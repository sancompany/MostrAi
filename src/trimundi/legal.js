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
const VERSAO = '1.2';
const VIGENCIA = '10/11/2026';

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

module.exports = { VERSAO, VIGENCIA, contato, hashDocumentos };
