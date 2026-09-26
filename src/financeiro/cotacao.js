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

// O que este pedido É pra esta conta — decidido aqui, não no navegador
// (consolidação final, 24/09/2026: o frontend não calcula regra):
//   'assinar' — sem plano pago vigente (sem plano, benefício/cortesia, ou
//               pago vencido): o pedido é uma assinatura nova (quem decide
//               como ela convive com benefício é o POST /assinar);
//   'trocar'  — plano pago vigente e o pedido é OUTRO plano;
//   'ja_tem'  — plano pago vigente e é o MESMO plano: nada a confirmar.
function acaoDoPedido(conta, plano) {
  const pagoVigente = !!conta.plano_id && !conta.plano_cortesia && vigencia.coberturaVigente(conta.data_expiracao);
  if (!pagoVigente) return 'assinar';
  return plano.id === conta.plano_id ? 'ja_tem' : 'trocar';
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

  return {
    planoId: plano.id,
    acao: acaoDoPedido(conta, plano),
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

module.exports = { cotarPlano, acaoDoPedido };
