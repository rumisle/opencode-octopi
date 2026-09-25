# TODO

## ⚠️ Caveats: things that don't work the way they should yet

These are workarounds for gaps in OpenCode v2's plugin API. Each should go away once upstream exposes the capability.

- [ ] **⚠️ On stock OpenCode, workers are top-level sessions, not children of the leader.**
  Stock OpenCode can't set `parentID` when creating a session (neither the plugin API nor the HTTP API accepts it). Octopi always asks for a child (`parentID` on create, `child: true` on fork) and falls back by what it gets back: a session without `parentID` gets the `octopi · ` title prefix. [ocelot](https://github.com/rumisle/ocelot)'s `core/child-sessions` patch supports both, so there workers are children of their leader. `CHILDREN=1 test/e2e.sh <binary>` asserts which.
  - Child sessions are not resumed by the server after a restart (only through a subagent job that owns them), so octopi resumes stopped child workers at startup and holds back results until that sweep is done.
  - Upstream: maintainer draft [#51095](https://github.com/anomalyco/opencode/pull/51095) (session subagent API) is the likely fix. Also [#47745](https://github.com/anomalyco/opencode/pull/47745) (`parentID` on create, stalled) and issue [#49389](https://github.com/anomalyco/opencode/issues/49389).
  - When it lands: nothing to change if it accepts the same `parentID` and `child` fields; otherwise adapt the two calls.
- [ ] **⚠️ Fork and compact go through OpenCode's HTTP API.**
  The plugin API has neither. The plugin calls the server over HTTP using the URL and password from `$XDG_STATE_HOME/opencode/service.json` (service mode) or the `server` plugin option. Without either, `fork` and `compact` are unavailable.
  - Upstream: [#48005](https://github.com/anomalyco/opencode/pull/48005) (plugin `session.fork`), issue [#49389](https://github.com/anomalyco/opencode/issues/49389) (plugin `session.compact`).
- [ ] **⚠️ Worker history is read straight from OpenCode's SQLite database.**
  Plugins can't read a session's full history (only the post-compaction context). Same workaround as opencode-vcc: a read-only connection to `session_message`.
  - Upstream: [#49568](https://github.com/anomalyco/opencode/pull/49568) (plugin message reads).
- [ ] **⚠️ No fleet view in the web UI.** The web UI has no plugin slots; the fleet block exists only in the TUI sidebar.
- [ ] **⚠️ Worker tool calls show as plain rows in the web UI**, without a link to the worker session (the built-in `subagent` tool gets a card with a link).

Check the upstream PRs about a week after 2026-09-25. Past record: maintainer PRs merge within ~2 days or get parked.

## Later

- [ ] `interrupt` should also cancel items the worker already had queued (needs inbox list/cancel; HTTP-only today).
- [ ] Dollar budgets per tree (cost data is already collected).
- [ ] Surface "worker is waiting for a permission answer" in `list`/`wait`.
- [ ] TUI: a command to jump to a worker's session.
