-- Tabela de eventos da métrica (seção 9 do docs/funcional.md).
--
-- Por quê: a métrica principal do projeto é a margem mensal real, e hoje ela
-- só existe como consulta do admin sobre o estado ATUAL. Estado atual não
-- responde "quanto tempo a fila de aprovação leva", "quantos chegam ao
-- checkout e não pagam" nem "quem sai, e depois de quanto tempo" — perguntas
-- que precisam do instante em que a coisa aconteceu, e que se perdem pra
-- sempre se ninguém anotar na hora.
--
-- Os nomes dos eventos foram fixados na Estação 4, antes desta primeira linha
-- de instrumentação. Nada aqui inventa nome novo.
--
-- ADITIVA.

CREATE TABLE eventos (
  id bigserial PRIMARY KEY,
  -- Convenção `categoria:objeto_acao`, verbo no presente (funcional.md §9).
  nome text NOT NULL,
  -- O funcional diz `usuario_id`; aqui é `anunciante_id` porque é essa a
  -- tabela de gente do sistema — anunciante, dono de ponto e vendedor são
  -- papéis da mesma conta. Nulo em evento que não tem dono (ainda não há,
  -- mas candidatura pública teria).
  anunciante_id integer REFERENCES anunciantes(id),
  propriedades jsonb NOT NULL DEFAULT '{}',
  -- O dono testando não pode virar métrica. Sem esta coluna, o primeiro mês
  -- de número seria o dono clicando no próprio sistema, e ninguém lembraria
  -- disso ao ler o gráfico seis meses depois.
  interno boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- As consultas salvas são todas "este evento, nesta janela de tempo".
CREATE INDEX idx_eventos_nome_criado ON eventos (nome, criado_em DESC);
-- "Tudo que esta conta fez" — funil por conta e exportação do titular.
CREATE INDEX idx_eventos_anunciante ON eventos (anunciante_id) WHERE anunciante_id IS NOT NULL;
