// Troca o link "Entrar" do cabeçalho por "Meu perfil" quando o anunciante já
// está logado (cookie de sessão) — carregado em todas as páginas públicas
// que têm o link marcado com data-nav-entrar. Requer /config.js antes.
(function () {
  var link = document.querySelector('[data-nav-entrar]');
  if (!link || typeof API_BASE_URL === 'undefined') return;
  fetch(API_BASE_URL + '/anunciantes/me', { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (a) {
      if (!a) return;
      link.textContent = a.nome_empresa;
      link.href = '/anunciante/painel.html';
      link.classList.remove('ghost');
    })
    .catch(function () {});
})();
