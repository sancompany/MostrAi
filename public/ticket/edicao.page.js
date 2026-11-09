// Trimundi — página pública da edição (/ticket/<evento>/<edição>): vitrine,
// escolha dos ingressos, dados de cada participante, aceite dos termos e
// ida para o pagamento. Quem decide preço, lote e estoque é o servidor
// (cotação e pedido); esta página só mostra e envia.
(() => {
  const { el, moeda, dataHora, hora, api, novaChave, mascaraCpf, cpfValido, enviando } = window.trimundi;
  const main = document.getElementById('conteudo');
  const [, , evento, edicao] = window.location.pathname.split('/').map(decodeURIComponent);
  const qtd = new Map();
  let dados = null;
  let chave = null;
  let conta = null;
  let voltouDaConta = false;

  const CLASSIFICACAO = { livre: 'Livre', 10: '10 anos', 12: '12 anos', 14: '14 anos', 16: '16 anos', 18: '18 anos' };
  const TEXTOS = [
    ['regras_entrada', 'Regulamento e condições de entrada'],
    ['condicoes_especiais', 'Condições especiais'],
    ['termos_compra', 'Termos e condições de compra'],
  ];
  const GUARDADO = 'trimundi:pedido-em-andamento';
  // Carrinho guardado enquanto a pessoa entra ou cria a conta (volta aqui).
  const CARRINHO = `trimundi:carrinho:${evento}/${edicao}`.toLowerCase();
  // Link de indicação (?ind=CÓDIGO): guardado por 30 dias para esta edição e
  // enviado no pedido. Quem decide se vale é o servidor.
  const INDICACAO = `trimundi:indicacao:${evento}/${edicao}`.toLowerCase();
  (() => {
    const ind = new URLSearchParams(window.location.search).get('ind');
    try {
      if (ind && /^[A-Za-z2-9]{8}$/.test(ind)) {
        localStorage.setItem(INDICACAO, JSON.stringify({ c: ind.toUpperCase(), ate: Date.now() + 30 * 86400000 }));
      }
    } catch {}
  })();
  function codigoDeIndicacao() {
    try {
      const g = JSON.parse(localStorage.getItem(INDICACAO) || 'null');
      return g && g.ate > Date.now() ? g.c : null;
    } catch {
      return null;
    }
  }

  async function carregar() {
    try {
      dados = await api(`/ticket/api/edicoes/${encodeURIComponent(evento)}/${encodeURIComponent(edicao)}`);
    } catch (err) {
      main.replaceChildren(
        el('div', { class: 'cartao' }, [
          el('h1', { text: err.status === 404 ? 'Evento não encontrado' : 'Não foi possível carregar agora' }),
          el('p', { text: err.status === 404 ? 'Confira o endereço com quem organiza o evento.' : err.message }),
          err.status === 404
            ? null
            : el('button', { class: 'btn', type: 'button', text: 'Tentar novamente', onclick: carregar }),
        ]),
      );
      return;
    }
    document.title = `${dados.evento.nome} — ${dados.edicao.nome} · Trimundi`;
    try {
      const guardado = JSON.parse(sessionStorage.getItem(CARRINHO) || 'null');
      sessionStorage.removeItem(CARRINHO);
      if (Array.isArray(guardado)) for (const [k, n] of guardado) if (Number(n) > 0) qtd.set(String(k), Number(n));
      voltouDaConta = qtd.size > 0;
    } catch {}
    // Quantidade escolhida que não cabe mais (esgotou) volta para o máximo.
    for (const [k, n] of qtd) {
      const item = itemDaChave(k);
      if (!item) qtd.delete(k);
      else qtd.set(k, Math.min(n, item.max_quantidade));
    }
    mostrarEscolha();
    // Voltou de entrar na conta com o carrinho guardado: segue para os dados.
    if (voltouDaConta && qtd.size) {
      voltouDaConta = false;
      cotar();
    }
  }

  const itemDaChave = (k) => {
    const [tipo, id] = [k[0], Number(k.slice(2))];
    return (tipo === 't' ? dados.tipos : dados.combos).find((x) => Number(x.id) === id);
  };
  const ingressosNoCarrinho = () =>
    [...qtd].reduce((s, [k, n]) => s + n * (k[0] === 'c' ? itemDaChave(k)?.ingressos_por_combo || 1 : 1), 0);
  const subtotal = () =>
    [...qtd].reduce((s, [k, n]) => {
      const item = itemDaChave(k);
      return s + n * (k[0] === 'c' ? item.preco_total_centavos : item.preco_centavos || 0);
    }, 0);

  function cabecalho() {
    const ed = dados.edicao;
    const local = ed.local
      ? [
          ed.local.nome,
          [ed.local.logradouro, ed.local.numero].filter(Boolean).join(', '),
          ed.local.bairro,
          [ed.local.cidade, ed.local.uf].filter(Boolean).join('/'),
        ]
          .filter(Boolean)
          .join(' · ')
      : 'A definir';
    return el('section', { class: 'cabecalho-evento' }, [
      ed.banner ? el('img', { class: 'banner', src: ed.banner, alt: '' }) : null,
      el('p', { class: 'sobre', text: dados.evento.nome }),
      el('h1', { text: ed.nome }),
      el('ul', { class: 'fatos' }, [
        el('li', {}, [
          el('span', { class: 'rotulo', text: 'Data' }),
          el('span', { text: dataHora(ed.inicio_em) || 'A definir' }),
        ]),
        el('li', {}, [el('span', { class: 'rotulo', text: 'Local' }), el('span', { text: local })]),
        ed.classificacao_etaria
          ? el('li', {}, [
              el('span', { class: 'rotulo', text: 'Classificação' }),
              el('span', { text: CLASSIFICACAO[ed.classificacao_etaria] || ed.classificacao_etaria }),
            ])
          : null,
      ]),
      ed.descricao ? el('p', { class: 'descricao', text: ed.descricao }) : null,
      ed.galeria?.length
        ? el(
            'div',
            { class: 'galeria' },
            ed.galeria.map((url) => el('img', { src: url, alt: '', loading: 'lazy' })),
          )
        : null,
    ]);
  }

  function seletor(chaveItem, item) {
    const atual = qtd.get(chaveItem) || 0;
    const porUnidade = chaveItem[0] === 'c' ? item.ingressos_por_combo : 1;
    const cabeMais =
      atual < item.max_quantidade && ingressosNoCarrinho() + porUnidade <= dados.max_ingressos_por_pedido;
    const mudar = (delta) => {
      const n = Math.max(0, Math.min(item.max_quantidade, (qtd.get(chaveItem) || 0) + delta));
      if (n) qtd.set(chaveItem, n);
      else qtd.delete(chaveItem);
      chave = null;
      mostrarEscolha({ foco: `${chaveItem}:${delta > 0 ? 'mais' : 'menos'}` });
    };
    return el('div', { class: 'quantidade', role: 'group', 'aria-label': `Quantidade de ${item.nome}` }, [
      el('button', {
        type: 'button',
        text: '−',
        'aria-label': `Tirar um ${item.nome}`,
        disabled: !atual,
        dataset: { foco: `${chaveItem}:menos` },
        onclick: () => mudar(-1),
      }),
      el('output', { text: String(atual), 'aria-live': 'polite' }),
      el('button', {
        type: 'button',
        text: '+',
        'aria-label': `Pôr mais um ${item.nome}`,
        disabled: !cabeMais,
        dataset: { foco: `${chaveItem}:mais` },
        onclick: () => mudar(1),
      }),
    ]);
  }

  const SELO = {
    a_venda: null,
    esgotado: 'Esgotado',
    em_breve: 'Em breve',
    encerrado: 'Vendas encerradas',
    indisponivel: 'Indisponível',
  };

  function ofertaDeTipo(t) {
    const aVenda = t.situacao === 'a_venda';
    let situacao = SELO[t.situacao];
    if (t.situacao === 'em_breve' && t.proximo_inicio) situacao = `A partir de ${dataHora(t.proximo_inicio)}`;
    return el('div', { class: 'oferta' }, [
      el('div', {}, [
        el('div', { class: 'nome', text: t.nome }),
        t.descricao ? el('p', { class: 'detalhe', text: t.descricao }) : null,
        aVenda
          ? el('p', { class: 'detalhe' }, [
              el('span', { class: 'preco', text: moeda(t.preco_centavos) }),
              ` · ${t.lote}`,
              t.vendas_ate ? ` · vendas até ${dataHora(t.vendas_ate)}` : '',
            ])
          : el('span', { class: `selo ${t.situacao === 'esgotado' ? 'erro' : 'alerta'}`, text: situacao }),
        aVenda && t.disponibilidade
          ? el('span', {
              class: `selo${t.disponibilidade.startsWith('Últimas') ? ' alerta' : ''}`,
              text: t.disponibilidade,
            })
          : null,
        aVenda && t.proximo_lote
          ? el('p', {
              class: 'detalhe',
              text: `Próximo: ${t.proximo_lote.lote} · ${moeda(t.proximo_lote.preco_centavos)}`,
            })
          : null,
        aVenda && t.beneficio_do_lote
          ? el('p', { class: 'beneficio-lote' }, [
              el('strong', { text: `Direito a: ${t.beneficio_do_lote.nome}` }),
              t.beneficio_do_lote.restam ? ` · restam ${t.beneficio_do_lote.restam}` : '',
            ])
          : null,
        t.limite_por_comprador
          ? el('p', { class: 'detalhe', text: `Até ${t.limite_por_comprador} por comprador.` })
          : null,
        t.beneficios?.length
          ? el(
              'ul',
              { class: 'chips' },
              t.beneficios.map((b) => el('li', { class: 'chip', text: b })),
            )
          : null,
      ]),
      aVenda ? seletor(`t:${t.id}`, t) : null,
    ]);
  }

  function ofertaDeCombo(c) {
    const aVenda = c.situacao === 'a_venda';
    // Itens iguais (mesmo tipo e mesmo benefício) somados: "2× Pista".
    const somados = new Map();
    for (const i of c.ingressos) {
      const k = `${i.categoria}|${i.beneficio || ''}`;
      somados.set(k, { ...i, quantidade: (somados.get(k)?.quantidade || 0) + i.quantidade });
    }
    const composicao = [...somados.values()]
      .map((i) => `${i.quantidade}× ${i.categoria}${i.beneficio ? ` (com ${i.beneficio})` : ''}`)
      .join(' + ');
    const rotulo = {
      esgotada: 'Esgotada',
      em_breve: 'Em breve',
      fora_da_validade: 'Encerrada',
      inativa: 'Indisponível',
      indisponivel: 'Indisponível',
    };
    return el('div', { class: 'oferta' }, [
      el('div', {}, [
        el('div', { class: 'nome', text: c.nome }),
        el('p', { class: 'detalhe', text: composicao }),
        c.descricao ? el('p', { class: 'detalhe', text: c.descricao }) : null,
        aVenda
          ? el('p', { class: 'detalhe' }, [
              el('span', { class: 'preco', text: moeda(c.preco_total_centavos) }),
              ` · ${c.ingressos_por_combo} ingressos`,
              c.valida_ate ? ` · até ${dataHora(c.valida_ate)}` : '',
            ])
          : el('span', { class: 'selo alerta', text: rotulo[c.situacao] || 'Indisponível' }),
      ]),
      aVenda ? seletor(`c:${c.id}`, c) : null,
    ]);
  }

  function pedidoEmAndamento() {
    try {
      const g = JSON.parse(localStorage.getItem(GUARDADO) || 'null');
      if (
        !g ||
        g.evento !== evento.toLowerCase() ||
        g.edicao !== edicao.toLowerCase() ||
        new Date(g.expira) <= new Date()
      )
        return null;
      return el('p', { class: 'mensagem alerta' }, [
        `Você tem um pedido aguardando pagamento até ${hora(g.expira)}. `,
        el('a', { href: g.url, text: 'Ver o pedido' }),
      ]);
    } catch {
      return null;
    }
  }

  function mostrarEscolha({ foco = null, aviso = null } = {}) {
    const blocos = [cabecalho(), pedidoEmAndamento()];
    if (aviso) blocos.push(el('p', { class: 'mensagem erro', role: 'alert', text: aviso }));
    if (!dados.venda_aberta)
      blocos.push(el('p', { class: 'mensagem alerta', text: dados.mensagem || 'Vendas fechadas.' }));
    const ofertas = el('section', { class: 'cartao', 'aria-labelledby': 'tituloIngressos' }, [
      el('h2', { id: 'tituloIngressos', text: 'Ingressos' }),
      dados.tipos.length
        ? dados.tipos.map(ofertaDeTipo)
        : el('p', { class: 'discreto', text: 'Os ingressos desta edição ainda não estão à venda.' }),
    ]);
    blocos.push(ofertas);
    if (dados.combos.length) {
      blocos.push(
        el('section', { class: 'cartao', 'aria-labelledby': 'tituloCombos' }, [
          el('h2', { id: 'tituloCombos', text: 'Promoções' }),
          dados.combos.map(ofertaDeCombo),
        ]),
      );
    }
    const n = ingressosNoCarrinho();
    const continuar = el('button', {
      class: 'btn primario',
      type: 'button',
      text: 'Continuar',
      disabled: !n || !dados.venda_aberta,
      onclick: cotar,
    });
    blocos.push(
      el('div', { class: 'barra-total' }, [
        el('div', { class: 'dentro' }, [
          el('div', { class: 'soma' }, [
            n ? `${n} ${n === 1 ? 'ingresso' : 'ingressos'} · ${moeda(subtotal())}` : 'Escolha seus ingressos',
            el('small', {
              text: n
                ? 'O total final aparece na próxima etapa.'
                : `Até ${dados.max_ingressos_por_pedido} ingressos por pedido.`,
            }),
          ]),
          continuar,
        ]),
      ]),
    );
    main.replaceChildren(...blocos.filter(Boolean));
    if (foco) main.querySelector(`[data-foco="${foco}"]:not(:disabled)`)?.focus();
  }

  const itensDoCarrinho = () => ({
    tipos: [...qtd]
      .filter(([k]) => k[0] === 't')
      .map(([k, n]) => ({ categoria_id: Number(k.slice(2)), quantidade: n })),
    combos: [...qtd]
      .filter(([k]) => k[0] === 'c')
      .map(([k, n]) => ({ promocao_id: Number(k.slice(2)), quantidade: n })),
  });

  // A compra é pela conta (com e-mail confirmado): sem sessão, guarda o
  // carrinho e vai entrar/criar a conta; a conta traz de volta para cá.
  async function cotar(e) {
    const botao = e?.currentTarget;
    conta = await api('/ticket/api/conta/sessao').catch(() => ({ logado: false }));
    if (!conta.logado) {
      try {
        sessionStorage.setItem(CARRINHO, JSON.stringify([...qtd]));
      } catch {}
      window.location.assign(`/ticket/conta?volta=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    try {
      const cotacao = await enviando(botao || document.createElement('button'), 'Conferindo...', () =>
        api('/ticket/api/cotacao', { metodo: 'POST', corpo: { evento, edicao, itens: itensDoCarrinho() } }),
      );
      chave ||= novaChave();
      mostrarDados(cotacao);
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (err.codigo === 'esgotado' || err.status === 409) {
        await carregar();
        mostrarEscolha({ aviso: err.message });
      } else {
        mostrarEscolha({ aviso: err.message });
      }
    }
  }

  function campo(rotulo, nome, atributos = {}) {
    const id = `${nome}-${Math.random().toString(36).slice(2, 8)}`;
    return el('div', { class: 'campo' }, [
      el('label', { for: id, text: rotulo }),
      el('input', { id, name: nome, ...atributos }),
    ]);
  }

  function pessoa(prefixo) {
    const bloco = el('div', { class: 'grade-2' }, [
      campo('Nome completo', `${prefixo}nome`, { autocomplete: 'off', maxlength: 120, required: true }),
      campo('CPF', `${prefixo}cpf`, {
        inputmode: 'numeric',
        autocomplete: 'off',
        maxlength: 14,
        required: true,
        placeholder: '000.000.000-00',
      }),
      campo('E-mail', `${prefixo}email`, { type: 'email', autocomplete: 'off', maxlength: 200, required: true }),
    ]);
    for (const i of bloco.querySelectorAll('input[name$="cpf"]')) mascaraCpf(i);
    return bloco;
  }

  function mostrarDados(cotacao, aviso = null) {
    const textos = TEXTOS.filter(([k]) => dados.textos[k]);
    const resumo = el('section', { class: 'cartao' }, [
      el('h2', { text: 'Resumo do pedido' }),
      el('table', { class: 'tabela' }, [
        el(
          'thead',
          {},
          el('tr', {}, [
            el('th', { text: 'Item' }),
            el('th', { class: 'num', text: 'Qtd.' }),
            el('th', { class: 'num', text: 'Valor' }),
          ]),
        ),
        el(
          'tbody',
          {},
          cotacao.itens.map((i) =>
            el('tr', {}, [
              el('td', { text: i.descricao }),
              el('td', { class: 'num', text: String(i.quantidade) }),
              el('td', { class: 'num', text: moeda(i.total_centavos) }),
            ]),
          ),
        ),
        el(
          'tfoot',
          {},
          el('tr', {}, [
            el('td', { text: 'Total' }),
            el('td', {}),
            el('td', { class: 'num', text: moeda(cotacao.total_centavos) }),
          ]),
        ),
      ]),
      el('p', { class: 'discreto', text: 'As taxas do meio de pagamento, se houver, aparecem na tela de pagamento.' }),
    ]);

    const comprador = el('p', { class: 'discreto' }, [
      `Comprando como ${conta.nome} (${conta.email}). `,
      el('a', { href: `/ticket/conta?volta=${encodeURIComponent(window.location.pathname)}`, text: 'Não é você?' }),
    ]);
    const participantes = cotacao.vagas.map((vaga, i) => {
      const titulo = `Ingresso ${vaga.numero} · ${vaga.categoria_nome}${vaga.combo_nome ? ` (promoção ${vaga.combo_nome})` : ''}`;
      const souEu =
        i === 0
          ? el('label', { class: 'marcar' }, [
              el('input', {
                type: 'checkbox',
                name: 'sou-eu',
                checked: true,
                onchange: (ev) => usarMinhaConta(ev.currentTarget.checked),
              }),
              'Este ingresso é meu (usar os dados da minha conta)',
            ])
          : null;
      return el('fieldset', { dataset: { vaga: String(i) } }, [
        el('legend', { text: titulo }),
        souEu,
        pessoa(`p${i}-`),
      ]);
    });
    const termos = el('section', { class: 'cartao' }, [
      el('h2', { text: 'Regras do evento' }),
      textos.map(([k, rotulo]) =>
        el('details', { class: 'termo' }, [
          el('summary', { text: `${rotulo} (versão ${dados.textos[k].versao})` }),
          el('div', { class: 'texto', text: dados.textos[k].texto }),
        ]),
      ),
      el('label', { class: 'marcar' }, [
        el('input', { type: 'checkbox', name: 'aceite', required: true }),
        `Li e aceito ${textos.map(([, r]) => r.toLowerCase()).join(', ')}.`,
      ]),
    ]);
    const erro = el('p', { class: 'mensagem erro', id: 'erroPedido', role: 'alert', text: aviso || '' });
    const pagar = el('button', { class: 'btn primario grande', type: 'submit', text: 'Ir para o pagamento' });
    const form = el('form', { id: 'formPedido', novalidate: true }, [
      el('section', { class: 'cartao' }, [
        el('h2', { text: 'Quem vai usar cada ingresso' }),
        el('p', {
          class: 'discreto',
          text: 'Cada ingresso é individual: tem o nome e o CPF de quem vai entrar. O QR Code não leva esses dados.',
        }),
        comprador,
        participantes,
      ]),
      termos,
      erro,
      el('p', { class: 'discreto', text: 'Seus ingressos ficam reservados por 30 minutos para o pagamento.' }),
      pagar,
      el(
        'p',
        {},
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Voltar e mudar os ingressos',
          onclick: () => mostrarEscolha(),
        }),
      ),
    ]);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      enviarPedido(form, cotacao, pagar, erro);
    });
    main.replaceChildren(resumo, form);
    usarMinhaConta(true);
    if (aviso) erro.scrollIntoView({ block: 'center' });
  }

  // "Este ingresso é meu": o servidor preenche com os dados da conta.
  function usarMinhaConta(marcado) {
    const bloco = document.querySelector('fieldset[data-vaga="0"] .grade-2');
    bloco.hidden = marcado;
  }

  const ler = (form, prefixo) => ({
    nome: form.elements[`${prefixo}nome`].value.trim(),
    cpf: form.elements[`${prefixo}cpf`].value,
    email: form.elements[`${prefixo}email`].value.trim(),
  });
  const ehMeu = (form, i) => i === 0 && form.elements['sou-eu']?.checked;

  function conferir(form, cotacao) {
    for (const [i] of cotacao.vagas.entries()) {
      if (ehMeu(form, i)) continue;
      const p = `p${i}-`;
      const rotulo = `Ingresso ${i + 1}`;
      const d = ler(form, p);
      if (d.nome.length < 2) return [form.elements[`${p}nome`], `${rotulo}: informe o nome completo.`];
      if (!cpfValido(d.cpf)) return [form.elements[`${p}cpf`], `${rotulo}: CPF inválido — confira os números.`];
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email))
        return [form.elements[`${p}email`], `${rotulo}: informe um e-mail válido.`];
    }
    if (!form.elements.aceite.checked) return [form.elements.aceite, 'Para continuar, aceite as regras do evento.'];
    return null;
  }

  async function enviarPedido(form, cotacao, botao, erro) {
    erro.textContent = '';
    const problema = conferir(form, cotacao);
    if (problema) {
      erro.textContent = problema[1];
      problema[0].focus();
      return;
    }
    const corpo = {
      evento,
      edicao,
      itens: itensDoCarrinho(),
      participantes: cotacao.vagas.map((_, i) => (ehMeu(form, i) ? { conta: true } : ler(form, `p${i}-`))),
      aceite: { aceito: true, termos: cotacao.termos.map((t) => t.id) },
      chave,
      indicacao: codigoDeIndicacao(),
    };
    try {
      const r = await enviando(botao, 'Reservando...', () => api('/ticket/api/pedidos', { metodo: 'POST', corpo }));
      try {
        localStorage.setItem(
          GUARDADO,
          JSON.stringify({
            url: r.url,
            evento: evento.toLowerCase(),
            edicao: edicao.toLowerCase(),
            expira: r.reserva_expira_em || new Date(Date.now() + 30 * 60000),
          }),
        );
      } catch {}
      chave = null;
      window.location.href = r.pagamento?.url || r.url;
    } catch (err) {
      if (err.codigo === 'termos') {
        await carregar();
        const nova = await api('/ticket/api/cotacao', {
          metodo: 'POST',
          corpo: { evento, edicao, itens: itensDoCarrinho() },
        }).catch(() => null);
        if (nova) mostrarDados(nova, 'As regras do evento mudaram agora há pouco — leia e aceite de novo.');
        return;
      }
      if (err.codigo === 'esgotado') {
        chave = null;
        await carregar();
        mostrarEscolha({ aviso: err.message });
        return;
      }
      if (err.codigo === 'conta') {
        try {
          sessionStorage.setItem(CARRINHO, JSON.stringify([...qtd]));
        } catch {}
        window.location.assign(`/ticket/conta?volta=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      erro.textContent = err.message;
      erro.scrollIntoView({ block: 'center' });
    }
  }

  carregar();
})();
