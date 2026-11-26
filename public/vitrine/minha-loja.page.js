// /anunciante/minha-loja — o painel da conta dona de uma loja do Marketplace:
// a situação do contrato com a Mostraí, os espaços da vitrine, os pedidos de
// orçamento e o perfil. Toda regra é do servidor (/conta/loja/*): a conta só
// alcança a própria loja, e o espaço bloqueado pela Mostraí não volta para a
// vitrine por aqui (o servidor e o banco recusam).
(() => {
  const V = window.VITRINE;
  const esc = (v) => window.esc(v ?? '');
  const $ = (id) => document.getElementById(id);
  const dia = (v) => (v ? window.dataBR(v) : '—');

  async function api(caminho, opts = {}) {
    let r;
    try {
      r = await fetch(`${API_BASE_URL}${caminho}`, {
        credentials: 'include',
        ...opts,
        headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      });
    } catch {
      throw new Error('sem conexão com o servidor — tente de novo');
    }
    if (r.status === 401) {
      window.sessaoExpirada();
      throw new Error('sessão encerrada');
    }
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(corpo.erro || 'não foi possível concluir');
      err.status = r.status;
      throw err;
    }
    return corpo;
  }

  let LOJA = null;

  // ------------------------------------------------------------ situação
  const SITUACOES = {
    na_vitrine: [
      'ok',
      'Sua loja está no Marketplace',
      'Os espaços publicados aparecem na vitrine e na página da loja.',
    ],
    rascunho: ['pendente', 'Loja em preparação', 'Monte o perfil e os espaços. A Mostraí ativa a loja e o contrato.'],
    suspensa: ['err', 'Loja suspensa pela Mostraí', ''],
    encerrada: ['err', 'Loja encerrada', 'O contrato terminou. Fale com a Mostraí para voltar.'],
    conta_indisponivel: ['err', 'Conta indisponível', 'A conta dona da loja está suspensa. Fale com a Mostraí.'],
    sem_assinatura: [
      'pendente',
      'Sem contrato ativo',
      'A loja não aparece na vitrine sem um plano de loja. Fale com a Mostraí.',
    ],
    aguardando_inicio: ['pendente', 'Contrato ainda não começou', ''],
    vencida: ['err', 'Contrato vencido', 'A loja saiu da vitrine. Fale com a Mostraí para renovar.'],
    inadimplente: ['err', 'Pagamento em atraso', 'A loja saiu da vitrine até o pagamento ser registrado pela Mostraí.'],
  };

  function desenharSituacao(l) {
    const [tipo, titulo, textoPadrao] = SITUACOES[l.situacao] || ['pendente', l.situacao, ''];
    const a = l.assinatura;
    let texto = textoPadrao;
    if (l.situacao === 'suspensa') texto = l.motivo_status ? `Motivo: ${l.motivo_status}` : 'Fale com a Mostraí.';
    if (l.situacao === 'aguardando_inicio' && a) texto = `A loja entra na vitrine em ${dia(a.inicio)}.`;
    const contrato = a
      ? `<dl class="loja-contrato">
          <div><dt>Plano</dt><dd>${esc(a.modalidade === 'anual' ? 'Anual' : 'Mensal')} · ${esc(a.prazo_meses)} ${Number(a.prazo_meses) === 1 ? 'mês' : 'meses'}</dd></div>
          <div><dt>Vigência</dt><dd>${dia(a.inicio)} a ${dia(a.fim)}</dd></div>
          <div><dt>Pago até</dt><dd>${a.pago_ate ? dia(a.pago_ate) : 'nenhum pagamento registrado'}</dd></div>
        </dl>`
      : '';
    $('situacaoLoja').innerHTML = `
      <div class="loja-situacao loja-situacao-${tipo}">
        <p class="section-eyebrow">${esc(l.nome)} · /loja/${esc(l.slug)}</p>
        <h1>${esc(titulo)}</h1>
        ${texto ? `<p>${esc(texto)}</p>` : ''}
        ${contrato}
      </div>`;
    const link = $('linkPublico');
    link.href = `/loja/${encodeURIComponent(l.slug)}`;
    link.hidden = l.situacao !== 'na_vitrine';
  }

  // ------------------------------------------------------------ espaços
  const STATUS = {
    publicado: ['badge-ok', 'Publicado'],
    rascunho: ['badge-neutro', 'Rascunho'],
    pausado: ['badge-pendente', 'Pausado'],
    arquivado: ['badge-neutro', 'Arquivado'],
  };

  function desenharEspacos(espacos) {
    const vivos = espacos.filter((e) => e.status !== 'arquivado' || e.bloqueado_admin_em);
    if (!vivos.length) {
      $('listaEspacos').innerHTML =
        '<p class="empty-state">Nenhum espaço ainda. Cadastre o primeiro: tela, painel, totem, outdoor ou empena.</p>';
      return;
    }
    $('listaEspacos').innerHTML = `<div class="pontos-grid vitrine-grid">${vivos
      .map((e) => {
        const [classe, rotulo] = STATUS[e.status] || ['badge-neutro', e.status];
        const bloqueado = Boolean(e.bloqueado_admin_em);
        const publicar =
          e.status === 'publicado'
            ? `<button type="button" class="btn ghost mini" data-acao="despublicar" data-id="${e.id}">Tirar da vitrine</button>`
            : `<button type="button" class="btn primary mini" data-acao="publicar" data-id="${e.id}"${bloqueado ? ' disabled title="Bloqueado pela Mostraí"' : ''}>Publicar</button>`;
        return `<article class="ponto-card espaco-card espaco-gestao">
          <div class="ponto-card-media">${V.foto(e.foto_url, e.nome)}</div>
          <div class="espaco-selos"><span class="badge ${classe}">${rotulo}</span>${
            bloqueado ? '<span class="badge badge-err">Bloqueado pela Mostraí</span>' : ''
          }</div>
          <h4>${esc(e.nome)}</h4>
          <p>${esc(V.TIPOS[e.tipo] || e.tipo)} · ${esc(V.onde(e))}</p>
          <p class="espaco-preco"><b>${esc(V.precoTexto(e))}</b></p>
          ${bloqueado ? `<p class="espaco-bloqueio">${esc(e.bloqueado_motivo)}. Só a Mostraí libera a volta para a vitrine.</p>` : ''}
          <div class="espaco-acoes">
            ${publicar}
            <button type="button" class="btn ghost mini" data-acao="editar" data-id="${e.id}">Editar</button>
            <button type="button" class="btn ghost mini" data-acao="foto" data-id="${e.id}">Foto</button>
            ${e.status !== 'arquivado' ? `<button type="button" class="btn perigo-sutil mini" data-acao="arquivar" data-id="${e.id}">Arquivar</button>` : ''}
          </div>
        </article>`;
      })
      .join('')}</div>
      <input type="file" id="arqFotoEspaco" accept="image/jpeg,image/png,image/webp" hidden>`;
  }

  // ------------------------------------------------------------ contatos
  function desenharContatos(contatos) {
    if (!contatos.length) {
      $('listaContatos').innerHTML =
        '<p class="empty-state">Nenhum pedido ainda. Eles chegam pelo formulário da página da loja.</p>';
      return;
    }
    $('listaContatos').innerHTML = `<ul class="lista-contatos">${contatos
      .map((c) => {
        const estado = c.respondido_em
          ? '<span class="badge badge-ok">Respondido</span>'
          : c.lido_em
            ? '<span class="badge badge-neutro">Lido</span>'
            : '<span class="badge badge-pendente">Novo</span>';
        const tel = (c.telefone || '').replace(/\D/g, '');
        return `<li class="contato-item${c.lido_em ? '' : ' contato-novo'}">
          <div class="contato-topo">${estado}<b>${esc(c.nome)}</b><span class="u-dim">${esc(window.dataBR(c.criado_em))}</span></div>
          ${c.espaco_nome ? `<p class="u-dim u-m-0">Espaço: ${esc(c.espaco_nome)}</p>` : ''}
          ${c.periodo_desejado ? `<p class="u-dim u-m-0">Período: ${esc(c.periodo_desejado)}</p>` : ''}
          <p class="contato-mensagem">${esc(c.mensagem)}</p>
          <p class="contato-canais"><a href="mailto:${esc(c.email)}">${esc(c.email)}</a>${
            tel
              ? ` · <a href="https://wa.me/55${esc(tel)}" target="_blank" rel="noopener">WhatsApp ${esc(V.telefoneBR(c.telefone))}</a>`
              : ''
          }</p>
          <div class="espaco-acoes">
            ${c.lido_em ? '' : `<button type="button" class="btn ghost mini" data-contato="lido" data-id="${c.id}">Marcar como lido</button>`}
            ${c.respondido_em ? '' : `<button type="button" class="btn ghost mini" data-contato="respondido" data-id="${c.id}">Marcar como respondido</button>`}
          </div>
        </li>`;
      })
      .join('')}</ul>
      <p class="u-dim u-fs-78">Pedidos com mais de 12 meses são apagados automaticamente (LGPD).</p>`;
  }

  // ------------------------------------------------------------ perfil
  function desenharPerfil(l) {
    const f = $('formPerfil');
    f.nome.value = l.nome || '';
    f.descricao.value = l.descricao || '';
    f.email.value = l.email || '';
    f.telefone.value = l.telefone || '';
    f.cidade.value = l.cidade || '';
    f.uf.value = l.uf || '';
    f.razao_social.value = l.razao_social || '';
    f.documento.value = l.documento || '';
    if (/^#[0-9a-fA-F]{6}$/.test(l.cor_primaria || '')) f.cor_primaria.value = l.cor_primaria;
    const livre = l.status === 'rascunho';
    f.razao_social.disabled = !livre;
    f.documento.disabled = !livre;
    $('avisoCadastro').textContent = livre
      ? 'Depois que a Mostraí ativar a loja, razão social e documento só mudam pela Mostraí.'
      : 'Conferidos pela Mostraí. Para mudar, fale com a gente.';
    $('logoAtual').innerHTML = l.logo_url
      ? `<img src="${esc(l.logo_url)}" alt="Logo atual">`
      : `<span>${esc((l.nome || '?').trim().charAt(0).toUpperCase())}</span>`;
    V.aplicarCor(l.cor_primaria);
  }

  async function carregar() {
    try {
      const [loja, contatos] = await Promise.all([api('/conta/loja'), api('/conta/loja/contatos')]);
      LOJA = loja;
      desenharSituacao(loja);
      desenharEspacos(loja.espacos || []);
      desenharContatos(contatos);
      desenharPerfil(loja);
    } catch (err) {
      if (err.status === 404) {
        $('situacaoLoja').innerHTML =
          `<div class="loja-situacao loja-situacao-pendente"><h1>Esta conta não tem loja</h1>
          <p>O Marketplace é para empresas com espaços de publicidade. Quer vender os seus? <a href="/contato.html">Fale com a Mostraí</a>.</p></div>`;
        for (const id of ['listaEspacos', 'listaContatos']) $(id).innerHTML = '';
        $('formPerfil').hidden = true;
        $('btnNovoEspaco').hidden = true;
        return;
      }
      $('situacaoLoja').innerHTML = `<p class="form-msg err">${esc(err.message)}</p>`;
    }
  }

  // ------------------------------------------------------------ diálogo do espaço
  const dlg = $('dlgEspaco');
  const formEspaco = $('formEspaco');
  let editando = null;
  $('eTipo').innerHTML = Object.entries(V.TIPOS)
    .map(([v, r]) => `<option value="${v}">${esc(r)}</option>`)
    .join('');

  function abrirEspaco(espaco = null) {
    editando = espaco;
    formEspaco.reset();
    $('tituloDlgEspaco').textContent = espaco ? 'Editar espaço' : 'Novo espaço';
    $('linhaSlug').hidden = Boolean(espaco);
    formEspaco.querySelector('[data-msg]').textContent = '';
    if (espaco) {
      for (const campo of [
        'nome',
        'tipo',
        'descricao',
        'endereco',
        'bairro',
        'cidade',
        'uf',
        'latitude',
        'longitude',
        'medidas',
        'fluxo_estimado_mensal',
        'preco',
        'periodo_preco',
      ]) {
        if (formEspaco[campo]) formEspaco[campo].value = espaco[campo] ?? '';
      }
    } else if (LOJA) {
      formEspaco.cidade.value = LOJA.cidade || '';
      formEspaco.uf.value = LOJA.uf || '';
    }
    dlg.showModal();
  }
  dlg.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', () => dlg.close()));

  const slugDe = (t) =>
    String(t || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  $('eNome').addEventListener('input', () => {
    if (!editando && !$('eSlug').dataset.mexido) $('eSlug').value = slugDe($('eNome').value);
  });
  $('eSlug').addEventListener('input', () => {
    $('eSlug').dataset.mexido = '1';
  });

  formEspaco.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = formEspaco.querySelector('[data-msg]');
    const dados = Object.fromEntries(new FormData(formEspaco));
    for (const k of Object.keys(dados)) if (dados[k] === '') dados[k] = null;
    if (dados.preco) dados.preco = String(dados.preco).replace(',', '.');
    if (dados.latitude) dados.latitude = String(dados.latitude).replace(',', '.');
    if (dados.longitude) dados.longitude = String(dados.longitude).replace(',', '.');
    msg.textContent = 'Salvando...';
    msg.className = 'form-msg';
    try {
      if (editando) {
        delete dados.slug;
        await api(`/conta/loja/espacos/${editando.id}`, { method: 'PATCH', body: JSON.stringify(dados) });
      } else {
        if (!dados.slug) dados.slug = slugDe(dados.nome);
        await api('/conta/loja/espacos', { method: 'POST', body: JSON.stringify(dados) });
      }
      dlg.close();
      await carregar();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'form-msg err';
    }
  });

  $('btnNovoEspaco').addEventListener('click', () => abrirEspaco());

  // Ações dos cards (delegadas: a lista é redesenhada a cada carga).
  let fotoDoEspaco = null;
  $('listaEspacos').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-acao]');
    if (!b || b.disabled) return;
    const espaco = (LOJA?.espacos || []).find((e) => String(e.id) === b.dataset.id);
    if (!espaco) return;
    const acao = b.dataset.acao;
    if (acao === 'editar') return abrirEspaco(espaco);
    if (acao === 'foto') {
      fotoDoEspaco = espaco.id;
      return $('arqFotoEspaco')?.click();
    }
    const status = { publicar: 'publicado', despublicar: 'pausado', arquivar: 'arquivado' }[acao];
    b.disabled = true;
    try {
      await api(`/conta/loja/espacos/${espaco.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await carregar();
    } catch (err) {
      b.disabled = false;
      alertar(err.message);
    }
  });
  $('listaEspacos').addEventListener('change', async (ev) => {
    if (ev.target.id !== 'arqFotoEspaco' || !ev.target.files[0] || !fotoDoEspaco) return;
    const corpo = new FormData();
    corpo.append('arquivo', ev.target.files[0]);
    try {
      await api(`/conta/loja/espacos/${fotoDoEspaco}/foto`, { method: 'POST', body: corpo });
      await carregar();
    } catch (err) {
      alertar(err.message);
    }
  });

  $('listaContatos').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-contato]');
    if (!b) return;
    b.disabled = true;
    try {
      await api(`/conta/loja/contatos/${b.dataset.id}/${b.dataset.contato}`, { method: 'POST' });
      desenharContatos(await api('/conta/loja/contatos'));
    } catch (err) {
      b.disabled = false;
      alertar(err.message);
    }
  });

  // Erro de ação: o mesmo lugar de mensagem do perfil, perto do topo.
  function alertar(texto) {
    const m = $('msgPerfil');
    m.textContent = texto;
    m.className = 'form-msg err';
    m.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ------------------------------------------------------------ perfil: salvar e logo
  $('formPerfil').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget;
    const msg = $('msgPerfil');
    const dados = {
      nome: f.nome.value,
      descricao: f.descricao.value,
      email: f.email.value || null,
      telefone: f.telefone.value || null,
      cidade: f.cidade.value || null,
      uf: f.uf.value || null,
      cor_primaria: f.cor_primaria.value,
    };
    if (!f.documento.disabled) {
      dados.razao_social = f.razao_social.value || null;
      dados.documento = f.documento.value || null;
    }
    msg.textContent = 'Salvando...';
    msg.className = 'form-msg';
    try {
      await api('/conta/loja', { method: 'PATCH', body: JSON.stringify(dados) });
      msg.textContent = 'Perfil salvo.';
      msg.className = 'form-msg ok';
      await carregar();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'form-msg err';
    }
  });
  document.addEventListener('click', (ev) => {
    const g = ev.target.closest('[data-escolher]');
    if (g) $(g.dataset.escolher)?.click();
  });
  $('arqLogo').addEventListener('change', async (ev) => {
    const arquivo = ev.target.files[0];
    if (!arquivo) return;
    const corpo = new FormData();
    corpo.append('arquivo', arquivo);
    const msg = $('msgPerfil');
    msg.textContent = 'Enviando o logo...';
    msg.className = 'form-msg';
    try {
      await api('/conta/loja/logo', { method: 'POST', body: corpo });
      msg.textContent = 'Logo atualizado.';
      msg.className = 'form-msg ok';
      await carregar();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'form-msg err';
    } finally {
      ev.target.value = '';
    }
  });

  // Conta primeiro (o cabeçalho, o perfil e a trava do e-mail são do layout).
  window
    .carregarConta()
    .then((conta) => {
      if (window.montarPerfil) window.montarPerfil(conta, () => {});
      return carregar();
    })
    // Falha transitória ao ler a conta não decide nada: a loja carrega igual
    // (o 401 de verdade a própria leitura da loja trata).
    .catch(() => carregar());
})();
