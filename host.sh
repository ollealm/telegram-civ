#!/bin/zsh
# Runs one RulerHost with plain java. Usage: host.sh <dataDir> [port]   (rebuild first with: host.sh --build)
cd "${0:A:h}"
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
if [[ "$1" == "--build" || ! -s data/classpath.txt ]]; then
  mkdir -p data
  (cd unciv && ./gradlew desktop:rulerClasspath --console=plain -q 2>/dev/null | grep "^CLASSPATH=" | cut -d= -f2- > ../data/classpath.txt)
  [[ "$1" == "--build" ]] && exit 0
fi
DATA="${1:-$PWD/data/game}"; PORT="${2:-8765}"
mkdir -p "$DATA"
cd unciv/android/assets && exec "$JAVA_HOME/bin/java" -cp "$(cat ../../../data/classpath.txt)" com.unciv.app.desktop.ruler.RulerHost "$DATA" "$PORT"
