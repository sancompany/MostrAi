CREATE TABLE exibicoes_contador (
  id serial PRIMARY KEY,
  anunciante_id int NOT NULL REFERENCES anunciantes(id),
  ponto_id int NOT NULL REFERENCES pontos(id),
  janela_hora timestamptz NOT NULL,
  vezes_programadas int NOT NULL DEFAULT 0,
  vezes_confirmadas int NOT NULL DEFAULT 0,
  UNIQUE (anunciante_id, ponto_id, janela_hora)
);
