const form = document.getElementById('formLogin');
const msg = document.getElementById('msg');

// O "Criar conta" do cabeçalho leva o plano escolhido junto (mesmo motivo do
// "Entrar" no cadastro): o cadastro já continua pra confirmação com ele.
(function levarPlanoProCadastro() {
  const plano = new URLSearchParams(window.location.search).get('plano');
  const criar = document.querySelector('header.site nav a[href="/anunciante/cadastro.html"]');
  if (plano && criar) criar.href = `/anunciante/cadastro.html?plano=${encodeURIComponent(plano)}`;
})();
// Veio do painel porque a sessão acabou de verdade (401 — layout.js,
// `sessaoExpirada`): diz isso, em vez de a pessoa cair no login sem saber
// por quê. Esta página não pergunta pela conta, então não volta sozinha.
if (new URLSearchParams(window.location.search).get('expirou') === '1') {
  msg.textContent = 'Sua sessão expirou. Entre de novo pra continuar.';
}
// Trava o botão enquanto o login responde (o hash de senha leva um tempo
// de propósito); destrava em qualquer desfecho que não seja entrar.
const botaoEntrar = form.querySelector('[type="submit"]');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Entrando...';
  msg.className = 'form-msg';
  const dados = Object.fromEntries(new FormData(form));
  botaoEntrar.disabled = true;
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
    });
    if (!r.ok) {
      // O servidor distingue senha errada (401) de conta excluída (403), e a
      // tela jogava as duas na mesma frase: quem teve a conta excluída ficava
      // tentando a senha pra sempre, porque o site dizia que ela estava errada.
      // A mensagem do 403 só sai DEPOIS de a senha conferir (routes.js:167),
      // então mostrá-la não entrega a existência de conta nenhuma.
      const corpo = await r.json().catch(() => ({}));
      // 429: o servidor diz quanto falta. `motivo: 'conta'` é o balde da
      // CONTA (src/lib/limite-tentativas.js): alguém errou a senha dela 10
      // vezes, e esperar pode não bastar se continuar errando. Redefinir a
      // senha zera esse balde e marca este navegador.
      if (r.status === 429) {
        msg.textContent = window.frase(corpo.erro || 'muitas tentativas seguidas — espere e tente de novo');
        if (corpo.motivo === 'conta') {
          msg.textContent += ' Se a conta é sua, redefinir a senha em "Esqueci minha senha" libera a entrada.';
        }
      } else if (r.status === 403 && corpo.erro) msg.textContent = window.frase(corpo.erro);
      else msg.textContent = 'E-mail ou senha inválidos.';
      msg.className = 'form-msg err';
      botaoEntrar.disabled = false;
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const plano = params.get('plano');
    // `voltar`: só uma página deste site (caminho relativo .html, nunca
    // outro domínio nem "//"): sem redirecionamento aberto.
    const voltar = params.get('voltar');
    const destinoSeguro = voltar && /^\/(?!\/)[a-z0-9/_.-]*\.html$/i.test(voltar) ? voltar : null;
    window.location.href = plano
      ? `/anunciante/confirmar-plano.html?plano=${plano}`
      : destinoSeguro || '/anunciante/painel.html';
  } catch {
    msg.textContent = 'Não foi possível entrar agora. Tente novamente.';
    msg.className = 'form-msg err';
    botaoEntrar.disabled = false;
  }
});
