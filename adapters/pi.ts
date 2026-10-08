/**
 * guardrails-md for pi — gates every bash tool call through core.ts before it
 * runs, including calls a codemode script makes, and deterministically refuses
 * edits and writes to protected paths (edit/write): no model call, no
 * threshold, no cooldown. A block returns { block, reason } to the agent and
 * warns the human. Without a credential the gate is inactive, and the human
 * is told once. Config warnings (bad threshold, truncated GUARDRAILS.md) are
 * shown when a session starts.
 *
 * Credentials: pi's own resolution for the "berget" provider first (OAuth or
 * API-key login), then the berget OAuth entry in pi's auth.json
 * ($PI_CODING_AGENT_DIR or ~/.pi/agent), then the env keys core reads.
 * Guardrails: GUARDRAILS.md or .pi/GUARDRAILS.md (legacy lowercase names are
 * still read), frozen at extension load.
 * Log: ~/.cache/pi/systemone-gate.log (SYSTEMONE_LOG=1).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createGate, type Harness } from "../core.ts"

const BERGET_PROVIDER = "berget"

function pi(): Harness {
  const home = process.env.HOME
  return {
    name: "pi",
    authPath: `${process.env.PI_CODING_AGENT_DIR ?? `${home}/.pi/agent`}/auth.json`,
    guardrailPaths: ["GUARDRAILS.md", ".pi/GUARDRAILS.md", "guardrails.md", ".pi/guardrails.md"],
    logPath: `${home}/.cache/pi/systemone-gate.log`,
  }
}

// ui.notify is a no-op without a UI (pi -p), where the human only sees stderr.
function warn(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning")
  else process.stderr.write(`${message}\n`)
}

// The file pi's edit/write tools actually open: they strip a leading `@`,
// expand `~`, and accept file:// URLs (resolvePath in pi's utils/paths.js).
// Checking the raw spelling would let `@GUARDRAILS.md` past the list.
function piPath(raw: string): string {
  const path = raw.startsWith("@") ? raw.slice(1) : raw
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  if (path.startsWith("file://")) return fileURLToPath(path)
  return path
}

export default function guardrailsMd(api: ExtensionAPI) {
  const gate = createGate(pi(), process.cwd())
  let warnedInactive = false
  const silentlyInactive = (key: string | undefined) =>
    !warnedInactive && process.env.SYSTEMONE_GATE !== "off" && !gate.hasCredential(key)

  api.on("session_start", async (_event, ctx) => {
    for (const warning of gate.warnings) warn(ctx, warning)
  })

  api.on("tool_call", async (event, ctx) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const pathBlock = gate.checkPath(piPath(String(event.input.path ?? "")))
      if (!pathBlock) return
      warn(ctx, pathBlock.reason.split("\n")[0])
      return { block: true, reason: pathBlock.reason }
    }
    if (event.toolName !== "bash") return
    const key = await ctx.modelRegistry.getApiKeyForProvider(BERGET_PROVIDER)
    const block = await gate.check(String(event.input.command ?? "").trim(), key)
    if (!block && silentlyInactive(key)) {
      warnedInactive = true
      warn(ctx, "guardrails-md inactive: no Berget login (/login) or BERGET_API_KEY")
    }
    if (!block) return
    warn(ctx, block.reason.split("\n")[0])
    return { block: true, reason: block.reason }
  })
}
