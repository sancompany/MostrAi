const pool = require('../db/pool');
const { colunasDoEndereco, parteQueFalta, problemaNoEndereco, linhaEndereco } = require('../lib/endereco');
const { possuiDireitoAtivoDeVeiculacao } = require('../anunciantes/acesso-painel');

// INTERESSE EM HOSPEDAR UM PONTO MÓVEL (migrations 113 e 114). Só
// manifestação: não reserva equipamento, não escolhe período, horário nem
// percentual, não tem termo. O Admin orquestra tudo: entra em contato,
// recusa, aprova para agendar e agenda (a hospedagem nasce em
// src/pontos/hospedagem.js#criar com `interesse_id`).
//
// V1.1 (05/10/2026, pedido do dono): só manda interesse quem JÁ TEM DIREITO
// ATIVO DE VEICULAÇÃO (`possuiDireitoAtivoDeVeiculacao`, a régua única) — e
// por isso só conta logada: empresa, responsável e contato vêm do cadastro
// (nunca do corpo). O local pretendido é o endereço da conta, um dos pontos
// dela ou outro endereço (só este pede o endereço no formulário).
//
// Andamento: nova (recebido) → em_contato → aprovada (aprovado para
// agendamento) → agendada; ou recusada. Um interesse em aberto por conta.

const LIMITES = { observacao: 500, local: 120, segmento: 80 };
const STATUS = ['nova', 'em_contato', 'aprovada', 'agendada', 'recusada'];
// Em aberto: ainda pode virar hospedagem.
const ABERTOS = ['nova', 'em_contato', 'aprovada'];
const LOCAIS = ['conta', 'ponto', 'outro'];

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });

function texto(valor, campo, rotulo, maximo, { obrigatorio = false, cortar = false } = {}) {
  const t = typeof valor === 'string' ? valor.trim().replace(/\s+/g, ' ') : '';
  if (!t) {
    if (obrigatorio) throw erro(400, `${rotulo}: preencha`, campo);
    return null;
  }
  if (t.length > maximo) {
    if (cortar) return t.slice(0, maximo);
    throw erro(400, `${rotulo}: no máximo ${maximo} caracteres`, campo);
  }
  return t;
}

const so = (v) => v ?? undefined;
const partesDe = (r) => ({
  cep: so(r.cep),
  logradouro: so(r.logradouro),
  numero: so(r.numero),
  complemento: so(r.complemento),
  bairro: so(r.bairro),
  cidade: so(r.cidade),
  uf: so(r.uf),
  // Registro antigo (só a linha): continua reconhecido.
  endereco: r.logradouro ? undefined : so(r.endereco),
});

// Os pontos FIXOS da conta que podem ser o local (o móvel nunca entra:
// não é de ninguém).
async function pontosDaConta(contaId, db = pool) {
  const { rows } = await db.query(
    `SELECT p.id, p.nome, p.cep, p.logradouro, p.numero, p.complemento, p.bairro, p.cidade, p.uf, p.endereco,
            p.categoria_id
       FROM pontos p
      WHERE p.anunciante_id = $1 AND p.tipo = 'fixo' AND p.status <> 'arquivado'
      ORDER BY p.id`,
    [contaId],
  );
  return rows;
}

// O local pretendido, decidido no servidor a partir da escolha:
//   conta — o endereço do cadastro da conta;
//   ponto — um ponto fixo DESTA conta (nunca de outra: IDOR);
//   outro — o endereço digitado (validado como todo endereço do sistema).
async function localPretendido(conta, corpo, db) {
  const tipo = corpo?.local_tipo ?? 'conta';
  if (!LOCAIS.includes(tipo))
    throw erro(400, 'Local: escolha o seu endereço, um dos seus pontos ou outro endereço', 'local_tipo');
  if (tipo === 'conta') {
    return { tipo, pontoId: null, partes: partesDe(conta), categoriaId: conta.categoria_id ?? null, nome: null };
  }
  if (tipo === 'ponto') {
    const id = Number(corpo?.ponto_id);
    const ponto = Number.isInteger(id) ? (await pontosDaConta(conta.id, db)).find((p) => p.id === id) : null;
    if (!ponto) throw erro(400, 'Escolha um dos seus pontos', 'ponto_id');
    return {
      tipo,
      pontoId: ponto.id,
      partes: partesDe(ponto),
      categoriaId: ponto.categoria_id ?? null,
      nome: ponto.nome,
    };
  }
  const problema = problemaNoEndereco(corpo || {});
  if (problema) throw erro(400, problema.erro, problema.campo);
  const falta = parteQueFalta(colunasDoEndereco(corpo || {}));
  if (falta) throw erro(400, `Endereço: preencha o campo ${falta}`, 'cep');
  const nome = texto(corpo?.local_nome, 'local_nome', 'Nome do local', LIMITES.local);
  return {
    tipo,
    pontoId: null,
    partes: Object.fromEntries(
      ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf'].map((k) => [k, corpo?.[k]]),
    ),
    categoriaId: conta.categoria_id ?? null,
    nome,
  };
}

// `conta`: a linha da conta da SESSÃO (nunca do corpo). Sem direito ativo de
// veiculação → 403 com o motivo. Um interesse em aberto por conta: repetir o
// envio (duplo clique, retry) devolve o mesmo, sem duplicar.
async function registrar(conta, corpo) {
  if (!conta || conta.excluido_em) throw erro(401, 'Entre na sua conta para enviar o interesse');
  const direito = await possuiDireitoAtivoDeVeiculacao(conta);
  if (!direito.possui) {
    throw Object.assign(
      erro(
        403,
        direito.motivo === 'suspensa'
          ? 'Sua conta está suspensa — fale com a Mostraí'
          : 'Para hospedar um Ponto Móvel, sua conta precisa ter um plano ativo, Plano Básico ou saldo de mídia',
      ),
      { motivo: direito.motivo },
    );
  }
  const observacao = texto(corpo?.observacao, 'observacao', 'Observação', LIMITES.observacao);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // Serializa por conta: dois envios simultâneos não criam dois.
    await cliente.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`hospedagem-interesse:conta:${conta.id}`]);
    const { rows: abertos } = await cliente.query(
      `SELECT id FROM hospedagem_interesses WHERE conta_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
      [conta.id, ABERTOS],
    );
    if (abertos[0]) {
      await cliente.query('COMMIT');
      return { id: Number(abertos[0].id), novo: false };
    }
    const local = await localPretendido(conta, corpo, cliente);
    const end = colunasDoEndereco(local.partes);
    const linha = linhaEndereco(end, { comCidade: true }) || '';
    const empresa = texto(conta.nome_empresa, 'empresa', 'Empresa', 120, { obrigatorio: true, cortar: true });
    const { rows } = await cliente.query(
      `INSERT INTO hospedagem_interesses
         (conta_id, origem, empresa, responsavel, contato_email, contato_telefone, logradouro, numero, complemento,
          bairro, cidade, uf, cep, endereco, categoria_id, categoria_livre, observacao, local_tipo, ponto_id,
          local_nome)
       VALUES ($1,'painel',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        conta.id,
        empresa,
        texto(conta.responsavel_nome, 'responsavel', 'Responsável', 120, { cortar: true }) || empresa,
        conta.contato_email ? String(conta.contato_email).slice(0, 160).toLowerCase() : null,
        (conta.contato_telefone || conta.responsavel_telefone || '').replace(/\D/g, '').slice(-11),
        end.logradouro ?? null,
        end.numero ?? null,
        end.complemento ?? null,
        end.bairro ?? null,
        end.cidade ?? '',
        end.uf ?? '',
        end.cep ?? null,
        linha,
        local.categoriaId,
        local.categoriaId
          ? null
          : texto(conta.categoria_livre, 'segmento', 'Segmento', LIMITES.segmento, { cortar: true }),
        observacao,
        local.tipo,
        local.pontoId,
        local.tipo === 'outro' ? local.nome : null,
      ],
    );
    await cliente.query('COMMIT');
    const id = Number(rows[0].id);
    await require('../pendencias/repository')
      .abrir({
        tipo: 'HOSPEDAGEM_INTERESSE',
        chave: `HOSPEDAGEM_INTERESSE:${id}`,
        anuncianteId: conta.id,
        titulo: `${empresa} quer hospedar um Ponto Móvel`,
        mensagem: `${linha || 'Endereço a confirmar'}. Entre em contato e, se fizer sentido, aprove e agende a hospedagem.`,
        ctaRotulo: 'Ver interesses',
        ctaDestino: '#rede/candidaturas/interesses',
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

// Admin: os interesses com a conta, o direito dela HOJE (o Admin decide com
// isso), o local, o ramo, o contato, a observação e o histórico da conta
// (interesses anteriores e hospedagens).
async function listar() {
  const { rows } = await pool.query(
    `SELECT i.*, cat.nome AS categoria_nome, p.nome AS ponto_nome,
            (SELECT COUNT(*)::int FROM hospedagem_interesses o WHERE o.conta_id = i.conta_id AND o.id <> i.id)
              AS interesses_anteriores,
            (SELECT COALESCE(json_agg(json_build_object('id', h.id, 'local', h.local, 'estado', h.estado,
                                                        'inicio', h.inicio, 'fim', h.fim) ORDER BY h.inicio DESC), '[]')
               FROM pontos_moveis_hospedagens h WHERE h.conta_id = i.conta_id) AS hospedagens
       FROM hospedagem_interesses i
       LEFT JOIN categorias cat ON cat.id = i.categoria_id
       LEFT JOIN pontos p ON p.id = i.ponto_id
      ORDER BY CASE i.status WHEN 'nova' THEN 0 WHEN 'em_contato' THEN 1 WHEN 'aprovada' THEN 2 ELSE 3 END,
               i.criado_em DESC
      LIMIT 200`,
  );
  const contaIds = [...new Set(rows.map((r) => r.conta_id).filter(Boolean))];
  const contas = new Map();
  if (contaIds.length) {
    const { rows: cs } = await pool.query('SELECT * FROM anunciantes WHERE id = ANY($1::int[])', [contaIds]);
    for (const c of cs) contas.set(c.id, { conta: c, direito: await possuiDireitoAtivoDeVeiculacao(c) });
  }
  return rows.map((r) => {
    const c = contas.get(r.conta_id);
    return {
      id: Number(r.id),
      conta: r.conta_id ? { id: r.conta_id, nome: c?.conta.nome_empresa ?? r.empresa } : null,
      direito: c ? c.direito : { possui: false, motivo: 'sem_conta' },
      origem: r.origem,
      empresa: r.empresa,
      responsavel: r.responsavel,
      email: r.contato_email,
      telefone: r.contato_telefone,
      localTipo: r.local_tipo,
      localNome: r.local_tipo === 'ponto' ? r.ponto_nome : r.local_tipo === 'outro' ? r.local_nome : null,
      ponto: r.ponto_id ? { id: r.ponto_id, nome: r.ponto_nome } : null,
      endereco: r.endereco,
      // As partes, para o compromisso abrir já preenchido (Rede Front V3).
      partes: {
        cep: r.cep || '',
        logradouro: r.logradouro || '',
        numero: r.numero || '',
        complemento: r.complemento || '',
        bairro: r.bairro || '',
        cidade: r.cidade || '',
        uf: r.uf || '',
      },
      segmento: r.categoria_nome || r.categoria_livre,
      categoriaId: r.categoria_id,
      observacao: r.observacao,
      status: r.status,
      notaInterna: r.nota_interna,
      criadoEm: r.criado_em,
      atualizadoEm: r.atualizado_em,
      atualizadoPor: r.atualizado_por_admin,
      historico: { interessesAnteriores: r.interesses_anteriores, hospedagens: r.hospedagens },
    };
  });
}

// O Admin muda o andamento (em contato, aprovado para agendamento, recusado)
// e a nota interna. "Agendada" nasce só da hospedagem confirmada — não por
// aqui. Interesse já agendado não muda mais.
async function atualizar(id, corpo, admin) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw erro(404, 'interesse não encontrado');
  const status = corpo?.status;
  if (status !== undefined && !['nova', 'em_contato', 'aprovada', 'recusada'].includes(status)) {
    throw erro(400, 'Andamento inválido: recebido, em contato, aprovado para agendamento ou recusado', 'status');
  }
  const nota = corpo?.nota_interna === undefined ? undefined : texto(corpo.nota_interna, 'nota_interna', 'Nota', 500);
  const { rows } = await pool.query(
    `UPDATE hospedagem_interesses
        SET status = COALESCE($2, status),
            nota_interna = CASE WHEN $3 THEN $4 ELSE nota_interna END,
            atualizado_em = now(), atualizado_por_admin = $5
      WHERE id = $1 AND status <> 'agendada'
      RETURNING id, status, conta_id`,
    [n, status ?? null, nota !== undefined, nota ?? null, admin || 'admin'],
  );
  if (!rows[0]) {
    const { rows: existe } = await pool.query('SELECT status FROM hospedagem_interesses WHERE id = $1', [n]);
    if (!existe[0]) throw erro(404, 'interesse não encontrado');
    throw erro(409, 'Esse interesse já virou hospedagem agendada');
  }
  if (rows[0].status === 'recusada') {
    await require('../pendencias/repository')
      .resolver(`HOSPEDAGEM_INTERESSE:${n}`, { resolucao: 'recusada', por: admin || 'admin' })
      .catch(() => {});
  }
  if (rows[0].conta_id) require('../lib/sse').emitirParaConta(rows[0].conta_id, 'hosting.updated', {});
  return { id: n, status: rows[0].status };
}

// O interesse mais recente da conta que ainda importa para ela: o aberto,
// ou o recusado/agendado mais novo (o painel mostra o andamento).
async function abertoDaConta(contaId) {
  const { rows } = await pool.query(
    `SELECT id, status, criado_em, atualizado_em FROM hospedagem_interesses
      WHERE conta_id = $1 AND status = ANY($2::text[]) ORDER BY criado_em DESC LIMIT 1`,
    [contaId, ABERTOS],
  );
  return rows[0]
    ? {
        id: Number(rows[0].id),
        status: rows[0].status,
        criadoEm: rows[0].criado_em,
        atualizadoEm: rows[0].atualizado_em,
      }
    : null;
}

module.exports = { STATUS, ABERTOS, LOCAIS, registrar, listar, atualizar, abertoDaConta, pontosDaConta };
