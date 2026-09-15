const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// Regra única de senha, usada por todo cadastro e pela redefinição.
const REGRA = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const MENSAGEM = 'a senha precisa ter no mínimo 8 caracteres, com maiúscula, minúscula, número e símbolo';

// Devolve a mensagem de erro, ou null se a senha serve.
function conferirSenha(senha) {
  return REGRA.test(String(senha || '')) ? null : MENSAGEM;
}

// Hash de senha com scrypt da biblioteca padrão (Lei 3: Argon2id > scrypt >
// bcrypt-só-legado). Parâmetros no piso da lei — N=2^17, r=8, p=1 — e as
// quatro obrigações de fazer à mão: salt aleatório por senha, parâmetros
// guardados junto do hash (pra poder migrar depois), comparação em tempo
// constante, e SEMPRE assíncrono (a versão síncrona seguraria o event loop
// por quase um segundo em toda requisição em voo).
//
// Custo assumido (CONSTRAINTS.md): ~128 MiB por hash em andamento. Com
// dezenas de contas isso é irrelevante; o maxmem abaixo é o que impede o
// Node de recusar a chamada com o padrão de 32 MiB.
const N = 2 ** 17;
const R = 8;
const P = 1;
const TAMANHO = 64;
const MAXMEM = 256 * 1024 * 1024;

async function gerarHash(senha) {
  const salt = crypto.randomBytes(16);
  const derivada = await scrypt(String(senha), salt, TAMANHO, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derivada.toString('base64')}`;
}

// Lê hash scrypt (formato acima) e, em transição, bcrypt (começa com $2).
// Devolve { ok, precisaMigrar } — quem chama regrava com gerarHash quando
// precisaMigrar for true, e o bcrypt some do banco no ritmo dos logins.
async function conferirHash(senha, hash) {
  if (!hash) return { ok: false, precisaMigrar: false };
  if (hash.startsWith('scrypt$')) {
    const [, n, r, p, saltB64, hashB64] = hash.split('$');
    const esperado = Buffer.from(hashB64, 'base64');
    const derivada = await scrypt(String(senha), Buffer.from(saltB64, 'base64'), esperado.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    });
    const ok = derivada.length === esperado.length && crypto.timingSafeEqual(derivada, esperado);
    // Parâmetro abaixo do atual também pede regravação.
    return { ok, precisaMigrar: ok && Number(n) < N };
  }
  if (hash.startsWith('$2')) {
    const bcrypt = require('bcrypt');
    const ok = await bcrypt.compare(String(senha), hash);
    return { ok, precisaMigrar: ok };
  }
  return { ok: false, precisaMigrar: false };
}

module.exports = { conferirSenha, gerarHash, conferirHash, REGRA, MENSAGEM };
