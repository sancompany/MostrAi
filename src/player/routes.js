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

// Margens da safe area (migration 069) pegam carona no heartbeat — a TV já
// chama isso a cada 5min (public/player.page.js), então não precisa de
// endpoint novo nem de mudar o contrato de /playlist (que continua igual
// pras telas já no ar, contrato 1 ou 2). Unidade vmin, mesma que o player
// já usava num valor só (?margem=N).
router.post('/player/:dispositivoId/heartbeat', exigirAparelho, async (req, res) => {
  // `erro` (migration 074) é um texto curto que o player manda quando algo deu
  // errado do lado dele (ex.: falha ao baixar playlist) — vira ultimo_erro,
  // parte da régua de status-tela.js. Ausente/vazio limpa o que já existia.
  const erro = typeof req.body.erro === 'string' ? req.body.erro.slice(0, 500) : null;
  await dispositivosRepo.marcarOnline(req.dispositivo.id, erro);
  const { margem_superior, margem_direita, margem_inferior, margem_esquerda } = req.dispositivo;
  res.json({
    ok: true,
    margens: {
      superior: Number(margem_superior) || 0,
      direita: Number(margem_direita) || 0,
      inferior: Number(margem_inferior) || 0,
      esquerda: Number(margem_esquerda) || 0,
    },
  });
});

module.exports = router;
