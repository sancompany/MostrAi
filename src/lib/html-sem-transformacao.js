// `Cache-Control: no-transform` em todo HTML que o servidor entrega
// (24/09/2026, decisão D6 do dono).
//
// A zona sancocore.com.br tem o Cloudflare Web Analytics com instalação
// automática: a borda injeta `static.cloudflareinsights.com/beacon.min.js`
// no HTML, e a nossa CSP (`script-src 'self'`, ADR-011) recusa — erro de
// console em toda página de produção, e a métrica nunca foi coletada. O dono
// decidiu NÃO liberar o domínio na CSP agora (analytics volta depois, junto
// com privacidade/CSP) e desligar a injeção.
//
// Por que aqui e não no painel da Cloudflare: o Web Analytics está ligado na
// ZONA inteira, que atende outros projetos da San & Co., e o plano só aceita
// uma regra (a de "todos os hosts") — não dá pra excluir só este host por
// lá. `no-transform` é o jeito documentado de a borda não mexer no corpo
// (developers.cloudflare.com/web-analytics/faq): o beacon não é injetado, e
// a ofuscação de e-mail (outro script injetado) também deixa de reescrever
// os `mailto:` — o e-mail já é público no site. Vale só pra este host.
//
// Só no HTML: é onde a borda injeta; CSS, JS e imagem seguem com o cache de
// sempre.
const DIRETIVA = 'no-transform';

function comSemTransformacao(valor) {
  const atual = String(valor || '').trim();
  if (!atual) return DIRETIVA;
  if (atual.split(',').some((d) => d.trim().toLowerCase() === DIRETIVA)) return atual;
  return `${atual}, ${DIRETIVA}`;
}

// Pro `express.static({ setHeaders })`: roda depois de o static montar o
// Cache-Control dele, então só acrescenta a diretiva.
function setHeadersEstaticos(res, arquivo) {
  if (arquivo.endsWith('.html')) res.setHeader('Cache-Control', comSemTransformacao(res.getHeader('Cache-Control')));
}

module.exports = { comSemTransformacao, setHeadersEstaticos };
