-- Exclusão de conta é soft-delete: guarda quando foi pedida, não apaga nada
-- na hora. Recuperável por 60 dias falando com o suporte (o admin zera essa
-- coluna manualmente) — sem fluxo de undo self-service por enquanto. Login
-- fica bloqueado enquanto estiver preenchida (ver POST /anunciantes/login).
ALTER TABLE anunciantes ADD COLUMN excluido_em timestamptz;
