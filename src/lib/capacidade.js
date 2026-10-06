// Régua ÚNICA de capacidade por ponto (rodada de integridade do admin,
// 23/09/2026). Antes, a Visão geral e a Mídia Mostraí mostravam o mesmo
// ponto com semânticas incompatíveis: uma dizia "77% comercial restante +
// 20% reserva", a outra "96,7% livre" — somando os dois saldos num só e
// sugerindo que a Mídia Mostraí podia ocupar 96,7% da hora. As duas telas
// agora leem daqui (via src/midias/repository.js#ocupacaoPorPonto).
//
// A regra (pedido do dono): até 80% da hora é capacidade COMERCIAL; 20% é
// reserva MOSTRAÍ/universal. Os dois saldos nunca se somam na leitura:
//   - comercial acima de 80% (só acontece com venda antiga, o bloqueio de
//     escolha nova é em 80%) come a reserva;
//   - Mostraí acima de 20% come capacidade comercial AINDA NÃO VENDIDA — não
//     é bloqueado (a trava de publicação continua sendo o total > 100%,
//     src/midias/routes.js), mas aparece como "acima da reserva".
// Comercial + Mostraí nunca passa de 100% na hora de publicar mídia própria.
// Desde 02/10/2026 (camada T3c, src/lib/pacing.js) a parte Mostraí é TETO, não
// reserva garantida: recuperação de atraso e saldo de hospedagem vêm antes dela.

const SEGUNDOS_DA_HORA = 3600;
// Mesmo 80% do bloqueio de escolha nova (G.7) — src/pontos/repository.js lê
// este valor daqui, pra régua e bloqueio nunca divergirem.
const LIMITE_COMERCIAL = 0.8;
const RESERVA_MOSTRAI = 0.2;

// Uma casa decimal, igual nas duas telas.
const pct = (segundos) => Math.round((segundos / SEGUNDOS_DA_HORA) * 1000) / 10;

function quebraCapacidade(segundosComercial, segundosMostrai) {
  const comercial = Math.max(0, Number(segundosComercial) || 0);
  const mostrai = Math.max(0, Number(segundosMostrai) || 0);
  const tetoComercial = LIMITE_COMERCIAL * SEGUNDOS_DA_HORA;
  const reserva = RESERVA_MOSTRAI * SEGUNDOS_DA_HORA;
  const comercialAcimaDoTeto = Math.max(0, comercial - tetoComercial);
  const mostraiAcimaDaReserva = Math.max(0, mostrai - reserva);
  return {
    comercialPct: pct(comercial),
    comercialRestantePct: pct(Math.max(0, tetoComercial - comercial - mostraiAcimaDaReserva)),
    mostraiPct: pct(mostrai),
    reservaRestantePct: pct(Math.max(0, reserva - mostrai - comercialAcimaDoTeto)),
    mostraiAcimaDaReservaPct: pct(mostraiAcimaDaReserva),
    totalPct: pct(comercial + mostrai),
    excede: comercial + mostrai > SEGUNDOS_DA_HORA,
  };
}

// Por quantas TELAS a parte COMERCIAL de um ponto se divide na hora (estação
// Rede/Admin V2, 06/10/2026): 1 no ponto fixo; na REDE MÓVEL, uma por tela
// ativa cadastrada (no mínimo 1) — o gerador divide a cota de cada conta na
// rede entre as telas do pool (src/playlist/gerador.js#parcelaDaTela). A régua
// é por tela: comercial ÷ telas contra a hora de UMA tela. A Mídia Mostraí não
// se divide (cada tela toca a sua). Fonte única para o bloqueio de escolha
// (src/pontos/repository.js), a régua de capacidade (src/midias/repository.js)
// e a ocupação do card (src/anunciantes/routes.js) — nunca divergem.
const telasDaCapacidadeSql = (p) => `(CASE WHEN ${p}.tipo = 'movel'
      THEN GREATEST(1, (SELECT COUNT(*)::int FROM dispositivos d WHERE d.ponto_id = ${p}.id AND d.status = 'ativo'))
      ELSE 1 END)`;

module.exports = { SEGUNDOS_DA_HORA, LIMITE_COMERCIAL, RESERVA_MOSTRAI, quebraCapacidade, telasDaCapacidadeSql };
