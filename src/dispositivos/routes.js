const express = require('express');
const router = express.Router();
const repo = require('./repository');
const pontosRepo = require('../pontos/repository');
const pool = require('../db/pool');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const { limiteTentativas } = require('../lib/limite-tentativas');

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
router.get('/admin/dispositivos', async (req, res) => {
  res.json(await repo.listarTodos());
});

router.get('/admin/pontos/:pontoId/dispositivos', async (req, res) => {
  res.json(await repo.listarPorPonto(req.params.pontoId));
});

router.post('/admin/pontos/:pontoId/dispositivos', async (req, res) => {
  const ponto = await pontosRepo.buscarPorId(req.params.pontoId);
  if (!ponto) return res.status(404).json({ erro: 'ponto não encontrado' });
  res.status(201).json(await repo.criar(ponto.id, req.body));
});

router.patch('/admin/dispositivos/:id', async (req, res) => {
  try {
    const dispositivo = await repo.atualizar(req.params.id, req.body);
    if (!dispositivo) return res.status(404).json({ erro: 'dispositivo não encontrado' });
    res.json(dispositivo);
  } catch (err) {
    if (err.code === '23514') return res.status(400).json({ erro: 'valor inválido' });
    if (err.code === '23502') return res.status(400).json({ erro: 'esse campo não pode ficar em branco' });
    throw err;
  }
});

router.post('/admin/dispositivos/:id/chave', async (req, res) => {
  const dispositivo = await repo.gerarChave(req.params.id);
  if (!dispositivo) return res.status(404).json({ erro: 'dispositivo não encontrado' });
  res.json({ aparelho_id: dispositivo.aparelho_id });
});

router.post('/admin/dispositivos/:id/pin', async (req, res) => {
  const pin = req.body.pin == null ? null : String(req.body.pin);
  if (pin !== null && !/^\d{4,6}$/.test(pin)) return res.status(400).json({ erro: 'PIN precisa ter de 4 a 6 dígitos' });
  const dispositivo = await repo.definirPin(req.params.id, pin);
  if (!dispositivo) return res.status(404).json({ erro: 'dispositivo não encontrado' });
  res.json(dispositivo);
});

router.delete('/admin/dispositivos/:id', async (req, res) => {
  await repo.deletar(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Dono do ponto: as telas dos pontos dele, com o que rodou em cada uma.
// ---------------------------------------------------------------------------
router.get('/anunciantes/:id/dispositivos', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode ver as próprias telas' });
  }
  const { rows } = await pool.query(
    `SELECT d.id, d.ponto_id, d.apelido, d.status, d.ultima_vez_online, d.instalado_em,
            p.nome AS ponto_nome, p.endereco, p.cidade, p.uf, p.status AS ponto_status,
            COALESCE(SUM(e.vezes_confirmadas) FILTER (WHERE e.janela_hora > now() - interval '30 days'), 0)::int AS exibicoes_30d,
            COUNT(DISTINCT e.anunciante_id) FILTER (WHERE e.janela_hora > now() - interval '30 days')::int AS anunciantes_30d
     FROM dispositivos d
     JOIN pontos p ON p.id = d.ponto_id
     LEFT JOIN exibicoes_contador e ON e.dispositivo_id = d.id
     WHERE p.anunciante_id = $1
     GROUP BY d.id, p.id ORDER BY p.nome, d.id`,
    [req.session.anuncianteId]
  );
  res.json(rows);
});

// O que rodou numa tela específica (dono do ponto ou admin), para o painel
// por tela.
async function painelDaTela(dispositivoId) {
  const [porAnunciante, porDia] = await Promise.all([
    pool.query(
      `SELECT a.id, a.nome_empresa, SUM(e.vezes_programadas)::int AS programadas, SUM(e.vezes_confirmadas)::int AS confirmadas
       FROM exibicoes_contador e JOIN anunciantes a ON a.id = e.anunciante_id
       WHERE e.dispositivo_id = $1 AND e.janela_hora > now() - interval '30 days'
       GROUP BY a.id ORDER BY confirmadas DESC`,
      [dispositivoId]
    ),
    pool.query(
      `SELECT date_trunc('day', janela_hora) AS dia, SUM(vezes_confirmadas)::int AS confirmadas
       FROM exibicoes_contador WHERE dispositivo_id = $1
       GROUP BY dia ORDER BY dia DESC LIMIT 30`,
      [dispositivoId]
    ),
  ]);
  return { porAnunciante: porAnunciante.rows, porDia: porDia.rows };
}

router.get('/anunciantes/:id/dispositivos/:dispositivoId/painel', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode ver as próprias telas' });
  }
  const { rows } = await pool.query(
    `SELECT d.id FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
     WHERE d.id = $1 AND p.anunciante_id = $2`,
    [req.params.dispositivoId, req.session.anuncianteId]
  );
  if (!rows[0]) return res.status(404).json({ erro: 'tela não encontrada' });
  res.json(await painelDaTela(req.params.dispositivoId));
});

router.get('/admin/dispositivos/:id/painel', async (req, res) => {
  res.json(await painelDaTela(req.params.id));
});

// Painel aberto a partir da própria TV: chave do aparelho + PIN. Não dá
// acesso a nada além desta tela (CONSTRAINTS.md).
// limiteTentativas: PIN de 4 dígitos sem limite é força bruta em minutos.
router.post('/player/:dispositivoId/painel', limiteTentativas, async (req, res) => {
  const dispositivo = await repo.buscarComPonto(req.params.dispositivoId);
  const chave = req.headers['x-aparelho-id'];
  if (!dispositivo || !dispositivo.aparelho_id || chave !== dispositivo.aparelho_id) {
    return res.status(401).json({ erro: 'aparelho não autorizado' });
  }
  if (!(await repo.conferirPin(dispositivo.id, req.body.pin))) {
    return res.status(401).json({ erro: 'PIN incorreto' });
  }
  res.json(await painelDaTela(dispositivo.id));
});

module.exports = router;
