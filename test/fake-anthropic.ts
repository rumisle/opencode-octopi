// Fake Anthropic Messages API for end-to-end tests with a real `opencode serve` (see test/e2e.sh).
//
// Scripted by the newest user text in the conversation:
//   "CODE:\n<js>"  → calls `execute` with <js> (a leader driving octopi), then answers
//                    "RESULT: <the execute output>"
//   "SLEEP n"      → calls `shell` with `sleep n`, then answers per REPLY (or "slept n")
//   "REPLY x"      → answers "x" (the rest of the line)
//   "FAIL"         → returns an API error (a failing worker turn)
// Text that arrives after a tool call (a steer) counts as the newest user text. Every request is
// logged to $OUT/requests.jsonl.
import { appendFileSync, mkdirSync } from "node:fs"

const OUT = process.env.OUT ?? "/tmp/octopi-e2e"
mkdirSync(OUT, { recursive: true })

const sse = (content: any[], stop: string, inputTokens: number) =>
  new Response(
    [
      { type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } },
      ...content.flatMap((block, index): any[] =>
        block.type === "text"
          ? [
              { type: "content_block_start", index, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
              { type: "content_block_stop", index },
            ]
          : [
              { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } },
              { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
              { type: "content_block_stop", index },
            ],
      ),
      { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )

const toolResultText = (c: any): string =>
  typeof c.content === "string" ? c.content : (c.content ?? []).map((x: any) => (x.type === "text" ? x.text : "")).join("\n")

// `opencode run` passes a multi-line message as a JSON string literal.
const unquote = (text: string) => {
  if (text.length < 2 || !text.startsWith("\"") || !text.endsWith("\"")) return text
  try {
    return JSON.parse(text) as string
  } catch {
    return text.slice(1, -1)
  }
}

let n = 0
let toolID = 0
const server = Bun.serve({
  port: Number(process.env.FAKE_PORT ?? 4831),
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (!url.pathname.endsWith("/v1/messages")) return new Response("not found", { status: 404 })
    const body = await req.json()
    const messages: any[] = body.messages ?? []
    const system = JSON.stringify(body.system ?? "")
    // Walk the conversation: the newest user text, and whether a tool result came after it.
    let newest = ""
    let resultAfter: string | undefined
    for (const m of messages) {
      if (m.role !== "user") continue
      const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? [])
      for (const part of parts) {
        if (part.type === "tool_result") resultAfter = toolResultText(part)
        if (part.type === "text" && part.text.trim() && !part.text.startsWith("<system-reminder>")) {
          newest = unquote(part.text)
          resultAfter = undefined
        }
      }
    }
    const tools: string[] = (body.tools ?? []).map((t: any) => t.name)
    const inputTokens = 2_000 + messages.length * 100
    appendFileSync(
      `${OUT}/requests.jsonl`,
      JSON.stringify({
        n: ++n,
        newest: newest.slice(-120),
        resultAfter: resultAfter?.slice(0, 200),
        tools,
        blurb: system.includes("Octopi: you can lead worker sessions"),
        worker: newest.includes("[octopi] You are worker"),
        octopiTools: /octopi\.spawn|octopi_spawn/.test(JSON.stringify(body.tools ?? []) + system),
      }) + "\n",
    )
    // Title and other auxiliary requests have no tools.
    if (tools.length === 0) return sse([{ type: "text", text: "Title" }], "end_turn", inputTokens)

    const code = /CODE:\n([\s\S]*)$/.exec(newest)
    if (code) {
      if (resultAfter === undefined)
        return sse([{ type: "tool_use", id: `toolu_${++toolID}`, name: "execute", input: { code: code[1] } }], "tool_use", inputTokens)
      return sse([{ type: "text", text: `RESULT: ${resultAfter}` }], "end_turn", inputTokens)
    }
    if (/\bFAIL\b/.test(newest)) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "scripted failure" } }), { status: 400, headers: { "content-type": "application/json" } })
    const sleep = /SLEEP (\d+)/.exec(newest)
    const reply = /REPLY (.+)/.exec(newest)
    if (sleep && resultAfter === undefined)
      return sse([{ type: "tool_use", id: `toolu_${++toolID}`, name: "shell", input: { command: `sleep ${sleep[1]}`, timeout: 600_000 } }], "tool_use", inputTokens)
    if (reply) return sse([{ type: "text", text: reply[1]!.trim() }], "end_turn", inputTokens)
    if (sleep) return sse([{ type: "text", text: `slept ${sleep[1]}` }], "end_turn", inputTokens)
    return sse([{ type: "text", text: "ok" }], "end_turn", inputTokens)
  },
})
console.log(`fake anthropic on ${server.url}`)
