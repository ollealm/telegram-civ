#!/bin/zsh
# Several leagues side by side, each on its own host.
# Usage (from orchestrator/):  harness/league-batch.sh <maxTurns> <seats> [<seats> ...]
#   <seats> is what league.mts takes: comma-separated model[:effort], e.g. claude-opus-5-5:low,claude-opus-5-5:medium
# Leagues are numbered on from the highest ../data/league-run<n> already there, so a new batch never touches a running one:
# league n runs on port 8770+n (never 8765, the real game), keeps its data in ../data/league-run<n>, tags its result files run<n>
# and logs to ../data/league-run<n>/league.log. LEAGUE_MAP=Medium for a bigger map (default Small). A number whose port is held by
# something other than a league host is skipped (port 8787 is taken on this machine, so run17 was skipped by hand once).
# LEAGUE_CHARACTERS, LEAGUE_REFLECT_EFFORT, LEAGUE_MAP_TYPE, LEAGUE_VICTORIES, LEAGUE_CITY_STATES, LEAGUE_AIMS, LEAGUE_GAME_AI and LEAGUE_WONDERS pass through to league.mts. A league that hits the token limit pauses and resumes
# itself (harness/league-loop.sh).
cd "${0:A:h}/.."
turns=$1; shift
(( $# )) || { echo "usage: $0 <maxTurns> <seats> [<seats> ...]"; exit 1 }
last=$(ls -d ../data/league-run<->(N) 2>/dev/null | sed 's/.*league-run//' | sort -n | tail -1)
i=${last:-0}
for seats in "$@"; do
  i=$((i + 1)); port=$((8770 + i))
  # Only ever stop a RulerHost, and only on this league's port; a port held by anything else is skipped, never touched
  old=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null)
  while [[ -n $old ]] && ! ps -o command= -p $old | grep -q RulerHost; do
    echo "run$i: port $port is held by another program - skipping to the next number"
    i=$((i + 1)); port=$((8770 + i)); old=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null)
  done
  dir="${PWD:h}/data/league-run$i"
  if [[ -n $old ]] && ps -o command= -p $old | grep -q RulerHost; then kill $old; sleep 2; fi
  mkdir -p "$dir"
  nohup ../host.sh "$dir" $port > "$dir/host.log" 2>&1 &
  for _ in {1..60}; do grep -q "listening on http://127.0.0.1:$port" "$dir/host.log" 2>/dev/null && break; sleep 1; done
  grep -q "listening on http://127.0.0.1:$port" "$dir/host.log" || { echo "run$i: host on $port did not start - see $dir/host.log"; exit 1 }
  # league-loop.sh resumes the league by itself after a spent token limit
  nohup harness/league-loop.sh $i $turns "$seats" ${LEAGUE_MAP:-Small} > "$dir/league.log" 2>&1 &
  echo "run$i on port $port: $seats (${LEAGUE_MAP:-Small} map${LEAGUE_GAME_AI:+, $LEAGUE_GAME_AI game-AI peoples}) -> $dir/league.log"
done
