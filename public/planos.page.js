let PLANOS = [];
// Se já estiver logado como anunciante, assinar aqui mesmo — sem passar
// pelo cadastro de novo (o painel pega o ?plano= e gera a cobrança).
let LOGADO = false;
// A troca do cabeçalho pelo menu da conta é do /layout.js — aqui só
// interessa saber se está logado, pra o botão do plano ir pro painel
// (que gera a cobrança) em vez de pedir cadastro de novo.
const carregarLogin = carregarConta().then((a) => { LOGADO = !!a; });

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
  const mensal = PLANOS.find((p) => p.tier === tier && p.compromisso_meses === 1 && !p.fundador);
  return mensal ? Number(mensal.valor_mensal) : null;
}

// Plano fundador: fica fora da grade de ciclos, sempre visível enquanto o
// programa estiver aberto e houver vaga (o servidor já filtra isso — ver
// GET /planos). Preço travado, meses grátis e vagas vêm do próprio plano.
function renderFundador() {
  const fundadores = PLANOS.filter((p) => p.fundador);
  const bloco = document.getElementById('fundadorBloco');
  bloco.hidden = !fundadores.length;
  if (!fundadores.length) return;
  const vagas = fundadores.reduce((s, p) => s + (p.vagas_restantes == null ? 0 : p.vagas_restantes), 0);
  document.getElementById('fundadorAviso').innerHTML = `<b>Programa fundador aberto.</b> Quem entra agora trava o preço de lançamento pelo tempo do plano${vagas ? ` — restam <b>${vagas} vaga${vagas > 1 ? 's' : ''}</b>` : ''}. Depois disso, valem os planos normais abaixo.`;
  document.getElementById('fundadorGrid').innerHTML = fundadores.map((p) => {
    const meses = p.compromisso_meses;
    const porMes = Number(p.valor_mensal);
    const cheio = Number(p.valor_mensal_cheio) || mensalDoTier(p.tier);
    const porHora = Math.round(p.frequencia_dia / 12);
    return `
    <div class="plan-card fundador">
      <span class="badge">Fundador</span>
      ${p.rotulo ? `<div class="rotulo">${esc(p.rotulo)}</div>` : ''}
      <div class="tier">${esc(p.nome)}</div>
      <div class="freq">${p.frequencia_dia}x por dia em cada tela <small>(≈${porHora}x por hora)</small></div>
      ${cheio && cheio > porMes ? `<div class="price-riscado">${fmt(cheio)}/mês</div>` : ''}
      <div class="price">${fmt(porMes)}<small class="u-fs-100">/mês</small></div>
      <div class="price-sub">
        ${meses > 1 ? `${fmt(porMes * meses)} ${LABEL_CICLO[meses] || `a cada ${meses} meses`}` : 'cobrado mensalmente'}
        ${p.preco_travado ? `<b>Preço travado por ${meses} meses</b>` : ''}
      </div>
      <ul>
        ${(p.beneficios || []).map((b) => `<li>${esc(b)}</li>`).join('')}
        ${p.ponto_apos_meses ? `<li><b>Ao completar ${p.ponto_apos_meses} meses, ganhe uma tela no seu comércio</b></li>` : ''}
        ${p.vagas_restantes != null ? `<li class="vagas">${p.vagas_restantes} vaga${p.vagas_restantes > 1 ? 's' : ''} restante${p.vagas_restantes > 1 ? 's' : ''}</li>` : ''}
      </ul>
      <a class="btn primary block" href="${LOGADO ? `/anunciante/painel.html?plano=${p.id}` : `/anunciante/cadastro.html?plano=${p.id}`}">Quero ser fundador</a>
    </div>`;
  }).join('');
}

function render(meses) {
  const grid = document.getElementById('plansGrid');
  document.getElementById('cycleNote').textContent = NOTA_CICLO[meses] || '';
  const doMes = PLANOS.filter((p) => p.compromisso_meses === meses && !p.fundador);
  grid.innerHTML = doMes.map((p) => {
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
      <div class="freq">${p.frequencia_dia}x por dia em cada ponto <small>(≈${porHora}x por hora)</small></div>
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
  }).join('');
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
    const descontos = PLANOS.filter((p) => p.compromisso_meses === meses && !p.fundador).map((p) => {
      const base = mensalDoTier(p.tier);
      return base ? Math.round((1 - p.valor_mensal / base) * 100) : 0;
    }).filter((d) => d > 0);
    rotulo.textContent = descontos.length ? `-${Math.max(...descontos)}%` : '';
  });
}

fetch(`${API_BASE_URL}/pontos/fluxo`).then((r) => r.json()).then(({ pessoasPorMes }) => {
  if (!pessoasPorMes) return;
  const el = document.getElementById('planosFluxo');
  el.innerHTML = `Hoje a rede já alcança <b>${pessoasPorMes.toLocaleString('pt-BR')} pessoas por mês</b> nos pontos instalados.`;
  el.hidden = false;
}).catch(() => {});

Promise.all([fetch(`${API_BASE_URL}/planos`).then((r) => r.json()), carregarLogin])
  .then(([planos]) => { PLANOS = planos; atualizarDescontos(); renderFundador(); render(3); })
  .catch(() => {
    document.getElementById('plansGrid').innerHTML = '<p class="empty-state">Não foi possível carregar os planos agora.</p>';
  });
