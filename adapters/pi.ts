/**
 * guardrails-md for pi — gates every bash tool call through core.ts before it
 * runs, including calls a codemode script makes. A block returns
 * { block, reason } to the agent and notifies the human. Without a
 * credential the gate is inactive, and the human is told once.
 *
 * Seat token: pi's auth storage ($PI_CODING_AGENT_DIR or ~/.pi/agent, auth.json
 * berget entry).
 * Guardrails: guardrails.md or .pi/guardrails.md, frozen at extension load.
 * Log: ~/.cache/pi/systemone-gate.log (SYSTEMONE_LOG=1).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createGate, type Harness } from "../core.ts"

function pi(): Harness {
  const home = process.env.HOME
  return {
    name: "pi",
    authPath: `${process.env.PI_CODING_AGENT_DIR ?? `${home}/.pi/agent`}/auth.json`,
    guardrailPaths: ["guardrails.md", ".pi/guardrails.md"],
    logPath: `${home}/.cache/pi/systemone-gate.log`,
  }
}

export default function guardrailsMd(api: ExtensionAPI) {
  const gate = createGate(pi(), process.cwd())
  let warnedInactive = false
  const silentlyInactive = () => !warnedInactive && process.env.SYSTEMONE_GATE !== "off" && !gate.hasCredential()

  api.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return
    const block = await gate.check(String(event.input.command ?? "").trim())
    if (!block && silentlyInactive()) {
      warnedInactive = true
      ctx.ui.notify("guardrails-md inactive: no Berget login (/login) or BERGET_API_KEY", "warning")
    }
    if (!block) return
    ctx.ui.notify(block.reason.split("\n")[0], "warning")
    return { block: true, reason: block.reason }
  })
}
