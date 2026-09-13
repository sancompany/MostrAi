const crypto = require('crypto');
const pool = require('../db/pool');
const { gerarHash, conferirHash } = require('../lib/senha');

// Dispositivo = uma tela. Ponto = o comércio/endereço (migration 019).
const CAMPOS_ATUALIZAVEIS = ['apelido', 'status', 'custo_equipamento', 'meses_amortizacao', 'instalado_em'];
const STATUS = ['ativo', 'reparo', 'inativo'];

// pin_hash nunca sai daqui pra fora.
const CAMPOS_PUBLICOS = `id, ponto_id, apelido, aparelho_id, status, ultima_vez_online,
  custo_equipamento, meses_amortizacao, instalado_em, created_at, (pin_hash IS NOT NULL) AS tem_pin`;

async function criar(pontoId, dados = {}, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO dispositivos (ponto_id, apelido, custo_equipamento, meses_amortizacao, instalado_em)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${CAMPOS_PUBLICOS}`,
    [pontoId, dados.apelido || 'Tela', Number(dados.custo_equipamento) || 0,
      Number(dados.meses_amortizacao) || 36, dados.instalado_em || null]
  );
  return rows[0];
}

async function buscarPorId(id) {
  const { rows } = await pool.query(`SELECT ${CAMPOS_PUBLICOS} FROM dispositivos WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Uso interno do player: precisa do ponto junto (categoria, horário, cota).
async function buscarComPonto(id) {
  const { rows } = await pool.query(
    `SELECT d.id, d.ponto_id, d.aparelho_id, d.status,
            p.categoria_id, p.horario_abertura, p.horario_fechamento,
            p.cota_autoanuncio_slots_hora, p.anunciante_id AS dono_conta_id, p.status AS ponto_status,
            (SELECT COUNT(*)::int FROM dispositivos x WHERE x.ponto_id = d.ponto_id AND x.status = 'ativo') AS telas_do_ponto
     FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id WHERE d.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function listarPorPonto(pontoId) {
  const { rows } = await pool.query(
    `SELECT ${CAMPOS_PUBLICOS} FROM dispositivos WHERE ponto_id = $1 ORDER BY id`, [pontoId]
  );
  return rows;
}

// Mesmos campos públicos, prefixados com o alias da tabela — sem isso
// `status`/`created_at` ficam ambíguos no JOIN com pontos.
const CAMPOS_PUBLICOS_D = `d.id, d.ponto_id, d.apelido, d.aparelho_id, d.status, d.ultima_vez_online,
  d.custo_equipamento, d.meses_amortizacao, d.instalado_em, d.created_at, (d.pin_hash IS NOT NULL) AS tem_pin`;

async function listarTodos() {
  const { rows } = await pool.query(
    `SELECT ${CAMPOS_PUBLICOS_D},
            p.nome AS ponto_nome, p.cidade AS ponto_cidade, p.status AS ponto_status
     FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id ORDER BY p.nome, d.id`
  );
  return rows;
}

async function atualizar(id, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorId(id);
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `UPDATE dispositivos SET ${sets} WHERE id = $1 RETURNING ${CAMPOS_PUBLICOS}`,
    [id, ...campos.map((c) => dados[c])]
  );
  return rows[0] || null;
}

// Chave nova derruba o aparelho antigo na hora — é o que se quer quando o
// stick é trocado ou some.
async function gerarChave(id) {
  const chave = crypto.randomBytes(16).toString('base64url');
  const { rows } = await pool.query(
    `UPDATE dispositivos SET aparelho_id = $2 WHERE id = $1 RETURNING ${CAMPOS_PUBLICOS}`, [id, chave]
  );
  return rows[0] ? { ...rows[0], aparelho_id: chave } : null;
}

// PIN de 4 dígitos, guardado com hash. Protege só o painel daquela tela
// aberto a partir da própria TV (CONSTRAINTS.md). null limpa.
async function definirPin(id, pin) {
  const hash = pin ? await gerarHash(String(pin)) : null;
  const { rows } = await pool.query(
    `UPDATE dispositivos SET pin_hash = $2 WHERE id = $1 RETURNING ${CAMPOS_PUBLICOS}`, [id, hash]
  );
  return rows[0] || null;
}

async function conferirPin(id, pin) {
  const { rows } = await pool.query('SELECT pin_hash FROM dispositivos WHERE id = $1', [id]);
  if (!rows[0] || !rows[0].pin_hash) return false;
  return (await conferirHash(String(pin), rows[0].pin_hash)).ok;
}

async function marcarOnline(id) {
  await pool.query('UPDATE dispositivos SET ultima_vez_online = now() WHERE id = $1', [id]);
}

// Telas ativas na rede inteira — é o que decide se a cobertura de um plano
// com minimo_telas_ativas começa a contar.
async function contarAtivas() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
     WHERE d.status = 'ativo' AND p.status = 'ativo'`
  );
  return rows[0].total;
}

async function deletar(id) {
  await pool.query('DELETE FROM exibicoes_contador WHERE dispositivo_id = $1', [id]);
  await pool.query('DELETE FROM dispositivos WHERE id = $1', [id]);
}

module.exports = {
  criar, buscarPorId, buscarComPonto, listarPorPonto, listarTodos, atualizar,
  gerarChave, definirPin, conferirPin, marcarOnline, contarAtivas, deletar, STATUS,
};
