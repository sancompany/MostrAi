const form = document.getElementById('formContato');
const msg = document.getElementById('msg');
// O botão trava enquanto envia: no celular, com rede lenta, o segundo toque
// no "Enviar" (sem nenhum sinal de que o primeiro pegou) gravava a mesma
// mensagem duas vezes.
const botaoEnviar = form.querySelector('[type="submit"]');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Enviando...';
  msg.className = 'form-msg';
  botaoEnviar.disabled = true;
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
  } finally {
    botaoEnviar.disabled = false;
  }
});
