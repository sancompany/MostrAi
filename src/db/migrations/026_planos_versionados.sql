-- Plano assinado é imutável pra quem assinou (item 9 da spec).
--
-- Por quê: hoje `PATCH /admin/planos/:id` edita a linha no lugar. O checkout
-- congela `valor` e `ciclo` na criação da assinatura e nunca reconsulta o
-- plano (API.md 4.2) — então essa metade já estava protegida. A outra metade
-- não: nome, benefícios, `limite_criativos`, `frequencia_dia` e `cobertura`
-- o Mostraí lê AO VIVO, toda vez que monta o painel e toda vez que gera
-- playlist. Baixar o `limite_criativos` de 3 pra 2 no admin derrubaria o
-- terceiro criativo de quem pagou por três, sem aviso e sem registro.
--
-- A partir daqui, editar campo de contrato não altera o plano: cria uma
-- VERSÃO NOVA, com id novo, e aposenta a anterior. Id novo é obrigatório, não
-- estético — o checkout guarda a assinatura pela chave `planoId` + `documento`
-- (API.md 4.2), e duas versões com o mesmo id tornariam cancelamento e
-- conciliação ambíguos.
--
-- ADITIVA. Não altera nem apaga nada.

-- Quando a versão foi aposentada. Nulo = versão viva. Aposentada nunca volta
-- pra vitrine e não aceita assinante novo, mas continua existindo e cobrando
-- igual pra quem já está nela — é exatamente o ponto.
ALTER TABLE planos ADD COLUMN arquivado_em timestamptz;

-- Qual versão substituiu esta. Sem isso, seis meses e três edições depois não
-- dá pra dizer que `essencial-12m` virou `essencial-12m-v2` virou `-v3`, e a
-- pergunta "posso apagar esta?" fica sem resposta.
ALTER TABLE planos ADD COLUMN substituido_por text REFERENCES planos(id);

-- Aposentado nunca é ativo. A vitrine já filtra por `ativo`, e o teto de 3
-- por ciclo também — esta regra existe pra que nenhum caminho futuro
-- reative uma versão aposentada por engano.
ALTER TABLE planos ADD CONSTRAINT planos_arquivado_nao_ativo
  CHECK (arquivado_em IS NULL OR NOT ativo);
