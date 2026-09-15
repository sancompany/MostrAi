const { gerarHash, conferirHash } = require('../lib/senha');
const pool = require('../db/pool');

const STATUS = ['pendente_aprovacao', 'aprovado', 'ativo', 'suspenso'];

const CAMPOS_ATUALIZAVEIS = [
  'nome_empresa',
  'cpf_cnpj',
  'endereco',
  'cidade',
  'uf',
  'cep',
  'contato_email',
  'contato_telefone',
  'status',
  'plano_id',
  'data_inicio_cobertura',
  'data_expiracao',
  'categoria_id',
  'categoria_livre',
  'responsavel_nome',
  'responsavel_cpf',
  'responsavel_email',
  'responsavel_telefone',
  'foto_url',
  'excluido_em',
  'papeis',
  'valor_mensal_travado',
  // Conta própria do Mostraí (migration 023) — só o admin muda os dois.
  'conta_propria',
  'frequencia_hora_propria',
  // Plano de cortesia (migration 024) — só o admin libera.
  'plano_cortesia',
  'cortesia_motivo',
  // Fundador (migration 033, item 4 da spec) — status de conta que só o
  // admin marca, com o desconto e o piso de compromisso que ele decidir.
  'fundador',
  'fundador_desconto_percentual',
  'fundador_compromisso_minimo',
];

// Nunca devolver senha_hash pra fora do repository.
// As duas ultimas sao da migration 025 (direitos do titular). Sem elas aqui,
// a tela do perfil lia undefined e remarcava o "quero receber novidades" de
// quem tinha acabado de revogar — a pessoa via o oposto do que estava no banco.
const CAMPOS_PUBLICOS = `
  id, nome_empresa, cpf_cnpj, endereco, cidade, uf, cep,
  contato_email, contato_telefone, status, plano_id,
  data_inicio_cobertura, data_expiracao, indicado_por_cupom, categoria_id, categoria_livre,
  responsavel_nome, responsavel_cpf, responsavel_email, responsavel_telefone, foto_url, created_at, excluido_em,
  papeis, valor_mensal_travado, conta_propria, frequencia_hora_propria,
  plano_cortesia, cortesia_motivo,
  ponto_bonus_resgatado_em, anuncio_bonus_resgatado_em,
  comunicacoes_revogado_em, dados_opcionais_apagados_em,
  fundador, fundador_desconto_percentual, fundador_compromisso_minimo
`;

// `db` opcional: o cadastro por convite passa o client da transação.
async function criar(dados, db = pool) {
  const senha_hash = await gerarHash(dados.senha);
  const { rows } = await db.query(
    `INSERT INTO anunciantes
       (nome_empresa, cpf_cnpj, endereco, cidade, uf, cep, contato_email, contato_telefone,
        senha_hash, indicado_por_cupom, categoria_id, categoria_livre,
        responsavel_nome, responsavel_cpf, responsavel_email,
        responsavel_telefone, aceitou_termos_em, papeis, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING ${CAMPOS_PUBLICOS}`,
    [
      dados.nome_empresa,
      dados.cpf_cnpj,
      dados.endereco || null,
      dados.cidade || null,
      dados.uf || null,
      dados.cep || null,
      dados.contato_email,
      dados.contato_telefone,
      senha_hash,
      dados.indicado_por_cupom ? String(dados.indicado_por_cupom).toUpperCase() : null,
      dados.categoria_id || null,
      dados.categoria_livre || null,
      dados.responsavel_nome || null,
      dados.responsavel_cpf || null,
      dados.responsavel_email || null,
      dados.responsavel_telefone || null,
      new Date(),
      dados.papeis?.length ? dados.papeis : ['anunciante'],
      // Não existe mais aprovação de conta (decisão do dono, 15/09/2026): a
      // conta nasce liberada, por convite ou pelo cadastro aberto. O único
      // portão que sobra é o do criativo (src/anunciantes/criativos-repository.js).
      dados.status || 'aprovado',
    ],
  );
  return rows[0];
}

// Uso interno (login/webhook) — inclui senha_hash pra comparar.
async function buscarPorEmailComSenha(email) {
  const { rows } = await pool.query('SELECT * FROM anunciantes WHERE contato_email = $1', [email]);
  return rows[0] || null;
}

async function buscarPorId(id) {
  const { rows } = await pool.query(`SELECT ${CAMPOS_PUBLICOS} FROM anunciantes WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Migração preguiçosa de hash: bcrypt legado é aceito e, no login que der
// certo, regravado em scrypt. Ninguém precisa trocar de senha.
async function validarSenha(anunciante, senha) {
  const { ok, precisaMigrar } = await conferirHash(senha, anunciante.senha_hash);
  if (ok && precisaMigrar) {
    const novo = await gerarHash(senha);
    await pool.query('UPDATE anunciantes SET senha_hash = $1 WHERE id = $2', [novo, anunciante.id]);
  }
  return ok;
}

async function listar() {
  const { rows } = await pool.query(`SELECT ${CAMPOS_PUBLICOS} FROM anunciantes ORDER BY created_at DESC`);
  return rows;
}

async function atualizar(id, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorId(id);

  const sets = campos.map((campo, i) => `${campo} = $${i + 2}`).join(', ');
  const valores = campos.map((c) => dados[c]);
  await pool.query(`UPDATE anunciantes SET ${sets} WHERE id = $1`, [id, ...valores]);
  return buscarPorId(id);
}

// Só pode existir uma conta própria (migration 023). Quem pergunta é a rota de
// criação do admin, antes de inserir.
async function existeContaPropria() {
  const { rows } = await pool.query('SELECT 1 FROM anunciantes WHERE conta_propria LIMIT 1');
  return rows.length > 0;
}

module.exports = {
  existeContaPropria,
  criar,
  buscarPorEmailComSenha,
  buscarPorId,
  validarSenha,
  listar,
  atualizar,
  STATUS,
};
