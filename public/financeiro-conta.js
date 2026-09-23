// Financeiro — módulo do painel único (Fatia 4, 23/09/2026). Pagamentos (o
// que a conta paga à Mostraí pelo plano) e recebimentos (a ajuda de custo do
// comodato de quem cede a parede) num lugar só; cada bloco aparece quando tem
// assunto, os dois lado a lado quando a conta faz as duas coisas.
//
// Uso: montarFinanceiro(). "Gerenciar plano" abre o #dlgPlano que o painel já
// preenche (painel.page.js#preencherAssinatura). Requer /config.js,
// /layout.js e /eventos.js. Idempotente: cada carga reescreve os blocos.
(function () {
  let dados = null;
  let montado = false;
  let carregando = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.esc(s);
  const data = (iso) => window.dataBR(iso);
  const mesAno = (iso) => window.dataBR(iso, { month: '2-digit', year: 'numeric' });

  const SITUACAO_PLANO = {
    ativa: ['badge-ok', 'Ativa'],
    cortesia: ['badge-neutro', 'Cortesia · sem cobrança'],
    vencida: ['badge-pendente', 'Vencida'],
    suspensa: ['badge-err', 'Suspensa'],
    sem_plano: ['badge-neutro', 'Sem plano'],
  };

  function htmlPagamentos(p) {
    const [classe, rotulo] = SITUACAO_PLANO[p.plano.situacao] || SITUACAO_PLANO.sem_plano;
    const validade = p.plano.validoAte && p.plano.situacao !== 'sem_plano' ? ` · até ${data(p.plano.validoAte)}` : '';
    const lista = p.cobrancas.length
      ? `<ul class="fin-lista">${p.cobrancas
          .map((c) => `<li><time>${data(c.data)}</time><span>Pagamento do plano</span><b>${fmtBRL(c.valor)}</b></li>`)
          .join('')}</ul>`
      : '<p class="texto-vazio">Nenhum pagamento registrado ainda.</p>';
    return `
      <div class="fin-bloco-topo">
        <div><h3 class="fin-titulo">Pagamentos</h3><p class="fin-nota">O que você paga à Mostraí pelo plano.</p></div>
        ${p.plano.situacao !== 'sem_plano' ? '<button type="button" class="btn-link" data-acao="gerenciar-plano">Gerenciar plano</button>' : '<a class="btn primary mini" href="/planos.html">Escolher plano</a>'}
      </div>
      <p class="fin-plano"><b>${esc(p.plano.nome || 'Sem plano')}</b> <span class="badge ${classe}">${esc(rotulo)}</span>${esc(validade)}</p>
      ${lista}`;
  }

  function htmlRecebimentos(r) {
    const linhas = r.linhas.length
      ? `<ul class="fin-lista">${r.linhas
          .map(
            (
              l,
            ) => `<li><time>${esc(mesAno(l.competencia))}</time><span>${esc(l.ponto)}${l.forma ? ` · ${esc(l.forma)}` : ''}</span>
              <b>${fmtBRL(l.valor)} ${l.pagoEm ? `<span class="badge badge-ok">pago em ${esc(data(l.pagoEm))}</span>` : '<span class="badge badge-pendente">em aberto</span>'}</b></li>`,
          )
          .join('')}</ul>`
      : '<p class="texto-vazio">Nenhum pagamento lançado ainda. Assim que o primeiro mês de comodato for fechado, ele aparece aqui.</p>';
    const troca = r.troca
      ? `<div class="fin-troca">
          <p><b>Quer trocar a ajuda de custo por tela?</b> Hoje você recebe <b>${fmtBRL(r.troca.totalMensal)} por mês</b>${r.troca.pontos > 1 ? ` (${r.troca.pontos} pontos)` : ''}.
            Abrindo mão desse valor, você passa a ter o plano Básico, com mais tempo de tela pro seu próprio anúncio, sem pagar nada.</p>
          <p class="fin-nota">A troca é só num sentido: pra voltar a receber, fale com a gente.</p>
          <button type="button" class="btn ghost mini" data-acao="trocar-comodato">Trocar os ${fmtBRL(r.troca.totalMensal)} por tela</button>
          <p class="form-msg" id="msgTrocaComodato" role="status"></p>
        </div>`
      : '';
    return `
      <div class="fin-bloco-topo">
        <div><h3 class="fin-titulo">Recebimentos</h3><p class="fin-nota">A ajuda de custo do comodato, mês a mês.</p></div>
      </div>
      <div class="fin-resumo">
        <div><span>Já recebido</span><b>${esc(r.resumo.totalPagoTexto)}</b><small>${r.resumo.ultimoPagamento ? `último em ${esc(r.resumo.ultimoPagamento)}` : 'nenhum ainda'}</small></div>
        <div><span>Em aberto</span><b>${esc(r.resumo.totalAbertoTexto)}</b><small>lançado e ainda não pago</small></div>
      </div>
      ${linhas}
      ${troca}`;
  }

  function carregar() {
    if (!carregando) {
      carregando = desenhar().finally(() => {
        carregando = null;
      });
    }
    return carregando;
  }

  async function desenhar() {
    const secao = $('modFinanceiro');
    if (!secao) return;
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/financeiro`, { credentials: 'include' });
      if (!r.ok) throw new Error();
      dados = await r.json();
      const { pagamentos, recebimentos } = dados;
      $('finPagamentos').hidden = !pagamentos.mostrar;
      $('finPagamentos').innerHTML = pagamentos.mostrar ? htmlPagamentos(pagamentos) : '';
      $('finRecebimentos').hidden = !recebimentos.mostrar;
      $('finRecebimentos').innerHTML = recebimentos.mostrar ? htmlRecebimentos(recebimentos) : '';
      $('finErro').hidden = true;
      secao.hidden = !pagamentos.mostrar && !recebimentos.mostrar;
    } catch {
      // Valor desconhecido nunca vira "R$ 0,00": diz que não carregou.
      $('finPagamentos').hidden = true;
      $('finRecebimentos').hidden = true;
      $('finErro').hidden = false;
      secao.hidden = false;
    }
  }

  async function trocarComodato(botao) {
    const t = dados?.recebimentos.troca;
    if (!t) return;
    if (
      !window.confirm(
        `Você deixa de receber ${fmtBRL(t.totalMensal)} por mês e passa a ter o plano Básico, de graça. Pra voltar a receber, vai precisar falar com a gente. Confirmar?`,
      )
    )
      return;
    const msg = $('msgTrocaComodato');
    botao.disabled = true;
    msg.textContent = 'Trocando...';
    msg.className = 'form-msg';
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/comodato/trocar-por-tela`, {
        method: 'POST',
        credentials: 'include',
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(corpo.erro || 'Não deu pra trocar agora.');
      // O servidor emite finance/point/plan.updated: este bloco e o resto do
      // painel se refazem sozinhos; a carga aqui é pra esta aba não esperar.
      await carregar();
    } catch (err) {
      msg.textContent = window.frase ? window.frase(err.message) : err.message;
      msg.className = 'form-msg err';
      botao.disabled = false;
    }
  }

  window.montarFinanceiro = function montarFinanceiro() {
    carregar();
    if (montado) return;
    montado = true;
    $('modFinanceiro')?.addEventListener('click', (ev) => {
      const alvo = ev.target.closest('[data-acao]');
      if (!alvo) return;
      if (alvo.dataset.acao === 'gerenciar-plano') $('dlgPlano')?.showModal();
      if (alvo.dataset.acao === 'trocar-comodato') trocarComodato(alvo);
    });
    if (window.ligarEventosDaConta) {
      window.ligarEventosDaConta({
        'payment.updated': carregar,
        'finance.updated': carregar,
        'plan.updated': carregar,
        'credits.updated': carregar,
      });
    }
  };
})();
