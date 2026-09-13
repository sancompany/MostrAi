# Mostraí — guia pra quem trabalha neste repositório com IA

Projeto da San & Co. Siga o plugin `san-co` (Leis, estações, `construir`, `revisar`, `seguranca-san`, `checkout`). Este arquivo é o que é específico daqui.

## O que este projeto é
Rede DOOH em Matão-SP: anunciante paga plano → vídeo roda nas telas; ponto cede a parede; vendedor indica. Node 22 + Express 4 + Postgres (`pg` cru) + site estático sem build. Leia `README.md` (mapa), `docs/api.md` (rotas), `CONSTRAINTS.md` (vetos e limites) antes de mudar qualquer coisa.

## Regras locais que não estão nas Leis
- **`anunciantes` é a tabela de contas.** Não renomear (CONSTRAINTS.md). Papéis em `papeis text[]`.
- **Dono de ponto e vendedor só nascem por convite.** Nunca reabrir cadastro público pra esses papéis. `POST /seja-um-ponto` responde 410 de propósito.
- **Regra de plano mora no banco, não em env var.** A única exceção é `PROGRAMA_FUNDADOR_ATIVO`. Não criar outra.
- **Tela ≠ ponto.** Playlist, chave, PIN, sinal, custo: por `dispositivos`. Cota de autoanúncio: do ponto, dividida por `dividirCota`.
- **Nada de usuário/senha na TV.** Chave de aparelho + PIN de 4–6 dígitos, e o PIN abre só o painel daquela tela.
- **Webhook do San Checkout:** fail-closed, idempotente (`webhooks_processados`), transacional. Não afrouxar.
- **Migrations são aditivas.** Drop de coluna/tabela (`afiliados`, `pontos.aparelho_id`, `comissoes.afiliado_id`…) só com permissão do dono, em migration própria.
- **`.env` nunca entra no git.** `.env.example` documenta tudo. Segredo que vazou se revoga, não se apaga do histórico.
- **Não prometer travar a TV em tela cheia** — isso é do app kiosk, não do player.

## Como testar
- `npm test` — unitários (pacing, senha scrypt, segurança).
- Fluxo ponta a ponta: subir Postgres local, `npm run migrate`, `node src/server.js`, e rodar candidatura → convite → cadastro → tela/chave/PIN → playlist → webhook (o roteiro está em `docs/specs/2026-09-12-mostrai.md`, seção de verificação).
- Admin exige sessão: `POST /admin/login` com `ADMIN_USER`/`ADMIN_PASSWORD`.
- Rate limit em memória: reiniciar o servidor zera (10 tentativas / 15 min por IP+rota).

## Hospedagem
Northflank (não Render). Supabase próprio, mesma região. Cloudflare Access é a porta do `/admin`. Detalhes na skill `classificar` do plugin.

## Onde registrar
- Decisão de produto/escopo → `docs/specs/<data>-mostrai.md` e `docs/proximas-versoes.md`.
- Erro que custou caro → `docs/erros/<data>-<nome>.md` (5 linhas: o que, sintoma, causa, correção, como não repetir).
- Limite ou exceção → `CONSTRAINTS.md`.
