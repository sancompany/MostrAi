# A teia do Mostraí

Mapa de todas as **387 funções** do produto e de como se ligam. Lido do código
em 15/09/2026 por doze leituras independentes, uma por superfície.

> **24/09/2026 — Player V2:** tudo o que este mapa diz sobre a **tela e o
> player** (chave de aparelho em `aparelho_id`, `gerarChave`, `/admin/dispositivos/:id/chave`,
> `/admin/pontos-offline`, comparação da chave fora de tempo constante, painel
> da TV conferindo a chave à mão) foi substituído: credencial por hash com
> provisionamento e rotação (`src/player/credencial.js`), autenticação única
> em `src/lib/aparelho.js`, rotas em `docs/api.md` e regras RN-58/59/60 em
> `docs/funcional.md`. As outras superfícies seguem como lidas em 15/09.

Cada função traz de onde a pessoa chega, para onde vai, e **o que ela fica
sabendo** — é nessa última coluna que mora a maior parte dos furos de
informação, catalogados em `docs/furos.md`.

| Superfície | Funções |
|---|---|
| [Site institucional público](#site-institucional-p-blico) | 38 |
| [Captação do anunciante](#capta-o-do-anunciante) | 25 |
| [Papel ponto (dono do comércio)](#papel-ponto-dono-do-com-rcio) | 23 |
| [Painel do anunciante](#painel-do-anunciante) | 24 |
| [Papel vendedor](#papel-vendedor) | 17 |
| [Administração](#administra-o) | 21 |
| [Tela e player](#tela-e-player) | 21 |
| [Caminho do dinheiro](#caminho-do-dinheiro) | 23 |
| [Modelo de dados](#modelo-de-dados) | 25 |
| [Superfície da API](#superf-cie-da-api) | 115 |
| [Contato fora do site](#contato-fora-do-site) | 28 |
| [Conteúdo informativo](#conte-do-informativo) | 27 |

---

## Site institucional público

Superfície institucional pública do Mostraí: 6 páginas HTML (`/index.html`, `/planos.html`, `/pontos.html`, `/contato.html`, `/404.html`, `/500.html`), 4 scripts de página (`index.page.js`, `planos.page.js`, `pontos.page.js`, `contato.page.js`) e os 2 scripts transversais (`public/layout.js` — cabeçalho, rodapé e botão flutuante de WhatsApp; `public/config.js` — API_BASE_URL, esc(), linkWhatsApp(), fmtBRL(), trava de duplo envio, barras). Quatro páginas declaram `data-layout="publico"` no <body> e recebem menu+rodapé+FAB montados em runtime; a 500.html não carrega script nenhum de propósito. Toda a superfície consome 4 rotas públicas do backend — `GET /planos`, `GET /pontos`, `GET…

**ajustarWhatsApp() — IIFE no topo de layout.js** — Percorre todo `a[data-wa]` do HTML e reescreve o href a partir de window.linkWhatsApp(mensagem do data-wa), para que o número viva num lugar só. O href literal fica no markup para funcionar sem JS.
  · `public/layout.js` · papéis: visitante anônimo, conta logada
  · ← toda página que carrega config.js + layout.js  → https://wa.me/5516994635946?text=...
  · **cliente sabe:** Invisível ao cliente — ele só vê o link. A mensagem pré-preenchida por página é a explicação ("Olá! Vim pelo site da Mostraí e quero saber mais.").

**ehAqui(href) / link([href,texto]) — marcação da página atual** — Compara `window.location.pathname` (com `/index.html` normalizado para `/`) com o href do item de menu e adiciona `aria-current="page"`. A comparação é por prefixo: `AQUI.startsWith(href.replace('.html',''))`.
  · `public/layout.js` · papéis: visitante anônimo, conta logada
  · ← montagem do cabeçalho em qualquer data-layout
  · **cliente sabe:** Sim, implicitamente: o item atual fica marcado. Nenhum texto explica; é só estado visual + aria-current para leitor de tela.

**navPublico() — menu do site institucional** — Monta a constante MENU_PUBLICO com 7 links — `/` (Home), `/planos.html` (Planos), `/pontos.html` (Onde estamos?), `/anunciante/cadastro.html` (Anuncie), `/seja-um-ponto.html` (Seja um ponto), `/seja-um-vendedor.html` (Seja um vendedor), `/contato.html`…
  · `public/layout.js` · papéis: visitante anônimo
  · ← index.html, planos.html, pontos.html, contato.html, 404.html (todas com data-layout="publico")  → / / /planos.html / /pontos.html
  · **cliente sabe:** Parcial. "Onde estamos?" e "Anuncie" são autoexplicativos; "Seja um ponto" e "Seja um vendedor" não dizem o que é ponto nem o que o vendedor ganha — a explicação só existe dentro da página de destino…

**navConta() — menu da conta (não é superfície institucional, mas substitui o menu público)** — Monta a aba única Painel (`/anunciante/painel.html`, chamava-se "Anúncios" até 19/09/2026), o link Planos e o botão de avatar #btnPerfil. "Meu ponto" e "Vendas" saíram do topo (pedido do dono: ponto virou card de candidatura no fim do próprio Painel, vendedor deixou de ser algo aberto ao público) — as duas páginas (`ponto.html`, `vendedor.html`) foram aposentadas depois (vendedor com o programa; ponto com o painel único, 23/09/2026) e redirecionam pro Painel.
  · `public/layout.js` · papéis: anunciante
  · ← páginas de /anunciante/  → /anunciante/painel.html / /anunciante/ponto.html / /anunciante/vendedor.html
  · **cliente sabe:** Sim, via aplicarPapeisNoMenu: aba de papel não ativado recebe `title="Modo ainda não ativado — clique pra ativar"` e classe `bloqueado`.

**navMinimo() — cabeçalho reduzido** — Só o logo e, opcionalmente, um botão vindo de `data-layout-botao="Texto|/destino"`. É também o fallback quando `data-layout` traz valor desconhecido (`NAVS[layout] || navMinimo`).
  · `public/layout.js` · papéis: visitante anônimo
  · ← páginas de cadastro/convite  → destino do data-layout-botao
  · **cliente sabe:** Não — é só chrome. Nenhuma das páginas institucionais mapeadas usa este modo.

**window.aplicarPapeisNoMenu(conta)** — Liga/desliga a classe `bloqueado` e o `title` das abas navDashboard / navMeuPonto / navVendas conforme `conta.papeis` (default `['anunciante']`).
  · `public/layout.js` · rotas: `GET /anunciantes/me` · papéis: anunciante, ponto, vendedor
  · ← páginas com data-layout="conta"
  · **cliente sabe:** Sim — o title é a explicação: "Modo ainda não ativado — clique pra ativar".

**Cabeçalho <header class="site"> injetado por insertAdjacentHTML('afterbegin')** — Insere o logo (`/img/logo-mostrai-wordmark.png`, alt "Mostraí", link para `/`) e o <nav class="main"> escolhido pelo data-layout. O HTML das páginas não tem cabeçalho nenhum.
  · `public/layout.js` · papéis: visitante anônimo, conta logada
  · ← qualquer página com data-layout != 'nenhum'  → /
  · **cliente sabe:** Não se aplica.

**Rodapé <footer class="site"> injetado por insertAdjacentHTML('beforeend')** — Escreve a linha "© Mostraí — Matão-SP. Parte do ecossistema San & Co.", os 4 links legais (`/termos-de-uso.html`, `/politica-de-privacidade.html`, `/comodato.html`, `/contrato-anunciante.html`) e `mailto:mostrai@sancocore.com.br`.
  · `public/layout.js` · papéis: visitante anônimo, conta logada
  · ← todas as páginas com data-layout != 'nenhum'  → /termos-de-uso.html / /politica-de-privacidade.html / /comodato.html
  · **cliente sabe:** Fraco: os 4 links são só o nome do documento, sem uma linha dizendo o que cada um cobre. O rodapé NÃO tem link para /contato.html — e o menu de quem está logado também perde o Contato, então a conta…

**Botão flutuante de WhatsApp (.whatsapp-fab)** — Ancora fixa injetada junto do rodapé, com SVG inline do ícone, `target="_blank" rel="noopener"`, aria-label "Falar no WhatsApp" e mensagem fixa "Olá! Vim pelo site da Mostraí e quero saber mais.".
  · `public/layout.js` · papéis: visitante anônimo, conta logada
  · ← todas as páginas com data-layout != 'nenhum' — inclusive a 404  → wa.me/5516994635946
  · **cliente sabe:** Só o aria-label. Não há texto visível, horário de atendimento nem promessa de tempo de resposta no FAB — isso só aparece dentro de /contato.html ("em horário comercial, geralmente em minutos"). A…

**window.carregarConta()** — Faz um único `fetch(API_BASE_URL + '/anunciantes/me', {credentials:'include'})` memoizado em `window.__conta`; devolve a conta ou null. É a promessa compartilhada por layout.js, planos.page.js e pelos painéis.
  · `public/layout.js` · rotas: `GET /anunciantes/me` · papéis: visitante anônimo (recebe null), conta logada
  · ← qualquer página com data-layout 'publico' ou 'conta'
  · **cliente sabe:** Não — é silencioso. Falha de rede vira `null`, indistinguível de "não logado"; o visitante continua vendo "Entrar" sem saber que a checagem falhou.

**Troca do menu público pelo menu da conta (bloco `if (layout === 'publico')` em layout.js)** — Se carregarConta() devolve conta, substitui o innerHTML inteiro de `header.site nav.main` pelas abas Anúncios/Meu ponto/Vendas + Planos + avatar (foto_url ou inicial de nome_empresa, escapada com esc()), e marca `document.body.dataset.logado = '1'`. Calcula a…
  · `public/layout.js` · rotas: `GET /anunciantes/me` · papéis: anunciante, ponto, vendedor
  · ← index.html, planos.html, pontos.html, contato.html, 404.html quando há sessão  → /anunciante/painel.html / /anunciante/ponto.html / /anunciante/vendedor.html
  · **cliente sabe:** Não. O menu de marketing inteiro some sem aviso — a pessoa logada perde da navegação "Onde estamos?", "Seja um ponto", "Seja um vendedor" e "Contato". As abas de papel não ativado ficam com classe…

**window.ROTULOS** — Dicionário único de rótulos e classes de badge por status (anunciante, ponto, pontoClasse, criativo, criativoClasse, vendedor), criado para acabar com textos divergentes entre telas.
  · `public/layout.js` · papéis: conta logada, admin
  · ← painéis e admin
  · **cliente sabe:** Sim, é literalmente o texto que o cliente lê (ex.: "Aprovado — escolha um plano"). Mas a superfície pública NÃO o usa: pontos.page.js tem tabela própria (STATUS_LABEL) e chama `aguardando_instalacao`…

**API_BASE_URL / REDE_LOCAL (config.js)** — Define a base de toda chamada de API. Testa o hostname contra a regex REDE_LOCAL (localhost, 127.0.0.1, ::1, 10., 192.168., 172.16–31.) para cobrir a TV do ponto abrindo o player pelo IP da rede. Hoje os DOIS ramos do ternário devolvem…
  · `public/config.js` · papéis: visitante anônimo, conta logada, TV/player
  · ← primeiro <script> de toda página com JS
  · **cliente sabe:** Não se aplica.

**window.esc(v)** — Escapa & < > " ' antes de qualquer innerHTML. Existe porque nome de empresa e de ponto vêm de formulário público, sem autenticação, e são renderizados na sessão de outra pessoa.
  · `public/config.js` · papéis: visitante anônimo, conta logada
  · ← pontos.page.js (esc(p.nome), esc(p.cidade), esc(p.endereco)), planos.page.js (esc(p.nome), esc(p.rotulo), esc(b)), layout.js (avatar)
  · **cliente sabe:** Não se aplica — é a primeira camada de defesa; a CSP sem 'unsafe-inline' em src/server.js é a segunda.

**window.WHATSAPP + window.linkWhatsApp(mensagem)** — Constante única do número (5516994635946, formato wa.me: só dígitos) e montador do link com a mensagem pré-preenchida, encodeURIComponent.
  · `public/config.js` · papéis: visitante anônimo, conta logada
  · ← layout.js (FAB e data-wa), contato.html, 500.html (href literal)  → https://wa.me/...
  · **cliente sabe:** A mensagem pré-preenchida é a explicação para o dono, não para o cliente.

**window.fmtBRL(v)** — Formata Number(v||0) em pt-BR/BRL. planos.page.js faz `const fmt = fmtBRL` justamente porque a versão local usava Number(v) e virava 'R$ NaN'.
  · `public/config.js`, `public/planos.page.js` · papéis: visitante anônimo
  · ← planos.page.js (preço, preço riscado, total do ciclo, economia)
  · **cliente sabe:** Sim, indiretamente: o cliente vê R$ formatado. Valor ausente vira "R$ 0,00" em vez de sumir — não há estado para preço ausente.

**travarDuploEnvio() — IIFE de config.js** — Monkey-patch em window.fetch contando requisições em voo + listener de `submit` em captura que desabilita o primeiro `button[type=submit]` do form e o libera quando `emVoo === 0`, com teto de 15s. Existe porque dois cliques criavam duas contas / dois pontos /…
  · `public/config.js` · papéis: visitante anônimo
  · ← formContato de /contato.html e todos os formulários do site
  · **cliente sabe:** Não. O botão fica apenas desabilitado — sem trocar rótulo para "Enviando...", sem spinner. Quem vê a mudança é só o texto de #msg, escrito pelo contato.page.js.

**window.aplicarBarras(raiz) + MutationObserver** — Lê `data-pct` (clamp 0–100) e aplica via CSSOM `height` (.bar) ou `width` (.fill), marcando com data-pct-ok. Existe para não precisar de `style-src 'unsafe-inline'` na CSP. Observa document.documentElement inteiro (childList+subtree) e também roda no…
  · `public/config.js` · papéis: conta logada, admin
  · ← painéis e admin — nenhuma das 6 páginas institucionais tem [data-pct]
  · **cliente sabe:** Não se aplica.

**index.html — hero + CTA principal** — Símbolo (`/img/simbolo-lampada.png`), eyebrow "Publicidade física em Matão-SP", H1 "Sua marca está onde o seu cliente está?", lead longo e três CTAs: "Quero anunciar" (btn primary), "Quero ser um ponto", "Quero ser vendedor". Traz também um <p id="heroFluxo"…
  · `public/index.html` · papéis: visitante anônimo
  · ← raiz do domínio, sitemap.xml, logo do cabeçalho de qualquer página, botão "Voltar para o início" da 404 e "Tentar de novo" da 500  → /anunciante/cadastro.html / /seja-um-ponto.html / /seja-um-vendedor.html
  · **cliente sabe:** Sim, em prosa (restaurantes, academias, barbearias, salas de espera). Mas "Quero anunciar" vai direto para o cadastro SEM `?plano=` e sem passar pelos planos — a pessoa cria conta antes de ver preço.…

**index.html — três cards de público (.split)** — Um card por papel: Anunciante ("Sua marca em evidência, sem depender de agência" → /anunciante/cadastro.html), Ponto ("Sua parede rende dinheiro todo mês", com R$ 50/mês de ajuda de custo OU o triplo de espaço → /seja-um-ponto.html) e Vendedor parceiro (link…
  · `public/index.html` · papéis: visitante anônimo
  · ← rolagem da home  → /anunciante/cadastro.html / /seja-um-ponto.html / /seja-um-vendedor.html
  · **cliente sabe:** Sim, e é a melhor explicação da conta de três papéis em todo o site. Ressalva: o valor "R$ 50 por mês" e "o triplo de espaço" estão escritos à mão no HTML, enquanto o número real vem de…

**index.html — seção "Como funciona" (3 passos) e "Por que funciona" (4 razões)** — Passos 1 Crie sua conta / 2 Suba seu criativo (imagem ou vídeo de 15–30s em 9:16, com a Mostraí fazendo a edição) / 3 Acompanhe o resultado. Razões: tempo de espera vira atenção; rotação garantida com painel; sem concorrente do seu lado; troca de anúncio…
  · `public/index.html` · papéis: visitante anônimo
  · ← rolagem da home
  · **cliente sabe:** É a única explicação de formato (9:16, 15–30s) e de que existe aprovação antes do ar. Não diz quanto tempo leva a aprovação, nem o que acontece se o criativo for reprovado, nem quantos criativos o…

**index.page.js — prova social de fluxo** — `fetch(API_BASE_URL + '/pontos/fluxo')` → se `pessoasPorMes` for verdadeiro, escreve em #heroFluxo "<b>N pessoas</b> veem sua marca por mês nos pontos da Mostraí." e tira o hidden. Sem "já instalados" (19/09/2026, pedido do dono) — o texto não diz mais se o ponto está no ar ou em instalação. Catch vazio.
  · `public/index.page.js` · rotas: `GET /pontos/fluxo → src/pontos/routes.js:24 → repository.somaFluxoMensal()` · papéis: visitante anônimo
  · ← carregamento da home
  · **cliente sabe:** O número é afirmado sem metodologia: não diz que é estimativa declarada pelos donos dos pontos, nem que só conta ponto ativo (`status = 'em_operacao'`, apesar do texto não mencionar mais isso). O piso de 1.000 pra exibir saiu (19/09/2026, pedido do dono — só continua null em zero); quando a API cai, a linha…

**index.html — JSON-LD (@graph Organization + WebSite)** — Bloco application/ld+json com Organization (#organizacao) — nome, url, logo, description, email mostrai@sancocore.com.br, telephone +5516994635946, areaServed Matão/SP, address, parentOrganization San & Co., contactPoint de vendas — e WebSite (#site). O…
  · `public/index.html`, `public/planos.html`, `public/contato.html` · papéis: robô de busca
  · ← buscador
  · **cliente sabe:** Não é para o cliente. Observação: a description do JSON-LD é a explicação mais precisa do modelo de negócio em todo o site, e nenhum humano a lê.

**planos.page.js — boot (Promise.all([GET /planos, carregarLogin]))** — Carrega os planos e, em paralelo, `carregarConta()` para saber se está logado (LOGADO). No sucesso chama atualizarDescontos(), renderFundador() e render(3) — trimestral é o ciclo default, casado com `class="active"` no botão data-meses=3. No catch escreve em…
  · `public/planos.page.js`, `public/planos.html` · rotas: `GET /planos → src/financeiro/routes.js:23`, `GET /anunciantes/me` · papéis: visitante anônimo, anunciante logado
  · ← menu "Planos", CTA final da home ("Ver planos e preços"), card "Ver planos e anunciar", botão "Ver os planos" da 404, menu da conta logada  → /anunciante/cadastro.html?plano=ID (deslogado) / /anunciante/painel.html?plano=ID (logado)
  · **cliente sabe:** O destino do botão muda conforme o login sem avisar. Quem está logado vai para o painel, que gera a cobrança — não há confirmação intermediária nesta página dizendo que clicar ali inicia uma cobrança.

**planos.page.js — render(meses) da grade normal** — Filtra `compromisso_meses === meses && !fundador` e monta um .plan-card por plano com: badge "Mais escolhido" (destaque_no_site), rótulo, nome do tier, "Nx por dia em cada ponto (≈Mx por hora)", preço cheio riscado (referência × meses), total do ciclo em…
  · `public/planos.page.js` · rotas: `GET /planos` · papéis: visitante anônimo, anunciante logado
  · ← boot e cliques no #cycleToggle  → /anunciante/cadastro.html?plano=ID / /anunciante/painel.html?plano=ID
  · **cliente sabe:** Bem explicado no preço: o riscado, o total do ciclo e a economia por mês estão todos na tela. A frequência agora é por hora direto (`frequencia_hora`, migration 037); o "≈Nx por dia" mostrado é só estimativa (`frequencia_hora × 12`), rotulada como "num comércio aberto 12h" — não é mais o valor real que decide quanto roda, então…

**planos.page.js — renderFundador()** — Filtra `p.fundador`, soma `vagas_restantes` e escreve o aviso "Programa fundador aberto. Quem entra agora trava o preço de lançamento pelo tempo do plano — restam N vagas." e um card único (grid de 1 coluna, max 440px) com badge Fundador, preço riscado,…
  · `public/planos.page.js`, `public/planos.html` · rotas: `GET /planos` · papéis: visitante anônimo, anunciante logado
  · ← boot de /planos.html  → /anunciante/cadastro.html?plano=ID / /anunciante/painel.html?plano=ID
  · **cliente sabe:** Sim — é o bloco mais bem explicado do site: diz o que trava, por quanto tempo, quantas vagas restam e que depois valem os planos normais. Escassez ("restam N vagas") é afirmada sem dizer de onde sai…

**planos.page.js — #cycleToggle e atualizarDescontos()** — Quatro botões (1/3/6/12 meses) que trocam a classe active e chamam render(meses). atualizarDescontos() calcula, por ciclo, `Math.round((1 - valor_mensal/mensalDoTier) * 100)` e escreve o maior como "-N%" no <small> do botão — o desconto sai dos preços do…
  · `public/planos.page.js`, `public/planos.html` · rotas: `GET /planos` · papéis: visitante anônimo
  · ← clique do visitante
  · **cliente sabe:** Parcialmente. O #cycleNote muda por ciclo e explica a cobrança ("Você paga uma vez a cada 3 meses. O valor por mês abaixo é a referência...", "Sem compromisso: cobrança todo mês, cancele quando…

**planos.page.js — #planosFluxo** — Mesmo `GET /pontos/fluxo` da home; escreve "Os pontos estimam <b>N pessoas por mês</b> passando na frente das telas." e tira o hidden. Sem "no ar" (19/09/2026, pedido do dono, mesmo motivo do texto da home). Catch vazio.
  · `public/planos.page.js` · rotas: `GET /pontos/fluxo` · papéis: visitante anônimo
  · ← carregamento de /planos.html
  · **cliente sabe:** Mesma lacuna da home: número sem metodologia, ausência silenciosa.

**pontos.page.js — #statRow (contadores da rede)** — A partir do `GET /pontos`, conta `status==='ativo'`, `status==='aguardando_instalacao'` e o tamanho do Set de cidades, e escreve três .stat: "Pontos ativos", "Em instalação" e "Cidade atendida"/"Cidades atendidas" (com fallback `cidades || 1`). Depois insere…
  · `public/pontos.page.js`, `public/pontos.html` · rotas: `GET /pontos → repository.listarPublicos()`, `GET /pontos/fluxo` · papéis: visitante anônimo
  · ← menu "Onde estamos?"
  · **cliente sabe:** Os rótulos são curtos mas claros. Pontos em `reparo` entram na lista e no total implícito mas não têm contador próprio, e nenhum texto diz isso.

**pontos.page.js — grade de pontos (.ponto-card) + link do mapa** — Um card por ponto com badge de status (STATUS_LABEL local: ativo→"Ativo"/badge-ok, aguardando_instalacao→"Em construção"/badge-pendente, reparo→"Em reparo"/badge-err), nome e "cidade — endereço" escapados, e o link "📍 Ver no mapa" para google.com/maps/search…
  · `public/pontos.page.js` · rotas: `GET /pontos` · papéis: visitante anônimo
  · ← /pontos.html  → https://www.google.com/maps/search/?api=1&query=...
  · **cliente sabe:** "Em construção" e "Em reparo" aparecem como badge sem legenda; o lead da página explica só o primeiro ("Pontos em instalação entram na sua cobertura assim que forem ligados, sem você pagar nada a…

**pontos.html — mapa embutido, foto de exemplo e bloco de 4 razões** — <iframe> do Google Maps centrado em Matão-SP (loading=lazy, title acessível), a <figure> `/img/exemplo-ponto-completo.jpg` com legenda explicando o molde de acabamento, e quatro .razao: tela vertical 9:16; player conectado o tempo todo ("se algum ponto cai,…
  · `public/pontos.html` · papéis: visitante anônimo
  · ← rolagem de /pontos.html  → /seja-um-ponto.html
  · **cliente sabe:** Explica bem o produto físico. Duas promessas comerciais ficam sem contrapartida visível nesta superfície: "você não paga por exibição que não aconteceu" (não há política de abatimento explicada em…

**contato.html — formulário #formContato** — Quatro campos: nome (required), telefone/WhatsApp (marcado "*opcional"), email (type=email, required), mensagem (textarea rows=6, required), botão "Enviar mensagem" e <p class="form-msg" id="msg"> para o retorno.
  · `public/contato.html` · rotas: `POST /contato` · papéis: visitante anônimo, conta logada (que, porém, não tem link de menu para chegar aqui)
  · ← menu "Contato", link "nos avise" da 404.html  → permanece na própria página
  · **cliente sabe:** O cabeçalho explica bem para que serve ("Quer anunciar, quer uma tela no seu comércio ou só quer entender como tudo funciona?"). Falta: nenhum aviso de privacidade nem link para…

**contato.page.js — submit handler** — preventDefault, escreve "Enviando..." em #msg, POSTa `Object.fromEntries(new FormData(form))` como JSON em `${API_BASE_URL}/contato`; se `r.ok` mostra "Mensagem enviada! A gente responde no e-mail informado." (class form-msg ok) e dá form.reset(); no catch…
  · `public/contato.page.js` · rotas: `POST /contato → src/conta/routes.js:76, com middleware limiteTentativas` · papéis: visitante anônimo
  · ← clique em "Enviar mensagem"  → nenhuma navegação; sugere o WhatsApp no erro
  · **cliente sabe:** O sucesso explica o próximo passo ("responde no e-mail informado") e o erro oferece saída (WhatsApp). Mas o corpo da resposta do servidor é descartado: 400 ("campos obrigatórios faltando"), 429…

**contato.html — coluna lateral (.contato-lado)** — Dois .split-card: "Resposta rápida" com o botão "Chamar no WhatsApp" (href literal no markup + data-wa reescrito pelo layout.js) e a promessa "em horário comercial, geralmente em minutos"; e "Outros canais" com mailto:mostrai@sancocore.com.br e "Matão — SP.…
  · `public/contato.html` · papéis: visitante anônimo
  · ← /contato.html  → wa.me/5516994635946 / mailto:mostrai@sancocore.com.br
  · **cliente sabe:** Sim — é o único lugar do site que promete tempo de resposta. Não há endereço físico, CNPJ, nem horário de atendimento em números.

**404.html** — Página estática com data-layout="publico" (ganha menu, rodapé e FAB de WhatsApp), `<meta name="robots" content="noindex">`, eyebrow "Erro 404", H1 "Essa página não existe", lead "O endereço pode ter mudado, ou o link que você abriu está velho. Nada quebrou do…
  · `public/404.html`, `src/server.js` · rotas: `handler 404 de src/server.js: `querHtml(req)` (Accept cru contendo text/html) → status 404 + sendFile 404.html; senão 404 JSON `{erro:'não encontrado'}`` · papéis: visitante anônimo, conta logada
  · ← qualquer URL inexistente aberta por navegador  → / / /planos.html / /contato.html
  · **cliente sabe:** Sim, e bem: diz que nada quebrou e oferece saída. Não mostra qual endereço falhou, não tem busca e não sugere as páginas mais próximas.

**500.html** — Página deliberadamente sem config.js, sem layout.js e sem fetch — o comentário no <head> diz que é justamente quando a aplicação falhou que ela precisa abrir. Só style.css. Eyebrow "Erro 500", H1 "Alguma coisa falhou do nosso lado", "Não foi você. O erro foi…
  · `public/500.html`, `src/server.js` · rotas: `error handler global de src/server.js: se `querHtml(req)` → 500 + sendFile 500.html; senão `{erro:'erro interno'}`. Antes dele: entity.parse.failed→400, entity.too.large→413, LIMIT_FILE_SIZE→413, filtro do multer→400` · papéis: visitante anônimo, conta logada
  · ← qualquer erro não tratado com Accept: text/html  → / / wa.me (href literal, sem passar pelo linkWhatsApp)
  · **cliente sabe:** É a melhor redação de erro do site: assume a culpa, diz que foi registrado e antecipa o medo real (cobrança duplicada). Custo: sem <body data-layout>, a página não tem cabeçalho, logo, rodapé, menu…

**MUDARAM_DE_ENDERECO — redirecionamentos 301 (src/server.js)** — Quatro `app.get` respondendo 301: /afiliado/cadastro.html → /seja-um-vendedor.html, /afiliado/login.html → /anunciante/login.html, /afiliado/painel.html → /anunciante/vendedor.html, /anunciante/perfil.html → /anunciante/painel.html. Substituiu quatro HTMLs…
  · `src/server.js` · rotas: `GET /afiliado/*`, `GET /anunciante/perfil.html` · papéis: visitante anônimo, conta logada
  · ← link salvo, favorito, indexação antiga  → /seja-um-vendedor.html / /anunciante/login.html / /anunciante/vendedor.html
  · **cliente sabe:** Não — a pessoa cai na página nova sem nenhuma faixa dizendo "esta página mudou de endereço".

**robots.txt / sitemap.xml / site.webmanifest** — robots.txt bloqueia só /admin/ e /player.html (o resto usa noindex no HTML, de propósito, porque página bloqueada no robots nunca é lida e o noindex nunca é visto) e aponta o sitemap. sitemap.xml lista 11 URLs com lastmod 2026-09-14. site.webmanifest declara…
  · `public/robots.txt`, `public/sitemap.xml`, `public/site.webmanifest` · papéis: robô de busca
  · ← robô de busca / navegador
  · **cliente sabe:** Não se aplica. O sitemap inclui corretamente as 4 páginas institucionais indexáveis e exclui 404/500; não inclui /anunciante/login.html nem /esqueci-senha.html.

**Estados sem tela:** /planos.html — CARREGANDO não existe. `#plansGrid` e `#fundadorBloco` ficam vazios entre o load e a resposta do `GET… · /planos.html — VAZIO não existe. Se `GET /planos` devolver `[]`, ou se simplesmente não houver plano com… · /planos.html — ERRO é parcial: escreve "Não foi possível carregar os planos agora." só dentro de `#plansGrid`. Não tem… · /planos.html e /index.html — FALHA DA PROVA SOCIAL é silenciosa. O `catch(() => {})` de `GET /pontos/fluxo` deixa… · /planos.html — SEM DESCONTO não tem desenho. Em `atualizarDescontos()`, se não existir plano mensal do tier… · /index.html — a home NÃO TEM NENHUM estado de erro, carregando ou vazio. É 100% estática, exceto a linha de fluxo que… · /pontos.html — `#statRow` não tem carregando nem erro. No `.catch` só o `#pontosGrid` recebe mensagem; os três… · /pontos.html — CARREGANDO é um texto cru no HTML (`<p class="empty-state">Carregando pontos...</p>`), não um esqueleto.… · /pontos.html — não há estado para "só pontos em reparo / em instalação": o card "Pontos ativos" mostra 0 sem nenhuma… · /pontos.html — o `<iframe>` do Google Maps não tem fallback. Se o Google não carregar (CSP libera só… · /contato.html — CARREGANDO é só a palavra "Enviando..." em `#msg`. O botão é desabilitado pela trava de config.js sem… · /contato.html — 400, 429 e 502 não têm estados distintos. `contato.page.js` faz `if (!r.ok) throw new Error()` e…

**Notas:**
- DIVERGÊNCIA DOC×CÓDIGO (planos): docs/funcional.md §4 descreve três estados de /planos.html — esqueleto de carregamento, vazio com texto próprio e erro com botão de tentar de novo — e nenhum dos três existe em public/planos.page.js. Só a mensagem de erro existe, sem botão.
- DIVERGÊNCIA DOC×CÓDIGO (LGPD, mais séria): docs/funcional.md declara o canal do titular como "/contato.html, que grava a mensagem e avisa por e-mail". `POST /contato` (src/conta/routes.js:76-86) só chama `email.enviarMensagemContato` — não grava nada em banco. Com SMTP fora do ar a rota devolve 502…
- O formulário de /contato.html coleta nome, e-mail e telefone sem nenhum aviso de tratamento de dados e sem link para /politica-de-privacidade.html ao lado do botão — o único link à política está no rodapé, junto de mais três documentos.
- BURACO DE NAVEGAÇÃO: quando `carregarConta()` devolve conta, layout.js substitui o `innerHTML` inteiro do nav público. O cliente logado perde do menu "Onde estamos?", "Seja um ponto", "Seja um vendedor" e "Contato" — e o rodapé não tem Contato. Resultado: conta logada não tem nenhum caminho para…
- No ramo logado do layout.js as abas recebem a classe `bloqueado` mas NÃO recebem o `title="Modo ainda não ativado — clique pra ativar"` que `aplicarPapeisNoMenu` coloca no ramo `data-layout="conta"`. Mesmo estado visual, explicação só em uma das duas telas.
- index.html escreve "R$ 50 por mês de ajuda de custo" e "o triplo de espaço na tela" à mão no HTML, enquanto os valores reais vivem em `planos_ponto.ajuda_custo_mensal` / `cota_slots_hora`, editáveis no admin e expostos por `GET /planos-ponto` — rota que nenhuma página institucional consome.…
- Duas promessas comerciais da superfície pública não têm contrapartida explicada em lugar nenhum do site: "você não paga por exibição que não aconteceu" (pontos.html) e "anúncio de concorrente direto do estabelecimento não entra ali" (pontos.html / "Sem concorrente do seu lado" na home). O bloqueio…
- **RESOLVIDO em 15/09/2026 (migration 037):** a frequência do plano passou a ser `frequencia_hora` direto — não existe mais conversão por horário do ponto (`horasAbertoPorDia` foi removida de `src/playlist/gerador.js`). O "≈Nx por dia" que `planos.page.js` mostra (`Math.round(p.frequencia_hora * 12)`) é claramente rotulado como estimativa ("num comércio aberto 12h") e não decide mais quanto realmente roda — o valor por hora é o mesmo em qualquer ponto, aberto 8h ou 12h.
- A vitrine de planos não menciona renovação automática, cancelamento nem o direito de arrependimento de 7 dias (RN-26, `POST /titular/arrependimento`), e o botão "Assinar" muda de destino conforme o login: deslogado vai para o cadastro, logado vai direto para `/anunciante/painel.html?plano=ID`, que…
- O CTA principal da home ("Quero anunciar") vai para `/anunciante/cadastro.html` sem `?plano=`, isto é, pede conta antes de mostrar preço. O caminho com preço primeiro só existe pelo menu "Planos" ou pelo CTA do rodapé da página.
- config.js: os dois ramos do ternário de `API_BASE_URL` devolvem `window.location.origin`. A regex `REDE_LOCAL` não altera comportamento nenhum hoje — é documentação executável, não lógica.
- planos.html e pontos.html carregam `/formulario.js` sem ter um único `[data-cep]`, `[data-categorias]`, `[data-senha]` ou `input[type=password]` — script morto em duas das quatro páginas institucionais (e ele dispara `ligarCategorias`, que retorna cedo, mas o arquivo inteiro é baixado).


---

## Captação do anunciante

CAPTAÇÃO DE ANUNCIANTE — da vitrine pública até a sessão logada no painel. Superfície: 5 páginas públicas (`public/anunciante/cadastro.html`, `public/anunciante/login.html`, `public/esqueci-senha.html`, `public/redefinir-senha.html`, `public/contrato-anunciante.html`) + a página de convite (`public/convite.html`, que POSTa na MESMA rota de cadastro) + 4 scripts compartilhados carregados por elas (`public/config.js`, `public/layout.js`, `public/formulario.js`, `public/nav-auth.js` — este último legado, já substituído por layout.js). Backend: 6 rotas em `src/anunciantes/routes.js` e `src/conta/routes.js` — POST /anunciantes/cadastro, POST /anunciantes/login, POST /anunciantes/logout, GET…

**Portas de entrada da captação (links montados em runtime)** — Todo caminho até /anunciante/cadastro.html é gerado por JS, não escrito no HTML: layout.js injeta o cabeçalho com MENU_PUBLICO (entrada ['/anunciante/cadastro.html', 'Anuncie']) e o botão ghost 'Entrar' apontando para /anunciante/login.html com…
  · `public/layout.js`, `public/planos.page.js`, `public/index.html` · papéis: público, anunciante, vendedor
  · ← / / /planos.html / link de cupom do vendedor  → /anunciante/cadastro.html / /anunciante/login.html
  · **cliente sabe:** SABE: onde clicar para anunciar; que o plano escolhido 'vai junto' (o botão diz 'Assinar X'). NÃO SABE: que o plano viaja só como ?plano= na URL e não é reservado nem travado em lugar nenhum até ele…

**Formulário de cadastro — campos e seções** — cadastro.html monta 4 seções em <form id="formCadastro">: 'Seu negócio' (nome_empresa, cpf_cnpj, categoria_id via <select data-categorias>, categoria_livre em div[data-categoria-livre] oculta), 'Endereço' (cep com data-cep, endereco, numero, cidade, uf…
  · `public/anunciante/cadastro.html` · papéis: público
  · ← /planos.html / / / menu 'Anuncie'  → POST /anunciantes/cadastro
  · **cliente sabe:** SABE: que o ramo evita dividir tela com concorrente direto (form-hint 'O ramo garante que você não divida a tela com um concorrente direto.'); que o responsável é opcional; que aceitar os termos…

**Autopreenchimento de endereço por CEP (ViaCEP)** — ligarCep(escopo) em formulario.js: no `input` mascara o CEP para 00000-000 (8 dígitos); no `blur` chama https://viacep.com.br/ws/{cep}/json/ e preenche, por `name` dentro do mesmo <form>, `endereco` = logradouro + ', ' + bairro, `cidade` = localidade, `uf` =…
  · `public/formulario.js`, `public/anunciante/cadastro.html`, `src/server.js` · papéis: público
  · **cliente sabe:** SABE: 'Digite o CEP e o resto vem preenchido — só o número é com você.' NÃO SABE: que o CEP é consultado num serviço de terceiro (ViaCEP) e que, portanto, o CEP dele sai do navegador antes de…

**Busca de ramo de atividade (categorias concorrenciais)** — ligarCategorias(escopo) em formulario.js busca GET /categorias (src/categorias/routes.js: `SELECT id, nome, grupo, aliases FROM categorias WHERE ativo AND NOT legado ORDER BY grupo, nome`, rota pública sem sessão) e monta, sobre um `<select data-categorias>` escondido (`hidden`, ainda a fonte de `.value`/`FormData`), um campo de busca por nome/alias (normalizado, sem acento/maiúscula — `montarBusca`, 22/09/2026). "Não encontrei minha categoria" abre `[data-categoria-livre]` (texto livre, nunca bloqueia concorrência — RN-57). Se a categoria escolhida tiver data-nome…
  · `public/formulario.js`, `src/categorias/routes.js` · rotas: `GET /categorias` · papéis: público
  · **cliente sabe:** SABE: quando a lista cai, lê '(a gente confirma seu ramo no contato)'. NÃO SABE: que `categoria_id` chega ao backend por `req.body.categoria_id` (src/anunciantes/routes.js:105) sem nenhuma checagem…

**Senha na tela: olho, regra e confirmação** — Três ligações de formulario.js, todas no DOMContentLoaded: ligarMostrarSenha() envolve todo input[type=password] num .senha-wrap e adiciona o botão .senha-olho que alterna type text/password; ligarForcaSenha() age só onde há [data-senha] (criação de conta,…
  · `public/formulario.js`, `public/anunciante/cadastro.html`, `public/redefinir-senha.html` · papéis: público
  · **cliente sabe:** SABE: a regra exata da senha, antes de enviar, com validação nativa do navegador. NÃO SABE: que a mesma regra existe de novo no servidor em `conferirSenha` (src/lib/senha.js, constante REGRA) e que…

**Trava de duplo envio (global, todas as telas)** — IIFE travarDuploEnvio() em config.js: intercepta window.fetch contando requisições em voo, e num listener de `submit` em fase de captura desabilita o primeiro button[type=submit] do form, liberando quando emVoo chega a zero ou após 15s. Existe porque dois…
  · `public/config.js` · papéis: público, anunciante
  · **cliente sabe:** SABE: o botão fica cinza enquanto envia. NÃO SABE: que essa é a ÚNICA proteção contra conta duplicada no lado do cliente — no servidor a garantia real é o índice UNIQUE de `contato_email` (migration…

**Captura do cupom de vendedor (?ref) e do plano escolhido (?plano)** — cadastro.page.js:13-14 lê `ref` da query e o envia como `indicado_por_cupom`; :31-32 lê `plano` e redireciona depois do sucesso para `/anunciante/painel.html?plano=...`. No servidor, repository.criar (src/anunciantes/repository.js:41) grava…
  · `public/anunciante/cadastro.page.js`, `src/anunciantes/repository.js`, `src/financeiro/san-checkout.js` · rotas: `POST /anunciantes/cadastro` · papéis: público, vendedor
  · ← link /anunciante/cadastro.html?ref=CUPOM  → /anunciante/painel.html?plano=
  · **cliente sabe:** SABE: nada — a tela de cadastro NÃO mostra em lugar nenhum que ele veio por indicação de um vendedor. Não há campo, badge nem texto. NÃO SABE: que um cupom digitado errado no link é aceito e gravado…

**Envio do cadastro (front)** — Listener de `submit` em cadastro.page.js: preventDefault, escreve 'Enviando...' em #msg, monta o corpo com Object.fromEntries(new FormData(form)), força `aceitou_termos` a booleano pelo .checked, concatena endereço+número, anexa ?ref, e faz…
  · `public/anunciante/cadastro.page.js` · rotas: `POST /anunciantes/cadastro` · papéis: público
  · ← formulário de cadastro  → /anunciante/painel.html / /anunciante/painel.html?plano=
  · **cliente sabe:** SABE: 'Depois do cadastro a gente confere seus documentos e libera a conta. Você recebe o aviso no WhatsApp.' (form-hint da cadastro.html:135) e, se o e-mail repetir, que deve entrar. NÃO SABE, e é o…

**POST /anunciantes/cadastro — a rota** — src/anunciantes/routes.js:56. Ordem exata: (1) limiteTentativas como middleware; (2) se vier `convite`, convitesRepo.buscarValido → 400 'convite inválido, usado ou expirado — fale com quem te enviou'; papeis = convite.papeis, senão ['anunciante']; (3)…
  · `src/anunciantes/routes.js`, `src/anunciantes/repository.js`, `src/convites/repository.js` · rotas: `POST /anunciantes/cadastro` · papéis: público, anunciante, ponto, vendedor
  · ← /anunciante/cadastro.html / /convite.html?t=TOKEN  → sessão logada / /anunciante/painel.html
  · **cliente sabe:** SABE: que a conta foi criada, porque já cai logado no painel. NÃO SABE: que já está com sessão aberta sem nunca ter provado o e-mail — não existe confirmação de e-mail (docs/PENDENCIAS.md, linha 287:…

**Validação de CPF/CNPJ (src/br/documento.js)** — limpar(valor) tira tudo que não é [0-9A-Za-z] e sobe pra maiúscula. digito(base, pesos) faz o módulo 11 usando `charCodeAt(i) - 48`, o que dá '0'→0, '9'→9, 'A'→17, 'Z'→42 — é assim que o CNPJ ALFANUMÉRICO (Receita Federal, IN 2.229/2024, valendo desde…
  · `src/br/documento.js`, `src/anunciantes/routes.js`, `tests/br.test.js` · rotas: `POST /anunciantes/cadastro`, `POST /admin/anunciantes` · papéis: público, anunciante
  · ← campo cpf_cnpj do formulário  → San Checkout → Asaas (documento do pagador)
  · **cliente sabe:** SABE: em tese, a mensagem 'CPF inválido — confira os números.' — mas NÃO chega até ele no cadastro público, porque cadastro.page.js descarta o corpo do 400 (ver observações). Só a tela de convite e o…

**Validação de formato brasileiro (src/br/formato.js)** — Na captação entram duas funções: cepValido(valor) = /^\d{8}$/ sobre os dígitos (só formato — 'a validação de verdade é o serviço dos Correios', diz o comentário), usada em routes.js:87 apenas quando ehAnunciante; e telefoneE164(valor), que tira não-dígitos e…
  · `src/br/formato.js`, `src/anunciantes/routes.js`, `tests/br.test.js` · rotas: `POST /anunciantes/cadastro` · papéis: público, anunciante
  · ← campos cep e contato_telefone
  · **cliente sabe:** SABE: o placeholder '00000-000' e a máscara do CEP enquanto digita. NÃO SABE: que o WhatsApp dele foi reescrito para +5516… antes de ser gravado; que `responsavel_telefone` NÃO passa por telefoneE164…

**Regra e hash de senha (src/lib/senha.js)** — conferirSenha(senha) devolve null ou a MENSAGEM única 'a senha precisa ter no mínimo 8 caracteres, com maiúscula, minúscula, número e símbolo', a partir da constante REGRA — a MESMA regex do front (REGRA_SENHA em formulario.js), e o teste…
  · `src/lib/senha.js`, `src/anunciantes/repository.js`, `tests/senha.test.js` · rotas: `POST /anunciantes/cadastro`, `POST /anunciantes/login`, `POST /redefinir-senha` · papéis: anunciante, ponto, vendedor
  · ← campo senha
  · **cliente sabe:** SABE: a regra, escrita na dica abaixo do campo. NÃO SABE: que cada hash custa ~128 MiB de memória em andamento (CONSTRAINTS.md), o que é o teto real de logins simultâneos nesta instância; que se a…

**Gravação da conta (src/anunciantes/repository.js)** — criar(dados, db = pool) — aceita o client da transação do convite. Gera o hash, faz um único INSERT em `anunciantes` com 19 colunas, carimba aceitou_termos_em = new Date(), papeis = dados.papeis?.length ? dados.papeis : ['anunciante'], status = dados.status…
  · `src/anunciantes/repository.js`, `src/db/migrations/002_anunciantes.sql` · rotas: `POST /anunciantes/cadastro`, `POST /anunciantes/login`, `POST /admin/anunciantes` · papéis: anunciante, ponto, vendedor
  · ← POST /anunciantes/cadastro
  · **cliente sabe:** NÃO SABE: que a tabela se chama `anunciantes` mesmo quando ele entra só como ponto ou vendedor (CONSTRAINTS.md veta o rename); que `aceitou_termos_em` guarda o INSTANTE do aceite mas não guarda QUAL…

**Trava de tentativas (src/lib/limite-tentativas.js)** — limiteTentativas(req,res,next): chave = `${req.ip}:${req.path}`, janela JANELA_MS = 15 min, teto MAX = 10. Primeira tentativa (ou janela vencida) grava {desde, qtd:1}; a partir da 11ª na mesma janela devolve 429 com header Retry-After em segundos e o corpo…
  · `src/lib/limite-tentativas.js`, `src/anunciantes/routes.js`, `src/conta/routes.js` · rotas: `POST /anunciantes/cadastro`, `POST /anunciantes/login`, `POST /anunciantes/esqueci-senha`, `POST /afiliados/esqueci-senha` · papéis: público, anunciante, admin
  · **cliente sabe:** NÃO SABE NADA: nenhuma das três telas desta superfície mostra a mensagem do 429. No cadastro vira 'Não foi possível criar a conta agora'; no login vira 'E-mail ou senha inválidos.' (o que é…

**Sessão e cookie (src/server.js)** — express-session com store PgSession (connect-pg-simple) na tabela `session` do Postgres (migration 019) — MemoryStore deslogava todo mundo a cada deploy (docs/erros/2026-09-sessao-em-memoria.md). Cookie: httpOnly:true, sameSite:'lax', secure só em produção,…
  · `src/server.js`, `src/anunciantes/routes.js`, `src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql` · rotas: `POST /anunciantes/cadastro`, `POST /anunciantes/login`, `POST /anunciantes/logout` · papéis: anunciante, ponto, vendedor, admin
  · ← cadastro / login  → /anunciante/painel.html
  · **cliente sabe:** SABE: que continua logado entre visitas. NÃO SABE: que a sessão vale 7 dias; que não existe lista de dispositivos nem 'encerrar outras sessões'; que trocar a senha em /redefinir-senha NÃO derruba as…

**Login do anunciante (tela)** — login.html: <form id="formLogin"> com email (type=email, autocomplete=username) e senha (type=password, autocomplete=current-password), botão 'Entrar' e o link '/esqueci-senha.html?tipo=anunciante'. Não tem [data-senha], então ligarForcaSenha não age aqui —…
  · `public/anunciante/login.html`, `public/anunciante/login.page.js` · rotas: `POST /anunciantes/login` · papéis: público, anunciante, ponto, vendedor
  · ← menu público 'Entrar' / redirect 301 de /afiliado/login.html (server.js:113) / painel/ponto/vendedor quando a sessão expira  → /anunciante/painel.html / /esqueci-senha.html?tipo=anunciante / /anunciante/cadastro.html (botão do layout mínimo)
  · **cliente sabe:** SABE: que errou e-mail ou senha. NÃO SABE: quando a causa foi outra — conta excluída (403, 'essa conta foi excluída — fale com o suporte pra recuperar') e 429 de muitas tentativas aparecem os dois…

**POST /anunciantes/login — a rota** — src/anunciantes/routes.js:160, com limiteTentativas. repo.buscarPorEmailComSenha(email) → se não achar OU repo.validarSenha falhar, 401 'e-mail ou senha inválidos' (mesma resposta para os dois casos, sem enumerar). Só DEPOIS de a senha bater é que checa…
  · `src/anunciantes/routes.js`, `src/anunciantes/repository.js`, `src/lib/senha.js` · rotas: `POST /anunciantes/login` · papéis: anunciante, ponto, vendedor
  · ← /anunciante/login.html  → /anunciante/painel.html
  · **cliente sabe:** NÃO SABE: que uma conta suspensa entra normalmente e só descobre a suspensão ao tentar assinar (src/financeiro/routes.js:198); que a resposta do login não traz o plano nem a expiração — o painel pede…

**Sessão corrente e troca do menu (GET /anunciantes/me)** — src/anunciantes/routes.js:206, atrás de exigirAnuncianteLogado: repo.buscarPorId + o perfil de vendedor quando o papel existe; 401 se a conta sumiu. É a rota que o front usa para saber se há alguém logado. window.carregarConta() (layout.js:108) faz UMA…
  · `src/anunciantes/routes.js`, `public/layout.js`, `public/nav-auth.js` · rotas: `GET /anunciantes/me` · papéis: anunciante, ponto, vendedor
  · ← qualquer página com data-layout publico ou conta  → /anunciante/painel.html / /anunciante/ponto.html / /anunciante/vendedor.html
  · **cliente sabe:** SABE: vê o próprio nome/avatar no topo quando está logado. NÃO SABE: que as páginas de cadastro e login usam data-layout='minimo' e NÃO chamam carregarConta — então quem já está logado e abre…

**Esqueci minha senha (tela + rota)** — esqueci-senha.html (noindex) com <form id="formEsqueci"> de um campo e o texto 'O link vale por uma hora.'; esqueci-senha.page.js força #voltarLogin para /anunciante/login.html (comentando que o ?tipo=afiliado dos links antigos cai no mesmo fluxo), faz POST…
  · `public/esqueci-senha.html`, `public/esqueci-senha.page.js`, `src/conta/routes.js` · rotas: `POST /anunciantes/esqueci-senha`, `POST /afiliados/esqueci-senha` · papéis: público, anunciante, ponto, vendedor
  · ← /anunciante/login.html  → e-mail com /redefinir-senha.html?token=
  · **cliente sabe:** SABE: a resposta neutra e o prazo de 1 hora. NÃO SABE: que a resposta é neutra por construção, e que ela é enviada ANTES do e-mail existir — se o SMTP falhar, o servidor só grava console.error e o…

**Redefinir senha (tela + rota)** — redefinir-senha.html (noindex, nofollow) lê o token da query em redefinir-senha.page.js:1; sem token, escreve 'Link inválido. Peça um novo em "Esqueci minha senha".' e desabilita o botão. O submit faz POST /redefinir-senha com {token, senha} e — ao contrário…
  · `public/redefinir-senha.html`, `public/redefinir-senha.page.js`, `src/conta/routes.js` · rotas: `POST /redefinir-senha` · papéis: quem tem o token
  · ← link do e-mail de redefinição  → /anunciante/login.html
  · **cliente sabe:** SABE: a regra da senha antes de enviar, e a mensagem exata do servidor quando o link expirou. NÃO SABE: que trocar a senha NÃO encerra as sessões já abertas (nada chama session.destroy nem limpa a…

**Contrato do anunciante e o aceite** — public/contrato-anunciante.html é página pública estática (data-layout='publico'), com 6 cláusulas: Partes (pessoa física, CPF do dono, com cessão automática à SLU ME quando o CNPJ sair), Objeto (exibição conforme o plano), Início da vigência (a contagem só…
  · `public/contrato-anunciante.html`, `public/anunciante/cadastro.html`, `public/layout.js` · papéis: público, anunciante
  · ← checkbox do cadastro / rodapé de todo o site / tela de convite  → /planos.html / /termos-de-uso.html
  · **cliente sabe:** SABE, se clicar: que não é cobrado enquanto não houver ponto no ar; que atraso tira o anúncio do ar na virada do dia; que hoje não há emissão de nota fiscal. NÃO SABE: que aceitou uma versão…

**Cadastro por convite (a outra entrada da mesma rota)** — public/convite.html?t=TOKEN + convite.page.js: carrega GET /convites/{token}, desenha os papéis que o link concede, e adapta o formulário — secaoPix required se vendedor, secaoPlanoPonto se ponto, secaoEndereco (cep/endereco/numero/cidade/uf) required só se…
  · `public/convite.html`, `public/convite.page.js`, `src/anunciantes/routes.js` · rotas: `GET /convites/:token`, `POST /convites/:token/aceitar`, `POST /anunciantes/cadastro`, `POST /anunciantes/logout` · papéis: ponto, vendedor, anunciante
  · ← link enviado pelo dono, por WhatsApp, na mão  → /anunciante/painel.html / /anunciante/ponto.html / /anunciante/vendedor.html
  · **cliente sabe:** SABE: exatamente quais papéis o link libera, e a data de validade do convite. NÃO SABE: que quem entra por convite pula a fila de aprovação (status já nasce 'aprovado', routes.js:107); que o convite…

**Aprovação da conta pelo administrador** — PATCH /admin/anunciantes/:id (src/anunciantes/routes.js:533), atrás de requireAdminSession (server.js:150). repo.buscarPorId antes, repo.atualizar (filtrado por CAMPOS_ATUALIZAVEIS), 404 se não achar, 400 'status inválido' no CHECK constraint 23514. Registra…
  · `src/anunciantes/routes.js`, `src/server.js`, `src/lib/eventos.js` · rotas: `PATCH /admin/anunciantes/:id`, `POST /admin/anunciantes`, `GET /admin/anunciantes` · papéis: admin
  · ← fila de pendentes no /admin (GET /admin/resumo conta pendente_aprovacao)  → conta liberada para assinar plano
  · **cliente sabe:** NÃO SABE DE NADA. Aprovar uma conta não dispara e-mail, nem SMS, nem WhatsApp: não há uma única chamada a `email.` em PATCH /admin/anunciantes/:id. O aviso prometido na cadastro.html:135 ('Você…

**Medição da captação (eventos)** — eventos.registrar('conta:cadastro_conclui', {papel_inicial, veio_de_cupom, veio_de_convite}, anunciante) em src/anunciantes/routes.js:147-151 (cadastro público e por convite) e de novo em :523-529 com pelo_operador:true (cadastro a frio do admin).…
  · `src/lib/eventos.js`, `src/anunciantes/routes.js`, `src/admin/metrica.js` · rotas: `GET /admin/metrica` · papéis: admin
  · ← cadastro / aprovação
  · **cliente sabe:** NÃO SABE: que o cadastro dele é medido e que os campos `veio_de_cupom` e `veio_de_convite` registram por qual porta ele entrou. Não há menção a isso na Política de Privacidade linkada no checkbox…

**Endereços antigos da captação (301)** — src/server.js:111-119, mapa MUDARAM_DE_ENDERECO com app.get(...).redirect(301, ...): /afiliado/cadastro.html → /seja-um-vendedor.html, /afiliado/login.html → /anunciante/login.html, /afiliado/painel.html → /anunciante/vendedor.html, /anunciante/perfil.html →…
  · `src/server.js`, `src/financeiro/routes.js` · rotas: `GET /afiliado/cadastro.html`, `GET /afiliado/login.html`, `GET /afiliado/painel.html`, `GET /anunciante/perfil.html` · papéis: público, vendedor
  · ← link salvo, e-mail antigo, buscador  → /anunciante/login.html / /seja-um-vendedor.html / /anunciante/vendedor.html
  · **cliente sabe:** SABE: nada — o redirecionamento é silencioso, que é o comportamento certo. NÃO SABE: que /anunciante/perfil.html, que docs/funcional.md ainda lista como uma tela própria ('Perfil'), não existe mais:…

**Estados sem tela:** 429 de muitas tentativas no cadastro — o servidor devolve {erro:'muitas tentativas — espere N minuto(s)...'} +… · 429 no login — login.page.js:16 transforma em 'E-mail ou senha inválidos.', que manda o cliente para o caminho errado… · 429 no esqueci-senha — esqueci-senha.page.js nem lê o status: mostra 'o link já está a caminho' mesmo tendo tomado… · 400 por campo no cadastro público (cpf_cnpj, responsavel_cpf, cep, contato_telefone) — o servidor devolve {erro, campo}… · 400 de senha fraca no cadastro — mesma frase genérica; só a validação do navegador (setCustomValidity) segura, e ela… · 403 'essa conta foi excluída — fale com o suporte pra recuperar' — existe na rota (routes.js:174) e nunca chega à tela… · Conta em 'pendente_aprovacao' — não existe tela, faixa ou bloqueio próprio: o painel só escreve o rótulo 'Pendente de… · Aprovação da conta — não há notificação nenhuma (nem e-mail, nem WhatsApp automático). A tela promete WhatsApp, a doc… · Falha no envio do e-mail de redefinição — só console.error em src/conta/routes.js:46; o cliente continua lendo 'o link… · Senha alterada com sucesso — nenhum e-mail de confirmação, e as sessões abertas continuam válidas · Cliente já logado que abre /anunciante/cadastro.html — a página usa data-layout='minimo' e não consulta a sessão; não… · Erro 500 no cadastro (ex.: categoria_id inexistente estourando a FK) — cai no handler global de src/server.js:188 e,…

**Notas:**
- O defeito mais concreto desta superfície: /home/user/MostrAi/public/anunciante/cadastro.page.js:26 faz `if (!r.ok) throw new Error();` — sem ler o corpo. Todo 400 com {erro, campo} produzido por src/anunciantes/routes.js:82-94 (documento, CPF do responsável, CEP, telefone, senha, campos faltando) e…
- Divergência de promessa em três lugares: public/anunciante/cadastro.html:135 diz 'Você recebe o aviso no WhatsApp'; docs/funcional.md seção 6 diz 'Conta criada. Avisaremos por e-mail quando ela for aprovada.'; PATCH /admin/anunciantes/:id (src/anunciantes/routes.js:533-553) não envia nada. Nenhuma…
- A jornada 2.1 de docs/funcional.md diz 'O administrador aprova… Aprovado, volta ao painel e assina o plano'. O código NÃO exige isso: POST /anunciantes/:id/assinar (src/financeiro/routes.js:178) só barra `status === 'suspenso'` (linha 198) e endereço incompleto (linha 200). Uma conta em…
- `contato_email` é comparado com `=` exato (src/anunciantes/repository.js:54) e o UNIQUE do Postgres em text é case-sensitive (migration 002, linha 11). 'Ana@x.com' e 'ana@x.com' criam duas contas, e o login só funciona com a grafia exata. Notar que a própria migration 019 usa…
- `indicado_por_cupom` não é validado no cadastro: repository.js:41 só faz .toUpperCase(). Um cupom errado só deixa de gerar comissão lá no pagamento (src/financeiro/san-checkout.js:150-156), em silêncio, e nem o vendedor nem o cliente ficam sabendo.
- `responsavel_telefone` não passa por telefoneE164, ao contrário de `contato_telefone` (src/anunciantes/routes.js:90). Dois telefones na mesma tabela, um normalizado e outro cru.
- `categoria_id` chega por `req.body.categoria_id` (src/anunciantes/routes.js:105) sem existir na desestruturação nem ser conferido; um id inexistente estoura a FK e vira 500 genérico em vez de 400 com mensagem.
- POST /redefinir-senha (src/conta/routes.js:52-73) apaga só o token usado e não encerra sessões: senha trocada por suspeita de invasão não expulsa quem está logado, e outros links de redefinição gerados na mesma hora continuam valendo. Tokens ficam em texto puro em `tokens_senha` (migration 015,…
- Não existe confirmação de e-mail em nenhum ponto — o cadastro já abre sessão (req.session.regenerate em routes.js:153). Está reconhecido como pendência em docs/PENDENCIAS.md linha 287 ('Faltam: confirmação de e-mail, troca de e-mail com link nos dois endereços'), e a linha 367 registra que e-mail…
- O 409 de e-mail já cadastrado é enumerável por design; a única contenção é o limiteTentativas (10 por 15 min por IP+rota), que é em memória do processo — some no restart e não vale entre instâncias (CONSTRAINTS.md, 'Limitador de tentativas em memória do processo').
- public/redefinir-senha.html:40 tem o atributo `data-senha` duplicado no mesmo input, e :44 usa `data-senha` junto de `data-senha-confirma` — funciona (ligarConfirmacaoSenha pega o primeiro [data-senha] do form), mas o campo de confirmação acaba recebendo também a dica de força de senha.
- public/nav-auth.js continua no repositório e é morto para esta superfície: public/layout.js:119 anota que o substituiu, e nenhuma das páginas da captação o carrega.


---

## Papel ponto (dono do comércio)

> **Atualização 23/09/2026 (painel único, Fatias 2–6):** `public/anunciante/ponto.html` e `ponto.page.js` foram **aposentados** — o endereço responde 301 pro Painel (`#modPontos`). O que eles faziam mora agora em `public/meus-pontos.js` (pedido, ponto, telas, PIN; `GET /anunciantes/me/meus-pontos`), `public/meus-criativos.js` (autoanúncio junto dos criativos comerciais; `GET /anunciantes/me/criativos`) e `public/financeiro-conta.js` (extrato e troca da ajuda de custo; `GET /anunciantes/me/financeiro`). As funções de `ponto.page.js` citadas abaixo são histórico, não código vivo.

Papel PONTO (dono do comércio que cede a parede) no Mostraí. Caminho completo: candidatura pública em /seja-um-ponto.html → triagem no admin (aba Candidaturas) → convite com token → /convite.html cria a conta (ou liga o papel numa conta já logada) → ponto + "Tela 1" criados no mesmo COMMIT → admin cadastra custo, gera chave de aparelho e PIN, muda o ponto para ativo → TV abre /player.html → dono acompanha em /anunciante/ponto.html → extrato de pagamento existe no backend mas NÃO tem tela. 2 páginas públicas (seja-um-ponto.html, comodato.html), 1 página de entrada (convite.html), 1 página de painel (anunciante/ponto.html) + componente compartilhado modos.js, e 4 domínios de backend…

**Candidatura pública de ponto** — Formulário 'Seja um ponto' que grava uma linha em `candidaturas` com tipo='ponto', origem='site'. NÃO cria conta e NÃO cria ponto. Campos enviados por seja-um-ponto.page.js: tipo, nome, nome_comercio, contato_telefone, contato_email, endereco (rua+numero…
  · `public/seja-um-ponto.html`, `public/seja-um-ponto.page.js`, `public/formulario.js` · rotas: `POST /candidaturas` · papéis: público (sem login)
  · ← / (home) / /comodato.html / menu público MENU_PUBLICO em public/layout.js  → Admin → aba Candidaturas (GET /admin/candidaturas)
  · **cliente sabe:** Parcial. A tela de sucesso (#enviado) promete 'a gente chama no WhatsApp em até 2 dias úteis'. Mas o formulário NÃO pede a escolha de comodato (ajuda de custo x cota) apesar de comodato.html dizer…

**Contrato de comodato (página estática)** — Texto integral do comodato: partes (CPF do dono, PJ em constituição), objeto (TV + player cedidos), as duas modalidades de contrapartida, obrigações do estabelecimento (manter ligado, internet por conta dele, comunicar defeito, não mudar de endereço),…
  · `public/comodato.html`, `public/layout.js` · papéis: público
  · ← rodapé de todas as páginas (layout.js linha 98) / label de aceite em convite.page.js quando o convite inclui o papel ponto  → /termos-de-uso.html
  · **cliente sabe:** O texto é bom e completo, mas está desconectado do fluxo: nem seja-um-ponto.html nem o card de ativação de ponto em modos.js nem o formulário 'Novo endereço' em ponto.page.js apontam para ele. O…

**Triagem da candidatura (admin)** — Lista todas as candidaturas com o comércio, endereço, segmento, fluxo estimado e um link wa.me já montado com o telefone. O admin muda o status pelo <select>: nova → em_contato → aprovada/recusada. `repository.atualizar` só aceita os campos da whitelist…
  · `public/admin/index.page.js`, `src/candidaturas/routes.js`, `src/candidaturas/repository.js` · rotas: `GET /admin/candidaturas`, `PATCH /admin/candidaturas/:id` · papéis: admin
  · ← POST /candidaturas / POST /conta/modos/ponto/pedir / POST /conta/bonus/ponto/resgatar  → POST /admin/convites (botão 'Gerar convite') / POST /admin/candidaturas/:id/liberar (botão 'Liberar na conta', só quando a candidatura tem conta_id)
  · **cliente sabe:** Não. Nenhum e-mail, SMS ou webhook sai em nenhuma transição de status. src/financeiro/email.js só tem enviarConfirmacaoPagamento, enviarLinkRedefinicaoSenha, enviarMensagemContato,…

**Geração e entrega do convite** — O admin gera um token de 24 bytes base64url, com papeis[], nome_sugerido, email_sugerido, candidatura_id e validade (VALIDADE_DIAS_PADRAO = 7). O link é montado por linkDoConvite() a partir de SITE_URL ou CORS_ORIGIN. Ao gerar com candidatura_id, a…
  · `src/convites/routes.js`, `src/convites/repository.js`, `public/admin/index.page.js` · rotas: `POST /admin/convites`, `GET /admin/convites`, `POST /admin/convites/:id/revogar`, `GET /convites/:token` · papéis: admin gera, público consome
  · ← aba Candidaturas do admin / aba Convites do admin (botão '+ Novo convite (sem candidatura)')  → /convite.html?t=TOKEN
  · **cliente sabe:** Não automaticamente. O envio é 100% manual por WhatsApp (docs/PENDENCIAS.md, seção D: 'e-mail de boas-vindas/convite (hoje o link vai por WhatsApp na mão)'). O convite expira em 7 dias em silêncio:…

**Criação de conta pelo convite (visitante sem sessão)** — convite.page.js lê ?t=, consulta GET /convites/:token e desenha só o que cada papel precisa. Para ponto: mostra a seção #secaoPlanoPonto com os radios de comodato vindos de GET /planos-ponto, esconde #secaoEndereco (endereço comercial só é exigido de…
  · `public/convite.html`, `public/convite.page.js`, `src/anunciantes/routes.js` · rotas: `GET /convites/:token`, `GET /planos-ponto`, `POST /anunciantes/cadastro` · papéis: público com token
  · ← link do convite mandado por WhatsApp  → /anunciante/ponto.html (destino quando PAPEIS tem ponto e não tem anunciante)
  · **cliente sabe:** Sim, é o melhor momento do fluxo: os cards de plano mostram nome, ajuda_custo_mensal formatada em R$/mês, chamada, benefícios e o bônus 'depois de N meses como ponto, ganhe M meses de anúncio…

**Nascimento do ponto e da Tela 1 (transação do cadastro)** — Dentro de uma transação única em POST /anunciantes/cadastro: consome o convite ANTES de criar a conta, cria a conta com papeis do convite e status 'aprovado', e — se papeis inclui 'ponto' e convite.candidatura_id existe — chama criarPontoDaCandidatura(). Essa função agora copia `categoria_id`/`categoria_livre` da conta pro ponto novo (corrigido em 22/09/2026, reforma de categorias — antes o ponto nascia sem categoria e ficava sem bloqueio de concorrente; RN-57 em docs/funcional.md). Essa…
  · `src/anunciantes/routes.js`, `src/pontos/repository.js`, `src/dispositivos/repository.js` · rotas: `POST /anunciantes/cadastro` · papéis: ponto
  · ← /convite.html  → GET /anunciantes/:id/pontos / GET /anunciantes/:id/dispositivos
  · **cliente sabe:** Não. `aceitou_termos_em` é gravado com a hora do cadastro, mas o que foi aceito não é versionado nem arquivado: nenhuma cópia do comodato vigente, nenhum número de versão, nenhum PDF. Se o texto de…

**Convite aceito por quem já tem conta** — Se carregarConta() devolve sessão, convite.page.js troca o formulário pelo card #jaLogado e chama POST /convites/:token/aceitar. O handler em modos.js roda emTransacao(): consome o token, busca a candidatura ligada e chama liberarPapelNaConta() para cada papel — corrigida em 22/09/2026 (reforma de categorias) pra também copiar `categoria_id`/`categoria_livre` da conta pro ponto novo, mesmo furo e mesmo conserto de criarPontoDaCandidatura…
  · `public/convite.page.js`, `src/conta/modos.js` · rotas: `POST /convites/:token/aceitar` · papéis: conta logada
  · ← link do convite aberto por quem já é anunciante ou vendedor  → /anunciante/ponto.html
  · **cliente sabe:** Não, neste caminho a escolha de comodato desaparece. O card #jaLogado só tem o campo de chave Pix (para vendedor); não existe seletor de planos-ponto. A opção vem exclusivamente de…

**Pedido do modo 'Meu ponto' de dentro do painel** — Conta que já existe pede uma tela sem convite. montarModo('ponto', ...) em modos.js desenha o card CARDS.ponto com nome_comercio, endereço completo, segmento, fluxo estimado, **horário de funcionamento** (obrigatório, 22/09/2026 — 3 grupos seg-sex/sáb/dom via CAMPO_HORARIO_SEMANAL()/ligarHorarioSemanal()/lerHorarioSemanalDoForm(), validado por src/lib/horario-semanal.js), os radios de comodato (#modoEscolhaPlano, carregados por carregarOpcoesComodato) e…
  · `public/modos.js`, `public/anunciante/ponto.html`, `public/anunciante/ponto.page.js` · rotas: `GET /conta/modos`, `POST /conta/modos/ponto/pedir` · papéis: conta logada sem o papel ponto
  · ← /anunciante/ponto.html quando estado.modos.ponto.liberado é falso  → Admin → Candidaturas com etiqueta 'pedido do painel' → POST /admin/candidaturas/:id/liberar
  · **cliente sabe:** Sim, é o melhor estado de espera do sistema: depois de enviado, GET /conta/modos devolve modos.ponto.pedido e o card vira 'Pedido enviado em DD/MM/AAAA — a gente chama no WhatsApp pra combinar a…

**Liberar o papel ponto numa conta existente (admin)** — Botão 'Liberar na conta' do admin. Exige cand.conta_id (400 'essa candidatura não é de uma conta existente — gere um convite'), recusa 409 se já aprovada, recusa conta excluída, e em transação chama liberarPapelNaConta(conta,'ponto',cand,cliente) + UPDATE…
  · `src/conta/modos.js`, `public/admin/index.page.js` · rotas: `POST /admin/candidaturas/:id/liberar` · papéis: admin
  · ← candidatura com origem 'painel' ou 'bonus_plano'  → /anunciante/ponto.html do cliente (modo liberado na próxima carga)
  · **cliente sabe:** Não. A liberação é silenciosa: nenhum e-mail, e o cliente só descobre que o modo abriu se voltar ao painel por conta própria. Diferente da aprovação de criativo (RN-18, enviarCriativoNoAr), que manda…

**Bônus 'tela após N meses' (módulo cruzado do plano do anunciante)** — bonusPontoDaConta() em modos.js lê planos.ponto_apos_meses, conta os meses cobertos por mesesEntre(data_inicio_cobertura, hoje ou data_expiracao) e devolve {apos_meses, meses_cobertos, disponivel, resgatado_em, ja_e_ponto}. window.cardBonus(estado,'ponto')…
  · `src/conta/modos.js`, `public/modos.js`, `public/anunciante/painel.page.js` · rotas: `GET /conta/modos`, `POST /conta/bonus/ponto/resgatar` · papéis: anunciante que ainda não é ponto
  · ← aba Anúncios do painel  → Admin → Candidaturas (etiqueta 'bônus do plano')
  · **cliente sabe:** Sim, com progresso numérico visível. É o único contador de prazo que o sistema mostra para o lado do ponto.

**Painel 'Meu ponto' — telas e sinal** — GET /anunciantes/:id/dispositivos devolve, por tela do dono: apelido, status, ultima_vez_online, instalado_em, ponto_nome, endereco, ponto_status, exibicoes_30d (SUM de vezes_confirmadas na janela de 30 dias) e anunciantes_30d (COUNT DISTINCT). ponto.page.js…
  · `public/anunciante/ponto.html`, `public/anunciante/ponto.page.js`, `src/dispositivos/routes.js` · rotas: `GET /anunciantes/:id/dispositivos` · papéis: ponto
  · ← aba 'Meu ponto' do menu de conta (navMeuPonto em layout.js)  → modal 'Ver o que rodou' (GET /anunciantes/:id/dispositivos/:dispositivoId/painel)
  · **cliente sabe:** Parcial e comprometido. A leitura de sinal é boa, mas toda a montagem é derrubada por um defeito: ponto.page.js:13 faz `await Promise.all([carregarTelas(), carregarPontos(), carregarExtrato()])` e…

**Painel de uma tela (o que rodou)** — Modal <dialog id='modalTela'>: painelDaTela() devolve porAnunciante (nome_empresa, programadas, confirmadas nos últimos 30 dias) e porDia (30 dias, agregado por date_trunc('day')). O front desenha a tabela e um gráfico de barras horizontais dos últimos 14…
  · `public/anunciante/ponto.page.js`, `src/dispositivos/routes.js` · rotas: `GET /anunciantes/:id/dispositivos/:dispositivoId/painel` · papéis: ponto
  · ← botão 'Ver o que rodou' de cada tela-card
  · **cliente sabe:** Sim. Mostra 'programadas' x 'confirmadas' por anunciante, que é exatamente o proof-of-play que o dono do ponto usa para conferir se a tela está cumprindo. O mesmo corpo é servido ao admin (GET…

**Meus endereços e cadastro de um segundo endereço** — GET /anunciantes/:id/pontos lista os pontos da conta com categoria_nome e plano_ponto_nome (do LEFT JOIN em planos_ponto). ponto.page.js mostra badge de status, nome, endereço, cidade/UF e — quando >0 — 'Ajuda de custo: R$ X/mês' e 'Cota do seu anúncio: Nx…
  · `public/anunciante/ponto.html`, `public/anunciante/ponto.page.js`, `src/pontos/routes.js` · rotas: `GET /anunciantes/:id/pontos`, `POST /anunciantes/me/pontos` · papéis: ponto
  · ← aba Meu ponto  → Admin → aba Pontos (o ponto aparece como 'lead')
  · **cliente sabe:** Não. Três furos no mesmo formulário: (1) ele não pergunta a opção de comodato — o corpo enviado tem só nome, endereco, cidade, uf, cep e segmento, então o ponto novo nasce com valor_pago_mensal=0 e…

**Extrato de pagamento ao ponto (backend sem tela)** — extratoDaConta(anuncianteId) faz JOIN pagamentos_ponto → pontos WHERE p.anunciante_id = sessão, ordenado por competencia DESC, e resumir() devolve totalPago, totalAberto, totalPagoTexto/totalAbertoTexto formatados em reais (soma em centavos inteiros, sem…
  · `src/pontos/routes.js`, `src/pontos/pagamentos-repository.js`, `src/br/formato.js` · rotas: `GET /anunciantes/me/pontos/extrato` · papéis: ponto
  · ← NADA — nenhum arquivo de public/ chama esta rota
  · **cliente sabe:** Não, e é o buraco mais grave do papel. A rota está pronta e correta, a migration 022 existe, o admin sabe lançar — e o dono do ponto não tem como ver. public/anunciante/ponto.html não tem nenhum…

**Lançamento e quitação do pagamento ao ponto (admin)** — lancar() normaliza competencia 'AAAA-MM' para o dia 1 e faz INSERT ... ON CONFLICT (ponto_id, competencia) DO UPDATE — o mesmo mês lançado de novo atualiza em vez de duplicar (RN-20). marcarPago() grava ou limpa pago_em. Ao quitar (e só ao quitar) emite…
  · `src/pontos/routes.js`, `src/pontos/pagamentos-repository.js`, `src/lib/eventos.js` · rotas: `GET /admin/pontos/:pontoId/pagamentos`, `POST /admin/pontos/:pontoId/pagamentos`, `PATCH /admin/pagamentos-ponto/:id` · papéis: admin
  · ← admin, manualmente, mês a mês  → GET /anunciantes/me/pontos/extrato (que ninguém consome)
  · **cliente sabe:** Não. Não existe recorrência nem lembrete: nenhum cron, nenhum job, nada em scripts/ gera o lançamento do mês. Se o dono esquecer de lançar, o ponto não recebe e não tem onde reclamar — não há tela,…

**Chave de aparelho e instalação da tela** — gerarChave() grava 16 bytes base64url em dispositivos.aparelho_id e o admin monta o link completo `/player.html?tela=<id>&chave=<chave>` (linkDoPlayer em index.page.js). A TV abre uma vez e guarda a chave. Trocar a chave derruba o aparelho antigo na hora. O…
  · `src/dispositivos/routes.js`, `src/dispositivos/repository.js`, `public/admin/index.page.js` · rotas: `POST /admin/dispositivos/:id/chave`, `PATCH /admin/dispositivos/:id`, `POST /admin/pontos/:pontoId/dispositivos`, `GET /admin/dispositivos` · papéis: admin instala, tela autentica por chave
  · ← ponto criado com a Tela 1  → GET /playlist/:dispositivoId / POST /player/:dispositivoId/heartbeat
  · **cliente sabe:** Não. O dono do ponto nunca vê a chave (correto, é credencial) mas também nunca vê nada sobre a instalação: não há data prevista, não há 'técnico a caminho', não há confirmação de instalação. O único…

**PIN e painel aberto na própria TV** — definirPin() aceita 4 a 6 dígitos (regex /^\d{4,6}$/) e guarda com o mesmo scrypt da senha de conta; pin_hash nunca sai do repositório (CAMPOS_PUBLICOS expõe apenas `(pin_hash IS NOT NULL) AS tem_pin`). POST /player/:dispositivoId/painel exige o header…
  · `src/dispositivos/routes.js`, `src/dispositivos/repository.js`, `public/player.page.js` · rotas: `POST /admin/dispositivos/:id/pin`, `POST /player/:dispositivoId/painel` · papéis: admin define, quem está na frente da TV usa
  · ← admin define; dono do ponto usa na TV  → painelDaTela() na própria TV
  · **cliente sabe:** Não, e aqui a documentação promete o que o código não faz. docs/funcional.md §2.2 passo 7 diz 'O dono do ponto define o PIN da tela' e §3 lista 'definir PIN' como ação da tela 'Meu ponto'. Não existe…

**Cota de autoanúncio na playlist** — criativosDoDono(contaId) pega até 3 criativos com status 'aprovado' e arquivo_normalizado_url da conta dona do ponto; dividirCota(cota_autoanuncio_slots_hora, telas_do_ponto) reparte os slots/hora entre as telas ativas daquele ponto (RN-07). Os itens saem da…
  · `src/playlist/gerador.js`, `src/lib/pacing.js`, `src/dispositivos/repository.js` · rotas: `GET /playlist/:dispositivoId` · papéis: ponto (beneficiário)
  · ← a TV, a cada hora  → POST /player/:dispositivoId/played
  · **cliente sabe:** Não. O ponto que escolheu a modalidade 'cota ampliada de autoanúncio' — a contrapartida inteira do comodato dele — não tem NENHUMA tela para subir o vídeo. /anunciante/ponto.html não tem upload de…

**Bônus de anúncio grátis por tempo como ponto (módulo cruzado inverso)** — bonusAnuncioDaConta() faz JOIN pontos → planos_ponto → dispositivos ativos, pega MIN(COALESCE(d.instalado_em, p.created_at::date)) do ponto ativo cuja opção tem plano_bonus_id, calcula meses_ativo e devolve {opcao, plano_nome, apos_meses, meses_ativo,…
  · `src/conta/modos.js`, `public/modos.js`, `public/anunciante/ponto.page.js` · rotas: `GET /conta/modos`, `POST /conta/bonus/anuncio/resgatar`, `PATCH /admin/planos-ponto/:id` · papéis: ponto
  · ← aba Meu ponto (#bonusPonto)  → /anunciante/painel.html
  · **cliente sabe:** O card é claro quando renderiza — mas ele é escrito em #bonusPonto dentro do mesmo callback que estoura no carregarExtrato() indefinido. O innerHTML do bônus acontece ANTES do Promise.all, então o…

**Catálogo de opções de comodato** — planos_ponto guarda id, nome, chamada, ajuda_custo_mensal, cota_slots_hora, beneficios[], ordem, ativo e os três campos do bônus cruzado. GET /planos-ponto (público) devolve só os ativos, ordenados por ordem, id. O admin cria (POST, 409 em id duplicado) e…
  · `src/pontos/routes.js`, `src/pontos/planos-ponto-repository.js`, `public/admin/index.page.js` · rotas: `GET /planos-ponto`, `GET /admin/planos-ponto`, `POST /admin/planos-ponto`, `PATCH /admin/planos-ponto/:id` · papéis: público lê, admin edita
  · ← aba 'Opções de comodato' do admin  → radios de escolha em convite.page.js e modos.js
  · **cliente sabe:** Só dentro dos dois formulários que desenham os radios. Não existe página pública que liste as opções com preço — /comodato.html descreve as duas modalidades em prosa e remete 'aos valores exibidos no…

**Vitrine pública 'Onde estamos'** — listarPublicos() devolve id, nome, cidade, endereco, status e categoria_nome dos pontos com status IN ('ativo','aguardando_instalacao','reparo') — nunca responsavel_contato. somaFluxoMensal() soma fluxo_estimado_mensal só dos ativos e devolve null só em zero (19/09/2026 — o piso de 1.000 pra exibir saiu, pedido do dono)…
  · `public/pontos.html`, `public/pontos.page.js`, `src/pontos/repository.js` · rotas: `GET /pontos`, `GET /pontos/fluxo` · papéis: público
  · ← menu público
  · **cliente sabe:** Não avisado. O nome e o endereço do comércio viram página pública indexável assim que o status sai de 'lead' — inclusive em 'aguardando_instalacao', ou seja, antes de qualquer tela existir no local.…

**Dados do ponto na exportação do titular** — GET /titular/meus-dados inclui pontos, dispositivos (custo_equipamento, meses_amortizacao, instalado_em, created_at — sem aparelho_id e sem pin_hash), candidaturas e pagamentos recebidos como ponto, num JSON com Content-Disposition: attachment (RN-24).
  · `src/titular/routes.js`, `src/titular/repository.js` · rotas: `GET /titular/meus-dados`, `POST /titular/consentimento`, `GET/POST /titular/arrependimento` · papéis: ponto (como titular)
  · ← bloco 'Seus dados e seus direitos' no popup de perfil (public/perfil.js)
  · **cliente sabe:** Sim, mas o acesso é pelo popup de perfil do painel, que ponto.html carrega via perfil.js — então chega ao dono do ponto. É, curiosamente, o único lugar onde ele consegue ver o histórico de pagamentos…

**Cadastro manual de ponto pelo admin (exceção)** — POST /admin/pontos cria o ponto direto (o front do admin força status 'aguardando_instalacao') e já cria a 'Tela 1', para nunca existir ponto sem dispositivo. PATCH /admin/pontos/:id edita pela whitelist de 21 colunas, incluindo plano_ponto_id,…
  · `src/pontos/routes.js`, `src/pontos/repository.js`, `public/admin/index.page.js` · rotas: `POST /admin/pontos`, `GET /admin/pontos`, `PATCH /admin/pontos/:id`, `POST /admin/pontos/:id/foto` · papéis: admin
  · ← '+ Novo ponto (cadastro manual)' — explicitamente marcado como exceção  → aba Telas do admin
  · **cliente sabe:** Não se aplica ao cliente. Nota: o cadastro manual não tem anunciante_id, então o ponto criado assim fica sem dono logado — não aparece em nenhum painel e o extrato dele nunca chega a ninguém, porque…

**Estados sem tela:** EXTRATO DE PAGAMENTO — o buraco central. public/anunciante/ponto.page.js:13 chama `carregarExtrato()`, função que não… · QUANDO EU RECEBO — não existe data prevista de pagamento em lugar nenhum. pagamentos_ponto.competencia é preenchida à… · QUANDO A TELA VAI SER INSTALADA — o ponto nasce em 'aguardando_instalacao' (por convite) ou 'lead' (por 'Cadastrar… · A CANDIDATURA FOI RECUSADA — PATCH /admin/candidaturas/:id aceita status 'recusada' e nada sai. Não há e-mail… · O CONVITE EXPIROU — validade padrão de 7 dias (VALIDADE_DIAS_PADRAO em src/convites/repository.js). Passado o prazo,… · A ESCOLHA DE COMODATO SUMIU NO MEIO DO CAMINHO — public/seja-um-ponto.page.js não envia plano_ponto_id (o campo nem… · COMO SUBIR O MEU PRÓPRIO ANÚNCIO — quem escolheu a modalidade 'cota ampliada de autoanúncio' não tem upload em lugar… · O PIN NÃO É DELE — docs/funcional.md §2.2 passo 7 e §3 dizem que o dono do ponto define o PIN em 'Meu ponto'. A única… · O QUE EU ACEITEI — `aceitou_termos_em` é gravado (com new Date()) em criarPontoDaCandidatura, em liberarPapelNaConta e… · MEU COMÉRCIO VIROU PÁGINA PÚBLICA — listarPublicos() expõe nome, endereço, cidade e status assim que o ponto sai de… · O CONTADOR DO BÔNUS PODE ESTAR ERRADO — bonusAnuncioDaConta() conta os meses a partir de MIN(COALESCE(d.instalado_em,… · O CONTRATO ACABA EM 1 ANO — comodato.html §6.1 diz que o prazo é de 1 ano sem renovação automática. Não existe campo de…

**Notas:**
- DEFEITO CONFIRMADO, ALTA SEVERIDADE — public/anunciante/ponto.page.js:13: `await Promise.all([carregarTelas(), carregarPontos(), carregarExtrato()])`. `carregarExtrato` não é definido em ponto.page.js, nem em modos.js, perfil.js, layout.js, formulario.js ou config.js. A ordem de avaliação faz…
- LACUNA DE CONTRATO DE API — GET /anunciantes/me/pontos/extrato (src/pontos/routes.js:77) não está em docs/api.md, nem na tabela de 'Conta logada' nem em nenhuma outra. A Estação 4 fechou com a promessa de que o contrato é conferível rota a rota contra o código; essa rota escapou.
- DIVERGÊNCIA DOC × CÓDIGO — docs/funcional.md §2.2 passo 7 e a linha 'Meu ponto' da tabela §3 dizem que o dono do ponto 'define o PIN'. Não existe rota fora de /admin/* nem UI. Ou se constrói a rota do dono, ou se corrige o funcional (que, pela regra do próprio documento, 'mudou o comportamento,…
- DIVERGÊNCIA DOC × CÓDIGO — public/comodato.html §3 diz 'No momento do cadastro, o estabelecimento escolhe uma entre as modalidades' e o fecho diz 'Ao marcar "Aceito os termos do comodato" no formulário de cadastro de ponto'. Esse checkbox não existe em public/seja-um-ponto.html (só há o aceite de…
- INCONSISTÊNCIA DE VALIDAÇÃO ENTRE OS TRÊS CAMINHOS DE PEDIDO DE PONTO — POST /conta/modos/ponto/pedir e POST /conta/bonus/ponto/resgatar validam plano_ponto_id com planosPontoRepo.buscarPorId e devolvem 400 'opção de comodato inválida'. POST /anunciantes/me/pontos aceita req.body.plano_ponto_id e…
- INCONSISTÊNCIA DE STATUS INICIAL — ponto criado por convite/liberação nasce 'aguardando_instalacao' (src/anunciantes/routes.js criarPontoDaCandidatura, src/conta/modos.js liberarPapelNaConta); ponto criado pelo próprio dono em POST /anunciantes/me/pontos nasce 'lead'. Os dois aparecem na mesma…
- AS OPÇÕES DE COMODATO NÃO SÃO VERSIONADAS — PATCH /admin/planos-ponto/:id altera ajuda_custo_mensal e cota_slots_hora na linha viva, enquanto os planos de anunciante ganharam versionamento imutável na RN-27 (POST /admin/planos/:id/nova-versao). comodato.html §3 promete o mesmo para o ponto…
- PONTO ÓRFÃO PELO CADASTRO MANUAL — o formulário '+ Novo ponto (cadastro manual)' do admin não coleta anunciante_id. O ponto resultante não aparece em GET /anunciantes/:id/pontos de ninguém, não aparece em GET /anunciantes/:id/dispositivos e o extrato dele nunca é lido por extratoDaConta (que filtra…
- COBERTURA DE TESTE — tests/e2e/01-fluxo-api.sh cobre candidatura → convite → conta → ponto → Tela 1 → chave → playlist → played, e tests/e2e/04-modos-e-bonus.sh cobre os modos e bônus. Nenhum teste toca GET /anunciantes/me/pontos/extrato, POST /admin/pontos/:pontoId/pagamentos ou PATCH…
- ORDEM DOS ARQUIVOS EM src/pontos/routes.js — `module.exports = router` está na linha 197, antes das três rotas de pagamento, e `const dispositivosRepo = require(...)` aparece depois do handler de POST /anunciantes/me/pontos que o usa. Nenhum dos dois quebra em runtime (o router é o mesmo objeto; a…
- O QUE ESTÁ CERTO E VALE PRESERVAR — o isolamento por conta é consistente nas quatro rotas do dono (Number(req.params.id) !== req.session.anuncianteId → 403 em /pontos e /dispositivos; JOIN pontos ON p.anunciante_id = sessão em /dispositivos/:id/painel e em extratoDaConta); pin_hash e aparelho_id…


---

## Painel do anunciante

PAINEL DO ANUNCIANTE (aba única "Painel", renomeada de "Anúncios" em 19/09/2026) — /anunciante/painel.html, servido por /home/user/MostrAi/public/anunciante/painel.html + /home/user/MostrAi/public/anunciante/painel.page.js, com quatro scripts compartilhados carregados nesta ordem: /config.js (API_BASE_URL, esc, fmtBRL, linkWhatsApp, aplicarBarras, trava de duplo envio), /layout.js (cabeçalho+rodapé, navConta, aplicarPapeisNoMenu, window.ROTULOS, window.carregarConta), /perfil.js (dialog #dlgPerfil: dados da conta, foto, LGPD/CDC, sair, excluir conta), /formulario.js e /modos.js (montarModo/cardBonus/ligarResgateAnuncio). O HTML tem body data-layout="conta" e NENHUM link de navegação — a aba Painel é montada em runtime por navConta(). No fim da página, `montarCardPonto()` (painel.page.js) desenha a candidatura a ponto (ver entrada própria abaixo).

**Abertura do painel e porta de sessão** — carregar() faz GET /anunciantes/me com credentials:'include'. 401 → window.location.href='/anunciante/login.html'. Qualquer outro !r.ok → throw, e o catch final escreve 'Não foi possível carregar sua conta agora.' em #statusBanner (o guard existe justamente…
  · `public/anunciante/painel.page.js`, `src/anunciantes/routes.js`, `src/anunciantes/repository.js` · rotas: `GET /anunciantes/me` · papéis: anunciante, ponto, vendedor
  · ← /anunciante/login.html / /anunciante/cadastro.html (sessão já criada no cadastro) / /convite.html  → /anunciante/login.html
  · **cliente sabe:** Você entra uma vez; o painel é o mesmo para anunciar, para ser ponto e para vender. Sessão vencida devolve para o login, nunca para uma tela em branco.

**Menu e avatar (19/09/2026: uma aba só)** — navConta() em layout.js injeta a aba Painel (#navDashboard), Planos e o botão de avatar #btnPerfil. aplicarPapeisNoMenu({papeis}) marca com a classe .bloqueado a aba Painel se a conta não tiver o papel anunciante (caso hoje inexistente na prática — toda conta nasce com ele). "Meu ponto" e "Vendas" não têm mais aba: `ponto.html`/`vendedor.html` continuam existindo, só sem link no topo.
  · `public/layout.js`, `public/modos.js` · rotas: `GET /anunciantes/me`, `GET /conta/modos` · papéis: anunciante
  · → /planos.html
  · **cliente sabe:** Não tem mais aba pra clicar e descobrir "ainda não ativei isso" — quem quer ser ponto vê o card lá no fim do próprio Painel; quem já é vendedor ou ponto sabe pelo link que a gente manda (ou pela home) onde entrar.

**Candidatura a ponto no fim do Painel (19/09/2026, substitui a aba "Meu ponto" pra quem ainda não é ponto)** — `montarCardPonto(estado)` em `painel.page.js`, chamada de `carregar()` com o mesmo `estado` de `GET /conta/modos` que `montarModo` já buscou. Três estados, mesma lógica de `CARDS.ponto` em `modos.js` só que sem o formulário completo: (1) `papeis.includes('ponto')` → só um link, "Ver o painel do meu ponto →", pra `/anunciante/ponto.html` (o dashboard de verdade, com telas/indicações, não muda em nada); (2) candidatura em aberto (`estado.modos.ponto.pedido`) → aviso "Pedido enviado em [data]"; (3) nenhum dos dois → o card novo: "Média de pessoas que passam por mês" (obrigatório, 21/09/2026 — antes opcional), **horário de funcionamento** (obrigatório, 22/09/2026 — mesmo widget de 3 grupos duplicado aqui: `GRUPOS_HORARIO`/`CAMPO_HORARIO_SEMANAL()`/`ligarHorarioSemanal()`/`lerHorarioSemanalDoForm()` em `painel.page.js`) e uma mensagem livre opcional, e um `POST /conta/modos/ponto/pedir` que PREENCHE `nome_comercio`/`endereco`/`cidade`/`uf`/`cep` a partir de `ANUNCIANTE` (a conta já logada) em vez de pedir de novo — o backend exige `nome_comercio`, `endereco`, `fluxo_estimado_mensal` e `horario_semanal` (`src/conta/modos.js`), e os dois primeiros sempre existem pra quem tem o papel anunciante (obrigatórios no cadastro). `segmento` também não é pedido: o backend resolve sozinho a partir de `categoria_livre` ou, se a conta usou o catálogo fixo, busca o nome por `categoria_id` (`categoriasRepo.buscarAtivaPorId`) — o front não precisa saber qual dos dois a conta tem. Sucesso recarrega a página, que aí já mostra o estado (2).
  · `public/anunciante/painel.html` (`#cardPonto`), `public/anunciante/painel.page.js`, `src/conta/modos.js` · rotas: `GET /conta/modos`, `POST /conta/modos/ponto/pedir` · papéis: anunciante
  · → /anunciante/ponto.html (só quem já é ponto)
  · **cliente sabe:** Sim — o card muda de cara conforme o estado (candidatar-se / aguardando / já é ponto), nunca mostra formulário pra quem já pediu ou já é.

**Gate do modo Anúncios (card de ativação)** — montarModo('anunciante', #dashboardAnuncios, cb) consulta GET /conta/modos. Se modos.anunciante.liberado → executa o callback (banner, bônus, exibições, criativos, KPI de pontos). Se não → esconde #dashboardAnuncios (container.hidden=true), insere…
  · `public/modos.js`, `src/conta/modos.js` · rotas: `GET /conta/modos`, `POST /conta/modos/anunciante` · papéis: ponto, vendedor
  · ← conta criada por convite só com papel ponto ou vendedor  → o próprio painel recarregado, já com dashboard
  · **cliente sabe:** Dono de ponto ou vendedor que resolve anunciar não cria outra conta: preenche o endereço da empresa (que vai na nota) e o modo Anúncios abre na mesma conta.

**Faixa de status da conta** — **Mudou em 16/09/2026 (migration 038):** preencherStatusBanner() escreve em #statusBanner: nome da empresa + (só se `status='parceiro'`) o rótulo "Parceiro" (ROTULOS.anunciante: comum/parceiro — não bloqueia nada, é só rótulo) + 'Plano ativo até…' — e, se `suspenso` for true, a explicação de conta suspensa aparece à parte, no lugar do antigo rótulo 'Suspenso' do status.
  · `public/anunciante/painel.page.js`, `public/layout.js` · rotas: `GET /anunciantes/me` · papéis: anunciante
  · → /planos.html
  · **cliente sabe:** Uma linha só diz em que pé você está: aprovado ou não, com plano ou sem, até quando, e se o seu preço está travado.

**Confirmação de plano e ida ao checkout** — Página própria desde 19/09/2026 (`confirmar-plano.html`, sem o cabeçalho do site). Com ?plano=X na URL e a conta sem plano_id, montarConfirmacaoPedido(planoId) busca GET /planos, acha o plano e mostra um resumo com subtotal/desconto/equivalente mensal/total agrupados, e o botão 'Ir para o pagamento'.…
  · `public/anunciante/confirmar-plano.page.js`, `src/financeiro/routes.js`, `src/financeiro/san-checkout.js` · rotas: `GET /planos`, `POST /anunciantes/:id/assinar` · papéis: anunciante
  · ← /planos.html?plano=X  → San Checkout (host externo)
  · **cliente sabe:** Antes de gerar qualquer cobrança a tela mostra exatamente quanto e de quanto em quanto tempo. Um F5 depois disso não gera segunda cobrança.

**KPIs do topo** (redesenho 19/09/2026, pedido do dono — "dados redundantes que enchem o dashboard e dão uma cara melhor"; ajustado no mesmo dia, segunda rodada) — #kpiGrid, 4 cards fixos + 1 opcional, preenchido por `data-kpi`: [horas] Horas de tela no mês = dados.horasEntreguesMes/horasContratadasMes (card em destaque, 2 colunas — é a métrica que a conta vende, então vem primeiro), [exibicoes] Exibições = "concluídas / total" (dados.confirmadasMes / dados.exibicoesContratadasMes, formatado com `toLocaleString('pt-BR')` — 19/09/2026, terceira rodada: "devia ser exibições concluídas/total de exibições", eram duas legendas de prosa, virou uma fração), [custo] Custo por exibição = dados.custoPorExibicao (valor mensal pago ÷ `exibicoesContratadasMes`, NÃO por `confirmadasMes` — pedido do dono: "deve ser um preço fixo desde o início, não pelas exibições realizadas", pra não oscilar mês afora), [media] Média diária = dados.mediaDiariaMes. O card [entrega] (%) e o card [criativos] saíram do grid (ver "Lista de criativos" abaixo, contador foi pro título do painel). O card fixo "Meus pontos" saiu de vez (pedido do dono, "pode arrancar"; ver KPI Meus pontos abaixo). Banco de horas (carregarBancoHoras) é o 5º card, sempre anexado no fim, sempre visível mesmo em zero. "Exibições por dia" continua com sua própria legenda (#legendaDia, delta 7 dias vs. 7 anteriores).
  · `public/anunciante/painel.html`, `public/anunciante/painel.page.js`, `src/anunciantes/routes.js` · rotas: `GET /anunciantes/:id/exibicoes`, `GET /anunciantes/:id/criativos`, `GET /anunciantes/me/banco-horas` · papéis: anunciante
  · **cliente sabe:** Quantas horas de tela e quantas exibições já rodaram este mês (de quanto contratou), quanto falta, quanto custa cada exibição (fixo, não muda com o mês) e quanto tem no banco de horas.

**Gráfico de exibições por dia (empilhado por ponto)** — desenharPorDia(porDia, porDiaPonto, porPonto) mostra #painelDia com as 14 barras mais recentes (o endpoint devolve DESC e só dias COM registro; o front inverte e não preenche buraco). Empilhado por ponto desde 19/09/2026 (pedido do dono: "no card exibições por dia, coloque também um exibições por ponto") — os 5 primeiros pontos do `porPonto` (já ORDER BY confirmadas DESC) ganham cor própria e fixa (`serie-1`.."serie-5", paleta categórica da skill dataviz, validada com `scripts/validate_palette.js` contra a superfície branca do `.panel`); o resto some em `serie-outros` (cinza, não é identidade de ponto nenhuma). `segmentosDoDia()` faz o agrupamento por dia mantendo essa mesma ordem/cor em toda barra, mesmo quando um ponto fora do top 5 foi o que mais exibiu naquele dia específico — a cor tem que significar sempre o mesmo ponto. Cada `.bar-pilha` e cada `.bar-seg` dentro dela usa data-pct (aplicado por window.aplicarBarras do config.js — CSP proíbe estilo inline; o observador agora trata `.fill` como largura e QUALQUER outra coisa como altura, pra cobrir os segmentos novos sem precisar de outra classe). O espaçador de 2px entre segmentos é `border-top` + `box-sizing:border-box`, não `gap`, pra não somar altura além da pilha em barras baixas. Legenda própria (#legendaPontosDia, `desenharLegendaPontosDia()`) só aparece com 2+ séries — um ponto só não precisa, a cor já é óbvia sozinha.
  · `public/anunciante/painel.page.js`, `public/config.js`, `public/style.css`, `src/anunciantes/routes.js` · rotas: `GET /anunciantes/:id/exibicoes` · papéis: anunciante
  · **cliente sabe:** O desenho dos últimos dias em que você apareceu, com a comparação da semana contra a anterior, e de qual ponto veio cada parte de cada dia.

**Exibições por ponto (barras + tabela)** — desenharPorPonto(porPonto) mostra #painelDetalhe: barras horizontais por ponto (nome, trilho com .fill data-pct, valor) e a tabela .mini-table com Ponto / Cidade / Programadas / Confirmadas / Entrega% / Status. A coluna Status (19/09/2026) usa `statusOnline(ultima_vez_online)`: badge 🟢 Online/🔴 Offline com o mesmo limiar `HORAS_OFFLINE_ALERTA=2h` já usado no admin. Os dados vêm do GROUP BY p.id, p.nome, p.cidade sobre…
  · `public/anunciante/painel.page.js`, `src/anunciantes/routes.js` · rotas: `GET /anunciantes/:id/exibicoes` · papéis: anunciante
  · **cliente sabe:** Em quais comércios seu anúncio apareceu, quanto do prometido foi entregue em cada um, e se a tela está online agora.

**Exibições por horário — REMOVIDO (19/09/2026, pedido do dono: "pode retirar totalmente o exibições por horário")** — existiu por um dia só: desenharPorHora(porHora), #painelHorario e a query `porHora` no backend foram todos apagados (não é um `hidden`, o painel nem existe mais no HTML). "Exibições por ponto" voltou a ocupar a largura toda, sem o par `.duas-colunas` que existia só pra esses dois ficarem lado a lado — a classe CSS também saiu (ficou sem uso).
  · `src/anunciantes/routes.js` (query removida de `GET /anunciantes/:id/exibicoes`) · papéis: anunciante

**Comprovante de veiculação (CSV / proof-of-play)** — Select #periodoComprovante (30/90/365 dias) + link #btnComprovante (<a download>, não fetch+blob, para o navegador usar o nome do Content-Disposition e não esbarrar na CSP). A IIFE comprovante() monta o href e re-monta a cada 'change'. Backend GET…
  · `public/anunciante/painel.html`, `public/anunciante/painel.page.js`, `src/anunciantes/routes.js` · rotas: `GET /anunciantes/:id/exibicoes.csv?dias=N` · papéis: anunciante
  · → download do arquivo
  · **cliente sabe:** Um arquivo que abre no Excel com a prova do que rodou, dia a dia e tela a tela — dá para imprimir ou mandar para o contador.

**Meus pagamentos** — desenharCobrancas(cobrancas) mostra #painelCobrancas com Data / Valor. Os dados chegam no MESMO GET /anunciantes/:id/exibicoes (SELECT id, valor, criado_em FROM cobrancas_confirmadas ORDER BY criado_em DESC). A coluna Nota fiscal saiu da tabela e do SELECT em 19/09/2026 (pedido do dono: nenhuma nota é emitida hoje, e quando passar a ser possível o envio será automático por e-mail, não um link nesta lista — ver BURACO — nota fiscal).
  · `public/anunciante/painel.page.js`, `src/anunciantes/routes.js` · rotas: `GET /anunciantes/:id/exibicoes` · papéis: anunciante
  · **cliente sabe:** O histórico do que você pagou.

**Upload de criativo** — Label .upload-label 'Enviar criativo' sobre o input #arquivoCriativo (accept="video/*,image/*", hidden). O change dispara FormData('arquivo') → POST /anunciantes/:id/criativos, com input.disabled durante o envio. Sucesso: 'Criativo enviado! Ele entra em…
  · `public/anunciante/painel.html`, `public/anunciante/painel.page.js`, `src/anunciantes/routes.js` · rotas: `POST /anunciantes/:id/criativos` · papéis: anunciante
  · → fila /admin/criativos
  · **cliente sabe:** Escolheu o arquivo, já enviou. Em até um minuto ele é padronizado para o formato das TVs e entra em análise.

**Lista de criativos e seus estados** — carregarCriativos() faz GET /anunciantes/:id/criativos (ORDER BY created_at DESC) e monta .criativos-lista: vídeo (<video muted loop playsinline poster=thumbnail_url> + botão .criativo-play) quando a URL casa /\.(mp4|webm|mov|m4v)/, senão <img>; sem…
  · `public/anunciante/painel.page.js`, `public/layout.js`, `src/anunciantes/criativos-repository.js` · rotas: `GET /anunciantes/:id/criativos` · papéis: anunciante
  · ← upload do próprio anunciante / POST /admin/anunciantes/:id/criativos (peça feita pelo operador, já aprovada)
  · **cliente sabe:** Cada peça enviada aparece com a miniatura e o estado: em análise, aprovada ou reprovada.

**Reproduzir e excluir criativo (delegação de clique)** — Um único listener em #listaCriativos: .criativo-play dá video.play() e classe .tocando (removida no primeiro 'pause'); clique no próprio vídeo pausa; .criativo-excluir pede confirm('Excluir este criativo? Pra trocar por outro, é só enviar um novo depois.') e…
  · `public/anunciante/painel.page.js`, `src/anunciantes/routes.js` · rotas: `DELETE /anunciantes/:id/criativos/:criativoId` · papéis: anunciante
  · **cliente sabe:** Excluir libera uma vaga do seu plano na hora; para trocar a peça, exclua e envie a nova.

**Portas de arte pelo WhatsApp** — montarPortasDeArte() reescreve o href de #linkArteSimples com window.linkWhatsApp(mensagem), já com o nome da empresa dentro ('Olá! Sou <empresa>, do Mostraí, e quero pedir o anúncio simples que vem no meu plano.'). Simplificado em 19/09/2026 (pedido do dono): antes eram dois links (#linkArteSimples/#linkGravacao, arte incluída no plano vs. vídeo gravado à parte) — a escolha virou conversa no WhatsApp, não tela. O bloco `#ajudaArte` inteiro some assim que existe pelo menos um criativo na conta (`ajudaArte.hidden = criativos.length > 0` dentro de carregarCriativos(), reavaliado a cada upload/exclusão).
  · `public/anunciante/painel.html`, `public/anunciante/painel.page.js`, `public/config.js` · papéis: anunciante
  · → wa.me (externo)
  · **cliente sabe:** Sem arte ainda? Um botão só, "Quero um anúncio", que já chega puxando uma conversa no WhatsApp — e some assim que a primeira peça é enviada.

**KPI Meus pontos — REMOVIDO (19/09/2026, pedido do dono: "pode arrancar o card meus pontos")** — carregarKpiPontos() e o card fixo do #kpiGrid foram apagados por inteiro; o link "Quero uma tela no meu comércio" pra quem ainda não tem o papel 'ponto' não vive mais aqui. Quem já é ponto continua vendo a própria rede pela aba "Meu ponto" (ponto.page.js), sem atalho a partir do painel de anúncios.
  · `src/pontos/routes.js` (`GET /anunciantes/:id/pontos`, agora sem chamador no painel de anúncios) · papéis: anunciante, ponto

**"Onde seu anúncio aparece" — escolha de pontos (17/09/2026, compactado 19/09/2026)** — `carregarPontos()` em `painel.page.js` (não confundir com o `carregarPontos()` de `ponto.page.js`, do dono de ponto — nomes iguais, arquivos e papéis diferentes) busca `GET /anunciantes/me/pontos-disponiveis` e desenha uma linha por ponto em `#listaPontos`. Cada linha é `.ponto-escolha` (div) com um `<label class="ponto-marcar">` dentro (`display:contents` — só o comportamento de marcar/desmarcar, sem caixa própria, pra virar grid item transparente) cobrindo checkbox + nome + cidade + ocupação, e um `<a class="ponto-mapa">` FORA do label como irmão — de propósito: um link dentro de `<label>` também ativa o checkbox quando o clique chega no label (não dá pra impedir só com `stopPropagation` numa camada acima), então tirar o link do label de vez é o que evita marcar/desmarcar sem querer ao clicar em "ver no mapa" (reaproveita a mesma busca do Google Maps que `pontos.page.js` já usa na vitrine pública — sem coordenadas gravadas, sem mapa embutido). Compactado (19/09/2026, pedido do dono: "se existir muitos pontos cadastrados ele se perde") — era um cartão de 2 linhas por ponto, virou 1 linha densa. Busca por nome/cidade (`#buscaPontos`, filtro em `data-busca`) só aparece acima de 6 pontos — poucos pontos não precisam de filtro. O parágrafo explicativo fixo ("Seu plano cobre N pontos. Marque onde...") saiu de vez, mesmo pedido — o contador (`#contadorPontos`, badge `badge-pendente`/`badge-ok` conforme bate o limite) e o próprio ato de marcar já bastam. Continua valendo sem mudança nenhuma: quem não marca a cota inteira do plano (por sobrar ponto ou por não ter clicado) tem o resto sorteado de forma estável por `pontosDoAnunciante` — isso nunca dependeu do parágrafo, só não era mais dito em prosa.
  · `public/anunciante/painel.html`, `public/anunciante/painel.page.js`, `src/anunciantes/routes.js`, `src/lib/pacing.js` · rotas: `GET /anunciantes/me/pontos-disponiveis`, `PUT /anunciantes/me/pontos` · papéis: anunciante
  · **cliente sabe:** Sim — o contador diz quantos já marcou de quantos o plano cobre, e o `msgPontos` confirma depois de cada clique ("Pronto. Salvo." / "Sem marcação, a gente distribui seus pontos"). A frase antiga prometia "vale a partir da próxima hora cheia" — falsa desde que a playlist parou de ter cache (17/09/2026) e mais ainda depois do congelamento por hora (19/09/2026, ver entrada própria abaixo): a mudança já entra na hora que está no ar, no próximo poll do player. Não é dito EXPLICITAMENTE que sobra vira sorteio, só implícito na segunda mensagem — é a mesma lacuna que o texto removido cobria com mais prosa.

**Congelamento da hora da playlist (19/09/2026, pedido do dono: "não precisa separar por horas dentro só se lembre de bater a meta do mês")** — `gerarPlaylistDaHora` (`src/playlist/gerador.js`) monta a hora inteira (`montarHoraDeTv`) só na primeira vez que alguém pede aquela hora pra aquela tela, e grava a `entrada` usada (frequência, déficit, duração — sem criativos, sem url) numa linha de `playlist_hora_congelada` (migration 064, dispositivo+hora). Todo poll seguinte do player (a cada 15 min) reprocessa a MESMA `base` pela MESMA semente — determinístico, sempre a mesma sequência — em vez de remontar do zero com a elegibilidade atual: é isso que impede um ponto novo escolhido, um criativo aprovado ou o banco de horas drenando no meio da hora de reposicionar quem já estava rodando (`embaralhar`/`espalhar` recalculam a posição de TODO MUNDO quando o total de participantes muda, não só de quem chegou). Quem passa a ser elegível DEPOIS da primeira geração entra em `extras` (`sequenciaAdicional`, sem corte proporcional — pede exatamente `frequenciaBase+deficit`) e é sempre ANEXADO no fim da lista, nunca disputa posição com quem já tinha vaga. `exibicoes_contador` (déficit/RN-10) soma base+extras normalmente, então uma hora que só entregou um pedaço porque a novidade chegou tarde vira déficit e a hora seguinte tenta compensar — a meta do mês nunca depende de a mudança ter caído "no começo" da hora.

**Banco de horas como obrigação (25/09/2026, migration 090)** — a `base` congelada leva `banco` (exibições de dívida pedidas pela conta) separado de `deficit`; `montarHoraDeTv` (`src/lib/pacing.js`) põe o banco só no tempo que sobrou depois do corte da RN-30 (`caberEm` duas vezes: hora vendida, depois o resto) e devolve `bancoProgramados`. `gravarProgramados` grava `vezes_banco`; nada drena na geração (`criadaAgora` saiu de `congelamento-repository.js`). `liquidarBancoConfirmado` (`src/bancohoras/apuracao.js`) abate o banco confirmado das horas fechadas, chamado por `scripts/conciliar.js` (diário) e `scripts/apurar-banco-horas.js` (mensal, com `apurarMes`); `saldosAtivos` (`src/bancohoras/repository.js`) desconta o banco programado ainda não liquidado. `marcarAguardandoCredito`/`aplicarValvula` saíram.
  · `src/playlist/gerador.js`, `src/playlist/congelamento-repository.js`, `src/db/migrations/064_playlist_hora_congelada.sql` · sem rota própria (é interno de `GET /playlist/:dispositivoId`) · papéis: nenhum (motor)
  · **cliente sabe:** Só pelo efeito — marcou um ponto novo, o anúncio começa a rodar ali dentro de 15 minutos (o intervalo de poll do player), sem esperar a troca de hora.

**Card de bônus do plano (tela ganha por tempo de assinatura)** — #bonusAnuncios recebe cardBonus(estado,'ponto') de modos.js. Com plano que tem ponto_apos_meses, bonusPontoDaConta() calcula meses_cobertos por mesesEntre(data_inicio_cobertura, hoje) e devolve {apos_meses, meses_cobertos, disponivel, resgatado_em,…
  · `public/modos.js`, `src/conta/modos.js` · rotas: `GET /conta/modos`, `POST /conta/bonus/ponto/resgatar` · papéis: anunciante
  · → /anunciante/ponto.html
  · **cliente sabe:** Quem fica N meses no plano ganha uma tela instalada no próprio comércio; o painel mostra quanto falta e o botão quando chega a hora.

**Popup de perfil: ver e editar dados da conta** — montarPerfil(conta, aoAtualizar) injeta o <dialog id='dlgPerfil'> no body e o abre pelo #btnPerfil do cabeçalho. Campos travados por padrão; 'Editar' destrava CAMPOS_EDITAVEIS = nome_empresa, endereco, cidade, uf, cep, contato_telefone, responsavel_nome,…
  · `public/perfil.js`, `src/anunciantes/routes.js` · rotas: `GET /anunciantes/me`, `PATCH /anunciantes/me` · papéis: anunciante, ponto, vendedor
  · **cliente sabe:** Endereço, telefone e responsável você mesmo corrige. Documento e e-mail de acesso só mudam falando com a gente.

**Foto da conta (avatar)** — #btnTrocarFoto abre o #inputFoto (accept=image/*); o change faz POST /anunciantes/me/foto (multipart 'arquivo'). No servidor, o arquivo é lido do tmp e subido para `avatares/anunciante-<id>.jpg` com contentType FIXO 'image/jpeg' e upsert:true — fixo de…
  · `public/perfil.js`, `src/anunciantes/routes.js`, `src/lib/supabase.js` · rotas: `POST /anunciantes/me/foto` · papéis: anunciante, ponto, vendedor
  · **cliente sabe:** A foto vira o seu avatar no canto da tela; sem foto, aparece a inicial do nome.

**Direitos do titular — baixar meus dados (LGPD art. 18 II e V, RN-24)** — Dentro do <details class='bloco-titular'>, o #btnBaixarDados é um <a download> apontando para GET /titular/meus-dados (href, não fetch+blob, para o nome do Content-Disposition valer e a CSP não atrapalhar). O servidor chama repo.exportarConta(), que devolve…
  · `public/perfil.js`, `src/titular/routes.js`, `src/titular/repository.js` · rotas: `GET /titular/meus-dados` · papéis: anunciante, ponto, vendedor
  · → download do JSON
  · **cliente sabe:** Um clique baixa tudo o que a Mostraí guarda sobre você — inclusive o que você não digitou, como exibições e cobranças.

**Direitos do titular — consentimento e apagar dados opcionais (RN-25)** — Checkbox #chkComunicacoes (iniciado por !conta.comunicacoes_revogado_em) faz POST /titular/consentimento {escopo:'comunicacoes', aceita}; falha reverte o próprio checkbox. Botão #btnApagarOpcionais faz POST /titular/consentimento {escopo:'opcionais'}, que no…
  · `public/perfil.js`, `src/titular/routes.js`, `src/titular/repository.js` · rotas: `POST /titular/consentimento` · papéis: anunciante, ponto, vendedor
  · **cliente sabe:** Você liga e desliga as novidades quando quiser; avisos de plano, pagamento e anúncio continuam chegando porque fazem parte do serviço. E o que foi opcional (contato do responsável e foto) você apaga…

**Direitos do titular — arrependimento em 7 dias com estorno (CDC art. 49, RN-26)** — montarArrependimento() consulta GET /titular/arrependimento. Se já houver pedido, mostra o protocolo e o estado ('registrada e valor devolvido' ou 'devolução em andamento'). Se disponivel, mostra 'Você tem até <data> pra desistir e receber R$X de volta... O…
  · `public/perfil.js`, `src/titular/routes.js`, `src/titular/repository.js` · rotas: `GET /titular/arrependimento`, `POST /titular/arrependimento`, `GET /admin/arrependimentos`, `POST /admin/arrependimentos/:id/estornado` · papéis: anunciante
  · → fila do admin (o estorno em si é feito no painel do Checkout/Asaas)
  · **cliente sabe:** Desistiu em até 7 dias da primeira cobrança? O anúncio sai do ar na hora, a cobrança recorrente é cancelada e o valor pago volta inteiro — com protocolo.

**Sair e excluir a conta** — #btnLogout pede confirmação e faz POST /anunciantes/logout, que chama req.session.destroy() (destruir, não zerar o campo — senão sair como anunciante não derrubava admin/afiliado no mesmo cookie) e manda para '/'. #btnExcluirConta avisa que a conta fica…
  · `public/perfil.js`, `src/anunciantes/routes.js`, `src/playlist/gerador.js` · rotas: `POST /anunciantes/logout`, `POST /anunciantes/me/excluir` · papéis: anunciante, ponto, vendedor
  · → /
  · **cliente sabe:** Excluir tira você do ar na hora e a conta fica recuperável por 60 dias, só pelo suporte — não há botão de desfazer.

**Aprovação do criativo pelo admin (o passo que põe no ar)** — GET /admin/criativos?status=pendente lista a fila; PATCH /admin/criativos/:id {status} muda o estado (CAMPOS_ATUALIZAVEIS do criativos-repository: status, arquivo_normalizado_url, thumbnail_url, editado_pelo_operador). Só na transição !aprovado → aprovado sai…
  · `src/admin/routes.js`, `src/anunciantes/criativos-repository.js`, `src/financeiro/email.js` · rotas: `GET /admin/criativos`, `PATCH /admin/criativos/:id`
  · ← upload do anunciante / upload do operador  → playlist das telas
  · **cliente sabe:** Nenhum vídeo vai ao ar sem alguém olhar. Quando é aprovado, você recebe um e-mail dizendo que está na playlist.

**Entrada na playlist e confirmação de exibição** — anunciantesElegiveis(categoriaDoPonto, excluirContaId) monta quem entra na tela; limiteDeCriativos() corta em min(3, plano.limite_criativos) (conta própria sem teto); calcularPlaylist/contarPorAnunciante (src/lib/pacing.js) aplicam frequenciaBase =…
  · `src/playlist/gerador.js`, `src/playlist/routes.js`, `src/player/routes.js` · rotas: `GET /playlist/:dispositivoId`, `POST /player/:dispositivoId/played`, `POST /player/:dispositivoId/heartbeat`
  · ← criativo aprovado + conta ativa + plano dentro da validade  → KPIs e gráficos do painel do anunciante
  · **cliente sabe:** O que você vê como 'confirmado' é o que a TV avisou ter tocado de verdade — e só conta se aquele anúncio estava programado naquela tela naquela hora.

**Estados sem tela:** MOTIVO DA REPROVAÇÃO — a tabela `criativos` (migration 003) não tem coluna de motivo, o PATCH /admin/criativos/:id só… · APROVADO MAS FORA DO AR — o badge diz 'Aprovado' assim que o admin aprova, mas anunciantesElegiveis() ainda exige… · BLOQUEIO DE CONCORRENTE — a cláusula `a.categoria_id <> categoria do ponto` tira o anúncio das telas do mesmo ramo. O… · COTA DE AUTOANÚNCIO E CONTA PRÓPRIA — dividem inventário com os anúncios pagos (cotaDaTela e frequencia_hora_propria… · DÉFICIT E COMPENSAÇÃO — pacing.js soma o déficit da hora anterior à frequência da hora seguinte, e calcularPlaylist… · CRIATIVO 'PROCESSANDO...' PRESO — o card com `arquivo_normalizado_url` nulo só deveria existir durante o request; se o… · TETO DE CRIATIVOS DO PLANO — o número (planos.limite_criativos, migration 014) não aparece em lugar nenhum do painel;… · ASSINATURA CRIADA E NÃO PAGA — POST /anunciantes/:id/assinar grava uma linha em `assinaturas` e devolve o checkoutUrl;… · CONTA SUSPENSA POR ARREPENDIMENTO — depois do POST /titular/arrependimento a faixa mostra 'Suspenso' + 'Sem plano… · EXIBIÇÕES SEM RECORTE DE PERÍODO — os KPIs 'Exibições confirmadas' e 'Entrega' são totais de vida inteira da conta (SUM… · PAGINAÇÃO — docs/funcional.md §4 promete 'criativos e exibições paginam a partir de 50 linhas'; não existe LIMIT/offset… · AVISO DE QUEDA DE TELA — dispositivos offline (heartbeat/ultima_vez_online, HORAS_OFFLINE_ALERTA no admin) não geram…

**Notas:**
- BUG VIVO — link do comprovante nasce com id nulo: a IIFE `comprovante()` em /home/user/MostrAi/public/anunciante/painel.page.js:164-172 roda na hora do parse do script, quando ANUNCIANTE_ID ainda é null (só é preenchido dentro de carregar(), que é assíncrona). O href fica…
- BUG VIVO — consentimento de comunicações volta marcado: perfil.js:236 faz `chk.checked = !conta.comunicacoes_revogado_em`, mas a coluna `comunicacoes_revogado_em` (migration 025) NÃO está em CAMPOS_PUBLICOS de /home/user/MostrAi/src/anunciantes/repository.js, então GET /anunciantes/me nunca a…
- CORREÇÃO QUE ACABOU DE ENTRAR (working tree não commitado, `git status` mostra M public/anunciante/painel.page.js): a linha do badge usava `CRIATIVO_ROTULOS.anunciante[c.status]`, mapa que não existe em lugar nenhum do repositório — todo anunciante COM pelo menos um criativo tomava ReferenceError…
- DRIFT docs/funcional.md §7 vs código: a tabela diz 'ffmpeg falha ao normalizar → o criativo fica pendente, sem entrar na playlist / a pessoa vê estamos processando seu vídeo'. O código faz o oposto e por bom motivo (comentário em subirCriativo): deleta a linha e devolve 400 'não foi possível…
- DRIFT docs/api.md linha 37: descreve GET /anunciantes/me devolvendo `meses_gratis_creditados` e `meses_cobertura_pendentes`; as duas colunas foram DROPADAS na migration 021_remove_cobertura_adiada.sql e não estão em CAMPOS_PUBLICOS. A tabela de rotas de /admin foi conferida na Estação 4, mas esta…
- anunciantesElegiveis() não filtra `arquivo_normalizado_url IS NOT NULL`, ao contrário de criativosDoDono() logo abaixo (src/playlist/gerador.js). Um criativo aprovado com URL nula (hoje só alcançável se alguém aprovar pelo admin uma linha presa em 'processando') entraria na playlist com `url: null`…
- Corrida no teto de criativos: contarNaoReprovados e o INSERT não estão na mesma transação, e o input só trava por aba. Dois uploads simultâneos (duas abas) passam os dois pelo limite. Impacto baixo no porte declarado, mas é o mesmo padrão que o cadastro por convite resolveu com transação.
- Superfície de upload: o multer aceita pelo mimetype DECLARADO pelo cliente (fileFilter ^(image|video)/) — a validação real é o ffprobe, que rejeita o que não é mídia, e o avatar é forçado a contentType 'image/jpeg' fixo no upload para o bucket público. A cadeia está correta; vale registrar que o…
- public/nav-auth.js está órfão: nenhum HTML o carrega e o próprio layout.js diz no comentário que o substituiu. É candidato a remoção (ou a arquivo citado no CLAUDE.md que já não existe na prática).
- Ordem dos scripts importa e é frágil: painel.page.js depende de `fmtBRL`, `esc`, `API_BASE_URL` (config.js), `ROTULOS`, `#btnPerfil` (layout.js), `montarPerfil` (perfil.js), `montarModo`/`cardBonus` (modos.js) e `ligarCep`/`ligarCategorias` (formulario.js) — tudo via global, sem módulo. Trocar a…
- O painel do anunciante não expõe o item 8 pendente da spec (desconto de comodato por linha da grade) nem o item 9 (plano imutável, RN-27, já construído em 14/09) — a imutabilidade aparece só como `valor_mensal_travado` na faixa de status e em valorMensalDaConta.


---

## Papel vendedor

O papel VENDEDOR é um dos três papéis da conta única (`anunciantes.papeis text[]`, migration 019). Ele existe em 4 páginas públicas/de conta, 2 abas do admin, 2 rotas próprias (`GET /vendedor/painel`, `PATCH /vendedor/me`) mais 4 rotas de admin (`/admin/vendedores`, `/admin/vendedores/:contaId`, `/admin/comissoes`, `/admin/comissoes/:id`), 3 rotas legadas em 410 e 2 tabelas (`vendedores`, `comissoes`). O ciclo completo é: candidatura pública (ou pedido pelo painel) → convite gerado pelo dono → conta com papel `vendedor` + cupom gerado automaticamente → cupom viaja por link `?ref=CUPOM` → indicado se cadastra com `anunciantes.indicado_por_cupom` → quando o webhook do San Checkout credita um…

**Candidatura pública 'Seja um vendedor'** — Formulário público que grava uma linha em `candidaturas` com tipo='vendedor' e origem='site'. Não cria conta (RN-03). Campos enviados por `seja-um-vendedor.page.js`: tipo, nome, contato_telefone, contato_email, cidade, mensagem. O backend (`POST…
  · `public/seja-um-vendedor.html`, `public/seja-um-vendedor.page.js`, `src/candidaturas/routes.js` · rotas: `POST /candidaturas` · papéis: público
  · ← / (public/index.html, dois CTAs: 'Quero ser vendedor' e 'Quero ser parceiro') / menu público em public/layout.js (MENU_PUBLICO)  → Admin → aba Candidaturas / POST /admin/convites
  · **cliente sabe:** Bem explicado no marketing: 4 cards ('Seu cupom, seu crédito', 'Painel que mostra tudo', 'Produto que se explica sozinho', 'Comissão no Pix') e 3 passos ('Como funciona'). Mas NÃO diz o percentual…

**Convite — único caminho de entrada** — O dono gera um convite com `papeis:['vendedor']` (opcionalmente ligado a uma `candidatura_id`) e manda o link `/convite.html?t=TOKEN`. `convites/repository.js` valida os papéis contra a lista fixa PAPEIS=['anunciante','ponto','vendedor']. Cadastro aberto de…
  · `src/convites/repository.js`, `src/convites/routes.js`, `public/admin/index.page.js` · rotas: `POST /admin/convites`, `GET /admin/convites`, `POST /admin/convites/:id/revogar`, `GET /convites/:token` · papéis: administrador, público com token
  · ← Admin → Candidaturas → botão que pergunta 'Esse vendedor também vai ANUNCIAR (ter plano pago)? OK = sim, também anunciante. Cancelar = só vendedor.' (index.page.js:946)  → POST /anunciantes/cadastro / POST /convites/:token/aceitar
  · **cliente sabe:** `convite.page.js` mostra o card do papel: 'Vendedor — Comissão em cada assinatura que você indicar.' Uma linha. Sem percentual, sem periodicidade.

**Cadastro por convite → criação do perfil de vendedor e do cupom** — `POST /anunciantes/cadastro` com `convite`: consome o token ANTES de criar a conta (transação), cria a conta já com status 'aprovado' e os papéis do convite, e — se papeis inclui 'vendedor' — exige `chave_pix` (400 'chave Pix é obrigatória pra receber…
  · `src/anunciantes/routes.js`, `src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql` · rotas: `POST /anunciantes/cadastro` · papéis: público com token de convite (perfil de vendedor não nasce mais — programa aposentado, repositório removido em 24/09/2026)
  · ← /convite.html?t=TOKEN  → /anunciante/vendedor.html (convite só-vendedor cai direto lá — convite.page.js linha do `destino`)
  · **cliente sabe:** O formulário mostra a seção Pix com a legenda 'Sua comissão de vendedor é paga nessa chave. Pode ser CPF, e-mail, telefone ou chave aleatória.' O cupom NÃO é mostrado no momento do cadastro — o…

**Aceite de convite por conta já logada** — Conta existente aceita um convite e ganha o papel novo em vez de nascer outra conta. Exige `chave_pix` no corpo se 'vendedor' estiver entre os papéis novos (400 'chave Pix é obrigatória pra receber comissão'). Roda em `emTransacao`: consome o convite, chama…
  · `src/conta/modos.js`, `public/convite.page.js`, `public/convite.html` · rotas: `POST /convites/:token/aceitar` · papéis: conta logada
  · ← /convite.html?t=TOKEN com sessão ativa  → /anunciante/vendedor.html
  · **cliente sabe:** Título dinâmico: '<Empresa>, esse convite libera vendedor' + campo 'Chave Pix pra receber comissão'. Nada sobre percentual nem prazo.

**Pedido de 'modo vendas' pelo próprio painel** — Quem já tem conta pede o papel sem convite: `POST /conta/modos/vendedor/pedir` cria uma `candidatura` com tipo='vendedor', origem='painel' e `conta_id`. Recusa 409 se o papel já existe ou se já há pedido 'nova'/'em_contato'. O card de ativação…
  · `src/conta/modos.js`, `public/modos.js`, `public/anunciante/vendedor.page.js` · rotas: `POST /conta/modos/vendedor/pedir`, `GET /conta/modos` · papéis: conta logada sem o papel vendedor
  · ← clique na aba 'Vendas' do menu da conta (public/layout.js, aba marcada com classe `bloqueado` e title 'Modo ainda não ativado — clique pra ativar')  → POST /admin/candidaturas/:id/liberar
  · **cliente sabe:** 'Você ganha um cupom próprio; toda assinatura fechada com ele rende comissão em cada cobrança.' É o texto que mais perto chega de explicar a recorrência. Ainda sem percentual e sem prazo de pagamento.

**Liberação do papel pelo admin** — `POST /admin/candidaturas/:id/liberar` liga o papel direto numa conta que já existe (candidatura com `conta_id`), sem gerar link. Chama `liberarPapelNaConta(conta,'vendedor',cand,cliente)` que faz `adicionarPapel` + `vendedoresRepo.criar(conta.id,{chave_pix:…
  · `src/conta/modos.js`, `src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql` · rotas: `POST /admin/candidaturas/:id/liberar`, `PATCH /admin/candidaturas/:id` · papéis: administrador
  · ← Admin → aba Candidaturas  → perfil em `vendedores`, cupom gerado
  · **cliente sabe:** Nada é comunicado à pessoa: não existe e-mail nem notificação. Ela só descobre que foi liberada se voltar ao painel por conta própria.

**Cupom e link de indicação (a ferramenta de venda)** — O painel monta `${origin}/anunciante/cadastro.html?ref=${cupom}`, oferece botão Copiar para o cupom, botão Copiar link e um botão 'Mandar no WhatsApp' com texto pronto ('Coloca a sua marca nas telas da Mostraí em Matão. Cadastra por aqui com o meu cupom X:…
  · `public/anunciante/vendedor.html`, `public/anunciante/vendedor.page.js`, `public/admin/index.page.js` · rotas: `GET /vendedor/painel` · papéis: vendedor, administrador
  · ← /anunciante/vendedor.html  → /anunciante/cadastro.html?ref=CUPOM
  · **cliente sabe:** 'O anunciante digita esse cupom no cadastro — ou usa o seu link, que já preenche sozinho.' A primeira metade da frase é FALSA: `public/anunciante/cadastro.html` não tem campo de cupom nenhum.…

**Atribuição da indicação no cadastro do indicado** — `cadastro.page.js` lê `?ref=` e manda como `indicado_por_cupom`. `anunciantesRepo.criar` grava em `anunciantes.indicado_por_cupom` já em UPPERCASE. Nenhuma validação: cupom inexistente, de vendedor inativo ou digitado errado é aceito e persistido igual.…
  · `public/anunciante/cadastro.page.js`, `public/anunciante/cadastro.html`, `src/anunciantes/routes.js` · rotas: `POST /anunciantes/cadastro`, `POST /admin/anunciantes` · papéis: público, administrador
  · ← link/WhatsApp do vendedor  → registrarComissaoSeHouver, na primeira cobrança confirmada
  · **cliente sabe:** Nada. O indicado não vê 'você foi indicado por Fulano' em lugar nenhum do formulário, e o vendedor não recebe nenhum sinal de que alguém abriu o link ou se cadastrou.

**Geração da comissão (o momento em que o dinheiro nasce)** — `registrarComissaoSeHouver(anunciante, valor, db)` em san-checkout.js. Roda DENTRO da transação de `aplicarCicloPago`, junto com o UPDATE de `anunciantes` e o INSERT em `cobrancas_confirmadas` — ou entra tudo, ou nada. Regras concretas: (a) só age se…
  · `src/financeiro/san-checkout.js`, `src/financeiro/conciliacao.js`, `src/lib/dinheiro.js` · rotas: `POST /webhook/san-checkout`, `npm run conciliar` · papéis: servidor (nenhuma pessoa dispara)
  · ← webhook do San Checkout (evento 'criada' ou 'cobranca_confirmada') ou cron de conciliação  → tabela `comissoes` → GET /vendedor/painel e GET /admin/comissoes
  · **cliente sabe:** Só depois do fato: a linha aparece no painel. Não há e-mail (`src/financeiro/email.js` não tem nenhuma função para vendedor — só enviarConfirmacaoPagamento, enviarLinkRedefinicaoSenha,…

**Painel de vendas do vendedor** — `GET /vendedor/painel`, protegido por `exigirVendedorLogado` (401 sem sessão, 403 'esta conta não é de vendedor' sem linha em `vendedores`). Devolve `{vendedor, comissoes, totalComissionado, totalPago, totalAReceber}`; comissões vêm com JOIN em `anunciantes`…
  · `public/anunciante/vendedor.html`, `public/anunciante/vendedor.page.js`, `src/financeiro/routes.js` · rotas: `GET /vendedor/painel` · papéis: vendedor
  · ← aba 'Vendas' do menu da conta / redirect 301 de /afiliado/painel.html / convite só-vendedor  → PATCH /vendedor/me (aviso de Pix) / WhatsApp com link de indicação
  · **cliente sabe:** A frase-chave é: 'Comissão: <X>% de cada cobrança confirmada dos seus indicados, paga no Pix <chave>.' Diz o percentual, a base (cobrança confirmada) e o destino (Pix). NÃO diz quando: nenhuma data…

**Chave Pix do vendedor** — `PATCH /vendedor/me` (em src/conta/modos.js, não em financeiro/routes.js) atualiza só `chave_pix` — 403 se a conta não tem perfil de vendedor, 400 se o corpo vier sem a chave. Passa pela allowlist `CAMPOS_ATUALIZAVEIS =…
  · `src/conta/modos.js`, `src/financeiro/vendedores-repository.js`, `public/anunciante/vendedor.page.js` · rotas: `PATCH /vendedor/me` · papéis: vendedor
  · ← aviso `#avisoPix` no painel de vendas  → GET /admin/comissoes (a chave aparece na linha para o admin pagar)
  · **cliente sabe:** Bem explicado e bem colocado: o aviso é o primeiro elemento da página quando falta a chave.

**Admin — aba Vendedores** — `GET /admin/vendedores` devolve `vendedoresRepo.listar()` (JOIN com anunciantes: nome, email, telefone, cpf). A tabela é editável em linha: chave Pix (texto), Comissão % (number, step .01, 0–100) e Status (select Aprovado/Inativo) salvam no blur via `PATCH…
  · `public/admin/index.page.js`, `src/financeiro/routes.js`, `src/financeiro/vendedores-repository.js` · rotas: `GET /admin/vendedores`, `PATCH /admin/vendedores/:contaId` · papéis: administrador
  · ← Admin → Vendedores  → mudança do percentual afeta só comissões FUTURAS (as já gravadas têm o valor congelado em `comissoes.comissao_valor`)
  · **cliente sabe:** Nada chega ao vendedor. Se o dono baixar o percentual de 12% para 5%, o painel do vendedor simplesmente passa a exibir 5% na frase 'Comissão: X% de cada cobrança confirmada' — sem aviso, sem…

**Admin — aba Comissões (o pagamento)** — `GET /admin/comissoes` lista tudo com `ORDER BY c.pago_em NULLS FIRST, c.criado_em DESC` (abertas primeiro), trazendo `vendedor_nome`, `chave_pix` e o nome do anunciante. A tela agrupa em KPIs 'Total a pagar' e um card por vendedor com o Pix. `PATCH…
  · `public/admin/index.page.js`, `src/financeiro/routes.js` · rotas: `GET /admin/comissoes`, `PATCH /admin/comissoes/:id` · papéis: administrador
  · ← Admin → Comissões  → KPI 'Já recebido' e badge 'Pago em <data>' no painel do vendedor
  · **cliente sabe:** Do lado do vendedor, a badge muda de 'A receber' para 'Pago em dd/mm/aaaa'. Sem comprovante, sem identificador de transação, sem e-mail. Se o admin errar e marcar a comissão errada, o botão…

**Métrica — evento comissao:vendedor_gera** — Emitido em `registrarComissaoSeHouver` com `{anunciante_id: vendedor.conta_id, vendedor_id, comissao_valor, valor_confirmado}`. O dono do evento é deliberadamente o vendedor (comentário no código: 'a pergunta é quanto a indicação custa, e ela se responde por…
  · `src/financeiro/san-checkout.js`, `src/lib/eventos.js`, `src/admin/metrica.js` · rotas: `GET /admin/metrica` · papéis: administrador
  · ← transação do webhook, depois do COMMIT da cobrança  → aba Métrica do admin
  · **cliente sabe:** Não se aplica — é instrumentação interna.

**Direitos do titular aplicados ao vendedor** — `GET /titular/meus-dados` monta o JSON da conta incluindo três recortes do papel vendedor: `comissoes_ganhas_como_vendedor` (WHERE vendedor_conta_id = eu, com `anunciante_id AS indicou`), `comissoes_geradas_pelas_minhas_compras` (WHERE anunciante_id = eu — o…
  · `src/titular/repository.js`, `src/titular/routes.js` · rotas: `GET /titular/meus-dados`, `POST /titular/consentimento` · papéis: conta logada
  · ← /anunciante/perfil.html (hoje 301 para painel.html)  → download com Content-Disposition: attachment
  · **cliente sabe:** É a única superfície onde o vendedor consegue ver, em dado bruto, tudo o que o sistema guarda sobre a comissão dele — inclusive o `comissao_percentual` histórico e o `pago_em` de cada linha.

**Legado de 'afiliado' → vendedor** — Três redirects 301 em `src/server.js` (MUDARAM_DE_ENDERECO): /afiliado/cadastro.html → /seja-um-vendedor.html, /afiliado/login.html → /anunciante/login.html, /afiliado/painel.html → /anunciante/vendedor.html. E três rotas POST em 410 com a mensagem 'vendedor…
  · `src/server.js`, `src/financeiro/routes.js`, `src/financeiro/afiliados-repository.js` · rotas: `GET /afiliado/*.html (301)`, `POST /afiliados/cadastro (410)`, `POST /afiliados/login (410)`, `POST /afiliados/logout (410)` · papéis: público com link antigo
  · ← links salvos de antes da v2  → /anunciante/login.html
  · **cliente sabe:** A mensagem do 410 diz exatamente para onde ir. Boa.

**Navegação da aba Vendas — REMOVIDA do menu (19/09/2026)** — Não existe mais aba nem link pra /anunciante/vendedor.html no menu (nem público, nem da conta). A página continua no ar e funcional pra quem já tem o papel vendedor; o caminho até ela agora é `montarLinkVendedor()` (`painel.page.js`) — uma linha só, "Ver meu painel de vendas →", que aparece no fim do Painel quando `papeis.includes('vendedor')`, sem inflar o menu com uma aba que quase ninguém usa.
  · `public/layout.js`, `public/anunciante/painel.page.js` · rotas: `GET /anunciantes/me` · papéis: vendedor
  · ← link no fim de /anunciante/painel.html  → /anunciante/vendedor.html
  · **cliente sabe:** Sim — o link só some se a conta não tiver o papel; quem já é vendedor sempre acha o próprio painel, só que agora dentro do Painel em vez de lá em cima.

**Estados sem tela:** QUANDO o vendedor recebe. É o buraco central. `comissoes.pago_em` só muda por clique manual do admin em `PATCH… · Comissão gerada sem avisar ninguém. `src/financeiro/email.js` não tem nenhuma função dirigida ao vendedor. O anunciante… · Comissão marcada como paga sem avisar ninguém. A badge muda no painel se o vendedor entrar. Sem comprovante, sem… · Vendedor com `status='inativo'`: `registrarComissaoSeHouver` filtra por `v.status='aprovado'` e simplesmente retorna. O… · Cupom inexistente ou digitado errado: `POST /anunciantes/cadastro` aceita qualquer string em `indicado_por_cupom`,… · Auto-indicação: `if (vendedor.conta_id === anunciante.id) return` — bloqueio correto, mas totalmente silencioso. O… · Conta com o papel 'vendedor' sem linha em `vendedores`. `papeis` está em `CAMPOS_ATUALIZAVEIS` de… · Perfil de vendedor com `chave_pix` NULL. `liberarPapelNaConta` chama `vendedoresRepo.criar(..., {chave_pix:… · `ROTULOS.vendedor.pendente_aprovacao` em `public/layout.js` é um estado que o banco proíbe: o CHECK da migration 019… · Indicado que se cadastrou com o cupom mas ainda não pagou é invisível para o vendedor. O painel só lista `comissoes`,… · Candidatura de vendedor recusada (`PATCH /admin/candidaturas/:id` com status 'recusada'): nenhuma notificação, nenhuma… · Mudança de `comissao_percentual` no admin não tem vigência nem histórico. O painel do vendedor passa a mostrar o valor…

**Notas:**
- `buscarPorCupomAprovado` em `/home/user/MostrAi/src/financeiro/vendedores-repository.js` é código morto: está exportada e não é chamada em lugar nenhum de src/, tests/ ou public/. `registrarComissaoSeHouver` refaz a mesma consulta inline em `san-checkout.js` (com `upper($1)`, que a função do…
- O caminho mais barato de fechar o buraco do 'quando' sem construir nada: uma frase fixa no card do cupom em `public/anunciante/vendedor.html` e no item 6 dos Termos, do tipo 'as comissões em aberto são pagas no Pix até o dia X do mês seguinte'. Hoje o produto tem o número (percentual), o destino…
- O texto 'O anunciante digita esse cupom no cadastro' no painel de vendas é falso hoje: `public/anunciante/cadastro.html` não tem campo de cupom. Ou se acrescenta o campo (com validação contra `buscarPorCupomAprovado` e feedback 'indicado por Fulano'), ou se corrige a frase para falar só do link. Do…
- A comissão é transacional e idempotente de verdade: entra no mesmo BEGIN/COMMIT da cobrança em `aplicarCicloPago`, e a dedupe por `chargeId|status` em `webhooks_processados` (migration 018, cujo comentário nasceu exatamente de 'pagava a comissão do vendedor duas vezes'). O rollback apaga a chave de…
- Cobertura de teste do papel: `tests/e2e/01-fluxo-api.sh` (convite ponto+vendedor, cupom em /anunciantes/me, painel), `02-fundador-webhook-comissao.sh` (valor da comissão, não-duplicação, soma no painel, listagens do admin), `04-modos-e-bonus.sh` (pedido de modo, exigência de Pix no aceite, PATCH…
- Assimetria de arquivo que atrapalha a leitura: as duas rotas do vendedor moram em módulos diferentes — `GET /vendedor/painel` em `/home/user/MostrAi/src/financeiro/routes.js` (com `exigirVendedorLogado`) e `PATCH /vendedor/me` em `/home/user/MostrAi/src/conta/modos.js` (que refaz a checagem à mão…
- `docs/api.md` está desatualizado num ponto verificável: o cabeçalho da seção Admin diz 'As 60 rotas estão listadas uma a uma' enquanto o CLAUDE.md fala em 55 e o enunciado do projeto em 112 rotas no total. As 4 rotas de admin do papel vendedor (`/admin/vendedores`, `/admin/vendedores/:contaId`,…
- A restrição legal registrada em `CONSTRAINTS.md` é pertinente a este papel e continua sem tratamento no produto: 'Comissão de vendedor recorrente pode caracterizar representação comercial (Lei 4.886/65) … O contrato com o vendedor é decisão do dono e está fora deste repositório.' Não existe, hoje,…


---

## Administração

Painel administrativo de página única em `/admin/index.html`. Três arquivos: `public/admin/index.html` (60 linhas — só o gate de login, a casca `#app` com `<aside class="admin-side">` + `<main class="admin-main">` e dois `<script>`: `/config.js` e `/admin/index.page.js`), `public/admin/index.css` (87 linhas — casca de grid 224px+1fr, `.alertas`, `.tabela-caixa`, `.criativo-fila`, `.toast`, colapsa para abas horizontais roláveis em max-width 900px) e `public/admin/index.page.js` (1685 linhas — TODA a lógica). O HTML não tem nenhum link interno: a navegação é montada em runtime por `montarNav()` a partir da constante `NAV` (linha 129), em 5 grupos — Início, Entrada, Operação, Catálogo,…

**Gate de login e casca (montarNav / irPara / pintarContadores)** — Formulário `#formLogin` sobre `#gate`; em sucesso chama `mostrarApp()`, que esconde o gate, roda `montarNav()` e `irPara(hash || 'resumo', true)`. `montarNav()` desenha os 5 grupos de `NAV` como `<button class="nav-item" data-aba data-fila>`.…
  · `public/admin/index.html`, `public/admin/index.page.js`, `public/admin/index.css` · rotas: `POST /admin/login (src/server.js:126)`, `POST /admin/logout (src/server.js:142)`, `GET /admin/resumo (sonda de sessão, index.page.js:292)` · papéis: admin
  · → Visão geral
  · **cliente sabe:** Sim — o erro de login diz 'Usuário ou senha inválidos' e, se o fetch estourar, 'Não foi possível falar com o servidor. Ele está rodando?'. Só o usuário/senha vem de variável de ambiente: não há tela…

**Visão geral (resumo)** — `renderResumo(el)` (linha 319). Cartões de alerta (`ALERTAS`, linha 294) só para filas > 0, cada um um `<button data-ir>` que chama `irPara(aba)`; se tudo zerado, mostra a faixa '.tudo-em-dia'. Marca como `.urgente` (vermelho) criativos, telas sem sinal,…
  · `public/admin/index.page.js`, `src/admin/routes.js` · rotas: `GET /admin/resumo (src/admin/routes.js:57)` · papéis: admin
  · ← é a aba inicial (hash vazio)  → Fila de criativos / Telas / Candidaturas
  · **cliente sabe:** Cada KPI tem legenda ('custo de cada tela ÷ prazo dela', 'planos ativos, por mês'). Mas o resumo calcula e devolve `anunciantesAtivosPagantes` e `anunciantesEmCortesia` (src/admin/routes.js, RN-23) e…

**Métrica** — `renderMetrica(el)` (linha 1299). Só leitura, sem nenhuma ação. Três KPIs (margem do mês corrente, % de quem abre checkout e paga, % de quem cadastra e paga) e quatro tabelas: Margem mês a mês (receita, pontos, amortização, fixos, margem), Funil mês a mês…
  · `public/admin/index.page.js`, `src/admin/routes.js`, `src/admin/metrica.js` · rotas: `GET /admin/metrica (src/admin/routes.js:53 → metrica.consultar())` · papéis: admin
  · ← menu, grupo Início
  · **cliente sabe:** Sim, e bem: o subtítulo avisa que ignora a conta própria e as de teste; há um aviso explícito de que 'os três custos são os de hoje, repetidos em todo mês da tabela — só a receita é histórica de…

**Candidaturas** — `renderCandidaturas(el)` (linha 903). Tabela de quem pediu para ser ponto ou vendedor. Colunas: quando, tipo (selo Ponto/Vendedor + marcação 'pedido do painel' quando `origem='painel'` e 'bônus do plano' quando `origem='bonus_plano'`), nome (+ 'conta #id'…
  · `public/admin/index.page.js`, `src/candidaturas/routes.js`, `src/candidaturas/repository.js` · rotas: `GET /admin/candidaturas (src/candidaturas/routes.js:20)`, `PATCH /admin/candidaturas/:id (src/candidaturas/routes.js:22)`, `POST /admin/convites (src/convites/routes.js:25)`, `POST /admin/candidaturas/:id/liberar (src/conta/modos.js:183)` · papéis: admin, ponto, vendedor
  · ← Visão geral (alerta 'candidatura(s) nova(s) pra responder') / Planos (o módulo 'Tela após N meses' despeja resgates aqui) / Opções de comodato (o bônus de plano do dono de ponto também cai aqui)  → Convites (o convite gerado aparece lá) / Pontos e Telas (quando 'Liberar na conta' é usado, o ponto e a Tela 1 nascem) / Anunciantes (a conta criada pelo convite)
  · **cliente sabe:** A dica do rodapé explica bem as duas saídas. O que NÃO está na tela: que 'Liberar na conta' cria silenciosamente um ponto E uma Tela 1 sem chave de aparelho — o confirm() avisa, mas nada leva o admin…

**Convites** — `renderConvites(el)` (linha 979). `<details open>` com o formulário `#formNovoConvite`: checkboxes dos três papéis (`PAPEIS`, 'ponto' já marcado), nome e e-mail sugeridos, validade em dias (default 7, 1..60). Gera o link, copia para a área de transferência e…
  · `public/admin/index.page.js`, `src/convites/routes.js` · rotas: `GET /admin/convites (src/convites/routes.js:20)`, `POST /admin/convites (src/convites/routes.js:25)`, `POST /admin/convites/:id/revogar (src/convites/routes.js:44)` · papéis: admin, anunciante, ponto, vendedor
  · ← Candidaturas (botão 'Gerar convite')  → Anunciantes (a conta nasce lá quando o link é usado) / Vendedores (só nasce vendedor por convite com papel 'vendedor') / Pontos e Telas (convite de ponto vindo de candidatura cria o ponto e a Tela 1 no cadastro)
  · **cliente sabe:** Sim: a dica diz que convite é o único caminho de entrada de dono de ponto e de vendedor, e que o de ponto vindo de candidatura já cria ponto e Tela 1. O convite gerado a partir de Candidaturas…

**Fila de criativos** — `renderCriativos(el, status='pendente')` (linha 371). Não é tabela: é uma grade de cartões `.criativo-fila`, cada um com o vídeo (`<video controls muted loop>` quando a URL termina em mp4/webm/mov/m4v, senão `<img>`) usando `arquivo_normalizado_url ||…
  · `public/admin/index.page.js`, `src/admin/routes.js`, `src/anunciantes/criativos-repository.js` · rotas: `GET /admin/criativos?status= (src/admin/routes.js:15)`, `GET /admin/anunciantes (src/anunciantes/routes.js:464 — só para o nome)`, `PATCH /admin/criativos/:id (src/admin/routes.js:19)` · papéis: admin, anunciante
  · ← Visão geral (alerta urgente 'criativo(s) esperando aprovação')  → playlist/player (aprovado entra no ar) / Métrica (o PATCH para 'aprovado' emite o evento criativo:video_aprova com horas_ate_aprovar) / e-mail 'seu anúncio está no ar' ao dono, só na transição para aprovado
  · **cliente sabe:** Não diz na tela que aprovar dispara e-mail para o anunciante, nem que a peça entra na playlist imediatamente. E, crucial: criativo subido pelo admin em Anunciantes ou em Meus anúncios nasce com…

**Meus anúncios** — `renderMeusAnuncios(el)` (linha 425). A conta de anunciante do próprio Mostraí (`conta_propria`, migration 023): anuncia a rede nas telas da rede, sem plano, sem cobrança, criativos ilimitados. Se não existe, mostra `#formContaPropria` (nome, CNPJ, vezes por…
  · `public/admin/index.page.js`, `src/anunciantes/routes.js`, `src/anunciantes/repository.js` · rotas: `GET /admin/anunciantes (src/anunciantes/routes.js:464 — procura `conta_propria`)`, `POST /admin/anunciantes (src/anunciantes/routes.js:474)`, `PATCH /admin/anunciantes/:id (src/anunciantes/routes.js:533)`, `GET /admin/criativos — SEM query string (src/admin/routes.js:15)` · papéis: admin, anunciante
  · ← menu, grupo Operação  → playlist das telas / Anunciantes (a conta própria aparece lá como uma linha comum)
  · **cliente sabe:** O subtítulo explica bem o conceito. Mas a tela está QUEBRADA: `renderMeusAnuncios` chama `pegar('/admin/criativos')` sem `?status=`, e o servidor usa `req.query.status || 'pendente'`. Como criativo…

**Pontos** — `renderPontos(el)` (linha 537). `<details>` '+ Novo ponto (cadastro manual)' → POST /admin/pontos com `status:'aguardando_instalacao'` fixo. Tabela de 13 colunas com edição inline (salva no `change`, ou seja ao sair do campo): ID, Nome (+ responsável e…
  · `public/admin/index.page.js`, `src/pontos/routes.js`, `src/pontos/repository.js` · rotas: `GET /admin/pontos (src/pontos/routes.js:93)`, `GET /admin/categorias (src/categorias/routes.js:16)`, `GET /admin/planos-ponto (src/pontos/routes.js:145)`, `PATCH /admin/pontos/:id (src/pontos/routes.js:98)` · papéis: admin, ponto
  · ← Visão geral (alerta 'ponto(s) candidatos aguardando triagem' = status 'lead') / Candidaturas (via convite ou 'Liberar na conta')  → Telas (link 'N/M no ar' e botão '+ tela' fazem irPara('telas') com o filtro já aplicado) / Visão geral (valor_pago_mensal alimenta custoPontosMensal, fluxo_estimado_mensal alimenta o alcance)
  · **cliente sabe:** Muito bem explicado: o parágrafo abaixo da tabela diz que trocar a opção de comodato NÃO recalcula ajuda e cota sozinho, que a cota é dividida entre as telas ativas, que o fluxo só entra na soma…

**Telas** — `renderTelas(el)` (linha 650). Uma linha por TV/dispositivo. Colunas: ID, Ponto (+ cidade e status do ponto), Tela (apelido editável), Status (`TELA_STATUS`), Último sinal (com selo 'sem sinal' quando `estaOffline()` — tela ativa em ponto ativo cujo…
  · `public/admin/index.page.js`, `src/dispositivos/routes.js`, `src/dispositivos/repository.js` · rotas: `GET /admin/dispositivos (src/dispositivos/routes.js:13)`, `PATCH /admin/dispositivos/:id (src/dispositivos/routes.js:27)`, `POST /admin/dispositivos/:id/chave (src/dispositivos/routes.js:49)`, `POST /admin/dispositivos/:id/pin (src/dispositivos/routes.js:55)` · papéis: admin, ponto
  · ← Pontos (link 'N/M no ar' e botão '+ tela') / Visão geral (alerta urgente 'tela(s) ativas sem dar sinal')  → Visão geral (custo_equipamento ÷ meses_amortizacao das telas ativas = amortizacaoMensal; telas sem sinal = alerta urgente) / Custos fixos (o KPI 'Amortização das telas' aparece lá também) / player.html
  · **cliente sabe:** Sim, com o passo a passo completo abaixo da tabela ('gere a chave → copie o link → abra no navegador da TV') e a explicação do PIN (5 toques no canto superior direito ou tecla P). O estado vazio…

**Anunciantes** — `renderAnunciantes(el)` (linha 757). Todas as contas — os papéis vêm do convite. `<details>` '+ Novo anunciante (cadastro manual)' → POST /admin/anunciantes, que devolve `senhaGerada` e a mostra num `alert()` com o aviso de que não fica salva em nenhuma tela…
  · `public/admin/index.page.js`, `src/anunciantes/routes.js`, `src/anunciantes/repository.js` · rotas: `GET /admin/anunciantes (src/anunciantes/routes.js:464)`, `GET /admin/categorias`, `GET /admin/planos (src/financeiro/routes.js:29)`, `GET /admin/pontos (só para marcar quem é dono de ponto)` · papéis: admin, anunciante, ponto, vendedor
  · ← Visão geral (alerta 'anunciante(s) pendente(s) de aprovação') / Convites (conta criada pelo link)  → Visão geral (status 'ativo' + plano = receitaMensal; 'pendente_aprovacao' = fila) / Fila de criativos (só em teoria — o upload daqui nasce aprovado e pula a fila) / Métrica (mudar status para aprovado/ativo emite conta:aprovacao_recebe uma única vez, na transição)
  · **cliente sabe:** O subtítulo explica o 'Subir anúncio' ('põe a peça pronta direto na conta do cliente, já aprovada'). Não está na tela: que 'Liberar plano' é recusado com 409 se a conta tem plano pago ainda vigente…

**Vendedores** — `renderVendedores(el)` (linha 864). Só edição, nunca criação. Colunas: Conta (`conta_id`), Nome, Contato, Chave Pix (input inline), Cupom (`<code>` + botão 'copiar link' que monta `/anunciante/cadastro.html?ref=CUPOM`), Comissão % (input 0..100), Status…
  · `public/admin/index.page.js`, `src/financeiro/routes.js`, `src/financeiro/vendedores-repository.js` · rotas: `GET /admin/vendedores (src/financeiro/routes.js:405)`, `PATCH /admin/vendedores/:contaId (src/financeiro/routes.js:407)` · papéis: admin, vendedor
  · ← menu, grupo Operação (não tem contador nem alerta)  → Comissões (comissao_percentual e chave_pix são lidos lá) / cadastro público com ?ref=cupom
  · **cliente sabe:** Sim, tanto na dica do rodapé quanto no estado vazio: 'Gere um convite com o papel vendedor na aba Convites — a conta que entrar por ele já nasce com cupom'. É a única aba que diz explicitamente onde…

**Planos** — `renderPlanos(el)` (linha 1090). A aba mais carregada de regra. `<details>` '+ Novo plano' com id único, tier, nome, compromisso (`CICLOS` 1/3/6/12), frequência/dia, valor mensal, limite de criativos (1..3), cobertura (todos_pontos / tres_pontos_dia /…
  · `public/admin/index.page.js`, `src/financeiro/routes.js`, `src/financeiro/planos-repository.js` · rotas: `GET /admin/planos (src/financeiro/routes.js:29 — só não arquivados)`, `GET /admin/beneficios (src/financeiro/routes.js:147)`, `POST /admin/planos (src/financeiro/routes.js:44)`, `PATCH /admin/planos/:id (src/financeiro/routes.js:74 — recusa campo de contrato com 409)` · papéis: admin, anunciante
  · ← menu, grupo Catálogo  → Planos arquivados (a versão aposentada cai lá) / Anunciantes (coluna Plano e o prompt de 'Liberar plano') / Opções de comodato (o select 'Bônus: plano de anúncio' lista estes planos)
  · **cliente sabe:** Excepcionalmente bem: o parágrafo final explica campo a campo o que é contrato e o que é vitrine, e o confirm do botão repete. DUAS coisas erradas nesse mesmo parágrafo: ele explica 'Mín. telas' e…

**Planos arquivados** — `renderPlanosArquivados(el)` (linha 1346). Só leitura. KPI 'Versões aposentadas: N — M ainda com conta ativa'. Tabela com ID, Nome, Ciclo, Valor mensal, Criativos, Freq./dia, Cobertura, Benefícios (juntos por ' · '), Aposentada em, Substituída por, Contas…
  · `public/admin/index.page.js`, `src/financeiro/routes.js`, `src/financeiro/planos-repository.js` · rotas: `GET /admin/planos-arquivados (src/financeiro/routes.js:142 → planosRepo.listarArquivados())` · papéis: admin
  · ← Planos
  · **cliente sabe:** Sim, e é a melhor prosa do painel: o estado vazio diz 'Quando você publicar uma versão nova de um plano, a anterior aparece aqui', e o rodapé explica por que zero contas ativas ainda não autoriza…

**Benefícios** — `renderBeneficios(el)` (linha 1388). Catálogo reaproveitado por todos os planos. Formulário de criação (texto + ordem) sempre visível. Tabela com Texto (input), Ordem (number), Disponível (checkbox — desmarcado some da lista dos planos sem apagar o vínculo) e…
  · `public/admin/index.page.js`, `src/financeiro/routes.js` · rotas: `GET /admin/beneficios (src/financeiro/routes.js:147)`, `POST /admin/beneficios (src/financeiro/routes.js:151)`, `PATCH /admin/beneficios/:id (src/financeiro/routes.js:161)`, `DELETE /admin/beneficios/:id (src/financeiro/routes.js:167)` · papéis: admin
  · ← menu, grupo Catálogo  → Planos (a coluna Benefícios é este catálogo; `opcoesBeneficio()` lista inclusive os inativos, marcados '(indisponível)', justamente para não apagar o vínculo no próximo clique) / vitrine pública de planos
  · **cliente sabe:** A dica diz 'Excluir tira o benefício de todos os planos que o usavam'. O que NÃO está dito aqui: marcar/desmarcar um benefício dentro da aba Planos é campo de CONTRATO — não salva, obriga a publicar…

**Categorias** — `renderCategorias(el)` (linha 1436). Segmentos usados no cadastro. Formulário de criação (nome) + tabela com Nome (input), 'Aparece no cadastro' (checkbox `ativo`) e Excluir. O confirm de exclusão é o único que explica a consequência de negócio: 'É ela que…
  · `public/admin/index.page.js`, `src/categorias/routes.js` · rotas: `GET /admin/categorias (src/categorias/routes.js:16)`, `POST /admin/categorias (src/categorias/routes.js:21)`, `PATCH /admin/categorias/:id (src/categorias/routes.js:33)`, `DELETE /admin/categorias/:id (src/categorias/routes.js:46)` · papéis: admin
  · ← menu, grupo Catálogo  → Pontos (select 'Segmento do local') / Anunciantes (select 'Ramo') / playlist (a regra de exclusividade por ramo na tela)
  · **cliente sabe:** Sim: a dica diz que categoria já usada por alguém não pode ser excluída e que o caminho é desmarcar. Mas quem está em Pontos ou Anunciantes com o select vazio não recebe nenhuma pista de que a lista…

**Opções de comodato** — `renderComodato(el)` (linha 1479). O que o dono do ponto escolhe no formulário 'Seja um ponto'. Tabela SEM `caixaTabela`/`turbinarTabela` (sem busca, sem chips, sem ordenação) e SEM formulário de criação. Colunas editáveis inline: Opção (nome + id embaixo),…
  · `public/admin/index.page.js`, `src/pontos/routes.js`, `src/pontos/planos-ponto-repository.js` · rotas: `GET /admin/planos-ponto (src/pontos/routes.js:145)`, `GET /admin/planos (src/financeiro/routes.js:29 — para o select de bônus)`, `PATCH /admin/planos-ponto/:id (src/pontos/routes.js:160)` · papéis: admin, ponto
  · ← menu, grupo Catálogo  → Pontos (a coluna 'Comodato' lista estas opções) / página pública 'Seja um ponto' / Candidaturas (o resgate do bônus pelo dono do ponto vira candidatura com origem='bonus_plano')
  · **cliente sabe:** O parágrafo abaixo explica que ajuda e cota são COPIADAS para o ponto na entrada e que mudar aqui não altera o que já foi combinado — o par exato do aviso que está em Pontos. Falta: existe POST…

**[ATUALIZADO 22/09/2026 — rodada Financeiro, `docs/PENDENCIAS.md` seção N. As cinco entradas abaixo (Cobranças, Comissões, Devoluções, Repasses, Custos fixos) descrevem o admin ANTES da reorganização — mantidas como registro histórico do que existia; o estado atual está nos parágrafos "ATUALIZADO" logo abaixo de cada uma. Refazer a auditoria completa das 387 funções está fora do escopo desta rodada.]**

**Cobranças** — `renderCobrancas(el)` (linha 1523, ANTES da rodada). Pagamentos confirmados e emissão de nota fiscal. Dois KPIs (Total confirmado / Notas por emitir). Tabela: ID, Anunciante, Valor, Data e Nota fiscal — quando `nota_fiscal_status='emitida'`, selo verde + link 'ver PDF';…
  · `public/admin/index.page.js`, `src/financeiro/routes.js`, `src/financeiro/san-checkout.js` · rotas: `GET /admin/cobrancas (src/financeiro/routes.js:327)`, `PATCH /admin/cobrancas/:id/nota-fiscal (src/financeiro/routes.js:337, uploadNota.single('arquivo'))` · papéis: admin, anunciante
  · ← Visão geral (alerta 'nota(s) fiscal(is) por emitir')  → Visão geral (faturamentoPorMes = gráfico de 6 meses; notas pendentes = fila 'notas') / Comissões (a comissão nasce da cobrança confirmada) / Métrica (funil, coluna pagamentos)
  · **cliente sabe:** A dica diz 'Selecionar o PDF já envia a nota'. Não diz que a emissão da nota em si é manual e fora do sistema, nem que a cobrança só aparece aqui se o webhook chegou — o admin que ficar esperando uma…
  · **ATUALIZADO:** virou `renderHistoricoCobrancas(el)`, drill-down oculto em `#financeiro/cobrancas` (fora da sidebar). Toda a UI de nota fiscal manual (KPI 'Notas por emitir', upload de PDF, filtro Sem nota/Com nota) foi removida — tela agora é histórico puro (ID/Anunciante/Valor/Data). `PATCH .../nota-fiscal` continua no backend sem chamador.

**Comissões** — `renderComissoes(el)` (linha 1559, ANTES da rodada). KPI 'Total a pagar' mais até três KPIs, um por vendedor (agrupamento client-side em `porVendedor`, mostrando total, quantidade e a chave Pix — ou 'sem chave Pix'). Tabela: Vendedor, Anunciante, Venda (`valor_confirmado`),…
  · `public/admin/index.page.js`, `src/financeiro/routes.js` · rotas: `GET /admin/comissoes (src/financeiro/routes.js:384)`, `PATCH /admin/comissoes/:id (src/financeiro/routes.js:396)` · papéis: admin, vendedor
  · ← menu, grupo Financeiro (sem contador no menu — comissão em aberto não vira alerta na Visão geral)  → painel do vendedor em /anunciante/vendedor.html
  · **cliente sabe:** A dica diz 'Marcar como paga só registra aqui — o Pix é feito por fora'. O que a tela não diz: quando o KPI mostra 'sem chave Pix', a correção é na aba Vendedores — aqui a coluna Pix não é editável,…
  · **ATUALIZADO:** virou `renderFilaComissoes(el)`, drill-down oculto em `#financeiro/comissoes`, filtrado só a `!pago_em` (fila, não histórico). Contador na Visão geral agora existe: `financeiro.comissoesPendentes`.

**Devoluções (arrependimentos)** — `renderArrependimentos(el)` (linha 1601, ANTES da rodada). Quem desistiu da contratação dentro dos 7 dias da lei. KPI 'A devolver' com o total em aberto. Tabela: Protocolo, Anunciante (+ e-mail), CPF/CNPJ, Valor a estornar, Pedido em, Situação (selo 'a devolver' ou 'devolvido…
  · `public/admin/index.page.js`, `src/titular/routes.js` · rotas: `GET /admin/arrependimentos (src/titular/routes.js:146)`, `POST /admin/arrependimentos/:id/estornado (src/titular/routes.js:150) — mas a tela chama com PATCH` · papéis: admin, anunciante
  · ← Visão geral (alerta urgente)  → Visão geral (alerta urgente 'devolução(ões) por arrependimento a pagar' — a única fila com prazo legal correndo)
  · **cliente sabe:** A dica e o comentário do código explicam certo o fluxo de duas mãos. Mas a aba está QUEBRADA: o handler faz `salvar('/admin/arrependimentos/${id}/estornado', {comprovante})` e `salvar()` (linha 34)…
  · **ATUALIZADO:** virou `renderFilaDevolucoes(el)`, drill-down oculto em `#financeiro/devolucoes`, filtrado só a `status === 'pendente'`. **O BUG do parágrafo acima foi corrigido de passagem nesta rodada** (a reescrita chama `api()` com `method: 'POST'` direto, batendo com a rota — não usa mais `salvar()`).

**Repasses de ponto** — nova fila, não existia como aba antes desta rodada (o extrato por ponto já existia em `/admin/pontos/:pontoId/pagamentos`, sem visão agregada "quem devo pagar este mês"). `renderFilaRepasses(el)`, drill-down oculto em `#financeiro/repasses`, lê `GET /admin/pagamentos-ponto/pendentes` (`listarPendentesDoMes()`, `src/pontos/pagamentos-repository.js`) — só pontos com `valor_pago_mensal > 0` e sem lançamento pago no mês. Botão único por linha: 'Pagar' (lança já quitado) ou 'Marcar como pago' (quita lançamento existente), refaz `RESUMO` e some da fila na hora.
  · ← Visão geral (pendência 'repasse(s) de ponto pendente(s)')  → nenhum lugar (fim da linha; o histórico completo por ponto continua em `/admin/pontos/:pontoId/pagamentos`, sem tela própria)

**Custos fixos** — `renderCustos(el)` (linha 1039, ANTES da rodada). Três KPIs: 'Custos fixos ativos' (somado no cliente, só os `ativo`), 'Amortização das telas' (lido de `RESUMO.financeiro.amortizacaoMensal`, com a legenda 'vem do custo de cada tela (aba Telas)') e 'Ajuda de custo aos pontos'…
  · `public/admin/index.page.js`, `src/admin/routes.js` · rotas: `GET /admin/custos-fixos (src/admin/routes.js:198)`, `POST /admin/custos-fixos (src/admin/routes.js:202)`, `PATCH /admin/custos-fixos/:id (src/admin/routes.js:211)`, `DELETE /admin/custos-fixos/:id (src/admin/routes.js:222)` · papéis: admin
  · ← Visão geral (link 'editar →' no cartão 'Custos fixos')  → Visão geral (custosFixosMensal entra na margem) / Métrica (coluna 'Fixos' da margem mês a mês)
  · **cliente sabe:** Sim: a dica diz 'Custo anual? Lance o valor ÷ 12', e os KPIs de amortização e ajuda de custo trazem, na legenda, a aba de onde vêm — é a única aba do painel que aponta explicitamente para as outras…
  · **ATUALIZADO:** a aba deixou de existir (nem oculta — sem hash nenhum aponta pra ela). Função renomeada `_renderCustos` (lint: código morto, mantido por convenção, sem chamador). Rotas de `/admin/custos-fixos*` e as tabelas continuam intactas no backend. `margemMensal`/`custosFixosMensal`/`amortizacaoMensal`/`custoPontosMensal` continuam calculados em `GET /admin/resumo`, sem exposição em UI nenhuma (conferido: nenhuma outra tela os lia).

**Eventos pendentes** — `renderEventos(el)` (linha 1655). A fila de reconciliação manual do San Checkout: webhooks que não deram para correlacionar sozinhos ou eventos sem ação automática. Tabela crua, sem `caixaTabela` (sem busca, sem chips, sem ordenação): ID, Motivo, Quando (data…
  · `public/admin/index.page.js`, `src/financeiro/routes.js`, `src/financeiro/san-checkout.js` · rotas: `GET /admin/eventos-pendentes (src/financeiro/routes.js:312)`, `PATCH /admin/eventos-pendentes/:id (src/financeiro/routes.js:319)` · papéis: admin
  · ← Visão geral (alerta urgente 'evento(s) de pagamento pra revisar')  → Cobranças e Anunciantes — mas só na cabeça do admin: 'Marcar resolvido' NÃO cria cobrança, não ativa conta e não credita nada
  · **cliente sabe:** NÃO. O subtítulo só diz 'Eventos do San Checkout que não deram pra correlacionar sozinhos'. A tela não diz o que o admin deve FAZER com o payload antes de marcar resolvido — não há link para a conta…

**Estados sem tela:** Pagamento ao dono do ponto (RN-20, migration 022) não tem aba nenhuma. Existem GET /admin/pontos/:pontoId/pagamentos,… · POST /admin/anunciantes/:id/cancelar-assinatura (src/financeiro/routes.js:294) não tem botão em lugar nenhum. É… · POST /admin/planos-ponto (src/pontos/routes.js:149) cria uma opção de comodato nova; a aba 'Opções de comodato'… · GET /admin/pontos-offline (src/admin/routes.js:185) devolve a lista pronta de telas sem sinal e nunca é consumida — a… · GET /admin/pontos/:pontoId/dispositivos (src/dispositivos/routes.js:17) não é usado: a aba Telas baixa… · POST /admin/pontos/:id/aparelho (src/pontos/routes.js:137) gera chave no nível do PONTO — legado anterior à migration… · `anunciantesAtivosPagantes` e `anunciantesEmCortesia` são calculados e devolvidos por GET /admin/resumo e não aparecem… · Campos de contrato de plano sem coluna na aba Planos: `tier`, `frequencia_hora`, `cobertura` e `valor_mensal_cheio`. São… · Não há desarquivar plano nem excluir plano: a aba Planos arquivados é 100% leitura e o próprio rodapé diz que o drop é… · Não há tela para trocar a senha de um anunciante: POST /admin/anunciantes devolve `senhaGerada` uma única vez num… · Não há tela para o usuário/senha do próprio admin: vêm de ADMIN_USER/ADMIN_PASSWORD no ambiente — e esses são… · Criativo com status 'reprovado' fica sem tela em 'Meus anúncios': 'Tirar do ar' grava reprovado e a lista (que só pede…

**Notas:**
- ~~BUG que trava uma fila legal~~ — **CORRIGIDO na rodada Financeiro (22/09/2026)**: em renderArrependimentos (agora `renderFilaDevolucoes`) o botão 'Registrar devolução' chamava `salvar('/admin/arrependimentos/${id}/estornado', {comprovante})`, e `salvar()` era fixo em `method: 'PATCH'` contra uma rota `POST`. A reescrita da fila passou a chamar `api()` com `method: 'POST'` direto, batendo com a rota — corrigido de passagem, não era o objetivo da rodada.
- BUG em 'Meus anúncios': renderMeusAnuncios (linha 466) faz `pegar('/admin/criativos')` sem query string; o servidor (src/admin/routes.js:16) usa `req.query.status || 'pendente'`. Como criativo subido pelo admin nasce `status: 'aprovado'` (`peloOperador` em src/anunciantes/routes.js:285), a tabela…
- DEPENDÊNCIA OCULTA #1 — Anunciantes ⇄ (inexistente) cancelamento: o 409 de POST /admin/anunciantes/:id/liberar-plano diz 'cancele a assinatura antes de liberar cortesia'. Não há botão de cancelar assinatura em aba alguma. O admin recebe uma instrução impossível de cumprir pelo painel.
- DEPENDÊNCIA OCULTA #2 — Benefícios → Planos: quem desmarca/edita um benefício na aba Benefícios salva na hora. Quem marca o mesmo benefício DENTRO da aba Planos está mexendo em campo de CONTRATO (`beneficio_ids` está em CAMPOS_CONTRATO, src/financeiro/planos-repository.js:117) e precisa publicar…
- DEPENDÊNCIA OCULTA #3 — Pontos → Telas: '+ tela' cria o dispositivo SEM chave de aparelho. A única pista é o toast 'Tela criada — gere a chave dela na aba Telas' (que some em 1,8s); a tela fica na lista de Telas com o chip 'Sem chave', mas o alerta da Visão geral ('tela(s) ativas sem dar sinal')…
- DEPENDÊNCIA OCULTA #4 — Candidaturas → Telas: 'Liberar na conta' (POST /admin/candidaturas/:id/liberar) cria o ponto E a Tela 1 dentro de uma transação, também sem chave. O confirm menciona a criação, mas nada leva o admin para gerar a chave, e a tabela de Candidaturas não volta a falar do assunto.
- DEPENDÊNCIA OCULTA #5 — Anunciantes → Fila de criativos: 'Subir anúncio' entra JÁ APROVADO e pula a fila; a fila de criativos, cujo chip default é 'Em análise', nunca mostra essas peças. Nem a aba Anunciantes nem a Fila de criativos dizem isso (só o subtítulo da aba Anunciantes, de passagem: 'já…
- DEPENDÊNCIA OCULTA #6 — Comissões → Vendedores: o KPI por vendedor mostra 'sem chave Pix' quando falta a chave, e a coluna 'Chave Pix' da tabela de Comissões é só leitura. O lugar de corrigir é a aba Vendedores, e nada na tela de Comissões aponta para lá.
- DEPENDÊNCIA OCULTA #7 — Pontos/Anunciantes → Categorias: os dois selects de segmento/ramo ficam com uma única opção '—' se nenhuma categoria estiver `ativo`. Nenhuma das duas abas menciona Categorias.
- DEPENDÊNCIA OCULTA #8 — Opções de comodato → Planos: o select 'Bônus: plano de anúncio' fica só com '— sem bônus —' se não houver plano; e o módulo inverso ('Tela após N meses') mora na aba Planos. As duas abas se referem uma à outra em prosa, mas nenhuma é clicável.
- DEPENDÊNCIA OCULTA #9 — Eventos pendentes é um beco sem saída: 'Marcar resolvido' só grava `resolvido = true`. Não cria cobrança, não ativa conta, não credita nada, e não há link para o anunciante do payload. Todo o trabalho real é manual e fora do painel, e a tela não diz qual é.
- Texto de ajuda obsoleto na aba Planos: o parágrafo final explica 'Mín. telas' e 'meses grátis' como se fossem campos da tela. As colunas `planos.minimo_telas_ativas` e `planos.meses_gratis` foram DERRUBADAS pela migration src/db/migrations/021_remove_cobertura_adiada.sql (linhas 24-25). O texto…


---

## Tela e player

TELA / PLAYER — a TV no ponto. Superfície sem pessoa logada: `public/player.html` é uma página isolada (não carrega `layout.js`, não tem nav, `<meta name="robots" content="noindex">` duplicado), servida pelo mesmo Express de `src/server.js` a partir de `public/`. A unidade é o DISPOSITIVO (tela), não o ponto — migration `019_v2_contas_dispositivos_convites_planos.sql` criou a tabela `dispositivos` e moveu chave de aparelho, PIN, sinal e custo do ponto para lá. Uma tela = uma chave = uma playlist. Backend: `src/playlist/routes.js` (1 rota), `src/player/routes.js` (2 rotas), `src/dispositivos/routes.js` (9 rotas, incluindo o `POST /player/:dispositivoId/painel`), cálculo puro em…

**Boot do player e identificação da tela** — `public/player.page.js` linhas 1-30: lê `?tela=` (aceita os aliases legados `?dispositivo=` e `?ponto=`) e passa por `.replace(/\D/g,'')` — só dígitos, porque o id entra em URL e no innerHTML do painel. Monta três chaves de storage por tela:…
  · `public/player.html`, `public/player.page.js`, `public/config.js` · rotas: `GET /player.html` · papéis: tela (aparelho, sem pessoa)
  · ← link gerado no admin: linkDoPlayer() em public/admin/index.page.js:648  → GET /playlist/:dispositivoId / POST /player/:dispositivoId/heartbeat
  · **cliente sabe:** Só no rodapé de debug `#msg` (monospace 12px, cinza #444, canto inferior esquerdo): 'api: <URL>', 'playlist ok (N itens)', 'sem anúncios programados agora', 'offline — tocando playlist em cache'.…

**Chave de aparelho (autenticação de máquina)** — `src/lib/aparelho.js` exporta `exigirAparelho(req,res,next)`: carrega `dispositivosRepo.buscarComPonto(req.params.dispositivoId)` (404 'tela não encontrada'), lê a chave de `req.headers['x-aparelho-id']` OU `req.query.chave`, e compara com…
  · `src/lib/aparelho.js`, `src/dispositivos/repository.js`, `public/player.page.js` · rotas: `POST /admin/dispositivos/:id/chave`, `GET /playlist/:dispositivoId`, `POST /player/:dispositivoId/played`, `POST /player/:dispositivoId/heartbeat` · papéis: tela, admin
  · ← botão 'Gerar chave' / 'Trocar' na aba Telas do admin (public/admin/index.page.js:707-713)  → req.dispositivo consumido por gerador.gerarPlaylistDaHora e dispositivosRepo.marcarOnline
  · **cliente sabe:** Sim, ao admin: `confirm('Gerar uma chave nova? A TV que está usando a chave atual para de funcionar até você abrir o link novo nela.')` e depois um `prompt('Abra este link no navegador da TV (ele…

**Geração da playlist da hora** — `src/playlist/gerador.js:gerarPlaylistDaHora(dispositivo, hora)` — trunca a hora (`setMinutes(0,0,0)`), calcula `horaAnterior`, e roda três buscas em paralelo: `anunciantesElegiveis(dispositivo.categoria_id, dispositivo.dono_conta_id)`,…
  · `src/playlist/gerador.js`, `src/playlist/routes.js`, `src/dispositivos/repository.js` · rotas: `GET /playlist/:dispositivoId` · papéis: tela
  · ← poll do player a cada 15 min  → cache em memória de src/playlist/routes.js / exibicoes_contador.vezes_programadas
  · **cliente sabe:** Não diretamente. O anunciante vê o resultado agregado no painel (exibições programadas x confirmadas); o dono do ponto vê o mesmo por tela em /anunciante/ponto.html. A regra de elegibilidade só está…

**Revezamento entre criativos da mesma conta — FURO CORRIGIDO (19/09/2026)** — no fim de `gerarPlaylistDaHora`, cada ocorrência do id do anunciante em `daHora.itens` pega `criativos[vez % criativos.length]`, `vez` incrementando a partir de `usados[id] || 0`. Até 19/09/2026 esse `usados` nascia zerado TODA hora — pra conta que só cabe 1 inserção por hora (plano pequeno, começo de conta), `criativos[0]` (o mais novo — `anunciantesElegiveis` traz `array_agg(... ORDER BY c.created_at DESC)`) ganhava a vaga toda hora, pra sempre, e qualquer criativo mais antigo NUNCA era escolhido. Relatado pelo dono como "rodou uma vez e não rodou mais" — não era limitação de imagem (imagem já virava vídeo de verdade, com duração real, bem antes deste ponto), era o ponto de partida do revezamento sempre voltar pro mesmo lugar. Corrigido girando o início por hora: `inicio = horaEpoch % criativos.length`, `criativos[(inicio + vez) % criativos.length]` — ao longo de `criativos.length` horas, todo criativo passa pela vaga pelo menos uma vez, mesmo com 1 inserção por hora.
  · `src/playlist/gerador.js` · rotas: `GET /playlist/:dispositivoId` · papéis: tela
  · **cliente sabe:** Não. Sem métrica nem aviso nenhum de "este criativo está sem rodar" — só dá pra perceber comparando "Exibições por ponto"/"por dia" no painel ao longo de várias semanas, e mesmo assim sem indicar qual criativo específico.

**Elegibilidade e bloqueio de concorrente** — `anunciantesElegiveis(categoriaDoPonto, excluirContaId)` em `src/playlist/gerador.js`: `FROM anunciantes a LEFT JOIN planos p ON p.id = a.plano_id JOIN criativos c ON c.anunciante_id = a.id AND c.status='aprovado'`, com `WHERE a.status='ativo' AND…
  · `src/playlist/gerador.js`, `tests/pacing.test.js` · rotas: `GET /playlist/:dispositivoId` · papéis: tela, admin
  · ← cadastro do anunciante (categoria_id) e aprovação do criativo no admin  → entrada do calcularPlaylist
  · **cliente sabe:** Sim, como promessa comercial: public/pontos.html ('Cada ponto é um lugar...'), e a aba Categorias do admin explica 'é o que impede concorrente direto na mesma tela'. O anunciante não é avisado de…

**Pacing — frequência por hora, direta** — **Mudou em 15/09/2026 (migration 037), pedido do dono.** O plano vende 'vezes por hora' (`planos.frequencia_hora`), sem conversão nenhuma por horário do ponto: `frequenciaBase` em `gerarPlaylistDaHora` é o próprio `frequencia_hora`. A função `horasAbertoPorDia` (que convertia 'por dia' em 'por hora' usando `horario_abertura`/`horario_fechamento`, caindo em 12h por padrão) foi removida — o mesmo valor roda em qualquer ponto, aberto 8h ou 12h.
  · `src/lib/pacing.js`, `src/playlist/gerador.js`, `tests/pacing.test.js` · rotas: `GET /playlist/:dispositivoId` · papéis: tela
  · ← cadastro do ponto e edição do plano no admin  → contarPorAnunciante → gravarProgramados
  · **cliente sabe:** /planos.html vende 'X vezes por hora' direto, com um "≈Nx por dia" ao lado, claramente rotulado como estimativa ("num comércio aberto 12h") — o valor que aparece é exatamente o que roda, sem conversão escondida.

**Compensação de déficit da hora anterior** — `deficitHoraAnterior(dispositivoId, horaAnterior)` roda `SELECT anunciante_id, GREATEST(vezes_programadas - vezes_confirmadas, 0) AS deficit FROM exibicoes_contador WHERE dispositivo_id=$1 AND janela_hora=$2` e devolve um mapa. O déficit entra somado à…
  · `src/playlist/gerador.js`, `src/lib/pacing.js`, `tests/pacing.test.js` · rotas: `GET /playlist/:dispositivoId`, `POST /player/:dispositivoId/played` · papéis: tela
  · ← confirmarExibicao da hora anterior  → playlist da hora corrente
  · **cliente sabe:** Não. Nem o anunciante nem o dono do ponto veem 'você ficou devendo N exibições e elas foram repostas'. O painel mostra só as colunas Programadas e Confirmadas lado a lado — a diferença é o déficit,…

**Teto de 200 slots por hora** — `LIMITE_SLOTS_PROGRAMADOS = 200` em `src/lib/pacing.js` (comentário: 'trava de segurança (SPEC módulo 3, de 240 slots/hora)'). Aplicado no fim de `calcularPlaylist`, DEPOIS do embaralhamento: `if (itens.length > LIMITE_SLOTS_PROGRAMADOS) itens =…
  · `src/lib/pacing.js`, `tests/pacing.test.js`, `docs/funcional.md` · rotas: `GET /playlist/:dispositivoId` · papéis: tela
  · ← soma de frequências + déficits de todos os anunciantes elegíveis  → exibicoes_contador.vezes_programadas
  · **cliente sabe:** Só em docs/funcional.md §4, estado 'Lista longa' do Player: 'o gerador corta em 200 slots por hora (trava de segurança)'. Nenhuma tela mostra isso, e nenhum alerta avisa o admin quando o teto começa…

**Cota de autoanúncio do dono do ponto** — `criativosDoDono(contaId)` busca `arquivo_normalizado_url` + `duracao_segundos` dos criativos aprovados da conta dona do ponto, `ORDER BY created_at DESC LIMIT 3`. `dividirCota(cotaDoPonto, telasAtivas)` em `src/lib/pacing.js` faz `Math.ceil(cota/telas)`…
  · `src/playlist/gerador.js`, `src/lib/pacing.js`, `public/player.page.js` · rotas: `GET /playlist/:dispositivoId` · papéis: tela, dono do ponto
  · ← opção de comodato escolhida no cadastro do ponto; editável no admin aba Pontos  → itens da playlist sem cobrança e sem contador
  · **cliente sabe:** Sim em texto comercial: public/comodato.html ('Cota ampliada de autoanúncio'), public/seja-um-ponto.html, public/index.html ('o triplo de espaço na tela'). E no admin: 'A cota é dividida entre as…

**Cache da playlist em memória do processo** — `src/playlist/routes.js`: `const cache = new Map()` com chave `${id}-${hora.toISOString()}`. Em cada `GET /playlist/:dispositivoId`, se a chave não existe, apaga todas as entradas antigas daquela tela (`for (const k of cache.keys()) if…
  · `src/playlist/routes.js`, `CONSTRAINTS.md` · rotas: `GET /playlist/:dispositivoId` · papéis: tela
  · ← poll de 15 min do player  → resposta JSON ao player
  · **cliente sabe:** Não. É invisível.

**Cache offline da playlist (localStorage)** — `carregarCache()` / `salvarCache(lista)` em `public/player.page.js` gravam o JSON inteiro da playlist em `localStorage['mostrai-playlist-<id>']`, dentro de try/catch. No boot o player toca o cache ANTES de falar com o servidor (`playlist = carregarCache();…
  · `public/player.page.js` · rotas: `GET /playlist/:dispositivoId` · papéis: tela
  · ← resposta 200 da playlist  → tocarProximo()
  · **cliente sabe:** Sim, ao admin/dono, em documento: RUNBOOK.md §8 ('as telas continuam tocando a playlist em cache até o próximo ciclo' se o Northflank cair) e docs/funcional.md §7 ('TV sem internet → toca o cache e…

**Cache offline dos arquivos de vídeo (Cache API)** — Bloco 'Cache de arquivos' em `public/player.page.js`, cache nomeado `mostrai-midia-<id>`. `garantirNoCache(url)` abre o cache, sai se `cache.match(url)` já tem, senão `fetch(url,{mode:'cors'})` e `cache.put`. `prepararArquivos(lista)` reconstrói o Set…
  · `public/player.page.js`, `docs/erros/2026-09-saida-de-video-sem-cache.md`, `src/server.js` · rotas: `GET no Supabase Storage (arquivo_normalizado_url)` · papéis: tela
  · ← itens da playlist com campo url  → videoEl.src
  · **cliente sabe:** Não ao dono do ponto. Ao operador, só em docs/erros/ e no CONSTRAINTS.md ('mitigação (cache de arquivo no player) está na v2').

**Rotação e tolerância a falha de item** — `tocarProximo()` em `public/player.page.js`: se o painel estiver aberto, reagenda em 2s; se a playlist estiver vazia, marca `body.sem-playlist` e reagenda em 5s; pega `playlist[indice]`, avança com `indice = (indice+1) % playlist.length` (loop circular…
  · `public/player.page.js`, `public/player.css` · rotas: `—` · papéis: tela
  · ← atualizarPlaylist / cache  → POST /player/:dispositivoId/played
  · **cliente sabe:** Não. O 'item falhou — pulando' fica no `#msg` de debug, que ninguém monitora remotamente.

**Confirmação de exibição (played)** — Cliente: em cada troca de vídeo, se `item.anuncianteId` existir, `fetch POST ${API_BASE_URL}/player/${dispositivoId}/played` com `X-Aparelho-Id` e `{anuncianteId}`, fire-and-forget (`.catch(()=>{})`) pra não travar a exibição. Servidor:…
  · `src/player/routes.js`, `src/playlist/gerador.js`, `public/player.page.js` · rotas: `POST /player/:dispositivoId/played` · papéis: tela
  · ← tocarProximo()  → exibicoes_contador.vezes_confirmadas → painel do anunciante, painel da tela, painel do dono do ponto, comprovante de veiculação (CSV)
  · **cliente sabe:** Sim, no resultado: painel do anunciante (exibições + CSV de comprovante de veiculação), painel do dono do ponto em /anunciante/ponto.html ('exibições confirmadas pela própria tela') e painel da tela…

**Heartbeat e alerta de tela sem sinal** — Cliente: `heartbeat()` chama `POST /player/${dispositivoId}/heartbeat` no boot e a cada 5 min. Servidor: `src/player/routes.js` → `dispositivosRepo.marcarOnline(id)` → `UPDATE dispositivos SET ultima_vez_online = now()`. Leitura: `HORAS_OFFLINE_ALERTA = 2` em…
  · `src/player/routes.js`, `src/dispositivos/repository.js`, `src/admin/routes.js` · rotas: `POST /player/:dispositivoId/heartbeat`, `GET /admin/resumo`, `GET /admin/pontos-offline`, `GET /anunciantes/:id/dispositivos` · papéis: tela, admin, dono do ponto
  · ← timer de 5 min do player  → badge 'sem sinal' no admin e no painel do dono do ponto
  · **cliente sabe:** Sim ao dono do ponto (card da tela com o tempo desde o último sinal) e ao admin (badge + alerta). NÃO existe alerta que saia da tela do admin — RUNBOOK.md §6 registra como pendência de Estação 6:…

**Painel da tela por PIN (na própria TV)** — Abertura: `#alvoPainel` é um alvo invisível de 18vmin x 18vmin no canto superior direito (player.css); 5 cliques em 3s (`toques = toques.filter(t => agora - t < 3000).concat(agora)`) ou a tecla `p`/`P` chamam `abrirPainel()`, que pausa o vídeo, seta…
  · `public/player.page.js`, `public/player.css`, `src/dispositivos/routes.js` · rotas: `POST /player/:dispositivoId/painel` · papéis: quem está fisicamente na frente da TV (dono do ponto, na prática)
  · ← 5 toques no canto superior direito ou tecla P  → painelDaTela(dispositivoId): {porAnunciante, porDia}
  · **cliente sabe:** Só em dois lugares, ambos internos: a dica da aba Telas do admin ('O PIN abre o painel da tela na própria TV (5 toques no canto superior direito ou tecla P) — só mostra o que rodou nela, nada mais')…

**Definição do PIN** — `POST /admin/dispositivos/:id/pin` em `src/dispositivos/routes.js`: valida `/^\d{4,6}$/` (400 'PIN precisa ter de 4 a 6 dígitos'), `null` limpa; `repo.definirPin(id, pin)` grava `gerarHash(String(pin))` em `dispositivos.pin_hash`. `CAMPOS_PUBLICOS` do…
  · `src/dispositivos/routes.js`, `src/dispositivos/repository.js`, `public/admin/index.page.js` · rotas: `POST /admin/dispositivos/:id/pin` · papéis: admin
  · ← aba Telas do admin  → POST /player/:dispositivoId/painel
  · **cliente sabe:** Ao admin sim, pelo texto do prompt. Ao dono do ponto: não existe caminho — docs/funcional.md §3 afirma que /anunciante/ponto.html permite 'definir PIN', mas não há rota nem UI para isso; o PIN só se…

**Link do player e instalação da TV** — `linkDoPlayer(telaId, chave)` em `public/admin/index.page.js:648` monta `${window.location.origin}/player.html?tela=${telaId}&chave=${encodeURIComponent(chave)}`. Depois de 'Gerar chave', um `prompt` mostra o link pronto; com chave já existente, o botão…
  · `public/admin/index.page.js`, `docs/PENDENCIAS.md`, `CONSTRAINTS.md` · rotas: `POST /admin/dispositivos/:id/chave`, `GET /player.html` · papéis: admin (quem instala é o próprio dono do negócio)
  · ← botão '+ tela' na aba Pontos → 'Gerar chave' na aba Telas  → boot do player na TV
  · **cliente sabe:** RESPOSTA DIRETA À PERGUNTA: quem instala a TV recebe instrução de dois lugares, os dois internos e nenhum é uma tela pensada pra isso — (1) a frase de rodapé da aba Telas do admin, em…

**Orientação da tela (giro por CSS)** — `public/player.css`: `#stage` é `position: fixed; top:50%; left:50%; width:100vh; height:100vw; transform: translate(-50%,-50%) rotate(90deg)` — o painel físico fica deitado (1920x1080) e o giro é por CSS, sem mexer em hardware. `?orientacao=paisagem`…
  · `public/player.css`, `public/player.page.js`, `src/lib/ffmpeg.js` · rotas: `GET /player.html?orientacao=paisagem` · papéis: tela
  · ← query string do link  → —
  · **cliente sabe:** Só em docs/PENDENCIAS.md item 13. O admin não oferece um botão nem um campo de orientação por tela — quem instalar precisa saber digitar o parâmetro na URL.

**Estado vazio da tela** — Quando a playlist volta com 0 itens, `atualizarPlaylist` faz `document.body.classList.toggle('sem-playlist', !nova.length)` e loga 'sem anúncios programados agora'. `body.sem-playlist #vazio { display: flex }` mostra `#vazio` com `/img/simbolo-lampada.png` a…
  · `public/player.css`, `public/player.page.js`, `public/player.html` · rotas: `—` · papéis: tela
  · ← atualizarPlaylist / tocarProximo  → —
  · **cliente sabe:** docs/funcional.md §4 promete 'tela institucional do Mostraí, nunca tela preta' e §7 repete 'tela institucional'. O que existe é a lâmpada a 50% de opacidade sobre preto — não é uma peça…

**Admin — aba Telas (CRUD de dispositivo)** — `renderTelas(el)` em `public/admin/index.page.js:650+` monta a tabela com colunas Ponto/Apelido/Status/Último sinal/Chave-link do player/PIN/Custo/Meses/Amortização-mês/Instalada em. Rotas por trás: `GET /admin/dispositivos` (`repo.listarTodos`, com JOIN em…
  · `src/dispositivos/routes.js`, `src/dispositivos/repository.js`, `public/admin/index.page.js` · rotas: `GET /admin/dispositivos`, `GET /admin/pontos/:pontoId/dispositivos`, `POST /admin/pontos/:pontoId/dispositivos`, `PATCH /admin/dispositivos/:id` · papéis: admin
  · ← aba Pontos (botão '+ tela' e link 'N/M no ar')  → link do player → boot na TV / eventos 'tela:dispositivo_ativa' → aba Métrica
  · **cliente sabe:** Sim, dentro do admin: dica da aba ('Uma tela = um link do player + uma playlist. Custo e prazo alimentam a amortização da visão geral.') e tooltip do botão de excluir ('Só se nunca rodou nada').

**Painel da tela pelo dono do ponto (web, não na TV)** — `GET /anunciantes/:id/dispositivos` (src/dispositivos/routes.js) devolve as telas dos pontos da conta com `exibicoes_30d` e `anunciantes_30d`; `GET /anunciantes/:id/dispositivos/:dispositivoId/painel` confirma a posse (`JOIN pontos p ON p.id = d.ponto_id…
  · `src/dispositivos/routes.js`, `public/anunciante/ponto.page.js` · rotas: `GET /anunciantes/:id/dispositivos`, `GET /anunciantes/:id/dispositivos/:dispositivoId/painel` · papéis: dono do ponto
  · ← /anunciante/ponto.html  → —
  · **cliente sabe:** Sim: 'Últimos 30 dias · N exibições confirmadas pela própria tela.' e 'Nenhuma tela instalada ainda — assim que a gente instalar, ela aparece aqui.'

**Estados sem tela:** Instrução de instalação física da TV. Não existe tela, página nem documento entregável. As duas únicas cópias são… · O que o dono do ponto faz quando a tela apaga. Ele tem o card 'sem sinal' em /anunciante/ponto.html mas nenhuma… · Definir PIN pelo dono do ponto. docs/funcional.md §3 lista 'definir PIN' como ação de /anunciante/ponto.html — não… · Tela institucional do player vazio. docs/funcional.md §4 e §7 prometem 'tela institucional do Mostraí, nunca tela… · Mensagem de chave inválida. docs/funcional.md §4/§7 promete 'tela não autorizada — fale com o Mostraí'; o texto real no… · Déficit não tem nome em nenhuma interface. O painel mostra Programadas e Confirmadas; ninguém explica que a diferença é… · Teto de 200 slots não avisa ninguém quando começa a cortar. Não há alerta no admin, nem log, nem campo no painel — o… · Autoanúncio do dono não aparece em lugar nenhum. `delete contagem.dono` remove o autoanúncio do contador, então o dono… · Alerta de tela sem sinal não sai da tela do admin. RUNBOOK.md §6 registra como pendência da Estação 6: falta alerta… · Campo de orientação por tela. O giro só se controla digitando ?orientacao=paisagem na URL; o admin não tem o campo.

**Notas:**
- `exigirAparelho` (src/lib/aparelho.js) não olha `dispositivo.status` nem `ponto_status`, embora `buscarComPonto` traga os dois. Uma tela marcada 'inativo' ou 'reparo', ou de um ponto inativo, continua recebendo playlist, gravando `vezes_programadas` e confirmando exibição. O anunciante é creditado…
- O déficit acumula em cascata. `deficitHoraAnterior` lê só a hora imediatamente anterior, mas o programado dessa hora já inclui o déficit dela: TV offline com base 3 gera 3 → 6 → 12 → 24… até bater no teto de 200. Quando a tela volta, a hora seguinte pode vir com a playlist inteira de um anunciante…
- O teto de 200 é aplicado depois do embaralhamento, com `itens.slice(0, 200)`. O corte é aleatório e sem proporcionalidade: com a rede cheia, um anunciante pode terminar a hora com muito menos que a frequência contratada, e outro com tudo. `contarPorAnunciante` roda sobre a lista já cortada, então o…
- `gravarProgramados` usa `ON CONFLICT ... DO UPDATE SET vezes_programadas = $5` (sobrescreve). Como o cache da playlist é em memória do processo (src/playlist/routes.js), todo restart do container dentro da mesma hora regenera a playlist com novo embaralhamento e reescreve `vezes_programadas`,…
- `repo.deletar(id)` faz `DELETE FROM exibicoes_contador WHERE dispositivo_id = $1` antes de apagar a tela. Isso apaga o histórico de exibição que é a base do comprovante de veiculação do anunciante. O admin só avisa por tooltip ('Só se nunca rodou nada'); não há guarda no servidor nem confirmação.
- `POST /player/:dispositivoId/painel` vive em src/dispositivos/routes.js e não usa `exigirAparelho` — reimplementa a checagem à mão (`req.headers['x-aparelho-id']`, sem aceitar `?chave=`, sem o 404 de tela inexistente). Duas implementações da mesma autenticação de máquina, com comportamentos…
- A comparação da chave de aparelho é `String(enviada) !== dispositivo.aparelho_id`, não em tempo constante — inconsistente com a regra da casa, que usa `segredoConfere` (src/lib/segredo.js) no login do admin e no HMAC do webhook. Com 128 bits de entropia o risco prático é baixo, mas é a mesma classe…
- O player não usa `duracaoSegundos`. O campo é gerado por `src/lib/ffmpeg.js` (caso especial de imagem: vira vídeo com `-loop 1 -t`, duração = teto do plano do anunciante — `DURACAO_PADRAO_IMAGEM = 10` só entra sem plano, 19/09/2026), devolvido pela playlist e documentado em docs/api.md — mas a troca de vídeo é 100% por evento `ended`. O contrato promete um controle que o player ignora.
- `public/player.css` estiliza `#stage img` e `#stage img.ativo`, mas `public/player.html` só tem `<video>`. Resquício de quando imagem tocava como imagem; hoje o ffmpeg converte foto em mp4 com `-loop 1 -t <duração>`.
- O cache de arquivo depende inteiramente da CSP: `src/server.js` monta `connect-src`/`media-src` a partir de `origemDe(process.env.SUPABASE_URL)`. Se essa variável faltar ou mudar de host, `garantirNoCache` e o próprio `<video>` são bloqueados sem erro visível — o player cai no caminho 'toca direto…
- `anunciantesElegiveis` exclui `a.id <> excluirContaId`, ou seja, a conta dona do ponto nunca entra como anunciante PAGANTE na própria tela. Se o dono do ponto também assina plano, o anúncio pago dele não roda na tela dele — só a cota de autoanúncio, que não gera contador. O efeito não está escrito…
- `dividirCota` divide pelo número de telas com status 'ativo' do ponto (`telas_do_ponto` em `buscarComPonto`), mas a playlist é gerada mesmo para tela em 'reparo'/'inativo'. Uma tela em reparo recebe cota calculada como se não existisse, e o dono recebe mais slots do que a cota do ponto no total.


---

## Caminho do dinheiro

Caminho do dinheiro do Mostraí, ponta a ponta: vitrine pública de planos (public/planos.page.js + GET /planos) → início de assinatura (POST /anunciantes/:id/assinar, cria linha em `assinaturas` e devolve o link do San Checkout) → contrato de consulta do Checkout (GET /plano/:assinaturaId, com X-Checkout-Key) → webhook assinado por HMAC (POST /webhook/san-checkout) → dedupe por `chargeId|status` (tabela `webhooks_processados`) → crédito do ciclo numa transação única (`aplicarCicloPago`: estende `anunciantes.data_expiracao`, trava preço, grava `cobrancas_confirmadas`, grava `comissoes`) → rede de segurança diária (`npm run conciliar` → src/financeiro/conciliacao.js) → saídas do dinheiro (nota…

**Vitrine pública de planos** — Lista os planos ativos para o site. Filtra o plano fundador por PROGRAMA_FUNDADOR_ATIVO e por vagas_restantes > 0. `listarAtivos` calcula vagas_restantes chamando `contarVagasOcupadas` por plano.
  · `src/financeiro/routes.js`, `src/financeiro/planos-repository.js`, `public/planos.page.js` · rotas: `GET /planos`, `GET /pontos/fluxo` · papéis: visitante, anunciante
  · ← index.html, layout.js, seja-um-ponto  → /anunciante/cadastro.html?plano=X (deslogado) / /anunciante/painel.html?plano=X (logado)
  · **cliente sabe:** O preço que o cliente vê é o do banco: `render()` mostra o total do ciclo (valor_mensal × meses), o valor por mês, o riscado (mensal do mesmo tier × meses, via `mensalDoTier`) e 'Você economiza X por…

**Versionamento de plano (item 9 / RN-27)** — PATCH só aceita CAMPOS_VITRINE (ativo, destaque_no_site, rotulo, vagas). Campo de CAMPOS_CONTRATO (tier, nome, valor_mensal, valor_mensal_cheio, compromisso_meses, frequencia_hora, cobertura, limite_criativos, preco_travado, fundador, ponto_apos_meses,…
  · `src/financeiro/routes.js`, `src/financeiro/planos-repository.js`, `src/db/migrations/026_planos_versionados.sql` · rotas: `GET /admin/planos`, `POST /admin/planos`, `PATCH /admin/planos/:id`, `POST /admin/planos/:id/nova-versao` · papéis: admin
  · → aba Planos arquivados (contas_ativas e cobrancas por versão)
  · **cliente sabe:** Quem já assinou continua na versão antiga, com o preço, a frequência, a cobertura, o limite de criativos e os benefícios que contratou.

**Catálogo de benefícios** — CRUD de benefícios reaproveitados por plano; o vínculo é por id (planos_beneficios), não por texto, para que desativar um benefício não apague o vínculo.
  · `src/financeiro/beneficios-repository.js`, `src/financeiro/routes.js` · rotas: `GET /admin/beneficios`, `POST /admin/beneficios`, `PATCH /admin/beneficios/:id`, `DELETE /admin/beneficios/:id` · papéis: admin
  · **cliente sabe:** Vira a lista de bullets de cada card de plano na página pública.

**Início de assinatura** — Valida plano ativo, programa fundador, vagas (`contarVagasOcupadas`), conta não excluída/suspensa, endereço comercial completo; acrescenta o papel 'anunciante'; reusa a assinatura ativa ou cria uma nova (`assinaturas-repository.criar`, id UUID); emite o…
  · `src/financeiro/routes.js`, `src/financeiro/assinaturas-repository.js`, `src/financeiro/san-checkout.js` · rotas: `POST /anunciantes/:id/assinar` · papéis: anunciante
  · ← public/planos.page.js via ?plano=X / montarConfirmacaoPedido() em confirmar-plano.html  → tela de pagamento do San Checkout / GET /plano/:assinaturaId (o Checkout consulta de volta)
  · **cliente sabe:** `montarConfirmacaoPedido()` mostra antes de redirecionar um resumo com subtotal, desconto, equivalente mensal e total agrupados. Erros do servidor ('as vagas desse plano…

**Contrato de consulta do Checkout** — `montarRespostaPlano` devolve ao San Checkout planoId (= id da assinatura), nome, descrição, `valor` = valorMensalDaConta × compromisso_meses, `ciclo` mapeado para CICLO_ASAAS (MONTHLY/QUARTERLY/SEMIANNUALLY/YEARLY) e o bloco `pagador` (nome, e-mail,…
  · `src/financeiro/san-checkout.js`, `src/financeiro/routes.js` · rotas: `GET /plano/:assinaturaId` · papéis: sistema (San Checkout)
  · **cliente sabe:** É o valor que aparece na tela de pagamento e o que a Asaas passa a cobrar para sempre naquele ciclo.

**Autenticação do webhook (HMAC)** — `webhookAutorizado` exige X-Checkout-Signature (sha256=<hex>) sobre '{timestamp}.{corpo cru}' e X-Checkout-Timestamp em segundos, com a mesma SAN_CHECKOUT_KEY; recusa timestamp fora de 300s (JANELA_ASSINATURA_S), exige `req.rawBody` como Buffer e compara em…
  · `src/financeiro/san-checkout.js`, `src/financeiro/routes.js`, `src/server.js` · rotas: `POST /webhook/san-checkout` · papéis: sistema (San Checkout)
  · → processarWebhookAssinatura (assíncrono, após o 200)
  · **cliente sabe:** Invisível ao cliente. É o que impede terceiro de creditar cobertura sem pagar.

**Dedupe do evento (chave natural)** — `chaveDoEvento`: usa payload.eventoId/cobrancaId se houver; para 'criada' e 'cobranca_confirmada' (EVENTOS_QUE_CREDITAM) busca o chargeId em `consultarAssinatura` (rota 5.3 do Checkout) e devolve `${chargeId}|${status}`; para os demais eventos usa…
  · `src/financeiro/san-checkout.js`, `src/db/migrations/018_seguranca_e_comissoes.sql`, `tests/dedupe-webhook.test.js` · rotas: `POST /webhook/san-checkout` · papéis: sistema
  · → aplicarCicloPago / registrarPendencia quando não há chargeId
  · **cliente sabe:** É o que garante que uma reentrega do mesmo aviso não estenda a cobertura nem pague comissão duas vezes.

**Crédito do ciclo pago** — `aplicarCicloPago` calcula valorMensal (trava) × compromisso_meses com `multiplicar` (centavos), estende data_expiracao a partir da maior entre a expiração vigente e agora, e numa transação única faz: UPDATE anunciantes (plano_id, status 'ativo',…
  · `src/financeiro/san-checkout.js`, `src/db/migrations/008_cobrancas_confirmadas.sql`, `src/db/migrations/021_remove_cobertura_adiada.sql` · rotas: `POST /webhook/san-checkout`, `(também chamado por scripts/conciliar.js)` · papéis: sistema, anunciante
  · ← processarWebhookAssinatura / conciliarAssinaturas  → aba Cobranças do admin / aba Comissões / playlist (data_expiracao >= now em src/playlist/gerador.js:45)
  · **cliente sabe:** O anunciante vê no painel 'Plano ativo até DD/MM/AAAA' e recebe o e-mail 'Pagamento confirmado — Mostraí' com o valor cobrado.

**Trava de preço (fundador)** — `valorMensalDaConta(anunciante, plano)` só usa `anunciantes.valor_mensal_travado` quando `anunciante.plano_id === plano.id`; trocar de plano solta a trava. O UPDATE do crédito grava COALESCE(valor_mensal_travado, plano.valor_mensal) quando é o mesmo plano e…
  · `src/financeiro/san-checkout.js`, `src/anunciantes/repository.js` · rotas: `GET /plano/:assinaturaId`, `POST /webhook/san-checkout`, `PATCH /admin/anunciantes/:id (valor_mensal_travado está em CAMPOS_ATUALIZAVEIS)` · papéis: admin, sistema
  · **cliente sabe:** No painel: '· preço travado em R$ X/mês'. Na aba Anunciantes do admin: badge 'R$ X/mês travado'.

**Comissão de vendedor** — `registrarComissaoSeHouver` roda DENTRO da transação do crédito: busca o vendedor por `upper(indicado_por_cupom)` com status 'aprovado' e conta não excluída, recusa autocomissão (vendedor.conta_id === anunciante.id), calcula `percentual(valor,…
  · `src/financeiro/san-checkout.js`, `src/financeiro/vendedores-repository.js`, `src/db/migrations/007_comissoes.sql` · rotas: `GET /vendedor/painel`, `GET /admin/comissoes`, `PATCH /admin/comissoes/:id`, `GET /admin/vendedores` · papéis: vendedor, admin
  · **cliente sabe:** Painel do vendedor: totalComissionado, totalPago, totalAReceber e a lista linha a linha. Admin: 'Total a pagar', agrupado por vendedor com a chave Pix, e o botão 'Marcar como paga' (aviso na tela: 'o…

**Fila de eventos pendentes** — `registrarPendencia` grava payload + motivo em `eventos_assinatura_pendentes` para: tipo != 'assinatura', falta de chargeId para deduplicar, assinatura não encontrada, plano/anunciante não encontrados, e eventos sem ação automática…
  · `src/financeiro/san-checkout.js`, `src/financeiro/routes.js`, `src/db/migrations/010_eventos_assinatura_pendentes.sql` · rotas: `GET /admin/eventos-pendentes`, `PATCH /admin/eventos-pendentes/:id` · papéis: admin
  · → contador da fila 'eventos' em GET /admin/resumo
  · **cliente sabe:** Aba 'Eventos pendentes': motivo, data, payload cru e o botão 'Marcar resolvido'.

**Conciliação diária** — `conciliarAssinaturas` varre todas as assinaturas 'ativa' de contas não excluídas, chama `consultarAssinatura`, e quando ultimaCobranca.status === 'confirmado' insere a mesma chave `chargeId|status` e chama `aplicarCicloPago`. Devolve {verificadas, aplicadas,…
  · `src/financeiro/conciliacao.js`, `scripts/conciliar.js` · rotas: `(sem rota HTTP) npm run conciliar` · papéis: sistema
  · **cliente sabe:** Nada. É a rede que impede um webhook perdido virar cliente pagante sem cobertura.

**Cancelamento de assinatura** — `cancelarAssinatura` faz POST {SAN_CHECKOUT_API_URL}/api/checkout/cancelar-assinatura {planoId: assinaturaId, documento: cpf_cnpj}; em sucesso marca a assinatura 'cancelada' localmente. Em falha responde 502 e não muda nada local. O evento 'cancelada' vindo…
  · `src/financeiro/san-checkout.js`, `src/financeiro/routes.js`, `src/financeiro/assinaturas-repository.js` · rotas: `POST /admin/anunciantes/:id/cancelar-assinatura`, `POST /anunciantes/me/cancelar-assinatura` · papéis: admin, anunciante
  · **cliente sabe:** RESOLVIDO em 16/09/2026 — `POST /anunciantes/me/cancelar-assinatura` deixa o próprio cliente cancelar, com botão no dialog "Gerenciar plano" do painel (`public/anunciante/painel.page.js`). A rota de admin continua existindo, pro admin cancelar em nome do cliente.

**Cortesia (liberar plano de graça)** — Põe a conta no ar sem assinatura e sem cobrança: plano_id, status 'ativo', data_expiracao = agora + meses×30 dias, plano_cortesia = true, cortesia_motivo, valor_mensal_travado = null. Recusa com 409 se houver plano pago ativo (plano_id e não cortesia e…
  · `src/financeiro/routes.js`, `src/db/migrations/024_plano_cortesia.sql`, `public/admin/index.page.js` · rotas: `POST /admin/anunciantes/:id/liberar-plano` · papéis: admin
  · **cliente sabe:** Admin: botão 'Liberar plano' na aba Anunciantes (dois prompts: plano e motivo) e badge 'cortesia' na coluna Plano. O cliente não vê diferença de uma conta paga.

**Bônus cruzados (tela grátis e anúncio grátis)** — `bonusPontoDaConta` libera candidatura de ponto após `planos.ponto_apos_meses` meses de cobertura. `bonusAnuncioDaConta` + POST /conta/bonus/anuncio/resgatar ativa plano de anúncio por `planos_ponto.plano_bonus_meses` meses sem cobrança: UPDATE anunciantes…
  · `src/conta/modos.js`, `src/db/migrations/020_modos_da_conta_e_modulos_de_plano.sql` · rotas: `POST /conta/bonus/ponto/resgatar`, `POST /conta/bonus/anuncio/resgatar` · papéis: anunciante, ponto
  · **cliente sabe:** No card de plano: 'Ao completar N meses, ganhe uma tela no seu comércio'. No painel do dono de ponto, o resgate do anúncio grátis.

**Cobranças e nota fiscal (Drive)** — Lista cobrancas_confirmadas com o nome da empresa; o upload do PDF vai por multer para os.tmpdir(), sobe no Drive por conta de serviço (`drive.subirNotaFiscal`, escopo drive.file, pasta GOOGLE_DRIVE_FOLDER_ID), grava nota_fiscal_url + drive_file_id e marca…
  · `src/financeiro/routes.js`, `src/financeiro/drive.js`, `src/financeiro/cobrancas-repository.js` · rotas: `GET /admin/cobrancas`, `PATCH /admin/cobrancas/:id/nota-fiscal` · papéis: admin
  · **cliente sabe:** Admin: KPIs 'Total confirmado' e 'Notas por emitir'; selecionar o PDF já envia. O anunciante vê a cobrança e a nota na exportação de dados (GET /titular/meus-dados).

**Direito de acesso e portabilidade** — `exportarConta` monta um JSON com conta, pontos, telas, criativos, assinaturas, cobrancas_confirmadas, comissões ganhas e geradas, exibições por hora, pagamentos como ponto, cadastro de vendedor, candidaturas e eventos da métrica. Não exporta senha_hash nem…
  · `src/titular/repository.js`, `src/titular/routes.js`, `src/db/migrations/025_direitos_do_titular.sql` · rotas: `GET /titular/meus-dados`, `POST /titular/consentimento` · papéis: anunciante, ponto, vendedor
  · **cliente sabe:** Download direto, com Content-Disposition attachment (mostrai-<empresa>-<data>.json).

**Arrependimento em 7 dias com estorno (CDC art. 49)** — GET calcula o prazo a partir de `primeiraCobranca` (a cobrança confirmada mais antiga) e devolve disponivel/prazo_ate/valor_a_estornar (= `totalPago`, soma de TODAS as cobranças). POST: cancela no Checkout primeiro, marca a assinatura 'cancelada', grava em…
  · `src/titular/routes.js`, `src/titular/repository.js`, `src/financeiro/email.js` · rotas: `GET /titular/arrependimento`, `POST /titular/arrependimento`, `GET /admin/arrependimentos`, `POST /admin/arrependimentos/:id/estornado` · papéis: anunciante, admin
  · → aba Devoluções do admin (fila urgente no resumo)
  · **cliente sabe:** E-mail 'Desistência registrada' com valor a devolver e protocolo. Admin: 'A devolução é feita no painel do San Checkout/Asaas. Aqui você registra o comprovante pra fechar o pedido.'

**Resumo financeiro do admin** — Calcula receitaMensal = SUM(COALESCE(a.valor_mensal_travado, p.valor_mensal)) de anunciantes com status 'ativo' unidos a planos; custoPontosMensal (ajuda de custo dos pontos ativos); amortizacaoMensal (custo_equipamento / meses_amortizacao das telas ativas);…
  · `src/admin/routes.js`, `public/admin/index.page.js` · rotas: `GET /admin/resumo`, `GET /admin/metrica`, `GET /admin/custos-fixos`, `POST /admin/custos-fixos` · papéis: admin
  · **cliente sabe:** KPIs 'Receita recorrente — planos ativos, por mês' e 'Margem — no azul/no vermelho'.

**Aritmética de dinheiro** — `multiplicar` e `percentual` operam em centavos inteiros para não produzir 267.29999999999995 em cobrancas_confirmadas, na comissão e no `valor` que vai para a Asaas.
  · `src/lib/dinheiro.js`, `tests/dinheiro.test.js` · papéis: sistema
  · **cliente sabe:** Nada — mas é o que impede o cliente ver R$ 267,2999 no extrato.

**Eventos da métrica de receita** — `eventos.registrar` grava plano:assinatura_inicia (na entrega do link), pagamento:cobranca_confirma (só depois do COMMIT, com ciclo_numero contado em cobrancas_confirmadas) e comissao:vendedor_gera (dono = vendedor). Engole o próprio erro para nunca derrubar…
  · `src/lib/eventos.js`, `src/db/migrations/027_eventos_da_metrica.sql` · rotas: `GET /admin/metrica` · papéis: admin
  · **cliente sabe:** Aba Métrica: a distância entre assinatura_inicia e cobranca_confirma é quem desistiu no checkout.

**E-mails do caminho do dinheiro** — enviarConfirmacaoPagamento (disparado após o COMMIT do crédito), enviarArrependimentoRecebido (titular + cópia para a Mostraí), enviarCriativoNoAr, enviarNovidade (bloqueia quem tem comunicacoes_revogado_em). Todos por SMTP via nodemailer.
  · `src/financeiro/email.js` · papéis: anunciante
  · **cliente sabe:** É a única confirmação escrita que o cliente recebe de que o dinheiro entrou.

**Rotas de afiliado aposentadas** — POST /afiliados/cadastro, /afiliados/login e /afiliados/logout respondem 410. A tabela `afiliados` e afiliados-repository.js (bcrypt, gerarCupom, CAMPOS_PUBLICOS) continuam no código e no banco até o dono autorizar o drop; `comissoes.afiliado_id` é NOT NULL…
  · `src/financeiro/afiliados-repository.js`, `src/financeiro/routes.js`, `src/db/migrations/006_afiliados.sql` · rotas: `POST /afiliados/cadastro (410)`, `POST /afiliados/login (410)`, `POST /afiliados/logout (410)` · papéis: vendedor
  · **cliente sabe:** 'vendedor agora usa a conta única — entre em /anunciante/login.html'.

**Estados sem tela:** CRÉDITO QUE FALHOU NO MEIO DA TRANSAÇÃO — invisível. Em src/financeiro/routes.js a rota POST /webhook/san-checkout… · CICLO DESCARTADO EM SILÊNCIO PELA DEDUPE — `processarWebhookAssinatura` faz `if (!rowCount) return;` depois do INSERT… · CHAVE DE DEDUPE ÓRFÃ — o INSERT em `webhooks_processados` acontece antes do BEGIN de `aplicarCicloPago`. Se o processo… · RELATÓRIO DA CONCILIAÇÃO — o objeto `relato` de src/financeiro/conciliacao.js (verificadas, aplicadas, jaProcessadas,… · TABELA `assinaturas` SEM NENHUMA TELA — é a linha que diz que a Asaas está cobrando recorrentemente alguém, e não… · CANCELAMENTO SEM BOTÃO — POST /admin/anunciantes/:id/cancelar-assinatura existe em src/financeiro/routes.js e… · CONTA EXCLUÍDA COM COBRANÇA VIVA — POST /anunciantes/me/excluir (src/anunciantes/routes.js:180) só grava `excluido_em`… · NADA EXPIRA A COBERTURA — não existe job, cron ou rota que mude `status` quando `data_expiracao` passa (o único… · RECEITA RECORRENTE INFLADA — a query de `receita` em GET /admin/resumo (src/admin/routes.js) é… · BÔNUS DE ANÚNCIO GRÁTIS SEM MARCA DE CORTESIA — POST /conta/bonus/anuncio/resgatar (src/conta/modos.js) ativa plano_id… · VALOR REGISTRADO ≠ VALOR COBRADO — `cobrancas_confirmadas.valor` é recalculado localmente a cada ciclo… · ESTORNO NÃO ABATE NADA — o pedido de arrependimento não toca em `cobrancas_confirmadas`. A cobrança devolvida continua…

**Notas:**
- As três regras duras do webhook (fail-closed, idempotente, transacional) estão de pé e conferem com o CONSTRAINTS.md: HMAC sobre corpo cru com janela de 300s, chave natural `chargeId|status` em webhooks_processados, e UPDATE anunciantes + INSERT cobranca + INSERT comissao numa transação só, com…
- Os dois endereços do Checkout estão separados corretamente: SAN_CHECKOUT_BASE_URL só em `linkCheckoutAssinatura` (tela) e SAN_CHECKOUT_API_URL só em `chamarApiCheckout` (API, sob /api/checkout/). Nenhuma montagem de URL fora dessas duas funções. SAN_CHECKOUT_API_URL segue pendente de combinação com…
- Item 8 da spec (desconto de comodato por linha da grade) continua sem construir: em src/financeiro/planos-repository.js não há campo nem coluna de desconto por linha, e nem `planos_ponto` nem `CAMPOS_CRIACAO` têm nada equivalente.
- O item 9 (plano imutável, RN-27) está construído e coerente ponta a ponta: CAMPOS_CONTRATO x CAMPOS_VITRINE, 409 com o caminho certo no PATCH, `novaVersao` transacional, constraint planos_arquivado_nao_ativo na migration 026 e aba 'Planos arquivados' com contas_ativas por versão.
- O e-mail de confirmação de pagamento e o de arrependimento são fire-and-forget com .catch() — correto para não derrubar o crédito, mas significa que um SMTP fora do ar deixa o cliente sem nenhum aviso de que pagou ou de que a devolução foi registrada, e isso também não aparece em tela nenhuma.
- `comissoes.afiliado_id` continua NOT NULL na migration 007 enquanto o código só escreve `vendedor_conta_id` (migration 019) — vale conferir no banco real se a 019 tornou a coluna nullable; se não tornou, todo INSERT de comissão em `registrarComissaoSeHouver` quebraria, e a quebra cairia exatamente…
- src/financeiro/afiliados-repository.js ainda usa bcrypt(10) para senha, abaixo do piso da Lei 3 (scrypt N=2^17 em src/lib/senha.js). É código morto atrás dos 410, mas continua importável.
- Sugestão de ordem de correção, se virar tarefa: (1) gravar pendência quando `aplicarCicloPago` falhar e quando a dedupe descartar um evento, (2) cron da conciliação + persistir o relato numa tabela com aba própria, (3) filtros de cortesia/excluído/expirado na receita do /admin/resumo, (4) aba…


---

## Modelo de dados

MODELO DE DADOS do Mostraí — 26 tabelas criadas por 27 arquivos em /home/user/MostrAi/src/db/migrations/ (numeração 001..027, SEM o arquivo 009 — o runner /home/user/MostrAi/src/db/migrate.js só ordena por nome e registra em schema_migrations, então o buraco não quebra nada, mas a numeração mente sobre a contagem). Postgres cru via pg, sem ORM: todo SQL está escrito à mão em src/<domínio>/repository.js e src/<domínio>/routes.js. Três eixos: (1) CONTAS E PAPÉIS — a tabela `anunciantes` é a tabela de contas desde a migration 019 (nome histórico, veto de renomear no CONSTRAINTS.md linha 31), com `papeis text[]` e o perfil de vendedor numa tabela satélite `vendedores`; (2) REDE FÍSICA —…

**pontos** — O comércio parceiro: endereço, responsável, horário de funcionamento e o contrato de comodato. Colunas que importam: nome, endereco, cidade, uf, cep, segmento (texto livre, legado), categoria_id (FK categorias, é o que bloqueia concorrente na tela), horario_semanal (jsonb, migration 066, 22/09/2026 — `{seg,ter,qua,qui,sex,sab,dom}`, cada dia `null` ou `{abre,fecha}`, validado/resumido por `src/lib/horario-semanal.js`; as colunas antigas `horario_abertura`/`horario_fechamento` da migration 001 nunca chegaram a ser lidas por nenhuma tela ou rota — ficaram paradas até serem substituídas por esta),…
  · `src/db/migrations/001_pontos.sql`, `src/db/migrations/012_pontos_status_reparo.sql`, `src/db/migrations/015_beneficios_categorias_planos_ponto.sql`, `src/db/migrations/066_horario_semanal_do_ponto.sql` · rotas: `GET /pontos`, `GET /pontos/fluxo`, `POST /seja-um-ponto (410)`, `GET /admin/pontos`, `POST /admin/pontos`, `PATCH /admin/pontos/:id` · papéis: admin, ponto
  · ← candidaturas (via POST /admin/candidaturas/:id/liberar e POST /convites/:token/aceitar)  → dispositivos / exibicoes_contador / pagamentos_ponto
  · **cliente sabe:** O comércio onde a TV fica: endereço, horário, quem é o responsável e o que ele recebe pela parede (dinheiro ou cota de tela).

**dispositivos** — A TELA. Entidade própria desde a migration 019 — antes a chave de aparelho vivia no ponto. Colunas: ponto_id (FK pontos, NOT NULL, índice idx_dispositivos_ponto), apelido, aparelho_id UNIQUE (a credencial do player, header X-Aparelho-Id), pin_hash (PIN de 4…
  · `src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql`, `src/dispositivos/repository.js`, `src/dispositivos/routes.js` · rotas: `GET /admin/dispositivos`, `PATCH /admin/dispositivos/:id`, `DELETE /admin/dispositivos/:id`, `POST /admin/dispositivos/:id/chave` · papéis: admin, ponto, tela
  · ← pontos  → exibicoes_contador
  · **cliente sabe:** Cada TV instalada. Tem uma chave secreta que o player usa para se identificar, um PIN para o dono abrir o painel na própria tela, e o custo do equipamento que se dilui mês a mês.

**anunciantes** — A TABELA DE CONTAS (nome histórico; renomear está vetado no CONSTRAINTS.md linha 31). Uma linha por pessoa/empresa, com `papeis text[] DEFAULT '{anunciante}'` e índice GIN idx_anunciantes_papeis (migration 019). Identidade: nome_empresa, cpf_cnpj,…
  · `src/db/migrations/002_anunciantes.sql`, `src/db/migrations/013_planos_beneficios_e_perfil.sql`, `src/db/migrations/015_beneficios_categorias_planos_ponto.sql` · rotas: `POST /anunciantes/cadastro`, `POST /anunciantes/login`, `POST /anunciantes/logout`, `GET /anunciantes/me` · papéis: anunciante, ponto, vendedor, admin
  · ← convites / candidaturas / afiliados (migrados na 019)  → criativos / exibicoes_contador / cobrancas_confirmadas
  · **cliente sabe:** Sua conta. É uma só, mesmo que você anuncie, ceda a parede e venda para outros — os três papéis moram na mesma conta e no mesmo login.

**vendedores** — Perfil de vendedor de uma conta, criado na migration 019 para substituir a tabela `afiliados`. conta_id int PRIMARY KEY REFERENCES anunciantes(id) — um perfil por conta, garantido pela PK. chave_pix (o NOT NULL caiu na 020: vendedor liberado pelo painel pode…
  · `src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql`, `src/db/migrations/020_modos_da_conta_e_modulos_de_plano.sql`, `src/financeiro/vendedores-repository.js` · rotas: `GET /vendedor/painel`, `PATCH /vendedor/me`, `GET /admin/vendedores`, `PATCH /admin/vendedores/:contaId` · papéis: vendedor, admin
  · ← convites / candidaturas  → comissoes
  · **cliente sabe:** Se você vende para o Mostraí: seu cupom, sua chave Pix e o seu percentual de comissão.

**criativos** — O vídeo/imagem do anunciante. anunciante_id FK NOT NULL, arquivo_original_url (o que subiu), arquivo_normalizado_url (o que roda — gerado pelo ffmpeg em src/lib/ffmpeg.js; o gerador de playlist SÓ usa esta), thumbnail_url (poster do <video> no admin e no…
  · `src/db/migrations/003_criativos.sql`, `src/anunciantes/criativos-repository.js`, `src/anunciantes/routes.js` · rotas: `GET /anunciantes/:id/criativos`, `POST /anunciantes/:id/criativos`, `DELETE /anunciantes/:id/criativos/:criativoId`, `POST /admin/anunciantes/:id/criativos` · papéis: anunciante, admin
  · → playlist (leitura direta em anunciantesElegiveis e criativosDoDono)
  · **cliente sabe:** O seu anúncio. Você sobe, a gente converte para o formato da TV, e ele só entra no ar depois de aprovado.

**exibicoes_contador** — A medição: uma linha por (anunciante, tela, hora cheia). vezes_programadas é o que o gerador colocou na playlist daquela hora; vezes_confirmadas é o que o player reportou como tocado. A diferença vira `deficit` e é compensada na hora seguinte…
  · `src/db/migrations/004_exibicoes_contador.sql`, `src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql`, `src/playlist/gerador.js` · rotas: `GET /playlist/:dispositivoId`, `POST /player/:dispositivoId/played`, `GET /anunciantes/:id/exibicoes`, `GET /anunciantes/:id/dispositivos/:dispositivoId/painel` · papéis: anunciante, ponto, tela, admin
  · ← playlist/gerador.js
  · **cliente sabe:** Quantas vezes o seu anúncio foi programado e quantas realmente tocaram, tela por tela, hora por hora.

**planos** — O catálogo de planos do anunciante. id text PK (ex.: 'essencial-12m', 'fundador-12m', e as versões '-vN' da 026). Preço: valor_mensal (unidade de preço, NÃO é o valor de cada cobrança quando compromisso_meses > 1), valor_mensal_cheio (riscado),…
  · `src/db/migrations/005_planos.sql`, `src/db/migrations/013_planos_beneficios_e_perfil.sql`, `src/db/migrations/014_planos_promo_e_limite_criativos.sql` · rotas: `GET /planos`, `GET /admin/planos`, `POST /admin/planos`, `PATCH /admin/planos/:id` · papéis: anunciante, admin
  · → planos_beneficios / assinaturas / cobrancas_confirmadas
  · **cliente sabe:** Os planos que você pode assinar. Depois que você assina, o seu plano vira uma versão congelada: mudanças de preço ou de benefício criam um plano novo e não alcançam quem já está dentro.

**beneficios + planos_beneficios** — Catálogo de benefícios reutilizável, criado na 015 para substituir o `planos.beneficios text[]`. `beneficios`: id, texto UNIQUE, ordem (define a sequência no card — a migration reproduz exatamente a ordem que os textos já tinham na 014), ativo.…
  · `src/db/migrations/015_beneficios_categorias_planos_ponto.sql`, `src/financeiro/beneficios-repository.js`, `src/financeiro/planos-repository.js` · rotas: `GET /admin/beneficios`, `POST /admin/beneficios`, `PATCH /admin/beneficios/:id`, `DELETE /admin/beneficios/:id` · papéis: admin
  · **cliente sabe:** As frases que aparecem na lista de cada plano. Editar num lugar só muda em todos os planos que usam aquela frase.

**categorias** — Lista única de segmentos, usada dos dois lados: o que o anunciante vende (anunciantes.categoria_id) e o que o estabelecimento é (pontos.categoria_id). É o que impede anúncio de barbearia dentro de outra barbearia — o filtro está no WHERE de…
  · `src/db/migrations/015_beneficios_categorias_planos_ponto.sql`, `src/categorias/routes.js`, `src/pontos/repository.js` · rotas: `GET /categorias`, `GET /admin/categorias`, `POST /admin/categorias`, `PATCH /admin/categorias/:id` · papéis: anunciante, ponto, admin
  · → anunciantes / pontos
  · **cliente sabe:** O ramo do seu negócio. É por ele que a gente garante que o seu anúncio não vai tocar dentro de um concorrente direto.

**planos_ponto** — As opções de comodato que o dono do ponto escolhe. id text PK, nome, chamada, ajuda_custo_mensal, cota_slots_hora, beneficios text[] (aqui a 015 MANTEVE o array solto, ao contrário de `planos`, que ganhou catálogo na mesma migration), ordem, ativo. Duas…
  · `src/db/migrations/015_beneficios_categorias_planos_ponto.sql`, `src/db/migrations/020_modos_da_conta_e_modulos_de_plano.sql`, `src/pontos/planos-ponto-repository.js` · rotas: `GET /planos-ponto`, `GET /admin/planos-ponto`, `POST /admin/planos-ponto`, `PATCH /admin/planos-ponto/:id` · papéis: ponto, admin
  · → pontos / candidaturas
  · **cliente sabe:** Você cede a parede e escolhe: recebe uma ajuda de custo em dinheiro, ou troca esse dinheiro por mais espaço para o seu próprio negócio na tela.

**assinaturas** — A ponte com o San Checkout. id text PK gerado com randomUUID() em src/financeiro/assinaturas-repository.js — é ESTE id que vai no link de checkout (?assinatura=id) e que volta como payload.planoId no webhook, o que torna a correlação exata sem depender de…
  · `src/db/migrations/011_assinaturas.sql`, `src/financeiro/assinaturas-repository.js`, `src/financeiro/san-checkout.js` · rotas: `POST /anunciantes/:id/assinar`, `GET /plano/:assinaturaId`, `POST /webhook/san-checkout`, `POST /admin/anunciantes/:id/cancelar-assinatura` · papéis: anunciante, admin, checkout
  · → cobrancas_confirmadas / comissoes / arrependimentos
  · **cliente sabe:** O seu contrato com o motor de pagamento. Cada link de pagamento aponta para uma linha aqui, e é assim que a gente sabe exatamente quem pagou.

**cobrancas_confirmadas** — O dinheiro que entrou de verdade — é a única fonte de receita histórica (SQL_MARGEM em src/admin/metrica.js). anunciante_id FK NOT NULL, plano_id FK NOT NULL, valor (o valor do CICLO, não do mês), criado_em. Nota fiscal: nota_fiscal_status…
  · `src/db/migrations/008_cobrancas_confirmadas.sql`, `src/financeiro/cobrancas-repository.js`, `src/financeiro/san-checkout.js` · rotas: `POST /webhook/san-checkout`, `GET /admin/cobrancas`, `PATCH /admin/cobrancas/:id/nota-fiscal`, `GET /admin/resumo` · papéis: admin, anunciante
  · ← webhook do San Checkout  → comissoes / arrependimentos
  · **cliente sabe:** Cada pagamento que caiu, com a nota fiscal correspondente.

**comissoes** — O que o vendedor ganhou. anunciante_id FK NOT NULL (quem comprou), valor_confirmado (a base), comissao_valor, criado_em, pago_em (adicionada na 018 — sem ela o admin não sabia quanto devia). vendedor_conta_id FK anunciantes (adicionada na 019, é a coluna…
  · `src/db/migrations/007_comissoes.sql`, `src/db/migrations/018_seguranca_e_comissoes.sql`, `src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql` · rotas: `POST /webhook/san-checkout`, `GET /vendedor/painel`, `GET /admin/comissoes`, `PATCH /admin/comissoes/:id` · papéis: vendedor, admin
  · ← webhook do San Checkout
  · **cliente sabe:** Cada venda sua que virou pagamento, quanto você ganhou nela e se já foi pago.

**pagamentos_ponto** — O extrato do dono do ponto (migration 022). ponto_id FK pontos ON DELETE CASCADE, competencia date (sempre o dia 1 do mês — guardar como data evita o clássico '2026-9' × '2026-09'), valor numeric(10,2) CHECK(>=0), pago_em (NULL = em aberto; é o que separa…
  · `src/db/migrations/022_pagamentos_ponto.sql`, `src/pontos/pagamentos-repository.js`, `src/pontos/routes.js` · rotas: `GET /admin/pontos/:pontoId/pagamentos`, `POST /admin/pontos/:pontoId/pagamentos`, `PATCH /admin/pagamentos-ponto/:id` · papéis: admin, ponto
  · **cliente sabe:** O seu extrato de quem cede a parede: o que a gente te deve, mês a mês, e o que já foi pago.

**custos_fixos** — Os custos mensais da operação lançados pelo dono, que entram na margem. id, nome, valor_mensal CHECK(>=0), ativo, observacao. Cinco linhas semeadas na 019: DAS MEI 86,05; Contador 100; Domínio 3,33; Supabase Pro 0; Deslocamento 50.
  · `src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql`, `src/admin/routes.js`, `src/admin/metrica.js` · rotas: `GET /admin/custos-fixos`, `POST /admin/custos-fixos`, `PATCH /admin/custos-fixos/:id`, `DELETE /admin/custos-fixos/:id` · papéis: admin
  · **cliente sabe:** Interno do dono: as contas fixas do negócio, que são descontadas da margem.

**candidaturas** — O formulário de quem quer entrar como ponto ou vendedor. tipo CHECK('ponto','vendedor'), nome, nome_comercio, contato_telefone NOT NULL, contato_email, endereco/cidade/uf/cep, segmento, fluxo_estimado_mensal, horario_semanal (jsonb, migration 066, 22/09/2026 — só preenchido em candidatura de ponto; copiado pro ponto por `liberarPapelNaConta()` quando o admin libera), mensagem, status…
  · `src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql`, `src/db/migrations/020_modos_da_conta_e_modulos_de_plano.sql`, `src/db/migrations/066_horario_semanal_do_ponto.sql`, `src/candidaturas/repository.js` · rotas: `POST /candidaturas`, `GET /admin/candidaturas`, `PATCH /admin/candidaturas/:id`, `POST /admin/candidaturas/:id/liberar` · papéis: visitante, anunciante, ponto, vendedor
  · → convites / pontos / vendedores
  · **cliente sabe:** Seu pedido para virar ponto ou vendedor. Não cria conta — a gente lê, fala com você e manda um convite.

**convites** — O link que o dono gera para alguém entrar com papéis específicos. token UNIQUE (o que vai na URL), papeis text[] NOT NULL, nome_sugerido, email_sugerido, candidatura_id (FK candidaturas), expira_em NOT NULL, usado_em (NULL = ainda aberto), conta_id (FK…
  · `src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql`, `src/convites/repository.js`, `src/convites/routes.js` · rotas: `GET /convites/:token`, `POST /convites/:token/aceitar`, `GET /admin/convites`, `POST /admin/convites` · papéis: visitante, anunciante, admin
  · ← candidaturas  → anunciantes / vendedores / pontos
  · **cliente sabe:** O link que a gente te manda. Ele já sabe quais papéis a sua conta vai ter e vale uma vez só, até a data de validade.

**arrependimentos** — Devolução por arrependimento do art. 49 do CDC (migration 025). Ficou em tabela própria, e não em coluna da conta, por dois motivos escritos no arquivo: é caminho de dinheiro e precisa de trilha, e o estorno acontece FORA daqui (a API do San Checkout não…
  · `src/db/migrations/025_direitos_do_titular.sql`, `src/titular/repository.js`, `src/titular/routes.js` · rotas: `GET /titular/arrependimento`, `POST /titular/arrependimento`, `GET /admin/arrependimentos`, `POST /admin/arrependimentos/:id/estornado` · papéis: anunciante, admin
  · ← cobrancas_confirmadas (é de lá que sai contratado_em e valor_a_estornar)
  · **cliente sabe:** Se você se arrependeu em até 7 dias: o pedido fica registrado com data e valor, o anúncio sai do ar na hora e o dinheiro volta.

**eventos** — Instrumentação da métrica (migration 027, seção 9 do docs/funcional.md). id bigserial, nome (convenção `categoria:objeto_acao`, verbo no presente), anunciante_id (FK anunciantes, nulo para evento sem dono), propriedades jsonb DEFAULT '{}', interno boolean (o…
  · `src/db/migrations/027_eventos_da_metrica.sql`, `src/lib/eventos.js`, `src/admin/metrica.js` · rotas: `GET /admin/metrica`, `GET /titular/meus-dados` · papéis: admin
  · ← todas as rotas que chamam eventos.registrar()
  · **cliente sabe:** Interno do dono: o registro do instante em que cada coisa importante aconteceu, para responder perguntas que o estado atual do banco não responde.

**eventos_assinatura_pendentes** — Fila de reconciliação manual (migration 010): payload jsonb NOT NULL, motivo, resolvido, criado_em. Recebe todo evento do San Checkout que não deu para aplicar automaticamente — CPF do pagador sem correspondência, assinatura não encontrada,…
  · `src/db/migrations/010_eventos_assinatura_pendentes.sql`, `src/financeiro/san-checkout.js`, `src/financeiro/routes.js` · rotas: `POST /webhook/san-checkout`, `GET /admin/eventos-pendentes`, `PATCH /admin/eventos-pendentes/:id`, `GET /admin/resumo` · papéis: admin
  · ← webhook do San Checkout
  · **cliente sabe:** Interno do dono: pagamentos que chegaram e o sistema não soube a quem atribuir. Ninguém fica sem cobertura por causa disso — alguém olha na mão.

**webhooks_processados** — Idempotência do webhook (migration 018). id text PRIMARY KEY = a chave natural do evento, calculada por chaveDoEvento() em src/financeiro/san-checkout.js (eventoId/cobrancaId quando existem, senão 'chargeId|status'); criado_em. Sem ela, um evento reentregue…
  · `src/db/migrations/018_seguranca_e_comissoes.sql`, `src/financeiro/san-checkout.js`, `src/financeiro/conciliacao.js` · rotas: `POST /webhook/san-checkout`, `npm run conciliar (src/financeiro/conciliacao.js)` · papéis: sistema
  · ← webhook do San Checkout
  · **cliente sabe:** Interno: a memória de quais avisos de pagamento já foram aplicados, para o mesmo pagamento nunca contar duas vezes.

**tokens_senha** — Redefinição de senha por link (migration 015). token text PRIMARY KEY, tipo CHECK('anunciante','afiliado'), usuario_id int (SEM FK — é polimórfico por `tipo`), expira_em, criado_em. Validade de 1 hora (VALIDADE_MS em src/conta/routes.js). Uso único: o DELETE…
  · `src/db/migrations/015_beneficios_categorias_planos_ponto.sql`, `src/conta/routes.js` · rotas: `POST /anunciantes/esqueci-senha`, `POST /anunciantes/redefinir-senha`, `POST /afiliados/esqueci-senha (alias legado)` · papéis: anunciante, vendedor
  · **cliente sabe:** O link de 'esqueci minha senha'. Vale uma hora e só uma vez.

**afiliados** — TABELA MORTA. Era o login separado do vendedor antes da v2. id, nome, cpf, chave_pix, telefone, email UNIQUE, senha_hash, status CHECK('pendente_aprovacao','aprovado','inativo'), codigo_cupom UNIQUE, comissao_percentual DEFAULT 12, aceitou_termos_em,…
  · `src/db/migrations/006_afiliados.sql`, `src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql`, `src/financeiro/afiliados-repository.js` · rotas: `POST /afiliados/cadastro (410)`, `POST /afiliados/login (410)`, `POST /afiliados/logout (410)`
  · → comissoes (pela coluna morta afiliado_id)
  · **cliente sabe:** Nada — não aparece em tela nenhuma. É o login antigo de vendedor, guardado só até o dono autorizar apagar.

**session** — Sessão HTTP no Postgres via connect-pg-simple (migration 019, seção 6). sid varchar PK, sess json, expire timestamp(6), índice IDX_session_expire. Criada com IF NOT EXISTS na migration e o servidor usa createTableIfMissing: false (src/server.js linha 95) — a…
  · `src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql`, `src/server.js` · rotas: `todas as rotas com cookie de sessão` · papéis: anunciante, ponto, vendedor, admin
  · **cliente sabe:** Nada — é o que mantém você logado mesmo depois de a gente atualizar o sistema.

**schema_migrations** — Controle do runner. filename text PRIMARY KEY, applied_at. NÃO é criada por nenhum arquivo .sql — é criada com CREATE TABLE IF NOT EXISTS pelo próprio src/db/migrate.js, que lê os .sql, ordena por nome, pula os já registrados e aplica cada um dentro de…
  · `src/db/migrate.js` · rotas: `npm run migrate` · papéis: sistema
  · **cliente sabe:** Nada — é a lista do que o banco já aplicou.

**Estados sem tela:** TABELA SEM TELA — `afiliados` (src/db/migrations/006_afiliados.sql). Nenhuma rota viva a toca;… · TABELA SEM TELA (por desenho) — `webhooks_processados` (018). Puramente interna à idempotência do webhook; nada no… · TABELA SEM TELA (por desenho) — `session` (019) e `schema_migrations` (src/db/migrate.js). Infraestrutura. · TABELA SEM TELA — `tokens_senha` (015). Correto não expor, mas também não há NENHUMA rotina de limpeza: o comentário da… · COLUNA SEM NENHUM LEITOR NEM ESCRITOR — cobrancas_confirmadas.email_confirmacao_enviado_em… · COLUNA ESCRITA E NUNCA LIDA — exibicoes_contador.ponto_id (004, NOT NULL). gravarProgramados() em… · COLUNA ESCRITA E NUNCA LIDA — pontos.aparelho_id (001, UNIQUE, com índice idx_pontos_aparelho criado na 018). A… · COLUNA MORTA — pontos.ultima_vez_online (001). Está no CAMPOS_ATUALIZAVEIS de src/pontos/repository.js:11 (logo,… · COLUNA MORTA — comissoes.afiliado_id (007). O INSERT vivo em src/financeiro/san-checkout.js:163 grava só… · COLUNA ESCRITA E NUNCA EXIBIDA — arrependimentos.assinatura_id (025). Gravada no INSERT de… · SEM TELA PRÓPRIA — pontos.acabamento_completo (016) tem checkbox no admin (public/admin/index.page.js:566) mas nenhuma… · SEM ENFORCEMENT — planos.cobertura (005, CHECK 'um_ponto_dia'/'tres_pontos_dia'/'todos_pontos'). É editável (POST…

**Notas:**
- RELAÇÃO CENTRAL SEM CHAVE ESTRANGEIRA — `anunciantes.plano_id text` (src/db/migrations/002_anunciantes.sql:16). O comentário na linha 1 da própria migration promete: 'plano_id ainda sem FK: a tabela planos só existe a partir do módulo 6 — vira FK de verdade quando ele for criado'. A 005 criou…
- RELAÇÃO SEM FK — `arrependimentos.plano_id text NOT NULL` e `arrependimentos.assinatura_id text` (025, linhas 35 e 34). Nenhuma das duas referencia planos(id) nem assinaturas(id), num registro que a própria migration classifica como 'caminho de dinheiro, que precisa de trilha'.
- RELAÇÃO POLIMÓRFICA SEM FK, COM RISCO REAL — `tokens_senha.usuario_id int` + `tipo CHECK('anunciante','afiliado')` (015). Não há FK porque a coluna apontava para duas tabelas. Depois da 019, o mapa TIPOS em src/conta/routes.js:12-15 aponta AMBOS os tipos para a tabela `anunciantes`. O UPDATE de…
- RELAÇÃO ASSUMIDA E NÃO GARANTIDA — uma assinatura ATIVA por anunciante. src/financeiro/assinaturas-repository.js:buscarAtivaDoAnunciante faz `WHERE status='ativa' ORDER BY created_at DESC LIMIT 1`, ou seja, assume uma. Não existe índice único parcial equivalente ao idx_um_arrependimento_aberto da…
- RELAÇÃO ASSUMIDA E NÃO GARANTIDA — exibicoes_contador.ponto_id deve ser o ponto do exibicoes_contador.dispositivo_id. Não há constraint nenhuma ligando os dois; gravarProgramados() em src/playlist/gerador.js:99 passa dispositivo.ponto_id 'na fé'. Como ninguém lê ponto_id, a divergência seria…
- FK SEM ON DELETE, EM CADEIA INCONSISTENTE — `dispositivos.ponto_id` (019:65) e `exibicoes_contador.ponto_id` (004:4) não têm ON DELETE, enquanto `pagamentos_ponto.ponto_id` (022:14) tem ON DELETE CASCADE. Apagar um ponto falharia no FK das telas e, se passasse, o CASCADE apagaria o extrato de…
- INCONSISTÊNCIA DE CÁLCULO ENTRE DUAS TELAS — `custos_fixos.ativo`. src/admin/routes.js:82 soma `FROM custos_fixos WHERE ativo`; src/admin/metrica.js:31 soma `FROM custos_fixos` sem filtro nenhum. A aba Resumo e a aba Métrica exibem margens diferentes assim que houver um custo desativado, e a margem…
- RECEITA DO RESUMO CONTA CORTESIA COMO DINHEIRO — src/admin/routes.js:64-67: `SELECT SUM(COALESCE(a.valor_mensal_travado, p.valor_mensal)) FROM anunciantes a JOIN planos p ON p.id = a.plano_id WHERE a.status='ativo'`. Não filtra `plano_cortesia` nem `excluido_em IS NULL`. É exatamente o problema que…
- docs/api.md ESTÁ DESATUALIZADO CONTRA O BANCO — a linha de GET /anunciantes/me promete devolver `meses_gratis_creditados` e `meses_cobertura_pendentes`, e a de GET /planos promete `meses_gratis` e `minimo_telas_ativas`. As quatro colunas foram APAGADAS na migration 021 (DROP COLUMN IF EXISTS). O…
- docs/api.md diz 'As 60 rotas estão listadas uma a uma', o CLAUDE.md fala em 55 rotas de /admin e o enunciado do projeto em 112 no total. Os três números não batem entre si — vale conferir antes de fechar a estação, porque o próprio doc afirma que a conferência mecânica contra o código é o que a…
- INCONSISTÊNCIA DE MODELAGEM DENTRO DA MESMA MIGRATION — a 015 tirou `planos.beneficios text[]` e criou o par beneficios + planos_beneficios, mas criou `planos_ponto.beneficios text[]` como array solto na linha 96 do MESMO arquivo. Editar 'Tela, player e instalação por nossa conta' exige tocar nas…
- DUPLICAÇÃO NÃO RESOLVIDA — `pontos.segmento text NOT NULL` (001) convive com `pontos.categoria_id` (015). O texto livre continua obrigatório e é o que o formulário do admin pede (public/admin/index.page.js:581), enquanto o bloqueio de concorrente na playlist usa exclusivamente categoria_id…


---

## Superfície da API

API do Mostraí — 112 declarações `router.<método>` em 12 `src/**/routes.js` + `src/conta/modos.js`. Uma delas (`src/financeiro/routes.js:368`) é um `forEach` sobre `['/afiliados/cadastro','/afiliados/login','/afiliados/logout']`, então as 112 declarações registram 114 caminhos. Somando o que está direto em `src/server.js` (POST /admin/login, POST /admin/logout, GET /health e 4 redirects 301), o servidor expõe 121 handlers. Cinco tipos de autorização: (1) público, (2) sessão de conta (`req.session.anuncianteId`, guarda `exigirAnuncianteLogado` exportada de `src/anunciantes/routes.js:197`), (3) sessão de conta + papel vendedor (`exigirVendedorLogado`, `src/financeiro/routes.js:357`), (4)…

**GET /health** — Healthcheck, {ok:true}.
  · `src/server.js:152` · rotas: `/health` · papéis: publico
  · ← nenhuma tela — só monitoração/Northflank

**POST /admin/login** — Login do admin contra ADMIN_USER/ADMIN_PASSWORD em tempo constante (segredoConfere), regenera sessão. Rate-limited.
  · `src/server.js:126`, `public/admin/index.page.js:266` · rotas: `/admin/login` · papéis: publico (é a porta do admin)
  · ← public/admin/index.page.js:266

**POST /admin/logout** — Destrói a sessão.
  · `src/server.js:142`, `public/admin/index.page.js:288` · rotas: `/admin/logout` · papéis: publico
  · ← public/admin/index.page.js:288

**GET /pontos** — Pontos ativos para a página "Onde estamos" (repo.listarPublicos).
  · `src/pontos/routes.js:16`, `public/pontos.page.js:1` · rotas: `/pontos` · papéis: publico
  · ← public/pontos.page.js:1

**GET /pontos/fluxo** — {pessoasPorMes} somando fluxo estimado dos pontos ativos (prova social).
  · `src/pontos/routes.js:24`, `public/index.page.js:4`, `public/planos.page.js:120` · rotas: `/pontos/fluxo` · papéis: publico
  · ← public/index.page.js:4 / public/planos.page.js:120 / public/pontos.page.js:15

**GET /anunciantes/:id/pontos** — Pontos da própria conta (403 se :id != sessão).
  · `src/pontos/routes.js:30`, `public/anunciante/painel.page.js:90`, `public/anunciante/ponto.page.js:92` · rotas: `/anunciantes/:id/pontos` · papéis: conta logada
  · ← public/anunciante/painel.page.js:90 / public/anunciante/ponto.page.js:92

**POST /anunciantes/me/pontos** — Dono de ponto cadastra outro endereço; cria ponto status 'lead' + 'Tela 1'. 403 sem papel ponto.
  · `src/pontos/routes.js:39`, `public/anunciante/ponto.page.js:121` · rotas: `/anunciantes/me/pontos` · papéis: conta logada + papel ponto
  · ← public/anunciante/ponto.page.js:121 (formEndereco)

**GET /planos-ponto** — Opções de comodato ativas (ajuda de custo x cota).
  · `src/pontos/routes.js:59`, `public/convite.page.js:98`, `public/modos.js:129` · rotas: `/planos-ponto` · papéis: publico
  · ← public/convite.page.js:98 / public/modos.js:129 (carregarOpcoesComodato)

**POST /seja-um-ponto** — 410 fixo — cadastro aberto de ponto virou candidatura + convite.
  · `src/pontos/routes.js:70` · rotas: `/seja-um-ponto` · papéis: publico
  · ← NENHUMA TELA — public/seja-um-ponto.page.js:27 usa POST /candidaturas

**GET /anunciantes/me/pontos/extrato** — Extrato de pagamentos ao ponto ({linhas, resumo}) via pagamentosRepo.extratoDaConta.
  · `src/pontos/routes.js:77` · rotas: `/anunciantes/me/pontos/extrato` · papéis: conta logada
  · ← NENHUMA TELA — public/anunciante/ponto.page.js:13 chama carregarExtrato(), função que NÃO EXISTE no arquivo (142 linhas, só carregar/carregarTelas/carregarPontos). ReferenceError engolido pelo .catch() da linha 140. Rota órfã e tela quebrada.

**POST /admin/pontos** — Cria ponto + 'Tela 1' junto.
  · `src/pontos/routes.js:87`, `public/admin/index.page.js:635` · rotas: `/admin/pontos` · papéis: sessao de admin
  · ← public/admin/index.page.js:635 (formNovoPonto)

**GET /admin/pontos** — Lista todos os pontos.
  · `src/pontos/routes.js:93`, `public/admin/index.page.js:540`, `public/admin/index.page.js:755` · rotas: `/admin/pontos` · papéis: sessao de admin
  · ← public/admin/index.page.js:540 (aba Pontos) / public/admin/index.page.js:755 (aba Contas)

**PATCH /admin/pontos/:id** — Status, endereço, ajuda de custo, cota.
  · `src/pontos/routes.js:98`, `public/admin/index.page.js:605`, `public/admin/index.page.js:608` · rotas: `/admin/pontos/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:605 / public/admin/index.page.js:608

**POST /admin/pontos/:id/foto** — Foto da instalação no Supabase Storage (multipart 'arquivo').
  · `src/pontos/routes.js:112`, `public/admin/index.page.js:627` · rotas: `/admin/pontos/:id/foto` · papéis: sessao de admin
  · ← public/admin/index.page.js:627

**POST /admin/pontos/:id/aparelho** — LEGADO — gera chave de aparelho por PONTO (pré-migration 019).
  · `src/pontos/routes.js:137` · rotas: `/admin/pontos/:id/aparelho` · papéis: sessao de admin
  · ← NENHUMA TELA — o admin usa POST /admin/dispositivos/:id/chave (index.page.js:709)

**GET /admin/planos-ponto** — Todas as opções de comodato (inclusive inativas).
  · `src/pontos/routes.js:145`, `public/admin/index.page.js:540`, `public/admin/index.page.js:1483` · rotas: `/admin/planos-ponto` · papéis: sessao de admin
  · ← public/admin/index.page.js:540 / public/admin/index.page.js:1483

**POST /admin/planos-ponto** — Cria opção de comodato (409 em id duplicado).
  · `src/pontos/routes.js:149` · rotas: `/admin/planos-ponto` · papéis: sessao de admin
  · ← NENHUMA TELA — a aba Comodato só lista e edita (PATCH), não cria

**PATCH /admin/planos-ponto/:id** — Edita opção, inclusive plano_bonus_id / plano_bonus_apos_meses / plano_bonus_meses.
  · `src/pontos/routes.js:160`, `public/admin/index.page.js:1515` · rotas: `/admin/planos-ponto/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:1515

**GET /admin/pontos/:pontoId/pagamentos** — Lançamentos de ajuda de custo daquele ponto.
  · `src/pontos/routes.js:171` · rotas: `/admin/pontos/:pontoId/pagamentos` · papéis: sessao de admin
  · ← NENHUMA TELA — zero ocorrências de 'pagamentos' como caminho em public/admin/index.page.js

**POST /admin/pontos/:pontoId/pagamentos** — Lança {competencia,valor,forma,observacao,pago_em}; UNIQUE da migration 022 faz o mesmo mês atualizar em vez de duplicar.
  · `src/pontos/routes.js:175` · rotas: `/admin/pontos/:pontoId/pagamentos` · papéis: sessao de admin
  · ← NENHUMA TELA

**PATCH /admin/pagamentos-ponto/:id** — Quita ou reabre lançamento; ao quitar emite evento 'ponto:pagamento_quita'.
  · `src/pontos/routes.js:186` · rotas: `/admin/pagamentos-ponto/:id` · papéis: sessao de admin
  · ← NENHUMA TELA

**POST /anunciantes/cadastro** — Cria conta. Sem convite: papel anunciante, status pendente_aprovacao. Com convite: papéis do link, status aprovado, ponto de candidatura já cria ponto + Tela 1. Regenera sessão. Rate-limited.
  · `src/anunciantes/routes.js:56`, `public/anunciante/cadastro.page.js:16`, `public/convite.page.js:139` · rotas: `/anunciantes/cadastro` · papéis: publico
  · ← public/anunciante/cadastro.page.js:16 / public/convite.page.js:139

**POST /anunciantes/login** — {email,senha} → conta com papeis; scrypt, migra bcrypt antigo; regenera sessão; 403 se excluido_em. Rate-limited.
  · `src/anunciantes/routes.js:160`, `public/anunciante/login.page.js:9` · rotas: `/anunciantes/login` · papéis: publico
  · ← public/anunciante/login.page.js:9

**POST /anunciantes/me/excluir** — Soft-delete (excluido_em), emite 'conta:exclusao_pede' e destrói a sessão.
  · `src/anunciantes/routes.js:180`, `public/perfil.js:196` · rotas: `/anunciantes/me/excluir` · papéis: conta logada
  · ← public/perfil.js:196 (btnExcluirConta)

**POST /anunciantes/logout** — session.destroy().
  · `src/anunciantes/routes.js:192`, `public/perfil.js:190`, `public/convite.page.js:63` · rotas: `/anunciantes/logout` · papéis: publico (idempotente)
  · ← public/perfil.js:190 (btnLogout) / public/convite.page.js:63

**GET /anunciantes/me** — A conta + perfil de vendedor quando tem o papel. É o que decide o menu e o redirect de login em todo painel.
  · `src/anunciantes/routes.js:206`, `public/layout.js:110`, `public/perfil.js:236` · rotas: `/anunciantes/me` · papéis: conta logada
  · ← public/layout.js:110 (window.carregarConta, usado por painel/ponto/vendedor e pelo menu público) / public/perfil.js:236 / public/anunciante/painel.page.js:29

**PATCH /anunciantes/me** — Autoedição por lista branca CAMPOS_AUTOEDITAVEIS (não alcança cpf_cnpj, status, plano_id, e-mail de acesso).
  · `src/anunciantes/routes.js:222`, `public/perfil.js:144` · rotas: `/anunciantes/me` · papéis: conta logada
  · ← public/perfil.js:144 (formPerfil)

**POST /anunciantes/me/foto** — Foto de perfil (multipart 'arquivo') → bucket Supabase, contentType fixo image/jpeg.
  · `src/anunciantes/routes.js:230`, `public/perfil.js:173` · rotas: `/anunciantes/me/foto` · papéis: conta logada
  · ← public/perfil.js:173 (inputFoto)

**POST /anunciantes/:id/criativos** — Upload de criativo na própria conta (403 se :id != sessão); teto = plano.limite_criativos, 1 sem plano; normaliza por ffmpeg.
  · `src/anunciantes/routes.js:300`, `public/anunciante/painel.page.js:344` · rotas: `/anunciantes/:id/criativos` · papéis: conta logada
  · ← public/anunciante/painel.page.js:344 (arquivoCriativo)

**POST /admin/anunciantes/:id/criativos** — Admin sobe peça na conta do cliente, já aprovada e marcada editado_pelo_operador. Sem teto na conta própria.
  · `src/anunciantes/routes.js:329`, `public/admin/index.page.js:521`, `public/admin/index.page.js:847` · rotas: `/admin/anunciantes/:id/criativos` · papéis: sessao de admin
  · ← public/admin/index.page.js:521 (aba Meus anúncios / conta própria) / public/admin/index.page.js:847 (aba Contas)

**GET /anunciantes/:id/criativos** — Criativos da própria conta.
  · `src/anunciantes/routes.js:343`, `public/anunciante/painel.page.js:264` · rotas: `/anunciantes/:id/criativos` · papéis: conta logada
  · ← public/anunciante/painel.page.js:264

**DELETE /anunciantes/:id/criativos/:criativoId** — Exclui criativo próprio; limpa .mp4 e -thumb.jpg do bucket em best-effort.
  · `src/anunciantes/routes.js:352`, `public/anunciante/painel.page.js:314` · rotas: `/anunciantes/:id/criativos/:criativoId` · papéis: conta logada
  · ← public/anunciante/painel.page.js:314

**GET /anunciantes/:id/exibicoes.csv** — Proof-of-play em CSV (;, BOM, ?dias= de 1 a 365) com Content-Disposition attachment.
  · `src/anunciantes/routes.js:380`, `public/anunciante/painel.page.js:169` · rotas: `/anunciantes/:id/exibicoes.csv` · papéis: conta logada
  · ← public/anunciante/painel.page.js:169 (href do btnComprovante)

**GET /anunciantes/:id/exibicoes** — Dashboard agregado: totais programadas/confirmadas, confirmadasMes, porPonto (com ultima_vez_online), porDia, porDiaPonto (dia × ponto, pro gráfico empilhado), cobranças (sem nota fiscal), horasContratadasMes/horasEntreguesMes, exibicoesContratadasMes/exibicoesRestantesMes, mediaDiariaMes e custoPorExibicao (valor mensal ÷ exibicoesContratadasMes — fixo, não pelas confirmadas). Sem `porHora` (existiu por um dia, removido — ver "Exibições por horário — REMOVIDO").
  · `src/anunciantes/routes.js:415`, `public/anunciante/painel.page.js:179` · rotas: `/anunciantes/:id/exibicoes` · papéis: conta logada
  · ← public/anunciante/painel.page.js:179

**GET /admin/anunciantes** — Lista todas as contas.
  · `src/anunciantes/routes.js:464`, `public/admin/index.page.js:376`, `public/admin/index.page.js:423` · rotas: `/admin/anunciantes` · papéis: sessao de admin
  · ← public/admin/index.page.js:376 (aba Criativos) / public/admin/index.page.js:423 / public/admin/index.page.js:755 (aba Contas)

**POST /admin/anunciantes** — Cria conta pelo admin; conta_propria:true dispensa endereço e recusa a segunda com 409.
  · `src/anunciantes/routes.js:474`, `public/admin/index.page.js:445`, `public/admin/index.page.js:862` · rotas: `/admin/anunciantes` · papéis: sessao de admin
  · ← public/admin/index.page.js:445 (criar conta própria) / public/admin/index.page.js:862 (formulário de nova conta)

**PATCH /admin/anunciantes/:id** — Status, papéis, dados, conta_propria, frequencia_hora_propria; também é o caminho de restaurar conta excluída (excluido_em: null).
  · `src/anunciantes/routes.js:533`, `public/admin/index.page.js:506`, `public/admin/index.page.js:817` · rotas: `/admin/anunciantes/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:506 / public/admin/index.page.js:817 / public/admin/index.page.js:856 (data-restaurar)

**POST /candidaturas** — Formulário 'Seja um ponto' / 'Seja um vendedor'. Não cria conta. Rate-limited.
  · `src/candidaturas/routes.js:8`, `public/seja-um-ponto.page.js:27`, `public/seja-um-vendedor.page.js:16` · rotas: `/candidaturas` · papéis: publico
  · ← public/seja-um-ponto.page.js:27 / public/seja-um-vendedor.page.js:16

**GET /admin/candidaturas** — Lista as candidaturas.
  · `src/candidaturas/routes.js:20`, `public/admin/index.page.js:908` · rotas: `/admin/candidaturas` · papéis: sessao de admin
  · ← public/admin/index.page.js:908

**PATCH /admin/candidaturas/:id** — nova → em_contato → aprovada/recusada; emite 'ponto:candidatura_aprova' só na transição.
  · `src/candidaturas/routes.js:22`, `public/admin/index.page.js:940` · rotas: `/admin/candidaturas/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:940

**GET /categorias** — Categorias ativas e não-legadas (com grupo e aliases) para a busca de cadastro (RN-57, reforma de 22/09/2026 — taxonomia de ~229 categorias específicas substituiu as 25 amplas antigas, que viram `legado=true` sem apagar).
  · `src/categorias/routes.js:11`, `public/formulario.js:47` · rotas: `/categorias` · papéis: publico
  · ← public/formulario.js:47 (window.ligarCategorias — cadastro, convite, planos, pontos, seja-um-*, modos.js)

**GET /admin/categorias** — Lista todas (inclusive inativas).
  · `src/categorias/routes.js:16`, `public/admin/index.page.js:540`, `public/admin/index.page.js:755` · rotas: `/admin/categorias` · papéis: sessao de admin
  · ← public/admin/index.page.js:540 / public/admin/index.page.js:755 / public/admin/index.page.js:1438

**POST /admin/categorias** — Cria categoria (409 em nome duplicado).
  · `src/categorias/routes.js:21`, `public/admin/index.page.js:1475` · rotas: `/admin/categorias` · papéis: sessao de admin
  · ← public/admin/index.page.js:1475

**PATCH /admin/categorias/:id** — Edita nome/ativo. Devolve `null` (200) quando o id não existe, em vez de 404.
  · `src/categorias/routes.js:33`, `public/admin/index.page.js:1462` · rotas: `/admin/categorias/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:1462

**DELETE /admin/categorias/:id** — Exclui; 409 com mensagem de 'desative' quando a FK está em uso (23503).
  · `src/categorias/routes.js:46`, `public/admin/index.page.js:1467` · rotas: `/admin/categorias/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:1467

**POST /anunciantes/esqueci-senha** — Envia link de redefinição; resposta sempre {ok:true} pra não virar verificador de cadastro. Rate-limited.
  · `src/conta/routes.js:49`, `public/esqueci-senha.page.js:12` · rotas: `/anunciantes/esqueci-senha` · papéis: publico
  · ← public/esqueci-senha.page.js:12

**POST /afiliados/esqueci-senha** — Alias legado do anterior (tipo 'afiliado' aponta pra mesma tabela anunciantes).
  · `src/conta/routes.js:50` · rotas: `/afiliados/esqueci-senha` · papéis: publico
  · ← NENHUMA TELA — só serve link antigo salvo

**POST /redefinir-senha** — Troca a senha pelo token (validade 60 min), aplica conferirSenha e apaga o token.
  · `src/conta/routes.js:52`, `public/redefinir-senha.page.js:16` · rotas: `/redefinir-senha` · papéis: publico (token)
  · ← public/redefinir-senha.page.js:16

**POST /contato** — Formulário de contato → e-mail; 502 se o envio falhar. Rate-limited.
  · `src/conta/routes.js:76`, `public/contato.page.js:8` · rotas: `/contato` · papéis: publico
  · ← public/contato.page.js:8

**GET /convites/:token** — O que o link permite: {papeis, nome_sugerido, email_sugerido, expira_em}. 404 se usado/expirado.
  · `src/convites/routes.js:13`, `public/convite.page.js:26` · rotas: `/convites/:token` · papéis: publico
  · ← public/convite.page.js:26

**GET /admin/convites** — Lista convites com `link` montado só quando situacao==='aberto'.
  · `src/convites/routes.js:20`, `public/admin/index.page.js:972` · rotas: `/admin/convites` · papéis: sessao de admin
  · ← public/admin/index.page.js:972

**POST /admin/convites** — Cria convite; com candidatura_id marca a candidatura como aprovada.
  · `src/convites/routes.js:25`, `public/admin/index.page.js:948`, `public/admin/index.page.js:1016` · rotas: `/admin/convites` · papéis: sessao de admin
  · ← public/admin/index.page.js:948 (a partir de uma candidatura) / public/admin/index.page.js:1016 (convite avulso)

**POST /admin/convites/:id/revogar** — Invalida o link (404 se não existe ou já usado).
  · `src/convites/routes.js:44`, `public/admin/index.page.js:1030` · rotas: `/admin/convites/:id/revogar` · papéis: sessao de admin
  · ← public/admin/index.page.js:1030

**GET /admin/dispositivos** — Todas as telas (repo.listarTodos).
  · `src/dispositivos/routes.js:13`, `public/admin/index.page.js:651` · rotas: `/admin/dispositivos` · papéis: sessao de admin
  · ← public/admin/index.page.js:651 (aba Telas)

**GET /admin/pontos/:pontoId/dispositivos** — Telas de um ponto específico.
  · `src/dispositivos/routes.js:17` · rotas: `/admin/pontos/:pontoId/dispositivos` · papéis: sessao de admin
  · ← NENHUMA TELA — o admin carrega GET /admin/dispositivos inteiro e filtra no cliente

**POST /admin/pontos/:pontoId/dispositivos** — Cria tela num ponto (404 se o ponto não existe).
  · `src/dispositivos/routes.js:21`, `public/admin/index.page.js:616` · rotas: `/admin/pontos/:pontoId/dispositivos` · papéis: sessao de admin
  · ← public/admin/index.page.js:616 (data-nova-tela)

**PATCH /admin/dispositivos/:id** — Apelido, status, custo, amortização; emite 'tela:dispositivo_ativa' só na transição para ativo.
  · `src/dispositivos/routes.js:27`, `public/admin/index.page.js:701` · rotas: `/admin/dispositivos/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:701

**POST /admin/dispositivos/:id/chave** — Gera/troca a chave de aparelho (derruba o player antigo na hora).
  · `src/dispositivos/routes.js:49`, `public/admin/index.page.js:709` · rotas: `/admin/dispositivos/:id/chave` · papéis: sessao de admin
  · ← public/admin/index.page.js:709 (monta o link do player em :712)

**POST /admin/dispositivos/:id/pin** — Define o PIN da tela (4 a 6 dígitos, guardado com hash; null limpa).
  · `src/dispositivos/routes.js:55`, `public/admin/index.page.js:724` · rotas: `/admin/dispositivos/:id/pin` · papéis: sessao de admin
  · ← public/admin/index.page.js:724

**DELETE /admin/dispositivos/:id** — Remove a tela.
  · `src/dispositivos/routes.js:63`, `public/admin/index.page.js:745` · rotas: `/admin/dispositivos/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:745

**GET /anunciantes/:id/dispositivos** — Telas dos pontos da conta com exibicoes_30d, anunciantes_30d e ponto_status.
  · `src/dispositivos/routes.js:71`, `public/anunciante/ponto.page.js:33` · rotas: `/anunciantes/:id/dispositivos` · papéis: conta logada
  · ← public/anunciante/ponto.page.js:33

**GET /anunciantes/:id/dispositivos/:dispositivoId/painel** — {porAnunciante, porDia} daquela tela, com checagem de que a tela é de um ponto da conta.
  · `src/dispositivos/routes.js:111`, `public/anunciante/ponto.page.js:71` · rotas: `/anunciantes/:id/dispositivos/:dispositivoId/painel` · papéis: conta logada
  · ← public/anunciante/ponto.page.js:71 (abrirPainel)

**GET /admin/dispositivos/:id/painel** — O mesmo painelDaTela visto pelo admin.
  · `src/dispositivos/routes.js:124`, `public/admin/index.page.js:731` · rotas: `/admin/dispositivos/:id/painel` · papéis: sessao de admin
  · ← public/admin/index.page.js:731 (data-painel-tela)

**POST /player/:dispositivoId/painel** — Painel aberto da própria TV: header X-Aparelho-Id conferido à mão (não usa exigirAparelho) + PIN com hash. Rate-limited.
  · `src/dispositivos/routes.js:131`, `public/player.page.js:172` · rotas: `/player/:dispositivoId/painel` · papéis: chave de aparelho + PIN
  · ← public/player.page.js:172 (formPin, aberto com 5 toques ou tecla P)

**GET /planos** — Planos ativos da vitrine; fundador só com PROGRAMA_FUNDADOR_ATIVO=true e vagas_restantes>0.
  · `src/financeiro/routes.js:23`, `public/planos.page.js:127`, `public/anunciante/painel.page.js:104` · rotas: `/planos` · papéis: publico
  · ← public/planos.page.js:127 / public/anunciante/painel.page.js:104

**GET /admin/planos** — Todos os planos, ativos e desativados.
  · `src/financeiro/routes.js:29`, `public/admin/index.page.js:755`, `public/admin/index.page.js:1091` · rotas: `/admin/planos` · papéis: sessao de admin
  · ← public/admin/index.page.js:755 / public/admin/index.page.js:1091 / public/admin/index.page.js:1483

**POST /admin/planos** — Cria versão nova de preço/promoção; valida limite_criativos 1..3 e o teto MAX_ATIVOS_POR_CICLO (409).
  · `src/financeiro/routes.js:44`, `public/admin/index.page.js:1251` · rotas: `/admin/planos` · papéis: sessao de admin
  · ← public/admin/index.page.js:1251

**PATCH /admin/planos/:id** — Só campo de vitrine (ativo, vagas, rotulo, destaque_no_site); campo de contrato responde 409 apontando /nova-versao (RN-27).
  · `src/financeiro/routes.js:74`, `public/admin/index.page.js:1207` · rotas: `/admin/planos/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:1207

**POST /admin/planos/:id/nova-versao** — RN-27: cria a versão -vN com os campos de contrato mudados e aposenta a atual, em transação.
  · `src/financeiro/routes.js:105`, `public/admin/index.page.js:1235` · rotas: `/admin/planos/:id/nova-versao` · papéis: sessao de admin
  · ← public/admin/index.page.js:1235

**GET /admin/planos-arquivados** — Versões aposentadas com contas_ativas e cobrancas de cada uma.
  · `src/financeiro/routes.js:142`, `public/admin/index.page.js:1349` · rotas: `/admin/planos-arquivados` · papéis: sessao de admin
  · ← public/admin/index.page.js:1349

**GET /admin/beneficios** — Lista os benefícios de plano.
  · `src/financeiro/routes.js:147`, `public/admin/index.page.js:1091`, `public/admin/index.page.js:1390` · rotas: `/admin/beneficios` · papéis: sessao de admin
  · ← public/admin/index.page.js:1091 / public/admin/index.page.js:1390

**POST /admin/beneficios** — Cria benefício.
  · `src/financeiro/routes.js:151`, `public/admin/index.page.js:1430` · rotas: `/admin/beneficios` · papéis: sessao de admin
  · ← public/admin/index.page.js:1430

**PATCH /admin/beneficios/:id** — Edita benefício.
  · `src/financeiro/routes.js:161`, `public/admin/index.page.js:1417` · rotas: `/admin/beneficios/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:1417

**DELETE /admin/beneficios/:id** — Remove benefício.
  · `src/financeiro/routes.js:167`, `public/admin/index.page.js:1422` · rotas: `/admin/beneficios/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:1422

**POST /anunciantes/:id/assinar** — {planoId} → {checkoutUrl}. Exige endereço completo, recusa fundador fechado/sem vaga, reusa assinatura ativa, emite 'plano:assinatura_inicia'.
  · `src/financeiro/routes.js:178`, `public/anunciante/confirmar-plano.page.js` · rotas: `/anunciantes/:id/assinar` · papéis: conta logada
  · ← public/anunciante/confirmar-plano.page.js

**GET /plano/:assinaturaId** — O San Checkout consulta a assinatura (montarRespostaPlano).
  · `src/financeiro/routes.js:235`, `src/financeiro/san-checkout.js:19` · rotas: `/plano/:assinaturaId` · papéis: chave do checkout (X-Checkout-Key)
  · ← NENHUMA TELA — chamada de saída do San Checkout, por contrato

**POST /webhook/san-checkout** — Fail-closed por HMAC-SHA256 sobre '{timestamp}.{corpo cru}' (janela 300s, segredo SAN_CHECKOUT_KEY). Responde 200 e processa depois.
  · `src/financeiro/routes.js:244`, `src/financeiro/san-checkout.js:40` · rotas: `/webhook/san-checkout` · papéis: chave do checkout (assinatura HMAC)
  · ← NENHUMA TELA — chamada de entrada do San Checkout

**POST /admin/anunciantes/:id/liberar-plano** — Cortesia: põe a conta no ar sem assinatura nem cobrança; 409 se já houver plano pago ativo; não trava preço.
  · `src/financeiro/routes.js:261`, `public/admin/index.page.js:834` · rotas: `/admin/anunciantes/:id/liberar-plano` · papéis: sessao de admin
  · ← public/admin/index.page.js:834

**POST /admin/anunciantes/:id/cancelar-assinatura** — Cancela no San Checkout e marca a assinatura; 502 se o Checkout falhar. RESOLVIDO em 16/09/2026: agora existe também `POST /anunciantes/me/cancelar-assinatura`, a mesma ação pelo próprio cliente.
  · `src/financeiro/routes.js` · rotas: `/admin/anunciantes/:id/cancelar-assinatura`, `/anunciantes/me/cancelar-assinatura` · papéis: sessao de admin, sessao de anunciante
  · ← public/admin/index.page.js (botão do admin) e public/anunciante/painel.page.js (botão "Cancelar assinatura", no dialog "Gerenciar plano").

**GET /admin/eventos-pendentes** — Webhooks não aplicados, com motivo e payload.
  · `src/financeiro/routes.js:312`, `public/admin/index.page.js:1664` · rotas: `/admin/eventos-pendentes` · papéis: sessao de admin
  · ← public/admin/index.page.js:1664

**PATCH /admin/eventos-pendentes/:id** — Marca resolvido. Devolve null (200) quando o id não existe.
  · `src/financeiro/routes.js:319`, `public/admin/index.page.js:1679` · rotas: `/admin/eventos-pendentes/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:1679 (via salvar(), PATCH — casa com a rota)

**GET /admin/cobrancas** — Cobranças confirmadas com nome da empresa.
  · `src/financeiro/routes.js:327`, `public/admin/index.page.js:1521` · rotas: `/admin/cobrancas` · papéis: sessao de admin
  · ← public/admin/index.page.js:1521

**PATCH /admin/cobrancas/:id/nota-fiscal** — Sobe o PDF da nota (multipart 'arquivo') e joga no Drive.
  · `src/financeiro/routes.js:337`, `public/admin/index.page.js:1556` · rotas: `/admin/cobrancas/:id/nota-fiscal` · papéis: sessao de admin
  · ← public/admin/index.page.js:1556 (fetch PATCH com FormData)

**POST /afiliados/cadastro, POST /afiliados/login, POST /afiliados/logout** — 410 fixo — vendedor virou papel da conta única. TRÊS caminhos gerados por um forEach, por isso as 112 declarações registram 114 rotas.
  · `src/financeiro/routes.js:367-369` · rotas: `/afiliados/cadastro`, `/afiliados/login`, `/afiliados/logout` · papéis: publico
  · ← NENHUMA TELA — src/server.js:112-114 redireciona 301 os HTML antigos de /afiliado/*

**GET /vendedor/painel** — {vendedor, comissoes, totalComissionado, totalPago, totalAReceber}. 403 se a conta não tem perfil de vendedor.
  · `src/financeiro/routes.js:371`, `public/anunciante/vendedor.page.js:24` · rotas: `/vendedor/painel` · papéis: conta logada + papel vendedor
  · ← public/anunciante/vendedor.page.js:24

**GET /admin/comissoes** — Comissões geradas, com chave_pix e nome do vendedor.
  · `src/financeiro/routes.js:384`, `public/admin/index.page.js:1564` · rotas: `/admin/comissoes` · papéis: sessao de admin
  · ← public/admin/index.page.js:1564

**PATCH /admin/comissoes/:id** — {pago} marca/desmarca pago_em.
  · `src/financeiro/routes.js:396`, `public/admin/index.page.js:1608` · rotas: `/admin/comissoes/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:1608

**GET /admin/vendedores** — Lista vendedores.
  · `src/financeiro/routes.js:405`, `public/admin/index.page.js:872` · rotas: `/admin/vendedores` · papéis: sessao de admin
  · ← public/admin/index.page.js:872

**PATCH /admin/vendedores/:contaId** — status, comissao_percentual, chave_pix.
  · `src/financeiro/routes.js:407`, `public/admin/index.page.js:898` · rotas: `/admin/vendedores/:contaId` · papéis: sessao de admin
  · ← public/admin/index.page.js:898

**POST /player/:dispositivoId/played** — Confirma exibição; só aceita anunciante programado nesta tela nesta hora.
  · `src/player/routes.js:17`, `public/player.page.js:118` · rotas: `/player/:dispositivoId/played` · papéis: chave de aparelho
  · ← public/player.page.js:118 (fire-and-forget em tocarProximo)

**POST /player/:dispositivoId/heartbeat** — Marca a tela online (ultima_vez_online).
  · `src/player/routes.js:25`, `public/player.page.js:133` · rotas: `/player/:dispositivoId/heartbeat` · papéis: chave de aparelho
  · ← public/player.page.js:133

**GET /playlist/:dispositivoId** — Playlist da hora, com cache em memória por processo; programa os contadores.
  · `src/playlist/routes.js:11`, `public/player.page.js:93` · rotas: `/playlist/:dispositivoId` · papéis: chave de aparelho (header X-Aparelho-Id ou ?chave=)
  · ← public/player.page.js:93

**GET /titular/meus-dados** — RN-24: exporta conta + tudo que gerou em JSON, com Content-Disposition attachment. Sem senha nem chave/PIN.
  · `src/titular/routes.js:26`, `public/perfil.js:211` · rotas: `/titular/meus-dados` · papéis: conta logada
  · ← public/perfil.js:211 (href do btnBaixarDados, não fetch — de propósito, por causa da CSP)

**POST /titular/consentimento** — RN-25: escopo 'comunicacoes' liga/desliga divulgação; 'opcionais' apaga contato do responsável e foto; outro escopo → 400.
  · `src/titular/routes.js:44`, `public/perfil.js:216`, `public/perfil.js:229` · rotas: `/titular/consentimento` · papéis: conta logada
  · ← public/perfil.js:216 (chkComunicacoes) / public/perfil.js:229 (btnApagarOpcionais)

**GET /titular/arrependimento** — RN-26: {disponivel, motivo, prazo_ate, valor_a_estornar} ou {pedido}; prazo de 7 dias da 1ª cobrança confirmada.
  · `src/titular/routes.js:62`, `public/perfil.js:248` · rotas: `/titular/arrependimento` · papéis: conta logada
  · ← public/perfil.js:248 (montarArrependimento)

**POST /titular/arrependimento** — RN-26: cancela no Checkout primeiro, suspende a conta, registra a devolução e manda e-mail fire-and-forget. 400 fora do prazo, 409 com pedido aberto, 502 se o Checkout cair.
  · `src/titular/routes.js:84`, `public/perfil.js:268` · rotas: `/titular/arrependimento` · papéis: conta logada
  · ← public/perfil.js:268 (btnArrependimento)

**GET /admin/arrependimentos** — Fila de devoluções, pendentes primeiro.
  · `src/titular/routes.js:146`, `public/admin/index.page.js:1618` · rotas: `/admin/arrependimentos` · papéis: sessao de admin
  · ← public/admin/index.page.js:1618

**POST /admin/arrependimentos/:id/estornado** — {comprovante} fecha o pedido depois do estorno no Checkout/Asaas. 404 se já estornado.
  · `src/titular/routes.js:150`, `public/admin/index.page.js:1656` · rotas: `/admin/arrependimentos/:id/estornado` · papéis: sessao de admin
  · ← CHAMADA QUEBRADA — public/admin/index.page.js:1656 usa salvar(), que é PATCH fixo (index.page.js:35). A rota é POST. PATCH nesse caminho não casa com rota nenhuma, cai no 404 de src/server.js:181 e o admin vê 'Não foi possível salvar.' Nenhuma devolução por arrependimento pode ser fechada pela tela.

**GET /admin/criativos** — Fila de aprovação por ?status= (default 'pendente').
  · `src/admin/routes.js:15`, `public/admin/index.page.js:375`, `public/admin/index.page.js:458` · rotas: `/admin/criativos` · papéis: sessao de admin
  · ← public/admin/index.page.js:375 (com ?status=) / public/admin/index.page.js:458

**PATCH /admin/criativos/:id** — Aprova/recusa; só na transição para aprovado manda e-mail e emite 'criativo:video_aprova'.
  · `src/admin/routes.js:19`, `public/admin/index.page.js:408`, `public/admin/index.page.js:531` · rotas: `/admin/criativos/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:408 / public/admin/index.page.js:531

**GET /admin/metrica** — As três consultas salvas (margem, funil, filas) + contagem de eventos, tudo com NOT interno.
  · `src/admin/routes.js:53`, `src/admin/metrica.js`, `public/admin/index.page.js:1263` · rotas: `/admin/metrica` · papéis: sessao de admin
  · ← public/admin/index.page.js:1263 (aba Métrica)

**GET /admin/resumo** — Filas, financeiro (margemMensal, faturamentoPorMes), rede, horasOfflineAlerta, programaFundadorAtivo. Também é o teste de sessão viva na abertura do admin.
  · `src/admin/routes.js:57`, `public/admin/index.page.js:294` · rotas: `/admin/resumo` · papéis: sessao de admin
  · ← public/admin/index.page.js:294 (gate de sessão), :219, :409, :702, :818, :940, :953, :961, :1072, :1077, :1084, :1558, :1680

**GET /admin/pontos-offline** — Telas ativas sem sinal além de HORAS_OFFLINE_ALERTA (2h).
  · `src/admin/routes.js:185` · rotas: `/admin/pontos-offline` · papéis: sessao de admin
  · ← NENHUMA TELA — o próprio comentário da rota (src/admin/routes.js:182) admite: a aba Telas refaz a regra no cliente em public/admin/index.page.js:652-653, usando GET /admin/dispositivos + RESUMO.horasOfflineAlerta

**GET /admin/custos-fixos** — Custos fixos que entram na margem.
  · `src/admin/routes.js:198`, `public/admin/index.page.js:1039` · rotas: `/admin/custos-fixos` · papéis: sessao de admin
  · ← public/admin/index.page.js:1039

**POST /admin/custos-fixos** — Cria custo fixo.
  · `src/admin/routes.js:202`, `public/admin/index.page.js:1082` · rotas: `/admin/custos-fixos` · papéis: sessao de admin
  · ← public/admin/index.page.js:1082

**PATCH /admin/custos-fixos/:id** — Edita nome, valor_mensal, ativo, observacao.
  · `src/admin/routes.js:211`, `public/admin/index.page.js:1072` · rotas: `/admin/custos-fixos/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:1072

**DELETE /admin/custos-fixos/:id** — Remove custo fixo.
  · `src/admin/routes.js:222`, `public/admin/index.page.js:1076` · rotas: `/admin/custos-fixos/:id` · papéis: sessao de admin
  · ← public/admin/index.page.js:1076

**GET /conta/modos** — {papeis, modos:{anunciante,ponto,vendedor}, bonus:{ponto,anuncio}} — o que desenha as três abas e os cards de bônus.
  · `src/conta/modos.js:74`, `public/modos.js:11` · rotas: `/conta/modos` · papéis: conta logada
  · ← public/modos.js:11 (estadoDosModos, chamado por montarModo em painel/ponto/vendedor)

**POST /conta/modos/anunciante** — Ativa o modo anúncios na própria conta; exige endereco/cidade/uf/cep; acrescenta o papel.
  · `src/conta/modos.js:100`, `public/modos.js:150` · rotas: `/conta/modos/anunciante` · papéis: conta logada
  · ← public/modos.js:150 (submeter, modo 'anunciante')

**POST /conta/modos/:papel/pedir** — UMA rota com parâmetro (não duas): valida papel em ['ponto','vendedor'], 409 se já liberado ou com pedido aberto, cria candidatura origem='painel' com conta_id.
  · `src/conta/modos.js:123`, `public/modos.js:165`, `public/modos.js:167` · rotas: `/conta/modos/:papel/pedir` · papéis: conta logada
  · ← public/modos.js:165 (/conta/modos/ponto/pedir) / public/modos.js:167 (/conta/modos/vendedor/pedir)

**POST /convites/:token/aceitar** — Conta logada aceita convite em transação: consome o token, liga os papéis novos (vendedor exige chave_pix, ponto de candidatura cria ponto + Tela 1).
  · `src/conta/modos.js:154`, `public/convite.page.js:53` · rotas: `/convites/:token/aceitar` · papéis: conta logada
  · ← public/convite.page.js:53

**POST /admin/candidaturas/:id/liberar** — Liga o papel direto na conta que pediu (candidatura com conta_id) e marca aprovada, em transação. 400 sem conta_id, 409 se já liberada.
  · `src/conta/modos.js:183`, `public/admin/index.page.js:958` · rotas: `/admin/candidaturas/:id/liberar` · papéis: sessao de admin
  · ← public/admin/index.page.js:958

**PATCH /vendedor/me** — Vendedor completa/troca a própria chave Pix. 403 se a conta não é de vendedor.
  · `src/conta/modos.js:199`, `public/anunciante/vendedor.page.js:18` · rotas: `/vendedor/me` · papéis: conta logada + perfil de vendedor
  · ← public/anunciante/vendedor.page.js:18 (formPix)

**POST /conta/bonus/ponto/resgatar** — Módulo 'tela após N meses' (planos.ponto_apos_meses): cria candidatura origem='bonus_plano' e marca ponto_bonus_resgatado_em, em transação.
  · `src/conta/modos.js:230`, `public/modos.js:165` · rotas: `/conta/bonus/ponto/resgatar` · papéis: conta logada
  · ← public/modos.js:165 (mesmo formulário do pedido de ponto, quando form.dataset.bonus está setado)

**POST /conta/bonus/anuncio/resgatar** — Módulo 'anúncio grátis após N meses como ponto' (planos_ponto.plano_bonus_*): ativa o plano por M meses sem cobrança e acrescenta o papel anunciante. 409 se já houver plano ativo.
  · `src/conta/modos.js:277`, `public/modos.js:234` · rotas: `/conta/bonus/anuncio/resgatar` · papéis: conta logada
  · ← public/modos.js:234 (ligarResgateAnuncio, botão btnResgatarAnuncio no card de bônus da tela Meu ponto)

**Estados sem tela:** POST /seja-um-ponto — 410 legado, nenhuma tela chama (src/pontos/routes.js:70) · GET /anunciantes/me/pontos/extrato — nenhuma tela chama; o único ponto que deveria chamar… · POST /admin/pontos/:id/aparelho — legado por ponto, substituído por /admin/dispositivos/:id/chave… · POST /admin/planos-ponto — nenhuma tela cria opção de comodato (src/pontos/routes.js:149) · GET /admin/pontos/:pontoId/pagamentos — nenhuma tela (src/pontos/routes.js:171) · POST /admin/pontos/:pontoId/pagamentos — nenhuma tela (src/pontos/routes.js:175) · PATCH /admin/pagamentos-ponto/:id — nenhuma tela (src/pontos/routes.js:186) · POST /afiliados/esqueci-senha — alias legado, nenhuma tela (src/conta/routes.js:50) · GET /admin/pontos/:pontoId/dispositivos — nenhuma tela; o admin baixa GET /admin/dispositivos e filtra no cliente… · POST /admin/anunciantes/:id/cancelar-assinatura — nenhuma tela, apesar de docs/api.md dizer que é o ÚNICO caminho de… · POST /afiliados/cadastro, /afiliados/login, /afiliados/logout — três 410 gerados em loop, nenhuma tela… · GET /admin/pontos-offline — nenhuma tela; a regra é refeita no cliente em public/admin/index.page.js:652-653…

**Notas:**
- CONTAGEM: 112 declarações router.<método> em src/*/routes.js + src/conta/modos.js. Uma delas (src/financeiro/routes.js:368) é um forEach sobre 3 caminhos, então são 114 caminhos registrados pelos routers. Somando src/server.js — POST /admin/login (:126), POST /admin/logout (:142), GET /health…
- CHAMADA DO SITE PARA ROTA QUE NÃO EXISTE (a única): public/admin/index.page.js:1656 manda PATCH /admin/arrependimentos/:id/estornado através do helper salvar() (index.page.js:34-35, método PATCH fixo). A rota registrada é POST (src/titular/routes.js:150). PATCH não casa, cai no 404 de…
- TELA QUEBRADA: public/anunciante/ponto.page.js:13 faz `await Promise.all([carregarTelas(), carregarPontos(), carregarExtrato()])`, mas carregarExtrato NÃO É DEFINIDA em lugar nenhum (o arquivo tem 142 linhas e só declara carregar, carregarTelas e carregarPontos). ReferenceError síncrono → a…
- CÓDIGO MORTO: public/nav-auth.js existe e chama GET /anunciantes/me, mas nenhum HTML o carrega — public/layout.js:119 diz literalmente 'Isso substituiu o antigo nav-auth.js'. Arquivo para apagar.
- ROTA NO CÓDIGO E NÃO NO DOC: (1) GET /anunciantes/:id/exibicoes.csv (src/anunciantes/routes.js:380) — o comprovante de veiculação, chamado por public/anunciante/painel.page.js:169, não aparece em docs/api.md; (2) GET /anunciantes/me/pontos/extrato (src/pontos/routes.js:77) — docs/api.md tem a seção…
- ROTA NO DOC E NÃO NO CÓDIGO: docs/api.md lista POST /conta/modos/ponto/pedir e POST /conta/modos/vendedor/pedir como duas rotas; o código tem UMA, POST /conta/modos/:papel/pedir (src/conta/modos.js:123), com a validação do papel dentro do handler. Nenhuma outra divergência de caminho — GET /health,…
- CONTAGEM DO ADMIN DIVERGE EM DOIS LUGARES: docs/api.md diz 'As 60 rotas estão listadas uma a uma' e CLAUDE.md fala em 55. O número real é 65: 63 declarações /admin nos routers + POST /admin/login + POST /admin/logout. A tabela do doc, essa sim, tem 65 linhas /admin — só a prosa ao lado está…
- SMELL ESTRUTURAL: src/pontos/routes.js faz `module.exports = router;` na linha 165 e define mais TRÊS rotas depois (linhas 171, 175, 186 — as de pagamentos). Funciona porque o export é a referência do mesmo objeto e o corpo do módulo roda inteiro no require, antes do app.use. Mas é exatamente o…
- ASSIMETRIA DE AUTENTICAÇÃO NO PLAYER: POST /player/:dispositivoId/painel (src/dispositivos/routes.js:131) NÃO usa o middleware exigirAparelho; confere req.headers['x-aparelho-id'] à mão e não aceita ?chave=, ao contrário de /playlist e das outras duas de /player, que aceitam os dois…
- PATCH QUE DEVOLVE 200 EM VEZ DE 404: PATCH /admin/categorias/:id (src/categorias/routes.js:33, `res.json(rows[0] || null)`) e PATCH /admin/eventos-pendentes/:id (src/financeiro/routes.js:319, mesmo padrão) respondem 200 com corpo `null` quando o id não existe. O helper salvar() do admin lê r.ok e…


---

## Contato fora do site

Mapa dos pontos de contato FORA do site do Mostraí, lido no código real (não nos docs). São quatro superfícies: (1) E-MAIL — 6 funções em src/financeiro/email.js, todas via nodemailer/SMTP, das quais 5 têm gatilho real e 1 (enviarNovidade) está morta de propósito; nenhuma delas é transacional-bloqueante: 4 das 5 são fire-and-forget com .catch(). (2) WHATSAPP — um único número (5516994635946) centralizado em window.WHATSAPP/window.linkWhatsApp (public/config.js L43-50), reescrito em runtime por ajustarWhatsApp() em public/layout.js L17-22 sobre todo <a data-wa>, mais um FAB flutuante injetado em TODA página com data-layout != "nenhum" (layout.js L102). Existem 7 saídas reais para o wa.me da…

**transportador() / remetente()** — Cria o transporte SMTP a cada envio (nodemailer.createTransport com SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS) e resolve o From. Nenhum pool, nenhuma verificação de conexão, nenhum retry, nenhuma fila: um SMTP fora do ar significa e-mail perdido em silêncio.
  · `src/financeiro/email.js (L3-13)`, `.env.example (L48-53)`
  · **cliente sabe:** Nada. Não há aviso de falha de envio em tela nenhuma; o erro só vai para console.error.

**enviarConfirmacaoPagamento(anunciante, plano, valorCobrado)** — Assunto "Pagamento confirmado — Mostraí". Único aviso que o cliente recebe depois de pagar em outro domínio. Disparado DENTRO de aplicarCicloPago (src/financeiro/san-checkout.js L348), depois do COMMIT, em fire-and-forget com .catch(console.error). Duas…
  · `src/financeiro/email.js (L19-30)`, `src/financeiro/san-checkout.js (L348-350, dentro de aplicarCicloPago L267)`, `src/financeiro/conciliacao.js (L51, chama aplicarCicloPago)` · rotas: `POST /webhook/san-checkout`, `(sem rota) npm run conciliar → conciliarAssinaturas()` · papéis: anunciante
  · ← San Checkout (webhook HMAC) / conciliação diária  → lugar nenhum — o corpo do e-mail cita "seu painel" mas NÃO tem URL; é o único e-mail transacional do sistema sem link clicável (compare com enviarCriativoNoAr, que monta ${SITE_URL}/anunciante/painel.html)
  · **cliente sabe:** "Assim que o primeiro ponto da rede estiver no ar, seu anúncio começa a rodar automaticamente." — texto FALSO para o fluxo atual: o anúncio só roda depois de o cliente SUBIR o vídeo e o admin APROVAR…

**enviarCriativoNoAr(anunciante, criativo)** — Assunto "Seu anúncio está no ar — Mostraí". Disparado SÓ na transição de status para 'aprovado' (compara com o estado anterior para não reenviar a cada save do admin). Fire-and-forget com .catch.
  · `src/financeiro/email.js (L60-82)`, `src/admin/routes.js (L19-43, envio na L32)` · rotas: `PATCH /admin/criativos/:id` · papéis: admin (dispara), anunciante (recebe)
  · → ${process.env.SITE_URL}/anunciante/painel.html
  · **cliente sabe:** É o ÚNICO e-mail do sistema que traz um caminho de volta explícito. Se SITE_URL estiver vazia o texto vira "undefined/anunciante/painel.html" — não há guarda.

**enviarLinkRedefinicaoSenha(email, nome, link)** — Assunto "Redefinir sua senha — Mostraí". Token de 32 bytes, validade de 1h, gravado em tokens_senha. O servidor responde {ok:true} SEMPRE (antes de saber se a conta existe) para não virar verificador de cadastro — o e-mail sai depois, fora do ciclo da…
  · `src/financeiro/email.js (L32-44)`, `src/conta/routes.js (pedirRedefinicao, envio na L45; rotas L50-51)`, `public/esqueci-senha.page.js` · rotas: `POST /anunciantes/esqueci-senha`, `POST /afiliados/esqueci-senha (alias legado)` · papéis: anunciante, ponto, vendedor, afiliado (legado)
  · → ${SITE_URL}/redefinir-senha.html?token=<token>&tipo=<tipo>
  · **cliente sabe:** A tela sempre diz que o link foi enviado, mesmo quando não foi (conta inexistente OU SMTP caiu). O cliente não tem como distinguir "não tenho conta" de "o e-mail não chegou".

**enviarMensagemContato({nome, email, telefone, mensagem})** — Único e-mail que entra em vez de sair: cai na caixa da própria Mostraí (MOSTRAI_EMAIL_CONTATO, com fallback para o próprio remetente), com replyTo do visitante. É o ÚNICO envio AWAIT-ado numa rota — se o SMTP falhar, a rota devolve 502 e a pessoa vê o erro.
  · `src/financeiro/email.js (L46-57)`, `src/conta/routes.js (L78-88)`, `public/contato.page.js` · rotas: `POST /contato` · papéis: público (sem login)
  · **cliente sabe:** Em caso de falha, public/contato.page.js L18: "Não foi possível enviar agora. Chame no WhatsApp que a gente resolve na hora." — a única degradação graciosa do site que aponta para o canal…

**enviarArrependimentoRecebido(anunciante, pedido)** — Assunto "Mostraí — Desistência registrada". Único e-mail com CC para a caixa da Mostraí (MOSTRAI_EMAIL_CONTATO) — porque o estorno é executado à MÃO por uma pessoa no painel do San Checkout/Asaas e sem esse aviso ninguém fica sabendo que há dinheiro a…
  · `src/financeiro/email.js (L101-115)`, `src/titular/routes.js (POST /titular/arrependimento L84-141, envio na L138)` · rotas: `POST /titular/arrependimento` · papéis: anunciante (recebe), admin (CC, fila em GET /admin/arrependimentos)
  · → lugar nenhum — sem link; só o número do protocolo (pedido.id)
  · **cliente sabe:** "A devolução é feita pelo mesmo meio do pagamento e pode levar alguns dias úteis pra aparecer no seu extrato." — "alguns dias úteis" é a única promessa de prazo, e o estorno real depende de uma…

**enviarNovidade(anunciante, {assunto, texto}) — MORTA** — Único canal de comunicação NÃO-operacional. Checa anunciante.comunicacoes_revogado_em e recusa quem revogou (LGPD art. 8 §5), devolvendo {enviado:false, motivo:'consentimento revogado'}. Exportada em email.js L118-119 mas SEM NENHUM CHAMADOR no repositório —…
  · `src/financeiro/email.js (L86-98)` · papéis: anunciante
  · **cliente sabe:** Rodapé fixo: "Pra parar, abra seu perfil no painel e desmarque 'receber novidades'" — sem link de descadastro de um clique (sem List-Unsubscribe).

**window.WHATSAPP / window.linkWhatsApp(mensagem)** — Fonte única do número (5516994635946) e montador do link wa.me com mensagem pré-preenchida e encodeURIComponent. Antes o número estava à mão em 6 arquivos.
  · `public/config.js (L43, L48-50)` · papéis: público, anunciante, ponto, vendedor
  · → https://wa.me/5516994635946?text=<mensagem>
  · **cliente sabe:** Nada — é infraestrutura.

**ajustarWhatsApp() — reescrita dos data-wa** — IIFE que roda antes do layout: varre document.querySelectorAll('a[data-wa]') e sobrescreve o href com window.linkWhatsApp(a.dataset.wa). O href literal no HTML existe para funcionar sem JS. Roda em TODA página que carrega layout.js, inclusive as com…
  · `public/layout.js (L13-22)` · papéis: público
  · **cliente sabe:** Nada.

**Botão flutuante de WhatsApp (whatsapp-fab)** — Injetado em document.body de TODA página com data-layout diferente de "nenhum" (público, conta e mínimo), junto do rodapé. Mensagem fixa "Olá! Vim pelo site da Mostraí e quero saber mais." — a mesma em todas as páginas, então a conversa NÃO diz de onde a…
  · `public/layout.js (L102-104)`, `public/style.css (L466-476)` · papéis: público, anunciante, ponto, vendedor
  · → wa.me/5516994635946
  · **cliente sabe:** Só o aria-label "Falar no WhatsApp". Nenhum horário de atendimento, nenhum prazo.

**montarPortasDeArte() — as duas saídas de quem não tem arte** — No painel do anunciante, reescreve o href de #linkArteSimples e #linkGravacao com mensagem personalizada contendo o nome da empresa ("Olá! Sou <empresa>, do Mostraí, e quero pedir o anúncio simples que vem no meu plano" / "...quero orçar a gravação de um…
  · `public/anunciante/painel.page.js (L11-25)`, `public/anunciante/painel.html (L82-92)` · papéis: anunciante
  · → wa.me/5516994635946 com mensagem personalizada
  · **cliente sabe:** painel.html L86: "incluído no seu plano. A gente combina no WhatsApp, monta a peça e sobe aqui pra você." e L90: "filmagem é feita por uma produtora parceira, orçada à parte." — não diz prazo de…

**Link de indicação do vendedor (#btnWhats)** — Único link wa.me SEM destinatário (https://wa.me/?text=...) — abre o WhatsApp do próprio vendedor para ele ESCOLHER para quem mandar. Monta a mensagem com o cupom e o link ${window.location.origin}/anunciante/cadastro.html?ref=<CUPOM>. Escrito à mão, NÃO usa…
  · `public/anunciante/vendedor.page.js (L44)`, `public/anunciante/vendedor.html (L44)` · papéis: vendedor
  · ← GET /vendedor/painel  → https://wa.me/?text=... (WhatsApp do próprio vendedor) → traz o indicado de volta para /anunciante/cadastro.html?ref=CUPOM
  · **cliente sabe:** Nada sobre o que acontece depois de mandar: o vendedor não sabe se o indicado abriu, cadastrou ou desistiu — a tabela de comissões só mostra quem já teve cobrança confirmada.

**Links data-wa escritos no HTML (7 saídas para o wa.me da Mostraí)** — Cada um carrega data-wa com a mensagem própria daquela página, reescrita por ajustarWhatsApp(). Inventário completo: (1) public/500.html L31 "Olá! Tive um erro no site da Mostraí."; (2) public/contato.html L74 "Olá! Vim pelo site da Mostraí e quero saber…
  · `public/500.html (L31)`, `public/contato.html (L74)`, `public/convite.html (L32)` · papéis: público
  · → wa.me/5516994635946
  · **cliente sabe:** Em seja-um-ponto.html L142: "A gente chama no WhatsApp <telefone> em até 2 dias úteis pra combinar a visita." e seja-um-vendedor.html L98: "A gente chama no WhatsApp <telefone> em até 2 dias úteis."…

**wa.me do cliente a partir do admin** — Na tabela de contas do admin, o telefone do cliente vira link clicável: https://wa.me/55${contato_telefone sem não-dígitos}. É a porta pela qual o dono executa TODAS as promessas de "a gente chama no WhatsApp" — manualmente, uma a uma, olhando a fila.
  · `public/admin/index.page.js (L918)` · papéis: admin
  · → wa.me/55<telefone do cliente>
  · **cliente sabe:** Nada ao cliente. Do lado do admin, index.page.js L172 explica: "'Subir anúncio' põe a peça pronta direto na conta do cliente, já aprovada: ela é feita fora do site e combinada no WhatsApp."

**POST /anunciantes/:id/assinar → {checkoutUrl}** — Valida plano ativo, programa fundador (PROGRAMA_FUNDADOR_ATIVO), vagas, conta não excluída/suspensa, endereço comercial completo (endereco+cidade+uf+cep), acrescenta o papel 'anunciante' se faltar, reusa a assinatura ativa ou cria uma nova em `assinaturas`,…
  · `src/financeiro/routes.js (L175-230)`, `src/financeiro/assinaturas-repository.js` · rotas: `POST /anunciantes/:id/assinar` · papéis: anunciante
  · → linkCheckoutAssinatura(assinatura.id)
  · **cliente sabe:** Os erros voltam como {erro} e são renderizados por assinar() no painel. O 409 de troca de plano manda "fale com a gente pelo WhatsApp" sem um <a href> — o cliente tem de achar o FAB sozinho.

**linkCheckoutAssinatura(assinaturaId) — a saída para outro domínio** — Monta `${SAN_CHECKOUT_BASE_URL}/index.html?c=${SAN_CHECKOUT_CONTRATANTE_ID}&assinatura=${assinaturaId}`. SAN_CHECKOUT_BASE_URL é a TELA que o comprador abre (distinta de SAN_CHECKOUT_API_URL, que só o servidor chama — ver CONSTRAINTS.md). A URL carrega…
  · `src/financeiro/san-checkout.js (L70-72)`
  · → outro domínio (San Checkout) — VIAGEM SÓ DE IDA
  · **cliente sabe:** NADA. Este é o buraco principal do mapa: o cliente sai do mostrai.sancocore.com.br para um domínio que não é o da Mostraí, e nem a tela de origem nem a URL dizem como voltar.

**montarConfirmacaoPedido(planoId) + assinar(anuncianteId, planoId)** — Página dedicada desde 19/09/2026 (antes vivia dentro de painel.page.js). montarConfirmacaoPedido desenha o resumo ("Você vai pagar R$ X a cada N meses") e só depois do clique em #btnConfirmarPlano chama assinar(); antes disso limpa o ?plano= da URL com history.replaceState para que um F5 não gere outra cobrança. assinar() faz o POST, e se…
  · `public/anunciante/confirmar-plano.page.js`, `public/anunciante/confirmar-plano.html` · papéis: anunciante
  · → SAN_CHECKOUT_BASE_URL (outro domínio)
  · **cliente sabe:** Só o rótulo do botão: "Ir para o pagamento". Nenhum texto do tipo "você vai para nosso parceiro de pagamento e volta para cá em seguida", nenhuma marca do San Checkout/Asaas antecipada, nenhuma…

**GET /plano/:assinaturaId — o Checkout consultando o Mostraí** — Entrada servidor-a-servidor, autenticada por exigirChaveCheckout (header X-Checkout-Key, comparação em tempo constante que nunca passa com segredo vazio). montarRespostaPlano() devolve {planoId, nome, descricao, valor, ciclo, pagador:{nome, email, documento,…
  · `src/financeiro/routes.js (L235-239)`, `src/financeiro/san-checkout.js (montarRespostaPlano L110-131, exigirChaveCheckout L19-24, valorMensalDaConta L135-138)` · rotas: `GET /plano/:assinaturaId`
  · ← San Checkout
  · **cliente sabe:** politica-de-privacidade.html L56 declara o repasse: "San Checkout / Asaas — processamento do pagamento (recebe nome, CPF/CNPJ, e-mail e telefone do pagador para gerar a cobrança)". Correto e completo.

**POST /webhook/san-checkout — a única volta real do dinheiro** — Autenticado por HMAC-SHA256 sobre "{timestamp}.{corpo cru}" nos headers X-Checkout-Signature + X-Checkout-Timestamp (janela de 300s, corpo cru vindo do verify do express.json em src/server.js L91, comparação em tempo constante). Responde 200 imediato e…
  · `src/financeiro/routes.js (L244-252)`, `src/financeiro/san-checkout.js (webhookAutorizado L40-63, chaveDoEvento L208-220, processarWebhookAssinatura L222-261, aplicarCicloPago L267-353)`, `src/server.js (L89-91)` · rotas: `POST /webhook/san-checkout`
  · ← San Checkout  → enviarConfirmacaoPagamento
  · **cliente sabe:** Nada em tempo real. Toda a comunicação do resultado do pagamento depende deste webhook chegar — e se ele falhar na dedupe (sem chargeId), o pagamento vira pendência e o cliente não recebe e-mail…

**conciliarAssinaturas() — npm run conciliar** — Varre todas as assinaturas status='ativa' de contas não excluídas, chama consultarAssinatura (POST /api/checkout/consultar-assinatura) e, se ultimaCobranca.status === 'confirmado' com chargeId, aplica o ciclo pela MESMA dedupe do webhook. É a rede de…
  · `src/financeiro/conciliacao.js (conciliarAssinaturas L18-58)`, `src/financeiro/san-checkout.js (consultarAssinatura L90-95, aplicarCicloPago L267)`
  · ← San Checkout (pull, não push)
  · **cliente sabe:** docs/funcional.md §7 promete "nada — a conta ativa sozinha em até 24h". Na prática: até 24h de silêncio absoluto para quem pagou, e hoje, sem o cron, silêncio indefinido.

**cancelarAssinatura(assinaturaId, documento) — saída para a API do Checkout** — POST para ${SAN_CHECKOUT_API_URL}/api/checkout/cancelar-assinatura com {planoId, documento}. Dois chamadores: POST /titular/arrependimento (o cliente exercendo o direito de 7 dias, src/titular/routes.js L113) e a rota de cancelamento do admin…
  · `src/financeiro/san-checkout.js (L358-362)`, `src/titular/routes.js (L108-120)`, `src/financeiro/routes.js (L302-307)` · rotas: `POST /titular/arrependimento`, `(rota admin de cancelamento em src/financeiro/routes.js)` · papéis: anunciante, admin
  · → San Checkout (API)
  · **cliente sabe:** Se falhar: 502 com "não conseguimos cancelar a cobrança agora — tente de novo em alguns minutos" (titular) / "falha ao cancelar no San Checkout" (admin). O cliente não recebe instrução alternativa (a…

**Estorno — executado FORA do sistema, no painel do Checkout/Asaas** — A API do San Checkout não expõe estorno. O POST /titular/arrependimento cancela a recorrência, suspende a conta, tira o anúncio do ar e REGISTRA a obrigação numa fila (GET /admin/arrependimentos). Devolver o dinheiro é uma pessoa abrindo o painel do Asaas e…
  · `src/titular/routes.js (L79-141, fila L145+)`, `public/admin/index.page.js (L1613-1650)` · rotas: `POST /titular/arrependimento`, `GET /admin/arrependimentos`, `POST /admin/arrependimentos/:id/estornado` · papéis: anunciante, admin
  · → painel do San Checkout/Asaas (fora de tudo)
  · **cliente sabe:** Só o e-mail de enviarArrependimentoRecebido ("alguns dias úteis"). Não há tela onde o cliente acompanhe o andamento da devolução: GET /titular/arrependimento devolve {pedido} mas não há estado…

**POST /candidaturas — a promessa de WhatsApp sem nenhum disparo** — Grava a candidatura de ponto ou de vendedor e devolve {ok:true, id}. NÃO envia e-mail para ninguém, NÃO avisa o admin, NÃO cria nenhuma notificação. A única forma de o dono saber que alguém se candidatou é abrir GET /admin/candidaturas e olhar.
  · `src/candidaturas/routes.js (L8-17)`, `public/seja-um-ponto.page.js`, `public/seja-um-vendedor.page.js` · rotas: `POST /candidaturas`, `GET /admin/candidaturas`, `PATCH /admin/candidaturas/:id` · papéis: público
  · **cliente sabe:** seja-um-ponto.html L142 e seja-um-vendedor.html L98 prometem "A gente chama no WhatsApp <telefone> em até 2 dias úteis". Nada no código garante isso: não há e-mail para o admin, não há lembrete, não…

**linkDoConvite(token) — entregue à mão pelo WhatsApp** — Monta ${SITE_URL||CORS_ORIGIN}/convite.html?t=<token>. POST /admin/convites devolve o link na resposta para o admin COPIAR. Não existe nenhuma função de e-mail de convite: a entrega é 100% manual, pelo WhatsApp do dono (docs/funcional.md §2.2 passo 3: "recebe…
  · `src/convites/routes.js (linkDoConvite L6-9, POST /admin/convites L25-42, GET /admin/convites L20-23)`, `public/convite.html`, `public/convite.page.js` · rotas: `POST /admin/convites`, `GET /admin/convites`, `GET /convites/:token`, `POST /convites/:token/aceitar` · papéis: admin (gera), ponto, vendedor (recebe)
  · **cliente sabe:** Se o link expirar ou já tiver sido usado, convite.html L32: "Fale com quem te enviou pra receber um link novo, ou chame no WhatsApp" — com data-wa próprio. É bem resolvido. O que não existe é…

**PATCH /admin/anunciantes/:id — aprovação da conta, em silêncio** — Muda o status da conta (inclusive de 'pendente_aprovacao' para 'aprovado'/'ativo') e registra o evento conta:aprovacao_recebe só na transição. NÃO dispara e-mail nenhum — grep confirma que src/anunciantes/routes.js não importa src/financeiro/email.js. É o…
  · `src/anunciantes/routes.js (L533-554)`, `src/financeiro/email.js (não importado aqui)` · rotas: `PATCH /admin/anunciantes/:id` · papéis: admin
  · **cliente sabe:** CONTRADIÇÃO TRIPLA, e nenhuma das três versões é verdade: docs/funcional.md L346 diz "Conta criada. Avisaremos por e-mail quando ela for aprovada"; public/anunciante/cadastro.html L135 diz "Você…

**Pedidos de modo (ponto/vendas) de dentro do painel — WhatsApp prometido, sem link e sem aviso** — POST /conta/modos/ponto/pedir, POST /conta/modos/vendedor/pedir e POST /conta/bonus/ponto/resgatar criam candidaturas com origem 'painel'/'bonus_plano'. Nenhum dos três envia e-mail para o admin nem para o cliente. A tela mostra "Pedido enviado — a gente…
  · `public/modos.js (card ponto L70-80, card vendedor L101-110, mensagem de sucesso L171, fallback L141)`, `src/conta/modos.js (L132: 409 "você já tem um pedido em análise — a gente chama no WhatsApp")`, `public/anunciante/ponto.page.js (L132)` · rotas: `POST /conta/modos/ponto/pedir`, `POST /conta/modos/vendedor/pedir`, `POST /conta/bonus/ponto/resgatar`, `GET /conta/modos` · papéis: anunciante, ponto, vendedor
  · **cliente sabe:** Cinco variações de "a gente chama no WhatsApp" (modos.js L80, L109, L141, L171; ponto.page.js L132; src/conta/modos.js L132) e NENHUMA delas é um link — são texto puro. O cliente que quiser adiantar…

**Fallbacks que mandam para o WhatsApp quando a API falha** — Quando o carregamento de planos falha, a tela degrada para uma frase que empurra para fora do site. Três ocorrências: public/convite.page.js L110 "Não deu pra carregar as opções agora — a gente combina no WhatsApp"; public/modos.js L141 "Não deu pra carregar…
  · `public/convite.page.js (L110)`, `public/modos.js (L141)`, `public/contato.page.js (L18)` · papéis: público, anunciante, ponto, vendedor
  · **cliente sabe:** Manda para o WhatsApp sem dar o caminho. O FAB está na página, mas o texto não o aponta.

**perfil.js — exclusão de conta remete ao WhatsApp** — confirm() antes de POST /anunciantes/me/excluir (soft-delete, 60 dias recuperável). O texto do confirm manda falar com o suporte pelo WhatsApp para recuperar dentro do prazo — e não há nenhuma rota de autoatendimento para isso.
  · `public/perfil.js (L195)` · rotas: `POST /anunciantes/me/excluir` · papéis: anunciante, ponto, vendedor
  · **cliente sabe:** "Ela fica recuperável por 60 dias — depois disso é apagada de vez. Pra recuperar dentro desse prazo, fale com o suporte pelo WhatsApp." — dentro de um window.confirm(), onde não cabe link.…

**Estados sem tela:** O CLIENTE SAI PARA PAGAR E NÃO HÁ VOLTA. linkCheckoutAssinatura (src/financeiro/san-checkout.js L70-72) monta a URL com… · NÃO EXISTE PÁGINA DE RETORNO PÓS-PAGAMENTO. public/ não tem obrigado.html, sucesso.html, pagamento.html, retorno.html… · QUEM APERTA VOLTAR DEPOIS DE PAGAR CAI NO PAINEL SEM SABER SE PAGOU. window.location.href (painel.page.js L159)… · O E-MAIL DE PAGAMENTO CONFIRMADO NÃO TEM LINK E DIZ A COISA ERRADA. email.js L19-30: cita 'seu painel' sem URL (é o… · ENTRE PAGAR E SER AVISADO PODE HAVER 24H DE SILÊNCIO — OU SILÊNCIO INDEFINIDO. O e-mail só sai por aplicarCicloPago,… · APROVAÇÃO DA CONTA É MUDA, E OS DOIS DOCUMENTOS SE CONTRADIZEM. PATCH /admin/anunciantes/:id (src/anunciantes/routes.js… · CANDIDATURA DE PONTO E DE VENDEDOR: PRAZO PROMETIDO SEM NENHUMA INFRAESTRUTURA. POST /candidaturas… · NOVE 'A GENTE CHAMA NO WHATSAPP' SEM LINK E SEM DISPARO. modos.js L80, L109, L141, L171; ponto.page.js L132;… · PEDIR A ARTE PELO WHATSAPP NÃO DEIXA RASTRO NO SISTEMA. montarPortasDeArte (painel.page.js L11-25) abre o WhatsApp com… · O LINK 'Fale no WhatsApp' DE seja-um-vendedor.html L103 NÃO TEM data-wa. É o único link wa.me da Mostraí que escapa de… · O ESTORNO NÃO TEM ACOMPANHAMENTO PARA O CLIENTE. Depois de enviarArrependimentoRecebido ('alguns dias úteis'), o… · VENDEDOR MANDA O CUPOM E NUNCA SABE O QUE ACONTECEU. #btnWhats (vendedor.page.js L44) sai para o WhatsApp do próprio…

**Notas:**
- remetente() (email.js L11-13) tem fallback para process.env.VITRINA_EMAIL_FROM — nome herdado do projeto ancestral (Vitrina) e NÃO documentado em .env.example, que só lista MOSTRAI_EMAIL_FROM. Se MOSTRAI_EMAIL_FROM faltar, o From vira undefined e o nodemailer falha em silêncio (todos os envios são…
- transportador() (email.js L3-9) cria um transporte novo a cada e-mail, sem pool, sem `secure`, sem `requireTLS` e sem transporter.verify(). Com SMTP_PORT=465 (SMTPS implícito) o nodemailer só usa TLS se `secure:true` — que não está lá. Vale checar antes do deploy, já que 4 dos 5 envios engolem o…
- enviarArrependimentoRecebido é chamado com `.catch(() => {})` (src/titular/routes.js L138) — o único catch do repositório que não loga nada. Um SMTP fora do ar apaga completamente o rastro de um direito exercido sob o CDC art. 49; só o registro em banco sobrevive, e o admin perde o CC que o…
- enviarNovidade é a única função de e-mail com checagem de consentimento (comunicacoes_revogado_em, LGPD art. 8 §5) e é a única sem chamador — por desenho declarado no comentário. Seu rodapé manda 'abra seu perfil no painel e desmarque receber novidades' em vez de um link de descadastro de um…
- Todas as rotas estão montadas na RAIZ, sem prefixo /api (src/server.js L154-166), e public/config.js define API_BASE_URL = window.location.origin nos dois ambientes. Os nomes de rota neste mapa são os reais, como aparecem em docs/api.md.
- O e-mail é o único canal automatizado do sistema. WhatsApp é 100% manual em ambos os sentidos: o cliente clica num wa.me, ou o dono clica no wa.me do cliente a partir de public/admin/index.page.js L918. Não existe integração com API do WhatsApp em lugar nenhum do repositório.
- docs/funcional.md tem duas afirmações que o código não sustenta: L346 ('Avisaremos por e-mail quando ela for aprovada') e L376 ('a página de status consulta o Checkout'). Ambas descrevem coisas que não existem — vale corrigir o documento junto com a construção, para não fechar a Estação 5 com a…


---

## Conteúdo informativo

Superfície informativa pública do Mostraí: 10 páginas HTML em `/home/user/MostrAi/public/` (index, planos, pontos, seja-um-ponto, seja-um-vendedor, comodato, contato, contrato-anunciante, termos-de-uso, politica-de-privacidade), mais `/anunciante/cadastro.html` e `/anunciante/login.html` como portas de conversão. Todas declaram `<body data-layout="publico">` e recebem cabeçalho/rodapé/FAB de WhatsApp de `public/layout.js` em runtime. O menu público é a constante `MENU_PUBLICO` em `public/layout.js` (7 itens: /, /planos.html, /pontos.html, /anunciante/cadastro.html, /seja-um-ponto.html, /seja-um-vendedor.html, /contato.html) — `comodato.html`, `contrato-anunciante.html`, `termos-de-uso.html`…

**index.html — home** — RESPONDE: o que é a Mostraí, para quem serve (3 papéis), por que tela em sala de espera funciona, e quais são os 3 passos até o anúncio no ar (Crie sua conta / Suba seu criativo 15-30s em 9:16 / Acompanhe o resultado). NÃO RESPONDE: quanto custa (nenhum preço…
  · `public/index.html`, `public/index.page.js`, `public/layout.js` · rotas: `GET /pontos/fluxo` · papéis: visitante, anunciante, ponto, vendedor
  · ← logo do cabeçalho (layout.js) / item 'Home' do MENU_PUBLICO  → /anunciante/cadastro.html / /seja-um-ponto.html / /seja-um-vendedor.html
  · **cliente sabe:** O visitante sai sabendo o que é o produto, os três papéis e o formato do criativo (15-30s, 9:16). Sai sem saber preço, sem saber que a conta passa por aprovação, e com um valor de comodato (R$ 50 /…

**planos.html — vitrine de preços** — RESPONDE: quanto custa por ciclo e por mês, quantas vezes por hora o anúncio roda em cada tela (`frequencia_hora`, com a estimativa '≈Nx por dia' feita em `planos.page.js`), quanto se economiza escolhendo ciclo maior, quais benefícios cada plano dá (array…
  · `public/planos.html`, `public/planos.page.js`, `src/financeiro/routes.js` · rotas: `GET /planos`, `GET /pontos/fluxo`, `POST /anunciantes/:id/assinar (indireto, via painel)` · papéis: visitante, anunciante
  · ← index.html (2 CTAs) / MENU_PUBLICO 'Planos' / menu da conta logada (layout.js navConta)  → /anunciante/cadastro.html?plano=ID / /anunciante/painel.html?plano=ID
  · **cliente sabe:** Preço, frequência e ciclo ficam claros. Fica fora: limite de criativos, preço travado nos planos normais, imutabilidade do plano assinado, cancelamento, nota fiscal, atraso e arrependimento.

**pontos.html — onde estamos** — RESPONDE: onde ficam as telas hoje (cards com nome, cidade, endereço e link para o Google Maps, montados em `pontos.page.js` a partir de `GET /pontos`), quantos pontos estão ativos, quantos em instalação, quantas cidades, e quantas pessoas por mês a rede…
  · `public/pontos.html`, `public/pontos.page.js`, `src/pontos/repository.js` · rotas: `GET /pontos`, `GET /pontos/fluxo` · papéis: visitante, anunciante, ponto
  · ← MENU_PUBLICO 'Onde estamos?'  → /seja-um-ponto.html / Google Maps (link externo por ponto)
  · **cliente sabe:** O visitante vê a rede real e a prova social. Recebe uma promessa de não pagar por exibição não entregue que o produto não cumpre e que os Termos negam.

**seja-um-ponto.html — candidatura de estabelecimento** — RESPONDE: o que o comércio ganha (tela, player e instalação de graça, anúncio próprio, bloqueio de concorrente, visita combinada antes), o que precisa dar (parede e tomada) e como é o processo em 3 passos (formulário → WhatsApp → link para criar conta). NÃO…
  · `public/seja-um-ponto.html`, `public/seja-um-ponto.page.js`, `public/formulario.js` · rotas: `POST /candidaturas (tipo: 'ponto')`, `GET /categorias` · papéis: visitante, ponto
  · ← index.html (hero + card 'Ponto') / pontos.html (CTA final) / MENU_PUBLICO 'Seja um ponto'  → /politica-de-privacidade.html / wa.me/5516994635946 / /
  · **cliente sabe:** O comerciante entende a proposta e envia a candidatura sem criar conta. Não escolhe modalidade, não vê valores vindos do banco e não aceita o comodato — o que quebra a premissa de `comodato.html`.

**seja-um-vendedor.html — candidatura de vendedor** — RESPONDE: que existe cupom próprio, que a comissão é recorrente ('em cada cobrança, enquanto o cliente ficar'), que se paga por Pix, que há painel com indicados e valores, e que não tem meta nem custo de entrada. NÃO RESPONDE: **qual é o percentual** da…
  · `public/seja-um-vendedor.html`, `public/seja-um-vendedor.page.js`, `public/anunciante/vendedor.page.js` · rotas: `POST /candidaturas (tipo: 'vendedor')`, `GET /vendedor/painel (só depois do login)`, `PATCH /vendedor/me` · papéis: visitante, vendedor
  · ← index.html (hero + card 'Vendedor parceiro') / MENU_PUBLICO 'Seja um vendedor'  → /politica-de-privacidade.html / /anunciante/login.html / wa.me/5516994635946
  · **cliente sabe:** O vendedor entende o modelo, mas não descobre o número que decide a adesão dele: o percentual. Ele só aparece depois de aprovado e logado.

**comodato.html — contrato de comodato** — RESPONDE: de quem é o equipamento (da Mostraí), quais são as duas modalidades de contrapartida, quais são as obrigações dos dois lados, prazo (1 ano, sem renovação automática), rescisão (30 dias, sem multa), furto/roubo e foro. NÃO RESPONDE: **os valores** —…
  · `public/comodato.html`, `public/seja-um-ponto.html`, `public/convite.page.js` · papéis: ponto
  · ← rodapé (layout.js) / convite.page.js (quando o convite inclui o papel ponto) / sitemap.xml  → /termos-de-uso.html / mailto:mostrai@sancocore.com.br
  · **cliente sabe:** Quem chega pelo rodapé entende o contrato inteiro. Quem chega por 'Seja um ponto' nunca vê esta página: `seja-um-ponto.html` não tem um único link para `/comodato.html`, e `comodato.html` não tem um…

**contato.html — canal aberto** — RESPONDE: como falar com a Mostraí (formulário nome/WhatsApp/e-mail/mensagem, WhatsApp direto, e-mail mostrai@sancocore.com.br) e que o WhatsApp responde em horário comercial. NÃO RESPONDE: que este é o canal do titular de dados (docs/funcional.md §8 o define…
  · `public/contato.html`, `public/contato.page.js`, `src/conta/routes.js` · rotas: `POST /contato` · papéis: visitante, anunciante, ponto, vendedor
  · ← MENU_PUBLICO 'Contato' / politica-de-privacidade.html (indiretamente, pelo e-mail)  → wa.me/5516994635946 / mailto:mostrai@sancocore.com.br
  · **cliente sabe:** Serve como canal comercial. Não se apresenta como o canal de LGPD que a documentação diz que ele é, e não promete prazo de resposta para quem escreve pelo formulário.

**contrato-anunciante.html — contrato de prestação de serviços** — RESPONDE: quem contrata com quem (pessoa física CPF 552.085.198-01 até a SLU ME sair), que o contrato é cedido automaticamente ao CNPJ, que a vigência só começa quando o primeiro ponto entra no ar ('aguardando ponto', sem cobrança na espera), que o pagamento…
  · `public/contrato-anunciante.html`, `src/db/migrations/021_remove_cobertura_adiada.sql`, `src/financeiro/routes.js` · rotas: `POST /webhook/san-checkout (cita o efeito)`, `PATCH /admin/cobrancas/:id/nota-fiscal` · papéis: anunciante
  · ← rodapé (layout.js) / checkbox de aceite em /anunciante/cadastro.html linha 132 / convite.page.js linha 89  → /planos.html / /termos-de-uso.html / mailto:mostrai@sancocore.com.br
  · **cliente sabe:** É o único lugar que conta duas coisas decisivas: que não se emite nota fiscal nesta fase e que o anúncio cai no dia seguinte ao vencimento. Nenhuma das duas aparece em index.html ou planos.html.

**termos-de-uso.html — termos** — RESPONDE: quem opera, o que rege a conta, como funciona a cobrança recorrente por ciclo, como se cancela (por solicitação ao administrador, valendo do próximo ciclo), o arrependimento de 7 dias com devolução integral (art. 49 CDC, RN-26), a política de…
  · `public/termos-de-uso.html`, `public/perfil.js`, `src/titular/routes.js` · rotas: `POST /titular/arrependimento`, `GET /titular/arrependimento`, `PATCH /admin/criativos/:id`, `POST /admin/anunciantes/:id/cancelar-assinatura` · papéis: anunciante, vendedor
  · ← rodapé (layout.js) / checkbox de aceite em /anunciante/cadastro.html / comodato.html §5.4  → /planos.html / mailto:mostrai@sancocore.com.br
  · **cliente sabe:** É a página que mais conta regra real de produto — e é a menos visitada (rodapé). O arrependimento de 7 dias, que é argumento de venda, só existe aqui e na Política.

**politica-de-privacidade.html — LGPD** — RESPONDE: quem é o controlador, que dados são coletados por papel (anunciante, vendedor, ponto, criativos, dados de uso, pagamento), para que servem, com quem são compartilhados (San Checkout/Asaas, Supabase, Google Drive), por quanto tempo ficam, os direitos…
  · `public/politica-de-privacidade.html`, `public/perfil.js`, `src/titular/routes.js` · rotas: `GET /titular/meus-dados`, `POST /titular/consentimento`, `POST /anunciantes/me/excluir`, `POST /titular/arrependimento` · papéis: titular de dados, anunciante, ponto, vendedor
  · ← rodapé (layout.js) / checkbox de aceite em /anunciante/cadastro.html / checkbox de aceite em /seja-um-ponto.html  → mailto:mostrai@sancocore.com.br
  · **cliente sabe:** É a página mais completa e mais fiel ao código. Ironia da superfície: os recursos de autoatendimento mais valiosos do produto (exportar dados, arrependimento) só são anunciados aqui, numa página…

**BURACO — anúncio simples incluído no plano e gravação por produtora parceira (RN-22)** — O sistema oferece duas portas de arte para quem não tem criativo: 'Pedir um anúncio simples' (incluído no plano) e 'orçar a gravação de um vídeo' (produtora parceira, à parte). É a resposta para a objeção nº 1 de um comerciante pequeno — 'eu não tenho vídeo'.…
  · `public/anunciante/painel.html`, `public/anunciante/painel.page.js`, `src/anunciantes/routes.js` · rotas: `POST /admin/anunciantes/:id/criativos` · papéis: anunciante
  · **cliente sabe:** NADA. index.html passo 2 ('Suba seu criativo') pressupõe que o cliente já tem a peça pronta; planos.html não lista 'anúncio simples incluído' em nenhum benefício. Só se descobre depois de pagar e…

**BURACO — comprovante de veiculação em CSV (RN-19)** — `GET /anunciantes/:id/exibicoes.csv?dias=N` gera o proof of play do período escolhido (1 a 365 dias), com `;` e BOM UTF-8 para abrir no Excel em português. É o documento que um anunciante usa para justificar a verba.
  · `src/anunciantes/routes.js`, `public/anunciante/painel.page.js` · rotas: `GET /anunciantes/:id/exibicoes.csv` · papéis: anunciante
  · **cliente sabe:** Quase nada. index.html promete 'dashboard'; a única menção pública à expressão 'proof of play' está em termos-de-uso.html §8 — dentro da cláusula que limita responsabilidade, não como benefício.

**BURACO — preço travado do anunciante (RN-11)** — A conta paga para sempre o valor de quando entrou (`anunciantes.valor_mensal_travado`, campo `planos.preco_travado`), mesmo que a grade suba. `planos.page.js` imprime 'Preço travado por N meses' apenas no card de fundador (`renderFundador`); a função…
  · `public/planos.page.js`, `src/financeiro/planos-repository.js`, `src/anunciantes/repository.js` · rotas: `GET /planos`, `POST /webhook/san-checkout` · papéis: anunciante
  · **cliente sabe:** Só para o plano fundador. Quem assina um dos 12 planos normais não é informado de que o preço dele não sobe.

**BURACO — plano assinado é imutável para quem assinou (RN-27)** — Campos de contrato (`nome`, `valor_mensal`, `frequencia_hora`, `cobertura`, `limite_criativos`, benefícios) não se editam: publica-se versão nova com id novo e a antiga é aposentada; quem já assinou fica na versão antiga. É uma garantia forte de estabilidade…
  · `src/financeiro/routes.js`, `src/db/migrations/026_planos_versionados.sql` · rotas: `POST /admin/planos/:id/nova-versao`, `PATCH /admin/planos/:id`, `GET /admin/planos-arquivados` · papéis: anunciante, administrador
  · **cliente sabe:** NADA. Nem planos.html, nem termos-de-uso.html, nem contrato-anunciante.html mencionam. O cliente não sabe que está protegido contra mudança de plano.

**BURACO — as opções de comodato vindas do banco (GET /planos-ponto)** — A rota pública `GET /planos-ponto` devolve as modalidades reais ('ajuda-custo': R$ 50/mês + 1 slot/hora; 'mais-cota': R$ 0 + 3 slots/hora — migration 015 linhas 92-100), com `chamada` e array `beneficios` prontos para exibir. É consumida apenas por…
  · `src/pontos/routes.js`, `src/pontos/planos-ponto-repository.js`, `src/db/migrations/015_beneficios_categorias_planos_ponto.sql` · rotas: `GET /planos-ponto` · papéis: ponto
  · **cliente sabe:** NADA numa página pública. index.html repete os valores à mão no HTML e comodato.html descreve as modalidades em prosa; nenhuma das duas lê o banco, então uma edição em /admin/planos-ponto não muda o…

**BURACO — módulo cruzado: ponto que ganha meses de anúncio grátis (planos_ponto.plano_bonus_*)** — Depois de N meses como ponto no ar, o estabelecimento ganha M meses de um plano de anunciante sem cobrança (`POST /conta/bonus/anuncio/resgatar`). Renderizado só em `public/modos.js` linha 137 e no card de bônus da linha 223.
  · `public/modos.js`, `src/conta/modos.js`, `src/db/migrations/020_modos_da_conta_e_modulos_de_plano.sql` · rotas: `POST /conta/bonus/anuncio/resgatar`, `PATCH /admin/planos-ponto/:id` · papéis: ponto
  · **cliente sabe:** NADA. seja-um-ponto.html e comodato.html não citam. É o argumento mais forte para o comerciante e ele só o vê depois de já estar dentro.

**BURACO — extrato de pagamento do ponto (RN-20)** — `GET /anunciantes/me/pontos/extrato` mostra ao dono do ponto o que já foi pago e o que está em aberto, um lançamento por ponto por mês (`pagamentos_ponto`, UNIQUE da migration 022). Resolve a pergunta 'eles pagaram o mês passado?' sem ninguém precisar…
  · `src/pontos/routes.js`, `src/pontos/pagamentos-repository.js`, `public/anunciante/ponto.page.js` · rotas: `GET /anunciantes/me/pontos/extrato`, `POST /admin/pontos/:pontoId/pagamentos`, `PATCH /admin/pagamentos-ponto/:id` · papéis: ponto
  · **cliente sabe:** NADA. seja-um-ponto.html promete 'painel pra acompanhar a tela' sem dizer que o painel também é o comprovante financeiro do comodato.

**BURACO — painel da tela por PIN, na própria TV (RN-08)** — Cinco toques no canto superior direito (ou tecla P) no player pedem o PIN de 4 a 6 dígitos e abrem o painel daquela tela: o que rodou, por anunciante e por dia (`POST /player/:dispositivoId/painel`). É a funcionalidade que o dono do ponto mais usaria no dia a…
  · `public/player.page.js`, `src/dispositivos/routes.js` · rotas: `POST /player/:dispositivoId/painel`, `POST /admin/dispositivos/:id/pin` · papéis: ponto
  · **cliente sabe:** NADA. Nenhuma página pública menciona PIN, painel na TV ou sinal da tela.

**BURACO — exclusão de conta é soft-delete recuperável por 60 dias (RN-15)** — `POST /anunciantes/me/excluir` some com a conta na hora e o suporte consegue restaurar dentro de 60 dias. O único texto que diz isso está no `confirm()` de `public/perfil.js` linha 195 e na tabela de textos de docs/funcional.md §6.
  · `public/perfil.js`, `src/anunciantes/routes.js` · rotas: `POST /anunciantes/me/excluir` · papéis: anunciante, ponto, vendedor
  · **cliente sabe:** NADA. politica-de-privacidade.html §5 fala em retenção genérica e não cita os 60 dias; termos-de-uso.html §3 fala em suspensão, não em exclusão pelo titular.

**BURACO — conta única com três papéis e ativação de modo pelo painel** — A mesma conta acumula os papéis anunciante/ponto/vendedor (`anunciantes.papeis text[]`), e de dentro do painel dá para pedir a ativação de outro modo: `POST /conta/modos/anunciante`, `POST /conta/modos/ponto/pedir`, `POST /conta/modos/vendedor/pedir`, com o…
  · `src/conta/modos.js`, `src/conta/routes.js`, `public/modos.js` · rotas: `GET /conta/modos`, `POST /conta/modos/anunciante`, `POST /conta/modos/ponto/pedir`, `POST /conta/modos/vendedor/pedir` · papéis: anunciante, ponto, vendedor
  · **cliente sabe:** NADA. index.html apresenta os três papéis como três CTAs distintos, o que sugere três cadastros distintos. Ninguém conta ao anunciante que ele pode virar ponto, nem ao ponto que ele pode virar…

**BURACO — bônus 'tela no seu comércio após N meses' explicado só no card do plano** — `planos.ponto_apos_meses` gera direito a uma tela instalada no comércio do anunciante (`POST /conta/bonus/ponto/resgatar`, candidatura `origem=bonus_plano`). `planos.page.js` imprime como um `<li>` em negrito dentro do card.
  · `public/planos.page.js`, `src/conta/routes.js`, `public/modos.js` · rotas: `POST /conta/bonus/ponto/resgatar`, `GET /conta/modos` · papéis: anunciante
  · ← planos.html
  · **cliente sabe:** PARCIAL. Aparece como uma linha de benefício em planos.html e em lugar nenhum mais — nem na home, nem em pontos.html, nem em seja-um-ponto.html, embora seja o cruzamento entre os dois públicos.

**RESOLVIDO em 16/09/2026 (migration 038) — aprovação da conta antes de anunciar** — Não existe mais `pendente_aprovacao`: a migration 038 (16/09/2026) reduziu `anunciantes.status` a só `comum`/`parceiro`, sem sentido operacional. Toda conta nasce liberada; quem bloqueia operação hoje é o campo `suspenso`, separado. Este buraco não existe mais.

**RESOLVIDO em 16/09/2026 — o que acontece quando o pagamento atrasa, e como se cancela** — Atraso: o anúncio sai do ar na virada do dia seguinte e volta sozinho quando o pagamento é identificado (contrato §5), sem mudança. Cancelamento: agora também `POST /anunciantes/me/cancelar-assinatura`, pelo próprio cliente, com botão no painel — não é mais só o admin.
  · `public/contrato-anunciante.html`, `public/termos-de-uso.html`, `src/financeiro/routes.js`, `public/anunciante/painel.page.js` · rotas: `POST /admin/anunciantes/:id/cancelar-assinatura`, `POST /anunciantes/me/cancelar-assinatura`, `POST /webhook/san-checkout` · papéis: anunciante, administrador
  · **cliente sabe:** Agora sim — botão "Cancelar assinatura" no painel. `planos.page.js` (FAQ "Como eu cancelo?") já batia com o comportamento real desde a rodada anterior.

**BURACO — nota fiscal** — Cobranças carregam `nota_fiscal_status` e `nota_fiscal_url`, marcadas manualmente por `PATCH /admin/cobrancas/:id/nota-fiscal` (segue existindo, lado admin intacto). O que mudou em 19/09/2026 (pedido do dono, "não será enviada nada mesmo e quando for possivel enviaremos pelo email direto automaticamente"): a tabela "Meus pagamentos" do painel do anunciante PAROU de mostrar a coluna Nota fiscal — `GET /anunciantes/:id/exibicoes` nem seleciona mais os dois campos (`src/anunciantes/routes.js`). Nenhuma nota é emitida hoje; quando passar a ser possível, o plano é mandar por e-mail direto, não reabrir um link nesta tabela. Enquanto não houver CNPJ, não há emissão (contrato §1).
  · `src/financeiro/routes.js`, `src/anunciantes/routes.js`, `public/anunciante/painel.page.js`, `public/contrato-anunciante.html` · rotas: `PATCH /admin/cobrancas/:id/nota-fiscal`, `GET /anunciantes/:id/exibicoes` · papéis: anunciante, administrador
  · **cliente sabe:** Só em contrato-anunciante.html §1, em letra de contrato. Para um comprador PJ, 'tem nota?' é pergunta de primeira conversa e nenhuma página de venda responde.

**BURACO — limite de criativos por plano** — `planos.limite_criativos` vem em `GET /planos`, e `limiteDeCriativos()` (src/playlist/gerador.js) aplica teto duro de 3 por conta de cliente. O painel conta os criativos ativos (`painel.page.js` linha 265).
  · `src/playlist/gerador.js`, `public/planos.page.js`, `public/anunciante/painel.page.js` · rotas: `GET /planos`, `POST /anunciantes/:id/criativos` · papéis: anunciante
  · **cliente sabe:** NADA. index.html promete 'você troca o anúncio quando quiser' sem dizer quantas peças podem coexistir. O campo já chega no navegador em planos.html e não é impresso.

**BURACO — especificação real do criativo aceita pelo servidor** — `POST /anunciantes/:id/criativos` aceita qualquer `image/*` ou `video/*` até 200 MB (multer em src/anunciantes/routes.js linha 27) e normaliza para 1080x1920 (src/lib/ffmpeg.js): vídeo fora de 9:16 ganha fundo desfocado; imagem fora de 9:16 ganha `pad` sem…
  · `src/lib/ffmpeg.js`, `src/anunciantes/routes.js`, `public/index.html` · rotas: `POST /anunciantes/:id/criativos` · papéis: anunciante
  · **cliente sabe:** PARCIAL E IMPRECISO. index.html pede '15 a 30 segundos, 9:16' (nada disso é validado) e pontos.html promete 'sem borda preta e sem corte' (falso para imagem fora de proporção, verdadeiro para vídeo).…

**BURACO — página pública que explique o player e o que a TV precisa** — O player (`/player.html`, `public/player.page.js`) autentica por chave de aparelho, toca a playlist da hora, confirma cada exibição (`POST /player/:dispositivoId/played`), manda heartbeat e cai para tela institucional quando a playlist está vazia. Precisa de…
  · `public/player.html`, `public/player.page.js`, `src/player/routes.js` · rotas: `GET /playlist/:dispositivoId`, `POST /player/:dispositivoId/played`, `POST /player/:dispositivoId/heartbeat` · papéis: tela (aparelho), ponto
  · **cliente sabe:** NADA. seja-um-ponto.html diz 'Zero custo, zero trabalho… você só cede a parede e a tomada', mas comodato.html §4.4 obriga o estabelecimento a garantir e custear a internet do local. As duas páginas…

**Estados sem tela:** planos.html — aba 'Mensal' sem nenhum plano: os 4 planos de 1 mês nascem `ativo = false` no seed… · planos.html — vitrine inteira vazia: docs/funcional.md §4 exige 'os planos estão sendo atualizados, fale com a gente'.… · planos.html — rótulo de desconto dos botões de ciclo: `atualizarDescontos()` calcula o percentual contra… · planos.html — programa fundador fechado ou sem vaga: `#fundadorBloco` simplesmente fica `hidden` (renderFundador). Não… · planos.html — nenhum estado de carregamento: docs/funcional.md §4 pede 'esqueleto dos cards'; o `#plansGrid` nasce… · pontos.html — rede com zero pontos: o grid mostra 'Nenhum ponto ativo ainda — em breve', mas o `#statRow` continua… · pontos.html — ponto com status 'inativo': `listarPublicos` não devolve, o card some sem aviso, e nenhum texto explica a… · pontos.html — sem estado de carregamento real além do texto 'Carregando pontos...' e nenhum estado para `GET… · seja-um-ponto.html e seja-um-vendedor.html — candidatura repetida: `POST /candidaturas` não deduplica por… · seja-um-ponto.html — não existe estado de escolha de modalidade de comodato (ajuda de custo × mais cota): o formulário… · contato.html — sem estado de 'prazo de resposta' para o formulário (o WhatsApp promete minutos, o formulário não… · comodato.html, contrato-anunciante.html, termos-de-uso.html, politica-de-privacidade.html — 'Última atualização:…

**Notas:**
- CONTRADIÇÃO 1 (a mais grave, comercial e jurídica): public/pontos.html afirma 'Se algum ponto cai, ele sai da conta — você não paga por exibição que não aconteceu'. Não existe crédito, pró-rata ou abatimento em nenhum ponto de src/ (busca por pro.rata/prorata/abatimento/credito por offline: zero…
- CONTRADIÇÃO 2: public/planos.page.js, NOTA_CICLO[1], diz 'Sem compromisso: cobrança todo mês, cancele quando quiser'. public/termos-de-uso.html §4.4 diz que o cancelamento é por solicitação ao administrador, que não existe self-service no provedor de pagamento, e que só produz efeito no próximo…
- CONTRADIÇÃO 3: public/comodato.html §3 afirma que 'os valores e a quantidade de espaços de cada modalidade são os exibidos no formulário Seja um ponto no momento do cadastro' e o parágrafo final afirma que o estabelecimento marca 'Aceito os termos do comodato' nesse formulário.…
- CONTRADIÇÃO 4: public/seja-um-ponto.html promete 'Zero custo, zero trabalho — você só cede a parede e a tomada'. public/comodato.html §4.4 obriga o comodatário a garantir internet no local 'cujo custo de conexão em si é do estabelecimento' e §4.1 a manter o equipamento ligado e conectado durante…
- CONTRADIÇÃO 5 (navegação): docs/funcional.md §3 registra que a tela Comodato 'leva para seja-um-ponto'. public/comodato.html não tem nenhum link para /seja-um-ponto.html (só para /termos-de-uso.html e o mailto), e public/seja-um-ponto.html não tem nenhum link para /comodato.html. As duas páginas do…
- DADO DUPLICADO FORA DO BANCO: public/index.html escreve 'R$ 50 por mês de ajuda de custo' e 'o triplo de espaço na tela' direto no HTML, e public/comodato.html §3 escreve 'atualmente R$ 50,00'. A fonte real é a tabela planos_ponto (migration 015, linhas 92-100: ajuda-custo = R$ 50 + 1 slot/hora;…
- DIVERGÊNCIA CÓDIGO × docs/funcional.md: a jornada 2.1 do funcional coloca a aprovação do administrador (passo 5) antes de assinar (passo 6). POST /anunciantes/:id/assinar (src/financeiro/routes.js) só barra conta `suspenso`, conta excluída, falta de endereço e regras de plano — `pendente_aprovacao`…
- CAMPO QUE CHEGA AO NAVEGADOR E NÃO É USADO: GET /planos devolve `meses_gratis`, `minimo_telas_ativas` e `limite_criativos` (docs/api.md, seção Público). public/planos.page.js não imprime nenhum dos três. `meses_gratis` é especialmente sensível porque CONSTRAINTS.md registra que 'benefício comercial…
- PRECISÃO TÉCNICA DE UMA PROMESSA: public/pontos.html promete 'sem borda preta e sem corte'. src/lib/ffmpeg.js linha 59 usa fundo desfocado (boxblur) para vídeo — a promessa se cumpre; a linha 56 usa `pad=1080:1920` sem parâmetro de cor para imagem, o que produz barra preta. Imagem fora de 9:16…
- ESPECIFICAÇÃO NÃO VALIDADA: public/index.html pede 'imagem ou vídeo curto de 15 a 30 segundos em formato 9:16'. O upload (src/anunciantes/routes.js linha 27) aceita qualquer image/* ou video/* até 200 MB, e não há nenhuma checagem de duração em src/lib/ffmpeg.js — um vídeo de 3 minutos entra, é…
- ITEM 8 DA SPEC (pendência declarada no CLAUDE.md): 'desconto de comodato por linha da grade' — o comodatário que quer mais espaço do que a cota paga plano de anunciante com desconto, por linha da grade, válido a partir da aprovação da conta e nunca revogado (docs/specs/2026-09-12-mostrai.md, item…
- ROTAS PÚBLICAS CONSUMIDAS PELO SITE PÚBLICO: GET /planos (planos.page.js), GET /pontos e GET /pontos/fluxo (pontos.page.js, index.page.js, planos.page.js), GET /categorias (formulario.js, via data-categorias em seja-um-ponto.html), POST /candidaturas (seja-um-ponto.page.js e…
