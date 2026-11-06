#!/usr/bin/env bash
# Operator status for the arena night loop: processes, chain, balances, batch logs, dataset.
#   scripts/arena-status.sh            # compact text
#   scripts/arena-status.sh --json     # one JSON object
#   scripts/arena-status.sh --watch    # repeat every 30 s
# Public RPC only (NEAR_RPC / ARENA_CONTRACT env override the defaults); no .env is read.
set -u
cd "$(dirname "$0")/.."
RPC="${NEAR_RPC:-https://near-testnet.drpc.org}"
ARENA="${ARENA_CONTRACT:-arena.nearbuddy-solver.testnet}"
ACCOUNTS="nearbuddy-solver.testnet nearbuddy-owner.testnet nearbuddy-fund2.testnet"
JSON=0 WATCH=0
for a in "$@"; do
  case "$a" in
    --json) JSON=1 ;;
    --watch) WATCH=1 ;;
    *) echo "usage: $0 [--json] [--watch]" >&2; exit 2 ;;
  esac
done

first_pid() { pgrep -f "$1" 2>/dev/null | head -1; }

snapshot() {
  local solver_ok=0 web_ok=0
  curl -sf -m 3 -o /dev/null http://127.0.0.1:4020/arena && solver_ok=1
  curl -sf -m 5 -o /dev/null http://127.0.0.1:3011/arena && web_ok=1
  local batch_log batch=0 round=0 resolve="" inject="" spec_log
  batch_log=$(ls -t /tmp/nearbuddy-tee-batch*.log 2>/dev/null | head -1)
  if [ -n "$batch_log" ]; then
    batch=$(echo "$batch_log" | sed -E 's/.*batch([0-9]+)\.log/\1/')
    round=$(grep -oE '^\[round [0-9]+\]' "$batch_log" | tail -1 | tr -dc 0-9)
    resolve=$(grep -E '^\[round [0-9]+\] resolve' "$batch_log" | tail -1)
  fi
  spec_log=$(ls -t /tmp/nearbuddy-spectator-*.log 2>/dev/null | head -1)
  [ -n "$spec_log" ] && inject=$(grep 'injected' "$spec_log" | tail -1)
  local dec_rows=0 sig_rows=0 copier_rows=0
  [ -f agents/data/decisions.jsonl ] && dec_rows=$(wc -l < agents/data/decisions.jsonl | tr -d ' ') &&
    sig_rows=$(grep -c '"signature_record"' agents/data/decisions.jsonl)
  [ -f analysis/data/copier.jsonl ] && copier_rows=$(wc -l < analysis/data/copier.jsonl | tr -d ' ')

  SOLVER_OK=$solver_ok WEB_OK=$web_ok \
  PID_SOLVER="$(first_pid 'packages/solver/src/index.ts')" PID_WEB="$(first_pid 'bun run start -p 3011')" \
  PID_DRIVER="$(first_pid 'nearbuddy-night|night-loop\.sh|/night\.sh')" PID_RUNNER="$(first_pid 'runner.py|-m runner')" \
  PID_COPIER="$(first_pid 'copier_bot')" \
  BATCH="${batch:-0}" ROUND="${round:-0}" RESOLVE="$resolve" INJECT="$inject" SPEC_LOG="${spec_log:-}" \
  DEC_ROWS="$dec_rows" SIG_ROWS="$sig_rows" COPIER_ROWS="$copier_rows" \
  RPC="$RPC" ARENA="$ARENA" ACCOUNTS="$ACCOUNTS" JSON="$JSON" \
  python3 - <<'PY'
import base64, json, os, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

RPC, ARENA = os.environ["RPC"], os.environ["ARENA"]
E = os.environ

def rpc(params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "query", "params": {"finality": "final", **params}}).encode()
    req = urllib.request.Request(RPC, body, {"content-type": "application/json", "user-agent": "nearbuddy/1"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=8))
    except Exception as e:  # noqa: BLE001 - status must print whatever the RPC does
        return {"error": str(e)}
    return r.get("result") if "result" in r else {"error": r.get("error", {}).get("message", "rpc error")}

def view(method, args):
    r = rpc({"request_type": "call_function", "account_id": ARENA, "method_name": method,
             "args_base64": base64.b64encode(json.dumps(args).encode()).decode()})
    if not r or "error" in r:
        return None
    return json.loads(bytes(r["result"]))

def balance(acct):
    r = rpc({"request_type": "view_account", "account_id": acct})
    return None if not r or "error" in r else int(r["amount"]) / 1e24

accounts = E["ACCOUNTS"].split()
with ThreadPoolExecutor(max_workers=6) as ex:
    cfg_f = ex.submit(view, "get_config", {})
    board_f = ex.submit(view, "leaderboard", {})
    bal_f = {a: ex.submit(balance, a) for a in accounts}
    cfg = cfg_f.result()
    duel = view("get_duel", {"duel_id": str(int(cfg["next_duel"]) - 1)}) if cfg else None
    board = board_f.result() or []
    bals = {a: f.result() for a, f in bal_f.items()}

now = time.time()
left = None
if duel:
    left = int(int(duel["close_at"]) / 1e9 - now)
top = [{"model_id": a["model_id"], "alpha_bps": a["alpha_bps"], "shield": a["shield"],
        "bond_near": round(int(a["bond"]) / 1e24, 3), "tee": a["tee"]} for a in board[:5]]
pid = lambda k: int(E[k]) if E[k] else None  # noqa: E731

out = {
    "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "processes": {
        "solver": {"pid": pid("PID_SOLVER"), "arena_ok": E["SOLVER_OK"] == "1"},
        "web": {"pid": pid("PID_WEB"), "ok": E["WEB_OK"] == "1"},
        "night_driver": pid("PID_DRIVER"), "runner": pid("PID_RUNNER"), "copier": pid("PID_COPIER"),
    },
    "chain": {
        "rpc": RPC, "contract": ARENA,
        "config": cfg and {k: cfg.get(k) for k in ("next_duel", "intent_lock_s", "min_duel_s")},  # intent_lock_s: deploy 11+
        "newest_duel": duel and {"id": duel["id"], "resolved": duel["resolved"], "close_at": duel["close_at"],
                                 "seconds_left": left, "injections": len(duel["injections"])},
        "leaderboard": top,
    },
    "balances_near": bals,
    "batch": {"number": int(E["BATCH"]), "round": int(E["ROUND"]), "last_resolve": E["RESOLVE"] or None,
              "last_injection": E["INJECT"] or None, "spectator_log": E["SPEC_LOG"] or None},
    "dataset": {"decisions_rows": int(E["DEC_ROWS"]), "signature_record_rows": int(E["SIG_ROWS"]),
                "copier_rows": int(E["COPIER_ROWS"])},
}
if E["JSON"] == "1":
    print(json.dumps(out))
    raise SystemExit

def up(ok, p):
    return ("up" if ok else "DOWN") + (f" pid {p}" if p else " no pid")

p = out["processes"]
print(f"nearbuddy arena status  {out['at']}")
print(f"  solver :4020  {up(p['solver']['arena_ok'], p['solver']['pid'])}    web :3011  {up(p['web']['ok'], p['web']['pid'])}")
print(f"  night driver {p['night_driver'] or '-'}   runner {p['runner'] or '-'}   copier {p['copier'] or '-'}")
print(f"chain  {ARENA} via {RPC}")
if cfg:
    print(f"  next_duel {cfg['next_duel']}  intent_lock_s {cfg.get('intent_lock_s', '-')}  min_duel_s {cfg['min_duel_s']}")
else:
    print("  get_config: RPC error")
if duel:
    if duel["resolved"]:
        state = "resolved"
    elif left >= 0:
        state = f"closes in {left // 60}m{left % 60:02d}s"
    else:
        state = f"closed {-left}s ago, unresolved"
    print(f"  duel {duel['id']}  {state}  injections {len(duel['injections'])}")
for a in top:
    print(f"  {a['model_id']:34} alpha {a['alpha_bps']:>5} bps  shield {a['shield']:>3}  bond {a['bond_near']:.3f}  tee {a['tee']}")
print("balances")
for a, b in bals.items():
    print(f"  {a:28} {'%.3f NEAR' % b if b is not None else 'RPC error'}")
b = out["batch"]
print(f"batch {b['number']} round {b['round']}")
print(f"  {b['last_resolve'] or 'no resolve yet'}")
print(f"  {b['last_injection'] or 'no injection yet'}")
d = out["dataset"]
print(f"dataset  decisions {d['decisions_rows']} rows ({d['signature_record_rows']} with signature_record)  copier {d['copier_rows']} rows")
PY
}

if [ "$WATCH" = 1 ]; then
  while :; do
    [ "$JSON" = 1 ] || clear
    snapshot
    sleep 30
  done
else
  snapshot
fi
