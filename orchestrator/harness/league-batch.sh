#!/bin/zsh
# Several leagues side by side, each on its own host.
# Usage (from orchestrator/):  harness/league-batch.sh <maxTurns> <seats> [<seats> ...]
#   <seats> is what league.mts takes: comma-separated model[:effort], e.g. claude-opus-5-5:low,claude-opus-5-5:medium
# League i runs on port 8770+i (never 8765, the real game), with its data in ../data/league-run<i> (an older one is moved aside),
# tags its result files run<i>, and logs to ../data/league-run<i>/league.log. Small map, no game-AI peoples.
cd "${0:A:h}/.."
turns=$1; shift
(( $# )) || { echo "usage: $0 <maxTurns> <seats> [<seats> ...]"; exit 1 }
i=0
for seats in "$@"; do
  i=$((i + 1)); port=$((8770 + i)); dir="${PWD:h}/data/league-run$i"
  # Only ever stop a RulerHost, and only on this league's port
  old=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null)
  if [[ -n $old ]] && ps -o command= -p $old | grep -q RulerHost; then kill $old; sleep 2; fi
  [[ -d $dir ]] && mv "$dir" "$dir-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dir"
  nohup ../host.sh "$dir" $port > "$dir/host.log" 2>&1 &
  for _ in {1..60}; do grep -q "listening on http://127.0.0.1:$port" "$dir/host.log" 2>/dev/null && break; sleep 1; done
  grep -q "listening on http://127.0.0.1:$port" "$dir/host.log" || { echo "run$i: host on $port did not start - see $dir/host.log"; exit 1 }
  LEAGUE_TAG=run$i RULER_HOST_URL=http://127.0.0.1:$port RULER_STATE_FILE="$dir/state.json" IMAGES=off \
    nohup npx tsx harness/league.mts "$seats" $turns 0 Small > "$dir/league.log" 2>&1 &
  echo "run$i on port $port: $seats -> $dir/league.log"
done
