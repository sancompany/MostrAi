-- Inbox durável do webhook do San Checkout (26/09/2026).
--
-- Antes: POST /webhook/san-checkout respondia 200 e SÓ DEPOIS processava em
-- memória. Falha no processamento (banco fora, instância reiniciando num
-- deploy) virava só log, e o Checkout — que já tinha recebido 200 — não
-- reenviava. A conciliação diária recupera ciclo pago, falha de cobrança e
-- cancelamento, mas não recupera chargeback (`cobranca_contestada`),
-- estorno (`cobranca_estornada`) nem `troca_revertida`.
--
-- Agora a rota grava o evento AQUI e só então responde 200; um processador
-- (src/financeiro/webhook-inbox.js) lê esta tabela, roda a mesma lógica de
-- antes (processarWebhookAssinatura / processarWebhookPedido) e marca o
-- resultado. É a porta de ENTRADA de eventos externos — não é a fila de
-- e-mails (essa, quando existir, é outra tabela).
--
-- `chave`: identidade do EVENTO, não da entrega. `eventoId` do contrato v2
-- quando vem; sem ele, SHA-256 do corpo cru (a reentrega do mesmo evento
-- traz o mesmo corpo — a assinatura e o timestamp vão nos headers). Mesma
-- entrega duas vezes = uma linha, um processamento.
--
-- `payload` tem dado pessoal (CPF/CNPJ do pagador em `documento`, que a
-- lógica usa pra consultar o Checkout): fica só enquanto serve — ver a
-- retenção em webhook-inbox.js (processado: 30 dias; morto: 90 dias).
CREATE TABLE webhooks_recebidos (
  id bigserial PRIMARY KEY,
  chave text NOT NULL UNIQUE,
  tipo text NOT NULL CHECK (tipo IN ('assinatura', 'pedido')),
  evento text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'recebido'
    CHECK (status IN ('recebido', 'processando', 'processado', 'tentando_de_novo', 'morto')),
  tentativas integer NOT NULL DEFAULT 0,
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  processando_desde timestamptz,
  ultimo_erro text,
  recebido_em timestamptz NOT NULL DEFAULT now(),
  processado_em timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- O que o processador procura: pendente e já na hora, ou "processando" há
-- tempo demais (a instância que pegou morreu no meio).
CREATE INDEX webhooks_recebidos_fila ON webhooks_recebidos (proxima_tentativa_em)
  WHERE status IN ('recebido', 'tentando_de_novo', 'processando');
CREATE INDEX webhooks_recebidos_status ON webhooks_recebidos (status, recebido_em);

-- Mesma regra das outras tabelas (migration 091): RLS ligado, sem política —
-- só o dono do banco (o backend) lê e escreve.
ALTER TABLE webhooks_recebidos ENABLE ROW LEVEL SECURITY;
