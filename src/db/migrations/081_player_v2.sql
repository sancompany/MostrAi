-- Player V2 — contraparte do contrato implementado em sancompany/Playlist.MostrAi
-- (docs/player-v2-contract.md, main 28bc93d). Plano em
-- docs/specs/2026-09-23-player-v2-backend.md.
--
-- Tudo aditivo e idempotente (IF NOT EXISTS / CREATE OR REPLACE): nenhuma
-- coluna existente é apagada nem reescrita, exceto o backfill das colunas
-- novas. `aparelho_id` (chave em claro, migration 019) continua na tabela
-- nesta migration — o código deixa de ler e escrever nela, e o valor só é
-- zerado numa migration seguinte, depois de a produção provar que a
-- autenticação por hash funciona (reverter o código antes disso não derruba
-- as TVs V1).

-- ---------------------------------------------------------------------------
-- 1. Identidade da Tela: número estável dentro do ponto ("Tela 3" continua
--    "Tela 3" se a Tela 2 sair). Contador no ponto, nunca reaproveitado.
-- ---------------------------------------------------------------------------
ALTER TABLE pontos ADD COLUMN IF NOT EXISTS telas_numeradas integer NOT NULL DEFAULT 0;
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS numero integer;

UPDATE dispositivos d SET numero = x.n
  FROM (SELECT id, row_number() OVER (PARTITION BY ponto_id ORDER BY id)::int AS n FROM dispositivos) x
 WHERE x.id = d.id AND d.numero IS NULL;

UPDATE pontos p SET telas_numeradas = GREATEST(p.telas_numeradas,
  COALESCE((SELECT max(numero) FROM dispositivos WHERE ponto_id = p.id), 0));

ALTER TABLE dispositivos ALTER COLUMN numero SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dispositivos_ponto_numero_uk ON dispositivos (ponto_id, numero);

-- Toda tela nova ganha o próximo número do ponto no próprio INSERT — no
-- banco, e não em cada caminho que cria tela: esquecer num deles quebraria
-- o NOT NULL (ou pior, repetiria número). A trava de linha do UPDATE em
-- `pontos` serializa duas criações simultâneas no mesmo ponto.
CREATE OR REPLACE FUNCTION tela_numero_estavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.numero IS NULL THEN
    UPDATE pontos SET telas_numeradas = telas_numeradas + 1 WHERE id = NEW.ponto_id
      RETURNING telas_numeradas INTO NEW.numero;
  ELSE
    UPDATE pontos SET telas_numeradas = GREATEST(telas_numeradas, NEW.numero) WHERE id = NEW.ponto_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tela_numero_estavel ON dispositivos;
CREATE TRIGGER tela_numero_estavel BEFORE INSERT ON dispositivos
  FOR EACH ROW EXECUTE FUNCTION tela_numero_estavel();

-- `apelido` ("Nome da tela (só interno)") sai da interface; a coluna fica
-- (NOT NULL com default) para não quebrar leitura antiga.

-- ---------------------------------------------------------------------------
-- 2. Identidade do Player e credencial (hash, nunca em claro)
-- ---------------------------------------------------------------------------
ALTER TABLE dispositivos
  ADD COLUMN IF NOT EXISTS dispositivo_uid text,
  ADD COLUMN IF NOT EXISTS provisionado_em timestamptz,
  ADD COLUMN IF NOT EXISTS revogado_em timestamptz,
  ADD COLUMN IF NOT EXISTS chave_hash text,
  ADD COLUMN IF NOT EXISTS chave_fingerprint text,
  ADD COLUMN IF NOT EXISTS chave_criada_em timestamptz,
  ADD COLUMN IF NOT EXISTS chave_ultimo_uso_em timestamptz,
  -- Rotação (contrato §1.1): a candidata vai no heartbeat até o Player usá-la.
  -- A cópia cifrada existe só para reenviar enquanto não é confirmada.
  ADD COLUMN IF NOT EXISTS chave_nova_hash text,
  ADD COLUMN IF NOT EXISTS chave_nova_fingerprint text,
  ADD COLUMN IF NOT EXISTS chave_nova_cifrada text,
  ADD COLUMN IF NOT EXISTS chave_nova_criada_em timestamptz,
  -- Sobreposição: a anterior vale até expirar (24h), para requisições que já
  -- tinham saído com ela.
  ADD COLUMN IF NOT EXISTS chave_anterior_hash text,
  ADD COLUMN IF NOT EXISTS chave_anterior_expira_em timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS dispositivos_uid_uk ON dispositivos (dispositivo_uid) WHERE dispositivo_uid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dispositivos_chave_hash_uk ON dispositivos (chave_hash) WHERE chave_hash IS NOT NULL;

-- Chave V1 existente → hash. A TV continua mandando a mesma chave; o
-- servidor passa a comparar o SHA-256 dela.
UPDATE dispositivos
   SET chave_hash = encode(sha256(convert_to(aparelho_id, 'UTF8')), 'hex'),
       chave_fingerprint = upper(right(encode(sha256(convert_to(aparelho_id, 'UTF8')), 'hex'), 6))
 WHERE aparelho_id IS NOT NULL AND chave_hash IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Snapshot do Player (hello + heartbeat). Uma linha por tela, sobrescrita;
--    histórico só de transição (tela_eventos, abaixo).
-- ---------------------------------------------------------------------------
ALTER TABLE dispositivos
  ADD COLUMN IF NOT EXISTS primeiro_sinal_em timestamptz,
  ADD COLUMN IF NOT EXISTS player_contrato smallint,
  ADD COLUMN IF NOT EXISTS player_versao text,
  ADD COLUMN IF NOT EXISTS player_build integer,
  ADD COLUMN IF NOT EXISTS aparelho_fabricante text,
  ADD COLUMN IF NOT EXISTS aparelho_modelo text,
  ADD COLUMN IF NOT EXISTS aparelho_android text,
  ADD COLUMN IF NOT EXISTS aparelho_largura integer,
  ADD COLUMN IF NOT EXISTS aparelho_altura integer,
  ADD COLUMN IF NOT EXISTS aparelho_timezone text,
  ADD COLUMN IF NOT EXISTS hello_primeiro_em timestamptz,
  ADD COLUMN IF NOT EXISTS hello_ultimo_em timestamptz,
  ADD COLUMN IF NOT EXISTS player_estado text,
  ADD COLUMN IF NOT EXISTS criativo_atual text,
  ADD COLUMN IF NOT EXISTS ultima_playlist_ok_em timestamptz,
  ADD COLUMN IF NOT EXISTS playlist_entregue_em timestamptz,
  ADD COLUMN IF NOT EXISTS fila_pendentes integer,
  ADD COLUMN IF NOT EXISTS fila_mais_antigo_em timestamptz,
  ADD COLUMN IF NOT EXISTS ultimo_erro_codigo text,
  ADD COLUMN IF NOT EXISTS desvio_relogio_ms bigint,
  ADD COLUMN IF NOT EXISTS update_estado text,
  ADD COLUMN IF NOT EXISTS update_estado_em timestamptz;

-- Primeiro sinal de telas que já falaram antes desta migration: o mais cedo
-- que se sabe (primeira exibição confirmada, ou o último heartbeat). Nunca é
-- apagado depois.
UPDATE dispositivos d
   SET primeiro_sinal_em = LEAST(
         d.ultima_vez_online,
         (SELECT min(e.janela_hora) FROM exibicoes_contador e WHERE e.dispositivo_id = d.id AND e.vezes_confirmadas > 0))
 WHERE d.primeiro_sinal_em IS NULL
   AND (d.ultima_vez_online IS NOT NULL
        OR EXISTS (SELECT 1 FROM exibicoes_contador e WHERE e.dispositivo_id = d.id AND e.vezes_confirmadas > 0));

-- ---------------------------------------------------------------------------
-- 4. Configuração versionada (contrato §5)
-- ---------------------------------------------------------------------------
ALTER TABLE dispositivos
  ADD COLUMN IF NOT EXISTS rotacao_tela smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN IF NOT EXISTS update_baixar_auto boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS update_horas_entre_tentativas smallint NOT NULL DEFAULT 6,
  -- PIN do painel do Player: o contrato entrega em claro na config
  -- (`pinPainel`), então o servidor precisa recuperá-lo — guardado cifrado
  -- (AES-256-GCM, src/lib/cofre.js), nunca em claro. `pin_hash` continua
  -- sendo o PIN que o player web (V1) confere no servidor.
  ADD COLUMN IF NOT EXISTS pin_manutencao_cifrado text,
  ADD COLUMN IF NOT EXISTS pin_manutencao_alterado_em timestamptz,
  ADD COLUMN IF NOT EXISTS config_versao_desejada integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS config_alterada_em timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS config_versao_aplicada integer,
  ADD COLUMN IF NOT EXISTS config_aplicada_em timestamptz,
  -- Playlist desatualizada (sinal `playlist.atualizar`, contrato §6.2).
  ADD COLUMN IF NOT EXISTS playlist_desatualizada_em timestamptz,
  ADD COLUMN IF NOT EXISTS playlist_sinalizada_em timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispositivos_rotacao_tela_check') THEN
    ALTER TABLE dispositivos ADD CONSTRAINT dispositivos_rotacao_tela_check CHECK (rotacao_tela IN (0, 90, 180, 270));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispositivos_update_horas_check') THEN
    ALTER TABLE dispositivos ADD CONSTRAINT dispositivos_update_horas_check CHECK (update_horas_entre_tentativas BETWEEN 1 AND 72);
  END IF;
  -- Margens: SEM teto no banco e sem cortar valor existente. O Player V2
  -- aceita 0–10 vmin (contrato §5) e o /config manda no máximo isso
  -- (src/player/config.js); o player web V1 respeita até 20, e uma TV V1
  -- configurada com 15 não pode perder a moldura no deploy. O teto de 10 vale
  -- para a escrita nova (validarCampos em src/dispositivos/routes.js). Um CHECK
  -- NOT VALID não serve: barraria qualquer UPDATE da linha — o heartbeat.
END $$;

-- Versão desejada sobe sozinha quando muda qualquer campo que vai na config.
-- No banco, e não em cada rota: esquecer de incrementar num caminho novo
-- deixaria a TV com a config velha sem ninguém perceber.
CREATE OR REPLACE FUNCTION tela_config_versionada() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.margem_superior, NEW.margem_direita, NEW.margem_inferior, NEW.margem_esquerda,
      NEW.rotacao_tela, NEW.modo_horario, NEW.horario_semanal, NEW.timezone,
      NEW.pin_manutencao_cifrado, NEW.update_baixar_auto, NEW.update_horas_entre_tentativas)
     IS DISTINCT FROM
     (OLD.margem_superior, OLD.margem_direita, OLD.margem_inferior, OLD.margem_esquerda,
      OLD.rotacao_tela, OLD.modo_horario, OLD.horario_semanal, OLD.timezone,
      OLD.pin_manutencao_cifrado, OLD.update_baixar_auto, OLD.update_horas_entre_tentativas) THEN
    NEW.config_versao_desejada := OLD.config_versao_desejada + 1;
    NEW.config_alterada_em := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tela_config_versionada ON dispositivos;
CREATE TRIGGER tela_config_versionada BEFORE UPDATE ON dispositivos
  FOR EACH ROW EXECUTE FUNCTION tela_config_versionada();

-- Horário do ponto mudou: as telas que seguem o ponto recebem a config nova.
CREATE OR REPLACE FUNCTION ponto_horario_versiona_telas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE dispositivos
     SET config_versao_desejada = config_versao_desejada + 1, config_alterada_em = now()
   WHERE ponto_id = NEW.id AND modo_horario = 'ponto';
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS ponto_horario_versiona_telas ON pontos;
CREATE TRIGGER ponto_horario_versiona_telas AFTER UPDATE OF horario_semanal ON pontos
  FOR EACH ROW WHEN (OLD.horario_semanal IS DISTINCT FROM NEW.horario_semanal)
  EXECUTE FUNCTION ponto_horario_versiona_telas();

-- ---------------------------------------------------------------------------
-- 4b. contentHash (contrato §6.1): SHA-256 do arquivo FINAL servido. Antes
--     da seção 5: o gatilho de criativos lê esta coluna.
-- ---------------------------------------------------------------------------
ALTER TABLE criativos
  ADD COLUMN IF NOT EXISTS conteudo_sha256 text,
  ADD COLUMN IF NOT EXISTS conteudo_bytes bigint;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'criativos_conteudo_sha256_check') THEN
    ALTER TABLE criativos ADD CONSTRAINT criativos_conteudo_sha256_check CHECK (conteudo_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Playlist desatualizada: tudo que alimenta o gerador marca as telas
--    ativas. Gatilho POR LINHA e só com mudança de verdade (WHEN … IS
--    DISTINCT FROM): gatilho por instrução dispararia até com UPDATE que não
--    muda nada (status regravado igual, cron que casa 0 linhas) e marcaria a
--    rede inteira à toa.
--    limite: marca todas as telas ativas a cada mudança real — custa uma
--    busca de playlist por tela por mudança; afinar por ponto/anunciante
--    quando a rede tiver centenas de telas.
--    clock_timestamp(), não now(): o GET /playlist só limpa marcas anteriores
--    ao início da própria geração (com folga), e now() é o início da
--    transação que mudou — poderia ser anterior demais. Marca de menos de 1 s
--    atrás não é regravada (lote que muda várias linhas de uma vez).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION marcar_playlists_desatualizadas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE dispositivos SET playlist_desatualizada_em = clock_timestamp()
   WHERE status = 'ativo'
     AND (playlist_desatualizada_em IS NULL OR playlist_desatualizada_em < clock_timestamp() - interval '1 second');
  RETURN NULL;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  -- Inserir ou apagar linha sempre muda o que o gerador lê.
  FOREACH t IN ARRAY ARRAY['criativos', 'midias_proprias', 'midias_proprias_pontos', 'anunciantes_pontos', 'dispositivos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS playlist_desatualizada_ins_del ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER playlist_desatualizada_ins_del AFTER INSERT OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION marcar_playlists_desatualizadas()', t);
  END LOOP;
  -- Tabelas de ligação: qualquer UPDATE é mudança de vínculo.
  FOREACH t IN ARRAY ARRAY['midias_proprias', 'midias_proprias_pontos', 'anunciantes_pontos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS playlist_desatualizada ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER playlist_desatualizada AFTER UPDATE ON %I
         FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION marcar_playlists_desatualizadas()', t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS playlist_desatualizada ON criativos;
CREATE TRIGGER playlist_desatualizada AFTER UPDATE ON criativos
  FOR EACH ROW WHEN ((OLD.status, OLD.anunciante_id, OLD.arquivo_normalizado_url, OLD.duracao_segundos, OLD.conteudo_sha256)
                     IS DISTINCT FROM
                     (NEW.status, NEW.anunciante_id, NEW.arquivo_normalizado_url, NEW.duracao_segundos, NEW.conteudo_sha256))
  EXECUTE FUNCTION marcar_playlists_desatualizadas();

DROP TRIGGER IF EXISTS playlist_desatualizada ON anunciantes;
CREATE TRIGGER playlist_desatualizada AFTER UPDATE ON anunciantes
  FOR EACH ROW WHEN ((OLD.status, OLD.plano_id, OLD.data_inicio_cobertura, OLD.data_expiracao, OLD.suspenso, OLD.excluido_em,
                      OLD.categoria_id, OLD.comodato_plano_id, OLD.papeis, OLD.conta_propria, OLD.frequencia_hora_propria)
                     IS DISTINCT FROM
                     (NEW.status, NEW.plano_id, NEW.data_inicio_cobertura, NEW.data_expiracao, NEW.suspenso, NEW.excluido_em,
                      NEW.categoria_id, NEW.comodato_plano_id, NEW.papeis, NEW.conta_propria, NEW.frequencia_hora_propria))
  EXECUTE FUNCTION marcar_playlists_desatualizadas();

DROP TRIGGER IF EXISTS playlist_desatualizada ON pontos;
CREATE TRIGGER playlist_desatualizada AFTER UPDATE ON pontos
  FOR EACH ROW WHEN ((OLD.status, OLD.categoria_id, OLD.cota_autoanuncio_slots_hora, OLD.anunciante_id, OLD.escolha_bloqueada_em)
                     IS DISTINCT FROM
                     (NEW.status, NEW.categoria_id, NEW.cota_autoanuncio_slots_hora, NEW.anunciante_id, NEW.escolha_bloqueada_em))
  EXECUTE FUNCTION marcar_playlists_desatualizadas();

-- Em dispositivos só o que muda a cobertura (quantas telas ativas o ponto
-- tem). `UPDATE OF status` não dispara de novo com o UPDATE da própria função.
DROP TRIGGER IF EXISTS playlist_desatualizada ON dispositivos;
CREATE TRIGGER playlist_desatualizada AFTER UPDATE OF status ON dispositivos
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION marcar_playlists_desatualizadas();

-- ---------------------------------------------------------------------------
-- 6. Provisionamento por token de uso único (contrato §2.1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tokens_provisionamento (
  id serial PRIMARY KEY,
  dispositivo_id integer NOT NULL REFERENCES dispositivos(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  criado_em timestamptz NOT NULL DEFAULT now(),
  criado_por text,
  expira_em timestamptz NOT NULL,
  usado_em timestamptz,
  cancelado_em timestamptz,
  -- Pedido do contrato §2.3: a mesma troca, repetida por alguns minutos,
  -- devolve as mesmas credenciais (a resposta pode se perder na rede depois
  -- de o servidor queimar o token). Cifrada, apagada ao fim da janela ou no
  -- primeiro uso da credencial nova.
  credencial_cifrada text,
  CHECK (usado_em IS NULL OR cancelado_em IS NULL)
);
CREATE INDEX IF NOT EXISTS tokens_provisionamento_tela_idx ON tokens_provisionamento (dispositivo_id, criado_em DESC);

-- ---------------------------------------------------------------------------
-- 7. Histórico de transições da tela (nunca um heartbeat por linha)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tela_eventos (
  id bigserial PRIMARY KEY,
  dispositivo_id integer NOT NULL REFERENCES dispositivos(id) ON DELETE CASCADE,
  tipo text NOT NULL,
  ocorrido_em timestamptz NOT NULL DEFAULT now(),
  detalhe jsonb
);
CREATE INDEX IF NOT EXISTS tela_eventos_tela_idx ON tela_eventos (dispositivo_id, ocorrido_em DESC);

-- ---------------------------------------------------------------------------
-- 8. Releases do Player (OTA fase 1, contrato §8)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_releases (
  id serial PRIMARY KEY,
  versao text NOT NULL,
  build integer NOT NULL UNIQUE CHECK (build > 0),
  url text NOT NULL CHECK (url LIKE 'https://%'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  tamanho_bytes bigint CHECK (tamanho_bytes > 0),
  obrigatoria boolean NOT NULL DEFAULT false,
  build_minimo integer CHECK (build_minimo > 0),
  notas text,
  -- Um humano confere que o APK foi assinado com o keystore definitivo antes
  -- de liberar: o Android recusa APK com assinatura diferente da instalada, e
  -- o servidor não tem como provar isso sozinho (contrato §8.4).
  assinatura_conferida_em timestamptz,
  assinatura_conferida_por text,
  ativa boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now(),
  criado_por text,
  CHECK (NOT ativa OR assinatura_conferida_em IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 9. Estado do ponto: "Ativo" só com tela ativa, com credencial, que já deu
--     sinal (o resto da regra é a de sempre — src/pontos/repository.js
--     sincronizarStatusPonto).
-- ---------------------------------------------------------------------------
UPDATE pontos p SET status = x.status
  FROM (
    SELECT p2.id,
           CASE
             WHEN COUNT(d.id) = 0 THEN 'a_instalar'
             WHEN COUNT(d.id) FILTER (WHERE d.status = 'ativo' AND d.primeiro_sinal_em IS NOT NULL
                                      AND d.chave_hash IS NOT NULL) > 0 THEN 'em_operacao'
             WHEN COUNT(d.id) FILTER (WHERE d.status = 'ativo') > 0 THEN 'a_instalar'
             WHEN COUNT(d.id) FILTER (WHERE d.status = 'reparo') > 0 THEN 'em_reparo'
             ELSE 'inativo'
           END AS status
      FROM pontos p2 LEFT JOIN dispositivos d ON d.ponto_id = p2.id
     WHERE p2.status <> 'arquivado'
     GROUP BY p2.id
  ) x
 WHERE p.id = x.id AND p.status <> x.status;
