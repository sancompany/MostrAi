const token = new URLSearchParams(location.search).get('token');
const form = document.getElementById('formSenha');
const msg = document.getElementById('msg');

if (!token) {
  msg.textContent = 'Link inválido. Peça um novo em "Esqueci minha senha".';
  msg.className = 'form-msg err';
  form.querySelector('button').disabled = true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Salvando...';
  msg.className = 'form-msg';
  try {
    const r = await fetch(`${API_BASE_URL}/redefinir-senha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, senha: document.getElementById('senha').value }),
    });
    const corpo = await r.json();
    if (!r.ok) {
      msg.textContent = corpo.erro || 'Não foi possível salvar.';
      msg.className = 'form-msg err';
      return;
    }
    msg.textContent = 'Senha alterada! Redirecionando pro login...';
    msg.className = 'form-msg ok';
    setTimeout(() => {
      window.location.href = corpo.login;
    }, 1200);
  } catch {
    msg.textContent = 'Não foi possível salvar agora. Tente novamente.';
    msg.className = 'form-msg err';
  }
});
