require('express-async-errors');
const { randomUUID } = require('node:crypto');
const express = require('express');
const pool = require('../src/db/pool');
const dispositivosRepo = require('../src/dispositivos/repository');
const pinSaida = require('../src/player/pin-saida');
const { normalizarCodigoInstalacao } = require('../src/lib/codigo-tela');

// Apoio comum dos testes do Player MVP (docs/player-mvp-contract.md): o app
// com as rotas reais, pontos/telas de teste e um Player instalado pelo mesmo
// caminho da TV (código de instalação → credencial). Não é teste — o
// `npm test` só roda `tests/*.test.js`.

process.env.SESSION_SECRET ||= 'teste-player-mvp';

// `ip`: cada teste usa uma "origem" própria (X-Forwarded-For com trust
// proxy), senão o limite de tentativas por IP de um teste vazaria no outro.
async function subirApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(require('../src/player/routes'));
  app.use(require('../src/playlist/routes'));
  app.use(require('../src/dispositivos/routes'));
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido' });
    if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'corpo grande demais' });
    res.status(500).json({ erro: 'erro interno' });
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, { corpo, chave, ip, cru, versao = '1.2.0+12' } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (versao) headers['X-Player-Version'] = versao;
    if (chave !== undefined) headers['X-Aparelho-Key'] = chave;
    if (ip) headers['X-Forwarded-For'] = ip;
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers,
      body: cru ?? (corpo === undefined ? undefined : JSON.stringify(corpo)),
    });
    const texto = await r.text();
    let json = null;
    try {
      json = JSON.parse(texto);
    } catch {}
    return { status: r.status, json, texto, headers: r.headers };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

// IP privado aleatório: só precisa ser diferente entre testes.
const ipDeTeste = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

const pontosCriados = [];

async function novoPonto({ horario = null, status = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, horario_semanal)
     VALUES ($1, 'R', 'Matão', 'SP', '1', 'outro', 'R', '1', $2) RETURNING id`,
    [`PMVP ${randomUUID().slice(0, 8)}`, horario ? JSON.stringify(horario) : null],
  );
  if (status) await pool.query('UPDATE pontos SET status = $2 WHERE id = $1', [rows[0].id, status]);
  pontosCriados.push(rows[0].id);
  return rows[0].id;
}

// Sem PIN de saída o admin não gera código de instalação (contrato §6). O
// PIN é global: se outro teste já definiu, fica o dele.
const PIN_DE_TESTE = '482715';
async function garantirPinSaida() {
  if (!(await pinSaida.obter())) await pinSaida.definir(PIN_DE_TESTE);
  return pinSaida.obter();
}

// Player instalado pelo caminho da TV: gera o código (como o admin) e troca
// pela credencial (como POST /player/provisionar).
async function instalarPlayer(telaId) {
  await garantirPinSaida();
  const { codigo } = await dispositivosRepo.gerarCodigo(telaId, 'teste');
  const r = await dispositivosRepo.trocarCodigoPorCredencial(telaId, normalizarCodigoInstalacao(codigo));
  return { dispositivoId: r.dispositivoId, chaveAparelho: r.chaveAparelho };
}

async function novaTela(pontoId, dados = {}) {
  return dispositivosRepo.criar(pontoId, dados);
}

async function limparPontos() {
  for (const id of pontosCriados.splice(0)) {
    const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
    await pool.query(`DELETE FROM execucoes_confirmadas WHERE dispositivo_id IN (${telas})`, [id]);
    await pool.query(`DELETE FROM exibicoes_contador WHERE dispositivo_id IN (${telas})`, [id]);
    await pool.query(`DELETE FROM playlist_hora_congelada WHERE dispositivo_id IN (${telas})`, [id]);
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
  }
}

async function eventosDe(telaId, tipo) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM tela_eventos WHERE dispositivo_id = $1 AND tipo = $2',
    [telaId, tipo],
  );
  return rows[0].n;
}

module.exports = {
  subirApp,
  ipDeTeste,
  novoPonto,
  novaTela,
  instalarPlayer,
  garantirPinSaida,
  limparPontos,
  eventosDe,
};
