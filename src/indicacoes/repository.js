const pool = require('../db/pool');

// Cupom de indicação da conta (migration 062): até 6 letras do nome (sem
// acento) + 3 dígitos, prefixado com "PT-". O prefixo veio da época em que
// existia cupom de vendedor (só letras e dígitos, tabela UNIQUE separada) —
// o programa foi aposentado, mas o formato fica: cupons já impressos e
// gravados em `anunciantes.indicado_por_cupom` continuam válidos. Cada
// pagamento de quem usou o cupom vira crédito no ledger (src/creditos).
function gerarCupomPonto(nome) {
  const slug =
    String(nome || 'ponto')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z]/g, '')
      .toUpperCase()
      .slice(0, 6) || 'PONTO';
  return `PT-${slug}${Math.floor(100 + Math.random() * 900)}`;
}

// Precisa de transação (usa SAVEPOINT): um 23505 por colisão de código
// abortaria a transação inteira sem o SAVEPOINT em volta de cada tentativa.
async function criarCupom(contaId, nome, db = pool) {
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

// Toda conta indica — não só quem tem ponto (o cupom nascia só junto do
// ponto). Cria na primeira vez que a conta abre "Créditos e benefícios".
// Duas abas abrindo juntas: a trava por conta serializa, e a segunda só lê.
async function garantirCupom(contaId, nome) {
  const existente = await buscarCupomPorConta(contaId);
  if (existente) return existente;
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cupom:${contaId}`]);
    const ja = await buscarCupomPorConta(contaId, cliente);
    const cupom = ja || (await criarCupom(contaId, nome, cliente));
    await cliente.query('COMMIT');
    return cupom;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

async function buscarPontoPorCupom(codigo) {
  const { rows } = await pool.query(
    `SELECT cp.*, a.nome_empresa AS nome FROM cupons_ponto cp JOIN anunciantes a ON a.id = cp.conta_id
     WHERE cp.codigo = $1 AND a.excluido_em IS NULL`,
    [codigo],
  );
  return rows[0] || null;
}

// Atividade das indicações em número, nunca em pessoa: quantas contas se
// cadastraram com o código e quantas já pagaram. Nome, e-mail ou documento
// de quem foi indicado não saem daqui.
async function resumoIndicacoes(codigo) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cadastradas,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM cobrancas_confirmadas cc WHERE cc.anunciante_id = a.id))::int AS pagantes
       FROM anunciantes a
      WHERE a.indicado_por_cupom = $1 AND a.excluido_em IS NULL`,
    [codigo],
  );
  return rows[0];
}

module.exports = {
  criarCupom,
  garantirCupom,
  buscarCupomPorConta,
  buscarPontoPorCupom,
  resumoIndicacoes,
};
