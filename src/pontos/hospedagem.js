const crypto = require('node:crypto');
const pool = require('../db/pool');
const { confirmadasHospedagemSql } = require('../lib/partes-da-hora');
const movel = require('./movel');
const agenda = require('./agenda');
const alocacao = require('./alocacao');

// HOSPEDAGEM TEMPORÁRIA DO PONTO MÓVEL (02/10/2026, pedido do dono;
// migrations 113 e 114). Um comércio recebe por um período o ponto móvel da
// Mostraí. Não é aluguel: não paga nada, não vira dono, ponto fixo, Básico,
// crédito nem cupom. No ENCERRAMENTO, uma parte do TEMPO OPERACIONAL VÁLIDO
// da tela (percentual global, congelado quando o Admin confirmou) volta para
// ele em HORAS DE MÍDIA GRATUITAS na rede — o SALDO DE HOSPEDAGEM, em
// segundos, num livro próprio (saldo_hospedagem_lancamentos).
//
//   programada → ativa (o Admin marca que a tela chegou — nunca sozinha) →
//     encerrada (o Admin, ou o sistema no fim previsto: `encerrarVencidas`);
//   programada → cancelada (não aconteceu: benefício 0).
// O período é [inicio, fim) com data E hora, e a hospedagem tem o seu
// HORÁRIO DE FUNCIONAMENTO (migration 114, src/pontos/alocacao.js) — é ele
// que vai para a TV e é só dentro dele que o tempo vale.
//
// Regras que moram SÓ aqui (o navegador nunca decide):
//   · o percentual é lido do banco na transação que confirma e gravado na
//     linha — mudar o global depois não mexe nela;
//   · o tempo válido é a UNIÃO dos intervalos de operação da tela
//     (tela_operacao: heartbeat + o que o Player contou offline) ∩ o
//     período ∩ o horário de funcionamento, a partir de quando ela chegou —
//     nunca a duração do calendário (27 h válidas × 20% = 5 h 24 min);
//   · o encerramento não passa do fim previsto: o tempo além dele só conta
//     se o Admin prorrogar antes;
//   · o benefício nasce UMA vez, no encerramento, com a chave
//     `hospedagem:<id>` (UNIQUE): repetir o encerramento, o job concorrente
//     ou um retry nunca gravam duas vezes.

const PERCENTUAL_PADRAO = 20;
const CHAVE_PERCENTUAL = 'hospedagem_percentual';
const LIMITES = { local: 160, endereco: 300, motivo: 300, observacao: 500, ajusteMaximoSegundos: 1000 * 3600 };

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
// União dos intervalos de operação gravados NESTE ponto (pela tela de hoje
// e por uma trocada no meio, se houver — mesmo já excluída) dentro de
// [de, ate). O mesmo minuto visto pelo heartbeat e pelo Player conta uma
// vez; minutos em que nada comprovou operação não contam.
async function intervalosDeOperacao(db, pontoId, de, ate) {
  const { rows } = await db.query(
    `SELECT (EXTRACT(EPOCH FROM lower(r)) * 1000)::bigint AS a, (EXTRACT(EPOCH FROM upper(r)) * 1000)::bigint AS b
       FROM unnest((
         SELECT range_agg(tstzrange(GREATEST(o.inicio, $2::timestamptz), LEAST(o.fim, $3::timestamptz), '[)'))
           FROM tela_operacao o
          WHERE o.ponto_id = $1 AND o.fim > $2::timestamptz AND o.inicio < $3::timestamptz
       )) AS r
      ORDER BY 1`,
    [pontoId, de, ate],
  );
  return rows.map((r) => [Number(r.a), Number(r.b)]);
}

async function tempoOperacional(db, pontoId, de, ate) {
  return alocacao.somaSegundos(await intervalosDeOperacao(db, pontoId, de, ate));
}

// O TEMPO VÁLIDO de uma hospedagem até `ate`: o que a tela comprovou ∩ o
// período ([inicio, fim), a partir de quando ela chegou) ∩ o horário de
// funcionamento da hospedagem. É a base do benefício.
async function tempoValido(db, h, ate) {
  const de = Math.max(new Date(h.iniciada_em).getTime(), new Date(h.inicio).getTime());
  const limite = Math.min(new Date(ate).getTime(), new Date(h.fim).getTime());
  if (!(limite > de)) return 0;
  const operou = await intervalosDeOperacao(db, h.ponto_id, new Date(de), new Date(limite));
  if (!operou.length) return 0;
  return alocacao.somaSegundos(
    alocacao.intersectar(operou, alocacao.intervalosAbertos(h.horario_operacao, de, limite)),
  );
}

// ---------------------------------------------------------------------------
// Escrita (só Admin)
// ---------------------------------------------------------------------------
async function hospedagemDoPonto(c, pontoId, hospedagemId) {
  const id = /^\d{1,15}$/.test(String(hospedagemId)) ? String(hospedagemId) : null;
  const { rows } = id
    ? await c.query(
        `SELECT h.*, (h.fim <= now()) AS terminou, (h.inicio > now()) AS ainda_nao_comecou,
                (SELECT p.movel_numero FROM pontos p WHERE p.id = h.ponto_id) AS movel_numero
           FROM pontos_moveis_hospedagens h WHERE h.id = $1 AND h.ponto_id = $2 FOR UPDATE`,
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

// Ramo informado pelo Admin (contexto de concorrência): vazio/ausente =
// `undefined` (quem chama decide o padrão).
function lerCategoria(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return undefined;
  const id = Number(String(valor).trim());
  if (!Number.isInteger(id) || id <= 0) {
    throw erro(400, 'Contexto de concorrência: escolha um ramo da lista', 'categoria_id');
  }
  return id;
}

async function exigirCategoria(c, categoriaId) {
  if (!categoriaId) return;
  const { rows } = await c.query('SELECT 1 FROM categorias WHERE id = $1', [categoriaId]);
  if (!rows[0]) throw erro(400, 'Contexto de concorrência: ramo não encontrado', 'categoria_id');
}

// Agendar a hospedagem (o Admin orquestra tudo): móvel → conta anfitriã →
// local e endereço → período com data e hora → horário de funcionamento →
// ramo (padrão: o da conta) → observação → percentual. `percentual_esperado`
// é o que o Admin VIU na revisão ("Esta hospedagem ficará vinculada a 20%");
// se o global mudou nesse meio-tempo, a confirmação volta (409) em vez de
// vincular um número que ninguém viu. Nasce PROGRAMADA: nunca começa
// sozinha — o Admin inicia quando a tela chega (com termo aceito e entrega).
async function criar(pontoId, corpo, admin) {
  const contaId = Number(corpo?.conta_id);
  if (!Number.isInteger(contaId) || contaId <= 0) throw erro(400, 'Escolha a conta anfitriã', 'conta_id');
  const periodo = alocacao.lerPeriodo(corpo);
  const horario = alocacao.lerHorario(corpo?.horario_operacao);
  const categoriaInformada = lerCategoria(corpo?.categoria_id);
  const observacao = movel.texto(corpo?.observacao, 'observacao', 'Observação', LIMITES.observacao, {
    obrigatorio: false,
  });
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
      let interesse = null;
      if (interesseId) {
        const { rows } = await c.query(
          `SELECT i.id, i.conta_id, i.status, i.empresa, i.endereco, i.categoria_id,
                  COALESCE(i.local_nome, p.nome) AS local_nome
             FROM hospedagem_interesses i LEFT JOIN pontos p ON p.id = i.ponto_id
            WHERE i.id = $1 FOR UPDATE OF i`,
          [interesseId],
        );
        interesse = rows[0];
        if (!interesse) throw erro(400, 'Interesse não encontrado', 'interesse_id');
        if (interesse.status === 'agendada' || interesse.status === 'recusada') {
          throw erro(409, `Esse interesse já foi ${interesse.status} — programe sem ele`, 'interesse_id');
        }
        if (interesse.conta_id && Number(interesse.conta_id) !== contaId) {
          throw erro(400, 'Esse interesse é de outra conta', 'conta_id');
        }
      }
      // Local e endereço: o que o Admin escreveu; senão os do interesse;
      // senão os da conta.
      const local = movel.texto(
        corpo?.local || interesse?.local_nome || interesse?.empresa || conta.nome_empresa,
        'local',
        'Local',
        LIMITES.local,
      );
      const { linhaEndereco } = require('../lib/endereco');
      const endereco = movel.texto(
        corpo?.endereco || interesse?.endereco || linhaEndereco(conta, { comCidade: true }),
        'endereco',
        'Endereço',
        LIMITES.endereco,
      );
      const categoriaId =
        categoriaInformada !== undefined ? categoriaInformada : (interesse?.categoria_id ?? conta.categoria_id);
      await exigirCategoria(c, categoriaId);
      const percentual = await percentualAtual(c, { travar: true });
      if (percentual !== esperado) {
        throw erro(
          409,
          `O percentual mudou para ${formatarPercentual(percentual)} enquanto você revisava — confira e confirme de novo`,
          'percentual_esperado',
        );
      }
      await agenda.exigirLivre(c, pontoId, periodo.inicio, periodo.fim);
      const { rows } = await c.query(
        `INSERT INTO pontos_moveis_hospedagens
           (ponto_id, conta_id, interesse_id, local, endereco, categoria_id, data_inicio, data_fim, percentual,
            criado_por_admin, inicio, fim, horario_operacao, observacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [
          pontoId,
          contaId,
          interesseId,
          local,
          endereco,
          categoriaId || null,
          periodo.dataInicio,
          periodo.dataFim,
          percentual,
          admin,
          periodo.inicio,
          periodo.fim,
          JSON.stringify(horario),
          observacao,
        ],
      );
      if (interesseId) {
        await c.query(
          `UPDATE hospedagem_interesses
              SET status = 'agendada', atualizado_em = now(), atualizado_por_admin = $2
            WHERE id = $1`,
          [interesseId, admin],
        );
      }
      return { id: Number(rows[0].id), contaId, percentual };
    });
  } catch (err) {
    throw agenda.traduzirErroDoBanco(err);
  }
}

// "A tela chegou ao comércio": o local atual passa a ser o do anfitrião (o
// ramo da hospedagem vale na trava de concorrente e o horário dela vai para
// a TV). Só dentro do período — para antecipar, o Admin muda o período antes
// (programada).
// "A tela chegou": exige o aceite do termo pelo anfitrião (para o período e
// o percentual de agora) e a ENTREGA do equipamento registrada — já
// registrada antes ou vinda no corpo, gravada na mesma transação.
async function iniciar(pontoId, hospedagemId, corpo = {}, admin = null) {
  const termo = require('./hospedagem-termo');
  try {
    return await movel.emTransacao(async (c) => {
      await movel.travarMovel(c, pontoId);
      const h = await hospedagemDoPonto(c, pontoId, hospedagemId);
      if (h.estado !== 'programada') throw erro(409, JA_ESTA[h.estado]);
      if (h.terminou) throw erro(409, 'O período dessa hospedagem já passou — cancele ou programe de novo');
      if (h.ainda_nao_comecou) {
        throw erro(409, 'Essa hospedagem começa só no horário marcado — para antecipar, altere o período antes');
      }
      if (!(await termo.aceiteValido(c, h))) {
        throw erro(
          409,
          'O anfitrião ainda não aceitou o termo desta hospedagem (com o local, o período, o horário e o percentual de agora) — ele aceita pelo painel',
        );
      }
      if (!(await termo.movimentacaoDe(c, h.id, 'entrega'))) {
        if (!corpo?.entrega) throw erro(400, 'Registre a entrega do equipamento para iniciar', 'entrega');
        await termo.registrarMovimentacao(c, h, 'entrega', corpo.entrega, admin);
      }
      await agenda.exigirLivre(c, pontoId, h.inicio, h.fim, {
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
// previsto (encerrar antes é permitido: conta até ali); o tempo é o válido
// (`tempoValido`) nesse intervalo.
async function encerrarNaTransacao(c, h, { encerramento, admin = null }) {
  const {
    rows: [fim],
  } = await c.query(
    `SELECT GREATEST(h.iniciada_em, LEAST(now(), h.fim)) AS encerrada_em
       FROM pontos_moveis_hospedagens h WHERE h.id = $1`,
    [h.id],
  );
  const tempo = await tempoValido(c, h, fim.encerrada_em);
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

// A retirada pode vir junto (o Admin está recolhendo agora) ou depois.
async function encerrar(pontoId, hospedagemId, admin, corpo = {}) {
  const r = await movel.emTransacao(async (c) => {
    await movel.travarMovel(c, pontoId);
    const h = await hospedagemDoPonto(c, pontoId, hospedagemId);
    if (h.estado === 'programada') throw erro(409, 'Essa hospedagem ainda não começou — para desistir dela, cancele');
    if (h.estado !== 'ativa') throw erro(409, JA_ESTA[h.estado]);
    if (corpo?.retirada) {
      await require('./hospedagem-termo').registrarMovimentacao(c, h, 'retirada', corpo.retirada, admin);
    }
    return encerrarNaTransacao(c, h, { encerramento: 'manual', admin });
  });
  await avisarBeneficio(r);
  return r;
}

// A hospedagem que não aconteceu devolve o interesse que a originou para
// "em contato": o Admin pode agendar de novo com ele.
async function devolverInteresse(c, h) {
  if (!h.interesse_id) return;
  // Um interesse em aberto por conta (hospedagem-interesse.js#registrar):
  // se a conta já mandou outro enquanto este estava agendado, este fecha.
  const { rows } = await c.query(
    `UPDATE hospedagem_interesses i
        SET status = CASE WHEN i.conta_id IS NOT NULL AND EXISTS (
                       SELECT 1 FROM hospedagem_interesses o
                        WHERE o.conta_id = i.conta_id AND o.id <> i.id AND o.status IN ('nova', 'em_contato', 'aprovada'))
                     THEN 'recusada' ELSE 'em_contato' END,
            nota_interna = CASE WHEN i.conta_id IS NOT NULL AND EXISTS (
                       SELECT 1 FROM hospedagem_interesses o
                        WHERE o.conta_id = i.conta_id AND o.id <> i.id AND o.status IN ('nova', 'em_contato', 'aprovada'))
                     THEN concat_ws(' · ', i.nota_interna, 'hospedagem cancelada; a conta já tem outro interesse aberto')
                     ELSE i.nota_interna END,
            atualizado_em = now()
      WHERE i.id = $1 AND i.status = 'agendada'
      RETURNING i.id, i.conta_id, i.empresa, i.status`,
    [h.interesse_id],
  );
  if (rows[0]?.status !== 'em_contato') return;
  // A pendência do interesse volta a ficar aberta para o Admin.
  await require('../pendencias/repository').abrir(
    {
      tipo: 'HOSPEDAGEM_INTERESSE',
      chave: `HOSPEDAGEM_INTERESSE:${rows[0].id}`,
      anuncianteId: rows[0].conta_id,
      titulo: `${rows[0].empresa} quer hospedar um Ponto Móvel`,
      mensagem: 'A hospedagem agendada foi cancelada — o interesse voltou para "em contato".',
      ctaRotulo: 'Ver interesses',
      ctaDestino: '#rede/moveis',
      dados: { interesseId: Number(rows[0].id) },
    },
    c,
  );
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
    await devolverInteresse(c, h);
    return { contaId: h.conta_id };
  });
}

// Alterar a hospedagem. PROGRAMADA: período, horário, local e endereço
// (o que mudar pede aceite novo do anfitrião — o termo vincula tudo isso).
// ATIVA: só prorrogar o fim (o início e o horário já estão valendo; para
// terminar antes, Encerrar). Sem conflito na agenda; o percentual continua
// o congelado.
async function alterarPeriodo(pontoId, hospedagemId, corpo) {
  try {
    return await movel.emTransacao(async (c) => {
      await movel.travarMovel(c, pontoId);
      const h = await hospedagemDoPonto(c, pontoId, hospedagemId);
      if (h.estado !== 'programada' && h.estado !== 'ativa') throw erro(409, JA_ESTA[h.estado]);
      let periodo;
      let horario = h.horario_operacao;
      let local = h.local;
      let endereco = h.endereco;
      if (h.estado === 'ativa') {
        const { instanteComercial } = require('../lib/fuso-comercial');
        const inicioPedido = instanteComercial(corpo?.inicio, { campo: 'Início' });
        if (inicioPedido && inicioPedido.getTime() !== new Date(h.inicio).getTime()) {
          throw erro(400, 'A hospedagem já começou — só o fim pode mudar', 'inicio');
        }
        if (corpo?.horario_operacao !== undefined || corpo?.local !== undefined || corpo?.endereco !== undefined) {
          throw erro(400, 'A hospedagem já começou — só o fim pode mudar (prorrogar)', 'fim');
        }
        // O fim novo com hora (`fim`) ou só o último dia (`data_fim`, o dia inteiro).
        const fimPedido =
          corpo?.fim !== undefined || !corpo?.data_fim
            ? corpo?.fim
            : alocacao.lerPeriodo({ data_inicio: corpo.data_fim }, { exigirFuturo: false }).fim;
        periodo = alocacao.lerPeriodo({ inicio: new Date(h.inicio), fim: fimPedido });
        if (periodo.fim <= new Date(h.fim)) {
          throw erro(400, 'Para terminar antes, use Encerrar — aqui é só para prorrogar', 'fim');
        }
      } else {
        periodo = alocacao.lerPeriodo(corpo);
        if (corpo?.horario_operacao !== undefined) horario = alocacao.lerHorario(corpo.horario_operacao);
        if (corpo?.local !== undefined) local = movel.texto(corpo.local, 'local', 'Local', LIMITES.local);
        if (corpo?.endereco !== undefined) {
          endereco = movel.texto(corpo.endereco, 'endereco', 'Endereço', LIMITES.endereco);
        }
      }
      await agenda.exigirLivre(c, pontoId, periodo.inicio, periodo.fim, { ignorar: { tipo: 'hospedagem', id: h.id } });
      await c.query(
        `UPDATE pontos_moveis_hospedagens
            SET inicio = $2, fim = $3, data_inicio = $4, data_fim = $5, horario_operacao = $6, local = $7, endereco = $8
          WHERE id = $1`,
        [
          h.id,
          periodo.inicio,
          periodo.fim,
          periodo.dataInicio,
          periodo.dataFim,
          horario ? JSON.stringify(horario) : null,
          local,
          endereco,
        ],
      );
      return { contaId: h.conta_id, inicio: periodo.inicio, fim: periodo.fim };
    });
  } catch (err) {
    throw agenda.traduzirErroDoBanco(err);
  }
}

// ---------------------------------------------------------------------------
// Encerramento automático (job)
// ---------------------------------------------------------------------------
// No fim previsto (data e hora), se ninguém agiu: hospedagem ativa encerra
// (com o benefício), programada que nunca começou é cancelada; o mesmo para
// evento (sem benefício). Cada linha na própria transação, travada e conferida de
// novo — duas instâncias rodando juntas nunca encerram a mesma duas vezes.
async function encerrarVencidas() {
  const { rows: vencidas } = await pool.query(
    `SELECT id, ponto_id, estado FROM pontos_moveis_hospedagens
      WHERE estado IN ('programada', 'ativa') AND fim <= now()
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
          await devolverInteresse(c, h);
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
      WHERE estado IN ('programado', 'em_andamento') AND fim <= now() ORDER BY id`,
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
            WHERE id = $1 AND estado IN ('programado', 'em_andamento') AND fim <= now()
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

// ---------------------------------------------------------------------------
// Apuração tardia (job)
// ---------------------------------------------------------------------------
// A tela que exibiu sem internet só manda os segmentos quando volta — e o
// fim da hospedagem é justamente quando ela é desligada e levada embora.
// O que chegar DEPOIS do encerramento, mas comprovando operação DENTRO da
// janela da hospedagem (iniciada_em → encerrada_em, que não muda), soma: o
// tempo é apurado de novo e a diferença do benefício entra como lançamento
// complementar, com chave pelo total (`hospedagem:<id>:ate:<total>`) —
// repetir grava uma vez, e o total lançado é sempre o benefício do tempo
// final, nunca a soma de arredondamentos. Nunca diminui. Vale pelo mesmo
// prazo que o servidor aceita segmento atrasado (src/player/operacao.js).
// Um dia a mais que o prazo do segmento atrasado (8 dias): o aceito no
// limite ainda passa pelo job.
const DIAS_DE_APURACAO_TARDIA = 9;

async function apurarTardias() {
  const { rows: candidatas } = await pool.query(
    `SELECT h.id, h.ponto_id FROM pontos_moveis_hospedagens h
      WHERE h.estado = 'encerrada' AND h.encerrada_em > now() - make_interval(days => $1)
        AND EXISTS (SELECT 1 FROM tela_operacao o
                     WHERE o.ponto_id = h.ponto_id AND o.origem = 'player'
                       AND o.recebido_em > h.encerrada_em - interval '7 minutes'
                       AND o.fim > h.iniciada_em AND o.inicio < h.encerrada_em)
     ORDER BY h.id`,
    [DIAS_DE_APURACAO_TARDIA],
  );
  let apuradas = 0;
  for (const v of candidatas) {
    try {
      const r = await movel.emTransacao(async (c) => {
        await c.query('SELECT 1 FROM pontos WHERE id = $1 FOR UPDATE', [v.ponto_id]);
        const {
          rows: [h],
        } = await c.query(`SELECT * FROM pontos_moveis_hospedagens WHERE id = $1 FOR UPDATE`, [v.id]);
        if (h?.estado !== 'encerrada') return null;
        const tempo = await tempoValido(c, h, h.encerrada_em);
        if (tempo <= h.tempo_operacional_segundos) return null;
        const beneficio = Math.max(h.beneficio_segundos, beneficioDe(tempo, h.percentual));
        await c.query(
          `UPDATE pontos_moveis_hospedagens SET tempo_operacional_segundos = $2, beneficio_segundos = $3 WHERE id = $1`,
          [h.id, tempo, beneficio],
        );
        const {
          rows: [lancado],
        } = await c.query(
          `SELECT COALESCE(SUM(segundos), 0)::bigint AS segundos FROM saldo_hospedagem_lancamentos
            WHERE hospedagem_id = $1 AND tipo = 'beneficio'`,
          [h.id],
        );
        const falta = beneficio - Number(lancado.segundos);
        if (falta > 0) {
          await c.query(
            `INSERT INTO saldo_hospedagem_lancamentos (conta_id, tipo, segundos, chave, hospedagem_id)
             VALUES ($1, 'beneficio', $2, $3, $4)
             ON CONFLICT (chave) DO NOTHING`,
            [h.conta_id, falta, `hospedagem:${h.id}:ate:${beneficio}`, h.id],
          );
        }
        return { contaId: h.conta_id, acrescimo: falta };
      });
      if (!r) continue;
      apuradas += 1;
      require('../lib/sse').emitirParaConta(r.contaId, 'hosting.updated', {});
      if (r.acrescimo > 0) {
        await require('../creditos/notificacoes').registrarSemFalhar(r.contaId, {
          tipo: 'hospedagem_encerrada',
          titulo: `Mais ${duracaoLegivel(r.acrescimo)} de mídia pela hospedagem do Ponto Móvel`,
          descricao:
            'A tela mandou o tempo que operou sem internet e ele entrou na conta da hospedagem. As horas já estão no seu saldo.',
          entidadeTipo: 'hospedagem',
          link: '/anunciante/painel.html#modHospedagem',
        });
      }
    } catch (err) {
      console.error(`apuração tardia da hospedagem ${v.id} falhou (tenta de novo no próximo ciclo)`, err.message);
    }
  }
  return { apuradas };
}

const INTERVALO_MS = 5 * 60 * 1000;
function iniciarJob() {
  const rodar = () =>
    encerrarVencidas()
      .then(() => apurarTardias())
      .catch((err) => console.error('job de encerramento do ponto móvel falhou', err.message));
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
      // Recebido − entregue SEM piso: negativo só se a rede entregou além do
      // saldo (arredondamento por tela) — o Admin vê; a conta vê 0.
      diferencaSegundos: recebido - entregue,
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
  diferencaSegundos: 0,
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
// limite: soma toda a entrega de hospedagem de toda conta que já recebeu
// horas, a cada geração de playlist — barato com a rede de hoje; se crescer,
// guardar o total entregue liquidado (como o banco de horas faz) e só somar
// o que veio depois.
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
    // Duplo clique ou retry da rede: a mesma chave grava uma vez — e o
    // repetido responde o que JÁ foi lançado (nunca "ok" para outro valor).
    const chave = `ajuste:${id}:${/^[A-Za-z0-9-]{8,64}$/.test(String(corpo?.chave ?? '')) ? corpo.chave : crypto.randomUUID()}`;
    const { rows: ja } = await c.query('SELECT segundos FROM saldo_hospedagem_lancamentos WHERE chave = $1', [chave]);
    if (ja[0]) {
      if (Number(ja[0].segundos) !== segundos) {
        throw erro(409, 'Esse ajuste já foi lançado com outro valor — feche e abra o ajuste de novo', 'minutos');
      }
      return { contaId: id, segundos, repetido: true };
    }
    // Retirar só o que ainda não está programado: o que já está na grade
    // (reservado) pode ser confirmado pela TV depois, e o saldo ficaria
    // negativo escondido.
    if (segundos < 0) {
      const s = await saldoDaConta(id, c);
      if (s.paraProgramarSegundos + segundos < 0) {
        throw erro(
          400,
          `O ajuste deixaria o saldo negativo — retire no máximo ${Math.floor(s.paraProgramarSegundos / 60)} min (o que não está programado)`,
          'minutos',
        );
      }
    }
    await c.query(
      `INSERT INTO saldo_hospedagem_lancamentos (conta_id, tipo, segundos, chave, motivo, admin)
       VALUES ($1, 'ajuste', $2, $3, $4, $5)`,
      [id, segundos, chave, motivo, admin || 'admin'],
    );
    return { contaId: id, segundos, repetido: false };
  });
}

async function extratoDaConta(contaId) {
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
    admin: r.admin,
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
    `SELECT h.id, h.ponto_id, h.conta_id, h.local, h.endereco, h.data_inicio, h.data_fim, h.inicio, h.fim,
            h.horario_operacao, h.percentual, h.estado, h.iniciada_em, h.encerrada_em, h.tempo_operacional_segundos,
            h.beneficio_segundos, p.nome AS ponto_nome, p.movel_numero
       FROM pontos_moveis_hospedagens h JOIN pontos p ON p.id = h.ponto_id
      WHERE h.conta_id = $1 AND h.estado IN ('programada', 'ativa', 'encerrada')
      ORDER BY CASE h.estado WHEN 'ativa' THEN 0 WHEN 'programada' THEN 1 ELSE 2 END,
               CASE WHEN h.estado = 'programada' THEN h.inicio END, h.encerrada_em DESC NULLS LAST, h.id DESC
      LIMIT 20`,
    [contaId],
  );
  const documentos = await require('./hospedagem-termo').documentosDasHospedagens(rows);
  const lista = [];
  for (const h of rows) {
    const doc = documentos.get(String(h.id));
    const item = {
      id: Number(h.id),
      ponto: h.ponto_nome,
      // Só o que é dela: se já aceitou o termo (a programada espera o aceite).
      termoAceito: Boolean(doc?.aceite) && !doc.prorrogacaoSemAceite,
      // Ativa prorrogada depois do aceite: o novo período pede o acordo dela.
      prorrogacaoSemAceite: h.estado === 'ativa' && Boolean(doc?.prorrogacaoSemAceite),
      local: h.local,
      endereco: h.endereco,
      inicio: h.inicio,
      fim: h.fim,
      horario: h.horario_operacao ? resumoDoHorario(h.horario_operacao) : null,
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
      item.tempoSegundos = await tempoValido(pool, h, new Date());
      item.beneficioEstimadoSegundos = beneficioDe(item.tempoSegundos, h.percentual);
    }
    lista.push(item);
  }
  return lista;
}

// Admin: todas as hospedagens de um móvel (agenda + histórico).
async function hospedagensDoPonto(pontoId, db = pool) {
  const { rows } = await db.query(
    `SELECT h.*, a.nome_empresa AS conta_nome, (h.fim <= now()) AS terminou, cat.nome AS categoria_nome,
            (SELECT p.movel_numero FROM pontos p WHERE p.id = h.ponto_id) AS movel_numero
       FROM pontos_moveis_hospedagens h JOIN anunciantes a ON a.id = h.conta_id
       LEFT JOIN categorias cat ON cat.id = h.categoria_id
      WHERE h.ponto_id = $1
      ORDER BY CASE h.estado WHEN 'ativa' THEN 0 WHEN 'programada' THEN 1 ELSE 2 END,
               CASE WHEN h.estado = 'programada' THEN h.inicio END, h.inicio DESC, h.id DESC`,
    [pontoId],
  );
  const documentos = await require('./hospedagem-termo').documentosDasHospedagens(rows);
  const lista = [];
  for (const h of rows) {
    const ativa = h.estado === 'ativa';
    const doc = documentos.get(String(h.id));
    const tempoAteAgora = ativa ? await tempoValido(db, h, new Date()) : null;
    lista.push({
      id: Number(h.id),
      conta: { id: h.conta_id, nome: h.conta_nome },
      interesseId: h.interesse_id ? Number(h.interesse_id) : null,
      local: h.local,
      endereco: h.endereco,
      inicio: h.inicio,
      fim: h.fim,
      // Para o formulário de alteração: o período na parede de Matão e o
      // horário como está gravado.
      inicioLocal: alocacao.parede(h.inicio),
      fimLocal: alocacao.parede(h.fim),
      horarioOperacao: h.horario_operacao,
      horario: h.horario_operacao ? resumoDoHorario(h.horario_operacao) : null,
      categoria: h.categoria_id ? { id: h.categoria_id, nome: h.categoria_nome } : null,
      observacao: h.observacao,
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
      // Termo e equipamento: aceite que vale para o período/percentual de
      // agora, quantos aceites anteriores ficaram de histórico, entrega e
      // retirada.
      aceite: doc?.aceite || null,
      aceitesAnteriores: doc?.aceitesAnteriores || 0,
      prorrogacaoSemAceite: Boolean(doc?.prorrogacaoSemAceite),
      entrega: doc?.entrega || null,
      retirada: doc?.retirada || null,
    });
  }
  return lista;
}

// Aviso à conta anfitriã: as horas chegaram (ou a hospedagem acabou sem
// tempo comprovado). Aviso nunca derruba o encerramento que já aconteceu.
async function avisarBeneficio({ contaId, beneficioSegundos, tempoSegundos = 0 }) {
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
        : tempoSegundos > 0
          ? 'O tempo que a tela operou não chegou a gerar horas nesse percentual.'
          : 'A tela ainda não comprovou tempo de operação nesse período. Se ela exibiu sem internet, o tempo entra quando ela sincronizar.',
    entidadeTipo: 'hospedagem',
    link: '/anunciante/painel.html#modHospedagem',
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
const { resumo: resumoDoHorario } = require('../lib/horario-semanal');

module.exports = {
  PERCENTUAL_PADRAO,
  apurarTardias,
  REGRA_DO_SALDO,
  pecasDoSaldo,
  lerPercentual,
  percentualAtual,
  alterarPercentual,
  historicoDoPercentual,
  beneficioDe,
  tempoOperacional,
  tempoValido,
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
