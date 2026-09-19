let ANUNCIANTE = null;

// Aviso de cobertura da rede (RN-49), reaproveitado da vitrine e do painel
// com plano ativo: quantos pontos existem hoje e, quando o plano cobre mais
// pontos do que a rede tem no ar, a explicação de que essas horas entram no
// banco de horas e se concentram nos pontos já ligados. Quem chama decide se
// mostra (ver limite de 10 pontos em montarConfirmacaoPedido).
function montarAvisoRede(plano, pontos) {
  const naRede = pontos.length;
  const veiculando = pontos.filter((p) => p.status === 'em_operacao').length;
  const situacaoRede =
    naRede === 0
      ? 'A rede ainda não tem nenhum ponto ativo hoje.'
      : `A rede tem hoje ${naRede} ${naRede === 1 ? 'ponto cadastrado' : 'pontos cadastrados'}${
          veiculando !== naRede ? `, ${veiculando} já no ar` : ', todos no ar'
        }.`;
  const cobreMaisQueARede = plano.pontos_incluidos && veiculando > 0 && plano.pontos_incluidos > veiculando;
  const explicacaoBancoHoras = cobreMaisQueARede
    ? ' Enquanto a rede não chega no tamanho do seu plano, as horas dos pontos que faltam entram no banco de horas e se concentram nos pontos que já estão no ar, até a rede completar essa cobertura. Conforme novos pontos entram no ar, o tempo se espalha de volta.'
    : '';
  return `<div class="aviso-rede u-m-0"><b>${situacaoRede}</b>${explicacaoBancoHoras}</div>`;
}

// Confirmação antes de gerar cobrança. Antes, chegar aqui com ?plano=X já
// criava a cobrança e jogava o anunciante no checkout sem ele nunca ver
// quanto ia pagar — e um F5 nessa URL gerava outra cobrança.
async function montarConfirmacaoPedido(planoId) {
  const box = document.getElementById('confirmacaoPedido');
  box.innerHTML = '<p class="form-hint u-m-0">Carregando seu pedido...</p>';
  let plano = null;
  let pontos = [];
  try {
    const [planos, listaPontos] = await Promise.all([
      fetch(`${API_BASE_URL}/planos`).then((r) => r.json()),
      fetch(`${API_BASE_URL}/pontos`)
        .then((r) => r.json())
        .catch(() => []),
    ]);
    plano = planos.find((p) => p.id === planoId);
    if (Array.isArray(listaPontos)) pontos = listaPontos;
  } catch {
    /* plano fica null e cai no aviso de erro abaixo */
  }
  if (!plano) {
    box.innerHTML =
      '<p class="form-msg err">Não encontramos esse plano. <a href="/planos.html">Escolha de novo em Planos.</a></p>';
    return;
  }
  const total = Math.round(Number(plano.valor_mensal) * plano.compromisso_meses * 100) / 100;
  const ciclo = plano.compromisso_meses === 1 ? 'mensal' : `a cada ${plano.compromisso_meses} meses`;
  // Economia e equivalência mensal, condicionais (pedido do dono, 19/09/2026,
  // mesma regra da vitrine — ver montarPreco em planos.page.js): no ciclo
  // mensal o total JÁ é o valor por mês, então nenhuma das duas linhas diz
  // nada de novo. Nos demais ciclos, "economizou" só aparece quando o plano
  // tem desconto de verdade (`valor_mensal_cheio` é a referência sem
  // desconto, a mesma que a vitrine usa pro preço riscado).
  const cheio =
    plano.desconto_percentual > 0 && plano.valor_mensal_cheio != null ? Number(plano.valor_mensal_cheio) : null;
  const economia = cheio ? Math.round((cheio * plano.compromisso_meses - total) * 100) / 100 : 0;
  // Cada característica do plano em uma linha, como um resumo de compra, em
  // vez da frase corrida que existia antes. `horas_por_mes` vem calculado
  // pelo servidor (GET /planos), com a mesma função da vitrine — não
  // recalculado aqui, que viraria a terceira conta pro mesmo número.
  const linhas = [
    plano.horas_por_mes ? ['Horas de tela por mês', `até ${plano.horas_por_mes}h na rede`] : null,
    plano.pontos_incluidos
      ? ['Pontos incluídos', `até ${plano.pontos_incluidos} ${plano.pontos_incluidos === 1 ? 'ponto' : 'pontos'}`]
      : ['Pontos incluídos', 'todos os pontos da rede'],
    plano.duracao_maxima_segundos ? ['Duração da peça', `até ${plano.duracao_maxima_segundos} segundos`] : null,
    ['Cobrança', ciclo],
  ].filter(Boolean);

  // Quantos pontos a rede tem hoje, e o que acontece com as horas dos que
  // ainda faltam (pedido do dono, 19/09/2026): mesma mecânica do aviso de
  // cobertura já usado na vitrine e no painel com plano ativo (RN-49), agora
  // também na hora de decidir a compra.
  //
  // Mesmo limite de 10 pontos da vitrine (`PONTOS_PARA_TIRAR_AVISO` em
  // planos.page.js, ajustado de 5 pra 10 em 19/09/2026): com 10 pontos a
  // rede já cobre o maior plano vendido, então o aviso inteiro some — não
  // sobra plano que ainda precisaria dele.
  const avisoRede = pontos.length < 10 ? montarAvisoRede(plano, pontos) : '';

  // A ressalva da cobrança e do prazo de arrependimento saiu daqui a pedido
  // do dono (19/09/2026): a tela de pedido é só o resumo da compra. O prazo
  // de 7 dias continua valendo e disponível pro cliente (Termos de Uso,
  // Contrato do anunciante e vitrine em /planos.html) — só não repete aqui.
  // Resumo de preço primeiro (subtotal, desconto, total, equivalente
  // mensal), como qualquer tela de checkout de mercado — antes essas quatro
  // informações vinham espalhadas (um "Total" no meio da lista de
  // características do plano, "economizou" e "equivale a" soltos depois).
  // Só mostra Subtotal/Desconto quando existe desconto de verdade
  // (`cheio` é o preço cheio de referência — sem ele não tem o que abater).
  const linhasPreco = [
    cheio ? ['Subtotal', fmtBRL(cheio * plano.compromisso_meses)] : null,
    economia > 0 ? ['Desconto', `-${fmtBRL(economia)}`, 'desconto'] : null,
  ].filter(Boolean);

  box.innerHTML = `
    <p class="eyebrow">Confirmar pedido</p>
    <h3 class="u-m-0 u-mb-4">${esc(plano.nome)}</h3>
    <p class="form-hint u-m-0 u-mb-14">Revise os detalhes do seu plano antes de continuar.</p>
    ${
      linhasPreco.length
        ? `<div class="pedido-linhas">
      ${linhasPreco.map(([rotulo, valor, classe]) => `<div class="pedido-linha${classe ? ` ${classe}` : ''}"><span>${esc(rotulo)}</span><span>${esc(valor)}</span></div>`).join('')}
    </div>`
        : ''
    }
    <div class="pedido-total">
      <span class="rotulo">Total ${ciclo}</span>
      <b>${fmtBRL(total)}</b>
    </div>
    ${plano.compromisso_meses > 1 ? `<p class="form-hint u-m-0 u-mb-14">Equivale a ${fmtBRL(plano.valor_mensal)} por mês.</p>` : ''}
    <p class="form-hint u-m-0 u-mb-4">O que está incluso</p>
    <div class="pedido-linhas">
      ${linhas.map(([rotulo, valor]) => `<div class="pedido-linha"><span>${esc(rotulo)}</span><span>${esc(valor)}</span></div>`).join('')}
    </div>
    ${avisoRede}
    <div class="field-row u-mt-8">
      <button class="btn primary" id="btnConfirmarPlano">Ir para o pagamento</button>
      <a class="btn ghost" href="/planos.html">Escolher outro</a>
    </div>
    <p class="form-msg" id="msgConfirmacaoPedido"></p>
  `;
  document.getElementById('btnConfirmarPlano').addEventListener('click', (e) => {
    e.target.disabled = true;
    // Tira o ?plano= da URL pra que um F5 (ou um "voltar" depois de ir pro
    // Checkout) não caia direto nesta mesma confirmação de novo.
    history.replaceState(null, '', '/anunciante/confirmar-plano.html');
    assinar(ANUNCIANTE.id, planoId);
  });
}

// Troca de plano de quem já paga (POST /trocar-plano do Checkout, desde
// 18/09/2026): cobra o acerto proporcional no cartão já salvo, na mesma
// hora, sem redirecionar pra uma segunda tela de pagamento. O Checkout não
// tem modo de "só calcular sem cobrar" (o valor nunca vem do corpo da
// requisição, pra ninguém escolher quanto paga), então não dá pra mostrar o
// número exato antes de confirmar; o botão avisa o que vai acontecer em vez
// de prometer um valor que só o servidor sabe.
async function montarConfirmacaoTroca(planoNovoId) {
  const box = document.getElementById('confirmacaoPedido');
  box.innerHTML = `
    <p class="eyebrow">Confirmar pedido</p>
    <h3 class="u-m-0 u-mb-14">Trocar de plano</h3>
    <p class="u-m-0 u-mb-12">Se o plano novo custa mais, a diferença proporcional aos dias que faltam no seu
      ciclo atual é cobrada agora, no cartão que você já tem salvo. Se custa menos, nada é cobrado nem
      devolvido agora. O valor novo passa a valer só na sua próxima renovação.</p>
    <div class="field-row">
      <button class="btn primary" id="btnConfirmarTroca">Trocar agora</button>
      <a class="btn ghost" href="/planos.html">Escolher outro</a>
    </div>
    <p class="form-msg" id="msgConfirmacaoPedido"></p>
  `;
  document.getElementById('btnConfirmarTroca').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Trocando...';
    const msg = document.getElementById('msgConfirmacaoPedido');
    const r = await fetch(`${API_BASE_URL}/anunciantes/me/trocar-plano`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planoNovoId }),
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) {
      msg.innerHTML = `${esc(corpo.erro || 'Não foi possível trocar de plano.')} <a href="/planos.html">Escolher outro plano</a>`;
      msg.className = 'form-msg err';
      e.target.disabled = false;
      e.target.textContent = 'Trocar agora';
      return;
    }
    e.target.remove();
    document.querySelector('#confirmacaoPedido .btn.ghost')?.remove();
    const texto = corpo.acerto?.cobrado
      ? `Troca feita. Cobramos ${fmtBRL(corpo.acerto.valor)} de acerto no cartão salvo.`
      : 'Troca feita. Como o plano novo é mais barato, nada foi cobrado agora. O valor novo vale a partir da próxima renovação.';
    msg.textContent = texto;
    msg.className = 'form-msg ok';
    box.insertAdjacentHTML(
      'beforeend',
      '<a class="btn ghost" id="btnIrPainel" href="/anunciante/painel.html">Ir pro meu painel</a>',
    );
  });
}

// Assinatura de plano — a escolha em si acontece em /planos.html (mesma
// página pública, linkando pra cá com ?plano=X quando já logado); aqui só
// sobra gerar a cobrança e mandar pro checkout.
async function assinar(anuncianteId, planoId) {
  const msg = document.getElementById('msgConfirmacaoPedido');
  msg.textContent = 'Gerando cobrança...';
  msg.className = 'form-msg';
  const r = await fetch(`${API_BASE_URL}/anunciantes/${anuncianteId}/assinar`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planoId }),
  });
  if (!r.ok) {
    const erro = (await r.json().catch(() => ({}))).erro;
    msg.innerHTML = `${esc(erro || 'Não foi possível gerar a cobrança.')} <a href="/planos.html">Escolher outro plano</a>`;
    msg.className = 'form-msg err';
    document.getElementById('btnConfirmarPlano').disabled = false;
    return;
  }
  const { checkoutUrl } = await r.json();
  // Se o San Checkout não estiver configurado (.env sem
  // SAN_CHECKOUT_BASE_URL/CONTRATANTE_ID), checkoutUrl vira um caminho
  // relativo tipo "/index.html?..." e o navegador cairia na home sem
  // avisar nada — melhor mostrar o erro do que redirecionar pra lugar
  // nenhum.
  if (!/^https?:\/\//.test(checkoutUrl)) {
    msg.textContent =
      'Checkout não configurado neste ambiente (SAN_CHECKOUT_BASE_URL vazio no .env). Fale com o suporte técnico.';
    msg.className = 'form-msg err';
    document.getElementById('btnConfirmarPlano').disabled = false;
    return;
  }
  window.location.href = checkoutUrl;
}

async function carregar() {
  const planoUrl = new URLSearchParams(window.location.search).get('plano');
  // Esta página só existe pra confirmar um pedido — sem plano na URL não há
  // o que mostrar aqui.
  if (!planoUrl) {
    window.location.href = '/planos.html';
    return;
  }

  const r = await fetch(`${API_BASE_URL}/anunciantes/me`, { credentials: 'include' });
  if (r.status === 401) {
    window.location.href = '/anunciante/login.html';
    return;
  }
  if (!r.ok) throw new Error();
  ANUNCIANTE = await r.json();

  // Mesmo gate de papel que o resto do painel (modos.js): sem o papel
  // "anunciante" liberado, mostra o card de ativação em vez do pedido — só
  // acontece com contas que entraram pelo convite de outro papel (ponto,
  // vendedor) e ainda não ativaram anúncios.
  await montarModo('anunciante', document.getElementById('dashboardConfirmacao'), async () => {
    const temPlanoPagoAtivo =
      ANUNCIANTE.plano_id &&
      !ANUNCIANTE.plano_cortesia &&
      ANUNCIANTE.data_expiracao &&
      new Date(ANUNCIANTE.data_expiracao) > new Date();
    if (!ANUNCIANTE.plano_id) {
      montarConfirmacaoPedido(planoUrl);
      return;
    }
    if (temPlanoPagoAtivo && planoUrl !== ANUNCIANTE.plano_id) {
      montarConfirmacaoTroca(planoUrl);
      return;
    }
    // Já tem esse plano mesmo (ou plano de cortesia, que não troca por
    // aqui) — nada a confirmar, volta pro painel de verdade.
    window.location.href = '/anunciante/painel.html';
  });
}

carregar();
