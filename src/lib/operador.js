// Quem está operando o Admin: o usuário do login do admin e, quando a
// requisição veio pelo Cloudflare Access (a origem só aceita tráfego dele), o
// e-mail que o Access autenticou — o login do admin é compartilhado; o Access,
// não. Usado em toda trilha de auditoria do Admin (estorno, validação de
// negócio).
function operadorDaRequisicao(req) {
  const access = String(req.get('cf-access-authenticated-user-email') || '').slice(0, 200) || null;
  return { operador: req.session.adminUsuario || 'admin', operadorAccess: access };
}

module.exports = { operadorDaRequisicao };
