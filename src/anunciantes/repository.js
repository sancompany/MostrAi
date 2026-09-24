const { gerarHash, conferirHash } = require('../lib/senha');
const { limpar: limparDocumento } = require('../br/documento');
const pool = require('../db/pool');
const { PARTES, colunasDoEndereco } = require('../lib/endereco');

// `status` deixou de ser estado operacional (decisão do dono, 16/09/2026) —
// hoje só distingue comum de parceiro (substitui o antigo flag `fundador`).
// O que bloqueia login/veiculação é o campo `suspenso`, separado.
const STATUS = ['comum', 'parceiro'];

const CAMPOS_ATUALIZAVEIS = [
  'nome_empresa',
  'cpf_cnpj',
  'endereco',
  // Partes do endereço (migration 086, D5 de 24/09/2026) — `endereco` vira a
  // linha "logradouro, número" composta por src/lib/endereco.js.
  'logradouro',
  'numero',
  'complemento',
  'bairro',
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
  // Conta própria do Mostraí (migration 023) — só o admin muda os dois.
  'conta_propria',
  'frequencia_hora_propria',
  // Plano de cortesia (migration 024) — só o admin libera.
  'plano_cortesia',
  'cortesia_motivo',
  // Bloqueio operacional (migration 038, 16/09/2026) — separado do `status`
  // (que virou só comum/parceiro). Marcado à mão pelo admin, ou pela
  // conciliação quando a cobertura vence.
  'suspenso',
  // Parceiro (migration 033, renomeado de "fundador" na migration 038) —
  // status de conta que só o admin marca, com o desconto e o piso de
  // compromisso que ele decidir.
  'parceiro_desconto_percentual',
  'parceiro_compromisso_minimo',
  // Confirmação de e-mail por código (migration 061) — só a rota de
  // confirmação marca isso, nunca o PATCH de autoedição (não está em
  // CAMPOS_AUTOEDITAVEIS, em src/anunciantes/routes.js).
  'email_confirmado',
];

// Nunca devolver senha_hash pra fora do repository.
// As duas ultimas sao da migration 025 (direitos do titular). Sem elas aqui,
// a tela do perfil lia undefined e remarcava o "quero receber novidades" de
// quem tinha acabado de revogar — a pessoa via o oposto do que estava no banco.
const CAMPOS_PUBLICOS = `
  id, nome_empresa, cpf_cnpj, endereco, logradouro, numero, complemento, bairro, cidade, uf, cep,
  contato_email, contato_telefone, status, plano_id,
  data_inicio_cobertura, data_expiracao, indicado_por_cupom, categoria_id, categoria_livre,
  responsavel_nome, responsavel_cpf, responsavel_email, responsavel_telefone, foto_url, created_at, excluido_em,
  papeis, conta_propria, frequencia_hora_propria,
  plano_cortesia, cortesia_motivo,
  anuncio_bonus_resgatado_em,
  comunicacoes_revogado_em, dados_opcionais_apagados_em,
  suspenso, parceiro_desconto_percentual, parceiro_compromisso_minimo,
  credito_comodato_mensal, comodato_plano_id, email_confirmado,
  plano_pago_guardado_id, plano_pago_guardado_dias
`;

// O plano da conta é SÓ o comercial (`plano_id`): Essencial, Pro ou Prime —
// pago, benefício por créditos ou cortesia legada. Inicial/Básico deixaram de
// ser plano em 24/09/2026 (ADR-016): `comodato_plano_id` fica no banco como
// legado e nada mais o lê pra dar direito de veicular.
function planoEfetivoId(conta) {
  return conta?.plano_id || null;
}

// O plano que o GERADOR honra AGORA (src/playlist/gerador.js#
// anunciantesElegiveis, mesma condição): o comercial enquanto estiver dentro
// da validade. `planoEfetivoId` acima ignora a validade — serve pra cota de
// cadastro; pra dizer "está no ar" / "veicula agora", é esta.
function planoVigenteId(conta, agora = new Date()) {
  if (!conta?.plano_id) return null;
  return !conta.data_expiracao || new Date(conta.data_expiracao) >= agora ? conta.plano_id : null;
}

// `db` opcional: o cadastro por convite passa o client da transação.
//
// `cpf_cnpj` é normalizado (`limpar` — sem pontuação, maiúsculo) AQUI, não em
// cada rota que chama `criar` (cadastro público, cadastro manual do admin,
// convite) — 21/09/2026, pedido do dono: documento digitado com ou sem
// pontuação nunca pode virar duas identidades diferentes daqui pra frente.
// Contas já gravadas antes desta mudança não são tocadas — ver
// docs/PENDENCIAS.md pra o que fazer com as duplicidades que já existem.
async function criar(dados, db = pool) {
  const senha_hash = await gerarHash(dados.senha);
  // Partes do endereço e a linha `endereco` composta num lugar só (D5).
  const end = colunasDoEndereco(dados);
  const { rows } = await db.query(
    `INSERT INTO anunciantes
       (nome_empresa, cpf_cnpj, endereco, cidade, uf, cep, contato_email, contato_telefone,
        senha_hash, indicado_por_cupom, categoria_id, categoria_livre,
        responsavel_nome, responsavel_cpf, responsavel_email,
        responsavel_telefone, aceitou_termos_em, papeis, status,
        logradouro, numero, complemento, bairro)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING ${CAMPOS_PUBLICOS}`,
    [
      dados.nome_empresa,
      limparDocumento(dados.cpf_cnpj),
      end.endereco ?? null,
      end.cidade ?? null,
      end.uf ?? null,
      end.cep ?? null,
      normalizarEmail(dados.contato_email),
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
      // `status` virou só comum/parceiro (16/09/2026) — toda conta nova é
      // 'comum'; quem bloqueia é o campo `suspenso`, não este.
      dados.status || 'comum',
      end.logradouro ?? null,
      end.numero ?? null,
      end.complemento ?? null,
      end.bairro ?? null,
    ],
  );
  return rows[0];
}

// E-mail é identidade e login: uma forma só (minúsculas, sem espaço nas
// pontas). Cadastro grava assim; login, redefinição e a busca por e-mail
// comparam assim — "Bruno@x.com" e "bruno@x.com" são a mesma conta
// (índice único em lower(trim()) na migration 088).
function normalizarEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

// Uso interno (login/webhook) — inclui senha_hash pra comparar.
async function buscarPorEmailComSenha(email) {
  const { rows } = await pool.query('SELECT * FROM anunciantes WHERE lower(trim(contato_email)) = $1', [
    normalizarEmail(email),
  ]);
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

async function atualizar(id, entrada) {
  // Mexeu no endereço: as partes e a linha `endereco` composta saem juntas
  // daqui (D5, src/lib/endereco.js) — nenhuma rota compõe por conta própria.
  let dados = entrada;
  if (PARTES.some((p) => entrada[p] !== undefined) || entrada.endereco !== undefined) {
    dados = { ...entrada, ...colunasDoEndereco(entrada, await buscarPorId(id)) };
  }
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorId(id);

  const sets = campos.map((campo, i) => `${campo} = $${i + 2}`).join(', ');
  // Mesma normalização de `criar` — quem editar cpf_cnpj por aqui (hoje
  // ninguém no admin, mas a rota genérica de PATCH aceita) não reabre a
  // porta pra documento sem padrão.
  const valores = campos.map((c) =>
    c === 'cpf_cnpj' ? limparDocumento(dados[c]) : c === 'contato_email' ? normalizarEmail(dados[c]) : dados[c],
  );
  await pool.query(`UPDATE anunciantes SET ${sets} WHERE id = $1`, [id, ...valores]);
  return buscarPorId(id);
}

// Só pode existir uma conta própria (migration 023). Quem pergunta é a rota de
// criação do admin, antes de inserir.
async function existeContaPropria() {
  const { rows } = await pool.query('SELECT 1 FROM anunciantes WHERE conta_propria LIMIT 1');
  return rows.length > 0;
}

async function buscarContaPropria() {
  const { rows } = await pool.query(`SELECT ${CAMPOS_PUBLICOS} FROM anunciantes WHERE conta_propria LIMIT 1`);
  return rows[0] || null;
}

// Conta institucional do Mostraí — recurso interno, singleton, sem tela de
// criação (reorganização de Conteúdo, 22/09/2026: "não quero formulário de
// bootstrap da conta, não quero login dessa conta"). Idempotente: a
// primeira mídia própria criada aciona isto e cria a linha sozinha; toda
// chamada seguinte devolve a mesma conta. Nome/CNPJ são só o que a coluna
// NOT NULL exige — nunca aparecem em tela nenhuma, a conta não emite nota
// nem faz login de verdade (senha aleatória, nunca entregue a ninguém).
async function ensureContaMostrai() {
  const existente = await buscarContaPropria();
  if (existente) return existente;
  const senha = require('node:crypto').randomBytes(24).toString('base64url');
  const criada = await criar({
    nome_empresa: 'Mostraí',
    cpf_cnpj: '00000000000000',
    contato_email: 'rede+propria@mostrai.local',
    contato_telefone: '+5516000000000',
    senha,
  });
  return atualizar(criada.id, { conta_propria: true, email_confirmado: true });
}

module.exports = {
  existeContaPropria,
  buscarContaPropria,
  ensureContaMostrai,
  criar,
  normalizarEmail,
  buscarPorEmailComSenha,
  buscarPorId,
  validarSenha,
  listar,
  planoEfetivoId,
  planoVigenteId,
  atualizar,
  STATUS,
};
