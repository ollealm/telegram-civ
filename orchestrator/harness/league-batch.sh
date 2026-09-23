#!/bin/zsh
# Several leagues side by side, each on its own host.
# Usage (from orchestrator/):  harness/league-batch.sh <maxTurns> <seats> [<seats> ...]
#   <seats> is what league.mts takes: comma-separated model[:effort], e.g. claude-opus-5-5:low,claude-opus-5-5:medium
# Leagues are numbered on from the highest ../data/league-run<n> already there, so a new batch never touches a running one:
# league n runs on port 8770+n (never 8765, the real game), keeps its data in ../data/league-run<n>, tags its result files run<n>
# and logs to ../data/league-run<n>/league.log. No game-AI peoples; LEAGUE_MAP=Medium for a bigger map (default Small).
# LEAGUE_CHARACTERS and LEAGUE_REFLECT_EFFORT pass through to league.mts.
cd "${0:A:h}/.."
turns=$1; shift
(( $# )) || { echo "usage: $0 <maxTurns> <seats> [<seats> ...]"; exit 1 }
last=$(ls -d ../data/league-run<->(N) 2>/dev/null | sed 's/.*league-run//' | sort -n | tail -1)
i=${last:-0}
for seats in "$@"; do
  i=$((i + 1)); port=$((8770 + i)); dir="${PWD:h}/data/league-run$i"
  # Only ever stop a RulerHost, and only on this league's port
  old=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null)
  if [[ -n $old ]] && ps -o command= -p $old | grep -q RulerHost; then kill $old; sleep 2; fi
  mkdir -p "$dir"
  nohup ../host.sh "$dir" $port > "$dir/host.log" 2>&1 &
  for _ in {1..60}; do grep -q "listening on http://127.0.0.1:$port" "$dir/host.log" 2>/dev/null && break; sleep 1; done
  grep -q "listening on http://127.0.0.1:$port" "$dir/host.log" || { echo "run$i: host on $port did not start - see $dir/host.log"; exit 1 }
  LEAGUE_TAG=run$i RULER_HOST_URL=http://127.0.0.1:$port RULER_STATE_FILE="$dir/state.json" IMAGES=off \
    nohup npx tsx harness/league.mts "$seats" $turns 0 ${LEAGUE_MAP:-Small} > "$dir/league.log" 2>&1 &
  echo "run$i on port $port: $seats (${LEAGUE_MAP:-Small} map) -> $dir/league.log"
done
