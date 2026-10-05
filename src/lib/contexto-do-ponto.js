// O CONTEXTO COMERCIAL de uma tela agora, em SQL — um lugar só (migrations
// 112 a 115). Na tela de ponto FIXO é o de sempre: o horário, o ramo e a dona
// do próprio ponto. O ponto MÓVEL é a REDE MÓVEL de uma cidade (migration
// 115: `pontos.tipo = 'movel'`, "Mostraí Móvel — Matão/SP") e as telas dela
// são `dispositivos`; o contexto é de CADA TELA, e só existe enquanto ela
// está ALOCADA:
//   hospedagem ativa da tela → o horário DA HOSPEDAGEM, o ramo e a conta do
//                              comércio ANFITRIÃO;
//   evento em curso com ela  → o horário DO EVENTO, o ramo protegido que o
//                              Admin definiu (ou nenhum) e nenhuma casa;
//   sem alocação             → nada: sem horário comercial, sem ramo, sem
//                              casa e fora do inventário. Ligada, a tela toca
//                              só o institucional.
// A agenda garante no máximo uma alocação em curso por tela (migration 115,
// `movel_tela_ocupada`); duas telas da mesma rede podem estar em lugares
// diferentes ao mesmo tempo, cada uma com o seu contexto.
// O horário da alocação vai para a TV pelo contrato de sempre
// (`config.operacao`). Nenhuma obrigação nasce de hora em que a tela não
// pediu nada (src/bancohoras/obrigacao.js pula o ponto móvel).
// Quem lê: a config da TV e o gerador (SELECT_TELA,
// src/dispositivos/repository.js), as métricas por tela, a régua "no ar" do
// anunciante, a cobertura prevista, a escolha de pontos e "Onde estamos" —
// com cálculos separados, o Admin e o anunciante discordariam da mesma tela.
// `p`: o apelido de `pontos`; `d`: o de `dispositivos`.
const hospedagemDaTela = (d, coluna) =>
  `(SELECT h.${coluna} FROM pontos_moveis_hospedagens h WHERE h.dispositivo_id = ${d}.id AND h.estado = 'ativa' LIMIT 1)`;
const temHospedagem = (d) =>
  `EXISTS (SELECT 1 FROM pontos_moveis_hospedagens h WHERE h.dispositivo_id = ${d}.id AND h.estado = 'ativa')`;
const eventoDaTela = (d, coluna) =>
  `(SELECT ev.${coluna} FROM pontos_moveis_evento_telas et JOIN pontos_moveis_eventos ev ON ev.id = et.evento_id
     WHERE et.dispositivo_id = ${d}.id AND ev.estado = 'em_andamento' LIMIT 1)`;
const temEvento = (d) =>
  `EXISTS (SELECT 1 FROM pontos_moveis_evento_telas et JOIN pontos_moveis_eventos ev ON ev.id = et.evento_id
            WHERE et.dispositivo_id = ${d}.id AND ev.estado = 'em_andamento')`;

// ---------------------------------------------------------------------------
// Por TELA
// ---------------------------------------------------------------------------
// A tela móvel está alocada agora (hospedagem ativa ou evento em andamento).
const telaAlocadaSql = (p, d) => `(${p}.tipo = 'movel' AND (${temHospedagem(d)} OR ${temEvento(d)}))`;

// É inventário comercial: toda tela de ponto fixo; a móvel só alocada.
const telaNoInventarioSql = (p, d) => `(${p}.tipo <> 'movel' OR ${temHospedagem(d)} OR ${temEvento(d)})`;

// Horário em vigor na tela. Fixo: o do ponto. Móvel alocada: o da alocação
// (NULL = sem restrição, "operar durante todo o período"). Móvel sem
// alocação: NULL — e o gerador só toca o institucional.
const horarioDaTelaSql = (p, d) => `CASE
    WHEN ${p}.tipo <> 'movel' THEN ${p}.horario_semanal
    WHEN ${temHospedagem(d)} THEN ${hospedagemDaTela(d, 'horario_operacao')}
    WHEN ${temEvento(d)} THEN ${eventoDaTela(d, 'horario_operacao')}
    ELSE NULL END`;

const categoriaDaTelaSql = (p, d) => `CASE
    WHEN ${p}.tipo <> 'movel' THEN ${p}.categoria_id
    WHEN ${temHospedagem(d)} THEN ${hospedagemDaTela(d, 'categoria_id')}
    WHEN ${temEvento(d)} THEN ${eventoDaTela(d, 'categoria_id')}
    ELSE NULL END`;

const casaDaTelaSql = (p, d) => `CASE
    WHEN ${p}.tipo <> 'movel' THEN ${p}.anunciante_id
    ELSE ${hospedagemDaTela(d, 'conta_id')} END`;

// O anfitrião da hospedagem ativa DESTA tela (NULL fora dela) — o único que
// não roda de graça na tela que hospeda.
const anfitriaDaTelaSql = (p, d) => `CASE WHEN ${p}.tipo = 'movel' THEN ${hospedagemDaTela(d, 'conta_id')} END`;

// ---------------------------------------------------------------------------
// Por PONTO (a rede móvel conta como UM ponto)
// ---------------------------------------------------------------------------
// O ponto é inventário agora: todo fixo; a rede móvel quando ao menos uma
// tela dela, ativa no cadastro, está alocada.
const inventarioSql = (p) => `(${p}.tipo <> 'movel' OR EXISTS (
    SELECT 1 FROM dispositivos dx WHERE dx.ponto_id = ${p}.id AND dx.status = 'ativo'
       AND (${temHospedagem('dx')} OR ${temEvento('dx')})))`;

// Horário do PONTO. A rede móvel não tem um: cada tela tem o da sua alocação
// (`horarioDaTelaSql`) — aqui NULL.
const horarioDoPontoSql = (p) => `CASE WHEN ${p}.tipo <> 'movel' THEN ${p}.horario_semanal END`;

module.exports = {
  telaAlocadaSql,
  telaNoInventarioSql,
  horarioDaTelaSql,
  categoriaDaTelaSql,
  casaDaTelaSql,
  anfitriaDaTelaSql,
  inventarioSql,
  horarioDoPontoSql,
};
