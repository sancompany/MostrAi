-- E-mail confiável (27/09/2026): fila durável de saída, código de
-- verificação guardado só como hash, e trilha de toda troca de e-mail.
--
-- Antes: cada rota chamava o SMTP na hora, "fire-and-forget". Falha de SMTP
-- (ou reinício do processo no meio) virava só uma linha de log — o primeiro
-- código de confirmação às vezes não chegava e a pessoa dependia de clicar
-- em "Reenviar". O cadastro ainda abria DUAS conexões SMTP ao mesmo tempo
-- (boas-vindas + código), competindo pelo mesmo login no Gmail.
--
-- Agora a regra de negócio só GRAVA a mensagem aqui (email_outbox) e segue;
-- um processador (src/email/outbox.js) envia, com nova tentativa e espera
-- crescente, e marca o resultado. É a porta de SAÍDA — a de entrada dos
-- webhooks é outra tabela (webhooks_recebidos, migration 096).

-- `chave`: o EVENTO DE NEGÓCIO, não a fonte — `cobranca_falhou:<chargeId>`
-- serve igual pro webhook e pra conciliação, então o mesmo aviso nunca sai
-- duas vezes. Unique: gravar de novo a mesma chave é no-op.
--
-- `destinatario` é o endereço real: sem ele o processador não entrega. Não
-- vai pra log (lá só a forma mascarada) nem pra tela operacional.
--
-- `dados`: o mínimo pra montar o texto (nome, plano, valor). NUNCA segredo.
-- `segredo`: código de verificação / link de redefinição, CIFRADO pelo cofre
-- (AES-256-GCM, src/lib/cofre.js). Apagado assim que a mensagem termina
-- (enviada, abandonada ou descartada) — e a linha inteira de mensagem com
-- segredo some em 2 dias (retenção em outbox.js).
--
-- `valido_ate`: passou disso, não adianta mais entregar (código vencido) —
-- a linha vira `descartado` em vez de mandar um código que já não vale.
CREATE TABLE email_outbox (
  id bigserial PRIMARY KEY,
  chave text NOT NULL UNIQUE,
  tipo text NOT NULL,
  classe text NOT NULL CHECK (classe IN ('critico', 'transacional', 'operacional', 'opcional')),
  destinatario text NOT NULL,
  anunciante_id int REFERENCES anunciantes(id) ON DELETE SET NULL,
  dados jsonb NOT NULL DEFAULT '{}'::jsonb,
  segredo text,
  status text NOT NULL DEFAULT 'na_fila'
    CHECK (status IN ('na_fila', 'enviando', 'enviado', 'tentando_de_novo', 'abandonado', 'descartado')),
  tentativas integer NOT NULL DEFAULT 0,
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  enviando_desde timestamptz,
  valido_ate timestamptz,
  ultimo_erro text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  enviado_em timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- O que o processador procura: na fila e na hora, ou "enviando" há tempo
-- demais (a instância que pegou morreu no meio).
CREATE INDEX email_outbox_fila ON email_outbox (proxima_tentativa_em)
  WHERE status IN ('na_fila', 'tentando_de_novo', 'enviando');
CREATE INDEX email_outbox_status ON email_outbox (status, criado_em);
-- Teto de códigos por conta por hora (conta pelas linhas daqui).
CREATE INDEX email_outbox_conta_tipo ON email_outbox (anunciante_id, tipo, criado_em);

-- Código de verificação de e-mail, versão 2. Substitui
-- tokens_confirmacao_email (061), que guardava o código em texto puro: um
-- dump do banco entregava o código de toda conta com confirmação pendente.
--   · `codigo_hash`: HMAC-SHA256 com chave do servidor (cofre.assinar) —
--     6 dígitos em SHA simples cairiam por força bruta offline em segundos;
--   · `email`: o endereço que RECEBEU o código. No cadastro é o próprio
--     login; na troca é o endereço novo, que só vira login quando o código
--     for confirmado;
--   · uma linha por conta e finalidade: pedir outro código SUBSTITUI o
--     anterior (o antigo deixa de valer na hora);
--   · `tentativas`: código errado conta aqui também (além do limite por
--     IP), e 5 erros matam o código — força bruta distribuída por vários IPs
--     não passa de 5 palpites em 1 milhão.
CREATE TABLE codigos_email (
  id bigserial PRIMARY KEY,
  anunciante_id int NOT NULL REFERENCES anunciantes(id) ON DELETE CASCADE,
  finalidade text NOT NULL CHECK (finalidade IN ('cadastro', 'troca')),
  email text NOT NULL,
  codigo_hash text NOT NULL,
  expira_em timestamptz NOT NULL,
  tentativas integer NOT NULL DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (anunciante_id, finalidade)
);

-- O código em texto puro da 061 sai já: quem estava com confirmação
-- pendente pede um novo (a tela oferece "Enviar código" quando não há
-- código valendo). A tabela em si fica até a próxima migration de limpeza —
-- durante o deploy em rolagem o processo antigo ainda escreve nela.
DELETE FROM tokens_confirmacao_email;

-- Trilha de TODA troca de e-mail de login: pelo próprio usuário (correção
-- antes de confirmar, ou troca depois de confirmar) e pelo admin. Antes o
-- admin trocava `contato_email` por um PATCH sem deixar rastro — e o e-mail
-- é o login e o único canal de recuperação de senha.
CREATE TABLE alteracoes_email (
  id bigserial PRIMARY KEY,
  anunciante_id int NOT NULL REFERENCES anunciantes(id) ON DELETE CASCADE,
  email_anterior text NOT NULL,
  email_novo text NOT NULL,
  origem text NOT NULL CHECK (origem IN ('correcao_antes_de_confirmar', 'troca_confirmada', 'admin')),
  admin_usuario text,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alteracoes_email_conta ON alteracoes_email (anunciante_id, criado_em DESC);

-- Mesma regra das outras tabelas (migrations 031/091): RLS ligada, sem
-- política — só o dono do banco (o backend) lê e escreve.
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE codigos_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE alteracoes_email ENABLE ROW LEVEL SECURITY;
