-- Libera os planos mensais (sem compromisso) e trava as chamadas
-- combinadas como "preço fundador" — mesmo id, mesmo valor, o admin cria
-- um plano NOVO (POST /admin/planos) em vez de editar este quando quiser
-- mudar preço pra clientes futuros, então quem já assinou aqui mantém a
-- tarifa (ver src/financeiro/planos-repository.js).
UPDATE planos SET ativo = true WHERE compromisso_meses = 1;

ALTER TABLE planos ADD COLUMN rotulo text;
UPDATE planos SET rotulo = 'Preço fundador — nunca muda' WHERE compromisso_meses <> 1;

-- Limite de criativos simultâneos por plano (enforcement em
-- src/anunciantes/routes.js — a rotação entre eles na playlist ainda não
-- existe, ver src/playlist/gerador.js, que hoje só pega o mais recente
-- aprovado; fica pra uma próxima rodada dedicada ao gerador).
ALTER TABLE planos ADD COLUMN limite_criativos int NOT NULL DEFAULT 1;
UPDATE planos SET limite_criativos = 1 WHERE tier = 'essencial';
UPDATE planos SET limite_criativos = 2 WHERE tier = 'destaque';
UPDATE planos SET limite_criativos = 3 WHERE tier = 'maximo';

UPDATE planos SET beneficios = ARRAY[
  'Alcança 100% dos pontos ativos',
  'Painel com exibições confirmadas',
  'Até 1 criativo ativo por vez',
  'Upload ilimitado de novas versões'
] WHERE tier = 'essencial';

UPDATE planos SET beneficios = ARRAY[
  'Tudo do Essencial',
  'O dobro de frequência de exibição',
  'Até 2 criativos ativos, revezando entre si',
  'Melhor custo por exibição'
] WHERE tier = 'destaque';

UPDATE planos SET beneficios = ARRAY[
  'Tudo do Destaque',
  'Prioridade em horário de pico',
  'Até 3 criativos ativos, revezando entre si',
  'Cobertura máxima da rede'
] WHERE tier = 'maximo';
