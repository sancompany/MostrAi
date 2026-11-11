// Trimundi — login do operador de check-in (/ticket/entrar). Login próprio
// da Trimundi; o destino vem do servidor e só pode ser um caminho /ticket/.
(() => {
  const { api, enviando, comOlho } = window.trimundi;
  const form = document.getElementById('formEntrar');
  // Olho dentro de cada campo de senha (mostrar/ocultar), o mesmo da conta
  // do cliente: só troca o tipo do campo, não envia o formulário.
  for (const campo of form.querySelectorAll('input[type="password"]')) {
    const pai = campo.parentNode;
    const depois = campo.nextSibling;
    pai.insertBefore(comOlho(campo), depois);
  }
  const msg = document.getElementById('msg');
  const botao = form.querySelector('[type="submit"]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.className = 'mensagem';
    msg.textContent = '';
    const email = form.elements.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      msg.className = 'mensagem erro';
      msg.textContent = 'Informe um e-mail válido.';
      return form.elements.email.focus();
    }
    try {
      const r = await enviando(botao, 'Entrando...', () =>
        api('/ticket/api/operador/entrar', { metodo: 'POST', corpo: { email, senha: form.elements.senha.value } }),
      );
      window.location.assign(/^\/ticket\/[a-z0-9/_-]*$/.test(r.destino || '') ? r.destino : '/ticket/checkin');
    } catch (err) {
      msg.className = 'mensagem erro';
      msg.textContent = err.message;
    }
  });
})();
