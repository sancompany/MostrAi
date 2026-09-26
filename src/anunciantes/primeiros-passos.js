const pool = require('../db/pool');
const { planoVigenteId } = require('./repository');

// Primeiros passos do painel (estação da conta, 26/09/2026): o onboarding é o
// estado REAL da conta, lido do banco, nunca uma caixa marcada à mão.
//
// A ordem é a do fluxo que o sistema aplica: criativo e escolha de pontos
// exigem plano (o servidor recusa antes disso — POST /anunciantes/:id/
// criativos e /pontos-disponiveis). Escolher pontos é OPCIONAL (sem escolha,
// a Mostraí distribui) e, no benefício por créditos, a escolha não existe
// (o painel já não oferece — painel.page.js#carregarPontos): por isso ela
// nunca segura o passo seguinte. "Acompanhe suas exibições" se completa
// sozinho, na primeira exibição confirmada por uma tela.
function etapasDosPrimeirosPassos({
  temPlano,
  beneficio,
  criativosEnviados,
  criativosAprovados,
  pontosEscolhidos,
  exibicoes,
}) {
  const etapas = [
    { id: 'plano', titulo: 'Escolha seu plano', feito: temPlano, opcional: false },
    {
      id: 'criativo',
      titulo: 'Envie seu criativo',
      feito: criativosEnviados > 0,
      opcional: false,
      detalhe: criativosEnviados > 0 && criativosAprovados === 0 ? 'Em análise pela Mostraí' : null,
    },
    {
      id: 'pontos',
      titulo: 'Escolha os pontos',
      feito: pontosEscolhidos > 0,
      opcional: true,
      detalhe: beneficio
        ? 'No benefício, a Mostraí distribui seu anúncio pelos pontos'
        : 'Sem escolha, a Mostraí distribui seu anúncio',
    },
    { id: 'exibicoes', titulo: 'Acompanhe suas exibições', feito: exibicoes > 0, opcional: false },
  ];
  // Disponível = o sistema já deixa fazer agora. Sem plano, só o plano.
  for (const e of etapas) e.disponivel = e.id === 'plano' || (temPlano && !(e.id === 'pontos' && beneficio));
  const proxima = etapas.find((e) => !e.feito && !e.opcional) || null;
  return {
    etapas,
    proxima: proxima?.id || null,
    numeroDaProxima: proxima ? etapas.indexOf(proxima) + 1 : null,
    total: etapas.length,
    concluido: !proxima,
  };
}

async function primeirosPassosDaConta(conta) {
  const [criativos, escolhidos, exibicoes, passado] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status <> 'retirado')::int AS enviados,
              COUNT(*) FILTER (WHERE status = 'aprovado')::int AS aprovados
         FROM criativos WHERE anunciante_id = $1`,
      [conta.id],
    ),
    pool.query('SELECT COUNT(*)::int AS n FROM anunciantes_pontos WHERE anunciante_id = $1', [conta.id]),
    pool.query(
      'SELECT COALESCE(SUM(vezes_confirmadas), 0)::int AS n FROM exibicoes_contador WHERE anunciante_id = $1',
      [conta.id],
    ),
    // Já teve plano (pago ou benefício) alguma vez: o convite deixa de ser
    // "primeira campanha" e vira "volte a anunciar".
    pool.query(
      `SELECT (EXISTS (SELECT 1 FROM ciclos_contratados WHERE anunciante_id = $1)
            OR EXISTS (SELECT 1 FROM planos_administrativos WHERE anunciante_id = $1)) AS ja`,
      [conta.id],
    ),
  ]);
  return {
    ...etapasDosPrimeirosPassos({
      temPlano: !!planoVigenteId(conta),
      beneficio: !!conta.plano_cortesia,
      criativosEnviados: criativos.rows[0].enviados,
      criativosAprovados: criativos.rows[0].aprovados,
      pontosEscolhidos: escolhidos.rows[0].n,
      exibicoes: exibicoes.rows[0].n,
    }),
    jaTevePlano: passado.rows[0].ja,
  };
}

module.exports = { etapasDosPrimeirosPassos, primeirosPassosDaConta };
