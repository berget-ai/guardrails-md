import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

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
const getApiKeyForProvider = vi.fn()
const ctx = { hasUI: true, ui: { notify }, modelRegistry: { getApiKeyForProvider } }
const printCtx = { ...ctx, hasUI: false }

async function loadHandlers(): Promise<Record<string, Handler>> {
  const handlers: Record<string, Handler> = {}
  const api = { on: (name: string, handler: Handler) => (handlers[name] = handler) }
  const mod = await import("./pi.ts")
  mod.default(api as never)
  return handlers
}

async function loadHandler(): Promise<Handler> {
  return (await loadHandlers()).tool_call
}

async function loadSessionStart(): Promise<(event: unknown, ctx: unknown) => Promise<void>> {
  return (await loadHandlers()).session_start as never
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
  getApiKeyForProvider.mockResolvedValue(undefined)
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

  it("Given a pi API-key login for Berget, When bash is called, Then the SDK gets the key pi resolves", async () => {
    getApiKeyForProvider.mockResolvedValue("pi-api-key")
    vi.stubEnv("BERGET_API_KEY", undefined)
    vi.stubEnv("TYPESAFE_API_KEY", undefined)
    const handler = await loadHandler()
    await handler(bash("ls"), ctx)
    expect(getApiKeyForProvider).toHaveBeenCalledWith("berget")
    expect(sdk.configs[0]?.apiKey).toBe("pi-api-key")
  })

  it("Given a pi-resolved key, When bash is called, Then no inactive warning is shown", async () => {
    getApiKeyForProvider.mockResolvedValue("pi-api-key")
    vi.stubEnv("BERGET_API_KEY", undefined)
    vi.stubEnv("TYPESAFE_API_KEY", undefined)
    const handler = await loadHandler()
    await handler(bash("ls"), ctx)
    expect(notify).not.toHaveBeenCalled()
  })

  it("Given print mode without UI, When a command is blocked, Then the warning goes to stderr", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    systemOne.mockResolvedValue(blockDestructive)
    const handler = await loadHandler()
    const result = await handler(bash("rm -rf /data"), printCtx)
    expect(result?.block).toBe(true)
    expect(notify).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^SystemOne-gate: blocked command/))
  })

  it("Given print mode and no credential, When bash is called, Then the inactive warning goes to stderr", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("BERGET_API_KEY", undefined)
    vi.stubEnv("TYPESAFE_API_KEY", undefined)
    const handler = await loadHandler()
    await handler(bash("ls"), printCtx)
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/inactive/))
  })

  it("Given an invalid SYSTEMONE_THRESHOLD, When a session starts, Then the human is warned", async () => {
    vi.stubEnv("SYSTEMONE_THRESHOLD", "abc")
    const sessionStart = await loadSessionStart()
    await sessionStart({ type: "session_start" }, ctx)
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/SYSTEMONE_THRESHOLD/), "warning")
  })

  it("Given print mode and an invalid SYSTEMONE_THRESHOLD, When a session starts, Then the warning goes to stderr", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("SYSTEMONE_THRESHOLD", "abc")
    const sessionStart = await loadSessionStart()
    await sessionStart({ type: "session_start" }, printCtx)
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/SYSTEMONE_THRESHOLD/))
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

describe("pi adapter: protected paths", () => {
  function writeCall(path: string): ToolCall {
    return { type: "tool_call", toolCallId: "w1", toolName: "write", input: { path, content: "x" } }
  }
  function editCall(path: string): ToolCall {
    return { type: "tool_call", toolCallId: "e1", toolName: "edit", input: { path, edits: [{ oldText: "a", newText: "b" }] } }
  }

  it("Given an edit on guardrails.md, When it is called, Then it is blocked with a reason and the human is warned", async () => {
    const handler = await loadHandler()
    const result = await handler(editCall(join(dir, "guardrails.md")), ctx)
    expect(result).toMatchObject({ block: true, reason: expect.stringMatching(/protected file — guardrails\.md[\s\S]*restart pi/) })
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^SystemOne-gate: protected file/), "warning")
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given a write under .pi/, When it is called, Then it is blocked", async () => {
    const handler = await loadHandler()
    const result = await handler(writeCall(join(dir, ".pi", "tool.ts")), ctx)
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain("protected file — .pi/")
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given an edit on @guardrails.md, When pi strips the @ prefix, Then it is blocked", async () => {
    const handler = await loadHandler()
    const result = await handler(editCall("@guardrails.md"), ctx)
    expect(result?.reason).toContain("protected file — guardrails.md")
  })

  it("Given a write to ~/<project>/guardrails.md, When pi expands the tilde, Then it is blocked", async () => {
    vi.stubEnv("HOME", dirname(dir))
    const handler = await loadHandler()
    const result = await handler(writeCall(`~/${basename(dir)}/guardrails.md`), ctx)
    expect(result?.reason).toContain("protected file — guardrails.md")
  })

  it("Given a write to a file:// URL of guardrails.md, When pi converts the URL, Then it is blocked", async () => {
    const handler = await loadHandler()
    const result = await handler(writeCall(pathToFileURL(join(dir, "guardrails.md")).href), ctx)
    expect(result?.reason).toContain("protected file — guardrails.md")
  })

  it("Given an edit on a plain source file, When it is called, Then it passes and the human is not warned", async () => {
    const handler = await loadHandler()
    await expect(handler(editCall(join(dir, "src", "a.ts")), ctx)).resolves.toBeUndefined()
    expect(systemOne).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it("Given no Berget credential, When an edit on guardrails.md is called, Then it is still blocked", async () => {
    vi.stubEnv("BERGET_API_KEY", undefined)
    vi.stubEnv("TYPESAFE_API_KEY", undefined)
    const handler = await loadHandler()
    const result = await handler(editCall(join(dir, "guardrails.md")), ctx)
    expect(result?.block).toBe(true)
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given SYSTEMONE_GATE=off, When an edit on guardrails.md is called, Then it passes", async () => {
    vi.stubEnv("SYSTEMONE_GATE", "off")
    const handler = await loadHandler()
    await expect(handler(editCall(join(dir, "guardrails.md")), ctx)).resolves.toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
  })
})
