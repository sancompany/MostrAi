const express = require('express');
const router = express.Router();
const { exigirAparelho } = require('../lib/aparelho');
const { gerarPlaylistDaHora } = require('./gerador');
const pool = require('../db/pool');
const { registrarPrimeiroContato } = require('../player/sinal');

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
// `gerarPlaylistDaHora` sempre devolve o envelope (contrato 2, migration
// 065). O formato de saída sai do próprio Player: quem manda
// `X-Player-Contract` >= 2 (Player V2) recebe o envelope com `contentHash`;
// sem o header, compat-v1 — `contrato_playlist` da tela (padrão 1, o array
// que o player web `public/player.page.js` e o Android antigo leem).

// Folga contra a corrida entre a geração e uma mudança commitada durante ela
// (o gatilho da migration 083 marca com o relógio do statement, antes do
// commit): só limpa marcas feitas antes do início da geração menos isto.
const FOLGA_DESATUALIZADA_MS = 5000;

router.get('/playlist/:dispositivoId', exigirAparelho(), async (req, res) => {
  // Início pelo relógio do BANCO: as marcas de "desatualizada" são
  // `clock_timestamp()` do gatilho; comparar com o relógio do Node deixaria a
  // folga à mercê do desvio entre as duas máquinas.
  const {
    rows: [{ inicio }],
  } = await pool.query('SELECT clock_timestamp() AS inicio');
  if (!req.dispositivo.primeiro_sinal_em) await registrarPrimeiroContato(req.dispositivo.id);
  const hora = new Date();
  hora.setMinutes(0, 0, 0);
  const envelope = await gerarPlaylistDaHora(req.dispositivo, hora);
  // Entregue: a marca de "playlist desatualizada" anterior a esta geração
  // está resolvida — nunca fica true pra sempre.
  await pool.query(
    `UPDATE dispositivos
        SET playlist_entregue_em = now(),
            playlist_desatualizada_em = CASE WHEN playlist_desatualizada_em <= $2::timestamptz - ($3::int * interval '1 millisecond')
                                             THEN NULL ELSE playlist_desatualizada_em END
      WHERE id = $1`,
    [req.dispositivo.id, inicio, FOLGA_DESATUALIZADA_MS],
  );
  if ((req.player.contrato || 0) >= 2 || req.dispositivo.contrato_playlist === 2) return res.json(envelope);
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
