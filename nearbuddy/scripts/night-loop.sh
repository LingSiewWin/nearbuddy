#!/usr/bin/env bash
# Overnight data loop: batches of enclave duels (runner) with a spectator injecting at one side, until a
# wall-clock time. Per batch: fresh solver (merged solver code goes live between duels, never during one),
# runner and spectator in parallel. A failed batch logs its last traceback line, resolves any duel the runner's
# agents are stuck in (`runner.py --resolve-stuck`), backs off and goes on with the next batch.
# One driver at a time: a pidfile lock, and no batch starts while another runner or night driver is alive.
#
#   scripts/night-loop.sh --until 0530 --rounds 10 --duel-seconds 330 --variants A,B,C --target a
#   scripts/night-loop.sh --until 0530 --payload-set holdout --start-batch 20
#   scripts/night-loop.sh --dry-run ...     # print the commands of one batch and its failure path, run nothing
#
# Logs: /tmp/nearbuddy-night.log (one line per batch), /tmp/nearbuddy-tee-batch<N>.log (runner),
# /tmp/nearbuddy-spectator-<N>.log, /tmp/nearbuddy-solver.log, /tmp/nearbuddy-resolve-stuck.log.
# Run it detached: nohup scripts/night-loop.sh --until 0530 > /tmp/nearbuddy-night-driver.log 2>&1 &
# Stop at the next batch boundary: touch /tmp/nearbuddy-night-loop.stop (the loop leaves it in place; remove it before a
# restart). SIGINT to a backgrounded bash is ignored, and the next batch starts within a second of the last one.
set -u
cd "$(dirname "$0")/.." || exit 1

RUN=${NEARBUDDY_RUN_DIR:-/tmp} # logs, pidfiles and stop files; tests point it at a temp dir
LOG=$RUN/nearbuddy-night.log
PIDFILE=$RUN/nearbuddy-night-loop.pid
STOP_FILE=$RUN/nearbuddy-night-loop.stop # present = finish the running batch, start no other, exit 0
SOLVER_LOG=$RUN/nearbuddy-solver.log
STUCK_LOG=$RUN/nearbuddy-resolve-stuck.log
SOLVER_PORT=${SOLVER_PORT:-4020}
SPECTATOR_ID=${SPECTATOR_ID:-nearbuddy-solver.testnet}
SPECTATOR_DELAY_S=100 # the runner registers and opens round 0 first
IDLE_MINUTES=12
BACKOFF_S=60
PY=agents/.venv/bin/python

until_hhmm=0530 rounds=10 duel_s=330 cycle_s=45 variants="" target=a payload_set=train start_batch="" dry=0

usage() {
  echo "usage: $0 [--until HHMM] [--rounds N] [--duel-seconds S] [--cycle-seconds S] [--variants A,B,C]" \
    "[--target a|b|alt] [--payload-set train|holdout] [--start-batch N] [--dry-run]"
}
die() { echo "$*" >&2; exit 2; }
val() { [ -n "${2-}" ] || die "$1 needs a value"; }
num() { case "$2" in '' | *[!0-9]*) die "$1 must be a whole number, got '$2'" ;; esac; }

while [ $# -gt 0 ]; do
  case "$1" in
    --until) val "$1" "${2-}"; until_hhmm=$2; shift 2 ;;
    --rounds) val "$1" "${2-}"; rounds=$2; shift 2 ;;
    --duel-seconds) val "$1" "${2-}"; duel_s=$2; shift 2 ;;
    --cycle-seconds) val "$1" "${2-}"; cycle_s=$2; shift 2 ;;
    --variants) val "$1" "${2-}"; variants=$2; shift 2 ;;
    --target) val "$1" "${2-}"; target=$2; shift 2 ;;
    --payload-set) val "$1" "${2-}"; payload_set=$2; shift 2 ;;
    --start-batch) val "$1" "${2-}"; start_batch=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
case "$until_hhmm" in [01][0-9][0-5][0-9] | 2[0-3][0-5][0-9]) ;; *) die "--until takes HHMM, got '$until_hhmm'" ;; esac
num --rounds "$rounds"; num --duel-seconds "$duel_s"; num --cycle-seconds "$cycle_s"
case "$target" in a | b | alt) ;; *) die "--target takes a, b or alt" ;; esac
case "$payload_set" in train | holdout) ;; *) die "--payload-set takes train or holdout" ;; esac
if [ -z "$start_batch" ]; then # carry on from the last batch this log saw (the old watchdog's rule)
  last=$(grep -oE 'batch [0-9]+' "$LOG" 2>/dev/null | tail -1 | tr -dc 0-9)
  start_batch=$((${last:-0} + 1))
fi
num --start-batch "$start_batch"

# deadline: the next HHMM on the wall clock (tomorrow if it already passed today); checked before each batch,
# so the last batch can run past it by one batch length
read -r now_s h m s < <(date '+%s %H %M %S')
left=$(((10#${until_hhmm:0:2} * 3600 + 10#${until_hhmm:2:2} * 60 - (10#$h * 3600 + 10#$m * 60 + 10#$s) + 86400) % 86400))
[ "$left" -eq 0 ] && left=86400
deadline=$((now_s + left))

# arrays keep every flag its own word in bash and zsh alike (a scalar "$flag" is one word in zsh)
runner_cmd=("$PY" -u agents/runner.py --rounds "$rounds" --duel-seconds "$duel_s" --cycle-seconds "$cycle_s")
[ -n "$variants" ] && runner_cmd+=(--variants "$variants")
stuck_cmd=("$PY" -u agents/runner.py --resolve-stuck)
spectator_cmd=(env DUELS="$rounds" TARGET="$target" PAYLOAD_SET="$payload_set" SPECTATOR_ID="$SPECTATOR_ID"
  IDLE_MINUTES="$IDLE_MINUTES" bun packages/demo/src/spectator.ts)
solver_cmd=(bun packages/solver/src/index.ts)

log() { echo "$(date '+%H:%M') $*" >> "$LOG"; }
show() { printf '+'; printf ' %q' "$@"; printf '\n'; }

if [ "$dry" = 1 ]; then
  echo "# until $until_hhmm ($(date -r "$deadline" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$deadline" '+%Y-%m-%d %H:%M')), batches from $start_batch, lock $PIDFILE, log $LOG"
  echo "# batch $start_batch"
  echo "+ kill the listener on tcp:$SOLVER_PORT; wait for http://127.0.0.1:$SOLVER_PORT/arena after:"
  show nohup "${solver_cmd[@]}"; echo "  > $SOLVER_LOG"
  echo "+ after ${SPECTATOR_DELAY_S}s, in the background:"
  show "${spectator_cmd[@]}"; echo "  > $RUN/nearbuddy-spectator-$start_batch.log"
  show "${runner_cmd[@]}"; echo "  > $RUN/nearbuddy-tee-batch$start_batch.log"
  echo "# then stop the spectator; on a non-zero runner exit also:"
  show "${stuck_cmd[@]}"; echo "  >> $STUCK_LOG"
  echo "+ sleep $BACKOFF_S"
  exit 0
fi

other_drivers() { # another night driver or two-sided runner would fight ours over agents A/B
  pgrep -f 'agents/runner\.py --rounds|/night\.sh' | grep -vx "$$" | tr '\n' ' '
}

# lock: noclobber makes the pidfile write atomic; a pidfile whose process is gone is stale
take_lock() { (set -C; echo $$ > "$PIDFILE") 2>/dev/null; }
if ! take_lock; then
  other=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then die "night-loop already running (pid $other, $PIDFILE)"; fi
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
trap 'log "night loop stopped by signal"; exit 130' INT TERM
busy=$(other_drivers)
[ -n "$busy" ] && die "another driver is running (pids $busy); stop it first"

solver_up() { curl -sf -m 3 -o /dev/null "http://127.0.0.1:$SOLVER_PORT/arena"; }
restart_solver() {
  lsof -ti "tcp:$SOLVER_PORT" -sTCP:LISTEN | while read -r p; do kill "$p"; done
  sleep 2
  nohup "${solver_cmd[@]}" > "$SOLVER_LOG" 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    sleep 2
    solver_up && return 0
  done
  return 1
}
stop_spectator() { [ -n "$spec" ] && kill "$spec" 2>/dev/null; [ -n "$spec" ] && wait "$spec" 2>/dev/null; spec=""; }

log "night loop pid $$ until $until_hhmm, first #$start_batch: rounds $rounds duel ${duel_s}s variants ${variants:-none} target $target payload $payload_set"
i=$start_batch
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -e "$STOP_FILE" ]; then # checked before every batch (and every wait): deploy-contract.sh --at-boundary
    log "stopping at boundary ($STOP_FILE present), next would be #$i"
    exit 0
  fi
  busy=$(other_drivers)
  if [ -n "$busy" ]; then
    log "another driver is running (pids $busy); waiting ${BACKOFF_S}s"
    sleep "$BACKOFF_S"
    continue
  fi
  log "batch $i variants ${variants:-none} target $target payload $payload_set"
  if ! restart_solver; then
    log "batch $i solver did not answer on :$SOLVER_PORT (see $SOLVER_LOG); backing off ${BACKOFF_S}s"
    sleep "$BACKOFF_S"
    i=$((i + 1))
    continue
  fi
  batch_log=$RUN/nearbuddy-tee-batch$i.log
  (sleep "$SPECTATOR_DELAY_S"; exec "${spectator_cmd[@]}") > "$RUN/nearbuddy-spectator-$i.log" 2>&1 &
  spec=$!
  "${runner_cmd[@]}" > "$batch_log" 2>&1 &
  runner=$!
  wait "$runner"
  rc=$?
  runner=""
  log "batch $i exit $rc"
  stop_spectator # the runner resolved its last duel; nothing is left to inject into
  if [ "$rc" -ne 0 ]; then
    log "batch $i error: $(awk 'NF { l = $0 } END { print l }' "$batch_log")"
    solver_up || restart_solver || log "batch $i solver down; resolve-stuck will fail"
    "${stuck_cmd[@]}" >> "$STUCK_LOG" 2>&1
    src=$?
    log "batch $i resolve-stuck exit $src ($(tail -1 "$STUCK_LOG"))"
    sleep "$BACKOFF_S"
  fi
  i=$((i + 1))
done
log "night loop done, last batch $((i - 1))"
