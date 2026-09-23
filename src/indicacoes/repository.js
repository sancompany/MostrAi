const pool = require('../db/pool');
const vendedoresRepo = require('../financeiro/vendedores-repository');

// Cupom do dono de ponto (migration 062). Mesmo algoritmo de gerarCupom()
// (financeiro/vendedores-repository.js), prefixado com "PT-" — gerarCupom()
// só produz letras e dígitos, então o hífen garante que este código nunca
// colide com codigo_cupom de vendedor: são tabelas UNIQUE separadas, e a
// validação no cadastro precisa resolver sem ambiguidade entre as duas.
function gerarCupomPonto(nome) {
  return `PT-${vendedoresRepo.gerarCupom(nome)}`;
}

async function criarCupom(contaId, nome, db = pool) {
  // Mesma retentativa com SAVEPOINT de vendedoresRepo.criar: dentro de uma
  // transação, um 23505 (colisão de código) aborta a transação inteira sem
  // o SAVEPOINT em volta de cada tentativa.
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    try {
      await db.query('SAVEPOINT cupom_ponto');
      const { rows } = await db.query('INSERT INTO cupons_ponto (conta_id, codigo) VALUES ($1,$2) RETURNING *', [
        contaId,
        gerarCupomPonto(nome),
      ]);
      await db.query('RELEASE SAVEPOINT cupom_ponto');
      return rows[0];
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT cupom_ponto').catch(() => {});
      if (err.code !== '23505' || tentativa === 4) throw err;
    }
  }
  return null;
}

async function buscarCupomPorConta(contaId, db = pool) {
  const { rows } = await db.query('SELECT * FROM cupons_ponto WHERE conta_id = $1', [contaId]);
  return rows[0] || null;
}

async function buscarPontoPorCupom(codigo) {
  const { rows } = await pool.query(
    `SELECT cp.*, a.nome_empresa AS nome FROM cupons_ponto cp JOIN anunciantes a ON a.id = cp.conta_id
     WHERE cp.codigo = $1 AND a.excluido_em IS NULL`,
    [codigo],
  );
  return rows[0] || null;
}

// Uma linha por indicado, sempre — o UNIQUE (migration 062) é quem decide se
// conta. Chamar em toda renovação é seguro: só a primeira tentativa gera
// linha, exatamente como registrarDeficit em src/bancohoras/repository.js.
async function registrarCredito(pontoContaId, indicadoContaId, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO indicacoes_pagas (ponto_conta_id, indicado_conta_id) VALUES ($1,$2)
     ON CONFLICT (ponto_conta_id, indicado_conta_id) DO NOTHING RETURNING *`,
    [pontoContaId, indicadoContaId],
  );
  return rows[0] || null;
}

async function contarCreditos(pontoContaId, db = pool) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM indicacoes_pagas WHERE ponto_conta_id = $1', [
    pontoContaId,
  ]);
  return rows[0].n;
}

// Toda conta que já ganhou pelo menos um crédito — usado pela reavaliação
// diária (apuracao.js) pra tentar aplicar upgrades que ficaram pendentes
// porque a conta estava pagando o próprio plano na hora em que o crédito
// entrou (ver aplicar.js). Lista pequena: número de pontos na rede é baixo,
// não precisa de paginação.
async function listarContasComCredito(db = pool) {
  const { rows } = await db.query('SELECT DISTINCT ponto_conta_id FROM indicacoes_pagas');
  return rows.map((r) => r.ponto_conta_id);
}

// O plano ativo de um tier, no ciclo pedido — nunca por id fixo: ids
// carregam sufixo -vN quando o plano é reeditado (proximoId, em
// financeiro/planos-repository.js). Buscar por (tier, compromisso_meses,
// ativo) é o que modalidadeSemDinheiro (src/pontos/comodato.js) já faz,
// pelo mesmo motivo.
// `ORDER BY` (achado na auditoria da reconstrução do painel, 23/09/2026):
// sem ele, `LIMIT 1` não é determinístico se algum dia existir mais de um
// plano ativo pro mesmo tier+ciclo (nada no schema impede isso — um
// `fundador` pode coexistir com um comercial normal do mesmo tier/ciclo).
// Mesma cautela que `financeiro/planos-repository.js#linhaAtualDoProduto`
// já usa pro mesmo risco: nunca um fundador aqui (vagas limitadas, preço
// twisted pra esse caso), e desempate estável por id.
async function buscarPlanoAtivoDoTier(tier, compromissoMeses, db = pool) {
  const { rows } = await db.query(
    'SELECT * FROM planos WHERE tier = $1 AND compromisso_meses = $2 AND ativo AND NOT fundador ORDER BY id LIMIT 1',
    [tier, compromissoMeses],
  );
  return rows[0] || null;
}

module.exports = {
  criarCupom,
  buscarCupomPorConta,
  buscarPontoPorCupom,
  registrarCredito,
  contarCreditos,
  listarContasComCredito,
  buscarPlanoAtivoDoTier,
};
