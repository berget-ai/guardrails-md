/**
 * guardrails-md for opencode — gates every bash command through core.ts
 * before it runs. A block throws, and opencode hands the message to the agent.
 * Config warnings (bad threshold, truncated guardrails.md) are shown as a
 * toast at load.
 *
 * Seat token: opencode's auth storage, maintained by @bergetai/opencode-auth.
 * Guardrails: guardrails.md or .opencode/guardrails.md, frozen at plugin load.
 * Log: ~/.cache/opencode/systemone-gate.log (SYSTEMONE_LOG=1).
 */
import type { Plugin } from "@opencode-ai/plugin"
import { createGate, type Harness } from "../core.ts"

function opencode(): Harness {
  const home = process.env.HOME
  return {
    name: "opencode",
      label: "opencode",
    authPath: `${process.env.XDG_DATA_HOME ?? `${home}/.local/share`}/opencode/auth.json`,
    guardrailPaths: ["guardrails.md", ".opencode/guardrails.md"],
    logPath: `${home}/.cache/opencode/systemone-gate.log`,
  }
}

export const SystemOneGate = (async ({ directory, client }) => {
  const gate = createGate(opencode(), directory)
  // Best effort: the TUI may not be up yet, and every block reason repeats
  // these warnings anyway.
  for (const message of gate.warnings) {
    Promise.resolve(client?.tui?.showToast?.({ body: { message, variant: "warning" } })).catch(() => {})
  }
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const block = await gate.check(String(output.args?.command ?? "").trim())
      if (block) throw new Error(block.reason)
    },
  }
}) satisfies Plugin

export default SystemOneGate
