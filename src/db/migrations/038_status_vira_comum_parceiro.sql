-- `anunciantes.status` misturava dois sentidos sem relação um com o outro:
-- um rótulo comercial ("fundador") e um estado operacional (herdado do
-- extinto modelo de aprovação de conta, RN-34). Pedido do dono, 16/09/2026,
-- na rodada de depuração: "o status de aprovado pendente e ativo continuam
-- no status do cliente, mude esse status somente para 2 status comum e
-- parceiro que é a substituição do fundador" — e depois: "o status serve
-- somente para separar parceiro de cliente comum, e os criativos são
-- aprovados quando sobem em uma aba deles próprio" (confirmando que o
-- criativo, não a conta, é o portão real de veiculação).
--
-- Agora são dois campos:
--   - `status`: só 'comum' ou 'parceiro' — rótulo, nunca bloqueia nada.
--   - `suspenso`: booleano — o que de fato bloqueia login em
--     /anunciantes/:id/assinar e some da playlist. Substitui o que os
--     valores 'suspenso' (bloqueio) e 'pendente_aprovacao'/'aprovado'/'ativo'
--     (herança do modelo de aprovação) faziam misturado no `status`.
--
-- Ordem importa: primeiro guarda o que `suspenso` precisa saber (quem tinha
-- status='suspenso'), depois vira `fundador` em 'parceiro', só então troca a
-- constraint do domínio velho pelo novo.
ALTER TABLE anunciantes ADD COLUMN suspenso boolean NOT NULL DEFAULT false;
UPDATE anunciantes SET suspenso = true WHERE status = 'suspenso';

ALTER TABLE anunciantes RENAME COLUMN fundador_desconto_percentual TO parceiro_desconto_percentual;
ALTER TABLE anunciantes RENAME COLUMN fundador_compromisso_minimo TO parceiro_compromisso_minimo;
UPDATE anunciantes SET status = 'parceiro' WHERE fundador;
UPDATE anunciantes SET status = 'comum' WHERE status <> 'parceiro';
ALTER TABLE anunciantes DROP COLUMN fundador;

ALTER TABLE anunciantes DROP CONSTRAINT anunciantes_status_check;
ALTER TABLE anunciantes ALTER COLUMN status SET DEFAULT 'comum';
ALTER TABLE anunciantes ADD CONSTRAINT anunciantes_status_check CHECK (status IN ('comum', 'parceiro'));
