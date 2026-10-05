// MOSTRAÍ MÓVEL como opção de seleção (migration 115).
//
// Para o anunciante, "Mostraí Móvel" é UMA escolha lógica — a frota móvel
// ativa —, nunca um equipamento: ocupa 1 posição do plano e é resolvida a
// cada hora nas unidades alocadas (`coberturaDoAnunciante`,
// src/lib/pacing.js). Na lista de escolhas ela aparece como o marcador
// `MOSTRAI_MOVEL`, ao lado dos ids de ponto, na ordem em que foi escolhida.

const MOSTRAI_MOVEL = 'mostrai_movel';

// As escolhas da conta `a` em ordem (ids de ponto como texto e o marcador),
// num array: a mesma régua de `escolhido_em` para os dois tipos de alvo.
const escolhasSql = (a) => `COALESCE((
    SELECT array_agg(x.alvo ORDER BY x.em, x.alvo) FROM (
      SELECT ap.ponto_id::text AS alvo, ap.escolhido_em AS em FROM anunciantes_pontos ap WHERE ap.anunciante_id = ${a}.id
      UNION ALL
      SELECT '${MOSTRAI_MOVEL}', ${a}.mostrai_movel_escolhido_em WHERE ${a}.mostrai_movel_escolhido_em IS NOT NULL
    ) x), ARRAY[]::text[])`;

// Do array do banco para a lista do motor: número para ponto, o marcador
// como está.
const lerEscolhas = (lista) => (lista || []).map((v) => (v === MOSTRAI_MOVEL ? v : Number(v)));

module.exports = { MOSTRAI_MOVEL, escolhasSql, lerEscolhas };
