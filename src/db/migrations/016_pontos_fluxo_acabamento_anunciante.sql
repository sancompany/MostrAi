-- Vínculo do ponto com uma conta de anunciante — em vez de criar um terceiro
-- tipo de login, quem tem ponto usa a mesma conta de anunciante (que ele vai
-- precisar de qualquer jeito pra anunciar, inclusive o próprio negócio via
-- cota de autoanúncio do comodato). Só o vendedor continua com login à parte.
ALTER TABLE pontos ADD COLUMN anunciante_id int REFERENCES anunciantes(id);

-- Acabamento visual (molde de ACM) é independente do status operacional —
-- um ponto pode estar "ativo" funcionando só com a TV, sem ainda ter
-- recebido o molde. Foto real de instalação some quando o admin marca como
-- completo (upload manual, mesmo padrão de nota_fiscal_url).
ALTER TABLE pontos ADD COLUMN acabamento_completo boolean NOT NULL DEFAULT false;
ALTER TABLE pontos ADD COLUMN foto_instalacao_url text;

-- Fluxo mensal estimado, informado pelo próprio comércio no cadastro (sem
-- validação de mínimo — a triagem é o admin decidindo aprovar ou não) e
-- ajustável pelo admin depois, já que o comerciante pode super/subestimar o
-- movimento do próprio local. Nunca exposto por ponto isolado, só a soma
-- agregada de todos os pontos ativos (ver GET /pontos/fluxo).
ALTER TABLE pontos ADD COLUMN fluxo_estimado_mensal int;
