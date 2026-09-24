const pool = require('../db/pool');
const { validar: validarHorarioSemanal } = require('../lib/horario-semanal');
const { LIMITE_COMERCIAL } = require('../lib/capacidade');

// Quatro status desde 22/09/2026 (migration 069, rodada final da Rede) —
// e AUTOMÁTICO: ninguém escreve aqui direto, `sincronizarStatusPonto` (mais
// abaixo) deriva de `dispositivos.status` sempre que uma tela muda. Por
// isso `status` saiu de CAMPOS_ATUALIZAVEIS — só essa função grava a coluna.
const STATUS = ['a_instalar', 'em_operacao', 'em_reparo', 'inativo'];

// Whitelist de colunas editáveis via PATCH — nunca monta SET a partir de
// chave arbitrária vinda do body.
const CAMPOS_ATUALIZAVEIS = [
  'nome',
  'endereco',
  // Bairro e complemento entraram na migration 070 (rodada de candidatura
  // canônica, 22/09/2026) — antes disso `endereco` guardava rua e bairro
  // concatenados (o ViaCEP devolve os dois separados; era o formulário que
  // juntava). Endereço antigo continua lendo normal, só não tem os dois
  // campos novos preenchidos.
  'bairro',
  'complemento',
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
  'cota_autoanuncio_slots_hora',
  'horario_abertura',
  'horario_fechamento',
  // Horário de funcionamento por dia da semana (migration 066) — os dois
  // campos acima são de antes, nunca tiveram tela nem uso; este é o de
  // verdade, ver src/lib/horario-semanal.js.
  'horario_semanal',
  'anunciante_id',
  'acabamento_completo',
  'foto_instalacao_url',
  'fluxo_estimado_mensal',
  // Migration 067 — "algo a mais" da candidatura, copiado no nascimento do
  // ponto (ver liberarPapelNaConta); editável aqui só pelo mesmo motivo dos
  // outros dados de ficha, não porque o admin deva reescrever a palavra do
  // estabelecimento.
  'observacoes',
];

async function criar(dados, db = pool) {
  const {
    nome,
    endereco,
    bairro,
    complemento,
    cidade,
    uf,
    cep,
    segmento,
    categoria_id,
    categoria_livre,
    responsavel_nome,
    responsavel_contato,
    anunciante_id,
    fluxo_estimado_mensal,
    status,
    aceitou_termos_em,
    cota_autoanuncio_slots_hora,
    horario_semanal,
    foto_instalacao_url,
    observacoes,
    candidatura_id,
  } = dados;
  const horarioValidado = validarHorarioSemanal(horario_semanal);

  const { rows } = await db.query(
    `INSERT INTO pontos
       (nome, endereco, bairro, complemento, cidade, uf, cep, segmento, categoria_id, categoria_livre,
        responsavel_nome, responsavel_contato, status, aceitou_termos_em,
        cota_autoanuncio_slots_hora, anunciante_id, fluxo_estimado_mensal,
        horario_semanal, foto_instalacao_url, observacoes, candidatura_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [
      nome,
      endereco,
      bairro || null,
      complemento || null,
      cidade,
      uf,
      cep,
      segmento,
      categoria_id || null,
      categoria_livre || null,
      responsavel_nome,
      responsavel_contato,
      status || 'a_instalar',
      aceitou_termos_em || null,
      cota_autoanuncio_slots_hora || 0,
      anunciante_id || null,
      fluxo_estimado_mensal || null,
      horarioValidado ? JSON.stringify(horarioValidado) : null,
      foto_instalacao_url || null,
      observacoes || null,
      candidatura_id || null,
    ],
  );
  return rows[0];
}

// Identidade do estabelecimento (23/09/2026, auditoria do ponto duplicado).
// Uma função só para as três portas que podiam criar o mesmo lugar duas
// vezes: os dois formulários de candidatura (POST /anunciantes/me/pontos e
// POST /conta/modos/ponto/pedir) e a aprovação (liberarPapelNaConta).
//
// NÃO é "mesmo endereço" sozinho — dois comércios diferentes podem dividir o
// endereço (galeria, sala comercial, box). O mesmo estabelecimento é: mesma
// conta dona + mesmo nome + mesmo endereço. Devolve o motivo em texto pra
// quem recusa, ou null quando está livre.
async function estabelecimentoJaCadastrado(
  contaId,
  { nome, endereco, cep },
  db = pool,
  { incluirPedidos = true } = {},
) {
  if (incluirPedidos) {
    const { rows: pedidos } = await db.query(
      `SELECT id FROM candidaturas
         WHERE conta_id = $1 AND tipo = 'ponto' AND status IN ('nova', 'em_contato')
           AND lower(trim(endereco)) = lower(trim($2)) AND trim(COALESCE(cep, '')) = trim($3)`,
      [contaId, endereco || '', cep || ''],
    );
    if (pedidos.length) return 'Já existe uma solicitação em análise para este endereço';
  }
  if (!nome) return null;
  const { rows: pontos } = await db.query(
    `SELECT id FROM pontos
       WHERE anunciante_id = $1 AND status <> 'arquivado'
         AND lower(trim(nome)) = lower(trim($2)) AND lower(trim(endereco)) = lower(trim($3))
       LIMIT 1`,
    [contaId, nome, endereco || ''],
  );
  if (pontos.length) return 'Este estabelecimento já é um ponto da sua conta';
  return null;
}

// Ponto arquivado (migration 080) fica fora de toda listagem da experiência
// normal. O histórico continua no banco — `mesclado_em_ponto_id` diz para
// qual registro canônico ele foi.
async function listar() {
  const { rows } = await pool.query(
    `SELECT p.*, c.nome AS categoria_nome,
            a.nome_empresa AS dono_nome,
            (SELECT COUNT(*)::int FROM dispositivos d WHERE d.ponto_id = p.id) AS telas,
            (SELECT COUNT(*)::int FROM dispositivos d WHERE d.ponto_id = p.id AND d.status = 'ativo') AS telas_ativas
     FROM pontos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN anunciantes a ON a.id = p.anunciante_id
     WHERE p.status <> 'arquivado'
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

// Status automático do ponto (rodada final da Rede, 22/09/2026) — único
// lugar que escreve `pontos.status`. Chamada de dentro de
// src/dispositivos/repository.js toda vez que uma tela nasce, muda de
// status, ou é excluída, pra nunca existir um momento em que o status do
// ponto e o das telas dele contem histórias diferentes.
//
//   0 telas                -> a_instalar   (Aguardando instalação)
//   >=1 tela ativa         -> em_operacao  (Ativo)
//   0 ativa, >=1 reparo    -> em_reparo    (Em reparo)
//   0 ativa, 0 reparo      -> inativo      (Inativo, mas tem tela cadastrada)
async function sincronizarStatusPonto(pontoId, db = pool) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'ativo')::int AS ativas,
            COUNT(*) FILTER (WHERE status = 'reparo')::int AS em_reparo,
            COUNT(*)::int AS total
       FROM dispositivos WHERE ponto_id = $1`,
    [pontoId],
  );
  const { ativas, em_reparo, total } = rows[0];
  const status = total === 0 ? 'a_instalar' : ativas > 0 ? 'em_operacao' : em_reparo > 0 ? 'em_reparo' : 'inativo';
  // Arquivado é decisão explícita e auditável (migration 080), nunca
  // derivada das telas — o status automático não pode ressuscitar um ponto
  // mesclado só porque alguém mexeu numa tela dele.
  const { rowCount } = await db.query(`UPDATE pontos SET status = $2 WHERE id = $1 AND status <> 'arquivado'`, [
    pontoId,
    status,
  ]);
  return rowCount ? status : 'arquivado';
}

// Pública (módulo 7 "onde estamos") — pontos ativos + em construção/reparo,
// pra mostrar a rede crescendo com status visível, só campo seguro. Nunca
// devolver responsavel_contato aqui. (O player não usa isso — ele resolve
// playlist por ponto_id direto, não lista pontos.)
//
// Só `inativo` fica de fora (rodada final da Rede, 22/09/2026): antes desta
// rodada `pontos.status` só tinha 2 valores possíveis (a_instalar/em_operacao,
// migration 045) e este filtro incluía os dois — na prática, 100% dos pontos
// reais. Com o status automático (migration 069) `em_reparo` virou um valor
// de verdade; este comentário já dizia "ativos + em construção/reparo" desde
// antes, então entra na mesma lista — só `inativo` (tela(s) cadastrada(s),
// nenhuma funcionando) é o caso realmente novo que faz sentido esconder.
async function listarPublicos() {
  const { rows } = await pool.query(
    `SELECT p.id, p.nome, p.cidade, p.endereco, p.status, p.foto_instalacao_url, c.nome AS categoria_nome
     FROM pontos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.status IN ('em_operacao', 'a_instalar', 'em_reparo')
     ORDER BY (p.status = 'em_operacao') DESC, p.nome`,
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
// Valor único em src/lib/capacidade.js (rodada de integridade, 23/09/2026):
// a régua 80/20 que Visão geral e Mídia Mostraí mostram lê o mesmo número.
const LIMITE_OCUPACAO_BLOQUEIA = LIMITE_COMERCIAL;
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
  estabelecimentoJaCadastrado,
  listar,
  buscarPorId,
  atualizar,
  listarPublicos,
  somaFluxoMensal,
  obterConfiguracao,
  definirConfiguracao,
  ocupacaoPorAnunciante,
  sincronizarStatusPonto,
  avaliarBloqueios,
  liberarEscolha,
  idsBloqueadosParaEscolha,
  LIMITE_OCUPACAO_BLOQUEIA,
  FOLGA_MINIMA_PARA_LIBERAR_SEGUNDOS,
  STATUS,
};
