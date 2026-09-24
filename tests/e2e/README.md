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
bash tests/e2e/01-fluxo-api.sh                     # pedido de ponto → admin libera → Meus pontos → telas ativadas → player → anunciante indicado pelo cupom PT- → e-mail
tests/e2e/reset-db.sh && bash tests/e2e/04-modos-e-bonus.sh  # conta só-ponto (convite) → modo anúncios → outro estabelecimento → troca da ajuda de custo → bônus de anúncio
bash tests/e2e/02-assinatura-webhook-comissao.sh   # parceiro (status de conta), vagas, webhook, cobertura, comissão
tests/e2e/reset-db.sh && tests/e2e/restart.sh
# Cada roteiro de navegador assume banco zerado (repetem e-mails entre si):
# rode tests/e2e/reset-db.sh antes de cada um. Screenshots em tests/e2e/saida/.
PW_CHROME=... node tests/e2e/03-navegador.mjs      # conta pede ponto → admin aprova na ficha → tela e PIN na ficha da tela → player V1 + painel por PIN; planos, Contas, celular
PW_CHROME=... node tests/e2e/05-navegador-modos.mjs  # candidatura sem conta → convite de ponto → Meu ponto, troca da ajuda de custo, ativação do modo anúncios; card do modo Meu ponto (a ViaCEP é respondida pelo roteiro)
PW_CHROME=... node tests/e2e/06-painel-bloqueio-plano.mjs  # sem plano trava o painel; admin libera cortesia e destrava
PW_CHROME=... node tests/e2e/07-painel-design.mjs  # marca, paleta, hero sem KPI duplicado + estado operacional, "previstas", custo por 1.000, média diária, barra de 1 ponto
PW_CHROME=... node tests/e2e/08-candidatura-ponto.mjs  # card "Faça parte da rede": movimento médio obrigatório, segmento resolvido por categoria_id OU categoria_livre
PW_CHROME=... node tests/e2e/09-rede-redesenho.mjs # Rede: status automático (grade/filtros/detalhe/site público), telas em cards + margens, ocupação como tabela, candidatura com foto
PW_CHROME=... node tests/e2e/16-rede-player-v2.mjs # Player V2: + Tela → Preparar instalação (download do mostrai-config.json) → provisionar → hello → Operando sem recarregar → config desejada × aplicada → erro no Diagnóstico → Histórico → rotação com sobreposição → nenhum segredo na UI/JSON → visão do dono → V1 ainda funciona
```

O limite de tentativas vive no banco desde a migration 051 (`tentativas_acesso`,
não mais um `Map` em memória — ver `src/lib/limite-tentativas.js`). Reiniciar
o servidor (`restart.sh`) NÃO zera o contador. Se um teste bater em "muitas
tentativas", rode `reset-db.sh` de novo (já trunca `tentativas_acesso`) ou
espere a janela de 15 min passar. Cookies e screenshots vão em
`tests/e2e/saida/` (ignorado no git).
