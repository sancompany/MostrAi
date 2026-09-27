const test = require('node:test');
const assert = require('node:assert');
const { pegarJson, criarNavegacao, desfecho, ErroApi } = require('../public/admin/carga');

// Núcleo de carga do admin (public/admin/carga.js — estação Admin sem F5,
// 27/09/2026), com um fetch FALSO que responde o que cada teste manda.
// Cobre: sucesso, vazio, erro, nova tentativa, prazo, cancelamento,
// resposta fora de ordem, sessão (401/403 e o 302 do Cloudflare Access).

const json = (status, corpo) => ({
  ok: status >= 200 && status < 300,
  status,
  type: 'basic',
  json: async () => corpo,
});
// Fetch que responde em sequência (uma resposta por chamada) e conta.
function fetchFalso(...respostas) {
  const f = async (_url, opcoes) => {
    f.chamadas += 1;
    f.opcoes.push(opcoes);
    const r = respostas[Math.min(f.chamadas - 1, respostas.length - 1)];
    if (typeof r === 'function') return r(opcoes);
    if (r instanceof Error) throw r;
    return r;
  };
  f.chamadas = 0;
  f.opcoes = [];
  return f;
}
// Fetch que só responde quando o teste mandar (ou quando for abortado).
function fetchPendurado() {
  let soltar;
  // O prazo (AbortSignal.timeout) não segura o event loop do Node sozinho:
  // um timer "de verdade" fica vivo enquanto a leitura está pendurada.
  const f = (_url, opcoes) =>
    new Promise((resolve, reject) => {
      const vivo = setInterval(() => {}, 50);
      soltar = (r) => {
        clearInterval(vivo);
        resolve(r);
      };
      opcoes.signal.addEventListener(
        'abort',
        () => {
          clearInterval(vivo);
          reject(opcoes.signal.reason);
        },
        { once: true },
      );
    });
  f.soltar = (r) => soltar(r);
  return f;
}

test('1. sucesso: devolve o JSON; GET sem seguir redirect e com prazo', async () => {
  const f = fetchFalso(json(200, { total: 3 }));
  assert.deepStrictEqual(await pegarJson('/admin/x', { fetchFn: f }), { total: 3 });
  assert.strictEqual(f.opcoes[0].redirect, 'manual');
  assert.ok(f.opcoes[0].signal, 'toda leitura tem sinal (prazo)');
});

test('2. vazio (200 + []) é vazio, não erro', async () => {
  assert.deepStrictEqual(await pegarJson('/admin/x', { fetchFn: fetchFalso(json(200, [])) }), []);
});

test('3. erro (500 duas vezes) vira erro recuperável — nunca "nenhum item"', async () => {
  const f = fetchFalso(json(500, { erro: 'boom' }), json(500, { erro: 'boom' }));
  const err = await pegarJson('/admin/x', { fetchFn: f }).catch((e) => e);
  assert.ok(err instanceof ErroApi);
  assert.strictEqual(err.status, 500);
  assert.strictEqual(f.chamadas, 2, 'uma nova tentativa');
  const d = desfecho(err);
  assert.strictEqual(d.acao, 'tentar');
  assert.match(d.texto, /Não foi possível carregar/);
});

test('4. nova tentativa: primeira falha (rede), segunda funciona', async () => {
  const f = fetchFalso(new TypeError('Failed to fetch'), json(200, { ok: 1 }));
  assert.deepStrictEqual(await pegarJson('/admin/x', { fetchFn: f }), { ok: 1 });
  assert.strictEqual(f.chamadas, 2);
});

test('5. 401 e 403 não tentam de novo; 401 pede "entrar", 403 não oferece repetir', async () => {
  const f401 = fetchFalso(json(401, { erro: 'não autenticado' }));
  const e401 = await pegarJson('/admin/x', { fetchFn: f401 }).catch((e) => e);
  assert.strictEqual(f401.chamadas, 1);
  assert.strictEqual(desfecho(e401).acao, 'entrar');
  const f403 = fetchFalso(json(403, {}));
  const e403 = await pegarJson('/admin/x', { fetchFn: f403 }).catch((e) => e);
  assert.strictEqual(f403.chamadas, 1);
  assert.strictEqual(desfecho(e403).acao, 'nenhuma');
});

test('6. sessão do Cloudflare Access vencida (302 → opaqueredirect) não vira "sem conexão"', async () => {
  const f = fetchFalso({ ok: false, status: 0, type: 'opaqueredirect', json: async () => ({}) });
  const err = await pegarJson('/admin/x', { fetchFn: f }).catch((e) => e);
  assert.strictEqual(err.status, 401);
  assert.strictEqual(err.acesso, true);
  assert.strictEqual(f.chamadas, 1, 'não repete: repetir não renova a sessão do Access');
  const d = desfecho(err);
  assert.strictEqual(d.acao, 'entrar');
  assert.match(d.texto, /sessão de acesso/);
});

test('7. prazo: leitura pendurada vira erro recuperável (não fica carregando pra sempre)', async () => {
  const f = fetchPendurado();
  const inicio = Date.now();
  const err = await pegarJson('/admin/x', { fetchFn: f, prazoMs: 80 }).catch((e) => e);
  assert.ok(Date.now() - inicio < 1000);
  assert.strictEqual(err.tempoEsgotado, true);
  const d = desfecho(err);
  assert.strictEqual(d.acao, 'tentar');
  assert.match(d.texto, /demorou demais/);
});

test('8. cancelamento: a navegação nova aborta a leitura da anterior, sem mostrar erro', async () => {
  const nav = criarNavegacao();
  nav.nova();
  const f = fetchPendurado();
  const leitura = pegarJson('/admin/lenta', { fetchFn: f, sinal: nav.sinal });
  nav.nova(); // mudou de rota
  const err = await leitura.catch((e) => e);
  assert.strictEqual(err.cancelada, true);
  assert.strictEqual(desfecho(err), null, 'leitura cancelada não desenha nada');
});

test('9. resposta fora de ordem: a velha chega DEPOIS da nova e não vale', async () => {
  const nav = criarNavegacao();
  const tela = { conteudo: null };
  // Quem desenha confere a geração — é o que o roteador do admin faz.
  const carregar = async (fetchFn, valor) => {
    const g = nav.nova();
    const dado = await pegarJson('/admin/x', { fetchFn, sinal: nav.sinal }).catch((e) => e);
    if (nav.vigente(g) && !(dado instanceof Error)) tela.conteudo = valor ?? dado;
  };
  // A primeira leitura ignora o cancelamento (servidor lento que responde
  // mesmo assim); a segunda responde na hora.
  let soltarVelha;
  const velha = () => new Promise((r) => (soltarVelha = r));
  const primeira = carregar(velha, 'VELHA');
  await carregar(fetchFalso(json(200, 'NOVA')));
  soltarVelha(json(200, 'VELHA'));
  await primeira;
  assert.strictEqual(tela.conteudo, 'NOVA');
});

test('10. atualizar várias vezes: só a última geração é vigente', () => {
  const nav = criarNavegacao();
  const g1 = nav.nova();
  const sinal1 = nav.sinal;
  const g2 = nav.nova();
  const g3 = nav.nova();
  assert.ok(sinal1.aborted, 'o Atualizar anterior foi cancelado');
  assert.ok(!nav.vigente(g1) && !nav.vigente(g2) && nav.vigente(g3));
});

test('11. erro depois de sucesso: primeira falha, [Tentar novamente] funciona (sem F5)', async () => {
  // A mesma carga, chamada de novo — é o que o botão faz.
  const f = fetchFalso(json(500, {}), json(500, {}), json(200, { itens: [1] }));
  const primeira = await pegarJson('/admin/x', { fetchFn: f }).catch((e) => e);
  assert.strictEqual(desfecho(primeira).acao, 'tentar');
  assert.deepStrictEqual(await pegarJson('/admin/x', { fetchFn: f }), { itens: [1] });
});

test('12. 429 tenta de novo; 404 não', async () => {
  const f429 = fetchFalso(json(429, {}), json(200, { ok: true }));
  assert.deepStrictEqual(await pegarJson('/admin/x', { fetchFn: f429 }), { ok: true });
  const f404 = fetchFalso(json(404, { erro: 'não encontrado' }));
  const err = await pegarJson('/admin/x', { fetchFn: f404 }).catch((e) => e);
  assert.strictEqual(err.status, 404);
  assert.strictEqual(f404.chamadas, 1);
});
