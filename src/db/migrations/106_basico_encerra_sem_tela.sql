-- Plano Básico do ponto: encerra quando o ponto fica sem NENHUMA tela
-- instalada (28/09/2026, decisão do dono no fechamento da estação — ADR-025,
-- RN-43.5). Até aqui o benefício só terminava com ponto arquivado, dono
-- trocado, conta excluída ou conta interna; um ponto com todas as telas
-- removidas, revogadas ou inativas continuava com 14 h/mês, upload e vaga
-- sem funcionar mais como ponto da rede.
--
-- Não é status novo: é mais um MOTIVO de fim, na lista fechada que já
-- existia. Problema temporário continua sem encerrar — tela em reparo, TV
-- sem sinal, internet caída (sinal não é estado estrutural; a régua é a tela
-- instalada, não o heartbeat). Voltar a ter tela instalada abre um Básico
-- novo (o índice único parcial garante um ativo por ponto; o histórico fica).
ALTER TABLE beneficios_basico_ponto DROP CONSTRAINT IF EXISTS beneficios_basico_ponto_motivo_fim_check;
ALTER TABLE beneficios_basico_ponto ADD CONSTRAINT beneficios_basico_ponto_motivo_fim_check CHECK (
  motivo_fim IS NULL OR motivo_fim IN (
    'ponto_arquivado', 'dono_mudou', 'conta_excluida', 'conta_interna', 'sem_tela_instalada'
  )
);
