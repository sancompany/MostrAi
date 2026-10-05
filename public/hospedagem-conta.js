// Hospedagem temporária de uma tela do Mostraí Móvel — módulo do painel
// (migrations 113 a 115) e o formulário de interesse (painel e
// /hospedar.html).
//
// O que aparece, sempre decidido no servidor (GET /anunciantes/me/hospedagem):
//   · hospedagem programada — "Tela do Mostraí Móvel programada" (Agendado)
//     e a situação do termo de hospedagem, que é assinado EM PAPEL com a
//     Mostraí (migration 115 — não há aceite pelo painel);
//   · hospedagem em andamento — tempo operacional válido até agora, o
//     percentual dela e o benefício ESTIMADO;
//   · hospedagem concluída — tempo, percentual e horas recebidas;
//   · SALDO DE HOSPEDAGEM — horas de mídia gratuitas, na rede inteira. Não
//     são créditos (os créditos têm card próprio) e não são dinheiro.
//   · o andamento do interesse enviado (recebido, em contato, aprovado).
// O convite para hospedar NÃO mora aqui (V1.1): é a ação secundária do card
// "Meus pontos", só para quem tem direito ativo de veiculação, e leva a
// /hospedar.html — onde fica o formulário (`window.formInteresseHospedagem`).
// O comércio não escolhe equipamento, período, horário nem percentual — a
// Mostraí combina tudo isso com ele.
//
// Uso: window.montarHospedagem() — idempotente (toda carga reescreve o
// container). Requer /config.js e /eventos.js antes.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.esc(s);
  let dados = null;
  // "6 h 00 min" — o mesmo formato do servidor (src/pontos/hospedagem.js).
  function horas(segundos) {
    const minutos = Math.floor(Math.max(0, Number(segundos) || 0) / 60);
    const h = Math.floor(minutos / 60);
    const m = minutos % 60;
    return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
  }
  const pct = (n) => `${String(Number(n)).replace('.', ',')}%`;
  // "10/10 08:00 → 12/10 18:00", no relógio de Matão (o período tem hora).
  const quando = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const instante = (v) => (v ? quando.format(new Date(v)).replace(',', '') : '');
  const periodo = (h) =>
    h.inicio ? `${instante(h.inicio)} → ${instante(h.fim)}` : window.periodoDoEvento?.(h.dataInicio, h.dataFim) || '';
  const horario = (h) => (h.horario ? `<p class="hosp-meta">Horário: ${esc(h.horario)}</p>` : '');

  function htmlHospedagem(h) {
    if (h.estado === 'programada') {
      // A hospedagem só começa com o termo físico assinado (a Mostraí leva
      // o termo na entrega) — aqui só a situação.
      const termo = h.termoAssinado
        ? '<p class="hosp-meta">Termo de hospedagem assinado. A Mostraí combina a entrega com você.</p>'
        : '<p class="hosp-nota">O termo de hospedagem é assinado em papel com a equipe Mostraí, na entrega da tela.</p>';
      return `<div class="hosp-item">
          <p class="hosp-titulo"><span class="badge badge-pendente">Agendado</span> <b>Tela do Mostraí Móvel programada</b></p>
          <p class="hosp-meta">${esc(h.local)} · ${esc(periodo(h))}</p>
          ${horario(h)}
          ${termo}
        </div>`;
    }
    if (h.estado === 'ativa') {
      return `<div class="hosp-item">
          <p class="hosp-titulo"><span class="badge badge-ok">Em andamento</span> uma tela do <b>${esc(h.ponto)}</b> está no seu comércio</p>
          <dl class="hosp-numeros">
            <div><dt>Tempo operacional válido</dt><dd>${horas(h.tempoSegundos)}</dd></div>
            <div><dt>Percentual</dt><dd>${pct(h.percentual)}</dd></div>
            <div><dt>Benefício estimado</dt><dd>${horas(h.beneficioEstimadoSegundos)}</dd></div>
          </dl>
          <p class="hosp-nota">Valor estimado enquanto a hospedagem estiver em andamento.</p>
        </div>`;
    }
    // Spec §36: a concluída também leva a "Usar minhas horas" — enquanto
    // ainda há saldo para usar.
    const usar =
      h.beneficioSegundos > 0 && dados.saldo.disponivelSegundos > 0
        ? '<button type="button" class="btn ghost mini" data-hosp-usar>Usar minhas horas</button>'
        : '';
    return `<div class="hosp-item">
        <p class="hosp-titulo"><span class="badge badge-neutro">Concluída</span> <b>${esc(h.local)}</b></p>
        <p class="hosp-meta">${esc(periodo(h))}</p>
        <dl class="hosp-numeros">
          <div><dt>Tempo operacional válido</dt><dd>${horas(h.tempoSegundos)}</dd></div>
          <div><dt>Percentual</dt><dd>${pct(h.percentual)}</dd></div>
          <div><dt>Horas recebidas</dt><dd>${horas(h.beneficioSegundos)}</dd></div>
        </dl>
        ${usar}
      </div>`;
  }

  function htmlSaldo(saldo) {
    return `<div class="hosp-saldo">
        <p class="section-eyebrow">Saldo de hospedagem</p>
        <p class="hosp-saldo-valor"><b>${horas(saldo.disponivelSegundos)}</b> disponíveis</p>
        <p class="hosp-nota">Ganhos por hospedar uma tela do Mostraí Móvel. Valem na rede inteira e não expiram.</p>
        ${saldo.disponivelSegundos > 0 ? '<button type="button" class="btn primary" data-hosp-usar>Usar minhas horas</button>' : ''}
      </div>`;
  }

  // O andamento do interesse, nas palavras da conta.
  const ANDAMENTO = {
    nova: ['badge-pendente', 'Interesse enviado', 'Em análise pela equipe Mostraí.'],
    em_contato: ['badge-info', 'Em contato', 'A equipe Mostraí está falando com você para combinar.'],
    aprovada: [
      'badge-ok',
      'Aprovado para agendamento',
      'Falta combinar o período e o horário. Enviar interesse não reserva um equipamento.',
    ],
  };
  function htmlInteresse(i) {
    const [classe, rotulo, nota] = ANDAMENTO[i.status] || ANDAMENTO.nova;
    return `<div class="hosp-convite" data-hosp-interesse>
        <p class="hosp-titulo"><span class="badge ${classe}">${esc(rotulo)}</span> <b>Hospedar uma tela do Mostraí Móvel</b></p>
        <p class="hosp-nota">${esc(nota)}</p>
      </div>`;
  }

  function render() {
    const secao = $('modHospedagem');
    const corpo = $('hospedagemCorpo');
    if (!secao || !corpo) return;
    if (!dados) {
      secao.hidden = true;
      return;
    }
    const partes = [];
    if (dados.saldo.recebidoSegundos > 0 || dados.saldo.disponivelSegundos > 0) partes.push(htmlSaldo(dados.saldo));
    partes.push(...dados.hospedagens.map(htmlHospedagem));
    if (dados.interesseAberto) partes.push(htmlInteresse(dados.interesseAberto));
    // Nada a mostrar (sem saldo, hospedagem nem interesse): o módulo some —
    // o convite é a ação secundária de "Meus pontos".
    corpo.innerHTML = partes.join('');
    secao.hidden = partes.length === 0;
  }

  // "Usar minhas horas": as horas rodam com o criativo da conta — leva até
  // "Meus criativos" (subir ou acompanhar a peça).
  function usarHoras() {
    const alvo = $('modCriativos');
    if (alvo && !alvo.hidden) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  let ligado = false;
  function ligar() {
    if (ligado) return;
    ligado = true;
    const corpo = $('hospedagemCorpo');
    corpo?.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-hosp-usar]')) usarHoras();
    });
    window.ligarEventosDaConta?.({ 'hosting.updated': () => carregar().catch(() => {}) });
  }

  // No resync o painel remonta (montarHospedagem) e o evento
  // `hosting.updated` também recarrega: as duas chamadas simultâneas
  // dividem a mesma busca.
  let emCurso = null;
  let carregadoEm = 0;
  function carregar() {
    emCurso ??= (async () => {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/hospedagem`, { credentials: 'include' });
      if (!r.ok) throw new Error('hospedagem indisponível');
      dados = await r.json();
      carregadoEm = Date.now();
      render();
    })().finally(() => {
      emCurso = null;
    });
    return emCurso;
  }

  // Remontar logo depois de uma carga (o resync acabou de buscar pelo
  // evento) reaproveita o que chegou; o evento `hosting.updated` sempre busca.
  window.montarHospedagem = function montarHospedagem() {
    ligar();
    if (dados && Date.now() - carregadoEm < 3000) return Promise.resolve(render());
    return carregar().catch(() => {
      // Módulo complementar: se falhar, some — o resto do painel segue.
      dados = null;
      render();
    });
  };

  // -------------------------------------------------------------------------
  // Formulário de interesse (V1.1) — /hospedar.html. Só para conta com
  // direito ativo de veiculação (o servidor confere de novo). Os dados da
  // conta vão juntos, sem pedir de novo ("DADOS DA CONTA"); a pessoa só
  // escolhe ONDE: o endereço da conta, um dos pontos dela ou outro endereço
  // (só este abre os campos de endereço). Nada de equipamento, datas,
  // percentual ou termo.
  // `d`: a resposta de GET /anunciantes/me/hospedagem.
  window.formInteresseHospedagem = function formInteresseHospedagem(alvo, d, { aoEnviar } = {}) {
    const c = d.conta || {};
    const linha = (rotulo, valor) => (valor ? `<div><dt>${esc(rotulo)}</dt><dd>${esc(valor)}</dd></div>` : '');
    const opcaoPonto = d.pontos?.length
      ? `<label class="hosp-check"><input type="radio" name="local_tipo" value="ponto"> Um dos meus pontos</label>
         <div data-local="ponto" hidden>
           <label class="form-label" for="hospPonto">Qual ponto</label>
           <select class="form-input" id="hospPonto" name="ponto_id">
             ${d.pontos.map((p) => `<option value="${p.id}">${esc(p.nome)}${p.endereco ? ` — ${esc(p.endereco)}` : ''}</option>`).join('')}
           </select>
         </div>`
      : '';
    alvo.innerHTML = `
      <form class="card u-m-0 u-mw-livre hosp-form" id="formHospedar" novalidate>
        <h2 class="u-fs-130">Quero hospedar um Ponto Móvel</h2>
        <p class="form-hint">Enviar interesse não reserva um equipamento. A disponibilidade, o período e o horário são definidos com a equipe Mostraí.</p>
        <p class="section-eyebrow">Dados da conta</p>
        <dl class="hosp-numeros">
          ${linha('Empresa', c.empresa)}${linha('Responsável', c.responsavel)}${linha('WhatsApp', c.telefone)}${linha('E-mail', c.email)}
        </dl>
        <fieldset class="hosp-local">
          <legend class="form-label">Onde você quer receber o Ponto Móvel?</legend>
          <label class="hosp-check"><input type="radio" name="local_tipo" value="conta" checked> No endereço da minha conta${c.endereco ? ` <span class="form-hint">(${esc(c.endereco)})</span>` : ''}</label>
          ${opcaoPonto}
          <label class="hosp-check"><input type="radio" name="local_tipo" value="outro"> Em outro endereço</label>
          <div data-local="outro" hidden>
            <label class="form-label" for="hospLocalNome">Nome do local <span class="form-hint">(opcional)</span></label>
            <input class="form-input" id="hospLocalNome" name="local_nome" maxlength="120" autocomplete="off">
            <div id="hospEnderecoOutro"></div>
          </div>
        </fieldset>
        <label class="form-label" for="hospObservacao">Observação <span class="form-hint">(opcional)</span></label>
        <textarea class="form-input" id="hospObservacao" name="observacao" maxlength="500" rows="3"></textarea>
        <div hidden aria-hidden="true"><label for="site">Site</label><input id="site" name="site" tabindex="-1" autocomplete="off"></div>
        <p class="form-msg" id="hospMsg" role="status" aria-live="polite" hidden></p>
        <button class="btn primary block" type="submit" id="hospEnviar">Enviar interesse</button>
      </form>`;
    const form = alvo.querySelector('form');
    const enderecoOutro = alvo.querySelector('#hospEnderecoOutro');
    if (window.camposEndereco) {
      enderecoOutro.innerHTML = window.camposEndereco('h_', { cidadePadrao: 'Matão', ufPadrao: 'SP' });
      window.ligarCep?.(form);
    }
    const trocarLocal = () => {
      const tipo = form.local_tipo.value;
      for (const bloco of form.querySelectorAll('[data-local]')) bloco.hidden = bloco.dataset.local !== tipo;
    };
    form.addEventListener('change', (ev) => ev.target.name === 'local_tipo' && trocarLocal());
    let enviandoForm = false;
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (enviandoForm) return;
      enviandoForm = true;
      const botao = form.querySelector('[type=submit]');
      const msg = form.querySelector('#hospMsg');
      botao.disabled = true;
      msg.hidden = false;
      msg.className = 'form-msg';
      msg.textContent = 'Enviando...';
      try {
        const tipo = form.local_tipo.value;
        const corpo = { local_tipo: tipo, observacao: form.observacao.value, site: form.site.value };
        if (tipo === 'ponto') corpo.ponto_id = Number(form.ponto_id.value);
        if (tipo === 'outro') Object.assign(corpo, { local_nome: form.local_nome.value }, window.enderecoDoForm(form));
        const r = await fetch(`${API_BASE_URL}/hospedagem/interesse`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(corpo),
        });
        const resp = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(resp.erro || 'Não foi possível enviar agora. Tente de novo.');
        aoEnviar?.(resp);
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'form-msg err';
        botao.disabled = false;
      } finally {
        enviandoForm = false;
      }
    });
    return form;
  };
  window.htmlAndamentoInteresse = htmlInteresse;
})();
