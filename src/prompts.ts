// Model-facing text: the leader's system-prompt blurb, tool descriptions, and the worker preamble.

export const NAMESPACE = "octopi"

export const BLURB = `
## Octopi: you can lead worker sessions

You can spawn workers (full OpenCode sessions, any model) and steer them. Do not delegate unprompted:
spawn workers only when the user asks for or approves delegation; otherwise do the work yourself.
The tools are in Code Mode as \`tools.octopi.*\`, so one execute call can drive several workers
(e.g. spawn a few with Promise.all, then wait).
The loop: spawn (optionally with its first prompt) → wait (blocks until a worker's turn ends and
returns its final message) → read → send again (interrupt / steer / queue) → … → kill when done.
- A worker is a normal session; the user can open it. Its name is your handle for it.
- wait is your pacing loop: call it, act on what finished, call it again. It returns as soon as any
  worker finishes, immediately when nothing is running, and on timeout with who is still running.
- Workers are leaves by default: they have no octopi tools. Pass spawner:true only when a worker
  genuinely needs to delegate further.
- Running workers across your whole tree share a slot pool. If a prompt fails with "no free worker
  slot", do not retry in a loop: wait for a worker to finish, kill one, or tell the user.
`.trim()

export const NAMESPACE_DESCRIPTION = "Lead worker sessions: spawn, prompt/steer/interrupt/queue, wait, inspect, fork, compact, kill."

export const SPAWN = [
  "Create a worker session and optionally give it its first prompt. Returns once the worker exists (and the prompt is accepted); use wait for its result.",
  'model: "providerID/modelID" or "providerID/modelID#variant" (look it up with tools.opencode.models), or omit / "inherit" to use your own model.',
  "fork: start from an existing session's history instead of a blank one: {from: <worker name> | \"self\", before?: <messageID>}. \"self\" forks your own session, so the worker knows everything you know.",
  "spawner: true gives the worker the octopi tools so it can lead workers of its own (default false: a leaf).",
  "task: a short label for the session title (default: the start of the prompt).",
].join("\n")

export const SEND = [
  "Send a message to a worker. Returns on acceptance; use wait for the result.",
  "If the worker is idle, every mode simply prompts it. If it is busy, pick by urgency:",
  '- "interrupt" (default): STOP whatever it is doing and do this instead. Aborts the current turn (including a long-running tool call), then prompts. The only mode that is guaranteed to take effect right away; use it for any real change of plan.',
  '- "steer": a course correction that should NOT interrupt the current work. Delivered at the next step boundary, i.e. only after the tool call in flight returns (a long shell command holds it back).',
  '- "queue": runs after the current work finishes. Only when you are sure what comes next and want to line it up early.',
  "model: switch the worker's model from now on (same format as spawn).",
].join("\n")

export const WAIT = [
  "Block until a worker's turn ends; returns each newly finished worker's final message (reported once).",
  "names: which workers (default: all of yours). Returns immediately with idle:true when none of them is running and none has an unreported result: prompt or spawn instead of waiting again.",
  "timeoutSec: default from config (1800 unless configured). On timeout you get timedOut:true and the still-running list; just wait again or inspect.",
].join("\n")

export const LIST = "Your workers: state (running / idle / closed; * = unreported result), model, context use, cost, plus running slots and the whole tree's cost."

export const INSPECT = [
  "Look at a worker without waiting: state, model, context use, cost, and its last finished turn.",
  "messages: also include a compact transcript of its last N messages (or those after `since`, a message id from an earlier transcript).",
].join("\n")

export const COMPACT = "Compact a worker's context now (OpenCode's compaction, which is vcc if opencode-vcc is installed). Queued behind current work if the worker is busy."

export const KILL = "Stop a worker for good: interrupts its current turn and closes it (it accepts no more messages). The session and its history remain."

export const workerPreamble = (name: string, spawner: boolean, forkOf?: string) =>
  [
    forkOf
      ? `[octopi] You are now worker "${name}": a fork of ${forkOf}, sharing its history up to here. From now on you work for that session (your leader) on the task below; do not continue its previous work unless the task says so.`
      : `[octopi] You are worker "${name}", spawned by another agent session (your leader) to do the task below.`,
    "Work autonomously. When your turn ends, your leader reads your final message, so end with a clear, self-contained report.",
    "Your leader may steer or interrupt you with new messages mid-task.",
    ...(spawner ? ["You may lead workers of your own with the octopi tools."] : []),
  ].join(" ")
