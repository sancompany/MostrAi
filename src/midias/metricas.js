const pool = require('../db/pool');
const { operacaoDoPonto, minutosOperando } = require('../lib/operacao-tela');
const { situacaoDerivada } = require('./repository');

// Métricas da Mídia Mostraí (estação de distribuição, 27/09/2026): quantas
// vezes cada peça TOCOU de verdade — só proof-of-play confirmado
// (`midias_exibicoes_contador.vezes_confirmadas`, creditado em
// src/playlist/gerador.js#creditarMidia). Playlist gerada, download ou
// frequência configurada nunca contam como exibição.
//
// PROGRAMADAS: o que as playlists servidas prometeram (gravado pelo gerador
// só em hora com o ponto aberto).
// ESPERADAS: o que a configuração pede, e não frequência × 24 —
//   frequência/hora × horas em que CADA tela da cobertura deveria estar
//   exibindo: ponto aberto (horário do ponto, mesma régua do Player),
//   dentro do período (início/fim), só enquanto a mídia estava ativa
//   (histórico de pausa em `midias_proprias_situacoes`), só depois da tela
//   dar o primeiro sinal, e só em ponto em operação.
// limite: tela, ponto e cobertura entram como estão AGORA (não existe
// histórico deles); frequência também — mudar a frequência reescreve o
// esperado do passado. Tela trocada de ponto ou ponto que saiu de operação
// somem do esperado inteiro.
//
// ENTREGA = confirmadas ÷ esperadas no mesmo período, até 10 min atrás (o
// prazo do comprovante chegar — src/anunciantes/entrada-no-ar.js).
const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;
const MARGEM_COMPROVANTE_MS = 10 * 60_000;
const JANELAS = { hoje: null, d7: 7 * DIA_MS, d30: 30 * DIA_MS };

const ESTADOS = {
  AGUARDANDO: 'ATIVA_AGUARDANDO_PRIMEIRA_EXIBICAO',
  NORMAL: 'ATIVA_REPRODUZINDO',
  ATRASADA: 'ATIVA_ENTREGA_ATRASADA',
  PAUSADA: 'PAUSADA',
  AGENDADA: 'AGENDADA',
  ENCERRADA: 'ENCERRADA',
};

// Meia-noite de hoje em Matão (o "hoje" do painel é o dia de lá).
function inicioDoDiaSP(agora) {
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
  // America/Sao_Paulo é UTC-3 fixo desde 2019 (sem horário de verão).
  return new Date(`${dia}T00:00:00-03:00`);
}

// Minutos abertos por ponto, com cache por hora cheia: a mesma hora de um
// ponto serve a todas as mídias e a todas as telas dele.
function criarRelogio(pontos) {
  const operacoes = new Map(pontos.map((p) => [p.id, operacaoDoPonto(p.horario_semanal)]));
  const cache = new Map();
  const daHora = (pontoId, hora) => {
    const chave = `${pontoId}|${hora}`;
    if (!cache.has(chave)) {
      cache.set(chave, minutosOperando(operacoes.get(pontoId), new Date(hora), new Date(hora + HORA_MS)));
    }
    return cache.get(chave);
  };
  // Minutos abertos em [de, ate): horas inteiras pelo cache, bordas na hora.
  return function minutosAbertos(pontoId, de, ate) {
    let total = 0;
    let t = de;
    while (t < ate) {
      const hora = Math.floor(t / HORA_MS) * HORA_MS;
      const fimHora = hora + HORA_MS;
      if (t === hora && ate >= fimHora) total += daHora(pontoId, hora);
      else total += minutosOperando(operacoes.get(pontoId), new Date(t), new Date(Math.min(ate, fimHora)));
      t = fimHora;
    }
    return total;
  };
}

// Intervalos [de, ate) em que a mídia estava ATIVA e dentro do período.
function intervalosAtivos(midia, historico, agoraMs) {
  const linhas = historico.length ? historico : [{ situacao: midia.situacao, desde: midia.created_at }];
  const inicioPeriodo = midia.periodo_inicio ? new Date(midia.periodo_inicio).getTime() : -Infinity;
  const fimPeriodo = midia.periodo_fim ? new Date(midia.periodo_fim).getTime() : Infinity;
  const intervalos = [];
  linhas.forEach((l, i) => {
    if (l.situacao !== 'ativa') return;
    const de = Math.max(new Date(l.desde).getTime(), inicioPeriodo);
    const proxima = linhas[i + 1] ? new Date(linhas[i + 1].desde).getTime() : agoraMs;
    const ate = Math.min(proxima, fimPeriodo, agoraMs);
    if (ate > de) intervalos.push([de, ate]);
  });
  return intervalos;
}

function esperadasNoPeriodo({ midia, intervalos, telas, minutosAbertos, de, ate }) {
  const freq = Number(midia.frequencia_hora) || 0;
  if (!freq) return { total: 0, porTela: new Map() };
  const porTela = new Map();
  let total = 0;
  for (const tela of telas) {
    const desdeTela = tela.desde ? new Date(tela.desde).getTime() : null;
    if (desdeTela == null) continue;
    let minutos = 0;
    for (const [a, b] of intervalos) {
      const ini = Math.max(a, de, desdeTela);
      const fim = Math.min(b, ate);
      if (fim > ini) minutos += minutosAbertos(tela.ponto_id, ini, fim);
    }
    const esperadas = (freq * minutos) / 60;
    porTela.set(tela.id, esperadas);
    total += esperadas;
  }
  return { total, porTela };
}

const pct = (confirmadas, esperadas) =>
  esperadas >= 1 ? Math.min(100, Math.round((confirmadas / esperadas) * 100)) : null;
const arred = (n) => Math.round(n * 10) / 10;

// Estado da mídia ativa: aguardando a primeira exibição (e até quando),
// reproduzindo normalmente, ou entrega atrasada (a última hora aberta que
// já deveria ter comprovante não tem nenhum).
function estadoDaAtiva({ midia, intervalos, telas, minutosAbertos, porHora, ultimaMs, agoraMs }) {
  const atual = intervalos.at(-1);
  const inicioAtivo = atual ? atual[0] : agoraMs;
  const prazoFechado = agoraMs - MARGEM_COMPROVANTE_MS;
  const abertaNaHora = (hora) => telas.some((t) => minutosAbertos(t.ponto_id, hora, hora + HORA_MS) >= 60);

  if (midia.aprovacao_status !== 'aprovado' || !midia.arquivo_normalizado_url) {
    return { estado: ESTADOS.AGUARDANDO, motivo: 'arquivo_nao_aprovado', prazoPrimeiraExibicao: null };
  }
  if (!telas.length)
    return { estado: ESTADOS.AGUARDANDO, motivo: 'sem_tela_na_cobertura', prazoPrimeiraExibicao: null };

  if (!ultimaMs || ultimaMs < inicioAtivo) {
    // Primeira hora cheia aberta depois de ativar; prazo = fim dela + 10 min.
    let hora = Math.ceil(inicioAtivo / HORA_MS) * HORA_MS;
    for (let i = 0; i < 8 * 24 && !abertaNaHora(hora); i++) hora += HORA_MS;
    const prazo = hora + HORA_MS + MARGEM_COMPROVANTE_MS;
    return {
      estado: agoraMs > prazo ? ESTADOS.ATRASADA : ESTADOS.AGUARDANDO,
      motivo: null,
      primeiraJanelaPrevista: new Date(hora).toISOString(),
      prazoPrimeiraExibicao: new Date(prazo).toISOString(),
    };
  }
  // Última hora cheia aberta já fechada (+10 min) desde a ativação.
  let hora = Math.floor((prazoFechado - HORA_MS) / HORA_MS) * HORA_MS;
  for (let i = 0; i < 8 * 24 && hora >= inicioAtivo; i++, hora -= HORA_MS) {
    if (!abertaNaHora(hora)) continue;
    return { estado: (porHora.get(hora) || 0) > 0 ? ESTADOS.NORMAL : ESTADOS.ATRASADA, motivo: null };
  }
  return { estado: ESTADOS.NORMAL, motivo: null };
}

// `midias`: linhas de repository.listar/buscarPorId. Devolve Map(id → métricas).
async function metricasDasMidias(midias, { agora = new Date(), detalhe = false, db = pool } = {}) {
  const resultado = new Map();
  if (!midias.length) return resultado;
  const ids = midias.map((m) => m.id);
  const agoraMs = new Date(agora).getTime();
  const ateMs = agoraMs - MARGEM_COMPROVANTE_MS;
  const inicioHoje = inicioDoDiaSP(agora).getTime();
  const desde = { hoje: inicioHoje, d7: agoraMs - JANELAS.d7, d30: agoraMs - JANELAS.d30 };

  const [{ rows: somas }, { rows: historico }, { rows: telasRede }, { rows: coberturas }, { rows: porHoraRows }] =
    await Promise.all([
      db.query(
        `SELECT midia_id, dispositivo_id, ponto_id,
                SUM(vezes_confirmadas)::int AS confirmadas_total,
                SUM(vezes_programadas)::int AS programadas_total,
                COALESCE(SUM(vezes_confirmadas) FILTER (WHERE janela_hora >= $2), 0)::int AS confirmadas_hoje,
                COALESCE(SUM(vezes_programadas) FILTER (WHERE janela_hora >= $2), 0)::int AS programadas_hoje,
                COALESCE(SUM(vezes_confirmadas) FILTER (WHERE janela_hora >= $3), 0)::int AS confirmadas_d7,
                COALESCE(SUM(vezes_programadas) FILTER (WHERE janela_hora >= $3), 0)::int AS programadas_d7,
                COALESCE(SUM(vezes_confirmadas) FILTER (WHERE janela_hora >= $4), 0)::int AS confirmadas_d30,
                COALESCE(SUM(vezes_programadas) FILTER (WHERE janela_hora >= $4), 0)::int AS programadas_d30,
                MIN(primeira_confirmacao_em) AS primeira, MAX(ultima_confirmacao_em) AS ultima
           FROM midias_exibicoes_contador
          WHERE midia_id = ANY($1::int[])
          GROUP BY midia_id, dispositivo_id, ponto_id`,
        [ids, new Date(desde.hoje), new Date(desde.d7), new Date(desde.d30)],
      ),
      db.query(
        `SELECT midia_id, situacao, desde FROM midias_proprias_situacoes
          WHERE midia_id = ANY($1::int[]) ORDER BY midia_id, desde, id`,
        [ids],
      ),
      // Só tela ativa, com primeiro sinal, em ponto em operação.
      db.query(
        `SELECT d.id, d.ponto_id, d.apelido, d.numero, p.nome AS ponto_nome, p.horario_semanal,
                COALESCE(d.primeiro_sinal_em, d.provisionado_em) AS desde
           FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
          WHERE d.status = 'ativo' AND p.status = 'em_operacao'
          ORDER BY p.nome, d.numero`,
      ),
      db.query('SELECT midia_id, ponto_id FROM midias_proprias_pontos WHERE midia_id = ANY($1::int[])', [ids]),
      // Confirmadas por hora nas últimas 8 dias (estado "atrasada").
      db.query(
        `SELECT midia_id, janela_hora, SUM(vezes_confirmadas)::int AS n
           FROM midias_exibicoes_contador
          WHERE midia_id = ANY($1::int[]) AND janela_hora >= $2
          GROUP BY midia_id, janela_hora`,
        [ids, new Date(agoraMs - 8 * DIA_MS)],
      ),
    ]);

  const pontos = [
    ...new Map(telasRede.map((t) => [t.ponto_id, { id: t.ponto_id, horario_semanal: t.horario_semanal }])).values(),
  ];
  const minutosAbertos = criarRelogio(pontos);

  for (const midia of midias) {
    const m = midia.id;
    const linhas = somas.filter((s) => s.midia_id === m);
    const soma = (campo) => linhas.reduce((t, s) => t + s[campo], 0);
    const hist = historico.filter((h) => h.midia_id === m);
    const intervalos = intervalosAtivos(midia, hist, agoraMs);
    const pontosDaMidia = new Set(coberturas.filter((c) => c.midia_id === m).map((c) => c.ponto_id));
    const telas = midia.cobertura_tipo === 'rede' ? telasRede : telasRede.filter((t) => pontosDaMidia.has(t.ponto_id));
    const elegivel = midia.aprovacao_status === 'aprovado' && !!midia.arquivo_normalizado_url;

    const esperadas = {};
    const porTelaD30 = new Map();
    for (const janela of Object.keys(JANELAS)) {
      const r = elegivel
        ? esperadasNoPeriodo({ midia, intervalos, telas, minutosAbertos, de: desde[janela], ate: ateMs })
        : { total: 0, porTela: new Map() };
      esperadas[janela] = r.total;
      if (janela === 'd30') for (const [id, v] of r.porTela) porTelaD30.set(id, v);
    }
    const confirmadas = {
      hoje: soma('confirmadas_hoje'),
      d7: soma('confirmadas_d7'),
      d30: soma('confirmadas_d30'),
      total: soma('confirmadas_total'),
    };
    const programadas = {
      hoje: soma('programadas_hoje'),
      d7: soma('programadas_d7'),
      d30: soma('programadas_d30'),
      total: soma('programadas_total'),
    };
    const primeiras = linhas.map((s) => s.primeira).filter(Boolean);
    const ultimas = linhas.map((s) => s.ultima).filter(Boolean);
    const primeira = primeiras.length ? new Date(Math.min(...primeiras.map((d) => new Date(d).getTime()))) : null;
    const ultima = ultimas.length ? new Date(Math.max(...ultimas.map((d) => new Date(d).getTime()))) : null;

    const situacao = situacaoDerivada(midia, agora);
    const estado =
      situacao === 'ativa'
        ? estadoDaAtiva({
            midia,
            intervalos,
            telas,
            minutosAbertos,
            porHora: new Map(
              porHoraRows.filter((r) => r.midia_id === m).map((r) => [new Date(r.janela_hora).getTime(), r.n]),
            ),
            ultimaMs: ultima?.getTime() || null,
            agoraMs,
          })
        : { estado: situacao.toUpperCase(), motivo: null };

    const metricas = {
      frequenciaHora: Number(midia.frequencia_hora),
      confirmadas,
      programadas,
      esperadas: { hoje: arred(esperadas.hoje), d7: arred(esperadas.d7), d30: arred(esperadas.d30) },
      entregaPct: {
        hoje: pct(confirmadas.hoje, esperadas.hoje),
        d7: pct(confirmadas.d7, esperadas.d7),
        d30: pct(confirmadas.d30, esperadas.d30),
      },
      primeiraExibicaoEm: primeira?.toISOString() || null,
      ultimaExibicaoEm: ultima?.toISOString() || null,
      ...estado,
    };

    if (detalhe) {
      const porTela = telas.map((t) => {
        const l = linhas.find((s) => s.dispositivo_id === t.id);
        return {
          dispositivoId: t.id,
          codigo: `M-${String(t.id).padStart(4, '0')}`,
          apelido: t.apelido,
          pontoId: t.ponto_id,
          pontoNome: t.ponto_nome,
          confirmadas30d: l?.confirmadas_d30 || 0,
          programadas30d: l?.programadas_d30 || 0,
          esperadas30d: arred(porTelaD30.get(t.id) || 0),
        };
      });
      // Tela que já tocou mas saiu da cobertura (ou do ar) continua na
      // conta do que tocou — sem esperado, que é só da cobertura de hoje.
      for (const l of linhas) {
        if (porTela.some((t) => t.dispositivoId === l.dispositivo_id) || !l.confirmadas_d30) continue;
        porTela.push({
          dispositivoId: l.dispositivo_id,
          codigo: `M-${String(l.dispositivo_id).padStart(4, '0')}`,
          apelido: null,
          pontoId: l.ponto_id,
          pontoNome: null,
          confirmadas30d: l.confirmadas_d30,
          programadas30d: l.programadas_d30,
          esperadas30d: 0,
        });
      }
      const porPonto = new Map();
      for (const t of porTela) {
        const p = porPonto.get(t.pontoId) || {
          pontoId: t.pontoId,
          pontoNome: t.pontoNome,
          confirmadas30d: 0,
          programadas30d: 0,
          esperadas30d: 0,
        };
        p.pontoNome ||= t.pontoNome;
        p.confirmadas30d += t.confirmadas30d;
        p.programadas30d += t.programadas30d;
        p.esperadas30d = arred(p.esperadas30d + t.esperadas30d);
        porPonto.set(t.pontoId, p);
      }
      metricas.porTela = porTela;
      metricas.porPonto = [...porPonto.values()];
    }
    resultado.set(m, metricas);
  }
  return resultado;
}

module.exports = { metricasDasMidias, ESTADOS, intervalosAtivos, inicioDoDiaSP };
