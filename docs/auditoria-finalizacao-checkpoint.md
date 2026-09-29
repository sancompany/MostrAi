# Estação mestre de finalização — CHECKPOINT (PAUSADA)

**Status: PAUSADA em 28/09/2026 — NÃO CONCLUÍDA.** Pausa pedida pelo dono
pra usar os créditos em outra tarefa. Nada foi mergeado nesta estação. Não
iniciar a Passada 2/3 nem outro domínio sem o dono.

`main` no início da estação: `e99dc45` (ainda é o `main`; nenhum merge).

## RETOMAR DAQUI

| Campo | Estado |
|---|---|
| Último domínio auditado | Criativos (lote Admin Conta + Criativos) e revisões Codex de Mídia/Lógica |
| Última tela auditada | Admin → Contas → Conta (ficha) e Painel → Meus criativos (pausar/retomar) |
| Último bug investigado | PR #88: teto de cadastro barrava a substituição pelo operador (admin sem saída, P1 da revisão adversarial) |
| Última correção | `65aa528` (branch `-logica`): troca pelo operador fora do teto de cadastro; contarCadastrados; `/played` com 403 de tela inativa |
| Estado | 6 PRs abertos (#87–#92), todos com worktree limpo e empurrado; threads do Codex de #88 e #89 respondidas e resolvidas |
| Próximo item a investigar | Pendências P2 da revisão de #88 (abaixo, LOG-P1/LOG-P2), depois a thread Codex de #91 (`.ia/HANDOFF.md`), depois Passada 2 |
| PRs | #87 UX global · #88 Lógica · #89 Mídia · #90 Pontos/Rede · #91 Indicações · #92 Conta+Criativos (empilhado em #87) |
| Branches | `claude/busy-noether-hheir2` (+ sufixos `-logica`, `-midia`, `-pontos`, `-indic`, `-conta`) |
| Últimos commits | #87 `6642836` · #88 `65aa528` · #89 `8a0f0d4` · #90 `1fa0f4a` · #91 `21148f6` · #92 `126fd13` (+ este checkpoint em #87) |
| Testes já executados | ver "Testes" |
| Testes que faltam | CI de #88/#89/#92 nos commits novos; e2e completo pós-merge; `npm run check` em banco limpo com todos os lotes juntos |
| Telas revisadas | ver "Telas" |
| Telas que faltam | ver "Telas" |

Ordem recomendada ao retomar:
1. Conferir CI de #88 (`65aa528`), #89 (`8a0f0d4`) e #92 (`126fd13`).
2. Decidir com o dono a ordem de merge (sugestão: #87 → #92 → #88 → #89 → #90 → #91; #88 e #92 mexem nos dois em `criativos-repository.js` e `admin/routes.js` — conflito esperado, ver "Conflitos previstos").
3. Corrigir LOG-P1/LOG-P2 (pequenos) no #88.
4. Responder a thread Codex de #91 (P1: `.ia/HANDOFF.md` desatualizado) — este checkpoint é a resposta; apontar pra ele.
5. Só então Passada 2 (e2e completo + tour) e relatório final.

### Conflitos previstos entre PRs
- #88 e #92 alteram `src/anunciantes/criativos-repository.js` (#88: `contarCadastrados`, retirado fora de `contarNaoReprovados`; #92: `retirado_por` e `contarAtivos`) e o PATCH de `src/admin/routes.js` (#88: swap de substituto; #92: `retirado_por`; #89: guarda de mídia excluída). Resolver juntando as três regras.
- #92 usa migration 102; #89 usa 101. Nenhum outro PR cria migration.

## Inventário (todos os achados, inclusive os resolvidos)

Estados: VALIDADO E CORRIGIDO · CORRIGIDO, AGUARDANDO VALIDAÇÃO · REPRODUZIDO, NÃO CORRIGIDO · IDENTIFICADO, NÃO REPRODUZIDO AINDA · PENDENTE DE INVESTIGAÇÃO · VISUAL PENDENTE · FEATURE FORA DO ESCOPO.
"VALIDADO" aqui = teste/e2e verde no branch; nada está em produção.

| ID | Domínio/tela | Camada | Sev | Problema | Como foi identificado | Estado | Arquivos/rotas | PR/commit | Próximo passo |
|---|---|---|---|---|---|---|---|---|---|
| UX-01 | Painel · perfil/criativos/plano | Front | P1 | 7 `confirm()`/`alert()` nativos | grep + clique | VALIDADO E CORRIGIDO | `public/perfil.js`, `painel.page.js`, `meus-criativos.js`, `public/confirmar.js` | #87 `6642836` | merge |
| UX-02 | Site todo | Front | P1 | Trava de duplo clique só em `<form>`; ação por clique criava 2 telas | 2 cliques em "+ Adicionar tela" | VALIDADO E CORRIGIDO | `public/layout.js` | #87 | merge |
| UX-03 | Site todo | Front | P2 | Trava liberava entre POST e upload da foto | pedido de ponto com foto | VALIDADO E CORRIGIDO | `public/layout.js` | #87 | merge |
| UX-04 | Painel/público | Front | P2 | "Failed to fetch" cru na tela | sem rede + salvar | VALIDADO E CORRIGIDO | perfil, creditos, modos, convite, pontos | #87 | merge |
| UX-05 | Admin | Front | P2 | `api()` sem try/catch: queda de rede = botão preso | sem rede + ação | VALIDADO E CORRIGIDO | `public/admin/index.page.js` | #87 | merge |
| UX-06 | Admin | Front | P2 | 12 ações recarregam RESUMO antes de redesenhar; falha = tela parada | `/admin/resumo` caindo | VALIDADO E CORRIGIDO | idem | #87 | merge |
| UX-07 | confirmar-plano | Front | P2 | Sem rede: "Gerando cobrança…" pra sempre; mensagem técnica | sem rede | VALIDADO E CORRIGIDO | `public/confirmar-plano*.js` | #87 | merge |
| UX-08 | style.css | Front | P3 | 273 blocos CSS duplicados | grep | VALIDADO E CORRIGIDO | `public/style.css` | #87 | merge |
| VIS-01 | Admin → Rede → Ponto (celular) | Visual | P2 | `.dado-sub` nowrap vaza o card (49px) | tour 390px | VALIDADO E CORRIGIDO | `public/admin/index.css` | #90 `1fa0f4a` | merge; na ficha da conta ainda vaza até #90 entrar |
| VIS-02 | Admin → Rede → Ponto | Visual | P3 | Responsável sem separador entre nome e cargo | tour | VISUAL PENDENTE | `renderPontoInformacoes` | — | separar nome/cargo |
| VIS-03 | Admin → Visão geral | Visual | P3 | Tabela de ocupação cortada com scroll interno | tour 1366 | CORRIGIDO, AGUARDANDO VALIDAÇÃO | `index.css` `.celula-ponto` | #92 | medir na Passada 2 |
| VIS-04 | Admin → Mídia Mostraí | Visual | P3 | Tabela "Capacidade da rede" cortada à direita | tour | CORRIGIDO, AGUARDANDO VALIDAÇÃO | idem | #92 | medir na Passada 2 |
| VIS-05 | Painel · Onde seu anúncio aparece | Visual | P2 | Nome longo do ponto sobrepõe/vaza 313px | tour conta A | VALIDADO E CORRIGIDO | `painel.page.js`, `style.css` | #90 | merge |
| VIS-06 | Painel · Créditos (celular) | Visual | P3 | Tabela planos × períodos vaza 124px | tour 390px | VISUAL PENDENTE | `public/creditos.js` | — | conferir se o `.u-ox-auto` basta (rolagem interna) |
| VIS-07 | Painel · Exibições por ponto (celular) | Visual | P3 | mini-table vaza 224px; gráfico por dia 11px | tour 390px | VISUAL PENDENTE | `painel.page.js` | — | idem |
| VIS-08 | Painel · form completo de ponto | Visual | P2 | Form espremido na coluna de 35%; rolagem lateral | conta B | VALIDADO E CORRIGIDO | `painel.html/css`, `meus-pontos.js` | #90 | merge |
| VIS-09 | Painel · form compacto "Quero ser um ponto" | Visual | P2 | Mesmo problema de largura | conta A | VALIDADO E CORRIGIDO | idem | #90 | merge |
| VIS-10 | Painel · forms de ponto | Visual | P2 | Campos sem estilo (form sem `.card`) | tela | VALIDADO E CORRIGIDO | idem | #90 | merge |
| MID-01 | Admin → Mídia Mostraí | Front | P2 | Mídias misturadas, sem histórico | tela | VALIDADO E CORRIGIDO | `index.page.js` GRUPOS_MIDIA | #89 | merge |
| MID-02 | Admin → Mídia Mostraí | Back+Front | P2 | Sem exclusão de mídia | tela | VALIDADO E CORRIGIDO | `DELETE /admin/midias-proprias/:id`, migration 101 | #89 | merge |
| MID-03 | midias/routes.js | Back | P3 | `/retomar` aceitava encerrada | teste | VALIDADO E CORRIGIDO | `midiasRepo.transicionar` | #89 | merge |
| MID-04 | Mídia (Codex #89) | Back | P2 | Criativo pendente de mídia excluída ficava na fila | teste | VALIDADO E CORRIGIDO | `midiasRepo.excluir` (1 transação) | #89 `8a0f0d4` | merge |
| MID-05 | Mídia (Codex #89) | Back | P2 | Pausar/retomar depois do fim do período | teste | VALIDADO E CORRIGIDO | `situacaoDerivada`, `soVigente` | #89 `8a0f0d4` | merge |
| MID-06 | Mídia (Codex #89) | Teste | P2 | Fixture do contador sem `ponto_id` | teste com tela real | VALIDADO E CORRIGIDO | `tests/midias-historico.test.js`, e2e 30 | #89 `8a0f0d4` | merge |
| MID-07 | Mídia (revisão) | Back+Front | P2 | Editar estendia período de mídia retirada sem revalidar capacidade | revisão adversarial | VALIDADO E CORRIGIDO | PATCH `/admin/midias-proprias/:id` | #89 `8a0f0d4` | merge |
| MID-08 | Mídia (revisão) | Front | P3 | 409 de Pausar/Retirar sem motivo e sem redesenho | revisão | VALIDADO E CORRIGIDO | `index.page.js` | #89 `8a0f0d4` | merge |
| MID-09 | Mídia (revisão) | Back | P3 | PATCH de criativo x DELETE de mídia: guarda check-then-act (corrida de duas abas) | revisão | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `src/admin/routes.js` PATCH | — | levar a guarda pro UPDATE (`NOT EXISTS midia excluida`) |
| ADM-01 | Admin → Contas → Conta | Front | P3 | Pontos abaixo de Criativos; pedido: ao lado de Créditos | tela | VALIDADO E CORRIGIDO | `desenharFicha`, `.conta-grade` | #92 `126fd13` | merge |
| IND-01 | Cadastro `?ref=` | Front+Back | P2 | Nada mostrava "Você foi indicado por" | tela | VALIDADO E CORRIGIDO | `GET /indicacoes/:codigo`, `cadastro.page.js` | #91 `21148f6` | merge |
| IND-02 | Painel do ponto · Indicações | Front+Back | P2 | Sem histórico de indicados | tela | VALIDADO E CORRIGIDO | `listarIndicados`, `creditos.js` | #91 | merge |
| IND-03 | Docs (Codex #91) | Docs | P1 | `.ia/HANDOFF.md`/`TODO.md`/`PENDENCIAS.md` não citam a estação | Codex | REPRODUZIDO, NÃO CORRIGIDO | `.ia/`, `docs/PENDENCIAS.md` | este checkpoint (#87) | responder a thread apontando pra cá |
| PON-01 | Painel · pontos | Front | P2 | Dois cliques = dois PUTs; recusa deixava caixa marcada | e2e | VALIDADO E CORRIGIDO | `painel.page.js` fila de salvamento | #90 | merge |
| PON-02 | Painel · pontos | Front | P3 | "Horário não informado" × admin "Aberto 24 horas" | tela | VALIDADO E CORRIGIDO | idem | #90 | merge |
| CRI-01 | criativos-repository | Back | P2 | Retirado ocupava vaga do plano ("2 de 1") | teste | VALIDADO E CORRIGIDO | `contarNaoReprovados` | #88 | merge |
| CRI-02 | anunciantes/routes | Back | P2 | Três regras de limite (plano / 3 no admin / 3 na ficha) | leitura | PENDENTE DE INVESTIGAÇÃO | `subirCriativo`, `situacao.js` | parcial em #88 | unificar com LOG-P1 |
| CRI-03 | admin PATCH | Back | P1 | Substituto recusado e depois aprovado não retirava o original | teste | VALIDADO E CORRIGIDO | `src/admin/routes.js` | #88 | merge |
| CRI-04 | admin PATCH | Back | P3 | Reprovado vai direto a aprovado sem guarda | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | idem | — | decidir com o dono se é permitido |
| CRI-05 | Meus criativos | Back+Front | P2 | Sem pausa/retomada; "retirado" não dizia quem tirou | pedido H | VALIDADO E CORRIGIDO | `/me/criativos/:id/pausar|retomar`, migration 102 | #92 `126fd13` | merge |
| CRI-06 | Teto de cadastro (Codex #88) | Back | P2 | Substituição acumulava retirados sem teto | teste | VALIDADO E CORRIGIDO | `contarCadastrados` | #88 `65aa528` | merge |
| LOG-P1 | Teto de cadastro (revisão #88) | Back+Front | P2 | `contarCadastrados` exclui o substituto em análise → a conta pode chegar a "4 de 3" (mesma régua em `situacao.js:392` e `index.page.js:4443`) | revisão adversarial | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `criativos-repository.js`, `situacao.js`, `admin/index.page.js` | — | contar `status <> 'reprovado'` nos 3 lugares + teste |
| LOG-P2 | Painel do cliente (revisão #88) | Front | P2 | Painel não sabe do teto de 3: oferece "Substituir" que dá 400; tooltip diz "exclua ou substitua" | revisão adversarial | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `public/meus-criativos.js`, GET `/me/criativos` | — | devolver `cadastrados`/`limiteConta`; esconder Substituir no teto |
| LOG-P3 | Ficha admin (revisão #88) | Front | P3 | Dica "substitua ou retire um pra trocar" — retirar não libera o teto | revisão | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `index.page.js:4536` | — | trocar texto |
| POP-07 | player/routes | Back | P2 | `/played` com tela inativa → 403 | auditoria | FEATURE FORA DO ESCOPO (decisão: mantido o 403 do contrato §4; Codex #88) | `src/player/routes.js` | #88 `65aa528` | nenhum |
| FIN-01 | plano-administrativo | Back | P1 | Ciclo pago zerava `suspenso` | teste | VALIDADO E CORRIGIDO | `plano-administrativo.js` | #88 | merge |
| FIN-02 | financeiro /assinar | Back | P1 | Cancelar + assinar outro somava dias no plano novo | teste | VALIDADO E CORRIGIDO | `san-checkout.js`, `financeiro/routes.js` | #88 | merge |
| FIN-03 | san-checkout | Back | P2 | Expiração calculada antes do FOR UPDATE | leitura | VALIDADO E CORRIGIDO | `san-checkout.js` | #88 | merge |
| FIN-04 | plano-administrativo | Back | P2 | Renovação no dia seguinte ao fim do benefício apaga dias pagos guardados | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `plano-administrativo.js:367/461` | — | escrever teste |
| FIN-05 | trocar-plano | Back | P2 | Troca ignora vagas do plano e compromisso mínimo do parceiro | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `financeiro/routes.js` | — | teste |
| FIN-06 | ciclo-contratado | Back | P1 | Custo por exibição "-" pra conta que trocou de plano antes da 087 | produção (conta 5) | VALIDADO E CORRIGIDO | `ciclo-contratado.js` | #88 | merge + conferir em produção |
| CTA-01 | sessão | Back | P2 | Conta excluída mantinha outras sessões | teste | VALIDADO E CORRIGIDO | `anunciantes/routes.js` | #88 | merge |
| CTA-02 | titular/arrependimento | Back | P2 | Arrependimento usa `suspenso` → bloqueia login, não cancela links | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `titular/routes.js:137` | — | teste + decisão |
| POP-01 | bancohoras/obrigacao | Back | P1 | Obrigação retroativa (saldo indevido) | teste | VALIDADO E CORRIGIDO | `obrigacao.js` | #88 | merge |
| POP-02 | gerador | Back | P2 | criativoId fora do int4 → 500 trava a fila de POP | teste | VALIDADO E CORRIGIDO | `gerador.js` | #88 | merge |
| POP-03 | gerador | Back | P2 | Déficit congelado antes do lote de POP: reprograma a mais | leitura | PENDENTE DE INVESTIGAÇÃO (design) | `gerador.js:246` | — | decidir com o dono |
| POP-04 | gerador | Back | P2 | Entrante no meio da hora vai pro fim de hora cheia (não toca) | leitura | PENDENTE DE INVESTIGAÇÃO (design) | `gerador.js:689` | — | idem |
| POP-05 | gerador | Back | P2 | Reserva de banco multiplicada por tela | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `gerador.js:524` | — | teste com 2 telas |
| POP-06 | gerador | Back | P2 | 1ª hora da tela nova: obrigação da hora inteira | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `gerador.js:428` | — | teste |
| POP-08 | apuracao | Back | P2 | Reapurar mês antigo usa estado atual | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `apuracao.js` | — | teste |
| POP-09 | painel exibições | Back | P2 | "Horas entregues" ≠ apuração | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `anunciantes/routes.js` `/exibicoes` | — | unificar fonte |
| POP-10 | dispositivos | Back | P3 | Excluir tela apaga obrigação não paga; checagem fora da transação | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `dispositivos/repository.js:236` | — | teste |
| VAR-01 | vários | Back | P3 | Off-by-one em datas (31 dias/mês, restaurar +1, 21h–24h, setMonth, mês UTC) | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | vários | — | um teste por caso |
| VAR-02 | webhook-inbox | Back | P3 | Sem ordem por assinatura entre tentativas | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `webhook-inbox.js:83` | — | teste |
| VAR-03 | contas | Back | P3 | Sem rota de restaurar conta excluída | leitura | FEATURE FORA DO ESCOPO | — | — | dono decide |
| VAR-04 | midias substituir | Back | P2 | "Substituir arquivo" sem guarda de status | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | `midias/routes.js` `/admin/criativos/:id/substituir` | — | teste |
| VAR-05 | vários | Back | P3 | Duplo submit sem lock no servidor (/assinar, trocar-plano, pedir ponto, substituto duplo, conceder créditos) | leitura | IDENTIFICADO, NÃO REPRODUZIDO AINDA | vários | parcial: trava de clique no front (#87) | idempotência no servidor |

## Pendências visuais pedidas pelo dono

| Item | Estado |
|---|---|
| Dois formulários "Tornar-se ponto" (65/35 desktop, 1 coluna celular) | CORRIGIDO (e2e 31; #90) |
| Admin → Mídia Mostraí (organização) | CORRIGIDO (e2e 30; #89) |
| Histórico de mídias pausadas/retiradas | CORRIGIDO (#89) |
| Exclusão de mídia com modal | CORRIGIDO (#89) |
| `window.confirm/alert/prompt` | CORRIGIDO (nenhum uso restante; #87) |
| Admin → Contas → conta específica | CORRIGIDO (#92) |
| Pontos ao lado de Créditos e benefícios | CORRIGIDO (#92) |
| Admin → Rede → Ponto (overflow) | CORRIGIDO (#90); VIS-02 pendente |
| Texto escapando dos cards | CORRIGIDO onde medido (VIS-01/05/08/09); VIS-06/07 VISUAL PENDENTE |
| Pontos do anunciante | CORRIGIDO (#90) |
| Lista → cards coerentes com o Admin | CORRIGIDO (#90) |
| Criativos (cards, contador, pausa, retomada, exclusão, feedback) | CORRIGIDO (#92); LOG-P2 pendente |
| Modais e ações destrutivas | CORRIGIDO (#87 + #89 + #92) |
| Responsividade | CORRIGIDO nas telas alteradas (e2e 390px); Passada 2 geral NÃO INICIADA |
| Espaços mortos | NÃO INICIADO (não houve passada dedicada) |
| Hierarquia visual | NÃO INICIADO |
| Estados vazio/loading/erro | CORRIGIDO no admin (#87 UX-05/06); resto NÃO INICIADO |
| Nenhum item foi VALIDADO em produção (nada mergeado) | — |

## Funções provisórias (grep no branch #87, 28/09/2026)

- **Já substituído:** todos os `confirm()`/`alert()`/`prompt()` nativos de `public/` (7 em UX-01 + os `prompt()` do admin, substituídos antes). `public/confirmar.js` (`window.confirmarMostrai`) e `confirmarModal` do admin são o padrão.
- **Ainda existe e precisa ser analisado:** nenhum.
- **Intencional / não é problema:** 6 menções em comentários (`public/admin/index.page.js:272/1823/3777/4666`, `public/confirmar.js:3`, `public/perfil.js:387`). `TODO` só aparece como a palavra "todo/TODOS" em comentários (`gerador.js:567`, `midias/repository.js:232`, `conta/modos.js:138`, `san-checkout.js:34/44`). Nenhum `FIXME`.

## Telas

- **Revisadas (Passada 1 + lotes):** Painel do anunciante inteiro (hero, primeiros passos, resumo, pontos, criativos, créditos, financeiro, perfil) desktop e 390px; cadastro e `?ref=`; confirmar-plano; Admin: Visão geral, Rede (lista, ponto, tela), Contas (lista, ficha), Ofertas, Mídia Mostraí, Aprovação, Mensagens; tour visual automatizado (90 medições).
- **Faltam (Passada 2):** site público (home, planos, seja ponto, termos) no estado final dos PRs; notebook/tablet (1024/768) em todas; Central financeira interna; player (`public/player.html`) visual; e-mails transacionais; rever tudo após os merges juntos.

## Testes

- **Executados e verdes no branch de cada PR:** `npm test` #88 625/625 (implementador) + `finalizacao-logica` 8/8 e `player-mvp` 35/35 após `65aa528`; #89 621/621 + e2e 30; #90 e2e 31 + regressões; #91 `indicacoes-historico` 2/2 + e2e 32; #92 `criativos-pausa` 4/4, e2e 33 21/21, e2e 13/16/24, `npm test` 617/618 (a falha era dado de e2e sobrando; em banco zerado passa). Lint no baseline (14 avisos) em todos.
- **Faltam:** CI nos commits `65aa528`, `8a0f0d4`, `126fd13` (+ este); e2e completo (33 roteiros) com os PRs juntos; `npm run check` em banco limpo com todos os lotes; smoke em produção depois de cada merge autorizado.

## Ambiente local (pra quem retomar nesta máquina)
Worktrees: `/home/user/MostrAi` (#87, banco `mostrai`), `-logica` (#88, `mostrai_limpo2`), `-midia` (#89, `mostrai_limpo`), `-pontos` (#90), `-indic` (#91), `-conta` (#92, `mostrai`, migration 102 aplicada). Os testes não carregam `.env` sozinhos (`set -a; . ./.env; set +a`). O Postgres local caiu 3 vezes nesta sessão (`service postgresql start`).
