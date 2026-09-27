const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

// Sessões do site — duas, com cookies separados (estação sessão do
// anunciante, 27/09/2026).
//
// Sessão no Postgres (tabela `session`, migration 019). Com o MemoryStore
// padrão todo deploy deslogava todo mundo — docs/erros/2026-09-sessao-em-memoria.md
//
// Por que duas: até aqui o admin e a conta do cliente dividiam UM cookie
// (`connect.sid`) e UMA sessão. Cada login faz `regenerate` (proteção contra
// fixação de sessão), e regenerar joga fora a sessão inteira — então entrar
// no admin derrubava a conta do anunciante aberta no mesmo navegador, entrar
// como anunciante derrubava o admin, e sair de um saía dos dois. Em produção
// o dono sobe um criativo no painel, confere no admin, volta pra aba do
// painel — e a volta (resync do SSE em `visibilitychange`) recebia 401 e ia
// pro login. Reproduzido em curl; ver docs/erros/2026-09-27-sessao-do-admin-derrubava-o-anunciante.md.
//
// O admin agora tem cookie próprio (`mostrai.admin`), com `path=/admin`: só
// viaja para as rotas do admin, e o do cliente não é lido lá. Toda rota que
// usa `isAdmin`/`adminUsuario` mora em /admin (conferido na criação), e
// nenhuma rota /admin lê `anuncianteId`.
//
// TTL: 7 dias contados do login (cookie sem `rolling`). O `touch` do store
// renova a validade da linha no banco a cada request, mas o cookie no
// navegador vence na data do login — não muda aqui.
const SETE_DIAS_MS = 7 * 24 * 3600 * 1000;

function montarSessoes(app, pool) {
  // Um store POR sessão (mesma tabela): o express-session pendura o gerador
  // de sessão (`store.generate`, com as opções de cookie) no próprio objeto
  // do store. Com um store só, a segunda montagem sobrescrevia a primeira, e
  // o `regenerate` do login do admin emitia o cookie com `Path=/` — pego pelo
  // teste (tests/sessao-anunciante.test.js). A limpeza das vencidas roda num
  // deles só.
  const novoStore = (opcoes = {}) =>
    new PgSession({ pool, tableName: 'session', createTableIfMissing: false, ...opcoes });
  const base = {
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  };
  const cookie = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SETE_DIAS_MS,
  };
  // Ordem importa: o express-session não faz nada quando `req.session` já
  // existe, então nas rotas /admin a sessão do admin monta primeiro e a do
  // cliente passa reto.
  app.use(
    '/admin',
    session({
      ...base,
      store: novoStore({ pruneSessionInterval: false }),
      name: 'mostrai.admin',
      cookie: { ...cookie, path: '/admin' },
    }),
  );
  app.use(session({ ...base, store: novoStore(), cookie }));
}

module.exports = { montarSessoes };
