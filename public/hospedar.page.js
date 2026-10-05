// "Hospede temporariamente um Ponto Móvel Mostraí" (migrations 113 e 114).
// Três estados, decididos no servidor (GET /anunciantes/me/hospedagem):
//   · anônimo (401) — a explicação e "Entrar na minha conta"; sem formulário;
//   · logado SEM direito ativo de veiculação — o requisito e "Ver planos";
//   · logado COM direito — o formulário curto (src/pontos/hospedagem-interesse.js
//     confere tudo de novo no envio). Com interesse em aberto, o andamento.
// O percentual do texto vem do servidor (GET /hospedagem/condicao) — nada
// fixo na página.
const alvo = document.getElementById('hospedarConteudo');
const esc = (s) => window.esc(s);

const horasTexto = (segundos) => {
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
};

const cartao = (titulo, texto, acoes = '') =>
  `<div class="card u-m-0 u-mw-livre"><h2 class="u-fs-130">${esc(titulo)}</h2><p>${texto}</p>${acoes}</div>`;

function anonimo() {
  const volta = encodeURIComponent('/hospedar.html');
  alvo.innerHTML = cartao(
    'Entre na sua conta para pedir',
    'O Ponto Móvel é para quem já anuncia na Mostraí. Entre na sua conta para ver se ela pode receber um — e, se puder, enviar o interesse em poucos cliques.',
    `<a class="btn primary block" href="/anunciante/login.html?voltar=${volta}">Entrar na minha conta</a>
     <p class="form-hint u-ta-c">Ainda não anuncia? <a href="/planos.html">Conheça os planos</a>.</p>`,
  );
}

function semDireito(d) {
  const texto =
    d.elegivel?.motivo === 'suspensa'
      ? 'Sua conta está suspensa no momento. Fale com a Mostraí para regularizar.'
      : 'Para hospedar um Ponto Móvel, sua conta precisa ter direito ativo de veiculação: um plano vigente, benefício de mídia, Plano Básico ou saldo de horas.';
  alvo.innerHTML = cartao(
    'Disponível para quem já anuncia',
    esc(texto),
    d.elegivel?.motivo === 'suspensa' ? '' : '<a class="btn primary block" href="/planos.html">Ver planos</a>',
  );
}

function jaEnviado(d) {
  alvo.innerHTML = `<div class="card u-m-0 u-mw-livre">${window.htmlAndamentoInteresse(d.interesseAberto)}
    <p class="form-hint">Você acompanha o andamento no seu <a href="/anunciante/painel.html#modHospedagem">painel</a>.</p></div>`;
}

async function carregar() {
  let r;
  try {
    r = await fetch(`${API_BASE_URL}/anunciantes/me/hospedagem`, { credentials: 'include' });
  } catch {
    alvo.innerHTML = cartao('Não foi possível carregar agora', 'Atualize a página em alguns instantes.');
    return;
  }
  if (r.status === 401) return anonimo();
  if (!r.ok) {
    alvo.innerHTML = cartao('Não foi possível carregar agora', 'Atualize a página em alguns instantes.');
    return;
  }
  const d = await r.json();
  if (d.interesseAberto) return jaEnviado(d);
  if (!d.elegivel?.possui) return semDireito(d);
  window.formInteresseHospedagem(alvo, d, { aoEnviar: () => carregar() });
}

(async () => {
  try {
    const r = await fetch(`${API_BASE_URL}/hospedagem/condicao`);
    if (!r.ok) return;
    const c = await r.json();
    const pct = `${String(c.percentual).replace('.', ',')}%`;
    document.getElementById('hospPercentual').textContent =
      `${pct} do tempo de operação válido volta em horas de mídia`;
    document.getElementById('hospExemplo').textContent =
      `Com ${pct}: ${c.exemplo.horasDeOperacao} h de operação válida geram ${horasTexto(c.exemplo.segundosDeMidia)} de mídia ` +
      'para anunciar o seu negócio na rede. Conta só o tempo em que a tela esteve ligada e funcionando, dentro do período e do horário combinados.';
  } catch {
    // Sem o número, o texto genérico da página continua valendo.
  }
})();

carregar();
