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
  let itens = [];
  for (const a of anunciantes) {
    const repeticoes = a.frequenciaBase + (a.deficit || 0);
    for (let i = 0; i < repeticoes; i++) itens.push(a.id);
  }
  itens = embaralhar(itens);
  if (itens.length > LIMITE_SLOTS_PROGRAMADOS) itens = itens.slice(0, LIMITE_SLOTS_PROGRAMADOS);
  return itens;
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

module.exports = { calcularPlaylist, contarPorAnunciante, dividirCota, LIMITE_SLOTS_PROGRAMADOS };
