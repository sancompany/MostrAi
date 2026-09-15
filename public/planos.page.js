let PLANOS = [];
// Se já estiver logado como anunciante, assinar aqui mesmo — sem passar
// pelo cadastro de novo (o painel pega o ?plano= e gera a cobrança).
let LOGADO = false;
// A troca do cabeçalho pelo menu da conta é do /layout.js — aqui só
// interessa saber se está logado, pra o botão do plano ir pro painel
// (que gera a cobrança) em vez de pedir cadastro de novo.
const carregarLogin = carregarConta().then((a) => {
  LOGADO = !!a;
});

const fmt = fmtBRL; // config.js — Number(v||0), o local usava Number(v) e virava 'R$ NaN'

const NOTA_CICLO = {
  // Os Termos (§4.4) dizem que o cancelamento e pedido ao administrador e
  // vale a partir do proximo ciclo. A vitrine dizia "cancele quando quiser",
  // o contrario do contrato que a pessoa assina na mesma compra.
  1: 'Sem fidelidade: você pede o cancelamento quando quiser e ele vale a partir do mês seguinte — o mês já pago continua no ar.',
  3: 'Você paga uma vez a cada 3 meses. O valor por mês abaixo é a referência de quanto isso representa.',
  6: 'Você paga uma vez a cada 6 meses. O valor por mês abaixo é a referência de quanto isso representa.',
  12: 'Você paga uma vez por ano. O valor por mês abaixo é a referência de quanto isso representa.',
};

const LABEL_CICLO = { 3: 'cobrado a cada 3 meses', 6: 'cobrado a cada 6 meses', 12: 'cobrado 1x por ano' };

// Referência de preço cheio: é o plano mensal do mesmo tier. Assinar 3
// meses custa o mensal × 3 se não houvesse desconto — esse é o valor
// riscado, e a diferença dividida pelos meses é a economia por mês.
function mensalDoTier(tier) {
  const mensal = PLANOS.find((p) => p.tier === tier && p.compromisso_meses === 1);
  return mensal ? Number(mensal.valor_mensal) : null;
}

function render(meses) {
  const grid = document.getElementById('plansGrid');
  document.getElementById('cycleNote').textContent = NOTA_CICLO[meses] || '';
  const doMes = PLANOS.filter((p) => p.compromisso_meses === meses);
  // Aba sem plano nenhum deixava a area em branco, sem dizer se estava
  // carregando, se deu erro ou se nao ha plano naquele ciclo.
  if (!doMes.length) {
    grid.innerHTML =
      '<p class="empty-state">Nenhum plano nesse ciclo agora. Veja os outros ciclos acima ou ' +
      '<a href="/contato.html">fale com a gente</a>.</p>';
    return;
  }
  grid.innerHTML = doMes
    .map((p) => {
      const porHora = Math.round(p.frequencia_dia / 12);
      const porMes = Number(p.valor_mensal);
      const totalCiclo = porMes * meses;
      const referencia = mensalDoTier(p.tier) || Number(p.valor_mensal_cheio) || null;
      const totalCheio = referencia ? referencia * meses : null;
      const economiaMes = referencia ? referencia - porMes : 0;
      return `
    <div class="plan-card ${p.destaque_no_site ? 'popular' : ''}">
      ${p.destaque_no_site ? '<span class="badge">Mais escolhido</span>' : ''}
      ${p.rotulo ? `<div class="rotulo">${esc(p.rotulo)}</div>` : ''}
      <div class="tier">${esc(p.nome)}</div>
      <div class="freq">${p.frequencia_dia}x por dia em cada ponto <small>(≈${porHora}x por hora num comércio aberto 12h)</small></div>
      ${totalCheio && economiaMes > 0 ? `<div class="price-riscado">${fmt(totalCheio)}</div>` : ''}
      <div class="price">${fmt(totalCiclo)}</div>
      <div class="price-sub">
        ${fmt(porMes)}/mês${meses > 1 ? ` · ${LABEL_CICLO[meses]}` : ''}
        ${economiaMes > 0 ? `<b>Você economiza ${fmt(economiaMes)} por mês</b>` : ''}
      </div>
      <ul>${(p.beneficios || []).map((b) => `<li>${esc(b)}</li>`).join('')}
        ${p.ponto_apos_meses ? `<li><b>Ao completar ${p.ponto_apos_meses} meses, ganhe uma tela no seu comércio</b></li>` : ''}</ul>
      <a class="btn ${p.destaque_no_site ? 'primary' : 'ghost'} block" href="${LOGADO ? `/anunciante/painel.html?plano=${p.id}` : `/anunciante/cadastro.html?plano=${p.id}`}">Assinar ${esc(p.nome)}</a>
    </div>
  `;
    })
    .join('');
}

document.getElementById('cycleToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#cycleToggle button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  render(Number(btn.dataset.meses));
});

// O desconto de cada ciclo sai dos preços que estão no banco, não de um
// número escrito na mão aqui — se o admin mexer no preço, o rótulo segue.
function atualizarDescontos() {
  document.querySelectorAll('#cycleToggle button').forEach((btn) => {
    const meses = Number(btn.dataset.meses);
    const rotulo = btn.querySelector('small');
    if (!rotulo || meses === 1) return;
    const descontos = PLANOS.filter((p) => p.compromisso_meses === meses)
      .map((p) => {
        const base = mensalDoTier(p.tier);
        return base ? Math.round((1 - p.valor_mensal / base) * 100) : 0;
      })
      .filter((d) => d > 0);
    rotulo.textContent = descontos.length ? `-${Math.max(...descontos)}%` : '';
  });
}

fetch(`${API_BASE_URL}/pontos/fluxo`)
  .then((r) => r.json())
  .then(({ pessoasPorMes }) => {
    if (!pessoasPorMes) return;
    const el = document.getElementById('planosFluxo');
    // "alcança" era medicao; isto e estimativa de fluxo declarada por cada
    // ponto na instalacao. A palavra mudou pra o que o numero e de verdade.
    el.innerHTML = `Os pontos no ar estimam <b>${pessoasPorMes.toLocaleString('pt-BR')} pessoas por mês</b> passando na frente das telas.`;
    el.hidden = false;
  })
  .catch(() => {});

Promise.all([fetch(`${API_BASE_URL}/planos`).then((r) => r.json()), carregarLogin])
  .then(([planos]) => {
    PLANOS = planos;
    atualizarDescontos();
    render(3);
  })
  .catch(() => {
    document.getElementById('plansGrid').innerHTML =
      '<p class="empty-state">Não foi possível carregar os planos agora.</p>';
  });

// Vender cobertura numa rede sem nenhuma tela no ar era o furo mais caro da
// vitrine: a cobranca comeca na confirmacao do pagamento (migration 021 tirou
// a espera por ponto), entao quem assinasse ia pagar por uma rede vazia sem a
// tela dizer isso em lugar nenhum. Nao bloqueia a venda, so para de esconder.
fetch(`${API_BASE_URL}/pontos`)
  .then((r) => r.json())
  .then((pontos) => {
    // /pontos e a lista da pagina "Onde estamos", que mostra tambem ponto em
    // instalacao e em reparo. Quem exibe anuncio e so o 'ativo'.
    if (!Array.isArray(pontos) || pontos.some((p) => p.status === 'ativo')) return;
    const el = document.getElementById('avisoRede');
    el.innerHTML =
      '<b>A rede ainda está em montagem.</b> Neste momento não há nenhuma tela no ar. ' +
      'A cobrança do plano começa na confirmação do pagamento, e não quando a primeira tela subir. ' +
      'Se preferir esperar, <a href="/contato.html">fale com a gente</a> — e se assinar agora e mudar de ideia, ' +
      'você tem 7 dias para pedir a devolução integral pelo painel.';
    el.hidden = false;
  })
  .catch(() => {});
