// Horário de funcionamento do ponto, por dia da semana (migration 066).
// Formato: objeto com uma chave por dia — `null` (fechado) ou
// `{abre:"HH:MM", fecha:"HH:MM"}`. O formulário só pergunta 3 grupos
// (semana/sábado/domingo, ver public/modos.js e public/admin/index.page.js),
// mas a coluna guarda por dia — mais flexível se um dia precisar divergir um
// dia sem precisar de migration nova.
const DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];
const NOME_DIA = {
  seg: 'segunda',
  ter: 'terça',
  qua: 'quarta',
  qui: 'quinta',
  sex: 'sexta',
  sab: 'sábado',
  dom: 'domingo',
};
const HORA_VALIDA = /^([01]\d|2[0-3]):[0-5]\d$/;

// `null`/`undefined` passam batido (campo opcional em quem chama sem exigir
// horário, ex.: cadastro manual do admin). Quem exige preenchimento checa
// isso ANTES de chamar `validar`.
function validar(horario) {
  if (horario == null) return null;
  const erro = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (typeof horario !== 'object' || Array.isArray(horario)) {
    throw erro('horário de funcionamento em formato inválido');
  }
  const limpo = {};
  for (const dia of DIAS) {
    const v = horario[dia];
    if (v == null) {
      limpo[dia] = null;
      continue;
    }
    if (typeof v !== 'object' || !HORA_VALIDA.test(v.abre) || !HORA_VALIDA.test(v.fecha)) {
      throw erro(`horário de ${NOME_DIA[dia]} inválido`);
    }
    if (v.abre >= v.fecha) {
      throw erro(`${NOME_DIA[dia]}: horário de abertura precisa ser antes do de fechamento`);
    }
    limpo[dia] = { abre: v.abre, fecha: v.fecha };
  }
  return limpo;
}

// Texto curto pro card do anunciante e pro admin. Segunda a sexta vira uma
// fatia só quando os 5 dias são idênticos (é o único caso que o formulário
// hoje produz) — cai pra dia a dia se algum dia divergir dos outros (edição
// futura mais fina, direto no banco ou numa tela que ainda não existe).
function resumo(horario) {
  if (!horario) return null;
  const fmt = (v) => (v ? `${v.abre}-${v.fecha}` : 'fechado');
  const partes = [];
  const semana = ['seg', 'ter', 'qua', 'qui', 'sex'].map((d) => horario[d]);
  const semanaIgual = semana.every((v) => JSON.stringify(v) === JSON.stringify(semana[0]));
  if (semanaIgual) {
    partes.push(`Seg-sex ${fmt(semana[0])}`);
  } else {
    for (const d of ['seg', 'ter', 'qua', 'qui', 'sex']) partes.push(`${NOME_DIA[d]} ${fmt(horario[d])}`);
  }
  partes.push(`Sáb ${fmt(horario.sab)}`);
  partes.push(`Dom ${fmt(horario.dom)}`);
  return partes.join(' · ');
}

module.exports = { DIAS, NOME_DIA, validar, resumo };
