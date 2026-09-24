-- (084 fica reservada pro Player V2 — zerar `dispositivos.aparelho_id`, ver
-- docs/PENDENCIAS.md, seção "Player V2".)
--
-- Janela de compra das promoções no relógio de Matão (D3, rodada de
-- 24/09/2026, decisão do dono: "a promoção não pode encerrar 3 horas antes
-- por conversão UTC/local").
--
-- ANTES: o admin mandava o `datetime-local` cru ("2026-10-31T00:00", sem
-- fuso) e o Postgres, com a sessão em UTC, gravava 00:00 de LONDRES —
-- 21:00 do dia anterior em Matão. O formulário relia em UTC, então o admin
-- via exatamente o que digitou e nada denunciava o erro; o site público, que
-- formata no fuso do navegador, anunciava "válida até 30/10/2026".
--
-- AGORA (src/lib/fuso-comercial.js): horário sem fuso é horário de São
-- Paulo, e o fim é inclusivo no minuto (até :59,999). Esta migration faz o
-- mesmo com o que já está gravado: toda linha de `promocoes` só pôde ser
-- criada pelo admin (não há outra rota que escreva essas colunas), então o
-- relógio UTC gravado É o que o admin digitou — relê-lo como São Paulo
-- devolve a intenção dele, sem inventar nenhuma. Em produção (24/09/2026):
-- 1 promoção, 22/09 00:00 → 31/10 00:00 digitados; passa a valer de 22/09
-- 00:00 até 31/10 00:00:59 de Matão. Se a intenção era o dia 31 inteiro, é
-- o admin que muda pra 23:59 — o site agora mostra "às 00:00" e deixa isso
-- visível.
--
-- `midias_proprias.periodo_*` NÃO entra: ali o navegador já convertia certo
-- na ida (o erro era só a releitura), e cada edição somou +3h de forma
-- diferente — não dá pra saber daqui qual horário o admin quis. Fica no
-- relatório da rodada pro dono conferir no admin.
UPDATE promocoes
   SET compra_inicio = (compra_inicio AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
 WHERE compra_inicio IS NOT NULL;

UPDATE promocoes
   SET compra_fim = ((compra_fim AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')
                    + CASE WHEN date_trunc('minute', compra_fim) = compra_fim
                           THEN interval '59.999 seconds' ELSE interval '0' END
 WHERE compra_fim IS NOT NULL;
