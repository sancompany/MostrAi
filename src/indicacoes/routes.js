const express = require('express');
const router = express.Router();
const repo = require('./repository');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const { LIMIAR_ESSENCIAL, LIMIAR_DESTAQUE, LIMIAR_MAXIMO, tierElegivel } = require('./regras');

// Escada de tiers na ordem em que o crédito de indicação libera cada um —
// mesma ordem de regras.js, só que junto do limiar de cada degrau, pra
// achar "o próximo" andando um índice à frente de `tierGanho` em vez de
// repetir a cadeia de ternários (o que já tinha ficado errado uma vez,
// faltando o degrau do Essencial).
const ESCADA = [
  { tier: 'essencial', limiar: LIMIAR_ESSENCIAL },
  { tier: 'destaque', limiar: LIMIAR_DESTAQUE },
  { tier: 'maximo', limiar: LIMIAR_MAXIMO },
];

// Autoatendimento: o dono de ponto vê o próprio cupom e progresso, nunca de
// outra conta. Sem papel `ponto`, não tem cupom (montado só em
// liberarPapelNaConta / criarPontoDaCandidatura) — devolve tudo zerado em
// vez de 404, pra tela poder mostrar "convide comerciantes pro seu cupom"
// só depois de virar ponto, sem precisar de dois estados de erro.
router.get('/anunciantes/me/indicacoes', exigirAnuncianteLogado, async (req, res) => {
  const cupom = await repo.buscarCupomPorConta(req.session.anuncianteId);
  if (!cupom) return res.json({ codigo: null, creditos: 0, tierGanho: null, proximoTier: null, faltam: null });

  const creditos = await repo.contarCreditos(req.session.anuncianteId);
  const tierGanho = tierElegivel(creditos);
  // Já bateu no Máximo não tem "próximo" — é o tier mais alto que existe.
  const indiceProximo = ESCADA.findIndex((degrau) => degrau.limiar > creditos);
  const proximo = indiceProximo === -1 ? null : ESCADA[indiceProximo];
  res.json({
    codigo: cupom.codigo,
    creditos,
    tierGanho,
    proximoTier: proximo?.tier || null,
    faltam: proximo ? proximo.limiar - creditos : null,
  });
});

module.exports = router;
