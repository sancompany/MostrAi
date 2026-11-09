// Trimundi — conta do cliente (/ticket/conta e subpáginas): entrar, criar
// conta, confirmar e-mail, recuperar senha e "minha conta" (ingressos, QR e
// indicação). O token dos links de e-mail vem no fragmento (#t=...) e sai da
// barra de endereço assim que é lido.
(() => {
  const { el, api, mascaraCpf, cpfValido, enviando, dataHora, dataCurta, digitos } = window.trimundi;
  const conteudo = document.getElementById('conteudo');
  const topo = document.getElementById('topoConta');
  const params = new URLSearchParams(location.search);
  // Para onde voltar depois de entrar (só caminhos da Trimundi).
  const volta = /^\/ticket\/[A-Za-z0-9/_-]+$/.test(params.get('volta') || '') ? params.get('volta') : null;

  function tokenDoLink() {
    const t = new URLSearchParams(location.hash.slice(1)).get('t');
    if (t) history.replaceState(null, '', location.pathname + location.search);
    return t;
  }

  const trocar = (...nos) => conteudo.replaceChildren(...nos.filter((n) => n !== null && n !== undefined));
  const mensagem = () => el('p', { class: 'mensagem', role: 'status', 'aria-live': 'polite' });
  function avisar(m, tipo, texto) {
    m.className = `mensagem ${tipo}`;
    m.textContent = texto;
  }
  function campo(rotulo, nome, atributos = {}) {
    return el(
      'div',
      { class: 'campo' },
      el('label', { for: nome, text: rotulo }),
      el('input', { id: nome, name: nome, required: true, ...atributos }),
    );
  }
  const SENHA = 'Mínimo de 8 caracteres, com letra maiúscula, minúscula, número e símbolo.';
  const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

  const trocarPara = (tela) => (e) => {
    e.preventDefault();
    tela();
  };

  function depoisDeEntrar() {
    if (volta) location.assign(volta);
    else location.assign('/ticket/conta');
  }

  // ---- entrar
  function telaEntrar(aviso = null) {
    const m = mensagem();
    const form = el(
      'form',
      { class: 'cartao', novalidate: true },
      campo('E-mail', 'email', { type: 'email', autocomplete: 'email', maxlength: 200 }),
      campo('Senha', 'senha', { type: 'password', autocomplete: 'current-password', maxlength: 200 }),
      m,
      el('button', { class: 'btn primario grande', type: 'submit', text: 'Entrar' }),
    );
    let reenviar = null;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.elements.email.value.trim();
      if (!emailOk(email)) return avisar(m, 'erro', 'Informe um e-mail válido.');
      try {
        await enviando(form.querySelector('[type="submit"]'), 'Entrando...', () =>
          api('/ticket/api/conta/entrar', { metodo: 'POST', corpo: { email, senha: form.elements.senha.value } }),
        );
        depoisDeEntrar();
      } catch (err) {
        avisar(m, 'erro', err.message);
        if (err.codigo === 'nao_confirmado' && !reenviar) {
          reenviar = el('button', {
            class: 'btn',
            type: 'button',
            text: 'Reenviar o link de confirmação',
            onclick: async () => {
              const r = await api('/ticket/api/conta/reenviar', { metodo: 'POST', corpo: { email } }).catch((x) => x);
              avisar(m, r instanceof Error ? 'erro' : 'ok', r.mensagem || r.message);
            },
          });
          form.append(reenviar);
        }
      }
    });
    trocar(
      el('h1', { text: 'Entrar' }),
      aviso ? el('p', { class: 'mensagem ok', text: aviso }) : null,
      form,
      el(
        'p',
        {},
        'Ainda não tem conta? ',
        el('a', { href: '#criar', onclick: trocarPara(telaCadastro), text: 'Criar conta' }),
        ' · ',
        el('a', { href: '/ticket/conta/esqueci', text: 'Esqueci a senha' }),
      ),
    );
  }

  // ---- criar conta
  function telaCadastro() {
    const m = mensagem();
    const cpf = el('input', {
      id: 'cpf',
      name: 'cpf',
      inputmode: 'numeric',
      autocomplete: 'off',
      maxlength: 14,
      placeholder: '000.000.000-00',
      required: true,
    });
    mascaraCpf(cpf);
    const form = el(
      'form',
      { class: 'cartao', novalidate: true },
      campo('Nome completo', 'nome', { autocomplete: 'name', maxlength: 120 }),
      el('div', { class: 'campo' }, el('label', { for: 'cpf', text: 'CPF' }), cpf),
      campo('E-mail', 'email', { type: 'email', autocomplete: 'email', maxlength: 200 }),
      campo('Senha', 'senha', { type: 'password', autocomplete: 'new-password', maxlength: 200 }),
      el('p', { class: 'discreto', text: SENHA }),
      m,
      el('button', { class: 'btn primario grande', type: 'submit', text: 'Criar conta' }),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form.elements;
      const dados = {
        nome: f.nome.value.trim(),
        cpf: digitos(f.cpf.value),
        email: f.email.value.trim(),
        senha: f.senha.value,
      };
      if (dados.nome.length < 2) return avisar(m, 'erro', 'Informe seu nome completo.');
      if (!cpfValido(dados.cpf)) return avisar(m, 'erro', 'CPF inválido — confira os números.');
      if (!emailOk(dados.email)) return avisar(m, 'erro', 'Informe um e-mail válido.');
      try {
        const r = await enviando(form.querySelector('[type="submit"]'), 'Criando...', () =>
          api('/ticket/api/conta/cadastro', { metodo: 'POST', corpo: dados }),
        );
        trocar(
          el('h1', { text: 'Confirme seu e-mail' }),
          el('p', { class: 'mensagem ok', text: r.mensagem }),
          el('p', {
            class: 'discreto',
            text: 'Não chegou? Veja a caixa de spam ou tente entrar para reenviar o link.',
          }),
          el('a', { class: 'btn', href: `/ticket/conta${location.search}`, text: 'Voltar para entrar' }),
        );
      } catch (err) {
        avisar(m, 'erro', err.message);
      }
    });
    trocar(
      el('h1', { text: 'Criar conta' }),
      el('p', {
        text: 'Só o necessário: nome, CPF, e-mail e senha. Depois de confirmar o e-mail, você compra e vê seus ingressos aqui.',
      }),
      form,
      el('p', {}, 'Já tem conta? ', el('a', { href: '#entrar', onclick: trocarPara(telaEntrar), text: 'Entrar' })),
    );
  }

  // ---- links do e-mail
  async function telaConfirmar() {
    const t = tokenDoLink();
    try {
      await api('/ticket/api/conta/confirmar', { metodo: 'POST', corpo: { token: t } });
      trocar(
        el('h1', { text: 'E-mail confirmado' }),
        el('p', { class: 'mensagem ok', text: 'Sua conta está ativa. Você já pode comprar.' }),
        el('a', { class: 'btn primario', href: '/ticket/conta', text: 'Ver minha conta' }),
      );
    } catch (err) {
      trocar(el('h1', { text: 'Não deu para confirmar' }), el('p', { class: 'mensagem erro', text: err.message }));
      conteudo.append(el('a', { class: 'btn', href: '/ticket/conta', text: 'Entrar para reenviar o link' }));
    }
  }

  function telaEsqueci() {
    const m = mensagem();
    const form = el(
      'form',
      { class: 'cartao', novalidate: true },
      campo('E-mail da conta', 'email', { type: 'email', autocomplete: 'email', maxlength: 200 }),
      m,
      el('button', { class: 'btn primario grande', type: 'submit', text: 'Enviar o link' }),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.elements.email.value.trim();
      if (!emailOk(email)) return avisar(m, 'erro', 'Informe um e-mail válido.');
      try {
        const r = await enviando(form.querySelector('[type="submit"]'), 'Enviando...', () =>
          api('/ticket/api/conta/esqueci', { metodo: 'POST', corpo: { email } }),
        );
        avisar(m, 'ok', r.mensagem);
      } catch (err) {
        avisar(m, 'erro', err.message);
      }
    });
    trocar(el('h1', { text: 'Recuperar a senha' }), form);
  }

  function telaRedefinir() {
    const t = tokenDoLink();
    const m = mensagem();
    const form = el(
      'form',
      { class: 'cartao', novalidate: true },
      campo('Senha nova', 'senha', { type: 'password', autocomplete: 'new-password', maxlength: 200 }),
      el('p', { class: 'discreto', text: SENHA }),
      m,
      el('button', { class: 'btn primario grande', type: 'submit', text: 'Salvar a senha' }),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await enviando(form.querySelector('[type="submit"]'), 'Salvando...', () =>
          api('/ticket/api/conta/redefinir', { metodo: 'POST', corpo: { token: t, senha: form.elements.senha.value } }),
        );
        location.assign('/ticket/conta');
      } catch (err) {
        avisar(m, 'erro', err.message);
      }
    });
    trocar(el('h1', { text: 'Senha nova' }), form);
  }

  // ---- minha conta
  function cartaoIngresso(i) {
    const usado = Boolean(i.utilizado_em);
    const rotulo = usado
      ? `Utilizado em ${dataCurta(i.utilizado_em)}`
      : { valido: 'Válido', bloqueado: 'Bloqueado', cancelado: 'Cancelado' }[i.status] || i.status;
    return el(
      'article',
      { class: `cartao ingresso${i.qr ? '' : ' inativo'}` },
      el('div', { class: 'discreto', text: `${i.evento} — ${i.edicao}` }),
      el('h3', { text: i.categoria }),
      el('div', { text: [i.inicio_em ? dataHora(i.inicio_em) : null, i.local].filter(Boolean).join(' · ') }),
      el('div', { class: 'discreto', text: `Participante: ${i.participante}` }),
      i.beneficios?.length
        ? el(
            'ul',
            { class: 'chips' },
            i.beneficios.map((b) =>
              el('li', { class: 'chip', text: b.resgatado_em ? `${b.nome} — resgatado` : `Direito a: ${b.nome}` }),
            ),
          )
        : null,
      i.qr
        ? el('img', { class: 'qr', src: i.qr, alt: `QR Code do ingresso ${i.codigo_curto}`, width: 260, height: 260 })
        : el('div', {
            class: 'qr-vazio',
            text: usado ? 'Entrada já registrada.' : 'Este ingresso não vale para entrar.',
          }),
      el('div', { class: 'codigo', text: i.codigo_curto }),
      el('span', { class: 'selo', text: rotulo }),
    );
  }

  async function telaConta() {
    let d;
    try {
      d = await api('/ticket/api/conta');
    } catch (err) {
      if (err.status === 401) return telaEntrar(volta ? 'Entre na sua conta para continuar a compra.' : null);
      return trocar(el('p', { class: 'mensagem erro', text: err.message }));
    }
    topo.replaceChildren(
      el('button', {
        class: 'btn mini',
        type: 'button',
        text: 'Sair',
        onclick: async () => {
          await api('/ticket/api/conta/sair', { metodo: 'POST', corpo: {} }).catch(() => {});
          location.assign('/ticket/conta');
        },
      }),
    );
    trocar(
      el('h1', { text: `Olá, ${d.conta.nome.split(' ')[0]}` }),
      el('p', { class: 'discreto', text: `${d.conta.email} · CPF ${d.conta.cpf}` }),
      d.indicacao ? secaoIndicacao(d.indicacao) : null,
      el('h2', { text: d.ingressos.length === 1 ? 'Seu ingresso' : 'Seus ingressos' }),
      d.ingressos.length
        ? el('div', { class: 'ingressos' }, d.ingressos.map(cartaoIngresso))
        : el('p', {
            class: 'discreto',
            text: 'Você ainda não tem ingressos. Quando o pagamento for confirmado, eles aparecem aqui.',
          }),
    );
  }

  // Preenchida pela etapa de indicação (S5): link e andamento por campanha.
  function secaoIndicacao() {
    return null;
  }

  const rota = location.pathname.replace(/\/+$/, '');
  if (rota === '/ticket/conta/confirmar') telaConfirmar();
  else if (rota === '/ticket/conta/esqueci') telaEsqueci();
  else if (rota === '/ticket/conta/redefinir') telaRedefinir();
  else telaConta();
})();
