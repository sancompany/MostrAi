# Estado da consolidação final — Mostraí

Arquivo curto de retomada. Não é diário: só o necessário para outra sessão
continuar com segurança.

## Fase atual
Checkpoint C (backend/banco) + D (Player) implementados localmente — em
validação/commit. A (inventário) fechado em 8/12 domínios (4 restantes rodam
em agentes read-only; resultado em `scratchpad`, não bloqueia).

## Último commit / deploy
- MostrAi: HEAD local à frente de `3f2412c` (main = deployed SHA no Northflank
  `mostrai/mostrai`, 2 instâncias, build main). Branch `claude/busy-noether-hheir2`.
- Player (`sancompany/Playlist.MostrAi`): `28bc93d` (main) — aceita credencial
  direta `{dispositivoId, chaveAparelho, baseUrl}` (ConfigExterna.kt) e token.
- San Checkout (`sancompany/san_checkout`): `f7b1cb9` deployado em
  `san-checkout/san-checkout`, `ASAAS_AMBIENTE=sandbox` — NÃO virar para
  produção sem gate explícito do dono.
- Migrations: produção aplicada até `087`; local até **`088_consolidacao_ponto_tela_conta.sql`**
  (status `aguardando_primeiro_sinal`, número da tela = menor livre, índice
  único lower(e-mail), `anonimizada_em`). Sobe com o próximo deploy (release
  `npm run migrate`).
- Baseline `npm run check` na main: 377/377. Local com C+D: 381/381 (após correções).

## Ambiente
- Banco: Supabase `wnbztsprmzarexnncchg` (MostrAi). Jobs Northflank:
  `conciliacao` (0 9 * * * UTC, `npm run conciliar` — agora também anonimiza
  contas excluídas há 60+ dias), `backup` (0 8 * * 0).
- Cloudflare Access: LIGADO (conferido 24/09 16:10 UTC: policy "Somente o
  operador" nas duas apps, `/admin` → 302 sem cookie). Nenhum bypass criado.
- Produção (leitura): telas 1 (V1, chave hash, sinal) e 4 (sem credencial);
  nenhum token de provisionamento vivo; nenhuma execução confirmada.

## Concluído nesta consolidação
- Fase 0 preflight; A inventário (8/12 domínios, 138 achados brutos, em
  `scratchpad/inventario-dominios.json`).
- C/backend: `sincronizarStatusPonto` canônica (0 telas → a_instalar; ativa
  provisionada sem sinal → aguardando_primeiro_sinal; operando → em_operacao;
  reparo; inativo); crédito do ponto só com `chave_hash` (revogada não conta);
  candidatura → ponto numa função só (`src/pontos/materializar.js`, categoria
  do `segmento`); PATCH candidatura recusa 'aprovada' (só `/liberar`, que
  agora registra métrica e avisa admin via SSE); `ehPonto` derivado do ponto
  materializado; `/anunciantes/me/pontos` sem guarda por papel; PATCH
  `/admin/anunciantes/:id` com allowlist (plano/papeis/cortesia → 400);
  e-mail lower/trim (cadastro, login, redefinição, índice único); exclusão
  remove avatar do bucket; anonimização automática 60 dias; exportação LGPD
  com créditos/benefícios/notificações/arrependimentos/etc.;
  `/afiliados/esqueci-senha` e `/planos-ponto` → 410; e-mail de candidatura lê
  `mensagem`; colunas mortas fora da allowlist de pontos; CEP por dígitos.
- D/Player: `dispositivoId` = 5 dígitos (10000–99999, RNG seguro, único, sem
  colidir com PK); `buscarComPonto` = uid primeiro, PK só para tela V1 sem
  uid; **[Preparar Player]** (`POST /admin/dispositivos/:id/preparar-player`)
  devolve `{dispositivoId, chaveAparelho, baseUrl, rotacaoTela}` uma vez;
  `chave-legada` → 410 (fluxo antigo aposentado); PIN com olho auditado
  (`GET .../pin` → `PIN_REVEALED`) e Trocar; excluir tela com exibição
  confirmada → 409; ficha da Tela nos 7 blocos canônicos (Player / Conexão /
  PIN / Operação / Área segura / Diagnóstico / Histórico), sem PK exposta,
  "Mídia no ar" por nome; equipamento (custo/amortização/instalação) editável;
  painel V1 usa `exigirAparelho`. Token por provisionamento fica como
  capacidade do backend (Player aceita), sem botão no admin.
- Labels de status do ponto em admin, painel, site, layout e docs/api.md.

## Item atual
- `npm run check` verde → commit + push → deploy (migration 088) → validar
  online (health, ficha da tela, Preparar Player em tela de teste).

## Próximos
- E (admin/painel: eventos SSE em todas as abas, regras no backend — vencido,
  promoção; código morto; ponto ficha sem "ID do Ponto #"), F (site: textos,
  comodato.html §3 = decisão), G (Checkout: `criada` antes do chargeId,
  valor do ciclo = valorCobrado, fila de eventos sem tela, assinatura
  'pendente_pagamento', dedupe por evento, matriz de ciclos no sandbox),
  H (legado: vendedor/convites/cortesia/afiliados/dead renderers),
  I (polimento), J (E2E online com bypass controlado), K (Access + smoke +
  relatório).

## Decisões aplicadas nesta rodada (reversíveis, registrar no relatório)
- Estado "Aguardando primeiro sinal" no ponto (regra canônica).
- Número da tela reaproveitado (menor livre) — o histórico continua por PK.
- Fluxo antigo de chave (link do player web) aposentado; player web aceita
  a credencial do Preparar Player em `?tela=<dispositivoId>&chave=`.
- Excluir tela com exibição confirmada é bloqueado (inativar).
- PIN revelável no admin, auditado.
- Provisionamento por token: mantido só no backend (sem UI).

## Decisões necessárias (do dono)
- comodato.html §3 (texto jurídico) — PENDENCIAS J.1.
- Existe TV V1 (player web) em campo além da tela 1? Se não: aposentar
  public/player.html + auth por PK.
- Convites/POST /admin/anunciantes: manter ou 410.
- Confirmação de e-mail como portão do backend; consentimento de novidades.
- Promoção com prazo: preço sobe na Asaas ao vencer ou é vitalícia.
- Banco de horas: manter (cron + tela) ou aposentar.
- Teto de cadastro de criativos: 3 fixos ou limite do plano.

## Bloqueios reais
- Nenhum.
