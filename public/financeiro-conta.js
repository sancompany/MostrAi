// Financeiro — módulo do painel único (Fatia 4, 23/09/2026): os pagamentos
// (o que a conta paga à Mostraí pelo plano). "Recebimentos" saiu em
// 24/09/2026 (ADR-016): ser ponto não recebe dinheiro, gera créditos — que
// aparecem em "Créditos e benefícios".
//
// Uso: montarFinanceiro(). As ações do plano (escolher, gerenciar) moram no
// card "Plano comercial" do painel — aqui só o histórico. Requer /config.js,
// /layout.js e /eventos.js. Idempotente: cada carga reescreve os blocos.
(function () {
  let dados = null;
  let montado = false;
  let carregando = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.esc(s);
  const data = (iso) => window.dataBR(iso);

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
      </div>
      <p class="fin-plano"><b>${esc(p.plano.nome || 'Sem plano')}</b> <span class="badge ${classe}">${esc(rotulo)}</span>${esc(validade)}</p>
      ${lista}`;
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
      const { pagamentos } = dados;
      $('finPagamentos').hidden = !pagamentos.mostrar;
      $('finPagamentos').innerHTML = pagamentos.mostrar ? htmlPagamentos(pagamentos) : '';
      $('finErro').hidden = true;
      secao.hidden = !pagamentos.mostrar;
    } catch {
      // Valor desconhecido nunca vira "R$ 0,00": diz que não carregou.
      $('finPagamentos').hidden = true;
      $('finErro').hidden = false;
      secao.hidden = false;
    }
  }

  window.montarFinanceiro = function montarFinanceiro() {
    carregar();
    if (montado) return;
    montado = true;
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
