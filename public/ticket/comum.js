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

  window.trimundi = {
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
