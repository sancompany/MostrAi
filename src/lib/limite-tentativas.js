const crypto = require('node:crypto');
const pool = require('../db/pool');
const cofre = require('./cofre');
const { segredoConfere } = require('./segredo');

// Limitador de tentativas por IP+rota e, nos logins e no esqueci-senha,
// também por conta+rota.
// Sem isso, /admin/login aceitava tentativas ilimitadas contra uma senha de
// 10 caracteres, e dava pra varrer uma lista de e-mails pelo 409 do cadastro.
//
// A CONTAGEM VIVE NO BANCO desde 17/09/2026 (migration 051). Era um `Map` na
// memória do processo, e isso tem dois defeitos que só aparecem quando o
// serviço cresce: com N instâncias o teto vira N×10 sem ninguém perceber (o
// balanceador espalha as tentativas e cada processo conta as suas), e o
// contador zera a cada deploy. Nenhum dos dois falha barulhento — falham
// deixando a porta mais aberta do que o número escrito aqui promete.
const JANELA_MS = 15 * 60 * 1000;
const MAX = 10;

// O contador é `UPDATE ... RETURNING` num INSERT com conflito, numa ida só ao
// banco. A cláusula do UPDATE decide, no próprio SQL, se a janela anterior
// expirou: se expirou, reinicia em 1; se não, soma 1. Fazer isso em dois
// passos (ler, decidir, gravar) abriria a corrida clássica — duas tentativas
// simultâneas leem 9, as duas gravam 10, e passam as duas.
async function contar(chave) {
  const { rows } = await pool.query(
    `INSERT INTO tentativas_acesso (chave, quantidade, desde)
          VALUES ($1, 1, now())
     ON CONFLICT (chave) DO UPDATE
            SET quantidade = CASE WHEN tentativas_acesso.desde < now() - ($2 || ' milliseconds')::interval
                                  THEN 1 ELSE tentativas_acesso.quantidade + 1 END,
                desde      = CASE WHEN tentativas_acesso.desde < now() - ($2 || ' milliseconds')::interval
                                  THEN now() ELSE tentativas_acesso.desde END
       RETURNING quantidade, desde`,
    [chave, JANELA_MS],
  );
  return rows[0];
}

// Limpeza oportunista, no caminho da própria requisição: sem job pra manter
// vivo e sem tabela crescendo pra sempre. 1 em 100 é raro o bastante pra não
// pesar e frequente o bastante pra não acumular.
async function limparDeVezEmQuando() {
  if (Math.random() > 0.01) return;
  await pool
    .query(`DELETE FROM tentativas_acesso WHERE desde < now() - ($1 || ' milliseconds')::interval`, [JANELA_MS])
    .catch(() => {});
}

// A REGRA, separada do armazenamento: função pura, sem banco e sem relógio
// escondido. É ela que os testes exercem — o resto aqui é adaptador. Enquanto
// a contagem vivia num Map, regra e armazenamento eram a mesma coisa e o
// teste só existia porque tudo era síncrono; ao mover pro banco, ou a suíte
// inteira passava a precisar de Postgres, ou a regra saía de dentro do I/O.
function decidir({ quantidade, desde, agora = Date.now() }) {
  if (quantidade <= MAX) return { bloquear: false };
  const faltam = Math.max(1, Math.ceil((JANELA_MS - (agora - new Date(desde).getTime())) / 60000));
  return { bloquear: true, faltamMinutos: faltam };
}

// A rota da chave: a ROTA COMO FOI DECLARADA, nunca o caminho como o cliente
// escreveu. Sem `case sensitive routing`/`strict routing` (padrão do
// Express), `/Anunciantes/login`, `/anunciantes/login/` e `/ANUNCIANTES/LOGIN`
// caem no MESMO handler que `/anunciantes/login` — e chavear por `req.path`
// dava um balde novo de 10 a cada grafia, força bruta sem teto trocando uma
// letra. `req.route.path` é o caminho registrado (`router.post('/x', …)`), o
// Express o preenche antes dos middlewares da rota; por isso este limitador
// só serve como middleware DE ROTA, nunca em `app.use`.
function rotaDe(req) {
  if (!req.route) throw new Error('limiteTentativas só funciona como middleware de rota (req.route vazio)');
  return req.route.path;
}

// DOIS BALDES, cada um com o teto MAX na janela; estourar QUALQUER um dá 429.
//   · IP+rota, sempre: segura quem tenta MUITAS contas de um lugar só
//     (credential stuffing, um e-mail vazado a cada chute; varredura de telas
//     no provisionar).
//   · ALVO+rota, onde a rota mira uma conta (os dois logins, pelo e-mail ou
//     usuário; o esqueci-senha, pelo e-mail): segura quem mira UMA conta de
//     muitos lugares. Só o balde do IP não basta — quem tem muitos endereços
//     (um /48 IPv6 de túnel gratuito são 65.536 /64) ganhava 10 chutes, ou 10
//     e-mails de redefinição, por endereço contra a MESMA vítima.
// Um balde não substitui o outro: pôr o alvo DENTRO da chave do IP trocava
// "10 por IP" por "10 por alvo", e o stuffing ficava sem teto.
// Em SEQUÊNCIA, o do IP primeiro: o pedido que o IP já barrou não chega à
// senha e não conta contra a conta. Somar os dois em todo pedido deixava um
// IP só, já estourado, encher de novo o balde da conta a cada janela.
// O alvo entra na chave como HMAC com a chave do servidor (cofre.assinar): a
// tabela não guarda o e-mail tentado (nem uma senha digitada no campo do
// usuário), e o tamanho da chave não depende do que o cliente mandou.
//
// O balde da conta trava a dona junto com quem chuta — a senha certa também
// recebe 429, senão o 429 diria ao atacante quando ele acertou —, e uma
// origem só, repetindo 10 erros a cada janela, mantém a trava pelo tempo que
// quiser. Por isso o APARELHO CONHECIDO (OWASP, "device cookies"): o
// navegador em que a conta já entrou traz o cookie `mostrai.aparelho`, e o
// pedido com ele conta num balde DELE (`aparelho:…`), não no da conta. Quem
// chuta não tem o cookie e não enche esse balde; quem o roubou tem o mesmo
// teto de 10. Quem entra de aparelho novo durante o ataque redefine a senha:
// a redefinição zera o balde da conta e marca o aparelho (liberarConta).
const BALDES = Symbol('baldes do limitador');
const COOKIE_APARELHO = 'mostrai.aparelho';
const LER_APARELHO = /(?:^|;\s*)mostrai\.aparelho=([0-9a-f]{32})\.([0-9a-f]{64})(?:;|$)/;
const VALIDADE_APARELHO_MS = 90 * 24 * 3600 * 1000; // renovado a cada login certo

const chaveDaConta = (alvo, rota) => `alvo:${cofre.assinar(alvo, 'limite-tentativas')}:${rota}`;

// O cookie é `<sorteio>.<HMAC(rota, alvo, sorteio)>`, com a chave do
// servidor: vale só pra conta e a rota em que nasceu (o cookie da conta do
// atacante não abre o balde da vítima), não se forja sem a chave e não leva
// nada legível — nem o e-mail. Sem estado no banco: a assinatura confere.
const assinarAparelho = (alvo, rota, sorteio) => cofre.assinar(`${rota}\n${alvo}\n${sorteio}`, 'aparelho-conhecido');

async function limitar(req, res, next, alvo) {
  // Fora do try: rota sem `req.route` é erro de programação, não banco fora —
  // tem que falhar fechado, não abrir a porta com um aviso no log.
  const rota = rotaDe(req);
  const cookie = alvo && LER_APARELHO.exec(req.get('cookie') || '');
  const aparelho = cookie && segredoConfere(cookie[2], assinarAparelho(alvo, rota, cookie[1])) ? cookie[2] : null;
  const baldes = {
    ip: `${req.ip}:${rota}`,
    conta: alvo ? chaveDaConta(alvo, rota) : null,
    aparelho: aparelho ? `aparelho:${aparelho}:${rota}` : null,
    alvo,
    rota,
  };
  req[BALDES] = baldes;
  try {
    limparDeVezEmQuando();
    for (const [chave, motivo] of [
      [baldes.ip, 'origem'],
      [baldes.aparelho ?? baldes.conta, 'conta'],
    ]) {
      if (!chave) continue;
      const v = decidir(await contar(chave));
      if (v.bloquear) {
        res.setHeader('Retry-After', v.faltamMinutos * 60);
        // `motivo` diz qual balde estourou, pra tela dizer o que fazer: no da
        // conta, esperar pode não bastar (quem chuta repete) e redefinir a
        // senha libera. Não revela cadastro: o balde existe pra qualquer alvo.
        return res
          .status(429)
          .json({ erro: `muitas tentativas — espere ${v.faltamMinutos} minuto(s) e tente de novo`, motivo });
      }
    }
    next();
  } catch (err) {
    // Banco fora não pode virar porta trancada: /admin/login e o login do
    // anunciante ficariam inacessíveis por causa do CONTADOR, não da senha. O
    // caminho autenticado logo abaixo depende do mesmo banco e vai falhar
    // sozinho, com o erro certo.
    console.error('limite de tentativas indisponível:', err.message);
    next();
  }
}

// Middleware de rota: só o balde do IP.
function limiteTentativas(req, res, next) {
  return limitar(req, res, next, '');
}

// Middleware de rota: o balde do IP E o do alvo que `alvoDe(req)` devolve,
// resolvido como a rota resolve a conta (e-mail normalizado como o repo
// compara, senão "Vitima@x" abria balde novo). Alvo vazio: só o do IP. Nos
// logins, onde o segredo (a senha) não morre com o erro, e no esqueci-senha,
// onde cada pedido manda um e-mail pra conta. Confirmar-email/troca e o
// provisionar já têm teto POR ALVO no próprio código (5 erros e o código
// morre — src/email/codigos.js, src/dispositivos/repository.js), e a
// redefinição de senha usa token de 256 bits, não segredo curto.
function limiteTentativasPorAlvo(alvoDe) {
  return (req, res, next) => limitar(req, res, next, alvoDe(req));
}

// A conta provou ser de quem está aqui: zera o balde dela na `rota` e marca
// este navegador como aparelho conhecido. Usado no login certo (via
// descontarAcerto) e na redefinição de senha pelo link do e-mail — sem isso,
// quem mantinha a conta travada travava também a volta da dona com a senha
// nova.
async function liberarConta(res, alvo, rota) {
  const sorteio = crypto.randomBytes(16).toString('hex');
  res.cookie(COOKIE_APARELHO, `${sorteio}.${assinarAparelho(alvo, rota, sorteio)}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: rota, // só viaja pra rota de login em que nasceu
    maxAge: VALIDADE_APARELHO_MS,
  });
  await pool.query('DELETE FROM tentativas_acesso WHERE chave = $1', [chaveDaConta(alvo, rota)]);
}

// Chamado depois de um acerto (login, código de e-mail, instalação de tela).
// No balde do IP desconta SÓ a tentativa que acertou: quem errou e acertou
// não paga pelo acerto, e os acertos de várias contas atrás do mesmo IP
// (escritório, NAT) não gastam o teto. Os ERROS ficam: antes isto apagava o
// balde, que é o mesmo pra toda conta naquele IP+rota, e 9 chutes na vítima +
// 1 login certo na conta do próprio atacante reiniciavam a contagem (AUD-003).
// O balde da CONTA que acertou (e o do aparelho, se veio com cookie), estes
// zeram, e o aparelho ganha cookie novo: quem acertou a senha da conta não
// carrega os erros antigos contra ela. Só o dela — o da vítima ninguém zera
// sem a senha da vítima. `res` é a resposta ainda não enviada: o cookie novo
// sai nela.
async function descontarAcerto(req, res) {
  const baldes = req[BALDES];
  if (!baldes) throw new Error('descontarAcerto sem limiteTentativas na rota');
  try {
    await Promise.all([
      pool.query('UPDATE tentativas_acesso SET quantidade = quantidade - 1 WHERE chave = $1 AND quantidade > 0', [
        baldes.ip,
      ]),
      baldes.alvo && liberarConta(res, baldes.alvo, baldes.rota),
      baldes.aparelho && pool.query('DELETE FROM tentativas_acesso WHERE chave = $1', [baldes.aparelho]),
    ]);
  } catch (err) {
    console.error('limite de tentativas: desconto do acerto falhou:', err.message);
  }
}

module.exports = {
  limiteTentativas,
  limiteTentativasPorAlvo,
  descontarAcerto,
  liberarConta,
  decidir,
  MAX,
  JANELA_MS,
};
