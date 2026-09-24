#!/usr/bin/env bash
# Start (or stop) an isolated `opencode serve` with this plugin against test/fake-anthropic.ts.
#   test/harness.sh start [opencode binary]   → writes $E/env.sh; source it to use lead/A helpers
#   test/harness.sh stop
# SERVICE=1 runs `opencode serve --service` (like a real install): it resumes interrupted turns at boot,
# and the plugin finds the server through the service registration instead of the `server` option.
set -euo pipefail
E=${E:-/tmp/octopi-e2e}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-4832}
FAKE=${FAKE:-4831}
PLUGIN=${PLUGIN:-$ROOT}
case "${1:-start}" in
stop)
  [ -f $E/session ] && tmux kill-session -t "$(cat $E/session)" 2>/dev/null || true
  exit 0
  ;;
esac
OC=${2:-opencode2}
[ -f $E/session ] && tmux kill-session -t "$(cat $E/session)" 2>/dev/null || true
rm -rf $E && mkdir -p $E/{config/opencode,data,state,cache,work}
S=agent-octopie2e-$(openssl rand -hex 3)
if [ -n "${SERVICE:-}" ]; then
  SERVER_OPTION=""
  SERVE="serve --service"
  echo "{\"port\": $PORT, \"password\": \"test\"}" > $E/config/opencode/service.json
else
  SERVER_OPTION=", \"server\": { \"url\": \"http://127.0.0.1:$PORT\", \"password\": \"test\" }"
  SERVE="serve --port $PORT"
fi
echo "$S" > $E/session
cat > $E/config/opencode/opencode.jsonc <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "$PLUGIN", "options": { "maxRunning": ${MAX_RUNNING:-3}, "waitTimeoutSec": 120$SERVER_OPTION } }],
  "providers": { "anthropic": { "settings": { "baseURL": "http://127.0.0.1:$FAKE/v1" } } }
}
EOF
cat > $E/env.sh <<EOF
export XDG_CONFIG_HOME=$E/config XDG_DATA_HOME=$E/data XDG_STATE_HOME=$E/state XDG_CACHE_HOME=$E/cache
export OPENCODE_SERVER_PASSWORD=test ANTHROPIC_API_KEY=sk-ant-fake OPENCODE_OCTOPI_DEBUG=1 OUT=$E FAKE_PORT=$FAKE
export OC=$OC URL=http://127.0.0.1:$PORT E=$E SERVE="$SERVE"
# restart_server: stop and start opencode (its tmux window closes when it exits).
restart_server() { tmux send-keys -t "$S:oc" C-c; sleep 3; tmux new-window -t "$S" -n oc ". $E/env.sh && cd $E/work && \$OC \$SERVE --print-logs --log-level info >> $E/oc.log 2>&1"; timeout 60 sh -c "until \$OC api --server \$URL get /api/session >/dev/null 2>&1; do sleep 0.5; done"; }
A() { \$OC api --server \$URL "\$@"; }
# lead <title> <js>: create a leader session and run a turn whose model executes <js> in Code Mode;
# prints the leader's session id, then its final reply.
lead() { local t=\$1; shift; local s; s=\$(A post /api/session -d "\$(jq -nc --arg t "\$t" --arg d $E/work '{title:\$t, model:{id:"claude-opus-5-5",providerID:"anthropic"}, location:{directory:\$d}}')" | jq -r '.data.id // .id'); echo "leader \$s"; lead_in "\$s" "\$@"; }
# lead_in <sessionID> <js>: the same, continuing an existing leader session.
lead_in() { local s=\$1; shift; A post "/api/session/\$s/prompt" -d "\$(jq -nc --arg c "CODE:
\$*" '{text:\$c}')" >/dev/null; timeout \${LEAD_TIMEOUT:-300} \$OC api --server \$URL post "/api/experimental/session/\$s/wait" >/dev/null 2>&1; A get "/api/session/\$s/message?limit=1&order=desc&type=assistant" | jq -r '.data[0].content[] | select(.type=="text") | .text'; }
sid() { A get /api/session | jq -r --arg t "\$1" '[.data[] | select(.title == \$t)][0].id'; }
EOF
. $E/env.sh
tmux new-session -d -s "$S" -n fake ". $E/env.sh && bun $ROOT/test/fake-anthropic.ts > $E/fake.log 2>&1"
tmux new-window -t "$S" -n oc ". $E/env.sh && cd $E/work && $OC $SERVE --print-logs --log-level info > $E/oc.log 2>&1"
timeout 60 sh -c "until $OC api --server $URL get /api/session >/dev/null 2>&1; do sleep 0.5; done"
echo "ready: . $E/env.sh"
