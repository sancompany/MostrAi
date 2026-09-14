// ---------- base ----------
function api(caminho, opts = {}) {
  return fetch(`${API_BASE_URL}${caminho}`, {
    ...opts,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}
const pegar = async (caminho) => (await api(caminho)).json();

function fmt(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function num(v) { return Number(v || 0).toLocaleString('pt-BR'); }
function data(v) { return v ? new Date(v).toLocaleDateString('pt-BR') : '—'; }

// Nome de ponto/empresa chega por formulário público, sem autenticação —
// vai pra innerHTML aqui dentro da sessão do admin, então escapa sempre.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ESCAPES[c]); }

let toastTimer;
function toast(texto, tipo) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = tipo === 'err' ? 'toast err' : 'toast';
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, tipo === 'err' ? 5000 : 1800);
}

// Salvar edição inline com retorno visual. Todas as telas passam por aqui —
// antes cada uma disparava o PATCH e ignorava a resposta, então um erro do
// servidor sumia sem ninguém ver e o campo continuava mostrando o valor novo.
async function salvar(caminho, corpo, campo) {
  const r = await api(caminho, { method: 'PATCH', body: JSON.stringify(corpo) });
  if (r.ok) {
    if (campo) { campo.classList.remove('flash-ok'); void campo.offsetWidth; campo.classList.add('flash-ok'); }
    toast('Salvo.');
    return true;
  }
  toast((await r.json().catch(() => ({}))).erro || 'Não foi possível salvar.', 'err');
  return false;
}

// Busca, filtro por status e ordenação por clique no cabeçalho, para
// qualquer tabela montada no formato .tabela-caixa. Uma função só em vez
// de repetir em cada seção.
function turbinarTabela(caixa) {
  const tabela = caixa.querySelector('table');
  if (!tabela || !tabela.tBodies[0]) return;
  const busca = caixa.querySelector('.busca');
  const contagem = caixa.querySelector('[data-contagem]');
  const linhas = () => [...tabela.tBodies[0].rows];

  function aplicar() {
    const termo = (busca ? busca.value : '').toLowerCase().trim();
    const chipAtivo = caixa.querySelector('.chip.active');
    const filtro = chipAtivo ? (chipAtivo.dataset.filtro || '') : '';
    let visiveis = 0;
    linhas().forEach((tr) => {
      const casaTermo = !termo || tr.textContent.toLowerCase().includes(termo);
      const casaFiltro = !filtro || (tr.dataset.filtro || '').split(' ').includes(filtro);
      tr.hidden = !(casaTermo && casaFiltro);
      if (!tr.hidden) visiveis += 1;
    });
    if (contagem) contagem.textContent = `${visiveis} de ${linhas().length}`;
  }

  if (busca) busca.addEventListener('input', aplicar);
  caixa.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
    caixa.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
    chip.classList.add('active');
    aplicar();
  }));

  tabela.querySelectorAll('th[data-ord]').forEach((th) => th.addEventListener('click', () => {
    const idx = [...th.parentNode.children].indexOf(th);
    const desc = th.classList.contains('asc');
    tabela.querySelectorAll('th[data-ord]').forEach((x) => x.classList.remove('asc', 'desc'));
    th.classList.add(desc ? 'desc' : 'asc');
    // Célula com input/select ordena pelo valor do campo, não pelo texto
    // vazio da célula.
    const valorDe = (tr) => {
      const celula = tr.cells[idx];
      if (!celula) return '';
      const campo = celula.querySelector('input, select, textarea');
      if (!campo) return celula.textContent.trim();
      return campo.type === 'checkbox' ? (campo.checked ? '1' : '0') : String(campo.value).trim();
    };
    const corpo = tabela.tBodies[0];
    linhas().sort((a, b) => {
      const x = valorDe(a); const y = valorDe(b);
      const nx = parseFloat(x.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
      const ny = parseFloat(y.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
      const cmp = (x !== '' && y !== '' && !isNaN(nx) && !isNaN(ny)) ? nx - ny : x.localeCompare(y, 'pt-BR');
      return desc ? -cmp : cmp;
    }).forEach((tr) => corpo.appendChild(tr));
  }));

  aplicar();
}

// Monta a casca padrão de tabela (busca + chips + rodapé de contagem).
function caixaTabela({ chips = [], html, dica = '' }) {
  return `<div class="tabela-caixa">
    <div class="tabela-topo">
      <input class="busca" type="search" placeholder="Buscar...">
      <div class="chips">${chips.map((c, i) => `<button type="button" class="chip ${i === 0 ? 'active' : ''}" data-filtro="${c.valor}">${esc(c.nome)}</button>`).join('')}</div>
    </div>
    <div class="rolagem">${html}</div>
    <div class="tabela-pe"><span data-contagem></span><span>${dica}</span></div>
  </div>`;
}

// ---------- rótulos ----------
const PONTO_STATUS = { lead: 'Novo lead', aguardando_instalacao: 'A instalar', ativo: 'Ativo', reparo: 'Em reparo', inativo: 'Inativo' };
const ANUNCIANTE_STATUS = { pendente_aprovacao: 'Pendente', aprovado: 'Aprovado', ativo: 'Ativo', suspenso: 'Suspenso' };
const VENDEDOR_STATUS = { aprovado: 'Aprovado', inativo: 'Inativo' };
const TELA_STATUS = { ativo: 'Ativa', reparo: 'Em reparo', inativo: 'Inativa' };
const CANDIDATURA_STATUS = { nova: 'Nova', em_contato: 'Em contato', aprovada: 'Aprovada (convite gerado)', recusada: 'Recusada' };
const PAPEIS = { anunciante: 'Anunciante', ponto: 'Dono de ponto', vendedor: 'Vendedor' };
const CRIATIVO_STATUS = { pendente: 'Em análise', aprovado: 'Aprovado', reprovado: 'Reprovado' };
const CICLOS = { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };

function selectStatus(mapa, atual, attrs) {
  return `<select class="mini" ${attrs}>
    ${Object.entries(mapa).map(([v, nome]) => `<option value="${v}" ${v === atual ? 'selected' : ''}>${nome}</option>`).join('')}
  </select>`;
}

// ---------- navegação ----------
const NAV = [
  { grupo: 'Início', itens: [{ id: 'resumo', nome: 'Visão geral' }] },
  { grupo: 'Entrada', itens: [
    { id: 'candidaturas', nome: 'Candidaturas', fila: 'candidaturas' },
    { id: 'convites', nome: 'Convites' },
  ] },
  { grupo: 'Operação', itens: [
    { id: 'criativos', nome: 'Fila de criativos', fila: 'criativos' },
    { id: 'meusanuncios', nome: 'Meus anúncios' },
    { id: 'pontos', nome: 'Pontos', fila: 'pontos' },
    { id: 'telas', nome: 'Telas', fila: 'offline' },
    { id: 'anunciantes', nome: 'Anunciantes', fila: 'anunciantes' },
    { id: 'vendedores', nome: 'Vendedores' },
  ] },
  { grupo: 'Catálogo', itens: [
    { id: 'planos', nome: 'Planos' },
    { id: 'beneficios', nome: 'Benefícios' },
    { id: 'categorias', nome: 'Categorias' },
    { id: 'comodato', nome: 'Opções de comodato' },
  ] },
  { grupo: 'Financeiro', itens: [
    { id: 'cobrancas', nome: 'Cobranças', fila: 'notas' },
    { id: 'comissoes', nome: 'Comissões' },
    { id: 'arrependimentos', nome: 'Devoluções', fila: 'arrependimentos' },
    { id: 'custos', nome: 'Custos fixos' },
    { id: 'eventos', nome: 'Eventos pendentes', fila: 'eventos' },
  ] },
];

const SUBTITULOS = {
  resumo: 'O que precisa de você agora, o resultado do mês e a fotografia da rede.',
  criativos: 'Anúncios enviados pelos anunciantes esperando aprovação antes de entrar no ar.',
  candidaturas: 'Quem pediu pra ser ponto ou vendedor pelo site. Você conversa, e se fechar, gera o convite daqui.',
  convites: 'Links de cadastro gerados por você: quem entra por eles nasce com os papéis marcados. Uso único, com validade.',
  pontos: 'Comércios da rede: status, comodato, ajuda de custo, cota e acabamento. As telas de cada ponto ficam em "Telas".',
  telas: 'Cada TV/dispositivo: chave do aparelho, PIN do painel, custo e último sinal. Uma tela = uma playlist.',
  anunciantes: 'Todas as contas — os papéis vêm do convite. "Subir anúncio" põe a peça pronta direto na conta do cliente, já aprovada: ela é feita fora do site e combinada no WhatsApp.',
  vendedores: 'Contas com papel de vendedor: cupom, Pix e percentual de comissão.',
  planos: 'Preços do site. Cada modalidade mostra no máximo 3 planos na vitrine; o plano fundador fica fora dessa conta.',
  beneficios: 'Catálogo de benefícios reaproveitado por todos os planos.',
  categorias: 'Segmentos usados no cadastro — é o que impede concorrente direto na mesma tela.',
  comodato: 'O que o dono do ponto escolhe no "Seja um ponto": ajuda de custo e cota de autoanúncio.',
  cobrancas: 'Pagamentos confirmados e emissão de nota fiscal.',
  comissoes: 'Quanto cada vendedor tem a receber, e o Pix pra pagar.',
  custos: 'Custos mensais que entram na margem: MEI, contador, domínio, deslocamento... o que você lançar aqui.',
  eventos: 'Eventos do San Checkout que não deram pra correlacionar sozinhos.',
  arrependimentos: 'Quem desistiu da contratação dentro dos 7 dias da lei. A cobrança já foi cancelada e o anúncio já saiu do ar — falta devolver o dinheiro no painel do Checkout e registrar aqui.',
  meusanuncios: 'A conta de anunciante do próprio Mostraí: anuncia a rede nas telas da rede, sem plano e sem cobrança. Criativos ilimitados.',
};

let RESUMO = null;

function montarNav() {
  document.getElementById('nav').innerHTML = NAV.map((g) => `
    <div class="nav-grupo">${g.grupo}</div>
    ${g.itens.map((i) => `<button type="button" class="nav-item" data-aba="${i.id}" ${i.fila ? `data-fila="${i.fila}"` : ''}>
      <span>${i.nome}</span><span class="cont" hidden></span>
    </button>`).join('')}
  `).join('');
}

// Contadores no menu — o admin vê o que está pendente sem abrir aba nenhuma.
function pintarContadores() {
  if (!RESUMO) return;
  document.querySelectorAll('.nav-item[data-fila]').forEach((btn) => {
    const qtd = RESUMO.filas[btn.dataset.fila] || 0;
    const cont = btn.querySelector('.cont');
    cont.textContent = qtd;
    cont.hidden = qtd === 0;
  });
}

async function irPara(aba, forcarResumo) {
  const alvo = SUBTITULOS[aba] ? aba : 'resumo';
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.aba === alvo));
  const item = NAV.flatMap((g) => g.itens).find((i) => i.id === alvo);
  document.getElementById('tituloSecao').textContent = item ? item.nome : 'Visão geral';
  document.getElementById('subSecao').textContent = SUBTITULOS[alvo];
  if (location.hash !== `#${alvo}`) location.hash = alvo;

  const el = document.getElementById('conteudo');
  el.textContent = 'Carregando...';
  if (!RESUMO || forcarResumo) { RESUMO = await pegar('/admin/resumo'); pintarContadores(); }

  const telas = {
    resumo: renderResumo, candidaturas: renderCandidaturas, convites: renderConvites,
    criativos: renderCriativos, pontos: renderPontos, telas: renderTelas,
    anunciantes: renderAnunciantes, vendedores: renderVendedores, planos: renderPlanos,
    beneficios: renderBeneficios, categorias: renderCategorias, comodato: renderComodato,
    cobrancas: renderCobrancas, comissoes: renderComissoes, custos: renderCustos, eventos: renderEventos,
    meusanuncios: renderMeusAnuncios,
    arrependimentos: renderArrependimentos,
  };
  try {
    await telas[alvo](el);
  } catch (err) {
    console.error(`falha ao montar a aba ${alvo}`, err);
    el.innerHTML = '<p class="form-msg err">Não foi possível carregar esta seção. Clique em Atualizar.</p>';
  }
}

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (btn) irPara(btn.dataset.aba);
});
document.getElementById('btnRecarregar').addEventListener('click', () => irPara(location.hash.slice(1) || 'resumo', true));
window.addEventListener('hashchange', () => {
  const aba = location.hash.slice(1) || 'resumo';
  const ativo = document.querySelector('.nav-item.active');
  if (!ativo || ativo.dataset.aba !== aba) irPara(aba);
});

// ---------- login ----------
async function mostrarApp() {
  document.getElementById('gate').hidden = true;
  document.getElementById('app').hidden = false;
  montarNav();
  irPara(location.hash.slice(1) || 'resumo', true);
}

document.getElementById('formLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('gateMsg');
  msg.textContent = 'Entrando...';
  msg.className = 'form-msg';
  let r;
  try {
    r = await fetch(`${API_BASE_URL}/admin/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: document.getElementById('usuario').value, senha: document.getElementById('senha').value }),
    });
  } catch {
    // Sem isso a promessa rejeitava e a tela não mudava nada — o admin
    // ficava clicando em "Entrar" sem nenhum retorno.
    msg.textContent = 'Não foi possível falar com o servidor. Ele está rodando?';
    msg.className = 'form-msg err';
    return;
  }
  if (!r.ok) {
    msg.textContent = (await r.json().catch(() => ({}))).erro || 'Usuário ou senha inválidos.';
    msg.className = 'form-msg err';
    return;
  }
  mostrarApp();
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  await fetch(`${API_BASE_URL}/admin/logout`, { method: 'POST', credentials: 'include' });
  location.hash = '';
  location.reload();
});

// Sessão é cookie httpOnly — testa se já tem uma válida antes de mostrar o gate.
api('/admin/resumo').then((r) => { if (r.ok) mostrarApp(); });

// ---------- visão geral ----------
const ALERTAS = [
  { fila: 'criativos', aba: 'criativos', texto: 'criativo(s) esperando aprovação', urgente: true },
  { fila: 'offline', aba: 'telas', texto: 'tela(s) ativas sem dar sinal', urgente: true },
  { fila: 'candidaturas', aba: 'candidaturas', texto: 'candidatura(s) nova(s) pra responder' },
  { fila: 'eventos', aba: 'eventos', texto: 'evento(s) de pagamento pra revisar', urgente: true },
  { fila: 'anunciantes', aba: 'anunciantes', texto: 'anunciante(s) pendente(s) de aprovação' },
  { fila: 'pontos', aba: 'pontos', texto: 'ponto(s) candidatos aguardando triagem' },
  { fila: 'notas', aba: 'cobrancas', texto: 'nota(s) fiscal(is) por emitir' },
  { fila: 'arrependimentos', aba: 'arrependimentos', texto: 'devolução(ões) por arrependimento a pagar', urgente: true },
];

function barrasHorizontais(linhas, mapa) {
  if (!linhas.length) return '<p class="empty-state u-py-8">Nada cadastrado ainda.</p>';
  const max = Math.max(...linhas.map((l) => l.qtd)) || 1;
  return `<div class="bar-chart-h">${linhas.map((l) => `
    <div class="row">
      <span class="nome">${esc(mapa[l.status] || l.status)}</span>
      <span class="track"><span class="fill" data-pct="${(l.qtd / max) * 100}"></span></span>
      <span class="valor">${l.qtd}</span>
    </div>`).join('')}</div>`;
}

async function renderResumo(el) {
  const { filas, financeiro, rede } = RESUMO;
  const pendentes = ALERTAS.filter((a) => (filas[a.fila] || 0) > 0);
  const entrega = rede.programadas30d ? Math.round((rede.exibicoes30d / rede.programadas30d) * 100) : null;
  const meses = financeiro.faturamentoPorMes || [];
  const maxFat = Math.max(...meses.map((m) => Number(m.total)), 1);
  const margemOk = financeiro.margemMensal >= 0;

  el.innerHTML = `
    ${pendentes.length
      ? `<div class="alertas">${pendentes.map((a) => `
          <button type="button" class="alerta ${a.urgente ? 'urgente' : ''}" data-ir="${a.aba}">
            <b>${filas[a.fila]}</b><span>${a.texto}</span>
          </button>`).join('')}</div>`
      : '<div class="tudo-em-dia"><b>Tudo em dia.</b> Nenhuma fila esperando você agora.</div>'}

    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">Receita recorrente</span><b>${fmt(financeiro.receitaMensal)}</b><span class="kpi-caption">planos ativos, por mês</span></div>
      <div class="kpi-card"><span class="kpi-label">Custo dos pontos</span><b>${fmt(financeiro.custoPontosMensal)}</b><span class="kpi-caption">ajuda de custo paga</span></div>
      <div class="kpi-card"><span class="kpi-label">Amortização</span><b>${fmt(financeiro.amortizacaoMensal)}</b><span class="kpi-caption">custo de cada tela ÷ prazo dela</span></div>
      <div class="kpi-card"><span class="kpi-label">Custos fixos</span><b>${fmt(financeiro.custosFixosMensal)}</b><a class="link-secundario" href="#custos">editar →</a></div>
      <div class="kpi-card"><span class="kpi-label">Margem</span><b>${fmt(financeiro.margemMensal)}</b><span class="delta ${margemOk ? 'up' : 'down'}">${margemOk ? 'no azul' : 'no vermelho'}</span></div>
    </div>

    <div class="kpi-grid u-mb-20">
      <div class="kpi-card"><span class="kpi-label">Pontos ativos</span><b>${rede.pontosAtivos}</b><span class="kpi-caption">${rede.telasAtivas} tela(s) no ar · +${rede.novosPontos30d} pontos em 30 dias</span></div>
      <div class="kpi-card"><span class="kpi-label">Alcance da rede</span><b>${num(rede.fluxoMensal)}</b><span class="kpi-caption">pessoas/mês estimadas</span></div>
      <div class="kpi-card"><span class="kpi-label">Exibições (30 dias)</span><b>${num(rede.exibicoes30d)}</b><span class="kpi-caption">${entrega === null ? 'sem programação ainda' : `${entrega}% do programado`}</span></div>
      <div class="kpi-card"><span class="kpi-label">Anunciantes novos</span><b>${rede.novosAnunciantes30d}</b><span class="kpi-caption">nos últimos 30 dias</span></div>
    </div>

    <div class="dashboard-grid">
      <div class="panel">
        <div class="panel-head"><h3>Faturamento confirmado</h3><span class="kpi-caption">últimos 6 meses</span></div>
        ${meses.length ? `<div class="bar-chart">${meses.map((m) => {
          const [ano, mes] = m.mes.split('-');
          return `<div class="bar-col" title="${m.mes}: ${fmt(m.total)}">
            <div class="bar" data-pct="${Math.max(2, (Number(m.total) / maxFat) * 100)}"></div>
            <span class="bar-label">${mes}/${ano.slice(2)}</span>
          </div>`;
        }).join('')}</div>` : '<p class="empty-state u-py-14">Nenhuma cobrança confirmada ainda.</p>'}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Pontos por status</h3></div>
        ${barrasHorizontais(rede.pontosPorStatus, PONTO_STATUS)}
        <div class="panel-head u-mt-22"><h3>Anunciantes por status</h3></div>
        ${barrasHorizontais(rede.anunciantesPorStatus, ANUNCIANTE_STATUS)}
      </div>
    </div>`;

  el.querySelectorAll('[data-ir]').forEach((btn) => btn.addEventListener('click', () => irPara(btn.dataset.ir)));
}

// ---------- fila de criativos ----------
async function renderCriativos(el, status = 'pendente') {
  const [criativos, anunciantes] = await Promise.all([
    pegar(`/admin/criativos?status=${status}`),
    pegar('/admin/anunciantes'),
  ]);
  // O endpoint de criativos só devolve anunciante_id — sem o nome, o admin
  // aprovava um número. Junta aqui em vez de mexer na query do servidor.
  const nomePor = Object.fromEntries(anunciantes.map((a) => [a.id, a.nome_empresa]));
  const ehVideo = (u) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(u || '');

  el.innerHTML = `
    <div class="chips u-mb-16">
      ${Object.entries(CRIATIVO_STATUS).map(([v, nome]) => `<button type="button" class="chip ${v === status ? 'active' : ''}" data-status="${v}">${nome}</button>`).join('')}
    </div>
    ${criativos.length ? `<div class="criativo-fila">${criativos.map((c) => {
      const url = c.arquivo_normalizado_url || c.arquivo_original_url;
      return `<div class="item">
        ${url && ehVideo(url)
          ? `<video class="midia" src="${esc(url)}" muted loop playsinline controls poster="${esc(c.thumbnail_url || '')}"></video>`
          : (url ? `<img class="midia" src="${esc(url)}" alt="">` : '<div class="midia"></div>')}
        <div class="dados">
          <b>${esc(nomePor[c.anunciante_id] || `Anunciante #${c.anunciante_id}`)}</b>
          <small>#${c.id} · ${c.duracao_segundos ? `${c.duracao_segundos}s · ` : ''}enviado ${data(c.created_at)}</small>
        </div>
        ${status === 'pendente' ? `<div class="acoes">
          <button class="btn primary mini" data-acao="aprovado" data-id="${c.id}">Aprovar</button>
          <button class="btn ghost mini" data-acao="reprovado" data-id="${c.id}">Reprovar</button>
        </div>` : `<div class="acoes">
          <button class="btn ghost mini" data-acao="${status === 'aprovado' ? 'reprovado' : 'aprovado'}" data-id="${c.id}">Mudar para ${status === 'aprovado' ? 'reprovado' : 'aprovado'}</button>
        </div>`}
      </div>`;
    }).join('')}</div>` : `<p class="empty-state">Nenhum criativo ${CRIATIVO_STATUS[status].toLowerCase()}.</p>`}`;

  el.querySelectorAll('.chip[data-status]').forEach((chip) => chip.addEventListener('click', () => renderCriativos(el, chip.dataset.status)));
  el.querySelectorAll('button[data-acao]').forEach((btn) => btn.addEventListener('click', async () => {
    if (await salvar(`/admin/criativos/${btn.dataset.id}`, { status: btn.dataset.acao })) {
      RESUMO = await pegar('/admin/resumo');
      pintarContadores();
      renderCriativos(el, status);
    }
  }));
}

// ---------- meus anúncios (conta própria do Mostraí) ----------
// A rede anunciando a si mesma. É uma conta comum em `anunciantes` com a
// marca `conta_propria` (migration 023): entra na mesma playlist e gera os
// mesmos contadores, mas dispensa plano e nunca gera cobrança — por isso
// não aparece na receita nem na margem. Só pode existir uma; o índice
// único do banco garante isso mesmo com dois cliques.
async function renderMeusAnuncios(el) {
  const contas = await pegar('/admin/anunciantes');
  const conta = contas.find((c) => c.conta_propria);

  if (!conta) {
    el.innerHTML = `
      <div class="tabela-caixa">
        <div class="tabela-topo"><b>Nenhuma conta própria ainda</b></div>
        <div class="u-p-14">
          <p class="sub u-mt-0">Crie a conta do Mostraí para anunciar a própria rede nas telas. Ela não assina plano, não é cobrada e não entra na receita.</p>
          <form id="formContaPropria" class="card u-mw-420">
            <label for="cpNome">Nome que aparece</label>
            <input id="cpNome" value="Mostraí" required>
            <label for="cpDoc">CNPJ do Mostraí</label>
            <input id="cpDoc" placeholder="00.000.000/0000-00" required>
            <label for="cpFreq">Vezes por dia, por tela</label>
            <input id="cpFreq" type="number" min="1" max="240" value="12" required>
            <button class="btn primary" type="submit">Criar conta própria</button>
          </form>
        </div>
      </div>`;
    document.getElementById('formContaPropria').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const r = await api('/admin/anunciantes', { method: 'POST', body: JSON.stringify({
        nome_empresa: document.getElementById('cpNome').value,
        cpf_cnpj: document.getElementById('cpDoc').value,
        contato_email: 'rede+propria@mostrai.local',
        contato_telefone: '+5516000000000', status: 'ativo',
        conta_propria: true, frequencia_dia_propria: Number(document.getElementById('cpFreq').value),
      }) });
      if (!r.ok) return toast((await r.json()).erro || 'não deu pra criar', 'err');
      toast('conta própria criada'); renderMeusAnuncios(el);
    });
    return;
  }

  const criativos = await pegar(`/admin/criativos`);
  const meus = criativos.filter((c) => c.anunciante_id === conta.id);
  const aprovados = meus.filter((c) => c.status === 'aprovado').length;

  el.innerHTML = `
    <div class="tabela-caixa">
      <div class="tabela-topo">
        <b>${esc(conta.nome_empresa)}</b>
        <span class="sub u-m-0">${aprovados} no ar · ${meus.length} no total · sem teto de criativos</span>
      </div>
      <div class="u-p-14">
        <form id="formFreq" class="card u-mw-420 u-mb-14">
          <label for="cpFreq2">Vezes por dia, por tela</label>
          <input id="cpFreq2" type="number" min="1" max="240" value="${conta.frequencia_dia_propria || 12}">
          <label for="cpStatus">Situação</label>
          <select id="cpStatus">
            <option value="ativo"${conta.status === 'ativo' ? ' selected' : ''}>No ar</option>
            <option value="suspenso"${conta.status === 'suspenso' ? ' selected' : ''}>Pausada</option>
          </select>
          <button class="btn ghost" type="submit">Salvar</button>
        </form>

        <form id="formSubir" class="card u-mw-420">
          <label for="cpArquivo">Novo anúncio (vídeo ou imagem)</label>
          <input id="cpArquivo" type="file" accept="video/*,image/*" required>
          <button class="btn primary" type="submit">Subir</button>
        </form>
        <p class="sub u-m-0 u-mt-8" id="cpMsg"></p>
      </div>
    </div>

    <div class="tabela-caixa">
      <table>
        <thead><tr><th>Anúncio</th><th>Duração</th><th>Situação</th><th></th></tr></thead>
        <tbody>${meus.map((c) => `
          <tr>
            <td>${esc(c.arquivo_original_url || '—')}</td>
            <td>${c.duracao_segundos ? c.duracao_segundos + 's' : '—'}</td>
            <td>${c.status === 'aprovado' ? 'No ar' : esc(c.status)}</td>
            <td>${c.status === 'aprovado'
              ? `<button class="btn ghost mini" data-tirar="${c.id}">Tirar do ar</button>`
              : `<button class="btn ghost mini" data-por="${c.id}">Pôr no ar</button>`}</td>
          </tr>`).join('') || '<tr><td colspan="4">Nenhum anúncio ainda.</td></tr>'}</tbody>
      </table>
    </div>`;

  document.getElementById('formFreq').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await api(`/admin/anunciantes/${conta.id}`, { method: 'PATCH', body: JSON.stringify({
      frequencia_dia_propria: Number(document.getElementById('cpFreq2').value),
      status: document.getElementById('cpStatus').value,
    }) });
    toast(r.ok ? 'salvo' : 'não deu pra salvar', r.ok ? 'ok' : 'err');
  });

  // Upload vai em multipart, então não passa pelo `api()`, que manda JSON.
  document.getElementById('formSubir').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const arquivo = document.getElementById('cpArquivo').files[0];
    if (!arquivo) return;
    const msg = document.getElementById('cpMsg');
    msg.textContent = 'Enviando e normalizando o vídeo... isso leva alguns segundos.';
    const dados = new FormData(); dados.append('arquivo', arquivo);
    const r = await fetch(`${API_BASE_URL}/admin/anunciantes/${conta.id}/criativos`, {
      method: 'POST', body: dados, credentials: 'include',
    });
    if (!r.ok) { msg.textContent = ''; return toast((await r.json()).erro || 'falhou', 'err'); }
    toast('anúncio enviado'); renderMeusAnuncios(el);
  });

  el.querySelectorAll('[data-tirar],[data-por]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.tirar || b.dataset.por;
    const status = b.dataset.tirar ? 'reprovado' : 'aprovado';
    const r = await api(`/admin/criativos/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    if (!r.ok) return toast('não deu pra mudar', 'err');
    renderMeusAnuncios(el);
  }));
}

// ---------- pontos ----------
async function renderPontos(el) {
  const [pontos, categorias, opcoesComodato] = await Promise.all([
    pegar('/admin/pontos'), pegar('/admin/categorias'), pegar('/admin/planos-ponto'),
  ]);
  // Sinal/chave/PIN são por TELA (migration 019) — ficam na aba "Telas".
  // Aqui o ponto mostra quantas telas tem e quem é o dono (conta).
  const corpo = `<table><thead><tr>
      <th data-ord>ID</th><th data-ord>Nome</th><th data-ord>Dono (conta)</th><th data-ord>Cidade</th><th>Segmento do local</th>
      <th>Comodato</th><th data-ord>Ajuda R$/mês</th><th data-ord>Cota/h</th><th data-ord>Status</th>
      <th data-ord>Fluxo/mês</th><th>Molde</th><th data-ord>Telas</th><th>Foto</th>
    </tr></thead><tbody>
    ${pontos.map((p) => `<tr data-filtro="${p.status}${p.telas_ativas < p.telas ? ' parcial' : ''}">
      <td>${p.id}</td>
      <td><b>${esc(p.nome)}</b><div class="u-dim u-fs-72">${esc(p.responsavel_nome)} · ${esc(p.responsavel_contato)}</div></td>
      <td>${p.dono_nome ? esc(p.dono_nome) : '<span class="u-dim">sem conta</span>'}</td>
      <td>${esc(p.cidade)}/${esc(p.uf)}</td>
      <td><select class="mini" data-ponto="categoria_id" data-id="${p.id}" title="Define de qual segmento NÃO entra anúncio nessa tela">
        <option value="">—</option>
        ${categorias.map((c) => `<option value="${c.id}" ${c.id === p.categoria_id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
      </select></td>
      <td><select class="mini" data-ponto="plano_ponto_id" data-id="${p.id}">
        <option value="">—</option>
        ${opcoesComodato.map((o) => `<option value="${o.id}" ${o.id === p.plano_ponto_id ? 'selected' : ''}>${esc(o.nome)}</option>`).join('')}
      </select></td>
      <td><input class="mini u-w-80" type="number" step="0.01" min="0" data-ponto="valor_pago_mensal" data-id="${p.id}" value="${p.valor_pago_mensal}"></td>
      <td><input class="mini u-w-60" type="number" min="0" data-ponto="cota_autoanuncio_slots_hora" data-id="${p.id}" value="${p.cota_autoanuncio_slots_hora}"></td>
      <td>${selectStatus(PONTO_STATUS, p.status, `data-ponto="status" data-id="${p.id}"`)}</td>
      <td><input class="mini u-w-80" type="number" min="0" data-ponto="fluxo_estimado_mensal" data-id="${p.id}" value="${p.fluxo_estimado_mensal ?? ''}" title="Só entra na soma pública se o ponto estiver ativo"></td>
      <td class="u-ta-c"><input type="checkbox" data-ponto="acabamento_completo" data-id="${p.id}" ${p.acabamento_completo ? 'checked' : ''} title="Molde de ACM já instalado"></td>
      <td><a href="#telas" data-ver-telas="${p.id}"><b>${p.telas_ativas ?? 0}</b>/${p.telas ?? 0} no ar</a>
        <button class="btn ghost mini" data-nova-tela="${p.id}" title="Adiciona mais uma TV nesse endereço">+ tela</button></td>
      <td>
        <input type="file" accept="image/*" class="mini u-w-100" data-foto-ponto="${p.id}">
        ${p.foto_instalacao_url ? `<a class="u-d-block u-fs-72" href="${esc(p.foto_instalacao_url)}" target="_blank" rel="noopener">ver foto</a>` : ''}
      </td>
    </tr>`).join('')}
  </tbody></table>`;

  el.innerHTML = `
    <details class="bloco-novo">
      <summary class="btn ghost mini">+ Novo ponto (cadastro manual)</summary>
      <form class="card u-mt-12 u-mw-420" id="formNovoPonto">
        <div><label>Nome</label><input class="mini" name="nome" required></div>
        <div><label>Segmento</label><input class="mini" name="segmento" required></div>
        <div><label>Endereço</label><input class="mini" name="endereco" required></div>
        <div class="field-row">
          <div class="u-col-2"><label>Cidade</label><input class="mini" name="cidade" required value="Matão"></div>
          <div class="u-col"><label>UF</label><input class="mini" name="uf" maxlength="2" required value="SP"></div>
          <div class="u-col"><label>CEP</label><input class="mini" name="cep" required></div>
        </div>
        <div><label>Responsável</label><input class="mini" name="responsavel_nome" required></div>
        <div><label>WhatsApp</label><input class="mini" name="responsavel_contato" required></div>
        <button class="btn primary" type="submit">Criar ponto</button>
        <p class="form-msg" id="msgNovoPonto"></p>
      </form>
    </details>
    ${caixaTabela({
      chips: [{ valor: '', nome: 'Todos' }, { valor: 'parcial', nome: 'Com tela fora do ar' },
        ...Object.entries(PONTO_STATUS).map(([v, n]) => ({ valor: v, nome: n }))],
      html: corpo,
      dica: 'Alterações salvam ao sair do campo. Chave, PIN e sinal de cada TV ficam na aba Telas.',
    })}
    <p class="empty-state u-ta-l u-p-0 u-pt-4">A ajuda de custo e a cota vêm da opção de comodato escolhida no cadastro, mas ficam editáveis por ponto — trocar a opção aqui não recalcula sozinho. A cota é dividida entre as telas ativas do ponto. Fluxo mensal só entra na soma pública com o ponto ativo. Ponto novo entra pelo formulário "Seja um ponto" → candidatura → convite; o cadastro manual abaixo é pra exceção.</p>`;

  turbinarTabela(el.querySelector('.tabela-caixa'));

  el.querySelectorAll('[data-ponto]').forEach((campo) => campo.addEventListener('change', () => {
    if (campo.type === 'checkbox') return salvar(`/admin/pontos/${campo.dataset.id}`, { [campo.dataset.ponto]: campo.checked }, campo);
    const numerico = ['valor_pago_mensal', 'cota_autoanuncio_slots_hora', 'fluxo_estimado_mensal', 'categoria_id'].includes(campo.dataset.ponto);
    const valor = campo.value === '' ? null : (numerico ? Number(campo.value) : campo.value);
    return salvar(`/admin/pontos/${campo.dataset.id}`, { [campo.dataset.ponto]: valor }, campo);
  }));

  el.querySelectorAll('[data-ver-telas]').forEach((a) => a.addEventListener('click', () => { FILTRO_TELAS_PONTO = Number(a.dataset.verTelas); }));
  el.querySelectorAll('[data-nova-tela]').forEach((btn) => btn.addEventListener('click', async () => {
    const apelido = prompt('Nome da tela (ex.: Tela 2 — balcão):', `Tela ${(pontos.find((p) => p.id === Number(btn.dataset.novaTela)) || {}).telas + 1 || 2}`);
    if (apelido === null) return;
    const custo = prompt('Custo do equipamento dessa tela (R$), pra amortização — pode deixar 0 e preencher depois:', '0');
    const r = await api(`/admin/pontos/${btn.dataset.novaTela}/dispositivos`, { method: 'POST', body: JSON.stringify({ apelido, custo_equipamento: Number(custo) || 0 }) });
    if (!r.ok) return toast('Não foi possível criar a tela.', 'err');
    toast('Tela criada — gere a chave dela na aba Telas.');
    FILTRO_TELAS_PONTO = Number(btn.dataset.novaTela);
    irPara('telas');
  }));

  el.querySelectorAll('[data-foto-ponto]').forEach((input) => input.addEventListener('change', async () => {
    if (!input.files[0]) return;
    const form = new FormData();
    form.append('arquivo', input.files[0]);
    const r = await fetch(`${API_BASE_URL}/admin/pontos/${input.dataset.fotoPonto}/foto`, { method: 'POST', credentials: 'include', body: form });
    toast(r.ok ? 'Foto enviada.' : 'Não foi possível enviar a foto.', r.ok ? '' : 'err');
    if (r.ok) renderPontos(el);
  }));

  document.getElementById('formNovoPonto').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovoPonto');
    const r = await api('/admin/pontos', { method: 'POST', body: JSON.stringify({ ...Object.fromEntries(new FormData(e.target)), status: 'aguardando_instalacao' }) });
    if (!r.ok) { msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao criar.'; msg.className = 'form-msg err'; return; }
    toast('Ponto criado.');
    renderPontos(el);
  });
}

// ---------- telas (dispositivos) ----------
let FILTRO_TELAS_PONTO = null;

// A chave do aparelho é o que autentica a TV (ver src/lib/aparelho.js).
// O link completo é o que se abre no navegador da tela — ele guarda a
// chave e continua funcionando depois de reiniciar.
const linkDoPlayer = (telaId, chave) => `${window.location.origin}/player.html?tela=${telaId}&chave=${encodeURIComponent(chave)}`;

async function renderTelas(el) {
  const telas = await pegar('/admin/dispositivos');
  const limite = Date.now() - (RESUMO.horasOfflineAlerta || 2) * 3600 * 1000;
  const estaOffline = (t) => t.status === 'ativo' && t.ponto_status === 'ativo' && (!t.ultima_vez_online || new Date(t.ultima_vez_online).getTime() < limite);
  const filtroPonto = FILTRO_TELAS_PONTO;
  FILTRO_TELAS_PONTO = null;
  const lista = filtroPonto ? telas.filter((t) => t.ponto_id === filtroPonto) : telas;
  const amort = (t) => Number(t.custo_equipamento) > 0 ? Number(t.custo_equipamento) / Math.max(1, Number(t.meses_amortizacao) || 36) : 0;

  const corpo = `<table><thead><tr>
      <th data-ord>ID</th><th data-ord>Ponto</th><th data-ord>Tela</th><th data-ord>Status</th><th data-ord>Último sinal</th>
      <th>Chave / link do player</th><th>PIN do painel</th><th data-ord>Custo R$</th><th data-ord>Meses</th><th data-ord>Amort./mês</th><th data-ord>Instalada em</th><th></th>
    </tr></thead><tbody>
    ${lista.map((t) => `<tr data-filtro="${t.status}${estaOffline(t) ? ' offline' : ''}${t.aparelho_id ? '' : ' semchave'}">
      <td>${t.id}</td>
      <td><b>${esc(t.ponto_nome)}</b><div class="u-dim u-fs-72">${esc(t.ponto_cidade || '')} · ponto ${esc(PONTO_STATUS[t.ponto_status] || t.ponto_status)}</div></td>
      <td><input class="mini u-w-120" data-tela="apelido" data-id="${t.id}" value="${esc(t.apelido)}"></td>
      <td>${selectStatus(TELA_STATUS, t.status, `data-tela="status" data-id="${t.id}"`)}</td>
      <td>${estaOffline(t) ? '<span class="badge badge-err">sem sinal</span> ' : ''}${t.ultima_vez_online ? new Date(t.ultima_vez_online).toLocaleString('pt-BR') : '—'}</td>
      <td>${t.aparelho_id
        ? `<button class="btn ghost mini" data-copiar="${esc(t.aparelho_id)}" data-tela-id="${t.id}">Copiar link</button>
           <button class="btn ghost mini" data-chave="${t.id}" data-trocar="1" title="Gera uma chave nova e derruba o aparelho atual">Trocar</button>`
        : `<button class="btn primary mini" data-chave="${t.id}">Gerar chave</button>`}</td>
      <td>${t.tem_pin ? '<span class="badge badge-ok">definido</span> ' : '<span class="badge badge-pendente">sem PIN</span> '}
        <button class="btn ghost mini" data-pin="${t.id}">${t.tem_pin ? 'Trocar' : 'Definir'}</button></td>
      <td><input class="mini u-w-80" type="number" step="0.01" min="0" data-tela="custo_equipamento" data-id="${t.id}" value="${t.custo_equipamento ?? 0}"></td>
      <td><input class="mini u-w-60" type="number" min="1" data-tela="meses_amortizacao" data-id="${t.id}" value="${t.meses_amortizacao ?? 36}"></td>
      <td>${amort(t) ? fmt(amort(t)) : '—'}</td>
      <td><input class="mini u-w-120" type="date" data-tela="instalado_em" data-id="${t.id}" value="${t.instalado_em ? String(t.instalado_em).slice(0, 10) : ''}"></td>
      <td><button class="btn ghost mini" data-painel-tela="${t.id}" title="O que rodou nessa tela">Painel</button>
          <button class="btn ghost mini u-txt-erro" data-excluir-tela="${t.id}" title="Só se nunca rodou nada">×</button></td>
    </tr>`).join('')}
  </tbody></table>`;

  el.innerHTML = `
    ${filtroPonto ? `<p class="form-hint u-m-0 u-mb-10">Mostrando só as telas do ponto #${filtroPonto}. <a href="#telas" data-limpar-filtro>Ver todas</a></p>` : ''}
    ${lista.length ? caixaTabela({
      chips: [{ valor: '', nome: 'Todas' }, { valor: 'offline', nome: 'Sem sinal' }, { valor: 'semchave', nome: 'Sem chave' },
        ...Object.entries(TELA_STATUS).map(([v, n]) => ({ valor: v, nome: n }))],
      html: corpo,
      dica: 'Uma tela = um link do player + uma playlist. Custo e prazo alimentam a amortização da visão geral.',
    }) : '<p class="empty-state">Nenhuma tela ainda. Crie a primeira pelo botão "+ tela" na aba Pontos.</p>'}
    <p class="empty-state u-ta-l u-p-0 u-pt-4">Como ligar uma TV: gere a chave → copie o link → abra no navegador da TV (ou no app kiosk apontando pra ele). O PIN abre o painel da tela na própria TV (5 toques no canto superior direito ou tecla P) — só mostra o que rodou nela, nada mais.</p>`;

  if (!lista.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelector('[data-limpar-filtro]')?.addEventListener('click', () => renderTelas(el));

  el.querySelectorAll('[data-tela]').forEach((campo) => campo.addEventListener('change', async () => {
    const numerico = ['custo_equipamento', 'meses_amortizacao'].includes(campo.dataset.tela);
    const valor = campo.value === '' ? null : (numerico ? Number(campo.value) : campo.value);
    if (await salvar(`/admin/dispositivos/${campo.dataset.id}`, { [campo.dataset.tela]: valor }, campo) && ['status', 'custo_equipamento', 'meses_amortizacao'].includes(campo.dataset.tela)) {
      RESUMO = await pegar('/admin/resumo'); pintarContadores();
      if (campo.dataset.tela !== 'status') renderTelas(el);
    }
  }));

  el.querySelectorAll('[data-chave]').forEach((btn) => btn.addEventListener('click', async () => {
    if (btn.dataset.trocar && !confirm('Gerar uma chave nova? A TV que está usando a chave atual para de funcionar até você abrir o link novo nela.')) return;
    const r = await api(`/admin/dispositivos/${btn.dataset.chave}/chave`, { method: 'POST' });
    if (!r.ok) return toast('Não foi possível gerar a chave.', 'err');
    const { aparelho_id } = await r.json();
    prompt('Abra este link no navegador da TV (ele guarda a chave e continua funcionando depois de reiniciar):', linkDoPlayer(btn.dataset.chave, aparelho_id));
    renderTelas(el);
  }));

  el.querySelectorAll('[data-copiar]').forEach((btn) => btn.addEventListener('click', () => {
    const link = linkDoPlayer(btn.dataset.telaId, btn.dataset.copiar);
    navigator.clipboard?.writeText(link).then(() => toast('Link copiado.'), () => prompt('Link do player:', link));
  }));

  el.querySelectorAll('[data-pin]').forEach((btn) => btn.addEventListener('click', async () => {
    const pin = prompt('PIN de 4 a 6 dígitos pra abrir o painel dessa tela na TV (deixe vazio pra remover):');
    if (pin === null) return;
    const r = await api(`/admin/dispositivos/${btn.dataset.pin}/pin`, { method: 'POST', body: JSON.stringify({ pin: pin.trim() || null }) });
    if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'Não foi possível salvar o PIN.', 'err');
    toast(pin.trim() ? 'PIN definido.' : 'PIN removido.');
    renderTelas(el);
  }));

  el.querySelectorAll('[data-painel-tela]').forEach((btn) => btn.addEventListener('click', async () => {
    const d = await pegar(`/admin/dispositivos/${btn.dataset.painelTela}/painel`);
    const total = d.porAnunciante.reduce((s, a) => s + a.confirmadas, 0);
    const linha = btn.closest('tr');
    const existente = linha.nextElementSibling;
    if (existente && existente.dataset.painelDe === btn.dataset.painelTela) { existente.remove(); return; }
    linha.insertAdjacentHTML('afterend', `<tr data-painel-de="${btn.dataset.painelTela}"><td class="u-bg" colspan="12">
      <b>Últimos 30 dias: ${num(total)} exibições confirmadas</b>
      ${d.porAnunciante.length ? `<table class="mini-table u-mt-6"><thead><tr><th>Anunciante</th><th>Programadas</th><th>Confirmadas</th></tr></thead><tbody>
        ${d.porAnunciante.map((a) => `<tr><td>${esc(a.nome_empresa)}</td><td>${a.programadas}</td><td>${a.confirmadas}</td></tr>`).join('')}</tbody></table>` : '<p class="empty-state u-py-6">Nada rodou nessa tela ainda.</p>'}
    </td></tr>`);
  }));

  el.querySelectorAll('[data-excluir-tela]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Excluir essa tela? Só faça isso se ela nunca rodou nada (o histórico de exibições vai junto).')) return;
    const r = await api(`/admin/dispositivos/${btn.dataset.excluirTela}`, { method: 'DELETE' });
    if (!r.ok) return toast('Não foi possível excluir.', 'err');
    toast('Tela excluída.');
    renderTelas(el);
  }));
}

// ---------- anunciantes ----------
async function renderAnunciantes(el) {
  const [anunciantes, categorias, planos, pontos] = await Promise.all([
    pegar('/admin/anunciantes'), pegar('/admin/categorias'), pegar('/admin/planos'), pegar('/admin/pontos'),
  ]);
  // Plano mostrava só o id cru; e desde que ponto usa conta de anunciante
  // (migration 016), dá pra marcar aqui quem também é dono de ponto.
  const nomePlano = Object.fromEntries(planos.map((p) => [p.id, `${p.nome} · ${CICLOS[p.compromisso_meses] || p.compromisso_meses + 'x'}`]));
  const temPonto = new Set(pontos.map((p) => p.anunciante_id).filter(Boolean));

  const corpo = `<table><thead><tr>
      <th data-ord>ID</th><th data-ord>Empresa</th><th data-ord>Documento</th><th>Contato</th>
      <th>Ramo</th><th data-ord>Plano</th><th data-ord>Expira</th><th data-ord>Status</th><th data-ord>Entrou</th><th></th>
    </tr></thead><tbody>
    ${anunciantes.map((a) => `<tr data-filtro="${a.excluido_em ? 'excluida' : a.status}${temPonto.has(a.id) || (a.papeis || []).includes('ponto') ? ' comodato' : ''}${(a.papeis || []).includes('vendedor') ? ' vendedor' : ''}" class="${a.excluido_em ? 'u-op-60' : ''}">
      <td>${a.id}</td>
      <td><b>${esc(a.nome_empresa)}</b> ${(a.papeis || ['anunciante']).filter((x) => x !== 'anunciante').map((x) => `<span class="badge badge-ok">${esc(PAPEIS[x] || x)}</span>`).join(' ')}${a.valor_mensal_travado != null ? ` <span class="badge badge-pendente" title="preço travado (fundador)">${fmt(a.valor_mensal_travado)}/mês travado</span>` : ''}${a.excluido_em ? ` <span class="badge badge-err">excluída ${data(a.excluido_em)}</span>` : ''}</td>
      <td>${esc(a.cpf_cnpj)}</td>
      <td><div class="u-fs-78">${esc(a.contato_email)}</div><div class="u-dim u-fs-74">${esc(a.contato_telefone)}</div></td>
      <td><select class="mini" data-anunciante="categoria_id" data-id="${a.id}" title="Ramo do anunciante — não entra em ponto do mesmo ramo">
        <option value="">${a.categoria_livre ? `(livre) ${esc(a.categoria_livre)}` : '—'}</option>
        ${categorias.map((c) => `<option value="${c.id}" ${c.id === a.categoria_id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
      </select></td>
      <td>${a.plano_id ? esc(nomePlano[a.plano_id] || a.plano_id) : '<span class="u-dim">sem plano</span>'}${a.plano_cortesia ? ` <span class="badge badge-pendente" title="${esc(a.cortesia_motivo || 'liberado pelo admin')}">cortesia</span>` : ''}</td>
      <td>${data(a.data_expiracao)}</td>
      <td>${selectStatus(ANUNCIANTE_STATUS, a.status, `data-anunciante="status" data-id="${a.id}"`)}</td>
      <td>${data(a.created_at)}</td>
      <td>${a.excluido_em
        ? `<button class="btn ghost mini" data-restaurar="${a.id}">Restaurar</button>`
        : `<label class="btn ghost mini" title="Sobe a peça direto na conta dele — já entra aprovada">Subir anúncio<input type="file" accept="video/*,image/*" hidden data-subir="${a.id}"></label>
           <button class="btn ghost mini" data-liberar="${a.id}" title="Põe a conta no ar sem cobrar nada">Liberar plano</button>`}</td>
    </tr>`).join('')}
  </tbody></table>`;

  el.innerHTML = `
    <details class="bloco-novo">
      <summary class="btn ghost mini">+ Novo anunciante (cadastro manual)</summary>
      <form class="card u-mt-12 u-mw-420" id="formNovoAnunciante">
        <div><label>Nome da empresa</label><input class="mini" name="nome_empresa" required></div>
        <div><label>CNPJ/CPF</label><input class="mini" name="cpf_cnpj" required></div>
        <div><label>Endereço</label><input class="mini" name="endereco" required></div>
        <div class="field-row">
          <div class="u-col-2"><label>Cidade</label><input class="mini" name="cidade" required></div>
          <div class="u-col"><label>UF</label><input class="mini" name="uf" maxlength="2" required></div>
          <div class="u-col"><label>CEP</label><input class="mini" name="cep" required></div>
        </div>
        <div><label>E-mail de acesso</label><input class="mini" type="email" name="contato_email" required></div>
        <div><label>WhatsApp</label><input class="mini" name="contato_telefone" required></div>
        <button class="btn primary" type="submit">Criar anunciante</button>
        <p class="form-msg" id="msgNovoAnunciante"></p>
      </form>
    </details>
    ${caixaTabela({
      chips: [{ valor: '', nome: 'Todos' },
        ...Object.entries(ANUNCIANTE_STATUS).map(([v, n]) => ({ valor: v, nome: n })),
        { valor: 'comodato', nome: 'Dono de ponto' }, { valor: 'vendedor', nome: 'Vendedor' }, { valor: 'excluida', nome: 'Excluídas' }],
      html: corpo,
      dica: 'Conta excluída fica recuperável por 60 dias — use Restaurar.',
    })}`;

  turbinarTabela(el.querySelector('.tabela-caixa'));

  el.querySelectorAll('[data-anunciante]').forEach((sel) => sel.addEventListener('change', async () => {
    const campo = sel.dataset.anunciante;
    const valor = campo === 'categoria_id' ? (sel.value === '' ? null : Number(sel.value)) : sel.value;
    if (await salvar(`/admin/anunciantes/${sel.dataset.id}`, { [campo]: valor }, sel) && campo === 'status') {
      RESUMO = await pegar('/admin/resumo');
      pintarContadores();
    }
  }));

  // Exclusão de conta é soft-delete (migration 017): o anunciante pede,
  // o suporte desfaz aqui dentro de 60 dias zerando excluido_em.
  // A peça é feita FORA do site (combinada no WhatsApp) e sobe direto na
  // conta do cliente. Multipart, então não passa pelo `api()`, que manda JSON.
  // Liberar plano de graça. A conta fica igual a uma pagante pra quem vê a
  // tela, e diferente pra quem lê o resumo — que é onde a diferença importa.
  el.querySelectorAll('[data-liberar]').forEach((b) => b.addEventListener('click', async () => {
    const opcoes = planos.map((p) => `${p.id} = ${p.nome} · ${CICLOS[p.compromisso_meses] || p.compromisso_meses + 'x'}`).join('\n');
    const plano_id = prompt(`Qual plano liberar?\n\n${opcoes}`);
    if (!plano_id) return;
    const motivo = prompt('Por que está liberando? (parceria, teste, cortesia de lançamento...)') || '';
    const r = await api(`/admin/anunciantes/${b.dataset.liberar}/liberar-plano`, {
      method: 'POST', body: JSON.stringify({ plano_id: plano_id.trim(), motivo }),
    });
    if (!r.ok) return toast((await r.json()).erro || 'não deu pra liberar', 'err');
    toast('plano liberado — a conta está no ar, sem cobrança');
    renderAnunciantes(el);
  }));
  el.querySelectorAll('[data-subir]').forEach((input) => input.addEventListener('change', async () => {
    const arquivo = input.files[0];
    if (!arquivo) return;
    input.disabled = true;
    toast('enviando e normalizando o vídeo...');
    const dados = new FormData(); dados.append('arquivo', arquivo);
    const r = await fetch(`${API_BASE_URL}/admin/anunciantes/${input.dataset.subir}/criativos`, {
      method: 'POST', body: dados, credentials: 'include',
    });
    input.disabled = false; input.value = '';
    if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'não deu pra subir', 'err');
    toast('anúncio no ar na conta do cliente');
  }));
  el.querySelectorAll('[data-restaurar]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Restaurar essa conta? O anunciante volta a conseguir entrar.')) return;
    if (await salvar(`/admin/anunciantes/${btn.dataset.restaurar}`, { excluido_em: null })) renderAnunciantes(el);
  }));

  document.getElementById('formNovoAnunciante').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovoAnunciante');
    const r = await api('/admin/anunciantes', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
    const corpoResp = await r.json();
    if (!r.ok) { msg.textContent = corpoResp.erro || 'Erro ao criar.'; msg.className = 'form-msg err'; return; }
    alert(`Anunciante criado! Senha de acesso: ${corpoResp.senhaGerada}\n\nRepasse pro anunciante agora — não fica salva em nenhuma tela depois desta.`);
    renderAnunciantes(el);
  });
}

// ---------- vendedores ----------
async function renderVendedores(el) {
  const vendedores = await pegar('/admin/vendedores');
  const corpo = `<table><thead><tr>
      <th data-ord>Conta</th><th data-ord>Nome</th><th>Contato</th><th>Chave Pix</th><th data-ord>Cupom</th><th data-ord>Comissão %</th><th data-ord>Status</th><th data-ord>Desde</th>
    </tr></thead><tbody>
    ${vendedores.map((v) => `<tr data-filtro="${v.status}">
      <td>${v.conta_id}</td>
      <td><b>${esc(v.nome)}</b></td>
      <td><div class="u-fs-78">${esc(v.email || '')}</div><div class="u-dim u-fs-74">${esc(v.telefone || '')}</div></td>
      <td><input class="mini u-w-160" data-vendedor="chave_pix" data-id="${v.conta_id}" value="${esc(v.chave_pix || '')}"></td>
      <td><code>${esc(v.codigo_cupom)}</code> <button class="btn ghost mini" data-copiar-cupom="${esc(v.codigo_cupom)}">copiar link</button></td>
      <td><input class="mini u-w-60" type="number" step="0.01" min="0" max="100" data-vendedor="comissao_percentual" data-id="${v.conta_id}" value="${v.comissao_percentual}"></td>
      <td>${selectStatus(VENDEDOR_STATUS, v.status, `data-vendedor="status" data-id="${v.conta_id}"`)}</td>
      <td>${data(v.created_at)}</td>
    </tr>`).join('')}
  </tbody></table>`;

  el.innerHTML = vendedores.length ? caixaTabela({
    chips: [{ valor: '', nome: 'Todos' }, ...Object.entries(VENDEDOR_STATUS).map(([v, n]) => ({ valor: v, nome: n }))],
    html: corpo,
    dica: 'Comissão e Pix salvam ao sair do campo. Vendedor novo entra por convite (aba Convites) com o papel "vendedor".',
  }) : '<p class="empty-state">Nenhum vendedor ainda. Gere um convite com o papel "vendedor" na aba Convites — a conta que entrar por ele já nasce com cupom.</p>';

  if (!vendedores.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('[data-vendedor]').forEach((campo) => campo.addEventListener('change', () => {
    const valor = campo.dataset.vendedor === 'comissao_percentual' ? Number(campo.value) : campo.value;
    salvar(`/admin/vendedores/${campo.dataset.id}`, { [campo.dataset.vendedor]: valor }, campo);
  }));
  el.querySelectorAll('[data-copiar-cupom]').forEach((btn) => btn.addEventListener('click', () => {
    const link = `${window.location.origin}/anunciante/cadastro.html?ref=${encodeURIComponent(btn.dataset.copiarCupom)}`;
    navigator.clipboard?.writeText(link).then(() => toast('Link de indicação copiado.'), () => prompt('Link:', link));
  }));
}

// ---------- candidaturas ----------
async function renderCandidaturas(el) {
  const lista = await pegar('/admin/candidaturas');
  const corpo = `<table><thead><tr>
      <th data-ord>Quando</th><th data-ord>Tipo</th><th data-ord>Nome</th><th>Comércio / endereço</th><th>Contato</th><th>Mensagem</th><th data-ord>Status</th><th></th>
    </tr></thead><tbody>
    ${lista.map((c) => `<tr data-filtro="${c.status} ${c.tipo}">
      <td>${data(c.criado_em)}</td>
      <td><span class="badge ${c.tipo === 'ponto' ? 'badge-ok' : 'badge-pendente'}">${c.tipo === 'ponto' ? 'Ponto' : 'Vendedor'}</span>
        ${c.origem === 'painel' ? '<div class="u-fs-70 u-dim">pedido do painel</div>' : c.origem === 'bonus_plano' ? '<div class="u-fs-70 u-txt-marca"><b>bônus do plano</b></div>' : ''}</td>
      <td><b>${esc(c.nome)}</b>${c.conta_id ? `<div class="u-fs-72 u-dim">conta #${c.conta_id} · ${esc(c.conta_nome || '')}</div>` : ''}</td>
      <td>${c.tipo === 'ponto' ? `<b>${esc(c.nome_comercio || '')}</b><div class="u-fs-76">${esc(c.endereco || '')} · ${esc(c.cidade || '')}/${esc(c.uf || '')}</div><div class="u-dim u-fs-72">${esc(c.segmento || '')}${c.fluxo_estimado_mensal ? ` · ~${num(c.fluxo_estimado_mensal)} pessoas/mês` : ''}</div>` : `<span class="u-dim">${esc(c.cidade || '')}</span>`}</td>
      <td><a href="https://wa.me/55${String(c.contato_telefone || '').replace(/\D/g, '')}" target="_blank" rel="noopener">${esc(c.contato_telefone)}</a><div class="u-dim u-fs-72">${esc(c.contato_email || '')}</div></td>
      <td class="u-mw-240 u-fs-78 u-ws-normal">${esc(c.mensagem || '—')}</td>
      <td>${c.status === 'aprovada'
        ? `<span class="badge ${c.convite_usado_em ? 'badge-ok' : c.convite_aberto ? 'badge-pendente' : 'badge-err'}">Convite ${c.convite_usado_em ? 'usado' : c.convite_aberto ? 'aberto' : 'expirado'}</span>`
        : selectStatus({ nova: 'Nova', em_contato: 'Em contato', recusada: 'Recusada' }, c.status, `data-cand="status" data-id="${c.id}"`)}</td>
      <td>${c.conta_id && c.status !== 'aprovada' && c.status !== 'recusada'
          ? `<button class="btn primary mini" data-liberar="${c.id}" data-tipo="${c.tipo}" title="Liga o modo direto na conta que pediu">Liberar na conta</button>`
          : ''}
          ${!c.conta_id && c.status !== 'recusada' && !c.convite_usado_em && !c.convite_aberto ? `<button class="btn primary mini" data-convidar="${c.id}" data-tipo="${c.tipo}" data-nome="${esc(c.nome)}" data-email="${esc(c.contato_email || '')}">${c.status === 'aprovada' ? 'Gerar convite novo' : 'Gerar convite'}</button>` : ''}
          ${c.convite_aberto ? `<button class="btn ghost mini" data-copiar-convite="${esc(c.convite_token)}">Copiar link</button>` : ''}</td>
    </tr>`).join('')}
  </tbody></table>`;

  el.innerHTML = lista.length ? caixaTabela({
    chips: [{ valor: 'nova', nome: 'Novas' }, { valor: 'em_contato', nome: 'Em contato' }, { valor: 'aprovada', nome: 'Aprovadas' }, { valor: 'recusada', nome: 'Recusadas' }, { valor: '', nome: 'Todas' }, { valor: 'ponto', nome: 'Só pontos' }, { valor: 'vendedor', nome: 'Só vendedores' }],
    html: corpo,
    dica: 'Pedido do site → "Gerar convite" (link de cadastro, uso único, 7 dias). Pedido feito de dentro do painel de uma conta → "Liberar na conta" liga o modo direto nela.',
  }) : '<p class="empty-state">Nenhuma candidatura ainda. Os formulários "Seja um ponto" e "Seja um vendedor" do site caem aqui.</p>';

  if (!lista.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('[data-cand]').forEach((sel) => sel.addEventListener('change', async () => {
    if (await salvar(`/admin/candidaturas/${sel.dataset.id}`, { status: sel.value }, sel)) { RESUMO = await pegar('/admin/resumo'); pintarContadores(); }
  }));
  el.querySelectorAll('[data-convidar]').forEach((btn) => btn.addEventListener('click', async () => {
    const papeis = btn.dataset.tipo === 'ponto' ? ['ponto'] : ['vendedor'];
    const extra = confirm(btn.dataset.tipo === 'ponto'
      ? 'Esse dono de ponto também vai ANUNCIAR (ter plano pago)? OK = sim, também anunciante. Cancelar = só dono de ponto.'
      : 'Esse vendedor também vai ANUNCIAR (ter plano pago)? OK = sim, também anunciante. Cancelar = só vendedor.');
    if (extra) papeis.push('anunciante');
    const r = await api('/admin/convites', { method: 'POST', body: JSON.stringify({ papeis, candidatura_id: Number(btn.dataset.convidar), nome_sugerido: btn.dataset.nome, email_sugerido: btn.dataset.email || null }) });
    if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'Não foi possível gerar o convite.', 'err');
    const { link } = await r.json();
    navigator.clipboard?.writeText(link).catch(() => {});
    prompt('Convite gerado (já copiado). Mande esse link pra pessoa — vale 7 dias e só pode ser usado uma vez:', link);
    RESUMO = await pegar('/admin/resumo'); pintarContadores();
    renderCandidaturas(el);
  }));
  el.querySelectorAll('[data-liberar]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm(`Liberar o modo "${btn.dataset.tipo === 'ponto' ? 'Meu ponto' : 'Vendas'}" nessa conta agora?${btn.dataset.tipo === 'ponto' ? ' O ponto e a Tela 1 são criados com o endereço do pedido.' : ''}`)) return;
    const r = await api(`/admin/candidaturas/${btn.dataset.liberar}/liberar`, { method: 'POST' });
    if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'Não foi possível liberar.', 'err');
    toast('Modo liberado na conta.');
    RESUMO = await pegar('/admin/resumo'); pintarContadores();
    renderCandidaturas(el);
  }));
  el.querySelectorAll('[data-copiar-convite]').forEach((btn) => btn.addEventListener('click', () => {
    const link = `${window.location.origin}/convite.html?t=${encodeURIComponent(btn.dataset.copiarConvite)}`;
    navigator.clipboard?.writeText(link).then(() => toast('Link do convite copiado.'), () => prompt('Link:', link));
  }));
}

// ---------- convites ----------
async function renderConvites(el) {
  const convites = await pegar('/admin/convites');
  const corpo = `<table><thead><tr>
      <th data-ord>Criado</th><th>Papéis</th><th data-ord>Pra quem</th><th data-ord>Vale até</th><th data-ord>Situação</th><th>Conta criada</th><th></th>
    </tr></thead><tbody>
    ${convites.map((c) => `<tr data-filtro="${c.situacao}">
      <td>${data(c.criado_em)}</td>
      <td>${(c.papeis || []).map((x) => `<span class="badge badge-ok">${esc(PAPEIS[x] || x)}</span>`).join(' ')}</td>
      <td>${esc(c.nome_sugerido || '—')}<div class="u-dim u-fs-72">${esc(c.email_sugerido || '')}${c.candidatura_id ? ` · candidatura #${c.candidatura_id}` : ''}</div></td>
      <td>${data(c.expira_em)}</td>
      <td>${c.situacao === 'aberto' ? '<span class="badge badge-pendente">aberto</span>' : c.situacao === 'usado' ? `<span class="badge badge-ok">usado ${data(c.usado_em)}</span>` : '<span class="badge badge-err">expirado/revogado</span>'}</td>
      <td>${c.conta_nome ? esc(c.conta_nome) : '—'}</td>
      <td>${c.situacao === 'aberto' ? `<button class="btn ghost mini" data-copiar-link="${esc(c.link)}">Copiar link</button> <button class="btn ghost mini u-txt-erro" data-revogar="${c.id}">Revogar</button>` : ''}</td>
    </tr>`).join('')}
  </tbody></table>`;

  el.innerHTML = `
    <details class="bloco-novo" open>
      <summary class="btn ghost mini">+ Novo convite (sem candidatura)</summary>
      <form class="card u-mt-12 u-mw-520" id="formNovoConvite">
        <div><label>Papéis da conta que vai nascer</label>
          <div class="benef-lista">
            ${Object.entries(PAPEIS).map(([v, n]) => `<label class="benef-check"><input type="checkbox" name="papeis" value="${v}" ${v === 'ponto' ? 'checked' : ''}><span>${n}</span></label>`).join('')}
          </div></div>
        <div class="field-row">
          <div class="u-col"><label>Nome (sugestão, opcional)</label><input class="mini" name="nome_sugerido"></div>
          <div class="u-col"><label>E-mail (sugestão, opcional)</label><input class="mini" type="email" name="email_sugerido"></div>
          <div class="u-col-fixa-90"><label>Validade (dias)</label><input class="mini" type="number" name="validade_dias" value="7" min="1" max="60"></div>
        </div>
        <button class="btn primary" type="submit">Gerar link</button>
        <p class="form-msg" id="msgNovoConvite"></p>
      </form>
    </details>
    ${convites.length ? caixaTabela({
      chips: [{ valor: 'aberto', nome: 'Abertos' }, { valor: 'usado', nome: 'Usados' }, { valor: 'expirado', nome: 'Expirados' }, { valor: '', nome: 'Todos' }],
      html: corpo,
      dica: 'Convite é o único caminho de entrada de dono de ponto e de vendedor. Convite de ponto vindo de candidatura já cria o ponto e a Tela 1 quando a pessoa se cadastra.',
    }) : '<p class="empty-state">Nenhum convite gerado ainda.</p>'}`;

  if (convites.length) turbinarTabela(el.querySelector('.tabela-caixa'));
  document.getElementById('formNovoConvite').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovoConvite');
    const papeis = [...e.target.querySelectorAll('input[name="papeis"]:checked')].map((i) => i.value);
    if (!papeis.length) { msg.textContent = 'Marque ao menos um papel.'; msg.className = 'form-msg err'; return; }
    const r = await api('/admin/convites', { method: 'POST', body: JSON.stringify({
      papeis, nome_sugerido: e.target.nome_sugerido.value || null, email_sugerido: e.target.email_sugerido.value || null, validade_dias: Number(e.target.validade_dias.value) || 7,
    }) });
    if (!r.ok) { msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao gerar.'; msg.className = 'form-msg err'; return; }
    const { link } = await r.json();
    navigator.clipboard?.writeText(link).catch(() => {});
    prompt('Convite gerado (já copiado). Mande esse link pra pessoa:', link);
    renderConvites(el);
  });
  el.querySelectorAll('[data-copiar-link]').forEach((btn) => btn.addEventListener('click', () => {
    navigator.clipboard?.writeText(btn.dataset.copiarLink).then(() => toast('Link copiado.'), () => prompt('Link:', btn.dataset.copiarLink));
  }));
  el.querySelectorAll('[data-revogar]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Revogar esse convite? O link para de funcionar na hora.')) return;
    const r = await api(`/admin/convites/${btn.dataset.revogar}/revogar`, { method: 'POST' });
    if (!r.ok) return toast('Não foi possível revogar.', 'err');
    toast('Convite revogado.');
    renderConvites(el);
  }));
}

// ---------- custos fixos ----------
async function renderCustos(el) {
  const custos = await pegar('/admin/custos-fixos');
  const total = custos.filter((c) => c.ativo).reduce((t, c) => t + Number(c.valor_mensal), 0);
  const corpo = `<table><thead><tr><th data-ord>Nome</th><th data-ord>R$/mês</th><th>Observação</th><th data-ord>Entra na margem</th><th></th></tr></thead><tbody>
    ${custos.map((c) => `<tr data-filtro="${c.ativo ? 'ativo' : 'inativo'}">
      <td><input class="mini u-w-200" data-custo="nome" data-id="${c.id}" value="${esc(c.nome)}"></td>
      <td><input class="mini u-w-100" type="number" step="0.01" min="0" data-custo="valor_mensal" data-id="${c.id}" value="${c.valor_mensal}"></td>
      <td><input class="mini u-w-280" data-custo="observacao" data-id="${c.id}" value="${esc(c.observacao || '')}"></td>
      <td class="u-ta-c"><input type="checkbox" data-custo="ativo" data-id="${c.id}" ${c.ativo ? 'checked' : ''}></td>
      <td><button class="btn ghost mini u-txt-erro" data-excluir-custo="${c.id}">×</button></td>
    </tr>`).join('')}
  </tbody></table>`;

  el.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">Custos fixos ativos</span><b>${fmt(total)}</b><span class="kpi-caption">por mês, somados na margem da visão geral</span></div>
      <div class="kpi-card"><span class="kpi-label">Amortização das telas</span><b>${fmt(RESUMO.financeiro.amortizacaoMensal)}</b><span class="kpi-caption">vem do custo de cada tela (aba Telas)</span></div>
      <div class="kpi-card"><span class="kpi-label">Ajuda de custo aos pontos</span><b>${fmt(RESUMO.financeiro.custoPontosMensal)}</b><span class="kpi-caption">vem de cada ponto ativo</span></div>
    </div>
    <details class="bloco-novo">
      <summary class="btn ghost mini">+ Novo custo fixo</summary>
      <form class="card u-mt-12 u-mw-420" id="formNovoCusto">
        <div><label>Nome (ex.: DAS MEI, Contador, Domínio, Deslocamento)</label><input class="mini" name="nome" required></div>
        <div><label>Valor por mês (R$)</label><input class="mini" type="number" step="0.01" min="0" name="valor_mensal" required></div>
        <div><label>Observação</label><input class="mini" name="observacao"></div>
        <button class="btn primary" type="submit">Adicionar</button>
        <p class="form-msg" id="msgNovoCusto"></p>
      </form>
    </details>
    ${custos.length ? caixaTabela({ chips: [{ valor: '', nome: 'Todos' }, { valor: 'ativo', nome: 'Ativos' }, { valor: 'inativo', nome: 'Desligados' }], html: corpo, dica: 'Salva ao sair do campo. Custo anual? Lance o valor ÷ 12.' }) : '<p class="empty-state">Nenhum custo lançado.</p>'}`;

  if (custos.length) turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('[data-custo]').forEach((campo) => campo.addEventListener('change', async () => {
    const valor = campo.type === 'checkbox' ? campo.checked : (campo.dataset.custo === 'valor_mensal' ? Number(campo.value) : campo.value);
    if (await salvar(`/admin/custos-fixos/${campo.dataset.id}`, { [campo.dataset.custo]: valor }, campo)) { RESUMO = await pegar('/admin/resumo'); if (campo.dataset.custo !== 'nome' && campo.dataset.custo !== 'observacao') renderCustos(el); }
  }));
  el.querySelectorAll('[data-excluir-custo]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Excluir esse custo?')) return;
    const r = await api(`/admin/custos-fixos/${btn.dataset.excluirCusto}`, { method: 'DELETE' });
    if (r.ok) { RESUMO = await pegar('/admin/resumo'); renderCustos(el); }
  }));
  document.getElementById('formNovoCusto').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovoCusto');
    const r = await api('/admin/custos-fixos', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
    if (!r.ok) { msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao criar.'; msg.className = 'form-msg err'; return; }
    RESUMO = await pegar('/admin/resumo');
    renderCustos(el);
  });
}

// ---------- planos ----------
async function renderPlanos(el) {
  const [planos, beneficios] = await Promise.all([pegar('/admin/planos'), pegar('/admin/beneficios')]);

  // Lista todos, inclusive os indisponíveis: um benefício desativado
  // continua vinculado ao plano (só não aparece no site), e some daqui
  // significaria apagar esse vínculo no próximo clique.
  const opcoesBeneficio = (marcadosIds) => beneficios.map((b) => `
    <label class="benef-check">
      <input type="checkbox" value="${b.id}" ${marcadosIds.includes(b.id) ? 'checked' : ''}>
      <span class="u-op-55"${b.ativo ? '' : ''}>${esc(b.texto)}${b.ativo ? '' : ' <i>(indisponível)</i>'}</span>
    </label>`).join('');

  const porCiclo = {};
  planos.filter((p) => !p.fundador).forEach((p) => { (porCiclo[p.compromisso_meses] = porCiclo[p.compromisso_meses] || []).push(p); });
  const fundadores = planos.filter((p) => p.fundador);

  const linhaPlano = (p) => `<tr>
          <td><input class="mini u-w-120" data-campo="nome" data-id="${p.id}" value="${esc(p.nome)}">
            <div class="u-dim u-fs-72 u-mt-2">${esc(p.id)}${p.fundador ? '' : ` · ${CICLOS[p.compromisso_meses] || p.compromisso_meses + 'x'}`}</div></td>
          <td><input class="mini u-w-80" type="number" step="0.01" min="0" data-campo="valor_mensal" data-id="${p.id}" value="${p.valor_mensal}"></td>
          <td><b>${fmt(p.valor_mensal * p.compromisso_meses)}</b></td>
          <td><input class="mini u-w-60" type="number" min="1" max="3" data-campo="limite_criativos" data-id="${p.id}" value="${p.limite_criativos}"></td>
          <td><input class="mini u-w-60" type="number" min="1" data-campo="vagas" data-id="${p.id}" value="${p.vagas ?? ''}" placeholder="∞"></td>
          <td><input class="mini u-w-60" type="number" min="1" data-campo="ponto_apos_meses" data-id="${p.id}" value="${p.ponto_apos_meses ?? ''}" placeholder="—" title="Módulo: ao completar N meses de cobertura, o anunciante ganha direito a uma tela no comércio dele (vira candidatura de ponto)"></td>
          <td class="u-ta-c"><input type="checkbox" data-campo="preco_travado" data-id="${p.id}" ${p.preco_travado ? 'checked' : ''} title="Quem assinar paga esse valor até o fim do compromisso, mesmo que o plano mude de preço"></td>
          <td><input class="mini u-w-140" data-campo="rotulo" data-id="${p.id}" value="${esc(p.rotulo)}"></td>
          <td><div class="benef-lista" data-beneficios-de="${p.id}">${opcoesBeneficio(p.beneficio_ids || [])}</div></td>
          <td class="u-ta-c"><input type="checkbox" data-campo="destaque_no_site" data-id="${p.id}" ${p.destaque_no_site ? 'checked' : ''} title="Marca como 'Mais escolhido' na página de planos"></td>
          <td class="u-ta-c"><input type="checkbox" data-campo="ativo" data-id="${p.id}" ${p.ativo ? 'checked' : ''}></td>
        </tr>`;
  const cabecalho = `<tr><th>Nome</th><th>Valor mensal</th><th>Total do ciclo</th><th>Criativos</th><th>Vagas</th><th>Tela após (meses)</th><th>Travado</th><th>Rótulo</th><th>Benefícios</th><th>Destaque</th><th>Ativo</th></tr>`;

  el.innerHTML = `
    <details class="bloco-novo">
      <summary class="btn ghost mini">+ Novo plano (novo preço/promoção — não mexe no que já existe)</summary>
      <form class="card u-mt-12 u-mw-520" id="formNovoPlano">
        <div><label>ID único (ex.: destaque-black-friday)</label><input class="mini" name="id" required></div>
        <div><label>Tier</label><select class="mini" name="tier" required>
          <option value="essencial">Essencial</option><option value="destaque">Destaque</option><option value="maximo">Máximo</option>
        </select></div>
        <div><label>Nome exibido</label><input class="mini" name="nome" required></div>
        <div class="field-row">
          <div class="u-col"><label>Compromisso</label><select class="mini" name="compromisso_meses" required>
            ${Object.entries(CICLOS).map(([m, nome]) => `<option value="${m}" ${m === '3' ? 'selected' : ''}>${nome} (${m}x)</option>`).join('')}
          </select></div>
          <div class="u-col"><label>Frequência/dia</label><input class="mini" type="number" name="frequencia_dia" value="72" required></div>
        </div>
        <div class="field-row">
          <div class="u-col"><label>Valor mensal (R$)</label><input class="mini" type="number" step="0.01" name="valor_mensal" required></div>
          <div class="u-col"><label>Limite de criativos</label><input class="mini" type="number" name="limite_criativos" value="1" min="1" max="3" required></div>
        </div>
        <div><label>Cobertura</label><select class="mini" name="cobertura" required>
          <option value="todos_pontos">Todos os pontos</option><option value="tres_pontos_dia">3 pontos/dia</option><option value="um_ponto_dia">1 ponto/dia</option>
        </select></div>
        <div><label>Rótulo (ex.: "Preço fundador — travado por 12 meses")</label><input class="mini" name="rotulo"></div>
        <div class="field-row">
          <div class="u-col"><label>Vagas (vazio = sem teto)</label><input class="mini" type="number" name="vagas" min="1"></div>
          <div class="u-col"><label>Tela após N meses</label><input class="mini" type="number" name="ponto_apos_meses" min="1" title="Módulo cruzado: ao completar N meses o anunciante ganha uma tela no comércio dele"></div>
        </div>
        <div class="field-row">
          <label class="benef-check"><input type="checkbox" name="preco_travado" value="1"><span>Preço travado pelo compromisso</span></label>
          <label class="benef-check"><input type="checkbox" name="fundador" value="1"><span>Plano fundador (fora da grade de 3, só aparece com PROGRAMA_FUNDADOR_ATIVO=true)</span></label>
        </div>
        <div><label>Benefícios do plano</label><div class="benef-lista" id="novoPlanoBeneficios">${opcoesBeneficio([])}</div></div>
        <button class="btn primary" type="submit">Criar plano</button>
        <p class="form-msg" id="msgNovoPlano"></p>
      </form>
    </details>

    <div class="panel-head u-m-0 u-mt-24 u-mb-10">
      <h3>Programa fundador <span class="badge ${RESUMO.programaFundadorAtivo ? 'badge-ok' : 'badge-pendente'} u-ml-6">${RESUMO.programaFundadorAtivo ? 'ABERTO no site' : 'fechado (PROGRAMA_FUNDADOR_ATIVO≠true)'}</span></h3>
    </div>
    <p class="form-hint u-m-0 u-mb-8">Plano fundador fica fora da grade de 3 por modalidade. Ele só aparece no site quando a variável de ambiente PROGRAMA_FUNDADOR_ATIVO está em <code>true</code> <b>e</b> ainda há vaga. Preço travado, meses grátis e mínimo de telas são do próprio plano — dá pra usar em qualquer plano, não só no fundador.</p>
    ${fundadores.length ? `<div class="tabela-caixa"><div class="rolagem"><table><thead>${cabecalho}</thead><tbody>${fundadores.map(linhaPlano).join('')}</tbody></table></div></div>` : '<p class="empty-state u-py-6">Nenhum plano fundador. Crie um acima marcando "Plano fundador".</p>'}

    ${Object.keys(CICLOS).map((meses) => {
      const doCiclo = porCiclo[meses] || [];
      const ativos = doCiclo.filter((p) => p.ativo).length;
      return `
      <div class="panel-head u-m-0 u-mt-24 u-mb-10">
        <h3>${CICLOS[meses]} <span class="badge ${ativos >= 3 ? 'badge-err' : 'badge-ok'} u-ml-6">${ativos}/3 na vitrine</span></h3>
      </div>
      ${doCiclo.length ? `<div class="tabela-caixa"><div class="rolagem"><table><thead>${cabecalho}</thead><tbody>${doCiclo.map(linhaPlano).join('')}</tbody></table></div></div>` : '<p class="empty-state u-py-6">Nenhum plano nessa modalidade.</p>'}`;
    }).join('')}

    <p class="empty-state u-ta-l u-p-0 u-pt-16">
      Desativar um plano só tira ele do site — quem já assinou continua pagando o mesmo valor até cancelar.
      Pra lançar preço novo sem mexer no de quem já é cliente, crie um plano novo em vez de editar o existente.
      "Mín. telas": abaixo desse número de telas no ar, o que o anunciante pagar fica guardado (meses pendentes) e a cobertura liga sozinha quando a tela entrar.
      "Tela após": módulo cruzado — ao completar esse nº de meses de cobertura, o anunciante ganha direito a uma tela no comércio dele (aparece como bônus no painel; o resgate cai em Candidaturas). O módulo inverso (ponto que ganha anúncio grátis) fica em Opções de comodato.
    </p>`;

  el.querySelectorAll('[data-campo]').forEach((inp) => {
    inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'blur', async () => {
      let valor;
      if (inp.type === 'checkbox') valor = inp.checked;
      else if (inp.dataset.campo === 'nome' || inp.dataset.campo === 'rotulo') valor = inp.value || null;
      else valor = inp.value === '' ? null : Number(inp.value);
      if (!await salvar(`/admin/planos/${inp.dataset.id}`, { [inp.dataset.campo]: valor }, inp)) renderPlanos(el);
    });
  });

  el.querySelectorAll('[data-beneficios-de]').forEach((caixa) => caixa.addEventListener('change', () => {
    const ids = [...caixa.querySelectorAll('input:checked')].map((i) => Number(i.value));
    salvar(`/admin/planos/${caixa.dataset.beneficiosDe}`, { beneficio_ids: ids }, caixa);
  }));

  document.getElementById('formNovoPlano').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dados = Object.fromEntries(new FormData(e.target));
    dados.beneficio_ids = [...document.querySelectorAll('#novoPlanoBeneficios input:checked')].map((i) => Number(i.value));
    dados.preco_travado = !!dados.preco_travado;
    dados.fundador = !!dados.fundador;
    if (dados.vagas === '') delete dados.vagas;
    if (dados.ponto_apos_meses === '') delete dados.ponto_apos_meses;
    const msg = document.getElementById('msgNovoPlano');
    const r = await api('/admin/planos', { method: 'POST', body: JSON.stringify(dados) });
    if (!r.ok) { msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao criar.'; msg.className = 'form-msg err'; return; }
    toast('Plano criado.');
    renderPlanos(el);
  });
}

// ---------- benefícios ----------
async function renderBeneficios(el) {
  const beneficios = await pegar('/admin/beneficios');
  const corpo = `<table><thead><tr><th data-ord>Texto</th><th data-ord>Ordem</th><th data-ord>Disponível</th><th></th></tr></thead><tbody>
    ${beneficios.map((b) => `<tr data-filtro="${b.ativo ? 'ativo' : 'inativo'}">
      <td><input class="mini u-w-360" data-benef="texto" data-id="${b.id}" value="${esc(b.texto)}"></td>
      <td><input class="mini u-w-60" type="number" data-benef="ordem" data-id="${b.id}" value="${b.ordem}"></td>
      <td class="u-ta-c"><input type="checkbox" data-benef="ativo" data-id="${b.id}" ${b.ativo ? 'checked' : ''} title="Desmarcado some da lista dos planos sem apagar nada"></td>
      <td><button class="btn ghost mini" data-excluir="${b.id}">Excluir</button></td>
    </tr>`).join('')}
  </tbody></table>`;

  el.innerHTML = `
    <form class="card bloco-novo u-mw-520" id="formNovoBeneficio">
      <div><label>Novo benefício</label><input class="mini" name="texto" placeholder="ex.: Até 3 criativos ativos, revezando entre si" required></div>
      <div><label>Ordem (menor aparece primeiro)</label><input class="mini" type="number" name="ordem" value="0"></div>
      <button class="btn primary" type="submit">Criar benefício</button>
      <p class="form-msg" id="msgNovoBeneficio"></p>
    </form>
    ${beneficios.length ? caixaTabela({
      chips: [{ valor: '', nome: 'Todos' }, { valor: 'ativo', nome: 'Disponíveis' }, { valor: 'inativo', nome: 'Indisponíveis' }],
      html: corpo,
      dica: 'Excluir tira o benefício de todos os planos que o usavam.',
    }) : '<p class="empty-state">Nenhum benefício cadastrado.</p>'}`;

  if (beneficios.length) turbinarTabela(el.querySelector('.tabela-caixa'));

  el.querySelectorAll('[data-benef]').forEach((inp) => inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'blur', () => {
    const valor = inp.type === 'checkbox' ? inp.checked : (inp.dataset.benef === 'ordem' ? Number(inp.value) : inp.value);
    salvar(`/admin/beneficios/${inp.dataset.id}`, { [inp.dataset.benef]: valor }, inp);
  }));

  el.querySelectorAll('[data-excluir]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Excluir esse benefício de todos os planos?')) return;
    const r = await api(`/admin/beneficios/${btn.dataset.excluir}`, { method: 'DELETE' });
    toast(r.ok ? 'Benefício excluído.' : ((await r.json().catch(() => ({}))).erro || 'Não foi possível excluir.'), r.ok ? '' : 'err');
    renderBeneficios(el);
  }));

  document.getElementById('formNovoBeneficio').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovoBeneficio');
    const r = await api('/admin/beneficios', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
    if (!r.ok) { msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao criar.'; msg.className = 'form-msg err'; return; }
    renderBeneficios(el);
  });
}

// ---------- categorias ----------
async function renderCategorias(el) {
  const categorias = await pegar('/admin/categorias');
  const corpo = `<table><thead><tr><th data-ord>Nome</th><th data-ord>Aparece no cadastro</th><th></th></tr></thead><tbody>
    ${categorias.map((c) => `<tr data-filtro="${c.ativo ? 'ativo' : 'inativo'}">
      <td><input class="mini u-w-300" data-cat="nome" data-id="${c.id}" value="${esc(c.nome)}"></td>
      <td class="u-ta-c"><input type="checkbox" data-cat="ativo" data-id="${c.id}" ${c.ativo ? 'checked' : ''}></td>
      <td><button class="btn ghost mini" data-excluir="${c.id}">Excluir</button></td>
    </tr>`).join('')}
  </tbody></table>`;

  el.innerHTML = `
    <form class="card bloco-novo u-mw-420" id="formNovaCategoria">
      <div><label>Nova categoria</label><input class="mini" name="nome" placeholder="ex.: Tatuagem / piercing" required></div>
      <button class="btn primary" type="submit">Criar categoria</button>
      <p class="form-msg" id="msgNovaCategoria"></p>
    </form>
    ${categorias.length ? caixaTabela({
      chips: [{ valor: '', nome: 'Todas' }, { valor: 'ativo', nome: 'No cadastro' }, { valor: 'inativo', nome: 'Fora do cadastro' }],
      html: corpo,
      dica: 'Categoria já usada por alguém cadastrado não pode ser excluída — desmarque para parar de oferecer.',
    }) : '<p class="empty-state">Nenhuma categoria cadastrada.</p>'}`;

  if (categorias.length) turbinarTabela(el.querySelector('.tabela-caixa'));

  el.querySelectorAll('[data-cat]').forEach((inp) => inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'blur', () => {
    salvar(`/admin/categorias/${inp.dataset.id}`, { [inp.dataset.cat]: inp.type === 'checkbox' ? inp.checked : inp.value }, inp);
  }));

  el.querySelectorAll('[data-excluir]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Excluir essa categoria? É ela que impede concorrente do mesmo ramo na mesma tela.')) return;
    const r = await api(`/admin/categorias/${btn.dataset.excluir}`, { method: 'DELETE' });
    toast(r.ok ? 'Categoria excluída.' : ((await r.json().catch(() => ({}))).erro || 'Não foi possível excluir.'), r.ok ? '' : 'err');
    renderCategorias(el);
  }));

  document.getElementById('formNovaCategoria').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovaCategoria');
    const r = await api('/admin/categorias', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
    if (!r.ok) { msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao criar.'; msg.className = 'form-msg err'; return; }
    renderCategorias(el);
  });
}

// ---------- opções de comodato ----------
async function renderComodato(el) {
  const [opcoes, planos] = await Promise.all([pegar('/admin/planos-ponto'), pegar('/admin/planos')]);
  const selectPlano = (o) => `<select class="mini u-w-140" data-pp="plano_bonus_id" data-id="${o.id}">
      <option value="">— sem bônus —</option>
      ${planos.map((p) => `<option value="${esc(p.id)}" ${p.id === o.plano_bonus_id ? 'selected' : ''}>${esc(p.nome)} · ${CICLOS[p.compromisso_meses] || p.compromisso_meses + 'x'}</option>`).join('')}
    </select>`;
  el.innerHTML = `<div class="tabela-caixa"><div class="rolagem"><table><thead><tr>
      <th>Opção</th><th>Ajuda de custo (R$/mês)</th><th>Cota (espaços/hora)</th><th>Chamada no site</th><th>Benefícios (1 por linha)</th>
      <th>Bônus: plano de anúncio</th><th>após (meses)</th><th>por (meses)</th><th>Ordem</th><th>Ativa</th>
    </tr></thead><tbody>
      ${opcoes.map((o) => `<tr>
        <td class="u-ws-normal"><input class="mini u-w-120" data-pp="nome" data-id="${o.id}" value="${esc(o.nome)}">
          <div class="u-dim u-fs-72 u-mt-2">${esc(o.id)}</div></td>
        <td><input class="mini u-w-80" type="number" step="0.01" min="0" data-pp="ajuda_custo_mensal" data-id="${o.id}" value="${o.ajuda_custo_mensal}"></td>
        <td><input class="mini u-w-60" type="number" min="0" data-pp="cota_slots_hora" data-id="${o.id}" value="${o.cota_slots_hora}"></td>
        <td><textarea class="mini u-w-260 u-resize-v" data-pp="chamada" data-id="${o.id}" rows="3">${esc(o.chamada)}</textarea></td>
        <td><textarea class="mini u-w-240 u-resize-v" data-pp="beneficios" data-id="${o.id}" rows="4">${esc((o.beneficios || []).join('\n'))}</textarea></td>
        <td>${selectPlano(o)}</td>
        <td><input class="mini u-w-60" type="number" min="1" data-pp="plano_bonus_apos_meses" data-id="${o.id}" value="${o.plano_bonus_apos_meses ?? ''}" placeholder="—"></td>
        <td><input class="mini u-w-60" type="number" min="1" data-pp="plano_bonus_meses" data-id="${o.id}" value="${o.plano_bonus_meses ?? ''}" placeholder="—"></td>
        <td><input class="mini u-w-60" type="number" data-pp="ordem" data-id="${o.id}" value="${o.ordem}"></td>
        <td class="u-ta-c"><input type="checkbox" data-pp="ativo" data-id="${o.id}" ${o.ativo ? 'checked' : ''}></td>
      </tr>`).join('')}
    </tbody></table></div></div>
    <p class="empty-state u-ta-l u-p-0 u-pt-12">Ajuda de custo e cota são copiadas pro ponto no momento em que ele entra — mudar aqui não altera o que já foi combinado com quem já está na rede. "Bônus": módulo cruzado — ponto ativo há N meses ganha M meses do plano de anúncio escolhido, sem pagar (o dono resgata no painel dele).</p>`;

  el.querySelectorAll('[data-pp]').forEach((inp) => inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'blur', () => {
    let valor;
    if (inp.type === 'checkbox') valor = inp.checked;
    else if (inp.dataset.pp === 'beneficios') valor = inp.value.split('\n').map((l) => l.trim()).filter(Boolean);
    else if (['nome', 'chamada', 'plano_bonus_id'].includes(inp.dataset.pp)) valor = inp.value || null;
    else if (['plano_bonus_apos_meses', 'plano_bonus_meses'].includes(inp.dataset.pp)) valor = inp.value === '' ? null : Number(inp.value);
    else valor = Number(inp.value);
    salvar(`/admin/planos-ponto/${inp.dataset.id}`, { [inp.dataset.pp]: valor }, inp);
  }));
}

// ---------- cobranças ----------
async function renderCobrancas(el) {
  const cobrancas = await pegar('/admin/cobrancas');
  const total = cobrancas.reduce((t, c) => t + Number(c.valor), 0);
  const pendentes = cobrancas.filter((c) => c.nota_fiscal_status !== 'emitida').length;

  const corpo = `<table><thead><tr>
      <th data-ord>ID</th><th data-ord>Anunciante</th><th data-ord>Valor</th><th data-ord>Data</th><th>Nota fiscal</th>
    </tr></thead><tbody>
    ${cobrancas.map((c) => `<tr data-filtro="${c.nota_fiscal_status}">
      <td>${c.id}</td>
      <td><b>${esc(c.nome_empresa)}</b></td>
      <td>${fmt(c.valor)}</td>
      <td>${data(c.criado_em)}</td>
      <td>${c.nota_fiscal_status === 'emitida'
        ? `<span class="badge badge-ok">emitida</span> <a href="${esc(c.nota_fiscal_url)}" target="_blank" rel="noopener">ver PDF</a>`
        : `<input type="file" accept="application/pdf" class="mini u-w-140" data-cobranca="${c.id}">`}</td>
    </tr>`).join('')}
  </tbody></table>`;

  el.innerHTML = cobrancas.length ? `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">Total confirmado</span><b>${fmt(total)}</b><span class="kpi-caption">${cobrancas.length} cobrança(s)</span></div>
      <div class="kpi-card"><span class="kpi-label">Notas por emitir</span><b>${pendentes}</b><span class="kpi-caption">envie o PDF na linha</span></div>
    </div>
    ${caixaTabela({
      chips: [{ valor: '', nome: 'Todas' }, { valor: 'pendente', nome: 'Sem nota' }, { valor: 'emitida', nome: 'Com nota' }],
      html: corpo,
      dica: 'Selecionar o PDF já envia a nota.',
    })}` : '<p class="empty-state">Nenhuma cobrança confirmada ainda.</p>';

  if (!cobrancas.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('input[data-cobranca]').forEach((input) => input.addEventListener('change', async () => {
    if (!input.files[0]) return;
    const form = new FormData();
    form.append('arquivo', input.files[0]);
    const r = await fetch(`${API_BASE_URL}/admin/cobrancas/${input.dataset.cobranca}/nota-fiscal`, { method: 'PATCH', credentials: 'include', body: form });
    toast(r.ok ? 'Nota fiscal anexada.' : 'Não foi possível anexar a nota.', r.ok ? '' : 'err');
    if (r.ok) { RESUMO = await pegar('/admin/resumo'); pintarContadores(); renderCobrancas(el); }
  }));
}

// ---------- comissões ----------
async function renderComissoes(el) {
  const comissoes = await pegar('/admin/comissoes');
  const aReceber = comissoes.filter((c) => !c.pago_em);
  const totalAPagar = aReceber.reduce((t, c) => t + Number(c.comissao_valor), 0);

  // Agrupa por vendedor: na hora de pagar, o que interessa é "quanto pro
  // Fulano", não linha a linha.
  const porVendedor = {};
  aReceber.forEach((c) => {
    porVendedor[c.vendedor_nome] = porVendedor[c.vendedor_nome] || { total: 0, pix: c.chave_pix, qtd: 0 };
    porVendedor[c.vendedor_nome].total += Number(c.comissao_valor);
    porVendedor[c.vendedor_nome].qtd += 1;
  });

  const corpo = `<table><thead><tr>
      <th data-ord>Vendedor</th><th data-ord>Anunciante</th><th data-ord>Venda</th><th data-ord>Comissão</th><th data-ord>Data</th><th>Chave Pix</th><th data-ord>Situação</th>
    </tr></thead><tbody>
    ${comissoes.map((c) => `<tr data-filtro="${c.pago_em ? 'pago' : 'aberto'}">
      <td><b>${esc(c.vendedor_nome)}</b></td>
      <td>${esc(c.nome_empresa)}</td>
      <td>${fmt(c.valor_confirmado)}</td>
      <td><b>${fmt(c.comissao_valor)}</b></td>
      <td>${data(c.criado_em)}</td>
      <td>${esc(c.chave_pix || '—')}</td>
      <td>${c.pago_em
        ? `<span class="badge badge-ok">pago ${data(c.pago_em)}</span> <button class="btn ghost mini" data-pago="${c.id}" data-valor="0">Desfazer</button>`
        : `<button class="btn primary mini" data-pago="${c.id}" data-valor="1">Marcar como paga</button>`}</td>
    </tr>`).join('')}
  </tbody></table>`;

  el.innerHTML = comissoes.length ? `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">Total a pagar</span><b>${fmt(totalAPagar)}</b><span class="kpi-caption">${aReceber.length} comissão(ões) em aberto</span></div>
      ${Object.entries(porVendedor).slice(0, 3).map(([nome, d]) => `
        <div class="kpi-card"><span class="kpi-label">${esc(nome)}</span><b>${fmt(d.total)}</b><span class="kpi-caption">${esc(d.pix || 'sem chave Pix')}</span></div>`).join('')}
    </div>
    ${caixaTabela({
      chips: [{ valor: 'aberto', nome: 'A pagar' }, { valor: 'pago', nome: 'Pagas' }, { valor: '', nome: 'Todas' }],
      html: corpo,
      dica: 'Marcar como paga só registra aqui — o Pix é feito por fora.',
    })}` : '<p class="empty-state">Nenhuma comissão gerada ainda. Elas aparecem quando um anunciante indicado por um vendedor tem o pagamento confirmado.</p>';

  if (!comissoes.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('[data-pago]').forEach((btn) => btn.addEventListener('click', async () => {
    if (await salvar(`/admin/comissoes/${btn.dataset.pago}`, { pago: btn.dataset.valor === '1' })) renderComissoes(el);
  }));
}

// ---------- devoluções por arrependimento ----------
// O estorno acontece FORA daqui: a API do San Checkout não expõe estorno, quem
// devolve é uma pessoa no painel do Checkout/Asaas. Esta tela existe pra que o
// pedido não vire um e-mail que alguém esquece — é dinheiro que a lei manda
// devolver, com prazo.
async function renderArrependimentos(el) {
  const pedidos = await pegar('/admin/arrependimentos');
  const abertos = pedidos.filter((p) => p.status === 'pendente');
  const totalAberto = abertos.reduce((t, p) => t + Number(p.valor_a_estornar), 0);

  const corpo = `<table><thead><tr>
      <th data-ord>Protocolo</th><th data-ord>Anunciante</th><th>CPF/CNPJ</th><th data-ord>Valor</th>
      <th data-ord>Pedido em</th><th data-ord>Situação</th><th></th>
    </tr></thead><tbody>
    ${pedidos.map((p) => `<tr data-filtro="${p.status}">
      <td><b>${p.id}</b></td>
      <td>${esc(p.nome_empresa)}<div class="u-dim u-fs-72">${esc(p.contato_email)}</div></td>
      <td>${esc(p.cpf_cnpj)}</td>
      <td><b>${fmt(p.valor_a_estornar)}</b></td>
      <td>${data(p.pedido_em)}</td>
      <td>${p.status === 'estornado'
        ? `<span class="badge badge-ok">devolvido ${data(p.estornado_em)}</span>`
        : '<span class="badge badge-pendente">a devolver</span>'}</td>
      <td>${p.status === 'estornado'
        ? `<span class="u-dim u-fs-72">${esc(p.comprovante || '—')}</span>`
        : `<input class="u-w-160" placeholder="id do estorno" data-comp="${p.id}">
           <button class="btn primary mini" data-estornado="${p.id}">Registrar devolução</button>`}</td>
    </tr>`).join('')}
  </tbody></table>`;

  el.innerHTML = pedidos.length ? `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">A devolver</span><b>${fmt(totalAberto)}</b><span class="kpi-caption">${abertos.length} pedido(s) em aberto</span></div>
    </div>
    ${caixaTabela({
      chips: [{ valor: 'pendente', nome: 'A devolver' }, { valor: 'estornado', nome: 'Devolvidas' }, { valor: '', nome: 'Todas' }],
      html: corpo,
      dica: 'A devolução é feita no painel do San Checkout/Asaas. Aqui você registra o comprovante pra fechar o pedido.',
    })}` : '<p class="empty-state">Ninguém desistiu de uma contratação até agora.</p>';

  if (!pedidos.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('[data-estornado]').forEach((btn) => btn.addEventListener('click', async () => {
    const campo = el.querySelector(`[data-comp="${btn.dataset.estornado}"]`);
    if (await salvar(`/admin/arrependimentos/${btn.dataset.estornado}/estornado`, { comprovante: campo.value.trim() })) {
      renderArrependimentos(el);
    }
  }));
}

// ---------- eventos pendentes ----------
async function renderEventos(el) {
  const eventos = await pegar('/admin/eventos-pendentes');
  el.innerHTML = eventos.length ? `<div class="tabela-caixa"><div class="rolagem"><table><thead><tr>
      <th>ID</th><th>Motivo</th><th>Quando</th><th>Dados recebidos</th><th></th>
    </tr></thead><tbody>
    ${eventos.map((e) => `<tr>
      <td>${e.id}</td>
      <td><b>${esc(e.motivo)}</b></td>
      <td>${new Date(e.criado_em).toLocaleString('pt-BR')}</td>
      <td class="u-ws-normal"><details><summary class="u-pointer u-txt-link">ver payload</summary>
        <pre class="u-fs-72 u-bg-alt u-p-8 u-r-6 u-o-auto u-mw-460">${esc(JSON.stringify(e.payload, null, 2))}</pre></details></td>
      <td><button class="btn ghost mini" data-resolver="${e.id}">Marcar resolvido</button></td>
    </tr>`).join('')}
  </tbody></table></div></div>` : '<p class="empty-state">Nenhum evento pendente de revisão.</p>';

  el.querySelectorAll('button[data-resolver]').forEach((btn) => btn.addEventListener('click', async () => {
    if (await salvar(`/admin/eventos-pendentes/${btn.dataset.resolver}`, {})) {
      RESUMO = await pegar('/admin/resumo');
      pintarContadores();
      renderEventos(el);
    }
  }));
}
