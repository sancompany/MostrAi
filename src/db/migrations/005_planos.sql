-- compromisso_meses = permanência mínima assumida. A Asaas cobra o ciclo
-- INTEIRO de uma vez, automaticamente, no ciclo nativo correspondente
-- (1 mês → MONTHLY, 3 → QUARTERLY, 6 → SEMIANNUALLY, 12 → YEARLY — ver
-- CICLO_ASAAS em src/financeiro/san-checkout.js e INTEGRACAO.md 6.1), não
-- ciclo mensal fixo com desconto cosmético. valor_mensal é só a unidade de
-- preço (R$/mês) usada pra calcular o valor cheio do ciclo e exibir no
-- site — não é o valor de cada cobrança quando compromisso_meses > 1.
CREATE TABLE planos (
  id text PRIMARY KEY,
  tier text NOT NULL CHECK (tier IN ('essencial', 'destaque', 'maximo')),
  nome text NOT NULL,
  valor_mensal numeric NOT NULL,        -- cobrado todo mês via assinatura
  valor_mensal_cheio numeric,           -- preço sem desconto de compromisso, só pra exibir riscado
  compromisso_meses int NOT NULL,       -- permanência mínima (1 = sem compromisso, 3/6/12)
  frequencia_dia int NOT NULL,          -- vezes que o anúncio entra na playlist por dia; a hora
                                         -- efetiva é recalculada por ponto (src/playlist/gerador.js)
                                         -- dividindo pelo horário de funcionamento de cada ponto
  cobertura text NOT NULL CHECK (cobertura IN ('um_ponto_dia', 'tres_pontos_dia', 'todos_pontos')),
  ativo boolean NOT NULL DEFAULT true
);

-- Base: essencial R$99/mês, destaque R$199/mês, máximo R$399/mês (grade de
-- lançamento, vitrina-plano-completo.md 2.3), com desconto de 10/15/20% no
-- valor mensal conforme a permanência mínima assumida.
-- frequencia_dia parte da referência antiga de 3/6/12x por hora × ~12h de
-- funcionamento (36/72/144 por dia) — recalculado por ponto de verdade a
-- partir daqui.
-- Regra de fundador: sem compromisso (1 mês) fica inativo até a rede sair
-- da fase de captação inicial (SPEC.md 2.8).
INSERT INTO planos (id, tier, nome, valor_mensal, valor_mensal_cheio, compromisso_meses, frequencia_dia, cobertura, ativo) VALUES
  ('essencial-1m', 'essencial', 'Essencial', 99, NULL, 1, 36, 'todos_pontos', false),
  ('essencial-3m', 'essencial', 'Essencial', 89.10, 99, 3, 36, 'todos_pontos', true),
  ('essencial-6m', 'essencial', 'Essencial', 84.15, 99, 6, 36, 'todos_pontos', true),
  ('essencial-12m', 'essencial', 'Essencial', 79.20, 99, 12, 36, 'todos_pontos', true),
  ('destaque-1m', 'destaque', 'Destaque', 199, NULL, 1, 72, 'todos_pontos', false),
  ('destaque-3m', 'destaque', 'Destaque', 179.10, 199, 3, 72, 'todos_pontos', true),
  ('destaque-6m', 'destaque', 'Destaque', 169.15, 199, 6, 72, 'todos_pontos', true),
  ('destaque-12m', 'destaque', 'Destaque', 159.20, 199, 12, 72, 'todos_pontos', true),
  ('maximo-1m', 'maximo', 'Máximo', 399, NULL, 1, 144, 'todos_pontos', false),
  ('maximo-3m', 'maximo', 'Máximo', 359.10, 399, 3, 144, 'todos_pontos', true),
  ('maximo-6m', 'maximo', 'Máximo', 339.15, 399, 6, 144, 'todos_pontos', true),
  ('maximo-12m', 'maximo', 'Máximo', 319.20, 399, 12, 144, 'todos_pontos', true);
