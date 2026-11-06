#!/usr/bin/env bash
# Merge gate: every check CI runs, plus lint and the contract wasm build, from a clean shell.
# Exit non-zero on the first failure; prints one line per check. Usage: scripts/check-all.sh [--fast]
set -uo pipefail
cd "$(dirname "$0")/.."
fast=${1:-}
fail=0
run() { local name=$1; shift; local t0=$SECONDS; if "$@" >/tmp/nearbuddy-check-$name.log 2>&1; then
  printf 'PASS %-14s %3ss\n' "$name" $((SECONDS - t0)); else printf 'FAIL %-14s %3ss  (see /tmp/nearbuddy-check-%s.log)\n' "$name" $((SECONDS - t0)) "$name"; fail=1; fi; }
run ts-types     bun x tsc --noEmit -p .
run ts-lint      bun run lint  # lockfile biome; a missing devDependency fails instead of fetching an unrelated "biome" package
run ts-tests     bun run test
run web-types    bash -c 'cd web && bun x tsc --noEmit -p .'
run py-lint      bash -c 'cd agents && .venv/bin/ruff check . ../analysis'
run py-tests     bash -c 'NEAR_AI_API_KEY= agents/.venv/bin/python -m pytest -q agents/tests'
run rs-fmt       bash -c 'cd arena && cargo fmt --check'
run rs-clippy    bash -c 'cd arena && cargo clippy --all-targets -- -D warnings'
run rs-tests     bash -c 'cd arena && cargo test --lib'
run stub-tests   bash -c 'cd intents-stub && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --lib'
if [ "$fast" != "--fast" ]; then
  run web-build  bash -c 'cd web && bun run build'
  run wasm       bash -c 'cd arena && cargo near build non-reproducible-wasm'
fi
exit $fail
