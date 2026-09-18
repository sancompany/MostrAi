const express = require('express');
const router = express.Router();
const repo = require('./repository');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');

// Autoatendimento: o anunciante vê o próprio saldo, se tiver — nunca o de
// outra conta. Só as linhas 'ativo' (o que ainda pode virar prioridade);
// linha 'drenado' já foi entregue, e 'aguardando_credito' é conversa que
// só o admin tem com ele fora do sistema.
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

// Admin — fila de quem passou de N meses sem drenar tudo (G.3, a válvula).
// Resolver é ação humana: crédito manual, desconto na próxima fatura, ou
// nada — a rota só registra QUE foi decidido, nunca decide o quê.
router.get('/admin/banco-horas/aguardando-credito', async (_req, res) => {
  res.json(await repo.listarAguardandoCredito());
});

router.post('/admin/banco-horas/:id/resolver', async (req, res) => {
  const linha = await repo.resolverCredito(req.params.id);
  if (!linha) return res.status(404).json({ erro: 'linha não encontrada ou já resolvida' });
  res.json(linha);
});

module.exports = router;
