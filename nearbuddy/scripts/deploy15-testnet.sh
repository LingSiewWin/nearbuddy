#!/usr/bin/env bash
# Testnet rollout of deploy 15 (verified settlement) on an idle arena:
#   a. the intents stub at $STUB: built and deployed when the account exists without code; when the account
#      is missing the create-account command is printed and the run stops (it never creates accounts)
#   b. scripts/deploy-contract.sh --migrate migrate_v15 --migrate-args '{intents_account, max_vault_total}'
#      (it refuses while duels are open)
#   c. migrate_follows '{"limit":50}' with 1 yocto from the owner, repeated until get_config.migrating is false
#   d. get_config checks: intents_account, migrating, paused, withdraw_delay_s, max_vault_total
#
#   scripts/deploy15-testnet.sh --dry-run    # read-only: chain state, every command, the checks against today
#   scripts/deploy15-testnet.sh              # sends the transactions
#
# Env: ARENA_CONTRACT (arena.nearbuddy-solver.testnet), INTENTS_STUB (intents-stub.nearbuddy-solver.testnet),
# ARENA_OWNER (nearbuddy-solver.testnet, signs migrate_follows), MAX_VAULT_TOTAL (27 NEAR in yocto).
# Before the switch set the solver's FOLLOWERS (deploy 15 has no list_followers; see the runbook).
set -u
cd "$(dirname "$0")/.." || exit 1

ARENA="${ARENA_CONTRACT:-arena.nearbuddy-solver.testnet}"
STUB="${INTENTS_STUB:-intents-stub.nearbuddy-solver.testnet}"
OWNER="${ARENA_OWNER:-nearbuddy-solver.testnet}"
CAP="${MAX_VAULT_TOTAL:-27000000000000000000000000}"
STUB_WASM=intents-stub/target/near/nearbuddy_intents_stub.wasm
dry=0
die() { echo "deploy15: $*" >&2; exit 1; }
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument '$a' (see --help)" ;;
  esac
done
run() { # print, and send unless --dry-run
  printf '+'; printf ' %q' "$@"; printf '\n'
  [ "$dry" = 1 ] || "$@"
}

# read-only RPC: `q account <id>` -> absent | nocode | code <hash>; `q view <contract> <method> [json]` -> JSON
q() {
  RPCS="${NEAR_RPC:-https://near-testnet.drpc.org} ${NEAR_RPC_FALLBACK:-https://test.rpc.fastnear.com}" \
    python3 - "$@" <<'PY'
import base64, json, os, sys, time, urllib.request

def rpc(params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "query", "params": params}).encode()
    last = ""
    for attempt, url in enumerate(os.environ["RPCS"].split() * 3):
        try:
            req = urllib.request.Request(url, body, {"content-type": "application/json", "user-agent": "nearbuddy/1"})
            r = json.load(urllib.request.urlopen(req, timeout=15))
            if "result" in r or "UNKNOWN_ACCOUNT" in json.dumps(r.get("error", {})):
                return r
            last = str(r.get("error"))
        except Exception as e:  # noqa: BLE001 - any RPC failure means "cannot verify"
            last = str(e)
        time.sleep(attempt + 1)
    sys.exit(f"RPC failed: {last[:200]}")

kind = sys.argv[1]
if kind == "account":
    r = rpc({"request_type": "view_account", "finality": "final", "account_id": sys.argv[2]})
    if "result" not in r:
        print("absent")
    else:
        h = r["result"]["code_hash"]
        print("nocode" if h == "11111111111111111111111111111111" else f"code {h}")
else:
    args = (sys.argv[4] if len(sys.argv) > 4 else "{}").encode()
    r = rpc({"request_type": "call_function", "finality": "final", "account_id": sys.argv[2],
             "method_name": sys.argv[3], "args_base64": base64.b64encode(args).decode()})
    if "result" not in r:
        sys.exit(f"{sys.argv[3]}: {json.dumps(r.get('error'))[:200]}")
    print(json.dumps(json.loads(bytes(r["result"]["result"]))))
PY
}
field() { python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1]); print("null" if v is None else (json.dumps(v) if not isinstance(v, str) else v))' "$1"; }

[ "$dry" = 1 ] && echo "DRY RUN: read-only, nothing is sent"
cfg=$(q view "$ARENA" get_config) || die "cannot read $ARENA get_config"
deployed15=0
[ "$(printf '%s' "$cfg" | field intents_account)" != null ] && deployed15=1
echo "arena $ARENA: next_duel $(printf '%s' "$cfg" | field next_duel), open_duels $(printf '%s' "$cfg" | field open_duels), owner $(printf '%s' "$cfg" | field owner), deploy 15 already: $([ $deployed15 = 1 ] && echo yes || echo no)"

# a. the intents stub
echo "== a. intents stub $STUB"
stub=$(q account "$STUB") || die "cannot read account $STUB"
case "$stub" in
  absent)
    echo "account $STUB does not exist. Create it (not done by this script), then rerun:"
    echo "  near account create-account fund-myself $STUB '3 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as nearbuddy-solver.testnet network-config testnet sign-with-legacy-keychain send"
    [ "$dry" = 1 ] || exit 2
    stub_deploy=1
    ;;
  nocode) echo "account exists without code: build and deploy the stub"; stub_deploy=1 ;;
  code*)
    echo "stub already deployed (${stub#code })"
    stub_deploy=0
    q view "$STUB" mt_balance_of "{\"account_id\":\"$ARENA\",\"token_id\":\"nep141:wrap.near\"}" >/dev/null \
      || die "$STUB has code but mt_balance_of does not answer: not the intents stub?"
    ;;
esac
if [ "$stub_deploy" = 1 ]; then
  if [ "$dry" = 1 ]; then
    echo "+ (cd intents-stub && cargo near build non-reproducible-wasm)"
  else
    (cd intents-stub && cargo near build non-reproducible-wasm) || die "stub build failed"
  fi
  run near contract deploy "$STUB" use-file "$STUB_WASM" without-init-call network-config testnet sign-with-legacy-keychain send
fi

# b. deploy 15 and migrate_v15 in one tx (deploy-contract.sh refuses while duels are open)
echo "== b. deploy and migrate_v15"
margs="{\"intents_account\":\"$STUB\",\"max_vault_total\":\"$CAP\"}"
if [ "$deployed15" = 1 ]; then
  echo "get_config already has intents_account: deploy 15 is live, skipping"
else
  dflag=(); [ "$dry" = 1 ] && dflag=(--dry-run)
  scripts/deploy-contract.sh --migrate migrate_v15 --migrate-args "$margs" ${dflag[@]+"${dflag[@]}"}
  rc=$?
  [ "$dry" = 1 ] || [ "$rc" = 0 ] || die "deploy-contract.sh failed (exit $rc)"
fi

# c. re-key follows in batches until get_config.migrating is false
echo "== c. migrate_follows until get_config.migrating is false"
follows_cmd=(near contract call-function as-transaction "$ARENA" migrate_follows json-args '{"limit":50}'
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER" network-config testnet
  sign-with-legacy-keychain send)
if [ "$dry" = 1 ]; then
  printf '+'; printf ' %q' "${follows_cmd[@]}"; printf '\n'
  echo "  (repeated until get_config.migrating is false; each call moves up to 50 agents' follower lists)"
else
  for i in $(seq 1 40); do
    m=$(q view "$ARENA" get_config | field migrating) || die "cannot read get_config"
    [ "$m" = false ] && break
    echo "batch $i (migrating $m)"
    if ! out=$("${follows_cmd[@]}" 2>&1); then
      # a lagging get_config read can send one call too many; the contract then answers "migration done"
      if printf '%s\n' "$out" | grep -q "migration done"; then
        echo "migration already done"
        break
      fi
      die "migrate_follows failed in batch $i: $(printf '%s\n' "$out" | tail -3)"
    fi
    sleep 3
  done
fi

# d. checks
echo "== d. get_config checks$([ "$dry" = 1 ] && [ "$deployed15" = 0 ] && echo " (today's values: these turn PASS once deploy 15 is live)")"
cfg=$(q view "$ARENA" get_config) || die "cannot read get_config"
fail=0
check() { # field expected
  local got; got=$(printf '%s' "$cfg" | field "$1")
  if [ "$got" = "$2" ]; then echo "PASS $1 = $got"; else echo "FAIL $1 = $got (want $2)"; fail=1; fi
}
check intents_account "$STUB"
check migrating false
check paused false
check withdraw_delay_s 900
check max_vault_total "$CAP"
if [ "$dry" = 1 ]; then exit 0; fi
[ "$fail" = 0 ] || die "deploy 15 checks failed"
echo "deploy 15 live on $ARENA; restart the solver with FOLLOWERS set"
