/** @jsxImportSource @opentui/solid */
// Sidebar block for opencode-octopi: the session's workers (state, model, cost) and the tree's
// running slots and cost, pushed live from the server plugin over RPC. A worker finishing toasts.
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { Definition, type FleetSnapshot } from "./rpc.ts"

const usd = (value: number) => (value < 0.01 && value > 0 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`)
const shortModel = (model: string) => model.slice(model.indexOf("/") + 1).replace(/^claude-/, "")

export default Plugin.define({
  id: "opencode-octopi.sidebar",
  setup(context) {
    const rpc = context.client.rpc(Definition as any) as any
    const [fleets, setFleets] = createSignal<Record<string, FleetSnapshot>>({})
    const store = (snap: FleetSnapshot) => setFleets((all) => ({ ...all, [snap.leaderID]: snap }))

    const off = rpc.events.on("update", (event: { data: FleetSnapshot }) => {
      const snap = event.data
      store(snap)
      if (snap.notice) context.ui.toast.show({ variant: "info", message: `octopi: ${snap.notice}`, sessionID: snap.leaderID })
    })

    function Block(props: { sessionID: string }) {
      const theme = context.theme
      const fleet = createMemo(() => fleets()[props.sessionID])

      // Fetch once per session shown; later changes arrive as events.
      createEffect(
        on(
          () => props.sessionID,
          (sessionID) => {
            const location = context.data.session.get(sessionID)?.location
            rpc
              .fleet({ sessionID }, location ? { location } : undefined)
              .then((result: FleetSnapshot) => result && store(result))
              .catch(() => {})
          },
        ),
      )

      const color = (state: string) =>
        state === "running" ? theme.text.feedback.success.base : state === "closed" ? theme.text.muted : theme.text.base

      return (
        <Show when={fleet() && fleet()!.workers.length > 0}>
          <box>
            <text fg={theme.text.base}>
              <b>Workers</b>
            </text>
            <For each={fleet()!.workers}>
              {(w) => (
                <text fg={color(w.state)}>
                  {w.state === "running" ? "▶" : w.state === "closed" ? "✕" : w.unreported ? "●" : "○"} {w.name}{" "}
                  <span style={{ fg: theme.text.muted }}>
                    {shortModel(w.model)} {usd(w.cost)}
                    {w.contextPercent !== undefined ? ` ${w.contextPercent}%` : ""}
                  </span>
                </text>
              )}
            </For>
            <text fg={theme.text.muted}>
              {fleet()!.running}/{fleet()!.maxRunning} running · tree {usd(fleet()!.treeCost)}
            </text>
          </box>
        </Show>
      )
    }

    const release = context.ui.slot({
      append: "sidebar.content",
      render: (props) => <Block sessionID={props.sessionID} />,
    })

    return () => {
      release()
      off()
    }
  },
})
