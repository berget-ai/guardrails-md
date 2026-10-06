import type { On } from "claude-code"
import { describe, expect, mock, test, type Engine } from "claude-code/testing"

const CWD = "/repo"
const POLICY = "MUST NOT delete ./data"
const allow = { answers: { destructive: { noul: 0.01 }, credentials: { noul: 0 } } }
const destructive = { answers: { destructive: { noul: 0.98 }, credentials: { noul: 0 } } }

interface World {
  env?: Record<string, string>
  files?: Record<string, string>
  answer?: () => { status: number; body: unknown } | Promise<never>
}

const hang = () => new Promise<never>(() => {})

function world(on: On, { env = { BERGET_API_KEY: "k" }, files = {}, answer = () => ({ status: 200, body: allow }) }: World) {
  const fetches: { url: string; headers: Record<string, string>; body: string }[] = []
  const toasts: string[] = []
  const ran: string[] = []
  const clock = mock.clock(on)
  mock.env(on, env)
  on("fs.read", ($, e) => (e.path in files ? { value: files[e.path] } : { deny: `ENOENT ${e.path}` }))
  on("fs.stat", ($, e) =>
    e.path in files
      ? { value: { kind: "file" as const, size: files[e.path].length, mtimeMs: 0, isLink: false } }
      : { deny: `ENOENT ${e.path}` },
  )
  on("http.fetch", async ($, e) => {
    fetches.push({ url: e.url, headers: e.init?.headers ?? {}, body: e.init?.body ?? "" })
    try {
      const { status, body } = await answer()
      return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } }
    } catch (err) {
      return { deny: String(err) }
    }
  })
  on("ui.toast", ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on("session.start", ($, e) => ({ cwd: e.cwd }))
  on("tool.call", { tool: ["Bash", "Monitor"] }, ($, e) => {
    ran.push(e.tool === "Monitor" && e.ws ? `ws ${e.ws.url}` : String(e.command))
    return { result: {} }
  })
  return { fetches, toasts, ran, clock }
}

async function start($: Engine) {
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
}

function bash($: Engine, command: string) {
  return $.tool.call({ tool: "Bash", command })
}

function monitor($: Engine, watch: { command: string } | { ws: { url: string } }) {
  return $.tool.call({ tool: "Monitor", description: "watch", timeout_ms: 60_000, ...watch })
}

describe("guardrails-md mod", () => {
  test("Given an allow verdict, When Bash runs, Then the command reaches the tool", async ($, on) => {
    const w = world(on, { files: { [`${CWD}/guardrails.md`]: POLICY } })
    await start($)
    const out = await bash($, "ls")
    expect(out.deny).toBeUndefined()
    expect(w.ran).toEqual(["ls"])
    expect(w.fetches[0].url).toBe("https://api.berget.ai/v1/systemone")
    expect(w.fetches[0].headers.Authorization).toBe("Bearer k")
    const body = JSON.parse(w.fetches[0].body)
    expect(body.model).toBe("berget/bev")
    expect(body.state.text).toContain(POLICY)
    expect(body.questions.destructive.type).toBe("noul")
  })

  test("Given a destructive verdict, When Bash runs, Then the call is denied with the reason", async ($, on) => {
    const w = world(on, { answer: () => ({ status: 200, body: destructive }) })
    await start($)
    const out = await bash($, "rm -rf ./data")
    expect(out.deny).toContain("SystemOne-gate: blocked command — destructive=0.98")
    expect(out.deny).toContain("restart claude")
    expect(w.ran).toEqual([])
  })

  test("Given no credential, When the session starts and Bash runs, Then the human is warned and the gate is inactive", async ($, on) => {
    const w = world(on, { env: {} })
    await start($)
    await bash($, "rm -rf ./data")
    expect(w.toasts.join("\n")).toContain("guardrails-md inactive")
    expect(w.fetches).toEqual([])
    expect(w.ran).toEqual(["rm -rf ./data"])
  })

  test("Given a blocked command, When the next command follows at once, Then the cooldown denies it unjudged", async ($, on) => {
    const w = world(on, { env: { BERGET_API_KEY: "k" }, answer: () => ({ status: 200, body: destructive }) })
    await start($)
    for (let i = 0; i < 10; i++) await bash($, "rm -rf ./data")
    const judged = w.fetches.length
    const out = await bash($, "ls")
    expect(out.deny).toContain("cooling down")
    expect(w.fetches.length).toBe(judged)
    expect(w.ran).toEqual([])
  })

  test("Given the fetch is refused, When Bash runs, Then the call is denied fail-closed", async ($, on) => {
    const w = world(on, { answer: () => Promise.reject(new Error("refused by web-fetch policy")) })
    await start($)
    const out = await bash($, "ls")
    expect(out.deny).toContain("endpoint unreachable — command blocked")
    expect(w.ran).toEqual([])
  })

  test("Given the endpoint answers 402, When Bash runs, Then the denial names the credit problem", async ($, on) => {
    world(on, { answer: () => ({ status: 402, body: { error: "no credit" } }) })
    await start($)
    const out = await bash($, "ls")
    expect(out.deny).toContain("out of credit")
  })

  test("Given a hung endpoint, When 5 s pass, Then the call is denied as unreachable", async ($, on) => {
    const w = world(on, { answer: hang })
    await start($)
    const pending = bash($, "ls")
    await w.clock.advance(0)
    await w.clock.advance(5000)
    const out = await pending
    expect(out.deny).toContain("endpoint unreachable — command blocked")
    expect(out.deny).toContain("timed out after 5000 ms")
    expect(w.ran).toEqual([])
  })

  test("Given scores sent as strings, When Bash runs, Then they are coerced and judged", async ($, on) => {
    const w = world(on, { answer: () => ({ status: 200, body: { answers: { destructive: { noul: "0.98" } } } }) })
    await start($)
    const out = await bash($, "rm -rf ./data")
    expect(out.deny).toContain("SystemOne-gate: blocked command — destructive=0.98 > 0.7")
    expect(w.ran).toEqual([])
  })

  test("Given a command the gate cannot read, When Bash runs, Then .catch denies the call", async ($, on) => {
    const w = world(on, {})
    await start($)
    const out = await $.tool.call({ tool: "Bash", command: 42 as unknown as string })
    expect(out.deny).toContain("the gate failed (throw")
    expect(out.deny).toContain("fail-closed")
    expect(w.ran).toEqual([])
  })

  test("Given a destructive Monitor command, When Monitor runs, Then the call is denied", async ($, on) => {
    const w = world(on, { answer: () => ({ status: 200, body: destructive }) })
    await start($)
    const out = await monitor($, { command: "rm -rf ./data" })
    expect(out.deny).toContain("SystemOne-gate: blocked command — destructive=0.98")
    expect(JSON.parse(w.fetches[0].body).state.text).toContain("rm -rf ./data")
    expect(w.ran).toEqual([])
  })

  test("Given a Monitor on a WebSocket, When Monitor runs, Then it passes unjudged", async ($, on) => {
    const w = world(on, {})
    await start($)
    const out = await monitor($, { ws: { url: "wss://example.com/feed" } })
    expect(out.deny).toBeUndefined()
    expect(w.fetches).toEqual([])
    expect(w.ran).toEqual(["ws wss://example.com/feed"])
  })

  test("Given no session.start, When Bash runs, Then the call is denied fail-closed", async ($, on) => {
    const w = world(on, {})
    const out = await bash($, "ls")
    expect(out.deny).toContain("session.start did not run")
    expect(w.ran).toEqual([])
  })

  test("Given SYSTEMONE_GATE=off, When Bash runs, Then nothing is judged", async ($, on) => {
    const w = world(on, { env: { BERGET_API_KEY: "k", SYSTEMONE_GATE: "off" } })
    await start($)
    await bash($, "rm -rf ./data")
    expect(w.fetches).toEqual([])
    expect(w.ran).toEqual(["rm -rf ./data"])
  })
})
