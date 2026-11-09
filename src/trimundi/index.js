const path = require('node:path');
const express = require('express');
const config = require('./config');
const { MENSAGEM_NAO_CONFIGURADA } = require('./lib/erros');

// Ponto de entrada da Trimundi na aplicação da Mostraí (ADR-048). Monta as
// rotas e, no processo principal, os trabalhos de fundo. Sem o banco
// próprio configurado, nada roda: as rotas respondem 503 e o login da
// Mostraí não procura operador.

const router = express.Router();

// Desligada (sem banco próprio): todo /ticket responde 503 — página para
// quem pediu página, JSON para a API. O Admin tem a trava dele (rotas/admin.js).
router.use('/ticket', (req, res, next) => {
  if (config.configurada()) return next();
  if (req.path.startsWith('/api/')) return res.status(503).json({ erro: MENSAGEM_NAO_CONFIGURADA });
  return res.status(503).sendFile(path.join(__dirname, '..', '..', 'public', '500.html'));
});
router.use(require('./rotas/admin').router);
router.use(require('./rotas/operador').router);
router.use(require('./rotas/conta').router);
router.use(require('./rotas/publico').router);

function registrar(nome) {
  return (err) => console.error(`trimundi: ${nome}:`, err.message);
}

function iniciarProcessos() {
  if (!config.configurada()) {
    console.log('trimundi: desligada (sem banco próprio configurado)');
    return;
  }
  const pagamentos = require('./pagamentos');
  const email = require('./email');
  const pedidos = require('./pedidos');
  // Fila de avisos de pagamento e de e-mail a cada 30 s; pedidos vencidos a
  // cada 5 min. Sem exclusão automática de dado pessoal (D2: só depois da
  // revisão jurídica).
  const a = setInterval(() => {
    pagamentos.processarFila().catch(registrar('fila de pagamento'));
    email.processar().catch(registrar('fila de e-mail'));
  }, 30000);
  const b = setInterval(() => pedidos.expirarVencidos().catch(registrar('expiração de pedidos')), 5 * 60000);
  // Conciliação com o San Checkout a cada 6 h (API.md §4.3.6 pede ao menos
  // uma vez por dia): acha pagamento ou estorno cujo aviso se perdeu. Só com
  // o Checkout configurado; reaplicar não duplica nada (evento_id próprio).
  const conciliar = () => {
    if (!config.checkout().configurado) return;
    require('./checkout/conciliar').conciliarPendentes().catch(registrar('conciliação'));
  };
  const c = setInterval(conciliar, 6 * 3600000);
  const primeira = setTimeout(conciliar, 2 * 60000);
  a.unref();
  b.unref();
  c.unref();
  primeira.unref();
  setImmediate(() => pagamentos.processarFila().catch(registrar('fila de pagamento')));
}

module.exports = { router, iniciarProcessos };
