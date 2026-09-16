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

module.exports = router;
