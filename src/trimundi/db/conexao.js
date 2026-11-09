const { Pool, types } = require('pg');
const config = require('../config');

// Conexão com o banco PRÓPRIO da Trimundi — nunca o da Mostraí
// (docs/trimundi/CONSTRAINTS.md). Criada só no primeiro uso: sem
// TRIMUNDI_DATABASE_URL o módulo fica desligado e nada aqui roda.
//
// bigint volta como número (centavos e contagens) só NESTE pool: o parser é
// por pool, então a Mostraí continua recebendo bigint como texto, como sempre.
const tipos = {
  getTypeParser(oid, formato) {
    if (oid === 20) return (v) => (v === null ? null : Number(v));
    return types.getTypeParser(oid, formato);
  },
};

class NaoConfigurada extends Error {
  constructor() {
    super('a Trimundi não está configurada neste ambiente');
    this.naoConfigurada = true;
  }
}

let pool = null;

function obterPool() {
  if (!config.configurada()) throw new NaoConfigurada();
  if (!pool) {
    const url = config.urlDoBanco();
    const local = /localhost|127\.0\.0\.1/.test(url);
    // Mesmas lições da Mostraí (src/db/pool.js): teto de conexões, prazo para
    // pegar conexão (AUD-001) e ouvinte de erro no pool e no cliente (AUD-019).
    pool = new Pool({
      connectionString: url,
      ssl: local ? false : { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 5000,
      types: tipos,
    });
    pool.on('error', (err) => console.error('trimundi: conexão ociosa caiu, o pool abre outra', err.message));
    pool.on('connect', (cliente) => cliente.on('error', (err) => console.error('trimundi: conexão caiu', err.message)));
  }
  return pool;
}

function consultar(sql, params) {
  return obterPool().query(sql, params);
}

// Tudo que precisa ser atômico passa por aqui: lê e escreve pelo MESMO
// cliente da transação (nunca pelo pool no meio — AUD-001 da Mostraí).
async function emTransacao(fn) {
  const cliente = await obterPool().connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

async function encerrar() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = { obterPool, consultar, emTransacao, encerrar, NaoConfigurada };
