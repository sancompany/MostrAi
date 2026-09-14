const express = require('express');
const router = express.Router();
const repo = require('./repository');
const eventos = require('../lib/eventos');
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
  const antes = await repo.buscarPorId(req.params.id);
  const c = await repo.atualizar(req.params.id, req.body);
  if (!c) return res.status(404).json({ erro: 'candidatura não encontrada' });

  if (c.status === 'aprovada' && antes && antes.status !== 'aprovada') {
    eventos.registrar('ponto:candidatura_aprova', {
      tipo: c.tipo,
      cidade: c.cidade,
      uf: c.uf,
      ramo: c.segmento,
      dias_ate_aprovar: eventos.diasEntre(c.criado_em),
    });
  }
  res.json(c);
});

module.exports = router;
