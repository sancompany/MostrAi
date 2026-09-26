-- Config do Player MVP (docs/player-mvp-contract.md §6): margens da tela +
-- horário do PONTO + PIN de saída global. Rotação, horário/fuso por tela,
-- PIN por tela e update remoto saíram da config, então deixam de subir a
-- versão. O PIN global sobe a versão de todas as telas no próprio código
-- (src/player/pin-saida.js#definir), na mesma transação.
--
-- As colunas antigas continuam na tabela até a migration de limpeza; este
-- gatilho já não depende de nenhuma delas.
CREATE OR REPLACE FUNCTION tela_config_versionada() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.margem_superior, NEW.margem_direita, NEW.margem_inferior, NEW.margem_esquerda)
     IS DISTINCT FROM
     (OLD.margem_superior, OLD.margem_direita, OLD.margem_inferior, OLD.margem_esquerda) THEN
    NEW.config_versao_desejada := OLD.config_versao_desejada + 1;
    NEW.config_alterada_em := now();
  END IF;
  RETURN NEW;
END $$;

-- Toda tela segue o horário do ponto: mudou o horário, TODAS as telas do
-- ponto recebem config nova (antes, só as que estavam em modo "ponto").
CREATE OR REPLACE FUNCTION ponto_horario_versiona_telas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE dispositivos
     SET config_versao_desejada = config_versao_desejada + 1, config_alterada_em = now()
   WHERE ponto_id = NEW.id;
  RETURN NULL;
END $$;

-- O formato da config mudou (pinSaida, operacao sem regime): toda tela busca
-- a config de novo no próximo heartbeat.
UPDATE dispositivos SET config_versao_desejada = config_versao_desejada + 1, config_alterada_em = now();
