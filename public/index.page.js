// Preco da dobra: sai do PLANO, nunca de um numero escrito a mao. Antes era
// "R$ 99" fixo no HTML — trocar de plano no admin deixava a home mentindo, e
// ninguem ia lembrar de editar a home junto.
// Qual plano: o mensal (1 mes, sem compromisso) mais barato entre os ativos.
// E o primeiro degrau da grade, que e o que "a partir de" quer dizer.
fetch(`${API_BASE_URL}/planos`)
  .then((r) => r.json())
  .then((planos) => {
    const mensais = (planos || []).filter((p) => p.ativo && Number(p.compromisso_meses) === 1);
    if (!mensais.length) return;
    const maisBarato = mensais.reduce((a, b) => (Number(a.valor_mensal) <= Number(b.valor_mensal) ? a : b));
    const el = document.getElementById('heroPreco');
    el.innerHTML = `<b>A partir de ${fmtBRL(maisBarato.valor_mensal)} por mês.</b> Sem agência, sem contrato complicado.`;
    el.hidden = false;
  })
  .catch(() => {});

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

// O valor da ajuda de custo é editável no admin (planos_ponto) e estava
// escrito à mão aqui: bastava o dono mudar de R$ 50 pra R$ 60 no painel e a
// home passaria a prometer um número que não existe mais. Sai da mesma rota
// que a página do ponto e a tela do convite usam.
fetch(`${API_BASE_URL}/planos-ponto`)
  .then((r) => r.json())
  .then((opcoes) => {
    const alvo = document.querySelector('[data-ajuda-custo]');
    if (!alvo || !Array.isArray(opcoes)) return;
    const comAjuda = opcoes.filter((o) => o.ativo && Number(o.ajuda_custo_mensal) > 0);
    if (!comAjuda.length) return;
    const maior = comAjuda.reduce((a, b) => (Number(a.ajuda_custo_mensal) >= Number(b.ajuda_custo_mensal) ? a : b));
    alvo.textContent = `${fmtBRL(maior.ajuda_custo_mensal)} por mês de ajuda de custo`;
  })
  .catch(() => {});
