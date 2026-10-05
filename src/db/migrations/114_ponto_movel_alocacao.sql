-- Ponto Móvel V1.1 (05/10/2026, pedido do dono): o móvel NÃO tem base.
--
-- É equipamento itinerante da Mostraí. Só ganha local, contexto comercial,
-- horário e lugar no inventário quando está ALOCADO — uma hospedagem ativa ou
-- um evento em andamento, com período (data E hora) e horário de
-- funcionamento definidos pelo Admin. Sem alocação: nenhum local, nenhum
-- ramo, nenhuma casa, nenhum horário comercial, fora de todo inventário (a
-- tela, se ligada, toca o institucional).
--
-- Aditiva: nada é apagado. `base_*` e `pontos_moveis_bases` ficam como
-- histórico (deprecated — nenhum código lê para decidir nada). A 113 não foi
-- editada; produção estava com 0 pontos móveis quando esta foi escrita.

-- ---------------------------------------------------------------------------
-- 1. Ponto móvel sem base e sem endereço próprio
-- ---------------------------------------------------------------------------
-- Continua: sem dono, sem candidatura, com número. A base deixa de ser
-- exigida; o ponto fixo continua sem nenhum campo de base.
ALTER TABLE pontos DROP CONSTRAINT IF EXISTS pontos_movel_coerente;
ALTER TABLE pontos ADD CONSTRAINT pontos_movel_coerente CHECK (
  (tipo = 'fixo' AND base_conta_id IS NULL AND base_nome IS NULL AND base_desde IS NULL)
  OR (tipo = 'movel' AND anunciante_id IS NULL AND candidatura_id IS NULL AND movel_numero IS NOT NULL)
);
COMMENT ON COLUMN pontos.base_conta_id IS 'DEPRECATED (migration 114): o ponto móvel não tem base. Só histórico.';
COMMENT ON COLUMN pontos.base_nome IS 'DEPRECATED (migration 114): o ponto móvel não tem base. Só histórico.';
COMMENT ON COLUMN pontos.base_desde IS 'DEPRECATED (migration 114): o ponto móvel não tem base. Só histórico.';
COMMENT ON TABLE pontos_moveis_bases IS 'DEPRECATED (migration 114): histórico de bases do modelo antigo. Nada novo entra aqui.';

-- O endereço do móvel é o da ALOCAÇÃO (hospedagem/evento), não do ponto: o
-- equipamento parado não está comercialmente em lugar nenhum. O ponto fixo
-- continua com endereço obrigatório (agora por CHECK, não por NOT NULL).
ALTER TABLE pontos ALTER COLUMN endereco DROP NOT NULL;
ALTER TABLE pontos ALTER COLUMN cidade DROP NOT NULL;
ALTER TABLE pontos ALTER COLUMN uf DROP NOT NULL;
ALTER TABLE pontos ALTER COLUMN cep DROP NOT NULL;
ALTER TABLE pontos ADD CONSTRAINT pontos_endereco_do_fixo CHECK (
  tipo = 'movel' OR (endereco IS NOT NULL AND cidade IS NOT NULL AND uf IS NOT NULL AND cep IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 2. Alocação com data E hora, e horário de funcionamento próprio
-- ---------------------------------------------------------------------------
-- `inicio`/`fim`: o período previsto, instantes (o Admin informa no horário de
-- Matão). `horario_operacao`: o horário de funcionamento DENTRO do período, no
-- mesmo formato de `pontos.horario_semanal` (o que vira `config.operacao`
-- para a TV). Só ali a tela é inventário e só ali o tempo vale benefício.
-- NULL só nas linhas antigas (sem restrição de horário, como eram).
-- `data_inicio`/`data_fim` continuam (compatibilidade), derivadas do período.
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN inicio timestamptz;
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN fim timestamptz;
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN horario_operacao jsonb;
-- Observação do agendamento (o Admin escreve; nunca sai para o anunciante).
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN observacao text
  CHECK (observacao IS NULL OR char_length(observacao) <= 500);
ALTER TABLE pontos_moveis_eventos ADD COLUMN inicio timestamptz;
ALTER TABLE pontos_moveis_eventos ADD COLUMN fim timestamptz;
ALTER TABLE pontos_moveis_eventos ADD COLUMN horario_operacao jsonb;

-- Backfill: o período antigo era de dias inteiros (inclusivos) em Matão.
-- A hospedagem encerrada não muda (gatilho): o backfill passa com ele
-- desligado só nesta transação.
ALTER TABLE pontos_moveis_hospedagens DISABLE TRIGGER hospedagem_final_imutavel;
UPDATE pontos_moveis_hospedagens
   SET inicio = (data_inicio::timestamp AT TIME ZONE 'America/Sao_Paulo'),
       fim = ((data_fim + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo');
ALTER TABLE pontos_moveis_hospedagens ENABLE TRIGGER hospedagem_final_imutavel;
UPDATE pontos_moveis_eventos
   SET inicio = (data_inicio::timestamp AT TIME ZONE 'America/Sao_Paulo'),
       fim = ((data_fim + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo');

ALTER TABLE pontos_moveis_hospedagens ALTER COLUMN inicio SET NOT NULL;
ALTER TABLE pontos_moveis_hospedagens ALTER COLUMN fim SET NOT NULL;
ALTER TABLE pontos_moveis_hospedagens ADD CONSTRAINT pontos_moveis_hospedagens_periodo_check CHECK (fim > inicio);
ALTER TABLE pontos_moveis_hospedagens ADD CONSTRAINT pontos_moveis_hospedagens_horario_check
  CHECK (horario_operacao IS NULL OR jsonb_typeof(horario_operacao) = 'object');
ALTER TABLE pontos_moveis_eventos ALTER COLUMN inicio SET NOT NULL;
ALTER TABLE pontos_moveis_eventos ALTER COLUMN fim SET NOT NULL;
ALTER TABLE pontos_moveis_eventos ADD CONSTRAINT pontos_moveis_eventos_periodo_check CHECK (fim > inicio);
ALTER TABLE pontos_moveis_eventos ADD CONSTRAINT pontos_moveis_eventos_horario_check
  CHECK (horario_operacao IS NULL OR jsonb_typeof(horario_operacao) = 'object');

-- Agenda única, agora por instante: [inicio, fim) de um compromisso não pode
-- cruzar o de outro (hospedagem × hospedagem, hospedagem × evento, evento ×
-- evento), e dois em curso nunca coexistem. Mesma trava da 113 (linha do
-- ponto), mesmo código de erro (src/pontos/agenda.js traduz).
CREATE OR REPLACE FUNCTION movel_agenda_verificar() RETURNS trigger AS $$
DECLARE
  ocupa boolean;
  em_curso boolean;
  eh_hospedagem boolean := TG_TABLE_NAME = 'pontos_moveis_hospedagens';
BEGIN
  ocupa := NEW.estado IN ('programada', 'ativa', 'programado', 'em_andamento');
  IF NOT ocupa THEN
    RETURN NEW;
  END IF;
  em_curso := NEW.estado IN ('ativa', 'em_andamento');
  PERFORM 1 FROM pontos WHERE id = NEW.ponto_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM pontos_moveis_hospedagens h
     WHERE h.ponto_id = NEW.ponto_id AND h.estado IN ('programada', 'ativa')
       AND NOT (eh_hospedagem AND h.id = NEW.id)
       AND (tstzrange(h.inicio, h.fim, '[)') && tstzrange(NEW.inicio, NEW.fim, '[)')
            OR (em_curso AND h.estado = 'ativa'))
  ) OR EXISTS (
    SELECT 1 FROM pontos_moveis_eventos e
     WHERE e.ponto_id = NEW.ponto_id AND e.estado IN ('programado', 'em_andamento')
       AND NOT (NOT eh_hospedagem AND e.id = NEW.id)
       AND (tstzrange(e.inicio, e.fim, '[)') && tstzrange(NEW.inicio, NEW.fim, '[)')
            OR (em_curso AND e.estado = 'em_andamento'))
  ) THEN
    RAISE EXCEPTION 'agenda do ponto móvel % ocupada nesse período', NEW.ponto_id
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS movel_agenda_hospedagens ON pontos_moveis_hospedagens;
CREATE TRIGGER movel_agenda_hospedagens BEFORE INSERT OR UPDATE OF estado, inicio, fim
  ON pontos_moveis_hospedagens FOR EACH ROW EXECUTE FUNCTION movel_agenda_verificar();
DROP TRIGGER IF EXISTS movel_agenda_eventos ON pontos_moveis_eventos;
CREATE TRIGGER movel_agenda_eventos BEFORE INSERT OR UPDATE OF estado, inicio, fim
  ON pontos_moveis_eventos FOR EACH ROW EXECUTE FUNCTION movel_agenda_verificar();

CREATE INDEX ix_pontos_moveis_hospedagens_fim ON pontos_moveis_hospedagens (fim) WHERE estado IN ('programada', 'ativa');
CREATE INDEX ix_pontos_moveis_eventos_fim ON pontos_moveis_eventos (fim) WHERE estado IN ('programado', 'em_andamento');

-- ---------------------------------------------------------------------------
-- 3. Interesse só de conta, com o local escolhido
-- ---------------------------------------------------------------------------
-- O interesse passa a ser só de conta logada com direito ativo de veiculação
-- (decidido no servidor). O local pretendido: o endereço da conta, um dos
-- pontos dela ou outro endereço. `aprovada`: o Admin aprovou para agendar
-- (ainda sem equipamento, data nem horário — isso nasce na hospedagem).
ALTER TABLE hospedagem_interesses ADD COLUMN local_tipo text
  CHECK (local_tipo IS NULL OR local_tipo IN ('conta', 'ponto', 'outro'));
ALTER TABLE hospedagem_interesses ADD COLUMN ponto_id integer REFERENCES pontos(id) ON DELETE SET NULL;
ALTER TABLE hospedagem_interesses ADD COLUMN local_nome text
  CHECK (local_nome IS NULL OR char_length(local_nome) <= 120);
ALTER TABLE hospedagem_interesses DROP CONSTRAINT IF EXISTS hospedagem_interesses_status_check;
ALTER TABLE hospedagem_interesses ADD CONSTRAINT hospedagem_interesses_status_check
  CHECK (status IN ('nova', 'em_contato', 'aprovada', 'agendada', 'recusada'));

-- ---------------------------------------------------------------------------
-- 4. O aceite guarda também o período com hora, o horário e o equipamento
-- ---------------------------------------------------------------------------
-- Aceites antigos ficam como estão (colunas NULL). Mudar período, horário,
-- endereço ou percentual depois do aceite exige aceite novo.
ALTER TABLE hospedagem_aceites ADD COLUMN inicio timestamptz;
ALTER TABLE hospedagem_aceites ADD COLUMN fim timestamptz;
ALTER TABLE hospedagem_aceites ADD COLUMN horario_operacao jsonb;
ALTER TABLE hospedagem_aceites ADD COLUMN equipamento text;

-- ---------------------------------------------------------------------------
-- 5. Termo: minuta-2 (a minuta-1 fica como está — imutável)
-- ---------------------------------------------------------------------------
-- Ajusta o texto ao modelo sem base: período com data e hora, horário de
-- funcionamento definido na hospedagem, tempo válido só dentro dele.
-- Continua MINUTA OPERACIONAL, sem revisão jurídica (docs/PENDENCIAS.md T13).
UPDATE hospedagem_termos SET vigente = false
 WHERE vigente AND NOT EXISTS (SELECT 1 FROM hospedagem_termos WHERE versao = 'minuta-2');
INSERT INTO hospedagem_termos (versao, titulo, texto, hash_sha256, vigente, publicado_por)
SELECT v.versao, v.titulo, v.texto, encode(sha256(convert_to(v.texto, 'UTF8')), 'hex'), true, v.por
  FROM (VALUES (
    'minuta-2',
    'Termo de Hospedagem Temporária, Guarda de Equipamento e Contrapartida em Mídia',
    'MINUTA OPERACIONAL — este texto ainda não passou por revisão jurídica.

1. Objeto. O anfitrião recebe, pelo período e nos horários de funcionamento indicados nos dados desta hospedagem, um Ponto Móvel da Mostraí (tela, suporte, aparelho Player e acessórios) para instalação temporária no endereço indicado nesses dados. O período e os horários são definidos em conjunto com a equipe Mostraí.

2. Propriedade. O equipamento é e continua sendo exclusivamente da Mostraí. A hospedagem não transfere propriedade, posse definitiva, direito de uso próprio nem qualquer direito administrativo sobre o equipamento ou sobre a programação da tela.

3. Não é aluguel. Nenhuma das partes paga valor em dinheiro à outra por esta hospedagem. O anfitrião não recebe Plano Básico, créditos, cupons, receita nem veiculação gratuita própria naquela tela durante a hospedagem.

4. Responsabilidades do anfitrião. Oferecer o espaço e a energia elétrica, manter o equipamento ligado e exposto ao público nos horários de funcionamento indicados, não desligá-lo, mover, abrir, alterar ou ceder a terceiros, e avisar a Mostraí sem demora sobre qualquer dano, furto ou problema.

5. Responsabilidades da Mostraí. Entregar, instalar, operar, manter e retirar o equipamento, e gerir a programação exibida.

6. Contrapartida em mídia. Ao fim da hospedagem, a Mostraí apura o tempo operacional válido da tela: o tempo em que a tela comprovadamente operou, dentro do período e dos horários de funcionamento indicados — nunca a simples duração do período nem o tempo em que o equipamento esteve no local fora desses horários. O percentual indicado nos dados desta hospedagem desse tempo é creditado ao anfitrião como Saldo de Hospedagem, em horas de veiculação na rede Mostraí. O Saldo de Hospedagem não é dinheiro, crédito financeiro, cashback ou pagamento; não pode ser sacado nem convertido em dinheiro; não expira automaticamente; é usado conforme a capacidade e as regras de programação da rede.

7. Período, prorrogação e encerramento. O período e os horários são os indicados nos dados desta hospedagem; alterá-los exige novo aceite. Prorrogação depende de acordo e de disponibilidade da agenda do equipamento. Qualquer das partes pode encerrar antes; nesse caso, conta apenas o tempo operacional válido até o encerramento. A Mostraí registra a entrega e a retirada do equipamento, com a condição em que se encontra.

8. Dados. Os dados informados são usados para operar esta hospedagem e a contrapartida, conforme a Política de Privacidade da Mostraí.',
    'migration 114'
  )) AS v(versao, titulo, texto, por)
 WHERE NOT EXISTS (SELECT 1 FROM hospedagem_termos WHERE versao = 'minuta-2');
