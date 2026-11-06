#!/usr/bin/env bash
# Second duel pair next to night-loop.sh: batches of enclave duels between two more models, under keys derived with
# `runner.py --pair-tag p2` (never the main pair's agents), with its own spectator filtered to pair 2's duels
# (AGENTS=..., TARGET=alt). It shares the solver on :SOLVER_PORT and never restarts it: night-loop.sh does that
# between its batches, and the runner waits out the restart. Refuses to start while a pair 2 agent is in a duel.
# One driver at a time: its own pidfile, and no batch starts while another pair 2 runner is alive.
#
#   scripts/second-loop.sh --until 0530 --model-a z-ai/glm-5.3-flash --model-b Qwen/Qwen3.6-35B-A3B-FP8
#   scripts/second-loop.sh --dry-run ...     # print the commands of one batch and its failure path, run nothing
#
# Logs: /tmp/nearbuddy-pair2-night.log (one line per batch), /tmp/nearbuddy-pair2-batch<N>.log (runner),
# /tmp/nearbuddy-pair2-spectator-<N>.log, /tmp/nearbuddy-pair2-resolve-stuck.log.
# Run it detached: nohup scripts/second-loop.sh --until 0530 > /tmp/nearbuddy-pair2-driver.log 2>&1 &
# Stop at the next batch boundary: touch /tmp/nearbuddy-pair2-loop.stop (the loop leaves it in place; remove it before a
# restart). SIGINT to a backgrounded bash is ignored, and the next batch starts within a second of the last one.
set -u
LAUNCH_CWD=$PWD LAUNCH_ARGS=("$0" "$@") # for the restart line deploy-contract.sh --at-boundary prints
cd "$(dirname "$0")/.." || exit 1
. scripts/loop-env.sh

PAIR=p2
RUN=${NEARBUDDY_RUN_DIR:-/tmp} # logs, pidfiles and stop files; tests point it at a temp dir
LOG=$RUN/nearbuddy-pair2-night.log
PIDFILE=$RUN/nearbuddy-pair2-loop.pid
CMD_FILE=$RUN/nearbuddy-pair2-loop.cmd # how to restart this run: pid, cwd, launch env, argv (loop-env.sh)
STOP_FILE=$RUN/nearbuddy-pair2-loop.stop # present = finish the running batch, start no other, exit 0
STUCK_LOG=$RUN/nearbuddy-pair2-resolve-stuck.log
SOLVER_PORT=${SOLVER_PORT:-4020}
SPECTATOR_ID=${SPECTATOR_ID:-nearbuddy-solver.testnet}
SPECTATOR_DELAY_S=100 # the runner registers and opens round 0 first
IDLE_MINUTES=12
BACKOFF_S=60
PY=agents/.venv/bin/python

until_hhmm=0530 rounds=10 duel_s=330 cycle_s=45 variants="" payload_set=train start_batch="" dry=0
model_a=z-ai/glm-5.3-flash model_b=Qwen/Qwen3.6-35B-A3B-FP8

usage() {
  echo "usage: $0 [--until HHMM] [--model-a ID] [--model-b ID] [--rounds N] [--duel-seconds S]" \
    "[--cycle-seconds S] [--variants A,B,C] [--payload-set train|holdout] [--start-batch N] [--dry-run]"
}
die() { echo "$*" >&2; exit 2; }
val() { [ -n "${2-}" ] || die "$1 needs a value"; }
num() { case "$2" in '' | *[!0-9]*) die "$1 must be a whole number, got '$2'" ;; esac; }

while [ $# -gt 0 ]; do
  case "$1" in
    --until) val "$1" "${2-}"; until_hhmm=$2; shift 2 ;;
    --model-a) val "$1" "${2-}"; model_a=$2; shift 2 ;;
    --model-b) val "$1" "${2-}"; model_b=$2; shift 2 ;;
    --rounds) val "$1" "${2-}"; rounds=$2; shift 2 ;;
    --duel-seconds) val "$1" "${2-}"; duel_s=$2; shift 2 ;;
    --cycle-seconds) val "$1" "${2-}"; cycle_s=$2; shift 2 ;;
    --variants) val "$1" "${2-}"; variants=$2; shift 2 ;;
    --payload-set) val "$1" "${2-}"; payload_set=$2; shift 2 ;;
    --start-batch) val "$1" "${2-}"; start_batch=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
case "$until_hhmm" in [01][0-9][0-5][0-9] | 2[0-3][0-5][0-9]) ;; *) die "--until takes HHMM, got '$until_hhmm'" ;; esac
num --rounds "$rounds"; num --duel-seconds "$duel_s"; num --cycle-seconds "$cycle_s"
case "$payload_set" in train | holdout) ;; *) die "--payload-set takes train or holdout" ;; esac
[ "$model_a" != "$model_b" ] || die "--model-a and --model-b are the same model"
if [ -z "$start_batch" ]; then # carry on from the last batch this log saw
  last=$(grep -oE 'batch [0-9]+' "$LOG" 2>/dev/null | tail -1 | tr -dc 0-9)
  start_batch=$((${last:-0} + 1))
fi
num --start-batch "$start_batch"

read -r now_s h m s < <(date '+%s %H %M %S')
left=$(((10#${until_hhmm:0:2} * 3600 + 10#${until_hhmm:2:2} * 60 - (10#$h * 3600 + 10#$m * 60 + 10#$s) + 86400) % 86400))
[ "$left" -eq 0 ] && left=86400
deadline=$((now_s + left))

# `--pair-tag` first: night-loop.sh treats any `agents/runner.py --rounds` process as a rival driver and waits on it
models=(env NEAR_AI_MODEL_A="$model_a" NEAR_AI_MODEL_B="$model_b")
runner_cmd=("${models[@]}" "$PY" -u agents/runner.py --pair-tag "$PAIR" --rounds "$rounds" --duel-seconds "$duel_s"
  --cycle-seconds "$cycle_s")
[ -n "$variants" ] && runner_cmd+=(--variants "$variants")
stuck_cmd=("$PY" -u agents/runner.py --pair-tag "$PAIR" --resolve-stuck)
check_cmd=("$PY" agents/runner.py --pair-tag "$PAIR" --check-agents)

log() { echo "$(date '+%H:%M') $*" >> "$LOG"; }
show() { printf '+'; printf ' %q' "$@"; printf '\n'; }

# pair 2's keys (read-only views); exit 1 = one of them is still in a duel
agents=$("${check_cmd[@]}" 2> "$RUN/nearbuddy-pair2-check.log")
check_rc=$?
[ -n "$agents" ] || die "could not derive pair $PAIR's keys: $(tail -1 "$RUN/nearbuddy-pair2-check.log")"
spectator_cmd=(env AGENTS="$agents" DUELS="$rounds" TARGET=alt PAYLOAD_SET="$payload_set" SPECTATOR_ID="$SPECTATOR_ID"
  IDLE_MINUTES="$IDLE_MINUTES" bun packages/demo/src/spectator.ts)

if [ "$dry" = 1 ]; then
  echo "# pair $PAIR: A $model_a, B $model_b; until $until_hhmm ($(date -r "$deadline" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$deadline" '+%Y-%m-%d %H:%M')), batches from $start_batch, lock $PIDFILE, log $LOG"
  show "${check_cmd[@]}"
  if [ "$check_rc" -ne 0 ]; then echo "  -> would refuse to start: $(tr '\n' ' ' < "$RUN/nearbuddy-pair2-check.log")"; else echo "  -> no pair $PAIR agent in a duel"; fi
  echo "# batch $start_batch"
  echo "+ wait for http://127.0.0.1:$SOLVER_PORT/arena (never restarted here)"
  echo "+ after ${SPECTATOR_DELAY_S}s, in the background:"
  show "${spectator_cmd[@]}"; echo "  > $RUN/nearbuddy-pair2-spectator-$start_batch.log"
  show "${runner_cmd[@]}"; echo "  > $RUN/nearbuddy-pair2-batch$start_batch.log"
  echo "# then stop the spectator; on a non-zero runner exit also:"
  show "${stuck_cmd[@]}"; echo "  >> $STUCK_LOG"
  echo "+ sleep $BACKOFF_S"
  exit 0
fi

[ "$check_rc" -eq 0 ] || die "pair $PAIR agents are in a duel ($(tr '\n' ' ' < "$RUN/nearbuddy-pair2-check.log")); run: ${stuck_cmd[*]}"

other_runners() { pgrep -f "agents/runner\.py --pair-tag $PAIR --rounds" | tr '\n' ' '; }

take_lock() { (set -C; echo $$ > "$PIDFILE") 2>/dev/null; }
if ! take_lock; then
  other=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then die "second-loop already running (pid $other, $PIDFILE)"; fi
  rm -f "$PIDFILE"
  take_lock || die "lost the race for $PIDFILE"
fi
spec="" runner=""
cleanup() {
  [ -n "$spec" ] && kill "$spec" 2>/dev/null
  [ -n "$runner" ] && kill "$runner" 2>/dev/null
  [ "$(cat "$PIDFILE" 2>/dev/null)" = "$$" ] && rm -f "$PIDFILE"
}
trap cleanup EXIT
trap 'log "pair 2 loop stopped by signal"; exit 130' INT TERM
write_loop_cmd "$CMD_FILE" "$LAUNCH_CWD" "${LAUNCH_ARGS[@]}"
busy=$(other_runners)
[ -n "$busy" ] && die "another pair $PAIR runner is running (pids $busy); stop it first"

solver_up() { curl -sf -m 3 -o /dev/null "http://127.0.0.1:$SOLVER_PORT/arena"; }
wait_solver() { # night-loop.sh owns the solver; give its restart up to two minutes
  for _ in $(seq 40); do solver_up && return 0; sleep 3; done
  return 1
}
stop_spectator() { [ -n "$spec" ] && kill "$spec" 2>/dev/null; [ -n "$spec" ] && wait "$spec" 2>/dev/null; spec=""; }

log "pair 2 loop pid $$ until $until_hhmm, first #$start_batch: A $model_a B $model_b rounds $rounds duel ${duel_s}s variants ${variants:-none} payload $payload_set"
i=$start_batch
while [ "$(date +%s)" -lt "$deadline" ]; do
  busy=$(other_runners)
  if [ -n "$busy" ]; then
    log "another pair $PAIR runner is running (pids $busy); waiting ${BACKOFF_S}s"
    sleep "$BACKOFF_S"
    continue
  fi
  if ! wait_solver; then
    log "batch $i solver not answering on :$SOLVER_PORT; backing off ${BACKOFF_S}s"
    sleep "$BACKOFF_S"
    continue
  fi
  if [ -e "$STOP_FILE" ]; then # checked right before a batch starts: deploy-contract.sh --at-boundary
    log "stopping at boundary ($STOP_FILE present), next would be #$i"
    exit 0
  fi
  log "batch $i A $model_a B $model_b variants ${variants:-none} payload $payload_set"
  batch_log=$RUN/nearbuddy-pair2-batch$i.log
  (sleep "$SPECTATOR_DELAY_S"; exec "${spectator_cmd[@]}") > "$RUN/nearbuddy-pair2-spectator-$i.log" 2>&1 &
  spec=$!
  "${runner_cmd[@]}" > "$batch_log" 2>&1 &
  runner=$!
  wait "$runner"
  rc=$?
  runner=""
  log "batch $i exit $rc"
  stop_spectator
  if [ "$rc" -ne 0 ]; then
    log "batch $i error: $(awk 'NF { l = $0 } END { print l }' "$batch_log")"
    wait_solver || log "batch $i solver down; resolve-stuck will fail"
    "${stuck_cmd[@]}" >> "$STUCK_LOG" 2>&1
    src=$?
    log "batch $i resolve-stuck exit $src ($(tail -1 "$STUCK_LOG"))"
    sleep "$BACKOFF_S"
  fi
  i=$((i + 1))
done
log "pair 2 loop done, last batch $((i - 1))"
