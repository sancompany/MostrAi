const form = document.getElementById('formVendedor');
const msg = document.getElementById('msg');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Enviando...';
  msg.className = 'form-msg';
  const dados = {
    tipo: 'vendedor',
    nome: form.nome.value.trim(),
    contato_telefone: form.contato_telefone.value.trim(),
    contato_email: form.contato_email.value.trim() || null,
    cidade: form.cidade.value.trim(),
    mensagem: form.mensagem.value.trim() || null,
  };
  try {
    const r = await fetch(`${API_BASE_URL}/candidaturas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corpo.erro || 'falha');
    document.getElementById('enviadoTel').textContent = dados.contato_telefone;
    form.hidden = true;
    document.getElementById('enviado').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    msg.textContent =
      err.message === 'falha' ? 'Não foi possível enviar agora. Tente novamente em instantes.' : err.message;
    msg.className = 'form-msg err';
  }
});
