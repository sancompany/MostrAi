-- 117 — Fecha SV1 e SV3 do hotfix de Saldo de veiculação (docs/PENDENCIAS.md,
-- 07/10/2026). SV2 é só código (src/bancohoras/obrigacao-do-ciclo.js).
--
-- ---------------------------------------------------------------------------
-- SV1 — benefício por CRÉDITOS = cota exata do ciclo resgatado
-- ---------------------------------------------------------------------------
-- O resgate de créditos compra um CICLO do plano (creditos/routes.js escolhe o
-- plano por `compromisso_meses` = meses resgatados), mas o lote nascia
-- proporcional aos dias corridos entre a ativação e o fim do último dia
-- inclusivo: o Essencial mensal da conta real nasceu com 98.295 s (27h18), não
-- 97.200 s (27 h). O código novo grava a cota exata
-- (obrigacao-do-ciclo.js#segundosDoBeneficio); aqui, só os lotes ainda vivos
-- que nasceram pela régua antiga são normalizados, pelo significado dos dados:
--   · tipo 'beneficio' de um plano administrativo com origem 'indicacao'
--     (créditos — cortesia administrativa NÃO entra: a validade dela é
--     escolhida em dias e continua proporcional);
--   · benefício ainda 'ativo' e lote ainda aberto (fim no futuro);
--   · sem encerramento antecipado lançado (o encerramento foi calculado sobre
--     o valor antigo — mexer agora desalinharia os dois);
--   · valor diferente da cota (rodar de novo não muda nada).
-- Cota = horas/mês do plano × meses do ciclo, na mesma fórmula de
-- src/lib/pacing.js#horasDeTelaPorMes: round(s/h × pontos × 12 h × 30 d ÷ 3600) h.
UPDATE obrigacoes_veiculacao o
   SET segundos = c.cota,
       motivo = format('benefício %s (%s %s)', p.nome, p.compromisso_meses,
                       CASE WHEN p.compromisso_meses = 1 THEN 'mês' ELSE 'meses' END)
  FROM planos_administrativos h
  JOIN planos p ON p.id = h.plano_id
  CROSS JOIN LATERAL (
    SELECT round(p.segundos_por_hora::numeric * p.pontos_incluidos * 12 * 30 / 3600)::bigint * 3600
           * GREATEST(COALESCE(p.compromisso_meses, 1), 1) AS cota
  ) c
 WHERE o.tipo = 'beneficio'
   AND o.plano_administrativo_id = h.id
   AND h.origem = 'indicacao'
   AND h.status = 'ativo'
   AND o.fim > now()
   AND NOT EXISTS (SELECT 1 FROM obrigacoes_veiculacao e
                    WHERE e.tipo = 'beneficio_encerrado' AND e.referencia_id = o.id)
   AND o.segundos <> c.cota;

-- ---------------------------------------------------------------------------
-- SV3 — invalidação de playlist GLOBAL, sem escrever em todas as telas
-- ---------------------------------------------------------------------------
-- A 083 marcava `playlist_desatualizada_em` em TODA tela ativa a cada mudança
-- que alimenta a playlist (criativo, mídia, vínculo, ponto, conta, tela). Dois
-- comandos concorrentes que disparavam o gatilho travavam as mesmas linhas de
-- `dispositivos` em ordem diferente → deadlock (40P01) e 500 na rota (CI do
-- PR #121: revogar credencial × DELETE de telas).
--
-- A semântica sempre foi global ("mudou algo, toda tela deve buscar de
-- novo"), então a verdade passa a ser uma só: o livro `playlist_mudancas`.
-- Cada TRANSAÇÃO que muda algo relevante insere UMA linha (id = versão global,
-- `em` = relógio do primeiro comando que mudou). INSERT não disputa trava com
-- ninguém — nem com outro INSERT, nem com UPDATE/DELETE de telas —, então não
-- existe ordem de travas para inverter. Nada de linha única (singleton): um
-- UPDATE nela serializaria toda escrita até o COMMIT e criaria outra ordem de
-- travas possível.
--
-- Quem lê (src/playlist/routes.js e src/player/sinal.js): a tela está
-- desatualizada quando a última mudança é posterior à cobertura da última
-- playlist que ela recebeu (`playlist_gerada_desde` = início da geração − a
-- mesma folga de 5 s de antes). A marca por tela (`playlist_desatualizada_em`)
-- continua existindo para o pedido direcionado da operação
-- (anunciantes/fila-entrada.js#pedirAtualizacaoDasTelas) — o gatilho só não
-- escreve mais nela.
-- limite: o livro cresce uma linha por transação que muda a playlist (não
-- por tela nem por heartbeat); só a última importa. Se crescer demais,
-- apagar as antigas mantendo a de maior id.
CREATE TABLE IF NOT EXISTS playlist_mudancas (
  id bigserial PRIMARY KEY,
  em timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_playlist_mudancas_em ON playlist_mudancas (em);
ALTER TABLE playlist_mudancas ENABLE ROW LEVEL SECURITY;

ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS playlist_gerada_desde timestamptz;

-- Mesma função (os gatilhos da 083 continuam ligados a ela, com as mesmas
-- condições — todo fato que invalidava continua invalidando): só o corpo
-- muda. Uma linha por transação: a primeira mudança grava e marca a
-- transação (`set_config(..., true)` vale só até o COMMIT/ROLLBACK e volta
-- junto num ROLLBACK TO SAVEPOINT); as seguintes não gravam de novo.
CREATE OR REPLACE FUNCTION marcar_playlists_desatualizadas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('mostrai.playlist_mudou', true) IS DISTINCT FROM 'sim' THEN
    INSERT INTO playlist_mudancas DEFAULT VALUES;
    PERFORM set_config('mostrai.playlist_mudou', 'sim', true);
  END IF;
  RETURN NULL;
END $$;

-- O `em` vale o instante do COMMIT, não o do comando: gatilho de restrição
-- ADIADO na própria linha, que roda no fim da transação. Assim duas
-- transações que fecham fora de ordem (a mais velha commitando depois) têm
-- `em` na ordem em que ficaram visíveis — senão a mais velha nasceria com
-- `em` anterior ao de uma playlist já entregue e a tela nunca seria avisada
-- (revisão do PR #122). Atualiza só a própria linha, ainda invisível aos
-- outros: não disputa trava com ninguém. A folga de 5 s do GET /playlist
-- cobre o intervalo entre este carimbo e o COMMIT.
CREATE OR REPLACE FUNCTION carimbar_playlist_mudanca() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE playlist_mudancas SET em = clock_timestamp() WHERE id = NEW.id;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS playlist_mudanca_no_commit ON playlist_mudancas;
CREATE CONSTRAINT TRIGGER playlist_mudanca_no_commit AFTER INSERT ON playlist_mudancas
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION carimbar_playlist_mudanca();
