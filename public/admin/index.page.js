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

// ---------- horário de funcionamento (migration 066) ----------
// Mesmo formato de src/lib/horario-semanal.js: um objeto por dia da semana,
// `null` (fechado) ou `{abre,fecha}`. O admin só LÊ (a ficha do ponto é
// somente-leitura desde o redesenho de 22/09/2026 — quem preenche é a
// candidatura, public/modos.js/painel.page.js, que mantêm a própria cópia
// editável do widget, convenção do projeto sem bundler).
//
// Texto curto pro card ("Seg-sex 09:00-18:00 · Sáb 09:00-15:00 · Dom
// fechado") — mesma regra de src/lib/horario-semanal.js#resumo.
function resumoHorarioSemanal(horario) {
  if (!horario) return null;
  const f = (v) => (v ? `${v.abre}-${v.fecha}` : 'fechado');
  const semana = ['seg', 'ter', 'qua', 'qui', 'sex'].map((d) => horario[d]);
  const semanaIgual = semana.every((v) => JSON.stringify(v) === JSON.stringify(semana[0]));
  const partes = semanaIgual
    ? [`Seg-sex ${f(semana[0])}`]
    : ['seg', 'ter', 'qua', 'qui', 'sex'].map((d, i) => `${['Seg', 'Ter', 'Qua', 'Qui', 'Sex'][i]} ${f(horario[d])}`);
  partes.push(`Sáb ${f(horario.sab)}`, `Dom ${f(horario.dom)}`);
  return partes.join(' · ');
}

// Busca de categoria (22/09/2026, ~230 categorias — select tradicional parou
// de fazer sentido) — mesma ideia de public/formulario.js#montarBusca, versão
// admin: aqui não há <select> pra esconder por baixo, é tudo montado direto
// no template string, então o "valor" fica num input hidden. Duplicado de
// propósito (sem bundler, sem import entre os dois front-ends — ver README).
function normalizarBuscaCategoria(txt) {
  return (txt || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function categoriaBuscaHtml(idPrefixo, categoriaAtual, { placeholder, name } = {}) {
  return `<div class="categoria-busca-wrap">
    <input type="text" class="mini categoria-busca" id="${idPrefixo}Busca" autocomplete="off"
      placeholder="${esc(placeholder || 'Pesquise a categoria...')}" value="${categoriaAtual ? esc(categoriaAtual.nome) : ''}">
    <input type="hidden" id="${idPrefixo}Id" ${name ? `name="${name}"` : ''} value="${categoriaAtual ? categoriaAtual.id : ''}">
    <ul class="categoria-resultados" id="${idPrefixo}Resultados" hidden></ul>
  </div>`;
}

// `categorias`: a lista completa do admin (`GET /admin/categorias`, inclui
// legado/inativa) — só entram na BUSCA as ativas e não-legado (não faz
// sentido oferecer categoria descontinuada pra escolha nova), mas o valor já
// selecionado (`categoriaBuscaHtml`, acima) mostra o nome de qualquer uma,
// legado ou não, porque desfazer uma associação existente não é a mesma
// decisão que criar uma nova.
//
// `excluirId` (Mesclar, tela Categorias): tira a própria categoria da busca.
// Quem bateu pelo NOME vem antes de quem bateu só pelo alias — mesma regra
// de public/formulario.js.
function ligarCategoriaBusca(idPrefixo, categorias, aoEscolher, { excluirId = null } = {}) {
  const input = document.getElementById(`${idPrefixo}Busca`);
  const hiddenId = document.getElementById(`${idPrefixo}Id`);
  const lista = document.getElementById(`${idPrefixo}Resultados`);
  if (!input) return;
  const comBusca = categorias
    .filter((c) => c.ativo && !c.legado && c.id !== excluirId)
    .map((c) => ({
      ...c,
      busca: normalizarBuscaCategoria(`${c.nome} ${(c.aliases || []).join(' ')}`),
      buscaNome: normalizarBuscaCategoria(c.nome),
    }));

  function abrir(termo) {
    const alvo = normalizarBuscaCategoria(termo);
    const bateu = alvo
      ? comBusca
          .filter((c) => c.busca.includes(alvo))
          .map((c) => ({ c, peso: c.buscaNome.startsWith(alvo) ? 0 : c.buscaNome.includes(alvo) ? 1 : 2 }))
          .sort((a, b) => a.peso - b.peso)
          .map((x) => x.c)
      : comBusca;
    lista.innerHTML =
      bateu
        .slice(0, 40)
        .map(
          (c) => `<li data-id="${c.id}">${esc(c.nome)}<span class="categoria-grupo">${esc(c.grupo || '')}</span></li>`,
        )
        .join('') || '<li class="categoria-vazio">Nada encontrado.</li>';
    lista.hidden = false;
  }
  input.addEventListener('focus', () => abrir(input.value));
  input.addEventListener('input', () => {
    abrir(input.value);
    if (!input.value) hiddenId.value = '';
  });
  input.addEventListener('blur', () => setTimeout(() => (lista.hidden = true), 150));
  lista.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    e.preventDefault();
    const categoria = comBusca.find((c) => String(c.id) === li.dataset.id);
    if (!categoria) return;
    input.value = categoria.nome;
    hiddenId.value = categoria.id;
    lista.hidden = true;
    if (aoEscolher) aoEscolher(categoria);
  });
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

// ---------- modal ----------
// Modal de verdade (reconstrução de Contas + Categorias, 23/09/2026, Parte
// 17: nada de prompt()/confirm()/alert() nativo em fluxo que mexe com plano,
// acesso ou cadastro). <dialog> com showModal(): o navegador já cuida de
// fundo escurecido, ESC e foco preso dentro — mesma escolha do painel do
// cliente (dlgPerfil/dlgPlano em style.css), sem lib. `corpo` e `rodape` são
// HTML: quem chama escapa o que veio de fora com esc(), como no resto do
// arquivo. O <dialog> se remove sozinho do DOM ao fechar.
function abrirModal({ titulo, corpo, rodape = '', largo = false }) {
  const dlg = document.createElement('dialog');
  dlg.className = `modal-admin${largo ? ' modal-largo' : ''}`;
  dlg.innerHTML = `<div class="modal-caixa">
      <div class="modal-topo"><h3>${esc(titulo)}</h3><button type="button" class="modal-x" data-fechar aria-label="Fechar">×</button></div>
      <div class="modal-corpo">${corpo}</div>
      ${rodape ? `<div class="modal-rodape">${rodape}</div>` : ''}
    </div>`;
  document.body.appendChild(dlg);
  const fechar = () => {
    if (dlg.open) dlg.close();
  };
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', fechar));
  // Clique no fundo (fora da caixa) fecha — o próprio <dialog> é o fundo.
  dlg.addEventListener('mousedown', (e) => {
    if (e.target === dlg) fechar();
  });
  dlg.showModal();
  return { dlg, fechar };
}

// Confirmação em modal → Promise<boolean>. `texto` é HTML (já escapado).
function confirmarModal({ titulo, texto, botao = 'Confirmar', perigo = false }) {
  return new Promise((resolve) => {
    let confirmou = false;
    const { dlg, fechar } = abrirModal({
      titulo,
      corpo: texto,
      rodape: `<button type="button" class="btn ghost" data-fechar>Cancelar</button>
        <button type="button" class="btn ${perigo ? 'perigo' : 'primary'}" data-confirmar>${esc(botao)}</button>`,
    });
    dlg.querySelector('[data-confirmar]').addEventListener('click', () => {
      confirmou = true;
      fechar();
    });
    dlg.addEventListener('close', () => resolve(confirmou));
  });
}

// Mensagem de erro dentro do modal (em vez de toast escondido atrás do fundo).
function erroNoModal(dlg, texto) {
  const msg = dlg.querySelector('[data-msg]');
  if (!msg) return toast(texto, 'err');
  msg.textContent = texto;
  msg.className = 'form-msg err';
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

  // `tr.textContent` não enxerga o `value` de <input>/<select> — só texto de
  // verdade no DOM. Numa linha inteira de campos editáveis (categorias, por
  // exemplo: nome/grupo/aliases são todos <input>) a busca nunca achava
  // nada, silenciosamente (achado montando a busca por grupo da reforma de
  // categorias, 22/09/2026 — a busca "reaproveitada" estava quebrada pra
  // qualquer tabela só de inputs, não só a nova).
  function textoBuscavel(tr) {
    const valores = [...tr.querySelectorAll('input, select')].map((c) => c.value).join(' ');
    return `${tr.textContent} ${valores}`.toLowerCase();
  }

  function aplicar() {
    const termo = (busca ? busca.value : '').toLowerCase().trim();
    const chipAtivo = caixa.querySelector('.chip.active');
    const filtro = chipAtivo ? chipAtivo.dataset.filtro || '' : '';
    let visiveis = 0;
    linhas().forEach((tr) => {
      const casaTermo = !termo || textoBuscavel(tr).includes(termo);
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
        // `data-valor` = o valor de ordenar quando o texto visível não serve
        // (data "23/09/2026" ordenaria por dia, não por data).
        if (celula.dataset.valor !== undefined) return celula.dataset.valor;
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
// `ativo`: chip que já entra marcado (por valor, não por índice) — quem
// chega de outra tela já filtrado (ex.: "Pontos por status" na Visão geral)
// não vê "Todos" primeiro pra depois clicar de novo. Sem isso, o padrão é o
// primeiro chip, igual sempre foi.
function caixaTabela({ chips = [], html, dica = '', ativo = null }) {
  const valorAtivo = ativo !== null && chips.some((c) => c.valor === ativo) ? ativo : chips[0]?.valor;
  return `<div class="tabela-caixa">
    <div class="tabela-topo">
      <input class="busca" type="search" placeholder="Buscar...">
      <div class="chips">${chips.map((c) => `<button type="button" class="chip ${c.valor === valorAtivo ? 'active' : ''}" data-filtro="${c.valor}">${esc(c.nome)}</button>`).join('')}</div>
    </div>
    <div class="rolagem">${html}</div>
    <div class="tabela-pe"><span data-contagem></span><span>${dica}</span></div>
  </div>`;
}

// Mesma casca de caixaTabela (busca + chips + rodapé), pra uma grade de
// cards em vez de linhas de tabela (21/09/2026 — cards de ponto). O shell
// visual (.tabela-caixa/.tabela-topo/.busca/.chips) já era genérico o
// bastante pra servir aos dois; só o conteúdo e o item que a busca/o chip
// filtram mudam (`.ponto-card` em vez de `<tr>`).
function caixaCards({ chips = [], html, dica = '', ativo = null }) {
  const valorAtivo = ativo !== null && chips.some((c) => c.valor === ativo) ? ativo : chips[0]?.valor;
  return `<div class="tabela-caixa">
    <div class="tabela-topo">
      <input class="busca" type="search" placeholder="Buscar...">
      <div class="chips">${chips.map((c) => `<button type="button" class="chip ${c.valor === valorAtivo ? 'active' : ''}" data-filtro="${c.valor}">${esc(c.nome)}</button>`).join('')}</div>
    </div>
    <div class="pontos-grid u-p-14">${html}</div>
    <div class="tabela-pe"><span data-contagem></span><span>${dica}</span></div>
  </div>`;
}

function turbinarCards(caixa, seletorItem, substantivo = 'ponto') {
  const itens = () => [...caixa.querySelectorAll(seletorItem)];
  const busca = caixa.querySelector('.busca');
  const contagem = caixa.querySelector('[data-contagem]');

  function aplicar() {
    const termo = (busca ? busca.value : '').toLowerCase().trim();
    const chipAtivo = caixa.querySelector('.chip.active');
    const filtro = chipAtivo ? chipAtivo.dataset.filtro || '' : '';
    let visiveis = 0;
    itens().forEach((card) => {
      const casaTermo = !termo || card.textContent.toLowerCase().includes(termo);
      const casaFiltro = !filtro || (card.dataset.filtro || '').split(' ').includes(filtro);
      card.hidden = !(casaTermo && casaFiltro);
      if (!card.hidden) visiveis += 1;
    });
    if (contagem) contagem.textContent = `${visiveis} de ${itens().length}`;
    let aviso = caixa.querySelector('[data-vazio]');
    if (visiveis > 0) {
      if (aviso) aviso.hidden = true;
      return;
    }
    if (!aviso) {
      aviso = document.createElement('p');
      aviso.className = 'empty-state';
      aviso.setAttribute('data-vazio', '');
      caixa.querySelector('.pontos-grid').insertAdjacentElement('afterend', aviso);
    }
    aviso.hidden = false;
    // Mensagem distingue busca de filtro (seção 15 do redesenho da Rede,
    // 22/09/2026) — "nenhum ponto neste status" não é a mesma frustração de
    // "sua busca não achou nada", e o card genérico não dizia qual delas.
    aviso.textContent = termo
      ? `Nenhum ${substantivo} encontrado para esta busca.`
      : `Nenhum ${substantivo} neste status.`;
  }

  if (busca) busca.addEventListener('input', aplicar);
  caixa.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      caixa.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
      chip.classList.add('active');
      aplicar();
    }),
  );
  aplicar();
}

// ---------- rótulos ----------
// Quatro status desde 22/09/2026 (migration 069, rodada final da Rede) —
// AUTOMÁTICO, derivado das telas do ponto (src/pontos/repository.js#sincronizarStatusPonto).
// Ninguém edita isso à mão em lugar nenhum do admin.
const PONTO_STATUS = {
  a_instalar: 'Aguardando instalação',
  em_operacao: 'Ativo',
  em_reparo: 'Em reparo',
  inativo: 'Inativo',
};
const PONTO_STATUS_CLASSE = {
  a_instalar: 'badge-pendente',
  em_operacao: 'badge-ok',
  em_reparo: 'badge-info',
  inativo: 'badge-err',
};
const TELA_STATUS = { ativo: 'Ativa', reparo: 'Em reparo', inativo: 'Inativa' };
const PAPEIS = { anunciante: 'Anunciante', ponto: 'Dono de ponto', vendedor: 'Vendedor' };
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

function selectStatus(mapa, atual, attrs) {
  return `<select class="mini" ${attrs}>
    ${Object.entries(mapa)
      .map(([v, nome]) => `<option value="${v}" ${v === atual ? 'selected' : ''}>${nome}</option>`)
      .join('')}
  </select>`;
}

// ---------- navegação ----------
// Redesenho de 21/09/2026: 25 itens independentes viraram 12 módulos
// agrupados por fluxo (docs/specs/2026-09-21-redesenho-admin.md). Nenhuma
// função de render mudou — cada aba abaixo chama exatamente a mesma função
// de antes. Os 25 hashes antigos continuam abrindo a tela certa: o roteador
// resolve o id antigo pro par módulo/aba novo por este mapa, então nenhum
// `href="#pontos"`/`irPara('telas')`/`data-ir="criativos"` espalhado pelas
// telas abaixo precisou mudar.
const ALIASES_ANTIGOS = {
  resumo: 'visaogeral/hoje',
  metrica: 'visaogeral/performance',
  // Entrada foi encerrada como área da navegação (22/09/2026, pedido do
  // dono): Candidaturas virou aba de Rede (pertence conceitualmente a
  // pontos, não a "gente entrando"), Mensagens virou rota sem menu própria
  // (aberta pelo aviso da Visão geral), Convites saiu da interface —
  // `renderConvites`/`/admin/convites` continuam existindo no código
  // (legado, sem UI) só não navega mais lá; o hash antigo `#convites` cai
  // sozinho em visaogeral (resolverAlvo já degrada assim quando o módulo
  // não existe mais).
  candidaturas: 'rede/candidaturas',
  contato: 'mensagens',
  criativos: 'aprovacao',
  meusanuncios: 'midiamostrai',
  pontos: 'rede/pontos',
  // Telas e Ocupação não são mais abas próprias (21/09/2026) — os três
  // hashes antigos caem na listagem de pontos; quem quiser a tela ou a
  // ocupação de um endereço específico abre o card dele.
  ocupacaopontos: 'rede/pontos',
  telas: 'rede/pontos',
  bancohoras: 'rede/pontos',
  // "Anunciantes" virou a aba "Contas" de Contas (rodada Contas, 22/09/2026).
  anunciantes: 'contas/contas',
  // "Planos" virou "Ofertas" (reformulação comercial, 22/09/2026) —
  // Arquivados e Benefícios não têm mais aba própria, caem em Preços (mesmo
  // padrão de telas/ocupação acima).
  planos: 'ofertas/precos',
  planosarquivados: 'ofertas/precos',
  beneficios: 'ofertas/precos',
  categorias: 'contas/categorias',
  comodato: 'configuracoes/comodato',
  eventos: 'configuracoes/diagnostico',
  // Financeiro (rodada 22/09/2026): Receitas/Repasses saem de página
  // permanente e viram drill-down oculto — os hashes antigos continuam
  // abrindo a tela certa, só que agora escondida da sidebar. Custos não tem
  // mais tela nenhuma (nem oculta): o hash antigo cai em visaogeral sozinho,
  // igual todo alias que aponta pra um módulo que não existe mais.
  cobrancas: 'financeiro/cobrancas',
  trocas: 'financeiro/trocas',
  arrependimentos: 'financeiro/devolucoes',
  comissoes: 'financeiro/comissoes',
  pagamentospontos: 'financeiro/repasses',
};
// Reverso: de "módulo/aba" novo pro id antigo — só pra reaproveitar o texto
// de SUBTITULOS sem duplicar nenhuma frase.
const ALIAS_REVERSO = Object.fromEntries(Object.entries(ALIASES_ANTIGOS).map(([velho, novo]) => [novo, velho]));

// Sidebar final (rodada Navegação, 22/09/2026, pedido do dono): lista PLANA,
// sem `grupo`/cabeçalho de seção — "MOSTRAÍ"/"OPERAÇÃO"/"COMERCIAL"/"SISTEMA"
// não existem mais. A ordem visível é a ordem literal do array (depois do
// filtro de `oculto` em `montarNav()`): Visão geral, Rede, Contas, Ofertas, e
// por último Mídia Mostraí — `destaque: true` faz `montarNav()` estilizar
// esse item como atalho especial (separação por espaçamento, não por
// título de seção). Configurações e Pendências saíram do array por completo
// (não só `oculto`): os hashes antigos (`#configuracoes`, `#pendencias` e
// filhos) caem sozinhos em `visaogeral`, porque `resolverAlvo()` já degrada
// assim quando `buscarModulo()` não acha o id — mesmo padrão do alias
// "custos", que também não tem módulo (nem oculto) desde a rodada Financeiro.
const MODULOS = [
  { id: 'visaogeral', nome: 'Visão geral', render: renderResumo },
  {
    // O ponto virou a entidade central (21/09/2026, pedido do dono):
    // Telas e Ocupação, que eram abas irmãs, agora vivem DENTRO do
    // detalhe de cada ponto (ver renderPontoDetalhe) — não navega mais
    // entre telas globais pra entender um endereço só. "Entrega" (banco
    // de horas) saiu do menu por pedido dele: a função e as rotas
    // continuam intactas (renderBancoHoras, src/bancohoras/routes.js),
    // só não tem mais superfície de navegação — ver ALIASES_ANTIGOS.
    id: 'rede',
    nome: 'Rede',
    abas: [
      // Sem `fila` de propósito (rodada de integridade, 23/09/2026): a fila
      // "pontos" contava ponto aguardando instalação e inflava o contador de
      // Rede como se fosse candidatura. O badge de Rede agora é só a fila
      // de candidaturas — a mesma que a aba Candidaturas lista.
      { id: 'pontos', nome: 'Pontos', render: renderPontos },
      // Candidatura é sempre pra ser PONTO (vendedor não passa mais por
      // aqui, 18/09/2026) — por isso mora em Rede, não numa área própria
      // de "entrada" (encerrada 22/09/2026, pedido do dono).
      { id: 'candidaturas', nome: 'Candidaturas', fila: 'candidaturas', render: renderCandidaturas },
    ],
  },
  {
    // "Anunciantes" virou "Contas" (rodada Contas, 22/09/2026, pedido do
    // dono): a entidade real não é "anunciante" — é uma conta, e toda conta
    // pode anunciar (reconstrução de 23/09/2026). Categorias
    // se mudou pra cá também (saiu de Configurações): é dado de conta
    // (e de ponto), não configuração de sistema — única fonte administrativa
    // agora, sem duplicar em outro lugar.
    id: 'contas',
    nome: 'Contas',
    abas: [
      { id: 'contas', nome: 'Contas', render: renderContasAba },
      { id: 'categorias', nome: 'Categorias', render: renderCategorias },
    ],
  },
  {
    // "Ofertas" (reformulação comercial, 22/09/2026) — substitui "Planos"
    // na navegação. Essencial/Pro/Prime são produtos fixos (Parte B do
    // pedido do dono); Arquivados e Benefícios saíram da UI de propósito
    // (Parte K/D) — `renderPlanos`/`renderPlanosArquivados`/
    // `renderBeneficios` continuam definidas mais abaixo, só sem aba que
    // chame, por enquanto (limpeza fica pra outra rodada, pedido
    // explícito: não gastar esta rodada removendo código legado). Comodato
    // (saiu de Configurações nesta rodada de Navegação) pertence
    // conceitualmente aqui também, mas a implementação comercial correta
    // está sendo tratada em outra frente — não reimplementado nesta rodada,
    // de propósito.
    id: 'ofertas',
    nome: 'Ofertas',
    abas: [
      { id: 'precos', nome: 'Preços', render: renderPrecos },
      { id: 'promocoes', nome: 'Promoções', render: renderPromocoes },
    ],
  },
  // "Conteúdo" foi desmontada (reorganização de 22/09/2026, pedido do
  // dono): Anúncios próprios virou página própria — Mídia Mostraí —, e
  // Aprovação perdeu item de menu (mesmo padrão de Mensagens abaixo: o
  // aviso mora na Visão geral, `oculto` tira o botão sem tirar o módulo
  // de `buscarModulo`, a rota `#aprovacao` continua funcionando).
  // `renderCriativos`/`renderMeusAnuncios` (a versão antiga, com "Criar
  // conta própria") continuam definidas mais abaixo como legado sem
  // chamador — `renderMeusAnuncios` foi substituída por `renderMidiaMostrai`.
  { id: 'aprovacao', nome: 'Aprovação de criativos', oculto: true, fila: 'criativos', render: renderCriativos },
  // Mensagens (22/09/2026): sem item próprio na sidebar — o aviso de
  // pendência mora na Visão geral (PENDENCIAS_OPERACIONAIS) e leva pra cá. `oculto`
  // tira o botão do menu sem tirar o módulo de `buscarModulo`, então a rota
  // (`#mensagens`, ou o hash antigo `#contato` via ALIASES_ANTIGOS) continua
  // funcionando normalmente.
  { id: 'mensagens', nome: 'Mensagens', oculto: true, render: renderContato },
  // Financeiro deixou de ser grupo próprio da sidebar (rodada Financeiro,
  // 22/09/2026, pedido do dono: "normalidade não ocupa espaço, pendência
  // aparece") — Receitas/Repasses/Custos como páginas permanentes saíram.
  // O que sobra é drill-down: a Visão geral mostra receita e pendências
  // reais (repasses/comissões/trocas/devoluções) e cada uma leva pra cá
  // por clique. `oculto` mantém a rota (`#financeiro/repasses` etc.) sem
  // nenhum botão na sidebar — mesmo padrão de "mensagens"/"vendedores".
  {
    id: 'financeiro',
    nome: 'Financeiro',
    oculto: true,
    abas: [
      { id: 'repasses', nome: 'Repasses', render: renderFilaRepasses },
      { id: 'comissoes', nome: 'Comissões', render: renderFilaComissoes },
      { id: 'trocas', nome: 'Trocas', render: renderFilaTrocas },
      { id: 'devolucoes', nome: 'Devoluções', render: renderFilaDevolucoes },
      { id: 'cobrancas', nome: 'Cobranças', render: renderHistoricoCobrancas },
    ],
  },
  // Último item de propósito (rodada Navegação, 22/09/2026): Mídia Mostraí é
  // "ação administrativa especial", não mais um item de "Conteúdo" — fica
  // sozinho no fim da lista, com `destaque: true` pra `montarNav()` desenhar
  // como atalho, separado do resto só por espaçamento (sem título de seção).
  { id: 'midiamostrai', nome: 'Mídia Mostraí', destaque: true, render: renderMidiaMostrai },
];

const buscarModulo = (id) => MODULOS.find((m) => m.id === id);

const SUBTITULOS = {
  visaogeral: 'O que precisa de você agora, o resultado do mês e a fotografia da rede.',
  criativos: 'Anúncios enviados pelos anunciantes esperando aprovação antes de entrar no ar.',
  candidaturas: 'Pedidos pra ter um ponto, de dentro do próprio painel. Aprovado vira ponto na hora.',
  contato: 'Quem escreveu pelo site — também é o canal de pedido de dados pessoais, com prazo legal pra responder.',
  pontos:
    'Comércios da rede: quem são, onde ficam e quantas telas têm. Abra um ponto pra ver telas, ocupação e editar o que é dele.',
  anunciantes:
    'Toda conta da rede — toda conta pode anunciar; quem tem ponto aparece como dono de ponto. Abra uma pra ver a ficha completa.',
  ofertas: 'Os 3 produtos da rede — Essencial, Pro e Prime — e as promoções vigentes.',
  categorias: 'Segmentos usados no cadastro, para impedir concorrente direto na mesma tela.',
  comodato:
    'O que o dono do ponto escolhe no "Seja um ponto": receber os R$ 50 com o plano Inicial junto, ou trocar os R$ 50 pelo plano Básico.',
  cobrancas: 'Histórico de pagamentos confirmados.',
  trocas: 'Quem trocou de plano no meio do período e ainda não pagou a diferença.',
  comissoes: 'Comissões de vendedor em aberto. Marcar como paga só registra aqui — o Pix é por fora.',
  pagamentospontos: 'Quem tem ajuda de custo de comodato pra pagar este mês.',
  eventos: 'Eventos do San Checkout que não deram pra correlacionar sozinhos.',
  arrependimentos:
    'Quem desistiu da contratação dentro dos 7 dias da lei e ainda espera a devolução. A devolução em si é feita no painel do Checkout; aqui só se registra o comprovante.',
  meusanuncios: 'Conteúdo institucional da própria rede.',
  pendencias:
    'As mesmas filas da Visão geral, juntas numa lista só — sem os números do mês, só o que precisa de você agora.',
};

let RESUMO = null;
let ABA_ATUAL = { modulo: null, aba: null, resto: null };

// Lista plana (rodada Navegação, 22/09/2026) — sem `.nav-grupo`, sem
// cabeçalho de seção. `destaque` (só em Mídia Mostraí) ganha a classe
// `.nav-item-destaque`, que traz a separação visual sozinha (espaçamento +
// borda), sem precisar de um título "FERRAMENTAS"/"CONTEÚDO" antes dela.
function montarNav() {
  document.getElementById('nav').innerHTML = MODULOS.filter((i) => !i.oculto)
    .map(
      (i) => `<button type="button" class="nav-item${i.destaque ? ' nav-item-destaque' : ''}" data-modulo="${i.id}">
      <span>${i.nome}</span><span class="cont" hidden></span>
    </button>`,
    )
    .join('');
}

function contarFilasDoModulo(modulo) {
  if (!RESUMO) return 0;
  const filas = modulo.abas ? modulo.abas.map((a) => a.fila).filter(Boolean) : [];
  return filas.reduce((soma, f) => soma + (RESUMO.filas?.[f] || 0), 0);
}

// Contadores no menu (e nas abas de dentro de um módulo) — o admin vê o que
// está pendente sem abrir nada.
function pintarContadores() {
  // `RESUMO.filas?.` e nao `RESUMO.filas.`: resposta parcial de /admin/resumo
  // derrubava o menu inteiro com "Cannot read properties of undefined", e um
  // menu morto esconde TODAS as filas — justo quando algo ja esta errado no
  // servidor. Contador zerado e degradacao; menu quebrado e apagao.
  if (!RESUMO) return;
  document.querySelectorAll('.nav-item[data-modulo]').forEach((btn) => {
    const modulo = buscarModulo(btn.dataset.modulo);
    const qtd = contarFilasDoModulo(modulo);
    const cont = btn.querySelector('.cont');
    cont.textContent = qtd;
    cont.hidden = qtd === 0;
  });
  document.querySelectorAll('.modulo-aba[data-aba]').forEach((btn) => {
    const modulo = buscarModulo(ABA_ATUAL.modulo);
    const aba = modulo?.abas?.find((a) => a.id === btn.dataset.aba);
    if (!aba?.fila) return;
    const qtd = RESUMO.filas?.[aba.fila] || 0;
    const cont = btn.querySelector('.cont');
    cont.textContent = qtd;
    cont.hidden = qtd === 0;
  });
}

// Resolve tanto um hash antigo ("pontos") quanto um novo ("rede/pontos") ou
// um módulo sozinho ("rede", cai na primeira aba). É o único lugar que sabe
// a diferença — todo o resto do arquivo continua chamando irPara('pontos')
// como sempre chamou.
//
// `resto` (21/09/2026): tudo que vem depois do módulo/aba, cru, sem
// interpretar — hoje serve pro detalhe de um ponto (`rede/pontos/42`, ou
// `rede/pontos/42/telas` pra abrir direto numa sub-aba do detalhe) e pro
// detalhe de uma conta (`contas/contas/42`, aba "Contas" dentro do módulo
// Contas). Quem dá sentido ao `resto` é a própria tela
// (`renderPontos`/`renderContasAba`), não o roteador — mesma regra de
// sempre, só um nível a mais.
function resolverAlvo(alvoBruto) {
  const bruto = alvoBruto || 'visaogeral';
  // O alias pode bater com o hash inteiro ("categorias" → "contas/categorias")
  // ou só com o primeiro pedaço, sobrando um id ("anunciantes/42", link velho
  // de conta — vira "contas/contas/42"). Sem o segundo caso, um módulo que
  // virou aba (rodada Contas, 22/09/2026: "anunciantes" não existe mais como
  // id de módulo sozinho) perdia o `resto` e caía sempre em visaogeral.
  const [primeiro, ...resto] = bruto.split('/');
  const canonico =
    ALIASES_ANTIGOS[bruto] || (ALIASES_ANTIGOS[primeiro] ? [ALIASES_ANTIGOS[primeiro], ...resto].join('/') : bruto);
  const [moduloId, ...partes] = canonico.split('/');
  const modulo = buscarModulo(moduloId);
  if (!modulo) return { moduloId: 'visaogeral', abaId: null, resto: null };
  if (!modulo.abas) return { moduloId, abaId: null, resto: partes.join('/') || null };
  const aba = modulo.abas.find((a) => a.id === partes[0]) || modulo.abas[0];
  return { moduloId, abaId: aba.id, resto: partes.slice(1).join('/') || null };
}

function subtituloDe(moduloId, abaId) {
  const chave = abaId ? `${moduloId}/${abaId}` : moduloId;
  return SUBTITULOS[ALIAS_REVERSO[chave] || moduloId] || '';
}

// Módulo sem abas (Anunciantes, Vendedores, Custos, Pendências) renderiza
// direto no container, igual sempre foi. Módulo com abas monta a fileira de
// abas uma vez e só troca o conteúdo de dentro ao mudar de aba — a fileira
// não pisca, e cada função de render continua recebendo o mesmo tipo de `el`
// que sempre recebeu, só que agora pode ser o container da aba em vez do
// container da página inteira.
async function renderModulo(el, modulo, abaId, resto) {
  if (!modulo.abas) {
    el.textContent = 'Carregando...';
    try {
      await modulo.render(el, resto);
    } catch (err) {
      console.error(`falha ao montar o módulo ${modulo.id}`, err);
      el.innerHTML = '<p class="form-msg err">Não foi possível carregar esta seção. Clique em Atualizar.</p>';
    }
    return;
  }

  const abaAtiva = modulo.abas.find((a) => a.id === abaId) || modulo.abas[0];
  el.innerHTML = `
    <div class="modulo-abas">
      ${modulo.abas
        .map(
          (a) => `<button type="button" class="modulo-aba ${a.id === abaAtiva.id ? 'active' : ''}" data-aba="${a.id}">
        ${a.nome}<span class="cont" hidden></span>
      </button>`,
        )
        .join('')}
    </div>
    <div id="abaConteudo">Carregando...</div>`;

  pintarContadores();
  el.querySelectorAll('.modulo-aba').forEach((btn) =>
    btn.addEventListener('click', () => irPara(`${modulo.id}/${btn.dataset.aba}`)),
  );

  const subEl = document.getElementById('abaConteudo');
  try {
    await abaAtiva.render(subEl, resto);
  } catch (err) {
    console.error(`falha ao montar a aba ${modulo.id}/${abaAtiva.id}`, err);
    subEl.innerHTML = '<p class="form-msg err">Não foi possível carregar esta seção. Clique em Atualizar.</p>';
  }
}

async function irPara(alvoBruto, forcarResumo) {
  const { moduloId, abaId, resto } = resolverAlvo(alvoBruto);
  ABA_ATUAL = { modulo: moduloId, aba: abaId, resto };
  const canonico = [moduloId, abaId, resto].filter(Boolean).join('/');
  const modulo = buscarModulo(moduloId);

  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.modulo === moduloId));
  document.getElementById('tituloSecao').textContent = modulo.nome;
  document.getElementById('subSecao').textContent = subtituloDe(moduloId, abaId);
  if (location.hash !== `#${canonico}`) location.hash = canonico;

  if (!RESUMO || forcarResumo) {
    RESUMO = await pegar('/admin/resumo');
    pintarContadores();
  }

  await renderModulo(document.getElementById('conteudo'), modulo, abaId, resto);
}

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (btn) irPara(btn.dataset.modulo);
});
document
  .getElementById('btnRecarregar')
  .addEventListener('click', () => irPara(location.hash.slice(1) || 'visaogeral', true));
window.addEventListener('hashchange', () => {
  const alvo = location.hash.slice(1) || 'visaogeral';
  const { moduloId, abaId, resto } = resolverAlvo(alvo);
  // Achado testando a rodada Navegação (22/09/2026): com vários hashes
  // antigos caindo no MESMO destino de fallback (visaogeral — configuracoes,
  // configuracoes/comodato, configuracoes/diagnostico, pendencias), navegar
  // de um pro outro em sequência batia só nas três primeiras condições
  // (ABA_ATUAL já era 'visaogeral' desde a queda anterior) e pulava
  // `irPara` — a tela certa continuava no ar, mas a URL ficava travada no
  // hash antigo. `location.hash` comparado contra o canônico fecha esse
  // buraco sem abrir loop (a própria `irPara` só reatribui o hash quando ele
  // ainda não bate, e o hashchange seguinte já encontra tudo igual).
  const canonico = `#${[moduloId, abaId, resto].filter(Boolean).join('/')}`;
  if (
    ABA_ATUAL.modulo !== moduloId ||
    ABA_ATUAL.aba !== abaId ||
    ABA_ATUAL.resto !== resto ||
    location.hash !== canonico
  )
    irPara(alvo);
});

// ---------- login ----------
async function mostrarApp() {
  document.getElementById('gate').hidden = true;
  document.getElementById('app').hidden = false;
  montarNav();
  irPara(location.hash.slice(1) || 'visaogeral', true);
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
// Alertas de EXCEÇÃO operacional (rodada de integridade, 23/09/2026): só o
// que foge da rotina e só aparece quando existe. O trabalho pendente normal
// (candidaturas, criativos, mensagens, repasses, comissões, trocas,
// devoluções, falhas fiscais) saiu daqui e mora no resumo operacional fixo
// (`PENDENCIAS_OPERACIONAIS`, logo abaixo), que mostra também o zero.
//
// - "evento(s) de pagamento pra revisar" saiu na rodada Navegação
//   (22/09/2026): Diagnóstico deixou de existir na UI, não há destino.
// - "ponto(s) candidatos aguardando triagem" saiu na rodada de integridade:
//   contava ponto 'a_instalar' (já aprovado, só sem tela) como se fosse
//   candidatura. Candidatura de verdade está em PENDENCIAS_OPERACIONAIS.
// - Banco de horas não tem mais tela no admin desde 21/09/2026 (pedido do
//   dono, "Entrega" saiu do menu) — o aviso fica, mas sem link, porque
//   levar pra Rede/Pontos era levar pra um lugar onde não dá pra resolver.
// - Ponto travado por ocupação só se libera na tabela "Ocupação da rede"
//   desta mesma Visão geral — `rolar` desce até ela em vez de navegar pra
//   Rede/Pontos, onde o botão Liberar não existe.
const ALERTAS = [
  { fila: 'offline', aba: 'telas', texto: 'tela(s) ativas sem dar sinal', urgente: true },
  {
    fila: 'bancohoras',
    texto: 'saldo(s) do banco de horas esperando decisão',
    semLink: 'O banco de horas não tem mais tela no admin — resolver por suporte técnico.',
  },
  { fila: 'pontosocupados', rolar: 'ocupacaoRede', texto: 'ponto(s) travado(s) pra escolha nova por ocupação' },
];

// Resumo operacional FIXO (rodada de integridade, 23/09/2026, pedido do
// dono): mostra o zero de propósito — um contador que some não se distingue
// de um contador que deixou de carregar. Cada linha usa exatamente a mesma
// definição da tela de destino (mesma fila de `/admin/resumo`). `forte`:
// devolução tem prazo legal correndo (CDC art. 49), por isso é o único item
// que ganha destaque forte quando > 0; o resto ganha destaque moderado.
const PENDENCIAS_OPERACIONAIS = [
  { nome: 'Candidaturas', aba: 'rede/candidaturas', qtd: (r) => r.filas?.candidaturas },
  { nome: 'Criativos', aba: 'aprovacao', qtd: (r) => r.filas?.criativos },
  { nome: 'Mensagens', aba: 'mensagens', qtd: (r) => r.filas?.contato },
  {
    nome: 'Repasses',
    aba: 'financeiro/repasses',
    qtd: (r) => r.financeiro?.repassesPendentes?.qtd,
    valor: (r) => r.financeiro?.repassesPendentes?.total,
  },
  {
    nome: 'Comissões',
    aba: 'financeiro/comissoes',
    qtd: (r) => r.financeiro?.comissoesPendentes?.qtd,
    valor: (r) => r.financeiro?.comissoesPendentes?.total,
  },
  { nome: 'Trocas', aba: 'financeiro/trocas', qtd: (r) => r.financeiro?.trocasPendentes?.qtd },
  { nome: 'Devoluções', aba: 'financeiro/devolucoes', qtd: (r) => r.filas?.arrependimentos, forte: true },
  // Sem destino: não existe automação fiscal ainda, então não há fila pra
  // abrir. O backend devolve 0 fixo até ela existir.
  { nome: 'Falhas fiscais', qtd: (r) => r.filas?.falhasFiscais },
];

function painelPendenciasOperacionais(resumo) {
  const linhas = PENDENCIAS_OPERACIONAIS.map((p) => {
    const qtd = p.qtd(resumo);
    const carregou = typeof qtd === 'number' && Number.isFinite(qtd);
    const estado = !carregou ? 'pend-erro' : qtd === 0 ? 'pend-zero' : p.forte ? 'pend-forte' : 'pend-ativa';
    const valor = p.valor && carregou ? ` · ${fmt(p.valor(resumo) || 0)}` : '';
    const conteudo = `<span class="pend-nome">${p.nome}</span><b class="pend-qtd">${carregou ? qtd : '—'}${valor}</b>`;
    return p.aba
      ? `<button type="button" class="pend-linha ${estado}" data-ir="${p.aba}">${conteudo}</button>`
      : `<div class="pend-linha ${estado}">${conteudo}</div>`;
  }).join('');
  return `
    <div class="panel u-mb-16">
      <div class="panel-head"><h3>Pendências operacionais</h3></div>
      <div class="pend-lista">${linhas}</div>
    </div>`;
}

// `paraAba`: quando informado, cada linha vira botão que navega pra lá com
// o status já filtrado (ver FILTRO_PONTOS_STATUS/data-status-clique, uma
// linha abaixo). Sem isso, continua puro texto, como sempre foi.
function barrasHorizontais(linhas, mapa, paraAba = null) {
  if (!linhas.length) return '<p class="empty-state u-py-8">Nada cadastrado ainda.</p>';
  const max = Math.max(...linhas.map((l) => l.qtd)) || 1;
  const tag = paraAba ? 'button' : 'div';
  return `<div class="bar-chart-h">${linhas
    .map(
      (l) => `
    <${tag} ${paraAba ? `type="button" class="row row-clicavel" data-status-clique="${esc(l.status)}"` : 'class="row"'}>
      <span class="nome">${esc(mapa[l.status] || l.status)}</span>
      <span class="track"><span class="fill" data-pct="${(l.qtd / max) * 100}"></span></span>
      <span class="valor">${l.qtd}</span>
    </${tag}>`,
    )
    .join('')}</div>`;
}

// Linha da conciliação diária na Visão geral. Ela é o que salva quem pagou e
// cujo webhook se perdeu; sem esta linha, não havia onde responder "ela rodou
// hoje?" — e o cron ainda está por configurar no Northflank.
function linhaConciliacao(c) {
  if (!c) {
    // `.alerta` (singular, laranja) — isto é um aviso, não um "tudo em dia":
    // a rede de segurança de quem paga nunca rodou. Achado na varredura
    // visual de 21/09/2026: usava `.tudo-em-dia` (verde), a cor errada pro
    // que a frase diz.
    return `<div class="alerta u-mb-20 u-cursor-default"><b>A conciliação nunca rodou por aqui.</b>
      Ela é a rede de segurança de quem paga e cujo aviso do Checkout se perde. Rode <code>npm run conciliar</code> uma vez por dia.</div>`;
  }
  const horas = Math.floor((Date.now() - new Date(c.terminouEm).getTime()) / 3600000);
  const atrasada = horas >= 36;
  const problema = c.abortou || c.falhas > 0 || atrasada;
  const quando = horas < 1 ? 'há menos de uma hora' : horas < 48 ? `há ${horas}h` : `em ${data(c.terminouEm)}`;
  const detalhe = c.abortou
    ? `abortou: ${esc(c.abortou)}`
    : `${c.verificadas} assinatura(s) verificada(s) · ${c.aplicadas} ciclo(s) aplicado(s)` +
      `${c.expiradas ? ` · ${c.expiradas} plano(s) encerrado(s) por cobertura vencida` : ''}` +
      `${c.avisados ? ` · ${c.avisados} aviso(s) de fim de cobertura` : ''}` +
      `${c.falhas ? ` · ${c.falhas} falha(s)` : ''}`;
  // Achado na mesma varredura: a versão anterior usava a classe `alertas`
  // (plural, o CONTÊINER em grade de vários cards) num único `<div>` — sem
  // `.alerta` (singular), o caso com problema saía sem borda colorida
  // nenhuma, e era justo o caso que mais precisava chamar atenção.
  return `<div class="${problema ? 'alerta urgente' : 'tudo-em-dia'} u-mb-20 u-cursor-default">
    <b>Conciliação ${quando}${atrasada ? ' (atrasada)' : ''}.</b> ${detalhe}
  </div>`;
}

// "Tudo em dia" no primeiro dia de uso diz exatamente o contrario do que o
// dono precisa ouvir: nao ha fila porque nao ha nada — nem ponto, nem conta.
function redeVazia(rede) {
  // `anunciantesPorSituacao` é o nome que `/admin/resumo` devolve desde
  // 16/09/2026 — lia `anunciantesPorStatus`, que não existe, então "contas"
  // dava sempre 0 e a mensagem de rede vazia aparecia mesmo com contas.
  const contas = (rede.anunciantesPorSituacao || []).reduce((soma, r) => soma + Number(r.qtd || 0), 0);
  return !rede.pontosAtivos && !rede.telasAtivas && contas === 0;
}

// Bloco Financeiro da Visão geral (rodada Financeiro, 22/09/2026): só os
// dois números de receita. As filas de dinheiro (repasses, comissões,
// trocas, devoluções) moram no resumo operacional fixo desde a rodada de
// integridade (23/09/2026) — mostrar as duas coisas repetia a mesma fila em
// dois lugares da mesma tela. Cards por ciclo continuam em
// `financeiro.receitaPorCiclo` pra quem quiser consumir.
function painelFinanceiroResumo(financeiro) {
  return `
    <div class="panel financeiro-panel u-mb-16">
      <div class="panel-head"><h3>Financeiro</h3></div>
      <div class="kpi-grid">
        <div class="kpi-card"><span class="kpi-label">Receita recorrente</span><b>${fmt(financeiro.receitaMensal)}</b><span class="kpi-caption">planos ativos, por mês</span></div>
        <div class="kpi-card"><span class="kpi-label">Confirmado no mês</span><b>${fmt(financeiro.receitaConfirmadaMes)}</b><a class="link-secundario" href="#financeiro/cobrancas">Ver histórico →</a></div>
      </div>
    </div>`;
}

function botaoAlerta(a, qtd) {
  const classe = `alerta ${a.urgente ? 'urgente' : ''}`;
  const conteudo = `<b>${qtd}</b><span>${a.texto}</span>`;
  if (a.semLink) return `<div class="${classe} alerta-sem-link" title="${esc(a.semLink)}">${conteudo}</div>`;
  if (a.rolar) return `<button type="button" class="${classe}" data-rolar="${a.rolar}">${conteudo}</button>`;
  return `<button type="button" class="${classe}" data-ir="${a.aba}">${conteudo}</button>`;
}

async function renderResumo(el) {
  const { filas, financeiro, rede } = RESUMO;
  const pendentes = ALERTAS.filter((a) => (filas[a.fila] || 0) > 0);

  // Sem exceção nenhuma, a faixa de alertas não ocupa espaço — o resumo
  // operacional logo abaixo já mostra cada fila, zero incluído. A única
  // mensagem que sobra é a de rede recém-criada, que diz o que fazer.
  el.innerHTML = `
    ${
      pendentes.length
        ? `<div class="alertas">${pendentes.map((a) => botaoAlerta(a, filas[a.fila])).join('')}</div>`
        : redeVazia(rede)
          ? `<div class="tudo-em-dia"><b>Rede em montagem.</b> Nenhum ponto no ar ainda.
             Os primeiros passos: aprovar a primeira candidatura em
             <a href="#rede/candidaturas">Rede › Candidaturas</a>, instalar a tela (a chave fica na ficha do ponto,
             em <a href="#rede/pontos">Rede › Pontos</a>) e pôr a mídia da própria Mostraí no ar em
             <a href="#midiamostrai">Mídia Mostraí</a>. Tela vazia é tela sem prova social.</div>`
          : ''
    }

    ${painelPendenciasOperacionais(RESUMO)}

    <div id="promocaoAtivaResumo"></div>

    ${painelFinanceiroResumo(financeiro)}

    <div class="kpi-grid u-mb-20">
      <div class="kpi-card"><span class="kpi-label">Alcance da rede</span><b>${num(rede.fluxoMensal)}</b><span class="kpi-caption">pessoas/mês estimadas</span></div>
      <div class="kpi-card"><span class="kpi-label">Anunciantes novos</span><b>${rede.novosAnunciantes30d}</b><span class="kpi-caption">nos últimos 30 dias</span></div>
      <div class="kpi-card"><span class="kpi-label">Cadastra e paga</span><b>${financeiro.percentualPagantes === null ? '-' : `${financeiro.percentualPagantes.toFixed(0)}%`}</b><span class="kpi-caption">${financeiro.percentualPagantes === null ? 'nenhuma conta ainda' : `${financeiro.contasPagantes} de ${financeiro.totalContas} contas · cortesia e suspensa não contam`}</span></div>
    </div>

    ${linhaConciliacao(RESUMO.conciliacao)}

    <div class="panel">
      <div class="panel-head"><h3>Pontos por status</h3></div>
      ${barrasHorizontais(rede.pontosPorStatus, PONTO_STATUS, 'pontos')}
    </div>

    <div class="panel u-mt-16">
      <div class="panel-head"><h3>Ocupação da rede</h3></div>
      <div id="ocupacaoRede">Carregando...</div>
    </div>`;

  el.querySelectorAll('[data-ir]').forEach((btn) => btn.addEventListener('click', () => irPara(btn.dataset.ir)));
  el.querySelectorAll('[data-rolar]').forEach((btn) =>
    btn.addEventListener('click', () =>
      document.getElementById(btn.dataset.rolar)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    ),
  );
  el.querySelectorAll('[data-status-clique]').forEach((btn) =>
    btn.addEventListener('click', () => {
      FILTRO_PONTOS_STATUS = btn.dataset.statusClique;
      irPara('pontos');
    }),
  );

  renderOcupacaoRede(document.getElementById('ocupacaoRede'));
  renderPromocaoAtivaResumo(document.getElementById('promocaoAtivaResumo'));
}

// Bloco de promoção ativa na Visão geral (reconstrução de Ofertas/
// Promoções, 23/09/2026): toda promoção vigente aparece automaticamente,
// sem checkbox de opt-in — sem nenhuma vigente, o bloco não existe (nunca
// mostra vazio). Endpoint próprio de admin (`/admin/ofertas/promocoes-
// vigentes`), sem o filtro de elegibilidade comercial da rota pública — a
// sessão do admin não é sessão de anunciante, então a rota pública sempre
// trataria o pedido como "visitante novo". Mais de uma: resumo compacto,
// uma linha por promoção — não vira catálogo aqui, quem quer editar clica
// "Abrir" e vai pra Ofertas.
async function renderPromocaoAtivaResumo(el) {
  const vigentes = await pegar('/admin/ofertas/promocoes-vigentes');
  if (!vigentes.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<div class="panel promocao-ativa-panel u-mb-16">
    <div class="panel-head"><h3>Promoção${vigentes.length > 1 ? 'ões' : ''} ativa${vigentes.length > 1 ? 's' : ''}</h3></div>
    ${vigentes
      .map((p) => {
        const ciclos = [...new Set((p.itens || []).map((i) => CICLOS[i.compromissoMeses] || i.compromissoMeses))];
        return `<div class="promocao-ativa-linha">
          <div>
            <b>${esc(p.titulo_publico)}</b>${p.selo ? ` <span class="badge badge-info">${esc(p.selo)}</span>` : ''}
            <p class="u-dim u-fs-85 u-m-0">
              ${p.compra_fim ? `Até ${data(p.compra_fim)}` : 'Sem prazo pra comprar'} ·
              ${esc(ciclos.join(' · ')) || 'nenhum ciclo'} ·
              Condição por ${p.duracao_beneficio_meses} meses ·
              ${p.adesoes} ades${p.adesoes === 1 ? 'ão' : 'ões'}${p.limite_adesoes != null ? ` de ${p.limite_adesoes}` : ''}
            </p>
          </div>
          <button class="btn ghost mini" data-abrir-promocao="${p.id}">Abrir promoção</button>
        </div>`;
      })
      .join('')}
  </div>`;
  el.querySelectorAll('[data-abrir-promocao]').forEach((btn) =>
    btn.addEventListener('click', () => irPara('ofertas/promocoes')),
  );
}

// Ocupação agregada da rede (saiu da aba própria de cada ponto, redesenho
// de 22/09/2026 — pedido do dono: "não quero transformar a Visão geral numa
// enorme tabela", uma linha por ponto, barra + percentual). Mesmo endpoint
// e mesmo cálculo de sempre (G.7, `ocupacaoPorAnunciante`,
// src/pontos/repository.js) — não duplica a soma, só agrupa por ponto (a
// query devolve uma linha por par ponto×anunciante, e `segundos_vendidos`
// já vem repetido — igual — em toda linha do mesmo ponto). Async e
// separado do resto da Visão geral pra não segurar o resumo inteiro
// esperando esta consulta a mais.
// Ocupação da rede — tabela operacional (rodada final da Rede, 22/09/2026):
// virou tabela de verdade (era barra simples), mas a REGRA não mudou nada —
// mesmo `GET /admin/pontos-ocupacao` (G.7, `ocupacaoPorAnunciante` em
// src/pontos/repository.js), mesmo limite de 80% (LIMITE_OCUPACAO_BLOQUEIA).
// Os 20% de reserva são sempre exibidos como reserva — nunca somados em
// "disponível comercial" (pedido explícito: não confundir os dois).
// Desde a rodada de integridade (23/09/2026) os percentuais vêm de
// `GET /admin/capacidade-rede?escopo=rede` — a MESMA régua 80/20 da tela
// Mídia Mostraí (src/lib/capacidade.js). Antes a reserva aparecia fixa em
// "20%" aqui (ignorando o que a Mostraí já usava) e como "Livre 96,7%" lá.
async function renderOcupacaoRede(el) {
  const [linhasOcupacao, pontos, capacidade] = await Promise.all([
    pegar('/admin/pontos-ocupacao'),
    pegar('/admin/pontos'),
    pegar('/admin/capacidade-rede?escopo=rede'),
  ]);
  const pontosPorId = new Map(pontos.map((p) => [p.id, p]));
  const capacidadePorPonto = new Map(capacidade.map((c) => [c.pontoId, c]));
  const porPonto = new Map();
  linhasOcupacao.forEach((l) => {
    if (!porPonto.has(l.ponto_id)) {
      porPonto.set(l.ponto_id, {
        pontoId: l.ponto_id,
        nome: l.ponto_nome,
        segundosVendidos: l.segundos_vendidos,
        bloqueado: !!l.escolha_bloqueada_em,
        anunciantes: [],
      });
    }
    porPonto.get(l.ponto_id).anunciantes.push({ nome: l.nome_empresa, segundosPorHora: l.segundos_por_hora });
  });
  const linhas = [...porPonto.values()].sort((a, b) => b.segundosVendidos - a.segundosVendidos);

  if (!linhas.length) {
    el.innerHTML = '<p class="empty-state">Nenhum ponto possui ocupação comercial ainda.</p>';
    return;
  }

  const corpo = `<table><thead><tr>
      <th data-ord>Ponto</th><th data-ord>Status</th><th data-ord>Telas</th><th data-ord>Anunciantes</th>
      <th data-ord>Ocupação comercial</th><th data-ord>Comercial restante (80%)</th><th>Reserva Mostraí (20%)</th><th></th>
    </tr></thead><tbody>
    ${linhas
      .map((l) => {
        const ponto = pontosPorId.get(l.pontoId);
        const cap = capacidadePorPonto.get(l.pontoId);
        return `<tr data-filtro="${l.bloqueado ? 'bloqueado' : ''}" data-ponto-id="${l.pontoId}">
      <td>${esc(l.nome)}</td>
      <td>${ponto ? `<span class="badge ${PONTO_STATUS_CLASSE[ponto.status]}">${PONTO_STATUS[ponto.status] || ponto.status}</span>` : '-'}</td>
      <td>${ponto?.telas ?? '-'}</td>
      <td><button class="btn ghost mini" data-expandir-ocupacao="${l.pontoId}">${l.anunciantes.length}</button></td>
      <td title="${Math.round(l.segundosVendidos)}s de 3600s/hora">${cap ? `${cap.comercialPct}%` : '-'}${l.bloqueado ? ' <span class="badge badge-err">travado</span>' : ''}</td>
      <td title="Do teto comercial de 80%, já descontado o que a Mostraí usa acima da reserva">${cap ? `${cap.comercialRestantePct}%` : '-'}</td>
      <td title="Mídia própria e universal — nunca entra como disponível comercial">${cap ? `${cap.mostraiPct}% usado · ${cap.reservaRestantePct}% livre` : '-'}</td>
      <td>${l.bloqueado ? `<button class="btn ghost mini" data-liberar="${l.pontoId}">Liberar</button>` : ''}</td>
    </tr>`;
      })
      .join('')}
  </tbody></table>`;

  el.innerHTML = caixaTabela({
    chips: [
      { valor: '', nome: 'Todos' },
      { valor: 'bloqueado', nome: 'Travados (80%)' },
    ],
    html: corpo,
    dica: 'Clique no número de anunciantes pra ver o peso (s/hora) de cada um nesse ponto.',
  });
  turbinarTabela(el.querySelector('.tabela-caixa'));

  el.querySelectorAll('[data-expandir-ocupacao]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const linha = btn.closest('tr');
      const existente = linha.nextElementSibling;
      if (existente && existente.dataset.ocupacaoDe === btn.dataset.expandirOcupacao) {
        existente.remove();
        return;
      }
      const p = porPonto.get(Number(btn.dataset.expandirOcupacao));
      const ordenados = [...p.anunciantes].sort((a, b) => b.segundosPorHora - a.segundosPorHora);
      linha.insertAdjacentHTML(
        'afterend',
        `<tr data-ocupacao-de="${btn.dataset.expandirOcupacao}"><td class="u-bg" colspan="8">
      ${
        ordenados.length
          ? `<table class="mini-table u-mt-6"><thead><tr><th>Anunciante</th><th>Peso (s/hora)</th><th>% do ponto</th></tr></thead><tbody>
        ${ordenados
          .map(
            (a) =>
              `<tr><td>${esc(a.nome)}</td><td>${a.segundosPorHora}s</td><td>${Math.round((a.segundosPorHora / 3600) * 100)}%</td></tr>`,
          )
          .join('')}</tbody></table>`
          : '<p class="empty-state u-py-6">Nenhum anunciante associado.</p>'
      }
    </td></tr>`,
      );
    }),
  );

  el.querySelectorAll('[data-liberar]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Liberar este ponto pra escolha nova?')) return;
      const r = await api(`/admin/pontos/${btn.dataset.liberar}/liberar-escolha`, { method: 'POST' });
      if (!r.ok) {
        const corpoErro = await r.json().catch(() => ({}));
        return toast(corpoErro.erro || 'Não foi possível liberar — ainda não sobra folga suficiente.', 'err');
      }
      toast('Ponto liberado pra escolha nova.');
      renderOcupacaoRede(el);
    }),
  );
}

// ---------- pendências ----------
// Mesmas filas da Visão geral (ALERTAS, RESUMO.filas já carregados por
// irPara) — nenhum dado novo, só uma lista dedicada sem os KPIs e o gráfico
// que "Hoje" também mostra, pra quando a pergunta é só "o que eu resolvo".
async function _renderPendencias(el) {
  const { filas } = RESUMO;
  const pendentes = ALERTAS.filter((a) => (filas[a.fila] || 0) > 0);
  el.innerHTML = pendentes.length
    ? `<div class="alertas">${pendentes
        .map(
          (a) => `<button type="button" class="alerta ${a.urgente ? 'urgente' : ''}" data-ir="${a.aba}">
        <b>${filas[a.fila]}</b><span>${a.texto}</span>
      </button>`,
        )
        .join('')}</div>`
    : '<p class="tudo-em-dia"><b>Nada pendente agora.</b> Assim que alguma fila tiver algo esperando você, aparece aqui.</p>';
  el.querySelectorAll('[data-ir]').forEach((btn) => btn.addEventListener('click', () => irPara(btn.dataset.ir)));
}

// ---------- fila de criativos ----------
// Formato REAL do arquivo (rodada Mídia Mostraí, 23/09/2026): o arquivo
// NORMALIZADO é sempre um .mp4 — até imagem vira um vídeo em loop de 1
// frame, pra tocar igual na TV (src/lib/ffmpeg.js#normalizar) — então
// decidir <img> vs <video> pela extensão dele classificava toda imagem
// como vídeo (aparecia com controles de player). `arquivo_original_url`
// guarda o nome do arquivo que o cliente mandou, com a extensão real —
// é ele que diz o formato de verdade.
const EXT_IMAGEM = /\.(png|jpe?g|webp|gif|svg)(\?|$)/i;
const ehImagemArquivo = (nomeOuUrl) => EXT_IMAGEM.test(nomeOuUrl || '');

// Preview de um criativo — card de Mídia Mostraí, fila de Aprovação e
// "Ajustar mídia" decidem o mesmo jeito, uma função só (corrigir na raiz).
// Imagem mostra a miniatura estática (thumbnail_url, um frame do vídeo
// normalizado) em vez do próprio .mp4 em loop.
function montarPreviewAsset({ original, normalizado, thumb, classe = 'midia' }) {
  if (ehImagemArquivo(original)) {
    const src = thumb || normalizado;
    return src ? `<img class="${classe}" src="${esc(src)}" alt="">` : `<div class="${classe}"></div>`;
  }
  if (normalizado) {
    return `<video class="${classe}" src="${esc(normalizado)}" muted loop playsinline controls poster="${esc(thumb || '')}"></video>`;
  }
  return `<div class="${classe}"></div>`;
}

// Aprovação de criativos (reorganização de Conteúdo, 22/09/2026): caixa de
// PENDÊNCIAS, não histórico (Parte 24) — só mostra "pendente", sem abas de
// Aprovados/Reprovados. Resolvido some da tela sozinho.
async function renderCriativos(el) {
  const [criativos, anunciantes, midias] = await Promise.all([
    pegar('/admin/criativos?status=pendente'),
    pegar('/admin/anunciantes'),
    pegar('/admin/midias-proprias'),
  ]);
  // O endpoint de criativos só devolve anunciante_id — sem o nome, o admin
  // aprovava um número. Junta aqui em vez de mexer na query do servidor.
  const nomePor = Object.fromEntries(anunciantes.map((a) => [a.id, a.nome_empresa]));
  // Nome interno (Parte 21: "nome do criativo, se houver") só existe pra
  // mídia própria — criativo de anunciante pagante não tem esse campo.
  const nomeMidiaPor = Object.fromEntries(midias.map((m) => [m.criativo_id, m.nome_interno]));

  el.innerHTML = `
    <div id="ajusteMidiaWrap" hidden></div>
    ${
      criativos.length
        ? `<div class="criativo-fila">${criativos
            .map((c) => {
              const ehVideo = !ehImagemArquivo(c.arquivo_original_url);
              return `<div class="item">
        ${montarPreviewAsset({ original: c.arquivo_original_url, normalizado: c.arquivo_normalizado_url, thumb: c.thumbnail_url })}
        <div class="dados">
          <b>${esc(nomeMidiaPor[c.id] || nomePor[c.anunciante_id] || `Anunciante #${c.anunciante_id}`)}</b>
          <small>${esc(nomePor[c.anunciante_id] || '')}${nomeMidiaPor[c.id] ? ` · #${c.id}` : ` #${c.id}`} · ${ehVideo ? 'vídeo' : 'imagem'}${c.duracao_segundos ? ` · ${c.duracao_segundos}s` : ''} · enviado ${data(c.created_at)}${c.substitui_criativo_id ? ` · substitui o #${c.substitui_criativo_id}, que sai do ar ao aprovar` : ''}</small>
        </div>
        <div class="acoes">
          <button class="btn ghost mini" data-ajustar="${c.id}">Ajustar mídia</button>
          <button class="btn ghost mini" data-acao="reprovado" data-id="${c.id}">Reprovar</button>
          <button class="btn primary mini" data-acao="aprovado" data-id="${c.id}">Aprovar</button>
        </div>
      </div>`;
            })
            .join('')}</div>`
        : '<p class="empty-state">Nenhum criativo aguardando aprovação.</p>'
    }`;

  const aposDecidir = async () => {
    RESUMO = await pegar('/admin/resumo');
    pintarContadores();
    renderCriativos(el);
  };
  el.querySelectorAll('button[data-acao]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      // Reprovar sem motivo era um beco sem saída pro anunciante: o card dele
      // virava "Reprovado" e nenhuma tela dizia o que consertar. O motivo vai
      // junto do status, aparece no card dele e vai no e-mail. Pedido num
      // modal — o mesmo da ficha da conta — em vez de prompt() nativo
      // (reconstrução de Contas, 23/09/2026, Parte 17).
      if (btn.dataset.acao === 'reprovado') {
        return recusarCriativo(
          criativos.find((x) => x.id === Number(btn.dataset.id)),
          aposDecidir,
        );
      }
      if (await salvar(`/admin/criativos/${btn.dataset.id}`, { status: btn.dataset.acao })) aposDecidir();
    }),
  );
  el.querySelectorAll('[data-ajustar]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const c = criativos.find((x) => x.id === Number(btn.dataset.ajustar));
      abrirAjusteMidia(document.getElementById('ajusteMidiaWrap'), c, nomePor[c.anunciante_id], () =>
        renderCriativos(el),
      );
    }),
  );
}

// "Ajustar mídia" (Parte 25/26): baixar, substituir sem criar outro
// criativo (Parte 27 — o backend já garante isso, `/admin/criativos/:id/
// substituir` atualiza a mesma linha), ver o novo preview, aprovar. Volta
// pra "pendente" sozinho ao trocar o arquivo (Parte 29) — o botão Aprovar
// aqui é só conveniência pra não precisar voltar pra fila depois de trocar.
function abrirAjusteMidia(wrap, criativo, nomeConta, aoFechar) {
  const url = criativo.arquivo_normalizado_url || criativo.arquivo_original_url;
  const ehVideo = !ehImagemArquivo(criativo.arquivo_original_url);
  wrap.innerHTML = `
    <div class="card wide u-mb-16">
      <div class="field-row u-ai-c">
        <h3 class="u-m-0 u-mr-auto">Ajustar mídia #${criativo.id}</h3>
        <button class="btn ghost mini" type="button" id="btnFecharAjuste">Fechar</button>
      </div>
      <div class="field-row">
        <div class="u-col" id="previewAjuste">
          ${montarPreviewAsset({ original: criativo.arquivo_original_url, normalizado: criativo.arquivo_normalizado_url, thumb: criativo.thumbnail_url })}
        </div>
        <div class="u-col-2">
          <p class="u-m-0"><b>Conta</b><br>${esc(nomeConta || `Anunciante #${criativo.anunciante_id}`)}</p>
          <p class="u-mt-8"><b>Formato</b><br>${ehVideo ? 'Vídeo' : 'Imagem'}${criativo.duracao_segundos ? ` · ${criativo.duracao_segundos}s` : ''}</p>
          <p class="u-mt-8"><b>Enviado em</b><br>${data(criativo.created_at)}</p>
          <div class="field-row u-mt-12">
            ${url ? `<a class="btn ghost mini" href="${esc(url)}" download target="_blank" rel="noopener">Baixar arquivo</a>` : ''}
            <label class="btn ghost mini" for="arquivoSubstituto">Substituir arquivo<input type="file" id="arquivoSubstituto" accept="video/*,image/*" hidden></label>
            <button class="btn primary mini" type="button" id="btnAprovarAjuste">Aprovar</button>
          </div>
          <p class="form-msg" id="msgAjuste" role="status"></p>
        </div>
      </div>
    </div>`;
  wrap.hidden = false;
  wrap.scrollIntoView({ behavior: 'smooth' });

  document.getElementById('btnFecharAjuste').addEventListener('click', () => {
    wrap.hidden = true;
    wrap.innerHTML = '';
  });
  document.getElementById('btnAprovarAjuste').addEventListener('click', async () => {
    if (await salvar(`/admin/criativos/${criativo.id}`, { status: 'aprovado' })) {
      RESUMO = await pegar('/admin/resumo');
      pintarContadores();
      wrap.hidden = true;
      wrap.innerHTML = '';
      aoFechar();
    }
  });
  document.getElementById('arquivoSubstituto').addEventListener('change', async (e) => {
    const arquivo = e.target.files[0];
    if (!arquivo) return;
    const msg = document.getElementById('msgAjuste');
    msg.textContent = 'Enviando e normalizando... isso leva alguns segundos.';
    msg.className = 'form-msg';
    const dados = new FormData();
    dados.append('arquivo', arquivo);
    const r = await fetch(`${API_BASE_URL}/admin/criativos/${criativo.id}/substituir`, {
      method: 'POST',
      body: dados,
      credentials: 'include',
    });
    if (!r.ok) {
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'não deu pra substituir';
      msg.className = 'form-msg err';
      return;
    }
    const atualizado = await r.json();
    msg.textContent = 'Arquivo substituído — volta pra "em análise" até você aprovar de novo.';
    msg.className = 'form-msg ok';
    RESUMO = await pegar('/admin/resumo');
    pintarContadores();
    abrirAjusteMidia(wrap, atualizado, nomeConta, aoFechar);
  });
}

// ---------- mídia Mostraí ----------
// Conteúdo institucional da própria rede (reorganização de Conteúdo,
// 22/09/2026, Partes 5-18 do pedido): cada peça tem frequência, cobertura e
// período PRÓPRIOS — não existe mais "conta própria com vezes por hora" nem
// formulário de bootstrap (a conta institucional vira singleton por baixo,
// `ensureContaMostrai`, ver src/anunciantes/repository.js). Backend inteiro
// em src/midias/ — aqui só consome as rotas.
const SITUACAO_MIDIA_ROTULO = { ativa: 'Ativa', agendada: 'Agendada', pausada: 'Pausada', encerrada: 'Encerrada' };
const SITUACAO_MIDIA_BADGE = {
  ativa: 'badge-ok',
  agendada: 'badge-info',
  pausada: 'badge-pendente',
  encerrada: 'badge-err',
};

// Card da grade de Mídias próprias — classes `.mm-*` próprias (não
// `.criativo-fila`/`.item`/`.midia` da fila de Aprovação): aqui o preview
// precisa de `object-fit: contain` num fundo neutro (o asset é uma peça pra
// conferir por inteiro, não uma miniatura recortada), e misturar a mesma
// classe mudaria a Aprovação junto, fora do pedido desta rodada.
function montarCardMidia(m) {
  const sit = m.situacaoDerivada;
  const cobertura =
    m.cobertura_tipo === 'rede' ? 'Toda a rede' : `${m.qtd_pontos} ponto${m.qtd_pontos === 1 ? '' : 's'}`;
  const periodo =
    m.periodo_inicio || m.periodo_fim
      ? `${m.periodo_inicio ? data(m.periodo_inicio) : 'sempre'} até ${m.periodo_fim ? data(m.periodo_fim) : 'sem fim'}`
      : 'Sempre no ar';
  return `<div class="mm-card">
    <div class="mm-card-preview">${montarPreviewAsset({ original: m.arquivo_original_url, normalizado: m.arquivo_normalizado_url, thumb: m.thumbnail_url, classe: 'mm-card-asset' })}</div>
    <div class="mm-card-dados">
      <div class="field-row u-ai-c u-m-0">
        <b class="u-mr-auto">${esc(m.nome_interno)}</b>
        <span class="badge ${SITUACAO_MIDIA_BADGE[sit] || ''}">${SITUACAO_MIDIA_ROTULO[sit] || sit}</span>
      </div>
      ${m.aprovacao_status !== 'aprovado' ? '<span class="badge badge-pendente u-mt-4 u-d-block">Em análise</span>' : ''}
      <small class="u-d-block u-mt-4">${m.duracao_segundos ? `${m.duracao_segundos}s` : '-'} · ${m.frequencia_hora}x/hora · ${cobertura}</small>
      <small class="u-d-block">${periodo}</small>
    </div>
    <div class="mm-card-acoes">
      <button class="btn ghost mini" data-editar-midia="${m.id}">Editar</button>
      ${
        sit === 'pausada'
          ? `<button class="btn ghost mini" data-retomar-midia="${m.id}">Retomar</button>`
          : sit !== 'encerrada'
            ? `<button class="btn ghost mini" data-pausar-midia="${m.id}">Pausar</button>`
            : ''
      }
      ${sit !== 'encerrada' ? `<button class="btn ghost mini" data-encerrar-midia="${m.id}">Retirar do ar</button>` : ''}
    </div>
  </div>`;
}

// Tabela de capacidade da rede (Parte 16/17) — mesmo padrão de
// renderOcupacaoRede (expandir por clique mostra quem consome ali), só que
// separando comercial de institucional em vez de uma coluna só (Parte 9:
// "não quero só uma porcentagem abstrata").
function montarTabelaCapacidade(el, capacidade) {
  if (!capacidade.length) {
    el.innerHTML = '<p class="empty-state">Nenhum ponto em operação ainda.</p>';
    return;
  }
  // Régua 80/20 (rodada de integridade, 23/09/2026): sem coluna "Livre" —
  // ela somava a reserva Mostraí com o comercial ainda não vendido e dava a
  // entender que a mídia própria podia ocupar ~97% da hora. Mesmos números
  // da tabela "Ocupação da rede" da Visão geral (src/lib/capacidade.js).
  el.innerHTML = `<div class="tabela-caixa"><div class="rolagem"><table><thead><tr>
      <th>Ponto</th><th>Status</th><th title="Vendido a anunciantes">Comercial</th>
      <th title="Do teto comercial de 80%">Comercial restante</th>
      <th title="Mídia própria e universal, dentro da reserva de 20%">Mostraí</th>
      <th title="Da reserva de 20%">Reserva restante</th><th>Total</th><th>Mídias próprias</th>
    </tr></thead><tbody>
    ${capacidade
      .map(
        (p) => `<tr>
      <td>${esc(p.pontoNome)}</td>
      <td><span class="badge ${PONTO_STATUS_CLASSE[p.status] || ''}">${PONTO_STATUS[p.status] || p.status}</span></td>
      <td>${p.comercialPct}%</td>
      <td>${p.comercialRestantePct}% <span class="u-dim u-fs-78">de 80%</span></td>
      <td>${p.mostraiPct}%${p.mostraiAcimaDaReservaPct > 0 ? ` <span class="badge badge-pendente" title="${p.mostraiAcimaDaReservaPct}% ocupando capacidade comercial ainda não vendida">acima da reserva</span>` : ''}</td>
      <td>${p.reservaRestantePct}% <span class="u-dim u-fs-78">de 20%</span></td>
      <td>${p.totalPct}%</td>
      <td><button class="btn ghost mini" data-expandir-capacidade="${p.pontoId}">${p.qtdMidiasProprias}</button></td>
    </tr>`,
      )
      .join('')}
    </tbody></table></div></div>`;

  el.querySelectorAll('[data-expandir-capacidade]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const linha = btn.closest('tr');
      const existente = linha.nextElementSibling;
      if (existente && existente.dataset.capacidadeDe === btn.dataset.expandirCapacidade) {
        existente.remove();
        return;
      }
      const midiasNoPonto = await pegar(`/admin/capacidade-rede/${btn.dataset.expandirCapacidade}/midias`);
      linha.insertAdjacentHTML(
        'afterend',
        `<tr data-capacidade-de="${btn.dataset.expandirCapacidade}"><td class="u-bg" colspan="8">
      ${
        midiasNoPonto.length
          ? `<table class="mini-table u-mt-6"><thead><tr><th>Mídia</th><th>% do ponto</th></tr></thead><tbody>
        ${midiasNoPonto.map((m) => `<tr><td>${esc(m.nomeInterno)}</td><td>${m.pct}%</td></tr>`).join('')}
      </tbody></table>`
          : '<p class="empty-state u-py-6">Nenhuma mídia própria nesse ponto.</p>'
      }
    </td></tr>`,
      );
    }),
  );
}

// Card do seletor de pontos (rodada Mídia Mostraí, 23/09/2026) — mesma
// identidade visual de Rede > Pontos (`.ponto-card`/`.ponto-card-media`/
// `fotoOuPlaceholder`, de public/style.css, compartilhada com o site
// público), só que como rótulo de checkbox em vez de link: o card inteiro
// seleciona, o check no canto é só reforço visual (o input continua
// presente e focável por teclado).
function montarPontoPickerCard(p, marcado) {
  const segmento = p.categoriaNome || p.categoriaLivre || p.segmento;
  const busca = `${p.pontoNome} ${p.cidade || ''} ${p.uf || ''} ${segmento || ''} ${p.endereco || ''}`.toLowerCase();
  return `<label class="ponto-card mm-picker-card" data-busca="${esc(busca)}">
    <input type="checkbox" class="mm-picker-input" value="${p.pontoId}" ${marcado ? 'checked' : ''}>
    <div class="ponto-card-media">${fotoOuPlaceholder(p.fotoUrl, p.pontoNome)}</div>
    <span class="mm-picker-check" aria-hidden="true">✓</span>
    <span class="badge ${PONTO_STATUS_CLASSE[p.status] || ''}">${PONTO_STATUS[p.status] || p.status}</span>
    <h4>${esc(p.pontoNome)}</h4>
    <p>${esc(p.cidade || '')}${p.uf ? `/${esc(p.uf)}` : ''}${segmento ? ` · ${esc(segmento)}` : ''}</p>
    <div class="mm-picker-stats">
      <span>Comercial <b>${p.comercialPct}%</b></span>
      <span>Mostraí <b>${p.mostraiPct}%</b></span>
      <span>Reserva <b>${p.reservaRestantePct}%</b></span>
    </div>
  </label>`;
}

// Mesmo default de src/lib/ffmpeg.js#DURACAO_PADRAO_IMAGEM — só pra estimar
// o preview de capacidade ANTES do upload real (Parte 7: frequência entra no
// cálculo de verdade). O servidor sempre revalida com a duração normalizada
// de verdade ao salvar (Parte 10/12) — esta estimativa nunca é a palavra
// final, só evita mostrar "Ajuste..." até o arquivo terminar de subir.
const DURACAO_PADRAO_IMAGEM_JS = 10;

// Formulário de criação/edição de uma mídia própria (Parte 6: Conteúdo,
// Veiculação, Cobertura, Capacidade) — revisão visual de 23/09/2026: duas
// colunas no desktop (configuração / preview), preview real assim que o
// arquivo é escolhido, e "Alterar mídia" embutido na edição (reaproveita
// `/admin/criativos/:id/substituir`, o mesmo endpoint de "Ajustar mídia" na
// fila de Aprovação — mesmo criativo lógico, só troca o arquivo).
async function abrirEditorMidia(wrap, midia, aoFechar) {
  // Capacidade dá comercial/Mostraí/reserva por ponto; Pontos dá foto,
  // segmento e UF — o seletor de cobertura junta as duas pra virar card
  // (Parte 20/21), sem endpoint novo nenhum.
  const [pontosCapacidade, pontosCadastro] = await Promise.all([
    pegar('/admin/capacidade-rede'),
    pegar('/admin/pontos'),
  ]);
  const cadastroPorId = Object.fromEntries(pontosCadastro.map((p) => [p.id, p]));
  const pontosRede = pontosCapacidade.map((p) => {
    const cad = cadastroPorId[p.pontoId];
    return {
      ...p,
      fotoUrl: cad?.foto_instalacao_url || null,
      uf: cad?.uf || null,
      endereco: cad?.endereco || null,
      categoriaNome: cad?.categoria_nome || null,
      categoriaLivre: cad?.categoria_livre || null,
      segmento: cad?.segmento || null,
    };
  });
  const pontosSelecionados = new Set(midia?.pontosIds || []);
  const isoLocal = (v) => (v ? new Date(v).toISOString().slice(0, 16) : '');
  let duracaoEstimada = midia?.duracao_segundos || 0;
  const temPeriodo = !!(midia?.periodo_inicio || midia?.periodo_fim);

  // Painel de preview — o MESMO container/classe serve a criação (assim que
  // o arquivo é escolhido) e a edição (arquivo já salvo): container de
  // tamanho fixo com `object-fit: contain`, então nem um vídeo vertical nem
  // uma imagem panorâmica nunca estouram o painel (Parte 12).
  const previewInicial = midia
    ? montarPreviewAsset({
        original: midia.arquivo_original_url,
        normalizado: midia.arquivo_normalizado_url,
        thumb: midia.thumbnail_url,
        classe: 'mm-card-asset',
      })
    : '<p class="u-dim u-fs-78 u-m-0">Escolha um arquivo pra ver o preview.</p>';
  const infoInicial = midia
    ? `${ehImagemArquivo(midia.arquivo_original_url) ? 'Imagem' : 'Vídeo'}${midia.duracao_segundos ? ` · ${midia.duracao_segundos}s` : ''}${midia.aprovacao_status !== 'aprovado' ? ' · em análise' : ''}`
    : '';

  wrap.innerHTML = `
    <div class="card mm-editor-card">
      <div class="field-row u-ai-c">
        <h3 class="u-m-0 u-mr-auto">${midia ? `Editar — ${esc(midia.nome_interno)}` : 'Nova mídia própria'}</h3>
        <button class="btn ghost mini" type="button" id="btnFecharEditorMidia">Fechar</button>
      </div>
      <form id="formMidia">
        <div class="mm-editor-grid">
          <div class="mm-editor-col">
            <p class="form-sep-titulo u-mt-0">Conteúdo</p>
            <div class="u-col"><label>Nome interno</label><input name="nome_interno" required value="${esc(midia?.nome_interno || '')}"></div>
            ${
              !midia
                ? `<div class="u-mt-10">
                     <label class="btn ghost mini" for="mmArquivo">Escolher arquivo<input type="file" id="mmArquivo" accept="video/*,image/*" hidden required></label>
                   </div>`
                : ''
            }

            <p class="form-sep-titulo">Veiculação</p>
            <div class="field-row">
              <div class="u-col"><label>Vezes por hora</label><input class="mini" type="number" min="1" max="60" name="frequencia_hora" required value="${midia?.frequencia_hora || 1}"></div>
            </div>
            <label class="check-row u-mt-8"><input type="checkbox" id="mmAgendada" ${temPeriodo ? 'checked' : ''}> Tem período definido (fora dele, não entra no ar)</label>
            <div class="field-row u-mt-8" id="mmPeriodoCampos" ${temPeriodo ? '' : 'hidden'}>
              <div class="u-col"><label>Começa em</label><input class="mini" type="datetime-local" name="periodo_inicio" value="${isoLocal(midia?.periodo_inicio)}"></div>
              <div class="u-col"><label>Termina em</label><input class="mini" type="datetime-local" name="periodo_fim" value="${isoLocal(midia?.periodo_fim)}"></div>
            </div>
            ${!midia ? '<label class="check-row u-mt-8"><input type="checkbox" name="situacao_pausada"> Começar pausada</label>' : ''}

            <p class="form-sep-titulo">Cobertura</p>
            <div class="field-row">
              <label class="check-row"><input type="radio" name="cobertura_tipo" value="rede" ${(midia?.cobertura_tipo || 'rede') === 'rede' ? 'checked' : ''}> Toda a rede</label>
              <label class="check-row"><input type="radio" name="cobertura_tipo" value="pontos" ${midia?.cobertura_tipo === 'pontos' ? 'checked' : ''}> Pontos específicos</label>
            </div>
            <p class="form-hint u-m-0">"Toda a rede" inclui pontos novos automaticamente, sem limite de quantidade.</p>
            <div id="mmPontosWrap" ${midia?.cobertura_tipo === 'pontos' ? '' : 'hidden'}>
              <input class="busca u-mt-8 u-mb-8" type="search" id="mmBuscaPontos" placeholder="Buscar por nome, cidade ou segmento...">
              <div class="mm-picker-grid">
                ${pontosRede.map((p) => montarPontoPickerCard(p, pontosSelecionados.has(p.pontoId))).join('') || '<p class="empty-state u-py-8">Nenhum ponto em operação ainda.</p>'}
              </div>
            </div>

            <p class="form-sep-titulo">Capacidade projetada</p>
            <div id="mmCapacidadePreview"><p class="u-dim u-fs-78 u-m-0">${midia ? 'Ajuste frequência e cobertura pra ver o impacto em cada ponto.' : 'Escolha o arquivo pra ver o impacto em cada ponto.'}</p></div>
          </div>
          <div class="mm-editor-col mm-editor-col-preview">
            <p class="form-sep-titulo u-mt-0">Preview</p>
            <div class="mm-editor-preview-box" id="mmPreviewBox">${previewInicial}</div>
            <p class="u-dim u-fs-78 u-mt-6 u-m-0" id="mmPreviewInfo">${infoInicial}</p>
            ${
              midia
                ? `<label class="btn ghost mini u-mt-10" for="mmAlterarArquivo">Alterar mídia<input type="file" id="mmAlterarArquivo" accept="video/*,image/*" hidden></label>`
                : ''
            }
          </div>
        </div>

        <div class="field-row u-mt-14">
          <button class="btn primary" type="submit">${midia ? 'Salvar' : 'Criar mídia'}</button>
          <button class="btn ghost" type="button" id="btnCancelarMidia">Cancelar</button>
        </div>
        <p class="form-msg" id="mmMsg"></p>
      </form>
    </div>`;
  wrap.hidden = false;
  wrap.scrollIntoView({ behavior: 'smooth' });

  const form = document.getElementById('formMidia');
  const fechar = () => {
    wrap.hidden = true;
    wrap.innerHTML = '';
  };
  document.getElementById('btnFecharEditorMidia').addEventListener('click', fechar);
  document.getElementById('btnCancelarMidia').addEventListener('click', fechar);

  document.getElementById('mmAgendada').addEventListener('change', (e) => {
    document.getElementById('mmPeriodoCampos').hidden = !e.target.checked;
    if (!e.target.checked) {
      form.periodo_inicio.value = '';
      form.periodo_fim.value = '';
    }
  });

  form.querySelectorAll('input[name="cobertura_tipo"]').forEach((r) =>
    r.addEventListener('change', () => {
      document.getElementById('mmPontosWrap').hidden = form.cobertura_tipo.value !== 'pontos';
      atualizarPreview();
    }),
  );

  const buscaPontos = document.getElementById('mmBuscaPontos');
  if (buscaPontos) {
    buscaPontos.addEventListener('input', () => {
      const termo = buscaPontos.value.trim().toLowerCase();
      document.querySelectorAll('.mm-picker-card').forEach((card) => {
        card.hidden = termo.length > 0 && !card.dataset.busca.includes(termo);
      });
    });
  }
  document.querySelectorAll('.mm-picker-card input').forEach((chk) => chk.addEventListener('change', atualizarPreview));
  form.frequencia_hora.addEventListener('input', atualizarPreview);

  // Preview real assim que o arquivo é escolhido (Parte 13) — imagem vira
  // <img>, vídeo vira <video> com controles; a duração real (pro cálculo de
  // capacidade) só é confirmada de verdade pelo servidor ao normalizar —
  // isto aqui é só a melhor estimativa ANTES do upload.
  function previewLocal(arquivo) {
    const box = document.getElementById('mmPreviewBox');
    const info = document.getElementById('mmPreviewInfo');
    if (arquivo.type.startsWith('image/') || ehImagemArquivo(arquivo.name)) {
      // FileReader (data:), não URL.createObjectURL — a CSP do site só
      // libera `img-src 'self' data:` (src/server.js), sem `blob:` (mesmo
      // achado já registrado em public/candidatura-ponto.js#candidaturaCampoFoto:
      // com blob: a imagem some, bloqueada em silêncio pelo navegador).
      const leitor = new FileReader();
      leitor.onload = () => {
        box.innerHTML = `<img class="mm-card-asset" src="${esc(leitor.result)}" alt="">`;
        const sonda = new Image();
        sonda.onload = () => {
          info.textContent = `${arquivo.name} · imagem${sonda.naturalWidth ? ` · ${sonda.naturalWidth}×${sonda.naturalHeight}px` : ''}`;
        };
        sonda.src = leitor.result;
      };
      leitor.readAsDataURL(arquivo);
      return;
    }
    // Vídeo: blob: já é liberado em `media-src` (o player offline também usa).
    const url = URL.createObjectURL(arquivo);
    box.innerHTML = `<video class="mm-card-asset" src="${esc(url)}" muted loop playsinline controls></video>`;
    const videoEl = box.querySelector('video');
    videoEl.onloadedmetadata = () => {
      info.textContent = `${arquivo.name} · vídeo${videoEl.duration ? ` · ${Math.round(videoEl.duration)}s` : ''}`;
    };
  }

  const arquivoInput = document.getElementById('mmArquivo');
  if (arquivoInput) {
    arquivoInput.addEventListener('change', () => {
      const arquivo = arquivoInput.files[0];
      if (!arquivo) return;
      previewLocal(arquivo);
      if (arquivo.type.startsWith('image/')) {
        duracaoEstimada = DURACAO_PADRAO_IMAGEM_JS;
        atualizarPreview();
        return;
      }
      const videoTeste = document.createElement('video');
      videoTeste.preload = 'metadata';
      videoTeste.onloadedmetadata = () => {
        duracaoEstimada = Math.round(videoTeste.duration) || 0;
        URL.revokeObjectURL(videoTeste.src);
        atualizarPreview();
      };
      videoTeste.src = URL.createObjectURL(arquivo);
    });
  }

  // "Alterar mídia" (Parte 16, edição) — mesmo endpoint de "Ajustar mídia"
  // na fila de Aprovação (`/admin/criativos/:id/substituir`): troca o
  // arquivo do MESMO criativo lógico, nunca cria outra mídia. Volta pra "em
  // análise" sempre (o backend já garante isso), então some o texto de
  // "aprovado" do card até o operador aprovar de novo.
  const alterarInput = document.getElementById('mmAlterarArquivo');
  if (alterarInput) {
    alterarInput.addEventListener('change', async () => {
      const arquivo = alterarInput.files[0];
      if (!arquivo) return;
      const msg = document.getElementById('mmMsg');
      previewLocal(arquivo);
      msg.textContent = 'Enviando e normalizando... isso leva alguns segundos.';
      msg.className = 'form-msg';
      const dados = new FormData();
      dados.append('arquivo', arquivo);
      const r = await fetch(`${API_BASE_URL}/admin/criativos/${midia.criativo_id}/substituir`, {
        method: 'POST',
        body: dados,
        credentials: 'include',
      });
      if (!r.ok) {
        msg.textContent = (await r.json().catch(() => ({}))).erro || 'não deu pra substituir';
        msg.className = 'form-msg err';
        return;
      }
      const atualizado = await r.json();
      midia.arquivo_original_url = atualizado.arquivo_original_url;
      midia.arquivo_normalizado_url = atualizado.arquivo_normalizado_url;
      midia.thumbnail_url = atualizado.thumbnail_url;
      midia.duracao_segundos = atualizado.duracao_segundos;
      midia.aprovacao_status = atualizado.status;
      duracaoEstimada = atualizado.duracao_segundos || duracaoEstimada;
      document.getElementById('mmPreviewBox').innerHTML = montarPreviewAsset({
        original: midia.arquivo_original_url,
        normalizado: midia.arquivo_normalizado_url,
        thumb: midia.thumbnail_url,
        classe: 'mm-card-asset',
      });
      document.getElementById('mmPreviewInfo').textContent =
        `${ehImagemArquivo(midia.arquivo_original_url) ? 'Imagem' : 'Vídeo'}${midia.duracao_segundos ? ` · ${midia.duracao_segundos}s` : ''} · em análise`;
      msg.textContent = 'Arquivo substituído — volta pra "em análise" até aprovar de novo, na fila de Aprovação.';
      msg.className = 'form-msg ok';
      atualizarPreview();
    });
  }

  async function atualizarPreview() {
    const alvo = document.getElementById('mmCapacidadePreview');
    if (!duracaoEstimada) {
      alvo.innerHTML = `<p class="u-dim u-fs-78 u-m-0">${midia ? 'Ajuste frequência e cobertura pra ver o impacto em cada ponto.' : 'Escolha o arquivo pra ver o impacto em cada ponto.'}</p>`;
      return;
    }
    const coberturaTipo = form.cobertura_tipo.value;
    const idsMarcados =
      coberturaTipo === 'pontos'
        ? [...document.querySelectorAll('.mm-picker-card input:checked')].map((i) => i.value)
        : [];
    if (coberturaTipo === 'pontos' && !idsMarcados.length) {
      alvo.innerHTML = '<p class="u-dim u-fs-78 u-m-0">Escolha pelo menos um ponto pra ver o impacto.</p>';
      return;
    }
    const params = new URLSearchParams({
      cobertura_tipo: coberturaTipo,
      frequencia_hora: form.frequencia_hora.value || '0',
      duracao_segundos: String(duracaoEstimada),
    });
    if (idsMarcados.length) params.set('pontos_ids', idsMarcados.join(','));
    if (midia) params.set('excluir_midia_id', midia.id);
    const linhas = await pegar(`/admin/midias-proprias-preview-ocupacao?${params}`);
    if (!linhas.length) {
      alvo.innerHTML = '<p class="u-dim u-fs-78 u-m-0">Nenhum ponto em operação nessa cobertura.</p>';
      return;
    }
    const excedentes = linhas.filter((l) => !l.comporta);
    // Passar da reserva de 20% não bloqueia (a trava é o total > 100%), mas
    // tem que ficar claro que o excedente come capacidade comercial ainda
    // não vendida — rodada de integridade, 23/09/2026.
    const acimaDaReserva = linhas.filter((l) => l.comporta && l.acimaDaReserva);
    alvo.innerHTML = `
      ${excedentes.length ? `<p class="form-msg err u-m-0 u-mb-8">Excede 100% em ${excedentes.length} ponto(s) — reduza a frequência ou a cobertura antes de salvar.</p>` : ''}
      ${acimaDaReserva.length ? `<p class="form-msg u-m-0 u-mb-8">Passa da reserva Mostraí de 20% em ${acimaDaReserva.length} ponto(s): o excedente ocupa capacidade comercial ainda não vendida.</p>` : ''}
      <table class="mini-table"><thead><tr><th>Ponto</th><th>Mostraí agora</th><th>Mostraí depois <span class="u-dim">(reserva 20%)</span></th><th>Total depois</th></tr></thead><tbody>
      ${linhas
        .map(
          (l) => `<tr class="${l.comporta ? '' : 'mm-linha-excede'}">
        <td>${esc(l.pontoNome)}</td><td>${l.mostraiPct}%</td>
        <td>${l.mostraiDepoisPct}%${l.acimaDaReserva ? ' — acima da reserva' : ''}</td>
        <td>${l.depoisPct}%${l.comporta ? '' : ' — excede'}</td>
      </tr>`,
        )
        .join('')}
      </tbody></table>`;
  }
  atualizarPreview();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('mmMsg');
    const idsMarcados =
      form.cobertura_tipo.value === 'pontos'
        ? [...document.querySelectorAll('.mm-picker-card input:checked')].map((i) => i.value)
        : [];
    if (form.cobertura_tipo.value === 'pontos' && !idsMarcados.length) {
      msg.textContent = 'Escolha pelo menos um ponto, ou marque "toda a rede".';
      msg.className = 'form-msg err';
      return;
    }

    if (!midia) {
      const arquivo = arquivoInput.files[0];
      if (!arquivo) {
        msg.textContent = 'Escolha um arquivo.';
        msg.className = 'form-msg err';
        return;
      }
      msg.textContent = 'Enviando e normalizando... isso leva alguns segundos.';
      msg.className = 'form-msg';
      const dados = new FormData();
      dados.append('arquivo', arquivo);
      dados.append('nome_interno', form.nome_interno.value);
      dados.append('frequencia_hora', form.frequencia_hora.value);
      dados.append('cobertura_tipo', form.cobertura_tipo.value);
      if (idsMarcados.length) dados.append('pontos_ids', idsMarcados.join(','));
      if (document.getElementById('mmAgendada').checked) {
        if (form.periodo_inicio.value)
          dados.append('periodo_inicio', new Date(form.periodo_inicio.value).toISOString());
        if (form.periodo_fim.value) dados.append('periodo_fim', new Date(form.periodo_fim.value).toISOString());
      }
      if (form.situacao_pausada?.checked) dados.append('situacao', 'pausada');
      const r = await fetch(`${API_BASE_URL}/admin/midias-proprias`, {
        method: 'POST',
        body: dados,
        credentials: 'include',
      });
      if (!r.ok) {
        msg.textContent = (await r.json().catch(() => ({}))).erro || 'não deu pra criar';
        msg.className = 'form-msg err';
        return;
      }
      toast('mídia criada');
      fechar();
      aoFechar();
      return;
    }

    const corpo = {
      nome_interno: form.nome_interno.value,
      frequencia_hora: Number(form.frequencia_hora.value),
      cobertura_tipo: form.cobertura_tipo.value,
      periodo_inicio:
        document.getElementById('mmAgendada').checked && form.periodo_inicio.value
          ? new Date(form.periodo_inicio.value).toISOString()
          : null,
      periodo_fim:
        document.getElementById('mmAgendada').checked && form.periodo_fim.value
          ? new Date(form.periodo_fim.value).toISOString()
          : null,
    };
    if (form.cobertura_tipo.value === 'pontos') corpo.pontos_ids = idsMarcados.join(',');
    const r = await api(`/admin/midias-proprias/${midia.id}`, { method: 'PATCH', body: JSON.stringify(corpo) });
    if (!r.ok) {
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'não deu pra salvar';
      msg.className = 'form-msg err';
      return;
    }
    toast('salvo');
    fechar();
    aoFechar();
  });
}

// Hierarquia da página (revisão visual de 23/09/2026, pedido do dono):
// Resumo → Capacidade da rede → Mídias próprias. Capacidade morava depois
// da grade de mídias; como ela é o "quanto ainda cabe" antes de decidir
// criar uma peça nova, faz mais sentido vir primeiro.
async function renderMidiaMostrai(el) {
  const [midias, capacidade] = await Promise.all([pegar('/admin/midias-proprias'), pegar('/admin/capacidade-rede')]);
  const porSituacao = (s) => midias.filter((m) => m.situacaoDerivada === s).length;

  el.innerHTML = `
    <div class="field-row u-ai-c u-mb-14">
      <span class="u-mr-auto"></span>
      <button class="btn primary" id="btnNovaMidia">+ Nova mídia</button>
    </div>
    <div class="mm-resumo u-mb-20">
      <div class="mm-resumo-item"><b>${porSituacao('ativa')}</b><span>ativas</span></div>
      <div class="mm-resumo-item"><b>${porSituacao('agendada')}</b><span>agendadas</span></div>
      <div class="mm-resumo-item"><b>${porSituacao('pausada')}</b><span>pausadas</span></div>
      <div class="mm-resumo-item"><b>${capacidade.length}</b><span>pontos em operação</span></div>
    </div>
    <div id="editorMidiaWrap" hidden></div>

    <h3 class="u-mb-8">Capacidade da rede</h3>
    <div id="mmCapacidadeWrap" class="u-mb-24"></div>

    <div class="field-row u-ai-c u-mb-12">
      <h3 class="u-m-0 u-mr-auto">Mídias próprias</h3>
      <span class="u-dim u-fs-85">${midias.length} ${midias.length === 1 ? 'mídia' : 'mídias'}</span>
    </div>
    ${
      midias.length
        ? `<div class="mm-grid">${midias.map(montarCardMidia).join('')}</div>`
        : `<p class="empty-state">Nenhuma mídia própria cadastrada.<br><span class="u-fs-85">Crie uma mídia para utilizar a reserva institucional da rede.</span></p>`
    }`;

  montarTabelaCapacidade(document.getElementById('mmCapacidadeWrap'), capacidade);

  const wrap = document.getElementById('editorMidiaWrap');
  document
    .getElementById('btnNovaMidia')
    .addEventListener('click', () => abrirEditorMidia(wrap, null, () => renderMidiaMostrai(el)));

  el.querySelectorAll('[data-editar-midia]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const midia = await pegar(`/admin/midias-proprias/${btn.dataset.editarMidia}`);
      abrirEditorMidia(wrap, midia, () => renderMidiaMostrai(el));
    }),
  );
  el.querySelectorAll('[data-pausar-midia]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const r = await api(`/admin/midias-proprias/${btn.dataset.pausarMidia}/pausar`, { method: 'POST' });
      if (!r.ok) return toast('não deu pra pausar', 'err');
      toast('mídia pausada');
      renderMidiaMostrai(el);
    }),
  );
  el.querySelectorAll('[data-retomar-midia]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const r = await api(`/admin/midias-proprias/${btn.dataset.retomarMidia}/retomar`, { method: 'POST' });
      if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'não deu pra retomar', 'err');
      toast('mídia retomada');
      renderMidiaMostrai(el);
    }),
  );
  el.querySelectorAll('[data-encerrar-midia]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Retirar esta mídia do ar? Ela para de entrar na programação — não precisa excluir nada.')) return;
      const r = await api(`/admin/midias-proprias/${btn.dataset.encerrarMidia}/encerrar`, { method: 'POST' });
      if (!r.ok) return toast('não deu pra retirar do ar', 'err');
      toast('mídia retirada do ar');
      renderMidiaMostrai(el);
    }),
  );
}

// ---------- meus anúncios (conta própria do Mostraí) ----------
// A rede anunciando a si mesma. É uma conta comum em `anunciantes` com a
// marca `conta_propria` (migration 023): entra na mesma playlist e gera os
// mesmos contadores, mas dispensa plano e nunca gera cobrança — por isso
// não aparece na receita nem na margem. Só pode existir uma; o índice
// único do banco garante isso mesmo com dois cliques.
async function _renderMeusAnuncios(el) {
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
      _renderMeusAnuncios(el);
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
          <label>Novo anúncio (vídeo ou imagem)</label>
          <label class="btn ghost u-mb-8">Escolher arquivo<input id="cpArquivo" type="file" accept="video/*,image/*" hidden required></label>
          <span class="u-dim u-fs-78 u-d-block u-mb-8" id="cpArquivoNome">nenhum arquivo escolhido</span>
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

  // O botão que escolhe o arquivo é um <label> estilizado escondendo o
  // <input type="file"> de verdade (mesmo truque de "Subir anúncio" em
  // Anunciantes) — sem isto o navegador desenha o próprio botão cinza
  // "Choose File", fora do desenho do resto da tela (achado na varredura
  // visual de 21/09/2026). Como o nome do arquivo escolhido não aparece mais
  // sozinho, este span substitui.
  document.getElementById('cpArquivo').addEventListener('change', (e) => {
    document.getElementById('cpArquivoNome').textContent = e.target.files[0]?.name || 'nenhum arquivo escolhido';
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
    _renderMeusAnuncios(el);
  });

  el.querySelectorAll('[data-tirar],[data-por]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.tirar || b.dataset.por;
      const status = b.dataset.tirar ? 'reprovado' : 'aprovado';
      const r = await api(`/admin/criativos/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      if (!r.ok) return toast('não deu pra mudar', 'err');
      _renderMeusAnuncios(el);
    }),
  );
}

// ---------- pontos ----------
// O ponto virou a entidade central (21/09/2026, pedido do dono). A aba
// Pontos mostra uma grade de cards; clicar num ponto abre o detalhe dele,
// com sub-abas Resumo/Telas/Ocupação — Telas e Ocupação deixaram de ser
// destinos próprios no menu.
//
// Mesmo padrão de sempre: a Visão geral seta este global antes de navegar
// pra cá, quando o clique veio de um status específico em "Pontos por
// status" — consumido uma vez só.
let FILTRO_PONTOS_STATUS = null;

// A chave do aparelho é o que autentica a TV (ver src/lib/aparelho.js).
// O link completo é o que se abre no navegador da tela — ele guarda a
// chave e continua funcionando depois de reiniciar.
const linkDoPlayer = (telaId, chave) =>
  `${window.location.origin}/player.html?tela=${telaId}&chave=${encodeURIComponent(chave)}`;

// `resto` vem cru do roteador (ver resolverAlvo): "" pra grade, "42" pro
// detalhe de um ponto. Sem sub-abas desde o redesenho de 22/09/2026 (a
// ficha virou somente-leitura e cabe na mesma página que Telas) — um hash
// antigo tipo "42/telas" ainda abre o ponto certo, só ignora o resto.
async function renderPontos(el, resto) {
  const [pontoIdBruto] = (resto || '').split('/');
  const pontoId = pontoIdBruto ? Number(pontoIdBruto) : null;
  if (pontoId) return renderPontoDetalhe(el, pontoId);
  return renderPontosGrade(el);
}

// Placeholder oficial de ponto sem foto (redesenho de 22/09/2026) — pedido
// do dono: parar de usar a foto artificial de "seu anúncio aqui" (o cartão
// institucional do player) como fallback de estabelecimento. Mesmo conceito
// nas superfícies que mostram ponto (aqui e public/pontos.page.js — sem
// bundler, cada arquivo tem a própria cópia, convenção do projeto).
function fotoOuPlaceholder(url, nome) {
  if (url) return `<img src="${esc(url)}" alt="${esc(nome || '')}" loading="lazy">`;
  return `<div class="ponto-foto-placeholder" role="img" aria-label="${esc(nome ? `${nome}, sem foto` : 'Ponto sem foto')}">
    <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
      <path d="M12 21.5s7.25-7.35 7.25-12.25a7.25 7.25 0 1 0-14.5 0c0 4.9 7.25 12.25 7.25 12.25Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="12" cy="9.25" r="2.75" fill="none" stroke="currentColor" stroke-width="1.6"/>
    </svg>
  </div>`;
}

function montarPontoCard(p) {
  const segmento = p.categoria_nome || p.categoria_livre || p.segmento;
  const telasTexto = !p.telas ? 'Nenhuma tela ainda' : `${p.telas} ${p.telas === 1 ? 'tela' : 'telas'}`;
  return `<a class="ponto-card ponto-card-link" href="#rede/pontos/${p.id}" data-filtro="${p.status}">
    <div class="ponto-card-media">${fotoOuPlaceholder(p.foto_instalacao_url, p.nome)}</div>
    <span class="badge ${PONTO_STATUS_CLASSE[p.status]}">${PONTO_STATUS[p.status] || p.status}</span>
    <h4>${esc(p.nome)}</h4>
    <p>${esc(p.cidade)}${p.uf ? `/${esc(p.uf)}` : ''}${segmento ? ` · ${esc(segmento)}` : ''}</p>
    <p>${telasTexto}</p>
  </a>`;
}

async function renderPontosGrade(el) {
  // Vem da Visão geral ("Pontos por status" → clique num status real do
  // banco) — status do ponto é automático desde 22/09/2026, então o valor
  // já bate 1:1 com o chip.
  const filtroStatus = FILTRO_PONTOS_STATUS;
  FILTRO_PONTOS_STATUS = null;
  const pontos = await pegar('/admin/pontos');

  el.innerHTML = pontos.length
    ? caixaCards({
        chips: [{ valor: '', nome: 'Todos' }, ...Object.entries(PONTO_STATUS).map(([v, n]) => ({ valor: v, nome: n }))],
        html: pontos.map(montarPontoCard).join(''),
        dica: 'Clique num ponto pra ver a ficha completa e as telas.',
        ativo: filtroStatus,
      })
    : '<p class="empty-state">Nenhum ponto cadastrado ainda. Pedido de "meu ponto" no painel de uma conta vira candidatura na aba Candidaturas — você libera na conta, e o ponto nasce de lá.</p>';

  if (pontos.length) turbinarCards(el.querySelector('.tabela-caixa'), '.ponto-card');
}

// ---------- detalhe do ponto ----------
// Sem abas (redesenho de 22/09/2026): a ficha do estabelecimento é
// somente-leitura, então não compete mais por espaço com a tabela de telas —
// as duas cabem na mesma página, em blocos. Sem endpoint "GET
// /admin/pontos/:id" — reaproveita a listagem (que já junta categoria,
// comodato, dono e contagem de telas) e acha o ponto nela, igual sempre foi;
// por isso também não precisa mais buscar `/admin/categorias` nem
// `/admin/planos-ponto` à parte: os nomes já vêm prontos na própria linha do
// ponto (`categoria_nome`/`plano_ponto_nome`), e o formulário que precisava
// das opções cruas saiu (fluxo morto a menos, pedido da seção 13).
async function renderPontoDetalhe(el, pontoId) {
  const pontos = await pegar('/admin/pontos');
  const ponto = pontos.find((p) => p.id === pontoId);
  if (!ponto) {
    el.innerHTML = '<p class="form-msg err">Ponto não encontrado. <a href="#rede/pontos">Voltar pra Rede</a></p>';
    return;
  }

  el.innerHTML = `
    <p class="ponto-breadcrumb u-mb-16"><a href="#rede/pontos">Rede</a><span class="u-dim"> / </span>${esc(ponto.nome)}</p>
    <div class="ponto-detalhe-grid">
      <div id="pontoInformacoes"></div>
      <div id="pontoTelas"></div>
    </div>`;

  renderPontoInformacoes(document.getElementById('pontoInformacoes'), ponto);
  renderPontoTelas(document.getElementById('pontoTelas'), ponto);
}

// Ficha do estabelecimento — SOMENTE LEITURA (pedido do dono: "dados
// fornecidos pelo estabelecimento devem ser tratados como ficha", não
// formulário). Quem fornece os dados é a candidatura (liberarPapelNaConta,
// src/conta/modos.js); o admin consulta, não edita. Status é automático
// (deriva das telas, src/pontos/repository.js#sincronizarStatusPonto) — não
// tem controle nenhum aqui. Molde ACM saiu do admin de vez (rodada final da
// Rede, 22/09/2026): passou a ser operado fora deste painel, sem sistema
// novo — se precisar consultar o valor antigo, é direto no banco.
// Comodato aparece como informação simples de propósito — a estrutura de
// planos/benefícios de comodato é revisão futura (tela Planos/Benefícios),
// não desta rodada.
function renderPontoInformacoes(el, ponto) {
  // Mesma prioridade do card (montarPontoCard): categoria do catálogo
  // primeiro, senão categoria livre, senão o texto puro de `segmento` — o
  // único que a candidatura de fato grava hoje.
  const segmento = ponto.categoria_nome || ponto.categoria_livre || ponto.segmento;
  const linha = (rotulo, valor) =>
    valor ? `<div><label>${esc(rotulo)}</label><p class="u-m-0">${valor}</p></div>` : '';
  el.innerHTML = `
    <div class="card">
      <div class="ponto-info-cabecalho">
        <div class="ponto-info-foto">${fotoOuPlaceholder(ponto.foto_instalacao_url, ponto.nome)}</div>
        <div class="ponto-info-titulo">
          <span class="badge ${PONTO_STATUS_CLASSE[ponto.status]}">${PONTO_STATUS[ponto.status] || ponto.status}</span>
          <h3 class="u-m-0">${esc(ponto.nome)}</h3>
          <p class="u-dim u-m-0">${esc(ponto.endereco || ponto.cidade)}${ponto.endereco ? `, ${esc(ponto.cidade)}/${esc(ponto.uf)}` : ''}</p>
          <p class="u-dim u-m-0 u-fs-85">${segmento ? esc(segmento) : 'Sem segmento informado'} · ${ponto.telas || 0} ${ponto.telas === 1 ? 'tela' : 'telas'}</p>
        </div>
      </div>
      <hr class="ponto-info-sep">
      <div class="field-row">
        <div class="u-col-2"><label>Responsável</label><p class="u-m-0">${esc(ponto.responsavel_nome || '-')}${ponto.responsavel_contato ? ` · ${esc(ponto.responsavel_contato)}` : ''}</p></div>
        <div class="u-col-2"><label>Dono (conta)</label><p class="u-m-0">${ponto.dono_nome ? esc(ponto.dono_nome) : '<span class="u-dim">sem conta</span>'}</p></div>
      </div>
      <div class="field-row">
        <div class="u-col-2"><label>Movimento estimado/mês</label><p class="u-m-0">${ponto.fluxo_estimado_mensal ? `${num(ponto.fluxo_estimado_mensal)} pessoas` : '<span class="u-dim">não informado</span>'}</p></div>
        <div class="u-col-2"><label>Horário de funcionamento</label><p class="u-m-0">${ponto.horario_semanal ? esc(resumoHorarioSemanal(ponto.horario_semanal)) : '<span class="u-dim">não informado</span>'}</p></div>
      </div>
      ${linha('Comodato', ponto.plano_ponto_nome ? `${esc(ponto.plano_ponto_nome)}${Number(ponto.valor_pago_mensal) > 0 ? ` · ${fmt(ponto.valor_pago_mensal)}/mês` : ''}` : '')}
      ${linha('Observações', ponto.observacoes ? esc(ponto.observacoes) : '')}
      <div><label>Cadastrado em</label><p class="u-m-0">${data(ponto.created_at)}</p></div>
    </div>`;
}

// Mesma tabela e as mesmas ações de sempre (chave, PIN, custo/prazo de
// amortização, painel de exibições, exclusão) — só que sempre escondida
// dentro de UM ponto agora, em vez de "todas as telas da rede" com um
// filtro opcional por cima. A rota já aceitava esse filtro desde sempre.
// Cards horizontais em vez de tabela (rodada final da Rede, 22/09/2026) —
// menos colunas (Tela/Contrato/Custo/Meses/Amort./Painel saíram, seção 12
// do pedido: sem player de terceiro pra configurar contrato, sem custo
// nesta tela) sobraram só ID/status/sinal/chave/PIN/instalação + margens
// novas, e cabem melhor num card do que espremidas numa linha de tabela —
// funciona igual com 1 tela (o caso comum hoje) ou várias.
function montarTelaCard(t, estaOffline) {
  const offline = estaOffline(t);
  return `<div class="tela-card" data-filtro="${t.status}${offline ? ' offline' : ''}${t.aparelho_id ? '' : ' semchave'}">
    <div class="tela-card-topo">
      <span class="tela-card-id">Tela #${t.id}</span>
      ${selectStatus(TELA_STATUS, t.status, `data-tela="status" data-id="${t.id}"`)}
      <span class="tela-card-sinal">${offline ? '<span class="badge badge-err">sem sinal</span>' : t.ultima_vez_online ? `desde ${new Date(t.ultima_vez_online).toLocaleString('pt-BR')}` : '<span class="u-dim">nunca conectou</span>'}</span>
      <button class="btn ghost mini u-txt-erro u-ml-auto" data-excluir-tela="${t.id}" title="Só se essa tela nunca rodou nada">Excluir</button>
    </div>
    <div class="tela-card-corpo">
      <div class="tela-campo">
        <label>Chave / link do player</label>
        ${
          t.aparelho_id
            ? `<div class="field-row"><button class="btn ghost mini" data-copiar="${esc(t.aparelho_id)}" data-tela-id="${t.id}">Copiar link</button>
               <button class="btn ghost mini" data-chave="${t.id}" data-trocar="1" title="Gera uma chave nova e derruba o aparelho atual">Trocar</button></div>`
            : `<button class="btn primary mini" data-chave="${t.id}">Gerar chave</button>`
        }
      </div>
      <div class="tela-campo">
        <label>PIN do painel</label>
        <div class="field-row">${t.tem_pin ? '<span class="badge badge-ok">definido</span>' : '<span class="badge badge-pendente">sem PIN</span>'}
          <button class="btn ghost mini" data-pin="${t.id}">${t.tem_pin ? 'Trocar' : 'Definir'}</button></div>
      </div>
      <div class="tela-campo">
        <label>Instalada em</label>
        <input class="mini" type="date" data-tela="instalado_em" data-id="${t.id}" value="${t.instalado_em ? String(t.instalado_em).slice(0, 10) : ''}">
      </div>
      <div class="tela-campo tela-campo-margens">
        <label title="Área que a moldura do molde ACM cobre — o player encolhe a mídia pra não ficar atrás dela">Margens da safe area (vmin)</label>
        <p class="form-hint u-m-0 u-fs-72">1 vmin = 1% do menor lado da área visível da tela.</p>
        <div class="margens-grid">
          <div class="margem-campo">
            <label for="margemSuperior${t.id}">Superior</label>
            <input class="mini" type="number" min="0" step="0.5" id="margemSuperior${t.id}" data-tela="margem_superior" data-id="${t.id}" value="${t.margem_superior ?? 0}">
          </div>
          <div class="margem-campo">
            <label for="margemDireita${t.id}">Direita</label>
            <input class="mini" type="number" min="0" step="0.5" id="margemDireita${t.id}" data-tela="margem_direita" data-id="${t.id}" value="${t.margem_direita ?? 0}">
          </div>
          <div class="margem-campo">
            <label for="margemInferior${t.id}">Inferior</label>
            <input class="mini" type="number" min="0" step="0.5" id="margemInferior${t.id}" data-tela="margem_inferior" data-id="${t.id}" value="${t.margem_inferior ?? 0}">
          </div>
          <div class="margem-campo">
            <label for="margemEsquerda${t.id}">Esquerda</label>
            <input class="mini" type="number" min="0" step="0.5" id="margemEsquerda${t.id}" data-tela="margem_esquerda" data-id="${t.id}" value="${t.margem_esquerda ?? 0}">
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

async function renderPontoTelas(el, ponto) {
  const [telas, semSinal] = await Promise.all([
    pegar(`/admin/pontos/${ponto.id}/dispositivos`),
    pegar('/admin/pontos-offline').catch(() => []),
  ]);
  const idsOffline = new Set((semSinal || []).map((d) => d.id));
  const estaOffline = (t) => idsOffline.has(t.id);

  el.innerHTML = `
    <div class="card">
      <div class="field-row u-mb-10">
        <h3 class="u-m-0 u-mr-auto">Telas</h3>
        <button class="btn ghost mini" id="btnNovaTela">+ tela</button>
      </div>
      ${
        telas.length
          ? `<div class="telas-topo u-mb-10">
              <input class="busca" type="search" placeholder="Buscar...">
              <div class="chips">
                <button type="button" class="chip active" data-filtro="">Todas</button>
                <button type="button" class="chip" data-filtro="offline">Sem sinal</button>
                <button type="button" class="chip" data-filtro="semchave">Sem chave</button>
                ${Object.entries(TELA_STATUS)
                  .map(([v, n]) => `<button type="button" class="chip" data-filtro="${v}">${n}</button>`)
                  .join('')}
              </div>
            </div>
            <div class="telas-lista">${telas.map((t) => montarTelaCard(t, estaOffline)).join('')}</div>
            <p class="u-dim u-fs-78 u-m-0 u-mt-8" data-contagem></p>`
          : '<p class="empty-state">Nenhuma tela instalada neste ponto.</p>'
      }
    </div>`;

  document.getElementById('btnNovaTela').addEventListener('click', async () => {
    const apelido = prompt('Nome da tela (só interno, ex.: Tela 2 — balcão):', `Tela ${telas.length + 1}`);
    if (apelido === null) return;
    const r = await api(`/admin/pontos/${ponto.id}/dispositivos`, {
      method: 'POST',
      body: JSON.stringify({ apelido }),
    });
    if (!r.ok) return toast('Não foi possível criar a tela.', 'err');
    toast('Tela criada. Gere a chave dela abaixo.');
    renderPontoTelas(el, ponto);
  });

  if (!telas.length) return;

  const busca = el.querySelector('.busca');
  const contagem = el.querySelector('[data-contagem]');
  const cartoes = () => [...el.querySelectorAll('.tela-card')];
  function aplicarFiltro() {
    const termo = (busca.value || '').toLowerCase().trim();
    const chipAtivo = el.querySelector('.chip.active');
    const filtro = chipAtivo ? chipAtivo.dataset.filtro : '';
    let visiveis = 0;
    cartoes().forEach((card) => {
      const casaTermo = !termo || card.textContent.toLowerCase().includes(termo);
      const casaFiltro = !filtro || (card.dataset.filtro || '').split(' ').includes(filtro);
      card.hidden = !(casaTermo && casaFiltro);
      if (!card.hidden) visiveis += 1;
    });
    contagem.textContent = `${visiveis} de ${cartoes().length}`;
  }
  busca.addEventListener('input', aplicarFiltro);
  el.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      el.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      aplicarFiltro();
    }),
  );
  aplicarFiltro();

  el.querySelectorAll('[data-tela]').forEach((campo) =>
    campo.addEventListener('change', async () => {
      const numerico = ['margem_superior', 'margem_direita', 'margem_inferior', 'margem_esquerda'].includes(
        campo.dataset.tela,
      );
      const valor = campo.value === '' ? null : numerico ? Number(campo.value) : campo.value;
      if (await salvar(`/admin/dispositivos/${campo.dataset.id}`, { [campo.dataset.tela]: valor }, campo)) {
        if (campo.dataset.tela === 'status') {
          RESUMO = await pegar('/admin/resumo');
          pintarContadores();
          renderPontoTelas(el, ponto);
        }
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
      prompt('Abra este link no navegador da TV:', linkDoPlayer(btn.dataset.chave, aparelho_id));
      renderPontoTelas(el, ponto);
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
      const pin = prompt('PIN de 4 a 6 dígitos (deixe vazio pra remover):');
      if (pin === null) return;
      const r = await api(`/admin/dispositivos/${btn.dataset.pin}/pin`, {
        method: 'POST',
        body: JSON.stringify({ pin: pin.trim() || null }),
      });
      if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'Não foi possível salvar o PIN.', 'err');
      toast(pin.trim() ? 'PIN definido.' : 'PIN removido.');
      renderPontoTelas(el, ponto);
    }),
  );

  el.querySelectorAll('[data-excluir-tela]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Excluir essa tela? Só faça isso se ela nunca rodou nada (o histórico de exibições vai junto).'))
        return;
      const r = await api(`/admin/dispositivos/${btn.dataset.excluirTela}`, { method: 'DELETE' });
      if (!r.ok) return toast('Não foi possível excluir.', 'err');
      toast('Tela excluída.');
      renderPontoTelas(el, ponto);
    }),
  );
}

// Ocupação por ponto saiu da ficha (redesenho de 22/09/2026, pedido do
// dono) — virou visão agregada da rede inteira em "Visão geral"
// (renderOcupacaoRede, mais abaixo). Mesmo endpoint (`/admin/pontos-ocupacao`)
// e mesma regra G.7 (LIMITE_OCUPACAO_BLOQUEIA = 0.8, src/pontos/repository.js)
// — só a exibição mudou de lugar, o cálculo é lido de lá, não duplicado.

// ---------- contas ----------
// Central de Contas (reconstrução final de 23/09/2026, pedido do dono).
//
// TODA CONTA JÁ PODE ANUNCIAR — "anunciante" não é papel, status nem badge.
// O que a tela mostra de uma conta sai de FATOS, nunca de rótulo gravado:
// tem ponto → "Dono de ponto"; tem ponto em comodato → coluna Comodato; tem
// plano comercial vigente → coluna Plano. Vendedor e Parceiro saíram da
// experiência (os dados antigos continuam no banco, intocados). A conta
// interna do Mostraí (`conta_propria`) não aparece aqui: ela é gerida em
// Mídia Mostraí e não é cliente.
//
// A tabela continua sendo `anunciantes` — só a UI chama de conta.

// Comodato (Inicial/Básico) e plano comercial (Essencial/Pro/Prime) são
// entitlements INDEPENDENTES desde 23/09/2026 — decisão do dono e do GPT,
// migration 076: dois campos próprios (`plano_id` e `comodato_plano_id`),
// nunca mais um sobrescrevendo o outro. Básico coexiste com qualquer plano
// comercial; Inicial bloqueia conceder/vender um (o backend recusa —
// `pontos/comodato.js#bloqueiaPlanoComercial` — as duas telas de plano
// abaixo só mostram o erro que ele mandar).

function nomeDoPlano(plano) {
  if (!plano) return '';
  return `${plano.nome} · ${CICLOS[plano.compromisso_meses] || `${plano.compromisso_meses} meses`}`;
}

// Plano COMERCIAL da conta, com a origem (Parte 12): 'assinatura' = pago
// pelo San Checkout; 'cortesia' = benefício concedido pelo admin (ou bônus).
function planoComercialDaConta(conta, planosPorId) {
  if (!conta.plano_id) return null;
  return {
    plano: planosPorId[conta.plano_id] || null,
    id: conta.plano_id,
    origem: conta.plano_cortesia ? 'cortesia' : 'assinatura',
    vencido: !!(conta.data_expiracao && new Date(conta.data_expiracao) < new Date()),
    expira: conta.data_expiracao,
  };
}

const ORIGEM_PLANO = { assinatura: 'Assinatura paga', cortesia: 'Cortesia administrativa' };

// Comodato é direito do PONTO (modalidade + produto Inicial/Básico),
// espelhado em `conta.comodato_plano_id` (sincronizado por
// `pontos/comodato.js#sincronizarComodato` toda vez que a modalidade de um
// ponto muda). A lista de pontos só entra aqui pra mostrar QUAL modalidade
// ("Troca os R$ 50 por tela") — o produto em si vem do campo da conta.
function comodatoDaConta(conta, pontosDaConta, planosPorId) {
  if (!conta.comodato_plano_id) return null;
  const ponto =
    pontosDaConta.find(
      (p) => p.plano_ponto_id && p.comodato_produto_nome === planosPorId[conta.comodato_plano_id]?.nome,
    ) || pontosDaConta.find((p) => p.plano_ponto_nome);
  return {
    produto: planosPorId[conta.comodato_plano_id]?.nome || ponto?.comodato_produto_nome || 'Comodato',
    modalidade: ponto?.plano_ponto_nome || null,
  };
}

async function renderContasAba(el, resto) {
  const contaId = resto ? Number(resto) : null;
  if (contaId) return renderContaDetalhe(el, contaId);
  return renderContasLista(el);
}

async function renderContasLista(el) {
  const [anunciantes, categorias, planos, pontos] = await Promise.all([
    pegar('/admin/anunciantes'),
    pegar('/admin/categorias'),
    pegar('/admin/planos'),
    pegar('/admin/pontos'),
  ]);
  const planosPorId = Object.fromEntries(planos.map((p) => [p.id, p]));
  const nomeCategoria = Object.fromEntries(categorias.map((c) => [c.id, c.nome]));
  const pontosPorConta = {};
  pontos.forEach((p) => {
    if (!p.anunciante_id) return;
    if (!pontosPorConta[p.anunciante_id]) pontosPorConta[p.anunciante_id] = [];
    pontosPorConta[p.anunciante_id].push(p);
  });
  const contas = anunciantes.filter((a) => !a.conta_propria);

  const linhas = contas
    .map((a) => {
      const pts = pontosPorConta[a.id] || [];
      const comercial = planoComercialDaConta(a, planosPorId);
      const comodato = comodatoDaConta(a, pts, planosPorId);
      const filtro = [
        comercial && !comercial.vencido ? 'com-plano' : 'sem-plano',
        pts.length ? 'dono-ponto' : '',
        comodato ? 'comodato' : '',
        a.suspenso ? 'suspensa' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const sinais = [
        a.suspenso ? '<span class="conta-sinal conta-sinal-err">suspensa</span>' : '',
        a.excluido_em ? `<span class="conta-sinal">excluída em ${data(a.excluido_em)}</span>` : '',
      ].join('');
      const categoria = a.categoria_id
        ? esc(nomeCategoria[a.categoria_id] || '—')
        : a.categoria_livre
          ? `<span class="u-dim" title="Descrita pelo cliente — falta escolher a categoria">${esc(a.categoria_livre)} (livre)</span>`
          : '<span class="u-dim">—</span>';
      const plano = comercial
        ? `${esc(nomeDoPlano(comercial.plano) || comercial.id)}<small class="cat-detalhe">${
            comercial.vencido ? `venceu em ${data(comercial.expira)}` : ORIGEM_PLANO[comercial.origem]
          }</small>`
        : '<span class="u-dim">—</span>';
      return `<tr data-filtro="${filtro}" class="linha-clicavel${a.excluido_em ? ' u-op-60' : ''}" data-abrir="${a.id}">
        <td><b>${esc(a.nome_empresa)}</b>${sinais}</td>
        <td><div class="u-fs-78">${esc(a.contato_email)}</div><div class="u-dim u-fs-74">${esc(a.contato_telefone)}</div></td>
        <td>${categoria}</td>
        <td>${plano}</td>
        <td>${comodato ? esc(comodato.produto || comodato.modalidade) : '<span class="u-dim">—</span>'}</td>
        <td class="num">${pts.length}</td>
        <td data-valor="${new Date(a.created_at).getTime()}">${data(a.created_at)}</td>
      </tr>`;
    })
    .join('');

  el.innerHTML = contas.length
    ? caixaTabela({
        chips: [
          { valor: '', nome: 'Todas' },
          { valor: 'com-plano', nome: 'Com plano' },
          { valor: 'sem-plano', nome: 'Sem plano' },
          { valor: 'dono-ponto', nome: 'Donos de ponto' },
          { valor: 'comodato', nome: 'Com comodato' },
          { valor: 'suspensa', nome: 'Suspensas' },
        ],
        html: `<table class="tabela-contas"><thead><tr>
            <th data-ord>Conta</th><th>Contato</th><th data-ord>Categoria</th><th data-ord>Plano</th>
            <th data-ord>Comodato</th><th data-ord class="num">Pontos</th><th data-ord>Entrou</th>
          </tr></thead><tbody>${linhas}</tbody></table>`,
        dica: 'Clique numa conta pra abrir a ficha. Toda conta pode anunciar.',
      })
    : '<p class="empty-state">Nenhuma conta ainda. O cadastro pelo site cai aqui na hora.</p>';

  if (contas.length) turbinarTabela(el.querySelector('.tabela-caixa'));
  el.querySelectorAll('[data-abrir]').forEach((tr) =>
    tr.addEventListener('click', () => irPara(`contas/contas/${tr.dataset.abrir}`)),
  );
}

// ---------- ficha da conta ----------
// Página única, sem mini-abas (Parte 8): Conta (cabeçalho) → Dados → Plano →
// Comodato → Criativos → Pontos → Suspensão, nesta ordem, tudo visível.
async function renderContaDetalhe(el, contaId) {
  const [anunciantes, categorias, planos, pontos] = await Promise.all([
    pegar('/admin/anunciantes'),
    pegar('/admin/categorias'),
    pegar('/admin/planos'),
    pegar('/admin/pontos'),
  ]);
  const conta = anunciantes.find((a) => a.id === contaId);
  if (!conta || conta.conta_propria) {
    el.innerHTML = `<nav class="breadcrumb"><a href="#contas/contas">Contas</a></nav>
      <p class="form-msg err">${conta ? 'A conta interna do Mostraí é gerida em Mídia Mostraí.' : 'Conta não encontrada.'}</p>`;
    return;
  }
  const [planoInfo, criativosInfo] = await Promise.all([
    pegar(`/admin/anunciantes/${conta.id}/plano`),
    pegar(`/admin/anunciantes/${conta.id}/criativos`),
  ]);
  const planosPorId = Object.fromEntries(planos.map((p) => [p.id, p]));
  const pontosDaConta = pontos.filter((p) => p.anunciante_id === conta.id);
  const comercial = planoComercialDaConta(conta, planosPorId);
  const comodato = comodatoDaConta(conta, pontosDaConta, planosPorId);
  const bloqueada = conta.suspenso || !!conta.excluido_em;
  const recarregar = () => renderContaDetalhe(el, conta.id);
  const ctx = { conta, categorias, planos, planosPorId, comercial, planoInfo, criativosInfo, bloqueada, recarregar };

  el.innerHTML = `
    <nav class="breadcrumb" aria-label="Você está em"><a href="#contas/contas">Contas</a><span aria-hidden="true">/</span><span>${esc(conta.nome_empresa)}</span></nav>
    <header class="conta-cabecalho">
      <h2>${esc(conta.nome_empresa)}</h2>
      ${pontosDaConta.length ? '<span class="badge badge-info">Dono de ponto</span>' : ''}
      ${conta.suspenso ? '<span class="conta-sinal conta-sinal-err">Conta suspensa</span>' : ''}
      ${conta.excluido_em ? `<span class="conta-sinal">Excluída em ${data(conta.excluido_em)}</span>` : ''}
    </header>
    <div class="conta-grade">
      <section class="card conta-secao" id="contaDados"></section>
      <div class="conta-coluna">
        <section class="card conta-secao" id="contaPlano"></section>
        <section class="card conta-secao" id="contaComodato"></section>
      </div>
    </div>
    <section class="card conta-secao" id="contaCriativos"></section>
    <section class="card conta-secao" id="contaPontos"></section>
    <div class="conta-rodape" id="contaRodape"></div>`;

  desenharContaDados(document.getElementById('contaDados'), ctx);
  desenharContaPlano(document.getElementById('contaPlano'), ctx);
  desenharContaComodato(document.getElementById('contaComodato'), comodato, pontosDaConta);
  desenharContaCriativos(document.getElementById('contaCriativos'), ctx);
  desenharContaPontos(document.getElementById('contaPontos'), pontosDaConta);
  desenharContaRodape(document.getElementById('contaRodape'), ctx);
}

// Dados: só leitura, menos a categoria (Parte 11 — o admin corrige a
// categoria aqui; o resto é do cliente, pelo painel dele).
function desenharContaDados(el, { conta, categorias }) {
  const atual = categorias.find((c) => c.id === conta.categoria_id);
  const aviso = atual?.legado
    ? `<p class="u-dim u-fs-78 u-m-0 u-mt-4">“${esc(atual.nome)}” é uma categoria antiga — escolha a atual.</p>`
    : !atual && conta.categoria_livre
      ? `<p class="u-dim u-fs-78 u-m-0 u-mt-4">O cliente descreveu: “${esc(conta.categoria_livre)}”. Escolha a categoria que corresponde.</p>`
      : '';
  el.innerHTML = `
    <h3>Dados</h3>
    <dl class="conta-dados">
      <div><dt>Documento</dt><dd>${esc(conta.cpf_cnpj)}</dd></div>
      <div><dt>Entrou em</dt><dd>${data(conta.created_at)}</dd></div>
      <div><dt>E-mail</dt><dd>${esc(conta.contato_email)}</dd></div>
      <div><dt>WhatsApp</dt><dd>${esc(conta.contato_telefone)}</dd></div>
      <div class="conta-dados-largo"><dt><label for="fichaCategoriaBusca">Categoria</label></dt><dd>
        ${categoriaBuscaHtml('fichaCategoria', atual, { placeholder: 'Pesquise a categoria...' })}
        ${aviso}
      </dd></div>
    </dl>`;
  ligarCategoriaBusca('fichaCategoria', categorias, (categoria) => {
    salvar(
      `/admin/anunciantes/${conta.id}`,
      { categoria_id: categoria.id, categoria_livre: null },
      document.getElementById('fichaCategoriaBusca'),
    );
  });
}

// Plano comercial (Partes 12-17). Conceder/alterar/cancelar sempre por modal.
function desenharContaPlano(el, ctx) {
  const { conta, comercial, planoInfo, bloqueada } = ctx;
  const assinaturaAtiva = planoInfo.assinatura_ativa;
  const vigente = planoInfo.historico.find(
    (h) => !h.encerrado_em && comercial?.origem === 'cortesia' && h.plano_id === conta.plano_id,
  );
  let corpo;
  if (comercial) {
    const detalhe =
      comercial.origem === 'assinatura'
        ? assinaturaAtiva
          ? 'Cobrança recorrente pelo San Checkout.'
          : 'Assinatura já cancelada — a cobertura paga vale até a data abaixo.'
        : 'Sem cobrança — não entra em receita.';
    corpo = `
      <p class="conta-plano-nome">${esc(nomeDoPlano(comercial.plano) || comercial.id)}</p>
      <p class="u-m-0"><span class="badge ${comercial.origem === 'assinatura' ? 'badge-ok' : 'badge-info'}">${ORIGEM_PLANO[comercial.origem]}</span></p>
      <dl class="conta-dados u-mt-12">
        <div><dt>${comercial.vencido ? 'Venceu em' : 'Válido até'}</dt><dd>${comercial.expira ? data(comercial.expira) : 'sem prazo'}</dd></div>
        <div><dt>Desde</dt><dd>${conta.data_inicio_cobertura ? data(conta.data_inicio_cobertura) : '—'}</dd></div>
        ${vigente?.observacao ? `<div class="conta-dados-largo"><dt>Observação</dt><dd>${esc(vigente.observacao)}</dd></div>` : ''}
      </dl>
      <p class="u-dim u-fs-78 u-mb-0">${detalhe}</p>`;
  } else {
    corpo = '<p class="u-dim u-m-0">Sem plano comercial.</p>';
  }
  const podeCancelar = comercial && (comercial.origem === 'cortesia' || assinaturaAtiva);
  const acoes = bloqueada
    ? `<p class="u-dim u-fs-78 u-mb-0">${conta.excluido_em ? 'Restaure a conta' : 'Reative a conta'} pra mexer no plano.</p>`
    : `<div class="conta-acoes">
        <button type="button" class="btn ${comercial ? 'ghost' : 'primary'} mini" data-plano-conceder>${comercial ? 'Alterar plano' : 'Conceder plano'}</button>
        ${podeCancelar ? '<button type="button" class="btn ghost mini btn-texto-perigo" data-plano-cancelar>Cancelar plano</button>' : ''}
      </div>`;
  const historico = planoInfo.historico.length
    ? `<details class="conta-historico"><summary>Histórico de benefícios (${planoInfo.historico.length})</summary><ul>${planoInfo.historico
        .map((h) => {
          const fim = h.encerrado_em
            ? `encerrado em ${data(h.encerrado_em)}${h.encerrado_motivo === 'substituido' ? ' (substituído)' : ''}`
            : `até ${data(h.valido_ate)}`;
          return `<li><b>${esc(nomeDoPlano({ nome: h.plano_nome, compromisso_meses: h.compromisso_meses }))}</b> · desde ${data(h.inicio)} · ${fim}${h.concedido_por ? ` · por ${esc(h.concedido_por)}` : ''}${h.observacao ? `<br><span class="u-dim">${esc(h.observacao)}</span>` : ''}</li>`;
        })
        .join('')}</ul></details>`
    : '';
  el.innerHTML = `<h3>Plano</h3>${corpo}${acoes}${historico}`;
  el.querySelector('[data-plano-conceder]')?.addEventListener('click', () => abrirPlanoAdministrativo(ctx));
  el.querySelector('[data-plano-cancelar]')?.addEventListener('click', () => abrirCancelarPlano(ctx));
}

function desenharContaComodato(el, comodato, pontosDaConta) {
  el.innerHTML = comodato
    ? `<h3>Comodato</h3>
      <dl class="conta-dados">
        <div><dt>Produto</dt><dd>${esc(comodato.produto || '—')}</dd></div>
        <div><dt>Modalidade</dt><dd>${esc(comodato.modalidade || '—')}</dd></div>
      </dl>
      <p class="u-dim u-fs-78 u-mb-0">Vem do ponto${pontosDaConta.length > 1 ? ' (a conta tem mais de um)' : ''}, sem cobrança. Separado do plano comercial.</p>`
    : '<h3>Comodato</h3><p class="u-dim u-m-0">Sem ponto em comodato.</p>';
}

// Pontos da conta — mesmos cards de Rede > Pontos (foto/placeholder, status,
// telas), com endereço. Clique leva pro ponto na Rede: telas não se gerenciam
// daqui (Parte 25).
function desenharContaPontos(el, pontosDaConta) {
  el.innerHTML = `<h3>Pontos</h3>${
    pontosDaConta.length
      ? `<div class="pontos-grid conta-pontos-grid">${pontosDaConta
          .map((p) => {
            const endereco = [p.endereco, p.bairro].filter(Boolean).join(' · ');
            const telas = !p.telas ? 'Nenhuma tela ainda' : `${p.telas} ${Number(p.telas) === 1 ? 'tela' : 'telas'}`;
            return `<a class="ponto-card ponto-card-link" href="#rede/pontos/${p.id}">
              <div class="ponto-card-media">${fotoOuPlaceholder(p.foto_instalacao_url, p.nome)}</div>
              <span class="badge ${PONTO_STATUS_CLASSE[p.status] || 'badge-pendente'}">${esc(PONTO_STATUS[p.status] || p.status)}</span>
              <h4>${esc(p.nome)}</h4>
              ${endereco ? `<p>${esc(endereco)}</p>` : ''}
              <p>${esc(p.cidade || '')}${p.uf ? `/${esc(p.uf)}` : ''} · ${telas}</p>
            </a>`;
          })
          .join('')}</div>`
      : '<p class="u-dim u-m-0">Nenhum ponto nesta conta.</p>'
  }`;
}

// ---------- criativos da conta (Partes 18-24) ----------
// Mesmo motor da fila global de Aprovação: aprovar/recusar é o mesmo PATCH
// /admin/criativos/:id, trocar arquivo é o mesmo /substituir. O que é só
// daqui: ver os estados todos juntos e substituir SEM tirar o atual do ar.
const CRIATIVO_ORDEM = { pendente: 0, aprovado: 1, retirado: 2, reprovado: 3 };

function estadoCriativo(c, info) {
  if (c.status === 'pendente') return { nome: 'Em análise', classe: 'badge-pendente' };
  if (c.status === 'reprovado') return { nome: 'Recusado', classe: 'badge-err' };
  if (c.status === 'retirado') return { nome: 'Fora do ar', classe: 'badge-neutro' };
  if (c.no_ar) return { nome: 'No ar', classe: 'badge-ok' };
  const motivo = !info.conta_veicula
    ? 'a conta não está veiculando (sem plano vigente ou suspensa)'
    : `o plano põe ${info.limite_no_ar} no ar por vez`;
  return { nome: 'Aprovado', classe: 'badge-info', dica: `Aprovado, mas fora da rotação: ${motivo}.` };
}

function desenharContaCriativos(el, ctx) {
  const { criativosInfo: info, bloqueada } = ctx;
  const criativos = [...info.criativos].sort(
    (a, b) => (CRIATIVO_ORDEM[a.status] ?? 9) - (CRIATIVO_ORDEM[b.status] ?? 9),
  );
  const substitutoDe = {};
  criativos.forEach((c) => {
    if (c.substitui_criativo_id && c.status === 'pendente') substitutoDe[c.substitui_criativo_id] = c;
  });
  const cadastrados = criativos.filter(
    (c) => c.status !== 'reprovado' && !(c.status === 'pendente' && c.substitui_criativo_id),
  ).length;
  const noAr = criativos.filter((c) => c.no_ar).length;
  const podeAdicionar = !bloqueada && cadastrados < info.limite_cadastro;

  const cards = criativos
    .map((c) => {
      const estado = estadoCriativo(c, info);
      const ehVideo = !ehImagemArquivo(c.arquivo_original_url);
      const acoes = [];
      acoes.push(`<button type="button" class="btn ghost mini" data-cr-ver="${c.id}">Ver</button>`);
      if (!bloqueada) {
        if (c.status === 'pendente') {
          acoes.push(`<button type="button" class="btn primary mini" data-cr-aprovar="${c.id}">Aprovar</button>`);
          acoes.push(`<button type="button" class="btn ghost mini" data-cr-recusar="${c.id}">Recusar</button>`);
          acoes.push(`<button type="button" class="btn ghost mini" data-cr-arquivo="${c.id}">Trocar arquivo</button>`);
        } else if (c.status === 'aprovado') {
          if (!substitutoDe[c.id]) {
            acoes.push(`<button type="button" class="btn ghost mini" data-cr-substituir="${c.id}">Substituir</button>`);
          }
          acoes.push(`<button type="button" class="btn ghost mini" data-cr-retirar="${c.id}">Retirar do ar</button>`);
        } else if (c.status === 'retirado') {
          acoes.push(`<button type="button" class="btn ghost mini" data-cr-colocar="${c.id}">Colocar no ar</button>`);
        } else if (c.status === 'reprovado') {
          acoes.push(`<button type="button" class="btn ghost mini" data-cr-arquivo="${c.id}">Trocar arquivo</button>`);
        }
      }
      const notas = [
        c.substitui_criativo_id && c.status === 'pendente'
          ? `Substitui o #${c.substitui_criativo_id}, que segue no ar até este ser aprovado.`
          : '',
        substitutoDe[c.id] ? `Tem substituto em análise (#${substitutoDe[c.id].id}).` : '',
        estado.dica || '',
        c.status === 'reprovado' && c.motivo_reprovacao ? `Motivo: ${c.motivo_reprovacao}` : '',
      ].filter(Boolean);
      return `<article class="conta-criativo">
        <div class="conta-criativo-midia">${montarPreviewAsset({ original: c.arquivo_original_url, normalizado: c.arquivo_normalizado_url, thumb: c.thumbnail_url })}</div>
        <div class="conta-criativo-corpo">
          <div class="conta-criativo-topo"><span class="badge ${estado.classe}">${estado.nome}</span><small>#${c.id}</small></div>
          <p class="u-dim u-fs-78 u-m-0">${ehVideo ? 'Vídeo' : 'Imagem'}${c.duracao_segundos ? ` · ${c.duracao_segundos}s` : ''} · enviado ${data(c.created_at)}${c.editado_pelo_operador ? ' · pelo Mostraí' : ''}</p>
          ${notas.map((n) => `<p class="conta-criativo-nota">${esc(n)}</p>`).join('')}
          <div class="conta-acoes">${acoes.join('')}</div>
        </div>
      </article>`;
    })
    .join('');

  el.innerHTML = `
    <div class="conta-secao-topo">
      <h3>Criativos</h3>
      <span class="u-dim u-fs-78">${cadastrados} de ${info.limite_cadastro} cadastrados${info.limite_no_ar ? ` · o plano põe ${info.limite_no_ar} no ar por vez (${noAr} agora)` : ''}</span>
      <span class="u-mr-auto"></span>
      ${podeAdicionar ? '<button type="button" class="btn primary mini" data-cr-adicionar>Adicionar criativo</button>' : ''}
    </div>
    ${
      criativos.length
        ? `<div class="conta-criativos-grid">${cards}</div>`
        : '<p class="u-dim u-m-0">Nenhum criativo nesta conta ainda.</p>'
    }
    ${bloqueada ? '<p class="u-dim u-fs-78 u-mb-0">Conta suspensa ou excluída — criativos só leitura.</p>' : !podeAdicionar && criativos.length ? `<p class="u-dim u-fs-78 u-mb-0">Limite de ${info.limite_cadastro} criativos cadastrados atingido — substitua ou retire um pra trocar.</p>` : ''}`;

  const achar = (id) => criativos.find((c) => c.id === Number(id));
  const { recarregar } = ctx;
  const pintarFila = async () => {
    RESUMO = await pegar('/admin/resumo');
    pintarContadores();
  };

  el.querySelectorAll('[data-cr-ver]').forEach((b) =>
    b.addEventListener('click', () =>
      verCriativo(achar(b.dataset.crVer), estadoCriativo(achar(b.dataset.crVer), info)),
    ),
  );
  el.querySelectorAll('[data-cr-aprovar]').forEach((b) =>
    b.addEventListener('click', async () => {
      const c = achar(b.dataset.crAprovar);
      if (c.substitui_criativo_id) {
        const ok = await confirmarModal({
          titulo: 'Aprovar substituto?',
          texto: `<p>O #${c.id} entra no ar e o #${c.substitui_criativo_id} sai do ar (fica cadastrado como “fora do ar”).</p>`,
          botao: 'Aprovar e trocar',
        });
        if (!ok) return;
      }
      if (await salvar(`/admin/criativos/${c.id}`, { status: 'aprovado' })) {
        await pintarFila();
        recarregar();
      }
    }),
  );
  el.querySelectorAll('[data-cr-recusar]').forEach((b) =>
    b.addEventListener('click', () =>
      recusarCriativo(achar(b.dataset.crRecusar), async () => {
        await pintarFila();
        recarregar();
      }),
    ),
  );
  el.querySelectorAll('[data-cr-retirar]').forEach((b) =>
    b.addEventListener('click', async () => {
      const c = achar(b.dataset.crRetirar);
      const ok = await confirmarModal({
        titulo: 'Retirar do ar?',
        texto: `<p>O criativo #${c.id} sai da rotação das telas agora. Continua cadastrado na conta e pode voltar pro ar depois.</p>`,
        botao: 'Retirar do ar',
      });
      if (ok && (await salvar(`/admin/criativos/${c.id}`, { status: 'retirado' }))) recarregar();
    }),
  );
  el.querySelectorAll('[data-cr-colocar]').forEach((b) =>
    b.addEventListener('click', async () => {
      const c = achar(b.dataset.crColocar);
      const ok = await confirmarModal({
        titulo: 'Colocar no ar?',
        texto: `<p>O criativo #${c.id} volta a ser aprovado. ${info.limite_no_ar ? `O plano põe ${info.limite_no_ar} no ar por vez — se passar disso, rodam os mais recentes.` : 'A conta precisa de plano vigente pra ele rodar.'}</p>`,
        botao: 'Colocar no ar',
      });
      if (ok && (await salvar(`/admin/criativos/${c.id}`, { status: 'aprovado' }))) recarregar();
    }),
  );
  el.querySelector('[data-cr-adicionar]')?.addEventListener('click', () =>
    enviarCriativo({
      titulo: 'Adicionar criativo',
      explicacao:
        'O arquivo é normalizado e entra aprovado (subido pelo Mostraí). Vídeo de 3 a 60 segundos, ou imagem.',
      url: `/admin/anunciantes/${ctx.conta.id}/criativos`,
      aoTerminar: recarregar,
    }),
  );
  el.querySelectorAll('[data-cr-substituir]').forEach((b) =>
    b.addEventListener('click', () =>
      enviarCriativo({
        titulo: `Substituir criativo #${b.dataset.crSubstituir}`,
        explicacao:
          'O novo arquivo entra em análise. O atual continua no ar até você aprovar o novo — aí os dois trocam de lugar.',
        url: `/admin/criativos/${b.dataset.crSubstituir}/substituto`,
        aoTerminar: async () => {
          await pintarFila();
          recarregar();
        },
      }),
    ),
  );
  el.querySelectorAll('[data-cr-arquivo]').forEach((b) =>
    b.addEventListener('click', () =>
      enviarCriativo({
        titulo: `Trocar arquivo do criativo #${b.dataset.crArquivo}`,
        explicacao: 'Troca o arquivo deste mesmo criativo. Ele volta pra “em análise” até ser aprovado.',
        url: `/admin/criativos/${b.dataset.crArquivo}/substituir`,
        aoTerminar: async () => {
          await pintarFila();
          recarregar();
        },
      }),
    ),
  );
}

function verCriativo(c, estado) {
  const url = c.arquivo_normalizado_url || c.arquivo_original_url;
  abrirModal({
    titulo: `Criativo #${c.id}`,
    largo: true,
    corpo: `<div class="ver-criativo">
      <div class="ver-criativo-midia">${montarPreviewAsset({ original: c.arquivo_original_url, normalizado: c.arquivo_normalizado_url, thumb: c.thumbnail_url })}</div>
      <dl class="conta-dados">
        <div><dt>Estado</dt><dd><span class="badge ${estado.classe}">${estado.nome}</span></dd></div>
        <div><dt>Formato</dt><dd>${ehImagemArquivo(c.arquivo_original_url) ? 'Imagem' : 'Vídeo'}${c.duracao_segundos ? ` · ${c.duracao_segundos}s` : ''}</dd></div>
        <div><dt>Enviado em</dt><dd>${data(c.created_at)}</dd></div>
        ${c.motivo_reprovacao ? `<div class="conta-dados-largo"><dt>Motivo da recusa</dt><dd>${esc(c.motivo_reprovacao)}</dd></div>` : ''}
      </dl>
    </div>`,
    rodape: `${url && /^https?:/.test(url) ? `<a class="btn ghost mini" href="${esc(url)}" download target="_blank" rel="noopener">Baixar arquivo</a>` : ''}<span class="u-mr-auto"></span><button type="button" class="btn ghost" data-fechar>Fechar</button>`,
  });
}

// Recusar com motivo — modal no lugar do prompt() (o anunciante lê o motivo
// no painel e no e-mail, então ele é obrigatório).
function recusarCriativo(c, aoTerminar) {
  const { dlg, fechar } = abrirModal({
    titulo: `Recusar criativo #${c.id}`,
    corpo: `<label for="motivoRecusa">Motivo <span class="u-dim">(o cliente lê isto no painel e no e-mail)</span></label>
      <textarea id="motivoRecusa" rows="3" placeholder="ex.: o texto final fica fora da área visível da tela"></textarea>
      <p class="form-msg" data-msg role="status"></p>`,
    rodape: `<button type="button" class="btn ghost" data-fechar>Cancelar</button><button type="button" class="btn perigo" data-confirmar>Recusar criativo</button>`,
  });
  dlg.querySelector('#motivoRecusa').focus();
  dlg.querySelector('[data-confirmar]').addEventListener('click', async () => {
    const motivo = dlg.querySelector('#motivoRecusa').value.trim();
    if (!motivo) return erroNoModal(dlg, 'Escreva o motivo — é o que diz ao cliente o que corrigir.');
    const r = await api(`/admin/criativos/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'reprovado', motivo_reprovacao: motivo }),
    });
    if (!r.ok) return erroNoModal(dlg, (await r.json().catch(() => ({}))).erro || 'Não foi possível recusar.');
    toast('Criativo recusado.');
    fechar();
    aoTerminar();
  });
}

// Upload com retorno dentro do modal (normalizar leva alguns segundos).
function enviarCriativo({ titulo, explicacao, url, aoTerminar }) {
  const { dlg, fechar } = abrirModal({
    titulo,
    corpo: `<p class="u-mt-0">${esc(explicacao)}</p>
      <label class="btn ghost" for="arquivoCriativo">Escolher arquivo<input type="file" id="arquivoCriativo" accept="video/*,image/*" hidden></label>
      <p class="form-msg" data-msg role="status"></p>`,
    rodape: '<button type="button" class="btn ghost" data-fechar>Fechar</button>',
  });
  const input = dlg.querySelector('#arquivoCriativo');
  input.addEventListener('change', async () => {
    const arquivo = input.files[0];
    if (!arquivo) return;
    const msg = dlg.querySelector('[data-msg]');
    msg.textContent = 'Enviando e normalizando... isso leva alguns segundos.';
    msg.className = 'form-msg';
    input.disabled = true;
    const dados = new FormData();
    dados.append('arquivo', arquivo);
    const r = await fetch(`${API_BASE_URL}${url}`, { method: 'POST', body: dados, credentials: 'include' });
    input.disabled = false;
    input.value = '';
    if (!r.ok) return erroNoModal(dlg, (await r.json().catch(() => ({}))).erro || 'Não foi possível enviar.');
    toast('Criativo enviado.');
    fechar();
    aoTerminar();
  });
}

// ---------- plano administrativo: modais (Partes 13-17) ----------
function dataIsoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function abrirPlanoAdministrativo(ctx) {
  const { planos, comercial } = ctx;
  const vendaveis = planos.filter((p) => p.ativo && !p.fundador && NOME_TIER[p.tier] && CICLOS[p.compromisso_meses]);
  const porChave = Object.fromEntries(vendaveis.map((p) => [`${p.tier}:${p.compromisso_meses}`, p]));
  const tiers = Object.keys(NOME_TIER).filter((t) => vendaveis.some((p) => p.tier === t));
  const ciclos = Object.keys(CICLOS)
    .map(Number)
    .filter((m) => vendaveis.some((p) => p.compromisso_meses === m));
  const tierAtual = comercial?.plano && tiers.includes(comercial.plano.tier) ? comercial.plano.tier : tiers[0];
  const cicloAtual =
    comercial?.plano && ciclos.includes(comercial.plano.compromisso_meses)
      ? comercial.plano.compromisso_meses
      : ciclos[0];

  const { dlg, fechar } = abrirModal({
    titulo: comercial ? 'Alterar plano' : 'Conceder plano',
    corpo: `<form id="formPlanoAdm" class="modal-form">
        <div><label>Plano</label><div class="chips-radio">${tiers
          .map(
            (t) =>
              `<label class="chip-check"><input type="radio" name="tier" value="${t}" ${t === tierAtual ? 'checked' : ''}> ${NOME_TIER[t]}</label>`,
          )
          .join('')}</div></div>
        <div><label>Ciclo</label><div class="chips-radio">${ciclos
          .map(
            (m) =>
              `<label class="chip-check"><input type="radio" name="ciclo" value="${m}" ${m === cicloAtual ? 'checked' : ''}> ${CICLOS[m]}</label>`,
          )
          .join('')}</div></div>
        <div><label for="planoAdmValidade">Válido até</label><input type="date" id="planoAdmValidade" name="valido_ate" required></div>
        <div><label>Origem</label><p class="u-m-0"><span class="badge badge-info">Cortesia administrativa</span> <span class="u-dim u-fs-78">sem cobrança, sem Pix, sem fatura — não entra em receita</span></p></div>
        <div><label for="planoAdmObs">Observação <span class="u-dim">(opcional)</span></label><textarea id="planoAdmObs" name="observacao" rows="2" maxlength="500" placeholder="ex.: parceria de lançamento, teste de 30 dias"></textarea></div>
        <p class="form-msg" data-msg role="status"></p>
      </form>`,
    rodape: `<button type="button" class="btn ghost" data-fechar>Cancelar</button><button type="submit" form="formPlanoAdm" class="btn primary">Continuar</button>`,
  });
  const form = dlg.querySelector('#formPlanoAdm');
  const validade = form.valido_ate;
  const hoje = new Date();
  validade.min = dataIsoLocal(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 1));
  let validadeEditada = false;
  const sugerirValidade = () => {
    if (validadeEditada) return;
    const meses = Number(form.querySelector('[name="ciclo"]:checked').value);
    validade.value = dataIsoLocal(new Date(hoje.getFullYear(), hoje.getMonth() + meses, hoje.getDate()));
  };
  validade.addEventListener('input', () => {
    validadeEditada = true;
  });
  form.querySelectorAll('[name="ciclo"]').forEach((r) => r.addEventListener('change', sugerirValidade));
  sugerirValidade();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const tier = form.querySelector('[name="tier"]:checked')?.value;
    const meses = Number(form.querySelector('[name="ciclo"]:checked')?.value);
    const plano = porChave[`${tier}:${meses}`];
    if (!plano) return erroNoModal(dlg, 'Essa combinação de plano e ciclo não está à venda hoje.');
    if (!validade.value || validade.value < validade.min)
      return erroNoModal(dlg, 'Escolha uma validade a partir de amanhã.');
    const escolha = { plano, validoAte: validade.value, observacao: form.observacao.value.trim() };
    fechar();
    confirmarPlanoAdministrativo(ctx, escolha);
  });
}

// Confirmação (Parte 16): plano atual × novo benefício × consequências.
function confirmarPlanoAdministrativo(ctx, { plano, validoAte, observacao }) {
  const { conta, comercial, planoInfo, recarregar } = ctx;
  const [a, m, d] = validoAte.split('-');
  const consequencias = [];
  if (comercial) consequencias.push('O plano atual é encerrado agora. O histórico fica guardado.');
  if (comercial?.origem === 'assinatura' && planoInfo.assinatura_ativa) {
    consequencias.push('A assinatura paga é cancelada no San Checkout — a cobrança recorrente para.');
  }
  consequencias.push('Nenhuma cobrança, diferença de plano ou reembolso é gerado.');
  consequencias.push('O novo plano entra no ar hoje e vale até a data escolhida.');
  const { dlg, fechar } = abrirModal({
    titulo: comercial ? 'Confirmar alteração de plano' : 'Confirmar concessão de plano',
    corpo: `<div class="troca-plano">
        <div class="troca-plano-lado"><span class="u-dim u-fs-78">Plano atual</span><b>${comercial ? esc(nomeDoPlano(comercial.plano) || comercial.id) : 'Nenhum'}</b>${comercial ? `<span class="u-fs-78">${ORIGEM_PLANO[comercial.origem]}</span>` : ''}</div>
        <div class="troca-plano-seta" aria-hidden="true">→</div>
        <div class="troca-plano-lado troca-plano-novo"><span class="u-dim u-fs-78">Novo benefício</span><b>${esc(nomeDoPlano(plano))}</b><span class="u-fs-78">Cortesia administrativa · até ${d}/${m}/${a}</span></div>
      </div>
      ${observacao ? `<p class="u-fs-85"><span class="u-dim">Observação:</span> ${esc(observacao)}</p>` : ''}
      <ul class="lista-consequencias">${consequencias.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <p class="form-msg" data-msg role="status"></p>`,
    rodape: `<button type="button" class="btn ghost" data-fechar>Cancelar</button><button type="button" class="btn primary" data-confirmar>${comercial ? 'Confirmar alteração' : 'Conceder plano'}</button>`,
  });
  const botao = dlg.querySelector('[data-confirmar]');
  botao.addEventListener('click', async () => {
    botao.disabled = true;
    const r = await api(`/admin/anunciantes/${conta.id}/plano-administrativo`, {
      method: 'POST',
      body: JSON.stringify({ plano_id: plano.id, valido_ate: validoAte, observacao }),
    });
    if (!r.ok) {
      botao.disabled = false;
      return erroNoModal(dlg, (await r.json().catch(() => ({}))).erro || 'Não foi possível conceder o plano.');
    }
    toast(comercial ? 'Plano alterado.' : 'Plano concedido.');
    fechar();
    recarregar();
  });
}

function abrirCancelarPlano(ctx) {
  const { conta, comercial, planoInfo, recarregar } = ctx;
  const pago = comercial.origem === 'assinatura';
  const texto = pago
    ? `<p>A assinatura de <b>${esc(nomeDoPlano(comercial.plano) || comercial.id)}</b> é cancelada no San Checkout e a cobrança recorrente para. A cobertura já paga continua valendo até ${comercial.expira ? data(comercial.expira) : 'o fim do ciclo'} — o anúncio não sai do ar hoje. Nenhum reembolso é gerado.</p>`
    : `<p>O benefício <b>${esc(nomeDoPlano(comercial.plano) || comercial.id)}</b> (cortesia administrativa) termina agora. ${planoInfo.historico.length ? 'O histórico fica guardado.' : ''} O comodato desta conta (se houver) não é afetado — é separado do plano comercial e nunca é tocado por este cancelamento.</p>`;
  const { dlg, fechar } = abrirModal({
    titulo: 'Cancelar plano?',
    corpo: `${texto}<p class="form-msg" data-msg role="status"></p>`,
    rodape: `<button type="button" class="btn ghost" data-fechar>Voltar</button><button type="button" class="btn perigo" data-confirmar>Cancelar plano</button>`,
  });
  const botao = dlg.querySelector('[data-confirmar]');
  botao.addEventListener('click', async () => {
    botao.disabled = true;
    const r = await api(
      pago
        ? `/admin/anunciantes/${conta.id}/cancelar-assinatura`
        : `/admin/anunciantes/${conta.id}/plano-administrativo/encerrar`,
      { method: 'POST' },
    );
    if (!r.ok) {
      botao.disabled = false;
      return erroNoModal(dlg, (await r.json().catch(() => ({}))).erro || 'Não foi possível cancelar.');
    }
    toast(pago ? 'Assinatura cancelada. A cobertura paga continua até expirar.' : 'Benefício encerrado.');
    fechar();
    recarregar();
  });
}

// ---------- suspensão (Partes 26-29) ----------
// Canto de baixo, discreto e vermelho. Suspender bloqueia login, painel,
// compra, upload e mexida em criativo; NÃO desliga os pontos físicos da
// conta (a TV autentica pelo aparelho). Os criativos comerciais saem da
// rotação como sempre saíram (gerador ignora conta suspensa).
function desenharContaRodape(el, { conta, recarregar }) {
  el.innerHTML = `
    ${conta.excluido_em ? '<button type="button" class="btn ghost mini" data-restaurar>Restaurar conta</button>' : ''}
    ${
      conta.suspenso
        ? '<button type="button" class="btn ghost mini" data-reativar>Reativar conta</button>'
        : '<button type="button" class="btn-texto-perigo" data-suspender>Suspender conta</button>'
    }`;
  el.querySelector('[data-suspender]')?.addEventListener('click', async () => {
    const ok = await confirmarModal({
      titulo: 'Suspender esta conta?',
      texto: `<p>A conta perderá acesso ao painel e não poderá comprar, subir ou alterar criativos, nem fazer operações comerciais. Os anúncios dela saem da rotação.</p>
        <p class="u-dim u-fs-85">Os pontos físicos da conta continuam funcionando. Nada é apagado — dá pra reativar depois.</p>`,
      botao: 'Suspender conta',
      perigo: true,
    });
    if (ok && (await salvar(`/admin/anunciantes/${conta.id}`, { suspenso: true }))) recarregar();
  });
  el.querySelector('[data-reativar]')?.addEventListener('click', async () => {
    const ok = await confirmarModal({
      titulo: 'Reativar esta conta?',
      texto:
        '<p>A conta volta a entrar no painel e a operar normalmente, com os mesmos dados de antes. O cliente recebe o e-mail de conta liberada.</p>',
      botao: 'Reativar conta',
    });
    if (ok && (await salvar(`/admin/anunciantes/${conta.id}`, { suspenso: false }))) recarregar();
  });
  el.querySelector('[data-restaurar]')?.addEventListener('click', async () => {
    const ok = await confirmarModal({
      titulo: 'Restaurar esta conta?',
      texto: '<p>A conta foi excluída pelo cliente. Restaurar faz ela voltar a conseguir entrar.</p>',
      botao: 'Restaurar conta',
    });
    if (ok && (await salvar(`/admin/anunciantes/${conta.id}`, { excluido_em: null }))) recarregar();
  });
}

// ---------- candidaturas ----------
// Redesenho de 22/09/2026 (encerramento da área "Entrada", pedido do dono):
// candidatura é sempre pra ser PONTO (vendedor não passa mais por aqui desde
// 18/09/2026), então vira cards com a mesma linguagem visual de Rede/Pontos
// — a candidatura É visualmente um "futuro ponto". Sem funil (nova/em
// contato desapareceram da UI, ainda existem no banco só por causa de linha
// antiga): só "Em análise" até o dono decidir Aprovar ou Recusar.
async function renderCandidaturas(el, resto) {
  const [idBruto] = (resto || '').split('/');
  const id = idBruto ? Number(idBruto) : null;
  if (id) return renderCandidaturaDetalhe(el, id);
  return renderCandidaturasGrade(el);
}

function montarCandidaturaCard(c) {
  const nome = c.nome_comercio || c.nome;
  return `<a class="ponto-card ponto-card-link" href="#rede/candidaturas/${c.id}">
    <div class="ponto-card-media">${fotoOuPlaceholder(c.foto_fachada_url, nome)}</div>
    <span class="badge badge-pendente">Em análise</span>
    <h4>${esc(nome)}</h4>
    <p>${esc(c.cidade || '')}${c.uf ? `/${esc(c.uf)}` : ''}${c.segmento ? ` · ${esc(c.segmento)}` : ''}</p>
    <p>${c.fluxo_estimado_mensal ? `${num(c.fluxo_estimado_mensal)} pessoas/mês` : 'Movimento não informado'} · ${data(c.criado_em)}</p>
  </a>`;
}

async function renderCandidaturasGrade(el) {
  const todas = await pegar('/admin/candidaturas');
  // "Em análise" cobre 'nova' e 'em_contato' juntos — o funil de 3 etapas
  // saiu da UI (pedido do dono: candidatura é simples, não CRM), mas o
  // valor antigo continua válido no banco pra não precisar de migration.
  const pendentes = todas.filter((c) => c.status !== 'aprovada' && c.status !== 'recusada');

  el.innerHTML = pendentes.length
    ? caixaCards({
        html: pendentes.map(montarCandidaturaCard).join(''),
        dica: 'Clique numa candidatura pra ver a ficha completa.',
      })
    : '<p class="empty-state">Nenhuma candidatura aguardando análise.</p>';

  if (pendentes.length) turbinarCards(el.querySelector('.tabela-caixa'), '.ponto-card', 'candidatura');
}

async function renderCandidaturaDetalhe(el, id) {
  const todas = await pegar('/admin/candidaturas');
  const c = todas.find((x) => x.id === id);
  if (!c) {
    el.innerHTML = '<p class="form-msg err">Candidatura não encontrada. <a href="#rede/candidaturas">Voltar</a></p>';
    return;
  }
  const nome = c.nome_comercio || c.nome;
  const telefoneWpp = String(c.contato_telefone || '').replace(/\D/g, '');
  // Volta pelo histórico do navegador (ou um bookmark) pode reabrir a ficha
  // de uma candidatura já decidida — os botões só fazem sentido enquanto o
  // status ainda é o de fila (achado do review: sem essa checagem, dava
  // pra "Recusar" uma candidatura já aprovada, com ponto já criado).
  const pendente = c.status !== 'aprovada' && c.status !== 'recusada';
  const badge = pendente
    ? '<span class="badge badge-pendente">Em análise</span>'
    : c.status === 'aprovada'
      ? '<span class="badge badge-ok">Aprovada</span>'
      : '<span class="badge badge-err">Recusada</span>';

  el.innerHTML = `
    <p class="ponto-breadcrumb u-mb-16"><a href="#rede/candidaturas">Rede</a><span class="u-dim"> / </span>${esc(nome)}</p>
    <div class="card u-mw-820">
      <div class="ponto-info-cabecalho">
        <div class="ponto-info-foto">${fotoOuPlaceholder(c.foto_fachada_url, nome)}</div>
        <div class="ponto-info-titulo">
          ${badge}
          <h3 class="u-m-0">${esc(nome)}</h3>
          <p class="u-dim u-m-0">${c.endereco ? `${esc(c.endereco)}${c.bairro ? `, ${esc(c.bairro)}` : ''}, ` : ''}${esc(c.cidade || '')}${c.uf ? `/${esc(c.uf)}` : ''}</p>
          <p class="u-dim u-m-0 u-fs-85">${c.segmento ? esc(c.segmento) : 'Sem segmento informado'}</p>
        </div>
      </div>
      <hr class="ponto-info-sep">
      <div class="field-row">
        <div class="u-col-2"><label>Responsável</label><p class="u-m-0">${esc(c.nome)}${telefoneWpp ? ` · <a href="https://wa.me/55${telefoneWpp}" target="_blank" rel="noopener">${esc(c.contato_telefone)}</a>` : ''}</p></div>
        <div class="u-col-2"><label>E-mail</label><p class="u-m-0">${c.contato_email ? esc(c.contato_email) : '<span class="u-dim">não informado</span>'}</p></div>
      </div>
      <div class="field-row">
        <div class="u-col-2"><label>Movimento estimado/mês</label><p class="u-m-0">${c.fluxo_estimado_mensal ? `${num(c.fluxo_estimado_mensal)} pessoas` : '<span class="u-dim">não informado</span>'}</p></div>
        <div class="u-col-2"><label>Horário de funcionamento</label><p class="u-m-0">${c.horario_semanal ? esc(resumoHorarioSemanal(c.horario_semanal)) : '<span class="u-dim">não informado</span>'}</p></div>
      </div>
      ${c.mensagem ? `<div><label>Observações</label><p class="u-m-0">${esc(c.mensagem)}</p></div>` : ''}
      <div><label>Candidatura enviada em</label><p class="u-m-0">${data(c.criado_em)}</p></div>
      ${
        pendente
          ? `<div class="field-row u-mt-16">
        <button class="btn ghost u-txt-erro" type="button" data-recusar="${c.id}">Recusar</button>
        <button class="btn primary" type="button" data-aprovar="${c.id}">Aprovar ponto</button>
      </div>`
          : ''
      }
      <p class="form-msg" id="candDetalheMsg"></p>
    </div>`;

  if (!pendente) return;
  const msg = document.getElementById('candDetalheMsg');
  el.querySelector('[data-aprovar]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    // Sem "e a Tela 1": desde a rodada final da Rede (22/09/2026) o ponto
    // nasce SEM tela, como "aguardando instalação" — a tela é criada na
    // instalação de verdade (src/conta/modos.js).
    if (!confirm(`Aprovar "${nome}"? O ponto nasce agora com esses dados, aguardando instalação.`)) return;
    btn.disabled = true;
    // Candidatura de conta existente (caminho de hoje): liga o papel direto
    // na conta, cria o ponto. Candidatura antiga sem conta (aposentada
    // 18/09/2026, pode sobrar linha de antes): cai no convite, único jeito
    // de uma pessoa sem conta ainda virar ponto — POST /admin/convites já
    // marca a candidatura como aprovada sozinho (src/convites/routes.js).
    // `c.tipo` preserva o papel real da linha antiga (achado do review:
    // linha de vendedor pré-18/09 caindo aqui não pode nascer com o papel
    // de ponto).
    const r = c.conta_id
      ? await api(`/admin/candidaturas/${c.id}/liberar`, { method: 'POST' })
      : await api('/admin/convites', {
          method: 'POST',
          body: JSON.stringify({
            papeis: [c.tipo === 'vendedor' ? 'vendedor' : 'ponto'],
            candidatura_id: c.id,
            nome_sugerido: c.nome,
            email_sugerido: c.contato_email || null,
          }),
        });
    if (!r.ok) {
      btn.disabled = false;
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'Não foi possível aprovar.';
      msg.className = 'form-msg err';
      return;
    }
    if (!c.conta_id) {
      const { link } = await r.json();
      navigator.clipboard?.writeText(link).catch(() => {});
      prompt(
        'Convite gerado (já copiado) — essa candidatura é antiga, sem conta vinculada. Mande esse link pra pessoa criar a conta e virar ponto:',
        link,
      );
    }
    toast('Candidatura aprovada.');
    RESUMO = await pegar('/admin/resumo');
    pintarContadores();
    irPara('rede/candidaturas');
  });
  el.querySelector('[data-recusar]').addEventListener('click', async () => {
    if (!confirm(`Recusar "${nome}"?`)) return;
    const r = await api(`/admin/candidaturas/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'recusada' }),
    });
    if (!r.ok) {
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'Não foi possível recusar.';
      msg.className = 'form-msg err';
      return;
    }
    toast('Candidatura recusada.');
    RESUMO = await pegar('/admin/resumo');
    pintarContadores();
    irPara('rede/candidaturas');
  });
}

// ---------- convites ----------
// Sem rota na UI desde a reorganização da Entrada (22/09/2026) — mantido
// como código morto autorizado, não referenciado pelo router.
async function _renderConvites(el) {
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
    _renderConvites(el);
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
      _renderConvites(el);
    }),
  );
}

// ---------- custos fixos ----------
// Sem rota na UI desde a rodada Financeiro (22/09/2026, pedido do dono: a
// Mostraí não vira sistema de controle contábil) — mantido como código
// morto autorizado, não referenciado pelo router. `custos_fixos` segue no
// banco, `margemMensal` (GET /admin/resumo) segue calculada com o último
// valor gravado — nenhuma tela deste admin lê `margemMensal` (conferido:
// só `receitaMensal`/`receitaConfirmadaMes` aparecem na Visão geral), então
// não há métrica visível ficando enganosa por custo desatualizado.
async function _renderCustos(el) {
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
        if (campo.dataset.custo !== 'nome' && campo.dataset.custo !== 'observacao') _renderCustos(el);
      }
    }),
  );
  el.querySelectorAll('[data-excluir-custo]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Excluir esse custo?')) return;
      const r = await api(`/admin/custos-fixos/${btn.dataset.excluirCusto}`, { method: 'DELETE' });
      if (r.ok) {
        RESUMO = await pegar('/admin/resumo');
        _renderCustos(el);
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
    _renderCustos(el);
  });
}

// ---------- planos ----------
// O QUE VALE PRO TIER INTEIRO E O QUE VALE SÓ PRA ESTE CICLO.
//
// Uma linha de `planos` é um tier × um ciclo — "Essencial trimestral" é uma
// linha, "Essencial anual" é outra. O admin mostra as quatro como cartões
// separados, e todo campo aparece editável nos quatro. Isso esconde a regra:
//
//   O PRODUTO é do tier. A OFERTA é do ciclo.
//
// O que o cliente COMPRA (nome, subtítulo, tempo de tela, pontos, duração da
// peça, criativos, benefícios, preço cheio) tem que ser igual nos quatro
// ciclos — senão a vitrine promete 90s de tela na aba Mensal e 120s na
// Trimestral, com o mesmo nome e o mesmo card. O que MUDA por ciclo é só como
// aquilo é vendido: o desconto, e os controles de vitrine.
//
// Mexer num campo de tier num cartão só NÃO propaga pros outros três — essa é
// a armadilha. A única coisa que muda em todos de uma vez é o TEXTO de um
// benefício, porque `beneficios` é catálogo compartilhado: editar lá reescreve
// o card dos 12 planos ao mesmo tempo, sem versão nova.
//
// Não dá pra travar isso no banco sem quebrar a versão de plano (RN-27: cada
// edição de contrato publica um id novo, e os quatro ciclos não versionam
// juntos). Então a defesa é ver: o painel compara os quatro e reclama em cima
// quando eles discordam.
const CAMPOS_DO_TIER = {
  nome: 'Nome',
  rotulo: 'Subtítulo',
  valor_mensal_cheio: 'Preço cheio',
  segundos_por_hora: 'Segundos de tela por hora',
  pontos_incluidos: 'Pontos incluídos',
  duracao_maxima_segundos: 'Duração da peça',
  limite_criativos: 'Criativos',
  desconto_comodato_percentual: 'Desconto comodato',
};

// Compara os campos de tier entre os ciclos do mesmo tier. Só planos que ainda
// estão de pé: versão arquivada guarda o contrato antigo de propósito, e
// comparar com ela acusaria divergência em toda edição legítima.
function divergenciasPorTier(planos) {
  const porTier = {};
  for (const p of planos) {
    if (p.arquivado_em || p.fundador) continue;
    porTier[p.tier] = porTier[p.tier] || [];
    porTier[p.tier].push(p);
  }
  const achados = [];
  for (const [tier, linhas] of Object.entries(porTier)) {
    if (linhas.length < 2) continue;
    for (const [campo, rotulo] of Object.entries(CAMPOS_DO_TIER)) {
      const vistos = new Map();
      for (const p of linhas) {
        const v = p[campo] == null ? '' : String(p[campo]);
        vistos.set(v, [...(vistos.get(v) || []), CICLOS[p.compromisso_meses] || p.compromisso_meses]);
      }
      if (vistos.size > 1) achados.push({ tier, rotulo, vistos });
    }
  }
  return achados;
}

function avisoDivergencia(planos) {
  const achados = divergenciasPorTier(planos);
  if (!achados.length) return '';
  return `
    <div class="aviso-rede u-mb-16">
      <b>Os ciclos do mesmo plano estão diferentes entre si.</b>
      O cliente vê o mesmo nome nas quatro abas da vitrine, então o que está abaixo ele lê como promessa
      diferente pro mesmo plano. Acerte nos quatro cartões:
      <ul class="u-mt-6">
        ${achados
          .map(
            (a) =>
              `<li><b>${esc(a.tier)} · ${esc(a.rotulo)}</b>: ` +
              [...a.vistos].map(([v, ciclos]) => `${esc(ciclos.join('/'))} = ${esc(v || '(vazio)')}`).join(' · ') +
              '</li>',
          )
          .join('')}
      </ul>
    </div>`;
}

// ---------- OFERTAS > PREÇOS (reformulação comercial, 22/09/2026) ----------
// 3 produtos fixos (Essencial/Pro/Prime — chave `tier`, não editável aqui:
// características estruturais como pontos/segundos-por-hora/duração/
// criativos são fixas por produto e não entram nesta tela, Parte C/D do
// pedido). Editável: preço-base mensal + um desconto por ciclo + desconto
// comodato — nada além disso (Parte E). Por baixo continua a mesma máquina
// de versão imutável de sempre (`GET/PATCH /admin/ofertas/produtos/:tier`,
// que chama `planosRepo.atualizarProduto` — ver o repositório).
function calcularPreviewCiclo(precoBase, meses, descontoPercentual) {
  const cheio = Math.round(Number(precoBase || 0) * meses * 100) / 100;
  const desconto = Number(descontoPercentual) || 0;
  const final = Math.round(cheio * (1 - desconto / 100) * 100) / 100;
  const economia = Math.round((cheio - final) * 100) / 100;
  const porMes = meses ? Math.round((final / meses) * 100) / 100 : final;
  return { cheio, final, economia, porMes };
}

function montarPreviewCiclo(meses, preview) {
  if (meses === 1) {
    return `<div class="oferta-preco"><b>${fmt(preview.final)}</b>/mês</div>`;
  }
  return `<div class="oferta-preco">
    <div class="price-riscado"><span>${fmt(preview.cheio)}</span>${preview.economia > 0 ? ` <span class="badge-desconto">-${Math.round((preview.economia / preview.cheio) * 100)}%</span>` : ''}</div>
    <b>${fmt(preview.final)}</b>
    ${preview.economia > 0 ? `<div class="price-economia">economiza ${fmt(preview.economia)}</div>` : ''}
    <div class="price-equivalente">equivale a ${fmt(preview.porMes)}/mês</div>
  </div>`;
}

function montarCardProduto(p) {
  return `
    <div class="card oferta-produto" data-produto="${p.tier}">
      <div class="oferta-produto-cabecalho">
        <h3 class="u-m-0">${esc(p.nome)}</h3>
        <label class="oferta-preco-base-campo">
          <span>Preço-base/mês</span>
          <span class="ed-moeda">R$<input type="number" step="0.01" min="0.01" class="oferta-preco-base" value="${p.precoBase}"></span>
        </label>
      </div>
      <div class="oferta-ciclos">
        ${Object.entries(CICLOS)
          .map(([meses, nome]) => {
            const ciclo = p.ciclos[meses];
            const preview = calcularPreviewCiclo(p.precoBase, Number(meses), ciclo?.descontoPercentual);
            return `<div class="oferta-ciclo" data-meses="${meses}">
              <div class="oferta-ciclo-topo">
                <span>${nome}</span>
                <span class="ed-moeda mini"><input type="number" class="mini oferta-desconto" step="0.01" min="0" max="99" value="${ciclo?.descontoPercentual ?? ''}" placeholder="0">%</span>
              </div>
              <div data-preview>${montarPreviewCiclo(Number(meses), preview)}</div>
            </div>`;
          })
          .join('')}
      </div>
      <button class="btn primary block u-mt-12" data-salvar-produto="${p.tier}">Salvar</button>
      <p class="form-msg" data-msg-produto="${p.tier}"></p>
    </div>`;
}

// Card somente-leitura dos 2 produtos de comodato (rodada de integridade,
// 23/09/2026) — sumiram da UI quando Configurações > Comodato saiu. Não têm
// preço nem botão: não se compram, chegam pela modalidade do ponto. Tudo que
// aparece aqui vem do banco (`GET /admin/ofertas/comodato`), nada fixo no
// front.
function montarCardComodato(c) {
  const pontos = c.pontosIncluidos === 1 ? '1 ponto' : `até ${c.pontosIncluidos} pontos`;
  const criativos = `${c.limiteCriativos} criativo${c.limiteCriativos === 1 ? '' : 's'}`;
  const contrapartida =
    c.ajudaCustoMensal > 0
      ? `Dono do ponto recebe ${fmt(c.ajudaCustoMensal)}/mês em dinheiro`
      : 'Dono do ponto abre mão da ajuda de custo em troca da mídia';
  const assinatura = c.permiteAssinar
    ? `Pode ter plano pago junto${c.creditoAssinatura > 0 ? `, com ${fmt(c.creditoAssinatura)}/mês de crédito` : ''}`
    : 'Não assina plano pago enquanto estiver nesta modalidade';
  return `
    <div class="card oferta-produto oferta-comodato-card" data-comodato="${esc(c.planoId)}">
      <h3 class="u-m-0">${esc(c.nome)}</h3>
      <p class="u-dim u-fs-78 u-m-0 u-mt-2">${esc(c.modalidadeNome)}</p>
      <ul class="oferta-comodato-lista">
        <li>${c.segundosPorHora}s por hora · ${pontos}</li>
        <li>Criativo de até ${c.duracaoMaximaSegundos}s · ${criativos}</li>
        <li>Cerca de ${c.horasMes}h de tela/mês · ${num(c.exibicoesMes)} exibições planejadas</li>
        <li>${contrapartida}</li>
        <li>${assinatura}</li>
      </ul>
    </div>`;
}

async function renderPrecos(el) {
  const [produtos, comodato] = await Promise.all([pegar('/admin/ofertas/produtos'), pegar('/admin/ofertas/comodato')]);
  el.innerHTML = `
    <div class="oferta-produtos-grid">${produtos.map(montarCardProduto).join('')}</div>
    <div class="oferta-comodato-secao">
      <div class="field-row u-ai-c u-m-0">
        <h3 class="u-m-0 u-mr-auto">Comodato</h3>
        <span class="badge badge-info">Inicial e Básico não se compram</span>
      </div>
      ${
        comodato.length
          ? `<div class="oferta-produtos-grid u-mt-12">${comodato.map(montarCardComodato).join('')}</div>`
          : '<p class="form-msg err">Nenhum produto de comodato encontrado — confira as modalidades ativas do comodato.</p>'
      }
    </div>`;

  // Recalcula os 4 previews ao vivo, sem esperar salvar — mesma régua da
  // vitrine pública (preço cheio riscado, badge, preço final, economia,
  // equivalente mensal), só que antes de publicar.
  el.querySelectorAll('.oferta-produto').forEach((cartao) => {
    const recalcular = () => {
      const precoBase = Number(cartao.querySelector('.oferta-preco-base').value) || 0;
      cartao.querySelectorAll('.oferta-ciclo').forEach((linha) => {
        const meses = Number(linha.dataset.meses);
        const desconto = linha.querySelector('.oferta-desconto').value;
        const preview = calcularPreviewCiclo(precoBase, meses, desconto);
        linha.querySelector('[data-preview]').innerHTML = montarPreviewCiclo(meses, preview);
      });
    };
    cartao
      .querySelectorAll('.oferta-preco-base, .oferta-desconto')
      .forEach((inp) => inp.addEventListener('input', recalcular));
  });

  el.querySelectorAll('[data-salvar-produto]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tier = btn.dataset.salvarProduto;
      const cartao = el.querySelector(`.oferta-produto[data-produto="${tier}"]`);
      const msg = el.querySelector(`[data-msg-produto="${tier}"]`);
      const descontos = {};
      cartao.querySelectorAll('.oferta-ciclo').forEach((linha) => {
        descontos[linha.dataset.meses] = linha.querySelector('.oferta-desconto').value || null;
      });
      const corpo = {
        precoBase: cartao.querySelector('.oferta-preco-base').value,
        descontos,
      };
      const r = await api(`/admin/ofertas/produtos/${tier}`, { method: 'PATCH', body: JSON.stringify(corpo) });
      if (!r.ok) {
        msg.textContent = (await r.json().catch(() => ({}))).erro || 'Não foi possível salvar.';
        msg.className = 'form-msg err';
        return;
      }
      msg.textContent = 'Salvo.';
      msg.className = 'form-msg ok';
      toast(`${tier === 'essencial' ? 'Essencial' : tier === 'destaque' ? 'Pro' : 'Prime'} atualizado.`);
    });
  });
}

// ---------- OFERTAS > PROMOÇÕES ----------
// Entidade separada do produto (Parte L): uma matriz produto × ciclo, cada
// célula com o próprio desconto. Ciclo sem célula marcada fica de fora —
// não precisa de "desabilitado" explícito (Parte N).
const NOME_TIER = { essencial: 'Essencial', destaque: 'Pro', maximo: 'Prime' };

// Status pra EXIBIÇÃO combina o controle manual (`status`) com o que já dá
// pra calcular pelas datas (Parte F do pedido: "Encerrada (ou calculada
// automaticamente conforme datas)") — sem exigir que o admin lembre de virar
// o status manualmente quando o prazo passa ou quando esgota as vagas.
function statusExibicaoPromocao(promo) {
  const agora = new Date();
  if (promo.status !== 'ativa')
    return {
      rotulo: STATUS_PROMOCAO[promo.status] || promo.status,
      badge: promo.status === 'rascunho' ? 'badge-pendente' : 'badge-err',
    };
  if (promo.compra_fim && new Date(promo.compra_fim) < agora) return { rotulo: 'Encerrada', badge: 'badge-err' };
  if (promo.compra_inicio && new Date(promo.compra_inicio) > agora) return { rotulo: 'Agendada', badge: 'badge-info' };
  if (promo.limite_adesoes != null && promo.adesoes >= promo.limite_adesoes)
    return { rotulo: 'Esgotada', badge: 'badge-err' };
  return { rotulo: 'Ativa', badge: 'badge-ok' };
}

// Listagem em cards (reconstrução visual, 23/09/2026) — "parecer painel
// comercial, não tabela técnica": mídia, status, período, elegibilidade,
// onde aparece, produtos/ciclos e adesões, tudo visível sem abrir a linha.
function montarCardPromocao(promo) {
  const st = statusExibicaoPromocao(promo);
  const itensPorTier = {};
  (promo.itens || []).forEach((i) => {
    itensPorTier[i.tier] = itensPorTier[i.tier] || [];
    itensPorTier[i.tier].push(`${CICLOS[i.compromissoMeses] || i.compromissoMeses} -${i.descontoPercentual}%`);
  });
  const matriz =
    Object.entries(itensPorTier)
      .map(([tier, linhas]) => `${NOME_TIER[tier] || tier}: ${esc(linhas.join(', '))}`)
      .join(' · ') || 'nenhum produto/ciclo';
  const onde =
    [promo.mostrar_home ? 'Home' : null, promo.mostrar_planos ? 'Planos' : null].filter(Boolean).join(' · ') ||
    'nenhuma superfície';
  return `<div class="promo-card" data-promocao="${promo.id}">
    ${promo.imagem_url ? `<img class="promo-card-midia" src="${esc(promo.imagem_url)}" alt="">` : '<div class="promo-card-midia promo-card-midia-vazia"></div>'}
    <div class="promo-card-corpo">
      <div class="field-row u-ai-c u-m-0">
        <b class="u-mr-auto">${esc(promo.titulo_publico)}</b>
        <span class="badge ${st.badge}">${st.rotulo}</span>
      </div>
      <small class="u-dim u-d-block">${promo.selo ? `${esc(promo.selo)} · ` : ''}${esc(promo.nome_interno)}</small>
      <ul class="promo-card-meta">
        <li>${promo.compra_fim ? `Compra até ${data(promo.compra_fim)}` : 'Sem prazo pra comprar'} · condição por ${promo.duracao_beneficio_meses} meses</li>
        <li>${PUBLICO_ELEGIVEL[promo.publico_elegivel] || promo.publico_elegivel} · aparece em: ${onde}</li>
        <li>${matriz}</li>
        <li>${promo.adesoes} ades${promo.adesoes === 1 ? 'ão' : 'ões'}${promo.limite_adesoes != null ? ` de ${promo.limite_adesoes}` : ''}</li>
      </ul>
      <div class="field-row u-mt-10">
        <button class="btn ghost mini" data-editar-promocao="${promo.id}">Editar</button>
        ${promo.status === 'rascunho' ? `<button class="btn ghost mini" data-mudar-status="${promo.id}" data-novo-status="ativa">Ativar</button>` : ''}
        ${promo.status === 'ativa' ? `<button class="btn ghost mini" data-mudar-status="${promo.id}" data-novo-status="encerrada">Encerrar</button>` : ''}
        ${promo.status === 'encerrada' ? `<button class="btn ghost mini" data-mudar-status="${promo.id}" data-novo-status="ativa">Reabrir</button>` : ''}
        ${promo.adesoes === 0 ? `<button class="btn ghost mini u-txt-erro" data-excluir-promocao="${promo.id}">Excluir</button>` : ''}
      </div>
    </div>
  </div>`;
}

// Formulário de criação/edição — mesmo formulário serve os dois casos
// (`promocaoEditando` diferencia POST de PATCH). A matriz produto × ciclo é
// uma checkbox por célula (12 no total: 3 produtos × 4 ciclos); marcada,
// libera o campo de desconto daquela célula.
const FORMATO_MIDIA = {
  horizontal: { nome: 'Banner horizontal', hint: 'Home' },
  quadrado: { nome: 'Quadrado', hint: 'Card' },
  vertical: { nome: 'Vertical mobile', hint: 'Celular' },
};
const PUBLICO_ELEGIVEL = { novos: 'Novos usuários', assinantes: 'Assinantes atuais', todos: 'Todos' };
const STATUS_PROMOCAO = { rascunho: 'Rascunho', ativa: 'Ativa', encerrada: 'Encerrada' };

// Formulário de criação/edição — mesmo formulário serve os dois casos
// (`promo` null/objeto diferencia POST de PATCH). Blocos A-F (reconstrução
// visual, 23/09/2026): Identidade, Mídia, Janela de compra, Condições
// (inclui elegibilidade comercial), Produtos e ciclos, Exibição — status
// tri-state (Rascunho/Ativa/Encerrada) substitui o checkbox solto "ativa",
// e elegibilidade comercial substitui "mostrar pra usuários logados"/
// "mostrar na Visão Geral" (essa última virou automática, sem controle).
function montarFormularioPromocao(promo) {
  const item = (tier, meses) => (promo?.itens || []).find((i) => i.tier === tier && i.compromissoMeses === meses);
  const status = promo?.status || 'rascunho';
  const publicoElegivel = promo?.publico_elegivel || 'todos';
  return `
    <form class="card wide promo-form" id="formPromocao">
      <p class="form-sep-titulo u-mt-0">Identidade</p>
      <div class="field-row">
        <div class="u-col"><label>Nome interno</label><input class="mini" name="nome_interno" required value="${esc(promo?.nome_interno || '')}"></div>
        <div class="u-col"><label>Selo curto (ex.: "Pré-venda")</label><input class="mini" name="selo" value="${esc(promo?.selo || '')}"></div>
      </div>
      <div><label>Título público</label><input name="titulo_publico" required value="${esc(promo?.titulo_publico || '')}"></div>
      <div><label>Subtítulo</label><input name="subtitulo" value="${esc(promo?.subtitulo || '')}"></div>
      <div><label>Descrição</label><textarea name="descricao" rows="2">${esc(promo?.descricao || '')}</textarea></div>

      <p class="form-sep-titulo">Mídia</p>
      <div class="formato-picker">
        ${Object.entries(FORMATO_MIDIA)
          .map(
            ([valor, f]) => `<label class="formato-opcao">
              <input type="radio" name="formato_midia" value="${valor}" ${promo?.formato_midia === valor ? 'checked' : ''}>
              <span class="formato-preview formato-preview-${valor}"></span>
              <span class="formato-nome">${f.nome}</span>
              <span class="u-dim u-fs-70">${f.hint}</span>
            </label>`,
          )
          .join('')}
      </div>
      <div class="u-mt-10">
        <label class="btn ghost mini" for="promoArquivo">Escolher imagem<input type="file" id="promoArquivo" accept="image/*" hidden></label>
        <span class="u-dim u-fs-78 u-d-block u-mt-4" id="promoArquivoNome">${promo?.imagem_url ? 'imagem atual mantida — escolha outra pra trocar' : 'nenhuma imagem'}</span>
        <div class="promo-midia-preview" id="promoMidiaPreview">${promo?.imagem_url ? `<img src="${esc(promo.imagem_url)}" alt="">` : ''}</div>
      </div>

      <p class="form-sep-titulo">Janela de compra</p>
      <div class="field-row">
        <div class="u-col"><label>Começa em (vazio = já vale)</label><input class="mini" type="datetime-local" name="compra_inicio" value="${promo?.compra_inicio ? new Date(promo.compra_inicio).toISOString().slice(0, 16) : ''}"></div>
        <div class="u-col"><label>Termina em (vazio = sem prazo)</label><input class="mini" type="datetime-local" name="compra_fim" value="${promo?.compra_fim ? new Date(promo.compra_fim).toISOString().slice(0, 16) : ''}"></div>
      </div>

      <p class="form-sep-titulo">Condições</p>
      <div class="field-row">
        <div class="u-col"><label title="Quantos meses, a partir da adesão, o desconto vale">Duração do benefício (meses)</label><input class="mini" type="number" min="1" name="duracao_beneficio_meses" value="${promo?.duracao_beneficio_meses ?? 12}" required></div>
        <div class="u-col"><label>Limite de adesões (vazio = sem teto)</label><input class="mini" type="number" min="1" name="limite_adesoes" value="${promo?.limite_adesoes ?? ''}"></div>
      </div>
      <label class="u-d-block u-mt-8">Público elegível</label>
      <div class="chip-check-row">
        ${Object.entries(PUBLICO_ELEGIVEL)
          .map(
            ([valor, nome]) =>
              `<label class="chip-check"><input type="radio" name="publico_elegivel" value="${valor}" ${publicoElegivel === valor ? 'checked' : ''}>${nome}</label>`,
          )
          .join('')}
      </div>

      <p class="form-sep-titulo">Produtos e ciclos</p>
      <div class="rolagem">
      <table class="promo-matriz"><thead><tr><th></th>${Object.values(CICLOS)
        .map((n) => `<th>${n}</th>`)
        .join('')}</tr></thead>
        <tbody>
          ${Object.entries(NOME_TIER)
            .map(
              ([tier, nome]) =>
                `<tr><th>${nome}</th>${Object.keys(CICLOS)
                  .map((meses) => {
                    const atual = item(tier, Number(meses));
                    return `<td><label class="check-row u-m-0"><input type="checkbox" data-item-tier="${tier}" data-item-meses="${meses}" ${atual ? 'checked' : ''}></label>
                    <input type="number" class="mini" data-item-desconto data-item-tier="${tier}" data-item-meses="${meses}" min="0.01" max="100" step="0.01" placeholder="%" value="${atual?.descontoPercentual ?? ''}" ${atual ? '' : 'hidden'}></td>`;
                  })
                  .join('')}</tr>`,
            )
            .join('')}
        </tbody>
      </table>
      </div>

      <p class="form-sep-titulo">Exibição</p>
      <div class="field-row u-flex-wrap">
        <label class="check-row"><input type="checkbox" name="mostrar_home" ${promo?.mostrar_home ? 'checked' : ''}> Mostrar na Home</label>
        <label class="check-row"><input type="checkbox" id="chkMostrarPlanos" name="mostrar_planos" ${promo?.mostrar_planos !== false ? 'checked' : ''}> Mostrar na página de Planos</label>
      </div>
      <p class="u-dim u-fs-74 u-m-0" id="notaMostrarPlanos" hidden>Obrigatório: há produtos/ciclos participando.</p>
      <label class="u-d-block u-mt-10">Status</label>
      <div class="chip-check-row">
        ${Object.entries(STATUS_PROMOCAO)
          .map(
            ([valor, nome]) =>
              `<label class="chip-check"><input type="radio" name="status" value="${valor}" ${status === valor ? 'checked' : ''}>${nome}</label>`,
          )
          .join('')}
      </div>

      <div class="field-row u-mt-14">
        <button class="btn primary" type="submit">${promo ? 'Salvar' : 'Criar promoção'}</button>
        <button class="btn ghost" type="button" id="btnCancelarPromocao">Cancelar</button>
      </div>
      <p class="form-msg" id="msgPromocao"></p>
    </form>`;
}

async function renderPromocoes(el) {
  const promocoes = await pegar('/admin/ofertas/promocoes');
  el.innerHTML = `
    <div class="field-row u-mb-14">
      <h3 class="u-m-0 u-mr-auto">Promoções</h3>
      <button class="btn primary" id="btnNovaPromocao">+ Nova promoção</button>
    </div>
    <div id="formPromocaoWrap" hidden></div>
    ${
      promocoes.length
        ? `<div class="promo-cards-grid">${promocoes.map(montarCardPromocao).join('')}</div>`
        : '<p class="empty-state">Nenhuma promoção criada ainda.</p>'
    }`;

  const wrap = document.getElementById('formPromocaoWrap');
  function abrirFormulario(promo) {
    wrap.innerHTML = montarFormularioPromocao(promo);
    wrap.hidden = false;
    wrap.scrollIntoView({ behavior: 'smooth' });
    const form = document.getElementById('formPromocao');
    let arquivoSelecionado = null;

    const chkMostrarPlanos = document.getElementById('chkMostrarPlanos');
    const notaMostrarPlanos = document.getElementById('notaMostrarPlanos');
    // "Mostrar na página de Planos" é obrigatório quando há produto/ciclo
    // participando (Parte F do pedido) — não faz sentido vender um desconto
    // que não aparece onde o preço é mostrado.
    function sincronizarMostrarPlanos() {
      const temItem = form.querySelectorAll('[data-item-tier][type="checkbox"]:checked').length > 0;
      chkMostrarPlanos.disabled = temItem;
      if (temItem) chkMostrarPlanos.checked = true;
      notaMostrarPlanos.hidden = !temItem;
    }
    form.querySelectorAll('[data-item-tier][type="checkbox"]').forEach((chk) => {
      chk.addEventListener('change', () => {
        const desconto = form.querySelector(
          `[data-item-desconto][data-item-tier="${chk.dataset.itemTier}"][data-item-meses="${chk.dataset.itemMeses}"]`,
        );
        desconto.hidden = !chk.checked;
        if (chk.checked) desconto.focus();
        sincronizarMostrarPlanos();
      });
    });
    sincronizarMostrarPlanos();

    document.getElementById('promoArquivo').addEventListener('change', (e) => {
      const arquivo = e.target.files[0];
      document.getElementById('promoArquivoNome').textContent = arquivo ? arquivo.name : 'nenhuma imagem';
      if (!arquivo) return;
      arquivoSelecionado = arquivo;
      // FileReader (data:), não URL.createObjectURL (blob:) — a CSP só
      // libera data: em img-src, mesma convenção já usada no preview de
      // foto da candidatura de ponto.
      const leitor = new FileReader();
      leitor.onload = () => {
        document.getElementById('promoMidiaPreview').innerHTML = `<img src="${leitor.result}" alt="">`;
      };
      leitor.readAsDataURL(arquivo);
    });

    document.getElementById('btnCancelarPromocao').addEventListener('click', () => {
      wrap.hidden = true;
      wrap.innerHTML = '';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('msgPromocao');
      const fd = new FormData(form);
      const itens = [];
      form.querySelectorAll('[data-item-tier][type="checkbox"]:checked').forEach((chk) => {
        const desconto = form.querySelector(
          `[data-item-desconto][data-item-tier="${chk.dataset.itemTier}"][data-item-meses="${chk.dataset.itemMeses}"]`,
        );
        if (desconto.value) {
          itens.push({
            tier: chk.dataset.itemTier,
            compromissoMeses: Number(chk.dataset.itemMeses),
            descontoPercentual: Number(desconto.value),
          });
        }
      });
      const corpo = {
        nome_interno: fd.get('nome_interno'),
        titulo_publico: fd.get('titulo_publico'),
        subtitulo: fd.get('subtitulo') || null,
        descricao: fd.get('descricao') || null,
        selo: fd.get('selo') || null,
        formato_midia: fd.get('formato_midia') || null,
        compra_inicio: fd.get('compra_inicio') || null,
        compra_fim: fd.get('compra_fim') || null,
        duracao_beneficio_meses: Number(fd.get('duracao_beneficio_meses')),
        limite_adesoes: fd.get('limite_adesoes') || null,
        publico_elegivel: fd.get('publico_elegivel') || 'todos',
        mostrar_home: fd.get('mostrar_home') === 'on',
        mostrar_planos: itens.length > 0 || fd.get('mostrar_planos') === 'on',
        status: fd.get('status') || 'rascunho',
        itens,
      };
      const r = promo
        ? await api(`/admin/ofertas/promocoes/${promo.id}`, { method: 'PATCH', body: JSON.stringify(corpo) })
        : await api('/admin/ofertas/promocoes', { method: 'POST', body: JSON.stringify(corpo) });
      if (!r.ok) {
        msg.textContent = (await r.json().catch(() => ({}))).erro || 'Não foi possível salvar.';
        msg.className = 'form-msg err';
        return;
      }
      const salva = await r.json();
      if (arquivoSelecionado) {
        const dadosImagem = new FormData();
        dadosImagem.append('arquivo', arquivoSelecionado);
        const rImagem = await fetch(`${API_BASE_URL}/admin/ofertas/promocoes/${salva.id}/imagem`, {
          method: 'POST',
          body: dadosImagem,
          credentials: 'include',
        });
        if (!rImagem.ok) {
          toast('Promoção salva, mas a imagem falhou — tente enviar de novo em "Editar".', 'err');
          renderPromocoes(el);
          return;
        }
      }
      toast(promo ? 'Promoção atualizada.' : 'Promoção criada.');
      renderPromocoes(el);
    });
  }

  document.getElementById('btnNovaPromocao').addEventListener('click', () => abrirFormulario(null));
  el.querySelectorAll('[data-editar-promocao]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const promo = promocoes.find((p) => p.id === Number(btn.dataset.editarPromocao));
      abrirFormulario(promo);
    });
  });
  el.querySelectorAll('[data-mudar-status]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const r = await api(`/admin/ofertas/promocoes/${btn.dataset.mudarStatus}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: btn.dataset.novoStatus }),
      });
      if (!r.ok) return toast('Não foi possível atualizar.', 'err');
      toast('Status atualizado.');
      renderPromocoes(el);
    });
  });
  el.querySelectorAll('[data-excluir-promocao]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Excluir esta promoção? Só é possível porque ela ainda não tem nenhuma adesão.')) return;
      const r = await api(`/admin/ofertas/promocoes/${btn.dataset.excluirPromocao}`, { method: 'DELETE' });
      if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'Não foi possível excluir.', 'err');
      toast('Promoção excluída.');
      renderPromocoes(el);
    });
  });
}

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
  // ordem (nome, subtítulo, preço riscado + desconto, preço grande, lista de
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

      <input class="ed-nome" ${contrato('nome', p)} value="${esc(p.nome)}" aria-label="Nome do plano">
      <input class="ed-rotulo" ${vitrine('rotulo', p)} value="${esc(p.rotulo)}" placeholder="Subtítulo (opcional)" aria-label="Subtítulo">

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
    ${avisoDivergencia(planos)}
    <p class="empty-state u-ta-l u-p-0 u-pb-12">
      <b>O produto é do tier; a oferta é do ciclo.</b>
      Nome, subtítulo, preço cheio, tempo de tela, pontos, duração da peça, criativos, benefícios e desconto
      comodato descrevem o mesmo plano nas quatro abas da vitrine — mudar num cartão só faz as abas
      discordarem, então mude nos quatro. Só <b>desconto</b>, <b>vagas</b>, <b>Na vitrine</b> e
      <b>Mais escolhido</b> são deste ciclo e desse cartão.
      O <b>texto</b> de um benefício é a exceção: ele é do catálogo, e editar lá reescreve o card de todos os
      planos ao mesmo tempo.
    </p>
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

// ---------- fila financeira: repasses de pontos ----------
// Rodada Financeiro (22/09/2026): "eu preciso saber QUEM devo pagar no mês"
// — a fila se monta sozinha a partir de `pontos.valor_pago_mensal` (a
// modalidade "troca por tela" do comodato tem esse valor zerado, então ela
// nunca aparece aqui — regra de comodato não foi recriada, só consumida) e
// de `GET /admin/pagamentos-ponto/pendentes` (quem ainda não tem lançamento
// pago pra este mês). Sumiu o formulário manual "Lançar o mês": um clique
// em "Pagar" lança e quita no mesmo passo; quem já tinha lançamento em
// aberto (lançado por fora, ou de um mês anterior) usa "Marcar como pago".
async function renderFilaRepasses(el) {
  const pendentes = await pegar('/admin/pagamentos-ponto/pendentes');
  const mesAtual = new Date().toISOString().slice(0, 7);

  if (!pendentes.length) {
    el.innerHTML = '<p class="empty-state">Nenhum repasse pendente.</p>';
    return;
  }

  el.innerHTML = `<div class="card u-mw-680">
    ${pendentes
      .map(
        (p) => `<div class="linha-financeira" data-linha="${p.pagamento_id || `novo-${p.ponto_id}`}">
        <div>
          <b>${esc(p.ponto_nome)}</b>
          <p class="u-dim u-m-0 u-fs-85">${esc(p.conta_nome || p.responsavel_nome || 'sem responsável cadastrado')} · ${esc(mesAtual)}${p.forma ? ` · ${esc(p.forma)}` : ''}</p>
        </div>
        <div class="u-ta-r">
          <b>${fmt(p.valor_pago_mensal)}</b>
          <button class="btn primary mini u-d-block u-mt-4" data-pagar="${p.ponto_id}" data-pagamento="${p.pagamento_id || ''}">${p.pagamento_id ? 'Marcar como pago' : 'Pagar'}</button>
        </div>
      </div>`,
      )
      .join('<hr class="ponto-info-sep">')}
  </div>`;

  el.querySelectorAll('[data-pagar]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const pagamentoId = btn.dataset.pagamento;
      const r = pagamentoId
        ? await api(`/admin/pagamentos-ponto/${pagamentoId}`, { method: 'PATCH', body: JSON.stringify({ pago: true }) })
        : await api(`/admin/pontos/${btn.dataset.pagar}/pagamentos`, {
            method: 'POST',
            body: JSON.stringify({
              competencia: mesAtual,
              valor: pendentes.find((p) => p.ponto_id === Number(btn.dataset.pagar)).valor_pago_mensal,
              pago_em: new Date().toISOString(),
            }),
          });
      if (!r.ok) {
        btn.disabled = false;
        return toast((await r.json().catch(() => ({}))).erro || 'Não foi possível registrar o pagamento.', 'err');
      }
      toast('Repasse pago.');
      RESUMO = await pegar('/admin/resumo');
      renderFilaRepasses(el);
    }),
  );
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
// Categoria = o que impede concorrente direto na mesma tela (pontos e
// anunciantes com o mesmo categoria_id, ver src/playlist/gerador.js). Grupo
// é só organização desta tela e nunca entra no bloqueio nem aparece pro
// cliente; aliases só ajudam a achar a categoria na busca.
//
// Reconstrução de 23/09/2026 (Parte 38-44): a tela era ~250 linhas com 3
// campos abertos cada, salvando no blur. Agora é lista de leitura + modal de
// edição. Categoria em uso não se exclui — sai do cadastro, vira legado ou é
// MESCLADA numa canônica (quem usava vai junto, ver
// POST /admin/categorias/:id/mesclar e a migration 074).
function estadoCategoria(c) {
  if (c.legado) return { chave: 'legado', nome: 'Legado', classe: 'badge-pendente' };
  if (!c.ativo) return { chave: 'fora', nome: 'Fora do cadastro', classe: 'badge-info' };
  return { chave: 'ativa', nome: 'Ativa', classe: 'badge-ok' };
}

function usoCategoria(c) {
  const partes = [];
  if (c.uso_contas) partes.push(`${c.uso_contas} ${c.uso_contas === 1 ? 'conta' : 'contas'}`);
  if (c.uso_pontos) partes.push(`${c.uso_pontos} ${c.uso_pontos === 1 ? 'ponto' : 'pontos'}`);
  return partes.join(' · ');
}

async function renderCategorias(el) {
  const categorias = await pegar('/admin/categorias');
  const grupos = [...new Set(categorias.map((c) => c.grupo).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'pt-BR'),
  );
  const conta = (chave) => categorias.filter((c) => estadoCategoria(c).chave === chave).length;

  const linhas = categorias
    .map((c) => {
      const estado = estadoCategoria(c);
      const uso = usoCategoria(c);
      const detalhe = c.canonica_nome
        ? `<small class="cat-detalhe">absorvida por ${esc(c.canonica_nome)}</small>`
        : c.aliases?.length
          ? `<small class="cat-detalhe">também: ${esc(c.aliases.join(', '))}</small>`
          : '';
      return `<tr data-filtro="${estado.chave}" class="linha-clicavel" data-editar-cat="${c.id}">
        <td><b>${esc(c.nome)}</b>${detalhe}</td>
        <td>${c.grupo ? esc(c.grupo) : '<span class="u-dim">—</span>'}</td>
        <td>${uso || '<span class="u-dim">sem uso</span>'}</td>
        <td>${c.ativo && !c.legado ? 'Sim' : '<span class="u-dim">Não</span>'}</td>
        <td><span class="badge ${estado.classe}">${estado.nome}</span></td>
        <td class="u-ta-r"><button type="button" class="btn ghost mini" data-editar-cat="${c.id}">Editar</button></td>
      </tr>`;
    })
    .join('');

  el.innerHTML = `
    <div class="field-row u-ai-c u-mb-14">
      <h3 class="u-m-0 u-mr-auto">Categorias</h3>
      <button class="btn primary" type="button" id="btnNovaCategoria">+ Nova categoria</button>
    </div>
    <p class="u-dim u-fs-85 u-mt-0 u-mb-14">${conta('ativa')} ativas no cadastro · ${conta('legado')} legado · ${conta('fora')} fora do cadastro. Categoria é o que impede concorrente direto na mesma tela — o grupo só organiza esta lista.</p>
    ${caixaTabela({
      chips: [
        { valor: '', nome: 'Todas' },
        { valor: 'ativa', nome: 'Ativas' },
        { valor: 'legado', nome: 'Legado' },
        { valor: 'fora', nome: 'Fora do cadastro' },
      ],
      html: `<table class="tabela-categorias"><thead><tr><th data-ord>Categoria</th><th data-ord>Grupo</th><th data-ord>Uso</th><th data-ord>No cadastro</th><th data-ord>Estado</th><th></th></tr></thead><tbody>${linhas}</tbody></table>`,
      dica: 'A busca acha por nome, alias e grupo.',
      // Abre nas ativas: é a lista que o cliente vê no cadastro; legado e
      // fora do cadastro ficam a um clique.
      ativo: 'ativa',
    })}
    <datalist id="listaGrupos">${grupos.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>`;

  turbinarTabela(el.querySelector('.tabela-caixa'));
  const recarregar = () => renderCategorias(el);

  el.querySelectorAll('tr[data-editar-cat]').forEach((tr) =>
    tr.addEventListener('click', () => {
      const c = categorias.find((x) => x.id === Number(tr.dataset.editarCat));
      if (c) abrirCategoria(c, categorias, recarregar);
    }),
  );
  document
    .getElementById('btnNovaCategoria')
    .addEventListener('click', () => abrirCategoria(null, categorias, recarregar));
}

// Modal de criar/editar categoria. `c` null = nova.
function abrirCategoria(c, categorias, aoSalvar) {
  const estado = c ? estadoCategoria(c) : { chave: 'ativa' };
  const uso = c ? usoCategoria(c) : '';
  const emUso = !!(c && (c.uso_contas || c.uso_pontos));
  const avisoCanonica = c?.canonica_nome
    ? `<p class="aviso-info u-mt-0">Absorvida por <b>${esc(c.canonica_nome)}</b> — quem usava esta categoria foi movido pra lá.</p>`
    : '';
  const { dlg, fechar } = abrirModal({
    titulo: c ? 'Editar categoria' : 'Nova categoria',
    corpo: `
      ${avisoCanonica}
      <form id="formCategoria" class="modal-form">
        <div><label for="catNome">Nome</label><input id="catNome" name="nome" required value="${esc(c?.nome || '')}" placeholder="ex.: Tatuagem / Piercing"></div>
        <div><label for="catGrupo">Grupo <span class="u-dim">(só organização interna)</span></label><input id="catGrupo" name="grupo" list="listaGrupos" value="${esc(c?.grupo || '')}" placeholder="ex.: Beleza e estética"></div>
        <div><label for="catAliases">Aliases <span class="u-dim">(termos de busca, separados por vírgula — o cliente nunca vê)</span></label>
          <textarea id="catAliases" name="aliases" rows="2" placeholder="ex.: tattoo, tatuador">${esc((c?.aliases || []).join(', '))}</textarea></div>
        <div class="field-row">
          <div class="u-col"><label>Estado</label>
            <div class="chips-radio">
              <label class="chip-check"><input type="radio" name="estado" value="ativa" ${estado.chave !== 'legado' ? 'checked' : ''}> Normal</label>
              <label class="chip-check"><input type="radio" name="estado" value="legado" ${estado.chave === 'legado' ? 'checked' : ''}> Legado</label>
            </div>
          </div>
          <div class="u-col"><label>Cadastro</label>
            <label class="chip-check"><input type="checkbox" name="ativo" ${!c || (c.ativo && !c.legado) ? 'checked' : ''}> Aparece no cadastro</label>
          </div>
        </div>
        ${c ? `<p class="u-dim u-fs-85 u-m-0">${uso ? `Em uso por ${esc(uso)}.` : 'Nenhuma conta ou ponto usa esta categoria.'}</p>` : ''}
        <p class="form-msg" data-msg role="status"></p>
      </form>`,
    rodape: `
      ${c && !emUso ? '<button type="button" class="btn ghost mini btn-texto-perigo" data-excluir>Excluir</button>' : ''}
      ${c && !c.canonica_id ? '<button type="button" class="btn ghost mini" data-mesclar>Mesclar em outra…</button>' : ''}
      <span class="u-mr-auto"></span>
      <button type="button" class="btn ghost" data-fechar>Cancelar</button>
      <button type="submit" form="formCategoria" class="btn primary">${c ? 'Salvar' : 'Criar categoria'}</button>`,
  });

  const form = dlg.querySelector('#formCategoria');
  const chkAtivo = form.querySelector('[name="ativo"]');
  // Legado nunca aparece no cadastro — o checkbox reflete isso na hora.
  const sincronizarEstado = () => {
    const legado = form.querySelector('[name="estado"]:checked').value === 'legado';
    chkAtivo.disabled = legado;
    if (legado) chkAtivo.checked = false;
  };
  form.querySelectorAll('[name="estado"]').forEach((r) => r.addEventListener('change', sincronizarEstado));
  sincronizarEstado();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const legado = form.querySelector('[name="estado"]:checked').value === 'legado';
    const corpo = {
      nome: form.nome.value.trim(),
      grupo: form.grupo.value.trim(),
      aliases: form.aliases.value
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      legado,
      ativo: !legado && chkAtivo.checked,
    };
    if (!corpo.nome) return erroNoModal(dlg, 'Dê um nome à categoria.');
    const r = await api(c ? `/admin/categorias/${c.id}` : '/admin/categorias', {
      method: c ? 'PATCH' : 'POST',
      body: JSON.stringify(corpo),
    });
    if (!r.ok) return erroNoModal(dlg, (await r.json().catch(() => ({}))).erro || 'Não foi possível salvar.');
    toast(c ? 'Categoria salva.' : 'Categoria criada.');
    fechar();
    aoSalvar();
  });

  dlg.querySelector('[data-excluir]')?.addEventListener('click', async () => {
    fechar();
    const ok = await confirmarModal({
      titulo: 'Excluir categoria?',
      texto: `<p>“${esc(c.nome)}” não é usada por ninguém e vai sumir de vez. Se a ideia é só parar de oferecer, tire do cadastro em vez de excluir.</p>`,
      botao: 'Excluir categoria',
      perigo: true,
    });
    if (!ok) return;
    const r = await api(`/admin/categorias/${c.id}`, { method: 'DELETE' });
    toast(
      r.ok ? 'Categoria excluída.' : (await r.json().catch(() => ({}))).erro || 'Não foi possível excluir.',
      r.ok ? '' : 'err',
    );
    aoSalvar();
  });

  dlg.querySelector('[data-mesclar]')?.addEventListener('click', () => {
    fechar();
    abrirMesclarCategoria(c, categorias, aoSalvar);
  });
}

// Mesclar: escolhe a canônica que fica, mostra o que vai acontecer, confirma.
function abrirMesclarCategoria(c, categorias, aoSalvar) {
  const uso = usoCategoria(c);
  const { dlg, fechar } = abrirModal({
    titulo: `Mesclar “${c.nome}”`,
    corpo: `
      <p class="u-mt-0">Use quando é o mesmo negócio com outro nome. A categoria que fica passa a bloquear os dois como concorrentes.</p>
      <label for="mesclarDestinoBusca">Categoria que fica</label>
      ${categoriaBuscaHtml('mesclarDestino', null, { placeholder: 'Pesquise a categoria que fica...' })}
      <ul class="lista-consequencias">
        <li>${uso ? `Quem usa hoje (${esc(uso)}) passa a usar a categoria escolhida.` : 'Ninguém usa esta categoria hoje — nada a mover.'}</li>
        <li>“${esc(c.nome)}” vira legado e sai do cadastro (nada é apagado).</li>
        <li>O nome “${esc(c.nome)}” vira termo de busca da que fica.</li>
      </ul>
      <p class="form-msg" data-msg role="status"></p>`,
    rodape: `<button type="button" class="btn ghost" data-fechar>Cancelar</button>
      <button type="button" class="btn primary" data-confirmar-mescla disabled>Mesclar</button>`,
  });
  const botao = dlg.querySelector('[data-confirmar-mescla]');
  let destino = null;
  ligarCategoriaBusca(
    'mesclarDestino',
    categorias,
    (escolhida) => {
      destino = escolhida;
      botao.disabled = false;
    },
    { excluirId: c.id },
  );
  dlg.querySelector('#mesclarDestinoBusca').addEventListener('input', () => {
    destino = null;
    botao.disabled = true;
  });
  botao.addEventListener('click', async () => {
    if (!destino) return;
    botao.disabled = true;
    const r = await api(`/admin/categorias/${c.id}/mesclar`, {
      method: 'POST',
      body: JSON.stringify({ destino_id: destino.id }),
    });
    if (!r.ok) {
      botao.disabled = false;
      return erroNoModal(dlg, (await r.json().catch(() => ({}))).erro || 'Não foi possível mesclar.');
    }
    toast(`“${c.nome}” mesclada em “${destino.nome}”.`);
    fechar();
    aoSalvar();
  });
}

// ---------- opções de comodato ----------
async function _renderComodato(el) {
  const [opcoes, planos] = await Promise.all([pegar('/admin/planos-ponto'), pegar('/admin/planos')]);
  const selectPlano = (o) => `<select class="mini u-w-140" data-pp="plano_bonus_id" data-id="${o.id}">
      <option value="">(sem bônus)</option>
      ${planos.map((p) => `<option value="${esc(p.id)}" ${p.id === o.plano_bonus_id ? 'selected' : ''}>${esc(p.nome)} · ${CICLOS[p.compromisso_meses] || p.compromisso_meses + 'x'}</option>`).join('')}
    </select>`;
  el.innerHTML = `
    ${avisoDivergencia(planos)}
    <p class="empty-state u-ta-l u-p-0 u-pb-12">
      <b>O produto é do tier; a oferta é do ciclo.</b>
      Nome, subtítulo, preço cheio, tempo de tela, pontos, duração da peça, criativos, benefícios e desconto
      comodato descrevem o mesmo plano nas quatro abas da vitrine — mudar num cartão só faz as abas
      discordarem, então mude nos quatro. Só <b>desconto</b>, <b>vagas</b>, <b>Na vitrine</b> e
      <b>Mais escolhido</b> são deste ciclo e desse cartão.
      O <b>texto</b> de um benefício é a exceção: ele é do catálogo, e editar lá reescreve o card de todos os
      planos ao mesmo tempo.
    </p>
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
    _renderComodato(el);
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
//
// Redesenho de 22/09/2026 (encerramento de "Entrada"): sem item próprio na
// sidebar — chega pelo aviso da Visão geral (ALERTAS, fila `contato`). Só
// mostra pendente; marcar como respondida some da tela NA HORA, sem
// recarregar nada (o registro continua no banco, `respondida_em` preenchido
// — histórico e LGPD preservados, só não tem mais aba "Respondidas").
async function renderContato(el) {
  const todas = await pegar('/admin/mensagens-contato');
  const pendentes = todas.filter((m) => !m.respondida_em);

  const linha = (m) => `<tr data-msg="${m.id}">
      <td>${data(m.created_at)}</td>
      <td><b>${esc(m.nome)}</b><br><a href="mailto:${esc(m.email)}">${esc(m.email)}</a>${m.telefone ? `<br><span class="u-dim">${esc(m.telefone)}</span>` : ''}</td>
      <td><div class="celula-mensagem">${esc(m.mensagem)}</div></td>
      <td>${m.email_enviado ? '<span class="badge badge-ok">aviso enviado</span>' : '<span class="badge badge-err">aviso não saiu</span>'}</td>
      <td><button class="btn primary mini" type="button" data-respondida="${m.id}">Marcar como respondida</button></td>
    </tr>`;

  const corpo = `<table><thead><tr>
      <th data-ord>Quando</th><th data-ord>Quem</th><th>Mensagem</th><th data-ord>Aviso</th><th></th>
    </tr></thead><tbody>${pendentes.map(linha).join('')}</tbody></table>`;

  el.innerHTML = pendentes.length
    ? caixaTabela({ html: corpo, dica: 'Responda pelo e-mail da pessoa e marque aqui.' })
    : '<p class="empty-state">Nenhuma mensagem aguardando resposta.</p>';

  if (!pendentes.length) return;
  turbinarTabela(el.querySelector('.tabela-caixa'));

  el.querySelectorAll('[data-respondida]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await api(`/admin/mensagens-contato/${btn.dataset.respondida}`, {
        method: 'PATCH',
        body: JSON.stringify({ respondida: true }),
      });
      if (!r.ok) {
        btn.disabled = false;
        return toast('Não deu pra salvar.', 'err');
      }
      RESUMO = await pegar('/admin/resumo');
      pintarContadores();
      renderContato(el);
    });
  });
}

// ---------- trocas de plano ----------
// Seção F, item 17. O pedido pago já entrava em Cobranças e o que falhava já
// virava pendência, mas nenhuma tela respondia "quem trocou, de qual plano
// pra qual, e quando" — e é essa a pergunta que diz se o mecanismo pegou.
// Leitura pura: daqui não se altera pedido nenhum.
// ---------- fila financeira: trocas de plano ----------
// Rodada Financeiro (22/09/2026): só quem abriu o checkout da diferença e
// não pagou ainda. Não tem ação aqui — o pagamento acontece no Checkout do
// próprio cliente (webhook fecha sozinho); a lógica de troca/prorrata não
// foi tocada, só a exibição. Paga ou cancelada é histórico, sem tela fixa —
// mesmos dados, só sem consulta nova.
async function renderFilaTrocas(el) {
  const pendentes = (await pegar('/admin/pedidos-avulsos')).filter((p) => p.status === 'pendente');

  if (!pendentes.length) {
    el.innerHTML = '<p class="empty-state">Nenhuma troca aguardando pagamento.</p>';
    return;
  }

  el.innerHTML = `<div class="card u-mw-680">
    ${pendentes
      .map(
        (p) => `<div class="linha-financeira">
        <div>
          <b>${esc(p.nome_empresa)}</b>
          <p class="u-dim u-m-0 u-fs-85">${p.plano_atual_nome ? esc(p.plano_atual_nome) : 'sem plano'} → ${esc(p.plano_novo_nome)} ${esc(CICLOS[p.plano_novo_meses] || `${p.plano_novo_meses}x`)} · pedida em ${data(p.criado_em)}</p>
        </div>
        <div class="u-ta-r"><b>${fmt(p.valor)}</b><span class="badge badge-pendente u-d-block u-mt-4">esperando pagamento</span></div>
      </div>`,
      )
      .join('<hr class="ponto-info-sep">')}
  </div>`;
}

// A tela de banco de horas (G.3, "Entrega") saiu da navegação do admin
// (21/09/2026, pedido do dono) — só a superfície própria no menu, não a
// função do produto: `src/bancohoras/routes.js` e `repository.js`
// continuam intactos, com a regra "nunca crédito automático em dinheiro"
// documentada lá (repository.js:115), perto do código que a aplica. O
// render antigo (`renderBancoHoras`) foi removido por ficar sem chamador
// nenhum — reconstrua a partir do histórico do git se um dia a tela
// precisar voltar.

// ---------- histórico: cobranças ----------
// Rodada Financeiro (22/09/2026): pura leitura, sem ação nenhuma — a emissão
// manual de nota fiscal (upload de PDF) saiu da UI de propósito (pedido do
// dono: não emitir/anexar nota pela Mostraí; quando existir emissão fiscal
// automática, o resultado dela vira uma FALHA na Visão geral, não uma tarefa
// manual aqui). `PATCH /admin/cobrancas/:id/nota-fiscal` continua no backend,
// sem chamador nesta tela.
async function renderHistoricoCobrancas(el) {
  const cobrancas = await pegar('/admin/cobrancas');
  if (!cobrancas.length) {
    el.innerHTML = '<p class="empty-state">Nenhuma cobrança confirmada ainda.</p>';
    return;
  }
  const total = cobrancas.reduce((t, c) => t + Number(c.valor), 0);

  const corpo = `<table><thead><tr>
      <th data-ord>ID</th><th data-ord>Anunciante</th><th data-ord>Valor</th><th data-ord>Data</th>
    </tr></thead><tbody>
    ${cobrancas
      .map(
        (c) => `<tr>
      <td>${c.id}</td>
      <td><b>${esc(c.nome_empresa)}</b></td>
      <td>${fmt(c.valor)}</td>
      <td>${data(c.criado_em)}</td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card"><span class="kpi-label">Total confirmado</span><b>${fmt(total)}</b><span class="kpi-caption">${cobrancas.length} cobrança(s)</span></div>
    </div>
    ${caixaTabela({ chips: [{ valor: '', nome: 'Todas' }], html: corpo, dica: 'Histórico de pagamentos confirmados.' })}`;

  turbinarTabela(el.querySelector('.tabela-caixa'));
}

// ---------- fila financeira: comissões de vendedor ----------
// Rodada Financeiro (22/09/2026): só o que está em aberto — "normalidade não
// ocupa espaço". Histórico de comissões pagas continua em `comissoes`, sem
// aba pra navegar por ele aqui (pedido explícito: nada de abas de concluídos).
async function renderFilaComissoes(el) {
  const comissoes = (await pegar('/admin/comissoes')).filter((c) => !c.pago_em);

  if (!comissoes.length) {
    el.innerHTML = '<p class="empty-state">Nenhuma comissão pendente.</p>';
    return;
  }

  el.innerHTML = `<div class="card u-mw-680">
    ${comissoes
      .map(
        (c) => `<div class="linha-financeira" data-linha="${c.id}">
        <div>
          <b>${esc(c.vendedor_nome)}</b>
          <p class="u-dim u-m-0 u-fs-85">indicou ${esc(c.nome_empresa)} · venda de ${fmt(c.valor_confirmado)} · ${data(c.criado_em)}</p>
          ${c.chave_pix ? `<p class="u-dim u-m-0 u-fs-72">Pix: ${esc(c.chave_pix)}</p>` : ''}
        </div>
        <div class="u-ta-r">
          <b>${fmt(c.comissao_valor)}</b>
          <button class="btn primary mini u-d-block u-mt-4" data-pago="${c.id}">Marcar como paga</button>
        </div>
      </div>`,
      )
      .join('<hr class="ponto-info-sep">')}
  </div>`;

  el.querySelectorAll('[data-pago]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      if (!(await salvar(`/admin/comissoes/${btn.dataset.pago}`, { pago: true }))) {
        btn.disabled = false;
        return;
      }
      RESUMO = await pegar('/admin/resumo');
      renderFilaComissoes(el);
    }),
  );
}

// ---------- fila financeira: devoluções por arrependimento ----------
// Rodada Financeiro (22/09/2026): só as pendentes. O estorno acontece FORA
// daqui (API do San Checkout não expõe estorno, é o painel do Checkout/
// Asaas) — esta fila existe pra que o pedido não vire um e-mail que alguém
// esquece: é dinheiro que a lei manda devolver, com prazo. Resolvida some
// da fila; o registro (com o comprovante) continua no banco.
async function renderFilaDevolucoes(el) {
  const pendentes = (await pegar('/admin/arrependimentos')).filter((p) => p.status === 'pendente');

  if (!pendentes.length) {
    el.innerHTML = '<p class="empty-state">Nenhuma devolução pendente.</p>';
    return;
  }

  el.innerHTML = `<div class="card u-mw-680">
    ${pendentes
      .map(
        (p) => `<div class="linha-financeira" data-linha="${p.id}">
        <div>
          <b>${esc(p.nome_empresa)}</b>
          <p class="u-dim u-m-0 u-fs-85">${esc(p.contato_email)} · ${esc(p.cpf_cnpj)} · pedida em ${data(p.pedido_em)}</p>
        </div>
        <div class="u-ta-r">
          <b>${fmt(p.valor_a_estornar)}</b>
          <div class="field-row u-mt-4">
            <input class="mini u-w-140" placeholder="id do estorno" data-comp="${p.id}">
            <button class="btn primary mini" data-estornado="${p.id}">Registrar</button>
          </div>
        </div>
      </div>`,
      )
      .join('<hr class="ponto-info-sep">')}
  </div>`;

  el.querySelectorAll('[data-estornado]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const campo = el.querySelector(`[data-comp="${btn.dataset.estornado}"]`);
      btn.disabled = true;
      const r = await api(`/admin/arrependimentos/${btn.dataset.estornado}/estornado`, {
        method: 'POST',
        body: JSON.stringify({ comprovante: campo.value.trim() }),
      });
      if (!r.ok) {
        btn.disabled = false;
        return toast((await r.json().catch(() => ({}))).erro || 'Não deu pra registrar.', 'err');
      }
      toast('Devolução registrada.');
      RESUMO = await pegar('/admin/resumo');
      pintarContadores();
      renderFilaDevolucoes(el);
    }),
  );
}

// ---------- eventos pendentes ----------
async function _renderEventos(el) {
  const eventos = await pegar('/admin/eventos-pendentes');
  // Teste do e-mail aqui dentro de propósito: quando um evento fica pendente
  // por falha de envio, esta é a tela onde você está. O botão faz o login no
  // servidor de SMTP e diz na hora se a senha de app está valendo — sem
  // mandar mensagem nenhuma e sem esperar um pagamento real acontecer.
  const smtp = `<div class="tabela-caixa u-mb-16 u-p-14">
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
      const detalhe = `${esc(r.host || '?')}:${r.porta || '?'} · usuário ${esc(r.usuario || '?')} · senha com ${r.senha_caracteres} caracteres${r.senha_tem_espaco ? ' (TEM ESPAÇO — a senha de app do Gmail tem 16 e os espaços não entram)' : ''}<br>Contato do site sai de <b>${esc(r.remetente || '?')}</b> e cai em <b>${esc(r.destino_contato || '?')}</b> — confira estes dois endereços na caixa (Tudo, Spam e as outras abas, não só Principal) e em Configurações → Filtros e endereços bloqueados.`;
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
        _renderEventos(el);
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
      _renderEventos(el);
    }),
  );
}
