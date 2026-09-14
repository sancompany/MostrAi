const pool = require('../db/pool');

// Registro de evento da métrica (docs/funcional.md §9).
//
// Regra de ouro: NUNCA derrubar o caminho de negócio. Anotar que um pagamento
// foi confirmado é importante; deixar de confirmar o pagamento porque a
// anotação falhou é absurdo. Por isso toda chamada engole o próprio erro e
// quem chama não precisa de `await` nem de `.catch()`.
//
// Contas internas: o dono testando o próprio sistema não pode virar métrica.
// Duas fontes, as duas conhecidas na hora do evento — a conta do próprio
// Mostraí (`conta_propria`) e a lista de contas de teste do dono em
// EVENTOS_CONTAS_INTERNAS. Marcar depois seria tarde: o número já teria sido
// lido.
function contasInternasDoAmbiente() {
  return String(process.env.EVENTOS_CONTAS_INTERNAS || '')
    .split(',').map((x) => Number(x.trim())).filter(Boolean);
}

function ehInterno(conta) {
  if (!conta) return false;
  if (conta.conta_propria) return true;
  return contasInternasDoAmbiente().includes(Number(conta.id));
}

// `conta` é o registro de anunciantes quando existe — dele saem o id e a marca
// de interno, sem quem chama ter de lembrar dos dois.
function registrar(nome, propriedades = {}, conta = null) {
  const anuncianteId = conta ? conta.id : (propriedades.anunciante_id ?? null);
  const props = { ...propriedades };
  delete props.anunciante_id;
  pool.query(
    'INSERT INTO eventos (nome, anunciante_id, propriedades, interno) VALUES ($1, $2, $3, $4)',
    [nome, anuncianteId, JSON.stringify(props), ehInterno(conta)],
  ).catch((err) => {
    // Sai no log e morre aqui. Um evento perdido é um buraco no gráfico;
    // uma exceção aqui seria um buraco no dinheiro.
    console.error(`evento ${nome} não registrado:`, err.message);
  });
}

// Horas inteiras entre dois instantes, pra `horas_ate_aprovar` e afins. Uma
// casa decimal: "2,5 horas" responde a pergunta, "2,53333" não responde mais.
function horasEntre(inicio, fim = new Date()) {
  if (!inicio) return null;
  return Math.round(((new Date(fim) - new Date(inicio)) / 3600000) * 10) / 10;
}

function diasEntre(inicio, fim = new Date()) {
  if (!inicio) return null;
  return Math.floor((new Date(fim) - new Date(inicio)) / 86400000);
}

module.exports = { registrar, horasEntre, diasEntre, ehInterno };
