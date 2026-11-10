// Trimundi — utilitários das páginas públicas (/ticket/*). Sem dependência e
// sem innerHTML com dado de fora: todo texto entra por textContent (CSP sem
// script inline, e nada que venha do banco vira HTML).
(() => {
  // el('p', { class: 'x', text: 'oi' }, filho...) — cria o elemento com segurança.
  function el(tag, atributos = {}, ...filhos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(atributos || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const f of filhos.flat(Number.POSITIVE_INFINITY)) {
      if (f === null || f === undefined || f === false) continue;
      n.append(f instanceof Node ? f : document.createTextNode(String(f)));
    }
    return n;
  }

  const moeda = (centavos) =>
    (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const FUSO = 'America/Sao_Paulo';
  function dataHora(iso, { comHora = true } = {}) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const data = d.toLocaleDateString('pt-BR', {
      timeZone: FUSO,
      weekday: 'short',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
    if (!comHora) return data;
    return `${data}, ${d.toLocaleTimeString('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' })}`;
  }
  const hora = (iso) =>
    new Date(iso).toLocaleTimeString('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' });
  const dataCurta = (iso) =>
    new Date(iso).toLocaleString('pt-BR', {
      timeZone: FUSO,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  // Chamada à API da Trimundi. Erro vira exceção com `status`, a mensagem do
  // servidor e os campos extras (`codigo`, `disponivel`...).
  async function api(caminho, { metodo = 'GET', corpo, cabecalhos = {} } = {}) {
    let r;
    try {
      r = await fetch(caminho, {
        method: metodo,
        credentials: 'same-origin',
        headers: { ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...cabecalhos },
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      });
    } catch {
      const err = new Error('Sem conexão agora — confira a internet e tente de novo.');
      err.status = 0;
      throw err;
    }
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const mensagem =
        r.status === 429
          ? json.erro || 'Muitas tentativas seguidas — espere alguns minutos.'
          : r.status >= 500 && !json.erro
            ? 'Não foi possível concluir agora — tente de novo em instantes.'
            : json.erro || 'Não foi possível concluir agora.';
      const err = new Error(frase(mensagem));
      Object.assign(err, json, { status: r.status });
      throw err;
    }
    return json;
  }

  // Primeira letra maiúscula e ponto no fim (as mensagens do servidor variam).
  function frase(texto) {
    const t = String(texto || '').trim();
    if (!t) return t;
    const inicio = t[0].toUpperCase() + t.slice(1);
    return /[.!?…]$/.test(inicio) ? inicio : `${inicio}.`;
  }

  // Chave de idempotência: o mesmo envio repetido (duplo clique, rede que cai)
  // não cria dois pedidos.
  function novaChave() {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  // CPF: só para ajudar quem digita — quem valida é o servidor.
  const digitos = (v) => String(v || '').replace(/\D/g, '');
  function formatarCpf(v) {
    const d = digitos(v).slice(0, 11);
    return d
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  function cpfValido(v) {
    const d = digitos(v);
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    const dv = (n) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
      const r = (s * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
  }
  function mascaraCpf(input) {
    input.addEventListener('input', () => {
      const fim = input.selectionEnd === input.value.length;
      input.value = formatarCpf(input.value);
      if (fim) input.setSelectionRange(input.value.length, input.value.length);
    });
  }
  function formatarTelefone(v) {
    const d = digitos(v).slice(0, 11);
    if (d.length <= 10) return d.replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d)/, '$1-$2');
    return d.replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d)/, '$1-$2');
  }

  // Trava o botão enquanto envia (o padrão do resto do site).
  async function enviando(botao, rotulo, fn) {
    const antes = botao.textContent;
    botao.disabled = true;
    botao.textContent = rotulo;
    try {
      return await fn();
    } finally {
      botao.disabled = false;
      botao.textContent = antes;
    }
  }

  // Visitante (só para contar acessos únicos pelo link de indicação): um id
  // aleatório deste navegador, sem nada da pessoa. O servidor guarda o hash.
  function visitante() {
    try {
      let id = localStorage.getItem('tick:visitante');
      if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
        id = (crypto.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
        localStorage.setItem('tick:visitante', id);
      }
      return id;
    } catch {
      return null;
    }
  }

  // Link de indicação geral (/tic/eventos?ind=CÓDIGO): guardado 30 dias e
  // usado pela página do evento quando ela não tem um código próprio.
  const INDICACAO_GERAL = 'trimundi:indicacao:geral';
  function guardarIndicacaoGeral(codigo) {
    try {
      if (codigo && /^[A-Za-z2-9]{8}$/.test(codigo))
        localStorage.setItem(
          INDICACAO_GERAL,
          JSON.stringify({ c: codigo.toUpperCase(), ate: Date.now() + 30 * 86400000 }),
        );
    } catch {}
  }
  function indicacaoGeral() {
    try {
      const g = JSON.parse(localStorage.getItem(INDICACAO_GERAL) || 'null');
      return g && g.ate > Date.now() ? g.c : null;
    } catch {
      return null;
    }
  }

  // Campo de senha com o botão de olho dentro, à direita: mostra e esconde o
  // que foi digitado. É um botão de verdade (type="button": não envia o
  // formulário), com nome para leitor de tela e aria-pressed. Começa oculto.
  // Cada campo tem o seu — mostrar um não mexe no outro. A senha nunca sai
  // daqui: só o `type` do campo muda.
  const SVG = 'http://www.w3.org/2000/svg';
  function icone(aberto) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const caminho = (d) => {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.8');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.append(p);
    };
    caminho('M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z');
    caminho('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z');
    if (!aberto) caminho('M4 4l16 16');
    return svg;
  }
  function comOlho(input) {
    const caixa = el('div', { class: 'campo-senha' });
    const botao = el('button', {
      type: 'button',
      class: 'olho',
      'aria-label': 'Mostrar senha',
      'aria-pressed': 'false',
      'aria-controls': input.id || null,
    });
    botao.append(icone(false));
    botao.addEventListener('click', () => {
      const mostrar = input.type === 'password';
      input.type = mostrar ? 'text' : 'password';
      botao.setAttribute('aria-pressed', String(mostrar));
      botao.setAttribute('aria-label', mostrar ? 'Ocultar senha' : 'Mostrar senha');
      botao.replaceChildren(icone(mostrar));
      input.focus({ preventScroll: true });
    });
    // Mostrar a senha não deve ajudar corretor nem preenchimento a guardar
    // o texto.
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    caixa.append(input, botao);
    return caixa;
  }

  window.trimundi = {
    visitante,
    guardarIndicacaoGeral,
    indicacaoGeral,
    comOlho,
    el,
    moeda,
    dataHora,
    hora,
    dataCurta,
    api,
    frase,
    novaChave,
    digitos,
    formatarCpf,
    cpfValido,
    mascaraCpf,
    formatarTelefone,
    enviando,
  };
})();
