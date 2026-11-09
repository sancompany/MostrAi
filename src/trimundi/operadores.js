const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { auditar, medir } = require('./lib/registro');
const { hmac } = require('./lib/chaves');
const { ALFABETO } = require('./lib/codigos');
const { gerarHash, conferirHash, conferirSenha } = require('../lib/senha');
const config = require('./config');
const crypto = require('node:crypto');

// Operadores de check-in (T5, T6; RN-T24 a RN-T28). Só a permissão de
// check-in existe. A conta da Mostraí vence: e-mail que já é conta lá não
// vira operador (D-05). Revogação imediata: desativar ou gerar código novo
// sobe a `sessao_versao`, e a sessão antiga cai na requisição seguinte.

const VALIDADE_CODIGO_H = 72;
const MAX_TENTATIVAS_CODIGO = 5;

function gerarCodigo() {
  const b = crypto.randomBytes(8);
  let s = '';
  for (const x of b) s += ALFABETO[x % 32];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const normalizarCodigo = (c) =>
  String(c ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
const hashDoCodigo = (codigo) => hmac('ativacao-operador', normalizarCodigo(codigo));

async function contaDaMostrai(email) {
  const repo = require('../anunciantes/repository');
  return Boolean(await repo.buscarPorEmailComSenha(email));
}

async function conferirEdicoes(cliente, edicoes) {
  if (edicoes === 'todas' || edicoes === undefined || edicoes === null) return null;
  if (!Array.isArray(edicoes) || !edicoes.length) throw erro(400, 'Escolha as edições do operador.');
  const ids = [...new Set(edicoes.map((x) => v.id(x, 'edição')))];
  const { rows } = await cliente.query('SELECT id FROM edicoes WHERE id = ANY($1::bigint[])', [ids]);
  if (rows.length !== ids.length) throw erro(400, 'edição não encontrada');
  return ids;
}

async function gravarPermissoes(cliente, operadorId, ids, autor) {
  await cliente.query('DELETE FROM operador_permissoes WHERE operador_id = $1', [operadorId]);
  for (const edicaoId of ids === null ? [null] : ids) {
    await cliente.query(
      "INSERT INTO operador_permissoes (operador_id, permissao, edicao_id, concedida_por) VALUES ($1, 'checkin', $2, $3)",
      [operadorId, edicaoId, autor?.autor || 'admin'],
    );
  }
}

async function criar(dados, autor) {
  const nome = v.texto(dados?.nome, {
    campo: 'o nome',
    obrigatorio: true,
    min: 2,
    max: 120,
    mensagem: 'Informe o nome do operador.',
  });
  const email = v.email(dados?.email);
  if (await contaDaMostrai(email)) {
    throw erro(409, 'Este e-mail já é de uma conta da Mostraí — use outro para o operador.');
  }
  const codigo = gerarCodigo();
  return emTransacao(async (cliente) => {
    const ids = await conferirEdicoes(cliente, dados?.edicoes);
    const { rows: ja } = await cliente.query('SELECT 1 FROM operadores WHERE email_normalizado = $1', [email]);
    if (ja.length) throw erro(409, 'Já existe um operador com este e-mail.');
    const { rows } = await cliente.query(
      `INSERT INTO operadores (nome, email, email_normalizado, codigo_hash, codigo_expira_em)
       VALUES ($1, $2, $2, $3, now() + make_interval(hours => $4)) RETURNING id`,
      [nome, email, hashDoCodigo(codigo), VALIDADE_CODIGO_H],
    );
    await gravarPermissoes(cliente, rows[0].id, ids, autor);
    await auditar(cliente, autor, 'operador_criado', 'operador', rows[0].id, { edicoes: ids ?? 'todas' });
    return { operador: await obter(rows[0].id, cliente), codigo, endereco: `${config.urlDoSite()}/ticket/ativar` };
  });
}

async function obter(id, cliente = null) {
  const q = cliente ? (s, p) => cliente.query(s, p) : consultar;
  const { rows } = await q(
    `SELECT o.id, o.nome, o.email, o.status, o.ativado_em, o.desativado_em, o.ultimo_acesso_em, o.codigo_expira_em,
            COALESCE(json_agg(json_build_object('edicao_id', op.edicao_id, 'nome', CASE WHEN ed.id IS NULL THEN NULL ELSE ev.nome || ' — ' || ed.nome END))
                     FILTER (WHERE op.id IS NOT NULL), '[]') AS permissoes
       FROM operadores o
       LEFT JOIN operador_permissoes op ON op.operador_id = o.id
       LEFT JOIN edicoes ed ON ed.id = op.edicao_id LEFT JOIN eventos ev ON ev.id = ed.evento_id
      WHERE o.id = $1 GROUP BY o.id`,
    [id],
  );
  const o = rows[0];
  if (!o) throw erro(404, 'operador não encontrado');
  return formatar(o);
}

function formatar(o) {
  const todas = o.permissoes.some((p) => p.edicao_id === null);
  return {
    id: o.id,
    nome: o.nome,
    email: o.email,
    status: o.status,
    ativado_em: o.ativado_em,
    ultimo_acesso_em: o.ultimo_acesso_em,
    codigo_expira_em: o.status === 'aguardando_ativacao' ? o.codigo_expira_em : null,
    edicoes: todas ? 'todas' : o.permissoes.map((p) => ({ id: p.edicao_id, nome: p.nome })),
  };
}

async function listar() {
  const { rows } = await consultar('SELECT id FROM operadores WHERE anonimizado_em IS NULL ORDER BY criado_em DESC');
  const lista = [];
  for (const r of rows) {
    const o = await obter(r.id);
    // Conta da Mostraí criada depois com o mesmo e-mail: a conta vence no login.
    o.bloqueado_pela_mostrai = o.status === 'ativo' && (await contaDaMostrai(o.email).catch(() => false));
    lista.push(o);
  }
  return lista;
}

async function atualizar(id, dados, autor) {
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT id FROM operadores WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw erro(404, 'operador não encontrado');
    const campos = [];
    if (Object.hasOwn(dados || {}, 'nome')) {
      const nome = v.texto(dados.nome, { campo: 'o nome', obrigatorio: true, min: 2, max: 120 });
      await cliente.query('UPDATE operadores SET nome = $2 WHERE id = $1', [id, nome]);
      campos.push('nome');
    }
    if (Object.hasOwn(dados || {}, 'edicoes')) {
      await gravarPermissoes(cliente, id, await conferirEdicoes(cliente, dados.edicoes), autor);
      campos.push('edicoes');
    }
    await auditar(cliente, autor, 'operador_alterado', 'operador', id, { campos });
    return obter(id, cliente);
  });
}

async function novoCodigo(id, autor) {
  const codigo = gerarCodigo();
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      `UPDATE operadores SET codigo_hash = $2, codigo_expira_em = now() + make_interval(hours => $3), codigo_tentativas = 0,
         senha_hash = NULL, status = CASE WHEN status = 'desativado' THEN 'desativado' ELSE 'aguardando_ativacao' END,
         sessao_versao = sessao_versao + 1
       WHERE id = $1 RETURNING id`,
      [id, hashDoCodigo(codigo), VALIDADE_CODIGO_H],
    );
    if (!rows[0]) throw erro(404, 'operador não encontrado');
    await auditar(cliente, autor, 'operador_codigo', 'operador', id, {});
    return { operador: await obter(id, cliente), codigo, endereco: `${config.urlDoSite()}/ticket/ativar` };
  });
}

async function desativar(id, autor) {
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      `UPDATE operadores SET status = 'desativado', desativado_em = now(), sessao_versao = sessao_versao + 1
        WHERE id = $1 AND status <> 'desativado' RETURNING id`,
      [id],
    );
    if (!rows[0]) throw erro(409, 'Esse operador já está desativado.');
    await auditar(cliente, autor, 'operador_desativado', 'operador', id, {});
    return obter(id, cliente);
  });
}

async function reativar(id, autor) {
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      `UPDATE operadores SET status = CASE WHEN senha_hash IS NULL THEN 'aguardando_ativacao' ELSE 'ativo' END,
         desativado_em = NULL WHERE id = $1 AND status = 'desativado' RETURNING id`,
      [id],
    );
    if (!rows[0]) throw erro(409, 'Esse operador não está desativado.');
    await auditar(cliente, autor, 'operador_reativado', 'operador', id, {});
    return obter(id, cliente);
  });
}

// T6: e-mail + código + senha nova. Mesma resposta para e-mail desconhecido
// e código errado (não revela quem é operador).
async function ativar(dados) {
  const email = v.email(dados?.email);
  const codigo = normalizarCodigo(dados?.codigo);
  const senha = String(dados?.senha ?? '');
  const regra = conferirSenha(senha);
  if (regra) throw erro(400, regra);
  const invalido = () => erro(400, 'E-mail ou código inválido.');
  const hash = await gerarHash(senha);
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM operadores WHERE email_normalizado = $1 FOR UPDATE', [email]);
    const o = rows[0];
    if (o?.status !== 'aguardando_ativacao' || !o.codigo_hash) throw invalido();
    if (o.codigo_tentativas >= MAX_TENTATIVAS_CODIGO) throw invalido();
    if (new Date(o.codigo_expira_em) <= new Date()) {
      throw erro(410, 'Este código venceu — peça um novo a quem organiza o evento.');
    }
    const a = Buffer.from(hashDoCodigo(codigo));
    const b = Buffer.from(o.codigo_hash);
    if (codigo.length !== 8 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await cliente.query('UPDATE operadores SET codigo_tentativas = codigo_tentativas + 1 WHERE id = $1', [o.id]);
      // O erro precisa sair DEPOIS de gravar a tentativa: devolve em vez de lançar.
      return { erro: true };
    }
    await cliente.query(
      `UPDATE operadores SET senha_hash = $2, status = 'ativo', ativado_em = now(), codigo_hash = NULL,
         codigo_expira_em = NULL, codigo_tentativas = 0, sessao_versao = sessao_versao + 1 WHERE id = $1`,
      [o.id, hash],
    );
    await medir(cliente, 'acesso:operador_ativa', null, { operador_id: o.id });
    return { ok: true };
  }).then((r) => {
    if (r.erro) throw invalido();
    return r;
  });
}

// Login pela tela da Mostraí (RN-T27): null = não é operador (ou senha
// errada) e a Mostraí responde como sempre respondeu.
async function autenticar(email, senha) {
  const e = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!e || e.length > 200) return null;
  const { rows } = await consultar(
    "SELECT id, senha_hash, status, sessao_versao FROM operadores WHERE email_normalizado = $1 AND status IN ('ativo', 'desativado')",
    [e],
  );
  const o = rows[0];
  if (!o?.senha_hash) return null;
  const { ok } = await conferirHash(String(senha ?? ''), o.senha_hash);
  if (!ok) return null;
  if (o.status === 'desativado') return { desativado: true };
  await consultar('UPDATE operadores SET ultimo_acesso_em = now() WHERE id = $1', [o.id]);
  return { id: o.id, versao: o.sessao_versao };
}

// Operador da sessão, conferido no banco a cada requisição: desativado ou
// com versão antiga perde a sessão na hora.
async function daSessao(req) {
  const id = req.session?.trimundiOperadorId;
  if (!id || !config.configurada()) return null;
  const { rows } = await consultar(
    'SELECT id, nome, status, sessao_versao, ultimo_acesso_em FROM operadores WHERE id = $1',
    [id],
  );
  const o = rows[0];
  if (o?.status !== 'ativo' || o.sessao_versao !== req.session.trimundiOperadorVersao) {
    delete req.session.trimundiOperadorId;
    delete req.session.trimundiOperadorVersao;
    return null;
  }
  if (!o.ultimo_acesso_em || Date.now() - new Date(o.ultimo_acesso_em).getTime() > 5 * 60000) {
    await consultar('UPDATE operadores SET ultimo_acesso_em = now() WHERE id = $1', [o.id]);
  }
  return o;
}

// Edições em que o operador pode fazer check-in agora (publicadas ou pausadas).
async function edicoesPermitidas(operadorId) {
  const { rows } = await consultar(
    `SELECT DISTINCT ed.id, ed.nome, ev.nome AS evento, ed.inicio_em, ed.codigo_publico
       FROM operador_permissoes op
       JOIN edicoes ed ON (op.edicao_id IS NULL OR ed.id = op.edicao_id)
       JOIN eventos ev ON ev.id = ed.evento_id
      WHERE op.operador_id = $1 AND op.permissao = 'checkin' AND ed.status IN ('publicado', 'pausado')
      ORDER BY ed.inicio_em NULLS LAST, ed.id`,
    [operadorId],
  );
  return rows;
}

module.exports = {
  criar,
  obter,
  listar,
  atualizar,
  novoCodigo,
  desativar,
  reativar,
  ativar,
  autenticar,
  daSessao,
  edicoesPermitidas,
  hashDoCodigo,
};
