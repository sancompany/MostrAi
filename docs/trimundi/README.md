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
- `pendencias.md` — o que falta, e o que só o dono faz
- `proximas-versoes.md` — o que fica para depois
- `erros/` — os erros vividos na Trimundi (a pasta nasce no primeiro)

## Classificação
Porte: produto externo, com cliente pagante · Dado: financeiro, documento
(CPF), senha (operador) · Vida útil: anos → **rigor no topo da escala**.
É projeto, não estrutura (os quatro testes estão no spec, §6). O banco é
**próprio**, nunca o da Mostraí.

## Estado na esteira
Estação atual: **4 — Contratos**, aberta em 09/11/2026.
- **1 Escopo, 2 Fronteiras e 3 Fundação:** escritas na Etapa 0. Fecham com
  o commit dela e o CI verde, no PR da branch `claude/beautiful-faraday-cjq1nt`.
  Evidência: o spec (1), o spec §6 (2), e o repositório com segredo fora do
  código, o CI, este índice e o `RUNBOOK.md` §11 (3).
- **Falta para fechar a 4:** D1 e D2 (`pendencias.md`) e as migrations do
  banco próprio aplicadas em banco limpo (Etapa 1).
- **Próxima:** 5 — Construção (Etapas 2 a 8), com esforço alto.

## Mapa de caminhos
Os caminhos nascem nas etapas indicadas; antes disso, não existem.
- **Código:** `src/trimundi/`, com banco em `src/trimundi/db/` e migrations
  em `src/trimundi/db/migrations/` (Etapa 1).
- **Telas do Admin:** `public/admin/trimundi.js` e `trimundi.css`, no
  módulo `trimundi` do menu, rótulo "Eventos" (Etapa 2).
- **Páginas do operador:** `src/trimundi/paginas/`, com scripts em
  `public/ticket/` (Etapa 7).
- **Testes:** `tests/trimundi-*.test.js` (Etapa 1).
- **Variáveis:** `.env.example`, bloco Trimundi (Etapa 1).

## Fronteira com a Mostraí
- **Prefixo `trimundi`** em rota, arquivo e módulo. "Eventos", "operador" e
  `/admin/eventos` já significam outra coisa na Mostraí (spec §6 e
  `api.md`).
- **Nada de tabela cruzada.** Um lado só chama a função do módulo dono do
  dado.
- **A única rota da Mostraí que muda** é `POST /anunciantes/login`
  (`api.md`).

## Pendências que bloqueiam a esteira
- D1 (métrica de sucesso) e D2 (prazos de retenção): confirmação do dono,
  com proposta em `pendencias.md`.
