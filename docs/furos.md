# Furos do Mostraí

132 furos levantados em 15/09/2026 por oito lentes sobre a teia inteira
(`docs/teia.md`): **31 críticos, 51 altos, 39 médios, 11 baixos**.

**Rodada de novo em 16/09/2026** contra o código de hoje — resultado logo
abaixo, antes do placar de 15/09.

**Isto é uma lista de hipóteses com endereço, não de fatos.** A varredura leu o
código; a verificação adversarial foi interrompida por limite de sessão e depois
cancelada por custo — verificar por agente custava caro e rendia menos que abrir
a tela. Cada furo se confirma ou cai na hora de consertar, no navegador.

Não é teoria: dos seis primeiros abertos, cinco se confirmaram e **um caiu** —
`carregarExtrato` não derrubava o painel do ponto, o erro era engolido em
silêncio, que é outro problema e outro conserto.

Regra: nada daqui vira código sem ser reproduzido antes. O que já foi
reproduzido e consertado sai desta lista e vira commit.


---

## Segunda passada, 16/09/2026 — a lista foi rodada de novo contra o código

**Por que rodar de novo.** O placar de 15/09 fechou as quatro seções, mas
desde então entrou muito código: vitrine de planos reorganizada, cancelamento
e troca de plano, depuração visual do site inteiro, e os itens 16 a 19 da
seção F. Furo fechado não fica fechado sozinho — e código novo traz furo novo.

**Como foi rodada.** Três varreduras, nesta ordem:

1. **Furo a furo, com teste automático.** 78 checagens concretas contra a
   árvore de hoje, uma por furo verificável.
2. **As lentes da lista aplicadas à árvore inteira, não à lista.** Rota do
   servidor sem tela que a chame; função chamada e nunca declarada; `id` que o
   JS procura e o HTML não tem; rota viva fora do `docs/api.md`; tabela que
   ninguém lê; coluna escrita e nunca lida.
3. **Navegador.** As 22 páginas públicas em 1440px e 390px, escutando
   `pageerror` e medindo estouro. Zero erro de JS, zero estouro.

**Resultado: 11 alarmes na primeira varredura, 9 deles erro do teste e não do
código.** Vale registrar, porque é o mesmo aviso que abre este documento — a
lista é de hipóteses, e hipótese se confirma abrindo. Os nove:

- `[hidden]` do botão: o conserto existe, mas como `[hidden] { display: none
  !important }` global, melhor que a regra por classe que a lista propunha.
- FAQ de cancelamento: existe em `planos.html` ("Como eu cancelo?"); o teste
  procurava a palavra "cancelar", que não aparece em "cancelo"/"cancelamento".
- `pendente_aprovacao`: só sobrevive em migration antiga (história, imutável) e
  num comentário que explica a remoção. Não é código vivo.
- Painel do vendedor sem perfil: tratado, com estado próprio pro 403. O teste
  olhava um arquivo que não existe (`vendas.page.js`; é `vendedor.page.js`).
- Erro do servidor no login/cadastro: tratado, inclusive o 429. Mora nas
  páginas, não no `formulario.js` onde o teste procurou.
- Tela em reparo recebendo playlist: barrado em `src/lib/aparelho.js`, no
  middleware que autentica o aparelho — lugar certo, não no gerador.
- Limite de criativos na vitrine: dito, mas como TEXTO DE BENEFÍCIO no banco
  ("Até 2 criativos ativos, revezando entre si"), não como campo no HTML.
- `/contato` gravando a mensagem: grava; a tabela chama `mensagens_contato`.
- `POST /admin/pontos/:id/aparelho`: continua viva de propósito, respondendo
  410 e dizendo qual é o caminho novo. Lápide é melhor que ausência.

**Os quatro que eram furo de verdade — consertados nesta passada:**

**1. [x] M11 de volta por outra porta: custo por exibição ignora os descontos
de parceiro e de comodato.** O furo M11 original (custo por exibição usando
preço de tabela) foi fechado em 15/09 fazendo a conta enxergar
`valor_mensal_travado` e a cortesia. Só que os descontos de parceiro (RN-31) e
de comodato (RN-32) nasceram DEPOIS, em `valorMensalDaConta` — e a conta
inline de `src/anunciantes/routes.js` não os acompanhou. Resultado medido, com
o plano Destaque trimestral e 1000 exibições confirmadas:

| conta | mostrava | paga de verdade |
|---|---|---|
| comum | R$ 0,5672 | R$ 0,5672 |
| dono de ponto (comodato 20%) | R$ 0,5672 | **R$ 0,4537** |
| parceira (10%) | R$ 0,5672 | **R$ 0,5104** |

O cliente com desconto via, na própria tela, um custo por exibição 25% maior
do que o que paga. Conserto: a rota passa a chamar
`sanCheckout.valorMensalDaConta`, a mesma função que decide o que o Checkout
cobra. Preço de cobrança não pode ter duas fontes.

**2. [x] `mensagens_contato` é gravada e ninguém nunca a lê.** Furo NOVO,
criado pelo próprio conserto de 15/09: a migration 039 passou a gravar a
mensagem antes de tentar o e-mail, justamente pra que falha de SMTP perdesse o
aviso e não o dado. Só que nenhuma tela lia a tabela — o dado ficou salvo e
invisível, que é o mesmo furo por outra porta. E pior do que parece: o SMTP
está fora do ar (seção F, item 2), e `/contato.html` se declara canal de
pedido do titular (LGPD art. 18), que tem prazo legal. Hoje, todo pedido de
dado pessoal cai nesse buraco. Conserto: aba **Mensagens do site** no admin,
com a coluna "aviso" dizendo se o e-mail chegou (quando não chegou, a tela é o
único lugar onde a mensagem existe), contador de fila no menu, e marcação de
respondida (migration 044) — fila que não se limpa deixa de ser olhada.

**3. [x] `POST /admin/eventos-pendentes/:id/aplicar` fora do `docs/api.md`.**
Rota viva, com botão no admin ("Aplicar este ciclo"), que credita cobertura
depois de conferir a cobrança no Checkout. Caminho de dinheiro não documentado
— e o doc listava só o `PATCH` irmão, que apenas arquiva e não credita nada.
Quem lesse o doc concluiria que a fila de eventos não tem saída.

**4. [x] `POST /anunciantes/:id/dispositivos/:dispositivoId/pin` fora do
`docs/api.md`.** O doc tinha o irmão `GET .../painel` e não esta.

**O que a segunda passada confirmou que continua fechado:** tudo o mais. As
117 rotas vivas contra o `docs/api.md`: 4 apareciam fora e todas estão lá, em
entradas combinadas que o teste não sabe ler. Nenhuma tabela sem leitor além
da de contato. Nenhuma coluna morta nas migrations novas. Nenhum erro de JS
em nenhuma página.

**Uma lição de método que ficou.** O estouro da célula de mensagem na aba nova
não vazava a tela, então a medição automática deu tudo certo — quem pegou foi
olhar a captura. Medição automática pega o que sai da janela; sobreposição
dentro de uma tabela só se vê.

---

## Placar final em 15/09/2026 — as quatro seções fechadas

**Os 132 furos foram percorridos.** O que sobrou depende do dono, não de
código, e está em `docs/PENDENCIAS.md`:

- **prova social** (depoimento, foto de ponto real, cliente citado): não dá pra
  inventar — precisa do primeiro cliente e da autorização dele;
- **CNPJ e razão social na identificação do fornecedor**: a empresa está em
  constituição; enquanto isso o rodapé traz cidade, e-mail, WhatsApp e o canal
  de dados pessoais, e o contrato diz que não há emissão de nota fiscal até o
  CNPJ existir.

Tudo o mais foi consertado e verificado — no navegador, no banco, ou pelos
testes ponta a ponta. As seções abaixo ficam como registro do que era, com o
detalhe de cada um: é o mapa de onde este projeto erra quando erra.

O detalhamento da seção Crítica, que foi a primeira a fechar, segue abaixo.

## Placar em 15/09/2026 — a seção Crítica está fechada

Dos 31 furos críticos: **29 consertados e verificados** (no navegador, no banco
ou pelos testes ponta a ponta) e **2 refutados** na hora de abrir.

Consertados em 14 e 15/09, nesta ordem: `carregarExtrato` escrito e a seção de
recebimentos criada · fila de devolução (PATCH numa rota POST — o mesmo furo
aparece quatro vezes na lista, por quatro lentes) · `Baixar comprovante`
apontando pra `/anunciantes/null/` · página de retorno `/obrigado.html` e
`returnUrl` no link do Checkout · aba de pagamento ao dono do ponto no admin ·
receita recorrente somando cortesia, conta excluída e cobertura vencida ·
e-mail de pagamento que dizia que o anúncio rodava sozinho · aviso de conta
aprovada · custo por exibição usando preço de tabela em vez do travado ·
`[hidden]` perdendo pro `display` do `.btn` · selo "preço fundador" sem
`preco_travado` (migration 028) · botão de cancelar assinatura · login de conta
excluída que dizia "senha inválida" · aba "Meus anúncios" sempre vazia ·
cobertura vencida que nunca suspendia · vitrine prometendo cancelamento
self-service · abatimento por tela fora do ar prometido em `pontos.html` ·
contrato prometendo "aguardando ponto" sem cobrança · comodato descrevendo um
formulário que não existe · ramo do negócio não exigido ao virar anunciante ·
bônus de ponto entrando na receita como cliente pagante · falha no meio do
ciclo pago sem virar pendência · vitrine sem resposta a "como eu cancelo"
(FAQ) · vitrine vendendo cobertura sem dizer que a rede está vazia.

Refutados, com a checagem que derrubou cada um: a aba "Mensal" da vitrine não
é vazia (há três planos mensais ativos) e `categoria_id` **é** gravado nos
caminhos de criação de ponto — o furo real, ao lado, era do outro lado do
balcão (virar anunciante pelo painel não exigia ramo) e esse foi consertado.

**O que sobra:** as seções Alta, Média e Baixa abaixo.

---

## Critica

**Painel do dono de ponto quebra em toda visita: carregarExtrato() não existe** *(beco sem saída)*
  · onde: public/anunciante/ponto.page.js:13 (+ public/anunciante/ponto.html, src/pontos/routes.js:77)
  · evidência: ponto.page.js:13 faz `await Promise.all([carregarTelas(), carregarPontos(), carregarExtrato()])`. O arquivo tem 142 linhas e declara apenas `carregar`, `tempoDesde`, `online`, `carregarTelas`, `abrirPainel`, `carregarPontos` — `carregarExtrato` não existe em nenhum arquivo do repositório (grep em public/ e src/ só…
  · conserto: Escrever `carregarExtrato()` em public/anunciante/ponto.page.js consumindo GET /anunciantes/me/pontos/extrato e acrescentar a seção correspondente (com estado vazio) em public/anunciante/ponto.html; enquanto isso não existir, remover a…

**Fila de devoluções por arrependimento não fecha: a tela manda PATCH numa rota POST** *(beco sem saída)*
  · onde: public/admin/index.page.js (renderArrependimentos, botão 'Registrar devolução') + src/titular/routes.js:150
  · evidência: O handler do botão chama `salvar('/admin/arrependimentos/${btn.dataset.estornado}/estornado', { comprovante: campo.value.trim() })`, e `salvar()` em public/admin/index.page.js:34-35 é `api(caminho, { method: 'PATCH', ... })` — método fixo. A rota registrada é `router.post('/admin/arrependimentos/:id/estornado')` em…
  · conserto: Trocar a chamada em renderArrependimentos por `api(`/admin/arrependimentos/${id}/estornado`, { method: 'POST', body: JSON.stringify({ comprovante }) })` em /home/user/MostrAi/public/admin/index.page.js.

**Botão 'Baixar comprovante' nasce apontando para /anunciantes/null/ e devolve 403** *(beco sem saída)*
  · onde: public/anunciante/painel.page.js:164-172 (IIFE `comprovante`) + src/anunciantes/routes.js:380-383
  · evidência: A IIFE `comprovante()` roda no parse do script e monta `link.href = `${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/exibicoes.csv?dias=${sel.value}``. Nesse instante `ANUNCIANTE_ID` ainda é `null` (declarado na linha 4 e só preenchido dentro de `carregar()`, que é async e roda depois). O href só é reescrito no listener…
  · conserto: Chamar `atualizar()` também ao fim de `carregar()` (ou montar o href dentro de `carregarExibicoes()`) em /home/user/MostrAi/public/anunciante/painel.page.js.

**Não existe página de retorno depois do pagamento — o cliente sai do site e não volta** *(falta pra parecer sério)*
  · onde: public/ (não existe obrigado.html/sucesso.html/retorno.html) · public/anunciante/painel.page.js (assinar → window.location.href) · src/financeiro/san-checkout.js:70-72
  · evidência: `ls public/` não tem nenhuma página de status pós-pagamento. `linkCheckoutAssinatura` (src/financeiro/san-checkout.js:71) monta `${SAN_CHECKOUT_BASE_URL}/index.html?c=...&assinatura=...` — só dois parâmetros. `grep -rniE "returnurl|successurl|cancelurl|backurl|redirect_uri" src/ public/` retorna VAZIO: o San Checkout…
  · conserto: Criar public/obrigado.html ('recebemos, a confirmação leva alguns minutos e chega por e-mail'), passar a URL dela ao Checkout no linkCheckoutAssinatura (src/financeiro/san-checkout.js:70-72) e, no painel.page.js, mostrar 'pagamento em…

**Nenhuma página pública responde 'como eu cancelo' — e a vitrine diz o contrário do contrato** *(falta pra parecer sério)*
  · onde: public/planos.page.js:13 vs public/termos-de-uso.html:50
  · evidência: planos.page.js:13 imprime na aba Mensal: 'Sem compromisso: cobrança todo mês, cancele quando quiser.' termos-de-uso.html:50 diz: 'O cancelamento é feito mediante solicitação ao administrador da Mostraí (não existe cancelamento self-service no provedor de pagamento) e produz efeito a partir do próximo ciclo'. O código…
  · conserto: Trocar o texto de public/planos.page.js:13 por 'Cobrança mensal. Para cancelar, é só avisar a gente — vale a partir do próximo ciclo' e acrescentar a linha de cancelamento numa FAQ em public/planos.html.

**pontos.html promete abatimento por tela fora do ar que não existe no código e que os Termos negam** *(falta pra parecer sério)*
  · onde: public/pontos.html:61 vs public/termos-de-uso.html linha do item 7
  · evidência: pontos.html:61: 'Se algum ponto cai, ele sai da conta — você não paga por exibição que não aconteceu.' termos-de-uso.html §7: quedas de energia ou internet 'podem interromper temporariamente a exibição ... sem que isso gere direito automático a reembolso'. Busca por pro-rata/prorata/abatimento/crédito em src/ não acha…
  · conserto: Trocar a frase de public/pontos.html:61 por algo verdadeiro ('a tela manda sinal a cada 5 min e só conta a exibição que ela confirmou') ou construir a regra de abatimento — as duas coisas não podem coexistir.

**Devolução por arrependimento nunca fecha: a tela manda PATCH numa rota POST** *(estado invisível)*
  · onde: public/admin/index.page.js:1656 (via salvar(), linha 34-35) contra src/titular/routes.js:150
  · evidência: `salvar()` é fixo em `method: 'PATCH'` (index.page.js:35). O botão 'Registrar devolução' chama `salvar('/admin/arrependimentos/${id}/estornado', {comprovante})`. A rota registrada é `router.post('/admin/arrependimentos/:id/estornado')`. PATCH nesse caminho não casa com rota nenhuma, cai no 404 global e o admin vê o…
  · conserto: Em public/admin/index.page.js:1656, trocar `salvar(...)` por `api('/admin/arrependimentos/'+id+'/estornado', { method: 'POST', body: JSON.stringify({comprovante}) })` e tratar o retorno.

**Crédito de ciclo que falha no meio não gera pendência nenhuma — o cliente paga e fica sem cobertura, invisível** *(estado invisível)*
  · onde: src/financeiro/routes.js:244-252 e src/financeiro/san-checkout.js:337-343
  · evidência: A rota responde `res.json({ok:true})` ANTES de processar e o `.catch` só faz `console.error('erro processando webhook san-checkout', err)`. Em `aplicarCicloPago`, o catch faz ROLLBACK, `DELETE FROM webhooks_processados` e `throw` — não chama `registrarPendencia` em momento nenhum. Resultado: pagamento confirmado na…
  · conserto: No catch de `aplicarCicloPago` (src/financeiro/san-checkout.js:338), chamar `registrarPendencia(contexto, 'falha ao aplicar ciclo: '+err.message)` antes do `throw`, para que a falha caia na aba Eventos pendentes.

**Extrato do ponto: ReferenceError derruba o painel inteiro em toda visita, e a rota nunca é chamada** *(estado invisível)*
  · onde: public/anunciante/ponto.page.js:13; rota em src/pontos/routes.js:77
  · evidência: `await Promise.all([carregarTelas(), carregarPontos(), carregarExtrato()])` — `grep -rn carregarExtrato public/ src/` devolve exatamente UMA ocorrência: essa chamada. A função não existe em nenhum arquivo. O throw é síncrono dentro do callback `aoLiberado`, que modos.js:186 executa com `await` FORA do try (o try…
  · conserto: Escrever `carregarExtrato()` em public/anunciante/ponto.page.js consumindo `GET /anunciantes/me/pontos/extrato` e acrescentar o container correspondente em public/anunciante/ponto.html (o texto de vazio já está decidido em…

**Pagamento ao dono do ponto não tem aba no admin — o dono não consegue lançar nem quitar** *(estado invisível)*
  · onde: src/pontos/routes.js:171, 175 e 186; NAV em public/admin/index.page.js:130-160
  · evidência: As três rotas (`GET /admin/pontos/:pontoId/pagamentos`, `POST` da mesma, `PATCH /admin/pagamentos-ponto/:id`) estão declaradas DEPOIS de `module.exports = router` na linha 166 de src/pontos/routes.js — funcionam, mas ninguém as vê lendo o arquivo. `grep -rn pagamentos public/admin/` só retorna o funil da aba Métrica;…
  · conserto: Criar `renderPagamentosPonto(el)` em public/admin/index.page.js e um item no grupo Financeiro do NAV, consumindo as três rotas que já existem em src/pontos/routes.js:171-186.

**Receita recorrente do resumo soma cortesia, conta excluída e cobertura vencida — a margem mente** *(estado invisível)*
  · onde: src/admin/routes.js:64-67 e public/admin/index.page.js:337, 369
  · evidência: A query é `SELECT COALESCE(SUM(COALESCE(a.valor_mensal_travado, p.valor_mensal)),0) FROM anunciantes a JOIN planos p ON p.id=a.plano_id WHERE a.status='ativo'` — sem `plano_cortesia = false`, sem `excluido_em IS NULL`, sem `data_expiracao > now()`. Entram na 'Receita recorrente' e na 'Margem': cortesias liberadas por…
  · conserto: Acrescentar `AND NOT a.plano_cortesia AND a.excluido_em IS NULL AND (a.data_expiracao IS NULL OR a.data_expiracao > now())` à query de receita em src/admin/routes.js:64-67, e desenhar `anunciantesAtivosPagantes`/`anunciantesEmCortesia`…

**Site promete abatimento por tela fora do ar; não existe mecanismo e os Termos dizem o contrário** *(informação faltando)*
  · onde: public/pontos.html (razão "Player conectado o tempo todo") × public/termos-de-uso.html §7 × src/
  · evidência: pontos.html: "Se algum ponto cai, ele sai da conta — você não paga por exibição que não aconteceu." Busca em src/ por pro.?rata|abatimento|credito|reembols retorna APENAS o fluxo de arrependimento (src/titular/*) — não há nenhuma linha que desconte, credite ou recalcule valor por exibição não entregue.…
  · conserto: Remover a frase de public/pontos.html ou construir a regra de abatimento — hoje a página de venda contradiz o documento legal que o próprio cliente aceitou.

**RESOLVIDO em 22/09/2026 (reforma da taxonomia de categorias, docs/PENDENCIAS.md seção K) — "Sem concorrente na sua tela" não funciona: nenhum caminho de criação de ponto grava categoria_id** *(informação faltando)*
  · onde: src/anunciantes/routes.js:41-54 (criarPontoDaCandidatura), src/conta/modos.js:40-52 (liberarPapelNaConta), src/pontos/routes.js:39-56 (POST /anunciantes/me/pontos) × src/playlist/gerador.js:46
  · evidência original: O filtro de concorrente é `AND ($1::int IS NULL OR a.categoria_id IS NULL OR a.categoria_id <> $1)` em gerador.js, com $1 = ponto.categoria_id. pontosRepo.criar ACEITA categoria_id (src/pontos/repository.js:16-33), mas as três funções que criam ponto passam só `segmento` (texto livre) e nunca categoria_id.
  · conserto aplicado: `POST /anunciantes/me/pontos` (src/pontos/routes.js) já validava e gravava categoria_id antes desta rodada (corrigido em sessão anterior, sem atualizar este arquivo). `criarPontoDaCandidatura` e `liberarPapelNaConta` corrigidos agora — os dois copiam `categoria_id`/`categoria_livre` da conta pro ponto novo.

**Quem paga sai do site e nunca volta: não há returnUrl, não há página de retorno e o e-mail não tem link** *(informação faltando)*
  · onde: src/financeiro/san-checkout.js:70-72, public/anunciante/painel.page.js (window.location.href), public/ (sem obrigado/sucesso/retorno), src/financeiro/email.js:19-30
  · evidência: linkCheckoutAssinatura monta `${SAN_CHECKOUT_BASE_URL}/index.html?c=...&assinatura=...` — grep por returnUrl|successUrl|cancelUrl|backUrl|redirect_uri em src/ e public/ não retorna NADA. `ls public/ | grep -iE obrigad|sucesso|pagamento|retorno|status` não retorna nada. Ou seja: o Checkout não tem para onde devolver e…
  · conserto: Criar public/obrigado.html (consultando GET /anunciantes/me em polling) e passar o endereço dela ao San Checkout, senão o cliente que pagou não tem como distinguir sucesso de falha.

**E-mail de pagamento confirmado diz que o anúncio roda sozinho e não pede o vídeo** *(informação faltando)*
  · onde: src/financeiro/email.js:19-30 (enviarConfirmacaoPagamento)
  · evidência: Texto literal: "Assim que o primeiro ponto da rede estiver no ar, seu anúncio começa a rodar automaticamente. Você pode acompanhar tudo no seu painel." Falso: anunciantesElegiveis (src/playlist/gerador.js:37) exige `JOIN criativos c ... AND c.status = 'aprovado'` — sem upload e sem aprovação do admin nada roda. É…
  · conserto: Reescrever o corpo em src/financeiro/email.js para "suba seu vídeo no painel — ele entra no ar depois da aprovação" e incluir o link ${SITE_URL}/anunciante/painel.html.

**Aprovação da conta não avisa ninguém, e as três fontes prometem coisas diferentes** *(informação faltando)*
  · onde: src/anunciantes/routes.js:533-554 (PATCH /admin/anunciantes/:id) × public/anunciante/cadastro.html:135 × docs/funcional.md:346 × public/politica-de-privacidade.html §3
  · evidência: O handler do PATCH só chama repo.atualizar e eventos.registrar — o arquivo não faz require de src/financeiro/email.js em lugar nenhum. Enquanto isso: cadastro.html:135 diz "Você recebe o aviso no WhatsApp"; docs/funcional.md:346 diz "Avisaremos por e-mail quando ela for aprovada"; e politica-de-privacidade.html §3…
  · conserto: Ou disparar um e-mail na transição para aprovado em src/anunciantes/routes.js:544, ou corrigir cadastro.html:135, funcional.md e a Política — hoje as três mentem em direções diferentes.

**Comodato descreve um formulário que não existe: escolha de modalidade e checkbox de aceite ausentes** *(informação faltando)*
  · onde: public/comodato.html §3 e parágrafo final × public/seja-um-ponto.html
  · evidência: comodato.html §3: "No momento do cadastro, o estabelecimento escolhe uma entre as modalidades" e "Os valores e a quantidade de espaços de cada modalidade são os exibidos no formulário 'Seja um ponto'". Fecho: "Ao marcar 'Aceito os termos do comodato' no formulário de cadastro de ponto...". Em public/seja-um-ponto.html…
  · conserto: Carregar GET /planos-ponto em public/seja-um-ponto.html com os radios de modalidade e o checkbox de aceite linkando /comodato.html, ou reescrever o §3 e o fecho do contrato para descrever o fluxo real (escolha só no convite).

**Aba "Mensal" da vitrine é vazia e promete cancelamento self-service que os Termos negam** *(informação faltando)*
  · onde: public/planos.page.js (NOTA_CICLO[1]) × public/termos-de-uso.html §4.4 × src/db/migrations/005_planos.sql
  · evidência: NOTA_CICLO[1] = 'Sem compromisso: cobrança todo mês, cancele quando quiser.' Termos §4.4: "O cancelamento é feito mediante solicitação ao administrador da Mostraí (não existe cancelamento self-service no provedor de pagamento)". O código confirma os Termos: o único caminho é POST…
  · conserto: Remover a frase de NOTA_CICLO[1] em public/planos.page.js e esconder o botão "Mensal" enquanto não houver plano de 1 mês ativo.

**Extrato de pagamento do ponto existe no backend, não tem tela e ainda quebra o painel inteiro** *(informação faltando)*
  · onde: public/anunciante/ponto.page.js:13, public/anunciante/ponto.html, src/pontos/routes.js:77
  · evidência: ponto.page.js:13 faz `await Promise.all([carregarTelas(), carregarPontos(), carregarExtrato()])` e `grep -rn carregarExtrato public/ src/` retorna SÓ essa linha — a função não existe. O ReferenceError sobe até o `carregar().catch()` do fim do arquivo, que escreve "Não foi possível carregar sua conta agora." no…
  · conserto: Escrever carregarExtrato() consumindo GET /anunciantes/me/pontos/extrato e acrescentar o container em public/anunciante/ponto.html.

**Custo por exibição ignora o preço travado e a cortesia — número errado ao lado do preço certo** *(informação faltando)*
  · onde: src/anunciantes/routes.js:459 × src/financeiro/san-checkout.js (valorMensalDaConta) × public/anunciante/painel.page.js
  · evidência: routes.js:459: `custoPorExibicao: Number(plano.valor_mensal) * plano.compromisso_meses / confirmadas` — usa o preço de tabela. A cobrança real usa valorMensalDaConta(anunciante, plano), que prefere anunciante.valor_mensal_travado. O fundador com preço travado vê um custo por exibição MAIOR do que paga, na mesma tela…
  · conserto: Trocar o cálculo de src/anunciantes/routes.js:459 por sanCheckout.valorMensalDaConta(anunciante, plano) e devolver null quando plano_cortesia.

**Contrato do anunciante promete "aguardando ponto" sem cobrança — mecanismo removido pela migration 021** *(informação faltando)*
  · onde: public/contrato-anunciante.html §3 × src/db/migrations/021_remove_cobertura_adiada.sql
  · evidência: Contrato §3: "A contagem do período contratado só começa a valer a partir da data em que o primeiro ponto coberto pelo plano entrar efetivamente no ar. Enquanto a rede não tiver nenhum ponto ativo ... o contratante fica em situação de 'aguardando ponto' e não é cobrado por esse período de espera." A migration 021…
  · conserto: Reescrever o §3 de public/contrato-anunciante.html para o comportamento real (cobrança no ato da assinatura) — é a cláusula que mais expõe a operação a pedido de devolução.

**Devolução por arrependimento nunca fecha: a tela chama PATCH numa rota POST** *(informação faltando)*
  · onde: public/admin/index.page.js:1656 (salvar(...)) e :35 (method PATCH fixo) × src/titular/routes.js:150 (router.post)
  · evidência: O botão "Registrar devolução" chama `salvar('/admin/arrependimentos/${id}/estornado', {comprovante})`, e salvar() em index.page.js:35 é `api(caminho, { method: 'PATCH', ... })`. A rota registrada é `router.post('/admin/arrependimentos/:id/estornado')`. PATCH nesse caminho não casa com rota nenhuma → 404 → toast "Não…
  · conserto: Trocar por api(`/admin/arrependimentos/${id}/estornado`, { method: 'POST', body: JSON.stringify({comprovante}) }) em public/admin/index.page.js:1656.

**CEP do visitante vai para a ViaCEP (terceiro) e isso não está na Política nem no inventário de dados** *(informação faltando)*
  · onde: public/formulario.js:23, src/server.js:57 × public/politica-de-privacidade.html §4 × docs/
  · evidência: formulario.js:23 faz `fetch('https://viacep.com.br/ws/${cep}/json/')` no blur do campo, ANTES de qualquer envio; src/server.js:57 libera viacep.com.br em connect-src. A Política §4 "Com quem compartilhamos" lista apenas San Checkout/Asaas, Supabase e Google Drive. `grep -rn viacep docs/` não retorna NADA — nem…
  · conserto: Acrescentar ViaCEP em public/politica-de-privacidade.html §4 e em docs/inventario-de-dados.md, e uma linha no [data-cep-msg] de formulario.js dizendo que o CEP é consultado num serviço público de terceiro.

**`.btn { display: inline-flex }` anula o atributo `hidden` — botão destrutivo sempre aceso no admin** *(quebra visual)*
  · onde: public/style.css:83 (`.btn { display: inline-flex; ... }`) e :547 (`form.card[hidden], .card[hidden], .dashboard-grid[hidden], .wrap[hidden] { display: none; }` — `.btn[hidden]` não está na lista). Vítimas:…
  · evidência: A regra `[hidden] { display: none }` vive na folha do NAVEGADOR (origem UA). Qualquer declaração `display` de autor vence origem UA no cascade, independente de especificidade. Como `.btn` declara `display: inline-flex`, todo `<button class="btn" hidden>` fica VISÍVEL. Os dois únicos casos no repositório (grep…
  · conserto: Acrescentar `.btn[hidden] { display: none !important; }` em /home/user/MostrAi/public/style.css logo após a regra `.btn` da linha 83 — ou trocar a linha 547 por um seletor global `[hidden] { display: none !important; }`.

**Bônus 'anúncio grátis por ser ponto' não marca cortesia e entra na receita recorrente como cliente pagante** *(papéis cruzados)*
  · onde: src/conta/modos.js (POST /conta/bonus/anuncio/resgatar, UPDATE anunciantes) vs src/financeiro/routes.js (POST /admin/anunciantes/:id/liberar-plano) e src/admin/routes.js (GET /admin/resumo)
  · evidência: O resgate do bônus faz `UPDATE anunciantes SET plano_id = $2, status = 'ativo', data_inicio_cobertura = COALESCE(...), data_expiracao = now() + ($3 || ' months')::interval, anuncio_bonus_resgatado_em = now()` — e NÃO grava `plano_cortesia`. A cortesia do admin, no caminho equivalente, grava explicitamente…
  · conserto: Acrescentar `plano_cortesia = true` (e um `cortesia_motivo` tipo 'bônus de ponto') ao UPDATE do resgate em /home/user/MostrAi/src/conta/modos.js, e filtrar `AND NOT a.plano_cortesia AND a.excluido_em IS NULL AND (a.data_expiracao IS NULL…

**RESOLVIDO em sessão anterior, confirmado em 22/09/2026 (reforma da taxonomia de categorias, docs/PENDENCIAS.md seção K) — Ativar o modo anúncios por dentro do painel dispensa o ramo — e o anúncio passa a rodar dentro de concorrente direto** *(papéis cruzados)*
  · onde: public/modos.js:45 (CAMPO_SEGMENTO) e src/playlist/gerador.js (anunciantesElegiveis)
  · evidência original: `grep -rn data-categorias public/` mostra que public/anunciante/cadastro.html:48 e public/seja-um-ponto.html:70 marcam o select com `required`, mas public/modos.js:40 monta `<select ... data-categorias>` SEM `required`. `ligarCategorias` (public/formulario.js) nunca seta `required = true` — só seta `false` no caminho…
  · conserto aplicado: `<select id="${prefixo}categoria_id" name="categoria_id" data-categorias required>` já está com `required` em public/modos.js:45 — corrigido em sessão anterior, sem atualizar este arquivo. Não foi tocado nesta rodada.

**O primeiro cliente paga por uma rede com zero telas — e o contrato que ele aceitou diz que não deveria** *(primeira vez)*
  · onde: public/contrato-anunciante.html:39 · src/financeiro/routes.js:178-230 · src/financeiro/san-checkout.js (aplicarCicloPago) · src/db/migrations/021_remove_cobertura_adiada.sql
  · evidência: contrato-anunciante.html:39 (aceite obrigatório no checkbox do cadastro): 'A contagem do período contratado só começa a valer a partir da data em que o primeiro ponto coberto entrar efetivamente no ar. Enquanto a rede não tiver nenhum ponto ativo... o contratante fica em situação de "aguardando ponto" e não é cobrado…
  · conserto: Barrar em src/financeiro/routes.js, antes de criar a assinatura, com um SELECT COUNT(*) FROM pontos WHERE status='ativo' = 0 → 400 'a rede ainda não tem ponto no ar — deixe seu contato que a gente avisa quando abrir', ou reescrever a…

**Os 9 planos da vitrine nascem com o selo 'Preço fundador — nunca muda' e o preço não é travado** *(primeira vez)*
  · onde: src/db/migrations/014_planos_promo_e_limite_criativos.sql:9 · src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql:150 · public/planos.page.js:80 · src/financeiro/san-checkout.js (aplicarCicloPago)
  · evidência: A migration 014 faz `UPDATE planos SET rotulo = 'Preço fundador — nunca muda' WHERE compromisso_meses <> 1` — os 9 planos de 3/6/12 meses do seed. A migration 019:150 cria `preco_travado boolean NOT NULL DEFAULT false` e o único INSERT com preco_travado=true é o 'fundador-12m' (019:168), que nasce ativo=false.…
  · conserto: Ou trocar o rotulo dos 9 planos por algo verdadeiro numa migration nova, ou ligar preco_travado=true neles — mas os dois têm de ser a mesma coisa, e planos.page.js:80 não deve imprimir promessa de preço que não venha de preco_travado.

**Fila de devolução por arrependimento (CDC art. 49) nunca pode ser fechada: front manda PATCH, rota é POST** *(rota órfã)*
  · onde: public/admin/index.page.js:1656 → src/titular/routes.js:150
  · evidência: public/admin/index.page.js:1656 faz `salvar(`/admin/arrependimentos/${btn.dataset.estornado}/estornado`, { comprovante: ... })`, e `salvar()` (mesmo arquivo, linha 34) é fixo em `method: 'PATCH'`. A rota registrada é `router.post('/admin/arrependimentos/:id/estornado', ...)` em src/titular/routes.js:150 — não existe…
  · conserto: Em public/admin/index.page.js:1656, trocar o `salvar(...)` por `api(`/admin/arrependimentos/${id}/estornado`, { method: 'POST', body: JSON.stringify({ comprovante }) })` e tratar o `r.ok` na mão.

**Rota de cancelamento de assinatura não tem um único botão em lugar nenhum — a cobrança recorrente continua rodando** *(rota órfã)*
  · onde: src/financeiro/routes.js:294 (POST /admin/anunciantes/:id/cancelar-assinatura)
  · evidência: `grep -rn "cancelar-assinatura" public/` não retorna NENHUMA ocorrência (só docs/api.md:121 e docs/erros/). A rota existe e funciona (src/financeiro/routes.js:294 chama sanCheckout.cancelarAssinatura e marca a assinatura), e docs/api.md:121 a declara textualmente como **'Único caminho de cancelamento — o pagador nunca…
  · conserto: Acrescentar um botão 'Cancelar assinatura' na coluna de ações da aba Anunciantes em public/admin/index.page.js (renderAnunciantes, ~linha 834, ao lado de 'Liberar plano'), chamando `api('/admin/anunciantes/${id}/cancelar-assinatura', {…

**Painel do dono do ponto quebra em toda visita: carregarExtrato() não existe, e a rota de extrato é órfã** *(rota órfã)*
  · onde: public/anunciante/ponto.page.js:13 → src/pontos/routes.js:77 (GET /anunciantes/me/pontos/extrato)
  · evidência: public/anunciante/ponto.page.js:13 faz `await Promise.all([carregarTelas(), carregarPontos(), carregarExtrato()])`. `grep -rn "carregarExtrato" public/ src/ tests/` devolve EXATAMENTE essa linha e mais nada — a função não é definida em ponto.page.js (142 linhas, só carregar/carregarTelas/carregarPontos), nem em…
  · conserto: Em public/anunciante/ponto.page.js, escrever `carregarExtrato()` consumindo GET /anunciantes/me/pontos/extrato e acrescentar o container correspondente em public/anunciante/ponto.html (o texto do estado vazio já está decidido em…


---

## Alta

**Cancelar assinatura: rota existe, docs dizem ser o único caminho, e não há botão em lugar nenhum** *(beco sem saída)*
  · onde: src/financeiro/routes.js:294 (POST /admin/anunciantes/:id/cancelar-assinatura) + public/admin/index.page.js + docs/api.md:121
  · evidência: `grep -rn 'cancelar-assinatura' public/` não retorna nenhuma ocorrência — nem no admin nem no painel do anunciante. docs/api.md:121 descreve a rota como '**Único caminho de cancelamento** — o pagador nunca cancela sozinho'. Pior: src/financeiro/routes.js:275 recusa a cortesia com 409 'essa conta tem plano pago ativo —…
  · conserto: Acrescentar o botão 'Cancelar assinatura' na linha da aba Anunciantes em /home/user/MostrAi/public/admin/index.page.js, chamando `api('/admin/anunciantes/'+id+'/cancelar-assinatura', { method: 'POST' })` com confirm.

**Pagamento ao dono do ponto: três rotas de admin sem nenhuma tela que as chame** *(beco sem saída)*
  · onde: src/pontos/routes.js:171, :175, :186 + public/admin/index.page.js
  · evidência: Existem GET /admin/pontos/:pontoId/pagamentos, POST /admin/pontos/:pontoId/pagamentos e PATCH /admin/pagamentos-ponto/:id, com UNIQUE (ponto_id, competencia) na migration 022 e evento `ponto:pagamento_quita`. `grep -n 'pagamentos-ponto\|/pagamentos' public/admin/index.page.js` só retorna linhas da aba Métrica (a…
  · conserto: Criar a aba/seção de lançamento de pagamento ao ponto em /home/user/MostrAi/public/admin/index.page.js (dentro da aba Pontos ou uma aba nova no grupo Financeiro) consumindo as três rotas de src/pontos/routes.js.

**'Meus anúncios' do admin: a tabela da conta própria fica sempre vazia e 'Tirar do ar' faz a linha sumir de vez** *(beco sem saída)*
  · onde: public/admin/index.page.js (renderMeusAnuncios, `const criativos = await pegar('/admin/criativos')`) + src/admin/routes.js:16
  · evidência: `renderMeusAnuncios` chama `pegar('/admin/criativos')` SEM query string; src/admin/routes.js:16 faz `criativosRepo.listarPorStatus(req.query.status || 'pendente')`. O criativo subido pelo admin nasce aprovado: src/anunciantes/routes.js, `subirCriativo`, aplica `...(peloOperador ? { editado_pelo_operador: true, status:…
  · conserto: Trocar por `pegar('/admin/criativos?status=aprovado')` mais uma segunda chamada para 'reprovado' (ou um endpoint por anunciante) em renderMeusAnuncios de /home/user/MostrAi/public/admin/index.page.js.

**Conta logada perde todo caminho para /contato.html — que a documentação declara canal do titular de dados** *(beco sem saída)*
  · onde: public/layout.js:120-138 (troca do nav) e :98 (footer-links) + docs/funcional.md:395
  · evidência: Em layout.js:128 o bloco `if (layout === 'publico')` substitui o `innerHTML` INTEIRO de `header.site nav.main` pelas abas Anúncios/Meu ponto/Vendas + Planos + avatar. O item ['/contato.html','Contato'] do MENU_PUBLICO (layout.js:38) desaparece. O rodapé montado em layout.js:98 tem só Termos de Uso, Privacidade,…
  · conserto: Acrescentar `<a href="/contato.html">Contato</a>` ao `footer-links` de /home/user/MostrAi/public/layout.js:98 (aparece em todos os layouts, logado ou não).

**Login de conta excluída: o servidor explica, a tela mente 'E-mail ou senha inválidos'** *(beco sem saída)*
  · onde: public/anunciante/login.page.js:15-19 + src/anunciantes/routes.js:166-168
  · evidência: A rota devolve 403 com `{ erro: 'essa conta foi excluída — fale com o suporte pra recuperar' }` (routes.js:167) — mensagem escrita justamente para o caso do soft-delete recuperável por 60 dias. login.page.js:15 faz `if (!r.ok) { msg.textContent = 'E-mail ou senha inválidos.'; ... return; }` sem ler o corpo: 401, 403…
  · conserto: Ler o corpo da resposta em /home/user/MostrAi/public/anunciante/login.page.js e exibir `corpo.erro` quando o status for 403 ou 429, mantendo o texto genérico só no 401.

**Conta suspensa (inclusive pós-arrependimento) recebe o botão 'Escolher plano', que sempre falha** *(beco sem saída)*
  · onde: public/anunciante/painel.page.js:63-76 (preencherStatusBanner) + src/financeiro/routes.js:200
  · evidência: POST /titular/arrependimento (src/titular/routes.js:130-133) põe a conta em `status: 'suspenso', plano_id: null, data_expiracao: null`. `preencherStatusBanner` monta o rótulo por `ROTULOS.anunciante[status]` ('Suspenso') e, como `!ANUNCIANTE.plano_id`, sempre acrescenta `<a class="btn primary"…
  · conserto: Em `preencherStatusBanner` de /home/user/MostrAi/public/anunciante/painel.page.js, suprimir o botão 'Escolher plano' quando `status === 'suspenso'` e trocar por uma linha explicando o estado (e, havendo pedido de arrependimento, o…

**Estado 'pendente_aprovacao' não tem tela nem aviso, e as duas promessas de notificação não existem no código** *(beco sem saída)*
  · onde: src/anunciantes/routes.js:533-553 (PATCH /admin/anunciantes/:id) + public/anunciante/cadastro.html:135 + public/anunciante/painel.page.js:65 + docs/funcional.md:346
  · evidência: public/anunciante/cadastro.html:135 promete 'Depois do cadastro a gente confere seus documentos e libera a conta. Você recebe o aviso no WhatsApp.'; docs/funcional.md:346 promete 'Avisaremos por e-mail quando ela for aprovada'. O handler PATCH /admin/anunciantes/:id (src/anunciantes/routes.js:533-553) só faz…
  · conserto: Em /home/user/MostrAi/public/anunciante/painel.page.js, mostrar uma faixa explicativa quando `ANUNCIANTE.status === 'pendente_aprovacao'`, e alinhar a promessa: ou disparar o aviso no PATCH de src/anunciantes/routes.js, ou corrigir o texto…

**Não existe FAQ em nenhuma página — nem a pergunta mais óbvia de um produto pago é respondida** *(falta pra parecer sério)*
  · onde: public/planos.html (depois de #plansGrid) e public/index.html (antes do CTA final)
  · evidência: `grep -rniE "faq|perguntas frequentes|dúvidas frequentes" public/*.html` retorna VAZIO. Nenhuma página responde: quantos criativos meu plano permite (planos.limite_criativos vem em GET /planos e planos.page.js nunca imprime), quanto tempo leva a aprovação do criativo, o que acontece se for reprovado, tem nota fiscal,…
  · conserto: Acrescentar uma seção <section class="faq"> em public/planos.html, depois da grade, com 8 perguntas cujas respostas já existem no código (limite_criativos, aprovação manual, sem NF nesta fase, cancelamento por contato, arrependimento de 7…

**Zero prova social: nenhum depoimento, nenhum cliente citado, nenhuma foto de ponto real** *(falta pra parecer sério)*
  · onde: public/index.html (seção 'Por que funciona', linhas 131-160) e public/pontos.html (grade #pontosGrid)
  · evidência: `grep -rniE "depoiment|quem já anuncia|cases?" public/*.html` retorna VAZIO. pontos.html tem UMA foto e ela é genérica (/img/exemplo-ponto-completo.jpg, linha 41). A coluna pontos.foto_instalacao_url existe, é preenchida por POST /admin/pontos/:id/foto (src/pontos/routes.js:126) e só é exibida no admin…
  · conserto: Incluir p.foto_instalacao_url no SELECT de listarPublicos (src/pontos/repository.js:76) e renderizar a foto em cada .ponto-card de public/pontos.page.js; abrir um bloco de depoimentos em public/index.html assim que houver os três primeiros…

**O 'Como funciona' em 3 passos da home omite a aprovação da conta e o tempo até o ar** *(falta pra parecer sério)*
  · onde: public/index.html:113-130 (seção 'Como funciona')
  · evidência: index.html:118 diz 'Crie sua conta e escolha seu plano' e o passo seguinte já é 'Suba seu criativo'. Mas src/anunciantes/routes.js:107 cria a conta com `status: convite ? 'aprovado' : 'pendente_aprovacao'`, e PATCH /admin/anunciantes/:id (a aprovação) não dispara e-mail nenhum — src/anunciantes/routes.js não importa…
  · conserto: Reescrever os 3 passos de public/index.html:113-130 para 4 ('crie a conta → a gente confere e libera em até X dias úteis → suba o criativo, aprovamos em até Y horas → acompanhe'), com os prazos que o dono se compromete a cumprir.

**O número de alcance da rede é autodeclarado e apresentado como fato** *(falta pra parecer sério)*
  · onde: public/index.page.js:7, public/planos.page.js:130, public/pontos.page.js:17
  · evidência: index.page.js:7 escreve '<b>N pessoas</b> veem sua marca por mês nos pontos da Mostraí.' (19/09/2026: era '...nos pontos já instalados...', o dono pediu pra tirar a menção a instalado ou não — o texto ficou mais genérico, não mais preciso). A fonte é somaFluxoMensal (src/pontos/repository.js:103): SUM(fluxo_estimado_mensal) dos pontos ativos — continua contando só `status = 'em_operacao'`, mas o texto não diz isso. Esse campo é preenchido pelo próprio comerciante num input opcional — public/seja-um-ponto.html:105 'Média de…
  · conserto: Acrescentar a legenda 'estimativa informada pelos próprios estabelecimentos parceiros' abaixo do número em public/index.page.js:7, public/planos.page.js:130 e public/pontos.page.js:17.

**Não há CNPJ e nenhuma página de venda identifica o fornecedor nem dá endereço** *(falta pra parecer sério)*
  · onde: public/contato.html:78-81 ('Outros canais') e rodapé de public/layout.js:96-99
  · evidência: O fornecedor real (Bruno Henrique Sanches, CPF 552.085.198-01, PJ em constituição) só aparece em public/termos-de-uso.html:33, comodato.html:32, contrato-anunciante.html:32 e politica-de-privacidade.html:32 — as quatro páginas que só existem no rodapé (MENU_PUBLICO em public/layout.js:38-46 não as inclui).…
  · conserto: Acrescentar ao rodapé de public/layout.js (bloco footer.site) uma linha com razão social/nome, CPF ou CNPJ e endereço completo, e repetir o bloco no card 'Outros canais' de public/contato.html:78.

**Que não há emissão de nota fiscal está escondido no contrato do rodapé** *(falta pra parecer sério)*
  · onde: public/contrato-anunciante.html:33 (deveria estar em public/planos.html)
  · evidência: contrato-anunciante.html:33: 'A partir desse momento, cobranças e emissão de nota fiscal (NFS-e) passam a ocorrer pelo CNPJ; até lá, não há emissão de nota fiscal para os valores cobrados.' planos.html e index.html não mencionam nota fiscal em nenhum lugar, e o painel do anunciante tem coluna 'Nota fiscal'…
  · conserto: Acrescentar à FAQ de public/planos.html a linha 'Nesta fase de lançamento ainda não emitimos nota fiscal — assim que o CNPJ sair, a NFS-e passa a ser emitida em cada cobrança', com link para /contrato-anunciante.html.

**A página de vendedor pede a candidatura sem dizer o percentual da comissão** *(falta pra parecer sério)*
  · onde: public/seja-um-vendedor.html (bloco .razoes, card 'Comissão no Pix')
  · evidência: `grep -n "%" public/seja-um-vendedor.html` só acha percent-encoding de URL — o número não está na página. O valor real (12 por padrão, vendedores.comissao_percentual DEFAULT 12 em src/db/migrations/019_v2_contas_dispositivos_convites_planos.sql:25) só é mostrado depois do login, em…
  · conserto: Imprimir o percentual e a periodicidade de pagamento no card 'Comissão no Pix' de public/seja-um-vendedor.html, lendo de uma rota pública ou, no mínimo, com o texto fixo 'a partir de 12% de cada cobrança confirmada, pago no Pix até o dia X…

**Os valores do comodato estão escritos à mão no HTML, e o formulário que deveria exibi-los não exibe nada** *(falta pra parecer sério)*
  · onde: public/index.html:97, public/comodato.html:41-42, public/seja-um-ponto.html (formulário)
  · evidência: index.html:97 escreve '<b>R$ 50 por mês de ajuda de custo</b> ou o triplo de espaço'; comodato.html:41 escreve 'atualmente R$ 50,00'. A fonte real é a tabela planos_ponto (migration 015), editável por PATCH /admin/planos-ponto/:id e exposta em GET /planos-ponto. `grep -n "planos-ponto|plano_ponto"…
  · conserto: Fazer public/seja-um-ponto.page.js chamar GET /planos-ponto e renderizar as modalidades com ajuda_custo_mensal e cota_slots_hora reais, e trocar os números fixos de public/index.html:97 por texto sem valor ou pelo mesmo fetch.

**'Zero custo, zero trabalho' contradiz a obrigação de internet do próprio contrato de comodato** *(falta pra parecer sério)*
  · onde: public/seja-um-ponto.html:36-37 vs public/comodato.html:49 e :52
  · evidência: seja-um-ponto.html:37: 'Tela, suporte e instalação são nossos. Você só cede a parede e a tomada.' comodato.html:52: 'Garantir acesso à energia elétrica e a uma rede de internet no local de instalação (Wi-Fi ou cabo), cujo custo de conexão em si é do estabelecimento'; e :49 obriga a manter o equipamento ligado e…
  · conserto: Trocar 'você só cede a parede e a tomada' por 'você cede a parede, a tomada e o Wi-Fi do local' em public/seja-um-ponto.html:37 e linkar /comodato.html no bloco de aceite do formulário.

**Nada expira a cobertura: quem parou de pagar continua 'ativo' em toda tela e dentro da receita** *(estado invisível)*
  · onde: busca por `data_expiracao` em src/ (só leituras) e package.json (scripts: dev, start, test, migrate, backup, conciliar, sintaxe, lint, formato, check)
  · evidência: Nenhum job, cron ou rota muda `anunciantes.status` quando `data_expiracao` passa. O único filtro por vencimento é `AND (a.data_expiracao IS NULL OR a.data_expiracao >= now())` em src/playlist/gerador.js:45 — o anúncio some da TV, mas a conta segue `status='ativo'` na aba Anunciantes, na receita do resumo e no gráfico…
  · conserto: Criar um job diário (mesmo padrão de scripts/conciliar.js) que ponha em `suspenso` quem tem `status='ativo' AND data_expiracao < now()`, ou ao menos um chip 'Cobertura vencida' em renderAnunciantes cruzando data_expiracao com now().

**Aba 'Meus anúncios' do admin está sempre vazia: pede a fila de pendentes para listar peças que nascem aprovadas** *(estado invisível)*
  · onde: public/admin/index.page.js:460 contra src/admin/routes.js:16
  · evidência: `const criativos = await pegar('/admin/criativos')` — sem query string. O servidor faz `criativosRepo.listarPorStatus(req.query.status || 'pendente')`. Criativo subido pelo admin nasce `status: 'aprovado'` (src/anunciantes/routes.js:285, bloco `peloOperador`). Logo `meus` é sempre `[]`, a tabela exibe 'Nenhum anúncio…
  · conserto: Em public/admin/index.page.js:460, buscar os três estados (ex.: `Promise.all(['aprovado','pendente','reprovado'].map(s => pegar('/admin/criativos?status='+s)))`) e concatenar antes de filtrar por `anunciante_id`.

**Link do comprovante de veiculação nasce com id nulo e devolve 403 no primeiro clique** *(estado invisível)*
  · onde: public/anunciante/painel.page.js:165-173 e src/anunciantes/routes.js:380-383
  · evidência: A IIFE `comprovante()` roda no parse do script e chama `atualizar()` imediatamente; `ANUNCIANTE_ID` só é preenchido dentro de `carregar()` (painel.page.js:38), que é assíncrona. O href sai como `/anunciantes/null/exibicoes.csv?dias=30`. Na rota, `Number(req.params.id)` de 'null' é NaN, nunca igual a…
  · conserto: Mover a montagem do href para dentro de `carregarExibicoes()` em public/anunciante/painel.page.js, ou expor `atualizar()` e chamá-la ao fim de `carregar()`.

**Consentimento de comunicações volta marcado depois de revogar — o titular vê o oposto do banco** *(estado invisível)*
  · onde: public/perfil.js:214 e src/anunciantes/repository.js:20-28
  · evidência: perfil.js:214 faz `chk.checked = !conta.comunicacoes_revogado_em`, mas `comunicacoes_revogado_em` NÃO está na constante CAMPOS_PUBLICOS do repository (a lista vai de `id` a `anuncio_bonus_resgatado_em` e não inclui nem essa coluna nem `dados_opcionais_apagados_em`, ambas da migration 025). Logo `GET /anunciantes/me`…
  · conserto: Acrescentar `comunicacoes_revogado_em, dados_opcionais_apagados_em` a CAMPOS_PUBLICOS em src/anunciantes/repository.js:20-28.

**Vitrine de planos não tem estado vazio nem carregando — a aba 'Mensal' é garantidamente branca** *(estado invisível)*
  · onde: public/planos.page.js:66-96 e 136-140
  · evidência: `render(meses)` faz `grid.innerHTML = doMes.map(...).join('')`; com `doMes` vazio isso é string vazia e a seção fica em branco, sem uma linha de texto. Os planos de 1 mês nascem `ativo=false` no seed da migration 005, então `GET /planos` não os devolve e clicar em 'Mensal' produz uma tela vazia com a nota 'Sem…
  · conserto: Em public/planos.page.js:68, quando `doMes.length === 0`, escrever o estado vazio de docs/funcional.md §4 ('os planos estão sendo atualizados, fale com a gente') em vez de string vazia.

**Conta com papel 'vendedor' sem perfil em `vendedores` quebra o painel inteiro, sem estado de 'sem permissão'** *(estado invisível)*
  · onde: src/anunciantes/repository.js:12 ('papeis' em CAMPOS_ATUALIZAVEIS), public/modos.js:186 e public/anunciante/vendedor.page.js (bloco final)
  · evidência: `papeis` está em CAMPOS_ATUALIZAVEIS, então `PATCH /admin/anunciantes/:id` acrescenta 'vendedor' sem passar por `liberarPapelNaConta` e sem criar a linha em `vendedores`. Aí `GET /conta/modos` diz `vendedor.liberado: true`, montarModo chama `carregarVendas`, `GET /vendedor/painel` devolve 403 'esta conta não é de…
  · conserto: Em public/anunciante/vendedor.page.js, tratar o 403 de `GET /vendedor/painel` como estado próprio ('seu cadastro de vendedor ainda não foi criado — fale com a gente'), em vez de `throw new Error()` genérico.

**Assinatura ativa não tem tela nenhuma, e o único cancelamento documentado não tem botão** *(estado invisível)*
  · onde: NAV em public/admin/index.page.js:130-160; rota em src/financeiro/routes.js:294
  · evidência: `grep -rn 'admin/assinaturas' src/ public/` devolve NONE — não existe rota nem aba. O grupo Financeiro do NAV tem Cobranças, Comissões, Devoluções, Custos fixos e Eventos pendentes, e nada mais. Ninguém consegue listar quem tem cobrança recorrente viva na Asaas, nem ver assinaturas `status='ativa'` que nunca foram…
  · conserto: Criar uma aba 'Assinaturas' no grupo Financeiro do admin, com listagem de `assinaturas` ativas e o botão que chama a rota já existente POST /admin/anunciantes/:id/cancelar-assinatura.

**Cadastro público e login descartam todo erro do servidor, inclusive o 429 — o cliente é mandado para o caminho errado** *(estado invisível)*
  · onde: public/anunciante/cadastro.page.js:26 e public/anunciante/login.page.js:16-19
  · evidência: No cadastro: `if (!r.ok) throw new Error();` — sem ler o corpo. O servidor devolve `{erro, campo}` para cpf_cnpj, responsavel_cpf, cep, contato_telefone, senha e campos faltando (src/anunciantes/routes.js:82-94), e 429 com Retry-After pelo limiteTentativas; tudo vira 'Não foi possível criar a conta agora. Tente…
  · conserto: Em cadastro.page.js:26 e login.page.js:16, ler `await r.json().catch(()=>({}))` e exibir `corpo.erro`, destacando `corpo.campo` quando vier.

**Tela em 'reparo' ou 'inativo' continua recebendo playlist e confirmando exibição cobrada — e o alerta de offline não a pega** *(estado invisível)*
  · onde: src/lib/aparelho.js:12-21 e src/admin/routes.js:100-105
  · evidência: `exigirAparelho` carrega `buscarComPonto` (que traz `status` e `ponto_status`) e confere apenas `aparelho_id` — não olha nenhum dos dois status. Logo uma tela marcada 'inativo' ou de um ponto 'inativo' continua servindo `GET /playlist/:dispositivoId`, gravando `vezes_programadas` e incrementando `vezes_confirmadas`. E…
  · conserto: Em src/lib/aparelho.js:16, recusar com 403 quando `dispositivo.status !== 'ativo'` ou `dispositivo.ponto_status !== 'ativo'`, com mensagem própria para a TV.

**Criativo reprovado não tem motivo, não gera aviso e não tem como ser corrigido** *(estado invisível)*
  · onde: src/db/migrations/003_criativos.sql, src/anunciantes/criativos-repository.js:5 e src/financeiro/email.js
  · evidência: A tabela `criativos` não tem coluna de motivo (colunas: id, anunciante_id, arquivo_original_url, arquivo_normalizado_url, thumbnail_url, editado_pelo_operador, status, duracao_segundos, created_at). `CAMPOS_ATUALIZAVEIS = ['status','arquivo_normalizado_url','thumbnail_url','editado_pelo_operador']` — não há onde…
  · conserto: Acrescentar `motivo_reprovacao text` a `criativos` numa migration nova, incluir o campo em CAMPOS_ATUALIZAVEIS de src/anunciantes/criativos-repository.js:5 e exibi-lo no card em public/anunciante/painel.page.js.

**Conta excluída com assinatura viva continua sendo creditada e gerando comissão** *(estado invisível)*
  · onde: src/anunciantes/routes.js:180 (soft-delete), src/financeiro/san-checkout.js:222-261 e src/financeiro/conciliacao.js:25
  · evidência: `POST /anunciantes/me/excluir` só grava `excluido_em` e destrói a sessão — não cancela nada no San Checkout nem toca em `assinaturas`. `processarWebhookAssinatura` não tem nenhuma guarda de `excluido_em`: segue creditando ciclo, gravando `cobrancas_confirmadas` e chamando `registrarComissaoSeHouver`. Já…
  · conserto: Em src/anunciantes/routes.js:180, chamar `cancelarAssinatura` para a assinatura ativa antes de gravar `excluido_em`, e acrescentar `AND a.excluido_em IS NULL` como guarda em processarWebhookAssinatura.

**Vendedor nunca vê o percentual da comissão antes de aceitar, e o painel não mostra "quem você indicou"** *(informação faltando)*
  · onde: public/seja-um-vendedor.html × src/financeiro/routes.js:371 (GET /vendedor/painel) × public/anunciante/vendedor.html:38 × public/anunciante/cadastro.html
  · evidência: grep por 'comiss|percent|12%' em seja-um-vendedor.html: nenhuma ocorrência de número — o percentual (default 12 em vendedores.comissao_percentual) só aparece depois de aprovado e logado. O card promete "Painel que mostra tudo — Quem você indicou, o que já virou comissão e quanto tem a receber", mas GET…
  · conserto: Publicar o percentual em public/seja-um-vendedor.html, acrescentar a lista de indicados (query por indicado_por_cupom) em GET /vendedor/painel, e corrigir o texto de public/anunciante/vendedor.html:38 ou criar o campo de cupom no cadastro.

**"Zero custo, zero trabalho — só a parede e a tomada" contradiz as obrigações do comodato** *(informação faltando)*
  · onde: public/seja-um-ponto.html (razão "Zero custo, zero trabalho") × public/comodato.html §4.1 e §4.4
  · evidência: seja-um-ponto.html: "Tela, suporte e instalação são nossos. Você só cede a parede e a tomada." comodato.html §4.4: "Garantir acesso à energia elétrica e a uma rede de internet no local de instalação (Wi-Fi ou cabo), cujo custo de conexão em si é do estabelecimento — a Mostraí não cobra pelo uso do equipamento, mas não…
  · conserto: Acrescentar internet e o compromisso de manter ligada às razões de public/seja-um-ponto.html, com link para /comodato.html.

**Limite de criativos do plano nunca é dito: o campo chega ao navegador e não é impresso** *(informação faltando)*
  · onde: public/planos.page.js (render e renderFundador) × src/financeiro/planos-repository.js (SELECT p.*) × src/anunciantes/routes.js:265
  · evidência: GET /planos devolve `p.*`, que inclui limite_criativos (CHECK BETWEEN 1 AND 3, migrations 014/015). Nem render() nem renderFundador() em planos.page.js imprimem o campo, e grep por 'criativo' nas páginas de venda não retorna nada. O cliente só descobre o teto quando o upload é recusado com "seu plano permite até N…
  · conserto: Imprimir limite_criativos como um <li> no card de plano em public/planos.page.js e mostrar "X de N criativos" no painel.

**Preço travado só é anunciado no card fundador, e a imutabilidade do plano (RN-27) não é dita em lugar nenhum** *(informação faltando)*
  · onde: public/planos.page.js (render vs renderFundador) × src/db/migrations/026_planos_versionados.sql × public/termos-de-uso.html §4.1
  · evidência: renderFundador imprime `${p.preco_travado ? '<b>Preço travado por N meses</b>' : ''}`; a função render() dos cards normais NÃO tem essa linha, embora preco_travado seja coluna dos mesmos planos. E a garantia mais forte do produto — campos de contrato viram versão nova (POST /admin/planos/:id/nova-versao, migration…
  · conserto: Imprimir preco_travado também em render() de public/planos.page.js e acrescentar uma cláusula em public/termos-de-uso.html §4 dizendo que mudanças de plano não alcançam quem já assinou.

**Anúncio simples incluído no plano e gravação por produtora: a resposta à objeção nº 1 só aparece depois de pagar** *(informação faltando)*
  · onde: public/anunciante/painel.html (.ajuda-arte) e painel.page.js (montarPortasDeArte) × public/index.html, public/planos.html
  · evidência: O painel monta dois links de WhatsApp (#linkArteSimples "quero pedir o anúncio simples que vem no meu plano" e #linkGravacao) — ou seja, o produto resolve quem não tem arte. Nas páginas públicas nada disso existe: index.html passo 2 é "Suba seu criativo", pressupondo peça pronta, e planos.html não lista o benefício…
  · conserto: Acrescentar "anúncio simples incluído" como benefício de plano (tabela beneficios) e um passo/linha em public/index.html para quem não tem vídeo.

**Comprovante de veiculação em CSV (RN-19) não é vendido em nenhuma página** *(informação faltando)*
  · onde: src/anunciantes/routes.js:380 (GET /anunciantes/:id/exibicoes.csv) × public/index.html, public/planos.html, public/termos-de-uso.html §8
  · evidência: A rota gera proof-of-play por dia/ponto/tela, com ';' e BOM para Excel pt-BR, 1 a 365 dias. Nas páginas públicas a única ocorrência da ideia é termos-de-uso.html §8 — "a plataforma fornece a exibição e a comprovação de exibição (proof of play), não uma garantia de retorno" — dentro da cláusula que LIMITA…
  · conserto: Citar o comprovante em CSV como entrega concreta em public/index.html e como benefício nos cards de public/planos.html.

**"Sem borda preta e sem corte" é falso para qualquer mídia vertical fora de 9:16** *(informação faltando)*
  · onde: public/pontos.html (razão "Tela vertical, imagem limpa") × src/lib/ffmpeg.js:55-58
  · evidência: ffmpeg.js: `const jaVertical = height >= width;` e o ramo vertical é `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2` — pad SEM parâmetro de cor, ou seja, preto. Só o ramo horizontal usa fundo desfocado (boxblur=20:5). Logo uma peça 1080x1350 (4:5) ou 1:1 — formatos comuns de…
  · conserto: Aplicar o mesmo filtro de fundo desfocado ao ramo vertical em src/lib/ffmpeg.js:56, ou corrigir a frase em public/pontos.html.

**"15 a 30 segundos" e o teto de 200 MB: um não é validado, o outro não é dito** *(informação faltando)*
  · onde: public/index.html (passo 2) × src/anunciantes/routes.js:25-32 e src/lib/ffmpeg.js
  · evidência: O multer aceita qualquer image/* ou video/* com `limits: { fileSize: 200 * 1024 * 1024 }` e o fileFilter só olha o mimetype. Não existe nenhuma checagem de duração em subirCriativo nem em ffmpeg.normalizar (probeMidia só LÊ duration para gravar duracao_segundos). Um vídeo de 3 minutos entra e passa a ocupar slots…
  · conserto: Validar a duração em src/anunciantes/routes.js (subirCriativo) com o retorno de probeMidia, e escrever o limite de tamanho e a duração fixa de imagem em public/index.html.

**Ausência de nota fiscal só é revelada num parágrafo do contrato do rodapé** *(informação faltando)*
  · onde: public/contrato-anunciante.html §1 × public/planos.html, public/index.html × public/layout.js (MENU_PUBLICO)
  · evidência: contrato-anunciante.html §1: "...cobranças e emissão de nota fiscal (NFS-e) passam a ocorrer pelo CNPJ; até lá, não há emissão de nota fiscal para os valores cobrados." grep por 'nota fiscal' em index.html, planos.html, pontos.html, seja-um-ponto.html, seja-um-vendedor.html e contato.html: zero ocorrências. E…
  · conserto: Dizer em public/planos.html, junto ao preço, que nesta fase não há emissão de NFS-e, com link para /contrato-anunciante.html.

**`<div class="card">` não tem estilo nenhum — a tela de "Recebido!" de Seja um ponto e Seja um vendedor sai sem card** *(quebra visual)*
  · onde: public/style.css:201 (`form.card { ... }`), :206 (`form.card.wide`), :547 (`.card[hidden]`), :550 (`div.card.modo-card`). Markup: public/seja-um-ponto.html:140, public/seja-um-vendedor.html:96, public/convite.html:29 e…
  · evidência: Grep `\.card` em style.css devolve SOMENTE seletores com o qualificador de elemento: `form.card{background;border;border-radius;padding:28px;max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:14px}` e `form.card.wide{max-width:640px}`. Não existe nenhuma regra `.card {}` genérica — só…
  · conserto: Em /home/user/MostrAi/public/style.css, generalizar a linha 201 para `.card` (e `.card.wide`), mantendo `display:flex` só para `form.card` — ou acrescentar `div.card { background: var(--card); border: 1px solid var(--border);…

**Cabeçalho público estoura a tela entre 641px e ~920px (tablet e janela de laptop)** *(quebra visual)*
  · onde: public/style.css:67 (`nav.main { display: flex; gap: 24px; align-items: center; }` — sem `flex-wrap`), :68 (`nav.main a { ... white-space: nowrap; }`) e :78 (`@media (max-width: 640px)`, a ÚNICA media query do…
  · evidência: `navPublico()` injeta 8 itens: Home, Planos, Onde estamos?, Anuncie, Seja um ponto, Seja um vendedor, Contato e o botão `.btn ghost` Entrar. A .95rem, o texto soma ~500px; mais 7 gaps de 24px (168px) e o botão Entrar (~86px com o padding 11px/20px do `.btn`), o `<nav>` precisa de ~755px. O logo…
  · conserto: Em /home/user/MostrAi/public/style.css, subir a media query do cabeçalho da linha 78 de `max-width: 640px` para `max-width: 960px` (e acrescentar `flex-shrink: 0` em `.logo`), para que `nav.main` já quebre em linha antes de faltar espaço.

**O criativo 9:16 é cortado em cima e embaixo por `object-fit: cover` — no painel do anunciante e na fila de aprovação do admin** *(quebra visual)*
  · onde: public/style.css:296 (`.criativo-card img, .criativo-card video { width: 100%; aspect-ratio: 9/16; object-fit: cover; }`) combinada com :392 (`.criativos-lista .criativo-card img, .criativos-lista .criativo-card video {…
  · evidência: `aspect-ratio` só transfere para a dimensão `auto`. Com `width:100%` definido, a altura sai da razão e depois é CORTADA pelo `max-height` — a largura não é recalculada, então a caixa deixa de ser 9:16 e o `object-fit: cover` crops o vídeo verticalmente. Painel do anunciante: a lista fica na coluna de 1fr do…
  · conserto: Trocar `object-fit: cover` por `contain` nas duas regras, ou (melhor) deixar a largura derivar da altura: em style.css:392 e admin/index.css:66 usar `height: 420px/300px; width: auto; max-width: 100%; margin: 0 auto;` e remover o…

**RESOLVIDO em sessão anterior, confirmado em 22/09/2026 (reforma da taxonomia de categorias, docs/PENDENCIAS.md seção K) — Endereço novo cadastrado pelo próprio dono de ponto nasce sem categoria_id — a tela dele fica sem bloqueio de concorrente** *(papéis cruzados)*
  · onde: src/pontos/routes.js (POST /anunciantes/me/pontos) e public/anunciante/ponto.page.js:396 (submit de #formEndereco)
  · evidência original: public/anunciante/ponto.html:76 oferece `<select id="categoria_id" data-categorias>` mas o submit em ponto.page.js monta o corpo com apenas `{nome, endereco, cidade, uf, cep, segmento}` — `segmento` recebe só o TEXTO (`opcao.dataset.nome`) e `categoria_id` nunca é enviado. Do lado do servidor, o handler desestrutura…
  · conserto aplicado: ponto.page.js:396 já envia `categoria_id: usouLivre ? null : formEnd.categoria_id.value || null` — corrigido em sessão anterior, sem atualizar este arquivo. Não foi tocado nesta rodada.

**Anunciante que também é dono de ponto paga cobertura total e nunca roda (nem conta) na própria tela** *(papéis cruzados)*
  · onde: src/playlist/gerador.js (anunciantesElegiveis + gerarPlaylistDaHora + criativosDoDono) e public/anunciante/painel.page.js (Exibições por ponto)
  · evidência: gerarPlaylistDaHora chama `anunciantesElegiveis(dispositivo.categoria_id, dispositivo.dono_conta_id)`, e a query termina com `AND ($2::int IS NULL OR a.id <> $2)`: a conta dona do ponto é removida da lista de pagantes daquela tela. Em paralelo, `criativosDoDono(dispositivo.dono_conta_id)` busca os MESMOS criativos…
  · conserto: Ou deixar o pagante concorrer também na própria tela (restringindo `excluirContaId` apenas aos slots de autoanúncio) em /home/user/MostrAi/src/playlist/gerador.js, ou exibir no painel uma linha fixa 'sua própria tela não entra na cobertura…

**Papel 'vendedor' ligado pelo admin sem perfil derruba o painel inteiro com erro genérico** *(papéis cruzados)*
  · onde: src/anunciantes/repository.js (CAMPOS_ATUALIZAVEIS inclui 'papeis'), src/financeiro/routes.js (exigirVendedorLogado) e public/modos.js (montarModo)
  · evidência: `CAMPOS_ATUALIZAVEIS` em src/anunciantes/repository.js lista 'papeis', e PATCH /admin/anunciantes/:id (src/anunciantes/routes.js) chama `repo.atualizar(req.params.id, req.body)` direto — nada cria a linha em `vendedores`, ao contrário de `liberarPapelNaConta` (src/conta/modos.js), que sempre chama…
  · conserto: Fazer GET /conta/modos em /home/user/MostrAi/src/conta/modos.js marcar `vendedor.liberado` só quando existir linha em `vendedores` (ou criar o perfil no PATCH do admin), e envolver `await aoLiberado(estado)` em try/catch dentro de…

**Dono de ponto que escolheu 'mais cota de autoanúncio' não tem nenhuma tela para subir o próprio vídeo** *(papéis cruzados)*
  · onde: public/anunciante/painel.html:27-97 (#arquivoCriativo dentro de #dashboardAnuncios), public/modos.js (montarModo esconde o container) e src/playlist/gerador.js (criativosDoDono)
  · evidência: `grep -n 'id="dashboardAnuncios"|arquivoCriativo' public/anunciante/painel.html` mostra #dashboardAnuncios abrindo na linha 27 e o `<input type="file" id="arquivoCriativo">` na linha 74, dentro dele; a seção fecha na 97. Em public/modos.js, quando `estado.modos[modo].liberado` é falso, o código faz `container.hidden =…
  · conserto: Acrescentar um bloco de upload de criativo em /home/user/MostrAi/public/anunciante/ponto.html apontando para POST /anunciantes/:id/criativos (a rota já aceita conta sem plano, com teto 1) e liberá-lo quando o ponto tiver…

**Com zero pontos a página 'Onde estamos' anuncia '1 Cidade atendida'** *(primeira vez)*
  · onde: public/pontos.page.js:11
  · evidência: `<div class="stat"><b>${cidades || 1}</b><span>${cidades > 1 ? 'Cidades atendidas' : 'Cidade atendida'}</span></div>` — `cidades` é `new Set(pontos.map(p => p.cidade)).size`, que é 0 quando GET /pontos devolve []; o `|| 1` transforma zero em um. O resultado no dia um é a linha '0 Pontos ativos · 0 Em instalação · 1…
  · conserto: Em public/pontos.page.js:11, trocar `cidades || 1` por `cidades` e esconder o #statRow inteiro quando `!pontos.length`, deixando só o empty-state.

**A vitrine vende '100% dos pontos da rede' quando a rede tem zero pontos** *(primeira vez)*
  · onde: public/planos.html:44 (lead) e :9 (meta description) · src/db/migrations/014_planos_promo_e_limite_criativos.sql:20 (benefício 'Alcança 100% dos pontos ativos') · public/pontos.html:29
  · evidência: planos.html:44: 'Todo plano coloca a sua marca em 100% dos pontos da rede'. O benefício semeado pela 014 e renderizado como <li> em planos.page.js:89 diz 'Alcança 100% dos pontos ativos'. pontos.html:29: 'Quando você anuncia na Mostraí, sua marca aparece em todos eles'. Nenhuma dessas três frases consulta `GET…
  · conserto: Em public/planos.page.js, ler `GET /pontos` junto com `GET /planos` e, com zero pontos ativos, trocar a lead e desabilitar os botões 'Assinar' por um aviso único ('a rede está em instalação — deixe seu contato'), em vez de vender cobertura…

**O primeiro dono de ponto abre 'Meu ponto' e lê 'Não foi possível carregar sua conta agora'** *(primeira vez)*
  · onde: public/anunciante/ponto.page.js:13 e :140
  · evidência: Linha 13: `await Promise.all([carregarTelas(), carregarPontos(), carregarExtrato()]);`. `carregarExtrato` não é definida em lugar nenhum do repositório — grep em public/ e src/ só encontra `extratoDaConta` em src/pontos/pagamentos-repository.js:10 e a rota GET /anunciantes/me/pontos/extrato em src/pontos/routes.js:77.…
  · conserto: Escrever `carregarExtrato()` em public/anunciante/ponto.page.js consumindo GET /anunciantes/me/pontos/extrato e acrescentar o contêiner em public/anunciante/ponto.html — ou, como correção mínima imediata, remover a chamada da linha 13.

**A primeira coisa que o dono faz no admin — pôr o anúncio da própria rede nas telas vazias — some da tela** *(primeira vez)*
  · onde: public/admin/index.page.js:458 · src/admin/routes.js:16 · src/anunciantes/routes.js:285
  · evidência: renderMeusAnuncios faz `const criativos = await pegar(`/admin/criativos`)` (index.page.js:458), sem query string. A rota é `res.json(await criativosRepo.listarPorStatus(req.query.status || 'pendente'))` (src/admin/routes.js:16) — devolve só os pendentes. Mas o upload do operador nasce aprovado: em subirCriativo,…
  · conserto: Trocar a linha 458 de public/admin/index.page.js por `pegar('/admin/criativos?status=aprovado')` somado a `?status=pendente` e `?status=reprovado`, ou criar um endpoint por anunciante que devolva todos os status.

**O link 'Baixar comprovante' nasce com o id da conta nulo e devolve 403** *(primeira vez)*
  · onde: public/anunciante/painel.page.js:164-172 · src/anunciantes/routes.js:380-382
  · evidência: A IIFE `comprovante()` roda no parse do script e chama `atualizar()` uma vez (linha 172), quando `ANUNCIANTE_ID` ainda é `null` — ele só é preenchido dentro de `carregar()` (linha 37), que é assíncrona. O href fica `${API_BASE_URL}/anunciantes/null/exibicoes.csv?dias=30` e só é reescrito no evento 'change' do…
  · conserto: Em public/anunciante/painel.page.js, chamar `atualizar()` também ao fim de `carregarExibicoes()` (ou montar o href lá dentro) em vez de só no parse e no 'change'.

**Lançamento de pagamento ao ponto: três rotas de admin construídas e sem nenhuma tela que as chame** *(rota órfã)*
  · onde: src/pontos/routes.js:171, :175 e :186 (GET/POST /admin/pontos/:pontoId/pagamentos, PATCH /admin/pagamentos-ponto/:id)
  · evidência: As três rotas existem em src/pontos/routes.js (:171 lista, :175 lança com ON CONFLICT (ponto_id, competencia) DO UPDATE, :186 quita e emite o evento `ponto:pagamento_quita`), apoiadas pela migration 022 e por src/pontos/pagamentos-repository.js. `grep -rn "pagamentos" public/admin/index.page.js` só encontra…
  · conserto: Acrescentar em public/admin/index.page.js uma aba (ou um bloco expansível por linha na aba Pontos) que chame GET/POST /admin/pontos/:pontoId/pagamentos e PATCH /admin/pagamentos-ponto/:id.

**Aba 'Meus anúncios' do admin pede a fila de pendentes e a conta própria só tem aprovados — tabela sempre vazia** *(rota órfã)*
  · onde: public/admin/index.page.js:458 → src/admin/routes.js:15
  · evidência: public/admin/index.page.js:458 faz `const criativos = await pegar(`/admin/criativos`)` — sem query string. O servidor (src/admin/routes.js:16) faz `criativosRepo.listarPorStatus(req.query.status || 'pendente')`. Mas todo criativo subido pelo admin nasce aprovado: `subirCriativo` em src/anunciantes/routes.js aplica…
  · conserto: Trocar por `pegar('/admin/criativos?status=aprovado')` em public/admin/index.page.js:458 (ou juntar as três listagens de status) para a tabela da conta própria enxergar as peças que estão no ar.

**Link 'Baixar comprovante' nasce apontando para /anunciantes/null/exibicoes.csv e devolve 403 no primeiro clique** *(rota órfã)*
  · onde: public/anunciante/painel.page.js:164-173 → src/anunciantes/routes.js:380
  · evidência: A IIFE `comprovante()` em public/anunciante/painel.page.js:164-173 chama `atualizar()` na hora do parse do script, montando `link.href = `${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/exibicoes.csv?dias=${sel.value}``. `ANUNCIANTE_ID` é `let ANUNCIANTE_ID = null;` (linha 4) e só recebe valor na linha 39, dentro de…
  · conserto: Em public/anunciante/painel.page.js, expor o `atualizar()` da IIFE e chamá-lo ao fim de `carregar()` (ou montar o href dentro de `carregarExibicoes()`), depois de `ANUNCIANTE_ID` estar preenchido.


---

## Media

**Plano de cortesia não é identificado em nenhuma tela do cliente, embora o dado chegue ao navegador** *(beco sem saída)*
  · onde: public/anunciante/painel.page.js:63-76 + src/anunciantes/repository.js (CAMPOS_PUBLICOS) + src/financeiro/routes.js:261-292
  · evidência: POST /admin/anunciantes/:id/liberar-plano grava `plano_cortesia: true` e `cortesia_motivo`, com `data_expiracao = agora + meses*30 dias` e sem nenhuma linha em cobrancas_confirmadas. `plano_cortesia` e `cortesia_motivo` ESTÃO em CAMPOS_PUBLICOS (src/anunciantes/repository.js:18-27), portanto chegam em GET…
  · conserto: Em `preencherStatusBanner` de /home/user/MostrAi/public/anunciante/painel.page.js, quando `ANUNCIANTE.plano_cortesia` for verdadeiro, rotular 'Cortesia até DD/MM' em vez de 'Plano ativo até DD/MM'.

**'Seja um ponto' não linka nem coleta o comodato que o próprio contrato diz estar naquele formulário** *(beco sem saída)*
  · onde: public/seja-um-ponto.html:130-148 + public/comodato.html:32, :44, :79
  · evidência: comodato.html:79 afirma: 'Ao marcar "Aceito os termos do comodato" no formulário de cadastro de ponto, o estabelecimento declara ter lido e concordado com este contrato'; :44 diz que 'os valores e a quantidade de espaços de cada modalidade são os exibidos no formulário "Seja um ponto"'; :32 define o comodatário como…
  · conserto: Acrescentar em /home/user/MostrAi/public/seja-um-ponto.html o link para /comodato.html e os radios de modalidade vindos de GET /planos-ponto (o mesmo código já existe em public/modos.js, `carregarOpcoesComodato`), enviando `plano_ponto_id`…

**Com a rede vazia, a vitrine afirma '1 Cidade atendida' sobre 0 pontos** *(falta pra parecer sério)*
  · onde: public/pontos.page.js:11 (#statRow)
  · evidência: public/pontos.page.js:11: `<b>${cidades || 1}</b><span>${cidades > 1 ? 'Cidades atendidas' : 'Cidade atendida'}</span>`. Com a lista vazia, `new Set([]).size` é 0, o `|| 1` transforma em 1, e o statRow é escrito ANTES do `if (!pontos.length) return` da linha 24 — então a página mostra '0 Pontos ativos / 0 Em…
  · conserto: Remover o fallback `|| 1` de public/pontos.page.js:11 e esconder o #statRow inteiro quando pontos.length === 0.

**Canal de suporte sem horário em números e sem telefone visível** *(falta pra parecer sério)*
  · onde: public/contato.html:73 e :78-81 (cards 'Resposta rápida' e 'Outros canais')
  · evidência: contato.html:73 diz apenas 'No WhatsApp a gente responde em horário comercial, geralmente em minutos' — sem dias da semana e sem faixa de horas. O card 'Outros canais' (linhas 78-81) lista só o e-mail e 'Matão — SP'; o número +55 16 99463-5946 existe no site apenas dentro do href do botão e do FAB…
  · conserto: Escrever o número por extenso e o horário real ('seg a sex, 8h às 18h') no card 'Outros canais' de public/contato.html:78.

**O formulário de contato não promete prazo de resposta nenhum** *(falta pra parecer sério)*
  · onde: public/contato.page.js:14 (mensagem de sucesso) e public/contato.html (form #formContato)
  · evidência: contato.page.js:14: 'Mensagem enviada! A gente responde no e-mail informado.' — sem prazo, enquanto o card ao lado (contato.html:73) promete 'geralmente em minutos' para o WhatsApp. Quem escolhe o canal escrito fica sem referência. Somado a isso, POST /contato (src/conta/routes.js:76) só dispara e-mail e não grava…
  · conserto: Acrescentar o prazo na mensagem de sucesso de public/contato.page.js:14 ('respondemos em até 1 dia útil') e repetir ao lado do botão em public/contato.html.

**O que mais protege o cliente (arrependimento de 7 dias, prazo do comodato, direitos LGPD) só existe no rodapé** *(falta pra parecer sério)*
  · onde: public/layout.js:38-46 (MENU_PUBLICO) e :96-99 (footer-links)
  · evidência: MENU_PUBLICO (public/layout.js:38-46) tem 7 itens e nenhum é comodato.html, contrato-anunciante.html, termos-de-uso.html ou politica-de-privacidade.html — elas só aparecem no footer-links de layout.js:98, como nomes soltos sem uma linha dizendo o que cada uma cobre. É nessas páginas que estão o arrependimento de 7…
  · conserto: Promover o arrependimento de 7 dias para um selo em public/planos.html (ao lado da grade) e acrescentar /contato.html ao footer-links de public/layout.js:98.

**O anúncio simples incluído no plano — a resposta para 'eu não tenho vídeo' — não é contado em nenhuma página pública** *(falta pra parecer sério)*
  · onde: public/anunciante/painel.html (bloco .ajuda-arte) — deveria estar em public/index.html passo 2 e nos benefícios de public/planos.html
  · evidência: public/anunciante/painel.page.js:11-25 (montarPortasDeArte) monta duas saídas de WhatsApp: 'anúncio simples que vem no meu plano' e 'orçar a gravação de um vídeo'. Isso só existe atrás do login. index.html:123 (passo 2) pressupõe que o cliente já tem a peça pronta, e planos.page.js só imprime o array `beneficios` do…
  · conserto: Acrescentar no passo 2 de public/index.html:123 e como benefício em public/planos.html a frase 'não tem vídeo? o anúncio simples vem incluído no plano — a gente monta pra você'.

**Ciclo descartado pela dedupe some em silêncio, sem pendência e sem tela** *(estado invisível)*
  · onde: src/financeiro/san-checkout.js:241-246
  · evidência: Depois do `INSERT INTO webhooks_processados ... ON CONFLICT DO NOTHING`, o código faz `if (!rowCount) return;` — sem `registrarPendencia`, sem log. Se a consulta `consultarAssinatura` devolver a `ultimaCobranca` do ciclo ANTERIOR (defasagem entre Asaas e Checkout numa renovação), a chave `chargeId|status` colide com…
  · conserto: Em src/financeiro/san-checkout.js:246, trocar o `return` mudo por `registrarPendencia(payload, 'evento descartado pela dedupe (chave '+chave+' já processada)')` quando o evento for de EVENTOS_QUE_CREDITAM.

**Relato da conciliação só existe no stdout: ninguém sabe se ela rodou nem o que falhou** *(estado invisível)*
  · onde: src/financeiro/conciliacao.js:27-57 e scripts/conciliar.js
  · evidência: `conciliarAssinaturas()` monta `{verificadas, aplicadas, jaProcessadas, semCobranca, falhas[]}` e devolve; o runner só faz `console.log`/`console.error` e `process.exit`. Nada é persistido: não há tabela, rota nem aba que mostre a última execução, quantas assinaturas falharam e quais. Somado ao cron ainda pendente no…
  · conserto: Persistir o relato numa tabela (`conciliacoes`) em src/financeiro/conciliacao.js e mostrar a última execução como KPI na Visão geral do admin.

**Eventos pendentes é beco sem saída: 'Marcar resolvido' não credita nada** *(estado invisível)*
  · onde: src/financeiro/routes.js:319 e public/admin/index.page.js:1655-1684
  · evidência: O PATCH só grava `resolvido = true`; não cria cobrança, não ativa conta, não credita ciclo. A tela mostra ID, motivo, data e o payload cru num `<details>`, sem link para a conta do anunciante envolvido e sem nenhuma ação de 'aplicar este ciclo'. O único caminho manual para pôr no ar quem pagou e caiu aqui é 'Liberar…
  · conserto: Acrescentar em renderEventos (public/admin/index.page.js:1655) um link para a conta do `payload.planoId`/`documento` e um botão que chame uma rota nova de 'aplicar este ciclo' reutilizando `aplicarCicloPago`.

**Custo por exibição ignora o preço travado e a cortesia — contradiz a faixa logo acima na mesma tela** *(estado invisível)*
  · onde: src/anunciantes/routes.js:459
  · evidência: `custoPorExibicao: plano && confirmadas > 0 ? Number(plano.valor_mensal) * plano.compromisso_meses / confirmadas : null` — usa o preço de tabela do plano, enquanto a cobrança real usa `valorMensalDaConta(anunciante, plano)` (src/financeiro/san-checkout.js), que prefere `valor_mensal_travado`. Um fundador com preço…
  · conserto: Em src/anunciantes/routes.js:459, usar `Number(anunciante.valor_mensal_travado || plano.valor_mensal)` e devolver `null` quando `anunciante.plano_cortesia`.

**Criativo aprovado com URL nula entra na playlist e a TV toca vazio** *(estado invisível)*
  · onde: src/playlist/gerador.js:29-44
  · evidência: `anunciantesElegiveis` faz `JOIN criativos c ON c.anunciante_id = a.id AND c.status = 'aprovado'` e `array_agg(c.arquivo_normalizado_url ...)` sem exigir `c.arquivo_normalizado_url IS NOT NULL` — ao contrário de `criativosDoDono`, logo abaixo no mesmo arquivo, que filtra. Uma linha presa em 'processando' (processo…
  · conserto: Acrescentar `AND c.arquivo_normalizado_url IS NOT NULL` ao JOIN de `anunciantesElegiveis` em src/playlist/gerador.js:36.

**pontos.html: os três contadores não têm estado de carregando nem de erro** *(estado invisível)*
  · onde: public/pontos.page.js (bloco .catch final) e public/pontos.html:30
  · evidência: `#statRow` nasce vazio no HTML (`<div class="stat-row u-mt-28" id="statRow"></div>`) e só é preenchido no `.then` de `GET /pontos`. O `.catch` final escreve apenas em `#pontosGrid` ('Não foi possível carregar os pontos agora.') — o statRow fica permanentemente em branco, sem zero, sem traço e sem explicação. O…
  · conserto: No `.catch` de public/pontos.page.js, escrever também em `#statRow` um estado de erro, e preenchê-lo com um esqueleto antes do fetch.

**Soft-delete de 60 dias não está em nenhuma página pública nem na Política de Privacidade** *(informação faltando)*
  · onde: src/anunciantes/routes.js:178-190 × public/perfil.js:195 × public/politica-de-privacidade.html §5 e §6
  · evidência: POST /anunciantes/me/excluir só grava excluido_em; o comentário da rota diz "Recuperação é manual pelo suporte dentro de 60 dias". `grep -rn '60 dias' public/ docs/` só acha public/perfil.js:195 (dentro de um window.confirm), public/admin/index.page.js e os docs. A Política §5 fala em retenção genérica e §6 diz apenas…
  · conserto: Registrar os 60 dias de soft-delete em public/politica-de-privacidade.html §5.

**A conta única com três papéis nunca é explicada: o site vende três cadastros separados** *(informação faltando)*
  · onde: public/index.html (3 CTAs) × src/conta/modos.js (GET /conta/modos, POST /conta/modos/*), public/modos.js
  · evidência: index.html apresenta "Quero anunciar", "Quero ser um ponto" e "Quero ser vendedor" como três produtos, cada um com CTA próprio. O backend tem anunciantes.papeis text[] e rotas para ativar modo na MESMA conta: POST /conta/modos/anunciante, POST /conta/modos/:papel/pedir (src/conta/modos.js:100 e :123), com o estado…
  · conserto: Acrescentar uma linha em public/index.html dizendo que é uma conta só para os três papéis.

**Valores do comodato estão escritos à mão no HTML enquanto a fonte real é editável no admin** *(informação faltando)*
  · onde: public/index.html (card Ponto), public/comodato.html §3 × src/db/migrations/015 (seed planos_ponto) × GET /planos-ponto
  · evidência: index.html: "<b>R$ 50 por mês de ajuda de custo</b> ou o triplo de espaço na tela"; comodato.html §3: "atualmente R$ 50,00". A fonte real é planos_ponto (migration 015 linhas 92-100: 'ajuda-custo' = 50 + 1 slot/h; 'mais-cota' = 0 + 3 slots/h), editável por PATCH /admin/planos-ponto/:id sem deploy. A rota pública GET…
  · conserto: Consumir GET /planos-ponto em public/index.html e public/comodato.html em vez de repetir os números no markup.

**O teto de 200 slots/hora corta a entrega de forma aleatória, sem aviso a ninguém** *(informação faltando)*
  · onde: src/lib/pacing.js:18-26 (calcularPlaylist) × public/index.html ("Rotação garantida, não promessa")
  · evidência: calcularPlaylist monta a lista, chama embaralhar() e só então faz `itens = itens.slice(0, 200)` — o corte é sobre a lista já sorteada, sem proporcionalidade, então com a rede cheia um anunciante pode terminar a hora com muito menos que a frequência contratada. contarPorAnunciante roda sobre a lista já cortada, de modo…
  · conserto: Distribuir o corte proporcionalmente em src/lib/pacing.js e registrar um alerta no admin quando o teto de 200 começar a cortar.

**RESOLVIDO em 15/09/2026 (migration 037) — "≈Nx por hora" da vitrine presumia 12 horas de funcionamento que nunca eram ditas e que o gerador não usava** *(informação faltando)*
  · onde era: public/planos.page.js (const porHora) × src/playlist/gerador.js:75-81 (horasAbertoPorDia)
  · o que mudou: a frequência do plano deixou de ser "por dia" (convertida pro horário de cada ponto) e virou `frequencia_hora`, direta — pedido do dono. `horasAbertoPorDia` foi removida de `src/playlist/gerador.js`; a vitrine agora mostra "N vezes por hora" como valor real, com um "≈Nx por dia" derivado (`× 12`) e claramente rotulado como estimativa. Não há mais número escondido que diverge do que o gerador realmente faz.

**Conta pendente de aprovação: sem gate no código, sem explicação na tela, e a doc diz que o gate existe** *(informação faltando)*
  · onde: src/financeiro/routes.js:178-230 (POST /anunciantes/:id/assinar) × docs/funcional.md §2.1 e linha 347 × public/layout.js:151
  · evidência: A rota de assinar só barra `conta.excluido_em`, `conta.status === 'suspenso'` e endereço incompleto — não há nenhuma checagem de 'pendente_aprovacao'. Ou seja, conta ainda não aprovada vai ao San Checkout e paga. docs/funcional.md §2.1 coloca a aprovação como passo 5, antes de assinar, e a linha 347 tem o texto "Sua…
  · conserto: Decidir e alinhar: ou barrar 'pendente_aprovacao' em src/financeiro/routes.js:198, ou corrigir docs/funcional.md §2.1 — e escrever a faixa explicativa no painel.

**/contato.html é o canal declarado do titular LGPD, não se apresenta como tal e não grava nada** *(informação faltando)*
  · onde: docs/funcional.md:395 × src/conta/routes.js:76-88 (POST /contato) × public/contato.html
  · evidência: docs/funcional.md:395: "Canal do titular — /contato.html, que grava a mensagem e avisa por e-mail." O handler só chama `await email.enviarMensagemContato(req.body)` e responde ok — não há INSERT nenhum. Com SMTP fora do ar devolve 502 e a mensagem do titular se perde sem rastro. Na tela, contato.html não se identifica…
  · conserto: Gravar a mensagem em tabela antes de tentar o envio em src/conta/routes.js:76 e acrescentar o aviso de privacidade com link ao lado do botão em public/contato.html.

**Bônus cruzados (tela grátis após N meses / anúncio grátis após N meses como ponto) quase não são contados** *(informação faltando)*
  · onde: src/conta/modos.js (bonusPontoDaConta, bonusAnuncioDaConta, POST /conta/bonus/*) × public/seja-um-ponto.html, public/comodato.html, public/pontos.html
  · evidência: O módulo inverso existe: planos_ponto.plano_bonus_id / plano_bonus_apos_meses / plano_bonus_meses (migration 020) dão M meses de plano de anúncio grátis a quem é ponto há N meses, resgatáveis por POST /conta/bonus/anuncio/resgatar, e é renderizado só em public/modos.js (cardBonus). Nenhuma menção em…
  · conserto: Citar o bônus "ponto há N meses ganha anúncio grátis" em public/seja-um-ponto.html e o "tela após N meses" em public/index.html.

**PIN da tela: a doc diz que o dono do ponto define; não existe rota nem campo fora do admin** *(informação faltando)*
  · onde: docs/funcional.md:52 e :101 × src/dispositivos/routes.js (POST /admin/dispositivos/:id/pin) × public/anunciante/ponto.html
  · evidência: funcional.md:52 ("O dono do ponto define o PIN da tela") e a linha 101 da tabela de telas ("definir PIN") descrevem uma ação que não existe: a única rota de PIN é POST /admin/dispositivos/:id/pin, e `grep -on 'id="..."' public/anunciante/ponto.html` não mostra nenhum campo de PIN. O lojista precisa combinar o número…
  · conserto: Construir a rota de PIN para o dono do ponto ou corrigir docs/funcional.md:52 e :101 — e explicar o painel por PIN em public/seja-um-ponto.html.

**Painel do PIN na TV: texto branco sobre laranja dá 2,61:1 — e o projeto já tem o token certo** *(quebra visual)*
  · onde: public/style.css:533 — `.painel-tela .pin-form button, .painel-tela .fechar { background: var(--brand); color: var(--escuro-texto); ... }`.
  · evidência: `--brand` é `#ff7a1a` e `--escuro-texto` é `#fff`: razão de contraste 2,61:1, contra o mínimo AA de 4,5:1. O próprio :root (style.css:27-29) define `--sobre-brand: #1a0f00` com o comentário "Texto sobre a cor de ação. Preto puro vibra sobre laranja" — e esse par dá 7,24:1. `.btn.primary` (style.css:87) usa o token…
  · conserto: Em /home/user/MostrAi/public/style.css:533, trocar `color: var(--escuro-texto)` por `color: var(--sobre-brand)`.

**Os três badges de status ficam abaixo de 4,5:1 — e são o sinal de estado de todo o produto** *(quebra visual)*
  · onde: public/style.css:290-292 — `.badge-pendente { background: rgba(255,122,26,.12); color: var(--brand-text); }`, `.badge-ok { background: rgba(22,163,74,.12); color: var(--ok); }`, `.badge-err { background:…
  · evidência: Compondo o alpha .12 sobre o branco do `--card` e medindo: pendente `#c2570a` sobre `#ffefe4` = 4,02:1; ok `#15803d` sobre `#e3f4e9` = 4,39:1; err `#dc2626` sobre `#fbe5e5` = 4,01:1. Todos abaixo de 4,5:1, e 12px em negrito não se qualifica como texto grande (o piso seria 18,66px em negrito). O próprio style.css:13…
  · conserto: Em /home/user/MostrAi/public/style.css:290-292, escurecer os três tokens de texto do badge (ex.: `#9a4508`, `#116533`, `#b01c1c`) ou subir o alpha do fundo de `.12` para `.18`, e conferir com um medidor até passar de 4,5:1.

**`.field-row > div { min-width: 130px }` vence `.u-col { min-width: 0 }` e quebra a linha Cidade/UF/CEP no popup de perfil** *(quebra visual)*
  · onde: public/style.css:209 (`.field-row > div { min-width: 130px; }`) contra :582 (`.u-col { flex: 1; min-width: 0; }`). Markup: public/perfil.js:41-45; também public/anunciante/cadastro.html:57-70 e…
  · evidência: `.field-row > div` tem especificidade (0,1,1) e `.u-col` tem (0,1,0) — o seletor descendente vence, então o `min-width: 0` das utilidades NUNCA se aplica dentro de uma `.field-row`; todos os campos ficam presos em 130px. Conta exata no popup de perfil: `dialog#dlgPerfil` (style.css:323) tem `max-width: 460px; padding:…
  · conserto: Em /home/user/MostrAi/public/style.css:209, trocar `min-width: 130px` por `min-width: 110px` e/ou dar à utilidade a especificidade necessária (`.field-row > .u-col { min-width: 0; }`) para que ela possa encolher como foi projetada.

**Alvos de toque de 22 a 30px, incluindo o botão destrutivo de excluir criativo** *(quebra visual)*
  · onde: public/style.css:400 (`.criativo-excluir { ... width: 26px; height: 26px; ... top: 8px; right: 8px; }`), :344 (`.dlg-foto-cam { width: 22px; height: 22px; }`), :306 (`.senha-olho { padding: 6px }` com SVG de 18px — 30px…
  · evidência: O piso de acessibilidade para toque é 44×44px (WCAG 2.5.5 / HIG). O caso pior é `.criativo-excluir`: 26×26px, posicionado 8px do canto de um card de criativo que no painel chega a 420px de altura, e cuja única proteção é um `confirm()` (painel.page.js, delegação em `#listaCriativos`). Perto dele fica o…
  · conserto: Em /home/user/MostrAi/public/style.css:400, levar `.criativo-excluir` a 40×40px (mantendo o ícone pequeno via `font-size`), e em /home/user/MostrAi/public/admin/index.css acrescentar `@media (max-width: 900px) { .btn.mini, .chip {…

**Tabela de comissões sem contêiner de rolagem — rolagem horizontal da página inteira no celular** *(quebra visual)*
  · onde: public/anunciante/vendedor.page.js:52 — `lista.innerHTML = '<table class="mini-table">...'` com 5 colunas, sem wrapper. Compare com public/anunciante/painel.page.js:237 e :250, que fazem `'<div class="u-ox-auto"><table…
  · evidência: O mesmo componente `.mini-table` (style.css:448) é usado nos dois painéis, mas só o do anunciante recebe o `.u-ox-auto` (style.css, utilidades: `overflow-x: auto`). No painel de vendas as colunas são Data, Anunciante, Cobrança, Sua comissão e Situação; o mínimo somado (a coluna Situação sozinha carrega um `.badge`…
  · conserto: Em /home/user/MostrAi/public/anunciante/vendedor.page.js:52, envolver a tabela em `<div class="u-ox-auto">...</div>`, igual ao que painel.page.js:237 já faz.

**Campo de chave Pix da tela de convite renderiza sem estilo nenhum (fica fora de `form.card`)** *(quebra visual)*
  · onde: public/convite.html:39-42 — `<div id="logadoPix"><label ...><input id="logado_chave_pix"></div>`, dentro do `<div class="card wide" id="jaLogado">`. Regras aplicáveis: public/style.css:210-212 (`form.card label`,…
  · evidência: Todas as regras de campo de formulário do site são qualificadas por `form.card` (`form.card label { font-size:.85rem; color: var(--text-dim); display:block }`, `form.card input { width:100%; background: var(--bg-alt); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }`). O bloco `#jaLogado` é…
  · conserto: Em /home/user/MostrAi/public/style.css, generalizar os seletores da linha 210-218 de `form.card X` para `.card X` (ou acrescentar `#jaLogado label, #jaLogado input` às mesmas declarações).

**Anunciante que já é dono de ponto perde, em silêncio, o bônus 'tela após N meses' que o plano vende** *(papéis cruzados)*
  · onde: src/conta/modos.js (bonusPontoDaConta) e public/modos.js (cardBonus)
  · evidência: bonusPontoDaConta calcula `disponivel: cobertos >= plano.ponto_apos_meses && !conta.ponto_bonus_resgatado_em && !(conta.papeis || []).includes('ponto')` e devolve `ja_e_ponto: (conta.papeis || []).includes('ponto')`. Em public/modos.js, cardBonus começa o ramo 'ponto' com `if (b.ja_e_ponto) return '';` — o card…
  · conserto: Em /home/user/MostrAi/public/modos.js, trocar o `return ''` de `ja_e_ponto` por um card explicando que a conta já é ponto e que o bônus vale para um endereço novo — ou ajustar bonusPontoDaConta em /home/user/MostrAi/src/conta/modos.js para…

**Cota de autoanúncio é dividida só entre telas ativas, mas a playlist é servida também a tela em reparo/inativo** *(papéis cruzados)*
  · onde: src/dispositivos/repository.js (buscarComPonto) e src/lib/aparelho.js (exigirAparelho)
  · evidência: buscarComPonto calcula `telas_do_ponto` como `(SELECT COUNT(*) FROM dispositivos x WHERE x.ponto_id = d.ponto_id AND x.status = 'ativo')`, e dividirCota (src/lib/pacing.js:38-42) faz `Math.ceil(cota / telas)`. Mas `exigirAparelho` em src/lib/aparelho.js só confere `String(enviada) !== dispositivo.aparelho_id` — não…
  · conserto: Recusar playlist em /home/user/MostrAi/src/lib/aparelho.js quando `dispositivo.status !== 'ativo'` ou `ponto_status` não for 'ativo', ou contar todas as telas que recebem playlist no `telas_do_ponto` de…

**Cupom de vendedor nunca é validado e a autoindicação é recusada em silêncio — o vendedor-anunciante perde comissão sem saber** *(papéis cruzados)*
  · onde: src/anunciantes/repository.js (criar) e src/financeiro/san-checkout.js (registrarComissaoSeHouver)
  · evidência: Em anunciantes/repository.js:41 o cadastro grava `dados.indicado_por_cupom ? String(dados.indicado_por_cupom).toUpperCase() : null` — sem nenhuma consulta a `vendedores`; `grep -n indicado_por_cupom src/anunciantes/routes.js` mostra que a rota só repassa o campo. A conferência só acontece no pagamento, em…
  · conserto: Validar `indicado_por_cupom` com `vendedoresRepo.buscarPorCupomAprovado` em POST /anunciantes/cadastro (/home/user/MostrAi/src/anunciantes/routes.js), devolvendo 400 por campo quando o cupom não existir, e registrar pendência em…

**A primeira tela instalada passa semanas mostrando uma lâmpada apagada sobre fundo preto** *(primeira vez)*
  · onde: public/player.css:1 e :10-12 · public/player.html:18 · public/player.page.js (classe sem-playlist)
  · evidência: player.css:1 põe `html, body { background: #000 }`; :10-12 define `#vazio { display:none }` / `#vazio img { width: 28vmin; opacity: .5 }` / `body.sem-playlist #vazio { display:flex }`; player.html:18 é `<div id="vazio"><img src="/img/simbolo-lampada.png" alt=""></div>`. Entre a instalação do primeiro ponto e a…
  · conserto: Trocar o conteúdo de #vazio em public/player.html por uma peça institucional de verdade (logo, 'anuncie aqui' e o WhatsApp) com opacidade 1, ou fazer a conta própria do Mostraí ser criada e aprovada antes de qualquer tela ir ao ar.

**As duas primeiras candidaturas do lançamento não avisam ninguém, e as páginas prometem contato em 2 dias úteis** *(primeira vez)*
  · onde: src/candidaturas/routes.js:8-17 · public/seja-um-ponto.html:142 · public/seja-um-vendedor.html:98
  · evidência: POST /candidaturas valida tipo/nome/telefone, chama `repo.criar(req.body)` e responde `{ok:true, id}`. Não há nenhum `require` de src/financeiro/email.js no diretório src/candidaturas/ (grep por 'email' só encontra a coluna contato_email no repository). seja-um-ponto.html:142 e seja-um-vendedor.html:98 prometem 'A…
  · conserto: Em src/candidaturas/routes.js, depois de repo.criar, disparar um e-mail fire-and-forget para MOSTRAI_EMAIL_CONTATO com tipo, nome e telefone, reusando o transportador de src/financeiro/email.js.

**O painel do primeiro anunciante pagante mostra zero exibições sem uma linha explicando por quê** *(primeira vez)*
  · onde: public/anunciante/painel.html:29-64 · public/anunciante/painel.page.js (desenharPorDia/desenharPorPonto/desenharCobrancas)
  · evidência: As três funções começam com `if (!porDia.length) return;` / `if (!porPonto.length) return;` / `if (!cobrancas.length) return;`, e os painéis #painelDia, #painelDetalhe e #painelCobrancas nascem `hidden` no HTML (painel.html:37, 42, 63). Com a rede vazia, GET /anunciantes/:id/exibicoes devolve totais zerados e arrays…
  · conserto: Em public/anunciante/painel.page.js, quando `dados.totalProgramadas === 0`, escrever um estado explícito abaixo do #kpiGrid dizendo o motivo real (sem ponto no ar / criativo em análise / criativo ainda não enviado), em vez de deixar três…

**Admin zerado: abas Pontos e Anunciantes mostram tabela só com cabeçalho, sem nenhum estado vazio** *(primeira vez)*
  · onde: public/admin/index.page.js:594 (renderPontos) e :804 (renderAnunciantes)
  · evidência: As duas abas montam `${caixaTabela({ chips: [...], html: corpo, dica: '...' })}` sem nenhum `if (lista.length)`, ao contrário de Telas (:691 'Nenhuma tela ainda. Crie a primeira pelo botão "+ tela" na aba Pontos.'), Vendedores (:892), Candidaturas (:935), Convites (:1008), Custos (:1067), Cobranças (:1548), Comissões…
  · conserto: Em public/admin/index.page.js:594 e :804, aplicar o mesmo padrão das outras abas: `${lista.length ? caixaTabela({...}) : '<p class="empty-state">...</p>'}`, dizendo qual é o próximo passo (candidatura → convite, e convite → conta).

**docs/api.md promete quatro campos que a migration 021 apagou do banco** *(rota órfã)*
  · onde: docs/api.md:18 e :37 vs src/db/migrations/021_remove_cobertura_adiada.sql:24-28
  · evidência: docs/api.md:18 diz que GET /planos devolve 'Campos novos: `meses_gratis`, `minimo_telas_ativas`, ...' e docs/api.md:37 diz que GET /anunciantes/me devolve '`meses_gratis_creditados`, `meses_cobertura_pendentes`'. A migration 021_remove_cobertura_adiada.sql dropa as quatro colunas (`ALTER TABLE planos DROP COLUMN IF…
  · conserto: Apagar as quatro menções das linhas 18 e 37 de docs/api.md (e conferir a mesma linha contra CAMPOS_PUBLICOS de src/anunciantes/repository.js).

**Quatro rotas vivas fora do docs/api.md, entre elas o comprovante fiscal do anunciante e o extrato do ponto** *(rota órfã)*
  · onde: docs/api.md (ausências) vs src/anunciantes/routes.js:380, src/pontos/routes.js:77, src/financeiro/routes.js:367-369
  · evidência: (1) `grep -rn "exibicoes.csv" docs/` = zero: GET /anunciantes/:id/exibicoes.csv (src/anunciantes/routes.js:380), que é o comprovante de veiculação da RN-19 e é chamado por public/anunciante/painel.page.js:169, não está em lugar nenhum do doc. (2) `grep -n "extrato" docs/api.md` só acha o título da seção 'Pagamento ao…
  · conserto: Acrescentar as quatro linhas ao docs/api.md: exibicoes.csv na tabela 'Conta logada', /anunciantes/me/pontos/extrato na seção de pagamento ao ponto, e os três 410 de /afiliados junto do 410 de /seja-um-ponto.

**POST /admin/planos-ponto (criar opção de comodato) não tem formulário em lugar nenhum do admin** *(rota órfã)*
  · onde: src/pontos/routes.js:149 vs renderComodato em public/admin/index.page.js:1479
  · evidência: src/pontos/routes.js:149 registra POST /admin/planos-ponto (409 em id duplicado) e docs/api.md:151 a documenta como 'cria'. Mas `renderComodato` (public/admin/index.page.js:1479) só faz `pegar('/admin/planos-ponto')` e `pegar('/admin/planos')` e edita inline por `salvar('/admin/planos-ponto/${id}', ...)` (linha 1515)…
  · conserto: Acrescentar o `<details>` '+ Nova opção de comodato' em renderComodato (public/admin/index.page.js:1479), chamando POST /admin/planos-ponto, no mesmo padrão de renderBeneficios.


---

## Baixa

**public/nav-auth.js continua versionado e nenhum HTML o carrega** *(beco sem saída)*
  · onde: public/nav-auth.js
  · evidência: `grep -rn 'nav-auth' public/` retorna uma única linha: o comentário de public/layout.js:119 ('Isso substituiu o antigo nav-auth.js'). Nenhum `<script src="/nav-auth.js">` existe em qualquer HTML do projeto. O arquivo faz o próprio GET /anunciantes/me e uma versão antiga da troca de menu, que hoje vive em…
  · conserto: Apagar /home/user/MostrAi/public/nav-auth.js e a menção a ele no comentário de public/layout.js:119.

**H1 de /planos.html e /pontos.html perde o `clamp()` responsivo por causa de utilidades de tamanho fixo** *(quebra visual)*
  · onde: public/style.css:98 (`h1 { font-size: clamp(2rem, 4vw, 3.1rem); }`) contra as utilidades :636-638 (`.u-fs-220 { font-size: 2.2rem }`, `.u-fs-240 { font-size: 2.4rem }`). Markup: public/planos.html:41 (`<h1…
  · evidência: A utilidade tem especificidade (0,1,0) contra (0,0,1) do seletor de elemento, e ainda vem depois no arquivo — vence sempre. Resultado: no celular a home encolhe o H1 para 2rem (32px, o piso do clamp), enquanto /planos.html fica travada em 2,4rem (38,4px) e /pontos.html e /contato.html em 2,2rem (35,2px). Três tamanhos…
  · conserto: Remover `u-fs-240`/`u-fs-220` dos `<h1>` de /home/user/MostrAi/public/planos.html:41, pontos.html:29 e contato.html:38, deixando o `clamp()` de style.css:98 valer — ou trocar as utilidades por um `clamp()` próprio.

**`.panel-head` não tem `flex-wrap` — título e controles se espremem no celular** *(quebra visual)*
  · onde: public/style.css:370 — `.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }`. Usos críticos: public/anunciante/painel.html:43-56 (h3 + label + `<select…
  · evidência: Todas as outras linhas flex da folha declaram quebra — `.dash-status` (style.css:353) tem `flex-wrap: wrap`, `.cta-row` (:125) tem, `.tela-acoes` (:504) tem, `.admin-topo` (admin/index.css:16) tem. `.panel-head` não. No painel do anunciante, dentro de um `.panel` de padding 24px num `.wrap` de 320px (celular de…
  · conserto: Acrescentar `flex-wrap: wrap;` à regra `.panel-head` em /home/user/MostrAi/public/style.css:370.

**Botão de fechar do diálogo (40px) invade a área reservada no cabeçalho (28px)** *(quebra visual)*
  · onde: public/style.css:328 (`.dlg-head { ... position: relative; padding-right: 28px; }`) e :329-333 (`.dlg-close { position: absolute; right: 0; top: -4px; ... min-width: 40px; min-height: 40px; }`). Afeta…
  · evidência: O `padding-right: 28px` do `.dlg-head` foi dimensionado para o botão de fechar antigo; quando o `min-width: 40px` foi acrescentado (comentário do arquivo indica que veio de uma correção de alvo de toque), o padding não acompanhou. O botão cobre os últimos 40px do cabeçalho enquanto o texto do título pode avançar até…
  · conserto: Em /home/user/MostrAi/public/style.css:328, subir o `padding-right` do `.dlg-head` de 28px para 44px, casando com o `min-width` de `.dlg-close`.

**No menu público logado as abas bloqueadas perdem a explicação, e a conta só-ponto é levada direto para a página quebrada** *(papéis cruzados)*
  · onde: public/layout.js (bloco `if (layout === 'publico')` vs aplicarPapeisNoMenu)
  · evidência: Em aplicarPapeisNoMenu o marcador faz `el.classList.toggle('bloqueado', !liberado); el.title = liberado ? '' : 'Modo ainda não ativado — clique pra ativar';`. Já no ramo público o helper é `const aba = (href, papel, texto) => \`<a href="${href}" class="modo-aba ${papeis.includes(papel) ? '' :…
  · conserto: Reusar `window.aplicarPapeisNoMenu` no ramo `layout === 'publico'` de /home/user/MostrAi/public/layout.js em vez de remontar o `aba()` à mão, e remover a chave `pendente_aprovacao` de ROTULOS.vendedor no mesmo arquivo.

**Na primeira abertura do admin, a visão geral diz 'Tudo em dia. Nenhuma fila esperando você agora.'** *(primeira vez)*
  · onde: public/admin/index.page.js:333 (renderResumo) · src/admin/routes.js:57-90 (filas)
  · evidência: `${pendentes.length ? ...alertas... : '<div class="tudo-em-dia"><b>Tudo em dia.</b> Nenhuma fila esperando você agora.</div>'}` — `pendentes` é ALERTAS filtrado por `filas[a.fila] > 0`, e com banco limpo as oito contagens de GET /admin/resumo (criativos, eventos, anunciantes, pontos, notas, candidaturas,…
  · conserto: Em public/admin/index.page.js:333, quando `rede.pontosAtivos === 0 && rede.novosAnunciantes30d === 0`, trocar o bloco 'tudo-em-dia' por um roteiro de primeira configuração com links para as abas Meus anúncios, Candidaturas e Pontos.

**public/nav-auth.js continua versionado, chama GET /anunciantes/me e nenhum HTML o carrega** *(rota órfã)*
  · onde: public/nav-auth.js
  · evidência: `grep -rn "nav-auth" public/ src/` devolve uma única linha, e é um comentário: public/layout.js:119 — '(Isso substituiu o antigo nav-auth.js.)'. Nenhum `<script src="/nav-auth.js">` existe em nenhum HTML do projeto. O arquivo (708 bytes) segue no repositório e faz fetch em /anunciantes/me.
  · conserto: Apagar /home/user/MostrAi/public/nav-auth.js.

**src/pontos/routes.js exporta o router antes de declarar as três rotas de pagamento** *(rota órfã)*
  · onde: src/pontos/routes.js:166 (module.exports) com rotas nas linhas 171, 175 e 186
  · evidência: `grep -n "module.exports" src/pontos/routes.js` → linha 166; o arquivo tem 198 linhas e as rotas GET/POST /admin/pontos/:pontoId/pagamentos e PATCH /admin/pagamentos-ponto/:id são registradas depois disso. Não quebra em runtime (o export é a referência do mesmo objeto e o corpo do módulo roda inteiro no require, antes…
  · conserto: Mover `module.exports = router;` da linha 166 para o fim de src/pontos/routes.js.

**docs/api.md e CLAUDE.md dão três contagens diferentes para as rotas de /admin; a tabela do doc é a única certa** *(rota órfã)*
  · onde: docs/api.md:88 e CLAUDE.md (estação 4)
  · evidência: docs/api.md:88 diz 'As 60 rotas estão listadas uma a uma de propósito'. CLAUDE.md fala em 55 rotas de /admin. O número real é 65: `grep -rhoE "router\.(get|post|patch|put|delete)\('/admin/[^']*'" src/ | sort -u | wc -l` = 63, mais POST /admin/login (src/server.js:126) e POST /admin/logout (src/server.js:142). A tabela…
  · conserto: Corrigir '60' para '65' em docs/api.md:88 e a contagem correspondente no CLAUDE.md.

---

## Novo, 19/09/2026 — achado ao construir a escada de 5 planos do comodato

Não veio de varredura — apareceu ao implementar o Plano Inicial
(`inicial-1m`, migration 063) e revisar o texto do contrato de comodato
contra o que o sistema hoje entrega. Confirmado lendo o código, não hipótese.

**O Plano Inicial (1 ponto incluído) não garante que o ponto escolhido seja a própria tela do dono** *(regra de negócio)*
  · onde: `src/pontos/comodato.js` (`ajustarPlanoIncluido`) e RN-42 (`src/anunciantes/routes.js`, escolha/distribuição automática de pontos)
  · evidência: `ajustarPlanoIncluido` só troca `anunciantes.plano_id`; nunca grava em `anunciantes_pontos`. Sem escolha manual do dono em `PUT /anunciantes/me/pontos`, RN-42 distribui automaticamente por um embaralhamento estável (`${anuncianteId}-${pontoId}`) entre TODOS os pontos `em_operacao` da rede — não há preferência pelo ponto do próprio dono. Com `pontos_incluidos=3` (o Plano Básico de antes, dado hoje pela modalidade "troca por tela") a chance de o sorteio incluir o próprio ponto era razoável numa rede pequena; com `pontos_incluidos=1` (o Plano Inicial novo, dado por "recebe os R$ 50") a intenção declarada do dono — "1 ponto (a própria tela instalada no comércio dele)" — só se realiza se o sorteio acertar esse único ponto, ou se o dono escolher manualmente depois.
  · conserto: Decidir se `ajustarPlanoIncluido`/`aplicarModalidade` (`src/pontos/comodato.js`) devem gravar `anunciantes_pontos` com o próprio ponto na mesma transação que concede o Plano Inicial (pré-seleção automática do que já é óbvio pro caso de 1 ponto só), ou deixar como está e reforçar no onboarding que o dono precisa confirmar a escolha em `PUT /anunciantes/me/pontos`. Registrado em `docs/funcional.md`, RN-43, como furo em aberto — não corrigido nesta rodada.
