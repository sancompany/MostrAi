-- TICK — Promoters e comissões (PR 1: banco e motor), 16/11/2026.
--
-- Regras aprovadas (docs/trimundi/decisoes-comerciais-2026-11-14.md, regras
-- 4 a 9 e decisão B; desenho em docs/trimundi/specs/2026-11-16-promoters-desenho.md):
--   - promoter é permissão própria, concedida pelo Admin; nada a ver com a
--     portaria (operadores) — decisão B;
--   - o link de venda é o link de indicação que a conta já tem (indicadores);
--   - base da comissão = valor efetivamente pago pelo ingresso, sem taxas
--     (regra 4); taxa não informada fica NULL ("—"), nunca inventada;
--   - percentual pela venda de número k na edição (10% até a 19ª, +1 a cada
--     10, teto 15% na 60ª), gravado na confirmação e nunca recalculado
--     (regra 5); cada ingresso pago conta uma; reembolso desconta (regra 6);
--     contagem por edição (regra 7); abaixo de 10, comissão provisória
--     (regra 8);
--   - recrutamento: um recrutador por pessoa, sem cadeia; 1 ingresso em
--     crédito quando o recrutado chega a 10 vendas na mesma edição, emitido
--     pelo Admin como cortesia nominal (regras 3 e 9).
--
-- Livro de comissões só de acréscimo: estorno é lançamento novo ligado ao
-- original. Pagamento manual (decisão C), também só de acréscimo.
--
-- Nada existente muda; nenhuma tabela ou coluna sai.
--
-- Reversão (só antes de existir dado):
--   DROP TABLE promoter_creditos, promoter_pagamento_itens, promoter_pagamentos,
--              promoter_comissoes, promoter_eventos, promoters;

CREATE TABLE promoters (
  id bigserial PRIMARY KEY,
  cliente_id bigint NOT NULL UNIQUE REFERENCES clientes(id),
  -- O link de venda: o indicador da própria conta (criado na aprovação).
  indicador_id bigint UNIQUE REFERENCES indicadores(id),
  situacao text NOT NULL DEFAULT 'candidato'
    CHECK (situacao IN ('candidato', 'ativo', 'recusado', 'suspenso', 'encerrado')),
  -- Quem recrutou (um só, regra 9). Sem cadeia: só o recrutador direto ganha.
  recrutador_id bigint REFERENCES promoters(id),
  candidatura_em timestamptz NOT NULL DEFAULT now(),
  -- Primeira aprovação: vendas confirmadas antes dela não geram comissão
  -- (sem retroativo — decisão B).
  aprovado_em timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  -- Termo do promoter (P-8, texto do advogado): versão e data quando existir.
  termo_versao text CHECK (char_length(termo_versao) <= 40),
  termo_aceito_em timestamptz,
  CHECK (recrutador_id IS NULL OR recrutador_id <> id),
  CHECK (situacao IN ('candidato', 'recusado') OR aprovado_em IS NOT NULL)
);
CREATE INDEX ix_promoters_recrutador ON promoters (recrutador_id) WHERE recrutador_id IS NOT NULL;

-- Histórico das decisões do Admin sobre o promoter (aprovar, recusar,
-- suspender, reativar, encerrar), com autor e motivo. Imutável.
CREATE TABLE promoter_eventos (
  id bigserial PRIMARY KEY,
  promoter_id bigint NOT NULL REFERENCES promoters(id),
  acao text NOT NULL CHECK (acao IN ('candidatura', 'aprovado', 'recusado', 'suspenso', 'reativado', 'encerrado')),
  de text,
  para text NOT NULL,
  motivo text CHECK (char_length(motivo) <= 300),
  autor text NOT NULL CHECK (char_length(autor) <= 200),
  autor_access text CHECK (char_length(autor_access) <= 200),
  ocorrido_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_promoter_eventos ON promoter_eventos (promoter_id, id);
CREATE TRIGGER promoter_eventos_imutavel BEFORE UPDATE OR DELETE ON promoter_eventos
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

-- Livro de comissões. 'venda': um por ingresso pago atribuído ao promoter;
-- 'estorno': um por venda, quando o ingresso é cancelado (reembolso).
CREATE TABLE promoter_comissoes (
  id bigserial PRIMARY KEY,
  promoter_id bigint NOT NULL REFERENCES promoters(id),
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  pedido_id uuid NOT NULL REFERENCES pedidos(id),
  ingresso_id bigint NOT NULL REFERENCES ingressos(id),
  tipo text NOT NULL CHECK (tipo IN ('venda', 'estorno')),
  origem_id bigint REFERENCES promoter_comissoes(id),
  -- Número desta venda na edição (k), contando só as vendas de pé na hora.
  venda_numero integer CHECK (venda_numero >= 1),
  -- Valor bruto do pedido (o que o comprador pagou pelos ingressos, antes
  -- das taxas do Checkout) e taxas: NULL = não informado.
  valor_bruto_pedido_centavos bigint CHECK (valor_bruto_pedido_centavos >= 0),
  taxas_centavos bigint CHECK (taxas_centavos >= 0),
  base_centavos bigint NOT NULL CHECK (base_centavos >= 0),
  percentual numeric(5, 2) NOT NULL CHECK (percentual > 0 AND percentual <= 100),
  comissao_centavos bigint NOT NULL CHECK (comissao_centavos >= 0),
  motivo text CHECK (char_length(motivo) <= 300),
  registrado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((tipo = 'venda') = (origem_id IS NULL)),
  CHECK ((tipo = 'venda') = (venda_numero IS NOT NULL))
);
CREATE UNIQUE INDEX ux_promoter_comissoes_venda ON promoter_comissoes (ingresso_id) WHERE tipo = 'venda';
CREATE UNIQUE INDEX ux_promoter_comissoes_estorno ON promoter_comissoes (origem_id) WHERE tipo = 'estorno';
CREATE INDEX ix_promoter_comissoes ON promoter_comissoes (promoter_id, edicao_id, id);
CREATE INDEX ix_promoter_comissoes_pedido ON promoter_comissoes (pedido_id);
CREATE TRIGGER promoter_comissoes_imutavel BEFORE UPDATE OR DELETE ON promoter_comissoes
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

-- Pagamento manual registrado pelo Admin (decisão C): data, meio, referência
-- e as vendas pagas. Correção é lançamento novo; nada se apaga.
CREATE TABLE promoter_pagamentos (
  id bigserial PRIMARY KEY,
  promoter_id bigint NOT NULL REFERENCES promoters(id),
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  valor_centavos bigint NOT NULL CHECK (valor_centavos > 0),
  pago_em date NOT NULL,
  meio text NOT NULL CHECK (char_length(meio) BETWEEN 1 AND 40),
  referencia text CHECK (char_length(referencia) <= 120),
  observacao text CHECK (char_length(observacao) <= 300),
  registrado_por text NOT NULL CHECK (char_length(registrado_por) <= 200),
  registrado_por_access text CHECK (char_length(registrado_por_access) <= 200),
  registrado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_promoter_pagamentos ON promoter_pagamentos (promoter_id, edicao_id);
CREATE TRIGGER promoter_pagamentos_imutavel BEFORE UPDATE OR DELETE ON promoter_pagamentos
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

CREATE TABLE promoter_pagamento_itens (
  pagamento_id bigint NOT NULL REFERENCES promoter_pagamentos(id),
  -- Cada venda é paga uma vez só.
  comissao_id bigint NOT NULL UNIQUE REFERENCES promoter_comissoes(id),
  PRIMARY KEY (pagamento_id, comissao_id)
);
CREATE TRIGGER promoter_pagamento_itens_imutavel BEFORE UPDATE OR DELETE ON promoter_pagamento_itens
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

-- Crédito de recrutamento: 1 ingresso para o recrutador quando o recrutado
-- chega a 10 vendas numa edição. Uma vez por recrutado (sem duplicidade,
-- §5.4). 'pendente' → o Admin emite a cortesia nominal e marca 'emitido';
-- 'revogado' se o recrutado voltar abaixo de 10 antes da emissão.
CREATE TABLE promoter_creditos (
  id bigserial PRIMARY KEY,
  recrutador_id bigint NOT NULL REFERENCES promoters(id),
  recrutado_id bigint NOT NULL UNIQUE REFERENCES promoters(id),
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  situacao text NOT NULL DEFAULT 'pendente' CHECK (situacao IN ('pendente', 'emitido', 'revogado')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  emitido_por text CHECK (char_length(emitido_por) <= 200),
  nota text CHECK (char_length(nota) <= 300),
  CHECK (recrutador_id <> recrutado_id)
);
CREATE INDEX ix_promoter_creditos_recrutador ON promoter_creditos (recrutador_id);

ALTER TABLE promoters ENABLE ROW LEVEL SECURITY;
ALTER TABLE promoter_eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE promoter_comissoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE promoter_pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE promoter_pagamento_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE promoter_creditos ENABLE ROW LEVEL SECURITY;
