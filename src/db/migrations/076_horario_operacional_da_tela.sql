-- Horário operacional da tela (revisão final da Visão Geral, 23/09/2026,
-- pedido do dono): o alerta "X tela(s) sem dar sinal" tratava toda ausência
-- de heartbeat como falha, mesmo quando o estabelecimento estava só fechado.
-- Cada tela ganha um modo — 'ponto' (usa horario_semanal do ponto onde está
-- instalada, o padrão), '24h' (sempre esperada online) ou 'personalizado'
-- (horario_semanal PRÓPRIO da tela, pra quando ela roda além do horário do
-- comércio — ex.: tela virada pra rua que continua ligada depois da loja
-- fechar). `horario_semanal` aqui é o MESMO formato/validação de
-- pontos.horario_semanal (migration 066): objeto por dia, `null` ou
-- {"abre":"HH:MM","fecha":"HH:MM"}.
ALTER TABLE dispositivos ADD COLUMN modo_horario text NOT NULL DEFAULT 'ponto'
  CHECK (modo_horario IN ('ponto', '24h', 'personalizado'));
ALTER TABLE dispositivos ADD COLUMN horario_semanal jsonb;

-- Erro operacional relatado pelo PRÓPRIO player (não inferido pelo backend
-- por ausência de heartbeat — isso já é "sem sinal"). Fica ao lado do
-- heartbeat: cada chamada de /player/:id/heartbeat que vier com `erro` grava
-- os dois campos juntos; uma chamada limpa (sem `erro`) zera os dois — não
-- existe status de erro "preso" depois que o player volta a reportar normal.
ALTER TABLE dispositivos ADD COLUMN ultimo_erro text;
ALTER TABLE dispositivos ADD COLUMN ultimo_erro_em timestamptz;
