const express = require('express');
const router = express.Router();
const indicacoesRepo = require('./repository');

// GET /indicacoes/:codigo — quem está indicando, pra página de cadastro
// dizer "Você foi indicado por: <nome>" antes de a pessoa preencher
// (finalização, 28/09/2026, pedido do dono). Anônima de propósito: quem
// chega pelo link ainda não tem conta. Devolve só o nome do negócio que
// indica — o que o link já carrega no mundo real quando o dono do ponto o
// compartilha; nunca contato, documento ou endereço. Código fora do formato
// do cupom (src/indicacoes/repository.js#gerarCupomPonto) nem chega no
// banco: é 404 como qualquer código que não existe, sem distinguir os dois
// casos pra quem estiver tateando.
const FORMATO_CUPOM = /^PT-[A-Z]{1,6}\d{3}$/;

router.get('/indicacoes/:codigo', async (req, res) => {
  const codigo = String(req.params.codigo || '').toUpperCase();
  const ponto = FORMATO_CUPOM.test(codigo) ? await indicacoesRepo.buscarPontoPorCupom(codigo) : null;
  if (!ponto) return res.status(404).json({ erro: 'esse cupom de indicação não existe ou não está ativo' });
  res.json({ nome: ponto.nome });
});

module.exports = router;
