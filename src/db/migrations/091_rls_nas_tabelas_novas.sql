-- (084 continua reservada pro Player V2 — ver o cabeçalho da 085.)
--
-- Refaz o laço da 031 (RLS ligada, sem política) nas tabelas criadas DEPOIS
-- dela. A 031 só alcançou o que existia no dia; de lá pra cá 22 tabelas
-- nasceram sem `ENABLE ROW LEVEL SECURITY` (só a 087 lembrou), e conferência
-- só-leitura em produção de 26/09/2026 achou todas com SELECT liberado pro
-- papel `anon` — ou seja, abertas pela API REST automática do Supabase pra
-- quem tiver a chave pública. Entre elas: mensagens_contato, tentativas_acesso
-- (IP), tokens_confirmacao_email, tokens_provisionamento, creditos_ledger.
-- Registro do erro: docs/erros/2026-09-26-tabelas-novas-sem-rls.md.
--
-- Mesma decisão da 031, pelo mesmo motivo: sem política e sem FORCE. O dono
-- da tabela (o usuário da aplicação) passa por cima da RLS, então o Mostraí
-- continua igual; `anon` e `authenticated` passam a enxergar zero linha.
--
-- ADITIVA e idempotente: só liga onde está desligada; não cria, apaga nem
-- altera dado. A regressão é pega por tests/rls.test.js.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
