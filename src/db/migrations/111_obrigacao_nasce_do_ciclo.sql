-- A OBRIGAÇÃO DE VEICULAÇÃO NASCE DO CICLO CONTRATADO (01/10/2026, correção
-- estrutural achada na auditoria Review-Master; decisão do dono).
--
-- Até aqui a obrigação nascia da CAPACIDADE: cada tela, em cada hora aberta
-- em que pedia playlist, gravava `exibicoes_contador.segundos_obrigacao`, e o
-- saldo era a soma disso menos o entregue. Sem tela, nenhuma linha — quem
-- comprava um Pro com a rede vazia pagava, recebia 0 h, devia-se 0 h e o
-- painel dizia "Em dia".
--
-- Agora: comprar/renovar um ciclo cria a obrigação INTEIRA do ciclo (horas do
-- plano por mês × meses do ciclo); a capacidade da rede só serve pra pagá-la;
-- só Proof-of-Play confirmado abate. As horas por tela continuam gravadas em
-- `exibicoes_contador` (diagnóstico da capacidade e a parcela do Plano Básico),
-- mas não decidem mais quanto se deve do plano comercial.
--
-- ADITIVA: duas tabelas novas, nada alterado nem apagado. Produção em
-- 01/10/2026 (conferido só leitura): 0 contas com plano, 0 cobranças, 0 ciclos
-- contratados, 0 linhas de banco de horas — nenhum caso histórico pra
-- converter, e por isso nenhum backfill.

-- ---------------------------------------------------------------------------
-- 1. O livro da obrigação
-- ---------------------------------------------------------------------------
-- Uma linha por fato que muda o que a Mostraí deve em tempo de tela:
--   ciclo                — compra/renovação paga (+ horas do ciclo inteiro);
--   troca                — troca de plano no meio do ciclo: a diferença de
--                          horas/mês entre o plano novo e o antigo pelos dias
--                          que faltavam (mesma régua do acerto do Checkout);
--                          negativa no rebaixamento;
--   beneficio            — benefício por créditos/cortesia ativado (+ horas
--                          do plano pelos dias de validade);
--   beneficio_encerrado  — benefício encerrado antes do fim (− o que faltava);
--   reembolso            — reembolso integral do ciclo `referencia_id`: o
--                          ciclo some; o que já tinha sido entregue dele vira
--                          saldo técnico negativo (interno, nunca mostrado ao
--                          cliente como dívida).
-- Nunca é editada nem apagada: o estado da conta é derivado daqui + do
-- Proof-of-Play (`exibicoes_contador.vezes_confirmadas`).
--
-- `chave` é a identidade do fato (idempotência): `ciclo:<ciclos_contratados.id>`,
-- `troca:<ciclos_contratados.id>`, `beneficio:<planos_administrativos.id>`,
-- `beneficio_encerrado:<planos_administrativos.id>`, `reembolso:<id do lote>`.
-- Webhook repetido, retry, conciliação ou dois processos ao mesmo tempo
-- batem no UNIQUE e não somam nada.
--
-- `inicio`/`fim`: o período em que o lote deveria ser entregue — é dele que
-- sai o ritmo (quanto já devia ter passado) e o desconto do tempo em que a
-- campanha esteve indisponível por responsabilidade do cliente.
CREATE TABLE IF NOT EXISTS obrigacoes_veiculacao (
  id bigserial PRIMARY KEY,
  anunciante_id integer NOT NULL REFERENCES anunciantes(id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('ciclo', 'troca', 'beneficio', 'beneficio_encerrado', 'reembolso')),
  chave text NOT NULL UNIQUE,
  segundos bigint NOT NULL,
  plano_id text REFERENCES planos(id),
  ciclo_contratado_id integer REFERENCES ciclos_contratados(id) ON DELETE SET NULL,
  plano_administrativo_id integer REFERENCES planos_administrativos(id) ON DELETE SET NULL,
  referencia_id bigint REFERENCES obrigacoes_veiculacao(id),
  inicio timestamptz NOT NULL,
  fim timestamptz NOT NULL,
  motivo text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (fim >= inicio),
  -- Sinal coerente com o tipo: o que cria obrigação é positivo; o que tira,
  -- negativo. A troca pode ser dos dois (subida ou rebaixamento).
  CHECK (
    (tipo IN ('ciclo', 'beneficio') AND segundos >= 0)
    OR (tipo IN ('beneficio_encerrado', 'reembolso') AND segundos <= 0)
    OR tipo = 'troca'
  ),
  CHECK (tipo <> 'reembolso' OR referencia_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_obrigacoes_veiculacao_conta ON obrigacoes_veiculacao (anunciante_id, criado_em, id);
ALTER TABLE obrigacoes_veiculacao ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Campanha indisponível por responsabilidade do cliente
-- ---------------------------------------------------------------------------
-- Regra do dono (spec de consolidação, A.3/A.4 e R3 §20): tempo em que a
-- Mostraí não tinha o que veicular por culpa do CLIENTE não vira dívida —
-- nenhum criativo aprovado/disponível, ou todos pausados/retirados por ele. A
-- assinatura continua correndo e esse tempo se perde. Retirada pela Mostraí
-- (admin) NÃO entra aqui: a dívida continua dela.
--
-- Janelas [inicio, fim) por conta; `fim` NULL = ainda indisponível. No
-- máximo UMA aberta por conta (índice parcial): duas instâncias avaliando ao
-- mesmo tempo não abrem duas. A dívida de cada lote é reduzida na proporção
-- do tempo dele coberto por estas janelas.
CREATE TABLE IF NOT EXISTS indisponibilidade_cliente (
  id bigserial PRIMARY KEY,
  anunciante_id integer NOT NULL REFERENCES anunciantes(id) ON DELETE CASCADE,
  inicio timestamptz NOT NULL,
  fim timestamptz,
  motivo text NOT NULL CHECK (motivo IN ('sem_criativo_disponivel', 'pausado_pelo_cliente')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (fim IS NULL OR fim >= inicio)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_indisponibilidade_cliente_aberta
  ON indisponibilidade_cliente (anunciante_id) WHERE fim IS NULL;
CREATE INDEX IF NOT EXISTS idx_indisponibilidade_cliente_conta ON indisponibilidade_cliente (anunciante_id, inicio);
ALTER TABLE indisponibilidade_cliente ENABLE ROW LEVEL SECURITY;
