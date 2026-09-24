// The octopi server side: worker lifecycle over OpenCode's plugin session API, activity tracking
// from session events, and the model-facing tools.
import { type History, lastPromptTokens, type Row, stoppedTurn, transcript, turns, type Turn } from "./history.ts"
import { compactSession, forkSession, type ServerOptions } from "./http.ts"
import * as P from "./prompts.ts"
import { Roster, type Worker } from "./roster.ts"

export interface Options {
  /** Default `wait` timeout in seconds. */
  waitTimeoutSec?: number
  /** Max running workers per delegation tree. */
  maxRunning?: number
  /** Agent new workers run as (default: OpenCode's default agent). */
  agent?: string
  /** OpenCode server for fork/compact (default: the service registration). */
  server?: ServerOptions
  /** OpenCode database path (default: auto-detected, like opencode-vcc). */
  database?: string
}

export const DEFAULTS = { waitTimeoutSec: 1800, maxRunning: 8 }

type ModelRef = { providerID: string; id: string; variant?: string }

export class ToolError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const unwrap = <T>(value: any): T => (value && typeof value === "object" && "data" in value && !("id" in value) ? value.data : value)
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
const LEAF_PERMISSIONS = [{ action: `${P.NAMESPACE}_*`, resource: "*", effect: "deny" as const }]

export function parseModel(value: string): ModelRef {
  const [path, variant] = value.split("#", 2)
  const slash = path!.indexOf("/")
  if (slash <= 0 || slash === path!.length - 1)
    throw new ToolError(`Invalid model "${value}". Use "providerID/modelID" or "providerID/modelID#variant".`)
  return { providerID: path!.slice(0, slash), id: path!.slice(slash + 1), ...(variant ? { variant } : {}) }
}

export const formatModel = (model?: ModelRef) =>
  model ? `${model.providerID}/${model.id}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""}` : "-"

function assertKeys(tool: string, input: unknown, allowed: string[]) {
  if (!input || typeof input !== "object") return
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key))
  if (unknown.length)
    throw new ToolError(`${tool}: unknown parameter(s): ${unknown.join(", ")}. Valid: ${allowed.join(", ") || "(none)"}.`)
}

/** Which sessions are running, from session execution events (plus a probe for unknown ones). */
export class Activity {
  private busy = new Map<string, boolean>()
  private listeners = new Set<(sessionID: string, outcome: string) => void>()

  constructor(private waitIdle: (sessionID: string) => Promise<unknown>) {}

  onEvent(event: any) {
    const sessionID: string | undefined = event?.data?.sessionID
    if (!sessionID) return
    switch (event.type) {
      case "session.execution.started":
        this.busy.set(sessionID, true)
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        this.busy.set(sessionID, false)
        const outcome = event.type.slice("session.execution.".length)
        for (const listener of this.listeners) listener(sessionID, outcome)
        return
      }
      case "session.deleted":
        this.busy.delete(sessionID)
        for (const listener of this.listeners) listener(sessionID, "deleted")
        return
    }
  }

  /** Mark a session busy before its execution-started event arrives (a prompt was just accepted). */
  mark(sessionID: string) {
    this.busy.set(sessionID, true)
  }

  /** Forget a mark whose prompt failed; the next query probes again. */
  unmark(sessionID: string) {
    this.busy.delete(sessionID)
  }

  known(sessionID: string) {
    return this.busy.get(sessionID)
  }

  async isBusy(sessionID: string): Promise<boolean> {
    const known = this.busy.get(sessionID)
    if (known !== undefined) return known
    // Unknown since this server started: `wait` resolves at once for an idle session.
    const busy = await Promise.race([
      this.waitIdle(sessionID).then(
        () => false,
        () => false,
      ),
      sleep(200).then(() => true),
    ])
    if (!this.busy.has(sessionID)) this.busy.set(sessionID, busy)
    return this.busy.get(sessionID)!
  }

  /** Resolves on the next settle of any of `sessionIDs`, or when `signal` aborts. */
  nextSettle(sessionIDs: Set<string>, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.listeners.delete(listener)
        signal.removeEventListener("abort", done)
        resolve()
      }
      const listener = (sessionID: string) => {
        if (sessionIDs.has(sessionID)) done()
      }
      this.listeners.add(listener)
      signal.addEventListener("abort", done, { once: true })
    })
  }

  subscribe(listener: (sessionID: string, outcome: string) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export interface Completion {
  name: string
  outcome: Turn["outcome"]
  text: string
  /** Replies to earlier inputs handled in the same turn (steered or queued messages), oldest first. */
  earlierReplies?: string[]
  error?: string
  completionID: string
  durationSec: number
  runCost: number
  /** Turns that finished since the last report, when more than one (only the latest is shown). */
  finishedTurns?: number
  compaction?: boolean
}

export interface FleetRow {
  name: string
  sessionID: string
  state: "running" | "idle" | "closed"
  unreported: boolean
  model: string
  contextTokens?: number
  contextPercent?: number
  cost: number
  spawner: boolean
}

export interface Fleet {
  leaderID: string
  workers: FleetRow[]
  running: number
  maxRunning: number
  treeCost: number
  /** Whole tree: every worker below this leader's root, any depth. */
  treeWorkers: number
}

const TEXT_LIMIT = 8000
const clip = (text: string, max = TEXT_LIMIT) => (text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars; use inspect]` : text)

export class Octopi {
  readonly roster: Roster
  readonly activity: Activity
  private readonly options: Required<Pick<Options, "waitTimeoutSec" | "maxRunning">> & Options
  private modelCache?: { at: number; models: any[] }
  /** Called whenever a leader's fleet may have changed (for the TUI). */
  onChange: (leaderID: string, notice?: string) => void = () => {}

  constructor(
    private ctx: any,
    private history: History,
    options: Options = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
    this.roster = new Roster(ctx.storage)
    this.activity = new Activity((sessionID) => ctx.session.wait({ sessionID }))
    this.activity.subscribe((sessionID, outcome) => {
      const worker = this.roster.worker(sessionID)
      if (!worker) return
      if (outcome === "deleted" && !worker.closedAt) void this.roster.update(worker.leaderID, worker.name, (w) => (w.closedAt = Date.now()))
      const notice = outcome === "deleted" ? undefined : `${worker.name} finished (${outcome})`
      this.onChange(worker.leaderID, notice)
    })
  }

  private stepTimers = new Map<string, ReturnType<typeof setTimeout>>()

  onEvent(event: any) {
    this.activity.onEvent(event)
    const worker = event?.data?.sessionID ? this.roster.worker(event.data.sessionID) : undefined
    if (!worker) return
    if (event.type === "session.execution.started") this.onChange(worker.leaderID)
    // Cost and context change with every step; refresh the fleet view at most every 2s.
    if (event.type === "session.step.ended" && !this.stepTimers.has(worker.leaderID))
      this.stepTimers.set(
        worker.leaderID,
        setTimeout(() => {
          this.stepTimers.delete(worker.leaderID)
          this.onChange(worker.leaderID)
        }, 2000),
      )
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async models(): Promise<any[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 60_000) return this.modelCache.models
    const models = unwrap<any[]>(await this.ctx.model.list()) ?? []
    this.modelCache = { at: Date.now(), models }
    return models
  }

  private async resolveModel(value: string | undefined, leaderID: string): Promise<ModelRef | undefined> {
    if (value === undefined || value === "" || value === "inherit") {
      const leader = await this.ctx.session.get({ sessionID: leaderID })
      return leader?.model
    }
    const ref = parseModel(value)
    const model = (await this.models()).find((m) => m.providerID === ref.providerID && m.id === ref.id)
    if (!model)
      throw new ToolError(`Model "${ref.providerID}/${ref.id}" is not available. Look it up with tools.opencode.models.`)
    if (ref.variant && !(model.variants ?? []).some((v: any) => v.id === ref.variant))
      throw new ToolError(
        `Variant "${ref.variant}" is not available for ${ref.providerID}/${ref.id}. Available: ${(model.variants ?? []).map((v: any) => v.id).join(", ") || "none"}.`,
      )
    return ref
  }

  private worker(leaderID: string, name: unknown): Worker {
    if (typeof name !== "string" || !name) throw new ToolError("name is required")
    const worker = this.roster.get(leaderID, name)
    if (!worker) {
      const known = this.roster.workers(leaderID).map((w) => w.name)
      throw new ToolError(`No worker named "${name}". Yours: ${known.join(", ") || "(none)"}.`)
    }
    return worker
  }

  private open(leaderID: string, name: unknown): Worker {
    const worker = this.worker(leaderID, name)
    if (worker.closedAt) throw new ToolError(`Worker "${worker.name}" was killed and accepts no more messages.`)
    return worker
  }

  /** Running workers in the tree `sessionID` belongs to. */
  async running(sessionID: string) {
    const all = this.roster.descendants(this.roster.root(sessionID))
    const busy = await Promise.all(all.map((w) => this.activity.isBusy(w.sessionID)))
    return all.filter((_, i) => busy[i])
  }

  private slotLock: Promise<unknown> = Promise.resolve()
  /** Slots promised to workers being spawned, per tree root. */
  private reserved = new Map<string, number>()

  /**
   * Take a running slot in `leaderID`'s tree: for an existing worker (marks it busy), or a
   * reservation for one about to be spawned (returns a release function). Serialized, so
   * concurrent spawns cannot overshoot the cap.
   */
  private claimSlot(leaderID: string, worker?: Worker): Promise<() => void> {
    const next = this.slotLock.then(async () => {
      const root = this.roster.root(leaderID)
      const running = await this.running(leaderID)
      if (worker && running.some((w) => w.sessionID === worker.sessionID)) return () => {}
      const reserved = this.reserved.get(root) ?? 0
      if (running.length + reserved >= this.options.maxRunning)
        throw new ToolError(
          `no free worker slot: ${running.length + reserved} workers are running in this tree (max ${this.options.maxRunning}` +
            `${running.length ? `: ${running.map((w) => w.name).join(", ")}` : ""}). ` +
            "Do not retry in a loop: wait for one to finish, kill one, or tell the user.",
        )
      if (worker) {
        this.activity.mark(worker.sessionID)
        return () => {}
      }
      this.reserved.set(root, reserved + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        this.reserved.set(root, Math.max(0, (this.reserved.get(root) ?? 1) - 1))
      }
    })
    this.slotLock = next.catch(() => {})
    return next
  }

  private async prompt(worker: Worker, text: string, delivery: "steer" | "queue") {
    try {
      await this.ctx.session.prompt({ sessionID: worker.sessionID, text, delivery })
    } catch (error) {
      this.activity.unmark(worker.sessionID)
      throw error
    }
  }

  private withPreamble(worker: Worker, message: string) {
    const forkOf =
      worker.forkedFrom === undefined
        ? undefined
        : worker.forkedFrom === worker.leaderID
          ? "your leader"
          : `worker "${this.roster.owner(worker.forkedFrom)?.name ?? worker.forkedFrom}"`
    return `${P.workerPreamble(worker.name, worker.spawner, forkOf)}\n\n${message}`
  }

  /** Finished turns, plus a turn that stopped without finishing when the session is not running. */
  private results(rows: Row[], busy: boolean): Turn[] {
    const done = turns(rows)
    const stopped = busy ? undefined : stoppedTurn(rows)
    return stopped ? [...done, stopped] : done
  }

  private latestTurn(sessionID: string) {
    return this.results(this.history.rows(sessionID), false).at(-1)
  }

  /** Newly finished turns of `worker` since the last report, if it is idle now. */
  private async completion(worker: Worker): Promise<Completion | undefined> {
    if (await this.activity.isBusy(worker.sessionID)) return undefined
    const all = this.results(this.history.rows(worker.sessionID), false)
    const last = all.at(-1)
    if (!last || last.id === worker.consumed) return undefined
    const consumedIndex = worker.consumed ? all.findIndex((t) => t.id === worker.consumed) : -1
    const finished = all.length - 1 - consumedIndex
    return {
      name: worker.name,
      outcome: last.outcome,
      text: clip(last.text || (last.compaction ? "(context compacted)" : "(no text in its final message)")),
      ...(last.earlier.length ? { earlierReplies: last.earlier.map((t) => clip(t, 2000)) } : {}),
      ...(last.error ? { error: last.error } : {}),
      completionID: last.id,
      durationSec: Math.round((last.ended - last.started) / 1000),
      runCost: Math.round(last.cost * 10000) / 10000,
      ...(finished > 1 ? { finishedTurns: finished } : {}),
      ...(last.compaction ? { compaction: true } : {}),
    }
  }

  private async fleetRow(worker: Worker): Promise<FleetRow> {
    const [info, busy] = await Promise.all([
      this.ctx.session.get({ sessionID: worker.sessionID }).catch(() => undefined),
      this.activity.isBusy(worker.sessionID),
    ])
    const rows = this.history.rows(worker.sessionID)
    const last = this.results(rows, busy).at(-1)
    const contextTokens = lastPromptTokens(rows)
    const model = info?.model as ModelRef | undefined
    const limit = model ? (await this.models()).find((m) => m.providerID === model.providerID && m.id === model.id)?.limit?.context : undefined
    return {
      name: worker.name,
      sessionID: worker.sessionID,
      state: worker.closedAt ? "closed" : busy ? "running" : "idle",
      unreported: !busy && !!last && last.id !== worker.consumed,
      model: formatModel(model),
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(contextTokens !== undefined && limit ? { contextPercent: Math.round((100 * contextTokens) / limit) } : {}),
      cost: Math.round((info?.cost ?? 0) * 10000) / 10000,
      spawner: worker.spawner,
    }
  }

  async fleet(leaderID: string): Promise<Fleet> {
    await this.roster.ready()
    const workers = await Promise.all(this.roster.workers(leaderID).map((w) => this.fleetRow(w)))
    const root = this.roster.root(leaderID)
    const tree = this.roster.descendants(root)
    const costs = await Promise.all(
      tree.map((w) => this.ctx.session.get({ sessionID: w.sessionID }).then((i: any) => i?.cost ?? 0, () => 0)),
    )
    return {
      leaderID,
      workers,
      running: (await this.running(leaderID)).length,
      maxRunning: this.options.maxRunning,
      treeCost: Math.round(costs.reduce((a: number, b: number) => a + b, 0) * 10000) / 10000,
      treeWorkers: tree.length,
    }
  }

  // ── tools ──────────────────────────────────────────────────────────────────

  async spawn(leaderID: string, input: any) {
    assertKeys("spawn", input, ["name", "prompt", "model", "fork", "spawner", "task", "agent", "directory"])
    await this.roster.ready()
    const name = input?.name
    if (typeof name !== "string" || !NAME.test(name))
      throw new ToolError('name is required: 1-40 characters of letters, digits, "_", "-", "." (starting with a letter or digit)')
    if (this.roster.get(leaderID, name)) throw new ToolError(`You already have a worker named "${name}". Names are never reused.`)
    const spawner = input.spawner === true
    const model = await this.resolveModel(input.model, leaderID)
    const leader = await this.ctx.session.get({ sessionID: leaderID })
    const task = String(input.task ?? input.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "worker"
    const title = `octopi · ${name} · ${task}`
    const permissions = spawner ? [] : LEAF_PERMISSIONS
    const prompt = typeof input.prompt === "string" && input.prompt.trim() ? input.prompt : undefined
    // Reserve a slot before creating anything, so a full tree refuses cleanly.
    const release = prompt ? await this.claimSlot(leaderID) : () => {}
    try {
      return await this.create(leaderID, input, { name, spawner, model, leader, task, title, permissions, prompt })
    } finally {
      release()
    }
  }

  private async create(
    leaderID: string,
    input: any,
    o: { name: string; spawner: boolean; model?: ModelRef; leader: any; task: string; title: string; permissions: any[]; prompt?: string },
  ) {
    const { name, spawner, model, leader, task, title, permissions, prompt } = o
    let session: any
    let forkedFrom: string | undefined
    let consumed: string | undefined
    if (input.fork) {
      assertKeys("spawn.fork", input.fork, ["from", "before"])
      const from = input.fork.from
      const source = from === "self" || from === undefined ? leaderID : this.worker(leaderID, from).sessionID
      session = await forkSession(this.options.server, source, input.fork.before)
      if (!session?.id) throw new ToolError("fork returned no session")
      await this.ctx.session.update({ sessionID: session.id, title, permissions })
      if (input.model !== undefined && model) await this.ctx.session.switchModel({ sessionID: session.id, model })
      forkedFrom = source
      // The copied history's finished turns are not this worker's results.
      consumed = this.latestTurn(session.id)?.id
    } else {
      session = await this.ctx.session.create({
        title,
        ...(typeof (input.agent ?? this.options.agent) === "string" ? { agent: input.agent ?? this.options.agent } : {}),
        ...(model ? { model } : {}),
        metadata: { octopi: { leaderID, name } },
        permissions,
        location: input.directory ? { directory: String(input.directory) } : leader?.location,
      })
    }

    const worker: Worker = {
      name,
      sessionID: session.id,
      leaderID,
      spawner,
      createdAt: Date.now(),
      task,
      ...(forkedFrom ? { forkedFrom } : {}),
      ...(consumed ? { consumed } : {}),
    }
    await this.roster.add(worker)
    this.onChange(leaderID)

    let prompted = false
    if (prompt) {
      this.activity.mark(worker.sessionID)
      const text = this.withPreamble(worker, prompt)
      await this.prompt(worker, text, "steer")
      prompted = true
      await this.roster.update(leaderID, name, (w) => (w.preambled = true))
      this.onChange(leaderID)
    }
    return {
      name,
      sessionID: session.id,
      model: formatModel(model ?? session.model),
      spawner,
      ...(forkedFrom ? { forkedFrom: forkedFrom === leaderID ? "self" : input.fork.from } : {}),
      prompted,
      ...(prompted ? { next: "wait for its result" } : { next: "send it a prompt" }),
    }
  }

  async send(leaderID: string, input: any) {
    assertKeys("send", input, ["name", "message", "mode", "model"])
    await this.roster.ready()
    const worker = this.open(leaderID, input?.name)
    const message = input?.message
    if (typeof message !== "string" || !message.trim()) throw new ToolError("message is required")
    const mode = input.mode ?? "interrupt"
    if (!["interrupt", "steer", "queue"].includes(mode)) throw new ToolError('mode must be "interrupt", "steer" or "queue"')
    if (input.model !== undefined) {
      const model = await this.resolveModel(input.model, leaderID)
      if (model) await this.ctx.session.switchModel({ sessionID: worker.sessionID, model })
    }
    // The first message a worker gets carries the preamble.
    const text = worker.preambled ? message : this.withPreamble(worker, message)
    const preambled = async () => {
      if (!worker.preambled) await this.roster.update(leaderID, worker.name, (w) => (w.preambled = true))
    }

    const busy = await this.activity.isBusy(worker.sessionID)
    if (!busy) {
      await this.claimSlot(leaderID, worker)
      await this.prompt(worker, text, "steer")
      await preambled()
      this.onChange(leaderID)
      return { name: worker.name, delivered: "prompt", note: "the worker was idle, so it just started on this" }
    }
    if (mode === "interrupt") {
      await this.ctx.session.interrupt({ sessionID: worker.sessionID, resume: false })
      await this.ctx.session.wait({ sessionID: worker.sessionID })
      // The aborted turn is superseded, not a result to report.
      const aborted = this.latestTurn(worker.sessionID)
      if (aborted) await this.roster.update(leaderID, worker.name, (w) => (w.consumed = aborted.id))
      this.activity.mark(worker.sessionID)
      await this.prompt(worker, text, "steer")
      await preambled()
      this.onChange(leaderID)
      return { name: worker.name, delivered: "interrupt", note: "stopped its current turn and started on this" }
    }
    await this.prompt(worker, text, mode)
    await preambled()
    return {
      name: worker.name,
      delivered: mode,
      note:
        mode === "steer"
          ? "delivered at its next step boundary (after the tool call in flight returns)"
          : "queued; runs after its current work finishes",
    }
  }

  async wait(leaderID: string, input: any, signal: AbortSignal) {
    assertKeys("wait", input, ["names", "name", "timeoutSec"])
    await this.roster.ready()
    const names: string[] | undefined =
      typeof input?.name === "string" ? [input.name] : Array.isArray(input?.names) ? input.names : undefined
    const targets = names ? names.map((name) => this.worker(leaderID, name)) : this.roster.workers(leaderID).filter((w) => !w.closedAt)
    const timeoutSec = typeof input?.timeoutSec === "number" && input.timeoutSec > 0 ? input.timeoutSec : this.options.waitTimeoutSec
    const deadline = Date.now() + timeoutSec * 1000
    const ids = new Set(targets.map((w) => w.sessionID))

    for (let settledWithoutTurn = 0; ; ) {
      const found = (await Promise.all(targets.map((w) => this.completion(w)))).filter((c): c is Completion => !!c)
      const stillRunning = (await Promise.all(targets.map(async (w) => ((await this.activity.isBusy(w.sessionID)) ? w.name : undefined)))).filter(
        (n): n is string => !!n,
      )
      if (found.length) {
        for (const completion of found)
          await this.roster.update(leaderID, completion.name, (w) => (w.consumed = completion.completionID))
        this.onChange(leaderID)
        return { finished: found, stillRunning }
      }
      if (stillRunning.length === 0) {
        // A settle event can arrive a moment before its end-of-turn marker is readable.
        if (settledWithoutTurn > 0 && settledWithoutTurn < 10) {
          settledWithoutTurn++
          await sleep(100)
          continue
        }
        return {
          idle: true,
          finished: [],
          stillRunning: [],
          note: targets.length ? "None of these workers is running and none has an unreported result. Prompt or spawn one instead of waiting." : "You have no workers.",
        }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { timedOut: true, finished: [], stillRunning }
      if (signal.aborted) return { aborted: true, finished: [], stillRunning }
      const timer = new AbortController()
      const onAbort = () => timer.abort()
      signal.addEventListener("abort", onAbort, { once: true })
      const timeout = setTimeout(() => timer.abort(), remaining)
      await this.activity.nextSettle(ids, timer.signal)
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
      settledWithoutTurn = 1
    }
  }

  async list(leaderID: string, input: any) {
    assertKeys("list", input, [])
    const fleet = await this.fleet(leaderID)
    return {
      workers: fleet.workers.map((w) => ({
        name: w.name,
        state: w.unreported ? `${w.state}*` : w.state,
        model: w.model,
        context: w.contextTokens === undefined ? "-" : `${Math.round(w.contextTokens / 1000)}k${w.contextPercent !== undefined ? ` (${w.contextPercent}%)` : ""}`,
        cost: w.cost,
        ...(w.spawner ? { spawner: true } : {}),
        sessionID: w.sessionID,
      })),
      running: `${fleet.running}/${fleet.maxRunning} slots in use (whole tree)`,
      treeCost: fleet.treeCost,
    }
  }

  async inspect(leaderID: string, input: any) {
    assertKeys("inspect", input, ["name", "messages", "since"])
    await this.roster.ready()
    const worker = this.worker(leaderID, input?.name)
    const row = await this.fleetRow(worker)
    const rows = this.history.rows(worker.sessionID)
    const last = this.results(rows, row.state === "running").at(-1)
    const limit = typeof input?.messages === "number" ? Math.max(0, Math.min(200, input.messages)) : input?.since ? 50 : 0
    return {
      name: worker.name,
      sessionID: worker.sessionID,
      state: row.state,
      model: row.model,
      ...(row.contextTokens !== undefined ? { contextTokens: row.contextTokens } : {}),
      ...(row.contextPercent !== undefined ? { contextPercent: row.contextPercent } : {}),
      cost: row.cost,
      lastTurn: last
        ? { completionID: last.id, outcome: last.outcome, text: clip(last.text, 4000), ...(last.error ? { error: last.error } : {}), reported: last.id === worker.consumed }
        : null,
      ...(limit > 0 ? { transcript: transcript(rows, { limit, since: input?.since }) } : {}),
    }
  }

  async compact(leaderID: string, input: any) {
    assertKeys("compact", input, ["name"])
    await this.roster.ready()
    const worker = this.open(leaderID, input?.name)
    const busy = await this.activity.isBusy(worker.sessionID)
    if (!busy) await this.claimSlot(leaderID, worker)
    await compactSession(this.options.server, worker.sessionID, busy ? "queue" : "steer")
    this.onChange(leaderID)
    return { name: worker.name, compaction: busy ? "queued behind its current work" : "started", next: "wait for it to finish" }
  }

  async kill(leaderID: string, input: any) {
    assertKeys("kill", input, ["name"])
    await this.roster.ready()
    const worker = this.worker(leaderID, input?.name)
    if (worker.closedAt) return { name: worker.name, closed: true, note: "already killed" }
    const wasRunning = await this.activity.isBusy(worker.sessionID)
    await this.roster.update(leaderID, worker.name, (w) => (w.closedAt = Date.now()))
    if (wasRunning) {
      await this.ctx.session.interrupt({ sessionID: worker.sessionID, resume: false })
      await this.ctx.session.wait({ sessionID: worker.sessionID })
    }
    const last = this.latestTurn(worker.sessionID)
    if (last) await this.roster.update(leaderID, worker.name, (w) => (w.consumed = last.id))
    this.onChange(leaderID)
    return { name: worker.name, closed: true, wasRunning }
  }

  /** Whether this session gets the octopi tools and blurb (everything except leaf workers). */
  isLeader(sessionID: string) {
    const worker = this.roster.worker(sessionID)
    return !worker || worker.spawner
  }
}
