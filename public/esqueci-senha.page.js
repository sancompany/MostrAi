// v2: uma conta só (anunciante, ponto e vendedor no mesmo login) — o
// ?tipo=afiliado dos links antigos cai no mesmo fluxo.
document.getElementById('voltarLogin').href = '/anunciante/login.html';

const form = document.getElementById('formEsqueci');
const msg = document.getElementById('msg');
const botaoEnviar = form.querySelector('[type="submit"]');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Enviando...';
  msg.className = 'form-msg';
  botaoEnviar.disabled = true;
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/esqueci-senha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('email').value }),
    });
    // 429: teto de pedidos (src/lib/limite-tentativas.js) — por este endereço
    // de rede, ou por este e-mail (`motivo: 'conta'`), com conta ou sem. Antes
    // a tela dizia "o link está a caminho" mesmo quando nada tinha saído.
    if (r.status === 429) {
      const corpo = await r.json().catch(() => ({}));
      msg.textContent =
        corpo.motivo === 'conta'
          ? 'Já pedimos vários links para este e-mail nos últimos minutos. Se existir uma conta com ele, use o link mais recente (vale 1 hora) e confira também o spam.'
          : window.frase(corpo.erro || 'muitas tentativas seguidas — espere e tente de novo');
      msg.className = 'form-msg err';
      return;
    }
    // Resposta é sempre a mesma, com ou sem conta nesse e-mail.
    msg.textContent = 'Se existir uma conta com esse e-mail, o link já está a caminho. Confira também o spam.';
    msg.className = 'form-msg ok';
    form.reset();
  } catch {
    msg.textContent = 'Não foi possível enviar agora. Tente novamente em instantes.';
    msg.className = 'form-msg err';
  } finally {
    botaoEnviar.disabled = false;
  }
});
