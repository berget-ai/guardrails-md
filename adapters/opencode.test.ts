import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sdk = await vi.hoisted(async () => (await import("../test/sdk-mock.ts")).createSdkMock())
vi.mock("@typesafe-ai/sdk", () => sdk.module)
const { systemOne } = sdk

type Hook = (input: { tool: string }, output: { args: { command?: string } }) => Promise<void>

const allow = { answers: { destructive: { noul: 0.01 }, credentials: { noul: 0 } } }
const blockDestructive = { answers: { destructive: { noul: 0.98 }, credentials: { noul: 0 } } }

let dir: string
let home: string

const showToast = vi.fn()

async function loadHook(): Promise<Hook> {
  const mod = await import("./opencode.ts")
  const hooks = await mod.default({ directory: dir, client: { tui: { showToast } } } as never)
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
  vi.stubEnv("SYSTEMONE_THRESHOLD", undefined)
  showToast.mockResolvedValue(undefined)
  systemOne.mockResolvedValue(structuredClone(allow))
  sdk.configs.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

describe("opencode adapter", () => {
  it("Given opencode's loader calls every export, When the module loads, Then every export is a function", async () => {
    const mod = await import("./opencode.ts")
    for (const value of Object.values(mod)) expect(value).toBeTypeOf("function")
  })

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
    expect(sdk.configs[0]?.apiKey).toBe("xdg-tok")
  })

  it("Given an invalid SYSTEMONE_THRESHOLD, When the plugin loads, Then a warning toast is shown", async () => {
    vi.stubEnv("SYSTEMONE_THRESHOLD", "abc")
    await loadHook()
    expect(showToast).toHaveBeenCalledWith({ body: { message: expect.stringMatching(/SYSTEMONE_THRESHOLD/), variant: "warning" } })
  })

  it("Given a toast that fails, When the plugin loads, Then the plugin still loads", async () => {
    vi.stubEnv("SYSTEMONE_THRESHOLD", "abc")
    showToast.mockRejectedValueOnce(new Error("tui not ready"))
    await expect(loadHook()).resolves.toBeTypeOf("function")
  })

  it("Given .opencode/guardrails.md, When bash runs, Then the policy is judged", async () => {
    mkdirSync(join(dir, ".opencode"), { recursive: true })
    writeFileSync(join(dir, ".opencode", "guardrails.md"), "# opencode rules")
    const hook = await loadHook()
    await hook({ tool: "bash" }, { args: { command: "ls" } })
    expect(systemOne.mock.calls[0][0].state.text).toContain("# opencode rules")
  })
})

describe("opencode adapter: protected paths", () => {
  it("Given an edit on guardrails.md, When the hook runs, Then it throws with the reason and the model is not asked", async () => {
    const hook = await loadHook()
    await expect(hook({ tool: "edit" }, { args: { filePath: join(dir, "guardrails.md") } })).rejects.toThrow(
      /protected file — guardrails\.md[\s\S]*restart opencode/,
    )
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given a write to .pi/guardrails.md, When the hook runs, Then it throws", async () => {
    const hook = await loadHook()
    await expect(hook({ tool: "write" }, { args: { filePath: join(dir, ".pi", "guardrails.md") } })).rejects.toThrow(
      /protected file/,
    )
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given apply_patch touching guardrails.md, When the hook runs, Then it throws and the model is not asked", async () => {
    const hook = await loadHook()
    const patchText = `*** Begin Patch\n*** Update File: ${join(dir, "guardrails.md")}\n@@\n@@\n*** End Patch`
    await expect(hook({ tool: "apply_patch" }, { args: { patchText } })).rejects.toThrow(/protected file — guardrails\.md/)
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given apply_patch that names a protected file first and a plain file second, When the hook runs, Then the first block wins", async () => {
    const hook = await loadHook()
    const patchText =
      `*** Begin Patch\n*** Delete File: ${join(dir, "opencode.json")}\n*** Add File: ${join(dir, "src", "new.ts")}\n+export {}\n*** End Patch`
    await expect(hook({ tool: "apply_patch" }, { args: { patchText } })).rejects.toThrow(/protected file — opencode\.json/)
  })

  it("Given an edit on a plain source file, When the hook runs, Then it passes and the model is not asked", async () => {
    const hook = await loadHook()
    await expect(hook({ tool: "edit" }, { args: { filePath: join(dir, "src", "a.ts") } })).resolves.toBeUndefined()
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given SYSTEMONE_GATE=off, When an edit on guardrails.md runs, Then it passes", async () => {
    vi.stubEnv("SYSTEMONE_GATE", "off")
    const hook = await loadHook()
    await expect(hook({ tool: "edit" }, { args: { filePath: join(dir, "guardrails.md") } })).resolves.toBeUndefined()
  })
})
