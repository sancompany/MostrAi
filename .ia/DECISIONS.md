# DECISIONS.md — Decisões reais do Mostraí (ADRs)

Registradas especialmente porque um agente novo, vendo só o código, poderia
tentar "corrigir" alguma delas sem necessidade. Datas são as do commit/
comentário no código, não de hoje.

## ADR-001 — Sem ORM, SQL cru com `pg`

Status: Ativa.

Contexto: o projeto é pequeno (uma cidade, uma rede de telas) e as consultas
têm lógica de negócio específica (orçamento de segundos, sorteio estável,
cobertura) que um ORM genérico não expressaria melhor que SQL direto.

Decisão: toda operação de banco é uma função em `<domínio>/repository.js`
com SQL parametrizado (`$1, $2, ...`), nunca concatenação de string, nunca
ORM.

Motivo: controle total sobre a query, sem camada de tradução a mais para
depurar; o time é pequeno o bastante para isso não virar dívida de
manutenção.

Consequências: quem chega de um projeto com Prisma/Sequelize/Knex estranha
a ausência — não é lacuna, é escolha. Não adicionar um ORM "de passagem"
numa tarefa que não pediu isso.

## ADR-002 — Frontend sem build, sem framework

Status: Ativa.

Contexto: site institucional + painéis simples, sem necessidade de estado
complexo de UI nem de SPA de verdade.

Decisão: HTML + JS puro por página (`<nome>.html` + `<nome>.page.js`),
componentes mínimos compartilhados via `<script src>` (`layout.js`,
`modos.js`, `perfil.js`, `config.js`).

Motivo: zero etapa de build significa que qualquer editor de texto e um
navegador bastam para testar; deploy é servir arquivos estáticos direto do
Express.

Consequências: não introduzir React/Vue/bundler numa tarefa que não pediu
isso explicitamente — mudaria a natureza do projeto inteiro, não é ajuste
pontual.

## ADR-003 — Sessão em Postgres, nunca `MemoryStore`

Status: Ativa. Erro documentado: `docs/erros/2026-09-sessao-em-memoria.md`.

Contexto: `MemoryStore` do `express-session` perde todas as sessões a cada
restart/deploy do processo — e o Northflank reinicia o container a cada
deploy.

Decisão: `connect-pg-simple`, tabela `session` no mesmo Postgres da
aplicação.

Motivo: deploy (que acontece a cada push na `main`) não pode deslogar todo
mundo.

Consequências: nunca trocar por `MemoryStore` "para simplificar" nem por
outro store sem entender esse motivo primeiro.

## ADR-004 — Playlist sem cache em memória; ordem por semente determinística

Status: Ativa desde 17/09/2026. Complementada pelo congelamento (ADR-005).

Contexto: até 16/09/2026 o gerador contava "slots" (cópias de cada
anunciante) sem relação com os 3600 segundos reais da hora — o mesmo plano
entregava números diferentes conforme o tamanho da rede. Corrigir isso pediu
recalcular a hora como orçamento de segundos; fazer esse cálculo caro a cada
poll do player (a cada 15 min) parecia pedir um cache em memória do
processo — mas cache em memória por processo não sobrevive a mais de uma
instância nem a um restart, e cada instância cachearia uma ordem diferente.

Decisão: `GET /playlist/:dispositivoId` **não usa cache nenhum** — recalcula
do zero a cada request. A estabilidade dentro da mesma hora vem de um
embaralhamento/espalhamento **determinístico**, semeado por
`(dispositivo.id, hora ISO)` (`src/lib/pacing.js`). Mesma tela, mesma hora,
mesma ordem sempre, em qualquer instância, mesmo depois de reiniciar.

Motivo: elimina a necessidade de cache (e portanto de sincronizar cache
entre instâncias) sem perder estabilidade visual pro espectador da TV.

Consequências: **`RUNBOOK.md` (seção 8) e o veto contra Edge Function em
`CONSTRAINTS.md` ainda mencionam "cache em memória por processo" como se
fosse o desenho atual — isso é documentação desatualizada, não uma
descrição do código de hoje.** Um agente que ler só esses dois arquivos vai
descrever a arquitetura errada. Ver `.ia/RISKS.md` para o registro desse
drift (a correção desses dois arquivos não foi feita nesta tarefa porque
`CONSTRAINTS.md` é documento de governança da San & Co., fora do escopo de
uma tarefa de scaffolding — mas `RUNBOOK.md` foi corrigido).

## ADR-005 — Congelamento da hora da playlist (19/09/2026)

Status: Ativa. Migration `064_playlist_hora_congelada.sql`.

Contexto: mesmo sem cache (ADR-004), cada poll do player recalculava a hora
inteira do zero — e qualquer mudança de composição (ponto escolhido,
criativo aprovado, saldo do banco de horas drenando) alterava o TOTAL de
participantes, o que faz o embaralhamento/espalhamento reposicionar TODO
MUNDO, não só quem chegou depois. O dono pediu explicitamente que uma
escolha de ponto nova entrasse "no meio da hora", sempre no fim da lista,
sem empurrar quem já estava rodando.

Decisão: a primeira geração de cada hora (por tela) grava a `entrada` usada
em `playlist_hora_congelada` (dispositivo + hora). Gerações seguintes da
mesma hora reprocessam **a mesma base congelada** pela mesma semente (saída
idêntica, é uma função pura) e só anexam, ao final, quem passou a ser
elegível depois — sem corte proporcional (pede exatamente o que teria
direito).

Motivo: satisfaz "sempre no fim" de forma exata, sem precisar reintroduzir
cache em memória nem quebrar a garantia de "mesma sequência, qualquer
instância" da ADR-004 (o congelamento é uma tabela no Postgres, não memória
de processo — continua funcionando com múltiplas instâncias).

Consequências: isto NÃO é o "cache em memória" antigo (ADR-004) voltando —
é uma tabela de estado explícita, com uma linha por (tela, hora), e existe
só para congelar a ORDEM, não para evitar reconsultar o banco. Um agente
que veja `playlist_hora_congelada` e pense "ah, voltou o cache que a
ADR-004 proibiu" está enganado — são mecanismos diferentes, resolvendo
problemas diferentes. Efeito colateral aceito: banco de horas e déficit
para participantes já congelados continuam sendo recalculados a cada poll
com base em dado fresco (não congelado) — só a ORDEM/composição da base é
que fica fixa; ver `docs/teia.md`, entrada "Congelamento da hora da
playlist".

**Reforço de concorrência (20/09/2026):** criação da base e anexação de
extras são serializadas por um `pg_advisory_xact_lock` transacional com a
chave `(dispositivo, hora)`. A requisição que chegar depois obrigatoriamente
relê a base vencedora sob o lock; a decisão e a gravação da nova leva de
extras acontecem na mesma transação. Isso preserva todas as regras acima e
fecha duas corridas: respostas com bases iniciais diferentes e duplicação de
uma mesma leva de extras. O lock é por tela/hora, não global.

## ADR-006 — `anunciantes` é a tabela de contas; nunca renomear

Status: Ativa (veto formal em `CONSTRAINTS.md`).

Contexto: o nome é histórico — a tabela nasceu só para anunciantes, antes
de existir o conceito de papéis múltiplos (ponto, vendedor).

Decisão: manter o nome `anunciantes` para a tabela de contas, mesmo
representando qualquer papel hoje.

Motivo: renomear tocaria o sistema inteiro (todo `anunciante_id`,
`req.session.anuncianteId`, nomes de rota) sem ganho funcional nenhum.

Consequências: não proponha o rename. `papeis text[]` é onde vive a
informação real de "o que essa conta é".

## ADR-007 — Custo por exibição divide pelo contratado, não pelo confirmado

Status: Ativa desde 19/09/2026 (reversão explícita de um design anterior no
mesmo dia).

Contexto: dividir pelo confirmado fazia o número oscilar (alto no início do
mês, caindo conforme mais exibições confirmavam) e sumir de vez em quando
por divisão por zero.

Decisão: `custoPorExibicao = valorMensalDaConta ÷ exibicoesContratadasMes`
(fixo assim que existe plano).

Motivo: pedido explícito do dono — "deve ser um preço fixo desde o início,
não pelas exibições realizadas".

Consequências: não "corrigir" de volta para dividir pelo confirmado — foi
tentado e revertido no mesmo dia por decisão de produto, não por bug.

## ADR-008 — Painel único, uma aba só ("Painel"); Meu ponto e Vendas saem do topo

Status: Ativa desde 19/09/2026.

Contexto: o menu tinha três abas fixas (Anúncios/Meu ponto/Vendas) sempre
visíveis, mesmo pra quem não tinha o papel — o dono achou o menu poluído e
decidiu que ponto e vendedor não precisam de porta de entrada pública
ativa: pontos "terão a mesma ideia de créditos" (mecanismo de indicação já
existente) e vendedor vira seleção direta do dono.

Decisão: o menu da conta (`navConta()`, `public/layout.js`) mostra só a aba
"Painel" (renomeada de "Anúncios") + Planos + avatar. A candidatura a ponto
virou um card simplificado no fim do próprio Painel (só movimento médio
mensal + mensagem livre — o resto vem da conta). Quem já é vendedor ou
ponto continua acessando as páginas próprias (`vendedor.html`,
`ponto.html`, que não mudaram) por um link dentro do Painel, não mais por
aba no topo.

Motivo: pedido explícito do dono, ver mensagem original preservada no
histórico de commits do dia.

Consequências: `ponto.html`/`vendedor.html` continuam existindo e
funcionais — não são páginas mortas, só perderam link direto no menu. Não
"restaurar" as abas achando que sumiram por engano.

## ADR-009 — Dono do ponto passa na própria tela (17/09/2026, revertendo exclusão anterior)

Status: Ativa, condicional.

Contexto: antes, o dono de um ponto era excluído da rotação paga da própria
tela — fazia sentido quando a contrapartida do comodato era só a cota de
autoanúncio (ele "já entrava por ali"). A cota de autoanúncio zerou por
padrão na migration 049 (a contrapartida virou plano de verdade), e a
exclusão passou a ter o efeito oposto: ele escolhia o próprio ponto e o
gerador tirava ele de lá, gastando cobertura à toa.

Decisão: o dono do ponto só é excluído da rotação paga da própria tela
**enquanto a cota de autoanúncio daquela tela for maior que zero**
(`excluirDaRotacaoPaga = cotaDaTela > 0 ? dono_conta_id : null`,
`src/playlist/gerador.js`).

Motivo: evitar dobra (cota + plano pagando pela mesma exibição) só quando a
dobra é real.

Consequências: na prática, com cota zerada por padrão, o dono roda
normalmente na própria tela hoje — isso é o comportamento correto, não um
furo de "concorrente aparecendo".

## ADR-010 — Webhook do San Checkout: fail-closed, idempotente, transacional

Status: Ativa (regra dura, `CONSTRAINTS.md`). Erro que originou:
`docs/erros/2026-09-webhook-falhava-aberto.md`.

Contexto: um webhook que falha aberto (aceita mesmo sem validar
corretamente) ou que reaplica o mesmo evento duas vezes tem efeito direto
em dinheiro (cobrar ou creditar em dobro).

Decisão: toda notificação do San Checkout precisa (1) ter a assinatura
HMAC-SHA256 conferida com `SAN_CHECKOUT_KEY` antes de qualquer efeito, (2)
ser registrada em `webhooks_processados` e recusar reprocessar o mesmo
evento, (3) aplicar tudo dentro de uma transação.

Motivo: nenhuma das três é negociável quando o efeito é financeiro.

Consequências: não "simplificar" o webhook removendo qualquer uma das três
camadas, mesmo que pareça redundante numa leitura rápida.

## ADR-011 — CSP estrita, sem `unsafe-inline`

Status: Ativa.

Contexto: cadastro público alimenta dados que aparecem em telas de outras
pessoas (ex.: vendedor vê o nome que o anunciante digitou) — XSS armazenado
é um risco real, não teórico.

Decisão: `script-src 'self'` e `style-src 'self'` sem exceção. Nada de
`onclick=` inline nem `style=` inline. Largura/altura dinâmica de barra usa
o atributo `data-pct` + o observador `window.aplicarBarras()`
(`public/config.js`).

Motivo: é a única forma de a CSP valer de verdade contra XSS — com
`unsafe-inline` ela vira decoração.

Consequências: qualquer novo elemento com estilo ou comportamento dinâmico
precisa seguir o mesmo padrão (`data-*` + JS delegado), nunca inline. Um
`<a>` dentro de um `<label>` clicável tem uma armadilha conhecida (o clique
ativa o checkbox do label mesmo com `stopPropagation` num ancestral) —
resolvida deixando o link como IRMÃO do label, com `display: contents` no
CSS do label pra manter o layout.

## ADR-012 — Duração de imagem normalizada usa a duração máxima do plano, não um valor fixo

Status: Ativa desde 19/09/2026 (correção de um comportamento anterior).

Contexto: imagens eram sempre convertidas em vídeo de 10 segundos fixos
(`DURACAO_PADRAO_IMAGEM`), independente do plano — quem pagava por peça de
30s recebia 10s se tivesse subido uma imagem.

Decisão: `ffmpeg.normalizar(caminho, criativoId, duracaoMaxima)` usa
`duracaoMaxima || DURACAO_PADRAO_IMAGEM` — o valor do plano quando existe,
o padrão de 10s só como fallback (conta própria/admin sem plano).

Motivo: imagem e vídeo devem receber o mesmo benefício de plano; o valor
fixo era um furo de entrega, não uma limitação técnica real (a imagem já
virava vídeo de verdade antes desta mudança).

Consequências: não assumir que criativo de imagem tem duração diferente de
vídeo em nenhuma lógica de agendamento — depois de normalizado, os dois são
indistinguíveis para o gerador de playlist.

## ADR-013 — Revezamento entre criativos gira o ponto de partida pela hora

Status: Ativa desde 19/09/2026. Furo real encontrado a partir de relato do
dono ("rodou só uma vez e não rodou de novo").

Contexto: o índice de revezamento (`vez % criativos.length`) sempre
começava do zero a cada hora. Para uma conta com só 1 inserção por hora
disponível, `criativos[0]` (o mais recente, por causa do `ORDER BY
created_at DESC`) ganhava a vaga toda hora, para sempre — qualquer criativo
mais antigo nunca era escolhido. Não tinha relação com o criativo ser
imagem ou vídeo (hipótese inicial do dono, descartada depois de investigar
o código).

Decisão: `inicio = horaEpoch % criativos.length`, e o revezamento usa
`criativos[(inicio + vez) % criativos.length]` (`src/playlist/gerador.js`).

Motivo: ao longo de N horas (N = quantidade de criativos da conta), todo
criativo passa pela vaga pelo menos uma vez, mesmo quando só cabe uma
inserção por vez.

Consequências: nenhuma ação necessária — já corrigido e testado.

## ADR-007 — Status visual do ponto é derivado, não um 3º valor no banco

Status: **Superada em 22/09/2026 pelo ADR-009** (rodada final da Rede) — o
dono pediu status automático de verdade, com `em_reparo` como 3º valor
real no banco. Registro abaixo mantido como histórico de por que a decisão
original foi tomada, não como estado atual.

Status (original): Ativa desde 22/09/2026 (redesenho da tela Rede do admin).

Contexto: o dono pediu 3 estados visuais (Aguardando instalação/TV
instalada/Em operação) pros cards e filtros da Rede. `pontos.status` só tem
dois valores desde a migration 045 (`a_instalar`/`em_operacao`) e alimenta
elegibilidade de playlist (`src/playlist/gerador.js`), gate de confirmação
do player (`src/lib/aparelho.js`), pacing e amortização — um 3º valor real
exigiria revisar todos esses pontos.

Decisão: "TV instalada" é calculado (`statusVisualPonto`,
`public/admin/index.page.js`) a partir de `telas_instaladas` — contagem de
`dispositivos.instalado_em` preenchido, nova coluna já lida por
`src/pontos/repository.js#listar`. Não usa `aparelho_id`/chave: gerar uma
chave só prova que alguém abriu o link, não que a TV chegou no endereço.

Motivo: zero mudança de regra de negócio, zero risco pra playlist/pacing/
gate — é presentation logic pura sobre dado que já existia.

Consequências: se um dia o negócio precisar que "TV instalada" dispare
algo no backend (ex.: notificação, cobrança), precisa virar coluna real —
hoje é só leitura pro admin.

## ADR-008 — A regra "80% comercial / 20% reservado" não existe como o dono descreveu

Status: Registrada, não corrigida (22/09/2026, redesenho da Rede).

Contexto: o dono descreveu uma reserva deliberada de 20% da capacidade de
cada ponto pra conteúdo institucional/universal e pra conta própria da
Mostraí, com o limite de 80% garantindo essa reserva. Investigação real do
código antes de tocar em ocupação (pedido explícito dele nesta rodada)
achou dois mecanismos DIFERENTES e INDEPENDENTES, não um só:

1. `LIMITE_OCUPACAO_BLOQUEIA = 0.8` (`src/pontos/repository.js`, G.7,
   migration 060): freio de VENDA — quando a soma do `segundos_por_hora`
   CONTRATADO pelos anunciantes já associados ao ponto cruza 80% de 3600s,
   o ponto para de aparecer pra ESCOLHA NOVA. Quem já está lá continua
   normal; `liberar-escolha` só reabre com folga real (15min).
2. O preenchimento institucional (`src/lib/pacing.js`, `ID_INSTITUCIONAL`)
   usa só o que sobra DE VERDADE depois do contratado + autoanúncio do
   comodato — best-effort, sem piso garantido. Se o contratado já bate
   3600s (RN-30 corta proporcional), o institucional pode não rodar nada
   naquela hora.

Não existe nenhum código que reserve 20% de forma garantida. Os dois
mecanismos SE CORRELACIONAM na prática (o freio de venda tende a deixar
sobra), mas um não implica o outro — o freio olha COMPROMISSO vendido, não
tempo de tela realmente entregue.

Decisão: **não alterar nenhum dos dois mecanismos.** A Ocupação agregada na
Visão geral (`renderOcupacaoRede`) só EXIBE o que `ocupacaoPorAnunciante()`
já calcula — mesmo número de sempre, sem reescrever a regra.

Consequências: se o dono quiser a reserva garantida de verdade, é decisão
de produto nova (ex.: um piso mínimo de segundos institucionais por hora,
descontado ANTES do orçamento comercial em `src/lib/pacing.js`) — não
implementada aqui, fora do escopo desta rodada (era só reorganização
visual + o que já existia).

## ADR-009 — `pontos.status` vira automático de verdade, 4 valores reais no banco (supera ADR-007)

Status: Ativa desde 22/09/2026 (rodada final da Rede, prompt de 35 seções
do dono — "considere este prompt como a especificação definitiva").

Contexto: ADR-007 (acima) resolveu deliberadamente NÃO tocar
`pontos.status` — manteve só 2 valores reais e simulou um 3º estado visual
("TV instalada") calculado no front a partir de `telas_instaladas`. O dono
revisou essa decisão e pediu o oposto: `em_reparo` como estado real,
derivado automaticamente das telas, sem controle manual nenhum no admin.

Decisão: `pontos.status` virou 4 valores reais (`a_instalar`/`em_operacao`/
`em_reparo`/`inativo`, migration 069), escritos por uma única função
(`sincronizarStatusPonto`, `src/pontos/repository.js`), chamada de dentro
de `src/dispositivos/repository.js` nos 3 pontos onde uma tela muda
(criar, atualizar `status`, deletar). Ninguém mais escreve a coluna direto
— `status` saiu de `CAMPOS_ATUALIZAVEIS` de pontos. Regra: 0 telas →
`a_instalar`; ≥1 tela `ativo` → `em_operacao`; 0 ativa e ≥1 em `reparo` →
`em_reparo`; tem tela(s), nenhuma ativa/reparo → `inativo`.

Consumidores mapeados antes de mexer (pedido explícito do prompt):
- **Sem mudança**: `src/playlist/gerador.js` (só `em_operacao` entra na
  playlist) e `src/lib/aparelho.js` (gate do player só libera com
  `em_operacao`) — veiculação de verdade continua exatamente igual.
  `avaliarBloqueios` (G.7, 80%) continua só em `em_operacao` — ponto que
  não veicula não pode estar "cheio".
- **Mudança deliberada, documentada**: `listarPublicos` (site público) e a
  escolha de pontos do anunciante (`GET .../pontos-disponiveis`, `PUT
  .../pontos`) passaram a aceitar `em_reparo` junto com `em_operacao`/
  `a_instalar` — antes desta rodada só existiam 2 valores possíveis, então
  esses filtros cobriam de fato 100% dos pontos reais; com `em_reparo`
  virando um valor de verdade, não estendê-los faria pontos reais
  desaparecerem da noite pro dia sem nenhuma mudança física ter
  acontecido. `em_reparo` é estruturalmente igual a `a_instalar` pro
  propósito desses dois filtros (não veicula agora, mas é um lugar real —
  RN-49 já tratava `a_instalar` assim). Só `inativo` ficou de fora — o
  caso genuinamente novo (tela(s) cadastrada(s), nenhuma funcionando).

Efeito colateral encontrado e corrigido no caminho: 3 lugares
(`liberarPapelNaConta`, `criarPontoDaCandidatura`, cadastro de endereço
pelo dono de ponto) criavam uma "Tela 1" vazia junto com o ponto. Como
tela nova nasce `inativo` (default da coluna, também mudado nesta
migration — era `'ativo'`), isso fazia o ponto nascer `inativo` em vez de
`a_instalar`. Os 3 lugares pararam de criar essa tela — o admin cria de
verdade só na instalação física.

Motivo: `em_reparo` como estado real permite ao admin ver, filtrar e agir
sobre telas quebradas sem depender de olhar a lista de telas ponto a
ponto; e mantém uma única fonte de verdade (não duas, como o modelo
anterior — DB com 2 valores + cálculo no front com um 3º).

Consequências: qualquer novo consumidor de `pontos.status` precisa tratar
os 4 valores, não 2. Reverter pra manual exigiria desfazer
`sincronizarStatusPonto` e devolver `status` a `CAMPOS_ATUALIZAVEIS` — não
é mudança trivial, decisão de produto se algum dia for pedida.
