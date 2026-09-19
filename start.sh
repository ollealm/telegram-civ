#!/bin/zsh
# Starts the headless Unciv host and the Telegram orchestrator. Ctrl-C stops both.
cd "${0:A:h}"
./host.sh --build
./host.sh "$PWD/data/game" 8765 &
HOST_PID=$!
trap 'kill $HOST_PID 2>/dev/null' EXIT
until curl -s http://127.0.0.1:8765/state >/dev/null; do sleep 1; done
cd orchestrator && npm start
