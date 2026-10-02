const crypto = require('node:crypto');
const pool = require('../db/pool');
const { FUSO } = require('../lib/fuso-comercial');
const { confirmadasHospedagemSql } = require('../lib/partes-da-hora');
const movel = require('./movel');
const agenda = require('./agenda');

// HOSPEDAGEM TEMPORÁRIA DO PONTO MÓVEL (02/10/2026, pedido do dono;
// migration 113). Um comércio recebe por alguns dias o ponto móvel da
// Mostraí. Não é aluguel: não paga nada, não vira dono, ponto fixo, Básico,
// crédito nem cupom. No ENCERRAMENTO, uma parte do TEMPO OPERACIONAL VÁLIDO
// da tela (percentual global, congelado quando o Admin confirmou) volta para
// ele em HORAS DE MÍDIA GRATUITAS na rede — o SALDO DE HOSPEDAGEM, em
// segundos, num livro próprio (saldo_hospedagem_lancamentos).
//
//   programada → ativa (o Admin marca que a tela chegou) → encerrada
//     (o Admin, ou o sistema no fim da data prevista: `encerrarVencidas`);
//   programada → cancelada (não aconteceu: benefício 0).
//
// Regras que moram SÓ aqui (o navegador nunca decide):
//   · o percentual é lido do banco na transação que confirma e gravado na
//     linha — mudar o global depois não mexe nela;
//   · o tempo válido é a UNIÃO dos intervalos de operação da tela
//     (tela_operacao: heartbeat + o que o Player contou offline) dentro de
//     [iniciada_em, encerrada_em] — nunca a duração do calendário;
//   · o encerramento não passa do fim previsto: o tempo além dele só conta
//     se o Admin prorrogar antes;
//   · o benefício nasce UMA vez, no encerramento, com a chave
//     `hospedagem:<id>` (UNIQUE): repetir o encerramento, o job concorrente
//     ou um retry nunca gravam duas vezes.

const PERCENTUAL_PADRAO = 20;
const CHAVE_PERCENTUAL = 'hospedagem_percentual';
const SQL_HOJE = `(now() AT TIME ZONE '${FUSO}')::date`;
// O fim previsto de uma hospedagem: a meia-noite (de Matão) que fecha o
// último dia — as datas são inclusivas.
const FIM_PREVISTO_SQL = (h) => `((${h}.data_fim + 1)::timestamp AT TIME ZONE '${FUSO}')`;
const LIMITES = { local: 160, endereco: 300, motivo: 300, ajusteMaximoSegundos: 1000 * 3600 };

// COMO O SALDO VEICULA (um lugar só). Benefício não pago que já existia: a
// regra do Plano Básico — 1 peça ativa de até 15 s, no ritmo de 140 s por
// hora de tela. Conta SEM plano usa exatamente isto; conta com plano usa as
// peças do plano dela (é a mesma conta, a mesma peça na tela).
// limite: decisão provisória (a quantidade/duração de criativos do saldo
// não foi definida pelo dono — trocar aqui e só aqui quando for).
const REGRA_DO_SALDO = (() => {
  const { BASICO } = require('./basico');
  return {
    segundosPorHora: BASICO.segundosPorHora,
    duracaoMaximaSegundos: BASICO.duracaoMaximaSegundos,
    limiteCriativos: BASICO.limiteCriativos,
  };
})();

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });

// ---------------------------------------------------------------------------
// Percentual (configuração global, auditada)
// ---------------------------------------------------------------------------
// Aceita "20", "12,5", 12.5. De 0 a 100, até 2 casas (numeric(5,2)).
function lerPercentual(valor) {
  const t = typeof valor === 'number' ? String(valor) : typeof valor === 'string' ? valor.trim().replace(',', '.') : '';
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : null;
}

async function percentualAtual(db = pool, { travar = false } = {}) {
  const { rows } = await db.query(
    `SELECT valor FROM configuracoes_site WHERE chave = $1 ${travar ? 'FOR SHARE' : ''}`,
    [CHAVE_PERCENTUAL],
  );
  // Valor gravado à mão errado não derruba a confirmação nem o site: cai no
  // padrão (e o Admin vê o padrão na tela, onde pode corrigir).
  return lerPercentual(rows[0]?.valor) ?? PERCENTUAL_PADRAO;
}

async function alterarPercentual(valor, admin) {
  const novo = lerPercentual(valor);
  if (novo === null) throw erro(400, 'Percentual: um número de 0 a 100, com até 2 casas decimais', 'percentual');
  return movel.emTransacao(async (c) => {
    // Trava a configuração: a hospedagem que está sendo confirmada agora lê
    // o valor com FOR SHARE — ou ela vê o antigo inteiro, ou o novo.
    await c.query(`INSERT INTO configuracoes_site (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO NOTHING`, [
      CHAVE_PERCENTUAL,
      String(PERCENTUAL_PADRAO),
    ]);
    const { rows } = await c.query(`SELECT valor FROM configuracoes_site WHERE chave = $1 FOR UPDATE`, [
      CHAVE_PERCENTUAL,
    ]);
    const anterior = lerPercentual(rows[0].valor) ?? PERCENTUAL_PADRAO;
    if (anterior === novo) return { anterior, novo, mudou: false };
    await c.query(`UPDATE configuracoes_site SET valor = $2 WHERE chave = $1`, [CHAVE_PERCENTUAL, String(novo)]);
    await c.query(`INSERT INTO hospedagem_percentual_historico (anterior, novo, admin) VALUES ($1, $2, $3)`, [
      anterior,
      novo,
      admin || 'admin',
    ]);
    return { anterior, novo, mudou: true };
  });
}

async function historicoDoPercentual() {
  const { rows } = await pool.query(
    `SELECT anterior, novo, admin, alterado_em FROM hospedagem_percentual_historico ORDER BY alterado_em DESC, id DESC LIMIT 50`,
  );
  return rows.map((r) => ({
    anterior: r.anterior === null ? null : Number(r.anterior),
    novo: Number(r.novo),
    admin: r.admin,
    alteradoEm: r.alterado_em,
  }));
}

// Benefício em segundos: tempo × percentual, para baixo. Em inteiros
// (percentual em centésimos), sem ponto flutuante no caminho.
function beneficioDe(tempoSegundos, percentual) {
  const centesimos = Math.round(Number(percentual) * 100);
  return Math.floor((Math.max(0, Math.floor(Number(tempoSegundos) || 0)) * centesimos) / 10000);
}

// ---------------------------------------------------------------------------
// Tempo operacional
// ---------------------------------------------------------------------------
// União dos intervalos de operação de QUALQUER tela do ponto (a de hoje e
// uma trocada no meio, se houver) dentro de [de, ate). O mesmo minuto visto
// pelo heartbeat e pelo Player conta uma vez; minutos em que nada
// comprovou operação não contam.
async function tempoOperacional(db, pontoId, de, ate) {
  const { rows } = await db.query(
    `SELECT COALESCE(FLOOR(SUM(EXTRACT(EPOCH FROM upper(r) - lower(r)))), 0)::bigint AS segundos
       FROM unnest((
         SELECT range_agg(tstzrange(GREATEST(o.inicio, $2::timestamptz), LEAST(o.fim, $3::timestamptz), '[)'))
           FROM tela_operacao o JOIN dispositivos d ON d.id = o.dispositivo_id
          WHERE d.ponto_id = $1 AND o.fim > $2::timestamptz AND o.inicio < $3::timestamptz
       )) AS r`,
    [pontoId, de, ate],
  );
  return Number(rows[0].segundos);
}

// ---------------------------------------------------------------------------
// Escrita (só Admin)
// ---------------------------------------------------------------------------
async function hospedagemDoPonto(c, pontoId, hospedagemId) {
  const id = /^\d{1,15}$/.test(String(hospedagemId)) ? String(hospedagemId) : null;
  const { rows } = id
    ? await c.query(
        `SELECT *, (data_fim < ${SQL_HOJE}) AS terminou, (data_inicio > ${SQL_HOJE}) AS ainda_nao_comecou
           FROM pontos_moveis_hospedagens WHERE id = $1 AND ponto_id = $2 FOR UPDATE`,
        [id, pontoId],
      )
    : { rows: [] };
  if (!rows[0]) throw erro(404, 'hospedagem não encontrada');
  return rows[0];
}

const JA_ESTA = {
  ativa: 'Essa hospedagem já está em andamento',
  encerrada: 'Essa hospedagem já foi encerrada',
  cancelada: 'Essa hospedagem foi cancelada',
};

function periodo(corpo, hoje) {
  const dataInicio = movel.dia(corpo?.data_inicio, 'data_inicio', 'Início');
  const dataFim = movel.dia(corpo?.data_fim, 'data_fim', 'Fim');
  if (dataFim < dataInicio) throw erro(400, 'O fim vem antes do início', 'data_fim');
  if (dataFim < hoje) throw erro(400, 'Esse período já terminou — programe só o que ainda vai acontecer', 'data_fim');
  return { dataInicio, dataFim };
}

// Confirmar a hospedagem: móvel → conta anfitriã → local → período →
// percentual. `percentual_esperado` é o que o Admin VIU na revisão ("Esta
// hospedagem ficará vinculada a 20%"); se o global mudou nesse meio-tempo, a
// confirmação volta (409) em vez de vincular um número que ninguém viu.
async function criar(pontoId, corpo, admin) {
  const contaId = Number(corpo?.conta_id);
  if (!Number.isInteger(contaId) || contaId <= 0) throw erro(400, 'Escolha a conta anfitriã', 'conta_id');
  const { dataInicio, dataFim } = periodo(corpo, movel.hojeEmMatao());
  const esperado = lerPercentual(corpo?.percentual_esperado);
  if (esperado === null) throw erro(400, 'Revise o percentual antes de confirmar', 'percentual_esperado');
  const interesseId = corpo?.interesse_id ? Number(corpo.interesse_id) : null;
  if (interesseId !== null && (!Number.isInteger(interesseId) || interesseId <= 0)) {
    throw erro(400, 'Interesse inválido', 'interesse_id');
  }

  try {
    return await movel.emTransacao(async (c) => {
      await movel.travarMovel(c, pontoId);
      const {
        rows: [conta],
      } = await c.query(
        `SELECT id, nome_empresa, excluido_em, conta_propria, categoria_id, logradouro, numero, complemento,
                bairro, cidade, uf, endereco
           FROM anunciantes WHERE id = $1`,
        [contaId],
      );
      if (!conta || conta.excluido_em) throw erro(400, 'Conta anfitriã não encontrada', 'conta_id');
      if (conta.conta_propria) throw erro(400, 'A conta própria da Mostraí não hospeda o próprio ponto', 'conta_id');
      const local = movel.texto(corpo?.local || conta.nome_empresa, 'local', 'Local', LIMITES.local);
      const { linhaEndereco } = require('../lib/endereco');
      const endereco = movel.texto(
        corpo?.endereco || linhaEndereco(conta, { comCidade: true }),
        'endereco',
        'Endereço',
        LIMITES.endereco,
      );
      if (interesseId) {
        const { rows } = await c.query(`SELECT id, conta_id FROM hospedagem_interesses WHERE id = $1 FOR UPDATE`, [
          interesseId,
        ]);
        if (!rows[0]) throw erro(400, 'Interesse não encontrado', 'interesse_id');
        if (rows[0].conta_id && Number(rows[0].conta_id) !== contaId) {
          throw erro(400, 'Esse interesse é de outra conta', 'conta_id');
        }
      }
      const percentual = await percentualAtual(c, { travar: true });
      if (percentual !== esperado) {
        throw erro(
          409,
          `O percentual mudou para ${formatarPercentual(percentual)} enquanto você revisava — confira e confirme de novo`,
          'percentual_esperado',
        );
      }
      await agenda.exigirLivre(c, pontoId, dataInicio, dataFim);
      const { rows } = await c.query(
        `INSERT INTO pontos_moveis_hospedagens
           (ponto_id, conta_id, interesse_id, local, endereco, categoria_id, data_inicio, data_fim, percentual,
            criado_por_admin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [pontoId, contaId, interesseId, local, endereco, conta.categoria_id, dataInicio, dataFim, percentual, admin],
      );
      if (interesseId) {
        await c.query(
          `UPDATE hospedagem_interesses
              SET status = 'agendada', conta_id = COALESCE(conta_id, $2), atualizado_em = now(),
                  atualizado_por_admin = $3
            WHERE id = $1`,
          [interesseId, contaId, admin],
        );
      }
      return { id: Number(rows[0].id), contaId, percentual };
    });
  } catch (err) {
    throw agenda.traduzirErroDoBanco(err);
  }
}

// "A tela chegou ao comércio": o local atual passa a ser o do anfitrião (e o
// ramo dele vale na trava de concorrente). Só dentro do período — para
// antecipar, o Admin muda o período antes (programada).
async function iniciar(pontoId, hospedagemId) {
  try {
    return await movel.emTransacao(async (c) => {
      await movel.travarMovel(c, pontoId);
      const h = await hospedagemDoPonto(c, pontoId, hospedagemId);
      if (h.estado !== 'programada') throw erro(409, JA_ESTA[h.estado]);
      if (h.terminou) throw erro(409, 'O período dessa hospedagem já passou — cancele ou programe de novo');
      if (h.ainda_nao_comecou) {
        throw erro(409, 'Essa hospedagem começa só no dia marcado — para antecipar, altere o período antes');
      }
      await agenda.exigirLivre(c, pontoId, h.data_inicio, h.data_fim, {
        ignorar: { tipo: 'hospedagem', id: h.id },
        emCurso: true,
      });
      await c.query(`UPDATE pontos_moveis_hospedagens SET estado = 'ativa', iniciada_em = now() WHERE id = $1`, [h.id]);
      await movel.avisarTelas(c, pontoId);
      return { contaId: h.conta_id };
    });
  } catch (err) {
    throw agenda.traduzirErroDoBanco(err);
  }
}

// O coração: fecha a hospedagem e faz nascer o benefício, na MESMA
// transação (a linha está travada). O fim é o agora, nunca depois do fim
// previsto; o tempo é o que a tela comprovou nesse intervalo.
async function encerrarNaTransacao(c, h, { encerramento, admin = null }) {
  const {
    rows: [fim],
  } = await c.query(
    `SELECT GREATEST(h.iniciada_em, LEAST(now(), ${FIM_PREVISTO_SQL('h')})) AS encerrada_em
       FROM pontos_moveis_hospedagens h WHERE h.id = $1`,
    [h.id],
  );
  const tempo = await tempoOperacional(c, h.ponto_id, h.iniciada_em, fim.encerrada_em);
  const beneficio = beneficioDe(tempo, h.percentual);
  await c.query(
    `UPDATE pontos_moveis_hospedagens
        SET estado = 'encerrada', encerrada_em = $2, encerramento = $3,
            tempo_operacional_segundos = $4, beneficio_segundos = $5, encerrado_por_admin = $6
      WHERE id = $1`,
    [h.id, fim.encerrada_em, encerramento, tempo, beneficio, admin],
  );
  if (beneficio > 0) {
    await c.query(
      `INSERT INTO saldo_hospedagem_lancamentos (conta_id, tipo, segundos, chave, hospedagem_id)
       VALUES ($1, 'beneficio', $2, $3, $4)
       ON CONFLICT (chave) DO NOTHING`,
      [h.conta_id, beneficio, `hospedagem:${h.id}`, h.id],
    );
  }
  await movel.avisarTelas(c, h.ponto_id);
  return { contaId: h.conta_id, tempoSegundos: tempo, beneficioSegundos: beneficio };
}

async function encerrar(pontoId, hospedagemId, admin) {
  const r = await movel.emTransacao(async (c) => {
    await movel.travarMovel(c, pontoId);
    const h = await hospedagemDoPonto(c, pontoId, hospedagemId);
    if (h.estado === 'programada') throw erro(409, 'Essa hospedagem ainda não começou — para desistir dela, cancele');
    if (h.estado !== 'ativa') throw erro(409, JA_ESTA[h.estado]);
    return encerrarNaTransacao(c, h, { encerramento: 'manual', admin });
  });
  await avisarBeneficio(r);
  return r;
}

// Só antes de começar. Depois de começar, o caminho é encerrar (conta o
// tempo real até ali).
async function cancelar(pontoId, hospedagemId) {
  return movel.emTransacao(async (c) => {
    await movel.travarMovel(c, pontoId);
    const h = await hospedagemDoPonto(c, pontoId, hospedagemId);
    if (h.estado === 'ativa') {
      throw erro(409, 'A hospedagem já começou — use Encerrar (conta o tempo real até agora)');
    }
    if (h.estado !== 'programada') throw erro(409, JA_ESTA[h.estado]);
    await c.query(
      `UPDATE pontos_moveis_hospedagens SET estado = 'cancelada', cancelada_em = now(), encerramento = 'manual'
        WHERE id = $1`,
      [h.id],
    );
    return { contaId: h.conta_id };
  });
}

// Alterar o período: programada muda início e fim; ativa só prorroga o fim
// (o início já aconteceu). Sem conflito na agenda; o percentual continua o
// congelado.
async function alterarPeriodo(pontoId, hospedagemId, corpo) {
  try {
    return await movel.emTransacao(async (c) => {
      await movel.travarMovel(c, pontoId);
      const h = await hospedagemDoPonto(c, pontoId, hospedagemId);
      if (h.estado !== 'programada' && h.estado !== 'ativa') throw erro(409, JA_ESTA[h.estado]);
      const hoje = movel.hojeEmMatao();
      const inicioAtual = String(h.data_inicio).slice(0, 10);
      const fimAtual = String(h.data_fim).slice(0, 10);
      let dataInicio = inicioAtual;
      let dataFim;
      if (h.estado === 'ativa') {
        dataFim = movel.dia(corpo?.data_fim, 'data_fim', 'Fim');
        if (corpo?.data_inicio && corpo.data_inicio !== inicioAtual) {
          throw erro(400, 'A hospedagem já começou — só o fim pode mudar', 'data_inicio');
        }
        if (dataFim <= fimAtual) {
          throw erro(400, 'Para terminar antes, use Encerrar — aqui é só para prorrogar', 'data_fim');
        }
      } else {
        ({ dataInicio, dataFim } = periodo(corpo, hoje));
      }
      await agenda.exigirLivre(c, pontoId, dataInicio, dataFim, { ignorar: { tipo: 'hospedagem', id: h.id } });
      await c.query(`UPDATE pontos_moveis_hospedagens SET data_inicio = $2, data_fim = $3 WHERE id = $1`, [
        h.id,
        dataInicio,
        dataFim,
      ]);
      return { contaId: h.conta_id, dataInicio, dataFim };
    });
  } catch (err) {
    throw agenda.traduzirErroDoBanco(err);
  }
}

// ---------------------------------------------------------------------------
// Encerramento automático (job)
// ---------------------------------------------------------------------------
// No fim da data prevista, se ninguém agiu: hospedagem ativa encerra (com o
// benefício), programada que nunca começou é cancelada; o mesmo para evento
// (sem benefício). Cada linha na própria transação, travada e conferida de
// novo — duas instâncias rodando juntas nunca encerram a mesma duas vezes.
async function encerrarVencidas() {
  const { rows: vencidas } = await pool.query(
    `SELECT id, ponto_id, estado FROM pontos_moveis_hospedagens
      WHERE estado IN ('programada', 'ativa') AND data_fim < ${SQL_HOJE}
     ORDER BY id`,
  );
  const resultado = { hospedagensEncerradas: 0, hospedagensCanceladas: 0, eventosEncerrados: 0, eventosCancelados: 0 };
  const pontos = new Set();
  const contas = new Set();
  for (const v of vencidas) {
    try {
      const r = await movel.emTransacao(async (c) => {
        await c.query('SELECT 1 FROM pontos WHERE id = $1 FOR UPDATE', [v.ponto_id]);
        const h = await hospedagemDoPonto(c, v.ponto_id, v.id);
        if (!h.terminou) return null;
        if (h.estado === 'ativa') return { ...(await encerrarNaTransacao(c, h, { encerramento: 'automatico' })), h };
        if (h.estado === 'programada') {
          await c.query(
            `UPDATE pontos_moveis_hospedagens
                SET estado = 'cancelada', cancelada_em = now(), encerramento = 'automatico' WHERE id = $1`,
            [h.id],
          );
          return { cancelada: true, contaId: h.conta_id, h };
        }
        return null;
      });
      if (!r) continue;
      pontos.add(v.ponto_id);
      contas.add(r.contaId);
      if (r.cancelada) resultado.hospedagensCanceladas += 1;
      else {
        resultado.hospedagensEncerradas += 1;
        await avisarBeneficio(r);
      }
    } catch (err) {
      console.error(
        `encerramento automático da hospedagem ${v.id} falhou (tenta de novo no próximo ciclo)`,
        err.message,
      );
    }
  }
  const { rows: eventos } = await pool.query(
    `SELECT id, ponto_id FROM pontos_moveis_eventos
      WHERE estado IN ('programado', 'em_andamento') AND data_fim < ${SQL_HOJE} ORDER BY id`,
  );
  for (const e of eventos) {
    try {
      const estado = await movel.emTransacao(async (c) => {
        await c.query('SELECT 1 FROM pontos WHERE id = $1 FOR UPDATE', [e.ponto_id]);
        const { rows } = await c.query(
          `UPDATE pontos_moveis_eventos
              SET estado = CASE estado WHEN 'em_andamento' THEN 'encerrado' ELSE 'cancelado' END,
                  encerrado_em = CASE WHEN estado = 'em_andamento' THEN now() END,
                  cancelado_em = CASE WHEN estado = 'programado' THEN now() END,
                  encerramento = 'automatico'
            WHERE id = $1 AND estado IN ('programado', 'em_andamento') AND data_fim < ${SQL_HOJE}
            RETURNING estado`,
          [e.id],
        );
        if (rows[0]?.estado === 'encerrado') await movel.avisarTelas(c, e.ponto_id);
        return rows[0]?.estado || null;
      });
      if (!estado) continue;
      pontos.add(e.ponto_id);
      if (estado === 'encerrado') resultado.eventosEncerrados += 1;
      else resultado.eventosCancelados += 1;
    } catch (err) {
      console.error(`encerramento automático do evento ${e.id} falhou (tenta de novo no próximo ciclo)`, err.message);
    }
  }
  if (pontos.size) {
    const sse = require('../lib/sse');
    for (const pontoId of pontos) {
      sse.emitirParaAdmin('point.updated', { id: pontoId });
      for (const conta of await movel.contasInteressadas(pontoId, [...contas])) {
        sse.emitirParaConta(conta, 'point.updated', { id: pontoId });
      }
    }
  }
  return resultado;
}

const INTERVALO_MS = 5 * 60 * 1000;
function iniciarJob() {
  const rodar = () =>
    encerrarVencidas().catch((err) => console.error('job de encerramento do ponto móvel falhou', err.message));
  setTimeout(rodar, 30_000).unref();
  setInterval(rodar, INTERVALO_MS).unref();
}

// ---------------------------------------------------------------------------
// Saldo de hospedagem
// ---------------------------------------------------------------------------
// recebido  — soma do livro (benefícios + ajustes);
// entregue  — exibições CONFIRMADAS (Proof-of-Play) que o gerador programou
//             na camada de hospedagem × a duração da peça;
// reservado — programadas na camada de hospedagem ainda sem confirmação,
//             dentro do prazo do Proof-of-Play offline (podem chegar ainda);
// disponível = recebido − entregue (o que a conta vê);
// para programar = disponível − reservado (o que o gerador ainda pode pôr).
// Passado o prazo, o que não foi confirmado nunca foi entregue: volta.
async function saldosDasContas(contaIds = null, db = pool) {
  const { PRAZO_PROOF_OF_PLAY_MIN } = require('../playlist/gerador');
  const { DURACAO_PADRAO } = require('../lib/pacing');
  const conf = confirmadasHospedagemSql('e.');
  const { rows } = await db.query(
    `WITH rec AS (
       SELECT conta_id, SUM(segundos)::bigint AS recebido FROM saldo_hospedagem_lancamentos
        WHERE ($1::int[] IS NULL OR conta_id = ANY($1::int[])) GROUP BY conta_id
     ), ent AS (
       SELECT e.anunciante_id AS conta_id,
              SUM(${conf} * COALESCE(e.duracao_segundos, $2))::bigint AS entregue,
              SUM(CASE WHEN e.janela_hora > now() - make_interval(mins => $3)
                       THEN (e.vezes_hospedagem - ${conf}) * COALESCE(e.duracao_segundos, $2) ELSE 0 END)::bigint
                AS reservado
         FROM exibicoes_contador e
        WHERE e.vezes_hospedagem > 0 AND e.anunciante_id IN (SELECT conta_id FROM rec)
        GROUP BY e.anunciante_id
     )
     SELECT rec.conta_id, rec.recebido, COALESCE(ent.entregue, 0) AS entregue, COALESCE(ent.reservado, 0) AS reservado
       FROM rec LEFT JOIN ent USING (conta_id)`,
    [contaIds ? contaIds.map(Number) : null, DURACAO_PADRAO, PRAZO_PROOF_OF_PLAY_MIN],
  );
  const mapa = new Map();
  for (const r of rows) {
    const recebido = Number(r.recebido);
    const entregue = Number(r.entregue);
    const disponivel = Math.max(0, recebido - entregue);
    mapa.set(Number(r.conta_id), {
      recebidoSegundos: recebido,
      entregueSegundos: entregue,
      reservadoSegundos: Number(r.reservado),
      disponivelSegundos: disponivel,
      paraProgramarSegundos: Math.max(0, disponivel - Number(r.reservado)),
    });
  }
  return mapa;
}

const SALDO_VAZIO = {
  recebidoSegundos: 0,
  entregueSegundos: 0,
  reservadoSegundos: 0,
  disponivelSegundos: 0,
  paraProgramarSegundos: 0,
};

async function saldoDaConta(contaId, db = pool) {
  return (await saldosDasContas([contaId], db)).get(Number(contaId)) || { ...SALDO_VAZIO };
}

// As peças que o saldo põe na tela de uma conta SEM plano vigente: as
// aprovadas mais novas que cabem na regra do saldo.
async function pecasDoSaldo(contaId, db = pool) {
  const { rows } = await db.query(
    `SELECT id AS "criativoId", arquivo_normalizado_url AS url, duracao_segundos AS "duracaoSegundos",
            conteudo_sha256 AS "contentHash"
       FROM criativos
      WHERE anunciante_id = $1 AND status = 'aprovado' AND arquivo_normalizado_url IS NOT NULL
        AND duracao_segundos <= $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [contaId, REGRA_DO_SALDO.duracaoMaximaSegundos, REGRA_DO_SALDO.limiteCriativos],
  );
  return rows;
}

// O que o gerador pode programar AGORA: { contaId: segundos }.
async function saldosParaProgramar(db = pool) {
  const mapa = {};
  for (const [id, s] of await saldosDasContas(null, db))
    if (s.paraProgramarSegundos > 0) mapa[id] = s.paraProgramarSegundos;
  return mapa;
}

// Correção do Admin: um lançamento novo (+/−) com motivo — nunca se edita o
// benefício. Retirar mais do que está disponível é recusado: o saldo nunca
// fica negativo.
async function ajustar(contaId, corpo, admin) {
  const id = Number(contaId);
  if (!Number.isInteger(id) || id <= 0) throw erro(404, 'conta não encontrada');
  const minutos = Number(
    String(corpo?.minutos ?? '')
      .trim()
      .replace(',', '.'),
  );
  if (!Number.isFinite(minutos) || !Number.isInteger(minutos) || minutos === 0) {
    throw erro(400, 'Ajuste: um número inteiro de minutos, positivo ou negativo, diferente de zero', 'minutos');
  }
  const segundos = minutos * 60;
  if (Math.abs(segundos) > LIMITES.ajusteMaximoSegundos) throw erro(400, 'Ajuste grande demais', 'minutos');
  const motivo = movel.texto(corpo?.motivo, 'motivo', 'Motivo', LIMITES.motivo);
  return movel.emTransacao(async (c) => {
    const { rows } = await c.query('SELECT id, excluido_em FROM anunciantes WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0] || rows[0].excluido_em) throw erro(404, 'conta não encontrada');
    if (segundos < 0) {
      const s = await saldoDaConta(id, c);
      if (s.disponivelSegundos + segundos < 0) {
        throw erro(400, 'O ajuste deixaria o saldo negativo — retire no máximo o que está disponível', 'minutos');
      }
    }
    await c.query(
      `INSERT INTO saldo_hospedagem_lancamentos (conta_id, tipo, segundos, chave, motivo, admin)
       VALUES ($1, 'ajuste', $2, $3, $4, $5)`,
      [id, segundos, `ajuste:${crypto.randomUUID()}`, motivo, admin || 'admin'],
    );
    return { contaId: id, segundos };
  });
}

async function extratoDaConta(contaId, { comAdmin = false } = {}) {
  const { rows } = await pool.query(
    `SELECT l.tipo, l.segundos, l.motivo, l.admin, l.criado_em, l.hospedagem_id, h.local
       FROM saldo_hospedagem_lancamentos l LEFT JOIN pontos_moveis_hospedagens h ON h.id = l.hospedagem_id
      WHERE l.conta_id = $1 ORDER BY l.criado_em DESC, l.id DESC LIMIT 100`,
    [contaId],
  );
  return rows.map((r) => ({
    tipo: r.tipo,
    segundos: Number(r.segundos),
    criadoEm: r.criado_em,
    hospedagemId: r.hospedagem_id ? Number(r.hospedagem_id) : null,
    local: r.local,
    motivo: r.motivo,
    ...(comAdmin ? { admin: r.admin } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
// As hospedagens de uma conta anfitriã (painel): só as dela. Na ativa, o
// tempo até agora e o benefício ESTIMADO (o valor só fica fechado no
// encerramento).
async function hospedagensDaConta(contaId) {
  const { rows } = await pool.query(
    `SELECT h.id, h.ponto_id, h.local, h.data_inicio, h.data_fim, h.percentual, h.estado, h.iniciada_em,
            h.encerrada_em, h.tempo_operacional_segundos, h.beneficio_segundos, p.nome AS ponto_nome
       FROM pontos_moveis_hospedagens h JOIN pontos p ON p.id = h.ponto_id
      WHERE h.conta_id = $1 AND h.estado IN ('programada', 'ativa', 'encerrada')
      ORDER BY CASE h.estado WHEN 'ativa' THEN 0 WHEN 'programada' THEN 1 ELSE 2 END,
               CASE WHEN h.estado = 'programada' THEN h.data_inicio END, h.encerrada_em DESC NULLS LAST, h.id DESC
      LIMIT 20`,
    [contaId],
  );
  const lista = [];
  for (const h of rows) {
    const item = {
      id: Number(h.id),
      ponto: h.ponto_nome,
      local: h.local,
      dataInicio: h.data_inicio,
      dataFim: h.data_fim,
      percentual: Number(h.percentual),
      estado: h.estado,
      iniciadaEm: h.iniciada_em,
      encerradaEm: h.encerrada_em,
      tempoSegundos: h.tempo_operacional_segundos === null ? null : Number(h.tempo_operacional_segundos),
      beneficioSegundos: h.beneficio_segundos === null ? null : Number(h.beneficio_segundos),
    };
    if (h.estado === 'ativa') {
      item.tempoSegundos = await tempoOperacional(pool, h.ponto_id, h.iniciada_em, new Date());
      item.beneficioEstimadoSegundos = beneficioDe(item.tempoSegundos, h.percentual);
    }
    lista.push(item);
  }
  return lista;
}

// Admin: todas as hospedagens de um móvel (agenda + histórico).
async function hospedagensDoPonto(pontoId, db = pool) {
  const { rows } = await db.query(
    `SELECT h.*, a.nome_empresa AS conta_nome, (h.data_fim < ${SQL_HOJE}) AS terminou
       FROM pontos_moveis_hospedagens h JOIN anunciantes a ON a.id = h.conta_id
      WHERE h.ponto_id = $1
      ORDER BY CASE h.estado WHEN 'ativa' THEN 0 WHEN 'programada' THEN 1 ELSE 2 END,
               CASE WHEN h.estado = 'programada' THEN h.data_inicio END, h.data_inicio DESC, h.id DESC`,
    [pontoId],
  );
  const lista = [];
  for (const h of rows) {
    const ativa = h.estado === 'ativa';
    const tempoAteAgora = ativa ? await tempoOperacional(db, h.ponto_id, h.iniciada_em, new Date()) : null;
    lista.push({
      id: Number(h.id),
      conta: { id: h.conta_id, nome: h.conta_nome },
      interesseId: h.interesse_id ? Number(h.interesse_id) : null,
      local: h.local,
      endereco: h.endereco,
      dataInicio: h.data_inicio,
      dataFim: h.data_fim,
      percentual: Number(h.percentual),
      estado: h.estado,
      terminou: h.terminou,
      iniciadaEm: h.iniciada_em,
      encerradaEm: h.encerrada_em,
      canceladaEm: h.cancelada_em,
      encerramento: h.encerramento,
      tempoSegundos: ativa ? tempoAteAgora : h.tempo_operacional_segundos,
      beneficioSegundos: ativa ? beneficioDe(tempoAteAgora, h.percentual) : h.beneficio_segundos,
      estimado: ativa,
      criadoEm: h.criado_em,
      criadoPor: h.criado_por_admin,
      encerradoPor: h.encerrado_por_admin,
    });
  }
  return lista;
}

// Aviso à conta anfitriã: as horas chegaram (ou a hospedagem acabou sem
// tempo comprovado). Aviso nunca derruba o encerramento que já aconteceu.
async function avisarBeneficio({ contaId, beneficioSegundos }) {
  const notificacoes = require('../creditos/notificacoes');
  const sse = require('../lib/sse');
  await notificacoes.registrarSemFalhar(contaId, {
    tipo: 'hospedagem_encerrada',
    titulo:
      beneficioSegundos > 0
        ? `Você ganhou ${duracaoLegivel(beneficioSegundos)} de mídia por hospedar um Ponto Móvel`
        : 'A hospedagem do Ponto Móvel terminou',
    descricao:
      beneficioSegundos > 0
        ? 'As horas já estão no seu saldo de hospedagem e valem na rede inteira.'
        : 'A tela não registrou tempo de operação nesse período, então não houve horas a receber.',
    entidadeTipo: 'hospedagem',
    link: '/anunciante/painel.html#hospedagem',
  });
  sse.emitirParaConta(contaId, 'hosting.updated', {});
}

// "6 h 00 min" — o mesmo formato do painel.
function duracaoLegivel(segundos) {
  const minutos = Math.floor(Math.max(0, Number(segundos) || 0) / 60);
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

const formatarPercentual = (n) => `${String(Number(n)).replace('.', ',')}%`;

module.exports = {
  PERCENTUAL_PADRAO,
  REGRA_DO_SALDO,
  pecasDoSaldo,
  lerPercentual,
  percentualAtual,
  alterarPercentual,
  historicoDoPercentual,
  beneficioDe,
  tempoOperacional,
  criar,
  iniciar,
  encerrar,
  cancelar,
  alterarPeriodo,
  encerrarVencidas,
  iniciarJob,
  saldosDasContas,
  saldoDaConta,
  saldosParaProgramar,
  ajustar,
  extratoDaConta,
  hospedagensDaConta,
  hospedagensDoPonto,
  duracaoLegivel,
  formatarPercentual,
};
