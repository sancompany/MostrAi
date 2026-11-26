// Marketplace de Lojas — Admin → Lojas (migrations 123 e 124).
//
// Três abas: Lojas (lista e ficha: status, contrato, pagamentos, espaços,
// contatos e histórico), Planos de loja e Moderação (espaços de todas as
// lojas). Arquivo próprio, carregado ANTES de index.page.js (o mesmo arranjo
// de admin/trimundi.js): o módulo `lojas` de lá chama as funções daqui, e as
// peças de lá (api, pegar, abrirModal, caixaTabela...) são resolvidas na hora
// do uso. Toda regra é do servidor (/admin/lojas/*): esta tela só mostra e
// envia. Texto vindo do banco passa por esc() antes de virar HTML.
//
// O item "Lojas" só aparece no menu com o Marketplace ligado
// (MARKETPLACE_ATIVO=1 — GET /admin/marketplace/estado).
(() => {
  const doAdmin =
    (nome) =>
    (...args) =>
      window[nome](...args);
  const api = doAdmin('api');
  const pegar = doAdmin('pegar');
  const abrirModal = doAdmin('abrirModal');
  const confirmarModal = doAdmin('confirmarModal');
  const toast = doAdmin('toast');
  const vazio = doAdmin('vazio');
  const erroNoModal = doAdmin('erroNoModal');
  const caixaTabela = doAdmin('caixaTabela');
  const turbinarTabela = doAdmin('turbinarTabela');
  const migalha = doAdmin('migalha');
  const fichaCabecalho = doAdmin('fichaCabecalho');
  const fmt = doAdmin('fmt');
  const esc = (v) => window.esc(v ?? '');
  const dia = (v) => (v ? window.dataBR(v) : '—');

  const TIPOS = {
    tela_indoor: 'Tela indoor',
    painel_led: 'Painel de LED',
    totem: 'Totem',
    outdoor: 'Outdoor',
    empena: 'Empena',
    outro: 'Outro',
  };
  const SITUACAO = {
    na_vitrine: ['badge-ok', 'Na vitrine'],
    rascunho: ['badge-neutro', 'Rascunho'],
    suspensa: ['badge-err', 'Suspensa'],
    encerrada: ['badge-neutro', 'Encerrada'],
    conta_indisponivel: ['badge-err', 'Conta indisponível'],
    sem_assinatura: ['badge-pendente', 'Sem contrato'],
    aguardando_inicio: ['badge-info', 'Contrato a começar'],
    vencida: ['badge-err', 'Contrato vencido'],
    inadimplente: ['badge-err', 'Pagamento em atraso'],
  };
  const selo = (sit) => {
    const [classe, rotulo] = SITUACAO[sit] || ['badge-neutro', sit];
    return `<span class="badge ${classe}">${esc(rotulo)}</span>`;
  };
  const STATUS_ESPACO = { publicado: 'Publicado', rascunho: 'Rascunho', pausado: 'Pausado', arquivado: 'Arquivado' };

  // Erro de escrita → mensagem do servidor.
  async function enviar(caminho, metodo, corpo) {
    const r = await api(caminho, { method: metodo, body: corpo ? JSON.stringify(corpo) : undefined });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(dados.erro || 'não foi possível concluir');
    return dados;
  }

  // Formulário em modal: junta os campos, envia e fecha; erro fica no modal.
  function formularioModal({ titulo, campos, botao, aoEnviar, largo = false }) {
    const { dlg, fechar } = abrirModal({
      titulo,
      largo,
      corpo: `<form id="formLojaModal" class="modal-form" novalidate>${campos}<p class="form-msg" data-msg role="status"></p></form>`,
      rodape: `<button type="button" class="btn ghost" data-fechar>Cancelar</button>
        <button type="submit" form="formLojaModal" class="btn primary">${esc(botao)}</button>`,
    });
    const form = dlg.querySelector('#formLojaModal');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const dados = Object.fromEntries(new FormData(form));
      for (const k of Object.keys(dados)) if (dados[k] === '') dados[k] = null;
      const btn = dlg.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        await aoEnviar(dados, form);
        fechar();
      } catch (err) {
        erroNoModal(dlg, err.message);
        btn.disabled = false;
      }
    });
    return { dlg, form };
  }

  const campo = (id, rotulo, attrs = '', valor = '') =>
    `<div><label for="${id}">${rotulo}</label><input id="${id}" ${attrs} value="${esc(valor)}"></div>`;

  // ------------------------------------------------------------------ lista
  async function renderLista(el) {
    const lojas = await pegar('/admin/lojas');
    const linhas = lojas
      .map((l) => {
        const a = l.assinatura;
        return `<tr class="linha-clicavel" data-filtro="${esc(l.situacao)}" data-loja="${l.id}">
          <td><b>${esc(l.nome)}</b><small class="cat-detalhe">/loja/${esc(l.slug)}</small></td>
          <td>${esc(l.conta_nome)}</td>
          <td>${esc([l.cidade, l.uf].filter(Boolean).join('/')) || '<span class="u-dim">—</span>'}</td>
          <td>${selo(l.situacao)}</td>
          <td>${a ? `${dia(a.inicio)} a ${dia(a.fim)}` : '<span class="u-dim">—</span>'}</td>
          <td>${a?.pago_ate ? dia(a.pago_ate) : '<span class="u-dim">—</span>'}</td>
        </tr>`;
      })
      .join('');
    const conta = (s) => lojas.filter((l) => l.situacao === s).length;
    el.innerHTML = `
      <div class="barra-pagina">
        <p class="barra-pagina-texto">${conta('na_vitrine')} na vitrine · ${lojas.length} no total</p>
        <button class="btn primary" type="button" id="btnNovaLoja">+ Nova loja</button>
      </div>
      ${
        lojas.length
          ? caixaTabela({
              chips: [
                { valor: '', nome: 'Todas' },
                { valor: 'na_vitrine', nome: 'Na vitrine' },
                { valor: 'rascunho', nome: 'Rascunho' },
                { valor: 'inadimplente', nome: 'Em atraso' },
                { valor: 'vencida', nome: 'Vencidas' },
                { valor: 'suspensa', nome: 'Suspensas' },
              ],
              html: `<table><thead><tr><th data-ord>Loja</th><th data-ord>Conta</th><th data-ord>Cidade</th><th data-ord>Situação</th><th data-ord>Contrato</th><th data-ord>Pago até</th></tr></thead><tbody>${linhas}</tbody></table>`,
              unidade: 'loja|lojas',
            })
          : vazio('Nenhuma loja ainda', 'Crie a primeira a partir de uma conta da Mostraí.')
      }`;
    const caixa = el.querySelector('.tabela-caixa');
    if (caixa) turbinarTabela(caixa);
    el.querySelectorAll('tr[data-loja]').forEach((tr) =>
      tr.addEventListener('click', () => {
        location.hash = `lojas/lojas/${tr.dataset.loja}`;
      }),
    );
    el.querySelector('#btnNovaLoja').addEventListener('click', () => novaLoja());
  }

  // Nova loja: escolhe a conta (busca), dá o endereço e o nome. A conta ganha
  // o papel 'loja' no servidor.
  function novaLoja() {
    const { dlg, form } = formularioModal({
      titulo: 'Nova loja',
      botao: 'Criar loja',
      campos: `
        <div><label for="lojaBusca">Conta dona da loja</label>
          <input id="lojaBusca" type="search" placeholder="Nome, e-mail ou número da conta" autocomplete="off">
          <input type="hidden" name="conta_id">
          <ul class="lojas-contas" data-contas></ul>
          <p class="u-dim u-fs-85 u-m-0" data-conta-escolhida>Nenhuma conta escolhida.</p></div>
        ${campo('lojaNome', 'Nome da loja', 'name="nome" maxlength="80" required')}
        ${campo('lojaSlug', 'Endereço público (/loja/...)', 'name="slug" maxlength="40" pattern="[a-z0-9-]+" required placeholder="extradoor"')}
        <div class="campos">
          ${campo('lojaDoc', 'CNPJ ou CPF', 'name="documento" inputmode="numeric" maxlength="18"')}
          ${campo('lojaRazao', 'Razão social', 'name="razao_social" maxlength="120"')}
        </div>
        <div class="campos">
          ${campo('lojaCidade', 'Cidade', 'name="cidade" maxlength="80"')}
          ${campo('lojaUf', 'UF', 'name="uf" maxlength="2"')}
        </div>`,
      aoEnviar: async (dados) => {
        if (!dados.conta_id) throw new Error('escolha a conta dona da loja');
        const loja = await enviar('/admin/lojas', 'POST', dados);
        toast('Loja criada.');
        location.hash = `lojas/lojas/${loja.id}`;
      },
    });
    const busca = dlg.querySelector('#lojaBusca');
    const lista = dlg.querySelector('[data-contas]');
    const escolhida = dlg.querySelector('[data-conta-escolhida]');
    let timer = null;
    busca.addEventListener('input', () => {
      clearTimeout(timer);
      const termo = busca.value.trim();
      if (termo.length < 2) {
        lista.innerHTML = '';
        return;
      }
      timer = setTimeout(async () => {
        try {
          const contas = await pegar(`/admin/lojas/contas?busca=${encodeURIComponent(termo)}`);
          lista.innerHTML = contas.length
            ? contas
                .map(
                  (c) =>
                    `<li><button type="button" class="btn-linha" data-conta="${c.id}" data-nome="${esc(c.nome_empresa)}">#${c.id} · ${esc(c.nome_empresa)} <span class="u-dim">${esc(c.contato_email || '')}</span></button></li>`,
                )
                .join('')
            : '<li class="u-dim">Nenhuma conta sem loja com esse termo.</li>';
        } catch {
          lista.innerHTML = '<li class="u-txt-erro">Não foi possível buscar agora.</li>';
        }
      }, 250);
    });
    lista.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-conta]');
      if (!b) return;
      form.conta_id.value = b.dataset.conta;
      escolhida.textContent = `Conta escolhida: #${b.dataset.conta} · ${b.dataset.nome}`;
      if (!form.nome.value) form.nome.value = b.dataset.nome;
      if (!form.slug.value) {
        form.slug.value = b.dataset.nome
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40);
      }
      lista.innerHTML = '';
    });
  }

  // ------------------------------------------------------------------ ficha
  async function renderFicha(el, lojaId) {
    let l;
    try {
      l = await pegar(`/admin/lojas/${lojaId}`);
    } catch {
      el.innerHTML = '<p class="form-msg err">Loja não encontrada. <a href="#lojas/lojas">Voltar</a></p>';
      return;
    }
    const [planos, contatos] = await Promise.all([
      pegar('/admin/lojas/planos'),
      pegar(`/admin/lojas/${lojaId}/contatos`),
    ]);
    const a = l.assinatura;
    const recarregar = () => renderFicha(el, lojaId);

    const acoesStatus = {
      rascunho: [['ativa', 'Ativar loja', 'primary']],
      ativa: [['suspensa', 'Suspender', 'ghost']],
      suspensa: [['ativa', 'Reativar', 'primary']],
      encerrada: [],
    }[l.status];
    const botoesStatus = [
      ...(acoesStatus || []).map(
        ([s, rotulo, estilo]) =>
          `<button type="button" class="btn ${estilo} mini" data-status="${s}">${rotulo}</button>`,
      ),
      l.status !== 'encerrada'
        ? '<button type="button" class="btn perigo-sutil mini" data-status="encerrada">Encerrar</button>'
        : '',
    ].join('');

    const contrato = a
      ? `<dl class="lojas-kv">
          <div><dt>Plano</dt><dd>${esc(a.plano_loja_id)} · ${a.modalidade === 'anual' ? 'Anual' : 'Mensal'} · ${esc(a.prazo_meses)} m</dd></div>
          <div><dt>Valor</dt><dd>${fmt(a.valor_mensal)} / mês${Number(a.taxa_percentual) ? ` · taxa ${esc(a.taxa_percentual)}% (só quando houver venda)` : ''}</dd></div>
          <div><dt>Vigência</dt><dd>${dia(a.inicio)} a ${dia(a.fim)}</dd></div>
          <div><dt>Pago até</dt><dd>${a.pago_ate ? dia(a.pago_ate) : 'nada pago ainda'} · tolerância ${esc(a.dias_tolerancia)} dias</dd></div>
        </dl>
        <div class="lojas-botoes">
          <button type="button" class="btn primary mini" data-pagamento="${a.id}">Registrar pagamento</button>
          <button type="button" class="btn ghost mini" data-nova-assinatura>Renovar (após vencer)</button>
          <button type="button" class="btn perigo-sutil mini" data-cancelar="${a.id}">Cancelar contrato</button>
        </div>`
      : `${vazio('Sem contrato ativo', 'A loja só aparece na vitrine com um plano de loja vigente e em dia.')}
        <div class="lojas-botoes"><button type="button" class="btn primary mini" data-nova-assinatura>Nova assinatura</button></div>`;

    const espacos = l.espacos || [];
    const tabelaEspacos = espacos.length
      ? `<table class="lojas-tabela"><thead><tr><th>Espaço</th><th>Tipo</th><th>Cidade</th><th>Status</th><th><span class="u-sr">Ação</span></th></tr></thead><tbody>${espacos
          .map(
            (
              e,
            ) => `<tr><td><b>${esc(e.nome)}</b>${e.bloqueado_admin_em ? `<small class="cat-detalhe u-txt-erro">bloqueado: ${esc(e.bloqueado_motivo)}</small>` : ''}</td>
              <td>${esc(TIPOS[e.tipo] || e.tipo)}</td><td>${esc(e.cidade)}/${esc(e.uf)}</td><td>${esc(STATUS_ESPACO[e.status] || e.status)}</td>
              <td class="u-ta-r">${
                e.bloqueado_admin_em
                  ? `<button type="button" class="btn-linha" data-liberar="${e.id}">Liberar</button>`
                  : `<button type="button" class="btn-linha" data-bloquear="${e.id}">Bloquear</button>`
              }</td></tr>`,
          )
          .join('')}</tbody></table>`
      : vazio('Nenhum espaço cadastrado', 'A dona da loja cadastra os espaços pelo painel dela.');

    const h = l.historico || { assinaturas: [], eventos: [] };
    const historicoPagamentos = h.assinaturas.length
      ? `<table class="lojas-tabela"><thead><tr><th>Contrato</th><th>Vigência</th><th>Status</th><th>Pagamentos</th></tr></thead><tbody>${h.assinaturas
          .map(
            (
              s,
            ) => `<tr><td>${esc(s.plano_loja_id)} · ${fmt(s.valor_mensal)}/mês</td><td>${dia(s.inicio)} a ${dia(s.fim)}</td><td>${esc(s.status)}</td>
              <td>${
                s.pagamentos.length
                  ? s.pagamentos
                      .map(
                        (p) =>
                          `${dia(p.registrado_em)}: ${fmt(p.valor)} (${esc(p.meio)}${p.referencia ? ` · ${esc(p.referencia)}` : ''}) até ${dia(p.pago_ate)}`,
                      )
                      .join('<br>')
                  : '<span class="u-dim">nenhum</span>'
              }</td></tr>`,
          )
          .join('')}</tbody></table>`
      : '<p class="u-dim">Nenhum contrato ainda.</p>';
    const eventos = h.eventos.length
      ? `<ul class="lojas-eventos">${h.eventos
          .map(
            (ev) =>
              `<li><span class="u-dim">${dia(ev.ocorrido_em)}</span> ${esc(ev.acao.replace(/_/g, ' '))} <span class="u-dim">· ${esc(ev.autor)}</span></li>`,
          )
          .join('')}</ul>`
      : '<p class="u-dim">Sem eventos.</p>';
    const listaContatos = contatos.length
      ? `<ul class="lojas-eventos">${contatos
          .slice(0, 20)
          .map(
            (c) =>
              `<li><span class="u-dim">${dia(c.criado_em)}</span> <b>${esc(c.nome)}</b> · ${esc(c.email)}${c.espaco_nome ? ` · ${esc(c.espaco_nome)}` : ''}${c.respondido_em ? ' · respondido' : c.lido_em ? ' · lido' : ' · <b>novo</b>'}</li>`,
          )
          .join('')}</ul>`
      : '<p class="u-dim">Nenhum pedido de orçamento ainda.</p>';

    el.innerHTML = `
      ${migalha([{ rotulo: 'Lojas', href: '#lojas/lojas' }, { rotulo: l.nome }])}
      <div class="ficha-candidatura lojas-ficha">
        ${fichaCabecalho({
          foto: l.logo_url ? `<img src="${esc(l.logo_url)}" alt="">` : '<div class="ponto-foto-placeholder"></div>',
          nome: esc(l.nome),
          badge: selo(l.situacao),
          endereco: `<a href="/loja/${encodeURIComponent(l.slug)}" target="_blank" rel="noopener">/loja/${esc(l.slug)}</a>${l.cidade ? ` · ${esc(l.cidade)}${l.uf ? `/${esc(l.uf)}` : ''}` : ''}`,
          meta: `Conta #${esc(l.conta_id)}${l.documento ? ` · documento ${esc(l.documento)}` : ''}${l.razao_social ? ` · ${esc(l.razao_social)}` : ''}${l.motivo_status ? ` · motivo: ${esc(l.motivo_status)}` : ''}`,
        })}
        <div class="lojas-botoes">${botoesStatus}<button type="button" class="btn ghost mini" data-editar>Editar cadastro</button>
          <button type="button" class="btn ghost mini" data-escolher-arquivo="arqLogoAdmin">Trocar logo</button>
          <input type="file" id="arqLogoAdmin" accept="image/jpeg,image/png,image/webp" hidden></div>

        <h4 class="lojas-titulo">Contrato com a Mostraí</h4>
        ${contrato}
        <h4 class="lojas-titulo">Espaços (${espacos.length})</h4>
        ${tabelaEspacos}
        <h4 class="lojas-titulo">Pedidos de orçamento (${l.contatos?.total ?? 0}${l.contatos?.novos ? `, ${l.contatos.novos} novos` : ''})</h4>
        ${listaContatos}
        <h4 class="lojas-titulo">Contratos e pagamentos</h4>
        ${historicoPagamentos}
        <h4 class="lojas-titulo">Histórico</h4>
        ${eventos}
      </div>`;

    // Status (motivo obrigatório para suspender e encerrar).
    el.querySelectorAll('[data-status]').forEach((b) =>
      b.addEventListener('click', () => {
        const status = b.dataset.status;
        const pedeMotivo = status === 'suspensa' || status === 'encerrada';
        if (!pedeMotivo) {
          return enviar(`/admin/lojas/${lojaId}/status`, 'POST', { status })
            .then(() => {
              toast('Loja atualizada.');
              recarregar();
            })
            .catch((err) => toast(err.message, 'err'));
        }
        formularioModal({
          titulo: status === 'suspensa' ? 'Suspender loja' : 'Encerrar loja',
          botao: status === 'suspensa' ? 'Suspender' : 'Encerrar',
          campos: `<div><label for="lojaMotivo">Motivo</label><textarea id="lojaMotivo" name="motivo" rows="3" maxlength="300" required></textarea></div>
            ${status === 'encerrada' ? '<p class="aviso-info u-m-0">Encerrada é final: a loja sai da vitrine e não volta.</p>' : ''}`,
          aoEnviar: async (dados) => {
            await enviar(`/admin/lojas/${lojaId}/status`, 'POST', { status, motivo: dados.motivo });
            toast('Loja atualizada.');
            recarregar();
          },
        });
      }),
    );

    el.querySelector('[data-editar]')?.addEventListener('click', () =>
      formularioModal({
        titulo: 'Editar cadastro da loja',
        botao: 'Salvar',
        campos: `${campo('eNome', 'Nome', 'name="nome" maxlength="80"', l.nome)}
          <div class="campos">${campo('eDoc', 'CNPJ ou CPF', 'name="documento" maxlength="18"', l.documento)}${campo('eRazao', 'Razão social', 'name="razao_social" maxlength="120"', l.razao_social)}</div>
          <div class="campos">${campo('eEmail', 'E-mail', 'name="email" type="email" maxlength="200"', l.email)}${campo('eTel', 'Telefone', 'name="telefone" maxlength="20"', l.telefone)}</div>
          <div class="campos">${campo('eCidade', 'Cidade', 'name="cidade" maxlength="80"', l.cidade)}${campo('eUf', 'UF', 'name="uf" maxlength="2"', l.uf)}</div>`,
        aoEnviar: async (dados) => {
          await enviar(`/admin/lojas/${lojaId}`, 'PATCH', dados);
          toast('Cadastro salvo.');
          recarregar();
        },
      }),
    );

    el.querySelector('#arqLogoAdmin').addEventListener('change', async (ev) => {
      const arquivo = ev.target.files[0];
      if (!arquivo) return;
      const corpo = new FormData();
      corpo.append('arquivo', arquivo);
      const r = await fetch(`${API_BASE_URL}/admin/lojas/${lojaId}/logo`, {
        method: 'POST',
        credentials: 'include',
        body: corpo,
      }).catch(() => null);
      if (!r?.ok) return toast((await r?.json().catch(() => ({})))?.erro || 'Não foi possível enviar o logo.', 'err');
      toast('Logo atualizado.');
      recarregar();
    });

    el.querySelectorAll('[data-nova-assinatura]').forEach((b) =>
      b.addEventListener('click', () => {
        const ativos = planos.filter((p) => p.ativo);
        if (!ativos.length) return toast('Crie um plano de loja antes (aba Planos de loja).', 'err');
        formularioModal({
          titulo: a ? 'Renovar contrato' : 'Nova assinatura',
          botao: 'Criar contrato',
          campos: `<div><label for="aPlano">Plano de loja</label><select id="aPlano" name="plano_loja_id">${ativos
            .map(
              (p) =>
                `<option value="${esc(p.id)}">${esc(p.nome)} — ${fmt(p.valor_mensal)}/mês · ${esc(p.prazo_meses)} meses</option>`,
            )
            .join('')}</select></div>
            ${campo('aInicio', 'Início do contrato', 'name="inicio" type="date"')}
            <p class="u-dim u-fs-85 u-m-0">Vazio = hoje. O fim é o início + o prazo do plano − 1 dia. Renovação só depois de o contrato atual vencer.</p>`,
          aoEnviar: async (dados) => {
            await enviar(`/admin/lojas/${lojaId}/assinaturas`, 'POST', dados);
            toast('Contrato criado.');
            recarregar();
          },
        });
      }),
    );

    el.querySelector('[data-pagamento]')?.addEventListener('click', () =>
      formularioModal({
        titulo: 'Registrar pagamento',
        botao: 'Registrar',
        campos: `${campo('pAte', 'Pago até (último dia coberto)', `name="pago_ate" type="date" required max="${esc(a.fim)}"`)}
          <div class="campos">${campo('pValor', 'Valor (R$)', 'name="valor" inputmode="decimal" required')}${campo('pMeio', 'Meio', 'name="meio" maxlength="40" required placeholder="Pix, boleto, transferência"')}</div>
          ${campo('pRef', 'Referência', 'name="referencia" maxlength="120" placeholder="Comprovante, id da transação"')}
          <p class="u-dim u-fs-85 u-m-0">O registro não se altera depois. Fora do contrato ou para trás, o servidor recusa.</p>`,
        aoEnviar: async (dados) => {
          if (dados.valor) dados.valor = String(dados.valor).replace(',', '.');
          await enviar(`/admin/lojas/assinaturas/${a.id}/pagamentos`, 'POST', dados);
          toast('Pagamento registrado.');
          recarregar();
        },
      }),
    );

    el.querySelector('[data-cancelar]')?.addEventListener('click', () =>
      formularioModal({
        titulo: 'Cancelar contrato',
        botao: 'Cancelar contrato',
        campos: `<div><label for="cMotivo">Motivo</label><textarea id="cMotivo" name="motivo" rows="3" maxlength="300" required></textarea></div>
          <p class="aviso-info u-m-0">A loja sai da vitrine na hora.</p>`,
        aoEnviar: async (dados) => {
          await enviar(`/admin/lojas/assinaturas/${a.id}/cancelar`, 'POST', dados);
          toast('Contrato cancelado.');
          recarregar();
        },
      }),
    );

    ligarModeracao(el, lojaId, recarregar);
  }

  // Bloquear / liberar espaço (ficha da loja e aba Moderação).
  function ligarModeracao(el, lojaFixa, recarregar) {
    el.querySelectorAll('[data-bloquear]').forEach((b) =>
      b.addEventListener('click', () => {
        const lojaId = lojaFixa || b.dataset.loja;
        formularioModal({
          titulo: 'Bloquear espaço',
          botao: 'Bloquear',
          campos: `<div><label for="mMotivo">Motivo (a dona vê)</label><textarea id="mMotivo" name="motivo" rows="3" maxlength="300" required placeholder="Ex.: foto sem relação com o espaço"></textarea></div>
            <p class="aviso-info u-m-0">O espaço sai da vitrine e a dona não consegue publicar de novo até você liberar.</p>`,
          aoEnviar: async (dados) => {
            await enviar(`/admin/lojas/${lojaId}/espacos/${b.dataset.bloquear}/moderacao`, 'POST', {
              acao: 'bloquear',
              motivo: dados.motivo,
            });
            toast('Espaço bloqueado.');
            recarregar();
          },
        });
      }),
    );
    el.querySelectorAll('[data-liberar]').forEach((b) =>
      b.addEventListener('click', async () => {
        const lojaId = lojaFixa || b.dataset.loja;
        const ok = await confirmarModal({
          titulo: 'Liberar espaço',
          texto: '<p>O espaço continua pausado. A dona pode publicar de novo pelo painel dela.</p>',
          botao: 'Liberar',
        });
        if (!ok) return;
        try {
          await enviar(`/admin/lojas/${lojaId}/espacos/${b.dataset.liberar}/moderacao`, 'POST', { acao: 'liberar' });
          toast('Espaço liberado.');
          recarregar();
        } catch (err) {
          toast(err.message, 'err');
        }
      }),
    );
  }

  window.renderLojasLista = (el, resto) => (resto ? renderFicha(el, Number(resto)) : renderLista(el));

  // ------------------------------------------------------------------ planos
  window.renderLojasPlanos = async function renderLojasPlanos(el) {
    const planos = await pegar('/admin/lojas/planos');
    const recarregar = () => renderLojasPlanos(el);
    el.innerHTML = `
      <div class="barra-pagina">
        <p class="barra-pagina-texto">O que a Mostraí cobra de cada loja para estar no Marketplace. Mudar um plano não muda contrato já assinado.</p>
        <button class="btn primary" type="button" id="btnNovoPlano">+ Novo plano de loja</button>
      </div>
      ${
        planos.length
          ? `<div class="tabela-caixa"><div class="rolagem"><table><thead><tr><th>Plano</th><th>Modalidade</th><th>Prazo</th><th>Valor</th><th>Taxa sobre vendas</th><th>Tolerância</th><th>Ativo</th><th><span class="u-sr">Ação</span></th></tr></thead><tbody>${planos
              .map(
                (p) => `<tr><td><b>${esc(p.nome)}</b><small class="cat-detalhe">${esc(p.id)}</small></td>
                  <td>${p.modalidade === 'anual' ? 'Anual+' : 'Mensal'}</td><td>${esc(p.prazo_meses)} meses</td>
                  <td>${fmt(p.valor_mensal)}/mês</td><td>${esc(p.taxa_percentual)}%</td><td>${esc(p.dias_tolerancia)} dias</td>
                  <td>${p.ativo ? 'Sim' : '<span class="u-dim">Não</span>'}</td>
                  <td class="u-ta-r"><button type="button" class="btn-linha" data-plano="${esc(p.id)}">Editar</button></td></tr>`,
              )
              .join('')}</tbody></table></div></div>
            <p class="u-dim u-fs-85">A taxa sobre vendas fica registrada no contrato, mas não é cobrada nesta versão: venda ao comprador depende da V2 do San Checkout.</p>`
          : vazio('Nenhum plano de loja', 'Crie o Mensal e o Anual+ com os valores que a Mostraí vai cobrar.')
      }`;
    const formPlano = (p) =>
      formularioModal({
        titulo: p ? 'Editar plano de loja' : 'Novo plano de loja',
        botao: p ? 'Salvar' : 'Criar plano',
        campos: `${p ? '' : campo('plId', 'Identificador', 'name="id" maxlength="40" pattern="[a-z0-9-]+" required placeholder="loja-mensal"')}
          ${campo('plNome', 'Nome', 'name="nome" maxlength="60" required', p?.nome)}
          <div class="campos">
            <div><label for="plMod">Modalidade</label><select id="plMod" name="modalidade"><option value="mensal"${p?.modalidade === 'mensal' ? ' selected' : ''}>Mensal</option><option value="anual"${p?.modalidade === 'anual' ? ' selected' : ''}>Anual+ (12 meses ou mais)</option></select></div>
            ${campo('plPrazo', 'Prazo (meses)', 'name="prazo_meses" inputmode="numeric" required', p?.prazo_meses ?? 1)}
          </div>
          <div class="campos">
            ${campo('plValor', 'Valor por mês (R$)', 'name="valor_mensal" inputmode="decimal" required', p?.valor_mensal)}
            ${campo('plTaxa', 'Taxa sobre vendas (%)', 'name="taxa_percentual" inputmode="decimal"', p?.taxa_percentual ?? 0)}
          </div>
          <div class="campos">
            ${campo('plTol', 'Tolerância após o último dia pago (dias)', 'name="dias_tolerancia" inputmode="numeric"', p?.dias_tolerancia ?? 5)}
            <div><label for="plAtivo">Disponível para novos contratos</label><select id="plAtivo" name="ativo"><option value="true"${p?.ativo !== false ? ' selected' : ''}>Sim</option><option value="false"${p?.ativo === false ? ' selected' : ''}>Não</option></select></div>
          </div>`,
        aoEnviar: async (dados) => {
          dados.ativo = dados.ativo !== 'false';
          for (const k of ['valor_mensal', 'taxa_percentual'])
            if (dados[k]) dados[k] = String(dados[k]).replace(',', '.');
          if (p) await enviar(`/admin/lojas/planos/${encodeURIComponent(p.id)}`, 'PATCH', dados);
          else await enviar('/admin/lojas/planos', 'POST', dados);
          toast('Plano salvo.');
          recarregar();
        },
      });
    el.querySelector('#btnNovoPlano').addEventListener('click', () => formPlano(null));
    el.querySelectorAll('[data-plano]').forEach((b) =>
      b.addEventListener('click', () => formPlano(planos.find((p) => p.id === b.dataset.plano))),
    );
  };

  // ------------------------------------------------------------------ moderação
  window.renderLojasModeracao = async function renderLojasModeracao(el) {
    const espacos = await pegar('/admin/lojas/espacos');
    const recarregar = () => renderLojasModeracao(el);
    const linhas = espacos
      .map((e) => {
        const filtro = e.bloqueado_admin_em ? 'bloqueado' : e.status;
        return `<tr data-filtro="${esc(filtro)}">
          <td><b>${esc(e.nome)}</b>${e.bloqueado_admin_em ? `<small class="cat-detalhe u-txt-erro">${esc(e.bloqueado_motivo)}</small>` : ''}</td>
          <td><a href="#lojas/lojas/${e.loja_id}">${esc(e.loja_nome)}</a>${e.loja_na_vitrine ? '' : ' <span class="u-dim">(fora da vitrine)</span>'}</td>
          <td>${esc(TIPOS[e.tipo] || e.tipo)}</td><td>${esc(e.cidade)}/${esc(e.uf)}</td>
          <td>${esc(e.bloqueado_admin_em ? 'Bloqueado' : STATUS_ESPACO[e.status] || e.status)}</td>
          <td class="u-ta-r">${
            e.bloqueado_admin_em
              ? `<button type="button" class="btn-linha" data-liberar="${e.id}" data-loja="${e.loja_id}">Liberar</button>`
              : `<button type="button" class="btn-linha" data-bloquear="${e.id}" data-loja="${e.loja_id}">Bloquear</button>`
          }</td></tr>`;
      })
      .join('');
    el.innerHTML = espacos.length
      ? caixaTabela({
          chips: [
            { valor: '', nome: 'Todos' },
            { valor: 'publicado', nome: 'Publicados' },
            { valor: 'bloqueado', nome: 'Bloqueados' },
            { valor: 'pausado', nome: 'Pausados' },
            { valor: 'rascunho', nome: 'Rascunho' },
          ],
          html: `<table><thead><tr><th data-ord>Espaço</th><th data-ord>Loja</th><th data-ord>Tipo</th><th data-ord>Cidade</th><th data-ord>Status</th><th><span class="u-sr">Ação</span></th></tr></thead><tbody>${linhas}</tbody></table>`,
          unidade: 'espaço|espaços',
          dica: 'Bloquear tira da vitrine e impede a dona de publicar de novo até você liberar.',
          ativo: 'publicado',
        })
      : vazio('Nenhum espaço cadastrado', 'Os espaços aparecem aqui quando as lojas cadastrarem.');
    const caixa = el.querySelector('.tabela-caixa');
    if (caixa) turbinarTabela(caixa);
    ligarModeracao(el, null, recarregar);
  };

  // Menu: o item "Lojas" só com o Marketplace ligado. Quem chama
  // (index.page.js, mostrarApp) recebe true/false; falha = não mostra.
  window.marketplaceNoMenu = async function marketplaceNoMenu() {
    try {
      const r = await fetch(`${API_BASE_URL}/admin/marketplace/estado`, { credentials: 'include' });
      if (!r.ok) return false;
      return Boolean((await r.json()).ativo);
    } catch {
      return false;
    }
  };
})();
