// Reads worker history straight from OpenCode's SQLite database, read-only.
//
// ⚠️ Workaround: plugins can only read a session's post-compaction context, not its full history
// or its end-of-turn `idle` markers. Until upstream exposes message reads to plugins (#49568), read
// the `session_message` table directly, like opencode-vcc does. The server keeps the database in
// WAL mode, so a read-only connection sees every committed message without blocking writes.
import { Database } from "bun:sqlite"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export interface Row {
  id: string
  type: string
  seq: number
  created: number
  data: any
}

export interface History {
  /** Every message of the session in `seq` order ([] if unknown). */
  rows(sessionID: string): Row[]
}

/** Candidate database files: an explicit path, $OPENCODE_DB, else every opencode*.db in the data dir. */
export const candidateDatabases = (explicit?: string): string[] => {
  if (explicit) return [explicit]
  if (process.env.OPENCODE_DB && process.env.OPENCODE_DB !== ":memory:") return [process.env.OPENCODE_DB]
  const data = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share"), "opencode")
  if (!existsSync(data)) return []
  const names = readdirSync(data).filter((name) => /^opencode.*\.db$/.test(name))
  names.sort((a, b) => Number(b === "opencode.db") - Number(a === "opencode.db") || a.localeCompare(b))
  return names.map((name) => path.join(data, name))
}

export const sqliteHistory = (explicit?: string): History => {
  const open = new Map<string, Database>()
  const bySession = new Map<string, string>()
  const db = (file: string) => {
    let handle = open.get(file)
    if (handle) return handle
    if (!existsSync(file)) return undefined
    try {
      handle = new Database(file, { readonly: true })
      open.set(file, handle)
      return handle
    } catch {
      return undefined
    }
  }
  const query = (file: string, sessionID: string) => {
    try {
      return db(file)
        ?.query<{ id: string; type: string; seq: number; time_created: number; data: string }, [string]>(
          "select id, type, seq, time_created, data from session_message where session_id = ? order by seq",
        )
        .all(sessionID)
    } catch {
      return undefined
    }
  }
  return {
    rows(sessionID) {
      const known = bySession.get(sessionID)
      for (const file of known ? [known] : candidateDatabases(explicit)) {
        const found = query(file, sessionID)
        if (!found || found.length === 0) continue
        bySession.set(sessionID, file)
        return found.flatMap((row) => {
          try {
            return [{ id: row.id, type: row.type, seq: row.seq, created: row.time_created, data: JSON.parse(row.data) }]
          } catch {
            return []
          }
        })
      }
      return []
    },
  }
}

// ── Reading turns ────────────────────────────────────────────────────────────

/** A finished turn: everything between two `idle` markers. */
export interface Turn {
  /** The `idle` marker's message id: the completion's identity. */
  id: string
  outcome: "succeeded" | "failed" | "interrupted"
  /** When the turn's first input was recorded, and when it went idle. */
  started: number
  ended: number
  /** Text of the turn's last assistant message ("" if it produced none). */
  text: string
  /** When the turn handled several inputs (steered or queued messages): the final non-empty reply
   *  to each input before the last, oldest first. */
  earlier: string[]
  /** Error of the turn's last assistant message, if any. */
  error?: string
  cost: number
  /** The turn compacted the context. */
  compaction?: boolean
}

const textOf = (message: any): string =>
  (message?.content ?? [])
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("")
    .trim()

const errorOf = (message: any): string | undefined => {
  const error = message?.error
  if (!error) return undefined
  return error.message ?? error.data?.message ?? error.name ?? error.type ?? JSON.stringify(error).slice(0, 200)
}

/** Finished turns in order. A turn with no idle marker yet (still running) is not included. */
export function turns(rows: Row[]): Turn[] {
  const result: Turn[] = []
  let start: number | undefined
  let last: any
  let cost = 0
  let compaction = false
  // Final non-empty reply to each input so far in this turn.
  let earlier: string[] = []
  let segmentReply = ""
  for (const row of rows) {
    if (row.type === "idle") {
      result.push({
        id: row.id,
        outcome: row.data?.outcome ?? "succeeded",
        started: start ?? row.created,
        ended: row.data?.time?.created ?? row.created,
        text: textOf(last),
        earlier,
        ...(errorOf(last) ? { error: errorOf(last) } : {}),
        cost,
        ...(compaction ? { compaction } : {}),
      })
      start = undefined
      last = undefined
      cost = 0
      compaction = false
      earlier = []
      segmentReply = ""
      continue
    }
    if (start === undefined) start = row.created
    if (row.type === "user" || row.type === "synthetic") {
      if (segmentReply) earlier.push(segmentReply)
      segmentReply = ""
    }
    if (row.type === "assistant" && textOf(row.data)) segmentReply = textOf(row.data)
    if (row.type === "assistant") {
      last = row.data
      cost += row.data?.cost ?? 0
    }
    if (row.type === "compaction") {
      cost += row.data?.cost ?? 0
      compaction = true
    }
  }
  return result
}

/**
 * A turn that stopped without finishing: messages after the last `idle` marker while the session
 * is not running. Happens when the server stops mid-turn and does not resume it (a non-service
 * server never does; the service resumes at boot, which later produces a real end-of-turn).
 */
export function stoppedTurn(rows: Row[]): Turn | undefined {
  const lastIdle = rows.findLastIndex((row) => row.type === "idle")
  const tail = rows.slice(lastIdle + 1)
  if (tail.length === 0) return undefined
  // Only a tail with real input counts (not e.g. a lone system notice).
  if (!tail.some((row) => row.type === "user" || row.type === "synthetic" || row.type === "assistant")) return undefined
  const last = tail.findLast((row) => row.type === "assistant")?.data
  return {
    id: `${tail.at(-1)!.id}:stopped`,
    outcome: "interrupted",
    started: tail[0]!.created,
    ended: tail.at(-1)!.created,
    text: textOf(last),
    earlier: [],
    error: "the turn stopped without finishing (the server probably restarted and did not resume it)",
    cost: tail.reduce((sum, row) => sum + (row.type === "assistant" ? (row.data?.cost ?? 0) : 0), 0),
  }
}

/** Prompt size of the latest assistant step, for context-usage display. */
export function lastPromptTokens(rows: Row[]): number | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.type === "compaction" && row.data?.status === "completed") return undefined
    const t = row.type === "assistant" ? row.data?.tokens : undefined
    if (t) return (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
  }
  return undefined
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text)
const oneLine = (value: unknown) => JSON.stringify(value) ?? ""

/** A compact transcript of the last `limit` messages (or those after `since`), for `inspect`. */
export function transcript(rows: Row[], options: { limit: number; since?: string; maxChars?: number }): string {
  const max = options.maxChars ?? 2000
  let selected = rows
  if (options.since) {
    const index = rows.findIndex((row) => row.id === options.since)
    selected = index === -1 ? rows : rows.slice(index + 1)
  }
  selected = selected.slice(-options.limit)
  const lines: string[] = []
  for (const row of selected) {
    const d = row.data ?? {}
    switch (row.type) {
      case "user":
        lines.push(`[${row.id}] USER: ${clip(d.text ?? "", max)}`)
        break
      case "synthetic":
        lines.push(`[${row.id}] SYNTHETIC: ${clip(d.text ?? "", max)}`)
        break
      case "assistant": {
        const parts: string[] = []
        for (const part of d.content ?? []) {
          if (part.type === "text" && part.text?.trim()) parts.push(clip(part.text.trim(), max))
          if (part.type === "tool") {
            const status = part.state?.status ?? "?"
            const out = (part.state?.content ?? [])
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n")
            parts.push(
              `→ ${part.name}(${clip(oneLine(part.state?.input ?? {}), 300)}) ${status}${out ? `: ${clip(out, Math.min(max, 500))}` : ""}`,
            )
          }
        }
        if (d.error) parts.push(`ERROR: ${errorOf(d)}`)
        lines.push(`[${row.id}] ASSISTANT: ${parts.join("\n  ")}`)
        break
      }
      case "compaction":
        lines.push(`[${row.id}] COMPACTION (${d.status})`)
        break
      case "idle":
        lines.push(`[${row.id}] — turn ended: ${d.outcome} —`)
        break
    }
  }
  return lines.join("\n")
}
