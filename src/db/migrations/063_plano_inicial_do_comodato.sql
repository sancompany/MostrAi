-- Plano Inicial: quinto degrau da escada de planos (pedido do dono,
-- 19/09/2026, especificação final depois de várias rodadas). Hoje o
-- comodato só tem duas modalidades — "recebe R$ 50" e "troca R$ 50 por
-- tela" (planos_ponto, migration 015/049) — e a segunda dá o Essencial
-- inteiro de graça (essencial-1m, via planos_ponto.mais-cota.plano_incluido_id).
-- O dono quer dois planos de comodato, não um: quem recebe os R$ 50 tem
-- direito a UM anúncio mínimo na própria tela dele; quem troca o dinheiro
-- por tela sobe pro que hoje já existe como `comodato-basico` ("Plano
-- Básico") — que por acaso já bate exatamente com o que o dono descreveu
-- pra esse degrau (45s/hora, 3 pontos, 15s de duração, 1 criativo), então
-- não precisa de plano novo ali, só repontar quem recebe o quê.
--
-- `ativo = false`, mesmo motivo de `comodato-basico`: não aparece em
-- GET /planos (listarAtivos em src/financeiro/planos-repository.js),
-- porque não é assinável — só chega numa conta via `ajustarPlanoIncluido`
-- (src/pontos/comodato.js), nunca por compra direta.
--
-- `cobertura = 'todos_pontos'` segue o mesmo valor de TODA linha existente
-- em `planos` hoje (checado antes de escrever esta migration) — a coluna
-- ficou congelada nesse valor desde que `pontos_incluidos` assumiu o papel
-- dela (migration 045) e nenhum código lê `planos.cobertura` em runtime.
-- `frequencia_hora = 1` pelo mesmo motivo: coluna legada, só consultada por
-- `quantasInsercoes()` (src/playlist/gerador.js) como fallback quando
-- `segundos_por_hora <= 0`, o que nunca é o caso aqui (60).
INSERT INTO planos (
  id, tier, nome, valor_mensal, valor_mensal_cheio, compromisso_meses,
  frequencia_hora, segundos_por_hora, duracao_maxima_segundos,
  pontos_incluidos, cobertura, ativo, destaque_no_site, rotulo,
  limite_criativos, fundador
) VALUES (
  'inicial-1m', 'essencial', 'Plano Inicial', 0, NULL, 1,
  1, 60, 15,
  1, 'todos_pontos', false, false, 'Seu primeiro anúncio, na sua própria tela.',
  1, false
);

-- As duas modalidades de comodato sobem um degrau cada: quem recebe R$ 50
-- ganha o Plano Inicial (era o Básico inteiro, que agora fica reservado pra
-- quem troca o dinheiro por tela); quem troca por tela ganha o Básico (era
-- o Essencial inteiro). Nenhum UPDATE em `anunciantes` aqui de propósito —
-- mudar o catálogo não deve tocar sozinho em conta nenhuma; quem já tem um
-- plano incluído aplicado só muda na próxima vez que a modalidade for
-- reaplicada, e passa pelo guard de `ajustarPlanoIncluido` normalmente.
UPDATE planos_ponto SET plano_incluido_id = 'inicial-1m' WHERE id = 'ajuda-custo';
UPDATE planos_ponto SET plano_incluido_id = 'comodato-basico' WHERE id = 'mais-cota';
