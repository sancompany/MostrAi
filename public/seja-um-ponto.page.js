// Candidatura, não cadastro: aqui ninguém cria conta. O dono recebe o
// pedido no painel, conversa, e gera um convite (link) — a conta nasce lá.
const form = document.getElementById('formPonto');
const msg = document.getElementById('msg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Enviando...';
  msg.className = 'form-msg';
  const opcao = form.categoria_id.options[form.categoria_id.selectedIndex];
  const usouLivre = !document.querySelector('[data-categoria-livre]').hidden;
  const dados = {
    tipo: 'ponto',
    nome: form.nome.value.trim(),
    nome_comercio: form.nome_comercio.value.trim(),
    contato_telefone: form.contato_telefone.value.trim(),
    contato_email: form.contato_email.value.trim() || null,
    endereco: `${form.endereco.value.trim()}, ${form.numero.value.trim()}`,
    cidade: form.cidade.value.trim(),
    uf: form.uf.value.trim().toUpperCase(),
    cep: form.cep.value.trim(),
    segmento: usouLivre ? form.categoria_livre.value.trim() : (opcao ? opcao.dataset.nome : ''),
    fluxo_estimado_mensal: form.fluxo_estimado_mensal.value || null,
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
    msg.textContent = err.message === 'falha' ? 'Não foi possível enviar agora. Tente novamente em instantes.' : err.message;
    msg.className = 'form-msg err';
  }
});
