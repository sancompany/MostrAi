const form = document.getElementById('formContato');
const msg = document.getElementById('msg');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Enviando...';
  msg.className = 'form-msg';
  try {
    const r = await fetch(`${API_BASE_URL}/contato`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    if (!r.ok) throw new Error();
    msg.textContent = 'Mensagem enviada! A gente responde no e-mail informado.';
    msg.className = 'form-msg ok';
    form.reset();
  } catch {
    msg.textContent = 'Não foi possível enviar agora. Chame no WhatsApp que a gente resolve na hora.';
    msg.className = 'form-msg err';
  }
});
