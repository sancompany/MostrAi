-- TICK — Campanhas, decisões do dono sobre P2 e P5 (16/11/2026).
--
-- P2: "Registre no histórico qual campanha venceu e qual deixou de conceder
-- o benefício." Entre promoção de preço e brinde de primeiros N isso já fica
-- em campanha_posicoes (resultado 'nao_acumulavel' + vencedora_id). Entre
-- DUAS promoções de preço, a perdedora não deixava rastro: esta tabela grava,
-- por item do pedido, a promoção que valeu e cada outra que alcançava o mesmo
-- lote, tinha quantidade e ficou de fora (preço maior ou empate perdido).
-- Só acréscimo (imutável), como o resto do histórico das campanhas.
--
-- P5: o pedido "pago sem vaga" ganha o MOTIVO, gravado na confirmação do
-- pagamento: lote fechado ou sem vaga, capacidade da edição, promoção
-- encerrada ou promoção sem quantidade (e qual). É a base da fila de
-- exceções do Admin. Pedidos "pago sem vaga" de antes ficam sem linha aqui
-- (a fila mostra "motivo não registrado"). Também imutável.
--
-- Nada existente muda; nenhuma tabela ou coluna sai.
--
-- Reversão (só antes de existir dado):
--   DROP TABLE pedidos_sem_vaga;
--   DROP TABLE campanha_disputas;

CREATE TABLE campanha_disputas (
  id bigserial PRIMARY KEY,
  pedido_item_id bigint NOT NULL REFERENCES pedido_itens(id),
  vencedora_id bigint NOT NULL REFERENCES campanhas(id),
  preterida_id bigint NOT NULL REFERENCES campanhas(id),
  preco_vencedora_centavos bigint NOT NULL CHECK (preco_vencedora_centavos >= 0),
  preco_preterida_centavos bigint NOT NULL CHECK (preco_preterida_centavos >= preco_vencedora_centavos),
  registrado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (vencedora_id <> preterida_id),
  UNIQUE (pedido_item_id, preterida_id)
);
CREATE INDEX ix_campanha_disputas_vencedora ON campanha_disputas (vencedora_id);
CREATE INDEX ix_campanha_disputas_preterida ON campanha_disputas (preterida_id);
CREATE TRIGGER campanha_disputas_imutavel BEFORE UPDATE OR DELETE ON campanha_disputas
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

CREATE TABLE pedidos_sem_vaga (
  pedido_id uuid PRIMARY KEY REFERENCES pedidos(id),
  motivo text NOT NULL
    CHECK (motivo IN ('lote', 'capacidade', 'promocao_encerrada', 'promocao_sem_quantidade')),
  campanha_id bigint REFERENCES campanhas(id),
  detalhe text CHECK (char_length(detalhe) <= 300),
  registrado_em timestamptz NOT NULL DEFAULT now(),
  CHECK ((motivo LIKE 'promocao_%') = (campanha_id IS NOT NULL))
);
CREATE TRIGGER pedidos_sem_vaga_imutavel BEFORE UPDATE OR DELETE ON pedidos_sem_vaga
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();
