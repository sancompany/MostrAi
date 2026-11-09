// Trimundi — Admin → Eventos (ADR-048; docs/trimundi/funcional.md, T1 a T5).
//
// Um item só no menu, "Eventos", com as cinco abas: Criar evento (lista e
// ficha da edição), Criar ingressos (tipos e lotes), Criar promoção
// (combos), Participantes (ingressos emitidos, cortesias, pedidos,
// reembolsos e os números da edição) e Adicionar operador (check-in).
//
// Arquivo próprio, carregado ANTES de index.page.js (o mesmo arranjo de
// comunicados.js): o módulo `trimundi` de lá chama as funções daqui, e as
// peças de lá (pegar, api, abrirModal, toast...) são resolvidas na hora do
// uso. Toda regra é do servidor (/admin/trimundi/*): esta tela só mostra e
// envia. Texto que vem do banco passa por esc() antes de virar HTML.
(() => {
  const doAdmin =
    (nome) =>
    (...args) =>
      window[nome](...args);
  const pegar = doAdmin('pegar');
  const api = doAdmin('api');
  const abrirModal = doAdmin('abrirModal');
  const confirmarModal = doAdmin('confirmarModal');
  const toast = doAdmin('toast');
  const plural = doAdmin('plural');
  const vazio = doAdmin('vazio');
  const alternar = doAdmin('alternar');
  const erroNoModal = doAdmin('erroNoModal');
  const copiarTexto = doAdmin('copiarTexto');
  const irPara = doAdmin('irPara');
  const fmt = doAdmin('fmt');
  const num = doAdmin('num');
  const frase = (t) => (window.frase ? window.frase(t) : t);

  const R = '/admin/trimundi';
  const NAO_CONFIGURADA = 'A Trimundi não está configurada neste ambiente.';

  // ------------------------------------------------------------- utilidades
  const FUSO = 'America/Sao_Paulo';
  const FORMATO = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const quando = (iso) => (iso ? FORMATO.format(new Date(iso)).replace(', ', ' às ') : null);

  // <input type="datetime-local"> ↔ ISO, sempre no horário de Brasília
  // (UTC−3, sem horário de verão desde 2019), seja qual for o fuso do
  // computador de quem usa o Admin.
  function paraCampoData(iso) {
    if (!iso) return '';
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: FUSO,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(iso))
        .map((x) => [x.type, x.value]),
    );
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  const doCampoData = (valor) => (valor ? `${valor}:00-03:00` : null);

  const reais = (centavos) =>
    centavos === null || centavos === undefined ? '' : (Number(centavos) / 100).toFixed(2).replace('.', ',');
  // "50", "50,00", "1.234,56" ou "50.5" → centavos (inteiro). Inválido → NaN.
  function centavosDe(texto) {
    let t = String(texto ?? '')
      .trim()
      .replace(/^R\$\s*/i, '');
    if (!t) return Number.NaN;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
    return Math.round(Number(t) * 100);
  }

  function novaChave() {
    const b = window.crypto.getRandomValues(new Uint8Array(18));
    return btoa(String.fromCharCode(...b))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  // Escrita: devolve { ok, status, json } — o erro do servidor vira texto.
  async function escrever(caminho, metodo, corpo) {
    const r = await api(`${R}${caminho}`, {
      method: metodo,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const json = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json, erro: frase(json.erro || 'Não foi possível salvar agora.') };
  }

  // Envio de arquivo (multipart): o api() do Admin manda JSON, então aqui é
  // fetch direto, com o mesmo cookie de sessão.
  async function enviarArquivo(caminho, campos) {
    const form = new FormData();
    for (const [k, v] of Object.entries(campos)) form.append(k, v);
    try {
      const r = await fetch(`${API_BASE_URL}${R}${caminho}`, { method: 'POST', credentials: 'include', body: form });
      const json = await r.json().catch(() => ({}));
      return { ok: r.ok, json, erro: frase(json.erro || 'Não foi possível salvar a imagem agora — tente de novo.') };
    } catch {
      return { ok: false, json: {}, erro: 'Sem conexão com o servidor — tente de novo.' };
    }
  }

  // Botão travado enquanto a ação anda (duplo clique não manda duas vezes).
  async function travado(botao, fn) {
    if (!botao) return fn();
    botao.disabled = true;
    try {
      return await fn();
    } finally {
      botao.disabled = false;
    }
  }

  // Leitura com o estado "não configurada" (503) próprio da Trimundi.
  async function lerOuAvisar(el, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err?.status === 503) {
        el.innerHTML = vazio(
          NAO_CONFIGURADA,
          'Falta o banco próprio da Trimundi neste ambiente (docs/trimundi/README.md).',
        );
        return null;
      }
      throw err;
    }
  }

  const STATUS_EDICAO = {
    rascunho: ['badge-neutro', 'Rascunho'],
    publicado: ['badge-ok', 'Publicado'],
    pausado: ['badge-pendente', 'Pausado'],
    encerrado: ['badge-neutro', 'Encerrado'],
  };
  const selo = ([classe, texto]) => `<span class="badge ${classe}">${esc(texto)}</span>`;
  const nomeDaEdicao = (e) => `${e.evento?.nome || e.evento_nome} — ${e.nome}`;

  // Seletor de edição de T2, T3 e T4: não encerradas primeiro (a lista já
  // vem nessa ordem do servidor); sem edição no endereço, a mais recente.
  function escolherEdicao(edicoes, resto) {
    const id = Number(String(resto || '').split('/')[0]);
    return edicoes.find((e) => e.id === id) || edicoes.find((e) => e.status !== 'encerrado') || edicoes[0] || null;
  }
  function seletorEdicao(edicoes, atual, aba) {
    return `<div class="tm-seletor campo-grupo painel-form">
      <label for="tmEdicao">Edição</label>
      <select id="tmEdicao" data-aba="${aba}">
        ${edicoes.map((e) => `<option value="${e.id}" ${e.id === atual.id ? 'selected' : ''}>${esc(nomeDaEdicao(e))}${e.status === 'encerrado' ? ' (encerrada)' : ''}</option>`).join('')}
      </select>
    </div>`;
  }
  function ligarSeletor(el) {
    const s = el.querySelector('#tmEdicao');
    s?.addEventListener('change', () => irPara(`trimundi/${s.dataset.aba}/${s.value}`));
  }
  const semEdicao = () =>
    `${vazio('Crie um evento primeiro.')}<p><button type="button" class="btn primary" data-ir-eventos>Criar evento</button></p>`;
  function ligarSemEdicao(el) {
    el.querySelector('[data-ir-eventos]')?.addEventListener('click', () => irPara('trimundi/eventos/nova'));
  }

  // ===================================================== T1 — Criar evento
  async function renderEventos(el, resto) {
    if (resto === 'nova' || /^\d+$/.test(resto || '')) return renderFicha(el, resto === 'nova' ? null : Number(resto));
    const edicoes = await lerOuAvisar(el, () => pegar(`${R}/edicoes`));
    if (!edicoes) return;
    const abertas = edicoes.filter((e) => e.status !== 'encerrado');
    const encerradas = edicoes.filter((e) => e.status === 'encerrado');
    const linha = (e) => `<tr>
        <td><b>${esc(nomeDaEdicao(e))}</b></td>
        <td>${esc(quando(e.inicio_em) || 'A definir')}</td>
        <td>${esc(e.local_nome || 'A definir')}</td>
        <td>${selo(STATUS_EDICAO[e.status])}</td>
        <td><code>${esc(e.endereco_publico)}</code></td>
        <td class="u-ta-r"><button type="button" class="btn ghost mini" data-abrir="${e.id}">Abrir</button></td>
      </tr>`;
    const tabela = (lista) => `<div class="tabela-caixa"><div class="rolagem"><table>
        <thead><tr><th>Evento — edição</th><th>Data</th><th>Local</th><th>Status</th><th>Endereço público</th><th></th></tr></thead>
        <tbody>${lista.map(linha).join('')}</tbody></table></div></div>`;
    el.innerHTML = `
      <div class="barra-pagina">
        <p class="barra-pagina-texto">${edicoes.length ? plural(edicoes.length, 'edição', 'edições') : ''}</p>
        <button type="button" class="btn primary" id="tmCriarEvento">+ Criar evento</button>
      </div>
      ${edicoes.length ? '' : vazio('Nenhum evento ainda.', 'Cada evento tem edições; cada edição tem o próprio endereço de venda em /ticket/.')}
      ${abertas.length ? tabela(abertas) : ''}
      ${
        encerradas.length
          ? `<details class="tm-encerradas"><summary>Mostrar encerradas (${encerradas.length})</summary>${tabela(encerradas)}</details>`
          : ''
      }`;
    el.querySelector('#tmCriarEvento').addEventListener('click', () => irPara('trimundi/eventos/nova'));
    el.querySelectorAll('[data-abrir]').forEach((b) =>
      b.addEventListener('click', () => irPara(`trimundi/eventos/${b.dataset.abrir}`)),
    );
  }

  const CLASSIFICACOES = [
    ['', 'Escolha'],
    ['livre', 'Livre'],
    ['10', '10 anos'],
    ['12', '12 anos'],
    ['14', '14 anos'],
    ['16', '16 anos'],
    ['18', '18 anos'],
  ];
  const TEXTOS = [
    ['regras_entrada', 'Regulamento e condições de entrada', 'regulamento'],
    ['condicoes_especiais', 'Condições especiais (opcional)', 'condições especiais'],
    ['termos_compra', 'Termos e condições de compra', 'termos de compra'],
  ];

  async function renderFicha(el, id) {
    const leituras = await lerOuAvisar(el, () =>
      Promise.all([id ? pegar(`${R}/edicoes/${id}`) : null, pegar(`${R}/eventos`), pegar(`${R}/estado`)]),
    );
    if (!leituras) return;
    const [ed, eventos, estado] = leituras;
    const nova = !ed;
    const so_leitura = ed?.status === 'encerrado';
    const v = (x) => esc(x ?? '');
    const local = ed?.local || null;
    const opcoesEvento = eventos
      .map((e) => `<option value="${e.id}">${esc(e.nome)} (/ticket/${esc(e.slug)})</option>`)
      .join('');
    const botoesStatus = !ed
      ? ''
      : {
          rascunho: '<button type="button" class="btn primary" data-status="publicado">Publicar</button>',
          publicado: '<button type="button" class="btn ghost" data-status="pausado">Pausar</button>',
          pausado: '<button type="button" class="btn primary" data-status="publicado">Retomar venda</button>',
          encerrado: '',
        }[ed.status] +
        (ed.status !== 'encerrado'
          ? '<button type="button" class="btn perigo-sutil" data-status="encerrado">Encerrar</button>'
          : '');

    el.innerHTML = `
      ${window.migalha([{ rotulo: 'Eventos', href: '#trimundi/eventos' }, { rotulo: ed ? nomeDaEdicao(ed) : 'Novo evento' }])}
      ${ed ? `<p class="tm-status">${selo(STATUS_EDICAO[ed.status])} <span class="u-dim">Endereço público:</span> <code>${v(ed.endereco_publico)}</code>${ed.status !== 'rascunho' ? ` · <a href="${v(ed.endereco_publico)}" target="_blank" rel="noopener">abrir a página</a>` : ''}</p>` : ''}
      ${so_leitura ? '<p class="form-msg">Edição encerrada fica só para consulta.</p>' : ''}
      <form id="tmFicha" class="tm-ficha painel-form" novalidate>
        <fieldset ${so_leitura ? 'disabled' : ''}>
          <section class="secao-pagina">
            <div class="secao-topo"><h3>Evento</h3></div>
            ${
              nova
                ? `<div class="segmentado" role="radiogroup">
                    <label><input type="radio" name="modoEvento" value="novo" checked><span>Evento novo</span></label>
                    <label><input type="radio" name="modoEvento" value="existente" ${eventos.length ? '' : 'disabled'}><span>Evento já cadastrado</span></label>
                  </div>`
                : ''
            }
            <div class="campos" data-evento-novo>
              <div class="campo-grupo"><label for="tmEvNome">Nome do evento</label><input id="tmEvNome" name="evNome" maxlength="120" value="${v(ed?.evento.nome)}"></div>
              <div class="campo-grupo"><label for="tmEvSlug">Endereço do evento</label>
                <div class="tm-prefixo"><span>/ticket/</span><input id="tmEvSlug" name="evSlug" maxlength="60" value="${v(ed?.evento.slug)}" ${ed?.evento.endereco_travado ? 'readonly' : ''} autocomplete="off"></div>
                <p class="campo-ajuda">${ed?.evento.endereco_travado ? 'O endereço não muda depois de publicado.' : 'Letras, números e hífen.'}</p></div>
            </div>
            ${nova ? `<div class="campos" data-evento-existente hidden><div class="campo-grupo"><label for="tmEvId">Evento</label><select id="tmEvId" name="evId">${opcoesEvento}</select></div></div>` : ''}
          </section>
          <section class="secao-pagina">
            <div class="secao-topo"><h3>Edição</h3></div>
            <div class="campos">
              <div class="campo-grupo"><label for="tmNome">Edição</label><input id="tmNome" name="nome" maxlength="120" value="${v(ed?.nome)}" placeholder="ex.: EDITION01"></div>
              <div class="campo-grupo"><label for="tmSlug">Endereço da edição</label>
                <div class="tm-prefixo"><span>/ticket/…/</span><input id="tmSlug" name="slug" maxlength="40" value="${v(ed?.slug)}" ${ed?.endereco_travado ? 'readonly' : ''} autocomplete="off"></div></div>
            </div>
            <div class="campo-grupo"><label for="tmDescricao">Descrição</label><textarea id="tmDescricao" name="descricao" rows="4" maxlength="5000">${v(ed?.descricao)}</textarea></div>
            <div class="campos">
              <div class="campo-grupo"><label for="tmInicio">Data e horário</label><input id="tmInicio" name="inicio" type="datetime-local" value="${paraCampoData(ed?.inicio_em)}">
                <div class="tm-alternar">${alternar({ nome: 'semData', marcado: ed ? !ed.inicio_em : false, texto: 'A definir' })}</div></div>
              <div class="campo-grupo"><label for="tmFim">Término (opcional)</label><input id="tmFim" name="fim" type="datetime-local" value="${paraCampoData(ed?.fim_em)}"></div>
              <div class="campo-grupo"><label for="tmClass">Classificação etária</label><select id="tmClass" name="classificacao">${CLASSIFICACOES.map(([k, r]) => `<option value="${k}" ${String(ed?.classificacao_etaria ?? '') === k ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
              <div class="campo-grupo"><label for="tmCap">Capacidade do local (opcional)</label><input id="tmCap" name="capacidade" type="number" min="1" max="1000000" value="${v(ed?.capacidade)}"></div>
            </div>
          </section>
          <section class="secao-pagina">
            <div class="secao-topo"><h3>Local</h3></div>
            ${alternar({ nome: 'semLocal', marcado: ed ? !local : false, texto: 'A definir' })}
            <div class="campos" data-local>
              <div class="campo-grupo"><label for="tmLocNome">Local</label><input id="tmLocNome" name="locNome" maxlength="120" value="${v(local?.nome)}"></div>
              <div class="campo-grupo"><label for="tmCep">CEP</label><input id="tmCep" name="cep" inputmode="numeric" maxlength="9" value="${v(local?.cep)}"></div>
              <div class="campo-grupo"><label for="tmLog">Endereço</label><input id="tmLog" name="logradouro" maxlength="160" value="${v(local?.logradouro)}"></div>
              <div class="campo-grupo"><label for="tmNum">Número</label><input id="tmNum" name="numero" maxlength="20" value="${v(local?.numero)}"></div>
              <div class="campo-grupo"><label for="tmComp">Complemento</label><input id="tmComp" name="complemento" maxlength="80" value="${v(local?.complemento)}"></div>
              <div class="campo-grupo"><label for="tmBairro">Bairro</label><input id="tmBairro" name="bairro" maxlength="80" value="${v(local?.bairro)}"></div>
              <div class="campo-grupo"><label for="tmCidade">Cidade</label><input id="tmCidade" name="cidade" maxlength="80" value="${v(local?.cidade)}"></div>
              <div class="campo-grupo"><label for="tmUf">UF</label><input id="tmUf" name="uf" maxlength="2" value="${v(local?.uf)}"></div>
            </div>
          </section>
          <section class="secao-pagina">
            <div class="secao-topo"><h3>Textos que o comprador aceita</h3></div>
            ${TEXTOS.map(
              ([k, rotulo]) => `<div class="campo-grupo">
                <label for="tm_${k}">${rotulo}${ed?.textos?.[k] ? ` <span class="u-dim">· versão ${ed.textos[k].versao}</span>` : ''}</label>
                <textarea id="tm_${k}" name="${k}" rows="6" maxlength="50000">${v(ed?.textos?.[k]?.texto)}</textarea>
              </div>`,
            ).join('')}
            <p class="campo-ajuda">Mudar um texto grava uma versão nova; quem já comprou fica com a versão que aceitou.</p>
          </section>
        </fieldset>
        <p class="form-msg" data-msg role="status"></p>
        <div class="tm-acoes">
          ${so_leitura ? '' : '<button type="submit" class="btn primary">Salvar</button>'}
          ${botoesStatus}
          <button type="button" class="btn ghost" data-voltar>Voltar</button>
        </div>
      </form>
      ${ed ? blocoImagens(ed, estado, so_leitura) : ''}`;

    const form = el.querySelector('#tmFicha');
    const msg = form.querySelector('[data-msg]');
    const avisar = (texto, erro = false) => {
      msg.textContent = texto;
      msg.className = erro ? 'form-msg err' : 'form-msg ok';
    };
    form.querySelector('[data-voltar]').addEventListener('click', () => irPara('trimundi/eventos'));
    const sincronizar = () => {
      form.elements.inicio.disabled = form.elements.semData.checked;
      form.querySelector('[data-local]').hidden = form.elements.semLocal.checked;
      if (nova) {
        const existente = form.querySelector('[name="modoEvento"]:checked').value === 'existente';
        form.querySelector('[data-evento-novo]').hidden = existente;
        form.querySelector('[data-evento-existente]').hidden = !existente;
      }
    };
    form.addEventListener('change', sincronizar);
    sincronizar();

    function corpoDaFicha() {
      const f = form.elements;
      const edicao = {
        nome: f.nome.value,
        slug: f.slug.value,
        descricao: f.descricao.value,
        inicio_em: f.semData.checked ? null : doCampoData(f.inicio.value),
        fim_em: doCampoData(f.fim.value),
        classificacao_etaria: f.classificacao.value || null,
        capacidade: f.capacidade.value === '' ? null : f.capacidade.value,
        local: f.semLocal.checked
          ? null
          : {
              nome: f.locNome.value,
              cep: f.cep.value,
              logradouro: f.logradouro.value,
              numero: f.numero.value,
              complemento: f.complemento.value,
              bairro: f.bairro.value,
              cidade: f.cidade.value,
              uf: f.uf.value,
            },
        textos: Object.fromEntries(TEXTOS.map(([k]) => [k, f[k].value])),
      };
      if (!nova) {
        // Texto que não mudou não vai (não cria versão nova).
        for (const [k] of TEXTOS) if ((ed.textos?.[k]?.texto || '') === edicao.textos[k]) delete edicao.textos[k];
      }
      return edicao;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const botao = form.querySelector('[type="submit"]');
      await travado(botao, async () => {
        const f = form.elements;
        const edicao = corpoDaFicha();
        let r;
        if (nova) {
          const existente = form.querySelector('[name="modoEvento"]:checked').value === 'existente';
          r = await escrever('/edicoes', 'POST', {
            evento: existente ? { id: f.evId.value } : { nome: f.evNome.value, slug: f.evSlug.value },
            edicao,
          });
          if (!r.ok) return avisar(r.erro, true);
          toast('Edição salva.');
          return irPara(`trimundi/eventos/${r.json.id}`);
        }
        const evento = {};
        if (f.evNome.value !== ed.evento.nome) evento.nome = f.evNome.value;
        if (!ed.evento.endereco_travado && f.evSlug.value !== ed.evento.slug) evento.slug = f.evSlug.value;
        if (ed.endereco_travado) delete edicao.slug;
        r = await escrever(`/edicoes/${ed.id}`, 'PATCH', {
          ...edicao,
          ...(Object.keys(evento).length ? { evento } : {}),
        });
        if (!r.ok) return avisar(r.erro, true);
        const versoes = r.json.versoes_novas || [];
        const rotulo = Object.fromEntries(TEXTOS.map(([k, , curto]) => [k, curto]));
        toast(
          versoes.length
            ? versoes.map((x) => `Versão ${x.versao} do ${rotulo[x.tipo]} salva.`).join(' ')
            : 'Edição salva.',
        );
        return renderFicha(el, ed.id);
      });
    });

    const TEXTO_STATUS = {
      publicado: ed?.status === 'pausado' ? 'Venda retomada.' : 'Edição publicada.',
      pausado: 'Venda pausada.',
      encerrado: 'Edição encerrada.',
    };
    form.querySelectorAll('[data-status]').forEach((b) =>
      b.addEventListener('click', async () => {
        const status = b.dataset.status;
        if (status === 'encerrado') {
          const ok = await confirmarModal({
            titulo: 'Encerrar a edição',
            texto: `<p>Encerrar <b>${esc(nomeDaEdicao(ed))}</b>? Depois disso nada mais é vendido nem emitido, e a edição fica só para consulta.</p>`,
            botao: 'Encerrar',
            perigo: true,
          });
          if (!ok) return;
        }
        await travado(b, async () => {
          const r = await escrever(`/edicoes/${ed.id}/status`, 'POST', { status });
          if (!r.ok) return avisar(r.erro, true);
          toast(TEXTO_STATUS[status]);
          renderFicha(el, ed.id);
        });
      }),
    );
    if (ed) ligarImagens(el, ed);
  }

  function blocoImagens(ed, estado, soLeitura) {
    const banner = ed.imagens.find((i) => i.tipo === 'banner');
    const galeria = ed.imagens.filter((i) => i.tipo === 'galeria');
    const semArmazenamento = !estado.imagens;
    const desligado = soLeitura || semArmazenamento ? 'disabled' : '';
    return `<section class="secao-pagina tm-imagens">
      <div class="secao-topo"><h3>Imagens</h3></div>
      ${semArmazenamento ? '<p class="form-msg err">As imagens não estão configuradas neste ambiente.</p>' : ''}
      <p class="campo-rotulo">Banner</p>
      <div class="tm-banner">${banner ? `<img src="${esc(banner.url)}" alt="Banner da edição">` : '<div class="tm-banner-vazio">Sem banner</div>'}</div>
      <div class="tm-acoes">
        <input type="file" id="tmArqBanner" accept="image/jpeg,image/png,image/webp" hidden>
        <button type="button" class="btn ghost mini" data-escolher-arquivo="tmArqBanner" ${desligado}>Enviar banner</button>
        ${banner && !soLeitura ? `<button type="button" class="btn perigo-sutil mini" data-remover-imagem="${banner.id}">Remover</button>` : ''}
      </div>
      <p class="campo-rotulo">Imagens (até 8)</p>
      <div class="tm-galeria">${galeria
        .map(
          (i) =>
            `<figure><img src="${esc(i.url)}" alt="">${soLeitura ? '' : `<button type="button" class="btn perigo-sutil mini" data-remover-imagem="${i.id}">Remover</button>`}</figure>`,
        )
        .join('')}</div>
      <input type="file" id="tmArqGaleria" accept="image/jpeg,image/png,image/webp" hidden>
      <button type="button" class="btn ghost mini" data-escolher-arquivo="tmArqGaleria" ${desligado || (galeria.length >= 8 ? 'disabled' : '')}>Enviar imagem</button>
      <p class="campo-ajuda">JPEG, PNG ou WebP de até 8 MB.</p>
    </section>`;
  }

  function ligarImagens(el, ed) {
    const enviar = async (input, tipo) => {
      const arquivo = input.files[0];
      if (!arquivo) return;
      const r = await enviarArquivo(`/edicoes/${ed.id}/imagens`, { tipo, arquivo });
      input.value = '';
      if (!r.ok) return toast(r.erro, 'err');
      toast(tipo === 'banner' ? 'Banner enviado.' : 'Imagem enviada.');
      renderFicha(el, ed.id);
    };
    el.querySelector('#tmArqBanner')?.addEventListener('change', (e) => enviar(e.target, 'banner'));
    el.querySelector('#tmArqGaleria')?.addEventListener('change', (e) => enviar(e.target, 'galeria'));
    el.querySelectorAll('[data-remover-imagem]').forEach((b) =>
      b.addEventListener('click', async () => {
        await travado(b, async () => {
          const r = await escrever(`/imagens/${b.dataset.removerImagem}`, 'DELETE');
          if (!r.ok) return toast(r.erro, 'err');
          toast('Imagem removida.');
          renderFicha(el, ed.id);
        });
      }),
    );
  }

  // ================================================= T2 — Criar ingressos
  const SITUACAO_LOTE = {
    agendado: ['badge-info', 'Agendado'],
    a_venda: ['badge-ok', 'À venda'],
    aguardando_anterior: ['badge-neutro', 'Aguardando o lote anterior'],
    esgotado: ['badge-err', 'Esgotado'],
    encerrado: ['badge-neutro', 'Encerrado'],
  };

  async function renderIngressos(el, resto) {
    const edicoes = await lerOuAvisar(el, () => pegar(`${R}/edicoes`));
    if (!edicoes) return;
    const ed = escolherEdicao(edicoes, resto);
    if (!ed) {
      el.innerHTML = semEdicao();
      return ligarSemEdicao(el);
    }
    const [tipos, beneficios] = await Promise.all([
      pegar(`${R}/edicoes/${ed.id}/tipos`),
      pegar(`${R}/edicoes/${ed.id}/beneficios`),
    ]);
    const soLeitura = ed.status === 'encerrado';
    const periodo = (l) =>
      l.inicio_vendas || l.fim_vendas
        ? `${quando(l.inicio_vendas) || 'já'} → ${quando(l.fim_vendas) || 'sem fim'}`
        : '—';
    const cartao = (t) => `<section class="secao-pagina tm-tipo">
        <div class="secao-topo">
          <h3>${esc(t.nome)} ${t.ativo ? '' : '<span class="badge badge-neutro">Inativo</span>'}</h3>
          <div class="secao-acoes">${soLeitura ? '' : `<button type="button" class="btn ghost mini" data-editar-tipo="${t.id}">Editar</button>`}</div>
        </div>
        ${t.descricao ? `<p class="u-dim">${esc(t.descricao)}</p>` : ''}
        <p class="u-dim">${t.limite_por_comprador ? `Até ${t.limite_por_comprador} por comprador. ` : ''}${t.beneficios.length ? `Benefícios: ${t.beneficios.map((b) => esc(b.nome)).join(', ')}.` : ''}
          Disponível agora: <b>${num(t.disponivel_agora)}</b>.</p>
        <div class="tabela-caixa"><div class="rolagem"><table>
          <thead><tr><th>Lote</th><th class="num">Preço</th><th class="num">Quantidade</th><th class="num">Vendidos</th><th class="num">Reservados</th><th class="num">Disponíveis</th><th>Período</th><th>Situação</th><th></th></tr></thead>
          <tbody>${t.lotes
            .map(
              (l) => `<tr>
              <td>${l.numero}º lote</td>
              <td class="num">${fmt(l.preco_centavos / 100)}</td>
              <td class="num">${num(l.quantidade)}</td>
              <td class="num">${num(l.pagos)}</td>
              <td class="num">${num(l.reservados)}</td>
              <td class="num">${num(l.disponivel)}</td>
              <td>${esc(periodo(l))}</td>
              <td>${selo(SITUACAO_LOTE[l.situacao] || ['badge-neutro', l.situacao])}${l.reaberto ? ' <span class="u-dim">(vaga devolvida)</span>' : ''}</td>
              <td class="u-ta-r">${!soLeitura && !l.encerrado_em ? `<button type="button" class="btn perigo-sutil mini" data-encerrar-lote="${l.id}" data-numero="${l.numero}">Encerrar lote</button>` : ''}</td>
            </tr>`,
            )
            .join('')}</tbody></table></div></div>
      </section>`;
    el.innerHTML = `
      <div class="barra-pagina">${seletorEdicao(edicoes, ed, 'ingressos')}
        ${soLeitura ? '' : '<button type="button" class="btn primary" id="tmNovoTipo">+ Criar ingresso</button>'}</div>
      ${soLeitura ? '<p class="form-msg">Edição encerrada fica só para consulta.</p>' : ''}
      <p class="u-dim tm-beneficios">Benefícios desta edição: ${beneficios.length ? beneficios.map((b) => `<span class="badge badge-neutro">${esc(b.nome)}</span>`).join(' ') : 'nenhum ainda.'}
        ${soLeitura ? '' : '<button type="button" class="btn ghost mini" id="tmNovoBeneficio">+ Novo benefício</button>'}</p>
      ${tipos.length ? tipos.map(cartao).join('') : vazio('Nenhum ingresso nesta edição ainda.', 'Cada ingresso tem de 1 a 10 lotes, com preço e quantidade.')}`;
    ligarSeletor(el);
    const recarregar = () => renderIngressos(el, String(ed.id));
    el.querySelector('#tmNovoTipo')?.addEventListener('click', () => modalTipo(ed, null, beneficios, recarregar));
    el.querySelector('#tmNovoBeneficio')?.addEventListener('click', () => modalBeneficio(ed, recarregar));
    el.querySelectorAll('[data-editar-tipo]').forEach((b) =>
      b.addEventListener('click', () =>
        modalTipo(
          ed,
          tipos.find((t) => t.id === Number(b.dataset.editarTipo)),
          beneficios,
          recarregar,
        ),
      ),
    );
    el.querySelectorAll('[data-encerrar-lote]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ok = await confirmarModal({
          titulo: 'Encerrar lote',
          texto: `<p>Encerrar o ${b.dataset.numero}º lote? O próximo lote assume a venda na hora.</p>`,
          botao: 'Encerrar lote',
          perigo: true,
        });
        if (!ok) return;
        const r = await escrever(`/lotes/${b.dataset.encerrarLote}/encerrar`, 'POST');
        if (!r.ok) return toast(r.erro, 'err');
        toast(`${b.dataset.numero}º lote encerrado.`);
        recarregar();
      }),
    );
  }

  function modalBeneficio(ed, depois) {
    const { dlg, fechar } = abrirModal({
      titulo: 'Novo benefício',
      corpo: `<form id="tmFormBeneficio" novalidate>
          <div class="campo-grupo"><label for="tmBenNome">Nome</label><input id="tmBenNome" name="nome" maxlength="60" required></div>
          <div class="campo-grupo"><label for="tmBenDesc">Descrição (opcional)</label><input id="tmBenDesc" name="descricao" maxlength="300"></div>
          <p class="form-msg" data-msg></p></form>`,
      rodape:
        '<button type="button" class="btn ghost" data-fechar>Cancelar</button><button type="submit" form="tmFormBeneficio" class="btn primary">Salvar benefício</button>',
    });
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await travado(dlg.querySelector('[type="submit"]'), async () => {
        const f = e.target.elements;
        const r = await escrever(`/edicoes/${ed.id}/beneficios`, 'POST', {
          nome: f.nome.value,
          descricao: f.descricao.value,
        });
        if (!r.ok) return erroNoModal(dlg, r.erro);
        fechar();
        toast('Benefício salvo.');
        depois(r.json);
      });
    });
  }

  function linhaLote(l = {}, travar = false) {
    const t = travar ? 'disabled' : '';
    return `<div class="tm-lote" ${l.id ? `data-id="${l.id}"` : ''}>
      <div class="campo-grupo"><label>Preço (R$)</label><input name="preco" inputmode="decimal" value="${reais(l.preco_centavos)}" ${t}></div>
      <div class="campo-grupo"><label>Quantidade</label><input name="quantidade" type="number" min="1" max="100000" value="${l.quantidade ?? ''}" ${t}></div>
      <div class="campo-grupo"><label>Início das vendas</label><input name="inicio" type="datetime-local" value="${paraCampoData(l.inicio_vendas)}" ${t}></div>
      <div class="campo-grupo"><label>Fim das vendas</label><input name="fim" type="datetime-local" value="${paraCampoData(l.fim_vendas)}" ${t}></div>
      ${travar ? '<span class="u-dim tm-lote-nota">encerrado</span>' : '<button type="button" class="btn perigo-sutil mini" data-tirar-lote aria-label="Tirar este lote">×</button>'}
    </div>`;
  }

  function modalTipo(ed, tipo, beneficios, depois) {
    const marcados = new Set((tipo?.beneficios || []).map((b) => b.id));
    const listaBeneficios = (lista) =>
      lista.length
        ? lista
            .map(
              (b) =>
                `<label class="tm-marcar"><input type="checkbox" name="beneficio" value="${b.id}" ${marcados.has(b.id) ? 'checked' : ''}> ${esc(b.nome)}</label>`,
            )
            .join('')
        : '<span class="u-dim">Nenhum benefício nesta edição.</span>';
    const { dlg, fechar } = abrirModal({
      titulo: tipo ? 'Editar ingresso' : 'Novo ingresso',
      largo: true,
      corpo: `<form id="tmFormTipo" novalidate>
          <div class="campos">
            <div class="campo-grupo"><label for="tmTipoNome">Nome do ingresso</label><input id="tmTipoNome" name="nome" maxlength="60" value="${esc(tipo?.nome ?? '')}" required></div>
            <div class="campo-grupo"><label for="tmTipoLimite">Limite por comprador (opcional)</label><input id="tmTipoLimite" name="limite" type="number" min="1" max="20" value="${tipo?.limite_por_comprador ?? ''}"></div>
          </div>
          <div class="campo-grupo"><label for="tmTipoDesc">Descrição</label><textarea id="tmTipoDesc" name="descricao" rows="2" maxlength="500">${esc(tipo?.descricao ?? '')}</textarea></div>
          ${alternar({ nome: 'ativo', marcado: tipo ? tipo.ativo : true, texto: 'Ativo' })}
          <p class="campo-rotulo">Benefícios</p>
          <div class="tm-lista-marcar" data-beneficios>${listaBeneficios(beneficios)}</div>
          <button type="button" class="btn ghost mini" data-novo-beneficio>+ Novo benefício</button>
          <p class="campo-rotulo">Lotes</p>
          <div data-lotes>${(tipo?.lotes?.length ? tipo.lotes : [{}]).map((l) => linhaLote(l, Boolean(l.encerrado_em))).join('')}</div>
          <button type="button" class="btn ghost mini" data-mais-lote>+ Adicionar lote</button>
          <p class="campo-ajuda">De 1 a 10 lotes. O próximo lote abre sozinho quando o anterior esgota ou encerra; a sobra do encerrado passa para ele.</p>
          <p class="form-msg" data-msg></p>
        </form>`,
      rodape:
        '<button type="button" class="btn ghost" data-fechar>Cancelar</button><button type="submit" form="tmFormTipo" class="btn primary">Salvar ingresso</button>',
    });
    const lotes = dlg.querySelector('[data-lotes]');
    dlg.querySelector('[data-mais-lote]').addEventListener('click', () => {
      if (lotes.children.length >= 10) return erroNoModal(dlg, 'Cada ingresso tem de 1 a 10 lotes.');
      lotes.insertAdjacentHTML('beforeend', linhaLote());
    });
    lotes.addEventListener('click', (e) => {
      if (e.target.closest('[data-tirar-lote]') && lotes.children.length > 1) e.target.closest('.tm-lote').remove();
    });
    dlg.querySelector('[data-novo-beneficio]').addEventListener('click', () =>
      modalBeneficio(ed, async () => {
        for (const c of dlg.querySelectorAll('[name="beneficio"]:checked')) marcados.add(Number(c.value));
        const lista = await pegar(`${R}/edicoes/${ed.id}/beneficios`);
        dlg.querySelector('[data-beneficios]').innerHTML = listaBeneficios(lista);
      }),
    );
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const lista = [];
      for (const linha of lotes.querySelectorAll('.tm-lote')) {
        const preco = centavosDe(linha.querySelector('[name="preco"]').value);
        if (!Number.isFinite(preco)) return erroNoModal(dlg, 'Preço inválido — use o formato 50,00.');
        lista.push({
          ...(linha.dataset.id ? { id: Number(linha.dataset.id) } : {}),
          preco_centavos: preco,
          quantidade: linha.querySelector('[name="quantidade"]').value,
          inicio_vendas: doCampoData(linha.querySelector('[name="inicio"]').value),
          fim_vendas: doCampoData(linha.querySelector('[name="fim"]').value),
        });
      }
      const corpo = {
        nome: f.nome.value,
        descricao: f.descricao.value,
        limite_por_comprador: f.limite.value === '' ? null : f.limite.value,
        ativo: f.ativo.checked,
        beneficios: [...dlg.querySelectorAll('[name="beneficio"]:checked')].map((c) => Number(c.value)),
        lotes: lista,
      };
      await travado(dlg.querySelector('[type="submit"]'), async () => {
        const r = tipo
          ? await escrever(`/tipos/${tipo.id}`, 'PATCH', corpo)
          : await escrever(`/edicoes/${ed.id}/tipos`, 'POST', corpo);
        if (!r.ok) return erroNoModal(dlg, r.erro);
        fechar();
        toast('Ingresso salvo.');
        depois();
      });
    });
  }

  // ================================================= T3 — Criar promoção
  const SITUACAO_PROMO = {
    a_venda: ['badge-ok', 'Ativa'],
    inativa: ['badge-neutro', 'Inativa'],
    esgotada: ['badge-err', 'Esgotada'],
    em_breve: ['badge-info', 'Em breve'],
    fora_da_validade: ['badge-neutro', 'Fora da validade'],
  };

  async function renderPromocoes(el, resto) {
    const edicoes = await lerOuAvisar(el, () => pegar(`${R}/edicoes`));
    if (!edicoes) return;
    const ed = escolherEdicao(edicoes, resto);
    if (!ed) {
      el.innerHTML = semEdicao();
      return ligarSemEdicao(el);
    }
    const [promos, tipos, beneficios] = await Promise.all([
      pegar(`${R}/edicoes/${ed.id}/promocoes`),
      pegar(`${R}/edicoes/${ed.id}/tipos`),
      pegar(`${R}/edicoes/${ed.id}/beneficios`),
    ]);
    const soLeitura = ed.status === 'encerrado';
    const validade = (p) => (p.inicio || p.fim ? `${quando(p.inicio) || 'já'} → ${quando(p.fim) || 'sem fim'}` : '—');
    el.innerHTML = `
      <div class="barra-pagina">${seletorEdicao(edicoes, ed, 'promocoes')}
        ${soLeitura ? '' : `<button type="button" class="btn primary" id="tmNovaPromo" ${tipos.length ? '' : 'disabled title="Crie um ingresso antes da promoção."'}>+ Criar promoção</button>`}</div>
      ${!tipos.length && !soLeitura ? '<p class="u-dim">Crie um ingresso antes da promoção.</p>' : ''}
      ${
        promos.length
          ? `<div class="tabela-caixa"><div class="rolagem"><table>
          <thead><tr><th>Promoção</th><th>Ingressos</th><th class="num">Preço</th><th class="num">Vendidos</th><th class="num">Disponíveis</th><th>Validade</th><th>Situação</th><th></th></tr></thead>
          <tbody>${promos
            .map(
              (p) => `<tr>
              <td><b>${esc(p.nome)}</b></td>
              <td>${p.itens.map((i) => `${i.quantidade}× ${esc(i.categoria_nome)}${i.beneficio_nome ? ` <span class="u-dim">(+ ${esc(i.beneficio_nome)})</span>` : ''}`).join('<br>')}</td>
              <td class="num">${fmt(p.preco_total_centavos / 100)}</td>
              <td class="num">${num(p.vendidos)}</td>
              <td class="num">${num(p.disponiveis)}</td>
              <td>${esc(validade(p))}</td>
              <td>${selo(SITUACAO_PROMO[p.situacao] || ['badge-neutro', p.situacao])}</td>
              <td class="u-ta-r">${soLeitura ? '' : `<button type="button" class="btn ghost mini" data-editar-promo="${p.id}">Editar</button>`}</td></tr>`,
            )
            .join('')}</tbody></table></div></div>`
          : vazio(
              'Nenhuma promoção nesta edição ainda.',
              'Um combo junta ingressos por um preço só; cada posição vira um ingresso próprio.',
            )
      }`;
    ligarSeletor(el);
    const recarregar = () => renderPromocoes(el, String(ed.id));
    el.querySelector('#tmNovaPromo')?.addEventListener('click', () =>
      modalPromocao(ed, null, tipos, beneficios, recarregar),
    );
    el.querySelectorAll('[data-editar-promo]').forEach((b) =>
      b.addEventListener('click', () =>
        modalPromocao(
          ed,
          promos.find((p) => p.id === Number(b.dataset.editarPromo)),
          tipos,
          beneficios,
          recarregar,
        ),
      ),
    );
  }

  function linhaItem(tipos, beneficios, it = {}) {
    return `<div class="tm-item">
      <div class="campo-grupo"><label>Ingresso</label><select name="categoria">${tipos.map((t) => `<option value="${t.id}" ${Number(it.categoria_id) === t.id ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></div>
      <div class="campo-grupo"><label>Quantidade</label><input name="quantidade" type="number" min="1" max="20" value="${it.quantidade ?? 1}"></div>
      <div class="campo-grupo"><label>Benefício promocional (opcional)</label><select name="beneficio"><option value="">Nenhum</option>${beneficios.map((b) => `<option value="${b.id}" ${Number(it.beneficio_id) === b.id ? 'selected' : ''}>${esc(b.nome)}</option>`).join('')}</select></div>
      <button type="button" class="btn perigo-sutil mini" data-tirar-item aria-label="Tirar este ingresso">×</button>
    </div>`;
  }

  function modalPromocao(ed, promo, tipos, beneficios, depois) {
    const { dlg, fechar } = abrirModal({
      titulo: promo ? 'Editar promoção' : 'Nova promoção',
      largo: true,
      corpo: `<form id="tmFormPromo" novalidate>
          <div class="campos">
            <div class="campo-grupo"><label for="tmPromoNome">Nome da promoção</label><input id="tmPromoNome" name="nome" maxlength="60" value="${esc(promo?.nome ?? '')}" required></div>
            <div class="campo-grupo"><label for="tmPromoPreco">Preço total do combo (R$)</label><input id="tmPromoPreco" name="preco" inputmode="decimal" value="${reais(promo?.preco_total_centavos)}"></div>
            <div class="campo-grupo"><label for="tmPromoQtd">Quantidade de combos</label><input id="tmPromoQtd" name="combos" type="number" min="1" max="10000" value="${promo?.quantidade ?? ''}"></div>
          </div>
          <div class="campo-grupo"><label for="tmPromoDesc">Descrição</label><textarea id="tmPromoDesc" name="descricao" rows="2" maxlength="500">${esc(promo?.descricao ?? '')}</textarea></div>
          <p class="campo-rotulo">Ingressos incluídos</p>
          <div data-itens>${(promo?.itens?.length ? promo.itens : [{}, {}]).map((i) => linhaItem(tipos, beneficios, i)).join('')}</div>
          <button type="button" class="btn ghost mini" data-mais-item>+ Incluir ingresso</button>
          <p class="campo-ajuda">De 2 a 20 ingressos por combo. O combo usa o estoque dos ingressos que o compõem e cada posição vira um ingresso próprio.</p>
          <div class="campos">
            <div class="campo-grupo"><label for="tmPromoIni">Válida de (opcional)</label><input id="tmPromoIni" name="inicio" type="datetime-local" value="${paraCampoData(promo?.inicio)}"></div>
            <div class="campo-grupo"><label for="tmPromoFim">até (opcional)</label><input id="tmPromoFim" name="fim" type="datetime-local" value="${paraCampoData(promo?.fim)}"></div>
          </div>
          ${alternar({ nome: 'ativo', marcado: promo ? promo.ativo : true, texto: 'Ativa' })}
          <p class="form-msg" data-msg></p>
        </form>`,
      rodape:
        '<button type="button" class="btn ghost" data-fechar>Cancelar</button><button type="submit" form="tmFormPromo" class="btn primary">Salvar promoção</button>',
    });
    const itens = dlg.querySelector('[data-itens]');
    dlg
      .querySelector('[data-mais-item]')
      .addEventListener('click', () => itens.insertAdjacentHTML('beforeend', linhaItem(tipos, beneficios)));
    itens.addEventListener('click', (e) => {
      if (e.target.closest('[data-tirar-item]') && itens.children.length > 1) e.target.closest('.tm-item').remove();
    });
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const preco = centavosDe(f.preco.value);
      if (!Number.isFinite(preco)) return erroNoModal(dlg, 'Preço inválido — use o formato 90,00.');
      const corpo = {
        nome: f.nome.value,
        descricao: f.descricao.value,
        preco_total_centavos: preco,
        quantidade: f.combos.value,
        inicio: doCampoData(f.inicio.value),
        fim: doCampoData(f.fim.value),
        ativo: f.ativo.checked,
        itens: [...itens.querySelectorAll('.tm-item')].map((linha) => ({
          categoria_id: Number(linha.querySelector('[name="categoria"]').value),
          quantidade: linha.querySelector('[name="quantidade"]').value,
          beneficio_id: linha.querySelector('[name="beneficio"]').value || null,
        })),
      };
      await travado(dlg.querySelector('[type="submit"]'), async () => {
        const r = promo
          ? await escrever(`/promocoes/${promo.id}`, 'PATCH', corpo)
          : await escrever(`/edicoes/${ed.id}/promocoes`, 'POST', corpo);
        if (!r.ok) return erroNoModal(dlg, r.erro);
        fechar();
        toast('Promoção salva.');
        depois();
      });
    });
  }

  // =================================================== T4 — Participantes
  const FILTROS = [
    ['todos', 'Todos'],
    ['pagos', 'Pagos'],
    ['cortesias', 'Cortesias'],
    ['testes', 'Testes'],
    ['cancelados', 'Cancelados'],
    ['utilizados', 'Utilizados'],
  ];
  const PAGAMENTO = {
    confirmado: 'Confirmado',
    cortesia: 'Cortesia (gratuita)',
    teste: 'Teste',
    reembolsado: 'Reembolsado',
  };
  const CLASSIF_CORTESIA = [
    ['convidado', 'Convidado'],
    ['equipe', 'Equipe'],
    ['patrocinador', 'Patrocinador'],
    ['promocional', 'Promocional'],
  ];
  const estadoT4 = { filtro: 'todos', busca: '', pagina: 1 };

  function situacaoDoIngresso(i) {
    if (i.status === 'cancelado') return selo(['badge-err', 'Cancelado']);
    if (i.status === 'bloqueado')
      return `${selo(['badge-pendente', 'Bloqueado'])}${i.motivo_status ? `<br><span class="u-dim">${esc(i.motivo_status)}</span>` : ''}`;
    if (i.checkin)
      return `${selo(['badge-info', 'Utilizado'])}<br><span class="u-dim">${esc(quando(i.checkin.em))}${i.checkin.operador ? ` · ${esc(i.checkin.operador)}` : ''}</span>`;
    return selo(['badge-ok', 'Válido']);
  }

  async function renderParticipantes(el, resto) {
    const edicoes = await lerOuAvisar(el, () => pegar(`${R}/edicoes`));
    if (!edicoes) return;
    const ed = escolherEdicao(edicoes, resto);
    if (!ed) {
      el.innerHTML = semEdicao();
      return ligarSemEdicao(el);
    }
    const q = new URLSearchParams({ filtro: estadoT4.filtro, busca: estadoT4.busca, pagina: String(estadoT4.pagina) });
    const [lista, resumo, avisos, tipos, beneficios, estado] = await Promise.all([
      pegar(`${R}/edicoes/${ed.id}/participantes?${q}`),
      pegar(`${R}/edicoes/${ed.id}/resumo`),
      pegar(`${R}/edicoes/${ed.id}/avisos`),
      pegar(`${R}/edicoes/${ed.id}/tipos`),
      pegar(`${R}/edicoes/${ed.id}/beneficios`),
      pegar(`${R}/estado`),
    ]);
    const soLeitura = ed.status === 'encerrado';
    const indicador = (valor, rotulo) => `<div class="mini-indicador"><b>${valor}</b><span>${rotulo}</span></div>`;
    const paginas = Math.max(1, Math.ceil(lista.total / lista.por_pagina));
    el.innerHTML = `
      <div class="barra-pagina">${seletorEdicao(edicoes, ed, 'participantes')}
        <div class="tm-acoes">
          <button type="button" class="btn ghost" id="tmTitular">Pedido do titular (LGPD)</button>
          ${estado.pedido_teste && !soLeitura ? `<button type="button" class="btn ghost" id="tmPedidoTeste" ${tipos.length ? '' : 'disabled'}>Pedido de teste</button>` : ''}
          ${soLeitura ? '' : `<button type="button" class="btn primary" id="tmCortesia" ${tipos.length ? '' : 'disabled title="Crie um ingresso antes da cortesia."'}>+ Emitir cortesia</button>`}
        </div></div>
      <div class="mini-indicadores">
        ${indicador(num(resumo.ingressos_pagos), 'ingressos pagos')}
        ${indicador(num(resumo.cortesias), 'cortesias')}
        ${indicador(num(resumo.participantes), 'participantes')}
        ${indicador(num(resumo.entradas), 'entradas')}
        ${indicador(fmt(resumo.receita_confirmada_centavos / 100), 'receita confirmada')}
        ${indicador(fmt(resumo.reembolsado_centavos / 100), `reembolsado (${num(resumo.reembolsos)})`)}
        ${indicador(fmt(resumo.receita_liquida_centavos / 100), 'receita líquida')}
        ${indicador(num(resumo.cancelados), 'cancelados')}
        ${indicador(num(resumo.chargebacks), 'chargebacks')}
      </div>
      <p class="campo-ajuda">Pedido de teste fica fora de todos os números; cortesia nunca é receita.</p>
      ${
        avisos.length
          ? `<section class="secao-pagina tm-avisos"><div class="secao-topo"><h3>Precisa de você</h3><span class="contagem">${avisos.length}</span></div>
          <ul>${avisos.map((a, n) => `<li><b>${esc(a.texto || a.tipo)}</b> Pedido ${esc(a.pedido_codigo || '—')}${a.desde ? ` · ${esc(quando(a.desde))}` : ''} ${a.pedido_id ? `<button type="button" class="btn ghost mini" data-pedido="${esc(a.pedido_id)}">Abrir pedido</button>` : ''} ${soLeitura ? '' : `<button type="button" class="btn ghost mini" data-resolver="${n}">Marcar como resolvido</button>`}</li>`).join('')}</ul></section>`
          : ''
      }
      <div class="tabela-caixa">
        <div class="tabela-topo">
          <form id="tmBusca" class="tm-busca"><input class="busca" type="search" name="busca" value="${esc(estadoT4.busca)}" placeholder="Buscar por nome, CPF, e-mail ou pedido" aria-label="Buscar"></form>
          <div class="chips">${FILTROS.map(([k, r]) => `<button type="button" class="chip ${estadoT4.filtro === k ? 'active' : ''}" data-filtro="${k}">${r}</button>`).join('')}</div>
        </div>
        <div class="rolagem">${
          lista.itens.length
            ? `<table><thead><tr><th>Participante</th><th>CPF</th><th>E-mail</th><th>Ingresso</th><th>Pedido</th><th>Pagamento</th><th>Benefícios</th><th>Situação</th><th></th></tr></thead>
              <tbody>${lista.itens
                .map(
                  (i) => `<tr>
                  <td><b>${esc(i.nome)}</b><br><span class="u-dim">${esc(i.codigo_curto)}</span></td>
                  <td>${esc(i.cpf || '—')}</td>
                  <td>${esc(i.email)}</td>
                  <td>${esc(i.categoria)}${i.promocao ? `<br><span class="u-dim">combo ${esc(i.promocao)}</span>` : ''}</td>
                  <td>${i.pedido ? `<button type="button" class="btn-linha" data-pedido="${esc(i.pedido.id)}">${esc(i.pedido.codigo)}</button>` : 'Cortesia'}</td>
                  <td>${esc(PAGAMENTO[i.pagamento] || i.pagamento)}${i.classificacao ? `<br><span class="u-dim">${esc(i.classificacao)}</span>` : ''}</td>
                  <td>${i.beneficios.length ? i.beneficios.map(esc).join(', ') : '—'}</td>
                  <td>${situacaoDoIngresso(i)}</td>
                  <td class="u-ta-r">
                    ${i.status !== 'cancelado' ? `<button type="button" class="btn ghost mini" data-qr="${i.id}" data-codigo="${esc(i.codigo_curto)}">Ver QR</button>` : ''}
                    ${i.origem === 'cortesia' && i.status !== 'cancelado' && !soLeitura ? `<button type="button" class="btn perigo-sutil mini" data-cancelar="${i.id}" data-nome="${esc(i.nome)}">Cancelar cortesia</button>` : ''}
                  </td></tr>`,
                )
                .join('')}</tbody></table>`
            : vazio(
                estadoT4.busca
                  ? `Nada encontrado para “${esc(estadoT4.busca)}”.`
                  : 'Nenhum ingresso emitido nesta edição ainda.',
              )
        }</div>
        <div class="tabela-pe"><span>${plural(lista.total, 'ingresso')}</span>
          ${
            paginas > 1
              ? `<span class="tm-paginas"><button type="button" class="btn ghost mini" data-pagina="${lista.pagina - 1}" ${lista.pagina <= 1 ? 'disabled' : ''}>Anterior</button>
            ${lista.pagina} de ${paginas}
            <button type="button" class="btn ghost mini" data-pagina="${lista.pagina + 1}" ${lista.pagina >= paginas ? 'disabled' : ''}>Próxima</button></span>`
              : ''
          }</div>
      </div>`;
    ligarSeletor(el);
    const recarregar = () => renderParticipantes(el, String(ed.id));
    el.querySelector('#tmBusca').addEventListener('submit', (e) => {
      e.preventDefault();
      estadoT4.busca = e.target.elements.busca.value.trim();
      estadoT4.pagina = 1;
      recarregar();
    });
    el.querySelectorAll('[data-filtro]').forEach((b) =>
      b.addEventListener('click', () => {
        estadoT4.filtro = b.dataset.filtro;
        estadoT4.pagina = 1;
        recarregar();
      }),
    );
    el.querySelectorAll('[data-pagina]').forEach((b) =>
      b.addEventListener('click', () => {
        estadoT4.pagina = Number(b.dataset.pagina);
        recarregar();
      }),
    );
    el.querySelectorAll('[data-qr]').forEach((b) =>
      b.addEventListener('click', () => modalQr(b.dataset.qr, b.dataset.codigo)),
    );
    el.querySelectorAll('[data-pedido]').forEach((b) =>
      b.addEventListener('click', () => modalPedido(b.dataset.pedido, recarregar)),
    );
    el.querySelectorAll('[data-cancelar]').forEach((b) =>
      b.addEventListener('click', () => modalCancelarCortesia(b.dataset.cancelar, b.dataset.nome, recarregar)),
    );
    el.querySelector('#tmCortesia')?.addEventListener('click', () => modalCortesia(ed, tipos, beneficios, recarregar));
    el.querySelector('#tmPedidoTeste')?.addEventListener('click', () => modalPedidoTeste(ed, tipos, recarregar));
    el.querySelector('#tmTitular').addEventListener('click', () => modalTitular(recarregar));
    el.querySelectorAll('[data-resolver]').forEach((b) =>
      b.addEventListener('click', () => modalResolverAviso(ed, avisos[Number(b.dataset.resolver)], recarregar)),
    );
  }

  function modalResolverAviso(ed, aviso, depois) {
    const { dlg, fechar } = abrirModal({
      titulo: 'Marcar aviso como resolvido',
      corpo: `<form id="tmFormResolver" novalidate><p>${esc(aviso.texto || aviso.tipo)} · Pedido ${esc(aviso.pedido_codigo || '—')}</p>
        <p class="campo-ajuda">Só some o aviso: nada muda no pedido. Se o mesmo problema voltar a acontecer, ele aparece de novo.</p>
        <div class="campo-grupo"><label for="tmResolverMotivo">O que foi feito</label><input id="tmResolverMotivo" name="motivo" maxlength="300" required></div>
        <p class="form-msg" data-msg></p></form>`,
      rodape:
        '<button type="button" class="btn ghost" data-fechar>Voltar</button><button type="submit" form="tmFormResolver" class="btn primary">Marcar como resolvido</button>',
    });
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await travado(dlg.querySelector('[type="submit"]'), async () => {
        const r = await escrever(`/edicoes/${ed.id}/avisos/resolver`, 'POST', {
          chave: aviso.chave,
          motivo: e.target.elements.motivo.value,
        });
        if (!r.ok) return erroNoModal(dlg, r.erro);
        fechar();
        toast('Aviso resolvido.');
        depois();
      });
    });
  }

  // Pedido do titular (LGPD): consulta por CPF (exportação em JSON) e
  // anonimização do que não tem guarda legal. O CPF vai só no corpo.
  function modalTitular(depois) {
    let ultimo = null;
    const { dlg } = abrirModal({
      titulo: 'Pedido do titular (LGPD)',
      largo: true,
      corpo: `<form id="tmFormTitular" novalidate>
          <p class="campo-ajuda">Vale para todas as edições. Quem comprou e pagou fica guardado pelo prazo legal; o resto sai na hora.</p>
          <div class="campos"><div class="campo-grupo"><label for="tmTitularCpf">CPF do titular</label><input id="tmTitularCpf" name="cpf" inputmode="numeric" maxlength="14" required></div></div>
          <div class="tm-acoes"><button type="submit" class="btn ghost">Consultar</button></div>
          <div data-resultado></div>
          <p class="form-msg" data-msg></p></form>`,
      rodape: '<button type="button" class="btn ghost" data-fechar>Fechar</button>',
    });
    const caixa = dlg.querySelector('[data-resultado]');
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const cpf = e.target.elements.cpf.value;
      await travado(e.submitter, async () => {
        const r = await escrever('/titular/consultar', 'POST', { cpf });
        if (!r.ok) return erroNoModal(dlg, r.erro);
        ultimo = r.json;
        const n = r.json.compradores.length + r.json.participantes.length;
        caixa.innerHTML = n
          ? `<p>${plural(r.json.compradores.length, 'cadastro de comprador', 'cadastros de comprador')} e ${plural(r.json.participantes.length, 'ingresso em nome dele', 'ingressos em nome dele')}.</p>
            <div class="tm-acoes"><button type="button" class="btn ghost" data-baixar>Baixar os dados (JSON)</button></div>
            <div class="campo-grupo"><label for="tmTitularMotivo">Motivo da anonimização</label><input id="tmTitularMotivo" maxlength="300" value="Pedido do titular"></div>
            <div class="tm-acoes"><button type="button" class="btn perigo" data-anonimizar>Anonimizar</button></div>`
          : '<p>Nada guardado com esse CPF.</p>';
        caixa.querySelector('[data-baixar]')?.addEventListener('click', () => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(ultimo, null, 2)], { type: 'application/json' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = 'dados-do-titular.json';
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
        caixa.querySelector('[data-anonimizar]')?.addEventListener('click', async (ev) => {
          const ok = await confirmarModal({
            titulo: 'Anonimizar',
            texto:
              '<p>Apagar nome, CPF e e-mail desta pessoa de tudo que não tem guarda legal? Não dá para desfazer. Os ingressos continuam valendo pelo QR.</p>',
            botao: 'Anonimizar',
            perigo: true,
          });
          if (!ok) return;
          await travado(ev.currentTarget, async () => {
            const a = await escrever('/titular/anonimizar', 'POST', {
              cpf,
              motivo: caixa.querySelector('#tmTitularMotivo').value,
            });
            if (!a.ok) return erroNoModal(dlg, a.erro);
            caixa.innerHTML = `<p class="form-msg ok">Feito: ${plural(a.json.participantes, 'ingresso anonimizado', 'ingressos anonimizados')}, ${plural(a.json.compradores, 'cadastro de comprador anonimizado', 'cadastros de comprador anonimizados')}${a.json.compradores_retidos ? `; ${plural(a.json.compradores_retidos, 'cadastro guardado', 'cadastros guardados')} pelo prazo legal (pagamento)` : ''}.</p>`;
            depois();
          });
        });
      });
    });
  }

  function modalQr(id, codigo) {
    const url = `${API_BASE_URL}${R}/ingressos/${encodeURIComponent(id)}/qr`;
    abrirModal({
      titulo: `Ingresso ${codigo}`,
      corpo: `<div class="tm-qr"><img src="${esc(url)}" alt="QR Code do ingresso ${esc(codigo)}" width="320" height="320"></div>
        <p class="campo-ajuda">O QR não leva nome, CPF nem e-mail. O código ${esc(codigo)} serve para digitar na portaria.</p>`,
      rodape: `<a class="btn ghost" href="${esc(url)}" download="ingresso-${esc(codigo)}.png">Baixar QR (PNG)</a><button type="button" class="btn primary" data-fechar>Fechar</button>`,
    });
  }

  function modalCortesia(ed, tipos, beneficios, depois) {
    const chave = novaChave();
    const { dlg, fechar } = abrirModal({
      titulo: 'Emitir cortesia',
      corpo: `<form id="tmFormCortesia" novalidate>
          <div class="campos">
            <div class="campo-grupo"><label for="tmCortNome">Nome do participante</label><input id="tmCortNome" name="nome" maxlength="120" required></div>
            <div class="campo-grupo"><label for="tmCortCpf">CPF</label><input id="tmCortCpf" name="cpf" inputmode="numeric" maxlength="14" required></div>
            <div class="campo-grupo"><label for="tmCortEmail">E-mail</label><input id="tmCortEmail" name="email" type="email" maxlength="200" required></div>
            <div class="campo-grupo"><label for="tmCortTipo">Ingresso</label><select id="tmCortTipo" name="tipo">${tipos.map((t) => `<option value="${t.id}">${esc(t.nome)}</option>`).join('')}</select></div>
            <div class="campo-grupo"><label for="tmCortBen">Benefício (opcional)</label><select id="tmCortBen" name="beneficio"><option value="">Nenhum</option>${beneficios.map((b) => `<option value="${b.id}">${esc(b.nome)}</option>`).join('')}</select></div>
            <div class="campo-grupo"><label for="tmCortClass">Classificação</label><select id="tmCortClass" name="classificacao">${CLASSIF_CORTESIA.map(([k, r]) => `<option value="${k}">${r}</option>`).join('')}</select></div>
          </div>
          <p class="campo-ajuda">Cortesia é gratuita: conta na capacidade da edição e nunca entra na receita.</p>
          <p class="form-msg" data-msg></p>
        </form>`,
      rodape:
        '<button type="button" class="btn ghost" data-fechar>Cancelar</button><button type="submit" form="tmFormCortesia" class="btn primary">Emitir cortesia</button>',
    });
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      await travado(dlg.querySelector('[type="submit"]'), async () => {
        const r = await escrever(`/edicoes/${ed.id}/cortesias`, 'POST', {
          nome: f.nome.value,
          cpf: f.cpf.value,
          email: f.email.value,
          categoria_id: Number(f.tipo.value),
          beneficio_id: f.beneficio.value ? Number(f.beneficio.value) : null,
          classificacao: f.classificacao.value,
          chave,
        });
        if (!r.ok) return erroNoModal(dlg, r.erro);
        fechar();
        toast(`Cortesia emitida para ${f.nome.value.trim()}.`);
        depois();
      });
    });
  }

  function modalCancelarCortesia(id, nome, depois) {
    const { dlg, fechar } = abrirModal({
      titulo: 'Cancelar cortesia',
      corpo: `<form id="tmFormCancelar" novalidate><p>Cancelar a cortesia de <b>${esc(nome)}</b>? O QR deixa de valer.</p>
        <div class="campo-grupo"><label for="tmMotivo">Motivo</label><input id="tmMotivo" name="motivo" maxlength="200" required></div>
        <p class="form-msg" data-msg></p></form>`,
      rodape:
        '<button type="button" class="btn ghost" data-fechar>Voltar</button><button type="submit" form="tmFormCancelar" class="btn perigo">Cancelar cortesia</button>',
    });
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await travado(dlg.querySelector('[type="submit"]'), async () => {
        const r = await escrever(`/ingressos/${id}/cancelar`, 'POST', { motivo: e.target.elements.motivo.value });
        if (!r.ok) return erroNoModal(dlg, r.erro);
        fechar();
        toast('Cortesia cancelada.');
        depois();
      });
    });
  }

  const STATUS_PEDIDO = {
    aguardando_pagamento: ['badge-pendente', 'Aguardando pagamento'],
    pago: ['badge-ok', 'Pago'],
    cancelado: ['badge-neutro', 'Cancelado'],
    expirado: ['badge-neutro', 'Expirado'],
    estornado: ['badge-err', 'Reembolsado'],
    pago_sem_vaga: ['badge-err', 'Pago sem vaga — devolver'],
  };
  const STATUS_REEMBOLSO = {
    solicitado: ['badge-pendente', 'Aguardando o Checkout'],
    confirmado: ['badge-ok', 'Confirmado'],
    negado: ['badge-err', 'Negado pelo provedor'],
    falhou: ['badge-err', 'Recusado pelo Checkout'],
  };

  async function modalPedido(pedidoId, depois) {
    let p;
    try {
      p = await pegar(`${R}/pedidos/${encodeURIComponent(pedidoId)}`);
    } catch (err) {
      return toast(frase(err.message), 'err');
    }
    const podeReembolsar = ['pago', 'pago_sem_vaga'].includes(p.status);
    const { dlg, fechar } = abrirModal({
      titulo: `Pedido ${p.codigo}`,
      largo: true,
      corpo: `<p>${selo(STATUS_PEDIDO[p.status] || ['badge-neutro', p.status])} ${p.origem === 'teste' ? selo(['badge-info', 'Teste']) : ''}
          <span class="u-dim">· criado ${esc(quando(p.criado_em))}${p.pago_em ? ` · pago ${esc(quando(p.pago_em))}` : ''}${p.metodo_pagamento ? ` · ${esc(p.metodo_pagamento)}` : ''}</span></p>
        <p>Comprador: <b>${esc(p.comprador)}</b> · ${esc(p.email)}</p>
        <div class="tabela-caixa"><div class="rolagem"><table><tbody>
          ${p.itens.map((i) => `<tr><td>${esc(i.descricao)}</td><td class="num">${i.quantidade}×</td><td class="num">${fmt(i.total_centavos / 100)}</td></tr>`).join('')}
          <tr><td><b>Total</b></td><td></td><td class="num"><b>${fmt(p.total_centavos / 100)}</b></td></tr>
        </tbody></table></div></div>
        ${
          p.ingressos.length
            ? `<p class="campo-rotulo">Ingressos</p><ul class="tm-lista">${p.ingressos
                .map(
                  (
                    i,
                  ) => `<li>${esc(i.nome)} · ${esc(i.categoria)} · <code>${esc(i.codigo_curto)}</code> · ${esc(i.status)}
                ${podeReembolsar && i.status !== 'cancelado' && p.status === 'pago' ? `<button type="button" class="btn ghost mini" data-reembolsar-ingresso="${i.id}" data-valor="${i.valor_centavos}">Reembolsar este ingresso</button>` : ''}</li>`,
                )
                .join('')}</ul>`
            : ''
        }
        ${
          p.reembolsos.length
            ? `<p class="campo-rotulo">Reembolsos</p><ul class="tm-lista">${p.reembolsos
                .map(
                  (
                    r,
                  ) => `<li>${fmt(r.valor_centavos / 100)} · ${selo(STATUS_REEMBOLSO[r.status] || ['badge-neutro', r.status])} · ${esc(r.motivo)}
                ${r.ultimo_erro ? `<br><span class="u-dim">${esc(r.ultimo_erro)}</span>` : ''}
                ${r.status === 'solicitado' && r.ultimo_erro ? `<button type="button" class="btn ghost mini" data-reenviar="${r.id}">Reenviar ao Checkout</button>` : ''}</li>`,
                )
                .join('')}</ul>`
            : ''
        }
        <div data-link></div>
        <p class="form-msg" data-msg></p>`,
      rodape: `<button type="button" class="btn ghost" data-gerar-link>Gerar link do pedido</button>
        ${podeReembolsar ? '<button type="button" class="btn perigo-sutil" data-reembolsar-pedido>Reembolsar pedido</button>' : ''}
        <button type="button" class="btn primary" data-fechar>Fechar</button>`,
    });
    const reabrir = () => {
      fechar();
      depois?.();
      modalPedido(pedidoId, depois);
    };
    dlg.querySelector('[data-gerar-link]').addEventListener('click', async (e) => {
      await travado(e.currentTarget, async () => {
        const r = await escrever(`/pedidos/${encodeURIComponent(pedidoId)}/link`, 'POST', {});
        if (!r.ok) return erroNoModal(dlg, r.erro);
        dlg.querySelector('[data-link]').innerHTML =
          `<div class="campo-grupo"><label>Link novo do pedido (entregue só a quem comprou)</label>
          <div class="tm-acoes"><input readonly value="${esc(r.json.url)}"><button type="button" class="btn ghost mini" data-copiar>Copiar</button></div></div>`;
        dlg.querySelector('[data-copiar]').addEventListener('click', () =>
          copiarTexto(r.json.url).then(
            () => toast('Link copiado.'),
            () => toast('Copie o link à mão.', 'err'),
          ),
        );
      });
    });
    const pedirReembolso = async (ingressoId, valor) => {
      const { dlg: d2, fechar: f2 } = abrirModal({
        titulo: ingressoId ? 'Reembolsar ingresso' : 'Reembolsar pedido',
        corpo: `<form id="tmFormReembolso" novalidate>
            <p>${ingressoId ? `Devolver ${fmt(valor / 100)} deste ingresso.` : 'Devolver o que falta do pedido.'} O pedido vai ao San Checkout; o ingresso fica bloqueado até a confirmação.</p>
            <div class="campo-grupo"><label for="tmMotivoReemb">Motivo</label><input id="tmMotivoReemb" name="motivo" maxlength="300" required></div>
            <p class="form-msg" data-msg></p></form>`,
        rodape:
          '<button type="button" class="btn ghost" data-fechar>Voltar</button><button type="submit" form="tmFormReembolso" class="btn perigo">Reembolsar</button>',
      });
      d2.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await travado(d2.querySelector('[type="submit"]'), async () => {
          const r = await escrever(`/pedidos/${encodeURIComponent(pedidoId)}/reembolsos`, 'POST', {
            motivo: e.target.elements.motivo.value,
            ...(ingressoId ? { ingresso_id: Number(ingressoId) } : {}),
          });
          if (!r.ok) return erroNoModal(d2, r.erro);
          f2();
          toast(
            r.json.status === 'confirmado'
              ? 'Reembolso confirmado.'
              : r.json.reenviar
                ? 'O Checkout não respondeu agora — reenvie pelo pedido.'
                : 'Reembolso pedido ao Checkout.',
          );
          reabrir();
        });
      });
    };
    dlg.querySelector('[data-reembolsar-pedido]')?.addEventListener('click', () => pedirReembolso(null));
    dlg
      .querySelectorAll('[data-reembolsar-ingresso]')
      .forEach((b) =>
        b.addEventListener('click', () => pedirReembolso(b.dataset.reembolsarIngresso, Number(b.dataset.valor))),
      );
    dlg.querySelectorAll('[data-reenviar]').forEach((b) =>
      b.addEventListener('click', async () => {
        await travado(b, async () => {
          const r = await escrever(`/reembolsos/${b.dataset.reenviar}/reenviar`, 'POST', {});
          if (!r.ok) return erroNoModal(dlg, r.erro);
          toast(r.json.reenviar ? 'O Checkout ainda não respondeu.' : 'Reembolso reenviado.');
          reabrir();
        });
      }),
    );
  }

  function modalPedidoTeste(ed, tipos, depois) {
    const chave = novaChave();
    const { dlg } = abrirModal({
      titulo: 'Pedido de teste',
      corpo: `<form id="tmFormTeste" novalidate>
          <p class="campo-ajuda">Passa pelo fluxo de verdade (estoque, reserva, pagamento, emissão) e fica fora de todos os números. Vale também em rascunho.</p>
          <div class="campos">
            <div class="campo-grupo"><label for="tmTesteTipo">Ingresso</label><select id="tmTesteTipo" name="tipo">${tipos.map((t) => `<option value="${t.id}">${esc(t.nome)}</option>`).join('')}</select></div>
            <div class="campo-grupo"><label for="tmTesteQtd">Quantidade</label><input id="tmTesteQtd" name="quantidade" type="number" min="1" max="4" value="1"></div>
            <div class="campo-grupo"><label for="tmTesteNome">Nome</label><input id="tmTesteNome" name="nome" maxlength="120" value="Equipe de teste"></div>
            <div class="campo-grupo"><label for="tmTesteCpf">CPF</label><input id="tmTesteCpf" name="cpf" inputmode="numeric" maxlength="14"></div>
            <div class="campo-grupo"><label for="tmTesteEmail">E-mail</label><input id="tmTesteEmail" name="email" type="email" maxlength="200"></div>
          </div>
          <div data-resultado></div>
          <p class="form-msg" data-msg></p></form>`,
      rodape:
        '<button type="button" class="btn ghost" data-fechar>Fechar</button><button type="submit" form="tmFormTeste" class="btn primary">Criar pedido de teste</button>',
    });
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const pessoa = { nome: f.nome.value, cpf: f.cpf.value, email: f.email.value };
      const n = Math.max(1, Math.min(4, Number(f.quantidade.value) || 1));
      await travado(dlg.querySelector('[type="submit"]'), async () => {
        const r = await escrever(`/edicoes/${ed.id}/pedido-teste`, 'POST', {
          itens: { tipos: [{ categoria_id: Number(f.tipo.value), quantidade: n }] },
          comprador: pessoa,
          participantes: Array.from({ length: n }, () => pessoa),
          chave,
        });
        if (!r.ok) return erroNoModal(dlg, r.erro);
        dlg.querySelector('[type="submit"]').hidden = true;
        dlg.querySelector('[data-resultado]').innerHTML = `<p class="form-msg ok">Pedido de teste criado.</p>
          <p class="tm-acoes"><a class="btn ghost" href="${esc(r.json.url)}" target="_blank" rel="noopener">Abrir o pedido</a>
          ${r.json.pagamento?.url ? `<a class="btn primary" href="${esc(r.json.pagamento.url)}" target="_blank" rel="noopener">Pagar</a>` : ''}</p>`;
        depois();
      });
    });
  }

  // ================================================ T5 — Adicionar operador
  const SITUACAO_OPERADOR = {
    aguardando_ativacao: ['badge-pendente', 'Aguardando ativação'],
    ativo: ['badge-ok', 'Ativo'],
    desativado: ['badge-neutro', 'Desativado'],
  };

  async function renderOperadores(el) {
    const leituras = await lerOuAvisar(el, () => Promise.all([pegar(`${R}/operadores`), pegar(`${R}/edicoes`)]));
    if (!leituras) return;
    const [operadores, edicoes] = leituras;
    const edicoesTexto = (o) =>
      o.edicoes === 'todas' ? 'Todas' : o.edicoes.map((e) => esc(e.nome || `#${e.id}`)).join('<br>') || '—';
    el.innerHTML = `
      <div class="barra-pagina"><p class="barra-pagina-texto">${operadores.length ? plural(operadores.length, 'operador', 'operadores') : ''}</p>
        <button type="button" class="btn primary" id="tmNovoOperador">+ Adicionar operador</button></div>
      <p class="campo-ajuda">O operador ativa o acesso em <code>/ticket/ativar</code> e entra pela tela de login da Mostraí; a sessão dele só abre o check-in.</p>
      ${
        operadores.length
          ? `<div class="tabela-caixa"><div class="rolagem"><table>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Edições</th><th>Situação</th><th>Último acesso</th><th></th></tr></thead>
          <tbody>${operadores
            .map(
              (o) => `<tr>
              <td><b>${esc(o.nome)}</b></td><td>${esc(o.email)}</td><td>${edicoesTexto(o)}</td>
              <td>${o.bloqueado_pela_mostrai ? selo(['badge-err', 'Acesso bloqueado pela conta da Mostraí']) : selo(SITUACAO_OPERADOR[o.status])}
                ${o.status === 'aguardando_ativacao' && o.codigo_expira_em ? `<br><span class="u-dim">código vale até ${esc(quando(o.codigo_expira_em))}</span>` : ''}</td>
              <td>${esc(quando(o.ultimo_acesso_em) || '—')}</td>
              <td class="u-ta-r">
                <button type="button" class="btn ghost mini" data-editar-op="${o.id}">Editar</button>
                <button type="button" class="btn ghost mini" data-codigo-op="${o.id}">Gerar novo código</button>
                ${o.status === 'desativado' ? `<button type="button" class="btn ghost mini" data-reativar-op="${o.id}">Reativar</button>` : `<button type="button" class="btn perigo-sutil mini" data-desativar-op="${o.id}">Desativar</button>`}
              </td></tr>`,
            )
            .join('')}</tbody></table></div></div>`
          : vazio('Nenhum operador ainda.', 'Operador faz o check-in na portaria, pelo celular.')
      }`;
    const recarregar = () => renderOperadores(el);
    const porId = (id) => operadores.find((o) => o.id === Number(id));
    el.querySelector('#tmNovoOperador').addEventListener('click', () => modalOperador(null, edicoes, recarregar));
    el.querySelectorAll('[data-editar-op]').forEach((b) =>
      b.addEventListener('click', () => modalOperador(porId(b.dataset.editarOp), edicoes, recarregar)),
    );
    el.querySelectorAll('[data-codigo-op]').forEach((b) =>
      b.addEventListener('click', async () => {
        const o = porId(b.dataset.codigoOp);
        const ok = await confirmarModal({
          titulo: 'Gerar novo código',
          texto: `<p>Gerar um código novo para <b>${esc(o.nome)}</b>? O código anterior para de valer${o.status === 'ativo' ? ' e a senha atual também' : ''}.</p>`,
          botao: 'Gerar novo código',
        });
        if (!ok) return;
        const r = await escrever(`/operadores/${o.id}/codigo`, 'POST', {});
        if (!r.ok) return toast(r.erro, 'err');
        mostrarCodigo(r.json);
        recarregar();
      }),
    );
    el.querySelectorAll('[data-desativar-op]').forEach((b) =>
      b.addEventListener('click', async () => {
        const o = porId(b.dataset.desativarOp);
        const ok = await confirmarModal({
          titulo: 'Desativar operador',
          texto: `<p>Desativar <b>${esc(o.nome)}</b>? O acesso para na hora.</p>`,
          botao: 'Desativar',
          perigo: true,
        });
        if (!ok) return;
        const r = await escrever(`/operadores/${o.id}/desativar`, 'POST', {});
        if (!r.ok) return toast(r.erro, 'err');
        toast('Operador desativado.');
        recarregar();
      }),
    );
    el.querySelectorAll('[data-reativar-op]').forEach((b) =>
      b.addEventListener('click', async () => {
        await travado(b, async () => {
          const r = await escrever(`/operadores/${b.dataset.reativarOp}/reativar`, 'POST', {});
          if (!r.ok) return toast(r.erro, 'err');
          toast('Operador reativado.');
          recarregar();
        });
      }),
    );
  }

  function mostrarCodigo({ operador, codigo, endereco }) {
    const texto = `Código de ativação de ${operador.nome}: ${codigo}. Vale 72 horas e uma vez só. Envie também o endereço: ${endereco}`;
    const { dlg } = abrirModal({
      titulo: 'Código de ativação',
      corpo: `<p>Código de ativação de <b>${esc(operador.nome)}</b>:</p><p class="tm-codigo">${esc(codigo)}</p>
        <p>Vale 72 horas e uma vez só. Envie também o endereço: <code>${esc(endereco)}</code></p>
        <p class="campo-ajuda">O código aparece só agora. Se perder, gere outro.</p>`,
      rodape:
        '<button type="button" class="btn ghost" data-copiar>Copiar</button><button type="button" class="btn primary" data-fechar>Fechar</button>',
    });
    dlg.querySelector('[data-copiar]').addEventListener('click', () =>
      copiarTexto(texto).then(
        () => toast('Código e endereço copiados.'),
        () => toast('Copie o código à mão.', 'err'),
      ),
    );
  }

  function modalOperador(op, edicoes, depois) {
    const escolhidas = new Set(op && op.edicoes !== 'todas' ? op.edicoes.map((e) => Number(e.id)) : []);
    const todas = !op || op.edicoes === 'todas';
    const { dlg, fechar } = abrirModal({
      titulo: op ? 'Editar operador' : 'Adicionar operador',
      corpo: `<form id="tmFormOperador" novalidate>
          <div class="campos">
            <div class="campo-grupo"><label for="tmOpNome">Nome</label><input id="tmOpNome" name="nome" maxlength="120" value="${esc(op?.nome ?? '')}" required></div>
            <div class="campo-grupo"><label for="tmOpEmail">E-mail</label><input id="tmOpEmail" name="email" type="email" maxlength="200" value="${esc(op?.email ?? '')}" ${op ? 'readonly' : ''} required></div>
          </div>
          <p class="campo-rotulo">Edições</p>
          <div class="segmentado" role="radiogroup">
            <label><input type="radio" name="alcance" value="todas" ${todas ? 'checked' : ''}><span>Todas as edições</span></label>
            <label><input type="radio" name="alcance" value="escolhidas" ${todas ? '' : 'checked'}><span>Só as escolhidas</span></label>
          </div>
          <div class="tm-lista-marcar" data-escolhidas ${todas ? 'hidden' : ''}>${edicoes
            .filter((e) => e.status !== 'encerrado')
            .map(
              (e) =>
                `<label class="tm-marcar"><input type="checkbox" name="edicao" value="${e.id}" ${escolhidas.has(e.id) ? 'checked' : ''}> ${esc(nomeDaEdicao(e))}</label>`,
            )
            .join('')}</div>
          <p class="form-msg" data-msg></p></form>`,
      rodape: `<button type="button" class="btn ghost" data-fechar>Cancelar</button><button type="submit" form="tmFormOperador" class="btn primary">${op ? 'Salvar' : 'Adicionar e gerar código'}</button>`,
    });
    const form = dlg.querySelector('form');
    form.addEventListener('change', () => {
      form.querySelector('[data-escolhidas]').hidden = form.elements.alcance.value === 'todas';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form.elements;
      const edicoesSel =
        f.alcance.value === 'todas'
          ? 'todas'
          : [...form.querySelectorAll('[name="edicao"]:checked')].map((c) => Number(c.value));
      await travado(dlg.querySelector('[type="submit"]'), async () => {
        const r = op
          ? await escrever(`/operadores/${op.id}`, 'PATCH', { nome: f.nome.value, edicoes: edicoesSel })
          : await escrever('/operadores', 'POST', { nome: f.nome.value, email: f.email.value, edicoes: edicoesSel });
        if (!r.ok) return erroNoModal(dlg, r.erro);
        fechar();
        if (op) toast('Operador salvo.');
        else {
          toast('Operador adicionado.');
          mostrarCodigo(r.json);
        }
        depois();
      });
    });
  }

  window.renderTrimundiEventos = renderEventos;
  window.renderTrimundiIngressos = renderIngressos;
  window.renderTrimundiPromocoes = renderPromocoes;
  window.renderTrimundiParticipantes = renderParticipantes;
  window.renderTrimundiOperadores = renderOperadores;
})();
