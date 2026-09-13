const express = require('express');
const router = express.Router();
const { exigirAparelho } = require('../lib/aparelho');
const gerador = require('../playlist/gerador');
const dispositivosRepo = require('../dispositivos/repository');

// Confirmação de exibição, por tela. O anunciante precisa estar na playlist
// desta tela nesta hora — senão qualquer chave válida confirmaria exibição
// de qualquer anunciante.
router.post('/player/:dispositivoId/played', exigirAparelho, async (req, res) => {
  const { anuncianteId } = req.body;
  if (!anuncianteId) return res.status(400).json({ erro: 'anuncianteId obrigatório' });
  const ok = await gerador.confirmarExibicao(req.dispositivo.id, anuncianteId, new Date());
  if (!ok) return res.status(400).json({ erro: 'anunciante não está programado nesta tela nesta hora' });
  res.json({ ok: true });
});

router.post('/player/:dispositivoId/heartbeat', exigirAparelho, async (req, res) => {
  await dispositivosRepo.marcarOnline(req.dispositivo.id);
  res.json({ ok: true });
});

module.exports = router;
