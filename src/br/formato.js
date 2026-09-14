// Formato brasileiro num lugar só: dinheiro, data, ordenação e telefone.
//
// Por que existe: o servidor roda em UTC e o cliente está em Brasília. Data
// formatada sem `timeZone` explícito mostra o dia errado entre 21h e 00h —
// a janela em que o dono do ponto confere o dia dele. E cada arquivo que
// formatava dinheiro tinha a sua chamada de `toLocaleString`, então mudar o
// formato era caçar string.
//
// Usa `Intl`, que é da plataforma — não entra biblioteca para isto.

const FUSO = 'America/Sao_Paulo';

const dinheiroBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dataCurta = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: FUSO });
const dataHora = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: FUSO });
const colator = new Intl.Collator('pt-BR');

// Dinheiro chega do Postgres como string ('149.00') por causa do NUMERIC —
// Number() aqui é conversão de borda, não cálculo. Cálculo é src/lib/dinheiro.js.
const reais = (valor) => dinheiroBRL.format(Number(valor || 0));

const data = (valor) => (valor ? dataCurta.format(new Date(valor)) : '—');
const dataEHora = (valor) => (valor ? dataHora.format(new Date(valor)) : '—');

// Ordena respeitando acento: sem isto "Ágata" cai depois de "Zulmira".
const compararTexto = (a, b) => colator.compare(String(a || ''), String(b || ''));

// Telefone guardado em E.164 (+5516994635946) e exibido no formato de casa.
function telefoneE164(valor) {
  const d = String(valor || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `+${d}`;
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  return null;
}

function telefoneExibicao(valor) {
  const d = String(valor || '').replace(/\D/g, '').replace(/^55/, '');
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return String(valor || '');
}

// CEP: só formato, porque a validação de verdade é o serviço dos Correios.
const cepValido = (valor) => /^\d{8}$/.test(String(valor || '').replace(/\D/g, ''));
const cepFormatado = (valor) => {
  const d = String(valor || '').replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0,5)}-${d.slice(5)}` : String(valor || '');
};

module.exports = { FUSO, reais, data, dataEHora, compararTexto, telefoneE164, telefoneExibicao, cepValido, cepFormatado };
