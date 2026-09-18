-- Banco de horas (G.3 de docs/PENDENCIAS.md) — proposta do dono: "criamos
-- um banco de horas mensal para anúncios que não couberam; eles ganham
-- prioridade no próximo mês e abatem as horas". Uma linha por mês em que
-- um anunciante teve déficit (apurado por scripts/apurar-banco-horas.js,
-- rodando junto da conciliação diária) — não uma linha de saldo único,
-- porque a válvula de expiração (N meses sem drenar) precisa saber a
-- IDADE de cada pedaço da dívida, e um saldo único perderia isso.
--
-- Unidade: EXIBIÇÕES (vezes), a mesma do resto do motor de pacing
-- (`exibicoes_contador`, `src/lib/pacing.js`'s `deficit`), não segundos.
-- A duração de um criativo não é guardada por exibição — só existe a de
-- HOJE (`criativos.duracao_segundos`) — então segundos históricos seriam
-- estimativa em cima de estimativa. Exibição é a unidade que o motor já
-- soma e já dá prioridade de hora em hora; o banco só estende esse mesmo
-- número pro mês.
--
-- Saldo restante de uma linha = exibicoes_banco - exibicoes_drenadas.
-- Saldo total de um anunciante = soma disso em toda linha 'ativa'.
CREATE TABLE banco_horas (
  id serial PRIMARY KEY,
  anunciante_id int NOT NULL REFERENCES anunciantes(id),
  mes_referencia date NOT NULL, -- primeiro dia do mês em que faltou entregar
  exibicoes_pedidas int NOT NULL,
  exibicoes_entregues int NOT NULL,
  exibicoes_banco int NOT NULL CHECK (exibicoes_banco >= 0),
  exibicoes_drenadas int NOT NULL DEFAULT 0 CHECK (exibicoes_drenadas >= 0 AND exibicoes_drenadas <= exibicoes_banco),
  -- 'ativo': ainda tem saldo, pode drenar. 'drenado': saldo zerado, entregue
  -- de volta por inteiro. 'aguardando_credito': passou de N meses sem
  -- drenar tudo — fila do admin decidir (nunca crédito automático em
  -- dinheiro, ver RUNBOOK.md sobre mudança no caminho de dinheiro).
  status text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'drenado', 'aguardando_credito')),
  -- Preenchido quando o admin decide o que fazer com uma linha
  -- 'aguardando_credito' (crédito manual, desconto na próxima fatura,
  -- ou decidir não fazer nada). O `status` continua 'aguardando_credito'
  -- pra registro — é este campo que tira a linha da fila de pendências.
  resolvido_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (anunciante_id, mes_referencia)
);

-- A consulta mais comum, em toda hora de toda tela: "este anunciante tem
-- saldo pra usar agora?" — só olha linhas 'ativo', da mais antiga pra mais
-- nova (FIFO: quem espera mais tempo drena primeiro).
CREATE INDEX idx_banco_horas_ativo ON banco_horas (anunciante_id, mes_referencia) WHERE status = 'ativo';
