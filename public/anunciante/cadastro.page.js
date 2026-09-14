const form = document.getElementById('formCadastro');
const msg = document.getElementById('msg');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Enviando...';
  msg.className = 'form-msg';
  const dados = Object.fromEntries(new FormData(form));
  dados.aceitou_termos = form.aceitou_termos.checked;
  // O número é campo separado só pra facilitar o preenchimento por CEP —
  // no banco o endereço continua sendo uma linha só.
  dados.endereco = `${dados.endereco}, ${dados.numero}`;
  delete dados.numero;
  const ref = new URLSearchParams(window.location.search).get('ref');
  if (ref) dados.indicado_por_cupom = ref;
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/cadastro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
    });
    if (r.status === 409) {
      msg.textContent = 'Esse e-mail já tem cadastro. Tente entrar.';
      msg.className = 'form-msg err';
      return;
    }
    if (!r.ok) throw new Error();
    msg.textContent = 'Conta criada!';
    msg.className = 'form-msg ok';
    // Cadastro já loga a sessão (ver POST /anunciantes/cadastro) — direto
    // pro painel, sem passar pela tela de login de novo.
    const plano = new URLSearchParams(window.location.search).get('plano');
    window.location.href = plano ? `/anunciante/painel.html?plano=${plano}` : '/anunciante/painel.html';
  } catch {
    msg.textContent = 'Não foi possível criar a conta agora. Tente novamente.';
    msg.className = 'form-msg err';
  }
});
