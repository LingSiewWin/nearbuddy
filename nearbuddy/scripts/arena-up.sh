#!/usr/bin/env sh
# Start the solver and the production web app together, then run duels in the foreground.
#   sh scripts/arena-up.sh [rounds] [duel-seconds]
# Needs .env (copy .env.example), agents/.venv (see agents/README.md), and testnet keys for the solver account.
set -e
cd "$(dirname "$0")/.."
( cd web && bun run build ) > .web.log 2>&1 || { echo "web build failed, see .web.log"; exit 1; }
bun run solver > .solver.log 2>&1 &
SOLVER=$!
( cd web && exec bun run start -p 3011 ) >> .web.log 2>&1 &
WEB=$!
trap 'kill $SOLVER $WEB 2>/dev/null' EXIT
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:4020/ledger > /dev/null 2>&1 && break
  sleep 1
done
curl -sf http://127.0.0.1:4020/ledger > /dev/null 2>&1 || { echo "solver did not come up, see .solver.log"; exit 1; }
echo "solver :4020  web http://127.0.0.1:3011/arena  logs .solver.log .web.log"
cd agents && .venv/bin/python -u -m runner --rounds "${1:-3}" --duel-seconds "${2:-330}" --cycle-seconds 30
