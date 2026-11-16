-- TICK — as campanhas de indicação passam para o modelo de Campanhas (015).
--
-- NÃO APAGA NEM ALTERA NADA DO QUE EXISTE: `campanhas_indicacao`,
-- `recompensas_indicacao` e `indicacoes` ficam intactas (só leitura daqui em
-- diante — decisão do dono de 16/11/2026: preservar as tabelas antigas, sem
-- remoção). A remoção delas só numa migration futura, com autorização.
--
-- Por que um livro de conversões NOVO (`campanha_indicacoes`) e não a tabela
-- `indicacoes`: ela tem FK para `campanhas_indicacao` e é única por pedido
-- (um pedido, uma campanha). Reaproveitá-la exigiria remover essas duas
-- restrições. O livro novo é a cópia fiel, apontando para `campanhas` e
-- único por (campanha, pedido) — o pedido pode contar em mais de uma campanha
-- de indicação (acumuláveis; R1 deixa uma só não acumulável ativa).
--
-- Cópia com os MESMOS ids de campanha. Cada campanha antiga ("a cada N
-- indicações pagas, 1 recompensa, até X por pessoa, Q no total") vira uma
-- campanha de indicação com um nível que se repete: de = N, estoque = Q,
-- limite por pessoa = X. Cada recompensa antiga vira um prêmio (repetição 1,
-- 2, 3… por indicador), com o histórico.
--
-- Reversão: DROP TABLE campanha_indicacoes; DELETE das linhas copiadas em
-- campanha_premio_eventos/campanha_premios/campanha_faixas/campanhas só se a
-- reversão vier antes de qualquer campanha nova (as antigas seguem intactas).

CREATE TABLE campanha_indicacoes (
  id bigserial PRIMARY KEY,
  campanha_id bigint NOT NULL REFERENCES campanhas(id),
  indicador_id bigint NOT NULL REFERENCES indicadores(id),
  pedido_id uuid NOT NULL REFERENCES pedidos(id),
  cliente_id bigint NOT NULL REFERENCES clientes(id),
  valida boolean NOT NULL DEFAULT true,
  -- R2: instante oficial em que a TICK aplicou a confirmação do pedido.
  confirmado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campanha_id, pedido_id)
);
-- A mesma pessoa conta uma vez por campanha.
CREATE UNIQUE INDEX ux_campanha_indicacao_pessoa ON campanha_indicacoes (campanha_id, cliente_id) WHERE valida;
CREATE INDEX ix_campanha_indicacoes_indicador ON campanha_indicacoes (campanha_id, indicador_id) WHERE valida;
CREATE INDEX ix_campanha_indicacoes_pedido ON campanha_indicacoes (pedido_id);
ALTER TABLE campanha_indicacoes ENABLE ROW LEVEL SECURITY;

-- Campanhas (mesmos ids). Ativa → 'ativa'; inativa → 'pausada'.
INSERT INTO campanhas (id, edicao_id, modalidade, nome, status, inicio, fim, acumula, escada,
                       limite_por_pessoa, criado_em, atualizado_em)
SELECT id, edicao_id, 'indicacao', nome, CASE WHEN ativo THEN 'ativa' ELSE 'pausada' END, inicio, fim, false,
       'cumulativa', limite_por_indicador, criado_em, atualizado_em
  FROM campanhas_indicacao;
SELECT setval(pg_get_serial_sequence('campanhas', 'id'), COALESCE((SELECT max(id) FROM campanhas), 0) + 1, false);

INSERT INTO campanha_faixas (campanha_id, ordem, de, repete, premio, quantidade, estoque)
SELECT id, 1, indicacoes_por_recompensa, true, recompensa, 1, quantidade
  FROM campanhas_indicacao;

-- Conversões.
INSERT INTO campanha_indicacoes (campanha_id, indicador_id, pedido_id, cliente_id, valida, confirmado_em, criado_em, atualizado_em)
SELECT x.campanha_id, x.indicador_id, x.pedido_id, x.cliente_id, x.valida, p.pago_em, x.criado_em, x.atualizado_em
  FROM indicacoes x JOIN pedidos p ON p.id = x.pedido_id;

-- Recompensas → prêmios (repetição pela ordem de concessão, por indicador).
INSERT INTO campanha_premios (campanha_id, faixa_id, indicador_id, repeticao, premio, brinde, quantidade,
                              valor_centavos, exclusivo, so_admin, status, motivo, concedido_em, entregue_em,
                              entregue_por, revogado_em, atualizado_em, chave)
SELECT r.campanha_id, f.id, r.indicador_id, r.rep, c.recompensa,
       'n:' || left(lower(trim(c.recompensa)), 86), 1, 0, true, ind.operador_id IS NOT NULL,
       CASE r.status WHEN 'concedida' THEN 'concedido' WHEN 'entregue' THEN 'entregue' ELSE 'revogado' END,
       CASE WHEN r.status = 'revogada' THEN 'indicação reembolsada (antes da migração)' END,
       r.concedida_em, r.entregue_em, r.entregue_por,
       CASE WHEN r.status = 'revogada' THEN COALESCE(r.revogada_em, r.concedida_em) END,
       now(),
       'niv:' || r.campanha_id || ':' || r.indicador_id || ':' || f.id || ':' || r.rep
  FROM (SELECT ri.*, row_number() OVER (PARTITION BY ri.campanha_id, ri.indicador_id ORDER BY ri.concedida_em, ri.id) AS rep
          FROM recompensas_indicacao ri) r
  JOIN campanhas_indicacao c ON c.id = r.campanha_id
  JOIN campanha_faixas f ON f.campanha_id = r.campanha_id AND f.ordem = 1
  JOIN indicadores ind ON ind.id = r.indicador_id;

INSERT INTO campanha_premio_eventos (premio_id, acao, autor, motivo, em)
SELECT p.id, 'concedido', 'migracao', 'cópia da recompensa de indicação anterior', p.concedido_em FROM campanha_premios p
 WHERE p.chave LIKE 'niv:%';
INSERT INTO campanha_premio_eventos (premio_id, acao, autor, motivo, em)
SELECT p.id, 'entregue', COALESCE(p.entregue_por, 'migracao'), 'cópia da recompensa de indicação anterior', p.entregue_em
  FROM campanha_premios p WHERE p.status = 'entregue' AND p.chave LIKE 'niv:%';
INSERT INTO campanha_premio_eventos (premio_id, acao, autor, motivo, em)
SELECT p.id, 'revogado', 'migracao', p.motivo, p.revogado_em
  FROM campanha_premios p WHERE p.status = 'revogado' AND p.chave LIKE 'niv:%';
