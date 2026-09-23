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
# Each host runs from its own copy of the compiled classes: the JVM loads classes lazily, so a rebuild under a running host
# would otherwise feed it new inner classes mid-game (NoClassDefFoundError killed a league that way on 2026-09-23). Everything
# gradle builds under unciv/ is copied - core.jar included - while the library jars in the gradle cache never change.
SNAP="$DATA/classes"; rm -rf "$SNAP"; mkdir -p "$SNAP"
CP=""; n=0
for entry in ${(s.:.)"$(cat data/classpath.txt)"}; do
  if [[ "$entry" == */unciv/*/build/* && -e "$entry" ]]; then n=$((n + 1)); cp -R "$entry" "$SNAP/$n${entry:e:+.${entry:e}}"; CP="$CP:$SNAP/$n${entry:e:+.${entry:e}}"; else CP="$CP:$entry"; fi
done
cd unciv/android/assets && exec "$JAVA_HOME/bin/java" -cp "${CP#:}" com.unciv.app.desktop.ruler.RulerHost "$DATA" "$PORT"
