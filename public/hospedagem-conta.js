// Hospedagem temporária de Ponto Móvel — módulo do painel (migration 113).
//
// O que aparece, sempre decidido no servidor (GET /anunciantes/me/hospedagem):
//   · hospedagem programada — "Ponto Móvel programado" (Agendado);
//   · hospedagem em andamento — tempo operacional válido até agora, o
//     percentual dela e o benefício ESTIMADO;
//   · hospedagem concluída — tempo, percentual e horas recebidas;
//   · SALDO DE HOSPEDAGEM — horas de mídia gratuitas, na rede inteira. Não
//     são créditos (os créditos têm card próprio) e não são dinheiro.
//   · sem nada disso: o convite "Tenho interesse em receber um Ponto Móvel".
//     O comércio não escolhe equipamento, período nem percentual — a Mostraí
//     entra em contato.
//
// Uso: window.montarHospedagem() — idempotente (toda carga reescreve o
// container). Requer /config.js e /eventos.js antes.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.esc(s);
  let dados = null;
  let enviando = false;

  // "6 h 00 min" — o mesmo formato do servidor (src/pontos/hospedagem.js).
  function horas(segundos) {
    const minutos = Math.floor(Math.max(0, Number(segundos) || 0) / 60);
    const h = Math.floor(minutos / 60);
    const m = minutos % 60;
    return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
  }
  const pct = (n) => `${String(Number(n)).replace('.', ',')}%`;
  const periodo = (h) => window.periodoDoEvento?.(h.dataInicio, h.dataFim) || '';

  function htmlHospedagem(h) {
    if (h.estado === 'programada') {
      return `<div class="hosp-item">
          <p class="hosp-titulo"><span class="badge badge-pendente">Agendado</span> <b>Ponto Móvel programado</b></p>
          <p class="hosp-meta">${esc(h.local)} · ${esc(periodo(h))}</p>
        </div>`;
    }
    if (h.estado === 'ativa') {
      return `<div class="hosp-item">
          <p class="hosp-titulo"><span class="badge badge-ok">Em andamento</span> <b>${esc(h.ponto)}</b> está no seu comércio</p>
          <dl class="hosp-numeros">
            <div><dt>Tempo operacional válido</dt><dd>${horas(h.tempoSegundos)}</dd></div>
            <div><dt>Percentual</dt><dd>${pct(h.percentual)}</dd></div>
            <div><dt>Benefício estimado</dt><dd>${horas(h.beneficioEstimadoSegundos)}</dd></div>
          </dl>
          <p class="hosp-nota">Valor estimado enquanto a hospedagem estiver em andamento.</p>
        </div>`;
    }
    // "Usar minhas horas" fica uma vez só, na área do saldo (acima).
    return `<div class="hosp-item">
        <p class="hosp-titulo"><span class="badge badge-neutro">Concluída</span> <b>${esc(h.local)}</b></p>
        <p class="hosp-meta">${esc(periodo(h))}</p>
        <dl class="hosp-numeros">
          <div><dt>Tempo operacional válido</dt><dd>${horas(h.tempoSegundos)}</dd></div>
          <div><dt>Percentual</dt><dd>${pct(h.percentual)}</dd></div>
          <div><dt>Horas recebidas</dt><dd>${horas(h.beneficioSegundos)}</dd></div>
        </dl>
      </div>`;
  }

  function htmlSaldo(saldo) {
    return `<div class="hosp-saldo">
        <p class="section-eyebrow">Saldo de hospedagem</p>
        <p class="hosp-saldo-valor"><b>${horas(saldo.disponivelSegundos)}</b> disponíveis</p>
        <p class="hosp-nota">Ganhos por hospedar um Ponto Móvel Mostraí. Valem na rede inteira e não expiram.</p>
        ${saldo.disponivelSegundos > 0 ? '<button type="button" class="btn primary" data-hosp-usar>Usar minhas horas</button>' : ''}
      </div>`;
  }

  function htmlConvite(d) {
    if (d.interesseAberto) {
      return `<div class="hosp-convite">
          <p><b>Recebemos seu interesse em receber um Ponto Móvel.</b></p>
          <p class="hosp-nota">A Mostraí entra em contato para combinar se e quando faz sentido.</p>
        </div>`;
    }
    // Enxuto (não poluir o painel): um botão; o formulário curto só abre
    // quando a pessoa pede.
    return `<div class="hosp-convite">
        <p>Hospede temporariamente um Ponto Móvel Mostraí no seu comércio. No fim, ${pct(d.percentual)} do tempo em que a tela operou volta para você em horas de mídia gratuitas na rede.</p>
        <button type="button" class="btn ghost" data-hosp-abrir aria-expanded="false" aria-controls="hospInteresseForm">Tenho interesse em receber um Ponto Móvel</button>
        <form id="hospInteresseForm" class="hosp-form" novalidate hidden>
          <label class="form-label" for="hospDisponibilidade">Quando seria bom? <span class="form-hint">(opcional)</span></label>
          <input class="form-input" id="hospDisponibilidade" name="disponibilidade" maxlength="300" autocomplete="off">
          <label class="form-label" for="hospObservacao">Observação <span class="form-hint">(opcional)</span></label>
          <textarea class="form-input" id="hospObservacao" name="observacao" maxlength="500" rows="2"></textarea>
          <p class="form-msg" id="hospMsg" role="status" hidden></p>
          <button type="submit" class="btn primary" id="hospEnviar">Enviar interesse</button>
        </form>
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
    if (!dados.hospedagens.some((h) => h.estado === 'programada' || h.estado === 'ativa')) {
      partes.push(htmlConvite(dados));
    }
    corpo.innerHTML = partes.join('');
    secao.hidden = false;
  }

  async function enviarInteresse(form) {
    if (enviando) return;
    enviando = true;
    const botao = $('hospEnviar');
    const msg = $('hospMsg');
    botao.disabled = true;
    msg.hidden = true;
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/hospedagem/interesse`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          disponibilidade: form.disponibilidade.value,
          observacao: form.observacao.value,
        }),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(corpo.erro || 'Não foi possível enviar agora. Tente de novo.');
      await carregar();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'form-msg err';
      msg.hidden = false;
      botao.disabled = false;
    } finally {
      enviando = false;
    }
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
      const abrir = ev.target.closest('[data-hosp-abrir]');
      if (abrir) {
        const form = $('hospInteresseForm');
        form.hidden = !form.hidden;
        abrir.setAttribute('aria-expanded', String(!form.hidden));
        if (!form.hidden) form.querySelector('input')?.focus();
      }
    });
    corpo?.addEventListener('submit', (ev) => {
      if (ev.target.id !== 'hospInteresseForm') return;
      ev.preventDefault();
      enviarInteresse(ev.target);
    });
    window.ligarEventosDaConta?.({ 'hosting.updated': () => carregar().catch(() => {}) });
  }

  async function carregar() {
    const r = await fetch(`${API_BASE_URL}/anunciantes/me/hospedagem`, { credentials: 'include' });
    if (!r.ok) throw new Error('hospedagem indisponível');
    dados = await r.json();
    render();
  }

  window.montarHospedagem = function montarHospedagem() {
    ligar();
    return carregar().catch(() => {
      // Módulo complementar: se falhar, some — o resto do painel segue.
      dados = null;
      render();
    });
  };
})();
