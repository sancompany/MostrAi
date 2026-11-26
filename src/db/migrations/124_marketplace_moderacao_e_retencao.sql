-- Marketplace de Lojas — moderação e retenção (26/11/2026, pedido do dono).
-- Só colunas novas nas tabelas do marketplace (migration 123); nenhuma tabela
-- da rede própria muda.

-- TRAVA DE MODERAÇÃO. O espaço bloqueado pelo Admin não volta para a vitrine
-- pela mão da dona: só o Admin libera. Garantido pelo banco, não só pela
-- rota — bloqueado nunca está `publicado`.
ALTER TABLE lojas_espacos ADD COLUMN bloqueado_admin_em timestamptz;
ALTER TABLE lojas_espacos ADD COLUMN bloqueado_motivo text CHECK (char_length(bloqueado_motivo) <= 300);
ALTER TABLE lojas_espacos ADD CONSTRAINT lojas_espacos_bloqueio_coerente
  CHECK ((bloqueado_admin_em IS NULL) = (bloqueado_motivo IS NULL));
ALTER TABLE lojas_espacos ADD CONSTRAINT lojas_espacos_bloqueado_fora_da_vitrine
  CHECK (bloqueado_admin_em IS NULL OR status <> 'publicado');

-- Contato respondido (a resposta acontece por fora — e-mail, telefone).
ALTER TABLE lojas_contatos ADD COLUMN respondido_em timestamptz;

-- RETENÇÃO (LGPD): o contato da vitrine é guardado por 12 meses e depois
-- apagado pelo expurgo de hora em hora (src/lojas/repository.js,
-- `expurgarContatosAntigos`). Índice para o expurgo não varrer a tabela.
CREATE INDEX ix_lojas_contatos_criado ON lojas_contatos (criado_em);
