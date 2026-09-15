// Cálculo puro de frequência/compensação — sem acesso a banco, testável
// isolado (tests/pacing.test.js). Quem busca os dados e grava o resultado é
// src/playlist/gerador.js.

const LIMITE_SLOTS_PROGRAMADOS = 200; // trava de segurança (SPEC módulo 3, de 240 slots/hora)

function embaralhar(lista) {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

// anunciantes: [{ id, frequenciaBase, deficit }] → lista de ids repetidos
// representando a playlist da hora (já embaralhada e com o teto aplicado)
function calcularPlaylist(anunciantes) {
  const pedidos = embaralhar(anunciantes.map((a) => ({
    id: a.id,
    quer: Math.max(0, (a.frequenciaBase || 0) + (a.deficit || 0)),
  })));
  const total = pedidos.reduce((soma, p) => soma + p.quer, 0);

  // O teto era aplicado com um `slice` na lista já sorteada: quem ficasse pra
  // depois do item 200 simplesmente perdia as exibições daquela hora, e quem
  // perdia era sorteio. Com a rede cheia, um anunciante podia terminar a hora
  // com muito menos que a frequência que contratou enquanto outro ficava com
  // tudo — e nada em lugar nenhum dizia que isso tinha acontecido.
  //
  // Agora o corte é proporcional: cada um perde a mesma fração do que pediu.
  // O que sobra da divisão vai para os maiores restos (regra dos maiores
  // restos), e a lista já vem embaralhada, então empate não favorece sempre o
  // mesmo. `cortou` sai junto pra quem chama poder registrar o aperto.
  const cortou = total > LIMITE_SLOTS_PROGRAMADOS;
  if (cortou) {
    const fator = LIMITE_SLOTS_PROGRAMADOS / total;
    for (const p of pedidos) {
      const exato = p.quer * fator;
      p.cabe = Math.floor(exato);
      p.resto = exato - p.cabe;
    }
    let sobra = LIMITE_SLOTS_PROGRAMADOS - pedidos.reduce((soma, p) => soma + p.cabe, 0);
    const porResto = [...pedidos].sort((x, y) => y.resto - x.resto);
    for (let i = 0; i < porResto.length && sobra > 0; i++, sobra--) porResto[i].cabe += 1;
  } else {
    for (const p of pedidos) p.cabe = p.quer;
  }

  const itens = [];
  for (const p of pedidos) {
    for (let i = 0; i < p.cabe; i++) itens.push(p.id);
  }
  return embaralhar(itens);
}

// Quanto do que foi pedido cabe no teto da hora. Quem chama usa pra saber que
// a hora apertou — o corte proporcional e justo, mas continua sendo entrega
// menor do que a contratada, e isso precisa aparecer em algum lugar.
function pedidoDaHora(anunciantes) {
  const pedido = anunciantes.reduce((soma, a) => soma + Math.max(0, (a.frequenciaBase || 0) + (a.deficit || 0)), 0);
  return { pedido, cabe: Math.min(pedido, LIMITE_SLOTS_PROGRAMADOS), cortou: pedido > LIMITE_SLOTS_PROGRAMADOS };
}

function contarPorAnunciante(itens) {
  const contagem = {};
  for (const id of itens) contagem[id] = (contagem[id] || 0) + 1;
  return contagem;
}

// Cota de autoanúncio é do PONTO e é dividida entre as telas ativas dele
// (migration 019). Cota 6 com 2 telas = 3 por tela; com 4 telas = 2 (arredonda
// pra cima, pra o dono nunca ficar com zero por causa de divisão).
function dividirCota(cotaDoPonto, telasAtivas) {
  const cota = Math.max(0, Number(cotaDoPonto) || 0);
  const telas = Math.max(1, Number(telasAtivas) || 1);
  return cota === 0 ? 0 : Math.ceil(cota / telas);
}

module.exports = { calcularPlaylist, contarPorAnunciante, dividirCota, pedidoDaHora, LIMITE_SLOTS_PROGRAMADOS };
