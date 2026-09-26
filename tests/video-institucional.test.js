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
const { instalarPlayer } = require('./apoio-player');

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
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
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
