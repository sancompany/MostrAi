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
  contratou (`frequencia_dia`). Isso já estava mapeado em
  `docs/catalogo-beneficios.md`, seção 2, e é a peça que muda a resposta da
  pergunta 2 e 4 abaixo.

## 1. Quantos anúncios cabem por hora, dentro de um ponto

O cálculo roda **por tela**, não por ponto (`gerarPlaylistDaHora` é chamado
uma vez por dispositivo). Um ponto com N telas multiplica a conta por N —
telas são independentes, cada uma com sua própria lista.

| | Por tela | Ponto com 2 telas | Ponto com 4 telas |
|---|---|---|---|
| Teto de segurança/hora | **200** | 400 | 800 |
| Teto físico otimista (vídeo de 15s) | 240 | 480 | 960 |
| Teto físico conservador (vídeo de 30s) | 120 | 240 | 480 |

Quanto disso é OCUPADO de verdade depende da demanda contratada. A régua por
plano (frequência dividida pelas horas de funcionamento do ponto —
`horasAbertoPorDia`, padrão 12h quando o ponto não declara horário):

| Plano | Frequência/dia | Exibições/hora (12h abertas) |
|---|---|---|
| Essencial | 36 | 3/hora |
| Destaque | 72 | 6/hora |
| Máximo | 144 | 12/hora |

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

Concretamente: com a rede tendo, hoje, um total de `frequencia_dia` somado
de todos os anunciantes ativos igual a **F** exibições/dia, cada ponto novo
(de 1 tela) passa a entregar **+F exibições/dia pra rede** — desde que F
caiba no teto diário do ponto (200/hora × horas abertas, ex. 2.400/dia com
12h). Se F já estiver perto do teto, o ponto novo entrega até o teto e o
resto vira corte proporcional, igual a qualquer ponto saturado.

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
   quanto sobra: `vaga = 200 × horasAberto − Σ frequência dos garantidos`.
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
5. **Os 15 minutos de folga.** Hoje a hora é um bloco rígido
   (`horaAtual.setMinutes(0,0,0)`) e quem não coube leva corte proporcional
   na hora — o `deficit` (a diferença entre o que foi programado e o que foi
   confirmado, `deficitHoraAnterior`) já existe e já entra como prioridade
   extra na hora seguinte, mas hoje ele pode ser cortado de novo se a
   próxima hora também apertar. Dar 15 minutos de folga por hora significa:
   reservar os primeiros ~15 minutos de cada hora só pra saldar o déficit da
   hora anterior — um teto MÍNIMO garantido pro que sobrou, em vez de só uma
   prioridade que compete de novo pelo mesmo corte proporcional. É uma
   extensão pequena do mecanismo que já existe, não um pacing novo.
   O poll do player já é de 15 em 15 minutos (`tests/e2e` e
   `src/playlist/routes.js`, comentário do cache) — a folga proposta usa a
   MESMA janela que o player já visita, só muda o que é servido dentro
   dela.

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
