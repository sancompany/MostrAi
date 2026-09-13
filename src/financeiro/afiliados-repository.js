const bcrypt = require('bcrypt');
const pool = require('../db/pool');

const STATUS = ['pendente_aprovacao', 'aprovado', 'inativo'];

const CAMPOS_ATUALIZAVEIS = ['status', 'comissao_percentual'];

const CAMPOS_PUBLICOS = `
  id, nome, cpf, chave_pix, telefone, email, status, codigo_cupom,
  comissao_percentual, created_at
`;

function gerarCupom(nome) {
  const slug = nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 8) || 'VITRINA';
  return `${slug}${Math.floor(100 + Math.random() * 900)}`;
}

async function criar(dados) {
  const senha_hash = await bcrypt.hash(dados.senha, 10);
  // ponytail: colisão de cupom é rara (slug + 3 dígitos), mas o índice único
  // existe — se colidir, tenta de novo uma vez em vez de travar o cadastro.
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO afiliados (nome, cpf, chave_pix, telefone, email, senha_hash, codigo_cupom, aceitou_termos_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${CAMPOS_PUBLICOS}`,
        [dados.nome, dados.cpf, dados.chave_pix, dados.telefone, dados.email, senha_hash,
          gerarCupom(dados.nome), new Date()]
      );
      return rows[0];
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'afiliados_codigo_cupom_key' && tentativa === 0) continue;
      throw err;
    }
  }
}

async function buscarPorEmailComSenha(email) {
  const { rows } = await pool.query('SELECT * FROM afiliados WHERE email = $1', [email]);
  return rows[0] || null;
}

async function buscarPorId(id) {
  const { rows } = await pool.query(`SELECT ${CAMPOS_PUBLICOS} FROM afiliados WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function validarSenha(afiliado, senha) {
  return bcrypt.compare(senha, afiliado.senha_hash);
}

async function listar() {
  const { rows } = await pool.query(`SELECT ${CAMPOS_PUBLICOS} FROM afiliados ORDER BY created_at DESC`);
  return rows;
}

async function atualizar(id, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorId(id);
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const valores = campos.map((c) => dados[c]);
  await pool.query(`UPDATE afiliados SET ${sets} WHERE id = $1`, [id, ...valores]);
  return buscarPorId(id);
}

module.exports = {
  criar, buscarPorEmailComSenha, buscarPorId, validarSenha, listar, atualizar, STATUS,
};
