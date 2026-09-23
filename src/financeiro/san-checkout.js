const crypto = require('node:crypto');
const pool = require('../db/pool');
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
const STATUS_QUE_SERVEM_PLANO = new Set(['ativa', 'pendente_troca']);

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

// Por cima do preço-base entram (item 4 e item 8 da spec, 15/09/2026):
// - comodato: HOJE é só o crédito em reais (abaixo). O percentual por plano
//   (`desconto_comodato_percentual`) foi aposentado — ver o comentário
//   dentro de `valorMensalDaConta`.
// - parceiro (era "fundador" até 16/09/2026): conta com `status = 'parceiro'`
//   marcada pelo dono (à mão, sem concessão automática) ganha o
//   `parceiro_desconto_percentual` dela, mas só nos planos que o dono liberou
//   pra parceiro via `parceiro_compromisso_minimo` (ex.: só trimestral pra
//   cima — mensal fica de fora).
//
// A TRAVA DE PREÇO SAIU EM 17/09/2026, a pedido do dono ("não irei modificar
// muito os planos então pode retirar o plano travado"). Ela existia pra
// proteger quem assinou de um aumento futuro; com a grade fechada e sem
// previsão de mexer, virou máquina parada. E ela carregava um defeito:
// `mesmoPlano` comparava `anunciante.plano_id === plano.id`, então migrar a
// conta pra versão nova de um plano REESCREVIA a trava com o preço novo — o
// contrário exato do direito que ela prometia.
// O CRÉDITO DE COMODATO EM REAIS entrou em 17/09/2026 (migration 049). Quem
// escolhe trocar a ajuda de custo por tela deixa de receber R$ 50 por mês, e
// esses R$ 50 viram abatimento fixo na mensalidade. É o desenho do dono:
// "ele nem precisa pagar os 50 reais aqui, ele pode somente abrir mão".
//
// Em reais e não em percentual de propósito. O valor abatido tem que ser
// exatamente o que ele deixou de receber — um percentual daria R$ 50 no
// Destaque mensal e R$ 40 no anual sem ninguém ter decidido isso, e mudaria
// sozinho no dia em que o preço da linha mudasse.
//
// Entra DEPOIS dos percentuais e nunca deixa a mensalidade negativa: crédito
// maior que o preço vira mensalidade zero, não devolução de dinheiro.
//
// VALE NOS TRÊS PLANOS PAGOS — Essencial, Pro (`destaque`) e Prime
// (`maximo`) — desde a rodada de integridade de 23/09/2026 (decisão
// comercial do dono). A regra antiga deixava o Essencial de fora porque,
// no desenho da migration 049, quem trocava os R$ 50 por tela GANHAVA o
// Essencial inteiro de cortesia — o crédito nele seria dar a mesma coisa
// duas vezes. Desde a migration 063 isso não existe mais: quem troca ganha o
// Básico (produto de comodato próprio, 45s/hora em 3 pontos), não o
// Essencial, então o Essencial pago é um degrau acima como os outros dois.
// Lista fechada de propósito: plano sem tier (versão antiga, linha fora da
// grade) continua sem crédito — é direito nomeado, não desconto genérico.
const TIERS_COM_CREDITO = new Set(['essencial', 'destaque', 'maximo']);

// `assinatura` é opcional (várias chamadas antigas não tinham como passar) —
// quando vem, e carrega uma condição promocional ainda dentro do prazo
// prometido (`promocao_valido_ate`, rodada de Ofertas/Promoções,
// 22/09/2026), o desconto promocional SUBSTITUI o desconto do ciclo na base
// (mesma régua da vitrine pública, public/planos.page.js: a promoção é o
// preço de tabela daquele ciclo enquanto vale, não mais um percentual em
// cima do preço de tabela normal) — comodato e parceiro continuam entrando
// DEPOIS, em cima dessa base, porque são direito da CONTA, não do ciclo.
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

  // O percentual de comodato por plano (`desconto_comodato_percentual`) NÃO
  // entra mais (rodada de integridade, 23/09/2026). A migration 049 já tinha
  // zerado a coluna e declarado que "quem manda agora é o crédito em reais da
  // conta" — mas a leitura continuava aqui, e a tela de Ofertas voltou a
  // deixar o campo editável: preencher ali abriria um SEGUNDO desconto de
  // comodato por cima do crédito, sem ninguém ter decidido isso. Comodato é
  // só o `credito_comodato_mensal`, abaixo. A coluna fica no banco (sem DROP
  // nesta rodada), só sem efeito.
  const descontoParceiro =
    anunciante.status === 'parceiro' && plano.compromisso_meses >= (anunciante.parceiro_compromisso_minimo || 0)
      ? Number(anunciante.parceiro_desconto_percentual || 0)
      : 0;
  const desconto = Math.min(100, descontoParceiro);
  const comPercentual = desconto ? arredondar(base - percentual(base, desconto)) : base;

  const credito =
    (anunciante.papeis || []).includes('ponto') && TIERS_COM_CREDITO.has(plano.tier)
      ? Number(anunciante.credito_comodato_mensal || 0)
      : 0;

  return credito ? arredondar(Math.max(0, comPercentual - credito)) : comPercentual;
}

async function registrarPendencia(payload, motivo) {
  await pool.query(`INSERT INTO eventos_assinatura_pendentes (payload, motivo) VALUES ($1,$2)`, [
    JSON.stringify(payload),
    motivo,
  ]);
}

// Programa de vendedores aposentado (reconstrução de Contas, 23/09/2026,
// pedido do dono: "sem novas comissões"). Nenhuma comissão NOVA nasce daqui
// em diante — nem de cadastro novo, nem da renovação de quem já tinha vindo
// por cupom. As comissões que já existem ficam na tabela como estão (histórico
// e fila de pagamento). A função fica inteira atrás da chave pra que
// religar, se o dono um dia quiser, seja trocar uma constante — não
// reescrever a regra.
const COMISSAO_DE_VENDEDOR_ATIVA = false;

// `db` é o pool por padrão, mas o webhook passa o client da transação pra
// que a comissão entre junto com a cobrança — ou não entre nenhuma das duas.
async function registrarComissaoSeHouver(anunciante, valor, db = pool) {
  if (!COMISSAO_DE_VENDEDOR_ATIVA) return;
  if (!anunciante.indicado_por_cupom || !valor) return;
  // Vendedor é papel da conta única (migration 019). Cupom em maiúsculas pra
  // não perder comissão por caixa diferente.
  const { rows } = await db.query(
    `SELECT v.* FROM vendedores v JOIN anunciantes a ON a.id = v.conta_id
     WHERE v.codigo_cupom = upper($1) AND v.status = 'aprovado' AND a.excluido_em IS NULL`,
    [anunciante.indicado_por_cupom],
  );
  const vendedor = rows[0];
  if (!vendedor || vendedor.conta_id === anunciante.id) return; // ninguém ganha comissão de si mesmo

  const comissaoValor = percentual(valor, vendedor.comissao_percentual);
  await db.query(
    `INSERT INTO comissoes (vendedor_conta_id, anunciante_id, valor_confirmado, comissao_valor)
     VALUES ($1,$2,$3,$4)`,
    [vendedor.conta_id, anunciante.id, valor, comissaoValor],
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

// Crédito de indicação do dono de ponto (migration 062, pedido do dono,
// 19/09/2026) — irmã de registrarComissaoSeHouver, mas nunca move dinheiro:
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
async function chaveDoEvento(payload) {
  if (payload.eventoId || payload.cobrancaId) return String(payload.eventoId || payload.cobrancaId);

  if (EVENTOS_QUE_CREDITAM.has(payload.evento)) {
    const estado = await consultarAssinatura(payload.planoId, payload.documento);
    const ultima = estado?.ultimaCobranca;
    if (!ultima?.chargeId) throw new Error('checkout não devolveu ultimaCobranca.chargeId');
    return `${ultima.chargeId}|${ultima.status}`;
  }

  const dia = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash('sha256')
    .update(`${dia}|${JSON.stringify(payload)}`)
    .digest('hex');
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
    if (EVENTOS_QUE_CREDITAM.has(payload.evento)) {
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

  return aplicarCicloPago(assinatura, chave, payload);
}

// Credita um ciclo pago na conta: estende a cobertura, registra a cobrança e
// a comissão. Chamado pelo webhook e pela conciliação diária — as duas rotas
// passam pela mesma dedupe (`chave`), então um ciclo nunca entra duas vezes,
// venha o aviso por webhook ou pela varredura.
async function aplicarCicloPago(assinatura, chave, payload = null) {
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
  const valorMensal = valorMensalDaConta(anunciante, plano, assinatura);
  const valorCiclo = multiplicar(valorMensal, plano.compromisso_meses);

  // Cobertura e cobrança andam pelo MESMO calendário, e é o único desenho
  // que o motor de pagamento suporta: o San Checkout cobra no ato da
  // assinatura e a cada `ciclo` a partir dali — sem carência, sem mês grátis
  // e sem pular ciclo (API.md do Checkout, seção 7.5). Qualquer coisa que
  // fizesse a cobertura começar num dia diferente do da cobrança era promessa
  // que o motor não cumpre, e saiu na migration 021. Benefício se dá no
  // PREÇO (o valor que o nosso GET /plano/{id} devolve), nunca no tempo.
  const mesesDoCiclo = plano.compromisso_meses;
  const baseExpiracao =
    anunciante.data_expiracao && new Date(anunciante.data_expiracao) > new Date()
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
  try {
    await cliente.query('BEGIN');
    // A expiração é estendida a cada ciclo pago; quem paga dois ciclos
    // seguidos recebe os dois.
    //
    // Ciclo PAGO tira a marca de cortesia (rodada de integridade,
    // 23/09/2026). Quem tinha o Básico do comodato (cortesia, motivo
    // 'comodato') e assinava o Pro ficava com o Pro gravado MAS ainda marcado
    // como cortesia: saía da receita recorrente e do "cadastra e paga",
    // perdia o botão "Cancelar assinatura" no admin, e — o pior — continuava
    // casando com a guarda de `pontos/comodato.js#ajustarPlanoIncluido`
    // ("só troca se o que está lá é o plano do comodato"), que podia
    // sobrescrever o plano pago pelo Básico na próxima vez que uma modalidade
    // fosse aplicada (ex.: um segundo ponto aprovado). O comentário de
    // `conta/modos.js` já dizia que este passo limpava a cortesia — não
    // limpava.
    await cliente.query(
      `UPDATE anunciantes
       SET plano_id = $2, suspenso = false,
           plano_cortesia = false, cortesia_motivo = NULL,
           data_inicio_cobertura = COALESCE(data_inicio_cobertura, now()),
           data_expiracao = $3::timestamptz
       WHERE id = $1`,
      [anunciante.id, plano.id, novaExpiracao],
    );
    ({ rows: cobrancaRows } = await cliente.query(
      `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, nota_fiscal_status)
       VALUES ($1,$2,$3,'pendente') RETURNING id`,
      [anunciante.id, plano.id, valorCiclo],
    ));
    await registrarComissaoSeHouver(anunciante, valorCiclo, cliente);
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
  await pool.query(
    `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, nota_fiscal_status) VALUES ($1,$2,$3,'pendente')`,
    [anunciante.id, planoNovo.id, pedido.valor],
  );
  await pedidosRepo.marcarPago(pedido.id);

  eventos.registrar('plano:troca_paga', { plano_id: planoNovo.id, valor_confirmado: Number(pedido.valor) }, anunciante);
}

// Cancelamento é sempre a Vitrina quem aciona (nunca o pagador direto no
// checkout — INTEGRACAO.md 6.1). Formato do corpo confirmado com quem
// administra o San Checkout (v2, campo `documento` — CPF ou CNPJ).
async function cancelarAssinatura(assinaturaId, documento) {
  const r = await chamarApiCheckout('cancelar-assinatura', { planoId: assinaturaId, documento: soDigitos(documento) });
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
