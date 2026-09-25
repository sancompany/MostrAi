const pool = require('../db/pool');
const telaEventos = require('./tela-eventos');
const { TOLERANCIA_SEM_SINAL_MS } = require('../lib/status-tela');
const { sincronizarStatusPonto } = require('../pontos/repository');

// Sinal de vida do Player: hello (dados que não mudam) e heartbeat (estado de
// agora). Os dois viram SNAPSHOT nas colunas da própria tela — uma linha,
// sobrescrita — e só as transições viram linha em `tela_eventos`.
//
// Leitura tolerante, campo a campo (contrato §5, "campo ausente = não
// mexa"): um campo com tipo errado é ignorado, o resto vale, e o sinal de
// vida (`ultima_vez_online`) é gravado de qualquer jeito. 400 fica para corpo
// que nem é objeto JSON.

const ESTADOS = new Set([
  'PLAYING',
  'IDLE',
  'OUT_OF_SCHEDULE',
  'NO_PLAYLIST',
  'DOWNLOAD_ERROR',
  'PLAYBACK_ERROR',
  'AUTH_ERROR',
  'NOT_PROVISIONED',
  'CONFIG_ERROR',
  'UPDATE_PENDING',
]);
const ESTADOS_UPDATE = new Set([
  'NONE',
  'AVAILABLE',
  'DOWNLOADING',
  'READY',
  'INSTALL_REQUESTED',
  'DEFERRED',
  'FAILED',
]);
const EVENTO_DO_UPDATE = { DOWNLOADING: 'UPDATE_STARTED', READY: 'UPDATE_READY', FAILED: 'UPDATE_FAILED' };

const texto = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const inteiro = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
function data(v) {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
// O Player já sanitiza (DiarioBordo.sanitizar); aqui só garante texto
// imprimível e curto antes de ir para o banco e para o admin.
const mensagem = (v) => {
  const t = texto(v, 300);
  // Caractere de controle vira espaço (quebra de linha, escape de terminal).
  return t ? Array.from(t, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('') : null;
};
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Leitura dos corpos
// ---------------------------------------------------------------------------
function lerHello(corpo) {
  return {
    contrato: inteiro(corpo.contrato, 1, 99),
    versao: texto(corpo.versaoApp, 32),
    build: inteiro(corpo.buildNumber, 1, 2_000_000_000),
    fabricante: texto(corpo.fabricante, 64),
    modelo: texto(corpo.modelo, 64),
    android: texto(corpo.android, 32),
    largura: inteiro(corpo.largura, 1, 20000),
    altura: inteiro(corpo.altura, 1, 20000),
    timezone: texto(corpo.timezone, 64),
  };
}

// V2 = corpo com `versaoContrato` numérico (contrato §4.1). Qualquer outra
// coisa é o heartbeat V1: corpo vazio (Android legado) ou `{erro: "texto"}`
// (player web, migration 076).
function lerHeartbeat(corpo) {
  if (typeof corpo.versaoContrato !== 'number') {
    const erro = mensagem(corpo.erro);
    return { v2: false, erro: erro ? { codigo: null, mensagem: erro, em: null } : null, erroInformado: true };
  }
  const hb = { v2: true, versaoContrato: corpo.versaoContrato };
  hb.estado = ESTADOS.has(corpo.estado) ? corpo.estado : null;
  hb.configVersionAplicada = inteiro(corpo.configVersionAplicada, 0, 2_000_000_000);
  // Ausente = nenhum item comercial no ar agora.
  hb.criativoId = typeof corpo.criativoId === 'number' ? String(corpo.criativoId) : texto(corpo.criativoId, 100);
  // Ausente = nunca buscou com sucesso (contrato §4.1).
  hb.ultimaPlaylistOkEm = data(corpo.ultimaPlaylistOkEm);
  hb.filaInformada = ehObjeto(corpo.fila) && inteiro(corpo.fila.pendentes, 0, 10_000_000) != null;
  if (hb.filaInformada) {
    hb.filaPendentes = corpo.fila.pendentes;
    hb.filaMaisAntigoEm = data(corpo.fila.maisAntigoEm);
  }
  // `erro: null` explícito = "sem erro" (limpa); ausente = não informado.
  hb.erroInformado = 'erro' in corpo && (corpo.erro === null || ehObjeto(corpo.erro));
  hb.erro =
    hb.erroInformado && corpo.erro
      ? {
          codigo: texto(corpo.erro.codigo, 64)?.replace(/[^A-Za-z0-9_.-]/g, '_') || 'ERRO',
          mensagem: mensagem(corpo.erro.mensagem),
          em: data(corpo.erro.ocorreuEm),
        }
      : null;
  hb.desvioRelogioMs =
    Number.isInteger(corpo.desvioRelogioMs) && Math.abs(corpo.desvioRelogioMs) < 1e12 ? corpo.desvioRelogioMs : null;
  hb.updateEstado = ehObjeto(corpo.update) && ESTADOS_UPDATE.has(corpo.update.estado) ? corpo.update.estado : null;
  return hb;
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------
// Transições comuns aos dois sinais: primeiro sinal, volta depois de sumir,
// build novo (atualização instalada). Devolve os eventos a gravar.
function transicoesDeVida(antes, agora, build) {
  const eventos = [];
  if (!antes.primeiro_sinal_em) eventos.push(['FIRST_SEEN', null]);
  else if (antes.ultima_vez_online && agora - new Date(antes.ultima_vez_online) > TOLERANCIA_SEM_SINAL_MS) {
    const desde = new Date(antes.ultima_vez_online);
    eventos.push(['OFFLINE', { ultimoSinal: desde }, new Date(desde.getTime() + TOLERANCIA_SEM_SINAL_MS)]);
    eventos.push(['ONLINE', { semSinalMin: Math.round((agora - desde) / 60000) }]);
  }
  if (build != null && antes.player_build != null && build > antes.player_build) {
    eventos.push(['UPDATE_INSTALLED', { deBuild: antes.player_build, paraBuild: build }]);
  }
  return eventos;
}

async function comTela(telaId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM dispositivos WHERE id = $1 FOR UPDATE', [telaId]);
    const resultado = await fn(client, rows[0]);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// O status do ponto sai DEPOIS do commit, em transação própria: mudar o
// ponto dispara o gatilho que marca a playlist de todas as telas dele — com a
// linha desta tela ainda travada pelo FOR UPDATE, dois primeiros sinais (ou
// um primeiro sinal e uma edição do admin) podiam travar um ao outro.
async function depoisDoCommit(r) {
  if (r.primeiroSinal) await sincronizarStatusPonto(r.pontoId);
  return r;
}

async function gravarEventos(client, telaId, eventos) {
  for (const [tipo, detalhe, em] of eventos) await telaEventos.registrar(telaId, tipo, detalhe, client, em || null);
}

async function registrarHello(telaId, corpo, player) {
  const h = lerHello(corpo);
  // Header é o que o Player manda em toda requisição; o corpo do hello vence
  // quando os dois existem (é o dado declarado para isso).
  const contrato = h.contrato ?? player.contrato;
  const versao = h.versao ?? player.versao;
  const build = h.build ?? player.build;
  const agora = new Date();
  return comTela(telaId, async (client, antes) => {
    const eventos = transicoesDeVida(antes, agora, build);
    await client.query(
      `UPDATE dispositivos
          SET player_contrato = COALESCE($2, player_contrato), player_versao = COALESCE($3, player_versao),
              player_build = COALESCE($4, player_build),
              aparelho_fabricante = $5, aparelho_modelo = $6, aparelho_android = $7,
              aparelho_largura = $8, aparelho_altura = $9, aparelho_timezone = $10,
              hello_primeiro_em = COALESCE(hello_primeiro_em, now()), hello_ultimo_em = now(),
              primeiro_sinal_em = COALESCE(primeiro_sinal_em, now()), ultima_vez_online = now()
        WHERE id = $1`,
      [telaId, contrato, versao, build, h.fabricante, h.modelo, h.android, h.largura, h.altura, h.timezone],
    );
    await gravarEventos(client, telaId, eventos);
    return { primeiroSinal: !antes.primeiro_sinal_em, pontoId: antes.ponto_id, eventos: eventos.map((e) => e[0]) };
  }).then(depoisDoCommit);
}

async function registrarHeartbeat(telaId, corpo, player) {
  const hb = lerHeartbeat(corpo);
  const agora = new Date();
  const contrato = hb.v2 ? Math.max(2, player.contrato || 2) : player.contrato || 1;
  return comTela(telaId, async (client, antes) => {
    const eventos = transicoesDeVida(antes, agora, player.build);

    const sets = [
      'ultima_vez_online = now()',
      'primeiro_sinal_em = COALESCE(primeiro_sinal_em, now())',
      'player_contrato = $2',
      'player_versao = COALESCE($3, player_versao)',
      'player_build = COALESCE($4, player_build)',
    ];
    const valores = [telaId, contrato, player.versao, player.build];
    const set = (coluna, valor) => {
      valores.push(valor);
      sets.push(`${coluna} = $${valores.length}`);
    };

    if (hb.erroInformado) {
      const antesCodigo = antes.ultimo_erro_codigo || (antes.ultimo_erro ? 'ERRO' : null);
      const agoraCodigo = hb.erro ? hb.erro.codigo || 'ERRO' : null;
      if (!antesCodigo && agoraCodigo)
        eventos.push(['ERROR_STARTED', { codigo: hb.erro.codigo, mensagem: hb.erro.mensagem }]);
      else if (antesCodigo && !agoraCodigo) eventos.push(['ERROR_RESOLVED', { codigo: antes.ultimo_erro_codigo }]);
      else if (antesCodigo && agoraCodigo && antesCodigo !== agoraCodigo) {
        eventos.push(['ERROR_STARTED', { codigo: hb.erro.codigo, mensagem: hb.erro.mensagem }]);
      }
      set('ultimo_erro_codigo', hb.erro?.codigo || null);
      set('ultimo_erro', hb.erro?.mensagem || null);
      // Hora do erro: a que o Player registrou (V2) ou a de agora (V1).
      set('ultimo_erro_em', hb.erro ? hb.erro.em || agora : null);
    }

    if (hb.v2) {
      set('player_estado', hb.estado);
      set('criativo_atual', hb.criativoId);
      set('ultima_playlist_ok_em', hb.ultimaPlaylistOkEm);
      if (hb.filaInformada) {
        set('fila_pendentes', hb.filaPendentes);
        set('fila_mais_antigo_em', hb.filaMaisAntigoEm);
      }
      set('desvio_relogio_ms', hb.desvioRelogioMs);
      if (hb.configVersionAplicada != null) {
        // 0 = "nunca recebeu config" (contrato §4.1): não é uma aplicação.
        if (hb.configVersionAplicada !== antes.config_versao_aplicada && hb.configVersionAplicada > 0) {
          set('config_aplicada_em', agora);
          eventos.push(['CONFIG_APPLIED', { versao: hb.configVersionAplicada }]);
        }
        set('config_versao_aplicada', hb.configVersionAplicada);
      }
      if (hb.updateEstado !== antes.update_estado) {
        set('update_estado', hb.updateEstado);
        set('update_estado_em', agora);
        if (EVENTO_DO_UPDATE[hb.updateEstado]) eventos.push([EVENTO_DO_UPDATE[hb.updateEstado], null]);
      }
    }

    await client.query(`UPDATE dispositivos SET ${sets.join(', ')} WHERE id = $1`, valores);
    await gravarEventos(client, telaId, eventos);
    return {
      v2: hb.v2,
      primeiroSinal: !antes.primeiro_sinal_em,
      pontoId: antes.ponto_id,
      eventos: eventos.map((e) => e[0]),
    };
  }).then(depoisDoCommit);
}

// compat-v1: o player web pede a playlist e manda o heartbeat ao mesmo tempo
// no boot. Sem isto, a primeira playlist de uma TV nova sai com o ponto
// ainda "Aguardando instalação" — fora da cobertura — e só se corrige no
// próximo poll (15 min). Uma requisição autenticada é contato; o FOR UPDATE
// do heartbeat e o `IS NULL` daqui garantem um FIRST_SEEN só.
async function registrarPrimeiroContato(telaId) {
  const { rows } = await pool.query(
    `UPDATE dispositivos SET primeiro_sinal_em = now(), ultima_vez_online = now()
      WHERE id = $1 AND primeiro_sinal_em IS NULL
      RETURNING ponto_id`,
    [telaId],
  );
  if (!rows[0]) return false;
  await telaEventos.registrar(telaId, 'FIRST_SEEN', { via: 'playlist' });
  await sincronizarStatusPonto(rows[0].ponto_id);
  return true;
}

// `playlist.atualizar` UMA vez por mudança (contrato §6.2): true só se há
// marca de "desatualizada" que ainda não foi avisada, e já grava que avisou.
async function sinalizarPlaylist(telaId, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE dispositivos SET playlist_sinalizada_em = now()
      WHERE id = $1 AND playlist_desatualizada_em IS NOT NULL
        AND (playlist_sinalizada_em IS NULL OR playlist_sinalizada_em < playlist_desatualizada_em)`,
    [telaId],
  );
  return rowCount > 0;
}

module.exports = {
  ESTADOS,
  ESTADOS_UPDATE,
  lerHello,
  lerHeartbeat,
  registrarHello,
  registrarHeartbeat,
  registrarPrimeiroContato,
  sinalizarPlaylist,
};
