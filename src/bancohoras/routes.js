const express = require('express');
const router = express.Router();
const repo = require('./repository');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');

// Autoatendimento: o anunciante vê o próprio saldo, se tiver — nunca o de
// outra conta. Só as linhas 'ativo' (o que ainda vai voltar em exibição);
// linha 'drenado' já foi entregue. 'aguardando_credito' é histórico da
// válvula que saiu em 25/09/2026 (banco de horas não expira).
//
// Saldo de Veiculação (27/09/2026): a conta é em TEMPO (`segundos`, a
// autoridade). `exibicoesEquivalentes` é derivado — quantas vezes a peça que
// roda HOJE (`duracaoReferencia`) precisa tocar pra devolver esse tempo; muda
// se a peça mudar, o tempo não. `saldo` (exibições) continua no corpo pra
// leitura antiga e é o mesmo número de `exibicoesEquivalentes`.
router.get('/anunciantes/me/banco-horas', exigirAnuncianteLogado, async (req, res) => {
  const minhas = await repo.listarAtivasDoAnunciante(req.session.anuncianteId);
  const segundos = minhas.reduce((soma, l) => soma + (l.segundos_banco - l.segundos_drenados), 0);
  const duracaoReferencia = segundos > 0 ? await repo.duracaoMediaDoAnunciante(req.session.anuncianteId) : 0;
  const exibicoesEquivalentes = segundos > 0 ? Math.ceil(segundos / duracaoReferencia) : 0;
  res.json({
    segundos,
    exibicoesEquivalentes,
    duracaoReferencia,
    saldo: exibicoesEquivalentes,
    linhas: minhas.map((l) => ({
      mesReferencia: l.mes_referencia,
      segundosContratados: l.segundos_obrigacao,
      segundosEntregues: l.segundos_entregues,
      segundosPendentes: l.segundos_banco - l.segundos_drenados,
      segundosCompensados: l.segundos_drenados,
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
