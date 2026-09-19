#!/bin/zsh
# Starts the headless Unciv host and the Telegram orchestrator. Ctrl-C stops both.
cd "${0:A:h}"
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export RULER_DATA="$PWD/data/game"
mkdir -p "$RULER_DATA"

(cd unciv && ./gradlew desktop:rulerHost --console=plain -q 2>&1 | grep -v "^w: \|warning:") &
HOST_PID=$!
trap 'kill $HOST_PID 2>/dev/null; pkill -f com.unciv.app.desktop.ruler.RulerHost 2>/dev/null' EXIT

until curl -s http://127.0.0.1:8765/state >/dev/null; do sleep 1; done
cd orchestrator && npm start
