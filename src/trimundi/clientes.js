const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { medir } = require('./lib/registro');
const { token, hashToken } = require('./lib/codigos');
const { conteudoDoQr, qrDataUrl } = require('./lib/qr');
const { gerarHash, conferirHash, conferirSenha } = require('../lib/senha');
const config = require('./config');
const email = require('./email');
const legal = require('./legal');

// Conta do cliente da Trimundi (pedido do dono, 09/11/2026): cadastro com
// nome, CPF, e-mail e senha; o e-mail é confirmado por link antes da
// primeira compra; na conta ficam os ingressos, os QR Codes e o link de
// indicação. Respostas de "esqueci a senha" e "reenviar confirmação" são
// sempre as mesmas — não dizem se o e-mail tem conta.

const CONFIRMAR_H = 48;
const REDEFINIR_MIN = 60;

const site = () => config.urlDoSite();

// Aceite obrigatório: maioridade (a conta é só para maiores de 18) e os
// Termos de Uso com a Política de Privacidade, na versão vigente. A tela
// manda a versão que MOSTROU (`versao_termos`): se não for a vigente (a
// versão mudou com a tela aberta), não vale — ninguém aceita um texto que não
// lhe foi apresentado.
function lerAceite(d) {
  if (d?.maioridade !== true) {
    throw erro(400, 'A conta é só para maiores de 18 anos — confirme que você tem 18 anos ou mais.', {
      codigo: 'maioridade',
    });
  }
  if (d?.aceite_termos !== true) {
    throw erro(400, 'Para criar a conta, aceite os Termos de Uso e a Política de Privacidade.', {
      codigo: 'aceite_termos',
    });
  }
  if (String(d?.versao_termos ?? '') !== legal.VERSAO) {
    throw erro(
      409,
      'Os Termos de Uso e a Política de Privacidade foram atualizados. Leia a versão atual e aceite de novo.',
      { codigo: 'versao_termos', versao: legal.VERSAO },
    );
  }
}

const textoCurto = (t, n) => (t ? String(t).slice(0, n) : null);

// Cada aceite vira uma linha que não muda (aceites_conta): o aceite anterior
// nunca é apagado nem sobrescrito.
async function registrarAceite(cliente, clienteId, origem, contexto) {
  await cliente.query(
    `INSERT INTO aceites_conta (cliente_id, versao, documentos_hash, origem, maioridade_declarada, ip, user_agent)
     VALUES ($1, $2, $3, $4, true, $5, $6)`,
    [
      clienteId,
      legal.VERSAO,
      legal.hashDocumentos(),
      origem,
      textoCurto(contexto.ip, 64),
      textoCurto(contexto.userAgent, 300),
    ],
  );
}

// Uma conta TICK por CPF e por e-mail (pedido do dono, 10/11/2026). As
// mensagens dizem qual dos dois já existe e mandam para o login. O banco
// garante a regra (índices únicos `ux_clientes_cpf` e `ux_clientes_email`);
// o servidor só traduz.
const EMAIL_EM_USO = 'Este e-mail já possui uma conta. Entre na sua conta.';
const CPF_EM_USO = 'Este CPF já possui uma conta vinculada. Entre na sua conta.';
const emUso = (qual) =>
  qual === 'email'
    ? erro(409, EMAIL_EM_USO, { codigo: 'email_em_uso', entrar: '/ticket/conta' })
    : erro(409, CPF_EM_USO, { codigo: 'cpf_em_uso', entrar: '/ticket/conta' });

function lerCadastro(d) {
  lerAceite(d);
  const senha = String(d?.senha ?? '');
  const regra = conferirSenha(senha);
  if (regra) throw erro(400, regra);
  if (String(d?.senha_confirmacao ?? '') !== senha) {
    throw erro(400, 'A confirmação da senha não confere — digite a mesma senha nos dois campos.', {
      codigo: 'senha_confirmacao',
    });
  }
  return {
    nome: v.texto(d?.nome, {
      campo: 'o nome',
      obrigatorio: true,
      min: 2,
      max: 120,
      mensagem: 'Informe seu nome completo.',
    }),
    cpf: v.cpf(d?.cpf, { mensagem: 'CPF inválido — confira os números.' }),
    email: v.email(d?.email),
    senha,
  };
}

// Link de uso único: os anteriores do mesmo tipo deixam de valer.
async function novoToken(cliente, clienteId, tipo, minutos) {
  await cliente.query(
    'UPDATE cliente_tokens SET usado_em = now() WHERE cliente_id = $1 AND tipo = $2 AND usado_em IS NULL',
    [clienteId, tipo],
  );
  const tk = token();
  await cliente.query(
    `INSERT INTO cliente_tokens (cliente_id, tipo, token_hash, expira_em)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [clienteId, tipo, hashToken(tk), minutos],
  );
  return tk;
}

// O token vai no fragmento (#): não aparece em log de servidor nem em Referer.
async function enviarConfirmacao(cliente, c) {
  const tk = await novoToken(cliente, c.id, 'confirmar_email', CONFIRMAR_H * 60);
  await email.enfileirar(cliente, {
    chave: `confirmar_email:${c.id}:${hashToken(tk).slice(0, 16)}`,
    tipo: 'confirmar_email',
    para: c.email,
    assunto: 'Confirme seu e-mail — TICK',
    texto: `Olá, ${c.nome.split(' ')[0]}.\n\nPara ativar sua conta na TICK, confirme seu e-mail neste link (vale por ${CONFIRMAR_H} horas):\n${site()}/ticket/conta/confirmar#t=${tk}\n\nSe não foi você, ignore este e-mail.`,
  });
}

async function cadastrar(dados, contexto = {}) {
  const d = lerCadastro(dados);
  const hash = await gerarHash(d.senha);
  return emTransacao(async (cliente) => {
    // Serializa cadastros do mesmo CPF e do mesmo e-mail (dois cliques, duas
    // abas ao mesmo tempo). Sempre na mesma ordem: CPF, depois e-mail.
    await cliente.query('SELECT pg_advisory_xact_lock(872028, hashtext($1))', [`cpf:${d.cpf}`]);
    await cliente.query('SELECT pg_advisory_xact_lock(872028, hashtext($1))', [`email:${d.email}`]);
    const { rows } = await cliente.query(
      'SELECT email, cpf FROM clientes WHERE anonimizado_em IS NULL AND (email = $1 OR cpf = $2)',
      [d.email, d.cpf],
    );
    if (rows.some((r) => r.email === d.email)) throw emUso('email');
    if (rows.some((r) => r.cpf === d.cpf)) throw emUso('cpf');
    const { rows: novo } = await cliente.query(
      `INSERT INTO clientes (nome, cpf, email, senha_hash, termos_versao, termos_aceitos_em, maioridade_declarada_em,
          aceite_ip, aceite_user_agent)
       VALUES ($1, $2, $3, $4, $5, now(), now(), $6, $7) RETURNING *`,
      [d.nome, d.cpf, d.email, hash, legal.VERSAO, textoCurto(contexto.ip, 64), textoCurto(contexto.userAgent, 300)],
    );
    await registrarAceite(cliente, novo[0].id, 'cadastro', contexto);
    await enviarConfirmacao(cliente, novo[0]);
    await medir(cliente, 'conta:cadastro', null, {});
    return { email: d.email };
  }).catch((err) => {
    // Última linha de defesa: o índice único do banco barrou (corrida que
    // escapou das travas). Mesma mensagem de sempre, nunca o erro cru.
    if (err?.code === '23505' && /ux_clientes_email/.test(err.constraint || '')) throw emUso('email');
    if (err?.code === '23505' && /ux_clientes_cpf/.test(err.constraint || '')) throw emUso('cpf');
    throw err;
  });
}

// Consome um link de uso único; devolve o cliente ou lança 400.
async function consumir(cliente, tipo, tk) {
  const t = String(tk ?? '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) throw erro(400, 'Link inválido ou vencido.');
  const { rows } = await cliente.query(
    `UPDATE cliente_tokens SET usado_em = now()
      WHERE token_hash = $1 AND tipo = $2 AND usado_em IS NULL AND expira_em > now()
      RETURNING cliente_id`,
    [hashToken(t), tipo],
  );
  if (!rows[0]) throw erro(400, 'Link inválido ou vencido — peça um novo.');
  const { rows: c } = await cliente.query('SELECT * FROM clientes WHERE id = $1 AND anonimizado_em IS NULL', [
    rows[0].cliente_id,
  ]);
  if (!c[0]) throw erro(400, 'Link inválido ou vencido.');
  return c[0];
}

async function confirmarEmail(tk) {
  return emTransacao(async (cliente) => {
    const c = await consumir(cliente, 'confirmar_email', tk);
    if (!c.email_confirmado_em) {
      await cliente.query('UPDATE clientes SET email_confirmado_em = now(), atualizado_em = now() WHERE id = $1', [
        c.id,
      ]);
      await medir(cliente, 'conta:email_confirmado', null, {});
    }
    return { id: c.id, versao: c.sessao_versao };
  });
}

async function reenviarConfirmacao(emailBruto) {
  const e = v.email(emailBruto);
  await emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM clientes WHERE email = $1 AND anonimizado_em IS NULL AND email_confirmado_em IS NULL',
      [e],
    );
    if (rows[0]) await enviarConfirmacao(cliente, rows[0]);
  });
}

// Hash de referência para conferir senha mesmo sem conta: o tempo da
// resposta não diz se o e-mail existe.
let hashFalso = null;

async function entrar(emailBruto, senha) {
  const e = String(emailBruto ?? '')
    .trim()
    .toLowerCase();
  if (!e || e.length > 200) return null;
  const { rows } = await consultar(
    'SELECT id, senha_hash, sessao_versao, email_confirmado_em FROM clientes WHERE email = $1 AND anonimizado_em IS NULL',
    [e],
  );
  const c = rows[0];
  if (!c) {
    hashFalso ||= await gerarHash('trimundi-senha-que-nao-existe');
    await conferirHash(String(senha ?? ''), hashFalso);
    return null;
  }
  const { ok } = await conferirHash(String(senha ?? ''), c.senha_hash);
  if (!ok) return null;
  if (!c.email_confirmado_em) return { naoConfirmado: true };
  await consultar('UPDATE clientes SET ultimo_acesso_em = now() WHERE id = $1', [c.id]);
  return { id: c.id, versao: c.sessao_versao };
}

async function esqueciSenha(emailBruto) {
  const e = v.email(emailBruto);
  await emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM clientes WHERE email = $1 AND anonimizado_em IS NULL', [e]);
    const c = rows[0];
    if (!c) return;
    const tk = await novoToken(cliente, c.id, 'redefinir_senha', REDEFINIR_MIN);
    await email.enfileirar(cliente, {
      chave: `redefinir_senha:${c.id}:${hashToken(tk).slice(0, 16)}`,
      tipo: 'redefinir_senha',
      para: c.email,
      assunto: 'Redefinir sua senha — TICK',
      texto: `Para criar uma senha nova na TICK, use este link (vale por ${REDEFINIR_MIN} minutos):\n${site()}/ticket/conta/redefinir#t=${tk}\n\nSe não foi você, ignore este e-mail: sua senha continua a mesma.`,
    });
  });
}

// Senha nova derruba as sessões abertas e confirma o e-mail (quem abriu o
// link provou que recebe nele).
async function redefinirSenha(tk, senha) {
  const regra = conferirSenha(String(senha ?? ''));
  if (regra) throw erro(400, regra);
  const hash = await gerarHash(String(senha));
  return emTransacao(async (cliente) => {
    const c = await consumir(cliente, 'redefinir_senha', tk);
    const { rows } = await cliente.query(
      `UPDATE clientes SET senha_hash = $2, sessao_versao = sessao_versao + 1,
              email_confirmado_em = COALESCE(email_confirmado_em, now()), atualizado_em = now()
        WHERE id = $1 RETURNING sessao_versao`,
      [c.id, hash],
    );
    return { id: c.id, versao: rows[0].sessao_versao };
  });
}

// Aceite de novo (versão nova dos Termos, ou conta anterior ao aceite).
async function aceitar(c, dados, contexto = {}) {
  lerAceite(dados);
  await emTransacao(async (cliente) => {
    // A conta guarda o aceite vigente (o que a compra confere); o histórico,
    // todos.
    await cliente.query(
      `UPDATE clientes SET termos_versao = $2, termos_aceitos_em = now(), maioridade_declarada_em = now(),
              aceite_ip = $3, aceite_user_agent = $4, atualizado_em = now()
        WHERE id = $1`,
      [c.id, legal.VERSAO, textoCurto(contexto.ip, 64), textoCurto(contexto.userAgent, 300)],
    );
    await registrarAceite(cliente, c.id, 'reaceite', contexto);
  });
  return { ok: true, versao: legal.VERSAO };
}

const aceiteEmDia = (c) => Boolean(c?.termos_aceitos_em && c.termos_versao === legal.VERSAO);

// Cliente da sessão, conferido no banco a cada requisição.
async function daSessao(req) {
  const id = req.session?.trimundiClienteId;
  if (!id || !config.configurada()) return null;
  const { rows } = await consultar(
    `SELECT id, nome, cpf, email, sessao_versao, email_confirmado_em, termos_versao, termos_aceitos_em FROM clientes
      WHERE id = $1 AND anonimizado_em IS NULL`,
    [id],
  );
  const c = rows[0];
  if (!c || c.sessao_versao !== req.session.trimundiClienteVersao || !c.email_confirmado_em) {
    delete req.session.trimundiClienteId;
    delete req.session.trimundiClienteVersao;
    return null;
  }
  return c;
}

const mascararCpf = (cpf) => (cpf ? `***.${cpf.slice(3, 6)}.***-${cpf.slice(9)}` : null);

// "Minha conta": dados, os pedidos — agrupados por edição, um cartão por
// pedido (nunca dois eventos no mesmo cartão) — com os ingressos, o QR e os
// benefícios, e a indicação. O QR só sai de ingresso válido de pedido pago e
// ainda não usado (como sempre foi).
const SITUACAO_PEDIDO = {
  aguardando_pagamento: 'Aguardando pagamento',
  pago: 'Confirmado',
  expirado: 'Expirado',
  cancelado: 'Cancelado',
  estornado: 'Reembolsado',
  pago_sem_vaga: 'Pago sem vaga — devolução em andamento',
};

async function painel(c) {
  const { rows: pedidos } = await consultar(
    `SELECT p.id, p.status, p.criado_em, p.pago_em, p.reserva_expira_em, p.total_centavos,
            ed.id AS edicao_id, ev.nome AS evento, ed.nome AS edicao, ed.inicio_em, ed.local_nome, ed.cidade, ed.uf,
            ev.slug AS evento_slug, ed.slug AS edicao_slug,
            COALESCE((SELECT json_agg(json_build_object('descricao', pi.descricao, 'quantidade', pi.quantidade) ORDER BY pi.ordem)
                        FROM pedido_itens pi WHERE pi.pedido_id = p.id), '[]') AS itens
       FROM pedidos p JOIN edicoes ed ON ed.id = p.edicao_id JOIN eventos ev ON ev.id = ed.evento_id
      WHERE p.cliente_id = $1 AND p.origem = 'venda'
      ORDER BY ed.inicio_em NULLS LAST, ed.id, p.criado_em DESC`,
    [c.id],
  );
  const { rows } = await consultar(
    `SELECT i.id, i.codigo, i.codigo_curto, i.status, cat.nome AS categoria, pa.nome AS participante,
            ev.nome AS evento, ed.nome AS edicao, ed.inicio_em, ed.local_nome, ed.cidade, ed.uf, ed.codigo_publico,
            ev.slug AS evento_slug, ed.slug AS edicao_slug, p.id AS pedido_id, p.status AS pedido_status,
            (SELECT registrado_em FROM checkins ck WHERE ck.ingresso_id = i.id AND ck.escopo = 'entrada' AND ck.resultado = 'aceito') AS utilizado_em,
            COALESCE((SELECT json_agg(json_build_object('nome', ib.nome, 'resgatado_em', ib.resgatado_em) ORDER BY ib.nome)
                        FROM ingresso_beneficios ib WHERE ib.ingresso_id = i.id), '[]') AS beneficios
       FROM ingressos i
       JOIN pedidos p ON p.id = i.pedido_id
       JOIN categorias cat ON cat.id = i.categoria_id
       JOIN participantes pa ON pa.id = i.participante_id
       JOIN edicoes ed ON ed.id = i.edicao_id JOIN eventos ev ON ev.id = ed.evento_id
      WHERE p.cliente_id = $1
      ORDER BY ed.inicio_em NULLS LAST, i.id`,
    [c.id],
  );
  const localDe = (r) =>
    [r.local_nome, r.cidade && `${r.cidade}${r.uf ? `/${r.uf}` : ''}`].filter(Boolean).join(' · ') || null;
  const ingressos = await Promise.all(
    rows.map(async (i) => ({
      codigo_curto: i.codigo_curto,
      evento: i.evento,
      edicao: i.edicao,
      inicio_em: i.inicio_em,
      local: localDe(i),
      endereco_publico: `/ticket/${i.evento_slug}/${i.edicao_slug}`,
      pedido: i.pedido_id.slice(0, 8).toUpperCase(),
      pedido_id: i.pedido_id,
      categoria: i.categoria,
      participante: i.participante,
      status: i.status,
      utilizado_em: i.utilizado_em,
      beneficios: i.beneficios,
      qr:
        i.status === 'valido' && !i.utilizado_em && i.pedido_status === 'pago'
          ? await qrDataUrl(conteudoDoQr(i.codigo_publico, i.codigo))
          : null,
    })),
  );
  const porPedido = new Map();
  for (const i of ingressos) {
    if (!porPedido.has(i.pedido_id)) porPedido.set(i.pedido_id, []);
    const { pedido_id, evento, edicao, inicio_em, local, endereco_publico, ...resto } = i;
    porPedido.get(i.pedido_id).push(resto);
  }
  const edicoes = new Map();
  for (const p of pedidos) {
    if (!edicoes.has(p.edicao_id)) {
      edicoes.set(p.edicao_id, {
        evento: p.evento,
        edicao: p.edicao,
        inicio_em: p.inicio_em,
        local: localDe(p),
        endereco_publico: `/ticket/${p.evento_slug}/${p.edicao_slug}`,
        pedidos: [],
      });
    }
    const vivo = p.status === 'aguardando_pagamento' && new Date(p.reserva_expira_em) > new Date();
    edicoes.get(p.edicao_id).pedidos.push({
      id: p.id,
      codigo: p.id.slice(0, 8).toUpperCase(),
      status: vivo || p.status !== 'aguardando_pagamento' ? p.status : 'expirado',
      situacao: SITUACAO_PEDIDO[vivo || p.status !== 'aguardando_pagamento' ? p.status : 'expirado'],
      criado_em: p.criado_em,
      pago_em: p.pago_em,
      reserva_expira_em: vivo ? p.reserva_expira_em : null,
      total_centavos: p.total_centavos,
      itens: p.itens,
      ingressos: porPedido.get(p.id) || [],
    });
  }
  const indicacao = await require('./indicacao').andamentoDoCliente(c.id);
  if (indicacao) {
    const { rows: ind } = await consultar('SELECT id FROM indicadores WHERE cliente_id = $1', [c.id]);
    indicacao.numeros = await require('./desempenho').numerosDoIndicador(ind[0].id);
  }
  return {
    conta: { nome: c.nome, email: c.email, cpf: mascararCpf(c.cpf), aceite_pendente: !aceiteEmDia(c) },
    termos_versao: legal.VERSAO,
    edicoes: [...edicoes.values()],
    ingressos,
    indicacao,
  };
}

// "Continuar pagamento" de um pedido da própria conta ainda aguardando: um
// acesso novo ao pedido (o mesmo link que a compra gera). Pedido de outra
// conta, pago, expirado ou cancelado: não.
async function linkDoMeuPedido(c, pedidoId) {
  const id = v.uuid(pedidoId);
  if (!id) throw erro(404, 'pedido não encontrado');
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      "SELECT id FROM pedidos WHERE id = $1 AND cliente_id = $2 AND status = 'aguardando_pagamento' AND reserva_expira_em > now()",
      [id, c.id],
    );
    if (!rows[0]) throw erro(404, 'Este pedido não está aguardando pagamento.');
    const tk = await require('./pedidos').novoAcesso(cliente, id, 'compra');
    return { url: `/ticket/pedido/${id}?t=${encodeURIComponent(tk)}` };
  });
}

module.exports = {
  cadastrar,
  confirmarEmail,
  reenviarConfirmacao,
  entrar,
  esqueciSenha,
  redefinirSenha,
  daSessao,
  aceitar,
  aceiteEmDia,
  painel,
  linkDoMeuPedido,
  mascararCpf,
};
