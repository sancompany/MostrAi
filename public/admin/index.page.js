// ---------- base ----------
function api(caminho, opts = {}) {
  return fetch(`${API_BASE_URL}${caminho}`, {
    ...opts,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}
const pegar = async (caminho) => (await api(caminho)).json();

function fmt(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function num(v) {
  return Number(v || 0).toLocaleString('pt-BR');
}
const data = (v) => window.dataBR(v);

// Nome de ponto/empresa chega por formulário público, sem autenticação —
// vai pra innerHTML aqui dentro da sessão do admin, então escapa sempre.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

let toastTimer;
function toast(texto, tipo) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = tipo === 'err' ? 'toast err' : 'toast';
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      el.hidden = true;
    },
    tipo === 'err' ? 5000 : 1800,
  );
}

// Salvar edição inline com retorno visual. Todas as telas passam por aqui —
// antes cada uma disparava o PATCH e ignorava a resposta, então um erro do
// servidor sumia sem ninguém ver e o campo continuava mostrando o valor novo.
async function salvar(caminho, corpo, campo) {
  const r = await api(caminho, { method: 'PATCH', body: JSON.stringify(corpo) });
  if (r.ok) {
    if (campo) {
      campo.classList.remove('flash-ok');
      void campo.offsetWidth;
      campo.classList.add('flash-ok');
    }
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
  if (!tabela?.tBodies[0]) return;
  const busca = caixa.querySelector('.busca');
  const contagem = caixa.querySelector('[data-contagem]');
  const linhas = () => [...tabela.tBodies[0].rows];

  function aplicar() {
    const termo = (busca ? busca.value : '').toLowerCase().trim();
    const chipAtivo = caixa.querySelector('.chip.active');
    const filtro = chipAtivo ? chipAtivo.dataset.filtro || '' : '';
    let visiveis = 0;
    linhas().forEach((tr) => {
      const casaTermo = !termo || tr.textContent.toLowerCase().includes(termo);
      const casaFiltro = !filtro || (tr.dataset.filtro || '').split(' ').includes(filtro);
      tr.hidden = !(casaTermo && casaFiltro);
      if (!tr.hidden) visiveis += 1;
    });
    if (contagem) contagem.textContent = `${visiveis} de ${linhas().length}`;
    mostrarVazio(visiveis, linhas().length, termo || filtro);
  }

  // Tabela sem nenhuma linha aparecia como um cabecalho solto sobre o vazio —
  // no admin recem-instalado (que e o estado do primeiro dia) isso acontece em
  // quase toda aba, e nao da pra saber se e "nao tem nada" ou "quebrou".
  // Tambem cobre a busca que nao achou nada.
  function mostrarVazio(visiveis, total, filtrando) {
    let aviso = caixa.querySelector('[data-vazio]');
    if (visiveis > 0) {
      if (aviso) aviso.hidden = true;
      return;
    }
    if (!aviso) {
      aviso = document.createElement('p');
      aviso.className = 'empty-state';
      aviso.setAttribute('data-vazio', '');
      caixa.querySelector('.rolagem').insertAdjacentElement('afterend', aviso);
    }
    aviso.hidden = false;
    aviso.textContent = total === 0 ? 'Nada cadastrado aqui ainda.' : 'Nenhuma linha com esse filtro ou essa busca.';
    if (!filtrando && total === 0) aviso.textContent = 'Nada cadastrado aqui ainda.';
  }

  if (busca) busca.addEventListener('input', aplicar);
  caixa.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      caixa.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
      chip.classList.add('active');
      aplicar();
    }),
  );

  tabela.querySelectorAll('th[data-ord]').forEach((th) =>
    th.addEventListener('click', () => {
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
      linhas()
        .sort((a, b) => {
          const x = valorDe(a);
          const y = valorDe(b);
          const nx = parseFloat(
            x
              .replace(/\./g, '')
              .replace(',', '.')
              .replace(/[^\d.-]/g, ''),
          );
          const ny = parseFloat(
            y
              .replace(/\./g, '')
              .replace(',', '.')
              .replace(/[^\d.-]/g, ''),
          );
          const cmp =
            x !== '' && y !== '' && !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : x.localeCompare(y, 'pt-BR');
          return desc ? -cmp : cmp;
        })
        .forEach((tr) => corpo.appendChild(tr));
    }),
  );

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
// Dois status desde 17/09/2026 (migration 045). Tela quebrada não é mais
// estado do PONTO — é estado da tela, em TELA_STATUS logo abaixo.
const PONTO_STATUS = {
  a_instalar: 'A instalar',
  em_operacao: 'Em operação',
};
// `status` deixou de ser estado operacional (16/09/2026) — só distingue
// comum de parceiro (substitui o antigo flag "fundador"). O que bloqueia
// login/veiculação é `suspenso`, mostrado à parte (ver ANUNCIANTE_SITUACAO).
const ANUNCIANTE_STATUS = { comum: 'Comum', parceiro: 'Parceiro' };
// Situação operacional calculada no backend (GET /admin/resumo) a partir de
// `suspenso` + `plano_id` + `data_expiracao` — não é mais o campo `status`.
const ANUNCIANTE_SITUACAO = { ativo: 'Ativo', suspenso: 'Suspenso', sem_plano: 'Sem plano' };
const VENDEDOR_STATUS = { aprovado: 'Aprovado', inativo: 'Inativo' };
const TELA_STATUS = { ativo: 'Ativa', reparo: 'Em reparo', inativo: 'Inativa' };
const PAPEIS = { anunciante: 'Anunciante', ponto: 'Dono de ponto', vendedor: 'Vendedor' };
const CRIATIVO_STATUS = { pendente: 'Em análise', aprovado: 'Aprovado', reprovado: 'Reprovado' };
const CICLOS = { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };
// Mesma conta da vitrine (public/planos.page.js): o número grande que o
// cliente vê sai do dado, não de texto guardado. Aqui ele aparece ao lado do
// campo pra o dono conferir o efeito do que está digitando.
const HORAS_ABERTO_DIA = 12;
const DIAS_MES = 30;
function horasDeTelaPorMes(p) {
  if (!p.segundos_por_hora || !p.pontos_incluidos) return '';
  const h = Math.round((p.segundos_por_hora * p.pontos_incluidos * HORAS_ABERTO_DIA * DIAS_MES) / 3600);
  return `= até ${h}h de tela/mês`;
}

const TROCA_STATUS = { pendente: 'Esperando pagamento', pago: 'Paga', cancelado: 'Cancelada' };

function selectStatus(mapa, atual, attrs) {
  return `<select class="mini" ${attrs}>
    ${Object.entries(mapa)
      .map(([v, nome]) => `<option value="${v}" ${v === atual ? 'selected' : ''}>${nome}</option>`)
      .join('')}
  </select>`;
}

// ---------- navegação ----------
const NAV = [
  {
    grupo: 'Início',
    itens: [
      { id: 'resumo', nome: 'Visão geral' },
      { id: 'metrica', nome: 'Métrica' },
    ],
  },
  {
    grupo: 'Entrada',
    itens: [
      { id: 'candidaturas', nome: 'Candidaturas', fila: 'candidaturas' },
      { id: 'contato', nome: 'Mensagens do site', fila: 'contato' },
      { id: 'convites', nome: 'Convites' },
    ],
  },
  {
    grupo: 'Operação',
    itens: [
      { id: 'criativos', nome: 'Fila de criativos', fila: 'criativos' },
      { id: 'meusanuncios', nome: 'Meus anúncios' },
      { id: 'pontos', nome: 'Pontos', fila: 'pontos' },
      { id: 'telas', nome: 'Telas', fila: 'offline' },
      { id: 'anunciantes', nome: 'Anunciantes' },
      { id: 'vendedores', nome: 'Vendedores' },
    ],
  },
  {
    grupo: 'Catálogo',
    itens: [
      { id: 'planos', nome: 'Planos' },
      { id: 'planosarquivados', nome: 'Planos arquivados' },
      { id: 'beneficios', nome: 'Benefícios' },
      { id: 'categorias', nome: 'Categorias' },
      { id: 'comodato', nome: 'Opções de comodato' },
    ],
  },
  {
    grupo: 'Financeiro',
    itens: [
      { id: 'cobrancas', nome: 'Cobranças', fila: 'notas' },
      { id: 'trocas', nome: 'Trocas de plano' },
      { id: 'comissoes', nome: 'Comissões' },
      { id: 'pagamentospontos', nome: 'Pagar os pontos' },
      { id: 'arrependimentos', nome: 'Devoluções', fila: 'arrependimentos' },
      { id: 'custos', nome: 'Custos fixos' },
      { id: 'eventos', nome: 'Eventos pendentes', fila: 'eventos' },
    ],
  },
];

const SUBTITULOS = {
  resumo: 'O que precisa de você agora, o resultado do mês e a fotografia da rede.',
  metrica:
    'A margem mês a mês, onde as pessoas param no caminho até pagar, e quanto tempo suas filas demoram. Tudo ignorando a sua própria conta e as contas de teste.',
  criativos: 'Anúncios enviados pelos anunciantes esperando aprovação antes de entrar no ar.',
  candidaturas: 'Quem pediu pra ser ponto ou vendedor pelo site. Você conversa, e se fechar, gera o convite daqui.',
  contato:
    'Quem escreveu pelo formulário do site. É também o canal de pedido sobre dados pessoais (LGPD), que tem prazo pra responder. A coluna "aviso" diz se o e-mail chegou na sua caixa; quando não chegou, esta tela é o único lugar onde a mensagem existe.',
  convites:
    'Links de cadastro gerados por você: quem entra por eles nasce com os papéis marcados. Uso único, com validade.',
  pontos:
    'Comércios da rede: status, comodato, ajuda de custo, cota e acabamento. As telas de cada ponto ficam em "Telas".',
  telas: 'Cada TV/dispositivo: chave do aparelho, PIN do painel, custo e último sinal. Uma tela = uma playlist.',
  anunciantes:
    'Todas as contas, com os papéis vindos do convite. "Subir anúncio" põe a peça pronta direto na conta do cliente, já aprovada: ela é feita fora do site e combinada no WhatsApp.',
  vendedores: 'Contas com papel de vendedor: cupom, Pix e percentual de comissão.',
  planos: 'Preços do site. Cada modalidade mostra no máximo 3 planos na vitrine.',
  planosarquivados:
    'Versões aposentadas por uma edição. Continuam cobrando igual pra quem assinou nelas, por isso não são apagadas. A coluna "contas ativas" é o número que um dia torna seguro apagar uma versão.',
  beneficios: 'Catálogo de benefícios reaproveitado por todos os planos.',
  categorias: 'Segmentos usados no cadastro, para impedir concorrente direto na mesma tela.',
  comodato:
    'O que o dono do ponto escolhe no "Seja um ponto": receber os R$ 50 com o plano básico junto, ou trocar os R$ 50 pelo Essencial inteiro.',
  cobrancas: 'Pagamentos confirmados e emissão de nota fiscal.',
  trocas:
    'Quem trocou de plano no meio do período: de qual plano pra qual, quanto pagou de diferença e quando. O pago também entra em Cobranças; aqui é a lista de quem subiu de plano.',
  comissoes: 'Quanto cada vendedor tem a receber, e o Pix pra pagar.',
  pagamentospontos:
    'A ajuda de custo do comodato, ponto a ponto. Lance o mês e quite quando pagar, e isso aparece no extrato do dono do ponto.',
  custos: 'Custos mensais que entram na margem: MEI, contador, domínio, deslocamento... o que você lançar aqui.',
  eventos: 'Eventos do San Checkout que não deram pra correlacionar sozinhos.',
  arrependimentos:
    'Quem desistiu da contratação dentro dos 7 dias da lei. A cobrança já foi cancelada e o anúncio já saiu do ar. Falta devolver o dinheiro no painel do Checkout e registrar aqui.',
  meusanuncios:
    'A conta de anunciante do próprio Mostraí: anuncia a rede nas telas da rede, sem plano e sem cobrança. Criativos ilimitados.',
};

let RESUMO = null;

function montarNav() {
  document.getElementById('nav').innerHTML = NAV.map(
    (g) => `
    <div class="nav-grupo">${g.grupo}</div>
    ${g.itens
      .map(
        (i) => `<button type="button" class="nav-item" data-aba="${i.id}" ${i.fila ? `data-fila="${i.fila}"` : ''}>
      <span>${i.nome}</span><span class="cont" hidden></span>
    </button>`,
      )
      .join('')}
  `,
  ).join('');
}

// Contadores no menu — o admin vê o que está pendente sem abrir aba nenhuma.
function pintarContadores() {
  // `RESUMO.filas?.` e nao `RESUMO.filas.`: resposta parcial de /admin/resumo
  // derrubava o menu inteiro com "Cannot read properties of undefined", e um
  // menu morto esconde TODAS as filas — justo quando algo ja esta errado no
  // servidor. Contador zerado e degradacao; menu quebrado e apagao.
  if (!RESUMO) return;
  document.querySelectorAll('.nav-item[data-fila]').forEach((btn) => {
    const qtd = RESUMO.filas?.[btn.dataset.fila] || 0;
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
  if (!RESUMO || forcarResumo) {
    RESUMO = await pegar('/admin/resumo');
    pintarContadores();
  }

  const telas = {
    resumo: renderResumo,
    candidaturas: renderCandidaturas,
    contato: renderContato,
    convites: renderConvites,
    criativos: renderCriativos,
    pontos: renderPontos,
    telas: renderTelas,
    anunciantes: renderAnunciantes,
    vendedores: renderVendedores,
    planos: renderPlanos,
    beneficios: renderBeneficios,
    categorias: renderCategorias,
    comodato: renderComodato,
    cobrancas: renderCobrancas,
    trocas: renderTrocas,
    comissoes: renderComissoes,
    custos: renderCustos,
    eventos: renderEventos,
    meusanuncios: renderMeusAnuncios,
    arrependimentos: renderArrependimentos,
    planosarquivados: renderPlanosArquivados,
    metrica: renderMetrica,
    pagamentospontos: renderPagamentosPontos,
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
document
  .getElementById('btnRecarregar')
  .addEventListener('click', () => irPara(location.hash.slice(1) || 'resumo', true));
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
      body: JSON.stringify({
        usuario: document.getElementById('usuario').value,
        senha: document.getElementById('senha').value,
      }),
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
api('/admin/resumo').then((r) => {
  if (r.ok) mostrarApp();
});

// ---------- visão geral ----------
const ALERTAS = [
  { fila: 'criativos', aba: 'criativos', texto: 'criativo(s) esperando aprovação', urgente: true },
  { fila: 'offline', aba: 'telas', texto: 'tela(s) ativas sem dar sinal', urgente: true },
  { fila: 'candidaturas', aba: 'candidaturas', texto: 'candidatura(s) nova(s) pra responder' },
  { fila: 'eventos', aba: 'eventos', texto: 'evento(s) de pagamento pra revisar', urgente: true },
  { fila: 'pontos', aba: 'pontos', texto: 'ponto(s) candidatos aguardando triagem' },
  { fila: 'notas', aba: 'cobrancas', texto: 'nota(s) fiscal(is) por emitir' },
  {
    fila: 'arrependimentos',
    aba: 'arrependimentos',
    texto: 'devolução(ões) por arrependimento a pagar',
    urgente: true,
  },
];

function barrasHorizontais(linhas, mapa) {
  if (!linhas.length) return '<p class="empty-state u-py-8">Nada cadastrado ainda.</p>';
  const max = Math.max(...linhas.map((l) => l.qtd)) || 1;
  return `<div class="bar-chart-h">${linhas
    .map(
      (l) => `
    <div class="row">
      <span class="nome">${esc(mapa[l.status] || l.status)}</span>
      <span class="track"><span class="fill" data-pct="${(l.qtd / max) * 100}"></span></span>
      <span class="valor">${l.qtd}</span>
    </div>`,
    )
    .join('')}</div>`;
}

// Linha da conciliação diária na Visão geral. Ela é o que salva quem pagou e
// cujo webhook se perdeu; sem esta linha, não havia onde responder "ela rodou
// hoje?" — e o cron ainda está por configurar no Northflank.
function linhaConciliacao(c) {
  if (!c) {
    return `<div class="tudo-em-dia u-mb-20"><b>A conciliação nunca rodou por aqui.</b>
      Ela é a rede de segurança de quem paga e cujo aviso do Checkout se perde. Rode <code>npm run conciliar</code> uma vez por dia.</div>`;
  }
  const horas = Math.floor((Date.now() - new Date(c.terminouEm).getTime()) / 3600000);
  const atrasada = horas >= 36;
  const problema = c.abortou || c.falhas > 0 || atrasada;
  const quando = horas < 1 ? 'há menos de uma hora' : horas < 48 ? `há ${horas}h` : `em ${data(c.terminouEm)}`;
  const detalhe = c.abortou
    ? `abortou: ${esc(c.abortou)}`
    : `${c.verificadas} assinatura(s) verificada(s) · ${c.aplicadas} ciclo(s) aplicado(s)` +
      `${c.expiradas ? ` · ${c.expiradas} cobertura(s) vencida(s) suspensa(s)` : ''}` +
      `${c.avisados ? ` · ${c.avisados} aviso(s) de fim de cobertura` : ''}` +
      `${c.falhas ? ` · ${c.falhas} falha(s)` : ''}`;
  return `<div class="${problema ? 'alertas' : 'tudo-em-dia'} u-mb-20">
    <b>Conciliação ${quando}${atrasada ? ' (atrasada)' : ''}.</b> ${detalhe}
  </div>`;
}

// "Tudo em dia" no primeiro dia de uso diz exatamente o contrario do que o
// dono precisa ouvir: nao ha fila porque nao ha nada — nem ponto, nem conta.
function redeVazia(rede) {
  const contas = (rede.anunciantesPorStatus || []).reduce((soma, r) => soma + Number(r.qtd || 0), 0);
  return !rede.pontosAtivos && !rede.telasAtivas && contas === 0;
}

async function renderResumo(el) {
  const { filas, financeiro, rede } = RESUMO;
  const pendentes = ALERTAS.filter((a) => (filas[a.fila] || 0) > 0);
  const entrega = rede.programadas30d ? Math.round((rede.exibicoes30d / rede.programadas30d) * 100) : null;
  const meses = financeiro.faturamentoPorMes || [];
  const maxFat = Math.max(...meses.map((m) => Number(m.total)), 1);
  const margemOk = financeiro.margemMensal >= 0;

  el.innerHTML = `
    ${
      pendentes.length
        ? `<div class="alertas">${pendentes
            .map(
              (a) => `
          <button type="button" class="alerta ${a.urgente ? 'urgente' : ''}" data-ir="${a.aba}">
            <b>${filas[a.fila]}</b><span>${a.texto}</span>
          </button>`,
            )
            .join('')}</div>`
        : redeVazia(rede)
          ? `<div class="tudo-em-dia"><b>Rede em montagem.</b> Nenhuma fila esperando você, e nenhum ponto no ar ainda.
             Os primeiros passos: <a href="#pontos">cadastrar o primeiro ponto</a>, gerar a chave da tela em
             <a href="#telas">Telas</a>, e pôr o anúncio da própria Mostraí no ar por
             <a href="#meusanuncios">Meus anúncios</a>. Tela vazia é tela sem prova social.</div>`
          : '<div class="tudo-em-dia"><b>Tudo em dia.</b> Nenhuma fila esperando você agora.</div>'
    }

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

    ${linhaConciliacao(RESUMO.conciliacao)}

    <div class="dashboard-grid">
      <div class="panel">
        <div class="panel-head"><h3>Faturamento confirmado</h3><span class="kpi-caption">últimos 6 meses</span></div>
        ${
          meses.length
            ? `<div class="bar-chart">${meses
                .map((m) => {
                  const [ano, mes] = m.mes.split('-');
                  return `<div class="bar-col" title="${m.mes}: ${fmt(m.total)}">
            <div class="bar" data-pct="${Math.max(2, (Number(m.total) / maxFat) * 100)}"></div>
            <span class="bar-label">${mes}/${ano.slice(2)}</span>
          </div>`;
                })
                .join('')}</div>`
            : '<p class="empty-state u-py-14">Nenhuma cobrança confirmada ainda.</p>'
        }
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Pontos por status</h3></div>
        ${barrasHorizontais(rede.pontosPorStatus, PONTO_STATUS)}
        <div class="panel-head u-mt-22"><h3>Anunciantes por situação</h3></div>
        ${barrasHorizontais(
          rede.anunciantesPorSituacao.map((r) => ({ status: r.situacao, qtd: r.qtd })),
          ANUNCIANTE_SITUACAO,
        )}
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
      ${Object.entries(CRIATIVO_STATUS)
        .map(
          ([v, nome]) =>
            `<button type="button" class="chip ${v === status ? 'active' : ''}" data-status="${v}">${nome}</button>`,
        )
        .join('')}
    </div>
    ${
      criativos.length
        ? `<div class="criativo-fila">${criativos
            .map((c) => {
              const url = c.arquivo_normalizado_url || c.arquivo_original_url;
              return `<div class="item">
        ${
          url && ehVideo(url)
            ? `<video class="midia" src="${esc(url)}" muted loop playsinline controls poster="${esc(c.thumbnail_url || '')}"></video>`
            : url
              ? `<img class="midia" src="${esc(url)}" alt="">`
              : '<div class="midia"></div>'
        }
        <div class="dados">
          <b>${esc(nomePor[c.anunciante_id] || `Anunciante #${c.anunciante_id}`)}</b>
          <small>#${c.id} · ${c.duracao_segundos ? `${c.duracao_segundos}s · ` : ''}enviado ${data(c.created_at)}</small>
        </div>
        ${
          status === 'pendente'
            ? `<div class="acoes">
          <button class="btn primary mini" data-acao="aprovado" data-id="${c.id}">Aprovar</button>
          <button class="btn ghost mini" data-acao="reprovado" data-id="${c.id}">Reprovar</button>
        </div>`
            : `<div class="acoes">
          <button class="btn ghost mini" data-acao="${status === 'aprovado' ? 'reprovado' : 'aprovado'}" data-id="${c.id}">Mudar para ${status === 'aprovado' ? 'reprovado' : 'aprovado'}</button>
        </div>`
        }
      </div>`;
            })
            .join('')}</div>`
        : `<p class="empty-state">Nenhum criativo ${CRIATIVO_STATUS[status].toLowerCase()}.</p>`
    }`;

  el.querySelectorAll('.chip[data-status]').forEach((chip) =>
    chip.addEventListener('click', () => renderCriativos(el, chip.dataset.status)),
  );
  el.querySelectorAll('button[data-acao]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      // Reprovar sem motivo era um beco sem saída pro anunciante: o card dele
      // virava "Reprovado" e nenhuma tela dizia o que consertar. O motivo vai
      // junto do status, aparece no card dele e vai no e-mail.
      const corpo = { status: btn.dataset.acao };
      if (btn.dataset.acao === 'reprovado') {
        const motivo = window.prompt('Por que essa peça não entra no ar? (o anunciante lê isto no painel e no e-mail)');
        if (motivo === null) return;
        if (!motivo.trim()) return window.alert('Escreva o motivo. É o que diz ao anunciante o que corrigir.');
        corpo.motivo_reprovacao = motivo.trim();
      }
      if (await salvar(`/admin/criativos/${btn.dataset.id}`, corpo)) {
        RESUMO = await pegar('/admin/resumo');
        pintarContadores();
        renderCriativos(el, status);
      }
    }),
  );
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
            <label for="cpFreq">Vezes por hora, por tela</label>
            <input id="cpFreq" type="number" min="1" max="60" value="1" required>
            <button class="btn primary" type="submit">Criar conta própria</button>
          </form>
        </div>
      </div>`;
    document.getElementById('formContaPropria').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const r = await api('/admin/anunciantes', {
        method: 'POST',
        body: JSON.stringify({
          nome_empresa: document.getElementById('cpNome').value,
          cpf_cnpj: document.getElementById('cpDoc').value,
          contato_email: 'rede+propria@mostrai.local',
          contato_telefone: '+5516000000000',
          status: 'ativo',
          conta_propria: true,
          frequencia_hora_propria: Number(document.getElementById('cpFreq').value),
        }),
      });
      if (!r.ok) return toast((await r.json()).erro || 'não deu pra criar', 'err');
      toast('conta própria criada');
      renderMeusAnuncios(el);
    });
    return;
  }

  const criativos = await pegar('/admin/criativos?status=todos');
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
          <label for="cpFreq2">Vezes por hora, por tela</label>
          <input id="cpFreq2" type="number" min="1" max="60" value="${conta.frequencia_hora_propria || 1}">
          <label for="cpStatus">Situação</label>
          <select id="cpStatus">
            <option value="nao"${!conta.suspenso ? ' selected' : ''}>No ar</option>
            <option value="sim"${conta.suspenso ? ' selected' : ''}>Pausada</option>
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
        <tbody>${
          meus
            .map(
              (c) => `
          <tr>
            <td>${esc(c.arquivo_original_url || '-')}</td>
            <td>${c.duracao_segundos ? c.duracao_segundos + 's' : '-'}</td>
            <td>${c.status === 'aprovado' ? 'No ar' : esc(c.status)}</td>
            <td>${
              c.status === 'aprovado'
                ? `<button class="btn ghost mini" data-tirar="${c.id}">Tirar do ar</button>`
                : `<button class="btn ghost mini" data-por="${c.id}">Pôr no ar</button>`
            }</td>
          </tr>`,
            )
            .join('') || '<tr><td colspan="4">Nenhum anúncio ainda.</td></tr>'
        }</tbody>
      </table>
    </div>`;

  document.getElementById('formFreq').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await api(`/admin/anunciantes/${conta.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        frequencia_hora_propria: Number(document.getElementById('cpFreq2').value),
        suspenso: document.getElementById('cpStatus').value === 'sim',
      }),
    });
    toast(r.ok ? 'salvo' : 'não deu pra salvar', r.ok ? 'ok' : 'err');
  });

  // Upload vai em multipart, então não passa pelo `api()`, que manda JSON.
  document.getElementById('formSubir').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const arquivo = document.getElementById('cpArquivo').files[0];
    if (!arquivo) return;
    const msg = document.getElementById('cpMsg');
    msg.textContent = 'Enviando e normalizando o vídeo... isso leva alguns segundos.';
    const dados = new FormData();
    dados.append('arquivo', arquivo);
    const r = await fetch(`${API_BASE_URL}/admin/anunciantes/${conta.id}/criativos`, {
      method: 'POST',
      body: dados,
      credentials: 'include',
    });
    if (!r.ok) {
      msg.textContent = '';
      return toast((await r.json()).erro || 'falhou', 'err');
    }
    toast('anúncio enviado');
    renderMeusAnuncios(el);
  });

  el.querySelectorAll('[data-tirar],[data-por]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.tirar || b.dataset.por;
      const status = b.dataset.tirar ? 'reprovado' : 'aprovado';
      const r = await api(`/admin/criativos/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      if (!r.ok) return toast('não deu pra mudar', 'err');
      renderMeusAnuncios(el);
    }),
  );
}

// ---------- pontos ----------
async function renderPontos(el) {
  const [pontos, categorias, opcoesComodato] = await Promise.all([
    pegar('/admin/pontos'),
    pegar('/admin/categorias'),
    pegar('/admin/planos-ponto'),
  ]);
  // Sinal/chave/PIN são por TELA (migration 019) — ficam na aba "Telas".
  // Aqui o ponto mostra quantas telas tem e quem é o dono (conta).
  const corpo = `<table><thead><tr>
      <th data-ord>ID</th><th data-ord>Nome</th><th data-ord>Dono (conta)</th><th data-ord>Cidade</th><th>Segmento do local</th>
      <th>Comodato</th><th data-ord>Ajuda R$/mês</th><th data-ord>Cota/h</th><th data-ord>Status</th>
      <th data-ord>Fluxo/mês</th><th>Molde</th><th data-ord>Telas</th><th>Foto</th>
    </tr></thead><tbody>
    ${pontos
      .map(
        (p) => `<tr data-filtro="${p.status}${p.telas_ativas < p.telas ? ' parcial' : ''}">
      <td>${p.id}</td>
      <td><b>${esc(p.nome)}</b><div class="u-dim u-fs-72">${esc(p.responsavel_nome)} · ${esc(p.responsavel_contato)}</div></td>
      <td>${p.dono_nome ? esc(p.dono_nome) : '<span class="u-dim">sem conta</span>'}</td>
      <td>${esc(p.cidade)}/${esc(p.uf)}</td>
      <td><select class="mini" data-ponto="categoria_id" data-id="${p.id}" title="Define de qual segmento NÃO entra anúncio nessa tela">
        <option value="">-</option>
        ${categorias.map((c) => `<option value="${c.id}" ${c.id === p.categoria_id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
      </select></td>
      <td><select class="mini" data-ponto="plano_ponto_id" data-id="${p.id}">
        <option value="">-</option>
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
    </tr>`,
      )
      .join('')}
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
    ${
      pontos.length
        ? caixaTabela({
            chips: [
              { valor: '', nome: 'Todos' },
              { valor: 'parcial', nome: 'Com tela fora do ar' },
              ...Object.entries(PONTO_STATUS).map(([v, n]) => ({ valor: v, nome: n })),
            ],
            html: corpo,
            dica: 'Alterações salvam ao sair do campo. Chave, PIN e sinal de cada TV ficam na aba Telas.',
          })
        : '<p class="empty-state">Nenhum ponto ainda. Candidatura em "Seja um ponto" no site vira convite aqui, e o convite aceito nasce ponto. O cadastro manual acima é pra exceção.</p>'
    }
    <p class="empty-state u-ta-l u-p-0 u-pt-4">A ajuda de custo e a cota vêm da opção de comodato escolhida no cadastro, mas ficam editáveis por ponto. Trocar a opção aqui não recalcula sozinho. A cota é dividida entre as telas ativas do ponto. Fluxo mensal só entra na soma pública com o ponto ativo. Ponto novo entra pelo formulário "Seja um ponto" → candidatura → convite; o cadastro manual abaixo é pra exceção.</p>`;

  turbinarTabela(el.querySelector('.tabela-caixa'));

  el.querySelectorAll('[data-ponto]').forEach((campo) =>
    campo.addEventListener('change', () => {
      if (campo.type === 'checkbox')
        return salvar(`/admin/pontos/${campo.dataset.id}`, { [campo.dataset.ponto]: campo.checked }, campo);
      const numerico = [
        'valor_pago_mensal',
        'cota_autoanuncio_slots_hora',
        'fluxo_estimado_mensal',
        'categoria_id',
      ].includes(campo.dataset.ponto);
      const valor = campo.value === '' ? null : numerico ? Number(campo.value) : campo.value;
      return salvar(`/admin/pontos/${campo.dataset.id}`, { [campo.dataset.ponto]: valor }, campo);
    }),
  );

  el.querySelectorAll('[data-ver-telas]').forEach((a) =>
    a.addEventListener('click', () => {
      FILTRO_TELAS_PONTO = Number(a.dataset.verTelas);
    }),
  );
  el.querySelectorAll('[data-nova-tela]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const apelido = prompt(
        'Nome da tela (ex.: Tela 2, balcão):',
        `Tela ${pontos.find((p) => p.id === Number(btn.dataset.novaTela))?.telas + 1 || 2}`,
      );
      if (apelido === null) return;
      const custo = prompt(
        'Custo do equipamento dessa tela (R$), pra amortização. Pode deixar 0 e preencher depois:',
        '0',
      );
      const r = await api(`/admin/pontos/${btn.dataset.novaTela}/dispositivos`, {
        method: 'POST',
        body: JSON.stringify({ apelido, custo_equipamento: Number(custo) || 0 }),
      });
      if (!r.ok) return toast('Não foi possível criar a tela.', 'err');
      toast('Tela criada. Gere a chave dela na aba Telas.');
      FILTRO_TELAS_PONTO = Number(btn.dataset.novaTela);
      irPara('telas');
    }),
  );

  el.querySelectorAll('[data-foto-ponto]').forEach((input) =>
    input.addEventListener('change', async () => {
      if (!input.files[0]) return;
      const form = new FormData();
      form.append('arquivo', input.files[0]);
      const r = await fetch(`${API_BASE_URL}/admin/pontos/${input.dataset.fotoPonto}/foto`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      toast(r.ok ? 'Foto enviada.' : 'Não foi possível enviar a foto.', r.ok ? '' : 'err');
      if (r.ok) renderPontos(el);
    }),
  );

  document.getElementById('formNovoPonto').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovoPonto');
    const r = await api('/admin/pontos', {
      method: 'POST',
      body: JSON.stringify({ ...Object.fromEntries(new FormData(e.target)), status: 'a_instalar' }),
    });
    if (!r.ok) {
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao criar.';
      msg.className = 'form-msg err';
      return;
    }
    toast('Ponto criado.');
    renderPontos(el);
  });
}

// ---------- telas (dispositivos) ----------
let FILTRO_TELAS_PONTO = null;

// A chave do aparelho é o que autentica a TV (ver src/lib/aparelho.js).
// O link completo é o que se abre no navegador da tela — ele guarda a
// chave e continua funcionando depois de reiniciar.
const linkDoPlayer = (telaId, chave) =>
  `${window.location.origin}/player.html?tela=${telaId}&chave=${encodeURIComponent(chave)}`;

async function renderTelas(el) {
  const filtroPonto = FILTRO_TELAS_PONTO;
  FILTRO_TELAS_PONTO = null;
  // Filtrando por ponto, pede só as telas daquele ponto (a rota existia desde
  // sempre e ninguem chamava; o admin baixava a rede inteira pra descartar
  // quase tudo no navegador). E a lista de telas sem sinal vem do servidor, em
  // vez de refazer a regra das 2 horas aqui: eram duas implementacoes da mesma
  // regra, livres pra divergir — e a do alerta do topo ja era a do servidor.
  const [telas, semSinal] = await Promise.all([
    pegar(filtroPonto ? `/admin/pontos/${filtroPonto}/dispositivos` : '/admin/dispositivos'),
    pegar('/admin/pontos-offline').catch(() => []),
  ]);
  const idsOffline = new Set((semSinal || []).map((d) => d.id));
  const estaOffline = (t) => idsOffline.has(t.id);
  const lista = telas;
  const amort = (t) =>
    Number(t.custo_equipamento) > 0 ? Number(t.custo_equipamento) / Math.max(1, Number(t.meses_amortizacao) || 36) : 0;

  const corpo = `<table><thead><tr>
      <th data-ord>ID</th><th data-ord>Ponto</th><th data-ord>Tela</th><th data-ord>Status</th><th data-ord>Último sinal</th>
      <th>Chave / link do player</th><th>PIN do painel</th><th data-ord>Custo R$</th><th data-ord>Meses</th><th data-ord>Amort./mês</th><th data-ord>Instalada em</th><th></th>
    </tr></thead><tbody>
    ${lista
      .map(
        (t) => `<tr data-filtro="${t.status}${estaOffline(t) ? ' offline' : ''}${t.aparelho_id ? '' : ' semchave'}">
      <td>${t.id}</td>
      <td><b>${esc(t.ponto_nome)}</b><div class="u-dim u-fs-72">${esc(t.ponto_cidade || '')} · ponto ${esc(PONTO_STATUS[t.ponto_status] || t.ponto_status)}</div></td>
      <td><input class="mini u-w-120" data-tela="apelido" data-id="${t.id}" value="${esc(t.apelido)}"></td>
      <td>${selectStatus(TELA_STATUS, t.status, `data-tela="status" data-id="${t.id}"`)}</td>
      <td>${estaOffline(t) ? '<span class="badge badge-err">sem sinal</span> ' : ''}${t.ultima_vez_online ? new Date(t.ultima_vez_online).toLocaleString('pt-BR') : '-'}</td>
      <td>${
        t.aparelho_id
          ? `<button class="btn ghost mini" data-copiar="${esc(t.aparelho_id)}" data-tela-id="${t.id}">Copiar link</button>
           <button class="btn ghost mini" data-chave="${t.id}" data-trocar="1" title="Gera uma chave nova e derruba o aparelho atual">Trocar</button>`
          : `<button class="btn primary mini" data-chave="${t.id}">Gerar chave</button>`
      }</td>
      <td>${t.tem_pin ? '<span class="badge badge-ok">definido</span> ' : '<span class="badge badge-pendente">sem PIN</span> '}
        <button class="btn ghost mini" data-pin="${t.id}">${t.tem_pin ? 'Trocar' : 'Definir'}</button></td>
      <td><input class="mini u-w-80" type="number" step="0.01" min="0" data-tela="custo_equipamento" data-id="${t.id}" value="${t.custo_equipamento ?? 0}"></td>
      <td><input class="mini u-w-60" type="number" min="1" data-tela="meses_amortizacao" data-id="${t.id}" value="${t.meses_amortizacao ?? 36}"></td>
      <td>${amort(t) ? fmt(amort(t)) : '-'}</td>
      <td><input class="mini u-w-120" type="date" data-tela="instalado_em" data-id="${t.id}" value="${t.instalado_em ? String(t.instalado_em).slice(0, 10) : ''}"></td>
      <td><button class="btn ghost mini" data-painel-tela="${t.id}" title="O que rodou nessa tela">Painel</button>
          <button class="btn ghost mini u-txt-erro" data-excluir-tela="${t.id}" title="Só se nunca rodou nada">×</button></td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = `
    ${filtroPonto ? `<p class="form-hint u-m-0 u-mb-10">Mostrando só as telas do ponto #${filtroPonto}. <a href="#telas" data-limpar-filtro>Ver todas</a></p>` : ''}
    ${
      lista.length
        ? caixaTabela({
            chips: [
              { valor: '', nome: 'Todas' },
              { valor: 'offline', nome: 'Sem sinal' },
              { valor: 'semchave', nome: 'Sem chave' },
              ...Object.entries(TELA_STATUS).map(([v, n]) => ({ valor: v, nome: n })),
            ],
            html: corpo,
            dica: 'Uma tela = um link do player + uma playlist. Custo e prazo alimentam a amortização da visão geral.',
          })
        : '<p class="empty-state">Nenhuma tela ainda. Crie a primeira pelo botão "+ tela" na aba Pontos.</p>'
    }
    <p class="empty-state u-ta-l u-p-0 u-pt-4">Como ligar uma TV: gere a chave → copie o link → abra no navegador da TV (ou no app kiosk apontando pra ele). O PIN abre o painel da tela na própria TV (5 toques no canto superior direito ou tecla P). Só mostra o que rodou nela, nada mais.</p>`;

  if (!lista.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelector('[data-limpar-filtro]')?.addEventListener('click', () => renderTelas(el));

  el.querySelectorAll('[data-tela]').forEach((campo) =>
    campo.addEventListener('change', async () => {
      const numerico = ['custo_equipamento', 'meses_amortizacao'].includes(campo.dataset.tela);
      const valor = campo.value === '' ? null : numerico ? Number(campo.value) : campo.value;
      if (
        (await salvar(`/admin/dispositivos/${campo.dataset.id}`, { [campo.dataset.tela]: valor }, campo)) &&
        ['status', 'custo_equipamento', 'meses_amortizacao'].includes(campo.dataset.tela)
      ) {
        RESUMO = await pegar('/admin/resumo');
        pintarContadores();
        if (campo.dataset.tela !== 'status') renderTelas(el);
      }
    }),
  );

  el.querySelectorAll('[data-chave]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (
        btn.dataset.trocar &&
        !confirm(
          'Gerar uma chave nova? A TV que está usando a chave atual para de funcionar até você abrir o link novo nela.',
        )
      )
        return;
      const r = await api(`/admin/dispositivos/${btn.dataset.chave}/chave`, { method: 'POST' });
      if (!r.ok) return toast('Não foi possível gerar a chave.', 'err');
      const { aparelho_id } = await r.json();
      prompt(
        'Abra este link no navegador da TV (ele guarda a chave e continua funcionando depois de reiniciar):',
        linkDoPlayer(btn.dataset.chave, aparelho_id),
      );
      renderTelas(el);
    }),
  );

  el.querySelectorAll('[data-copiar]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const link = linkDoPlayer(btn.dataset.telaId, btn.dataset.copiar);
      navigator.clipboard?.writeText(link).then(
        () => toast('Link copiado.'),
        () => prompt('Link do player:', link),
      );
    }),
  );

  el.querySelectorAll('[data-pin]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const pin = prompt('PIN de 4 a 6 dígitos pra abrir o painel dessa tela na TV (deixe vazio pra remover):');
      if (pin === null) return;
      const r = await api(`/admin/dispositivos/${btn.dataset.pin}/pin`, {
        method: 'POST',
        body: JSON.stringify({ pin: pin.trim() || null }),
      });
      if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'Não foi possível salvar o PIN.', 'err');
      toast(pin.trim() ? 'PIN definido.' : 'PIN removido.');
      renderTelas(el);
    }),
  );

  el.querySelectorAll('[data-painel-tela]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const d = await pegar(`/admin/dispositivos/${btn.dataset.painelTela}/painel`);
      const total = d.porAnunciante.reduce((s, a) => s + a.confirmadas, 0);
      const linha = btn.closest('tr');
      const existente = linha.nextElementSibling;
      if (existente && existente.dataset.painelDe === btn.dataset.painelTela) {
        existente.remove();
        return;
      }
      linha.insertAdjacentHTML(
        'afterend',
        `<tr data-painel-de="${btn.dataset.painelTela}"><td class="u-bg" colspan="12">
      <b>Últimos 30 dias: ${num(total)} exibições confirmadas</b>
      ${
        d.porAnunciante.length
          ? `<table class="mini-table u-mt-6"><thead><tr><th>Anunciante</th><th>Programadas</th><th>Confirmadas</th></tr></thead><tbody>
        ${d.porAnunciante.map((a) => `<tr><td>${esc(a.nome_empresa)}</td><td>${a.programadas}</td><td>${a.confirmadas}</td></tr>`).join('')}</tbody></table>`
          : '<p class="empty-state u-py-6">Nada rodou nessa tela ainda.</p>'
      }
    </td></tr>`,
      );
    }),
  );

  el.querySelectorAll('[data-excluir-tela]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Excluir essa tela? Só faça isso se ela nunca rodou nada (o histórico de exibições vai junto).'))
        return;
      const r = await api(`/admin/dispositivos/${btn.dataset.excluirTela}`, { method: 'DELETE' });
      if (!r.ok) return toast('Não foi possível excluir.', 'err');
      toast('Tela excluída.');
      renderTelas(el);
    }),
  );
}

// ---------- anunciantes ----------
async function renderAnunciantes(el) {
  const [anunciantes, categorias, planos, pontos] = await Promise.all([
    pegar('/admin/anunciantes'),
    pegar('/admin/categorias'),
    pegar('/admin/planos'),
    pegar('/admin/pontos'),
  ]);
  // Plano mostrava só o id cru; e desde que ponto usa conta de anunciante
  // (migration 016), dá pra marcar aqui quem também é dono de ponto.
  const nomePlano = Object.fromEntries(
    planos.map((p) => [p.id, `${p.nome} · ${CICLOS[p.compromisso_meses] || p.compromisso_meses + 'x'}`]),
  );
  const temPonto = new Set(pontos.map((p) => p.anunciante_id).filter(Boolean));

  const corpo = `<table><thead><tr>
      <th data-ord>ID</th><th data-ord>Empresa</th><th data-ord>Documento</th><th>Contato</th>
      <th>Ramo</th><th data-ord>Plano</th><th data-ord>Expira</th><th data-ord>Status</th><th data-ord>Suspensa</th><th data-ord>Entrou</th><th></th>
    </tr></thead><tbody>
    ${anunciantes
      .map(
        (
          a,
        ) => `<tr data-filtro="${a.excluido_em ? 'excluida' : a.status}${temPonto.has(a.id) || (a.papeis || []).includes('ponto') ? ' comodato' : ''}${(a.papeis || []).includes('vendedor') ? ' vendedor' : ''}" class="${a.excluido_em ? 'u-op-60' : ''}">
      <td>${a.id}</td>
      <td><b>${esc(a.nome_empresa)}</b> ${(a.papeis || ['anunciante'])
        .filter((x) => x !== 'anunciante')
        .map((x) => `<span class="badge badge-ok">${esc(PAPEIS[x] || x)}</span>`)
        .join(
          ' ',
        )}${a.status === 'parceiro' ? ` <span class="badge badge-ok" title="desconto extra ${a.parceiro_desconto_percentual ?? 0}%${a.parceiro_compromisso_minimo ? ` · só a partir de ${a.parceiro_compromisso_minimo}x` : ''}">parceiro</span>` : ''}${a.excluido_em ? ` <span class="badge badge-err">excluída ${data(a.excluido_em)}</span>` : ''}</td>
      <td>${esc(a.cpf_cnpj)}</td>
      <td><div class="u-fs-78">${esc(a.contato_email)}</div><div class="u-dim u-fs-74">${esc(a.contato_telefone)}</div></td>
      <td><select class="mini" data-anunciante="categoria_id" data-id="${a.id}" title="Ramo do anunciante. Não entra em ponto do mesmo ramo">
        <option value="">${a.categoria_livre ? `(livre) ${esc(a.categoria_livre)}` : '-'}</option>
        ${categorias.map((c) => `<option value="${c.id}" ${c.id === a.categoria_id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
      </select></td>
      <td>${a.plano_id ? esc(nomePlano[a.plano_id] || a.plano_id) : '<span class="u-dim">sem plano</span>'}${a.plano_cortesia ? ` <span class="badge badge-pendente" title="${esc(a.cortesia_motivo || 'liberado pelo admin')}">cortesia</span>` : ''}</td>
      <td>${data(a.data_expiracao)}</td>
      <td>${selectStatus(ANUNCIANTE_STATUS, a.status, `data-anunciante="status" data-id="${a.id}"`)}</td>
      <td><select class="mini" data-anunciante="suspenso" data-id="${a.id}">
        <option value="false"${!a.suspenso ? ' selected' : ''}>Não</option>
        <option value="true"${a.suspenso ? ' selected' : ''}>Sim</option>
      </select></td>
      <td>${data(a.created_at)}</td>
      <td>${
        a.excluido_em
          ? `<button class="btn ghost mini" data-restaurar="${a.id}">Restaurar</button>`
          : `<label class="btn ghost mini" title="Sobe a peça direto na conta dele, já entra aprovada">Subir anúncio<input type="file" accept="video/*,image/*" hidden data-subir="${a.id}"></label>
           <button class="btn ghost mini" data-liberar="${a.id}" title="Põe a conta no ar sem cobrar nada">Liberar plano</button>
           <button class="btn ghost mini" data-parceiro="${a.id}" title="Marca esta conta como parceira: desconto extra e piso de compromisso definidos por você">${a.status === 'parceiro' ? 'Editar parceiro' : 'Marcar parceiro'}</button>
           ${
             a.plano_id && !a.plano_cortesia
               ? `<button class="btn ghost mini u-txt-erro" data-cancelar="${a.id}" title="Cancela a cobrança recorrente no San Checkout. A cobertura já paga continua até expirar.">Cancelar assinatura</button>`
               : ''
}`
      }</td>
    </tr>`,
      )
      .join('')}
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
    ${
      anunciantes.length
        ? caixaTabela({
            chips: [
              { valor: '', nome: 'Todos' },
              ...Object.entries(ANUNCIANTE_STATUS).map(([v, n]) => ({ valor: v, nome: n })),
              { valor: 'comodato', nome: 'Dono de ponto' },
              { valor: 'vendedor', nome: 'Vendedor' },
              { valor: 'excluida', nome: 'Excluídas' },
            ],
            html: corpo,
            dica: 'Conta excluída fica recuperável por 60 dias. Use Restaurar.',
          })
        : '<p class="empty-state">Nenhum anunciante ainda. Cadastro pelo site cai aqui na hora, ou use "+ Novo anunciante" acima pra exceção.</p>'
    }`;

  turbinarTabela(el.querySelector('.tabela-caixa'));

  el.querySelectorAll('[data-anunciante]').forEach((sel) =>
    sel.addEventListener('change', async () => {
      const campo = sel.dataset.anunciante;
      const valor =
        campo === 'categoria_id'
          ? sel.value === ''
            ? null
            : Number(sel.value)
          : campo === 'suspenso'
            ? sel.value === 'true'
            : sel.value;
      if ((await salvar(`/admin/anunciantes/${sel.dataset.id}`, { [campo]: valor }, sel)) && campo === 'suspenso') {
        RESUMO = await pegar('/admin/resumo');
        pintarContadores();
      }
    }),
  );

  // Exclusão de conta é soft-delete (migration 017): o anunciante pede,
  // o suporte desfaz aqui dentro de 60 dias zerando excluido_em.
  // A peça é feita FORA do site (combinada no WhatsApp) e sobe direto na
  // conta do cliente. Multipart, então não passa pelo `api()`, que manda JSON.
  // Liberar plano de graça. A conta fica igual a uma pagante pra quem vê a
  // tela, e diferente pra quem lê o resumo — que é onde a diferença importa.
  el.querySelectorAll('[data-liberar]').forEach((b) =>
    b.addEventListener('click', async () => {
      const opcoes = planos
        .map((p) => `${p.id} = ${p.nome} · ${CICLOS[p.compromisso_meses] || p.compromisso_meses + 'x'}`)
        .join('\n');
      const plano_id = prompt(`Qual plano liberar?\n\n${opcoes}`);
      if (!plano_id) return;
      const motivo = prompt('Por que está liberando? (parceria, teste, cortesia de lançamento...)') || '';
      const r = await api(`/admin/anunciantes/${b.dataset.liberar}/liberar-plano`, {
        method: 'POST',
        body: JSON.stringify({ plano_id: plano_id.trim(), motivo }),
      });
      if (!r.ok) return toast((await r.json()).erro || 'não deu pra liberar', 'err');
      toast('plano liberado, a conta está no ar, sem cobrança');
      renderAnunciantes(el);
    }),
  );
  // Parceiro (item 4 da spec, 15/09/2026; renomeado de "fundador" e
  // absorvido pelo `status` em 16/09/2026): não é mais um flag à parte —
  // é o próprio `status` da conta virando 'parceiro', com o desconto e o
  // piso de compromisso que o admin decidir.
  el.querySelectorAll('[data-parceiro]').forEach((b) =>
    b.addEventListener('click', async () => {
      const atual = anunciantes.find((a) => a.id === Number(b.dataset.parceiro));
      const desconto = prompt(
        'Desconto extra (%) além do preço do plano. Deixe vazio para remover o status de parceiro:',
        atual?.parceiro_desconto_percentual ?? '',
      );
      if (desconto === null) return;
      if (desconto.trim() === '') {
        if (atual?.status !== 'parceiro' || !confirm('Remover o status de parceiro dessa conta?')) return;
        if (
          await salvar(`/admin/anunciantes/${b.dataset.parceiro}`, {
            status: 'comum',
            parceiro_desconto_percentual: null,
            parceiro_compromisso_minimo: null,
          })
        )
          renderAnunciantes(el);
        return;
      }
      const minimo = prompt(
        'Compromisso mínimo (em meses) pra usar o desconto. Deixe vazio para liberar qualquer plano:',
        atual?.parceiro_compromisso_minimo ?? '',
      );
      if (minimo === null) return;
      if (
        await salvar(`/admin/anunciantes/${b.dataset.parceiro}`, {
          status: 'parceiro',
          parceiro_desconto_percentual: Number(desconto),
          parceiro_compromisso_minimo: minimo.trim() === '' ? null : Number(minimo),
        })
      )
        renderAnunciantes(el);
    }),
  );
  el.querySelectorAll('[data-subir]').forEach((input) =>
    input.addEventListener('change', async () => {
      const arquivo = input.files[0];
      if (!arquivo) return;
      input.disabled = true;
      toast('enviando e normalizando o vídeo...');
      const dados = new FormData();
      dados.append('arquivo', arquivo);
      const r = await fetch(`${API_BASE_URL}/admin/anunciantes/${input.dataset.subir}/criativos`, {
        method: 'POST',
        body: dados,
        credentials: 'include',
      });
      input.disabled = false;
      input.value = '';
      if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'não deu pra subir', 'err');
      toast('anúncio no ar na conta do cliente');
    }),
  );
  // A rota de cancelar assinatura existia desde sempre e nao tinha um unico
  // botao em lugar nenhum: nao havia como parar uma cobranca recorrente pela
  // interface. Cancelar so no painel do Asaas deixaria o banco daqui achando
  // que a assinatura segue viva.
  el.querySelectorAll('[data-cancelar]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const linha = btn.closest('tr');
      const nome = linha ? linha.querySelector('b').textContent : 'esta conta';
      if (
        !confirm(
          `Cancelar a assinatura de ${nome}?\n\n` +
            'A cobrança recorrente para no San Checkout e não volta sozinha. ' +
            'A cobertura já paga continua valendo até a data de expiração, ' +
            'e o anúncio não sai do ar hoje.',
        )
      )
        return;
      const r = await api(`/admin/anunciantes/${btn.dataset.cancelar}/cancelar-assinatura`, { method: 'POST' });
      if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'Não foi possível cancelar.', true);
      toast('Assinatura cancelada. A cobertura paga continua até expirar.');
      renderAnunciantes(el);
    }),
  );

  el.querySelectorAll('[data-restaurar]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Restaurar essa conta? O anunciante volta a conseguir entrar.')) return;
      if (await salvar(`/admin/anunciantes/${btn.dataset.restaurar}`, { excluido_em: null })) renderAnunciantes(el);
    }),
  );

  document.getElementById('formNovoAnunciante').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovoAnunciante');
    const r = await api('/admin/anunciantes', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    const corpoResp = await r.json();
    if (!r.ok) {
      msg.textContent = corpoResp.erro || 'Erro ao criar.';
      msg.className = 'form-msg err';
      return;
    }
    alert(
      `Anunciante criado! Senha de acesso: ${corpoResp.senhaGerada}\n\nRepasse pro anunciante agora. Não fica salva em nenhuma tela depois desta.`,
    );
    renderAnunciantes(el);
  });
}

// ---------- vendedores ----------
async function renderVendedores(el) {
  const vendedores = await pegar('/admin/vendedores');
  const corpo = `<table><thead><tr>
      <th data-ord>Conta</th><th data-ord>Nome</th><th>Contato</th><th>Chave Pix</th><th data-ord>Cupom</th><th data-ord>Comissão %</th><th data-ord>Status</th><th data-ord>Desde</th>
    </tr></thead><tbody>
    ${vendedores
      .map(
        (v) => `<tr data-filtro="${v.status}">
      <td>${v.conta_id}</td>
      <td><b>${esc(v.nome)}</b></td>
      <td><div class="u-fs-78">${esc(v.email || '')}</div><div class="u-dim u-fs-74">${esc(v.telefone || '')}</div></td>
      <td><input class="mini u-w-160" data-vendedor="chave_pix" data-id="${v.conta_id}" value="${esc(v.chave_pix || '')}"></td>
      <td><code>${esc(v.codigo_cupom)}</code> <button class="btn ghost mini" data-copiar-cupom="${esc(v.codigo_cupom)}">copiar link</button></td>
      <td><input class="mini u-w-60" type="number" step="0.01" min="10" max="30" data-vendedor="comissao_percentual" data-id="${v.conta_id}" value="${v.comissao_percentual}" title="Entre 10% e 30%. Quem decide o percentual é você"></td>
      <td>${selectStatus(VENDEDOR_STATUS, v.status, `data-vendedor="status" data-id="${v.conta_id}"`)}</td>
      <td>${data(v.created_at)}</td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = vendedores.length
    ? caixaTabela({
        chips: [
          { valor: '', nome: 'Todos' },
          ...Object.entries(VENDEDOR_STATUS).map(([v, n]) => ({ valor: v, nome: n })),
        ],
        html: corpo,
        dica: 'Comissão e Pix salvam ao sair do campo. Vendedor novo entra por convite (aba Convites) com o papel "vendedor".',
      })
    : '<p class="empty-state">Nenhum vendedor ainda. Gere um convite com o papel "vendedor" na aba Convites. A conta que entrar por ele já nasce com cupom.</p>';

  if (!vendedores.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('[data-vendedor]').forEach((campo) =>
    campo.addEventListener('change', () => {
      const valor = campo.dataset.vendedor === 'comissao_percentual' ? Number(campo.value) : campo.value;
      salvar(`/admin/vendedores/${campo.dataset.id}`, { [campo.dataset.vendedor]: valor }, campo);
    }),
  );
  el.querySelectorAll('[data-copiar-cupom]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const link = `${window.location.origin}/anunciante/cadastro.html?ref=${encodeURIComponent(btn.dataset.copiarCupom)}`;
      navigator.clipboard?.writeText(link).then(
        () => toast('Link de indicação copiado.'),
        () => prompt('Link:', link),
      );
    }),
  );
}

// ---------- candidaturas ----------
async function renderCandidaturas(el) {
  const lista = await pegar('/admin/candidaturas');
  const corpo = `<table><thead><tr>
      <th data-ord>Quando</th><th data-ord>Tipo</th><th data-ord>Nome</th><th>Comércio / endereço</th><th>Contato</th><th>Mensagem</th><th data-ord>Status</th><th></th>
    </tr></thead><tbody>
    ${lista
      .map(
        (c) => `<tr data-filtro="${c.status} ${c.tipo}">
      <td>${data(c.criado_em)}</td>
      <td><span class="badge ${c.tipo === 'ponto' ? 'badge-ok' : 'badge-pendente'}">${c.tipo === 'ponto' ? 'Ponto' : 'Vendedor'}</span>
        ${c.origem === 'painel' ? '<div class="u-fs-70 u-dim">pedido do painel</div>' : c.origem === 'bonus_plano' ? '<div class="u-fs-70 u-txt-marca"><b>bônus do plano</b></div>' : ''}</td>
      <td><b>${esc(c.nome)}</b>${c.conta_id ? `<div class="u-fs-72 u-dim">conta #${c.conta_id} · ${esc(c.conta_nome || '')}</div>` : ''}</td>
      <td>${c.tipo === 'ponto' ? `<b>${esc(c.nome_comercio || '')}</b><div class="u-fs-76">${esc(c.endereco || '')} · ${esc(c.cidade || '')}/${esc(c.uf || '')}</div><div class="u-dim u-fs-72">${esc(c.segmento || '')}${c.fluxo_estimado_mensal ? ` · ~${num(c.fluxo_estimado_mensal)} pessoas/mês` : ''}</div>` : `<span class="u-dim">${esc(c.cidade || '')}</span>`}</td>
      <td><a href="https://wa.me/55${String(c.contato_telefone || '').replace(/\D/g, '')}" target="_blank" rel="noopener">${esc(c.contato_telefone)}</a><div class="u-dim u-fs-72">${esc(c.contato_email || '')}</div></td>
      <td class="u-mw-240 u-fs-78 u-ws-normal">${esc(c.mensagem || '-')}</td>
      <td>${
        c.status === 'aprovada'
          ? `<span class="badge ${c.convite_usado_em ? 'badge-ok' : c.convite_aberto ? 'badge-pendente' : 'badge-err'}">Convite ${c.convite_usado_em ? 'usado' : c.convite_aberto ? 'aberto' : 'expirado'}</span>`
          : selectStatus(
              { nova: 'Nova', em_contato: 'Em contato', recusada: 'Recusada' },
              c.status,
              `data-cand="status" data-id="${c.id}"`,
            )
      }</td>
      <td>${
        c.conta_id && c.status !== 'aprovada' && c.status !== 'recusada'
          ? `<button class="btn primary mini" data-liberar="${c.id}" data-tipo="${c.tipo}" title="Liga o modo direto na conta que pediu">Liberar na conta</button>`
          : ''
      }
          ${!c.conta_id && c.status !== 'recusada' && !c.convite_usado_em && !c.convite_aberto ? `<button class="btn primary mini" data-convidar="${c.id}" data-tipo="${c.tipo}" data-nome="${esc(c.nome)}" data-email="${esc(c.contato_email || '')}">${c.status === 'aprovada' ? 'Gerar convite novo' : 'Gerar convite'}</button>` : ''}
          ${c.convite_aberto ? `<button class="btn ghost mini" data-copiar-convite="${esc(c.convite_token)}">Copiar link</button>` : ''}</td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = lista.length
    ? caixaTabela({
        chips: [
          { valor: 'nova', nome: 'Novas' },
          { valor: 'em_contato', nome: 'Em contato' },
          { valor: 'aprovada', nome: 'Aprovadas' },
          { valor: 'recusada', nome: 'Recusadas' },
          { valor: '', nome: 'Todas' },
          { valor: 'ponto', nome: 'Só pontos' },
          { valor: 'vendedor', nome: 'Só vendedores' },
        ],
        html: corpo,
        dica: 'Pedido do site → "Gerar convite" (link de cadastro, uso único, 7 dias). Pedido feito de dentro do painel de uma conta → "Liberar na conta" liga o modo direto nela.',
      })
    : '<p class="empty-state">Nenhuma candidatura ainda. Os formulários "Seja um ponto" e "Seja um vendedor" do site caem aqui.</p>';

  if (!lista.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('[data-cand]').forEach((sel) =>
    sel.addEventListener('change', async () => {
      if (await salvar(`/admin/candidaturas/${sel.dataset.id}`, { status: sel.value }, sel)) {
        RESUMO = await pegar('/admin/resumo');
        pintarContadores();
      }
    }),
  );
  el.querySelectorAll('[data-convidar]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const papeis = btn.dataset.tipo === 'ponto' ? ['ponto'] : ['vendedor'];
      const extra = confirm(
        btn.dataset.tipo === 'ponto'
          ? 'Esse dono de ponto também vai ANUNCIAR (ter plano pago)? OK = sim, também anunciante. Cancelar = só dono de ponto.'
          : 'Esse vendedor também vai ANUNCIAR (ter plano pago)? OK = sim, também anunciante. Cancelar = só vendedor.',
      );
      if (extra) papeis.push('anunciante');
      const r = await api('/admin/convites', {
        method: 'POST',
        body: JSON.stringify({
          papeis,
          candidatura_id: Number(btn.dataset.convidar),
          nome_sugerido: btn.dataset.nome,
          email_sugerido: btn.dataset.email || null,
        }),
      });
      if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'Não foi possível gerar o convite.', 'err');
      const { link } = await r.json();
      navigator.clipboard?.writeText(link).catch(() => {});
      prompt('Convite gerado (já copiado). Mande esse link pra pessoa. Vale 7 dias e só pode ser usado uma vez:', link);
      RESUMO = await pegar('/admin/resumo');
      pintarContadores();
      renderCandidaturas(el);
    }),
  );
  el.querySelectorAll('[data-liberar]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (
        !confirm(
          `Liberar o modo "${btn.dataset.tipo === 'ponto' ? 'Meu ponto' : 'Vendas'}" nessa conta agora?${btn.dataset.tipo === 'ponto' ? ' O ponto e a Tela 1 são criados com o endereço do pedido.' : ''}`,
        )
      )
        return;
      const r = await api(`/admin/candidaturas/${btn.dataset.liberar}/liberar`, { method: 'POST' });
      if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'Não foi possível liberar.', 'err');
      toast('Modo liberado na conta.');
      RESUMO = await pegar('/admin/resumo');
      pintarContadores();
      renderCandidaturas(el);
    }),
  );
  el.querySelectorAll('[data-copiar-convite]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const link = `${window.location.origin}/convite.html?t=${encodeURIComponent(btn.dataset.copiarConvite)}`;
      navigator.clipboard?.writeText(link).then(
        () => toast('Link do convite copiado.'),
        () => prompt('Link:', link),
      );
    }),
  );
}

// ---------- convites ----------
async function renderConvites(el) {
  const convites = await pegar('/admin/convites');
  const corpo = `<table><thead><tr>
      <th data-ord>Criado</th><th>Papéis</th><th data-ord>Pra quem</th><th data-ord>Vale até</th><th data-ord>Situação</th><th>Conta criada</th><th></th>
    </tr></thead><tbody>
    ${convites
      .map(
        (c) => `<tr data-filtro="${c.situacao}">
      <td>${data(c.criado_em)}</td>
      <td>${(c.papeis || []).map((x) => `<span class="badge badge-ok">${esc(PAPEIS[x] || x)}</span>`).join(' ')}</td>
      <td>${esc(c.nome_sugerido || '-')}<div class="u-dim u-fs-72">${esc(c.email_sugerido || '')}${c.candidatura_id ? ` · candidatura #${c.candidatura_id}` : ''}</div></td>
      <td>${data(c.expira_em)}</td>
      <td>${c.situacao === 'aberto' ? '<span class="badge badge-pendente">aberto</span>' : c.situacao === 'usado' ? `<span class="badge badge-ok">usado ${data(c.usado_em)}</span>` : '<span class="badge badge-err">expirado/revogado</span>'}</td>
      <td>${c.conta_nome ? esc(c.conta_nome) : '-'}</td>
      <td>${c.situacao === 'aberto' ? `<button class="btn ghost mini" data-copiar-link="${esc(c.link)}">Copiar link</button> <button class="btn ghost mini u-txt-erro" data-revogar="${c.id}">Revogar</button>` : ''}</td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = `
    <details class="bloco-novo" open>
      <summary class="btn ghost mini">+ Novo convite (sem candidatura)</summary>
      <form class="card u-mt-12 u-mw-520" id="formNovoConvite">
        <div><label>Papéis da conta que vai nascer</label>
          <div class="benef-lista">
            ${Object.entries(PAPEIS)
              .map(
                ([v, n]) =>
                  `<label class="benef-check"><input type="checkbox" name="papeis" value="${v}" ${v === 'ponto' ? 'checked' : ''}><span>${n}</span></label>`,
              )
              .join('')}
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
    ${
      convites.length
        ? caixaTabela({
            chips: [
              { valor: 'aberto', nome: 'Abertos' },
              { valor: 'usado', nome: 'Usados' },
              { valor: 'expirado', nome: 'Expirados' },
              { valor: '', nome: 'Todos' },
            ],
            html: corpo,
            dica: 'Convite é o único caminho de entrada de dono de ponto e de vendedor. Convite de ponto vindo de candidatura já cria o ponto e a Tela 1 quando a pessoa se cadastra.',
          })
        : '<p class="empty-state">Nenhum convite gerado ainda.</p>'
    }`;

  if (convites.length) turbinarTabela(el.querySelector('.tabela-caixa'));
  document.getElementById('formNovoConvite').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovoConvite');
    const papeis = [...e.target.querySelectorAll('input[name="papeis"]:checked')].map((i) => i.value);
    if (!papeis.length) {
      msg.textContent = 'Marque ao menos um papel.';
      msg.className = 'form-msg err';
      return;
    }
    const r = await api('/admin/convites', {
      method: 'POST',
      body: JSON.stringify({
        papeis,
        nome_sugerido: e.target.nome_sugerido.value || null,
        email_sugerido: e.target.email_sugerido.value || null,
        validade_dias: Number(e.target.validade_dias.value) || 7,
      }),
    });
    if (!r.ok) {
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao gerar.';
      msg.className = 'form-msg err';
      return;
    }
    const { link } = await r.json();
    navigator.clipboard?.writeText(link).catch(() => {});
    prompt('Convite gerado (já copiado). Mande esse link pra pessoa:', link);
    renderConvites(el);
  });
  el.querySelectorAll('[data-copiar-link]').forEach((btn) =>
    btn.addEventListener('click', () => {
      navigator.clipboard?.writeText(btn.dataset.copiarLink).then(
        () => toast('Link copiado.'),
        () => prompt('Link:', btn.dataset.copiarLink),
      );
    }),
  );
  el.querySelectorAll('[data-revogar]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Revogar esse convite? O link para de funcionar na hora.')) return;
      const r = await api(`/admin/convites/${btn.dataset.revogar}/revogar`, { method: 'POST' });
      if (!r.ok) return toast('Não foi possível revogar.', 'err');
      toast('Convite revogado.');
      renderConvites(el);
    }),
  );
}

// ---------- custos fixos ----------
async function renderCustos(el) {
  const custos = await pegar('/admin/custos-fixos');
  const total = custos.filter((c) => c.ativo).reduce((t, c) => t + Number(c.valor_mensal), 0);
  const corpo = `<table><thead><tr><th data-ord>Nome</th><th data-ord>R$/mês</th><th>Observação</th><th data-ord>Entra na margem</th><th></th></tr></thead><tbody>
    ${custos
      .map(
        (c) => `<tr data-filtro="${c.ativo ? 'ativo' : 'inativo'}">
      <td><input class="mini u-w-200" data-custo="nome" data-id="${c.id}" value="${esc(c.nome)}"></td>
      <td><input class="mini u-w-100" type="number" step="0.01" min="0" data-custo="valor_mensal" data-id="${c.id}" value="${c.valor_mensal}"></td>
      <td><input class="mini u-w-280" data-custo="observacao" data-id="${c.id}" value="${esc(c.observacao || '')}"></td>
      <td class="u-ta-c"><input type="checkbox" data-custo="ativo" data-id="${c.id}" ${c.ativo ? 'checked' : ''}></td>
      <td><button class="btn ghost mini u-txt-erro" data-excluir-custo="${c.id}">×</button></td>
    </tr>`,
      )
      .join('')}
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
    ${
      custos.length
        ? caixaTabela({
            chips: [
              { valor: '', nome: 'Todos' },
              { valor: 'ativo', nome: 'Ativos' },
              { valor: 'inativo', nome: 'Desligados' },
            ],
            html: corpo,
            dica: 'Salva ao sair do campo. Custo anual? Lance o valor ÷ 12.',
          })
        : '<p class="empty-state">Nenhum custo lançado.</p>'
    }`;

  if (custos.length) turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('[data-custo]').forEach((campo) =>
    campo.addEventListener('change', async () => {
      const valor =
        campo.type === 'checkbox'
          ? campo.checked
          : campo.dataset.custo === 'valor_mensal'
            ? Number(campo.value)
            : campo.value;
      if (await salvar(`/admin/custos-fixos/${campo.dataset.id}`, { [campo.dataset.custo]: valor }, campo)) {
        RESUMO = await pegar('/admin/resumo');
        if (campo.dataset.custo !== 'nome' && campo.dataset.custo !== 'observacao') renderCustos(el);
      }
    }),
  );
  el.querySelectorAll('[data-excluir-custo]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Excluir esse custo?')) return;
      const r = await api(`/admin/custos-fixos/${btn.dataset.excluirCusto}`, { method: 'DELETE' });
      if (r.ok) {
        RESUMO = await pegar('/admin/resumo');
        renderCustos(el);
      }
    }),
  );
  document.getElementById('formNovoCusto').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovoCusto');
    const r = await api('/admin/custos-fixos', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    if (!r.ok) {
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao criar.';
      msg.className = 'form-msg err';
      return;
    }
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
  const opcoesBeneficio = (marcadosIds) =>
    beneficios
      .map(
        (b) => `
    <label class="benef-check">
      <input type="checkbox" value="${b.id}" ${marcadosIds.includes(b.id) ? 'checked' : ''}>
      <span class="u-op-55"${b.ativo ? '' : ''}>${esc(b.texto)}${b.ativo ? '' : ' <i>(indisponível)</i>'}</span>
    </label>`,
      )
      .join('');

  const porCiclo = {};
  planos.forEach((p) => {
    porCiclo[p.compromisso_meses] = porCiclo[p.compromisso_meses] || [];
    porCiclo[p.compromisso_meses].push(p);
  });

  // Item 9 da spec: os campos se dividem em dois. `data-grupo="vitrine"` salva
  // na hora, porque não alcança quem já assinou. `data-grupo="contrato"` não
  // salva sozinho: acende o botão da linha, e sair de lá é publicar uma versão
  // nova. Um input que parece salvar e devolve 409 seria pior que não ter.
  const contrato = (campo, p) => `data-campo="${campo}" data-grupo="contrato" data-id="${p.id}"`;
  const vitrine = (campo, p) => `data-campo="${campo}" data-grupo="vitrine" data-id="${p.id}"`;

  // Preço cheio e desconto são o que o admin digita; valor_mensal (o que é
  // cobrado de verdade) é sempre calculado a partir dos dois, no servidor —
  // por isso aqui é só leitura, recalculado ao vivo pra conferência.
  const valorComDesconto = (p) => {
    const cheio = Number(p.valor_mensal_cheio ?? p.valor_mensal);
    const desconto = Number(p.desconto_percentual) || 0;
    return Math.round(cheio * (1 - desconto / 100) * 100) / 100;
  };
  // O cartão do admin é o cartão da vitrine com os campos abertos: mesma
  // ordem (rótulo, nome, preço riscado + desconto, preço grande, lista de
  // benefícios) e o mesmo botão embaixo, só que salvando em vez de assinar.
  // A tabela de 15 colunas que havia aqui mostrava tudo e não parecia nada:
  // o dono editava preço sem ver o que o cliente ia ver.
  const cartaoPlano = (p) => `
    <div class="plano-edit ${p.destaque_no_site ? 'popular' : ''} ${p.ativo ? '' : 'fora'}" data-linha="${p.id}" data-ciclo="${p.compromisso_meses}">
      <div class="plano-edit-chips">
        <label class="chip-check" title="Marca como 'Mais escolhido' na vitrine">
          <input type="checkbox" ${vitrine('destaque_no_site', p)} ${p.destaque_no_site ? 'checked' : ''}> Mais escolhido
        </label>
        <label class="chip-check" title="Desmarcado, o plano some da vitrine — quem já assinou continua pagando igual">
          <input type="checkbox" ${vitrine('ativo', p)} ${p.ativo ? 'checked' : ''}> Na vitrine
        </label>
      </div>

      <input class="ed-rotulo" ${vitrine('rotulo', p)} value="${esc(p.rotulo)}" placeholder="Rótulo (opcional)" aria-label="Rótulo">
      <input class="ed-nome" ${contrato('nome', p)} value="${esc(p.nome)}" aria-label="Nome do plano">

      <div class="ed-precos">
        <label class="ed-campo">Preço cheio
          <span class="ed-moeda">R$<input type="number" step="0.01" min="0" ${contrato('valor_mensal_cheio', p)} data-preco-cheio="${p.id}" value="${p.valor_mensal_cheio ?? p.valor_mensal}"></span>
        </label>
        <label class="ed-campo">Desconto
          <span class="ed-moeda"><input type="number" step="0.01" min="0" max="99" ${contrato('desconto_percentual', p)} data-desconto="${p.id}" value="${p.desconto_percentual ?? ''}" placeholder="0">%</span>
        </label>
      </div>
      <div class="ed-preco-final">
        <b data-valor-final="${p.id}">${fmt(valorComDesconto(p))}</b>/mês
        <span class="u-dim">${p.compromisso_meses === 1 ? 'cobrado todo mês' : `· cobrado <b data-total-ciclo="${p.id}">${fmt(valorComDesconto(p) * p.compromisso_meses)}</b> a cada ${p.compromisso_meses} meses`}</span>
      </div>

      <ul class="ed-lista">
        <li class="ed-freq">
          <input type="number" min="10" max="3600" step="10" ${contrato('segundos_por_hora', p)} value="${p.segundos_por_hora ?? ''}" aria-label="Segundos de tela por hora">s de tela por hora, em cada ponto
          <span class="u-dim" data-horas-mes="${p.id}">${horasDeTelaPorMes(p)}</span>
        </li>
        <li class="ed-freq">
          <input type="number" min="1" max="999" ${contrato('pontos_incluidos', p)} value="${p.pontos_incluidos ?? ''}" aria-label="Pontos incluídos">pontos da rede, escolhidos pelo cliente
        </li>
        <li class="ed-freq">
          peça de até <input type="number" min="5" max="60" ${contrato('duracao_maxima_segundos', p)} value="${p.duracao_maxima_segundos ?? ''}" aria-label="Duração máxima da peça">segundos
        </li>
      </ul>
      <div class="benef-lista" data-beneficios-de="${p.id}">${opcoesBeneficio(p.beneficio_ids || [])}</div>

      <div class="ed-tecnicos">
        <label>Criativos<input type="number" min="1" max="3" ${contrato('limite_criativos', p)} value="${p.limite_criativos}"></label>
        <label title="Vazio = sem teto de vagas">Vagas<input type="number" min="1" ${vitrine('vagas', p)} value="${p.vagas ?? ''}" placeholder="∞"></label>
        <label title="Desconto extra (%) pra conta que também é dona de ponto (comodato), só nesse plano">Comodato %<input type="number" min="1" max="100" ${contrato('desconto_comodato_percentual', p)} value="${p.desconto_comodato_percentual ?? ''}" placeholder="-"></label>
      </div>

      <button class="btn primary block" data-nova-versao="${p.id}" disabled>Salvar novo plano</button>
      <p class="ed-id">${esc(p.id)} · ${CICLOS[p.compromisso_meses] || p.compromisso_meses + 'x'}</p>
    </div>`;

  el.innerHTML = `
    <details class="bloco-novo">
      <summary class="btn ghost mini">+ Novo plano (novo preço/promoção, não mexe no que já existe)</summary>
      <form class="card u-mt-12 u-mw-520" id="formNovoPlano">
        <div><label>ID único (ex.: destaque-black-friday)</label><input class="mini" name="id" required></div>
        <div><label>Tier</label><select class="mini" name="tier" required>
          <!-- rótulo = nome comercial de hoje; value = tier, que é chave de
               regra no código e não muda quando o nome muda. -->
          <option value="essencial">Essencial</option><option value="destaque">Pro</option><option value="maximo">Prime</option>
        </select></div>
        <div><label>Nome exibido</label><input class="mini" name="nome" required></div>
        <div class="field-row">
          <div class="u-col"><label>Compromisso</label><select class="mini" name="compromisso_meses" required>
            ${Object.entries(CICLOS)
              .map(([m, nome]) => `<option value="${m}" ${m === '3' ? 'selected' : ''}>${nome} (${m}x)</option>`)
              .join('')}
          </select></div>
          <div class="u-col"><label>Segundos de tela/hora</label><input class="mini" type="number" name="segundos_por_hora" value="90" min="10" max="3600" step="10" required></div>
        </div>
        <div class="field-row">
          <div class="u-col"><label>Pontos incluídos</label><input class="mini" type="number" name="pontos_incluidos" value="3" min="1" required></div>
          <div class="u-col"><label>Peça até (segundos)</label><input class="mini" type="number" name="duracao_maxima_segundos" value="15" min="5" max="60" required></div>
        </div>
        <div class="field-row">
          <div class="u-col"><label>Preço cheio (R$)</label><input class="mini" type="number" step="0.01" name="valor_mensal_cheio" required></div>
          <div class="u-col"><label>Desconto (%, vazio = sem desconto)</label><input class="mini" type="number" step="0.01" min="0" max="99" name="desconto_percentual"></div>
        </div>
        <div><label>Limite de criativos</label><input class="mini" type="number" name="limite_criativos" value="1" min="1" max="3" required></div>
        <!-- Cobertura virou rótulo histórico: quem manda agora é o campo de
             pontos incluídos, logo acima. Fica oculto porque o INSERT ainda
             exige a coluna. -->
        <div hidden><label>Cobertura</label><select class="mini" name="cobertura" required>
          <option value="todos_pontos">Todos os pontos</option><option value="tres_pontos_dia">3 pontos/dia</option><option value="um_ponto_dia">1 ponto/dia</option>
        </select></div>
        <div><label>Rótulo (ex.: "Preço promocional, travado pelo compromisso")</label><input class="mini" name="rotulo"></div>
        <div class="field-row">
          <div class="u-col"><label>Vagas (vazio = sem teto)</label><input class="mini" type="number" name="vagas" min="1"></div>
        </div>
        <div><label>Desconto comodato (%, vazio = nenhum)</label><input class="mini" type="number" name="desconto_comodato_percentual" min="1" max="100" title="Desconto extra pra conta que também é dona de ponto, só nesse plano"></div>
        <div class="field-row">
        </div>
        <div><label>Benefícios do plano</label><div class="benef-lista" id="novoPlanoBeneficios">${opcoesBeneficio([])}</div></div>
        <button class="btn primary" type="submit">Criar plano</button>
        <p class="form-msg" id="msgNovoPlano"></p>
      </form>
    </details>

    ${Object.keys(CICLOS)
      .map((meses) => {
        const doCiclo = porCiclo[meses] || [];
        const ativos = doCiclo.filter((p) => p.ativo).length;
        return `
      <div class="panel-head u-m-0 u-mt-24 u-mb-10">
        <h3>${CICLOS[meses]} <span class="badge ${ativos >= 3 ? 'badge-err' : 'badge-ok'} u-ml-6">${ativos}/3 na vitrine</span></h3>
      </div>
      ${doCiclo.length ? `<div class="planos-edit-grade">${doCiclo.map(cartaoPlano).join('')}</div>` : '<p class="empty-state u-py-6">Nenhum plano nessa modalidade.</p>'}`;
      })
      .join('')}

    <p class="empty-state u-ta-l u-p-0 u-pt-16">
      <b>Plano assinado é imutável pra quem assinou.</b> Nome, preço cheio, desconto, frequência, criativos, "tela após", desconto comodato e benefícios mudam o contrato:
      editar um deles acende "Salvar novo plano", que aposenta a versão atual e cria outra com id novo. Quem já assinou fica na antiga, pagando o mesmo.
      O valor cobrado é sempre calculado (preço cheio menos o desconto). Sem desconto, o preço cheio é o valor cobrado, e o site não mostra preço riscado.
      Vagas, rótulo, destaque e Ativo são só vitrine. Salvam na hora e não alcançam ninguém que já é cliente.
      Desativar um plano só tira ele do site; quem já assinou continua pagando o mesmo valor até cancelar.
      "Tela após": módulo cruzado. Ao completar esse nº de meses de cobertura, o anunciante ganha direito a uma tela no comércio dele (aparece como bônus no painel; o resgate cai em Candidaturas). O módulo inverso (ponto que ganha anúncio grátis) fica em Opções de comodato.
      "Desconto comodato": desconto extra pra conta que também é dona de ponto, por plano, que some do valor cobrado quando a conta tem o papel "ponto".
      Parceiro (antigo "fundador") não é plano de catálogo: é status de conta, marcado à mão em Anunciantes → "Marcar parceiro".
    </p>`;

  const valorDo = (inp) => {
    if (inp.type === 'checkbox') return inp.checked;
    if (inp.dataset.campo === 'nome' || inp.dataset.campo === 'rotulo') return inp.value || null;
    return inp.value === '' ? null : Number(inp.value);
  };
  // O botão fica sempre no pé do cartão (como o "Assinar" da vitrine), só
  // que desligado até algo de contrato mudar — botão que some é botão que o
  // dono procura, e botão sempre clicável convida a publicar versão à toa.
  const acenderBotao = (id) => {
    const btn = el.querySelector(`[data-nova-versao="${id}"]`);
    if (btn) btn.disabled = false;
  };

  el.querySelectorAll('[data-grupo="vitrine"]').forEach((inp) => {
    inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'blur', async () => {
      if (!(await salvar(`/admin/planos/${inp.dataset.id}`, { [inp.dataset.campo]: valorDo(inp) }, inp)))
        renderPlanos(el);
    });
  });

  el.querySelectorAll('[data-grupo="contrato"]').forEach((inp) => {
    inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', () => acenderBotao(inp.dataset.id));
  });

  // Preço cheio e desconto recalculam o valor final ao vivo, antes mesmo de
  // publicar a versão nova — pra conferir o resultado sem chute.
  el.querySelectorAll('[data-preco-cheio], [data-desconto]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const id = inp.dataset.precoCheio || inp.dataset.desconto;
      const linha = el.querySelector(`[data-linha="${id}"]`);
      const cheio = Number(linha.querySelector('[data-preco-cheio]').value) || 0;
      const desconto = Number(linha.querySelector('[data-desconto]').value) || 0;
      const final = Math.round(cheio * (1 - desconto / 100) * 100) / 100;
      linha.querySelector('[data-valor-final]').textContent = fmt(final);
      // Plano mensal não imprime total do ciclo (seria o mesmo número duas
      // vezes), então aqui o elemento pode não existir.
      const total = linha.querySelector('[data-total-ciclo]');
      if (total) total.textContent = fmt(final * Number(linha.dataset.ciclo));
    });
  });

  el.querySelectorAll('[data-beneficios-de]').forEach((caixa) => {
    caixa.addEventListener('change', () => acenderBotao(caixa.dataset.beneficiosDe));
  });

  el.querySelectorAll('[data-nova-versao]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.novaVersao;
      const linha = el.querySelector(`[data-linha="${id}"]`);
      const mudancas = {};
      linha.querySelectorAll('[data-grupo="contrato"]').forEach((inp) => {
        mudancas[inp.dataset.campo] = valorDo(inp);
      });
      const caixa = linha.querySelector('[data-beneficios-de]');
      if (caixa) mudancas.beneficio_ids = [...caixa.querySelectorAll('input:checked')].map((i) => Number(i.value));

      if (
        !confirm(
          `Publicar uma versão nova de "${id}"?\n\n` +
            'A versão atual é aposentada e vai pra "Planos arquivados". ' +
            'Quem já assinou continua nela, pagando o mesmo e com os mesmos benefícios. Nada muda pra essas contas. ' +
            'A versão nova vale só pra quem assinar daqui pra frente, e nasce com um id novo.',
        )
      )
        return;

      const r = await api(`/admin/planos/${id}/nova-versao`, { method: 'POST', body: JSON.stringify(mudancas) });
      if (!r.ok) {
        toast((await r.json().catch(() => ({}))).erro || 'Não deu pra publicar.', true);
        return;
      }
      toast(`Versão nova publicada: ${(await r.json()).id}`);
      renderPlanos(el);
    });
  });

  document.getElementById('formNovoPlano').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dados = Object.fromEntries(new FormData(e.target));
    dados.beneficio_ids = [...document.querySelectorAll('#novoPlanoBeneficios input:checked')].map((i) =>
      Number(i.value),
    );
    if (dados.vagas === '') delete dados.vagas;
    if (dados.desconto_comodato_percentual === '') delete dados.desconto_comodato_percentual;
    if (dados.desconto_percentual === '') delete dados.desconto_percentual;
    const msg = document.getElementById('msgNovoPlano');
    const r = await api('/admin/planos', { method: 'POST', body: JSON.stringify(dados) });
    if (!r.ok) {
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao criar.';
      msg.className = 'form-msg err';
      return;
    }
    toast('Plano criado.');
    renderPlanos(el);
  });
}

// ---------- pagar os pontos ----------
// As três rotas existiam desde a migration 022 e NENHUMA tinha tela: dava pra
// lançar e quitar só por curl. O dono do ponto via o extrato dele (que também
// não tinha tela até hoje) e o dono da rede não tinha por onde pagar.
async function renderPagamentosPontos(el) {
  const pontos = (await pegar('/admin/pontos')).filter((p) => p.status === 'em_operacao' || p.valor_pago_mensal > 0);
  if (!pontos.length) {
    el.innerHTML =
      '<p class="empty-state">Nenhum ponto ativo ainda. A ajuda de custo aparece aqui quando o primeiro ponto entrar no ar.</p>';
    return;
  }
  const mesAtual = new Date().toISOString().slice(0, 7);
  const listas = await Promise.all(pontos.map((p) => pegar(`/admin/pontos/${p.id}/pagamentos`)));

  const linhas = [];
  let aberto = 0;
  pontos.forEach((p, i) => {
    (listas[i] || []).forEach((l) => {
      if (!l.pago_em) aberto += Number(l.valor);
      linhas.push({ ...l, ponto_nome: p.nome });
    });
  });
  linhas.sort((a, b) => String(b.competencia).localeCompare(String(a.competencia)));

  const semLancamento = pontos.filter(
    (_p, i) => !(listas[i] || []).some((l) => String(l.competencia).slice(0, 7) === mesAtual),
  );

  el.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">Em aberto</span><b>${fmt(aberto)}</b><span class="kpi-caption">lançado e ainda não pago</span></div>
      <div class="kpi-card"><span class="kpi-label">Sem lançamento em ${esc(mesAtual)}</span><b>${semLancamento.length}</b><span class="kpi-caption">de ${pontos.length} ponto(s) ativo(s)</span></div>
    </div>

    <div class="panel-head u-m-0 u-mt-24 u-mb-10"><h3>Lançar o mês</h3></div>
    <form class="card u-mw-520" id="formPagPonto">
      <div><label for="pagPonto">Ponto</label><select class="mini" id="pagPonto" required>
        ${pontos.map((p) => `<option value="${p.id}">${esc(p.nome)} (${fmt(p.valor_pago_mensal || 0)}/mês)</option>`).join('')}
      </select></div>
      <div class="field-row">
        <div class="u-col"><label for="pagComp">Competência</label><input class="mini" id="pagComp" type="month" value="${mesAtual}" required></div>
        <div class="u-col"><label for="pagValor">Valor (R$)</label><input class="mini" id="pagValor" type="number" step="0.01" min="0" required></div>
      </div>
      <div class="field-row">
        <div class="u-col"><label for="pagForma">Forma</label><input class="mini" id="pagForma" placeholder="pix, dinheiro, desconto…"></div>
        <div class="u-col"><label for="pagObs">Observação</label><input class="mini" id="pagObs"></div>
      </div>
      <label class="check-row"><input type="checkbox" id="pagJaPago"><span>Já paguei, lançar direto como quitado</span></label>
      <button class="btn primary" type="submit">Lançar</button>
      <p class="form-msg" id="msgPagPonto"></p>
    </form>

    <div class="panel-head u-m-0 u-mt-24 u-mb-10"><h3>Lançamentos</h3></div>
    ${
      linhas.length
        ? `<div class="tabela-caixa"><div class="rolagem"><table><thead><tr>
      <th data-ord>Competência</th><th data-ord>Ponto</th><th class="num">Valor</th><th data-ord>Situação</th><th>Forma</th><th>Observação</th><th></th>
    </tr></thead><tbody>
    ${linhas
      .map(
        (l) => `<tr data-filtro="${l.pago_em ? 'pago' : 'aberto'}">
      <td>${esc(String(l.competencia).slice(0, 7))}</td>
      <td>${esc(l.ponto_nome)}</td>
      <td class="num"><b>${fmt(l.valor)}</b></td>
      <td>${l.pago_em ? `<span class="badge badge-ok">pago ${data(l.pago_em)}</span>` : '<span class="badge badge-pendente">em aberto</span>'}</td>
      <td>${esc(l.forma || '-')}</td>
      <td class="u-ws-normal u-mw-240 u-fs-72">${esc(l.observacao || '-')}</td>
      <td><button class="btn ${l.pago_em ? 'ghost' : 'primary'} mini" data-quitar="${l.id}" data-pago="${l.pago_em ? '0' : '1'}">${l.pago_em ? 'Desfazer' : 'Marcar como pago'}</button></td>
    </tr>`,
      )
      .join('')}
    </tbody></table></div></div>`
        : '<p class="empty-state">Nenhum lançamento ainda.</p>'
    }
    <p class="empty-state u-ta-l u-p-0 u-pt-16">Um lançamento por ponto por mês. O banco recusa o segundo da mesma competência, então duplo clique não vira pagamento dobrado. O dono do ponto vê exatamente esta lista no painel dele, em "Meus recebimentos".</p>`;

  if (linhas.length) turbinarTabela(el.querySelector('.tabela-caixa'));

  document.getElementById('formPagPonto').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgPagPonto');
    const corpo = {
      competencia: document.getElementById('pagComp').value,
      valor: Number(document.getElementById('pagValor').value),
      forma: document.getElementById('pagForma').value.trim() || null,
      observacao: document.getElementById('pagObs').value.trim() || null,
    };
    if (document.getElementById('pagJaPago').checked) corpo.pago_em = new Date().toISOString();
    const r = await api(`/admin/pontos/${document.getElementById('pagPonto').value}/pagamentos`, {
      method: 'POST',
      body: JSON.stringify(corpo),
    });
    if (!r.ok) {
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'Não deu pra lançar.';
      msg.className = 'form-msg err';
      return;
    }
    toast('Lançado.');
    renderPagamentosPontos(el);
  });

  el.querySelectorAll('[data-quitar]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const r = await api(`/admin/pagamentos-ponto/${btn.dataset.quitar}`, {
        method: 'PATCH',
        body: JSON.stringify({ pago: btn.dataset.pago === '1' }),
      });
      if (!r.ok) return toast('Não deu pra atualizar.', true);
      toast(btn.dataset.pago === '1' ? 'Pagamento quitado.' : 'Quitação desfeita.');
      renderPagamentosPontos(el);
    }),
  );
}

// ---------- métrica ----------
// As três consultas da seção 9 do funcional, numa tela só. O que elas
// respondem e por que são essas três está em src/admin/metrica.js — aqui é só
// a leitura.
async function renderMetrica(el) {
  const m = await pegar('/admin/metrica');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
  const ultimo = m.margem[m.margem.length - 1] || {};

  const funil = m.funil.length
    ? m.funil
    : [{ mes: '-', cadastros: 0, aprovacoes: 0, checkouts_abertos: 0, pagamentos: 0 }];
  const totalFunil = funil.reduce(
    (t, f) => ({
      cadastros: t.cadastros + f.cadastros,
      aprovacoes: t.aprovacoes + f.aprovacoes,
      checkouts_abertos: t.checkouts_abertos + f.checkouts_abertos,
      pagamentos: t.pagamentos + f.pagamentos,
    }),
    { cadastros: 0, aprovacoes: 0, checkouts_abertos: 0, pagamentos: 0 },
  );

  el.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">Margem deste mês</span><b>${fmt(ultimo.margem || 0)}</b>
        <span class="delta ${Number(ultimo.margem) >= 0 ? 'up' : 'down'}">${Number(ultimo.margem) >= 0 ? 'no azul' : 'no vermelho'}</span></div>
      <div class="kpi-card"><span class="kpi-label">Chega ao checkout e paga</span><b>${pct(totalFunil.pagamentos, totalFunil.checkouts_abertos)}</b>
        <span class="kpi-caption">${totalFunil.pagamentos} de ${totalFunil.checkouts_abertos} em ${m.meses} meses</span></div>
      <div class="kpi-card"><span class="kpi-label">Cadastra e paga</span><b>${pct(totalFunil.pagamentos, totalFunil.cadastros)}</b>
        <span class="kpi-caption">${totalFunil.pagamentos} de ${totalFunil.cadastros} cadastros</span></div>
    </div>

    <div class="panel-head u-m-0 u-mt-24 u-mb-10"><h3>Margem mês a mês</h3><span class="kpi-caption">receita confirmada − pontos − amortização − fixos</span></div>
    <div class="tabela-caixa"><div class="rolagem"><table><thead><tr>
      <th>Mês</th><th class="num">Receita</th><th class="num">Pontos</th><th class="num">Amortização</th><th class="num">Fixos</th><th class="num">Margem</th>
    </tr></thead><tbody>
    ${m.margem
      .map(
        (r) => `<tr>
      <td>${esc(r.mes)}</td>
      <td class="num">${fmt(r.receita)}</td>
      <td class="num">${fmt(r.custo_pontos)}</td>
      <td class="num">${fmt(r.amortizacao)}</td>
      <td class="num">${fmt(r.custos_fixos)}</td>
      <td class="num"><b class="${Number(r.margem) >= 0 ? 'delta up' : 'delta down'}">${fmt(r.margem)}</b></td>
    </tr>`,
      )
      .join('')}
    </tbody></table></div></div>
    <p class="form-hint u-m-0 u-mb-20">Os três custos são os de <b>hoje</b>, repetidos em todo mês da tabela: o sistema não guarda quanto a rede custava em março. Só a receita é histórica de verdade.</p>

    <div class="panel-head u-m-0 u-mt-24 u-mb-10"><h3>Funil, mês a mês</h3><span class="kpi-caption">cadastrou → aprovado → abriu o checkout → pagou</span></div>
    <div class="tabela-caixa"><div class="rolagem"><table><thead><tr>
      <th>Mês</th><th class="num">Cadastros</th><th class="num">Aprovações</th><th class="num">Checkouts abertos</th><th class="num">Pagamentos</th><th class="num">Checkout → pago</th>
    </tr></thead><tbody>
    ${
      m.funil.length
        ? m.funil
            .map(
              (f) => `<tr>
      <td>${esc(f.mes)}</td>
      <td class="num">${f.cadastros}</td>
      <td class="num">${f.aprovacoes}</td>
      <td class="num">${f.checkouts_abertos}</td>
      <td class="num"><b>${f.pagamentos}</b></td>
      <td class="num">${pct(f.pagamentos, f.checkouts_abertos)}</td>
    </tr>`,
            )
            .join('')
        : '<tr><td colspan="6" class="u-dim">Nenhum evento ainda.</td></tr>'
    }
    </tbody></table></div></div>

    <div class="panel-head u-m-0 u-mt-24 u-mb-10"><h3>Tempo das suas filas</h3><span class="kpi-caption">últimas 90 dias, por semana</span></div>
    <div class="tabela-caixa"><div class="rolagem"><table><thead><tr>
      <th>Semana</th><th>Fila</th><th class="num">Quantidade</th><th class="num">Mediana (h)</th><th class="num">Pior caso (h)</th>
    </tr></thead><tbody>
    ${
      m.filas.length
        ? m.filas
            .map(
              (f) => `<tr>
      <td>${esc(f.semana)}</td>
      <td>${f.nome === 'conta:aprovacao_recebe' ? 'Reinstalar conta suspensa' : 'Aprovar criativo'}</td>
      <td class="num">${f.quantidade}</td>
      <td class="num"><b>${f.mediana_horas ?? '-'}</b></td>
      <td class="num">${f.pior_caso_horas ?? '-'}</td>
    </tr>`,
            )
            .join('')
        : '<tr><td colspan="5" class="u-dim">Nada aprovado nos últimos 90 dias.</td></tr>'
    }
    </tbody></table></div></div>
    <p class="form-hint u-m-0 u-mb-20">Mediana, não média: uma conta esquecida por duas semanas puxaria a média e esconderia que o resto sai no mesmo dia.</p>

    <details>
      <summary class="u-pointer u-dim u-fs-85 u-py-8">Instrumentação: o que está sendo gravado</summary>
      <div class="tabela-caixa u-mt-8"><div class="rolagem"><table><thead><tr>
        <th>Evento</th><th class="num">Total</th><th class="num">Internos</th><th>Último</th>
      </tr></thead><tbody>
      ${
        m.eventos.length
          ? m.eventos
              .map(
                (e) => `<tr>
        <td><code>${esc(e.nome)}</code></td>
        <td class="num">${e.total}</td>
        <td class="num">${e.internos}</td>
        <td>${data(e.ultimo)}</td>
      </tr>`,
              )
              .join('')
          : '<tr><td colspan="4" class="u-dim">Nenhum evento gravado ainda.</td></tr>'
      }
      </tbody></table></div></div>
      <p class="form-hint">Evento que nunca aparece aqui é evento que ninguém emite. <code>exibicao:video_toca</code> não entra nesta tabela de propósito. Ele já existe agregado em "Telas", por hora e por anunciante, com programadas e confirmadas.</p>
    </details>`;
}

// ---------- planos arquivados ----------
// Versão aposentada não some: quem assinou nela continua pagando o que
// contratou, e é essa tela que responde "quantas contas ainda dependem desta
// versão" — a pergunta que precede qualquer limpeza.
async function renderPlanosArquivados(el) {
  const planos = await pegar('/admin/planos-arquivados');
  if (!planos.length) {
    el.innerHTML =
      '<p class="empty-state">Nenhuma versão aposentada ainda. Quando você publicar uma versão nova de um plano, a anterior aparece aqui.</p>';
    return;
  }
  const emUso = planos.filter((p) => p.contas_ativas > 0).length;
  el.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">Versões aposentadas</span><b>${planos.length}</b><span class="kpi-caption">${emUso} ainda com conta ativa</span></div>
    </div>
    <div class="tabela-caixa"><div class="rolagem"><table><thead><tr>
      <th data-ord>ID</th><th data-ord>Nome</th><th data-ord>Ciclo</th><th data-ord>Valor mensal</th>
      <th data-ord>Criativos</th><th data-ord>Tela/hora</th><th data-ord>Pontos</th><th>Benefícios</th>
      <th data-ord>Aposentada em</th><th>Substituída por</th><th data-ord>Contas ativas</th><th data-ord>Cobranças</th>
    </tr></thead><tbody>
    ${planos
      .map(
        (p) => `<tr>
      <td><b>${esc(p.id)}</b></td>
      <td>${esc(p.nome)}</td>
      <td>${CICLOS[p.compromisso_meses] || `${p.compromisso_meses}x`}</td>
      <td>${fmt(p.valor_mensal)}</td>
      <td class="num">${p.limite_criativos}</td>
      <td class="num">${p.segundos_por_hora ?? '-'}s/h</td>
      <td class="num">${p.pontos_incluidos ?? 'todos'}</td>
      <td class="u-fs-72 u-ws-normal u-mw-240">${(p.beneficios || []).map(esc).join(' · ') || '-'}</td>
      <td>${data(p.arquivado_em)}</td>
      <td>${esc(p.substituido_por || '-')}</td>
      <td class="num">${
        p.contas_ativas > 0 ? `<span class="badge badge-ok">${p.contas_ativas}</span>` : '<span class="u-dim">0</span>'
      }</td>
      <td class="num">${p.cobrancas}</td>
    </tr>`,
      )
      .join('')}
    </tbody></table></div></div>
    <p class="empty-state u-ta-l u-p-0 u-pt-16">
      Zero contas ativas não quer dizer "pode apagar já": cobrança confirmada guarda o <code>plano_id</code> por obrigação fiscal,
      e apagar a versão levaria junto a referência da nota. Drop de linha aqui é decisão do dono, em migration própria (Lei das migrations aditivas).
    </p>`;
  turbinarTabela(el.querySelector('.tabela-caixa'));
}

// ---------- benefícios ----------
async function renderBeneficios(el) {
  const beneficios = await pegar('/admin/beneficios');
  const corpo = `<table><thead><tr><th data-ord>Texto</th><th data-ord>Ordem</th><th data-ord>Disponível</th><th></th></tr></thead><tbody>
    ${beneficios
      .map(
        (b) => `<tr data-filtro="${b.ativo ? 'ativo' : 'inativo'}">
      <td><input class="mini u-w-360" data-benef="texto" data-id="${b.id}" value="${esc(b.texto)}"></td>
      <td><input class="mini u-w-60" type="number" data-benef="ordem" data-id="${b.id}" value="${b.ordem}"></td>
      <td class="u-ta-c"><input type="checkbox" data-benef="ativo" data-id="${b.id}" ${b.ativo ? 'checked' : ''} title="Desmarcado some da lista dos planos sem apagar nada"></td>
      <td><button class="btn ghost mini" data-excluir="${b.id}">Excluir</button></td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = `
    <form class="card bloco-novo u-mw-520" id="formNovoBeneficio">
      <div><label>Novo benefício</label><input class="mini" name="texto" placeholder="ex.: Até 3 criativos ativos, revezando entre si" required></div>
      <div><label>Ordem (menor aparece primeiro)</label><input class="mini" type="number" name="ordem" value="0"></div>
      <button class="btn primary" type="submit">Criar benefício</button>
      <p class="form-msg" id="msgNovoBeneficio"></p>
    </form>
    ${
      beneficios.length
        ? caixaTabela({
            chips: [
              { valor: '', nome: 'Todos' },
              { valor: 'ativo', nome: 'Disponíveis' },
              { valor: 'inativo', nome: 'Indisponíveis' },
            ],
            html: corpo,
            dica: 'Excluir tira o benefício de todos os planos que o usavam.',
          })
        : '<p class="empty-state">Nenhum benefício cadastrado.</p>'
    }`;

  if (beneficios.length) turbinarTabela(el.querySelector('.tabela-caixa'));

  el.querySelectorAll('[data-benef]').forEach((inp) =>
    inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'blur', () => {
      const valor =
        inp.type === 'checkbox' ? inp.checked : inp.dataset.benef === 'ordem' ? Number(inp.value) : inp.value;
      salvar(`/admin/beneficios/${inp.dataset.id}`, { [inp.dataset.benef]: valor }, inp);
    }),
  );

  el.querySelectorAll('[data-excluir]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Excluir esse benefício de todos os planos?')) return;
      const r = await api(`/admin/beneficios/${btn.dataset.excluir}`, { method: 'DELETE' });
      toast(
        r.ok ? 'Benefício excluído.' : (await r.json().catch(() => ({}))).erro || 'Não foi possível excluir.',
        r.ok ? '' : 'err',
      );
      renderBeneficios(el);
    }),
  );

  document.getElementById('formNovoBeneficio').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovoBeneficio');
    const r = await api('/admin/beneficios', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    if (!r.ok) {
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao criar.';
      msg.className = 'form-msg err';
      return;
    }
    renderBeneficios(el);
  });
}

// ---------- categorias ----------
async function renderCategorias(el) {
  const categorias = await pegar('/admin/categorias');
  const corpo = `<table><thead><tr><th data-ord>Nome</th><th data-ord>Aparece no cadastro</th><th></th></tr></thead><tbody>
    ${categorias
      .map(
        (c) => `<tr data-filtro="${c.ativo ? 'ativo' : 'inativo'}">
      <td><input class="mini u-w-300" data-cat="nome" data-id="${c.id}" value="${esc(c.nome)}"></td>
      <td class="u-ta-c"><input type="checkbox" data-cat="ativo" data-id="${c.id}" ${c.ativo ? 'checked' : ''}></td>
      <td><button class="btn ghost mini" data-excluir="${c.id}">Excluir</button></td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = `
    <form class="card bloco-novo u-mw-420" id="formNovaCategoria">
      <div><label>Nova categoria</label><input class="mini" name="nome" placeholder="ex.: Tatuagem / piercing" required></div>
      <button class="btn primary" type="submit">Criar categoria</button>
      <p class="form-msg" id="msgNovaCategoria"></p>
    </form>
    ${
      categorias.length
        ? caixaTabela({
            chips: [
              { valor: '', nome: 'Todas' },
              { valor: 'ativo', nome: 'No cadastro' },
              { valor: 'inativo', nome: 'Fora do cadastro' },
            ],
            html: corpo,
            dica: 'Categoria já usada por alguém cadastrado não pode ser excluída. Desmarque para parar de oferecer.',
          })
        : '<p class="empty-state">Nenhuma categoria cadastrada.</p>'
    }`;

  if (categorias.length) turbinarTabela(el.querySelector('.tabela-caixa'));

  el.querySelectorAll('[data-cat]').forEach((inp) =>
    inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'blur', () => {
      salvar(
        `/admin/categorias/${inp.dataset.id}`,
        { [inp.dataset.cat]: inp.type === 'checkbox' ? inp.checked : inp.value },
        inp,
      );
    }),
  );

  el.querySelectorAll('[data-excluir]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Excluir essa categoria? É ela que impede concorrente do mesmo ramo na mesma tela.')) return;
      const r = await api(`/admin/categorias/${btn.dataset.excluir}`, { method: 'DELETE' });
      toast(
        r.ok ? 'Categoria excluída.' : (await r.json().catch(() => ({}))).erro || 'Não foi possível excluir.',
        r.ok ? '' : 'err',
      );
      renderCategorias(el);
    }),
  );

  document.getElementById('formNovaCategoria').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovaCategoria');
    const r = await api('/admin/categorias', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    if (!r.ok) {
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao criar.';
      msg.className = 'form-msg err';
      return;
    }
    renderCategorias(el);
  });
}

// ---------- opções de comodato ----------
async function renderComodato(el) {
  const [opcoes, planos] = await Promise.all([pegar('/admin/planos-ponto'), pegar('/admin/planos')]);
  const selectPlano = (o) => `<select class="mini u-w-140" data-pp="plano_bonus_id" data-id="${o.id}">
      <option value="">(sem bônus)</option>
      ${planos.map((p) => `<option value="${esc(p.id)}" ${p.id === o.plano_bonus_id ? 'selected' : ''}>${esc(p.nome)} · ${CICLOS[p.compromisso_meses] || p.compromisso_meses + 'x'}</option>`).join('')}
    </select>`;
  el.innerHTML = `
    <details class="bloco-novo">
      <summary class="btn ghost mini">+ Nova opção de comodato</summary>
      <form class="card u-mt-12 u-mw-420" id="formNovaOpcao">
        <div><label>Id (sem espaço, ex.: ajuda-custo)</label><input class="mini" name="id" required pattern="[a-z0-9-]+"></div>
        <div><label>Nome</label><input class="mini" name="nome" required></div>
        <div><label>Chamada no site</label><textarea class="mini u-resize-v" name="chamada" rows="2" required></textarea></div>
        <div class="field-row">
          <div class="u-col"><label>Ajuda de custo (R$/mês)</label><input class="mini" type="number" step="0.01" min="0" name="ajuda_custo_mensal" value="0"></div>
          <div class="u-col"><label>Cota (espaços/hora)</label><input class="mini" type="number" min="0" name="cota_slots_hora" value="1"></div>
          <div class="u-col"><label>Ordem</label><input class="mini" type="number" name="ordem" value="10"></div>
        </div>
        <button class="btn primary" type="submit">Criar opção</button>
        <p class="form-msg" id="msgNovaOpcao"></p>
      </form>
    </details>
    <div class="tabela-caixa"><div class="rolagem"><table><thead><tr>
      <th>Opção</th><th>Ajuda de custo (R$/mês)</th><th>Cota (espaços/hora)</th><th>Chamada no site</th><th>Benefícios (1 por linha)</th>
      <th>Bônus: plano de anúncio</th><th>após (meses)</th><th>por (meses)</th><th>Ordem</th><th>Ativa</th>
    </tr></thead><tbody>
      ${opcoes
        .map(
          (o) => `<tr>
        <td class="u-ws-normal"><input class="mini u-w-120" data-pp="nome" data-id="${o.id}" value="${esc(o.nome)}">
          <div class="u-dim u-fs-72 u-mt-2">${esc(o.id)}</div></td>
        <td><input class="mini u-w-80" type="number" step="0.01" min="0" data-pp="ajuda_custo_mensal" data-id="${o.id}" value="${o.ajuda_custo_mensal}"></td>
        <td><input class="mini u-w-60" type="number" min="0" data-pp="cota_slots_hora" data-id="${o.id}" value="${o.cota_slots_hora}"></td>
        <td><textarea class="mini u-w-260 u-resize-v" data-pp="chamada" data-id="${o.id}" rows="3">${esc(o.chamada)}</textarea></td>
        <td><textarea class="mini u-w-240 u-resize-v" data-pp="beneficios" data-id="${o.id}" rows="4">${esc((o.beneficios || []).join('\n'))}</textarea></td>
        <td>${selectPlano(o)}</td>
        <td><input class="mini u-w-60" type="number" min="1" data-pp="plano_bonus_apos_meses" data-id="${o.id}" value="${o.plano_bonus_apos_meses ?? ''}" placeholder="-"></td>
        <td><input class="mini u-w-60" type="number" min="1" data-pp="plano_bonus_meses" data-id="${o.id}" value="${o.plano_bonus_meses ?? ''}" placeholder="-"></td>
        <td><input class="mini u-w-60" type="number" data-pp="ordem" data-id="${o.id}" value="${o.ordem}"></td>
        <td class="u-ta-c"><input type="checkbox" data-pp="ativo" data-id="${o.id}" ${o.ativo ? 'checked' : ''}></td>
      </tr>`,
        )
        .join('')}
    </tbody></table></div></div>
    <p class="empty-state u-ta-l u-p-0 u-pt-12">Ajuda de custo e cota são copiadas pro ponto no momento em que ele entra. Mudar aqui não altera o que já foi combinado com quem já está na rede. "Bônus": módulo cruzado. Ponto ativo há N meses ganha M meses do plano de anúncio escolhido, sem pagar (o dono resgata no painel dele).</p>`;

  // A rota de criar opção de comodato existia desde sempre e não tinha
  // formulário em lugar nenhum: dava pra editar as duas opções nascidas na
  // migration, nunca criar uma terceira (nem recriar uma apagada).
  document.getElementById('formNovaOpcao').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msgNovaOpcao');
    const dados = Object.fromEntries(new FormData(e.target));
    dados.ajuda_custo_mensal = Number(dados.ajuda_custo_mensal || 0);
    dados.cota_slots_hora = Number(dados.cota_slots_hora || 0);
    dados.ordem = Number(dados.ordem || 0);
    const r = await api('/admin/planos-ponto', { method: 'POST', body: JSON.stringify(dados) });
    if (!r.ok) {
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'Erro ao criar.';
      msg.className = 'form-msg err';
      return;
    }
    toast('Opção de comodato criada.');
    renderComodato(el);
  });

  el.querySelectorAll('[data-pp]').forEach((inp) =>
    inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'blur', () => {
      let valor;
      if (inp.type === 'checkbox') valor = inp.checked;
      else if (inp.dataset.pp === 'beneficios')
        valor = inp.value
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
      else if (['nome', 'chamada', 'plano_bonus_id'].includes(inp.dataset.pp)) valor = inp.value || null;
      else if (['plano_bonus_apos_meses', 'plano_bonus_meses'].includes(inp.dataset.pp))
        valor = inp.value === '' ? null : Number(inp.value);
      else valor = Number(inp.value);
      salvar(`/admin/planos-ponto/${inp.dataset.id}`, { [inp.dataset.pp]: valor }, inp);
    }),
  );
}

// ---------- mensagens do site ----------
// A migration 039 passou a gravar a mensagem antes de tentar o e-mail, pra que
// falha de SMTP perdesse o aviso e não o dado. Só que ninguém lia a tabela: o
// dado ficava salvo e invisível — o mesmo furo por outra porta, e pior, porque
// /contato.html é o canal declarado de pedido do titular (LGPD art. 18).
async function renderContato(el) {
  const msgs = await pegar('/admin/mensagens-contato');
  const abertas = msgs.filter((m) => !m.respondida_em).length;
  const semAviso = msgs.filter((m) => !m.email_enviado).length;

  const corpo = `<table><thead><tr>
      <th data-ord>Quando</th><th data-ord>Quem</th><th>Mensagem</th><th data-ord>Aviso</th><th>Respondida</th>
    </tr></thead><tbody>
    ${msgs
      .map(
        (m) => `<tr data-filtro="${m.respondida_em ? 'respondida' : 'aberta'}">
      <td>${data(m.created_at)}</td>
      <td><b>${esc(m.nome)}</b><br><a href="mailto:${esc(m.email)}">${esc(m.email)}</a>${m.telefone ? `<br><span class="u-dim">${esc(m.telefone)}</span>` : ''}</td>
      <td><div class="celula-mensagem">${esc(m.mensagem)}</div></td>
      <td>${m.email_enviado ? '<span class="badge badge-ok">enviado</span>' : '<span class="badge badge-err">não saiu</span>'}</td>
      <td><label class="chip-check"><input type="checkbox" data-respondida="${m.id}" ${m.respondida_em ? 'checked' : ''}> ${m.respondida_em ? data(m.respondida_em) : 'marcar'}</label></td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = msgs.length
    ? `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">Esperando resposta</span><b>${abertas}</b><span class="kpi-caption">pedido de dados tem prazo legal</span></div>
      <div class="kpi-card"><span class="kpi-label">Aviso por e-mail não saiu</span><b>${semAviso}</b><span class="kpi-caption">${semAviso ? 'só aparecem aqui' : 'todas chegaram na caixa'}</span></div>
    </div>
    ${caixaTabela({
      chips: [
        { valor: '', nome: 'Todas' },
        { valor: 'aberta', nome: 'Esperando resposta' },
        { valor: 'respondida', nome: 'Respondidas' },
      ],
      html: corpo,
      dica: 'Responda pelo e-mail da pessoa e marque aqui.',
    })}`
    : '<p class="empty-state">Ninguém escreveu pelo site ainda.</p>';

  el.querySelectorAll('[data-respondida]').forEach((chk) => {
    chk.addEventListener('change', async () => {
      const r = await api(`/admin/mensagens-contato/${chk.dataset.respondida}`, {
        method: 'PATCH',
        body: JSON.stringify({ respondida: chk.checked }),
      });
      if (!r.ok) {
        chk.checked = !chk.checked;
        return toast('Não deu pra salvar.', 'err');
      }
      irPara('contato', true);
    });
  });
}

// ---------- trocas de plano ----------
// Seção F, item 17. O pedido pago já entrava em Cobranças e o que falhava já
// virava pendência, mas nenhuma tela respondia "quem trocou, de qual plano
// pra qual, e quando" — e é essa a pergunta que diz se o mecanismo pegou.
// Leitura pura: daqui não se altera pedido nenhum.
async function renderTrocas(el) {
  const pedidos = await pegar('/admin/pedidos-avulsos');
  const pagos = pedidos.filter((p) => p.status === 'pago');
  const arrecadado = pagos.reduce((t, p) => t + Number(p.valor), 0);
  const pendentes = pedidos.filter((p) => p.status === 'pendente').length;

  const corpo = `<table><thead><tr>
      <th data-ord>Anunciante</th><th data-ord>De</th><th data-ord>Para</th>
      <th data-ord>Diferença</th><th data-ord>Situação</th><th data-ord>Pedido em</th><th data-ord>Pago em</th>
    </tr></thead><tbody>
    ${pedidos
      .map(
        (p) => `<tr data-filtro="${p.status}">
      <td><b>${esc(p.nome_empresa)}</b></td>
      <td>${p.plano_atual_nome ? esc(p.plano_atual_nome) : '<span class="u-dim">sem plano</span>'}</td>
      <td>${esc(p.plano_novo_nome)} <span class="u-dim">${CICLOS[p.plano_novo_meses] || `${p.plano_novo_meses}x`}</span></td>
      <td>${fmt(p.valor)}</td>
      <td><span class="badge ${p.status === 'pago' ? 'badge-ok' : p.status === 'cancelado' ? 'badge-err' : 'badge-pendente'}">${TROCA_STATUS[p.status] || p.status}</span></td>
      <td>${data(p.criado_em)}</td>
      <td>${p.pago_em ? data(p.pago_em) : '-'}</td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = pedidos.length
    ? `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">Trocas pagas</span><b>${pagos.length}</b><span class="kpi-caption">${fmt(arrecadado)} em diferenças</span></div>
      <div class="kpi-card"><span class="kpi-label">Esperando pagamento</span><b>${pendentes}</b><span class="kpi-caption">o cliente abriu o checkout e não concluiu</span></div>
    </div>
    ${caixaTabela({
      chips: [
        { valor: '', nome: 'Todas' },
        { valor: 'pago', nome: 'Pagas' },
        { valor: 'pendente', nome: 'Pendentes' },
        { valor: 'cancelado', nome: 'Canceladas' },
      ],
      html: corpo,
      dica: 'Troca é pagamento único: não deixa renovação automática no lugar da antiga.',
    })}`
    : '<p class="empty-state">Ninguém trocou de plano ainda.</p>';
}

// ---------- cobranças ----------
async function renderCobrancas(el) {
  const cobrancas = await pegar('/admin/cobrancas');
  const total = cobrancas.reduce((t, c) => t + Number(c.valor), 0);
  const pendentes = cobrancas.filter((c) => c.nota_fiscal_status !== 'emitida').length;

  const corpo = `<table><thead><tr>
      <th data-ord>ID</th><th data-ord>Anunciante</th><th data-ord>Valor</th><th data-ord>Data</th><th>Nota fiscal</th>
    </tr></thead><tbody>
    ${cobrancas
      .map(
        (c) => `<tr data-filtro="${c.nota_fiscal_status}">
      <td>${c.id}</td>
      <td><b>${esc(c.nome_empresa)}</b></td>
      <td>${fmt(c.valor)}</td>
      <td>${data(c.criado_em)}</td>
      <td>${
        c.nota_fiscal_status === 'emitida'
          ? `<span class="badge badge-ok">emitida</span> <a href="${esc(c.nota_fiscal_url)}" target="_blank" rel="noopener">ver PDF</a>`
          : `<input type="file" accept="application/pdf" class="mini u-w-140" data-cobranca="${c.id}">`
      }</td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = cobrancas.length
    ? `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">Total confirmado</span><b>${fmt(total)}</b><span class="kpi-caption">${cobrancas.length} cobrança(s)</span></div>
      <div class="kpi-card"><span class="kpi-label">Notas por emitir</span><b>${pendentes}</b><span class="kpi-caption">envie o PDF na linha</span></div>
    </div>
    ${caixaTabela({
      chips: [
        { valor: '', nome: 'Todas' },
        { valor: 'pendente', nome: 'Sem nota' },
        { valor: 'emitida', nome: 'Com nota' },
      ],
      html: corpo,
      dica: 'Selecionar o PDF já envia a nota.',
    })}`
    : '<p class="empty-state">Nenhuma cobrança confirmada ainda.</p>';

  if (!cobrancas.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('input[data-cobranca]').forEach((input) =>
    input.addEventListener('change', async () => {
      if (!input.files[0]) return;
      const form = new FormData();
      form.append('arquivo', input.files[0]);
      const r = await fetch(`${API_BASE_URL}/admin/cobrancas/${input.dataset.cobranca}/nota-fiscal`, {
        method: 'PATCH',
        credentials: 'include',
        body: form,
      });
      toast(r.ok ? 'Nota fiscal anexada.' : 'Não foi possível anexar a nota.', r.ok ? '' : 'err');
      if (r.ok) {
        RESUMO = await pegar('/admin/resumo');
        pintarContadores();
        renderCobrancas(el);
      }
    }),
  );
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
    ${comissoes
      .map(
        (c) => `<tr data-filtro="${c.pago_em ? 'pago' : 'aberto'}">
      <td><b>${esc(c.vendedor_nome)}</b></td>
      <td>${esc(c.nome_empresa)}</td>
      <td>${fmt(c.valor_confirmado)}</td>
      <td><b>${fmt(c.comissao_valor)}</b></td>
      <td>${data(c.criado_em)}</td>
      <td>${esc(c.chave_pix || '-')}</td>
      <td>${
        c.pago_em
          ? `<span class="badge badge-ok">pago ${data(c.pago_em)}</span> <button class="btn ghost mini" data-pago="${c.id}" data-valor="0">Desfazer</button>`
          : `<button class="btn primary mini" data-pago="${c.id}" data-valor="1">Marcar como paga</button>`
      }</td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = comissoes.length
    ? `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">Total a pagar</span><b>${fmt(totalAPagar)}</b><span class="kpi-caption">${aReceber.length} comissão(ões) em aberto</span></div>
      ${Object.entries(porVendedor)
        .slice(0, 3)
        .map(
          ([nome, d]) => `
        <div class="kpi-card"><span class="kpi-label">${esc(nome)}</span><b>${fmt(d.total)}</b><span class="kpi-caption">${esc(d.pix || 'sem chave Pix')}</span></div>`,
        )
        .join('')}
    </div>
    ${caixaTabela({
      chips: [
        { valor: 'aberto', nome: 'A pagar' },
        { valor: 'pago', nome: 'Pagas' },
        { valor: '', nome: 'Todas' },
      ],
      html: corpo,
      dica: 'Marcar como paga só registra aqui. O Pix é feito por fora.',
    })}`
    : '<p class="empty-state">Nenhuma comissão gerada ainda. Elas aparecem quando um anunciante indicado por um vendedor tem o pagamento confirmado.</p>';

  if (!comissoes.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('[data-pago]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (await salvar(`/admin/comissoes/${btn.dataset.pago}`, { pago: btn.dataset.valor === '1' }))
        renderComissoes(el);
    }),
  );
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
    ${pedidos
      .map(
        (p) => `<tr data-filtro="${p.status}">
      <td><b>${p.id}</b></td>
      <td>${esc(p.nome_empresa)}<div class="u-dim u-fs-72">${esc(p.contato_email)}</div></td>
      <td>${esc(p.cpf_cnpj)}</td>
      <td><b>${fmt(p.valor_a_estornar)}</b></td>
      <td>${data(p.pedido_em)}</td>
      <td>${
        p.status === 'estornado'
          ? `<span class="badge badge-ok">devolvido ${data(p.estornado_em)}</span>`
          : '<span class="badge badge-pendente">a devolver</span>'
      }</td>
      <td>${
        p.status === 'estornado'
          ? `<span class="u-dim u-fs-72">${esc(p.comprovante || '-')}</span>`
          : `<input class="u-w-160" placeholder="id do estorno" data-comp="${p.id}">
           <button class="btn primary mini" data-estornado="${p.id}">Registrar devolução</button>`
      }</td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = pedidos.length
    ? `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">A devolver</span><b>${fmt(totalAberto)}</b><span class="kpi-caption">${abertos.length} pedido(s) em aberto</span></div>
    </div>
    ${caixaTabela({
      chips: [
        { valor: 'pendente', nome: 'A devolver' },
        { valor: 'estornado', nome: 'Devolvidas' },
        { valor: '', nome: 'Todas' },
      ],
      html: corpo,
      dica: 'A devolução é feita no painel do San Checkout/Asaas. Aqui você registra o comprovante pra fechar o pedido.',
    })}`
    : '<p class="empty-state">Ninguém desistiu de uma contratação até agora.</p>';

  if (!pedidos.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('[data-estornado]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const campo = el.querySelector(`[data-comp="${btn.dataset.estornado}"]`);
      // `salvar()` forca PATCH e esta rota e POST — a fila de devolucao nunca
      // fechava, o pedido ficava aberto pra sempre e o dinheiro devolvido nao
      // era registrado em lugar nenhum.
      const r = await api(`/admin/arrependimentos/${btn.dataset.estornado}/estornado`, {
        method: 'POST',
        body: JSON.stringify({ comprovante: campo.value.trim() }),
      });
      if (!r.ok) {
        toast((await r.json().catch(() => ({}))).erro || 'Nao deu pra registrar.', true);
        return;
      }
      toast('Devolucao registrada.');
      renderArrependimentos(el);
    }),
  );
}

// ---------- eventos pendentes ----------
async function renderEventos(el) {
  const eventos = await pegar('/admin/eventos-pendentes');
  // Teste do e-mail aqui dentro de propósito: quando um evento fica pendente
  // por falha de envio, esta é a tela onde você está. O botão faz o login no
  // servidor de SMTP e diz na hora se a senha de app está valendo — sem
  // mandar mensagem nenhuma e sem esperar um pagamento real acontecer.
  const smtp = `<div class="tabela-caixa u-mb-16" style="padding:14px">
    <b>E-mail (SMTP)</b>
    <p class="u-fs-84 u-mt-8 u-mb-8">Confere se o servidor aceita a senha de app. Não envia e-mail e não mostra a senha.</p>
    <button class="btn ghost mini" id="testarSmtp">Testar agora</button>
    <div id="resultadoSmtp" class="u-fs-84 u-mt-8"></div>
  </div>`;
  el.innerHTML =
    smtp +
    (eventos.length
      ? `<div class="tabela-caixa"><div class="rolagem"><table><thead><tr>
      <th>ID</th><th>Motivo</th><th>Quando</th><th>Dados recebidos</th><th></th>
    </tr></thead><tbody>
    ${eventos
      .map(
        (e) => `<tr>
      <td>${e.id}</td>
      <td><b>${esc(e.motivo)}</b></td>
      <td>${new Date(e.criado_em).toLocaleString('pt-BR')}</td>
      <td class="u-ws-normal"><details><summary class="u-pointer u-txt-link">ver payload</summary>
        <pre class="u-fs-72 u-bg-alt u-p-8 u-r-6 u-o-auto u-mw-460">${esc(JSON.stringify(e.payload, null, 2))}</pre></details></td>
      <td class="u-ws-normal">
        ${e.payload?.planoId ? `<button class="btn primary mini" data-aplicar="${e.id}">Aplicar este ciclo</button> ` : ''}
        <button class="btn ghost mini" data-resolver="${e.id}">Só marcar resolvido</button>
      </td>
    </tr>`,
      )
      .join('')}
  </tbody></table></div></div>`
      : '<p class="empty-state">Nenhum evento pendente de revisão.</p>');

  el.querySelector('#testarSmtp')?.addEventListener('click', async (ev) => {
    const alvo = el.querySelector('#resultadoSmtp');
    ev.target.disabled = true;
    alvo.textContent = 'testando...';
    try {
      const r = await pegar('/admin/diagnostico/smtp');
      const detalhe = `${esc(r.host || '?')}:${r.porta || '?'} · ${esc(r.usuario || '?')} · senha com ${r.senha_caracteres} caracteres${r.senha_tem_espaco ? ' (TEM ESPAÇO — a senha de app do Gmail tem 16 e os espaços não entram)' : ''}`;
      alvo.innerHTML = r.ok
        ? `<span class="badge badge-ok">Funcionando</span> O servidor aceitou a senha.<br><span class="u-fs-72">${detalhe}</span>`
        : `<span class="badge badge-err">Não passou</span> ${esc(r.erro || 'erro desconhecido')}<br><span class="u-fs-72">${detalhe}</span>${r.dica ? `<div class="u-mt-8"><b>Provável causa:</b> ${esc(r.dica)}</div>` : ''}`;
    } catch (err) {
      alvo.innerHTML = `<span class="badge badge-err">Não deu pra testar</span> ${esc(err.message || '')}`;
    }
    ev.target.disabled = false;
  });

  el.querySelectorAll('button[data-resolver]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (
        !window.confirm(
          'Marcar resolvido NÃO credita ciclo nenhum: só tira o item da fila. Use isto quando já tiver resolvido por fora. Continuar?',
        )
      )
        return;
      if (await salvar(`/admin/eventos-pendentes/${btn.dataset.resolver}`, {})) {
        RESUMO = await pegar('/admin/resumo');
        pintarContadores();
        renderEventos(el);
      }
    }),
  );

  el.querySelectorAll('button[data-aplicar]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (
        !window.confirm(
          'Aplicar o ciclo desta assinatura: estende a cobertura, registra a cobrança e a comissão. Continuar?',
        )
      )
        return;
      const r = await fetch(`${API_BASE_URL}/admin/eventos-pendentes/${btn.dataset.aplicar}/aplicar`, {
        method: 'POST',
        credentials: 'include',
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) return window.alert(corpo.erro || 'não foi possível aplicar esse ciclo agora');
      RESUMO = await pegar('/admin/resumo');
      pintarContadores();
      renderEventos(el);
    }),
  );
}
