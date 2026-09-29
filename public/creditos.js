// Créditos e benefícios — módulo do painel único. Crédito vem da
// participação como ponto (mês elegível na rede e indicação paga) e de
// concessão da Mostraí (ADR-016). Créditos viram um benefício temporário —
// nunca dinheiro, carteira ou saldo sacável.
//
// Estação da conta (26/09/2026): a área é RELACIONAL — aparece pra ponto,
// pra quem tem saldo e pra quem tem histórico (`exibicao`, decidido no
// servidor). Indicação saiu daqui: tem card próprio (#modIndicacao), só pra
// ponto.
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
  // Benefício é um CICLO, com o mesmo nome do plano pago (ADR-018):
  // Mensal/Trimestral/Semestral/Anual. A duração em meses fica como
  // explicação secundária ("Período: 6 meses").
  const nomeCiclo = (m) => window.ROTULOS.ciclo[m] || `${m} meses`;
  const duracao = (m) => (m === 1 ? '1 mês' : `${m} meses`);
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
    if (d.beneficioEncerrado) {
      const b = d.beneficioEncerrado;
      partes.push(
        `<p><span class="badge badge-neutro">Terminou</span> Seu benefício <b>${esc(b.nome || b.nomeTier)}</b> terminou em <b>${data(b.validoAte)}</b>. Nenhuma cobrança foi realizada.</p>`,
      );
    }
    if (d.beneficioAtivo) {
      const b = d.beneficioAtivo;
      partes.push(
        `<p><span class="badge badge-ok">Em vigor</span> <b>${esc(b.nome || b.nomeTier)}</b> · Benefício por créditos · até <b>${data(b.validoAte)}</b>.</p>`,
      );
    }
    if (d.beneficioAgendado) {
      const b = d.beneficioAgendado;
      partes.push(
        `<p><span class="badge badge-pendente">Programado</span> <b>${esc(b.nome || b.nomeTier)}</b> · Benefício por créditos · <b>${data(b.comecaEm)}</b> → <b>${data(b.validoAte)}</b>, quando o plano pago atual terminar.</p>`,
      );
    }
    if (d.resgate.substituicao)
      partes.push(
        '<p class="creditos-motivo">Você pode trocar por outro benefício: o atual é encerrado e os créditos usados nele não voltam. Antes de confirmar, você vê exatamente o que muda.</p>',
      );
    if (!d.resgate.permitido && d.resgate.motivo)
      partes.push(`<p class="creditos-motivo">${esc(d.resgate.motivo)}</p>`);
    return partes.length ? `<div class="creditos-situacao">${partes.join('')}</div>` : '';
  }

  // Card "Indicações" (#modIndicacao) — só existe pra conta que é ponto
  // (o servidor manda `indicacao` só nesse caso). Painel do usuário
  // (29/09/2026, pedido do dono): o QR Code do MESMO link, o histórico de
  // quem se cadastrou por ele e o resumo, de GET /anunciantes/me/indicacoes.
  // O card nasce com o que /creditos já trouxe; o histórico chega em seguida
  // (`hist`: undefined = carregando, null = falhou).
  //
  // O link à vista, o "Copiar link", o WhatsApp e o QR saem da MESMA string
  // quando o servidor a manda (`hist.link`, montada com o endereço público do
  // site) — o QR nunca aponta pra um endereço diferente do que está escrito.
  function htmlIndicacao(ind, hist) {
    const link = hist?.link || linkIndicacao(ind.codigo);
    const texto = `Anuncie nas telas da Mostraí. Cadastre-se pelo meu link: ${link}`;
    const qr = hist?.link
      ? `<div class="indicacao-qr"><img src="${API_BASE_URL}/anunciantes/me/indicacoes/qr.svg" alt="QR Code do seu link de indicação" width="132" height="132"></div>`
      : '';
    let historico = '<p class="creditos-atividade">Carregando o histórico de indicações...</p>';
    if (hist) historico = htmlHistoricoIndicacoes(hist);
    else if (hist === null) historico = '<p class="form-msg err">Não foi possível carregar o histórico agora.</p>';
    return `
      <div class="indicacao-compartilhar${qr ? ' com-qr' : ''}">
        ${qr}
        <div class="indicacao-acoes">
          ${qr ? `<p class="indicacao-qr-legenda">Escaneie para criar uma conta indicada por <b>${esc(hist.nome)}</b>.</p>` : ''}
          <div class="indicacao-botoes">
            <button type="button" class="btn ghost mini" data-acao="copiar" data-texto="${esc(link)}">Copiar link</button>
            <a class="btn ghost mini" href="https://wa.me/?text=${encodeURIComponent(texto)}" target="_blank" rel="noopener">Compartilhar pelo WhatsApp</a>
          </div>
        </div>
      </div>
      <code class="indicacao-link">${esc(link)}</code>
      <p class="creditos-codigo">Seu código: <b>${esc(ind.codigo)}</b> — ele já vai dentro do link.</p>
      <p class="creditos-nota">Cada pagamento confirmado de quem se cadastrar pelo seu link vale 1 crédito — o primeiro e cada renovação. Só o cadastro não gera crédito.</p>
      <div class="indicacao-historico">${historico}</div>`;
  }

  // Resumo e histórico — números das MESMAS linhas que o servidor lista
  // (indicacoes/repository.js#historicoDeIndicados). "Cadastrou pelo seu
  // link" e "Gerou crédito" são estados diferentes, e é o crédito que conta.
  function htmlHistoricoIndicacoes(hist) {
    if (!hist.indicados.length) return '<p class="creditos-atividade">Ninguém se cadastrou pelo seu link ainda.</p>';
    const r = hist.resumo;
    const plural = (n, um, varios) => `<b>${n}</b> ${n === 1 ? um : varios}`;
    const linhas = hist.indicados
      .map((i) => {
        const situacao =
          i.creditos > 0
            ? '<span class="badge badge-ok">Gerou crédito</span>'
            : '<span class="badge badge-neutro">Cadastrou pelo seu link</span>';
        const detalhes = i.creditosEm.length
          ? `<details class="indicacao-detalhes"><summary>Ver créditos</summary><ul>${i.creditosEm
              .map(
                (c) =>
                  `<li>${data(c.data)} · +1 crédito · ${c.tipo === 'renovacao' ? 'renovação' : 'primeiro pagamento'}</li>`,
              )
              .join('')}</ul></details>`
          : '';
        return `<tr role="row">
          <th scope="row" role="rowheader"><div class="ind-nome"><span class="ind-nome-texto">${esc(i.nome)}</span>${situacao}${detalhes}</div></th>
          <td role="cell" data-rotulo="Cadastro">${data(i.cadastroEm)}</td>
          <td role="cell" data-rotulo="Plano">${esc(i.plano || 'Sem plano')}</td>
          <td role="cell" class="num" data-rotulo="Pagamentos">${i.pagamentos}</td>
          <td role="cell" class="num" data-rotulo="Créditos">${i.creditos}</td>
        </tr>`;
      })
      .join('');
    return `<ul class="indicacao-resumo" aria-label="Resumo das indicações">
        <li>${plural(r.contas, 'conta indicada', 'contas indicadas')}</li>
        <li>${plural(r.contrataram, 'já contratou', 'já contrataram')}</li>
        <li>${plural(r.creditos, 'crédito gerado', 'créditos gerados')}</li>
      </ul>
      <p class="creditos-titulo indicacao-historico-titulo">Quem se cadastrou pelo seu link</p>
      <table class="mini-table tabela-indicados" role="table" aria-label="Contas indicadas pelo seu link">
        <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Indicado</th><th scope="col" role="columnheader">Cadastro</th><th scope="col" role="columnheader">Plano</th><th scope="col" role="columnheader" class="num">Pagamentos</th><th scope="col" role="columnheader" class="num">Créditos</th></tr></thead>
        <tbody role="rowgroup">${linhas}</tbody>
      </table>`;
  }

  // Uma carga de histórico por vez, e só a mais recente desenha: o SSE de
  // crédito e a recarga do painel chegam juntos.
  let geracaoIndicacao = 0;
  async function desenharIndicacao(ind) {
    const secao = $('modIndicacao');
    if (!secao) return;
    const minha = ++geracaoIndicacao;
    if (!ind) {
      secao.hidden = true;
      $('indicacaoCorpo').innerHTML = '';
      return;
    }
    // Recarga (SSE): mantém o que já está na tela até o histórico novo chegar.
    if (!$('indicacaoCorpo').childElementCount) $('indicacaoCorpo').innerHTML = htmlIndicacao(ind);
    secao.hidden = false;
    let hist = null;
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/indicacoes`, { credentials: 'include' });
      if (r.ok) hist = await r.json();
    } catch {
      hist = null;
    }
    if (minha !== geracaoIndicacao) return;
    // O que estava aberto ("Ver créditos") continua aberto depois da recarga.
    const abertos = new Set(
      [...$('indicacaoCorpo').querySelectorAll('.indicacao-detalhes[open]')].map(
        (d) => d.closest('tr')?.querySelector('.ind-nome-texto')?.textContent,
      ),
    );
    $('indicacaoCorpo').innerHTML = htmlIndicacao(ind, hist);
    for (const d of $('indicacaoCorpo').querySelectorAll('.indicacao-detalhes')) {
      if (abertos.has(d.closest('tr')?.querySelector('.ind-nome-texto')?.textContent)) d.open = true;
    }
  }

  function htmlOpcoes(d) {
    const porChave = Object.fromEntries(d.opcoes.map((o) => [`${o.tier}:${o.meses}`, o]));
    const celula = (tier, meses) => {
      const o = porChave[`${tier}:${meses}`];
      if (!o) return '<td>—</td>';
      const acao =
        o.disponivel && d.resgate.permitido
          ? `<button type="button" class="btn primary mini" data-acao="resgatar" data-tier="${tier}" data-meses="${meses}" aria-label="Resgatar ${esc(nomeTier(tier))} · ${nomeCiclo(meses)}">Resgatar</button>`
          : o.bloqueio
            ? `<span class="creditos-faltam" title="${esc(o.bloqueio)}">abaixo do seu plano</span>`
            : `<span class="creditos-faltam">${o.disponivel ? 'indisponível agora' : `faltam ${o.faltam}`}</span>`;
      return `<td><span class="creditos-custo">${creditos(o.custo)}</span>${acao}</td>`;
    };
    return `<div class="u-ox-auto"><table class="creditos-tabela">
      <thead><tr><th scope="col">Plano</th>${PERIODOS.map((m) => `<th scope="col">${nomeCiclo(m)}</th>`).join('')}</tr></thead>
      <tbody>${TIERS.map((t) => `<tr><th scope="row">${esc(nomeTier(t))}</th>${PERIODOS.map((m) => celula(t, m)).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  }

  function htmlHistorico(movs) {
    if (!movs.length) return '<p class="texto-vazio">Nenhuma movimentação ainda.</p>';
    return `<ul class="creditos-movimentos">${movs
      .map((m) => {
        const rotulo = window.ROTULOS.movimentoCredito[m.tipo] || m.tipo;
        const origem =
          m.origem_nome && m.tipo.startsWith('indicacao')
            ? ` · ${esc(m.origem_nome)}`
            : m.ponto_nome && m.tipo === 'credito_mensal_ponto'
              ? ` ${esc(m.ponto_nome)}`
              : '';
        const sinal = m.quantidade > 0 ? `+${m.quantidade}` : String(m.quantidade);
        // Resgate diz o QUE foi resgatado: "Resgate · Prime · Semestral"
        // (o servidor já traduz registros antigos "6 meses" pro ciclo).
        const oQue =
          m.tipo === 'resgate_beneficio' && m.observacao
            ? ` · ${esc(String(m.observacao).replace(/^Resgate:\s*/, ''))}`
            : '';
        return `<li><time>${data(m.criado_em)}</time><span>${esc(rotulo)}${origem}${oQue}</span><b class="${m.quantidade > 0 ? 'creditos-entrada' : 'creditos-saida'}">${sinal}</b></li>`;
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
      desenharIndicacao(dados.indicacao);
      // Conta que ainda não tem relação com créditos não vê a área (nem o
      // "0 créditos"): o servidor decide pela mesma regra que a documenta.
      if (!dados.exibicao?.mostrar) {
        secao.hidden = true;
        window.publicarResumo?.('creditos', { chips: [] });
        return;
      }
      $('creditosSaldo').textContent = String(dados.saldo);
      $('creditosSituacao').innerHTML = htmlSituacao(dados);
      // Compacto: saldo zerado de quem não é ponto — fica a situação e o
      // histórico, sem a tabela de resgate.
      $('creditosColunas').hidden = !!dados.exibicao.compacto;
      $('creditosOpcoes').innerHTML = dados.exibicao.compacto ? '' : htmlOpcoes(dados);
      $('creditosHistorico').innerHTML = htmlHistorico(dados.movimentacoes);
      window.publicarResumo?.('creditos', {
        chips: [{ rotulo: 'Créditos', valor: String(dados.saldo), alvo: 'modCreditos' }],
      });
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
      ? `${esc(s.planoNome)} (${s.cortesia ? 'benefício' : 'pago'})${s.validoAte ? ` até ${data(s.validoAte)}` : ''}`
      : 'Sem plano ativo';
    const detalheInicio = s.pagandoEmDia
      ? 'Começa quando o seu plano pago terminar — ele não é interrompido.'
      : s.planoNome
        ? 'Começa hoje e substitui o benefício atual.'
        : 'Começa hoje.';
    const renovacao = s.pagandoEmDia
      ? '<li>Se a sua assinatura renovar enquanto o benefício vale, o período pago fica guardado e volta depois dele.</li>'
      : '';
    return `
      <ol class="resgate-etapas">
        <li><span class="resgate-rotulo">Agora</span><b>${agora}</b></li>
        <li><span class="resgate-rotulo">Será ativado</span><b>${esc(nomeTier(tier))} · ${nomeCiclo(meses)}</b>
          <span>Benefício por créditos · ${creditos(o.custo)} · período: ${duracao(meses)}, de ${data(inicio)} a ${data(fim)}. ${detalheInicio}</span></li>
        <li><span class="resgate-rotulo">Depois</span><b>Em ${data(fim)} o benefício termina.</b>
          <span>${
            s.pagandoEmDia
              ? `Seu plano ${esc(s.planoNome || 'pago')} volta com o tempo pago que ainda tinha — nenhum dia pago se perde.`
              : 'A conta fica sem plano. Nada é cobrado automaticamente — você assina quando quiser.'
          }</span></li>
      </ol>
      <ul class="resgate-notas">${renovacao}
        <li>Saldo: <b>${creditos(dados.saldo)}</b> → <b>${creditos(dados.saldo - o.custo)}</b></li>
      </ul>`;
  }

  // Troca de benefício por créditos (crédito → crédito): o aviso vem ANTES
  // do botão de confirmar — plano atual, origem, validade, créditos gastos e
  // a consequência. Sem ele, o clique no card de outro plano nunca encerra
  // nada (confirmação em duas etapas; o servidor exige o id do benefício).
  function htmlAvisoTroca(sub) {
    const gastos =
      sub.creditosGastos != null ? `<li>Créditos utilizados nele: <b>${creditos(sub.creditosGastos)}</b></li>` : '';
    return `<div class="aviso-troca" role="alert">
      <p class="aviso-troca-titulo"><b>Você já possui um benefício ativo.</b></p>
      <ul>
        <li>Plano atual: <b>${esc(sub.nome)}</b> · Benefício por créditos</li>
        <li>Válido até <b>${data(sub.validoAte)}</b></li>
        ${gastos}
      </ul>
      <p>Se você fizer a troca agora, o benefício atual será encerrado e os créditos utilizados <b>não serão devolvidos</b>. O novo benefício consome os créditos dele, uma vez.</p>
    </div>`;
  }

  function abrirResgate(tier, meses) {
    if (!dados) return;
    const sub = dados.resgate.substituicao || null;
    escolha = { tier, meses, ...(sub ? { substituirBeneficioId: sub.id } : {}) };
    const o = dados.opcoes.find((x) => x.tier === tier && x.meses === meses);
    $('tituloResgate').textContent = `${sub ? 'Trocar por' : 'Resgatar'} ${nomeTier(tier)} · ${nomeCiclo(meses)}`;
    $('avisoTrocaBeneficio').innerHTML = sub ? htmlAvisoTroca(sub) : '';
    $('btnConfirmarResgate').textContent = sub
      ? 'Continuar com a troca'
      : o
        ? `Usar ${creditos(o.custo)}`
        : 'Confirmar resgate';
    $('btnCancelarResgate').textContent = sub ? 'Manter plano atual' : 'Cancelar';
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
    msg.textContent = escolha.substituirBeneficioId ? 'Trocando...' : 'Resgatando...';
    msg.className = 'form-msg';
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/creditos/resgatar`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(escolha),
      });
      const corpo = await r.json().catch(() => ({}));
      if (r.status === 409 && corpo.substituicao) {
        // O benefício mudou (outra aba, ou ele passou a existir): mostra o
        // aviso do benefício que está valendo agora e pede de novo.
        dados.resgate.substituicao = corpo.substituicao;
        escolha.substituirBeneficioId = corpo.substituicao.id;
        $('avisoTrocaBeneficio').innerHTML = htmlAvisoTroca(corpo.substituicao);
        $('btnConfirmarResgate').textContent = 'Continuar com a troca';
        $('btnCancelarResgate').textContent = 'Manter plano atual';
        throw new Error('Confira o aviso acima antes de continuar.');
      }
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
      const alvo = e.target.closest('[data-acao="resgatar"]');
      if (alvo) abrirResgate(alvo.dataset.tier, Number(alvo.dataset.meses));
    });
    $('modIndicacao')?.addEventListener('click', (e) => {
      const alvo = e.target.closest('[data-acao="copiar"]');
      if (alvo) copiar(alvo);
    });
    $('btnConfirmarResgate')?.addEventListener('click', confirmarResgate);
    $('btnCancelarResgate')?.addEventListener('click', () => $('dlgResgate').close());
    $('btnFecharResgate')?.addEventListener('click', () => $('dlgResgate').close());
    if (window.ligarEventosDaConta) window.ligarEventosDaConta({ 'credits.updated': carregar });
  };
})();
