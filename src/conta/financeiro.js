// Financeiro da conta — módulo do painel único (Fatia 4, 23/09/2026). Os dois
// sentidos do dinheiro numa resposta só, porque a mesma conta pode anunciar
// (paga a Mostraí) e ceder a parede (recebe a ajuda de custo do comodato):
//   pagamentos   — plano comercial e cobranças confirmadas;
//   recebimentos — o extrato do comodato e a troca da ajuda de custo por tela.
// Antes: "Meus pagamentos" no fim do painel e "Meus recebimentos" + a troca
// numa página separada do ponto. Cada bloco só aparece quando tem assunto.
const express = require('express');
const pool = require('../db/pool');
const anunciantesRepo = require('../anunciantes/repository');
const pagamentosRepo = require('../pontos/pagamentos-repository');
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
  const [cobrancas, plano, linhas, pontos] = await Promise.all([
    pool.query(
      'SELECT id, valor, criado_em FROM cobrancas_confirmadas WHERE anunciante_id = $1 ORDER BY criado_em DESC LIMIT 36',
      [conta.id],
    ),
    conta.plano_id ? pool.query('SELECT nome FROM planos WHERE id = $1', [conta.plano_id]) : null,
    pagamentosRepo.extratoDaConta(conta.id),
    // O valor CONTRATADO de cada ponto (`pontos.valor_pago_mensal`, copiado da
    // modalidade no dia da aprovação — migration 015), não o preço atual da
    // modalidade: o admin pode reajustar a modalidade depois, e o contrato de
    // quem já é ponto não muda com isso.
    pool.query(
      `SELECT id, nome, valor_pago_mensal FROM pontos
        WHERE anunciante_id = $1 AND status <> 'arquivado'`,
      [conta.id],
    ),
  ]);
  const recebendo = pontos.rows.filter((p) => Number(p.valor_pago_mensal || 0) > 0);
  const ajudaMensal = recebendo.reduce((s, p) => s + Number(p.valor_pago_mensal), 0);
  res.json({
    pagamentos: {
      mostrar: !!conta.plano_id || cobrancas.rows.length > 0,
      plano: {
        nome: plano?.rows[0]?.nome || null,
        situacao: situacaoDoPlano(conta),
        validoAte: conta.data_expiracao,
      },
      cobrancas: cobrancas.rows.map((c) => ({ id: c.id, data: c.criado_em, valor: Number(c.valor) })),
    },
    recebimentos: {
      mostrar: recebendo.length > 0 || linhas.length > 0,
      ajudaMensal,
      resumo: pagamentosRepo.resumir(linhas),
      // Sem `observacao`: é anotação interna de quem lançou o pagamento.
      linhas: linhas.map((l) => ({
        id: l.id,
        competencia: l.competencia,
        ponto: l.ponto_nome,
        valor: Number(l.valor),
        pagoEm: l.pago_em,
        forma: l.forma,
      })),
      // A troca é mão única (POST /anunciantes/me/comodato/trocar-por-tela):
      // só existe enquanto algum ponto ainda recebe em dinheiro.
      troca: recebendo.length ? { totalMensal: ajudaMensal, pontos: recebendo.length } : null,
    },
  });
});

module.exports = router;
