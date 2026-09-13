// Limitador de tentativas por IP+rota. Sem isso, /admin/login aceitava
// tentativas ilimitadas contra uma senha de 10 caracteres, e dava pra varrer
// uma lista de e-mails pelo 409 do cadastro.
//
// ponytail: contagem em memória do processo — some no restart e não é
// compartilhada entre instâncias. Resolve o ataque real (força bruta de uma
// origem só); se um dia rodar em várias instâncias, mover pra tabela/redis.
const JANELA_MS = 15 * 60 * 1000;
const MAX = 10;
const tentativas = new Map();

function limpar(agora) {
  for (const [chave, dados] of tentativas) {
    if (agora - dados.desde > JANELA_MS) tentativas.delete(chave);
  }
}

function limiteTentativas(req, res, next) {
  const agora = Date.now();
  if (tentativas.size > 5000) limpar(agora);

  const chave = `${req.ip}:${req.path}`;
  const dados = tentativas.get(chave);
  if (!dados || agora - dados.desde > JANELA_MS) {
    tentativas.set(chave, { desde: agora, qtd: 1 });
    return next();
  }
  dados.qtd += 1;
  if (dados.qtd > MAX) {
    const faltam = Math.ceil((JANELA_MS - (agora - dados.desde)) / 60000);
    res.setHeader('Retry-After', faltam * 60);
    return res.status(429).json({ erro: `muitas tentativas — espere ${faltam} minuto(s) e tente de novo` });
  }
  next();
}

// Chamado depois de um login que deu certo, pra não punir quem só errou a
// senha uma vez antes de acertar.
function zerarTentativas(req) {
  tentativas.delete(`${req.ip}:${req.path}`);
}

module.exports = { limiteTentativas, zerarTentativas };
