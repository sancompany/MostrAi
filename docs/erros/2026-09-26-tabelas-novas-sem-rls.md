# 22 tabelas criadas depois da migration 031 ficaram sem RLS — legíveis pela chave `anon`

**Sintoma.** Nenhum visível na aplicação: o Mostraí fala com o Postgres por
conexão direta, como dono das tabelas, e o dono passa por cima da RLS. O
buraco só aparece de fora. Conferência só-leitura em produção (26/09/2026,
`pg_class.relrowsecurity` + `has_table_privilege('anon', oid, 'SELECT')`)
achou **22 das 49 tabelas do `public` com RLS desligada e SELECT liberado pro
papel `anon`**: anunciantes_pontos, banco_horas, banco_horas_execucoes,
configuracoes_site, creditos_ledger, cupons_ponto, execucoes_confirmadas,
indicacoes_pagas, mensagens_contato, midias_proprias, midias_proprias_pontos,
notificacoes, pedidos_avulsos, planos_administrativos, player_releases,
playlist_hora_congelada, promocoes, promocoes_itens, tela_eventos,
tentativas_acesso, tokens_confirmacao_email, tokens_provisionamento.

A chave `anon` do Supabase é pública por definição. Com a API REST automática
(PostgREST) ligada, qualquer um lê essas tabelas por
`https://<projeto>.supabase.co/rest/v1/<tabela>` — mensagem de contato, IP de
tentativa de acesso, hash de token de e-mail e de provisionamento, ledger de
crédito. Não foi testado com a chave (nem deve ser); não há indício de uso.

**Causa raiz.** A 031 ligou a RLS com um laço sobre `pg_tables` — correto,
mas só alcança as tabelas que existiam no dia em que rodou. Nada obrigava as
migrations seguintes a repetir o `ENABLE ROW LEVEL SECURITY`; só a 087
lembrou. O próprio comentário da 031 contava com o painel de saúde do
Supabase pra acusar o esquecimento, e ninguém estava olhando o painel.

**Como foi achado.** No inventário Backend ↔ Player (26/09/2026), um agente
notou que as tabelas do Player (064, 065, 083) não tinham RLS em migration
nenhuma; a consulta em produção mostrou que o problema era de todas as
tabelas pós-031.

**Correção.** Migration `091_rls_nas_tabelas_novas.sql`: o mesmo laço da 031,
só onde a RLS está desligada. Sem política, sem FORCE — o app continua
igual, `anon`/`authenticated` passam a ver zero linha.

**Guarda.** `tests/rls.test.js` roda depois das migrations (no CI,
`npm run migrate` vem antes do `npm run check`) e quebra se qualquer tabela
do `public` estiver com `relrowsecurity = false`. Tabela nova sem RLS não
passa mais no CI.

**Como evitar na origem.** Proteção que depende de "rodar de novo quando
criar coisa nova" precisa de um teste que confira o estado final, não de
disciplina. Toda migration que cria tabela termina com
`ALTER TABLE <tabela> ENABLE ROW LEVEL SECURITY;`.

**Ecossistema:** sim — vale pra todo projeto San & Co. sobre Supabase que usa
conexão direta e deixa o PostgREST fechado por RLS sem política (conferir o
San Checkout).
