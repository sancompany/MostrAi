# Trimundi

Ticketeira da San & Co. É um **projeto próprio**, hospedado no repositório
e na aplicação da Mostraí por decisão do dono (09/11/2026), e segue as leis
do plugin `san-co`. Esta pasta é a porta de entrada da Trimundi; o
`CLAUDE.md` da raiz continua sendo o da Mostraí.

## Antes de propor ou escrever qualquer coisa, leia
- `CONSTRAINTS.md` — o que a Trimundi NÃO faz, as regras duras e os limites
- `specs/2026-11-09-trimundi-fundacao.md` — por que existe, escopo,
  classificação, contrapontos e decisões
- `funcional.md` — o que o sistema faz, tela por tela
- `modelo-de-dados.md` — tabelas, travas e invariantes do banco próprio
- `api.md` — o mapa das rotas
- `inventario-de-dados.md` — que dado de pessoa existe aqui (LGPD)
- `STATUS-IMPLEMENTACAO.md` — o que já funciona, com teste, e o que depende de fora
- `pendencias.md` — o que falta, e o que só o dono faz
- `proximas-versoes.md` — o que fica para depois
- `erros/` — os erros vividos na Trimundi (a pasta nasce no primeiro)

## Escopo e marca (decisões do dono, 09/11/2026 — escopo simplificado)
- **Marca Trimundi, experiência independente.** A logo enviada pelo dono
  (`public/ticket/img/`) é a marca oficial; nenhuma página pública, conta
  ou login de operador leva à Mostraí. O Admin continua no `/admin` dela.
- **O que existe, e só isso:** página do evento (banner, data, local,
  descrição, card com lotes, preço, disponibilidade e benefício, botão de
  compra); conta do cliente (nome, CPF, e-mail, senha; e-mail confirmado
  antes de comprar; ingressos, QR e link de indicação); benefício por lote
  com quantidade e entrega única na portaria; indicação (link, conversão
  paga, recompensa por campanha); operadores criados só pelo Admin, com
  login próprio e check-in.
- **Eventos são criados no site**, pelo Admin (Eventos → Criar evento). TREEMUNDO
  é um evento, não uma empresa; nenhum evento vem pronto no código.

## Classificação
Porte: produto externo, com cliente pagante · Dado: financeiro, documento
(CPF), senha (operador e cliente) · Vida útil: anos → **rigor no topo da
escala**. É projeto, não estrutura (os quatro testes estão no spec, §6). Os
dados ficam no **esquema `trimundi`** do banco da Mostraí, nunca no `public`
(exceção registrada em `CONSTRAINTS.md`).

## Estado na esteira
Estação atual: **5 — Construção**, aberta e com o escopo da v1 construído em
09/11/2026 (Etapas 1 a 6). Detalhe em `STATUS-IMPLEMENTACAO.md`.
- **1 a 3:** fechadas com o commit `fc13b5c` (Etapa 0) e o CI verde.
- **4 — Contratos:** fechada em 09/11/2026 — D1 e D2 aprovadas, migrations
  aplicadas em banco limpo com o teste de RLS verde.
- **5 — Construção:** código, telas e testes da v1 prontos na branch
  `claude/beautiful-faraday-cjq1nt`. Falta a homologação do dono (aparelho
  real, Checkout de teste) e as decisões de `pendencias.md`.
- **Próxima:** 6 — Prontidão (banco, Storage, e-mail e contratante de
  produção; backup; revisão jurídica) — só com autorização e custos
  apresentados antes.

## Mapa de caminhos
- **Código:** `src/trimundi/` — `index.js` (entrada), `rotas/` (admin,
  operador, conta, público), um arquivo por assunto (`eventos`, `catalogo`,
  `promocoes`, `pedidos`, `pagamentos`, `emissao`, `reembolsos`,
  `participantes`, `operadores`, `checkin`, `clientes`, `indicacao`,
  `retencao`), `checkout/`
  (contrato com o San Checkout), `lib/` (validação, códigos, QR, chaves).
- **Banco:** `src/trimundi/db/` e migrations em `src/trimundi/db/migrations/`.
- **Telas do Admin:** `public/admin/trimundi.js` e `trimundi.css`, no
  módulo `trimundi` do menu, rótulo "Eventos".
- **Páginas públicas e do operador:** modelos em `src/trimundi/paginas/`,
  scripts e estilo em `public/ticket/`.
- **Testes:** `tests/trimundi-*.test.js` (esquema `trimundi` do banco de
  teste da Mostraí, faixa de IP própria 100.64/10).
- **Variáveis:** `.env.example`, bloco Trimundi.

## Fronteira com a Mostraí
- **Prefixo `trimundi`** em rota, arquivo e módulo. "Eventos", "operador" e
  `/admin/eventos` já significam outra coisa na Mostraí (spec §6 e
  `api.md`).
- **Nada de tabela cruzada.** Um lado só chama a função do módulo dono do
  dado.
- **Nenhuma rota da Mostraí muda.** O login de operador (`/ticket/entrar`)
  e o de cliente (`/ticket/conta`) são da Trimundi; `POST /anunciantes/login`
  voltou a ser o da `main`. Da Mostraí, só a aba "Eventos" do Admin.

## Pendências que bloqueiam a esteira
- Homologação do dono e as decisões abertas em `pendencias.md` ("Decisões
  do dono desta execução").
- Para produção: tudo de "Antes de dado real" em `pendencias.md`.
