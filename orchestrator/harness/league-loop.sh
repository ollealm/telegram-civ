#!/bin/zsh
# One league that survives a spent token limit: league.mts pauses (exit 4) the moment a look-in hits the limit, and this loop
# waits 15 minutes and resumes it - again and again until the league ends, or stops for another reason.
# Usage (from orchestrator/):  harness/league-loop.sh <n> <maxTurns> <seats> [mapSize]
#   league n talks to the host on port 8770+n with its state in ../data/league-run<n> (league-batch.sh starts both).
#   LEAGUE_RESUME=1 in the environment carries on league n instead of starting it.
#   LEAGUE_MAP_TYPE, LEAGUE_VICTORIES, LEAGUE_CITY_STATES and LEAGUE_AIMS (see league.mts) pass through from the environment;
#   LEAGUE_GAME_AI=3 adds that many peoples played by the game's own AI (default 0), LEAGUE_WONDERS=advised bars them from wonders (default all).
#   Every exit is logged with the time and the code, so a crash cannot pass for a league still running.
cd "${0:A:h}/.."
n=$1 turns=$2 seats=$3 map=${4:-Small}
export LEAGUE_TAG=run$n RULER_HOST_URL=http://127.0.0.1:$((8770 + n)) RULER_STATE_FILE="${PWD:h}/data/league-run$n/state.json" IMAGES=off
while true; do
  npx tsx harness/league.mts "$seats" $turns ${LEAGUE_GAME_AI:-0} $map ${LEAGUE_WONDERS:-all}; code=$?
  if (( code != 4 )); then
    echo "$(date +%H:%M:%S) LEAGUE STOPPED: league.mts exited with code $code ($( (( code == 0 )) && echo 'the league ended' || { (( code == 3 )) && echo 'a sovereign could not be reached' || echo 'a crash - see the lines above' } ))"
    exit $code
  fi
  echo "$(date +%H:%M:%S) paused on the token limit; trying again in 15 minutes"; sleep 900
  export LEAGUE_RESUME=1
done
