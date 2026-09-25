# PROJECT_STATE.md — Estado exato do Mostraí

Levantado em 20/09/2026, a partir do código e do Git — não de memória de
conversa. Ver `.ia/HANDOFF.md` para o que fazer a seguir; este arquivo é o
retrato, não o próximo passo.

## Branch e Git

- Branch de desenvolvimento designada: `claude/busy-noether-hheir2`.
- `main` e `claude/busy-noether-hheir2` estão sincronizadas no commit
  `b3fe101` ("nav: tira Vendas e Meu ponto do topo, Anúncios vira Painel,
  ponto ganha card de candidatura simplificado").
- Existe uma terceira branch remota, `claude/mostrai-estacao-1-pipeline-y2vgr5`
  (commit `44929d6`, "Adiciona Dockerfile de producao para o Northflank"),
  — conferida em 25/09/2026: já está inteira no `main` (0 commits próprios);
  listada para exclusão em `docs/FECHAMENTO_PRE_GATES_2026-09-25.md` §14.
- `npm run check` (sintaxe + lint + formato + 122 testes unitários) verde no
  commit acima.
- CI (`.github/workflows/ci.yml`) roda o mesmo `npm run check` a cada push/PR
  na `main`.

## Estação da esteira San & Co.

Estação **5 — Construção**, aberta 14/09/2026. No ar em produção desde
15/09/2026 (`mostrai.sancocore.com.br`). Falta só a rodada de depuração da
seção F de `docs/PENDENCIAS.md` — o dono revisa o produto no ar e reporta
ajuste; a estação fecha com o nível que ele aceitar. Ver `CLAUDE.md`.

## Funcionalidades concluídas (confirmadas no código, testadas)

- Cadastro/login de conta única, três papéis possíveis.
- Catálogo de planos no banco: Essencial/Pro/Prime × 4 ciclos, sem regra em
  variável de ambiente (Inicial/Básico ficaram `ativo=false`, só histórico —
  ADR-016). Ponto com tela ativa gera +1 crédito/mês (migration 082).
- Assinatura, troca de plano e cancelamento via San Checkout (webhook
  fail-closed/idempotente/transacional).
- Upload de criativo com validação síncrona (ffmpeg), normalização de
  imagem para vídeo na duração do plano, aprovação manual pelo admin.
- Geração de playlist por hora com orçamento em segundos, cobertura de
  pontos com compensação de rede incompleta, banco de horas como obrigação
  de veiculação (25/09/2026: volta só no tempo ocioso, só o confirmado abate
  o saldo, sem expiração — a válvula saiu).
- **Congelamento da hora da playlist** (19/09/2026, o mais recente) —
  escolha de ponto ou criativo aprovado entra na hora corrente sem
  reposicionar quem já estava programado. Testado manualmente
  (`.ia/DECISIONS.md`, ADR-005). Em 20/09/2026, a criação da base e a
  anexação de extras foram serializadas por tela/hora no PostgreSQL para
  impedir bases divergentes e levas duplicadas; há cobertura dedicada em
  `tests/playlist-congelamento.test.js`.
- Painel do anunciante: bloqueio total sem plano, KPIs (horas/exibições
  contratadas vs. entregues, custo por exibição fixo, banco de horas),
  gráficos por dia/ponto, escolha de pontos compacta com busca. Redesenhado
  visualmente em 21/09/2026 como dashboard SaaS/AdTech responsivo, sem mudar
  contratos nem cálculos; estados vazios e listas extensas foram mantidos
  utilizáveis.
- **Nav consolidada numa aba só ("Painel")** (19/09/2026) — Vendas e Meu
  ponto saíram do topo; candidatura a ponto virou card simplificado no fim
  do Painel; link para quem já é vendedor/ponto. Testado com Playwright
  (script descartável, não commitado — ver `.ia/OPERATIONS.md`).
- Indicação de ponto com cupom e upgrade automático de plano por limiar.
- Comissão de vendedor (entrada só por convite direto do dono).
- Painel administrativo: contas, candidaturas, convites, pontos, telas,
  criativos, dinheiro, banco de horas, resumo com margem real.
- Direitos do titular de dados (LGPD) — `src/titular/`.

## Funcionalidades parcialmente concluídas / com lacuna conhecida

- **Filtro de categoria concorrente na playlist** — a lógica existe
  (`anunciantesElegiveis` exclui anunciante com a mesma `categoria_id` do
  ponto), mas **nenhum caminho de criação de ponto grava `categoria_id`**
  hoje — na prática o filtro nunca exclui ninguém. Furo já catalogado em
  `docs/furos.md`. Ver `.ia/RISKS.md` e `.ia/TODO.md`.
- ~~**Job `ApuracaoBancoHoras` no Northflank** — não existe~~ — **criado em
  25/09/2026**, pela especificação de `docs/job-apuracao-banco-horas.md`;
  1ª execução manual (`--dry-run`) rodou com sucesso.
- **Bônus "ganhou uma tela" (`cardBonus`, qual='ponto') no Painel** —
  `GET /conta/modos` sempre devolve `bonus.ponto: null` por design atual
  (comentário no próprio código, `src/conta/modos.js`), então esse banner
  nunca aparece em `/anunciante/painel.html` hoje — não investigado se isso
  é intencional ou lacuna; não presumir nenhum dos dois sem checar com o
  dono ou reler o histórico do commit que introduziu isso.

## Funcionalidades/bugs em aberto (não resolvidos, com investigação registrada)

- **"Anúncio nunca passou na TV" (relato do dono, conta "San União", único
  ponto da rede hoje)** — investigado nesta sessão, causa **ainda não
  confirmada**. Seis hipóteses de causas comuns foram checadas no código e
  **descartadas** (upload/normalização síncrona sem estado quebrado
  possível; filtro de categoria já é sabidamente inofensivo por outro furo;
  fila de aprovação já tem contador visível no admin, entre outras). Não
  houve acesso de leitura aprovado ao banco de produção (Supabase) para
  confirmar a causa real nesta sessão. Ver `.ia/TODO.md` (seção BUGS) para
  o checklist específico ainda pendente de resposta do dono ou de acesso
  liberado ao banco.
- **Troca de plano falhando com "não foi possível calcular o acerto
  proporcional desta troca"** — investigado a fundo nesta sessão,
  incluindo leitura do código-fonte real do `sancompany/san_checkout`
  (clonado à parte). Concluído que os três valores que o Mostraí envia
  (`planoId`, `planoNovoId`, `documento`) estão corretos, e a falha é uma
  condição de `dadoIncoerente` dentro de `calcularAcertoDeTroca`
  (`proporcionalService.js` do Checkout) — aponta pra dado de assinatura
  do lado do Checkout (ciclo/data de vencimento divergente, ou cobrança
  confirmada faltando), não um bug do Mostraí. **Não é possível fechar essa
  investigação sem acesso ao banco do San Checkout** (projeto Supabase
  separado, `San_Checkout` — ref/host não registrado aqui, ver
  `.ia/INTEGRATIONS.md`) para a assinatura específica afetada.

## Telas existentes

Ver `docs/api.md` (mapa rota-a-rota) e `docs/funcional.md` (tabela tela-a-
tela) — fonte de verdade, não duplicada aqui.

## Banco / migrations

Arquivos SQL em `src/db/migrations/`, numerados até `069`. Mais recente:
`069_status_automatico_e_margens_da_tela.sql` (4 valores de `pontos.status`,
status automático via `sincronizarStatusPonto`, margens de safe area por
tela). Aplicadas por `src/db/migrate.js`, idempotente, com
`pg_advisory_lock`.

## Integrações — estado observado

- **Supabase** (Postgres + Storage): funcionando, confirmado via ferramenta
  MCP nesta sessão (dois projetos existem: `MostrAi` e `San_Checkout`).
- **San Checkout**: funcionando para assinatura nova; troca de plano com
  falha pontual não resolvida (ver acima).
- **Cloudflare Access em `/admin`**: confirmado ativo desde 15/09/2026.
- **Northflank**: deploy automático confirmado funcionando (deploys desta
  sessão verificados em produção via `/health` e strings distintas nos
  arquivos publicados).
- **SMTP (Google)**: funcionando; resposta sai do endereço real, não do
  alias (cosmético, aceito pelo dono).

## Última área trabalhada

Nesta sessão, em ordem: KPIs do Painel → seleção de pontos compacta →
correção de revezamento de criativos + duração de imagem → texto de troca
de plano → **congelamento da hora da playlist** → nav consolidada numa aba
só + candidatura a ponto simplificada → **esta tarefa** (estrutura `.ia/` de
memória entre agentes).

## Principais pendências (fora as duas acima)

Ver `docs/PENDENCIAS.md` seção F (rodada de depuração aberta com o dono) e
`.ia/TODO.md` para a lista organizada por urgência.

## Atualização — auditoria transversal de 20/09/2026

Relatório completo: `docs/auditoria-estacao-5-2026-09-20.md`.

- Produção confirmou que o anúncio investigado tem a cadeia de elegibilidade completa e foi programado muitas vezes, mas quase nada foi confirmado; a TV estava sem heartbeat recente. O foco passa a player/mídia/rede/confirmação.
- O player envia `/played` no início e ignora erro/resposta. Banco de horas é drenado/apurado por programação em vez de confirmação: inconsistência sistêmica de “entrega”.
- As corridas antes identificadas no congelamento 064 foram fechadas em
  20/09/2026 com lock transacional por tela/hora e teste dedicado.
- O ponto de produção possui `categoria_id`, e o código atual o grava por cadastro/admin. A afirmação anterior de que nenhum caminho gravava categoria está desatualizada.
- ~~`npm audit` reporta 10 vulnerabilidades~~ — 0 desde 25/09/2026 (PR #61).

## Investigação player/TV — 20/09/2026

Fluxo reconstruído em `docs/investigacao-player-confirmacao-2026-09-20.md`. Confirmado: `/played` sai logo após `play()` e não após `ended`; resposta é ignorada, sem retry/idempotência/identidade de peça ou janela. Imagens já são MP4 no player. A conclusão anterior sobre banco foi refinada: ele mede corte de capacidade (`pedidas - programadas`) por desenho; falha física (`programadas - confirmadas`) é separada e depende de decisão de produto.

## Admin Rede/Anunciantes reorganizados por entidade — 21/09/2026

`public/admin/index.page.js`: Rede virou grade de cards de ponto (foto
grande) com detalhe por ponto (Resumo/Telas/Ocupação em sub-abas); Entrega/
banco de horas saiu do menu (lógica de backend intacta). Anunciantes virou
lista enxuta + detalhe por conta (ações saíram da linha da tabela). Roteador
do admin ganhou um 3º segmento de hash genérico (`resto`). CPF/CNPJ agora é
normalizado (`src/br/documento.js#limpar`) em `src/anunciantes/repository.js`
na gravação (`criar`/`atualizar`) — só dali pra frente, nenhuma conta antiga
tocada, nenhuma constraint nova. Detalhe completo em `.ia/HANDOFF.md`. Ainda
na branch `claude/busy-noether-hheir2`, aguardando revisão do dono.
**Pendência aberta:** contas históricas duplicadas por documento (mesmo CPF/
CNPJ com formatação diferente) não foram consolidadas — query de diagnóstico
em `docs/PENDENCIAS.md` seção G; produção ainda não foi checada.
**Ideia futura registrada, não construída:** reserva de ~20% da capacidade
dos pontos pra conteúdo institucional/estratégico.

## Contrato novo de playlist/played pro app Android nativo — 21/09/2026

Lado do Mostraí do contrato que `sancompany/playlist.mostrai` (app Android
TV nativo, projeto separado) já sabia consumir. `dispositivos.contrato_playlist`
(migration 065, padrão 1) decide por tela se `/playlist` devolve o array de
sempre ou o envelope novo (`versaoContrato`/`janelaId`/`itemProgramacaoId`/
`criativoId`); `/played` aceita lote deduplicado por `execucaoId`, com ledger
próprio (`execucoes_confirmadas`) creditado na mesma transação. Nenhuma tela
de produção foi migrada pro contrato novo ainda — isso é passo separado,
depois do app ser confirmado rodando em hardware real. Player web e o
repositório do app não foram tocados. Detalhe em `.ia/HANDOFF.md` e
`docs/PENDENCIAS.md` seção H. `npm run check` 133/133. Ainda na branch
`claude/busy-noether-hheir2`.

## Redesenho da tela Rede do admin — 22/09/2026

`public/admin/index.page.js`: Rede virou grade de cards (foto/placeholder,
status visual derivado — Aguardando instalação/TV instalada/Em operação,
sem mudar `pontos.status` real) com ficha somente-leitura por ponto +
painel de Instalação (único trecho editável fora de Telas). Ocupação saiu
da aba por ponto e virou painel agregado na Visão geral, mesmo cálculo de
sempre (G.7). Cadastro manual de ponto (UI e rota `POST /admin/pontos`)
removido — sem consumidor real. Migration 067 fecha os 2 furos do pipeline
candidatura→ponto (foto da fachada, "algo a mais" → observações). Detalhe
completo em `.ia/HANDOFF.md` e `docs/PENDENCIAS.md` seção K. Divergência
real encontrada e documentada (não corrigida): a regra "80% comercial/20%
reservado" que o dono descreveu não existe assim no código — ver
`.ia/DECISIONS.md` ADR-008. `npm run check` 153/153. Ainda na branch
`claude/wonderful-hypatia-i7y4xx`, aguardando revisão do dono.

## Mapa funcional completo — 20/09/2026

Inventário atual de todas as funcionalidades de usuário, admin e operação em `docs/mapa-funcional-completo-2026-09-20.md`. Novo bug confirmado: a aba admin Métrica usa status antigo de ponto ao calcular amortização histórica e pode inflar margem; Visão geral usa a regra correta. Bugs técnicos previamente mapeados continuam pausados. Prioridade é acompanhar a revisão manual já em andamento pelo dono.

## Rede, rodada final do admin — 22/09/2026

Prompt de 35 seções do dono, considerado a especificação definitiva da tela
Rede — substitui as decisões de instalação/ACM/status intermediários das
rodadas anteriores (21-22/09/2026, seções G/L de `docs/PENDENCIAS.md`).
Mudança central: **`pontos.status` virou automático e real no banco**
(migration 069, 4 valores — `a_instalar`/`em_operacao`/`em_reparo`/
`inativo` — escritos só por `sincronizarStatusPonto`, derivado de
`dispositivos.status`), substituindo o "status visual sem 3º valor no
banco" da rodada anterior. Instalação/ACM saíram do admin de vez. Telas
viraram cards com margens de safe area (chegam no player pelo heartbeat).
Ocupação da rede virou tabela operacional (antes: painel agregado com
lista simples). Candidatura recebeu acabamento final (foto no topo,
formulário em blocos). Detalhe completo, inclusive o mapeamento de todo
consumidor de `pontos.status` e as duas correções de comportamento
encontradas no caminho (device recém-criado nasce `inativo`, ponto
nascido de candidatura não ganha mais uma "Tela 1" vazia automática; e
`em_reparo` passou a contar como escolha válida pro anunciante e como
visível no site público, igual `a_instalar` já era): `.ia/HANDOFF.md`,
`.ia/DECISIONS.md` (ADR novo) e `docs/PENDENCIAS.md` seção M. `npm run
check` 161/161 (5 testes reescritos em `tests/redesenho-rede.test.js`,
2 testes de playlist ajustados pro novo default de `dispositivos.status`).
`tests/e2e/09-rede-redesenho.mjs` reescrito por completo pro modelo novo,
58 checagens, 0 falhas. Branch `claude/wonderful-hypatia-i7y4xx`,
aguardando revisão do dono — por pedido explícito do prompt, esta é a
ÚLTIMA rodada de redesenho da Rede (não propor novo redesenho depois
desta, só ajustes pontuais que o dono pedir).

## Player V2 — integração definitiva (24/09/2026)

Backend do contrato V2 do Mostraí Player construído, V1 mantido. Migration
083 (a mais recente; 081 e 082 são do ledger de créditos, de outros PRs). Rotas do Player: `/player/provisionar`,
`/player/:id/hello`, `/heartbeat`, `/config`, `/played` (lote),
`/playlist/:id` (envelope V2 com `contentHash`). Admin: Rede → Ponto → Tela
(ficha em 5 blocos) e Rede → Versões do Player. Saúde da tela só em
`src/lib/status-tela.js`. Detalhe e o que falta: `.ia/HANDOFF.md` (topo) e
`docs/PENDENCIAS.md`, seção "Player V2".
