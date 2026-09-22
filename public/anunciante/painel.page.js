const fmt = fmtBRL; // config.js

let ANUNCIANTE = null;
let ANUNCIANTE_ID = null;

// Porta única pra quem não tem arte (19/09/2026, pedido do dono — antes eram
// dois links, arte simples incluída no plano e vídeo gravado à parte; virou
// um botão só, "Quero um anúncio", e a escolha entre os dois vira conversa
// no WhatsApp, não duas opções na tela). A mensagem já vai com o nome da
// empresa pra conversa não começar com "oi".
function montarPortasDeArte() {
  if (!window.linkWhatsApp) return;
  const nome = ANUNCIANTE?.nome_empresa || 'anunciante';
  const link = document.getElementById('linkArteSimples');
  if (link) link.href = window.linkWhatsApp(`Olá! Sou ${nome}, do Mostraí, e quero um anúncio pra minha conta.`);
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
    carregarBancoHoras();
  });
  montarCardPonto(estado);
  montarLinkVendedor(estado);
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

// "Vendas" saiu do topo (19/09/2026): quem já tem o papel vendedor perdia
// todo caminho até o próprio painel de vendas sem essa linha — a página
// continua existindo, só não tem mais aba.
function montarLinkVendedor(estado) {
  const caixa = document.getElementById('linkVendedor');
  if (!caixa || !estado?.papeis?.includes('vendedor')) return;
  caixa.innerHTML = `<p class="form-hint u-m-0"><a href="/anunciante/vendedor.html">Ver meu painel de vendas →</a></p>`;
}

// Candidatura a ponto, migrada pro fim do Painel (19/09/2026, pedido do
// dono: "todas informações restantes já foram pegas" — nome, endereço,
// cidade, UF e CEP já estão na própria conta, então o card pede só o que é
// exclusivo do ponto). Bem mais simples que o formulário completo em
// modos.js (CARDS.ponto, ainda usado por /anunciante/ponto.html): sem
// escolha de comodato aqui — quem se candidata combina isso no WhatsApp.
// Horário de funcionamento do ponto (pedido do dono, 22/09/2026) — mesmo
// padrão de 3 grupos de public/modos.js (sem módulo compartilhado entre os
// dois arquivos, por convenção do projeto).
const GRUPOS_HORARIO = [
  { id: 'semana', rotulo: 'Segunda a sexta', fechadoPadrao: false },
  { id: 'sab', rotulo: 'Sábado', fechadoPadrao: false },
  { id: 'dom', rotulo: 'Domingo', fechadoPadrao: true },
];

const CAMPO_HORARIO_SEMANAL = () => `
  <p class="form-sep-titulo u-mt-8">Horário de funcionamento</p>
  ${GRUPOS_HORARIO.map(
    (g) => `
    <div class="field-row u-ai-c" data-horario-grupo="${g.id}">
      <div class="u-col-2"><b>${g.rotulo}</b></div>
      <div class="u-col"><label class="check-row"><input type="checkbox" data-horario-fechado ${g.fechadoPadrao ? 'checked' : ''}><span>Fechado</span></label></div>
      <div class="u-col field-row" data-horario-campos ${g.fechadoPadrao ? 'hidden' : ''}>
        <div class="u-col"><label>Abre</label><input type="time" data-horario-abre value="09:00"></div>
        <div class="u-col"><label>Fecha</label><input type="time" data-horario-fecha value="${g.id === 'sab' ? '15:00' : '18:00'}"></div>
      </div>
    </div>`,
  ).join('')}`;

function ligarHorarioSemanal(form) {
  form.querySelectorAll('[data-horario-grupo]').forEach((grupo) => {
    const chk = grupo.querySelector('[data-horario-fechado]');
    const campos = grupo.querySelector('[data-horario-campos]');
    chk.addEventListener('change', () => {
      campos.hidden = chk.checked;
    });
  });
}

function lerHorarioSemanalDoForm(form) {
  const porGrupo = {};
  form.querySelectorAll('[data-horario-grupo]').forEach((grupo) => {
    const id = grupo.dataset.horarioGrupo;
    const fechado = grupo.querySelector('[data-horario-fechado]').checked;
    porGrupo[id] = fechado
      ? null
      : {
          abre: grupo.querySelector('[data-horario-abre]').value,
          fecha: grupo.querySelector('[data-horario-fecha]').value,
        };
  });
  const semana = porGrupo.semana;
  return { seg: semana, ter: semana, qua: semana, qui: semana, sex: semana, sab: porGrupo.sab, dom: porGrupo.dom };
}

function montarCardPonto(estado) {
  const caixa = document.getElementById('cardPonto');
  if (!caixa || !estado) return;

  if ((estado.papeis || []).includes('ponto')) {
    caixa.innerHTML = `
      <div class="card wide u-ta-c">
        <p class="form-hint u-m-0">Você já é um ponto da rede Mostraí. <a href="/anunciante/ponto.html">Ver o painel do meu ponto →</a></p>
      </div>`;
    return;
  }

  const pedido = estado.modos?.ponto?.pedido;
  if (pedido) {
    caixa.innerHTML = `
      <div class="card wide modo-card u-ta-c">
        <p class="eyebrow">Ser um ponto</p>
        <h3>Pedido enviado em ${new Date(pedido.criado_em).toLocaleDateString('pt-BR')}</h3>
        <p class="form-hint">A gente chama no WhatsApp pra combinar a visita e a instalação.</p>
      </div>`;
    return;
  }

  caixa.innerHTML = `
    <div class="card wide ponto-opportunity">
      <div class="ponto-opportunity-summary">
        <div class="ponto-opportunity-copy">
          <span class="ponto-opportunity-icon" aria-hidden="true">⌂</span>
          <div><p class="section-eyebrow">Faça parte da rede</p><h3>Você também possui um comércio?</h3><p class="form-hint">Transforme-o em um ponto Mostraí e ganhe uma tela.</p></div>
        </div>
        <button class="btn primary" type="button" id="btnAbrirCardPonto" aria-expanded="false">Quero ser um ponto</button>
      </div>
      <div class="ponto-opportunity-form" id="conteudoCardPonto" hidden>
        <form id="formCardPonto">
          <p class="form-hint u-m-0 u-mb-12">A tela, a instalação e o conteúdo são por nossa conta. Conte um pouco sobre o movimento do comércio e a gente chama no WhatsApp para combinar.</p>
          <div class="u-mb-12">
            <label for="cp_fluxo">Média de pessoas que passam por mês</label>
            <input id="cp_fluxo" name="fluxo_estimado_mensal" type="number" min="1" inputmode="numeric" required>
          </div>
          <div class="u-mb-12">
            <label for="cp_mensagem">Algo mais? (opcional)</label>
            <textarea id="cp_mensagem" name="mensagem" rows="2"></textarea>
          </div>
          ${CAMPO_HORARIO_SEMANAL()}
          <button class="btn primary" type="submit">Enviar meu interesse</button>
          <p class="form-msg" id="cardPontoMsg" role="status"></p>
        </form>
      </div>
    </div>`;

  ligarHorarioSemanal(document.getElementById('formCardPonto'));

  document.getElementById('btnAbrirCardPonto').addEventListener('click', (e) => {
    const conteudo = document.getElementById('conteudoCardPonto');
    conteudo.hidden = !conteudo.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!conteudo.hidden));
    e.currentTarget.textContent = conteudo.hidden ? 'Quero ser um ponto' : 'Fechar formulário';
  });

  document.getElementById('formCardPonto').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('cardPontoMsg');
    msg.textContent = 'Enviando...';
    msg.className = 'form-msg';
    try {
      const r = await fetch(`${API_BASE_URL}/conta/modos/ponto/pedir`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // O resto (nome, endereço, cidade, UF, CEP, ramo) já está na conta —
        // pedir de novo aqui seria retrabalho do que o cliente já preencheu.
        // `segmento` nem entra aqui: o backend resolve sozinho a partir do
        // ramo que a conta já informou pra poder anunciar (categoria_id ou
        // categoria_livre), então o front não precisa saber qual dos dois é.
        body: JSON.stringify({
          nome_comercio: ANUNCIANTE.nome_empresa,
          endereco: ANUNCIANTE.endereco,
          cidade: ANUNCIANTE.cidade,
          uf: ANUNCIANTE.uf,
          cep: ANUNCIANTE.cep,
          fluxo_estimado_mensal: Number(e.target.fluxo_estimado_mensal.value),
          mensagem: e.target.mensagem.value.trim() || null,
          horario_semanal: lerHorarioSemanalDoForm(e.target),
        }),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.textContent = corpo.erro || 'não deu pra enviar';
        msg.className = 'form-msg err';
        return;
      }
      msg.textContent = 'Pedido enviado, a gente chama no WhatsApp.';
      msg.className = 'form-msg ok';
      setTimeout(() => window.location.reload(), 900);
    } catch {
      msg.textContent = 'Sem conexão. Tente de novo.';
      msg.className = 'form-msg err';
    }
  });
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
  // Engrenagem "Gerenciar plano" (19/09/2026, pedido do dono): antes as
  // informações e ações de assinatura ficavam num card fixo no meio do
  // dashboard, ocupando espaço pra quem só queria ver os números. Agora é
  // um dialog, atrás de um botão nesta mesma linha — quem tem plano (mesmo
  // cortesia ou vencido) sempre pode abrir pra ver os detalhes.
  const podeGerenciar = !!ANUNCIANTE.plano_id;
  el.innerHTML = `
    <div class="hero-main">
      <div class="hero-copy">
        <p class="hero-kicker">Painel da campanha</p>
        <h1>Olá, ${esc(ANUNCIANTE.nome_empresa)}</h1>
        <p>Acompanhe a entrega do seu anúncio e a presença da sua marca na rede Mostraí.</p>
        <span class="hero-plan"><span class="hero-plan-dot"></span>${statusTxt ? `${statusTxt} · ` : ''}${planoTxt}</span>
        ${explicacao ? `<span class="dash-explica">${explicacao}</span>` : ''}
      </div>
      <div>
    ${podeAssinar ? '<a class="btn primary" href="/planos.html">Escolher plano</a>' : ''}
    ${
      podeGerenciar
        ? `<button type="button" class="btn-engrenagem" id="btnGerenciarPlano" aria-label="Gerenciar plano">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.05.3-.08.62-.08.94s.02.64.07.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.4.32.64.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.25.1.5.02.64-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.02-1.58ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg>
      Gerenciar plano
    </button>`
        : ''
    }
      </div>
    </div>
    <div class="hero-status" id="heroStatus" hidden></div>
  `;
  if (podeGerenciar) {
    preencherAssinatura();
    document.getElementById('btnGerenciarPlano').addEventListener('click', () => {
      document.getElementById('dlgPlano').showModal();
    });
  }
  const botaoSecundario = document.getElementById('btnGerenciarPlanoSecundario');
  if (botaoSecundario) {
    botaoSecundario.hidden = !podeGerenciar;
    if (podeGerenciar) botaoSecundario.onclick = () => document.getElementById('dlgPlano').showModal();
  }
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
    `<b>A rede Mostraí está crescendo</b> ` +
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
  const limite = dados.limite;
  document.getElementById('painelPontos').hidden = false;
  pintarCompensacao(dados.cobertura);

  const lista = document.getElementById('listaPontos');
  if (!dados.pontos.length) {
    lista.innerHTML =
      '<div class="empty-state dashboard-empty">A rede ainda não tem pontos disponíveis para seleção. Sua cobertura aparecerá aqui conforme eles entrarem no ar.</div>';
    return;
  }
  // Uma linha por ponto, sem o cartão grande de antes (19/09/2026, pedido
  // do dono: "se existir muitos pontos cadastrados ele se perde") — nome,
  // cidade e status cabem numa linha só; o link do mapa reaproveita a MESMA
  // busca do Google Maps que a vitrine pública já usa em pontos.page.js.
  lista.innerHTML = dados.pontos
    .map((p) => {
      const instalando = p.status === 'a_instalar';
      // Ponto em instalação nunca está "cheio": ele não vendeu hora nenhuma
      // ainda. Bloquear ele por ocupação seria bloquear por um zero que
      // significa "ainda não existe", não "tem espaço de sobra".
      const cheio = !instalando && p.ocupacao >= 100;
      const enderecoCompleto = `${p.endereco ? `${p.endereco}, ` : ''}${p.cidade || ''}`;
      const mapaUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(enderecoCompleto)}`;
      // <a> fica FORA do <label> de propósito: um link dentro de um label
      // ainda ativa o checkbox quando o clique borbulha até o label (é o
      // label que decide isso, não dá pra impedir com stopPropagation numa
      // camada acima). O <label> vira `display:contents` no CSS — some da
      // caixa, mas continua marcando/desmarcando o checkbox normalmente —
      // e os dois (label e link) viram irmãos dentro do mesmo grid da
      // linha, então o alinhamento continua igual.
      // Horário de funcionamento (22/09/2026, pedido do dono) vai no title
      // do nome — a linha já é enxuta de propósito (19/09/2026, "se existir
      // muitos pontos ele se perde"), sem espaço pra mais uma coluna visível;
      // hover/toque-e-segure mostra sem alargar nada. `null` (ponto antigo,
      // sem horário informado ainda) não aparece — mostrar "não informado"
      // por hover de todo ponto seria mais ruído que ajuda.
      const tituloNome = p.horario ? `${p.nome} · ${p.horario}` : p.nome;
      return `<div class="ponto-escolha${cheio ? ' cheio' : ''}" data-busca="${esc(`${p.nome} ${p.cidade || ''}`.toLowerCase())}">
      <label class="ponto-marcar">
        <input type="checkbox" value="${p.id}" ${p.escolhido ? 'checked' : ''} ${cheio && !p.escolhido ? 'disabled' : ''}>
        <span class="ponto-nome" title="${esc(tituloNome)}">${esc(p.nome)}</span>
        <span class="ponto-end" title="${esc(enderecoCompleto)}">${esc(p.cidade || '')}</span>
        <span class="ponto-ocupacao">${instalando ? 'Em instalação' : cheio ? 'Sem espaço agora' : `${p.ocupacao}% vendido`}</span>
      </label>
      <a class="ponto-mapa" href="${mapaUrl}" target="_blank" rel="noopener" title="Ver no mapa" aria-label="Ver ${esc(p.nome)} no mapa">📍</a>
    </div>`;
    })
    .join('');

  // Busca só aparece quando faz diferença — poucos pontos não precisam de
  // filtro, e um campo vazio de propósito é uma pergunta sem necessidade.
  const LIMIAR_BUSCA = 6;
  const busca = document.getElementById('buscaPontos');
  if (busca && dados.pontos.length > LIMIAR_BUSCA) {
    busca.hidden = false;
    busca.addEventListener('input', () => {
      const termo = busca.value.trim().toLowerCase();
      lista.querySelectorAll('.ponto-escolha').forEach((el) => {
        el.hidden = termo.length > 0 && !el.dataset.busca.includes(termo);
      });
    });
  }

  const msg = document.getElementById('msgPontos');
  const contador = document.getElementById('contadorPontos');
  const marcados = () => [...lista.querySelectorAll('input:checked')].map((i) => Number(i.value));

  function pintarContador() {
    const n = marcados().length;
    const base = limite ? `${n} de ${limite} escolhidos` : `${n} escolhido${n === 1 ? '' : 's'}`;
    // "Escolhidos" e "em operação" são contagens diferentes (o cliente pode
    // escolher um ponto que ainda está em instalação, ou não escolher nada e
    // ainda assim aparecer nos que estão no ar) — juntar os dois números no
    // mesmo badge evita a leitura de que "1 de 7" já diz tudo sobre a
    // cobertura real de hoje.
    const veiculando = dados.cobertura?.veiculando;
    contador.textContent = veiculando != null ? `${base} · ${veiculando} em operação` : base;
    contador.className = !limite || n >= limite ? 'badge badge-ok' : 'badge badge-pendente';
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
      msg.textContent = marcados().length ? 'Pronto. Salvo.' : 'Pronto. Sem marcação, a gente distribui seus pontos.';
      msg.className = 'form-msg ok';
    } catch {
      msg.textContent = 'Sem conexão. Tente de novo.';
      msg.className = 'form-msg err';
    }
  });
}

// Conteúdo do dialog #dlgPlano — chamada sempre que há plano_id, não só
// quando "ativo" (19/09/2026): quem está em cortesia ou com a cobertura
// vencida também pode querer abrir e ver o que está acontecendo. As duas
// ações (trocar/cancelar) só fazem sentido pra quem paga em dia — não tem o
// que cancelar numa cortesia, nem o que trocar numa cobertura já vencida
// (o botão de "Escolher plano" no banner já cobre esse caso).
function preencherAssinatura() {
  const el = document.getElementById('resumoAssinatura');
  const ativo =
    !ANUNCIANTE.plano_cortesia &&
    !ANUNCIANTE.suspenso &&
    ANUNCIANTE.data_expiracao &&
    new Date(ANUNCIANTE.data_expiracao) > new Date();
  const nomePlano = ANUNCIANTE.plano?.nome || 'seu plano';
  const ate = ANUNCIANTE.data_expiracao
    ? `${ativo ? 'Ativa' : ANUNCIANTE.plano_cortesia ? 'Cortesia' : 'Vencida'} até <b>${window.dataBR(ANUNCIANTE.data_expiracao)}</b>`
    : ativo
      ? 'Ativa'
      : 'Sem data de expiração';
  el.innerHTML = `
    <p class="u-m-0 u-mb-4">${esc(nomePlano)} · ${ate}.</p>
    ${
      ativo
        ? `<p class="form-hint u-m-0 u-mb-12">Cancelar não devolve o que já foi pago. O período atual continua no ar até essa data, e não renova depois.</p>
    <div class="field-row">
      <a class="btn ghost" href="/planos.html">Trocar de plano</a>
      <button class="btn ghost" id="btnCancelarAssinatura">Cancelar assinatura</button>
    </div>
    <p class="form-msg" id="msgCancelarAssinatura"></p>`
        : ANUNCIANTE.plano_cortesia
          ? '<p class="form-hint u-m-0">Plano de cortesia, sem cobrança — não há assinatura para cancelar ou trocar por aqui.</p>'
          : '<p class="form-hint u-m-0">Cobertura vencida. <a href="/planos.html">Escolha um plano</a> para voltar ao ar.</p>'
    }
  `;
  if (ativo) document.getElementById('btnCancelarAssinatura').addEventListener('click', cancelarAssinatura);
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

// Fechar o dialog de plano — mesmo padrão de #dlgPerfil (perfil.js): botão
// de fechar, clique fora (no <dialog>, o próprio elemento é o backdrop) e
// Esc, que o <dialog> nativo já trata sozinho.
(function dialogPlano() {
  const dlg = document.getElementById('dlgPlano');
  if (!dlg) return;
  document.getElementById('btnFecharPlano').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
})();

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

// Tempo decorrido em prosa curta, pro aviso de ponto fora do ar — não reusa
// duracaoLegivel porque ali "3h" faz sentido pra uma duração de exibição, e
// aqui um silêncio de dois dias em horas ("48h") é mais difícil de ler que
// "2 dias".
function tempoDesde(dataISO) {
  const horas = (Date.now() - new Date(dataISO).getTime()) / 3_600_000;
  if (horas < 1) return `${Math.max(1, Math.round(horas * 60))} min`;
  if (horas < 48) return `${Math.round(horas)} h`;
  return `${Math.round(horas / 24)} dias`;
}

// Estado operacional no hero (21/09/2026, revisão de design): "campanha
// ativa" não pode significar só "tem plano" — a tela pode estar apagada há
// horas com o plano em dia, e é exatamente esse caso que o anunciante mais
// precisa ver primeiro, antes de qualquer KPI. Mesmo limiar de
// HORAS_OFFLINE_ALERTA que a tabela "Exibições por ponto" já usa
// (statusOnline), pras duas leituras nunca divergirem.
function pintarStatusOperacional(porPonto) {
  const el = document.getElementById('heroStatus');
  if (!el) return;
  if (!porPonto.length) {
    el.hidden = true;
    return;
  }
  const agora = Date.now();
  const online = (p) =>
    p.ultima_vez_online && agora - new Date(p.ultima_vez_online).getTime() < HORAS_OFFLINE_ALERTA * 3600 * 1000;
  const noAr = porPonto.filter(online);
  const n = porPonto.length;
  const itens = [
    `<span class="hero-status-item"><span class="dot" aria-hidden="true"></span>${noAr.length} de ${n} ${n === 1 ? 'ponto no ar' : 'pontos no ar'}</span>`,
  ];
  if (noAr.length < n) {
    const foraDoAr = porPonto.filter((p) => !online(p));
    const maisAntigo = foraDoAr
      .map((p) => p.ultima_vez_online)
      .filter(Boolean)
      .sort()[0];
    const desde = maisAntigo ? `sinal mais antigo há ${tempoDesde(maisAntigo)}` : 'nunca recebeu playlist';
    itens.push(`<span class="hero-status-item hero-status-alerta">⚠ ${desde}</span>`);
  }
  el.innerHTML = itens.join('');
  el.hidden = false;
}

// Dashboard de exibições — leitura agregada de GET /anunciantes/:id/exibicoes
// (transparência de entrega: programado vs. confirmado, custo por exibição).
// Banco de horas (G.3): card sempre visível (19/09/2026, pedido do dono —
// antes só aparecia com saldo > 0; agora a conta consegue conferir "quanto
// tem no banco" mesmo quando é zero, sem precisar adivinhar que o
// mecanismo existe). `catch` silencioso de propósito: é um aviso extra, não
// um número que o cliente precisa pra decidir algo, e um painel que já
// carregou tudo (exibições, criativos) não deveria mostrar erro por causa
// deste card.
//
// O tempo (`dados.segundos`) é ilustrativo — exibições × duração ATUAL da
// peça (RN-53), não um histórico exato — por isso o número exato de
// exibições fica do lado, entre parênteses: quem quiser conferir a conta
// tem o dado que a apuração realmente usa.
async function carregarBancoHoras() {
  try {
    const dados = await (await fetch(`${API_BASE_URL}/anunciantes/me/banco-horas`, { credentials: 'include' })).json();
    // Virou card no grid (19/09/2026, pedido do dono) — antes era só uma
    // frase colada no banner, fácil de não notar entre os outros avisos.
    document.getElementById('kpiGrid').insertAdjacentHTML(
      'beforeend',
      `<div class="kpi-card kpi-secondary">
        <span class="kpi-icon" aria-hidden="true">＋</span>
        <span class="kpi-label">Banco de horas</span>
        <b>${duracaoLegivel(dados.segundos)}</b>
        ${
          dados.saldo
            ? `<span class="badge badge-pendente">${dados.saldo} exibições · prioridade nos próximos dias</span>`
            : '<span class="kpi-caption">sem déficit acumulado</span>'
        }
      </div>`,
    );
  } catch {
    /* aviso extra — sem ele, o painel continua completo */
  }
}

// Horas contratadas x entregues no mês corrente (19/09/2026, pedido do
// dono) — é a métrica que a conta realmente vende, então é o PRIMEIRO
// card do grid, não mais um card solto anexado no fim (HTML já reserva o
// lugar em painel.html, com data-kpi="horas"). Mesma barrinha de progresso
// do gráfico por ponto (.track/.fill), sem componente novo. Só aparece com
// plano (os dois vêm null sem plano, e nem deveria chegar até aqui: o
// bloqueio de plano já barra essa chamada).
function desenharHorasMes(contratadas, entregues) {
  const card = document.querySelector('#kpiGrid [data-kpi="horas"]');
  if (contratadas == null || !card) return;
  const restantes = Math.max(0, contratadas - entregues);
  const pct = contratadas > 0 ? Math.min(100, (entregues / contratadas) * 100) : 0;
  card.querySelector('b').textContent = `${entregues}h`;
  card.querySelector('[data-kpi-horas-legenda]').textContent =
    `de ${contratadas}h contratadas · ${restantes}h ainda por rodar`;
  const fill = card.querySelector('.fill');
  fill.dataset.pct = pct;
  // A barra já existe no HTML (data-pct="0") desde o carregamento — o
  // observador de config.js só aplica uma vez por elemento
  // (:not([data-pct-ok])), então mudar o número aqui não bastaria sozinho.
  fill.removeAttribute('data-pct-ok');
  window.aplicarBarras(card);
  card.hidden = false;
}

async function carregarExibicoes() {
  try {
    const dados = await (
      await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/exibicoes`, { credentials: 'include' })
    ).json();
    const kpi = (nome) => document.querySelector(`#kpiGrid [data-kpi="${nome}"] b`);
    // Fração "concluídas/total" num número só (19/09/2026, pedido do dono)
    // — antes eram duas legendas de prosa; agora é a mesma resposta num
    // formato que se lê num olhar só.
    const concluidas = (dados.confirmadasMes ?? 0).toLocaleString('pt-BR');
    kpi('exibicoes').textContent =
      dados.exibicoesContratadasMes != null
        ? `${concluidas} / ${dados.exibicoesContratadasMes.toLocaleString('pt-BR')}`
        : concluidas;
    // Por MIL exibições, não por exibição só (21/09/2026, revisão de
    // design): a mesma fórmula (plano ÷ previstas) em duas casas decimais
    // colapsava pra R$ 0,01 em qualquer plano — número que não se move não
    // informa nada. Não é CPM: CPM é custo por mil PESSOAS impactadas, e o
    // Mostraí não mede audiência, só reprodução na tela.
    kpi('custo').textContent = dados.custoPorExibicao ? fmt(dados.custoPorExibicao * 1000) : '-';
    kpi('media').textContent = dados.mediaDiariaMes ?? '-';

    desenharPorDia(dados.porDia || [], dados.porDiaPonto || [], dados.porPonto || []);
    desenharPorPonto(dados.porPonto || []);
    desenharCobrancas(dados.cobrancas || []);
    desenharHorasMes(dados.horasContratadasMes, dados.horasEntreguesMes);
    pintarStatusOperacional(dados.porPonto || []);
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

// Quantos pontos entram com cor própria na barra empilhada — o resto vira
// "Outros pontos" (--serie-outros, cinza). 5 é o tanto de slot categórico
// que a paleta da skill dataviz valida pro par ADJACENTE (o que importa numa
// barra empilhada, onde um segmento só encosta no de cima e no de baixo).
const TOP_SERIES_DIA_PONTO = 5;

// Barras verticais dos últimos 14 dias, empilhadas por ponto (19/09/2026,
// pedido do dono: "no card exibições por dia, coloque também um exibições
// por ponto"). O endpoint devolve DESC (mais novo primeiro) e só os dias com
// registro — inverte e mostra como vem, sem preencher buraco de dia sem
// exibição. `porPonto` já chega ORDER BY confirmadas DESC (mesma rota) —
// reaproveita esse ranking pra decidir quem ganha cor própria, em vez de
// recalcular: os 5 primeiros pontos do período inteiro têm sempre a mesma
// cor em toda barra; o resto soma em "Outros pontos".
function desenharPorDia(porDia, porDiaPonto, porPonto) {
  document.getElementById('painelDia').hidden = false;
  if (!porDia.length) {
    document.getElementById('graficoDia').innerHTML =
      '<div class="empty-state dashboard-empty">As exibições confirmadas aparecerão aqui assim que a campanha começar a rodar.</div>';
    document.getElementById('legendaDia').textContent = 'Sem exibições confirmadas no período';
    return;
  }
  const dias = porDia.slice(0, 14).reverse();
  const max = Math.max(...dias.map((d) => Number(d.confirmadas))) || 1;

  const principais = (porPonto || []).slice(0, TOP_SERIES_DIA_PONTO);
  const serieDoPonto = new Map(principais.map((p, i) => [p.id, `serie-${i + 1}`]));

  const porDiaChave = new Map();
  for (const linha of porDiaPonto || []) {
    const chave = String(linha.dia).slice(0, 10);
    if (!porDiaChave.has(chave)) porDiaChave.set(chave, []);
    porDiaChave.get(chave).push(linha);
  }

  document.getElementById('graficoDia').innerHTML = dias
    .map((d) => {
      const v = Number(d.confirmadas);
      // `dia` vem do servidor como dia de calendário puro ('2026-09-16'), sem
      // hora e sem fuso. `new Date('2026-09-16')` lê isso como meia-noite UTC
      // e `getDate()` devolve 15 pra quem está no Brasil — a barra ficava com
      // o rótulo do dia anterior. Fatiar a string não passa por fuso nenhum,
      // que é o certo pra uma data que não tem fuso.
      const [ano, mes, diaDoMes] = String(d.dia).slice(0, 10).split('-');
      const segmentos = segmentosDoDia(porDiaChave.get(String(d.dia).slice(0, 10)) || [], serieDoPonto);
      const pilha = segmentos.length
        ? segmentos
            .map(
              (s) =>
                `<div class="bar-seg ${s.classe}" data-pct="${v ? (s.valor / v) * 100 : 0}" title="${esc(s.nome)}: ${s.valor} exibições"></div>`,
            )
            .join('')
        : `<div class="bar-seg serie-1" data-pct="100" title="${v} exibições"></div>`;
      return `<div class="bar-col" title="${diaDoMes}/${mes}/${ano}: ${v} exibições">
      <div class="bar-pilha" data-pct="${Math.max(2, (v / max) * 100)}">${pilha}</div>
      <span class="bar-label">${diaDoMes}/${mes}</span>
    </div>`;
    })
    .join('');

  desenharLegendaPontosDia(principais, serieDoPonto, (porPonto || []).length > TOP_SERIES_DIA_PONTO);

  // Total de exibições e delta 7 dias x 7 anteriores — antes eram um card
  // próprio no kpi-grid ("Exibições confirmadas"); saíram de lá (19/09/2026,
  // pedido do dono) porque a conta vende por HORAS, não por vez rodada, e um
  // plano pequeno (peça curta, poucas inserções por hora) sempre ia mostrar
  // um número baixo ali, sem culpa nenhuma da entrega. A contagem continua
  // visível, só que como legenda do próprio gráfico que ela descreve.
  const soma = (arr) => arr.reduce((t, d) => t + Number(d.confirmadas), 0);
  const atual = soma(porDia.slice(0, 7));
  const anterior = soma(porDia.slice(7, 14));
  const delta = anterior
    ? `, ${atual >= anterior ? '▲' : '▼'} ${Math.abs(Math.round(((atual - anterior) / anterior) * 100))}% vs. 7 dias antes`
    : '';
  document.getElementById('legendaDia').textContent =
    `últimos ${dias.length} dias com exibição · ${atual} confirmadas nos últimos 7 dias${delta}`;
}

// Agrupa as linhas de um dia (já filtradas por dia em desenharPorDia) na
// mesma ordem/cor fixa dos 5 principais + "Outros pontos" — um ponto fora do
// top 5 do período inteiro sempre cai em "Outros", mesmo que tenha sido o
// que mais exibiu NESSE dia específico, porque a cor tem que significar o
// mesmo ponto em toda barra do gráfico, não só naquele dia.
function segmentosDoDia(linhasDoDia, serieDoPonto) {
  const porSerie = new Map();
  let outros = 0;
  for (const linha of linhasDoDia) {
    const classe = serieDoPonto.get(linha.ponto_id);
    const valor = Number(linha.confirmadas);
    if (!classe) {
      outros += valor;
      continue;
    }
    const atual = porSerie.get(classe) || { nome: linha.ponto_nome, valor: 0 };
    atual.valor += valor;
    porSerie.set(classe, atual);
  }
  const segmentos = [...serieDoPonto.values()]
    .map((classe) => (porSerie.has(classe) ? { classe, ...porSerie.get(classe) } : null))
    .filter(Boolean);
  if (outros > 0) segmentos.push({ classe: 'serie-outros', nome: 'Outros pontos', valor: outros });
  return segmentos;
}

// Legenda de cores do gráfico empilhado — cor sozinha não é canal acessível
// (skill dataviz), por isso a identidade de cada ponto também vem por nome
// aqui, não só pela cor do segmento. Um ponto só (sem "Outros") não precisa
// de legenda: só existe uma cor, e o título do card já diz o que é.
function desenharLegendaPontosDia(principais, serieDoPonto, temOutros) {
  const el = document.getElementById('legendaPontosDia');
  if (!el) return;
  const chips = principais.map((p) => ({ classe: serieDoPonto.get(p.id), nome: p.nome }));
  if (temOutros) chips.push({ classe: 'serie-outros', nome: 'Outros pontos' });
  el.hidden = chips.length < 2;
  el.innerHTML = chips
    .map((c) => `<span class="chip"><span class="swatch ${c.classe}"></span>${esc(c.nome)}</span>`)
    .join('');
}

// Top 8: já vem ORDER BY confirmadas DESC do servidor — uma rede com muitos
// pontos virava uma lista de barra alta e ilegível. O resto continua na
// tabela detalhada logo abaixo, completa, sem corte nenhum.
const TOP_PONTOS_GRAFICO = 8;
function desenharPorPonto(porPonto) {
  document.getElementById('painelDetalhe').hidden = false;
  if (!porPonto.length) {
    document.getElementById('graficoPonto').innerHTML =
      '<div class="empty-state dashboard-empty">Nenhum ponto com exibições neste período.</div>';
    document.getElementById('exibicoesDetalhe').innerHTML = '';
    return;
  }
  // Com um ponto só, a distribuição é sempre 100% por definição — a barra
  // não informa nada além do que o título da seção já diz (21/09/2026,
  // revisão de design). A tabela abaixo, com entrega e status por ponto,
  // continua sempre visível: ela conta uma história diferente da barra.
  if (porPonto.length < 2) {
    document.getElementById('graficoPonto').innerHTML = '';
  } else {
    const max = Math.max(...porPonto.map((p) => Number(p.confirmadas))) || 1;
    const total = porPonto.reduce((soma, p) => soma + Number(p.confirmadas), 0) || 1;
    const principais = porPonto.slice(0, TOP_PONTOS_GRAFICO);
    const resto = porPonto.length - principais.length;
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
  }
  document.getElementById('exibicoesDetalhe').innerHTML =
    `<div class="u-ox-auto"><table class="mini-table"><thead><tr><th>Ponto</th><th>Cidade</th><th>Programadas</th><th>Confirmadas</th><th>Entrega</th><th>Status</th></tr></thead><tbody>
    ${porPonto
      .map((p) => {
        const prog = Number(p.programadas) || 0;
        const conf = Number(p.confirmadas) || 0;
        return `<tr><td>${esc(p.nome)}</td><td>${esc(p.cidade)}</td><td>${prog}</td><td>${conf}</td><td>${prog ? Math.round((conf / prog) * 100) + '%' : '-'}</td><td>${statusOnline(p.ultima_vez_online)}</td></tr>`;
      })
      .join('')}
  </tbody></table></div>`;
}

// "A propaganda tá passando mesmo, ou a TV tá desligada?" (19/09/2026,
// pedido do dono) — mesma janela de 2h que o admin já usa pra alertar tela
// offline (HORAS_OFFLINE_ALERTA, src/admin/routes.js). Sem
// `ultima_vez_online` nenhuma, a tela nunca chegou a pedir playlist — trata
// como offline também, não como "sem dado".
const HORAS_OFFLINE_ALERTA = 2;
function statusOnline(ultimaVezOnline) {
  const online =
    ultimaVezOnline && Date.now() - new Date(ultimaVezOnline).getTime() < HORAS_OFFLINE_ALERTA * 3600 * 1000;
  return online ? '<span class="badge badge-ok">🟢 Online</span>' : '<span class="badge badge-err">🔴 Offline</span>';
}

// Cobranças já vêm no mesmo endpoint e não eram mostradas em lugar nenhum.
// Coluna de nota fiscal saiu (19/09/2026, pedido do dono): nenhuma é
// emitida hoje, e quando passar a emitir vai direto por e-mail, não por um
// link nesta tabela.
function desenharCobrancas(cobrancas) {
  document.getElementById('painelCobrancas').hidden = false;
  if (!cobrancas.length) {
    document.getElementById('listaCobrancas').innerHTML =
      '<div class="empty-state dashboard-empty">Nenhum pagamento registrado ainda.</div>';
    return;
  }
  document.getElementById('listaCobrancas').innerHTML =
    `<div class="u-ox-auto"><table class="mini-table"><thead><tr><th>Data</th><th>Valor</th></tr></thead><tbody>
    ${cobrancas
      .map(
        (c) => `<tr>
      <td>${new Date(c.criado_em).toLocaleDateString('pt-BR')}</td>
      <td>${fmt(c.valor)}</td>
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
    // Contador ao lado do título "Meus criativos" (19/09/2026, pedido do
    // dono) — não é mais card próprio no kpi-grid.
    const contador = document.getElementById('contadorCriativos');
    if (contador) contador.textContent = ativos ? `${ativos} ativo${ativos === 1 ? '' : 's'}` : '';
    // "Quero um anúncio" só faz sentido pra quem ainda não subiu nenhuma
    // peça (19/09/2026, pedido do dono) — assim que existe ao menos um
    // criativo na conta, a pergunta "não tem arte ainda?" já não se aplica.
    const ajudaArte = document.getElementById('ajudaArte');
    if (ajudaArte) ajudaArte.hidden = criativos.length > 0;
    el.innerHTML = criativos.length
      ? `<div class="criativos-lista">
      ${criativos
        .map((c) => {
          const video = c.arquivo_normalizado_url && ehVideo(c.arquivo_normalizado_url);
          const tipo = video ? 'Vídeo' : 'Imagem';
          const duracao = c.duracao_segundos ? `${Number(c.duracao_segundos)}s` : 'Processando';
          return `<div class="criativo-card" data-id="${c.id}"><div class="criativo-media">
          ${
            c.arquivo_normalizado_url
              ? video
                ? `<video src="${esc(c.arquivo_normalizado_url)}" muted loop playsinline poster="${esc(c.thumbnail_url || '')}"></video>
                 <button type="button" class="criativo-play" aria-label="Reproduzir"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></button>`
                : `<img src="${esc(c.arquivo_normalizado_url)}" alt="">`
              : '<div class="criativo-placeholder">processando...</div>'
          }
          <button type="button" class="criativo-excluir" aria-label="Excluir criativo">&times;</button>
          <span class="badge ${ROTULOS.criativoClasse[c.status] || 'badge-pendente'}">${esc(ROTULOS.criativo[c.status] || c.status)}</span>
          </div><div class="criativo-meta"><strong>${tipo}</strong><span>${duracao}</span></div>
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
