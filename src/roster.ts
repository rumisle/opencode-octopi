// The roster: which workers each leader owns, kept in OpenCode's per-plugin key-value storage.
//
//   leader/<leaderID>  → { workers: { [name]: Worker } }
//   worker/<sessionID> → { leaderID, name }            (reverse index: who owns a session)
//
// Everything else (state, cost, history) is read live from OpenCode, so the roster only holds what
// OpenCode can't: names, ownership, the spawner flag, and which completion `wait` returned last.

export interface Worker {
  name: string
  sessionID: string
  leaderID: string
  spawner: boolean
  createdAt: number
  /** Short task label shown in the session title. */
  task?: string
  /** Set by kill: the worker takes no more input. */
  closedAt?: number
  /** Id of the last completion (`idle` marker) that `wait` returned. */
  consumed?: string
  /** The worker preamble has been sent. */
  preambled?: boolean
  /** Set when the worker was created by forking another session. */
  forkedFrom?: string
}

interface LeaderRecord {
  workers: Record<string, Worker>
}

export interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: any): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: { key: string; value: unknown }[]
    next?: string
  }>
}

export class Roster {
  private leaders = new Map<string, LeaderRecord>()
  private owners = new Map<string, { leaderID: string; name: string }>()
  private writes = Promise.resolve()
  private loaded: Promise<void>

  constructor(private storage: Storage) {
    this.loaded = this.load()
  }

  private async load() {
    let after: string | undefined
    for (;;) {
      const page = await this.storage.scan({ prefix: "leader/", ...(after ? { after } : {}), limit: 500 })
      for (const entry of page.entries) {
        const record = entry.value as LeaderRecord | undefined
        if (!record?.workers) continue
        const leaderID = entry.key.slice("leader/".length)
        this.leaders.set(leaderID, record)
        for (const worker of Object.values(record.workers))
          this.owners.set(worker.sessionID, { leaderID, name: worker.name })
      }
      if (!page.next) break
      after = page.next
    }
  }

  ready() {
    return this.loaded
  }

  private persist(leaderID: string) {
    const record = this.leaders.get(leaderID)
    if (!record) return this.writes
    const snapshot = structuredClone(record)
    this.writes = this.writes.then(() => this.storage.set(`leader/${leaderID}`, snapshot as any)).catch(() => {})
    return this.writes
  }

  workers(leaderID: string): Worker[] {
    return Object.values(this.leaders.get(leaderID)?.workers ?? {}).sort((a, b) => a.createdAt - b.createdAt)
  }

  get(leaderID: string, name: string): Worker | undefined {
    return this.leaders.get(leaderID)?.workers[name]
  }

  /** The owner of a worker session, if it is one. */
  owner(sessionID: string) {
    return this.owners.get(sessionID)
  }

  worker(sessionID: string): Worker | undefined {
    const owner = this.owners.get(sessionID)
    return owner ? this.get(owner.leaderID, owner.name) : undefined
  }

  /** The top of the delegation tree a session belongs to. */
  root(sessionID: string): string {
    let current = sessionID
    for (let depth = 0; depth < 100; depth++) {
      const owner = this.owners.get(current)
      if (!owner) return current
      current = owner.leaderID
    }
    return current
  }

  /** Every worker session under `leaderID`, at any depth. */
  descendants(leaderID: string): Worker[] {
    const out: Worker[] = []
    const stack = [leaderID]
    const seen = new Set<string>()
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      for (const worker of this.workers(id)) {
        out.push(worker)
        stack.push(worker.sessionID)
      }
    }
    return out
  }

  async add(worker: Worker) {
    const record = this.leaders.get(worker.leaderID) ?? { workers: {} }
    record.workers[worker.name] = worker
    this.leaders.set(worker.leaderID, record)
    this.owners.set(worker.sessionID, { leaderID: worker.leaderID, name: worker.name })
    await this.persist(worker.leaderID)
  }

  async update(leaderID: string, name: string, change: (worker: Worker) => void) {
    const worker = this.get(leaderID, name)
    if (!worker) return
    change(worker)
    await this.persist(leaderID)
  }
}
