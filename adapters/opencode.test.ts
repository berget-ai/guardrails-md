import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const state = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[] }))
const systemOne = vi.fn()
vi.mock("@typesafe-ai/sdk", () => ({
  noul: (instructions: string) => ({ type: "noul", instructions }),
  TypeSafeClient: class {
    constructor(public cfg: Record<string, unknown>) {
      state.configs.push(cfg)
    }
    systemOne(req: unknown) {
      return systemOne(req)
    }
  },
}))

type Hook = (input: { tool: string }, output: { args: { command?: string } }) => Promise<void>

const allow = { answers: { destructive: { noul: 0.01 }, credentials: { noul: 0 } } }
const blockDestructive = { answers: { destructive: { noul: 0.98 }, credentials: { noul: 0 } } }

let dir: string
let home: string

async function loadHook(): Promise<Hook> {
  const mod = await import("./opencode.ts")
  const hooks = await mod.default({ directory: dir } as never)
  return hooks["tool.execute.before"] as Hook
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  home = mkdtempSync(join(tmpdir(), "gate-home-"))
  dir = mkdtempSync(join(tmpdir(), "gate-proj-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("BERGET_API_KEY", "test-key")
  vi.stubEnv("XDG_DATA_HOME", undefined)
  vi.stubEnv("SYSTEMONE_GATE", undefined)
  systemOne.mockResolvedValue(structuredClone(allow))
  state.configs.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

describe("opencode adapter", () => {
  it("Given a non-bash tool, When it is called, Then the model is not asked", async () => {
    const hook = await loadHook()
    await hook({ tool: "edit" }, { args: {} })
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given a safe verdict, When bash runs, Then the hook resolves", async () => {
    const hook = await loadHook()
    await expect(hook({ tool: "bash" }, { args: { command: "ls -la" } })).resolves.toBeUndefined()
  })

  it("Given a destructive verdict, When bash runs, Then the hook throws with opencode wording", async () => {
    systemOne.mockResolvedValue(blockDestructive)
    const hook = await loadHook()
    await expect(hook({ tool: "bash" }, { args: { command: "rm -rf /data" } })).rejects.toThrow(
      /destructive=0\.98[\s\S]*restart opencode/,
    )
  })

  it("Given an opencode seat token under XDG_DATA_HOME, When bash runs, Then the SDK gets that token", async () => {
    const xdg = join(home, "xdg")
    mkdirSync(join(xdg, "opencode"), { recursive: true })
    writeFileSync(join(xdg, "opencode", "auth.json"), JSON.stringify({ berget: { type: "oauth", access: "xdg-tok", expires: Date.now() + 60_000 } }))
    vi.stubEnv("XDG_DATA_HOME", xdg)
    vi.stubEnv("BERGET_API_KEY", undefined)
    const hook = await loadHook()
    await hook({ tool: "bash" }, { args: { command: "ls" } })
    expect(state.configs[0]?.apiKey).toBe("xdg-tok")
  })

  it("Given .opencode/guardrails.md, When bash runs, Then the policy is judged", async () => {
    mkdirSync(join(dir, ".opencode"), { recursive: true })
    writeFileSync(join(dir, ".opencode", "guardrails.md"), "# opencode rules")
    const hook = await loadHook()
    await hook({ tool: "bash" }, { args: { command: "ls" } })
    expect(systemOne.mock.calls[0][0].state.text).toContain("# opencode rules")
  })
})
