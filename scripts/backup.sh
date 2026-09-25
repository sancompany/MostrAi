#!/usr/bin/env bash
# Backup lógico do banco do Mostraí (pg_dump) — exceção registrada no
# CONSTRAINTS.md: o Supabase Free não tem backup automático, então este
# script é a Lei 6 até o plano mudar. Roda de onde tiver psql/pg_dump e a
# DATABASE_URL (ex.: no seu computador, uma vez por semana, ou como cron job
# do Northflank apontando pra um bucket).
#
# Uso: DATABASE_URL=postgres://... ./scripts/backup.sh [pasta-destino]
# Retenção: BACKUP_MANTER=N (padrão 26)
set -euo pipefail
DESTINO="${1:-backups}"
mkdir -p "$DESTINO"
: "${DATABASE_URL:?defina DATABASE_URL (a mesma do .env)}"
ARQ="$DESTINO/mostrai-$(date +%Y%m%d-%H%M%S).sql.gz"
# Grava num arquivo PARCIAL e só dá o nome de backup se o dump terminou.
# Achado do ensaio de restauração (25/09/2026): em 20/09 o pg_dump falhou
# (senha do banco trocada) e o job saiu com erro — mas o redirecionamento já
# tinha criado o .sql.gz, vazio, e ele ficou no volume com cara de backup.
PARCIAL="$ARQ.parcial"
trap 'rm -f "$PARCIAL"' EXIT
pg_dump --no-owner --no-privileges --format=plain "$DATABASE_URL" | gzip -9 > "$PARCIAL"
# O formato plain termina com esta linha; sem ela o dump está truncado.
if ! gzip -dc "$PARCIAL" | tail -n 5 | grep -q 'PostgreSQL database dump complete'; then
  echo "dump incompleto — nenhum backup gravado" >&2
  exit 1
fi
mv "$PARCIAL" "$ARQ"
trap - EXIT
echo "backup gravado em $ARQ ($(du -h "$ARQ" | cut -f1))"
# Mantém os N mais recentes na pasta (padrão 26 — meio ano de backup semanal).
# Dump gzipado de um banco deste porte é de KB a poucos MB, e o volume mínimo
# do Northflank é 6 GB, então guardar histórico é de graça. Ajuste com
# BACKUP_MANTER=N se rodar com outra frequência.
MANTER="${BACKUP_MANTER:-26}"
ls -1t "$DESTINO"/mostrai-*.sql.gz 2>/dev/null | tail -n +$((MANTER + 1)) | xargs -r rm --
# Restaurar: gunzip -c ARQUIVO | psql "$DATABASE_URL"
