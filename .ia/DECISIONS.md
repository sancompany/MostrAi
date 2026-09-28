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

Complemento (27/09/2026, erro `docs/erros/2026-09-27-sessao-do-admin-derrubava-o-anunciante.md`):
**admin e conta do cliente têm cookies separados** — `mostrai.admin`
(`Path=/admin`) e `connect.sid` — na mesma tabela `session`, montados por
`src/lib/sessao.js`, um store por sessão. Com um cookie só, cada login
(`regenerate`) derrubava a outra identidade no mesmo navegador. Não juntar
de novo "pra simplificar"; e toda rota que usa `isAdmin`/`adminUsuario` fica
debaixo de `/admin` (é só lá que o cookie do admin viaja).

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
problemas diferentes. Efeito colateral aceito: a base congelada guarda o
PEDIDO da hora de cada participante (base, compensação, déficit, banco e,
desde 27/09/2026, a obrigação da hora — ADR-023), e os polls seguintes da
mesma hora reprocessam essa mesma base; só quem entra depois (`extras`) é
calculado com dado fresco. (Até 27/09/2026 este parágrafo dizia que banco e
déficit eram recalculados a cada poll — não era o que o código fazia.)

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

## ADR-014 — Desconto de promoção SUBSTITUI o desconto de ciclo; comodato/parceiro continuam somando (22/09/2026)

Status: Ativa.

Contexto: rodada de Ofertas + Promoções (22/09/2026, prompt de 41 seções do
dono). Uma promoção vigente (ex.: "Pré-venda Mostraí") e o desconto normal
de ciclo (Trimestral/Semestral/Anual) podiam, em teoria, coexistir pro
mesmo plano — o prompt não disse explicitamente empilhar ou substituir.

Decisão: o desconto promocional SUBSTITUI o desconto de ciclo sobre o
preço cheio (`valor_mensal_cheio`) — nunca os dois aplicados em sequência.
Desconto de comodato e de parceiro continuam somando por cima do preço
resultante (promocional ou normal, o que estiver vigente), porque são
direitos da CONTA (dono de ponto, parceiro comercial), ortogonais a qual
"preço de tabela" está em vigor.

Motivo: a Parte Q do prompt descreve o card de preço promocional como
autocontido — "preço cheio riscado, selo de desconto, preço promocional,
economia, equivalente mensal" — nunca "10% de ciclo + mais X% de
promoção". Substituir mantém o card simples de explicar e o cálculo do
`san-checkout.js` (cobrança real) idêntico ao que a Parte P mostra
publicamente — duas fontes de verdade divergindo aqui seria o pior erro
possível numa tela de preço.

Onde vive: `public/planos.page.js#montarPreco` (exibição) e
`src/financeiro/san-checkout.js#valorMensalDaConta` (cobrança) — os dois
implementam a mesma regra, comentário cruzado em cada um.

Consequências: se um dia o dono pedir promoção empilhável com ciclo,
exige mudar os dois lugares junto, e a UI do card de preço (hoje mostra
um desconto só) também muda — não é ajuste de uma linha.

## ADR-015 — Ficha de Conta lê UMA fonte de domínio; cortesia é crédito; benefício pago com créditos é intocável (23/09/2026)

Status: Ativa.

Contexto: revisão da ficha de Conta do admin pedida pelo dono ("a interface
precisa representar o domínio da Mostraí, não a estrutura das tabelas").
A ficha montava a conta no navegador a partir de seis listas cruas, e dois
cards chegaram a se contradizer em produção ("Sem ponto em comodato" ao lado
de "Pontos: Santos unio · Inativo"). Os botões Conceder/Alterar/Cancelar
plano apagaram, em produção, um benefício pago com 120 créditos (substituído
por cortesia administrativa 42 s depois).

Decisão:
1. `GET /admin/anunciantes/:id/situacao` (`src/anunciantes/situacao.js`) é
   a ÚNICA leitura da ficha. Origem do plano, fila Agora → Próximo → Depois,
   comodato (ponto + modalidade), ponto × solicitação, selo "Dono de ponto"
   e invariantes são decididos ali. A tela só desenha.
2. Cortesia comercial = CRÉDITOS (`creditos/conceder`, motivo obrigatório +
   nota interna). "Conceder/Alterar/Cancelar plano" saíram da ficha; as
   rotas ficam como ferramenta técnica sem tela, e recusam (409) mexer em
   benefício pago com créditos em vigor ou programado.
3. Cortesia administrativa antiga NÃO é migrada nem apagada: vale até o fim
   e aparece como "Cortesia administrativa legada".
4. "No ar" usa o plano VIGENTE (`repository.planoVigenteId`, mesmo COALESCE
   do gerador) — ficha e TV nunca discordam.

Consequências: quem mexer em regra de plano/comodato/selo muda
`situacao.js` (e o teste `tests/ficha-conta.test.js`), nunca a tela. Pra
reintroduzir concessão direta de plano, rever este ADR — o dono pediu
explicitamente que o fluxo normal seja crédito.

## ADR-016 — Ser ponto não é plano: o ponto gera créditos; plano pago × benefício por prioridade de tier (24/09/2026)

Status: Ativa. Supera, no que conflita, a separação comodato/plano comercial
(migration 077) e o item 2 do ADR-015 sobre "comodato por ponto + modalidade".

Contexto: pedido do dono ("REESTRUTURAÇÃO COMPLETA DO MODELO DE BENEFÍCIOS
DOS PONTOS"). O modelo antigo tinha duas modalidades de comodato — "Recebe
os R$ 50" (repasse mensal + plano Inicial, sem poder assinar) e "Troca os
R$ 50 por tela" (plano Básico + R$ 50 de desconto na mensalidade) —, uma
fila de repasses no admin e um bônus de anúncio por tempo de ponto.

Decisão:
1. **Ponto aprovado + tela instalada e ativa = +1 crédito por mês**
   (`src/creditos/ponto.js`, migration 082). Um por PONTO (não por tela),
   por competência (mês em America/Sao_Paulo), no MESMO ledger
   (`creditos_ledger`, tipo `credito_mensal_ponto`, com `ponto_id` e
   `competencia`). Idempotência no banco: índice único (ponto, competência).
   Elegibilidade não olha heartbeat (queda de internet não tira o mês);
   tela desligada pelo admin, ponto arquivado/mesclado, conta excluída ou a
   conta interna tiram. Candidatura, aprovação sem tela e troca de dono no
   mês não geram (de novo). Concedido pelo job diário `npm run conciliar`.
2. **Não existe mais**: Inicial, Básico, repasse mensal, ajuda de custo,
   crédito monetário de R$ 50, escolha de modalidade (convite, candidatura,
   admin), bônus de anúncio por tempo de ponto, aba Repasses, card Comodato
   da ficha, "Comodato" em Ofertas. Rotas viram 410; `planos_ponto` ficam
   todos `ativo = false`; nada é apagado — `pagamentos_ponto`,
   `pontos.plano_ponto_id/valor_pago_mensal`, `anunciantes.comodato_plano_id/
   credito_comodato_mensal` e os planos `inicial-1m`/`comodato-basico` ficam
   como histórico. Saldo monetário antigo NÃO é convertido em crédito.
3. **Uma economia de créditos, três planos**: Essencial (1) < Pro (2) <
   Prime (3). Entre plano PAGO e BENEFÍCIO por créditos vale sempre UM
   plano efetivo:
   - pago MAIOR que o benefício em vigor → entra na hora; o benefício fecha
     como `superado_por_plano_pago`, sem devolver créditos; o cliente vê o
     aviso ANTES de pagar (`/assinar` → 409 com `confirmacao`);
   - pago IGUAL ou MENOR → o benefício continua; o período pago fica
     GUARDADO (`anunciantes.plano_pago_guardado_id/_dias`) e assume quando o
     benefício acaba, com os dias intactos ("cobrança adiada" — o San
     Checkout não tem pausa, então renovações durante o benefício somam
     dias guardados, nunca se perdem);
   - benefício PROGRAMADO abaixo do novo pago fecha como
     `superado_por_plano_pago`; igual ou acima continua na fila;
   - resgate ABAIXO do plano pago em dia é recusado sem consumir crédito;
     resgate igual/acima entra depois do ciclo pago e o pago volta depois.
4. **Financeiro**: crédito não é receita nem despesa. MRR soma só
   assinatura paga (inclui o pago guardado sob um benefício, porque a
   assinatura segue ativa). Custo de pontos (repasse) saiu da margem.
5. O comodato JURÍDICO do equipamento (`/comodato.html`) não foi reescrito:
   é documento legal, listado como pendência do dono (docs/PENDENCIAS.md §J).

Consequências: toda regra de elegibilidade mora em
`creditos/ponto.js#SQL_PONTOS_ELEGIVEIS` (job, painel e admin leem a mesma
SQL). Toda regra de convivência pago × benefício mora em
`plano-administrativo.js` (`preverPagamento`, `aplicarPagamentoNaFila`,
`ativarBeneficiosAgendados`, `encerrarBeneficiosVencidos`, `encerrar`) e
é coberta por `tests/prioridade-planos.test.js` (matriz 3×3). Nenhuma nova
operação no modelo antigo: reintroduzir modalidade, repasse ou plano de
ponto exige rever este ADR.

## ADR-017 — Data comercial é horário de Matão; endereço em partes; vantagem promocional só se anuncia onde existe (24/09/2026)

Contexto: decisões D1–D6 do dono sobre os achados da rodada mobile
(docs/PENDENCIAS.md, "Decisões D1–D6 do dono e auditoria seguinte").

Decisão:
1. **Data/hora comercial digitada no admin é horário de America/Sao_Paulo**,
   convertida no SERVIDOR (`src/lib/fuso-comercial.js#instanteComercial`):
   parede sem fuso = Matão; valor com fuso passa como veio; fim de janela é
   inclusivo no minuto. Vale pra `promocoes.compra_inicio/compra_fim` e
   `midias_proprias.periodo_inicio/periodo_fim`. O navegador manda a parede
   crua e relê com `window.paredeSP`; o site exibe com `window.prazoBR`.
   Nunca `toISOString().slice(0, 16)` em campo de data comercial.
2. **Endereço em partes** (CEP, logradouro, número, complemento, bairro,
   cidade, UF) em `anunciantes`, `pontos` e `candidaturas` (migration 086).
   `endereco` segue existindo como a linha "logradouro, número" composta SÓ
   por `src/lib/endereco.js#colunasDoEndereco` (repositórios de conta, ponto
   e candidatura chamam; rota e formulário nunca compõem). Exibição por
   `linhaEndereco` (servidor) / `window.linhaEndereco` (navegador).
   Complemento é o único opcional.
3. **Regra de preço da promoção intocada (ADR-014)**; o que se anuncia
   depende de `temVantagem` (preço promocional abaixo do preço normal do
   plano). Célula sem vantagem não leva selo nem "preço válido por N meses";
   banners dizem os `ciclosComVantagem`; sem vantagem em ciclo nenhum, sem
   banner. Percentual e escolha de ciclos são decisão comercial (C1–C3).
4. **Sessão pública sem 401**: páginas públicas perguntam por
   `GET /conta/sessao` (200 sempre, só nome/foto/papéis). Rota privada
   continua 401.
5. **Sem injeção de terceiros no HTML**: todo HTML sai com
   `Cache-Control: no-transform` (Cloudflare não injeta o Web Analytics da
   zona). Liberar analytics na CSP exige decisão explícita de privacidade.

Consequências: quem criar outro campo de data comercial usa
`instanteComercial` na gravação e `paredeSP`/`prazoBR` na tela. Quem criar
outro formulário de endereço usa os 7 campos e deixa a linha pro servidor.
Mudar "promoção substitui" pra "o maior dos dois" é rever o ADR-014, não
este.

## ADR-018 — Custo por exibição prevista vem do snapshot do ciclo; benefício por créditos é um ciclo (24/09/2026)

Status: Ativa. Última alteração estrutural da rodada no modelo comercial —
depois dela, o modelo fica congelado salvo bug real (pedido do dono).

Contexto: o card "Custo por 1.000 exibições" dividia o valor mensal da conta
pelas exibições previstas calculadas com a DURAÇÃO MÉDIA dos criativos
aprovados da conta — o número mudava quando o cliente trocava a peça, e
usava o preço atual (não o do contrato). E o benefício por créditos falava
"1 mês / 3 meses / 6 meses / 12 meses" enquanto o plano pago falava
"Mensal / Trimestral / Semestral / Anual".

Decisão:
1. **Custo por exibição prevista = valor contratado no ciclo ÷ exibições
   previstas no ciclo.** Nunca exibição realizada (proof-of-play), nunca preço
   atual do admin, nunca duração dos criativos.
2. **Snapshot por ciclo** em `ciclos_contratados` (migration 087): uma linha
   por ciclo pago que começa — `compra` e `renovacao` (em
   `san-checkout.js#aplicarCicloPago`, com o MESMO `valorCiclo` que vai pra
   cobrança: preço-base → desconto do ciclo ou promoção travada na
   assinatura → parceiro) e `troca` (webhook `plano_trocado`,
   `POST /anunciantes/me/trocar-plano` e o pedido avulso legado — o ciclo do
   plano novo, nunca o acerto proporcional). Exibições previstas = régua
   canônica da vitrine (`exibicoesPorMes`: horas de tela do plano ÷ duração
   máxima da peça) × meses do ciclo. Nada é recalculado depois; histórico
   anterior foi preenchido a partir das cobranças de ciclo inteiro.
3. **Benefício por créditos e cortesia legada nunca mostram valor**: o card
   diz "Benefício por créditos · Sem valor monetário neste ciclo" ou
   "Cortesia · Sem cobrança neste ciclo". Microvalor com 4 casas decimais
   (`fmtMicroBRL`, até 6 se precisar); positivo nunca vira "R$ 0,00".
4. **Ciclo único pra pago e benefício**: código canônico = meses
   (`planos.compromisso_meses` 1/3/6/12, equivalente ao ciclo do San
   Checkout); nome visível `src/lib/ciclos.js` / `ROTULOS.ciclo`
   (Mensal/Trimestral/Semestral/Anual). "Prime · Semestral", não
   "Prime · 6 meses"; a duração fica como explicação secundária. Tabela de
   créditos intacta e linear (3/7/10 por mês × meses). Registros antigos do
   ledger ("Resgate: Prime · 6 meses") são mostrados com o nome do ciclo só
   quando inequívoco — o registro gravado não muda.
5. Benefício por créditos nunca renova sozinho e nunca consome crédito
   automaticamente; a prioridade pago × benefício do ADR-016 não mudou.

Consequências: quem mexer em preço, promoção ou exibições previstas não
precisa tocar o card — o próximo ciclo grava o snapshot novo. Qualquer
tela nova que precise do nome de um ciclo usa `nomeDoCiclo`/`ROTULOS.ciclo`.

## ADR-019 — Preço promocional vale enquanto a assinatura existir, sem prazo (26/09/2026)

Contexto: o San Checkout confirmou em produção que uma assinatura de cartão
já paga não aceita alteração posterior do valor. A promoção prometia "N
meses de desconto e depois volta ao preço normal" (`duracao_beneficio_meses`
→ `assinaturas.promocao_valido_ate`), o que o produto não consegue cumprir.

Decisão (pedido do dono):
1. Condição FIXA para as promoções de assinatura: quem aderir durante a
   janela de compra mantém o preço promocional enquanto AQUELA assinatura
   permanecer ativa. Cancelou e contratou de novo = assinatura nova, preço
   vigente na nova contratação.
2. A janela de compra (Começa em / Termina em) só decide até quando entram
   adesões novas. Limite de adesões, público, produtos/ciclos, desconto,
   exposição e status não mudam.
3. `san-checkout.js#valorMensalDaConta` aplica a promoção sempre que a
   assinatura carrega `promocao_desconto_percentual` (snapshot da adesão).
   `promocao_valido_ate` não é mais gravada nem lida; `duracao_beneficio_meses`
   saiu do admin e da API. As colunas ficam no banco, sem efeito (produção
   tinha 0 promoções e 0 assinaturas com promoção).

Consequências: não existe seletor de modalidade de duração. Se um dia o
Checkout passar a permitir mudar o valor de uma assinatura paga, uma
modalidade "N meses" volta como decisão nova, não reativando a coluna antiga.

## ADR-020 — Painel por estado; crédito é relacional; indicação é do ponto; troca de benefício sem estorno (26/09/2026)

Contexto: estação da conta pedida pelo dono. A conta recém-criada parecia um
painel antigo sem dados: "sem plano" repetido em quatro lugares, créditos
("0 créditos" + tabela) e link de indicação pra quem não tinha nenhuma
relação com eles, convite de ponto espremido na coluna lateral, e nenhum
caminho claro pro primeiro passo.

Decisão:
1. **O painel mostra o estado real.** Sem plano: um bloco só com o próximo
   passo e um botão ("Escolher meu plano"); o card de plano some. Primeiros
   passos saem do servidor (`GET /anunciantes/me/primeiros-passos`).
2. **Crédito é relacional**, não produto de todo anunciante: a área aparece
   pra ponto, saldo > 0 ou histórico (`exibicao`, em `GET
   /anunciantes/me/creditos`). Crédito nunca é dinheiro/carteira/saque.
3. **Indicação é do ponto** (ponto aprovado não arquivado, qualquer status):
   card próprio, fora dos créditos. Crédito ≠ ponto: compensação não libera
   indicação. Cupom já emitido pra conta que não é ponto continua valendo
   no cadastro — só não é mais oferecido.
4. **Troca com benefício por créditos em vigor é permitida, com aviso
   explícito, e os créditos já usados NÃO voltam** (regra aprovada pelo
   dono). Crédito → crédito: o resgate exige `substituirBeneficioId` (o id
   do benefício em vigor); o atual fecha como `substituido` e o novo debita
   uma vez. Crédito → pago, pago → crédito e pago → pago: a regra do ADR-016
   e da RN-52 NÃO mudou; só o aviso ficou completo (plano, origem, validade,
   créditos gastos, consequência; "Manter plano atual" / "Continuar com a
   troca").
5. Benefício PROGRAMADO e cortesia da Mostraí em vigor continuam
   bloqueando um resgate novo (não são do cliente pra trocar).

Consequências: regra de visibilidade mora no servidor (`creditos/routes.js#
exibicaoDosCreditos`, `pontos/repository.js#contaEhPonto`) e é coberta por
`tests/conta-experiencia.test.js` (contas A–D) e pelo e2e 22. Divergência
registrada: o pedido do dono dizia que crédito → pago "encerra o
benefício"; o comportamento real (ADR-016) só encerra quando o pago é de
nível MAIOR — igual ou menor começa depois do benefício, sem perder dia
pago. A tela descreve o real. O dono confirmou em 26/09/2026 (PR #78):
o benefício por créditos continua intacto até a data final e o ADR-016
decide quando o pago entra.

## ADR-021 — E-mail por fila durável; código com hash e prazo do servidor; troca de e-mail em duas etapas (27/09/2026)

Contexto: e-mail saía "fire-and-forget" de cada rota. O primeiro código do
cadastro às vezes não chegava (duas conexões SMTP simultâneas, sem nova
tentativa, perdido num restart); a cobrança falhada podia ser avisada duas
vezes (webhook e conciliação com dedupes diferentes); erros eram engolidos;
o código de 6 dígitos vivia em texto puro, valia 2 minutos contados pelo
navegador; não havia como corrigir um e-mail digitado errado nem trocar o
e-mail com segurança; o admin trocava o login de um cliente sem rastro.

Decisão:
1. **Outbox** (`email_outbox`, `src/email/outbox.js`): regra de negócio só
   grava; processador com `FOR UPDATE SKIP LOCKED`, prazo de 5 min pra
   instância que morreu, 6 tentativas (30 s → 2 h), depois `abandonado`
   visível no admin. Pelo menos uma vez (nunca zero; na pior hipótese, dois).
2. **Chave = evento de negócio**, não a fonte (`cobranca_falhou:<chargeId>`
   serve pro webhook e pra conciliação). Marca antiga `renovacao|<chargeId>`
   continua respeitada.
3. **E-mail nunca quebra negócio**: depois de concluída a operação,
   `enfileirarSemFalhar` (e `registrarSemFalhar` pra notificação).
4. **Código**: 10 min, HMAC (`cofre.assinar`, rótulo próprio), cifrado na
   fila e apagado ao terminar; 60 s entre reenvios, 5 por hora, 5 erros.
5. **Troca de e-mail**: antes de confirmar, corrige na hora com a senha;
   depois de confirmar, só com o código no endereço novo, e o antigo é
   avisado. Admin: trilha + confirmação do novo + aviso ao antigo.
6. **Testes nunca falam com SMTP real** (`NODE_ENV=test` bloqueia); e2e usa
   `EMAIL_CAPTURA` (arquivo), ignorado em produção.

Consequências: nenhum `enviarX` é chamado fora de `src/email/outbox.js`.
Templates não mudaram (só o texto do código e 4 modelos novos: senha
alterada, e-mail alterado, ponto aprovado, ponto recusado). A tabela 061
fica pra uma migration de limpeza. Sem confirmação automática ao remetente
do formulário de contato (formulário público = vetor de e-mail pra terceiros).


## ADR-022 — "No ar" é comprovante; Mídia Mostraí conta no contador dela; dono isento da trava de ramo só por escolha (27/09/2026)

Contexto: em produção a conta dona do único ponto tinha plano, peça
aprovada e o próprio ponto escolhido — zero exibição programada — e o
painel dizia "No ar". A trava de ramo barrava o dono na própria tela; o
painel escondia a escolha de pontos do benefício; "no ar" era "está no
rodízio"; a Mídia Mostraí não gerava comprovante nenhum.

Decisão:
1. **No ar = proof-of-play confirmado depois de `aprovado_em`** (migration
   099: `aprovado_em` por trigger, `primeira/ultima_exibicao_em` só pelo
   `/played`). Estados derivados no servidor
   (`src/anunciantes/entrada-no-ar.js`): Aprovado (motivo) → Programado
   (primeira janela = primeira hora cheia aberta da cobertura depois da
   aprovação) → Aguardando primeira exibição (a TV pediu a hora e a conta
   estava nela) → No ar | Entrada atrasada. Tolerância = ⌈peças/inserções
   por hora⌉ horas abertas + 10 min (Player: lote de POP a cada 60 s, recuo
   até 5 min). O front não calcula nada disso.
2. **Mídia Mostraí com `contabiliza: true`**; crédito em
   `midias_exibicoes_contador` (programadas × confirmadas por
   mídia/tela/hora, mesmo teto), nunca em `exibicoes_contador` nem no banco
   de horas; histórico da situação em `midias_proprias_situacoes` pra o
   esperado respeitar pausa. Esperado = frequência × horas abertas de cada
   tela da cobertura (até 10 min atrás) — nunca frequência × 24.
3. **Trava de ramo isenta o dono só quando ele escolheu o próprio ponto.**
   No modo automático nada muda; o próprio ponto nunca é marcado por ser do
   dono e conta no limite do plano.
4. **Pedir atualização às telas** = só `playlist_desatualizada_em`; nunca
   reiniciar o Player como correção.

Consequências: o e-mail "Seu anúncio está no ar" (fora do escopo) ainda
sai na aprovação — pendência. Programadas comerciais em hora fechada
distorcem o déficit do banco de horas — pendência da estação do banco de
horas, sem mudança de fórmula aqui.

## ADR-023 — Saldo de Veiculação em tempo, por comprovante e só em hora aberta (27/09/2026)

Status: Ativa. Migration `100_saldo_de_veiculacao.sql`. Regra: RN-53.
Mapa, defeitos e invariantes: `docs/specs/2026-09-27-saldo-de-veiculacao.md`.

Contexto: o banco de horas contava "o que não coube" (pedidas − programadas)
em EXIBIÇÕES, confiando no déficit hora a hora pro que foi programado e não
tocou. Produziu dívida falsa em hora fechada (a TV pede playlist a noite
toda), perdia o não entregue na virada de hora fechada, de mês e com a TV
sem sinal, deixava a compensação da RN-49 cortar a base de outra conta numa
hora cheia, fazia sumir a parte do contrato acima do teto da RN-49, e
reescrevia a dívida em tempo quando a peça mudava.

Decisão:
1. **Unidade = segundo.** Cada hora do contador guarda a duração que usou;
   exibições equivalentes são derivadas com a peça de hoje.
2. **Obrigação explícita por hora aberta** (`segundos_obrigacao`), sem o teto
   da RN-49; hora fechada não grava; hora parcial deve os minutos abertos;
   hora aberta sem sinal ganha a obrigação (só para conta já servida naquela
   tela).
3. **Entrega = comprovante** (`LEAST(confirmadas, programadas − banco)`).
4. **Camadas da hora**: base de todos (T1) → compensação e reposição do mês
   (T2) → saldo antigo (T3). A Mídia Mostraí continua na T1 (regra
   existente; conflito sinalizado em `.ia/RISKS.md`).
5. **Mesmo job**, mesma tabela, mesma função: `ApuracaoBancoHoras` apura; o
   `Conciliacao` recompõe no prazo do comprovante. Idempotente: uma linha por
   conta × mês, recomposta (nunca somada) até congelar.

Consequências: nomes internos (`banco_horas`, `src/bancohoras/`, o job)
mantidos — renomear tabela e job em produção é risco sem ganho; o cliente vê
"Saldo de veiculação". As colunas `exibicoes_*` de `banco_horas` viram
equivalentes informativos. `vezes_pedidas` deixou de alimentar a apuração
(fica como registro de auditoria da hora).


## ADR-024 — QR institucional: rota permanente no próprio site, destino em configuração, imagem gerada no servidor (27/09/2026)

Status: Ativa. Sem migration. Regra: RN-66. Código:
`src/midias/qr-institucional.js` (regra) e `src/midias/routes.js` (HTTP).

Contexto: o dono quer um QR para vídeo institucional, flyer e material
impresso que nunca precise ser trocado quando a página de destino mudar.

Decisão:
1. **O QR codifica `SITE_URL/q/anuncie`, nunca o destino.** Para onde a rota
   leva é configuração em `configuracoes_site` (chave `qr_institucional`,
   JSON com destino, quem e quando) — a mesma tabela do vídeo institucional
   e da foto de exemplo; nada de tabela nova para um valor só.
2. **302 + `Cache-Control: no-store`, nunca 301**: redirecionamento
   permanente fica guardado no navegador e na Cloudflare, e o destino novo
   deixaria de valer para quem já escaneou.
3. **Validação na gravação e de novo na leitura**: só `https://` (http só
   quando o próprio site é http — ambiente local), sem usuário/senha, com
   domínio, até 2048 caracteres, nunca o próprio link. Qualquer falha na rota
   pública leva à página de planos, com log — o QR impresso nunca mostra erro.
4. **Imagem gerada no servidor com `qrcode`** (que já estava instalada como
   dependência de build e passou a dependência de produção): nenhum serviço
   externo recebe o link. Correção Q, margem de 4 módulos, tinta da marca
   sobre branco; marca só na moldura do preview. PNG 1024/2048 px (4096
   travava o processo ~2 s) e SVG; gerado uma vez por processo.

Consequências: o domínio `SITE_URL` vira parte do material impresso — se um
dia o site mudar de endereço, o antigo precisa continuar respondendo (ou
redirecionando) `/q/anuncie`. QR por ponto, de indicação ou com contagem de
acessos é outra estação (não reaproveita esta chave).


## ADR-026 — Concorrentes diretos entre categorias: par explícito e simétrico, nunca grupo (28/09/2026)

Status: Ativa. Migration 105. Regra: RN-57 (emenda de 28/09/2026). Código:
`src/categorias/concorrencia.js` (regra e gravação), `src/playlist/gerador.js`
(`anunciantesElegiveis`), `src/anunciantes/entrada-no-ar.js`
(`coberturaDaConta`), `src/categorias/routes.js` (admin).

Contexto: a proteção do dono da tela comparava só `categoria_id` igual. Com
~200 categorias específicas, concorrente de verdade com outro nome passava
(academia × CrossFit, cafeteria × padaria, hotel × locação por temporada).
Usar o grupo bloquearia quem não concorre (academia × pilates, barbearia ×
salão, pet shop × veterinário).

Decisão:
1. **Par explícito, cadastrado pelo admin**: `categorias_concorrentes
   (categoria_a, categoria_b)` com `CHECK (categoria_a < categoria_b)` e PK no
   par. Simetria e ausência de duplicata vêm do armazenamento, não de quem
   grava; categoria nunca é par de si mesma (isso já é a regra 1).
2. **Regra**: mesma categoria → bloqueia; par cadastrado → bloqueia; resto →
   exibe. Sempre categoria do PONTO × categoria do ANUNCIANTE. Grupo e
   aliases nunca entram; não há exclusividade anunciante × anunciante;
   nada de multicategoria, principal/secundária, regra por produto ou
   exceção por estabelecimento.
3. **No gerador, `NOT EXISTS` pela PK** (`least/greatest`) dentro da mesma
   trava de ramo — uma sonda de índice por candidato, sem N+1, sem cache em
   memória do processo. A isenção da dona que escolheu o próprio ponto
   (ADR-022) cobre as duas partes. Mídia Mostraí não passa por aqui.
4. **Admin**: o que mudou nos concorrentes (pôr/tirar — nunca a lista
   inteira, pra um modal antigo não apagar o par de outra aba) vai no mesmo
   PATCH/POST do modal da categoria, numa transação (Salvar grava tudo,
   Cancelar descarta). Par NOVO exige as duas pontas fora do legado, com as
   linhas travadas (`FOR SHARE`) contra mesclagem simultânea; par antigo não
   trava o salvar.
5. **Mesclar leva os pares** da absorvida pra canônica (é o mesmo negócio;
   senão a conta reapontada perderia a proteção que tinha).
6. **Seed por nome** (48 pares aprovados pelo dono), no-op se o nome não
   existir — mesma defensiva da 074. "Terapia capilar" criada sem par.

Consequências: bloquear é bloquear — conta que ESCOLHEU (ou recebeu no
sorteio) um ponto concorrente não exibe ali, e a vaga de cobertura não volta
nem é compensada (mesmo comportamento que a mesma categoria já tinha). Em
produção, em 28/09/2026, nenhuma conta cai nisso (1 ponto, 1 conta com plano,
a dona dele); risco em `.ia/RISKS.md`. Vale para a programação seguinte (a vaga já congelada da hora
some na próxima leitura, como qualquer saída de elegibilidade); histórico de
proof-of-play e contadores não muda. Uma categoria nova nasce sem par — o
admin decide. Com o Plano Básico (migration 103, branch própria) o ponto do
Básico continua fora da trava (é o estabelecimento da própria conta); no
merge, `coberturaDaConta` junta as duas condições
(`proprios.has(p.id) || (naFatia && (!bloqueia || dona))`).
