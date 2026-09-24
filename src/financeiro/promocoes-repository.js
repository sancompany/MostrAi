const pool = require('../db/pool');
const { instanteComercial } = require('../lib/fuso-comercial');
const { arredondar, percentual } = require('../lib/dinheiro');

// Promoções (reformulação comercial, 22/09/2026) — condição comercial
// temporária, separada do produto (Essencial/Pro/Prime continuam sendo os
// únicos produtos; ver planos-repository.js#listarProdutos). Uma promoção
// participa de uma matriz tier × ciclo (`promocoes_itens`), cada célula com
// o próprio desconto — Mensal pode simplesmente não ter linha e ficar de
// fora (Parte N do pedido).

// `mostrar_logados`/`mostrar_admin`/`ativa` saíram daqui (reconstrução de
// Ofertas/Promoções, 23/09/2026) — colunas continuam existindo (migrations
// são aditivas), só pararam de ser lidas/escritas: quem vê a promoção agora
// é `publico_elegivel` (elegibilidade comercial, não sessão), e o controle
// manual de liga/desliga é `status` (substitui `ativa`). A Visão Geral do
// admin passou a mostrar toda promoção vigente, sem opt-in por checkbox.
const CAMPOS_IDENTIDADE = [
  'nome_interno',
  'titulo_publico',
  'subtitulo',
  'descricao',
  'selo',
  'imagem_url',
  'formato_midia',
  'compra_inicio',
  'compra_fim',
  'duracao_beneficio_meses',
  'limite_adesoes',
  'publico_elegivel',
  'status',
  'mostrar_home',
  'mostrar_planos',
];

// Janela de compra digitada no admin é horário de Matão, não do banco (D3,
// 24/09/2026 — ver src/lib/fuso-comercial.js): antes "31/10 23:59" virava
// 23:59 UTC e a promoção encerrava às 20:59 daqui.
function comDatasComerciais(dados) {
  return {
    ...dados,
    compra_inicio: instanteComercial(dados.compra_inicio, { campo: 'início da compra' }),
    compra_fim: instanteComercial(dados.compra_fim, { campo: 'fim da compra', fim: true }),
  };
}

async function listarTodas() {
  const { rows } = await pool.query(`
    SELECT p.*,
      COALESCE(json_agg(json_build_object(
        'tier', i.tier, 'compromissoMeses', i.compromisso_meses, 'descontoPercentual', i.desconto_percentual
      ) ORDER BY i.tier, i.compromisso_meses) FILTER (WHERE i.id IS NOT NULL), '[]') AS itens,
      (SELECT COUNT(*)::int FROM assinaturas a WHERE a.promocao_id = p.id) AS adesoes
    FROM promocoes p
    LEFT JOIN promocoes_itens i ON i.promocao_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC`);
  return rows;
}

async function buscarPorId(id) {
  const { rows } = await pool.query(
    `SELECT p.*,
      COALESCE(json_agg(json_build_object(
        'tier', i.tier, 'compromissoMeses', i.compromisso_meses, 'descontoPercentual', i.desconto_percentual
      ) ORDER BY i.tier, i.compromisso_meses) FILTER (WHERE i.id IS NOT NULL), '[]') AS itens,
      (SELECT COUNT(*)::int FROM assinaturas a WHERE a.promocao_id = p.id) AS adesoes
    FROM promocoes p
    LEFT JOIN promocoes_itens i ON i.promocao_id = p.id
    WHERE p.id = $1
    GROUP BY p.id`,
    [id],
  );
  return rows[0] || null;
}

function validarItens(itens) {
  const TIERS = new Set(['essencial', 'destaque', 'maximo']);
  const CICLOS = new Set([1, 3, 6, 12]);
  const limpos = [];
  for (const item of itens || []) {
    if (!TIERS.has(item.tier)) throw Object.assign(new Error(`produto inválido: ${item.tier}`), { status: 400 });
    const meses = Number(item.compromissoMeses);
    if (!CICLOS.has(meses)) throw Object.assign(new Error(`ciclo inválido: ${item.compromissoMeses}`), { status: 400 });
    const desconto = Number(item.descontoPercentual);
    if (!Number.isFinite(desconto) || desconto <= 0 || desconto > 100) {
      throw Object.assign(new Error(`desconto inválido pra ${item.tier} × ${meses} meses`), { status: 400 });
    }
    limpos.push({ tier: item.tier, compromisso_meses: meses, desconto_percentual: desconto });
  }
  return limpos;
}

async function definirItens(promocaoId, itens, db = pool) {
  const limpos = validarItens(itens);
  await db.query('DELETE FROM promocoes_itens WHERE promocao_id = $1', [promocaoId]);
  for (const item of limpos) {
    await db.query(
      `INSERT INTO promocoes_itens (promocao_id, tier, compromisso_meses, desconto_percentual)
       VALUES ($1, $2, $3, $4)`,
      [promocaoId, item.tier, item.compromisso_meses, item.desconto_percentual],
    );
  }
}

async function criar(entrada) {
  if (!entrada.nome_interno || !entrada.titulo_publico) {
    throw Object.assign(new Error('nome interno e título público são obrigatórios'), { status: 400 });
  }
  const dados = comDatasComerciais(entrada);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const campos = CAMPOS_IDENTIDADE.filter((c) => dados[c] !== undefined);
    const { rows } = await cliente.query(
      `INSERT INTO promocoes (${campos.join(', ')}) VALUES (${campos.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      campos.map((c) => dados[c]),
    );
    await definirItens(rows[0].id, dados.itens, cliente);
    await cliente.query('COMMIT');
    return buscarPorId(rows[0].id);
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }
}

async function atualizar(id, entrada) {
  const dados = comDatasComerciais(entrada);
  const campos = CAMPOS_IDENTIDADE.filter((c) => dados[c] !== undefined);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    if (campos.length) {
      const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await cliente.query(`UPDATE promocoes SET ${sets} WHERE id = $1`, [id, ...campos.map((c) => dados[c])]);
    }
    if (dados.itens !== undefined) await definirItens(id, dados.itens, cliente);
    await cliente.query('COMMIT');
    return buscarPorId(id);
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }
}

async function excluir(id) {
  // `assinaturas.promocao_id` é FK sem CASCADE de propósito (migration 070):
  // apagar a promoção não pode apagar nem soltar o registro de quem já
  // aderiu. Se alguém já aderiu, a promoção fica (só pode ser desativada).
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM assinaturas WHERE promocao_id = $1', [id]);
  if (rows[0].n > 0) {
    throw Object.assign(new Error('essa promoção já tem adesão — desative em vez de excluir'), { status: 409 });
  }
  await pool.query('DELETE FROM promocoes WHERE id = $1', [id]);
}

// Promoções "vigentes" agora: ativas, dentro da janela de COMPRA (não da
// duração do benefício — essa é por assinatura, ver assinaturas-repository)
// e ainda com vaga se houver teto de adesões. É o que decide se uma condição
// promocional pode ser oferecida a alguém escolhendo agora — não afeta quem
// já aderiu antes.
async function listarVigentes() {
  const { rows } = await pool.query(`
    SELECT p.*,
      COALESCE(json_agg(json_build_object(
        'tier', i.tier, 'compromissoMeses', i.compromisso_meses, 'descontoPercentual', i.desconto_percentual
      ) ORDER BY i.tier, i.compromisso_meses) FILTER (WHERE i.id IS NOT NULL), '[]') AS itens,
      (SELECT COUNT(*)::int FROM assinaturas a WHERE a.promocao_id = p.id) AS adesoes
    FROM promocoes p
    LEFT JOIN promocoes_itens i ON i.promocao_id = p.id
    WHERE p.status = 'ativa'
      AND (p.compra_inicio IS NULL OR p.compra_inicio <= now())
      AND (p.compra_fim IS NULL OR p.compra_fim >= now())
    GROUP BY p.id
    HAVING p.limite_adesoes IS NULL
        OR p.limite_adesoes > (SELECT COUNT(*)::int FROM assinaturas a WHERE a.promocao_id = p.id)
    ORDER BY p.created_at DESC`);
  return rows;
}

// Elegibilidade COMERCIAL (reconstrução de Ofertas/Promoções, 23/09/2026:
// "não trate a promoção com a lógica usuário logado vs deslogado. A lógica
// correta deve ser de ELEGIBILIDADE COMERCIAL") — depende do estado da
// CONTA (tem plano ativo? já assinou antes?), nunca de ter sessão aberta.
// Visitante sem sessão é tratado como "novo" (mesma coisa que logado sem
// plano — nenhum dos dois tem histórico de assinatura pra excluir).
function temPlanoAtivo(conta) {
  if (!conta?.plano_id || conta.suspenso || conta.excluido_em) return false;
  return !conta.data_expiracao || new Date(conta.data_expiracao) >= new Date();
}

async function jaAssinouAntes(anuncianteId) {
  const { rows } = await pool.query(
    'SELECT EXISTS(SELECT 1 FROM cobrancas_confirmadas WHERE anunciante_id = $1) AS existe',
    [anuncianteId],
  );
  return rows[0].existe;
}

// `conta` null (visitante sem sessão) = "novo" por padrão: sem plano ativo,
// sem histórico. Usado tanto pela vitrine pública (`GET /promocoes/vigentes`)
// quanto pela assinatura de verdade (`POST /anunciantes/:id/assinar`) — o
// preço cobrado nunca pode ser mais generoso do que o que a vitrine mostrou,
// então os dois pontos passam pelo mesmo cálculo.
async function estadoComercialDaConta(conta) {
  if (!conta) return { temPlanoAtivo: false, jaAssinouAntes: false };
  return { temPlanoAtivo: temPlanoAtivo(conta), jaAssinouAntes: await jaAssinouAntes(conta.id) };
}

function elegivel(promo, estado) {
  if (promo.publico_elegivel === 'assinantes') return !!estado.temPlanoAtivo;
  if (promo.publico_elegivel === 'novos') return !estado.temPlanoAtivo && !estado.jaAssinouAntes;
  return true; // 'todos'
}

// A condição promocional pra UM tier × ciclo específico, se houver alguma
// vigente E elegível pro `estado` informado — é o que a vitrine e a
// assinatura nova consultam (Parte T do pedido original: o desconto
// aplicado na cobrança real nunca pode ser mais generoso do que a
// elegibilidade permite, mesmo que alguém monte a chamada à mão). Mais de
// uma promoção vigente cobrindo a mesma célula (o admin deveria evitar, mas
// nada impede) resolve pela mais recente, não pela de maior desconto — é a
// mesma regra "última decisão vale" que o resto do admin já segue.
async function condicaoVigente(tier, compromissoMeses, estado = { temPlanoAtivo: false, jaAssinouAntes: false }) {
  const vigentes = (await listarVigentes()).filter((p) => elegivel(p, estado));
  for (const promo of vigentes) {
    const item = (promo.itens || []).find((i) => i.tier === tier && i.compromissoMeses === Number(compromissoMeses));
    if (item) return { promocao: promo, descontoPercentual: item.descontoPercentual };
  }
  return null;
}

// Vantagem promocional (D1, rodada de 24/09/2026). A regra de preço NÃO
// muda: a promoção substitui o desconto do ciclo (ADR-014, a mesma conta de
// san-checkout.js#valorMensalDaConta). O que muda é o que se ANUNCIA: a
// pré-venda de produção dá 20% em todos os ciclos, e o Anual já tem 20%
// normais — ali o preço é o mesmo com ou sem promoção, e o site dizia
// "pré-venda" e "mais desconto" num ciclo que não ganha nada a mais. Decisão
// do dono: preservar a regra, não inventar percentual, e não anunciar
// vantagem onde não há. A célula só "tem vantagem" quando o preço
// promocional fica ABAIXO do preço normal daquele plano — comparação de
// preço, não de percentual, pra valer mesmo se um dia o plano tiver preço
// fora da régua do desconto. Se a promoção der MENOS que o ciclo, a regra
// atual cobraria mais caro com ela: não é anunciada, e fica registrado em
// docs/PENDENCIAS.md como decisão comercial em aberto.
function temVantagem(descontoPromocional, plano) {
  const cheio = Number(plano.valor_mensal_cheio ?? plano.valor_mensal);
  const promocional = arredondar(cheio - percentual(cheio, Number(descontoPromocional || 0)));
  return promocional < Number(plano.valor_mensal);
}

// Marca cada célula da promoção com `temVantagem` contra os planos à venda e
// resume os ciclos em que ela vale de fato (`ciclosComVantagem`) — é o que a
// Home e a página de Planos usam pra não prometer desconto a mais no ciclo
// errado. Célula sem plano à venda correspondente não tem vantagem nenhuma
// (não dá pra comprar).
function comVantagem(promocao, planos) {
  const itens = (promocao.itens || []).map((i) => {
    const plano = planos.find((p) => p.tier === i.tier && Number(p.compromisso_meses) === Number(i.compromissoMeses));
    return { ...i, temVantagem: plano ? temVantagem(i.descontoPercentual, plano) : false };
  });
  const ciclosComVantagem = [
    ...new Set(itens.filter((i) => i.temVantagem).map((i) => Number(i.compromissoMeses))),
  ].sort((a, b) => a - b);
  return { ...promocao, itens, ciclosComVantagem };
}

module.exports = {
  listarTodas,
  buscarPorId,
  criar,
  atualizar,
  excluir,
  listarVigentes,
  estadoComercialDaConta,
  elegivel,
  condicaoVigente,
  temVantagem,
  comVantagem,
};
