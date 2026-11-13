#!/usr/bin/env bash
# Merge gate: every check CI runs, plus lint and the contract wasm build, from a clean shell.
# Exit non-zero on the first failure; prints one line per check. Usage: scripts/check-all.sh [--fast]
# Logs go to a fresh directory per run (printed first), so gates in parallel worktrees never share a log file.
set -uo pipefail
cd "$(dirname "$0")/.."
fast=${1:-}
fail=0
logs=$(mktemp -d "${TMPDIR:-/tmp}/nearbuddy-check.XXXXXX")
echo "logs $logs"
run() { local name=$1; shift; local t0=$SECONDS; if "$@" >"$logs/$name.log" 2>&1; then
  printf 'PASS %-14s %3ss\n' "$name" $((SECONDS - t0)); else printf 'FAIL %-14s %3ss  (see %s/%s.log)\n' "$name" $((SECONDS - t0)) "$logs" "$name"; fail=1; fi; }
run ts-types     bun x tsc --noEmit -p .
run ts-lint      bun run lint  # lockfile biome; a missing devDependency fails instead of fetching an unrelated "biome" package
run ts-tests     bun run test
# tsconfig includes Next's generated route types: .next/dev/types is whatever `next dev` last wrote (stale after a page
# is deleted, and absent on a fresh checkout), so it goes, and `next typegen` writes .next/types from the app as it is.
# next build type-checks through the same tsconfig, so web-build depends on this cleanup too.
run web-types    bash -c 'cd web && rm -rf .next/dev/types && bun x next typegen && bun x tsc --noEmit -p .'
run web-tests    bash -c 'cd web && bun test app'
run py-lint      bash -c 'cd agents && uv run --locked ruff check . ../analysis && uv run --locked ruff format --check . ../analysis'
run py-types     bash -c 'cd agents && uv run --locked mypy .'
run py-tests     bash -c 'cd agents && NEAR_AI_API_KEY= uv run --locked pytest -q'  # --locked: a stale uv.lock fails
run sentinel     bash -c 'cd sentinel && uv run --locked ruff check . && uv run --locked ruff format --check . && NEAR_AI_API_KEY= uv run --locked pytest -q'
run lab          bash -c 'cd lab && uv run --locked ruff check . && uv run --locked ruff format --check . && uv run --locked mypy . && NEAR_AI_API_KEY= uv run --locked pytest -q'
run rs-fmt       bash -c 'cd arena && cargo fmt --check'
run rs-clippy    bash -c 'cd arena && cargo clippy --locked --all-targets -- -D warnings'
run rs-tests     bash -c 'cd arena && cargo test --locked --lib'
run stub-tests   bash -c 'cd intents-stub && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked --lib'
run vault-tests  bash -c 'cd contract && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked --lib'
run predict-tests bash -c 'cd predict && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked --lib'
run gate-tests   bash -c 'cd paygate && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked --lib'
run loop-tests   bash scripts/tests/test-loops.sh  # loop stop files and deploy-contract.sh --at-boundary, all fakes
if [ "$fast" != "--fast" ]; then
  run web-build  bash -c 'cd web && bun run build'
  run wasm       bash -c 'cd arena && cargo near build non-reproducible-wasm'
  run predict-wasm bash -c 'cd predict && cargo near build non-reproducible-wasm'
fi
exit $fail
