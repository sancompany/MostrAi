const pool = require('../db/pool');
const planosRepo = require('./planos-repository');
const afiliadosRepo = require('./afiliados-repository');
const anunciantesRepo = require('../anunciantes/repository');
const assinaturasRepo = require('./assinaturas-repository');
const { enviarConfirmacaoPagamento } = require('./email');

// Protege as rotas que o San Checkout chama de volta e as que a Vitrina
// chama nele (mesma chave nos dois sentidos — INTEGRACAO.md seção 6/6.1).
function exigirChaveCheckout(req, res, next) {
  if (req.headers['x-checkout-key'] !== process.env.SAN_CHECKOUT_KEY) {
    return res.status(401).json({ erro: 'chave inválida' });
  }
  next();
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
    descricao: `Vitrina — ${plano.nome}, ciclo de ${plano.compromisso_meses} ${plano.compromisso_meses === 1 ? 'mês' : 'meses'}`,
    valor: Number(plano.valor_mensal) * plano.compromisso_meses,
    ciclo: CICLO_ASAAS[plano.compromisso_meses] || 'MONTHLY',
    pagador: {
      nome: anunciante.nome_empresa,
      email: anunciante.contato_email,
      documento: anunciante.cpf_cnpj,
      telefone: anunciante.contato_telefone,
    },
  };
}

async function registrarPendencia(payload, motivo) {
  await pool.query(
    `INSERT INTO eventos_assinatura_pendentes (payload, motivo) VALUES ($1,$2)`,
    [JSON.stringify(payload), motivo]
  );
}

async function registrarComissaoSeHouver(anunciante, valor) {
  if (!anunciante.indicado_por_cupom || !valor) return;
  const { rows } = await pool.query(
    `SELECT * FROM afiliados WHERE codigo_cupom = $1 AND status = 'aprovado'`,
    [anunciante.indicado_por_cupom]
  );
  const afiliado = rows[0];
  if (!afiliado) return;

  const comissaoValor = Number(valor) * (Number(afiliado.comissao_percentual) / 100);
  await pool.query(
    `INSERT INTO comissoes (afiliado_id, anunciante_id, valor_confirmado, comissao_valor)
     VALUES ($1,$2,$3,$4)`,
    [afiliado.id, anunciante.id, valor, comissaoValor]
  );
}

// Handler do POST /webhook/san-checkout pro evento de assinatura
// (INTEGRACAO.md 6.1): { tipo: "assinatura", planoId, documento, evento }.
// Aqui `planoId` é o id da nossa linha em `assinaturas` (ver montarRespostaPlano).
// Só 'cobranca_confirmada' ativa automaticamente — os outros eventos
// (falhou/estornada/cancelada exceto cancelamento, criada) só ficam
// registrados pro admin revisar, pra nunca derrubar o acesso de alguém sem
// intervenção humana.
async function processarWebhookAssinatura(payload) {
  if (payload.tipo !== 'assinatura') {
    return registrarPendencia(payload, 'formato de webhook não reconhecido (esperava tipo=assinatura)');
  }

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

  const valorCiclo = Number(plano.valor_mensal) * plano.compromisso_meses;

  const { rows: pontosAtivos } = await pool.query(`SELECT 1 FROM pontos WHERE status = 'ativo' LIMIT 1`);
  const temPontoAtivo = pontosAtivos.length > 0;

  // Todo 'cobranca_confirmada' agora é uma cobrança real (a Asaas cobra o
  // ciclo inteiro de uma vez) — estende sempre.
  const baseExpiracao = anunciante.data_expiracao && new Date(anunciante.data_expiracao) > new Date()
    ? new Date(anunciante.data_expiracao)
    : new Date();
  const novaExpiracao = new Date(baseExpiracao);
  novaExpiracao.setMonth(novaExpiracao.getMonth() + plano.compromisso_meses);

  await pool.query(
    `UPDATE anunciantes SET plano_id = $2, status = $3, data_inicio_cobertura = COALESCE(data_inicio_cobertura, now()), data_expiracao = $4 WHERE id = $1`,
    [anunciante.id, plano.id, temPontoAtivo ? 'ativo' : 'aguardando_ponto', temPontoAtivo ? novaExpiracao : anunciante.data_expiracao]
  );

  const { rows: cobrancaRows } = await pool.query(
    `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, nota_fiscal_status)
     VALUES ($1,$2,$3,'pendente') RETURNING id`,
    [anunciante.id, plano.id, valorCiclo]
  );

  await registrarComissaoSeHouver(anunciante, valorCiclo);
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
  exigirChaveCheckout, linkCheckoutAssinatura, montarRespostaPlano,
  processarWebhookAssinatura, cancelarAssinatura,
};
