# Testes ponta a ponta (rodam contra um servidor local de verdade)

Pré-requisitos: Postgres local com o banco `mostrai` (usuário/senha `mostrai`),
`.env` apontando pra ele (`NODE_ENV=test`, `PORT=3999`, `ADMIN_USER=admin`,
`ADMIN_PASSWORD=Admin12@teste`, `SAN_CHECKOUT_KEY` qualquer — é com ela que
os testes assinam o webhook, como o Checkout assina), `openssl` no PATH,
`npm run migrate` aplicado, e `psql`/`curl` no PATH. Pro teste de navegador,
`npm i -D playwright` e um Chromium (`PW_CHROME=/caminho/do/chrome`).

```bash
tests/e2e/reset-db.sh                              # zera as tabelas de dados (não os planos)
tests/e2e/restart.sh                               # sobe o servidor na 3999
bash tests/e2e/01-fluxo-api.sh                     # candidatura → convite → tela → player → cadastro de anunciante
bash tests/e2e/02-assinatura-webhook-comissao.sh   # fundador (status de conta), vagas, webhook, cobertura, comissão
tests/e2e/reset-db.sh && tests/e2e/restart.sh
PW_CHROME=... node tests/e2e/03-navegador.mjs      # 36 checagens no Chromium + screenshots em tests/e2e/saida/
```

O limite de tentativas é em memória: se um teste bater em "muitas tentativas",
reinicie o servidor (`restart.sh`) e rode de novo. Cookies e screenshots vão
em `tests/e2e/saida/` (ignorado no git).
