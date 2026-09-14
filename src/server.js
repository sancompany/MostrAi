require('dotenv').config();
require('express-async-errors'); // faz rota async que rejeitar cair no error handler abaixo em vez de derrubar o processo
const path = require('path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const pool = require('./db/pool');
const { limiteTentativas } = require('./lib/limite-tentativas');

const pontosRoutes = require('./pontos/routes');
const anunciantesRoutes = require('./anunciantes/routes');
const playlistRoutes = require('./playlist/routes');
const playerRoutes = require('./player/routes');
const financeiroRoutes = require('./financeiro/routes');
const adminRoutes = require('./admin/routes');
const categoriasRoutes = require('./categorias/routes');
const contaRoutes = require('./conta/routes');
const dispositivosRoutes = require('./dispositivos/routes');
const convitesRoutes = require('./convites/routes');
const candidaturasRoutes = require('./candidaturas/routes');

const app = express();

// Atrás do proxy do Render, req.secure é falso sem isso e o express-session
// simplesmente não emite o cookie com `secure: true` — login quebrado em
// produção sem nenhuma mensagem de erro.
app.set('trust proxy', 1);

// Cabeçalhos de segurança básicos. São os quatro que valem a pena aqui, sem
// puxar o helmet só pra isso.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
// O `verify` guarda os bytes CRUS do corpo. A assinatura HMAC do webhook do
// San Checkout é calculada sobre exatamente o que chegou, e reserializar o
// JSON muda a ordem das chaves (API.md do Checkout, 4.3.1, passo 2).
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
// Sessão no Postgres (tabela `session`, migration 019). Com o MemoryStore
// padrão todo deploy deslogava todo mundo — docs/erros/2026-09-sessao-em-memoria.md
app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 3600 * 1000 },
}));

// Serve o site (public/) no mesmo servidor da API — um terminal só, sem
// precisar de Live Server ou outro serviço separado na 8080. Tem que vir
// antes do requireAdminSession abaixo, senão até o admin/index.html (a
// própria tela de login) fica bloqueado por exigir sessão pra carregar.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Login do admin por usuário/senha (env ADMIN_USER/ADMIN_PASSWORD) + sessão
// cookie — mesmo padrão já usado por anunciantes/afiliados. Registrado antes
// do requireAdminSession abaixo pra não cair na exigência de estar logado.
app.post('/admin/login', limiteTentativas, (req, res) => {
  const { usuario, senha } = req.body;
  const ok = usuario === process.env.ADMIN_USER
    && !!process.env.ADMIN_PASSWORD && senha === process.env.ADMIN_PASSWORD;
  if (!ok) return res.status(401).json({ erro: 'usuário ou senha inválidos' });
  // Sessão nova a cada login: sem isso, quem conseguisse plantar um cookie de
  // sessão na vítima ficava com uma sessão de admin válida assim que ela logasse.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ erro: 'erro interno' });
    req.session.isAdmin = true;
    res.json({ ok: true });
  });
});
app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function requireAdminSession(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ erro: 'não autorizado' });
  next();
}
app.use('/admin', requireAdminSession);

app.get('/health', (req, res) => res.json({ ok: true }));

app.use(pontosRoutes);
app.use(anunciantesRoutes.router);
app.use(playlistRoutes);
app.use(playerRoutes);
app.use(financeiroRoutes.router);
app.use(adminRoutes);
app.use(categoriasRoutes);
app.use(contaRoutes);
app.use(dispositivosRoutes);
app.use(convitesRoutes);
app.use(candidaturasRoutes);
app.use(require('./conta/modos').router);

// Error handler global — qualquer erro (agora inclusive de rota async, via
// express-async-errors acima) cai aqui em vez de derrubar o servidor.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // Corpo que não é JSON válido ou passou do limite é erro do cliente, não
  // nosso — 400 em vez de 500 (e sem poluir o log com stack trace).
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido' });
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'corpo grande demais' });
  console.error(err);
  res.status(500).json({ erro: 'erro interno' });
});

// Rede de segurança final — se algo escapar do error handler acima (ex.:
// rejeição fora do ciclo de uma request), loga em vez de deixar o processo
// morrer sozinho.
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

app.listen(process.env.PORT, () => {
  console.log(`mostrai rodando na porta ${process.env.PORT}`);
});
