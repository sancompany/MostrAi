require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const ffmpeg = require('../src/lib/ffmpeg');

// Upload confiável de criativo (estação sessão + upload, 27/09/2026).
//
// Em produção o processamento (FFmpeg a 0,5 vCPU + Storage) passava dos 100 s
// do proxy da Cloudflare: o navegador recebia 524 e mostrava "Não foi
// possível enviar", e o servidor terminava e criava o criativo mesmo assim.
// Tentar de novo criava outro. Aqui: o mesmo envio (mesma Idempotency-Key)
// nunca cria dois criativos, a resposta perdida é reconciliável pela chave,
// e erro de verdade não deixa linha pra trás.
//
// FFmpeg e Storage são falsos (o CI não tem FFmpeg; o teste do FFmpeg real
// fica em tests/ffmpeg-normalizar.test.js): `normalizar` espera uma "trava"
// que o teste solta — é assim que o teste segura o servidor NO MEIO do
// processamento, que é exatamente onde o 524 acontecia.

let midiaFalsa = { width: 1080, height: 1920, duracao_segundos: 10, ehImagem: false };
let travaNormalizar = null;
let falhaNormalizar = null;
ffmpeg.probeMidia = async () => midiaFalsa;
ffmpeg.normalizar = async (_caminho, criativoId) => {
  if (travaNormalizar) await travaNormalizar.promessa;
  if (falhaNormalizar) throw falhaNormalizar;
  return {
    arquivo_normalizado_url: `https://storage.teste/${criativoId}.mp4`,
    thumbnail_url: `https://storage.teste/${criativoId}-thumb.jpg`,
    duracao_segundos: midiaFalsa.duracao_segundos,
    conteudo_sha256: 'a'.repeat(64),
    conteudo_bytes: 1234,
    tempos: { ffmpeg_ms: 1, thumb_ms: 1, storage_ms: 1 },
  };
};
function travar() {
  let soltar;
  const promessa = new Promise((r) => {
    soltar = r;
  });
  travaNormalizar = { promessa, soltar };
  return () => {
    travaNormalizar = null;
    soltar();
  };
}

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-upload', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/anunciantes/routes').router);
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    enviar: async (conta, chave, { sinal } = {}) => {
      const form = new FormData();
      form.append('arquivo', new Blob([Buffer.from('video-de-teste')], { type: 'video/mp4' }), 'peca.mp4');
      const r = await fetch(`${base}/anunciantes/${conta.id}/criativos`, {
        method: 'POST',
        headers: { 'x-conta': String(conta.id), ...(chave ? { 'idempotency-key': chave } : {}) },
        body: form,
        signal: sinal,
      });
      return { status: r.status, corpo: await r.json().catch(() => null) };
    },
    envio: async (conta, chave) => {
      const r = await fetch(`${base}/anunciantes/me/criativos/envios/${chave}`, {
        headers: { 'x-conta': String(conta.id) },
      });
      return { status: r.status, corpo: await r.json().catch(() => null) };
    },
    lista: async (conta) => {
      const r = await fetch(`${base}/anunciantes/me/criativos`, { headers: { 'x-conta': String(conta.id) } });
      return r.json();
    },
    fechar: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

async function criarConta(plano = 'maximo-1m') {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, plano_id, data_inicio_cobertura, data_expiracao)
     VALUES (now(), $1, $2, $3, '16999990000', 'x', ARRAY['anunciante'], true, $4, now(), now() + interval '20 days')
     RETURNING *`,
    [
      `UP ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `up-${randomUUID()}@example.com`,
      plano,
    ],
  );
  return rows[0];
}

const contar = async (conta) =>
  (await pool.query('SELECT COUNT(*)::int AS n FROM criativos WHERE anunciante_id = $1', [conta.id])).rows[0].n;

async function esperarLinha(conta) {
  for (let i = 0; i < 100; i++) {
    if ((await contar(conta)) > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('a linha temporária não apareceu');
}

async function limpar(conta) {
  await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [conta.id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [conta.id]);
}

function preparar() {
  midiaFalsa = { width: 1080, height: 1920, duracao_segundos: 10, ehImagem: false };
  travaNormalizar = null;
  falhaNormalizar = null;
}

test('A/E. upload válido cria exatamente 1 criativo; repetir a mesma chave devolve o mesmo, sem criar outro', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const chave = randomUUID();
    const primeiro = await app.enviar(conta, chave);
    assert.strictEqual(primeiro.status, 201);
    assert.strictEqual(await contar(conta), 1);

    const repetido = await app.enviar(conta, chave);
    assert.strictEqual(repetido.status, 200);
    assert.strictEqual(repetido.corpo.repetido, true);
    assert.strictEqual(repetido.corpo.id, primeiro.corpo.id);
    assert.strictEqual(await contar(conta), 1, 'mesma chave nunca cria outro');

    // A mesma peça de novo, de propósito, é OUTRO envio (outra chave).
    assert.strictEqual((await app.enviar(conta, randomUUID())).status, 201);
    assert.strictEqual(await contar(conta), 2);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('D. resposta perdida depois do commit: o servidor conclui, a chave reconcilia, e o reenvio não duplica', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const chave = randomUUID();
    const soltar = travar();
    // O navegador desiste no meio do processamento (é o 524 da Cloudflare).
    const aborto = new AbortController();
    const perdido = app.enviar(conta, chave, { sinal: aborto.signal }).catch((e) => e);
    await esperarLinha(conta);
    aborto.abort();
    assert.strictEqual((await perdido).name, 'AbortError');

    // Enquanto processa: a chave diz "processando", e repetir não cria outro.
    assert.deepStrictEqual((await app.envio(conta, chave)).corpo.estado, 'processando');
    const repetidoNoMeio = await app.enviar(conta, chave);
    assert.strictEqual(repetidoNoMeio.status, 202);
    assert.strictEqual(repetidoNoMeio.corpo.processando, true);
    assert.strictEqual(await contar(conta), 1);
    // O card aparece como processando na lista (sem arquivo ainda).
    const durante = await app.lista(conta);
    assert.strictEqual(durante.criativos.length, 1);
    assert.strictEqual(durante.criativos[0].arquivoUrl, null);

    // O servidor termina mesmo sem ninguém ouvindo.
    soltar();
    for (let i = 0; i < 100; i++) {
      if ((await app.envio(conta, chave)).corpo.estado === 'pronto') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual((await app.envio(conta, chave)).corpo.estado, 'pronto');
    const reenvio = await app.enviar(conta, chave);
    assert.strictEqual(reenvio.status, 200);
    assert.strictEqual(await contar(conta), 1, 'resposta perdida + reenvio = um criativo só');
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('criativo processando não pode ser excluído; se a linha sumir no meio, o upload nunca responde 201', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  const removidos = [];
  const supabase = require('../src/lib/supabase');
  const storageDeVerdade = Object.getOwnPropertyDescriptor(supabase, 'storage');
  Object.defineProperty(supabase, 'storage', {
    configurable: true,
    get: () => ({ from: () => ({ remove: async (nomes) => removidos.push(...nomes) }) }),
  });
  try {
    let soltar = travar();
    const envio = app.enviar(conta, randomUUID());
    await esperarLinha(conta);
    const [{ id }] = (await pool.query('SELECT id FROM criativos WHERE anunciante_id = $1', [conta.id])).rows;
    const r = await fetch(`${app.base}/anunciantes/${conta.id}/criativos/${id}`, {
      method: 'DELETE',
      headers: { 'x-conta': String(conta.id) },
    });
    assert.strictEqual(r.status, 409, 'excluir no meio do FFmpeg é recusado');
    soltar();
    assert.strictEqual((await envio).status, 201);
    assert.strictEqual(await contar(conta), 1);

    // Rede de segurança: a linha sai por outro caminho no meio do trabalho.
    await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [conta.id]);
    soltar = travar();
    const outro = app.enviar(conta, randomUUID());
    await esperarLinha(conta);
    const [{ id: idOutro }] = (await pool.query('SELECT id FROM criativos WHERE anunciante_id = $1', [conta.id])).rows;
    await pool.query('DELETE FROM criativos WHERE id = $1', [idOutro]);
    soltar();
    const resposta = await outro;
    assert.strictEqual(resposta.status, 409, 'nunca 201 de um criativo que não existe');
    assert.match(resposta.corpo.erro, /excluído enquanto era processado/);
    assert.deepStrictEqual(
      removidos,
      [`${idOutro}.mp4`, `${idOutro}-thumb.jpg`],
      'arquivos que subiram não ficam órfãos',
    );
  } finally {
    Object.defineProperty(supabase, 'storage', storageDeVerdade);
    await app.fechar();
    await limpar(conta);
  }
});

test('duas requisições com a mesma chave ao mesmo tempo: o índice único deixa uma só criar', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const chave = randomUUID();
    const soltar = travar();
    const a = app.enviar(conta, chave);
    const b = app.enviar(conta, chave);
    await esperarLinha(conta);
    await new Promise((r) => setTimeout(r, 100));
    soltar();
    const status = [(await a).status, (await b).status];
    const criou = status.indexOf(201);
    assert.ok(criou >= 0, `uma cria (${status})`);
    const outra = status[1 - criou];
    assert.ok(outra === 200 || outra === 202, `a outra devolve o existente (${status})`);
    assert.strictEqual(await contar(conta), 1);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('F/H. arquivo ilegível e vídeo acima do plano: erro real, nenhuma linha, e a chave continua livre', async () => {
  preparar();
  const conta = await criarConta('essencial-1m'); // até 15 s
  const app = await subirApp();
  try {
    const chave = randomUUID();
    midiaFalsa = null; // ffprobe não leu
    const ilegivel = await app.enviar(conta, chave);
    assert.strictEqual(ilegivel.status, 400);
    assert.match(ilegivel.corpo.erro, /não foi possível ler esse arquivo/);
    assert.strictEqual(await contar(conta), 0);
    assert.strictEqual((await app.envio(conta, chave)).status, 404);

    midiaFalsa = { width: 1080, height: 1920, duracao_segundos: 20, ehImagem: false };
    const longo = await app.enviar(conta, randomUUID());
    assert.strictEqual(longo.status, 400);
    assert.match(longo.corpo.erro, /seu plano aceita peça de até 15s/);
    assert.strictEqual(await contar(conta), 0, 'bloqueio de duração do plano continua valendo');
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('G. Storage fora (502) e FFmpeg que falha: erro real, a linha temporária sai, e tentar de novo funciona', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const chave = randomUUID();
    falhaNormalizar = Object.assign(new Error('storage caiu'), { origem: 'storage' });
    const storage = await app.enviar(conta, chave);
    assert.strictEqual(storage.status, 502);
    assert.match(storage.corpo.erro, /armazenamento não respondeu/);
    assert.strictEqual(await contar(conta), 0, 'sem criativo fantasma ocupando cota');

    falhaNormalizar = new Error('ffmpeg: arquivo corrompido');
    const ffmpegFalhou = await app.enviar(conta, chave);
    assert.strictEqual(ffmpegFalhou.status, 400);
    assert.strictEqual(await contar(conta), 0);

    // Mesma chave depois das falhas: processa de novo e cria.
    falhaNormalizar = null;
    assert.strictEqual((await app.enviar(conta, chave)).status, 201);
    assert.strictEqual(await contar(conta), 1);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('repetir um envio concluído com a conta no limite devolve o criativo, não "limite atingido"', async () => {
  preparar();
  const conta = await criarConta('essencial-1m'); // limite 1
  const app = await subirApp();
  try {
    const chave = randomUUID();
    assert.strictEqual((await app.enviar(conta, chave)).status, 201);
    assert.strictEqual((await app.enviar(conta, chave)).status, 200);
    const outro = await app.enviar(conta, randomUUID());
    assert.strictEqual(outro.status, 400, 'limite do plano continua valendo pra envio novo');
    assert.match(outro.corpo.erro, /seu plano permite até 1/);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('chave inválida é recusada; upload sem chave continua funcionando', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    assert.strictEqual((await app.enviar(conta, 'curta')).status, 400);
    assert.strictEqual((await app.envio(conta, 'x;drop')).status, 400);
    assert.strictEqual((await app.enviar(conta, null)).status, 201);
    assert.strictEqual(await contar(conta), 1);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('processamento interrompido por restart (linha sem arquivo há mais de 30 min) não fica "processando" pra sempre', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    await pool.query(
      `INSERT INTO criativos (anunciante_id, arquivo_original_url, created_at)
       VALUES ($1, 'orfa.mp4', now() - interval '31 minutes'), ($1, 'recente.mp4', now() - interval '5 minutes')`,
      [conta.id],
    );
    const lista = await app.lista(conta);
    assert.strictEqual(lista.criativos.length, 1, 'a órfã saiu; a recente (pode estar processando) fica');
    assert.strictEqual(lista.emUso, 1);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test.after(() => pool.end());
