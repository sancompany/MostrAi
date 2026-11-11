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
// check-in existe. Só o Admin cria operador (não há cadastro público); o
// login é o da Trimundi (/ticket/entrar), separado da Mostraí (decisão do
// dono, 09/11/2026). Revogação imediata: desativar ou gerar código novo
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
  const codigo = gerarCodigo();
  return emTransacao(async (cliente) => {
    const ids = await conferirEdicoes(cliente, dados?.edicoes);
    const { rows: ja } = await cliente.query('SELECT 1 FROM operadores WHERE email_normalizado = $1', [email]);
    if (ja.length) throw erro(409, 'Já existe um operador com este e-mail.');
    const { rows } = await cliente.query(
      `INSERT INTO operadores (nome, email, email_normalizado, codigo_hash, codigo_expira_em, indicacao_habilitada)
       VALUES ($1, $2, $2, $3, now() + make_interval(hours => $4), $5) RETURNING id`,
      [nome, email, hashDoCodigo(codigo), VALIDADE_CODIGO_H, v.booleano(dados?.indicacao_habilitada, false)],
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
            o.indicacao_habilitada, o.vinculado_em,
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
    // Link de indicação próprio na tela de check-in, quando o Admin habilita.
    indicacao_habilitada: o.indicacao_habilitada,
    // Ligado a uma conta TICK (12, 11/11/2026): entra pela conta, não por
    // /ticket/entrar.
    na_conta_tick: Boolean(o.vinculado_em),
    edicoes: todas ? 'todas' : o.permissoes.map((p) => ({ id: p.edicao_id, nome: p.nome })),
  };
}

async function listar() {
  const { rows } = await consultar('SELECT id FROM operadores WHERE anonimizado_em IS NULL ORDER BY criado_em DESC');
  const lista = [];
  for (const r of rows) {
    lista.push(await obter(r.id));
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
    if (Object.hasOwn(dados || {}, 'indicacao_habilitada')) {
      await cliente.query('UPDATE operadores SET indicacao_habilitada = $2 WHERE id = $1', [
        id,
        v.booleano(dados.indicacao_habilitada, false),
      ]);
      campos.push('indicacao_habilitada');
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
      `UPDATE operadores SET status = CASE WHEN senha_hash IS NULL AND cliente_id IS NULL THEN 'aguardando_ativacao' ELSE 'ativo' END,
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

// Ativação NA CONTA TICK (pedido do dono, 11/11/2026): o mesmo código do
// convite (uso único, validade, 5 tentativas, revogado por código novo), mas
// em vez de criar uma senha só para a portaria, liga o operador à conta
// logada. Regras:
//   · o convite é para um e-mail: só a conta com ESSE e-mail o usa (outro
//     e-mail → 409, nada é ligado nem transferido);
//   · operador já ligado a outra conta, ou conta já ligada a outro operador
//     → 409, sem mexer em nada;
//   · conta já ligada a este operador → ok, sem duplicar;
//   · código errado conta tentativa no convite do e-mail da conta.
// Tudo decidido aqui, no servidor — nunca pelo parâmetro do link.
async function vincular(conta, dados) {
  const codigo = normalizarCodigo(dados?.codigo);
  const invalido = () =>
    erro(400, 'Código inválido. Confira o código ou peça um novo a quem organiza o evento.', {
      codigo: 'codigo_invalido',
    });
  const emailDaConta = String(conta?.email ?? '')
    .trim()
    .toLowerCase();
  return emTransacao(async (cliente) => {
    const { rows: meu } = await cliente.query('SELECT id, status FROM operadores WHERE cliente_id = $1', [conta.id]);
    const { rows } =
      codigo.length === 8
        ? await cliente.query('SELECT * FROM operadores WHERE codigo_hash = $1 FOR UPDATE', [hashDoCodigo(codigo)])
        : { rows: [] };
    const o = rows[0];
    // O código já usado (ou repetido) por quem já está ligado e ativo: nada a
    // fazer, sem duplicar.
    if (!o && meu[0]?.status === 'ativo') return { ok: true, ja_ativo: true, operador_id: meu[0].id };
    if (!o) {
      await cliente.query(
        `UPDATE operadores SET codigo_tentativas = codigo_tentativas + 1
          WHERE email_normalizado = $1 AND status = 'aguardando_ativacao'`,
        [emailDaConta],
      );
      return { erro: 'invalido' };
    }
    if (o.email_normalizado !== emailDaConta) {
      throw erro(
        409,
        'Este convite de operador foi emitido para outro e-mail. Entre com a conta TICK desse e-mail, ou peça a quem organiza o evento um convite para o e-mail desta conta.',
        { codigo: 'outro_email' },
      );
    }
    if (o.cliente_id && Number(o.cliente_id) !== Number(conta.id)) {
      throw erro(409, 'Este convite já está ligado a outra conta TICK. Fale com quem organiza o evento.', {
        codigo: 'outra_conta',
      });
    }
    if (meu[0] && Number(meu[0].id) !== Number(o.id)) {
      throw erro(409, 'Esta conta já está ligada a outro cadastro de operador. Fale com quem organiza o evento.', {
        codigo: 'ja_operador',
      });
    }
    if (o.status !== 'aguardando_ativacao' || o.codigo_tentativas >= MAX_TENTATIVAS_CODIGO) throw invalido();
    if (new Date(o.codigo_expira_em) <= new Date()) {
      throw erro(410, 'Este código venceu — peça um novo a quem organiza o evento.', { codigo: 'codigo_vencido' });
    }
    await cliente.query(
      `UPDATE operadores SET cliente_id = $2, vinculado_em = COALESCE(vinculado_em, now()), status = 'ativo',
         ativado_em = COALESCE(ativado_em, now()), codigo_hash = NULL, codigo_expira_em = NULL, codigo_tentativas = 0,
         sessao_versao = sessao_versao + 1
       WHERE id = $1`,
      [o.id, conta.id],
    );
    await medir(cliente, 'acesso:operador_ativa', null, { operador_id: o.id, na_conta: true });
    return { ok: true, ja_ativo: false, operador_id: o.id };
  }).then((r) => {
    if (r.erro) throw invalido();
    return r;
  });
}

// Operador ligado à conta (ativo ou não) — para "Minha conta".
async function daConta(clienteId) {
  const { rows } = await consultar('SELECT id, nome, status FROM operadores WHERE cliente_id = $1', [clienteId]);
  return rows[0] || null;
}

// Login do operador (/ticket/entrar): null = e-mail ou senha errados (a
// mesma resposta nos dois casos).
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
// com versão antiga perde a sessão na hora. Duas origens: o login antigo da
// portaria (/ticket/entrar) ou — desde 11/11/2026 — a própria conta TICK
// ligada a um operador ativo (um login só).
async function daSessao(req) {
  if (!config.configurada()) return null;
  const id = req.session?.trimundiOperadorId;
  if (!id) return daContaLogada(req);
  const { rows } = await consultar(
    'SELECT id, nome, status, sessao_versao, ultimo_acesso_em FROM operadores WHERE id = $1',
    [id],
  );
  const o = rows[0];
  if (o?.status !== 'ativo' || o.sessao_versao !== req.session.trimundiOperadorVersao) {
    delete req.session.trimundiOperadorId;
    delete req.session.trimundiOperadorVersao;
    return daContaLogada(req);
  }
  if (!o.ultimo_acesso_em || Date.now() - new Date(o.ultimo_acesso_em).getTime() > 5 * 60000) {
    await consultar('UPDATE operadores SET ultimo_acesso_em = now() WHERE id = $1', [o.id]);
  }
  return o;
}

// A conta TICK logada (confirmada, sessão em dia) ligada a um operador ativo.
async function daContaLogada(req) {
  const conta = await require('./clientes').daSessao(req);
  if (!conta) return null;
  const { rows } = await consultar(
    "SELECT id, nome, status, sessao_versao, ultimo_acesso_em FROM operadores WHERE cliente_id = $1 AND status = 'ativo'",
    [conta.id],
  );
  const o = rows[0];
  if (!o) return null;
  if (!o.ultimo_acesso_em || Date.now() - new Date(o.ultimo_acesso_em).getTime() > 5 * 60000) {
    await consultar('UPDATE operadores SET ultimo_acesso_em = now() WHERE id = $1', [o.id]);
  }
  return { ...o, pela_conta: true };
}

// Edições em que o operador pode fazer check-in agora (publicadas ou pausadas).
async function edicoesPermitidas(operadorId) {
  const { rows } = await consultar(
    `SELECT DISTINCT ed.id, ed.nome, ev.nome AS evento, ed.inicio_em, ed.codigo_publico, ed.classificacao_etaria
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
  vincular,
  daConta,
  autenticar,
  daSessao,
  edicoesPermitidas,
  hashDoCodigo,
};
