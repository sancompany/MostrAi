// O horário que vale AGORA para as telas de um ponto, em SQL — um lugar só
// (migration 112). É o `horario_semanal` do ponto, exceto no ponto MÓVEL com
// evento em andamento: ali o horário cadastrado é o da base e não diz nada
// sobre o evento, então a tela exibe enquanto estiver ligada (NULL = 24 h,
// como ponto sem horário). Quem lê: a config da TV e o gerador (SELECT_TELA,
// src/dispositivos/repository.js) e a régua "no ar" do anunciante
// (src/anunciantes/routes.js#comSituacaoNoAr). Com dois cálculos, o Admin
// diria "operando" e o anunciante "fora do horário" para a mesma tela.
// `p`: o apelido da tabela `pontos` na consulta.
const horarioEmVigorSql = (p) =>
  `CASE WHEN ${p}.tipo = 'movel' AND EXISTS (
          SELECT 1 FROM pontos_moveis_eventos ev WHERE ev.ponto_id = ${p}.id AND ev.estado = 'em_andamento')
        THEN NULL ELSE ${p}.horario_semanal END`;

module.exports = { horarioEmVigorSql };
