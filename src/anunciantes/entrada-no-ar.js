const pool = require('../db/pool');
const pontosRepo = require('../pontos/repository');
const concorrencia = require('../categorias/concorrencia');
const { coberturaDoAnunciante } = require('../lib/pacing');
const { escolhasSql, lerEscolhas } = require('../lib/mostrai-movel');
const { cabeNoTeto } = require('../pontos/basico');
const { operacaoDoPonto, minutosOperando } = require('../lib/operacao-tela');
const { horarioEmVigorSql, categoriaEmVigorSql, casaEmVigorSql, inventarioSql } = require('../lib/contexto-do-ponto');

// Primeira entrada no ar (estação de distribuição, 27/09/2026): entre
// "Aprovado" e "rodando" não pode haver limbo. O estado de cada peça é
// DERIVADO aqui, no servidor — o painel e o admin só exibem.
//
// Como o agendador funciona de verdade (é disso que a previsão sai):
//   - CURRENT_SCHEDULER_BOUNDARY: a playlist é por TELA e por HORA CHEIA
//     (src/playlist/gerador.js#gerarPlaylistDaHora). Não existe agenda além
//     da hora corrente: a próxima hora só existe quando a TV a pede.
//   - PLAYLIST_FREEZE_RULE: o primeiro GET da hora congela a `base`
//     (migration 064); gerações seguintes reprocessam a mesma base.
//   - MID_HOUR_CHANGE_BEHAVIOR: peça aprovada no meio da hora entra em
//     `extras`, NO FIM da sequência da hora — que já enche os 60 min
//     (institucional completa o que sobra). O Player reancora pelo
//     `itemProgramacaoId` e segue a ordem (ReposicionamentoPlaylist.kt), então
//     o fim só chega perto da virada, quando a janela troca e ele
//     reposiciona pela hora nova. Tocar na hora da aprovação é sorte, não
//     promessa: a PRIMEIRA JANELA PREVISTA é a primeira hora cheia depois da
//     aprovação em que um ponto da cobertura funciona a hora inteira.
//
// Estados de uma peça aprovada (em ordem):
//   APROVADO — aprovada mas sem janela possível agora (sem plano vigente,
//     conta suspensa, fora do limite de peças simultâneas, nenhum ponto da
//     cobertura no ar/aberto). Vem com `motivo`.
//   PROGRAMADO — tem janela prevista; a TV ainda não pediu essa hora.
//   AGUARDANDO_PRIMEIRA_EXIBICAO — a hora começou e a conta ESTÁ na
//     playlist servida (linha em `exibicoes_contador` com programadas > 0);
//     falta o comprovante chegar.
//   NO_AR — existe proof-of-play CONFIRMADO desta peça depois do início do
//     contexto (`ultima_exibicao_em >= aprovado_em`). Nunca a aprovação,
//     a playlist gerada ou o download.
//   ATRASADO — passou a janela + tolerância e nenhum comprovante chegou.
//
// TOLERÂNCIA = horas de rodízio × 60 min + 10 min, contando só horas em que
// a cobertura funciona:
//   - horas de rodízio: cada hora a conta usa `criativos[(hora + vez) % N]`
//     (gerador.js, "Ponto de partida do revezamento gira por hora"); com k
//     inserções por hora, uma peça específica aparece em até ⌈N / k⌉ horas.
//     k vem da hora programada quando existe (fato); sem ela, k = 1 (o pior
//     caso — plano pequeno, uma inserção por hora).
//   - dentro da hora a inserção pode cair em qualquer minuto (`espalhar`),
//     por isso a hora inteira conta.
//   - 10 min: o Player envia o lote de comprovantes a cada 60 s
//     (INTERVALO_FLUSH_MS) e, falhando, recua 5 s → 15 s → 60 s → 5 min
//     (FilaProofOfPlay.BACKOFF_MS): 10 min cobrem a peça terminar, o lote
//     sair e até quatro tentativas falharem, sem esperar o degrau de 15 min
//     (que já é rede fora, e deve virar atraso visível).
const MARGEM_COMPROVANTE_MIN = 10;
const HORA_MS = 3_600_000;
// Até onde procurar a próxima hora aberta: uma semana cobre qualquer grade
// semanal (e um feriado prolongado).
const HORIZONTE_HORAS = 8 * 24;

const ESTADOS = {
  APROVADO: 'APROVADO',
  PROGRAMADO: 'PROGRAMADO',
  AGUARDANDO: 'AGUARDANDO_PRIMEIRA_EXIBICAO',
  NO_AR: 'NO_AR',
  ATRASADO: 'ATRASADO',
};

function horaCheiaSeguinte(instante) {
  const t = new Date(instante).getTime();
  return new Date(Math.ceil(t / HORA_MS) * HORA_MS);
}

// "O ponto funciona nesta hora" = aberto a hora INTEIRA — uma hora em que
// ele abre às 08:30 não garante a vaga da peça (ela pode cair às 08:10, com
// a TV apagada). Cache por (ponto, hora): a mesma pergunta se repete pra
// cada peça e cada conta da mesma requisição.
function criarRelogioDaCobertura(pontos) {
  const operacoes = new Map(pontos.map((p) => [p.id, operacaoDoPonto(p.horario_semanal)]));
  const cache = new Map();
  const abertoNaHora = (pontoId, hora) => {
    const chave = `${pontoId}|${hora.getTime()}`;
    if (!cache.has(chave)) {
      const minutos = minutosOperando(operacoes.get(pontoId), hora, new Date(hora.getTime() + HORA_MS));
      cache.set(chave, minutos >= 60);
    }
    return cache.get(chave);
  };
  const algumAberto = (hora) => pontos.some((p) => abertoNaHora(p.id, hora));
  return { abertoNaHora, algumAberto };
}

function primeiraHoraAberta(relogio, desde) {
  for (let i = 0; i < HORIZONTE_HORAS; i++) {
    const hora = new Date(desde.getTime() + i * HORA_MS);
    if (relogio.algumAberto(hora)) return hora;
  }
  return null;
}

// Fim da n-ésima hora aberta a partir de `janela` (inclusive) + a margem.
function prazoDaJanela(relogio, janela, horasDeRodizio) {
  let contadas = 0;
  for (let i = 0; i < HORIZONTE_HORAS * 2; i++) {
    const hora = new Date(janela.getTime() + i * HORA_MS);
    if (!relogio.algumAberto(hora)) continue;
    contadas++;
    if (contadas >= horasDeRodizio) return new Date(hora.getTime() + HORA_MS + MARGEM_COMPROVANTE_MIN * 60_000);
  }
  return null;
}

// Os pontos em que a conta pode tocar AGORA — a mesma conta do gerador:
// fatia de `pontosDoAnunciante` (escolha ou sorteio estável) e a trava de
// ramo (a conta do mesmo ramo do ponto, ou de um ramo concorrente direto
// dele, não entra, salvo a dona que escolheu o próprio ponto —
// gerador.js#anunciantesElegiveis, categorias/concorrencia.js).
// limite: a cota de autoanúncio (`excluirContaId` do gerador) não entra —
// zerada em todas as telas desde a migration 049.
// Plano Básico do ponto (migration 103): o próprio ponto de cada Básico
// ativo entra na cobertura, sem trava de ramo (é o estabelecimento da conta)
// e sem ocupar vaga da escolha comercial.
// `redeInteira` (saldo de hospedagem, migration 113): as horas gratuitas
// valem em qualquer ponto no ar — só a trava de ramo filtra.
async function coberturaDaConta(conta, plano, db = pool, basicos = [], { redeInteira = false } = {}) {
  const [{ rows: escolhas }, { rows: noAr }, bloqueados, concorrentes] = await Promise.all([
    // Pontos e a opção Mostraí Móvel, na ordem da escolha (migration 115).
    db.query(`SELECT ${escolhasSql('a')} AS escolhas FROM anunciantes a WHERE a.id = $1`, [conta.id]),
    db.query(
      // Ramo, casa e horário EM VIGOR — os mesmos que o gerador usa na tela
      // (src/lib/contexto-do-ponto.js): no ponto móvel mudam com a
      // hospedagem ou o evento em curso.
      `SELECT p.id, p.tipo, ${horarioEmVigorSql('p')} AS horario_semanal, ${categoriaEmVigorSql('p')} AS categoria_id,
              ${casaEmVigorSql('p')} AS casa_id
         FROM pontos p WHERE p.status = 'em_operacao' AND ${inventarioSql('p')} ORDER BY p.id`,
    ),
    pontosRepo.idsBloqueadosParaEscolha(),
    concorrencia.concorrentesDe(conta.categoria_id, db),
  ]);
  const escolhidos = lerEscolhas(escolhas[0]?.escolhas);
  const ids = plano
    ? coberturaDoAnunciante(
        { id: conta.id, pontosIncluidos: plano.pontos_incluidos, escolhidos },
        noAr.map((p) => p.id),
        bloqueados,
        noAr.filter((p) => p.tipo === 'movel').map((p) => p.id),
      ).pontos
    : [];
  const naFatia = new Set(redeInteira ? noAr.map((p) => p.id) : ids);
  const proprios = new Set(basicos.map((b) => b.ponto_id));
  return noAr.filter(
    (p) =>
      proprios.has(p.id) ||
      (naFatia.has(p.id) &&
        (!concorrencia.bloqueia(p.categoria_id, conta.categoria_id, concorrentes) ||
          (p.casa_id === conta.id && escolhidos.includes(p.id)))),
  );
}

// Primeira hora PROGRAMADA de verdade (a TV pediu e a conta estava na
// playlist) a partir de `desde`, só em hora em que o ponto daquela tela
// estava aberto: a TV continua pedindo playlist fora do horário (e o
// gerador grava programadas mesmo assim), mas com a tela apagada nada toca.
async function primeiraHoraProgramada(contaId, desde, db = pool) {
  const { rows } = await db.query(
    `SELECT e.janela_hora, e.vezes_programadas, p.id AS ponto_id, p.horario_semanal
       FROM exibicoes_contador e
       JOIN dispositivos d ON d.id = e.dispositivo_id
       JOIN pontos p ON p.id = d.ponto_id
      WHERE e.anunciante_id = $1 AND e.janela_hora >= $2 AND e.vezes_programadas > 0
      ORDER BY e.janela_hora, e.vezes_programadas DESC
      LIMIT 500`,
    [contaId, desde],
  );
  if (!rows.length) return null;
  const relogio = criarRelogioDaCobertura(rows.map((r) => ({ id: r.ponto_id, horario_semanal: r.horario_semanal })));
  const aberta = rows.find((r) => relogio.abertoNaHora(r.ponto_id, new Date(r.janela_hora)));
  return aberta ? { janela: new Date(aberta.janela_hora), insercoes: aberta.vezes_programadas } : null;
}

// Decide o estado de cada peça aprovada. `criativos`: linhas de `criativos`
// com `em_rodizio` (dentro do limite de peças simultâneas do plano, conta
// veiculando). `teto`: o teto de peça da conta hoje — só com o Básico, a
// peça mais longa que ele não roda nunca, e o motivo diz isso em vez de
// "espere outra sair". Devolve Map(id → entrada).
async function entradaNoArDasPecas({
  conta,
  plano,
  basicos = [],
  teto = null,
  contaVeicula,
  saldoHospedagem = 0,
  criativos,
  agora = new Date(),
  db = pool,
}) {
  const resultado = new Map();
  const aprovadas = criativos.filter((c) => c.status === 'aprovado');
  if (!aprovadas.length) return resultado;
  const emRodizio = aprovadas.filter((c) => c.em_rodizio);
  const cobertura =
    contaVeicula && (plano || basicos.length || saldoHospedagem > 0) && emRodizio.length
      ? await coberturaDaConta(conta, plano, db, basicos, { redeInteira: !plano && !basicos.length })
      : [];
  const relogio = criarRelogioDaCobertura(cobertura);

  for (const c of aprovadas) {
    const aprovadoEm = c.aprovado_em ? new Date(c.aprovado_em) : new Date(c.created_at);
    const base = {
      // A primeira exibição é a do contexto atual: a de antes de uma
      // reaprovação não é mostrada como se fosse desta.
      primeiraExibicaoEm:
        c.primeira_exibicao_em && new Date(c.primeira_exibicao_em) >= aprovadoEm ? c.primeira_exibicao_em : null,
      ultimaExibicaoEm: c.ultima_exibicao_em || null,
      primeiraJanelaPrevista: null,
      prazoPrimeiraExibicao: null,
      motivo: null,
    };
    if (!c.em_rodizio) {
      resultado.set(c.id, {
        ...base,
        estado: ESTADOS.APROVADO,
        motivo: !contaVeicula
          ? conta.suspenso
            ? 'conta_suspensa'
            : 'sem_plano_vigente'
          : !c.arquivo_normalizado_url
            ? 'processando'
            : !plano && !cabeNoTeto(c.duracao_segundos, teto)
              ? 'acima_da_duracao_maxima'
              : 'fora_do_limite_de_pecas',
      });
      continue;
    }
    if (c.ultima_exibicao_em && new Date(c.ultima_exibicao_em) >= aprovadoEm) {
      resultado.set(c.id, { ...base, estado: ESTADOS.NO_AR });
      continue;
    }
    if (!cobertura.length) {
      resultado.set(c.id, { ...base, estado: ESTADOS.APROVADO, motivo: 'sem_ponto_no_ar_na_cobertura' });
      continue;
    }

    const inicio = horaCheiaSeguinte(aprovadoEm);
    const programada = await primeiraHoraProgramada(conta.id, inicio, db);
    // A hora programada (fato) vale sobre a previsão: é a hora em que a
    // conta de fato entrou numa playlist servida.
    const janela = programada?.janela || primeiraHoraAberta(relogio, inicio);
    if (!janela) {
      resultado.set(c.id, { ...base, estado: ESTADOS.APROVADO, motivo: 'cobertura_sem_horario_aberto' });
      continue;
    }
    const insercoes = Math.max(1, programada?.insercoes || 1);
    const pecasEmRodizio = Math.max(1, emRodizio.length);
    const horasDeRodizio = Math.ceil(pecasEmRodizio / insercoes);
    // Prazo contado nas horas abertas da cobertura; a hora programada de
    // uma tela fora da cobertura atual (escolha mudou) ainda conta ela.
    const prazo =
      prazoDaJanela(relogio, janela, horasDeRodizio) ||
      new Date(janela.getTime() + horasDeRodizio * HORA_MS + MARGEM_COMPROVANTE_MIN * 60_000);
    const agoraMs = new Date(agora).getTime();
    const estado =
      agoraMs < janela.getTime()
        ? ESTADOS.PROGRAMADO
        : agoraMs > prazo.getTime()
          ? ESTADOS.ATRASADO
          : programada
            ? ESTADOS.AGUARDANDO
            : ESTADOS.PROGRAMADO;
    resultado.set(c.id, {
      ...base,
      estado,
      primeiraJanelaPrevista: janela.toISOString(),
      prazoPrimeiraExibicao: prazo.toISOString(),
    });
  }
  return resultado;
}

module.exports = {
  ESTADOS,
  MARGEM_COMPROVANTE_MIN,
  entradaNoArDasPecas,
  coberturaDaConta,
  horaCheiaSeguinte,
};
