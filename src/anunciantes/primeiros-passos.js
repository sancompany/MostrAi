const pool = require('../db/pool');
const { planoVigenteId } = require('./repository');

// Primeiros passos do painel (estação da conta, 26/09/2026): o onboarding é o
// estado REAL da conta, lido do banco, nunca uma caixa marcada à mão.
//
// A ordem é a do fluxo que o sistema aplica: criativo e escolha de pontos
// exigem plano (o servidor recusa antes disso — POST /anunciantes/:id/
// criativos e /pontos-disponiveis). Escolher pontos é OPCIONAL (sem escolha,
// a Mostraí distribui) — por isso nunca segura o passo seguinte. Vale também
// pro benefício por créditos desde 27/09/2026: o servidor sempre aceitou a
// escolha dele, só o painel é que escondia a lista (e com ela o próprio
// ponto de quem é dono de comércio). "Acompanhe suas exibições" se completa
// sozinho, na primeira exibição confirmada por uma tela.
function etapasDosPrimeirosPassos({
  temPlano,
  criativosEnviados,
  criativosAprovados,
  criativosRecusados = 0,
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
      // Recusado não conta como enviado: nunca vai ao ar, então o passo
      // continua sendo mandar uma peça que sirva (revisão Codex do PR #77).
      detalhe:
        criativosEnviados > 0 && criativosAprovados === 0
          ? 'Em análise pela Mostraí'
          : criativosEnviados === 0 && criativosRecusados > 0
            ? 'Seu criativo foi recusado: envie uma nova peça'
            : null,
    },
    {
      id: 'pontos',
      titulo: 'Escolha os pontos',
      feito: pontosEscolhidos > 0,
      opcional: true,
      detalhe: 'Sem escolha, a Mostraí distribui seu anúncio',
    },
    { id: 'exibicoes', titulo: 'Acompanhe suas exibições', feito: exibicoes > 0, opcional: false },
  ];
  // Disponível = o sistema já deixa fazer agora. Sem plano, só o plano.
  for (const e of etapas) e.disponivel = e.id === 'plano' || temPlano;
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
      `SELECT COUNT(*) FILTER (WHERE status IN ('pendente', 'aprovado'))::int AS enviados,
              COUNT(*) FILTER (WHERE status = 'aprovado')::int AS aprovados,
              COUNT(*) FILTER (WHERE status = 'reprovado')::int AS recusados
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
      criativosEnviados: criativos.rows[0].enviados,
      criativosAprovados: criativos.rows[0].aprovados,
      criativosRecusados: criativos.rows[0].recusados,
      pontosEscolhidos: escolhidos.rows[0].n,
      exibicoes: exibicoes.rows[0].n,
    }),
    jaTevePlano: passado.rows[0].ja,
  };
}

module.exports = { etapasDosPrimeirosPassos, primeirosPassosDaConta };
