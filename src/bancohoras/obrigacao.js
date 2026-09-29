const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const { segundosDeObrigacao } = require('../lib/pacing');
const dispositivosRepo = require('../dispositivos/repository');
const { obrigacoesDaTela, minutosAbertosNaHora } = require('../playlist/gerador');
const basicoRepo = require('../pontos/basico');

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
// QUANDO RODA: minutos depois de a hora fechar (`iniciar`, no processo do
// servidor, a cada 10 min sobre as últimas 3 h) — plano, peça, suspensão e
// cobertura usados são os daquela hora, e a linha gravada não muda mais
// (ON CONFLICT DO NOTHING): trocar de plano, suspender ou tirar a peça
// depois não apaga nem reduz a obrigação que já existia (revisão Codex do
// PR #85). O diário (Conciliacao, 48 h) e a apuração mensal (o mês inteiro)
// são rede de segurança pra hora que o servidor passou fora do ar.
//
// limite: só nessa rede de segurança o estado usado é o de quando ela roda,
// não o da hora — não existe histórico com hora de troca de plano, suspensão
// ou remoção de peça. Guardar isso é o caminho se a rede de segurança um dia
// precisar cobrir janelas longas.
//
// Idempotente: ON CONFLICT DO NOTHING na chave (conta, tela, hora) — e hora
// que a tela pediu (linha em playlist_hora_congelada) nunca é tocada.
const HORA = 3_600_000;
const inicioDaHora = (d) => new Date(Math.floor(new Date(d).getTime() / HORA) * HORA);

// `soServidorForaDoAr` (finalização, 28/09/2026): é o modo da rede de
// segurança (conciliação diária, apuração mensal). Ela usa o estado de HOJE
// pra horas de dias atrás — tela que estava em reparo e voltou, plano que
// venceu e foi renovado ganhavam obrigação retroativa de horas em que não
// deviam nada, e isso virava saldo. Nesse modo só entram as horas em que
// NENHUMA tela da rede pediu playlist (servidor fora do ar): hora em que a
// rede funcionava já foi tratada pelo job de 10 min, com o estado daquela
// hora. limite: rede de uma tela só continua sem essa distinção.
async function registrarHorasSemPedido({
  de,
  ate,
  apenasContas = null,
  apenasTelas = null,
  soServidorForaDoAr = false,
}) {
  const limiteFim = inicioDaHora(ate).getTime();
  const telas = await dispositivosRepo.listarAtivasComPonto({ apenasTelas });
  let horas = 0;
  let redeNoAr = null;
  if (soServidorForaDoAr) {
    const { rows } = await pool.query(
      'SELECT DISTINCT janela_hora FROM playlist_hora_congelada WHERE janela_hora >= $1 AND janela_hora < $2',
      [new Date(Math.ceil(new Date(de).getTime() / HORA) * HORA), new Date(limiteFim)],
    );
    redeNoAr = new Set(rows.map((r) => new Date(r.janela_hora).getTime()));
  }
  for (const tela of telas) {
    if (!tela.provisionado_em) continue;
    const instalada = new Date(tela.provisionado_em).getTime();
    const inicio = Math.max(Math.ceil(new Date(de).getTime() / HORA) * HORA, inicioDaHora(instalada).getTime());
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
      if (redeNoAr?.has(h)) continue;
      // Na hora da instalação, só a partir do instante instalada (revisão
      // Codex do PR #85): antes disso a tela não existia pra dever nada.
      const minutos = minutosAbertosNaHora(tela, new Date(Math.max(h, instalada)), new Date(h + HORA));
      if (minutos > 0) semSinal.push({ hora: new Date(h), minutos });
    }
    if (!semSinal.length) continue;

    const contas = (await obrigacoesDaTela(tela, { desde: new Date(inicio) })).filter(
      (c) => !apenasContas || apenasContas.includes(c.anuncianteId),
    );
    if (!contas.length) continue;
    const { rows: comeco } = await pool.query(
      `SELECT anunciante_id, MIN(janela_hora) AS primeira FROM exibicoes_contador
        WHERE anunciante_id = ANY($1) AND dispositivo_id = $2 AND NOT obrigacao_sem_pedido
        GROUP BY anunciante_id`,
      [contas.map((c) => c.anuncianteId), tela.id],
    );
    const primeira = new Map(comeco.map((r) => [r.anunciante_id, new Date(r.primeira).getTime()]));

    const linhas = { conta: [], hora: [], segundos: [], duracao: [], minutos: [], basico: [] };
    for (const { hora, minutos } of semSinal) {
      for (const c of contas) {
        if (!primeira.has(c.anuncianteId) || primeira.get(c.anuncianteId) > hora.getTime()) continue;
        // Duas origens, uma linha (migration 103): o plano comercial vale
        // pela validade dele; o Básico do ponto, pelo início/fim da linha.
        const comercialValido = Boolean(c.obrigacaoHoraCheia) && vigencia.coberturaVigente(c.dataExpiracao, hora);
        const comercial = comercialValido
          ? segundosDeObrigacao({ ...c.obrigacaoHoraCheia, minutosAbertos: minutos })
          : 0;
        // A peça que a geração ao vivo teria usado nesta hora: com o
        // comercial valendo, a da conta; só com o Básico, a do Básico.
        const duracao = comercialValido ? c.duracaoSegundos : (c.duracaoBasico ?? c.duracaoSegundos);
        const basico = (c.basicos || [])
          .filter((b) => basicoRepo.valiaNaHora(b, hora))
          .reduce((t, b) => t + basicoRepo.segundosDoBasicoNaHora(b, duracao, hora, minutos, tela.telas_do_ponto), 0);
        const segundos = comercial + basico;
        if (segundos <= 0) continue;
        linhas.conta.push(c.anuncianteId);
        linhas.hora.push(hora);
        linhas.segundos.push(segundos);
        linhas.duracao.push(duracao);
        linhas.minutos.push(minutos);
        linhas.basico.push(basico || null);
      }
    }
    if (!linhas.conta.length) continue;
    const { rowCount } = await pool.query(
      `INSERT INTO exibicoes_contador
         (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas, vezes_banco,
          segundos_obrigacao, duracao_segundos, minutos_abertos, obrigacao_sem_pedido, segundos_obrigacao_basico)
       SELECT conta, $1, hora, 0, 0, 0, segundos, duracao, minutos, true, basico
         FROM unnest($2::int[], $3::timestamptz[], $4::int[], $5::int[], $6::smallint[], $7::int[])
              AS t(conta, hora, segundos, duracao, minutos, basico)
       ON CONFLICT (anunciante_id, dispositivo_id, janela_hora) DO NOTHING`,
      [tela.id, linhas.conta, linhas.hora, linhas.segundos, linhas.duracao, linhas.minutos, linhas.basico],
    );
    horas += rowCount;
  }
  return { horas };
}

// Registro contínuo, logo depois de cada hora fechar. Janela de 3 h: cobre
// um restart ou um atraso do timer sem perder hora. Duas instâncias rodando
// juntas só disputam o mesmo ON CONFLICT DO NOTHING.
const INTERVALO_MS = 10 * 60 * 1000;
const JANELA_MS = 3 * HORA;

// `filtros` ({ apenasContas, apenasTelas }): escopo de teste; produção não passa.
function registrarHorasRecemFechadas(agora = new Date(), filtros = {}) {
  return registrarHorasSemPedido({ ...filtros, de: new Date(agora.getTime() - JANELA_MS), ate: agora });
}

let timer = null;
function iniciar() {
  const rodar = () =>
    registrarHorasRecemFechadas().catch((err) => console.error('saldo de veiculação (hora sem sinal):', err.message));
  rodar();
  timer = setInterval(rodar, INTERVALO_MS);
  timer.unref();
}

module.exports = { registrarHorasSemPedido, registrarHorasRecemFechadas, iniciar };
