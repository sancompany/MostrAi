require('dotenv').config();
require('express-async-errors'); // faz rota async que rejeitar cair no error handler abaixo em vez de derrubar o processo
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const pool = require('./db/pool');
const { limiteTentativas } = require('./lib/limite-tentativas');
const { segredoConfere } = require('./lib/segredo');

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
const titularRoutes = require('./titular/routes');
const bancoHorasRoutes = require('./bancohoras/routes');
const midiasRoutes = require('./midias/routes');
const creditosRoutes = require('./creditos/routes');
const eventosRoutes = require('./creditos/eventos-routes');

const app = express();

// Atrás do proxy do Render, req.secure é falso sem isso e o express-session
// simplesmente não emite o cookie com `secure: true` — login quebrado em
// produção sem nenhuma mensagem de erro.
app.set('trust proxy', 1);

// Content-Security-Policy. É o que sobrou de pé depois de zerar os 301
// atributos style= e tirar os 16 <script> inline dos HTML: sem eles, a
// política não precisa de 'unsafe-inline' em lugar nenhum, que é o único
// jeito de a CSP realmente valer contra XSS. Um cadastro público alimenta
// telas de outras pessoas (o vendedor vê o nome que o anunciante digitou),
// então isto é a segunda camada atrás do `esc()` do config.js.
//
// A origem do Storage sai do ambiente, nunca escrita aqui: o repositório é
// público e endereço de infraestrutura não entra em arquivo versionado.
function origemDe(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
const ORIGEM_STORAGE = origemDe(process.env.SUPABASE_URL);
const MIDIA = ["'self'", ORIGEM_STORAGE].filter(Boolean);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  // data: para as imagens embutidas; o Storage serve os criativos.
  `img-src 'self' data: ${MIDIA.slice(1).join(' ')}`.trim(),
  // blob: é o player tocando do cache offline (URL.createObjectURL).
  `media-src ${MIDIA.join(' ')} blob:`,
  // viacep preenche endereço no cadastro; o player busca o criativo pra cachear.
  `connect-src ${MIDIA.join(' ')} https://viacep.com.br`,
  // o mapa de Matão na página de pontos.
  'frame-src https://www.google.com',
  "worker-src 'self' blob:",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

// CSP_REPORT_ONLY=1 sobe a política sem bloquear nada — a saída de emergência
// se algum navegador reclamar de algo que não apareceu nos testes.
const CABECALHO_CSP =
  process.env.CSP_REPORT_ONLY === '1' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';

// Cabeçalhos de segurança. Sem puxar o helmet só pra isso.
app.use((_req, res, next) => {
  res.setHeader(CABECALHO_CSP, CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Nada aqui precisa de câmera, microfone ou localização.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
// O `verify` guarda os bytes CRUS do corpo. A assinatura HMAC do webhook do
// San Checkout é calculada sobre exatamente o que chegou, e reserializar o
// JSON muda a ordem das chaves (API.md do Checkout, 4.3.1, passo 2).
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
// Sessão no Postgres (tabela `session`, migration 019). Com o MemoryStore
// padrão todo deploy deslogava todo mundo — docs/erros/2026-09-sessao-em-memoria.md
app.use(
  session({
    store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 3600 * 1000,
    },
  }),
);

// Serve o site (public/) no mesmo servidor da API — um terminal só, sem
// precisar de Live Server ou outro serviço separado na 8080. Tem que vir
// antes do requireAdminSession abaixo, senão até o admin/index.html (a
// própria tela de login) fica bloqueado por exigir sessão pra carregar.
// URLs antigas que mudaram de nome. Eram quatro arquivos HTML cuja única
// função era um window.location.replace — um redirecionamento que só acontece
// depois que o navegador baixa a página e roda script, e que buscador nenhum
// lê como mudança de endereço. 301 diz a mesma coisa antes do download, e sem
// script — o que também é o que permite a CSP não liberar script inline.
const MUDARAM_DE_ENDERECO = {
  // '/seja-um-vendedor.html' foi aposentada em 18/09/2026 (candidatura sem
  // conta virou contato direto) — quem tinha o link antigo de afiliado vai
  // pro mesmo lugar que o card de vendedor da home manda agora.
  '/afiliado/cadastro.html': '/#contato',
  '/afiliado/login.html': '/anunciante/login.html',
  '/afiliado/painel.html': '/anunciante/painel.html',
  '/anunciante/perfil.html': '/anunciante/painel.html',
  // Programa de vendedores aposentado (reconstrução de Contas, 23/09/2026):
  // o painel de vendas (cupom, link, comissão) saiu da experiência. Os dados
  // ficam no banco; quem tinha o link cai no painel da conta.
  '/anunciante/vendedor.html': '/anunciante/painel.html',
};
Object.entries(MUDARAM_DE_ENDERECO).forEach(([de, para]) => {
  app.get(de, (_req, res) => res.redirect(301, para));
});

// Endereço sem extensão (/planos) é o mesmo que a página (/planos.html).
// O site morou um tempo num servidor de arquivo estático que servia assim e
// redirecionava a URL com extensão pra sem — então buscador, histórico e link
// compartilhado daquele período apontam pro endereço curto. Agora que quem
// responde é o Express, /planos e /pontos batem antes na rota da API e
// devolvem JSON cru na cara de quem clicou. Só a navegação de documento é
// redirecionada: fetch() manda `Sec-Fetch-Dest: empty` e um Accept que não
// pede text/html, e continua caindo na API como sempre.
const PAGINAS_SEM_EXTENSAO = new Set();
(function mapearPaginas(dir, prefixo) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) mapearPaginas(path.join(dir, item.name), `${prefixo}/${item.name}`);
    else if (item.name.endsWith('.html')) PAGINAS_SEM_EXTENSAO.add(`${prefixo}/${item.name.slice(0, -5)}`);
  }
})(path.join(__dirname, '..', 'public'), '');

app.use((req, res, proximo) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return proximo();
  if (!PAGINAS_SEM_EXTENSAO.has(req.path)) return proximo();
  const destino = req.get('sec-fetch-dest');
  const navegacao = destino ? destino === 'document' : (req.get('accept') || '').includes('text/html');
  if (!navegacao) return proximo();
  const busca = req.originalUrl.slice(req.path.length);
  return res.redirect(301, `${req.path}.html${busca}`);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// Login do admin por usuário/senha (env ADMIN_USER/ADMIN_PASSWORD) + sessão
// cookie — mesmo padrão já usado por anunciantes/afiliados. Registrado antes
// do requireAdminSession abaixo pra não cair na exigência de estar logado.
app.post('/admin/login', limiteTentativas, (req, res) => {
  const { usuario, senha } = req.body;
  // Tempo constante nos dois campos: o `===` de antes devolvia mais rápido
  // quanto mais cedo os bytes divergiam, o que entrega usuário e senha prefixo
  // a prefixo pra quem mede. Mesma regra que o webhook do Checkout já segue.
  const ok = segredoConfere(usuario, process.env.ADMIN_USER) && segredoConfere(senha, process.env.ADMIN_PASSWORD);
  if (!ok) return res.status(401).json({ erro: 'usuário ou senha inválidos' });
  // Sessão nova a cada login: sem isso, quem conseguisse plantar um cookie de
  // sessão na vítima ficava com uma sessão de admin válida assim que ela logasse.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ erro: 'erro interno' });
    req.session.isAdmin = true;
    // Quem concedeu/encerrou um plano administrativo fica no histórico
    // (planos_administrativos.concedido_por) — é o único nome que existe.
    req.session.adminUsuario = String(usuario);
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

// Conta suspensa perde o acesso com a sessão já aberta (Parte 27 da
// reconstrução de Contas) — regra em src/anunciantes/routes.js.
app.use(anunciantesRoutes.derrubarSessaoSuspensa);

app.get('/health', (_req, res) => res.json({ ok: true }));

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
app.use(titularRoutes);
app.use(bancoHorasRoutes);
app.use(midiasRoutes);
app.use(creditosRoutes);
app.use(eventosRoutes);
app.use(require('./conta/modos').router);
app.use(require('./conta/financeiro'));

// Quem pediu página e quem pediu dado recebem coisas diferentes: navegador
// manda `Accept: text/html` e merece uma tela; `fetch` do painel espera JSON e
// quebraria recebendo HTML.
//
// A checagem é pelo cabeçalho CRU, não por `req.accepts`: com `Accept: */*` —
// que é o que curl e `fetch` sem header mandam — o `accepts` devolve o
// primeiro tipo oferecido, ou seja 'html', e todo cliente de API receberia uma
// página. Página só para quem pediu `text/html` com todas as letras.
const querHtml = (req) => String(req.headers.accept || '').includes('text/html');
const paginaDeErro = (arquivo) => path.join(__dirname, '..', 'public', arquivo);

// 404 — rota que não existe. Sem isto, endereço errado morria no handler
// padrão do Express, que devolve uma página em inglês com o caminho dentro.
//
// `no-store` (23/09/2026, deploy da Fatia 1): no deploy em rolagem, o pod
// antigo respondia 404 para o arquivo novo (creditos.js), a Cloudflare
// guardava esse 404 e continuava servindo depois que o pod novo subiu. Um
// "não existe" nunca é fato estável o bastante pra ir pra cache.
app.use((req, res) => {
  res.set('Cache-Control', 'no-store');
  if (querHtml(req)) return res.status(404).sendFile(paginaDeErro('404.html'));
  res.status(404).json({ erro: 'não encontrado' });
});

// Error handler global — qualquer erro (agora inclusive de rota async, via
// express-async-errors acima) cai aqui em vez de derrubar o servidor.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // Corpo que não é JSON válido ou passou do limite é erro do cliente, não
  // nosso — 400 em vez de 500 (e sem poluir o log com stack trace).
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido' });
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'corpo grande demais' });
  // Arquivo recusado pelo filtro do multer é escolha do cliente, não falha
  // nossa: 400 com a mensagem do filtro, em vez de 500 genérico.
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ erro: 'arquivo grande demais — o limite é 95 MB por arquivo' });
  if (err.storageErrors || /tipo de arquivo/i.test(err.message || '')) {
    return res.status(400).json({ erro: err.message || 'arquivo não aceito' });
  }
  console.error(err);
  // A 500.html não depende de nada da aplicação — é justamente quando ela
  // falhou que a página precisa abrir.
  if (querHtml(req)) return res.status(500).sendFile(paginaDeErro('500.html'));
  res.status(500).json({ erro: 'erro interno' });
});

// Rede de segurança final — se algo escapar do error handler acima (ex.:
// rejeição fora do ciclo de uma request), loga em vez de deixar o processo
// morrer sozinho.
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

app.listen(process.env.PORT, () => {
  console.log(`mostrai rodando na porta ${process.env.PORT}`);
});
