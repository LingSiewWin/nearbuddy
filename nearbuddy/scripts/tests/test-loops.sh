#!/usr/bin/env bash
# Offline tests for the duel loops' stop file and `deploy-contract.sh --at-boundary`. Each test copies the scripts
# into a temp tree with fake python/bun/curl/lsof/pgrep/near on PATH, NEARBUDDY_RUN_DIR in that tree and a fake
# JSON-RPC for the arena views, so nothing touches /tmp/nearbuddy-*, a running loop or a chain.
#   bash scripts/tests/test-loops.sh        (run by scripts/check-all.sh)
# shellcheck disable=SC2034  # variables read inside the eval strings of `expect`
set -u
SCRIPTS=$(cd "$(dirname "$0")/.." && pwd)
fails=0 T="" RPC_PID=""

pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
expect() { if eval "$2"; then pass "$1"; else fail "$1 ($2)"; fi; }
wait_for() { # seconds, condition
  local end=$((SECONDS + $1))
  until eval "$2"; do
    [ "$SECONDS" -lt "$end" ] || return 1
    sleep 0.2
  done
}

setup() {
  T=$(mktemp -d)
  mkdir -p "$T/scripts" "$T/bin" "$T/run" "$T/agents/.venv/bin" "$T/arena/target/near" "$T/arena/src" "$T/fake"
  cp "$SCRIPTS"/night-loop.sh "$SCRIPTS"/second-loop.sh "$SCRIPTS"/deploy-contract.sh "$T/scripts/"
  : > "$T/arena/src/lib.rs"
  echo wasm > "$T/arena/target/near/nearbuddy_arena.wasm"
  # the runner: records its arguments; a batch takes FAKE_BATCH_S; resolve-stuck marks the arena idle
  cat > "$T/agents/.venv/bin/python" << 'SH'
#!/usr/bin/env bash
echo "$*" >> "$NEARBUDDY_RUN_DIR/python-calls"
case "$*" in
  *--check-agents*) echo "pkA,pkB" ;;
  *--resolve-stuck*) echo 0 > "$NEARBUDDY_RUN_DIR/open_duels"; echo '{"still_in_duel": []}' ;;
  *) sleep "${FAKE_BATCH_S:-1}" ;;
esac
SH
  printf '#!/bin/sh\nexec sleep 3\n' > "$T/bin/bun"     # solver and spectator
  printf '#!/bin/sh\nexit 0\n' > "$T/bin/curl"          # the solver answers
  printf '#!/bin/sh\nexit 0\n' > "$T/bin/lsof"          # nothing listens, no cwd
  printf '#!/bin/sh\nexit 1\n' > "$T/bin/pgrep"         # no rival driver (a real loop may be running here)
  printf '#!/bin/sh\necho "$*" >> "$NEARBUDDY_RUN_DIR/near-calls"\necho "Transaction ID: FAKETX123"\n' > "$T/bin/near"
  chmod +x "$T/agents/.venv/bin/python" "$T/bin/"*
  export PATH="$T/bin:$PATH" NEARBUDDY_RUN_DIR="$T/run" FAKE_BATCH_S=2
}
teardown() {
  [ -n "$RPC_PID" ] && kill "$RPC_PID" 2>/dev/null
  RPC_PID=""
  pkill -f "$T/" 2>/dev/null
  rm -rf "$T"
}
# --until twelve hours from now: the deadline never ends a test, only the stop file does
far_until() { printf '%02d00' $(((10#$(date +%H) + 12) % 24)); }

# night-loop.sh and second-loop.sh: a stop file touched mid-batch ends the loop at the boundary
for spec in "night-loop.sh|nearbuddy-night-loop.stop|nearbuddy-night.log|nearbuddy-night-loop.pid" \
  "second-loop.sh|nearbuddy-pair2-loop.stop|nearbuddy-pair2-night.log|nearbuddy-pair2-loop.pid"; do
  IFS='|' read -r script stop log pidf <<< "$spec"
  setup
  bash "$T/scripts/$script" --until "$(far_until)" > "$T/run/driver.log" 2>&1 &
  loop=$!
  if wait_for 20 'grep -q -- "--rounds" "$T/run/python-calls" 2>/dev/null'; then
    touch "$T/run/$stop" # mid-batch: this batch finishes, no other starts
    wait_for 20 '! kill -0 $loop 2>/dev/null'
    wait "$loop"
    rc=$?
    expect "$script exits 0 at the boundary" '[ "$rc" = 0 ]'
    expect "$script ran exactly the one batch" '[ "$(grep -c -- "--rounds" "$T/run/python-calls")" = 1 ]'
    expect "$script logs stopping at boundary" 'grep -q "stopping at boundary" "$T/run/$log"'
    expect "$script leaves the stop file, removes its pidfile" '[ -e "$T/run/$stop" ] && [ ! -e "$T/run/$pidf" ]'
    expect "$script's next start batch is the one it skipped" '[ "$(grep -oE "batch [0-9]+" "$T/run/$log" | tail -1)" = "batch 1" ]'
  else
    fail "$script never started a batch: $(tail -3 "$T/run/driver.log")"
    kill "$loop" 2>/dev/null
  fi
  teardown

  setup
  touch "$T/run/$stop"
  bash "$T/scripts/$script" --until "$(far_until)" > "$T/run/driver.log" 2>&1
  rc=$?
  expect "$script with the stop file already present exits 0" '[ "$rc" = 0 ]'
  expect "$script with the stop file present runs no batch" '! grep -q -- "--rounds" "$T/run/python-calls" 2>/dev/null'
  teardown
done

# deploy-contract.sh --at-boundary against a fake RPC and two fake loops
rpc_up() { # serves get_config.open_duels from $T/run/open_duels and an empty leaderboard
  local port
  port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  python3 - "$port" "$T/run/open_duels" << 'PY' > "$T/run/rpc.log" 2>&1 &
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
port, state = int(sys.argv[1]), sys.argv[2]
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["content-length"])))
        method = req["params"]["method_name"]
        val = {"next_duel": "9", "open_duels": int(open(state).read()), "intent_lock_s": 60} if method == "get_config" else []
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"result": list(json.dumps(val).encode())}}).encode()
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", port), H).serve_forever()
PY
  RPC_PID=$!
  disown "$RPC_PID" # killed by teardown; no job notice
  export NEAR_RPC="http://127.0.0.1:$port" NEAR_RPC_FALLBACK="http://127.0.0.1:$port" ARENA_CONTRACT=arena.test
  wait_for 10 "python3 -c 'import socket; socket.create_connection((\"127.0.0.1\", $port), 1)' 2>/dev/null"
}
fake_loop() { # name pidfile stopfile [never]: finishes its "batch" one second after the stop file appears
  cat > "$T/fake/$1" << SH
#!/usr/bin/env bash
until [ -e "$3" ] && [ -z "${4-}" ]; do sleep 0.2; done
sleep 1
SH
  bash "$T/fake/$1" --until 0530 --rounds 10 --start-batch 7 &
  echo $! > "$2"
  disown $!
}

setup
echo 1 > "$T/run/open_duels" # a duel is still open after the loops stop: resolve-stuck has to run
rpc_up
fake_loop night-loop.sh "$T/run/nearbuddy-night-loop.pid" "$T/run/nearbuddy-night-loop.stop"
fake_loop second-loop.sh "$T/run/nearbuddy-pair2-loop.pid" "$T/run/nearbuddy-pair2-loop.stop"
out=$(BOUNDARY_POLL_S=1 IDLE_WAIT_S=20 BOUNDARY_WAIT_S=20 bash "$T/scripts/deploy-contract.sh" --at-boundary --no-build 2>&1)
rc=$?
expect "--at-boundary deploys once the loops stopped and the arena is idle" '[ "$rc" = 0 ] && grep -q "contract deploy arena.test" "$T/run/near-calls"'
expect "--at-boundary touched both stop files" '[ -e "$T/run/nearbuddy-night-loop.stop" ] && [ -e "$T/run/nearbuddy-pair2-loop.stop" ]'
expect "--at-boundary resolved stuck duels for both pairs" 'grep -qx -- "-u agents/runner.py --resolve-stuck" "$T/run/python-calls" && grep -qx -- "-u agents/runner.py --pair-tag p2 --resolve-stuck" "$T/run/python-calls"'
expect "--at-boundary prints both restart commands without --start-batch" 'printf "%s" "$out" | grep -q "rm -f $T/run/nearbuddy-night-loop.stop && nohup bash $T/fake/night-loop.sh --until 0530 --rounds 10 >" && printf "%s" "$out" | grep -q "rm -f $T/run/nearbuddy-pair2-loop.stop && nohup bash $T/fake/second-loop.sh --until 0530 --rounds 10 >"'
expect "--at-boundary restarts nothing itself" '! /usr/bin/pgrep -f "$T/fake/" >/dev/null'
teardown

setup
echo 0 > "$T/run/open_duels"
rpc_up
fake_loop night-loop.sh "$T/run/nearbuddy-night-loop.pid" "$T/run/nearbuddy-night-loop.stop" never
out=$(BOUNDARY_POLL_S=1 BOUNDARY_WAIT_S=2 bash "$T/scripts/deploy-contract.sh" --at-boundary --no-build 2>&1)
rc=$?
expect "--at-boundary refuses when a loop outlives the wait" '[ "$rc" != 0 ] && [ ! -e "$T/run/near-calls" ] && printf "%s" "$out" | grep -q "loops still running"'
expect "--at-boundary still prints the restart command on refusal" 'printf "%s" "$out" | grep -q "nohup bash $T/fake/night-loop.sh"'
teardown

setup
echo 0 > "$T/run/open_duels"
rpc_up
fake_loop night-loop.sh "$T/run/nearbuddy-night-loop.pid" "$T/run/nearbuddy-night-loop.stop"
out=$(bash "$T/scripts/deploy-contract.sh" --at-boundary --no-build --dry-run 2>&1)
expect "--at-boundary --dry-run touches no stop file and deploys nothing" '[ ! -e "$T/run/nearbuddy-night-loop.stop" ] && [ ! -e "$T/run/near-calls" ] && printf "%s" "$out" | grep -q "would touch the stop files"'
teardown

echo "$fails failed"
[ "$fails" = 0 ]
