-- Limpeza do Player MVP (docs/player-mvp-contract.md): o código deixou de
-- ler e escrever tudo isto nas fases G–K (player web/V1, /hello, OTA,
-- rotação de tela, horário/fuso/PIN por tela, rotação de credencial).
-- Conferido antes do DROP: nenhuma referência em src/, public/, scripts/
-- nem em função/gatilho/view do banco (o gatilho de versão da config só
-- olha margens desde a 093). Índices e CHECKs destas colunas caem junto.
--
-- Destrutiva: rodar em produção só com backup válido e recente
-- (RUNBOOK.md). Produção tinha 0 telas quando foi escrita.

-- OTA: a aba "Versões do Player" e o manifesto no heartbeat saíram.
DROP TABLE IF EXISTS player_releases;

ALTER TABLE dispositivos
  -- V1: chave em claro, PIN do player web, formato de playlist em array.
  DROP COLUMN IF EXISTS aparelho_id,
  DROP COLUMN IF EXISTS pin_hash,
  DROP COLUMN IF EXISTS contrato_playlist,
  -- Horário/fuso por tela: toda tela segue o horário do ponto.
  DROP COLUMN IF EXISTS modo_horario,
  DROP COLUMN IF EXISTS horario_semanal,
  DROP COLUMN IF EXISTS timezone,
  -- PIN por tela: o PIN de saída é global (configuracoes_site).
  DROP COLUMN IF EXISTS pin_manutencao_cifrado,
  DROP COLUMN IF EXISTS pin_manutencao_alterado_em,
  -- Rotação da tela: orientação fixa no APK.
  DROP COLUMN IF EXISTS rotacao_tela,
  -- OTA.
  DROP COLUMN IF EXISTS update_estado,
  DROP COLUMN IF EXISTS update_estado_em,
  DROP COLUMN IF EXISTS update_baixar_auto,
  DROP COLUMN IF EXISTS update_horas_entre_tentativas,
  -- /hello e dados do aparelho.
  DROP COLUMN IF EXISTS player_contrato,
  DROP COLUMN IF EXISTS aparelho_fabricante,
  DROP COLUMN IF EXISTS aparelho_modelo,
  DROP COLUMN IF EXISTS aparelho_android,
  DROP COLUMN IF EXISTS aparelho_largura,
  DROP COLUMN IF EXISTS aparelho_altura,
  DROP COLUMN IF EXISTS aparelho_timezone,
  DROP COLUMN IF EXISTS hello_primeiro_em,
  DROP COLUMN IF EXISTS hello_ultimo_em,
  -- Campos do heartbeat que saíram do contrato.
  DROP COLUMN IF EXISTS ultima_playlist_ok_em,
  DROP COLUMN IF EXISTS desvio_relogio_ms,
  -- Identidade técnica antiga: o ID da tela é a própria PK (M-0235).
  DROP COLUMN IF EXISTS dispositivo_uid,
  -- Rotação de credencial: uma chave por tela, sem candidata nem anterior.
  DROP COLUMN IF EXISTS chave_fingerprint,
  DROP COLUMN IF EXISTS chave_criada_em,
  DROP COLUMN IF EXISTS chave_atual_cifrada,
  DROP COLUMN IF EXISTS chave_nova_hash,
  DROP COLUMN IF EXISTS chave_nova_fingerprint,
  DROP COLUMN IF EXISTS chave_nova_cifrada,
  DROP COLUMN IF EXISTS chave_nova_criada_em,
  DROP COLUMN IF EXISTS chave_anterior_hash,
  DROP COLUMN IF EXISTS chave_anterior_expira_em;
