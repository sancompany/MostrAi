# Relatório — Estação final de consolidação do Mostraí (24/09/2026)

Executor único: Claude Code, sessão `session_011TaZ6uNzA5k5JBubc89PWF`,
branch `claude/busy-noether-hheir2`. Estado curto de retomada em
`docs/CONSOLIDATION_STATE.md`. Nenhuma funcionalidade nova; correção à regra
canônica; decisão indeterminada virou "DECISÃO NECESSÁRIA" (seção 18).

## 1. Estado final

Um Mostraí só, do site ao Player, passando pelo backend, pelo banco e pelo
San Checkout, com as regras decididas no servidor. Produção no ar em
`c6287fd` (+ PR #54 de fechamento), migrations até 089, `/health` ok,
Cloudflare Access ligado e conferido, banco **não** resetado. `npm run
check` 389/389; lint 14 avisos (baseline 16). Roteiros e2e locais 01–18
verdes; roteiro online 19 contra a produção com 0 falhas.

## 2. Arquitetura (o que vale agora)

- **Conta** (`anunciantes`) nasce anunciante; papel `ponto` deriva de ponto
  materializado; vendedor não existe. E-mail normalizado (lower/trim, índice
  único). Conta excluída é anonimizada em 60 dias pelo job diário.
- **Rede / Ponto / Tela**: PK nunca é identidade pública. Ponto:
  `a_instalar → aguardando_primeiro_sinal → em_operacao` (+ `em_reparo`,
  `inativo`), derivado das telas por `sincronizarStatusPonto`, nunca
  "Operando" sem primeiro sinal. Tela: número = menor livre por ponto;
  `dispositivoId` = 5 dígitos (10000–99999, único, não secreto);
  `chaveAparelho` só como hash; PIN de 4 dígitos no cofre, revelável e
  auditado; `baseUrl` canônica (`SITE_URL`). **[Preparar Player]** entrega
  `{dispositivoId, chaveAparelho, baseUrl, rotacaoTela}` uma vez
  (`mostrai-config.json`). Estado administrativo (Ativa/Reparo/Inativa) ×
  saúde (operando, fora do horário, aguardando primeiro sinal, sem sinal,
  erro do Player) separados. Excluir tela com exibição confirmada → 409;
  excluir tela não cria outra.
- **Produtos**: Essencial/Pro/Prime × Mensal/Trimestral/Semestral/Anual (12
  linhas em `planos`); Inicial/Básico aposentados; promoção por
  elegibilidade comercial com régua de vantagem (D1).
- **Ser ponto não é plano**: +1 crédito por ponto elegível (tela ativa com
  credencial viva) por competência, no ledger único, idempotente; benefício
  resgatado com créditos entra na fila (Agora → Próximo → Depois) com
  prioridade Essencial < Pro < Prime; plano pago fica guardado por baixo.
- **Vigência** (RN-32-B, `src/lib/vigencia.js`): último dia inclusivo no
  relógio de Matão — a mesma função no gerador, na cotação, na conciliação,
  no admin e nos jobs.
- **Checkout**: assinatura nasce `pendente_pagamento` e só vira `ativa` com
  o primeiro ciclo pago (webhook `criada` ou conciliação); o navegador nunca
  concede direito. Valor do ciclo = `valorCobrado` da Asaas; snapshot
  econômico em `ciclos_contratados`; custo por **exibição prevista**.
- **Frontend não calcula regra**: `plano_vigente`, `situacao_exibicao`,
  `acao` da cotação, `plano_origem`, situação de tela e ponto vêm do
  servidor; sem F5 — SSE por conta e por admin (LISTEN/NOTIFY entre as 2
  instâncias).

## 3. Legado removido do código executável

Rotas respondem 410 com o motivo; código e dependências saíram:
vendedor inteiro (`/vendedor/*`, `/admin/comissoes*`, `/admin/vendedores*`,
`ativar-vendedor`, `/afiliados/*`, `vendedores-repository.js`,
`vendedor.html/.page.js`, `registrarComissaoSeHouver`, campo `vendedor` de
`/me`, Pix no convite); grade antiga de planos (`POST/PATCH /admin/planos*`,
`nova-versao`, `planos-arquivados`, `/admin/beneficios*`,
`beneficios-repository.js`, `planosRepo.criar/atualizar/vagaOcupada/
definirBeneficios/listarArquivados`); `liberar-plano`; `/admin/custos-fixos*`;
`GET /admin/pontos/:id/pagamentos` + `pagamentos-repository.js`; nota fiscal
por upload (`drive.js`, `cobrancas-repository.js`, dependência `googleapis`);
`chave-legada` do Player; `/planos-ponto`, `/afiliados/esqueci-senha`;
~1.100 linhas de renderers mortos do admin + CSS legado;
`listarContasComMovimentacao`, alias `statusOperacionalTela`, `gerarUid`,
`gerarChaveLegada` (só em teste V1).

## 4. Legado preservado (histórico legítimo)

Tabelas `vendedores`, `comissoes`, `pagamentos_ponto`, `planos_ponto`,
`beneficios`, versões aposentadas em `planos`, colunas `nota_fiscal_*`,
`comodato_plano_id`, `credito_comodato_mensal`, `cota_autoanuncio_slots_hora`,
`aparelho_id` (chave V1 em texto — migration 084 espera a decisão da TV V1),
`indicacoes_pagas`. Exportação LGPD ainda lê comissões. Convites e
`POST /admin/anunciantes` continuam (decisão pendente). `GET /admin/planos`
e `GET /admin/anunciantes/:id/plano` ficam como leitura.

## 5. Backend (o que mudou)

Migration 088 (status `aguardando_primeiro_sinal`, gatilho de número da
tela = menor livre, índice único de e-mail, `anonimizada_em`) e 089
(`pendente_pagamento`). `src/pontos/materializar.js` (candidatura → ponto
numa função, categoria pelo segmento); PATCH de candidatura recusa
`aprovada`; `/liberar` registra métrica e avisa admin; allowlist no PATCH
de conta; e-mail normalizado; avatar removido do bucket; anonimização;
exportação completa; `src/player/credencial.js` (5 dígitos),
`prepararPlayer`, `revelarPin`, guarda de exclusão; swap atômico de
criativo; `criada` deduplica sem chargeId; conciliação não duplica; cancelar
404 limpo; `contarVagasOcupadas` conta a pendente (regressão achada pelo
e2e); `src/lib/vigencia.js`; cotação com `acao`; banco de horas drena uma
vez por hora; heartbeat só emite SSE em transição; proof-of-play com id
longo responde `item_invalido`; substituir arquivo pelo admin respeita a
duração do plano; PATCH de mídia própria valida frequência; job de
benefício notifica início/fim; e-mail de reativação próprio.

## 6. Frontend

Admin: ficha da Tela nos 7 blocos canônicos (Player / Conexão / PIN /
Operação / Área segura / Diagnóstico / Histórico), Preparar Player com
download, PIN com olho, sem PK exposta; aba "Eventos do Checkout"; SSE em
todas as abas; `plano_vigente`/`situacao_exibicao` do servidor; alerta de
telas abre a grade filtrada; blocos com catch; logout fecha o EventSource;
renderers mortos e CSS legado removidos. Painel: rótulos dos 4 estados do
ponto; confirmação do pedido só desenha (`acao`). Site: convite sem
vendedor/Pix; vitrine usa `desconto_percentual` do servidor; sem
Inicial/Básico/R$ 50; `/conta/sessao` evita 401; CSP e HSTS conferidos no ar.

## 7. Rede / Ponto / Tela

Regras da seção 2 implementadas e provadas por `tests/player-v2.test.js`,
`tests/redesenho-rede.test.js`, `tests/pontos-duplicados.test.js`, e2e 01,
03, 09, 12, 18 e o roteiro online (ficha da Tela em produção renderiza os
blocos; tela sem credencial mostra "Preparar Player", "Sem credencial",
"Aguardando primeiro sinal"; ponto correspondente "aguardando instalação").

## 8. Player

Fonte de verdade: código do Player (`28bc93d`) → `docs/player-v2-contract.md`
→ checklist. Backend aceita credencial direta e token; `hello`, `heartbeat`
(snapshot, transições), `config` versionada, `playlist` V2 com
`contentHash`, `played` sem 400 por conteúdo. V1 continua pelo ID numérico
enquanto a tela 1 existir (decisão pendente). Online: `/playlist/12345` e
`/player/12345/heartbeat` sem credencial → 401.

## 9. SAN Checkout (sandbox)

Matriz coberta em teste (`assinatura-pendente`, `dedupe-webhook`,
`troca-de-plano`, `prioridade-planos`, `ciclos-beneficio`, `cotacao`,
`custo-previsto`, e2e 02): Essencial/Pro/Prime × 4 ciclos, promoção,
pendente → confirmado, recusado, cancelado, estorno, contestação, troca,
renovação, benefício por cima, webhook duplicado, atrasado e fora da
janela, idempotência por evento. Online: webhook sem assinatura e com
assinatura errada → 401 em produção; consulta de `consultar-assinatura` da
assinatura ativa a partir do container de produção respondeu `ativa` com
cobrança confirmada e `chargeId`. Compra real de ponta a ponta no sandbox
NÃO foi executada (exige conta com e-mail real e gera dado em produção —
seção 18). **Sem virada financeira**: `ASAAS_AMBIENTE=sandbox`; RUNBOOK
§3.1 descreve a virada, que é gate do dono.

## 10. Créditos e benefícios

Ledger idempotente (`creditos_ledger`), +1/mês por ponto elegível (tela
ativa com `chave_hash`), resgate com fila e prioridade, benefício notifica
início/fim, plano pago guardado volta com os dias. Admin concede créditos
(motivo obrigatório), nunca plano (cortesia = `plano-administrativo`, só
ferramenta técnica).

## 11. Pagamentos

Assinatura pendente até o primeiro ciclo; `criada` ativa sem chargeId;
valor cobrado real; conciliação diária reconhece a cobrança; reserva de vaga
de 15 min conta a pendente; `plan.updated`/`payment.updated` em cancelar,
trocar e confirmar; 409 do `/assinar` aponta pra troca no painel.

## 12. E2E

Local: 01, 02, 03, 04, 05, 06, 07, 14, 16, 17, 18 rodados verdes nesta
estação (reset antes de cada um; 16/17 com `NODE_ENV=development`). Online
(`tests/e2e/19-online-producao.mjs`): saúde, cabeçalhos, `/planos`
canônico, 410 das rotas aposentadas, 301, adversarial, site em 5 tamanhos
(1366×768, 1440×900, 1920×1080, 390×844, 360×800) sem rolagem horizontal e
sem erro de console, admin por service token temporário (login, Visão
geral, Rede, Contas, Ofertas, Promoções, Eventos do Checkout, Mídia,
ficha do ponto e da tela, 390×844) — 0 falhas.

## 13. Teste adversarial (sem efeito colateral, em produção)

Webhook sem/with assinatura errada → 401; `/anunciantes/me*` sem sessão →
401; Player sem credencial → 401; `GET /plano/x` sem `X-Checkout-Key` →
401; convite inválido → 404; `/admin/*` sem Access → 302 pro login do
Cloudflare; rotas aposentadas → 410 (nunca 200/500). Unitários adversariais
já existentes: replay do webhook, corpo forjado com `conta_propria`, PATCH
de conta com campos proibidos → 400, duplo clique de assinatura, duas
substitutas, PK vs uid no Player.

## 14. Produção

Deploys desta estação, todos com build+rollout COMPLETED, purge do
Cloudflare e `/health` ok: `63952fb`, `89d73d4`, `1411abd`, `08ea4e8`,
`c6287fd`. Logs do serviço em 24/09 só com "rodando na porta 3000" (sem
erro). Migrations 088 e 089 aplicadas (release `npm run migrate`).

## 15. Cloudflare Access

Ligado durante toda a estação. Para o bloco do admin do roteiro online foi
criado um service token (`consolidacao-e2e-temporario`, 1 h) e uma policy
`non_identity` só pra ele na app do `/admin` do Mostraí; os dois foram
apagados no mesmo minuto em que o teste acabou. Estado final conferido pela
API: as duas apps (`/admin` do Mostraí e admin do Checkout) só com "Somente
o operador"; zero service tokens; `/admin` → 302 com e sem o token antigo.
(IDs das apps ficam fora do repositório — CONSTRAINTS.md.)

## 16. Banco

Supabase, migrations até 089. Leitura no fim: 4 contas (2 vigentes), 1
assinatura ativa + 3 canceladas + 1 trocada, 0 eventos pendentes, 2 pontos
(1 em operação, 1 aguardando instalação), 2 telas (1 V1 com sinal, 1 sem
credencial), 3 criativos aprovados, 0 vendedores/comissões, 1 convite
aberto (vendedor, #2, expira 29/09). **Nenhum dado apagado; banco não
resetado** — o reset final espera a auditoria Codex/Jules.

## 17. Dívida restante (não decisão)

P58 preço com desconto em 4 lugares; P77 "pagando em dia" em ~10 lugares;
P92 cinco cópias do fluxo de cancelar; P66 nomes de ciclo duplicados no
front; P69/P84 colunas internas expostas em `GET /planos` e `/me`; P136
cargas duplicadas na ficha; P128 subtítulo dos aliases antigos; P52
`avisarMudanca` em dois arquivos; migration 084 (zerar `aparelho_id`)
esperando a decisão da TV V1; `docs/teia.md` é histórico e cita funções
que saíram.

## 18. Decisões necessárias (do dono)

1. `public/comodato.html` §3 (texto jurídico) — PENDENCIAS J.1.
2. Termos §6 / Política de Privacidade ainda descrevem vendedor — PENDENCIAS §H.
3. TV V1 em campo além da tela 1? Se não: aposentar player web + auth por PK, rodar 084.
4. Convites e `POST /admin/anunciantes`: manter ou 410; revogar o convite #2.
5. Textos dos benefícios da vitrine: tela ou SQL.
6. Confirmação de e-mail como portão do backend; consentimento de novidades.
7. Promoção com prazo: preço sobe na Asaas ao vencer ou é vitalícia.
8. Banco de horas: manter (agendar apuração, tela da fila) ou aposentar.
9. Teto de cadastro de criativos: 3 fixos ou limite do plano.
10. Ponto 1 sem conta dona; ponto 3 sem tela preparada.
11. Compra real de ponta a ponta no sandbox com uma conta de teste (gera dado em produção).
12. Virada sandbox→produção (RUNBOOK §3.1) e reset final do banco — depois da auditoria.

## 19. Commits, SHA em produção e próxima etapa

PRs `#49` (C+D), `#50` (G+E), `#51` (H+F), `#52` (I-1), `#53` (I-2), `#54`
(roteiro online + docs de fechamento). **Deployed SHA**: `c6287fd` no
momento deste relatório (o `#54` sobe em seguida, sem mudança de código de
produto). Próxima etapa: auditoria externa (Codex/Jules) sobre este
relatório e o estado; decisões da seção 18; só então reset final do banco e
a Estação 6 (Prontidão).
