const pool = require('../db/pool');

// `beneficios` não é mais coluna (migration 015) — vem do catálogo por JOIN.
// Dois campos, de propósito: `beneficios` são os textos que vão pro site (só
// os disponíveis), `beneficio_ids` é o vínculo real, inclusive o de benefício
// desativado. O admin marca os checkboxes por id — se ele marcasse por texto,
// desativar um benefício apagaria o vínculo no próximo salvamento.
const SELECT_PLANO = `
  SELECT p.*,
    COALESCE(array_agg(b.texto ORDER BY b.ordem, b.id) FILTER (WHERE b.ativo), '{}') AS beneficios,
    COALESCE(array_agg(pb.beneficio_id) FILTER (WHERE pb.beneficio_id IS NOT NULL), '{}') AS beneficio_ids
  FROM planos p
  LEFT JOIN planos_beneficios pb ON pb.plano_id = p.id
  LEFT JOIN beneficios b ON b.id = pb.beneficio_id
`;

const CAMPOS_CRIACAO = [
  'id', 'tier', 'nome', 'valor_mensal', 'valor_mensal_cheio', 'compromisso_meses',
  'frequencia_dia', 'cobertura', 'ativo', 'destaque_no_site', 'rotulo', 'limite_criativos',
  'preco_travado', 'fundador', 'vagas', 'ponto_apos_meses'];

// Preço "fundador": criar um plano novo (id novo) em vez de editar um
// existente é o jeito de mudar preço pra clientes futuros sem mexer no que
// quem já assinou está pagando (ver migration 014).
async function criar(dados) {
  const campos = CAMPOS_CRIACAO.filter((c) => dados[c] !== undefined);
  const colunas = campos.join(', ');
  const marcadores = campos.map((_, i) => `$${i + 1}`).join(', ');
  const valores = campos.map((c) => dados[c]);
  const { rows } = await pool.query(
    `INSERT INTO planos (${colunas}) VALUES (${marcadores}) RETURNING *`,
    valores
  );
  return rows[0];
}

// vagas_restantes: só faz sentido em plano com teto de vagas (fundador) —
// nos outros vem null. Conta assinaturas ativas naquele plano.
async function listarAtivos({ incluirFundador = true } = {}) {
  const { rows } = await pool.query(
    `${SELECT_PLANO} WHERE p.ativo ${incluirFundador ? '' : 'AND NOT p.fundador'}
     GROUP BY p.id ORDER BY p.fundador DESC, p.tier, p.compromisso_meses`
  );
  for (const p of rows) {
    p.vagas_restantes = p.vagas == null ? null : Math.max(0, p.vagas - await contarVagasOcupadas(p.id));
  }
  return rows;
}

// Uma vaga é ocupada por assinatura ativa que já teve cobrança confirmada,
// ou que foi criada há pouco e ainda está indo pro checkout. Clique antigo
// que nunca pagou solta a vaga sozinho depois desse prazo — sem isso um
// curioso travaria a vaga de fundador pra sempre.
const DIAS_RESERVA_VAGA = 7;

async function contarVagasOcupadas(planoId, ignorarAnuncianteId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM assinaturas s
     WHERE s.plano_id = $1 AND s.status = 'ativa' AND s.anunciante_id <> COALESCE($2, -1)
       AND (s.created_at > now() - ($3 || ' days')::interval
            OR EXISTS (SELECT 1 FROM cobrancas_confirmadas c
                       WHERE c.anunciante_id = s.anunciante_id AND c.plano_id = s.plano_id))`,
    [planoId, ignorarAnuncianteId || null, DIAS_RESERVA_VAGA]
  );
  return rows[0].total;
}

async function listarTodos() {
  const { rows } = await pool.query(`${SELECT_PLANO} GROUP BY p.id ORDER BY p.compromisso_meses, p.tier`);
  return rows;
}

async function buscarPorId(id) {
  const { rows } = await pool.query(`${SELECT_PLANO} WHERE p.id = $1 GROUP BY p.id`, [id]);
  return rows[0] || null;
}

// Vitrine tem 3 vagas por modalidade (mensal/trimestral/semestral/anual) —
// mais que isso vira parede de card. Desativar não cancela quem já assinou:
// o plano continua existindo e cobrando igual, só sai da vitrine e não aceita
// assinante novo.
//
// Plano fundador fica fora dessa conta: ele não entra na grade de 3 tiers da
// vitrine (aparece como card próprio, só enquanto o programa está aberto).
const MAX_ATIVOS_POR_CICLO = 3;

async function contarAtivosDoCiclo(compromissoMeses, ignorarId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM planos
     WHERE ativo AND NOT fundador AND compromisso_meses = $1 AND id <> COALESCE($2, '')`,
    [compromissoMeses, ignorarId || null]
  );
  return rows[0].total;
}

async function vagaOcupada(compromissoMeses, ignorarId, ehFundador) {
  if (ehFundador) return false;
  return (await contarAtivosDoCiclo(compromissoMeses, ignorarId)) >= MAX_ATIVOS_POR_CICLO;
}

const CAMPOS_ATUALIZAVEIS = ['nome', 'valor_mensal', 'valor_mensal_cheio', 'compromisso_meses', 'ativo', 'destaque_no_site', 'rotulo', 'limite_criativos',
  'preco_travado', 'fundador', 'vagas', 'ponto_apos_meses'];

async function atualizar(id, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorId(id);
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const valores = campos.map((c) => dados[c]);
  await pool.query(`UPDATE planos SET ${sets} WHERE id = $1`, [id, ...valores]);
  return buscarPorId(id);
}

// Substitui a lista de benefícios do plano de uma vez (o admin manda o
// conjunto marcado inteiro, não um diff).
async function definirBeneficios(planoId, beneficioIds) {
  await pool.query('DELETE FROM planos_beneficios WHERE plano_id = $1', [planoId]);
  if (beneficioIds.length) {
    await pool.query(
      `INSERT INTO planos_beneficios (plano_id, beneficio_id)
       SELECT $1, unnest($2::int[])`,
      [planoId, beneficioIds]
    );
  }
  return buscarPorId(planoId);
}

module.exports = {
  criar, listarAtivos, listarTodos, buscarPorId, atualizar,
  definirBeneficios, vagaOcupada, contarVagasOcupadas, MAX_ATIVOS_POR_CICLO,
};
