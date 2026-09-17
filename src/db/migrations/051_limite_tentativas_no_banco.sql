-- O LIMITADOR DE TENTATIVAS SAI DA MEMÓRIA DO PROCESSO, pra o serviço poder
-- rodar em mais de uma instância (item 4 de docs/PENDENCIAS.md; o dono avisou
-- em 17/09/2026 que sobe pra duas antes do lançamento).
--
-- Em memória, o limite se multiplica pelo número de instâncias sem ninguém
-- perceber: com duas, o atacante tem 20 tentativas em vez de 10, porque o
-- balanceador distribui as requisições e cada processo conta as suas. E o
-- contador some a cada deploy, que é um por dia nesta fase.
--
-- Isso protege `/admin/login` (senha do dono), `/anunciantes/login`, o PIN de
-- 4 dígitos do player e o cadastro (que dava pra varrer por e-mail pelo 409).
-- Nenhum deles pode ter o teto dobrado em silêncio.
--
-- `chave` é `ip:rota`, o mesmo formato de antes. `desde` é o início da janela;
-- a limpeza das linhas velhas é oportunista, no próprio caminho da requisição,
-- pra não depender de job (que é mais uma peça pra manter viva).

CREATE TABLE tentativas_acesso (
  chave text PRIMARY KEY,
  quantidade int NOT NULL DEFAULT 1,
  desde timestamptz NOT NULL DEFAULT now()
);

-- A limpeza varre por `desde`, nunca pela chave.
CREATE INDEX tentativas_acesso_desde ON tentativas_acesso (desde);
