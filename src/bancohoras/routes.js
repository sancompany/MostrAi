const express = require('express');
const router = express.Router();
const repo = require('./repository');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');

// Autoatendimento: o anunciante vê o próprio saldo, se tiver — nunca o de
// outra conta. Só as linhas 'ativo' (o que ainda vai voltar em exibição);
// linha 'drenado' já foi entregue. 'aguardando_credito' é histórico da
// válvula que saiu em 25/09/2026 (banco de horas não expira).
router.get('/anunciantes/me/banco-horas', exigirAnuncianteLogado, async (req, res) => {
  const minhas = await repo.listarAtivasDoAnunciante(req.session.anuncianteId);
  const saldo = minhas.reduce((soma, l) => soma + (l.exibicoes_banco - l.exibicoes_drenadas), 0);
  // `segundos` é só pra virar tempo na tela (pedido do dono, 18/09/2026) —
  // exibições × duração ATUAL da peça, a mesma estimativa sem histórico que
  // já vale em toda esta feature (ver RN-53). Zero saldo não busca duração.
  const duracaoMedia = saldo > 0 ? await repo.duracaoMediaDoAnunciante(req.session.anuncianteId) : 0;
  res.json({
    saldo,
    segundos: saldo * duracaoMedia,
    linhas: minhas.map((l) => ({
      mesReferencia: l.mes_referencia,
      saldo: l.exibicoes_banco - l.exibicoes_drenadas,
    })),
  });
});

// Admin — todas as linhas, mais recente primeiro.
router.get('/admin/banco-horas', async (_req, res) => {
  res.json(await repo.listarTodos());
});

// Admin — fila 'aguardando_credito': HISTÓRICO da válvula de 3 meses, que
// saiu em 25/09/2026 (decisão do dono: banco de horas é obrigação de
// veiculação, sem expiração, nunca crédito em dinheiro). Nenhum código põe
// linha nova aqui; a rota fica só pra resolver alguma linha antiga.
router.get('/admin/banco-horas/aguardando-credito', async (_req, res) => {
  res.json(await repo.listarAguardandoCredito());
});

router.post('/admin/banco-horas/:id/resolver', async (req, res) => {
  const linha = await repo.resolverCredito(req.params.id);
  if (!linha) return res.status(404).json({ erro: 'linha não encontrada ou já resolvida' });
  res.json(linha);
});

module.exports = router;
