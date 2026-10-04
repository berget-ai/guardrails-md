import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// --- mock the SDK before importing the plugin -------------------------------
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

type Hooks = {
  "tool.execute.before": (input: { tool: string; callID?: string }, output: { args: { command?: string } }) => Promise<void>
}

async function loadPlugin() {
  const mod = await import("./index.js")
  return mod
}

let dir: string
let home: string

function seedAuth(auth: unknown) {
  const dataDir = join(home, ".local", "share")
  mkdirSync(join(dataDir, "opencode"), { recursive: true })
  writeFileSync(join(dataDir, "opencode", "auth.json"), JSON.stringify(auth))
}

function seedGuardrails(text: string, sub = false) {
  const p = sub ? join(dir, ".opencode", "guardrails.md") : join(dir, "guardrails.md")
  mkdirSync(p.replace(/\/[^/]+$/, ""), { recursive: true })
  writeFileSync(p, text)
}

async function makeHooks(env: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const mod = await loadPlugin()
  return (await mod.default({ directory: dir })) as Hooks
}

const allow = { answers: { destructive: { noul: 0.01 }, credentials: { noul: 0.0 } } }
const blockDestructive = { answers: { destructive: { noul: 0.98 }, credentials: { noul: 0.0 } } }

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  home = mkdtempSync(join(tmpdir(), "gate-home-"))
  dir = mkdtempSync(join(tmpdir(), "gate-proj-"))
  // every code path — direct __internals calls included — must stay inside
  // the temp HOME, never the developer's real auth.json
  vi.stubEnv("HOME", home)
  process.env.BERGET_API_KEY = "test-key"
  delete process.env.SYSTEMONE_GATE
  delete process.env.SYSTEMONE_FAIL_OPEN
  delete process.env.SYSTEMONE_LOG
  delete process.env.SYSTEMONE_THRESHOLD
  delete process.env.XDG_DATA_HOME
  systemOne.mockResolvedValue(structuredClone(allow))
  state.configs.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

describe("gatewayRoot", () => {
  it.each([
    ["https://api.berget.ai", "https://api.berget.ai"],
    ["https://api.berget.ai/", "https://api.berget.ai"],
    ["https://api.berget.ai/v1/systemone", "https://api.berget.ai"],
    ["https://api.berget.ai/v1/systemone/", "https://api.berget.ai"],
    ["https://gw.example.com/deep/v1/systemone", "https://gw.example.com/deep"],
  ])("normalizes %s -> %s", async (input, expected) => {
    const { __internals } = await loadPlugin()
    expect(__internals.gatewayRoot(input)).toBe(expected)
  })
})

describe("backoffMs", () => {
  it.each([
    [0, 0],
    [1, 10],
    [2, 20],
    [3, 40],
    [10, 5_120],
    [20, 5_242_880],
  ])("block %i -> %i ms", async (blocks, ms) => {
    const { __internals } = await loadPlugin()
    expect(__internals.backoffMs(blocks)).toBe(ms)
  })
  it("has no practical ceiling (block 25 ≈ 2 days)", async () => {
    const { __internals } = await loadPlugin()
    expect(__internals.backoffMs(25)).toBe(10 * 2 ** 24)
  })
  it("stays finite at absurd counts (exponent cap)", async () => {
    const { __internals } = await loadPlugin()
    expect(Number.isFinite(__internals.backoffMs(10_000))).toBe(true)
    expect(__internals.backoffMs(10_000)).toBe(__internals.backoffMs(41))
  })
})

describe("seatToken", () => {
  it("returns the access token for a valid oauth entry", async () => {
    seedAuth({ berget: { type: "oauth", access: "tok-1", refresh: "r", expires: Date.now() + 60_000 } })
    const { __internals } = await loadPlugin()
    expect(__internals.seatToken()).toBe("tok-1")
  })
  it("returns null for an expired token", async () => {
    seedAuth({ berget: { type: "oauth", access: "tok-old", expires: Date.now() - 1000 } })
    const { __internals } = await loadPlugin()
    expect(__internals.seatToken()).toBeNull()
  })
  it("parses string expires", async () => {
    seedAuth({ berget: { type: "oauth", access: "tok-2", expires: String(Date.now() + 60_000) } })
    const { __internals } = await loadPlugin()
    expect(__internals.seatToken()).toBe("tok-2")
  })
  it.each([
    ["non-oauth type", { berget: { type: "api", access: "x", expires: Date.now() + 60_000 } }],
    ["missing access", { berget: { type: "oauth", expires: Date.now() + 60_000 } }],
    ["missing entry", {}],
  ])("returns null: %s", async (_label, auth) => {
    seedAuth(auth)
    const { __internals } = await loadPlugin()
    expect(__internals.seatToken()).toBeNull()
  })
  it("returns null when auth.json is missing or malformed", async () => {
    const { __internals } = await loadPlugin()
    expect(__internals.seatToken()).toBeNull()
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true })
    writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), "{not json")
    expect(__internals.seatToken()).toBeNull()
  })
  it("honors XDG_DATA_HOME", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "gate-xdg-"))
    process.env.XDG_DATA_HOME = xdg
    mkdirSync(join(xdg, "opencode"), { recursive: true })
    writeFileSync(join(xdg, "opencode", "auth.json"), JSON.stringify({ berget: { type: "oauth", access: "xdg-tok", expires: Date.now() + 60_000 } }))
    const { __internals } = await loadPlugin()
    expect(__internals.seatToken()).toBe("xdg-tok")
    rmSync(xdg, { recursive: true, force: true })
  })
})

describe("readGuardrails (frozen at load)", () => {
  it("reads guardrails.md from the repo root", async () => {
    seedGuardrails("# rules\n- no force push")
    const { __internals } = await loadPlugin()
    expect(__internals.readGuardrails(dir)).toContain("no force push")
  })
  it("falls back to .opencode/guardrails.md", async () => {
    seedGuardrails("# sub rules", true)
    const { __internals } = await loadPlugin()
    expect(__internals.readGuardrails(dir)).toContain("sub rules")
  })
  it("returns null when absent", async () => {
    const { __internals } = await loadPlugin()
    expect(__internals.readGuardrails(dir)).toBeNull()
  })
  it("truncates at 2000 chars", async () => {
    seedGuardrails("x".repeat(3000))
    const { __internals } = await loadPlugin()
    const g = __internals.readGuardrails(dir)!
    expect(g.length).toBeLessThan(2100)
    expect(g).toContain("truncated")
  })
  it("freezes: later file edits are ignored until reset", async () => {
    seedGuardrails("# original")
    const { __internals } = await loadPlugin()
    expect(__internals.readGuardrails(dir)).toContain("original")
    seedGuardrails("# WEAKENED BY AGENT")
    expect(__internals.readGuardrails(dir)).toContain("original")
    __internals.resetGuardrailsCache()
    expect(__internals.readGuardrails(dir)).toContain("WEAKENED")
  })
})

describe("judge", () => {
  async function client() {
    const { TypeSafeClient } = await import("@typesafe-ai/sdk")
    return new TypeSafeClient({ apiKey: "k" }) as { systemOne: (r: unknown) => Promise<unknown> }
  }
  it("includes guardrails in the state and adds the violation question", async () => {
    seedGuardrails("# rules")
    const { __internals } = await loadPlugin()
    await __internals.judge(await client(), "ls -la", "# rules")
    const req = systemOne.mock.calls[0][0]
    expect(req.state.text).toContain("ls -la")
    expect(req.state.text).toContain("# rules")
    expect(Object.keys(req.questions)).toContain("guardrails_violation")
  })
  it("omits the violation question without guardrails", async () => {
    const { __internals } = await loadPlugin()
    await __internals.judge(await client(), "ls -la", null)
    expect(Object.keys(systemOne.mock.calls[0][0].questions)).not.toContain("guardrails_violation")
  })
  it("defaults missing answers to 0", async () => {
    systemOne.mockResolvedValue({ answers: {} })
    const { __internals } = await loadPlugin()
    const v = await __internals.judge(await client(), "ls", null)
    expect(v.destructive).toBe(0)
    expect(v.credentials).toBe(0)
    expect(v.guardrails_violation).toBeUndefined()
  })
})

describe("hook: happy path", () => {
  it("allows a safe verdict", async () => {
    const hooks = await makeHooks()
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "ls -la" } })).resolves.toBeUndefined()
  })
  it("ignores non-bash tools", async () => {
    const hooks = await makeHooks()
    await hooks["tool.execute.before"]({ tool: "edit" }, { args: {} })
    expect(systemOne).not.toHaveBeenCalled()
  })
  it("is inactive without any credential", async () => {
    delete process.env.BERGET_API_KEY
    const hooks = await makeHooks()
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "rm -rf /" } })).resolves.toBeUndefined()
    expect(systemOne).not.toHaveBeenCalled()
  })
  it("uses the seat token when no API key is set", async () => {
    seedAuth({ berget: { type: "oauth", access: "seat-tok", expires: Date.now() + 60_000 } })
    delete process.env.BERGET_API_KEY
    const hooks = await makeHooks()
    await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "ls" } })
    expect(state.configs[0]?.apiKey).toBe("seat-tok")
  })
  it("falls back to BERGET_API_KEY when the seat token is expired", async () => {
    seedAuth({ berget: { type: "oauth", access: "old", expires: Date.now() - 1000 } })
    const hooks = await makeHooks()
    await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "ls" } })
    expect(state.configs[0]?.apiKey).toBe("test-key")
  })
})

describe("hook: blocking", () => {
  it("blocks above threshold with kind, scores and human-only override", async () => {
    systemOne.mockResolvedValue(blockDestructive)
    const hooks = await makeHooks()
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "rm -rf /data" } })).rejects.toThrow(
      /destructive=0\.98.*SYSTEMONE_GATE=off.*SYSTEMONE_THRESHOLD/s,
    )
  })
  it("picks the worst dimension for the message", async () => {
    systemOne.mockResolvedValue({ answers: { destructive: { noul: 0.1 }, credentials: { noul: 0.9 } } })
    const hooks = await makeHooks()
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "x" } })).rejects.toThrow(/credentials=0\.90/)
  })
  it("respects SYSTEMONE_THRESHOLD", async () => {
    systemOne.mockResolvedValue({ answers: { destructive: { noul: 0.75 }, credentials: { noul: 0 } } })
    const hooks = await makeHooks({ SYSTEMONE_THRESHOLD: "0.9" })
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "x" } })).resolves.toBeUndefined()
  })
  it("SYSTEMONE_GATE=off disables everything", async () => {
    systemOne.mockResolvedValue(blockDestructive)
    const hooks = await makeHooks({ SYSTEMONE_GATE: "off" })
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "rm -rf /" } })).resolves.toBeUndefined()
    expect(systemOne).not.toHaveBeenCalled()
  })
})

describe("hook: fail-closed default", () => {
  it("blocks when the endpoint errors (default)", async () => {
    systemOne.mockRejectedValue(new Error("gateway down"))
    const hooks = await makeHooks()
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "x" } })).rejects.toThrow(/endpoint unreachable/)
  })
  it("fails open only with SYSTEMONE_FAIL_OPEN=1", async () => {
    systemOne.mockRejectedValue(new Error("gateway down"))
    const hooks = await makeHooks({ SYSTEMONE_FAIL_OPEN: "1" })
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "x" } })).resolves.toBeUndefined()
  })
})

describe("hook: circumvention cooldown", () => {
  it("the command right after a block gets a visible cooldown error", async () => {
    vi.useFakeTimers()
    systemOne.mockResolvedValue(blockDestructive)
    const hooks = await makeHooks()
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "a" } })).rejects.toThrow(/blocked command/)
    // within the 10 ms cooldown: explicit error, no model call
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "b" } })).rejects.toThrow(
      /cooling down after 1 blocked command.*next attempt in ~10 ms.*doubles with every block/s,
    )
    expect(systemOne).toHaveBeenCalledTimes(1)
  })
  it("after the cooldown the command is judged normally", async () => {
    vi.useFakeTimers()
    const hooks = await makeHooks()
    systemOne.mockResolvedValueOnce(blockDestructive)
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "a" } })).rejects.toThrow()
    systemOne.mockResolvedValue(structuredClone(allow))
    await vi.advanceTimersByTimeAsync(10)
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "b" } })).resolves.toBeUndefined()
  })
  it("the cooldown doubles with every block and early retries do not extend it", async () => {
    vi.useFakeTimers()
    systemOne.mockResolvedValue(blockDestructive)
    const hooks = await makeHooks()
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "a" } })).rejects.toThrow()
    // hammer during the cooldown: same error, count unchanged
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "b" } })).rejects.toThrow(/after 1 blocked/)
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "c" } })).rejects.toThrow(/after 1 blocked/)
    await vi.advanceTimersByTimeAsync(10)
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "d" } })).rejects.toThrow(/blocked command/)
    // block 2 → 500 ms cooldown
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "e" } })).rejects.toThrow(/after 2 blocked/)
    await vi.advanceTimersByTimeAsync(10)
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "f" } })).rejects.toThrow(/cooling down after 2/)
    await vi.advanceTimersByTimeAsync(10)
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "g" } })).rejects.toThrow(/blocked command/)
  })
  it("cooldown errors do not grow the block count", async () => {
    vi.useFakeTimers()
    const hooks = await makeHooks()
    systemOne.mockResolvedValueOnce(blockDestructive)
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "a" } })).rejects.toThrow()
    for (let i = 0; i < 5; i++) {
      await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "x" } })).rejects.toThrow(/after 1 blocked/)
    }
    await vi.advanceTimersByTimeAsync(10)
    systemOne.mockResolvedValue(structuredClone(allow))
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "ok" } })).resolves.toBeUndefined()
  })
})

describe("hook: endpoint error messages", () => {
  it.each([
    [402, /out of credit.*berget\.ai/s],
    [401, /authentication failed.*re-login/s],
    [429, /rate limited.*wait a moment/s],
  ])("status %i explains itself", async (status, pattern) => {
    systemOne.mockRejectedValue(Object.assign(new Error("api"), { status }))
    const hooks = await makeHooks()
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "x" } })).rejects.toThrow(pattern)
  })
  it("network errors say endpoint unreachable", async () => {
    systemOne.mockRejectedValue(new Error("socket hang up"))
    const hooks = await makeHooks()
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "x" } })).rejects.toThrow(/endpoint unreachable/)
  })
})

describe("audit log (opt-in)", () => {
  it("writes nothing by default", async () => {
    systemOne.mockResolvedValue(blockDestructive)
    const hooks = await makeHooks()
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "x" } })).rejects.toThrow()
    expect(existsSync(join(home, ".cache", "opencode", "systemone-gate.log"))).toBe(false)
  })
  it("writes JSONL with scores and backoff when SYSTEMONE_LOG=1", async () => {
    systemOne.mockResolvedValue(blockDestructive)
    const hooks = await makeHooks({ SYSTEMONE_LOG: "1" })
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "x" } })).rejects.toThrow()
    const line = JSON.parse(readFileSync(join(home, ".cache", "opencode", "systemone-gate.log"), "utf8").trim())
    expect(line.decision).toBe("BLOCK")
    expect(line.destructive).toBeCloseTo(0.98)
    expect(line.blockCount).toBe(1)
    expect(line.cooldownMs).toBe(10)
  })
})
