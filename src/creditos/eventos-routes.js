const express = require('express');
const router = express.Router();
const sse = require('../lib/sse');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');

// Ping de manutenção — sem isso, proxy/load balancer na frente (Cloudflare,
// Northflank) derruba a conexão HTTP por ociosidade antes de qualquer
// evento de verdade precisar passar. Comentário SSE (`: ...`), não um
// evento — EventSource ignora linhas começando com `:`.
const INTERVALO_PING_MS = 25_000;

// GET /conta/eventos — stream de eventos da conta logada. Autenticado por
// sessão (cookie), igual toda rota de `/anunciantes/me/*` — nunca por
// token na URL, que vazaria em log de acesso e no histórico do navegador.
router.get('/conta/eventos', exigirAnuncianteLogado, (req, res) => {
  const contaId = req.session.anuncianteId;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx/proxies costumam bufferizar por padrão — este cabeçalho é o
    // sinal padrão pra não fazer isso num stream.
    'X-Accel-Buffering': 'no',
  });
  res.write(': conectado\n\n');
  sse.registrarCliente(contaId, res);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, INTERVALO_PING_MS);

  req.on('close', () => {
    clearInterval(ping);
    sse.removerCliente(contaId, res);
  });
});

module.exports = router;
