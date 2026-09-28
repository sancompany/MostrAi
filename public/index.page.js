// Preco da dobra: sai do PLANO, nunca de um numero escrito a mao. Antes era
// "R$ 99" fixo no HTML — trocar de plano no admin deixava a home mentindo, e
// ninguem ia lembrar de editar a home junto.
// Qual plano: o mensal (1 mes, sem compromisso) mais barato entre os ativos.
// E o primeiro degrau da grade, que e o que "a partir de" quer dizer.
fetch(`${API_BASE_URL}/planos`)
  .then((r) => r.json())
  .then((planos) => {
    pintarPrecoDaDobra(planos || []);
  })
  .catch(() => {});

function pintarPrecoDaDobra(planos) {
  const mensais = planos.filter((p) => p.ativo && Number(p.compromisso_meses) === 1);
  if (!mensais.length) return;
  const maisBarato = mensais.reduce((a, b) => (Number(a.valor_mensal) <= Number(b.valor_mensal) ? a : b));
  const el = document.getElementById('heroPreco');
  el.innerHTML = `<b>A partir de ${fmtBRL(maisBarato.valor_mensal)} por mês.</b> Sem agência, sem contrato complicado.`;
  el.hidden = false;
}

// Promoções da Home (Estação 3, 28/09/2026 — componente em promocao.js):
// arte e texto lado a lado no computador, arte em cima e texto embaixo no
// celular, nunca texto sobre a imagem. Toda promoção vigente e elegível pra
// quem vê (GET /promocoes/vigentes já filtra no servidor) marcada "mostrar na
// Home", na ordem do servidor; duas ou mais viram carrossel. Só entra o que
// a promoção de fato entrega (`promocoesParaExibir`: sem célula que outra
// promoção já ocupa, sem ciclo sem vantagem — D1). Sem nenhuma, a seção
// continua `hidden`.
fetch(`${API_BASE_URL}/promocoes/vigentes`)
  .then((r) => r.json())
  .then(async (promocoes) => {
    const daHome = window.promocoesParaExibir(promocoes, 'mostrar_home');
    const montou = await window.montarPromocoes(document.getElementById('promocaoHome'), daHome, {
      variante: 'home',
      id: 'promoHome',
    });
    if (montou) document.getElementById('promocaoHomeSecao').hidden = false;
  })
  .catch(() => {});

// Soma de fluxo dos pontos ativos, só aparece acima de zero (ver
// GET /pontos/fluxo) — funciona como prova social pro funil de vendas, mas
// não expõe número de ponto isolado.
fetch(`${API_BASE_URL}/pontos/fluxo`)
  .then((r) => r.json())
  .then(({ pessoasPorMes }) => {
    if (!pessoasPorMes) return;
    const el = document.getElementById('heroFluxo');
    // Sem "já instalados" (19/09/2026, pedido do dono) — não importa se o
    // ponto está no ar ou em instalação, só o total.
    el.innerHTML = `<b>${pessoasPorMes.toLocaleString('pt-BR')} pessoas</b> veem sua marca por mês nos pontos da Mostraí.`;
    el.hidden = false;
  })
  .catch(() => {});
