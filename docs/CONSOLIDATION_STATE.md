# Estado da consolidação final — Mostraí

Arquivo curto de retomada. Não é diário: só o necessário para outra sessão
continuar com segurança.

## Fase atual
Checkpoint **H (legado)** implementado localmente, `npm run check` 385/385,
e2e 01/02/04/06/07 verdes — em commit/PR. Próximo: F (site público), I
(polimento), J (E2E online), K (Access + smoke + relatório).

## Último commit / deploy
- MostrAi `main` = **`89d73d4`** (PR #50, G+E) — deployed SHA no Northflank
  `mostrai/mostrai` (2 instâncias), `/health` ok, cache purgado. Antes:
  `63952fb` (PR #49, C+D). Branch de trabalho `claude/busy-noether-hheir2`.
- Migrations em produção: até **089** (constraint `assinaturas_status_check`
  confirmada com `pendente_pagamento`). Nenhuma migration nova em H.
- Player (`sancompany/Playlist.MostrAi`): `28bc93d` (main).
- San Checkout (`sancompany/san_checkout`): `f7b1cb9`, `ASAAS_AMBIENTE=sandbox`
  — NÃO virar para produção sem gate explícito do dono.
- Baseline `npm run check` na main: 385/385; lint 14 avisos (baseline era 16).

## Ambiente
- Banco: Supabase `wnbztsprmzarexnncchg`. Jobs Northflank: `conciliacao`
  (0 9 * * * UTC), `backup` (0 8 * * 0).
- Cloudflare Access: LIGADO (policy "Somente o operador" nas duas apps,
  `/admin` → 302 sem cookie). Nenhum bypass criado.
- Produção (leitura, 24/09 ~17:50 UTC): 0 vendedores, 0 comissões, 0 contas
  com papel vendedor; 1 convite aberto (#2, papéis `['vendedor']`, expira
  29/09) — se usado, cria conta só-anunciante (papel filtrado no cadastro);
  16 benefícios; 3 planos arquivados; 1 cortesia; 3 planos_administrativos;
  1 assinatura ativa, 0 pendentes.

## Concluído nesta consolidação
- A inventário (8/12 domínios, `scratchpad/inventario-dominios.json`).
- C/backend + D/Player (PR #49): status canônico do ponto, candidatura→ponto
  numa função, e-mail lower/trim, anonimização 60 dias, `dispositivoId`
  5 dígitos, Preparar Player, PIN auditado, ficha da Tela em 7 blocos.
- G/Checkout (PR #50): assinatura nasce `pendente_pagamento` (migration
  089), `criada` deduplica sem chargeId, valor do ciclo = `valorCobrado`,
  conciliação não duplica, cancelar 404 limpo, link pendente reaproveitado
  24 h, `payment.updated` pro admin.
- E/admin (PR #50): `plano_vigente`/`situacao_exibicao` decididos no
  servidor, aba "Eventos do Checkout", SSE em todas as abas, swap atômico de
  criativo, ficha do Ponto sem PK.
- H/legado (esta branch): vendedor, grade antiga de planos, benefícios,
  liberar-plano, custos-fixos → 410 + código removido (detalhe em
  `.ia/HANDOFF.md`); ~1.100 linhas de renderers mortos do admin e CSS
  legado removidos; e2e 02/06/07 atualizados; docs/api.md, funcional.md,
  teia.md, .ia/* ajustados.

## Item atual
- Commit H → PR → CI → merge → deploy (sem migration) → validar online
  (health, 410 nas rotas aposentadas, admin abre).

## Próximos
- F (site: textos, 401 em página pública, CSP/analytics; comodato.html §3 =
  decisão), I (polimento: banco de horas por poll, ocupação, vigência UTC ×
  Matão), J (E2E online com bypass controlado do Access; matriz do Checkout
  no sandbox), K (Access restaurado + smoke + relatório de 19 seções).

## Decisões aplicadas nesta rodada (reversíveis, registrar no relatório)
- Estado "Aguardando primeiro sinal" no ponto; número da tela = menor livre.
- Fluxo antigo de chave aposentado; excluir tela com exibição → 409; PIN
  revelável auditado; token de provisionamento só no backend.
- Assinatura nasce pendente; entitlement só pelo backend.
- Vendedor removido do código (produção sem dado vivo); grade antiga de
  planos e catálogo de benefícios sem escrita pela API (texto de benefício
  agora só por SQL); `liberar-plano` → 410 (cortesia = crédito ou
  `plano-administrativo`); custos fixos sem CRUD (resumo ainda soma).

## Decisões necessárias (do dono)
- comodato.html §3 (texto jurídico) — PENDENCIAS J.1.
- Existe TV V1 (player web) em campo além da tela 1? Se não: aposentar
  public/player.html + auth por PK.
- Convites e `POST /admin/anunciantes`: manter ou 410. Revogar o convite #2
  (vendedor, aberto em produção)?
- Textos dos benefícios da vitrine: voltar a ter tela ou ficar por SQL.
- Confirmação de e-mail como portão do backend; consentimento de novidades.
- Promoção com prazo: preço sobe na Asaas ao vencer ou é vitalícia.
- Banco de horas: manter (cron + tela) ou aposentar.
- Teto de cadastro de criativos: 3 fixos ou limite do plano.
- Termos de uso §6 / política de privacidade ainda descrevem vendedor.

## Bloqueios reais
- Nenhum.
