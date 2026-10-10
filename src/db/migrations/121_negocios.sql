-- 121 — Negócio ou marca por criativo (estação de 10/10/2026).
--
-- CONTA = quem administra, contrata e paga (assinatura, horas, saldo,
-- obrigação, pontos — nada disso sai da conta). NEGÓCIO = quem aparece no
-- criativo: "Academia Pizza" e "Academia Burger" anunciando pela mesma conta,
-- um login, um plano, um limite de criativos ativos. A proteção contra
-- concorrentes passa a olhar a categoria do NEGÓCIO de cada criativo, e só
-- depois que a Mostraí a validou (src/playlist/gerador.js#travaDeRamoSql).
--
-- ADITIVA: tabela nova, coluna nova no criativo, um status a mais. O código
-- antigo ignora tudo (o gatilho preenche o negócio de quem não informa).

-- ---------------------------------------------------------------------------
-- 1. Negócios
-- ---------------------------------------------------------------------------
-- `validado_em` vazio = a categoria ainda é só a palavra do cliente: nenhum
-- criativo desse negócio foi aprovado, e o gerador não confia nela. Validar é
-- aprovar um criativo do negócio (a Mostraí conferiu que a peça divulga
-- aquele negócio, daquela categoria) — ou o Admin corrigir o negócio. Depois
-- de validado, só o Admin muda nome e categoria (decisão do dono, 10/10/2026:
-- o cliente que precisar mudar cria outro negócio).
--
-- `mesmo_grupo_declarado_em`: o cliente declarou que o negócio adicional é do
-- mesmo responsável ou grupo da conta (não é revenda de vaga). O principal é
-- a própria conta e não declara nada.
CREATE TABLE negocios (
  id serial PRIMARY KEY,
  anunciante_id int NOT NULL REFERENCES anunciantes(id) ON DELETE CASCADE,
  nome text NOT NULL CHECK (btrim(nome) <> ''),
  categoria_id int REFERENCES categorias(id),
  categoria_livre text,
  principal boolean NOT NULL DEFAULT false,
  mesmo_grupo_declarado_em timestamptz,
  validado_em timestamptz,
  validado_por text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  -- Alvo da chave estrangeira composta do criativo (seção 2).
  UNIQUE (anunciante_id, id),
  CONSTRAINT negocios_adicional_declarado CHECK (principal OR mesmo_grupo_declarado_em IS NOT NULL),
  CONSTRAINT negocios_validado_com_quem CHECK ((validado_em IS NULL) = (validado_por IS NULL))
);
CREATE UNIQUE INDEX negocios_um_principal ON negocios (anunciante_id) WHERE principal;
-- O mesmo nome duas vezes na conta é o mesmo negócio — o envio reaproveita.
CREATE UNIQUE INDEX negocios_nome_na_conta ON negocios (anunciante_id, lower(btrim(nome)));
CREATE INDEX negocios_categoria ON negocios (categoria_id);
-- Fora do alcance da API pública do Supabase, como toda tabela do projeto
-- (só o servidor, com a conexão própria, lê e grava).
ALTER TABLE negocios ENABLE ROW LEVEL SECURITY;

-- Backfill pelo SIGNIFICADO (nunca por id): toda conta ganha o negócio
-- principal com o nome e a categoria que ela já tem. Nasce validado só onde
-- já existia peça que passou pela aprovação da Mostraí (aprovada ou tirada do
-- ar depois de aprovada) — é o comportamento de hoje, preservado. O resto
-- valida na primeira aprovação.
INSERT INTO negocios (anunciante_id, nome, categoria_id, categoria_livre, principal, validado_em, validado_por)
SELECT a.id, a.nome_empresa, a.categoria_id, a.categoria_livre, true, v.em, v.por
  FROM anunciantes a
  LEFT JOIN LATERAL (
    SELECT now() AS em, 'migração 121: conta já tinha criativo aprovado' AS por
     WHERE EXISTS (SELECT 1 FROM criativos c WHERE c.anunciante_id = a.id AND c.status IN ('aprovado', 'retirado'))
  ) v ON true
 WHERE btrim(a.nome_empresa) <> '';

-- Conta sem nome (não deveria existir: nome_empresa é obrigatório no
-- cadastro) não fica sem principal — o criativo dela precisa de um negócio.
INSERT INTO negocios (anunciante_id, nome, categoria_id, categoria_livre, principal)
SELECT a.id, 'Negócio principal', a.categoria_id, a.categoria_livre, true
  FROM anunciantes a
 WHERE NOT EXISTS (SELECT 1 FROM negocios n WHERE n.anunciante_id = a.id AND n.principal);

-- O principal de uma conta, criado na hora se ainda não existe (conta criada
-- depois desta migration). Copia o cadastro da conta; não valida.
CREATE FUNCTION negocio_principal(conta int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  achado int;
BEGIN
  SELECT id INTO achado FROM negocios WHERE anunciante_id = conta AND principal;
  IF achado IS NOT NULL THEN
    RETURN achado;
  END IF;
  INSERT INTO negocios (anunciante_id, nome, categoria_id, categoria_livre, principal)
  SELECT a.id, COALESCE(NULLIF(btrim(a.nome_empresa), ''), 'Negócio principal'), a.categoria_id, a.categoria_livre, true
    FROM anunciantes a WHERE a.id = conta
  ON CONFLICT (anunciante_id) WHERE principal DO NOTHING;
  SELECT id INTO achado FROM negocios WHERE anunciante_id = conta AND principal;
  RETURN achado;
END $$;

-- O principal AINDA NÃO VALIDADO acompanha o cadastro da conta: nada confiava
-- nele, e é o que o cliente vê como "o meu negócio". Validado, fica com o
-- que a Mostraí conferiu — mudar o perfil da conta não mexe no anúncio.
CREATE FUNCTION negocio_principal_acompanha_conta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- O nome só acompanha se não colidir com outro negócio da conta (o
  -- cadastro renomeado para "Academia Pizza", que já é um negócio adicional,
  -- não pode derrubar a edição do perfil).
  UPDATE negocios n
     SET nome = CASE WHEN btrim(NEW.nome_empresa) <> '' AND NOT EXISTS (
                       SELECT 1 FROM negocios o
                        WHERE o.anunciante_id = n.anunciante_id AND o.id <> n.id
                          AND lower(btrim(o.nome)) = lower(btrim(NEW.nome_empresa)))
                     THEN NEW.nome_empresa ELSE n.nome END,
         categoria_id = NEW.categoria_id,
         categoria_livre = NEW.categoria_livre
   WHERE n.anunciante_id = NEW.id AND n.principal AND n.validado_em IS NULL;
  RETURN NULL;
END $$;

CREATE TRIGGER negocio_principal_acompanha_conta
  AFTER UPDATE OF nome_empresa, categoria_id, categoria_livre ON anunciantes
  FOR EACH ROW
  WHEN ((OLD.nome_empresa, OLD.categoria_id, OLD.categoria_livre)
        IS DISTINCT FROM (NEW.nome_empresa, NEW.categoria_id, NEW.categoria_livre))
  EXECUTE FUNCTION negocio_principal_acompanha_conta();

-- ---------------------------------------------------------------------------
-- 2. Criativo → negócio
-- ---------------------------------------------------------------------------
-- Chave estrangeira COMPOSTA (conta, negócio): o banco recusa ligar o
-- criativo a um negócio de outra conta, seja qual for a rota. Sem ON DELETE:
-- negócio com criativo não se apaga.
ALTER TABLE criativos ADD COLUMN negocio_id int;

UPDATE criativos c
   SET negocio_id = n.id
  FROM negocios n
 WHERE n.anunciante_id = c.anunciante_id AND n.principal;

ALTER TABLE criativos ALTER COLUMN negocio_id SET NOT NULL;
ALTER TABLE criativos
  ADD CONSTRAINT criativos_negocio_da_conta FOREIGN KEY (anunciante_id, negocio_id) REFERENCES negocios (anunciante_id, id);
CREATE INDEX criativos_negocio ON criativos (negocio_id);

-- Quem cria criativo sem dizer o negócio (Mídia Mostraí, upload do Admin,
-- scripts) usa o principal da conta — o mesmo que a tela de envio já deixa
-- marcado.
CREATE FUNCTION criativo_negocio_padrao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.negocio_id IS NULL THEN
    NEW.negocio_id := negocio_principal(NEW.anunciante_id);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER criativo_negocio_padrao
  BEFORE INSERT ON criativos
  FOR EACH ROW EXECUTE FUNCTION criativo_negocio_padrao();

-- "Correção necessária": a Mostraí devolveu a peça ao cliente (negócio ou
-- categoria não batem com o que a peça divulga). Não veicula, ocupa a vaga
-- do plano como a peça em análise, e na obrigação é responsabilidade do
-- cliente, como a recusada (decisão do dono, 10/10/2026 —
-- src/bancohoras/obrigacao-do-ciclo.js#motivoDeIndisponibilidadeDoCliente
-- não a conta como "em análise").
ALTER TABLE criativos DROP CONSTRAINT criativos_status_check;
ALTER TABLE criativos ADD CONSTRAINT criativos_status_check
  CHECK (status IN ('pendente', 'aprovado', 'reprovado', 'retirado', 'correcao'));

-- ---------------------------------------------------------------------------
-- 3. Auditoria da validação
-- ---------------------------------------------------------------------------
-- Toda validação e toda mudança feita pelo Admin: o que o cliente declarou,
-- o que ficou, quem, quando e por quê. Nome da categoria guardado junto (e
-- sem chave estrangeira): o histórico sobrevive a mesclar ou apagar categoria.
CREATE TABLE negocios_validacoes (
  id serial PRIMARY KEY,
  negocio_id int NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  criativo_id int REFERENCES criativos(id) ON DELETE SET NULL,
  acao text NOT NULL CHECK (acao IN ('validado', 'categoria_corrigida', 'editado_pelo_admin')),
  nome_antes text,
  nome_depois text,
  categoria_antes_id int,
  categoria_antes_nome text,
  categoria_livre_antes text,
  categoria_depois_id int,
  categoria_depois_nome text,
  motivo text,
  operador text NOT NULL,
  operador_access text,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX negocios_validacoes_negocio ON negocios_validacoes (negocio_id, criado_em);
ALTER TABLE negocios_validacoes ENABLE ROW LEVEL SECURITY;

-- Rede de segurança: criativo aprovado por qualquer caminho (fila do Admin,
-- upload do operador, mídia própria, script) deixa o negócio validado — o
-- gerador nunca encontra peça aprovada de negócio sem validação. As rotas do
-- Admin validam antes, com o operador; este gatilho só age quando ninguém
-- validou, e registra isso.
CREATE FUNCTION validar_negocio_na_aprovacao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'aprovado' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'aprovado') THEN
    WITH validado AS (
      UPDATE negocios SET validado_em = now(), validado_por = 'sistema'
       WHERE id = NEW.negocio_id AND validado_em IS NULL
      RETURNING id, nome, categoria_id, categoria_livre
    )
    INSERT INTO negocios_validacoes (negocio_id, criativo_id, acao, nome_antes, nome_depois, categoria_antes_id,
                                     categoria_antes_nome, categoria_livre_antes, categoria_depois_id,
                                     categoria_depois_nome, motivo, operador)
    SELECT v.id, NEW.id, 'validado', v.nome, v.nome, v.categoria_id, k.nome, v.categoria_livre, v.categoria_id, k.nome,
           'criativo aprovado sem validação explícita do negócio', 'sistema'
      FROM validado v LEFT JOIN categorias k ON k.id = v.categoria_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER criativos_validar_negocio
  AFTER INSERT OR UPDATE OF status ON criativos
  FOR EACH ROW EXECUTE FUNCTION validar_negocio_na_aprovacao();

-- ---------------------------------------------------------------------------
-- 4. Playlist desatualizada (migration 083/117)
-- ---------------------------------------------------------------------------
-- Trocar o negócio de um criativo, ou a categoria/validação de um negócio,
-- muda quem pode aparecer em cada tela.
DROP TRIGGER IF EXISTS playlist_desatualizada ON criativos;
CREATE TRIGGER playlist_desatualizada AFTER UPDATE ON criativos
  FOR EACH ROW WHEN ((OLD.status, OLD.anunciante_id, OLD.arquivo_normalizado_url, OLD.duracao_segundos, OLD.conteudo_sha256,
                      OLD.negocio_id)
                     IS DISTINCT FROM
                     (NEW.status, NEW.anunciante_id, NEW.arquivo_normalizado_url, NEW.duracao_segundos, NEW.conteudo_sha256,
                      NEW.negocio_id))
  EXECUTE FUNCTION marcar_playlists_desatualizadas();

CREATE TRIGGER playlist_desatualizada AFTER UPDATE ON negocios
  FOR EACH ROW WHEN ((OLD.categoria_id, OLD.validado_em) IS DISTINCT FROM (NEW.categoria_id, NEW.validado_em))
  EXECUTE FUNCTION marcar_playlists_desatualizadas();
