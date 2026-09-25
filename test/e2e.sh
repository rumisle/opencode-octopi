#!/usr/bin/env bash
# End-to-end: a real `opencode serve --service` with this plugin, against test/fake-anthropic.ts.
# Leaders are driven by scripted Code Mode programs; each check asserts on the program's result.
#   test/e2e.sh [opencode binary]   (default: opencode2)
# PLUGIN=github:rumisle/opencode-octopi#<commit> tests an install instead of this checkout.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export SERVICE=1 MAX_RUNNING=3
"$ROOT/test/harness.sh" start "${1:-opencode2}" >/dev/null || exit 1
. /tmp/octopi-e2e/env.sh
trap '"$ROOT/test/harness.sh" stop' EXIT

PASS=0
FAIL=0
# result <output of lead/lead_in>: the JSON after "RESULT: "
result() { sed -n '/^RESULT: /,$p' <<<"$1" | sed '1s/^RESULT: //'; }
# check <label> <json> <jq boolean expression>
check() {
  if jq -e "$3" <<<"$2" >/dev/null 2>&1; then
    PASS=$((PASS + 1)); echo "ok   $1"
  else
    FAIL=$((FAIL + 1)); echo "FAIL $1"; echo "     expected: $3"; echo "$2" | head -30 | sed 's/^/     /'
  fi
}
leader() { head -1 <<<"$1" | cut -d' ' -f2; }

echo "== spawn + wait"
out=$(lead basic 'const s = await tools.octopi.spawn({name: "a", prompt: "SLEEP 1 REPLY hello"}); const w = await tools.octopi.wait({}); return {s, w}')
check "spawn prompts the worker" "$(result "$out")" '.s.prompted == true and .s.name == "a"'
check "wait returns its final message" "$(result "$out")" '.w.finished[0].text == "hello" and .w.finished[0].outcome == "succeeded"'
L=$(leader "$out")
# Workers are child sessions of their leader where the server supports it (ocelot), else prefixed top-level sessions.
# CHILDREN=1 or 0 asserts which; unset, the run only checks the two are consistent.
WA=$(result "$out" | jq -r '.s.sessionID')
info=$(A get "/api/session/$WA" | jq --arg l "$L" '.data // . | {child: (.parentID == $l), top: (.parentID == null), title}')
echo "     worker session: $(jq -c . <<<"$info")"
check "a worker is a child of its leader, or a prefixed top-level session" "$info" '(.child and .title == "a · SLEEP 1 REPLY hello") or (.top and .title == "octopi · a · SLEEP 1 REPLY hello")'
[ -n "${CHILDREN:-}" ] && check "workers are child sessions: $CHILDREN" "$info" "(.child | if . then 1 else 0 end) == $CHILDREN"
# The Code Mode rows name the workers each call drove (metadata.sessionIDs, forwarded by ocelot's
# core/codemode-child-sessions); the web app shows a card per worker from them. CARDS=1 asserts it.
rows=$(A get "/api/session/$L/message?limit=20&order=desc&type=assistant" | jq '[.data[].content[] | select(.type=="tool" and .name=="execute") | .state.metadata.toolCalls[]? | {tool, ids: (.sessionIDs // [])}]')
echo "     execute rows: $(jq -c . <<<"$rows")"
[ -n "${CARDS:-}" ] && check "spawn and wait rows carry the worker's session" "$rows" "map(select(.tool == \"octopi.spawn\" or .tool == \"octopi.wait\") | .ids == [\"$WA\"]) | length == 2 and all"
out=$(lead_in $L 'return await tools.octopi.wait({})')
check "a reported result is not reported again; wait is idle" "$(result "$out")" '.idle == true'

echo "== send modes"
out=$(lead_in $L 'return await tools.octopi.spawn({name: "st", prompt: "SLEEP 4 REPLY first"})'); sleep 1.5
out=$(lead_in $L 'const s = await tools.octopi.send({name: "st", message: "REPLY steered", mode: "steer"}); const w = await tools.octopi.wait({names: ["st"]}); return {s, w}')
check "steer lands after the tool call in flight" "$(result "$out")" '.s.delivered == "steer" and .w.finished[0].text == "steered" and .w.finished[0].durationSec >= 3'
out=$(lead_in $L 'return await tools.octopi.spawn({name: "in", prompt: "SLEEP 60 REPLY never"})'); sleep 1.5
T0=$(date +%s)
out=$(lead_in $L 'const s = await tools.octopi.send({name: "in", message: "REPLY interrupted"}); const w = await tools.octopi.wait({names: ["in"]}); return {s, w}')
check "interrupt (default) stops a long tool call at once" "$(result "$out")" '.s.delivered == "interrupt" and .w.finished[0].text == "interrupted"'
check "interrupt took seconds, not the 60s sleep" "{\"t\": $(( $(date +%s) - T0 ))}" '.t < 30'
out=$(lead_in $L 'return await tools.octopi.spawn({name: "q", prompt: "SLEEP 3 REPLY one"})'); sleep 1
out=$(lead_in $L 'const s = await tools.octopi.send({name: "q", message: "REPLY two", mode: "queue"}); const w = await tools.octopi.wait({names: ["q"]}); return {s, w}')
check "queue runs after the current work; both replies reported" "$(result "$out")" '.s.delivered == "queue" and .w.finished[0].text == "two" and .w.finished[0].earlierReplies == ["one"]'
out=$(lead_in $L 'return await tools.octopi.send({name: "a", message: "REPLY again", mode: "steer"})')
check "any mode just prompts an idle worker" "$(result "$out")" '.delivered == "prompt"'
out=$(lead_in $L 'return await tools.octopi.wait({names: ["a"]})')
check "…and its result arrives" "$(result "$out")" '.finished[0].text == "again"'

echo "== slots (max 3 per tree)"
out=$(lead slots 'const r = await Promise.allSettled(["s1","s2","s3","s4"].map(n => tools.octopi.spawn({name: n, prompt: "SLEEP 3 REPLY " + n}))); const l = await tools.octopi.list({}); return {r: r.map(x => x.status === "fulfilled" ? "ok" : x.reason.message), n: l.workers.length}')
check "concurrent spawns stop at the cap" "$(result "$out")" '([.r[] | select(. == "ok")] | length) == 3 and ([.r[] | select(test("no free worker slot"))] | length) == 1'
check "a refused spawn creates no session" "$(result "$out")" '.n == 3'
SL=$(leader "$out")
out=$(lead_in $SL 'const w = []; for (let i = 0; i < 3; i++) w.push(...(await tools.octopi.wait({})).finished); return w.map(f => f.text).sort()')
check "all three finish" "$(result "$out")" '. == ["s1","s2","s3"]'

echo "== leaf and spawner workers"
: > $E/requests.jsonl
out=$(lead tree 'await tools.octopi.spawn({name: "leaf", prompt: "REPLY leaf"}); await tools.octopi.spawn({name: "boss", spawner: true, prompt: "REPLY boss"}); await tools.octopi.spawn({name: "bad", prompt: "FAIL"}); const w = []; for (let i = 0; i < 3; i++) w.push(...(await tools.octopi.wait({})).finished); return w')
check "a failing worker reports failed with its error" "$(result "$out")" '[.[] | select(.name == "bad")][0] | .outcome == "failed" and (.error | test("scripted failure"))'
reqs=$(jq -s '.' $E/requests.jsonl)
check "leaf workers get neither the tools nor the blurb" "$reqs" '[.[] | select(.worker and (.newest | test("REPLY leaf")))] | length > 0 and all(.octopiTools == false and .blurb == false)'
check "spawner workers get both" "$reqs" '[.[] | select(.worker and (.newest | test("REPLY boss")))] | length > 0 and all(.octopiTools and .blurb)'
check "leaders get the blurb" "$reqs" '[.[] | select(.worker | not) | select(.newest | test("CODE:"))] | all(.blurb)'

echo "== fork"
out=$(lead_in $L 'const f = await tools.octopi.spawn({name: "fs", fork: {from: "self"}, prompt: "REPLY forked self"}); const g = await tools.octopi.spawn({name: "fa", fork: {from: "a"}, prompt: "REPLY forked a"}); const w = []; while (w.length < 2) w.push(...(await tools.octopi.wait({names: ["fs", "fa"]})).finished); return {f, g, w: w.map(x => x.name + ":" + x.text).sort()}')
check "fork self and fork a worker; copied turns are not reported" "$(result "$out")" '.f.forkedFrom == "self" and .w == ["fa:forked a", "fs:forked self"]'
FS=$(result "$out" | jq -r '.f.sessionID')
FA=$(result "$out" | jq -r '.g.sessionID')
forks=$(jq -n --argjson fs "$(A get "/api/session/$FS" | jq '.data // .')" --argjson fa "$(A get "/api/session/$FA" | jq '.data // .')" --arg l "$L" --arg a "$WA" '{fs: {child: ($fs.parentID == $l), top: ($fs.parentID == null), title: $fs.title}, fa: {child: ($fa.parentID == $a), top: ($fa.parentID == null), title: $fa.title}}')
check "a fork is a child of its source, or a prefixed top-level session" "$forks" '[.fs, .fa] | all((.child and (.title | startswith("octopi") | not)) or (.top and (.title | startswith("octopi · "))))'
[ -n "${CHILDREN:-}" ] && check "forks are child sessions: $CHILDREN" "$forks" "[.fs, .fa] | map(.child | if . then 1 else 0 end) | all(. == $CHILDREN)"
hist=$(A get "/api/session/$FA/message?limit=50" | jq '[.data[] | select(.type == "user") | .text]')
check "a forked worker has the source's history and a fork preamble" "$hist" 'any(test("REPLY hello")) and any(test("a fork of worker \"a\""))'

echo "== inspect, compact, timeout, kill"
out=$(lead_in $L 'const i = await tools.octopi.inspect({name: "a", messages: 5}); const c = await tools.octopi.compact({name: "a"}); const wc = await tools.octopi.wait({names: ["a"]}); await tools.octopi.spawn({name: "slow", prompt: "SLEEP 60"}); const t = await tools.octopi.wait({names: ["slow"], timeoutSec: 2}); const k = await tools.octopi.kill({name: "slow"}); let s; try { await tools.octopi.send({name: "slow", message: "hi"}) } catch (e) { s = e.message } const l = await tools.octopi.list({}); return {i, c, wc, t, k, s, l}')
r=$(result "$out")
check "inspect shows state, last turn and a transcript" "$r" '.i.state == "idle" and .i.lastTurn.text == "again" and (.i.transcript | test("REPLY again"))'
check "compact runs and reports as a compaction turn" "$r" '.c.compaction == "started" and .wc.finished[0].compaction == true'
check "wait times out with the still-running list" "$r" '.t.timedOut == true and .t.stillRunning == ["slow"]'
check "kill interrupts and closes; send is refused" "$r" '.k.wasRunning == true and (.s | test("killed"))'
check "list shows the closed worker and a free tree" "$r" '(.l.workers[] | select(.name == "slow") | .state) == "closed" and (.l.running | startswith("0/"))'

echo "== server restart mid-turn (service mode resumes it)"
out=$(lead restart 'return await tools.octopi.spawn({name: "r", prompt: "SLEEP 6 REPLY survived"})')
RL=$(leader "$out"); sleep 1.5
restart_server
out=$(lead_in $RL 'return await tools.octopi.wait({timeoutSec: 60})')
check "the roster survives and the resumed turn's result arrives" "$(result "$out")" '.finished[0].name == "r" and .finished[0].outcome == "succeeded"'

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
