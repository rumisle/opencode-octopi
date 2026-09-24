# TODO

## ⚠️ Caveats: things that don't work the way they should yet

These are workarounds for gaps in OpenCode v2's plugin API. Each should go away once upstream exposes the capability.

- [ ] **⚠️ Workers are top-level sessions, not children of the leader.**
  Plugins can't set `parentID` when creating a session (neither the plugin API nor the HTTP API accepts it). So workers appear as ordinary sessions titled `name · task`, not grouped under the leader in the web UI or the TUI's child navigation.
  - Upstream: maintainer draft [#51095](https://github.com/anomalyco/opencode/pull/51095) (session subagent API) is the likely fix. Also [#47745](https://github.com/anomalyco/opencode/pull/47745) (`parentID` on create, stalled) and issue [#49389](https://github.com/anomalyco/opencode/issues/49389).
  - When it lands: create workers with the leader as parent; drop the title prefix.
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
