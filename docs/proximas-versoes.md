# Próximas versões — Mostraí

Ideias guardadas para a próxima volta da esteira. Nada aqui está autorizado;
quem autoriza é a Estação 1 da versão seguinte. Cinco linhas por entrada.
Fonte principal: pesquisa de mercado de 11/09/2026
e a de custos de 12/09
(`docs/precificacao.md`).

## Primeiro mês sem cobrança como benefício de primeira compra
- **O que:** "assine e o primeiro mês é por nossa conta" — benefício só na primeira compra, não recorrente.
- **Por que:** é o gancho de venda mais direto para quem nunca anunciou; recorrente ("pague 3, leve 4") já se resolve embutindo 25% no valor do ciclo, mas o de primeira compra não fecha por preço.
- **De onde veio:** ideia do dono, 14/09/2026, na leitura do contrato do San Checkout.
- **O que toca:** o motor de pagamento, não o Mostraí. Hoje não há caminho limpo: não existe carência nem data de início (`API.md` do Checkout, 7.5), e pausar/retomar na data certa é comando manual sobre caminho de dinheiro — se ninguém executar no dia, o assinante é cobrado e a correção é estorno.
- **Quando vale a pena:** quando o San Checkout ganhar um campo de primeira cobrança (`primeiraCobrancaEm` alimentando o `nextDueDate`, que já está no caminho dele). Enquanto isso não existir, não se promete.

## Impactos estimados e CPM no painel e na página de planos
- **O que:** mostrar ao anunciante impactos/mês e CPM, além do custo por exibição.
- **Por que:** o mercado inteiro negocia em CPM; sem isso o anunciante não compara com rádio nem Instagram e o vendedor não defende preço.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** um campo por ponto (tempo médio de permanência), fórmula, painel do anunciante e `planos.html`.
- **Quando vale a pena:** na primeira negociação em que o anunciante perguntar "quanta gente vê".

## Comprovante de veiculação em PDF
- **O que:** relatório mensal por anunciante com log de exibições por tela e data, baixável.
- **Por que:** o dashboard mostra, mas o cliente não leva nada embora; é o que destrava cliente maior e a renovação.
- **De onde veio:** pesquisa de mercado, 11/09/2026 (Progic cita como o diferencial de rede indoor).
- **O que toca:** endpoint de PDF reaproveitando o pipeline da nota fiscal; dados já existem.
- **Quando vale a pena:** ao fim do primeiro ciclo pago de um anunciante.

## Alertas ativos e cobrança falhada
- **O que:** aviso por e-mail/WhatsApp quando uma tela cai, um criativo é reprovado ou uma cobrança falha; suspensão da veiculação após N dias sem pagar.
- **Por que:** hoje o heartbeat registra e ninguém é avisado; churn silencioso é a maior perda em assinatura.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** três eventos já registrados; um disparador de e-mail e o `wa.me` manual.
- **Quando vale a pena:** na primeira tela que ficar um dia inteiro fora sem ninguém perceber.

## "A arte é por nossa conta" como serviço
- **O que:** formulário para o anunciante pedir a peça, e um card no admin para o dono entregar.
- **Por que:** padaria não tem vídeo vertical pronto; é a fricção nº 1 de conversão em self-serve local.
- **De onde veio:** pesquisa de mercado, 11/09/2026; memorize.tv inclui produção no plano topo.
- **O que toca:** formulário, aba no admin, e o campo de "incluído" no plano.
- **Quando vale a pena:** no primeiro anunciante que pagar e travar no upload.

## Venda por campanha (período + subconjunto de pontos)
- **O que:** contratar N semanas em telas escolhidas, com data de início.
- **Por que:** metade da demanda local é sazonal e o cliente não assina 3 meses de cara.
- **De onde veio:** pesquisa de mercado, 11/09/2026 (Aqui Ads vende a partir de 1 semana).
- **O que toca:** motor de playlist, checkout (pagamento único), pacing.
- **Quando vale a pena:** quando três clientes pedirem "só no Dia das Mães" no mesmo trimestre.

## QR rastreável por criativo e por ponto
- **O que:** link curto com QR por peça e por tela, com contagem de acessos.
- **Por que:** única atribuição viável nessa escala e argumento de renovação.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** tabela de links, redirecionador, painel do anunciante.
- **Quando vale a pena:** quando um anunciante perguntar "veio alguém por causa disso?".

## Mapa dos pontos com foto real na página pública
- **O que:** "Onde estamos" em mapa, com foto da tela instalada e perfil do público.
- **Por que:** todo self-serve é map-based; o anunciante compra com os olhos.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** `pontos.html`; a foto de instalação já existe no cadastro do ponto.
- **Quando vale a pena:** com 10+ pontos ativos.

## Uptime por tela exposto ao anunciante
- **O que:** "98,7% no mês" por tela, no painel do anunciante.
- **Por que:** o heartbeat já existe; mostrar antes de perguntarem converte desconfiança em confiança.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** agregação sobre `ultima_vez_online` histórica (precisa passar a guardar histórico, não só o último).
- **Quando vale a pena:** junto do comprovante em PDF.

## Assinatura eletrônica do contrato com IP, data e hash
- **O que:** aceite registrado do contrato de comodato e do de anunciante.
- **Por que:** equipamento caro em loja de terceiro; aceite por checkbox é fraco.
- **De onde veio:** pesquisa de mercado, 11/09/2026; skill `legal`.
- **O que toca:** cadastro via convite, tabela de aceites.
- **Quando vale a pena:** antes da primeira tela instalada num comércio que não seja de conhecido.

## Kit do vendedor (proposta em PDF, pipeline de leads)
- **O que:** proposta gerada com os dados do prospect; lista de leads do vendedor.
- **Por que:** vendedor sem material vende mal e desiste.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** painel do vendedor.
- **Quando vale a pena:** no segundo vendedor ativo.

## Cupom de primeira compra reaproveitando o cupom do vendedor
- **O que:** desconto de aquisição sobre a mesma mecânica de cupom.
- **Por que:** reaproveitamento quase puro.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** tabela de cupons, checkout.
- **Quando vale a pena:** na primeira campanha de aquisição paga.

## Trial de 15 dias
- **O que:** período grátis antes da primeira cobrança.
- **Por que:** memorize.tv dá 10 dias; Yeloo dá 7; o ciclo de decisão de interior é mais lento.
- **De onde veio:** pesquisa de custos, 12/09/2026.
- **O que toca:** contrato com o San Checkout (início postergado de assinatura) — depende da auditoria da última estação do Checkout.
- **Quando vale a pena:** quando o programa de fundador fechar as vagas.

## Sobretaxa de exclusividade de categoria
- **O que:** o anunciante paga a mais para ser o único do ramo na rede.
- **Por que:** em cidade pequena é o ativo comercial mais forte; o bloqueio de concorrente já existe no motor, falta cobrar por ele.
- **De onde veio:** pesquisa de custos, 12/09/2026 (+40% sugerido, sem fonte pública).
- **O que toca:** campo no plano ou na assinatura; motor já bloqueia.
- **Quando vale a pena:** quando dois anunciantes do mesmo ramo disputarem a rede.

## Duas instâncias do servidor no Northflank
- **O que:** subir de 1 para 2 instâncias do serviço — tolerância a falha (uma cai, a outra serve) e folga pra picos, em vez de depender de o contêiner único reiniciar.
- **Por que:** hoje qualquer reinício é janela de indisponibilidade, e o deploy derruba o único processo que existe. Com o player das TVs consultando a playlist de 15 em 15 minutos, uma queda longa some com anúncio no ar.
- **De onde veio:** ideia do dono, 15/09/2026, na revisão da Estação 5.
- **O que toca:** **três estados que hoje moram na memória do processo e quebram com duas instâncias** — o cache de playlist (`src/playlist/routes.js`, `new Map()`, já avisado no `CONSTRAINTS.md` linha 94: "Uma instância só"), o limite de tentativas de login (`src/lib/limite-tentativas.js`, `new Map()` — com duas instâncias o atacante ganha o dobro de tentativas) e a fila de retry da conciliação (`src/financeiro/conciliacao.js`). Os três precisam ir pro Postgres (ou Redis) antes de a segunda instância subir. Depois, a escala em si é um número no painel do Northflank, e o `CONSTRAINTS.md` precisa perder a linha da instância única.
- **Quando vale a pena:** quando houver TV de terceiro no ar dependendo da playlist — aí indisponibilidade vira anúncio que não rodou e cliente que não foi entregue. Antes disso, uma instância com health check (que já existe) é proporcional.

## Endereço do anunciante pré-preenchido no checkout
- **O que:** mandar o endereço comercial que o Mostraí já tem (rua, número, bairro, CEP, cidade, UF) junto do `pagador`, pra pessoa não redigitar na tela de pagamento.
- **Por que:** o `POST /assinatura` do Checkout **exige** endereço completo com código IBGE (antifraude de cartão da Asaas). Hoje o anunciante digita endereço no cadastro do Mostraí — que é obrigatório pra poder assinar — e digita tudo de novo no checkout. É digitação dobrada no momento de maior desistência, o do pagamento.
- **De onde veio:** teste do caminho de pagamento em sandbox, 15/09/2026 — a chamada real recusou sem endereço ("Endereço completo (rua, número, bairro e CEP) é obrigatório") e sem CEP existente ("O campo postalCode é inválido").
- **O que toca:** `montarRespostaPlano` em `src/financeiro/san-checkout.js` — **mas depende do Checkout primeiro**: o contrato do `pagador` (API.md, seção 3) só aceita nome, e-mail, documento e telefone. Sem campo de endereço lá, não há onde mandar.
- **Quando vale a pena:** quando o Checkout aceitar endereço no `pagador`; até lá é pedido pra quem administra o Checkout, não construção nossa. Se aparecer desistência no checkout antes disso, vira prioridade.

## Cobertura restrita por ciclo, sorteada entre pontos
- **O que:** ligar de verdade `planos.cobertura` no gerador de playlist — hoje todo plano cobre 100% da rede (menos concorrente direto), o campo existe mas não é lido. **Atualização de 15/09/2026, pedido do dono (revista no mesmo dia):** ele pediu primeiro um número livre; depois voltou atrás e pediu uma **lista fixa de opções** — `1, 2, 3, 5, 10, 15, 20, 25+` pontos — mais uma opção **"todos os pontos"**. Enquanto a rede tiver poucos pontos, ele vai usar "todos". Junto, um sorteio diário que escolhe EM QUAIS pontos cada anunciante restrito entra, ponderado pela vaga sobrando de cada ponto (preenche os mais vazios primeiro) e com rodízio por histórico (não fixa sempre no mesmo ponto).
- **Por que:** sem isso, "1 ponto/dia" e "3 pontos/dia" são só rótulo na grade — não existe diferença de entrega entre um plano de entrada e o Máximo além da frequência. A lista fixa (em vez de número livre) é escolha do dono: opções redondas de venda, não qualquer número.
- **De onde veio:** `docs/catalogo-beneficios.md` (seção 2) e `docs/economia-da-rede.md` (seção 4), a pedido do dono em 15/09/2026; revisado duas vezes no mesmo dia, na rodada de depuração da página de Planos — primeiro pra número livre, depois pra esta lista fixa.
- **O que toca:** a coluna `planos.cobertura` (hoje enum de 2 valores) precisa virar um enum maior (ou `limite_pontos int null` com CHECK restrito a `{1,2,3,5,10,15,20,25}` + null pra "todos", e uma convenção pra "25+" — não está claro ainda se é um teto exato de 25 ou "25 ou mais sem teto"; perguntar ao dono na hora de construir); `anunciantesElegiveis` e `gerarPlaylistDaHora` (`src/playlist/gerador.js`) pra aplicar o teto; o formulário de plano no admin (`public/admin/index.page.js`, `renderPlanos`) — continua `<select>`, só com mais opções; uma tabela ou coluna nova pra guardar em quais pontos cada anunciante restrito está hoje e o histórico de rodízio.
- **Quando vale a pena:** quando o primeiro plano de entrada precisar custar visivelmente menos por entregar visivelmente menos (hoje o corte é só de frequência, não de alcance). Até a rede crescer além de ~25 pontos, "todos" resolve.

## Teto de 3 criativos por plano travado no código e no banco
- **O que:** `planos.limite_criativos` tem CHECK de 1 a 3 no banco (migration 015) **e** `limiteDeCriativos()` em `src/playlist/gerador.js` aplica `Math.min(3, ...)` por cima disso — então mesmo que o dono editasse esse campo pra um número maior num plano novo, o sistema ignora e trava em 3 de qualquer jeito.
- **Por que:** o dono pediu, na mesma leva, "se tiver outras funções que podem ficar do jeito que eu escrever, já coloque também" — esse é o caso mais direto que existe hoje: um campo que parece livre no admin mas tem teto escondido no código e na constraint do banco.
- **De onde veio:** pedido do dono, 15/09/2026 (levantamento por causa do pedido de limite de pontos configurável).
- **O que toca:** `ALTER TABLE planos DROP CONSTRAINT planos_limite_criativos_check` (ou trocar o teto, numa migration nova) e trocar `Math.min(3, ...)` por um teto maior ou configurável em `limiteDeCriativos()` (`src/playlist/gerador.js`); o `max="3"` dos inputs em `public/admin/index.page.js` (`renderPlanos`) também precisa subir.
- **Quando vale a pena:** quando o dono quiser desenhar um plano com mais de 3 criativos ativos ao mesmo tempo — até lá, os planos atuais (1/2/3) não esbarram no teto.

## App Android TV nativo pra tela, no lugar do Fully Kiosk Browser
- **O que:** projeto **à parte** (repositório próprio, Android/Kotlin — não entra no código deste projeto) — um app mínimo pra Android TV que só faz uma coisa: abre `player.html` da tela dele no boot e fica nela. Reaproveita tudo que já existe aqui: chave de aparelho (`src/lib/aparelho.js`), margem/orientação por tela (entrada acima, "Margem e orientação..."), e o próprio player web sem mudar nada nele — o app é só o "moldura" que substitui o Fully Kiosk Browser, que o dono já testou e descartou (permissão demais, pouco controle).
- **Por que:** Fully Kiosk é produto genérico com centenas de opções — daí a permissão excessiva. Um app que só sabe abrir uma URL não precisa de quase nada disso. Só funciona em TV com Android TV/Google TV de verdade — **Samsung (Tizen) e LG (webOS) ficam de fora**, checar a marca antes de comprar tela pensando nisso.
- **De onde veio:** conversa do dono com o ChatGPT + discussão nesta sessão, 20-21/09/2026.
- **O que toca:** repositório novo, fora do Mostraí. Duas decisões de arquitetura já mapeadas: (1) PIN de destravar o kiosk — universal (mesmo em toda tela, simples de operar, mas vaza uma vez e destrava a rede inteira) vs. por instalação (mesmo padrão da chave de aparelho de hoje, mais seguro, mesmo trabalho de configurar); (2) trava anti-fuga de verdade + atualização remota 100% silenciosa **são o mesmo requisito técnico** — os dois pedem o app virar "Device Owner" do aparelho (aprovisionamento único por QR/NFC no primeiro boot pós-reset de fábrica, o mesmo mecanismo de frota corporativa). Sem isso, dá pra fazer os dois de forma mais simples (tela fixada + update com um toque de confirmação), só que sem ser 100% sem mão humana.
- **Quando vale a pena:** o dono já decidiu que é o próximo passo — retomar entendendo primeiro qual PIN e se vale o aprovisionamento Device Owner logo de cara ou começar pela versão manual.

## Margem e orientação por tela configuráveis no admin, não só na URL
- **O que:** ao cadastrar/editar uma tela, campos pra margem de cada lado (topo/direita/baixo/esquerda — não uma só, porque a moldura física às vezes cobre um lado bem mais que os outros) e pra orientação (a `paisagem`/vertical de hoje mais um formato "quadrado" pra TV fora do padrão 16:9). Hoje isso só existe como `?margem=` e `?orientacao=` na URL do player (`public/player.css`, `public/player.page.js`), que funciona mas depende de editar a URL na TV.
- **Por que:** o dono testou numa TV real e achou chato depender da URL — quer configurar isso junto com o resto do cadastro da tela, no admin.
- **De onde veio:** teste físico do dono com TV + TV stick, 19/09/2026. **Reafirmada em 21/09/2026**, já mirando o app Android nativo (`sancompany/playlist.mostrai`), que reproduziu o mesmo desenho de margem única: `ConfigAparelho.margemVmin`/`ConfigExterna.Dados.margemVmin` são um `Float` só, aplicado igual nos 4 lados em `PlayerActivity.aplicarMargemOverscan()` (`raiz.setPadding(px, px, px, px)`), e hoje só chega por arquivo local no pendrive ou extra de Intent — não pelo site. O dono foi explícito: a margem tem que vir do admin, não de arquivo, porque cada TV tem a sua margem de cada um dos 4 lados.
- **O que toca:** neste repositório — coluna(s) novas em `dispositivos` (4 margens + orientação, em vez do parâmetro único), rota de admin pra gravar, `GET /playlist/:id` ou uma rota de config devolvendo isso pro player aplicar sem precisar de query string nem arquivo local, `public/admin/index.page.js` (aba Telas). No app Android (`playlist.mostrai`) — trocar `margemVmin: Float` por 4 valores, passar a buscar do backend (provavelmente junto da resposta de `/playlist`, já que ela já é por `dispositivoId`) em vez de `ConfigExterna`/`ConfigAparelho`; ver `docs/pendencias.md` daquele repositório.
- **Quando vale a pena:** quando o dono revisar a parte de administração — ele mesmo pediu pra guardar a ideia até lá, não construir agora. Toca os dois repositórios (contrato novo de API + app), então quando entrar em construção precisa das duas sessões coordenadas, não só uma.

## Banco de horas nos dois sentidos: sobra acelera, aperto puxa do banco
- **O que:** hoje o banco de horas só anda num sentido — hora que corta vira déficit, que ganha prioridade depois (`src/bancohoras/`, `multiplicadorPorIdade` em `src/playlist/gerador.js`). A ideia é fechar o outro lado: hora com sobra de inventário (o que hoje vira peça institucional de preenchimento, `qtdInstitucional` em `montarHoraDeTv`, `src/lib/pacing.js`) passa a rodar MAIS exibição de anunciante em vez de só mostrar "este espaço pode ser seu" — e esse excedente entregue vira crédito guardado no banco, que amortece a próxima hora apertada (corte proporcional) antes de virar déficit de verdade. Efeito: quem entrega mais que o combinado numa hora vazia empresta pra si mesmo na hora cheia, em vez do sistema desperdiçar a sobra e cobrar o aperto do zero.
- **Por que:** pedido do dono, 20/09/2026 — resume como "tempo de sobra, anúncios rodam mais rápido; tempo apertado, guarda horas no banco". Hoje o sistema já registra o lado ruim (déficit) mas ignora o lado bom (sobra), que simplesmente vira institucional e não beneficia ninguém.
- **De onde veio:** conversa com o dono, 20/09/2026, junto do incidente de senha do Postgres (não relacionado — só o mesmo dia).
- **O que toca:** `montarHoraDeTv`/`espalhar` (`src/lib/pacing.js`) — decidir quem ganha o excedente e em que proporção (provavelmente pelo mesmo peso do déficit: quem está mais perto do teto do plano primeiro, ou round-robin entre os elegíveis); `src/bancohoras/repository.js` — hoje só tem `drenar` (saque), precisa de um `creditar`/depósito simétrico; `src/playlist/gerador.js` — gravar o excedente entregue por hora do mesmo jeito que grava o déficit hoje. Cuidado explícito: não pode virar cobrança a mais — é entrega adiantada de exibição já contratada, não exibição nova vendida.
- **Quando vale a pena:** quando o evento `playlist:hora_quase_cheia`/`playlist:teto_corta` (já registrados) mostrarem um padrão de horas cheias e vazias alternando na mesma tela — hoje ainda não dá pra saber se compensa sem medir isso primeiro.

## Folga de 15 minutos pro déficit da hora anterior
- **O que:** tratar a virada da hora como janela e não como parede — exibição programada numa hora conta como entregue se acontecer até 15 minutos depois da virada. *(Definição do dono, 16/09/2026: os 15 minutos são TOLERÂNCIA pra absorver um transbordo ou outro, não inventário reservado. A hora inteira continua vendável — a versão anterior desta entrada dizia "reservar os primeiros 15 minutos", e estava errada.)*
- **Por que:** hoje quem perde exibição numa hora cheia depende de a hora seguinte não estar cheia também pra recuperar — sem garantia, o déficit pode se acumular indefinidamente numa rede saturada.
- **CORREÇÃO DE 16/09/2026 — esta entrada, como está escrita, NÃO funcionaria.**
  Medido: numa rede superlotada estável (30 anunciantes de 12x/h, pedido de
  7200s pra uma hora de 3600s), cada um recebe 6 das 12 que contratou e o
  `deficit` registrado fica em **zero**, hora após hora. O motivo é que
  `gravarProgramados` grava em `vezes_programadas` o número DEPOIS do corte
  proporcional, não o contratado — então `deficit = programadas − confirmadas`
  dá zero, e a folga de 15 minutos não teria dívida nenhuma pra saldar.
  O `deficit` de hoje compensa **falha de entrega** (tela offline, vídeo que
  não tocou), não **falta de inventário** (rede vendida além da hora). São
  duas dívidas diferentes e só uma está escrita. Construir a folga exige,
  antes, registrar o contratado separado do programado — ver
  `docs/PENDENCIAS.md`, item 29.
- **De onde veio:** `docs/economia-da-rede.md` (seção 4), a pedido do dono em 15/09/2026; usa a mesma janela de 15 minutos que o player já visita (cache de playlist em `src/playlist/routes.js`).
- **O que toca:** `gerarPlaylistDaHora` e `calcularPlaylist` (`src/lib/pacing.js`) — precisa de um teto mínimo garantido pro déficit dentro da fatia de 15 min, separado do corte proporcional do resto da hora.
- **Quando vale a pena:** quando o evento `playlist:teto_corta` começar a repetir no mesmo dispositivo em horas seguidas — sinal de que o déficit está empilhando, não só oscilando.
- **Nota de 15/09/2026:** o dono também pediu, no mesmo dia, pra trocar a unidade de frequência do plano de "por dia" para "por hora" — isso **já foi construído** (migration 037, `planos.frequencia_hora`) e não tem mais nada a ver com esta entrada. No pedido original ele mencionou uma "folga de 15 minutos" para a frequência por hora, que parecia a mesma ideia desta entrada dita de outro jeito; no pedido final de "construa" ele simplificou pra só "N vezes por hora, a quantia que eu quiser", sem repetir a folga — então essa parte não foi construída, e continua em aberto só aqui, se ainda for uma ideia viva.
