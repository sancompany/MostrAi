const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { medir } = require('./lib/registro');
const { token, hashToken } = require('./lib/codigos');
const { conteudoDoQr, qrDataUrl } = require('./lib/qr');
const { gerarHash, conferirHash, conferirSenha } = require('../lib/senha');
const config = require('./config');
const email = require('./email');

// Conta do cliente da Trimundi (pedido do dono, 09/11/2026): cadastro com
// nome, CPF, e-mail e senha; o e-mail é confirmado por link antes da
// primeira compra; na conta ficam os ingressos, os QR Codes e o link de
// indicação. Respostas de "esqueci a senha" e "reenviar confirmação" são
// sempre as mesmas — não dizem se o e-mail tem conta.

const CONFIRMAR_H = 48;
const REDEFINIR_MIN = 60;

const site = () => config.urlDoSite();

function lerCadastro(d) {
  const senha = String(d?.senha ?? '');
  const regra = conferirSenha(senha);
  if (regra) throw erro(400, regra);
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
    assunto: 'Confirme seu e-mail — Trimundi',
    texto: `Olá, ${c.nome.split(' ')[0]}.\n\nPara ativar sua conta na Trimundi, confirme seu e-mail neste link (vale por ${CONFIRMAR_H} horas):\n${site()}/ticket/conta/confirmar#t=${tk}\n\nSe não foi você, ignore este e-mail.`,
  });
}

async function cadastrar(dados) {
  const d = lerCadastro(dados);
  const hash = await gerarHash(d.senha);
  return emTransacao(async (cliente) => {
    // Serializa cadastros do mesmo CPF/e-mail (dois cliques ao mesmo tempo).
    await cliente.query('SELECT pg_advisory_xact_lock(872028, hashtext($1))', [d.cpf]);
    const { rows } = await cliente.query(
      'SELECT * FROM clientes WHERE anonimizado_em IS NULL AND (email = $1 OR cpf = $2)',
      [d.email, d.cpf],
    );
    const mesmoEmail = rows.find((r) => r.email === d.email);
    const mesmoCpf = rows.find((r) => r.cpf === d.cpf);
    if (mesmoCpf && mesmoCpf.email !== d.email) {
      throw erro(409, 'Este CPF já tem conta na Trimundi. Entre com o e-mail dela ou recupere a senha.', {
        codigo: 'cpf_em_uso',
      });
    }
    if (mesmoEmail) {
      // Conta existente: nada muda nela (nem a senha). Quem não confirmou
      // recebe o link de novo; quem já confirmou recebe o aviso.
      if (mesmoEmail.email_confirmado_em) {
        await email.enfileirar(cliente, {
          chave: `conta_existente:${mesmoEmail.id}:${Date.now()}`,
          tipo: 'conta_existente',
          para: mesmoEmail.email,
          assunto: 'Você já tem conta na Trimundi',
          texto: `Alguém tentou criar uma conta com este e-mail, que já tem conta na Trimundi.\n\nPara entrar: ${site()}/ticket/conta\nEsqueceu a senha? Recupere em ${site()}/ticket/conta/esqueci\n\nSe não foi você, ignore este e-mail.`,
        });
      } else {
        await enviarConfirmacao(cliente, mesmoEmail);
      }
      return { email: d.email };
    }
    const { rows: novo } = await cliente.query(
      'INSERT INTO clientes (nome, cpf, email, senha_hash) VALUES ($1, $2, $3, $4) RETURNING *',
      [d.nome, d.cpf, d.email, hash],
    );
    await enviarConfirmacao(cliente, novo[0]);
    await medir(cliente, 'conta:cadastro', null, {});
    return { email: d.email };
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
      assunto: 'Redefinir sua senha — Trimundi',
      texto: `Para criar uma senha nova na Trimundi, use este link (vale por ${REDEFINIR_MIN} minutos):\n${site()}/ticket/conta/redefinir#t=${tk}\n\nSe não foi você, ignore este e-mail: sua senha continua a mesma.`,
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

// Cliente da sessão, conferido no banco a cada requisição.
async function daSessao(req) {
  const id = req.session?.trimundiClienteId;
  if (!id || !config.configurada()) return null;
  const { rows } = await consultar(
    `SELECT id, nome, cpf, email, sessao_versao, email_confirmado_em FROM clientes
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

// "Minha conta": dados, ingressos pagos com QR e benefícios.
async function painel(c) {
  const { rows } = await consultar(
    `SELECT i.id, i.codigo, i.codigo_curto, i.status, cat.nome AS categoria, pa.nome AS participante,
            ev.nome AS evento, ed.nome AS edicao, ed.inicio_em, ed.local_nome, ed.cidade, ed.uf, ed.codigo_publico,
            ev.slug AS evento_slug, ed.slug AS edicao_slug, p.id AS pedido_id,
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
  const ingressos = await Promise.all(
    rows.map(async (i) => ({
      codigo_curto: i.codigo_curto,
      evento: i.evento,
      edicao: i.edicao,
      inicio_em: i.inicio_em,
      local: [i.local_nome, i.cidade && `${i.cidade}${i.uf ? `/${i.uf}` : ''}`].filter(Boolean).join(' · ') || null,
      endereco_publico: `/ticket/${i.evento_slug}/${i.edicao_slug}`,
      pedido: i.pedido_id.slice(0, 8).toUpperCase(),
      categoria: i.categoria,
      participante: i.participante,
      status: i.status,
      utilizado_em: i.utilizado_em,
      beneficios: i.beneficios,
      qr: i.status === 'valido' && !i.utilizado_em ? await qrDataUrl(conteudoDoQr(i.codigo_publico, i.codigo)) : null,
    })),
  );
  return {
    conta: { nome: c.nome, email: c.email, cpf: mascararCpf(c.cpf) },
    ingressos,
    indicacao: await require('./indicacao').andamentoDoCliente(c.id),
  };
}

module.exports = {
  cadastrar,
  confirmarEmail,
  reenviarConfirmacao,
  entrar,
  esqueciSenha,
  redefinirSenha,
  daSessao,
  painel,
  mascararCpf,
};
