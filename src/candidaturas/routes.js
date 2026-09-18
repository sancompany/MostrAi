const express = require('express');
const router = express.Router();
const repo = require('./repository');
const eventos = require('../lib/eventos');

// v3 (18/09/2026): candidatura sem conta foi aposentada. Ponto e vendedor não
// têm mais porta de entrada pra quem não tem conta ainda — a conta nasce
// sempre igual (papel `anunciante`, `POST /anunciantes/cadastro`), e quem
// quer um ponto pede de dentro do painel (`POST /conta/modos/ponto/pedir`,
// `src/conta/modos.js`), já logado — o endereço e os outros dados exclusivos
// entram ali, o resto já veio da conta. Vendedor não tem pedido nenhum: o
// card do modo (e o da home) só apontam pro contato direto; quem vira
// vendedor é por convite que o dono gera à mão depois da conversa
// (`POST /admin/convites`, sem candidatura).
router.post('/candidaturas', (_req, res) => {
  res.status(410).json({
    erro:
      'esse formulário saiu do ar — crie sua conta e peça pra ser ponto de dentro do painel, ' +
      'ou fale com a gente pra ser vendedor',
  });
});

// Admin
router.get('/admin/candidaturas', async (_req, res) => res.json(await repo.listar()));

router.patch('/admin/candidaturas/:id', async (req, res) => {
  if (req.body.status && !repo.STATUS.includes(req.body.status))
    return res.status(400).json({ erro: 'status inválido' });
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
