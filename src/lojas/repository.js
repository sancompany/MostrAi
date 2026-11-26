const pool = require('../db/pool');
const { hojeComercial, somarDias, diaTexto } = require('../lib/vigencia');

// Marketplace de Lojas — Etapa 3 (migration 123). Lojas, planos e assinaturas
// da loja (receita própria da Mostraí), catálogo da vitrine e contato.
//
// Nada daqui lê ou escreve `planos`, `assinaturas`, `pontos`, `dispositivos`
// ou qualquer tabela da playlist: a rede própria (Mostraí Core) não enxerga
// loja nenhuma, e a loja não enxerga a rede própria. A única linha da Core
// que muda é `anunciantes.papeis`, que ganha o rótulo 'loja' (nenhuma regra
// da Core decide nada por ele).
//
// Sem venda ao comprador: a vitrine capta contato. Pedido, cobrança e split
// de terceiro ficam para a V2 do San Checkout.

class ErroLoja extends Error {
  constructor(mensagem, status = 400) {
    super(mensagem);
    this.status = status;
  }
}

async function emTransacao(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const r = await fn(cliente);
    await cliente.query('COMMIT');
    return r;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

// ------------------------------------------------------------------ validação
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SLUG_ESPACO = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const TIPOS_ESPACO = ['tela_indoor', 'painel_led', 'totem', 'outdoor', 'empena', 'outro'];
const PERIODOS = ['dia', 'semana', 'mes'];

function texto(valor, campo, { min = 0, max = 200, obrigatorio = false } = {}) {
  if (valor === undefined || valor === null || String(valor).trim() === '') {
    if (obrigatorio) throw new ErroLoja(`${campo} é obrigatório`);
    return null;
  }
  const t = String(valor).trim();
  if (t.length < min || t.length > max) throw new ErroLoja(`${campo}: entre ${min} e ${max} caracteres`);
  return t;
}

const soDigitos = (v) => (v === undefined || v === null ? null : String(v).replace(/\D/g, '') || null);

function documento(v) {
  const d = soDigitos(v);
  if (d && d.length !== 11 && d.length !== 14) throw new ErroLoja('documento: CPF (11 dígitos) ou CNPJ (14)');
  return d;
}

function telefone(v) {
  const d = soDigitos(v);
  if (d && (d.length < 10 || d.length > 11)) throw new ErroLoja('telefone: DDD + número');
  return d;
}

function email(v, { obrigatorio = false } = {}) {
  const e = texto(v, 'e-mail', { min: 3, max: 200, obrigatorio });
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ErroLoja('e-mail inválido');
  return e ? e.toLowerCase() : null;
}

function uf(v, { obrigatorio = false } = {}) {
  const u = texto(v, 'UF', { min: 2, max: 2, obrigatorio });
  if (u && !/^[A-Za-z]{2}$/.test(u)) throw new ErroLoja('UF inválida');
  return u ? u.toUpperCase() : null;
}

function inteiro(v, campo, { min, max, padrao = null } = {}) {
  if (v === undefined || v === null || v === '') return padrao;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ErroLoja(`${campo}: inteiro entre ${min} e ${max}`);
  return n;
}

function decimal(v, campo, { min = 0, max = 1e8, padrao = null } = {}) {
  if (v === undefined || v === null || v === '') return padrao;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ErroLoja(`${campo}: número entre ${min} e ${max}`);
  return Math.round(n * 100) / 100;
}

function dia(v, campo) {
  if (!DIA.test(String(v ?? '')) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new ErroLoja(`${campo}: data no formato AAAA-MM-DD`);
  }
  return String(v);
}

function slug(v, padrao = SLUG, campo = 'endereço') {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  if (!padrao.test(s)) throw new ErroLoja(`${campo}: só letras minúsculas, números e hífen`);
  return s;
}

const unicoViolado = (err) => err?.code === '23505';

// ------------------------------------------------------------------ vigência
// Último dia do contrato: início + N meses − 1 dia (o último dia é inclusivo,
// no relógio de Matão — a régua de src/lib/vigencia.js).
function fimDoContrato(inicio, meses) {
  const d = new Date(`${inicio}T00:00:00Z`);
  const diaDoMes = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(meses));
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(diaDoMes, ultimo));
  return somarDias(d.toISOString().slice(0, 10), -1);
}

// Onde a loja está agora. É a MESMA regra de `visivelSql` (abaixo), em JS,
// para o Admin e a dona verem o porquê.
//   na_vitrine · rascunho · suspensa · encerrada · conta_indisponivel ·
//   sem_assinatura · aguardando_inicio · vencida · inadimplente
function situacao(loja, assinatura, conta, agora = new Date()) {
  const hoje = hojeComercial(agora);
  if (loja.status !== 'ativa') return loja.status;
  if (!conta || conta.suspenso || conta.excluido_em) return 'conta_indisponivel';
  if (assinatura?.status !== 'ativa') return 'sem_assinatura';
  if (diaTexto(assinatura.inicio) > hoje) return 'aguardando_inicio';
  if (diaTexto(assinatura.fim) < hoje) return 'vencida';
  const pagoAte = assinatura.pago_ate ? diaTexto(assinatura.pago_ate) : somarDias(assinatura.inicio, -1);
  if (somarDias(pagoAte, assinatura.dias_tolerancia) < hoje) return 'inadimplente';
  return 'na_vitrine';
}

// A loja aparece na vitrine: ativa, conta de pé, assinatura ativa, vigente
// hoje e em dia (último dia pago + tolerância). `p` é o parâmetro com o dia
// de hoje em Matão ('AAAA-MM-DD').
const visivelSql = (l, p) => `(${l}.status = 'ativa'
  AND EXISTS (SELECT 1 FROM anunciantes ca WHERE ca.id = ${l}.conta_id AND NOT ca.suspenso AND ca.excluido_em IS NULL)
  AND EXISTS (SELECT 1 FROM assinaturas_loja sa
               WHERE sa.loja_id = ${l}.id AND sa.status = 'ativa'
                 AND sa.inicio <= ${p}::date AND sa.fim >= ${p}::date
                 AND COALESCE(sa.pago_ate, sa.inicio - 1) + sa.dias_tolerancia >= ${p}::date))`;

async function registrarEvento(db, lojaId, acao, detalhe, autor) {
  await db.query(
    'INSERT INTO lojas_eventos (loja_id, acao, detalhe, autor, autor_access) VALUES ($1, $2, $3, $4, $5)',
    [lojaId, acao, detalhe || {}, String(autor?.operador || 'admin').slice(0, 200), autor?.operadorAccess || null],
  );
}

// ------------------------------------------------------------------ planos
const MODALIDADES = ['mensal', 'anual'];

function lerPlano(d, parcial = false) {
  const p = {};
  if (!parcial || d.nome !== undefined) p.nome = texto(d.nome, 'nome', { min: 2, max: 60, obrigatorio: true });
  if (!parcial || d.modalidade !== undefined) {
    if (!MODALIDADES.includes(d.modalidade)) throw new ErroLoja('modalidade: mensal ou anual');
    p.modalidade = d.modalidade;
  }
  if (!parcial || d.prazo_meses !== undefined) {
    p.prazo_meses = inteiro(d.prazo_meses, 'prazo em meses', { min: 1, max: 60 });
    if (p.prazo_meses === null) throw new ErroLoja('prazo em meses é obrigatório');
  }
  if (!parcial || d.valor_mensal !== undefined) {
    p.valor_mensal = decimal(d.valor_mensal, 'valor mensal', { min: 0, max: 1e6 });
    if (p.valor_mensal === null) throw new ErroLoja('valor mensal é obrigatório');
  }
  if (!parcial || d.taxa_percentual !== undefined) {
    p.taxa_percentual = decimal(d.taxa_percentual, 'taxa sobre vendas', { min: 0, max: 30, padrao: 0 });
  }
  if (!parcial || d.dias_tolerancia !== undefined) {
    p.dias_tolerancia = inteiro(d.dias_tolerancia, 'dias de tolerância', { min: 0, max: 30, padrao: 5 });
  }
  if (d.ativo !== undefined) p.ativo = Boolean(d.ativo);
  return p;
}

async function criarPlano(dados) {
  const id = slug(dados.id, /^[a-z0-9][a-z0-9-]{1,39}$/, 'id do plano');
  const p = lerPlano(dados);
  if (p.modalidade === 'anual' && p.prazo_meses < 12) throw new ErroLoja('plano anual: 12 meses ou mais');
  try {
    const { rows } = await pool.query(
      `INSERT INTO planos_loja (id, nome, modalidade, prazo_meses, valor_mensal, taxa_percentual, dias_tolerancia, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, true)) RETURNING *`,
      [id, p.nome, p.modalidade, p.prazo_meses, p.valor_mensal, p.taxa_percentual, p.dias_tolerancia, p.ativo ?? null],
    );
    return rows[0];
  } catch (err) {
    if (unicoViolado(err)) throw new ErroLoja('já existe um plano de loja com esse id', 409);
    throw err;
  }
}

// Mudar o plano não muda contrato assinado (a assinatura copiou os valores).
async function atualizarPlano(id, dados) {
  const p = lerPlano(dados, true);
  const campos = Object.keys(p);
  if (!campos.length) throw new ErroLoja('nada para alterar');
  const sets = campos.map((c, i) => `${c} = $${i + 2}`);
  const { rows } = await pool
    .query(`UPDATE planos_loja SET ${sets.join(', ')}, atualizado_em = now() WHERE id = $1 RETURNING *`, [
      id,
      ...campos.map((c) => p[c]),
    ])
    .catch((err) => {
      if (err.code === '23514') throw new ErroLoja('plano anual: 12 meses ou mais');
      throw err;
    });
  if (!rows[0]) throw new ErroLoja('plano de loja não encontrado', 404);
  return rows[0];
}

async function listarPlanos() {
  const { rows } = await pool.query('SELECT * FROM planos_loja ORDER BY ativo DESC, modalidade, prazo_meses, id');
  return rows;
}

// ------------------------------------------------------------------ lojas
function lerLoja(d, parcial = false) {
  const l = {};
  const campo = (nome, fn) => {
    if (!parcial || d[nome] !== undefined) l[nome] = fn(d[nome]);
  };
  campo('nome', (v) => texto(v, 'nome', { min: 2, max: 80, obrigatorio: true }));
  campo('razao_social', (v) => texto(v, 'razão social', { max: 120 }));
  campo('documento', documento);
  campo('email', (v) => email(v));
  campo('telefone', telefone);
  campo('cidade', (v) => texto(v, 'cidade', { max: 80 }));
  campo('uf', (v) => uf(v));
  campo('descricao', (v) => texto(v, 'descrição', { max: 2000 }) || '');
  campo('logo_url', (v) => texto(v, 'logo', { max: 500 }));
  campo('cor_primaria', (v) => {
    const c = texto(v, 'cor', { max: 7 });
    if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) throw new ErroLoja('cor: #RRGGBB');
    return c;
  });
  return l;
}

const COLUNAS_LOJA = [
  'nome',
  'razao_social',
  'documento',
  'email',
  'telefone',
  'cidade',
  'uf',
  'descricao',
  'logo_url',
  'cor_primaria',
];

async function criarLoja(dados, autor) {
  const contaId = inteiro(dados.conta_id, 'conta', { min: 1, max: 2147483647 });
  if (!contaId) throw new ErroLoja('conta é obrigatória');
  const s = slug(dados.slug);
  const l = lerLoja(dados);
  return emTransacao(async (db) => {
    const { rows: conta } = await db.query('SELECT id, excluido_em FROM anunciantes WHERE id = $1 FOR UPDATE', [
      contaId,
    ]);
    if (!conta[0] || conta[0].excluido_em) throw new ErroLoja('conta não encontrada', 404);
    let loja;
    try {
      const { rows } = await db.query(
        `INSERT INTO lojas (conta_id, slug, ${COLUNAS_LOJA.join(', ')})
         VALUES ($1, $2, ${COLUNAS_LOJA.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING *`,
        [contaId, s, ...COLUNAS_LOJA.map((c) => l[c])],
      );
      loja = rows[0];
    } catch (err) {
      if (unicoViolado(err)) {
        throw new ErroLoja(
          String(err.constraint).includes('slug') ? 'esse endereço já é de outra loja' : 'essa conta já tem loja',
          409,
        );
      }
      throw err;
    }
    // O rótulo do papel na conta — o mesmo caminho do papel 'ponto'.
    await require('../conta/modos').adicionarPapel(contaId, 'loja', db);
    await registrarEvento(db, loja.id, 'loja_criada', { slug: s }, autor);
    return loja;
  });
}

async function atualizarLoja(id, dados, autor, { soVitrine = false } = {}) {
  const l = lerLoja(dados, true);
  // A dona só mexe no que aparece na vitrine; nome, documento e endereço são
  // do cadastro que o Admin conferiu.
  if (soVitrine) {
    for (const c of ['nome', 'razao_social', 'documento']) delete l[c];
  }
  const campos = Object.keys(l);
  if (!campos.length) throw new ErroLoja('nada para alterar');
  return emTransacao(async (db) => {
    const { rows } = await db.query(
      `UPDATE lojas SET ${campos.map((c, i) => `${c} = $${i + 2}`).join(', ')}, atualizado_em = now()
        WHERE id = $1 RETURNING *`,
      [id, ...campos.map((c) => l[c])],
    );
    if (!rows[0]) throw new ErroLoja('loja não encontrada', 404);
    await registrarEvento(db, id, soVitrine ? 'vitrine_editada' : 'cadastro_editado', { campos }, autor);
    return rows[0];
  });
}

const TRANSICOES = {
  rascunho: ['ativa', 'encerrada'],
  ativa: ['suspensa', 'encerrada'],
  suspensa: ['ativa', 'encerrada'],
  encerrada: [],
};

async function mudarStatus(id, status, motivo, autor) {
  if (!TRANSICOES[status]) throw new ErroLoja('status inválido');
  const m = texto(motivo, 'motivo', { max: 300 });
  if (['suspensa', 'encerrada'].includes(status) && !m) throw new ErroLoja('informe o motivo');
  return emTransacao(async (db) => {
    const { rows: atual } = await db.query('SELECT status FROM lojas WHERE id = $1 FOR UPDATE', [id]);
    if (!atual[0]) throw new ErroLoja('loja não encontrada', 404);
    if (!TRANSICOES[atual[0].status].includes(status)) {
      throw new ErroLoja(`não dá para passar de ${atual[0].status} para ${status}`, 409);
    }
    const { rows } = await db.query(
      'UPDATE lojas SET status = $2, motivo_status = $3, atualizado_em = now() WHERE id = $1 RETURNING *',
      [id, status, m],
    );
    await registrarEvento(db, id, 'status', { de: atual[0].status, para: status, motivo: m }, autor);
    return rows[0];
  });
}

async function assinaturaAtiva(lojaId, db = pool) {
  const { rows } = await db.query(
    "SELECT * FROM assinaturas_loja WHERE loja_id = $1 AND status = 'ativa' ORDER BY id DESC LIMIT 1",
    [lojaId],
  );
  return rows[0] || null;
}

async function contaDaLoja(loja, db = pool) {
  const { rows } = await db.query('SELECT id, suspenso, excluido_em FROM anunciantes WHERE id = $1', [loja.conta_id]);
  return rows[0] || null;
}

// A ficha da loja com a situação calculada (Admin e dona).
async function ficha(lojaId, agora = new Date()) {
  const { rows } = await pool.query('SELECT * FROM lojas WHERE id = $1', [lojaId]);
  const loja = rows[0];
  if (!loja) return null;
  const [assinatura, conta, espacos, contatos] = await Promise.all([
    assinaturaAtiva(loja.id),
    contaDaLoja(loja),
    pool.query('SELECT * FROM lojas_espacos WHERE loja_id = $1 ORDER BY ordem, id', [loja.id]),
    pool.query(
      'SELECT count(*)::int AS total, count(*) FILTER (WHERE lido_em IS NULL)::int AS novos FROM lojas_contatos WHERE loja_id = $1',
      [loja.id],
    ),
  ]);
  return {
    ...loja,
    situacao: situacao(loja, assinatura, conta, agora),
    assinatura,
    espacos: espacos.rows,
    contatos: contatos.rows[0],
  };
}

async function lojaDaConta(contaId) {
  const { rows } = await pool.query('SELECT id FROM lojas WHERE conta_id = $1', [contaId]);
  return rows[0]?.id ?? null;
}

async function listarLojas(agora = new Date()) {
  const { rows } = await pool.query(
    `SELECT l.*, a.nome_empresa AS conta_nome, a.suspenso AS conta_suspensa, a.excluido_em AS conta_excluida_em
       FROM lojas l JOIN anunciantes a ON a.id = l.conta_id ORDER BY l.nome, l.id`,
  );
  const assinaturas = await pool.query("SELECT * FROM assinaturas_loja WHERE status = 'ativa'");
  const porLoja = new Map(assinaturas.rows.map((s) => [s.loja_id, s]));
  return rows.map((l) => ({
    ...l,
    assinatura: porLoja.get(l.id) || null,
    situacao: situacao(l, porLoja.get(l.id), { suspenso: l.conta_suspensa, excluido_em: l.conta_excluida_em }, agora),
  }));
}

// ------------------------------------------------------------------ assinatura
// Nova assinatura: uma ativa por loja. A que já existe só sai do lugar se já
// venceu (renovação) — antes disso, o Admin cancela primeiro, com motivo.
async function criarAssinatura(lojaId, { plano_loja_id: planoId, inicio }, autor, agora = new Date()) {
  const ini = dia(inicio ?? hojeComercial(agora), 'início');
  return emTransacao(async (db) => {
    const { rows: loja } = await db.query('SELECT id, status FROM lojas WHERE id = $1 FOR UPDATE', [lojaId]);
    if (!loja[0]) throw new ErroLoja('loja não encontrada', 404);
    if (loja[0].status === 'encerrada') throw new ErroLoja('loja encerrada não recebe assinatura', 409);
    const { rows: plano } = await db.query('SELECT * FROM planos_loja WHERE id = $1', [planoId]);
    if (!plano[0]) throw new ErroLoja('plano de loja não encontrado', 404);
    if (!plano[0].ativo) throw new ErroLoja('plano de loja inativo', 409);
    const atual = await assinaturaAtiva(lojaId, db);
    if (atual) {
      if (diaTexto(atual.fim) >= hojeComercial(agora)) {
        throw new ErroLoja('a loja já tem assinatura em curso — cancele antes ou espere vencer', 409);
      }
      await db.query("UPDATE assinaturas_loja SET status = 'encerrada' WHERE id = $1", [atual.id]);
    }
    const p = plano[0];
    const { rows } = await db.query(
      `INSERT INTO assinaturas_loja (loja_id, plano_loja_id, modalidade, prazo_meses, valor_mensal, taxa_percentual,
                                     dias_tolerancia, inicio, fim, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        lojaId,
        p.id,
        p.modalidade,
        p.prazo_meses,
        p.valor_mensal,
        p.taxa_percentual,
        p.dias_tolerancia,
        ini,
        fimDoContrato(ini, p.prazo_meses),
        String(autor?.operador || 'admin').slice(0, 200),
      ],
    );
    await registrarEvento(
      db,
      lojaId,
      'assinatura_criada',
      { assinatura_id: rows[0].id, plano: p.id, inicio: ini, fim: rows[0].fim, substituiu: atual?.id ?? null },
      autor,
    );
    return rows[0];
  });
}

// Pagamento registrado pelo Admin: estende `pago_ate` (nunca para trás e
// nunca além do fim do contrato).
async function registrarPagamento(assinaturaId, dados, autor) {
  const pagoAte = dia(dados.pago_ate, 'pago até');
  const valor = decimal(dados.valor, 'valor', { min: 0.01, max: 1e7 });
  if (valor === null) throw new ErroLoja('valor é obrigatório');
  const meio = texto(dados.meio, 'meio', { min: 1, max: 40, obrigatorio: true });
  const referencia = texto(dados.referencia, 'referência', { max: 120 });
  return emTransacao(async (db) => {
    const { rows } = await db.query('SELECT * FROM assinaturas_loja WHERE id = $1 FOR UPDATE', [assinaturaId]);
    const a = rows[0];
    if (!a) throw new ErroLoja('assinatura não encontrada', 404);
    if (a.status !== 'ativa') throw new ErroLoja('assinatura não está ativa', 409);
    if (pagoAte < diaTexto(a.inicio) || pagoAte > diaTexto(a.fim)) {
      throw new ErroLoja('"pago até" precisa estar dentro do contrato', 400);
    }
    if (a.pago_ate && pagoAte <= diaTexto(a.pago_ate)) throw new ErroLoja('esse período já está pago', 409);
    const { rows: pag } = await db.query(
      `INSERT INTO assinaturas_loja_pagamentos (assinatura_id, pago_ate, valor, meio, referencia, registrado_por, registrado_por_access)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        a.id,
        pagoAte,
        valor,
        meio,
        referencia,
        String(autor?.operador || 'admin').slice(0, 200),
        autor?.operadorAccess || null,
      ],
    );
    const { rows: nova } = await db.query('UPDATE assinaturas_loja SET pago_ate = $2 WHERE id = $1 RETURNING *', [
      a.id,
      pagoAte,
    ]);
    await registrarEvento(db, a.loja_id, 'pagamento', { assinatura_id: a.id, pago_ate: pagoAte, valor, meio }, autor);
    return { assinatura: nova[0], pagamento: pag[0] };
  });
}

async function cancelarAssinatura(assinaturaId, motivo, autor) {
  const m = texto(motivo, 'motivo', { min: 1, max: 300, obrigatorio: true });
  return emTransacao(async (db) => {
    const { rows } = await db.query(
      `UPDATE assinaturas_loja SET status = 'cancelada', cancelada_em = now(), motivo_cancelamento = $2
        WHERE id = $1 AND status = 'ativa' RETURNING *`,
      [assinaturaId, m],
    );
    if (!rows[0]) throw new ErroLoja('assinatura ativa não encontrada', 404);
    await registrarEvento(db, rows[0].loja_id, 'assinatura_cancelada', { assinatura_id: rows[0].id, motivo: m }, autor);
    return rows[0];
  });
}

// ------------------------------------------------------------------ espaços
function lerEspaco(d, parcial = false) {
  const e = {};
  const campo = (nome, fn) => {
    if (!parcial || d[nome] !== undefined) e[nome] = fn(d[nome]);
  };
  campo('nome', (v) => texto(v, 'nome', { min: 2, max: 80, obrigatorio: true }));
  campo('tipo', (v) => {
    if (!TIPOS_ESPACO.includes(v)) throw new ErroLoja(`tipo: ${TIPOS_ESPACO.join(', ')}`);
    return v;
  });
  campo('descricao', (v) => texto(v, 'descrição', { max: 2000 }) || '');
  campo('endereco', (v) => texto(v, 'endereço', { max: 200 }));
  campo('bairro', (v) => texto(v, 'bairro', { max: 80 }));
  campo('cidade', (v) => texto(v, 'cidade', { min: 2, max: 80, obrigatorio: true }));
  campo('uf', (v) => uf(v, { obrigatorio: true }));
  campo('latitude', (v) => decimal(v, 'latitude', { min: -90, max: 90 }));
  campo('longitude', (v) => decimal(v, 'longitude', { min: -180, max: 180 }));
  campo('medidas', (v) => texto(v, 'medidas', { max: 80 }));
  campo('fluxo_estimado_mensal', (v) => inteiro(v, 'fluxo estimado', { min: 0, max: 100000000 }));
  campo('preco', (v) => decimal(v, 'preço', { min: 0, max: 1e7 }));
  campo('periodo_preco', (v) => {
    if (v === undefined || v === null || v === '') return null;
    if (!PERIODOS.includes(v)) throw new ErroLoja('período do preço: dia, semana ou mes');
    return v;
  });
  campo('foto_url', (v) => texto(v, 'foto', { max: 500 }));
  campo('ordem', (v) => inteiro(v, 'ordem', { min: 0, max: 10000, padrao: 0 }));
  if (d.latitude !== undefined || d.longitude !== undefined) {
    if (((e.latitude ?? null) === null) !== ((e.longitude ?? null) === null)) {
      throw new ErroLoja('informe latitude e longitude juntas');
    }
  }
  if (d.preco !== undefined || d.periodo_preco !== undefined) {
    if (((e.preco ?? null) === null) !== ((e.periodo_preco ?? null) === null)) {
      throw new ErroLoja('preço e período vão juntos (ou os dois vazios, "sob consulta")');
    }
  }
  return e;
}

const STATUS_ESPACO = ['rascunho', 'publicado', 'pausado', 'arquivado'];

async function criarEspaco(lojaId, dados, autor) {
  const s = slug(dados.slug, SLUG_ESPACO, 'endereço do espaço');
  const e = lerEspaco(dados);
  const status = dados.status === 'publicado' ? 'publicado' : 'rascunho';
  const colunas = Object.keys(e);
  try {
    const { rows } = await pool.query(
      `INSERT INTO lojas_espacos (loja_id, slug, status, ${colunas.join(', ')})
       VALUES ($1, $2, $3, ${colunas.map((_, i) => `$${i + 4}`).join(', ')}) RETURNING *`,
      [lojaId, s, status, ...colunas.map((c) => e[c])],
    );
    await registrarEvento(pool, lojaId, 'espaco_criado', { espaco_id: rows[0].id, slug: s }, autor);
    return rows[0];
  } catch (err) {
    if (unicoViolado(err)) throw new ErroLoja('a loja já tem um espaço com esse endereço', 409);
    if (err.code === '23514') throw new ErroLoja('dados do espaço inválidos');
    throw err;
  }
}

async function atualizarEspaco(lojaId, espacoId, dados, autor) {
  const e = lerEspaco(dados, true);
  if (dados.status !== undefined) {
    if (!STATUS_ESPACO.includes(dados.status)) throw new ErroLoja(`status: ${STATUS_ESPACO.join(', ')}`);
    e.status = dados.status;
  }
  const campos = Object.keys(e);
  if (!campos.length) throw new ErroLoja('nada para alterar');
  const { rows } = await pool
    .query(
      `UPDATE lojas_espacos SET ${campos.map((c, i) => `${c} = $${i + 3}`).join(', ')}, atualizado_em = now()
        WHERE id = $1 AND loja_id = $2 RETURNING *`,
      [espacoId, lojaId, ...campos.map((c) => e[c])],
    )
    .catch((err) => {
      if (err.code === '23514') throw new ErroLoja('dados do espaço inválidos (preço com período, coordenadas juntas)');
      throw err;
    });
  if (!rows[0]) throw new ErroLoja('espaço não encontrado', 404);
  await registrarEvento(pool, lojaId, 'espaco_editado', { espaco_id: espacoId, campos }, autor);
  return rows[0];
}

// ------------------------------------------------------------------ vitrine
// O que a vitrine mostra de uma loja e de um espaço: nada de documento,
// razão social, conta, assinatura ou valores do contrato.
const LOJA_PUBLICA = `l.slug, l.nome, l.cidade, l.uf, l.descricao, l.logo_url, l.cor_primaria, l.telefone, l.email`;
const ESPACO_PUBLICO = `e.slug, e.nome, e.tipo, e.descricao, e.endereco, e.bairro, e.cidade, e.uf, e.latitude, e.longitude,
  e.medidas, e.fluxo_estimado_mensal, e.preco, e.periodo_preco, e.foto_url`;

const publicoDoEspaco = (r) => ({
  ...r,
  latitude: r.latitude === null ? null : Number(r.latitude),
  longitude: r.longitude === null ? null : Number(r.longitude),
  preco: r.preco === null ? null : Number(r.preco),
});

async function vitrine({ cidade = null, tipo = null } = {}, agora = new Date()) {
  const hoje = hojeComercial(agora);
  const c = texto(cidade, 'cidade', { max: 80 });
  if (tipo && !TIPOS_ESPACO.includes(tipo)) throw new ErroLoja('tipo inválido');
  const { rows } = await pool.query(
    `SELECT ${ESPACO_PUBLICO}, l.slug AS loja_slug, l.nome AS loja_nome
       FROM lojas_espacos e JOIN lojas l ON l.id = e.loja_id
      WHERE e.status = 'publicado' AND ${visivelSql('l', '$1')}
        AND ($2::text IS NULL OR lower(e.cidade) = lower($2))
        AND ($3::text IS NULL OR e.tipo = $3)
      ORDER BY e.cidade, l.nome, e.ordem, e.id
      LIMIT 500`,
    [hoje, c, tipo || null],
  );
  return rows.map(publicoDoEspaco);
}

async function lojaPublica(slugLoja, agora = new Date()) {
  const { rows } = await pool.query(
    `SELECT l.id, ${LOJA_PUBLICA} FROM lojas l WHERE l.slug = $1 AND ${visivelSql('l', '$2')}`,
    [String(slugLoja ?? '').toLowerCase(), hojeComercial(agora)],
  );
  const loja = rows[0];
  if (!loja) return null;
  const { rows: espacos } = await pool.query(
    `SELECT ${ESPACO_PUBLICO} FROM lojas_espacos e WHERE e.loja_id = $1 AND e.status = 'publicado' ORDER BY e.ordem, e.id`,
    [loja.id],
  );
  const { id: _id, ...publica } = loja;
  return { ...publica, espacos: espacos.map(publicoDoEspaco) };
}

// Contato pela vitrine: só para loja visível e espaço publicado dela.
async function registrarContato(slugLoja, dados, agora = new Date()) {
  const { rows } = await pool.query(`SELECT l.id FROM lojas l WHERE l.slug = $1 AND ${visivelSql('l', '$2')}`, [
    String(slugLoja ?? '').toLowerCase(),
    hojeComercial(agora),
  ]);
  if (!rows[0]) throw new ErroLoja('loja não encontrada', 404);
  const lojaId = rows[0].id;
  let espacoId = null;
  if (dados.espaco) {
    const { rows: e } = await pool.query(
      "SELECT id FROM lojas_espacos WHERE loja_id = $1 AND slug = $2 AND status = 'publicado'",
      [lojaId, String(dados.espaco).toLowerCase()],
    );
    if (!e[0]) throw new ErroLoja('espaço não encontrado', 404);
    espacoId = e[0].id;
  }
  const { rows: c } = await pool.query(
    `INSERT INTO lojas_contatos (loja_id, espaco_id, nome, email, telefone, mensagem, periodo_desejado)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, criado_em`,
    [
      lojaId,
      espacoId,
      texto(dados.nome, 'nome', { min: 2, max: 120, obrigatorio: true }),
      email(dados.email, { obrigatorio: true }),
      telefone(dados.telefone),
      texto(dados.mensagem, 'mensagem', { min: 1, max: 2000, obrigatorio: true }),
      texto(dados.periodo_desejado, 'período desejado', { max: 120 }),
    ],
  );
  return c[0];
}

async function contatosDaLoja(lojaId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.nome, c.email, c.telefone, c.mensagem, c.periodo_desejado, c.lido_em, c.criado_em,
            e.slug AS espaco_slug, e.nome AS espaco_nome
       FROM lojas_contatos c LEFT JOIN lojas_espacos e ON e.id = c.espaco_id
      WHERE c.loja_id = $1 ORDER BY c.criado_em DESC, c.id DESC`,
    [lojaId],
  );
  return rows;
}

async function marcarContatoLido(lojaId, contatoId) {
  const { rows } = await pool.query(
    'UPDATE lojas_contatos SET lido_em = COALESCE(lido_em, now()) WHERE id = $1 AND loja_id = $2 RETURNING id, lido_em',
    [contatoId, lojaId],
  );
  if (!rows[0]) throw new ErroLoja('contato não encontrado', 404);
  return rows[0];
}

module.exports = {
  ErroLoja,
  TIPOS_ESPACO,
  fimDoContrato,
  situacao,
  visivelSql,
  criarPlano,
  atualizarPlano,
  listarPlanos,
  criarLoja,
  atualizarLoja,
  mudarStatus,
  ficha,
  lojaDaConta,
  listarLojas,
  criarAssinatura,
  registrarPagamento,
  cancelarAssinatura,
  criarEspaco,
  atualizarEspaco,
  vitrine,
  lojaPublica,
  registrarContato,
  contatosDaLoja,
  marcarContatoLido,
};
