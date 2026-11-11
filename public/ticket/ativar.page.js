// Trimundi — ativação do operador de check-in (T6, /ticket/ativar): e-mail,
// código de ativação e senha nova. Depois, o login é em /ticket/entrar.
(() => {
  const { api, enviando, comOlho } = window.trimundi;
  const form = document.getElementById('formAtivar');
  // Olho dentro de cada campo de senha (mostrar/ocultar), o mesmo da conta
  // do cliente: só troca o tipo do campo, não envia o formulário.
  for (const campo of form.querySelectorAll('input[type="password"]')) {
    const pai = campo.parentNode;
    const depois = campo.nextSibling;
    pai.insertBefore(comOlho(campo), depois);
  }
  const msg = document.getElementById('msg');
  const botao = form.querySelector('[type="submit"]');

  form.elements.codigo.addEventListener('input', (e) => {
    const s = e.target.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    e.target.value = s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.className = 'mensagem';
    msg.textContent = '';
    const { email, codigo, senha, senha2 } = Object.fromEntries(new FormData(form));
    if (senha !== senha2) {
      msg.className = 'mensagem erro';
      msg.textContent = 'As duas senhas não são iguais.';
      return form.elements.senha2.focus();
    }
    try {
      await enviando(botao, 'Ativando...', () =>
        api('/ticket/api/ativar', { metodo: 'POST', corpo: { email: email.trim(), codigo, senha } }),
      );
      document.getElementById('painelForm').classList.add('oculto');
      document.getElementById('painelOk').classList.remove('oculto');
      document.querySelector('#painelOk a').focus();
    } catch (err) {
      msg.className = 'mensagem erro';
      msg.textContent = err.message;
    }
  });
})();
