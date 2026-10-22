/**
 * guardrails-md for opencode — gates every shell command through core.ts
 * before it runs, and deterministically refuses edits and writes to protected
 * paths: no model call, no threshold, no cooldown. A block throws, and
 * opencode hands the message to the agent.
 *
 * One default export serves both plugin APIs: opencode 1.x calls `server()`,
 * opencode 2.x calls `setup()`. The two name their tools and arguments
 * differently (bash/shell, apply_patch/patch, filePath/path).
 *
 * Config warnings (bad threshold, truncated GUARDRAILS.md) are a toast at load
 * on 1.x; 2.x has no toast API, so there they only reach the block reasons.
 *
 * Seat token: opencode 1.x auth storage, maintained by @bergetai/opencode-auth.
 * Guardrails: GUARDRAILS.md or .opencode/GUARDRAILS.md (legacy lowercase names
 * are still read), frozen at plugin load.
 * Log: ~/.cache/opencode/systemone-gate.log (SYSTEMONE_LOG=1).
 */
import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as V2 } from "@opencode/plugin"
import { createGate, type Harness } from "../core.ts"

type Gate = ReturnType<typeof createGate>
type Args = { command?: unknown; filePath?: unknown; path?: unknown; patchText?: unknown } | undefined

function opencode(): Harness {
  const home = process.env.HOME
  return {
    name: "opencode",
    authPath: `${process.env.XDG_DATA_HOME ?? `${home}/.local/share`}/opencode/auth.json`,
    guardrailPaths: ["GUARDRAILS.md", ".opencode/GUARDRAILS.md", "guardrails.md", ".opencode/guardrails.md"],
    logPath: `${home}/.cache/opencode/systemone-gate.log`,
  }
}

// *** Begin Patch / @@ patch text: every marker line names a file.
function patchPaths(patchText: string): string[] {
  const paths: string[] = []
  for (const line of patchText.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): +(.+?)\s*$/)
    if (match) paths.push(match[1])
  }
  return paths
}

async function guard(gate: Gate, tool: string, args: Args): Promise<void> {
  if (tool === "bash" || tool === "shell") {
    const block = await gate.check(String(args?.command ?? "").trim())
    if (block) throw new Error(block.reason)
    return
  }
  // Both spellings are checked: a call carrying both must not pass on the one
  // the tool ignores.
  if (tool === "edit" || tool === "write") {
    for (const path of [args?.filePath, args?.path]) {
      const block = gate.checkPath(String(path ?? ""))
      if (block) throw new Error(block.reason)
    }
    return
  }
  if (tool === "apply_patch" || tool === "patch") {
    for (const path of patchPaths(String(args?.patchText ?? ""))) {
      const block = gate.checkPath(path)
      if (block) throw new Error(block.reason)
    }
  }
}

const server = (async ({ directory, client }) => {
  const gate = createGate(opencode(), directory)
  // Best effort: the TUI may not be up yet, and every block reason repeats
  // these warnings anyway.
  for (const message of gate.warnings) {
    Promise.resolve(client?.tui?.showToast?.({ body: { message, variant: "warning" } })).catch(() => {})
  }
  return {
    "tool.execute.before": (input, output) => guard(gate, input.tool, output.args),
  }
}) satisfies V1Plugin

export default {
  id: "@bergetai/guardrails-md",
  async setup(ctx) {
    const gate = createGate(opencode(), ctx.location.directory)
    await ctx.tool.hook("execute.before", (event) => guard(gate, event.tool, event.input as Args))
  },
  server,
} satisfies V2.Plugin & { server: V1Plugin }
