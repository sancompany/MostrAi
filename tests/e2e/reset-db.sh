#!/bin/bash
PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -qc "TRUNCATE criativos, comissoes, exibicoes_contador, cobrancas_confirmadas, eventos_assinatura_pendentes, assinaturas, pontos, tokens_senha, webhooks_processados, vendedores, dispositivos, convites, candidaturas, anunciantes, session, tentativas_acesso, promocoes, promocoes_itens RESTART IDENTITY CASCADE;"
# Comunicados (migration 108): o texto não aponta pra conta, então o CASCADE
# acima não o alcança — e um comunicado igual nas últimas 24 h é barrado.
PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -qc "TRUNCATE comunicados RESTART IDENTITY CASCADE;"
# Inbox do webhook (migration 096): a chave é o `eventoId`, e os roteiros
# usam ids fixos (02: ev-1/ev-2/ev-3). Sem limpar, da segunda rodada em diante
# o evento era tido como reentrega — 200 sem processar nada.
PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -qc "TRUNCATE webhooks_recebidos RESTART IDENTITY;"
PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -qc "UPDATE planos SET vagas=NULL, desconto_comodato_percentual=NULL; UPDATE planos_ponto SET plano_bonus_id=NULL, plano_bonus_apos_meses=NULL, plano_bonus_meses=NULL;"
# Plano de fixture do 09-rede-redesenho.mjs: fica ATIVO no catálogo e, com o
# mesmo tier/ciclo do Essencial mensal, embaralhava buscarPlanoAtivoDoTier nos
# testes de unidade (tests/indicacoes.test.js) rodados depois do e2e.
PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -qc "DELETE FROM planos WHERE id = 'plano-teste-e2e-rede';"
rm -f "$(cd "$(dirname "$0")" && pwd)/saida/emails.jsonl"
# Categorias de fixture do 28-concorrentes-diretos.mjs (grupo "E2E"): as contas
# e pontos que as usavam já saíram no TRUNCATE acima; os pares vão junto
# (categorias_concorrentes, ON DELETE CASCADE).
PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -qc "DELETE FROM categorias WHERE grupo = 'E2E';"
