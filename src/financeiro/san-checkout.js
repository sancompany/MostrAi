const crypto = require('crypto');
const pool = require('../db/pool');
const planosRepo = require('./planos-repository');
const anunciantesRepo = require('../anunciantes/repository');
const assinaturasRepo = require('./assinaturas-repository');
const { enviarConfirmacaoPagamento } = require('./email');

// Protege as rotas que o San Checkout chama de volta e as que a Vitrina
// chama nele (mesma chave nos dois sentidos — INTEGRACAO.md seção 6/6.1).
// Comparação em tempo constante e que NUNCA passa com segredo vazio. O
// `!==` de antes deixava a rota aberta se a env var sumisse do ambiente
// (undefined !== undefined é falso), e o tempo de resposta do === vaza
// prefixo da chave pra quem mede.
function chaveConfere(enviada, esperada) {
  if (!esperada || !enviada) return false;
  const a = Buffer.from(String(enviada));
  const b = Buffer.from(String(esperada));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function exigirChaveCheckout(req, res, next) {
  if (!chaveConfere(req.headers['x-checkout-key'], process.env.SAN_CHECKOUT_KEY)) {
    return res.status(401).json({ erro: 'chave inválida' });
  }
  next();
}

// Webhook agora falha FECHADO. Antes, sem SAN_CHECKOUT_WEBHOOK_SECRET
// configurado, ele aceitava qualquer POST — e como o corpo é só
// { tipo, planoId, evento }, bastava ter o id da assinatura (que aparece na
// própria URL de checkout do anunciante) pra ativar uma conta sem pagar.
// Configure SAN_CHECKOUT_WEBHOOK_SECRET nos dois lados antes de subir.
function webhookAutorizado(req) {
  return chaveConfere(req.headers['x-webhook-secret'], process.env.SAN_CHECKOUT_WEBHOOK_SECRET);
}

function linkCheckoutAssinatura(assinaturaId) {
  return `${process.env.SAN_CHECKOUT_BASE_URL}/index.html?c=${process.env.SAN_CHECKOUT_CONTRATANTE_ID}&assinatura=${assinaturaId}`;
}

// Compromisso em meses → ciclo nativo da Asaas (repassado direto pelo San
// Checkout, confirmado). A Asaas cobra o valor cheio automaticamente nesse
// cadência pra sempre — sem callback por ciclo, sem contador pra manter.
const CICLO_ASAAS = { 1: 'MONTHLY', 3: 'QUARTERLY', 6: 'SEMIANNUALLY', 12: 'YEARLY' };

// GET /plano/:id — mas o `:id` aqui é o id da linha em `assinaturas`, não um
// SKU de catálogo (ver migration 011). Isso é o que permite: (1) devolver
// `pagador` já preenchido com os dados reais do anunciante, sem depender de
// URL carregar isso; (2) o webhook voltar com esse mesmo id e a correlação
// ser exata, sem bater CPF digitado na tela.
//
// Chamado uma vez só, na criação da assinatura — a Asaas fixa o valor e o
// ciclo nesse momento e cobra sozinha dali em diante.
async function montarRespostaPlano(assinaturaId) {
  const assinatura = await assinaturasRepo.buscarPorId(assinaturaId);
  if (!assinatura || assinatura.status !== 'ativa') return null;

  const plano = await planosRepo.buscarPorId(assinatura.plano_id);
  const anunciante = await anunciantesRepo.buscarPorId(assinatura.anunciante_id);
  if (!plano || !anunciante) return null;

  return {
    planoId: assinatura.id,
    nome: plano.nome,
    descricao: `Mostraí — ${plano.nome}, ciclo de ${plano.compromisso_meses} ${plano.compromisso_meses === 1 ? 'mês' : 'meses'}`,
    valor: valorMensalDaConta(anunciante, plano) * plano.compromisso_meses,
    ciclo: CICLO_ASAAS[plano.compromisso_meses] || 'MONTHLY',
    pagador: {
      nome: anunciante.nome_empresa,
      email: anunciante.contato_email,
      documento: anunciante.cpf_cnpj,
      telefone: anunciante.contato_telefone,
    },
  };
}

// O preço travado é da conta NAQUELE plano: trocar de plano solta a trava
// (senão o fundador de R$149 levaria o preço pro plano Máximo).
function valorMensalDaConta(anunciante, plano) {
  const travado = anunciante.valor_mensal_travado != null && anunciante.plano_id === plano.id;
  return travado ? Number(anunciante.valor_mensal_travado) : Number(plano.valor_mensal);
}

async function registrarPendencia(payload, motivo) {
  await pool.query(
    `INSERT INTO eventos_assinatura_pendentes (payload, motivo) VALUES ($1,$2)`,
    [JSON.stringify(payload), motivo]
  );
}

// `db` é o pool por padrão, mas o webhook passa o client da transação pra
// que a comissão entre junto com a cobrança — ou não entre nenhuma das duas.
async function registrarComissaoSeHouver(anunciante, valor, db = pool) {
  if (!anunciante.indicado_por_cupom || !valor) return;
  // Vendedor é papel da conta única (migration 019). Cupom em maiúsculas pra
  // não perder comissão por caixa diferente.
  const { rows } = await db.query(
    `SELECT v.* FROM vendedores v JOIN anunciantes a ON a.id = v.conta_id
     WHERE v.codigo_cupom = upper($1) AND v.status = 'aprovado' AND a.excluido_em IS NULL`,
    [anunciante.indicado_por_cupom]
  );
  const vendedor = rows[0];
  if (!vendedor || vendedor.conta_id === anunciante.id) return; // ninguém ganha comissão de si mesmo

  const comissaoValor = Number(valor) * (Number(vendedor.comissao_percentual) / 100);
  await db.query(
    `INSERT INTO comissoes (vendedor_conta_id, anunciante_id, valor_confirmado, comissao_valor)
     VALUES ($1,$2,$3,$4)`,
    [vendedor.conta_id, anunciante.id, valor, comissaoValor]
  );
}

// Handler do POST /webhook/san-checkout pro evento de assinatura
// (INTEGRACAO.md 6.1): { tipo: "assinatura", planoId, documento, evento }.
// Aqui `planoId` é o id da nossa linha em `assinaturas` (ver montarRespostaPlano).
// Só 'cobranca_confirmada' ativa automaticamente — os outros eventos
// (falhou/estornada/cancelada exceto cancelamento, criada) só ficam
// registrados pro admin revisar, pra nunca derrubar o acesso de alguém sem
// intervenção humana.
// Chave de deduplicação do evento. Se o San Checkout mandar um id próprio,
// usa ele; senão, o hash do corpo — que já barra a reentrega idêntica, que é
// o caso real (retry por timeout).
// Sem id, entra o dia na chave: reentrega por timeout chega em minutos e
// dedupa; a renovação do ciclo seguinte chega meses depois com o mesmo corpo
// e precisa passar. (Confirmar na auditoria do Checkout se ele manda id.)
function chaveDoEvento(payload) {
  if (payload.eventoId || payload.cobrancaId) return String(payload.eventoId || payload.cobrancaId);
  const dia = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${dia}|${JSON.stringify(payload)}`).digest('hex');
}

async function processarWebhookAssinatura(payload) {
  if (payload.tipo !== 'assinatura') {
    return registrarPendencia(payload, 'formato de webhook não reconhecido (esperava tipo=assinatura)');
  }

  // Reentrega do mesmo evento não pode estender cobertura, gravar outra
  // cobrança nem pagar a comissão do vendedor de novo (migration 018).
  const { rowCount } = await pool.query(
    'INSERT INTO webhooks_processados (id) VALUES ($1) ON CONFLICT DO NOTHING',
    [chaveDoEvento(payload)]
  );
  if (!rowCount) return;

  const assinatura = await assinaturasRepo.buscarPorId(payload.planoId);
  if (!assinatura) {
    return registrarPendencia(payload, `assinatura '${payload.planoId}' não encontrada`);
  }

  if (payload.evento === 'cancelada') {
    await assinaturasRepo.marcarCancelada(assinatura.id);
    return; // cobertura já paga continua valendo até data_expiracao — não derruba na hora
  }

  if (payload.evento !== 'cobranca_confirmada') {
    return registrarPendencia(payload, `evento '${payload.evento}' recebido, sem ação automática nesta fase`);
  }

  const plano = await planosRepo.buscarPorId(assinatura.plano_id);
  const anunciante = await anunciantesRepo.buscarPorId(assinatura.anunciante_id);
  if (!plano || !anunciante) return registrarPendencia(payload, 'plano ou anunciante não encontrado pra essa assinatura');

  // O que a conta paga é o que estava travado na primeira cobrança deste
  // plano (preco_travado) — senão, o valor atual do plano.
  const valorMensal = valorMensalDaConta(anunciante, plano);
  const valorCiclo = valorMensal * plano.compromisso_meses;
  const mesmoPlano = anunciante.plano_id === plano.id;

  // Cobertura e cobrança andam pelo MESMO calendário, e é o único desenho
  // que o motor de pagamento suporta: o San Checkout cobra no ato da
  // assinatura e a cada `ciclo` a partir dali — sem carência, sem mês grátis
  // e sem pular ciclo (API.md do Checkout, seção 7.5). Qualquer coisa que
  // fizesse a cobertura começar num dia diferente do da cobrança era promessa
  // que o motor não cumpre, e saiu na migration 021. Benefício se dá no
  // PREÇO (o valor que o nosso GET /plano/{id} devolve), nunca no tempo.
  const mesesDoCiclo = plano.compromisso_meses;
  const baseExpiracao = anunciante.data_expiracao && new Date(anunciante.data_expiracao) > new Date()
    ? new Date(anunciante.data_expiracao)
    : new Date();
  const novaExpiracao = new Date(baseExpiracao);
  novaExpiracao.setMonth(novaExpiracao.getMonth() + mesesDoCiclo);

  // Ativar a conta, registrar a cobrança e a comissão têm que ser tudo ou
  // nada: antes eram três queries soltas, e se a segunda falhasse a conta
  // ficava ativa sem cobrança registrada.
  const cliente = await pool.connect();
  let cobrancaRows;
  try {
    await cliente.query('BEGIN');
    // A expiração é estendida a cada ciclo pago; quem paga dois ciclos
    // seguidos recebe os dois. Trava de preço: mantém a da conta se for o
    // mesmo plano; plano novo trava no preço dele (se for travado) ou solta.
    await cliente.query(
      `UPDATE anunciantes
       SET plano_id = $2, status = 'ativo',
           data_inicio_cobertura = COALESCE(data_inicio_cobertura, now()),
           data_expiracao = $3::timestamptz,
           valor_mensal_travado = CASE WHEN NOT $4::boolean THEN NULL
                                       WHEN $5::boolean THEN COALESCE(valor_mensal_travado, $6::numeric)
                                       ELSE $6::numeric END
       WHERE id = $1`,
      [anunciante.id, plano.id, novaExpiracao,
        !!plano.preco_travado, mesmoPlano, plano.valor_mensal]
    );
    ({ rows: cobrancaRows } = await cliente.query(
      `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, nota_fiscal_status)
       VALUES ($1,$2,$3,'pendente') RETURNING id`,
      [anunciante.id, plano.id, valorCiclo]
    ));
    await registrarComissaoSeHouver(anunciante, valorCiclo, cliente);
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK');
    // Sem isso, o retry do San Checkout cairia na dedupe acima e o evento
    // seria perdido de vez.
    await pool.query('DELETE FROM webhooks_processados WHERE id = $1', [chaveDoEvento(payload)]);
    throw err;
  } finally {
    cliente.release();
  }

  enviarConfirmacaoPagamento(anunciante, plano, valorCiclo).catch((err) => {
    console.error('falha ao enviar e-mail de confirmação', err);
  });

  return cobrancaRows[0];
}

// Cancelamento é sempre a Vitrina quem aciona (nunca o pagador direto no
// checkout — INTEGRACAO.md 6.1). Formato do corpo confirmado com quem
// administra o San Checkout (v2, campo `documento` — CPF ou CNPJ).
async function cancelarAssinatura(assinaturaId, documento) {
  const r = await fetch(`${process.env.SAN_CHECKOUT_BASE_URL}/cancelar-assinatura`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Checkout-Key': process.env.SAN_CHECKOUT_KEY },
    body: JSON.stringify({ planoId: assinaturaId, documento }),
  });
  if (!r.ok) throw new Error('falha ao cancelar assinatura no San Checkout');
  return r.json();
}

module.exports = {
  exigirChaveCheckout, webhookAutorizado, linkCheckoutAssinatura, montarRespostaPlano,
  processarWebhookAssinatura, cancelarAssinatura,
};
