-- Mídia Mostraí (reorganização de Conteúdo, 22/09/2026, pedido do dono):
-- cada peça institucional da rede vira uma entidade própria, com
-- frequência, cobertura e período independentes — não mais um valor só
-- por conta (anunciantes.frequencia_hora_propria, que fica como legado,
-- sem uso novo a partir desta migration). O arquivo, o preview e o status
-- de aprovação continuam morando em `criativos` (relação 1-pra-1 com esta
-- tabela via criativo_id): substituir o arquivo edita a MESMA linha de
-- criativos, nunca cria outra (Parte 27 do pedido).
CREATE TABLE midias_proprias (
  id serial PRIMARY KEY,
  criativo_id int NOT NULL UNIQUE REFERENCES criativos(id),
  nome_interno text NOT NULL,
  frequencia_hora int NOT NULL CHECK (frequencia_hora > 0),
  cobertura_tipo text NOT NULL CHECK (cobertura_tipo IN ('rede', 'pontos')),
  periodo_inicio timestamptz,
  periodo_fim timestamptz,
  -- "Agendada" e "Encerrada por período" são derivadas de periodo_inicio/
  -- periodo_fim na leitura, não guardadas aqui — só o controle manual
  -- (Pausar/Retomar/Retirar do ar, Parte 13) precisa de estado próprio.
  situacao text NOT NULL DEFAULT 'ativa' CHECK (situacao IN ('ativa', 'pausada', 'encerrada')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Cobertura por pontos específicos, sem teto artificial (Parte 8: "sem
-- limite de quantidade de pontos" — diferente da lógica de planos
-- comerciais, que usa pontos_incluidos). Só populada quando
-- cobertura_tipo = 'pontos'; cobertura 'rede' não grava linha nenhuma
-- aqui, e por isso é dinâmica (ponto novo entra sozinho, Parte 8).
CREATE TABLE midias_proprias_pontos (
  midia_id int NOT NULL REFERENCES midias_proprias(id) ON DELETE CASCADE,
  ponto_id int NOT NULL REFERENCES pontos(id) ON DELETE CASCADE,
  PRIMARY KEY (midia_id, ponto_id)
);

CREATE INDEX idx_midias_proprias_pontos_ponto ON midias_proprias_pontos (ponto_id);
