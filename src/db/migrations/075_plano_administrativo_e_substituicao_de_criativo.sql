-- Reconstrução de Contas (23/09/2026, pedido do dono). Duas coisas aditivas.
--
-- 1. HISTÓRICO DE PLANO ADMINISTRATIVO (Partes 12-17).
--
-- Plano concedido pelo admin é BENEFÍCIO/CORTESIA — não passa pelo San
-- Checkout, não gera cobrança, fatura nem receita (continua fora do MRR por
-- `plano_cortesia`, ver src/admin/routes.js). O estado VIGENTE continua na
-- própria conta (`anunciantes.plano_id` + `plano_cortesia` +
-- `data_expiracao`), porque é o que playlist, conciliação e painel já leem —
-- esta tabela não muda regra nenhuma, só guarda o que foi concedido, quando,
-- até quando, por quem e como terminou. Antes, liberar cortesia sobrescrevia
-- a conta e o passado sumia.
--
-- `encerrado_motivo`: 'substituido' (outro benefício entrou no lugar),
-- 'cancelado' (o admin encerrou pela ficha). Linha sem `encerrado_em` e que
-- ainda bate com a conta é o benefício em vigor.
CREATE TABLE planos_administrativos (
  id serial PRIMARY KEY,
  anunciante_id int NOT NULL REFERENCES anunciantes(id),
  plano_id text NOT NULL REFERENCES planos(id),
  inicio timestamptz NOT NULL DEFAULT now(),
  -- `date`, igual a anunciantes.data_expiracao (que é o que de fato vale).
  valido_ate date NOT NULL,
  observacao text,
  -- Usuário do admin que concedeu (o login do admin é um só, por env — fica
  -- o que a sessão souber; nulo se ela não souber).
  concedido_por text,
  -- Plano que estava na conta no instante da concessão e de onde vinha
  -- ('assinatura', 'cortesia', 'comodato' ou NULL = nenhum) — é o "antes"
  -- da troca, que o histórico precisa pra fazer sentido depois.
  plano_anterior_id text,
  plano_anterior_origem text,
  encerrado_em timestamptz,
  encerrado_por text,
  encerrado_motivo text CHECK (encerrado_motivo IS NULL OR encerrado_motivo IN ('substituido', 'cancelado')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX planos_administrativos_anunciante_idx ON planos_administrativos (anunciante_id, created_at DESC);

-- 2. CRIATIVO: RETIRAR DO AR E SUBSTITUIR SEM TIRAR O ATUAL (Partes 18-24).
--
-- 'retirado' = aprovado que o admin tirou do ar à mão (ou que saiu porque o
-- substituto dele foi aprovado). Continua cadastrado — conta no limite de 3
-- e pode voltar pro ar —, só não entra na playlist: o gerador só pega
-- `status = 'aprovado'` (src/playlist/gerador.js), então nenhuma leitura
-- existente precisa mudar pra respeitar isso.
--
-- A CHECK original (migration 003) é inline e sem nome, e o Postgres a
-- batizou `criativos_status_check`. Troca por uma que ACEITA MAIS um valor:
-- nenhuma linha existente deixa de passar, nada é apagado.
ALTER TABLE criativos DROP CONSTRAINT criativos_status_check;
ALTER TABLE criativos ADD CONSTRAINT criativos_status_check
  CHECK (status IN ('pendente', 'aprovado', 'reprovado', 'retirado'));

-- B aponta pra A enquanto está em análise: A segue no ar; quando B é
-- aprovado, A vira 'retirado' na mesma operação (src/admin/routes.js). Se B
-- for recusado, A nem percebe. ON DELETE SET NULL: excluir A não pode
-- arrastar B junto.
ALTER TABLE criativos ADD COLUMN substitui_criativo_id int REFERENCES criativos(id) ON DELETE SET NULL;
