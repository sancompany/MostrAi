-- Benefícios e destaque editáveis pelo admin (antes hardcoded no front) +
-- foto de perfil do anunciante (self-service, ver src/anunciantes/routes.js).
ALTER TABLE planos ADD COLUMN beneficios text[] NOT NULL DEFAULT '{}';
ALTER TABLE planos ADD COLUMN destaque_no_site boolean NOT NULL DEFAULT false;

UPDATE planos SET beneficios = ARRAY['Alcança 100% dos pontos ativos', 'Painel com exibições confirmadas', 'Upload de criativo ilimitado'] WHERE tier = 'essencial';
UPDATE planos SET beneficios = ARRAY['Tudo do Essencial', 'O dobro de frequência de exibição', 'Melhor custo por exibição'] WHERE tier = 'destaque';
UPDATE planos SET beneficios = ARRAY['Tudo do Destaque', 'Prioridade em horário de pico', 'Cobertura máxima da rede'] WHERE tier = 'maximo';
UPDATE planos SET destaque_no_site = true WHERE tier = 'destaque' AND compromisso_meses <> 1;

ALTER TABLE anunciantes ADD COLUMN foto_url text;
