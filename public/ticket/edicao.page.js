// Trimundi — página pública da edição (/ticket/<evento>/<edição>): vitrine,
// escolha dos ingressos, conferência (todos no nome do titular da conta),
// aceite dos termos e ida para o pagamento. Quem decide preço, lote e estoque é o servidor
// (cotação e pedido); esta página só mostra e envia.
(() => {
  const { el, moeda, dataHora, hora, api, novaChave, enviando } = window.trimundi;
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
  // O código deste evento; sem ele, o do link geral (/tic/eventos?ind=).
  function codigoDeIndicacao() {
    try {
      const g = JSON.parse(localStorage.getItem(INDICACAO) || 'null');
      if (g && g.ate > Date.now()) return g.c;
    } catch {}
    return window.trimundi.indicacaoGeral();
  }

  // Quem indicou: o servidor diz (nome e tipo, nada mais). Logado, ele
  // também registra a origem desta conta nesta edição — o primeiro link que
  // valeu fica, inclusive para o pedido, mesmo vindo de outro aparelho depois.
  let indicadoPor = null;
  async function descobrirIndicacao() {
    try {
      const r = await api(`/ticket/api/edicoes/${encodeURIComponent(evento)}/${encodeURIComponent(edicao)}/indicacao`, {
        metodo: 'POST',
        corpo: { codigo: codigoDeIndicacao(), visitante: window.trimundi.visitante() },
      });
      indicadoPor = r.indicacao || null;
    } catch {
      indicadoPor = null; // nunca atrapalha a compra
    }
  }
  const avisoDeIndicacao = () =>
    indicadoPor
      ? el('p', {
          class: 'mensagem indicado-por',
          text:
            indicadoPor.tipo === 'operador'
              ? `Você chegou por indicação de ${indicadoPor.nome} — Operador oficial.`
              : `Você chegou por indicação de ${indicadoPor.nome}.`,
        })
      : null;

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
    document.title = `${dados.evento.nome} — ${dados.edicao.nome} · TICK`;
    await descobrirIndicacao();
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

  // Benefício com quantidade: a unidade só é separada quando o pagamento
  // confirma, então a página avisa antes da compra (pedido do dono, 10/11/2026).
  const AVISO_ESTOQUE = 'Benefício disponível enquanto durar o estoque.';

  // Evento com classificação etária (não livre): o pedido pede a declaração.
  const exigeIdade = () =>
    Boolean(dados?.edicao?.classificacao_etaria && dados.edicao.classificacao_etaria !== 'livre');

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
      el('div', { class: 'identidade-evento' }, [
        ed.logo ? el('img', { class: 'logo-evento', src: ed.logo, alt: `Logo de ${dados.evento.nome}` }) : null,
        el('div', {}, [el('p', { class: 'sobre', text: dados.evento.nome }), el('h1', { text: ed.nome })]),
      ]),
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

  // Card do ingresso (pedido do dono, 10/11/2026): no topo, o nome e o selo;
  // embaixo, o preço e a quantidade na mesma linha. Sem preço nem data do
  // próximo lote; a quantidade restante só aparece quando o lote atual tem
  // 10 ou menos (o servidor manda `restantes_no_lote` só nesse caso).
  const escassez = (n) => (n === 1 ? 'Último ingresso' : `Últimos ${n} ingressos`);

  function cardDeOferta({ nome, selo, corpo, preco, legenda, alerta, seletorDaOferta }) {
    return el('article', { class: `oferta${seletorDaOferta ? '' : ' fora'}` }, [
      el('div', { class: 'oferta-topo' }, [el('h3', { class: 'nome', text: nome }), selo]),
      ...corpo,
      seletorDaOferta
        ? el('div', { class: 'oferta-rodape' }, [
            el('div', { class: 'valor' }, [
              el('span', { class: 'preco', text: preco }),
              legenda ? el('span', { class: alerta ? 'escassez' : 'legenda', text: legenda }) : null,
            ]),
            seletorDaOferta,
          ])
        : null,
    ]);
  }

  function ofertaDeTipo(t) {
    const aVenda = t.situacao === 'a_venda';
    let situacao = SELO[t.situacao];
    if (t.situacao === 'em_breve' && t.proximo_inicio) situacao = `A partir de ${dataHora(t.proximo_inicio)}`;
    const beneficios = [...(t.beneficios || []), ...(aVenda && t.beneficio_do_lote ? [t.beneficio_do_lote.nome] : [])];
    const limitado = t.beneficios_limitados || (aVenda && t.beneficio_do_lote?.limitado);
    const pouco = aVenda && t.restantes_no_lote !== null && t.restantes_no_lote !== undefined;
    return cardDeOferta({
      nome: t.nome,
      selo: aVenda
        ? el('span', { class: 'selo ok', text: 'Disponível' })
        : el('span', { class: `selo ${t.situacao === 'esgotado' ? 'erro' : 'alerta'}`, text: situacao }),
      corpo: [
        t.descricao ? el('p', { class: 'detalhe', text: t.descricao }) : null,
        beneficios.length
          ? el(
              'ul',
              { class: 'chips', 'aria-label': 'Benefícios' },
              beneficios.map((b) => el('li', { class: 'chip', text: b })),
            )
          : null,
        limitado ? el('p', { class: 'aviso-estoque', text: AVISO_ESTOQUE }) : null,
        t.limite_por_comprador
          ? el('p', { class: 'detalhe', text: `Até ${t.limite_por_comprador} por comprador.` })
          : null,
      ],
      preco: moeda(t.preco_centavos),
      legenda: pouco ? escassez(t.restantes_no_lote) : t.lote,
      alerta: pouco,
      seletorDaOferta: aVenda ? seletor(`t:${t.id}`, t) : null,
    });
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
    return cardDeOferta({
      nome: c.nome,
      selo: aVenda
        ? el('span', { class: 'selo ok', text: 'Disponível' })
        : el('span', { class: 'selo alerta', text: rotulo[c.situacao] || 'Indisponível' }),
      corpo: [
        el('p', { class: 'detalhe', text: composicao }),
        c.descricao ? el('p', { class: 'detalhe', text: c.descricao }) : null,
        c.ingressos.some((i) => i.beneficio_limitado) ? el('p', { class: 'aviso-estoque', text: AVISO_ESTOQUE }) : null,
      ],
      preco: moeda(c.preco_total_centavos),
      legenda: `${c.ingressos_por_combo} ingressos`,
      seletorDaOferta: aVenda ? seletor(`c:${c.id}`, c) : null,
    });
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
    const blocos = [cabecalho(), avisoDeIndicacao(), pedidoEmAndamento()];
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
                : dados.limite_por_cpf
                  ? `Até ${dados.limite_por_cpf} ingressos por CPF neste evento.`
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

    // Todos os ingressos ficam no nome do titular da conta (pedido do dono,
    // 10/11/2026): nada de formulário por acompanhante. Cada um continua sendo
    // uma unidade, com número, tipo e QR Code próprios.
    const titular = el('section', { class: 'cartao titular' }, [
      el('h2', { text: 'Seus ingressos' }),
      el('p', { class: 'discreto' }, [
        'Todos ficam no nome de ',
        el('strong', { text: conta.nome }),
        `. Cada ingresso tem o próprio QR Code, e cada QR vale uma entrada.`,
      ]),
      el(
        'ol',
        { class: 'lista-ingressos' },
        cotacao.vagas.map((vaga) =>
          el('li', {}, [
            el('span', { class: 'n-ingresso', text: `Ingresso ${vaga.numero}` }),
            el('span', {
              text: `${vaga.categoria_nome}${vaga.combo_nome ? ` (promoção ${vaga.combo_nome})` : ''}`,
            }),
          ]),
        ),
      ),
      el('p', { class: 'discreto' }, [
        `Comprando como ${conta.nome} (${conta.email}). `,
        el('a', { href: `/ticket/conta?volta=${encodeURIComponent(window.location.pathname)}`, text: 'Não é você?' }),
      ]),
    ]);
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
      exigeIdade()
        ? el('label', { class: 'marcar' }, [
            el('input', { type: 'checkbox', name: 'idade', required: true }),
            `Confirmo que cada participante tem pelo menos ${dados.edicao.classificacao_etaria} anos e vai apresentar documento oficial com foto na entrada. Sem isso, a entrada é recusada e não há reembolso.`,
          ])
        : null,
    ]);
    const erro = el('p', { class: 'mensagem erro', id: 'erroPedido', role: 'alert', text: aviso || '' });
    const pagar = el('button', { class: 'btn primario grande', type: 'submit', text: 'Ir para o pagamento' });
    const form = el('form', { id: 'formPedido', novalidate: true }, [
      titular,
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
    if (aviso) erro.scrollIntoView({ block: 'center' });
  }

  function conferir(form) {
    if (!form.elements.aceite.checked) return [form.elements.aceite, 'Para continuar, aceite as regras do evento.'];
    if (exigeIdade() && !form.elements.idade.checked)
      return [
        form.elements.idade,
        `Confirme a idade mínima (${dados.edicao.classificacao_etaria} anos) dos participantes.`,
      ];
    return null;
  }

  async function enviarPedido(form, cotacao, botao, erro) {
    erro.textContent = '';
    const problema = conferir(form);
    if (problema) {
      erro.textContent = problema[1];
      problema[0].focus();
      return;
    }
    const corpo = {
      evento,
      edicao,
      itens: itensDoCarrinho(),
      // Sem `participantes`: o servidor põe cada ingresso no nome do titular.
      aceite: { aceito: true, termos: cotacao.termos.map((t) => t.id), idade: exigeIdade() ? true : undefined },
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
      if (err.codigo === 'pedido_pendente' && /^\/ticket\/pedido\/[0-9a-f-]+\?t=[A-Za-z0-9_%-]+$/.test(err.url || '')) {
        erro.replaceChildren(err.message, ' ', el('a', { href: err.url, text: 'Ver o pedido' }));
        erro.scrollIntoView({ block: 'center' });
        return;
      }
      if (err.codigo === 'conta' || err.codigo === 'aceite_conta') {
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
