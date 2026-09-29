const express = require('express');
const QRCode = require('qrcode');
const router = express.Router();
const indicacoesRepo = require('./repository');
const anunciantesRepo = require('../anunciantes/repository');
const pontosRepo = require('../pontos/repository');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const { baseDoSite, OPCOES_QR } = require('../midias/qr-institucional');

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

// O link de indicação, montado num lugar só (painel do usuário, 29/09/2026):
// o texto que o card mostra, o "Copiar link", o WhatsApp e o QR Code saem
// DESTA string — o QR nunca aponta pra outro endereço que o link à vista.
// Só o endereço público de cadastro com o cupom (que já é público: é ele que
// o dono compartilha). Base só do SITE_URL, a mesma régua do QR institucional
// (midias/qr-institucional.js#baseDoSite): sem ele, `null` — um QR com
// endereço relativo não abre em celular nenhum.
function linkDeIndicacao(codigo) {
  const base = baseDoSite();
  return base ? `${base}/anunciante/cadastro.html?ref=${encodeURIComponent(codigo)}` : null;
}

// Mesma porta do card "Indicações" em GET /anunciantes/me/creditos: o
// programa é do PONTO da rede, e a conta própria da Mostraí não indica
// (ADR-020). Devolve a conta e o cupom, ou null.
async function indicadorDaSessao(req) {
  const contaId = req.session.anuncianteId;
  const [conta, ehPonto] = await Promise.all([anunciantesRepo.buscarPorId(contaId), pontosRepo.contaEhPonto(contaId)]);
  if (!conta || !ehPonto || conta.conta_propria) return null;
  const cupom = await indicacoesRepo.garantirCupom(contaId, conta.nome_empresa);
  return { conta, codigo: cupom.codigo };
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
    link: linkDeIndicacao(indicador.codigo),
    nome: indicador.conta.nome_empresa,
    resumo: {
      contas: indicados.length,
      contrataram: indicados.filter((i) => i.pagamentos > 0).length,
      creditos: indicados.reduce((soma, i) => soma + i.creditos, 0),
    },
    indicados,
  });
});

// GET /anunciantes/me/indicacoes/qr.svg — o QR Code do link de indicação,
// gerado aqui (biblioteca `qrcode`, as mesmas opções do QR institucional:
// correção Q, zona de silêncio de 4 módulos, módulo escuro sobre branco).
// Codifica SÓ o link público de cadastro com o cupom — nenhum id, sessão,
// token ou dado da conta. Nenhum serviço externo recebe o link.
router.get('/anunciantes/me/indicacoes/qr.svg', exigirAnuncianteLogado, async (req, res) => {
  const indicador = await indicadorDaSessao(req);
  if (!indicador) return res.status(404).json({ erro: 'indicação é só para pontos da rede' });
  const link = linkDeIndicacao(indicador.codigo);
  if (!link) return res.status(503).json({ erro: 'endereço do site não configurado' });
  const svg = await QRCode.toString(link, { ...OPCOES_QR, type: 'svg' });
  res.set('Cache-Control', 'private, no-store');
  res.type('image/svg+xml').send(svg);
});

module.exports = router;
module.exports.linkDeIndicacao = linkDeIndicacao;
