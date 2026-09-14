const form = document.getElementById('formLogin');
const msg = document.getElementById('msg');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Entrando...';
  msg.className = 'form-msg';
  const dados = Object.fromEntries(new FormData(form));
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
    });
    if (!r.ok) {
      msg.textContent = 'E-mail ou senha inválidos.';
      msg.className = 'form-msg err';
      return;
    }
    const plano = new URLSearchParams(window.location.search).get('plano');
    window.location.href = plano ? `/anunciante/painel.html?plano=${plano}` : '/anunciante/painel.html';
  } catch {
    msg.textContent = 'Não foi possível entrar agora. Tente novamente.';
    msg.className = 'form-msg err';
  }
});
