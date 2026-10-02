const pool = require('../db/pool');
const { validar: validarHorarioSemanal } = require('../lib/horario-semanal');
const { LIMITE_COMERCIAL } = require('../lib/capacidade');
const { PARTES, colunasDoEndereco } = require('../lib/endereco');

// Cinco status (migration 069 + `aguardando_primeiro_sinal` na 088) —
// e AUTOMÁTICO: ninguém escreve aqui direto, `sincronizarStatusPonto` (mais
// abaixo) deriva das telas sempre que uma tela muda. Por isso `status` saiu
// de CAMPOS_ATUALIZAVEIS — só essa função grava a coluna. `arquivado` é
// decisão explícita (migration 080), fora desta lista.
const STATUS = ['a_instalar', 'aguardando_primeiro_sinal', 'em_operacao', 'em_reparo', 'inativo'];
// Os status em que o ponto é um lugar real da rede (aparece no site, conta
// como vaga do plano — RN-49). Só `inativo` (tela cadastrada, nenhuma
// funcionando) e `arquivado` ficam de fora.
const STATUS_NA_REDE = ['em_operacao', 'aguardando_primeiro_sinal', 'a_instalar', 'em_reparo'];

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
  // Logradouro e número separados (migration 086, D5 de 24/09/2026):
  // `endereco` passa a ser a linha "logradouro, número" composta por
  // src/lib/endereco.js, nunca escrita à mão.
  'logradouro',
  'numero',
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
  // Horário de funcionamento por dia da semana (migration 066) — ver
  // src/lib/horario-semanal.js. (`horario_abertura`/`horario_fechamento` e
  // `acabamento_completo` saíram daqui na consolidação de 24/09/2026: colunas
  // sem tela e sem leitor, não eram para continuar graváveis pela API.)
  'horario_semanal',
  'anunciante_id',
  'foto_instalacao_url',
  'fluxo_estimado_mensal',
  // Migration 067 — "algo a mais" da candidatura, copiado no nascimento do
  // ponto (ver liberarPapelNaConta); editável aqui só pelo mesmo motivo dos
  // outros dados de ficha, não porque o admin deva reescrever a palavra do
  // estabelecimento.
  'observacoes',
];

async function criar(dados, db = pool) {
  // Partes do endereço e a linha composta num lugar só (D5). `cidade`, `uf` e
  // `cep` são NOT NULL aqui: vazio continua indo como veio.
  const end = colunasDoEndereco(dados);
  const { nome, cidade, uf, cep } = dados;
  const {
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
    // Ponto móvel (migration 112): sem dona, com base. Fixo é o padrão.
    tipo,
    base_conta_id,
    base_nome,
    movel_numero,
  } = dados;
  const horarioValidado = validarHorarioSemanal(horario_semanal);
  const movel = tipo === 'movel';

  const { rows } = await db.query(
    `INSERT INTO pontos
       (nome, endereco, bairro, complemento, cidade, uf, cep, segmento, categoria_id, categoria_livre,
        responsavel_nome, responsavel_contato, status, aceitou_termos_em,
        cota_autoanuncio_slots_hora, anunciante_id, fluxo_estimado_mensal,
        horario_semanal, foto_instalacao_url, observacoes, candidatura_id, logradouro, numero,
        tipo, base_conta_id, base_nome, movel_numero, base_desde)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
             $24,$25,$26,$27, CASE WHEN $24 = 'movel' THEN now() END)
     RETURNING *`,
    [
      nome,
      end.endereco,
      end.bairro ?? null,
      end.complemento ?? null,
      end.cidade ?? cidade,
      end.uf ?? uf,
      end.cep ?? cep,
      segmento,
      categoria_id || null,
      categoria_livre || null,
      responsavel_nome,
      responsavel_contato,
      status || 'a_instalar',
      aceitou_termos_em || null,
      cota_autoanuncio_slots_hora || 0,
      movel ? null : anunciante_id || null,
      fluxo_estimado_mensal || null,
      horarioValidado ? JSON.stringify(horarioValidado) : null,
      foto_instalacao_url || null,
      observacoes || null,
      candidatura_id || null,
      end.logradouro ?? null,
      end.numero ?? null,
      movel ? 'movel' : 'fixo',
      movel ? base_conta_id : null,
      movel ? base_nome : null,
      movel ? movel_numero : null,
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
    // CEP comparado só pelos dígitos: "15990-000" e "15990000" são o mesmo
    // lugar (o formulário grava com hífen, a API pode receber sem).
    const { rows: pedidos } = await db.query(
      `SELECT id FROM candidaturas
         WHERE conta_id = $1 AND tipo = 'ponto' AND status IN ('nova', 'em_contato')
           AND lower(trim(endereco)) = lower(trim($2))
           AND regexp_replace(COALESCE(cep, ''), '\\D', '', 'g') = regexp_replace($3, '\\D', '', 'g')`,
      [contaId, endereco || '', cep || ''],
    );
    if (pedidos.length) return 'Já existe uma solicitação em análise para este endereço';
  }
  if (!nome) return null;
  // O mesmo estabelecimento como BASE de um ponto móvel da Mostraí também é
  // "já cadastrado" (migration 112): o móvel não é da conta, mas o lugar já
  // está na rede — um segundo pedido ali é duplicidade, não ponto novo.
  const { rows: pontos } = await db.query(
    `SELECT tipo FROM pontos
       WHERE status <> 'arquivado' AND lower(trim(endereco)) = lower(trim($3))
         AND ((anunciante_id = $1 AND lower(trim(nome)) = lower(trim($2)))
           OR (base_conta_id = $1 AND lower(trim(base_nome)) = lower(trim($2))))
       ORDER BY (tipo = 'fixo') DESC
       LIMIT 1`,
    [contaId, nome, endereco || ''],
  );
  if (!pontos.length) return null;
  return pontos[0].tipo === 'movel'
    ? 'Este estabelecimento já é base de um ponto móvel da Mostraí'
    : 'Este estabelecimento já é um ponto da sua conta';
}

// Ponto arquivado (migration 080) fica fora de toda listagem da experiência
// normal. O histórico continua no banco — `mesclado_em_ponto_id` diz para
// qual registro canônico ele foi.
async function listar() {
  const { rows } = await pool.query(
    `SELECT p.*, c.nome AS categoria_nome,
            a.nome_empresa AS dono_nome, b.nome_empresa AS base_conta_nome,
            (SELECT COUNT(*)::int FROM dispositivos d WHERE d.ponto_id = p.id) AS telas,
            (SELECT COUNT(*)::int FROM dispositivos d WHERE d.ponto_id = p.id AND d.status = 'ativo') AS telas_ativas,
            -- Mudou de endereço depois da instalação e a operação ainda não
            -- conferiu (src/pendencias/, estação de endereços).
            EXISTS (SELECT 1 FROM pendencias pe WHERE pe.ponto_id = p.id AND pe.tipo = 'ENDERECO_PONTO_ALTERADO'
                      AND pe.resolvido_em IS NULL) AS endereco_a_conferir
     FROM pontos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN anunciantes a ON a.id = p.anunciante_id
     LEFT JOIN anunciantes b ON b.id = p.base_conta_id
     WHERE p.status <> 'arquivado'
     ORDER BY p.created_at DESC`,
  );
  return rows;
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM pontos WHERE id = $1', [id]);
  return rows[0] || null;
}

async function atualizar(id, entrada) {
  // Mexeu no endereço: as partes e a linha composta saem juntas daqui (D5).
  let dados = entrada;
  if (PARTES.some((p) => entrada[p] !== undefined) || entrada.endereco !== undefined) {
    const atual = await buscarPorId(id);
    const { cidade, uf, cep, ...end } = colunasDoEndereco(entrada, atual);
    dados = { ...entrada, ...end };
    // NOT NULL na tabela: limpar não apaga, fica o que estava.
    for (const [campo, valor] of Object.entries({ cidade, uf, cep })) {
      if (valor) dados[campo] = valor;
      else delete dados[campo];
    }
    if (!dados.endereco) delete dados.endereco;
  }
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
// Regra canônica (consolidação, 24/09/2026), na ordem em que é decidida:
//   0 telas                                   -> a_instalar (Aguardando instalação)
//   >=1 tela ativa, provisionada, com sinal   -> em_operacao (Ativo)
//   >=1 tela ativa provisionada sem 1º sinal  -> aguardando_primeiro_sinal
//   >=1 tela ativa sem Player (sem chave —    -> a_instalar (tela cadastrada não é
//       nunca provisionada ou revogada)          tela operando; o reprovisionamento
//                                                chama isto de novo)
//   0 ativa, >=1 reparo                       -> em_reparo
//   0 ativa, 0 reparo                         -> inativo (tem tela, nenhuma ligada)
// É estado do ponto, não saúde: uma tela que já operou e está sem sinal
// agora não tira o ponto de "Ativo" (isso é alerta, src/lib/status-tela.js).
// "Ponto Inativo com tela Operando" é impossível por construção: tela
// operando é tela ativa, e tela ativa nunca leva a `inativo`.
async function sincronizarStatusPonto(pontoId, db = pool) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'ativo' AND primeiro_sinal_em IS NOT NULL AND chave_hash IS NOT NULL)::int AS operando,
            COUNT(*) FILTER (WHERE status = 'ativo' AND chave_hash IS NOT NULL)::int AS provisionadas,
            COUNT(*) FILTER (WHERE status = 'ativo')::int AS ativas,
            COUNT(*) FILTER (WHERE status = 'reparo')::int AS em_reparo,
            COUNT(*)::int AS total
       FROM dispositivos WHERE ponto_id = $1`,
    [pontoId],
  );
  const { operando, provisionadas, ativas, em_reparo, total } = rows[0];
  const status =
    total === 0
      ? 'a_instalar'
      : operando > 0
        ? 'em_operacao'
        : provisionadas > 0
          ? 'aguardando_primeiro_sinal'
          : ativas > 0
            ? 'a_instalar'
            : em_reparo > 0
              ? 'em_reparo'
              : 'inativo';
  // Arquivado é decisão explícita e auditável (migration 080), nunca
  // derivada das telas — o status automático não pode ressuscitar um ponto
  // mesclado só porque alguém mexeu numa tela dele.
  const { rowCount } = await db.query(`UPDATE pontos SET status = $2 WHERE id = $1 AND status <> 'arquivado'`, [
    pontoId,
    status,
  ]);
  // Plano Básico do ponto (migration 103): nasce quando o ponto passa a ter
  // tela provisionada e ativa — a mesma régua do +1 crédito/mês. Toda mudança
  // de tela passa por aqui (criar, provisionar, trocar status, revogar,
  // primeiro sinal), então o benefício não espera o job diário. Require
  // tardio: basico.js lê a régua de src/creditos/ponto.js.
  await require('./basico').sincronizar({ apenasPontos: [Number(pontoId)], db });
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
    `SELECT p.id, p.nome, p.cidade, p.endereco, p.bairro, p.status, p.foto_instalacao_url, c.nome AS categoria_nome,
            p.tipo, p.base_nome
     FROM pontos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.status = ANY($1::text[])
     ORDER BY (p.status = 'em_operacao') DESC, p.nome`,
    [STATUS_NA_REDE],
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

// A conta é ponto: tem ao menos um ponto aprovado não arquivado — a mesma
// regra de "Meus pontos" (`ehPonto`, meus-pontos.js) e do selo "Dono de
// ponto" da ficha (situacao.js). Candidatura em análise não conta.
async function contaEhPonto(contaId, db = pool) {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM pontos WHERE anunciante_id = $1 AND status <> 'arquivado') AS eh`,
    [contaId],
  );
  return rows[0].eh;
}

// Exclusão de ponto — a mesma regra da exclusão de tela
// (dispositivos/repository.js#deletar): só sai de verdade o ponto SEM
// histórico. Com histórico o servidor recusa (409) dizendo qual, e a saída é
// deixar as telas Inativas (o ponto vira Inativo sozinho). Histórico é tudo o
// que comprova algo a alguém: exibição confirmada em qualquer tela dele
// (anúncio ou Mídia Mostraí), crédito, repasse, Plano Básico já concedido,
// ou ponto mesclado nele. Ponto arquivado também é histórico (mesclagem).
// Sem histórico, o ponto e as telas saem numa transação só: o que as telas
// tinham é programação que nunca virou exibição, e a escolha de quem marcou
// o ponto sai junto (a cobertura dessas contas se redistribui sozinha).
// Devolve null se o ponto não existe; senão { contasQueEscolheram, dono }.
async function deletar(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      rows: [ponto],
    } = await client.query('SELECT id, status, anunciante_id FROM pontos WHERE id = $1 FOR UPDATE', [id]);
    if (!ponto) {
      await client.query('ROLLBACK');
      return null;
    }
    // Trava as telas antes de olhar o histórico: um comprovante que chegue
    // agora espera esta transação (e falha, sem a tela) ou entra antes e
    // é visto aqui.
    const { rows: telas } = await client.query('SELECT id FROM dispositivos WHERE ponto_id = $1 FOR UPDATE', [id]);
    const telaIds = telas.map((t) => t.id);
    const {
      rows: [h],
    } = await client.query(
      `SELECT
         EXISTS (SELECT 1 FROM execucoes_confirmadas WHERE dispositivo_id = ANY($2::int[]) AND status = 'contabilizado')
           OR EXISTS (SELECT 1 FROM exibicoes_contador WHERE dispositivo_id = ANY($2::int[]) AND vezes_confirmadas > 0)
           OR EXISTS (SELECT 1 FROM midias_exibicoes_contador
                       WHERE (dispositivo_id = ANY($2::int[]) OR ponto_id = $1) AND vezes_confirmadas > 0) AS exibicao,
         EXISTS (SELECT 1 FROM creditos_ledger WHERE ponto_id = $1) AS credito,
         EXISTS (SELECT 1 FROM pagamentos_ponto WHERE ponto_id = $1) AS repasse,
         EXISTS (SELECT 1 FROM beneficios_basico_ponto WHERE ponto_id = $1) AS basico,
         EXISTS (SELECT 1 FROM pontos WHERE mesclado_em_ponto_id = $1) AS mesclado`,
      [id, telaIds],
    );
    const motivo =
      ponto.status === 'arquivado'
        ? 'Este ponto está arquivado (faz parte do histórico de uma mesclagem) e não pode ser excluído.'
        : h.exibicao
          ? 'Este ponto possui histórico de exibições e não pode ser excluído permanentemente. Deixe as telas dele Inativas.'
          : h.credito
            ? 'Este ponto já gerou créditos e não pode ser excluído permanentemente. Deixe as telas dele Inativas.'
            : h.repasse
              ? 'Este ponto possui repasses registrados e não pode ser excluído permanentemente. Deixe as telas dele Inativas.'
              : h.basico
                ? 'Este ponto já deu o Plano Básico ao dono e não pode ser excluído permanentemente. Deixe as telas dele Inativas.'
                : h.mesclado
                  ? 'Outro ponto foi mesclado neste e o histórico depende dele: não pode ser excluído.'
                  : null;
    if (motivo) throw Object.assign(new Error(motivo), { status: 409 });

    if (telaIds.length) {
      await client.query('DELETE FROM exibicoes_contador WHERE dispositivo_id = ANY($1::int[])', [telaIds]);
      await client.query('DELETE FROM playlist_hora_congelada WHERE dispositivo_id = ANY($1::int[])', [telaIds]);
      await client.query('DELETE FROM execucoes_confirmadas WHERE dispositivo_id = ANY($1::int[])', [telaIds]);
    }
    await client.query('DELETE FROM midias_exibicoes_contador WHERE ponto_id = $1 OR dispositivo_id = ANY($2::int[])', [
      id,
      telaIds,
    ]);
    // tokens_provisionamento e tela_eventos saem com a tela (ON DELETE CASCADE).
    await client.query('DELETE FROM dispositivos WHERE ponto_id = $1', [id]);
    const { rows: escolhas } = await client.query(
      'DELETE FROM anunciantes_pontos WHERE ponto_id = $1 RETURNING anunciante_id',
      [id],
    );
    await client.query('DELETE FROM pontos_enderecos_historico WHERE ponto_id = $1', [id]);
    // pendencias e midias_proprias_pontos saem por ON DELETE CASCADE.
    await client.query('DELETE FROM pontos WHERE id = $1', [id]);
    await client.query('COMMIT');
    return {
      contasQueEscolheram: [...new Set(escolhas.map((e) => e.anunciante_id))],
      dono: ponto.anunciante_id,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  deletar,
  contaEhPonto,
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
  STATUS_NA_REDE,
};
