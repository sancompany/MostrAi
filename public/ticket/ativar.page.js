// Trimundi — ativação do operador de check-in (T6, /ticket/ativar): e-mail,
// código de ativação e senha nova. Depois, o login é pela tela da Mostraí.
(() => {
  const { api, enviando } = window.trimundi;
  const form = document.getElementById('formAtivar');
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
