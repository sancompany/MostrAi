# Mostraí — imagem de produção (Northflank, região sa-east-1)
#
# Por que Dockerfile e não Buildpack: o projeto normaliza criativo de vídeo com
# ffmpeg/ffprobe (src/lib/ffmpeg.js) e o backup usa pg_dump (scripts/backup.sh).
# Nenhum dos dois vem num buildpack de Node, e a falta só apareceria em runtime,
# no primeiro upload de vídeo — tarde demais.
#
# Dois estágios porque `bcrypt` é módulo nativo: ele precisa de compilador na
# instalação (quando não há prebuilt para a plataforma) e de nada depois. O
# compilador fica no estágio de build e não vai para a imagem final.

# ---------- estágio 1: dependências ----------
FROM node:22-slim AS deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- estágio 2: imagem final ----------
FROM node:22-slim

# ffmpeg               → normaliza o criativo e gera a thumb (src/lib/ffmpeg.js)
# postgresql-client-17 → pg_dump, usado por `npm run backup`. TEM que ser a 17:
#                        o Supabase roda Postgres 17 e o pg_dump recusa servidor
#                        mais novo que ele ("aborting because of server version
#                        mismatch"). O `postgresql-client` do Debian bookworm é
#                        a 15, então vem do repositório oficial do PostgreSQL.
# ca-certificates      → TLS para Supabase e San Checkout
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Não roda como root. O usuário `node` (uid 1000) já existe na imagem oficial.
USER node

ENV NODE_ENV=production
EXPOSE 3000

# Migrations no arranque, antes de servir. O Northflank não tem "release
# command" nativo (a recomendação deles é workflow com um job no meio), e o
# resultado de não ter nada foi o banco de produção ficar NOVE migrations atrás
# do código que estava no ar — descoberto em 15/09/2026, com o app já servindo
# clientes contra um schema sem as colunas que ele lê.
#
# `&&`: se a migration falhar, o contêiner não sobe, e o Northflank mantém o
# anterior servindo. É o comportamento que se quer — pior que deploy travado é
# deploy pela metade. A concorrência entre instâncias está resolvida por
# pg_advisory_lock dentro do runner.
CMD ["sh", "-c", "node src/db/migrate.js && node src/server.js"]
