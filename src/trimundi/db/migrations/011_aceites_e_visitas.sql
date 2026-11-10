-- TICK — histórico de aceite e visitas pelo link de indicação (pedido do dono,
-- 10/11/2026).
--
-- 1. HISTÓRICO DE ACEITE. Até aqui a conta guardava só o aceite mais recente
--    (clientes.termos_versao, termos_aceitos_em, aceite_ip...): aceitar uma
--    versão nova sobrescrevia a anterior. Agora cada aceite vira uma linha que
--    não muda nem se apaga — a versão, o hash dos documentos apresentados
--    naquela versão, a declaração de maioridade, IP, navegador e a hora. As
--    colunas da conta seguem como "o aceite vigente" (o que a compra confere).
--    Os aceites que já existiam entram aqui como 'anterior', com o que a conta
--    tinha (sem o hash, que não era guardado).
CREATE TABLE aceites_conta (
  id bigserial PRIMARY KEY,
  cliente_id bigint NOT NULL REFERENCES clientes(id),
  versao text NOT NULL CHECK (char_length(versao) BETWEEN 1 AND 20),
  documentos_hash text CHECK (documentos_hash ~ '^[0-9a-f]{64}$'),
  origem text NOT NULL CHECK (origem IN ('cadastro', 'reaceite', 'anterior')),
  maioridade_declarada boolean NOT NULL,
  ip text CHECK (char_length(ip) <= 64),
  user_agent text CHECK (char_length(user_agent) <= 300),
  aceito_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_aceites_conta ON aceites_conta (cliente_id, aceito_em DESC);
CREATE TRIGGER aceites_conta_imutavel BEFORE UPDATE OR DELETE ON aceites_conta
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();
ALTER TABLE aceites_conta ENABLE ROW LEVEL SECURITY;

INSERT INTO aceites_conta (cliente_id, versao, origem, maioridade_declarada, ip, user_agent, aceito_em)
SELECT id, termos_versao, 'anterior', maioridade_declarada_em IS NOT NULL, aceite_ip, aceite_user_agent, termos_aceitos_em
  FROM clientes
 WHERE termos_aceitos_em IS NOT NULL AND termos_versao IS NOT NULL;

-- 2. VISITAS PELO LINK DE INDICAÇÃO ("Indique e acompanhe" em Minha conta).
--    Um visitante é um navegador: um id aleatório gerado nele, guardado aqui
--    só como hash. Sem IP, sem nome, sem e-mail. A mesma pessoa voltando pelo
--    mesmo link no mesmo navegador não conta de novo (chave primária). Quando
--    esse navegador entra numa conta, a linha ganha o cliente_id: é assim que
--    "criou conta pela indicação" é contado. Visita não é indicação nem
--    conversão — essas continuam em indicacao_origens e nos pedidos pagos.
CREATE TABLE indicacao_visitas (
  indicador_id bigint NOT NULL REFERENCES indicadores(id),
  visitante text NOT NULL CHECK (visitante ~ '^[0-9a-f]{64}$'),
  edicao_id bigint REFERENCES edicoes(id),
  cliente_id bigint REFERENCES clientes(id),
  primeira_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (indicador_id, visitante)
);
CREATE INDEX ix_indicacao_visitas_cliente ON indicacao_visitas (cliente_id) WHERE cliente_id IS NOT NULL;
ALTER TABLE indicacao_visitas ENABLE ROW LEVEL SECURITY;
