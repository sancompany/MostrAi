-- Direitos do titular: revogação de consentimento e arrependimento com estorno.
--
-- Por quê: a Política de Privacidade promete os direitos do art. 18 da LGPD
-- "por e-mail", e a venda é a consumidor à distância, o que dá 7 dias de
-- arrependimento pelo art. 49 do CDC. Prometido por escrito e sem lugar
-- nenhum no sistema pra exercer é a pior combinação possível: a obrigação
-- existe, o registro de que ela foi cumprida não.
--
-- ADITIVA. Não altera nem apaga nada.

-- Comunicação que NÃO é operacional (novidade, oferta, convite) depende de
-- consentimento, e consentimento se revoga a qualquer tempo (LGPD art. 8 §5).
-- Hoje todo e-mail que o sistema manda é transacional — confirmação de
-- pagamento, redefinição de senha, anúncio no ar — e nenhum é bloqueado por
-- esta coluna. Ela existe pra que a PRIMEIRA mensagem de divulgação já nasça
-- tendo de perguntar, em vez de a trava ser lembrada depois dela sair.
ALTER TABLE anunciantes ADD COLUMN comunicacoes_revogado_em timestamptz;

-- Dado que a pessoa deu por vontade própria e que o serviço não precisa:
-- o contato do responsável e a foto. Esse é o único bloco que dá pra apagar
-- sem encerrar o contrato — o resto (documento, endereço, cobrança) é
-- execução de contrato e obrigação fiscal, e some com a conta, não antes.
ALTER TABLE anunciantes ADD COLUMN dados_opcionais_apagados_em timestamptz;

-- Pedido de arrependimento. Fica em tabela própria, e não numa coluna da
-- conta, por dois motivos: é caminho de dinheiro, que precisa de trilha
-- (quem pediu, quando, quanto, quem devolveu), e o estorno em si acontece
-- FORA daqui — a API do San Checkout não expõe estorno (API.md, seção 6),
-- então quem executa é uma pessoa no painel do Checkout/Asaas. Sem esta
-- tabela, o pedido viraria um e-mail que alguém esquece.
CREATE TABLE arrependimentos (
  id serial PRIMARY KEY,
  anunciante_id integer NOT NULL REFERENCES anunciantes(id),
  assinatura_id text,
  plano_id text NOT NULL,
  -- Valor pago que precisa voltar, em reais. Copiado no momento do pedido:
  -- se o plano mudar de preço depois, o que se devolve é o que se recebeu.
  valor_a_estornar numeric NOT NULL,
  -- Quando o prazo de 7 dias começou a contar: a primeira cobrança
  -- confirmada, que é quando a contratação se completou.
  contratado_em timestamptz NOT NULL,
  pedido_em timestamptz NOT NULL DEFAULT now(),
  -- 'pendente' = pedido aceito, anúncio já fora do ar, dinheiro ainda não
  -- devolvido. 'estornado' = o admin devolveu e registrou.
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'estornado')),
  estornado_em timestamptz,
  -- Identificador do estorno no Checkout/Asaas, digitado pelo admin — é o
  -- que liga o registro daqui ao comprovante de lá.
  comprovante text
);

-- Um pedido aberto por conta. Dois cliques no botão não podem virar dois
-- estornos; o segundo encontra o primeiro.
CREATE UNIQUE INDEX idx_um_arrependimento_aberto
  ON arrependimentos (anunciante_id) WHERE status = 'pendente';
