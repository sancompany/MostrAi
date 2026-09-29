const express = require('express');
const router = express.Router();
const indicacoesRepo = require('./repository');

// GET /indicacoes/:codigo — quem indica, pra página de cadastro mostrar
// "Indicado por: <nome>" antes de a pessoa preencher (29/09/2026, pedido do
// dono). Anônima de propósito: quem chega pelo link ainda não tem conta.
// A régua é `indicadorDoCupom`, a MESMA do POST /anunciantes/cadastro: o nome
// que aparece é o da conta que o cadastro vai associar. Devolve só o nome do
// negócio que indica — o que o link já carrega quando o dono do ponto o
// compartilha; nunca o código, id, contato, documento ou endereço. Cupom
// inexistente, de conta excluída ou fora do formato: 404, sem distinguir.
router.get('/indicacoes/:codigo', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const indicador = await indicacoesRepo.indicadorDoCupom(req.params.codigo);
  if (!indicador) return res.status(404).json({ erro: 'indicação não encontrada' });
  res.json({ nome: indicador.nome });
});

module.exports = router;
