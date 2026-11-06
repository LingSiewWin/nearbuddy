#!/usr/bin/env bash
# Prepare the Hugging Face upload of dataset/: re-export it from agents/data, print sizes and row counts, check the
# hf login, then print the upload command. Uploads only with --yes. Usage: scripts/publish-dataset.sh [--yes]
set -euo pipefail
cd "$(dirname "$0")/.."
repo=NekoRobbin/nearbuddy-arena-duels
py=agents/.venv/bin/python
yes=${1:-}

[ -s agents/data/decisions.jsonl ] || { echo "agents/data/decisions.jsonl missing: run the arena first" >&2; exit 1; }
"$py" agents/export_dataset.py

echo
du -sh dataset/decisions.* dataset/attestations dataset
echo "jsonl rows:   $(wc -l <dataset/decisions.jsonl | tr -d ' ')"
if [ -f dataset/decisions.parquet ]; then
  echo "parquet rows: $("$py" -c 'import pyarrow.parquet as pq; print(pq.read_metadata("dataset/decisions.parquet").num_rows)')"
else
  echo "parquet:      not written (pyarrow missing); the card points the viewer at decisions.jsonl"
fi
echo "attestations: $(find dataset/attestations -name '*.json' | wc -l | tr -d ' ') files"

echo
who=$(hf auth whoami 2>&1 || true)
if [ -z "$who" ] || grep -qi "not logged in" <<<"$who"; then
  echo "hf: not logged in. Run: hf auth login  (token with write access to ${repo%%/*})"
  logged_in=0
else
  echo "hf: $who"
  logged_in=1
fi

msg="$(date -u +%F) snapshot"
cmd=(hf upload "$repo" dataset --repo-type dataset --commit-message "$msg")
echo
echo "upload command:"
echo "  hf upload $repo dataset --repo-type dataset --commit-message \"$msg\""
if [ "$yes" != "--yes" ]; then
  echo "dry run: nothing uploaded. Re-run with --yes to upload."
  exit 0
fi
[ "$logged_in" = 1 ] || { echo "refusing to upload: not logged in" >&2; exit 1; }
"${cmd[@]}"
