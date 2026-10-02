const pool = require('../db/pool');
const { colunasDoEndereco, parteQueFalta, problemaNoEndereco, linhaEndereco } = require('../lib/endereco');

// INTERESSE EM HOSPEDAR UM PONTO MÓVEL (migration 113). Só manifestação: não
// reserva equipamento, não escolhe período nem percentual, não cria conta.
// Do site público (visitante, ou logado — aí vai com a conta) ou do painel
// (logado, dados preenchidos). O Admin entra em contato, recusa ou agenda
// (a hospedagem nasce em src/pontos/hospedagem.js#criar com `interesse_id`).

const LIMITES = { empresa: 120, responsavel: 120, email: 160, observacao: 500, disponibilidade: 300, segmento: 80 };
const STATUS = ['nova', 'em_contato', 'agendada', 'recusada'];
const ABERTOS = ['nova', 'em_contato'];

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });

function texto(valor, campo, rotulo, maximo, obrigatorio = true) {
  const t = typeof valor === 'string' ? valor.trim().replace(/\s+/g, ' ') : '';
  if (!t) {
    if (obrigatorio) throw erro(400, `${rotulo}: preencha`, campo);
    return null;
  }
  if (t.length > maximo) throw erro(400, `${rotulo}: no máximo ${maximo} caracteres`, campo);
  return t;
}

function validar(corpo) {
  const empresa = texto(corpo?.empresa, 'empresa', 'Empresa', LIMITES.empresa);
  const responsavel = texto(corpo?.responsavel, 'responsavel', 'Responsável', LIMITES.responsavel);
  const telefone = typeof corpo?.contato_telefone === 'string' ? corpo.contato_telefone.replace(/\D/g, '') : '';
  if (telefone.length < 10 || telefone.length > 11) {
    throw erro(400, 'WhatsApp: informe DDD + número', 'contato_telefone');
  }
  const email = texto(corpo?.contato_email, 'contato_email', 'E-mail', LIMITES.email, false);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw erro(400, 'E-mail inválido', 'contato_email');
  const problema = problemaNoEndereco(corpo || {});
  if (problema) throw erro(400, problema.erro, problema.campo);
  const end = colunasDoEndereco(corpo || {});
  const falta = parteQueFalta(end);
  if (falta) throw erro(400, `Endereço: preencha o campo ${falta}`, 'cep');
  let categoriaId = null;
  if (corpo?.categoria_id !== undefined && corpo?.categoria_id !== null && String(corpo.categoria_id).trim() !== '') {
    categoriaId = Number(corpo.categoria_id);
    if (!Number.isInteger(categoriaId) || categoriaId <= 0) throw erro(400, 'Segmento inválido', 'categoria_id');
  }
  return {
    empresa,
    responsavel,
    telefone,
    email: email ? email.toLowerCase() : null,
    end,
    endereco: linhaEndereco(end, { comCidade: true }),
    categoriaId,
    categoriaLivre: categoriaId ? null : texto(corpo?.segmento, 'segmento', 'Segmento', LIMITES.segmento, false),
    disponibilidade: texto(
      corpo?.disponibilidade,
      'disponibilidade',
      'Disponibilidade',
      LIMITES.disponibilidade,
      false,
    ),
    observacao: texto(corpo?.observacao, 'observacao', 'Observação', LIMITES.observacao, false),
  };
}

// `contaId`: a conta logada (nunca do corpo). Um interesse em aberto por
// conta — e, sem conta, por telefone: repetir o envio não duplica (e a
// resposta é a mesma, para não dizer a ninguém se aquele número já pediu).
async function registrar(corpo, { contaId = null, origem = 'publico' } = {}) {
  const d = validar(corpo);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // Serializa por conta/telefone: dois envios simultâneos não criam dois.
    await cliente.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      contaId ? `hospedagem-interesse:conta:${contaId}` : `hospedagem-interesse:tel:${d.telefone}`,
    ]);
    if (d.categoriaId) {
      const { rows } = await cliente.query('SELECT 1 FROM categorias WHERE id = $1 AND ativo', [d.categoriaId]);
      // Do painel o ramo vem do cadastro da conta — um ramo antigo (legado)
      // não impede o interesse: só não vai junto.
      if (!rows[0] && origem !== 'painel') throw erro(400, 'Segmento não encontrado', 'categoria_id');
      if (!rows[0]) d.categoriaId = null;
    }
    const { rows: abertos } = await cliente.query(
      `SELECT id FROM hospedagem_interesses
        WHERE status = ANY($3::text[])
          AND (($1::int IS NOT NULL AND conta_id = $1) OR ($1::int IS NULL AND conta_id IS NULL AND contato_telefone = $2))
        LIMIT 1`,
      [contaId, d.telefone, ABERTOS],
    );
    if (abertos[0]) {
      await cliente.query('COMMIT');
      return { id: Number(abertos[0].id), novo: false };
    }
    const { rows } = await cliente.query(
      `INSERT INTO hospedagem_interesses
         (conta_id, origem, empresa, responsavel, contato_email, contato_telefone, logradouro, numero, complemento,
          bairro, cidade, uf, cep, endereco, categoria_id, categoria_livre, disponibilidade, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        contaId,
        origem,
        d.empresa,
        d.responsavel,
        d.email,
        d.telefone,
        d.end.logradouro ?? null,
        d.end.numero ?? null,
        d.end.complemento ?? null,
        d.end.bairro ?? null,
        d.end.cidade,
        d.end.uf,
        d.end.cep ?? null,
        d.endereco,
        d.categoriaId,
        d.categoriaLivre,
        d.disponibilidade,
        d.observacao,
      ],
    );
    await cliente.query('COMMIT');
    const id = Number(rows[0].id);
    await require('../pendencias/repository')
      .abrir({
        tipo: 'HOSPEDAGEM_INTERESSE',
        chave: `HOSPEDAGEM_INTERESSE:${id}`,
        anuncianteId: contaId,
        titulo: `${d.empresa} quer hospedar um Ponto Móvel`,
        mensagem: `${d.responsavel} · ${d.endereco}. Entre em contato e, se fizer sentido, agende a hospedagem.`,
        ctaRotulo: 'Ver interesses',
        ctaDestino: '#rede/moveis',
        dados: { interesseId: id },
      })
      .catch((err) => console.error('pendência do interesse em hospedagem não aberta', err.message));
    require('../lib/sse').emitirParaAdmin('hosting.interest', { id });
    return { id, novo: true };
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

async function listar() {
  const { rows } = await pool.query(
    `SELECT i.*, cat.nome AS categoria_nome, a.nome_empresa AS conta_nome
       FROM hospedagem_interesses i
       LEFT JOIN categorias cat ON cat.id = i.categoria_id
       LEFT JOIN anunciantes a ON a.id = i.conta_id
      ORDER BY CASE i.status WHEN 'nova' THEN 0 WHEN 'em_contato' THEN 1 ELSE 2 END, i.criado_em DESC
      LIMIT 200`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    conta: r.conta_id ? { id: r.conta_id, nome: r.conta_nome } : null,
    origem: r.origem,
    empresa: r.empresa,
    responsavel: r.responsavel,
    email: r.contato_email,
    telefone: r.contato_telefone,
    endereco: r.endereco,
    segmento: r.categoria_nome || r.categoria_livre,
    categoriaId: r.categoria_id,
    disponibilidade: r.disponibilidade,
    observacao: r.observacao,
    status: r.status,
    notaInterna: r.nota_interna,
    criadoEm: r.criado_em,
    atualizadoEm: r.atualizado_em,
    atualizadoPor: r.atualizado_por_admin,
  }));
}

// O Admin muda o andamento (em contato / recusada) e a nota interna.
// "Agendada" nasce só da hospedagem confirmada — não por aqui.
async function atualizar(id, corpo, admin) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw erro(404, 'interesse não encontrado');
  const status = corpo?.status;
  if (status !== undefined && !['nova', 'em_contato', 'recusada'].includes(status)) {
    throw erro(400, 'Andamento inválido: nova, em contato ou recusada', 'status');
  }
  const nota =
    corpo?.nota_interna === undefined ? undefined : texto(corpo.nota_interna, 'nota_interna', 'Nota', 500, false);
  const { rows } = await pool.query(
    `UPDATE hospedagem_interesses
        SET status = COALESCE($2, status),
            nota_interna = CASE WHEN $3 THEN $4 ELSE nota_interna END,
            atualizado_em = now(), atualizado_por_admin = $5
      WHERE id = $1 AND status <> 'agendada'
      RETURNING id, status`,
    [n, status ?? null, nota !== undefined, nota ?? null, admin || 'admin'],
  );
  if (!rows[0]) {
    const { rows: existe } = await pool.query('SELECT status FROM hospedagem_interesses WHERE id = $1', [n]);
    if (!existe[0]) throw erro(404, 'interesse não encontrado');
    throw erro(409, 'Esse interesse já virou hospedagem agendada');
  }
  if (rows[0].status !== 'nova') {
    await require('../pendencias/repository')
      .resolver(`HOSPEDAGEM_INTERESSE:${n}`, { resolucao: rows[0].status, por: admin || 'admin' })
      .catch(() => {});
  }
  return { id: n, status: rows[0].status };
}

// O interesse em aberto da conta (o painel mostra "já recebemos").
async function abertoDaConta(contaId) {
  const { rows } = await pool.query(
    `SELECT id, status, criado_em FROM hospedagem_interesses
      WHERE conta_id = $1 AND status = ANY($2::text[]) ORDER BY criado_em DESC LIMIT 1`,
    [contaId, ABERTOS],
  );
  return rows[0] ? { id: Number(rows[0].id), status: rows[0].status, criadoEm: rows[0].criado_em } : null;
}

module.exports = { STATUS, validar, registrar, listar, atualizar, abertoDaConta };
