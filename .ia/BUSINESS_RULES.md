# BUSINESS_RULES.md — Regras de negócio reais do Mostraí

Toda fórmula abaixo foi copiada ou parafraseada do código-fonte, com o
arquivo de origem. Nada aqui é estimado ou inventado — onde a regra é
julgamento (não fórmula), está dito.

## Papéis e conta

- Uma conta (`anunciantes`) nasce sempre com o papel `anunciante`. O papel
  `ponto` só entra por decisão do dono (candidatura liberada, ou convite
  antigo) — nunca autodeclaração (`CONSTRAINTS.md`, veto). O papel
  `vendedor` foi aposentado (23/09/2026; código removido em 24/09/2026 —
  todas as rotas respondem 410, tabelas ficam como histórico).
- `status` da conta é só `comum`/`parceiro` (desconto especial, marcado à
  mão pelo admin) — não é estado operacional. Quem bloqueia acesso é
  `suspenso` (booleano).

## Planos

- Definidos inteiramente na tabela `planos` — nunca em variável de
  ambiente (veto em `CONSTRAINTS.md`).
- Campos que compõem a oferta: `frequencia_hora` (fallback antigo),
  `segundos_por_hora` (modelo atual), `pontos_incluidos` (quantos pontos da
  rede o plano cobre), `duracao_maxima_segundos` (teto da peça),
  `limite_criativos`, `preco_travado` (mantém o valor de quando assinou),
  `desconto_comodato_percentual` (aposentado — sem efeito; ADR-016).
- **Ser ponto não é plano (ADR-016, 24/09/2026)**: ponto com tela ativa
  gera +1 crédito por mês no ledger único; plano pago × benefício por
  créditos seguem a prioridade Essencial < Pro < Prime
  (`plano-administrativo.js`). Inicial/Básico/repasse/ajuda de custo não
  existem no fluxo ativo.
- **Benefício comercial é sempre no preço, nunca no tempo**: não existe
  carência, mês grátis ou pular ciclo na assinatura (`CONSTRAINTS.md`).

## Duração de criativo

- Vídeo: aceito de 3 a 60 segundos (teto físico da tela), até 95 MB.
- Duração além disso é recusada com erro explícito se passar do
  `duracao_maxima_segundos` do plano
  (`src/anunciantes/routes.js`, função `subirCriativo`).
- Imagem: sem duração própria — normalizada para vídeo real via `ffmpeg`
  usando **a duração máxima do plano** (não um valor fixo desde 19/09/2026 —
  `src/lib/ffmpeg.js`, `DURACAO_PADRAO_IMAGEM = 10` é só fallback quando
  nenhuma duração de plano é passada).
- Sem duração válida (upload que o ffmpeg não mediu, ou plano sem duração
  configurada): `DURACAO_MINIMA = 5`, `DURACAO_PADRAO = 20`
  (`src/lib/pacing.js`, função `duracaoValida`).

## Orçamento da hora da tela (o motor central)

`src/lib/pacing.js`, função `montarHoraDeTv`. A hora é um orçamento de
**3600 segundos** (`SEGUNDOS_DA_HORA`), gasto nesta ordem de prioridade:

1. **Exibição contratada**: `frequenciaBase + déficit da hora anterior +
   prioridade do banco de horas`.
2. **Cota de autoanúncio** do dono do ponto (permuta do comodato antigo) —
   zerada em todos os pontos desde a migration 049 (produção: 0 pontos com
   cota em 24/09/2026); só rodaria se alguém repusesse a cota no banco.
3. **Peça institucional** (`ID_INSTITUCIONAL`, duração fixa
   `DURACAO_INSTITUCIONAL = 10` segundos) preenche o que sobra.

Se o total pedido (`pedidoSegundos`) passa de 3600s, o corte é
**proporcional**: cada participante perde a mesma fração do que pediu
(`fator = SEGUNDOS_DA_HORA / pedidoSegundos`), sobra de arredondamento vai
pros maiores restos primeiro. Esse corte é o gatilho do evento
`playlist:teto_corta`.

**Espalhamento** (`espalhar`, mesmo arquivo): cada participante recebe as
posições ideais `(i + 0,5) * total / n` ao longo da hora, e nunca duas
exibições seguidas do mesmo anunciante — busca vaga livre sem vizinho igual
primeiro, só aceita vizinho igual se não sobrar outra opção.

**Embaralhamento determinístico** (`embaralhar` + `geradorSemente`,
xorshift32): semente = `dispositivo.id + hora ISO`. Mesma tela, mesma hora,
mesma ordem sempre — em qualquer instância, mesmo depois de reiniciar. Isso
é o que permite rodar sem cache em memória (ver `ARCHITECTURE.md` e
`DECISIONS.md`).

## Congelamento da hora (19/09/2026)

`src/playlist/gerador.js` + `src/playlist/congelamento-repository.js` +
migration `064_playlist_hora_congelada.sql`.

- A primeira geração de uma hora (por tela) roda `montarHoraDeTv` sobre a
  lista completa de elegíveis e **congela** essa entrada.
- Gerações seguintes da mesma hora reprocessam a mesma base congelada (sempre
  a mesma sequência) e só **anexam no fim** quem passou a ser elegível
  depois (`sequenciaAdicional` — sem corte proporcional, pede exatamente
  `frequenciaBase + deficit`).
- Efeito de negócio: escolher um ponto novo, ou um criativo ser aprovado, faz
  efeito dentro da hora corrente (no próximo poll do player, até 15 min),
  em vez de esperar a próxima hora cheia — mas quem já estava programado
  nunca perde ou troca de posição por causa disso.
- Qualquer déficit gerado por essa entrada tardia é absorvido normalmente
  pelo mecanismo de déficit/banco de horas na hora seguinte — a meta mensal
  não depende de a entrada ter caído "no começo" da hora.

## Cobertura de pontos (RN-49)

`src/lib/pacing.js`, `pontosDoAnunciante` + `segundosCompensados`.

- O plano compra acesso a N pontos (`pontos_incluidos`); o anunciante
  escolhe quais (`PUT /anunciantes/me/pontos`), até o limite do plano.
- Quem não escolhe (ou não preenche o limite) recebe o resto por **sorteio
  estável**: hash determinístico de `(conta.id, ponto.id)`, sempre a mesma
  fatia enquanto a rede não mudar.
- Ponto `a_instalar` conta como vaga do plano (não perde o lugar), mas não
  veicula — entra no numerador da compensação, nunca no denominador.
- **Compensação**: enquanto a rede tiver menos pontos em operação do que o
  plano promete, o tempo dos pontos que faltam volta pros que veiculam:
  `segundos por hora em cada ponto = base × (pontos do plano ÷ pontos
  cobertos)`. Teto: **um anunciante nunca passa de 1/6 da hora numa tela**
  (`TETO_COMPENSACAO_SEGUNDOS = SEGUNDOS_DA_HORA / 6`).
- Ponto que cruza **80% de ocupação** para de entrar em sorteio automático
  novo (G.7) — quem já estava lá continua recebendo normalmente.

## Banco de horas

`src/bancohoras/`. Quando a hora não coube em tudo que o plano pedia
(corte proporcional), a diferença vira déficit acumulado por conta/mês.
Prioridade na hora seguinte cresce conforme a dívida envelhece
(`multiplicadorPorIdade` em `src/playlist/gerador.js`): de 1x (dívida deste
mês) até `MULTIPLICADOR_MAXIMO_BANCO = 3` (dívida na borda da válvula de
expiração, `MESES_PARA_FILA_DE_CREDITO` em `src/bancohoras/apuracao.js`).
A válvula nunca move dinheiro sozinha — vira decisão do admin quando chega
ao limite.

## Exibições, métricas do painel (`GET /anunciantes/:id/exibicoes`)

Todas as fórmulas abaixo são de `src/anunciantes/routes.js` (bloco final da
rota), calculadas só quando a conta tem plano (`null` sem plano ou em
cortesia, quando marcado):

- `horasContratadasMes = horasDeTelaPorMes(plano.segundos_por_hora,
  plano.pontos_incluidos)` — mesma fórmula de `horasDeTelaPorMes` em
  `src/lib/pacing.js`: `round(segundos_por_hora × pontos × 12h/dia × 30
  dias ÷ 3600)`. **Assume 12h de comércio aberto por dia, 30 dias/mês** —
  é uma estimativa "até", não uma medição real de horário de
  funcionamento.
- `horasEntreguesMes = round((confirmadasMes × duracaoMedia) / 3600, 1
  casa)` — `confirmadasMes` é a soma de `vezes_confirmadas` do mês corrente
  (fuso `America/Sao_Paulo`); `duracaoMedia` vem de
  `bancohorasRepo.duracaoMediaDoAnunciante` (nunca zero — cai num padrão de
  20s sem criativo aprovado ainda).
- `exibicoesContratadasMes = round(horasContratadasMes × 3600 ÷
  duracaoMedia)`.
- `exibicoesRestantesMes = max(0, exibicoesContratadasMes -
  confirmadasMes)`.
- `mediaDiariaMes = round(confirmadasMes ÷ dia-do-mês-atual, 1 casa)` —
  aproximação pelo relógio do servidor, não pelo fuso de Matão (aceito de
  propósito, é só ilustrativo).
- **Custo por exibição prevista** (ADR-018, 24/09/2026 — substituiu o
  `custoPorExibicao` calculado ao vivo): `valorCiclo ÷
  exibicoesPrevistasCiclo`, lido do **snapshot** `ciclos_contratados` do
  ciclo pago em vigor (`src/financeiro/ciclo-contratado.js`). O valor do
  ciclo é o que a Asaas cobrou (`valorCobrado`), gravado uma vez; nunca é
  recalculado pelo preço atual do plano nem pelas exibições realizadas.
  Sem valor em benefício por créditos, cortesia ou sem plano.

## Categoria/concorrência

- `anunciantesElegiveis` (`src/playlist/gerador.js`) exclui da tela um
  anunciante cujo `categoria_id` bate com o `categoria_id` **do ponto**
  onde a tela está — "não competir com o ramo do próprio comércio".
- **Risco conhecido, não fórmula**: nenhum caminho de criação de ponto hoje
  grava `categoria_id` no ponto (`docs/furos.md`, furo já catalogado) — na
  prática esse filtro nunca exclui ninguém hoje. Ver `.ia/RISKS.md`.

## Vendedor / comissão

Comissão calculada sobre o **valor confirmado** de quem o vendedor indicou,
no percentual da própria conta do vendedor (faixa 10–30%, o admin define o
valor exato por conta — não há fórmula automática de faixa). Pagamento é
manual (`comissoes.pago_em` só muda por clique do admin).

## Indicação de ponto (créditos)

`src/indicacoes/regras.js` — escada de 3 limiares (3/7/10 indicações pagas)
que libera upgrade de plano de tier acima (essencial → destaque → máximo)
sem gerar comissão em dinheiro — é crédito de upgrade, categoria diferente
da comissão de vendedor.

## Dashboard — o que aparece e quando

- Sem plano: dashboard inteiro escondido atrás de um card de bloqueio (KPIs,
  gráficos, upload) — decisão de 19/09/2026, ver `.ia/DECISIONS.md`.
- Upload de criativo por auto-serviço também recusa no backend (400) sem
  plano — defesa em profundidade, mesma regra do frontend.
