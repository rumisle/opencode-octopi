// opencode-octopi: lead worker sessions from an OpenCode session. Spawn workers on any model, send
// them messages (interrupt / steer / queue), wait for their results, inspect, fork, compact, kill.
// Workers are ordinary OpenCode sessions; the tools live in Code Mode as `tools.octopi.*`.
import { sqliteHistory } from "./src/history.ts"
import { Octopi, ToolError, type Options } from "./src/octopi.ts"
import * as P from "./src/prompts.ts"
import { Definition, type FleetSnapshot } from "./rpc.ts"

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})
const str = (description: string) => ({ type: "string", description })
const num = (description: string) => ({ type: "number", description })
const bool = (description: string) => ({ type: "boolean", description })

const TOOLS = {
  spawn: {
    description: P.SPAWN,
    input: obj(
      {
        name: str("Your handle for the worker: letters, digits, _ - . (max 40). Never reused."),
        prompt: str("Its first task. Omit to create it idle."),
        model: str('"providerID/modelID[#variant]", or "inherit" (default: your model).'),
        fork: obj({
          from: str('A worker name, or "self" for your own session (default "self").'),
          before: str("Copy history only up to (not including) this message id."),
        }),
        spawner: bool("Give it the octopi tools so it can lead workers of its own (default false)."),
        task: str("Short label for the session title."),
        agent: str("Agent to run as (default: the default agent)."),
        directory: str("Working directory (default: yours)."),
      },
      ["name"],
    ),
  },
  send: {
    description: P.SEND,
    input: obj(
      {
        name: str("Worker name."),
        message: str("The message."),
        mode: { type: "string", enum: ["interrupt", "steer", "queue"], description: 'For a busy worker (default "interrupt").' },
        model: str("Switch its model first."),
      },
      ["name", "message"],
    ),
  },
  wait: {
    description: P.WAIT,
    input: obj({
      names: { type: "array", items: { type: "string" }, description: "Workers to wait on (default: all of yours)." },
      name: str("A single worker (same as names:[name])."),
      timeoutSec: num("Max seconds to block."),
    }),
  },
  list: { description: P.LIST, input: obj({}) },
  inspect: {
    description: P.INSPECT,
    input: obj(
      {
        name: str("Worker name."),
        messages: num("Include a transcript of its last N messages."),
        since: str("Transcript of the messages after this message id instead."),
      },
      ["name"],
    ),
  },
  compact: { description: P.COMPACT, input: obj({ name: str("Worker name.") }, ["name"]) },
  kill: { description: P.KILL, input: obj({ name: str("Worker name.") }, ["name"]) },
} as const

export default {
  id: "opencode-octopi",
  setup: async (ctx: any) => {
    const options: Options = ctx.options ?? {}
    const debug = (...args: unknown[]) => {
      if (process.env.OPENCODE_OCTOPI_DEBUG) console.error("[opencode-octopi]", ...args)
    }
    const octopi = new Octopi(ctx, sqliteHistory(options.database), options)
    await octopi.roster.ready().catch((error) => debug("roster load failed:", String(error)))
    // Continue workers a server restart cut off.
    void octopi.resumeStopped(debug)

    // ── TUI sidebar: fleet snapshots over RPC ──
    let rpc: { events: { emit: (name: "update", data: any) => Promise<void> } } | undefined
    const snapshot = async (leaderID: string, notice?: string): Promise<FleetSnapshot> => ({
      ...(await octopi.fleet(leaderID)),
      ...(notice ? { notice } : {}),
    })
    octopi.onChange = (leaderID, notice) => {
      if (!rpc) return
      // Only the instance that manages the leader reports its fleet (see Octopi.isLocal).
      void octopi
        .isLocal(leaderID)
        .then((local) => (local ? snapshot(leaderID, notice) : undefined))
        .then((snap) => snap && rpc!.events.emit("update", snap))
        .catch((error) => debug("rpc emit failed:", String(error)))
    }
    try {
      rpc = await ctx.rpc.register(Definition as any, {
        fleet: async (input: { sessionID: string }) => snapshot(input.sessionID),
      })
    } catch (error) {
      debug("rpc register failed:", String(error))
    }

    // ── tools ──
    const run =
      (name: keyof typeof TOOLS) =>
      async (input: any, context: any): Promise<{ output: unknown; content: string; metadata?: Record<string, unknown> }> => {
        const leaderID: string = context.sessionID
        if (!octopi.isLeader(leaderID)) throw new Error("octopi: this session is a leaf worker and cannot lead workers")
        octopi.markLocal(leaderID)
        // The workers a call is about, as metadata.sessionIDs: the web app shows a card per
        // worker under the call (patch core/codemode-child-sessions), like the subagent tool's.
        const named = (value: any): unknown[] => (typeof value?.name === "string" ? [value.name] : [])
        try {
          const output =
            name === "spawn"
              ? await octopi.spawn(leaderID, input)
              : name === "send"
                ? await octopi.send(leaderID, input)
                : name === "wait"
                  ? await octopi.wait(leaderID, input, context.signal ?? new AbortController().signal)
                  : name === "list"
                    ? await octopi.list(leaderID, input)
                    : name === "inspect"
                      ? await octopi.inspect(leaderID, input)
                      : name === "compact"
                        ? await octopi.compact(leaderID, input)
                        : await octopi.kill(leaderID, input)
          // wait: the workers whose results it returned; list: none (it is about all of them).
          const finished = Array.isArray((output as any)?.finished) ? (output as any).finished.map((c: any) => c?.name) : []
          const about = name === "wait" ? finished : name === "list" ? [] : [...named(input), ...named(output)]
          const sessionIDs = octopi.sessionIDs(leaderID, about)
          return { output, content: JSON.stringify(output, null, 2), ...(sessionIDs.length ? { metadata: { sessionIDs } } : {}) }
        } catch (error) {
          if (error instanceof ToolError) throw new Error(`octopi ${name}: ${error.message}`)
          debug(name, "failed:", error)
          throw error
        }
      }
    await ctx.tool.transform((editor: any) => {
      editor.namespace({ name: P.NAMESPACE, description: P.NAMESPACE_DESCRIPTION })
      for (const [name, tool] of Object.entries(TOOLS))
        editor.add({
          name,
          description: tool.description,
          input: tool.input,
          output: { type: "object", additionalProperties: true },
          options: { namespace: P.NAMESPACE, codemode: true, pinned: true },
          execute: run(name as keyof typeof TOOLS),
        })
    })

    // ── the leader's system prompt ──
    await ctx.session.hook("context", (event: any) => {
      if (!octopi.isLeader(event.sessionID)) return
      event.system.push({ type: "text", text: P.BLURB })
    })

    // ── session events: activity and fleet changes ──
    const abort = new AbortController()
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) octopi.onEvent(event)
        } catch (error) {
          if (!abort.signal.aborted) debug("event stream error:", String(error))
        }
        if (!abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    })()

    return async () => {
      abort.abort()
      await (rpc as any)?.dispose?.()
    }
  },
}
