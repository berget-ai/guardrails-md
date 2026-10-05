import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sdk = await vi.hoisted(async () => (await import("../test/sdk-mock.ts")).createSdkMock())
vi.mock("@typesafe-ai/sdk", () => sdk.module)
const { systemOne } = sdk

type ToolCall = { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown>; parentToolCallId?: string }
type Handler = (event: ToolCall, ctx: unknown) => Promise<{ block: boolean; reason: string } | undefined>

const allow = { answers: { destructive: { noul: 0.01 }, credentials: { noul: 0 } } }
const blockDestructive = { answers: { destructive: { noul: 0.98 }, credentials: { noul: 0 } } }

let dir: string
let home: string
const notify = vi.fn()
const ctx = { ui: { notify } }

async function loadHandler(): Promise<Handler> {
  const handlers: Record<string, Handler> = {}
  const api = { on: (name: string, handler: Handler) => (handlers[name] = handler) }
  const mod = await import("./pi.ts")
  mod.default(api as never)
  return handlers.tool_call
}

function bash(command: string, parentToolCallId?: string): ToolCall {
  return { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command }, parentToolCallId }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  home = mkdtempSync(join(tmpdir(), "gate-home-"))
  dir = mkdtempSync(join(tmpdir(), "gate-proj-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("BERGET_API_KEY", "test-key")
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined)
  vi.stubEnv("SYSTEMONE_GATE", undefined)
  vi.spyOn(process, "cwd").mockReturnValue(dir)
  systemOne.mockResolvedValue(structuredClone(allow))
  sdk.configs.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

describe("pi adapter", () => {
  it("Given a destructive verdict, When bash is called, Then it is blocked with a reason and the human is notified", async () => {
    systemOne.mockResolvedValue(blockDestructive)
    const handler = await loadHandler()
    const result = await handler(bash("rm -rf /data"), ctx)
    expect(result).toMatchObject({ block: true, reason: expect.stringMatching(/destructive=0\.98[\s\S]*restart pi/) })
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^SystemOne-gate: blocked command/), "warning")
  })

  it("Given a safe verdict, When bash is called, Then the call passes", async () => {
    const handler = await loadHandler()
    await expect(handler(bash("ls -la"), ctx)).resolves.toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
  })

  it("Given a codemode script, When it issues a nested bash call, Then that call is judged too", async () => {
    systemOne.mockResolvedValue(blockDestructive)
    const handler = await loadHandler()
    const result = await handler(bash("rm -rf /data", "codemode-1"), ctx)
    expect(result?.block).toBe(true)
  })

  it("Given a read tool call, When it is called, Then the model is not asked", async () => {
    const handler = await loadHandler()
    await expect(handler({ type: "tool_call", toolCallId: "c2", toolName: "read", input: { path: "x" } }, ctx)).resolves.toBeUndefined()
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given SYSTEMONE_GATE=off, When bash is called, Then nothing is judged", async () => {
    vi.stubEnv("SYSTEMONE_GATE", "off")
    systemOne.mockResolvedValue(blockDestructive)
    const handler = await loadHandler()
    await expect(handler(bash("rm -rf /"), ctx)).resolves.toBeUndefined()
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given .pi/guardrails.md at load, When it is edited afterwards, Then the frozen text is judged", async () => {
    mkdirSync(join(dir, ".pi"), { recursive: true })
    writeFileSync(join(dir, ".pi", "guardrails.md"), "# pi rules")
    const handler = await loadHandler()
    writeFileSync(join(dir, ".pi", "guardrails.md"), "# WEAKENED BY AGENT")
    await handler(bash("ls"), ctx)
    expect(systemOne.mock.calls[0][0].state.text).toContain("# pi rules")
    expect(systemOne.mock.calls[0][0].state.text).not.toContain("WEAKENED")
  })

  it("Given only a pi Berget login, When bash is called, Then the SDK gets the seat token", async () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true })
    writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ berget: { type: "oauth", access: "pi-seat", expires: Date.now() + 60_000 } }))
    vi.stubEnv("BERGET_API_KEY", undefined)
    const handler = await loadHandler()
    await handler(bash("ls"), ctx)
    expect(sdk.configs[0]?.apiKey).toBe("pi-seat")
  })

  it("Given no credential, When bash is called twice, Then the human is warned once that the gate is inactive", async () => {
    vi.stubEnv("BERGET_API_KEY", undefined)
    vi.stubEnv("TYPESAFE_API_KEY", undefined)
    const handler = await loadHandler()
    await expect(handler(bash("rm -rf /data"), ctx)).resolves.toBeUndefined()
    await handler(bash("ls"), ctx)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/inactive.*BERGET_API_KEY/), "warning")
  })

  it("Given a credential, When a call is allowed, Then no inactive warning is shown", async () => {
    const handler = await loadHandler()
    await handler(bash("ls"), ctx)
    expect(notify).not.toHaveBeenCalled()
  })

  it("Given an empty BERGET_API_KEY and no login, When bash is called, Then the human is warned the gate is inactive", async () => {
    vi.stubEnv("BERGET_API_KEY", "")
    vi.stubEnv("TYPESAFE_API_KEY", undefined)
    const handler = await loadHandler()
    await handler(bash("ls"), ctx)
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/inactive/), "warning")
  })

  it("Given the endpoint is down, When bash is called, Then the call is blocked (fail-closed)", async () => {
    systemOne.mockRejectedValue(new Error("gateway down"))
    const handler = await loadHandler()
    await expect(handler(bash("ls"), ctx)).resolves.toMatchObject({ block: true, reason: expect.stringMatching(/endpoint unreachable/) })
  })

  it("Given PI_CODING_AGENT_DIR, When bash is called, Then the seat token is read from there", async () => {
    const agentDir = join(home, "custom-agent")
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ berget: { type: "oauth", access: "custom-seat", expires: Date.now() + 60_000 } }))
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir)
    vi.stubEnv("BERGET_API_KEY", undefined)
    const handler = await loadHandler()
    await handler(bash("ls"), ctx)
    expect(sdk.configs[0]?.apiKey).toBe("custom-seat")
  })
})
