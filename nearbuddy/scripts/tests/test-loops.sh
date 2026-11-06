#!/usr/bin/env bash
# Offline tests for the duel loops' stop file. Each test copies the scripts
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

echo "$fails failed"
[ "$fails" = 0 ]
