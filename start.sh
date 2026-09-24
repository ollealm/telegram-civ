#!/bin/zsh
# Starts the headless Unciv host and the Telegram orchestrator, and starts either again if it dies. Ctrl-C stops both.
# Logs go to data/logs/<date>-host.log and <date>-orchestrator.log (a new file each day a process starts).
cd "${0:A:h}"
mkdir -p data/logs
(cd orchestrator && npm run -s typecheck) || { echo "The orchestrator does not typecheck - not starting."; exit 1; }
./host.sh --build
trap 'kill 0' EXIT
# Each process is started again five seconds after it exits, so a crash costs a few seconds, not an evening
keep() { local name=$1; shift; while true; do "$@" >> "data/logs/$(date +%F)-$name.log" 2>&1; echo "$(date +%T) $name exited ($?); starting it again" >> "data/logs/$(date +%F)-$name.log"; sleep 5; done; }
keep host ./host.sh "$PWD/data/game" 8765 &
until curl -s http://127.0.0.1:8765/state >/dev/null; do sleep 1; done
keep orchestrator zsh -c 'cd orchestrator && exec npm start'
