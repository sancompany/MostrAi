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
| **Tempo de tela por hora, em cada ponto** | `planos.segundos_por_hora` | `src/playlist/gerador.js` — `quantasInsercoes()` divide pelo tamanho da peça, e `montarHoraDeTv()` gasta os 3600s da hora nessa ordem (migration 045). Substituiu `frequencia_hora` em 17/09/2026: vender repetição fazia a duração da peça entrar na conta do estoque duas vezes |
| **Duração máxima da peça** | `planos.duracao_maxima_segundos` | `subirCriativo` recusa acima do teto, com o número do plano na mensagem (RN-41) |
| **Em quantos pontos da rede aparece** | `planos.pontos_incluidos` + `anunciantes_pontos` | `pontosDoAnunciante()` em `src/lib/pacing.js`, filtrando por ponto no gerador. O contratante escolhe quais em `PUT /anunciantes/me/pontos`; sem escolha, a distribuição é automática e estável (RN-42) |
| Quantos criativos ativos ao mesmo tempo (1 a 3) | `planos.limite_criativos` | Mesmo gerador — corta o array de criativos aprovados nesse limite |
| ~~Cobertura (1 ponto/dia, 3 pontos/dia, todos os pontos)~~ | `planos.cobertura` | **Aposentado em 17/09/2026.** Nunca passou de rótulo — o gerador ignorava e cobria 100% pra todo mundo. Quem manda agora é `pontos_incluidos`, e a coluna antiga foi normalizada pra `todos_pontos` na migration 047 pra parar de mentir. |
| ~~Preço travado no valor de quando entrou~~ | — | **Removido na migration 046**, autorizado pelo dono. A proteção de quem assinou é a imutabilidade do contrato (RN-11/RN-27): a conta fica na versão que assinou. |
| Desconto pra conta comodato (item 8 da spec) | `planos.desconto_comodato_percentual` | Mesmo arquivo — soma ao preço-base quando a conta tem o papel `ponto` |
| Desconto e piso de compromisso pra conta parceira (`status = 'parceiro'`, renomeado de "fundador" em 16/09/2026) | `anunciantes.parceiro_desconto_percentual` / `parceiro_compromisso_minimo` | Mesmo arquivo, mais a checagem de elegibilidade em `POST /anunciantes/:id/assinar` |
| ~~Tela no comércio ao completar N meses de plano~~ | — | **Removido na migration 046**, autorizado pelo dono ("esse de receber a tela após tantos meses retire essa função"). Nunca esteve ligado em plano nenhum, então nenhuma conta perdeu direito. O bônus INVERSO — dono de ponto que ganha plano de anúncio pelo tempo de comodato — continua: é contrapartida de contrato, não brinde. |
| Teto de vagas do plano | `planos.vagas` | `contarVagasOcupadas` — reserva de 15 minutos pra pagar (item 5) |

**Achado que vale registrar — e o que foi feito com ele (17/09/2026).** Dos
12 textos que existiam em `beneficios`, a maior parte só REDIZIA um destes
campos em português ("O dobro de frequência de exibição" era
`frequencia_hora`, "Até 3 criativos ativos" era `limite_criativos`). A
migration 047 resolveu isso na raiz: a tabela guarda **só benefício
qualitativo**, e tudo que é número — horas de tela por mês, minutos por hora,
pontos, duração da peça, quantidade de criativos — a vitrine DERIVA dos
campos do plano, na hora de desenhar o card (`public/planos.page.js`).
Benefício numérico escrito à mão é um número que envelhece sozinho no dia em
que alguém mexe no campo. Duas linhas, além disso, **não tinham nenhum código
atrás**:

- **"Alcança 100% dos pontos ativos"** — corrigida em 15/09/2026 (o dono
  apontou como mentira: a playlist exclui concorrente direto por categoria,
  então nunca é 100% pra todo mundo). Texto virou "Roda pelos pontos ativos
  da rede". "Cobertura máxima da rede" segue como está — é comparativa entre
  tiers, não uma promessa absoluta. No dia em que a régua de cobertura por
  ciclo virar código de verdade (seção 2), o texto do Essencial passa a
  precisar do campo `cobertura` sendo lido de verdade, não só mostrado.
- **"Prioridade em horário de pico"** (id 10) — **saiu da vitrine na migration
  047.** Não existe prioridade de horário em lugar nenhum do gerador de
  playlist, e ela estava no card do Máximo em produção. Desde a migration 037 a
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
| **Teto/mínimo de exibições por mês** (ex.: "até 1.500 exibições/mês") | Hoje `segundos_por_hora` é por hora, sem acumulado mensal. Precisaria de uma consulta agregando `exibicoes_contador.vezes_confirmadas` por mês e um corte no gerador quando o teto for atingido. |
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
- ~~Produção de peça simples incluída no plano~~ — **saiu em 17/09/2026**
  (migration 050). O dono esclareceu que nunca foi benefício de plano:
  produção de peça é **serviço à parte**, negociado no WhatsApp, com preço
  combinado caso a caso. Estava no Essencial, que é o de maior volume — era o
  mesmo problema do relatório mensal (048), no pior lugar possível.

## O que fazer com isso

Nenhuma linha nova foi criada na tabela `beneficios` nem em nenhum plano —
isso é escolha sua. Pra ativar um item da seção 1 ou 3, é só usar o admin
(Planos → Benefícios, ou os campos que já existem na grade). Um item da
seção 2 precisa entrar como pedido de construção — me diga qual, e eu volto
com o desenho antes de programar. A cobertura restrita por ciclo (linha 2
desta seção) já tem desenho pronto e guardado em `docs/proximas-versoes.md`
("Cobertura restrita por ciclo, sorteada entre pontos") — falta só você
autorizar a construção.
