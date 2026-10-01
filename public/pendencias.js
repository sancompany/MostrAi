// Pendências da conta no topo do painel (estação de endereços, 01/10/2026):
// "1 pendência precisa da sua atenção", com o botão que leva direto à
// correção. Quem decide o que é pendência é o servidor
// (GET /anunciantes/me/pendencias, src/pendencias/); aqui só se mostra, na
// mesma lista de alertas do painel (public/painel-resumo.js). O aviso no sino
// sai do servidor, uma vez só, quando a pendência nasce.
//
// Uso: montarPendencias() depois de montar Meus pontos e o perfil (os
// destinos dos botões moram lá). Requer /config.js, /eventos.js e
// /painel-resumo.js antes.
(function () {
  // `cta_destino` do servidor → o que o botão abre. Destino desconhecido não
  // ganha botão (a pendência aparece, só sem atalho).
  const DESTINOS = {
    'endereco-conta': () => window.abrirPerfilNoEndereco?.(),
    'endereco-ponto': (id) => window.editarEnderecoDoEstabelecimento?.('ponto', id),
    'endereco-candidatura': (id) => window.editarEnderecoDoEstabelecimento?.('candidatura', id),
  };
  const acaoDo = (destino) => {
    const [nome, id] = String(destino || '').split(':');
    const abrir = DESTINOS[nome];
    return abrir ? () => abrir(id) : null;
  };

  let carregando = null;
  let deNovo = false;
  async function buscar() {
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/pendencias`, { credentials: 'include' });
      // Falha aqui nunca derruba o painel: a lista fica como estava e a
      // próxima carga tenta de novo.
      if (!r.ok) return;
      const { pendencias } = await r.json();
      window.publicarResumo?.('pendencias', {
        alertas: pendencias.map((p) => {
          const acao = acaoDo(p.cta_destino);
          return {
            pendencia: true,
            nivel: p.severidade === 'informativa' ? 'info' : 'atencao',
            titulo: p.titulo,
            texto: p.mensagem,
            cta: acao && p.cta_rotulo ? { rotulo: p.cta_rotulo, acao } : null,
          };
        }),
      });
    } catch {
      /* sem rede: segue o que estava na tela */
    }
  }
  // Uma carga por vez; aviso que chega DURANTE uma carga vale uma (e só
  // uma) carga a mais no fim — ela pode ter lido antes da mudança.
  function carregar() {
    if (carregando) {
      deNovo = true;
      return carregando;
    }
    carregando = buscar().finally(() => {
      carregando = null;
      if (deNovo) {
        deNovo = false;
        carregar();
      }
    });
    return carregando;
  }
  window.recarregarPendencias = carregar;

  let montado = false;
  window.montarPendencias = function montarPendencias() {
    carregar();
    if (montado) return;
    montado = true;
    window.ligarEventosDaConta?.({
      'pendencia.updated': carregar,
      'account.updated': carregar,
      'point.updated': carregar,
      'application.updated': carregar,
    });
  };
})();
