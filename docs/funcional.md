# Definição funcional — Mostraí

O que o sistema faz, tela por tela, em detalhe suficiente para construir sem
inventar comportamento. Escrito na Estação 4 (14/09/2026).

Vizinhos: `docs/specs/2026-09-12-mostrai.md` diz **por que** o projeto existe;
`CONSTRAINTS.md` diz **o que ele não faz**; este diz **o que ele faz**.

> Este é o único documento de definição que muda durante o projeto. Mudou o
> comportamento, muda aqui na mesma tarefa.

---

## 1. Público-alvo

| Papel | O que quer resolver | O que sabe fazer sozinho |
|---|---|---|
| **Anunciante** | aparecer nas telas da cidade sem produzir campanha nem entender mídia; paga um valor fixo por mês | se cadastra, assina plano e sobe um vídeo pelo celular. Não lê manual |
| **Dono de ponto** | ganhar ajuda de custo ou anunciar o próprio negócio cedendo uma parede | liga a TV e não mexe mais. Usa o painel raramente, pelo celular |
| **Vendedor** | indicar anunciantes e receber comissão | manda o link com o cupom dele pelo WhatsApp. Acompanha o que tem a receber |
| **Administrador** (o dono do Mostraí) | aprovar quem entra, ver margem real, operar a rede | conhece o sistema inteiro. Usa no computador |
| **Tela** (aparelho, não pessoa) | tocar a playlist da própria tela sem ninguém por perto | nada. É um navegador em modo quiosque numa TV de comércio de terceiro |

Papel sem tela não existe; tela sem papel ninguém abre.

---

## 2. Jornadas

### 2.1 Anunciante — do site ao vídeo no ar

1. Chega em `/` ou `/planos.html` e vê a grade de planos com preço e frequência.
2. Escolhe um plano e clica em assinar → vai para `/anunciante/cadastro.html`.
3. Preenche empresa, CNPJ/CPF, endereço, contato e senha; aceita os termos.
4. A conta nasce com o papel **anunciante** e status `aprovado` — não existe
   mais aprovação de conta (RN-34); o painel abre na hora.
5. Escolhe o plano e assina → é levado ao San Checkout.
6. Paga. O webhook `criada` chega, a conta vira `ativo` e a cobertura começa.
7. Sobe o vídeo na aba **Anúncios**. O sistema normaliza com ffmpeg e gera a thumb.
8. O administrador aprova o criativo — esse é o único portão que existe.
9. O vídeo entra na playlist de todas as telas ativas, na frequência do plano — e é essa frequência que a tela entrega, com a rede vazia ou cheia (RN-39).
10. O anunciante acompanha exibições na própria aba.

### 2.2 Dono de ponto — do painel à tela no ar

1. Cria a conta normalmente (`/anunciante/cadastro.html`) — toda conta nasce **anunciante**.
2. De dentro do painel, pede o modo **Meu ponto**: nome do estabelecimento, endereço, segmento, fluxo de pessoas (opcional). O resto (nome, contato) já é da conta.
3. O pedido vira candidatura ligada à conta (`conta_id`, `origem: painel`); o administrador avalia bairro e ramo, conversa por WhatsApp, e decide.
4. Aprovado, o administrador libera direto na conta (`POST /admin/candidaturas/:id/liberar`) — sem convite, sem conta nova: a mesma conta ganha o papel **ponto**, e o ponto (com a Tela 1) nasce ali.
5. O administrador cadastra as telas extras, define custo e prazo de amortização de cada uma, e gera a **chave de aparelho**.
6. A TV abre o link do player uma vez; a chave fica guardada no aparelho.
7. O dono do ponto define o **PIN** da tela no próprio painel
   (`/anunciante/ponto.html` → a tela → "PIN desta tela") e passa a acompanhar
   ali — ou pelo painel da própria TV, com 5 toques no canto e o PIN.
8. Sobe o **próprio anúncio** na cota do comodato, em "Meu anúncio na minha
   tela": mesma conferência de conteúdo que vale para qualquer anúncio da rede.

### 2.3 Vendedor — do convite à comissão

1. Fala direto com a Mostraí por um canal oficial (não existe pedido self-service — o card do modo no painel e o card da home só apontam pro contato) e, se fechar, recebe convite do administrador.
2. Abre `/convite.html?t=…`, a conta nasce com o papel **vendedor** e um cupom.
3. Manda `/anunciante/cadastro.html?ref=CUPOM` para o interessado.
4. O indicado assina e paga.
5. A comissão é gerada sobre o valor confirmado, no percentual da conta do vendedor.
6. Acompanha em `/anunciante/vendedor.html`; o administrador marca como paga.

### 2.4 Administrador — o dia a dia

1. Entra em `/admin` (usuário e senha; o Cloudflare Access é a porta).
2. Vê o **resumo**: receita, ajuda de custo, amortização, custos fixos e **margem real**.
3. Aprova contas, candidaturas e criativos.
4. Gera convites, cadastra pontos e telas, define chave e PIN.
5. Edita a grade de planos e os benefícios.
6. Confere cobranças, comissões e a fila de eventos pendentes.

### 2.5 Tela — o ciclo do player

1. A TV abre `/player.html?tela=<id>` com a chave guardada.
2. Pede a playlist da hora; sem chave válida, 401.
3. Toca os vídeos em ordem, avisa `played` a cada exibição e manda `heartbeat`.
4. Cinco toques no canto superior direito (ou tecla P) pedem o PIN e abrem o painel daquela tela.

**Jornadas secundárias:** redefinir senha, editar perfil, excluir conta, pedir
ativação de um papel novo pelo painel, resgatar bônus de módulo cruzado.

---

## 3. Telas

| Tela | URL | Quem acessa | O que mostra | O que dá para fazer | Para onde leva |
|---|---|---|---|---|---|
| Início | `/` | público | o que é a rede, pontos, chamada, card de ponto e de vendedor | conhecer | planos, cadastro, contato |
| Planos | `/planos.html` | público | grade de 3 níveis × 4 ciclos, e o plano fundador se aberto | escolher plano | cadastro |
| Pontos | `/pontos.html` | público | os comércios da rede | ver onde o anúncio roda | cadastro |
| Comodato | `/comodato.html` | público | as opções de quem cede a parede | entender a contrapartida | — |
| Contato | `/contato.html` | público | formulário | mandar mensagem | — |
| Cadastro | `/anunciante/cadastro.html` | público | formulário de conta (aceita `?ref=CUPOM`) | criar conta de anunciante | painel |
| Login | `/anunciante/login.html` | público | e-mail e senha | entrar | painel |
| Esqueci a senha | `/esqueci-senha.html` | público | e-mail | pedir link | — |
| Redefinir senha | `/redefinir-senha.html?token=` | quem tem o token | nova senha | trocar a senha | login |
| Convite | `/convite.html?t=TOKEN` | quem tem o convite | papéis que o convite concede | criar conta ou aceitar logado | painel |
| Painel | `/anunciante/painel.html` | conta logada | abas Anúncios / Meu ponto / Vendas | assinar, subir criativo, ver exibições, baixar o comprovante de veiculação (CSV), e **pedir a arte pelo WhatsApp** (anúncio simples incluído, ou gravação orçada à parte) | perfil, ponto, vendedor |
| Meu ponto | `/anunciante/ponto.html` | conta com papel ponto | telas do ponto, cota, **sinal de cada tela**, e o **extrato** do que já foi pago e do que está em aberto | definir PIN, acompanhar | — |
| Vendas | `/anunciante/vendedor.html` | conta com papel vendedor | cupom, indicados, comissões | copiar link, informar Pix | — |
| Perfil | `/anunciante/perfil.html` | conta logada | dados da conta | editar, trocar foto, excluir conta | — |
| Player | `/player.html?tela=ID` | a TV, com chave | o vídeo da vez | tocar; 5 toques abrem o painel por PIN | — |
| Admin | `/admin/` | administrador | tudo: resumo, contas, candidaturas, convites, pontos, telas, planos, benefícios, cobranças, comissões, vendedores, custos fixos, eventos pendentes, e **Meus anúncios** (a conta do próprio Mostraí) | operar a rede inteira | — |
| Termos de uso | `/termos-de-uso.html` | público | o contrato | ler | — |
| Política de privacidade | `/politica-de-privacidade.html` | público | uso de dados | ler | — |
| Contrato do anunciante | `/contrato-anunciante.html` | público | condições do plano | ler | — |

**Legado, mantido só para link salvo:** `/afiliado/*` responde 410 apontando
para a conta única. `POST /seja-um-ponto` e `POST /candidaturas` (o
formulário público, sem conta — aposentado em 18/09/2026) respondem 410 de
propósito — o caminho agora é criar conta e pedir o modo ponto de dentro do
painel.

---

## 4. Estados de cada tela

Escrito por grupo, porque o padrão se repete.

**Planos (`/planos.html`)**
- *Vazio:* nenhum plano ativo → "os planos estão sendo atualizados, fale com a gente".
- *Carregando:* esqueleto dos cards.
- *Erro:* "não conseguimos carregar os planos agora" com botão de tentar de novo.
- *Sucesso:* a grade.
- *Sem permissão:* não se aplica — a tela é pública.
- *Lista longa:* não se aplica — são sempre 12 linhas, no máximo 13 com o fundador.

**Painel (`/anunciante/painel.html`)**
- *Vazio:* aba sem papel mostra o **card de ativação**, não uma tela em branco.
  Na aba Anúncios, sem plano ativo (nunca assinou, ou cancelou/venceu sem
  trocar) o dashboard inteiro (KPIs, gráficos e o upload de criativo) fica
  atrás de um card de bloqueio com CTA "Escolher plano" (19/09/2026) — o
  upload de auto-serviço também recusa no backend (400) nesse estado; é
  caminho diferente do admin/conta própria, que continua sem essa exigência.
  Conta suspensa cai no mesmo bloqueio, mas sem CTA — só remete pro aviso já
  mostrado no banner.
- *Carregando:* abas visíveis, conteúdo em esqueleto.
- *Erro:* faixa no topo com "não conseguimos carregar seus dados".
- *Sucesso:* conteúdo da aba — com plano ativo, os KPIs incluem banco de
  horas (saldo em exibições/horas, quando há saldo) e horas entregues no mês
  vs. contratadas vs. ainda por rodar; o gráfico por ponto mostra os 8 que
  mais exibiram, com contagem e percentual do total.
- *Sem permissão:* sessão expirada → volta para o login.
- *Lista longa:* criativos e exibições paginam a partir de 50 linhas.

**Player (`/player.html`)**
- *Vazio:* playlist sem itens → tela institucional do Mostraí, nunca tela preta.
- *Carregando:* logo enquanto o primeiro vídeo carrega.
- *Erro:* sem rede → toca o que está em cache e tenta de novo a cada ciclo.
- *Sucesso:* o vídeo.
- *Sem permissão:* chave inválida → "tela não autorizada — fale com o Mostraí".
- *Lista longa:* o gerador corta em 200 slots por hora (trava de segurança).

**Admin (`/admin/`)**
- *Vazio:* cada aba diz o que fazer primeiro ("nenhuma candidatura ainda").
- *Carregando:* tabela em esqueleto.
- *Erro:* mensagem por seção, nunca uma página de erro inteira.
- *Sucesso:* a tabela.
- *Sem permissão:* 401 → tela de login do admin.
- *Lista longa:* tabelas paginam a partir de 100 linhas.

**Formulários públicos (cadastro, candidatura, contato, convite)**
- *Vazio:* campos limpos com rótulo visível.
- *Carregando:* botão desabilitado com "enviando…".
- *Erro:* mensagem **por campo**, e a geral acima do botão.
- *Sucesso:* confirmação na própria tela, sem redirecionar sem avisar.
- *Sem permissão:* convite usado ou expirado → "este convite não vale mais".
- *Lista longa:* não se aplica.

---

## 5. Regras de negócio

**RN-01 — A grade de planos é fixa: 3 níveis × 4 ciclos = 12 linhas.**
Essencial, Destaque e Máximo; mensal, trimestral, semestral e anual. Não existe
criar plano, só editar um dos 12. Cada célula é isolada — editar
Essencial-mensal não toca Essencial-anual. *Violada:* o admin não oferece a
ação. *Quem vê:* administrador.

**RN-02 — O que se desliga é o ciclo inteiro.** Um nível isolado só sai
enquanto o ciclo dele está ativo, para promoção. Plano desativado aparece
apagado **só no admin**, nunca para o cliente. *Violada:* o plano some da
vitrine. *Quem vê:* administrador vê apagado; o público não vê nada.

**RN-03 — Ponto e vendedor nunca se autodeclaram; o dono sempre decide.**
*(Reescrita em 18/09/2026 — o formulário público sem conta foi aposentado, a
pedido do dono, pra unificar a entrada: toda conta nasce igual, sempre
`anunciante`.)* Ponto pede de dentro do painel de uma conta que já existe
(`POST /conta/modos/ponto/pedir`), e o dono libera direto nela
(`POST /admin/candidaturas/:id/liberar`) — sem convite, sem conta nova.
Vendedor não tem pedido nenhum: só entra depois de falar com o dono por um
canal oficial, que gera um convite à mão (`POST /admin/convites`, sem
candidatura). *Violada:* `POST /candidaturas` e `POST /seja-um-ponto`
respondem 410; `POST /conta/modos/vendedor/pedir` responde 400 (não existe
mais). *Quem vê:* quem tentou o caminho antigo.

**RN-04 — Benefício comercial se dá no preço, nunca no tempo.** A assinatura do
San Checkout não tem carência, mês grátis nem pular ciclo. Desconto entra no
valor que `GET /plano/{id}` devolve. *Violada:* não há caminho no código.
*Quem vê:* ninguém — é veto estrutural.

**RN-05 — A primeira cobrança paga chega como `criada`; renovação como
`cobranca_confirmada`.** Os dois creditam um ciclo, pela mesma dedupe por
`chargeId`. *Violada:* o evento vira pendência e espera a conciliação.
*Quem vê:* administrador, na fila de eventos pendentes.

**RN-06 — O webhook é fail-closed.** Sem assinatura HMAC válida, dentro da
janela de 300s, sobre o corpo cru, é 401. *Violada:* nada é creditado.
*Quem vê:* ninguém na hora; a conciliação diária corrige.

**RN-07 — Tela ≠ ponto.** Playlist, chave, PIN, sinal e custo vivem em
`dispositivos`. Ajuda de custo e cota de autoanúncio vivem no ponto, e a cota é
dividida entre as telas dele. *Violada:* não há caminho. *Quem vê:* —

**RN-08 — Nada de usuário e senha na TV.** A tela autentica por chave de
aparelho, revogável no admin. O PIN de 4 a 6 dígitos abre **apenas** o painel
daquela tela. *Violada:* 401 no player. *Quem vê:* quem está na frente da TV.

**RN-09 — A hora da tela é um orçamento de 3600 segundos.** A playlist de cada
hora é montada gastando esse orçamento, nesta ordem: exibição contratada
(o tempo de tela do plano + déficit da hora anterior), cota de autoanúncio do dono
do ponto, e o que sobrar vira espaço vago. Quando o contratado passa de 3600s
o corte é proporcional (regra dos maiores restos) e o aperto vira o evento
`playlist:teto_corta`; a partir de 80% de ocupação sai o aviso antecipado
`playlist:hora_quase_cheia`. *Violada:* o gerador corta. *Quem vê:* o dono, na
métrica — é o sinal de que a rede está vendida e é hora de subir preço ou
abrir ponto.
> Até 16/09/2026 o teto era de **200 slots**, não de segundos, e os "240 slots
> teóricos" só existiam com vídeo de 15s. Com 30s, 200 slots davam 6000
> segundos numa hora de 3600: metade do programado não cabia e virava déficit
> que a hora seguinte nunca quitava.

**RN-10 — A frequência compensa déficit da hora anterior.** Quem ficou devendo
exibição recebe a mais na hora seguinte, dentro do orçamento da RN-09.
*Violada:* não há caminho. *Quem vê:* o anunciante, na contagem de exibições.

**RN-39 — O que se vende é TEMPO DE TELA por hora, não número de repetições.**
O plano dá `segundos_por_hora` em cada ponto da cobertura, e o número de
inserções sai disso: `floor(segundos_por_hora / duração da peça)`. Quem sobe
uma peça mais curta aparece mais vezes pelo mesmo preço, e quem sobe uma mais
longa aparece menos — o que a conta consome do estoque é o mesmo nos dois
casos. As inserções são espalhadas ao longo da hora, não sorteadas: 90
segundos amontoados em cinco minutos não são 90 segundos de hora. *Violada:*
só pela RN-09, quando a rede enche e o corte proporcional entra; aí todos
entregam menos, na mesma proporção. *Quem vê:* o anunciante, no painel.
> **Por que deixou de ser repetição** (decisão do dono, 17/09/2026): com
> "N vezes por hora", a duração da peça entrava na conta do estoque duas
> vezes — o plano de peça longa comia o dobro da hora pelo mesmo preço, e
> subir o limite de duração de um plano quebrava o orçamento de todos os
> outros. Vendendo segundos, duração vira benefício de vitrine e para de
> mexer no inventário. O teto de duração por plano (RN-41) continua, porque
> peça longa demais deixaria a conta com uma inserção só por hora.
> **O furo que isto fechou** (medido em 16/09/2026): o gerador montava uma
> lista com N cópias de cada anunciante e o player tocava essa lista em LAÇO
> (`indice = (indice + 1) % playlist.length`). A lista não tinha relação
> nenhuma com os 3600 segundos da hora, então a frequência entregue era
> "quantas voltas cabem na hora". Com um anunciante só na rede, o Essencial
> vendia 3 e a tela entregava **180**; com 30 anunciantes, o Máximo vendia 12 e
> entregava 5. O produto piorava 36× conforme a rede desse certo — e
> `vezes_programadas` e `vezes_confirmadas` nem eram comparáveis.
> **A alternativa que NÃO foi escolhida:** entregar o excedente como bônus e
> mostrar "3 contratadas + N de bônus" no painel. Foi descartada porque treina
> o cliente a esperar o número do lançamento, que a rede não consegue manter
> quando enche — a mesma degradação, só que combinada.

**RN-40 — Espaço vago da hora anuncia a própria rede.** Os segundos que
ninguém comprou são preenchidos com a peça institucional do player (`#vazio`
em `public/player.html`, a mesma que aparece quando não há playlist): "Este
espaço pode ser do seu negócio". Dez segundos por peça. Não tem url, não é de
ninguém, não conta exibição e não entra em relatório de entrega. *Violada:*
não há caminho — a tela nunca fica preta nem parada. *Quem vê:* quem está na
frente da TV, que é exatamente o público que a Mostraí quer vender.

**RN-41 — Cada plano tem um teto de duração da peça.** `duracao_maxima_segundos`
define até quantos segundos a peça pode ter: 15s no Essencial, 20s no Destaque,
30s no Máximo. O upload recusa acima do teto, com o número do plano na
mensagem, e a vitrine diz o limite antes de a pessoa assinar. O teto não é
reserva de estoque — quem vende é a RN-39 — é proteção de ritmo: sem ele, uma
peça de 60s deixaria a conta com uma inserção só por hora. *Violada:* o upload
recusa. *Quem vê:* o anunciante, ao subir o criativo.

**RN-42 — A cobertura é um número de pontos, e o contratante escolhe quais.**
`pontos_incluidos` diz em quantos pontos da rede o plano aparece (3 no
Essencial, 7 no Destaque, 10 no Máximo). O anunciante escolhe quais no painel,
até o limite do plano; se não escolher nenhum, o sistema distribui sozinho, de
forma ESTÁVEL — um embaralhamento derivado de `${anuncianteId}-${pontoId}`,
que dá sempre o mesmo resultado para a mesma conta, mas redistribui quando a
rede cresce. Só ponto `em_operacao` entra na conta, e a promessa da vitrine é
"cobre até N pontos da rede": enquanto a rede tiver menos que N, cobre todos.
*Violada:* a rota recusa escolha acima do limite ou de ponto fora de operação.
*Quem vê:* o anunciante, na aba de pontos do painel.
> **Por que "até N", e não "N garantidos"** (decisão do dono, 17/09/2026):
> no lançamento a rede tem 3 pontos previstos. Prometer 10 pontos ao Máximo
> seria vender o que não existe; "cobre até 10" é verdade no primeiro dia e
> continua verdade no centésimo.

**RN-43 — O comodato é uma escolha entre dinheiro e tela, e as duas dão
tela.** Quem cede a parede escolhe uma das duas opções, na candidatura:
· **"Recebe os R$ 50"** — R$ 50/mês na conta mais o plano básico incluído
  (`comodato-basico`: 45 s/hora em até 3 pontos, peça de 15s, 1 criativo) =
  13,5 horas de tela por mês. **Não pode assinar plano de catálogo** enquanto
  estiver recebendo: `POST /anunciantes/:id/assinar` recusa e explica a troca.
· **"Troca os R$ 50 por tela"** — sem dinheiro, e o Essencial inteiro
  incluído = 27 horas por mês, o dobro. **Pode** assinar Destaque ou Máximo,
  com `credito_comodato_mensal` de R$ 50 abatendo a mensalidade.
**O crédito vale SÓ no Destaque e no Máximo.** No Essencial não abate nada,
porque o Essencial já É o que ele ganhou por abrir mão dos R$ 50 — abater ali
também seria gastar os mesmos R$ 50 duas vezes (ele teria o Essencial de
cortesia e ainda assinaria um segundo por R$ 49).
**A troca de modalidade tem mão única no autoatendimento:** trocar a ajuda de
custo POR TELA o dono do ponto faz sozinho e na hora
(`POST /anunciantes/me/comodato/trocar-por-tela`); VOLTAR a receber os R$ 50
só sai pelo admin (`PATCH /admin/pontos/:id`). Abrir mão do dinheiro não custa
nada à Mostraí — ela para de pagar e ele ganha o dobro de tela. Voltar a
receber é despesa nova e recorrente, e entra no caixa do mês. Sem a
assimetria, dava pra pingar entre as modalidades e sacar a ajuda de custo só
nos meses em que ela valesse mais, o que ninguém concilia.
O plano incluído é concedido na MESMA transação que cria o ponto, e nunca por
cima de plano que a conta já tenha — dono de ponto que já era cliente pagante
continua no plano que paga. *Violada:* a rota de assinar recusa. *Quem vê:* o
dono do ponto, no painel e na fatura.
> **As duas opções custam quase o mesmo ao Mostraí** — R$ 99,50 (R$ 50 de
> caixa + R$ 49,50 de estoque) contra R$ 99,00 (só estoque). O comerciante
> escolhe pelo que prefere, não por qual é o negócio melhor: não existe
> arbitragem entre elas. E a opção B não tira nada do caixa, que com R$ 2.500
> de equipamento por ponto e receita zero é o que decide no lançamento.
> **O abatimento de R$ 50 no Destaque e no Máximo não é desconto de verdade,
> e isso é uma qualidade:** quem pega o Destaque desembolsa R$ 199 mas deixa
> de receber R$ 50, então paga os R$ 249 da tabela. O preço de catálogo não é
> corroído e nenhum comerciante da cidade vai poder dizer que o vizinho
> comprou o Destaque pela metade. O único presente real é o Essencial da
> opção B: R$ 99 por R$ 50 abertos mão, 2x — proporção que se defende sozinha
> para quem hospeda o equipamento.
> **O que SAIU:** a cota de autoanúncio (`cota_slots_hora`) foi a zero nas
> duas opções. Ela rodava só na tela do próprio dono e valia ~R$ 16,50/mês na
> melhor das hipóteses — trocar R$ 50 por aquilo era um negócio 4,5x contra o
> comerciante. O plano incluído põe ele na REDE, e vale o que os R$ 50 valem.

**RN-44 — O dono do ponto passa na tela dele.** *(Decisão do dono,
17/09/2026 — fecha o item 28.)* Ele entra na rotação paga do próprio ponto
como qualquer anunciante que escolheu aquele ponto, pelo plano que o comodato
lhe deu. A exclusão antiga (`anunciantesElegiveis` tirava `dono_conta_id`)
só continua valendo enquanto aquela tela tiver cota de autoanúncio maior que
zero, que é o único caso em que ele apareceria em dobro. *Violada:* não há
caminho. *Quem vê:* o dono do ponto, na própria TV, e os clientes dele.
> A exclusão fazia sentido quando a contrapartida do comodato era a COTA: ele
> já entrava por ali. Com a cota zerada na 049, ela passou a fazer o contrário
> do que protegia — ele escolhia o próprio ponto em
> `PUT /anunciantes/me/pontos`, a rota aceitava, e o gerador tirava ele de lá.
> Queimava uma vaga de cobertura paga num lugar onde nunca ia aparecer, sem
> aviso nenhum. E é justamente a tela dele que vende o comodato: é ali que os
> clientes dele passam.

**RN-45 — Produção de peça é serviço à parte, não benefício de plano.**
*(Decisão do dono, 17/09/2026: "nunca disse que era benefício, e sim fica
separado dos planos, com negociação direta pelo WhatsApp, pelo valor que vai
ser cobrado".)* Nenhum plano promete arte incluída. Quem não tem a peça pede
orçamento no WhatsApp e combina o preço caso a caso. *Violada:* não há
caminho — a linha saiu do banco na migration 050 e do `obrigado.html`.
> É a mesma régua do relatório mensal (048): **pode prometer o que não gera
> trabalho recorrente; não pode prometer o que vira tarefa do dono, todo mês,
> pra todo cliente.** A peça incluída estava no Essencial, que é o de R$ 99 e
> o que mais vende — trinta clientes seriam trinta artes na mão dele. Serviço
> que dá trabalho de verdade tem preço; não vira brinde escrito no card.

**RN-46 — Exibição confirmada tem TETO, e a virada da hora tem folga.**
*(Itens 26 e 29, fechados em 17/09/2026.)* `POST /played` somava sem limite:
qualquer reenvio da TV — retentativa depois de queda de rede, recarregar a
página, player reiniciando — contava a mesma exibição de novo. Não é o plano
entregando a mais, é o COMPROVANTE ficando falso, e o comprovante é o que se
entrega a quem pagou. O teto é `vezes_programadas`, que é o que aquela hora
prometeu. Reenvio depois do teto responde 200 com `contou:false`, não erro:
400 faria o player tentar em laço e encheria o log com o funcionamento
normal. **A folga:** a peça que começa às 13h59m50s termina depois das 14h, e
o `played` dela chega numa hora que não é a dela. Nos primeiros 15 minutos, a
confirmação que não couber na hora corrente é creditada à anterior — a regra
do dono, "não pode passar de 1 hora, mas se passar alguns minutos, aí sim
pode deixar passar". Sem ela, uma exibição REAL virava déficit, e a hora
seguinte repunha: atraso de segundos virava exibição a mais no dia seguinte.
*Violada:* não há caminho. *Quem vê:* o anunciante, no comprovante.

**RN-47 — Tela sem rede mostra só a Mostraí.** *(Item 25, decisão do dono.)*
O player guarda a playlist em cache pra atravessar queda curta. Passada uma
hora sem falar com o servidor, ele para de exibir anúncio e fica só na peça
institucional — que agora traz telefone e QR code pro site. Dois motivos que
não aparecem olhando a TV: nenhuma exibição consegue ser confirmada, então o
anunciante roda de graça e o comprovante dele fica menor que a entrega; e a
lista em cache envelhece — conta vencida, peça reprovada, plano trocado — e a
tela passa a exibir anúncio que o cliente já não paga. A peça avisa que é a
conexão, não o aparelho, senão o dono do ponto liga achando que a TV quebrou.
*Violada:* não há caminho. *Quem vê:* quem está na frente da TV.

**RN-48 — O teto de criativos é 3, e quem recusa é a gravação do plano.**
*(Item 27.)* O gerador já cortava a rotação em 3, mas só ele: o admin tinha
`max="3"` no input (validação de navegador e nada mais) e nenhuma rota
conferia. Plano criado com 5 pela API era aceito, vendido com 5 na vitrine, e
a tela rodava 3 — sem aviso, porque o corte era silencioso no fim da linha.
Agora o número mora em `src/lib/limites.js` e quem recusa é
`planos-repository`, antes de gravar, com o motivo na mensagem. O corte no
gerador fica como última defesa. *Violada:* a rota devolve 400 com o teto.
*Quem vê:* o administrador, ao criar ou versionar um plano.

**RN-50 — A resposta de `consultar-assinatura` tem duas metades, e as duas
são lidas.** *(Atualização do San Checkout, 16/09/2026, adotada aqui em
17/09.)* `status` diz se o VÍNCULO existe (`ativa`/`pausada`/`cancelada`);
`ultimaCobranca` diz se o último CICLO entrou. A conciliação lia só a segunda
e jogava a primeira fora, e isso abria dois buracos de dinheiro:

· **Assinatura encerrada fora do nosso fluxo nunca chegava.** Cancelada no
  painel da Asaas, ou morta por ela depois de falhas seguidas, não gera aviso:
  o Checkout mediu em 16/09 que há **zero eventos `SUBSCRIPTION_*` entre os 53
  configurados** na Asaas. Esta rota é o único caminho. O anunciante seguia
  `ativa` aqui, rodando anúncio de graça, sem nada acusar.
· **Ciclo falhado sem o webhook `cobranca_falhou`** — que é justamente o aviso
  que se perde (fila de retry em memória do Checkout, reinício do processo). O
  anunciante nunca soube que precisava trocar o cartão, e a cobertura vencia.

A decisão mora em `decidirPorEstado` (`src/financeiro/conciliacao.js`), pura e
sem banco. O vínculo é avaliado ANTES do ciclo: assinatura encerrada não tem
ciclo a creditar, por mais confirmada que esteja a última cobrança. Status
desconhecido (o Checkout promete adicionar valores novos) conta como vínculo
não-ativo e vira evento, mas **não** cancela o registro por conta própria.
Resposta ausente (404) é "não sei", nunca "cancelada". *Violada:* não há
caminho de usuário. *Quem vê:* o admin, na aba de Eventos.

**RN-51 — O link de renovação vai assinado, ou não vai.** *(Mudança
incompatível do San Checkout, API.md 7.3, 16/09/2026.)* `&renovar=1` deixou de
valer: o `renovar` agora é um HMAC-SHA256 da nossa `SAN_CHECKOUT_KEY` sobre
`{timestamp}.{contratanteId}.{assinaturaId}.{documento}`. O motivo é um achado
grave do lado dele — CPF/CNPJ não é segredo, e quem soubesse o documento de um
assinante ativo montava o link, pagava com o próprio cartão e, ao confirmar,
fazia o Checkout cancelar a assinatura de verdade da vítima.

Duas armadilhas, as duas silenciosas:
· **Token que não bate não dá erro.** O Checkout degrada para "assinatura nova
  comum": cria, cobra e NÃO cancela a antiga — o cliente passa a ter duas
  assinaturas na Asaas. Por isso, sem chave ou sem documento,
  `linkRenovarAssinatura` devolve `null` e o e-mail sai **sem link**, pedindo
  contato. Link sem token é pior que link nenhum.
· **O documento entra no HMAC só com dígitos**, e de propósito NÃO pelo nosso
  `limpar()`: a pop-up do Checkout manda `documento.replace(/\D/g, '')` e é
  contra isso que ele confere. O nosso `limpar()` preserva letras, porque CNPJ
  é alfanumérico desde julho de 2026 — usá-lo aqui faria o token nunca bater
  para empresa com letra no CNPJ, e o sintoma seria cobrança dobrada, não erro.

*Violada:* não há caminho de usuário. *Quem vê:* o anunciante, no e-mail de
cobrança falhada; e o admin, na pendência, que diz qual dos dois casos ocorreu.

**RN-52 — Trocar de plano é uma chamada síncrona, não mais um pedido avulso.**
*(Rota nova do Checkout, `POST /trocar-plano`, 17/09/2026.)* Até aqui,
upgrade/downgrade eram um "pedido avulso": um link de pagamento fora do
ciclo, confirmado por webhook, tarde e às vezes nunca. Agora
`POST /anunciantes/me/trocar-plano` chama a rota nova do Checkout na hora:
ele cobra o acerto proporcional no cartão salvo ANTES de mudar o plano (se a
cobrança falha, nada muda), e devolve o resultado na mesma resposta — sem
redirecionar, sem pop-up.

Cada linha de `assinaturas` é o `planoId` que o Checkout usa pra nos
perguntar preço (`GET /plano/:id`) — trocar de plano não é UPDATE na linha,
é uma linha NOVA. A antiga fica com `status='trocada'` (não `'cancelada'` —
a assinatura na Asaas é a mesma, só o valor mudou), a nova nasce com
`status='pendente_troca'` até o Checkout confirmar, e só vira `'ativa'`
depois do 200. Se o Checkout devolve erro, a linha pendente é apagada e nada
mais muda.

A partir da troca, o `planoId` do assinante é o da linha NOVA — qualquer
ação depois (cancelar, pausar, retomar, consultar, link de renovação) usa o
id novo. `pedidosRepo.criar` e o link de checkout do pedido avulso saem de
uso pra troca de plano; o histórico de pedidos antigos e o webhook que os
fecha continuam lidos, só não crescem mais por essa porta.

Downgrade nunca cobra e nunca devolve — o preço novo só vale no próximo
vencimento, mas o valor da assinatura na Asaas já muda na hora. *Violada:*
não há caminho de usuário — a rota ou confirma os dois lados (Checkout e
nosso banco) ou desfaz a linha pendente e devolve erro. *Quem vê:* o
anunciante, no painel, ao confirmar a troca; e o admin, na aba "Trocas de
plano".

> Downgrade sem cobrança não gera `cobrancas_confirmadas`, e a aba do admin
> lê troca por essa tabela (`plano_anterior_id`, migration 059) — uma troca
> pra plano mais barato não aparece na lista, mesma limitação que o pedido
> avulso sempre teve com downgrade. Registrado, não corrigido.

**RN-53 — Banco de horas: quem não coube este mês tem prioridade no
próximo.** *(Pendência G.3, `docs/PENDENCIAS.md` — o mecanismo é decisão do
dono; a unidade e o prazo da válvula, abaixo, não foram.)* Quando a hora
está vendida além do que a rede aguenta, o corte proporcional da RN-30 sobra
pra todo mundo igual — mas quem sempre sobra é sempre o mesmo. Agora a
diferença entre o que o anunciante pediu (`vezes_pedidas`, novo, guarda o
pedido ANTES do corte) e o que ele recebeu (`vezes_programadas`) fecha em
saldo no fim do mês anterior (`apurarMesAnterior`), e esse saldo entra como
prioridade extra na próxima geração de playlist.

**Dívida mais velha, prioridade maior — pedido do dono, 18/09/2026: "quanto
mais tempo no banco tiver, mais prioridade tem", pra tentar drenar antes de
bater a válvula.** O teto (antes fixo em "nunca mais que dobrar o pedido
normal") agora cresce com a idade da linha mais antiga ainda ativa: dobra
pra dívida deste mês e sobe até `MULTIPLICADOR_MAXIMO_BANCO` (3, número meu)
vezes o pedido normal conforme ela se aproxima dos
`MESES_PARA_FILA_DE_CREDITO` (3) meses da válvula. Verificado ao vivo: a
mesma dívida de 10 exibições, com 1 mês de idade, entregou 10 no total (4
normais + 6 de prioridade); com 3 meses, entregou 16 (4 + 12) — dobra e
depois quase triplica o que a dívida nova ganhava.

A unidade é EXIBIÇÃO, não segundo: a duração do criativo hoje
(`criativos.duracao_segundos`) é o valor ATUAL, sem histórico — calcular em
segundos seria estimar sobre estimativa. Escolha minha, não pedida por ele
nestes termos.

O saldo drena por ordem de idade (mês mais antigo primeiro, `FOR UPDATE` pra
não drenar duas vezes a mesma linha em paralelo) e só proporcionalmente ao
quanto a hora sobrou pra ele: se a hora ainda corta, uma parte do saldo fica
pra próxima. Conta própria (`conta_propria`) nunca acumula banco — não paga,
não tem o que compensar.

O saldo é da conta, não da tela — mas a playlist é gerada uma tela por vez, e
quem cobre vários pontos gera a hora em paralelo em cada um. Sem dividir, o
mesmo saldo dava prioridade cheia em CADA ponto, e uma conta em 2 pontos
pagava 1 de dívida e recebia o dobro de volta. A prioridade da hora divide o
saldo pelos pontos cobertos (mesma fatia que a RN-49 já usa pra ratear
segundos) antes de aplicar o teto — o dono nunca falou desse caso; é
inferência de como o resto do motor já resolve o mesmo problema.

**Uma peça nunca roda duas vezes seguidas** (pedido do dono, 18/09/2026),
prioridade boostada ou não — `espalhar` (`src/lib/pacing.js`) procura vaga
livre SEM vizinho do mesmo anunciante antes de aceitar qualquer vizinho
igual; só aceita quando não sobra alternativa (um anunciante tomando quase
a hora inteira), e mesmo aí a entrega nunca é cortada por causa disso — o
que muda é só a ordem.

**A prioridade PODE tomar o lugar de outro anunciante na mesma hora — de
propósito, e sem perda pra quem cedeu.** O dono confirmou: não precisa se
limitar ao espaço vago da hora. Quando isso corta quem não tem dívida
nenhuma, o RN-30 já registra a diferença (`vezes_pedidas` maior que
`vezes_programadas` DAQUELE anunciante, não só de quem furou a fila), e a
apuração do mês seguinte credita ESSE déficit no banco de horas de quem
cedeu — o mesmo mecanismo, fechando o ciclo sozinho. Nenhum código novo
precisou entrar pra isso: é a mesma conta que já fecha o mês de qualquer
corte por hora vendida.

Saldo que não drena em `MESES_PARA_FILA_DE_CREDITO` (3, prazo meu — o dono
nunca fixou um número) meses vira `status='aguardando_credito'`: uma fila
que o admin decide, nunca um crédito automático — nenhuma linha desta
feature move dinheiro ou desconta fatura por conta própria. *Violada:* não
há caminho de usuário. *Quem vê:* o anunciante, no painel, quando tem saldo
ativo; e o admin, na aba "Banco de horas", incluindo a fila de decisão.

**RN-55 — Ponto que cruza 80% da hora vendida para de aceitar escolha
nova.** *(G.7, `docs/PENDENCIAS.md` — pedido do dono, 18/09/2026; os dois
números abaixo são leitura minha de um pedido falado, não confirmados
nestes termos.)* "Ocupação" é a soma de `planos.segundos_por_hora` de toda
conta associada ao ponto (`anunciantes_pontos`) — SEM a compensação da
RN-49, de propósito: aqui a pergunta é o que já foi prometido, não o que
cada um recebe depois de redistribuir o que falta. Ao cruzar 80%
(`LIMITE_OCUPACAO_BLOQUEIA`), o ponto marca `escolha_bloqueada_em`
sozinho — e esse bloqueio é STICKY: não sai só porque a ocupação caiu
depois (uma conta saindo não deve reabrir a vaga sem alguém olhar antes).

O bloqueio é só pra escolha NOVA — nem escolha explícita
(`PUT /anunciantes/me/pontos`) nem o sorteio automático
(`pontosDoAnunciante`, quem não escolheu nada) oferecem um ponto travado.
Quem JÁ estava lá — escolhido antes, ou já caído no sorteio antes de
travar — continua normalmente: o bloqueio nunca tira cobertura de ninguém,
só impede alguém novo de entrar.

Só o admin libera (`POST /admin/pontos/:id/liberar-escolha`), e só quando
sobra `FOLGA_MINIMA_PARA_LIBERAR_SEGUNDOS` (15 minutos) de espaço real —
sem essa folga, o próximo anunciante a cair ali reblocaria o ponto minutos
depois de liberado, e o clique não teria significado nenhum. *Violada:*
não há caminho de usuário — a escolha (manual ou automática) recusa antes
de gravar. *Quem vê:* o anunciante, na tela de escolha de pontos (com o %
de ocupação de cada um); e o admin, na aba "Ocupação dos pontos".

**RN-56 — Seis momentos da conta avisam por e-mail, sempre fire-and-forget.**
*(Pedido do dono, 18/09/2026 — completa a lista que já existia: pagamento
confirmado, cobrança falhada, cobertura acabando, candidatura nova,
aprovação/reprovação de criativo, RN-18/RN-36.)* Os quatro que faltavam:
conta criada (no cadastro — só quando o papel inclui 'anunciante': o texto
fala em escolher plano e subir anúncio, e não faz sentido pra quem entrou
só como vendedor ou dono de ponto por convite), conta excluída (a pedido do
titular — RN-24/26, esse sim pra qualquer papel), troca de plano (RN-52,
com o valor do acerto se houve) e cancelamento de assinatura (self-service
ou pelo admin em nome do cliente — mesmo aviso nos dois casos). Nenhum
e-mail bloqueia a ação que o disparou: se o SMTP falhar,
a conta é criada, excluída, trocada ou cancelada do mesmo jeito — só o
aviso que não sai, e vira log de erro, nunca 500 pro usuário. *Violada:*
não há caminho de usuário — a ação sempre completa; o e-mail é efeito
colateral, nunca condição. *Quem vê:* o anunciante, na caixa de entrada.

**RN-54 — Contestação de cobrança suspende o acesso na hora.** *(API.md do
Checkout: "suspenda o acesso" — instrução explícita do lado dele, não
interpretação nossa.)* Até aqui, `cobranca_contestada` só virava pendência
genérica pro admin decidir depois. Agora o webhook marca
`anunciantes.suspenso = true` no mesmo golpe — a decisão de reativar (ou
não) continua sendo do admin, mas o acesso já para antes dele olhar, porque
contestação é o único dos sete eventos que aponta fraude ou disputa em
andamento, não simples atraso. *Violada:* não há caminho de usuário. *Quem
vê:* o anunciante, que perde acesso ao painel; e o admin, na pendência, que
registra o motivo pra revisar antes de reativar.

**RN-49 — Enquanto a rede é menor que o plano, o tempo dos pontos que faltam
volta pros pontos que veiculam.** *(Decisão do dono, 17/09/2026.)* O plano
vende N pontos. Com a rede menor que N, o anunciante recebia menos do que
pagou e em silêncio — e quem pagava mais perdia mais: o Prime, que cobre 10,
ficava com metade do contrato numa rede de 5, enquanto o Essencial, que cobre
3, recebia tudo. Agora os segundos por hora em cada ponto viram
`base × (pontos do plano ÷ pontos cobertos)`, com teto de um sexto da hora por
anunciante. O TOTAL contratado não muda — só se concentra: Pro (120s × 7) numa
rede de 5 vira 168s em cada um dos 5, 840s de qualquer jeito. É a mesma venda
entregue no inventário que existe, não um brinde.

"Pontos cobertos" é quantos pontos EM OPERAÇÃO entram na fatia dele hoje. Ponto
com status `a_instalar` conta como vaga do plano — o anunciante pode escolher
ele e não perde o lugar no comércio que está sendo montado —, mas não veicula,
e é por isso que ele entra no numerador e nunca no denominador.

O teto existe porque sem ele a conta explode justamente quando ela mais roda:
Prime numa rede de 1 ponto pediria 1800s, metade da hora daquela tela pra uma
conta só, e o corte proporcional da RN-30 passaria a comer o de todo mundo,
inclusive o dele. Um sexto é onde a promessa ainda se cumpre — seis contas
compensadas enchem a hora, e antes disso ninguém é cortado. Acima do teto o
anunciante para de ganhar; nunca perde o que já tinha.

A conta vive em `segundosCompensados` (`src/lib/pacing.js`) e é usada nos dois
lugares que precisam concordar: o gerador da playlist e o painel do anunciante.
*Violada:* não há caminho de usuário — a função nunca devolve menos que o
contratado. *Quem vê:* o anunciante, no painel, com o número exato de horas a
mais; e a vitrine, no aviso de rede em montagem.

**RN-38 — O dia da exibição é o dia de Matão, não o do servidor.** O
agrupamento por dia de `exibicoes_contador` converte `janela_hora` para
`America/Sao_Paulo` ANTES de cortar o dia, e devolve dia de calendário puro
(`::date`), que os formatadores dos dois lados tratam sem fuso. Sem isso o
corte acontecia em UTC e tudo o que rodava antes das 21h caía no dia anterior
— inclusive no comprovante de veiculação em CSV, que é o papel que prova a
entrega pra quem pagou. *Violada:* não há caminho de usuário. *Quem vê:* o
anunciante (gráfico e CSV) e quem abre o painel na própria TV.

**RN-11 — O preço de quem assinou é o da VERSÃO que ele assinou.** Não existe
mais trava de preço por conta: a proteção é a imutabilidade do contrato
(RN-27). Editar preço ou benefício publica uma versão nova do plano; a conta
continua apontando para a versão antiga, e é o `valor_mensal` dela que a
renovação cobra. O valor só muda se o próprio anunciante trocar de plano.
*Violada:* não há caminho. *Quem vê:* o anunciante, na fatura.
> `planos.preco_travado` e `anunciantes.valor_mensal_travado` saíram na
> migration 046, autorizados pelo dono em 17/09/2026. A trava carregava um
> defeito medido na mesma data: `aplicarCicloPago` decidia por
> `anunciante.plano_id === plano.id`, então migrar a conta para a versão nova
> de um plano REESCREVIA a trava com o preço novo — o contrário exato do
> direito que ela prometia. Saiu junto o rótulo "Preço fundador, nunca muda",
> que 9 dos 12 planos exibiam na vitrine.

**RN-12 — Comissão do vendedor é gerada a cada cobrança confirmada**, inclusive
renovação, no percentual da conta dele — **confirmado pelo dono em
15/09/2026: mantém**. O percentual é do VENDEDOR (`vendedores.comissao_percentual`),
não do plano, então troca de plano de quem ele indicou nunca muda a comissão.
O dono define o valor entre **10% e 30%** (migration 035); fora da faixa a
rota recusa. *Violada:* não há caminho. *Quem vê:* vendedor e administrador.

**RN-13 — Troca de plano de quem já paga é recusada.** O sistema manda falar
com o administrador, para evitar cobrança dupla na Asaas. O caminho é cancelar
e assinar de novo. *Violada:* mensagem na tela. *Quem vê:* o anunciante.

**RN-14 — Parceiro é status de conta, marcado à mão pelo administrador**
(migration 033, 15/09/2026; renomeado de "fundador" pra "parceiro" e
absorvido pelo `status` na migration 038, 16/09/2026 — ver RN-35) — não é
plano de catálogo, nem trava por variável de ambiente (isso deixou de fazer
sentido quando RN-27/item 9 passou a travar o preço de QUALQUER plano
assinado). A conta com `status = 'parceiro'` ganha um desconto percentual —
definido pelo administrador, por conta — nos planos que ele liberar (piso de
compromisso em meses, ex.: só trimestral pra cima). Fora do piso, a
assinatura é recusada. *Violada:* "esse plano não está liberado para conta
parceira". *Quem vê:* o anunciante.

**RN-32 — Desconto de comodato por plano (item 8 da spec).** Conta com papel
`ponto` (comodato) recebe o desconto que o administrador definiu pra aquele
plano de anunciante especificamente (`planos.desconto_comodato_percentual`,
campo de contrato — só muda por versão nova). Some com o desconto de
parceiro, se a conta tiver os dois. *Violada:* não há caminho — o desconto
já sai no preço. *Quem vê:* o anunciante, no valor cobrado pelo San Checkout.

**RN-33 — Vagas: qualquer plano pode ter teto (campo `vagas`), sem vaga o
plano some da vitrine.** Uma assinatura sem cobrança confirmada solta a vaga
sozinha depois de 15 minutos (decisão do dono, 15/09/2026 — era 7 dias).
*Violada:* "as vagas desse plano acabaram". *Quem vê:* o anunciante.

**RN-34 — Não existe aprovação de conta.** *(Decisão do dono, 15/09/2026, a
partir da observação de que uma conta conseguia pagar um plano antes de ser
aprovada.)* A conta nasce liberada, por convite ou pelo cadastro aberto — o
painel abre na hora, sem esperar ninguém. O único portão que resta é o do
**criativo**: a peça enviada precisa ser aprovada pelo administrador antes
de entrar na playlist (RN do módulo de criativos). *Violada:* não há
caminho — pagar já ativa a conta, como sempre ativou. *Quem vê:* o
anunciante, no acesso imediato ao painel. *(Nota de 16/09/2026: o valor
`pendente_aprovacao`, que esta RN dizia continuar válido no banco só por
compatibilidade, foi removido de vez na migration 038 junto com o resto do
domínio antigo de `status` — ver RN-35. Não havia nenhuma conta usando esse
valor.)*

**RN-35 — `status` da conta virou só comum/parceiro; o que bloqueia é
`suspenso`.** *(Decisão do dono, 16/09/2026, na rodada de depuração: "o
status de aprovado pendente e ativo continuam no status do cliente" — pedido
pra simplificar.)* Antes, `anunciantes.status` misturava dois sentidos que
não tinham nada a ver um com o outro: um rótulo comercial (parceiro/fundador,
RN-14) e um estado operacional (se a conta podia logar e veicular — herdado
do modelo antigo de aprovação, RN-34, que já não fazia sentido desde então).
Agora são dois campos: `status` (`comum` ou `parceiro` — só rótulo, nunca
bloqueia nada) e `suspenso` (booleano — bloqueia login em `/anunciantes/:id/
assinar`, some da playlist, e é ligado automaticamente pela conciliação
diária quando a cobertura vence, ou desligado na hora em que uma cobrança é
confirmada ou um plano é liberado). O gate real de veiculação continua sendo
o do **criativo** (RN-34) — `suspenso` é sobre a CONTA, não sobre o anúncio.
*Violada:* "conta suspensa — fale com o suporte antes de assinar". *Quem
vê:* o anunciante (painel e perfil) e o administrador (coluna "Suspensa" na
aba Anunciantes, separada da coluna "Status").

**RN-36 — Cobertura sem recorrência avisa por e-mail 7 dias antes de
acabar.** *(Seção F, item 16, 16/09/2026.)* Quem troca de plano paga um
**pedido avulso**, não uma assinatura: a cobertura vale pelo período
contratado e some sozinha, porque não há próxima cobrança pra acontecer. A
conciliação diária varre as contas ativas que vencem nos próximos 7 dias e
**não têm assinatura ativa**, e manda um e-mail convidando a contratar de
novo (`enviarCoberturaAcabando`). Quem tem assinatura fica de fora: pra esse
o motor cobra sozinho, e se a cobrança falhar quem avisa é
`enviarCobrancaFalhou` (RN-24). Conta em cortesia e conta já suspensa também
ficam de fora. O aviso é marcado em `anunciantes.aviso_fim_cobertura_para`
guardando PARA QUAL expiração ele saiu, não como booleano: expiração nova
(outra troca, ou um plano assinado) é valor diferente e rearma o aviso
sozinho, sem rotina de limpeza. A marca só é gravada DEPOIS do envio, então
falha de SMTP não vira aviso que nunca sai. *Violada:* não há caminho de
usuário. *Quem vê:* o anunciante (e o administrador, no contador da
conciliação na Visão geral).

**RN-37 — Mensagem do formulário de contato é uma fila com dono, não um
e-mail que talvez chegue.** *(Segunda passada da furos.md, 16/09/2026.)* Todo
envio de `/contato` é GRAVADO em `mensagens_contato` antes de o e-mail ser
tentado (migration 039) e aparece na aba **Mensagens do site** do admin, com
`email_enviado` dizendo se o aviso chegou na caixa de entrada: quando é
`false`, essa tela é o único lugar onde a mensagem existe. Fica na fila (com
contador no menu) até alguém marcar `respondida_em` (migration 044). A fila
existe porque `/contato.html` é o canal declarado de pedido do titular de
dados (LGPD art. 18), que tem prazo legal pra resposta — depender de alguém
lembrar de abrir a caixa de e-mail não é procedimento. *Violada:* não há
caminho de usuário; do lado de quem escreveu nada falha. *Quem vê:* o
administrador.

**RN-15 — Exclusão de conta é soft-delete de 60 dias.** A conta some do sistema
na hora; o suporte pode reverter dentro de 60 dias. Não há tela de desfazer.
*Violada:* conta excluída não loga. *Quem vê:* quem excluiu.

**RN-16 — Limite de 10 tentativas por 15 minutos, por IP e rota.** Vale para
login, admin e redefinição. Reinício do servidor zera (é em memória).
*Violada:* "muitas tentativas, tente mais tarde". *Quem vê:* quem tentou.

**RN-22 — A peça é feita fora do site e sobe direto na conta do cliente.** Não
existe editor de anúncio no sistema. Quem não tem arte pede pelo WhatsApp, a
partir do painel: **anúncio simples é incluído no plano**; **gravação de vídeo é
serviço de produtora parceira, orçada à parte**. Nos dois casos a reunião e o
fechamento acontecem na conversa, e o resultado sobe pelo admin. Criativo que o
operador sobe entra **já aprovado** (quem aprovaria é quem acabou de subir) e
fica marcado em `editado_pelo_operador`, para ninguém cobrar do anunciante um
vídeo que o Mostraí montou. *Violada:* conta inexistente responde 404; o teto de
criativos do plano continua valendo nas contas de cliente. *Quem vê:* o
administrador.

**RN-23 — O admin pode liberar um plano de graça (cortesia).** Põe a conta no
ar sem criar assinatura nem cobrança: o San Checkout não fica sabendo, nada é
cobrado agora nem na renovação, e a cobertura simplesmente vence na data. A
conta em cortesia **não trava preço** — acabada a cortesia, ela assina pelo
valor da vitrine. O resumo do admin separa `anunciantesAtivosPagantes` de
`anunciantesEmCortesia`, porque "5 ativos" com três liberados de graça é a
leitura errada do número que mais importa. *Violada:* liberar cortesia por cima
de plano pago ativo responde 409 — cancele a assinatura antes, senão a
cobertura comprada seria apagada e pareceria um upgrade. *Quem vê:* o
administrador, com o motivo registrado na própria linha.

**RN-21 — O Mostraí tem uma conta de anunciante própria, e só uma.** Ela vive
no admin, em "Meus anúncios": anuncia a rede nas telas da rede. Difere de uma
conta comum em três pontos e só neles — não assina plano (a cota vem de
`frequencia_hora_propria`, e ela é o ÚNICO lugar que ainda conta em
repetições e não em segundos: sem plano, `segundos_por_hora` é nulo e o
gerador cai na ponte da RN-39), não tem teto de criativos, e nunca gera cobrança,
então não entra na receita nem na margem. Difere também da cota de autoanúncio
do ponto, que só roda nas telas daquele comércio: a conta própria roda na rede
inteira. *Violada:* tentar criar a segunda recebe 409 antes de qualquer
inserção, e o índice único do banco é a última defesa. Conta comum **não pode**
se marcar como própria — a marca não existe no caminho de cadastro, só na
rota do admin. *Quem vê:* o administrador.

**RN-18 — O anunciante é avisado quando o vídeo entra no ar, ou quando
precisa de ajuste.** Na transição do criativo para `aprovado` — e só na
transição —, sai um e-mail dizendo que ele está na playlist; na transição
pra reprovado, sai um e-mail explicando o motivo (`criativo.motivo_reprovacao`)
e como reenviar. Salvar de novo um criativo que já passou por uma dessas não
reenvia. *Violada:* nada acontece; a aprovação não depende do e-mail. *Quem
vê:* o anunciante, na caixa de entrada.

**RN-19 — O comprovante de veiculação respeita o período escolhido.** O CSV
sai com `;` e BOM UTF-8, porque o Excel em português com vírgula junta tudo
numa coluna e come os acentos. Período aceito: de 1 a 365 dias; fora disso é
limitado, não recusado. *Violada:* conta diferente da própria recebe 403.
*Quem vê:* o anunciante.

**RN-20 — O pagamento ao ponto é um lançamento por ponto por mês.** Lançar o
mesmo mês de novo atualiza o valor em vez de criar outro — é o que impede pagar
duas vezes por duplo clique no admin. Enquanto `pago_em` é nulo, a linha está
em aberto. *Violada:* o banco recusa pela chave única. *Quem vê:* o dono do
ponto, no extrato; o administrador, na lista do ponto.

**RN-24 — O titular baixa os próprios dados sem pedir a ninguém.**
`GET /titular/meus-dados` devolve, num JSON só, a conta e tudo que ela gerou —
pontos, telas, criativos, assinaturas, cobranças, comissões nas duas pontas,
exibições, pagamentos recebidos como ponto, candidaturas. Não inclui senha nem
chave/PIN de aparelho: isso é credencial, não dado do titular, e exportar hash
só ajuda quem roubar o arquivo. *Violada:* não há caminho automático — a rota é
uma leitura. *Quem vê:* o próprio titular, no perfil.

**RN-25 — Só se revoga o que é consentimento.** Comunicação de novidade e
oferta depende de consentimento e se desliga a qualquer tempo; o contato do
responsável e a foto são opcionais e se apagam na hora. Nome, documento,
endereço e histórico de cobrança têm outra base legal — execução de contrato e
obrigação fiscal — e não se revogam isoladamente: saem junto com a conta. A
trava da comunicação mora no remetente (`enviarNovidade`), não em quem chama.
*Violada:* uma mensagem de divulgação que não passe por `enviarNovidade`.
*Quem vê:* o titular, no perfil; o administrador, na coluna
`comunicacoes_revogado_em`.

**RN-26 — Arrependimento em 7 dias devolve tudo, e o prazo conta da primeira
cobrança confirmada.** É o art. 49 do CDC, e a venda é a consumidor à
distância. O botão só existe dentro do prazo. Ao pedir: a assinatura é
cancelada no San Checkout **antes** de qualquer mudança aqui (se falhar, nada
muda e a pessoa tenta de novo), a conta é suspensa e o anúncio sai do ar na
hora, e o valor **integral** já pago vira um pedido de devolução na fila do
admin — não há pró-rata pelos dias em que o anúncio rodou, o direito não é
proporcional. O estorno em si é executado no painel do Checkout/Asaas, porque a
API dele não expõe estorno; o admin registra o comprovante pra fechar o pedido.
*Violada:* o índice único barra um segundo pedido em aberto por conta.
*Quem vê:* o titular, no perfil; o administrador, na aba Devoluções e no alerta
da visão geral.

**RN-27 — Plano assinado é imutável para quem assinou.** Os campos do plano
se dividem em dois. **Vitrine** (`ativo`, `vagas`, `rotulo`,
`destaque_no_site`) muda na hora: não alcança ninguém que já é cliente.
**Contrato** (`tier`, `nome`, `valor_mensal`, `valor_mensal_cheio`,
`compromisso_meses`, `segundos_por_hora`, `duracao_maxima_segundos`,
`pontos_incluidos`, `cobertura`, `limite_criativos`, `fundador`,
`desconto_comodato_percentual`, `desconto_percentual`, benefícios) não se
edita: publica-se uma **versão nova**, com id novo, e a anterior é aposentada.
A lista viva está em `CAMPOS_CONTRATO` (`src/financeiro/planos-repository.js`).
Quem já assinou fica na versão antiga — mesmo preço, mesmo tempo de tela,
mesmos pontos, mesmos benefícios, mesmo limite de criativos. Id novo é obrigatório porque o San Checkout guarda a assinatura
pela chave `planoId` + `documento` (`API.md` 4.2): duas versões com o mesmo
id tornariam cancelamento e conciliação ambíguos. O Checkout já congela
`valor` e `ciclo` na criação e nunca reconsulta o plano — o que faltava era o
que o Mostraí lê ao vivo. *Violada:* `PATCH` com campo de contrato responde
409 dizendo qual campo e qual é o caminho; o banco recusa plano aposentado e
ativo ao mesmo tempo. *Quem vê:* o administrador, na aba Planos (o botão
"Publicar nova versão" só acende quando um campo de contrato muda) e na aba
Planos arquivados, que mostra quantas contas ativas cada versão ainda tem.

**RN-28 — Tela fora do ar não recebe playlist nem conta exibição.** Chave de
aparelho certa não basta: se a tela está em `reparo`/`inativo`, ou se o ponto
dela saiu do ar, `GET /playlist/:id` responde 403 e o player para de tocar o
cache e escreve o motivo na própria TV. Sem isso o anunciante pagava por
exibição numa tela que a operação já sabia que não estava no ar. *Violada:*
não há caminho — a guarda é o próprio `exigirAparelho`. *Quem vê:* o operador,
na TV; o anunciante, no painel, porque a exibição simplesmente não é contada.

**RN-29 — Reprovar criativo exige motivo, e o motivo chega ao anunciante.**
O admin não reprova sem escrever por quê; o motivo aparece no card da peça no
painel do anunciante, junto do que fazer (excluir e subir a versão corrigida),
e sai por e-mail. *Violada:* a tela não deixa reprovar com o campo vazio.
*Quem vê:* anunciante e administrador.

**RN-30 — O orçamento da hora corta proporcionalmente.** Quando a soma do
tempo contratado passa dos 3600 segundos, cada anunciante perde a mesma fração
do que pediu — medida em SEGUNDOS, pela regra dos maiores restos, sobre a
lista já embaralhada — em vez de o corte ser um sorteio que zerava a hora de
quem ficasse pra depois. O aperto vira evento `playlist:teto_corta`.
(Até 16/09/2026 o teto era de 200 slots; virou orçamento de segundos na
RN-09.)
*Violada:* não há caminho. *Quem vê:* o dono, na aba Métrica.

**RN-31 — Conta excluída não recebe ciclo.** A exclusão cancela a assinatura no
Checkout antes de marcar `excluido_em`; uma cobrança em trânsito que chegue
depois não credita cobertura nem paga comissão — vira pendência para alguém
devolver o dinheiro à mão. *Violada:* o webhook registra a pendência com o
motivo. *Quem vê:* administrador, em Eventos pendentes.

**RN-17 — Migrations são aditivas.** Drop de coluna ou tabela só com permissão
nominal do dono, em migration própria. Migration aplicada nunca é editada.
*Violada:* não há caminho automático. *Quem vê:* administrador.

---

## 6. Textos que o sistema diz

| Onde | Texto |
|---|---|
| Botão de assinar | **Assinar plano** |
| Cadastro concluído | Conta criada! |
| Senha fraca | A senha precisa de 8 caracteres, uma maiúscula e um símbolo. |
| E-mail já cadastrado | Já existe uma conta com esse e-mail. Tente entrar ou recuperar a senha. |
| Convite usado | Este convite não vale mais. Fale com a gente para receber outro. |
| Fundador sem vaga | As vagas desse plano acabaram. |
| Troca de plano | Para trocar de plano, fale com a gente — evitamos cobrança duplicada. |
| Player sem chave | Tela não autorizada — fale com o Mostraí. |
| PIN errado | PIN incorreto. |
| Playlist vazia | *(tela institucional do Mostraí, sem texto de erro)* |
| Muitas tentativas | Muitas tentativas. Tente de novo em alguns minutos. |
| Erro genérico | Não conseguimos completar agora. Tente de novo em instantes. |
| E-mail de pagamento | Assunto: **Pagamento confirmado — Mostraí**. Corpo: o plano, o valor e até quando a cobertura vale. |
| E-mail de anúncio no ar | Assunto: **Seu anúncio está no ar — Mostraí**. Corpo: o vídeo foi aprovado e entrou na playlist, com o link do painel para acompanhar as exibições. |
| Extrato vazio | Nenhum pagamento lançado ainda. Assim que o primeiro mês for fechado, ele aparece aqui. |
| Exclusão de conta | Sua conta foi excluída. Você tem 60 dias para pedir a volta pelo nosso contato. |

---

## 7. Quando dá errado

| Situação | O que o sistema faz | O que a pessoa vê |
|---|---|---|
| San Checkout fora do ar ao assinar | não cria assinatura local órfã; devolve erro | "não conseguimos abrir o pagamento agora" |
| Webhook não chega | a conciliação diária encontra a cobrança e credita | nada — a conta ativa sozinha em até 24h |
| Cobertura de troca de plano perto do fim | a conciliação diária manda o aviso 7 dias antes (RN-36) | e-mail convidando a contratar de novo |
| Webhook chega duas vezes | dedupe por `chargeId|status`; o segundo não faz nada | nada |
| Webhook sem `chargeId` consultável | vira pendência, **não credita no escuro** | administrador vê na fila |
| Rede cai no meio do upload | o criativo não é criado; nada meio-gravado | "o envio falhou, tente de novo" |
| ffmpeg falha ao normalizar | o criativo fica pendente, sem entrar na playlist | "estamos processando seu vídeo" |
| Duplo clique em assinar | a segunda chamada encontra assinatura aberta e devolve o mesmo link | mesma tela de pagamento |
| Volta no navegador depois de pagar | a página de status consulta o Checkout | o estado real |
| TV sem internet | toca o cache e tenta a cada ciclo | o vídeo continua rodando |
| Chave de aparelho revogada | 401 na playlist | "tela não autorizada" |
| Migration falha no deploy | aborta o deploy; o container antigo continua | nada — o site não cai |
| Storage fora do ar | o vídeo não carrega; a playlist continua | tela institucional |

---

## 8. Direitos e obrigações que viram tela

Todos ficam no mesmo lugar: o bloco "Seus dados e seus direitos", dentro do
popup de perfil do painel — junto de "excluir conta", e não escondido numa
página de política que ninguém abre.

- **Exportar dados da conta** — `GET /titular/meus-dados`, baixa um JSON com
  tudo (RN-24).
- **Excluir conta** — existe, no popup de perfil do painel (RN-15).
- **Revogar consentimento** — `POST /titular/consentimento`: desliga as
  comunicações de divulgação, ou apaga os dados opcionais (RN-25).
- **Canal do titular** — `/contato.html`, que grava a mensagem e avisa por e-mail.
- **Confirmação da contratação** — e-mail de pagamento confirmado (seção 6).
- **Direito de arrependimento (7 dias)** — `POST /titular/arrependimento`
  (RN-26): cancela a cobrança, tira o anúncio do ar e abre a devolução na fila
  do admin.
- **Termos de uso e Política de privacidade** — as páginas existem; o conteúdo
  é revisado na Estação 7 (skill `legal`).

---

## 9. A métrica de sucesso e os eventos que a alimentam

**Métrica principal:** margem mensal real — receita confirmada menos ajuda de
custo aos pontos, menos amortização das telas, menos custos fixos. Definida na
Estação 1. É precursora de receita porque uma rede que cresce com margem
negativa quebra crescendo.

Convenção: `categoria:objeto_acao`, verbo no presente; propriedades
`objeto_adjetivo`.

| Evento | Onde é emitido | Propriedades | Pergunta que responde |
|---|---|---|---|
| `conta:cadastro_conclui` | **servidor** | `papel_inicial`, `veio_de_cupom` | quantos se cadastraram ontem? |
| `conta:aprovacao_recebe` | servidor | `papel_liberado`, `horas_ate_aprovar` | quanto tempo leva pra reinstalar uma conta suspensa? (não existe mais aprovação de conta nova, RN-34 — o caso real que sobra é este) |
| `plano:assinatura_inicia` | servidor | `plano_id`, `plano_ciclo`, `valor_cobrado` | quantos chegam ao checkout? |
| `pagamento:cobranca_confirma` | **servidor (webhook)** | `plano_id`, `valor_confirmado`, `ciclo_numero` | quantos pagaram ontem? — é a receita |
| `criativo:video_aprova` | servidor | `horas_ate_aprovar` | o vídeo entra no ar rápido? (é o mesmo gatilho do e-mail da RN-18) |
| `exibicao:video_toca` | **não vai para `eventos`** — ver abaixo | — | a entrega prometida aconteceu? |
| `tela:dispositivo_ativa` | servidor | `ponto_id`, `custo_aparelho` | a rede cresceu quanto? |
| `ponto:candidatura_aprova` | servidor | `bairro`, `ramo` | de onde vêm os pontos? |
| `comissao:vendedor_gera` | servidor | `vendedor_id`, `comissao_valor` | quanto a indicação custa? |
| `ponto:pagamento_quita` | servidor | `ponto_id`, `valor`, `competencia` | quanto a rede custou em ajuda de custo? |
| `conta:exclusao_pede` | servidor | `dias_de_vida`, `tinha_plano_ativo` | quem sai, e quando? |

Os três críticos — cadastro, exibição e pagamento confirmado — são **de
servidor**, nunca do navegador.

**Construído em 14/09/2026** (migration 027): tabela
`eventos(id, nome, anunciante_id, propriedades, interno, criado_em)`,
`src/lib/eventos.js` para emitir, `src/admin/metrica.js` com as três consultas
salvas e a aba **Métrica** no admin. Três decisões que a tabela acima não
dizia, e que precisam de motivo escrito:

1. **`usuario_id` virou `anunciante_id`.** É essa a tabela de gente do sistema
   — anunciante, dono de ponto e vendedor são papéis da mesma conta.
2. **`exibicao:video_toca` não vira linha em `eventos`.** `exibicoes_contador`
   já guarda isso agregado por hora, por tela e por anunciante, com
   programadas **e** confirmadas — estritamente mais do que a linha de evento
   carregaria. Uma linha por exibição seria a maior tabela do sistema,
   crescendo para sempre, para responder a mesma pergunta pior. Fica registrado
   como decisão, não como esquecimento.
3. **`conta:cadastro_conclui` também sai do cadastro feito pelo admin.** O
   negócio fecha por WhatsApp e o dono cadastra o cliente depois; deixar de
   fora furaria o funil justamente no caminho que mais vende. A propriedade
   `pelo_operador` separa os dois.

**Filtro de uso interno:** a coluna `interno` é decidida na hora do evento, não
depois — a conta própria do Mostraí (`conta_propria`) e as contas listadas em
`EVENTOS_CONTAS_INTERNAS`. Todas as três consultas filtram `NOT interno`.
Marcar depois seria tarde: o número já teria sido lido.

**As três consultas** (`GET /admin/metrica`): a margem mês a mês, que é a
métrica principal; o funil cadastro → aprovação → checkout aberto → pagamento,
onde a distância entre os dois últimos é a única perda que o banco sozinho não
mostra (assinatura abandonada não vira linha em lugar nenhum); e o tempo das
filas do dono, em mediana e pior caso — mediana porque uma conta esquecida por
duas semanas puxaria a média e esconderia que o resto sai no mesmo dia.

---

## 10. O que fica fora desta versão

Os vetos estão em `CONSTRAINTS.md`; o que fica para depois, com condição de
entrada, está em `docs/proximas-versoes.md`. Nada é repetido aqui.
