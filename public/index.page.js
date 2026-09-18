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

// Soma de fluxo dos pontos ativos, só aparece com 1.000+ pessoas somadas
// (ver GET /pontos/fluxo) — funciona como prova social pro funil de
// vendas, mas não expõe número de ponto isolado.
fetch(`${API_BASE_URL}/pontos/fluxo`)
  .then((r) => r.json())
  .then(({ pessoasPorMes }) => {
    if (!pessoasPorMes) return;
    const el = document.getElementById('heroFluxo');
    el.innerHTML = `<b>${pessoasPorMes.toLocaleString('pt-BR')} pessoas</b> veem sua marca por mês nos pontos já instalados da Mostraí.`;
    el.hidden = false;
  })
  .catch(() => {});
