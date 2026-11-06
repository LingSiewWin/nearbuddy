#!/usr/bin/env bash
# Deploy the arena contract at a batch boundary. Refuses while `get_config.open_duels > 0` or any agent on the
# leaderboard is `in_duel` (a migration that resets a counter under an open duel panics its oracle callback),
# unless --force. Refuses a --migrate method that is not `#[init(ignore_state)]` in arena/src.
# Builds the wasm, re-checks the chain right before sending, deploys, verifies `get_config` answers, prints the
# tx hash and appends one line to /tmp/nearbuddy-deploys.log.
#
#   scripts/deploy-contract.sh                       # code-only deploy
#   scripts/deploy-contract.sh --migrate migrate_v12 # deploy + state migration in one tx
#   scripts/deploy-contract.sh --dry-run             # checks only (source + chain), prints the commands
#
# Signs with the legacy keychain key of the contract account (ARENA_CONTRACT, default arena.nearbuddy-solver.testnet).
set -u
cd "$(dirname "$0")/.." || exit 1

ARENA="${ARENA_CONTRACT:-arena.nearbuddy-solver.testnet}"
WASM=arena/target/near/nearbuddy_arena.wasm
DEPLOY_LOG=/tmp/nearbuddy-deploys.log
migrate="" force=0 dry=0 build=1

die() { echo "deploy-contract: $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --migrate) [ -n "${2-}" ] || die "--migrate needs a method name"; migrate=$2; shift 2 ;;
    --force) force=1; shift ;;
    --no-build) build=0; shift ;;
    --dry-run) dry=1; shift ;;
    -h | --help) echo "usage: $0 [--migrate <init(ignore_state) method>] [--force] [--no-build] [--dry-run]"; exit 0 ;;
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

def view(method):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "query", "params": {
        "request_type": "call_function", "finality": "final", "account_id": os.environ["ARENA"],
        "method_name": method, "args_base64": base64.b64encode(b"{}").decode()}}).encode()
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
         for a in view("leaderboard") if a.get("in_duel") is not None]
print(json.dumps({"next_duel": cfg["next_duel"], "open_duels": cfg.get("open_duels"),
                  "intent_lock_s": cfg.get("intent_lock_s"), "in_duel": stuck}))
PY
}

# succeeds only when the arena is idle (or --force); prints the state either way
gate() {
  local state
  if ! state=$(chain); then
    echo "REFUSE: cannot read chain state; not deploying blind" >&2
  else
    echo "chain: $state"
    printf '%s' "$state" | python3 -c 'import json,sys; s=json.load(sys.stdin)
sys.exit(0 if (s["open_duels"] or 0) == 0 and not s["in_duel"] else 1)' && return 0
    echo "REFUSE: duels are open (open_duels > 0 or an agent is in_duel); wait for the batch boundary" >&2
  fi
  [ "$force" = 1 ] && echo "--force given: deploying anyway" && return 0
  return 1
}

build_cmd=(cargo near build non-reproducible-wasm)
if [ -n "$migrate" ]; then
  init=(with-init-call "$migrate" json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR')
else
  init=(without-init-call)
fi
deploy_cmd=(near contract deploy "$ARENA" use-file "$WASM" "${init[@]}" network-config testnet sign-with-legacy-keychain send)

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
