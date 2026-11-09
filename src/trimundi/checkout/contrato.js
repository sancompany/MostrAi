const crypto = require('node:crypto');
const config = require('../config');
const v = require('../lib/validacao');
const { consultar } = require('../db/conexao');
const { expirarVencidos } = require('../pedidos');

// `GET /pedido/{pedidoId}` que o San Checkout chama antes de cobrar
// (API.md §4.1). O valor cobrado é SEMPRE o que esta resposta diz — nunca o
// que veio na URL. Responde rápido (lê e devolve, nada mais): o Checkout dá
// 45 s e não tenta de novo.

const STATUS_PARA_O_CHECKOUT = {
  aguardando_pagamento: 'pendente',
  pago: 'pago',
  cancelado: 'cancelado',
  expirado: 'cancelado',
  estornado: 'cancelado',
  pago_sem_vaga: 'cancelado',
};

const emReais = (centavos) => Math.round(Number(centavos)) / 100;

function chaveConfere(recebida) {
  const ck = config.checkout();
  if (!ck.chave) return false;
  const a = Buffer.from(String(recebida ?? ''));
  const b = Buffer.from(ck.chave);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function absoluta(url) {
  if (!url) return undefined;
  if (/^https:\/\//.test(url)) return url;
  const site = config.urlDoSite();
  return site.startsWith('https://') ? `${site}${url}` : undefined;
}

async function respostaDoPedido(pedidoId) {
  const id = v.uuid(pedidoId);
  if (!id) return null;
  await expirarVencidos(id);
  const { rows } = await consultar(
    `SELECT p.*, c.nome AS comprador_nome, c.email AS comprador_email, c.cpf AS comprador_cpf, c.telefone AS comprador_telefone,
            ev.nome AS evento_nome, ed.nome AS edicao_nome,
            (SELECT url FROM edicao_imagens WHERE edicao_id = ed.id AND tipo = 'banner') AS banner
       FROM pedidos p JOIN compradores c ON c.id = p.comprador_id
       JOIN edicoes ed ON ed.id = p.edicao_id JOIN eventos ev ON ev.id = ed.evento_id
      WHERE p.id = $1`,
    [id],
  );
  const p = rows[0];
  if (!p) return null;
  const { rows: itens } = await consultar(
    'SELECT descricao, quantidade, preco_unitario_centavos FROM pedido_itens WHERE pedido_id = $1 ORDER BY ordem',
    [id],
  );
  const total = emReais(p.total_centavos);
  const resposta = {
    pedidoId: p.id,
    status: STATUS_PARA_O_CHECKOUT[p.status],
    itens: itens.map((i) => ({
      nome: i.descricao,
      quantidade: i.quantidade,
      valorUnitario: emReais(i.preco_unitario_centavos),
    })),
    valorCheio: total,
    desconto: 0,
    cupom: null,
    valorComDesconto: total,
    frete: 0,
    taxaDoProjeto: 0,
    isentarTaxa: false,
    descricao: `${p.evento_nome} — ${p.edicao_nome}`.slice(0, 120),
    pagador: {
      nome: p.comprador_nome || undefined,
      email: p.comprador_email || undefined,
      documento: p.comprador_cpf || undefined,
      telefone: p.comprador_telefone || undefined,
    },
    expiraEm: new Date(p.reserva_expira_em).toISOString(),
  };
  const banner = absoluta(p.banner);
  if (banner) resposta.bannerUrl = banner;
  return resposta;
}

module.exports = { respostaDoPedido, chaveConfere, STATUS_PARA_O_CHECKOUT };
