const express = require('express');
const { limiteTentativasPorAlvo, descontarAcerto } = require('../../lib/limite-tentativas');
const { gerarHash, conferirHash } = require('../../lib/senha');
const { tratarErros, erro } = require('../lib/erros');
const config = require('../config');
const paginas = require('../paginas');
const operadores = require('../operadores');
const checkin = require('../checkin');

// Área do operador de check-in (T6, T8; RN-T26 a RN-T28). A sessão do
// operador é conferida no banco a cada requisição (revogação imediata) e só
// abre /ticket/*: nenhuma rota de conta da Mostraí nem do Admin a aceita. O
// login é próprio da Trimundi (/ticket/entrar), sem passar pela Mostraí.

const router = express.Router();

async function exigirOperador(req, res, next) {
  if (!config.configurada()) return res.status(503).json({ erro: 'a Trimundi não está configurada neste ambiente' });
  const op = await operadores.daSessao(req);
  if (!op) return res.status(401).json({ erro: 'sua sessão de operador acabou — entre de novo' });
  req.operador = op;
  next();
}

// Teto simples por operador (o limitador da Mostraí conta só erros e trava
// em 10; na portaria a leitura é legítima e rápida).
const janela = new Map();
function ritmo(req, res, next) {
  const agora = Date.now();
  const chave = req.operador.id;
  const atual = janela.get(chave);
  if (!atual || agora - atual.inicio > 60000) janela.set(chave, { inicio: agora, n: 1 });
  else if (++atual.n > 120) return res.status(429).json({ erro: 'Muitas leituras seguidas — espere alguns segundos.' });
  if (janela.size > 5000) janela.clear();
  next();
}

router.get('/ticket/ativar', (_req, res) => paginas.enviar(res, 'ativar'));
router.get('/ticket/entrar', (_req, res) => paginas.enviar(res, 'entrar', {}, { cache: 'no-store' }));

// Senha conferida mesmo sem operador: o tempo não diz se o e-mail existe.
let hashFalso = null;
router.post(
  '/ticket/api/operador/entrar',
  limiteTentativasPorAlvo((req) =>
    String(req.body?.email ?? '')
      .trim()
      .toLowerCase(),
  ),
  async (req, res) => {
    if (!config.configurada()) throw erro(503, 'a Trimundi não está configurada neste ambiente');
    const r = await operadores.autenticar(req.body?.email, req.body?.senha);
    if (!r) {
      hashFalso ||= await gerarHash('trimundi-operador-que-nao-existe');
      await conferirHash(String(req.body?.senha ?? ''), hashFalso);
      throw erro(401, 'E-mail ou senha incorretos.');
    }
    if (r.desativado) throw erro(403, 'Este acesso foi desativado — fale com quem organiza o evento.');
    await descontarAcerto(req, res).catch(() => {});
    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.trimundiOperadorId = r.id;
    req.session.trimundiOperadorVersao = r.versao;
    res.json({ ok: true, destino: '/ticket/checkin' });
  },
);

// Leitor de QR para navegador sem BarcodeDetector (Safari): jsQR, servido
// daqui — a CSP só aceita script deste site. Licença Apache-2.0.
const JSQR = require.resolve('jsqr/dist/jsQR.js');
router.get('/ticket/jsqr.js', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('application/javascript').sendFile(JSQR);
});

const alvoDaAtivacao = (req) =>
  String(req.body?.email ?? '')
    .trim()
    .toLowerCase();
router.post('/ticket/api/ativar', limiteTentativasPorAlvo(alvoDaAtivacao), async (req, res) => {
  if (!config.configurada()) throw erro(503, 'a Trimundi não está configurada neste ambiente');
  await operadores.ativar(req.body);
  await descontarAcerto(req, res).catch(() => {});
  res.json({ ok: true });
});

router.get('/ticket/checkin', async (req, res) => {
  const op = config.configurada() ? await operadores.daSessao(req) : null;
  if (!op) return res.redirect(302, '/ticket/entrar');
  // A câmera só nesta página (o resto do site segue com camera=()).
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), interest-cohort=()');
  paginas.enviar(res, 'checkin', {}, { cache: 'no-store' });
});

router.get('/ticket/api/operador', exigirOperador, async (req, res) => {
  const edicoes = await operadores.edicoesPermitidas(req.operador.id);
  res.set('Cache-Control', 'no-store');
  res.json({
    nome: req.operador.nome,
    edicoes: edicoes.map((e) => ({ id: e.id, nome: `${e.evento} — ${e.nome}`, inicio_em: e.inicio_em })),
    // Link de indicação do operador, quando o Admin habilita.
    indicacao: await require('../indicacao').andamentoDoOperador(req.operador.id),
  });
});

router.post('/ticket/api/sair', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.post('/ticket/api/checkin/consultar', exigirOperador, ritmo, async (req, res) => {
  res.json(await checkin.consultarIngresso(req.operador, req.body?.edicao_id, req.body?.entrada));
});

router.post('/ticket/api/checkin/confirmar', exigirOperador, ritmo, async (req, res) => {
  const aparelho = String(req.get('user-agent') || '').slice(0, 120);
  const lido =
    req.body?.lido_em && !Number.isNaN(new Date(req.body.lido_em).getTime()) ? new Date(req.body.lido_em) : null;
  res.json(
    await checkin.confirmar(req.operador, req.body?.edicao_id, req.body?.ingresso_id, { aparelho, lidoEm: lido }),
  );
});

router.post('/ticket/api/checkin/beneficio', exigirOperador, ritmo, async (req, res) => {
  res.json(
    await checkin.resgatarBeneficio(req.operador, req.body?.edicao_id, req.body?.ingresso_id, req.body?.beneficio_id),
  );
});

router.get('/ticket/api/checkin/contador', exigirOperador, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await checkin.contador(req.operador, req.query.edicao));
});

router.use('/ticket', tratarErros);

module.exports = { router };
