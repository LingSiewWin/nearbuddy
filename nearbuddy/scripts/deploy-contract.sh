#!/usr/bin/env bash
# Deploy the arena contract at a batch boundary. Refuses while `get_config.open_duels > 0` or any agent on the
# leaderboard is `in_duel` (a migration that resets a counter under an open duel panics its oracle callback),
# unless --force. Refuses a --migrate method that is not `#[init(ignore_state)]` in arena/src.
# Builds the wasm, re-checks the chain right before sending, deploys, verifies `get_config` answers, prints the
# tx hash and appends one line to /tmp/nearbuddy-deploys.log.
#
#   scripts/deploy-contract.sh                       # code-only deploy
#   scripts/deploy-contract.sh --migrate migrate_v12 # deploy + state migration in one tx
#   scripts/deploy-contract.sh --migrate migrate_v15 --migrate-args '{"intents_account":"…","max_vault_total":"…"}'
#   scripts/deploy-contract.sh --dry-run             # checks only (source + chain), prints the commands
#   scripts/deploy-contract.sh --at-boundary [...]   # stop both duel loops at their next batch boundary first
#
# --at-boundary touches the stop files of night-loop.sh and second-loop.sh, waits (up to BOUNDARY_WAIT_S, 7200 s)
# until both loop pids have exited, then until get_config.open_duels is 0 and no agent is in_duel (running
# `runner.py --resolve-stuck` for each pair once if not, then up to IDLE_WAIT_S, 900 s), then deploys as above.
# It never restarts the loops: on exit it prints the exact commands that do, from the restart file each loop writes
# at start (<RUN>/<loop>.cmd: launch cwd, the launch env in scripts/loop-env.sh's LOOP_ENV, argv), else from `ps`.
# The solver's own pairing loop (PAIR_EVERY_S, GET /pairing) opens duels too, so every deploy refuses while it is on:
# --at-boundary checks before touching anything, and the last check right before the tx repeats it (and the idle
# check). --force overrides both refusals on a plain deploy, never under --at-boundary.
#
# Signs with the legacy keychain key of the contract account (ARENA_CONTRACT, default arena.nearbuddy-solver.testnet).
set -u
cd "$(dirname "$0")/.." || exit 1
. scripts/loop-env.sh

ARENA="${ARENA_CONTRACT:-arena.nearbuddy-solver.testnet}"
WASM=arena/target/near/nearbuddy_arena.wasm
RUN=${NEARBUDDY_RUN_DIR:-/tmp} # logs, pidfiles and stop files; tests point it at a temp dir
DEPLOY_LOG=$RUN/nearbuddy-deploys.log
migrate="" margs="{}" force=0 dry=0 build=1 boundary=0
BOUNDARY_WAIT_S=${BOUNDARY_WAIT_S:-7200} IDLE_WAIT_S=${IDLE_WAIT_S:-900} POLL_S=${BOUNDARY_POLL_S:-10}
PY=agents/.venv/bin/python
SOLVER_URL=${SOLVER_URL:-http://127.0.0.1:${SOLVER_PORT:-4020}}

die() { echo "deploy-contract: $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --migrate) [ -n "${2-}" ] || die "--migrate needs a method name"; migrate=$2; shift 2 ;;
    --migrate-args) [ -n "${2-}" ] || die "--migrate-args needs a JSON object"; margs=$2; shift 2 ;;
    --force) force=1; shift ;;
    --no-build) build=0; shift ;;
    --dry-run) dry=1; shift ;;
    --at-boundary) boundary=1; shift ;;
    -h | --help) echo "usage: $0 [--migrate <init(ignore_state) method> [--migrate-args <json>]] [--force] [--no-build] [--dry-run] [--at-boundary]"; exit 0 ;;
    *) die "unknown argument '$1' (see --help)" ;;
  esac
done

# migration methods = the `pub fn` that follows each #[init(ignore_state)] (other attributes may sit between)
migrations=$(awk '/#\[init\(ignore_state\)\]/ { want = 1 } want && match($0, /pub fn [A-Za-z0-9_]+/) {
  print substr($0, RSTART + 7, RLENGTH - 7); want = 0 }' arena/src/*.rs)
if [ -n "$migrate" ] && ! printf '%s\n' "$migrations" | grep -qx "$migrate"; then
  die "'$migrate' is not an #[init(ignore_state)] method in arena/src (have: ${migrations:-none})"
fi

# chain state over public RPC, with a second endpoint when the first throttles; prints JSON or exits non-zero
chain() {
  ARENA="$ARENA" RPCS="${NEAR_RPC:-https://near-testnet.drpc.org} ${NEAR_RPC_FALLBACK:-https://test.rpc.fastnear.com}" \
    python3 - <<'PY'
import base64, json, os, sys, time, urllib.request

def view(method, args=b"{}"):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "query", "params": {
        "request_type": "call_function", "finality": "final", "account_id": os.environ["ARENA"],
        "method_name": method, "args_base64": base64.b64encode(args).decode()}}).encode()
    last = ""
    for attempt, url in enumerate(os.environ["RPCS"].split() * 3):
        try:
            req = urllib.request.Request(url, body, {"content-type": "application/json", "user-agent": "nearbuddy/1"})
            r = json.load(urllib.request.urlopen(req, timeout=15))
            if "result" in r:
                return json.loads(bytes(r["result"]["result"]))
            last = str(r.get("error"))
        except Exception as e:  # noqa: BLE001 - any RPC failure means "cannot verify", reported below
            last = str(e)
        time.sleep(attempt + 1)
    sys.exit(f"RPC failed for {method}: {last[:200]}")

cfg = view("get_config")
stuck = [{"model_id": a["model_id"], "pk": a["pk"], "in_duel": a["in_duel"]}
         for a in view("leaderboard", b'{"from":0,"limit":100}') if a.get("in_duel") is not None]
print(json.dumps({"next_duel": cfg["next_duel"], "open_duels": cfg.get("open_duels"),
                  "intent_lock_s": cfg.get("intent_lock_s"), "in_duel": stuck}))
PY
}

# 0 = the solver's PAIR_EVERY_S loop is off, or no solver listens; 1 = it is on or its state cannot be read
pairing_off() {
  SOLVER_URL="$SOLVER_URL" python3 - <<'PY'
import json, os, sys, urllib.error, urllib.request

url = os.environ["SOLVER_URL"] + "/pairing"
try:
    p = json.load(urllib.request.urlopen(url, timeout=5))
except urllib.error.URLError as e:
    if isinstance(e.reason, ConnectionRefusedError):
        print(f"pairing: no solver on {url}")
        sys.exit(0)
    sys.exit(f"pairing: cannot read {url}: {e.reason}")
except Exception as e:  # noqa: BLE001 - unreadable means "cannot verify", refused by the caller
    sys.exit(f"pairing: cannot read {url}: {e}")
if (p.get("every_s") or 0) > 0:
    sys.exit(f"pairing: the solver pairs idle agents every {p['every_s']}s (PAIR_EVERY_S) and can open a duel any time")
print("pairing: off")
PY
}
PAIRING_HINT="restart the solver with PAIR_EVERY_S=0 (and drop it from the env file: night-loop.sh restarts the solver)"

# succeeds only when the arena is idle and the solver's pairing loop is off; --force overrides on a plain deploy,
# never under --at-boundary. Prints the state either way.
gate() {
  local state ok=0
  if ! state=$(chain); then
    echo "REFUSE: cannot read chain state; not deploying blind" >&2
    ok=1
  else
    echo "chain: $state"
    if ! printf '%s' "$state" | python3 -c 'import json,sys; s=json.load(sys.stdin)
sys.exit(0 if (s["open_duels"] or 0) == 0 and not s["in_duel"] else 1)'; then
      echo "REFUSE: duels are open (open_duels > 0 or an agent is in_duel); wait for the batch boundary" >&2
      ok=1
    fi
  fi
  if ! pairing_off; then
    echo "REFUSE: $PAIRING_HINT" >&2
    ok=1
  fi
  [ "$ok" = 0 ] && return 0
  [ "$force" = 1 ] && [ "$boundary" = 0 ] && echo "--force given: deploying anyway" && return 0
  return 1
}

build_cmd=(cargo near build non-reproducible-wasm)
if [ -n "$migrate" ]; then
  init=(with-init-call "$migrate" json-args "$margs" prepaid-gas '100 Tgas' attached-deposit '0 NEAR')
else
  init=(without-init-call)
fi
deploy_cmd=(near contract deploy "$ARENA" use-file "$WASM" "${init[@]}" network-config testnet sign-with-legacy-keychain send)

# ---- --at-boundary: stop both duel loops between batches, wait for an idle arena --------------------------------
# name | pidfile | stop file | driver log | resolve-stuck command | restart file (written by the loop, loop-env.sh)
LOOPS=(
  "night-loop|$RUN/nearbuddy-night-loop.pid|$RUN/nearbuddy-night-loop.stop|$RUN/nearbuddy-night-driver.log|$PY -u agents/runner.py --resolve-stuck|$RUN/nearbuddy-night-loop.cmd"
  "second-loop|$RUN/nearbuddy-pair2-loop.pid|$RUN/nearbuddy-pair2-loop.stop|$RUN/nearbuddy-pair2-driver.log|$PY -u agents/runner.py --pair-tag p2 --resolve-stuck|$RUN/nearbuddy-pair2-loop.cmd"
)
loop_pid() { local p; p=$(cat "$1" 2>/dev/null) && [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"; }
# restart_line <pid> <stop file> <driver log> <restart file>: from the loop's own restart file when it names this
# pid; else (a loop started before restart files) from `ps`: argv minus --start-batch, plus the LOOP_ENV variables
# `ps eww` shows. ponytail: the ps fallback splits on spaces, so a value or argument with a space is cut; the
# restart file has no such limit.
restart_line() {
  local pid=$1 stop=$2 drv=$3 cmdf=$4 cpid cwd env argv k v
  if [ -r "$cmdf" ] && { read -r cpid && read -r cwd && read -r env && read -r argv; } < "$cmdf" && [ "$cpid" = "$pid" ]; then
    echo "cd $cwd && rm -f $(printf %q "$stop") && ${env:+$env }nohup $argv > $(printf %q "$drv") 2>&1 &"
    return
  fi
  argv=$(ps -o args= -p "$pid" | sed -E 's/ --start-batch [0-9]+//')
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  env=""
  for k in "${LOOP_ENV[@]}"; do
    v=$(ps eww -p "$pid" -o command= 2>/dev/null | tr ' ' '\n' | sed -n "s/^$k=//p" | head -1)
    [ -n "$v" ] && env+="$(printf '%q' "$k=$v") "
  done
  echo "cd $(printf %q "${cwd:-$PWD}") && rm -f $(printf %q "$stop") && ${env}nohup $argv > $(printf %q "$drv") 2>&1 &"
}
restart_lines=()
print_restart() {
  [ ${#restart_lines[@]} -gt 0 ] || return 0
  echo "the loops are stopped (or stopping) at a batch boundary; restart them with:"
  printf '  %s\n' "${restart_lines[@]}"
}
idle_now() { # 0 = open_duels 0 and nobody in_duel
  local state
  state=$(chain) || return 2
  printf '%s' "$state" | python3 -c 'import json,sys; s=json.load(sys.stdin)
sys.exit(0 if (s["open_duels"] or 0) == 0 and not s["in_duel"] else 1)'
}
wait_until() { # seconds, description, command...: poll the command until it succeeds or the time is up
  local limit=$1 what=$2 t0=$SECONDS
  shift 2
  until "$@"; do
    [ $((SECONDS - t0)) -lt "$limit" ] || return 1
    echo "waiting for $what ($((SECONDS - t0))s of ${limit}s)"
    sleep "$POLL_S"
  done
}
loops_gone() {
  local l pf
  for l in "${LOOPS[@]}"; do
    IFS='|' read -r _ pf _ _ _ <<< "$l"
    [ -z "$(loop_pid "$pf")" ] || return 1
  done
}
at_boundary() {
  local l name pf stop drv cmdf pid
  # the solver's pairing loop would open duels behind the stopped loops' backs: refuse before touching anything
  if ! pairing_off; then
    [ "$dry" = 1 ] || die "refusing --at-boundary: $PAIRING_HINT"
    echo "--dry-run: a real run would refuse here: $PAIRING_HINT"
  fi
  for l in "${LOOPS[@]}"; do
    IFS='|' read -r name pf stop drv _ cmdf <<< "$l"
    pid=$(loop_pid "$pf")
    if [ -z "$pid" ]; then echo "$name: not running"; continue; fi
    restart_lines+=("$(restart_line "$pid" "$stop" "$drv" "$cmdf")")
    echo "$name: pid $pid, stop file $stop"
  done
  if [ "$dry" = 1 ]; then
    echo "--dry-run: would touch the stop files, wait up to ${BOUNDARY_WAIT_S}s for the loops, ${IDLE_WAIT_S}s for an idle arena"
    print_restart
    return 0
  fi
  trap print_restart EXIT # whatever happens next the loops are stopping: always say how to bring them back
  for l in "${LOOPS[@]}"; do
    IFS='|' read -r _ _ stop _ _ <<< "$l"
    touch "$stop"
  done
  wait_until "$BOUNDARY_WAIT_S" "the loops to finish their batch" loops_gone ||
    die "loops still running after ${BOUNDARY_WAIT_S}s; the stop files stay, they stop at their next boundary"
  echo "both loops stopped"
  idle_now && return 0
  for l in "${LOOPS[@]}"; do
    IFS='|' read -r name _ _ _ stuck _ <<< "$l"
    echo "resolving stuck duels for $name: $stuck"
    $stuck || echo "$name resolve-stuck exit $?"
  done
  wait_until "$IDLE_WAIT_S" "open_duels 0 and no agent in_duel" idle_now ||
    die "arena not idle after ${IDLE_WAIT_S}s; not deploying"
}
[ "$boundary" = 1 ] && at_boundary

gate
idle=$?
[ "$idle" = 0 ] || [ "$dry" = 1 ] || exit 1
if [ "$dry" = 1 ]; then
  echo "migrations in source: ${migrations:-none}"
  printf '+ (cd arena &&'; printf ' %q' "${build_cmd[@]}"; printf ')\n'
  printf '+'; printf ' %q' "${deploy_cmd[@]}"; printf '\n'
  exit "$idle" # 1: a real run would refuse now
fi

if [ "$build" = 1 ]; then
  (cd arena && "${build_cmd[@]}") || die "wasm build failed"
fi
[ -f "$WASM" ] || die "no $WASM; build first"
gate || exit 1 # the build takes minutes; a batch may have opened a duel meanwhile

out=$("${deploy_cmd[@]}" 2>&1)
rc=$?
echo "$out" | tail -20
tx=$(printf '%s\n' "$out" | grep -oE 'Transaction ID: [A-Za-z0-9]+' | tail -1 | awk '{print $3}')
[ "$rc" -eq 0 ] && [ -n "$tx" ] || die "deploy failed (exit $rc)"
echo "tx $tx"

after=""
for _ in 1 2 3 4 5 6; do # final finality lags the send by a few blocks
  sleep 5
  after=$(chain) && break
done
[ -n "$after" ] || die "deployed in $tx but get_config does not answer: check the contract now"
echo "get_config ok: $after"
echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $ARENA tx $tx migrate ${migrate:-none} force $force wasm $(shasum -a 256 "$WASM" | cut -c1-16) rev $(git rev-parse --short HEAD)" >> "$DEPLOY_LOG"
