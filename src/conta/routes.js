const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();
const { conferirSenha, gerarHash } = require('../lib/senha');
const { limiteTentativas } = require('../lib/limite-tentativas');
const pool = require('../db/pool');
const email = require('../financeiro/email');

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
  const { email: destino } = req.body;
  if (!destino) return res.status(400).json({ erro: 'e-mail obrigatório' });

  const { rows } = await pool.query(
    `SELECT id, ${cfg.colunaNome} AS nome, ${cfg.colunaEmail} AS email
     FROM ${cfg.tabela} WHERE ${cfg.colunaEmail} = $1`,
    [destino],
  );

  // Resposta é sempre a mesma, exista a conta ou não: senão a tela vira um
  // verificador de quem tem cadastro na Mostraí.
  res.json({ ok: true });

  const conta = rows[0];
  if (!conta) return;

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO tokens_senha (token, tipo, usuario_id, expira_em) VALUES ($1,$2,$3,$4)', [
    token,
    tipo,
    conta.id,
    new Date(Date.now() + VALIDADE_MS),
  ]);

  const base = process.env.SITE_URL || process.env.CORS_ORIGIN || '';
  const link = `${base}/redefinir-senha.html?token=${token}&tipo=${tipo}`;
  email
    .enviarLinkRedefinicaoSenha(conta.email, conta.nome, link)
    .catch((err) => console.error('falha ao enviar link de redefinição', err));
}

router.post('/anunciantes/esqueci-senha', limiteTentativas, (req, res) => pedirRedefinicao(req, res, 'anunciante'));
router.post('/afiliados/esqueci-senha', limiteTentativas, (req, res) => pedirRedefinicao(req, res, 'afiliado'));

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
  await pool.query(`UPDATE ${cfg.tabela} SET senha_hash = $1 WHERE id = $2`, [hash, registro.usuario_id]);
  await pool.query('DELETE FROM tokens_senha WHERE token = $1', [token]);

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
  try {
    await email.enviarMensagemContato(req.body);
    await pool.query('UPDATE mensagens_contato SET email_enviado = true WHERE id = $1', [rows[0].id]);
  } catch (err) {
    // A mensagem já está gravada (id acima) — o aviso por e-mail é só um
    // extra pra quem olha a caixa de entrada primeiro. Quem escreveu não
    // fica sabendo que o SMTP falhou, porque do lado dele nada falhou.
    console.error('mensagem de contato gravada, mas aviso por e-mail falhou (id ' + rows[0].id + ')', err);
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
