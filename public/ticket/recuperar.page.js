// Trimundi — recuperar o link do pedido (/ticket/recuperar). A resposta é a
// mesma exista ou não pedido (não revela quem comprou); o link vai só para o
// e-mail de quem comprou, nunca aparece na tela.
(() => {
  const { api, mascaraCpf, cpfValido, enviando } = window.trimundi;
  const form = document.getElementById('formRecuperar');
  const msg = document.getElementById('msg');
  const botao = form.querySelector('[type="submit"]');
  mascaraCpf(form.elements.cpf);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.className = 'mensagem';
    msg.textContent = '';
    const email = form.elements.email.value.trim();
    const cpf = form.elements.cpf.value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      msg.className = 'mensagem erro';
      msg.textContent = 'Informe um e-mail válido.';
      return form.elements.email.focus();
    }
    if (!cpfValido(cpf)) {
      msg.className = 'mensagem erro';
      msg.textContent = 'CPF inválido — confira os números.';
      return form.elements.cpf.focus();
    }
    try {
      const r = await enviando(botao, 'Enviando...', () =>
        api('/ticket/api/recuperar', { metodo: 'POST', corpo: { email, cpf } }),
      );
      msg.className = 'mensagem ok';
      msg.textContent = r.mensagem;
    } catch (err) {
      msg.className = 'mensagem erro';
      msg.textContent = err.message;
    }
  });
})();
