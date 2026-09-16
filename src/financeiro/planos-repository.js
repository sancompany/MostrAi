const pool = require('../db/pool');

// O admin digita preço cheio + desconto; o valor cobrado de verdade sai
// daqui, sempre — nunca é digitado direto (pedido do dono, 16/09/2026).
// Sem desconto (0, null ou undefined), o valor cobrado é o preço cheio.
function calcularValorMensal(valorCheio, descontoPercentual) {
  const cheio = Number(valorCheio);
  const desconto = Number(descontoPercentual) || 0;
  return Math.round(cheio * (1 - desconto / 100) * 100) / 100;
}

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
  'id',
  'tier',
  'nome',
  'valor_mensal',
  'valor_mensal_cheio',
  'compromisso_meses',
  'frequencia_hora',
  'cobertura',
  'ativo',
  'destaque_no_site',
  'rotulo',
  'limite_criativos',
  'preco_travado',
  'fundador',
  'vagas',
  'ponto_apos_meses',
  'desconto_comodato_percentual',
  'desconto_percentual',
];

// Criar um plano novo (id novo) em vez de editar um existente é o jeito de
// mudar preço pra clientes futuros sem mexer no que quem já assinou está
// pagando (ver migration 014).
async function criar(dados) {
  const preparado = { ...dados };
  if (preparado.valor_mensal_cheio != null) {
    preparado.valor_mensal = calcularValorMensal(preparado.valor_mensal_cheio, preparado.desconto_percentual);
  }
  const campos = CAMPOS_CRIACAO.filter((c) => preparado[c] !== undefined);
  const colunas = campos.join(', ');
  const marcadores = campos.map((_, i) => `$${i + 1}`).join(', ');
  const valores = campos.map((c) => preparado[c]);
  const { rows } = await pool.query(`INSERT INTO planos (${colunas}) VALUES (${marcadores}) RETURNING *`, valores);
  return rows[0];
}

// vagas_restantes: só faz sentido em plano com teto de vagas (fundador) —
// nos outros vem null. Conta assinaturas ativas naquele plano.
async function listarAtivos({ incluirFundador = true } = {}) {
  const { rows } = await pool.query(
    `${SELECT_PLANO} WHERE p.ativo ${incluirFundador ? '' : 'AND NOT p.fundador'}
     GROUP BY p.id ORDER BY p.fundador DESC, p.tier, p.compromisso_meses`,
  );
  for (const p of rows) {
    p.vagas_restantes = p.vagas == null ? null : Math.max(0, p.vagas - (await contarVagasOcupadas(p.id)));
  }
  return rows;
}

// Uma vaga é ocupada por assinatura ativa que já teve cobrança confirmada,
// ou que foi criada há pouco e ainda está indo pro checkout. Clique antigo
// que nunca pagou solta a vaga sozinho depois desse prazo — sem isso um
// curioso travaria a vaga pra sempre. 15 minutos é o bastante pra completar
// o pagamento; não há por que seguar por dias (decisão do dono, 15/09/2026 —
// era 7 dias).
const MINUTOS_RESERVA_VAGA = 15;

async function contarVagasOcupadas(planoId, ignorarAnuncianteId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM assinaturas s
     WHERE s.plano_id = $1 AND s.status = 'ativa' AND s.anunciante_id <> COALESCE($2, -1)
       AND (s.created_at > now() - ($3 || ' minutes')::interval
            OR EXISTS (SELECT 1 FROM cobrancas_confirmadas c
                       WHERE c.anunciante_id = s.anunciante_id AND c.plano_id = s.plano_id))`,
    [planoId, ignorarAnuncianteId || null, MINUTOS_RESERVA_VAGA],
  );
  return rows[0].total;
}

// A grade do admin. Versão aposentada sai daqui e vai pra `listarArquivados()`
// — misturada, a tela mostraria dois "Essencial anual" e o dono editaria o
// errado.
async function listarTodos() {
  const { rows } = await pool.query(
    `${SELECT_PLANO} WHERE p.arquivado_em IS NULL GROUP BY p.id ORDER BY p.compromisso_meses, p.tier`,
  );
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
    [compromissoMeses, ignorarId || null],
  );
  return rows[0].total;
}

async function vagaOcupada(compromissoMeses, ignorarId, ehFundador) {
  if (ehFundador) return false;
  return (await contarAtivosDoCiclo(compromissoMeses, ignorarId)) >= MAX_ATIVOS_POR_CICLO;
}

// Os dois grupos de campo, e a linha entre eles é o item 9 da spec.
//
// VITRINE: mexer neles não alcança quem já assinou. `ativo` tira o plano da
// vitrine sem cancelar ninguém; `vagas` só limita quem ainda vai entrar;
// `destaque_no_site` e `rotulo` são marketing da página pública.
const CAMPOS_VITRINE = ['ativo', 'destaque_no_site', 'rotulo', 'vagas'];

// CONTRATO: cada um destes o Mostraí lê AO VIVO pra quem já está pagando —
// `limite_criativos` no upload, `frequencia_hora` e `cobertura` na playlist,
// `nome` e benefícios no painel, `desconto_comodato_percentual` no cálculo
// do valor mensal (item 8 da spec). Editar no lugar mudaria o contrato de
// quem já assinou. Só entram por versão nova.
const CAMPOS_CONTRATO = [
  'tier',
  'nome',
  'valor_mensal',
  'valor_mensal_cheio',
  'compromisso_meses',
  'frequencia_hora',
  'cobertura',
  'limite_criativos',
  'preco_travado',
  'fundador',
  'ponto_apos_meses',
  'beneficio_ids',
  'desconto_comodato_percentual',
  'desconto_percentual',
];

const CAMPOS_ATUALIZAVEIS = CAMPOS_VITRINE;

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
      [planoId, beneficioIds],
    );
  }
  return buscarPorId(planoId);
}

// Id da versão seguinte: `essencial-12m` vira `essencial-12m-v2`, e `-v2` vira
// `-v3`. Conta a partir do que existe no banco, não do id recebido, senão duas
// edições seguidas da mesma base colidiriam.
async function proximoId(idAtual) {
  const base = String(idAtual).replace(/-v\d+$/, '');
  const { rows } = await pool.query("SELECT id FROM planos WHERE id = $1 OR id LIKE $1 || '-v%'", [base]);
  let maior = 1;
  for (const r of rows) {
    const m = /-v(\d+)$/.exec(r.id);
    if (m) maior = Math.max(maior, Number(m[1]));
  }
  return `${base}-v${maior + 1}`;
}

// Cria a versão nova e aposenta a atual, numa transação só. Insere primeiro:
// `substituido_por` é chave estrangeira pra `planos`, então apontar pra uma
// linha que ainda não existe é recusado pelo banco. O instante em que há
// quatro planos ativos no ciclo não escapa da transação — leitura de fora vê
// o estado commitado, nunca o de dentro.
async function novaVersao(idAtual, mudancas) {
  const atual = await buscarPorId(idAtual);
  if (!atual) return null;

  const novo = { ...atual };
  delete novo.beneficios;
  for (const campo of [...CAMPOS_CONTRATO, ...CAMPOS_VITRINE]) {
    if (campo in mudancas && mudancas[campo] !== undefined) novo[campo] = mudancas[campo];
  }
  const beneficios = (mudancas.beneficio_ids || atual.beneficio_ids || []).map(Number);
  if (novo.valor_mensal_cheio != null) {
    novo.valor_mensal = calcularValorMensal(novo.valor_mensal_cheio, novo.desconto_percentual);
  }
  novo.id = await proximoId(idAtual);
  novo.ativo = true;

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const campos = CAMPOS_CRIACAO.filter((c) => novo[c] !== undefined && novo[c] !== null);
    await cliente.query(
      `INSERT INTO planos (${campos.join(', ')})
       VALUES (${campos.map((_, i) => `$${i + 1}`).join(', ')})`,
      campos.map((c) => novo[c]),
    );
    await cliente.query('UPDATE planos SET ativo = false, arquivado_em = now(), substituido_por = $2 WHERE id = $1', [
      idAtual,
      novo.id,
    ]);
    if (beneficios.length) {
      await cliente.query('INSERT INTO planos_beneficios (plano_id, beneficio_id) SELECT $1, unnest($2::int[])', [
        novo.id,
        beneficios,
      ]);
    }
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }
  return buscarPorId(novo.id);
}

// Versões aposentadas, com quantos assinantes ativos cada uma ainda tem — é
// esse número que um dia torna seguro apagar uma versão antiga. Zero não
// significa "pode apagar já": cobrança confirmada guarda `plano_id` por
// obrigação fiscal.
async function listarArquivados() {
  const { rows } = await pool.query(`
    ${SELECT_PLANO}
    WHERE p.arquivado_em IS NOT NULL
    GROUP BY p.id
    ORDER BY p.arquivado_em DESC`);
  for (const p of rows) {
    const { rows: c } = await pool.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM anunciantes
          WHERE plano_id = $1 AND NOT suspenso AND excluido_em IS NULL
            AND (data_expiracao IS NULL OR data_expiracao >= now())) AS contas_ativas,
        (SELECT COUNT(*)::int FROM cobrancas_confirmadas WHERE plano_id = $1) AS cobrancas`,
      [p.id],
    );
    p.contas_ativas = c[0].contas_ativas;
    p.cobrancas = c[0].cobrancas;
  }
  return rows;
}

module.exports = {
  criar,
  listarAtivos,
  listarTodos,
  buscarPorId,
  atualizar,
  novaVersao,
  listarArquivados,
  proximoId,
  definirBeneficios,
  vagaOcupada,
  contarVagasOcupadas,
  MAX_ATIVOS_POR_CICLO,
  CAMPOS_VITRINE,
  CAMPOS_CONTRATO,
};
