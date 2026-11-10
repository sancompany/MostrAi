const express = require('express');
const config = require('./config');
const { MENSAGEM_NAO_CONFIGURADA } = require('./lib/erros');

// Ponto de entrada da Trimundi na aplicação da Mostraí (ADR-048). Monta as
// rotas e, no processo principal, os trabalhos de fundo. Desligada,
// nada roda: as rotas respondem 503 (o login da Mostraí não conhece a
// Trimundi).

const router = express.Router();

// Desligada: todo /ticket responde 503 — página para
// quem pediu página, JSON para a API. O Admin tem a trava dele (rotas/admin.js).
router.use('/ticket', (req, res, next) => {
  if (config.configurada()) return next();
  if (req.path.startsWith('/api/')) return res.status(503).json({ erro: MENSAGEM_NAO_CONFIGURADA });
  // Página da própria Trimundi (a 500.html é da Mostraí).
  return require('./paginas').enviar(
    res,
    'erro',
    { titulo: 'Ingressos indisponíveis agora', texto: 'Voltamos em instantes. Tente de novo em alguns minutos.' },
    { status: 503, cache: 'no-store' },
  );
});
router.use(require('./rotas/admin').router);
router.use(require('./rotas/operador').router);
router.use(require('./rotas/conta').router);
router.use(require('./rotas/publico').router);
// Endereço que não existe em /ticket: 404 com a cara da Trimundi (os
// arquivos estáticos de public/ticket já foram servidos antes deste router).
router.use('/ticket', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ erro: 'não encontrado' });
  return require('./paginas').enviar(
    res,
    'erro',
    { titulo: 'Página não encontrada', texto: 'Confira o endereço com quem organiza o evento.' },
    { status: 404 },
  );
});

function registrar(nome) {
  return (err) => console.error(`trimundi: ${nome}:`, err.message);
}

function iniciarProcessos() {
  if (!config.configurada()) {
    console.log('trimundi: desligada (TRIMUNDI_ATIVA vazio)');
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
