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
//   · podeVeicular — a conta tem direito de veicular AGORA: plano vigente ou
//     Básico ativo. Nada aqui muda essa régua (criativo, playlist e escolha
//     de pontos continuam pedindo isso no servidor).
//
// O Básico do ponto só nasce com tela instalada (src/pontos/basico.js); até
// lá o painel diz "aguardando", nunca "ativo".

// Status do ponto que representam um estabelecimento que JÁ é da rede
// (src/pontos/repository.js#STATUS). `arquivado` fica de fora.
const STATUS_DE_PONTO_DA_REDE = ['a_instalar', 'aguardando_primeiro_sinal', 'em_operacao', 'em_reparo', 'inativo'];

async function situacaoDosPontos(contaId, db = pool) {
  const { rows } = await db.query(
    `SELECT p.status,
            EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = p.id
                      AND d.status IN ('ativo', 'reparo') AND d.chave_hash IS NOT NULL) AS tela_instalada,
            EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = p.id
                      AND d.primeiro_sinal_em IS NOT NULL) AS primeiro_sinal
       FROM pontos p
      WHERE p.anunciante_id = $1 AND p.status = ANY($2::text[])`,
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
  };
}

// `basicos` opcional: quem já leu os Básicos ativos da conta passa (evita a
// mesma consulta duas vezes no GET /anunciantes/me).
async function acessoDoPainel(conta, { basicos = null, db = pool } = {}) {
  const ativos = basicos ?? (await basicoRepo.ativosDaConta(conta.id));
  const pontos = await situacaoDosPontos(conta.id, db);
  const temPlano = !!conta.plano_id;
  const motivo = temPlano ? 'plano' : ativos.length ? 'basico' : pontos.total ? 'ponto' : null;
  // Dono de ponto sem Básico ainda: em que pé está a ativação (a régua de
  // ativação é a tela instalada — src/pontos/basico.js).
  const basicoAguardando = !ativos.length && pontos.total ? (pontos.telaInstalada ? 'ativacao' : 'instalacao') : null;
  return {
    completo: !!motivo,
    motivo,
    podeVeicular: !!planoVigenteId(conta) || ativos.length > 0,
    donoDePonto: pontos.total > 0,
    pontos,
    basico: {
      ativo: ativos.length > 0,
      aguardando: basicoAguardando,
      horasPorMes: basicoRepo.BASICO.horasPorMes,
      duracaoMaximaSegundos: basicoRepo.BASICO.duracaoMaximaSegundos,
    },
  };
}

module.exports = { acessoDoPainel, situacaoDosPontos, STATUS_DE_PONTO_DA_REDE };
