const pool = require('../db/pool');
const { planoVigenteId } = require('./repository');
const basicoRepo = require('../pontos/basico');

// ACESSO AO PAINEL ≠ DIREITO DE VEICULAR (01/10/2026, correção pedida pelo
// dono). Antes o painel inteiro ficava atrás de "plano OU Básico ativo" — e o
// dono de um ponto já aprovado, com a tela aguardando instalação, caía no
// "Comece sua primeira campanha / Escolha seu plano", como se precisasse
// comprar um plano pra usar a própria conta.
//
// Duas perguntas, duas respostas:
//   · completo — a conta vê o painel inteiro: tem plano (pago ou benefício),
//     Básico ativo, OU já é dona de um ponto materializado na rede (qualquer
//     status menos `arquivado`; candidatura em análise não conta — ainda não
//     é ponto).
//   · podeVeicular — a conta tem direito de veicular AGORA: plano vigente,
//     Básico ativo ou SALDO DE HOSPEDAGEM disponível (migration 113: horas
//     gratuitas de quem hospedou um ponto móvel — direito de veiculação não
//     é plano). Nada aqui muda essa régua (criativo, playlist e escolha de
//     pontos continuam pedindo isso no servidor).
//
// Anfitrião de ponto móvel (hospedagem programada, ativa ou já encerrada)
// também vê o painel inteiro: é lá que acompanha a hospedagem e o saldo.
//
// O Básico do ponto só nasce com tela instalada (src/pontos/basico.js); até
// lá o painel diz "aguardando", nunca "ativo".

// Status do ponto que representam um estabelecimento que JÁ é da rede
// (src/pontos/repository.js#STATUS). `arquivado` fica de fora.
const STATUS_DE_PONTO_DA_REDE = ['a_instalar', 'aguardando_primeiro_sinal', 'em_operacao', 'em_reparo', 'inativo'];

async function situacaoDosPontos(contaId, db = pool) {
  const { rows } = await db.query(
    `SELECT p.id, p.nome, p.status,
            EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = p.id
                      AND d.status IN ('ativo', 'reparo') AND d.chave_hash IS NOT NULL) AS tela_instalada,
            EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = p.id
                      AND d.primeiro_sinal_em IS NOT NULL) AS primeiro_sinal
       FROM pontos p
      WHERE p.anunciante_id = $1 AND p.status = ANY($2::text[])
      ORDER BY p.id`,
    [contaId, STATUS_DE_PONTO_DA_REDE],
  );
  const porStatus = {};
  for (const r of rows) porStatus[r.status] = (porStatus[r.status] || 0) + 1;
  return {
    total: rows.length,
    porStatus,
    emOperacao: porStatus.em_operacao || 0,
    telaInstalada: rows.some((r) => r.tela_instalada),
    primeiroSinal: rows.some((r) => r.primeiro_sinal),
    lista: rows.map((r) => ({ id: Number(r.id), nome: r.nome, telaInstalada: r.tela_instalada })),
  };
}

// `basicos` opcional: quem já leu os Básicos ativos da conta passa (evita a
// mesma consulta duas vezes no GET /anunciantes/me).
async function hospedagemDaConta(contaId, db = pool) {
  const hospedagem = require('../pontos/hospedagem');
  const [saldo, { rows }] = await Promise.all([
    hospedagem.saldoDaConta(contaId, db),
    db.query(
      `SELECT EXISTS (SELECT 1 FROM pontos_moveis_hospedagens
                       WHERE conta_id = $1 AND estado IN ('programada', 'ativa', 'encerrada')) AS anfitria`,
      [contaId],
    ),
  ]);
  return { saldoSegundos: saldo.disponivelSegundos, anfitria: rows[0].anfitria };
}

async function acessoDoPainel(conta, { basicos = null, db = pool } = {}) {
  const ativos = basicos ?? (await basicoRepo.ativosDaConta(conta.id));
  const [pontos, hosp] = await Promise.all([situacaoDosPontos(conta.id, db), hospedagemDaConta(conta.id, db)]);
  const temPlano = !!conta.plano_id;
  const comSaldo = hosp.saldoSegundos > 0;
  const motivo = temPlano
    ? 'plano'
    : ativos.length
      ? 'basico'
      : pontos.total
        ? 'ponto'
        : comSaldo || hosp.anfitria
          ? 'hospedagem'
          : null;
  // Dono de ponto sem Básico ainda: em que pé está a ativação (a régua de
  // ativação é a tela instalada — src/pontos/basico.js).
  const basicoAguardando = !ativos.length && pontos.total ? (pontos.telaInstalada ? 'ativacao' : 'instalacao') : null;
  // Um Básico por ponto: cada ponto da rede sem o seu ativo aparece com o
  // próprio estado — com vários pontos, um já ativo não esconde os outros.
  const comBasico = new Set(ativos.map((b) => Number(b.ponto_id)));
  const pendentes = pontos.lista
    .filter((p) => !comBasico.has(p.id))
    .map((p) => ({ pontoId: p.id, pontoNome: p.nome, aguardando: p.telaInstalada ? 'ativacao' : 'instalacao' }));
  const { lista, ...resumoDosPontos } = pontos;
  return {
    completo: !!motivo,
    motivo,
    podeVeicular: !!planoVigenteId(conta) || ativos.length > 0 || comSaldo,
    donoDePonto: pontos.total > 0,
    hospedagem: { saldoSegundos: hosp.saldoSegundos, anfitria: hosp.anfitria },
    pontos: resumoDosPontos,
    basico: {
      ativo: ativos.length > 0,
      aguardando: basicoAguardando,
      pendentes,
      horasPorMes: basicoRepo.BASICO.horasPorMes,
      duracaoMaximaSegundos: basicoRepo.BASICO.duracaoMaximaSegundos,
    },
  };
}

// DIREITO ATIVO DE VEICULAÇÃO — a régua ÚNICA de quem pode manifestar
// interesse em hospedar um Ponto Móvel (V1.1, 05/10/2026, pedido do dono).
// Vale: plano vigente — pago, benefício de mídia ou benefício por créditos
// (os três gravam `plano_id` com a validade, src/financeiro/
// plano-administrativo.js) —, Plano Básico ativo, ou saldo de hospedagem
// utilizável. Não vale: só cadastro, plano vencido, conta suspensa ou
// excluída, a conta própria da Mostraí. Nunca cria plano nenhum: só lê.
// `origem` diz de onde veio o direito (o Admin vê junto do interesse).
async function possuiDireitoAtivoDeVeiculacao(conta, { db = pool, agora = new Date() } = {}) {
  if (!conta || conta.excluido_em) return { possui: false, motivo: 'sem_conta' };
  if (conta.suspenso) return { possui: false, motivo: 'suspensa' };
  if (conta.conta_propria) return { possui: false, motivo: 'conta_propria' };
  if (planoVigenteId(conta, agora)) {
    return { possui: true, origem: conta.plano_cortesia ? 'beneficio' : 'plano', validoAte: conta.data_expiracao };
  }
  const ativos = await basicoRepo.ativosDaConta(conta.id, db);
  if (ativos.length) return { possui: true, origem: 'basico' };
  const { saldoSegundos } = await hospedagemDaConta(conta.id, db);
  if (saldoSegundos > 0) return { possui: true, origem: 'saldo_hospedagem', saldoSegundos };
  return { possui: false, motivo: conta.plano_id ? 'plano_vencido' : 'sem_direito' };
}

module.exports = { acessoDoPainel, situacaoDosPontos, STATUS_DE_PONTO_DA_REDE, possuiDireitoAtivoDeVeiculacao };
