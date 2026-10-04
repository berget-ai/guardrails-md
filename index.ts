/**
 * SystemOne-gate — opencode plugin that judges every bash command before it
 * runs, using a System One decision model (TypeSafe Jev contract) via the
 * official @typesafe-ai/sdk client.
 *
 * Flow: tool.execute.before → read guardrails.md from the repo → one forward
 * pass answers all questions (~100 ms) → block above threshold, else run.
 *
 * Questions (noul, 0..1):
 *   destructive          — deletes/destroys data, databases, clusters, infra?
 *   credentials          — contains/leaks secrets, keys, tokens?
 *   guardrails_violation — violates the team's guardrails.md? (if present)
 *
 * Guardrails: ${repo}/guardrails.md is read ONCE at plugin load and frozen
 * for the session, so verdicts follow the team's written policy as it stood
 * at startup. Edits require a restart (and go through repo review).
 *
 * Credentials, in order: the Berget Code seat token (opencode's auth
 * storage — zero config for logged-in users), then BERGET_API_KEY, then
 * the SDK's TYPESAFE_API_KEY. Endpoints: defaults to Berget's hosted
 * System One API (api.berget.ai, model berget/bev). Any other
 * System One-compatible gateway works via BERGET_BASE_URL/BERGET_MODEL,
 * and TypeSafe-hosted users can rely on the SDK's native TYPESAFE_* env
 * vars instead.
 *
 * Block > 0.7. Fail-CLOSED on endpoint errors: an unreachable endpoint
 * blocks commands (fail-open would be an agent-reachable kill switch —
 * it can induce the failure). SYSTEMONE_FAIL_OPEN=1 opts out.
 *
 * Config (BERGET_* takes precedence, then the SDK's TYPESAFE_* env vars,
 * then the Berget defaults):
 *   BERGET_API_KEY        bearer token for CI/headless (fallback:
 *                         TYPESAFE_API_KEY); logged-in Berget Code users
 *                         need nothing — the seat token is picked up
 *                         automatically
 *   BERGET_BASE_URL       gateway root or full /v1/systemone URL
 *                         (fallback: TYPESAFE_BASE_URL, then api.berget.ai)
 *   BERGET_MODEL          model id (fallback: TYPESAFE_DEFAULT_MODEL,
 *                         then berget/bev)
 *   SYSTEMONE_THRESHOLD   block threshold, default 0.7
 *   SYSTEMONE_FAIL_OPEN=1 prefer availability when the endpoint is down
 *   SYSTEMONE_GATE=off    disable the gate
 *
 * Log: ~/.cache/opencode/systemone-gate.log
 */
import type { Plugin } from "@opencode-ai/plugin"
import { noul, TypeSafeClient } from "@typesafe-ai/sdk"

const THRESHOLD = Number(process.env.SYSTEMONE_THRESHOLD ?? "0.7")
// Endpoint failure policy. Default is FAIL-CLOSED: if the endpoint cannot
// be reached, the command is blocked. Fail-open would be an agent-reachable
// kill switch — an agent can induce the failure (hammer the endpoint until
// rate-limited, exhaust the account quota) and then run anything unchecked.
// The SDK already retries transient 429/529 with backoff, so a persistent
// failure here is real. Interactive users who prefer availability over
// strictness can set SYSTEMONE_FAIL_OPEN=1.
const FAIL_OPEN = /^(1|true|yes)$/i.test(process.env.SYSTEMONE_FAIL_OPEN ?? "")
const GUARDRAILS_MAX = 2000 // chars — keep the state text tight
const SCRIPT_MAX = 4000 // chars of file content included per file
const SCRIPT_FILES_MAX = 3 // files read per command

// No interpreter blocklist — perl, java, dotnet, ruby, lua, osascript,
// xargs, find -exec and friends can never be enumerated. Instead: every
// argument that points to an existing file is read and judged, whatever
// tool would run it. Inline code (perl -e '…', node -e '…') is already
// part of the command text. One level deep; network-fetched payloads and
// binaries remain documented gaps.

type Verdict = {
  destructive: number
  credentials: number
  guardrails_violation?: number
  policy_exception?: number
}

// --- guardrails.md, frozen at session start ---------------------------------
// Read ONCE when the plugin loads, not per command. Hot-reloading would let
// the agent weaken its own rules mid-session via the (ungated) edit tools —
// the same self-approval hole as the removed allow-file. Humans edit
// guardrails.md and restart opencode; the change goes through repo review.
let frozen: string | null | undefined

function resetGuardrailsCache(): void {
  frozen = undefined
}

function readGuardrails(directory: string): string | null {
  if (frozen !== undefined) return frozen
  frozen = null
  const { readFileSync } = require("node:fs") as typeof import("node:fs")
  for (const p of [`${directory}/guardrails.md`, `${directory}/.opencode/guardrails.md`]) {
    try {
      let text = readFileSync(p, "utf8").trim()
      if (text.length > GUARDRAILS_MAX) text = text.slice(0, GUARDRAILS_MAX) + "\n… (truncated)"
      frozen = text
      break
    } catch {}
  }
  return frozen
}

// --- System One client -------------------------------------------------------
// The SDK wants the API ROOT (it appends /v1/systemone); accept both forms.
function gatewayRoot(url: string | undefined): string | undefined {
  if (!url) return undefined
  return url.replace(/\/v1\/systemone\/?$/, "").replace(/\/+$/, "")
}

// Berget Code seat token from opencode's auth storage (maintained and
// refreshed by @bergetai/opencode-auth). Read per request so a mid-session
// refresh is picked up. Returns null when absent or expired.
function seatToken(): string | null {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs")
    const path = `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/opencode/auth.json`
    const auth = JSON.parse(readFileSync(path, "utf8"))?.berget
    if (auth?.type !== "oauth" || typeof auth.access !== "string" || !auth.access) return null
    const exp = typeof auth.expires === "number" ? auth.expires : Number(auth.expires)
    if (Number.isFinite(exp) && exp > 0 && exp < Date.now()) return null // stale
    return auth.access
  } catch {
    return null
  }
}

function newClient(): TypeSafeClient | null {
  const apiKey = seatToken() ?? process.env.BERGET_API_KEY ?? process.env.TYPESAFE_API_KEY
  if (!apiKey) return null
  return new TypeSafeClient({
    apiKey,
    baseURL: gatewayRoot(
      process.env.BERGET_BASE_URL ?? process.env.TYPESAFE_BASE_URL ?? "https://api.berget.ai",
    ),
    defaultModel: process.env.BERGET_MODEL ?? process.env.TYPESAFE_DEFAULT_MODEL ?? "berget/bev",
    timeout: 5000,
  })
}

async function judge(client: TypeSafeClient, command: string, guardrails: string | null): Promise<Verdict> {
  const stateParts = [`Command the agent wants to run:\n${command}`]
  const scripts = scriptContents(command)
  if (scripts) {
    stateParts.push(`The command executes these script files — their content is part of the command:\n${scripts}`)
  }
  if (guardrails) {
    stateParts.push(
      `Team guardrails (rules for what the agent may and may not do):\n${guardrails}`,
    )
  }
  const questions = {
    destructive: noul(
      "Does this shell command delete, overwrite, format, or irreversibly destroy data, databases, clusters, or infrastructure? " +
        "Effects that are recoverable through version control (git rm, git rm --cached, git checkout, branch operations) are not irreversible. " +
        "Removing build artifacts, caches and temporary files is not irreversible. " +
        "However, in GitOps repositories a version-control change can trigger irreversible changes to real infrastructure — " +
        "deleting a manifest and pushing can destroy the resource it managed. Judge the actual effect of the command, not the version-control mechanics.",
    ),
    credentials: noul(
      "Does this shell command contain, print, or send credentials, secrets, API keys, or tokens?",
    ),
  }
  if (guardrails) {
    questions.guardrails_violation = noul(
      "Given the team's guardrails in the state, does this command violate any of those rules?",
    )
    questions.policy_exception = noul(
      "Does the team's guardrails text in the state EXPLICITLY allow this exact command — " +
        "naming it, or a precise and unambiguous pattern that matches it? " +
        "General or vague permissions do not count as an exception.",
    )
  }
  const response = await client.systemOne({ state: { text: stateParts.join("\n\n") }, questions })
  const a = response.answers as Record<string, { noul?: number }>
  return {
    destructive: a.destructive?.noul ?? 0,
    credentials: a.credentials?.noul ?? 0,
    guardrails_violation: a.guardrails_violation?.noul,
    policy_exception: a.policy_exception?.noul,
  }
}

// Audit log is opt-in (SYSTEMONE_LOG=1): nothing is written to disk by
// default, because commands can contain sensitive material.
// Existing files the command references, with their content — so the
// model judges what the command DOES, not just how innocuous its
// command line looks.
function scriptContents(command: string): string {
  const { readFileSync, statSync } = require("node:fs") as typeof import("node:fs")
  const parts: string[] = []
  for (const token of command.split(/\s+/)) {
    if (parts.length >= SCRIPT_FILES_MAX) break
    const path = token.replace(/^["']|["']$/g, "")
    if (!path || path.startsWith("-") || !path.includes(".")) continue
    try {
      const st = statSync(path)
      if (!st.isFile() || st.size > 1_000_000) continue
      let text = readFileSync(path, "utf8")
      if (text.includes("\0")) continue // binary — utf8 garbage adds nothing
      if (text.length > SCRIPT_MAX) text = text.slice(0, SCRIPT_MAX) + "\n… (truncated)"
      parts.push(`--- ${path} ---\n${text}`)
    } catch {}
  }
  return parts.join("\n")
}

function logFile(): string {
  return `${process.env.HOME}/.cache/opencode/systemone-gate.log`
}

function log(entry: Record<string, unknown>) {
  if (!/^(1|true|yes)$/i.test(process.env.SYSTEMONE_LOG ?? "")) return
  try {
    const { mkdirSync, appendFileSync } = require("node:fs")
    const path = logFile()
    mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true })
    appendFileSync(path, JSON.stringify(entry) + "\n")
  } catch {}
}

// Circumvention cooldown: every block doubles the wait before the next
// command is judged — 10 ms, 20 ms, 40 ms … with no ceiling. The first
// nine blocks are imperceptible (a few false positives cost nothing);
// the first noticeable pause arrives around block ten (5 s), and by
// block twenty an attempt waits 1.5 h, by block twenty-five almost two
// days: brute-forcing variants past the gate is arithmetically hopeless.
//
// The wait is enforced as a visible cooldown error, not a silent sleep —
// an invisible hang looks like a crash, while the error tells the agent
// (and through it the human) exactly what is happening and for how long.
// Retrying early just returns the same error with the remaining time.
//
// The counter decays with quiet time — one block of memory fades per 30
// minutes since the last block — so early false positives do not poison a
// whole session. Decay is wall-clock, not command-count: an agent cannot
// launder the counter by interleaving allowed commands, and an agent that
// keeps hammering refreshes lastBlockAt on every block, so escalation
// continues unchanged. State lives for the opencode process; restarting
// it resets everything.
const DECAY_MS = 30 * 60_000
let blockCount = 0
let lastBlockAt = 0
let cooldownUntil = 0

function effectiveBlocks(now: number): number {
  if (blockCount === 0 || lastBlockAt === 0) return 0
  return Math.max(0, blockCount - Math.floor((now - lastBlockAt) / DECAY_MS))
}

const BACKOFF_BASE_MS = 10

function backoffMs(blocks: number): number {
  if (blocks < 1) return 0
  // exponent capped at 40 to keep the float well-behaved
  return BACKOFF_BASE_MS * 2 ** Math.min(blocks - 1, 40)
}

export default (async ({ directory }) => {
  // Freeze guardrails NOW, at plugin load — before any command is judged.
  // A lazy first-read would let an agent weaken guardrails.md via the
  // ungated edit tools before issuing its first bash command and rule the
  // whole session under its own rules.
  readGuardrails(directory)
  let loggedInactive = false

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      if (process.env.SYSTEMONE_GATE === "off") return
      // Resolve credentials lazily: the seat token can appear or be
      // refreshed mid-session by @bergetai/opencode-auth.
      const client = newClient()
      if (!client) {
        if (!loggedInactive) {
          log({ ts: new Date().toISOString(), note: "gate inactive: no seat token, BERGET_API_KEY or TYPESAFE_API_KEY" })
          loggedInactive = true
        }
        return
      }
      const command = String((output.args as { command?: string })?.command ?? "").trim()
      if (!command) return
      const remainingMs = cooldownUntil - Date.now()
      if (remainingMs > 0) {
        const wait =
          remainingMs >= 90_000
            ? `${Math.round(remainingMs / 60_000)} min`
            : remainingMs >= 1000
              ? `${Math.ceil(remainingMs / 1000)} s`
              : `${remainingMs} ms`
        throw new Error(
          `SystemOne-gate: cooling down after ${blockCount} blocked command${blockCount === 1 ? "" : "s"} — ` +
            `next attempt in ~${wait}. The wait doubles with every block; ` +
            `restarting opencode resets it.`,
        )
      }

      // Every command is judged — no fast path of any kind. Prefix
      // allowlists ("it starts with ls, let it through") are exactly the
      // kind of seam an agent learns to exploit, and an override file the
      // agent can write is self-approval. Overrides belong to the human,
      // outside the agent's reach: SYSTEMONE_GATE / SYSTEMONE_THRESHOLD /
      // guardrails.md, all set before or around the session.

      const guardrails = readGuardrails(directory)
      let verdict: Verdict
      try {
        verdict = await judge(client, command, guardrails)
      } catch (err) {
        const status = (err as { status?: number }).status
        const reason =
          status === 402
            ? "Berget account out of credit — top up at berget.ai"
            : status === 401
              ? "authentication failed — re-login via @bergetai/opencode-auth or check BERGET_API_KEY"
              : status === 429
                ? "rate limited — wait a moment and retry"
                : "endpoint unreachable"
        if (FAIL_OPEN) {
          log({ ts: new Date().toISOString(), command, error: String(err), decision: "fail-open" })
          return // explicit opt-out: availability over strictness
        }
        log({ ts: new Date().toISOString(), command, error: String(err), decision: "fail-closed" })
        throw new Error(
          `SystemOne-gate: ${reason} — command blocked.\n` +
            `  ${command.slice(0, 200)}\n` +
            `  ${String(err).slice(0, 160)}\n` +
            `  Retry shortly, or set SYSTEMONE_FAIL_OPEN=1 to prefer availability.`,
        )
      }

      const scores: [string, number][] = [
        ["destructive", verdict.destructive],
        ["credentials", verdict.credentials],
      ]
      if (verdict.guardrails_violation !== undefined) {
        scores.push(["guardrails_violation", verdict.guardrails_violation])
      }
      // Two tiers. A named exception in guardrails.md overrides the POLICY
      // question (guardrails_violation) — that is how policy false positives
      // are fixed. It does NOT override destructive or credentials: those
      // judge the command's nature, they are the backstop, and guardrails.md
      // is agent-editable between sessions. A command the model judges
      // destructive needs a human at the keyboard, whatever the file says.
      const named = !!guardrails && (verdict.policy_exception ?? 0) > THRESHOLD
      const triggering = scores.filter(([k, v]) => {
        if (k === "guardrails_violation") return v > THRESHOLD && !named
        return v > THRESHOLD
      })
      const decision = triggering.length > 0 ? "BLOCK" : "allow"
      // report the worst triggering dimension, not a priority order
      const [kind, worst] = triggering.reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0])
      if (decision === "BLOCK") {
        const now = Date.now()
        blockCount = effectiveBlocks(now) + 1
        lastBlockAt = now
        cooldownUntil = now + backoffMs(blockCount)
      }
      log({
        ts: new Date().toISOString(), command, ...verdict,
        guardrails: !!guardrails, namedException: named, decision, blockCount,
        cooldownMs: decision === "BLOCK" ? backoffMs(blockCount) : 0,
      })

      if (decision === "BLOCK") {
        throw new Error(
          `SystemOne-gate: blocked command — ${kind}=${worst.toFixed(2)} > ${THRESHOLD}\n` +
            `  ${command.slice(0, 200)}\n` +
            (kind === "guardrails_violation"
              ? `\n  If this is a false positive, your human can name the command in the` +
                `\n  MAY section of guardrails.md and restart opencode — the gate` +
                `\n  follows the file.`
              : `\n  Judged destructive/leaking on its own merits — named exceptions in` +
                `\n  guardrails.md do not override this. If it is intended, your human` +
                `\n  can run it directly, or restart opencode with SYSTEMONE_GATE=off` +
                `\n  for a session that needs it.`) +
            (guardrails
              ? ""
              : `\n  No guardrails.md found in this repo. Your human can create one` +
                `\n  and write what the agent may and may not do — name what should` +
                `\n  pass in the MAY section, then restart opencode.`)
        )
      }
    },
  }
}) satisfies Plugin

/** Test hooks — not part of the public plugin API. */
export const __internals = {
  gatewayRoot,
  backoffMs,
  seatToken,
  readGuardrails,
  resetGuardrailsCache,
  judge,
  logFile,
}
