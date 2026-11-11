// Trimundi — página do pedido (/ticket/pedido/<id>?t=<token>): situação do
// pagamento e, depois de pago, um cartão por ingresso com o QR, o código
// para digitar e o nome de quem entra. O token vai em cabeçalho para a API
// (não fica em log de URL); sem ele, o pedido não abre.
(() => {
  const { el, moeda, dataHora, hora, dataCurta, api } = window.trimundi;
  const main = document.getElementById('conteudo');
  const id = window.location.pathname.split('/')[3] || '';
  const token = new URLSearchParams(window.location.search).get('t') || '';
  let espera = null;
  let relogio = null;

  const SITUACAO = {
    aguardando_pagamento: ['alerta', 'Aguardando pagamento'],
    pago: ['ok', 'Pago'],
    cancelado: ['erro', 'Cancelado'],
    expirado: ['erro', 'Reserva expirada'],
    estornado: ['erro', 'Reembolsado'],
    pago_sem_vaga: ['alerta', 'Pago — em devolução'],
  };
  const INGRESSO = { valido: ['ok', 'Válido'], cancelado: ['erro', 'Cancelado'], bloqueado: ['alerta', 'Bloqueado'] };

  function erro(titulo, texto) {
    main.replaceChildren(
      el('div', { class: 'cartao' }, [
        el('h1', { text: titulo }),
        el('p', { text: texto }),
        el('p', {}, el('a', { href: '/ticket/recuperar', text: 'Recuperar o link do pedido' })),
      ]),
    );
  }

  async function carregar() {
    if (!token) return erro('Link incompleto', 'Abra o link que chegou no seu e-mail, ou recupere o link do pedido.');
    let d;
    try {
      d = await api(`/ticket/api/pedidos/${encodeURIComponent(id)}`, { cabecalhos: { 'X-Pedido-Token': token } });
    } catch (err) {
      if (err.status === 404) return erro('Pedido não encontrado', 'Confira se o link está completo.');
      return erro('Não foi possível carregar agora', err.message);
    }
    mostrar(d);
    agendar(d);
  }

  // Aguardando pagamento: confere de novo a cada 5 s até a reserva vencer
  // (a confirmação chega por aviso do Checkout, alguns segundos depois).
  function agendar(d) {
    clearTimeout(espera);
    if (d.pedido.status !== 'aguardando_pagamento') return;
    if (new Date(d.pedido.reserva_expira_em).getTime() + 120000 < Date.now()) return;
    espera = setTimeout(() => (document.hidden ? agendar(d) : carregar()), 5000);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && espera) carregar();
  });

  function contagem(alvo, fim) {
    clearInterval(relogio);
    const tick = () => {
      const s = Math.max(0, Math.round((new Date(fim).getTime() - Date.now()) / 1000));
      alvo.textContent = s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'encerrada';
      if (!s) clearInterval(relogio);
    };
    tick();
    relogio = setInterval(tick, 1000);
  }

  function cabecalho(d) {
    const ed = d.edicao;
    return el('section', { class: 'cabecalho-evento' }, [
      ed.banner ? el('img', { class: 'banner', src: ed.banner, alt: '' }) : null,
      el('p', { class: 'sobre', text: ed.evento }),
      el('h1', { text: ed.nome }),
      el('ul', { class: 'fatos' }, [
        el('li', {}, [
          el('span', { class: 'rotulo', text: 'Data' }),
          el('span', { text: dataHora(ed.inicio_em) || 'A definir' }),
        ]),
        el('li', {}, [
          el('span', { class: 'rotulo', text: 'Local' }),
          el('span', {
            text: ed.local ? `${ed.local.nome}${ed.local.endereco ? ` · ${ed.local.endereco}` : ''}` : 'A definir',
          }),
        ]),
      ]),
    ]);
  }

  function resumo(d) {
    const p = d.pedido;
    const [cor, rotulo] = SITUACAO[p.status] || ['', p.status_rotulo];
    return el('section', { class: 'cartao' }, [
      el('h2', {}, [
        `Pedido ${p.codigo} `,
        el('span', { class: `selo ${cor}`, text: rotulo }),
        p.teste ? el('span', { class: 'selo', text: ' Teste' }) : null,
      ]),
      el('table', { class: 'tabela' }, [
        el(
          'tbody',
          {},
          p.itens.map((i) =>
            el('tr', {}, [
              el('td', { text: i.descricao }),
              el('td', { class: 'num', text: `${i.quantidade}×` }),
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
            el('td', { class: 'num', text: moeda(p.total_centavos) }),
          ]),
        ),
      ]),
    ]);
  }

  function blocoDoPagamento(d) {
    const p = d.pedido;
    if (p.status === 'aguardando_pagamento') {
      const restante = el('strong', {});
      const bloco = el('section', { class: 'cartao' }, [
        p.pagamento_recusado
          ? el('p', {
              class: 'mensagem erro',
              role: 'alert',
              text: `O pagamento não foi aprovado. Você pode tentar de novo, com outro cartão ou Pix, até ${hora(p.reserva_expira_em)}.`,
            })
          : null,
        el('p', {}, ['Seus ingressos estão reservados. Tempo para pagar: ', restante, '.']),
        d.pagamento?.url
          ? el('a', {
              class: 'btn primario grande',
              href: d.pagamento.url,
              text: p.pagamento_recusado ? 'Tentar pagar de novo' : 'Pagar agora',
            })
          : el('p', {
              class: 'mensagem alerta',
              text: 'O pagamento desta edição ainda não está disponível — fale com quem organiza o evento.',
            }),
        el('p', {
          class: 'discreto',
          text: 'Depois do pagamento, os ingressos aparecem nesta página e o link chega no seu e-mail.',
        }),
      ]);
      contagem(restante, p.reserva_expira_em);
      return bloco;
    }
    if (p.status === 'expirado' || p.status === 'cancelado') {
      return el('p', { class: 'mensagem alerta' }, [
        'A reserva acabou sem pagamento e os ingressos voltaram à venda. ',
        el('a', { href: d.edicao.endereco_publico, text: 'Voltar à página do evento' }),
      ]);
    }
    if (p.status === 'pago_sem_vaga') {
      return el('p', {
        class: 'mensagem alerta',
        text: 'O pagamento chegou depois do fim da reserva e os ingressos já tinham esgotado. A organização vai devolver o valor pelo mesmo meio de pagamento.',
      });
    }
    if (p.status === 'estornado')
      return el('p', { class: 'mensagem alerta', text: 'Este pedido foi reembolsado. Os ingressos não valem mais.' });
    return null;
  }

  function baixarQr(i) {
    const a = el('a', { href: i.qr, download: `ingresso-${i.codigo_curto}.png` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // O número vem do servidor (ordem do item e posição da vaga no pedido):
  // fixo, não a posição nesta lista. Sem ele (resposta antiga), a posição.
  function cartaoDoIngresso(i, posicao) {
    const n = i.numero || posicao;
    const usado = Boolean(i.utilizado_em);
    const [cor, rotulo] = usado
      ? ['', `Utilizado em ${dataCurta(i.utilizado_em)}`]
      : INGRESSO[i.status] || ['', i.status];
    const ativo = i.status === 'valido' && i.qr;
    return el('article', { class: `cartao ingresso${ativo ? '' : ' inativo'}`, 'aria-label': `Ingresso ${n}` }, [
      el('div', { class: 'discreto', text: `Ingresso ${n}${i.numero_de ? ` de ${i.numero_de}` : ''}` }),
      el('h3', { text: i.participante }),
      el('div', { text: `${i.categoria}${i.promocao ? ` · promoção ${i.promocao}` : ''}` }),
      ativo
        ? el('img', {
            class: 'qr',
            src: i.qr,
            alt: `QR Code do ingresso de ${i.participante}`,
            width: 260,
            height: 260,
          })
        : el('div', {
            class: 'qr-vazio',
            text: i.status === 'valido' ? 'QR indisponível' : 'Este ingresso não vale para entrar.',
          }),
      el('div', {
        class: 'codigo',
        text: i.codigo_curto,
        'aria-label': `Código ${i.codigo_curto.split('').join(' ')}`,
      }),
      el('span', { class: `selo ${cor}`, text: rotulo }),
      i.beneficios?.length
        ? el(
            'ul',
            { class: 'chips' },
            i.beneficios.map((b) => el('li', { class: 'chip', text: b })),
          )
        : null,
      ativo
        ? el('button', { class: 'btn nao-imprimir', type: 'button', text: 'Baixar QR', onclick: () => baixarQr(i) })
        : null,
    ]);
  }

  function mostrar(d) {
    const blocos = [cabecalho(d), blocoDoPagamento(d), resumo(d)];
    if (d.ingressos.length) {
      blocos.push(
        el('section', { 'aria-labelledby': 'tituloIngressos' }, [
          el('h2', { id: 'tituloIngressos', text: d.ingressos.length === 1 ? 'Seu ingresso' : 'Seus ingressos' }),
          el('p', {
            class: 'discreto',
            text: 'Na entrada, mostre o QR Code de cada ingresso (pode ser na tela). Se o QR não ler, a portaria digita o código.',
          }),
          el(
            'div',
            { class: 'acoes' },
            el('button', { class: 'btn', type: 'button', text: 'Imprimir', onclick: () => window.print() }),
          ),
          el(
            'div',
            { class: 'ingressos' },
            d.ingressos.map((i, n) => cartaoDoIngresso(i, n + 1)),
          ),
        ]),
      );
    }
    main.replaceChildren(...blocos.filter(Boolean));
    if (d.pedido.status === 'pago') {
      try {
        localStorage.removeItem('trimundi:pedido-em-andamento');
      } catch {}
    }
  }

  carregar();
})();
