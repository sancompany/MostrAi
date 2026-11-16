const { consultar, emTransacao } = require('./db/conexao');
const { erro } = require('./lib/erros');
const { auditar } = require('./lib/registro');
const { carregarLotes, estadoDaCategoria } = require('./disponibilidade');

// "DESEMPENHO DE VENDAS — LOTES DO EVENTO" (§7 do prompt master; decisões do
// dono de 14/11/2026, itens D e E).
//
// Tudo sai do estoque real a cada leitura (as mesmas contas da venda,
// disponibilidade.js) — nada é guardado, então o painel está sempre em dia
// com pagamento, reserva, vencimento, cancelamento e reembolso.
//
// - VENDIDO = ingresso pago e não cancelado. Pagamento pendente NÃO conta
//   (aparece só como "reservas ativas"). Combo não duplica: cada posição do
//   combo é um ingresso, que sai de um lote.
// - CAPACIDADE COMERCIAL = soma das quantidades dos lotes cadastrados dos
//   tipos ativos da edição (item E). Sobra de lote encerrado não passa para
//   outro lote: fica à vista como "sobra em lotes encerrados".
// - Cortesia não sai de lote: conta no resumo, não nas barras.
// - Alertas só no painel (item D): nada é enviado.

const PADRAO = Object.freeze({
  // Cores por % vendido: verde abaixo de `amarelo`, amarelo até `laranja`,
  // laranja até 100, vermelho em 100.
  cores: { amarelo: 70, laranja: 90 },
  alertas: [80, 90, 95, 100],
});

const pct = (parte, todo) => (todo > 0 ? Math.min(100, Math.floor((parte * 100) / todo)) : 0);

function corDe(p, cores) {
  if (p >= 100) return 'vermelho';
  if (p >= cores.laranja) return 'laranja';
  if (p >= cores.amarelo) return 'amarelo';
  return 'verde';
}

function configDe(salva) {
  const c = salva && typeof salva === 'object' ? salva : {};
  return {
    cores: { ...PADRAO.cores, ...(c.cores || {}) },
    alertas: Array.isArray(c.alertas) ? c.alertas : PADRAO.alertas,
    padrao: !salva,
  };
}

function lerConfig(dados) {
  const inteiro = (x, campo) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw erro(400, `${campo}: use um número inteiro de 1 a 100.`);
    return n;
  };
  const amarelo = inteiro(dados?.cores?.amarelo, 'Amarelo a partir de');
  const laranja = inteiro(dados?.cores?.laranja, 'Laranja a partir de');
  if (!(amarelo < laranja && laranja < 100)) {
    throw erro(400, 'As faixas precisam subir: amarelo < laranja < 100%.');
  }
  if (!Array.isArray(dados?.alertas) || dados.alertas.length > 6) throw erro(400, 'Até 6 alertas.');
  const alertas = [...new Set(dados.alertas.map((a) => inteiro(a, 'Alerta')))].sort((a, b) => a - b);
  return { cores: { amarelo, laranja }, alertas };
}

async function painel(edicaoId) {
  const { rows: ed } = await consultar('SELECT id, capacidade, monitor_lotes FROM edicoes WHERE id = $1', [edicaoId]);
  if (!ed[0]) throw erro(404, 'edição não encontrada');
  const cfg = configDe(ed[0].monitor_lotes);
  const { rows: tipos } = await consultar(
    'SELECT id, nome, ativo FROM categorias WHERE edicao_id = $1 ORDER BY ordem, id',
    [edicaoId],
  );
  const db = { query: (s, p) => consultar(s, p) };
  const porTipo = await carregarLotes(
    db,
    tipos.map((t) => Number(t.id)),
  );
  // Pedido de TESTE (só fora de produção) segura vaga no estoque, mas não é
  // venda: fica fora de vendidos, reservas e percentuais (RN-T19). O que
  // está disponível continua sendo o estoque real.
  const { rows: testes } = await consultar(
    `SELECT r.lote_id,
            count(*) FILTER (WHERE p.status = 'pago' AND i.id IS NOT NULL AND i.status <> 'cancelado')::int AS pagos,
            count(*) FILTER (WHERE p.status = 'aguardando_pagamento' AND p.reserva_expira_em > now())::int AS reservados
       FROM reservas r JOIN pedidos p ON p.id = r.pedido_id LEFT JOIN ingressos i ON i.reserva_id = r.id
      WHERE p.edicao_id = $1 AND p.origem = 'teste'
      GROUP BY r.lote_id`,
    [edicaoId],
  );
  const deTeste = new Map(testes.map((x) => [Number(x.lote_id), x]));
  const agora = new Date();
  const lotes = [];
  for (const t of tipos) {
    const estado = estadoDaCategoria(porTipo.get(Number(t.id)) || [], agora);
    for (const [i, l] of estado.lotes.entries()) {
      const teste = deTeste.get(Number(l.id)) || { pagos: 0, reservados: 0 };
      const vendidosDoLote = Math.max(0, l.pagos - teste.pagos);
      const p = pct(vendidosDoLote, l.quantidade);
      lotes.push({
        id: l.id,
        tipo_id: t.id,
        tipo: t.nome,
        tipo_ativo: t.ativo,
        numero: i + 1,
        quantidade: l.quantidade,
        vendidos: vendidosDoLote,
        reservados: Math.max(0, l.reservados - teste.reservados),
        // Lote fechado não vende mais: o que sobrou fica como sobra.
        disponiveis: l.fechado || !t.ativo ? 0 : l.disponivel,
        sobra: l.fechado ? Math.max(0, l.quantidade - l.pagos) : 0,
        situacao: l.situacao,
        percentual: p,
        cor: corDe(p, cfg.cores),
        esgotado: l.pagos >= l.quantidade,
        alerta: [...cfg.alertas].reverse().find((a) => p >= a) ?? null,
      });
    }
  }
  const ativos = lotes.filter((l) => l.tipo_ativo);
  const capacidade = ativos.reduce((s, l) => s + l.quantidade, 0);
  const vendidos = ativos.reduce((s, l) => s + l.vendidos, 0);
  const { rows: r } = await consultar(
    `SELECT count(*) FILTER (WHERE i.origem = 'cortesia' AND i.status <> 'cancelado')::int AS cortesias,
            count(*) FILTER (WHERE i.origem = 'pago' AND i.status = 'cancelado')::int AS cancelamentos,
            (SELECT count(*)::int FROM reembolsos re JOIN pedidos p ON p.id = re.pedido_id
              WHERE p.edicao_id = $1 AND p.origem = 'venda' AND re.status = 'confirmado') AS reembolsos
       FROM ingressos i LEFT JOIN pedidos p ON p.id = i.pedido_id
      WHERE i.edicao_id = $1 AND (p.id IS NULL OR p.origem = 'venda')`,
    [edicaoId],
  );
  const pGeral = pct(vendidos, capacidade);
  const alertas = lotes
    .filter((l) => l.tipo_ativo && l.alerta !== null)
    .map((l) => ({
      lote_id: l.id,
      tipo: l.tipo,
      numero: l.numero,
      percentual: l.percentual,
      alerta: l.alerta,
      esgotado: l.esgotado,
    }));
  return {
    config: cfg,
    resumo: {
      capacidade,
      teto_da_edicao: ed[0].capacidade,
      vendidos,
      cortesias: r[0].cortesias,
      reservas_ativas: ativos.reduce((s, l) => s + l.reservados, 0),
      disponiveis: ativos.reduce((s, l) => s + l.disponiveis, 0),
      sobra_em_lotes_encerrados: ativos.reduce((s, l) => s + l.sobra, 0),
      cancelamentos: r[0].cancelamentos,
      reembolsos: r[0].reembolsos,
      percentual: pGeral,
      cor: corDe(pGeral, cfg.cores),
    },
    lotes,
    alertas,
    atualizado_em: agora.toISOString(),
  };
}

async function salvarConfig(edicaoId, dados, autor) {
  const nova = dados?.padrao ? null : lerConfig(dados);
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query('UPDATE edicoes SET monitor_lotes = $2 WHERE id = $1 RETURNING id', [
      edicaoId,
      nova,
    ]);
    if (!rows[0]) throw erro(404, 'edição não encontrada');
    await auditar(cliente, autor, 'monitor_lotes_alterado', 'edicao', edicaoId, { config: nova });
    return configDe(nova);
  });
}

module.exports = { painel, salvarConfig, PADRAO, corDe };
