const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { lerQr } = require('./lib/qr');
const { normalizarCodigoCurto } = require('./lib/codigos');
const { historicoDoIngresso, medir } = require('./lib/registro');
const { edicoesPermitidas } = require('./operadores');
const { colunasDeNumero } = require('./lib/numeracao');

// Check-in (T8). A leitura do QR no aparelho só extrai o texto: quem decide
// é o servidor — assinatura, edição, status e uso único. A entrada aceita é
// única por ingresso (índice parcial no banco) e a confirmação trava a linha
// do ingresso: dois operadores no mesmo instante, um passa e o outro vê
// "já utilizado".

const RESULTADOS = {
  valido: 'Ingresso válido',
  ja_utilizado: 'Ingresso já utilizado',
  cancelado: 'Ingresso cancelado',
  bloqueado: 'Ingresso bloqueado',
  outra_edicao: 'Ingresso de outra edição',
  invalido: 'Ingresso inválido',
};

async function permitida(operador, edicaoId) {
  const lista = await edicoesPermitidas(operador.id);
  const ed = lista.find((e) => Number(e.id) === Number(edicaoId));
  if (!ed) throw erro(403, 'Você não tem acesso ao check-in desta edição.');
  return ed;
}

// Acha o ingresso pelo QR (assinado) ou pelo código curto digitado.
async function acharIngresso(cliente, ed, entrada) {
  const texto = String(entrada ?? '')
    .trim()
    .slice(0, 300);
  const lido = lerQr(texto);
  if (lido) {
    const { rows } = await cliente.query(
      'SELECT i.*, e.codigo_publico FROM ingressos i JOIN edicoes e ON e.id = i.edicao_id WHERE i.codigo = $1',
      [lido.codigo],
    );
    const i = rows[0];
    if (!i || i.codigo_publico !== lido.codigoPublico) return { resultado: 'invalido' };
    if (Number(i.edicao_id) !== Number(ed.id)) return { resultado: 'outra_edicao' };
    return { ingresso: i };
  }
  if (texto.startsWith('TM1.')) return { resultado: 'invalido' };
  const curto = normalizarCodigoCurto(texto);
  if (!curto) return { resultado: 'invalido' };
  const { rows } = await cliente.query('SELECT * FROM ingressos WHERE edicao_id = $1 AND codigo_curto = $2', [
    ed.id,
    curto,
  ]);
  return rows[0] ? { ingresso: rows[0] } : { resultado: 'invalido' };
}

// Quem entregou: o operador pelo nome; quem não é operador (Admin) aparece
// como "Admin". `coluna` guarda 'operador:<id>' ou o autor do Admin.
const entreguePor = (coluna) => `CASE WHEN ${coluna} IS NULL THEN NULL
  WHEN ${coluna} LIKE 'operador:%' THEN (SELECT nome FROM operadores WHERE 'operador:' || operadores.id = ${coluna})
  ELSE 'Admin' END`;

// Ingresso principal da conta na edição (o mesmo critério da "Minha conta",
// clientes.painel): o primeiro ingresso não cancelado do primeiro pedido pago
// da conta. É nele que a recompensa de indicação da conta é entregue
// (decisão do dono, 14/11/2026, item H).
async function principalDaConta(cliente, clienteId, edicaoId) {
  if (!clienteId) return null;
  const { rows } = await cliente.query(
    `SELECT i.id, ${colunasDeNumero('i')}
       FROM ingressos i JOIN pedidos p ON p.id = i.pedido_id
      WHERE p.cliente_id = $1 AND i.edicao_id = $2 AND p.status = 'pago' AND i.status <> 'cancelado'
      ORDER BY p.pago_em NULLS LAST, p.criado_em, numero, i.id
      LIMIT 1`,
    [clienteId, edicaoId],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

// Recompensas de indicação da conta nesta edição, uma a uma: as de pé
// (concedida ou entregue), do modelo de Campanhas. Revogada e expirada não
// aparecem (não se entregam); a de operador nunca chega aqui (é da conta de
// cliente — e é só pelo Admin).
async function recompensasDaConta(cliente, clienteId, edicaoId, { travar = false } = {}) {
  const { rows } = await cliente.query(
    `SELECT r.id, r.premio AS nome, r.status, r.entregue_em, ${entreguePor('r.entregue_por')} AS entregue_por
       FROM campanha_premios r
       JOIN campanhas ca ON ca.id = r.campanha_id AND ca.modalidade = 'indicacao'
       JOIN indicadores ind ON ind.id = r.indicador_id
      WHERE ind.cliente_id = $1 AND ca.edicao_id = $2 AND r.status IN ('concedido', 'entregue') AND NOT r.so_admin
      ORDER BY r.concedido_em, r.id${travar ? ' FOR UPDATE OF r' : ''}`,
    [clienteId, edicaoId],
  );
  return rows;
}

// "Número de indicados, quando disponível" (§6.1): pessoas que a conta do
// ingresso principal indicou com compra confirmada nesta edição (a mesma
// regra do "Indique e acompanhe"); nulo se não é o principal ou se a conta
// nunca teve link. Roda FORA da transação da entrada: a contagem usa outra
// conexão do pool, e pedir uma segunda conexão segurando a primeira trava a
// portaria quando o pool está cheio.
async function comIndicados(resposta) {
  const i = resposta?.ingresso;
  const conta = i?.[CONTA_PRINCIPAL];
  if (!conta) return resposta;
  const { rows } = await consultar('SELECT id FROM indicadores WHERE cliente_id = $1', [conta.clienteId]);
  if (rows[0]) {
    const { indicadosPor } = require('./desempenho');
    i.indicados = (await indicadosPor(rows[0].id, conta.edicaoId)).totais.pessoas;
  }
  return resposta;
}
const CONTA_PRINCIPAL = Symbol('conta do ingresso principal');

async function detalhes(cliente, ingresso) {
  const { rows } = await cliente.query(
    `SELECT i.id, i.codigo_curto, i.origem, i.status, i.motivo_status, i.pedido_id, i.reserva_id, i.edicao_id,
            pa.nome AS participante, c.nome AS categoria, c.pulseira, co.nome AS comprador, p.cliente_id,
            pr.nome AS promocao, ${colunasDeNumero('i')},
            ev.nome AS evento, ed.nome AS edicao, ed.inicio_em, ed.fim_em,
            (SELECT count(*)::int FROM lotes l2 WHERE l2.categoria_id = l.categoria_id AND l2.ordem <= l.ordem) AS lote,
            COALESCE((SELECT json_agg(json_build_object('id', ib.beneficio_id, 'nome', ib.nome, 'resgatado_em', ib.resgatado_em,
                        'resgatado_por', ${entreguePor('ib.resgatado_por')})
                        ORDER BY ib.nome) FROM ingresso_beneficios ib WHERE ib.ingresso_id = i.id), '[]') AS beneficios,
            ck.registrado_em AS utilizado_em, op.nome AS utilizado_por,
            (SELECT count(*)::int FROM checkins t WHERE t.ingresso_id = i.id AND t.escopo = 'entrada' AND t.resultado = 'recusado') AS tentativas
       FROM ingressos i JOIN participantes pa ON pa.id = i.participante_id JOIN categorias c ON c.id = i.categoria_id
       JOIN edicoes ed ON ed.id = i.edicao_id JOIN eventos ev ON ev.id = ed.evento_id
       LEFT JOIN lotes l ON l.id = i.lote_id
       LEFT JOIN pedidos p ON p.id = i.pedido_id
       LEFT JOIN compradores co ON co.id = p.comprador_id
       LEFT JOIN promocoes pr ON pr.id = i.promocao_id
       LEFT JOIN checkins ck ON ck.ingresso_id = i.id AND ck.escopo = 'entrada' AND ck.resultado = 'aceito'
       LEFT JOIN operadores op ON op.id = ck.operador_id
      WHERE i.id = $1`,
    [ingresso.id],
  );
  const d = rows[0];
  // Combo: os outros ingressos da mesma linha de combo do pedido, um a um —
  // cada QR continua sendo validado sozinho; a lista só mostra quem já entrou.
  let combo = null;
  if (d.promocao && d.reserva_id) {
    const { rows: doCombo } = await cliente.query(
      `SELECT i.id, pa.nome AS participante, c.nome AS categoria, i.status, ${colunasDeNumero('i')},
              ck.registrado_em AS utilizado_em
         FROM reservas eu JOIN reservas r ON r.pedido_item_id = eu.pedido_item_id
         JOIN ingressos i ON i.reserva_id = r.id
         JOIN participantes pa ON pa.id = i.participante_id JOIN categorias c ON c.id = i.categoria_id
         LEFT JOIN checkins ck ON ck.ingresso_id = i.id AND ck.escopo = 'entrada' AND ck.resultado = 'aceito'
        WHERE eu.id = $1
        ORDER BY numero, i.id`,
      [d.reserva_id],
    );
    combo = {
      nome: d.promocao,
      ingressos: doCombo.map((x) => ({
        id: x.id,
        este: Number(x.id) === Number(d.id),
        numero: x.numero,
        numero_de: x.numero_de,
        participante: x.participante,
        categoria: x.categoria,
        status: x.status,
        utilizado_em: x.utilizado_em,
      })),
    };
  }
  // Recompensa de indicação: só no ingresso principal da conta que indicou.
  const principal = d.cliente_id
    ? (await principalDaConta(cliente, d.cliente_id, d.edicao_id)) === Number(d.id)
    : false;
  const recompensas = principal ? await recompensasDaConta(cliente, d.cliente_id, d.edicao_id) : [];
  const saida = {
    id: d.id,
    codigo_curto: d.codigo_curto,
    // Titular (quem entra) e comprador (quem pagou); cortesia não tem comprador.
    participante: d.participante,
    comprador: d.comprador,
    evento: d.evento,
    edicao: d.edicao,
    // Validade do ingresso = data e horário da edição (item F).
    validade: { inicio_em: d.inicio_em, fim_em: d.fim_em },
    // "Ingresso 2 de 4" do pedido: cada QR é uma unidade; validar um não
    // mexe nos outros do mesmo pedido.
    numero: d.numero,
    numero_de: d.numero_de,
    categoria: d.categoria,
    lote: d.lote,
    pulseira: d.pulseira,
    promocao: d.promocao,
    combo,
    cortesia: d.origem === 'cortesia',
    beneficios: d.beneficios,
    // Preenchido por comIndicados, fora da transação.
    indicados: null,
    recompensas_indicacao: recompensas.map((r) => ({
      id: r.id,
      nome: r.nome,
      entregue_em: r.entregue_em,
      entregue_por: r.entregue_por,
    })),
    // Brindes de campanha por ordem de compra DESTE ingresso (PR 3): liberado,
    // já retirado ou expirado (prazo vencido — não se entrega).
    premios_campanha: (await require('./campanhas').premiosDoIngresso(cliente, d.id)).map((r) => ({
      id: r.id,
      nome: r.nome,
      campanha: r.campanha,
      posicao: r.posicao,
      status: r.status,
      entregue_em: r.entregue_em,
      entregue_por: r.entregue_por,
      prazo_retirada: r.prazo_retirada,
    })),
    status: d.status,
    motivo: d.motivo_status,
    utilizado_em: d.utilizado_em,
    utilizado_por: d.utilizado_por,
    tentativas_recusadas: d.tentativas,
  };
  // Símbolo: não sai no JSON da resposta.
  if (principal) saida[CONTA_PRINCIPAL] = { clienteId: d.cliente_id, edicaoId: d.edicao_id };
  return saida;
}

// Tentativa recusada de um ingresso desta edição (já utilizado, cancelado,
// bloqueado), registrada na consulta e na confirmação. A mesma leitura
// repetida pelo mesmo operador em 10 s (o QR parado na frente da câmera, ou
// a consulta seguida da confirmação) conta uma vez só.
async function registrarRecusa(cliente, ingressoId, edicaoId, operadorId, motivo, aparelho = null) {
  await cliente.query(
    `INSERT INTO checkins (ingresso_id, edicao_id, operador_id, resultado, motivo, aparelho)
     SELECT $1, $2, $3, 'recusado', $4, $5
      WHERE NOT EXISTS (SELECT 1 FROM checkins WHERE ingresso_id = $1 AND operador_id = $3 AND escopo = 'entrada'
                           AND resultado = 'recusado' AND motivo = $4 AND registrado_em > now() - interval '10 seconds')`,
    [ingressoId, edicaoId, operadorId, motivo, aparelho],
  );
}

function resultadoDe(d) {
  if (d.status === 'cancelado') return 'cancelado';
  if (d.status === 'bloqueado') return 'bloqueado';
  if (d.utilizado_em) return 'ja_utilizado';
  return 'valido';
}

async function consultarIngresso(operador, edicaoId, entrada, { aparelho = null } = {}) {
  const ed = await permitida(operador, v.id(edicaoId, 'edição'));
  const cliente = { query: (s, p) => consultar(s, p) };
  const achado = await acharIngresso(cliente, ed, entrada);
  if (!achado.ingresso) return { resultado: achado.resultado, mensagem: RESULTADOS[achado.resultado] };
  let d = await detalhes(cliente, achado.ingresso);
  const resultado = resultadoDe(d);
  if (resultado !== 'valido') {
    // Tentativa de entrada com ingresso já usado (ou cancelado/bloqueado):
    // fica registrada já na leitura, com operador e hora (§6).
    await registrarRecusa(cliente, d.id, ed.id, operador.id, resultado, aparelho);
    d = await detalhes(cliente, achado.ingresso);
  }
  return comIndicados({
    resultado,
    mensagem: RESULTADOS[resultado],
    ingresso: d,
    classificacao_etaria: ed.classificacao_etaria,
  });
}

async function confirmar(operador, edicaoId, ingressoId, { aparelho = null, lidoEm = null } = {}) {
  const ed = await permitida(operador, v.id(edicaoId, 'edição'));
  const id = v.id(ingressoId, 'ingresso');
  const resposta = await emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM ingressos WHERE id = $1 FOR UPDATE', [id]);
    const ing = rows[0];
    if (!ing) return { resultado: 'invalido', mensagem: RESULTADOS.invalido };
    if (Number(ing.edicao_id) !== Number(ed.id))
      return { resultado: 'outra_edicao', mensagem: RESULTADOS.outra_edicao };
    const antes = await detalhes(cliente, ing);
    const r = resultadoDe(antes);
    if (r !== 'valido') {
      await registrarRecusa(cliente, id, ed.id, operador.id, r, aparelho);
      return { resultado: r, mensagem: RESULTADOS[r], ingresso: await detalhes(cliente, ing) };
    }
    const { rows: ins } = await cliente.query(
      `INSERT INTO checkins (ingresso_id, edicao_id, operador_id, resultado, aparelho, lido_no_aparelho_em)
       VALUES ($1, $2, $3, 'aceito', $4, $5)
       ON CONFLICT (ingresso_id) WHERE escopo = 'entrada' AND resultado = 'aceito' DO NOTHING
       RETURNING registrado_em`,
      [id, ed.id, operador.id, aparelho, lidoEm],
    );
    if (!ins[0]) {
      await registrarRecusa(cliente, id, ed.id, operador.id, 'ja_utilizado', aparelho);
      const depois = await detalhes(cliente, ing);
      return { resultado: 'ja_utilizado', mensagem: RESULTADOS.ja_utilizado, ingresso: depois };
    }
    await historicoDoIngresso(cliente, id, 'checkin', { autor: `operador:${operador.id}` });
    await medir(cliente, 'acesso:checkin_registra', ed.id, { escopo: 'entrada', resultado: 'aceito' });
    const depois = await detalhes(cliente, ing);
    return { resultado: 'entrada_registrada', mensagem: 'Entrada registrada', ingresso: depois };
  });
  return comIndicados(resposta);
}

// Entrega do benefício do ingresso (ex.: copão): uma vez só. A linha do
// benefício é travada; o segundo operador no mesmo instante vê "já entregue".
async function resgatarBeneficio(operador, edicaoId, ingressoId, beneficioId) {
  const ed = await permitida(operador, v.id(edicaoId, 'edição'));
  const id = v.id(ingressoId, 'ingresso');
  const bid = v.id(beneficioId, 'benefício');
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      `SELECT ib.*, i.edicao_id, i.status FROM ingresso_beneficios ib JOIN ingressos i ON i.id = ib.ingresso_id
        WHERE ib.ingresso_id = $1 AND ib.beneficio_id = $2 FOR UPDATE OF ib`,
      [id, bid],
    );
    const b = rows[0];
    if (!b || Number(b.edicao_id) !== Number(ed.id)) throw erro(404, 'Este ingresso não tem esse benefício.');
    if (b.status !== 'valido') throw erro(409, 'Ingresso cancelado ou bloqueado: o benefício não pode ser entregue.');
    if (b.resgatado_em) {
      return { resultado: 'ja_resgatado', mensagem: `${b.nome}: já entregue`, resgatado_em: b.resgatado_em };
    }
    const { rows: ok } = await cliente.query(
      `UPDATE ingresso_beneficios SET resgatado_em = now(), resgatado_por = $3
        WHERE ingresso_id = $1 AND beneficio_id = $2 AND resgatado_em IS NULL RETURNING resgatado_em`,
      [id, bid, `operador:${operador.id}`],
    );
    await medir(cliente, 'acesso:beneficio_resgata', ed.id, { beneficio_id: bid });
    return { resultado: 'resgatado', mensagem: `${b.nome}: entregue`, resgatado_em: ok[0].resgatado_em };
  });
}

// Entrega da recompensa de indicação na portaria (decisão do dono,
// 14/11/2026, item H): na leitura do ingresso principal da conta que indicou,
// uma vez só, independente da entrada. Registra quem entregou e quando, com
// auditoria. Recompensa revogada (indicação reembolsada antes da entrega) não
// se entrega.
async function entregarRecompensa(operador, edicaoId, ingressoId, recompensaId) {
  const ed = await permitida(operador, v.id(edicaoId, 'edição'));
  const id = v.id(ingressoId, 'ingresso');
  const rid = v.id(recompensaId, 'recompensa');
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      `SELECT i.id, i.edicao_id, i.status, p.cliente_id FROM ingressos i LEFT JOIN pedidos p ON p.id = i.pedido_id
        WHERE i.id = $1 FOR UPDATE OF i`,
      [id],
    );
    const ing = rows[0];
    if (!ing || Number(ing.edicao_id) !== Number(ed.id)) throw erro(404, 'ingresso não encontrado');
    if (ing.status !== 'valido')
      throw erro(409, 'Ingresso cancelado ou bloqueado: a recompensa não pode ser entregue.');
    if (!ing.cliente_id || (await principalDaConta(cliente, ing.cliente_id, ed.id)) !== Number(ing.id)) {
      throw erro(409, 'A recompensa de indicação é entregue no ingresso principal de quem indicou.');
    }
    const r = (await recompensasDaConta(cliente, ing.cliente_id, ed.id, { travar: true })).find(
      (x) => Number(x.id) === rid,
    );
    if (!r) throw erro(404, 'Esta recompensa não é deste ingresso.');
    if (r.status === 'entregue') {
      return {
        resultado: 'ja_entregue',
        mensagem: `${r.nome}: já entregue`,
        entregue_em: r.entregue_em,
        entregue_por: r.entregue_por,
      };
    }
    // Entrega única, com histórico e auditoria (campanhas.entregarPremio).
    const feito = await require('./campanhas').entregarPremio(cliente, rid, {
      autor: `operador:${operador.id}`,
      via: 'portaria',
    });
    await medir(cliente, 'acesso:recompensa_entrega', ed.id, { recompensa_id: rid });
    if (feito.resultado === 'ja_entregue') {
      return { resultado: 'ja_entregue', mensagem: `${r.nome}: já entregue`, entregue_em: feito.entregue_em };
    }
    return {
      resultado: 'entregue',
      mensagem: `${r.nome}: entregue`,
      entregue_em: feito.entregue_em,
      entregue_por: operador.nome,
    };
  });
}

// Contador da portaria: entradas registradas e ingressos válidos da edição.
async function contador(operador, edicaoId) {
  const ed = await permitida(operador, v.id(edicaoId, 'edição'));
  const { rows } = await consultar(
    `SELECT (SELECT count(*) FROM checkins WHERE edicao_id = $1 AND escopo = 'entrada' AND resultado = 'aceito')::int AS entradas,
            (SELECT count(*) FROM ingressos WHERE edicao_id = $1 AND status <> 'cancelado')::int AS ingressos`,
    [ed.id],
  );
  return rows[0];
}

// Rota única de entrega na portaria (PR 3): o prêmio de campanha por ordem de
// compra do ingresso lido OU a recompensa de indicação do ingresso principal
// da conta que indicou. O prêmio tem de ser DESTE ingresso; o de operador
// indicador nunca é entregue aqui (só pelo Admin). Uma vez só, com operador,
// data e hora (campanhas.entregarPremio).
async function entregarPremio(operador, edicaoId, ingressoId, premioId) {
  const ed = await permitida(operador, v.id(edicaoId, 'edição'));
  const id = v.id(ingressoId, 'ingresso');
  const pid = v.id(premioId, 'prêmio');
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      `SELECT i.id, i.edicao_id, i.status, p.cliente_id FROM ingressos i LEFT JOIN pedidos p ON p.id = i.pedido_id
        WHERE i.id = $1 FOR UPDATE OF i`,
      [id],
    );
    const ing = rows[0];
    if (!ing || Number(ing.edicao_id) !== Number(ed.id)) throw erro(404, 'ingresso não encontrado');
    const { rows: pr } = await cliente.query('SELECT * FROM campanha_premios WHERE id = $1', [pid]);
    const premio = pr[0];
    if (!premio) throw erro(404, 'Este prêmio não é deste ingresso.');
    if (premio.so_admin) throw erro(409, 'Esta recompensa é entregue só pelo Admin.');
    if (premio.ingresso_id) {
      if (Number(premio.ingresso_id) !== Number(ing.id)) throw erro(404, 'Este prêmio não é deste ingresso.');
    } else {
      // Indicação: só no ingresso principal da conta que indicou.
      if (!ing.cliente_id || (await principalDaConta(cliente, ing.cliente_id, ed.id)) !== Number(ing.id)) {
        throw erro(409, 'A recompensa de indicação é entregue no ingresso principal de quem indicou.');
      }
      const meus = await recompensasDaConta(cliente, ing.cliente_id, ed.id);
      if (!meus.some((x) => Number(x.id) === pid)) throw erro(404, 'Este prêmio não é deste ingresso.');
    }
    if (ing.status !== 'valido') throw erro(409, 'Ingresso cancelado ou bloqueado: o prêmio não pode ser entregue.');
    const feito = await require('./campanhas').entregarPremio(cliente, pid, {
      autor: `operador:${operador.id}`,
      via: 'portaria',
    });
    await medir(cliente, 'acesso:premio_entrega', ed.id, { premio_id: pid });
    return feito.resultado === 'ja_entregue'
      ? { resultado: 'ja_entregue', mensagem: `${premio.premio}: já entregue`, entregue_em: feito.entregue_em }
      : {
          resultado: 'entregue',
          mensagem: `${premio.premio}: entregue`,
          entregue_em: feito.entregue_em,
          entregue_por: operador.nome,
        };
  });
}

module.exports = {
  consultarIngresso,
  confirmar,
  contador,
  resgatarBeneficio,
  entregarRecompensa,
  entregarPremio,
  RESULTADOS,
};
