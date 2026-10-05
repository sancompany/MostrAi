const pool = require('../db/pool');

// TERMO FÍSICO e ENTREGA/RETIRADA do equipamento de uma hospedagem
// (migrations 113 e 115).
//
// Termo: o termo de hospedagem é assinado EM PAPEL (migration 115 — o aceite
// eletrônico, com versões e hash, saiu: o sistema não é plataforma de
// assinatura). Aqui fica só o controle operacional: o Admin marca "termo
// físico assinado" (Pendente → Assinado), com a data da assinatura e uma
// observação opcionais, e quem marcou e quando. O modelo do termo físico
// passa por revisão jurídica antes da primeira hospedagem real
// (docs/PENDENCIAS.md, T13).
//
// Entrega e retirada: um registro de cada por hospedagem — itens, condição,
// observação, foto opcional, quando e qual Admin. Iniciar a hospedagem exige
// o termo físico assinado E a entrega (src/pontos/hospedagem.js#iniciar); a
// retirada vem com o encerramento ou depois.

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });

const LIMITES = { observacao: 1000 };

function texto(valor, campo, rotulo, maximo, { obrigatorio = true } = {}) {
  const t = typeof valor === 'string' ? valor.trim() : '';
  if (!t) {
    if (obrigatorio) throw erro(400, `${rotulo}: preencha`, campo);
    return null;
  }
  if (t.length > maximo) throw erro(400, `${rotulo}: no máximo ${maximo} caracteres`, campo);
  return t;
}

async function hospedagemTravada(c, pontoId, hospedagemId) {
  const hid = /^\d{1,15}$/.test(String(hospedagemId)) ? String(hospedagemId) : null;
  const { rows } = hid
    ? await c.query('SELECT * FROM pontos_moveis_hospedagens WHERE id = $1 AND ponto_id = $2 FOR UPDATE', [
        hid,
        pontoId,
      ])
    : { rows: [] };
  if (!rows[0]) throw erro(404, 'hospedagem não encontrada');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Termo físico
// ---------------------------------------------------------------------------
const linhaDoTermo = (h) => ({
  assinado: Boolean(h.termo_assinado),
  // `date` volta como texto ("2026-10-10" — src/db/pool.js).
  assinadoEm: h.termo_assinado_em || null,
  observacao: h.termo_observacao || null,
  marcadoPor: h.termo_marcado_por || null,
  marcadoEm: h.termo_marcado_em || null,
});

// `assinado` (true/false), `assinado_em` ("2026-10-10", opcional, não no
// futuro) e `observacao` (opcional). Só enquanto a hospedagem não terminou:
// programada (antes de iniciar) ou ativa (corrigir a data/observação).
// Desmarcar só na programada — na ativa o termo já valeu para iniciar.
async function marcarTermoFisico(pontoId, hospedagemId, corpo, admin) {
  if (typeof corpo?.assinado !== 'boolean') throw erro(400, 'Termo físico: informe se está assinado', 'assinado');
  let assinadoEm = null;
  if (corpo.assinado && corpo.assinado_em) {
    const v = String(corpo.assinado_em).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(`${v}T12:00:00Z`).getTime())) {
      throw erro(400, 'Data da assinatura inválida', 'assinado_em');
    }
    if (v > require('../lib/vigencia').hojeComercial()) {
      throw erro(400, 'A data da assinatura não pode ser no futuro', 'assinado_em');
    }
    assinadoEm = v;
  }
  const observacao = corpo.assinado
    ? texto(corpo.observacao, 'observacao', 'Observação', LIMITES.observacao, { obrigatorio: false })
    : null;
  const movel = require('./movel');
  return movel.emTransacao(async (c) => {
    await movel.travarMovel(c, pontoId);
    const h = await hospedagemTravada(c, pontoId, hospedagemId);
    if (h.estado !== 'programada' && h.estado !== 'ativa') {
      throw erro(409, 'Essa hospedagem já terminou — o termo não muda mais');
    }
    if (!corpo.assinado && h.estado === 'ativa') {
      throw erro(409, 'A hospedagem já começou com o termo assinado — não dá para desmarcar');
    }
    const {
      rows: [nova],
    } = await c.query(
      `UPDATE pontos_moveis_hospedagens
          SET termo_assinado = $2, termo_assinado_em = $3, termo_observacao = $4,
              termo_marcado_por = $5, termo_marcado_em = now()
        WHERE id = $1 RETURNING *`,
      [h.id, corpo.assinado, assinadoEm, observacao, admin || 'admin'],
    );
    return { contaId: h.conta_id, termo: linhaDoTermo(nova) };
  });
}

// ---------------------------------------------------------------------------
// Entrega e retirada
// ---------------------------------------------------------------------------
const ITENS = ['tela', 'suporte', 'player', 'cabos', 'controle'];

function lerMovimentacao(corpo, rotulo) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) {
    throw erro(400, `${rotulo}: informe os itens e a condição`, 'itens');
  }
  const itens = {};
  for (const item of ITENS) itens[item] = corpo.itens?.[item] === true;
  if (!itens.tela) throw erro(400, `${rotulo}: marque a tela`, 'itens');
  const condicao = corpo.condicao === 'com_avarias' ? 'com_avarias' : corpo.condicao === 'ok' ? 'ok' : null;
  if (!condicao) throw erro(400, `${rotulo}: informe a condição do equipamento`, 'condicao');
  const observacao = texto(corpo.observacao, 'observacao', 'Observação', LIMITES.observacao, {
    obrigatorio: condicao === 'com_avarias',
  });
  return { itens, condicao, observacao };
}

const linhaDaMovimentacao = (m) =>
  m && {
    tipo: m.tipo,
    itens: m.itens,
    condicao: m.condicao,
    observacao: m.observacao,
    foto: m.foto_url,
    realizadaEm: m.realizada_em,
    admin: m.admin,
  };

// Dentro da transação de quem chama (a hospedagem já travada). Uma de cada
// por hospedagem: repetir → 409.
async function registrarMovimentacao(c, h, tipo, corpo, admin) {
  const dados = lerMovimentacao(corpo, tipo === 'entrega' ? 'Entrega' : 'Retirada');
  const { rows } = await c.query(
    `INSERT INTO hospedagem_movimentacoes (hospedagem_id, tipo, itens, condicao, observacao, realizada_em, admin)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (hospedagem_id, tipo) DO NOTHING RETURNING *`,
    [h.id, tipo, JSON.stringify(dados.itens), dados.condicao, dados.observacao, admin || 'admin'],
  );
  if (!rows[0]) throw erro(409, tipo === 'entrega' ? 'A entrega já foi registrada' : 'A retirada já foi registrada');
  return linhaDaMovimentacao(rows[0]);
}

async function movimentacaoDe(db, hospedagemId, tipo) {
  const { rows } = await db.query('SELECT * FROM hospedagem_movimentacoes WHERE hospedagem_id = $1 AND tipo = $2', [
    hospedagemId,
    tipo,
  ]);
  return rows[0] || null;
}

// Retirada avulsa: só de hospedagem já encerrada (o encerramento automático
// não recolhe nada). Em andamento, a retirada vai no próprio encerramento —
// recolher sem encerrar deixaria o tempo seguinte contando para o anfitrião.
async function registrarRetirada(pontoId, hospedagemId, corpo, admin) {
  const movel = require('./movel');
  return movel.emTransacao(async (c) => {
    await movel.travarMovel(c, pontoId);
    const h = await hospedagemTravada(c, pontoId, hospedagemId);
    if (h.estado !== 'encerrada') {
      throw erro(409, 'Retirada avulsa só de hospedagem encerrada — em andamento, registre ao encerrar');
    }
    const retirada = await registrarMovimentacao(c, h, 'retirada', corpo, admin);
    return { contaId: h.conta_id, retirada };
  });
}

async function movimentacaoDoPonto(pontoId, hospedagemId, tipo) {
  const { rows } = await pool.query(
    `SELECT m.id FROM hospedagem_movimentacoes m JOIN pontos_moveis_hospedagens h ON h.id = m.hospedagem_id
      WHERE h.id = $1 AND h.ponto_id = $2 AND m.tipo = $3`,
    [hospedagemId, pontoId, tipo],
  );
  return rows[0] || null;
}

// Foto da entrega ou da retirada (o upload é da rota; aqui só a URL). Pode
// ser trocada — é evidência de apoio, o registro em si não muda; cada envio
// é um arquivo novo, então a foto anterior continua no bucket.
async function definirFotoDaMovimentacao(pontoId, hospedagemId, tipo, url) {
  const { rowCount } = await pool.query(
    `UPDATE hospedagem_movimentacoes m SET foto_url = $4
       FROM pontos_moveis_hospedagens h
      WHERE m.hospedagem_id = h.id AND h.id = $1 AND h.ponto_id = $2 AND m.tipo = $3`,
    [hospedagemId, pontoId, tipo, url],
  );
  if (!rowCount) throw erro(404, `${tipo === 'entrega' ? 'Entrega' : 'Retirada'} ainda não registrada`);
}

// Para a ficha do Admin e o painel: termo físico e movimentações de cada
// hospedagem.
async function documentosDasHospedagens(hospedagens) {
  if (!hospedagens.length) return new Map();
  const ids = hospedagens.map((h) => h.id);
  const { rows: movs } = await pool.query(
    'SELECT * FROM hospedagem_movimentacoes WHERE hospedagem_id = ANY($1::bigint[])',
    [ids],
  );
  const mapa = new Map();
  for (const h of hospedagens) {
    const dela = (tipo) => movs.find((m) => String(m.hospedagem_id) === String(h.id) && m.tipo === tipo);
    mapa.set(String(h.id), {
      termo: linhaDoTermo(h),
      entrega: linhaDaMovimentacao(dela('entrega')),
      retirada: linhaDaMovimentacao(dela('retirada')),
    });
  }
  return mapa;
}

module.exports = {
  ITENS,
  marcarTermoFisico,
  registrarMovimentacao,
  movimentacaoDe,
  movimentacaoDoPonto,
  registrarRetirada,
  definirFotoDaMovimentacao,
  documentosDasHospedagens,
};
