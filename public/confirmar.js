// Confirmação Mostraí no painel do cliente (finalização, 28/09/2026): o
// mesmo ciclo do admin (confirmarModal em admin/index.page.js), sem
// confirm()/alert() nativo em fluxo que mexe com conta, plano, criativo ou
// dinheiro. <dialog> com showModal(): fundo, ESC e foco preso vêm do
// navegador — mesma escolha de #dlgPerfil e #dlgPlano. Visual reaproveita
// .dlg-head, .dlg-acoes, .btn e .form-msg do style.css.
//
//   confirmarMostrai({ titulo, texto, botao, perigo, aoConfirmar })
//
// Ciclo: TÍTULO → CONSEQUÊNCIA (texto) → Cancelar / Confirmar → loading
// (botões travados, "Enviando…") → `aoConfirmar()` → sucesso fecha e resolve
// true; erro (throw ou retorno { erro }) fica escrito DENTRO do modal, com o
// botão liberado pra tentar de novo. Cancelar/ESC/fundo resolve false.
// Sem `aoConfirmar` é só uma pergunta: resolve true/false e quem chamou faz
// o pedido — pra ação sem requisição (sair da conta) não precisa de loading.
// `conteudo` (HTML montado por quem chama, já escapado) entra depois do texto
// — um formulário pequeno, como o "Revisar e reenviar" do criativo; `aoAbrir`
// e `aoConfirmar` recebem o <dialog> pra ligar e ler esse formulário.
(() => {
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

  window.confirmarMostrai = function confirmarMostrai({
    titulo,
    texto,
    botao = 'Confirmar',
    cancelar = 'Cancelar',
    perigo = false,
    conteudo = '',
    aoAbrir = null,
    aoConfirmar = null,
  }) {
    return new Promise((resolve) => {
      let resultado = false;
      let enviando = false;
      const dlg = document.createElement('dialog');
      dlg.className = 'dlg-confirmar';
      dlg.setAttribute('aria-labelledby', 'dlgConfirmarTitulo');
      dlg.innerHTML = `
        <div class="dlg-head"><h3 id="dlgConfirmarTitulo">${esc(titulo)}</h3>
          <button type="button" class="dlg-close" data-fechar aria-label="Fechar">&times;</button></div>
        <p class="dlg-confirmar-texto">${esc(texto)}</p>
        ${conteudo}
        <p class="form-msg" data-msg role="alert"></p>
        <div class="dlg-acoes">
          <button type="button" class="btn ghost" data-fechar>${esc(cancelar)}</button>
          <button type="button" class="btn ${perigo ? 'perigo' : 'primary'}" data-confirmar>${esc(botao)}</button>
        </div>`;
      document.body.appendChild(dlg);
      const btnOk = dlg.querySelector('[data-confirmar]');
      const msg = dlg.querySelector('[data-msg]');
      const fechar = () => {
        if (dlg.open) dlg.close();
      };
      // Enquanto o pedido está em voo, nada fecha: nem ESC, nem o fundo —
      // fechar no meio deixaria o clique sem resposta na tela.
      dlg.addEventListener('cancel', (e) => {
        if (enviando) e.preventDefault();
      });
      dlg.addEventListener('mousedown', (e) => {
        if (e.target === dlg && !enviando) fechar();
      });
      for (const b of dlg.querySelectorAll('[data-fechar]')) {
        b.addEventListener('click', () => {
          if (!enviando) fechar();
        });
      }
      dlg.addEventListener('close', () => {
        dlg.remove();
        resolve(resultado);
      });
      btnOk.addEventListener('click', async () => {
        if (enviando) return;
        if (!aoConfirmar) {
          resultado = true;
          return fechar();
        }
        enviando = true;
        const rotulo = btnOk.textContent;
        btnOk.textContent = 'Enviando…';
        for (const b of dlg.querySelectorAll('button')) b.disabled = true;
        msg.textContent = '';
        msg.className = 'form-msg';
        try {
          const r = await aoConfirmar(dlg);
          if (r && typeof r === 'object' && r.erro) throw new Error(r.erro);
          resultado = true;
          enviando = false;
          fechar();
        } catch (e) {
          enviando = false;
          btnOk.textContent = rotulo;
          for (const b of dlg.querySelectorAll('button')) b.disabled = false;
          msg.textContent = window.frase
            ? window.frase(e?.message || 'Não deu certo agora. Tente de novo.')
            : e?.message;
          msg.className = 'form-msg err';
        }
      });
      dlg.showModal();
      btnOk.focus();
      aoAbrir?.(dlg);
    });
  };
})();
