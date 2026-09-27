const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();
const { conferirSenha, gerarHash } = require('../lib/senha');
const { normalizarEmail } = require('../anunciantes/repository');
const { limiteTentativas } = require('../lib/limite-tentativas');
const pool = require('../db/pool');
const outbox = require('../email/outbox');

// Redefinição de senha por link. Desde a v2 existe uma conta só por pessoa
// (tabela anunciantes, papéis no convite) — o tipo 'afiliado' fica aceito
// só pra link antigo ainda válido, e aponta pra mesma tabela.
const TIPOS = {
  anunciante: {
    tabela: 'anunciantes',
    colunaEmail: 'contato_email',
    colunaNome: 'nome_empresa',
    login: '/anunciante/login.html',
  },
  afiliado: {
    tabela: 'anunciantes',
    colunaEmail: 'contato_email',
    colunaNome: 'nome_empresa',
    login: '/anunciante/login.html',
  },
};

const VALIDADE_MS = 60 * 60 * 1000;

async function pedirRedefinicao(req, res, tipo) {
  const cfg = TIPOS[tipo];
  const destino = normalizarEmail(req.body.email);
  if (!destino) return res.status(400).json({ erro: 'e-mail obrigatório' });

  const { rows } = await pool.query(
    `SELECT id, ${cfg.colunaNome} AS nome, ${cfg.colunaEmail} AS email
     FROM ${cfg.tabela} WHERE lower(trim(${cfg.colunaEmail})) = $1`,
    [destino],
  );

  // Resposta é sempre a mesma, exista a conta ou não: senão a tela vira um
  // verificador de quem tem cadastro na Mostraí.
  res.json({ ok: true });

  const conta = rows[0];
  if (!conta) return;

  const token = crypto.randomBytes(32).toString('hex');
  const expiraEm = new Date(Date.now() + VALIDADE_MS);
  const base = process.env.SITE_URL || process.env.CORS_ORIGIN || '';
  const link = `${base}/redefinir-senha.html?token=${token}&tipo=${tipo}`;
  // Token e e-mail juntos: o link vai CIFRADO na fila (outbox) e sai dela
  // assim que o e-mail é enviado; nunca vai pra log.
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query('INSERT INTO tokens_senha (token, tipo, usuario_id, expira_em) VALUES ($1,$2,$3,$4)', [
      token,
      tipo,
      conta.id,
      expiraEm,
    ]);
    await outbox.enfileirar(
      {
        tipo: 'redefinir_senha',
        chave: `redefinir_senha:${conta.id}:${crypto.randomUUID()}`,
        para: conta.email,
        anuncianteId: conta.id,
        dados: { conta: { nome_empresa: conta.nome } },
        segredo: { link },
        validoAte: expiraEm,
      },
      cliente,
    );
    await cliente.query('COMMIT');
    outbox.despachar();
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    console.error('pedido de redefinição de senha não entrou na fila:', outbox.sanitizar(err));
  } finally {
    cliente.release();
  }
}

// A página de nova senha pergunta de quem é o link antes de a pessoa digitar:
// com o e-mail num campo `autocomplete="username"`, o gerenciador de senhas
// do navegador salva a senha nova na conta CERTA (em vez de criar uma
// entrada sem usuário, ou pegar o telefone). Só quem tem o token (256 bits,
// chegou no e-mail da própria conta) descobre o endereço.
router.get('/redefinir-senha/conta', limiteTentativas, async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ erro: 'token obrigatório' });
  const { rows } = await pool.query(
    `SELECT a.contato_email AS email FROM tokens_senha t JOIN anunciantes a ON a.id = t.usuario_id
      WHERE t.token = $1 AND t.expira_em > now()`,
    [token],
  );
  if (!rows[0]) return res.status(400).json({ erro: 'link inválido ou expirado — peça um novo' });
  res.set('Cache-Control', 'no-store');
  res.json({ email: rows[0].email });
});

router.post('/anunciantes/esqueci-senha', limiteTentativas, (req, res) => pedirRedefinicao(req, res, 'anunciante'));
// Afiliado (programa de vendedor) aposentado: link antigo recebe o caminho
// atual. O tipo 'afiliado' em TIPOS fica só pra token de redefinição já
// emitido (1h de validade) não quebrar no deploy.
router.post('/afiliados/esqueci-senha', (_req, res) =>
  res.status(410).json({ erro: 'use a redefinição de senha da conta em /anunciante/esqueci-senha.html' }),
);

router.post('/redefinir-senha', limiteTentativas, async (req, res) => {
  const { token, senha } = req.body;
  if (!token) return res.status(400).json({ erro: 'token obrigatório' });
  // Mesma regra do cadastro (lib/senha.js) — antes aqui eram 6 caracteres
  // quaisquer e no cadastro nenhum, enquanto o front pedia 8 com símbolo.
  const senhaFraca = conferirSenha(senha);
  if (senhaFraca) return res.status(400).json({ erro: senhaFraca });

  const { rows } = await pool.query('SELECT * FROM tokens_senha WHERE token = $1 AND expira_em > now()', [token]);
  const registro = rows[0];
  if (!registro) return res.status(400).json({ erro: 'link inválido ou expirado — peça um novo' });

  const cfg = TIPOS[registro.tipo];
  const hash = await gerarHash(senha);
  const {
    rows: [conta],
  } = await pool.query(
    `UPDATE ${cfg.tabela} SET senha_hash = $1 WHERE id = $2 RETURNING id, ${cfg.colunaNome} AS nome, ${cfg.colunaEmail} AS email`,
    [hash, registro.usuario_id],
  );
  // O link usado e qualquer outro pendente da mesma conta deixam de valer —
  // e os e-mails de link que ainda estão na fila não saem mais (revisão
  // Codex do PR #80: sairiam com um link já morto).
  await pool.query('DELETE FROM tokens_senha WHERE usuario_id = $1 AND tipo = $2', [
    registro.usuario_id,
    registro.tipo,
  ]);
  await outbox
    .descartarPendentes(registro.usuario_id, ['redefinir_senha'], 'senha já foi trocada')
    .catch((err) => console.error('fila: descartar links de senha pendentes falhou', outbox.sanitizar(err)));
  // Aviso de segurança: se não foi a pessoa, é por aqui que ela descobre.
  if (conta) {
    await outbox.enfileirarSemFalhar({
      tipo: 'senha_alterada',
      chave: `senha_alterada:${conta.id}:${crypto.randomUUID()}`,
      para: conta.email,
      anuncianteId: conta.id,
      dados: { conta: { nome_empresa: conta.nome } },
    });
  }

  res.json({ ok: true, login: cfg.login });
});

// Formulário de contato do site. Grava antes de tentar o e-mail: se o SMTP
// falhar, a mensagem do titular não se perde sem rastro (furos.md, seção
// Média — relevante agora que o SMTP está fora do ar por senha de app
// expirada, ver docs/PENDENCIAS.md).
router.post('/contato', limiteTentativas, async (req, res) => {
  const { nome, email: remetente, telefone, mensagem } = req.body;
  if (!nome || !remetente || !mensagem) return res.status(400).json({ erro: 'campos obrigatórios faltando' });
  const { rows } = await pool.query(
    'INSERT INTO mensagens_contato (nome, email, telefone, mensagem) VALUES ($1,$2,$3,$4) RETURNING id',
    [nome, remetente, telefone || null, mensagem],
  );
  // A mensagem já está gravada (id acima); o aviso por e-mail vai pela fila
  // e marca `email_enviado` quando sair. Quem escreveu não depende do SMTP.
  // Sem confirmação automática pra quem escreveu: o formulário é público e
  // sem login — responder por e-mail a qualquer endereço digitado ali
  // transformaria o site num jeito de mandar e-mail da Mostraí pra terceiros.
  const destino = outbox.remetenteInterno();
  if (destino) {
    await outbox.enfileirarSemFalhar({
      tipo: 'contato_interno',
      chave: `contato:${rows[0].id}`,
      para: destino,
      dados: {
        mensagemId: rows[0].id,
        mensagem: { nome, email: remetente, telefone: telefone || '', mensagem },
      },
    });
  }
  res.json({ ok: true });
});

// Admin — a caixa de entrada do formulário de contato. A migration 039 passou
// a gravar a mensagem antes de tentar o e-mail (pra falha de SMTP perder o
// aviso, não o dado), mas nenhuma tela lia a tabela: o dado ficava salvo e
// invisível. Com o SMTP fora do ar, TODA mensagem — inclusive pedido de dado
// pessoal, que tem prazo legal — caía nesse buraco.
//
// `email_enviado` vem junto de propósito: é o que diz se aquela mensagem
// chegou (ou não) na caixa de entrada de quem responde. Quando ele é `false`,
// esta tela é o ÚNICO lugar onde a mensagem existe.
router.get('/admin/mensagens-contato', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, email, telefone, mensagem, email_enviado, respondida_em, created_at
       FROM mensagens_contato ORDER BY created_at DESC`,
  );
  res.json(rows);
});

router.patch('/admin/mensagens-contato/:id', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE mensagens_contato SET respondida_em = CASE WHEN $2::boolean THEN now() ELSE NULL END
      WHERE id = $1 RETURNING id, respondida_em`,
    [req.params.id, req.body.respondida !== false],
  );
  if (!rows[0]) return res.status(404).json({ erro: 'mensagem não encontrada' });
  res.json(rows[0]);
});

// Sessão pública (24/09/2026, decisão D4 do dono): as páginas públicas só
// precisam saber SE há alguém logado (pra trocar "Entrar" pelo menu da conta
// e levar o "Assinar" direto pra confirmação). Antes elas perguntavam isso a
// `GET /anunciantes/me`, que é privada — e todo visitante anônimo via um 401
// no console, em toda página. Aqui "não logado" é resposta normal (200), e o
// que volta é o mínimo pra desenhar o cabeçalho: nada de e-mail, documento,
// telefone ou plano. A autenticação não afrouxa: `/anunciantes/me` e o resto
// das rotas da conta continuam respondendo 401 sem sessão. Conta suspensa já
// teve a sessão derrubada antes de chegar aqui (derrubarSessaoSuspensa).
router.get('/conta/sessao', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.session?.anuncianteId) return res.json({ logado: false });
  const { rows } = await pool.query(
    'SELECT nome_empresa, foto_url, papeis FROM anunciantes WHERE id = $1 AND excluido_em IS NULL',
    [req.session.anuncianteId],
  );
  if (!rows[0]) return res.json({ logado: false });
  res.json({
    logado: true,
    conta: { nome_empresa: rows[0].nome_empresa, foto_url: rows[0].foto_url, papeis: rows[0].papeis },
  });
});

module.exports = router;
