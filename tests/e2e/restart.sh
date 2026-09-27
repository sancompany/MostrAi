#!/bin/bash
# uso: restart.sh [VAR=valor ...]
#
# NODE_ENV=development por padrão (dá pra sobrescrever nos argumentos): o
# .env local usa NODE_ENV=test pra `node --test`, e com ele o servidor NÃO
# abre o LISTEN do SSE (src/lib/sse.js) — evento publicado por outro processo
# (o `node -e` que concede crédito no roteiro 17, um job, a outra instância)
# nunca chegava na página. O servidor dos roteiros tem que ser um servidor de
# verdade. (Achado de 26/09/2026.)
for p in $(pgrep -f "^node src/server.js"); do kill $p; done; sleep 1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"; mkdir -p "$ROOT/tests/e2e/saida"
env NODE_ENV=development "$@" setsid nohup node src/server.js > "$ROOT/tests/e2e/saida/server.log" 2>&1 &
for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.5; curl -s -o /dev/null http://localhost:3999/planos && break; done
