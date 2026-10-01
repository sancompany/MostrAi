const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const {
  montarHoraDeTv,
  pontosDoAnunciante,
  dividirCota,
  duracaoValida,
  segundosCompensados,
  segundosDeObrigacao,
  espalhar,
  ID_INSTITUCIONAL,
  DURACAO_INSTITUCIONAL,
  DURACAO_PADRAO,
} = require('../lib/pacing');
const eventos = require('../lib/eventos');
const { CRIATIVOS_POR_CONTA } = require('../lib/limites');
const obrigacaoDoCiclo = require('../bancohoras/obrigacao-do-ciclo');
const pontosRepo = require('../pontos/repository');
const congelamentoRepo = require('./congelamento-repository');
const midiasRepo = require('../midias/repository');
const basicoRepo = require('../pontos/basico');
const { operacaoDoPonto, minutosOperando } = require('../lib/operacao-tela');

// Quem chega no meio da hora (ponto escolhido agora, criativo aprovado
// agora) não disputa vaga com quem já estava programado — só pede a fatia
// que teria direito e entra em fila, sempre depois de tudo que já existe.
// Sem corte proporcional (RN-30 já rodou pra quem estava na hora desde o
// início): o pedido do dono foi "não precisa separar por hora, só bater a
// meta do mês", e o déficit de uma hora cheia demais se resolve sozinho na
// hora seguinte, como qualquer déficit.
//
// A compensação da RN-49 (`compensacao`, separada da base desde 27/09/2026)
// entra junto: a obrigação de quem chega conta com ela, e deixá-la de fora
// virava saldo evitável mesmo com a tela ociosa (revisão Codex do PR #85).
function sequenciaAdicional(novosEntrada) {
  const pedidos = novosEntrada
    .map((n) => ({
      id: n.id,
      quantidade: Math.max(0, (n.frequenciaBase || 0) + (n.compensacao || 0) + (n.deficit || 0)),
    }))
    .filter((p) => p.quantidade > 0);
  if (!pedidos.length) return [];
  const total = pedidos.reduce((soma, p) => soma + p.quantidade, 0);
  return espalhar(pedidos, total).filter((id) => id !== null);
}

// Quanto mais velha a dívida, mais peso ela ganha na hora — pedido do dono,
// 18/09/2026: "quanto mais tempo no banco tiver, mais prioridade tem". Escala
// de 1x (dívida deste mês: nunca mais que o próprio pedido da hora) até
// MULTIPLICADOR_MAXIMO_BANCO (dívida com IDADE_DE_PESO_MAXIMO_MESES ou mais)
// — números nossos, o dono não pediu nestes termos (docs/PENDENCIAS.md). Até
// 25/09/2026 a idade máxima era a da válvula de expiração; a válvula saiu
// (banco de horas não expira) e a escala ficou com o mesmo formato.
const MULTIPLICADOR_MAXIMO_BANCO = 3;
const IDADE_DE_PESO_MAXIMO_MESES = 3;

function multiplicadorPorIdade(idadeMeses) {
  const fracao = Math.min((idadeMeses || 0) / IDADE_DE_PESO_MAXIMO_MESES, 1);
  return 1 + fracao * (MULTIPLICADOR_MAXIMO_BANCO - 1);
}

// Playlist é por TELA (dispositivo), não por ponto — migration 019. A tela
// recebe do ponto a categoria (bloqueio de concorrente) e a cota de
// autoanúncio do dono, dividida entre as telas daquele ponto.

// Quantos criativos da conta entram na rotação.
//
// Conta própria não tem teto: o inventário é da casa, e limitar a si mesmo não
// protege ninguém. Quem paga plano fica no que o plano vende, e nunca acima do
// teto de `src/lib/limites.js`.
//
// Este corte continua aqui como ÚLTIMA defesa (plano antigo, ou alguém
// escrevendo no banco à mão), mas desde 17/09/2026 já não é a única: quem
// recusa é o repositório de planos, na gravação, com o motivo na mensagem. O
// corte silencioso no fim da linha vendia 5 e rodava 3 sem avisar ninguém.
function limiteDeCriativos(contaPropria, limitePlano, disponiveis) {
  if (contaPropria) return disponiveis;
  return Math.min(CRIATIVOS_POR_CONTA, Math.max(1, Number(limitePlano) || 1));
}

// "Elegível pra esta tela" é: conta ativa + criativo aprovado + dentro da
// validade + não ser do mesmo ramo do comércio onde a tela está nem de um
// ramo registrado como CONCORRENTE DIRETO dele (migration 105) + O PLANO
// COBRIR ESTE PONTO.
//
// A última condição é nova (17/09/2026). Até aqui todo plano cobria 100% da
// rede, então instalar uma tela aumentava custo e abria zero vaga. Agora o
// plano dá acesso a N pontos e o contratante escolhe quais — quem não
// escolhe recebe uma fatia estável, calculada em `pontosDoAnunciante`.
//
// A CONTA PRÓPRIA do Mostraí (migration 023) SAIU desta função (reorganização
// de Conteúdo, 22/09/2026) — cada peça institucional agora é uma "mídia
// própria" independente (`midias-proprias`), com a própria frequência e
// cobertura, não mais um valor único por conta. Ver `midiasElegiveis`
// abaixo, chamada à parte em `gerarPlaylistDaHora`.
// `anunciantes.frequencia_hora_propria`/`conta_propria` continuam existindo
// no banco (legado, sem uso novo) — só não alimentam mais a playlist por
// aqui.
// `donoDoPonto`/`pontoId`: a trava de ramo ("não dividir a tela com um
// concorrente direto do comércio") protege o DONO do ponto — não pode
// barrá-lo na própria tela quando ele ESCOLHEU veicular ali. Até 27/09/2026
// a conta do mesmo ramo do ponto era barrada inclusive quando era a dona
// dele (o ponto herda o ramo do dono), e o anúncio de quem marcava "veicular
// no próprio ponto" nunca entrava: foi o que produção mostrou (conta e único
// ponto da rede no mesmo ramo, zero exibição programada). A isenção vale só
// com a escolha explícita (`anunciantes_pontos`): o próprio ponto é opcional
// e nunca entra por ser do dono — no modo automático a trava continua como
// era. A isenção cobre as duas regras da trava (mesma categoria e par de
// concorrentes diretos): é a tela DELE. A cota de autoanúncio continua
// saindo por `excluirContaId`.
//
// `qualquerValidade`: a obrigação de hora sem sinal (src/bancohoras/obrigacao.js)
// olha horas que já passaram — a validade é conferida hora a hora lá, com a
// `data_expiracao` devolvida aqui, não pela data de hoje.
//
// `comSaldo` (01/10/2026, migration 111): contas com saldo de veiculação
// ATRASADO entram mesmo com o plano vencido ou cancelado — a Mostraí continua
// entregando até zerar (spec de consolidação, R2 §1 e R3 §40), só na
// capacidade ociosa (camada T3). Sem plano vigente, a cobertura e a peça vêm
// do plano do último ciclo contratado; `plano_vigente` diz ao gerador que essa
// conta não tem base nem compensação, só a devolução do saldo.
async function anunciantesElegiveis(
  categoriaDoPonto,
  excluirContaId,
  donoDoPonto = null,
  pontoId = null,
  { qualquerValidade = false, comSaldo = [] } = {},
) {
  const { rows } = await pool.query(
    `
    SELECT a.id, a.conta_propria, a.data_expiracao,
           (a.plano_id IS NOT NULL AND ($5::boolean OR ${vigencia.vigenteSql('a.data_expiracao')})) AS plano_vigente,
           p.frequencia_hora,
           p.segundos_por_hora, p.pontos_incluidos,
           p.limite_criativos,
           array_agg(c.arquivo_normalizado_url ORDER BY c.created_at DESC) AS urls,
           array_agg(c.duracao_segundos ORDER BY c.created_at DESC) AS duracoes,
           array_agg(c.id ORDER BY c.created_at DESC) AS criativo_ids,
           array_agg(c.conteudo_sha256 ORDER BY c.created_at DESC) AS hashes,
           COALESCE(
             (SELECT array_agg(ap.ponto_id ORDER BY ap.escolhido_em)
                FROM anunciantes_pontos ap WHERE ap.anunciante_id = a.id),
             ARRAY[]::int[]
           ) AS pontos_escolhidos
    FROM anunciantes a
    -- Só o plano COMERCIAL dentro da validade (Essencial/Pro/Prime — pago,
    -- benefício por créditos ou cortesia legada). Inicial/Básico deixaram de
    -- dar direito de veicular em 24/09/2026 (ADR-016): ser ponto gera
    -- créditos, não plano. comodato_plano_id fica no banco como legado.
    LEFT JOIN LATERAL (
      SELECT o.plano_id FROM obrigacoes_veiculacao o
       WHERE o.anunciante_id = a.id AND o.plano_id IS NOT NULL AND o.segundos > 0
       ORDER BY o.criado_em DESC, o.id DESC LIMIT 1
    ) ultimo ON a.id = ANY($6::int[])
    JOIN planos p ON p.id = CASE
      WHEN a.plano_id IS NOT NULL AND ($5::boolean OR ${vigencia.vigenteSql('a.data_expiracao')}) THEN a.plano_id
      ELSE ultimo.plano_id END
    -- arquivo_normalizado_url IS NOT NULL: peca aprovada com o arquivo ainda
    -- em processamento (ou cujo processamento morreu no meio) entrava na
    -- playlist como url nula e a TV ficava tocando vazio no lugar dela — e a
    -- exibicao era contada. criativosDoDono, logo abaixo, ja filtrava.
    JOIN criativos c ON c.anunciante_id = a.id AND c.status = 'aprovado'
      AND c.arquivo_normalizado_url IS NOT NULL
    WHERE NOT a.suspenso
      AND a.excluido_em IS NULL
      AND NOT a.conta_propria
      -- Proteção do dono da tela (categorias/concorrencia.js): mesma
      -- categoria do ponto, ou par registrado em categorias_concorrentes
      -- (guardado com a < b — uma busca pela PK, sem N+1). Grupo e aliases
      -- não entram.
      AND ($1::int IS NULL OR a.categoria_id IS NULL
           OR (a.categoria_id <> $1 AND NOT EXISTS (
                 SELECT 1 FROM categorias_concorrentes cc
                  WHERE cc.categoria_a = least(a.categoria_id, $1::int)
                    AND cc.categoria_b = greatest(a.categoria_id, $1::int)))
           OR (a.id = $3::int AND EXISTS (
                 SELECT 1 FROM anunciantes_pontos proprio
                  WHERE proprio.anunciante_id = a.id AND proprio.ponto_id = $4::int)))
      AND ($2::int IS NULL OR a.id <> $2)
    GROUP BY a.id, a.conta_propria, a.data_expiracao, p.frequencia_hora, p.segundos_por_hora, p.pontos_incluidos,
             p.limite_criativos
  `,
    [
      categoriaDoPonto || null,
      excluirContaId || null,
      donoDoPonto || null,
      pontoId || null,
      qualquerValidade,
      comSaldo.map(Number),
    ],
  );

  return rows.map((r) => {
    const limite = limiteDeCriativos(r.conta_propria, r.limite_criativos, r.urls.length);
    return {
      ...r,
      criativos: r.urls.slice(0, limite).map((url, i) => ({
        url,
        duracaoSegundos: r.duracoes[i],
        criativoId: r.criativo_ids[i],
        contentHash: r.hashes[i],
      })),
    };
  });
}

// Mídias próprias elegíveis nesta tela, uma entrada de playlist por mídia
// (Parte 5/7 do pedido: cada mídia tem a própria frequência e cobertura,
// não é mais rateada entre pontos como a cobertura de plano — RN-49 e banco
// de horas não se aplicam aqui, os dois existem pra compensar/repartir
// cobertura entre pontos, e cada mídia já diz direto quantas vezes por
// hora, nos pontos que ela mesma escolheu).
async function midiasElegiveis(pontoId) {
  const rows = await midiasRepo.elegiveisNoPonto(pontoId);
  return rows.map((r) => ({
    id: `midia:${r.id}`,
    frequenciaBase: Number(r.frequencia_hora) || 0,
    deficit: 0,
    duracaoSegundos: r.duracao_segundos,
    criativos: [
      { url: r.url, duracaoSegundos: r.duracao_segundos, criativoId: r.criativo_id, contentHash: r.conteudo_sha256 },
    ],
  }));
}

// Cota de autoanúncio: os criativos aprovados da conta dona do ponto entram
// na tela dele sem plano e sem cobrança — é a contrapartida do comodato.
// A cota (slots/hora) é do ponto e é dividida entre as telas ativas dele.
async function criativosDoDono(contaId) {
  if (!contaId) return [];
  const { rows } = await pool.query(
    `SELECT id AS "criativoId", arquivo_normalizado_url AS url, duracao_segundos AS "duracaoSegundos",
            conteudo_sha256 AS "contentHash"
     FROM criativos WHERE anunciante_id = $1 AND status = 'aprovado' AND arquivo_normalizado_url IS NOT NULL
     ORDER BY created_at DESC LIMIT 3`,
    [contaId],
  );
  return rows;
}

// Os pontos que estão no ar agora. É a régua da cobertura: o plano dá acesso
// a N pontos, e "N de quantos" muda toda vez que um comércio novo entra.
// Quantas inserções aquele plano compra nesta hora, com a peça que a conta
// tem hoje. `segundos` já vem compensado pela cobertura (RN-49) — a decisão
// de quanto ele tem fica fora daqui, que é só a divisão.
function quantasInsercoes(conta, segundos, duracaoSegundos) {
  if (segundos > 0) return Math.floor(segundos / duracaoValida(duracaoSegundos));
  return Number(conta.frequencia_hora) || 0;
}

async function pontosEmOperacao() {
  const { rows } = await pool.query(`SELECT id FROM pontos WHERE status = 'em_operacao' ORDER BY id`);
  return rows.map((r) => r.id);
}

// Por quantos pontos o Saldo de Veiculação de uma conta sai na mesma hora: a
// fatia comercial e os pontos do Básico, sem contar duas vezes o próprio
// ponto que está nas duas (revisão independente, 28/09/2026). Nunca 0.
function pontosQuePuxamOSaldo(fatiaComercial, pontosDoBasico) {
  return new Set([...(fatiaComercial || []), ...(pontosDoBasico || [])]).size || 1;
}

// A fatia comercial de uma conta que ficou fora de `anunciantesElegiveis`
// nesta tela (a dona, que a trava de ramo barra no próprio ponto) — a MESMA
// conta de `pontosDoAnunciante` que as outras telas fazem pra ela, com o
// plano dentro da validade. Sem plano válido, nenhuma.
async function coberturaComercialDaConta(contaId, pontosNoAr, pontosBloqueados) {
  const { rows } = await pool.query(
    `SELECT p.pontos_incluidos,
            COALESCE((SELECT array_agg(ap.ponto_id ORDER BY ap.escolhido_em)
                        FROM anunciantes_pontos ap WHERE ap.anunciante_id = a.id), ARRAY[]::int[]) AS pontos_escolhidos
       FROM anunciantes a
       JOIN planos p ON p.id = a.plano_id AND ${vigencia.vigenteSql('a.data_expiracao')}
      WHERE a.id = $1`,
    [contaId],
  );
  if (!rows[0]) return [];
  return pontosDoAnunciante(
    { id: contaId, pontosIncluidos: rows[0].pontos_incluidos, escolhidos: rows[0].pontos_escolhidos },
    pontosNoAr,
    pontosBloqueados,
  );
}

// Quem reveza entre peças de durações diferentes ocupa, ao longo da hora, a
// média delas. Média e não a primeira: a rotação passa por todas.
function duracaoMedia(criativos) {
  if (!criativos?.length) return undefined;
  const soma = criativos.reduce((t, c) => t + duracaoValida(c.duracaoSegundos), 0);
  return Math.round(soma / criativos.length);
}

// Só a entrega NORMAL da hora anterior que a TV não confirmou volta como
// déficit. A exibição do banco (`vezes_banco`, migration 090) que não rodou
// continua no saldo do banco — carregar ela aqui também a devolveria duas
// vezes. A confirmada conta primeiro pra entrega normal (mesma regra da
// liquidação, src/bancohoras/apuracao.js).
//
// Saldo de Veiculação (27/09/2026):
// - hora anterior FECHADA não tem linha (não grava programada) — nada rola
//   pra dentro da madrugada, e o não entregue da última hora aberta fica
//   como não entregue daquela hora (vira saldo na apuração), em vez de rolar
//   a noite inteira e estourar na abertura;
// - hora anterior PARCIAL só devolve o que caberia nos minutos abertos dela
//   (a peça programada no pedaço fechado não tocou porque a tela estava
//   apagada, não porque falhou);
// - não cruza competência: o não entregue da última hora do mês fica no mês.
async function deficitHoraAnterior(dispositivoId, horaAnterior, horaAtual) {
  if (vigencia.hojeComercial(horaAnterior).slice(0, 7) !== vigencia.hojeComercial(horaAtual).slice(0, 7)) return {};
  const { rows } = await pool.query(
    `SELECT anunciante_id,
            GREATEST(FLOOR((vezes_programadas - vezes_banco) * COALESCE(minutos_abertos, 60) / 60.0)
                     - vezes_confirmadas, 0)::int AS deficit
     FROM exibicoes_contador WHERE dispositivo_id = $1 AND janela_hora = $2`,
    [dispositivoId, horaAnterior],
  );
  const mapa = {};
  rows.forEach((r) => {
    mapa[r.anunciante_id] = Number(r.deficit);
  });
  return mapa;
}

// `pedidos` é o que cada anunciante QUERIA antes do corte (RN-30) — pode
// ter chave que não está em `contagem` (quem não coube em nada, `cabe=0`,
// e por isso nem aparece na entrega). `vezes_pedidas` some do banco de
// horas quem não pediu mais nada naquela hora (conta cancelada, criativo
// removido): sem pedido não há déficit a apurar. `banco` é quanto de
// `contagem` veio do banco de horas (entra em `vezes_programadas` — é o teto
// da confirmação — e separado em `vezes_banco`). `banco_liquidado_em` nunca é
// regravado aqui: a base da hora é congelada, então `vezes_banco` não muda
// entre as gerações da mesma hora.
//
// `obrigacao` ({ [anuncianteId]: { segundos, duracao } }) e `minutosAbertos`
// (Saldo de Veiculação, migration 100): o tempo que a conta tinha direito
// nesta tela nesta hora e a duração usada. Gravados UMA vez — a primeira
// geração da hora fixa o número, e os polls seguintes não reescrevem
// (COALESCE), como a base congelada da hora.
//
// A parte do Básico (`basico`, migration 103) congela JUNTO com o total, na
// mesma escrita — nunca sozinha. Com COALESCE independente, a linha de quem
// chegou no meio da hora sem Básico (total fixado, Básico nulo) recebia num
// poll seguinte uma parte Básico maior que o total congelado, o CHECK da 103
// barrava, e a playlist daquela tela dava erro até a hora virar (revisão
// independente, 28/09/2026: a hora do deploy, ou um Básico que nasce no meio
// da hora pra uma conta que já estava nos `extras`).
async function gravarProgramados(
  dispositivo,
  horaAtual,
  contagem,
  pedidos = {},
  banco = {},
  obrigacao = {},
  minutosAbertos = 60,
) {
  const anunciantes = new Set([...Object.keys(contagem), ...Object.keys(pedidos)]);
  await Promise.all(
    [...anunciantes].map((anuncianteId) => {
      const vezes = contagem[anuncianteId] || 0;
      const doBanco = banco[anuncianteId] || 0;
      const pedidas = pedidos[anuncianteId] ?? vezes - doBanco;
      const devida = obrigacao[anuncianteId] || {};
      return pool.query(
        `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas, vezes_banco,
                                         segundos_obrigacao, duracao_segundos, minutos_abertos, segundos_obrigacao_basico)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (anunciante_id, dispositivo_id, janela_hora)
     DO UPDATE SET vezes_programadas = $4, vezes_pedidas = $5, vezes_banco = $6,
                   segundos_obrigacao = COALESCE(exibicoes_contador.segundos_obrigacao, EXCLUDED.segundos_obrigacao),
                   segundos_obrigacao_basico = CASE WHEN exibicoes_contador.segundos_obrigacao IS NULL
                                                    THEN EXCLUDED.segundos_obrigacao_basico
                                                    ELSE exibicoes_contador.segundos_obrigacao_basico END,
                   duracao_segundos = COALESCE(exibicoes_contador.duracao_segundos, EXCLUDED.duracao_segundos),
                   minutos_abertos = COALESCE(exibicoes_contador.minutos_abertos, EXCLUDED.minutos_abertos)`,
        [
          anuncianteId,
          dispositivo.id,
          horaAtual,
          vezes,
          pedidas,
          doBanco,
          devida.segundos ?? 0,
          devida.duracao ?? DURACAO_PADRAO,
          minutosAbertos,
          devida.basico || null,
        ],
      );
    }),
  );
}

// Quantos minutos da hora o ponto desta tela opera — a mesma régua que o
// Player usa pra apagar a tela (src/lib/operacao-tela.js).
function minutosAbertosNaHora(dispositivo, de, ate) {
  return Math.round(minutosOperando(operacaoDoPonto(dispositivo.ponto_horario_semanal, de), de, ate));
}

// Os números de uma conta numa tela: duração da hora, inserções pedidas na
// base (T1) e além dela (T2, compensação da RN-49 até o teto) e a obrigação
// por hora cheia (RN-49 sem teto — `segundosDeObrigacao`). Um lugar só, usado
// pela geração e pela obrigação da hora sem sinal: as duas nunca divergem.
function numerosDaConta(conta, pontosCobertos, telasDoPonto) {
  const duracaoSegundos = duracaoMedia(conta.criativos);
  // RN-49: enquanto a rede for menor que o plano, o tempo dos pontos que
  // faltam volta pros que veiculam (até o teto por tela).
  const segundos = segundosCompensados(conta.segundos_por_hora, conta.pontos_incluidos, pontosCobertos);
  // O plano compra SEGUNDOS da hora; quantas inserções isso vira depende
  // da peça que o cliente subiu (RN-39). `frequencia_hora * duração` é a
  // ponte pra plano legado sem `segundos_por_hora`.
  const total = quantasInsercoes(conta, segundos, duracaoSegundos);
  const base = Math.min(total, quantasInsercoes(conta, Number(conta.segundos_por_hora) || 0, duracaoSegundos));
  const obrigacaoHoraCheia = {
    segundosPorHora: conta.segundos_por_hora,
    frequenciaHora: conta.frequencia_hora,
    pontosIncluidos: conta.pontos_incluidos,
    pontosCobertos,
    duracaoSegundos,
    telasDoPonto,
  };
  return { duracaoSegundos, base, compensacao: total - base, total, obrigacaoHoraCheia };
}

// Mídia Mostraí: quantas vezes cada mídia foi PROGRAMADA nesta tela nesta
// hora (27/09/2026) — o outro lado do "confirmadas" que o proof-of-play
// credita. Conta o que foi de fato pra playlist servida (depois do corte da
// hora cheia e com quem entrou no fim), não a frequência configurada.
//
// Só grava se o ponto opera em algum momento da hora: o Player continua
// buscando a playlist com a loja fechada (só não toca — conferido no app,
// PlayerActivity#aplicarHorarioOperacional), e contar isso como programado
// transformaria toda madrugada em "entrega atrasada".
//
// Sobrescreve (como `gravarProgramados`): a base da hora é congelada, então a
// contagem só muda quando alguém entra no fim. Mídia que saiu no meio da
// hora (pausada) não é regravada — o que foi programado enquanto ela estava
// no ar continua valendo como teto das confirmações daquela hora.
async function gravarProgramadasDaMidia(dispositivo, horaAtual, itens) {
  const porMidia = {};
  for (const item of itens) {
    const tipo = item.itemProgramacaoId.split('|')[3];
    const m = /^midia:(\d+)$/.exec(tipo);
    if (m) porMidia[m[1]] = (porMidia[m[1]] || 0) + 1;
  }
  const midias = Object.keys(porMidia);
  if (!midias.length) return;
  const fimDaHora = new Date(horaAtual.getTime() + 3_600_000);
  if (minutosOperando(operacaoDoPonto(dispositivo.ponto_horario_semanal), horaAtual, fimDaHora) <= 0) return;
  await Promise.all(
    midias.map((midiaId) =>
      pool.query(
        `INSERT INTO midias_exibicoes_contador (midia_id, dispositivo_id, ponto_id, janela_hora, vezes_programadas)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (midia_id, dispositivo_id, janela_hora) DO UPDATE SET vezes_programadas = $5`,
        [Number(midiaId), dispositivo.id, dispositivo.ponto_id, horaAtual, porMidia[midiaId]],
      ),
    ),
  );
}

// Vídeo institucional (25/09/2026): configuração ÚNICA pra rede inteira,
// gravada por `POST /admin/video-institucional` na MESMA `configuracoes_site`
// que já guarda a foto de exemplo do ponto (migration 055; `src/pontos/
// repository.js#definirConfiguracao`) — não é criativo (não tem
// `anunciante_id`, não é de ninguém pra aprovar) nem mídia própria
// (`midias_proprias`, que compete por frequência: este só preenche o que
// sobrou, igual ao cartão que substitui).
//
// Roda em TODA geração de playlist de TODA tela da rede — nunca pode
// derrubar isso por causa de um valor gravado errado à mão. `null` (nunca
// configurado, JSON quebrado, ou campos faltando) cai no cartão de sempre.
async function obterVideoInstitucional() {
  const bruto = await pontosRepo.obterConfiguracao('video_institucional');
  if (!bruto) return null;
  try {
    const { url, duracaoSegundos, contentHash } = JSON.parse(bruto);
    if (typeof url !== 'string' || !url) return null;
    if (!Number.isFinite(duracaoSegundos) || duracaoSegundos <= 0) return null;
    return { url, duracaoSegundos, contentHash: typeof contentHash === 'string' ? contentHash : null };
  } catch {
    return null;
  }
}

// `dispositivo` é o objeto de dispositivosRepo.buscarComPonto (já traz a
// categoria, o horário, a cota e o dono do ponto).
//
// `agora` (relógio injetável dos testes; padrão, o de verdade): só decide
// quanto da hora sobra pra quem chega no meio dela (obrigação de `extras`).
async function gerarPlaylistDaHora(dispositivo, hora, agora = new Date()) {
  const horaAtual = new Date(hora);
  horaAtual.setMinutes(0, 0, 0);
  const horaAnterior = new Date(horaAtual);
  horaAnterior.setHours(horaAnterior.getHours() - 1);
  const fimDaHora = new Date(horaAtual.getTime() + 3_600_000);
  // PONTO FECHADO ≠ FALHA DE ENTREGA (Saldo de Veiculação, 27/09/2026). O
  // Player continua pedindo playlist com a loja fechada (só não toca), e
  // até aqui a hora fechada gravava programada comercial: o não confirmado
  // rolava a madrugada inteira e virava saldo falso na abertura. Hora sem
  // nenhum minuto aberto responde a playlist (técnico), mas não nasce
  // obrigação, programada, reposição nem banco. Hora parcial deve só os
  // minutos abertos.
  const minutosAbertos = minutosAbertosNaHora(dispositivo, horaAtual, fimDaHora);
  const aberta = minutosAbertos > 0;

  // O DONO DO PONTO PASSA NA PRÓPRIA TELA (decisão do dono, 17/09/2026 —
  // fecha o item 28 de docs/PENDENCIAS.md).
  //
  // Ele era excluído da rotação paga da tela dele, e isso fazia sentido
  // enquanto a contrapartida do comodato era a COTA de autoanúncio: ele já
  // entrava por ali, e entrar duas vezes era aparecer em dobro. A cota acabou
  // na migration 049 — agora a contrapartida é um plano de verdade, e a
  // exclusão passou a fazer o contrário do que ela protegia: ele escolhia o
  // próprio ponto em `PUT /anunciantes/me/pontos`, a rota aceitava, e o
  // gerador tirava ele de lá. Gastava uma vaga de cobertura num lugar onde
  // nunca ia aparecer, sem aviso nenhum.
  //
  // E é justamente a tela DELE que vende o comodato: os clientes dele passam
  // ali. A exclusão só continua valendo enquanto a cota existir naquela tela,
  // que é o único caso em que a dobra é real.
  // Plano Básico do ponto (migration 103): a conta dona veicula na própria
  // tela por benefício de ponto. É o sucessor da cota de autoanúncio — com
  // ele ativo a cota legada (zerada desde a 049) não entra, senão a dona
  // apareceria em dobro.
  const basico = await basicoRepo.paraVeicularNoPonto(dispositivo.ponto_id, horaAtual);
  const cotaDaTela = basico ? 0 : dividirCota(dispositivo.cota_autoanuncio_slots_hora, dispositivo.telas_do_ponto);
  const excluirDaRotacaoPaga = cotaDaTela > 0 ? dispositivo.dono_conta_id : null;

  // Saldo de Veiculação (migration 111): o ATRASO de cada conta — a
  // obrigação nascida dos ciclos contratados que o ritmo normal já devia ter
  // entregado e o Proof-of-Play ainda não confirmou. É ele que a camada T3
  // devolve na capacidade ociosa.
  const saldosBanco = await obrigacaoDoCiclo.saldosParaRecuperar({ agora });
  const [todos, deficits, doDono, pontosNoAr, pontosBloqueados, midiasProprias, videoInstitucional, basicosPorConta] =
    await Promise.all([
      anunciantesElegiveis(
        dispositivo.categoria_id,
        excluirDaRotacaoPaga,
        dispositivo.dono_conta_id,
        dispositivo.ponto_id,
        { comSaldo: Object.keys(saldosBanco) },
      ),
      aberta ? deficitHoraAnterior(dispositivo.id, horaAnterior, horaAtual) : {},
      criativosDoDono(dispositivo.dono_conta_id),
      pontosEmOperacao(),
      pontosRepo.idsBloqueadosParaEscolha(),
      midiasElegiveis(dispositivo.ponto_id),
      obterVideoInstitucional(),
      basicoRepo.pontosPorConta(),
    ]);

  // Cobertura: fica quem tem ESTE ponto na fatia dele.
  //
  // A fatia é calculada UMA vez por conta e guardada: ela decide duas coisas
  // agora (se a conta entra nesta tela, e por quantos pontos o tempo dela se
  // divide na RN-49), e chamar duas vezes convida as duas a divergirem.
  //
  // `pontosBloqueados` (G.7) só entra na fatia de quem NÃO escolheu nada —
  // quem já escolheu um ponto bloqueado continua nele (`pontosDoAnunciante`
  // só filtra o sorteio automático, nunca a escolha explícita). Quem não
  // escolheu já é recalculado do zero a cada hora (não existe linha salva
  // pra essa conta em `anunciantes_pontos`), então aplicar o filtro aqui é
  // exatamente o que impede um anunciante NOVO, sem escolha própria ainda,
  // de cair de primeira num ponto que já parou de aceitar gente.
  const cobertura = new Map(
    todos.map((a) => [
      a.id,
      pontosDoAnunciante(
        { id: a.id, pontosIncluidos: a.pontos_incluidos, escolhidos: a.pontos_escolhidos },
        pontosNoAr,
        pontosBloqueados,
      ),
    ]),
  );
  const anunciantes = todos.filter((a) => cobertura.get(a.id).includes(dispositivo.ponto_id));
  const porId = Object.fromEntries(anunciantes.map((a) => [a.id, a]));

  // Frequência é por hora direto agora (migration 037) — sem conversão por
  // horário do ponto. O que o plano diz é o que roda, hora a hora (RN-39: o
  // plano compra SEGUNDOS da hora; quantas inserções isso vira depende da
  // peça que o cliente subiu — `numerosDaConta`).
  //
  // Camadas da hora (src/lib/pacing.js#montarHoraDeTv): `frequenciaBase` é a
  // base (T1); `compensacao` (RN-49 além da base) e `deficit` (reposição da
  // hora anterior) são T2; `banco` é T3.
  const entrada = anunciantes.map((a) => {
    const cobertos = cobertura.get(a.id).length;
    const n = numerosDaConta(a, cobertos, dispositivo.telas_do_ponto);
    // Saldo de Veiculação (banco de horas): quem tem saldo DISPONÍVEL (dívida
    // de mês anterior ainda não devolvida, menos o que outra hora já
    // programou e ainda não liquidou) pede exibições a mais — mas só no tempo
    // que T1 e T2 deixaram livre: nunca tira a entrega corrente de ninguém.
    // Capado no próprio pedido da hora, crescendo com a idade da dívida
    // (`multiplicadorPorIdade`). O saldo é em SEGUNDOS (migration 100);
    // aqui vira inserções da peça de hoje.
    //
    // O saldo é da conta, não da tela — mas a playlist é gerada UMA TELA
    // por vez, e quem cobre vários pontos tem esta função rodando em
    // paralelo pra cada um, todas lendo o MESMO saldo ainda intacto. Sem
    // dividir, uma conta em 3 pontos puxaria o saldo inteiro 3 vezes na
    // mesma hora. Divide pelos pontos cobertos (a mesma fatia da RN-49) e
    // pelos pontos do Básico da conta (migration 103), que puxam o mesmo
    // saldo — `pontosQuePuxamOSaldo`.
    // Arredonda pra cima: saldo menor que o número de pontos nunca podia
    // virar 0 pra sempre; a sobra é de no máximo uma exibição por ponto, e a
    // liquidação nunca abate mais que o saldo.
    //
    // O multiplicador de idade acelera o RITMO (teto por hora), nunca o
    // tamanho da dívida. Hora fechada não programa banco (nada toca).
    const bancoDaConta = saldosBanco[a.id];
    const multiplicadorBanco = bancoDaConta ? multiplicadorPorIdade(bancoDaConta.idadeMeses) : 1;
    // O atraso já inclui a falta da hora anterior, que a reposição (T2,
    // `deficits`) devolve nesta mesma hora: a parte dela sai do pedido do
    // banco, senão a mesma falta seria programada duas vezes.
    const vigenteNaHora = a.plano_vigente !== false;
    const atrasoNestePonto = Math.max(
      0,
      (bancoDaConta?.segundos || 0) / pontosQuePuxamOSaldo(cobertura.get(a.id), basicosPorConta.get(a.id)) -
        (vigenteNaHora ? deficits[a.id] || 0 : 0) * duracaoValida(n.duracaoSegundos),
    );
    const prioridadeBanco = aberta
      ? Math.min(
          Math.ceil(atrasoNestePonto / duracaoValida(n.duracaoSegundos)),
          Math.floor(n.total * multiplicadorBanco),
        )
      : 0;
    // Plano vencido/cancelado com saldo atrasado: só a devolução (T3).
    return {
      id: a.id,
      frequenciaBase: vigenteNaHora ? n.base : 0,
      compensacao: vigenteNaHora ? n.compensacao : 0,
      deficit: vigenteNaHora ? deficits[a.id] || 0 : 0,
      banco: prioridadeBanco,
      duracaoSegundos: n.duracaoSegundos,
      // Congelada junto com a hora: a capacidade desta tela nesta hora não
      // muda entre os polls (nem se a rede mudar no meio da hora). É
      // diagnóstico da capacidade — a dívida nasce do ciclo, não daqui.
      obrigacaoSegundos: vigenteNaHora ? segundosDeObrigacao({ ...n.obrigacaoHoraCheia, minutosAbertos }) : 0,
    };
  });

  // PARCELA BÁSICO (migration 103): soma na MESMA entrada da conta — uma
  // conta, uma linha por tela e hora (sem POP nem saldo em dobro), com a
  // parte do Básico guardada à parte (`obrigacaoBasicoSegundos` →
  // `segundos_obrigacao_basico`). Se o plano comercial também cobre este
  // ponto (a dona escolheu o próprio ponto), as duas origens se somam aqui.
  if (basico) {
    const existente = entrada.find((e) => e.id === basico.conta_id);
    const criativos = existente ? porId[basico.conta_id].criativos : basico.criativos;
    const duracao = existente ? existente.duracaoSegundos : duracaoMedia(criativos);
    const insercoes = aberta ? basicoRepo.insercoesDoBasicoNaHora(basico.segundos_por_hora, duracao, horaAtual) : 0;
    const obrigacaoBasico = basicoRepo.segundosDoBasicoNaHora(
      basico,
      duracao,
      horaAtual,
      minutosAbertos,
      dispositivo.telas_do_ponto,
    );
    if (existente) {
      existente.frequenciaBase += insercoes;
      existente.obrigacaoSegundos += obrigacaoBasico;
      existente.obrigacaoBasicoSegundos = obrigacaoBasico;
    } else {
      porId[basico.conta_id] = { criativos };
      const saldo = saldosBanco[basico.conta_id];
      // Mesma divisão da entrada comercial. A fatia comercial da dona vem de
      // `cobertura` quando ela está em `todos`; fora dele (a trava de ramo a
      // barra no próprio ponto), é refeita — só quando há saldo pra dividir.
      // Este ponto conta sempre: está puxando o saldo agora, mesmo antes de
      // o status dele chegar a "em operação".
      const comercialDaDona =
        cobertura.get(basico.conta_id) ??
        (aberta && saldo ? await coberturaComercialDaConta(basico.conta_id, pontosNoAr, pontosBloqueados) : []);
      const pontosDoBasico = [...(basicosPorConta.get(basico.conta_id) || []), dispositivo.ponto_id];
      const banco = aberta
        ? Math.min(
            Math.ceil(
              (saldo?.segundos || 0) / pontosQuePuxamOSaldo(comercialDaDona, pontosDoBasico) / duracaoValida(duracao),
            ),
            Math.floor(insercoes * (saldo ? multiplicadorPorIdade(saldo.idadeMeses) : 1)),
          )
        : 0;
      entrada.push({
        id: basico.conta_id,
        frequenciaBase: insercoes,
        compensacao: 0,
        deficit: deficits[basico.conta_id] || 0,
        banco,
        duracaoSegundos: duracao,
        obrigacaoSegundos: obrigacaoBasico,
        obrigacaoBasicoSegundos: obrigacaoBasico,
      });
    }
  }

  // Mídia própria: cada uma já entra pronta (frequência e cobertura são
  // dela mesma, sem RN-49 nem banco de horas — ver `midiasElegiveis`).
  for (const m of midiasProprias) {
    porId[m.id] = { criativos: m.criativos };
    entrada.push({ id: m.id, frequenciaBase: m.frequenciaBase, deficit: 0, duracaoSegundos: m.duracaoSegundos });
  }

  // Dono do ponto entra com a fatia da cota que cabe a esta tela. Não conta
  // como anunciante pagante nem gera contador — é permuta, não venda. Zerada
  // nas duas opções de comodato desde a 049, então na prática este bloco só
  // roda se alguém repuser a cota à mão no admin.
  if (doDono.length && cotaDaTela > 0) {
    porId.dono = { criativos: doDono };
    entrada.push({ id: 'dono', frequenciaBase: cotaDaTela, deficit: 0, duracaoSegundos: duracaoMedia(doDono) });
  }

  // Semente = (aparelho, hora). A ordem da hora passa a ser a MESMA em
  // qualquer instância e depois de qualquer reinício, que é o que permite
  // rodar em mais de uma instância sem cache em memória (item 4).
  const semente = `${dispositivo.id}-${horaAtual.toISOString()}`;

  // A HORA CONGELA (19/09/2026, pedido do dono: escolher um ponto novo não
  // pode esperar "a próxima hora cheia" — tem que entrar na hora que já
  // está no ar, sem empurrar quem já tinha vaga). `montarHoraDeTv` reposiciona
  // TODO MUNDO quando o total de participantes muda (é assim que o
  // espalhamento fica justo no início da hora), então a única forma de uma
  // chegada no meio da hora não mexer em quem já tinha vaga é nunca mais
  // rodar `montarHoraDeTv` sobre a lista cheia depois da primeira vez.
  //
  // Por isso a `entrada` da primeira geração desta hora vira `base`
  // congelada (migration 064): toda geração seguinte reprocessa a MESMA
  // `base` pela mesma semente — determinístico, sempre a mesma sequência —
  // e quem não estava nela ainda entra em `extras`, sempre no fim.
  const congelada = await congelamentoRepo.resolver(dispositivo.id, horaAtual, entrada, (base, extras) => {
    const idsConhecidos = new Set([...base.map((e) => e.id), ...extras]);
    return sequenciaAdicional(entrada.filter((e) => !idsConhecidos.has(e.id)));
  });
  const daHora = montarHoraDeTv(congelada.base, semente, videoInstitucional?.duracaoSegundos ?? DURACAO_INSTITUCIONAL);
  const idsExtras = congelada.extras;

  // A hora não coube em todo mundo: todos entregam menos do que contrataram.
  // O corte é proporcional, mas continua sendo entrega menor, e sem isto não
  // haveria sinal nenhum em lugar nenhum. Vira evento da métrica, que é onde
  // o dono olha — e é também o aviso de que a rede está vendida e é hora de
  // subir preço ou abrir ponto novo.
  if (daHora.cortou) {
    eventos.registrar('playlist:teto_corta', {
      dispositivo_id: dispositivo.id,
      ponto_id: dispositivo.ponto_id,
      pedido_segundos: daHora.pedidoSegundos,
      cabe_segundos: daHora.cabeSegundos,
      anunciantes: entrada.length,
    });
  }

  // Quanto da hora está vendido. Registrado só quando a tela passa de 80%:
  // é o aviso antecipado do corte acima, com tempo de agir antes de alguém
  // receber menos do que comprou.
  if (!daHora.cortou && daHora.ocupacao >= 80) {
    eventos.registrar('playlist:hora_quase_cheia', {
      dispositivo_id: dispositivo.id,
      ponto_id: dispositivo.ponto_id,
      ocupacao: daHora.ocupacao,
    });
  }

  // `programados` já vem sem o institucional. O dono do ponto sai aqui: a cota
  // é permuta, não venda, e não entra no relatório de entrega de ninguém.
  // Mídia própria também sai — não é anunciante nem venda: o contador dela é
  // `midias_exibicoes_contador` (gravado por `gravarProgramadasDaMidia`, logo
  // abaixo), e `anunciante_id` desta tabela é int e não aceitaria `midia:N`. O filtro em `idsExtras`
  // (`id !== 'dono' && !String(id).startsWith('midia:')`) existe porque,
  // sem ele, um dos dois chegando no meio da hora (`extras`, quando a base
  // já congelou sem ele) voltava pro objeto pela soma logo abaixo.
  const contagem = { ...daHora.programados };
  delete contagem.dono;
  const pedidos = { ...daHora.pedidosPorAnunciante };
  delete pedidos.dono;
  // TODA mídia sai da conta comercial — não só as elegíveis agora. Mídia
  // pausada/encerrada no meio da hora continua na `base` congelada (e em
  // `programados`), e só apagar as de `midiasProprias` deixava `midia:N` ir
  // pro INSERT de `exibicoes_contador` (anunciante_id int): a playlist
  // daquela tela dava erro até a hora virar (achado de 27/09/2026).
  for (const id of Object.keys(contagem)) if (id.startsWith('midia:')) delete contagem[id];
  for (const id of Object.keys(pedidos)) if (id.startsWith('midia:')) delete pedidos[id];
  for (const id of idsExtras) {
    if (id === 'dono' || String(id).startsWith('midia:')) continue;
    contagem[id] = (contagem[id] || 0) + 1;
    pedidos[id] = (pedidos[id] || 0) + 1;
  }
  // Banco de horas: a hora só PROGRAMA (`vezes_banco`); o saldo é abatido
  // pela liquidação, com o que a TV confirmou, depois que a hora fecha
  // (src/bancohoras/apuracao.js#liquidarBancoConfirmado — job diário e
  // mensal). Até 25/09/2026 drenava aqui, no programado: TV desligada
  // consumia a dívida sem entregar nada.
  const banco = { ...daHora.bancoProgramados };
  if (aberta) {
    // Obrigação de cada conta nesta tela nesta hora: a da base congelada (a
    // primeira geração da hora fixa o número); quem chegou depois (`extras`)
    // deve só o que sobra da hora aberta a partir de agora.
    const obrigacao = {};
    const atualPorId = new Map(entrada.map((e) => [String(e.id), e]));
    for (const e of congelada.base) {
      if (e.id === 'dono' || String(e.id).startsWith('midia:')) continue;
      const segundos = e.obrigacaoSegundos ?? atualPorId.get(String(e.id))?.obrigacaoSegundos ?? 0;
      const basicoDaHora =
        e.obrigacaoSegundos != null ? e.obrigacaoBasicoSegundos : atualPorId.get(String(e.id))?.obrigacaoBasicoSegundos;
      obrigacao[e.id] = { segundos, duracao: e.duracaoSegundos, basico: basicoDaHora || 0 };
    }
    const desde = new Date(Math.min(Math.max(new Date(agora).getTime(), horaAtual.getTime()), fimDaHora.getTime()));
    const restantes = minutosAbertosNaHora(dispositivo, desde, fimDaHora);
    for (const id of new Set(idsExtras)) {
      if (id === 'dono' || String(id).startsWith('midia:') || obrigacao[id]) continue;
      const atual = atualPorId.get(String(id));
      if (!atual) continue;
      obrigacao[id] = {
        segundos: Math.round((atual.obrigacaoSegundos * restantes) / minutosAbertos),
        duracao: atual.duracaoSegundos,
        basico: Math.round(((atual.obrigacaoBasicoSegundos || 0) * restantes) / minutosAbertos),
      };
    }
    await gravarProgramados(dispositivo, horaAtual, contagem, pedidos, banco, obrigacao, minutosAbertos);
  }

  // Ponto de partida do revezamento gira por hora (19/09/2026, furo real
  // encontrado a partir de um relato do dono: "rodou só uma vez e não rodou
  // de novo"). Sem isto, `vez` sempre começava do zero A CADA HORA — pra
  // conta que só cabe 1 inserção por hora (plano pequeno, começo de conta),
  // `criativos[0]` (o mais novo, por causa do ORDER BY created_at DESC lá
  // em cima) ganhava a vaga TODA hora, pra sempre, e qualquer criativo mais
  // antigo nunca era escolhido — não porque a imagem tivesse alguma
  // limitação (imagem já virava vídeo de verdade, com duração real, muito
  // antes deste ponto), mas porque o revezamento reiniciava do mesmo lugar
  // toda hora. Girar o início pela hora garante que, ao longo de
  // `criativos.length` horas, todo criativo passa pela vaga pelo menos uma
  // vez, mesmo quando só cabe uma inserção por vez.
  const horaEpoch = Math.floor(horaAtual.getTime() / 3_600_000);
  const usados = {};
  // Identidade do item pro contrato novo (migration 065, app Android nativo
  // `sancompany/playlist.mostrai`): `janelaId` marca a hora congelada desta
  // tela, e `itemProgramacaoId` soma a POSIÇÃO na sequência congelada — antes
  // do `.filter(Boolean)` abaixo remover vagas que saíram de elegibilidade no
  // meio da hora, senão um buraco no meio deslocaria o índice de tudo que vem
  // depois a cada poll. O tipo/anunciante vai dentro do próprio id (formato
  // em docs/api.md) pra `/played` não precisar reconstruir a hora pra saber
  // quem creditar — só decodifica a string que ele mesmo devolveu.
  const janelaId = `${dispositivo.id}|${horaAtual.toISOString()}`;
  // `extras` sempre depois de `daHora.itens`: é o "sempre no fim" pedido —
  // quem chegou no meio da hora nunca disputa posição com quem já rodava.
  const itens = [...daHora.itens, ...idsExtras]
    .map((id, indice) => {
      // Inventário vago: sem vídeo institucional configurado, o Player mostra
      // o próprio cartão institucional pelo tempo do item — não tem url, não
      // é de ninguém e não conta exibição. Com o vídeo configurado
      // (25/09/2026, `POST /admin/video-institucional`), o Player baixa e
      // toca ele como qualquer mídia (`url`/`contentHash`).
      if (id === ID_INSTITUCIONAL) {
        return {
          itemProgramacaoId: `${janelaId}|${indice}|inst`,
          criativoId: null,
          anuncianteId: null,
          autoanuncio: false,
          institucional: true,
          contabiliza: false,
          url: videoInstitucional?.url ?? null,
          duracaoSegundos: videoInstitucional?.duracaoSegundos ?? DURACAO_INSTITUCIONAL,
          ...(videoInstitucional?.contentHash ? { contentHash: videoInstitucional.contentHash } : {}),
        };
      }
      // Congelou numa hora e saiu da elegibilidade depois (ponto desmarcado
      // de novo, criativo reprovado): a vaga dele só desaparece, não é
      // reaproveitada por ninguém — não é erro, é o fim natural de uma
      // escolha desfeita no meio da hora.
      const dados = porId[id];
      if (!dados?.criativos?.length) return null;
      const { criativos } = dados;
      const vez = usados[id] || 0;
      usados[id] = vez + 1;
      const inicio = horaEpoch % criativos.length;
      const criativo = criativos[(inicio + vez) % criativos.length];
      const autoanuncio = id === 'dono';
      // Mídia própria tem arquivo de verdade (ao contrário do item
      // institucional de preenchimento, `ID_INSTITUCIONAL` acima, que não
      // tem url nenhuma) — por isso `institucional: false` aqui: aquele
      // campo já tem um significado fixo no player (mostra o cartão
      // genérico "este espaço pode ser seu", nunca troca por vídeo real) e
      // reaproveitá-lo pra mídia própria trocaria o vídeo pelo cartão gená.
      // `anuncianteId: null`: mídia própria não é de anunciante nenhum.
      const midiaPropria = typeof id === 'string' && id.startsWith('midia:');
      return {
        itemProgramacaoId: `${janelaId}|${indice}|${autoanuncio ? 'dono' : id}`,
        criativoId: criativo.criativoId != null ? String(criativo.criativoId) : null,
        anuncianteId: autoanuncio || midiaPropria ? null : id,
        autoanuncio,
        institucional: false,
        // `contabiliza` é o que faz o Player gerar proof-of-play (contrato §7;
        // conferido no app, FilaProofOfPlay.registrarInicio: só olha este
        // campo no contrato novo). Autoanúncio (permuta) e institucional
        // (preenchimento) continuam fora. Mídia Mostraí PASSOU a contar
        // (27/09/2026): a métrica dela ("quantas vezes tocou de verdade") só
        // existe com comprovante — ela não é venda, então o crédito vai pra
        // `midias_exibicoes_contador`, nunca pra `exibicoes_contador`.
        contabiliza: !autoanuncio,
        url: criativo.url,
        duracaoSegundos: criativo.duracaoSegundos,
        // SHA-256 do arquivo servido (docs/player-mvp-contract.md §7): o
        // Player guarda por conteúdo e confere o download. Sem hash (criativo
        // anterior à migration 083, ou URL trocada à mão) o campo não vai, e
        // o Player guarda por criativoId.
        ...(criativo.contentHash ? { contentHash: criativo.contentHash } : {}),
      };
    })
    .filter(Boolean);

  await gravarProgramadasDaMidia(dispositivo, horaAtual, itens);

  return {
    versaoContrato: 2,
    janelaId,
    janelaInicio: horaAtual.toISOString(),
    janelaFim: new Date(horaAtual.getTime() + 3_600_000).toISOString(),
    servidorAgora: new Date().toISOString(),
    itens,
  };
}

// Obrigação por hora cheia de cada conta que cobre esta tela HOJE — para a
// hora aberta em que a tela não pediu playlist (sem sinal): a obrigação
// existia, a entrega não (src/bancohoras/obrigacao.js). Mesma elegibilidade,
// cobertura e conta da geração (`numerosDaConta`); a validade do plano é
// conferida hora a hora por quem chama (`dataExpiracao`). `desde`: o começo
// da janela olhada — o Básico que terminou antes dela não interessa.
async function obrigacoesDaTela(dispositivo, { desde = new Date(Date.now() - 62 * 86_400_000) } = {}) {
  const cotaDaTela = dividirCota(dispositivo.cota_autoanuncio_slots_hora, dispositivo.telas_do_ponto);
  const [todos, pontosNoAr, pontosBloqueados] = await Promise.all([
    anunciantesElegiveis(
      dispositivo.categoria_id,
      cotaDaTela > 0 ? dispositivo.dono_conta_id : null,
      dispositivo.dono_conta_id,
      dispositivo.ponto_id,
      { qualquerValidade: true },
    ),
    pontosEmOperacao(),
    pontosRepo.idsBloqueadosParaEscolha(),
  ]);
  const contas = [];
  for (const a of todos) {
    const cobertura = pontosDoAnunciante(
      { id: a.id, pontosIncluidos: a.pontos_incluidos, escolhidos: a.pontos_escolhidos },
      pontosNoAr,
      pontosBloqueados,
    );
    if (!cobertura.includes(dispositivo.ponto_id)) continue;
    const n = numerosDaConta(a, cobertura.length, dispositivo.telas_do_ponto);
    contas.push({
      anuncianteId: a.id,
      dataExpiracao: a.data_expiracao,
      duracaoSegundos: n.duracaoSegundos,
      obrigacaoHoraCheia: n.obrigacaoHoraCheia,
      basicos: [],
    });
  }
  // Plano Básico do ponto (migration 103): cada linha guarda início e fim, e
  // quem chama confere hora a hora (`basicoRepo.valiaNaHora`) — a hora sem
  // sinal paga o Básico que valia NAQUELA hora, não o de hoje. Soma na mesma
  // entrada da conta quando ela também tem o comercial neste ponto.
  //
  // `duracaoBasico`: a peça que a geração ao vivo usa quando só o Básico vale
  // na hora (o comercial vencido naquela hora, ou fora deste ponto) — as
  // peças da vaga do Básico (`pecasDoBasico`, a mesma escolha do ao vivo),
  // não a média do plano. Com o comercial valendo, as duas origens rodam a
  // peça da conta (`duracaoSegundos`), como ao vivo.
  const basicos = await basicoRepo.doPontoDesde(dispositivo.ponto_id, desde);
  for (const b of basicos) {
    const { rows } = await pool.query('SELECT suspenso FROM anunciantes WHERE id = $1', [b.conta_id]);
    if (!rows[0] || rows[0].suspenso) continue;
    const pecas = await basicoRepo.pecasDoBasico(b);
    if (!pecas.length) continue;
    const duracaoBasico = duracaoMedia(pecas);
    let conta = contas.find((c) => c.anuncianteId === b.conta_id);
    if (!conta) {
      conta = {
        anuncianteId: b.conta_id,
        dataExpiracao: null,
        duracaoSegundos: duracaoBasico,
        obrigacaoHoraCheia: null,
        basicos: [],
      };
      contas.push(conta);
    }
    conta.duracaoBasico = duracaoBasico;
    conta.basicos.push(b);
  }
  return contas;
}

// Proof-of-play offline (docs/player-mvp-contract.md §8): o evento vale até
// 7 DIAS depois do FIM da janela original — não pela hora de chegada. Uma
// TV pode ficar dias sem rede e mandar tudo depois; a exibição aconteceu e é
// do anunciante. Contado do início da hora: os 60 min dela + 7 dias. A
// liquidação do banco de horas espera o mesmo prazo
// (src/bancohoras/apuracao.js), senão uma confirmação atrasada cairia numa
// hora já liquidada e contaria duas vezes.
const PRAZO_PROOF_OF_PLAY_DIAS = 7;
const PRAZO_PROOF_OF_PLAY_MIN = 60 + PRAZO_PROOF_OF_PLAY_DIAS * 24 * 60;
// Evento de uma hora que ainda nem começou só pode ser relógio adulterado;
// 1 min cobre a diferença entre o relógio do banco e o do processo.
const TOLERANCIA_FUTURO_MIN = 1;

// Credita com TETO: `vezes_confirmadas` nunca passa de `vezes_programadas`
// (o que aquela hora prometeu). Qualquer reenvio da TV que escape da
// deduplicação por `execucaoId` bate aqui. `db`: o client da transação de
// `execucoes-repository.js`, que reserva o `execucaoId` e credita juntos.
async function creditarConfirmacao(anuncianteId, dispositivoId, janela, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE exibicoes_contador SET vezes_confirmadas = vezes_confirmadas + 1
      WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3
        AND vezes_confirmadas < vezes_programadas`,
    [anuncianteId, dispositivoId, janela],
  );
  return rowCount > 0;
}

async function existeConfirmacao(anuncianteId, dispositivoId, janela, db = pool) {
  const { rows } = await db.query(
    `SELECT 1 FROM exibicoes_contador
      WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3`,
    [anuncianteId, dispositivoId, janela],
  );
  return rows.length > 0;
}

// O anunciante estava na playlist CONGELADA desta tela nesta hora (base ou
// extras, migration 064)? Fato do servidor, gravado quando a hora foi
// servida — não depende de nada que a TV mande além do id.
async function estavaNaHoraCongelada(dispositivoId, janela, anuncianteId, db = pool) {
  const { rows } = await db.query(
    `SELECT 1 FROM playlist_hora_congelada
      WHERE dispositivo_id = $1 AND janela_hora = $2
        AND (EXISTS (SELECT 1 FROM jsonb_array_elements(base) b WHERE b->>'id' = $3)
             OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(extras) x WHERE x = $3))`,
    [dispositivoId, janela, String(anuncianteId)],
  );
  return rows.length > 0;
}

// Quando a exibição aconteceu, pra "primeira/última exibição": o servidor não
// confia no relógio da TV (contrato §8), então o `iniciadoEm` do Player só
// vale PRESO dentro da hora da janela (com 5 min pro fim de uma peça que
// começou no último minuto) e nunca no futuro. Sem ele (ou ilegível), a
// chegada — também presa na janela, pro lote offline de dias depois não
// virar "tocou hoje".
//
// `iniciadoEm` legível mas FORA da janela (relógio da TV errado) conta como
// ausente — vale a chegada (revisão Codex do PR #83): preso ao início da
// hora, ele caía antes da aprovação de uma peça aprovada no meio da hora, e
// ela nunca virava "no ar" apesar de creditada.
function instanteDaExibicao(iniciadoEm, horaJanela, agora) {
  const inicio = horaJanela.getTime();
  const chegada = new Date(agora).getTime();
  const teto = Math.max(Math.min(chegada, inicio + 65 * 60_000), inicio);
  const informado = typeof iniciadoEm === 'string' ? new Date(iniciadoEm).getTime() : Number.NaN;
  const base = Number.isFinite(informado) && informado >= inicio && informado <= teto ? informado : chegada;
  return new Date(Math.min(Math.max(base, inicio), teto));
}

// Criativo que tocou de verdade: é isto que separa "aprovado" de "no ar"
// (src/anunciantes/entrada-no-ar.js). LEAST/GREATEST: lote offline chega fora
// de ordem e não pode "atrasar" a primeira nem "adiantar" a última.
// `anuncianteId` amarra: o `criativoId` do evento é informativo (contrato
// §8), então só vale se a peça é mesmo daquela conta.
//
// Devolve true quando ESTA exibição é a que põe a peça no ar no contexto
// atual (antes, nenhuma exibição depois da aprovação) — quem chama avisa o
// painel e o admin por SSE, depois do COMMIT. O subselect `antes` lê a linha
// como estava antes deste UPDATE.
async function marcarExibicaoDoCriativo(criativoId, anuncianteId, instante, db) {
  // Dentro do int4 da coluna: "3000000000" passava na regex, estourava no
  // Postgres e derrubava o lote inteiro de comprovantes do aparelho — que
  // então repetia o mesmo lote até expirar (finalização, 28/09/2026).
  if (criativoId == null || !/^\d{1,10}$/.test(String(criativoId)) || Number(criativoId) > 2147483647) return false;
  // `primeira_exibicao_em` é do CONTEXTO atual (desde `aprovado_em`):
  // reaprovar recomeça — a primeira de antes é substituída pela primeira
  // exibição depois da nova aprovação, e comprovante atrasado do contexto
  // anterior não mexe nela (revisão Codex do PR #83). `ultima` é o fato
  // mais recente, de qualquer contexto.
  const { rows } = await db.query(
    `UPDATE criativos c
        SET primeira_exibicao_em = CASE
              WHEN $3 < COALESCE(c.aprovado_em, c.created_at) THEN c.primeira_exibicao_em
              WHEN c.primeira_exibicao_em IS NULL
                OR c.primeira_exibicao_em < COALESCE(c.aprovado_em, c.created_at) THEN $3
              ELSE LEAST(c.primeira_exibicao_em, $3)
            END,
            ultima_exibicao_em = GREATEST(COALESCE(c.ultima_exibicao_em, $3), $3)
       FROM (SELECT id, ultima_exibicao_em FROM criativos WHERE id = $1) antes
      WHERE c.id = antes.id AND c.anunciante_id = $2
      RETURNING (antes.ultima_exibicao_em IS NULL
                 OR antes.ultima_exibicao_em < COALESCE(c.aprovado_em, c.created_at))
                AND $3 >= COALESCE(c.aprovado_em, c.created_at) AS entrou_no_ar`,
    [Number(criativoId), anuncianteId, instante],
  );
  return rows[0]?.entrou_no_ar === true;
}

// Mídia Mostraí: credita com o MESMO teto do contador comercial (confirmada
// nunca passa de programada) e marca a primeira/última confirmação — é daí
// que saem "última exibição" e "primeira exibição" da mídia.
async function creditarMidia(midiaId, dispositivoId, janela, instante, db) {
  const { rows } = await db.query(
    `UPDATE midias_exibicoes_contador
        SET vezes_confirmadas = vezes_confirmadas + 1,
            primeira_confirmacao_em = LEAST(COALESCE(primeira_confirmacao_em, $4), $4),
            ultima_confirmacao_em = GREATEST(COALESCE(ultima_confirmacao_em, $4), $4)
      WHERE midia_id = $1 AND dispositivo_id = $2 AND janela_hora = $3
        AND vezes_confirmadas < vezes_programadas
      RETURNING (SELECT criativo_id FROM midias_proprias WHERE id = $1) AS criativo_id,
                (SELECT anunciante_id FROM criativos c JOIN midias_proprias mp ON mp.criativo_id = c.id
                  WHERE mp.id = $1) AS anunciante_id`,
    [midiaId, dispositivoId, janela, instante],
  );
  if (rows[0]) {
    await marcarExibicaoDoCriativo(rows[0].criativo_id, rows[0].anunciante_id, instante, db);
    return 'contabilizado';
  }
  const existe = await db.query(
    'SELECT 1 FROM midias_exibicoes_contador WHERE midia_id = $1 AND dispositivo_id = $2 AND janela_hora = $3',
    [midiaId, dispositivoId, janela],
  );
  return existe.rows.length ? 'teto_atingido' : 'janela_desconhecida';
}

// Decodifica o `itemProgramacaoId` (formato montado em `gerarPlaylistDaHora`:
// `dispositivoId|horaISO|indice|tipo`) e credita. Devolve SEMPRE um dos 6
// status finais do contrato (§8) — nunca lança por conteúdo do evento: um
// evento ruim responde `item_invalido` e o resto do lote segue.
//
// `extra` (27/09/2026): `criativoId` e `iniciadoEm` do evento — informativos,
// usados só pra marcar a primeira/última exibição da peça (nunca pra decidir
// se credita).
async function confirmarExecucao(dispositivoIdEsperado, itemProgramacaoId, janelaId, agora, db = pool, extra = {}) {
  if (typeof itemProgramacaoId !== 'string' || typeof janelaId !== 'string') return 'item_invalido';
  const partes = itemProgramacaoId.split('|');
  if (partes.length !== 4) return 'item_invalido';
  const [dispositivoIdStr, horaISO, indiceStr, tipo] = partes;
  if (!/^\d{1,10}$/.test(dispositivoIdStr) || !/^\d{1,6}$/.test(indiceStr)) return 'item_invalido';
  if (janelaId !== `${dispositivoIdStr}|${horaISO}`) return 'item_invalido';
  const horaJanela = new Date(horaISO);
  // Só a forma exata que o servidor emitiu: hora cheia, ISO com ms e Z.
  if (Number.isNaN(horaJanela.getTime()) || horaJanela.toISOString() !== horaISO) return 'item_invalido';
  if (horaJanela.getTime() % 3_600_000 !== 0) return 'item_invalido';
  if (Number(dispositivoIdStr) !== Number(dispositivoIdEsperado)) return 'janela_desconhecida';

  // `dono` (autoanúncio) e `inst` (institucional) nunca contam — o Player não
  // cria execução para item com `contabiliza: false`. `midia:N` (Mídia
  // Mostraí) conta desde 27/09/2026, no contador dela.
  const midia = /^midia:(\d{1,10})$/.exec(tipo);
  if (!midia && !/^\d{1,10}$/.test(tipo)) return 'item_invalido';
  const idNumerico = Number(midia ? midia[1] : tipo);
  if (idNumerico <= 0 || idNumerico > 2147483647) return 'item_invalido';

  const diffMin = (new Date(agora).getTime() - horaJanela.getTime()) / 60_000;
  if (diffMin < -TOLERANCIA_FUTURO_MIN || diffMin > PRAZO_PROOF_OF_PLAY_MIN) return 'janela_expirada';

  // Fato do servidor: estava na playlist congelada daquela tela e hora (a
  // mídia entra na base como `midia:N`, o anunciante pelo id).
  if (!(await estavaNaHoraCongelada(dispositivoIdEsperado, horaJanela, midia ? tipo : idNumerico, db))) {
    return 'janela_desconhecida';
  }
  const instante = instanteDaExibicao(extra.iniciadoEm, horaJanela, agora);
  if (midia) return creditarMidia(idNumerico, dispositivoIdEsperado, horaJanela, instante, db);

  const anuncianteId = idNumerico;
  if (await creditarConfirmacao(anuncianteId, dispositivoIdEsperado, horaJanela, db)) {
    if (await marcarExibicaoDoCriativo(extra.criativoId, anuncianteId, instante, db)) {
      // Primeira exibição do contexto: `extra.entradas` é lido por quem
      // chama (execucoes-repository.js) pra avisar depois do COMMIT.
      extra.entradas?.push({ anuncianteId, criativoId: Number(extra.criativoId) });
    }
    return 'contabilizado';
  }
  if (await existeConfirmacao(anuncianteId, dispositivoIdEsperado, horaJanela, db)) return 'teto_atingido';
  return 'janela_desconhecida';
}

module.exports = {
  gerarPlaylistDaHora,
  obrigacoesDaTela,
  minutosAbertosNaHora,
  confirmarExecucao,
  marcarExibicaoDoCriativo,
  limiteDeCriativos,
  PRAZO_PROOF_OF_PLAY_DIAS,
  PRAZO_PROOF_OF_PLAY_MIN,
};
