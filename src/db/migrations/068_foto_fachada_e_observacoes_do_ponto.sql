-- Fecha os dois furos do redesenho da tela Rede do admin (22/09/2026):
-- o pipeline candidatura → ponto (liberarPapelNaConta, src/conta/modos.js)
-- já copiava endereço/cidade/UF/CEP/segmento/responsável/movimento
-- mensal/horário — só faltavam a foto da fachada e a observação livre.
--
-- Mesma forma da migration 066 (horário semanal): o dado nasce na
-- candidatura, ANTES de o ponto existir, e precisa sobreviver até o admin
-- liberar o papel na conta.
ALTER TABLE candidaturas ADD COLUMN foto_fachada_url text;

-- `mensagem` já existe em `candidaturas` (rotulada "Algo mais?" no
-- formulário) e nunca foi copiada pro ponto — não existia coluna pra
-- receber. Nome `observacoes` porque no ponto ela deixa de ser "mensagem
-- pra quem está pedindo" e vira ficha do estabelecimento.
ALTER TABLE pontos ADD COLUMN observacoes text;
