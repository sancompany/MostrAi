const test = require('node:test');
const assert = require('node:assert');
const pool = require('../src/db/pool');

// Guarda da migration 031 (e da 091, que repetiu o laço): toda tabela do
// schema `public` nasce com RLS ligada e sem política — é o que fecha a API
// REST automática do Supabase (PostgREST) para a chave `anon`, que é pública
// por definição. A 031 só pegou as tabelas que existiam naquele dia; 22
// tabelas criadas depois ficaram abertas até 26/09/2026
// (docs/erros/2026-09-26-tabelas-novas-sem-rls.md). Este teste roda depois
// das migrations (CI: `npm run migrate` antes do `npm run check`) e quebra
// quando alguém cria tabela nova e esquece o `ENABLE ROW LEVEL SECURITY`.

test.after(() => pool.end());

test('toda tabela do schema public tem RLS ligada', async () => {
  const { rows } = await pool.query(
    `SELECT c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
      ORDER BY 1`,
  );
  assert.deepStrictEqual(
    rows.map((r) => r.relname),
    [],
    'tabela nova sem RLS: acrescente `ALTER TABLE <tabela> ENABLE ROW LEVEL SECURITY;` na migration que a cria',
  );
});
