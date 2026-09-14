// Soma de fluxo dos pontos ativos, só aparece com 1.000+ pessoas somadas
// (ver GET /pontos/fluxo) — funciona como prova social pro funil de
// vendas, mas não expõe número de ponto isolado.
fetch(`${API_BASE_URL}/pontos/fluxo`).then((r) => r.json()).then(({ pessoasPorMes }) => {
  if (!pessoasPorMes) return;
  const el = document.getElementById('heroFluxo');
  el.innerHTML = `<b>${pessoasPorMes.toLocaleString('pt-BR')} pessoas</b> veem sua marca por mês nos pontos já instalados da Mostraí.`;
  el.hidden = false;
}).catch(() => {});
