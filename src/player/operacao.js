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
//     exibindo e veio dentro da tolerância (o Player bate a cada 15 s; a
//     tolerância é a mesma do "sem sinal", 2 min — src/lib/heartbeat.js).
//     Um buraco maior fecha o intervalo e a próxima batida abre outro —
//     sinal perdido não vira tempo. É o piso para o APK atual; o Player novo manda também os
//     segmentos dele (online e offline), e a união não conta duas vezes;
//   · segmentos do Player (offline): o Player conta o que exibiu sem
//     internet com o relógio MONOTÔNICO do aparelho (imune a acerto de
//     relógio), ancorado no `servidorAgora` que recebeu do servidor no
//     mesmo boot, e manda quando volta. Idempotente por (tela, boot, seq):
//     reenvio, retry e duplicata gravam uma vez; um segmento que cresceu
//     (o Player reenvia o aberto) só estende.
// Só tela ATIVA de REDE MÓVEL grava aqui — ponto fixo não tem hospedagem, e
// tela em reparo ou inativa no cadastro não está operando para a Mostraí
// (mesmo que o aparelho siga ligado). A hospedagem soma pela TELA
// (`dispositivo_id`, migration 115); o intervalo guarda também a rede.

const ESTADOS_EXIBINDO = new Set(['PLAYING', 'IDLE']);
// Enquanto a tela está "conectada" (src/lib/heartbeat.js: 8 batidas de 15 s),
// o intervalo segue; com ela "sem comunicação", fecha. Era 390 s quando se
// achava que o APK batia a cada 5 min — com batidas de 15 s, isso contava
// até 6,5 min de silêncio como operação.
const TOLERANCIA_SEGUNDOS = require('../lib/heartbeat').TOLERANCIA_SEM_SINAL_MS / 1000;
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
  if (!ESTADOS_EXIBINDO.has(estado) || tela.status !== 'ativo' || !tela.ponto_id) return false;
  const { rowCount } = !ESTADOS_EXIBINDO.has(tela.player_estado)
    ? { rowCount: 0 }
    : await client.query(
        // Mudança do Admin no estado da tela depois da última batida (ex.:
        // reparo e volta a ativa dentro da tolerância) fecha o intervalo:
        // o tempo marcado como não operacional nunca entra na ponte.
        `UPDATE tela_operacao o SET fim = now()
      WHERE o.id = (SELECT id FROM tela_operacao
                   WHERE dispositivo_id = $1 AND ponto_id = $3 AND origem = 'heartbeat'
                     AND fim >= now() - make_interval(secs => $2) AND fim <= now()
                   ORDER BY fim DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM tela_eventos e
                         WHERE e.dispositivo_id = $1 AND e.tipo = 'ADMIN_STATE_CHANGED' AND e.ocorrido_em >= o.fim)`,
        [tela.id, TOLERANCIA_SEGUNDOS, tela.ponto_id],
      );
  if (rowCount) return true;
  const { rowCount: novo } = await client.query(
    `INSERT INTO tela_operacao (dispositivo_id, ponto_id, origem, inicio, fim)
     SELECT $1, $2, 'heartbeat', now(), now()
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

// Os trechos em que a tela estava ATIVA no cadastro, pela trilha de
// mudanças de estado do Admin (tela_eventos ADMIN_STATE_CHANGED). O
// segmento offline chega DEPOIS — às vezes com a tela já Inativa (o Admin
// achou que quebrou e trocou) —, então vale o estado de QUANDO foi exibido,
// não o de agora; e o exibido em reparo não conta mesmo que chegue depois
// de reativada.
async function trechosAtivos(tela) {
  // Só o que importa para segmentos aceitos (até PASSADO_ACEITO): as
  // mudanças da janela e a última antes dela (o estado em que a janela abre).
  const { rows } = await pool.query(
    `SELECT de, para, ocorrido_em FROM (
       (SELECT id, detalhe->>'de' AS de, detalhe->>'para' AS para, ocorrido_em FROM tela_eventos
         WHERE dispositivo_id = $1 AND tipo = 'ADMIN_STATE_CHANGED' AND ocorrido_em < $2
         ORDER BY ocorrido_em DESC, id DESC LIMIT 1)
       UNION ALL
       (SELECT id, detalhe->>'de', detalhe->>'para', ocorrido_em FROM tela_eventos
         WHERE dispositivo_id = $1 AND tipo = 'ADMIN_STATE_CHANGED' AND ocorrido_em >= $2)
     ) e ORDER BY ocorrido_em, id`,
    [tela.id, new Date(Date.now() - PASSADO_ACEITO_MS - 60_000)],
  );
  const trechos = [];
  let estado = rows.length ? rows[0].de : tela.status;
  let desde = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    const t = new Date(r.ocorrido_em).getTime();
    if (estado === 'ativo') trechos.push([desde, t]);
    estado = r.para;
    desde = t;
  }
  if (estado === 'ativo') trechos.push([desde, Number.POSITIVE_INFINITY]);
  return trechos;
}

// O pedaço do segmento dentro do PRIMEIRO trecho ativo que ele toca. Tem
// que ser o primeiro: o segmento aberto chega de novo cada vez maior, e o
// primeiro trecho que ele toca não muda (trechos novos só nascem depois de
// agora) — com "o maior", a mesclagem LEAST/GREATEST do reenvio uniria dois
// trechos por cima do período inativo (revisão, ciclo 2). limite: o que vem
// depois de um reparo no meio de um mesmo segmento (até 6 h) não conta.
// null = nada ativo.
function recortar(s, trechos) {
  for (const [de, ate] of trechos) {
    const inicio = Math.max(s.inicio.getTime(), de);
    const fim = Math.min(s.fim.getTime(), ate);
    if (fim > inicio || (fim === inicio && s.fim.getTime() === s.inicio.getTime() && de <= inicio && inicio < ate)) {
      return { ...s, inicio: new Date(inicio), fim: new Date(fim) };
    }
  }
  return null;
}

// Resposta item a item (como o Proof-of-Play): `ok` (gravado ou já estava),
// `item_invalido` (o Player descarta — tentar de novo não muda nada),
// `ignorado` (tela de ponto fixo: nada a medir). Segmento exibido inteiro
// com a tela fora do ar no cadastro responde `ok` sem gravar nada.
// Segmento que chega depois do encerramento da hospedagem ainda soma — o
// job de apuração tardia (src/pontos/hospedagem.js#apurarTardias) apura de
// novo. O ponto é o da tela (a tela não muda de ponto: `ponto_id` não é
// editável).
async function registrarSegmentos(tela, lista, agora = new Date()) {
  const movel = tela.ponto_tipo === 'movel' && Boolean(tela.ponto_id);
  const trechos = movel ? await trechosAtivos(tela) : [];
  const resultados = [];
  for (const bruto of lista) {
    const chave = {
      bootId: typeof bruto?.bootId === 'string' ? bruto.bootId.slice(0, 64) : null,
      seq: Number.isInteger(bruto?.seq) ? bruto.seq : null,
    };
    const lido = lerSegmento(bruto, agora);
    if (!lido) {
      resultados.push({ ...chave, status: 'item_invalido' });
      continue;
    }
    if (!movel) {
      resultados.push({ ...chave, status: 'ignorado' });
      continue;
    }
    // Exibido inteiro com a tela fora do ar no cadastro: nada a gravar, mas
    // `ok` (não `ignorado`): o segmento ainda aberto volta maior e pode
    // entrar num trecho ativo se a tela for reativada (revisão, ciclo 2).
    const s = recortar(lido, trechos);
    if (!s) {
      resultados.push({ ...chave, status: 'ok' });
      continue;
    }
    // O segmento aberto chega mais de uma vez, cada vez maior: estende,
    // nunca encolhe, e o total nunca passa do teto de um segmento.
    await pool.query(
      `INSERT INTO tela_operacao (dispositivo_id, ponto_id, origem, inicio, fim, boot_id, seq)
       VALUES ($1, $7, 'player', $2, $3, $4, $5)
       ON CONFLICT (dispositivo_id, boot_id, seq) WHERE origem = 'player' DO UPDATE
         SET inicio = LEAST(tela_operacao.inicio, EXCLUDED.inicio),
             fim = GREATEST(tela_operacao.fim, EXCLUDED.fim),
             recebido_em = now()
         WHERE GREATEST(tela_operacao.fim, EXCLUDED.fim) - LEAST(tela_operacao.inicio, EXCLUDED.inicio)
               <= make_interval(secs => $6)`,
      [tela.id, s.inicio, s.fim, s.bootId, s.seq, SEGMENTO_MAXIMO_MS / 1000, tela.ponto_id],
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
