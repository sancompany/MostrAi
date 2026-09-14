# Mostraí

Rede de telas de anúncio em comércios de Matão-SP. Anunciante assina um plano e o vídeo dele roda em todas as telas da rede; o comércio que cede a parede (ponto) recebe ajuda de custo ou cota pra anunciar o próprio negócio; vendedores indicam anunciantes e recebem comissão. Projeto próprio do ecossistema San & Co. (consome San Checkout, Cloudflare, e-mail do workspace).

## Rodar local

```bash
npm install
cp .env.example .env          # preencha DATABASE_URL, SESSION_SECRET, ADMIN_*
npm run migrate               # aplica src/db/migrations em ordem (idempotente)
npm run dev                   # http://localhost:3000
npm test                      # testes unitários (node:test)
npm run conciliar             # conciliação diária das assinaturas (cron em produção)
```

Precisa de Node 22+ e um Postgres (local ou o projeto Supabase do Mostraí). `ffmpeg` no PATH pra normalizar criativos.

Detalhes de teste que costumam faltar: o admin exige sessão (`POST /admin/login`
com `ADMIN_USER`/`ADMIN_PASSWORD`); o limitador de tentativas é em memória
(10 por 15 min, por IP e rota — reiniciar o servidor zera); e o roteiro ponta a
ponta está em `tests/e2e/README.md` e na seção de verificação de
`docs/specs/2026-09-12-mostrai.md`.

## Como o sistema é

- **Uma conta, três modos, um painel.** A tabela `anunciantes` é a tabela de contas (nome histórico). `papeis` ∈ {anunciante, ponto, vendedor}. O painel tem sempre as abas Anúncios / Meu ponto / Vendas; só as que a conta tem papel estão liberadas — as outras mostram um card de ativação (`public/modos.js`). Anunciante se cadastra sozinho ou ativa o modo pelo card (só falta o endereço); **dono de ponto e vendedor só entram com liberação do dono**: convite (link de cadastro, ou aceito por conta logada) ou "Liberar na conta" no admin a partir de um pedido feito de dentro do painel.
- **Ponto ≠ tela.** `pontos` é o comércio/endereço; `dispositivos` é cada TV. Cada tela tem chave de aparelho (autentica o player), PIN (abre um painel só daquela tela na própria TV), playlist própria, custo e prazo de amortização. A cota de autoanúncio é do ponto e é dividida entre as telas dele.
- **Planos modulares no banco.** Além de preço/frequência/ciclo: `preco_travado` (a conta paga o valor de quando entrou), `fundador` + `vagas` (plano especial fora da grade, ligado por `PROGRAMA_FUNDADOR_ATIVO=true` — a única regra de plano em variável de ambiente). **Benefício comercial se dá no preço, nunca no tempo**: a assinatura do San Checkout não tem carência, mês grátis nem pular ciclo (migration 021, `CONSTRAINTS.md`). **Módulos cruzados** entre os dois catálogos: plano de anunciante com `ponto_apos_meses` ("ao completar N meses ganhe uma tela no seu comércio" — o resgate vira candidatura de ponto) e opção de comodato com `plano_bonus_*` ("ponto ativo há N meses ganha M meses do plano X" — o resgate ativa o plano na conta).
- **Pagamento pelo San Checkout.** Webhook fail-closed, idempotente, transacional. Nada de cartão passa por aqui.
- **Margem real no admin.** Receita − ajuda de custo aos pontos − amortização (custo de cada tela ÷ prazo) − custos fixos lançados pelo dono.

Mapa completo das rotas em `docs/api.md`. Limites e vetos em `CONSTRAINTS.md`. Spec da versão em `docs/specs/`. Pesquisa de preço/custeio em `docs/precificacao.md`. O que fica pra depois em `docs/proximas-versoes.md`.

## Pastas

```
public/            site estático (sem build): páginas, layout.js, style.css, player.html, admin/
src/server.js      Express: sessão (Postgres), CORS, headers, rotas
src/<domínio>/     routes.js + repository.js por assunto (anunciantes, pontos, dispositivos,
                   convites, candidaturas, financeiro, playlist, player, admin, conta, categorias)
src/lib/           senha (scrypt), aparelho (chave da tela), pacing, limite de tentativas, ffmpeg, supabase
src/db/migrations  SQL numerado, aplicado por src/db/migrate.js
tests/             node:test (pacing, segurança, senha)
scripts/backup.sh  pg_dump — exceção Lei 6 enquanto o Supabase for Free
.github/workflows/ ci (push e PR na main) e auditoria semanal de dependências
docs/              api, spec, precificação, inventário de dados, erros registrados
```

## Produção (resumo — passo a passo em `docs/PENDENCIAS.md`)

Northflank (região sul-americana, deploy da `main`) + Supabase (projeto próprio, mesma região) + Cloudflare (DNS, proxy, **Access na frente de `/admin`**). Variáveis do `.env.example` no painel do Northflank. TV: navegador/kiosk abrindo o link do player gerado na aba Telas do admin.
