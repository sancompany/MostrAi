-- Fecha a porta do PostgREST: RLS ligada em tudo, sem política nenhuma.
--
-- O problema: o Supabase expõe uma API REST automática (PostgREST) sobre o
-- schema `public`, e os papéis `anon` e `authenticated` já vêm com SELECT em
-- tudo. Sem RLS, quem tiver a chave `anon` — que não é segredo por definição,
-- ela é feita pra viver dentro de navegador — lê o banco inteiro por
-- `https://<projeto>.supabase.co/rest/v1/anunciantes?select=*`: CPF/CNPJ,
-- e-mail, telefone, `senha_hash`, `tokens_senha` e a tabela `session`.
-- O painel de saúde do próprio Supabase marcava as 27 tabelas em ERROR.
--
-- Nada no Mostraí usa o PostgREST: a aplicação fala com o Postgres por conexão
-- direta (src/db/pool.js) e o Supabase só é usado como Storage
-- (src/lib/supabase.js). Então a porta pode ser fechada inteira.
--
-- Por que RLS sem política, e não REVOKE: com RLS ligada e nenhuma política,
-- `anon` e `authenticated` enxergam zero linha, e qualquer tabela nova que
-- alguém esqueça de proteger continua aparecendo no painel de saúde — o erro
-- fica visível em vez de silencioso. E o dono da tabela (que é o usuário da
-- aplicação) **não** é afetado: no Postgres, o dono passa por cima da RLS a
-- menos que se peça FORCE ROW LEVEL SECURITY, o que não é o caso aqui.
--
-- ADITIVA: não cria, não apaga e não altera dado nenhum.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
