// Trimundi — login do operador de check-in (/ticket/entrar). Login próprio
// da Trimundi; o destino vem do servidor e só pode ser um caminho /ticket/.
(() => {
  const { api, enviando } = window.trimundi;
  const form = document.getElementById('formEntrar');
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
