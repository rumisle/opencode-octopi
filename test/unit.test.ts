import { describe, expect, test } from "bun:test"
import { lastPromptTokens, type Row, stoppedTurn, transcript, turns } from "../src/history.ts"
import { Activity, formatModel, parseModel } from "../src/octopi.ts"
import { Roster } from "../src/roster.ts"

let seq = 0
const row = (type: string, data: any = {}, id = `m${++seq}`): Row => ({ id, type, seq, created: seq * 1000, data })
const user = (text: string) => row("user", { text })
const assistant = (text: string, extra: any = {}) => row("assistant", { content: text ? [{ type: "text", text }] : [], ...extra })
const tool = (name: string) => row("assistant", { content: [{ type: "tool", name, state: { status: "completed", input: { command: "ls" } } }], cost: 0.01 })
const idle = (outcome = "succeeded", id?: string) => row("idle", { outcome, time: { created: seq * 1000 } }, id)

describe("turns", () => {
  test("one turn per idle marker, with its final text and cost", () => {
    const rows = [user("a"), tool("shell"), assistant("done a", { cost: 0.02 }), idle("succeeded", "i1"), user("b"), assistant("done b"), idle("failed", "i2")]
    const t = turns(rows)
    expect(t.map((x) => [x.id, x.outcome, x.text])).toEqual([
      ["i1", "succeeded", "done a"],
      ["i2", "failed", "done b"],
    ])
    expect(t[0]!.cost).toBeCloseTo(0.03)
    expect(t[0]!.earlier).toEqual([])
  })

  test("replies to earlier inputs in the same turn (queued or steered)", () => {
    const rows = [user("first"), tool("shell"), user("steer"), assistant("reply 1"), user("queued"), assistant("reply 2"), idle()]
    const [t] = turns(rows)
    expect(t!.text).toBe("reply 2")
    expect(t!.earlier).toEqual(["reply 1"])
  })

  test("errors and compaction", () => {
    const rows = [user("x"), assistant("", { error: { type: "api", message: "boom" } }), idle("failed"), row("compaction", { status: "completed", cost: 0.5 }), idle()]
    const [a, b] = turns(rows)
    expect(a!.error).toBe("boom")
    expect(b!.compaction).toBe(true)
    expect(b!.cost).toBe(0.5)
  })

  test("a running turn (no marker yet) is not a turn", () => {
    expect(turns([user("x"), assistant("partial")])).toEqual([])
  })
})

describe("stoppedTurn", () => {
  test("messages after the last marker are a stopped turn", () => {
    const rows = [user("a"), assistant("done"), idle(), user("b"), assistant("half way")]
    const s = stoppedTurn(rows)!
    expect(s.outcome).toBe("interrupted")
    expect(s.text).toBe("half way")
    expect(s.id.endsWith(":stopped")).toBe(true)
  })
  test("nothing after the marker, or only system notices, is not", () => {
    expect(stoppedTurn([user("a"), idle()])).toBeUndefined()
    expect(stoppedTurn([user("a"), idle(), row("system", { text: "env changed" })])).toBeUndefined()
  })
})

test("lastPromptTokens counts input and cache, and resets at compaction", () => {
  const rows = [assistant("x", { tokens: { input: 10, output: 5, cache: { read: 100, write: 20 } } })]
  expect(lastPromptTokens(rows)).toBe(130)
  expect(lastPromptTokens([...rows, row("compaction", { status: "completed" })])).toBeUndefined()
})

test("transcript renders messages and tool calls compactly", () => {
  const rows = [user("hello"), tool("shell"), assistant("bye"), idle()]
  const text = transcript(rows, { limit: 10 })
  expect(text).toContain("USER: hello")
  expect(text).toContain('→ shell({"command":"ls"}) completed')
  expect(text).toContain("ASSISTANT: bye")
  expect(text).toContain("turn ended: succeeded")
  expect(transcript(rows, { limit: 10, since: rows[2]!.id }).split("\n")).toHaveLength(1)
})

test("parseModel and formatModel", () => {
  expect(parseModel("anthropic/claude-opus-5-5")).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" })
  expect(parseModel("openrouter/anthropic/claude#high")).toEqual({ providerID: "openrouter", id: "anthropic/claude", variant: "high" })
  expect(() => parseModel("opus")).toThrow("Invalid model")
  expect(formatModel({ providerID: "a", id: "b", variant: "default" })).toBe("a/b")
  expect(formatModel({ providerID: "a", id: "b", variant: "high" })).toBe("a/b#high")
})

const memoryStorage = () => {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
    scan: async ({ prefix }: { prefix: string }) => ({
      entries: [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    }),
  }
}

test("roster: ownership, tree roots, descendants, persistence", async () => {
  const storage = memoryStorage()
  const roster = new Roster(storage)
  await roster.ready()
  await roster.add({ name: "a", sessionID: "A", leaderID: "L", spawner: true, createdAt: 1 })
  await roster.add({ name: "b", sessionID: "B", leaderID: "L", spawner: false, createdAt: 2 })
  await roster.add({ name: "c", sessionID: "C", leaderID: "A", spawner: false, createdAt: 3 })
  expect(roster.root("C")).toBe("L")
  expect(roster.descendants("L").map((w) => w.name).sort()).toEqual(["a", "b", "c"])
  expect(roster.worker("C")?.name).toBe("c")
  await roster.update("L", "b", (w) => (w.consumed = "x"))
  // A new roster (server restart) loads the same state.
  const again = new Roster(storage)
  await again.ready()
  expect(again.get("L", "b")?.consumed).toBe("x")
  expect(again.root("C")).toBe("L")
})

describe("Activity", () => {
  test("tracks execution events and wakes waiters on settle", async () => {
    const activity = new Activity(async () => {})
    activity.onEvent({ type: "session.execution.started", data: { sessionID: "s" } })
    expect(await activity.isBusy("s")).toBe(true)
    const signal = new AbortController().signal
    const settled = activity.nextSettle(new Set(["s"]), signal)
    activity.onEvent({ type: "session.execution.succeeded", data: { sessionID: "s" } })
    await settled
    expect(await activity.isBusy("s")).toBe(false)
  })

  test("probes unknown sessions: an idle one resolves wait at once", async () => {
    const idle = new Activity(async () => {})
    expect(await idle.isBusy("x")).toBe(false)
    const busy = new Activity(() => new Promise(() => {}))
    expect(await busy.isBusy("y")).toBe(true)
  })
})
