const test = require('node:test');
const assert = require('node:assert');
const { randomBytes, randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');
const { MAX } = require('../src/lib/limite-tentativas');

// Limitador de tentativas na rota HTTP de verdade (auditoria Review-Master,
// ciclo 1, grupo A-limitador — AUD-002, AUD-003 e AUD-004). O unit de
// `decidir()` em tests/seguranca.test.js prova a regra; aqui são os BALDES
// que estão em jogo, e eles só existem com o app real: a grafia do caminho
// que o Express aceita, o acerto que o login desconta, a conta tentada e o IP
// que o proxy entrega.

process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-limite';
const app = require('../src/server');
const cofre = require('../src/lib/cofre');

// Rede própria por execução: o banco de teste é compartilhado, e cada arquivo
// limpa só as próprias chaves (o servidor confia em 1 proxy, X-Forwarded-For).
// 198.18.0.0/15 (faixa de benchmark) e não 10.x: outros arquivos apagam
// `10.%` no after (player-mvp, distribuicao), e `npm test` roda em paralelo —
// a limpeza deles no meio do laço daqui zerava o balde e o 429 não vinha.
const REDE = `198.${18 + Math.floor(Math.random() * 2)}.${Math.floor(Math.random() * 250)}`;
const ip = (n) => `${REDE}.${n}`;
// Uma borda da Cloudflare de verdade (104.16.0.0/13, cloudflare.com/ips-v4),
// sorteada por execução: o limitador só lê CF-Connecting-IP quando o salto
// que o ingress viu (`req.ip`) é da Cloudflare.
const BORDA = `104.${16 + Math.floor(Math.random() * 8)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const viaBorda = (cliente) => ({ 'x-forwarded-for': `${cliente}, ${BORDA}`, 'cf-connecting-ip': cliente });
// Um /48 de documentação (2001:db8::/32) por execução, pros testes de IPv6.
const IPV6 = `2001:db8:${Math.floor(Math.random() * 0xfff0).toString(16)}`;
// "Um lugar novo" pro balde do IP: o /64 número n dentro do MESMO /48, via
// borda da Cloudflare — o atacante que tem um prefixo IPv6 grande.
const lugar = (n) => viaBorda(`${IPV6}:${(0x100 + n).toString(16)}::1`);

let srv;
test.before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  srv = {
    base: `http://127.0.0.1:${server.address().port}`,
    fechar: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
});

// O balde da conta é `alvo:<HMAC do e-mail normalizado ou do usuário>:<rota>`
// (src/lib/limite-tentativas.js). Os alvos daqui são únicos por execução e
// saem no after pela chave exata, como as redes acima.
const chaveDoAlvo = (alvo, rota) => `alvo:${cofre.assinar(alvo, 'limite-tentativas')}:${rota}`;
const alvos = [];
const contas = [];
// Assinaturas dos cookies de aparelho conhecido que as respostas emitiram: o
// balde de um aparelho é `aparelho:<assinatura>:<rota>`.
const aparelhos = [];
test.after(async () => {
  await srv.fechar();
  for (const id of contas) {
    // A redefinição de senha põe o aviso "senha alterada" na fila.
    await pool.query('DELETE FROM email_outbox WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM tokens_senha WHERE usuario_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  for (const padrao of [`${REDE}.%`, `${BORDA}:%`, `${IPV6}:%`]) {
    await pool.query('DELETE FROM tentativas_acesso WHERE chave LIKE $1', [padrao]);
  }
  for (const [alvo, rota] of alvos) {
    await pool.query('DELETE FROM tentativas_acesso WHERE chave = $1', [chaveDoAlvo(alvo, rota)]);
  }
  for (const assinatura of aparelhos) {
    await pool.query('DELETE FROM tentativas_acesso WHERE chave = $1', [`aparelho:${assinatura}:/anunciantes/login`]);
  }
  await pool.end();
});

async function post(caminho, corpo, cabecalhos) {
  return (await postCompleto(caminho, corpo, cabecalhos)).status;
}

// Como `post`, com o corpo e o cookie de aparelho conhecido
// (`mostrai.aparelho=…`, pronto pro cabeçalho Cookie) que a resposta emitir.
async function postCompleto(caminho, corpo, cabecalhos) {
  const r = await fetch(`${srv.base}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabecalhos },
    body: JSON.stringify(corpo),
    redirect: 'manual',
  });
  const cabecalho = r.headers.getSetCookie().find((c) => c.startsWith('mostrai.aparelho='));
  const aparelho = cabecalho?.split(';')[0];
  if (aparelho) aparelhos.push(aparelho.split('.').at(-1));
  return { status: r.status, corpo: await r.json().catch(() => null), aparelho, cabecalho };
}

// Um e-mail sem conta, novo a cada chamada: nenhum alvo se repete, então só o
// balde do IP pode dar o 429 — é o que os testes de IP precisam isolar.
const semConta = () => {
  const email = `ninguem-${randomUUID()}@limite.test`;
  alvos.push([email, '/anunciantes/login']);
  return { email, senha: 'Errada12@' };
};

async function criarConta() {
  const senha = 'Senha12@teste';
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], true)
     RETURNING id, contato_email`,
    [
      `Limite ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `limite-${randomUUID()}@example.com`,
      await gerarHash(senha),
    ],
  );
  contas.push(rows[0].id);
  alvos.push([rows[0].contato_email, '/anunciantes/login']);
  return { ...rows[0], senha };
}

// AUD-002: a chave era `${req.ip}:${req.path}` com o caminho CRU. Sem `case
// sensitive routing`/`strict routing`, `/Anunciantes/login` e
// `/anunciantes/login/` caem no MESMO handler, e cada grafia ganhava um balde
// novo de 10 — força bruta sem teto trocando uma letra.
test('estourado o balde do login, qualquer grafia do mesmo caminho responde 429', async () => {
  const origem = { 'x-forwarded-for': ip(2) };
  for (let i = 1; i <= MAX; i++) {
    assert.strictEqual(await post('/anunciantes/login', semConta(), origem), 401, `tentativa ${i} dentro do limite`);
  }
  assert.strictEqual(await post('/anunciantes/login', semConta(), origem), 429, 'a 11ª estoura');
  assert.strictEqual(await post('/Anunciantes/login', semConta(), origem), 429, 'caixa alta na primeira letra');
  assert.strictEqual(await post('/anunciantes/login/', semConta(), origem), 429, 'barra final');
  assert.strictEqual(await post('/ANUNCIANTES/LOGIN', semConta(), origem), 429, 'tudo maiúsculo');

  // Mesma regra no login do admin (um usuário novo a cada chute, pelo mesmo
  // motivo do semConta).
  const admin = () => {
    const usuario = `ninguem-${randomUUID()}`;
    alvos.push([usuario, '/admin/login']);
    return { usuario, senha: 'errada' };
  };
  for (let i = 1; i <= MAX; i++) assert.strictEqual(await post('/admin/login', admin(), origem), 401);
  assert.strictEqual(await post('/admin/login', admin(), origem), 429);
  assert.strictEqual(await post('/ADMIN/login', admin(), origem), 429, 'caixa alta no admin');
});

// AUD-003: o login certo apagava o balde do IP+rota, que era o MESMO pra toda
// conta. Com uma conta própria (cadastro é público e grátis), 9 chutes + 1
// acerto na própria conta zerava o balde, e o 429 nunca vinha. Agora o acerto
// desconta só a própria tentativa no balde do IP, e não toca no balde de
// outra conta.
test('o login certo de uma conta não zera o balde das tentativas contra outra', async () => {
  const atacante = await criarConta();
  const entrar = (origem) =>
    post('/anunciantes/login', { email: atacante.contato_email, senha: atacante.senha }, origem);

  // Balde do IP: 9 chutes de um IP, cada um num e-mail diferente.
  const origem = { 'x-forwarded-for': ip(3) };
  for (let i = 1; i <= MAX - 1; i++) assert.strictEqual(await post('/anunciantes/login', semConta(), origem), 401);
  assert.strictEqual(await entrar(origem), 200, 'o atacante entra na própria conta');
  assert.strictEqual(await post('/anunciantes/login', semConta(), origem), 401, '10º erro ainda passa');
  assert.strictEqual(await post('/anunciantes/login', semConta(), origem), 429, '11º erro: o acerto não zerou o IP');

  // Balde da vítima: 9 chutes na vítima, cada um de um lugar diferente.
  const vitima = await criarConta();
  const chute = { email: vitima.contato_email, senha: 'Errada12@' };
  const n0 = 20;
  for (let i = 1; i <= MAX - 1; i++) assert.strictEqual(await post('/anunciantes/login', chute, lugar(n0 + i)), 401);
  assert.strictEqual(await entrar(lugar(n0 + MAX)), 200, 'o atacante entra na própria conta');
  assert.strictEqual(await post('/anunciantes/login', chute, lugar(n0 + MAX + 1)), 401, '10º erro na vítima');
  assert.strictEqual(
    await post('/anunciantes/login', chute, lugar(n0 + MAX + 2)),
    429,
    '11º erro na vítima: o acerto de outra conta não zerou o balde dela',
  );
});

// Revisão da 1ª rodada: o teto do IP não pode depender do alvo. A 1ª versão
// do AUD-003 chaveou o login SÓ por IP+e-mail e o provisionar SÓ por IP+tela,
// e credential stuffing (um par e-mail/senha vazado a cada chute) e a
// varredura de telas sequenciais ganhavam um balde novo por alvo.
test('credential stuffing de um IP esbarra no teto, com um e-mail novo a cada chute', async () => {
  const origem = { 'x-forwarded-for': ip(4) };
  for (let i = 1; i <= MAX; i++) assert.strictEqual(await post('/anunciantes/login', semConta(), origem), 401);
  assert.strictEqual(await post('/anunciantes/login', semConta(), origem), 429, 'e-mail novo, mesmo IP');
});

test('o provisionar de um IP esbarra no teto, com uma tela diferente a cada chute', async () => {
  const origem = { 'x-forwarded-for': ip(5) };
  // IDs de tela altos que não existem no banco de teste: 401 sem efeito
  // colateral (não há código pendente pra cancelar nem evento pra gravar).
  const primeira = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
  const chute = (n) => ({ codigoTela: `M-${primeira + n}`, codigoInstalacao: 'ABCD-EFGH' });

  for (let i = 1; i <= MAX; i++) assert.strictEqual(await post('/player/provisionar', chute(i), origem), 401);
  assert.strictEqual(await post('/player/provisionar', chute(MAX + 1), origem), 429, 'tela nova, mesmo IP');
});

// Revisão final da 2ª rodada: com o balde só por IP+rota, quem tem muitos
// endereços (um /48 IPv6 de túnel gratuito são 65.536 /64) ganhava 10 chutes
// por endereço contra a MESMA vítima — força bruta numa conta sem teto. O
// balde da CONTA (alvo+rota) fecha: 10 erros contra ela na janela, venham de
// onde vierem. `lugar(n)` é um endereço novo a cada chute.
test('força bruta numa conta vinda de vários endereços esbarra no balde da conta', async () => {
  const vitima = await criarConta();
  const outra = await criarConta();
  // Grafias do mesmo e-mail: o alvo é o e-mail normalizado, como o login acha a conta.
  const grafias = [vitima.contato_email, vitima.contato_email.toUpperCase(), `  ${vitima.contato_email} `];
  const chute = (n) => ({ email: grafias[n % grafias.length], senha: 'Errada12@' });
  const n0 = 40;

  for (let i = 1; i <= MAX; i++) {
    assert.strictEqual(await post('/anunciantes/login', chute(i), lugar(n0 + i)), 401, `chute ${i}`);
  }
  assert.strictEqual(
    await post('/anunciantes/login', chute(MAX + 1), lugar(n0 + MAX + 1)),
    429,
    'o 11º, de um endereço que nunca tentou nada, esbarra no balde da conta',
  );
  assert.strictEqual(
    await post('/ANUNCIANTES/LOGIN', chute(MAX + 2), lugar(n0 + MAX + 2)),
    429,
    'a grafia do caminho não abre balde novo pra conta',
  );
  assert.strictEqual(
    await post('/anunciantes/login', { email: outra.contato_email, senha: outra.senha }, lugar(n0 + MAX + 1)),
    200,
    'outra conta, do mesmo endereço, entra normalmente',
  );
  // Efeito aceito e documentado: a própria dona fica travada até a janela vencer.
  assert.strictEqual(
    await post('/anunciantes/login', { email: vitima.contato_email, senha: vitima.senha }, lugar(n0 + MAX + 3)),
    429,
    'a senha certa também recebe 429 (senão o 429 entregaria o acerto)',
  );

  // A tabela guarda o HMAC do e-mail, nunca o e-mail.
  const { rows } = await pool.query('SELECT quantidade FROM tentativas_acesso WHERE chave = $1', [
    chaveDoAlvo(vitima.contato_email, '/anunciantes/login'),
  ]);
  assert.strictEqual(rows[0]?.quantidade, MAX + 3, 'um balde só pras 3 grafias e os 2 caminhos');
  const comEmail = await pool.query('SELECT count(*)::int AS n FROM tentativas_acesso WHERE chave ILIKE $1', [
    `%${vitima.contato_email}%`,
  ]);
  assert.strictEqual(comEmail.rows[0].n, 0, 'nenhuma chave com o e-mail em claro');
});

test('o login certo zera o balde da própria conta', async () => {
  const conta = await criarConta();
  const chute = { email: conta.contato_email, senha: 'Errada12@' };
  const n0 = 60;

  for (let i = 1; i <= MAX - 1; i++) assert.strictEqual(await post('/anunciantes/login', chute, lugar(n0 + i)), 401);
  assert.strictEqual(
    await post('/anunciantes/login', { email: conta.contato_email, senha: conta.senha }, lugar(n0 + MAX)),
    200,
    'a dona entra',
  );
  for (let i = 1; i <= MAX; i++) {
    assert.strictEqual(
      await post('/anunciantes/login', chute, lugar(n0 + MAX + i)),
      401,
      `erro ${i} depois do acerto: o balde recomeçou do zero`,
    );
  }
  assert.strictEqual(await post('/anunciantes/login', chute, lugar(n0 + 2 * MAX + 1)), 429);
});

// Mesmo balde no admin, pelo USUÁRIO digitado. Não dá pra usar o ADMIN_USER
// de verdade aqui: o banco de teste é compartilhado e os outros arquivos
// entram como admin em paralelo — travá-lo derrubaria a suíte deles.
test('força bruta no admin vinda de vários endereços esbarra no balde do usuário', async () => {
  const usuario = `admin-${randomUUID()}`;
  alvos.push([usuario, '/admin/login']);
  const chute = { usuario, senha: 'errada' };
  const n0 = 120;

  for (let i = 1; i <= MAX; i++) assert.strictEqual(await post('/admin/login', chute, lugar(n0 + i)), 401);
  assert.strictEqual(await post('/admin/login', chute, lugar(n0 + MAX + 1)), 429);
});

// Revisão da rodada 3: todo pedido somava no balde da conta, inclusive o que
// o balde do IP já tinha barrado com 429. Um IP só mantinha a conta travada
// pra sempre: 11 chutes por janela, e na janela seguinte os 429 dele (IP
// ainda estourado) enchiam de novo o balde da conta. Agora os baldes vão em
// sequência: o pedido que o IP barrou não chega à senha e não conta contra
// a conta — uma origem põe no máximo MAX por janela no balde de uma conta.
test('o pedido que o balde do IP barrou não conta contra a conta', async () => {
  const dona = await criarConta();
  const chave = chaveDoAlvo(dona.contato_email, '/anunciantes/login');
  const naConta = async () =>
    (await pool.query('SELECT quantidade FROM tentativas_acesso WHERE chave = $1', [chave])).rows[0]?.quantidade;
  const atacante = { 'x-forwarded-for': ip(11) };
  const chute = { email: dona.contato_email, senha: 'Errada12@' };

  const status = [];
  for (let i = 1; i <= MAX + 1; i++) status.push(await post('/anunciantes/login', chute, atacante));
  assert.deepStrictEqual(status, [...Array(MAX).fill(401), 429], 'o 11º esbarra no balde do IP');
  assert.strictEqual(await naConta(), MAX, 'o 11º, barrado pelo IP, não entrou no balde da conta');

  // A janela da conta vence; o IP do atacante continua estourado.
  await pool.query("UPDATE tentativas_acesso SET desde = now() - interval '16 minutes' WHERE chave = $1", [chave]);
  for (let i = 1; i <= MAX + 1; i++) assert.strictEqual(await post('/anunciantes/login', chute, atacante), 429);
  assert.strictEqual(
    await post('/anunciantes/login', { email: dona.contato_email, senha: dona.senha }, lugar(12)),
    200,
    'a dona entra: os 429 do IP estourado não encheram de novo o balde da conta',
  );
});

// Revisão da rodada 3: o balde da conta trava a dona junto com quem chuta (a
// senha certa também recebe 429, senão o 429 entregaria o acerto), e uma
// origem só, repetindo 10 erros a cada janela, mantém a trava. O navegador em
// que a conta já entrou traz o cookie de aparelho conhecido (OWASP, "device
// cookies"), e o pedido com ele conta num balde DELE, não no da conta: quem
// chuta não tem o cookie e não o enche.
test('o aparelho onde a conta já entrou não fica preso no balde da conta', async () => {
  const dona = await criarConta();
  const outra = await criarConta();
  const entrar = (conta, origem, cookie) =>
    postCompleto(
      '/anunciantes/login',
      { email: conta.contato_email, senha: conta.senha },
      { ...origem, ...(cookie ? { cookie } : {}) },
    );

  const primeira = await entrar(dona, lugar(140));
  assert.strictEqual(primeira.status, 200);
  assert.ok(primeira.aparelho, 'o login certo marca o aparelho');
  for (const atributo of ['Path=/anunciantes/login', 'HttpOnly', 'SameSite=Strict', `Max-Age=${90 * 24 * 3600}`]) {
    assert.ok(primeira.cabecalho.includes(atributo), `cookie com ${atributo}: ${primeira.cabecalho}`);
  }
  const daOutraConta = (await entrar(outra, lugar(141))).aparelho;

  const chute = { email: dona.contato_email, senha: 'Errada12@' };
  for (let i = 1; i <= MAX; i++) assert.strictEqual(await post('/anunciantes/login', chute, lugar(141 + i)), 401);
  const deAparelhoNovo = await entrar(dona, lugar(152));
  assert.deepStrictEqual(
    [deAparelhoNovo.status, deAparelhoNovo.corpo?.motivo],
    [429, 'conta'],
    'de aparelho novo a dona espera (efeito aceito), e o 429 diz que o balde é o da conta',
  );
  assert.strictEqual((await entrar(dona, lugar(153), daOutraConta)).status, 429, 'o cookie de OUTRA conta não serve');
  const forjado = `mostrai.aparelho=${'0'.repeat(32)}.${'f'.repeat(64)}`;
  assert.strictEqual((await entrar(dona, lugar(154), forjado)).status, 429, 'cookie forjado não serve');
  const doAparelho = await entrar(dona, lugar(155), primeira.aparelho);
  assert.strictEqual(doAparelho.status, 200, 'do aparelho onde já entrou, a dona entra');

  // O cookie não é passe livre: os erros feitos com ele contam no balde
  // dele, com o mesmo teto — e não no da conta.
  const cookie = doAparelho.aparelho;
  for (let i = 1; i <= MAX; i++) {
    assert.strictEqual(await post('/anunciantes/login', chute, { ...lugar(155 + i), cookie }), 401);
  }
  const estourado = await postCompleto('/anunciantes/login', chute, { ...lugar(166), cookie });
  assert.deepStrictEqual([estourado.status, estourado.corpo?.motivo], [429, 'conta'], 'o balde do aparelho estoura');
  assert.strictEqual((await entrar(dona, lugar(167))).status, 200, 'o balde da conta ficou de fora');
});

// Revisão da rodada 3: redefinir a senha não destravava — /redefinir-senha
// não tocava o balde da conta, e a dona, com a senha NOVA, seguia com 429.
// Quem redefiniu provou ter o e-mail: o balde da conta no login zera e o
// navegador em que ela redefiniu vira aparelho conhecido.
test('redefinir a senha zera o balde da conta e marca o aparelho', async () => {
  const dona = await criarConta();
  const chute = { email: dona.contato_email, senha: 'Errada12@' };
  const travar = async (n0) => {
    for (let i = 1; i <= MAX; i++) assert.strictEqual(await post('/anunciantes/login', chute, lugar(n0 + i)), 401);
  };
  await travar(170);
  assert.strictEqual(
    await post('/anunciantes/login', { email: dona.contato_email, senha: dona.senha }, lugar(181)),
    429,
  );

  // O link que chega no e-mail da dona (gravado como o esqueci-senha grava).
  const token = randomBytes(32).toString('hex');
  await pool.query(
    "INSERT INTO tokens_senha (token, tipo, usuario_id, expira_em) VALUES ($1, 'anunciante', $2, now() + interval '1 hour')",
    [token, dona.id],
  );
  const nova = { email: dona.contato_email, senha: 'Nova12@senhaX' };
  const redefinida = await postCompleto('/redefinir-senha', { token, senha: nova.senha }, lugar(182));
  assert.strictEqual(redefinida.status, 200);
  assert.strictEqual(await post('/anunciantes/login', nova, lugar(183)), 200, 'logo depois, entra de qualquer lugar');
  assert.ok(redefinida.aparelho, 'quem redefiniu ganha o aparelho conhecido');

  // Quem chuta trava a conta de novo; do navegador em que redefiniu, a dona entra.
  await travar(183);
  assert.strictEqual(await post('/anunciantes/login', nova, lugar(194)), 429);
  assert.strictEqual(await post('/anunciantes/login', nova, { ...lugar(195), cookie: redefinida.aparelho }), 200);
});

// Revisão da rodada 3: o esqueci-senha só tinha o balde do IP, e cada pedido
// grava um token e põe um e-mail na fila pra vítima. Quem tem um /48 IPv6
// (65.536 /64) inundava a caixa dela e gastava a cota do SMTP. Agora há
// também o balde do E-MAIL pedido, exista conta ou não (o 429 não revela
// cadastro).
test('esqueci-senha: o mesmo e-mail pedido de vários endereços esbarra no balde do e-mail', async () => {
  const vitima = await criarConta();
  alvos.push([vitima.contato_email, '/anunciantes/esqueci-senha']);
  const pedir = (email, n) => postCompleto('/anunciantes/esqueci-senha', { email }, lugar(200 + n));

  for (let i = 1; i <= MAX; i++) assert.strictEqual((await pedir(vitima.contato_email, i)).status, 200, `pedido ${i}`);
  const estourado = await pedir(vitima.contato_email, MAX + 1);
  assert.deepStrictEqual(
    [estourado.status, estourado.corpo?.motivo],
    [429, 'conta'],
    'o 11º, de um endereço que nunca pediu nada, esbarra no balde do e-mail',
  );
  assert.strictEqual((await pedir(` ${vitima.contato_email.toUpperCase()}`, MAX + 2)).status, 429, 'outra grafia');

  // Sem conta, a mesma resposta: o balde existe pra qualquer e-mail.
  const semConta = `ninguem-${randomUUID()}@limite.test`;
  alvos.push([semConta, '/anunciantes/esqueci-senha']);
  for (let i = 1; i <= MAX; i++) assert.strictEqual((await pedir(semConta, 20 + i)).status, 200);
  assert.strictEqual((await pedir(semConta, 20 + MAX + 1)).status, 429);

  // A resposta sai antes de gravar (src/conta/routes.js#pedirRedefinicao):
  // espera os 10 aparecerem, e um pouco mais pra pegar um 11º atrasado.
  const contar = async () =>
    (
      await pool.query(
        `SELECT (SELECT count(*) FROM tokens_senha WHERE usuario_id = $1)::int AS tokens,
                (SELECT count(*) FROM email_outbox WHERE anunciante_id = $1 AND tipo = 'redefinir_senha')::int AS fila`,
        [vitima.id],
      )
    ).rows[0];
  for (let fim = Date.now() + 5000; Date.now() < fim && (await contar()).fila < MAX; ) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(await contar(), { tokens: MAX, fila: MAX }, 'só os 10 que passaram viraram link e e-mail');
});

// AUD-004: em produção (Cloudflare → ingress do Northflank → app), com
// `trust proxy 1` o `req.ip` é o último salto do X-Forwarded-For — a BORDA da
// Cloudflare, não o cliente. Todo mundo que saía pela mesma borda dividia um
// balde de 10 (lockout coletivo), e cada borda nova era um balde novo. O IP
// do cliente vem em CF-Connecting-IP, que a Cloudflare sempre preenche.
test('dois clientes atrás da mesma borda têm baldes separados', async () => {
  const atacante = ip(7);
  const vitima = ip(10);

  for (let i = 1; i <= MAX; i++) {
    assert.strictEqual(await post('/anunciantes/login', semConta(), viaBorda(atacante)), 401);
  }
  assert.strictEqual(
    await post('/anunciantes/login', semConta(), viaBorda(atacante)),
    429,
    'o atacante estoura o dele',
  );
  assert.strictEqual(await post('/anunciantes/login', semConta(), viaBorda(vitima)), 401, 'a vítima tem balde próprio');

  const { rows } = await pool.query(
    'SELECT chave, quantidade FROM tentativas_acesso WHERE chave LIKE $1 OR chave LIKE $2',
    [`${REDE}.%`, `${BORDA}:%`],
  );
  const doAtacante = rows.find((r) => r.chave.startsWith(`${atacante}:`));
  assert.strictEqual(doAtacante?.quantidade, MAX + 1, 'o balde é do IP do cliente');
  assert.ok(!rows.some((r) => r.chave.startsWith(`${BORDA}:`)), 'nenhum balde no IP da borda');
});

// Revisão da 1ª rodada: CF-Connecting-IP só vale se quem o entregou foi a
// Cloudflare. Quem fala direto com o ingress (`curl --resolve` no IP dele)
// manda o cabeçalho que quiser, e o ingress acrescenta o IP REAL dele ao
// X-Forwarded-For — esse salto (`req.ip`, fora das faixas da Cloudflare) é o
// que conta. Confiar no cabeçalho de qualquer um dava um balde novo a cada
// chute com um CF-Connecting-IP diferente.
test('CF-Connecting-IP de quem não veio pela Cloudflare não abre balde novo', async () => {
  const direto = ip(9);
  const forjado = (n) => ({ 'x-forwarded-for': `${ip(100 + n)}, ${direto}`, 'cf-connecting-ip': ip(100 + n) });

  for (let i = 1; i <= MAX; i++) assert.strictEqual(await post('/anunciantes/login', semConta(), forjado(i)), 401);
  assert.strictEqual(await post('/anunciantes/login', semConta(), forjado(MAX + 1)), 429, 'conta pelo salto real');
});

// Revisão da 1ª rodada: IPv6 conta pelo /64, não pelo endereço. O domínio
// publica AAAA, e o cliente IPv6 chega com o /128 dele em CF-Connecting-IP;
// quem tem um /64 (o mínimo que qualquer VPS entrega) trocava de endereço a
// cada chute e ganhava 2^64 baldes.
test('endereços IPv6 do mesmo /64 dividem o balde', async () => {
  const rede64 = `${IPV6}:a`;

  for (let i = 1; i <= MAX; i++) {
    assert.strictEqual(await post('/anunciantes/login', semConta(), viaBorda(`${rede64}::${i.toString(16)}`)), 401);
  }
  assert.strictEqual(
    await post('/anunciantes/login', semConta(), viaBorda(`${rede64}:AB:CD:EF:${MAX + 1}`)),
    429,
    'endereço novo, mesmo /64',
  );
  assert.strictEqual(
    await post('/anunciantes/login', semConta(), viaBorda(`${IPV6}:b::1`)),
    401,
    'outro /64, balde próprio',
  );
});
