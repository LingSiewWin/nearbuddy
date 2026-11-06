# shellcheck shell=bash
# Sourced by night-loop.sh, second-loop.sh and deploy-contract.sh: how a duel loop is restarted exactly as it was
# launched. Loop config set on the launch line (AGENTS=… scripts/night-loop.sh …) is environment, not argv, so
# `ps args` alone loses it. Only these variables are carried; secrets stay in the env file.
LOOP_ENV=(AGENTS NEAR_NETWORK NEAR_AI_MODEL_A NEAR_AI_MODEL_B TARGET PAYLOAD_SET SPECTATOR_ID NEARBUDDY_RUN_DIR NEARBUDDY_DATA)

# write_loop_cmd <file> <launch cwd> <$0> <args...>: four lines, each shell-quoted: this pid, the launch cwd, the
# LOOP_ENV assignments from the environment, and `bash <script> <args>` minus --start-batch (a restart carries on
# from the batch log). deploy-contract.sh --at-boundary prints them as the restart line when the pid still matches.
write_loop_cmd() {
  local file=$1 cwd=$2 k a skip=0 env=() argv=(bash)
  shift 2
  for k in "${LOOP_ENV[@]}"; do
    if printenv "$k" > /dev/null; then env+=("$k=$(printenv "$k")"); fi
  done
  for a in "$@"; do
    if [ "$skip" = 1 ]; then skip=0; continue; fi
    if [ "$a" = --start-batch ]; then skip=1; continue; fi
    argv+=("$a")
  done
  {
    echo "$$"
    printf '%q\n' "$cwd"
    [ ${#env[@]} -gt 0 ] && printf '%q ' "${env[@]}"
    echo
    printf '%q ' "${argv[@]}"
    echo
  } > "$file"
}
