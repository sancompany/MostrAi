const crypto = require('node:crypto');
const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { chavePublicaDaEdicao } = require('./lib/qr');
const { historicoDoIngresso, medir } = require('./lib/registro');
const { edicoesPermitidas } = require('./operadores');
const { colunasDeNumero } = require('./lib/numeracao');

// Check-in offline (pedido do dono, 10/11/2026).
//
// PACOTE (baixado antes de perder a conexão): por ingresso da edição, o
// hash SHA-256 do código do QR e do código curto, a situação, se já entrou, o
// tipo e só o PRIMEIRO nome do titular — nada de CPF, e-mail, sobrenome nem o
// código em claro. Mais a chave pública Ed25519 da edição, com a qual o
// aparelho confere a assinatura do QR (TM1.<edição>.<código>.<assinatura>):
// o QR não é aceito só pelo que mostra. O código do QR tem 132 bits
// aleatórios; achar um que bata com um hash do pacote sem ter o ingresso não
// é viável. O código curto tem 40 bits — o hash dele (com o código público da
// edição na frente) evita lista em claro, mas não resiste a força bruta: quem
// tem o pacote é o operador autorizado da edição.
//
// SINCRONIZAÇÃO: cada entrada aceita no aparelho vem com um id próprio
// (registro_id); reenviar não duplica. O servidor confere de novo e decide
// com a mesma regra do online — uma entrada aceita por ingresso. A que chega
// depois (de outro aparelho desconectado, ou de uma leitura online no
// meio-tempo) ou de ingresso que foi cancelado/bloqueado depois do pacote
// fica gravada como recusada, com o motivo: é o CONFLITO que o Admin vê.
// Dois aparelhos sem internet não se falam: os dois podem deixar a mesma
// pessoa entrar. Isso não se impede — se detecta aqui.

const MAX_REGISTROS = 500;
const APARELHO = /^[A-Za-z0-9_-]{8,64}$/;

const hash = (texto) => crypto.createHash('sha256').update(texto).digest('base64url');
const hashDoCurto = (codigoPublico, curto) => hash(`${codigoPublico}:${curto}`);
const primeiroNome = (nome) =>
  String(nome || '')
    .trim()
    .split(/\s+/)[0] || '';

async function permitida(operador, edicaoId) {
  const lista = await edicoesPermitidas(operador.id);
  const ed = lista.find((e) => Number(e.id) === Number(edicaoId));
  if (!ed) throw erro(403, 'Você não tem acesso ao check-in desta edição.');
  return ed;
}

async function pacote(operador, edicaoId) {
  const ed = await permitida(operador, v.id(edicaoId, 'edição'));
  const { rows } = await consultar(
    `SELECT i.id, i.codigo, i.codigo_curto, i.status, c.nome AS categoria, pa.nome, ${colunasDeNumero('i')},
            EXISTS (SELECT 1 FROM checkins ck WHERE ck.ingresso_id = i.id AND ck.escopo = 'entrada' AND ck.resultado = 'aceito') AS utilizado
       FROM ingressos i JOIN categorias c ON c.id = i.categoria_id JOIN participantes pa ON pa.id = i.participante_id
      WHERE i.edicao_id = $1
      ORDER BY i.id`,
    [ed.id],
  );
  const { rows: agora } = await consultar('SELECT now() AS agora');
  return {
    versao: 1,
    gerado_em: agora[0].agora,
    edicao: {
      id: ed.id,
      nome: `${ed.evento} — ${ed.nome}`,
      codigo_publico: ed.codigo_publico,
      classificacao_etaria: ed.classificacao_etaria,
    },
    // SPKI DER (base64url) da chave pública Ed25519 da edição.
    chave_publica: chavePublicaDaEdicao(ed.codigo_publico),
    ingressos: rows.map((r) => ({
      i: Number(r.id),
      h: hash(r.codigo),
      c: hashDoCurto(ed.codigo_publico, r.codigo_curto),
      s: r.status,
      u: r.utilizado,
      t: r.categoria,
      n: primeiroNome(r.nome),
      // Número do ingresso no pedido e quantos o pedido tem (cortesia: nulos).
      o: r.numero,
      q: r.numero_de,
    })),
  };
}

// Hora da leitura no aparelho: só se for plausível (o relógio do celular
// pode estar errado). Fora disso, fica sem — vale a hora do servidor.
function lidoEm(valor) {
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  const agora = Date.now();
  if (d.getTime() > agora + 5 * 60000 || d.getTime() < agora - 7 * 86400000) return null;
  return d;
}

function lerRegistros(lista) {
  if (!Array.isArray(lista) || !lista.length) throw erro(400, 'nada para sincronizar');
  if (lista.length > MAX_REGISTROS) throw erro(400, `envie até ${MAX_REGISTROS} registros por vez`);
  return lista
    .map((r) => {
      const registroId = v.uuid(r?.registro_id);
      if (!registroId) throw erro(400, 'registro sem identificação válida');
      return { registroId, ingressoId: v.id(r?.ingresso_id, 'ingresso'), lidoEm: lidoEm(r?.lido_em) };
    })
    .sort((a, b) => (a.lidoEm?.getTime() ?? Infinity) - (b.lidoEm?.getTime() ?? Infinity));
}

const RESPOSTA = (registroId, ck, extra = {}) => ({
  registro_id: registroId,
  resultado:
    ck.resultado === 'aceito'
      ? 'aceito'
      : String(ck.motivo || '').startsWith('offline:ja_utilizado')
        ? 'conflito'
        : 'recusado',
  motivo: ck.motivo || null,
  ...extra,
});

async function entradaVigente(cliente, ingressoId) {
  const { rows } = await cliente.query(
    `SELECT ck.registrado_em, ck.lido_no_aparelho_em, ck.modo, op.nome AS operador
       FROM checkins ck JOIN operadores op ON op.id = ck.operador_id
      WHERE ck.ingresso_id = $1 AND ck.escopo = 'entrada' AND ck.resultado = 'aceito'`,
    [ingressoId],
  );
  return rows[0] || null;
}

async function sincronizarUm(operador, ed, aparelhoId, r) {
  return emTransacao(async (cliente) => {
    const ja = await cliente.query('SELECT resultado, motivo FROM checkins WHERE registro_id = $1', [r.registroId]);
    if (ja.rows[0]) return RESPOSTA(r.registroId, ja.rows[0], { repetido: true });
    const { rows } = await cliente.query('SELECT id, edicao_id, status FROM ingressos WHERE id = $1 FOR UPDATE', [
      r.ingressoId,
    ]);
    const ing = rows[0];
    if (!ing || Number(ing.edicao_id) !== Number(ed.id)) {
      return { registro_id: r.registroId, resultado: 'invalido', motivo: 'ingresso não é desta edição' };
    }
    const gravar = (resultado, motivo) =>
      cliente.query(
        `INSERT INTO checkins (ingresso_id, edicao_id, operador_id, resultado, motivo, lido_no_aparelho_em, aparelho,
                               registro_id, modo, aparelho_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'offline', $7, 'offline', $8)
         ON CONFLICT (ingresso_id) WHERE escopo = 'entrada' AND resultado = 'aceito' DO NOTHING
         RETURNING id`,
        [ing.id, ed.id, operador.id, resultado, motivo, r.lidoEm, r.registroId, aparelhoId],
      );
    if (ing.status !== 'valido') {
      await gravar('recusado', `offline:${ing.status}`);
      return { registro_id: r.registroId, resultado: 'recusado', motivo: `offline:${ing.status}` };
    }
    const ok = await gravar('aceito', null);
    if (ok.rows[0]) {
      await historicoDoIngresso(cliente, ing.id, 'checkin', { autor: `operador:${operador.id}`, motivo: 'offline' });
      await medir(cliente, 'acesso:checkin_registra', ed.id, {
        escopo: 'entrada',
        resultado: 'aceito',
        modo: 'offline',
      });
      return { registro_id: r.registroId, resultado: 'aceito', motivo: null };
    }
    const vigente = await entradaVigente(cliente, ing.id);
    await gravar('recusado', 'offline:ja_utilizado');
    return { registro_id: r.registroId, resultado: 'conflito', motivo: 'offline:ja_utilizado', entrada: vigente };
  });
}

async function sincronizar(operador, corpo) {
  const ed = await permitida(operador, v.id(corpo?.edicao_id, 'edição'));
  const aparelhoId = String(corpo?.aparelho_id ?? '');
  if (!APARELHO.test(aparelhoId)) throw erro(400, 'aparelho sem identificação válida');
  const registros = lerRegistros(corpo?.registros);
  const resultados = [];
  for (const r of registros) {
    try {
      resultados.push(await sincronizarUm(operador, ed, aparelhoId, r));
    } catch (err) {
      // O mesmo registro chegando duas vezes ao mesmo tempo (reenvio): o
      // índice único do registro_id barra o segundo; vale o que já gravou.
      if (err.code === '23505' && /registro_id/.test(err.constraint || err.message)) {
        const { rows } = await consultar('SELECT resultado, motivo FROM checkins WHERE registro_id = $1', [
          r.registroId,
        ]);
        resultados.push(RESPOSTA(r.registroId, rows[0], { repetido: true }));
      } else {
        throw err;
      }
    }
  }
  return { resultados };
}

// Admin: leituras offline que o servidor não aceitou (entrada que já
// existia, ingresso cancelado ou bloqueado depois do pacote) e a entrada
// que valeu.
async function conflitos(edicaoId) {
  const { rows } = await consultar(
    `SELECT ck.id, ck.motivo, ck.lido_no_aparelho_em, ck.registrado_em, ck.aparelho_id, op.nome AS operador,
            i.id AS ingresso_id, i.codigo_curto, i.status AS ingresso_status, c.nome AS categoria, pa.nome AS participante,
            vence.registrado_em AS entrada_em, vence.lido_no_aparelho_em AS entrada_lida_em, vence.modo AS entrada_modo,
            opv.nome AS entrada_operador
       FROM checkins ck
       JOIN operadores op ON op.id = ck.operador_id
       JOIN ingressos i ON i.id = ck.ingresso_id JOIN categorias c ON c.id = i.categoria_id
       JOIN participantes pa ON pa.id = i.participante_id
       LEFT JOIN checkins vence ON vence.ingresso_id = ck.ingresso_id AND vence.escopo = 'entrada' AND vence.resultado = 'aceito'
       LEFT JOIN operadores opv ON opv.id = vence.operador_id
      WHERE ck.edicao_id = $1 AND ck.modo = 'offline' AND ck.resultado = 'recusado'
      ORDER BY ck.registrado_em DESC
      LIMIT 500`,
    [edicaoId],
  );
  const MOTIVO = {
    'offline:ja_utilizado': 'entrada liberada offline, mas o ingresso já tinha entrada registrada',
    'offline:cancelado': 'entrada liberada offline com ingresso cancelado depois do pacote',
    'offline:bloqueado': 'entrada liberada offline com ingresso bloqueado depois do pacote',
  };
  return rows.map((r) => ({
    id: r.id,
    ingresso_id: r.ingresso_id,
    codigo_curto: r.codigo_curto,
    categoria: r.categoria,
    participante: r.participante,
    motivo: MOTIVO[r.motivo] || r.motivo,
    lido_em: r.lido_no_aparelho_em,
    sincronizado_em: r.registrado_em,
    operador: r.operador,
    aparelho: r.aparelho_id,
    entrada_valida: r.entrada_em
      ? { em: r.entrada_lida_em || r.entrada_em, operador: r.entrada_operador, modo: r.entrada_modo }
      : null,
  }));
}

module.exports = { pacote, sincronizar, conflitos, hash, hashDoCurto, MAX_REGISTROS };
