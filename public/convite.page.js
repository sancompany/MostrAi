// Página de cadastro por convite: o único caminho de entrada de dono de
// ponto e de vendedor. O token diz quais papéis a conta nasce tendo; o
// formulário só mostra o que cada papel precisa (Pix pra vendedor, plano
// de comodato pra ponto, endereço comercial pra anunciante).
const token = new URLSearchParams(window.location.search).get('t');
const form = document.getElementById('formConvite');
const msg = document.getElementById('msg');
const TEXTO_PAPEL = {
  anunciante: ['Anunciante', 'Sua marca nas telas da cidade.'],
  ponto: ['Dono de ponto', 'Uma tela da Mostraí no seu comércio.'],
  vendedor: ['Vendedor', 'Comissão em cada assinatura que você indicar.'],
};
let PAPEIS = [];

function mostrarInvalido(texto) {
  document.getElementById('titulo').textContent = 'Convite inválido';
  document.getElementById('subtitulo').textContent = '';
  document.getElementById('invalido').hidden = false;
  if (texto) document.getElementById('invalidoMsg').textContent = texto;
}

async function carregar() {
  if (!token) return mostrarInvalido('O link está incompleto, copie o endereço inteiro que você recebeu.');
  let convite;
  try {
    const r = await fetch(`${API_BASE_URL}/convites/${encodeURIComponent(token)}`);
    const corpo = await r.json();
    if (!r.ok) return mostrarInvalido(corpo.erro);
    convite = corpo;
  } catch {
    return mostrarInvalido('Não deu pra conferir o convite agora. Tente de novo em instantes.');
  }

  PAPEIS = convite.papeis || [];
  const nomes = PAPEIS.map((p) => (TEXTO_PAPEL[p] || [p])[0].toLowerCase());

  // Já logado: oferece ligar os papéis nesta conta (painel único) em vez
  // de nascer uma conta nova.
  const conta = await carregarConta();
  if (conta) {
    const novos = PAPEIS.filter((p) => !(conta.papeis || []).includes(p));
    document.getElementById('titulo').textContent =
      `${conta.nome_empresa}, esse convite libera ${novos.length ? nomes.join(' e ') : 'nada novo'}`;
    document.getElementById('subtitulo').textContent = novos.length
      ? 'Confirme pra ativar na sua conta.'
      : 'Sua conta já tem tudo que esse convite libera.';
    document.getElementById('logadoNome').textContent = conta.nome_empresa;
    document.getElementById('papeisLogado').innerHTML = PAPEIS.map((p) => {
      const [t, d] = TEXTO_PAPEL[p] || [p, ''];
      return `<div class="convite-papel"><b>${esc(t)}</b><span>${esc(d)}</span></div>`;
    }).join('');
    document.getElementById('logadoPix').hidden = !novos.includes('vendedor');
    document.getElementById('jaLogado').hidden = false;
    document.getElementById('btnAceitar').disabled = !novos.length;
    document.getElementById('btnAceitar').addEventListener('click', async () => {
      const msg = document.getElementById('msgLogado');
      msg.textContent = 'Liberando...';
      msg.className = 'form-msg';
      try {
        const r = await fetch(`${API_BASE_URL}/convites/${encodeURIComponent(token)}/aceitar`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chave_pix: document.getElementById('logado_chave_pix').value.trim() || null }),
        });
        const corpo = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(corpo.erro || 'Não foi possível liberar agora.');
        window.location.href = novos.includes('ponto')
          ? '/anunciante/ponto.html'
          : novos.includes('vendedor')
            ? '/anunciante/vendedor.html'
            : '/anunciante/painel.html';
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'form-msg err';
      }
    });
    document.getElementById('btnOutraConta').addEventListener('click', async () => {
      await fetch(`${API_BASE_URL}/anunciantes/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
      window.location.reload();
    });
    return;
  }
  document.getElementById('titulo').textContent = convite.nome_sugerido
    ? `${convite.nome_sugerido}, bem-vindo à Mostraí`
    : 'Bem-vindo à Mostraí';
  document.getElementById('subtitulo').textContent =
    `Esse convite cria sua conta como ${nomes.join(' e ')}. Preencha uma vez e o painel já abre pra você.`;
  document.getElementById('papeis').innerHTML = PAPEIS.map((p) => {
    const [titulo, desc] = TEXTO_PAPEL[p] || [p, ''];
    return `<div class="convite-papel"><b>${esc(titulo)}</b><span>${esc(desc)}</span></div>`;
  }).join('');
  document.getElementById('validade').textContent = new Date(convite.expira_em).toLocaleDateString('pt-BR');
  if (convite.nome_sugerido) form.nome_empresa.value = convite.nome_sugerido;
  if (convite.email_sugerido) form.contato_email.value = convite.email_sugerido;

  const ehVendedor = PAPEIS.includes('vendedor');
  const ehPonto = PAPEIS.includes('ponto');
  const ehAnunciante = PAPEIS.includes('anunciante');
  document.getElementById('secaoPix').hidden = !ehVendedor;
  form.chave_pix.required = ehVendedor;
  document.getElementById('secaoPlanoPonto').hidden = !ehPonto;
  document.getElementById('secaoEndereco').hidden = !ehAnunciante;
  ['cep', 'endereco', 'numero', 'cidade', 'uf'].forEach((n) => {
    form[n].required = ehAnunciante;
  });
  document.getElementById('rotuloNome').textContent = ehAnunciante
    ? 'Nome da empresa'
    : ehPonto
      ? 'Seu nome ou o nome do estabelecimento'
      : 'Seu nome';
  const docs = [
    'os <a href="/termos-de-uso.html" target="_blank">Termos de Uso</a>',
    'a <a href="/politica-de-privacidade.html" target="_blank">Política de Privacidade</a>',
  ];
  if (ehAnunciante)
    docs.push('o <a href="/contrato-anunciante.html" target="_blank">Contrato de Prestação de Serviços</a>');
  if (ehPonto) docs.push('os <a href="/comodato.html" target="_blank">termos do comodato</a> da tela instalada');
  document.getElementById('rotuloTermos').innerHTML =
    `Li e aceito ${docs.slice(0, -1).join(', ')} e ${docs[docs.length - 1]}.`;
  if (ehPonto) carregarPlanosPonto();
  form.hidden = false;
}

async function carregarPlanosPonto() {
  try {
    const planos = await (await fetch(`${API_BASE_URL}/planos-ponto`)).json();
    document.getElementById('escolhaPlano').innerHTML = planos
      .map(
        (p, i) => `
      <label class="escolha">
        <input type="radio" name="plano_ponto_id" value="${p.id}" ${i === 0 ? 'checked' : ''}>
        <span class="box">
          <b>${esc(p.nome)}${Number(p.ajuda_custo_mensal) > 0 ? `, ${fmtBRL(p.ajuda_custo_mensal)}/mês` : ''}</b>
          <small>${esc(p.chamada || '')}</small>
          <ul>${(p.beneficios || []).map((b) => `<li>${esc(b)}</li>`).join('')}
            ${p.plano_bonus_id ? `<li>Depois de ${p.plano_bonus_apos_meses} meses como ponto, ganhe ${p.plano_bonus_meses} ${p.plano_bonus_meses > 1 ? 'meses' : 'mês'} de anúncio grátis</li>` : ''}</ul>
        </span>
      </label>`,
      )
      .join('');
  } catch {
    document.getElementById('escolhaPlano').innerHTML =
      '<p class="form-hint">Não deu pra carregar as opções agora, a gente combina no WhatsApp.</p>';
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Criando sua conta...';
  msg.className = 'form-msg';
  const dados = {
    convite: token,
    nome_empresa: form.nome_empresa.value.trim(),
    cpf_cnpj: form.cpf_cnpj.value.trim(),
    contato_telefone: form.contato_telefone.value.trim(),
    contato_email: form.contato_email.value.trim(),
    senha: form.senha.value,
    aceitou_termos: form.aceitou_termos.checked,
  };
  if (PAPEIS.includes('vendedor')) dados.chave_pix = form.chave_pix.value.trim();
  if (PAPEIS.includes('ponto')) {
    const escolhido = form.querySelector('input[name="plano_ponto_id"]:checked');
    if (escolhido) dados.plano_ponto_id = escolhido.value;
  }
  if (PAPEIS.includes('anunciante')) {
    Object.assign(dados, {
      endereco: `${form.endereco.value.trim()}, ${form.numero.value.trim()}`,
      cidade: form.cidade.value.trim(),
      uf: form.uf.value.trim().toUpperCase(),
      cep: form.cep.value.trim(),
    });
  }
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/cadastro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(dados),
    });
    const corpo = await r.json().catch(() => ({}));
    if (r.status === 409 && /e-mail/.test(corpo.erro || '')) {
      msg.textContent =
        'Esse e-mail já tem conta. Entre com ela e peça pra quem te convidou ligar o papel novo na sua conta.';
      msg.className = 'form-msg err';
      return;
    }
    if (!r.ok) throw new Error(corpo.erro || 'falha');
    msg.textContent = 'Conta criada! Abrindo seu painel...';
    msg.className = 'form-msg ok';
    const destino =
      PAPEIS.includes('vendedor') && !PAPEIS.includes('ponto') && !PAPEIS.includes('anunciante')
        ? '/anunciante/vendedor.html'
        : PAPEIS.includes('ponto') && !PAPEIS.includes('anunciante')
          ? '/anunciante/ponto.html'
          : '/anunciante/painel.html';
    window.location.href = destino;
  } catch (err) {
    msg.textContent = err.message === 'falha' ? 'Não foi possível criar a conta agora. Tente novamente.' : err.message;
    msg.className = 'form-msg err';
  }
});

carregar();
