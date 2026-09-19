const express = require('express');
const router = express.Router();
const repo = require('./repository');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const { LIMIAR_DESTAQUE, LIMIAR_MAXIMO, tierElegivel } = require('./regras');

// Autoatendimento: o dono de ponto vê o próprio cupom e progresso, nunca de
// outra conta. Sem papel `ponto`, não tem cupom (montado só em
// liberarPapelNaConta / criarPontoDaCandidatura) — devolve tudo zerado em
// vez de 404, pra tela poder mostrar "convide comerciantes pro seu cupom"
// só depois de virar ponto, sem precisar de dois estados de erro.
router.get('/anunciantes/me/indicacoes', exigirAnuncianteLogado, async (req, res) => {
  const cupom = await repo.buscarCupomPorConta(req.session.anuncianteId);
  if (!cupom) return res.json({ codigo: null, creditos: 0, proximoTier: null, faltam: null });

  const creditos = await repo.contarCreditos(req.session.anuncianteId);
  const tierGanho = tierElegivel(creditos);
  // Já bateu no Máximo não tem "próximo" — é o tier mais alto que existe.
  const proximoTier = tierGanho === 'maximo' ? null : tierGanho === 'destaque' ? 'maximo' : 'destaque';
  const limiarProximo = proximoTier === 'maximo' ? LIMIAR_MAXIMO : proximoTier === 'destaque' ? LIMIAR_DESTAQUE : null;
  res.json({
    codigo: cupom.codigo,
    creditos,
    tierGanho,
    proximoTier,
    faltam: limiarProximo != null ? Math.max(0, limiarProximo - creditos) : null,
  });
});

module.exports = router;
