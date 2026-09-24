-- Endereço em campos separados em todo o sistema (D5, rodada de 24/09/2026,
-- decisão do dono): CEP, logradouro, número, complemento, bairro, cidade e
-- UF — nunca mais "Rua e bairro" num campo só.
--
-- ANTES: a migration 070 separou bairro/complemento só em `pontos` e
-- `candidaturas`; o número continuava colado na rua ("Rua X, 123") e a conta
-- (`anunciantes`) guardava tudo em `endereco`. O cadastro público e o convite
-- ainda perguntavam "Rua e bairro" — e o CEP preenchia só a rua nesse campo,
-- então quem digitava o bairro junto gravava "Avenida 28 de Agosto, Alto,
-- 2502".
--
-- AGORA: `logradouro` e `numero` nas três tabelas, `bairro` e `complemento`
-- também na conta. `endereco` CONTINUA existindo e passa a ser a linha
-- "logradouro, número" composta pelo servidor (src/lib/endereco.js) — é o que
-- a busca de ponto duplicado (src/pontos/repository.js, migration 080), a
-- lista pública de pontos e o link do mapa já leem; nada disso quebra.
--
-- Os registros antigos são separados aqui só no formato que o próprio
-- sistema gravava, e só até onde ele é inequívoco:
--   · termina em ", <número>" (ou ", S/N") → esse é o número, o resto é a rua;
--   · o resto ainda tem uma vírgula, o bairro está vazio e o último pedaço
--     tem letra → é o formato do `ligarCep` antigo (`${logradouro},
--     ${bairro}`, ver migration 070): o último pedaço é o bairro;
--   · o resto termina com o bairro já gravado → tira a repetição.
-- Qualquer outra coisa fica inteira em `logradouro`, com número vazio — o
-- formulário pede o número na próxima edição, nada é adivinhado.
-- Produção em 24/09/2026: 2 contas, 3 pontos e 2 candidaturas com endereço,
-- todos no formato acima (CEP 15997-078, Avenida 28 de Agosto, bairro Alto).
ALTER TABLE anunciantes
  ADD COLUMN logradouro text,
  ADD COLUMN numero text,
  ADD COLUMN complemento text,
  ADD COLUMN bairro text;
ALTER TABLE pontos
  ADD COLUMN logradouro text,
  ADD COLUMN numero text;
ALTER TABLE candidaturas
  ADD COLUMN logradouro text,
  ADD COLUMN numero text;

-- Uma função temporária pra não repetir a mesma regra três vezes; some no fim.
CREATE FUNCTION pg_temp.separar_endereco(endereco text, bairro text)
RETURNS TABLE (logradouro text, numero text, bairro_novo text)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  num text := substring(endereco from ',\s*([0-9]+[0-9A-Za-z/-]*|[Ss]/?[Nn])\s*$');
  resto text := btrim(substring(endereco from '^(.*\S)\s*,\s*(?:[0-9]+[0-9A-Za-z/-]*|[Ss]/?[Nn])\s*$'));
BEGIN
  IF endereco IS NULL OR btrim(endereco) = '' THEN
    RETURN QUERY SELECT NULL::text, NULL::text, bairro;
  ELSIF num IS NULL OR resto IS NULL OR resto = '' THEN
    RETURN QUERY SELECT btrim(endereco), NULL::text, bairro;
  ELSIF bairro IS NOT NULL AND btrim(bairro) <> ''
        AND lower(resto) LIKE '%, ' || lower(btrim(bairro)) THEN
    RETURN QUERY SELECT btrim(left(resto, length(resto) - length(btrim(bairro)) - 2)), num, bairro;
  ELSIF (bairro IS NULL OR btrim(bairro) = '') AND resto LIKE '%,%'
        AND substring(resto from ',\s*([^,]*)$') ~ '[[:alpha:]]' THEN
    RETURN QUERY SELECT btrim(regexp_replace(resto, '\s*,\s*[^,]*$', '')),
                        num,
                        btrim(substring(resto from ',\s*([^,]*)$'));
  ELSE
    RETURN QUERY SELECT resto, num, bairro;
  END IF;
END $$;

UPDATE anunciantes t
   SET (logradouro, numero, bairro) =
       (SELECT s.logradouro, s.numero, s.bairro_novo FROM pg_temp.separar_endereco(t.endereco, NULL) AS s)
 WHERE t.endereco IS NOT NULL AND btrim(t.endereco) <> '';
UPDATE anunciantes SET endereco = logradouro || ', ' || numero WHERE logradouro IS NOT NULL AND numero IS NOT NULL;

UPDATE pontos t
   SET (logradouro, numero, bairro) =
       (SELECT s.logradouro, s.numero, s.bairro_novo FROM pg_temp.separar_endereco(t.endereco, t.bairro) AS s)
 WHERE t.endereco IS NOT NULL AND btrim(t.endereco) <> '';
UPDATE pontos SET endereco = logradouro || ', ' || numero WHERE logradouro IS NOT NULL AND numero IS NOT NULL;

UPDATE candidaturas t
   SET (logradouro, numero, bairro) =
       (SELECT s.logradouro, s.numero, s.bairro_novo FROM pg_temp.separar_endereco(t.endereco, t.bairro) AS s)
 WHERE t.endereco IS NOT NULL AND btrim(t.endereco) <> '';
UPDATE candidaturas SET endereco = logradouro || ', ' || numero WHERE logradouro IS NOT NULL AND numero IS NOT NULL;

DROP FUNCTION pg_temp.separar_endereco(text, text);
