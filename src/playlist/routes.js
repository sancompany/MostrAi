const express = require('express');
const router = express.Router();
const { exigirAparelho } = require('../lib/aparelho');
const { gerarPlaylistDaHora } = require('./gerador');

// ponytail: cache em memória por processo — evita reshuffle a cada poll do
// player (a cada 15min) dentro da mesma hora. Uma instância só (CONSTRAINTS.md);
// se escalar pra várias, mover pra tabela.
const cache = new Map();

router.get('/playlist/:dispositivoId', exigirAparelho, async (req, res) => {
  const id = req.dispositivo.id;
  const hora = new Date(); hora.setMinutes(0, 0, 0);
  const chave = `${id}-${hora.toISOString()}`;

  if (!cache.has(chave)) {
    for (const k of cache.keys()) if (k.startsWith(`${id}-`)) cache.delete(k);
    cache.set(chave, await gerarPlaylistDaHora(req.dispositivo, hora));
  }
  res.json(cache.get(chave));
});

module.exports = router;
