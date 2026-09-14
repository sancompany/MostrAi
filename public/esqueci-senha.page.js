// v2: uma conta só (anunciante, ponto e vendedor no mesmo login) — o
// ?tipo=afiliado dos links antigos cai no mesmo fluxo.
document.getElementById('voltarLogin').href = '/anunciante/login.html';

const form = document.getElementById('formEsqueci');
const msg = document.getElementById('msg');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Enviando...';
  msg.className = 'form-msg';
  try {
    await fetch(`${API_BASE_URL}/anunciantes/esqueci-senha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('email').value }),
    });
    // Resposta é sempre a mesma, com ou sem conta nesse e-mail.
    msg.textContent = 'Se existir uma conta com esse e-mail, o link já está a caminho. Confira também o spam.';
    msg.className = 'form-msg ok';
    form.reset();
  } catch {
    msg.textContent = 'Não foi possível enviar agora. Tente novamente em instantes.';
    msg.className = 'form-msg err';
  }
});
