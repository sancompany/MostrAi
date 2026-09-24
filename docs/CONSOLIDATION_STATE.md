# Estado da consolidação final — Mostraí

Arquivo curto de retomada. Não é diário: só o necessário para outra sessão
continuar com segurança.

## Fase atual
Checkpoint **I (polimento), parte 2** implementado localmente — em
commit/PR. I-1 mergeado (PR #52 → `08ea4e8`). Próximo: J (E2E online com
bypass controlado), K (Access + smoke + relatório).

## Último commit / deploy
- MostrAi `main` = **`1411abd`** (PR #51, H+F) — deployed SHA no Northflank
  `mostrai/mostrai` (2 instâncias), `/health` ok, cache purgado. Antes:
  `89d73d4` (PR #50, G+E), `63952fb` (PR #49, C+D). Branch de trabalho
  `claude/busy-noether-hheir2` (rebaseada sobre `main` a cada merge —
  squash na origem; push `--force-with-lease` só nesse caso).
- Migrations em produção: até **089** (constraint `assinaturas_status_check`
  confirmada com `pendente_pagamento`). Nenhuma migration nova em H/F/I.
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

- F/site (PR #51): convite sem Pix/vendedor; site conferido sem
  Inicial/Básico/R$ 50; `/conta/sessao` já evita 401; CSP em vigor; sem
  analytics. Legal (Termos §6, Política, comodato §3) = decisão do dono.
- I/polimento parte 1 (esta branch): **régua única de vigência**
  (`src/lib/vigencia.js`, RN-32-B: último dia inclusivo em Matão — gerador,
  planoVigenteId, cotação, conciliação, admin, jobs de benefício);
  cotação devolve `acao` (assinar/trocar/ja_tem) e a confirmação do pedido
  só desenha; banco de horas drena UMA vez por hora (`criadaAgora` do
  congelamento — antes drenava a cada poll); heartbeat sem transição não
  emite SSE pro admin; substituir arquivo pelo admin respeita a duração do
  plano; PATCH mídia própria valida frequência (400, não 500); proof-of-play
  com execucaoId > 100 chars responde `item_invalido`; job de benefício
  notifica início/fim (+ `plan.updated`); e-mail de reativação próprio (não
  "aprovada"); admin: promoções vigentes com régua de vantagem, candidatura
  antiga de vendedor não aprova; vitrine usa `desconto_percentual` do
  servidor; 409 do /assinar sem "WhatsApp"; RUNBOOK §3.1 (virada
  sandbox→produção, gate do dono). e2e 17 atualizado (chave_hash, 410).

- I parte 2 (esta branch): admin — alerta de telas abre a grade já em
  "Com problema", blocos da Visão geral com catch, logout fecha o
  EventSource, textos ("credencial sai do Preparar Player", "sem
  benefício"), index.html sem canonical/robots duplicado; código morto
  removido (`pagamentos-repository.js`, `drive.js` + dependência
  `googleapis`, `cobrancas-repository.js`, `listarContasComMovimentacao`,
  alias `statusOperacionalTela`); `GET /admin/pontos/:id/pagamentos` e
  `PATCH /admin/cobrancas/:id/nota-fiscal` → 410; docs (api, funcional,
  README, BUSINESS_RULES) sem "Tela 1 no cadastro", "ajuda de custo",
  vendedor e `custoPorExibicao`.

## Item atual
- Commit I-2 → PR → CI → merge → deploy → validar online.

## Próximos
- J (E2E online com bypass controlado do Access; matriz do Checkout no
  sandbox), K (Access restaurado + smoke + relatório de 19 seções).
- Não feito em I (decisão ou baixo valor): P58 preço em 4 lugares, P77
  "pagando em dia" em 10 lugares, P92 5 cópias de cancelar, P66 nomes de
  ciclo duplicados no front, P69/P84 colunas internas expostas, P136
  cargas duplicadas, P128 subtítulo dos aliases.

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
