# Login do admin derrubava a conta do anunciante (e vice-versa)

**Sintoma.** O anunciante, usando o painel normalmente, "perdia a sessão" e
caía no login, mais de uma vez. Sem padrão aparente: às vezes ao voltar pra
aba do painel, às vezes na ação seguinte.

**Causa raiz.** Admin e conta do cliente dividiam UM cookie de sessão
(`connect.sid`) e UMA linha na tabela `session`. Todo login faz
`req.session.regenerate()` (proteção contra fixação de sessão), e regenerar
joga fora a sessão inteira — com o `anuncianteId` junto. Então, no mesmo
navegador:

- entrar no admin (`POST /admin/login`) derrubava a conta do anunciante;
- entrar como anunciante derrubava o admin;
- sair de um (`destroy`) saía dos dois.

O dono sobe um criativo no painel, abre o admin pra conferir (o admin, desde
o #81, pede "entrar" quando a sessão dele não vale), volta pra aba do painel —
e o resync do SSE no `visibilitychange` (`public/eventos.js`) pedia
`/anunciantes/me`, recebia 401 e ia pro login. Pingue-pongue: cada login
derrubava o outro.

**Prova.** Reproduzido em curl com um pote de cookies só:
`me 200 → POST /admin/login 200 → me 401`; `login do anunciante → /admin/* 401`;
`/admin/logout → me 401`.

**Não era** (conferido): MemoryStore (o store é o Postgres, ADR-003);
expiração (7 dias do login); 500/rede tratados como logout (o painel só
mandava pro login num 401); cache da conta (`carregarConta` guardava `null`
pela vida da página — defeito real, corrigido junto, mas não mandava pro
login).

**Correção.** Cookie próprio pro admin (`mostrai.admin`, `Path=/admin`) —
`src/lib/sessao.js`. Um store por sessão: o express-session pendura o
gerador de sessão no próprio objeto do store, e com um store compartilhado o
`regenerate` do admin emitia o cookie com `Path=/` (pego pelo teste).
No painel: `carregarConta` só guarda sucesso; só 401 é "sessão expirada"
(com aviso no login, sem loop); 500/rede/prazo viram erro com
[Tentar novamente] e nunca login.

**Guarda.** `tests/sessao-anunciante.test.js` (app real do `server.js`,
store no Postgres: admin e anunciante no mesmo navegador, logout de um não sai
do outro, sessão sobrevive a outro processo) e
`tests/e2e/25-sessao-e-upload.mjs` (casos A–H no navegador, incluindo
"entra no admin e volta pra aba do painel").

**Efeito colateral no deploy.** A sessão de admin antiga morava no cookie do
cliente — depois do deploy o admin entra uma vez de novo. Conta de cliente
não é afetada.

**Como evitar na origem.** Identidades diferentes (operador × cliente) não
dividem sessão. Todo `regenerate`/`destroy` afeta tudo que mora na sessão —
antes de pôr um segundo dono nela, separar.
