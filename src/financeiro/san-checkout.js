const crypto = require('node:crypto');
const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const { arredondar, multiplicar, percentual } = require('../lib/dinheiro');
const { segredoConfere } = require('../lib/segredo');
const planosRepo = require('./planos-repository');
const anunciantesRepo = require('../anunciantes/repository');
const assinaturasRepo = require('./assinaturas-repository');
const pedidosRepo = require('./pedidos-repository');
const { enviarConfirmacaoPagamento, enviarCobrancaFalhou, enviarTrocaDePlano } = require('./email');
const eventos = require('../lib/eventos');
const indicacoesRepo = require('../indicacoes/repository');
const creditosRepo = require('../creditos/repository');
const notificacoesRepo = require('../creditos/notificacoes');
const sse = require('../lib/sse');
const planoAdministrativo = require('./plano-administrativo');
const cicloContratado = require('./ciclo-contratado');

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
  const timestamp = String(req.headers?.['x-checkout-timestamp'] || '');
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

  const esperada =
    'sha256=' +
    crypto
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
// Confirmado contra o API.md do Checkout (seção 3.1, atualizado 15/09/2026):
// a origem só precisa estar em `retornoDominios` quando vitrine e API vivem em
// hosts diferentes. Aqui SITE_URL É a origem do apiBaseUrl (mesmo domínio serve
// site e API), que "vale sempre, sem cadastrar nada" — nada a combinar.
function linkCheckoutAssinatura(assinaturaId) {
  const volta = process.env.SITE_URL ? `&returnUrl=${encodeURIComponent(`${process.env.SITE_URL}/obrigado.html`)}` : '';
  return `${process.env.SAN_CHECKOUT_BASE_URL}/index.html?c=${process.env.SAN_CHECKOUT_CONTRATANTE_ID}&assinatura=${assinaturaId}${volta}`;
}

// TOKEN DE RENOVAÇÃO — mudança incompatível do Checkout em 16/09/2026.
//
// Até então bastava `&renovar=1`. O Checkout confiava no `documento` que o
// próprio formulário coletava, e CPF/CNPJ não é segredo: quem soubesse o
// documento de um assinante ativo montava o link, pagava com o PRÓPRIO
// cartão e, ao confirmar, fazia o Checkout cancelar a assinatura de verdade
// da vítima na Asaas. Agora o `renovar` tem que ser um HMAC-SHA256 assinado
// com a nossa `SAN_CHECKOUT_KEY` (API.md 7.3 dele).
//
// O QUE ACONTECE SE O TOKEN NÃO BATER: o Checkout não recusa — ele degrada
// pra "assinatura nova comum", cria e cobra, e NÃO cancela a antiga. Do
// nosso lado isso é o pior caso possível: o cliente passa a ter duas
// assinaturas na Asaas e pode ser cobrado duas vezes. Por isso aqui o token
// ausente devolve `null` e o e-mail sai sem link, em vez de sair com um link
// que cobra em dobro calado.
//
// O DOCUMENTO VAI SÓ COM DÍGITOS, e NÃO pelo nosso `limpar()`. A pop-up do
// Checkout manda `documento.replace(/\D/g, '')` (public/js/app.js dele), e o
// HMAC é conferido contra exatamente o que ela manda. O nosso `limpar()`
// PRESERVA LETRAS, porque CNPJ é alfanumérico desde julho de 2026 — usar ele
// aqui faria o token nunca bater pra empresa com letra no CNPJ, e o sintoma
// seria cobrança dobrada, não erro. Espelhar a pop-up é o que faz bater.
const soDigitos = (valor) => String(valor || '').replace(/\D/g, '');

// `contato_telefone` é guardado em E.164 (+5516994635946, ver telefoneE164
// em src/br/formato.js) pra virar link de WhatsApp — mas o Checkout quer
// telefone só com DDD, 10 ou 11 dígitos (API.md dele, seção 9.2). Mandando o
// E.164 direto, o "55" do país virava o DDD que a Asaas lia, e o resto do
// número desalinhava (achado em produção, 19/09/2026: "(55) 16993-4443" em
// vez de "(16) 99463-5946"). Mesma suposição de telefoneExibicao (o campo
// sempre entra em E.164 pelas duas rotas de cadastro): tira só o "55" do
// início.
const telefoneNacional = (valor) => soDigitos(valor).replace(/^55/, '');

function tokenRenovacao(assinaturaId, documento) {
  const chave = process.env.SAN_CHECKOUT_KEY;
  if (!chave || !documento) return null;
  const agora = Math.floor(Date.now() / 1000);
  const mensagem = `${agora}.${process.env.SAN_CHECKOUT_CONTRATANTE_ID}.${assinaturaId}.${documento}`;
  return `${agora}.${crypto.createHmac('sha256', chave).update(mensagem).digest('hex')}`;
}

// Link de RENOVAÇÃO (API.md 7.3): cartão vencido ou cobrança recusada. É o
// mesmo link de assinar, com o token acima — o Checkout sabe que é troca de
// cartão de uma assinatura existente, não uma nova. A assinatura antiga só é
// cancelada quando a nova for paga, então o assinante nunca fica descoberto
// entre uma tentativa e outra.
//
// Devolve `null` quando não dá pra assinar o token (sem chave no ambiente ou
// sem documento na conta). Quem chama decide o que fazer — nunca mandar o
// link sem token.
function linkRenovarAssinatura(assinaturaId, cpfCnpj) {
  const token = tokenRenovacao(assinaturaId, soDigitos(cpfCnpj));
  return token ? `${linkCheckoutAssinatura(assinaturaId)}&renovar=${token}` : null;
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
  const r = await chamarApiCheckout('consultar-assinatura', { planoId, documento: soDigitos(documento) });
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
//
// 'pendente_troca' também serve esta resposta (migration 056): é o status
// da linha nova, criada ANTES de chamar POST /trocar-plano — o Checkout lê
// o preço/ciclo de destino por aqui (`resolverPlano`, do lado dele) antes
// de cobrar o acerto. Só não é servida quando a troca falha e a linha some.
// 'pendente_pagamento' (migration 089): é o estado normal entre gerar o
// link e o Checkout confirmar a primeira cobrança — o GET /plano acontece
// exatamente nessa janela.
const STATUS_QUE_SERVEM_PLANO = new Set(['pendente_pagamento', 'ativa', 'pendente_troca']);

async function montarRespostaPlano(assinaturaId) {
  const assinatura = await assinaturasRepo.buscarPorId(assinaturaId);
  if (!STATUS_QUE_SERVEM_PLANO.has(assinatura?.status)) return null;

  const plano = await planosRepo.buscarPorId(assinatura.plano_id);
  const anunciante = await anunciantesRepo.buscarPorId(assinatura.anunciante_id);
  if (!plano || !anunciante) return null;

  return {
    planoId: assinatura.id,
    nome: plano.nome,
    // Só o `nome` já vira o título na tela do Checkout, e o `ciclo` abaixo já
    // gera o rótulo "cobrança mensal/trimestral/..." sozinho — descricao
    // repetindo os dois virava "Mostraí — Pro, ciclo de 3 meses — cobrança
    // trimestral" (achado em produção, 19/09/2026): nome duplicado, ciclo
    // duplicado, e travessão que não pode aparecer em texto nenhum do site.
    descricao: 'Espaço publicitário na rede Mostraí.',
    valor: multiplicar(valorMensalDaConta(anunciante, plano, assinatura), plano.compromisso_meses),
    ciclo: CICLO_ASAAS[plano.compromisso_meses] || 'MONTHLY',
    pagador: {
      nome: anunciante.nome_empresa,
      email: anunciante.contato_email,
      documento: anunciante.cpf_cnpj,
      telefone: telefoneNacional(anunciante.contato_telefone),
    },
  };
}

// `assinatura` é opcional (várias chamadas antigas não tinham como passar) —
// quando vem, e carrega uma condição promocional ainda dentro do prazo
// prometido (`promocao_valido_ate`, rodada de Ofertas/Promoções,
// 22/09/2026), o desconto promocional SUBSTITUI o desconto do ciclo na base
// (mesma régua da vitrine pública, public/planos.page.js: a promoção é o
// preço de tabela daquele ciclo enquanto vale, não mais um percentual em
// cima do preço de tabela normal) — o desconto de parceiro continua entrando
// DEPOIS, em cima dessa base, porque é direito da CONTA, não do ciclo.
// É um SNAPSHOT da assinatura, travado no instante da adesão (ver
// promocoes-repository.js#condicaoVigente e o ponto de criação em
// financeiro/routes.js) — preço-base mudando depois, ou a promoção sendo
// editada/encerrada, não afeta quem já aderiu até o prazo acabar (Parte T
// do pedido: nunca recalcula retroativamente).
function valorMensalDaConta(anunciante, plano, assinatura) {
  const promoAtiva = assinatura?.promocao_valido_ate && new Date(assinatura.promocao_valido_ate) > new Date();
  const base = promoAtiva
    ? arredondar(
        Number(plano.valor_mensal_cheio ?? plano.valor_mensal) -
          percentual(
            Number(plano.valor_mensal_cheio ?? plano.valor_mensal),
            Number(assinatura.promocao_desconto_percentual || 0),
          ),
      )
    : Number(plano.valor_mensal);

  // Nenhum desconto de comodato entra no preço: nem o percentual por plano
  // (`desconto_comodato_percentual`, sem efeito desde 23/09/2026) nem o
  // crédito em reais da conta (sem efeito desde 24/09/2026, abaixo).
  const descontoParceiro =
    anunciante.status === 'parceiro' && plano.compromisso_meses >= (anunciante.parceiro_compromisso_minimo || 0)
      ? Number(anunciante.parceiro_desconto_percentual || 0)
      : 0;
  const desconto = Math.min(100, descontoParceiro);
  // O crédito monetário de R$ 50 do comodato Básico (`credito_comodato_mensal`)
  // SAIU do preço (24/09/2026, ADR-016): o benefício de ser ponto agora é
  // crédito do ledger, nunca desconto em reais. Auditoria de produção: 0
  // contas com esse crédito — ninguém tem a mensalidade alterada. A coluna
  // fica no banco como legado, sem efeito.
  return desconto ? arredondar(base - percentual(base, desconto)) : base;
}

async function registrarPendencia(payload, motivo) {
  await pool.query(`INSERT INTO eventos_assinatura_pendentes (payload, motivo) VALUES ($1,$2)`, [
    JSON.stringify(payload),
    motivo,
  ]);
  // Fila "Eventos do Checkout" do admin muda de tamanho.
  sse.emitirParaAdmin('payment.updated', {});
}

// Programa de vendedores aposentado (reconstrução de Contas, 23/09/2026,
// pedido do dono: "sem novas comissões"). A função que gerava comissão ficou
// desligada atrás de uma constante até a consolidação final (24/09/2026) e
// saiu do código: produção sem nenhum vendedor, nenhuma comissão. As tabelas
// `vendedores`/`comissoes` ficam no banco como histórico (exportação LGPD
// ainda as lê, src/titular/repository.js).

// Crédito de indicação do dono de ponto (migration 062, pedido do dono,
// 19/09/2026) — nunca move dinheiro:
// quem indica com cupom "PT-..." ganha crédito no ledger, pra resgate
// explícito depois (src/creditos/, migration 079) — CADA cobrança confirmada
// gera crédito, a primeira e toda renovação. `db` é o pool por
// padrão, mas o webhook passa o client da transação pra que crédito e
// cobrança entrem juntos, ou nenhum dos dois — mesmo padrão de sempre.
// `cobrancaConfirmadaId` é a chave de idempotência: sem ela, webhook
// duplicado ou a conciliação reprocessando geraria o mesmo crédito de novo.
async function registrarCreditoIndicacaoSeHouver(anunciante, cobrancaConfirmadaId, db = pool) {
  if (!anunciante.indicado_por_cupom) return;
  const cupom = String(anunciante.indicado_por_cupom).toUpperCase();
  if (!cupom.startsWith('PT-')) return; // cupom de vendedor — já tratado acima
  const ponto = await indicacoesRepo.buscarPontoPorCupom(cupom);
  if (!ponto || ponto.conta_id === anunciante.id) return; // ninguém ganha crédito de si mesmo

  const credito = await creditosRepo.registrarCreditoIndicacao(ponto.conta_id, anunciante.id, cobrancaConfirmadaId, db);
  if (!credito) return; // idempotência: essa cobrança já tinha gerado crédito
  // Emitido fora da transação de verdade só depois do COMMIT (quem chama faz
  // isso) — aqui só monta a intenção; ver logo abaixo, após o commit.
  return { pontoContaId: ponto.conta_id };
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
//
// 'criada' (consolidação, 24/09/2026): o Checkout manda esse evento no
// CHECKOUT_PAID, ~300 ms ANTES de a Asaas revelar o chargeId — a consulta
// 5.3 voltava sem `ultimaCobranca.chargeId`, o evento caía em pendência e o
// assinante novo só entrava no ar na conciliação do dia seguinte (aconteceu
// em produção, 15/09). A chave natural de 'criada' é a própria assinatura:
// a primeira cobrança paga de uma linha de `assinaturas` acontece uma vez
// só. O chargeId, quando já existir, é registrado DEPOIS (ver
// processarWebhookAssinatura) só para a conciliação não creditar de novo.
const chaveDaCriacao = (assinaturaId) => `criada|${assinaturaId}`;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Devolve { chave, ultima } — `ultima` (cobrança da consulta 5.3) traz o
// valor que a Asaas cobrou de fato, usado em aplicarCicloPago.
async function chaveDoEvento(payload) {
  if (payload.eventoId || payload.cobrancaId) return { chave: String(payload.eventoId || payload.cobrancaId) };

  if (payload.evento === 'criada') {
    let ultima = null;
    try {
      ultima = (await consultarAssinatura(payload.planoId, payload.documento))?.ultimaCobranca || null;
    } catch (err) {
      console.error('consulta do chargeId da primeira cobrança falhou (segue pela chave da assinatura):', err.message);
    }
    return { chave: chaveDaCriacao(payload.planoId), ultima };
  }

  if (EVENTOS_QUE_CREDITAM.has(payload.evento)) {
    // Renovação: a chave é chargeId|status (contrato 4.3.6). A Asaas pode
    // ainda não ter revelado o id no primeiro instante — três tentativas
    // curtas antes de virar pendência.
    for (let tentativa = 1; ; tentativa++) {
      const estado = await consultarAssinatura(payload.planoId, payload.documento);
      const ultima = estado?.ultimaCobranca;
      if (ultima?.chargeId) return { chave: `${ultima.chargeId}|${ultima.status}`, ultima };
      if (tentativa >= 3) throw new Error('checkout não devolveu ultimaCobranca.chargeId');
      await dormir(1500);
    }
  }

  const dia = new Date().toISOString().slice(0, 10);
  return {
    chave: crypto
      .createHash('sha256')
      .update(`${dia}|${JSON.stringify(payload)}`)
      .digest('hex'),
  };
}

async function processarWebhookAssinatura(payload) {
  if (payload.tipo !== 'assinatura') {
    return registrarPendencia(payload, 'formato de webhook não reconhecido (esperava tipo=assinatura)');
  }

  let chave;
  let ultima = null;
  try {
    ({ chave, ultima } = await chaveDoEvento(payload));
  } catch (err) {
    // Sem a chave natural não há como garantir idempotência, e creditar sem
    // garantia é dar cobertura que talvez já tenha sido dada. Fica pendente:
    // a conciliação diária (`npm run conciliar`) enxerga a cobrança e aplica.
    // É o papel que o próprio contrato dá a ela (4.3.6).
    return registrarPendencia(payload, `sem chargeId pra deduplicar: ${err.message}`);
  }

  // Reentrega do mesmo evento não pode estender cobertura, gravar outra
  // cobrança nem pagar a comissão do vendedor de novo (migration 018).
  const { rowCount } = await pool.query('INSERT INTO webhooks_processados (id) VALUES ($1) ON CONFLICT DO NOTHING', [
    chave,
  ]);
  if (!rowCount) {
    // Reentrega do MESMO evento e normal e nao precisa de barulho. Mas quando
    // o evento credita ciclo, o descarte pode nao ser reentrega: a consulta de
    // conciliacao devolve a ultima cobranca, e numa renovacao a defasagem
    // entre Asaas e Checkout faz a chave `chargeId|status` do ciclo novo
    // colidir com a do anterior — o ciclo pago some, sem cobertura e sem
    // rastro. Vira pendencia pra alguem olhar.
    // 'criada' reentregue é limpo por construção (chave = a assinatura): só
    // a renovação, chaveada por chargeId, pode esconder um ciclo novo.
    if (payload.evento === 'cobranca_confirmada') {
      await registrarPendencia(
        payload,
        `evento que credita ciclo descartado pela deduplicacao (chave ${chave}) — conferir se o ciclo entrou`,
      );
    }
    return;
  }

  const assinatura = await assinaturasRepo.buscarPorId(payload.planoId);
  if (!assinatura) {
    return registrarPendencia(payload, `assinatura '${payload.planoId}' não encontrada`);
  }

  if (payload.evento === 'cancelada') {
    await assinaturasRepo.marcarCancelada(assinatura.id);
    sse.emitirParaConta(assinatura.anunciante_id, 'plan.updated', {});
    return; // cobertura já paga continua valendo até data_expiracao — não derruba na hora
  }

  // plano_trocado: desde 21/09/2026 nem sempre é aviso redundante. Quando
  // a troca não teve acerto a cobrar (200 imediato), a aplicação já
  // aconteceu na própria chamada de POST /anunciantes/me/trocar-plano, e
  // `assinatura` já está 'ativa' — este evento só confirma o que já foi
  // feito, sem nada a fazer. Mas quando houve acerto, o Checkout responde
  // 202 e NÃO cobra nada na hora: o pagador aprova depois, numa tela dele,
  // e este webhook é o ÚNICO sinal de que a troca de fato aconteceu — a
  // linha nova continua 'pendente_troca' até aqui. `assinatura.status`
  // distingue os dois casos sem precisar guardar mais nada.
  if (payload.evento === 'plano_trocado') {
    if (assinatura.status !== 'pendente_troca') return; // já aplicada pela chamada síncrona

    const assinaturaAntiga = await assinaturasRepo.buscarPorId(payload.planoAnterior);
    const planoNovo = await planosRepo.buscarPorId(assinatura.plano_id);
    if (!assinaturaAntiga || !planoNovo) {
      return registrarPendencia(
        payload,
        'assinatura anterior ou plano novo não encontrado pra aplicar a troca aprovada no Checkout',
      );
    }
    const planoAntigo = await planosRepo.buscarPorId(assinaturaAntiga.plano_id);
    const anunciante = await anunciantesRepo.buscarPorId(assinatura.anunciante_id);
    if (!anunciante) {
      return registrarPendencia(payload, `conta '${assinatura.anunciante_id}' não encontrada pra aplicar a troca`);
    }

    // O Checkout permite mais de uma intenção pendente ao mesmo tempo
    // (API.md do Checkout, seção 5.6 — "não há bloqueio de já existe uma
    // pendente"): o pagador pode abrir a tela de troca duas vezes antes de
    // aprovar qualquer uma, e as duas aprovarem depois. Sem esta conferência,
    // a segunda aprovação a chegar sobrescreveria `anunciantes.plano_id`
    // por cima de uma troca mais nova que já tinha sido aplicada — aqui só
    // aplica se a conta ainda está exatamente no plano de onde esta
    // intenção partiu.
    if (anunciante.plano_id !== assinaturaAntiga.plano_id) {
      return registrarPendencia(
        payload,
        `conta '${anunciante.id}' já está no plano '${anunciante.plano_id}', não mais em '${assinaturaAntiga.plano_id}' — provável troca concorrente aprovada antes; não sobrescrevendo`,
      );
    }

    // Mesma escrita tudo-ou-nada da chamada síncrona (ver
    // POST /anunciantes/me/trocar-plano) — só que disparada pelo webhook
    // em vez da resposta HTTP original.
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await assinaturasRepo.marcarTrocada(assinaturaAntiga.id, cliente);
      await assinaturasRepo.marcarAtiva(assinatura.id, cliente);
      await cliente.query('UPDATE anunciantes SET plano_id = $2 WHERE id = $1', [anunciante.id, planoNovo.id]);
      // Troca = ciclo novo (migration 087): o snapshot é do CICLO do plano
      // novo (o valor que a assinatura nova cobra por ciclo), não do acerto
      // proporcional abaixo. Nunca reaproveita o snapshot do plano antigo.
      await cicloContratado.registrar(cliente, {
        anuncianteId: anunciante.id,
        plano: planoNovo,
        assinaturaId: assinatura.id,
        origem: 'troca',
        valorCiclo: multiplicar(valorMensalDaConta(anunciante, planoNovo, assinatura), planoNovo.compromisso_meses),
      });
      if (payload.acertoCobrado > 0) {
        await cliente.query(
          `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, plano_anterior_id, valor, nota_fiscal_status)
           VALUES ($1,$2,$3,$4,'pendente')`,
          [anunciante.id, planoNovo.id, assinaturaAntiga.plano_id, payload.acertoCobrado],
        );
      }
      await cliente.query('COMMIT');
    } catch (err) {
      await cliente.query('ROLLBACK');
      return registrarPendencia(
        payload,
        `troca de plano aprovada e cobrada no Checkout, mas falhou ao gravar aqui: ${err.message}`,
      );
    } finally {
      cliente.release();
    }

    eventos.registrar(
      'plano:troca_paga',
      { plano_id: planoNovo.id, valor_confirmado: Number(payload.acertoCobrado || 0) },
      anunciante,
    );
    enviarTrocaDePlano(anunciante, planoAntigo, planoNovo, {
      cobrado: payload.acertoCobrado > 0,
      valor: payload.acertoCobrado,
    }).catch((err) => console.error('e-mail de troca de plano', err));
    sse.emitirParaConta(anunciante.id, 'plan.updated', {});
    return;
  }

  // cobranca_falhou: cartão recusado ou cobrança vencida. O contrato do
  // Checkout (API.md 7.3, item explícito do checklist de integração) manda
  // avisar o assinante com o link de renovação — sem isso a cobertura acaba
  // silenciosamente na próxima data de expiração e ninguém nunca soube que
  // deveria trocar o cartão.
  if (payload.evento === 'cobranca_falhou') {
    const anunciante = await anunciantesRepo.buscarPorId(assinatura.anunciante_id);
    let comLink = false;
    if (anunciante) {
      // Sem token assinado o link cobraria em dobro (ver `tokenRenovacao`), e
      // aí é melhor um e-mail que manda falar com a gente do que um link que
      // cria uma segunda assinatura sem cancelar a primeira.
      const link = linkRenovarAssinatura(assinatura.id, anunciante.cpf_cnpj);
      comLink = !!link;
      enviarCobrancaFalhou(anunciante, link).catch((err) => console.error('e-mail de cobrança falhou', err));
    }
    return registrarPendencia(
      payload,
      comLink
        ? 'cobrança falhou — link de renovação enviado por e-mail'
        : 'cobrança falhou — e-mail enviado SEM link: não foi possível assinar o token de renovação (confira SAN_CHECKOUT_KEY e o cpf_cnpj da conta)',
    );
  }

  // cobranca_contestada: chargeback num ciclo. O contrato do Checkout
  // (API.md, tabela de eventos) manda suspender o acesso — é dinheiro
  // contestado no banco do cliente, não uma recusa comum de cartão como
  // `cobranca_falhou`. Suspende igual ao botão do admin (`suspenso`),
  // então o motor de playlist já para de veicular sozinho
  // (`anunciantesElegiveis`, src/playlist/gerador.js). Nunca reativa
  // sozinho: quem decide devolver o acesso depois de um chargeback é
  // uma pessoa olhando o caso, não um evento automático.
  if (payload.evento === 'cobranca_contestada') {
    const anunciante = await anunciantesRepo.buscarPorId(assinatura.anunciante_id);
    if (anunciante && !anunciante.suspenso) {
      await anunciantesRepo.atualizar(anunciante.id, { suspenso: true });
      eventos.registrar('pagamento:chargeback_suspende', { plano_id: assinatura.plano_id }, anunciante);
    }
    return registrarPendencia(payload, 'chargeback — conta suspensa automaticamente, revisar antes de reativar');
  }

  if (!EVENTOS_QUE_CREDITAM.has(payload.evento)) {
    return registrarPendencia(payload, `evento '${payload.evento}' recebido, sem ação automática nesta fase`);
  }

  const cobranca = await aplicarCicloPago(assinatura, chave, payload, { valorCobrado: ultima?.valorCobrado });
  // 'criada' entrou pela chave da assinatura; o chargeId (se a Asaas já o
  // revelou) fica registrado também, para a conciliação diária reconhecer
  // essa cobrança como aplicada e não creditar o primeiro ciclo de novo.
  if (cobranca && payload.evento === 'criada' && ultima?.chargeId) {
    await pool.query('INSERT INTO webhooks_processados (id) VALUES ($1) ON CONFLICT DO NOTHING', [
      `${ultima.chargeId}|${ultima.status}`,
    ]);
  }
  return cobranca;
}

// Credita um ciclo pago na conta: estende a cobertura, registra a cobrança e
// a comissão. Chamado pelo webhook e pela conciliação diária — as duas rotas
// passam pela mesma dedupe (`chave`), então um ciclo nunca entra duas vezes,
// venha o aviso por webhook ou pela varredura.
// `valorCobrado` (consolidação, 24/09/2026): o que a Asaas debitou de fato,
// lido da consulta 5.3 (`ultimaCobranca.valorCobrado`). Quando vem, é ele
// que entra na cobrança, no snapshot do ciclo e na receita — recalcular pelo
// catálogo do dia divergia do dinheiro real quando uma promoção com prazo
// vencia entre um ciclo e outro (a Asaas cobra o valor congelado na adesão).
async function aplicarCicloPago(assinatura, chave, payload = null, { valorCobrado = null } = {}) {
  const contexto = payload || {
    tipo: 'assinatura',
    planoId: assinatura.id,
    evento: 'cobranca_confirmada',
    origem: 'conciliacao',
  };

  const plano = await planosRepo.buscarPorId(assinatura.plano_id);
  const anunciante = await anunciantesRepo.buscarPorId(assinatura.anunciante_id);
  if (!plano || !anunciante) {
    await pool.query('DELETE FROM webhooks_processados WHERE id = $1', [chave]);
    return registrarPendencia(contexto, 'plano ou anunciante não encontrado pra essa assinatura');
  }

  // Conta excluída não recebe ciclo: a exclusão cancela a assinatura no
  // Checkout, mas uma cobrança em trânsito (ou um retry) ainda chega aqui — e
  // sem esta guarda ela reativava a conta excluída, registrava receita e
  // pagava comissão ao vendedor por um cliente que pediu pra sair. Vira
  // pendência pra alguém devolver o dinheiro à mão.
  if (anunciante.excluido_em) {
    return registrarPendencia(contexto, 'cobrança de conta já excluída — verificar devolução no Checkout');
  }

  // O que a conta paga é o valor do plano, com os descontos que ela tem
  // direito (comodato, parceiro, e promocional se a assinatura carregar um).
  const cobradoDeFato = Number(valorCobrado);
  const valorCiclo =
    Number.isFinite(cobradoDeFato) && cobradoDeFato > 0
      ? arredondar(cobradoDeFato)
      : multiplicar(valorMensalDaConta(anunciante, plano, assinatura), plano.compromisso_meses);

  // Cobertura e cobrança andam pelo MESMO calendário, e é o único desenho
  // que o motor de pagamento suporta: o San Checkout cobra no ato da
  // assinatura e a cada `ciclo` a partir dali — sem carência, sem mês grátis
  // e sem pular ciclo (API.md do Checkout, seção 7.5). Qualquer coisa que
  // fizesse a cobertura começar num dia diferente do da cobrança era promessa
  // que o motor não cumpre, e saiu na migration 021. Benefício se dá no
  // PREÇO (o valor que o nosso GET /plano/{id} devolve), nunca no tempo.
  const mesesDoCiclo = plano.compromisso_meses;
  const baseExpiracao =
    anunciante.data_expiracao && vigencia.coberturaVigente(anunciante.data_expiracao)
      ? new Date(anunciante.data_expiracao)
      : new Date();
  const novaExpiracao = new Date(baseExpiracao);
  novaExpiracao.setMonth(novaExpiracao.getMonth() + mesesDoCiclo);

  // Ativar a conta, registrar a cobrança e a comissão têm que ser tudo ou
  // nada: antes eram três queries soltas, e se a segunda falhasse a conta
  // ficava ativa sem cobrança registrada.
  const cliente = await pool.connect();
  let cobrancaRows;
  let creditoIndicacao;
  let eventosDaFila = [];
  try {
    await cliente.query('BEGIN');
    // A expiração é estendida a cada ciclo pago; quem paga dois ciclos
    // seguidos recebe os dois.
    //
    // Ciclo PAGO que entra na hora tira a marca de cortesia (rodada de
    // integridade, 23/09/2026): plano pago marcado como cortesia saía da
    // receita recorrente e perdia o "Cancelar assinatura" no admin.
    // Onde este ciclo entra na FILA (24/09/2026, ADR-016): sem benefício no
    // caminho, é a conta de sempre (plano pago, cobertura estendida, sem
    // marca de cortesia — ver o histórico da rodada de integridade em
    // plano-administrativo.js); com benefício em vigor, a prioridade por
    // nível decide se o pago entra agora (encerrando o benefício menor) ou
    // espera guardado até o benefício acabar. Conta relida travada: um
    // resgate ou a rotina diária no mesmo instante esperam este ciclo.
    const {
      rows: [contaTravada],
    } = await cliente.query('SELECT * FROM anunciantes WHERE id = $1 FOR UPDATE', [anunciante.id]);
    eventosDaFila = await planoAdministrativo.aplicarPagamentoNaFila(cliente, contaTravada, plano, novaExpiracao);
    // Primeiro ciclo pago: a assinatura deixa de ser só um link gerado
    // (migration 089). Na mesma transação da cobrança.
    if (assinatura.status === 'pendente_pagamento') await assinaturasRepo.marcarAtiva(assinatura.id, cliente);
    ({ rows: cobrancaRows } = await cliente.query(
      `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, nota_fiscal_status)
       VALUES ($1,$2,$3,'pendente') RETURNING id`,
      [anunciante.id, plano.id, valorCiclo],
    ));
    // Snapshot do ciclo (migration 087): o valor que ACABOU de ser cobrado e
    // as exibições previstas do plano — é daqui que sai o "Custo por
    // exibição prevista" do painel, sem nunca ser recalculado depois.
    await cicloContratado.registrar(cliente, {
      anuncianteId: anunciante.id,
      plano,
      assinaturaId: assinatura.id,
      cobrancaId: cobrancaRows[0].id,
      origem: await cicloContratado.origemDoCicloPago(cliente, assinatura.id),
      valorCiclo,
    });
    creditoIndicacao = await registrarCreditoIndicacaoSeHouver(anunciante, cobrancaRows[0].id, cliente);
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
  eventos.registrar(
    'pagamento:cobranca_confirma',
    {
      plano_id: plano.id,
      valor_confirmado: valorCiclo,
      ciclo_numero: ciclos[0].n,
    },
    anunciante,
  );

  enviarConfirmacaoPagamento(anunciante, plano, valorCiclo).catch((err) => {
    console.error('falha ao enviar e-mail de confirmação', err);
  });

  // Notificação + evento em tempo real — só depois do COMMIT, mesmo
  // raciocínio do evento de métrica acima: nunca anunciar um dado que
  // ainda pode dar ROLLBACK. `.catch` porque uma falha aqui é aviso extra,
  // nunca motivo pra derrubar um pagamento que já entrou de verdade.
  const valorFormatado = Number(valorCiclo).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  notificacoesRepo
    .registrar(anunciante.id, {
      tipo: 'pagamento_confirmado',
      titulo: `Pagamento confirmado: ${plano.nome}`,
      descricao: `${valorFormatado} recebidos.`,
    })
    .catch((err) => console.error('falha ao registrar notificação de pagamento', err));
  sse.emitirParaConta(anunciante.id, 'payment.updated', {});
  sse.emitirParaAdmin('payment.updated', { anuncianteId: anunciante.id });
  // O que o ciclo fez com a fila de benefícios (ADR-016) — o cliente sabe
  // na hora por que o plano mudou (ou por que ainda não mudou).
  for (const ev of eventosDaFila) {
    const nomeBeneficio = ev.beneficio?.planoNome || ev.linha?.plano_nome || 'benefício';
    const aviso =
      ev.tipo === 'beneficio_superado'
        ? {
            titulo: `Seu benefício ${nomeBeneficio} foi encerrado`,
            descricao: `Seu plano ${plano.nome} pago entrou em vigor.`,
          }
        : ev.tipo === 'pago_depois_do_beneficio'
          ? {
              titulo: `Seu plano ${plano.nome} começa depois do benefício`,
              descricao: `O benefício ${nomeBeneficio} continua até o fim; o período pago fica guardado e começa em seguida.`,
            }
          : {
              titulo: `Benefício programado ${nomeBeneficio} cancelado`,
              descricao: `Seu plano ${plano.nome} pago já oferece mais recursos.`,
            };
    notificacoesRepo
      .registrar(anunciante.id, { tipo: `fila_${ev.tipo}`, ...aviso })
      .catch((err) => console.error('falha ao notificar mudança na fila de benefícios', err));
  }
  if (eventosDaFila.length) sse.emitirParaConta(anunciante.id, 'plan.updated', {});
  if (creditoIndicacao) {
    notificacoesRepo
      .registrar(creditoIndicacao.pontoContaId, {
        tipo: 'credito_indicacao',
        titulo: 'Você ganhou 1 crédito por indicação',
        descricao: `${anunciante.nome_empresa} confirmou o pagamento.`,
      })
      .catch((err) => console.error('falha ao registrar notificação de crédito', err));
    sse.emitirParaConta(creditoIndicacao.pontoContaId, 'credits.updated', {});
  }

  return cobrancaRows[0];
}

// Webhook de pedido avulso (API.md do Checkout, 4.3.3) — payload sem
// `tipo`, então quem chama já filtrou pelo formato de assinatura antes.
// Dedupe pela mesma chave natural do contrato, chargeId + status; pedido
// já vem com chargeId no corpo, sem precisar consultar nada de volta.
async function processarWebhookPedido(payload) {
  if (!payload.pedidoId) {
    return registrarPendencia(payload, 'webhook de pedido sem pedidoId');
  }
  const chave = `${payload.chargeId || payload.pedidoId}|${payload.status}`;
  const { rowCount } = await pool.query('INSERT INTO webhooks_processados (id) VALUES ($1) ON CONFLICT DO NOTHING', [
    chave,
  ]);
  if (!rowCount) return; // reentrega do mesmo evento, nada a fazer de novo

  const pedido = await pedidosRepo.buscarPorId(payload.pedidoId);
  if (!pedido) return registrarPendencia(payload, `pedido '${payload.pedidoId}' não encontrado`);
  if (pedido.status !== 'pendente') return; // já processado (pago ou cancelado) por outra entrega

  // em_analise, estorno_solicitado, estorno_negado, pendente: nenhuma ação
  // ainda — o contrato pede esperar o desfecho, nunca tratar como falha.
  if (payload.status === 'confirmado') return aplicarTrocaDePlano(pedido, payload);
  if (['recusado', 'vencido', 'chargeback', 'estornado'].includes(payload.status)) {
    return pedidosRepo.marcarCancelado(pedido.id);
  }
}

// Efeito da troca de plano, só depois do dinheiro confirmado (nunca antes —
// é o que impede o cliente pagar zero e a troca acontecer do mesmo jeito
// por uma corrida entre a tela e o webhook).
async function aplicarTrocaDePlano(pedido, payload) {
  const anunciante = await anunciantesRepo.buscarPorId(pedido.anunciante_id);
  const planoNovo = await planosRepo.buscarPorId(pedido.plano_novo_id);
  if (!anunciante || !planoNovo) {
    return registrarPendencia(payload, 'conta ou plano novo não encontrado pra aplicar a troca');
  }

  const assinaturaAtiva = await assinaturasRepo.buscarAtivaDoAnunciante(anunciante.id);
  if (assinaturaAtiva) {
    // A recorrência do plano antigo tem que parar — sem isso o cliente
    // pagaria o plano antigo de novo no próximo ciclo, por cima do novo.
    try {
      await cancelarAssinatura(assinaturaAtiva.id, anunciante.cpf_cnpj);
      await assinaturasRepo.marcarCancelada(assinaturaAtiva.id);
    } catch (err) {
      // O dinheiro da troca já entrou — não dá pra travar a troca por isso,
      // mas alguém precisa cancelar a mão pra não cobrar as duas coisas.
      await registrarPendencia(payload, `troca de plano paga, mas falha ao cancelar assinatura antiga: ${err.message}`);
    }
  }

  const novaExpiracao = new Date();
  novaExpiracao.setMonth(novaExpiracao.getMonth() + planoNovo.compromisso_meses);

  await anunciantesRepo.atualizar(anunciante.id, {
    plano_id: planoNovo.id,
    suspenso: false,
    data_expiracao: novaExpiracao,
    plano_cortesia: false,
    cortesia_motivo: null,
  });
  const {
    rows: [cobranca],
  } = await pool.query(
    `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, nota_fiscal_status) VALUES ($1,$2,$3,'pendente') RETURNING id`,
    [anunciante.id, planoNovo.id, pedido.valor],
  );
  // Pedido avulso (fluxo legado, sem tela que o crie hoje): o pedido pagou o
  // ciclo inteiro do plano novo — é o snapshot desse ciclo (migration 087).
  await cicloContratado.registrar(pool, {
    anuncianteId: anunciante.id,
    plano: planoNovo,
    cobrancaId: cobranca.id,
    origem: 'troca',
    valorCiclo: Number(pedido.valor),
  });
  await pedidosRepo.marcarPago(pedido.id);

  eventos.registrar('plano:troca_paga', { plano_id: planoNovo.id, valor_confirmado: Number(pedido.valor) }, anunciante);
}

// Cancelamento é sempre a Vitrina quem aciona (nunca o pagador direto no
// checkout — INTEGRACAO.md 6.1). Formato do corpo confirmado com quem
// administra o San Checkout (v2, campo `documento` — CPF ou CNPJ).
// 404 (API.md 5.5: nenhuma assinatura nesse estado — nunca paga, ou já
// cancelada) não é falha: não há o que cancelar, e o registro local pode
// fechar. Antes virava 502 em todo cancelamento, inclusive na exclusão da
// conta. 409 (outra operação em andamento) e 5xx continuam sendo erro —
// quem chama tenta de novo.
async function cancelarAssinatura(assinaturaId, documento) {
  const r = await chamarApiCheckout('cancelar-assinatura', { planoId: assinaturaId, documento: soDigitos(documento) });
  if (r.status === 404) return { cancelada: false, inexistente: true };
  if (r.status === 409) throw new Error('outra operação em andamento nessa assinatura no San Checkout — tente de novo');
  if (!r.ok) throw new Error('falha ao cancelar assinatura no San Checkout');
  return r.json();
}

// Troca de plano SEM pedido avulso (POST /trocar-plano, API.md do
// Checkout, seção 5.6): altera a MESMA assinatura na Asaas, sem o
// assinante digitar cartão de novo e sem janela sem cobertura.
//
// Desde 21/09/2026, três saídas, não duas: sem acerto (ou acerto < R$5)
// continua `200` na hora; com acerto a cobrar, virou `202` — nada é
// cobrado nem alterado ainda, e o corpo traz `approvalUrl` (o pagador
// aprova o valor numa tela do próprio Checkout antes de qualquer débito;
// quem confirma de verdade é o webhook `plano_trocado`, não esta
// resposta). Antes disso, a rota cobrava direto, sem o pagador ver nada.
//
// Devolve `{ status, corpo }` sempre, mesmo quando o Checkout recusa (400
// dado inválido, 404 sem assinatura/plano, 409 período não confirmado/sem
// cartão salvo/assinatura encerrada, 502 troca imediata não confirmada).
// Não é exceção porque cada recusa tem uma mensagem própria pro usuário
// final, e quem chama (a rota que criou a linha 'pendente_troca') precisa
// do código exato pra decidir se apaga a linha criada ou mantém.
async function trocarPlano(assinaturaId, planoNovoId, documento) {
  const r = await chamarApiCheckout('trocar-plano', {
    planoId: assinaturaId,
    planoNovoId,
    documento: soDigitos(documento),
  });
  const corpo = await r.json().catch(() => ({}));
  return { status: r.status, corpo };
}

module.exports = {
  valorMensalDaConta,
  telefoneNacional,
  exigirChaveCheckout,
  webhookAutorizado,
  registrarPendencia,
  linkCheckoutAssinatura,
  linkRenovarAssinatura,
  montarRespostaPlano,
  trocarPlano,
  processarWebhookAssinatura,
  processarWebhookPedido,
  cancelarAssinatura,
  consultarAssinatura,
  chaveDoEvento,
  aplicarCicloPago,
};
