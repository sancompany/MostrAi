# Economia da rede: quantos anúncios cabem, quanto custa, quanto fatura

Pedido do dono (15/09/2026): a conta de quantos anúncios cabem por hora num
ponto, quanto cada ponto novo aumenta a capacidade, o faturamento de um ponto
"cheio" de anúncio, um desenho de sorteio entre pontos com 15 minutos de
folga por hora, e o custo por ponto e por hora ligado. Todo número aqui sai
do código que já roda (`src/lib/pacing.js`, `src/playlist/gerador.js`,
`src/admin/routes.js`) ou dos preços reais da grade (`planos` no banco) — não
é estimativa de mercado, é a régua que o próprio sistema usa hoje.

## 0. As três peças que sustentam toda conta daqui

- **Teto de segurança por tela, por hora: 200 exibições** (`LIMITE_SLOTS_PROGRAMADOS`,
  `src/lib/pacing.js`). O valor original da spec era **240/hora** — o código
  guarda essa história no comentário. 200 é a margem de segurança abaixo
  disso.
- **Duração do vídeo: 15 a 30 segundos** (regra do site, `planos.html` e o
  e-mail de confirmação de pagamento). É o que faz 240 não ser um número
  arbitrário: 3600s ÷ 15s = **240** exibições/hora se todo vídeo fosse o
  mínimo. Se todo vídeo fosse o máximo (30s), o teto físico real seria
  3600 ÷ 30 = **120**/hora. O software trava em 200 — dentro dessa faixa,
  puxado pro lado otimista.
- **Cobertura hoje é sempre "todos os pontos", pra qualquer plano.**
  `planos.cobertura` guarda a intenção (`um_ponto_dia`, `tres_pontos_dia`,
  `todos_pontos`), mas o gerador de playlist ainda não lê esse campo —
  todo anunciante ativo aparece em TODO ponto ativo, na frequência que
  contratou (`frequencia_hora`, por hora direto desde a migration 037). Isso
  já estava mapeado em `docs/catalogo-beneficios.md`, seção 2, e é a peça
  que muda a resposta da pergunta 2 e 4 abaixo.

## 1. Quantos anúncios cabem por hora, dentro de um ponto

O cálculo roda **por tela**, não por ponto (`gerarPlaylistDaHora` é chamado
uma vez por dispositivo). Um ponto com N telas multiplica a conta por N —
telas são independentes, cada uma com sua própria lista.

| | Por tela | Ponto com 2 telas | Ponto com 4 telas |
|---|---|---|---|
| Teto de segurança/hora | **200** | 400 | 800 |
| Teto físico otimista (vídeo de 15s) | 240 | 480 | 960 |
| Teto físico conservador (vídeo de 30s) | 120 | 240 | 480 |

Quanto disso é OCUPADO de verdade depende da demanda contratada. Desde a
migration 037 a frequência do plano é por hora, direta — sem conversão
nenhuma por horário do ponto (a função `horasAbertoPorDia` foi removida):

| Plano | Frequência/hora | ≈Exibições/dia (referência, 12h abertas) |
|---|---|---|
| Essencial | 3 | ≈36/dia |
| Destaque | 6 | ≈72/dia |
| Máximo | 12 | ≈144/dia |

Então, num ponto de 1 tela com o teto de 200/hora, cabem (por exemplo, se
fosse só um plano por vez): até **66 Essenciais**, ou **33 Destaques**, ou
**16 Máximos** simultâneos antes de a hora "apertar" e todo mundo levar corte
proporcional (`calcularPlaylist`, regra dos maiores restos — quem perde,
perde a mesma fração do que pediu, nunca zera um enquanto outro fica cheio).

## 2. Quanto cada ponto instalado aumenta a capacidade

**Achado central:** como cobertura é "todos os pontos" pra todo mundo hoje,
a demanda de cada anunciante **não se divide entre os pontos — se repete
inteira em cada um**. Isso muda a pergunta: instalar um ponto novo não tira
exibição de ninguém nos pontos que já existem (a demanda deles não migra
pro ponto novo); ele soma uma cópia inteira da grade atual de anunciantes
ativos.

Concretamente: com a rede tendo, hoje, um total de `frequencia_hora` somado
de todos os anunciantes ativos igual a **F** exibições/hora, cada ponto novo
(de 1 tela) passa a entregar **+F exibições/hora pra rede** — desde que F
caiba no teto de 200/hora do ponto. Se F já estiver perto do teto, o ponto
novo entrega até o teto e o resto vira corte proporcional, igual a qualquer
ponto saturado.

**O que isso NÃO faz:** não aumenta a receita. A mensalidade do anunciante é
pela rede inteira, não por ponto — instalar mais pontos não cobra mais dele
nem gera fatura nova. O que aumenta é o **alcance entregue pela mesma
assinatura** (mais lugares, mais exibições por real pago), que é o argumento
comercial pra reter e pra vender planos mais caros — não uma fonte de
receita direta.

## 3. Faturamento de "um ponto completo de anúncio"

Como a cobertura é da rede inteira, não existe estoque específico de um
ponto pra vender — a régua que sobra é um **teto teórico**: quanto os
anunciantes ativos, juntos, precisariam faturar pra encher os 200/hora
(2.400/dia, com 12h abertas) de **qualquer** ponto — e, pela mesma lógica da
seção 2, encher um enche todos ao mesmo tempo, porque é a mesma demanda.

| Mix (hipotético, só um plano) | Quantos cabem no teto diário | Faturamento mensal equivalente (ciclo 12m) |
|---|---|---|
| Só Essencial (36/dia) | 2.400 ÷ 36 ≈ **66** | 66 × R$ 79,20 = **R$ 5.227,20** |
| Só Destaque (72/dia) | 2.400 ÷ 72 ≈ **33** | 33 × R$ 159,20 = **R$ 5.253,60** |
| Só Máximo (144/dia) | 2.400 ÷ 144 = **16** (+ resto) | 16 × R$ 319,20 = **R$ 5.107,20** |

**Leitura:** os três tetos caem quase no mesmo lugar (R$ 5.100 a R$ 5.250) —
não é coincidência, preço e frequência crescem quase na mesma proporção
entre os planos. Ou seja: **o teto de faturamento antes de qualquer ponto
começar a cortar exibição fica em torno de R$ 5.200/mês**, seja qual for o
mix de planos que os anunciantes escolherem. Passar disso não perde
receita — passa a cortar exibição proporcionalmente pra todo mundo (o que
o evento `playlist:teto_corta` já registra).

## 4. Sorteio de anúncios entre pontos, com 15 minutos de folga

Isso só faz sentido de verdade no dia em que `cobertura` (`um_ponto_dia`,
`tres_pontos_dia`) virar código — hoje todo mundo está em todos os pontos, e
sortear "entre pontos" não teria o que decidir. É o item da seção 2 de
`docs/catalogo-beneficios.md`. Desenho proposto pra quando isso for
construído:

1. **Vaga por ponto.** Uma vez por dia, calcular quanto de cada ponto já
   está comprometido pelos anunciantes `todos_pontos` (que entram sempre) e
   quanto sobra, por hora (frequência já é por hora desde a migration 037,
   sem `horasAberto` no meio): `vaga_por_hora = 200 − Σ frequência_hora dos
   garantidos`.
2. **Encaixe guloso pelos restritos.** Para cada anunciante `um_ponto_dia`
   ou `tres_pontos_dia`, sortear entre os pontos elegíveis dando peso maior
   pra quem tem **mais vaga sobrando** — não sorteio puro, sorteio
   ponderado pela vaga. Isso maximiza o preenchimento: evita um ponto vazio
   enquanto outro já corta por excesso.
3. **Rodízio ao longo do tempo.** Guardar, por anunciante, a última vez que
   ele apareceu em cada ponto elegível, e dar preferência (não exclusividade)
   aos pontos visitados há mais tempo (ou nunca visitados) na próxima
   sorteio. Isso espalha o alcance do anunciante restrito pela cidade em vez
   de fixá-lo sempre no mesmo lugar.
4. **Onde este sorteio entra:** ele decide o **QUAL ponto**, uma vez por dia
   (ou por semana). O sorteio que já existe hoje dentro de `calcularPlaylist`
   (`embaralhar`) continua decidindo o **QUANDO**/em que ordem, dentro do
   ponto já escolhido, hora a hora. São duas decisões em camadas diferentes,
   não uma reforma do pacing atual.
5. **Os 15 minutos de folga.** *(Definição do dono, corrigida em 16/09/2026:
   os 15 minutos NÃO são inventário reservado — são **tolerância** pra
   absorver um transbordo ou outro na hora total. A hora inteira continua
   vendável. A versão anterior deste item dizia "reservar os primeiros 15
   minutos", e era leitura minha, não dele.)*
   Hoje a hora é um bloco rígido (`horaAtual.setMinutes(0,0,0)`): exibição
   programada às 10h que só acontece às 11h01 não conta pra hora das 10h e
   ainda vira déficit. Dar 15 minutos de folga significa tratar a virada
   como JANELA e não como parede — o que foi programado numa hora conta como
   entregue se acontecer até 15 minutos depois dela. Quem começou a tocar
   antes da virada e terminou depois continua valendo, e a TV que buscou a
   playlist atrasada tem tempo de se acertar em vez de gerar déficit de
   mentira.
   Escala, pra não superdimensionar: o transbordo FÍSICO é no máximo uma
   peça, 30 segundos. Os 900s de tolerância são 30x isso. Ou seja, a folga
   não existe pelo vídeo que atravessa a virada — existe pelo poll do player,
   que é de 15 em 15 minutos (`src/playlist/routes.js`, comentário do cache)
   e pode deixar a TV até 15 minutos tocando a hora anterior. A folga usa a
   MESMA janela que o player já visita.

Os dois desenhos desta seção (sorteio entre pontos e folga de 15 min pro
déficit) já estão guardados em `docs/proximas-versoes.md`, prontos pra
autorização — não precisam ser repropostos, só liberados quando você
quiser construir.

## 5. Custo por ponto e por hora ligado

Fórmula que o próprio `admin/resumo` já usa (`src/admin/routes.js`):

```
custo do ponto/mês = amortização das telas dele
                    + ajuda de custo (valor_pago_mensal, se houver)
                    + rateio dos custos fixos da operação

amortização de 1 tela = custo_equipamento ÷ meses_amortizacao
rateio dos custos fixos = custos fixos totais ÷ nº de pontos ativos

custo por hora ligado = custo do ponto/mês ÷ (horas abertas/dia × ~30 dias)
```

Com números reais do sistema (o mesmo valor de equipamento usado nos testes
e2e, e os custos fixos seed do admin):

| Item | Valor |
|---|---|
| Equipamento (TV stick) | R$ 2.400, amortizado em 36 meses |
| Amortização da tela | R$ 2.400 ÷ 36 = **R$ 66,67/mês** |
| Custos fixos da operação | DAS MEI 86,05 + Contador 100 + Domínio 3,33 + Deslocamento 50 = **R$ 239,38/mês** |
| Rateio por ponto (rede com 5 pontos ativos) | R$ 239,38 ÷ 5 = **R$ 47,88/mês** |
| **Custo total do ponto (sem ajuda de custo)** | R$ 66,67 + R$ 47,88 = **R$ 114,55/mês** |
| Horas ligadas no mês (12h/dia × 30) | 360h |
| **Custo por hora ligado** | R$ 114,55 ÷ 360 ≈ **R$ 0,32/hora** |

Se o ponto também recebe ajuda de custo (`pontos.valor_pago_mensal`, decidido
pelo dono, sem valor padrão no banco), soma esse valor antes de dividir pelas
horas — por exemplo, com R$ 50/mês de ajuda de custo, o custo total sobe pra
R$ 164,55/mês (≈ R$ 0,46/hora).

**Leitura cruzada com a seção 3:** o teto de faturamento por ponto saturado
(~R$ 5.200/mês, seção 3) contra um custo de ponto de ~R$ 115 a R$ 165/mês
(esta seção) — a margem por ponto, no limite físico de exibição, é folgada.
O que limita a receita hoje não é o custo do ponto, é quantos anunciantes
pagantes a rede tem — o mesmo achado da seção 2: mais pontos dão mais
alcance, não mais receita por si só.

---

# 6. A lógica da rede — desenho do dono, 17/09/2026

**Isto ainda não é código.** É o desenho que o dono trouxe, com as contas
refeitas em cima dele e os problemas que a revisão encontrou. Nada daqui
entra em produção antes de ele fechar as perguntas em aberto no fim da seção.

## 6.1 O que muda

Hoje todo plano é `todos_pontos` e todo anunciante roda em toda tela — por
isso o inventário é de 3600 segundos por hora **para a rede inteira**, e
instalar mais telas aumenta o alcance de cada anunciante sem abrir uma vaga
sequer (seção 2).

O desenho novo inverte isso: **o plano passa a dar acesso a N pontos, e o
anunciante escolhe quais.**

- Cada ponto tem a própria hora de 3600 segundos.
- Um anunciante em K pontos consome `frequência × duração` de cada um dos K.
- Quem não escolhe roda sorteado entre os pontos **livres**.
- Ponto que já está cheio sai da lista de escolha.

Com isso o inventário vendável vira `3600 × número de pontos ativos`, e cada
ponto instalado abre vaga de verdade. É a diferença entre uma rede que satura
e uma que cresce.

## 6.2 As contas, refeitas

Capacidade por ponto: 3600 s/h. Consumo por conta, **por ponto escolhido**:

| plano | frequência | duração | consumo por ponto | contas que cabem num ponto |
|---|---|---|---|---|
| Essencial | 3x/h | 15s | 45 s/h | 80 |
| Destaque | 6x/h | 30s | 180 s/h | 20 |
| Máximo | 12x/h | 30s | 360 s/h | 10 |

Com N pontos e cada conta escolhendo K deles, cabem `N × 3600 ÷ (consumo × K)`
contas. Exemplos, tudo Essencial de 15s escolhendo 3 pontos cada:

| pontos ativos | inventário | contas Essencial |
|---|---|---|
| 3 | 10.800 s/h | 80 |
| 10 | 36.000 s/h | 266 |
| 30 | 108.000 s/h | 800 |

A rede deixa de ter teto de receita: o teto passa a ser quantos pontos
existem.

## 6.3 O problema do lançamento — e ele é maior do que parece

O dono levantou: "no início terei poucos pontos, todos então irão querer
assinar os planos mais baratos, já que tem menos pontos disponíveis".

Está certo, e é pior do que ele disse. Se o plano de entrada der acesso a 3
pontos e a rede tiver 3 pontos, **o plano de entrada já é a rede inteira** —
Destaque e Máximo não têm nada a mais pra vender. A escada de preço não fica
fraca, ela deixa de existir.

**Saída proposta: o plano de entrada é UM ponto.**

| plano | pontos | com 3 pontos na rede | com 10 |
|---|---|---|---|
| Essencial | 1 | vende "o ponto da sua rua" | idem |
| Destaque | 3 | vende 3 de 3 | 3 de 10 |
| Máximo | 10 (ou todos) | igual ao Destaque | 10 de 10 |

Isso transforma a fraqueza em força: com 3 pontos, "seu anúncio na padaria da
sua rua por R$ X" é uma venda fácil para o comércio daquela rua — não depende
de a rede ser grande. E a escada volta a existir já no primeiro dia, porque 1
é diferente de 3.

Complemento, sem código: manter `ativo = false` nos degraus que a rede ainda
não sustenta. O admin já tem esse botão.

**Consequência de preço:** se o plano passa a ser definido por pontos, o
preço deveria acompanhar `frequência × pontos`, não só frequência. É uma
fórmula que o dono consegue conferir de cabeça.

## 6.4 Os 15 segundos — resposta à pergunta do dono

15 segundos é formato padrão de mídia, não produto capado: é o comprimento
dominante em DOOH e em TV, e para comércio local (marca, oferta, endereço) é
suficiente — numa fila de caixa, provavelmente melhor que 30.

**Mas, com a lógica nova, o limite de duração deixa de ser necessário.** Ele
existia pra espremer mais slots de uma hora fixa; agora o inventário cresce
com os pontos. O que ele ainda custa continua: faz o plano de entrada parecer
punição, e dobra o trabalho de produção (duas versões de cada peça quando o
cliente sobe de plano).

**Recomendação:** diferenciar por PONTOS e manter 30s para todos. Se o dono
quiser mesmo uma alavanca de duração, inverter a leitura — 15s é o padrão de
todo mundo e 30s é um benefício dos degraus de cima. A conta é a mesma e a
história de venda é melhor: bônus em vez de limite.

## 6.5 Plano Master

Plano que pega todos os pontos instalados, mensal, sem autoatendimento: no
lugar de "Assinar", um botão que abre conversa no WhatsApp. O dono fecha o
preço e cria a cobrança direto no Asaas.

Mecanicamente é barato: um campo `sob_consulta` no plano muda o botão do card
e faz `POST /anunciantes/:id/assinar` recusar aquele plano.

**O que NÃO é barato, e é armadilha:** hoje o único jeito de o admin pôr um
plano numa conta é `POST /admin/anunciantes/:id/liberar-plano`, que grava
`plano_cortesia = true` e `valor_mensal_travado = null`
(`src/financeiro/routes.js`). E a receita recorrente do admin exclui
explicitamente `plano_cortesia` (`src/admin/routes.js`). Ou seja: o dono
fecharia um Master de R$ 2.000, cobraria no Asaas, e **esse dinheiro não
apareceria na receita nem na margem** — a conta ainda seria mostrada como
"em cortesia". É a mesma classe de erro que já foi corrigida duas vezes esta
semana (receita somando quem não paga; agora seria o inverso).

Antes do Master é preciso separar três coisas que hoje são uma só:
cortesia (não paga), cobrança externa (paga fora do site, entra na receita) e
cobrança pelo site.

## 6.6 Planos que evoluem com a rede, e o direito do parceiro

Desenho do dono: quando a rede cresce, os planos crescem junto; cliente comum
recebe a mudança, **cliente parceiro mantém o preço** mas recebe os
benefícios novos.

Encaixa no que já existe (RN-27 versiona plano, RN-11 trava preço), mas tem
um detalhe que quebra em silêncio: para dar benefício novo a quem já assinou,
a conta precisa apontar pra versão nova do plano. E
`aplicarCicloPago` decide a trava de preço por
`mesmoPlano = anunciante.plano_id === plano.id` — mudar a conta de versão faz
`mesmoPlano` virar falso e **reescreve `valor_mensal_travado` com o preço
novo**, que é exatamente o contrário do direito do parceiro.
`valorMensalDaConta` tem a mesma condição.

Então a migração de versão precisa de um caminho próprio que preserve a
trava, e não pode ser um `UPDATE plano_id` à mão.

## 6.7 Tela de pontos com a playlist ao vivo

Ideia do dono: na página "onde estamos", cada ponto aparece rodando a
playlist ao vivo, com a localização embaixo e link pro mapa. Mostra de cara
como o anúncio roda, e a página passa a servir também às contas já
cadastradas.

Vale, e é boa venda. Dois cuidados, os dois com endereço:

1. **Saída de vídeo.** `docs/erros/2026-09-saida-de-video-sem-cache.md`: uma
   tela rodando 12h faz ~2.800 exibições/dia e, a 6 MB por peça, >15 GB/dia.
   O player resolveu isso com cache no aparelho — um visitante do site não
   tem esse cache. Autoplay de vídeo real pra cada visitante reabre o mesmo
   buraco, agora com visitante em vez de tela. Caminho seguro: mostrar a
   THUMB do criativo em rotação (a thumb já é gerada), com o vídeo só sob
   clique.
2. **Rota própria.** `GET /playlist/:id` exige chave de aparelho e PROGRAMA
   os contadores da hora. A página pública precisa de uma rota separada, de
   leitura pura, que não conte exibição — senão a vitrine infla a entrega
   que o anunciante recebe no relatório.

## 6.8 O que está em aberto, e é decisão do dono

1. O plano de entrada passa a ser 1 ponto? (recomendação: sim)
2. O limite de 15s cai, e a diferenciação vira só pontos? (recomendação: sim)
3. Máximo e Master se sobrepõem — Máximo vira "até 10 pontos" e Master "todos
   sem teto", ou Máximo é aposentado dentro do Master?
4. O Master aparece na vitrine pública como degrau "fale com o suporte", ou
   só existe pra quem o dono liberar? (o botão de WhatsApp só faz sentido na
   primeira leitura)
5. Preço passa a seguir `frequência × pontos`?

**Impacto na esteira:** isto é escopo novo sobre um produto no ar, não
depuração — mexe em planos, cobertura, preço e playlist ao mesmo tempo. Pela
skill `leis` não cabe dentro da Estação 5, que fecha com a revisão do dono
sobre o que já existe. O caminho honesto é fechar a Estação 5 com o produto
atual e abrir esta lógica como v2, com escopo e fronteiras próprios.
