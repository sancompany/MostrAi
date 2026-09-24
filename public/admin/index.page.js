// ---------- base ----------
function api(caminho, opts = {}) {
  return fetch(`${API_BASE_URL}${caminho}`, {
    ...opts,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}

// Erro tipado de leitura — carrega o status HTTP (0 = rede fora do ar/sem
// resposta) pra quem chama decidir o que fazer sem reabrir o corpo.
class ErroApi extends Error {
  constructor(status, corpo) {
    super(corpo?.erro || `erro ${status}`);
    this.status = status;
  }
}

// GET com JSON — achado na investigação do bug "admin abre com mensagem de
// erro, F5 resolve" (Fase 2, 23/09/2026): esta função nunca conferia
// `response.ok`, então uma falha transitória (cold start, blip de rede,
// sessão ainda não propagada) devolvia o CORPO DE ERRO (`{erro:'...'}`) como
// se fosse o dado esperado — o primeiro código que desmontava esse objeto
// (ex.: `const {filas} = RESUMO` em renderResumo) quebrava com TypeError,
// pego pelo catch genérico de `renderModulo`, que é exatamente a mensagem
// que aparecia. F5 "resolvia" só por recarregar do zero, quando a segunda
// tentativa já pegava o backend aquecido — não é conserto, é sorte.
// Retry de uma tentativa só, sem backoff longo, e só pra falha que reenviar
// pode resolver (rede caiu no meio, 5xx de cold start, 429): erro de
// autenticação/validação (401/403/404) nunca tenta de novo, porque reenviar
// não muda o resultado.
async function pegar(caminho, tentativasRestantes = 1) {
  let resposta;
  try {
    resposta = await api(caminho);
  } catch {
    if (tentativasRestantes > 0) {
      await new Promise((r) => setTimeout(r, 700));
      return pegar(caminho, tentativasRestantes - 1);
    }
    throw new ErroApi(0, { erro: 'sem conexão com o servidor' });
  }
  if (!resposta.ok) {
    const corpo = await resposta.json().catch(() => ({}));
    if (tentativasRestantes > 0 && (resposta.status >= 500 || resposta.status === 429)) {
      await new Promise((r) => setTimeout(r, 700));
      return pegar(caminho, tentativasRestantes - 1);
    }
    throw new ErroApi(resposta.status, corpo);
  }
  return resposta.json();
}

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

// ---------- peças visuais compartilhadas (polimento final, 23/09/2026) ----------
// Cada uma nasce aqui uma vez e é chamada de todas as telas — antes cada tela
// montava o próprio vazio, a própria migalha e o próprio seletor, e o admin
// parecia feito por pessoas diferentes.

// Percentual no formato brasileiro ("12,5%"). O dado chega como número JS e
// saía "12.5%" ao lado de "R$ 50,00" — duas convenções na mesma linha. A
// ordenação de turbinarTabela já lê a vírgula como decimal.
function pct(v, casas = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: casas })}%`;
}

// Singular/plural de uma contagem ("1 tela", "2 telas") — o "tela(s)" que
// sobrava em vários avisos lia como texto de sistema, não de produto.
function plural(n, singular, pluralTexto = `${singular}s`) {
  return `${num(n)} ${Number(n) === 1 ? singular : pluralTexto}`;
}

// Estado vazio compacto: o que não existe e, quando ajuda, o que faz aparecer.
function vazio(titulo, detalhe = '') {
  return `<div class="vazio"><b>${titulo}</b>${detalhe ? `<span>${detalhe}</span>` : ''}</div>`;
}

// Migalha de navegação — a mesma nas fichas (Pontos / Nome do ponto) e nas
// rotas internas abertas pela Visão geral (Visão geral / Financeiro).
function migalha(itens) {
  return `<nav class="breadcrumb" aria-label="Você está em">${itens
    .map(
      (item, i) =>
        `${i ? '<span class="sep" aria-hidden="true">/</span>' : ''}${
          item.href
            ? `<a href="${item.href}">${esc(item.rotulo)}</a>`
            : `<span aria-current="page">${esc(item.rotulo)}</span>`
        }`,
    )
    .join('')}</nav>`;
}

// Escolha única entre poucas opções (cobertura, público, status...): um
// controle segmentado só, com UM sinal de seleção (a opção "levantada").
// O rádio continua no DOM, focável e navegável por seta — só não aparece.
function segmentado(nome, opcoes, atual, attrs = '') {
  return `<div class="segmentado" role="radiogroup">${Object.entries(opcoes)
    .map(
      ([valor, rotulo]) =>
        `<label><input type="radio" name="${nome}" value="${valor}" ${valor === atual ? 'checked' : ''} ${attrs}><span>${esc(rotulo)}</span></label>`,
    )
    .join('')}</div>`;
}

// Liga/desliga (checkbox com cara de interruptor) — período definido,
// começar pausada, mostrar na Home... O checkbox de verdade continua lá
// (role="switch"), então teclado e leitor de tela seguem funcionando.
function alternar({ nome = '', id = '', marcado = false, texto, attrs = '' }) {
  return `<label class="alternar"><input type="checkbox" role="switch" ${nome ? `name="${nome}"` : ''} ${id ? `id="${id}"` : ''} ${marcado ? 'checked' : ''} ${attrs}><span class="alternar-trilho" aria-hidden="true"></span><span class="alternar-texto">${texto}</span></label>`;
}

// "há 3 min", "há 8 h", "há 2 dias" — último sinal de tela.
function tempoDesde(v) {
  if (!v) return '';
  const minutos = Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 60000));
  if (minutos < 1) return 'agora';
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 48) return `há ${horas} h`;
  return `há ${Math.round(horas / 24)} dias`;
}

// Foto quadrada ou em pé (logo, foto de celular na vertical) recortada pra
// caber num quadro deitado virava uma letra gigante dominando o card. Essas
// entram inteiras (contain) sobre fundo neutro; foto deitada continua
// preenchendo o quadro. Só dá pra saber a proporção depois de carregar.
function ajustarFotos(raiz) {
  raiz.querySelectorAll('img[data-foto]').forEach((img) => {
    const aplicar = () => {
      if (img.naturalWidth && img.naturalWidth / img.naturalHeight < 1.2) img.classList.add('foto-contida');
    };
    if (img.complete) aplicar();
    else img.addEventListener('load', aplicar, { once: true });
  });
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

// Botão que abre um <input type="file" hidden> (data-escolher-arquivo="id"):
// antes era <label for>, que não recebe foco — o upload ficava fora do
// alcance de quem navega por teclado (polimento final, 23/09/2026). Um
// ouvinte só, delegado, cobre os editores e modais que nascem depois.
document.addEventListener('click', (e) => {
  const gatilho = e.target.closest('[data-escolher-arquivo]');
  if (gatilho) document.getElementById(gatilho.dataset.escolherArquivo)?.click();
});

// Copiar pro clipboard sem quebrar quando a API não existe (origem sem HTTPS,
// navegador antigo): `navigator.clipboard?.writeText(x).then(...)` virava
// `undefined.then` e jogava erro, em vez de cair no aviso de copiar à mão.
function copiarTexto(texto) {
  return navigator.clipboard ? navigator.clipboard.writeText(texto) : Promise.reject(new Error('sem clipboard'));
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
// "8 contas" quando nada está filtrado, "3 de 8 contas" quando está — a
// unidade vem do `data-unidade` da caixa ("conta|contas"); sem ela, só números.
function textoContagem(caixa, visiveis, total) {
  const [um, varios] = (caixa.dataset.unidade || '').split('|');
  const nome = um ? ` ${total === 1 ? um : varios}` : '';
  return visiveis === total ? `${num(total)}${nome}` : `${num(visiveis)} de ${num(total)}${nome}`;
}

function turbinarTabela(caixa) {
  const tabela = caixa.querySelector('table');
  if (!tabela?.tBodies[0]) return;
  const busca = caixa.querySelector('.busca');
  const contagem = caixa.querySelector('[data-contagem]');
  // Linha de detalhe expandida (ocupação, capacidade) não é registro — não
  // conta, não filtra, não ordena.
  const linhas = () => [...tabela.tBodies[0].rows].filter((tr) => !tr.hasAttribute('data-detalhe'));
  // Ordenar/filtrar fecha a linha de detalhe aberta — e o botão que a abriu
  // volta a dizer "fechado" pro leitor de tela (antes ficava aria-expanded
  // "true" apontando pra uma linha que já não existia).
  function fecharDetalhes() {
    tabela.querySelectorAll('tr[data-detalhe]').forEach((tr) => tr.remove());
    tabela.querySelectorAll('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }

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
    fecharDetalhes();
    linhas().forEach((tr) => {
      const casaTermo = !termo || textoBuscavel(tr).includes(termo);
      const casaFiltro = !filtro || (tr.dataset.filtro || '').split(' ').includes(filtro);
      tr.hidden = !(casaTermo && casaFiltro);
      if (!tr.hidden) visiveis += 1;
    });
    if (contagem) contagem.textContent = textoContagem(caixa, visiveis, linhas().length);
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
      // `data-col`: cabeçalho de duas linhas (colunas agrupadas, ex.:
      // Comercial → usado/restante) — a posição do <th> na PRÓPRIA linha
      // não bate com a coluna do corpo, então ele diz qual é.
      const idx = th.dataset.col !== undefined ? Number(th.dataset.col) : [...th.parentNode.children].indexOf(th);
      const desc = th.classList.contains('asc');
      fecharDetalhes();
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
//
// Rodapé só com a contagem (polimento final, 23/09/2026): a frase fixa de
// "clique numa conta pra abrir" ensinava o admin a usar o próprio sistema em
// toda tela — `dica` continua existindo pra quando a frase diz algo que a
// tela não diz sozinha. Um chip só ("Todas") não filtra nada: não aparece.
function chipsFiltro(chips, ativo) {
  if (chips.length < 2) return '';
  const valorAtivo = ativo !== null && chips.some((c) => c.valor === ativo) ? ativo : chips[0]?.valor;
  return `<div class="chips">${chips.map((c) => `<button type="button" class="chip ${c.valor === valorAtivo ? 'active' : ''}" data-filtro="${c.valor}">${esc(c.nome)}</button>`).join('')}</div>`;
}

function caixaTabela({ chips = [], html, dica = '', ativo = null, unidade = '', busca = true }) {
  const filtros = chipsFiltro(chips, ativo);
  return `<div class="tabela-caixa" ${unidade ? `data-unidade="${unidade}"` : ''}>
    ${busca || filtros ? `<div class="tabela-topo">${busca ? '<input class="busca" type="search" placeholder="Buscar..." aria-label="Buscar">' : ''}${filtros}</div>` : ''}
    <div class="rolagem">${html}</div>
    <div class="tabela-pe"><span data-contagem></span>${dica ? `<span>${dica}</span>` : ''}</div>
  </div>`;
}

// Mesma busca + chips + contagem de caixaTabela, pra uma grade de cards.
// Sem a moldura branca em volta (card dentro de card): a barra de filtros
// fica no fundo da página e a grade logo abaixo, como a lista de Contas.
function caixaCards({ chips = [], html, dica = '', ativo = null, unidade = '' }) {
  return `<div class="colecao" ${unidade ? `data-unidade="${unidade}"` : ''}>
    <div class="colecao-topo">
      <input class="busca" type="search" placeholder="Buscar..." aria-label="Buscar">
      ${chipsFiltro(chips, ativo)}
      <span class="colecao-contagem" data-contagem></span>
    </div>
    <div class="pontos-grid">${html}</div>
    ${dica ? `<p class="colecao-dica">${dica}</p>` : ''}
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
    if (contagem) contagem.textContent = textoContagem(caixa, visiveis, itens().length);
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
  // Comissões saiu de aba da Central Financeira (revisão final da Visão
  // geral, 23/09/2026) e, na mesma data, a reconstrução de Contas + Categorias
  // (outro agente, mergeada nesta branch) removeu de vez a lista global de
  // vendedores (`renderVendedores`/módulo `vendedores`) — vendedor/parceiro
  // saiu de toda a UI, o cadastro de comissões da conta agora vive na ficha
  // dela em Contas. Sem alias explícito daqui pra baixo: `#comissoes`,
  // `#vendedores` e `#financeiro/comissoes` caem sozinhos em `visaogeral`
  // (resolverAlvo já degrada assim quando `buscarModulo()` não acha o id —
  // mesmo padrão do alias "custos"). Backend (`GET/PATCH /admin/comissoes`,
  // `/admin/vendedores`) e as tabelas continuam intactos, só sem tela que
  // os chame.
  // "Planos" virou "Ofertas" (reformulação comercial, 22/09/2026) —
  // Arquivados e Benefícios não têm mais aba própria, caem em Preços (mesmo
  // padrão de telas/ocupação acima).
  planos: 'ofertas/precos',
  planosarquivados: 'ofertas/precos',
  beneficios: 'ofertas/precos',
  categorias: 'contas/categorias',
  eventos: 'configuracoes/diagnostico',
  // Financeiro (rodada 22/09/2026): Receitas/Repasses saem de página
  // permanente e viram drill-down oculto — os hashes antigos continuam
  // abrindo a tela certa, só que agora escondida da sidebar. Custos não tem
  // mais tela nenhuma (nem oculta): o hash antigo cai em visaogeral sozinho,
  // igual todo alias que aponta pra um módulo que não existe mais.
  cobrancas: 'financeiro/cobrancas',
  trocas: 'financeiro/trocas',
  arrependimentos: 'financeiro/devolucoes',
  // `pagamentospontos`/`#financeiro/repasses` e `#comodato` saíram em
  // 24/09/2026 (ADR-016): ser ponto gera créditos, não repasse. Os hashes
  // antigos caem na Visão geral, igual todo alias sem módulo.
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
    // explícito: não gastar esta rodada removendo código legado). Inicial e
    // Básico (os produtos de comodato) saíram de vez em 24/09/2026 (ADR-016):
    // ser ponto não é plano, gera créditos.
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
  // funcionando normalmente. Abas Pendentes/Histórico (revisão final da
  // Visão geral, 23/09/2026, seção 5) — resolverAlvo cai na primeira aba
  // (Pendentes) sozinho quando o hash não pede uma aba específica, então o
  // clique vindo da Visão geral já abre onde sempre abriu.
  {
    id: 'mensagens',
    nome: 'Mensagens',
    oculto: true,
    abas: [
      { id: 'pendentes', nome: 'Pendentes', fila: 'contato', render: renderMensagensPendentes },
      { id: 'historico', nome: 'Histórico', render: renderMensagensHistorico },
    ],
  },
  // Financeiro deixou de ser grupo próprio da sidebar (rodada Financeiro,
  // 22/09/2026, pedido do dono: "normalidade não ocupa espaço, pendência
  // aparece") — Receitas/Repasses/Custos como páginas permanentes saíram.
  // O que sobra é drill-down: a Visão geral mostra receita e pendências
  // reais (trocas/devoluções) e cada uma leva pra cá por clique. `oculto`
  // mantém a rota (`#financeiro/trocas` etc.) sem nenhum botão na sidebar —
  // mesmo padrão de "mensagens"/"vendedores". A aba Repasses saiu em
  // 24/09/2026 (ADR-016): não existe repasse mensal ao ponto.
  {
    // Comissões saiu das abas (revisão final da Visão geral, 23/09/2026,
    // pedido do dono: "o conceito de vendedor foi retirado do projeto").
    // `_renderFilaComissoes` e a tabela `comissoes` continuam existindo —
    // vendedor/comissão ainda vive dentro de Contas (rodada Contas,
    // 22/09/2026) e não foi tocado aqui; só a Central Financeira parou de
    // expor um separado pra ela. Ver ALIASES_ANTIGOS pro hash antigo.
    id: 'financeiro',
    nome: 'Financeiro',
    oculto: true,
    abas: [
      { id: 'cobrancas', nome: 'Cobranças', render: renderHistoricoCobrancas },
      { id: 'trocas', nome: 'Trocas', render: renderFilaTrocas },
      { id: 'devolucoes', nome: 'Devoluções', render: renderFilaDevolucoes },
    ],
  },
  // Último item de propósito (rodada Navegação, 22/09/2026): Mídia Mostraí é
  // "ação administrativa especial", não mais um item de "Conteúdo" — fica
  // sozinho no fim da lista, com `destaque: true` pra `montarNav()` desenhar
  // como atalho, separado do resto só por espaçamento (sem título de seção).
  { id: 'midiamostrai', nome: 'Mídia Mostraí', destaque: true, render: renderMidiaMostrai },
];

const buscarModulo = (id) => MODULOS.find((m) => m.id === id);

// Uma frase por tela, só o que a tela não diz sozinha (polimento final,
// 23/09/2026: "abra uma pra ver a ficha" e parecidos saíram — o admin não
// precisa ser ensinado a clicar).
const SUBTITULOS = {
  visaogeral: 'O que precisa de você agora, o resultado do mês e a fotografia da rede.',
  criativos: 'Anúncios enviados pelas contas, esperando aprovação antes de entrar no ar.',
  candidaturas: 'Pedidos de novos pontos feitos pelo painel. Aprovado vira ponto na hora.',
  contato: 'Quem escreveu pelo site — também é o canal de pedido de dados pessoais, com prazo legal pra responder.',
  'mensagens/pendentes': 'Quem escreveu pelo site e espera resposta. Pedido de dados pessoais tem prazo legal.',
  'mensagens/historico': 'Mensagens já respondidas — a resposta em si acontece por fora (e-mail ou telefone).',
  // Chave nova e não "pontos": o alias reverso de "rede/pontos" é
  // "bancohoras" (último dos 4 hashes antigos que caem aqui), então a frase
  // em "pontos" nunca aparecia.
  'rede/pontos': 'Comércios da rede, com status automático pelas telas de cada um.',
  anunciantes: 'Toda conta pode anunciar; quem tem ponto aparece como dono de ponto.',
  ofertas: 'Os 3 planos comerciais — Essencial, Pro e Prime — e as promoções.',
  'ofertas/precos': 'O que o cliente paga em cada plano e ciclo. Salvar publica o valor novo na vitrine.',
  'ofertas/promocoes': 'Condições temporárias por plano e ciclo, exibidas na Home e na página de Planos.',
  categorias: 'Segmentos do cadastro. É a categoria que impede concorrente direto na mesma tela.',
  cobrancas: 'Histórico de pagamentos confirmados.',
  trocas: 'Quem trocou de plano no meio do período e ainda não pagou a diferença.',
  comissoes: 'Comissões de vendedor em aberto. Marcar como paga só registra aqui — o Pix é por fora.',
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
  // Preferência: alias legado revertido (module/aba novo é bem mais recente
  // que a frase em si, ex. "rede/pontos" -> "pontos") e só then a própria
  // chave — sem isso uma aba nova sem alias antigo (ex. "mensagens/
  // pendentes", seção 5 do pedido, 23/09/2026) nunca achava o SUBTITULOS
  // que tem exatamente o nome dela.
  // As duas chaves, nessa ordem: "ofertas/precos" tem alias reverso
  // ("beneficios", aba que não existe mais) sem frase própria — antes o
  // alias achado encerrava a busca e Preços ficava sem subtítulo nenhum.
  return SUBTITULOS[ALIAS_REVERSO[chave]] || SUBTITULOS[chave] || '';
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
  // Saindo da ficha de uma conta: fecha o canal de eventos dela (a ficha abre
  // o próprio ao desenhar — ver ligarEventosDaFicha).
  if (EVENTOS_FICHA && !(moduloId === 'contas' && resto === String(EVENTOS_FICHA.contaId))) fecharEventosDaFicha();
  ABA_ATUAL = { modulo: moduloId, aba: abaId, resto };
  const canonico = [moduloId, abaId, resto].filter(Boolean).join('/');
  const modulo = buscarModulo(moduloId);

  document.querySelectorAll('.nav-item').forEach((b) => {
    const ativo = b.dataset.modulo === moduloId;
    b.classList.toggle('active', ativo);
    if (ativo) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.getElementById('tituloSecao').textContent = modulo.nome;
  // Na ficha de um item (ponto, conta, candidatura) o subtítulo descreve a
  // LISTA, não o item — some, e a migalha da ficha assume o contexto.
  const sub = document.getElementById('subSecao');
  sub.textContent = resto ? '' : subtituloDe(moduloId, abaId);
  sub.hidden = !sub.textContent;
  // Rota interna sem sidebar (Mensagens, Financeiro, Aprovação) só se
  // chega por um card da Visão geral — sem ela na lista de módulos, a
  // migalha é o caminho de volta. Mesma migalha das fichas (polimento final,
  // 23/09/2026: antes era um "← Visão geral" solto, em outro formato).
  const migalhaTopo = document.getElementById('migalhaTopo');
  migalhaTopo.innerHTML = modulo.oculto
    ? migalha([{ rotulo: 'Visão geral', href: '#visaogeral' }, { rotulo: modulo.nome }])
    : '';
  migalhaTopo.hidden = !modulo.oculto;
  if (location.hash !== `#${canonico}`) location.hash = canonico;

  const conteudoEl = document.getElementById('conteudo');
  if (!RESUMO || forcarResumo) {
    try {
      RESUMO = await pegar('/admin/resumo');
    } catch (err) {
      console.error('falha ao carregar /admin/resumo', err);
      conteudoEl.innerHTML = '<p class="form-msg err">Não foi possível carregar esta seção. Clique em Atualizar.</p>';
      return;
    }
    pintarContadores();
  }

  await renderModulo(conteudoEl, modulo, abaId, resto);
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
// `resumoPreCarregado`: quando o teste de sessão no rodapé do arquivo já
// buscou `/admin/resumo` com sucesso, reaproveita — evita duas chamadas
// quase simultâneas ao mesmo endpoint na abertura (a outra fonte da
// intermitência: duas requisições concorrentes bem no momento em que a
// sessão/cold start é mais frágil).
async function mostrarApp(resumoPreCarregado) {
  document.getElementById('gate').hidden = true;
  document.getElementById('app').hidden = false;
  montarNav();
  if (resumoPreCarregado) {
    RESUMO = resumoPreCarregado;
    pintarContadores();
  }
  irPara(location.hash.slice(1) || 'visaogeral', !resumoPreCarregado);
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

// Sessão é cookie httpOnly — testa se já tem uma válida antes de mostrar o
// gate. 401 é o caso normal de quem não está logado — fica no gate, sem
// mensagem nenhuma. Qualquer outra falha (rede, 5xx mesmo depois do retry
// de `pegar`) agora avisa em vez de deixar o gate parado sem explicação.
pegar('/admin/resumo')
  .then((resumo) => mostrarApp(resumo))
  .catch((err) => {
    if (err.status === 401) return;
    const msg = document.getElementById('gateMsg');
    msg.textContent = 'Não foi possível verificar sua sessão agora. Recarregue a página.';
    msg.className = 'form-msg err';
  });

// ---------- visão geral ----------
// Alertas de EXCEÇÃO operacional (rodada de integridade, 23/09/2026): só o
// que foge da rotina e só aparece quando existe. O trabalho pendente normal
// (candidaturas, criativos, mensagens, comissões, trocas,
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
  // "offline" só conta sem_sinal/erro_do_player (src/lib/status-tela.js) —
  // tela fora do horário de funcionamento ou nunca instalada não é falha e
  // não entra aqui (revisão final da Visão geral, 23/09/2026).
  {
    fila: 'offline',
    aba: 'telas',
    acao: 'Ver pontos',
    texto: (n) =>
      n === 1
        ? '<b>1 tela</b> deveria estar operando e não está'
        : `<b>${n} telas</b> deveriam estar operando e não estão`,
    urgente: true,
  },
  {
    fila: 'bancohoras',
    texto: (n) => `<b>${plural(n, 'saldo')}</b> do banco de horas esperando decisão`,
    semLink: 'O banco de horas não tem mais tela no admin — resolver por suporte técnico.',
  },
  {
    fila: 'pontosocupados',
    rolar: 'ocupacaoRede',
    acao: 'Ver ocupação',
    texto: (n) => `<b>${plural(n, 'ponto travado', 'pontos travados')}</b> pra escolha nova por ocupação`,
  },
];

// Resumo operacional FIXO (rodada de integridade, 23/09/2026, pedido do
// dono): mostra o zero de propósito — um contador que some não se distingue
// de um contador que deixou de carregar. Cada linha usa exatamente a mesma
// definição da tela de destino (mesma fila de `/admin/resumo`).
//
// 4 cards, não 8 (revisão final da Visão geral, 23/09/2026, seção 3 do
// pedido): Comissões e Falhas fiscais saíram — "o conceito de vendedor foi
// retirado do projeto", e falha fiscal nunca teve automação nenhuma que
// pudesse falhar de verdade. Trocas/Devoluções deixaram de ser
// cards próprios e viram UM "Financeiro" agregado (financeiro.
// pendenciasFinanceiras, já somado no backend) — clique abre a Central
// Financeira, que aí sim detalha cada fila na aba dela.
const PENDENCIAS_OPERACIONAIS = [
  { nome: 'Candidaturas', aba: 'rede/candidaturas', qtd: (r) => r.filas?.candidaturas },
  { nome: 'Criativos', aba: 'aprovacao', qtd: (r) => r.filas?.criativos },
  { nome: 'Mensagens', aba: 'mensagens', qtd: (r) => r.filas?.contato },
  {
    nome: 'Financeiro',
    aba: 'financeiro/trocas',
    qtd: (r) => r.financeiro?.pendenciasFinanceiras?.qtd,
    valor: (r) => r.financeiro?.pendenciasFinanceiras?.total,
  },
];

// Pendências como UMA unidade (polimento final, 23/09/2026): os alertas de
// exceção (tela que deveria estar no ar, conciliação com problema) entram no
// topo do mesmo painel, em linha, em vez de faixas de largura inteira acima
// das duas colunas; as 4 filas viram 4 blocos iguais logo abaixo.
function painelPendenciasOperacionais(resumo, alertasHtml) {
  const blocos = PENDENCIAS_OPERACIONAIS.map((p) => {
    const qtd = p.qtd(resumo);
    const carregou = typeof qtd === 'number' && Number.isFinite(qtd);
    const estado = !carregou ? 'pend-erro' : qtd === 0 ? 'pend-zero' : p.forte ? 'pend-forte' : 'pend-ativa';
    const valor =
      p.valor && carregou && qtd > 0 ? `<small class="pend-valor">${fmt(p.valor(resumo) || 0)}</small>` : '';
    const conteudo = `<span class="pend-nome">${p.nome}</span><b class="pend-qtd">${carregou ? qtd : '—'}</b>${valor}`;
    return p.aba
      ? `<button type="button" class="pend-bloco ${estado}" data-ir="${p.aba}">${conteudo}</button>`
      : `<div class="pend-bloco ${estado}">${conteudo}</div>`;
  }).join('');
  return `
    <section class="panel">
      <div class="secao-topo"><h3>Pendências operacionais</h3></div>
      ${alertasHtml ? `<div class="alertas-lista">${alertasHtml}</div>` : ''}
      <div class="pend-grade">${blocos}</div>
    </section>`;
}

// `_` (revisão final da Visão geral, 23/09/2026, seção 9 do pedido): a
// seção grande com barra horizontal por status de ponto saiu — virou resumo
// de uma linha (`resumoPontosCompacto`, mais abaixo). Fica marcada como
// morta, não apagada (`paraAba` era só usado por esta chamada).
function _barrasHorizontais(linhas, mapa, paraAba = null) {
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

// Resumo compacto de pontos por status (substitui a barra horizontal acima,
// seção 9 do pedido): "3 pontos · 1 ativo · 2 aguardando instalação · 1
// tela em operação", cada status clicável (mesmo `data-status-clique` de
// sempre, filtra a aba Pontos). `rede.telasAtivas` já é só tela com status
// 'ativo' EM ponto 'em_operacao' (src/admin/routes.js) — é exatamente
// "tela em operação", não "tela cadastrada".
// Plural do status pra contagem ("2 ativos", não "2 ativo").
const PONTO_STATUS_PLURAL = {
  a_instalar: ['aguardando instalação', 'aguardando instalação'],
  em_operacao: ['ativo', 'ativos'],
  em_reparo: ['em reparo', 'em reparo'],
  inativo: ['inativo', 'inativos'],
};

function resumoPontosCompacto(rede) {
  const porStatus = Object.fromEntries((rede.pontosPorStatus || []).map((r) => [r.status, Number(r.qtd)]));
  const total = Object.values(porStatus).reduce((soma, v) => soma + v, 0);
  const partes = Object.keys(PONTO_STATUS)
    .filter((s) => porStatus[s])
    .map((s) => {
      const [um, varios] = PONTO_STATUS_PLURAL[s];
      return `<button type="button" class="status-contagem" data-status-clique="${s}"><i class="ponto-status ${PONTO_STATUS_CLASSE[s]}" aria-hidden="true"></i><b>${porStatus[s]}</b> ${porStatus[s] === 1 ? um : varios}</button>`;
    })
    .join('');
  const telas = Number(rede.telasAtivas) || 0;
  return `
    <section class="panel">
      <div class="secao-topo"><h3>Pontos</h3><span class="secao-nota">${plural(total, 'ponto')} · ${plural(telas, 'tela')} em operação</span></div>
      ${partes ? `<div class="status-resumo">${partes}</div>` : '<p class="u-dim u-fs-85 u-m-0">Nenhum ponto cadastrado ainda.</p>'}
    </section>`;
}

// Conciliação diária (seção 10 do pedido, 23/09/2026): saudável vira uma
// linha discreta DENTRO do card Financeiro (`.resumo`) — "normalidade não
// ocupa espaço". Só sai um alerta de largura cheia (`.alerta`) quando
// atrasada ou com falha real — junto dos outros alertas reais do topo, que
// é o único lugar da tela reservado pra exceção.
function conciliacaoInfo(c) {
  if (!c) {
    // Aviso, não "tudo em dia": a rede de segurança de quem paga nunca rodou.
    return {
      problema: true,
      alerta: `<div class="alerta-linha urgente"><span class="alerta-texto"><b>A conciliação diária nunca rodou.</b>
        É ela que recupera pagamento cujo aviso do Checkout se perdeu — agende <code>npm run conciliar</code> uma vez por dia.</span></div>`,
      resumo: '',
    };
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
  return {
    problema,
    alerta: problema
      ? `<div class="alerta-linha urgente"><span class="alerta-texto"><b>Conciliação ${quando}${atrasada ? ' (atrasada)' : ''}.</b> ${detalhe}</span></div>`
      : '',
    resumo: problema ? '' : `<p class="fin-conciliacao">Conciliação ${quando} · ${detalhe}</p>`,
  };
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

// Bloco Financeiro da Visão geral — card único e compacto (revisão final da
// Visão geral, 23/09/2026, seção 6 do pedido): antes eram 2 cards grandes
// (Receita recorrente + Confirmado no mês) soltos no meio da tela. Agora é
// um só, com as pendências financeiras agregadas (troca com problema +
// devolução — nunca mais comissão, seção 3/4; nem repasse, ADR-016) e a conciliação
// discreta dentro (seção 10) — "normalidade não ocupa espaço".
function painelFinanceiroResumo(financeiro, conciliacaoResumoHtml) {
  const pend = financeiro.pendenciasFinanceiras || { qtd: 0, total: 0 };
  return `
    <section class="panel">
      <div class="secao-topo"><h3>Financeiro</h3><a class="secao-link" href="#financeiro/cobrancas">Abrir</a></div>
      <div class="fin-numeros">
        <div class="fin-numero">
          <span class="fin-rotulo" title="Equivalente mensal das assinaturas pagas ativas">Receita recorrente mensal</span>
          <b>${fmt(financeiro.receitaMensal)}</b>
        </div>
        <div class="fin-numero">
          <span class="fin-rotulo">Recebido no mês</span>
          <b>${fmt(financeiro.receitaConfirmadaMes)}</b>
        </div>
      </div>
      ${
        pend.qtd
          ? `<button type="button" class="fin-pendencia" data-ir="financeiro/trocas"><span><b>${plural(pend.qtd, 'pendência')}</b> · ${fmt(pend.total)}</span><span aria-hidden="true">→</span></button>`
          : '<p class="fin-sem-pendencia">Nenhuma pendência financeira.</p>'
      }
      ${conciliacaoResumoHtml || ''}
    </section>`;
}

// "Rede" — indicadores de negócio compactados num card só (seção 8 do
// pedido): "Anunciantes novos"→"Novas contas" (toda conta pode anunciar
// agora, não só quem tinha esse papel) e "Cadastra e paga"→"Conversão
// cadastro → pagamento" (mais claro sobre o que o número mede). "Alcance"
// virou "Alcance estimado" explicitamente — é estimativa de fluxo, nunca
// contagem real de pessoas.
// Três indicadores em lista (rótulo à esquerda, número à direita) em vez de
// três cards empilhados dentro de outro card — na coluna estreita cada um
// ocupava 130px de altura pra mostrar um número.
function painelIndicadoresRede(rede, financeiro) {
  const conversao = financeiro.percentualPagantes;
  return `
    <section class="panel">
      <div class="secao-topo"><h3>Rede</h3></div>
      <dl class="indicadores">
        <div><dt>Alcance estimado<small>pessoas/mês</small></dt><dd>${num(rede.fluxoMensal)}</dd></div>
        <div><dt>Novas contas<small>últimos 30 dias</small></dt><dd>${num(rede.novosAnunciantes30d)}</dd></div>
        <div><dt>Conversão cadastro → pagamento<small>${conversao === null ? 'nenhuma conta ainda' : `${financeiro.contasPagantes} de ${financeiro.totalContas} contas · sem cortesia e suspensas`}</small></dt><dd>${conversao === null ? '—' : pct(conversao, 0)}</dd></div>
      </dl>
    </section>`;
}

function botaoAlerta(a, qtd) {
  const classe = `alerta-linha ${a.urgente ? 'urgente' : ''}`;
  const texto = `<span class="alerta-texto">${a.texto(qtd)}</span>`;
  if (a.semLink) return `<div class="${classe}" title="${esc(a.semLink)}">${texto}</div>`;
  const acao = `<span class="alerta-acao">${a.acao || 'Abrir'} <span aria-hidden="true">→</span></span>`;
  if (a.rolar) return `<button type="button" class="${classe}" data-rolar="${a.rolar}">${texto}${acao}</button>`;
  return `<button type="button" class="${classe}" data-ir="${a.aba}">${texto}${acao}</button>`;
}

// Layout final (seção 12 do pedido): 2 colunas no desktop (>900px, mesmo
// corte que já colapsa a sidebar — ver admin/index.css), empilha sozinho no
// mobile por ser a ordem natural do HTML sem grid nenhum. Coluna
// operacional: alertas reais de tela, pendências, resumo da rede, ocupação
// (bloco maior, mais denso). Coluna negócio: Financeiro, promoção ativa,
// indicadores — tudo que responde "como vai o dinheiro e o crescimento",
// sem competir por atenção com o que pede ação agora.
async function renderResumo(el) {
  const { filas, financeiro, rede } = RESUMO;
  const pendentes = ALERTAS.filter((a) => (filas[a.fila] || 0) > 0);
  const conciliacao = conciliacaoInfo(RESUMO.conciliacao);

  // Sem exceção nenhuma, os alertas não ocupam espaço — o bloco de pendências
  // já mostra cada fila, zero incluído. A única mensagem fora das colunas é a
  // de rede recém-criada, que diz o que fazer.
  const alertasHtml = conciliacao.alerta + pendentes.map((a) => botaoAlerta(a, filas[a.fila])).join('');
  el.innerHTML = `
    ${
      !pendentes.length && redeVazia(rede)
        ? `<div class="aviso-bloco u-mb-16"><b>Rede em montagem.</b> Nenhum ponto no ar ainda.
             Os primeiros passos: aprovar a primeira candidatura em
             <a href="#rede/candidaturas">Rede › Candidaturas</a>, instalar a tela (a chave fica na ficha do ponto,
             em <a href="#rede/pontos">Rede › Pontos</a>) e pôr a mídia da própria Mostraí no ar em
             <a href="#midiamostrai">Mídia Mostraí</a>. Tela vazia é tela sem prova social.</div>`
        : ''
    }

    <div class="visao-geral-colunas">
      <div class="coluna-operacional pilha">
        ${painelPendenciasOperacionais(RESUMO, alertasHtml)}
        ${resumoPontosCompacto(rede)}
        <section class="panel" id="ocupacaoRedeSecao">
          <div class="secao-topo"><h3>Ocupação da rede</h3><span class="secao-nota">teto comercial 80% · reserva Mostraí 20%</span></div>
          <div id="ocupacaoRede"><p class="carregando">Carregando...</p></div>
        </section>
      </div>
      <aside class="coluna-negocio pilha">
        ${painelFinanceiroResumo(financeiro, conciliacao.resumo)}
        <div id="promocaoAtivaResumo" hidden></div>
        ${painelIndicadoresRede(rede, financeiro)}
      </aside>
    </div>`;

  el.querySelectorAll('[data-ir]').forEach((btn) => btn.addEventListener('click', () => irPara(btn.dataset.ir)));
  el.querySelectorAll('[data-rolar]').forEach((btn) =>
    btn.addEventListener('click', () =>
      document.getElementById(`${btn.dataset.rolar}Secao`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
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
  el.hidden = !vigentes.length;
  if (!vigentes.length) {
    el.innerHTML = '';
    return;
  }
  // Empilhado (título, depois as condições em linhas curtas): na coluna
  // estreita, título + botão lado a lado quebravam o título em 3 linhas.
  el.innerHTML = `<section class="panel">
    <div class="secao-topo"><h3>${vigentes.length > 1 ? 'Promoções ativas' : 'Promoção ativa'}</h3><a class="secao-link" href="#ofertas/promocoes">Abrir</a></div>
    ${vigentes
      .map((p) => {
        const ciclos = [...new Set((p.itens || []).map((i) => CICLOS[i.compromissoMeses] || i.compromissoMeses))];
        return `<div class="promocao-ativa-item">
          <p class="promocao-ativa-titulo"><b>${esc(p.titulo_publico)}</b>${p.selo ? ` <span class="badge badge-neutro">${esc(p.selo)}</span>` : ''}</p>
          <p class="promocao-ativa-meta">${p.compra_fim ? `Até ${data(p.compra_fim)}` : 'Sem prazo pra comprar'} · ${esc(ciclos.join(', ')) || 'nenhum ciclo'}</p>
          <p class="promocao-ativa-meta">${plural(p.duracao_beneficio_meses, 'mês', 'meses')} de desconto · ${p.limite_adesoes != null ? `${p.adesoes} de ${plural(p.limite_adesoes, 'adesão', 'adesões')}` : plural(p.adesoes, 'adesão', 'adesões')}</p>
        </div>`;
      })
      .join('')}
  </section>`;
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
    el.innerHTML = vazio(
      'Nenhum ponto com ocupação comercial ainda.',
      'A ocupação aparece quando uma conta com plano escolhe os pontos dela.',
    );
    return;
  }

  // Colunas agrupadas (polimento final, 23/09/2026): "usado · livre" numa
  // célula só e "(80%)"/"(20%)" repetido em cada cabeçalho viraram dois
  // grupos — Comercial e Mostraí — com os números alinhados à direita. Status
  // e telas desceram pra linha de apoio do nome do ponto: são contexto, não
  // coluna de comparação, e a tabela cabe na coluna sem rolar pro lado.
  const algumTravado = linhas.some((l) => l.bloqueado);
  const corpo = `<table class="tabela-capacidade"><thead>
      <tr>
        <th rowspan="2" data-ord>Ponto</th>
        <th rowspan="2" data-ord class="num">Anunciantes</th>
        <th colspan="2" class="grupo">Comercial <span>teto 80%</span></th>
        <th colspan="2" class="grupo">Mostraí <span>reserva 20%</span></th>
        ${algumTravado ? '<th rowspan="2"><span class="u-sr">Ação</span></th>' : ''}
      </tr>
      <tr>
        <th data-ord data-col="2" class="num" title="Vendido a anunciantes">Usado</th>
        <th data-ord data-col="3" class="num" title="Do teto comercial de 80%, já descontado o que a Mostraí usa acima da reserva">Restante</th>
        <th data-ord data-col="4" class="num" title="Mídia própria e universal">Usado</th>
        <th data-ord data-col="5" class="num" title="Da reserva de 20% — nunca entra como disponível comercial">Livre</th>
      </tr>
    </thead><tbody>
    ${linhas
      .map((l) => {
        const ponto = pontosPorId.get(l.pontoId);
        const cap = capacidadePorPonto.get(l.pontoId);
        const telas = ponto ? plural(ponto.telas || 0, 'tela') : '';
        return `<tr data-filtro="${l.bloqueado ? 'bloqueado' : ''}" data-ponto-id="${l.pontoId}">
      <td data-valor="${esc(l.nome)}"><div class="celula-ponto">
        <a href="#rede/pontos/${l.pontoId}">${esc(l.nome)}</a>
        ${ponto ? `<span class="celula-sub"><i class="ponto-status ${PONTO_STATUS_CLASSE[ponto.status] || ''}" aria-hidden="true"></i>${PONTO_STATUS[ponto.status] || ponto.status} · ${telas}</span>` : ''}
      </div></td>
      <td class="num"><button type="button" class="link-contagem" data-expandir-ocupacao="${l.pontoId}" aria-expanded="false" title="Ver o peso de cada anunciante neste ponto">${l.anunciantes.length}</button></td>
      <td class="num grupo-inicio" title="${Math.round(l.segundosVendidos)}s de 3600s/hora">${cap ? pct(cap.comercialPct) : '—'}${l.bloqueado ? ' <span class="badge badge-err">travado</span>' : ''}</td>
      <td class="num">${cap ? pct(cap.comercialRestantePct) : '—'}</td>
      <td class="num grupo-inicio">${cap ? pct(cap.mostraiPct) : '—'}</td>
      <td class="num">${cap ? pct(cap.reservaRestantePct) : '—'}</td>
      ${algumTravado ? `<td class="u-ta-r">${l.bloqueado ? `<button class="btn ghost mini" data-liberar="${l.pontoId}">Liberar</button>` : ''}</td>` : ''}
    </tr>`;
      })
      .join('')}
  </tbody></table>`;

  el.innerHTML = caixaTabela({
    chips: algumTravado
      ? [
          { valor: '', nome: 'Todos' },
          { valor: 'bloqueado', nome: 'Travados (80%)' },
        ]
      : [],
    html: corpo,
    unidade: 'ponto|pontos',
    busca: linhas.length > 8,
  });
  turbinarTabela(el.querySelector('.tabela-caixa'));
  const colunas = algumTravado ? 7 : 6;

  el.querySelectorAll('[data-expandir-ocupacao]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const linha = btn.closest('tr');
      const existente = linha.nextElementSibling;
      if (existente && existente.dataset.ocupacaoDe === btn.dataset.expandirOcupacao) {
        existente.remove();
        btn.setAttribute('aria-expanded', 'false');
        return;
      }
      const p = porPonto.get(Number(btn.dataset.expandirOcupacao));
      const ordenados = [...p.anunciantes].sort((a, b) => b.segundosPorHora - a.segundosPorHora);
      btn.setAttribute('aria-expanded', 'true');
      linha.insertAdjacentHTML(
        'afterend',
        `<tr data-detalhe data-ocupacao-de="${btn.dataset.expandirOcupacao}"><td class="celula-detalhe" colspan="${colunas}">
      ${
        ordenados.length
          ? `<table class="mini-table"><thead><tr><th>Anunciante</th><th class="num">Peso</th><th class="num">% do ponto</th></tr></thead><tbody>
        ${ordenados
          .map(
            (a) =>
              `<tr><td>${esc(a.nome)}</td><td class="num">${a.segundosPorHora}s/hora</td><td class="num">${pct((a.segundosPorHora / 3600) * 100)}</td></tr>`,
          )
          .join('')}</tbody></table>`
          : '<p class="u-dim u-fs-85 u-m-0">Nenhum anunciante associado.</p>'
      }
    </td></tr>`,
      );
    }),
  );

  el.querySelectorAll('[data-liberar]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const ok = await confirmarModal({
        titulo: 'Liberar este ponto?',
        texto:
          '<p>Ele volta a aparecer pra escolha de pontos de contas novas. Só libera se ainda sobrar folga abaixo dos 80%.</p>',
        botao: 'Liberar ponto',
      });
      if (!ok) return;
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
          (a) => `<button type="button" class="alerta-linha ${a.urgente ? 'urgente' : ''}" data-ir="${a.aba}">
        <span class="alerta-texto">${a.texto(filas[a.fila])}</span>
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

  // Card deitado (miniatura 9:16 + dados + ações), o mesmo dos criativos na
  // ficha da conta: a peça aparece INTEIRA (contain, fundo escuro como a TV)
  // — o recorte `cover` de antes escondia justamente a borda que o operador
  // precisa conferir antes de aprovar. Ações de card são secundárias; Reprovar
  // tem a cor de ação destrutiva.
  el.innerHTML = `
    <div id="ajusteMidiaWrap" hidden></div>
    ${
      criativos.length
        ? `<div class="criativos-grade">${criativos
            .map((c) => {
              const ehVideo = !ehImagemArquivo(c.arquivo_original_url);
              const nomeConta = nomePor[c.anunciante_id] || 'Conta sem nome';
              return `<article class="criativo-item">
        <div class="criativo-item-midia">${montarPreviewAsset({ original: c.arquivo_original_url, normalizado: c.arquivo_normalizado_url, thumb: c.thumbnail_url })}</div>
        <div class="criativo-item-corpo">
          <div class="item-topo"><h4>${esc(nomeMidiaPor[c.id] || nomeConta)}</h4><span class="badge badge-pendente">Em análise</span></div>
          <p class="item-meta">${nomeMidiaPor[c.id] ? `${esc(nomeConta)} · ` : ''}${ehVideo ? 'Vídeo' : 'Imagem'}${c.duracao_segundos ? ` · ${c.duracao_segundos}s` : ''} · enviado ${data(c.created_at)}</p>
          ${c.substitui_criativo_id ? '<p class="item-nota">Substitui a peça que está no ar — ela sai quando esta for aprovada.</p>' : ''}
          <div class="acoes item-acoes">
            <button class="btn ghost mini" data-acao="aprovado" data-id="${c.id}">Aprovar</button>
            <button class="btn ghost mini" data-ajustar="${c.id}">Ajustar mídia</button>
            <button class="btn perigo-sutil mini" data-acao="reprovado" data-id="${c.id}">Reprovar</button>
          </div>
        </div>
      </article>`;
            })
            .join('')}</div>`
        : vazio(
            'Nenhum criativo aguardando aprovação.',
            'Peça enviada por uma conta aparece aqui antes de entrar no ar.',
          )
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
    <section class="panel u-mb-16">
      <div class="secao-topo">
        <h3>Ajustar mídia</h3>
        <div class="secao-acoes"><button class="botao-fechar" type="button" id="btnFecharAjuste" aria-label="Fechar">×</button></div>
      </div>
      <div class="ajuste-midia">
        <div class="ajuste-midia-preview" id="previewAjuste">
          ${montarPreviewAsset({ original: criativo.arquivo_original_url, normalizado: criativo.arquivo_normalizado_url, thumb: criativo.thumbnail_url })}
        </div>
        <div class="ajuste-midia-dados">
          <dl class="dados">
            <div><dt>Conta</dt><dd>${esc(nomeConta || 'Conta sem nome')}</dd></div>
            <div><dt>Formato</dt><dd>${ehVideo ? 'Vídeo' : 'Imagem'}${criativo.duracao_segundos ? ` · ${criativo.duracao_segundos}s` : ''}</dd></div>
            <div><dt>Enviado em</dt><dd>${data(criativo.created_at)}</dd></div>
          </dl>
          <div class="acoes">
            ${url ? `<a class="btn ghost mini" href="${esc(url)}" download target="_blank" rel="noopener">Baixar arquivo</a>` : ''}
            <button type="button" class="btn ghost mini" data-escolher-arquivo="arquivoSubstituto">Substituir arquivo</button><input type="file" id="arquivoSubstituto" accept="video/*,image/*" hidden>
            <button class="btn primary mini" type="button" id="btnAprovarAjuste">Aprovar</button>
          </div>
          <p class="form-msg" id="msgAjuste" role="status"></p>
        </div>
      </div>
    </section>`;
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
// Card deitado (polimento final, 23/09/2026): a miniatura vertical dominava
// um card estreito e as ações quebravam linha ("Retirar do ar" caía
// sozinho). Agora: miniatura 9:16 fixa à esquerda, nome como título com o
// estado no mesmo cabeçalho, frequência/período como metadado e as ações
// numa linha — Retirar do ar com a cor de ação destrutiva.
function montarCardMidia(m) {
  const sit = m.situacaoDerivada;
  const cobertura = m.cobertura_tipo === 'rede' ? 'Toda a rede' : plural(m.qtd_pontos, 'ponto');
  const periodo =
    m.periodo_inicio || m.periodo_fim
      ? `${m.periodo_inicio ? data(m.periodo_inicio) : 'Desde já'} até ${m.periodo_fim ? data(m.periodo_fim) : 'sem fim'}`
      : 'Sempre no ar';
  return `<article class="criativo-item mm-item">
    <div class="criativo-item-midia">${montarPreviewAsset({ original: m.arquivo_original_url, normalizado: m.arquivo_normalizado_url, thumb: m.thumbnail_url, classe: 'mm-card-asset' })}</div>
    <div class="criativo-item-corpo">
      <div class="item-topo"><h4>${esc(m.nome_interno)}</h4><span class="badge ${SITUACAO_MIDIA_BADGE[sit] || ''}">${SITUACAO_MIDIA_ROTULO[sit] || sit}</span></div>
      <p class="item-meta">${m.duracao_segundos ? `${m.duracao_segundos}s` : '—'} · ${m.frequencia_hora}×/hora · ${cobertura}</p>
      <p class="item-meta">${periodo}</p>
      ${m.aprovacao_status !== 'aprovado' ? '<p class="item-nota">Arquivo em análise — entra no ar depois de aprovado.</p>' : ''}
      <div class="acoes item-acoes">
        <button class="btn ghost mini" data-editar-midia="${m.id}">Editar</button>
        ${
          sit === 'pausada'
            ? `<button class="btn ghost mini" data-retomar-midia="${m.id}">Retomar</button>`
            : sit !== 'encerrada'
              ? `<button class="btn ghost mini" data-pausar-midia="${m.id}">Pausar</button>`
              : ''
        }
        ${sit !== 'encerrada' ? `<button class="btn perigo-sutil mini" data-encerrar-midia="${m.id}">Retirar do ar</button>` : ''}
      </div>
    </div>
  </article>`;
}

// Tabela de capacidade da rede (Parte 16/17) — mesmo padrão de
// renderOcupacaoRede (expandir por clique mostra quem consome ali), só que
// separando comercial de institucional em vez de uma coluna só (Parte 9:
// "não quero só uma porcentagem abstrata").
function montarTabelaCapacidade(el, capacidade) {
  if (!capacidade.length) {
    el.innerHTML = vazio(
      'Nenhum ponto em operação ainda.',
      'A capacidade aparece quando o primeiro ponto tiver tela ativa.',
    );
    return;
  }
  // Régua 80/20 (rodada de integridade, 23/09/2026): sem coluna "Livre" —
  // ela somava a reserva Mostraí com o comercial ainda não vendido e dava a
  // entender que a mídia própria podia ocupar ~97% da hora. Mesmos números
  // e o mesmo desenho da tabela "Ocupação da rede" da Visão geral
  // (src/lib/capacidade.js): dois grupos, números à direita.
  el.innerHTML = `<div class="tabela-caixa"><div class="rolagem"><table class="tabela-capacidade"><thead>
      <tr>
        <th rowspan="2">Ponto</th>
        <th colspan="2" class="grupo">Comercial <span>teto 80%</span></th>
        <th colspan="2" class="grupo">Mostraí <span>reserva 20%</span></th>
        <th rowspan="2" class="num">Total</th>
        <th rowspan="2" class="num">Mídias</th>
      </tr>
      <tr>
        <th class="num" title="Vendido a anunciantes">Usado</th>
        <th class="num" title="Do teto comercial de 80%">Restante</th>
        <th class="num" title="Mídia própria e universal">Usado</th>
        <th class="num" title="Da reserva de 20%">Livre</th>
      </tr>
    </thead><tbody>
    ${capacidade
      .map(
        (p) => `<tr>
      <td><div class="celula-ponto">
        <a href="#rede/pontos/${p.pontoId}">${esc(p.pontoNome)}</a>
        <span class="celula-sub"><i class="ponto-status ${PONTO_STATUS_CLASSE[p.status] || ''}" aria-hidden="true"></i>${PONTO_STATUS[p.status] || p.status}</span>
      </div></td>
      <td class="num grupo-inicio">${pct(p.comercialPct)}</td>
      <td class="num">${pct(p.comercialRestantePct)}</td>
      <td class="num grupo-inicio">${pct(p.mostraiPct)}${p.mostraiAcimaDaReservaPct > 0 ? `<span class="celula-alerta" title="${pct(p.mostraiAcimaDaReservaPct)} ocupando capacidade comercial ainda não vendida">acima da reserva</span>` : ''}</td>
      <td class="num">${pct(p.reservaRestantePct)}</td>
      <td class="num"><b>${pct(p.totalPct)}</b></td>
      <td class="num"><button type="button" class="link-contagem" data-expandir-capacidade="${p.pontoId}" aria-expanded="false" title="Ver as mídias próprias neste ponto">${p.qtdMidiasProprias}</button></td>
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
        btn.setAttribute('aria-expanded', 'false');
        return;
      }
      const midiasNoPonto = await pegar(`/admin/capacidade-rede/${btn.dataset.expandirCapacidade}/midias`);
      btn.setAttribute('aria-expanded', 'true');
      linha.insertAdjacentHTML(
        'afterend',
        `<tr data-detalhe data-capacidade-de="${btn.dataset.expandirCapacidade}"><td class="celula-detalhe" colspan="7">
      ${
        midiasNoPonto.length
          ? `<table class="mini-table"><thead><tr><th>Mídia</th><th class="num">% do ponto</th></tr></thead><tbody>
        ${midiasNoPonto.map((m) => `<tr><td>${esc(m.nomeInterno)}</td><td class="num">${pct(m.pct)}</td></tr>`).join('')}
      </tbody></table>`
          : '<p class="u-dim u-fs-85 u-m-0">Nenhuma mídia própria nesse ponto.</p>'
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
//
// Seleção com UM padrão (polimento final, 23/09/2026): antes o card
// selecionado tinha borda + linha laranja (o checkbox esticado pelo `.card
// input` global) + checkbox + um check redondo flutuando por cima da borda.
// Agora o checkbox fica escondido (continua focável) e a seleção é a borda
// da marca com o indicador redondo DENTRO do card. Card deitado e baixo: a
// miniatura (ou o placeholder oficial) não ocupa mais meia tela.
function montarPontoPickerCard(p, marcado) {
  const segmento = p.categoriaNome || p.categoriaLivre || p.segmento;
  const busca = `${p.pontoNome} ${p.cidade || ''} ${p.uf || ''} ${segmento || ''} ${p.endereco || ''}`.toLowerCase();
  return `<label class="selecionavel mm-picker-card" data-busca="${esc(busca)}">
    <input type="checkbox" class="mm-picker-input" value="${p.pontoId}" ${marcado ? 'checked' : ''}>
    <span class="selecionavel-check" aria-hidden="true"></span>
    <span class="mm-picker-foto">${fotoOuPlaceholder(p.fotoUrl, p.pontoNome)}</span>
    <span class="mm-picker-corpo">
      <span class="mm-picker-nome">${esc(p.pontoNome)}</span>
      <span class="mm-picker-meta"><i class="ponto-status ${PONTO_STATUS_CLASSE[p.status] || ''}" aria-hidden="true"></i>${PONTO_STATUS[p.status] || p.status}${p.cidade ? ` · ${esc(p.cidade)}${p.uf ? `/${esc(p.uf)}` : ''}` : ''}${segmento ? ` · ${esc(segmento)}` : ''}</span>
      <span class="mm-picker-stats">
        <span>Comercial <b>${pct(p.comercialPct)}</b></span>
        <span>Mostraí <b>${pct(p.mostraiPct)}</b></span>
        <span>Reserva livre <b>${pct(p.reservaRestantePct)}</b></span>
      </span>
    </span>
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
  // Preview vazio É o botão de escolher arquivo: o lugar onde a peça vai
  // aparecer já diz o que falta e o formato esperado. <button>, não <label>,
  // pra receber foco pelo teclado.
  const PREVIEW_VAZIO = `<button type="button" class="mm-preview-vazio" data-escolher-arquivo="mmArquivo">
      <b>Escolher arquivo</b><span>vídeo ou imagem em pé (9:16)</span>
    </button>`;
  const previewInicial = midia
    ? montarPreviewAsset({
        original: midia.arquivo_original_url,
        normalizado: midia.arquivo_normalizado_url,
        thumb: midia.thumbnail_url,
        classe: 'mm-card-asset',
      })
    : PREVIEW_VAZIO;
  const infoInicial = midia
    ? `${ehImagemArquivo(midia.arquivo_original_url) ? 'Imagem' : 'Vídeo'}${midia.duracao_segundos ? ` · ${midia.duracao_segundos}s` : ''}${midia.aprovacao_status !== 'aprovado' ? ' · em análise' : ''}`
    : '';
  const capacidadeVazia = midia
    ? 'Ajuste frequência e cobertura pra ver o impacto em cada ponto.'
    : 'Escolha o arquivo pra ver o impacto em cada ponto.';

  // Configuração ~62% / preview ~38% (polimento final, 23/09/2026): a coluna
  // de preview tinha largura fixa estreita e o formulário se esticava. Um
  // "×" no topo fecha (atalho), "Cancelar" no rodapé é a saída do formulário
  // — antes eram dois botões iguais, "Fechar" e "Cancelar", fazendo a mesma
  // coisa. Liga/desliga e cobertura usam os controles compartilhados.
  wrap.innerHTML = `
    <section class="panel mm-editor">
      <div class="secao-topo">
        <h3>${midia ? 'Editar mídia' : 'Nova mídia própria'}</h3>
        ${midia ? `<span class="secao-nota">${esc(midia.nome_interno)}</span>` : ''}
        <div class="secao-acoes"><button class="botao-fechar" type="button" id="btnFecharEditorMidia" aria-label="Fechar">×</button></div>
      </div>
      <form id="formMidia" class="painel-form">
        <div class="mm-editor-grid">
          <div class="mm-editor-col">
            <fieldset class="form-bloco">
              <legend>Conteúdo</legend>
              <div class="campo-grupo"><label for="mmNome">Nome interno</label><input id="mmNome" name="nome_interno" required value="${esc(midia?.nome_interno || '')}" placeholder="ex.: Institucional — seja um ponto"></div>
            </fieldset>

            <fieldset class="form-bloco">
              <legend>Veiculação</legend>
              <div class="campo-grupo campo-curto"><label for="mmFreq">Vezes por hora</label><input id="mmFreq" type="number" min="1" max="60" name="frequencia_hora" required value="${midia?.frequencia_hora || 1}"></div>
              <div class="alternar-lista">
                ${alternar({ id: 'mmAgendada', marcado: temPeriodo, texto: 'Período definido <span class="alternar-ajuda">fora dele, a mídia não entra no ar</span>' })}
                <div class="campos" id="mmPeriodoCampos" ${temPeriodo ? '' : 'hidden'}>
                  <div class="campo-grupo"><label for="mmInicio">Começa em</label><input id="mmInicio" type="datetime-local" name="periodo_inicio" value="${isoLocal(midia?.periodo_inicio)}"></div>
                  <div class="campo-grupo"><label for="mmFim">Termina em</label><input id="mmFim" type="datetime-local" name="periodo_fim" value="${isoLocal(midia?.periodo_fim)}"></div>
                </div>
                ${!midia ? alternar({ nome: 'situacao_pausada', texto: 'Começar pausada' }) : ''}
              </div>
            </fieldset>

            <fieldset class="form-bloco">
              <legend>Cobertura</legend>
              <div class="campo-linha">
                ${segmentado('cobertura_tipo', { rede: 'Toda a rede', pontos: 'Pontos específicos' }, midia?.cobertura_tipo === 'pontos' ? 'pontos' : 'rede')}
                <span class="campo-ajuda">Toda a rede inclui pontos novos automaticamente.</span>
              </div>
              <div id="mmPontosWrap" ${midia?.cobertura_tipo === 'pontos' ? '' : 'hidden'}>
                <div class="mm-picker-topo">
                  <input class="busca" type="search" id="mmBuscaPontos" placeholder="Buscar por nome, cidade ou segmento..." aria-label="Buscar ponto">
                  <span class="colecao-contagem" id="mmPontosContagem"></span>
                </div>
                <div class="mm-picker-grid">
                  ${pontosRede.map((p) => montarPontoPickerCard(p, pontosSelecionados.has(p.pontoId))).join('') || '<p class="u-dim u-fs-85 u-m-0">Nenhum ponto em operação ainda.</p>'}
                </div>
              </div>
            </fieldset>

            <fieldset class="form-bloco">
              <legend>Capacidade projetada</legend>
              <div id="mmCapacidadePreview"><p class="campo-ajuda">${capacidadeVazia}</p></div>
            </fieldset>
          </div>

          <aside class="mm-editor-lateral">
            <p class="form-bloco-titulo">Preview</p>
            <div class="tela-moldura"><div class="mm-editor-preview-box" id="mmPreviewBox">${previewInicial}</div></div>
            <p class="mm-preview-info" id="mmPreviewInfo">${infoInicial}</p>
            <div class="acoes">
              ${
                midia
                  ? '<button type="button" class="btn ghost mini" data-escolher-arquivo="mmAlterarArquivo">Alterar mídia</button><input type="file" id="mmAlterarArquivo" accept="video/*,image/*" hidden>'
                  : `<input type="file" id="mmArquivo" accept="video/*,image/*" hidden>
                     <button type="button" class="btn ghost mini" data-escolher-arquivo="mmArquivo" id="mmTrocarArquivo" hidden>Trocar arquivo</button>
                     <button type="button" class="btn perigo-sutil mini" id="mmRemoverArquivo" hidden>Remover</button>`
              }
            </div>
          </aside>
        </div>

        <div class="form-rodape">
          <p class="form-msg" id="mmMsg" role="status"></p>
          <button class="btn ghost" type="button" id="btnCancelarMidia">Cancelar</button>
          <button class="btn primary" type="submit">${midia ? 'Salvar alterações' : 'Criar mídia'}</button>
        </div>
      </form>
    </section>`;
  wrap.hidden = false;
  wrap.scrollIntoView({ behavior: 'smooth' });
  // O "+ Nova mídia" some enquanto o editor está aberto — senão eram dois
  // botões laranja na tela (o de abrir e o de criar).
  const btnNova = document.getElementById('btnNovaMidia');
  if (btnNova) btnNova.hidden = true;

  const form = document.getElementById('formMidia');
  const fechar = () => {
    wrap.hidden = true;
    wrap.innerHTML = '';
    if (btnNova) btnNova.hidden = false;
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
  const contagemPontos = document.getElementById('mmPontosContagem');
  const pintarContagemPontos = () => {
    if (!contagemPontos) return;
    const marcados = document.querySelectorAll('.mm-picker-card input:checked').length;
    contagemPontos.textContent = `Selecionados: ${marcados} de ${pontosRede.length}`;
  };
  if (buscaPontos) {
    buscaPontos.addEventListener('input', () => {
      const termo = buscaPontos.value.trim().toLowerCase();
      document.querySelectorAll('.mm-picker-card').forEach((card) => {
        card.hidden = termo.length > 0 && !card.dataset.busca.includes(termo);
      });
    });
  }
  document.querySelectorAll('.mm-picker-card input').forEach((chk) =>
    chk.addEventListener('change', () => {
      pintarContagemPontos();
      atualizarPreview();
    }),
  );
  pintarContagemPontos();
  ajustarFotos(wrap);
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
          info.innerHTML = `Imagem${sonda.naturalWidth ? ` · ${sonda.naturalWidth}×${sonda.naturalHeight} px` : ''}<span class="mm-arquivo-nome">${esc(arquivo.name)}</span>`;
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
      info.innerHTML = `Vídeo${videoEl.duration ? ` · ${Math.round(videoEl.duration)}s` : ''}${videoEl.videoWidth ? ` · ${videoEl.videoWidth}×${videoEl.videoHeight} px` : ''}<span class="mm-arquivo-nome">${esc(arquivo.name)}</span>`;
    };
  }

  const arquivoInput = document.getElementById('mmArquivo');
  const btnTrocarArquivo = document.getElementById('mmTrocarArquivo');
  const btnRemoverArquivo = document.getElementById('mmRemoverArquivo');
  // Remover só existe na criação (arquivo ainda não enviado): volta o preview
  // pro estado vazio. Na edição a troca é "Alterar mídia", que já sobe.
  btnRemoverArquivo?.addEventListener('click', () => {
    arquivoInput.value = '';
    document.getElementById('mmPreviewBox').innerHTML = PREVIEW_VAZIO;
    document.getElementById('mmPreviewInfo').textContent = '';
    btnTrocarArquivo.hidden = true;
    btnRemoverArquivo.hidden = true;
    duracaoEstimada = 0;
    atualizarPreview();
  });
  if (arquivoInput) {
    arquivoInput.addEventListener('change', () => {
      const arquivo = arquivoInput.files[0];
      if (!arquivo) return;
      previewLocal(arquivo);
      btnTrocarArquivo.hidden = false;
      btnRemoverArquivo.hidden = false;
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
    if (!alvo) return;
    if (!duracaoEstimada) {
      alvo.innerHTML = `<p class="campo-ajuda">${capacidadeVazia}</p>`;
      return;
    }
    const coberturaTipo = form.cobertura_tipo.value;
    const idsMarcados =
      coberturaTipo === 'pontos'
        ? [...document.querySelectorAll('.mm-picker-card input:checked')].map((i) => i.value)
        : [];
    if (coberturaTipo === 'pontos' && !idsMarcados.length) {
      alvo.innerHTML = '<p class="campo-ajuda">Escolha pelo menos um ponto pra ver o impacto.</p>';
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
      alvo.innerHTML = '<p class="campo-ajuda">Nenhum ponto em operação nessa cobertura.</p>';
      return;
    }
    const excedentes = linhas.filter((l) => !l.comporta);
    // Passar da reserva de 20% não bloqueia (a trava é o total > 100%), mas
    // tem que ficar claro que o excedente come capacidade comercial ainda
    // não vendida — rodada de integridade, 23/09/2026.
    const acimaDaReserva = linhas.filter((l) => l.comporta && l.acimaDaReserva);
    // "agora → depois" numa célula só, com o depois em destaque (polimento
    // final, 23/09/2026): a comparação que importa é a mudança, e duas
    // colunas de mesmo peso escondiam isso.
    alvo.innerHTML = `
      ${excedentes.length ? `<p class="aviso-linha erro">Excede 100% em ${plural(excedentes.length, 'ponto')} — reduza a frequência ou a cobertura antes de salvar.</p>` : ''}
      ${acimaDaReserva.length ? `<p class="aviso-linha">Passa da reserva de 20% em ${plural(acimaDaReserva.length, 'ponto')}: o excedente ocupa capacidade comercial ainda não vendida.</p>` : ''}
      <table class="mini-table tabela-projecao"><thead><tr><th>Ponto</th><th class="num">Mostraí <span class="u-dim">agora → depois</span></th><th class="num">Total depois</th><th>Situação</th></tr></thead><tbody>
      ${linhas
        .map(
          (l) => `<tr>
        <td>${esc(l.pontoNome)}</td>
        <td class="num"><span class="valor-antes">${pct(l.mostraiPct)}</span> <span class="seta" aria-hidden="true">→</span> <b class="valor-depois">${pct(l.mostraiDepoisPct)}</b></td>
        <td class="num">${pct(l.depoisPct)}</td>
        <td>${
          !l.comporta
            ? '<span class="badge badge-err">excede 100%</span>'
            : l.acimaDaReserva
              ? '<span class="badge badge-pendente">acima da reserva</span>'
              : '<span class="badge badge-ok">cabe</span>'
        }</td>
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
        msg.textContent = (await r.json().catch(() => ({}))).erro || 'Não foi possível criar a mídia.';
        msg.className = 'form-msg err';
        return;
      }
      toast('Mídia criada.');
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
      msg.textContent = (await r.json().catch(() => ({}))).erro || 'Não foi possível salvar.';
      msg.className = 'form-msg err';
      return;
    }
    toast('Mídia salva.');
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

  const resumo = [
    [porSituacao('ativa'), 'ativa', 'ativas'],
    [porSituacao('agendada'), 'agendada', 'agendadas'],
    [porSituacao('pausada'), 'pausada', 'pausadas'],
    [capacidade.length, 'ponto em operação', 'pontos em operação'],
  ];
  // Hierarquia em três níveis (polimento final, 23/09/2026): resumo em 4
  // números pequenos (não uma faixa larga quase vazia), depois as duas
  // seções com o mesmo cabeçalho — título, contagem junto dele e a ação da
  // seção logo em seguida, na mesma linha. "+ Nova mídia" mora na seção onde
  // a mídia nova vai aparecer, não solta numa linha própria acima de tudo.
  el.innerHTML = `
    <div class="mini-indicadores">
      ${resumo.map(([n, um, varios]) => `<div class="mini-indicador"><b>${n}</b><span>${n === 1 ? um : varios}</span></div>`).join('')}
    </div>
    <div id="editorMidiaWrap" hidden></div>

    <section class="secao-pagina">
      <div class="secao-topo"><h3>Capacidade da rede</h3><span class="secao-nota">quanto ainda cabe em cada ponto em operação</span></div>
      <div id="mmCapacidadeWrap"></div>
    </section>

    <section class="secao-pagina">
      <div class="secao-topo">
        <h3>Mídias próprias</h3>${midias.length ? `<span class="contagem">${midias.length}</span>` : ''}
        <div class="secao-acoes"><button class="btn primary" id="btnNovaMidia">+ Nova mídia</button></div>
      </div>
      ${
        midias.length
          ? `<div class="criativos-grade">${midias.map(montarCardMidia).join('')}</div>`
          : vazio(
              'Nenhuma mídia própria cadastrada.',
              'Uma mídia própria usa a reserva institucional de 20% de cada ponto.',
            )
      }
    </section>`;

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
      if (!r.ok) return toast('Não foi possível pausar.', 'err');
      toast('Mídia pausada.');
      renderMidiaMostrai(el);
    }),
  );
  el.querySelectorAll('[data-retomar-midia]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const r = await api(`/admin/midias-proprias/${btn.dataset.retomarMidia}/retomar`, { method: 'POST' });
      if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'Não foi possível retomar.', 'err');
      toast('Mídia retomada.');
      renderMidiaMostrai(el);
    }),
  );
  el.querySelectorAll('[data-encerrar-midia]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const ok = await confirmarModal({
        titulo: 'Retirar esta mídia do ar?',
        texto: '<p>Ela para de entrar na programação das telas. Nada é excluído — o cadastro fica guardado.</p>',
        botao: 'Retirar do ar',
        perigo: true,
      });
      if (!ok) return;
      const r = await api(`/admin/midias-proprias/${btn.dataset.encerrarMidia}/encerrar`, { method: 'POST' });
      if (!r.ok) return toast('Não foi possível retirar do ar.', 'err');
      toast('Mídia retirada do ar.');
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
  if (url) return `<img src="${esc(url)}" alt="${esc(nome || '')}" loading="lazy" data-foto>`;
  // <span> e não <div>: também entra dentro de <label> (seletor de pontos
  // da Mídia Mostraí), onde só cabe conteúdo de frase.
  return `<span class="ponto-foto-placeholder" role="img" aria-label="${esc(nome ? `${nome}, sem foto` : 'Ponto sem foto')}">
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <path d="M12 21.5s7.25-7.35 7.25-12.25a7.25 7.25 0 1 0-14.5 0c0 4.9 7.25 12.25 7.25 12.25Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="12" cy="9.25" r="2.75" fill="none" stroke="currentColor" stroke-width="1.6"/>
    </svg>
  </span>`;
}

// Card de ponto e de candidatura: um molde só (polimento final, 23/09/2026).
// Nome domina, estado fica no mesmo cabeçalho (menor, à direita), cidade e
// segmento numa linha de apoio e o rodapé com o dado que muda de card pra
// card (telas, movimento/data).
function cardEntidade({ href, filtro = '', foto, nome, badge, meta, rodape }) {
  return `<a class="ponto-card ponto-card-link com-corpo" href="${href}" ${filtro ? `data-filtro="${filtro}"` : ''}>
    <div class="ponto-card-media">${foto}</div>
    <div class="ponto-card-corpo">
      <div class="ponto-card-topo"><h4>${nome}</h4>${badge}</div>
      ${meta ? `<p class="ponto-card-meta">${meta}</p>` : ''}
      ${rodape ? `<p class="ponto-card-pe">${rodape}</p>` : ''}
    </div>
  </a>`;
}

function montarPontoCard(p) {
  const segmento = p.categoria_nome || p.categoria_livre || p.segmento;
  return cardEntidade({
    href: `#rede/pontos/${p.id}`,
    filtro: p.status,
    foto: fotoOuPlaceholder(p.foto_instalacao_url, p.nome),
    nome: esc(p.nome),
    badge: `<span class="badge ${PONTO_STATUS_CLASSE[p.status]}">${PONTO_STATUS[p.status] || p.status}</span>`,
    meta: `${esc(p.cidade)}${p.uf ? `/${esc(p.uf)}` : ''}${segmento ? ` · ${esc(segmento)}` : ''}`,
    rodape: p.telas ? plural(p.telas, 'tela') : 'Nenhuma tela ainda',
  });
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
        ativo: filtroStatus,
        unidade: 'ponto|pontos',
      })
    : vazio(
        'Nenhum ponto cadastrado ainda.',
        'Pedido de ponto feito no painel de uma conta chega em Candidaturas — aprovado, o ponto nasce aqui.',
      );

  if (pontos.length) {
    turbinarCards(el.querySelector('.colecao'), '.ponto-card');
    ajustarFotos(el);
  }
}

// ---------- detalhe do ponto ----------
// Sem abas (redesenho de 22/09/2026): a ficha do estabelecimento é
// somente-leitura, então não compete mais por espaço com a tabela de telas —
// as duas cabem na mesma página, em blocos. Sem endpoint "GET
// /admin/pontos/:id" — reaproveita a listagem (que já junta categoria,
// benefício do ponto, dono e contagem de telas) e acha o ponto nela, igual
// sempre foi; por isso também não precisa buscar `/admin/categorias` à
// parte: os nomes já vêm prontos na própria linha do ponto.
async function renderPontoDetalhe(el, pontoId) {
  const pontos = await pegar('/admin/pontos');
  const ponto = pontos.find((p) => p.id === pontoId);
  if (!ponto) {
    el.innerHTML = '<p class="form-msg err">Ponto não encontrado. <a href="#rede/pontos">Voltar pra Rede</a></p>';
    return;
  }

  el.innerHTML = `
    ${migalha([{ rotulo: 'Pontos', href: '#rede/pontos' }, { rotulo: ponto.nome }])}
    <div class="ponto-detalhe-grid">
      <section class="panel ponto-ficha" id="pontoInformacoes"></section>
      <section class="panel" id="pontoTelas"></section>
    </div>`;

  renderPontoInformacoes(document.getElementById('pontoInformacoes'), ponto);
  renderPontoTelas(document.getElementById('pontoTelas'), ponto);
}

// Horário em linhas curtas ("Seg–sex 07:00–20:00" / "Sáb 07:00–14:00" /
// "Dom fechado") em vez de uma frase corrida que quebrava no meio de um
// horário. Mesmo agrupamento de resumoHorarioSemanal (seg-sex iguais viram
// uma linha só).
function horarioEmLinhas(horario) {
  const texto = resumoHorarioSemanal(horario);
  if (!texto) return '';
  return `<ul class="horario-lista">${texto
    .split(' · ')
    .map((parte) => {
      const [dia, ...resto] = parte.split(' ');
      const valor = resto.join(' ').replace(/-/g, '–');
      return `<li><span>${esc(dia.replace('-', '–'))}</span><span class="${valor === 'fechado' ? 'u-dim' : ''}">${esc(valor)}</span></li>`;
    })
    .join('')}</ul>`;
}

// Cabeçalho de ficha (ponto e candidatura): foto, nome, estado e endereço
// juntos, como um bloco só — antes o nome e a foto ficavam de um lado e o
// resto dos dados solto em duas colunas embaixo.
function fichaCabecalho({ foto, nome, badge, endereco, meta }) {
  return `<div class="ficha-topo">
    <div class="ficha-foto">${foto}</div>
    <div class="ficha-titulo">
      <div class="ficha-nome"><h3>${nome}</h3>${badge}</div>
      ${endereco ? `<p class="ficha-endereco">${endereco}</p>` : ''}
      ${meta ? `<p class="ficha-meta">${meta}</p>` : ''}
    </div>
  </div>`;
}

// Endereço de ficha em duas linhas deliberadas: rua e número numa, bairro
// junto da cidade na outra — em vez do "·" pendurado no fim da linha.
function enderecoFicha(x) {
  const cidade = `${esc(x.cidade || '')}${x.uf ? `/${esc(x.uf)}` : ''}`;
  const linhaCidade = [x.bairro ? esc(x.bairro) : '', cidade].filter(Boolean).join(' · ');
  return `${x.endereco ? `${esc(x.endereco)}<br>` : ''}${linhaCidade}`;
}

// Ficha do estabelecimento — SOMENTE LEITURA (pedido do dono: "dados
// fornecidos pelo estabelecimento devem ser tratados como ficha", não
// formulário). Quem fornece os dados é a candidatura (liberarPapelNaConta,
// src/conta/modos.js); o admin consulta, não edita. Status é automático
// (deriva das telas, src/pontos/repository.js#sincronizarStatusPonto) — não
// tem controle nenhum aqui. Molde ACM saiu do admin de vez (rodada final da
// Rede, 22/09/2026): passou a ser operado fora deste painel, sem sistema
// novo — se precisar consultar o valor antigo, é direto no banco.
// Benefício do ponto (ADR-016, 24/09/2026): +1 crédito por mês enquanto o
// ponto tem tela instalada e ativa. Não é plano nem repasse.
function textoBeneficioPonto(b) {
  if (!b) return '<span class="u-dim">—</span>';
  const ultimo = b.ultimaCompetencia ? `último: ${esc(b.ultimaCompetencia)}` : 'nenhum crédito ainda';
  const proximo = b.creditoDoMesConcedido
    ? `próximo: ${esc(b.proximaCompetencia)}`
    : b.elegivel
      ? `${esc(b.competenciaAtual)} sai no próximo job diário`
      : 'fora do programa até ter tela instalada e ativa';
  return `+1 crédito/mês<span class="dado-sub">${ultimo} · ${proximo}</span>`;
}

function renderPontoInformacoes(el, ponto) {
  // Mesma prioridade do card (montarPontoCard): categoria do catálogo
  // primeiro, senão categoria livre, senão o texto puro de `segmento` — o
  // único que a candidatura de fato grava hoje.
  const segmento = ponto.categoria_nome || ponto.categoria_livre || ponto.segmento;
  const naoInformado = '<span class="u-dim">não informado</span>';
  el.innerHTML = `
    ${fichaCabecalho({
      foto: fotoOuPlaceholder(ponto.foto_instalacao_url, ponto.nome),
      nome: esc(ponto.nome),
      badge: `<span class="badge ${PONTO_STATUS_CLASSE[ponto.status]}">${PONTO_STATUS[ponto.status] || ponto.status}</span>`,
      endereco: enderecoFicha(ponto),
      meta: `${segmento ? esc(segmento) : 'Sem segmento informado'} · ${ponto.telas ? plural(ponto.telas, 'tela') : 'nenhuma tela'}`,
    })}
    <dl class="dados dados-2">
      <div><dt>Responsável</dt><dd>${esc(ponto.responsavel_nome || '—')}${ponto.responsavel_contato ? `<span class="dado-sub">${esc(ponto.responsavel_contato)}</span>` : ''}</dd></div>
      <div><dt>Dono (conta)</dt><dd>${ponto.dono_nome ? (ponto.anunciante_id ? `<a href="#contas/contas/${ponto.anunciante_id}">${esc(ponto.dono_nome)}</a>` : esc(ponto.dono_nome)) : '<span class="u-dim">sem conta</span>'}</dd></div>
      <div><dt>Movimento estimado</dt><dd>${ponto.fluxo_estimado_mensal ? `${num(ponto.fluxo_estimado_mensal)} pessoas/mês` : naoInformado}</dd></div>
      <div><dt>Benefício do ponto</dt><dd>${textoBeneficioPonto(ponto.beneficio)}</dd></div>
      <div class="dados-largo"><dt>Horário de funcionamento</dt><dd>${ponto.horario_semanal ? horarioEmLinhas(ponto.horario_semanal) : naoInformado}</dd></div>
      ${ponto.observacoes ? `<div class="dados-largo"><dt>Observações</dt><dd>${esc(ponto.observacoes)}</dd></div>` : ''}
      <div><dt>Cadastrado em</dt><dd>${data(ponto.created_at)}</dd></div>
    </dl>`;
  ajustarFotos(el);
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
// Texto/badge do sinal (revisão final da Visão geral, 23/09/2026) — antes era
// só "sem sinal" (2h sem heartbeat, sem olhar horário). `situacaoOperacional`
// já vem calculado do backend (src/lib/status-tela.js), única régua.
// Situação operacional como um selo só no cabeçalho da tela (polimento
// final, 23/09/2026) — antes eram três elementos soltos ("Tela #1", o
// select de estado e um "desde 23/09/2026, 14:30:29" que era, na verdade, o
// último sinal). `detalhe` é a linha de apoio ao lado do selo.
const SINAL_TELA = {
  aguardando_primeiro_sinal: () => ({ rotulo: 'Aguardando primeiro sinal', classe: 'badge-neutro', detalhe: '' }),
  fora_do_horario: (t) => ({
    rotulo: 'Fora do horário',
    classe: 'badge-neutro',
    detalhe: t.ultima_vez_online ? `último sinal ${tempoDesde(t.ultima_vez_online)}` : '',
  }),
  sem_sinal: (t) => ({
    rotulo: 'Sem sinal',
    classe: 'badge-err',
    detalhe: t.ultima_vez_online ? `último sinal ${tempoDesde(t.ultima_vez_online)}` : '',
  }),
  erro_do_player: (t) => ({ rotulo: 'Erro do player', classe: 'badge-err', detalhe: t.ultimo_erro || '' }),
  em_reparo: () => ({ rotulo: 'Em reparo', classe: 'badge-info', detalhe: '' }),
  inativa: () => ({ rotulo: 'Inativa', classe: 'badge-neutro', detalhe: '' }),
  operando: (t) => ({
    rotulo: 'Operando',
    classe: 'badge-ok',
    detalhe: t.ultima_vez_online ? `sinal ${tempoDesde(t.ultima_vez_online)}` : '',
  }),
};
// Só essas duas entram no filtro "Sem sinal" e no alerta da Visão geral —
// as outras são estado esperado (fora do horário, nunca instalada, manual).
const SITUACOES_DE_ALERTA_TELA = new Set(['sem_sinal', 'erro_do_player']);

const MODO_HORARIO_TELA = { ponto: 'Segue o horário do ponto', '24h': '24 horas', personalizado: 'Horário próprio' };
const DIAS_HORARIO_TELA = [
  { id: 'seg', rotulo: 'Segunda' },
  { id: 'ter', rotulo: 'Terça' },
  { id: 'qua', rotulo: 'Quarta' },
  { id: 'qui', rotulo: 'Quinta' },
  { id: 'sex', rotulo: 'Sexta' },
  { id: 'sab', rotulo: 'Sábado' },
  { id: 'dom', rotulo: 'Domingo' },
  { id: 'feriados', rotulo: 'Feriados' },
];

// Mesma geometria do widget público (public/candidatura-ponto.js): dia
// fechado mantém os campos no lugar, desabilitados.
function horarioTelaCampos(horario) {
  return `<div class="horario-semanal">
    ${DIAS_HORARIO_TELA.map((d) => {
      const janela = horario?.[d.id];
      const off = janela ? '' : 'disabled';
      return `<div class="horario-dia${janela ? '' : ' fechado'}" data-horario-dia="${d.id}">
        <span class="horario-dia-nome">${d.rotulo}</span>
        <div class="horario-dia-campos">
          <input class="mini" type="time" data-horario-abre value="${janela?.abre || '09:00'}" aria-label="${d.rotulo}, abre" ${off}>
          <span aria-hidden="true">–</span>
          <input class="mini" type="time" data-horario-fecha value="${janela?.fecha || '18:00'}" aria-label="${d.rotulo}, fecha" ${off}>
        </div>
        <label class="horario-dia-fechado"><input type="checkbox" data-horario-fechado aria-label="${d.rotulo}, fechado" ${janela ? '' : 'checked'}>Fechado</label>
      </div>`;
    }).join('')}
  </div>`;
}

// Campo de uma margem da safe area: rótulo por extenso na mesma linha do
// número, com a unidade colada ("Topo [2] vmin") — leitura imediata.
function campoMargem(t, campo, rotulo, lado) {
  const id = `margem_${campo}_${t.id}`;
  return `<label class="safe-lado safe-${lado}" for="${id}">
    <span class="safe-rotulo">${rotulo}</span>
    <span class="campo-unidade"><input class="mini" type="number" min="0" step="0.5" id="${id}" data-tela="margem_${campo}" data-id="${t.id}" value="${Number(t[`margem_${campo}`] ?? 0)}"><span>vmin</span></span>
  </label>`;
}

// Tela em blocos (polimento final, 23/09/2026, pedido do dono): cabeçalho
// operacional (nome, situação, último sinal, estado), depois Player, PIN,
// Instalação/horário e Safe area — cada ação com o nome do que faz ("Gerar
// nova chave", "Trocar PIN"), nunca dois "Trocar" soltos. Excluir no rodapé,
// com a cor de ação destrutiva.
function montarTelaCard(t) {
  const alerta = SITUACOES_DE_ALERTA_TELA.has(t.situacaoOperacional);
  const modoHorario = t.modo_horario || 'ponto';
  const sinal = (SINAL_TELA[t.situacaoOperacional] || SINAL_TELA.operando)(t);
  const nome = t.apelido && t.apelido !== 'Tela' ? t.apelido : `Tela ${t.id}`;
  return `<article class="tela-card" data-filtro="${t.status}${alerta ? ' offline' : ''}${t.aparelho_id ? '' : ' semchave'}">
    <header class="tela-card-topo">
      <div class="tela-card-titulo">
        <h4>${esc(nome)}</h4>
        <span class="badge ${sinal.classe}">${sinal.rotulo}</span>
        ${sinal.detalhe ? `<span class="tela-card-sinal" ${t.situacaoOperacional === 'erro_do_player' ? `title="${esc(sinal.detalhe)}"` : ''}>${esc(sinal.detalhe)}</span>` : ''}
      </div>
      <label class="tela-estado"><span>Estado</span>${selectStatus(TELA_STATUS, t.status, `data-tela="status" data-id="${t.id}"`)}</label>
    </header>
    <div class="tela-grupos">
      <section class="tela-grupo">
        <h5>Player</h5>
        <p class="tela-grupo-valor">${t.aparelho_id ? '<i class="ponto-status badge-ok" aria-hidden="true"></i>Chave configurada' : '<i class="ponto-status badge-pendente" aria-hidden="true"></i>Sem chave'}</p>
        <div class="acoes">
          ${
            t.aparelho_id
              ? `<button class="btn ghost mini" data-copiar="${esc(t.aparelho_id)}" data-tela-id="${t.id}">Copiar link</button>
                 <button class="btn ghost mini" data-chave="${t.id}" data-trocar="1" title="Gera uma chave nova e desconecta o aparelho atual">Gerar nova chave</button>`
              : `<button class="btn ghost mini" data-chave="${t.id}">Gerar chave</button>`
          }
        </div>
      </section>
      <section class="tela-grupo">
        <h5>PIN do painel</h5>
        <p class="tela-grupo-valor">${t.tem_pin ? '<i class="ponto-status badge-ok" aria-hidden="true"></i>Definido' : '<i class="ponto-status badge-pendente" aria-hidden="true"></i>Sem PIN'}</p>
        <div class="acoes"><button class="btn ghost mini" data-pin="${t.id}">${t.tem_pin ? 'Trocar PIN' : 'Definir PIN'}</button></div>
      </section>
      <section class="tela-grupo">
        <h5>Instalação</h5>
        <label class="tela-campo" for="instalada${t.id}"><span>Data</span>
          <input class="mini" type="date" id="instalada${t.id}" data-tela="instalado_em" data-id="${t.id}" value="${t.instalado_em ? String(t.instalado_em).slice(0, 10) : ''}"></label>
        <label class="tela-campo" for="modoHorario${t.id}" title="Quando essa tela deveria estar online — decide o que vira alerta de 'sem sinal'"><span>Horário</span>
          ${selectStatus(MODO_HORARIO_TELA, modoHorario, `id="modoHorario${t.id}" data-tela="modo_horario" data-id="${t.id}"`)}</label>
      </section>
    </div>
    <div class="horario-tela-editor" data-horario-tela="${t.id}" ${modoHorario === 'personalizado' ? '' : 'hidden'}>
      ${horarioTelaCampos(t.horario_semanal)}
      <div class="acoes"><button type="button" class="btn ghost mini" data-salvar-horario-tela="${t.id}">Salvar horário</button></div>
    </div>
    <section class="tela-safe">
      <h5>Safe area <span>área coberta pela moldura — o player encolhe a mídia pra dentro dela</span></h5>
      <div class="safe-area">
        ${campoMargem(t, 'superior', 'Topo', 'topo')}
        ${campoMargem(t, 'esquerda', 'Esquerda', 'esquerda')}
        <div class="safe-tela" aria-hidden="true"><div class="safe-miolo">mídia</div></div>
        ${campoMargem(t, 'direita', 'Direita', 'direita')}
        ${campoMargem(t, 'inferior', 'Baixo', 'baixo')}
      </div>
      <p class="campo-ajuda">1 vmin = 1% do menor lado da área visível da tela.</p>
    </section>
    <footer class="tela-card-pe">
      <button class="btn perigo-sutil mini" data-excluir-tela="${t.id}" title="Só se essa tela nunca rodou nada">Excluir tela</button>
    </footer>
  </article>`;
}

async function renderPontoTelas(el, ponto) {
  // `situacaoOperacional` já vem pronta em cada tela (src/dispositivos/
  // repository.js) — não precisa mais de uma segunda chamada só pra saber
  // quem está sem sinal.
  const telas = await pegar(`/admin/pontos/${ponto.id}/dispositivos`);

  // Filtros só aparecem quando há o que filtrar (3+ telas): com 1 ou 2, a
  // busca e os 6 chips ocupavam mais espaço que as próprias telas.
  const comFiltros = telas.length > 2;
  el.innerHTML = `
    <div class="secao-topo">
      <h3>Telas</h3>${telas.length ? `<span class="contagem">${telas.length}</span>` : ''}
      <div class="secao-acoes"><button class="btn ghost mini" id="btnNovaTela">+ Tela</button></div>
    </div>
    ${
      telas.length
        ? `${
            comFiltros
              ? `<div class="telas-topo">
              <input class="busca" type="search" placeholder="Buscar tela..." aria-label="Buscar tela">
              <div class="chips">
                <button type="button" class="chip active" data-filtro="">Todas</button>
                <button type="button" class="chip" data-filtro="offline">Sem sinal</button>
                <button type="button" class="chip" data-filtro="semchave">Sem chave</button>
                ${Object.entries(TELA_STATUS)
                  .map(([v, n]) => `<button type="button" class="chip" data-filtro="${v}">${n}</button>`)
                  .join('')}
              </div>
              <span class="colecao-contagem" data-contagem></span>
            </div>`
              : ''
          }
            <div class="telas-lista">${telas.map((t) => montarTelaCard(t)).join('')}</div>`
        : vazio('Nenhuma tela instalada ainda.', 'Crie a tela no dia da instalação — a chave do player sai dela.')
    }`;

  document.getElementById('btnNovaTela').addEventListener('click', () => {
    const { dlg, fechar } = abrirModal({
      titulo: 'Nova tela',
      corpo: `<form id="formNovaTela" class="modal-form">
          <div><label for="novaTelaApelido">Nome da tela <span class="u-dim">(só interno)</span></label>
          <input id="novaTelaApelido" name="apelido" required value="Tela ${telas.length + 1}" placeholder="ex.: Tela 2 — balcão"></div>
          <p class="u-dim u-fs-85 u-m-0">A tela nasce inativa. Gere a chave do player e marque como ativa na instalação.</p>
          <p class="form-msg" data-msg role="status"></p>
        </form>`,
      rodape:
        '<button type="button" class="btn ghost" data-fechar>Cancelar</button><button type="submit" form="formNovaTela" class="btn primary">Criar tela</button>',
    });
    const campo = dlg.querySelector('#novaTelaApelido');
    campo.select();
    dlg.querySelector('#formNovaTela').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await api(`/admin/pontos/${ponto.id}/dispositivos`, {
        method: 'POST',
        body: JSON.stringify({ apelido: campo.value.trim() }),
      });
      if (!r.ok) return erroNoModal(dlg, 'Não foi possível criar a tela.');
      toast('Tela criada. Gere a chave do player nela.');
      fechar();
      renderPontoTelas(el, ponto);
    });
  });

  if (!telas.length) return;

  const busca = el.querySelector('.busca');
  const contagem = el.querySelector('[data-contagem]');
  const cartoes = () => [...el.querySelectorAll('.tela-card')];
  function aplicarFiltro() {
    const termo = (busca?.value || '').toLowerCase().trim();
    const chipAtivo = el.querySelector('.chip.active');
    const filtro = chipAtivo ? chipAtivo.dataset.filtro : '';
    let visiveis = 0;
    cartoes().forEach((card) => {
      const casaTermo = !termo || card.textContent.toLowerCase().includes(termo);
      const casaFiltro = !filtro || (card.dataset.filtro || '').split(' ').includes(filtro);
      card.hidden = !(casaTermo && casaFiltro);
      if (!card.hidden) visiveis += 1;
    });
    if (contagem)
      contagem.textContent =
        visiveis === cartoes().length ? plural(visiveis, 'tela') : `${visiveis} de ${plural(cartoes().length, 'tela')}`;
  }
  if (comFiltros) {
    busca.addEventListener('input', aplicarFiltro);
    el.querySelectorAll('.chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        el.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        aplicarFiltro();
      }),
    );
    aplicarFiltro();
  }

  el.querySelectorAll('[data-tela]').forEach((campo) =>
    campo.addEventListener('change', async () => {
      const numerico = ['margem_superior', 'margem_direita', 'margem_inferior', 'margem_esquerda'].includes(
        campo.dataset.tela,
      );
      const valor = campo.value === '' ? null : numerico ? Number(campo.value) : campo.value;
      if (await salvar(`/admin/dispositivos/${campo.dataset.id}`, { [campo.dataset.tela]: valor }, campo)) {
        // status e modo_horario podem os dois mudar a situação operacional da
        // tela (src/lib/status-tela.js) — e com ela o alerta "sem sinal" da
        // Visão geral (achado em revisão de PR: só `status` recarregava
        // RESUMO, `modo_horario` só re-renderizava o card local e deixava o
        // contador do menu desatualizado até um Atualizar manual). As duas
        // recarregam RESUMO e o próprio card, pro editor mostrar/esconder e o
        // contador bater com o que acabou de ser salvo.
        if (campo.dataset.tela === 'status' || campo.dataset.tela === 'modo_horario') {
          RESUMO = await pegar('/admin/resumo');
          pintarContadores();
          renderPontoTelas(el, ponto);
        }
      }
    }),
  );

  el.querySelectorAll('[data-horario-dia]').forEach((linha) => {
    const chk = linha.querySelector('[data-horario-fechado]');
    chk.addEventListener('change', () => {
      linha.classList.toggle('fechado', chk.checked);
      linha.querySelectorAll('input[type="time"]').forEach((campo) => {
        campo.disabled = chk.checked;
      });
    });
  });

  el.querySelectorAll('[data-salvar-horario-tela]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const editor = el.querySelector(`[data-horario-tela="${btn.dataset.salvarHorarioTela}"]`);
      const horario_semanal = {};
      editor.querySelectorAll('[data-horario-dia]').forEach((linha) => {
        const fechado = linha.querySelector('[data-horario-fechado]').checked;
        horario_semanal[linha.dataset.horarioDia] = fechado
          ? null
          : {
              abre: linha.querySelector('[data-horario-abre]').value,
              fecha: linha.querySelector('[data-horario-fecha]').value,
            };
      });
      const r = await api(`/admin/dispositivos/${btn.dataset.salvarHorarioTela}`, {
        method: 'PATCH',
        body: JSON.stringify({ horario_semanal }),
      });
      if (!r.ok) return toast((await r.json().catch(() => ({}))).erro || 'Não foi possível salvar o horário.', 'err');
      toast('Horário salvo.');
      // Mesmo motivo do listener de `[data-tela]` acima: um horário
      // personalizado novo pode mudar a situação operacional da tela na
      // hora (ex.: tela que estava fora_do_horario passa a estar dentro) —
      // sem recarregar RESUMO o alerta da Visão geral ficava com o número
      // de antes até um Atualizar manual (achado em revisão de PR).
      RESUMO = await pegar('/admin/resumo');
      pintarContadores();
      renderPontoTelas(el, ponto);
    }),
  );

  el.querySelectorAll('[data-chave]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (btn.dataset.trocar) {
        const ok = await confirmarModal({
          titulo: 'Gerar nova chave?',
          texto:
            '<p>A TV que usa a chave atual para de funcionar até você abrir o link novo no navegador dela. Use quando o aparelho for trocado ou sumir.</p>',
          botao: 'Gerar nova chave',
          perigo: true,
        });
        if (!ok) return;
      }
      const r = await api(`/admin/dispositivos/${btn.dataset.chave}/chave`, { method: 'POST' });
      if (!r.ok) return toast('Não foi possível gerar a chave.', 'err');
      const { aparelho_id } = await r.json();
      mostrarLinkPlayer(linkDoPlayer(btn.dataset.chave, aparelho_id), 'Chave gerada');
      renderPontoTelas(el, ponto);
    }),
  );

  el.querySelectorAll('[data-copiar]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const link = linkDoPlayer(btn.dataset.telaId, btn.dataset.copiar);
      copiarTexto(link).then(
        () => toast('Link copiado.'),
        () => mostrarLinkPlayer(link, 'Link do player'),
      );
    }),
  );

  el.querySelectorAll('[data-pin]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const tela = telas.find((t) => t.id === Number(btn.dataset.pin));
      const { dlg, fechar } = abrirModal({
        titulo: tela?.tem_pin ? 'Trocar PIN' : 'Definir PIN',
        corpo: `<form id="formPinTela" class="modal-form">
            <div><label for="pinTela">PIN do painel da tela <span class="u-dim">(4 a 6 dígitos)</span></label>
            <input id="pinTela" name="pin" inputmode="numeric" autocomplete="off" pattern="\\d{4,6}" maxlength="6" ${tela?.tem_pin ? '' : 'required'}></div>
            <p class="u-dim u-fs-85 u-m-0">Protege só o painel aberto na própria TV.${tela?.tem_pin ? ' Deixe vazio e salve pra remover o PIN atual.' : ''}</p>
            <p class="form-msg" data-msg role="status"></p>
          </form>`,
        rodape:
          '<button type="button" class="btn ghost" data-fechar>Cancelar</button><button type="submit" form="formPinTela" class="btn primary">Salvar PIN</button>',
      });
      const campo = dlg.querySelector('#pinTela');
      campo.focus();
      dlg.querySelector('#formPinTela').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pin = campo.value.trim();
        const r = await api(`/admin/dispositivos/${btn.dataset.pin}/pin`, {
          method: 'POST',
          body: JSON.stringify({ pin: pin || null }),
        });
        if (!r.ok) return erroNoModal(dlg, (await r.json().catch(() => ({}))).erro || 'Não foi possível salvar o PIN.');
        toast(pin ? 'PIN definido.' : 'PIN removido.');
        fechar();
        renderPontoTelas(el, ponto);
      });
    }),
  );

  el.querySelectorAll('[data-excluir-tela]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const ok = await confirmarModal({
        titulo: 'Excluir esta tela?',
        texto: '<p>Só faça isso se ela nunca rodou nada — o histórico de exibições dela vai junto e não volta.</p>',
        botao: 'Excluir tela',
        perigo: true,
      });
      if (!ok) return;
      const r = await api(`/admin/dispositivos/${btn.dataset.excluirTela}`, { method: 'DELETE' });
      if (!r.ok) return toast('Não foi possível excluir.', 'err');
      toast('Tela excluída.');
      renderPontoTelas(el, ponto);
    }),
  );
}

// Link num modal com campo só-leitura e botão de copiar — no lugar do
// prompt() nativo, que no celular nem deixava selecionar direito.
function mostrarLinkPlayer(link, titulo) {
  mostrarLink({
    titulo,
    texto: 'Abra este link no navegador da TV. Ele guarda a chave e continua funcionando depois de reiniciar.',
    link,
  });
}

function mostrarLink({ titulo, texto, link }) {
  const { dlg } = abrirModal({
    titulo,
    corpo: `<p class="u-mt-0">${esc(texto)}</p>
      <input id="linkPlayerCampo" readonly value="${esc(link)}" aria-label="Link">
      <p class="form-msg" data-msg role="status"></p>`,
    rodape:
      '<button type="button" class="btn ghost" data-fechar>Fechar</button><button type="button" class="btn primary" data-copiar-link>Copiar link</button>',
  });
  const campo = dlg.querySelector('#linkPlayerCampo');
  campo.select();
  dlg.querySelector('[data-copiar-link]').addEventListener('click', () => {
    campo.select();
    copiarTexto(link).then(
      () => toast('Link copiado.'),
      () => erroNoModal(dlg, 'Não deu pra copiar sozinho — selecione o link e copie.'),
    );
  });
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
// tem ponto → "Dono de ponto" (e o benefício de +1 crédito/mês); tem plano
// vigente → coluna Plano. Vendedor e Parceiro saíram da
// experiência (os dados antigos continuam no banco, intocados). A conta
// interna do Mostraí (`conta_propria`) não aparece aqui: ela é gerida em
// Mídia Mostraí e não é cliente.
//
// A tabela continua sendo `anunciantes` — só a UI chama de conta.

// Só existem três planos comerciais — Essencial, Pro e Prime (ADR-016,
// 24/09/2026). Inicial e Básico (comodato) saíram do fluxo ativo; os ids
// antigos só aparecem em histórico, traduzidos por `humanizarPlanoId`.

function nomeDoPlano(plano) {
  if (!plano) return '';
  return `${plano.nome} · ${CICLOS[plano.compromisso_meses] || `${plano.compromisso_meses} meses`}`;
}

// Nome humano de um plano só pelo id (polimento final, 23/09/2026): versão
// aposentada ("destaque-3m-v2") não vem em `/admin/planos`, e a tela caía no
// id cru — "essencial-3m" aparecendo na tabela de Contas. O id segue o
// padrão `<tier>-<meses>m[-vN]` (planos-repository.js#proximoId).
const TIER_POR_PREFIXO = { essencial: 'Essencial', destaque: 'Pro', maximo: 'Prime', fundador: 'Pro' };
function humanizarPlanoId(id) {
  if (!id) return '';
  if (id === 'comodato-basico') return 'Básico (legado)';
  const m = /^([a-z]+)-(\d+)m(?:-v\d+)?$/.exec(id);
  if (!m) return 'Plano';
  if (m[1] === 'inicial') return 'Inicial (legado)';
  const tier = TIER_POR_PREFIXO[m[1]] || 'Plano';
  return `${tier} · ${CICLOS[m[2]] || `${m[2]} meses`}${m[1] === 'fundador' ? ' (fundador)' : ''}`;
}

// Sempre humano: nome da versão quando conhecida, senão o id traduzido.
function nomePlanoOuId(plano, id) {
  return nomeDoPlano(plano) || humanizarPlanoId(id);
}

// Plano COMERCIAL da conta na lista, com a ORIGEM decidida no servidor
// (`plano_origem`, plano-administrativo.js#origemDoDireito — a mesma régua da
// ficha). Antes toda cortesia saía "Cortesia administrativa", inclusive
// benefício pago com créditos.
function planoComercialDaConta(conta, planosPorId) {
  if (!conta.plano_id) return null;
  return {
    plano: planosPorId[conta.plano_id] || null,
    id: conta.plano_id,
    origem: conta.plano_origem || (conta.plano_cortesia ? 'cortesia_legada' : 'assinatura'),
    vencido: !!(conta.data_expiracao && new Date(conta.data_expiracao) < new Date()),
    expira: conta.data_expiracao,
  };
}

const ORIGEM_PLANO = {
  assinatura: 'Assinatura paga',
  beneficio_creditos: 'Benefício por créditos',
  cortesia_legada: 'Cortesia administrativa legada',
  bonus_ponto: 'Bônus de ponto legado',
};

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
      const filtro = [
        comercial && !comercial.vencido ? 'com-plano' : 'sem-plano',
        pts.length ? 'dono-ponto' : '',
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
        ? `${esc(nomePlanoOuId(comercial.plano, comercial.id))}<small class="cat-detalhe">${
            comercial.vencido ? `venceu em ${data(comercial.expira)}` : ORIGEM_PLANO[comercial.origem]
          }</small>`
        : '<span class="u-dim">—</span>';
      return `<tr data-filtro="${filtro}" class="linha-clicavel${a.excluido_em ? ' u-op-60' : ''}" data-abrir="${a.id}">
        <td><a class="celula-titulo" href="#contas/contas/${a.id}">${esc(a.nome_empresa)}</a>${sinais}</td>
        <td><div class="celula-contato">${esc(a.contato_email)}</div><div class="celula-sub">${esc(a.contato_telefone)}</div></td>
        <td>${categoria}</td>
        <td>${plano}</td>
        <td class="num">${pts.length}</td>
        <td class="num" data-valor="${new Date(a.created_at).getTime()}">${data(a.created_at)}</td>
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
          { valor: 'suspensa', nome: 'Suspensas' },
        ],
        html: `<table class="tabela-contas"><thead><tr>
            <th data-ord>Conta</th><th>Contato</th><th data-ord>Categoria</th><th data-ord>Plano</th>
            <th data-ord class="num">Pontos</th><th data-ord class="num">Entrou</th>
          </tr></thead><tbody>${linhas}</tbody></table>`,
        unidade: 'conta|contas',
      })
    : vazio('Nenhuma conta ainda.', 'O cadastro pelo site cai aqui na hora.');

  if (contas.length) turbinarTabela(el.querySelector('.tabela-caixa'));
  // A linha inteira abre a ficha; o nome é um link de verdade (teclado,
  // abrir em outra aba) — clique nele já navega sozinho.
  el.querySelectorAll('[data-abrir]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      irPara(`contas/contas/${tr.dataset.abrir}`);
    }),
  );
}

// ---------- ficha da conta ----------
// Revisão de 23/09/2026 (pedido do dono: "a interface precisa representar o
// domínio da Mostraí, não a estrutura das tabelas"). A ficha lê UMA fonte —
// GET /admin/anunciantes/:id/situacao (src/anunciantes/situacao.js), onde
// cada regra é decidida uma vez: origem do plano, fila Agora → Próximo →
// Depois, benefício de cada ponto (+1 crédito/mês), ponto × solicitação,
// selo "Dono de ponto", invariantes. Antes cada card tirava a própria
// conclusão de uma lista crua diferente, e dois cards chegaram a se
// contradizer. Aqui só se desenha.
//
// Cards condicionais: Plano, Dados, Créditos e Criativos sempre; Pontos só
// com ponto aprovado; Solicitações de ponto só com pedido em análise. Não
// existe card "Comodato" comercial desde 24/09/2026 (ADR-016): ser ponto
// gera créditos, não plano nem repasse. Históricos recolhidos. Ações
// destrutivas discretas, no fim.
//
// Reatividade sem F5: a ficha assina os eventos da própria conta
// (GET /admin/anunciantes/:id/eventos, o mesmo barramento SSE do painel do
// cliente) e se redesenha quando o cliente resgata créditos, uma candidatura
// é aprovada, um ponto ou tela muda.

const ORIGEM_CLASSE = {
  assinatura: 'badge-ok',
  beneficio_creditos: 'badge-info',
  cortesia_legada: 'badge-neutro',
  bonus_ponto: 'badge-neutro',
};

// Rótulos do tipo de movimentação do ledger (migration 079) — mesmos valores
// do CHECK de creditos_ledger.tipo.
const TIPO_CREDITO = {
  indicacao_primeiro_pagamento: 'Indicação · primeiro pagamento',
  indicacao_renovacao: 'Indicação · renovação',
  concessao_admin: 'Concedido pelo admin',
  estorno_admin: 'Estorno (admin)',
  resgate_beneficio: 'Resgate de benefício',
  estorno_resgate: 'Estorno de resgate',
  credito_mensal_ponto: 'Crédito mensal do ponto',
};

let EVENTOS_FICHA = null; // { contaId, fonte: EventSource, timer }

function fecharEventosDaFicha() {
  if (!EVENTOS_FICHA) return;
  EVENTOS_FICHA.fonte.close();
  clearTimeout(EVENTOS_FICHA.timer);
  EVENTOS_FICHA = null;
}

async function renderContaDetalhe(el, contaId) {
  let situacao = null;
  let categorias = [];
  try {
    [situacao, categorias] = await Promise.all([
      pegar(`/admin/anunciantes/${contaId}/situacao`),
      pegar('/admin/categorias'),
    ]);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (!situacao || situacao.dados.contaPropria) {
    fecharEventosDaFicha();
    el.innerHTML = `${migalha([{ rotulo: 'Contas', href: '#contas/contas' }])}
      ${vazio(situacao ? 'A conta interna do Mostraí é gerida em Mídia Mostraí.' : 'Conta não encontrada.')}`;
    return;
  }
  desenharFicha(el, situacao, categorias);
  ligarEventosDaFicha(el, contaId);
}

// Redesenha com o estado novo sem piscar "Carregando..." e sem perder a
// rolagem nem os históricos que o admin tinha aberto.
async function atualizarFicha(el, contaId) {
  if (!el.isConnected) return;
  const [situacao, categorias] = await Promise.all([
    pegar(`/admin/anunciantes/${contaId}/situacao`),
    pegar('/admin/categorias'),
  ]);
  if (!el.isConnected) return;
  const abertos = [...el.querySelectorAll('details[data-historico][open]')].map((d) => d.dataset.historico);
  const rolagem = window.scrollY;
  desenharFicha(el, situacao, categorias);
  abertos.forEach((k) => {
    const d = el.querySelector(`details[data-historico="${k}"]`);
    if (d) d.open = true;
  });
  window.scrollTo(0, rolagem);
}

function ligarEventosDaFicha(el, contaId) {
  // Mesma conta redesenhada do zero (botão Atualizar recria o contêiner da
  // aba): o canal continua, só passa a apontar pro contêiner novo — sem isso
  // o próximo evento via o antigo desconectado e fechava o canal.
  if (EVENTOS_FICHA?.contaId === contaId) {
    EVENTOS_FICHA.el = el;
    return;
  }
  fecharEventosDaFicha();
  if (typeof EventSource === 'undefined') return;
  const fonte = new EventSource(`${API_BASE_URL}/admin/anunciantes/${contaId}/eventos`, { withCredentials: true });
  const estado = { contaId, fonte, el, timer: null };
  const tentar = async () => {
    const alvo = estado.el;
    if (ABA_ATUAL.modulo !== 'contas' || ABA_ATUAL.resto !== String(contaId) || !alvo.isConnected) {
      fecharEventosDaFicha();
      return;
    }
    // Nunca redesenha por baixo de um modal aberto ou de um campo em edição
    // — tenta de novo daqui a pouco.
    const ativo = document.activeElement;
    if (document.querySelector('dialog[open]') || (alvo.contains(ativo) && ativo.matches('input, textarea, select'))) {
      estado.timer = setTimeout(tentar, 1500);
      return;
    }
    try {
      await atualizarFicha(alvo, contaId);
    } catch (err) {
      console.error('falha ao atualizar a ficha da conta', err);
    }
  };
  const agendar = () => {
    clearTimeout(estado.timer);
    estado.timer = setTimeout(tentar, 400);
  };
  [
    'credits.updated',
    'payment.updated',
    'plan.updated',
    'point.updated',
    'screen.updated',
    'application.updated',
    'creative.updated',
    'account.updated',
    'finance.updated',
  ].forEach((ev) => fonte.addEventListener(ev, agendar));
  EVENTOS_FICHA = estado;
}

function desenharFicha(el, s, categorias) {
  const d = s.dados;
  const bloqueada = d.suspensa || !!d.excluidaEm;
  const ctx = {
    s,
    conta: { id: d.id, nome: d.nome, suspensa: d.suspensa, excluidaEm: d.excluidaEm },
    categorias,
    bloqueada,
    // Depois de uma ação que já deu certo: se a releitura falhar (rede), a
    // ação não "falhou" — só avisa pra atualizar.
    recarregar: () =>
      atualizarFicha(el, d.id).catch((err) => {
        console.warn('ficha da conta: releitura falhou', err);
        toast('Feito — mas não deu pra atualizar a ficha. Clique em Atualizar.', 'err');
      }),
  };
  el.innerHTML = `
    ${migalha([{ rotulo: 'Contas', href: '#contas/contas' }, { rotulo: d.nome }])}
    <header class="conta-cabecalho">
      <h2>${esc(d.nome)}</h2>
      ${s.donoDePonto ? '<span class="badge badge-info">Dono de ponto</span>' : ''}
      ${d.suspensa ? '<span class="conta-sinal conta-sinal-err">Conta suspensa</span>' : ''}
      ${d.excluidaEm ? `<span class="conta-sinal">Excluída em ${data(d.excluidaEm)}</span>` : ''}
    </header>
    ${
      s.alertas.length
        ? `<div class="conta-alertas" role="status">${s.alertas.map((a) => `<p class="aviso-linha">${esc(a.texto)}</p>`).join('')}</div>`
        : ''
    }
    <div class="conta-grade">
      <section class="panel conta-secao" id="contaDados"></section>
      <section class="panel conta-secao" id="contaPlano"></section>
    </div>
    <section class="panel conta-secao" id="contaCreditos"></section>
    <section class="panel conta-secao" id="contaCriativos"></section>
    ${s.pontos.length ? '<section class="panel conta-secao" id="contaPontos"></section>' : ''}
    ${s.solicitacoes.length ? '<section class="panel conta-secao conta-secao-discreta" id="contaSolicitacoes"></section>' : ''}
    <div class="conta-rodape" id="contaRodape"></div>`;

  desenharContaDados(el.querySelector('#contaDados'), ctx);
  desenharContaPlano(el.querySelector('#contaPlano'), ctx);
  desenharContaCreditos(el.querySelector('#contaCreditos'), ctx);
  desenharContaCriativos(el.querySelector('#contaCriativos'), {
    ...ctx,
    criativosInfo: {
      criativos: s.criativos.lista,
      limite_no_ar: s.criativos.resumo.limiteNoAr,
      limite_cadastro: s.criativos.resumo.limiteConta,
      conta_veicula: s.criativos.resumo.contaVeicula,
    },
  });
  if (s.pontos.length) desenharContaPontos(el.querySelector('#contaPontos'), s.pontos);
  if (s.solicitacoes.length) desenharContaSolicitacoes(el.querySelector('#contaSolicitacoes'), s.solicitacoes);
  desenharContaRodape(el.querySelector('#contaRodape'), ctx);
}

// Dados: só leitura, menos a categoria (o admin corrige a categoria aqui; o
// resto é do cliente, pelo painel dele). Categoria antiga (fora do cadastro
// atual) não fica escrita dentro da busca como se valesse: aparece como
// aviso, com a sucessora em um clique quando a fusão de categorias gravou
// uma (`canonica_id`, migration 074) e sugestões pelo nome quando não.
function desenharContaDados(el, { s, categorias, bloqueada, recarregar }) {
  const d = s.dados;
  const cat = d.categoria;
  const antiga = cat?.antiga;
  const atual = cat && !antiga ? categorias.find((c) => c.id === cat.id) || { id: cat.id, nome: cat.nome } : null;
  let aviso = '';
  let sugestoes = [];
  if (antiga) {
    sugestoes = cat.canonica ? [cat.canonica] : sugerirCategorias(cat.nome, categorias);
    aviso = `<p class="aviso-linha u-mt-4">“${esc(cat.nome)}” é uma categoria antiga, fora do cadastro atual — o bloqueio de concorrente não enxerga ela direito. ${
      sugestoes.length ? 'Troque por uma atual:' : 'Pesquise a atual acima.'
    }</p>`;
  } else if (!cat && d.categoriaLivre) {
    sugestoes = sugerirCategorias(d.categoriaLivre, categorias);
    aviso = `<p class="aviso-linha u-mt-4">O cliente descreveu: “${esc(d.categoriaLivre)}”. ${sugestoes.length ? 'Escolha a categoria que corresponde:' : 'Pesquise a categoria que corresponde acima.'}</p>`;
  }
  el.innerHTML = `
    <div class="secao-topo"><h3>Dados</h3></div>
    <dl class="dados dados-2">
      <div><dt>Documento</dt><dd>${esc(d.documento)}</dd></div>
      <div><dt>Entrou em</dt><dd>${data(d.entrouEm)}</dd></div>
      <div><dt>E-mail</dt><dd>${esc(d.email)}</dd></div>
      <div><dt>WhatsApp</dt><dd class="u-nowrap">${esc(d.telefone)}</dd></div>
      <div class="dados-largo"><dt><label for="fichaCategoriaBusca">Categoria</label></dt><dd>
        ${categoriaBuscaHtml('fichaCategoria', atual, { placeholder: antiga ? 'Escolha a categoria atual...' : 'Pesquise a categoria...' })}
        ${aviso}
        ${
          sugestoes.length && !bloqueada
            ? `<div class="categoria-sugestoes">${sugestoes
                .map(
                  (c) => `<button type="button" class="btn ghost mini" data-sugestao="${c.id}">${esc(c.nome)}</button>`,
                )
                .join('')}</div>`
            : ''
        }
      </dd></div>
    </dl>`;
  const salvarCategoria = (categoria) =>
    salvar(
      `/admin/anunciantes/${d.id}`,
      { categoria_id: categoria.id, categoria_livre: null },
      document.getElementById('fichaCategoriaBusca'),
    );
  ligarCategoriaBusca('fichaCategoria', categorias, async (categoria) => {
    if (await salvarCategoria(categoria)) recarregar();
  });
  el.querySelectorAll('[data-sugestao]').forEach((b) =>
    b.addEventListener('click', async () => {
      const categoria = categorias.find((c) => String(c.id) === b.dataset.sugestao) || {
        id: Number(b.dataset.sugestao),
      };
      if (await salvarCategoria(categoria)) recarregar();
    }),
  );
}

// Até 4 categorias ATUAIS cujo nome ou alias contém uma palavra do nome
// antigo ("Restaurante / lanchonete" → Restaurante, Lanchonete...). Só
// sugestão — quem decide é o admin, nenhuma troca é automática.
function sugerirCategorias(texto, categorias) {
  const palavras = normalizarBuscaCategoria(texto)
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 4);
  if (!palavras.length) return [];
  return categorias
    .filter((c) => c.ativo && !c.legado)
    .map((c) => {
      const nome = normalizarBuscaCategoria(c.nome);
      const tudo = normalizarBuscaCategoria(`${c.nome} ${(c.aliases || []).join(' ')}`);
      const peso = palavras.reduce((t, p) => t + (nome.includes(p) ? 2 : tudo.includes(p) ? 1 : 0), 0);
      return { c, peso };
    })
    .filter((x) => x.peso > 0)
    .sort((a, b) => b.peso - a.peso || a.c.nome.localeCompare(b.c.nome))
    .slice(0, 4)
    .map((x) => x.c);
}

// O que um plano entrega, numa linha ("180 s/h · 10 pontos · peça até 30 s ·
// 3 no ar por vez · ~540 h/mês").
function direitosTexto(dir) {
  if (!dir) return '';
  return [
    dir.segundosPorHora ? `${dir.segundosPorHora} s por hora` : '',
    dir.pontos ? plural(dir.pontos, 'ponto') : '',
    dir.duracaoMaxima ? `peça até ${dir.duracaoMaxima} s` : '',
    dir.criativosNoAr ? `${dir.criativosNoAr} no ar por vez` : '',
    dir.horasPorMes ? `~${num(dir.horasPorMes)} h/mês` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

// Plano: o direito de veicular, com a ORIGEM, em fila — Agora → Próximo →
// Depois. Sem botão de conceder/alterar/cancelar plano (saíram da ficha:
// cortesia agora é crédito). Só a assinatura PAGA ativa tem uma ação aqui,
// discreta: cancelar a recorrência no San Checkout.
function desenharContaPlano(el, ctx) {
  const { s, bloqueada } = ctx;
  const p = s.plano;
  const etapa = (rotulo, corpo) =>
    `<li class="plano-etapa"><span class="plano-etapa-rotulo">${rotulo}</span><div class="plano-etapa-corpo">${corpo}</div></li>`;

  let agora;
  if (p.agora?.tipo === 'comercial') {
    const a = p.agora;
    const prazo = a.renovaEm
      ? `Próxima renovação ${data(a.renovaEm)}`
      : a.assinaturaCancelada
        ? `Assinatura cancelada — cobertura paga até ${data(a.validoAte)}, não renova`
        : a.validoAte
          ? `Válido até ${data(a.validoAte)}`
          : 'Sem prazo';
    agora = `<div class="plano-linha"><b class="conta-plano-nome">${esc(a.nome)}</b><span class="badge ${ORIGEM_CLASSE[a.origem] || 'badge-neutro'}">${esc(a.origemTexto)}</span></div>
      <p class="plano-meta">${prazo}${a.desde ? ` · desde ${data(a.desde)}` : ''}</p>
      ${a.direitos ? `<p class="plano-direitos">${esc(direitosTexto(a.direitos))}</p>` : ''}`;
  } else {
    agora = `<div class="plano-linha"><b class="conta-plano-nome">Sem plano</b></div>
      <p class="plano-meta">A conta não veicula na rede. Cortesia se dá por créditos, em “Créditos e benefícios”.</p>`;
  }

  const etapas = [etapa('Agora', agora)];
  if (p.proximo?.tipo === 'pago_guardado') {
    const x = p.proximo;
    etapas.push(
      etapa(
        'Próximo',
        `<div class="plano-linha"><b>${esc(x.nome)}</b><span class="badge ${ORIGEM_CLASSE.assinatura}">${esc(x.origemTexto)}</span></div>
        <p class="plano-meta">Guardado por baixo do benefício: volta ${x.comecaEm ? `em ${data(x.comecaEm)}` : 'quando ele acabar'} com ${plural(x.dias, 'dia pago', 'dias pagos')}${x.validoAte ? ` · até ${data(x.validoAte)}` : ''}</p>`,
      ),
    );
  } else if (p.proximo) {
    const x = p.proximo;
    etapas.push(
      etapa(
        'Próximo',
        `<div class="plano-linha"><b>${esc(x.nome)}</b><span class="badge ${ORIGEM_CLASSE[x.origem] || 'badge-neutro'}">${esc(x.origemTexto)}</span></div>
        <p class="plano-meta">Começa ${x.comecaEm ? `em ${data(x.comecaEm)}, ` : ''}quando o ciclo pago terminar · até ${data(x.validoAte)}</p>
        ${x.esperaAssinatura ? '<p class="plano-meta">A assinatura segue ativa: se renovar antes, o benefício espera o fim do novo ciclo, com a mesma duração.</p>' : ''}`,
      ),
    );
  }
  if (p.depois) {
    etapas.push(
      etapa(
        'Depois',
        `<p class="plano-meta plano-meta-forte">${p.depois.tipo === 'renova' ? '' : `Em ${data(p.depois.em)}: `}${esc(p.depois.texto)}</p>`,
      ),
    );
  }

  // "Veiculando" só com peça rodando de fato — plano sem criativo no ar não
  // passa nada na tela.
  const noAr = s.criativos.resumo.noAr;
  const veicula = !p.veicula
    ? `<span class="badge badge-neutro" title="${s.dados.suspensa ? 'Conta suspensa: fora da rotação.' : 'Sem plano vigente.'}">Não veicula</span>`
    : noAr
      ? '<span class="badge badge-ok">Veiculando</span>'
      : '<span class="badge badge-pendente" title="O plano está vigente, mas nenhum criativo aprovado está no ar.">Sem peça no ar</span>';
  const podeCancelarAssinatura = !bloqueada && p.agora?.origem === 'assinatura' && p.assinaturaAtiva;
  el.innerHTML = `
    <div class="secao-topo"><h3>Plano</h3><div class="secao-acoes">${veicula}</div></div>
    <ol class="plano-fila">${etapas.join('')}</ol>
    ${
      podeCancelarAssinatura
        ? '<div class="acoes secao-pe"><button type="button" class="btn perigo-sutil mini" data-cancelar-assinatura>Cancelar assinatura</button></div>'
        : ''
    }`;
  el.querySelector('[data-cancelar-assinatura]')?.addEventListener('click', () => abrirCancelarAssinatura(ctx));
}

// Créditos e benefícios: o jeito NORMAL de dar cortesia comercial. Saldo,
// concessão (quantidade + motivo + nota interna, com o admin e a hora
// gravados no ledger imutável) e os dois históricos, recolhidos.
function desenharContaCreditos(el, ctx) {
  const { s, bloqueada } = ctx;
  const cr = s.creditos;
  const movs = cr.movimentacoes;
  const bens = s.beneficios;
  el.innerHTML = `
    <div class="secao-topo"><h3>Créditos e benefícios</h3></div>
    <div class="creditos-topo">
      <div class="creditos-saldo"><span class="u-dim u-fs-78">Saldo</span><b>${plural(cr.saldo, 'crédito')}</b></div>
      ${bloqueada ? '' : '<button type="button" class="btn ghost mini" data-creditos-conceder>Conceder créditos</button>'}
    </div>
    <p class="campo-ajuda u-mt-4">A conta resgata o saldo pelo painel dela — o benefício entra na fila do plano, sem sobrepor o que já está em vigor.</p>
    ${
      movs.length
        ? `<details class="conta-historico" data-historico="movimentacoes"><summary>Movimentações (${movs.length})</summary><ul>${movs
            .map((m) => {
              const detalhes = [
                m.motivo
                  ? `<span class="u-dim">${m.tipo === 'concessao_admin' ? 'Motivo: ' : ''}${esc(m.motivo)}</span>`
                  : '',
                m.notaInterna ? `<span class="u-dim">Nota interna: ${esc(m.notaInterna)}</span>` : '',
              ].filter(Boolean);
              return `<li><b class="${m.quantidade > 0 ? 'creditos-entrada' : 'creditos-saida'}">${m.quantidade > 0 ? '+' : '−'}${num(Math.abs(m.quantidade))}</b> · ${esc(TIPO_CREDITO[m.tipo] || m.tipo)}${m.pontoNome ? ` · ${esc(m.pontoNome)}` : ''}${m.origemNome ? ` · ${esc(m.origemNome)}` : ''} · ${data(m.criadoEm)}${m.concedidoPor ? ` · por ${esc(m.concedidoPor)}` : ''}${detalhes.length ? `<br>${detalhes.join('<br>')}` : ''}</li>`;
            })
            .join('')}</ul></details>`
        : '<p class="texto-vazio u-mt-8">Nenhuma movimentação ainda.</p>'
    }
    ${
      bens.length
        ? `<details class="conta-historico" data-historico="beneficios"><summary>Histórico de benefícios (${bens.length})</summary><ul>${bens
            .map((b) => {
              const periodo =
                b.status === 'agendado'
                  ? `começa ${b.comecaEm ? data(b.comecaEm) : 'no fim do ciclo pago'} · até ${data(b.validoAte)}`
                  : `${data(b.inicio)} → ${b.encerradoEm ? data(b.encerradoEm) : data(b.validoAte)}`;
              return `<li><b>${esc(b.nome)}</b> · ${esc(b.origemTexto)}${b.custoCreditos ? ` (${plural(b.custoCreditos, 'crédito')})` : ''} · <span class="${b.status === 'encerrado' ? 'u-dim' : ''}">${esc(b.statusTexto)}</span><br><span class="u-dim">${periodo}${b.concedidoPor ? ` · por ${esc(b.concedidoPor)}` : ''}${b.observacao && b.origem !== 'beneficio_creditos' ? ` · ${esc(b.observacao)}` : ''}</span></li>`;
            })
            .join('')}</ul></details>`
        : ''
    }`;
  el.querySelector('[data-creditos-conceder]')?.addEventListener('click', () => abrirConcederCreditos(ctx));
}

// Pontos APROVADOS da conta (nunca candidatura) — card deitado: foto, nome,
// estado administrativo, endereço, telas e a saúde operacional resumida.
// Clique leva pro ponto na Rede; telas não se gerenciam daqui.
function desenharContaPontos(el, pontos) {
  el.innerHTML = `<div class="secao-topo"><h3>Pontos</h3><span class="contagem">${pontos.length}</span></div>
    <div class="itens-grade">${pontos
      .map((p) => {
        const endereco = [p.endereco, p.bairro].filter(Boolean).join(' · ');
        return `<a class="item-linha" href="#rede/pontos/${p.id}">
          <span class="item-linha-foto">${fotoOuPlaceholder(p.fotoUrl, p.nome)}</span>
          <span class="item-linha-corpo">
            <span class="item-linha-topo"><b>${esc(p.nome)}</b><span class="badge ${PONTO_STATUS_CLASSE[p.status] || 'badge-pendente'}">${esc(p.statusTexto)}</span></span>
            ${endereco ? `<span class="item-linha-meta">${esc(endereco)}</span>` : ''}
            <span class="item-linha-meta">${esc(p.cidade || '')}${p.uf ? `/${esc(p.uf)}` : ''} · ${p.telas ? plural(p.telas, 'tela') : 'sem tela'}</span>
            <span class="item-linha-meta saude-${p.saude.nivel}">${esc(p.saude.texto)}</span>
            <span class="item-linha-meta">Benefício: ${textoBeneficioPonto(p.beneficio)}</span>
          </span>
        </a>`;
      })
      .join('')}</div>`;
  ajustarFotos(el);
}

// Solicitações de ponto em análise — separadas de Pontos, discretas: pedido
// não é ponto, não dá selo, não gera crédito. Abre a candidatura em Rede.
function desenharContaSolicitacoes(el, solicitacoes) {
  el.innerHTML = `<div class="secao-topo"><h3>Solicitações de ponto</h3><span class="secao-nota">${plural(solicitacoes.length, 'em análise', 'em análise')}</span></div>
    <ul class="solicitacoes-lista">${solicitacoes
      .map((c) => {
        const endereco = [c.endereco, c.bairro, c.cidade].filter(Boolean).join(' · ');
        return `<li><a href="#rede/candidaturas/${c.id}"><b>${esc(c.nome || 'Sem nome')}</b>${endereco ? `<span class="item-meta">${esc(endereco)}</span>` : ''}</a><span class="item-meta">Enviada em ${data(c.enviadaEm)}</span></li>`;
      })
      .join('')}</ul>`;
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
  const podeAdicionar = !bloqueada && cadastrados < info.limite_cadastro;

  const cards = criativos
    .map((c) => {
      const estado = estadoCriativo(c, info);
      const ehVideo = !ehImagemArquivo(c.arquivo_original_url);
      // Ações de card são secundárias (nenhum laranja por card); retirar e
      // recusar têm a cor de ação destrutiva.
      const acoes = [];
      acoes.push(`<button type="button" class="btn ghost mini" data-cr-ver="${c.id}">Ver</button>`);
      if (!bloqueada) {
        if (c.status === 'pendente') {
          acoes.push(`<button type="button" class="btn ghost mini" data-cr-aprovar="${c.id}">Aprovar</button>`);
          acoes.push(`<button type="button" class="btn ghost mini" data-cr-arquivo="${c.id}">Trocar arquivo</button>`);
          acoes.push(`<button type="button" class="btn perigo-sutil mini" data-cr-recusar="${c.id}">Recusar</button>`);
        } else if (c.status === 'aprovado') {
          if (!substitutoDe[c.id]) {
            acoes.push(`<button type="button" class="btn ghost mini" data-cr-substituir="${c.id}">Substituir</button>`);
          }
          acoes.push(
            `<button type="button" class="btn perigo-sutil mini" data-cr-retirar="${c.id}">Retirar do ar</button>`,
          );
        } else if (c.status === 'retirado') {
          acoes.push(`<button type="button" class="btn ghost mini" data-cr-colocar="${c.id}">Colocar no ar</button>`);
        } else if (c.status === 'reprovado') {
          acoes.push(`<button type="button" class="btn ghost mini" data-cr-arquivo="${c.id}">Trocar arquivo</button>`);
        }
      }
      // Sem "#12" (id interno) na tela: a relação entre peças é dita em
      // palavras — "substitui a peça no ar", "tem substituto em análise".
      const notas = [
        c.substitui_criativo_id && c.status === 'pendente'
          ? 'Substitui a peça que está no ar — ela segue no ar até esta ser aprovada.'
          : '',
        substitutoDe[c.id] ? 'Tem um substituto em análise.' : '',
        estado.dica || '',
        c.status === 'reprovado' && c.motivo_reprovacao ? `Motivo: ${c.motivo_reprovacao}` : '',
      ].filter(Boolean);
      return `<article class="criativo-item">
        <div class="criativo-item-midia">${montarPreviewAsset({ original: c.arquivo_original_url, normalizado: c.arquivo_normalizado_url, thumb: c.thumbnail_url })}</div>
        <div class="criativo-item-corpo">
          <div class="item-topo"><h4>${ehVideo ? 'Vídeo' : 'Imagem'}${c.duracao_segundos ? ` · ${c.duracao_segundos}s` : ''}</h4><span class="badge ${estado.classe}">${estado.nome}</span></div>
          <p class="item-meta">Enviado ${data(c.created_at)}${c.editado_pelo_operador ? ' pelo Mostraí' : ''}</p>
          ${notas.map((n) => `<p class="item-nota">${esc(n)}</p>`).join('')}
          <div class="acoes item-acoes">${acoes.join('')}</div>
        </div>
      </article>`;
    })
    .join('');

  // Os números que respondem "quantos pode ter, quantos rodam e em que pé
  // está cada um" — limite da CONTA (cadastro) separado do limite do PLANO
  // (simultâneos no ar), que são regras diferentes (lib/limites.js ×
  // gerador.js#limiteDeCriativos).
  const r = ctx.s.criativos.resumo;
  const semAr = ctx.s.dados.suspensa
    ? 'conta suspensa'
    : ctx.s.dados.excluidaEm
      ? 'conta excluída'
      : 'sem plano vigente';
  const contagens = [
    `<span><b>${r.cadastrados} de ${r.limiteConta}</b> cadastrados <span class="u-dim">(limite da conta)</span></span>`,
    r.contaVeicula
      ? `<span><b>${r.noAr} de ${r.limiteNoAr}</b> no ar <span class="u-dim">(simultâneos do plano)</span></span>`
      : `<span class="u-dim">Nenhum no ar — ${semAr}</span>`,
    r.emAnalise ? `<span>${plural(r.emAnalise, 'em análise', 'em análise')}</span>` : '',
    r.substituicoesPendentes
      ? `<span>${plural(r.substituicoesPendentes, 'substituição pendente', 'substituições pendentes')}</span>`
      : '',
    r.aprovadosForaDoAr
      ? `<span>${plural(r.aprovadosForaDoAr, 'aprovado fora do ar', 'aprovados fora do ar')}</span>`
      : '',
    r.retirados ? `<span>${plural(r.retirados, 'retirado do ar', 'retirados do ar')}</span>` : '',
    r.recusados ? `<span>${plural(r.recusados, 'recusado', 'recusados')}</span>` : '',
  ].filter(Boolean);
  el.innerHTML = `
    <div class="secao-topo">
      <h3>Criativos</h3>
      ${podeAdicionar ? '<div class="secao-acoes"><button type="button" class="btn ghost mini" data-cr-adicionar>+ Adicionar criativo</button></div>' : ''}
    </div>
    <p class="criativos-contagens">${contagens.join('')}</p>
    ${
      criativos.length
        ? `<div class="criativos-grade">${cards}</div>`
        : '<p class="texto-vazio">Nenhum criativo nesta conta ainda.</p>'
    }
    ${bloqueada ? '<p class="campo-ajuda u-mt-12">Conta suspensa ou excluída — criativos só leitura.</p>' : !podeAdicionar && criativos.length ? `<p class="campo-ajuda u-mt-12">Limite de ${info.limite_cadastro} criativos cadastrados atingido — substitua ou retire um pra trocar.</p>` : ''}`;

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
          texto: '<p>Esta peça entra no ar e a que está no ar hoje sai (fica cadastrada como “fora do ar”).</p>',
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
        texto:
          '<p>A peça sai da rotação das telas agora. Continua cadastrada na conta e pode voltar pro ar depois.</p>',
        botao: 'Retirar do ar',
        perigo: true,
      });
      if (ok && (await salvar(`/admin/criativos/${c.id}`, { status: 'retirado' }))) recarregar();
    }),
  );
  el.querySelectorAll('[data-cr-colocar]').forEach((b) =>
    b.addEventListener('click', async () => {
      const c = achar(b.dataset.crColocar);
      const ok = await confirmarModal({
        titulo: 'Colocar no ar?',
        texto: `<p>A peça volta a ser aprovada. ${info.limite_no_ar ? `O plano põe ${info.limite_no_ar} no ar por vez — se passar disso, rodam os mais recentes.` : 'A conta precisa de plano vigente pra ele rodar.'}</p>`,
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
        titulo: 'Substituir criativo',
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
        titulo: 'Trocar arquivo do criativo',
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
    titulo: 'Criativo',
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
    titulo: 'Recusar criativo',
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

// ---------- créditos e assinatura: modais ----------
// "Conceder plano", "Alterar plano" e "Cancelar plano" (cortesia) SAÍRAM da
// ficha na revisão de 23/09/2026 (pedido do dono): cortesia comercial é
// crédito, que a conta resgata e entra na MESMA fila de benefícios, sem
// sobrepor nada. As rotas antigas ficam no servidor como ferramenta técnica
// de correção, sem tela, e recusam mexer em benefício pago com créditos.
// Cortesias administrativas já concedidas continuam valendo até o fim — a
// ficha mostra como "Cortesia administrativa legada".

// Conceder créditos: quantidade + motivo (o cliente lê) + nota interna (só
// o time lê). Quem concedeu e quando o ledger grava sozinho. A tabela de
// referência vem do servidor (mesma régua do resgate, creditos/regras.js).
function abrirConcederCreditos(ctx) {
  const { s, conta, recarregar } = ctx;
  const ref = s.creditos.referencia;
  const { dlg, fechar } = abrirModal({
    titulo: 'Conceder créditos',
    corpo: `<form id="formConcederCreditos" class="modal-form">
        <div><label for="creditosQtd">Quantidade</label><input type="number" id="creditosQtd" name="quantidade" min="1" max="100000" step="1" required inputmode="numeric"></div>
        <p class="creditos-referencia">Referência por mês de benefício: ${ref
          .map((r) => `<b>${esc(r.nome)}</b> ${plural(r.porMes, 'crédito')}`)
          .join(
            ' · ',
          )}. Ex.: ${esc(ref[ref.length - 1]?.nome || 'Prime')} por 12 meses = ${num(ref[ref.length - 1]?.anual || 120)} créditos.</p>
        <div><label for="creditosMotivo">Motivo <span class="u-dim">(o cliente lê no extrato)</span></label><input type="text" id="creditosMotivo" name="motivo" maxlength="200" required placeholder="ex.: parceria de lançamento"></div>
        <div><label for="creditosNota">Nota interna <span class="u-dim">(opcional, só o time vê)</span></label><textarea id="creditosNota" name="nota_interna" rows="2" maxlength="500" placeholder="ex.: combinado por WhatsApp em 20/09"></textarea></div>
        <p class="campo-ajuda" data-previa>Saldo agora: <b>${plural(s.creditos.saldo, 'crédito')}</b>.</p>
        <p class="form-msg" data-msg role="status"></p>
      </form>`,
    rodape: `<button type="button" class="btn ghost" data-fechar>Cancelar</button><button type="submit" form="formConcederCreditos" class="btn primary">Conceder</button>`,
  });
  const form = dlg.querySelector('#formConcederCreditos');
  const previa = dlg.querySelector('[data-previa]');
  form.quantidade.addEventListener('input', () => {
    const q = Number(form.quantidade.value);
    previa.innerHTML =
      Number.isInteger(q) && q > 0
        ? `Saldo: <b>${plural(s.creditos.saldo, 'crédito')}</b> → <b>${plural(s.creditos.saldo + q, 'crédito')}</b>. Fica registrado quem concedeu e quando.`
        : `Saldo agora: <b>${plural(s.creditos.saldo, 'crédito')}</b>.`;
  });
  form.quantidade.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const quantidade = Number(form.quantidade.value);
    const motivo = form.motivo.value.trim();
    if (!Number.isInteger(quantidade) || quantidade <= 0) {
      return erroNoModal(dlg, 'Quantidade precisa ser um número inteiro positivo.');
    }
    if (!motivo) return erroNoModal(dlg, 'Descreva o motivo — é o que o cliente lê.');
    const botao = dlg.querySelector('[type="submit"]');
    botao.disabled = true;
    const r = await api(`/admin/anunciantes/${conta.id}/creditos/conceder`, {
      method: 'POST',
      body: JSON.stringify({ quantidade, motivo, nota_interna: form.nota_interna.value.trim() }),
    });
    if (!r.ok) {
      botao.disabled = false;
      return erroNoModal(
        dlg,
        window.frase((await r.json().catch(() => ({}))).erro || 'Não foi possível conceder os créditos.'),
      );
    }
    toast(`${plural(quantidade, 'crédito concedido', 'créditos concedidos')}.`);
    fechar();
    recarregar();
  });
}

// Cancelar a ASSINATURA paga (recorrência no San Checkout). A cobertura já
// paga continua até o fim do ciclo; nada é reembolsado. Não existe mais
// "cancelar cortesia" pela ficha.
function abrirCancelarAssinatura(ctx) {
  const { s, conta, recarregar } = ctx;
  const a = s.plano.agora;
  const { dlg, fechar } = abrirModal({
    titulo: 'Cancelar assinatura?',
    corpo: `<p>A assinatura de <b>${esc(a.nome)}</b> é cancelada no San Checkout e a cobrança recorrente para. A cobertura já paga continua valendo até ${a.validoAte ? data(a.validoAte) : 'o fim do ciclo'} — o anúncio não sai do ar hoje. Nenhum reembolso é gerado.</p>
      ${s.plano.proximo ? `<p class="u-dim u-fs-85">O benefício programado (${esc(s.plano.proximo.nome)}) começa quando a cobertura paga terminar.</p>` : ''}
      <p class="form-msg" data-msg role="status"></p>`,
    rodape: `<button type="button" class="btn ghost" data-fechar>Voltar</button><button type="button" class="btn perigo" data-confirmar>Cancelar assinatura</button>`,
  });
  const botao = dlg.querySelector('[data-confirmar]');
  botao.addEventListener('click', async () => {
    botao.disabled = true;
    const r = await api(`/admin/anunciantes/${conta.id}/cancelar-assinatura`, { method: 'POST' });
    if (!r.ok) {
      botao.disabled = false;
      return erroNoModal(dlg, window.frase((await r.json().catch(() => ({}))).erro || 'Não foi possível cancelar.'));
    }
    toast('Assinatura cancelada. A cobertura paga continua até expirar.');
    fechar();
    recarregar();
  });
}

// ---------- suspensão (Partes 26-29) ----------
// No fim da ficha, discreto e vermelho. Suspender bloqueia login, painel,
// compra, resgate, upload e mudança comercial; NÃO desliga os pontos físicos
// da conta (a TV autentica pelo aparelho) nem apaga histórico. Os criativos
// comerciais saem da rotação (o gerador ignora conta suspensa). Confirmação
// séria: o botão só libera depois de marcar que entendeu.
function desenharContaRodape(el, { conta, recarregar }) {
  el.innerHTML = `
    ${conta.excluidaEm ? '<button type="button" class="btn ghost mini" data-restaurar>Restaurar conta</button>' : ''}
    ${
      conta.suspensa
        ? '<button type="button" class="btn ghost mini" data-reativar>Reativar conta</button>'
        : '<button type="button" class="btn perigo-sutil mini" data-suspender>Suspender conta</button>'
    }`;
  el.querySelector('[data-suspender]')?.addEventListener('click', () => {
    const { dlg, fechar } = abrirModal({
      titulo: 'Suspender esta conta?',
      corpo: `<p class="u-mt-0">Enquanto suspensa, <b>${esc(conta.nome)}</b>:</p>
        <ul class="lista-consequencias">
          <li>perde o acesso ao painel (a sessão aberta cai);</li>
          <li>não compra, não resgata créditos, não sobe nem altera criativos;</li>
          <li>não faz nenhuma mudança comercial;</li>
          <li>sai da rotação: os anúncios dela deixam de passar nas telas.</li>
        </ul>
        <p class="u-dim u-fs-85">Os pontos físicos da conta continuam funcionando — a tela não é desligada. Nada é apagado: plano, créditos e histórico ficam como estão, e dá pra reativar depois.</p>
        <label class="confirmar-serio"><input type="checkbox" data-entendi> Entendi — suspender ${esc(conta.nome)}</label>
        <p class="form-msg" data-msg role="status"></p>`,
      rodape:
        '<button type="button" class="btn ghost" data-fechar>Voltar</button><button type="button" class="btn perigo" data-confirmar disabled>Suspender conta</button>',
    });
    const botao = dlg.querySelector('[data-confirmar]');
    dlg.querySelector('[data-entendi]').addEventListener('change', (e) => {
      botao.disabled = !e.target.checked;
    });
    botao.addEventListener('click', async () => {
      botao.disabled = true;
      if (await salvar(`/admin/anunciantes/${conta.id}`, { suspenso: true })) {
        fechar();
        recarregar();
      } else {
        botao.disabled = false;
      }
    });
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
  const endereco = [c.endereco, c.bairro].filter(Boolean).join(' · ');
  return cardEntidade({
    href: `#rede/candidaturas/${c.id}`,
    foto: fotoOuPlaceholder(c.foto_fachada_url, nome),
    nome: esc(nome),
    badge: '<span class="badge badge-pendente">Em análise</span>',
    meta: `${endereco ? `${esc(endereco)}<br>` : ''}${esc(c.cidade || '')}${c.uf ? `/${esc(c.uf)}` : ''}${c.segmento ? ` · ${esc(c.segmento)}` : ''}`,
    rodape: `${c.fluxo_estimado_mensal ? `${num(c.fluxo_estimado_mensal)} pessoas/mês · ` : ''}enviada ${data(c.criado_em)}`,
  });
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
        unidade: 'candidatura|candidaturas',
      })
    : vazio('Nenhuma candidatura aguardando análise.', 'Pedido de ponto feito no painel de uma conta aparece aqui.');

  if (pendentes.length) {
    turbinarCards(el.querySelector('.colecao'), '.ponto-card', 'candidatura');
    ajustarFotos(el);
  }
}

async function renderCandidaturaDetalhe(el, id) {
  const todas = await pegar('/admin/candidaturas');
  const c = todas.find((x) => x.id === id);
  if (!c) {
    el.innerHTML = `${migalha([{ rotulo: 'Candidaturas', href: '#rede/candidaturas' }])}${vazio('Candidatura não encontrada.')}`;
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

  const naoInformado = '<span class="u-dim">não informado</span>';
  el.innerHTML = `
    ${migalha([{ rotulo: 'Candidaturas', href: '#rede/candidaturas' }, { rotulo: nome }])}
    <section class="panel ficha-candidatura">
      ${fichaCabecalho({
        foto: fotoOuPlaceholder(c.foto_fachada_url, nome),
        nome: esc(nome),
        badge,
        endereco: enderecoFicha(c),
        meta: c.segmento ? esc(c.segmento) : 'Sem segmento informado',
      })}
      <dl class="dados dados-3">
        <div><dt>Responsável</dt><dd>${esc(c.nome)}${telefoneWpp ? `<a class="dado-sub" href="https://wa.me/55${telefoneWpp}" target="_blank" rel="noopener">${esc(c.contato_telefone)} (WhatsApp)</a>` : ''}</dd></div>
        <div><dt>E-mail</dt><dd>${c.contato_email ? esc(c.contato_email) : naoInformado}</dd></div>
        <div><dt>Movimento estimado</dt><dd>${c.fluxo_estimado_mensal ? `${num(c.fluxo_estimado_mensal)} pessoas/mês` : naoInformado}</dd></div>
        <div class="dados-largo"><dt>Horário de funcionamento</dt><dd>${c.horario_semanal ? horarioEmLinhas(c.horario_semanal) : naoInformado}</dd></div>
        ${c.mensagem ? `<div class="dados-largo"><dt>Observações</dt><dd>${esc(c.mensagem)}</dd></div>` : ''}
        <div><dt>Enviada em</dt><dd>${data(c.criado_em)}</dd></div>
      </dl>
      ${
        pendente
          ? `<div class="ficha-acoes">
        <p class="form-msg" id="candDetalheMsg" role="status"></p>
        <button class="btn perigo-sutil" type="button" data-recusar="${c.id}">Recusar</button>
        <button class="btn primary" type="button" data-aprovar="${c.id}">Aprovar ponto</button>
      </div>`
          : ''
      }
    </section>`;
  ajustarFotos(el);

  if (!pendente) return;
  const msg = document.getElementById('candDetalheMsg');
  el.querySelector('[data-aprovar]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    // Sem "e a Tela 1": desde a rodada final da Rede (22/09/2026) o ponto
    // nasce SEM tela, como "aguardando instalação" — a tela é criada na
    // instalação de verdade (src/conta/modos.js).
    const ok = await confirmarModal({
      titulo: `Aprovar “${nome}”?`,
      texto: '<p>O ponto nasce agora com esses dados, como <b>aguardando instalação</b>.</p>',
      botao: 'Aprovar ponto',
    });
    if (!ok) return;
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
      copiarTexto(link).catch(() => {});
      mostrarLink({
        titulo: 'Convite gerado',
        texto:
          'Esta candidatura é antiga, sem conta vinculada. Mande este link pra pessoa criar a conta e virar ponto (já foi copiado).',
        link,
      });
    }
    toast('Candidatura aprovada.');
    RESUMO = await pegar('/admin/resumo');
    pintarContadores();
    irPara('rede/candidaturas');
  });
  el.querySelector('[data-recusar]').addEventListener('click', async () => {
    const ok = await confirmarModal({
      titulo: `Recusar “${nome}”?`,
      texto: '<p>A candidatura sai da fila de análise. Nenhum ponto é criado.</p>',
      botao: 'Recusar candidatura',
      perigo: true,
    });
    if (!ok) return;
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
    copiarTexto(link).catch(() => {});
    prompt('Convite gerado (já copiado). Mande esse link pra pessoa:', link);
    _renderConvites(el);
  });
  el.querySelectorAll('[data-copiar-link]').forEach((btn) =>
    btn.addEventListener('click', () => {
      copiarTexto(btn.dataset.copiarLink).then(
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

// Mesma estrutura em todo ciclo (polimento final, 23/09/2026): preço final
// dominante; embaixo, o equivalente por mês, o preço cheio riscado e a
// economia em verde — uma informação por linha, nunca quebrando no meio. O
// selo "-10%" colado no riscado saiu: o desconto já está no campo do próprio
// ciclo, logo acima. Mensal sem desconto diz o que é (a base dos outros
// ciclos) em vez de deixar linhas vazias.
function montarPreviewCiclo(meses, preview) {
  const temDesconto = preview.economia > 0;
  const linhas =
    meses === 1 && !temDesconto
      ? ['sem desconto', 'base dos outros ciclos']
      : [
          meses === 1 ? '' : `equivale a ${fmt(preview.porMes)}/mês`,
          temDesconto ? `<s>${fmt(preview.cheio)}</s>` : 'sem desconto neste ciclo',
          temDesconto ? `<span class="oferta-economia">economiza ${fmt(preview.economia)}</span>` : '',
        ].filter(Boolean);
  return `<div class="oferta-preco">
    <b class="oferta-preco-final">${fmt(preview.final)}${meses === 1 ? '<small>/mês</small>' : ''}</b>
    ${linhas.map((l) => `<span class="oferta-preco-linha">${l}</span>`).join('')}
  </div>`;
}

function montarCardProduto(p) {
  return `
    <section class="panel oferta-produto" data-produto="${p.tier}">
      <div class="oferta-produto-cabecalho">
        <h3>${esc(p.nome)}</h3>
        <label class="campo-moeda" title="Preço mensal cheio — os ciclos aplicam o desconto sobre ele">
          <span class="campo-moeda-rotulo">Preço-base</span>
          <span class="campo-moeda-caixa">R$<input type="number" step="0.01" min="0.01" class="oferta-preco-base" value="${p.precoBase}" aria-label="Preço-base mensal de ${esc(p.nome)}"><small>/mês</small></span>
        </label>
      </div>
      <div class="oferta-ciclos">
        ${Object.entries(CICLOS)
          .map(([meses, nome]) => {
            const ciclo = p.ciclos[meses];
            const preview = calcularPreviewCiclo(p.precoBase, Number(meses), ciclo?.descontoPercentual);
            return `<div class="oferta-ciclo" data-meses="${meses}">
              <div class="oferta-ciclo-topo">
                <span class="oferta-ciclo-nome">${nome}</span>
                <label class="campo-desconto" title="Desconto do ciclo sobre o preço-base">
                  <span class="u-sr">Desconto ${nome.toLowerCase()} de ${esc(p.nome)}</span>
                  <span class="campo-desconto-sinal" aria-hidden="true">−</span><input type="number" class="oferta-desconto" step="0.01" min="0" max="99" value="${ciclo?.descontoPercentual ?? ''}" placeholder="0"><span aria-hidden="true">%</span>
                </label>
              </div>
              <div data-preview>${montarPreviewCiclo(Number(meses), preview)}</div>
            </div>`;
          })
          .join('')}
      </div>
      <div class="oferta-produto-pe">
        <p class="form-msg" data-msg-produto="${p.tier}" role="status"></p>
        <button class="btn ghost" data-salvar-produto="${p.tier}" disabled>Salvar</button>
      </div>
    </section>`;
}

async function renderPrecos(el) {
  const produtos = await pegar('/admin/ofertas/produtos');
  el.innerHTML = `
    <section class="secao-pagina">
      <div class="secao-topo"><h3>Planos comerciais</h3><span class="secao-nota">o desconto de cada ciclo incide sobre o preço-base</span></div>
      <div class="oferta-produtos-grid">${produtos.map(montarCardProduto).join('')}</div>
    </section>`;

  // Recalcula os 4 previews ao vivo, sem esperar salvar — mesma régua da
  // vitrine pública, só que antes de publicar. O "Salvar" do card só acende
  // (vira a ação principal) quando algo mudou de verdade — três botões
  // laranja fixos competiam entre si o tempo todo.
  el.querySelectorAll('.oferta-produto').forEach((cartao) => {
    const btn = cartao.querySelector('[data-salvar-produto]');
    const campos = [...cartao.querySelectorAll('.oferta-preco-base, .oferta-desconto')];
    const original = campos.map((c) => c.value);
    const pintarSalvar = () => {
      const mudou = campos.some((c, i) => c.value !== original[i]);
      btn.disabled = !mudou;
      btn.classList.toggle('primary', mudou);
      btn.classList.toggle('ghost', !mudou);
      btn.textContent = mudou ? 'Salvar alterações' : 'Salvar';
    };
    const recalcular = () => {
      const precoBase = Number(cartao.querySelector('.oferta-preco-base').value) || 0;
      cartao.querySelectorAll('.oferta-ciclo').forEach((linha) => {
        const meses = Number(linha.dataset.meses);
        const desconto = linha.querySelector('.oferta-desconto').value;
        const preview = calcularPreviewCiclo(precoBase, meses, desconto);
        linha.querySelector('[data-preview]').innerHTML = montarPreviewCiclo(meses, preview);
      });
      pintarSalvar();
    };
    campos.forEach((inp) => inp.addEventListener('input', recalcular));
    // Depois de salvar, o que está na tela vira o novo "original".
    cartao.addEventListener('salvo', () => {
      campos.forEach((c, i) => {
        original[i] = c.value;
      });
      pintarSalvar();
    });
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
      btn.disabled = true;
      const r = await api(`/admin/ofertas/produtos/${tier}`, { method: 'PATCH', body: JSON.stringify(corpo) });
      if (!r.ok) {
        btn.disabled = false;
        msg.textContent = (await r.json().catch(() => ({}))).erro || 'Não foi possível salvar.';
        msg.className = 'form-msg err';
        return;
      }
      msg.textContent = 'Salvo.';
      msg.className = 'form-msg ok';
      cartao.dispatchEvent(new Event('salvo'));
      toast(`${NOME_TIER[tier] || 'Plano'} atualizado.`);
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
      badge: promo.status === 'rascunho' ? 'badge-pendente' : 'badge-neutro',
    };
  if (promo.compra_fim && new Date(promo.compra_fim) < agora) return { rotulo: 'Encerrada', badge: 'badge-neutro' };
  if (promo.compra_inicio && new Date(promo.compra_inicio) > agora) return { rotulo: 'Agendada', badge: 'badge-info' };
  if (promo.limite_adesoes != null && promo.adesoes >= promo.limite_adesoes)
    return { rotulo: 'Esgotada', badge: 'badge-neutro' };
  return { rotulo: 'Ativa', badge: 'badge-ok' };
}

// Grupo da listagem (polimento final, 23/09/2026): vigentes, futuras,
// rascunhos e encerradas em blocos próprios, na ordem em que o admin precisa
// olhar — a vigente não se perde entre as encerradas.
const GRUPOS_PROMOCAO = [
  ['vigente', 'Vigentes'],
  ['futura', 'Futuras'],
  ['rascunho', 'Rascunhos'],
  ['encerrada', 'Encerradas'],
];
function grupoPromocao(promo) {
  if (promo.status === 'rascunho') return 'rascunho';
  if (promo.status === 'encerrada') return 'encerrada';
  const { rotulo } = statusExibicaoPromocao(promo);
  if (rotulo === 'Agendada') return 'futura';
  if (rotulo === 'Encerrada' || rotulo === 'Esgotada') return 'encerrada';
  return 'vigente';
}

function periodoPromocao(promo) {
  const ini = promo.compra_inicio ? data(promo.compra_inicio) : null;
  const fim = promo.compra_fim ? data(promo.compra_fim) : null;
  if (ini && fim) return `${ini} até ${fim}`;
  if (fim) return `até ${fim}`;
  if (ini) return `a partir de ${ini}`;
  return 'sem prazo';
}

// Produtos × ciclos agrupados por produto, em etiquetas ("Pro: Trimestral
// −20% · Anual −25%" como frase corrida lia como dado técnico).
function ciclosPromocaoHtml(itens) {
  const porTier = {};
  (itens || []).forEach((i) => {
    porTier[i.tier] = porTier[i.tier] || [];
    porTier[i.tier].push(i);
  });
  const tiers = Object.keys(NOME_TIER).filter((t) => porTier[t]);
  if (!tiers.length) return '<span class="u-dim">nenhum produto ou ciclo — não muda preço</span>';
  return tiers
    .map(
      (t) =>
        `<span class="promo-produto"><b>${NOME_TIER[t]}</b>${porTier[t]
          .sort((a, b) => a.compromissoMeses - b.compromissoMeses)
          .map(
            (i) =>
              `<span class="etiqueta">${CICLOS[i.compromissoMeses] || `${i.compromissoMeses} meses`} −${pct(i.descontoPercentual, 2)}</span>`,
          )
          .join('')}</span>`,
    )
    .join('');
}

// Card deitado de largura inteira (polimento final, 23/09/2026): com uma
// promoção só, o card estreito deixava a tela vazia; e sem imagem, o
// retângulo cinza no topo parecia imagem quebrada — agora sem imagem não
// há área de mídia nenhuma. Título domina, estado no mesmo cabeçalho, os
// fatos em colunas rotuladas e os ciclos em etiquetas por produto.
function montarCardPromocao(promo) {
  const st = statusExibicaoPromocao(promo);
  const onde =
    [promo.mostrar_home ? 'Home' : null, promo.mostrar_planos ? 'Planos' : null].filter(Boolean).join(' · ') ||
    'nenhum lugar';
  const grupo = grupoPromocao(promo);
  const acoes = [
    `<button class="btn ghost mini" data-editar-promocao="${promo.id}">Editar</button>`,
    promo.status === 'rascunho'
      ? `<button class="btn ghost mini" data-mudar-status="${promo.id}" data-novo-status="ativa">Publicar</button>`
      : '',
    promo.status === 'ativa'
      ? `<button class="btn ghost mini" data-mudar-status="${promo.id}" data-novo-status="encerrada">Encerrar</button>`
      : '',
    promo.status === 'encerrada'
      ? `<button class="btn ghost mini" data-mudar-status="${promo.id}" data-novo-status="ativa">Reabrir</button>`
      : '',
    promo.adesoes === 0
      ? `<button class="btn perigo-sutil mini" data-excluir-promocao="${promo.id}">Excluir</button>`
      : '',
  ].join('');
  return `<article class="promo-item ${grupo === 'encerrada' ? 'promo-item-apagada' : ''}" data-promocao="${promo.id}">
    ${
      promo.imagem_url
        ? `<div class="promo-item-midia formato-${esc(promo.formato_midia || 'horizontal')}"><img src="${esc(promo.imagem_url)}" alt=""></div>`
        : ''
    }
    <div class="promo-item-corpo">
      <header class="promo-item-topo">
        <div class="promo-item-titulo">
          <h4>${esc(promo.titulo_publico)}</h4>
          <span class="badge ${st.badge}">${st.rotulo}</span>
          ${promo.selo ? `<span class="etiqueta etiqueta-selo">${esc(promo.selo)}</span>` : ''}
        </div>
        <div class="acoes">${acoes}</div>
      </header>
      <p class="promo-item-interno">Nome interno: ${esc(promo.nome_interno)}</p>
      <dl class="promo-fatos">
        <div><dt>Período de compra</dt><dd>${periodoPromocao(promo)}</dd></div>
        <div><dt>Público</dt><dd>${PUBLICO_ELEGIVEL[promo.publico_elegivel] || promo.publico_elegivel}</dd></div>
        <div><dt>Exposição</dt><dd>${onde}</dd></div>
        <div><dt>Duração</dt><dd>${plural(promo.duracao_beneficio_meses, 'mês', 'meses')} de desconto</dd></div>
        <div><dt>Adesões</dt><dd>${promo.limite_adesoes != null ? `${promo.adesoes} de ${promo.limite_adesoes}` : num(promo.adesoes)}</dd></div>
      </dl>
      <div class="promo-ciclos"><span class="promo-ciclos-rotulo">Ciclos</span>${ciclosPromocaoHtml(promo.itens)}</div>
    </div>
  </article>`;
}

// Formulário de criação/edição — mesmo formulário serve os dois casos
// (`promo` null/objeto diferencia POST de PATCH).
const FORMATO_MIDIA = {
  horizontal: { nome: 'Banner horizontal', hint: 'Home · 21:9' },
  quadrado: { nome: 'Quadrado', hint: 'Card · 1:1' },
  vertical: { nome: 'Vertical', hint: 'Celular · 9:16' },
};
const PUBLICO_ELEGIVEL = { novos: 'Novos usuários', assinantes: 'Assinantes atuais', todos: 'Todos' };
const STATUS_PROMOCAO = { rascunho: 'Rascunho', ativa: 'Ativa', encerrada: 'Encerrada' };

// Formulário em duas colunas (polimento final, 23/09/2026): à esquerda os
// blocos (identidade, mídia, janela, público e condição, produtos e ciclos,
// exposição, status); à direita, fixa na tela, a prévia de como a promoção
// aparece na Home e em Planos e um resumo curto da campanha — antes era um
// formulário estreito e comprido, configurado às cegas.
//
// Seleção com um padrão por tipo de controle: escolha única = segmentado
// (público, status), liga/desliga = interruptor (Home/Planos), escolha
// visual = card selecionável (formato e as células da matriz).
function montarFormularioPromocao(promo) {
  const item = (tier, meses) => (promo?.itens || []).find((i) => i.tier === tier && i.compromissoMeses === meses);
  const status = promo?.status || 'rascunho';
  const publicoElegivel = promo?.publico_elegivel || 'todos';
  // "Encerrada" não é um estado de criação — só aparece editando uma que
  // já existe (e aí serve pra reabrir/encerrar pelo próprio formulário).
  const opcoesStatus = promo ? STATUS_PROMOCAO : { rascunho: STATUS_PROMOCAO.rascunho, ativa: STATUS_PROMOCAO.ativa };
  const isoLocal = (v) => (v ? new Date(v).toISOString().slice(0, 16) : '');
  return `
    <form class="panel promo-form painel-form" id="formPromocao">
      <div class="secao-topo">
        <h3>${promo ? 'Editar promoção' : 'Nova promoção'}</h3>
        ${promo ? `<span class="secao-nota">${esc(promo.nome_interno)}</span>` : ''}
        <div class="secao-acoes"><button class="botao-fechar" type="button" id="btnFecharPromocao" aria-label="Fechar">×</button></div>
      </div>
      <div class="promo-form-grid">
        <div class="promo-form-campos">
          <fieldset class="form-bloco">
            <legend>Identidade</legend>
            <div class="campos">
              <div class="campo-grupo"><label for="pNomeInterno">Nome interno</label><input id="pNomeInterno" name="nome_interno" required value="${esc(promo?.nome_interno || '')}" placeholder="ex.: primavera-2026"><span class="campo-ajuda">Só aparece aqui no admin.</span></div>
              <div class="campo-grupo"><label for="pSelo">Selo curto</label><input id="pSelo" name="selo" maxlength="30" value="${esc(promo?.selo || '')}" placeholder="ex.: Pré-venda"><span class="campo-ajuda">Etiqueta sobre o título e o preço.</span></div>
            </div>
            <div class="campo-grupo"><label for="pTitulo">Título público</label><input id="pTitulo" name="titulo_publico" required value="${esc(promo?.titulo_publico || '')}" placeholder="ex.: Primavera Mostraí: até 25% off"></div>
            <div class="campo-grupo"><label for="pSubtitulo">Subtítulo</label><input id="pSubtitulo" name="subtitulo" value="${esc(promo?.subtitulo || '')}"></div>
            <div class="campo-grupo"><label for="pDescricao">Descrição</label><textarea id="pDescricao" name="descricao" rows="2">${esc(promo?.descricao || '')}</textarea></div>
          </fieldset>

          <fieldset class="form-bloco">
            <legend>Mídia</legend>
            <div class="formato-picker" role="radiogroup" aria-label="Formato da imagem">
              ${Object.entries(FORMATO_MIDIA)
                .map(
                  ([valor, f]) => `<label class="selecionavel formato-opcao">
                  <input type="radio" name="formato_midia" value="${valor}" ${promo?.formato_midia === valor ? 'checked' : ''}>
                  <span class="selecionavel-check" aria-hidden="true"></span>
                  <span class="formato-forma formato-forma-${valor}" aria-hidden="true"></span>
                  <span class="formato-nome">${f.nome}</span>
                  <span class="formato-uso">${f.hint}</span>
                </label>`,
                )
                .join('')}
            </div>
            <div class="promo-upload">
              <div class="promo-upload-preview" id="promoMidiaPreview"></div>
              <div class="promo-upload-info">
                <span class="promo-upload-nome" id="promoArquivoNome"></span>
                <div class="acoes">
                  <button type="button" class="btn ghost mini" data-escolher-arquivo="promoArquivo" id="promoEscolherRotulo">Escolher imagem</button>
                  <button type="button" class="btn perigo-sutil mini" id="promoRemoverImagem" hidden>Remover</button>
                </div>
                <span class="campo-ajuda">Banner horizontal vira o fundo do destaque da Home; os outros formatos ficam pro card e pro celular.</span>
              </div>
              <input type="file" id="promoArquivo" accept="image/*" hidden>
            </div>
          </fieldset>

          <fieldset class="form-bloco">
            <legend>Janela de compra</legend>
            <div class="campos">
              <div class="campo-grupo"><label for="pInicio">Começa em</label><input id="pInicio" type="datetime-local" name="compra_inicio" value="${isoLocal(promo?.compra_inicio)}"><span class="campo-ajuda">Vazio: já vale.</span></div>
              <div class="campo-grupo"><label for="pFim">Termina em</label><input id="pFim" type="datetime-local" name="compra_fim" value="${isoLocal(promo?.compra_fim)}"><span class="campo-ajuda">Vazio: sem prazo.</span></div>
            </div>
          </fieldset>

          <fieldset class="form-bloco">
            <legend>Público e condição</legend>
            <div class="campo-grupo"><span class="campo-rotulo">Público elegível</span>${segmentado('publico_elegivel', PUBLICO_ELEGIVEL, publicoElegivel)}</div>
            <div class="campos">
              <div class="campo-grupo"><label for="pDuracao">Duração da condição</label><span class="campo-unidade"><input id="pDuracao" type="number" min="1" name="duracao_beneficio_meses" value="${promo?.duracao_beneficio_meses ?? 12}" required><span>meses</span></span><span class="campo-ajuda">Conta a partir da adesão de cada conta.</span></div>
              <div class="campo-grupo"><label for="pLimite">Limite de adesões</label><input id="pLimite" type="number" min="1" name="limite_adesoes" value="${promo?.limite_adesoes ?? ''}" placeholder="sem teto"></div>
            </div>
          </fieldset>

          <fieldset class="form-bloco">
            <legend>Produtos e ciclos</legend>
            <p class="campo-ajuda u-mt-0">Marque a célula pra incluir o produto naquele ciclo e dê o desconto da promoção — ele substitui o desconto normal do ciclo enquanto a condição vale.</p>
            <div class="rolagem">
              <table class="promo-matriz"><thead><tr><th><span class="u-sr">Produto</span></th>${Object.values(CICLOS)
                .map((n) => `<th>${n}</th>`)
                .join('')}</tr></thead>
                <tbody>
                  ${Object.entries(NOME_TIER)
                    .map(
                      ([tier, nome]) =>
                        `<tr><th scope="row">${nome}</th>${Object.keys(CICLOS)
                          .map((meses) => {
                            const atual = item(tier, Number(meses));
                            return `<td><div class="matriz-celula">
                              <label class="matriz-toggle"><input type="checkbox" data-item-tier="${tier}" data-item-meses="${meses}" ${atual ? 'checked' : ''} aria-label="${nome} ${CICLOS[meses].toLowerCase()}"><span class="selecionavel-check" aria-hidden="true"></span><span class="matriz-off">Incluir</span></label>
                              <span class="matriz-desconto" ${atual ? '' : 'hidden'}><span aria-hidden="true">−</span><input type="number" class="mini" data-item-desconto data-item-tier="${tier}" data-item-meses="${meses}" min="0.01" max="100" step="0.01" placeholder="0" value="${atual?.descontoPercentual ?? ''}" aria-label="Desconto ${nome} ${CICLOS[meses].toLowerCase()}"><span aria-hidden="true">%</span></span>
                            </div></td>`;
                          })
                          .join('')}</tr>`,
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          </fieldset>

          <fieldset class="form-bloco">
            <legend>Exposição</legend>
            <div class="alternar-lista">
              ${alternar({ nome: 'mostrar_home', marcado: !!promo?.mostrar_home, texto: 'Destaque na Home' })}
              ${alternar({ nome: 'mostrar_planos', id: 'chkMostrarPlanos', marcado: promo?.mostrar_planos !== false, texto: 'Página de Planos <span class="alternar-ajuda" id="notaMostrarPlanos" hidden>obrigatório: há produtos participando</span>' })}
            </div>
          </fieldset>

          <fieldset class="form-bloco">
            <legend>Status</legend>
            ${segmentado('status', opcoesStatus, status)}
            <p class="campo-ajuda">Rascunho não aparece pra ninguém. Ativa aparece dentro da janela de compra.</p>
          </fieldset>
        </div>

        <aside class="promo-form-lateral">
          <p class="form-bloco-titulo">Como vai aparecer</p>
          <div class="promo-previa"><span class="promo-previa-rotulo">Home</span><div id="previaHome"></div></div>
          <div class="promo-previa"><span class="promo-previa-rotulo">Página de Planos</span><div id="previaPlanos"></div></div>
          <p class="form-bloco-titulo u-mt-16">Resumo</p>
          <dl class="promo-resumo" id="promoResumo"></dl>
        </aside>
      </div>

      <div class="form-rodape">
        <p class="form-msg" id="msgPromocao" role="status"></p>
        <button class="btn ghost" type="button" id="btnCancelarPromocao">Cancelar</button>
        <button class="btn primary" type="submit" id="btnSalvarPromocao">Salvar</button>
      </div>
    </form>`;
}

async function renderPromocoes(el) {
  const [promocoes, produtos] = await Promise.all([
    pegar('/admin/ofertas/promocoes'),
    pegar('/admin/ofertas/produtos'),
  ]);
  const precoBasePorTier = Object.fromEntries(produtos.map((p) => [p.tier, Number(p.precoBase)]));
  const grupos = GRUPOS_PROMOCAO.map(([chave, titulo]) => ({
    chave,
    titulo,
    itens: promocoes.filter((p) => grupoPromocao(p) === chave),
  })).filter((g) => g.itens.length);

  el.innerHTML = `
    <div class="barra-pagina">
      <p class="barra-pagina-texto">${promocoes.length ? plural(promocoes.length, 'promoção', 'promoções') : ''}</p>
      <button class="btn primary" id="btnNovaPromocao">+ Nova promoção</button>
    </div>
    <div id="formPromocaoWrap" hidden></div>
    ${
      promocoes.length
        ? grupos
            .map(
              (g) => `<section class="secao-pagina promo-grupo">
            <div class="secao-topo"><h3>${g.titulo}</h3><span class="contagem">${g.itens.length}</span></div>
            <div class="promo-lista">${g.itens.map(montarCardPromocao).join('')}</div>
          </section>`,
            )
            .join('')
        : vazio(
            'Nenhuma promoção criada ainda.',
            'Uma promoção dá desconto por plano e ciclo durante uma janela de compra.',
          )
    }`;

  const wrap = document.getElementById('formPromocaoWrap');
  const btnNova = document.getElementById('btnNovaPromocao');
  function fecharFormulario() {
    wrap.hidden = true;
    wrap.innerHTML = '';
    btnNova.hidden = false;
  }

  function abrirFormulario(promo) {
    wrap.innerHTML = montarFormularioPromocao(promo);
    wrap.hidden = false;
    // Um laranja por vez: com o formulário aberto, o "+ Nova" some.
    btnNova.hidden = true;
    wrap.scrollIntoView({ behavior: 'smooth' });
    const form = document.getElementById('formPromocao');
    let arquivoSelecionado = null;
    let arquivoDataUrl = null;
    let removerImagem = false;

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
        desconto.closest('.matriz-desconto').hidden = !chk.checked;
        if (chk.checked) desconto.focus();
        sincronizarMostrarPlanos();
      });
    });
    sincronizarMostrarPlanos();

    // ---- mídia: preview no formato escolhido, trocar/remover coerentes ----
    const previewMidia = document.getElementById('promoMidiaPreview');
    const nomeArquivo = document.getElementById('promoArquivoNome');
    const rotuloEscolher = document.getElementById('promoEscolherRotulo');
    const btnRemover = document.getElementById('promoRemoverImagem');
    const formatoAtual = () => form.querySelector('[name="formato_midia"]:checked')?.value || 'horizontal';
    const imagemAtual = () => arquivoDataUrl || (!removerImagem && promo?.imagem_url) || null;
    function pintarMidia() {
      const src = imagemAtual();
      previewMidia.className = `promo-upload-preview formato-${formatoAtual()}`;
      // Vazio: a moldura no formato escolhido diz "Sem imagem" (e abre o
      // seletor no clique, atalho de mouse); a ação de teclado é o botão ao
      // lado — antes os dois diziam "Escolher imagem", lado a lado.
      previewMidia.innerHTML = src
        ? `<img src="${esc(src)}" alt="Prévia da imagem da promoção">`
        : '<div class="promo-upload-vazio" data-escolher-arquivo="promoArquivo">Sem imagem</div>';
      nomeArquivo.textContent = arquivoSelecionado
        ? arquivoSelecionado.name
        : src
          ? 'Imagem atual'
          : removerImagem
            ? 'A imagem atual sai ao salvar'
            : '';
      nomeArquivo.hidden = !nomeArquivo.textContent;
      rotuloEscolher.textContent = src ? 'Trocar imagem' : 'Escolher imagem';
      btnRemover.hidden = !src;
      atualizarPrevias();
    }
    document.getElementById('promoArquivo').addEventListener('change', (e) => {
      const arquivo = e.target.files[0];
      if (!arquivo) return;
      arquivoSelecionado = arquivo;
      removerImagem = false;
      // FileReader (data:), não URL.createObjectURL (blob:) — a CSP só
      // libera data: em img-src, mesma convenção já usada no preview de
      // foto da candidatura de ponto.
      const leitor = new FileReader();
      leitor.onload = () => {
        if (arquivoSelecionado !== arquivo) return;
        arquivoDataUrl = leitor.result;
        pintarMidia();
      };
      leitor.readAsDataURL(arquivo);
    });
    btnRemover.addEventListener('click', () => {
      // Arquivo novo ainda não enviado: só desfaz a escolha (volta a imagem
      // salva, se houver). Imagem salva: marca pra remover ao salvar.
      if (arquivoSelecionado) {
        arquivoSelecionado = null;
        arquivoDataUrl = null;
        document.getElementById('promoArquivo').value = '';
      } else {
        removerImagem = true;
      }
      pintarMidia();
    });

    // ---- prévias (Home e Planos) e resumo, ao vivo ----
    function itensMarcados() {
      const itens = [];
      form.querySelectorAll('[data-item-tier][type="checkbox"]:checked').forEach((chk) => {
        const desconto = form.querySelector(
          `[data-item-desconto][data-item-tier="${chk.dataset.itemTier}"][data-item-meses="${chk.dataset.itemMeses}"]`,
        );
        itens.push({
          tier: chk.dataset.itemTier,
          compromissoMeses: Number(chk.dataset.itemMeses),
          descontoPercentual: Number(desconto.value) || 0,
        });
      });
      return itens;
    }
    function atualizarPrevias() {
      const titulo = form.titulo_publico.value.trim() || 'Título da promoção';
      const subtitulo = form.subtitulo.value.trim();
      const selo = form.selo.value.trim();
      const fim = form.compra_fim.value ? new Date(form.compra_fim.value) : null;
      const src = imagemAtual();
      const comFundo = src && formatoAtual() === 'horizontal';
      const naHome = form.mostrar_home.checked;
      document.getElementById('previaHome').innerHTML = naHome
        ? `<div class="previa-banner ${comFundo ? 'com-imagem' : ''}">
            ${comFundo ? `<img class="previa-banner-fundo" src="${esc(src)}" alt="">` : ''}
            <div class="previa-banner-conteudo">
              ${selo ? `<span class="previa-selo">${esc(selo)}</span>` : ''}
              <b>${esc(titulo)}</b>
              ${subtitulo ? `<span>${esc(subtitulo)}</span>` : ''}
              ${fim ? `<small>Condição válida até ${fim.toLocaleDateString('pt-BR')}.</small>` : ''}
              <span class="previa-banner-botao">Ver condição na página de planos</span>
            </div>
          </div>`
        : '<p class="promo-previa-fora">Não aparece na Home.</p>';

      const itens = itensMarcados().filter((i) => i.descontoPercentual > 0);
      const duracao = Number(form.duracao_beneficio_meses.value) || 0;
      const naPlanos = chkMostrarPlanos.checked;
      if (!naPlanos) {
        document.getElementById('previaPlanos').innerHTML = '<p class="promo-previa-fora">Não aparece em Planos.</p>';
      } else if (!itens.length) {
        document.getElementById('previaPlanos').innerHTML =
          '<p class="promo-previa-fora">Sem produto marcado: o preço dos planos não muda.</p>';
      } else {
        // Mesma conta da vitrine (public/planos.page.js#montarPreco): o
        // desconto promocional SUBSTITUI o do ciclo, sobre o preço-base.
        const i = [...itens].sort((a, b) => b.descontoPercentual - a.descontoPercentual)[0];
        const base = precoBasePorTier[i.tier] || 0;
        const porMes = Math.round(base * (1 - i.descontoPercentual / 100) * 100) / 100;
        const total = Math.round(porMes * i.compromissoMeses * 100) / 100;
        const cheio = Math.round(base * i.compromissoMeses * 100) / 100;
        document.getElementById('previaPlanos').innerHTML = `<div class="previa-plano">
            <span class="previa-selo">${esc(selo || titulo)}</span>
            <b class="previa-plano-nome">${NOME_TIER[i.tier]} · ${CICLOS[i.compromissoMeses]}</b>
            <span class="previa-plano-cheio"><s>${fmt(cheio)}</s> −${pct(i.descontoPercentual, 2)}</span>
            <b class="previa-plano-preco">${fmt(total)}${i.compromissoMeses === 1 ? '<small>/mês</small>' : ''}</b>
            ${i.compromissoMeses > 1 ? `<span class="previa-plano-mes">equivale a ${fmt(porMes)}/mês</span>` : ''}
            ${duracao ? `<small class="previa-plano-duracao">Preço válido por ${plural(duracao, 'mês', 'meses')} a partir da adesão.</small>` : ''}
            ${itens.length > 1 ? `<small class="previa-plano-mais">+ ${plural(itens.length - 1, 'outra combinação', 'outras combinações')} com desconto</small>` : ''}
          </div>`;
      }

      const descontos = itens.map((x) => x.descontoPercentual);
      const produtosMarcados = [...new Set(itens.map((x) => NOME_TIER[x.tier]))];
      const ciclosMarcados = [...new Set(itens.map((x) => x.compromissoMeses))]
        .sort((a, b) => a - b)
        .map((m) => CICLOS[m]);
      const minD = Math.min(...descontos);
      const maxD = Math.max(...descontos);
      const exposicao = [naHome ? 'Home' : null, naPlanos ? 'Planos' : null].filter(Boolean).join(' · ') || 'nenhuma';
      const publico = form.querySelector('[name="publico_elegivel"]:checked')?.value;
      document.getElementById('promoResumo').innerHTML = `
        <div><dt>Público</dt><dd>${PUBLICO_ELEGIVEL[publico] || '—'}</dd></div>
        <div><dt>Produtos</dt><dd>${produtosMarcados.join(', ') || '—'}</dd></div>
        <div><dt>Ciclos</dt><dd>${ciclosMarcados.join(', ') || '—'}</dd></div>
        <div><dt>Desconto</dt><dd>${descontos.length ? (minD === maxD ? pct(minD, 2) : `${pct(minD, 2)} a ${pct(maxD, 2)}`) : '—'}</dd></div>
        <div><dt>Exposição</dt><dd>${exposicao}</dd></div>
        <div><dt>Duração</dt><dd>${duracao ? `${plural(duracao, 'mês', 'meses')} de desconto` : '—'}</dd></div>`;
      pintarBotaoSalvar();
    }

    // Texto do botão diz o que o clique faz (a semântica do envio não muda:
    // é sempre o mesmo POST/PATCH com o status escolhido acima).
    function pintarBotaoSalvar() {
      const escolhido = form.querySelector('[name="status"]:checked')?.value;
      const btn = document.getElementById('btnSalvarPromocao');
      if (escolhido === 'rascunho') btn.textContent = 'Salvar rascunho';
      else if (escolhido === 'ativa' && promo?.status !== 'ativa') btn.textContent = 'Publicar promoção';
      else btn.textContent = 'Salvar alterações';
    }

    form.addEventListener('input', atualizarPrevias);
    form.addEventListener('change', (e) => {
      if (e.target.name === 'formato_midia') pintarMidia();
      else atualizarPrevias();
    });
    pintarMidia();

    document.getElementById('btnCancelarPromocao').addEventListener('click', fecharFormulario);
    document.getElementById('btnFecharPromocao').addEventListener('click', fecharFormulario);

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
      // Remover a imagem salva = gravar sem imagem (o campo já é editável
      // no PATCH; nada novo no backend).
      if (removerImagem && !arquivoSelecionado) corpo.imagem_url = null;
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

  btnNova.addEventListener('click', () => abrirFormulario(null));
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
      const ok = await confirmarModal({
        titulo: 'Excluir esta promoção?',
        texto:
          '<p>Ela some de vez. Só é possível porque ainda não tem nenhuma adesão — com adesão, encerre em vez de excluir.</p>',
        botao: 'Excluir promoção',
        perigo: true,
      });
      if (!ok) return;
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
        <td data-valor="${(c.uso_contas || 0) + (c.uso_pontos || 0)}">${uso || '<span class="u-dim">0 contas</span>'}</td>
        <td>${c.ativo && !c.legado ? 'Sim' : '<span class="u-dim">Não</span>'}</td>
        <td><span class="badge ${estado.classe}">${estado.nome}</span></td>
        <td class="u-ta-r"><button type="button" class="btn-linha" data-editar-cat="${c.id}">Editar</button></td>
      </tr>`;
    })
    .join('');

  // Cabeçalho enxuto (polimento final, 23/09/2026): o título "Categorias"
  // repetia a aba, e a frase sobre concorrência mora no subtítulo da página.
  // Sobra uma linha: a contagem por estado e a ação.
  el.innerHTML = `
    <div class="barra-pagina">
      <p class="barra-pagina-texto">${plural(conta('ativa'), 'ativa no cadastro', 'ativas no cadastro')} · ${num(conta('legado'))} legado · ${num(conta('fora'))} fora do cadastro</p>
      <button class="btn primary" type="button" id="btnNovaCategoria">+ Nova categoria</button>
    </div>
    ${caixaTabela({
      chips: [
        { valor: '', nome: 'Todas' },
        { valor: 'ativa', nome: 'Ativas' },
        { valor: 'legado', nome: 'Legado' },
        { valor: 'fora', nome: 'Fora do cadastro' },
      ],
      html: `<table class="tabela-categorias"><thead><tr><th data-ord>Categoria</th><th data-ord>Grupo</th><th data-ord>Uso</th><th data-ord>No cadastro</th><th data-ord>Estado</th><th><span class="u-sr">Ação</span></th></tr></thead><tbody>${linhas}</tbody></table>`,
      dica: 'A busca acha por nome, alias e grupo.',
      unidade: 'categoria|categorias',
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
        <div class="campos">
          <div><span class="campo-rotulo">Estado</span>${segmentado('estado', { ativa: 'Normal', legado: 'Legado' }, estado.chave === 'legado' ? 'legado' : 'ativa')}</div>
          <div><span class="campo-rotulo">Cadastro</span>${alternar({ nome: 'ativo', marcado: !c || (c.ativo && !c.legado), texto: 'Aparece no cadastro' })}</div>
        </div>
        ${c ? `<p class="u-dim u-fs-85 u-m-0">${uso ? `Em uso por ${esc(uso)}.` : 'Nenhuma conta ou ponto usa esta categoria.'}</p>` : ''}
        <p class="form-msg" data-msg role="status"></p>
      </form>`,
    rodape: `
      ${c && !emUso ? '<button type="button" class="btn perigo-sutil mini" data-excluir>Excluir</button>' : ''}
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

// ---------- mensagens do site ----------
// A migration 039 passou a gravar a mensagem antes de tentar o e-mail, pra que
// falha de SMTP perdesse o aviso e não o dado. Só que ninguém lia a tabela: o
// dado ficava salvo e invisível — o mesmo furo por outra porta, e pior, porque
// /contato.html é o canal declarado de pedido do titular (LGPD art. 18).
//
// Redesenho de 22/09/2026 (encerramento de "Entrada"): sem item próprio na
// sidebar — chega pelo aviso da Visão geral (ALERTAS, fila `contato`).
//
// Abas Pendentes/Histórico (revisão final da Visão geral, 23/09/2026, seção
// 5 do pedido): antes só existia Pendentes, e responder uma mensagem a
// fazia sumir sem deixar rastro navegável — o registro continuava no banco
// (`respondida_em` preenchido, LGPD preservada) mas não tinha mais tela que
// mostrasse. Mesmo endpoint pras duas abas (`GET /admin/mensagens-contato`
// já devolve tudo, sem filtro no servidor) — cada aba filtra do seu lado.
async function renderMensagensPendentes(el) {
  const todas = await pegar('/admin/mensagens-contato');
  const pendentes = todas.filter((m) => !m.respondida_em);

  const linha = (m) => `<tr data-msg="${m.id}">
      <td class="col-data" data-valor="${new Date(m.created_at).getTime()}">${data(m.created_at)}</td>
      <td><b>${esc(m.nome)}</b><a class="celula-sub" href="mailto:${esc(m.email)}">${esc(m.email)}</a>${m.telefone ? `<span class="celula-sub">${esc(m.telefone)}</span>` : ''}</td>
      <td><div class="celula-mensagem">${esc(m.mensagem)}</div></td>
      <td>${m.email_enviado ? '<span class="badge badge-ok">aviso enviado</span>' : '<span class="badge badge-err" title="O e-mail de aviso pra equipe falhou — a mensagem está só aqui">aviso não saiu</span>'}</td>
      <td class="u-ta-r"><button class="btn ghost mini" type="button" data-respondida="${m.id}">Marcar como respondida</button></td>
    </tr>`;

  const corpo = `<table class="tabela-mensagens"><thead><tr>
      <th data-ord>Recebida</th><th data-ord>Quem</th><th>Mensagem</th><th data-ord>Aviso</th><th><span class="u-sr">Ação</span></th>
    </tr></thead><tbody>${pendentes.map(linha).join('')}</tbody></table>`;

  el.innerHTML = pendentes.length
    ? caixaTabela({ html: corpo, unidade: 'mensagem|mensagens' })
    : vazio(
        'Nenhuma mensagem aguardando resposta.',
        'Responda pelo e-mail ou telefone da pessoa e marque a mensagem como respondida aqui.',
      );

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
      renderMensagensPendentes(el);
    });
  });
}

// Só leitura — nenhuma ação aqui, a mensagem já foi respondida por fora
// (e-mail/telefone). Mais recente primeiro, igual todo histórico do admin.
async function renderMensagensHistorico(el) {
  const todas = await pegar('/admin/mensagens-contato');
  const respondidas = todas
    .filter((m) => m.respondida_em)
    .sort((a, b) => new Date(b.respondida_em) - new Date(a.respondida_em));

  if (!respondidas.length) {
    el.innerHTML = vazio('Nenhuma mensagem respondida ainda.');
    return;
  }

  const linha = (m) => `<tr data-msg="${m.id}">
      <td class="col-data" data-valor="${new Date(m.created_at).getTime()}">${data(m.created_at)}</td>
      <td class="col-data" data-valor="${new Date(m.respondida_em).getTime()}">${data(m.respondida_em)}</td>
      <td><b>${esc(m.nome)}</b><a class="celula-sub" href="mailto:${esc(m.email)}">${esc(m.email)}</a>${m.telefone ? `<span class="celula-sub">${esc(m.telefone)}</span>` : ''}</td>
      <td><div class="celula-mensagem">${esc(m.mensagem)}</div></td>
    </tr>`;

  const corpo = `<table class="tabela-mensagens"><thead><tr>
      <th data-ord>Recebida</th><th data-ord>Respondida</th><th data-ord>Quem</th><th>Mensagem</th>
    </tr></thead><tbody>${respondidas.map(linha).join('')}</tbody></table>`;

  el.innerHTML = caixaTabela({ html: corpo, unidade: 'mensagem|mensagens' });
  turbinarTabela(el.querySelector('.tabela-caixa'));
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
    el.innerHTML = vazio(
      'Nenhuma troca aguardando pagamento.',
      'Quem troca de plano no meio do período e ainda não pagou a diferença aparece aqui.',
    );
    return;
  }

  // Só leitura: o pagamento acontece no Checkout do próprio cliente e o
  // webhook fecha a pendência sozinho.
  el.innerHTML = caixaTabela({
    busca: false,
    unidade: 'troca|trocas',
    html: `<table><thead><tr>
        <th>Conta</th><th>Troca</th><th class="num">Pedida em</th><th class="num">Diferença</th><th>Situação</th>
      </tr></thead><tbody>
      ${pendentes
        .map(
          (p) => `<tr>
          <td><b>${esc(p.nome_empresa)}</b></td>
          <td>${p.plano_atual_nome ? esc(p.plano_atual_nome) : 'sem plano'} <span class="u-dim" aria-hidden="true">→</span> ${esc(p.plano_novo_nome)} · ${esc(CICLOS[p.plano_novo_meses] || `${p.plano_novo_meses} meses`)}</td>
          <td class="num">${data(p.criado_em)}</td>
          <td class="num"><b>${fmt(p.valor)}</b></td>
          <td><span class="badge badge-pendente">esperando pagamento</span></td>
        </tr>`,
        )
        .join('')}
      </tbody></table>`,
  });
  turbinarTabela(el.querySelector('.tabela-caixa'));
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
    el.innerHTML = vazio('Nenhuma cobrança confirmada ainda.', 'Pagamento confirmado pelo San Checkout aparece aqui.');
    return;
  }
  const total = cobrancas.reduce((t, c) => t + Number(c.valor), 0);

  // Sem a coluna de id interno; o plano entra (humanizado) — é a pergunta
  // que se faz olhando um pagamento: de quem, de quê, quanto, quando.
  const corpo = `<table><thead><tr>
      <th data-ord>Data</th><th data-ord>Conta</th><th data-ord>Plano</th><th data-ord class="num">Valor</th>
    </tr></thead><tbody>
    ${cobrancas
      .map(
        (c) => `<tr>
      <td class="col-data" data-valor="${new Date(c.criado_em).getTime()}">${data(c.criado_em)}</td>
      <td><b>${esc(c.nome_empresa)}</b></td>
      <td>${esc(humanizarPlanoId(c.plano_id))}</td>
      <td class="num">${fmt(c.valor)}</td>
    </tr>`,
      )
      .join('')}
  </tbody></table>`;

  el.innerHTML = `
    <div class="mini-indicadores">
      <div class="mini-indicador"><b>${fmt(total)}</b><span>total confirmado</span></div>
      <div class="mini-indicador"><b>${num(cobrancas.length)}</b><span>${cobrancas.length === 1 ? 'cobrança' : 'cobranças'}</span></div>
    </div>
    ${caixaTabela({ html: corpo, unidade: 'cobrança|cobranças' })}`;

  turbinarTabela(el.querySelector('.tabela-caixa'));
}

// ---------- fila financeira: comissões de vendedor (SEM aba, ver abaixo) ----------
// Rodada Financeiro (22/09/2026): só o que está em aberto — "normalidade não
// ocupa espaço". Histórico de comissões pagas continua em `comissoes`, sem
// aba pra navegar por ele aqui (pedido explícito: nada de abas de concluídos).
// Perdeu a aba na Central Financeira (revisão final da Visão geral,
// 23/09/2026: "o conceito de vendedor foi retirado do projeto") — a tabela
// `comissoes` e a rota `/admin/comissoes` continuam intactas (vendedor ainda
// existe dentro de Contas), só esta fila específica ficou sem chamador.
// `_` no nome pelo mesmo motivo de sempre neste arquivo: função morta que
// não se apaga, só marca.
async function _renderFilaComissoes(el) {
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
      _renderFilaComissoes(el);
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
    el.innerHTML = vazio(
      'Nenhuma devolução pendente.',
      'Desistência dentro dos 7 dias da lei aparece aqui até o estorno ser registrado.',
    );
    return;
  }

  el.innerHTML = caixaTabela({
    busca: false,
    unidade: 'devolução|devoluções',
    html: `<table><thead><tr>
        <th>Conta</th><th class="num">Pedida em</th><th class="num">Valor</th><th>Comprovante do estorno</th>
      </tr></thead><tbody>
      ${pendentes
        .map(
          (p) => `<tr data-linha="${p.id}">
          <td><b>${esc(p.nome_empresa)}</b><span class="celula-sub">${esc(p.contato_email)} · ${esc(p.cpf_cnpj)}</span></td>
          <td class="num">${data(p.pedido_em)}</td>
          <td class="num"><b>${fmt(p.valor_a_estornar)}</b></td>
          <td><div class="acoes acoes-linha">
            <input class="mini" placeholder="id do estorno no Checkout" data-comp="${p.id}" aria-label="Comprovante do estorno de ${esc(p.nome_empresa)}">
            <button class="btn ghost mini" data-estornado="${p.id}">Registrar</button>
          </div></td>
        </tr>`,
        )
        .join('')}
      </tbody></table>`,
  });
  turbinarTabela(el.querySelector('.tabela-caixa'));

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
