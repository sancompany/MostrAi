const pool = require('../db/pool');

// Sessões operacionais do Player (migration 113, docs/player-mvp-contract.md
// §8.1). A TV registra, offline, de quando o ciclo de exibição esteve rodando
// até quando parou — medido pelo relógio monotônico dela — e manda quando a
// comunicação volta. Aqui só se guarda o FATO; nada daqui vira cobrança,
// saldo ou benefício.
//
// Respostas por sessão (o Player tira da fila local as duas):
//   registrada  gravada agora, estendida ou já conhecida (reenvio idempotente)
//   invalida    nunca vai ser aceita (formato, duração incoerente) — o Player
//               não insiste nela para sempre.

const TETO_LOTE = 100;
// UUID do Player (e qualquer id curto e imprimível, como em /played).
const SESSAO_ID = /^[A-Za-z0-9._:-]{1,100}$/;
// Uma sessão sem reinício: a TV pode ficar meses ligada sem ninguém sair do
// Player. Mais que isso é dado corrompido, não operação.
const DURACAO_MAXIMA_MS = 400 * 24 * 3600 * 1000;
// `duracaoMs` é `fimUptimeMs - inicioUptimeMs` no Player; folga só para
// arredondamento.
const FOLGA_DURACAO_MS = 1000;
const MOTIVO = /^[a-z_]{1,40}$/;

const inteiro = (v) => Number.isSafeInteger(v);
const instante = (v) => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const instanteOuNulo = (v) => (v == null ? { ok: true, valor: null } : { ok: !!instante(v), valor: instante(v) });

// Sessão crua → linha, ou null se inválida.
function validar(s) {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return null;
  const { inicioUptimeMs, fimUptimeMs, duracaoMs, bootCount } = s;
  if (!inteiro(inicioUptimeMs) || !inteiro(fimUptimeMs) || !inteiro(duracaoMs)) return null;
  if (inicioUptimeMs < 0 || fimUptimeMs < inicioUptimeMs || duracaoMs < 0 || duracaoMs > DURACAO_MAXIMA_MS) return null;
  if (Math.abs(fimUptimeMs - inicioUptimeMs - duracaoMs) > FOLGA_DURACAO_MS) return null;
  if (bootCount != null && !(inteiro(bootCount) && bootCount >= 0 && bootCount <= 2_147_483_647)) return null;
  const inicioEm = instante(s.inicioEm);
  const fimEm = instante(s.fimEm);
  const inicioServidor = instanteOuNulo(s.inicioServidorEm);
  const fimServidor = instanteOuNulo(s.fimServidorEm);
  if (!inicioEm || !fimEm || !inicioServidor.ok || !fimServidor.ok) return null;
  if (typeof s.encerrada !== 'boolean') return null;
  if (s.motivo != null && !(typeof s.motivo === 'string' && MOTIVO.test(s.motivo))) return null;
  return {
    bootCount: bootCount ?? null,
    inicioUptimeMs,
    fimUptimeMs,
    duracaoMs,
    inicioEm,
    fimEm,
    inicioServidorEm: inicioServidor.valor,
    fimServidorEm: fimServidor.valor,
    encerrada: s.encerrada,
    motivo: s.encerrada ? (s.motivo ?? null) : null,
  };
}

// Só ESTENDE: o mesmo boot e o mesmo início, duração que não diminui, e
// sessão encerrada nunca reabre. Um reenvio velho (checkpoint anterior que
// chegou atrasado) não apaga o que já se sabia.
const UPSERT = `
  INSERT INTO sessoes_operacionais
    (dispositivo_id, sessao_id, boot_count, inicio_uptime_ms, fim_uptime_ms, duracao_ms,
     inicio_parede_em, fim_parede_em, inicio_servidor_em, fim_servidor_em, encerrada, motivo)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  ON CONFLICT (dispositivo_id, sessao_id) DO UPDATE SET
    fim_uptime_ms = EXCLUDED.fim_uptime_ms,
    duracao_ms = EXCLUDED.duracao_ms,
    fim_parede_em = EXCLUDED.fim_parede_em,
    fim_servidor_em = COALESCE(EXCLUDED.fim_servidor_em, sessoes_operacionais.fim_servidor_em),
    encerrada = EXCLUDED.encerrada,
    motivo = EXCLUDED.motivo,
    atualizada_em = now()
  WHERE NOT sessoes_operacionais.encerrada
    AND sessoes_operacionais.boot_count IS NOT DISTINCT FROM EXCLUDED.boot_count
    AND sessoes_operacionais.inicio_uptime_ms = EXCLUDED.inicio_uptime_ms
    AND EXCLUDED.duracao_ms >= sessoes_operacionais.duracao_ms`;

async function registrarLote(dispositivoId, sessoes) {
  const resultados = [];
  for (const bruta of sessoes) {
    const sessaoId =
      bruta && typeof bruta === 'object' && typeof bruta.sessaoId === 'string' ? bruta.sessaoId.trim() : '';
    // Sem id não há como responder (o Player casa a resposta por ele).
    if (!sessaoId) continue;
    const s = SESSAO_ID.test(sessaoId) ? validar(bruta) : null;
    if (!s) {
      resultados.push({ sessaoId: sessaoId.slice(0, 100), status: 'invalida' });
      continue;
    }
    await pool.query(UPSERT, [
      dispositivoId,
      sessaoId,
      s.bootCount,
      s.inicioUptimeMs,
      s.fimUptimeMs,
      s.duracaoMs,
      s.inicioEm,
      s.fimEm,
      s.inicioServidorEm,
      s.fimServidorEm,
      s.encerrada,
      s.motivo,
    ]);
    resultados.push({ sessaoId, status: 'registrada' });
  }
  return { resultados };
}

// Fim confiável de uma sessão, em SQL: o relógio do servidor projetado pela
// TV quando existe; senão, o de parede — nunca depois de quando o servidor a
// recebeu (uma TV com o relógio adiantado não "opera no futuro").
const FIM_SQL = (s) => `LEAST(COALESCE(${s}.fim_servidor_em, ${s}.fim_parede_em), ${s}.atualizada_em)`;

module.exports = { registrarLote, validar, TETO_LOTE, FIM_SQL };
