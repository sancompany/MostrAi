const form = document.getElementById('formCadastro');
const msg = document.getElementById('msg');

// Quem veio de "Assinar X" na vitrine e já tem conta troca de tela pelo
// "Entrar" do cabeçalho — sem o ?plano= ele perderia o plano escolhido no
// caminho (o login sabe continuar pra confirmação quando o recebe).
(function levarPlanoProLogin() {
  const plano = new URLSearchParams(window.location.search).get('plano');
  const entrar = document.querySelector('header.site nav a[href="/anunciante/login.html"]');
  if (plano && entrar) entrar.href = `/anunciante/login.html?plano=${encodeURIComponent(plano)}`;
})();
// Trava o botão enquanto a conta é criada: dois toques seguidos no celular
// mandavam dois cadastros, e o segundo voltava "e-mail já cadastrado" pra
// quem acabou de criar a conta.
const botaoCriar = form.querySelector('[type="submit"]');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Enviando...';
  msg.className = 'form-msg';
  botaoCriar.disabled = true;
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
    let r = await fetch(`${API_BASE_URL}/anunciantes/cadastro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
    });
    // O cupom de indicação não é campo do formulário: vem no ?ref do link que
    // o vendedor compartilha. Se ele não vale mais (vendedor saiu, link velho,
    // letra trocada), o servidor recusa — e não haveria como a pessoa apagar o
    // cupom pra tentar de novo, porque não existe campo. Então a tela avisa e
    // recomeça sem o cupom: cadastro travado por um link de terceiro seria um
    // beco sem saída pior do que o silêncio de antes.
    if (!r.ok && ref) {
      const corpoRef = await r
        .clone()
        .json()
        .catch(() => ({}));
      if (corpoRef.campo === 'indicado_por_cupom') {
        delete dados.indicado_por_cupom;
        msg.textContent = 'O cupom de indicação desse link não está mais ativo, seguimos sem ele.';
        msg.className = 'form-msg';
        r = await fetch(`${API_BASE_URL}/anunciantes/cadastro`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dados),
        });
      }
    }
    if (r.status === 409) {
      msg.textContent = 'Esse e-mail já tem cadastro. Tente entrar.';
      msg.className = 'form-msg err';
      botaoCriar.disabled = false;
      return;
    }
    if (!r.ok) {
      // O servidor diz QUAL campo está errado (cpf_cnpj, cep, telefone, senha)
      // e devolve 429 com Retry-After quando é excesso de tentativa. Tudo isso
      // virava a mesma frase genérica, que mandava a pessoa "tentar de novo"
      // justamente quando tentar de novo era o problema.
      const corpo = await r.json().catch(() => ({}));
      msg.textContent =
        r.status === 429
          ? 'Muitas tentativas seguidas. Espere um minuto e tente de novo.'
          : corpo.erro
            ? window.frase(corpo.erro)
            : 'Não foi possível criar a conta agora. Tente novamente.';
      msg.className = 'form-msg err';
      const campo = corpo.campo && form.elements[corpo.campo];
      if (campo) {
        // Campo do bloco recolhido (Responsável): abre antes de focar, senão
        // o foco não acontece e a pessoa não vê qual campo o servidor recusou.
        const recolhido = campo.closest('details');
        if (recolhido) recolhido.open = true;
        campo.classList.add('campo-err');
        campo.focus();
      }
      botaoCriar.disabled = false;
      return;
    }
    msg.textContent = 'Conta criada!';
    msg.className = 'form-msg ok';
    // Cadastro já loga a sessão (ver POST /anunciantes/cadastro) — direto
    // pro painel, sem passar pela tela de login de novo.
    const plano = new URLSearchParams(window.location.search).get('plano');
    window.location.href = plano ? `/anunciante/confirmar-plano.html?plano=${plano}` : '/anunciante/painel.html';
  } catch {
    msg.textContent = 'Não foi possível criar a conta agora. Tente novamente.';
    msg.className = 'form-msg err';
    botaoCriar.disabled = false;
  }
});
