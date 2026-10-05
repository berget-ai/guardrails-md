/**
 * Internals — pure, testable pieces of the gate.
 *
 * These live in their own module because opencode's legacy plugin loader
 * iterates EVERY export of the plugin entrypoint and throws
 * "Plugin export is not a function" on any non-function value — a helpers
 * object exported from index.ts kills the whole plugin load silently.
 * index.ts therefore exports only the plugin function(s); tests import
 * this module directly.
 */
import { noul, TypeSafeClient } from "@typesafe-ai/sdk"

const GUARDRAILS_MAX = 2000 // chars — keep the state text tight
const SCRIPT_MAX = 4000 // chars of file content included per file
const SCRIPT_FILES_MAX = 3 // files read per command

// No interpreter blocklist — perl, java, dotnet, ruby, lua, osascript,
// xargs, find -exec and friends can never be enumerated. Instead: every
// argument that points to an existing file is read and judged, whatever
// tool would run it. Inline code (perl -e '…', node -e '…') is already
// part of the command text. One level deep; network-fetched payloads and
// binaries remain documented gaps.

export type Verdict = {
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

export function resetGuardrailsCache(): void {
  frozen = undefined
}

export function readGuardrails(directory: string): string | null {
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
export function gatewayRoot(url: string | undefined): string | undefined {
  if (!url) return undefined
  return url.replace(/\/v1\/systemone\/?$/, "").replace(/\/+$/, "")
}

// Berget Code seat token from opencode's auth storage (maintained and
// refreshed by @bergetai/opencode-auth). Read per request so a mid-session
// refresh is picked up. Returns null when absent or expired.
function readSeatAuth(): { access: string; expires: number } | null {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs")
    const path = `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/opencode/auth.json`
    const auth = JSON.parse(readFileSync(path, "utf8"))?.berget
    if (auth?.type !== "oauth" || typeof auth.access !== "string" || !auth.access) return null
    return { access: auth.access, expires: Number(auth.expires) }
  } catch {
    return null
  }
}

function isStale(expires: number): boolean {
  return Number.isFinite(expires) && expires > 0 && expires < Date.now()
}

export function seatToken(): string | null {
  const auth = readSeatAuth()
  if (!auth || isStale(auth.expires)) return null // stale: let the API key take over
  return auth.access
}

export interface JudgeContext {
  client: TypeSafeClient
  command: string
  guardrails: string | null
}

export async function judge({ client, command, guardrails }: JudgeContext): Promise<Verdict> {
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

// Existing files the command references, with their content — so the
// model judges what the command DOES, not just how innocuous its
// command line looks.
function readableFile(token: string): string | null {
  const { readFileSync, statSync } = require("node:fs") as typeof import("node:fs")
  const path = token.replace(/^["']|["']$/g, "")
  if (!path || path.startsWith("-") || !path.includes(".")) return null
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > 1_000_000) return null
    let text = readFileSync(path, "utf8")
    if (text.includes("\0")) return null // binary — utf8 garbage adds nothing
    if (text.length > SCRIPT_MAX) text = text.slice(0, SCRIPT_MAX) + "\n… (truncated)"
    return `--- ${path} ---\n${text}`
  } catch {
    return null
  }
}

function scriptContents(command: string): string {
  const parts: string[] = []
  for (const token of command.split(/\s+/)) {
    if (parts.length >= SCRIPT_FILES_MAX) break
    const content = readableFile(token)
    if (content) parts.push(content)
  }
  return parts.join("\n")
}

export function logFile(): string {
  return `${process.env.HOME}/.cache/opencode/systemone-gate.log`
}

const BACKOFF_BASE_MS = 10

export function backoffMs(blocks: number): number {
  if (blocks < 1) return 0
  // exponent capped at 40 to keep the float well-behaved
  return BACKOFF_BASE_MS * 2 ** Math.min(blocks - 1, 40)
}
