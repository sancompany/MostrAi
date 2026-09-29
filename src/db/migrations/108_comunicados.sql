-- Comunicados por e-mail (Admin → Visão geral, 29/09/2026): o admin escreve
-- um aviso da plataforma (manutenção, mudança de funcionamento, novidade do
-- serviço) e ele sai para um público de contas.
--
-- NÃO é um segundo sistema de e-mail: cada destinatário vira UMA linha na
-- fila que já existe (email_outbox, migration 097, tipo 'comunicado'), com o
-- mesmo processador, o mesmo SMTP, o mesmo template e as mesmas tentativas.
-- Uma mensagem por pessoa, com só o endereço dela no "Para" — ninguém vê
-- quem mais recebeu. Estas tabelas guardam o que a fila não guarda: o texto
-- (uma vez só, não copiado em cada linha), quem mandou, e o resultado de
-- cada destinatário depois que a fila expurga as linhas (30/90 dias).
--
-- ADITIVA e compatível com o código antigo: só cria tabelas novas. Nenhuma
-- coluna, tabela ou dado existente muda — o deploy em rolagem com o
-- processo antigo no ar não quebra nada (ele nunca lê estas tabelas, e o
-- tipo 'comunicado' só nasce pelas rotas novas).

-- `chave_idempotencia`: a chave que o navegador manda (Idempotency-Key) no
-- clique de "Enviar comunicado". Duplo clique, tempo esgotado e nova
-- tentativa da MESMA confirmação chegam com a mesma chave e devolvem o
-- comunicado já criado — nunca um segundo envio.
-- `impressao`: SHA-256 do público + conteúdo normalizado. Recarregar a
-- página perde a chave do navegador; a impressão pega o mesmo comunicado
-- mandado de novo para o mesmo público em 24 h (src/comunicados/repository.js).
-- `previstos`: quantos destinatários o envio teve na hora — o número que o
-- admin confirmou (> 0: público vazio nunca vira comunicado).
-- `criado_por`: o usuário da sessão do admin (req.session.adminUsuario),
-- como em planos_administrativos e alteracoes_email.
CREATE TABLE comunicados (
  id bigserial PRIMARY KEY,
  chave_idempotencia text NOT NULL UNIQUE,
  impressao text NOT NULL,
  publico text NOT NULL CHECK (publico IN ('todas', 'com_plano', 'sem_plano', 'donos_de_ponto')),
  assunto text NOT NULL,
  titulo text NOT NULL,
  mensagem text NOT NULL,
  botao_texto text,
  botao_url text,
  previstos integer NOT NULL CHECK (previstos > 0),
  criado_por text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CHECK ((botao_texto IS NULL) = (botao_url IS NULL))
);
CREATE INDEX comunicados_recentes ON comunicados (criado_em DESC);
CREATE INDEX comunicados_impressao ON comunicados (impressao, criado_em DESC);

-- Um destinatário por conta e comunicado (a chave primária impede a mesma
-- conta duas vezes no mesmo envio). O ENDEREÇO não é copiado aqui: ele está
-- na linha da fila enquanto ela existe, e a conta é a referência depois.
-- `email_outbox_id`: a linha da fila da rodada ATUAL (sem FK — a outbox
-- expurga as dela). `rodada` sobe a cada "Reenviar falhas": a chave da fila
-- muda junto, e só quem falhou volta pra fila.
-- `situacao`: na_fila → enviado | falhou | descartado (a conta saiu do
-- público antes da vez dela: excluída, suspensa, pediu pra não receber ou
-- trocou de e-mail). `ultimo_erro` já vem sanitizado (sem endereço).
-- ON DELETE CASCADE na conta: apagar uma conta não pode travar por causa
-- de um aviso que ela recebeu.
CREATE TABLE comunicados_destinatarios (
  comunicado_id bigint NOT NULL REFERENCES comunicados(id) ON DELETE CASCADE,
  anunciante_id integer NOT NULL REFERENCES anunciantes(id) ON DELETE CASCADE,
  email_outbox_id bigint,
  rodada integer NOT NULL DEFAULT 1,
  situacao text NOT NULL DEFAULT 'na_fila' CHECK (situacao IN ('na_fila', 'enviado', 'falhou', 'descartado')),
  ultimo_erro text,
  enviado_em timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comunicado_id, anunciante_id)
);
CREATE INDEX comunicados_destinatarios_situacao ON comunicados_destinatarios (comunicado_id, situacao);
-- Apagar uma conta leva os registros dela (ON DELETE CASCADE): sem índice na
-- conta, o apagamento varreria a tabela inteira.
CREATE INDEX comunicados_destinatarios_conta ON comunicados_destinatarios (anunciante_id);
-- O que o expurgo da fila consolida antes de apagar (src/comunicados/envio.js
-- #consolidar): só os que ainda dizem "na_fila".
CREATE INDEX comunicados_destinatarios_pendentes ON comunicados_destinatarios (email_outbox_id)
  WHERE situacao = 'na_fila';

-- Trilha de cada "Reenviar falhas": quem, quando e para quantos.
CREATE TABLE comunicados_reenvios (
  id bigserial PRIMARY KEY,
  comunicado_id bigint NOT NULL REFERENCES comunicados(id) ON DELETE CASCADE,
  quantidade integer NOT NULL CHECK (quantidade > 0),
  criado_por text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comunicados_reenvios_comunicado ON comunicados_reenvios (comunicado_id, criado_em);

-- Mesma regra das outras tabelas (migrations 031/091): RLS ligada, sem
-- política — só o dono do banco (o backend) lê e escreve.
ALTER TABLE comunicados ENABLE ROW LEVEL SECURITY;
ALTER TABLE comunicados_destinatarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE comunicados_reenvios ENABLE ROW LEVEL SECURITY;
