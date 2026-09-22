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

// Bloco promocional da Home (Parte P do pedido de Ofertas/Promoções,
// 22/09/2026) — consome a campanha vigente marcada "mostrar na Home", nunca
// hardcoded. Sem promoção vigente com essa marca, a seção some inteira
// (fica `hidden` desde o HTML, e continua assim).
fetch(`${API_BASE_URL}/promocoes/vigentes`)
  .then((r) => r.json())
  .then((promocoes) => {
    const promo = (Array.isArray(promocoes) ? promocoes : []).find((p) => p.mostrar_home);
    if (!promo) return;
    const secao = document.getElementById('promocaoHomeSecao');
    const el = document.getElementById('promocaoHome');
    el.innerHTML = `
      <div class="promo-home ${promo.imagem_url ? 'com-imagem' : ''}">
        ${promo.imagem_url ? `<img class="promo-home-img" src="${esc(promo.imagem_url)}" alt="">` : ''}
        <div class="promo-home-texto">
          ${promo.selo ? `<span class="badge">${esc(promo.selo)}</span>` : ''}
          <h2>${esc(promo.titulo_publico)}</h2>
          ${promo.subtitulo ? `<p class="lead">${esc(promo.subtitulo)}</p>` : ''}
          ${promo.descricao ? `<p>${esc(promo.descricao)}</p>` : ''}
          <a class="btn primary" href="/planos.html">Ver condição na página de planos</a>
        </div>
      </div>`;
    secao.hidden = false;
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
