-- Upload de criativo idempotente (estação sessão + upload, 27/09/2026).
--
-- O processamento do vídeo (FFmpeg a 0,5 vCPU + Storage) passa dos 100 s do
-- proxy da Cloudflare em peças de 16 s ou mais — medido nos criativos reais
-- de produção (105,7 s e 131,8 s). O proxy devolve 524 ao navegador, a tela
-- dizia "Não foi possível enviar", e o servidor terminava o trabalho e criava
-- o criativo mesmo assim. Tentar de novo criava OUTRO.
--
-- `envio_chave`: gerada pelo navegador UMA vez por arquivo escolhido e
-- mandada no cabeçalho `Idempotency-Key`. Repetir a mesma tentativa devolve
-- o criativo que já existe (ou "ainda processando") em vez de criar outro, e
-- o painel usa a chave pra perguntar o que aconteceu quando a resposta se
-- perdeu. Não é hash do arquivo: a mesma peça pode ser enviada de novo, de
-- propósito, em outro momento — com outra chave.
--
-- Única POR CONTA, e só quando existe (upload do operador e clientes antigos
-- não mandam chave). Falha no processamento apaga a linha temporária, então a
-- chave volta a valer e a nova tentativa processa de novo.
ALTER TABLE criativos
  ADD COLUMN envio_chave text CHECK (envio_chave ~ '^[A-Za-z0-9-]{16,64}$');

CREATE UNIQUE INDEX criativos_envio_chave_uniq ON criativos (anunciante_id, envio_chave)
  WHERE envio_chave IS NOT NULL;
