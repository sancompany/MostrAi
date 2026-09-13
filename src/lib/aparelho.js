const dispositivosRepo = require('../dispositivos/repository');

// Autentica a TV pela chave do dispositivo (migration 019: a chave saiu de
// pontos.aparelho_id e foi pra dispositivos.aparelho_id — um ponto pode ter
// várias telas). Sem isso, /playlist e /player eram públicos e qualquer um
// inflava as exibições cobradas do anunciante
// (docs/erros/2026-09-player-publico-inflava-exibicoes.md).
//
// A chave vai no header X-Aparelho-Id (ou ?chave= na URL, porque a TV abre a
// página por URL e o player guarda a chave no localStorage depois).
async function exigirAparelho(req, res, next) {
  const dispositivo = await dispositivosRepo.buscarComPonto(req.params.dispositivoId);
  if (!dispositivo) return res.status(404).json({ erro: 'tela não encontrada' });

  const enviada = req.headers['x-aparelho-id'] || req.query.chave;
  if (!dispositivo.aparelho_id || !enviada || String(enviada) !== dispositivo.aparelho_id) {
    return res.status(401).json({ erro: 'aparelho não autorizado — gere a chave da tela no painel admin' });
  }
  req.dispositivo = dispositivo;
  next();
}

module.exports = { exigirAparelho };
