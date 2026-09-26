const crypto = require('node:crypto');

// Identidade humana da tela e código de instalação do Player
// (docs/player-mvp-contract.md §2 e §3).

// ---------------------------------------------------------------------------
// Código da tela: "M-0235". É o id interno formatado — não substitui a PK,
// não é segredo e não muda ao revogar ou reinstalar o Player. Serve de
// `dispositivoId` no contrato e de nome da tela no admin.
// ---------------------------------------------------------------------------
const TETO_INT4 = 2147483647;

function formatarCodigoTela(id) {
  return `M-${String(id).padStart(4, '0')}`;
}

// "M-0235", "m-0235", "M0235", "0235" e "235" → 235. Qualquer outra coisa →
// null (quem chama decide se é 400 ou 401).
function normalizarCodigoTela(entrada) {
  if (typeof entrada !== 'string' && typeof entrada !== 'number') return null;
  const limpo = String(entrada).trim().toUpperCase().replace(/[\s-]/g, '');
  const m = limpo.match(/^M?(\d{1,10})$/);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 && id <= TETO_INT4 ? id : null;
}

// ---------------------------------------------------------------------------
// Código de instalação: 8 caracteres de um alfabeto sem ambíguos (sem 0, O,
// 1, I, L), exibido "XXXX-XXXX". 31^8 ≈ 8,5×10^11 (~40 bits). Sozinho seria
// fraco contra força bruta offline — por isso nunca é guardado em claro nem
// como SHA-256 simples (src/lib/cofre.js#assinar), vale só 30 min, só para
// UMA tela e morre na 5ª tentativa errada.
// ---------------------------------------------------------------------------
const ALFABETO_INSTALACAO = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const TAMANHO_INSTALACAO = 8;
const FORMATO_INSTALACAO = new RegExp(`^[${ALFABETO_INSTALACAO}]{${TAMANHO_INSTALACAO}}$`);

function gerarCodigoInstalacao() {
  let codigo = '';
  for (let i = 0; i < TAMANHO_INSTALACAO; i++)
    codigo += ALFABETO_INSTALACAO[crypto.randomInt(ALFABETO_INSTALACAO.length)];
  return codigo;
}

// "7k4m-9q2w", "7K4M 9Q2W" → "7K4M9Q2W"; fora do alfabeto ou tamanho → null.
function normalizarCodigoInstalacao(entrada) {
  if (typeof entrada !== 'string') return null;
  const limpo = entrada.trim().toUpperCase().replace(/[\s-]/g, '');
  return FORMATO_INSTALACAO.test(limpo) ? limpo : null;
}

const formatarCodigoInstalacao = (codigo) => `${codigo.slice(0, 4)}-${codigo.slice(4)}`;

module.exports = {
  formatarCodigoTela,
  normalizarCodigoTela,
  ALFABETO_INSTALACAO,
  TAMANHO_INSTALACAO,
  gerarCodigoInstalacao,
  normalizarCodigoInstalacao,
  formatarCodigoInstalacao,
};
