#!/usr/bin/env bash
# Contract ABIs -> committed abi/*.json -> generated TS and Python types (bun run gen:types).
# Usage: scripts/gen-abi.sh           rewrite abi/ and every generated type file
#        scripts/gen-abi.sh --check   same, then fail if anything differs from the commit (stale)
# Needs cargo-near (same version as CI: CARGO_NEAR_VERSION in .github/workflows/ci.yml).
set -euo pipefail
cd "$(dirname "$0")/.."
for pair in arena:nearbuddy_arena:arena contract:nearbuddy_vault:vault predict:nearbuddy_predict:predict paygate:nearbuddy_paygate:paygate; do
  IFS=: read -r crate lib out <<<"$pair"
  (cd "$crate" && cargo near abi >/dev/null)
  cp "$crate/target/near/${lib}_abi.json" "abi/$out.json"
done
bun run gen:types
if [ "${1:-}" = "--check" ]; then
  paths=(abi packages/protocol/src/abi web/app/lib/abi agents/arena_types.py agents/predict_types.py)
  git add -N "${paths[@]}"  # count new untracked outputs as changes
  git diff --exit-code --stat HEAD -- "${paths[@]}" || { echo "stale: run scripts/gen-abi.sh and commit"; exit 1; }
fi
