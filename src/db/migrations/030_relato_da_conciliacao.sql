-- Relato de cada execução da conciliação diária.
--
-- Por quê: a conciliação é o que salva quem pagou e não recebeu cobertura
-- quando o webhook se perde — e o resultado dela só existia no stdout do
-- processo. Ninguém sabia se ela rodou hoje, quantas assinaturas ela olhou,
-- se alguma falhou e qual. Com o cron ainda por configurar no Northflank, a
-- pergunta "ela está rodando?" não tinha onde ser respondida.
--
-- Aditiva: tabela nova.
CREATE TABLE conciliacoes (
  id serial PRIMARY KEY,
  comecou_em timestamptz NOT NULL,
  terminou_em timestamptz NOT NULL DEFAULT now(),
  verificadas int NOT NULL DEFAULT 0,
  aplicadas int NOT NULL DEFAULT 0,
  ja_processadas int NOT NULL DEFAULT 0,
  sem_cobranca int NOT NULL DEFAULT 0,
  expiradas int NOT NULL DEFAULT 0,
  -- lista de { assinaturaId, erro } — o que falhou, pra não precisar do log
  falhas jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- erro que abortou a execução inteira (diferente de falha por assinatura)
  abortou text
);
