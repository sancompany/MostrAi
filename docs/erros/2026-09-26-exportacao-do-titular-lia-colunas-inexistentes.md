# Exportação do titular (LGPD) quebrava pra qualquer conta — lia duas colunas que não existem

**Sintoma.** Nenhum relatado: a rota `GET /titular/meus-dados` (RN-24) nunca
foi usada por cliente real. Qualquer chamada respondia 500.

**Causa raiz.** `exportarConta` (`src/titular/repository.js`) lia:

- `exibicoes_contador.ponto_id` — dropada na migration 036 (a tela já diz o
  ponto);
- `planos_administrativos.criado_em` — a coluna nasceu `created_at` (075); a
  consulta foi escrita na consolidação de 24/09/2026 pelo nome que as outras
  tabelas usam.

As consultas rodam num `Promise.all`; uma coluna inexistente derruba a
exportação inteira. Nenhum teste passava por `src/titular/`.

**Como foi achado.** Inventário Backend ↔ Player (26/09/2026) notou a leitura
de `ponto_id`; ao corrigir, cada consulta da exportação foi executada contra o
schema atual, e apareceu a segunda.

**Correção.** `ponto_id` vem da tela (`JOIN dispositivos`) e `created_at` sai
como `criado_em` — o formato do JSON exportado não muda.

**Guarda.** `tests/titular-exportacao.test.js` monta conta com exibição e
benefício e exige a exportação no formato documentado.

**Como evitar na origem.** Migration que dropa ou renomeia coluna vem com um
`grep` do nome em `src/` — e consulta nova só entra depois de rodar ao menos
uma vez contra o banco (um teste que a execute basta).
