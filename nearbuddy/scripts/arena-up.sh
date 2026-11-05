#!/usr/bin/env sh
# Start the solver and the production web app together, then run duels in the foreground.
#   sh scripts/arena-up.sh [rounds] [duel-seconds]
# Needs .env (copy .env.example), agents/.venv (see agents/README.md), and testnet keys for the solver account.
set -e
cd "$(dirname "$0")/.."
pnpm solver > .solver.log 2>&1 &
SOLVER=$!
( cd web && pnpm build > /dev/null && pnpm start -p 3011 > ../.web.log 2>&1 ) &
WEB=$!
trap 'kill $SOLVER $WEB 2>/dev/null' EXIT
sleep 8
echo "solver :4020  web http://127.0.0.1:3011/arena  logs .solver.log .web.log"
agents/.venv/bin/python -u -m runner --rounds "${1:-3}" --duel-seconds "${2:-90}" --cycle-seconds 30
