# Catálogo de tipos de benefício

Pedido do dono (15/09/2026): mapear todos os tipos de benefício possíveis
pra plano — os que mudam código e os que não mudam — no mesmo espírito das
pesquisas de mercado (`docs/pesquisa-voltplace.md`,
`docs/pesquisa-preco-sp.md`). Este documento não ativa nada por conta
própria: é o mapa pra você decidir o que entra.

## Como ler este documento

Cada benefício vem com uma classificação:

| Classificação | O que significa |
|---|---|
| **Já existe (código)** | O plano já tem o campo, e o resto do sistema já lê ele de verdade. Só falta você usar. |
| **Texto, sem código** | Vira uma linha na tabela `beneficios` (admin → Planos → Benefícios) e aparece no site. Nenhuma parte do sistema confere se é verdade — é promessa, não regra. |
| **Precisa de código novo** | Não existe campo nem lógica hoje. Pra valer de verdade (não só aparecer escrito), alguém programa antes. |

## 1. Já existe — o plano já aplica isso de verdade

| Benefício | Campo | Onde é aplicado |
|---|---|---|
| Frequência de exibição (N vezes por hora, por tela) | `planos.frequencia_hora` | `src/playlist/gerador.js` — é a própria cota por hora, direta (migration 037; antes dividia uma meta diária pelas horas de funcionamento do ponto, hoje não existe mais essa conversão) |
| Quantos criativos ativos ao mesmo tempo (1 a 3) | `planos.limite_criativos` | Mesmo gerador — corta o array de criativos aprovados nesse limite |
| Cobertura (1 ponto/dia, 3 pontos/dia, todos os pontos) | `planos.cobertura` | Hoje é só o RÓTULO — a playlist já cobre 100% dos pontos elegíveis pra qualquer plano (comentário em `gerador.js`: "Todo plano cobre 100% da rede nesta fase"). Ligar a régua de verdade (restringir quantos pontos por dia) é trabalho de código, listado na seção 2. |
| Preço travado no valor de quando entrou | `planos.preco_travado` + `anunciantes.valor_mensal_travado` | `src/financeiro/san-checkout.js`, `valorMensalDaConta` |
| Desconto pra conta comodato (item 8 da spec) | `planos.desconto_comodato_percentual` | Mesmo arquivo — soma ao preço-base quando a conta tem o papel `ponto` |
| Desconto e piso de compromisso pra conta parceira (`status = 'parceiro'`, renomeado de "fundador" em 16/09/2026) | `anunciantes.parceiro_desconto_percentual` / `parceiro_compromisso_minimo` | Mesmo arquivo, mais a checagem de elegibilidade em `POST /anunciantes/:id/assinar` |
| Tela no comércio ao completar N meses de plano (módulo cruzado) | `planos.ponto_apos_meses` | `src/conta/modos.js` — vira candidatura de ponto quando resgatado |
| Teto de vagas do plano | `planos.vagas` | `contarVagasOcupadas` — reserva de 15 minutos pra pagar (item 5) |

**Achado que vale registrar:** dos 12 textos hoje em `beneficios`, a maior
parte só REDIZ um destes campos em português ("O dobro de frequência de
exibição" é `frequencia_hora`, "Até 3 criativos ativos, revezando entre si" é
`limite_criativos`). Duas linhas, porém, **não têm nenhum código atrás**:

- **"Alcança 100% dos pontos ativos"** — corrigida em 15/09/2026 (o dono
  apontou como mentira: a playlist exclui concorrente direto por categoria,
  então nunca é 100% pra todo mundo). Texto virou "Roda pelos pontos ativos
  da rede". "Cobertura máxima da rede" segue como está — é comparativa entre
  tiers, não uma promessa absoluta. No dia em que a régua de cobertura por
  ciclo virar código de verdade (seção 2), o texto do Essencial passa a
  precisar do campo `cobertura` sendo lido de verdade, não só mostrado.
- **"Prioridade em horário de pico"** (id 10) — **não existe prioridade de
  horário em lugar nenhum do gerador de playlist.** Desde a migration 037 a
  frequência é por hora, direta — não há mais nem a divisão por horas de
  funcionamento do ponto que existia antes (`horasAbertoPorDia`, removida de
  `gerador.js`). Continua sendo uma promessa que ninguém confere — nem o
  anunciante consegue ver se ela está sendo cumprida.

## 2. Precisa de código novo — a promessa dependeria de mecanismo que não existe

Estes são os do tipo que você descreveu como "aparece em N telas por mês ou
aparece tantas vezes por dia" — ligam direto no gerador de playlist ou no
contador de exibições, e hoje não têm campo nem lógica:

| Benefício proposto | O que precisaria mudar |
|---|---|
| **Teto/mínimo de exibições por mês** (ex.: "até 1.500 exibições/mês") | Hoje `frequencia_hora` é por hora, sem acumulado mensal. Precisaria de uma consulta agregando `exibicoes_contador.vezes_confirmadas` por mês e um corte no gerador quando o teto for atingido. |
| **Cobertura restrita por ciclo** (ex.: plano de entrada só entra em 1 ponto por dia, sorteado ou fixo) | `planos.cobertura` já guarda a intenção (`um_ponto_dia`, `tres_pontos_dia`, `todos_pontos`) mas o gerador ignora — hoje é 100% pra todo mundo. Ligar de verdade é reescrever `anunciantesElegiveis` pra considerar quantos pontos aquele anunciante já apareceu no dia/ciclo. |
| **Prioridade real em horário de pico** | Precisaria de uma tabela ou campo de "horário de pico" por ponto (hoje só existe `horario_abertura`/`horario_fechamento`) e o gerador dando peso maior às contas com esse benefício nas janelas de pico. |
| **Mínimo de telas simultâneas garantido** (ex.: "garante estar em pelo menos 3 telas ao mesmo tempo na cidade") | Hoje a elegibilidade é por tela, sem visão do conjunto. Precisaria de uma consulta global por hora, algo que o pacing atual (por tela, isolado) não faz. |
| **Relatório de audiência cruzando fluxo estimado × exibição confirmada** | O dado de fluxo (`pontos.fluxo_estimado_mensal`) e o de exibição (`exibicoes_contador`) já existem separados; cruzar os dois em um relatório por conta é código novo (rota + agregação), não é grande, mas não existe hoje. |
| **SLA de aprovação de criativo** (ex.: "seu vídeo é revisado em até 4h") | Não há registro de quando um criativo entrou na fila nem alarme de atraso. Precisaria de um campo de prazo e um alerta no admin — parecido com o alerta de ponto offline que já existe. |
| **Cupom de desconto para quem o anunciante indicar** (diferente da comissão do vendedor) | Hoje só o vendedor tem `codigo_cupom`/comissão. Um desconto direto pro anunciante indicado (não comissão pra terceiro) é um mecanismo novo, com sua própria coluna e validação. |

## 3. Texto, sem código — pode ativar hoje, sem programar nada

Bastam uma linha em `beneficios` (admin → Planos → Benefícios) e marcar o
plano. O sistema nunca confere se é cumprido — é a mesma categoria em que
"Prioridade em horário de pico" já vive hoje, só que aqui a promessa é
sobre algo que se resolve por fora do software (atendimento, produção,
operação):

- Atendimento prioritário por WhatsApp
- Produção de peça simples incluída no plano (o que já é feito hoje
  informalmente, ver `docs/funcional.md` e o e-mail de confirmação de
  pagamento — mas nunca virou texto de benefício)
- Relatório mensal em PDF enviado por e-mail (se for feito à mão pelo
  suporte; se for automático, vira código — ver seção 2)
- Banner "parceiro fundador" ou selo na página institucional
- Prioridade na fila de aprovação de criativo (sem SLA numérico — só
  "primeiro a entrar, primeiro a sair" mais rápido, sem instrumentar nada)
- Desconto em setup/instalação pra quem também é ponto
- Brinde ou cortesia de boas-vindas

## O que fazer com isso

Nenhuma linha nova foi criada na tabela `beneficios` nem em nenhum plano —
isso é escolha sua. Pra ativar um item da seção 1 ou 3, é só usar o admin
(Planos → Benefícios, ou os campos que já existem na grade). Um item da
seção 2 precisa entrar como pedido de construção — me diga qual, e eu volto
com o desenho antes de programar. A cobertura restrita por ciclo (linha 2
desta seção) já tem desenho pronto e guardado em `docs/proximas-versoes.md`
("Cobertura restrita por ciclo, sorteada entre pontos") — falta só você
autorizar a construção.
