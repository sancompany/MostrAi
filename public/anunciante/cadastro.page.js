const form = document.getElementById('formCadastro');
const msg = document.getElementById('msg');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Enviando...';
  msg.className = 'form-msg';
  form.querySelectorAll('.campo-err').forEach((c) => c.classList.remove('campo-err'));
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
    if (!r.ok) {
      // O servidor diz QUAL campo está errado (cpf_cnpj, cep, telefone, senha)
      // e devolve 429 com Retry-After quando é excesso de tentativa. Tudo isso
      // virava a mesma frase genérica, que mandava a pessoa "tentar de novo"
      // justamente quando tentar de novo era o problema.
      const corpo = await r.json().catch(() => ({}));
      msg.textContent = r.status === 429
        ? 'Muitas tentativas seguidas. Espere um minuto e tente de novo.'
        : (corpo.erro ? window.frase(corpo.erro) : 'Não foi possível criar a conta agora. Tente novamente.');
      msg.className = 'form-msg err';
      const campo = corpo.campo && form.elements[corpo.campo];
      if (campo) { campo.classList.add('campo-err'); campo.focus(); }
      return;
    }
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
