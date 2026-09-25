# opencode-octopi

An OpenCode v2 plugin that lets an agent session lead **worker sessions** it can spawn on any model, prompt, steer, interrupt, queue, fork, compact, wait on, and kill.

> ⚠️ **Read [TODO.md](TODO.md) first.** Stock OpenCode can't create child sessions yet, so there workers are top-level sessions titled `octopi · name · task`; on [ocelot](https://github.com/rumisle/ocelot) they are children of their leader. Fork and compact use OpenCode's HTTP API, and worker history is read from its SQLite database. Each workaround goes away when upstream exposes the capability.

## Why not OpenCode's `subagent` tool

| | `subagent` (built in) | octopi |
|---|---|---|
| Results | pushed into the parent as injected messages | pulled with `wait` (reported once) |
| Busy worker | steer only | interrupt (default), steer, or queue |
| Model | per call | per worker, switchable any time |
| Fork an existing session (or yourself) | no | yes |
| Compact / inspect a worker | no | yes |
| Nesting | depth limit (default 1) | leaf by default, `spawner: true` to delegate |
| Runaway control | none | running-slot cap per delegation tree |
| Cost | per session | per worker and per tree |
| Code Mode | excluded | `tools.octopi.*`, composable (`Promise.all`, loops) |

## Install

```jsonc
// opencode.jsonc
{
  "plugins": [
    { "package": "github:rumisle/opencode-octopi", "options": { "waitTimeoutSec": 1800, "maxRunning": 8 } }
  ]
}
```

| Option | Default | |
|---|---|---|
| `waitTimeoutSec` | `1800` | Default `wait` timeout. Cheap to keep long: a blocked leader makes no model calls, and a cache warmer (e.g. opencode-cache-warmer in `idle` mode) keeps its prompt cache warm meanwhile. |
| `maxRunning` | `8` | Max running workers per delegation tree (idle workers don't count). |
| `agent` | OpenCode's default | Agent new workers run as. |
| `server` | from the service registration | `{ "url", "password" }` of the OpenCode server, for fork/compact. Needed only when OpenCode doesn't run as a service. |
| `database` | auto-detected | Path to OpenCode's SQLite database. |

The TUI shows a **Workers** block in the sidebar (state, model, cost, context; running slots and tree cost) and toasts when a worker finishes. It loads automatically from the installed package.

## Tools

All in Code Mode as `tools.octopi.*` (permission names `octopi_*`).

| Tool | |
|---|---|
| `spawn({name, prompt?, model?, fork?, spawner?, task?, agent?, directory?})` | Create a worker, optionally with its first prompt. `model`: `"provider/model[#variant]"` (look it up with `tools.opencode.models`) or `"inherit"`. `fork: {from: name \| "self", before?}` starts from an existing session's history. |
| `send({name, message, mode?, model?})` | Idle worker: prompts it. Busy worker: `"interrupt"` (default) stops the current turn, including a long tool call, and does this instead; `"steer"` lands at the next step boundary without interrupting; `"queue"` runs after the current work. |
| `wait({names?, timeoutSec?})` | Blocks until a worker's turn ends; returns its final message (plus replies to earlier steered/queued inputs), reported once. Returns `idle: true` at once if nothing is running. |
| `list()` | Workers with state (`*` = unreported result), model, context, cost; running slots and tree cost. |
| `inspect({name, messages?, since?})` | State, last turn, optional transcript. |
| `compact({name})` | Compact a worker's context (vcc if opencode-vcc is installed). |
| `kill({name})` | Interrupt and close; the session stays. |

Workers are leaves by default: a session permission denies `octopi_*`, which removes the tools entirely, and they don't get the octopi system-prompt blurb. Leaders (every other session) do.

Restarts: the roster lives in OpenCode's plugin storage. A service-mode OpenCode resumes top-level sessions a restart interrupted, but not child sessions, so octopi resumes child workers itself at startup (with a note that the server restarted). `wait` reports them when they finish; a turn that stopped without being resumed is reported as `interrupted`.

## Development

```sh
bun test ./test/unit.test.ts   # pure logic
test/e2e.sh                    # real `opencode serve --service` + fake Anthropic API, ~25s
bun scripts/build-tui.ts       # after editing tui.tsx (installed plugins need precompiled tui.js)
```

`test/harness.sh start` leaves the e2e server running for manual poking (`. /tmp/octopi-e2e/env.sh`, then `lead <title> '<js>'`).
