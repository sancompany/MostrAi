-- Rodada final da Rede (22/09/2026) — duas mudanças de modelo:
--
-- 1) STATUS DO PONTO PASSA A SER AUTOMÁTICO, derivado das telas dele
--    (src/pontos/repository.js#sincronizarStatusPonto, chamada de dentro de
--    src/dispositivos/repository.js sempre que uma tela é criada, tem o
--    status trocado, ou é excluída — um só escritor, nunca duas fontes de
--    verdade). Os dois valores antigos (a_instalar/em_operacao, migration
--    045) continuam com o MESMO significado de sempre — playlist, gate do
--    player, disponibilidade pro anunciante e métricas continuam batendo
--    contra eles sem mudar uma linha. `em_reparo`/`inativo` são novos:
--      0 telas               -> a_instalar   (Aguardando instalação)
--      >=1 tela ativa        -> em_operacao  (Ativo)
--      0 ativa, >=1 reparo   -> em_reparo    (Em reparo)
--      0 ativa, 0 reparo     -> inativo      (Inativo)
ALTER TABLE pontos DROP CONSTRAINT IF EXISTS pontos_status_check;
ALTER TABLE pontos ADD CONSTRAINT pontos_status_check
  CHECK (status IN ('a_instalar', 'em_operacao', 'em_reparo', 'inativo'));

-- Backfill: recalcula o status real de todo ponto existente a partir das
-- telas que ele já tem hoje — sem isso, o primeiro deploy ficaria com status
-- antigos (setados à mão) que não batem mais com a regra automática.
UPDATE pontos p SET status = CASE
  WHEN NOT EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = p.id) THEN 'a_instalar'
  WHEN EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = p.id AND d.status = 'ativo') THEN 'em_operacao'
  WHEN EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = p.id AND d.status = 'reparo') THEN 'em_reparo'
  ELSE 'inativo'
END;

-- `dispositivos.status` nascia 'ativo' por padrão (migration 019) — fazia
-- sentido quando o status do PONTO era manual (o admin só marcava
-- em_operacao depois de conferir a instalação de verdade). Com o status
-- automático, uma "Tela 1" recém-criada pela candidatura (sem chave, sem
-- instalação física) deixaria o ponto "Ativo" na hora errada. Novas telas
-- passam a nascer 'inativo'; o admin marca 'ativo' quando confirmar.
ALTER TABLE dispositivos ALTER COLUMN status SET DEFAULT 'inativo';

-- 2) MARGENS DA TELA (safe area do molde ACM) — mesmo contrato que o player
-- web já tinha (public/player.page.js, 1 valor único em vmin, via
-- ?margem=N na URL), só que agora por LADO e persistido por tela em vez de
-- só client-side. Unidade continua vmin (mesma do contrato existente,
-- nunca documentada em outro lugar do projeto) — 0 = sem margem, nunca
-- negativo.
ALTER TABLE dispositivos ADD COLUMN margem_superior numeric NOT NULL DEFAULT 0 CHECK (margem_superior >= 0);
ALTER TABLE dispositivos ADD COLUMN margem_direita numeric NOT NULL DEFAULT 0 CHECK (margem_direita >= 0);
ALTER TABLE dispositivos ADD COLUMN margem_inferior numeric NOT NULL DEFAULT 0 CHECK (margem_inferior >= 0);
ALTER TABLE dispositivos ADD COLUMN margem_esquerda numeric NOT NULL DEFAULT 0 CHECK (margem_esquerda >= 0);
