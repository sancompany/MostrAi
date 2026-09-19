const fmt = fmtBRL; // config.js

let ANUNCIANTE = null;
let ANUNCIANTE_ID = null;

// As duas portas de quem não tem arte. Não há o que construir aqui além do
// caminho certo pra fora: a peça é feita fora do site, e a gravação é
// serviço de terceiro com preço caso a caso — as duas coisas se resolvem
// conversando. A mensagem já vai com o nome da empresa pra conversa não
// começar com "oi".
function montarPortasDeArte() {
  if (!window.linkWhatsApp) return;
  const nome = ANUNCIANTE?.nome_empresa || 'anunciante';
  const simples = document.getElementById('linkArteSimples');
  const gravacao = document.getElementById('linkGravacao');
  if (simples) {
    simples.href = window.linkWhatsApp(
      `Olá! Sou ${nome}, do Mostraí, e quero pedir o anúncio simples que vem no meu plano.`,
    );
  }
  if (gravacao) {
    gravacao.href = window.linkWhatsApp(
      `Olá! Sou ${nome}, do Mostraí, e quero orçar a gravação de um vídeo para o meu anúncio.`,
    );
  }
}

async function carregar() {
  const r = await fetch(`${API_BASE_URL}/anunciantes/me`, { credentials: 'include' });
  if (r.status === 401) {
    window.location.href = '/anunciante/login.html';
    return;
  }
  // Sem isso, um 500 caía no .json(), ANUNCIANTE_ID virava undefined e o
  // painel montava vazio e funcional — o cliente via "0 exibições" em vez
  // de "não deu pra carregar".
  if (!r.ok) throw new Error();
  ANUNCIANTE = await r.json();
  ANUNCIANTE_ID = ANUNCIANTE.id;
  // Popup de perfil, avatar e sair vêm de /perfil.js — a mesma tela que o
  // painel do ponto usa, em vez de duas cópias que divergem.
  montarPerfil(ANUNCIANTE, (nova) => {
    ANUNCIANTE = nova;
    preencherStatusBanner();
  });
  montarPortasDeArte();

  // Painel único (modos.js): sem o papel "anunciante" o dashboard dá
  // lugar ao card de ativação. Com o papel, segue o fluxo normal.
  const estado = await montarModo('anunciante', document.getElementById('dashboardAnuncios'), async (estado) => {
    preencherStatusBanner();
    document.getElementById('bonusAnuncios').innerHTML = cardBonus(estado, 'ponto');
    // Sem plano ainda, a tela inteira (KPIs, gráficos e o upload de
    // criativo) fica bloqueada — pedido do dono, 19/09/2026. Antes dava
    // pra subir 1 criativo mesmo sem plano "pra não travar o meio do
    // cadastro"; a decisão virou o contrário: trava, com aviso pra
    // escolher plano (o back também passou a recusar isso, defesa em
    // profundidade — ver POST /anunciantes/:id/criativos).
    if (!ANUNCIANTE.plano_id) {
      montarBloqueioPlano();
      return;
    }
    carregarExibicoes();
    carregarCriativos();
    carregarKpiPontos();
    carregarBancoHoras();
  });
  if (estado && !estado.modos.anunciante.liberado) {
    document.getElementById('statusBanner').innerHTML =
      `<span><strong>${esc(ANUNCIANTE.nome_empresa)}</strong> · modo anúncios ainda não ativado</span>`;
    // Veio da vitrine querendo um plano: guarda pra depois de ativar.
    const planoUrl = new URLSearchParams(window.location.search).get('plano');
    if (planoUrl) history.replaceState(null, '', `/anunciante/painel.html?plano=${encodeURIComponent(planoUrl)}`);
  }
}

// Mesmo padrão de public/modos.js (window.montarModo): esconde o container
// de verdade e insere um card no lugar dele, um nível abaixo do bloqueio de
// papel — aqui o papel "anunciante" já está liberado, só falta plano.
function montarBloqueioPlano() {
  const container = document.getElementById('dashboardAnuncios');
  container.hidden = true;
  const caixa = document.createElement('div');
  caixa.className = 'wrap';
  caixa.innerHTML = ANUNCIANTE.suspenso
    ? `<div class="card wide modo-card u-ta-c" id="bloqueioPlano">
        <p class="eyebrow">Seu painel</p>
        <h3>Conta suspensa</h3>
        <p class="form-hint u-m-0">Veja a explicação ali em cima. Seus números voltam a aparecer aqui assim que a conta for reativada.</p>
      </div>`
    : `<div class="card wide modo-card u-ta-c" id="bloqueioPlano">
        <p class="eyebrow">Seu painel</p>
        <h3>Escolha um plano pra ver seus números</h3>
        <p class="form-hint u-m-0 u-mb-8">Ative um plano e comece a anunciar agora mesmo.</p>
        <a class="btn primary" href="/planos.html">Escolher plano</a>
      </div>`;
  container.parentNode.insertBefore(caixa, container);
}

function preencherStatusBanner() {
  // Duração máxima da peça é benefício do plano (17/09/2026): o texto genérico
  // do HTML vira o número exato assim que sabemos em qual plano a conta está.
  const dicaDuracao = document.querySelector('[data-limite-duracao]');
  if (dicaDuracao && ANUNCIANTE.plano?.duracao_maxima_segundos) {
    dicaDuracao.textContent = `de até ${ANUNCIANTE.plano.duracao_maxima_segundos} segundos (o que o seu plano permite)`;
  }

  const el = document.getElementById('statusBanner');
  // `status` virou só comum/parceiro (16/09/2026) — "Comum" não é
  // informação nova pro cliente, então só aparece pra quem é parceiro.
  const statusTxt = ANUNCIANTE.status === 'parceiro' ? ROTULOS.anunciante.parceiro : null;
  let planoTxt = 'Sem plano ainda';
  if (ANUNCIANTE.plano_id) {
    // Cortesia chegava no navegador e nao aparecia em tela nenhuma do cliente:
    // quem ganhou o plano (bonus de ponto ou liberacao do dono) via "Plano
    // ativo" igualzinho a quem paga, e nao sabia que nao havia cobranca — nem
    // que a data de expiracao nao vai renovar sozinha.
    planoTxt = ANUNCIANTE.plano_cortesia ? 'Plano de cortesia' : 'Plano ativo';
    if (ANUNCIANTE.data_expiracao) planoTxt += ` até ${window.dataBR(ANUNCIANTE.data_expiracao)}`;
    if (ANUNCIANTE.plano_cortesia) planoTxt += ' · sem cobrança';
  }

  // Só um estado derruba o botão: `suspenso` (campo próprio desde
  // 16/09/2026, separado de `status`). POST /anunciantes/:id/assinar recusa
  // com 403 (financeiro/routes.js) quando suspenso. O botão levava pra
  // vitrine e a assinatura estourava lá na frente, sem dizer por quê. Quem
  // pediu devolução cai exatamente aqui, porque o arrependimento zera o
  // plano e suspende a conta.
  const explicacao = ANUNCIANTE.suspenso
    ? 'Sua conta está suspensa, e o anúncio não está no ar. Se você pediu devolução, o pedido está em andamento; ' +
      'se foi falta de pagamento, a conta volta assim que a cobrança for confirmada. <a href="/contato.html">Fale com a gente</a>.'
    : null;
  const podeAssinar = !ANUNCIANTE.plano_id && !ANUNCIANTE.suspenso;
  el.innerHTML = `
    <span><strong>${esc(ANUNCIANTE.nome_empresa)}</strong>${statusTxt ? ` · ${statusTxt}` : ''} · ${planoTxt}</span>
    ${explicacao ? `<span class="dash-explica">${explicacao}</span>` : ''}
    ${podeAssinar ? '<a class="btn primary" href="/planos.html">Escolher plano</a>' : ''}
  `;
  preencherAssinatura();
  carregarPontos();
}

// Autoatendimento: cancelar e trocar de plano, sem passar pelo admin.
// Só aparece pra quem tem plano pago em dia (cortesia não tem o que
// cancelar, e conta suspensa já mostra a explicação própria acima).
// ---------------------------------------------------------------------------
// Onde seu anúncio aparece — escolha de pontos (17/09/2026)
// ---------------------------------------------------------------------------
// O plano dá acesso a N pontos. Marcar é opcional: quem não marca recebe uma
// fatia sorteada de forma estável, e isso é dito na tela em vez de ficar
// implícito — senão "não marquei nada" parece "não vou aparecer em lugar
// nenhum", que é o contrário do que acontece.
// RN-49 — o bônus de cobertura, em HORAS POR MÊS (pedido do dono, 17/09/2026).
//
// Segundos por hora é a unidade do motor, não a do cliente: ele comprou horas
// de tela por mês, é assim que o card vende, e trocar de unidade no meio do
// caminho obriga ele a multiplicar por 12 e por 30 pra saber se ganhou algo.
// Aqui só aparece a unidade que ele já conhece.
//
// Dois números e não um: quantas horas a rede de hoje daria SEM a regra, e
// quantas ela dá com ela. Sem o primeiro, "você ganhou N horas" não tem em
// relação a quê — e é justamente o que dá pra conferir.
function pintarCompensacao(c) {
  const el = document.getElementById('avisoCompensacao');
  if (!el) return;
  if (!c?.compensando) {
    el.hidden = true;
    return;
  }
  const ganho = c.horas_hoje - c.horas_sem_compensacao;
  const faltam = c.contratados - c.veiculando;
  const h = (n) => `${n} ${n === 1 ? 'hora' : 'horas'}`;
  el.innerHTML =
    `<b>A rede ainda é menor que o seu plano, e você não perde por isso.</b> ` +
    `Seu plano cobre ${c.contratados} pontos e ${c.veiculando} ${c.veiculando === 1 ? 'está' : 'estão'} veiculando hoje. ` +
    `O tempo ${faltam === 1 ? 'do ponto que falta' : `dos ${faltam} pontos que faltam`} volta pros que estão no ar: ` +
    `em vez das ${h(c.horas_sem_compensacao)} de tela por mês que a rede de hoje daria, você tem ` +
    `<b>${h(c.horas_hoje)} de tela por mês</b> — <b>${h(ganho)} a mais</b>, sem pagar nada além do plano. ` +
    `Conforme os pontos entrarem no ar, o tempo se espalha de volta e você chega nas ` +
    `${h(c.horas_contratadas)} por mês que contratou.`;
  el.hidden = false;
}

async function carregarPontos() {
  if (!ANUNCIANTE.plano_id || ANUNCIANTE.plano_cortesia) return;
  let dados;
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/me/pontos-disponiveis`, { credentials: 'include' });
    if (!r.ok) return;
    dados = await r.json();
  } catch {
    return;
  }
  if (!dados.pontos.length) return;

  const limite = dados.limite;
  document.getElementById('painelPontos').hidden = false;
  document.getElementById('dicaPontos').textContent = limite
    ? `Seu plano cobre ${limite} ${limite === 1 ? 'ponto' : 'pontos'}. Marque onde você quer aparecer, ou deixe tudo desmarcado e a gente distribui pra você. Ponto em instalação pode ser marcado: a vaga fica sua.`
    : 'Seu plano cobre todos os pontos da rede.';
  pintarCompensacao(dados.cobertura);

  const lista = document.getElementById('listaPontos');
  lista.innerHTML = dados.pontos
    .map((p) => {
      const instalando = p.status === 'a_instalar';
      // Ponto em instalação nunca está "cheio": ele não vendeu hora nenhuma
      // ainda. Bloquear ele por ocupação seria bloquear por um zero que
      // significa "ainda não existe", não "tem espaço de sobra".
      const cheio = !instalando && p.ocupacao >= 100;
      return `<label class="ponto-escolha${cheio ? ' cheio' : ''}">
      <input type="checkbox" value="${p.id}" ${p.escolhido ? 'checked' : ''} ${cheio && !p.escolhido ? 'disabled' : ''}>
      <span class="ponto-nome">${esc(p.nome)}</span>
      <span class="ponto-end">${esc(p.endereco || '')}${p.cidade ? `, ${esc(p.cidade)}` : ''}</span>
      <span class="ponto-ocupacao">${instalando ? 'Em instalação' : cheio ? 'Sem espaço agora' : `${p.ocupacao}% vendido`}</span>
    </label>`;
    })
    .join('');

  const msg = document.getElementById('msgPontos');
  const contador = document.getElementById('contadorPontos');
  const marcados = () => [...lista.querySelectorAll('input:checked')].map((i) => Number(i.value));

  function pintarContador() {
    const n = marcados().length;
    contador.textContent = limite ? `${n} de ${limite}` : `${n} escolhido(s)`;
    // Passar do limite não é erro de servidor: é uma caixa que não devia ter
    // deixado marcar. Desligar as outras é mais honesto que aceitar e recusar
    // depois do clique em salvar.
    if (limite) {
      lista.querySelectorAll('input:not(:checked)').forEach((i) => {
        if (!i.closest('.ponto-escolha').classList.contains('cheio')) i.disabled = n >= limite;
      });
    }
  }
  pintarContador();

  lista.addEventListener('change', async (e) => {
    if (e.target.tagName !== 'INPUT') return;
    pintarContador();
    msg.textContent = 'Salvando...';
    msg.className = 'form-msg';
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/pontos`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pontos: marcados() }),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.textContent = window.frase(corpo.erro || 'não deu pra salvar');
        msg.className = 'form-msg err';
        return;
      }
      msg.textContent = marcados().length
        ? 'Pronto. A mudança vale a partir da próxima hora cheia.'
        : 'Pronto. Sem marcação, a gente distribui seus pontos.';
      msg.className = 'form-msg ok';
    } catch {
      msg.textContent = 'Sem conexão. Tente de novo.';
      msg.className = 'form-msg err';
    }
  });
}

function preencherAssinatura() {
  const panel = document.getElementById('painelAssinatura');
  const el = document.getElementById('resumoAssinatura');
  const ativo =
    ANUNCIANTE.plano_id &&
    !ANUNCIANTE.plano_cortesia &&
    !ANUNCIANTE.suspenso &&
    ANUNCIANTE.data_expiracao &&
    new Date(ANUNCIANTE.data_expiracao) > new Date();
  if (!ativo) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const preco = '';
  el.innerHTML = `
    <p class="u-m-0 u-mb-4">Ativa até <b>${window.dataBR(ANUNCIANTE.data_expiracao)}</b>${preco}.</p>
    <p class="form-hint u-m-0 u-mb-12">Cancelar não devolve o que já foi pago. O período atual continua no ar até essa data, e não renova depois.</p>
    <div class="field-row">
      <a class="btn ghost" href="/planos.html">Trocar de plano</a>
      <button class="btn ghost" id="btnCancelarAssinatura">Cancelar assinatura</button>
    </div>
    <p class="form-msg" id="msgCancelarAssinatura"></p>
  `;
  document.getElementById('btnCancelarAssinatura').addEventListener('click', cancelarAssinatura);
}

async function cancelarAssinatura() {
  if (
    !window.confirm(
      'Cancelar sua assinatura? O período que você já pagou continua no ar até o fim. Depois disso, não há nova cobrança nem novo anúncio no ar.',
    )
  )
    return;
  const btn = document.getElementById('btnCancelarAssinatura');
  const msg = document.getElementById('msgCancelarAssinatura');
  btn.disabled = true;
  const r = await fetch(`${API_BASE_URL}/anunciantes/me/cancelar-assinatura`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!r.ok) {
    msg.textContent = (await r.json().catch(() => ({}))).erro || 'Não foi possível cancelar agora.';
    msg.className = 'form-msg err';
    btn.disabled = false;
    return;
  }
  msg.textContent = 'Assinatura cancelada. A cobertura continua até o fim do período já pago.';
  msg.className = 'form-msg ok';
  btn.remove();
}

// Ponto usa a mesma conta de anunciante (ver migration 016) — o card só
// mostra a contagem e manda pro dashboard próprio do ponto; sem ponto
// ainda, manda pro cadastro. Nada disso mora mais no menu do topo.
async function carregarKpiPontos() {
  const el = document.getElementById('kpiPontos');
  // v2.1: sem o papel "ponto", o atalho leva ao modo "Meu ponto" (card
  // de ativação); com o papel, mostra a contagem.
  if (!(ANUNCIANTE.papeis || []).includes('ponto')) {
    el.innerHTML = `<span class="kpi-label">Meus pontos</span><b>0</b><a class="link-secundario" href="/anunciante/ponto.html">Quero uma tela no meu comércio</a>`;
    return;
  }
  try {
    const pontos = await (
      await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/pontos`, { credentials: 'include' })
    ).json();
    el.innerHTML = `<span class="kpi-label">Meus pontos</span><b>${pontos.length}</b><a class="link-secundario" href="/anunciante/ponto.html">Ver meu ponto →</a>`;
  } catch {
    el.innerHTML = '<span class="kpi-label">Meus pontos</span><b>-</b>';
  }
}

// O link do comprovante carrega o período escolhido, como a referência de
// mercado faz: exportação respeita o mesmo recorte que está na tela.
//
// O href se monta no CLIQUE, nao no carregamento: este bloco roda antes de
// `carregarConta()` resolver, entao `ANUNCIANTE_ID` ainda e null e o link
// nascia apontando pra /anunciantes/null/exibicoes.csv. Quem clicasse sem
// antes mexer no seletor de periodo baixava um erro.
(function comprovante() {
  const sel = document.getElementById('periodoComprovante');
  const link = document.getElementById('btnComprovante');
  if (!sel || !link) return;
  const montar = () => `${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/exibicoes.csv?dias=${sel.value}`;
  const atualizar = () => {
    if (ANUNCIANTE_ID) link.href = montar();
  };
  sel.addEventListener('change', atualizar);
  link.addEventListener('click', (e) => {
    if (!ANUNCIANTE_ID) {
      e.preventDefault();
      return;
    }
    link.href = montar();
  });
  atualizar();
})();

// Segundos em tempo legível, na maior unidade que ainda cabe: só segundos
// enquanto < 60, minutos enquanto < 60min, senão horas. Pedido do dono
// (18/09/2026) — "N exibições" sozinho não diz o tamanho da prioridade;
// tempo diz. Sempre com 1 casa nas unidades maiores, pra não sumir com o
// resto (ex.: 90s → "1,5min", não "2min" arredondado feito outra coisa).
function duracaoLegivel(segundos) {
  if (segundos < 60) return `${Math.round(segundos)}s`;
  const minutos = segundos / 60;
  if (minutos < 60) return `${(Math.round(minutos * 10) / 10).toLocaleString('pt-BR')}min`;
  return `${(Math.round((minutos / 60) * 10) / 10).toLocaleString('pt-BR')}h`;
}

// Dashboard de exibições — leitura agregada de GET /anunciantes/:id/exibicoes
// (transparência de entrega: programado vs. confirmado, custo por exibição).
// Banco de horas (G.3): só aparece pra quem tem saldo — conta sem déficit
// não precisa saber que esse mecanismo existe. `catch` silencioso de
// propósito: é um aviso extra, não um número que o cliente precisa pra
// decidir algo, e um painel que já carregou tudo (exibições, criativos)
// não deveria mostrar erro por causa deste card.
//
// O tempo (`dados.segundos`) é ilustrativo — exibições × duração ATUAL da
// peça (RN-53), não um histórico exato — por isso o número exato de
// exibições fica do lado, entre parênteses: quem quiser conferir a conta
// tem o dado que a apuração realmente usa.
async function carregarBancoHoras() {
  try {
    const dados = await (await fetch(`${API_BASE_URL}/anunciantes/me/banco-horas`, { credentials: 'include' })).json();
    if (!dados.saldo) return;
    // Virou card no grid (19/09/2026, pedido do dono) — antes era só uma
    // frase colada no banner, fácil de não notar entre os outros avisos.
    document.getElementById('kpiGrid').insertAdjacentHTML(
      'beforeend',
      `<div class="kpi-card">
        <span class="kpi-label">Banco de horas</span>
        <b>${duracaoLegivel(dados.segundos)}</b>
        <span class="badge badge-pendente">${dados.saldo} exibições · prioridade nos próximos dias</span>
      </div>`,
    );
  } catch {
    /* aviso extra — sem ele, o painel continua completo */
  }
}

// Horas contratadas x entregues no mês corrente (19/09/2026, pedido do
// dono) — mesma barrinha de progresso do gráfico por ponto (.track/.fill),
// sem componente novo. Só aparece com plano (os dois vêm null sem plano, e
// nem deveria chegar até aqui: o bloqueio de plano já barra essa chamada).
function desenharHorasMes(contratadas, entregues) {
  if (contratadas == null) return;
  const restantes = Math.max(0, contratadas - entregues);
  const pct = contratadas > 0 ? Math.min(100, (entregues / contratadas) * 100) : 0;
  document.getElementById('kpiGrid').insertAdjacentHTML(
    'beforeend',
    `<div class="kpi-card">
      <span class="kpi-label">Horas entregues no mês</span>
      <b>${entregues}h</b>
      <span class="kpi-caption">de ${contratadas}h contratadas · ${restantes}h ainda por rodar</span>
      <span class="track u-mt-6"><span class="fill" data-pct="${pct}"></span></span>
    </div>`,
  );
}

async function carregarExibicoes() {
  try {
    const dados = await (
      await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/exibicoes`, { credentials: 'include' })
    ).json();
    const kpi = (nome) => document.querySelector(`#kpiGrid [data-kpi="${nome}"] b`);
    const entrega =
      dados.totalProgramadas > 0 ? Math.round((dados.totalConfirmadas / dados.totalProgramadas) * 100) : 0;
    kpi('confirmadas').textContent = dados.totalConfirmadas;
    kpi('entrega').textContent = dados.totalProgramadas ? `${entrega}%` : '-';
    kpi('custo').textContent = dados.custoPorExibicao ? fmt(dados.custoPorExibicao) : '-';

    desenharPorDia(dados.porDia || []);
    desenharPorPonto(dados.porPonto || []);
    desenharCobrancas(dados.cobrancas || []);
    desenharHorasMes(dados.horasContratadasMes, dados.horasEntreguesMes);
    explicarZero(dados);
  } catch {
    // Antes o catch era vazio: falha de API e conta nova produziam a mesma
    // tela de "—", e quem paga não conseguia distinguir "meu anúncio não
    // rodou" de "o painel quebrou".
    document
      .getElementById('statusBanner')
      .insertAdjacentHTML(
        'beforeend',
        '<p class="form-msg err">Não foi possível carregar seus números agora. Tente atualizar a página.</p>',
      );
  }
}

// Conta nova enxerga a mesma tela de uma conta que parou de rodar: tudo zero,
// tres traços e nenhum grafico. Sem uma linha dizendo em que etapa a conta
// esta, quem acabou de pagar conclui que comprou algo que nao funciona.
//
// Não trata mais "sem plano" aqui — desde o bloqueio de plano (19/09/2026),
// essa função só roda com plano garantido (ver montarBloqueioPlano/carregar).
function explicarZero(dados) {
  const el = document.getElementById('exibicoesVazio');
  if (!el) return;
  if (dados.totalProgramadas > 0 || dados.totalConfirmadas > 0) {
    el.hidden = true;
    return;
  }
  const criativoNoAr = (dados.criativosAprovados || 0) > 0;
  el.innerHTML = criativoNoAr
    ? '<b>Seu anúncio já está aprovado e entra no rodízio das telas.</b> A primeira contagem aparece aqui na próxima hora cheia. Cada exibição é confirmada pela própria tela, e é isso que você vê neste painel.'
    : '<b>Falta o seu vídeo.</b> Suba a peça aqui embaixo: a gente confere (normalmente no mesmo dia útil) e, aprovada, ela entra no rodízio. Os números começam a aparecer logo depois.';
  el.hidden = false;
}

// Barras verticais dos últimos 14 dias. O endpoint devolve DESC (mais novo
// primeiro) e só os dias com registro — inverte e mostra como vem, sem
// preencher buraco de dia sem exibição.
function desenharPorDia(porDia) {
  if (!porDia.length) return;
  const dias = porDia.slice(0, 14).reverse();
  const max = Math.max(...dias.map((d) => Number(d.confirmadas))) || 1;
  document.getElementById('painelDia').hidden = false;
  document.getElementById('graficoDia').innerHTML = dias
    .map((d) => {
      const v = Number(d.confirmadas);
      // `dia` vem do servidor como dia de calendário puro ('2026-09-16'), sem
      // hora e sem fuso. `new Date('2026-09-16')` lê isso como meia-noite UTC
      // e `getDate()` devolve 15 pra quem está no Brasil — a barra ficava com
      // o rótulo do dia anterior. Fatiar a string não passa por fuso nenhum,
      // que é o certo pra uma data que não tem fuso.
      const [ano, mes, diaDoMes] = String(d.dia).slice(0, 10).split('-');
      return `<div class="bar-col" title="${diaDoMes}/${mes}/${ano}: ${v} exibições">
      <div class="bar" data-pct="${Math.max(2, (v / max) * 100)}"></div>
      <span class="bar-label">${diaDoMes}/${mes}</span>
    </div>`;
    })
    .join('');
  document.getElementById('legendaDia').textContent = `últimos ${dias.length} dias com exibição`;

  // Delta 7 dias x 7 anteriores — no card de confirmadas.
  const soma = (arr) => arr.reduce((t, d) => t + Number(d.confirmadas), 0);
  const atual = soma(porDia.slice(0, 7));
  const anterior = soma(porDia.slice(7, 14));
  const el = document.querySelector('#kpiGrid [data-delta]');
  if (!anterior) return;
  const pct = Math.round(((atual - anterior) / anterior) * 100);
  el.textContent = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs. 7 dias antes`;
  el.className = `delta ${pct >= 0 ? 'up' : 'down'}`;
}

// Top 8: já vem ORDER BY confirmadas DESC do servidor — uma rede com muitos
// pontos virava uma lista de barra alta e ilegível. O resto continua na
// tabela detalhada logo abaixo, completa, sem corte nenhum.
const TOP_PONTOS_GRAFICO = 8;
function desenharPorPonto(porPonto) {
  if (!porPonto.length) return;
  const max = Math.max(...porPonto.map((p) => Number(p.confirmadas))) || 1;
  const total = porPonto.reduce((soma, p) => soma + Number(p.confirmadas), 0) || 1;
  const principais = porPonto.slice(0, TOP_PONTOS_GRAFICO);
  const resto = porPonto.length - principais.length;
  document.getElementById('painelDetalhe').hidden = false;
  document.getElementById('graficoPonto').innerHTML =
    principais
      .map((p) => {
        const v = Number(p.confirmadas);
        const pct = Math.round((v / total) * 100);
        return `
    <div class="row">
      <span class="nome" title="${esc(p.nome)}">${esc(p.nome)}</span>
      <span class="track"><span class="fill" data-pct="${(v / max) * 100}"></span></span>
      <span class="valor">${v} <span class="u-dim">(${pct}%)</span></span>
    </div>`;
      })
      .join('') +
    (resto > 0
      ? `<p class="form-hint u-m-0 u-mt-8">+${resto} outro${resto === 1 ? '' : 's'} ponto${resto === 1 ? '' : 's'} na tabela abaixo.</p>`
      : '');
  document.getElementById('exibicoesDetalhe').innerHTML =
    `<div class="u-ox-auto"><table class="mini-table"><thead><tr><th>Ponto</th><th>Cidade</th><th>Programadas</th><th>Confirmadas</th><th>Entrega</th></tr></thead><tbody>
    ${porPonto
      .map((p) => {
        const prog = Number(p.programadas) || 0;
        const conf = Number(p.confirmadas) || 0;
        return `<tr><td>${esc(p.nome)}</td><td>${esc(p.cidade)}</td><td>${prog}</td><td>${conf}</td><td>${prog ? Math.round((conf / prog) * 100) + '%' : '-'}</td></tr>`;
      })
      .join('')}
  </tbody></table></div>`;
}

// Cobranças já vêm no mesmo endpoint e não eram mostradas em lugar nenhum.
function desenharCobrancas(cobrancas) {
  if (!cobrancas.length) return;
  document.getElementById('painelCobrancas').hidden = false;
  document.getElementById('listaCobrancas').innerHTML =
    `<div class="u-ox-auto"><table class="mini-table"><thead><tr><th>Data</th><th>Valor</th><th>Nota fiscal</th></tr></thead><tbody>
    ${cobrancas
      .map(
        (c) => `<tr>
      <td>${new Date(c.criado_em).toLocaleDateString('pt-BR')}</td>
      <td>${fmt(c.valor)}</td>
      <td>${c.nota_fiscal_url ? `<a href="${esc(c.nota_fiscal_url)}" target="_blank" rel="noopener">Baixar</a>` : esc(c.nota_fiscal_status || '-')}</td>
    </tr>`,
      )
      .join('')}
  </tbody></table></div>`;
}

function ehVideo(url) {
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url || '');
}

async function carregarCriativos() {
  const el = document.getElementById('listaCriativos');
  try {
    const criativos = await (
      await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/criativos`, { credentials: 'include' })
    ).json();
    const ativos = criativos.filter((c) => c.status !== 'reprovado').length;
    document.querySelector('#kpiGrid [data-kpi="criativos"] b').textContent = ativos;
    el.innerHTML = criativos.length
      ? `<div class="criativos-lista">
      ${criativos
        .map((c) => {
          const video = c.arquivo_normalizado_url && ehVideo(c.arquivo_normalizado_url);
          return `<div class="criativo-card" data-id="${c.id}">
          ${
            c.arquivo_normalizado_url
              ? video
                ? `<video src="${esc(c.arquivo_normalizado_url)}" muted loop playsinline poster="${esc(c.thumbnail_url || '')}"></video>
                 <button type="button" class="criativo-play" aria-label="Reproduzir"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></button>`
                : `<img src="${esc(c.arquivo_normalizado_url)}" alt="">`
              : '<div class="criativo-placeholder">processando...</div>'
          }
          <button type="button" class="criativo-excluir" aria-label="Excluir criativo">&times;</button>
          <span class="badge ${ROTULOS.criativoClasse[c.status]}">${ROTULOS.criativo[c.status]}</span>
          ${c.status === 'reprovado' ? `<p class="criativo-motivo">${c.motivo_reprovacao ? esc(c.motivo_reprovacao) : 'Fale com a gente pra entender o que ajustar.'}<br><b>Exclua esta peça e suba a versão corrigida.</b></p>` : ''}
        </div>`;
        })
        .join('')}
    </div>`
      : '<p class="empty-state">Nenhum criativo enviado ainda.</p>';
  } catch (err) {
    // O `catch` mudo daqui escondeu por semanas um ReferenceError
    // (`CRIATIVO_ROTULOS`, mapa que foi renomeado e ficou uma chamada pra
    // trás): todo anunciante COM criativo via "não foi possível carregar" e
    // ninguém sabia por quê, porque a mensagem culpava a rede e a rede estava
    // boa. Erro de programação tem que aparecer no console.
    console.error('falha ao montar a lista de criativos', err);
    el.innerHTML = '<p class="form-msg err">Não foi possível carregar seus criativos agora.</p>';
  }
}

// Play/excluir por delegação — a lista é re-renderizada a cada carregamento,
// então não dá pra prender listener em cada card.
document.getElementById('listaCriativos').addEventListener('click', async (e) => {
  const card = e.target.closest('.criativo-card');
  if (!card) return;

  if (e.target.closest('.criativo-play')) {
    const video = card.querySelector('video');
    video.play();
    card.classList.add('tocando');
    video.addEventListener('pause', () => card.classList.remove('tocando'), { once: true });
    return;
  }
  if (e.target.closest('video')) {
    const video = card.querySelector('video');
    video.pause();
    card.classList.remove('tocando');
    return;
  }
  if (e.target.closest('.criativo-excluir')) {
    if (!confirm('Excluir este criativo? Pra trocar por outro, é só enviar um novo depois.')) return;
    const r = await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/criativos/${card.dataset.id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    const msg = document.getElementById('uploadMsg');
    if (r.ok) {
      msg.textContent = 'Criativo excluído.';
      msg.className = 'form-msg ok';
      carregarCriativos();
    } else {
      msg.textContent = 'Não foi possível excluir agora. Tente de novo.';
      msg.className = 'form-msg err';
    }
  }
});

// Um controle só: escolher o arquivo já envia — sem botão "Enviar" à parte.
document.getElementById('arquivoCriativo').addEventListener('change', async (e) => {
  const input = e.target;
  const msg = document.getElementById('uploadMsg');
  if (!input.files[0]) return;

  msg.textContent = 'Enviando e processando o vídeo, pode levar um minuto...';
  msg.className = 'form-msg';
  // Sem travar o input, escolher outro arquivo durante o envio disparava
  // um segundo POST concorrente e duas listas fora de ordem.
  input.disabled = true;
  const form = new FormData();
  form.append('arquivo', input.files[0]);

  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/criativos`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || '');
    msg.textContent = 'Criativo enviado! Ele entra em análise antes de ir pro ar.';
    msg.className = 'form-msg ok';
    input.value = '';
    carregarCriativos();
  } catch (err) {
    msg.textContent = err.message
      ? window.frase(err.message)
      : 'Não foi possível enviar o criativo agora. Tente de novo.';
    msg.className = 'form-msg err';
  } finally {
    input.disabled = false;
  }
});

carregar().catch(() => {
  document.getElementById('statusBanner').textContent = 'Não foi possível carregar sua conta agora.';
});
