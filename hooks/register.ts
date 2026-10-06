/**
 * guardrails-md for Claude Code: a hooks module loaded in-process from
 * hooks/hooks.json. Self-contained: a hooks module runs without Node and
 * imports only files of the plugin, so it cannot share core.ts (node:fs,
 * the SDK). The questions, decision, block wording and cooldown below are
 * the same as core.ts's; keep the two in step when editing either.
 *
 * session.start snapshots guardrails.md (then .claude/guardrails.md) and
 * every variable below; it fires once per session and not on compaction,
 * and a missing snapshot denies. tool.call judges Bash, and Monitor when it
 * runs a shell `command`, and answers { deny } on a block.
 *
 * Fail-closed: the engine skips a hook that throws or overruns and lets the
 * call through, so .catch denies instead. The endpoint call is raced
 * against a 5 s $.clock.sleep, as the SDK times out in opencode and pi:
 * waiting on $.http.fetch does not count against the hook's budget.
 *
 * Credentials: BERGET_API_KEY, then TYPESAFE_API_KEY (no Berget seat token
 * here). Cooldown: module memory, for the session. No audit log: $.fs
 * cannot append.
 */
import type { Register } from "claude-code"

const HARNESS = "claude"
const GUARDRAIL_PATHS = ["guardrails.md", ".claude/guardrails.md"]
const TIMEOUT_MS = 5000
const DEFAULT_THRESHOLD = 0.7
const GUARDRAILS_MAX = 2000 // chars — keep the state text tight
const TRUNCATED = "\n… (truncated)"
const SCRIPT_MAX = 4000 // chars of file content included per file
const SCRIPT_FILES_MAX = 3 // files read per command
const SCRIPT_BYTES_MAX = 1_000_000 // larger files are not read

// --- config -----------------------------------------------------------------

// Out-of-range values fail silently otherwise: "abc" (NaN) or anything ≥ 1
// never blocks, while "", 0 or negatives block everything.
function parseThreshold(raw: string | undefined): { value: number; warning?: string } {
  if (raw === undefined) return { value: DEFAULT_THRESHOLD }
  const value = Number(raw)
  if (raw.trim() !== "" && value > 0 && value < 1) return { value }
  return {
    value: DEFAULT_THRESHOLD,
    warning:
      `SystemOne-gate: SYSTEMONE_THRESHOLD=${JSON.stringify(raw)} is not a number between 0 and 1 — ` +
      `using ${DEFAULT_THRESHOLD}.`,
  }
}

function isEnabled(raw: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(raw ?? "")
}

// The endpoint wants the API ROOT (we append /v1/systemone); accept both forms.
function gatewayRoot(url: string): string {
  return url.replace(/\/v1\/systemone\/?$/, "").replace(/\/+$/, "")
}

// --- guardrails.md ----------------------------------------------------------

function truncateGuardrails(raw: string): string {
  const text = raw.trim()
  return text.length > GUARDRAILS_MAX ? text.slice(0, GUARDRAILS_MAX) + TRUNCATED : text
}

// A truncated policy is applied as if complete, so rules past the cut are
// silently dropped — an agent can push them there by padding the file.
function truncationWarning(guardrails: string | null): string | undefined {
  if (!guardrails?.endsWith(TRUNCATED)) return undefined
  return (
    `SystemOne-gate: guardrails.md is longer than ${GUARDRAILS_MAX} characters — rules after that are ignored. ` +
    `Shorten it or put the MUST NOT rules first.`
  )
}

// --- judging ----------------------------------------------------------------

type Verdict = {
  destructive: number
  credentials: number
  guardrails_violation?: number
  policy_exception?: number
}

// The SDK's noul(), inlined: the same wire JSON without a package import.
function noul(instructions: string) {
  return { type: "noul" as const, instructions }
}

function buildQuestions(hasGuardrails: boolean) {
  const questions: Record<string, ReturnType<typeof noul>> = {
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
  if (hasGuardrails) {
    questions.guardrails_violation = noul(
      "Given the team's guardrails in the state, does this command violate any of those rules?",
    )
    questions.policy_exception = noul(
      "Does the team's guardrails text in the state EXPLICITLY allow this exact command — " +
        "naming it, or a precise and unambiguous pattern that matches it? " +
        "General or vague permissions do not count as an exception.",
    )
  }
  return questions
}

function buildStateText(command: string, scripts: string, guardrails: string | null): string {
  const stateParts = [`Command the agent wants to run:\n${command}`]
  if (scripts) {
    stateParts.push(`The command executes these script files — their content is part of the command:\n${scripts}`)
  }
  if (guardrails) {
    stateParts.push(`Team guardrails (rules for what the agent may and may not do):\n${guardrails}`)
  }
  return stateParts.join("\n\n")
}

// No interpreter blocklist — perl, java, dotnet, ruby, lua, osascript,
// xargs, find -exec and friends can never be enumerated. Instead: every
// argument that points to an existing file is read and judged, whatever
// tool would run it. Inline code (perl -e '…', node -e '…') is already
// part of the command text. One level deep; network-fetched payloads and
// binaries remain documented gaps.
function scriptPath(token: string): string | null {
  const path = token.replace(/^["']|["']$/g, "")
  if (!path || path.startsWith("-") || !path.includes(".")) return null
  return path
}

function scriptSection(path: string, text: string): string | null {
  if (text.includes("\0")) return null // binary — utf8 garbage adds nothing
  const cut = text.length > SCRIPT_MAX ? text.slice(0, SCRIPT_MAX) + TRUNCATED : text
  return `--- ${path} ---\n${cut}`
}

// A score the endpoint sends as a string or garbage must not reach decide
// as a non-number: "0.98" would pass the > comparison and then throw in
// blockMessage. Absent questions stay absent.
function score(answer: { noul?: unknown } | undefined): number {
  const value = Number(answer?.noul ?? 0)
  return Number.isNaN(value) ? 0 : value
}

function verdictFrom(answers: unknown): Verdict {
  const a = (answers ?? {}) as Record<string, { noul?: unknown } | undefined>
  return {
    destructive: score(a.destructive),
    credentials: score(a.credentials),
    guardrails_violation: a.guardrails_violation === undefined ? undefined : score(a.guardrails_violation),
    policy_exception: a.policy_exception === undefined ? undefined : score(a.policy_exception),
  }
}

// Two tiers. A named exception in guardrails.md overrides the POLICY
// question (guardrails_violation) — that is how policy false positives are
// fixed. It does NOT override destructive or credentials: those judge the
// command's nature, they are the backstop, and guardrails.md is
// agent-editable between sessions. A command the model judges destructive
// needs a human at the keyboard, whatever the file says.
type Dimension = "destructive" | "credentials" | "guardrails_violation"

interface Outcome {
  decision: "BLOCK" | "allow"
  kind: Dimension
  worst: number
  named: boolean
}

function decide(verdict: Verdict, hasGuardrails: boolean, threshold: number): Outcome {
  const named = hasGuardrails && (verdict.policy_exception ?? 0) > threshold
  const dimensions: [Dimension, number][] = [
    ["destructive", verdict.destructive],
    ["credentials", verdict.credentials],
  ]
  if (verdict.guardrails_violation !== undefined) {
    dimensions.push(["guardrails_violation", verdict.guardrails_violation])
  }
  const triggering = dimensions.filter(([dimension, score]) => {
    if (dimension === "guardrails_violation") return score > threshold && !named
    return score > threshold
  })
  const decision = triggering.length > 0 ? "BLOCK" : "allow"
  // report the worst triggering dimension, not a priority order
  const [kind, worst] = triggering.reduce(
    (a, b) => (b[1] > a[1] ? b : a),
    ["destructive", 0] as [Dimension, number],
  )
  return { decision, kind, worst, named }
}

function blockMessage(outcome: Outcome, hasGuardrails: boolean, threshold: number): string {
  const perKind =
    outcome.kind === "guardrails_violation"
      ? `\n  If this is a false positive, your human can name the command in the` +
        `\n  MAY section of guardrails.md and restart ${HARNESS} — the gate` +
        `\n  follows the file.`
      : `\n  Judged destructive/leaking on its own merits — named exceptions in` +
        `\n  guardrails.md do not override this. If it is intended, your human` +
        `\n  can run it directly, or restart ${HARNESS} with SYSTEMONE_GATE=off` +
        `\n  for a session that needs it.`
  const bootstrap = hasGuardrails
    ? ""
    : `\n  No guardrails.md found in this repo. Your human can create one` +
      `\n  and write what the agent may and may not do — name what should` +
      `\n  pass in the MAY section, then restart ${HARNESS}.`
  return (
    `SystemOne-gate: blocked command — ${outcome.kind}=${outcome.worst.toFixed(2)} > ${threshold}\n` +
    perKind +
    bootstrap
  )
}

function endpointReason(status: number | undefined): string {
  if (status === 402) return "Berget account out of credit — top up at berget.ai"
  if (status === 401) return "authentication failed — re-login to Berget or check BERGET_API_KEY"
  if (status === 429) return "rate limited — wait a moment and retry"
  return "endpoint unreachable"
}

function endpointFailure(command: string, err: unknown): string {
  return (
    `SystemOne-gate: ${endpointReason((err as { status?: number }).status)} — command blocked.\n` +
    `  ${command.slice(0, 200)}\n` +
    `  ${String(err).slice(0, 160)}\n` +
    `  Retry shortly, or set SYSTEMONE_FAIL_OPEN=1 to prefer availability.`
  )
}

// --- cooldown ---------------------------------------------------------------
// Circumvention cooldown: every block doubles the wait before the next
// command is judged — 10 ms, 20 ms, 40 ms … with no ceiling. The first
// nine blocks are imperceptible (a few false positives cost nothing);
// the first noticeable pause arrives around block ten (5 s), and by
// block twenty an attempt waits 1.5 h, by block twenty-five almost two
// days: brute-forcing variants past the gate is arithmetically hopeless.
//
// The wait is enforced as a visible cooldown block, not a silent sleep —
// an invisible hang looks like a crash, while the reason tells the agent
// (and through it the human) exactly what is happening and for how long.
// Retrying early just returns the same reason with the remaining time.
//
// The counter decays with quiet time — one block of memory fades per 30
// minutes since the last block — so early false positives do not poison a
// whole session. Decay is wall-clock, not command-count: an agent cannot
// launder the counter by interleaving allowed commands, and an agent that
// keeps hammering refreshes lastBlockAt on every block, so escalation
// continues unchanged. State lives for the session; a new session or a
// mod reload resets everything.
const DECAY_MS = 30 * 60_000
const BACKOFF_BASE_MS = 10

function backoffMs(blocks: number): number {
  if (blocks < 1) return 0
  // exponent capped at 40 to keep the float well-behaved
  return BACKOFF_BASE_MS * 2 ** Math.min(blocks - 1, 40)
}

function formatWait(remainingMs: number): string {
  if (remainingMs >= 90_000) return `${Math.round(remainingMs / 60_000)} min`
  if (remainingMs >= 1000) return `${Math.ceil(remainingMs / 1000)} s`
  return `${remainingMs} ms`
}

function createCooldown() {
  let blockCount = 0
  let lastBlockAt = 0
  let cooldownUntil = 0

  function effectiveBlocks(now: number): number {
    if (blockCount === 0 || lastBlockAt === 0) return 0
    return Math.max(0, blockCount - Math.floor((now - lastBlockAt) / DECAY_MS))
  }

  function register(): void {
    const now = Date.now()
    blockCount = effectiveBlocks(now) + 1
    lastBlockAt = now
    cooldownUntil = now + backoffMs(blockCount)
  }

  function reason(): string | null {
    const remainingMs = cooldownUntil - Date.now()
    if (remainingMs <= 0) return null
    return (
      `SystemOne-gate: cooling down after ${blockCount} blocked command${blockCount === 1 ? "" : "s"} — ` +
      `next attempt in ~${formatWait(remainingMs)}. The wait doubles with every block; ` +
      `restarting ${HARNESS} resets it.`
    )
  }

  return { register, reason }
}

// --- the module -------------------------------------------------------------

interface Session {
  guardrails: string | null
  key: string | undefined
  baseURL: string
  model: string
  threshold: number
  failOpen: boolean
  off: boolean
  warnings: string[]
  cooldown: ReturnType<typeof createCooldown>
}

class EndpointError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`System One endpoint answered ${status}: ${body.slice(0, 120)}`)
  }
}

async function firstReadable(read: (path: string) => Promise<string>, paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      return await read(path)
    } catch {}
  }
  return null
}

export const register: Register = (on) => {
  let session: Session | null = null

  on("session.start", async ($, e, next) => {
    const raw = await firstReadable((path) => $.fs.read(path), GUARDRAIL_PATHS.map((p) => `${e.cwd}/${p}`))
    const guardrails = raw === null ? null : truncateGuardrails(raw)
    const threshold = parseThreshold(await $.env.get("SYSTEMONE_THRESHOLD"))
    session = {
      guardrails,
      key: (await $.env.get("BERGET_API_KEY")) ?? (await $.env.get("TYPESAFE_API_KEY")),
      baseURL: gatewayRoot((await $.env.get("BERGET_BASE_URL")) ?? (await $.env.get("TYPESAFE_BASE_URL")) ?? "https://api.berget.ai"),
      model: (await $.env.get("BERGET_MODEL")) ?? (await $.env.get("TYPESAFE_DEFAULT_MODEL")) ?? "berget/bev",
      threshold: threshold.value,
      failOpen: isEnabled(await $.env.get("SYSTEMONE_FAIL_OPEN")),
      off: (await $.env.get("SYSTEMONE_GATE")) === "off",
      warnings: [threshold.warning, truncationWarning(guardrails)].filter((w): w is string => w !== undefined),
      cooldown: createCooldown(),
    }
    for (const warning of session.warnings) $.ui.toast(warning)
    if (!session.off && !session.key) {
      $.ui.toast("guardrails-md inactive: no BERGET_API_KEY or TYPESAFE_API_KEY — Bash and Monitor commands run ungated this session")
    }
    return next(e)
  })

  on("tool.call", { tool: ["Bash", "Monitor"] }, async ($, e, next) => {
    if (e.command === undefined) return next(e)
    if (!session) return { deny: "SystemOne-gate: no frozen policy — session.start did not run. Restart Claude Code (fail-closed)." }
    const s = session
    const command = e.command.trim()
    if (s.off || !s.key || !command) return next(e)
    const cooling = s.cooldown.reason()
    if (cooling) return { deny: cooling }
    const deny = (reason: string) => ({ deny: [reason, ...s.warnings.map((w) => `  ${w}`)].join("\n") })

    const scripts: string[] = []
    for (const token of command.split(/\s+/)) {
      if (scripts.length >= SCRIPT_FILES_MAX) break
      const path = scriptPath(token)
      if (!path) continue
      try {
        const st = await $.fs.stat(path)
        if (st.kind !== "file" || st.size > SCRIPT_BYTES_MAX) continue
        const section = scriptSection(path, await $.fs.read(path))
        if (section) scripts.push(section)
      } catch {}
    }

    let answers: unknown
    const stop = new AbortController()
    try {
      const timeout = $.clock.sleep(TIMEOUT_MS, { signal: AbortSignal.any([stop.signal, next.signal]) }).then(() => {
        throw new Error(`System One endpoint timed out after ${TIMEOUT_MS} ms`)
      })
      timeout.catch(() => {})
      const res = await Promise.race([
        $.http.fetch(`${s.baseURL}/v1/systemone`, {
          method: "POST",
          headers: { Authorization: `Bearer ${s.key}`, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            state: { text: buildStateText(command, scripts.join("\n"), s.guardrails) },
            questions: buildQuestions(!!s.guardrails),
            model: s.model,
          }),
        }),
        timeout,
      ])
      if (!res.ok) throw new EndpointError(res.status, res.text)
      answers = JSON.parse(res.text).answers
    } catch (err) {
      if (s.failOpen) return next(e)
      return deny(endpointFailure(command, err))
    } finally {
      stop.abort()
    }

    const outcome = decide(verdictFrom(answers), !!s.guardrails, s.threshold)
    if (outcome.decision === "allow") return next(e)
    s.cooldown.register()
    return deny(blockMessage(outcome, !!s.guardrails, s.threshold) + `\n  ${command.slice(0, 200)}`)
  }).catch(($, e, next) => ({
    deny: `SystemOne-gate: the gate failed (${next.error.kind}${next.error.message ? `: ${next.error.message}` : ""}) — command blocked (fail-closed).`,
  }))
}
