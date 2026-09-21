-- App Android TV nativo (sancompany/playlist.mostrai) pede um contrato novo
-- de /playlist e /player/:id/played — envelope com versaoContrato/janelaId/
-- itemProgramacaoId/criativoId, e confirmação em lote por execucaoId, com
-- deduplicação obrigatória no backend (decisão fechada 3 daquele repositório).
--
-- `contrato_playlist` decide, POR TELA, qual formato `/playlist` devolve: 1
-- (padrão) é o array de sempre, que o player web (`public/player.page.js`)
-- já consome sem mudar nada; 2 é o envelope novo, pra quem instalar o app
-- nativo. Sem esta trava, o servidor não teria como saber qual das duas
-- formas mandar — o app novo não manda nenhum cabeçalho de versão, só
-- reconhece a forma pela resposta (ver `docs/api.md`).
ALTER TABLE dispositivos ADD COLUMN contrato_playlist smallint NOT NULL DEFAULT 1;

-- Ledger de deduplicação do proof-of-play em lote (contrato novo). Cada
-- `execucaoId` é gerado uma vez no aparelho, antes do play(), e reenviado
-- em retentativa até o servidor confirmar — sem isto, queda de rede depois
-- de creditar (resposta perdida no meio do caminho) conta a mesma exibição
-- duas vezes, e o comprovante fica falso (mesma razão do teto em
-- `exibicoes_contador.vezes_confirmadas`, ver src/playlist/gerador.js).
--
-- limite: sem expurgo automático aqui — cresce por execução confirmada, não
-- por hora agregada como `exibicoes_contador`. Aceitável hoje (rede de 1
-- ponto); se crescer demais, criar rotina de limpeza por `confirmado_em`
-- mais velho que a janela de retentativa do app (7 dias, ver
-- `playlist.mostrai`, `FilaProofOfPlay.HORIZONTE_EXPIRACAO_MS`).
CREATE TABLE execucoes_confirmadas (
  execucao_id text PRIMARY KEY,
  dispositivo_id int NOT NULL REFERENCES dispositivos(id),
  status text NOT NULL,
  confirmado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX execucoes_confirmadas_dispositivo_idx ON execucoes_confirmadas (dispositivo_id, confirmado_em);
