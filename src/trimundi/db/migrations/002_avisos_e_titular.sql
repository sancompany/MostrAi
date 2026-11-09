-- Trimundi — avisos marcados como resolvidos pelo Admin. A chave inclui o
-- momento do fato: um fato NOVO do mesmo tipo no mesmo pedido (outro
-- chargeback, outro aviso morto) volta a aparecer.
CREATE TABLE avisos_resolvidos (
  id bigserial PRIMARY KEY,
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  chave text NOT NULL UNIQUE CHECK (char_length(chave) BETWEEN 1 AND 200),
  motivo text NOT NULL CHECK (char_length(motivo) BETWEEN 1 AND 300),
  resolvido_por text NOT NULL CHECK (char_length(resolvido_por) <= 200),
  resolvido_por_access text CHECK (char_length(resolvido_por_access) <= 200),
  resolvido_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_avisos_resolvidos_edicao ON avisos_resolvidos (edicao_id);
ALTER TABLE avisos_resolvidos ENABLE ROW LEVEL SECURITY;
