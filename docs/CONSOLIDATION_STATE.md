# Estado da consolidação final — Mostraí

Arquivo curto de retomada. Não é diário: só o necessário para outra sessão
continuar com segurança. Relatório completo da estação:
`docs/relatorio-consolidacao-final-2026-09-24.md`.

## Fase atual
**Estação final de consolidação CONCLUÍDA** (checkpoints A–K) em 24/09/2026.
O que resta é decisão do dono (lista abaixo) e a auditoria externa
(Codex/Jules) antes do reset final do banco — **banco NÃO resetado**.

## Último commit / deploy
> **Atualização 25/09/2026 (fechamento pré-gates):** `main` = `ff970a2`
> (PR #62) no ar; migrations até **090**; San Checkout **em produção**;
> `npm run check` 412/412; `npm audit` 0. Relatório:
> `docs/FECHAMENTO_PRE_GATES_2026-09-25.md`. O que segue abaixo é o retrato
> de 24/09.

- MostrAi `main` = **`632d7bf`** (PR #57) — deployed SHA no Northflank
  `mostrai/mostrai` (2 instâncias), `/health` ok, cache purgado. Sequência
  da estação: `63952fb` (#49 C+D, migration 088) → `89d73d4` (#50 G+E,
  migration 089) → `1411abd` (#51 H+F) → `08ea4e8` (#52 I-1) → `c6287fd`
  (#53 I-2) → `2ed9473` (#54 J+K, fecha a estação) → `a975c52` (#55,
  revisão Codex) → `4b25c0e` (#56, webhook de intenção cancelada) → `632d7bf` (#57, ciclo
  legado + recusa no admin) → PR #58 (janela do ciclo legado; SHA final no
  `git log -1 origin/main` e no relatório da sessão).
- Migrations em produção: até **089** (conferido em `schema_migrations`).
- Player (`sancompany/Playlist.MostrAi`): `28bc93d` (main).
- San Checkout (`sancompany/san_checkout`): `f7b1cb9` — hoje em produção
  (`ASAAS_AMBIENTE=producao`, Pix e cartão reais homologados; RUNBOOK §3.1).
- Baseline `npm run check`: 389/389; lint 14 avisos (era 16).

## Ambiente
- Banco: Supabase `wnbztsprmzarexnncchg`. Jobs Northflank: `conciliacao`
  (0 9 * * * UTC), `backup` (0 8 * * 0).
- Cloudflare Access: LIGADO e conferido no fim (24/09 ~18:55 UTC): as duas
  apps só com a policy "Somente o operador"; nenhum service token; `/admin`
  → 302 com e sem token. O bypass da validação online (service token +
  policy temporária) foi criado e apagado na mesma hora.
- Produção (leitura, 25/09 depois da reconciliação sandbox — PENDENCIAS
  L.2): 4 contas (1 com plano vigente, cortesia), 0 assinaturas, 0
  cobranças, 0 eventos pendentes, 0 chaves de webhook (o sandbox do
  Checkout foi zerado e os vínculos daqui saíram com snapshot no evento
  `sandbox:reconciliacao`), pontos 1 em operação + 1 aguardando instalação,
  telas: 1 V1 com credencial e sinal, 1 sem credencial (a preparar), 3
  criativos aprovados.

## Concluído nesta consolidação
- A inventário (8/12 domínios, 138 achados, `scratchpad` da sessão).
- C/backend + D/Player (PR #49); G/Checkout + E/admin (PR #50); H/legado +
  F/site (PR #51); I/polimento (PRs #52 e #53); J/online (roteiro
  `tests/e2e/19-online-producao.mjs`, rodado contra a produção com o admin
  por service token temporário: 0 falhas; site em 5 tamanhos sem overflow
  nem erro de console; adversarial sem efeito colateral); K/Access
  restaurado + smoke.

## Decisões aplicadas (reversíveis, todas no relatório)
- Ponto: estado "Aguardando primeiro sinal"; número da tela = menor livre.
- Player: dispositivoId 5 dígitos; Preparar Player entrega a credencial uma
  vez; chave-legada → 410; PIN revelável e auditado; excluir tela com
  exibição confirmada → 409; token de provisionamento só no backend.
- Checkout: assinatura nasce `pendente_pagamento`; entitlement só pelo
  backend; valor do ciclo = valorCobrado; `criada` sem chargeId.
- Legado fora do código executável: vendedor, grade antiga de planos,
  benefícios, liberar-plano, custos fixos, repasses, nota fiscal por upload.
- Vigência: último dia inclusivo em Matão (RN-32-B); cotação decide o
  pedido; banco de horas: desde 25/09 a geração só programa e a liquidação
  abate o confirmado (migration 090).

## Decisões necessárias (do dono)
- comodato.html §3 (texto jurídico) — PENDENCIAS J.1; Termos §6 e Política
  de Privacidade ainda descrevem vendedor — PENDENCIAS §H.
- Existe TV V1 (player web) em campo além da tela 1? Se não: aposentar
  public/player.html + auth por PK e rodar a migration 084.
- Convites e `POST /admin/anunciantes`: manter ou 410. Revogar o convite #2
  (vendedor, aberto em produção, expira 29/09)?
- Textos dos benefícios da vitrine: voltar a ter tela ou ficar por SQL.
- Confirmação de e-mail como portão do backend; consentimento de novidades
  (opt-in ou legítimo interesse).
- Promoção com prazo: preço sobe na Asaas ao vencer ou é vitalícia.
- ~~Banco de horas: manter ou aposentar~~ — **decidido MANTER** (25/09);
  fila/válvula removida; falta só criar o job `ApuracaoBancoHoras`.
- Teto de cadastro de criativos: 3 fixos ou limite do plano.
- Ponto 1 sem conta dona (crédito mensal sem destino); ponto 3 sem tela
  preparada.
- O reset final do banco — só depois da auditoria Codex/Jules e com o
  "pode resetar" do dono. (A virada do San Checkout para produção já foi
  feita.)

## Depois do fecho
- Revisão Codex dos PRs #50–#54 (24/09, mesma tarde): 8 achados corrigidos
  nos PRs #55, #56 e #57 (cada volta do Codex fechada na seguinte); o
  registrado em PENDENCIAS L.1 (drenagem retentável do banco de horas) foi
  resolvido em 25/09 pela migration 090.

## Bloqueios reais
- Nenhum.
