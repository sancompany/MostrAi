# O limitador de tentativas chaveava pelo que o cliente controla

**Sintoma** (auditoria Review-Master, ciclo 1, 11/10/2026 — AUD-002, ALTO e
reproduzido em servidor local). O teto de "10 tentativas por IP a cada 15
min" do `src/lib/limite-tentativas.js` valia só no papel:

- **Grafia do caminho** (AUD-002). A chave era `${req.ip}:${req.path}` com o
  caminho cru. O Express, sem `case sensitive routing`/`strict routing`,
  roteia `/Anunciantes/login`, `/anunciantes/login/` e `/ANUNCIANTES/LOGIN`
  para o mesmo handler — e cada grafia ganhava um balde novo de 10.

**Causa raiz.** A chave do balde era montada com o que o CLIENTE controla — a
grafia pedida. Um limitador só limita o que a chave distingue.

**Correção** (sem migration; `tests/limite-login.test.js` sobe o app real):

- Rota = `req.route.path`, a rota como declarada.

**O que a revisão ensinou no caminho** (12/10/2026):

- `tests/email-verificacao.test.js` apagava a tabela inteira antes de cada
  chamada; com `npm test` em paralelo, isso zerava no meio do laço o balde que
  o teste do limitador esperava ver estourar. Teste apaga só as próprias
  chaves.

**Regra que fica.** A chave de um limitador é montada pelo SERVIDOR a partir
do que ele decidiu (a rota registrada) — nunca do caminho como chegou.
