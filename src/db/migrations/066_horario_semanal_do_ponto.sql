-- Horário de funcionamento do ponto — pedido do dono, 22/09/2026 ("uma
-- pulga atrás da orelha" de um formulário antigo que nunca chegou a
-- existir). `horario_abertura`/`horario_fechamento` (migration 001, `time`
-- único) nunca tiveram tela nenhuma pra preencher e nunca entraram em
-- nenhum cálculo — ficam intocados (migrations são aditivas, drop só com
-- permissão, CONSTRAINTS.md), mas não são a base disto: o pedido agora é
-- por DIA DA SEMANA, não um horário só pra tudo.
--
-- Formato de `horario_semanal`: objeto com uma chave por dia
-- (seg/ter/qua/qui/sex/sab/dom), cada uma `null` (fechado) ou
-- `{"abre":"HH:MM","fecha":"HH:MM"}`. Validado em src/lib/horario-semanal.js
-- antes de gravar — a coluna em si aceita qualquer JSON, a validação é só
-- na aplicação. `NULL` na coluna inteira = nunca preenchido (ponto antigo,
-- ou cadastro manual do admin que pulou o campo).
ALTER TABLE pontos ADD COLUMN horario_semanal jsonb;

-- Mesma forma, na candidatura — o formulário público de "quero ser ponto"
-- coleta o horário ANTES de o ponto existir; ele precisa sobreviver até o
-- admin liberar a candidatura na conta (liberarPapelNaConta,
-- src/conta/modos.js), que é quando o `pontos.horario_semanal` nasce.
ALTER TABLE candidaturas ADD COLUMN horario_semanal jsonb;
