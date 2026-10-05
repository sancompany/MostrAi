const crypto = require('node:crypto');
const pool = require('../db/pool');

// TERMO DE HOSPEDAGEM TEMPORÁRIA e o registro de ENTREGA/RETIRADA do
// equipamento (migration 113, seções 10 e 11).
//
// Termo: versões imutáveis (o texto de uma versão publicada nunca muda —
// versão nova é linha nova); uma vigente. O anfitrião aceita no painel a
// versão vigente PARA AQUELA hospedagem: o aceite guarda versão, hash do
// texto, os dados da hospedagem como foram aceitos e o hash do documento
// inteiro, mais a evidência técnica (IP, navegador, conta da sessão). Sem
// aceite que bata com o período e o percentual atuais, a hospedagem não
// inicia (src/pontos/hospedagem.js#iniciar). A versão inicial é MINUTA — o
// texto definitivo depende de revisão jurídica (docs/PENDENCIAS.md §T).
//
// Entrega e retirada: um registro de cada por hospedagem — itens, condição,
// observação, foto opcional, quando e qual Admin. A entrega é condição para
// iniciar; a retirada vem com o encerramento ou depois.

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });
const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
const dia = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

const LIMITES = { versao: 40, titulo: 200, texto: 20000, responsavel: 120, observacao: 1000, userAgent: 300 };

function texto(valor, campo, rotulo, maximo, { obrigatorio = true, minimo = 1 } = {}) {
  const t = typeof valor === 'string' ? valor.trim() : '';
  if (!t) {
    if (obrigatorio) throw erro(400, `${rotulo}: preencha`, campo);
    return null;
  }
  if (t.length < minimo) throw erro(400, `${rotulo}: no mínimo ${minimo} caracteres`, campo);
  if (t.length > maximo) throw erro(400, `${rotulo}: no máximo ${maximo} caracteres`, campo);
  return t;
}

// ---------------------------------------------------------------------------
// Versões do termo
// ---------------------------------------------------------------------------
const linhaDoTermo = (r) =>
  r && {
    versao: r.versao,
    titulo: r.titulo,
    texto: r.texto,
    hash: r.hash_sha256,
    vigente: r.vigente,
    publicadoEm: r.publicado_em,
    publicadoPor: r.publicado_por,
    minuta: /^minuta/i.test(r.versao),
  };

async function termoVigente(db = pool) {
  const { rows } = await db.query('SELECT * FROM hospedagem_termos WHERE vigente');
  return linhaDoTermo(rows[0]) || null;
}

async function listarTermos() {
  const { rows } = await pool.query('SELECT * FROM hospedagem_termos ORDER BY publicado_em DESC, versao');
  return rows.map(linhaDoTermo);
}

// Publicar = versão nova vigente; as antigas ficam (os aceites apontam para
// elas). Mesma versão de novo → 409.
async function publicarTermo(corpo, admin) {
  const versao = texto(corpo?.versao, 'versao', 'Versão', LIMITES.versao);
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(versao)) {
    throw erro(400, 'Versão: só letras, números, ponto, hífen e sublinhado', 'versao');
  }
  const titulo = texto(corpo?.titulo, 'titulo', 'Título', LIMITES.titulo);
  const corpoTexto = texto(corpo?.texto, 'texto', 'Texto', LIMITES.texto, { minimo: 50 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('LOCK TABLE hospedagem_termos IN SHARE ROW EXCLUSIVE MODE');
    const { rows: ja } = await c.query('SELECT 1 FROM hospedagem_termos WHERE versao = $1', [versao]);
    if (ja[0]) throw erro(409, 'Essa versão já existe — use outro nome de versão', 'versao');
    await c.query('UPDATE hospedagem_termos SET vigente = false WHERE vigente');
    const { rows } = await c.query(
      `INSERT INTO hospedagem_termos (versao, titulo, texto, hash_sha256, vigente, publicado_por)
       VALUES ($1, $2, $3, $4, true, $5) RETURNING *`,
      [versao, titulo, corpoTexto, sha256(corpoTexto), admin || 'admin'],
    );
    await c.query('COMMIT');
    return linhaDoTermo(rows[0]);
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// Aceite
// ---------------------------------------------------------------------------
// Os dados desta hospedagem que entram no documento aceito.
function dadosDaHospedagem(h) {
  return {
    local: h.local,
    endereco: h.endereco,
    dataInicio: dia(h.data_inicio),
    dataFim: dia(h.data_fim),
    percentual: Number(h.percentual),
  };
}

// Hash do documento inteiro: versão + hash do texto + dados + quem aceitou,
// numa serialização de ordem fixa.
function hashDoDocumento(termo, dados, responsavel) {
  return sha256(
    JSON.stringify([
      termo.versao,
      termo.hash,
      dados.local,
      dados.endereco,
      dados.dataInicio,
      dados.dataFim,
      dados.percentual,
      responsavel,
    ]),
  );
}

// O aceite que vale para a hospedagem COMO ESTÁ: mesma conta, mesmo período,
// mesmo percentual (alterar o período de uma programada pede aceite novo).
async function aceiteValido(db, h) {
  const { rows } = await db.query(
    `SELECT * FROM hospedagem_aceites
      WHERE hospedagem_id = $1 AND conta_id = $2 AND data_inicio = $3 AND data_fim = $4 AND percentual = $5
      ORDER BY aceito_em DESC, id DESC LIMIT 1`,
    [h.id, h.conta_id, dia(h.data_inicio), dia(h.data_fim), h.percentual],
  );
  return rows[0] || null;
}

const linhaDoAceite = (a) =>
  a && {
    termoVersao: a.termo_versao,
    termoHash: a.termo_hash,
    documentoHash: a.documento_hash,
    responsavel: a.responsavel,
    aceitoEm: a.aceito_em,
  };

// O anfitrião (a conta da SESSÃO) aceita a versão vigente que leu. Versão ou
// hash diferentes da vigente → 409 (o texto mudou enquanto lia). Já aceito
// com os mesmos dados → devolve o mesmo aceite (duplo clique, retry).
async function aceitar(contaId, hospedagemId, corpo, { ip = null, userAgent = null } = {}) {
  const hid = /^\d{1,15}$/.test(String(hospedagemId)) ? String(hospedagemId) : null;
  if (!hid) throw erro(404, 'hospedagem não encontrada');
  const responsavel = texto(corpo?.responsavel, 'responsavel', 'Seu nome', LIMITES.responsavel, { minimo: 3 });
  if (corpo?.concordo !== true) throw erro(400, 'Marque que leu e concorda com o termo', 'concordo');
  const movel = require('./movel');
  return movel.emTransacao(async (c) => {
    // Mesma ordem de trava das ações do Admin: ponto → hospedagem.
    const { rows: alvo } = await c.query(
      'SELECT ponto_id FROM pontos_moveis_hospedagens WHERE id = $1 AND conta_id = $2',
      [hid, contaId],
    );
    if (!alvo[0]) throw erro(404, 'hospedagem não encontrada');
    await movel.travarMovel(c, alvo[0].ponto_id);
    const {
      rows: [h],
    } = await c.query('SELECT * FROM pontos_moveis_hospedagens WHERE id = $1 FOR UPDATE', [hid]);
    if (h.estado !== 'programada') throw erro(409, 'Essa hospedagem não está mais aguardando aceite');
    const termo = await termoVigente(c);
    if (!termo) throw erro(409, 'Nenhum termo publicado — fale com a Mostraí');
    if (corpo?.versao !== termo.versao || corpo?.hash !== termo.hash) {
      throw erro(409, 'O termo foi atualizado enquanto você lia — abra de novo para ler a versão atual');
    }
    const ja = await aceiteValido(c, h);
    if (ja && ja.termo_versao === termo.versao) return { contaId, aceite: linhaDoAceite(ja), repetido: true };
    const dados = dadosDaHospedagem(h);
    const {
      rows: [a],
    } = await c.query(
      `INSERT INTO hospedagem_aceites
         (hospedagem_id, ponto_id, conta_id, termo_versao, termo_hash, documento_hash, responsavel,
          local, endereco, data_inicio, data_fim, percentual, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        h.id,
        h.ponto_id,
        contaId,
        termo.versao,
        termo.hash,
        hashDoDocumento(termo, dados, responsavel),
        responsavel,
        dados.local,
        dados.endereco,
        dados.dataInicio,
        dados.dataFim,
        dados.percentual,
        ip ? String(ip).slice(0, 64) : null,
        userAgent ? String(userAgent).slice(0, LIMITES.userAgent) : null,
      ],
    );
    return { contaId, pontoId: h.ponto_id, aceite: linhaDoAceite(a), repetido: false };
  });
}

// O termo como a conta vê para UMA hospedagem dela: o texto vigente, os
// dados que vão junto e se já está aceito.
async function termoDaHospedagem(contaId, hospedagemId) {
  const hid = /^\d{1,15}$/.test(String(hospedagemId)) ? String(hospedagemId) : null;
  if (!hid) throw erro(404, 'hospedagem não encontrada');
  const { rows } = await pool.query('SELECT * FROM pontos_moveis_hospedagens WHERE id = $1 AND conta_id = $2', [
    hid,
    contaId,
  ]);
  if (!rows[0]) throw erro(404, 'hospedagem não encontrada');
  const h = rows[0];
  const [termo, aceite] = await Promise.all([termoVigente(), aceiteValido(pool, h)]);
  return {
    termo: termo && {
      versao: termo.versao,
      titulo: termo.titulo,
      texto: termo.texto,
      hash: termo.hash,
      minuta: termo.minuta,
    },
    dados: dadosDaHospedagem(h),
    aceite: linhaDoAceite(aceite),
    podeAceitar: h.estado === 'programada',
  };
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
  if (!itens.tela) throw erro(400, `${rotulo}: marque a tela (o Ponto Móvel é a tela)`, 'itens');
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

// Retirada avulsa: hospedagem em andamento (o Admin recolhe e em seguida
// encerra) ou já encerrada (o encerramento automático não recolhe nada).
async function registrarRetirada(pontoId, hospedagemId, corpo, admin) {
  const movel = require('./movel');
  return movel.emTransacao(async (c) => {
    await movel.travarMovel(c, pontoId);
    const h = await hospedagemTravada(c, pontoId, hospedagemId);
    if (h.estado !== 'ativa' && h.estado !== 'encerrada') {
      throw erro(409, 'Retirada só de hospedagem em andamento ou encerrada');
    }
    const retirada = await registrarMovimentacao(c, h, 'retirada', corpo, admin);
    return { contaId: h.conta_id, retirada };
  });
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

// Foto da entrega ou da retirada (o upload é da rota; aqui só a URL). Pode
// ser trocada — é evidência de apoio, o registro em si não muda.
async function definirFotoDaMovimentacao(pontoId, hospedagemId, tipo, url) {
  const { rowCount } = await pool.query(
    `UPDATE hospedagem_movimentacoes m SET foto_url = $4
       FROM pontos_moveis_hospedagens h
      WHERE m.hospedagem_id = h.id AND h.id = $1 AND h.ponto_id = $2 AND m.tipo = $3`,
    [hospedagemId, pontoId, tipo, url],
  );
  if (!rowCount) throw erro(404, `${tipo === 'entrega' ? 'Entrega' : 'Retirada'} ainda não registrada`);
}

// Para a ficha do Admin: aceite válido, todos os aceites e as movimentações
// de cada hospedagem.
async function documentosDasHospedagens(hospedagens) {
  if (!hospedagens.length) return new Map();
  const ids = hospedagens.map((h) => h.id);
  const [{ rows: aceites }, { rows: movs }] = await Promise.all([
    pool.query(
      'SELECT * FROM hospedagem_aceites WHERE hospedagem_id = ANY($1::bigint[]) ORDER BY aceito_em DESC, id DESC',
      [ids],
    ),
    pool.query('SELECT * FROM hospedagem_movimentacoes WHERE hospedagem_id = ANY($1::bigint[])', [ids]),
  ]);
  const mapa = new Map();
  for (const h of hospedagens) {
    const dela = aceites.filter((a) => String(a.hospedagem_id) === String(h.id));
    const valido = dela.find(
      (a) =>
        dia(a.data_inicio) === dia(h.data_inicio) &&
        dia(a.data_fim) === dia(h.data_fim) &&
        Number(a.percentual) === Number(h.percentual) &&
        Number(a.conta_id) === Number(h.conta_id),
    );
    mapa.set(String(h.id), {
      aceite: linhaDoAceite(valido) || null,
      aceitesAnteriores: dela.filter((a) => a !== valido).length,
      entrega: linhaDaMovimentacao(movs.find((m) => String(m.hospedagem_id) === String(h.id) && m.tipo === 'entrega')),
      retirada: linhaDaMovimentacao(
        movs.find((m) => String(m.hospedagem_id) === String(h.id) && m.tipo === 'retirada'),
      ),
    });
  }
  return mapa;
}

module.exports = {
  ITENS,
  sha256,
  termoVigente,
  listarTermos,
  publicarTermo,
  aceitar,
  aceiteValido,
  termoDaHospedagem,
  registrarMovimentacao,
  movimentacaoDe,
  registrarRetirada,
  definirFotoDaMovimentacao,
  documentosDasHospedagens,
};
