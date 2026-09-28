// Peças compartilhadas pelos 3 cadastros (anunciante, vendedor e ponto):
// CEP que preenche o endereço sozinho e o select de categoria vindo do banco.
// Sem dependência externa — ViaCEP é público e o resto é DOM puro.

// data-cep no input do CEP; os campos preenchidos são procurados pelo name
// dentro do mesmo formulário (logradouro/bairro/cidade/uf — D5, 24/09/2026:
// endereço em campos separados em todo o sistema, src/lib/endereco.js).
// O aviso embaixo do CEP diz em que pé está a consulta (`data-estado`:
// consultando, encontrado, nao-encontrado, erro) — "esse CEP não existe" e
// "não deu pra consultar agora" pedem coisas diferentes da pessoa, e antes
// eram a mesma frase. Consulta só no blur com 8 dígitos, como sempre.
function ligarCep(escopo) {
  (escopo || document).querySelectorAll('[data-cep]').forEach((input) => {
    const form = input.closest('form') || document;
    const achar = (nome) => form.querySelector(`[name="${nome}"]`);
    const aviso = form.querySelector('[data-cep-msg]');
    // Como o aviso nasceu (texto, classe, escondido ou não — no perfil ele
    // nasce vazio e escondido): é pra lá que ele volta quando o CEP muda.
    const inicial = aviso && { texto: aviso.textContent, classe: aviso.className, escondido: aviso.hidden };
    if (aviso && !aviso.hasAttribute('aria-live')) aviso.setAttribute('aria-live', 'polite');
    const avisar = (estado, texto) => {
      if (!aviso) return;
      aviso.hidden = false;
      aviso.textContent = texto;
      aviso.className = 'form-hint';
      aviso.dataset.estado = estado;
    };
    const restaurar = () => {
      if (!aviso) return;
      aviso.textContent = inicial.texto;
      aviso.className = inicial.classe;
      aviso.hidden = inicial.escondido;
      delete aviso.dataset.estado;
    };

    input.addEventListener('input', () => {
      const so = input.value.replace(/\D/g, '').slice(0, 8);
      input.value = so.length > 5 ? `${so.slice(0, 5)}-${so.slice(5)}` : so;
      // CEP mudou depois de uma consulta: o aviso dela já não vale.
      if (aviso?.dataset.estado && so.length < 8) restaurar();
    });

    input.addEventListener('blur', async () => {
      const cep = input.value.replace(/\D/g, '');
      if (cep.length !== 8) return;
      avisar('consultando', 'Buscando endereço...');
      // O que cada campo tinha quando a consulta saiu: quem a pessoa editou
      // enquanto a resposta não chegava fica como ela deixou (antes a
      // resposta atrasada apagava a rua recém-digitada).
      const campos = ['logradouro', 'endereco', 'bairro', 'cidade', 'uf'];
      const antes = Object.fromEntries(campos.map((nome) => [nome, achar(nome)?.value]));
      const preenchidos = new Set();
      const preencher = (nome, valor) => {
        const campo = achar(nome);
        if (!campo || campo.value !== antes[nome]) return;
        campo.value = valor;
        preenchidos.add(campo);
        // Quem depende do campo fica sabendo (a prévia do card do ponto
        // mostra a cidade; o erro de "informe o bairro" some).
        campo.dispatchEvent(new Event('input', { bubbles: true }));
      };
      let dados;
      try {
        dados = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
      } catch {
        // Consulta velha (a pessoa já trocou o CEP) não fala mais nada.
        if (input.value.replace(/\D/g, '') === cep) {
          avisar('erro', 'Não deu para consultar o CEP agora. Preencha o endereço à mão.');
        }
        return;
      }
      // Outra consulta começou depois desta (a pessoa trocou o CEP): esta
      // resposta já não é do CEP que está no campo.
      if (input.value.replace(/\D/g, '') !== cep) return;
      try {
        if (dados.erro) throw new Error();
        // Rua e bairro são campos separados (Parte W, migration 070) — nunca
        // mais concatenados. Quando a ViaCEP não devolve um dos dois (CEP de
        // faixa, sem logradouro/bairro fixo), o campo fica vazio, pro cliente
        // preencher — nunca inventado nem colado no outro campo.
        preencher(achar('logradouro') ? 'logradouro' : 'endereco', dados.logradouro || '');
        preencher('bairro', dados.bairro || '');
        // Deixa o número pro cliente digitar — é o único pedaço que o CEP não sabe.
        preencher('cidade', dados.localidade);
        preencher('uf', dados.uf);
        avisar('encontrado', 'Confira e complete com o número.');
        // Leva pro número (como sempre), a não ser que a pessoa já esteja
        // digitando num campo que a consulta não preencheu.
        const numero = achar('numero');
        const foco = document.activeElement;
        if (numero && (!foco || foco === document.body || foco === input || preenchidos.has(foco))) numero.focus();
      } catch {
        avisar('nao-encontrado', 'CEP não encontrado, pode preencher o endereço na mão.');
      }
    });
  });
}

// Busca ignorando maiúsculas/acentos ("estetica" acha "Estética"). Guardado
// junto do valor original — nunca altera o que fica gravado, só o que é
// comparado na hora de filtrar.
function normalizarBusca(txt) {
  return (txt || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// data-categorias num <select> — vira um campo de busca (22/09/2026: catálogo
// passou de 25 pra ~230 categorias, um select tradicional parou de fazer
// sentido). O <select> continua existindo no DOM, só escondido: é ele quem
// seguem lendo — form.categoria_id.value, .options[.selectedIndex].dataset,
// FormData — em cadastro.page.js, modos.js e meus-pontos.js, sem precisar
// mexer em nenhum desses arquivos. A busca é só uma camada de cima.
//
// Categoria = o que bloqueia concorrente direto (grupo é só organização
// do admin, nunca entra nisso nem aparece aqui — ver src/playlist/gerador.js
// e a Parte 45 da reconstrução de Categorias, 23/09/2026: o cliente vê só o
// nome da categoria canônica; alias só serve pra achar). "Não encontrei
// minha categoria" substitui o antigo "Outro" (era uma comparação de string
// solta no front, `nome === 'Outro'`): agora é só limpar o select e mostrar
// o campo de texto livre que os três formulários já tinham — mesmo mecanismo
// de categoria_livre / categoria pendente que já existia desde a migration
// 015, só sem depender de uma linha mágica no catálogo.
async function ligarCategorias(escopo) {
  const selects = (escopo || document).querySelectorAll('[data-categorias]');
  if (!selects.length) return;
  let categorias = [];
  try {
    const r = await fetch(`${API_BASE_URL}/categorias`);
    categorias = await r.json();
    // Erro do servidor também vem como JSON válido ({erro:...}) — sem essa
    // checagem o .map() estouraria fora do try e o campo ficaria vazio e
    // obrigatório, travando o cadastro sem dizer por quê.
    if (!r.ok || !Array.isArray(categorias)) throw new Error('resposta inesperada');
  } catch {
    // Sem a lista, o campo ficaria vazio e obrigatório — o navegador
    // bloquearia o envio sem dizer por quê e o cadastro morreria aí. Melhor
    // liberar o campo e perguntar o ramo depois, por WhatsApp.
    selects.forEach((sel) => {
      sel.required = false;
      sel.innerHTML = '<option value="">(a gente confirma seu ramo no contato)</option>';
      montarBusca(sel, [], true);
    });
    return;
  }

  const comBusca = categorias.map((c) => ({
    ...c,
    busca: normalizarBusca(`${c.nome} ${(c.aliases || []).join(' ')}`),
    buscaNome: normalizarBusca(c.nome),
  }));
  selects.forEach((sel) => {
    sel.innerHTML =
      '<option value="">Selecione...</option>' +
      categorias.map((c) => `<option value="${c.id}" data-nome="${c.nome}">${c.nome}</option>`).join('');
    montarBusca(sel, comBusca, false);
  });
}

// Monta o campo de busca por cima do <select> (que fica hidden, mas continua
// no form). `semCatalogo` é o caso de fallback do catch acima — sem lista
// pra filtrar, mostra só um aviso, sem pretender ser buscável.
//
// Estação dos formulários de ponto (28/09/2026), três furos da busca:
//   - o `required` ficava no <select> ESCONDIDO: o navegador recusava o envio
//     sem segmento, não conseguia focar o campo e não dizia nada ("An
//     invalid form control ... is not focusable") — o botão parecia
//     quebrado. A exigência passa pro campo visível, com a mensagem própria;
//   - o <label> apontava pro <select> escondido: o campo que a pessoa usa não
//     tinha nome pra leitor de tela;
//   - só dava pra escolher com o mouse. Agora setas, Enter e Esc, no padrão
//     de combobox (`aria-activedescendant`).
// E o texto do campo não fica mais dizendo uma categoria enquanto o <select>
// guarda outra: editou o nome escolhido, a escolha é desfeita.
function montarBusca(sel, categorias, semCatalogo) {
  sel.hidden = true;
  const obrigatorio = sel.required;
  sel.required = false;
  const form = sel.closest('form') || document;
  const livre = form.querySelector('[data-categoria-livre]');

  const wrap = document.createElement('div');
  wrap.className = 'categoria-busca-wrap';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'categoria-busca';
  if (sel.id) {
    input.id = `${sel.id}_busca`;
    const rotulo = form.querySelector(`label[for="${sel.id}"]`);
    if (rotulo) rotulo.htmlFor = input.id;
  }
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.autocomplete = 'off';
  input.placeholder = semCatalogo ? '(a gente confirma seu ramo no contato)' : 'Pesquise sua atividade...';
  input.disabled = semCatalogo;
  input.required = obrigatorio && !semCatalogo;
  const lista = document.createElement('ul');
  lista.className = 'categoria-resultados';
  lista.setAttribute('role', 'listbox');
  lista.id = `${input.id || `categoria_${Math.random().toString(36).slice(2)}`}_lista`;
  lista.hidden = true;
  input.setAttribute('aria-controls', lista.id);
  wrap.append(input, lista);
  sel.insertAdjacentElement('afterend', wrap);
  // Formulário enviado antes de o catálogo chegar: o erro ficou no <select>,
  // que agora sumiu — quem responde pelo campo daqui em diante é a busca.
  const erroDoSelect = sel.id && document.getElementById(`${sel.id}_erro`);
  if (erroDoSelect) {
    erroDoSelect.remove();
    sel.removeAttribute('aria-invalid');
    sel.removeAttribute('aria-describedby');
  }
  if (semCatalogo) return;

  // Edição de algo que já tem categoria escolhida (admin, ou volta na
  // página) — o campo de busca nasce mostrando o nome já selecionado.
  const opcaoInicial = sel.options[sel.selectedIndex];
  if (opcaoInicial?.value) input.value = opcaoInicial.dataset.nome;

  // Obrigatório e nada escolhido (nem "Não encontrei", que abre o campo de
  // texto livre, obrigatório por conta própria): o campo visível fica
  // inválido com a mensagem que diz o que fazer.
  const conferir = () => {
    const livreAberto = livre && !livre.hidden;
    input.required = obrigatorio && !livreAberto;
    input.setCustomValidity(
      obrigatorio && !sel.value && !livreAberto
        ? 'Escolha uma opção da lista (ou “Não encontrei minha categoria”).'
        : '',
    );
  };
  conferir();

  const escolher = (categoria) => {
    sel.innerHTML =
      '<option value="">Selecione...</option>' +
      categorias
        .map(
          (c) =>
            `<option value="${c.id}" data-nome="${c.nome}" ${c.id === categoria.id ? 'selected' : ''}>${c.nome}</option>`,
        )
        .join('');
    input.value = categoria.nome;
    if (livre) {
      livre.hidden = true;
      livre.querySelector('input').required = false;
      livre.querySelector('input').value = '';
    }
    fechar();
    conferir();
    // `bubbles`: quem ouve o formulário (a prévia do card do ponto) também
    // fica sabendo da escolha — antes o evento morria no próprio <select>.
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const naoEncontrei = () => {
    sel.value = '';
    input.value = '';
    if (livre) {
      livre.hidden = false;
      livre.querySelector('input').required = true;
      livre.querySelector('input').focus();
    }
    fechar();
    conferir();
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };

  let ativo = -1;
  const opcoes = () => [...lista.querySelectorAll('li[role="option"]')];
  function destacar(indice) {
    const todas = opcoes();
    ativo = todas.length ? (indice + todas.length) % todas.length : -1;
    todas.forEach((li, i) => {
      li.classList.toggle('ativo', i === ativo);
      li.setAttribute('aria-selected', String(i === ativo));
    });
    if (ativo >= 0) {
      input.setAttribute('aria-activedescendant', todas[ativo].id);
      todas[ativo].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function fechar() {
    lista.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    ativo = -1;
  }

  function abrir(termo) {
    const alvo = normalizarBusca(termo);
    // Sem termo ainda: mostra o catálogo inteiro em ordem alfabética (é a
    // mesma lista que um select mostraria aberto, só que já pesquisável). Com
    // termo, filtra por nome OU alias — e quem bateu pelo NOME vem antes de
    // quem bateu só pelo alias ("pousada" mostra "Hotel / Pousada" no topo).
    const bateu = alvo
      ? categorias
          .filter((c) => c.busca.includes(alvo))
          .map((c) => ({ c, peso: c.buscaNome.startsWith(alvo) ? 0 : c.buscaNome.includes(alvo) ? 1 : 2 }))
          .sort((a, b) => a.peso - b.peso)
          .map((x) => x.c)
      : categorias;
    const LIMITE = 40;
    const itens = bateu.slice(0, LIMITE);
    lista.innerHTML =
      (itens.length
        ? itens
            .map(
              (c) =>
                `<li role="option" id="${lista.id}_${c.id}" data-id="${c.id}" aria-selected="false">${esc(c.nome)}</li>`,
            )
            .join('')
        : '<li class="categoria-vazio" role="presentation">Nada encontrado.</li>') +
      `<li class="categoria-nao-encontrei" role="option" id="${lista.id}_nao" data-nao-encontrei aria-selected="false">Não encontrei minha categoria</li>`;
    lista.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
    ativo = -1;
  }

  input.addEventListener('focus', () => abrir(input.value));
  input.addEventListener('input', () => {
    // O texto não é mais o nome escolhido: a escolha antiga não vale.
    const escolhida = sel.options[sel.selectedIndex];
    if (escolhida?.value && input.value !== escolhida.dataset.nome) {
      sel.value = '';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    conferir();
    abrir(input.value);
  });
  input.addEventListener('blur', () => setTimeout(fechar, 150)); // dá tempo do click no item disparar antes de sumir a lista
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      fechar();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (lista.hidden) abrir(input.value);
      destacar(e.key === 'ArrowDown' ? ativo + 1 : ativo < 0 ? -1 : ativo - 1);
      return;
    }
    if (e.key === 'Enter') {
      // Enter nunca envia o formulário daqui: ou escolhe a opção destacada,
      // ou não faz nada.
      e.preventDefault();
      const li = ativo >= 0 && !lista.hidden ? opcoes()[ativo] : null;
      if (!li) return;
      if (li.dataset.naoEncontrei !== undefined) return naoEncontrei();
      const categoria = categorias.find((c) => String(c.id) === li.dataset.id);
      if (categoria) escolher(categoria);
    }
  });
  lista.addEventListener('mousedown', (e) => {
    // mousedown (não click) pra vencer o blur do input, que fecharia a
    // lista antes do click chegar a disparar.
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    if (li.dataset.naoEncontrei !== undefined) return naoEncontrei();
    const categoria = categorias.find((c) => String(c.id) === li.dataset.id);
    if (categoria) escolher(categoria);
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
    // A dica sai DEPOIS da linha de campos, não dentro da coluna da senha:
    // presa na coluna, ela herdava a largura do campo (140px no celular) e
    // a frase virava quatro linhas espremidas ao lado do "Confirmar senha".
    // Ela vale pro par inteiro, então ocupa a largura inteira.
    dica.dataset.dicaSenha = '';
    const ancora = input.closest('.field-row') || input.closest('.senha-wrap') || input;
    if (!ancora.nextElementSibling?.hasAttribute?.('data-dica-senha')) {
      ancora.insertAdjacentElement('afterend', dica);
    }
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
