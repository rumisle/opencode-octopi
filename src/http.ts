// ⚠️ Workaround: fork and compact over OpenCode's HTTP API.
//
// The plugin API has no `session.fork` or `session.compact` yet (#48005, #49389), but the server's
// HTTP API does. The plugin runs inside the server, so it calls it over loopback. It needs the
// server's URL and password: from the `server` plugin option, else from the service registration
// OpenCode writes in service mode ($XDG_STATE_HOME/opencode/service.json, or service-<channel>.json
// for builds on another release channel).
import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export interface ServerOptions {
  url: string
  password?: string
}

export const stateDir = () => path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local/state"), "opencode")

/** The server to call, re-read on every use so a restarted service (new port) is picked up. */
export function resolveServer(option?: ServerOptions): ServerOptions | undefined {
  if (option?.url) return option
  let files: string[]
  try {
    files = readdirSync(stateDir()).filter((name) => /^service(-.+)?\.json$/.test(name))
  } catch {
    return undefined
  }
  // The registration written by the server this plugin runs in.
  for (const name of files) {
    try {
      const info = JSON.parse(readFileSync(path.join(stateDir(), name), "utf8"))
      if (typeof info.url !== "string" || info.pid !== process.pid) continue
      return { url: info.url, password: typeof info.password === "string" ? info.password : undefined }
    } catch {}
  }
  return undefined
}

export class HttpUnavailable extends Error {
  constructor() {
    super(
      "this needs OpenCode's HTTP API (the plugin API has no fork/compact yet), but the server's address is unknown. " +
        'Run OpenCode as a service, or set the plugin option "server": {"url": ..., "password": ...}.',
    )
  }
}

export async function call(option: ServerOptions | undefined, method: string, route: string, body?: unknown) {
  const server = resolveServer(option)
  if (!server) throw new HttpUnavailable()
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (server.password) headers.authorization = `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`
  const response = await fetch(new URL(route, server.url), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${route} failed: ${response.status} ${text.slice(0, 300)}`)
  if (!text) return undefined
  const json = JSON.parse(text)
  return json?.data ?? json
}

// `child` makes the copy a child of its source where supported; other servers ignore it.
export const forkSession = (server: ServerOptions | undefined, sessionID: string, before?: string) =>
  call(server, "POST", `/api/session/${encodeURIComponent(sessionID)}/fork`, { ...(before ? { before } : {}), child: true })

export const compactSession = (server: ServerOptions | undefined, sessionID: string, delivery: "steer" | "queue") =>
  call(server, "POST", `/api/session/${encodeURIComponent(sessionID)}/compact`, { delivery })
