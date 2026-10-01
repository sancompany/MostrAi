-- Estação de endereços (01/10/2026). Só ADICIONA: nenhuma coluna existente
-- muda, nenhum dado antigo é reescrito.

-- Histórico do endereço físico do ponto. Uma linha por troca, nunca apagada
-- (ponto_id sem cascata: ponto não é apagado de verdade, é arquivado —
-- migration 080 — e o histórico segura o registro se alguém tentar).
-- `anterior`/`novo` guardam as partes (cep, logradouro, número, complemento,
-- bairro, cidade, UF) e a linha composta, como estavam e como ficaram.
CREATE TABLE pontos_enderecos_historico (
  id bigserial PRIMARY KEY,
  ponto_id integer NOT NULL REFERENCES pontos(id),
  anterior jsonb NOT NULL,
  novo jsonb NOT NULL,
  origem text NOT NULL CHECK (origem IN ('usuario', 'admin')),
  -- Quem alterou: a conta (origem usuario) ou o usuário do admin. Sem chave
  -- estrangeira de propósito — a conta pode ser anonimizada depois e o
  -- histórico continua dizendo quem foi.
  alterado_por_conta integer,
  alterado_por_admin text,
  -- Status do ponto no momento da troca (prova de "alterado depois da
  -- instalação" sem depender do status de hoje).
  status_do_ponto text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (origem <> 'usuario' OR alterado_por_conta IS NOT NULL)
);
CREATE INDEX idx_pontos_enderecos_historico_ponto ON pontos_enderecos_historico (ponto_id, criado_em DESC);
-- Mesma regra de toda tabela do projeto (tests/rls.test.js): só o servidor
-- lê e grava, nunca a chave pública do Supabase.
ALTER TABLE pontos_enderecos_historico ENABLE ROW LEVEL SECURITY;

-- Pendências da conta e da operação (infraestrutura genérica; hoje só os
-- tipos de endereço — catálogo em src/pendencias/repository.js). Uma
-- pendência ativa por `chave` (tipo + alvo), então reavaliar não duplica e
-- não gera aviso de novo. Resolvida não é apagada: fica com quando, por quê
-- e por quem.
CREATE TABLE pendencias (
  id bigserial PRIMARY KEY,
  tipo text NOT NULL,
  severidade text NOT NULL CHECK (severidade IN ('informativa', 'atencao', 'bloqueante')),
  -- 'conta': o cliente vê e corrige no painel. 'admin': só a operação vê.
  escopo text NOT NULL CHECK (escopo IN ('conta', 'admin')),
  chave text NOT NULL,
  anunciante_id integer REFERENCES anunciantes(id) ON DELETE CASCADE,
  ponto_id integer REFERENCES pontos(id) ON DELETE CASCADE,
  candidatura_id integer REFERENCES candidaturas(id) ON DELETE CASCADE,
  titulo text NOT NULL,
  mensagem text NOT NULL,
  cta_rotulo text,
  cta_destino text,
  -- Valor que originou a pendência (ex.: o Número suspeito). Quando o
  -- cliente confirma que está certo, a resolução guarda esta impressão e o
  -- mesmo valor não reabre a pendência.
  impressao text,
  dados jsonb,
  criado_em timestamptz NOT NULL DEFAULT now(),
  resolvido_em timestamptz,
  resolucao text CHECK (resolucao IS NULL OR resolucao IN ('corrigido', 'confirmado', 'conferido', 'encerrada')),
  resolvido_por text,
  CHECK ((resolvido_em IS NULL) = (resolucao IS NULL))
);
CREATE UNIQUE INDEX uq_pendencias_ativa_por_chave ON pendencias (chave) WHERE resolvido_em IS NULL;
CREATE INDEX idx_pendencias_conta_ativas ON pendencias (anunciante_id) WHERE resolvido_em IS NULL;
CREATE INDEX idx_pendencias_escopo_ativas ON pendencias (escopo, criado_em DESC) WHERE resolvido_em IS NULL;
CREATE INDEX idx_pendencias_chave ON pendencias (chave, resolvido_em DESC);
ALTER TABLE pendencias ENABLE ROW LEVEL SECURITY;
