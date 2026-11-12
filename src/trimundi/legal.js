const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Termos de Uso e Política de Privacidade da TICK. O texto é o oficial,
// entregue pelo advogado do dono, sem nenhuma palavra mudada:
// docs/trimundi/legal/*-v<versão>.txt; as páginas (paginas/termos.html e
// privacidade.html) dizem exatamente o mesmo — o teste trimundi-legal
// confere. A versão sobe a cada texto novo: quem aceitou a anterior aceita de
// novo antes da próxima compra, e o aceite antigo fica no histórico
// (aceites_conta, migration 011).

// 1.1: o nome público passa a ser TICK (10/11/2026).
// 1.2: textos oficiais do advogado (10/11/2026).
// 1.3: identificação da operadora pelo MEI (pedido do dono, 11/11/2026) — o
//      resto do texto, palavra por palavra, igual à 1.2.
const VERSAO = '1.3';
const VIGENCIA = '11/11/2026';

// Quem opera a TICK (fornecedora da plataforma e controladora dos dados) —
// os dados que o dono confirmou em 11/11/2026. A TICK continua sendo a
// marca; quem organiza cada evento é outra responsabilidade. Endereço
// completo, telefone e inscrições NÃO estão aqui porque não foram informados
// (pendência em docs/trimundi/pendencias.md) — não inventar.
const OPERADORA = Object.freeze({
  nome_empresarial: '68.949.029 BRUNO HENRIQUE SANCHES',
  cnpj: '68.949.029/0001-58',
  natureza: 'Empresário Individual — MEI',
  titular: 'Bruno Henrique Sanches',
});
// A linha que aparece no rodapé das páginas e dos e-mails.
const linhaDaOperadora = () => `TICK é uma plataforma de ${OPERADORA.nome_empresarial} · CNPJ: ${OPERADORA.cnpj}`;

const PAGINAS = path.join(__dirname, 'paginas');
let hash = null;
// Hash do que é apresentado nesta versão (as duas páginas, como servidas):
// fica em cada aceite e prova, junto com o git, o texto que a pessoa viu.
function hashDocumentos() {
  if (!hash) {
    const h = crypto.createHash('sha256');
    for (const nome of ['termos.html', 'privacidade.html']) h.update(fs.readFileSync(path.join(PAGINAS, nome)));
    hash = h.digest('hex');
  }
  return hash;
}

function contato() {
  return (
    process.env.TRIMUNDI_EMAIL_CONTATO ||
    process.env.MOSTRAI_EMAIL_CONTATO ||
    process.env.MOSTRAI_EMAIL_FROM ||
    ''
  ).trim();
}

module.exports = { VERSAO, VIGENCIA, OPERADORA, linhaDaOperadora, contato, hashDocumentos };
