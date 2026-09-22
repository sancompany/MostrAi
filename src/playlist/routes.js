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
// `gerarPlaylistDaHora` sempre devolve o envelope novo (contrato 2, migration
// 065) — quem decide qual forma sai daqui é `contrato_playlist`, POR TELA
// (docs/api.md). O player web (`public/player.page.js`) só sabe ler o array
// de sempre, então toda tela nasce em 1 e continua assim até alguém marcar
// o contrato novo no admin (telas com o app Android nativo instalado).
router.get('/playlist/:dispositivoId', exigirAparelho, async (req, res) => {
  const hora = new Date();
  hora.setMinutes(0, 0, 0);
  const envelope = await gerarPlaylistDaHora(req.dispositivo, hora);
  if (req.dispositivo.contrato_playlist === 2) return res.json(envelope);
  res.json(
    envelope.itens.map((item) => ({
      anuncianteId: item.anuncianteId,
      autoanuncio: item.autoanuncio,
      institucional: item.institucional,
      url: item.url,
      duracaoSegundos: item.duracaoSegundos,
    })),
  );
});

module.exports = router;
