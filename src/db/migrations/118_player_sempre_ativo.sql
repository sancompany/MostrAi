-- 118 — Player sempre ativo fora do horário (08/10/2026, decisão do dono).
--
-- O bloco `operacao` de GET /player/:id/config passou a ir SEMPRE como o dia
-- inteiro (src/player/config.js): o APK apagava a TV fora do horário do
-- ponto (ou do compromisso da tela móvel), e TV ligada + Player saudável
-- tem de reproduzir. O conteúdo da config mudou sem que nada na tela mudasse
-- — sem subir a versão desejada, a TV que já aplicou a config antiga nunca
-- buscaria a nova. Mesma operação da migration 093 (que mudou o formato da
-- config): toda tela recebe a config de novo na próxima batida.
UPDATE dispositivos SET config_versao_desejada = config_versao_desejada + 1, config_alterada_em = now();
