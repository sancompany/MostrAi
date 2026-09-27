const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const { segundosDeObrigacao } = require('../lib/pacing');
const dispositivosRepo = require('../dispositivos/repository');
const { obrigacoesDaTela, minutosAbertosNaHora } = require('../playlist/gerador');

// HORA ABERTA SEM SINAL (Saldo de Veiculação, 27/09/2026 — invariante 10 de
// docs/specs/2026-09-27-saldo-de-veiculacao.md).
//
// A obrigação da hora nasce quando a TV pede a playlist (gerador.js grava a
// linha com `segundos_obrigacao`). A TV sem sinal não pede nada — e até aqui
// a hora simplesmente não existia: nem obrigação, nem entrega, nem saldo. A
// conta perdia a hora em silêncio. Isto fecha o buraco: para cada tela ativa,
// cada hora ABERTA do ponto em que ela NÃO pediu playlist ganha a linha da
// obrigação (programada 0 — nada foi servido), marcada `obrigacao_sem_pedido`.
//
// Quem deve: as contas que cobrem a tela HOJE (mesma elegibilidade e
// cobertura do gerador, `obrigacoesDaTela`), com o plano válido naquela hora,
// e que já tinham sido servidas NESTA tela antes da hora (primeira hora
// servida de verdade aqui ≤ a hora). A trava é por tela de propósito: conta
// que chegou a este ponto depois da hora sem sinal (mudou de ponto) não deve
// nada dela — senão a mesma hora seria cobrada aqui e no ponto de antes. A
// tela só deve depois de instalada (`provisionado_em`).
//
// limite: a cobertura conferida é a de HOJE, não a da hora — conta que saiu
// deste ponto depois da hora sem sinal perde essa hora (erro a favor da
// Mostraí, nunca dívida inventada). Roda todo dia (Conciliacao, janela das
// últimas 48 h) pra essa diferença ser de horas; a apuração mensal roda de
// novo sobre o mês inteiro só como rede de segurança. Guardar a cobertura de
// cada hora é o caminho se a aproximação um dia pesar.
//
// Idempotente: ON CONFLICT DO NOTHING na chave (conta, tela, hora) — e hora
// que a tela pediu (linha em playlist_hora_congelada) nunca é tocada.
const HORA = 3_600_000;
const inicioDaHora = (d) => new Date(Math.floor(new Date(d).getTime() / HORA) * HORA);

async function registrarHorasSemPedido({ de, ate, apenasContas = null, apenasTelas = null }) {
  const limiteFim = inicioDaHora(ate).getTime();
  const telas = await dispositivosRepo.listarAtivasComPonto({ apenasTelas });
  let horas = 0;
  for (const tela of telas) {
    if (!tela.provisionado_em) continue;
    const inicio = Math.max(
      Math.ceil(new Date(de).getTime() / HORA) * HORA,
      inicioDaHora(tela.provisionado_em).getTime(),
    );
    if (inicio >= limiteFim) continue;
    const { rows: pedidas } = await pool.query(
      `SELECT janela_hora FROM playlist_hora_congelada
        WHERE dispositivo_id = $1 AND janela_hora >= $2 AND janela_hora < $3`,
      [tela.id, new Date(inicio), new Date(limiteFim)],
    );
    const servidas = new Set(pedidas.map((r) => new Date(r.janela_hora).getTime()));
    const semSinal = [];
    for (let h = inicio; h < limiteFim; h += HORA) {
      if (servidas.has(h)) continue;
      const minutos = minutosAbertosNaHora(tela, new Date(h), new Date(h + HORA));
      if (minutos > 0) semSinal.push({ hora: new Date(h), minutos });
    }
    if (!semSinal.length) continue;

    const contas = (await obrigacoesDaTela(tela)).filter((c) => !apenasContas || apenasContas.includes(c.anuncianteId));
    if (!contas.length) continue;
    const { rows: comeco } = await pool.query(
      `SELECT anunciante_id, MIN(janela_hora) AS primeira FROM exibicoes_contador
        WHERE anunciante_id = ANY($1) AND dispositivo_id = $2 AND NOT obrigacao_sem_pedido
        GROUP BY anunciante_id`,
      [contas.map((c) => c.anuncianteId), tela.id],
    );
    const primeira = new Map(comeco.map((r) => [r.anunciante_id, new Date(r.primeira).getTime()]));

    const linhas = { conta: [], hora: [], segundos: [], duracao: [], minutos: [] };
    for (const { hora, minutos } of semSinal) {
      for (const c of contas) {
        if (!primeira.has(c.anuncianteId) || primeira.get(c.anuncianteId) > hora.getTime()) continue;
        if (!vigencia.coberturaVigente(c.dataExpiracao, hora)) continue;
        const segundos = segundosDeObrigacao({ ...c.obrigacaoHoraCheia, minutosAbertos: minutos });
        if (segundos <= 0) continue;
        linhas.conta.push(c.anuncianteId);
        linhas.hora.push(hora);
        linhas.segundos.push(segundos);
        linhas.duracao.push(c.duracaoSegundos);
        linhas.minutos.push(minutos);
      }
    }
    if (!linhas.conta.length) continue;
    const { rowCount } = await pool.query(
      `INSERT INTO exibicoes_contador
         (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas, vezes_banco,
          segundos_obrigacao, duracao_segundos, minutos_abertos, obrigacao_sem_pedido)
       SELECT conta, $1, hora, 0, 0, 0, segundos, duracao, minutos, true
         FROM unnest($2::int[], $3::timestamptz[], $4::int[], $5::int[], $6::smallint[])
              AS t(conta, hora, segundos, duracao, minutos)
       ON CONFLICT (anunciante_id, dispositivo_id, janela_hora) DO NOTHING`,
      [tela.id, linhas.conta, linhas.hora, linhas.segundos, linhas.duracao, linhas.minutos],
    );
    horas += rowCount;
  }
  return { horas };
}

module.exports = { registrarHorasSemPedido };
