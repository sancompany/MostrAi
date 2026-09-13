# Mostraí

Rede de telas de anúncio em comércios de Matão-SP. Anunciante assina um plano e o vídeo dele roda em todas as telas da rede; o comércio que cede a parede (ponto) recebe ajuda de custo ou cota pra anunciar o próprio negócio; vendedores indicam anunciantes e recebem comissão. Projeto próprio do ecossistema San & Co. (consome San Checkout, Cloudflare, e-mail do workspace).

## Rodar local

```bash
npm install
cp .env.example .env          # preencha DATABASE_URL, SESSION_SECRET, ADMIN_*
npm run migrate               # aplica src/db/migrations em ordem (idempotente)
npm run dev                   # http://localhost:3000
npm test                      # testes unitários (node:test)
```

Precisa de Node 22+ e um Postgres (local ou o projeto Supabase do Mostraí). `ffmpeg` no PATH pra normalizar criativos.

## Como o sistema é

- **Uma conta, três modos, um painel.** A tabela `anunciantes` é a tabela de contas (nome histórico). `papeis` ∈ {anunciante, ponto, vendedor}. O painel tem sempre as abas Anúncios / Meu ponto / Vendas; só as que a conta tem papel estão liberadas — as outras mostram um card de ativação (`public/modos.js`). Anunciante se cadastra sozinho ou ativa o modo pelo card (só falta o endereço); **dono de ponto e vendedor só entram com liberação do dono**: convite (link de cadastro, ou aceito por conta logada) ou "Liberar na conta" no admin a partir de um pedido feito de dentro do painel.
- **Ponto ≠ tela.** `pontos` é o comércio/endereço; `dispositivos` é cada TV. Cada tela tem chave de aparelho (autentica o player), PIN (abre um painel só daquela tela na própria TV), playlist própria, custo e prazo de amortização. A cota de autoanúncio é do ponto e é dividida entre as telas dele.
- **Planos modulares no banco.** Além de preço/frequência/ciclo: `meses_gratis` (creditados na 1ª cobrança), `minimo_telas_ativas` (cobertura só começa a contar com a rede nesse tamanho; o pago antes vira crédito), `preco_travado` (a conta paga o valor de quando entrou), `fundador` + `vagas` (plano especial fora da grade, ligado por `PROGRAMA_FUNDADOR_ATIVO=true` — a única regra de plano em variável de ambiente). **Módulos cruzados** entre os dois catálogos: plano de anunciante com `ponto_apos_meses` ("ao completar N meses ganhe uma tela no seu comércio" — o resgate vira candidatura de ponto) e opção de comodato com `plano_bonus_*` ("ponto ativo há N meses ganha M meses do plano X" — o resgate ativa o plano na conta).
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
infra/github/      workflows pra mover pra .github/workflows/
docs/              api, spec, precificação, inventário de dados, erros registrados
```

## Produção (resumo — passo a passo em `claude/mostrai-pendencias.md` do projeto)

Northflank (região sul-americana, deploy da `main`) + Supabase (projeto próprio, mesma região) + Cloudflare (DNS, proxy, **Access na frente de `/admin`**). Variáveis do `.env.example` no painel do Northflank. TV: navegador/kiosk abrindo o link do player gerado na aba Telas do admin.
