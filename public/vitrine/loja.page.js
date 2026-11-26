// /loja/<slug> — a página pública da loja: perfil (logo, cor, descrição,
// contato), espaços publicados e o pedido de orçamento. O servidor só entrega
// esta página enquanto a loja está na vitrine; os dados vêm de
// GET /marketplace/api/lojas/<slug>.
(() => {
  const V = window.VITRINE;
  const slug = document.body.dataset.loja;
  const esc = (v) => window.esc(v ?? '');
  const $ = (id) => document.getElementById(id);
  const form = $('formContato');
  const msg = $('msg');
  const selEspaco = $('espaco');

  function desenharLoja(l) {
    V.aplicarCor(l.cor_primaria);
    $('lojaNome').textContent = l.nome;
    $('lojaCidade').textContent = [l.cidade, l.uf].filter(Boolean).join('/') || 'Marketplace';
    $('lojaDescricao').textContent = l.descricao || '';
    $('lojaLogo').innerHTML = l.logo_url
      ? `<img src="${esc(l.logo_url)}" alt="">`
      : `<span>${esc((l.nome || '?').trim().charAt(0).toUpperCase())}</span>`;
    const tel = (l.telefone || '').replace(/\D/g, '');
    $('lojaContatos').innerHTML = [
      l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '',
      tel ? `<a href="tel:+55${esc(tel)}">${esc(V.telefoneBR(l.telefone))}</a>` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const espacos = l.espacos || [];
    $('espacos').innerHTML = espacos.length
      ? espacos
          .map((e) =>
            V.cartao(e, {
              acao: `<button type="button" class="btn ghost mini" data-interesse="${esc(e.slug)}">Tenho interesse</button>`,
            }),
          )
          .join('')
      : '<p class="empty-state">Esta loja ainda não publicou espaços. Mande uma mensagem pelo formulário abaixo.</p>';
    selEspaco.insertAdjacentHTML(
      'beforeend',
      espacos.map((e) => `<option value="${esc(e.slug)}">${esc(e.nome)}</option>`).join(''),
    );
  }

  // "Tenho interesse": escolhe o espaço no formulário e leva até ele.
  $('espacos').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-interesse]');
    if (!b) return;
    selEspaco.value = b.dataset.interesse;
    $('secaoContato').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('nome').focus({ preventScroll: true });
  });

  fetch(`${API_BASE_URL}/marketplace/api/lojas/${encodeURIComponent(slug)}`)
    .then((r) => {
      if (!r.ok) throw new Error(`resposta ${r.status}`);
      return r.json();
    })
    .then(desenharLoja)
    .catch(() => {
      $('espacos').innerHTML =
        '<p class="empty-state">Não foi possível carregar a loja agora. Tente de novo em instantes.</p>';
    });

  const botao = form.querySelector('[type="submit"]');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const dados = Object.fromEntries(new FormData(form));
    if (!dados.nome?.trim() || !dados.email?.trim() || !dados.mensagem?.trim()) {
      msg.textContent = 'Preencha nome, e-mail e mensagem.';
      msg.className = 'form-msg err';
      return;
    }
    for (const k of Object.keys(dados)) if (dados[k] === '') delete dados[k];
    msg.textContent = 'Enviando...';
    msg.className = 'form-msg';
    botao.disabled = true;
    try {
      const r = await fetch(`${API_BASE_URL}/marketplace/api/lojas/${encodeURIComponent(slug)}/contato`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dados),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(corpo.erro || 'não foi possível enviar');
      msg.textContent = 'Pedido enviado! A loja responde no contato que você informou.';
      msg.className = 'form-msg ok';
      form.reset();
    } catch (err) {
      msg.textContent = `Não foi possível enviar: ${err.message}.`;
      msg.className = 'form-msg err';
    } finally {
      botao.disabled = false;
    }
  });
})();
