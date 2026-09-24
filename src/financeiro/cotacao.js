// Cotação: quanto ESTA conta pagaria neste plano se assinasse agora.
//
// Existe pra que a tela de confirmação do pedido (confirmar-plano.page.js)
// mostre o número que a cobrança vai usar — e não uma segunda conta feita no
// navegador. Até 23/09/2026 a tela calculava sozinha com `valor_mensal` e
// divergia do `POST /assinar` em dois pontos: ignorava a promoção vigente
// (vitrine R$ 597,60, confirmação R$ 672,30, Checkout R$ 597,60) e nunca
// mostrou o crédito de comodato nem o desconto de parceiro, que o ADR-014
// manda somar por cima do preço de tabela.
//
// Por isso aqui não há regra de preço nenhuma: é a MESMA escolha de promoção
// do `POST /assinar` (`condicaoVigente` com o estado comercial da conta) e a
// MESMA função da cobrança (`valorMensalDaConta`), com a assinatura simulada
// do jeito que a adesão a grava. Mudou a regra, muda lá — e a cotação segue.
const promocoesRepo = require('./promocoes-repository');
const { valorMensalDaConta } = require('./san-checkout');
const { multiplicar } = require('../lib/dinheiro');

async function cotarPlano(conta, plano) {
  const estado = await promocoesRepo.estadoComercialDaConta(conta);
  const condicao = await promocoesRepo.condicaoVigente(plano.tier, plano.compromisso_meses, estado);
  // A adesão grava a promoção com validade no futuro; pra calcular AGORA
  // basta que ela esteja dentro do prazo.
  const simulada = condicao
    ? {
        promocao_valido_ate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        promocao_desconto_percentual: condicao.descontoPercentual,
      }
    : null;

  const meses = plano.compromisso_meses;
  const cheioMensal = Number(plano.valor_mensal_cheio ?? plano.valor_mensal);
  // Preço de TABELA (ciclo ou promoção, sem nenhum direito da conta): a mesma
  // função, com uma conta neutra — nem parceiro, nem dona de ponto.
  const tabelaMensal = valorMensalDaConta({ papeis: [] }, plano, simulada);
  // Só o parceiro (sem o crédito do comodato), pra dizer qual direito pesou.
  const comParceiroMensal = valorMensalDaConta({ ...conta, papeis: [] }, plano, simulada);
  const valorMensal = valorMensalDaConta(conta, plano, simulada);

  return {
    planoId: plano.id,
    meses,
    cheioMensal,
    tabelaMensal,
    valorMensal,
    cheioCiclo: multiplicar(cheioMensal, meses),
    tabelaCiclo: multiplicar(tabelaMensal, meses),
    valorCiclo: multiplicar(valorMensal, meses),
    descontoParceiro: comParceiroMensal < tabelaMensal,
    creditoComodato: valorMensal < comParceiroMensal,
    promocao: condicao
      ? {
          selo: condicao.promocao.selo || null,
          titulo: condicao.promocao.titulo_publico,
          descontoPercentual: Number(condicao.descontoPercentual),
          duracaoMeses: condicao.promocao.duracao_beneficio_meses,
        }
      : null,
  };
}

module.exports = { cotarPlano };
