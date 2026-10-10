const pool = require('../db/pool');
const { planoVigenteId } = require('./repository');
const { acessoDoPainel } = require('./acesso-painel');
const basicoRepo = require('../pontos/basico');

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
//
// Peça em "Correção necessária" (migration 121) não conta como enviada — a
// vaga está ocupada, mas o passo é do cliente: revisar e reenviar a mesma
// peça (não mandar outra). `correcao` troca o botão do painel.
function detalheDoCriativo({ criativosEnviados, criativosAprovados, criativosRecusados, criativosEmCorrecao }) {
  if (criativosEnviados > 0 && criativosAprovados === 0) return 'Em análise pela Mostraí';
  if (criativosEnviados === 0 && criativosEmCorrecao > 0)
    return 'A Mostraí pediu uma correção: revise e reenvie a peça';
  // Recusado não conta como enviado: nunca vai ao ar, então o passo
  // continua sendo mandar uma peça que sirva (revisão Codex do PR #77).
  if (criativosEnviados === 0 && criativosRecusados > 0) return 'Seu criativo foi recusado: envie uma nova peça';
  return null;
}

function etapasDosPrimeirosPassos({
  temPlano,
  criativosEnviados,
  criativosAprovados,
  criativosRecusados = 0,
  criativosEmCorrecao = 0,
  pontosEscolhidos,
  exibicoes,
  soSaldoHospedagem = false,
}) {
  const etapas = [
    // Só com saldo de hospedagem (migration 113): o direito de veicular já
    // existe — são as horas gratuitas, não um plano a escolher.
    soSaldoHospedagem
      ? { id: 'plano', titulo: 'Suas horas de hospedagem estão disponíveis', feito: true, opcional: false }
      : { id: 'plano', titulo: 'Escolha seu plano', feito: temPlano, opcional: false },
    {
      id: 'criativo',
      titulo: 'Envie seu criativo',
      feito: criativosEnviados > 0,
      opcional: false,
      detalhe: detalheDoCriativo({ criativosEnviados, criativosAprovados, criativosRecusados, criativosEmCorrecao }),
      correcao: criativosEnviados === 0 && criativosEmCorrecao > 0,
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
  // Só com saldo de hospedagem não há pontos a escolher: as horas valem na
  // rede inteira (e o servidor recusa a escolha sem plano).
  if (soSaldoHospedagem)
    etapas.splice(
      etapas.findIndex((e) => e.id === 'pontos'),
      1,
    );
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

// Dono de ponto da rede sem plano comercial (01/10/2026): o caminho dele não
// começa por "Escolha seu plano" — o direito de veicular vem do Plano Básico
// do ponto, que nasce com a tela instalada (src/pontos/basico.js). Nenhuma
// etapa é marcada sem o estado real: "Plano Básico ativo" só com o Básico
// ativo de verdade, e o criativo só fica disponível a partir daí (é o que o
// servidor aceita — POST /anunciantes/:id/criativos). Plano comercial segue
// opcional, pela página Planos.
function etapasDoDonoDePonto({
  telaInstalada,
  primeiroSinal,
  basicoAtivo,
  horasBasico,
  criativosEnviados,
  criativosAprovados,
  criativosRecusados = 0,
  criativosEmCorrecao = 0,
  exibicoes,
}) {
  const etapas = [
    { id: 'ponto', titulo: 'Ponto aprovado', feito: true },
    {
      id: 'instalacao',
      titulo: 'Instalação da tela',
      feito: telaInstalada,
      detalhe: telaInstalada ? null : 'A equipe Mostraí combina a visita com você',
    },
    {
      id: 'sinal',
      titulo: 'Primeiro sinal da tela',
      feito: primeiroSinal,
      detalhe: primeiroSinal ? null : 'A tela se conecta sozinha depois de instalada',
    },
    {
      id: 'basico',
      titulo: 'Plano Básico ativo',
      feito: basicoAtivo,
      detalhe: basicoAtivo ? null : `${horasBasico} h/mês no seu ponto, sem custo — começa com a tela instalada`,
    },
    {
      id: 'criativo',
      titulo: 'Envie seu criativo',
      feito: criativosEnviados > 0,
      detalhe:
        detalheDoCriativo({ criativosEnviados, criativosAprovados, criativosRecusados, criativosEmCorrecao }) ??
        (!basicoAtivo ? 'Disponível quando o Plano Básico ativar' : null),
      correcao: criativosEnviados === 0 && criativosEmCorrecao > 0,
    },
    { id: 'exibicoes', titulo: 'Acompanhe suas exibições', feito: exibicoes > 0 },
  ];
  for (const e of etapas) {
    e.opcional = false;
    // O que a própria pessoa faz só abre com o direito de veicular.
    e.disponivel = e.id === 'criativo' || e.id === 'exibicoes' ? basicoAtivo : true;
  }
  const proxima = etapas.find((e) => !e.feito) || null;
  return {
    fluxo: 'ponto',
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
              COUNT(*) FILTER (WHERE status = 'reprovado')::int AS recusados,
              COUNT(*) FILTER (WHERE status = 'correcao')::int AS em_correcao
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
  const basicos = await basicoRepo.ativosDaConta(conta.id);
  const acesso = await acessoDoPainel(conta, { basicos });
  const comuns = {
    criativosEnviados: criativos.rows[0].enviados,
    criativosAprovados: criativos.rows[0].aprovados,
    criativosRecusados: criativos.rows[0].recusados,
    criativosEmCorrecao: criativos.rows[0].em_correcao,
    exibicoes: exibicoes.rows[0].n,
  };
  // Sem plano comercial em vigor e dono de ponto da rede: o fluxo do ponto
  // (com ou sem o Básico já ativo). Com plano, o fluxo de anunciante de
  // sempre — o Básico soma, não muda o caminho.
  if (!planoVigenteId(conta) && acesso.donoDePonto) {
    return {
      ...etapasDoDonoDePonto({
        ...comuns,
        telaInstalada: acesso.pontos.telaInstalada,
        primeiroSinal: acesso.pontos.primeiroSinal,
        basicoAtivo: basicos.length > 0,
        horasBasico: acesso.basico.horasPorMes,
      }),
      jaTevePlano: passado.rows[0].ja,
    };
  }
  return {
    fluxo: 'anunciante',
    ...etapasDosPrimeirosPassos({
      // O Básico do ponto (migration 103) e o saldo de hospedagem (113)
      // também são direito de veicular.
      temPlano: !!planoVigenteId(conta) || basicos.length > 0 || acesso.hospedagem.saldoSegundos > 0,
      soSaldoHospedagem: !planoVigenteId(conta) && !basicos.length && acesso.hospedagem.saldoSegundos > 0,
      ...comuns,
      pontosEscolhidos: escolhidos.rows[0].n,
    }),
    jaTevePlano: passado.rows[0].ja,
  };
}

module.exports = { etapasDosPrimeirosPassos, etapasDoDonoDePonto, primeirosPassosDaConta };
