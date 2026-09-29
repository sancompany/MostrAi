const express = require('express');
const router = express.Router();
const indicacoesRepo = require('./repository');
const anunciantesRepo = require('../anunciantes/repository');
const pontosRepo = require('../pontos/repository');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const { gerarSvg } = require('../midias/qr-institucional');

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

// A mesma porta do card de créditos (indicacoes/repository.js
// #cupomDoIndicador): ponto da rede, nunca a conta própria. A conta e o
// cupom, ou null.
async function indicadorDaSessao(req) {
  const contaId = req.session.anuncianteId;
  const [conta, ehPonto] = await Promise.all([anunciantesRepo.buscarPorId(contaId), pontosRepo.contaEhPonto(contaId)]);
  const cupom = await indicacoesRepo.cupomDoIndicador(conta, ehPonto);
  return cupom ? { conta, codigo: cupom.codigo } : null;
}

// GET /anunciantes/me/indicacoes — o histórico do card "Indicações": quem se
// cadastrou pelo link, o que cada conta já pagou (em número de pagamentos) e
// os créditos que rendeu, com o resumo somado das MESMAS linhas (nada de
// contador à parte). Campos em indicacoes/repository.js#historicoDeIndicados.
router.get('/anunciantes/me/indicacoes', exigirAnuncianteLogado, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const indicador = await indicadorDaSessao(req);
  if (!indicador) return res.status(404).json({ erro: 'indicação é só para pontos da rede' });
  const indicados = await indicacoesRepo.historicoDeIndicados(indicador.codigo, indicador.conta.id);
  res.json({
    codigo: indicador.codigo,
    link: indicacoesRepo.linkDeIndicacao(indicador.codigo),
    nome: indicador.conta.nome_empresa,
    resumo: {
      contas: indicados.length,
      contrataram: indicados.filter((i) => i.pagamentos > 0).length,
      creditos: indicados.reduce((soma, i) => soma + i.creditos, 0),
    },
    indicados,
  });
});

// GET /anunciantes/me/indicacoes/qr.svg?c=<cupom> — o QR Code do link de
// indicação, pelo mesmo gerador do QR institucional (`gerarSvg`: biblioteca
// `qrcode`, correção Q, zona de silêncio de 4 módulos, escuro sobre branco,
// guardado em memória por link). Codifica SÓ o link público de cadastro com o
// cupom — nenhum id, sessão, token ou dado da conta; nenhum serviço externo
// recebe o link. Com `?c=` igual ao cupom da sessão, o navegador guarda a
// imagem por um dia (o endereço muda se o cupom mudar, e outra conta no
// mesmo navegador pede outro endereço); sem ele, não guarda.
router.get('/anunciantes/me/indicacoes/qr.svg', exigirAnuncianteLogado, async (req, res) => {
  const indicador = await indicadorDaSessao(req);
  if (!indicador) return res.status(404).json({ erro: 'indicação é só para pontos da rede' });
  const link = indicacoesRepo.linkDeIndicacao(indicador.codigo);
  if (!link) return res.status(503).json({ erro: 'endereço do site não configurado' });
  const svg = await gerarSvg(link);
  res.set('Cache-Control', req.query.c === indicador.codigo ? 'private, max-age=86400' : 'private, no-store');
  res.type('image/svg+xml').send(svg);
});

module.exports = router;
