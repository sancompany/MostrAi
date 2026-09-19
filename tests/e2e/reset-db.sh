#!/bin/bash
PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -qc "TRUNCATE criativos, comissoes, exibicoes_contador, cobrancas_confirmadas, eventos_assinatura_pendentes, assinaturas, pontos, tokens_senha, webhooks_processados, vendedores, dispositivos, convites, candidaturas, anunciantes, session, tentativas_acesso RESTART IDENTITY CASCADE;"
PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -qc "UPDATE planos SET vagas=NULL, desconto_comodato_percentual=NULL; UPDATE planos_ponto SET plano_bonus_id=NULL, plano_bonus_apos_meses=NULL, plano_bonus_meses=NULL;"
