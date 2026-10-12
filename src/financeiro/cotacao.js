// Cotação: quanto ESTA conta pagaria neste plano se assinasse agora.
//
// Existe pra que a tela de confirmação do pedido (confirmar-plano.page.js)
// mostre o número que a cobrança vai usar — e não uma segunda conta feita no
// navegador. Até 23/09/2026 a tela calculava sozinha com `valor_mensal` e
// divergia do `POST /assinar` em dois pontos: ignorava a promoção vigente
// (vitrine R$ 597,60, confirmação R$ 672,30, Checkout R$ 597,60) e nunca
// mostrou o desconto de parceiro, que o ADR-014 manda somar por cima do preço
// de tabela. (O crédito de comodato também somava; saiu em 24/09/2026 —
// ADR-016: ser ponto gera créditos, não desconto em reais.)
//
// Por isso aqui não há regra de preço nenhuma: é a MESMA escolha de promoção
// do `POST /assinar` (`condicaoVigente` com o estado comercial da conta) e a
// MESMA função da cobrança (`valorMensalDaConta`), com a assinatura simulada
// do jeito que a adesão a grava. Mudou a regra, muda lá — e a cotação segue.
const promocoesRepo = require('./promocoes-repository');
const { valorMensalDaConta } = require('./san-checkout');
const { multiplicar } = require('../lib/dinheiro');
const vigencia = require('../lib/vigencia');

// Troca de plano de quem paga no cartão (AUD-007, 11/10/2026): o Checkout
// recusa mudar o valor de assinatura de cartão já paga (409
// `troca_de_valor_nao_suportada`, API.md dele 5.6) — e toda assinatura da
// Mostraí é de cartão (Pix Automático não está habilitado). O caminho pelo
// site ainda é decisão do dono (docs/PENDENCIAS.md, PG6); hoje quem troca é a
// equipe. A MESMA resposta sai da cotação, do POST /assinar e do POST
// /trocar-plano, com um `codigo` estável pra tela — nunca o texto cru do
// Checkout, nem um "use Trocar de plano" que volta pro mesmo 409.
const TROCA_PELA_EQUIPE = Object.freeze({
  codigo: 'troca_de_plano_pela_equipe',
  erro: 'A troca de plano de quem paga no cartão é feita pela nossa equipe — fale com a gente pelo WhatsApp que a gente troca o seu plano. Nada foi cobrado nem alterado.',
});

// O que este pedido É pra esta conta — decidido aqui, não no navegador
// (consolidação final, 24/09/2026: o frontend não calcula regra):
//   'assinar'           — sem plano pago vigente (sem plano, benefício/
//                         cortesia, ou pago vencido): o pedido é uma
//                         assinatura nova (quem decide como ela convive com
//                         benefício é o POST /assinar);
//   'troca_pela_equipe' — plano pago vigente e o pedido é OUTRO plano: até
//                         11/10/2026 era 'trocar', e levava ao 409 do
//                         Checkout (acima);
//   'ja_tem'            — plano pago vigente e é o MESMO plano.
function acaoDoPedido(conta, plano) {
  const pagoVigente = !!conta.plano_id && !conta.plano_cortesia && vigencia.coberturaVigente(conta.data_expiracao);
  if (!pagoVigente) return 'assinar';
  return plano.id === conta.plano_id ? 'ja_tem' : 'troca_pela_equipe';
}

async function cotarPlano(conta, plano) {
  const estado = await promocoesRepo.estadoComercialDaConta(conta);
  const condicao = await promocoesRepo.condicaoVigente(plano.tier, plano.compromisso_meses, estado);
  // A assinatura que nasceria agora, com o desconto travado na adesão.
  const simulada = condicao ? { promocao_desconto_percentual: condicao.descontoPercentual } : null;

  const meses = plano.compromisso_meses;
  const cheioMensal = Number(plano.valor_mensal_cheio ?? plano.valor_mensal);
  // Preço de TABELA (ciclo ou promoção, sem nenhum direito da conta): a mesma
  // função, com uma conta neutra — nem parceiro, nem dona de ponto.
  const tabelaMensal = valorMensalDaConta({ papeis: [] }, plano, simulada);
  const valorMensal = valorMensalDaConta(conta, plano, simulada);

  const acao = acaoDoPedido(conta, plano);
  return {
    planoId: plano.id,
    acao,
    aviso: acao === 'troca_pela_equipe' ? TROCA_PELA_EQUIPE : null,
    meses,
    cheioMensal,
    tabelaMensal,
    valorMensal,
    cheioCiclo: multiplicar(cheioMensal, meses),
    tabelaCiclo: multiplicar(tabelaMensal, meses),
    valorCiclo: multiplicar(valorMensal, meses),
    descontoParceiro: valorMensal < tabelaMensal,
    promocao: condicao
      ? {
          selo: condicao.promocao.selo || null,
          titulo: condicao.promocao.titulo_publico,
          descontoPercentual: Number(condicao.descontoPercentual),
          // Mesmo preço do ciclo normal (ou pior): a tela não chama isso de
          // desconto promocional (D1, 24/09/2026 — promocoes-repository.js).
          temVantagem: promocoesRepo.temVantagem(condicao.descontoPercentual, plano),
        }
      : null,
  };
}

module.exports = { cotarPlano, acaoDoPedido, TROCA_PELA_EQUIPE };
