// Shared RPC contract between the server plugin (index.ts) and the TUI sidebar (tui.tsx).
export const RPC_ID = "opencode-octopi"

export interface FleetSnapshot {
  leaderID: string
  workers: {
    name: string
    sessionID: string
    state: "running" | "idle" | "closed"
    unreported: boolean
    model: string
    contextTokens?: number
    contextPercent?: number
    cost: number
    spawner: boolean
  }[]
  running: number
  maxRunning: number
  treeCost: number
  treeWorkers: number
  /** Set on the update that carries a worker finishing. */
  notice?: string
}

const snapshotSchema = { type: "object", additionalProperties: true } as const

export const Definition = {
  id: RPC_ID,
  methods: {
    fleet: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: snapshotSchema,
    },
  },
  events: {
    update: { schema: snapshotSchema },
  },
} as const
