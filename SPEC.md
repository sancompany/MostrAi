# SPEC — Vitrina (app web)

> Especificação técnica completa, derivada do plano de negócio consolidado
> (`vitrina-plano-completo.md`, salvo no projeto). Este arquivo é a fonte de
> verdade pra construção do código — qualquer mudança de escopo passa por
> aqui antes de virar código.
>
> Raiz do projeto: `/home/claude/vitrina-app/`
> Repositório: novo, separado do San Checkout (consome a API dele de fora).

---

## 1. Objetivo

Sistema web que roda a rede de mídia digital indoor Vitrina: cadastro de
anunciantes e pontos físicos, geração e distribuição de playlist de anúncios
por ponto, player que roda nas TVs, painel administrativo, cobrança
recorrente via integração com o San Checkout, **e o site público** pelo qual
uma empresa que nunca foi contatada se cadastra, assina um plano e sobe o
próprio criativo sozinha (módulo 7) — o software não é só um back-office, é o
canal de aquisição da empresa.

**Fora de escopo nesta versão** (ver plano de negócio, Parte 3.7):
segmentação por perfil de público, múltiplos idiomas/fusos horários,
cobrança variável por audiência, app de gestão para o dono do
estabelecimento, promoção automática de nível de afiliado, integração com
DSPs externos.

---

## 2. Stack e comandos

| Camada | Escolha | Motivo |
|---|---|---|
| Runtime | Node.js (LTS) | mesma linguagem do San Checkout |
| Framework HTTP | Express | mínimo necessário, sem framework pesado |
| Banco | PostgreSQL **gerenciado pelo Supabase**, via `pg` (sem ORM) | contadores agregados e relatórios são `GROUP BY` simples; ORM não paga o preço aqui — Supabase é só o Postgres hospedado, `pg` conecta nele igual conectaria em qualquer Postgres |
| Processamento de mídia | `ffmpeg` via `child_process` direto | uma chamada de CLI resolve normalização e thumbnail — sem wrapper de biblioteca |
| Sessão/login | `express-session` + `bcrypt` | admin e anunciantes autenticados (sessões separadas); sem RBAC/biblioteca de auth completa nesta fase |
| Storage de mídia | **Supabase Storage** (bucket), via `@supabase/supabase-js` | não disco local — o Render não garante disco persistente entre deploys nos planos mais simples; o ffmpeg ainda processa em arquivo temporário local, só o resultado final (vídeo normalizado + thumbnail) sobe pro bucket |
| E-mail transacional | `nodemailer` via SMTP | confirmação de pagamento é responsabilidade da Vitrina, não do San Checkout (módulo 6) |
| Backup de comprovantes | `googleapis` (Drive, conta de serviço) | upload do PDF de nota fiscal pra pasta fixa do workspace San & Co. |
| CORS | `cors` | API (Render) e front (Cloudflare Pages) ficam em domínios diferentes — ver seção 2b |
| Frontend do player e dashboards | HTML/CSS/JS simples, sem build step | site pequeno, não justifica React/bundler ainda — mas agora é servido separado da API (ver 2b), não pelo Express |

```
npm install        # instala dependências
npm run dev         # sobe o servidor em modo desenvolvimento (nodemon)
npm start           # sobe o servidor em produção
npm test            # roda os testes (node --test)
npm run migrate     # aplica migrações do banco (scripts/migrate.js)
```

## 2b. Implantação (deploy)

Um repositório só no GitHub, dois lugares rodando:

- **Render** — a API Express (`src/server.js`), só JSON, sem servir HTML.
  Domínio: `api.vitrina.sancocore.com.br` (CNAME no Cloudflare pro Render).
- **Cloudflare Pages** — tudo que está em `public/` (institucional, planos,
  player, painel do anunciante, painel admin), deploy automático a cada push
  no GitHub, sem build step (é HTML/CSS/JS puro). Domínio:
  `vitrina.sancocore.com.br`.
- **Supabase** — Postgres (via `DATABASE_URL`, consumido com `pg` normal) e
  Storage (bucket `criativos`, ver tabela acima).

Como o front e a API vivem em domínios diferentes, toda chamada do front pra
API é cross-origin: `cors` no Express libera só `CORS_ORIGIN` (a origem do
Cloudflare Pages), com `credentials: true` nas rotas autenticadas (sessão de
anunciante/admin) — sem isso o cookie de sessão não vai e volta entre
domínios.

`ponytail:` sem proxy reverso, sem Cloudflare Pages Functions — CORS direto é
a solução mais curta pra dois domínios que só precisam conversar por fetch.
Adicionar proxy se algum dia o cookie cross-domain virar problema real (ex.:
navegador bloqueando third-party cookie), não antes.

## 3. Estrutura de pastas

```
/home/claude/vitrina-app/
├── SPEC.md
├── package.json
├── .env.example
├── src/
│   ├── server.js              # bootstrap do Express
│   ├── db/
│   │   ├── pool.js            # conexão pg
│   │   └── migrations/        # SQL numerado (001_pontos.sql, 002_anunciantes.sql, ...)
│   ├── lib/
│   │   ├── ffmpeg.js          # normalização de mídia (módulo 2)
│   │   └── pacing.js          # cálculo de frequência/compensação (módulo 3)
│   ├── pontos/                # módulo 1
│   │   ├── routes.js
│   │   └── repository.js
│   ├── anunciantes/           # módulo 2
│   │   ├── routes.js
│   │   └── repository.js
│   ├── playlist/              # módulo 3
│   │   ├── routes.js
│   │   └── gerador.js
│   ├── player/                # módulo 4 (front-end estático + rota de proof-of-play)
│   │   └── routes.js
│   ├── admin/                  # módulo 5
│   │   └── routes.js
│   ├── financeiro/             # módulo 6
│   │   ├── routes.js
│   │   ├── san-checkout.js
│   │   ├── email.js            # nodemailer, confirmação de pagamento
│   │   └── drive.js             # googleapis, upload de nota fiscal
│   └── site/                   # módulo 7 (institucional, planos, seja-um-ponto)
│       └── routes.js
├── public/
│   ├── player.html
│   ├── index.html               # institucional
│   ├── planos.html
│   ├── pontos.html               # "onde estamos"
│   ├── seja-um-ponto.html
│   ├── seja-um-vendedor.html
│   ├── anunciante/              # cadastro, login, painel (dashboard) do anunciante
│   ├── afiliado/                # cadastro, login, painel do vendedor
│   └── admin/                   # painel do operador
├── uploads/                    # staging temporário do ffmpeg (fora do git; resultado final vai pro Supabase Storage)
└── tests/
    ├── pacing.test.js
    └── ffmpeg-normalize.test.js
```

## 4. Estilo de código

- JavaScript puro (sem TypeScript nesta fase — reavaliar se o time crescer)
- Um arquivo de rotas + um de acesso a dados por módulo, nada além disso
- Sem camada de "service" genérica separada do repository enquanto a lógica
  couber numa função — extrair só quando duplicar
- SQL cru, parametrizado (`$1, $2`), nunca concatenado
- Nomes de tabela/coluna em português, snake_case (`pontos`, `anunciantes`,
  `criativo_url`), consistente com o domínio do negócio

## 5. Estratégia de testes

Mínimo necessário — um teste por lógica não-trivial, sem suíte completa:

- `pacing.test.js` — a função que decide quantas vezes um anúncio entra na
  playlist da hora, incluindo o caso de compensação (ficou devendo → entra
  mais na próxima)
- `ffmpeg-normalize.test.js` — confirma que um arquivo horizontal de entrada
  sai em 1080×1920
- Cálculo de comissão de afiliado e de `taxasTotais`/`valorCobrado` do
  webhook do San Checkout
- Sem cobertura de UI, sem CI nesta fase — roda `npm test` manualmente antes
  de cada deploy

## 6. Limites (boundaries)

**Sempre fazer sem perguntar:**
- Seguir as decisões já fechadas no plano de negócio (Parte 2 e "decisões já
  fechadas" do escopo original) — não reabrir sem o usuário levantar o tema
- Informar o caminho completo do arquivo (a partir da raiz
  `/home/claude/vitrina-app/`) sempre que criar ou editar algo
- Rodar os testes do módulo antes de considerar ele pronto

**Perguntar antes:**
- Qualquer mudança de schema que afete dado já gravado (renomear/remover
  coluna com dado)
- Adicionar uma dependência nova ao `package.json`
- Qualquer coisa que mude preço, comissão, ou regra de negócio já fechada

**Nunca fazer:**
- Guardar segredo (chave do San Checkout, senha) fora de variável de
  ambiente / `.env` (nunca commitado)
- Confiar em preço/valor vindo do client — todo cálculo de cobrança é
  server-side, espelhando a regra do próprio contrato do San Checkout
- Adicionar ORM, fila de mensagens, cache distribuído, ou qualquer peça de
  infraestrutura não pedida enquanto o volume não justificar

---

# MÓDULOS

## Módulo 1 — Pontos (base, sem dependências)

**Entidade `pontos`**

| Campo | Tipo | Obs |
|---|---|---|
| id | serial PK | |
| nome | text | nome do estabelecimento |
| endereco | text | rua, número, bairro — obrigatório pra listar no mapa público (módulo 7) e pro contrato de comodato |
| cidade / uf / cep | text | preparado pra expansão multi-cidade (Parte 2.7 do plano) |
| segmento | text | tipo de negócio (ex.: salão, academia, barbearia) — usado pra política de não-concorrência (não mostrar anunciante concorrente do próprio host) e pra segmentação por categoria |
| responsavel_nome / responsavel_contato | text | contato (WhatsApp) de quem decide pelo estabelecimento |
| aceitou_termos_em | timestamptz nullable | quando o candidato a ponto aceitou os termos (modelo de comodato) no formulário público — sem isso o cadastro fica incompleto |
| aparelho_id | text unique | identificador do TV Box instalado |
| valor_pago_mensal | numeric | 0 por padrão (oferta padrão é só cota, sem os R$50 — ver módulo 5) |
| cota_autoanuncio_slots_hora | int | quantos slots/hora reservados pro host |
| horario_abertura / horario_fechamento | time | define a janela de exibição e a base do pacing |
| status | enum: lead, aguardando_instalacao, ativo, inativo | `lead` = empresa se candidatou pelo site público (módulo 7), ainda não é ponto confirmado |
| ultima_vez_online | timestamptz nullable | atualizado pelo player (módulo 4), alimenta o alerta do módulo 5 |
| created_at | timestamptz | |

**Rotas**
- `POST /admin/pontos` — cria ponto (admin only)
- `PATCH /admin/pontos/:id` — edita, inclusive mudar status (`lead` → `aguardando_instalacao` → `ativo`)
- `GET /admin/pontos` — lista com status (admin, todos os campos)
- `GET /pontos` — **pública**, sem autenticação: só pontos com `status=ativo`,
  só campos seguros (nome, cidade, endereço, foto — nunca
  responsavel_contato). Alimenta a página "onde estamos" do módulo 7.

**Efeito colateral de `ativo`:** quando um ponto muda para `ativo`, dispara
`ativarCoberturaDosAnunciantes(pontoId)` (módulo 6) — anunciantes que
pagaram mas estavam esperando esse ponto entrar no ar começam a contar a
partir de agora, não da data do pagamento.

**Critério de aceite:** dá pra cadastrar os 3 pontos iniciais (salão, academia,
barbearia) com cidade = Matão, status `aguardando_instalacao`, e mudar pra
`ativo` manualmente. Um lead criado pelo formulário público aparece na fila do
admin com status `lead`.

---

## Módulo 2 — Anunciantes (base, sem dependências)

**Entidade `anunciantes`**

| Campo | Tipo | Obs |
|---|---|---|
| id | serial PK | |
| nome_empresa | text | razão social ou nome fantasia |
| cpf_cnpj | text | CNPJ da empresa (Vitrina é B2B) — vira o `pagador.documento` do San Checkout e o tomador da nota fiscal |
| responsavel_nome / responsavel_cpf / responsavel_email / responsavel_telefone | text, todos nullable | opcional — pessoa física responsável pela empresa, ponto de contato humano pra assuntos de anúncio; não é usado no `pagador` do checkout |
| endereco / cidade / uf / cep | text | obrigatório — é o que vai na nota fiscal de serviço (módulo 6); sem isso não dá pra faturar |
| contato_email / contato_telefone | text | também é o login |
| senha_hash | text | cadastro é self-service (módulo 7), `bcrypt` — mesmo mecanismo do login admin, sem lib nova |
| status | enum: pendente_aprovacao, aprovado, aguardando_ponto, ativo, suspenso | `aguardando_ponto` = pagou, mas nenhum ponto coberto pelo plano está `ativo` ainda (ver 6.x) |
| plano_id | text FK → planos (módulo 6) | nulo até fechar um plano |
| data_inicio_cobertura | date nullable | setada só quando sai de `aguardando_ponto` pra `ativo` — é daqui que `data_expiracao` é calculada, não da data do pagamento |
| data_expiracao | date nullable | até quando a cobertura vale; editável manualmente pelo admin (bônus avulso, cortesia) |
| aceitou_termos_em | timestamptz nullable | aceite da política de conteúdo (o que a Vitrina recusa exibir — Parte 7 do plano) no cadastro público; cadastro sem isso fica incompleto |
| created_at | timestamptz | |

**Entidade `criativos`**

| Campo | Tipo | Obs |
|---|---|---|
| id | serial PK | |
| anunciante_id | FK | |
| arquivo_original_url | text | o que o anunciante mandou |
| arquivo_normalizado_url | text | saída do ffmpeg (1080×1920) |
| editado_pelo_operador | boolean default false | true quando o operador substitui (módulo 5) |
| status | enum: pendente, aprovado, reprovado | |
| duracao_segundos | int | |
| created_at | timestamptz | |

**Normalização automática (`src/lib/ffmpeg.js`)** — chamada assim que o
upload termina, antes de entrar na fila de aprovação:
- Detecta orientação/proporção do arquivo de entrada
- Se já for 1080×1920 (ou proporção 9:16), só recodifica pro padrão
- Se vier horizontal, gera vídeo de saída 1080×1920 com o conteúdo
  centralizado e o fundo preenchido por uma cópia do mesmo vídeo, ampliada e
  desfocada (`boxblur`), via um único comando ffmpeg com filtro
  `scale+crop+overlay` (ver Parte 4.5 do plano de negócio)
- Gera thumbnail (frame do meio) pro dashboard
- ffmpeg processa em arquivo temporário local (`/tmp`, some no próximo
  deploy, não tem problema); o vídeo normalizado e o thumbnail resultantes
  sobem pro bucket `criativos` do Supabase Storage — `arquivo_normalizado_url`
  grava a URL pública do Storage, não um caminho de disco
- **Perfil de saída fixo** (`-c:v libx264 -profile:v main -pix_fmt yuv420p
  -b:v 4M -c:a aac`): todo anúncio normalizado sai no mesmo codec/bitrate,
  não importa o que o anunciante mandou. É isso que "homologa" cada anúncio
  pra rodar em qualquer TV Box da rede — H.264 a 4Mbps decodifica em hardware
  em qualquer aparelho Android homologado dos últimos anos, sem engasgar; um
  formato mais pesado (H.265, bitrate alto, 4K) arrisca travar em GPU fraca
  de caixinha de R$200. Validado uma vez no ponto piloto (Fase 0), vale pra
  todo anúncio depois — não é um teste por anúncio.

**Rotas**
- `POST /anunciantes/cadastro` — cadastro público self-service (empresa cria a
  própria conta com `senha_hash`), status inicial `pendente_aprovacao`
- `POST /anunciantes/login` — sessão própria (`express-session`), separada da
  sessão do admin
- `POST /anunciantes/:id/criativos` — upload (multipart, autenticado como o
  próprio anunciante), dispara normalização
- `GET /anunciantes/:id/exibicoes` — dashboard do anunciante (ver módulo 7)
- `GET /admin/criativos?status=pendente` — fila de aprovação
- `PATCH /admin/criativos/:id` — aprova/reprova/substitui arquivo (módulo 5)

**Critério de aceite:** subir um vídeo horizontal de teste e confirmar que o
`arquivo_normalizado_url` resultante é 1080×1920 sem cortar o conteúdo
original.

---

## Módulo 3 — Playlist e Pacing (depende de 1, 2)

**Entidade `exibicoes_contador`** (contador de pacing)

| Campo | Tipo | Obs |
|---|---|---|
| id | serial PK | |
| anunciante_id | FK | |
| ponto_id | FK | |
| janela_hora | timestamptz truncado na hora | chave de agregação |
| vezes_programadas | int | quanto foi colocado na playlist dessa hora |
| vezes_confirmadas | int | quanto o player realmente reportou (proof of play, módulo 4) |

**`src/lib/pacing.js` — função central**

```
gerarPlaylistDaHora(pontoId, hora):
  1. lista anunciantes ativos com plano vigente
  2. pra cada um, calcula repeticoes = frequencia_do_plano + deficit_da_hora_anterior
  3. embaralha a ordem
  4. soma slots ocupados; se sobrar espaço (< total_slots_hora do ponto),
     preenche na ordem: cota do host → institucional Vitrina → campanhas
     San & Co. (Trimundi9 etc, quando houver)
  5. grava a playlist como JSON e os `vezes_programadas` em exibicoes_contador
```

Trava de segurança (Parte 2.5 do plano): recusa nova assinatura nesse ponto
quando a soma de slots programados passar de 200 de 240 por hora.

**Rotas**
- `GET /playlist/:pontoId` — pública, sem autenticação (consumida pelo player,
  não por humano — mesmo padrão do contrato do San Checkout pra rota de
  pedido)

**Critério de aceite:** com 2 anunciantes de teste em frequências diferentes
rodando por 3 horas seguidas, o contador de compensação corrige quem ficou
devendo na hora seguinte (teste automatizado em `pacing.test.js`).

---

## Módulo 4 — Player (depende de 3)

**`public/player.html`** — página estática, sem framework:
- Abre em tela cheia (`?ponto=ID` na URL, uma por aparelho)
- Rotação de 90° via CSS (`transform: rotate(90deg)` no container, já que o
  painel físico continua 1920×1080 — ver Parte 4.4/3.4 do plano)
- Busca `GET /playlist/:pontoId` a cada 15 minutos; se mudou, baixa os
  arquivos novos antes de trocar a lista em memória
- Toca a playlist já baixada em loop, mesmo sem internet
- A cada item tocado, dispara `POST /player/:pontoId/played` (proof of play,
  fire-and-forget — se falhar, não trava a exibição)
- A cada 5 minutos, faz `POST /player/:pontoId/heartbeat` — atualiza
  `ultima_vez_online` do ponto (módulo 1)

**Rotas**
- `POST /player/:pontoId/played` — incrementa `vezes_confirmadas`
- `POST /player/:pontoId/heartbeat`

**Critério de aceite:** testado num TV Box real (Fase 0 do plano) — liga
sozinho, sobrevive a queda de energia, mantém a rotação vertical correta.

---

## Módulo 5 — Admin (depende de 1, 2, 3)

Painel único, autenticado (login simples, um usuário admin por enquanto):

- Fila de aprovação de criativos (aprovar / reprovar / **substituir arquivo**
  — o operador sobe sua própria versão editada, ver Parte 3.5 do plano)
- Cadastro/edição de pontos e anunciantes
- **Painel de margem**: receita (soma de assinaturas ativas) − custo de
  pontos (Σ `valor_pago_mensal`) − amortização de hardware (constante
  configurável, R$44,44/ponto/mês por padrão)
- **Alerta de ponto offline**: lista pontos cujo `ultima_vez_online` passou
  de N horas (configurável, default 2h)
- Fila de aprovação de afiliado novo (aprova/reprova, ajusta
  `comissao_percentual`) + visão de quem trouxe quem e comissão a pagar
  (módulo 6)

**Critério de aceite:** aprovar um criativo pendente muda seu status e ele
aparece na próxima geração de playlist do módulo 3.

---

## Módulo 6 — Financeiro / San Checkout (depende de 2)

**Entidade `planos`** (catálogo fixo, id = `planoId` do contrato San Checkout —
cada combinação tier × permanência mínima é uma linha própria, ex.:
`essencial-3m`, `essencial-6m`, `destaque-12m`)

| Campo | Tipo | Obs |
|---|---|---|
| id | text PK | ex.: `essencial-3m` |
| tier | enum: essencial, destaque, maximo | pra agrupar as linhas de um mesmo tier na tela de planos |
| nome | text | |
| valor_mensal | numeric | o que é cobrado de fato, por mês |
| valor_mensal_cheio | numeric nullable | preço mensal "cheio" (sem desconto de permanência) só pra exibir riscado no site; não afeta cobrança |
| compromisso_meses | int | permanência mínima assumida (1/3/6/12) — cobrança sempre no ciclo nativo da Asaas correspondente (`MONTHLY`/`QUARTERLY`/`SEMIANNUALLY`/`YEARLY`, ver módulo 6/`INTEGRACAO.md` 6.1), cobrando `valor_mensal × compromisso_meses` de uma vez por ciclo — não é "cobrança sempre mensal com desconto cosmético" |
| frequencia_dia | int | vezes que o anúncio entra na playlist por dia (módulo 3 recalcula por ponto a partir daqui) |
| cobertura | enum: um_ponto_dia, tres_pontos_dia, todos_pontos | |
| ativo | boolean default true | plano fora do ar não aparece pra novo cadastro, mas quem já assina continua no preço — é assim que se aposenta uma promoção ou se restringe ciclo (ver regra de fundador abaixo) |

**Regra de fundador:** durante a fase de captação inicial, as linhas de ciclo
`mensal` ficam com `ativo=false` nos três tiers — só dá pra fechar
trimestral/semestral/anual. Motivo: o relógio de cobertura de quem assina
antes do primeiro ponto ir ao ar só começa a contar quando o ponto liga (ver
`data_inicio_cobertura` no módulo 2), então cobrança mensal não faz sentido
nessa fase. Quando a rede sai do modo fundador, o admin ativa as linhas
`mensal` — não precisa mexer em código, é um `UPDATE` no campo `ativo`.

**`ativarCoberturaDosAnunciantes(pontoId)`** — chamada pelo módulo 1 quando um
ponto vira `ativo`: busca anunciantes com `status=aguardando_ponto` cujo plano
cobre esse ponto, muda status pra `ativo`, seta `data_inicio_cobertura=hoje` e
calcula `data_expiracao = hoje + duração do ciclo + meses_bonus`.

**Entidade `afiliados`**

| Campo | Tipo | Obs |
|---|---|---|
| id | serial PK | |
| nome | text | |
| cpf | text | identificação de quem recebe a comissão |
| chave_pix | text | sem isso o cadastro fica incompleto — é pra onde a comissão é paga de verdade; pode ser o próprio CPF, e-mail ou telefone, o afiliado escolhe |
| telefone | text | WhatsApp |
| email | text unique | também é o login |
| senha_hash | text | cadastro self-service (módulo 7), mesmo `bcrypt` dos outros dois logins |
| status | enum: pendente_aprovacao, aprovado, inativo | quem se cadastra sozinho começa `pendente_aprovacao` — envolve dinheiro de comissão, então não fica ativo sem o admin aprovar |
| codigo_cupom | text unique | gerado automático no cadastro (nome + número), admin pode editar depois |
| comissao_percentual | numeric | entre 10 e 30, padrão 10-15 pra novo afiliado (Parte 2.7) — só o admin edita, nunca o próprio afiliado |
| aceitou_termos_em | timestamptz nullable | aceite das regras de comissão no cadastro público |

**Rotas do afiliado**
- `POST /afiliados/cadastro` — cadastro público self-service, status inicial
  `pendente_aprovacao`
- `POST /afiliados/login` — sessão própria (terceira, além de admin e
  anunciante)
- `GET /afiliado/painel` (autenticado) — código do cupom/link de indicação,
  % de comissão, lista de anunciantes trazidos (via `codigo_cupom` na
  assinatura) com status, e o total comissionado — tudo lido de `comissoes`,
  sem tabela nova
- `PATCH /admin/afiliados/:id` — aprova/reprova, edita `comissao_percentual`
  (módulo 5)

**Entidade `comissoes`** — uma linha por pagamento confirmado, pra auditoria
e pro dashboard do próprio afiliado:
`afiliado_id, anunciante_id, valor_confirmado, comissao_valor, criado_em`.

**Entidade `cobrancas_confirmadas`** — uma linha por ciclo cobrado, é o
histórico de pagamento que aparece no dashboard do anunciante (módulo 7) e a
fonte da nota fiscal/e-mail:

| Campo | Tipo | Obs |
|---|---|---|
| id | serial PK | |
| anunciante_id | FK | |
| plano_id | FK | |
| valor | numeric | valor confirmado no webhook (nunca o do client) |
| criado_em | timestamptz | |
| nota_fiscal_status | enum: pendente, emitida | ver abaixo — emissão é manual nesta fase |
| nota_fiscal_url | text nullable | link do PDF depois de subido pelo admin |
| drive_file_id | text nullable | id do arquivo no Google Drive, depois do upload automático |
| email_confirmacao_enviado_em | timestamptz nullable | |

**Integração San Checkout (contrato já existe em `INTEGRACAO.md`, sem nada a
inventar):**
- `GET /plano/:planoId` — autenticado por `X-Checkout-Key`, devolve os campos
  do contrato (`planoId, nome, valor, ciclo, pagador`); `ciclo` vem do
  compromisso do plano (`MONTHLY`/`QUARTERLY`/`SEMIANNUALLY`/`YEARLY`) e
  `valor` já é o valor cheio do período — a Asaas cobra esse ciclo sozinha
  pra sempre, sem reconsultar; `pagador.documento` é o CNPJ da empresa
  (ver `claude/vitrina-san-checkout-requisitos.md`)
- `POST /webhook/san-checkout` — recebe `criada`, `cobranca_confirmada`,
  `cobranca_falhou`, `cobranca_estornada`, `cancelada`; em
  `cobranca_confirmada`: grava linha em `cobrancas_confirmadas`, muda
  `anunciantes.status` pra `ativo` (ou `aguardando_ponto`, ver módulo 2/1),
  grava a comissão do afiliado (se houver `codigo_cupom` associado), **envia
  o e-mail de confirmação**
- `POST /cancelar-assinatura` — proxy pro endpoint do San Checkout, nunca o
  anunciante cancela direto no checkout

**Nota fiscal e e-mail de confirmação (`INTEGRACAO.md`, seção 4: "o San
Checkout não emite nota fiscal nem manda e-mail — é responsabilidade do seu
projeto, disparado pelo `cobranca_confirmada`"):**

- **E-mail de confirmação** — automático. `nodemailer` via SMTP, remetente
  `vitrina@sancocore.com.br` (`.env`: `SMTP_HOST/PORT/USER/PASS`,
  `VITRINA_EMAIL_FROM`). Dispara direto no handler do webhook, fire-and-forget
  (se falhar, não trava a ativação — fica registrado
  `email_confirmacao_enviado_em = null` pra reenviar manualmente depois).
- **Nota fiscal — manual nesta fase.** Emitir NFS-e de verdade exige
  integração com o sistema da Prefeitura de Matão (ou um serviço tipo Focus
  NFe/eNotas) amarrado ao CNPJ da ME — é projeto próprio, não uma chamada de
  API simples, e depende da ME já estar aberta (Parte 6.5 do plano). Pra não
  travar o lançamento nisso: o admin emite a nota pelo canal que já usa
  (contador/portal da prefeitura) e sobe o PDF em
  `PATCH /admin/cobrancas/:id/nota-fiscal` (multipart) — o sistema then faz
  upload automático desse PDF pro Google Drive (ver abaixo) e marca
  `nota_fiscal_status=emitida`.
  `ponytail:` emissão manual é o teto aceitável enquanto o volume for baixo;
  automatizar quando o número de notas/mês justificar o custo da API de NFS-e.
- **Google Drive** — todo PDF de nota fiscal subido é automaticamente
  enviado, via `googleapis` (conta de serviço), pra uma pasta fixa
  `Comprovantes/Vitrina/` no Drive do workspace San & Co.
  (`.env`: `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`).

**Critério de aceite:** um webhook de teste com `status: cobranca_confirmada`
muda o anunciante pra ativo (ou `aguardando_ponto`, se nenhum ponto coberto
estiver no ar), cria a linha em `cobrancas_confirmadas`, dispara o e-mail de
confirmação, e, se tiver cupom de afiliado, cria a linha em `comissoes` com o
valor percentual certo.

---

## Módulo 7 — Site Público (depende de 1, 2, 3, 6)

Esta é a cara pública da empresa — o jeito de uma empresa que **ainda não foi
contatada** chegar até a Vitrina sozinha, seja pra anunciar ou pra virar
ponto. Sem isso o software é só um back-office; com isso, é o canal de
aquisição.

- `GET /` — institucional (quem é a Vitrina, por que anunciar, CTA triplo:
  "quero anunciar" / "quero ser um ponto" / "quero ser vendedor")
- `GET /planos` — lista `planos` com `ativo=true`, agrupados por `tier`, preço
  riscado quando houver `valor_riscado`; botão de assinar leva pro link do
  San Checkout (`?c=contratante_id&assinatura=planoId`)
- `GET /pontos` — reusa a rota pública do módulo 1: onde a rede está hoje
  (nome, cidade, endereço, foto)
- `GET/POST /anunciantes/cadastro`, `GET/POST /anunciantes/login` — reusam as
  rotas do módulo 2
- `GET /anunciante/painel` (autenticado) — escolhe plano → San Checkout;
  upload de criativo; status de aprovação; **dashboard de exibições**:
  - total confirmado no período (soma de `vezes_confirmadas` do módulo 3)
  - quebra por ponto (nome, cidade, quantas vezes)
  - quebra por dia
  - programado vs. confirmado (% de entrega — transparência)
  - plano atual, valor, `data_expiracao`
  - **custo por exibição**: `valor do plano ÷ total confirmado no período`
  - histórico de pagamento (`cobrancas_confirmadas` do módulo 6)

  Nenhum dado novo pra guardar — é tudo leitura agregada de tabelas que já
  existem nos módulos 1, 2, 3 e 6.

- `GET/POST /seja-um-ponto` — formulário público pra empresa que quer virar
  ponto. Cria uma linha em `pontos` com `status='lead'` (módulo 1) — cai
  direto na fila do admin, sem tabela nova.
- `GET/POST /afiliados/cadastro`, `GET/POST /afiliados/login`,
  `GET /afiliado/painel` — reusam as rotas do módulo 6: cadastro de vendedor
  self-service, e o painel dele mostra cupom, comissão e quanto já
  comissionou

**Critério de aceite:** uma empresa que nunca foi contatada consegue, sozinha,
sem falar com o admin: ver os planos, se cadastrar, assinar via San Checkout,
subir o criativo, e depois de aprovado ver no próprio painel quantas vezes o
anúncio rodou e quanto está pagando por exibição. Um vendedor novo se
cadastra sozinho, espera aprovação do admin, e depois de aprovado vê no
próprio painel o cupom, a comissão e quem ele já trouxe.

---

## Ordem de construção (primeira leva)

1. Módulo 1 (pontos) + Módulo 2 (anunciantes, sem o ffmpeg ainda — só CRUD)
2. `src/lib/ffmpeg.js` (normalização) plugado no upload do módulo 2
3. Módulo 3 (playlist + pacing) — é a peça de maior risco de lógica
4. Módulo 4 (player) — testado num TV Box real antes de ir pra frente
5. Módulo 5 (admin básico: aprovação + cadastros)
6. Módulo 6 (San Checkout + e-mail + nota fiscal + Drive) — pode entrar em
   paralelo a qualquer momento depois do módulo 2 existir
7. Módulo 7 (site público) — depende de 1, 2, 3 e 6 já existirem; é o último
   porque precisa de dado real (planos, pontos, exibições) pra ter o que
   mostrar

Isso é literalmente "o básico" que dá pra começar agora: passos 1 e 2.
