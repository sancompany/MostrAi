const pool = require('../db/pool');
const { CRIATIVOS_POR_CONTA } = require('../lib/limites');

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
  'segundos_por_hora',
  'duracao_maxima_segundos',
  'pontos_incluidos',
  'cobertura',
  'ativo',
  'destaque_no_site',
  'rotulo',
  'limite_criativos',
  'fundador',
  'vagas',
  'desconto_comodato_percentual',
  'desconto_percentual',
];

// Criar um plano novo (id novo) em vez de editar um existente é o jeito de
// mudar preço pra clientes futuros sem mexer no que quem já assinou está
// pagando (ver migration 014).
// A guarda fica AQUI e não nas rotas: `criar` e `novaVersao` são os dois
// únicos caminhos que gravam um plano, e uma guarda por caminho é uma guarda
// que a terceira rota vai esquecer. Erro nomeado, com o teto na mensagem —
// "valor inválido" manda o dono adivinhar qual.
function conferirLimiteCriativos(dados) {
  if (dados.limite_criativos == null) return;
  const n = Number(dados.limite_criativos);
  if (!Number.isInteger(n) || n < 1 || n > CRIATIVOS_POR_CONTA) {
    const erro = new Error(
      `limite de criativos tem que ser um número inteiro de 1 a ${CRIATIVOS_POR_CONTA} — a rotação da tela não roda mais que isso`,
    );
    erro.code = 'LIMITE_CRIATIVOS';
    throw erro;
  }
}

async function criar(dados) {
  conferirLimiteCriativos(dados);
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
  // Ordem da vitrine é por PREÇO, não pelo nome do tier: alfabético punha
  // "Destaque" na frente de "Essencial" e o cliente lia a grade de trás pra
  // frente (o do meio, mais escolhido, aparecia primeiro). Do mais barato
  // pro mais caro, o destacado cai no centro — que é onde o mercado põe.
  const { rows } = await pool.query(
    `${SELECT_PLANO} WHERE p.ativo ${incluirFundador ? '' : 'AND NOT p.fundador'}
     GROUP BY p.id ORDER BY p.fundador DESC, p.compromisso_meses, p.valor_mensal, p.tier`,
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
  // Mesma ordem da vitrine (por preço, não pelo nome do tier): o editor do
  // admin mostra os planos na posição em que o cliente vai vê-los.
  const { rows } = await pool.query(
    `${SELECT_PLANO} WHERE p.arquivado_em IS NULL GROUP BY p.id ORDER BY p.compromisso_meses, p.valor_mensal, p.tier`,
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
  'segundos_por_hora',
  'duracao_maxima_segundos',
  'pontos_incluidos',
  'cobertura',
  'limite_criativos',
  'fundador',
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
  conferirLimiteCriativos(mudancas);
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

// ---------------------------------------------------------------------------
// OFERTAS > PREÇOS (reformulação comercial, 22/09/2026) — os 3 produtos fixos
// (Essencial/Pro/Prime, chave `tier`) editados como UM produto, não como 4
// linhas soltas por ciclo. Por baixo continua a mesma máquina de sempre
// (`novaVersao`, uma linha imutável por tier×ciclo, versão nova quando algo
// muda) — só a CASCA fica simples: preço-base mensal + um desconto por
// ciclo (Mensal/Trimestral/Semestral/Anual) + desconto comodato, os únicos
// campos que o pedido do dono deixa editáveis no admin. Características
// estruturais (segundos/hora, pontos, duração, criativos, nome) não entram
// aqui de propósito — ficam como estão, fixas por tier.
const CICLOS_PRODUTO = [1, 3, 6, 12];

// Uma linha por ciclo, a que está valendo hoje pra aquele tier. Quando existir
// mais de uma ativa no mesmo ciclo (não deveria, mas o catálogo antigo
// permite plano solto fora da grade dos 3 produtos) pega a mais cara — é a
// que carrega o preço-base de verdade, não uma promoção ou plano avulso.
async function linhaAtualDoProduto(tier, compromissoMeses) {
  const { rows } = await pool.query(
    `SELECT * FROM planos
      WHERE tier = $1 AND compromisso_meses = $2 AND ativo AND NOT fundador
      ORDER BY valor_mensal_cheio DESC NULLS LAST, id LIMIT 1`,
    [tier, compromissoMeses],
  );
  return rows[0] || null;
}

// Os 3 produtos, cada um com as 4 ofertas de ciclo — é o que a tela OFERTAS >
// PREÇOS lê pra montar os 3 cards. `precoBase` é o `valor_mensal_cheio` do
// ciclo mensal (a referência de onde os outros ciclos partem, Parte H do
// pedido); `descontoComodato` vem do mensal também — as 4 linhas de um
// mesmo tier sempre compartilham o mesmo preço cheio e o mesmo desconto
// comodato (é assim que a grade nasce, migration 047), então ler do mensal
// basta.
async function listarProdutos() {
  const tiers = ['essencial', 'destaque', 'maximo'];
  const produtos = [];
  for (const tier of tiers) {
    const porCiclo = {};
    for (const meses of CICLOS_PRODUTO) {
      porCiclo[meses] = await linhaAtualDoProduto(tier, meses);
    }
    const referencia = porCiclo[1] || Object.values(porCiclo).find(Boolean);
    if (!referencia) continue; // tier sem nenhuma linha ativa — não deveria acontecer, mas não quebra a tela
    produtos.push({
      tier,
      nome: referencia.nome,
      precoBase: Number(referencia.valor_mensal_cheio ?? referencia.valor_mensal),
      ciclos: Object.fromEntries(
        CICLOS_PRODUTO.map((meses) => {
          const p = porCiclo[meses];
          return [
            meses,
            p
              ? {
                  planoId: p.id,
                  descontoPercentual: p.desconto_percentual != null ? Number(p.desconto_percentual) : null,
                  valorMensal: Number(p.valor_mensal),
                }
              : null,
          ];
        }),
      ),
    });
  }
  return produtos;
}

// Atualiza o produto inteiro (as 4 linhas do tier) numa tacada: preço-base
// novo se igual entra em todo mundo, cada ciclo recebe o desconto que veio
// pra ele. Só publica versão nova pra ciclo cujo valor de verdade mudou —
// reabrir e salvar sem mexer em nada não deve encher "Arquivados" de linha
// idêntica. `descontos` é um objeto { 1: pct|null, 3: ..., 6: ..., 12: ... }.
// `desconto_comodato_percentual` não entra mais (rodada de integridade,
// 23/09/2026): é legado da migration 049, que trocou o percentual pelo
// crédito em reais. `novaVersao` copia a linha atual, então o valor que já
// estiver gravado é preservado sem ser editado — e não entra mais em cálculo
// nenhum (ver san-checkout.js#valorMensalDaConta).
async function atualizarProduto(tier, { precoBase, descontos }) {
  const cheio = Number(precoBase);
  if (!Number.isFinite(cheio) || cheio <= 0) {
    const erro = new Error('preço-base tem que ser um número maior que zero');
    erro.status = 400;
    throw erro;
  }

  const resultado = [];
  for (const meses of CICLOS_PRODUTO) {
    const atual = await linhaAtualDoProduto(tier, meses);
    if (!atual) continue; // ciclo sem linha hoje — fora do escopo desta rodada (ver comentário da migration)
    const descontoBruto = descontos ? descontos[meses] : undefined;
    const desconto = descontoBruto === '' || descontoBruto == null ? null : Number(descontoBruto);
    if (desconto != null && (!Number.isFinite(desconto) || desconto < 0 || desconto >= 100)) {
      const erro = new Error(`desconto do ciclo de ${meses} meses tem que ser vazio ou um número entre 0 e 99`);
      erro.status = 400;
      throw erro;
    }
    const cheioAtual = atual.valor_mensal_cheio != null ? Number(atual.valor_mensal_cheio) : null;
    const descontoAtual = atual.desconto_percentual != null ? Number(atual.desconto_percentual) : null;
    const mudou = cheioAtual !== cheio || descontoAtual !== desconto;
    resultado.push(
      mudou ? await novaVersao(atual.id, { valor_mensal_cheio: cheio, desconto_percentual: desconto }) : atual,
    );
  }
  return resultado;
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
  listarProdutos,
  atualizarProduto,
};
