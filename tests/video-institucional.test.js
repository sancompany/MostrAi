require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const repo = require('../src/pontos/repository');
const gerador = require('../src/playlist/gerador');
const dispositivosRepo = require('../src/dispositivos/repository');
const { instalarPlayer, tirarDoSorteio } = require('./apoio-player');

// Vídeo institucional (25/09/2026, pedido do dono): o que preenche o tempo
// vago da rede pro Player V2 baixar e tocar, no lugar do cartão HTML "este
// espaço pode ser do seu negócio" que o Player V1 continua mostrando sempre
// (src/playlist/gerador.js#obterVideoInstitucional). Configuração ÚNICA pra
// rede inteira, na mesma `configuracoes_site` da foto de exemplo do ponto
// (migration 055) — por isso TODOS os testes deste arquivo (rota e geração
// de playlist) moram aqui: são os únicos que mexem nessa chave global, e
// espalhá-los por outros arquivos arriscaria dois testes de suítes
// diferentes pisando um no valor do outro em paralelo.
//
// A parte que depende de ffmpeg/upload real (normalizar, gerar hash, subir
// pro storage) segue o MESMO limite do resto deste projeto — ver o
// cabeçalho de tests/midias.test.js — e foi conferida à mão, com o binário
// instalado, fora da suíte automatizada.

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-video-institucional', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-admin'] === '1') req.session.isAdmin = true;
    proximo();
  });
  app.use(require('../src/pontos/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho) => {
    const r = await fetch(`${base}${caminho}`, { method: metodo, headers: { 'x-admin': '1' } });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { base, chamar, fechar: () => new Promise((r) => server.close(r)) };
}

test('GET /admin/video-institucional: null enquanto nunca configurado', async () => {
  await repo.definirConfiguracao('video_institucional', null);
  const app = await subirApp();
  try {
    const r = await app.chamar('GET', '/admin/video-institucional');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.corpo, null);
  } finally {
    await app.fechar();
  }
});

test('GET /admin/video-institucional: devolve a configuração gravada', async () => {
  const config = { url: 'https://exemplo.test/institucional.mp4', duracaoSegundos: 15, contentHash: 'abc' };
  const app = await subirApp();
  try {
    await repo.definirConfiguracao('video_institucional', JSON.stringify(config));
    const r = await app.chamar('GET', '/admin/video-institucional');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.corpo, config);
  } finally {
    await repo.definirConfiguracao('video_institucional', null);
    await app.fechar();
  }
});

test('GET /admin/video-institucional: valor corrompido não derruba a tela que existe pra consertar isso', async () => {
  const app = await subirApp();
  try {
    await pool.query(
      `INSERT INTO configuracoes_site (chave, valor) VALUES ('video_institucional', 'não é json')
       ON CONFLICT (chave) DO UPDATE SET valor = 'não é json'`,
    );
    const r = await app.chamar('GET', '/admin/video-institucional');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.corpo, null);
  } finally {
    await repo.definirConfiguracao('video_institucional', null);
    await app.fechar();
  }
});

test('POST /admin/video-institucional: sem arquivo é 400', async () => {
  const app = await subirApp();
  try {
    const r = await app.chamar('POST', '/admin/video-institucional');
    assert.strictEqual(r.status, 400);
    assert.match(r.corpo.erro, /arquivo obrigatório/);
  } finally {
    await app.fechar();
  }
});

// Revisão 2 do AUD-017, FFmpeg falso: a rota confere a resolução logo depois
// do ffprobe (antes a recusa vinha de dentro do normalizar e caía no "não foi
// possível processar") e passa o probe ao normalizar (sem ele, outro ffprobe e
// outra espera na fila pelo mesmo arquivo). `falha`: o erro que o normalizar
// lança.
async function enviarInstitucional(app, midiaDoProbe, falha = null) {
  const ffmpeg = require('../src/lib/ffmpeg');
  const originais = { probeMidia: ffmpeg.probeMidia, normalizar: ffmpeg.normalizar };
  const chamadas = { probe: 0, normalizar: [] };
  ffmpeg.probeMidia = async () => {
    chamadas.probe += 1;
    return midiaDoProbe;
  };
  ffmpeg.normalizar = async (...args) => {
    chamadas.normalizar.push(args);
    if (falha) throw falha;
    return {
      arquivo_normalizado_url: 'https://storage.teste/institucional.mp4',
      thumbnail_url: 'https://storage.teste/institucional-thumb.jpg',
      duracao_segundos: midiaDoProbe.duracao_segundos,
      conteudo_sha256: 'b'.repeat(64),
      conteudo_bytes: 4321,
      tempos: {},
    };
  };
  try {
    const form = new FormData();
    form.append('arquivo', new Blob([Buffer.from('video-de-teste')], { type: 'video/mp4' }), 'institucional.mp4');
    const r = await fetch(`${app.base}/admin/video-institucional`, {
      method: 'POST',
      headers: { 'x-admin': '1' },
      body: form,
    });
    return { status: r.status, corpo: await r.json(), chamadas };
  } finally {
    Object.assign(ffmpeg, originais);
  }
}

test('POST /admin/video-institucional: vídeo acima de 32 MP → 400 com a frase de resolução, sem FFmpeg', async () => {
  const app = await subirApp();
  try {
    const r = await enviarInstitucional(app, { width: 7680, height: 4320, duracao_segundos: 10, ehImagem: false });
    assert.strictEqual(r.status, 400);
    assert.match(r.corpo.erro, /vídeo grande demais: 7680x4320/);
    assert.strictEqual(r.chamadas.normalizar.length, 0);
  } finally {
    await app.fechar();
  }
});

test('POST /admin/video-institucional: o normalizar recebe o probe da rota (um ffprobe só)', async () => {
  const app = await subirApp();
  const midia = { width: 1080, height: 1920, duracao_segundos: 12, ehImagem: false, quadros: 360, pix_fmt: 'yuv420p' };
  try {
    const r = await enviarInstitucional(app, midia);
    assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
    assert.strictEqual(r.chamadas.probe, 1);
    assert.strictEqual(r.chamadas.normalizar.length, 1);
    const [, id, duracaoMaxima, probado] = r.chamadas.normalizar[0];
    assert.deepStrictEqual([id, duracaoMaxima], ['institucional', null]);
    assert.strictEqual(probado, midia, 'o normalizar recebe o probe da rota');
    assert.strictEqual(r.corpo.duracaoSegundos, 12);
  } finally {
    await repo.definirConfiguracao('video_institucional', null);
    await app.fechar();
  }
});

// Revisão 3 do AUD-017: o FFmpeg que estoura o teto de memória (prlimit) volta
// com a frase dele — antes caía no "não foi possível processar" genérico.
test('POST /admin/video-institucional: FFmpeg sem memória no teto → 400 com a frase do teto', async (t) => {
  t.mock.method(console, 'error', () => {});
  const app = await subirApp();
  const midia = { width: 3840, height: 2160, duracao_segundos: 20, ehImagem: false, quadros: 600, pix_fmt: 'yuv420p' };
  const semMemoria = Object.assign(
    new Error('esse arquivo pede mais memória do que o servidor reserva pra processá-lo'),
    {
      status: 400,
      origem: 'memoria',
    },
  );
  try {
    const r = await enviarInstitucional(app, midia, semMemoria);
    assert.strictEqual(r.status, 400);
    assert.match(r.corpo.erro, /pede mais memória do que o servidor reserva/);
  } finally {
    await app.fechar();
  }
});

// ---------- integração com o gerador de playlist ----------

async function criarPontoTeste() {
  return repo.criar({
    nome: `Ponto Teste Institucional ${randomUUID()}`,
    endereco: 'Rua Z, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    segmento: 'Teste',
    responsavel_nome: 'Fulano',
    responsavel_contato: '16999990000',
  });
}

async function dispositivoDeTeste() {
  const ponto = await criarPontoTeste();
  // Fora do sorteio: senão uma conta de outro arquivo cai aqui e a hora
  // deixa de ser toda institucional.
  await tirarDoSorteio(ponto.id);
  const dispositivo = await dispositivosRepo.criar(ponto.id, { apelido: `Teste ${randomUUID()}` });
  await dispositivosRepo.atualizar(dispositivo.id, { status: 'ativo' });
  await instalarPlayer(dispositivo.id);
  return dispositivosRepo.buscarComPonto(dispositivo.id);
}

async function limparDispositivo(id, pontoId) {
  await pool.query('DELETE FROM execucoes_confirmadas WHERE dispositivo_id = $1', [id]);
  await pool.query('DELETE FROM exibicoes_contador WHERE dispositivo_id = $1', [id]);
  await dispositivosRepo.deletar(id);
  await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [pontoId]);
  await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
}

test('vídeo institucional: sem configurar cai no cartão de 10s; configurado, o envelope leva url, duração real e contentHash', async () => {
  const dispositivo = await dispositivoDeTeste();
  try {
    const hora = new Date();
    // Ponto recém-criado, sem nenhum anunciante escolhendo-o: a hora inteira
    // vira tempo vago, o cenário mais simples pra ver só o item institucional.
    const semVideo = await gerador.gerarPlaylistDaHora(dispositivo, hora);
    assert.ok(semVideo.itens.length > 0, 'ponto sem anunciante nenhum: a hora inteira é institucional');
    assert.ok(semVideo.itens.every((i) => i.institucional === true));
    assert.ok(semVideo.itens.every((i) => i.url === null));
    assert.ok(
      semVideo.itens.every((i) => i.duracaoSegundos === 10),
      'sem vídeo configurado, cai no cartão de 10s',
    );
    assert.ok(!('contentHash' in semVideo.itens[0]), 'sem hash nenhum quando não há vídeo');

    await repo.definirConfiguracao(
      'video_institucional',
      JSON.stringify({ url: 'https://exemplo.test/institucional.mp4', duracaoSegundos: 47, contentHash: 'abc123' }),
    );
    try {
      const comVideo = await gerador.gerarPlaylistDaHora(dispositivo, hora);
      assert.ok(comVideo.itens.length > 0);
      assert.ok(comVideo.itens.every((i) => i.institucional === true));
      assert.ok(comVideo.itens.every((i) => i.url === 'https://exemplo.test/institucional.mp4'));
      assert.ok(
        comVideo.itens.every((i) => i.duracaoSegundos === 47),
        'a hora usa a duração REAL do vídeo configurado, não mais o cartão',
      );
      assert.ok(comVideo.itens.every((i) => i.contentHash === 'abc123'));
      // 3600/10=360 peças de cartão contra 3600/47=76 peças de vídeo — a
      // duração configurada decide quantas peças cabem no tempo livre, não
      // só o que cada uma mostra.
      assert.notStrictEqual(
        comVideo.itens.length,
        semVideo.itens.length,
        'menos peças de 47s cabem no mesmo tempo livre que 360 peças de 10s',
      );
    } finally {
      await repo.definirConfiguracao('video_institucional', null);
    }
  } finally {
    await limparDispositivo(dispositivo.id, dispositivo.ponto_id);
  }
});

test.after(() => pool.end());
