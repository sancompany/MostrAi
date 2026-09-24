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
  let cotacao = null;
  try {
    const [planos, listaPontos, cotado] = await Promise.all([
      fetch(`${API_BASE_URL}/planos`).then((r) => r.json()),
      fetch(`${API_BASE_URL}/pontos`)
        .then((r) => r.json())
        .catch(() => []),
      // O valor vem do SERVIDOR, calculado pelas mesmas funções da cobrança
      // (GET /anunciantes/me/cotacao, src/financeiro/cotacao.js): promoção
      // vigente pra esta conta, desconto do ciclo, crédito de comodato e
      // desconto de parceiro (ADR-014). Até 23/09/2026 esta tela fazia a
      // própria conta com `valor_mensal` e mostrava R$ 672,30 pra uma
      // cobrança de R$ 597,60 — duas contas pro mesmo preço divergem.
      fetch(`${API_BASE_URL}/anunciantes/me/cotacao/${encodeURIComponent(planoId)}`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    plano = planos.find((p) => p.id === planoId);
    if (Array.isArray(listaPontos)) pontos = listaPontos;
    cotacao = cotado;
  } catch {
    /* plano fica null e cai no aviso de erro abaixo */
  }
  if (!plano) {
    box.innerHTML =
      '<p class="form-msg err">Não encontramos esse plano. <a href="/planos.html">Escolha de novo em Planos.</a></p>';
    return;
  }
  // Sem a cotação (rede caiu no meio), a tela não inventa um número: diz que
  // o valor exato aparece no pagamento, e o botão continua funcionando —
  // quem calcula a cobrança é o servidor, com ou sem esta tela.
  const total = cotacao ? cotacao.valorCiclo : null;
  const ciclo = plano.compromisso_meses === 1 ? 'mensal' : `a cada ${plano.compromisso_meses} meses`;
  // Nome do ciclo pro título ("Pro - Trimestral"), separado da frase usada
  // na linha "Cobrança" ("a cada 3 meses") — pedido do dono, 19/09/2026: o
  // nome do plano sozinho não diz qual ciclo essa confirmação é, e com
  // troca de plano ou mais de um ciclo por tier isso importa de cara.
  const NOME_CICLO = { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };
  const nomeCiclo = NOME_CICLO[plano.compromisso_meses] || `a cada ${plano.compromisso_meses} meses`;
  // Subtotal e descontos, condicionais (pedido do dono, 19/09/2026, mesma
  // regra da vitrine — ver montarPreco em planos.page.js): só aparecem
  // quando existe desconto de verdade. O desconto de TABELA é o do ciclo ou
  // o da promoção (um substitui o outro, ADR-014); o da CONTA é o crédito de
  // comodato e/ou o desconto de parceiro, que somam por cima.
  const descontoTabela = cotacao ? Math.round((cotacao.cheioCiclo - cotacao.tabelaCiclo) * 100) / 100 : 0;
  const descontoConta = cotacao ? Math.round((cotacao.tabelaCiclo - cotacao.valorCiclo) * 100) / 100 : 0;
  // Promoção que não baixa o preço do ciclo (Anual 20% × pré-venda 20%) não
  // é chamada de promoção aqui: o desconto aparece como o do ciclo, sem a
  // nota de "preço promocional" (D1, 24/09/2026 — cotacao.js#temVantagem).
  const promo = cotacao?.promocao && cotacao.promocao.temVantagem !== false ? cotacao.promocao : null;
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
    // exibicoes_por_mes também vem calculado do servidor (mesma conta de
    // horas_por_mes, ver GET /planos) — é o piso: uma peça mais curta que
    // o teto do plano aparece mais vezes que este número, nunca menos.
    plano.exibicoes_por_mes
      ? ['Exibições por mês', `pelo menos ${plano.exibicoes_por_mes.toLocaleString('pt-BR')} vezes na rede`]
      : null,
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
  // Resumo de preço primeiro (subtotal, descontos, total), como qualquer
  // tela de checkout de mercado.
  const direitosDaConta = [cotacao?.descontoParceiro ? 'desconto de parceiro' : null].filter(Boolean);
  const linhasPreco = [
    descontoTabela > 0 || descontoConta > 0 ? ['Subtotal', fmtBRL(cotacao.cheioCiclo), 'dinheiro'] : null,
    descontoTabela > 0
      ? [
          promo ? `Desconto (${promo.selo || 'promoção'}, -${promo.descontoPercentual}%)` : 'Desconto do ciclo',
          `-${fmtBRL(descontoTabela)}`,
          'desconto dinheiro',
        ]
      : null,
    descontoConta > 0
      ? [`Desconto da sua conta (${direitosDaConta.join(' e ')})`, `-${fmtBRL(descontoConta)}`, 'desconto dinheiro']
      : null,
  ].filter(Boolean);
  const notaPromo = promo
    ? `<p class="form-hint u-m-0">Preço promocional válido por ${promo.duracaoMeses} meses a partir da adesão.</p>`
    : '';
  const totalHtml =
    total != null
      ? `<b>${fmtBRL(total)}</b>`
      : '<span class="form-hint u-m-0">O valor exato aparece na tela de pagamento.</span>';

  box.innerHTML = `
    <p class="eyebrow">Confirmar pedido</p>
    <h3 class="u-m-0 u-mb-4">${esc(plano.nome)} - ${esc(nomeCiclo)}</h3>
    <p class="form-hint u-m-0 u-mb-14">Revise os detalhes do seu plano antes de continuar.</p>
    ${
      linhasPreco.length
        ? `<div class="pedido-linhas">
      ${linhasPreco.map(([rotulo, valor, classe]) => `<div class="pedido-linha${classe ? ` ${classe}` : ''}"><span>${esc(rotulo)}</span><span>${esc(valor)}</span></div>`).join('')}
    </div>`
        : ''
    }
    <div class="pedido-total">
      <span class="rotulo">Total</span>
      ${totalHtml}
    </div>
    ${notaPromo}
    <p class="form-hint u-mt-14 u-mb-4">O que está incluso</p>
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

// Troca de plano de quem já paga (POST /trocar-plano do Checkout). Sem
// diferença a pagar (rebaixamento, ou diferença abaixo de R$ 5), troca na
// hora, sem sair daqui. Com diferença a pagar, desde 21/09/2026 o Checkout
// responde 202 e pede pra levar o pagador pra uma tela dele — o dono
// decidiu que nenhuma cobrança acontece sem o pagador aprovar o valor
// explicitamente (antes, cobrava direto no cartão salvo, sem ele ver
// nada). Não dá pra saber ANTES de chamar qual dos dois vai acontecer (o
// valor nunca vem do corpo da requisição, pra ninguém escolher quanto
// paga), então o botão avisa os dois casos.
async function montarConfirmacaoTroca(planoNovoId) {
  const box = document.getElementById('confirmacaoPedido');
  box.innerHTML = `
    <p class="eyebrow">Confirmar pedido</p>
    <h3 class="u-m-0 u-mb-14">Trocar de plano</h3>
    <p class="u-m-0 u-mb-12">Se houver diferença a pagar entre os planos, você vai aprovar o valor exato numa tela do Checkout antes de qualquer cobrança. Sem diferença, a troca já acontece agora.</p>
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
    if (r.status === 202) {
      // approvalUrl ausente não deveria acontecer (contrato do Checkout
      // garante os dois juntos no 202) — mas cair no sucesso abaixo sem
      // ele diria "troca feita" pra uma troca que não aconteceu. Melhor
      // erro claro do que mentira sobre dinheiro.
      if (!corpo.approvalUrl) {
        msg.textContent = 'Não conseguimos abrir a tela de aprovação do Checkout. Tente de novo em instantes.';
        msg.className = 'form-msg err';
        e.target.disabled = false;
        e.target.textContent = 'Trocar agora';
        return;
      }
      msg.textContent = 'Levando você pro Checkout pra aprovar o valor...';
      msg.className = 'form-msg';
      window.location.href = corpo.approvalUrl;
      return;
    }
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
//
// Benefício em vigor (24/09/2026, ADR-016): o servidor responde 409 com
// `confirmacao` dizendo exatamente o que acontece com o benefício (encerra na
// hora, sem devolver créditos; ou o plano começa depois dele). A pessoa lê e
// escolhe Voltar ou Continuar — só então a cobrança é gerada.
async function assinar(anuncianteId, planoId, confirmarBeneficio = false) {
  const msg = document.getElementById('msgConfirmacaoPedido');
  msg.textContent = 'Gerando cobrança...';
  msg.className = 'form-msg';
  const r = await fetch(`${API_BASE_URL}/anunciantes/${anuncianteId}/assinar`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planoId, confirmarBeneficio }),
  });
  if (r.status === 409) {
    const corpo = await r.json().catch(() => ({}));
    if (corpo.confirmacao) {
      msg.textContent = '';
      if (await confirmarTroca(corpo.confirmacao)) return assinar(anuncianteId, planoId, true);
      document.getElementById('btnConfirmarPlano').disabled = false;
      return;
    }
    msg.innerHTML = `${esc(corpo.erro || 'Não foi possível gerar a cobrança.')} <a href="/planos.html">Escolher outro plano</a>`;
    msg.className = 'form-msg err';
    document.getElementById('btnConfirmarPlano').disabled = false;
    return;
  }
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
    // Assinatura nova, troca ou "já tem esse plano"? Quem decide é o
    // SERVIDOR (`acao` da cotação, src/financeiro/cotacao.js — mesma régua
    // de vigência do gerador e da cobrança). Até 24/09/2026 esta tela
    // comparava `data_expiracao` com o relógio do navegador, e vencia o
    // plano um dia antes do que o resto do sistema. Sem cotação (rede caiu),
    // trata como pedido novo — o POST /assinar é quem decide de verdade.
    let acao = 'assinar';
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/cotacao/${encodeURIComponent(planoUrl)}`, {
        credentials: 'include',
      });
      if (r.ok) acao = (await r.json()).acao || 'assinar';
    } catch {
      /* fica 'assinar' */
    }
    if (acao === 'ja_tem') {
      // Já tem esse plano pago — nada a confirmar, volta pro painel.
      window.location.href = '/anunciante/painel.html';
      return;
    }
    // Sem plano, ou num benefício (cortesia — por créditos ou legado): o
    // pedido é uma assinatura nova. Como ela convive com o benefício quem
    // decide é o servidor (ADR-016): pago maior entra na hora e encerra o
    // benefício; igual ou menor começa depois dele — o /assinar devolve o
    // texto e o cliente confirma antes de pagar (confirmarTroca, abaixo).
    if (acao === 'trocar') montarConfirmacaoTroca(planoUrl);
    else montarConfirmacaoPedido(planoUrl);
  });
}

carregar();

// Diálogo nativo (<dialog>) com o texto que o servidor mandou — Voltar ou
// Continuar. Resolve true só em Continuar.
function confirmarTroca({ titulo, texto, botao }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg-resgate';
    dlg.innerHTML = `<h3 class="u-mt-0">${esc(titulo)}</h3><p>${esc(texto)}</p>
      <div class="dlg-acoes"><button type="button" class="btn ghost" data-voltar>Voltar</button>
      <button type="button" class="btn primary" data-continuar>${esc(botao)}</button></div>`;
    document.body.appendChild(dlg);
    let ok = false;
    dlg.querySelector('[data-voltar]').addEventListener('click', () => dlg.close());
    dlg.querySelector('[data-continuar]').addEventListener('click', () => {
      ok = true;
      dlg.close();
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(ok);
    });
    dlg.showModal();
  });
}
