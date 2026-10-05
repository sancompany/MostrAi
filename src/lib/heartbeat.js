// CADÊNCIA DO HEARTBEAT — fonte única no backend (docs/player-mvp-contract.md §5).
//
// O Player (sancompany/Playlist.MostrAi, `Produto.INTERVALO_HEARTBEAT_MS`)
// bate a cada 15 s desde a 2.0.0 (26/09/2026). O "5 min" que já apareceu
// aqui era o APK 0.1.0/1.0.0 (`PlayerActivity.INTERVALO_HEARTBEAT_MS`), que
// nunca falou com este contrato — conferido em 05/10/2026 no histórico do
// Player e na produção (zero telas). Mudar a cadência é mudar o contrato §5,
// esta constante e a do Player juntos.
const INTERVALO_HEARTBEAT_MS = 15 * 1000;

// Batidas perdidas toleradas antes de "sem comunicação": 8 × 15 s = 2 min —
// aguenta uma rede que oscila sem chamar de offline uma tela saudável. A MESMA
// régua fecha o intervalo de tempo operacional pelo heartbeat
// (src/player/operacao.js): enquanto a tela está "conectada", o intervalo
// segue; sem comunicação, fecha. `TELA_SEM_SINAL_MIN` sobrescreve (minutos).
const BATIDAS_TOLERADAS = 8;
const TOLERANCIA_SEM_SINAL_MS =
  (Number(process.env.TELA_SEM_SINAL_MIN) || 0) * 60 * 1000 || BATIDAS_TOLERADAS * INTERVALO_HEARTBEAT_MS;

module.exports = { INTERVALO_HEARTBEAT_MS, BATIDAS_TOLERADAS, TOLERANCIA_SEM_SINAL_MS };
