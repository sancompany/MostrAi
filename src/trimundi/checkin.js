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

async function detalhes(cliente, ingresso) {
  const { rows } = await cliente.query(
    `SELECT i.id, i.codigo_curto, i.origem, i.status, i.motivo_status, pa.nome AS participante, c.nome AS categoria,
            pr.nome AS promocao, ${colunasDeNumero('i')},
            COALESCE((SELECT json_agg(json_build_object('id', ib.beneficio_id, 'nome', ib.nome, 'resgatado_em', ib.resgatado_em,
                        'resgatado_por', (SELECT nome FROM operadores WHERE 'operador:' || operadores.id = ib.resgatado_por))
                        ORDER BY ib.nome) FROM ingresso_beneficios ib WHERE ib.ingresso_id = i.id), '[]') AS beneficios,
            ck.registrado_em AS utilizado_em, op.nome AS utilizado_por
       FROM ingressos i JOIN participantes pa ON pa.id = i.participante_id JOIN categorias c ON c.id = i.categoria_id
       LEFT JOIN promocoes pr ON pr.id = i.promocao_id
       LEFT JOIN checkins ck ON ck.ingresso_id = i.id AND ck.escopo = 'entrada' AND ck.resultado = 'aceito'
       LEFT JOIN operadores op ON op.id = ck.operador_id
      WHERE i.id = $1`,
    [ingresso.id],
  );
  const d = rows[0];
  return {
    id: d.id,
    codigo_curto: d.codigo_curto,
    participante: d.participante,
    // "Ingresso 2 de 4" do pedido: cada QR é uma unidade; validar um não
    // mexe nos outros do mesmo pedido.
    numero: d.numero,
    numero_de: d.numero_de,
    categoria: d.categoria,
    promocao: d.promocao,
    cortesia: d.origem === 'cortesia',
    beneficios: d.beneficios,
    status: d.status,
    motivo: d.motivo_status,
    utilizado_em: d.utilizado_em,
    utilizado_por: d.utilizado_por,
  };
}

function resultadoDe(d) {
  if (d.status === 'cancelado') return 'cancelado';
  if (d.status === 'bloqueado') return 'bloqueado';
  if (d.utilizado_em) return 'ja_utilizado';
  return 'valido';
}

async function consultarIngresso(operador, edicaoId, entrada) {
  const ed = await permitida(operador, v.id(edicaoId, 'edição'));
  const cliente = { query: (s, p) => consultar(s, p) };
  const achado = await acharIngresso(cliente, ed, entrada);
  if (!achado.ingresso) return { resultado: achado.resultado, mensagem: RESULTADOS[achado.resultado] };
  const d = await detalhes(cliente, achado.ingresso);
  const resultado = resultadoDe(d);
  return { resultado, mensagem: RESULTADOS[resultado], ingresso: d, classificacao_etaria: ed.classificacao_etaria };
}

async function confirmar(operador, edicaoId, ingressoId, { aparelho = null, lidoEm = null } = {}) {
  const ed = await permitida(operador, v.id(edicaoId, 'edição'));
  const id = v.id(ingressoId, 'ingresso');
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM ingressos WHERE id = $1 FOR UPDATE', [id]);
    const ing = rows[0];
    if (!ing) return { resultado: 'invalido', mensagem: RESULTADOS.invalido };
    if (Number(ing.edicao_id) !== Number(ed.id))
      return { resultado: 'outra_edicao', mensagem: RESULTADOS.outra_edicao };
    const antes = await detalhes(cliente, ing);
    const r = resultadoDe(antes);
    if (r !== 'valido') {
      await cliente.query(
        `INSERT INTO checkins (ingresso_id, edicao_id, operador_id, resultado, motivo, aparelho)
         VALUES ($1, $2, $3, 'recusado', $4, $5)`,
        [id, ed.id, operador.id, r, aparelho],
      );
      return { resultado: r, mensagem: RESULTADOS[r], ingresso: antes };
    }
    const { rows: ins } = await cliente.query(
      `INSERT INTO checkins (ingresso_id, edicao_id, operador_id, resultado, aparelho, lido_no_aparelho_em)
       VALUES ($1, $2, $3, 'aceito', $4, $5)
       ON CONFLICT (ingresso_id) WHERE escopo = 'entrada' AND resultado = 'aceito' DO NOTHING
       RETURNING registrado_em`,
      [id, ed.id, operador.id, aparelho, lidoEm],
    );
    if (!ins[0]) {
      const depois = await detalhes(cliente, ing);
      return { resultado: 'ja_utilizado', mensagem: RESULTADOS.ja_utilizado, ingresso: depois };
    }
    await historicoDoIngresso(cliente, id, 'checkin', { autor: `operador:${operador.id}` });
    await medir(cliente, 'acesso:checkin_registra', ed.id, { escopo: 'entrada', resultado: 'aceito' });
    const depois = await detalhes(cliente, ing);
    return { resultado: 'entrada_registrada', mensagem: 'Entrada registrada', ingresso: depois };
  });
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

module.exports = { consultarIngresso, confirmar, contador, resgatarBeneficio, RESULTADOS };
