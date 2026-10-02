const pool = require('../db/pool');

// TEMPO OPERACIONAL DA TELA DO PONTO MÓVEL (migration 113). É a régua do
// benefício da hospedagem (src/pontos/hospedagem.js#tempoOperacional): o
// tempo em que a tela esteve LIGADA, OPERACIONAL e APTA A EXIBIR — nunca a
// duração do calendário, e nunca um número que o servidor inventa.
//
// Duas fontes, ambas no relógio do servidor, que se somam por UNIÃO (o mesmo
// minuto visto pelas duas conta uma vez):
//   · heartbeat (online): a cada batida com o Player exibindo (PLAYING ou
//     IDLE — o institucional também é a tela no ar), o intervalo aberto da
//     tela se estende até agora — só se a batida anterior TAMBÉM foi
//     exibindo e veio dentro da tolerância (o APK bate a cada 5 min:
//     tolerância de 6 min 30 s, uma batida + 30%). Um buraco maior fecha o
//     intervalo e a próxima batida abre outro — sinal perdido não vira
//     tempo. É o piso para o APK atual; o Player novo manda também os
//     segmentos dele (online e offline), e a união não conta duas vezes;
//   · segmentos do Player (offline): o Player conta o que exibiu sem
//     internet com o relógio MONOTÔNICO do aparelho (imune a acerto de
//     relógio), ancorado no `servidorAgora` que recebeu do servidor no
//     mesmo boot, e manda quando volta. Idempotente por (tela, boot, seq):
//     reenvio, retry e duplicata gravam uma vez; um segmento que cresceu
//     (o Player reenvia o aberto) só estende.
// Só tela de ponto MÓVEL grava aqui — ponto fixo não tem hospedagem.

const ESTADOS_EXIBINDO = new Set(['PLAYING', 'IDLE']);
// O APK bate a cada 5 min (playlist.mostrai, PlayerActivity
// INTERVALO_HEARTBEAT_MS) — conferido em 02/10/2026; o contrato antigo dizia
// 15 s. Uma batida perdida já fecha o intervalo.
const TOLERANCIA_SEGUNDOS = 390;
const SEGMENTO_MAXIMO_MS = 6 * 3600 * 1000;
const FUTURO_TOLERADO_MS = 2 * 60 * 1000;
// O mesmo prazo do Proof-of-Play offline (7 dias) + 1 dia de folga: o
// Player que ficou uma semana sem rede ainda entrega o que contou.
const PASSADO_ACEITO_MS = 8 * 24 * 3600 * 1000;
const TETO_LOTE = 200;
const BOOT_ID = /^[A-Za-z0-9._:-]{1,64}$/;

// Dentro da transação do heartbeat (a linha da tela está travada: duas
// batidas da mesma tela nunca abrem dois intervalos).
// `tela`: a linha de ANTES desta batida — `player_estado` é o da batida
// anterior. Só estende se ela também era exibindo: uma batida fora do ar no
// meio (fora do horário, erro) quebra o intervalo.
async function registrarPeloHeartbeat(client, tela, estado) {
  if (!ESTADOS_EXIBINDO.has(estado)) return false;
  const { rowCount } = !ESTADOS_EXIBINDO.has(tela.player_estado)
    ? { rowCount: 0 }
    : await client.query(
        `UPDATE tela_operacao SET fim = now()
      WHERE id = (SELECT id FROM tela_operacao
                   WHERE dispositivo_id = $1 AND origem = 'heartbeat'
                     AND fim >= now() - make_interval(secs => $2) AND fim <= now()
                   ORDER BY fim DESC LIMIT 1)`,
        [tela.id, TOLERANCIA_SEGUNDOS],
      );
  if (rowCount) return true;
  const { rowCount: novo } = await client.query(
    `INSERT INTO tela_operacao (dispositivo_id, origem, inicio, fim)
     SELECT $1, 'heartbeat', now(), now()
      WHERE EXISTS (SELECT 1 FROM pontos WHERE id = $2 AND tipo = 'movel')`,
    [tela.id, tela.ponto_id],
  );
  return novo > 0;
}

function lerSegmento(s, agora) {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return null;
  const bootId = typeof s.bootId === 'string' ? s.bootId.trim() : '';
  if (!BOOT_ID.test(bootId) || !Number.isInteger(s.seq) || s.seq < 0 || s.seq > 2_000_000_000) return null;
  const inicio = typeof s.inicio === 'string' ? new Date(s.inicio) : null;
  const fim = typeof s.fim === 'string' ? new Date(s.fim) : null;
  if (!inicio || !fim || Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) return null;
  const agoraMs = agora.getTime();
  if (fim < inicio || fim - inicio > SEGMENTO_MAXIMO_MS) return null;
  if (fim.getTime() > agoraMs + FUTURO_TOLERADO_MS || inicio.getTime() < agoraMs - PASSADO_ACEITO_MS) return null;
  return { bootId, seq: s.seq, inicio, fim };
}

// Resposta item a item (como o Proof-of-Play): `ok` (gravado ou já estava),
// `item_invalido` (o Player descarta — tentar de novo não muda nada),
// `ignorado` (tela de ponto fixo: nada a medir).
async function registrarSegmentos(tela, lista, agora = new Date()) {
  const movel = tela.ponto_tipo === 'movel';
  const resultados = [];
  for (const bruto of lista) {
    const chave = {
      bootId: typeof bruto?.bootId === 'string' ? bruto.bootId.slice(0, 64) : null,
      seq: Number.isInteger(bruto?.seq) ? bruto.seq : null,
    };
    const s = lerSegmento(bruto, agora);
    if (!s) {
      resultados.push({ ...chave, status: 'item_invalido' });
      continue;
    }
    if (!movel) {
      resultados.push({ ...chave, status: 'ignorado' });
      continue;
    }
    // O segmento aberto chega mais de uma vez, cada vez maior: estende,
    // nunca encolhe, e o total nunca passa do teto de um segmento.
    await pool.query(
      `INSERT INTO tela_operacao (dispositivo_id, origem, inicio, fim, boot_id, seq)
       VALUES ($1, 'player', $2, $3, $4, $5)
       ON CONFLICT (dispositivo_id, boot_id, seq) WHERE origem = 'player' DO UPDATE
         SET inicio = LEAST(tela_operacao.inicio, EXCLUDED.inicio),
             fim = GREATEST(tela_operacao.fim, EXCLUDED.fim),
             recebido_em = now()
         WHERE GREATEST(tela_operacao.fim, EXCLUDED.fim) - LEAST(tela_operacao.inicio, EXCLUDED.inicio)
               <= make_interval(secs => $6)`,
      [tela.id, s.inicio, s.fim, s.bootId, s.seq, SEGMENTO_MAXIMO_MS / 1000],
    );
    resultados.push({ ...chave, status: 'ok' });
  }
  return { resultados };
}

module.exports = {
  ESTADOS_EXIBINDO,
  TOLERANCIA_SEGUNDOS,
  SEGMENTO_MAXIMO_MS,
  TETO_LOTE,
  lerSegmento,
  registrarPeloHeartbeat,
  registrarSegmentos,
};
