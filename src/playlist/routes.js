const express = require('express');
const router = express.Router();
const { exigirAparelho } = require('../lib/aparelho');
const { gerarPlaylistDaHora } = require('./gerador');

// O CACHE EM MEMÓRIA SAIU EM 17/09/2026, pra o serviço poder rodar em mais de
// uma instância (item 4 de docs/PENDENCIAS.md).
//
// Ele existia porque a ordem da hora era sorteada com `Math.random()`: sem
// cache, cada poll do player (a cada 15 min) remontava a hora numa ordem
// diferente e a TV pulava. Só que cache em memória do processo é exatamente o
// que NÃO sobrevive a duas instâncias — cada uma guardaria uma ordem, e o
// aparelho receberia uma ou outra conforme quem respondesse ao poll.
//
// A saída não foi mover o cache pra uma tabela: foi tirar a razão dele. O
// embaralhamento passou a ser semeado por (aparelho, hora) em
// `src/lib/pacing.js`, então a hora de uma tela é SEMPRE a mesma ordem —
// calculada por qualquer instância, e igual depois de reiniciar o servidor.
// Uma peça a menos, não uma peça diferente.
//
// Gerar de novo também não infla contador: `gravarProgramados` é um upsert com
// `DO UPDATE SET` (não incrementa), e com a ordem estável o valor gravado é o
// mesmo.
router.get('/playlist/:dispositivoId', exigirAparelho, async (req, res) => {
  const hora = new Date();
  hora.setMinutes(0, 0, 0);
  res.json(await gerarPlaylistDaHora(req.dispositivo, hora));
});

module.exports = router;
