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
// aceite que bata com o que a hospedagem é AGORA — local, endereço, período
// com data e hora, horário de funcionamento, percentual e equipamento
// (migration 114) — a hospedagem não inicia (src/pontos/hospedagem.js#iniciar):
// mudança material pede aceite novo, e os anteriores ficam. As versões
// publicadas são MINUTA — o texto definitivo depende de revisão jurídica
// (docs/PENDENCIAS.md §T).
//
// Entrega e retirada: um registro de cada por hospedagem — itens, condição,
// observação, foto opcional, quando e qual Admin. A entrega é condição para
// iniciar; a retirada vem com o encerramento ou depois.

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });
const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
const dia = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const instante = (d) => (d ? new Date(d).toISOString() : null);
const { DIAS, resumo: resumoDoHorario } = require('../lib/horario-semanal');
// O horário numa forma canônica (ordem fixa dos dias): o jsonb do banco não
// garante a ordem das chaves, e o hash precisa ser o mesmo nas duas pontas.
const horarioCanonico = (h) =>
  h ? DIAS.map((d) => (h[d] ? `${d}:${h[d].abre}-${h[d].fecha}` : `${d}:-`)).join(',') : null;
// O equipamento da hospedagem: o número do móvel nunca muda nem é
// reaproveitado (migration 112).
const equipamentoDe = (h) => (h.movel_numero ? `Mostraí Móvel #${String(h.movel_numero).padStart(2, '0')}` : null);
// Quem carrega a hospedagem para o termo traz o número do móvel junto.
const COM_EQUIPAMENTO = `(SELECT p.movel_numero FROM pontos p WHERE p.id = h.ponto_id) AS movel_numero`;

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
// Os dados desta hospedagem que entram no documento aceito. `dataInicio` e
// `dataFim` (dias) continuam para a leitura antiga; o que vincula é o
// período com hora, o horário e o equipamento.
function dadosDaHospedagem(h) {
  return {
    local: h.local,
    endereco: h.endereco,
    inicio: instante(h.inicio),
    fim: instante(h.fim),
    horario: h.horario_operacao || null,
    horarioResumo: h.horario_operacao ? resumoDoHorario(h.horario_operacao) : null,
    percentual: Number(h.percentual),
    equipamento: equipamentoDe(h),
    dataInicio: dia(h.data_inicio),
    dataFim: dia(h.data_fim),
  };
}

const camposQueVinculam = (d) => [
  d.local,
  d.endereco,
  d.inicio,
  d.fim,
  horarioCanonico(d.horario),
  d.percentual,
  d.equipamento,
];

// Impressão dos dados que o anfitrião LEU: o painel devolve no aceite e, se
// o Admin mudou alguma coisa no meio da leitura, o aceite é recusado.
const hashDosDados = (dados) => sha256(JSON.stringify(camposQueVinculam(dados)));

// Hash do documento inteiro: versão + hash do texto + dados + quem aceitou,
// numa serialização de ordem fixa.
function hashDoDocumento(termo, dados, responsavel) {
  return sha256(JSON.stringify([termo.versao, termo.hash, ...camposQueVinculam(dados), responsavel]));
}

// O aceite bate com a hospedagem como ela é agora? Mesma conta e os mesmos
// dados que vinculam (aceite anterior à 114, sem período com hora, nunca
// bate: a hospedagem nova pede aceite novo).
function aceiteBate(a, h) {
  return (
    Number(a.conta_id) === Number(h.conta_id) &&
    a.inicio != null &&
    JSON.stringify(camposQueVinculam(dadosDoAceite(a))) === JSON.stringify(camposQueVinculam(dadosDaHospedagem(h)))
  );
}

const dadosDoAceite = (a) => ({
  local: a.local,
  endereco: a.endereco,
  inicio: instante(a.inicio),
  fim: instante(a.fim),
  horario: a.horario_operacao || null,
  percentual: Number(a.percentual),
  equipamento: a.equipamento,
});

// O aceite que vale para a hospedagem COMO ESTÁ (`h` traz `movel_numero`).
async function aceiteValido(db, h) {
  const { rows } = await db.query(
    `SELECT * FROM hospedagem_aceites WHERE hospedagem_id = $1 AND conta_id = $2 ORDER BY aceito_em DESC, id DESC`,
    [h.id, h.conta_id],
  );
  return rows.find((a) => aceiteBate(a, h)) || null;
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
    } = await c.query(`SELECT h.*, ${COM_EQUIPAMENTO} FROM pontos_moveis_hospedagens h WHERE h.id = $1 FOR UPDATE`, [
      hid,
    ]);
    // Programada: o aceite libera o início. Ativa: registra o acordo da
    // prorrogação (o período mudou depois do aceite do início).
    if (h.estado !== 'programada' && h.estado !== 'ativa') {
      throw erro(409, 'Essa hospedagem não está mais aguardando aceite');
    }
    const termo = await termoVigente(c);
    if (!termo) throw erro(409, 'Nenhum termo publicado — fale com a Mostraí');
    if (corpo?.versao !== termo.versao || corpo?.hash !== termo.hash) {
      throw erro(409, 'O termo foi atualizado enquanto você lia — abra de novo para ler a versão atual');
    }
    const dados = dadosDaHospedagem(h);
    if (corpo?.dadosHash !== hashDosDados(dados)) {
      throw erro(409, 'Os dados desta hospedagem mudaram enquanto você lia — abra de novo para conferir');
    }
    const ja = await aceiteValido(c, h);
    if (ja && ja.termo_versao === termo.versao) return { contaId, aceite: linhaDoAceite(ja), repetido: true };
    if (ja && h.estado === 'ativa') return { contaId, aceite: linhaDoAceite(ja), repetido: true };
    const {
      rows: [a],
    } = await c.query(
      `INSERT INTO hospedagem_aceites
         (hospedagem_id, ponto_id, conta_id, termo_versao, termo_hash, documento_hash, responsavel,
          local, endereco, data_inicio, data_fim, percentual, ip, user_agent, inicio, fim, horario_operacao,
          equipamento)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
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
        h.inicio,
        h.fim,
        h.horario_operacao ? JSON.stringify(h.horario_operacao) : null,
        dados.equipamento,
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
  const { rows } = await pool.query(
    `SELECT h.*, ${COM_EQUIPAMENTO} FROM pontos_moveis_hospedagens h WHERE h.id = $1 AND h.conta_id = $2`,
    [hid, contaId],
  );
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
    dadosHash: hashDosDados(dadosDaHospedagem(h)),
    aceite: linhaDoAceite(aceite),
    podeAceitar: h.estado === 'programada' || (h.estado === 'ativa' && !aceite),
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

// Para a ficha do Admin: aceite válido, todos os aceites e as movimentações
// de cada hospedagem (`hospedagens` trazem `movel_numero`).
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
    const valido = dela.find((a) => aceiteBate(a, h));
    // Prorrogada depois do aceite: o que valeu no início continua sendo o
    // aceite dela; a prorrogação aparece como pendente (ou sem acordo).
    const doInicio =
      !valido && h.iniciada_em
        ? dela.find(
            (a) =>
              new Date(a.aceito_em) <= new Date(h.iniciada_em) && a.inicio && instante(a.inicio) === instante(h.inicio),
          )
        : null;
    mapa.set(String(h.id), {
      aceite: linhaDoAceite(valido || doInicio) || null,
      prorrogacaoSemAceite: Boolean(doInicio),
      aceitesAnteriores: dela.filter((a) => a !== (valido || doInicio)).length,
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
  movimentacaoDoPonto,
  registrarRetirada,
  definirFotoDaMovimentacao,
  documentosDasHospedagens,
};
