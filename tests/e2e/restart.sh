#!/bin/bash
# uso: restart.sh [VAR=valor ...]
for p in $(pgrep -f "^node src/server.js"); do kill $p; done; sleep 1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"; mkdir -p "$ROOT/tests/e2e/saida"
env "$@" setsid nohup node src/server.js > "$ROOT/tests/e2e/saida/server.log" 2>&1 &
for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.5; curl -s -o /dev/null http://localhost:3999/planos && break; done
