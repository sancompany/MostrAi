// O CONTEXTO COMERCIAL de um ponto agora, em SQL — um lugar só (migrations
// 112 e 113). Para o ponto FIXO é o de sempre: o horário, o ramo e a dona do
// próprio ponto. O ponto MÓVEL muda de lugar, e o contexto vai junto:
//   hospedagem ativa  → o ramo e a conta do comércio ANFITRIÃO;
//   evento em curso   → o ramo que o Admin definiu para o evento (ou nenhum)
//                       e nenhuma casa — o evento não herda a base;
//   na base           → o ramo e a conta da BASE (o que o ponto guarda).
// Fora da base o horário da base não vale: a tela está AUTORIZADA a operar
// enquanto estiver ligada (NULL = sem horário). Isso não é "24 h ligada" —
// o que aconteceu de fato vem do Proof-of-Play e da telemetria; nenhuma
// obrigação nasce de hora em que a tela não pediu nada
// (src/bancohoras/obrigacao.js pula o ponto móvel).
// Quem lê: a config da TV e o gerador (SELECT_TELA,
// src/dispositivos/repository.js), a régua "no ar" do anunciante
// (src/anunciantes/routes.js#comSituacaoNoAr) e a cobertura prevista
// (src/anunciantes/entrada-no-ar.js) — com cálculos separados, o Admin e o
// anunciante discordariam da mesma tela.
// `p`: o apelido da tabela `pontos` na consulta.
const hospedagem = (p, coluna) =>
  `(SELECT h.${coluna} FROM pontos_moveis_hospedagens h WHERE h.ponto_id = ${p}.id AND h.estado = 'ativa')`;
const temHospedagem = (p) =>
  `EXISTS (SELECT 1 FROM pontos_moveis_hospedagens h WHERE h.ponto_id = ${p}.id AND h.estado = 'ativa')`;
const evento = (p, coluna) =>
  `(SELECT ev.${coluna} FROM pontos_moveis_eventos ev WHERE ev.ponto_id = ${p}.id AND ev.estado = 'em_andamento')`;
const temEvento = (p) =>
  `EXISTS (SELECT 1 FROM pontos_moveis_eventos ev WHERE ev.ponto_id = ${p}.id AND ev.estado = 'em_andamento')`;

const foraDaBaseSql = (p) => `(${p}.tipo = 'movel' AND (${temHospedagem(p)} OR ${temEvento(p)}))`;

const horarioEmVigorSql = (p) => `CASE WHEN ${foraDaBaseSql(p)} THEN NULL ELSE ${p}.horario_semanal END`;

const categoriaEmVigorSql = (p) => `CASE
    WHEN ${p}.tipo <> 'movel' THEN ${p}.categoria_id
    WHEN ${temHospedagem(p)} THEN ${hospedagem(p, 'categoria_id')}
    WHEN ${temEvento(p)} THEN ${evento(p, 'categoria_id')}
    ELSE ${p}.categoria_id END`;

const casaEmVigorSql = (p) => `CASE
    WHEN ${p}.tipo <> 'movel' THEN ${p}.anunciante_id
    WHEN ${temHospedagem(p)} THEN ${hospedagem(p, 'conta_id')}
    WHEN ${temEvento(p)} THEN NULL
    ELSE ${p}.base_conta_id END`;

// O anfitrião da hospedagem ativa (NULL fora dela) — o único que não roda de
// graça na tela que hospeda; a base não perde nada por guardar o móvel.
const anfitriaEmVigorSql = (p) => `CASE WHEN ${p}.tipo = 'movel' THEN ${hospedagem(p, 'conta_id')} END`;

module.exports = { foraDaBaseSql, horarioEmVigorSql, categoriaEmVigorSql, casaEmVigorSql, anfitriaEmVigorSql };
