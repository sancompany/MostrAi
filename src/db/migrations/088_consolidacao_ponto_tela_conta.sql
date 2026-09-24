-- Consolidação final (24/09/2026) — três regras canônicas que o banco ainda
-- não sustentava. Tudo aditivo e idempotente; nada é apagado.
--
-- 1. STATUS DO PONTO ganha `aguardando_primeiro_sinal`: tela ativa com
--    Player provisionado (chave_hash) que ainda não deu o primeiro sinal.
--    Antes esse caso era lido como `a_instalar` — o mesmo rótulo de "ponto
--    sem tela nenhuma", e o dono não distinguia "falta instalar" de "está
--    instalada, só não ligou ainda". Derivação única continua em
--    src/pontos/repository.js#sincronizarStatusPonto; aqui só o CHECK e o
--    backfill pela mesma regra.
ALTER TABLE pontos DROP CONSTRAINT IF EXISTS pontos_status_check;
ALTER TABLE pontos ADD CONSTRAINT pontos_status_check
  CHECK (status IN ('a_instalar', 'aguardando_primeiro_sinal', 'em_operacao', 'em_reparo', 'inativo', 'arquivado'));

UPDATE pontos p SET status = 'aguardando_primeiro_sinal'
 WHERE p.status = 'a_instalar'
   AND EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = p.id AND d.status = 'ativo' AND d.chave_hash IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = p.id AND d.status = 'ativo'
                      AND d.chave_hash IS NOT NULL AND d.primeiro_sinal_em IS NOT NULL);

-- 2. NÚMERO DA TELA = menor número positivo livre dentro do ponto (regra
--    canônica: excluir a Tela 2 de [1,2,3] e criar outra → Tela 2). O
--    contador crescente `pontos.telas_numeradas` (migration 083) deixa de
--    ser lido; a coluna fica só até uma migration de limpeza. A trava de
--    linha em `pontos` continua serializando duas criações no mesmo ponto,
--    e o índice único (ponto_id, numero) é a última linha de defesa.
CREATE OR REPLACE FUNCTION tela_numero_estavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM pontos WHERE id = NEW.ponto_id FOR UPDATE;
  IF NEW.numero IS NULL THEN
    SELECT MIN(n) INTO NEW.numero
      FROM generate_series(1, (SELECT COUNT(*) + 1 FROM dispositivos WHERE ponto_id = NEW.ponto_id)::int) AS n
     WHERE NOT EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = NEW.ponto_id AND d.numero = n);
  END IF;
  RETURN NEW;
END $$;

-- 3. E-MAIL DA CONTA sem distinção de maiúsculas: login, cadastro e
--    redefinição normalizam (lower/trim) no código a partir desta versão; o
--    índice fecha a porta no banco. Guardado: se já houver duas contas que só
--    diferem em caixa, o índice não é criado (fica registrado no log da
--    migration) e o código continua funcionando — corrigir os dados à mão e
--    reaplicar.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM anunciantes GROUP BY lower(trim(contato_email)) HAVING COUNT(*) > 1) THEN
    RAISE NOTICE 'anunciantes_email_lower_uk NÃO criado: há e-mails duplicados por caixa';
  ELSE
    UPDATE anunciantes SET contato_email = lower(trim(contato_email)) WHERE contato_email <> lower(trim(contato_email));
    CREATE UNIQUE INDEX IF NOT EXISTS anunciantes_email_lower_uk ON anunciantes (lower(trim(contato_email)));
  END IF;
END $$;

-- 4. ANONIMIZAÇÃO da conta excluída há mais de 60 dias (LGPD): o job diário
--    (scripts/conciliar.js → src/titular/repository.js#anonimizarExcluidas)
--    apaga contato, endereço, responsável e senha e libera o e-mail para um
--    cadastro novo. Nome e documento ficam (obrigação fiscal das cobranças).
ALTER TABLE anunciantes ADD COLUMN IF NOT EXISTS anonimizada_em timestamptz;
