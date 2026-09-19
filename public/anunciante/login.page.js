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
      // O servidor distingue senha errada (401) de conta excluída (403), e a
      // tela jogava as duas na mesma frase: quem teve a conta excluída ficava
      // tentando a senha pra sempre, porque o site dizia que ela estava errada.
      // A mensagem do 403 só sai DEPOIS de a senha conferir (routes.js:167),
      // então mostrá-la não entrega a existência de conta nenhuma.
      const corpo = await r.json().catch(() => ({}));
      if (r.status === 429) msg.textContent = 'Muitas tentativas seguidas. Espere um minuto e tente de novo.';
      else if (r.status === 403 && corpo.erro) msg.textContent = window.frase(corpo.erro);
      else msg.textContent = 'E-mail ou senha inválidos.';
      msg.className = 'form-msg err';
      return;
    }
    const plano = new URLSearchParams(window.location.search).get('plano');
    window.location.href = plano ? `/anunciante/confirmar-plano.html?plano=${plano}` : '/anunciante/painel.html';
  } catch {
    msg.textContent = 'Não foi possível entrar agora. Tente novamente.';
    msg.className = 'form-msg err';
  }
});
