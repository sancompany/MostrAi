const express = require('express');
const router = express.Router();
const repo = require('./repository');
const { limiteTentativas } = require('../lib/limite-tentativas');

// Público. Substitui o cadastro aberto de ponto e de vendedor.
router.post('/candidaturas', limiteTentativas, async (req, res) => {
  const { tipo, nome, contato_telefone } = req.body;
  if (!repo.TIPOS.includes(tipo)) return res.status(400).json({ erro: 'tipo inválido' });
  if (!nome || !contato_telefone) return res.status(400).json({ erro: 'nome e WhatsApp são obrigatórios' });
  if (tipo === 'ponto' && (!req.body.nome_comercio || !req.body.endereco)) {
    return res.status(400).json({ erro: 'nome do comércio e endereço são obrigatórios' });
  }
  const candidatura = await repo.criar(req.body);
  res.status(201).json({ ok: true, id: candidatura.id });
});

// Admin
router.get('/admin/candidaturas', async (_req, res) => res.json(await repo.listar()));

router.patch('/admin/candidaturas/:id', async (req, res) => {
  if (req.body.status && !repo.STATUS.includes(req.body.status)) return res.status(400).json({ erro: 'status inválido' });
  const c = await repo.atualizar(req.params.id, req.body);
  if (!c) return res.status(404).json({ erro: 'candidatura não encontrada' });
  res.json(c);
});

module.exports = router;
