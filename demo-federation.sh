#!/usr/bin/env bash
# demo-federation.sh — Two-node DeadLine federation demo on one machine.
#
# Builds ONCE, then runs two nodes (separate ports, data dirs, node ids)
# that peer with each other. Post on one node and the post appears on the
# other within a sync round (push-on-post makes it near-immediate).
# Stop with Ctrl-C; both nodes are killed. Data survives in data/demo-a
# and data/demo-b, so a restart re-syncs from the persisted log.
#
#   Node A: web http://localhost:8081/  telnet localhost 2324
#   Node B: web http://localhost:8082/  telnet localhost 2325
set -euo pipefail
cd "$(dirname "$0")"

npm run build

cleanup() {
  echo ''
  echo 'Stopping both nodes...'
  kill "$PID_A" "$PID_B" 2>/dev/null || true
  wait "$PID_A" 2>/dev/null || true
  wait "$PID_B" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

HTTP_PORT=8081 TELNET_PORT=2324 DATA_DIR=data/demo-a \
  DEADLINE_NODE_ID=node-a DEADLINE_PEERS=http://127.0.0.1:8082 \
  node dist/server/main.js > /tmp/deadline-demo-a.log 2>&1 &
PID_A=$!

HTTP_PORT=8082 TELNET_PORT=2325 DATA_DIR=data/demo-b \
  DEADLINE_NODE_ID=node-b DEADLINE_PEERS=http://127.0.0.1:8081 \
  node dist/server/main.js > /tmp/deadline-demo-b.log 2>&1 &
PID_B=$!

sleep 1
echo ''
echo 'Two federated DeadLine nodes are answering (no SYNC_SECRET: demo network).'
echo '  Node A: web http://localhost:8081/  telnet localhost 2324'
echo '  Node B: web http://localhost:8082/  telnet localhost 2325'
echo '  Logs:   /tmp/deadline-demo-a.log  /tmp/deadline-demo-b.log'
echo ''
echo 'Try it: register on A, post a thread, then open B — the thread is there.'
echo 'Press Ctrl-C to stop both nodes.'
echo ''
wait
