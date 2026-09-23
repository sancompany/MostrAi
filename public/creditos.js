// Créditos e benefícios — módulo do painel único. Cada pagamento confirmado
// de quem a conta indicou vale 1 crédito; créditos viram um plano por tempo
// limitado.
//
// Uso: montarCreditos({ aoResgatar }) — `aoResgatar` recarrega o que depende
// do plano da conta. Requer /config.js, /layout.js e /eventos.js antes.
//
// Idempotente: toda carga reescreve os containers por inteiro, e os ouvintes
// ficam num container só (delegação), registrados uma vez.
(function () {
  const PERIODOS = [1, 3, 6, 12];
  const TIERS = ['essencial', 'destaque', 'maximo'];
  let dados = null;
  let escolha = null;
  let aoResgatar = null;
  let montado = false;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.esc(s);
  const data = (iso) => window.dataBR(iso);
  const nomeTier = (t) => window.ROTULOS.tier[t] || t;
  const periodo = (m) => (m === 1 ? '1 mês' : `${m} meses`);
  const creditos = (n) => `${n} ${Math.abs(n) === 1 ? 'crédito' : 'créditos'}`;
  const hoje = () => new Date().toISOString().slice(0, 10);
  function somarDias(iso, dias) {
    const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  }
  const linkIndicacao = (codigo) =>
    `${window.location.origin}/anunciante/cadastro.html?ref=${encodeURIComponent(codigo)}`;

  function htmlSituacao(d) {
    const partes = [];
    if (d.beneficioAtivo) {
      const b = d.beneficioAtivo;
      partes.push(
        `<p><span class="badge badge-ok">Em vigor</span> <b>${esc(b.nomeTier)}</b> por créditos até <b>${data(b.validoAte)}</b>.</p>`,
      );
    }
    if (d.beneficioAgendado) {
      const b = d.beneficioAgendado;
      partes.push(
        `<p><span class="badge badge-pendente">Programado</span> <b>${esc(b.nomeTier)}</b> de <b>${data(b.comecaEm)}</b> a <b>${data(b.validoAte)}</b>, quando o plano pago atual terminar.</p>`,
      );
    }
    if (!d.resgate.permitido && d.resgate.motivo)
      partes.push(`<p class="creditos-motivo">${esc(d.resgate.motivo)}</p>`);
    return partes.length ? `<div class="creditos-situacao">${partes.join('')}</div>` : '';
  }

  function htmlIndicacao(ind) {
    if (!ind) return '';
    const link = linkIndicacao(ind.codigo);
    const texto = `Anuncie nas telas da Mostraí. Cadastre-se pelo meu link: ${link}`;
    const atividade =
      ind.cadastradas === 0
        ? 'Ninguém se cadastrou pelo seu link ainda.'
        : `${ind.cadastradas} ${ind.cadastradas === 1 ? 'conta se cadastrou' : 'contas se cadastraram'} pelo seu link · ${ind.pagantes} ${ind.pagantes === 1 ? 'já pagou' : 'já pagaram'}.`;
    return `
      <h3 class="creditos-titulo">Seu link de indicação</h3>
      <p class="creditos-nota">Quem se cadastrar por este link vale 1 crédito pra você a cada pagamento confirmado — o primeiro e cada renovação.</p>
      <div class="creditos-link">
        <code>${esc(link)}</code>
        <button type="button" class="btn ghost mini" data-acao="copiar" data-texto="${esc(link)}">Copiar link</button>
      </div>
      <p class="creditos-codigo">Ou informe o código <b>${esc(ind.codigo)}</b> no cadastro.</p>
      <a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(texto)}" target="_blank" rel="noopener">Enviar pelo WhatsApp</a>
      <p class="creditos-atividade">${esc(atividade)}</p>`;
  }

  function htmlOpcoes(d) {
    const porChave = Object.fromEntries(d.opcoes.map((o) => [`${o.tier}:${o.meses}`, o]));
    const celula = (tier, meses) => {
      const o = porChave[`${tier}:${meses}`];
      if (!o) return '<td>—</td>';
      const acao =
        o.disponivel && d.resgate.permitido
          ? `<button type="button" class="btn primary mini" data-acao="resgatar" data-tier="${tier}" data-meses="${meses}">Resgatar</button>`
          : `<span class="creditos-faltam">${o.disponivel ? 'indisponível agora' : `faltam ${o.faltam}`}</span>`;
      return `<td><span class="creditos-custo">${creditos(o.custo)}</span>${acao}</td>`;
    };
    return `<div class="u-ox-auto"><table class="creditos-tabela">
      <thead><tr><th scope="col">Plano</th>${PERIODOS.map((m) => `<th scope="col">${periodo(m)}</th>`).join('')}</tr></thead>
      <tbody>${TIERS.map((t) => `<tr><th scope="row">${esc(nomeTier(t))}</th>${PERIODOS.map((m) => celula(t, m)).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  }

  function htmlHistorico(movs) {
    if (!movs.length) return '<p class="texto-vazio">Nenhuma movimentação ainda.</p>';
    return `<ul class="creditos-movimentos">${movs
      .map((m) => {
        const rotulo = window.ROTULOS.movimentoCredito[m.tipo] || m.tipo;
        const origem = m.origem_nome && m.tipo.startsWith('indicacao') ? ` · ${esc(m.origem_nome)}` : '';
        const sinal = m.quantidade > 0 ? `+${m.quantidade}` : String(m.quantidade);
        return `<li><time>${data(m.criado_em)}</time><span>${esc(rotulo)}${origem}</span><b class="${m.quantidade > 0 ? 'creditos-entrada' : 'creditos-saida'}">${sinal}</b></li>`;
      })
      .join('')}</ul>`;
  }

  async function carregar() {
    const secao = $('modCreditos');
    if (!secao) return;
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/creditos`, { credentials: 'include' });
      if (!r.ok) throw new Error();
      dados = await r.json();
      $('creditosSaldo').textContent = String(dados.saldo);
      $('creditosSituacao').innerHTML = htmlSituacao(dados);
      $('creditosIndicacao').innerHTML = htmlIndicacao(dados.indicacao);
      $('creditosIndicacao').hidden = !dados.indicacao;
      $('creditosOpcoes').innerHTML = htmlOpcoes(dados);
      $('creditosHistorico').innerHTML = htmlHistorico(dados.movimentacoes);
    } catch {
      // Saldo desconhecido nunca vira "0": mostra que não carregou.
      dados = null;
      $('creditosSaldo').textContent = '-';
      $('creditosSituacao').innerHTML =
        '<p class="form-msg err">Não foi possível carregar seus créditos agora. Tente atualizar a página.</p>';
      $('creditosOpcoes').innerHTML = '';
    }
    secao.hidden = false;
  }

  // O mesmo que o servidor aplica (src/creditos/routes.js e
  // plano-administrativo.js): com ciclo pago em curso, começa quando ele
  // termina; sem, começa hoje. Validade = início + 30 dias por mês.
  function htmlPreview(tier, meses) {
    const o = dados.opcoes.find((x) => x.tier === tier && x.meses === meses);
    const s = dados.situacaoAtual;
    const dias = meses * dados.diasPorMes;
    const inicio = s.pagandoEmDia ? s.validoAte : hoje();
    const fim = somarDias(inicio, dias);
    const agora = s.planoNome
      ? `${esc(s.planoNome)} (${s.cortesia ? 'cortesia' : 'pago'})${s.validoAte ? ` até ${data(s.validoAte)}` : ''}`
      : 'Sem plano ativo';
    const detalheInicio = s.pagandoEmDia
      ? 'Começa quando o seu plano pago terminar — ele não é interrompido.'
      : s.planoNome
        ? 'Começa hoje e substitui o plano atual.'
        : 'Começa hoje.';
    const renovacao = s.pagandoEmDia
      ? '<li>Se a sua assinatura renovar antes disso, o benefício começa no fim do novo ciclo, com a mesma duração.</li>'
      : '';
    return `
      <ol class="resgate-etapas">
        <li><span class="resgate-rotulo">Agora</span><b>${agora}</b></li>
        <li><span class="resgate-rotulo">Será ativado</span><b>${esc(nomeTier(tier))} por ${periodo(meses)}</b>
          <span>de ${data(inicio)} a ${data(fim)}. ${detalheInicio}</span></li>
        <li><span class="resgate-rotulo">Depois</span><b>Em ${data(fim)} o benefício termina.</b>
          <span>A conta fica sem plano. Nada é cobrado automaticamente — você assina quando quiser.</span></li>
      </ol>
      <ul class="resgate-notas">${renovacao}
        <li>Saldo: <b>${creditos(dados.saldo)}</b> → <b>${creditos(dados.saldo - o.custo)}</b></li>
      </ul>`;
  }

  function abrirResgate(tier, meses) {
    if (!dados) return;
    escolha = { tier, meses };
    $('previewResgate').innerHTML = htmlPreview(tier, meses);
    $('msgResgate').textContent = '';
    $('msgResgate').className = 'form-msg';
    $('btnConfirmarResgate').disabled = false;
    $('dlgResgate').showModal();
  }

  async function confirmarResgate() {
    if (!escolha) return;
    const botao = $('btnConfirmarResgate');
    const msg = $('msgResgate');
    botao.disabled = true;
    msg.textContent = 'Resgatando...';
    msg.className = 'form-msg';
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/creditos/resgatar`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(escolha),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(corpo.erro || 'Não foi possível resgatar agora.');
      $('dlgResgate').close();
      escolha = null;
      await carregar();
      if (aoResgatar) aoResgatar();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'form-msg err';
      botao.disabled = false;
    }
  }

  async function copiar(botao) {
    const antes = botao.textContent;
    try {
      await navigator.clipboard.writeText(botao.dataset.texto);
      botao.textContent = 'Copiado!';
    } catch {
      botao.textContent = 'Copie o link acima';
    }
    setTimeout(() => {
      botao.textContent = antes;
    }, 1600);
  }

  window.montarCreditos = function montarCreditos(opcoes = {}) {
    aoResgatar = opcoes.aoResgatar || null;
    carregar();
    if (montado) return;
    montado = true;
    $('modCreditos')?.addEventListener('click', (e) => {
      const alvo = e.target.closest('[data-acao]');
      if (!alvo) return;
      if (alvo.dataset.acao === 'resgatar') abrirResgate(alvo.dataset.tier, Number(alvo.dataset.meses));
      if (alvo.dataset.acao === 'copiar') copiar(alvo);
    });
    $('btnConfirmarResgate')?.addEventListener('click', confirmarResgate);
    $('btnCancelarResgate')?.addEventListener('click', () => $('dlgResgate').close());
    $('btnFecharResgate')?.addEventListener('click', () => $('dlgResgate').close());
    if (window.ligarEventosDaConta) window.ligarEventosDaConta({ 'credits.updated': carregar });
  };
})();
