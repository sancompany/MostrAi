const express = require('express');
const router = express.Router();
const { exigirAparelho } = require('../lib/aparelho');
const gerador = require('../playlist/gerador');
const execucoesRepo = require('../playlist/execucoes-repository');
const dispositivosRepo = require('../dispositivos/repository');
const eventos = require('../lib/eventos');

// Confirmação de exibição, por tela. Duas formas no mesmo corpo — o corpo
// que chega é que diz qual (o app novo, `sancompany/playlist.mostrai`, só
// manda `eventos` quando a playlist que recebeu já veio no contrato novo;
// ver `contrato_playlist` em `src/playlist/routes.js`).
//
// `exibicao:video_toca` NÃO vai pra tabela `eventos` por execução — e o
// motivo está no funcional §9: `exibicoes_contador` já guarda isso agregado
// por hora, por tela e por anunciante, com programadas E confirmadas — que é
// estritamente mais do que a linha de evento carregaria. Uma linha por
// exibição seria a maior tabela do sistema, crescendo para sempre, pra
// responder a mesma pergunta pior — inclusive no contrato novo, que só
// registra 1 evento por LOTE (ver abaixo), não por execução.
router.post('/player/:dispositivoId/played', exigirAparelho, async (req, res) => {
  if (Array.isArray(req.body.eventos)) return res.json(await confirmarLote(req.dispositivo, req.body.eventos));

  const { anuncianteId } = req.body;
  if (!anuncianteId) return res.status(400).json({ erro: 'anuncianteId obrigatório' });
  const r = await gerador.confirmarExibicao(req.dispositivo.id, anuncianteId, new Date());
  if (r.ok) return res.json({ ok: true, janela: r.janela });

  // `ja_completo` NÃO é erro: é a própria TV reenviando o que já contou
  // (retentativa depois de queda de rede, recarregar a página, player
  // reiniciando). Responder 400 aqui faria o player tentar de novo em laço, e
  // encheria o log de erro com o funcionamento normal. 200 com `contou:false`
  // diz a verdade sem pedir retentativa.
  if (r.motivo === 'ja_completo') return res.json({ ok: true, contou: false, motivo: 'ja_completo' });

  return res.status(400).json({ erro: 'anunciante não está programado nesta tela nesta hora' });
});

// Um por um (não em paralelo): o lote chega raramente e nunca passa de 50
// itens (teto do próprio app) — abrir até 50 conexões de uma vez pra creditar
// a mesma tela é desproporcional, e o gargalo real é o Postgres, não isto.
async function confirmarLote(dispositivo, eventosRecebidos) {
  const agora = new Date();
  const resultados = [];
  for (const evento of eventosRecebidos) {
    const r = await execucoesRepo.confirmarComDedup(dispositivo.id, evento, agora);
    if (r) resultados.push(r);
  }

  const porStatus = {};
  for (const r of resultados) porStatus[r.status] = (porStatus[r.status] || 0) + 1;
  eventos.registrar('playlist:proofofplay_lote', {
    dispositivo_id: dispositivo.id,
    tamanho: eventosRecebidos.length,
    ...porStatus,
  });

  return { resultados };
}

router.post('/player/:dispositivoId/heartbeat', exigirAparelho, async (req, res) => {
  await dispositivosRepo.marcarOnline(req.dispositivo.id);
  res.json({ ok: true });
});

module.exports = router;
