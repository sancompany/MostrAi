-- A rede passa a ser vendida por PONTO e por TEMPO (decisão do dono,
-- 17/09/2026, desenho inteiro em docs/economia-da-rede.md seções 6 a 9).
--
-- Duas mudanças de conceito, e cada uma conserta um furo medido:
--
-- 1. TEMPO no lugar de REPETIÇÃO. `frequencia_hora` dizia "N vezes por hora"
--    e multiplicava com a duração da peça: um plano de 12x com peça de 30s
--    consumia 40x o que um de 3x com peça de 10s consumia, e custava 4x
--    (seção 7). Vendendo SEGUNDOS, a duração da peça sai da conta de
--    inventário — 6 inserções de 15s e 3 de 30s ocupam o mesmo lugar.
--
-- 2. PONTOS no lugar de "toda a rede". Até aqui todo plano era
--    `todos_pontos` e todo anunciante rodava em toda tela, então instalar
--    uma tela nova aumentava o custo e abria ZERO vaga (seção 2). Com o
--    plano dando acesso a N pontos, cada ponto instalado abre vaga de
--    verdade, e a rede deixa de ter teto de receita.
--
-- ADITIVA. Nada é apagado aqui — as remoções autorizadas pelo dono (preço
-- travado, bônus de tela) vão na 046, própria delas.

-- Quantos segundos da hora aquele plano compra, EM CADA PONTO que ele cobre.
-- Fica nulo até a 047 publicar a grade nova; enquanto for nulo, o gerador
-- cai no cálculo antigo (frequencia_hora x duração), então nada muda de
-- comportamento entre esta migration e a publicação.
ALTER TABLE planos ADD COLUMN segundos_por_hora int CHECK (segundos_por_hora > 0);

-- Teto de duração da peça, por plano. Nulo = sem teto próprio, vale só o
-- limite global de 3 a 60s que já existe em src/anunciantes/routes.js.
ALTER TABLE planos ADD COLUMN duracao_maxima_segundos int
  CHECK (duracao_maxima_segundos IS NULL OR duracao_maxima_segundos BETWEEN 5 AND 60);

-- Em quantos pontos o plano coloca o anunciante. Nulo = todos os pontos, que
-- é exatamente o comportamento de hoje — por isso os planos existentes não
-- mudam nada até alguém preencher.
ALTER TABLE planos ADD COLUMN pontos_incluidos int CHECK (pontos_incluidos > 0);

-- Os pontos que o ANUNCIANTE escolheu. Linha nenhuma = ele não escolheu, e
-- o sistema escolhe por ele entre os pontos com espaço (decisão do dono:
-- "se não escolherem nenhum ponto roda aleatoriamente nos livres").
--
-- Sem `ON DELETE CASCADE` no ponto de propósito: apagar um ponto que tem
-- anunciante escolhido tem que doer, pra ninguém sumir com a escolha de
-- alguém sem perceber. Ponto sai de operação mudando o status, não apagando.
CREATE TABLE anunciantes_pontos (
  anunciante_id int NOT NULL REFERENCES anunciantes(id) ON DELETE CASCADE,
  ponto_id int NOT NULL REFERENCES pontos(id),
  escolhido_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (anunciante_id, ponto_id)
);
CREATE INDEX idx_anunciantes_pontos_ponto ON anunciantes_pontos (ponto_id);

-- Status do ponto vira dois: a instalar e em operação (decisão do dono,
-- 17/09/2026). Os cinco de antes misturavam duas perguntas diferentes —
-- "o ponto existe na rede?" e "a tela está funcionando?". A segunda tem
-- resposta própria em `dispositivos.status` (ativo/reparo/inativo), que
-- continua igual; aqui fica só a primeira.
--
-- `inativo` vira `a_instalar` e não `em_operacao`: ponto desligado não pode
-- voltar pra rede por causa de uma migration. É o mapeamento menos errado
-- dos dois — e hoje a tabela está vazia em produção, então não mexe em dado
-- de ninguém.
ALTER TABLE pontos DROP CONSTRAINT IF EXISTS pontos_status_check;
UPDATE pontos SET status = 'em_operacao' WHERE status IN ('ativo', 'reparo');
UPDATE pontos SET status = 'a_instalar' WHERE status IN ('lead', 'aguardando_instalacao', 'inativo');
ALTER TABLE pontos ADD CONSTRAINT pontos_status_check
  CHECK (status IN ('a_instalar', 'em_operacao'));
ALTER TABLE pontos ALTER COLUMN status SET DEFAULT 'a_instalar';
