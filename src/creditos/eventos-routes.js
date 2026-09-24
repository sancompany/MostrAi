const express = require('express');
const router = express.Router();
const sse = require('../lib/sse');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');

// Ping de manutenção — sem isso, proxy/load balancer na frente (Cloudflare,
// Northflank) derruba a conexão HTTP por ociosidade antes de qualquer
// evento de verdade precisar passar. Comentário SSE (`: ...`), não um
// evento — EventSource ignora linhas começando com `:`.
const INTERVALO_PING_MS = 25_000;

function abrirStream(req, res, registrar, remover) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx/proxies costumam bufferizar por padrão — este cabeçalho é o
    // sinal padrão pra não fazer isso num stream.
    'X-Accel-Buffering': 'no',
  });
  res.write(': conectado\n\n');
  registrar(res);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, INTERVALO_PING_MS);

  req.on('close', () => {
    clearInterval(ping);
    remover(res);
  });
}

// GET /conta/eventos — stream de eventos da conta logada. Autenticado por
// sessão (cookie), igual toda rota de `/anunciantes/me/*` — nunca por
// token na URL, que vazaria em log de acesso e no histórico do navegador.
const streamDaConta = (req, res, contaId) =>
  abrirStream(
    req,
    res,
    (r) => sse.registrarCliente(contaId, r),
    (r) => sse.removerCliente(contaId, r),
  );

router.get('/conta/eventos', exigirAnuncianteLogado, (req, res) => streamDaConta(req, res, req.session.anuncianteId));

// GET /admin/anunciantes/:id/eventos — o MESMO stream da conta, pra ficha de
// Conta do admin (revisão de 23/09/2026: "reatividade sem F5"). O admin vê
// qualquer conta, então assinar os eventos de uma é só ler o que ela já lê:
// créditos resgatados, candidatura aprovada, ponto/tela mudando. Protegido
// pelo `requireAdminSession` montado em '/admin' no server.js.
router.get('/admin/anunciantes/:id/eventos', (req, res) => {
  const contaId = Number(req.params.id);
  if (!Number.isInteger(contaId) || contaId <= 0) return res.status(400).json({ erro: 'conta inválida' });
  streamDaConta(req, res, contaId);
});

// GET /admin/eventos — canal do próprio admin (Player V2): tela e ponto
// mudando na Rede sem F5. Mesma sessão de admin, via requireAdminSession.
router.get('/admin/eventos', (req, res) => {
  abrirStream(req, res, sse.registrarAdmin, sse.removerAdmin);
});

module.exports = router;
