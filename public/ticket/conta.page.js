// Trimundi — conta do cliente (/ticket/conta e subpáginas): entrar, criar
// conta, confirmar e-mail, recuperar senha e "minha conta" (identificação,
// ingressos por evento e pedido, e "Indique e acompanhe"). O token dos links
// de e-mail vem no fragmento (#t=...) e sai da barra de endereço assim que é
// lido. Toda regra (senha, CPF, e-mail, aceite) é conferida no servidor.
(() => {
  const { el, api, mascaraCpf, cpfValido, enviando, dataHora, dataCurta, digitos, moeda, comOlho } = window.trimundi;
  const conteudo = document.getElementById('conteudo');
  const topo = document.getElementById('topoConta');
  const params = new URLSearchParams(location.search);
  // Para onde voltar depois de entrar (só caminhos da Trimundi).
  const volta = /^\/ticket\/[A-Za-z0-9/_-]+$/.test(params.get('volta') || '') ? params.get('volta') : null;
  // Versão dos Termos que esta página mostra (vem do servidor, no HTML): é a
  // que o cadastro e o reaceite mandam — o servidor recusa se não for a
  // vigente.
  const VERSAO_TERMOS = document.querySelector('meta[name="tick-termos"]')?.content || '';

  function tokenDoLink() {
    const t = new URLSearchParams(location.hash.slice(1)).get('t');
    if (t) history.replaceState(null, '', location.pathname + location.search);
    return t;
  }

  const trocar = (...nos) => conteudo.replaceChildren(...nos.flat().filter((n) => n !== null && n !== undefined));
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
  // Campo de senha com o olho (mostrar/ocultar), cada um com o seu.
  function campoSenha(rotulo, nome, atributos = {}) {
    const input = el('input', { id: nome, name: nome, type: 'password', required: true, maxlength: 200, ...atributos });
    return el('div', { class: 'campo' }, el('label', { for: nome, text: rotulo }), comOlho(input));
  }
  const SENHA = 'Mínimo de 8 caracteres, com letra maiúscula, minúscula, número e símbolo.';
  const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

  // Cabeçalho das telas de acesso: título e uma linha de contexto.
  const cabecalho = (titulo, texto) =>
    el('div', { class: 'auth-cabeca' }, el('h1', { text: titulo }), texto ? el('p', { text: texto }) : null);
  // Rodapé das telas de acesso: a outra opção (criar conta / entrar) como
  // botão secundário — visível, sem competir com o principal.
  const alternativa = (pergunta, rotulo, onclick, href = '#') =>
    el(
      'div',
      { class: 'auth-alternativa' },
      el('p', { text: pergunta }),
      el('a', { class: 'btn secundario', href, onclick, text: rotulo }),
    );

  // Maioridade e aceite: obrigatórios, nunca marcados de antemão. O texto diz
  // a versão que está sendo aceita.
  function caixasDeAceite() {
    const caixa = (nome, ...texto) =>
      el(
        'label',
        { class: 'marcar' },
        el('input', { type: 'checkbox', name: nome, required: true }),
        el('span', {}, ...texto),
      );
    return el(
      'div',
      { class: 'aceites' },
      caixa('maioridade', 'Declaro que tenho 18 anos ou mais.'),
      caixa(
        'aceite_termos',
        'Li e aceito os ',
        el('a', { href: '/ticket/termos', target: '_blank', rel: 'noopener', text: 'Termos de Uso' }),
        ' e a ',
        el('a', { href: '/ticket/privacidade', target: '_blank', rel: 'noopener', text: 'Política de Privacidade' }),
        VERSAO_TERMOS ? ` (versão ${VERSAO_TERMOS}).` : '.',
      ),
    );
  }

  // Versão nova dos Termos enquanto a página estava aberta: recarrega para
  // mostrar o texto novo antes de qualquer aceite.
  function versaoMudou(m, err) {
    if (err.codigo !== 'versao_termos') return false;
    avisar(m, 'erro', err.message);
    m.append(
      ' ',
      el('button', { class: 'btn mini', type: 'button', text: 'Ver a versão atual', onclick: () => location.reload() }),
    );
    return true;
  }

  // Conta sem o aceite da versão atual: aceita de novo antes de comprar.
  function blocoDeAceite() {
    const m = mensagem();
    const form = el(
      'form',
      { class: 'cartao aviso-aceite', novalidate: true },
      el('h2', { text: 'Confirme para continuar comprando' }),
      el('p', {
        text: 'Os Termos de Uso e a Política de Privacidade da TICK mudaram ou ainda não foram aceitos nesta conta.',
      }),
      caixasDeAceite(),
      m,
      el('button', { class: 'btn primario', type: 'submit', text: 'Confirmar' }),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.elements.maioridade.checked) return avisar(m, 'erro', 'A conta é só para maiores de 18 anos.');
      if (!form.elements.aceite_termos.checked)
        return avisar(m, 'erro', 'Aceite os Termos de Uso e a Política de Privacidade.');
      try {
        await api('/ticket/api/conta/aceite', {
          metodo: 'POST',
          corpo: { maioridade: true, aceite_termos: true, versao_termos: VERSAO_TERMOS },
        });
        if (volta) location.assign(volta);
        else form.replaceWith(el('p', { class: 'mensagem ok', text: 'Pronto. Obrigado!' }));
      } catch (err) {
        if (!versaoMudou(m, err)) avisar(m, 'erro', err.message);
      }
    });
    return form;
  }

  const trocarPara = (tela) => (e) => {
    e.preventDefault();
    tela();
  };

  function depoisDeEntrar() {
    if (volta) location.assign(volta);
    else location.assign('/ticket/conta');
  }

  // ---- entrar
  function telaEntrar(aviso = null, emailSugerido = '') {
    const m = mensagem();
    const form = el(
      'form',
      { class: 'cartao auth-cartao', novalidate: true },
      campo('E-mail', 'email', { type: 'email', autocomplete: 'email', maxlength: 200, value: emailSugerido }),
      campoSenha('Senha', 'senha', { autocomplete: 'current-password' }),
      el(
        'div',
        { class: 'auth-linha' },
        el('a', { class: 'link-suave', href: '/ticket/conta/esqueci', text: 'Esqueci a senha' }),
      ),
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
      el(
        'section',
        { class: 'auth' },
        cabecalho('Entrar', 'Acesse seus ingressos e compre com a sua conta TICK.'),
        aviso ? el('p', { class: 'mensagem ok', text: aviso }) : null,
        form,
        alternativa('Ainda não tem conta?', 'Criar conta', trocarPara(telaCadastro), '#criar'),
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
      { class: 'cartao auth-cartao', novalidate: true },
      campo('Nome completo', 'nome', { autocomplete: 'name', maxlength: 120 }),
      el('div', { class: 'campo' }, el('label', { for: 'cpf', text: 'CPF' }), cpf),
      campo('E-mail', 'email', { type: 'email', autocomplete: 'email', maxlength: 200 }),
      el(
        'div',
        { class: 'grade-2' },
        campoSenha('Senha', 'senha', { autocomplete: 'new-password' }),
        campoSenha('Confirme a senha', 'senha_confirmacao', { autocomplete: 'new-password' }),
      ),
      el('p', { class: 'ajuda-campo', text: SENHA }),
      caixasDeAceite(),
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
        senha_confirmacao: f.senha_confirmacao.value,
        maioridade: f.maioridade.checked,
        aceite_termos: f.aceite_termos.checked,
        versao_termos: VERSAO_TERMOS,
      };
      if (dados.nome.length < 2) return avisar(m, 'erro', 'Informe seu nome completo.');
      if (!cpfValido(dados.cpf)) return avisar(m, 'erro', 'CPF inválido — confira os números.');
      if (!emailOk(dados.email)) return avisar(m, 'erro', 'Informe um e-mail válido.');
      if (dados.senha !== dados.senha_confirmacao)
        return avisar(m, 'erro', 'A confirmação da senha não confere — digite a mesma senha nos dois campos.');
      if (!dados.maioridade) return avisar(m, 'erro', 'A conta é só para maiores de 18 anos.');
      if (!dados.aceite_termos) return avisar(m, 'erro', 'Aceite os Termos de Uso e a Política de Privacidade.');
      try {
        const r = await enviando(form.querySelector('[type="submit"]'), 'Criando...', () =>
          api('/ticket/api/conta/cadastro', { metodo: 'POST', corpo: dados }),
        );
        trocar(
          el(
            'section',
            { class: 'auth' },
            cabecalho('Confirme seu e-mail'),
            el('p', { class: 'mensagem ok', text: r.mensagem }),
            el('p', {
              class: 'discreto',
              text: 'Não chegou? Veja a caixa de spam ou tente entrar para reenviar o link.',
            }),
            el('a', { class: 'btn secundario', href: `/ticket/conta${location.search}`, text: 'Voltar para entrar' }),
          ),
        );
      } catch (err) {
        if (versaoMudou(m, err)) return;
        avisar(m, 'erro', err.message);
        // Já tem conta (e-mail ou CPF): leva ao login, com o e-mail digitado.
        if (err.codigo === 'email_em_uso' || err.codigo === 'cpf_em_uso') {
          m.append(
            ' ',
            el('button', {
              class: 'btn mini',
              type: 'button',
              text: 'Entrar na minha conta',
              onclick: () => telaEntrar(null, err.codigo === 'email_em_uso' ? dados.email : ''),
            }),
          );
        }
      }
    });
    trocar(
      el(
        'section',
        { class: 'auth' },
        cabecalho(
          'Criar conta',
          'Só o necessário: nome, CPF, e-mail e senha. Depois de confirmar o e-mail, você compra e vê seus ingressos aqui.',
        ),
        form,
        alternativa('Já tem conta?', 'Entrar', trocarPara(telaEntrar), '#entrar'),
      ),
    );
  }

  // ---- links do e-mail
  async function telaConfirmar() {
    const t = tokenDoLink();
    try {
      await api('/ticket/api/conta/confirmar', { metodo: 'POST', corpo: { token: t } });
      trocar(
        el(
          'section',
          { class: 'auth' },
          cabecalho('E-mail confirmado'),
          el('p', { class: 'mensagem ok', text: 'Sua conta está ativa. Você já pode comprar.' }),
          el('a', { class: 'btn primario grande', href: '/ticket/conta', text: 'Ver minha conta' }),
        ),
      );
    } catch (err) {
      trocar(
        el(
          'section',
          { class: 'auth' },
          cabecalho('Não deu para confirmar'),
          el('p', { class: 'mensagem erro', text: err.message }),
          el('a', { class: 'btn secundario', href: '/ticket/conta', text: 'Entrar para reenviar o link' }),
        ),
      );
    }
  }

  function telaEsqueci() {
    const m = mensagem();
    const form = el(
      'form',
      { class: 'cartao auth-cartao', novalidate: true },
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
    trocar(
      el(
        'section',
        { class: 'auth' },
        cabecalho('Recuperar a senha', 'Enviamos um link para você criar uma senha nova.'),
        form,
        alternativa('Lembrou a senha?', 'Entrar', null, '/ticket/conta'),
      ),
    );
  }

  function telaRedefinir() {
    const t = tokenDoLink();
    const m = mensagem();
    const form = el(
      'form',
      { class: 'cartao auth-cartao', novalidate: true },
      campoSenha('Senha nova', 'senha', { autocomplete: 'new-password' }),
      el('p', { class: 'ajuda-campo', text: SENHA }),
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
    trocar(el('section', { class: 'auth' }, cabecalho('Senha nova'), form));
  }

  // ---- minha conta
  const SELO_PEDIDO = {
    pago: 'ok',
    aguardando_pagamento: 'alerta',
    pago_sem_vaga: 'alerta',
    expirado: '',
    cancelado: 'erro',
    estornado: 'erro',
  };

  // Um ingresso = uma unidade (pedido do dono, 10/11/2026): número no pedido
  // (fixo — não é o lote), nome do titular, tipo, QR próprio (só válido, pago
  // e não usado) e a situação. Os benefícios DESTE ingresso aparecem nele; o
  // benefício do titular da conta (recompensa de indicação) aparece só no
  // ingresso principal, nunca repetido nos outros.
  const textoDoNumero = (i) =>
    i.numero ? `Ingresso ${i.numero}${i.numero_de ? ` de ${i.numero_de}` : ''}` : 'Ingresso';
  const textoDoTitular = (b) =>
    [
      b.a_retirar ? `${b.a_retirar} para retirar` : null,
      b.entregues ? `${b.entregues} ${b.entregues === 1 ? 'entregue' : 'entregues'}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

  function ingresso(i) {
    const usado = Boolean(i.utilizado_em);
    const situacao = usado
      ? ['Utilizado', `Entrada em ${dataCurta(i.utilizado_em)}`]
      : { valido: ['Válido'], bloqueado: ['Bloqueado'], cancelado: ['Cancelado'] }[i.status] || [i.status];
    const classe = usado ? 'usado' : i.status === 'valido' ? 'valido' : 'inativo';
    const doTitular = i.principal ? i.beneficios_do_titular || [] : [];
    return el(
      'div',
      { class: `ingresso ${classe}${i.principal ? ' principal' : ''}`, dataset: { numero: String(i.numero ?? '') } },
      el(
        'div',
        { class: 'ingresso-numero' },
        el('span', { text: textoDoNumero(i) }),
        i.principal ? el('span', { class: 'selo titular', text: 'Principal · titular' }) : null,
      ),
      el(
        'div',
        { class: 'ingresso-topo' },
        el('strong', { text: i.categoria }),
        el('span', {
          class: `selo ${classe === 'valido' ? 'ok' : classe === 'usado' ? '' : 'erro'}`,
          text: situacao[0],
        }),
      ),
      el('div', { class: 'discreto', text: `Nome: ${i.participante}` }),
      i.qr
        ? el('img', {
            class: 'qr',
            src: i.qr,
            alt: `QR Code do ${textoDoNumero(i).toLowerCase()} (${i.codigo_curto})`,
            width: 240,
            height: 240,
          })
        : el('div', {
            class: 'qr-vazio',
            text: usado ? situacao[1] : 'Este ingresso não vale para entrar.',
          }),
      el('div', { class: 'codigo', text: i.codigo_curto }),
      i.beneficios?.length
        ? el(
            'div',
            { class: 'beneficios-ingresso' },
            el('span', { class: 'rotulo-beneficio', text: 'Benefícios deste ingresso' }),
            el(
              'ul',
              { class: 'chips' },
              i.beneficios.map((b) =>
                el('li', { class: 'chip', text: b.resgatado_em ? `${b.nome} — resgatado` : b.nome }),
              ),
            ),
          )
        : null,
      doTitular.length
        ? el(
            'div',
            { class: 'beneficios-titular' },
            el('span', { class: 'rotulo-beneficio', text: 'Benefício do titular (indicação)' }),
            el(
              'ul',
              { class: 'chips' },
              doTitular.map((b) => el('li', { class: 'chip destaque', text: `${b.nome} — ${textoDoTitular(b)}` })),
            ),
          )
        : null,
    );
  }

  // Um pedido = um cartão (um evento só, sempre).
  function cartaoPedido(p) {
    const itens = p.itens.map((x) => `${x.quantidade}× ${x.descricao}`).join(' · ');
    const acoes = [];
    if (p.status === 'aguardando_pagamento') {
      const b = el('button', { class: 'btn primario', type: 'button', text: 'Continuar pagamento' });
      b.addEventListener('click', async () => {
        try {
          const r = await enviando(b, 'Abrindo...', () =>
            api(`/ticket/api/conta/pedidos/${encodeURIComponent(p.id)}/link`, { metodo: 'POST', corpo: {} }),
          );
          location.assign(r.url);
        } catch (err) {
          b.replaceWith(el('p', { class: 'mensagem erro', text: err.message }));
        }
      });
      acoes.push(b);
    }
    return el(
      'article',
      { class: `pedido-card ${p.status}` },
      el(
        'header',
        { class: 'pedido-topo' },
        el('span', { class: 'discreto', text: `Pedido ${p.codigo} · ${dataCurta(p.criado_em)}` }),
        el('span', { class: `selo ${SELO_PEDIDO[p.status] ?? ''}`, text: p.situacao }),
      ),
      el('p', { class: 'pedido-itens', text: `${itens} · ${moeda(p.total_centavos)}` }),
      p.reserva_expira_em
        ? el('p', {
            class: 'discreto',
            text: `Reserva até ${dataCurta(p.reserva_expira_em)}. Depois disso, os ingressos voltam à venda.`,
          })
        : null,
      acoes.length ? el('div', { class: 'acoes' }, ...acoes) : null,
      p.ingressos.length ? el('div', { class: 'ingressos' }, p.ingressos.map(ingresso)) : null,
    );
  }

  // Um evento (edição) = um grupo; dentro, os pedidos. Pedido que não deu
  // certo (expirado, cancelado) fica recolhido.
  function grupoDoEvento(g) {
    const vivos = g.pedidos.filter((p) => !['expirado', 'cancelado'].includes(p.status));
    const mortos = g.pedidos.filter((p) => ['expirado', 'cancelado'].includes(p.status));
    return el(
      'section',
      { class: 'evento-grupo' },
      el(
        'header',
        { class: 'evento-grupo-topo' },
        el('h3', {}, el('span', { class: 'sobre', text: g.evento }), el('span', { text: g.edicao })),
        el('p', {
          class: 'discreto',
          text: [g.inicio_em ? dataHora(g.inicio_em) : 'Data a definir', g.local || 'Local a definir'].join(' · '),
        }),
        el('a', { class: 'link-suave', href: g.endereco_publico, text: 'Página do evento' }),
      ),
      vivos.map(cartaoPedido),
      mortos.length
        ? el(
            'details',
            { class: 'nao-concluidos' },
            el('summary', { text: `Pedidos não concluídos (${mortos.length})` }),
            mortos.map(cartaoPedido),
          )
        : null,
    );
  }

  function secaoIngressos(d) {
    const temAlgum = d.edicoes.length > 0;
    return el(
      'section',
      { class: 'conta-secao', 'aria-labelledby': 'tituloIngressos' },
      el('h2', { id: 'tituloIngressos', text: 'Meus ingressos' }),
      temAlgum
        ? d.edicoes.map(grupoDoEvento)
        : el(
            'div',
            { class: 'cartao vazio-ingressos' },
            el('p', { text: 'Você ainda não tem ingressos. Quando o pagamento for confirmado, eles aparecem aqui.' }),
            el('a', { class: 'btn primario', href: '/tic/eventos', text: 'Ver eventos' }),
          ),
    );
  }

  // Área do operador (11/11/2026): aparece quando a conta está ligada a um
  // operador — os eventos em que ele trabalha na portaria, com o desempenho
  // de indicação de cada um separado, e o botão da portaria. Mesmo login.
  function secaoOperador(op) {
    if (!op) return null;
    const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
    const eventos = op.eventos.length
      ? el(
          'ul',
          { class: 'lista-indicados' },
          op.eventos.map((e) =>
            el(
              'li',
              {},
              el(
                'div',
                { class: 'indicado-topo' },
                el('strong', { text: e.nome }),
                el('span', { class: 'discreto', text: e.inicio_em ? dataCurta(e.inicio_em) : 'Data a definir' }),
              ),
              el('span', {
                class: 'discreto',
                text: `Por indicação: ${plural(e.pessoas, 'pessoa', 'pessoas')} · ${plural(e.ingressos, 'ingresso', 'ingressos')}`,
              }),
            ),
          ),
        )
      : el('p', {
          class: 'discreto',
          text: op.ativo
            ? 'Nenhum evento está liberado para você na portaria agora.'
            : 'Seu acesso de operador está pausado — fale com quem organiza o evento.',
        });
    return el(
      'section',
      { class: 'conta-secao', 'aria-labelledby': 'tituloOperador' },
      el('h2', { id: 'tituloOperador', text: 'Área do operador' }),
      el(
        'div',
        { class: 'cartao' },
        el('p', { class: 'discreto', text: `Você trabalha na portaria como ${op.nome}. Eventos liberados para você:` }),
        eventos,
        op.portaria ? el('a', { class: 'btn primario grande', href: op.portaria, text: 'Abrir a portaria' }) : null,
      ),
    );
  }

  // Código de ativação de operador guardado nesta aba (veio do link e a
  // pessoa entrou ou criou a conta): um atalho para terminar.
  function ativacaoPendente(op) {
    let pendente = '';
    try {
      pendente = sessionStorage.getItem('tick:ativacao-operador') || '';
    } catch {}
    if (!pendente || op?.ativo) return null;
    return el(
      'div',
      { class: 'cartao aviso-aceite' },
      el('p', { text: 'Você começou a ativar o acesso de operador nesta conta.' }),
      el('a', { class: 'btn primario', href: '/ticket/ativar', text: 'Continuar a ativação' }),
    );
  }

  async function telaConta() {
    let d;
    try {
      d = await api('/ticket/api/conta');
    } catch (err) {
      if (err.status === 401) {
        // `#criar` (vindo da ativação de operador, por exemplo): já abre o cadastro.
        if (location.hash === '#criar') return telaCadastro();
        return telaEntrar(volta ? 'Entre na sua conta para continuar.' : null);
      }
      return trocar(el('p', { class: 'mensagem erro', text: err.message }));
    }
    // Chegou pelo link geral de indicação antes de ter conta: com a conta
    // aberta, o servidor liga aquela visita a ela (conta "criou conta pela
    // indicação" mesmo sem abrir uma página de evento depois).
    const codigoGeral = window.trimundi.indicacaoGeral();
    if (codigoGeral) {
      api('/ticket/api/indicacao/visita', {
        metodo: 'POST',
        corpo: { codigo: codigoGeral, visitante: window.trimundi.visitante() },
      }).catch(() => {});
    }
    topo.replaceChildren(
      el('button', {
        class: 'btn-conta',
        type: 'button',
        text: 'Sair',
        onclick: async () => {
          await api('/ticket/api/conta/sair', { metodo: 'POST', corpo: {} }).catch(() => {});
          location.assign('/ticket/conta');
        },
      }),
    );
    trocar(
      el(
        'section',
        { class: 'cartao identificacao', 'aria-label': 'Sua conta' },
        el('h1', { text: `Olá, ${d.conta.nome.split(' ')[0]}` }),
        el(
          'p',
          { class: 'discreto' },
          el('span', { text: d.conta.email }),
          ' · ',
          el('span', { text: `CPF ${d.conta.cpf}` }),
        ),
      ),
      d.conta.aceite_pendente ? blocoDeAceite() : null,
      ativacaoPendente(d.operador),
      secaoOperador(d.operador),
      secaoIngressos(d),
      window.trimundi.indiqueEAcompanhe(d.indicacao),
    );
  }

  const rota = location.pathname.replace(/\/+$/, '');
  if (rota === '/ticket/conta/confirmar') telaConfirmar();
  else if (rota === '/ticket/conta/esqueci') telaEsqueci();
  else if (rota === '/ticket/conta/redefinir') telaRedefinir();
  else telaConta();
})();
