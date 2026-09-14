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

# ffmpeg            → normaliza o criativo e gera a thumb (src/lib/ffmpeg.js)
# postgresql-client → pg_dump, usado por `npm run backup` (Lei 6, exceção
#                     registrada enquanto o Supabase for Free)
# ca-certificates   → TLS para Supabase e San Checkout
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Não roda como root. O usuário `node` (uid 1000) já existe na imagem oficial.
USER node

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
