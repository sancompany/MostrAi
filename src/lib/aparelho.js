const dispositivosRepo = require('../dispositivos/repository');
const credencial = require('../player/credencial');

// Autenticação das rotas da tela (docs/player-mvp-contract.md §4). Sem
// sessão web: a credencial é a chave do aparelho, conferida por hash.
//
// - `:dispositivoId` é o ID da tela ("M-0235"; "0235" e "235" também valem).
// - Chave só em `X-Aparelho-Key`. Nunca por query string: URL vai parar em
//   log.
// - Vazia, errada ou de outra tela → 401, sem dizer qual dos três (não
//   ajuda quem está adivinhando). Tela inexistente e ponto arquivado também
//   são 401: para o Player, 401 = "reinstale".
//
// `operacao: true` (playlist, played): além da chave, a tela precisa estar
// Ativa — tela em reparo/inativa não recebe programação nem gera cobrança
// (docs/erros/2026-09-player-publico-inflava-exibicoes.md). Heartbeat e
// config não exigem: o admin continua vendo a tela viva durante um reparo.
const NAO_AUTORIZADO = { erro: 'aparelho não autorizado — reprovisione a tela pelo admin' };

// "1.0.0+2" → { versao: '1.0.0', build: 2 }
function lerVersao(texto) {
  if (typeof texto !== 'string') return { versao: null, build: null };
  const m = texto.trim().match(/^([0-9A-Za-z.\-_]{1,32})\+(\d{1,9})$/);
  if (!m) return { versao: texto.trim().slice(0, 32) || null, build: null };
  return { versao: m[1], build: Number(m[2]) };
}

// Versão do Player: só pelo header (contrato §5).
const lerPlayer = (req) => lerVersao(req.get('x-player-version'));

function exigirAparelho({ operacao = true } = {}) {
  return async (req, res, next) => {
    const tela = await dispositivosRepo.buscarComPonto(req.params.dispositivoId);
    if (!tela || tela.ponto_status === 'arquivado') return res.status(401).json(NAO_AUTORIZADO);

    const enviada = req.get('x-aparelho-key');
    const qual = credencial.identificarChave(tela, enviada);
    if (!qual) return res.status(401).json(NAO_AUTORIZADO);

    if (operacao && tela.status !== 'ativo') {
      return res.status(403).json({ erro: 'esta tela está fora do ar no cadastro — fale com a Mostraí pra reativar' });
    }
    // Candidata de rotação: o Player só a oficializa numa resposta de
    // sucesso e a descarta em qualquer outra (contrato §1.1). Então o
    // servidor promove exatamente aí: na hora de mandar uma resposta 2xx e
    // antes de ela sair. 400/403/500 do handler não promovem; promoção que
    // falha vira 503 (o Player repete 5xx com a chave antiga, a candidata
    // segue pendente). Se a resposta 2xx se perder na rede, a chave
    // promovida volta no heartbeat seguinte (credencial.promoverChaveNova).
    if (qual === 'nova') {
      const responder = res.json.bind(res);
      const hashAtualLido = tela.chave_hash;
      res.json = (corpo) => {
        if (res.statusCode < 200 || res.statusCode >= 300) return responder(corpo);
        credencial.promoverChaveNova(tela.id, enviada, hashAtualLido).then(
          () => responder(corpo),
          (err) => {
            console.error('promoção da chave candidata falhou:', err.code || err.name);
            res.status(503);
            responder({ erro: 'tente de novo em instantes' });
          },
        );
        return res;
      };
    } else if (qual === 'atual' && tela.chave_atual_cifrada) {
      await credencial.esquecerCopiaDaAtual(tela.id);
    }
    // Primeira requisição com a credencial do provisionamento: o Player
    // provou que a recebeu, a janela de repetição do token fecha.
    if (tela.provisionado_em && !tela.chave_ultimo_uso_em) await dispositivosRepo.fecharJanelaDoToken(tela.id);
    await credencial.registrarUso(tela.id);

    req.dispositivo = tela;
    req.chaveUsada = qual;
    req.player = lerPlayer(req);
    next();
  };
}

module.exports = { exigirAparelho, lerPlayer, lerVersao };
