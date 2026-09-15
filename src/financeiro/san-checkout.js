const crypto = require('node:crypto');
const pool = require('../db/pool');
const { multiplicar, percentual } = require('../lib/dinheiro');
const { segredoConfere } = require('../lib/segredo');
const planosRepo = require('./planos-repository');
const anunciantesRepo = require('../anunciantes/repository');
const assinaturasRepo = require('./assinaturas-repository');
const { enviarConfirmacaoPagamento } = require('./email');
const eventos = require('../lib/eventos');

// Protege as rotas que o San Checkout chama de volta e as que a Vitrina
// chama nele (mesma chave nos dois sentidos — INTEGRACAO.md seção 6/6.1).
// Comparação em tempo constante e que NUNCA passa com segredo vazio. O
// `!==` de antes deixava a rota aberta se a env var sumisse do ambiente
// (undefined !== undefined é falso), e o tempo de resposta do === vaza
// prefixo da chave pra quem mede.
const chaveConfere = segredoConfere;

function exigirChaveCheckout(req, res, next) {
  if (!chaveConfere(req.headers['x-checkout-key'], process.env.SAN_CHECKOUT_KEY)) {
    return res.status(401).json({ erro: 'chave inválida' });
  }
  next();
}

// O Checkout assina TODO webhook com HMAC-SHA256 e manda dois headers
// (API.md dele, 4.3 e 4.3.1): `X-Checkout-Signature: sha256=<hex>` sobre a
// string "{timestamp}.{corpo cru}", e `X-Checkout-Timestamp` em segundos.
// Não existe segredo separado de webhook: o segredo é a MESMA
// SAN_CHECKOUT_KEY que usamos nas chamadas de saída.
//
// O que havia aqui era um header `X-Webhook-Secret` comparado com uma
// SAN_CHECKOUT_WEBHOOK_SECRET — esquema que o Checkout nunca mandou e que
// nenhuma versão do contrato descreveu (o comentário citava o INTEGRACAO.md,
// que hoje é só um redirecionamento pro API.md). O fail-closed segurava o
// dinheiro, mas TODO webhook real tomava 401: nenhum pagamento era creditado
// e a conta só seria ativada pela conciliação diária.
const JANELA_ASSINATURA_S = 300;

function webhookAutorizado(req) {
  const chave = process.env.SAN_CHECKOUT_KEY;
  const recebida = req.headers?.['x-checkout-signature'];
  const timestamp = String((req.headers?.['x-checkout-timestamp']) || '');
  if (!chave || !recebida || !/^[0-9]{1,15}$/.test(timestamp)) return false;

  // Janela de 300s: impede que alguém capture um webhook legítimo e reenvie
  // depois (API.md 4.3.1, passo 1).
  const agora = Math.floor(Date.now() / 1000);
  if (Math.abs(agora - Number(timestamp)) > JANELA_ASSINATURA_S) return false;

  // Corpo CRU, nunca o JSON reparseado: reserializar muda a ordem das chaves
  // e a assinatura não fecha (API.md 4.3.1, passo 2). Quem guarda os bytes
  // originais é o `verify` do express.json, em src/server.js.
  const corpoCru = req.rawBody;
  if (!Buffer.isBuffer(corpoCru)) return false;

  const esperada = 'sha256=' + crypto
    .createHmac('sha256', chave)
    .update(Buffer.concat([Buffer.from(timestamp + '.', 'utf8'), corpoCru]))
    .digest('hex');

  return chaveConfere(recebida, esperada);
}

// O checkout mora em DOIS endereços e eles fazem coisas diferentes (API.md do
// Checkout, seção 2.1): a tela de pagamento, que o comprador abre no
// navegador, e a API, que o nosso servidor chama. Usar um só para os dois
// deixa necessariamente um dos lados errado — era o que acontecia aqui até
// 14/09/2026. SAN_CHECKOUT_BASE_URL é a TELA; SAN_CHECKOUT_API_URL é a API.
// `returnUrl` leva o cliente de volta pra cá depois de pagar. Sem ele, a
// pessoa sai do site num domínio que não é o nosso, paga, e fica parada numa
// tela de outra empresa sem nenhum caminho de volta — o momento de maior
// confiança da relação terminava num beco.
// PENDENTE de confirmação com quem administra o San Checkout: se ele ignorar
// o parâmetro, não quebra nada (é query string a mais), mas o retorno
// automático só funciona quando ele o respeitar. A página de destino já existe.
function linkCheckoutAssinatura(assinaturaId) {
  const volta = process.env.SITE_URL ? `&returnUrl=${encodeURIComponent(`${process.env.SITE_URL}/obrigado.html`)}` : '';
  return `${process.env.SAN_CHECKOUT_BASE_URL}/index.html?c=${process.env.SAN_CHECKOUT_CONTRATANTE_ID}&assinatura=${assinaturaId}${volta}`;
}

// Toda rota de servidor do checkout vive sob /api/checkout (API.md seção 12).
// O endereço nunca é montado à mão fora daqui — é a nota da seção 2.1, e foi
// uma troca de endereço não propagada que quebrou a integração antes.
async function chamarApiCheckout(rota, corpo) {
  return fetch(`${process.env.SAN_CHECKOUT_API_URL}/api/checkout/${rota}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Checkout-Key': process.env.SAN_CHECKOUT_KEY },
    body: JSON.stringify(corpo),
  });
}

// Conciliação de assinatura (API.md seção 5.3). É a única fonte do `chargeId`
// — o payload do webhook de assinatura não carrega nenhum id (seção 4.3.4) —
// e ela reconsulta a Asaas quando a última cobrança parece pendente, então
// enxerga pagamento que o webhook perdeu. Devolve null se nunca houve
// assinatura nem tentativa de cobrança (404 estreito, de propósito).
async function consultarAssinatura(planoId, documento) {
  const r = await chamarApiCheckout('consultar-assinatura', { planoId, documento });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`consultar-assinatura respondeu ${r.status}`);
  return r.json();
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
  if (assinatura?.status !== 'ativa') return null;

  const plano = await planosRepo.buscarPorId(assinatura.plano_id);
  const anunciante = await anunciantesRepo.buscarPorId(assinatura.anunciante_id);
  if (!plano || !anunciante) return null;

  return {
    planoId: assinatura.id,
    nome: plano.nome,
    descricao: `Mostraí — ${plano.nome}, ciclo de ${plano.compromisso_meses} ${plano.compromisso_meses === 1 ? 'mês' : 'meses'}`,
    valor: multiplicar(valorMensalDaConta(anunciante, plano), plano.compromisso_meses),
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

  const comissaoValor = percentual(valor, vendedor.comissao_percentual);
  await db.query(
    `INSERT INTO comissoes (vendedor_conta_id, anunciante_id, valor_confirmado, comissao_valor)
     VALUES ($1,$2,$3,$4)`,
    [vendedor.conta_id, anunciante.id, valor, comissaoValor]
  );
  // Dono do evento é o VENDEDOR, não quem comprou: a pergunta é "quanto a
  // indicação custa", e ela se responde por vendedor.
  eventos.registrar('comissao:vendedor_gera', {
    anunciante_id: vendedor.conta_id,
    vendedor_id: vendedor.conta_id,
    comissao_valor: comissaoValor,
    valor_confirmado: valor,
  });
}

// Handler do POST /webhook/san-checkout pro evento de assinatura
// (API.md do Checkout, 4.3.4): { versao, tipo, planoId, documento, evento }.
// Aqui `planoId` é o id da nossa linha em `assinaturas` (ver montarRespostaPlano).
//
// A PRIMEIRA cobrança paga de uma assinatura chega como 'criada'; só as
// RENOVAÇÕES chegam como 'cobranca_confirmada'. Está na tabela do API.md
// 4.3.4 ("Assinatura criada e primeira cobrança paga") e no código do
// Checkout, que cai no default `confirmado ? 'criada' : null` quando o
// evento não é de ciclo recorrente. Tratar só 'cobranca_confirmada' deixava
// justamente a entrada de todo assinante novo sem ativação automática — o
// caso que mais importa.
//
// Os demais eventos (falhou/estornada/contestada, e cancelada fora do ramo
// abaixo) só ficam registrados pro admin revisar, pra nunca derrubar o
// acesso de alguém sem intervenção humana.
const EVENTOS_QUE_CREDITAM = new Set(['criada', 'cobranca_confirmada']);
// Chave de deduplicação do evento. O contrato manda tratar o processamento
// como idempotente pela chave natural `chargeId` + `status` (API.md do
// Checkout, 4.3.6) — só que o payload de assinatura NÃO carrega chargeId
// nenhum: ele tem cinco campos, versao, tipo, planoId, documento e evento
// (4.3.4). Sem id, o corpo de uma renovação é byte a byte idêntico ao da
// anterior.
//
// O que havia aqui era hash(dia|corpo), e ele erra nas duas pontas: a
// retentativa que cruza a meia-noite muda de dia, passa pela dedupe e credita
// um ciclo que ninguém pagou; e duas cobranças reais no mesmo dia viram uma.
//
// Então, nos eventos que mexem em saldo ('criada' e 'cobranca_confirmada'),
// o chargeId é buscado na rota de conciliação (5.3) e a chave é a que o
// contrato pede. Os outros eventos só gravam pendência, não movem dinheiro,
// e seguem com o hash do corpo + dia.
async function chaveDoEvento(payload) {
  if (payload.eventoId || payload.cobrancaId) return String(payload.eventoId || payload.cobrancaId);

  if (EVENTOS_QUE_CREDITAM.has(payload.evento)) {
    const estado = await consultarAssinatura(payload.planoId, payload.documento);
    const ultima = estado?.ultimaCobranca;
    if (!ultima?.chargeId) throw new Error('checkout não devolveu ultimaCobranca.chargeId');
    return `${ultima.chargeId}|${ultima.status}`;
  }

  const dia = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${dia}|${JSON.stringify(payload)}`).digest('hex');
}

async function processarWebhookAssinatura(payload) {
  if (payload.tipo !== 'assinatura') {
    return registrarPendencia(payload, 'formato de webhook não reconhecido (esperava tipo=assinatura)');
  }

  let chave;
  try {
    chave = await chaveDoEvento(payload);
  } catch (err) {
    // Sem a chave natural não há como garantir idempotência, e creditar sem
    // garantia é dar cobertura que talvez já tenha sido dada. Fica pendente:
    // a conciliação diária (`npm run conciliar`) enxerga a cobrança e aplica.
    // É o papel que o próprio contrato dá a ela (4.3.6).
    return registrarPendencia(payload, `sem chargeId pra deduplicar: ${err.message}`);
  }

  // Reentrega do mesmo evento não pode estender cobertura, gravar outra
  // cobrança nem pagar a comissão do vendedor de novo (migration 018).
  const { rowCount } = await pool.query(
    'INSERT INTO webhooks_processados (id) VALUES ($1) ON CONFLICT DO NOTHING',
    [chave]
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

  if (!EVENTOS_QUE_CREDITAM.has(payload.evento)) {
    return registrarPendencia(payload, `evento '${payload.evento}' recebido, sem ação automática nesta fase`);
  }

  return aplicarCicloPago(assinatura, chave, payload);
}

// Credita um ciclo pago na conta: estende a cobertura, registra a cobrança e
// a comissão. Chamado pelo webhook e pela conciliação diária — as duas rotas
// passam pela mesma dedupe (`chave`), então um ciclo nunca entra duas vezes,
// venha o aviso por webhook ou pela varredura.
async function aplicarCicloPago(assinatura, chave, payload = null) {
  const contexto = payload || { tipo: 'assinatura', planoId: assinatura.id, evento: 'cobranca_confirmada', origem: 'conciliacao' };

  const plano = await planosRepo.buscarPorId(assinatura.plano_id);
  const anunciante = await anunciantesRepo.buscarPorId(assinatura.anunciante_id);
  if (!plano || !anunciante) {
    await pool.query('DELETE FROM webhooks_processados WHERE id = $1', [chave]);
    return registrarPendencia(contexto, 'plano ou anunciante não encontrado pra essa assinatura');
  }

  // O que a conta paga é o que estava travado na primeira cobrança deste
  // plano (preco_travado) — senão, o valor atual do plano.
  const valorMensal = valorMensalDaConta(anunciante, plano);
  const valorCiclo = multiplicar(valorMensal, plano.compromisso_meses);
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
    await pool.query('DELETE FROM webhooks_processados WHERE id = $1', [chave]);
    // E sem isto, a falha só existia no console: o dinheiro entrou no
    // Checkout, a cobertura não entrou aqui, e nenhuma tela mostrava isso.
    // Agora cai na fila de "eventos pendentes" do admin, que é onde alguém
    // olha. Se o próprio registro da pendência falhar, o erro original é que
    // tem que subir — por isso o catch aninhado.
    try {
      await registrarPendencia(contexto, `falha ao aplicar o ciclo pago: ${err.message}`);
    } catch (err2) {
      console.error('falha ao registrar a pendência do ciclo', err2);
    }
    throw err;
  } finally {
    cliente.release();
  }

  // Só depois do COMMIT: evento de receita que existisse sem a cobrança no
  // banco mentiria o número mais importante do projeto.
  const { rows: ciclos } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM cobrancas_confirmadas WHERE anunciante_id = $1 AND plano_id = $2',
    [anunciante.id, plano.id],
  );
  eventos.registrar('pagamento:cobranca_confirma', {
    plano_id: plano.id,
    valor_confirmado: valorCiclo,
    ciclo_numero: ciclos[0].n,
  }, anunciante);

  enviarConfirmacaoPagamento(anunciante, plano, valorCiclo).catch((err) => {
    console.error('falha ao enviar e-mail de confirmação', err);
  });

  return cobrancaRows[0];
}

// Cancelamento é sempre a Vitrina quem aciona (nunca o pagador direto no
// checkout — INTEGRACAO.md 6.1). Formato do corpo confirmado com quem
// administra o San Checkout (v2, campo `documento` — CPF ou CNPJ).
async function cancelarAssinatura(assinaturaId, documento) {
  const r = await chamarApiCheckout('cancelar-assinatura', { planoId: assinaturaId, documento });
  if (!r.ok) throw new Error('falha ao cancelar assinatura no San Checkout');
  return r.json();
}

module.exports = {
  valorMensalDaConta,
  exigirChaveCheckout, webhookAutorizado, linkCheckoutAssinatura, montarRespostaPlano,
  processarWebhookAssinatura, cancelarAssinatura, consultarAssinatura,
  chaveDoEvento, aplicarCicloPago,
};
