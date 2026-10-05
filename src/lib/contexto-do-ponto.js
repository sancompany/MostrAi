// O CONTEXTO COMERCIAL de um ponto agora, em SQL — um lugar só (migrations
// 112, 113 e 114). Para o ponto FIXO é o de sempre: o horário, o ramo e a
// dona do próprio ponto. O ponto MÓVEL não tem base (migration 114): é
// equipamento, e o contexto só existe enquanto ele está ALOCADO:
//   hospedagem ativa  → o horário DA HOSPEDAGEM, o ramo e a conta do
//                       comércio ANFITRIÃO;
//   evento em curso   → o horário DO EVENTO, o ramo que o Admin definiu para
//                       ele (ou nenhum) e nenhuma casa;
//   sem alocação      → nada: sem horário comercial, sem ramo, sem casa e
//                       FORA DO INVENTÁRIO (`inventarioSql`). A tela, se
//                       ligada, toca só o institucional.
// O horário da alocação vai para a TV pelo contrato de sempre
// (`config.operacao`); NULL só em alocação antiga, anterior à 114 (sem
// restrição, como era). Nenhuma obrigação nasce de hora em que a tela não
// pediu nada (src/bancohoras/obrigacao.js pula o ponto móvel).
// Quem lê: a config da TV e o gerador (SELECT_TELA,
// src/dispositivos/repository.js), a régua "no ar" do anunciante
// (src/anunciantes/routes.js#comSituacaoNoAr), a cobertura prevista
// (src/anunciantes/entrada-no-ar.js), a escolha de pontos, "Onde estamos" e
// as métricas — com cálculos separados, o Admin e o anunciante discordariam
// da mesma tela.
// `p`: o apelido da tabela `pontos` na consulta.
const hospedagem = (p, coluna) =>
  `(SELECT h.${coluna} FROM pontos_moveis_hospedagens h WHERE h.ponto_id = ${p}.id AND h.estado = 'ativa')`;
const temHospedagem = (p) =>
  `EXISTS (SELECT 1 FROM pontos_moveis_hospedagens h WHERE h.ponto_id = ${p}.id AND h.estado = 'ativa')`;
const evento = (p, coluna) =>
  `(SELECT ev.${coluna} FROM pontos_moveis_eventos ev WHERE ev.ponto_id = ${p}.id AND ev.estado = 'em_andamento')`;
const temEvento = (p) =>
  `EXISTS (SELECT 1 FROM pontos_moveis_eventos ev WHERE ev.ponto_id = ${p}.id AND ev.estado = 'em_andamento')`;

// O móvel está alocado agora (hospedagem ativa ou evento em andamento).
const alocadoSql = (p) => `(${p}.tipo = 'movel' AND (${temHospedagem(p)} OR ${temEvento(p)}))`;

// É inventário comercial: todo fixo; o móvel só alocado.
const inventarioSql = (p) => `(${p}.tipo <> 'movel' OR ${temHospedagem(p)} OR ${temEvento(p)})`;

// Horário em vigor. Fixo: o do ponto. Móvel alocado: o da alocação. Móvel
// sem alocação: NULL — a TV fica sem restrição de horário e o gerador só
// toca o institucional (não há contexto comercial nenhum).
const horarioEmVigorSql = (p) => `CASE
    WHEN ${p}.tipo <> 'movel' THEN ${p}.horario_semanal
    WHEN ${temHospedagem(p)} THEN ${hospedagem(p, 'horario_operacao')}
    WHEN ${temEvento(p)} THEN ${evento(p, 'horario_operacao')}
    ELSE NULL END`;

const categoriaEmVigorSql = (p) => `CASE
    WHEN ${p}.tipo <> 'movel' THEN ${p}.categoria_id
    WHEN ${temHospedagem(p)} THEN ${hospedagem(p, 'categoria_id')}
    WHEN ${temEvento(p)} THEN ${evento(p, 'categoria_id')}
    ELSE NULL END`;

const casaEmVigorSql = (p) => `CASE
    WHEN ${p}.tipo <> 'movel' THEN ${p}.anunciante_id
    WHEN ${temHospedagem(p)} THEN ${hospedagem(p, 'conta_id')}
    ELSE NULL END`;

// O anfitrião da hospedagem ativa (NULL fora dela) — o único que não roda de
// graça na tela que hospeda.
const anfitriaEmVigorSql = (p) => `CASE WHEN ${p}.tipo = 'movel' THEN ${hospedagem(p, 'conta_id')} END`;

module.exports = {
  alocadoSql,
  inventarioSql,
  horarioEmVigorSql,
  categoriaEmVigorSql,
  casaEmVigorSql,
  anfitriaEmVigorSql,
};
