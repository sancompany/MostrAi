const pool = require('../db/pool');
const { validar: validarHorarioSemanal } = require('../lib/horario-semanal');

// Dois status desde 17/09/2026 (migration 045). Os cinco de antes misturavam
// "o ponto existe na rede?" com "a tela está funcionando?" — a segunda tem
// resposta própria em `dispositivos.status`, que continua com três.
const STATUS = ['a_instalar', 'em_operacao'];

// Whitelist de colunas editáveis via PATCH — nunca monta SET a partir de
// chave arbitrária vinda do body.
const CAMPOS_ATUALIZAVEIS = [
  'nome',
  'endereco',
  'cidade',
  'uf',
  'cep',
  'segmento',
  'categoria_id',
  // Espelha anunciantes.categoria_livre (migration 015): preenchido quando o
  // dono não achou a categoria dele no catálogo — "pendente de
  // classificação", não entra na regra de bloqueio (só categoria_id entra).
  // pontos nunca teve essa coluna até a migration 067; o admin lia um campo
  // que não existia (sempre "-").
  'categoria_livre',
  'responsavel_nome',
  'responsavel_contato',
  'plano_ponto_id',
  'valor_pago_mensal',
  'cota_autoanuncio_slots_hora',
  'horario_abertura',
  'horario_fechamento',
  // Horário de funcionamento por dia da semana (migration 066) — os dois
  // campos acima são de antes, nunca tiveram tela nem uso; este é o de
  // verdade, ver src/lib/horario-semanal.js.
  'horario_semanal',
  'status',
  'anunciante_id',
  'acabamento_completo',
  'foto_instalacao_url',
  'fluxo_estimado_mensal',
];

async function criar(dados, db = pool) {
  const {
    nome,
    endereco,
    cidade,
    uf,
    cep,
    segmento,
    categoria_id,
    categoria_livre,
    plano_ponto_id,
    responsavel_nome,
    responsavel_contato,
    anunciante_id,
    fluxo_estimado_mensal,
    status,
    aceitou_termos_em,
    valor_pago_mensal,
    cota_autoanuncio_slots_hora,
    horario_semanal,
  } = dados;
  const horarioValidado = validarHorarioSemanal(horario_semanal);

  const { rows } = await db.query(
    `INSERT INTO pontos
       (nome, endereco, cidade, uf, cep, segmento, categoria_id, categoria_livre, plano_ponto_id,
        responsavel_nome, responsavel_contato, status, aceitou_termos_em,
        valor_pago_mensal, cota_autoanuncio_slots_hora, anunciante_id, fluxo_estimado_mensal,
        horario_semanal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      nome,
      endereco,
      cidade,
      uf,
      cep,
      segmento,
      categoria_id || null,
      categoria_livre || null,
      plano_ponto_id || null,
      responsavel_nome,
      responsavel_contato,
      status || 'a_instalar',
      aceitou_termos_em || null,
      valor_pago_mensal || 0,
      cota_autoanuncio_slots_hora || 0,
      anunciante_id || null,
      fluxo_estimado_mensal || null,
      horarioValidado ? JSON.stringify(horarioValidado) : null,
    ],
  );
  return rows[0];
}

async function listar() {
  const { rows } = await pool.query(
    `SELECT p.*, c.nome AS categoria_nome, pp.nome AS plano_ponto_nome,
            a.nome_empresa AS dono_nome,
            (SELECT COUNT(*)::int FROM dispositivos d WHERE d.ponto_id = p.id) AS telas,
            (SELECT COUNT(*)::int FROM dispositivos d WHERE d.ponto_id = p.id AND d.status = 'ativo') AS telas_ativas
     FROM pontos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
     LEFT JOIN anunciantes a ON a.id = p.anunciante_id
     ORDER BY p.created_at DESC`,
  );
  return rows;
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM pontos WHERE id = $1', [id]);
  return rows[0] || null;
}

async function atualizar(id, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorId(id);

  const sets = campos.map((campo, i) => `${campo} = $${i + 2}`).join(', ');
  const valores = campos.map((c) => {
    if (c !== 'horario_semanal') return dados[c];
    const horarioValidado = validarHorarioSemanal(dados[c]);
    return horarioValidado ? JSON.stringify(horarioValidado) : null;
  });
  const { rows } = await pool.query(`UPDATE pontos SET ${sets} WHERE id = $1 RETURNING *`, [id, ...valores]);
  return rows[0] || null;
}

// Pública (módulo 7 "onde estamos") — pontos ativos + em construção/reparo,
// pra mostrar a rede crescendo com status visível, só campo seguro. Nunca
// devolver responsavel_contato aqui. (O player não usa isso — ele resolve
// playlist por ponto_id direto, não lista pontos.)
async function listarPublicos() {
  const { rows } = await pool.query(
    `SELECT p.id, p.nome, p.cidade, p.endereco, p.status, c.nome AS categoria_nome
     FROM pontos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.status IN ('em_operacao', 'a_instalar')
     ORDER BY (p.status = 'em_operacao') DESC, p.nome`,
  );
  return rows;
}

async function listarPorAnunciante(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT p.*, c.nome AS categoria_nome, pp.nome AS plano_ponto_nome
     FROM pontos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
     WHERE p.anunciante_id = $1
     ORDER BY p.created_at DESC`,
    [anuncianteId],
  );
  return rows;
}

// Soma de fluxo estimado só dos pontos com status "ativo" — nunca devolve o
// valor por ponto isolado (ver comentário da coluna na migration 016). O
// piso de 1.000 pra exibir saiu (19/09/2026, pedido do dono) — só continua
// null em zero, porque "0 pessoas" não é prova social nenhuma.
async function somaFluxoMensal() {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(fluxo_estimado_mensal), 0)::int AS total
     FROM pontos WHERE status = 'em_operacao'`,
  );
  const total = rows[0].total;
  return total > 0 ? total : null;
}

// Bloqueio de escolha por ponto cheio (G.7, docs/PENDENCIAS.md, migration
// 060) — pedido do dono, 18/09/2026: ponto vendido demais deve parar de
// aparecer pra ESCOLHA NOVA, não só ganhar compensação depois (RN-49) ou
// cortar na hora (RN-30). Os dois números abaixo são leitura minha de um
// pedido falado, não confirmados nestes termos — documentados como tal em
// docs/PENDENCIAS.md.
//
// LIMITE_OCUPACAO_BLOQUEIA: cruzar 80% da hora vendida bloqueia sozinho.
// FOLGA_MINIMA_PARA_LIBERAR_SEGUNDOS: liberar manualmente só é aceito se
// sobrar pelo menos essa folga (15 min) — sem isso, o próximo anunciante
// a entrar reblocka o ponto minutos depois de o admin ter liberado.
const LIMITE_OCUPACAO_BLOQUEIA = 0.8;
const FOLGA_MINIMA_PARA_LIBERAR_SEGUNDOS = 15 * 60;

// Uma linha por (ponto, anunciante) — é o que a tela do admin mostra: toda
// vez que alguém entra num ponto (assina, escolhe, ou cai lá pelo sorteio
// automático), aparece uma linha nova aqui, com o que aquela conta ocupa e
// o total do ponto onde ela está.
async function ocupacaoPorAnunciante() {
  const { rows } = await pool.query(
    `WITH ocupacao AS (
       SELECT p.id AS ponto_id, COALESCE(SUM(pl.segundos_por_hora), 0)::int AS segundos_vendidos
         FROM pontos p
         LEFT JOIN anunciantes_pontos ap ON ap.ponto_id = p.id
         LEFT JOIN anunciantes a ON a.id = ap.anunciante_id AND NOT a.suspenso AND a.excluido_em IS NULL
         LEFT JOIN planos pl ON pl.id = a.plano_id
        GROUP BY p.id
     )
     SELECT a.id AS anunciante_id, a.nome_empresa, p.id AS ponto_id, p.nome AS ponto_nome,
            pl.segundos_por_hora, o.segundos_vendidos, p.escolha_bloqueada_em, ap.escolhido_em
       FROM anunciantes_pontos ap
       JOIN anunciantes a ON a.id = ap.anunciante_id AND NOT a.suspenso AND a.excluido_em IS NULL
       JOIN planos pl ON pl.id = a.plano_id
       JOIN pontos p ON p.id = ap.ponto_id
       JOIN ocupacao o ON o.ponto_id = p.id
      ORDER BY o.segundos_vendidos DESC, p.nome, a.nome_empresa`,
  );
  return rows;
}

// Roda a cada vez que a tabela do admin é aberta (não é cron — não precisa:
// é lida com frequência suficiente, e bloquear um pouco depois de cruzar
// 80% não tem custo nenhum). Só ENTRA sozinho; só admin tira (`liberarEscolha`).
// Só `em_operacao` — `a_instalar` não veicula ainda, então "cheio" não tem
// sentido pra ele; e ele já é escolha válida por si (RN-49), sem depender
// deste bloqueio.
async function avaliarBloqueios() {
  const { rows } = await pool.query(
    `UPDATE pontos SET escolha_bloqueada_em = now()
       WHERE status = 'em_operacao'
         AND escolha_bloqueada_em IS NULL
         AND (SELECT COALESCE(SUM(pl.segundos_por_hora), 0)
                FROM anunciantes_pontos ap
                JOIN anunciantes a ON a.id = ap.anunciante_id AND NOT a.suspenso AND a.excluido_em IS NULL
                JOIN planos pl ON pl.id = a.plano_id
               WHERE ap.ponto_id = pontos.id) >= $1::numeric * 3600
     RETURNING id`,
    [LIMITE_OCUPACAO_BLOQUEIA],
  );
  return rows.map((r) => r.id);
}

// Libera pra escolha nova. Só aceita se sobrar a folga mínima — ver o
// comentário de `FOLGA_MINIMA_PARA_LIBERAR_SEGUNDOS` acima.
async function liberarEscolha(id) {
  const { rows } = await pool.query(
    `UPDATE pontos SET escolha_bloqueada_em = NULL
       WHERE id = $1
         AND (SELECT COALESCE(SUM(pl.segundos_por_hora), 0)
                FROM anunciantes_pontos ap
                JOIN anunciantes a ON a.id = ap.anunciante_id AND NOT a.suspenso AND a.excluido_em IS NULL
                JOIN planos pl ON pl.id = a.plano_id
               WHERE ap.ponto_id = pontos.id) <= (3600 - $2)
     RETURNING id`,
    [id, FOLGA_MINIMA_PARA_LIBERAR_SEGUNDOS],
  );
  return rows.length > 0;
}

// Ids dos pontos bloqueados agora — pra filtrar da escolha nova
// (`pontosDoAnunciante`, RN-42) sem tirar quem já está associado.
async function idsBloqueadosParaEscolha() {
  const { rows } = await pool.query(`SELECT id FROM pontos WHERE escolha_bloqueada_em IS NOT NULL`);
  return rows.map((r) => r.id);
}

// Chave/valor genérica pra configuração de site que não é de nenhum ponto
// específico (migration 055). Hoje só a foto de exemplo do "ponto completo"
// em pontos.html; `null` quando o dono nunca trocou, e a página pública cai
// no arquivo estático padrão nesse caso.
async function obterConfiguracao(chave) {
  const { rows } = await pool.query('SELECT valor FROM configuracoes_site WHERE chave = $1', [chave]);
  return rows[0]?.valor ?? null;
}

async function definirConfiguracao(chave, valor) {
  await pool.query(
    `INSERT INTO configuracoes_site (chave, valor) VALUES ($1, $2)
     ON CONFLICT (chave) DO UPDATE SET valor = $2`,
    [chave, valor],
  );
}

module.exports = {
  criar,
  listar,
  buscarPorId,
  atualizar,
  listarPublicos,
  listarPorAnunciante,
  somaFluxoMensal,
  obterConfiguracao,
  definirConfiguracao,
  ocupacaoPorAnunciante,
  avaliarBloqueios,
  liberarEscolha,
  idsBloqueadosParaEscolha,
  LIMITE_OCUPACAO_BLOQUEIA,
  FOLGA_MINIMA_PARA_LIBERAR_SEGUNDOS,
  STATUS,
};
