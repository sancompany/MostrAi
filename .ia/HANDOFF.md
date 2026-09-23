# Current Handoff

## Updated
2026-09-23

## Correção cirúrgica de Rede: candidatura, CEP/bairro, safe area (23/09/2026, este agente)
Pedido explícito do dono, separado da reconstrução de Contas acima: "NÃO
quero redesenhar Rede... só 3 correções funcionais". Rede está congelada
pra V1 depois deste round — o resto visual fica pra uma rodada universal
futura.

- **Confirmação de candidatura**: `public/anunciante/ponto.page.js`, "+
  Cadastrar outro endereço" — a mensagem de sucesso (`msg`) morava DENTRO do
  form que a linha seguinte escondia (`candidaturaRaiz.hidden = true`);
  ninguém via. Agora um elemento próprio, fora do form
  (`#msgNovoEnderecoConfirma`, `public/anunciante/ponto.html`), mostra a
  confirmação depois do form fechar.
- **"Meus endereços" mostra candidaturas pendentes**: rota nova `GET
  /anunciantes/me/pontos/candidaturas` (`src/pontos/routes.js`, repositório
  `candidaturasRepo.listarAbertasPorConta`) lista as candidaturas em aberto
  da conta; `carregarPontos()` funde com os pontos de verdade, badge "Em
  análise". Sem FK entre candidatura e ponto (como já era) — a candidatura
  só some da lista quando o admin aprova (status sai de 'nova'/'em_contato'),
  sem exibição duplicada.
- **Bloqueio de duplicata corrigido pra ser por ENDEREÇO**: achado real —
  `POST /anunciantes/me/pontos` e `POST /conta/modos/:papel/pedir` bloqueavam
  QUALQUER segundo endereço enquanto o primeiro estivesse em análise, mesmo
  sendo lugares diferentes (dono de duas lojas não conseguia candidatar a
  segunda). Agora compara `endereco`+`cep` (case/espaço insensível) da MESMA
  conta; mensagem `"Já existe uma solicitação em análise para este
  endereço"`.
- **CEP → Rua/Bairro**: `public/formulario.js#ligarCep()` concatenava
  `bairro` dentro do campo Rua (`"Avenida X, Bairro Y"`) mesmo com o campo
  `bairro` dedicado já existindo no formulário canônico de candidatura
  (`public/candidatura-ponto.js`, de uma rodada anterior — nunca tinha sido
  ligado). Agora preenche os dois campos separados; campo que a ViaCEP não
  devolve fica vazio, nunca inventado.
- **Safe area (margens da tela)**: os 4 inputs (`public/admin/index.page.js`,
  card de Telas) só tinham `title=` (tooltip) distinguindo Superior/Direita/
  Inferior/Esquerda — confuso, sem rótulo visível. Agora cada um tem
  `<label>` visível, mais uma linha curta "1 vmin = 1% do menor lado da área
  visível da tela". Unidade (vmin), `step=0.5` (decimais) e `min=0` já
  existiam; mapeamento pro player conferido sem inversão (`superior→top`,
  `direita→right`, `inferior→bottom`, `esquerda→left`,
  `public/player.css`/`player.page.js`).
- Teste novo: `tests/rede-correcao-cirurgica.test.js` (bloqueio por endereço,
  listagem de candidaturas abertas). `tests/e2e/09-rede-redesenho.mjs`
  corrigido: apontava pra elementos aposentados por uma rodada anterior
  (`#cp_fotoNome`/`.campo-foto` → `[data-foto-legenda]`/`[data-campo-foto]`
  do formulário canônico) — achado ao rodar, não causado por este round.
  Suíte 206/206, `npm run check` limpo.

## Correção do modelo de domínio: comodato × plano comercial separados + suspensão só manual (23/09/2026, este agente)
Feedback do dono sobre a reconstrução de Contas acima, em 3 pontos + 1
decisão maior (dele e do GPT, "correção do modelo de domínio, não de Contas").
Branch `claude/wonderful-hypatia-i7y4xx`. Ver `docs/PENDENCIAS.md` (raiz —
sem seção nova, correção direta nas RN existentes de `docs/funcional.md`,
RN-32/RN-35/RN-32-A) e `docs/api.md` (rotas `/anunciantes/me`,
`/admin/anunciantes/:id/plano[-administrativo[/encerrar]]`).

- **Migration 077** (renumerada de 076 — colisão com a `076_horario_operacional_da_tela.sql` de outra rodada, mesmo dia; ver nota de merge em `docs/PENDENCIAS.md`) — `anunciantes.comodato_plano_id` (Inicial/Básico),
  independente de `plano_id` (agora SÓ comercial: Essencial/Pro/Prime, pago
  ou cortesia) de vez. Migração de dado em 3 passos, sem chute: deriva do
  ponto vivo pra todo mundo (via `planos_ponto.plano_incluido_id`, o de
  maior `ordem`); COALESCE pro `plano_id` antigo só nas contas órfãs
  (`cortesia_motivo='comodato'` sem ponto — caso synthetic, não achado em
  produção); limpa o slot comercial dessas órfãs depois. `sincronizarComodato`
  (`src/pontos/comodato.js`) recalcula o campo toda vez que a modalidade de
  um ponto muda — mesmo padrão "melhor, não soma" do `credito_comodato_mensal`.
- **Regra nova, centralizada em `comodato.bloqueiaPlanoComercial(contaId)`**
  (lê `planos_ponto.permite_assinar`, campo que já existia desde a 049):
  Inicial bloqueia comprar/receber plano comercial (o sistema pede pra trocar
  a modalidade pra Básico antes — sem conversão automática escondida); Básico
  libera; sem ponto nenhum não bloqueia. Checado em 5 lugares: `/assinar`
  self-service, concessão administrativa, `liberar-plano` legado, upgrade por
  indicação, resgate de bônus.
- **`plano-administrativo.js#encerrar()`** simplificado: encerra só o slot
  comercial. Comodato NUNCA é tocado — nem por cancelamento de cortesia, nem
  por cancelamento de assinatura paga. ("Não 'volta'; ele nunca deveria ter
  desaparecido" — a frase do dono, literal.)
- **Suspensão automática removida.** `conciliacao.js#encerrarCoberturaVencida`
  (renomeada de `suspenderCoberturaVencida`) agora chama o mesmo `encerrar()`
  do botão manual, com `motivo:'vencido'` (migration 078 amplia o CHECK de
  `encerrado_motivo`) em vez de marcar `suspenso=true`. Suspensão automática
  sobrevive só em `cobranca_contestada` (chargeback, obrigação contratual do
  San Checkout) e no direito de arrependimento (o próprio titular pedindo) —
  os dois não são "cobertura só venceu", são caso à parte, e ficaram como
  estavam.
- **Blast radius do `plano_id` virar só comercial** — corrigido com
  `anunciantesRepo.planoEfetivoId(conta) = plano_id || comodato_plano_id`,
  aplicado em ~15 pontos: elegibilidade de playlist
  (`playlist/gerador.js`), ocupação (`pontos/repository.js` ×4,
  `midias/repository.js`), upload/limite de criativo, pontos-disponíveis,
  dashboard do painel (`public/anunciante/painel.page.js` — **o mais crítico:
  sem esse fix o gate de bloqueio do painel escondia o autoanúncio de quem só
  tem Básico**), exibições.
- **Admin** (`public/admin/index.page.js`): ficha mostra Comodato e Plano
  comercial como blocos de fato independentes (lê `comodato_plano_id` direto,
  sem inferir de `plano_id`); texto do modal de cancelar cortesia não promete
  mais "o comodato volta"; resumo da Visão Geral fala "plano(s) encerrado(s)
  por cobertura vencida" em vez de "suspensa(s)".
- **Texto legal (Termos §6, Política de Privacidade — programa de Vendedor)
  marcado como pendência**, não editado — `docs/PENDENCIAS.md`, seção H. O
  dono decide a redação; é o pedido dele explícito nesta rodada.
- Testes: `tests/contas-reconstrucao.test.js` (+7 novos/reescritos) e
  `tests/indicacoes.test.js` (+1). Suíte 204/204, `npm run check` limpo (15
  avisos pré-existentes, nenhum novo).
- **Próximo, mesma sessão, pedido explícito do dono:** correção cirúrgica em
  Rede (candidatura, CEP/bairro, safe area) — ver seção logo abaixo assim que
  existir, e `docs/PENDENCIAS.md` se ficar algo em aberto.

## Revisão final da Visão geral do admin + fluxos internos (23/09/2026, outro agente, mergeada nesta branch)
Pedido do dono (17 seções): fechar a V1 do ADMIN com revisão estrutural da
Visão geral (2 colunas, muito mais compacta) e dos fluxos que ela abre.
Detalhe completo em `docs/PENDENCIAS.md` (seção "Revisão final da Visão
geral e fluxos internos — 23/09/2026", final do arquivo) — resumo aqui:

- **Régua única de status de tela** (migration 074, `src/lib/status-tela.js`):
  `modo_horario` (`ponto`/`24h`/`personalizado`) por tela, `horario_semanal`
  próprio no modo personalizado (editável na ficha do ponto). Substitui a
  checagem fixa "2h sem heartbeat" nas 2 telas do ADMIN (não tocou as 2
  cópias em `public/anunciante/painel.page.js`, fora de escopo desta
  rodada). Player manda `{erro}` no heartbeat quando algo real falha.
- **MRR corrigido**: `src/admin/routes.js#agregarReceitaPorCiclo` chama
  `valorMensalDaConta()` por conta (a mesma função da cobrança real) em vez
  de somar `planos.valor_mensal` cru — promoção travada, desconto de
  parceiro e crédito de comodato agora entram na conta.
- **Comissão de vendedor saiu** do card financeiro da Visão geral e da aba
  da Central Financeira (fica só Cobranças/Repasses/Trocas/Devoluções) —
  backend/tabela/Contas intactos, só parou de somar/aparecer aqui.
- **Financeiro virou 1 card** (receita recorrente + recebido no mês +
  conciliação discreta + pendências agregadas), Mensagens ganhou abas
  Pendentes/Histórico, Pendências operacionais caiu de 8 pra 4 cards,
  indicadores renomeados (Novas contas / Conversão cadastro → pagamento /
  Alcance estimado), "Pontos por status" virou resumo de uma linha.
  Todo módulo `oculto: true` (Financeiro/Mensagens/Aprovação/Vendedores)
  ganhou link "← Visão geral".
- **Layout final**: `.visao-geral-colunas` (2 colunas >900px, empilha
  sozinho abaixo disso).
- **Bug corrigido** (já reportado antes, ver rodada de integridade abaixo):
  ponto sem tela inflava ocupação comercial — `ocupacaoPorPonto`
  (`src/midias/repository.js`) agora só soma `segundos_por_hora` de ponto
  `em_operacao`.
- `npm run check`: 204/204 testes, lint/format limpos (só os 3 avisos
  antigos). Testado no navegador via Playwright headless (login, Visão
  geral com/sem dado, Mensagens, Central Financeira, editor de horário da
  tela salvando de verdade) — screenshots em desktop 1400px e mobile
  420px, sem overflow, sem erro de console novo.
- **Fora de escopo, de propósito**: `painel.page.js` do anunciante não foi
  tocado; "Recebido no mês" não mudou de nome no backend (`receitaConfirmadaMes`),
  só o rótulo na UI.

## Reconstrução final de Contas + Categorias (23/09/2026, este agente)
Pedido do dono (63 partes): toda conta já pode anunciar; Central de Contas
e ficha única; plano administrativo como benefício; criativos e pontos na
ficha; suspensão que tira acesso; Vendedor/Parceiro fora da experiência;
taxonomia de categorias consolidada. Depois disso o dono faz outra revisão
manual do admin — **não continuar mexendo em outras telas.**

- **Migration 074** (categorias): coluna `canonica_id`; 31 fusões de
  sinônimo/concorrente direto (ex.: Pousada→Hotel / Pousada, Casa de
  carnes→Açougue / Casa de carnes, Sementes/Fertilizantes/Defensivos→Insumos
  agrícolas). A absorvida vira legado + fora do cadastro, contas/pontos são
  reapontados (fecha falso-negativo de concorrência), nome vira alias. 17
  renomes pra clareza, aliases novos. Tudo por NOME e no-op se a linha não
  existir; renome só se o nome novo estiver livre (produção pode ter
  diferido do dev). 229→198 ativas. As 22 legadas da 067 continuam sem
  mapeamento automático (ambíguas — de propósito).
- **Migration 075**: `planos_administrativos` (histórico de benefício;
  estado vigente continua em `anunciantes`) + `criativos.status` aceita
  `retirado` + `criativos.substitui_criativo_id`.
- **Plano administrativo** (`src/financeiro/plano-administrativo.js` +
  rotas em financeiro/routes.js): cortesia, nunca cobrança; assinatura
  paga ativa é cancelada antes pela lógica existente (502 = nada muda);
  encerrar devolve o plano do comodato se houver ponto. `data_expiracao` é
  `date` — a validade trafega como string 'AAAA-MM-DD' (Date do JS às
  23:59 BRT gravava um dia a mais). `liberar-plano` ficou legado.
- **Suspensão**: login recusa conta suspensa (403) e
  `derrubarSessaoSuspensa` (anunciantes/routes.js, montado em server.js)
  derruba sessão aberta. Ponto físico do dono suspenso segue tocando (TV
  autentica por aparelho). Antes, suspensa só não conseguia comprar.
  Efeito colateral consciente: conta auto-suspensa (cobrança falhou /
  cobertura venceu) também não entra mais — já não conseguia assinar antes.
- **Criativos**: teto de cadastro do admin = 3 (`CRIATIVOS_POR_CONTA`);
  quantos rodam = limite do plano (gerador). Substituir sobe B em análise
  apontando pra A; aprovar B retira A (PATCH /admin/criativos/:id, vale
  também pela fila global). Retirar/colocar no ar = status `retirado` ⇄
  `aprovado` (voltar do retirado não reenvia e-mail de "no ar").
- **Vendedor aposentado**: `ativar-vendedor` 410; `liberarPapelNaConta`
  ignora 'vendedor'; convite novo não aceita o papel e o antigo é filtrado;
  cupom de vendedor não vale no cadastro (PT- de ponto segue);
  `registrarComissaoSeHouver` desligado por `COMISSAO_DE_VENDEDOR_ATIVA =
  false` (nenhuma comissão nova, nem de renovação). Tabelas/histórico e a
  fila oculta de Comissões (pagamento do que já existe) intactos.
  `/anunciante/vendedor.html` → 301 pro painel. Card "Vendedor parceiro" e
  "Quer indicar?" saíram da home; FAQ de planos sem "Vendas".
  **Pendente do dono**: termos-de-uso §6 e política de privacidade ainda
  descrevem o programa de vendedores (texto legal — não mexido).
- **Parceiro**: selo/filtro/status saíram de toda UI (admin, painel,
  perfil). O desconto de parceiro em `san-checkout.js` continua valendo
  pra quem já é parceiro (dado preservado, cobrança não mexida).
- **Admin**: `abrirModal`/`confirmarModal` (<dialog> nativo) substituem
  prompt/confirm nos fluxos de Contas/Categorias e no Reprovar da fila
  global. Conta interna (`conta_propria`) fora da Central de Contas.
- Testes: `tests/contas-reconstrucao.test.js` (14). Suíte 198/198.

## Reconstrução de Ofertas/Promoções (23/09/2026, agente anterior)
Pedido do dono: reconstrução visual e funcional completa de Ofertas
(Preços + Promoções), admin e site público. Requisito explícito mais
importante: parar de segmentar promoção por sessão ("logado × deslogado")
e passar a segmentar por ELEGIBILIDADE COMERCIAL (novos usuários / já
assinam / todos), calculada a partir do estado real da conta, não de ter
sessão aberta.

**Em uma linha cada:**
- Migration 073 (aditiva): `promocoes` ganha `publico_elegivel`
  (`novos`/`assinantes`/`todos`), `formato_midia`
  (`horizontal`/`quadrado`/`vertical`) e `status`
  (`rascunho`/`ativa`/`encerrada`, backfill a partir do antigo `ativa`).
  `mostrar_logados`/`mostrar_admin`/`ativa` continuam na tabela (nunca se
  apaga coluna sem permissão explícita), só pararam de ser lidos/escritos.
- **Elegibilidade** (`src/financeiro/promocoes-repository.js`):
  `temPlanoAtivo(conta)` reusa o mesmo predicado já usado em
  `planos-repository.js` (`plano_id` + não suspensa + não excluída + sem
  `data_expiracao` vencida); `jaAssinouAntes` olha
  `cobrancas_confirmadas`. `GET /promocoes/vigentes` (pública) monta o
  estado a partir de `req.session.anuncianteId` quando existir — sem
  sessão = tratado como "novo" (mesma regra de visitante). `condicaoVigente`
  (motor de preço real da assinatura, `POST /anunciantes/:id/assinar`)
  também passou a receber o estado comercial — sem isso, o preço cobrado
  de verdade podia ser mais generoso do que a elegibilidade permitia
  mesmo com a vitrine já filtrando certo. **Achado no caminho**: o resumo
  de promoção ativa da Visão Geral do admin usava a MESMA rota pública —
  como sessão de admin nunca é sessão de anunciante, isso escondia
  promoção "só assinantes" do próprio admin. Corrigido com rota própria
  (`GET /admin/ofertas/promocoes-vigentes`, sem filtro de elegibilidade).
- **Upload de imagem da promoção**: `POST
  /admin/ofertas/promocoes/:id/imagem`, mesmo padrão do avatar
  (`POST /anunciantes/me/foto` — Supabase Storage direto, sem ffmpeg).
  Promoção salva primeiro (JSON), imagem sobe depois num segundo POST
  multipart — mesma convenção de "Ajustar mídia" em Mídia Mostraí.
- **Admin > Preços**: grade 3 colunas fixas (era `auto-fit`/`minmax`, que
  deixava vazio nas laterais em telas largas), ciclos em grade 2×2 dentro
  do card (era 1 coluna de 4 caixas empilhadas), comodato isolado num
  painel com fundo próprio. Textos explicativos redundantes removidos.
- **Admin > Promoções**: formulário reescrito em blocos (Identidade,
  Mídia, Janela de compra, Condições, Produtos e ciclos, Exibição).
  Formato de mídia por 3 botões visuais (proporção de verdade, não
  `<select>`); "Mostrar na página de Planos" fica obrigatório e desabilitado
  quando há produto/ciclo participando; status vira 3 pills
  (Rascunho/Ativa/Encerrada) no lugar do checkbox solto "ativa". Listagem
  virou cards (`.promo-card`) em vez de tabela crua.
- **Achado e corrigido (bug real, não só polimento)**: as pills de rádio
  novas (elegibilidade/status) primeiro saíram completamente sobrepostas —
  `.chip-check input` não tinha o reset de `width`/`padding` que
  `.benef-check input` já tinha (documentado ali: dentro de um
  `<form class="card">`, `.card input { width:100%; padding:11px }`
  global estica qualquer input esquecido). Corrigido com o mesmo reset.
- **Achado e corrigido (bug real de CSP)**: a primeira versão do banner
  com imagem de fundo usava `style="background-image:url(...)"` inline —
  a CSP (`style-src 'self'`, sem `unsafe-inline`) bloqueia isso em
  silêncio (o atributo aparece no DOM, o navegador nunca aplica a regra).
  Corrigido trocando por um `<img>` de verdade, absoluto atrás do texto
  (`img-src` já libera o storage das mídias) — sem tocar a CSP.
- **Site público**: banner da promoção saiu de "card quadrado com imagem
  ao lado" (fora do fluxo, abaixo do hero) pra banner de largura cheia
  ACIMA do hero, com degradê de marca (ou a imagem de fundo, se formato
  horizontal). Planos ganhou o mesmo banner no topo (camada 1) além da
  aplicação por célula que já existia (camada 2). Painel logado: bloco
  simplificado — mostra a primeira promoção vigente (já filtrada por
  elegibilidade no servidor), sem filtro próprio de superfície.
- Achado testando em mobile: `.promo-matriz` (tabela produto × ciclo) sem
  `.rolagem` ao redor causava overflow horizontal da PÁGINA inteira em
  390px — corrigido envolvendo a tabela, mesmo padrão de toda tabela do
  admin.

**Deliberadamente não testado de ponta a ponta**: upload real de imagem
pro Supabase Storage — `SUPABASE_URL` não tem valor real neste ambiente
(mesma limitação já documentada na rodada de Mídia Mostraí). Rota
verificada até o ponto de chamar `supabase.storage.upload` (erro
esperado de credencial ausente, não erro de lógica); o mecanismo é cópia
literal do upload de avatar, que já funciona em produção.

**Verificado:** `npm run check` (184/184, 15 avisos de lint já
conhecidos), 11 testes novos de elegibilidade comercial
(`tests/promocoes-elegibilidade.test.js`), Playwright manual (admin
desktop/tablet/mobile — Preços, criar/editar promoção com todos os
blocos, listagem em cards, Visão Geral; site público Home/Planos
desktop/mobile, sem promoção e com promoção, com/sem imagem de fundo).

## Rodada de integridade do admin (23/09/2026, este agente)
Correção transversal, sem redesign. Próxima etapa definida pelo dono:
revisão manual tela por tela, começando pela Visão geral — NÃO continuar
reorganizando.

**Corrigido:** contador "ponto(s) candidatos aguardando triagem" contava
ponto `a_instalar` (fila `pontos` herdada do status `lead`) — saiu; badge de
Rede agora é só candidatura. Resumo operacional fixo na Visão geral (8
filas, zero neutro, "—" se não carregou). `filas.notas` saiu (contava todo
pagamento). Inicial/Básico voltaram à UI em Ofertas (somente leitura,
`GET /admin/ofertas/comodato`). `% comodato` aposentado (UI + cálculo).
Crédito de R$ 50 do Básico vale também no Essencial. `aplicarCicloPago`
agora limpa `plano_cortesia`/`cortesia_motivo` (paying customer ficava como
cortesia e o pago podia ser sobrescrito pelo Básico). Régua 80/20 única em
`src/lib/capacidade.js`, usada por Mídia Mostraí e Visão geral. Contas separa
comodato de plano comercial. Migration 072: textos das modalidades de
comodato (guardada — só troca texto ainda igual ao semeado).

**Aberto, pra revisão tela a tela (não corrigido de propósito):** Básico +
plano pago não coexistem como direitos separados (um `plano_id` só);
Inicial "só o próprio ponto" não é amarrado pelo motor; alerta de tela sem
sinal ignora horário do ponto (nunca implementado); banco de horas sem tela
no admin (alerta ficou sem link); trocas `pendente_troca` do fluxo novo não
entram em fila nenhuma; sem UI pra editar valores/textos de comodato.

## Limpeza estrutural final da navegação do admin (22/09/2026, este agente)
Pedido do dono, fechamento explícito: "depois desta tarefa não quero mais
reorganizar grandes módulos — a próxima fase é revisão tela a tela". Regra
de leitura: código como fonte, sem auditoria geral, sem ler HANDOFF/
PROJECT_STATE/docs históricas. Detalhe técnico completo só no commit (não
duplicado em `docs/PENDENCIAS.md` de propósito, pra não contrariar a regra
de leitura mínima desta rodada — mudança é só navegação, sem rota/API nova).

**Em uma linha cada:**
- `MODULOS` (`public/admin/index.page.js`) virou lista PLANA — sem `grupo`/
  `itens` aninhado, sem cabeçalhos "MOSTRAÍ"/"OPERAÇÃO"/"COMERCIAL"/
  "SISTEMA". Ordem visível: Visão geral, Rede, Contas, Ofertas, Mídia
  Mostraí (`destaque: true`, estilizada como atalho especial no fim —
  `.nav-item-destaque`, fundo/borda na cor da marca, só separação por
  espaçamento, sem título de seção).
- **Configurações e Pendências saíram do array por completo** (nem
  `oculto`) — hashes antigos (`#configuracoes`, `#configuracoes/comodato`,
  `#configuracoes/diagnostico`, `#pendencias`) caem sozinhos em
  `visaogeral`, mesmo padrão já usado pra "custos" (rodada Financeiro):
  `resolverAlvo()` degrada assim quando `buscarModulo()` não acha o id.
  Categorias (já vivia em Contas) e Comodato (não reimplementado — outra
  frente cuida da versão nova dentro de Ofertas) não têm mais destino em
  Configurações. Diagnóstico (teste SMTP + fila de eventos do San
  Checkout) saiu da UI por completo — sem destino nenhum, nem oculto,
  "recuperável por ferramenta interna se precisar" (pedido explícito do
  dono). `_renderComodato`/`_renderEventos`/`_renderPendencias`
  (prefixo `_`, convenção do lint pra código morto) continuam definidas,
  sem chamador.
- **Achado e corrigido no roteador**: com vários hashes antigos caindo no
  MESMO destino de fallback (`visaogeral`), navegar de um pro outro em
  sequência batia no guard de `hashchange` (comparava só contra
  `ABA_ATUAL`, que já estava em `visaogeral` desde a queda anterior) e
  pulava `irPara` — a tela certa continuava no ar, mas a URL ficava presa
  no hash antigo. Adicionado `location.hash !== canonico` ao guard; sem
  loop (a própria `irPara` só reatribui o hash quando ele ainda não bate).
- Removida a entrada `eventos` de `ALERTAS` (alimentava Visão Geral E a
  extinta Pendências) — apontava pra uma tela que deixou de existir,
  teria virado badge órfão.
- CSS: `.nav-grupo` removida (não é mais emitida por `montarNav`);
  `.nav-item-destaque` nova, com variante mobile (borda esquerda em vez de
  superior, porque a lista vira linha horizontal em telas estreitas).

**Verificado:** `npm run check` (168/168, só os 15 avisos de lint já
conhecidos — 3 pré-existentes de Ofertas + 12 de `candidatura-ponto.js`,
nenhum novo), Playwright cobrindo sidebar (5 itens, ordem, sem
agrupamento, Mídia Mostraí com classe de destaque e por último), navegação
normal pelos 5 itens, os 4 hashes antigos em sequência (a regressão que o
fix do roteador resolve), Categorias só em Contas, sem alerta órfão de
eventos na Visão Geral, responsividade desktop/tablet/mobile (sem overflow
horizontal, Mídia Mostraí visível e clicável nos três, botão Sair
acessível em mobile), screenshots desktop/mobile conferidos visualmente.

## Bloco FINANCEIRO do admin reorganizado (22/09/2026, este agente)
Pedido do dono, spec de 51 seções numa mensagem só: desmontar Receitas/
Repasses/Custos como páginas fixas — "normalidade não ocupa espaço,
pendência aparece pra eu resolver", sem mini-ERP, San Checkout continua
dono da infraestrutura de pagamento. Regra de leitura do prompt: código
como fonte de verdade, sem ler `PROJECT_STATE`/`TODO`/histórico a não ser
que uma dependência financeira não desse pra confirmar só pelo código
(não aconteceu). Detalhe técnico completo em `docs/PENDENCIAS.md` seção N.

**Em uma linha cada:**
- Grupo "Financeiro" sumiu da sidebar. Repasses/Comissões/Trocas/
  Devoluções/Cobranças viraram drill-down oculto (`#financeiro/*`),
  hospedado dentro do grupo "Sistema" (`oculto: true`) pra não deixar um
  cabeçalho "FINANCEIRO" vazio — `montarNav()` imprime o nome do grupo sem
  checar se sobrou item depois do filtro de ocultos.
- Visão geral ganhou `painelFinanceiroResumo()`: dois números sempre
  visíveis (Receita recorrente, Confirmado no mês) + lista de pendências
  que só existe quando tem algo (repasse/comissão/troca/devolução) —
  contador zero nunca aparece.
- **Fila de repasses nova, automática**: `listarPendentesDoMes()`
  (`src/pontos/pagamentos-repository.js`) junta `pontos` com
  `pagamentos_ponto` do mês corrente, só `valor_pago_mensal > 0` — a
  modalidade "troca por tela" (valor zero) nunca aparece, sem recriar
  regra de comodato nenhuma. Rota nova `GET
  /admin/pagamentos-ponto/pendentes`. Marcar como pago some da fila e da
  Visão geral na hora.
- Nota fiscal manual saiu inteira da UI (KPI "Notas por emitir", upload de
  PDF, filtro Sem nota/Com nota) — Cobranças virou histórico só-leitura.
  `PATCH .../nota-fiscal` continua no backend sem chamador, pronta pra
  quando existir emissão automática (não construída agora).
- Custos desapareceu da UI (CRUD de custo fixo, DAS, amortização, "entra
  na margem") — rotas e tabelas intactas no backend. **Conferido antes de
  tirar a tela** (seção 26 do prompt): nenhum indicador da Visão geral
  dependia de `custoPontosMensal`/`amortizacaoMensal`/`custosFixosMensal`/
  `margemMensal` — só a extinta `renderCustos` (agora `_renderCustos`,
  código morto por convenção do lint) os lia. Os quatro continuam
  calculados em `GET /admin/resumo`, sem exposição em UI nenhuma.
- **Achado e corrigido de passagem**: a fila de Devoluções
  (`renderArrependimentos`, agora `renderFilaDevolucoes`) estava com um
  bug pré-existente documentado em `docs/teia.md` — o botão "Registrar
  devolução" chamava o helper `salvar()` (fixo em `PATCH`) contra uma rota
  `POST`. A reescrita da fila passou a chamar `api()` com `method: 'POST'`
  direto — corrigido, não era o objetivo da rodada.
- `TROCA_STATUS` (constante que virou órfã pela reescrita de
  `renderFilaTrocas`) foi apagada, não prefixada com `_` — "deletar vence
  adicionar", sem chamador nenhum no arquivo.
- Migration: nenhuma (dado e rotas de trocas/devoluções/comissões/
  repasses/cobranças já existiam, só ganharam consumidor novo no front).

**Deliberadamente fora desta rodada:** os quatro cards de receita por
ciclo (mensal/trimestral/semestral/anual) saíram da Visão geral pra bater
com o exemplo literal do pedido — o dado continua em
`financeiro.receitaPorCiclo`. Uma tela unificada de "Movimentações" não
foi construída (era opcional no pedido; os drill-downs por domínio já
cobrem a necessidade operacional).

**Verificado:** `npm test` (161/161), `npm run check` (só os 3 avisos de
lint já conhecidos, de antes desta rodada), Playwright cobrindo login,
sidebar sem "Financeiro"/"Receitas"/"Repasses"/"Custos", painel compacto
com as quatro pendências simultâneas, clique até a fila de repasses,
pagar um repasse e ver ele sumir da fila e da Visão geral na hora (com
`pago_em` gravado no banco), trocas/devoluções mostrando só o pendente,
cobranças sem nenhum rastro de nota fiscal manual, hash antigo `#custos`
caindo em Visão geral sem abrir tela nenhuma, sem overflow horizontal em
390px (mobile) na Visão geral nem nas filas. Docs atualizados:
`docs/api.md`, `docs/funcional.md`, `docs/teia.md`, `docs/PENDENCIAS.md`
(seção N).

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em
`main`** (branch reiniciada de `origin/main` no começo desta sessão,
porque a PR anterior nela já tinha sido mergeada).

## Casca da central de Contas + Categorias (22/09/2026, este agente)
Pedido do dono: "Anunciantes" vira conceitualmente "Contas" — a entidade real
é uma conta que pode acumular papéis (anunciante, dono de ponto, vendedor),
não um registro fixo de um tipo só. Só a CASCA desta rodada — organização de
papéis + mover Categorias pro lugar definitivo — nenhuma regra financeira
nova, nenhuma fusão de comodato com plano comercial. Regra de leitura do
prompt: código como fonte de verdade, sem auditoria geral.

**Pré-voo (10 perguntas do prompt, respondidas antes de codar):** conta =
tabela `anunciantes` (nome já não muda, só a UI); papéis = `papeis` text[]
já editável via `PATCH /admin/anunciantes/:id` (nada novo); dono de ponto =
`pontos.anunciante_id`; vendedor = tabela `vendedores` (1:1 por `conta_id`,
cupom automático em `vendedoresRepo.criar`); comissão/cupom/link já vivem em
`src/financeiro/vendedores-repository.js`; parceiro = `anunciantes.status =
'parceiro'` (não é papel, é status — confirmado no código, `PAPEIS` só tem
anunciante/ponto/vendedor); ações hoje na ficha do anunciante: liberar
plano, marcar parceiro, subir anúncio, cancelar assinatura, restaurar;
Categorias já mora em `src/categorias/routes.js` (CRUD completo, nada pra
construir); categoria liga em conta/ponto por `categoria_id`/`categoria_livre`
direto na tabela; mudança mínima de backend: só uma rota nova (ativar papel
vendedor numa conta, reaproveitando `liberarPapelNaConta`).

**Em uma linha cada:**
- `public/admin/index.page.js`: "Anunciantes" virou o módulo `contas` com 2
  abas — "Contas" (`renderContasAba`/`renderContasLista`/`renderContaDetalhe`,
  substituindo `renderAnunciantes*`) e "Categorias" (`renderCategorias`,
  só mudou de módulo pai). "Vendedores" ganhou `oculto: true` (mesmo padrão
  de "mensagens") — página e rota seguem existindo, só sem botão na sidebar.
  Listagem: coluna de papéis mostra TODOS (inclusive "Anunciante", que antes
  ficava escondido por ser assumido), colunas Plano comercial e Comodato
  separadas (nunca fundidas — pedido explícito do dono), filtros novos
  (Anunciantes/Donos de ponto/Vendedores/Parceiras/Inativas).
- Ficha da conta: cabeçalho fixo + abas DINÂMICAS — Resumo sempre, Plano só
  se papel anunciante, Pontos só se dono de ponto (papel ou `pontos.anunciante_id`
  real), Vendedor só se papel vendedor ou perfil já existe. Nenhuma aba vazia
  nasce só pra antecipar trabalho futuro (Conteúdo/Financeiro ficaram de
  fora de propósito). Resumo: dados + ações gerais (marcar parceira, subir
  anúncio, restaurar, **ativar papel Vendedor**). Plano: dados do plano +
  liberar/cancelar (as duas ações que eram do Resumo, movidas pra cá por
  pertencerem ao plano). Pontos: lista somente-leitura dos pontos da conta,
  clique leva pra Rede (Rede não foi mexida). Vendedor: comissão/Pix/cupom,
  mesmos campos e rotas da antiga tabela.
- **Rota nova, única mudança real de backend**: `POST
  /admin/anunciantes/:id/ativar-vendedor` (`src/financeiro/routes.js`) —
  reaproveita `liberarPapelNaConta` (`src/conta/modos.js`, exportada agora
  junto com `emTransacao`) sem `cand`. **Achado e corrigido no caminho**:
  `vendedoresRepo.criar` usa `SAVEPOINT` (retry de colisão de cupom), que só
  funciona dentro de uma transação de verdade — a rota nova por pouco foi ao
  ar chamando `liberarPapelNaConta(conta, 'vendedor', null, pool)` direto
  (sem transação), o que quebra com "SAVEPOINT can only be used in
  transaction blocks"; corrigido envolvendo em `emTransacao`.
- **Achado e corrigido no roteador**: renomear o módulo `anunciantes` pra
  `contas` quebrava links antigos com id (`#anunciantes/42`) — `resolverAlvo`
  só casava o alias contra o hash INTEIRO, não contra o primeiro pedaço
  antes de um `/id`. Generalizado pra tentar o alias pelo primeiro segmento
  também, sobrando o resto — corrige esse caso pra qualquer alias futuro no
  mesmo formato, não só Contas.
- Migration: nenhuma. `papeis`, `vendedores`, `categorias` já tinham tudo.

**Legado mantido de propósito** (pedido explícito: não gastar esta rodada
limpando): `renderAnunciantes*` foram renomeadas/reescritas (não sobrou
código morto ali), mas `renderVendedores` (tabela antiga) e a página
Vendedores continuam intactas, só ocultas.

**Verificado:** `npm run check` 161/161; Playwright cobrindo desktop/tablet/
mobile — listagem com filtros/busca, conta com 1 papel e com 3 papéis
simultâneos (abas corretas em cada caso), ativar papel Vendedor de ponta a
ponta (cupom gerado no banco), Categorias dentro de Contas, hash antigo
`#anunciantes/42` caindo na ficha nova, `#vendedores` ainda funcionando.

## Ofertas + Promoções + formulário canônico de candidatura (22/09/2026, este agente)
Prompt de 41 seções (A–AO) do dono: reformulação estrutural e visual da
área comercial. Instrução explícita de não ler documentação histórica
ampla (código é a fonte de verdade), não limpar código legado nesta
rodada, e prosseguir com a implementação sem esperar nova autorização se
não houver bloqueador real de negócio (nenhum encontrado). "Depois disso
considere OFERTAS + PROMOÇÕES + FORMULÁRIO CANÔNICO DE CANDIDATURA
concluídos nesta rodada" — mesmo padrão de fechamento da rodada final da
Rede, abaixo.

**Em uma linha cada:**
- Migration 070 (única): `pontos`/`candidaturas` ganham `bairro`/
  `complemento` (endereço estava concatenando rua+bairro num campo só —
  ViaCEP já devolvia os dois separados, só faltava a coluna); tabelas
  `promocoes`/`promocoes_itens` novas; `assinaturas` ganha
  `promocao_id`/`promocao_desconto_percentual`/`promocao_valido_ate`
  (snapshot da condição no momento da adesão, mesmo padrão de
  `plano_id` apontando pra uma versão congelada).
- **Ofertas (admin)**: "Planos" virou "Ofertas", só 2 abas (Preços,
  Promoções) — Arquivados/Benefícios saíram da UI (código antigo
  continua morto, não apagado, por instrução explícita do prompt).
  `planos-repository.js#listarProdutos/atualizarProduto` agrupam os 4
  ciclos de cada tier (Essencial/Pro/Prime) num card por produto; editar
  reusa o `novaVersao()` já existente (só cria versão nova quando o valor
  realmente muda — testado idempotente).
- **Promoções**: entidade separada de plano (nunca "Pro Black Friday"
  fake) — matriz tier×ciclo com desconto por célula, Mensal pode ficar de
  fora. `promocoes-repository.js#condicaoVigente` é o motor; **ADR-014**
  (`.ia/DECISIONS.md`) registra a decisão de o desconto promocional
  SUBSTITUIR o de ciclo (nunca somar), com comodato/parceiro continuando
  a somar por cima. Snapshot na assinatura no momento da adesão — preço
  já vendido nunca recalcula se a promoção mudar depois.
- **Site público**: os 3 cards de produto mostram os 4 ciclos com
  geometria idêntica agora (`.price-linha-vazia{visibility:hidden}`
  reserva o espaço da linha de risco/economia/equivalente mesmo quando
  não se aplica) — corrige o bug visual do card Mensal mais baixo que os
  outros (decisão de 19/09 que o prompt reverteu explicitamente, Parte
  J). Bloco de promoção em Home (se `mostrar_home`), Planos (aplicado por
  célula elegível) e painel logado (`mostrar_logados`); Visão Geral do
  admin mostra resumo compacto só quando há promoção ativa.
- **Formulário canônico de candidatura** (`public/candidatura-ponto.js`,
  script global de verdade, sem IIFE — mesma convenção de
  `formulario.js`, porque os 3 pontos de entrada (`modos.js` CARDS.ponto,
  `painel.page.js` card compacto, `ponto.page.js` "+ Cadastrar outro
  endereço") precisam chamar as mesmas funções): endereço com
  rua/bairro/complemento separados, foto com preview real (`FileReader` +
  `readAsDataURL`, não `URL.createObjectURL` — a CSP só libera `data:` em
  `img-src`, não `blob:`; consolida no módulo compartilhado o mesmo padrão
  que a rodada "Reorganização da Entrada" abaixo já tinha aplicado, sem
  módulo, em `modos.js`/`painel.page.js` separadamente), Trocar/Remover,
  horário 7 dias + feriados, preview de card ao vivo ao lado do form
  (`.candidatura-layout`, empilha no mobile <900px) — este último é novo,
  não existia antes desta rodada em nenhum dos 3 lugares.
- **Achado real, corrigido nesta rodada**: `POST /anunciantes/me/pontos`
  ("+ Cadastrar outro endereço") criava o PONTO direto
  (`pontosRepo.criar`), nunca passava pelo admin — apesar do próprio
  comentário no código sempre ter dito "entra como lead". Agora chama
  `criarCandidaturaPonto` (mesma função do outro caminho), vira
  candidatura de verdade, só vira ponto quando o admin aprova. Um segundo
  achado no mesmo raio: `criarPontoDaCandidatura`
  (`src/anunciantes/routes.js`, caminho de convite) não copiava
  `horario_semanal`/`foto_instalacao_url`/`observacoes` da candidatura
  pro ponto — corrigido pra igualar `liberarPapelNaConta`.
- **Bug de duplicação achado testando**: injetar o formulário de "outro
  endereço" via `innerHTML` de forma SÍNCRONA (sem esperar fetch nenhum)
  faz o `DOMContentLoaded` global de `formulario.js` (que já liga
  CEP/categorias em todo o documento) rodar DEPOIS da injeção e religar o
  mesmo campo de novo — dois campos de busca de segmento na tela.
  Corrigido removendo a chamada manual de `ligarCep`/`ligarCategorias`
  nesse caminho (o listener global já cobre, porque a injeção acontece
  antes do documento terminar de carregar) — o padrão do `modos.js`
  (chamada manual dentro de `montarModo`, que é `async` e só injeta DEPOIS
  do `DOMContentLoaded` já ter passado) continua correto e não mudou.
- **Merge com a rodada "Reorganização da Entrada"** (abaixo — mesmo dia,
  outro agente, PR já fundida em `main` antes desta): sobreposição real em
  `public/admin/index.page.js` (nav "Planos"→"Ofertas" nesta rodada,
  Candidaturas virando aba de Rede na outra), `public/modos.js` e
  `public/anunciante/painel.page.js` (os dois mexeram no mesmo formulário
  de candidatura — a outra rodada trocou `URL.createObjectURL` por
  `FileReader` por causa da CSP, sem módulo compartilhado; esta rodada
  criou o módulo compartilhado). Resolvido reaplicando as duas mudanças
  juntas: a base estrutural da outra rodada (nav, grade de candidaturas,
  `FileReader`) mais as camadas desta (Ofertas/Promoções, módulo
  `candidatura-ponto.js` com `FileReader` em vez de `blob:`, preview de
  card ao vivo, bairro/complemento na ficha de candidatura do admin).
- Testado com Playwright (fluxo real via `fetch` + cookie de sessão,
  screenshots desktop/mobile): preview ao vivo atualiza com `input`, foto
  real mostra miniatura nos dois previews (inline + card), "+ Cadastrar
  outro endereço" cria candidatura (confirmado direto no banco, `status
  ='nova'`), bloqueio de pedido duplicado (409) funciona. Achado nesse
  teste (já corrigido acima do merge): antes de trocar pra `FileReader`, a
  primeira versão desta rodada usava `URL.createObjectURL` e abria `blob:`
  na CSP — revertido; a versão final não toca a CSP.
- `npm run check` verde (sintaxe + lint + format + 161 testes) —
  `DATABASE_URL` não estava exportado no shell desta sessão por padrão,
  setar antes de rodar (`postgres://mostrai:mostrai@localhost:5432/mostrai`
  local).
- Pendente ainda dentro desta rodada: polimento visual do card "Meus
  endereços" foi feito (foto/placeholder, segmento), mas a tabela/grade de
  Candidaturas no admin não ganhou redesign além do necessário pra mostrar
  o campo novo (bairro na ficha de detalhe) — fora do escopo explícito do
  prompt, Parte AN.

## Reorganização definitiva da antiga área Entrada (22/09/2026, este agente)
Pedido do dono, spec de 36 partes numa mensagem só + critério de aceite,
autorização direta pra implementar sem pausa por decisão visual pequena.
Objetivo: "Entrada" deixa de existir na navegação do admin. Detalhe técnico
completo no relatório final desta sessão (não duplicado aqui — ver PR/commit
`reorganizar entrada: candidaturas em Rede, mensagens em Visão Geral,
convites fora da UI`).

**Em uma linha cada:**
- Candidaturas virou 2ª aba de `rede` (`public/admin/index.page.js`): grade
  de cards (mesmo idioma visual de Pontos) → ficha somente com
  Aprovar/Recusar, sem funil CRM. Aprovar reaproveita 100% do mecanismo que
  já existia (`liberarPapelNaConta` quando tem `conta_id`, `POST
  /admin/convites` com `candidatura_id` no caminho legado sem conta) — zero
  rota nova.
- Mensagens saiu da navegação, virou alerta condicional na Visão Geral
  (`ALERTAS`) que abre uma rota interna sem item de sidebar — módulo novo
  `oculto: true`, filtrado em `montarNav()`. `GET/PATCH
  /admin/mensagens-contato` já existiam, sem mudança de backend.
- Convites: removido da UI (nav, `ALIASES_ANTIGOS`, `SUBTITULOS`) sem tocar
  backend/DB. `renderConvites` virou `_renderConvites` (prefixo `_`, convenção
  do lint do projeto pra código morto intencional) — mantido como legado, sem
  chamador no router. Hash antigo `#convites` cai sozinho em `visaogeral`
  (`resolverAlvo` já degradava assim; comportamento pré-existente, só
  confirmado).
- Bug real encontrado e corrigido no caminho: preview de foto no formulário
  de candidatura (`public/modos.js` e `public/anunciante/painel.page.js`)
  nunca aparecia — `URL.createObjectURL` gera `blob:`, fora da CSP
  (`img-src 'self' data:`). Trocado por `FileReader.readAsDataURL()` (já
  permitido), sem alterar a CSP.
- `src/admin/routes.js`: contagem de "Em análise" ampliada de `status =
  'nova'` pra `status NOT IN ('aprovada','recusada')` (cobre `em_contato`
  legado também) — única mudança de backend do round.
- Migration: nenhuma. O CHECK de `candidaturas.status` (4 valores) já
  cobria a simplificação — "Em análise" é só `nova`+`em_contato` tratados
  igual na UI.
- Fora do escopo deliberadamente (confirmado no critério de aceite): o
  preview ao vivo do "futuro ponto" ao lado do formulário (era exemplo, não
  obrigatório).

**Verificado:** `npm run check` 161/161; Playwright cobrindo
desktop/tablet/mobile (candidaturas, ficha, Visão Geral, Mensagens, hash
antigo), sem erro de console novo.

**Fundida em `main` (PR #9) no mesmo dia** — nota original desta seção
("sem merge em `main`") corrigida aqui porque ficou desatualizada; ver a
seção de merge acima, no topo deste arquivo.

## Rede, rodada final — status automático, telas em cards, ocupação como tabela (22/09/2026, este agente)
Prompt de 35 seções do dono: "considere este prompt como a especificação
definitiva desta tela... o objetivo é ENCERRAR a revisão da Rede depois
desta rodada." Substitui as decisões de instalação/ACM/status
intermediários das duas rodadas anteriores (seções G/L, abaixo). Autorizado
a implementar tudo sem pausa, exceto decisão de negócio real (nenhuma
encontrada). Detalhe completo em `docs/PENDENCIAS.md` seção M; a decisão
que valia ADR foi pra `.ia/DECISIONS.md` (ADR-009).

**Pré-voo (seção 34 do prompt) — respondido antes de codar:**
1. Consumidores de `pontos.status` mapeados por grep: `src/playlist/gerador.js`
   (elegibilidade), `src/lib/aparelho.js` (gate do player), `listarPublicos`/
   `pontos-disponiveis`/`PUT /anunciantes/me/pontos` (visibilidade e escolha),
   `somaFluxoMensal`/`avaliarBloqueios` (só `em_operacao`), admin
   (`public/admin/index.page.js`).
2. Estratégia: coluna real com 4 valores, escrita só por uma função
   (`sincronizarStatusPonto`), chamada de dentro de `dispositivos/repository.js`
   nos 3 pontos onde uma tela muda (criar/atualizar status/deletar) — nunca
   duas fontes de verdade, nunca computado no SELECT.
3. Regra 80/20: só existe o freio de 80% (`LIMITE_OCUPACAO_BLOQUEIA`,
   G.7) — mesma divergência de nomenclatura já registrada na rodada L
   (ADR-008), não fechada de novo aqui, só reconfirmada.
4. Peso do anunciante por ponto: `planos.segundos_por_hora` — métrica real
   já usada no motor de playlist, sem inventar score novo.
5. Margens/safe area: só existia um `?margem=N` uniforme no player (fallback
   legado mantido); não existia por tela nem por lado.
6. Horário: `horario_semanal` (jsonb, migration 066) já guardava por dia
   individual, apesar do formulário só perguntar 3 grupos — achado que
   evitou migration de dado (só a chave `feriados` nova).
7. Migrations necessárias: uma (069) — 4 valores de status + 4 colunas de
   margem em `dispositivos` + default de `dispositivos.status` pra
   `'inativo'`.
8. Bloqueador real: nenhum. Prosseguiu com a implementação completa.

**Em uma linha cada:**
- Migration 069 (única desta rodada): `pontos_status_check` novo (4
  valores), `dispositivos.status` DEFAULT `'inativo'` (era `'ativo'` —
  tela nova nasce sem confirmar operação; furo pego pelos testes de
  playlist quebrando, corrigido nos próprios testes — ver abaixo), 4
  colunas de margem em `dispositivos` (`numeric NOT NULL DEFAULT 0 CHECK
  (>= 0)`).
- `sincronizarStatusPonto` (`src/pontos/repository.js`) nova, única escrita
  de `pontos.status`. `status` saiu de `CAMPOS_ATUALIZAVEIS` de pontos —
  ninguém mais edita via PATCH.
- **Dois lugares criavam uma "Tela 1" vazia junto com o ponto**
  (`src/conta/modos.js#liberarPapelNaConta`, `src/anunciantes/routes.js#
  criarPontoDaCandidatura`, e `src/pontos/routes.js` — cadastro de outro
  endereço pelo dono de ponto). Com o status automático, essa tela (nascida
  `inativo`) fazia o ponto virar "Inativo" no nascimento em vez de
  "Aguardando instalação" — **achado e corrigido nesta rodada**: os 3
  lugares pararam de criar a tela; o admin cria de verdade (`+ tela`) só na
  instalação real.
- `listarPublicos` (site público) e a lista de pontos disponíveis pro
  anunciante (`GET .../pontos-disponiveis`, `PUT .../pontos`) passaram a
  incluir `em_reparo` junto com `em_operacao`/`a_instalar` — o comentário
  de `listarPublicos` já dizia "ativos + em construção/reparo" desde antes
  (quando só existiam 2 valores possíveis, na prática cobria 100% dos
  pontos); `em_reparo` é estruturalmente igual a `a_instalar` (RN-49 já
  tratava "não veicula agora, mas é real" como escolha válida). Só
  `inativo` ficou de fora dos dois — o caso realmente novo.
- Admin (`public/admin/index.page.js`): `renderPontoInstalacao` (molde ACM
  + botões colocar/voltar de operação) removido de vez; `POST
  /admin/pontos/:id/foto` removido (só a candidatura sobe foto agora).
  Detalhe do ponto virou grid de 2 colunas com breadcrumb. Telas: tabela →
  cards (`montarTelaCard`), colunas Tela/Contrato/Custo/Meses/Amort./Painel
  saíram (o `contrato_playlist` que uma sessão paralela tinha acabado de
  adicionar como select saiu de novo — sem player de terceiro pra
  configurar aqui), 4 inputs de margem por tela entraram. Ocupação da rede:
  painel simples → tabela operacional (`caixaTabela`/`turbinarTabela`,
  expande peso por anunciante em segundos/hora ao clicar).
- Margens chegam no player pelo heartbeat (`GET /player/heartbeat/:id`
  devolve `margens`), aplicadas com `calc()` + inset real (`#quadro`/
  `#stage`, `public/player.css`/`.page.js`) — reaproveita a unidade (vmin)
  do `?margem=N` legado, que continua funcionando como fallback.
- Candidatura: foto subiu pro topo dos 2 formulários
  (`public/modos.js`/`public/anunciante/painel.page.js`), hint padrão que
  não some ao cancelar o seletor de arquivo (bug visto e corrigido no
  caminho), formulário completo organizado em blocos (Estabelecimento/
  Horário/Como você quer ser recompensado/Informações adicionais).
- `telas_instaladas` (coluna computada de `listar()`, base do extinto "TV
  instalada" da rodada L) confirmada sem consumidor e removida.

**Verificado:** `npm run check` 161/161 — `tests/redesenho-rede.test.js`
reescrito (a verificação de `telas_instaladas` virou uma sequência
completa de `sincronizarStatusPonto`: 0 telas → tela nasce inativa → ativa
→ reparo → inativa → 2ª tela ativa → apaga as duas, sem estado residual em
nenhum passo); `tests/categorias-concorrencia.test.js` e
`tests/playlist-contrato-novo.test.js` ajustados pro novo default de
`dispositivos.status` (helpers de teste agora marcam a tela `ativo`
explicitamente em vez de contar com o default antigo).
`tests/e2e/09-rede-redesenho.mjs` reescrito por completo (o da rodada L
testava Instalação/ACM/"TV instalada"/tabela de telas — nada disso existe
mais): 58 checagens, 0 falhas, screenshots em `tests/e2e/saida/v26-*.png`.

**Achado, não é bug, registrado pra não reabrir**: em navegador com locale
en-US, `<input type="time">` nativo pode renderizar em 12h com o AM/PM
cortado pela largura do campo (92px) — "18:00" aparece como "06:00" sem
"PM" visível. Valor salvo confirmado correto (24h, via `inputValue()`);
locale pt-BR (produção) já formata em 24h nativamente. Fora do controle da
página (input nativo do browser).

**Trabalhando na branch `claude/wonderful-hypatia-i7y4xx`, sem merge em
`main`.** Por pedido explícito do prompt: esta é a ÚLTIMA rodada de
redesenho da Rede — próximo trabalho na área é só ajuste pontual que o
dono pedir depois de revisar, não novo redesenho.

## Reauditoria de alinhamento com o app Android (22/09/2026, este agente)
Pedido do dono: o app (`sancompany/playlist.mostrai`) recebeu mais commits
(rotação de tela, PIN travado em 4 dígitos, assets de marca, preparo pro
`margemVmin`), conferir de novo o alinhamento — **sem mexer em
`margemVmin`**, que outro agente já está construindo do lado do app
(`playlist.mostrai` PR #2, branch `claude/festive-goldberg-4gdhqi`) e que
"deve ser ligado ao final". Detalhe completo em `docs/PENDENCIAS.md`,
seção H (segunda adenda, "Reauditoria de 22/09/2026").

**Resultado:** `main` continua alinhado depois de dois merges paralelos
(reforma de categorias + redesenho da Rede) que aconteceram entre a
auditoria anterior e esta — nenhum dos dois tocou playlist/dispositivos, o
select de `contrato_playlist` sobreviveu intacto, `npm run check` 161/161.

**Achado novo, registrado, não construído:** o app ganhou RN-15 — decide
tocar vídeo × tela institucional local só pela presença de `url` no item,
preparando um futuro "vídeo de fundo institucional pelo admin"
(`PARA-O-BACKEND.md`, novo no repo do app). Hoje o item institucional do
backend sempre manda `url: null` — confirmado. Mesma categoria de
`margemVmin`: precisa de decisão do dono (onde o vídeo mora, upload por
tela ou por ponto) antes de virar código — não construído.

**Trabalhando direto em `main`** (mudança é só documentação, nenhum código
tocado nesta rodada).

## Merge com a reforma de categorias (outra sessão, 22/09/2026, este agente)
`main` avançou (PR #5, "reforma da taxonomia de categorias") enquanto esta
sessão trabalhava a Rede — ambas tocaram `src/pontos/repository.js` e
`public/admin/index.page.js` na mesma área (ficha do ponto). Merge
resolvido: minha migration virou 068 (colisão de número com a deles, que já
era 067). Na ficha do ponto, a busca de categoria editável que eles
adicionaram (`categoriaBuscaHtml`/`ligarCategoriaBusca`, com limpeza de
`categoria_livre` ao escolher) **não entrou** — a ficha é somente-leitura
desde o redesenho desta sessão (pedido explícito do dono: só status/molde
ACM ficam editáveis, categoria não estava na lista). O componente de busca
continua ativo e usado normalmente no cadastro, nas outras telas públicas e
no detalhe de Anunciantes — só não em Pontos.
**Dívida real, registrada, não resolvida**: com isso, não existe mais UI
pra corrigir `categoria_id`/`categoria_livre` de um ponto já criado (antes
existia, meio errado, no formulário de cadastro manual removido). Na
prática `liberarPapelNaConta` já propaga a categoria da CONTA pro ponto no
nascimento (fix deles), então o caso só importa se a conta mudar de ramo
DEPOIS do ponto já existir — raro, e sem UI hoje pra corrigir se acontecer
(precisaria de PATCH direto ou uma tela nova, decisão do dono se quiser).
`npm run check` 161/161 depois do merge (153 desta sessão + 8 deles),
`tests/e2e/01-fluxo-api.sh` e `09-rede-redesenho.mjs` reconfirmados verdes.

## Redesenho completo da tela Rede do admin (22/09/2026, este agente)
Pedido do dono, autorização direta pra implementar a rodada inteira ("pode
implementar... não precisa perguntar de novo, só se achar decisão de
negócio nova"). Objetivo: Rede virar centro operacional — grade de cards →
ficha do ponto (somente-leitura) → Telas (única parte editável). Detalhe
técnico completo e as decisões tomadas em `docs/PENDENCIAS.md` seção K;
as duas decisões que valiam ADR foram pra `.ia/DECISIONS.md` (ADR-007
status visual derivado, ADR-008 divergência da regra 80/20).

**Em uma linha cada:**
- `public/admin/index.page.js`: grade de cards nova (`montarPontoCard`,
  `caixaCards` reaproveitado), placeholder de foto oficial
  (`fotoOuPlaceholder`, SVG de pin), status visual derivado
  (`statusVisualPonto`), ficha do ponto somente-leitura
  (`renderPontoInformacoes`) + painel de Instalação
  (`renderPontoInstalacao`, único trecho realmente editável fora de Telas),
  Ocupação virou painel agregado na Visão geral (`renderOcupacaoRede`).
- Removido da UI: bloco de foto-de-exemplo do site público, botão "+Novo
  ponto" (cadastro manual). O endpoint `POST /admin/pontos` foi removido
  de vez (backend) — confirmado sem consumidor real antes (nem teste, nem
  `docs/api.md`); `POST /admin/pontos/foto-exemplo` ficou no backend sem
  gatilho na UI (config ainda é lida pelo site público, só perdeu o jeito
  de trocar pela tela — dívida registrada, seção K).
- Migration 067: `candidaturas.foto_fachada_url` + `pontos.observacoes`,
  fechando os 2 furos do pipeline candidatura→ponto (o resto — endereço,
  segmento, responsável, movimento, horário — já fluía). Upload de foto em
  2 passos, autenticado (`POST /conta/modos/ponto/candidaturas/:id/foto`).
- **Achado real corrigido no caminho**: `segmento` no header da ficha só
  olhava `categoria_nome`/`categoria_livre` — mas `liberarPapelNaConta`
  nunca escreve essas duas colunas, só o `segmento` texto puro. Sem o
  fallback, praticamente todo ponto nascido da candidatura mostrava "Sem
  segmento informado". Corrigido (mesma prioridade do card:
  `categoria_nome || categoria_livre || segmento`).

**Verificado:** `npm run check` 153/153 (5 testes novos,
`tests/redesenho-rede.test.js`); `tests/e2e/01-fluxo-api.sh` e
`08-candidatura-ponto.mjs` sem regressão; `tests/e2e/09-rede-redesenho.mjs`
novo (39 checagens, screenshots desktop+mobile em `tests/e2e/saida/v25-*`).
`03-navegador.mjs` quebra num seletor de tabela de telas que já não existe
desde a reorganização de Rede por entidade de 21/09 — confirmado
pré-existente, não desta mudança.

**Trabalhando na branch `claude/wonderful-hypatia-i7y4xx`, sem merge em
`main`.**

## Current priority
Revisão manual funcional e visual conduzida pelo dono. Ele já está aproximadamente na metade. Não reiniciar auditoria: receber a próxima observação, investigar transversalmente e fazer a menor correção coerente.

## Auditoria pós-atualização do app Android (22/09/2026, este agente)
Pedido do dono: o player nativo (`sancompany/playlist.mostrai`) lançou uma
atualização, ele pediu pra ler o repositório e conferir o que falta no
backend do Mostraí pra suportar. Comparado campo a campo, rota a rota,
status a status contra o código atual do app — detalhe completo em
`docs/PENDENCIAS.md`, seção H (adenda de 22/09/2026).

**Resultado principal: o contrato novo já está pronto** (foi construído
numa sessão anterior, seção H original) — rotas, cabeçalho, envelope, lote
de `/played`, os 6 status de dedup, as duas garantias de imutabilidade que
o app depende. Nada disso precisou de código novo.

**O que faltava de verdade, corrigido nesta sessão:** não existia controle
nenhum na aba Telas do admin pra ligar `contrato_playlist=2` — só dava pra
fazer com um `PATCH` cru (curl/Postman). Adicionado um select "Contrato"
na tabela de Telas (`public/admin/index.page.js`, mesmo padrão do select de
Status já existente), sem migration nem rota nova. Verificado por
Playwright: cria ponto → aba Telas → troca o select → persiste no banco.

**Achados que NÃO são bugs, registrados pra quando o dono decidir:**
- PIN do app (sempre 4 dígitos, local) e PIN do site admin (4-6 dígitos,
  hoje só usado pelo player web) são dois sistemas desconectados — já
  listado como questão aberta no próprio repo do app.
- `margemVmin` por tela/por lado — já era backlog intencional ("não
  construir agora"), confirmado que continua sem campo no backend, como
  esperado.

**Verificado:** `npm run check` (156/156), Playwright manual do select novo.

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`.**

## Reforma da taxonomia de categorias concorrenciais (22/09/2026, este agente)
Pedido do dono, spec completa de 13 itens em uma mensagem, autorização direta
("pode implementar"). Regra imutável reafirmada: categoria existe só pra
impedir dois CONCORRENTES DIRETOS na mesma tela — `categoria_id` igual
bloqueia, grupo nunca bloqueia. Detalhe técnico completo (mapa das 22
categorias antigas → novas, o que ficou fora de propósito, checklist de
verificação) em `docs/PENDENCIAS.md`, seção K; regra formalizada pela
primeira vez em `docs/funcional.md` RN-57.

**O que mudou, em uma linha cada:**
- Migration 067 (aditiva): `categorias` ganha `grupo`, `aliases[]`, `legado`;
  `pontos` ganha `categoria_livre` (paridade com `anunciantes`). As 25
  categorias amplas antigas viram `legado=true` (Barbearia/Odontologia/
  Imobiliária foram upgradadas no lugar, mesmo `id`); ~229 categorias novas
  e específicas entram em 20 grupos. Nada foi apagado nem reatribuído sem
  aviso — correspondência proposta, não aplicada, é decisão do dono.
- `GET /categorias` só devolve ativas e não-legadas (com grupo+aliases);
  contas antigas continuam válidas e continuam bloqueando concorrência
  (legado nunca é excluído do que já está em uso, só do catálogo de opção).
- Todo select de categoria virou busca (nome+alias, sem acento/maiúscula,
  até 40 resultados) sobre um `<select>` escondido — `public/formulario.js`
  (compartilhado pelas 3 telas públicas) e uma cópia equivalente no bundle
  do admin (`public/admin/index.page.js`), mesma convenção do horário
  semanal. "Não encontrei minha categoria" cai em `categoria_livre` (texto
  livre, nunca bloqueia — reaproveita o padrão que `anunciantes` já tinha
  desde a migration 015, só faltava em `pontos`).
- Admin de Categorias: tabela ganhou colunas Grupo/Aliases, chip "Legado",
  filtro por grupo — sem virar tela gigante (busca já existente reaproveitada).
- **Dois furos reais, pré-existentes, corrigidos**: `criarPontoDaCandidatura`
  (`src/anunciantes/routes.js`) e `liberarPapelNaConta` (`src/conta/modos.js`)
  — os dois caminhos reais de nascimento de ponto — nunca copiavam
  `categoria_id`/`categoria_livre` da conta pro ponto novo, então o ponto
  nascia sem proteção de concorrente nenhuma. `POST /anunciantes/cadastro`
  ganhou validação de `categoria_id` (era 500, agora 400 pra id inválido).
- **Bug de infra encontrado no caminho**: `turbinarTabela` (helper de busca
  de tabela do admin) filtrava por `tr.textContent`, que não vê valor de
  `<input>`/`<select>` — a busca da tela de Categorias (e qualquer tabela
  toda feita de campos editáveis) não funcionava pra nada. Corrigido na
  raiz, no helper compartilhado.

**Deliberadamente fora desta rodada** (pedido explícito do dono): scoring,
recomendação automática, targeting, IA, múltiplas categorias por negócio,
hierarquia complexa de bloqueio. Ação pendente do dono: revisar a tabela de
correspondência em `docs/PENDENCIAS.md` seção K e decidir se alguma das 22
categorias legadas deve virar `ativo=false` de vez (hoje só saíram do
catálogo de opção — continuam bloqueando quem já as usa).

**Verificado:** `tests/categorias-concorrencia.test.js` (8 testes novos,
mesma-categoria bloqueia / categoria-diferente não bloqueia / categoria
nula não bloqueia / categoria_livre nunca bloqueia / legado ainda bloqueia
quem já usa / catálogo público exclui inativa e legado / `liberarPapelNaConta`
propaga categoria), `tests/e2e/01-fluxo-api.sh` estendido (categoria_id
inválido → 400), Playwright manual dos três widgets (busca por nome
completo, parcial, sem acento, por alias, "não encontrei", categoria já
legada ainda aparecendo pra quem já usa), `npm run check`.

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`.**

## Horário de funcionamento do ponto, construído (22/09/2026, este agente)
Pedido do dono, funcionalidade que ele lembrava de ter esquecido: cada ponto
precisa dizer seu horário de funcionamento (seg-sex / sáb / dom), e isso
precisa aparecer pro anunciante ao escolher onde o anúncio roda. Investigação
confirmou: `pontos.horario_abertura`/`horario_fechamento` (migration 001)
existiam no banco desde o início e nunca foram ligados a formulário nenhum —
exatamente a lacuna que o dono lembrava. Detalhe técnico completo em
`docs/PENDENCIAS.md`, seção J.

**O que mudou, em uma linha cada:**
- Migration 066: `pontos.horario_semanal` e `candidaturas.horario_semanal`
  (jsonb, um valor por dia da semana), colunas antigas mantidas paradas.
- `src/lib/horario-semanal.js` — `validar()` e `resumo()`, únicos, usados
  nos três lugares que escrevem ou leem o campo.
- `POST /conta/modos/ponto/pedir` (as duas telas públicas de candidatura)
  passou a EXIGIR o horário — único momento em que quem sabe o horário do
  comércio está preenchendo o formulário.
- Widget de 3 grupos (seg-sex/sáb/dom, domingo fechado por padrão)
  duplicado em `public/modos.js`, `public/anunciante/painel.page.js` e
  `public/admin/index.page.js` — sem bundler, é a convenção do projeto.
- Admin (`POST /admin/pontos`, cadastro manual) deixa o campo opcional por
  um checkbox desmarcado — não silenciosamente 09:00-18:00 como se fosse
  real (placeholder virando dado falso).
- `GET /anunciantes/me/pontos-disponiveis` ganhou `horario` (resumo
  textual); o anunciante vê no `title` (tooltip) do nome do ponto, sem
  alargar a lista compacta (`.ponto-escolha`, redesenhada 19/09/2026).
- Achado e corrigido no caminho: o card estreito de "Novo ponto" no admin
  (~420px) espremia os campos de hora até sobrar só o ícone, porque
  reusava o layout de 3 colunas aninhadas do formulário público (640px) —
  virou 2 linhas só na versão do admin.

**Verificado:** `tests/horario-semanal.test.js` (8 testes novos), `npm run
check` (141/141), os e2e que passam pela rota
(`01-fluxo-api.sh`/`02-...comissao.sh`/`04-modos-e-bonus.sh`/
`03-navegador.mjs`/`08-candidatura-ponto.mjs`) e verificação visual manual
por Playwright dos três widgets.

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`.**

## Varredura visual do admin — botões sem CSS e avisos mal coloridos (21/09/2026, este agente)
Pedido do dono: mapear a funcionalidade do admin e corrigir botão mal estilizado, aviso inútil e função em aberto. Login via Playwright em todos os 12 módulos/22 telas (incluindo detalhe de ponto e de anunciante). Achados reais, corrigidos — detalhe técnico em `docs/PENDENCIAS.md`, seção I:
- Crash de verdade ao abrir Conteúdo → Aprovação pelo menu (`renderCriativos` recebia `resto=null` do roteador genérico, não `undefined`, e o parâmetro default nunca entrava).
- 4 `<input type="file">` nativos (cinza, fora do desenho) viraram o padrão já usado em "Subir anúncio": label estilizada escondendo o input de verdade.
- 2 checkboxes virando "barra cinza" cobrindo a linha inteira (Convites "papéis da conta" e Pontos "Molde de ACM") — mesmo bug do `.card input{width:100%}` que `.check-row` já resolvia noutro lugar, agora generalizado.
- Checkboxes de tabela azuis (cor do navegador) em Custos/Categorias/Comodato/Benefícios — regra geral `input[type=checkbox]{accent-color:var(--brand)}` no admin, resolve para sempre.
- Aviso "conciliação nunca rodou" estava verde (`.tudo-em-dia`) e o caso realmente grave (atrasada/abortou) saía SEM cor nenhuma (classe errada, `alertas` plural em vez de `alerta`). Trocados por laranja/vermelho, condizente com a gravidade.
- De brinde: a violação de CSP inline-style em Diagnóstico (já sabida, "não tocada") sumiu ao trocar `style="padding:14px"` por uma classe utilitária que já existia.

Nenhuma função foi removida — a varredura não achou nada sem uso real; o inventário de `docs/specs/2026-09-21-admin-inventario-funcoes.md` continua batendo. `npm run check` 133/133, zero erro de console em todas as 22 telas (desktop + mobile 390×844). Dados de teste acumulados no banco (24 eventos pendentes, um "Contador" duplicado em Custos) não foram apagados — é limpeza de banco, que o dono já disse que vai fazer à parte.

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`.**

## Contrato novo de playlist/played pro app Android nativo (21/09/2026, este agente)
Pedido direto do dono: "leia o repositório do aplicativo e faça o que tiver
que fazer do seu lado" — referência ao app irmão `sancompany/playlist.mostrai`
(Android TV nativo, sideload), cuja estação 5 já estava pronta esperando o
Mostraí publicar o contrato que ele já sabe consumir (envelope com
`versaoContrato`/`janelaId`/`itemProgramacaoId`/`criativoId`, `POST /played`
em lote deduplicado por `execucaoId`). Contrato completo em `docs/api.md`,
"Tela (chave de aparelho)"; resumo técnico em `docs/PENDENCIAS.md` seção H.

**O que mudou, em uma linha cada:**
- `dispositivos.contrato_playlist` (migration 065, padrão `1`) decide POR
  TELA se `/playlist` devolve o array de sempre ou o envelope novo — o app
  não manda cabeçalho de versão, então virou config por dispositivo.
- `itemProgramacaoId` embute índice (posição na hora congelada) + quem
  creditar, pra `/played` não precisar reconstruir a hora.
- `execucoes_confirmadas` (ledger novo) + `execucoes-repository.js` credita
  e deduplica na MESMA transação — sem essa atomicidade, um crash no meio
  perderia o crédito de uma exibição real pra sempre.
- Bug achado e corrigido no caminho: `dispositivosRepo.deletar` não limpava
  `playlist_hora_congelada` (existe desde a migration 064) — apagar tela que
  já gerou playlist falhava com FK, sempre, desde 19/09. Corrigido.

**Deliberadamente intocado:** `public/player.page.js` (player web, contrato
1, não mudou nem uma linha) e o repositório `sancompany/playlist.mostrai`
(o pedido foi só do lado do Mostraí — "do seu lado"). Nenhuma tela em
produção foi migrada pra `contrato_playlist=2`; isso só faz sentido depois
do dono confirmar o app rodando em hardware real (pendência do OUTRO
repositório) e então marcar a tela específica no admin.

**Verificado:** `npm run check` (133/133, 5 testes novos em
`tests/playlist-contrato-novo.test.js`), e fumaça manual pela API HTTP real
(servidor local + Postgres local: tela de teste em contrato 2 recebendo o
envelope, `/played` em lote com item malformado devolvendo `item_invalido`,
tela legada em paralelo sem mudar nada, exclusão da tela de teste pelo
admin funcionando).

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`.**

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

## Troca de plano com acerto agora redireciona pro Checkout aprovar (21/09/2026, este agente)
O San Checkout mudou de contrato NO MESMO DIA (`sancompany/san_checkout` commit
`9c21be1`, "Trocar de plano redireciona o pagador ao Checkout para aprovar o
acerto") — o dono testou o caminho de 17-18/09 (cobrava direto no cartão
salvo, sem o pagador ver nada) e reverteu: quando há diferença a pagar,
`POST /trocar-plano` agora responde `202` com `approvalUrl`, e só cobra depois
que o pagador aprova numa tela do próprio Checkout. Sem diferença
(rebaixamento/absorção < R$5), continua `200` na hora, sem redirect, igual
sempre foi.

**O que mudou no Mostraí**, pra acompanhar:
- `src/financeiro/routes.js` (`POST /anunciantes/me/trocar-plano`): novo
  ramo pro `202` — não aplica nada, só repassa `approvalUrl`/`expiresAt`/`amount`
  pro front. A linha `pendente_troca` fica como está.
- `src/financeiro/san-checkout.js` (`processarWebhookAssinatura`, evento
  `plano_trocado`): deixou de ser no-op. Agora só é no-op quando a
  assinatura já está `ativa` (caso síncrono, sem acerto); quando ainda está
  `pendente_troca`, este webhook é quem aplica a troca de verdade (marca
  trocada/ativa, atualiza `anunciantes.plano_id`, grava
  `cobrancas_confirmadas` se houve cobrança, manda o e-mail) — é o ÚNICO
  sinal de que a troca aconteceu no caso assíncrono.
- `public/anunciante/confirmar-plano.page.js` (`montarConfirmacaoTroca`):
  no `202`, redireciona `window.location.href = approvalUrl` (mesmo padrão
  que `assinar()` já usa pra assinatura nova).
- Docs atualizados: `docs/api.md`, `docs/funcional.md` (RN-52),
  `docs/PENDENCIAS.md` (seção G.9, com o limite conhecido: link nunca
  aprovado deixa uma linha `pendente_troca` órfã, inofensiva, sem
  varredura própria — fora de escopo desta entrega).

**Verificado:** `npm run check` (127/127 testes) contra Postgres local
real — dois testes novos usam linhas reais em `anunciantes`/`assinaturas`
(não um cliente de pool simulado: `pool.query` da dedupe do webhook e
`pool.connect` da transação da troca coexistem na mesma função, e simular
só `connect` trava o `query` por dentro do `pg-pool` — achado construindo
o primeiro teste, documentado no próprio arquivo). Não testado no
navegador contra um Checkout de verdade respondendo 202 (sandbox não tem
acesso de rede pro Checkout real) — só revisão do diff + testes de
unidade do lado do Mostraí.

**Pendência que este item resolveu, mas não a que motivou a pergunta
original:** a pendência 11 (antiga) do `PENDENCIAS.md`, sobre configurar o
San Checkout pra aceitar pedido avulso, segue corretamente marcada como
caída — o pedido avulso continua aposentado como caminho de troca de
plano, o `202` novo não trouxe ele de volta.

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
