// Financeiro da conta — módulo do painel único (Fatia 4, 23/09/2026): o
// plano comercial e as cobranças confirmadas — o dinheiro que a conta paga à
// Mostraí.
//
// "Recebimentos" (o extrato da ajuda de custo do comodato e a troca dos R$ 50
// por tela) SAIU em 24/09/2026 (ADR-016): ser ponto não recebe dinheiro,
// gera créditos — que moram em "Créditos e benefícios", não aqui. Os
// repasses antigos continuam em `pagamentos_ponto` (histórico).
const express = require('express');
const pool = require('../db/pool');
const anunciantesRepo = require('../anunciantes/repository');
const { nomeDoCiclo } = require('../lib/ciclos');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');

const router = express.Router();

function situacaoDoPlano(conta) {
  if (!conta.plano_id) return 'sem_plano';
  if (conta.suspenso) return 'suspensa';
  if (conta.plano_cortesia) return 'cortesia';
  if (conta.data_expiracao && new Date(conta.data_expiracao) <= new Date()) return 'vencida';
  return 'ativa';
}

router.get('/anunciantes/me/financeiro', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  const [cobrancas, plano] = await Promise.all([
    pool.query(
      'SELECT id, valor, criado_em FROM cobrancas_confirmadas WHERE anunciante_id = $1 ORDER BY criado_em DESC LIMIT 36',
      [conta.id],
    ),
    conta.plano_id ? pool.query('SELECT nome, compromisso_meses FROM planos WHERE id = $1', [conta.plano_id]) : null,
  ]);
  res.json({
    pagamentos: {
      mostrar: !!conta.plano_id || cobrancas.rows.length > 0,
      plano: {
        // Plano · Ciclo ("Pro · Trimestral"), ADR-018.
        nome: plano?.rows[0] ? `${plano.rows[0].nome} · ${nomeDoCiclo(plano.rows[0].compromisso_meses)}` : null,
        situacao: situacaoDoPlano(conta),
        validoAte: conta.data_expiracao,
      },
      cobrancas: cobrancas.rows.map((c) => ({ id: c.id, data: c.criado_em, valor: Number(c.valor) })),
    },
  });
});

module.exports = router;
