-- Módulo 1 — Pontos (SPEC.md)
-- status como text+CHECK em vez de ENUM nativo: já mudamos essa lista duas
-- vezes na fase de escopo (entrou "lead" depois), e alterar um CHECK é bem
-- mais simples que ALTER TYPE em produção.
CREATE TABLE pontos (
  id serial PRIMARY KEY,
  nome text NOT NULL,
  endereco text NOT NULL,
  cidade text NOT NULL,
  uf text NOT NULL,
  cep text NOT NULL,
  segmento text NOT NULL,
  responsavel_nome text NOT NULL,
  responsavel_contato text NOT NULL,
  aceitou_termos_em timestamptz,
  aparelho_id text UNIQUE,
  valor_pago_mensal numeric NOT NULL DEFAULT 0,
  cota_autoanuncio_slots_hora integer NOT NULL DEFAULT 0,
  horario_abertura time,
  horario_fechamento time,
  status text NOT NULL DEFAULT 'lead'
    CHECK (status IN ('lead', 'aguardando_instalacao', 'ativo', 'inativo')),
  ultima_vez_online timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
