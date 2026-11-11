// TICK — ativação do operador (/ticket/ativar), desde 11/11/2026 na conta
// TICK: o código do convite (digitado, ou vindo no link /ticket/ativar#c=…)
// liga o operador à conta logada — sem senha nova, sem segundo cadastro.
// Sem conta logada, a pessoa entra ou cria a conta e volta para cá. Quem
// decide se o código vale é o servidor; o link só preenche o campo.
(() => {
  const { el, api, enviando } = window.trimundi;
  const raiz = document.getElementById('ativacao');
  const GUARDADO = 'tick:ativacao-operador';
  const VOLTA = `/ticket/conta?volta=${encodeURIComponent('/ticket/ativar')}`;

  const formatar = (v) => {
    const s = String(v || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
  };
  // O código do link fica só nesta aba (sessionStorage) enquanto a pessoa
  // entra ou cria a conta, e sai da barra de endereço na hora.
  function codigoGuardado() {
    try {
      const doLink = new URLSearchParams(location.hash.slice(1)).get('c');
      if (doLink) {
        sessionStorage.setItem(GUARDADO, formatar(doLink));
        history.replaceState(null, '', location.pathname + location.search);
      }
      return sessionStorage.getItem(GUARDADO) || '';
    } catch {
      return '';
    }
  }
  const esquecerCodigo = () => {
    try {
      sessionStorage.removeItem(GUARDADO);
    } catch {}
  };

  function campoCodigo(valor) {
    const input = el('input', {
      id: 'codigo',
      name: 'codigo',
      autocomplete: 'one-time-code',
      autocapitalize: 'characters',
      maxlength: 9,
      placeholder: 'XXXX-XXXX',
      required: true,
      value: valor,
    });
    input.addEventListener('input', () => {
      input.value = formatar(input.value);
      try {
        sessionStorage.setItem(GUARDADO, input.value);
      } catch {}
    });
    return el('div', { class: 'campo' }, el('label', { for: 'codigo', text: 'Código de ativação' }), input);
  }

  function semConta(codigo) {
    raiz.replaceChildren(
      el(
        'div',
        { class: 'cartao auth-cartao' },
        campoCodigo(codigo),
        el('p', {
          class: 'discreto',
          text: 'Para ativar, entre na sua conta TICK — ou crie a conta com o mesmo e-mail que recebeu o convite. Depois você volta para cá e o código continua preenchido.',
        }),
        el('a', { class: 'btn primario grande', href: VOLTA, text: 'Entrar na minha conta' }),
      ),
      el(
        'div',
        { class: 'auth-alternativa' },
        el('p', { text: 'Ainda não tem conta TICK?' }),
        el('a', { class: 'btn secundario', href: `${VOLTA}#criar`, text: 'Criar conta' }),
      ),
    );
  }

  function pronto(jaEra) {
    esquecerCodigo();
    raiz.replaceChildren(
      el(
        'div',
        { class: 'cartao auth-cartao' },
        el('p', {
          class: 'mensagem ok',
          text: jaEra
            ? 'Sua conta TICK já tem o acesso de operador.'
            : 'Pronto: sua conta TICK agora tem o acesso de operador. Use o mesmo e-mail e a mesma senha de sempre.',
        }),
        el('a', { class: 'btn primario grande', href: '/ticket/checkin', text: 'Abrir a portaria' }),
      ),
      el(
        'div',
        { class: 'auth-alternativa' },
        el('a', { class: 'btn secundario', href: '/ticket/conta', text: 'Ver minha conta' }),
      ),
    );
  }

  function comConta(sessao, codigo) {
    const msg = el('p', { class: 'mensagem', role: 'status', 'aria-live': 'polite' });
    const botao = el('button', { class: 'btn primario grande', type: 'submit', text: 'Ativar acesso de operador' });
    const trocar = el('button', { class: 'link-suave', type: 'button', text: 'Não é você? Trocar de conta' });
    trocar.addEventListener('click', async () => {
      await api('/ticket/api/conta/sair', { metodo: 'POST', corpo: {} }).catch(() => {});
      location.assign(VOLTA);
    });
    const form = el(
      'form',
      { class: 'cartao auth-cartao', id: 'formAtivar', novalidate: true },
      el('p', {}, 'O acesso será ativado na conta ', el('strong', { text: sessao.email }), '.'),
      campoCodigo(codigo),
      msg,
      botao,
      el('div', { class: 'auth-linha' }, trocar),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = 'mensagem';
      msg.textContent = '';
      const valor = form.elements.codigo.value;
      if (valor.replace(/[^A-Z0-9]/g, '').length !== 8) {
        msg.className = 'mensagem erro';
        msg.textContent = 'O código tem 8 letras e números (XXXX-XXXX).';
        return form.elements.codigo.focus();
      }
      try {
        const r = await enviando(botao, 'Ativando...', () =>
          api('/ticket/api/operador/vincular', { metodo: 'POST', corpo: { codigo: valor } }),
        );
        pronto(r.ja_ativo);
      } catch (err) {
        if (err.status === 401) return semConta(valor);
        msg.className = 'mensagem erro';
        msg.textContent = err.message;
      }
    });
    raiz.replaceChildren(form);
  }

  (async () => {
    const codigo = codigoGuardado();
    const sessao = await api('/ticket/api/conta/sessao').catch(() => ({ logado: false }));
    if (sessao.logado) comConta(sessao, codigo);
    else semConta(codigo);
  })();
})();
