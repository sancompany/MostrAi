# Current Handoff

## Updated
2026-09-21

## Current priority
Revisão manual funcional e visual conduzida pelo dono. Ele já está aproximadamente na metade. Não reiniciar auditoria: receber a próxima observação, investigar transversalmente e fazer a menor correção coerente.

## Admin: Rede e Anunciantes reorganizados por entidade (21/09/2026, este agente)
Pedido do dono, spec fechada de 20 itens com screenshots do admin em produção:
o PONTO virou a entidade central de Rede (era 3 telas/abas separadas — Pontos,
Telas, Ocupação — cada uma com sua própria tabela) e a tabela de Anunciantes
foi simplificada (lista enxuta + detalhe por conta, ações saíram da linha).
Só reorganização administrativa/UX — **nenhuma relação de backend, rota, regra
de negócio ou autorização foi tocada**; cada função de render nova chama as
mesmas rotas de sempre.

**Rede:** `renderPontos` virou um dispatcher — grade de cards (`.ponto-card`,
foto grande quando existe, placeholder quando não) sem `pontoId` no hash, ou
`renderPontoDetalhe` com 3 sub-abas (Resumo/Telas/Ocupação) quando tem.
`renderOcupacaoPontos` (tela solta) foi deletada — virou a sub-aba Ocupação,
sempre filtrada a um ponto. Entrega/banco de horas **saiu do menu Rede**
(não existe mais como página administrativa independente) — a lógica de
backend (`src/bancohoras/`) não foi tocada, só a superfície de admin; a regra
"nunca crédito automático em dinheiro" que estava só no texto da tela deletada
já vive independentemente em `src/bancohoras/repository.js:115`.
Roteador do admin (`public/admin/index.page.js`, `resolverAlvo`/`irPara`/
`renderModulo`) ganhou um 3º segmento de hash (`resto`) pra isso — mecanismo
genérico, disponível pra qualquer módulo agora, não só Rede/Anunciantes.
Hashes antigos preservados via `ALIASES_ANTIGOS`: `#telas`→`rede/pontos`,
`#ocupacaopontos`→`rede/pontos`, `#bancohoras`→`rede/pontos` (a rota antiga
de Entrega não tem mais tela própria pra apontar; cai na grade de Pontos).

**Anunciantes:** lista caiu pra 7 colunas (nome/contato/ramo/plano/status/
entrada + badges de papel), sem os botões de ação nem o aviso laranja de
divergência de ciclo (que **continua existindo em Planos**, não foi apagado,
só duplicado — a chamada em Anunciantes foi removida, a de Planos ficou
intacta). Clicar na linha abre `renderAnuncianteDetalhe`: resumo completo +
os mesmos 4 botões de ação de sempre (Subir anúncio/Liberar plano/Marcar
parceiro/Cancelar assinatura), mesmas condições de disponibilidade, mesmas
rotas — só mudou de lugar na tela.

**Documento (CPF/CNPJ) normalizado na gravação, dali pra frente:**
`src/anunciantes/repository.js` (`criar`/`atualizar`) agora passa `cpf_cnpj`
por `limpar()` (`src/br/documento.js` — sem pontuação, maiúsculo, preserva
letra porque CNPJ é alfanumérico desde jul/2024) antes de gravar. Corrigido
na raiz (repository, não nas rotas) — cobre cadastro público, cadastro do
admin e convite de uma vez. **Contas já gravadas antes de hoje não foram
tocadas, nenhuma foi apagada, nenhum merge automático foi feito** — só o
comportamento novo, dali pra frente. Não há constraint `UNIQUE` em
`cpf_cnpj` hoje (confirmado antes de mexer — só `contato_email` é único), e
nenhuma foi criada agora: seria destrutivo sem antes tratar as duplicidades
existentes. Query pronta pra achar duplicidade por documento normalizado está
em `docs/PENDENCIAS.md`, seção G — **rodada contra o banco local não achou
nenhuma (é dado de sandbox); produção ainda não foi checada, fica registrado
como pendência, não resolvido aqui**.

**IDEIA FUTURA, explicitamente NÃO implementada agora** (só registrada, a
pedido do dono): reservar ~20% da capacidade de cada ponto pra conteúdo
institucional/estratégico (hoje é 100% comercial). Fica pra quando o dono
pedir — não mexer em playlist/pacing pra isso sem novo pedido.

**Verificado:** `npm test` (novo `tests/anunciantes-normalizacao-documento.test.js`,
3 casos: pontuação removida, letra de CNPJ alfanumérico preservada, edição
também normaliza), Playwright em desktop e mobile (grade com/sem foto, telas
0/1/muitas, as 3 sub-abas, lista e detalhe de Anunciantes, hashes antigos
redirecionando certo), `npm run lint`/`sintaxe`/`formato`.

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`.**

## Painel admin reorganizado: 25 telas → 12 módulos (21/09/2026, este agente)
Pedido do dono: reestruturar o admin inteiro (rascunho dele via GPT + pesquisa
de mercado + mapeamento do código real, tudo registrado em
`docs/specs/2026-09-21-redesenho-admin.md` e
`docs/specs/2026-09-21-admin-inventario-funcoes.md`), depois autorização direta
pra construir sem mais discussão item a item ("julgo olhando a tela").

**O que mudou, só isso:** navegação e agrupamento visual. `public/admin/index.page.js`
ganhou `MODULOS` (12 itens em 5 grupos: Mostraí/Operação/Comercial/Financeiro/Sistema)
no lugar do antigo `NAV` (25 itens em 5 grupos), um roteador novo (`irPara`,
`resolverAlvo`, `renderModulo`) e uma fileira de abas por módulo quando ele
agrupa mais de uma tela antiga. **Nenhuma função `render*()` foi reescrita** —
cada aba nova chama exatamente a função de antes, então toda edição inline,
toda regra de negócio e toda rota consumida continuam idênticas. Nova tela
`renderPendencias` (módulo "Pendências") reaproveita a mesma lista `ALERTAS`
e `RESUMO.filas` da Visão geral — nenhum dado novo.

**Compatibilidade:** os 25 hashes antigos (`#pontos`, `#criativos` etc.)
continuam abrindo a tela certa via `ALIASES_ANTIGOS` — nenhum `href="#x"` ou
`irPara('x')` espalhado pelas ~210 funções internas precisou mudar.
Verificado com Playwright: os 25 hashes antigos + os 12 módulos novos + todas
as sub-abas navegam certo, zero erro novo de console (só um CSP de estilo
inline pré-existente em `renderEventos`, não tocado).

**Bug achado e corrigido no caminho** (não estava no escopo, mas a própria
reorganização o expôs): `src/admin/metrica.js` comparava `p.status = 'ativo'`
num status que não existe desde a migration 045 — a amortização da aba
Performance (fundida com a Visão geral em abas) sempre dava zero, divergindo
do número certo da aba ao lado. Corrigido pra `p.status = 'em_operacao'`
(mesmo padrão já usado em `src/admin/routes.js`). `docs/erros/2026-09-21-metrica-amortizacao-status-errado.md`.

**Verificado, não só lido:** `npm run check` (125/125 testes) e toda a
bateria de `tests/e2e/` (01, 02, 03, 05, 06, 07, 08) contra Postgres local de
verdade + Chromium real. Dois ajustes nos próprios scripts de teste — `03-navegador.mjs`
e `05-navegador-modos.mjs` clicavam em `.nav-item[data-aba="x"]` (estrutura
antiga); passaram a navegar pelo hash antigo direto (`location.hash = 'x'`),
o que também serviu de teste real da promessa de compatibilidade.

**Dois achados pré-existentes, confirmados NÃO relacionados a esta mudança**
(já sabidos, não corrigidos, fora de escopo): `#navVendas` (03-navegador.mjs)
e `#navMeuPonto` (05-navegador-modos.mjs) — seletores do painel do
**anunciante**, removidos numa reestruturação de nav anterior (item 77 do
histórico desta sessão), scripts nunca atualizados depois. `tests/e2e/06-painel-bloqueio-plano.mjs`
também falha num rótulo renomeado ("Horas entregues no mês") no mesmo painel
— idem, já sabido, confirmado de novo agora.

**Deliberadamente fora desta rodada** (era o pedido original via GPT, mas o
dono cortou escopo — "tá muita coisa"): mover a edição densa de Pontos/Telas/Anunciantes/Comodato
pra página de detalhe com drawer; desduplicar o aviso de divergência de
ciclos e o texto "produto é do tier" (aparecem 3x: Planos, Anunciantes,
Comodato); o CSP inline-style pré-existente em Eventos/Diagnóstico. Tudo
com risco/decisão mapeado em `docs/specs/2026-09-21-redesenho-admin.md`,
seções 5 e 7, se um dia isso for retomado.

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`**
até o dono revisar visualmente — mesma regra que o rascunho do GPT já trazia.

## Advertiser dashboard redesigned
`public/anunciante/painel.html`, `painel.css` e `painel.page.js` agora formam um dashboard SaaS/AdTech responsivo: resumo executivo, KPIs, performance, relatório por ponto, cobertura positiva, biblioteca de criativos, pagamentos e candidatura recolhida sob CTA. Foram preservados endpoints, IDs funcionais, cálculos, filtros, comprovante, upload/exclusão, plano e candidatura. Validado com dados simulados realistas em Chromium nos viewports 1440×1000, 1280×800, 768×1024 e 390×844, sem erro de console nem overflow da página. Screenshots temporárias: `/tmp/painel-{desktop,notebook,tablet,mobile}.png` (não versionadas).

## Card "Faça parte da rede" — movimento obrigatório + segmento resolvido (21/09/2026, este agente)
Pedido direto do dono, depois da rodada de design acima: no card de candidatura a ponto do fim do painel (`montarCardPonto`, `painel.page.js`), "Movimento médio mensal" virou obrigatório (era opcional) — required no HTML e checado de novo no backend (`POST /conta/modos/:papel/pedir`, `src/conta/modos.js`), defesa em profundidade pra quem chamar a rota direto. Layout trocou o `field-row` de duas colunas (desalinhava rótulo/campo por causa do textarea vizinho) por dois campos empilhados. Rótulo alinhado com o mesmo campo em `public/modos.js` ("Média de pessoas que passam por mês"). Achado no caminho: `segmento` só olhava `categoria_livre` — conta que respondeu o ramo pelo catálogo fixo (`categoria_id`) mandava segmento vazio e caía em "outro" no admin sem motivo. Backend agora resolve os dois casos (`categoria_livre` direto, ou busca o nome por `categoria_id`); o front não manda mais esse campo. Teste `tests/e2e/08-candidatura-ponto.mjs` (9 checagens, os dois casos de segmento). Mergeado em `main` e verificado em produção.

**Achado fora de escopo, não corrigido:** `tests/e2e/03-navegador.mjs` quebra num seletor `#navVendas` que não existe desde a remoção da aba Vendas do topo (sessão anterior) — pré-existente, script nunca foi atualizado depois daquela mudança. As outras 17 checagens do script passam.

## Advertiser dashboard — segunda camada de refinamento (21/09/2026, este agente)
Depois de discussão em três pontas (dono, este agente e GPT, com pauta escrita explicitamente proibindo código até o dono autorizar) sobre o que o redesign do Codex deixou solto, o dono autorizou implementar. Mudou:
- **Marca**: as 2 ocorrências de "MostrAi" sem acento que existiam no texto do cliente (só nesta página) viraram "Mostraí", igual ao resto do produto (170 ocorrências).
- **Paleta**: o hero deixou de ser azul-marinho (`#172a46`→`#245b94`, cor que não existe em mais lugar nenhum) e virou laranja queimado escuro dentro da rampa de `--brand` (parado em `#9c4506` por contraste WCAG AA — branco sobre `--brand` puro dá só 2,3:1). Azuis escritos à mão em ícone/aviso/borda viraram tokens do design system.
- **Hero**: a faixa de 4 métricas (Plano/Horas/Exibições/Pontos), que duplicava os cards de "Resumo da campanha" logo abaixo, saiu. No lugar entrou um estado operacional — quantos pontos estão dando sinal agora e, se algum estiver fora do ar, há quanto tempo (mesmo limiar `HORAS_OFFLINE_ALERTA` que a tabela de pontos já usa).
- **Métricas**: "contratado" virou "previstas" (o número é derivado da duração do criativo, não uma promessa fixa); "Custo por exibição" (sempre R$ 0,01, ilegível) virou "Custo por 1.000 exibições" (mesma fórmula ×1000 no front, não é CPM — o Mostraí não mede audiência); média diária passou a dividir pelos dias decorridos desde o início real da campanha no mês, não pelo dia do mês (bug real: campanha nova aparecia com média artificialmente baixa); a barra de "Exibições por ponto" some com 1 ponto só (é sempre 100% por definição).
- Arquivos: `painel.css`, `painel.html`, `painel.page.js`, `src/anunciantes/routes.js` (nova query + cálculo de `mediaDiariaMes`), `docs/api.md`. Teste novo `tests/e2e/07-painel-design.mjs` (17 checagens). `npm run check` 125/125. Mergeado em `main` (fast-forward, sem conflito) e **verificado em produção** (`mostrai.sancocore.com.br`, `/health` 200, CSS/HTML/JS com a versão nova em múltiplas requisições — não numa só, porque a primeira bateu num nó de borda da Cloudflare ainda com cache antigo).
- **O que ficou pra depois, ainda em discussão com o GPT**: retomada de índice do app Android TV não é isso — não confundir; aqui os itens em aberto da PRÓPRIA discussão do painel foram: "1 de 7 escolhidos" (semântica conferida — são contagens diferentes, badge ganhou "· P em operação", mas não houve pedido pra ir além disso); card de "criativos" com métrica por peça (bloqueado — `exibicoes_contador` não tem `criativo_id`, só existe depois que o app de TV mandar o contrato de proof-of-play).

## Functional map
Inventário de site público, conta, anunciante, ponto, vendedor, player, Checkout, 25 seções admin e jobs em `docs/mapa-funcional-completo-2026-09-20.md`.

## Public review synchronized
Termos de Uso agora refletem o produto atual: conta nasce anunciante e vendedor só por convite; cobertura/vigência começam no pagamento sem espera por ponto; cancelamento é feito no painel; tempo é reservado por hora e a projeção mensal usa referência de 12h/dia.

## Infrastructure incident already resolved
Em 20/09/2026 a produção caiu porque a senha do Postgres foi trocada no Supabase sem atualizar `DATABASE_URL` no serviço e nos jobs Northflank. Foi corrigida nos três lugares; site, admin, `Conciliacao` e `Backup` foram confirmados. Detalhe: `docs/erros/2026-09-20-senha-do-postgres-divergente-entre-supabase-e-northflank.md`. Também foi confirmado que `ApuracaoBancoHoras` não existe no Northflank.

## Confirmed finding not fixed
`src/admin/metrica.js` usa o status antigo `p.status = 'ativo'` na amortização histórica. Pontos atuais usam `em_operacao`; a aba Métrica zera amortização e pode inflar margem. Visão geral está correta. Tratar quando o dono chegar nessa tela ou autorizar.

## Paused until explicit request
Player/proof-of-play, banco de horas/déficit físico e troca proporcional. A ideia de banco de horas nos dois sentidos está em `docs/proximas-versoes.md`. Manter tudo registrado e não trabalhar espontaneamente. A concorrência da playlist saiu desta lista porque o dono autorizou e ela foi corrigida nesta sessão.

## Existing temporary diagnostic
`?debug=1` no player permanece disponível, mas não retomar teste/correção sem pedido.

## Playlist concurrency fixed
Após o dono confirmar que `&debug=1` funcionou na TV e autorizar retomar o caminho da playlist, as duas corridas do congelamento foram corrigidas. `src/playlist/congelamento-repository.js` agora serializa base e extras com advisory lock transacional por `(dispositivo, hora)`; `gerador.js` sempre monta a resposta a partir da base efetivamente vencedora. As regras da ADR-005 permanecem: base não muda, novos participantes entram no fim, repetições da frequência são legítimas. Testes em `tests/playlist-congelamento.test.js`. Não houve mudança em `/played`, métricas ou banco de horas.

## Do not undo
- Não recolocar cache em memória na playlist.
- Não restaurar Vendas/Meu ponto no topo.
- Não mudar custo por exibição para dividir pelo confirmado.
- Não editar migration aplicada nem versionar segredo.

## Next action
Aguardar a próxima tela/observação do dono. Classificar como bug, inconsistência, melhoria visual, decisão, legado ou não confirmado; checar impactos laterais antes de alterar.

## Plano do dono para os próximos dias (21/09/2026)
Ordem que ele deu: (1) terminar a revisão do painel admin e do painel do anunciante — o redesign do Codex "melhorou muito" mas não bateu 100%, **principalmente a parte visual**; ele pediu explicitamente pra ESTE agente (Claude) corrigir isso, não o Codex — em especial **voltar as cores pra paleta própria do Mostraí** (laranja `#ff7a1a`, ver `theme-color` nos HTMLs e `public/style.css`) onde o redesign tiver se afastado dela; (2) terminar o app Android TV da playlist (`docs/proximas-versoes.md`, "App Android TV nativo..."); (3) **trocar o San Checkout de sandbox pra produção** — não investigado ainda se é config do lado do Mostraí (`SAN_CHECKOUT_*` já parecem apontar pra domínio de produção, `sancocore.com.br` — conferir antes de assumir) ou decisão só do lado de quem administra o Checkout; (4) finalizar os testes. Estimativa dele: ~2 dias de trabalho até poder vender; depois disso "só vai sobrar ir atrás do anunciante" (prospecção, fora do escopo de código).

## Item em aberto, agora especificado mas DEFERIDO — não implementar sem novo pedido (21/09/2026)
A "promoção de trazer gente de fora" mencionada antes (e que ficava sem detalhe) foi explicada pelo dono: dá um **crédito pro comodato**, e **quanto mais crédito, mais o plano do ponto sobe de nível**. Ele foi explícito: "**fica pendente também**" — não construir agora. Antes de começar quando ele pedir, checar contra o que já existe (pode ser extensão do `src/indicacoes/` — que já libera upgrade de plano por indicação em 3 limiares — ou algo separado ligado ao comodato/`credito_comodato_mensal`); não assumir qual dos dois sem perguntar, o mecanismo exato (o que conta como "trazer gente de fora", quanto vale cada crédito, a curva de nível) não foi dado.

## Revisão visual/funcional das telas — três ainda faltam (21/09/2026)
Depois do painel do anunciante fechado nesta sessão, o dono listou o que falta revisar: **1) painel admin, 2) painel do ponto/comodato, 3) painel do vendedor**. Sem pedido de começar ainda — só registrado pra não perder a ordem.

**Item já pautado pra quando a revisão do admin começar:** conta própria virar preenchimento elástico do vazio da hora (não frequência fixa) e configuração por criativo (alcance + frequência/"plano" por peça, não por conta) — ver `docs/proximas-versoes.md`, "Conta própria vira preenchimento elástico do vazio, configurada por criativo". Nasceu de uma investigação desta sessão sobre por que o cartão institucional aparece tanto — não era bug, era o desenho atual (RN-40) mesmo, e o dono decidiu mudar. **Correção (21/09/2026, mesma sessão):** este handoff chegou a afirmar que a aba "Meus anúncios" do admin estava quebrada por listar só `pendente`. **Era falso alarme** — só o *default* da rota é `pendente` (`src/admin/routes.js:16`); a aba pede `?status=todos` (`public/admin/index.page.js:718`) e o repositório trata isso (`src/anunciantes/criativos-repository.js:52-56`). O bug real existiu e foi corrigido em `7b4d173` (15/09/2026). Não "consertar" de novo o que já está certo — se a aba estiver vazia, checar se a conta própria existe e se tem criativo enviado.

## margemVmin — reafirmado que precisa ser por lado (4 valores), não só por tela (21/09/2026)
O dono apontou de novo: `margemVmin` tem que vir do admin (por tela), e como
**4 valores independentes** (um por lado — topo/base/esquerda/direita), não
um número só igual nos 4 lados. A ideia já estava registrada em
`docs/proximas-versoes.md` ("Margem e orientação por tela configuráveis no
admin, não só na URL") pensando no player web; esta sessão atualizou essa
entrada pra também cobrir o app Android nativo (que reproduz o mesmo
problema: `ConfigAparelho.margemVmin`/`ConfigExterna.Dados.margemVmin` são
um `Float` único aplicado igual nos 4 lados por
`PlayerActivity.aplicarMargemOverscan()`). Espelhado em
`sancompany/playlist.mostrai` (`docs/pendencias.md` e
`docs/proximas-versoes.md`), reconciliando com um registro concorrente que
outra sessão já tinha feito lá (faltava a nuance dos 4 lados). **Nada
implementado** — só registro, como pedido.

## playlist.mostrai — entrega de provisionamento revisada, nada a mudar aqui (21/09/2026)
A outra sessão entregou `ConfigExterna` (lê `mostrai-config.json` de um pendrive/volume externo montado, mesmos 5 campos do provisionamento por `adb`/build embutido). Conferido: é 100% client-side, nenhuma chamada nova ao backend, nenhum campo que o `sancompany/mostrai` precise passar a aceitar. Build + 53 testes verdes localmente (SDK Android montado em `/opt/android-sdk` nesta sessão pra verificar de verdade, não só ler). PR #1 (`playlist.mostrai`) segue em draft, aguardando o dono testar em hardware real.
