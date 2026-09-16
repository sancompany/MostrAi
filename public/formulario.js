// Peças compartilhadas pelos 3 cadastros (anunciante, vendedor e ponto):
// CEP que preenche o endereço sozinho e o select de categoria vindo do banco.
// Sem dependência externa — ViaCEP é público e o resto é DOM puro.

// data-cep no input do CEP; os campos preenchidos são procurados pelo name
// dentro do mesmo formulário (endereco/cidade/uf/bairro).
function ligarCep(escopo) {
  (escopo || document).querySelectorAll('[data-cep]').forEach((input) => {
    const form = input.closest('form') || document;
    const achar = (nome) => form.querySelector(`[name="${nome}"]`);

    input.addEventListener('input', () => {
      const so = input.value.replace(/\D/g, '').slice(0, 8);
      input.value = so.length > 5 ? `${so.slice(0, 5)}-${so.slice(5)}` : so;
    });

    input.addEventListener('blur', async () => {
      const cep = input.value.replace(/\D/g, '');
      const aviso = form.querySelector('[data-cep-msg]');
      if (cep.length !== 8) return;
      if (aviso) {
        aviso.textContent = 'Buscando endereço...';
        aviso.className = 'form-hint';
      }
      try {
        const dados = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
        if (dados.erro) throw new Error();
        const rua = achar('endereco');
        // Deixa o número pro cliente digitar — é o único pedaço que o CEP não sabe.
        if (rua) rua.value = `${dados.logradouro}${dados.bairro ? `, ${dados.bairro}` : ''}`;
        if (achar('cidade')) achar('cidade').value = dados.localidade;
        if (achar('uf')) achar('uf').value = dados.uf;
        if (aviso) aviso.textContent = 'Confira e complete com o número.';
        const numero = achar('numero');
        if (numero) numero.focus();
      } catch {
        if (aviso) {
          aviso.textContent = 'CEP não encontrado, pode preencher o endereço na mão.';
          aviso.className = 'form-hint';
        }
      }
    });
  });
}

// data-categorias num <select> — popula com o catálogo do admin e mostra o
// campo livre (data-categoria-livre) quando a escolha for "Outro".
async function ligarCategorias(escopo) {
  const selects = (escopo || document).querySelectorAll('[data-categorias]');
  if (!selects.length) return;
  let categorias = [];
  try {
    const r = await fetch(`${API_BASE_URL}/categorias`);
    categorias = await r.json();
    // Erro do servidor também vem como JSON válido ({erro:...}) — sem essa
    // checagem o .map() estouraria fora do try e o select ficaria vazio e
    // obrigatório, travando o cadastro sem dizer por quê.
    if (!r.ok || !Array.isArray(categorias)) throw new Error('resposta inesperada');
  } catch {
    // Sem a lista, o select ficaria vazio e obrigatório — o navegador
    // bloquearia o envio sem dizer por quê e o cadastro morreria aí. Melhor
    // liberar o campo e perguntar o ramo depois, por WhatsApp.
    selects.forEach((sel) => {
      sel.required = false;
      sel.innerHTML = '<option value="">(a gente confirma seu ramo no contato)</option>';
    });
    return;
  }

  selects.forEach((sel) => {
    sel.innerHTML =
      '<option value="">Selecione...</option>' +
      categorias.map((c) => `<option value="${c.id}" data-nome="${c.nome}">${c.nome}</option>`).join('');
    const form = sel.closest('form') || document;
    const livre = form.querySelector('[data-categoria-livre]');
    if (!livre) return;
    const alternar = () => {
      const nome = sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].dataset.nome;
      const outro = nome === 'Outro';
      livre.hidden = !outro;
      livre.querySelector('input').required = outro;
    };
    sel.addEventListener('change', alternar);
    alternar();
  });
}

// Confirmação de senha: data-senha e data-senha-confirma no mesmo formulário.
function ligarConfirmacaoSenha(escopo) {
  (escopo || document).querySelectorAll('[data-senha-confirma]').forEach((confirma) => {
    const form = confirma.closest('form');
    const senha = form.querySelector('[data-senha]');
    const conferir = () => {
      confirma.setCustomValidity(confirma.value && confirma.value !== senha.value ? 'As senhas não são iguais.' : '');
    };
    confirma.addEventListener('input', conferir);
    senha.addEventListener('input', conferir);
  });
}

// Olhinho pra mostrar/esconder senha — em qualquer input[type=password] da
// página, sem precisar de atributo extra. Envolve o input num wrapper
// relativo e alterna o type no clique do botão.
function ligarMostrarSenha(escopo) {
  (escopo || document).querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.dataset.olhoLigado) return;
    input.dataset.olhoLigado = '1';
    const wrap = document.createElement('div');
    wrap.className = 'senha-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'senha-olho';
    btn.setAttribute('aria-label', 'Mostrar senha');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 5c-5 0-9.27 3.11-11 7.5C2.73 16.89 7 20 12 20s9.27-3.11 11-7.5C21.27 8.11 17 5 12 5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>';
    wrap.appendChild(btn);
    btn.addEventListener('click', () => {
      const mostrando = input.type === 'text';
      input.type = mostrando ? 'password' : 'text';
      btn.classList.toggle('ativo', !mostrando);
      btn.setAttribute('aria-label', mostrando ? 'Mostrar senha' : 'Esconder senha');
    });
  });
}

// Regra de senha forte, só onde tiver data-senha (criação de conta — não no
// login): 8+ caracteres com maiúscula, minúscula, número e símbolo.
const REGRA_SENHA = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
function ligarForcaSenha(escopo) {
  (escopo || document).querySelectorAll('[data-senha]').forEach((input) => {
    input.removeAttribute('minlength');
    const dica = document.createElement('p');
    dica.className = 'form-hint';
    dica.textContent = 'Mínimo 8 caracteres, com maiúscula, minúscula, número e símbolo (ex.: @, #, -).';
    (input.closest('.senha-wrap') || input).insertAdjacentElement('afterend', dica);
    const conferir = () => {
      input.setCustomValidity(
        input.value && !REGRA_SENHA.test(input.value)
          ? 'A senha precisa ter 8+ caracteres com maiúscula, minúscula, número e símbolo.'
          : '',
      );
    };
    input.addEventListener('input', conferir);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  ligarCep();
  ligarCategorias();
  ligarMostrarSenha();
  ligarForcaSenha();
  ligarConfirmacaoSenha();
});
