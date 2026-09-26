const pool = require('../db/pool');
const telaEventos = require('./tela-eventos');
const { TOLERANCIA_SEM_SINAL_MS } = require('../lib/status-tela');
const { sincronizarStatusPonto } = require('../pontos/repository');

// Sinal de vida do Player: o heartbeat (estado de agora, a cada 15 s —
// docs/player-mvp-contract.md §5). Vira SNAPSHOT nas colunas da própria
// tela — uma linha, sobrescrita — e só as transições viram linha em
// `tela_eventos`.
//
// Leitura tolerante, campo a campo: um campo com tipo errado é ignorado, o
// resto vale, e o sinal de vida (`ultima_vez_online`) é gravado de qualquer
// jeito. 400 fica para corpo que nem é objeto JSON.

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
]);

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
// Snapshot (contrato §5): `estado` e `criativoId` valem para AGORA —
// ausentes, ficam "não informado"/"nenhum". `erro` e `fila` ausentes não
// mexem no que estava; `erro: null` limpa. A versão do Player vem só do
// header X-Player-Version.
function lerHeartbeat(corpo) {
  const hb = {};
  hb.estado = ESTADOS.has(corpo.estado) ? corpo.estado : null;
  hb.configVersionAplicada = inteiro(corpo.configVersionAplicada, 0, 2_000_000_000);
  hb.criativoId = Number.isInteger(corpo.criativoId) ? String(corpo.criativoId) : texto(corpo.criativoId, 100);
  hb.filaInformada = ehObjeto(corpo.fila) && inteiro(corpo.fila.pendentes, 0, 10_000_000) != null;
  if (hb.filaInformada) {
    hb.filaPendentes = corpo.fila.pendentes;
    hb.filaMaisAntigoEm = data(corpo.fila.maisAntigoEm);
  }
  hb.erroInformado = 'erro' in corpo && (corpo.erro === null || ehObjeto(corpo.erro));
  hb.erro =
    hb.erroInformado && corpo.erro
      ? {
          codigo: texto(corpo.erro.codigo, 64)?.replace(/[^A-Za-z0-9_.-]/g, '_') || 'ERRO',
          mensagem: mensagem(corpo.erro.mensagem),
          em: data(corpo.erro.ocorreuEm),
        }
      : null;
  return hb;
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------
// Transições de vida: primeiro sinal e volta depois de sumir. Devolve os
// eventos a gravar.
function transicoesDeVida(antes, agora) {
  const eventos = [];
  if (!antes.primeiro_sinal_em) eventos.push(['FIRST_SEEN', null]);
  else if (antes.ultima_vez_online && agora - new Date(antes.ultima_vez_online) > TOLERANCIA_SEM_SINAL_MS) {
    const desde = new Date(antes.ultima_vez_online);
    eventos.push(['OFFLINE', { ultimoSinal: desde }, new Date(desde.getTime() + TOLERANCIA_SEM_SINAL_MS)]);
    eventos.push(['ONLINE', { semSinalMin: Math.round((agora - desde) / 60000) }]);
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

async function registrarHeartbeat(telaId, corpo, player) {
  const hb = lerHeartbeat(corpo);
  const agora = new Date();
  return comTela(telaId, async (client, antes) => {
    const eventos = transicoesDeVida(antes, agora);

    const sets = [
      'ultima_vez_online = now()',
      'primeiro_sinal_em = COALESCE(primeiro_sinal_em, now())',
      'player_versao = COALESCE($2, player_versao)',
      'player_build = COALESCE($3, player_build)',
    ];
    const valores = [telaId, player.versao, player.build];
    const set = (coluna, valor) => {
      valores.push(valor);
      sets.push(`${coluna} = $${valores.length}`);
    };

    set('player_estado', hb.estado);
    set('criativo_atual', hb.criativoId);

    if (hb.erroInformado) {
      const antesCodigo = antes.ultimo_erro_codigo || (antes.ultimo_erro ? 'ERRO' : null);
      const agoraCodigo = hb.erro ? hb.erro.codigo : null;
      if (agoraCodigo && agoraCodigo !== antesCodigo) {
        eventos.push(['ERROR_STARTED', { codigo: hb.erro.codigo, mensagem: hb.erro.mensagem }]);
      } else if (antesCodigo && !agoraCodigo) {
        eventos.push(['ERROR_RESOLVED', { codigo: antes.ultimo_erro_codigo }]);
      }
      set('ultimo_erro_codigo', hb.erro?.codigo || null);
      set('ultimo_erro', hb.erro?.mensagem || null);
      set('ultimo_erro_em', hb.erro ? hb.erro.em || agora : null);
    }

    if (hb.filaInformada) {
      set('fila_pendentes', hb.filaPendentes);
      set('fila_mais_antigo_em', hb.filaMaisAntigoEm);
    }

    if (hb.configVersionAplicada != null) {
      // 0 = "nunca recebeu config": não é uma aplicação.
      if (hb.configVersionAplicada !== antes.config_versao_aplicada && hb.configVersionAplicada > 0) {
        set('config_aplicada_em', agora);
        eventos.push(['CONFIG_APPLIED', { versao: hb.configVersionAplicada }]);
      }
      set('config_versao_aplicada', hb.configVersionAplicada);
    }

    await client.query(`UPDATE dispositivos SET ${sets.join(', ')} WHERE id = $1`, valores);
    await gravarEventos(client, telaId, eventos);
    return { primeiroSinal: !antes.primeiro_sinal_em, pontoId: antes.ponto_id, eventos: eventos.map((e) => e[0]) };
  }).then(depoisDoCommit);
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
  lerHeartbeat,
  registrarHeartbeat,
  sinalizarPlaylist,
};
