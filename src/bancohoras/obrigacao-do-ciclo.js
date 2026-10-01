const pool = require('../db/pool');
const { horasDeTelaPorMes, DURACAO_PADRAO } = require('../lib/pacing');
const { fimDaCobertura } = require('../lib/vigencia');

// A OBRIGAÇÃO DE VEICULAÇÃO NASCE DO CICLO CONTRATADO (01/10/2026, correção
// estrutural achada na auditoria Review-Master — decisão do dono; migration
// 111, docs/funcional.md RN-53, ADR-035).
//
//   comprou/renovou o ciclo  → nasce 100% do tempo contratado (+27 h, +84 h, +180 h…)
//   Proof-of-Play confirmado → abate
//   falta de ponto/tela/capacidade da Mostraí → não apaga, não impede, não consome
//
//   SALDO A ENTREGAR = Σ obrigação dos ciclos − Σ tempo confirmado ± ajustes legítimos
//
// A capacidade da rede NÃO cria dívida — ela só decide onde e quão rápido a
// dívida é paga (o gerador, src/playlist/gerador.js). Até aqui era o contrário:
// a obrigação nascia por tela e por hora aberta (`segundos_obrigacao`), e sem
// tela nenhuma quem comprava um Pro devia-se 0 h e via "Em dia".
//
// Ajustes legítimos (regras do dono — spec de consolidação):
//   · troca de plano no meio do ciclo: (horas/mês do novo − do antigo) × dias
//     que faltavam ÷ 30 — a mesma régua do acerto do Checkout (o plano novo
//     vale dali até o vencimento que já existia);
//   · benefício encerrado antes do fim: sai o que faltava dele;
//   · campanha indisponível por responsabilidade do CLIENTE (nenhum criativo
//     disponível, ou todos pausados por ele): o tempo da assinatura corre e se
//     perde — a dívida do lote cai na proporção desse tempo. Retirada pela
//     Mostraí (admin) não reduz nada;
//   · reembolso integral: o ciclo some; o que já tinha sido entregue dele vira
//     saldo técnico NEGATIVO (interno), descontado da próxima contratação.
//
// Excedente (entrega além de toda a obrigação válida) é bônus: nunca vira
// crédito da Mostraí contra o cliente nem reduz o ciclo seguinte. Acima de
// 45 min por ciclo é anomalia operacional (alerta interno, sem compensação).

const DIA_MS = 86_400_000;
const FUSO = 'America/Sao_Paulo';
// Excedente tolerado por ciclo antes de virar anomalia (spec, R2 "Entrega
// excedente" e R3 §42/§6: até 45 min é bônus; acima, alerta interno).
const EXCEDENTE_TOLERADO_SEGUNDOS = 45 * 60;

// Horas do plano por mês, na régua canônica da vitrine (27/84/180 h) — em
// segundos. A fonte é o próprio plano (segundos por hora × pontos), nunca um
// número fixo no código.
function segundosPorMesDoPlano(plano) {
  return horasDeTelaPorMes(plano?.segundos_por_hora, plano?.pontos_incluidos) * 3600;
}

function somarMeses(data, meses) {
  const d = new Date(data);
  d.setMonth(d.getMonth() + Number(meses));
  return d;
}

async function planoPorId(db, id) {
  if (!id) return null;
  const { rows } = await db.query('SELECT * FROM planos WHERE id = $1', [id]);
  return rows[0] || null;
}

// Grava um lançamento. Idempotente pela `chave`: o segundo webhook, o retry
// e a conciliação batem no UNIQUE e não somam nada. Devolve a linha nova, ou
// null quando o fato já estava registrado.
async function lancar(db, l) {
  const { rows } = await db.query(
    `INSERT INTO obrigacoes_veiculacao
       (anunciante_id, tipo, chave, segundos, plano_id, ciclo_contratado_id, plano_administrativo_id,
        referencia_id, inicio, fim, motivo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (chave) DO NOTHING
     RETURNING *`,
    [
      l.anuncianteId,
      l.tipo,
      l.chave,
      Math.round(l.segundos),
      l.planoId || null,
      l.cicloContratadoId || null,
      l.planoAdministrativoId || null,
      l.referenciaId || null,
      l.inicio,
      l.fim,
      l.motivo,
    ],
  );
  return rows[0] || null;
}

// CICLO PAGO (compra ou renovação). Roda na MESMA transação que grava o ciclo
// (`ciclos_contratados`) e a cobertura: ou o pagamento vale inteiro, com a
// obrigação, ou nada vale. O período do lote é o da cobertura que este ciclo
// paga — é dele que sai o ritmo (quanto já devia ter passado); o TAMANHO da
// obrigação não depende dele, nem de tela, ponto ou horário.
async function registrarCiclo(db, { anuncianteId, plano, ciclo, agora = new Date() }) {
  const meses = Number(ciclo.ciclo_meses || plano.compromisso_meses) || 1;
  const {
    rows: [conta],
  } = await db.query(
    'SELECT data_expiracao, plano_pago_guardado_id, plano_pago_guardado_dias FROM anunciantes WHERE id = $1',
    [anuncianteId],
  );
  // Fim da cobertura que este ciclo paga: o vencimento que o pagamento acabou
  // de gravar; com um benefício maior em vigor (pago "guardado" por baixo,
  // plano-administrativo.js#aplicarPagamentoNaFila), depois dele.
  let fim = fimDaCobertura(conta?.data_expiracao) || somarMeses(agora, meses);
  if (conta?.plano_pago_guardado_id && conta.plano_pago_guardado_dias) {
    fim = new Date(fim.getTime() + Number(conta.plano_pago_guardado_dias) * DIA_MS);
  }
  if (fim.getTime() < new Date(agora).getTime()) fim = somarMeses(agora, meses);
  // Começo: os meses antes do fim — mas o lote só começa no futuro se ainda
  // há outra cobertura correndo até lá (renovação paga adiantada, ou pago
  // guardado atrás de um benefício). Compra (ou volta depois de vencer)
  // começa agora: com o último dia inclusivo, "fim − meses" cairia amanhã e
  // o ciclo que já vale não seria o atual.
  let inicio = somarMeses(fim, -meses);
  if (inicio.getTime() > new Date(agora).getTime()) {
    const {
      rows: [corrente],
    } = await db.query(
      `SELECT 1 FROM obrigacoes_veiculacao
        WHERE anunciante_id = $1 AND segundos > 0 AND tipo IN ('ciclo', 'troca', 'beneficio') AND fim > $2
        LIMIT 1`,
      [anuncianteId, agora],
    );
    if (!corrente) inicio = new Date(agora);
  }
  const lote = await lancar(db, {
    anuncianteId,
    tipo: 'ciclo',
    chave: `ciclo:${ciclo.id}`,
    segundos: segundosPorMesDoPlano(plano) * meses,
    planoId: plano.id,
    cicloContratadoId: ciclo.id,
    inicio,
    fim,
    motivo: `${ciclo.origem === 'renovacao' ? 'renovação' : 'compra'} ${plano.nome || plano.id}`,
  });
  if (lote) await avaliarDisponibilidade(anuncianteId, { agora, db });
  return lote;
}

// TROCA DE PLANO no meio do ciclo (síncrona ou pelo webhook `plano_trocado`).
// A troca não estende a cobertura: o plano novo vale de agora até o
// vencimento que já existia. A obrigação muda só nesse trecho:
//   (horas/mês do novo − do antigo) × dias que faltam ÷ 30
// — positiva na subida, negativa no rebaixamento (que reduz o lote em curso;
// nunca cria dívida do cliente).
async function registrarTroca(db, { anuncianteId, planoNovo, planoAnteriorId, ciclo, agora = new Date() }) {
  const planoAnterior = await planoPorId(db, planoAnteriorId);
  const {
    rows: [conta],
  } = await db.query('SELECT data_expiracao FROM anunciantes WHERE id = $1', [anuncianteId]);
  const inicio = new Date(agora);
  const vencimento = fimDaCobertura(conta?.data_expiracao);
  const fim = vencimento && vencimento > inicio ? vencimento : inicio;
  const dias = (fim.getTime() - inicio.getTime()) / DIA_MS;
  const delta = ((segundosPorMesDoPlano(planoNovo) - segundosPorMesDoPlano(planoAnterior)) * dias) / 30;
  const {
    rows: [emCurso],
  } = await db.query(
    `SELECT id FROM obrigacoes_veiculacao
      WHERE anunciante_id = $1 AND segundos > 0 AND tipo IN ('ciclo', 'troca', 'beneficio')
      ORDER BY criado_em DESC, id DESC LIMIT 1`,
    [anuncianteId],
  );
  return lancar(db, {
    anuncianteId,
    tipo: 'troca',
    chave: `troca:${ciclo.id}`,
    segundos: delta,
    planoId: planoNovo.id,
    cicloContratadoId: ciclo.id,
    referenciaId: delta < 0 ? emCurso?.id : null,
    inicio,
    fim,
    motivo: `troca ${planoAnterior?.nome || planoAnteriorId || '?'} → ${planoNovo.nome || planoNovo.id} (${Math.round(dias)} dias restantes)`,
  });
}

// BENEFÍCIO por créditos ou cortesia administrativa ativado: o plano vale
// pelos dias de validade (`validoAte`, o último dia, inclusivo), e a
// obrigação é a do plano nesses dias.
async function registrarBeneficio(db, { anuncianteId, planoAdministrativoId, planoId, validoAte, agora = new Date() }) {
  const plano = await planoPorId(db, planoId);
  const inicio = new Date(agora);
  const ate = fimDaCobertura(validoAte);
  const fim = ate && ate > inicio ? ate : inicio;
  const dias = (fim.getTime() - inicio.getTime()) / DIA_MS;
  const lote = await lancar(db, {
    anuncianteId,
    tipo: 'beneficio',
    chave: `beneficio:${planoAdministrativoId}`,
    segundos: (segundosPorMesDoPlano(plano) * dias) / 30,
    planoId,
    planoAdministrativoId,
    inicio,
    fim,
    motivo: `benefício ${plano?.nome || planoId} (${Math.round(dias)} dias)`,
  });
  if (lote) await avaliarDisponibilidade(anuncianteId, { agora, db });
  return lote;
}

// Benefício encerrado antes do fim (admin cancelou, ou um plano pago maior o
// superou — os créditos não voltam, e o tempo que faltava sai junto).
async function encerrarBeneficio(db, { planoAdministrativoId, agora = new Date() }) {
  const {
    rows: [lote],
  } = await db.query(`SELECT * FROM obrigacoes_veiculacao WHERE chave = $1`, [`beneficio:${planoAdministrativoId}`]);
  if (!lote) return null;
  const inicio = new Date(lote.inicio).getTime();
  const fim = new Date(lote.fim).getTime();
  const agoraMs = new Date(agora).getTime();
  if (fim <= agoraMs || fim <= inicio) return null;
  const faltava = (Number(lote.segundos) * (fim - Math.max(agoraMs, inicio))) / (fim - inicio);
  return lancar(db, {
    anuncianteId: lote.anunciante_id,
    tipo: 'beneficio_encerrado',
    chave: `beneficio_encerrado:${planoAdministrativoId}`,
    segundos: -faltava,
    planoId: lote.plano_id,
    planoAdministrativoId,
    referenciaId: lote.id,
    inicio: new Date(Math.max(agoraMs, inicio)),
    fim: new Date(fim),
    motivo: 'benefício encerrado antes do fim',
  });
}

// REEMBOLSO INTEGRAL (arrependimento — devolve tudo o que foi pago): cada
// ciclo PAGO da conta até o pedido (`ate`) some. O que já tinha sido entregue
// dele não desaparece contabilmente — vira saldo técnico negativo no cálculo
// (interno), que a próxima contratação desconta. Benefício não foi pago em
// dinheiro: fica. Ciclo contratado DEPOIS do pedido nunca entra.
async function registrarReembolsoDaConta(db, { anuncianteId, motivo, ate = null }) {
  const { rows: lotes } = await db.query(
    `SELECT o.* FROM obrigacoes_veiculacao o
      WHERE o.anunciante_id = $1 AND o.tipo IN ('ciclo', 'troca') AND o.segundos > 0
        AND ($2::timestamptz IS NULL OR o.criado_em <= $2)
        AND NOT EXISTS (SELECT 1 FROM obrigacoes_veiculacao r WHERE r.tipo = 'reembolso' AND r.referencia_id = o.id)`,
    [anuncianteId, ate],
  );
  const feitos = [];
  for (const lote of lotes) {
    const linha = await lancar(db, {
      anuncianteId,
      tipo: 'reembolso',
      chave: `reembolso:${lote.id}`,
      segundos: -Number(lote.segundos),
      planoId: lote.plano_id,
      cicloContratadoId: lote.ciclo_contratado_id,
      referenciaId: lote.id,
      inicio: lote.inicio,
      fim: lote.fim,
      motivo,
    });
    if (linha) feitos.push(linha);
  }
  return feitos;
}

// Rede de segurança da conciliação diária: o pedido de arrependimento é
// gravado antes do lançamento do reembolso, e um erro entre os dois deixaria
// a obrigação viva sem ninguém pra repetir (o pedido aberto barra um segundo
// clique). Idempotente: só o que ainda não foi lançado, até a data do pedido.
async function conferirReembolsos(db = pool) {
  const { rows } = await db.query('SELECT id, anunciante_id, pedido_em FROM arrependimentos ORDER BY id');
  let lancados = 0;
  for (const p of rows) {
    const feitos = await registrarReembolsoDaConta(db, {
      anuncianteId: p.anunciante_id,
      motivo: `arrependimento (reembolso integral, pedido ${p.id})`,
      ate: p.pedido_em,
    });
    lancados += feitos.length;
  }
  return lancados;
}

// ---------------------------------------------------------------------------
// Disponibilidade da campanha — responsabilidade do cliente × da Mostraí
// ---------------------------------------------------------------------------
// `null` = há o que veicular (ou, se não há, a culpa é da Mostraí: peça
// retirada pelo admin, ou peça enviada esperando a análise/processamento da
// Mostraí — a dívida continua dela). Senão, o motivo da indisponibilidade
// que é do CLIENTE: nenhuma peça (ou só recusadas), ou todas pausadas por ele.
async function motivoDeIndisponibilidadeDoCliente(contaId, db = pool) {
  const {
    rows: [c],
  } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'aprovado' AND arquivo_normalizado_url IS NOT NULL)::int AS disponiveis,
            count(*) FILTER (WHERE status = 'pendente')::int AS em_analise,
            count(*) FILTER (WHERE status = 'retirado' AND retirado_por = 'admin')::int AS retirados_mostrai,
            count(*) FILTER (WHERE status = 'retirado' AND retirado_por = 'cliente')::int AS pausados_cliente
       FROM criativos WHERE anunciante_id = $1`,
    [contaId],
  );
  if (c.disponiveis > 0 || c.em_analise > 0 || c.retirados_mostrai > 0) return null;
  return c.pausados_cliente > 0 ? 'pausado_pelo_cliente' : 'sem_criativo_disponivel';
}

// Abre/fecha a janela de indisponibilidade do cliente conforme o estado de
// AGORA. Só importa enquanto a conta tem lote em curso ou por vir (fora disso
// nada corre). Chamada na contratação, a cada mudança de criativo e, como
// rede de segurança, a cada 10 min (bancohoras/obrigacao.js#iniciar). Duas
// chamadas juntas: o índice parcial deixa abrir uma só; fechar é UPDATE com
// `fim IS NULL`.
async function avaliarDisponibilidade(contaId, { agora = new Date(), db = pool } = {}) {
  const {
    rows: [emCurso],
  } = await db.query(
    `SELECT 1 FROM obrigacoes_veiculacao
      WHERE anunciante_id = $1 AND segundos > 0 AND tipo IN ('ciclo', 'troca', 'beneficio') AND fim > $2
      LIMIT 1`,
    [contaId, agora],
  );
  const motivo = emCurso ? await motivoDeIndisponibilidadeDoCliente(contaId, db) : null;
  if (motivo) {
    await db.query(
      `INSERT INTO indisponibilidade_cliente (anunciante_id, inicio, motivo) VALUES ($1, $2, $3)
       ON CONFLICT (anunciante_id) WHERE fim IS NULL DO NOTHING`,
      [contaId, agora, motivo],
    );
  } else {
    await db.query(
      `UPDATE indisponibilidade_cliente SET fim = GREATEST(inicio, $2::timestamptz) WHERE anunciante_id = $1 AND fim IS NULL`,
      [contaId, agora],
    );
  }
  return motivo;
}

// Depois de mexer em criativo (aprovar, pausar, retomar, retirar, excluir):
// avalia na hora, sem deixar o erro subir — é registro, não a operação.
async function avaliarDisponibilidadeSemFalhar(contaId) {
  try {
    await avaliarDisponibilidade(contaId);
  } catch (err) {
    console.error(`disponibilidade da conta ${contaId} não avaliada: ${err.message}`);
  }
}

// Rede de segurança periódica: toda conta com lote em curso, ou com janela
// aberta (que precisa fechar).
async function avaliarTodas({ agora = new Date(), apenasContas = null } = {}) {
  const { rows } = await pool.query(
    `SELECT anunciante_id FROM obrigacoes_veiculacao
      WHERE segundos > 0 AND tipo IN ('ciclo', 'troca', 'beneficio') AND fim > $1
        AND ($2::int[] IS NULL OR anunciante_id = ANY($2))
     UNION
     SELECT anunciante_id FROM indisponibilidade_cliente
      WHERE fim IS NULL AND ($2::int[] IS NULL OR anunciante_id = ANY($2))`,
    [agora, apenasContas],
  );
  for (const { anunciante_id: id } of rows) await avaliarDisponibilidade(id, { agora });
  return rows.length;
}

// ---------------------------------------------------------------------------
// O saldo — derivado do livro + Proof-of-Play, nunca guardado
// ---------------------------------------------------------------------------
// Função PURA (testável sem banco). Entradas:
//   lancamentos: linhas de `obrigacoes_veiculacao` (ordem de criação);
//   indisponibilidades: janelas [inicio, fim) da conta (fim null = até agora);
//   dias: [{ dia: Date (início do dia em Matão), entregue, basico }] —
//         `entregue` = segundos CONFIRMADOS por Proof-of-Play no dia (toda
//         camada: base, compensação, reposição e devolução de saldo);
//         `basico` = obrigação do Plano Básico do ponto no dia (o Básico
//         continua nascendo da tela — ele mesmo é um benefício da tela).
//
// FIFO: cada entrega paga o lote mais antigo que ainda deve. Entrega além de
// tudo o que se deve é excedente (bônus) — não fica como crédito pro ciclo
// seguinte. Só o reembolso cria saldo técnico negativo.
//
// limite: as entregas são agrupadas por dia e entram no FIM do dia — num dia
// com compra ou reembolso, a ordem dentro do dia é aproximada. Conta a conta
// o custo é um dia por linha; se a base crescer, materializar o resultado até
// a data em que nenhum comprovante pode mais chegar (7 dias) e somar só o resto.
function calcularSaldo({ lancamentos = [], indisponibilidades = [], dias = [], agora = new Date() }) {
  const agoraMs = new Date(agora).getTime();
  const janelas = indisponibilidades.map((j) => ({
    inicio: new Date(j.inicio).getTime(),
    fim: j.fim ? new Date(j.fim).getTime() : agoraMs,
  }));

  // Quanto do período do lote a campanha esteve fora por culpa do cliente.
  const fracaoIndisponivel = (inicio, fim) => {
    const ate = Math.min(fim, agoraMs);
    if (fim <= inicio || ate <= inicio) return 0;
    let fora = 0;
    for (const j of janelas) fora += Math.max(0, Math.min(j.fim, ate) - Math.max(j.inicio, inicio));
    return Math.min(1, fora / (fim - inicio));
  };

  const eventos = [];
  for (const l of lancamentos) {
    const em = new Date(l.criado_em || l.inicio).getTime();
    const segundos = Number(l.segundos);
    if (l.tipo === 'reembolso') {
      eventos.push({ em, ordem: 3, tipo: 'reembolso', alvo: Number(l.referencia_id), lancamento: l });
    } else if (segundos < 0) {
      eventos.push({
        em,
        ordem: 2,
        tipo: 'reduz',
        alvo: l.referencia_id ? Number(l.referencia_id) : null,
        segundos: -segundos,
        lancamento: l,
      });
    } else if (segundos > 0) {
      const inicio = new Date(l.inicio).getTime();
      const fim = new Date(l.fim).getTime();
      const fracaoFora = fracaoIndisponivel(inicio, fim);
      const cliente = Math.round(segundos * fracaoFora);
      eventos.push({
        em,
        ordem: 1,
        tipo: 'lote',
        lote: {
          id: Number(l.id),
          tipo: l.tipo,
          planoId: l.plano_id,
          inicio,
          fim,
          contratado: segundos,
          cliente,
          fracaoFora,
          lancamento: l,
        },
      });
    }
  }
  for (const d of dias) {
    const dia = new Date(d.dia).getTime();
    if (Number(d.basico) > 0) {
      // Só horas já fechadas (dadosDasContas): o Básico do dia já é devido
      // por inteiro — período de duração zero, sem parte "por vir".
      eventos.push({
        em: dia,
        ordem: 0,
        tipo: 'lote',
        lote: {
          id: `basico:${dia}`,
          tipo: 'basico',
          planoId: null,
          inicio: dia,
          fim: dia,
          contratado: Number(d.basico),
          cliente: 0,
          fracaoFora: 0,
        },
      });
    }
    if (Number(d.entregue) > 0)
      eventos.push({ em: dia + DIA_MS - 1, ordem: 4, tipo: 'entrega', segundos: Number(d.entregue) });
  }
  // Reembolso no meio de um dia com entrega: o que o dia entregou já tinha
  // sido entregue ao ciclo reembolsado (vira negativo técnico, nunca bônus) —
  // o reembolso vai pro fim do dia, depois da entrega.
  for (const r of eventos) {
    if (r.tipo !== 'reembolso') continue;
    const dia = eventos.find((e) => e.tipo === 'entrega' && e.em >= r.em && e.em - DIA_MS < r.em);
    if (dia) {
      r.em = dia.em;
      r.ordem = 5;
    }
  }
  eventos.sort((a, b) => a.em - b.em || a.ordem - b.ordem);

  const lotes = [];
  const porId = new Map();
  let debitoTecnico = 0;
  let excedente = 0;
  for (const ev of eventos) {
    if (ev.tipo === 'lote') {
      const l = { ...ev.lote, reduzido: 0, alocado: 0, absorvido: 0, excedente: 0, cancelado: false };
      l.valor = Math.max(0, l.contratado - l.cliente);
      l.restante = l.valor;
      if (debitoTecnico > 0) {
        l.absorvido = Math.min(debitoTecnico, l.restante);
        l.restante -= l.absorvido;
        debitoTecnico -= l.absorvido;
      }
      lotes.push(l);
      porId.set(l.id, l);
    } else if (ev.tipo === 'reduz') {
      // Rebaixamento ou benefício encerrado: tira do lote em curso; o que
      // passar do que ele ainda devia é ignorado (nunca vira dívida do cliente).
      const alvo =
        (ev.alvo && porId.get(ev.alvo)) || [...lotes].reverse().find((l) => !l.cancelado && l.tipo !== 'basico');
      if (!alvo || alvo.cancelado) continue;
      // O contratado cai só o que de fato saiu: o que já tinha sido entregue
      // continua contado como contratado e entregue.
      const tirar = (l, quanto) => {
        const tira = Math.min(quanto, l.restante);
        l.restante -= tira;
        l.reduzido += tira;
        return quanto - tira;
      };
      let falta = tirar(alvo, ev.segundos);
      // Rebaixamento maior que o lote de referência (duas trocas no mesmo
      // ciclo: Pro → Prime → Essencial): o resto sai dos outros lotes que
      // valem naquele momento, do mais novo pro mais antigo — senão as horas
      // do plano antigo continuariam devidas depois do rebaixamento.
      if (falta > 0 && ev.lancamento?.tipo === 'troca') {
        const desde = new Date(ev.lancamento.inicio).getTime();
        for (const l of [...lotes].reverse()) {
          if (falta <= 0) break;
          if (l === alvo || l.cancelado || !['ciclo', 'troca'].includes(l.tipo)) continue;
          if (l.inicio <= desde && l.fim > desde) falta = tirar(l, falta);
        }
      }
    } else if (ev.tipo === 'reembolso') {
      const alvo = porId.get(ev.alvo);
      if (!alvo || alvo.cancelado) continue;
      // O que já tinha sido entregue (e o negativo antigo que ele quitou)
      // volta como saldo técnico negativo.
      debitoTecnico += alvo.alocado + alvo.absorvido;
      alvo.restante = 0;
      alvo.cancelado = true;
    } else if (ev.tipo === 'entrega') {
      let resta = ev.segundos;
      for (const l of lotes) {
        if (resta <= 0) break;
        if (l.cancelado || l.restante <= 0) continue;
        const paga = Math.min(resta, l.restante);
        l.restante -= paga;
        l.alocado += paga;
        resta -= paga;
      }
      if (resta > 0) {
        excedente += resta;
        const dono = [...lotes].reverse().find((l) => !l.cancelado && l.inicio <= ev.em) || lotes[lotes.length - 1];
        if (dono) dono.excedente += resta;
      }
    }
  }

  const ativos = lotes.filter((l) => !l.cancelado);
  const devido = ativos.reduce((s, l) => s + Math.max(0, l.valor - l.reduzido), 0);
  // Entregue inclui o que um negativo técnico de reembolso já tinha entregue
  // e este lote absorveu: pro cliente, contratado − entregue = a entregar.
  const entregue = ativos.reduce((s, l) => s + l.alocado + l.absorvido, 0);
  const pendente = ativos.reduce((s, l) => s + Math.max(0, l.restante), 0);
  // Ritmo: do lote em curso, a parte que ainda tem tempo pela frente não é
  // atraso — é o que a base normal vai entregar até o fim do período. O
  // gerador só usa a capacidade OCIOSA pra recuperar o ATRASO.
  let atraso = 0;
  let idadeMeses = 0;
  for (const l of ativos) {
    if (l.restante <= 0) continue;
    // A parte "por vir" é medida no tempo em que a campanha PODIA rodar: o
    // tempo fora por responsabilidade do cliente já saiu do valor do lote e
    // não pode contar de novo como tempo que passou sem entrega.
    const disponivel = (l.fim - l.inicio) * (1 - l.fracaoFora);
    const futuro =
      l.fim > agoraMs && disponivel > 0 ? Math.min(1, (l.fim - Math.max(agoraMs, l.inicio)) / disponivel) : 0;
    const devidoAteAgora = Math.max(0, l.restante - Math.max(0, l.valor - l.reduzido) * futuro);
    if (devidoAteAgora > 0) {
      if (atraso === 0) {
        const desde = new Date(Math.min(l.fim, agoraMs));
        const hoje = new Date(agoraMs);
        idadeMeses = Math.max(0, (hoje.getFullYear() - desde.getFullYear()) * 12 + hoje.getMonth() - desde.getMonth());
      }
      atraso += devidoAteAgora;
    }
  }
  // Lote vigente (o que o painel chama de "ciclo atual"): o ciclo (ou
  // benefício) mais recente já começado, junto com as trocas feitas dentro
  // do período dele — a troca é ajuste do ciclo, não um ciclo novo.
  const comerciais = ativos.filter((l) => l.tipo !== 'basico');
  const bases = comerciais.filter((l) => l.tipo !== 'troca');
  const atual =
    [...bases].reverse().find((l) => l.inicio <= agoraMs && agoraMs < l.fim) ||
    bases[bases.length - 1] ||
    comerciais[comerciais.length - 1] ||
    null;
  const grupoAtual = atual
    ? comerciais.filter((l) => l === atual || (l.tipo === 'troca' && l.inicio >= atual.inicio && l.inicio < atual.fim))
    : [];
  // O plano em vigor é o da troca mais recente do ciclo — inclusive um
  // rebaixamento, que não vira lote (só reduz) e por isso sai do livro.
  const trocaMaisRecente = atual
    ? lancamentos
        .filter((l) => {
          const t = new Date(l.inicio).getTime();
          return l.tipo === 'troca' && t >= atual.inicio && t < atual.fim;
        })
        .sort((a, b) => new Date(a.criado_em || a.inicio) - new Date(b.criado_em || b.inicio))
        .pop()
    : null;
  const anomalias = lotes
    .filter((l) => l.excedente > EXCEDENTE_TOLERADO_SEGUNDOS && typeof l.id === 'number')
    .map((l) => ({ loteId: l.id, excedenteSegundos: Math.round(l.excedente) }));

  return {
    devidoSegundos: Math.round(devido),
    entregueSegundos: Math.round(entregue),
    saldoSegundos: Math.round(pendente - debitoTecnico),
    pendenteSegundos: Math.round(pendente),
    negativoTecnicoSegundos: Math.round(debitoTecnico),
    atrasoSegundos: Math.round(atraso),
    excedenteSegundos: Math.round(excedente),
    idadeMeses,
    cicloAtual: atual
      ? {
          tipo: atual.tipo,
          planoId: trocaMaisRecente?.plano_id || atual.planoId,
          inicio: new Date(atual.inicio),
          fim: new Date(atual.fim),
          contratadoSegundos: Math.round(grupoAtual.reduce((s, l) => s + Math.max(0, l.valor - l.reduzido), 0)),
          pendenteSegundos: Math.round(grupoAtual.reduce((s, l) => s + Math.max(0, l.restante), 0)),
        }
      : null,
    // Só o que começou ANTES do ciclo atual — a renovação paga adiantada
    // (lote que ainda vai começar) é obrigação nova, não saldo anterior.
    saldoAnteriorSegundos: Math.round(
      ativos
        .filter((l) => atual && !grupoAtual.includes(l) && l.inicio <= atual.inicio)
        .reduce((s, l) => s + Math.max(0, l.restante), 0),
    ),
    anomalias,
    lotes: lotes.map((l) => ({
      id: l.id,
      tipo: l.tipo,
      planoId: l.planoId,
      inicio: new Date(l.inicio),
      fim: new Date(l.fim),
      contratadoSegundos: Math.round(l.contratado),
      indisponivelClienteSegundos: Math.round(l.cliente),
      reduzidoSegundos: Math.round(l.reduzido),
      entregueSegundos: Math.round(l.alocado + l.absorvido),
      negativoAbsorvidoSegundos: Math.round(l.absorvido),
      pendenteSegundos: Math.round(Math.max(0, l.restante)),
      excedenteSegundos: Math.round(l.excedente),
      reembolsado: l.cancelado,
      motivo: l.lancamento?.motivo || (l.tipo === 'basico' ? 'Plano Básico do ponto' : null),
    })),
  };
}

// Lê do banco o que `calcularSaldo` precisa, de uma vez pra várias contas.
// `agora`: a obrigação do Básico de uma hora só conta depois que a hora
// fecha — a hora em curso ainda está sendo entregue pela base.
async function dadosDasContas(ids, db = pool, agora = new Date()) {
  if (!ids.length) return new Map();
  const [lancamentos, janelas, dias] = await Promise.all([
    db.query(`SELECT * FROM obrigacoes_veiculacao WHERE anunciante_id = ANY($1::int[]) ORDER BY criado_em, id`, [ids]),
    db.query(`SELECT anunciante_id, inicio, fim FROM indisponibilidade_cliente WHERE anunciante_id = ANY($1::int[])`, [
      ids,
    ]),
    db.query(
      `SELECT e.anunciante_id,
              (date_trunc('day', e.janela_hora AT TIME ZONE '${FUSO}') AT TIME ZONE '${FUSO}') AS dia,
              SUM(e.vezes_confirmadas * COALESCE(e.duracao_segundos, $2))::bigint AS entregue,
              SUM(CASE WHEN e.janela_hora + interval '1 hour' <= $3::timestamptz
                       THEN COALESCE(e.segundos_obrigacao_basico, 0) ELSE 0 END)::bigint AS basico
         FROM exibicoes_contador e
        WHERE e.anunciante_id = ANY($1::int[])
        GROUP BY 1, 2
        ORDER BY 2`,
      [ids, DURACAO_PADRAO, agora],
    ),
  ]);
  const mapa = new Map(ids.map((id) => [Number(id), { lancamentos: [], indisponibilidades: [], dias: [] }]));
  for (const r of lancamentos.rows) mapa.get(r.anunciante_id)?.lancamentos.push(r);
  for (const r of janelas.rows) mapa.get(r.anunciante_id)?.indisponibilidades.push(r);
  for (const r of dias.rows) mapa.get(r.anunciante_id)?.dias.push(r);
  return mapa;
}

async function saldoDaConta(contaId, { agora = new Date(), db = pool } = {}) {
  const dados = (await dadosDasContas([Number(contaId)], db, agora)).get(Number(contaId));
  return calcularSaldo({ ...dados, agora });
}

// Contas que têm o que dever: lançamento no livro, ou Plano Básico (cuja
// obrigação continua nascendo da tela). O Básico sai do histórico do
// benefício (`beneficios_basico_ponto` guarda os encerrados), não de uma
// varredura de `exibicoes_contador` — isto roda a cada playlist pedida.
async function contasComObrigacao(db = pool) {
  const { rows } = await db.query(
    `SELECT a.id FROM anunciantes a
      WHERE a.excluido_em IS NULL AND NOT a.conta_propria
        AND (EXISTS (SELECT 1 FROM obrigacoes_veiculacao o WHERE o.anunciante_id = a.id)
             OR EXISTS (SELECT 1 FROM beneficios_basico_ponto b WHERE b.conta_id = a.id))`,
  );
  return rows.map((r) => Number(r.id));
}

async function saldosDasContas({ agora = new Date(), apenasContas = null, db = pool } = {}) {
  const ids = apenasContas ? apenasContas.map(Number) : await contasComObrigacao(db);
  const dados = await dadosDasContas(ids, db, agora);
  const resultado = new Map();
  for (const [id, d] of dados) resultado.set(id, calcularSaldo({ ...d, agora }));
  return resultado;
}

// O que a camada T3 do gerador pode devolver AGORA, por conta: o atraso
// menos o que já está programado pelo banco e ainda não confirmado (cada tela
// gera a hora sozinha — sem a reserva, várias programariam a mesma dívida).
// O confirmado já saiu do saldo pelo Proof-of-Play; só o não confirmado
// fica reservado até a hora ser liquidada (bancohoras/apuracao.js).
// `idadeMeses`: idade da dívida mais antiga — acelera o RITMO da devolução
// (gerador.js#multiplicadorPorIdade), nunca o tamanho.
//
// limite: recalcula todas as contas com obrigação a cada playlist pedida
// (cada tela, a cada 15 min e na virada da hora), lendo o histórico inteiro
// de entrega delas por dia. Com muitas contas × meses, materializar o saldo
// até a data em que nenhum comprovante pode mais chegar (ver o `limite:` de
// calcularSaldo) — não cachear: a reserva do banco tem de ser lida na hora,
// senão duas telas programam a mesma dívida.
async function saldosParaRecuperar({ agora = new Date(), db = pool } = {}) {
  const [saldos, { rows: reservas }] = await Promise.all([
    saldosDasContas({ agora, db }),
    db.query(
      `SELECT anunciante_id,
              SUM(GREATEST(vezes_banco - LEAST(GREATEST(vezes_confirmadas - (vezes_programadas - vezes_banco), 0), vezes_banco), 0)
                  * COALESCE(duracao_segundos, $1))::bigint AS segundos
         FROM exibicoes_contador
        WHERE vezes_banco > 0 AND banco_liquidado_em IS NULL
        GROUP BY anunciante_id`,
      [DURACAO_PADRAO],
    ),
  ]);
  const reservado = new Map(reservas.map((r) => [Number(r.anunciante_id), Number(r.segundos)]));
  const mapa = {};
  for (const [id, s] of saldos) {
    const disponivel = Math.min(s.atrasoSegundos, s.saldoSegundos) - (reservado.get(id) || 0);
    if (disponivel > 0) mapa[id] = { segundos: disponivel, idadeMeses: s.idadeMeses };
  }
  return mapa;
}

// Excedente acima de 45 min num ciclo → pendência do admin, uma por lote
// (a chave da pendência é a do lote: rodar todo dia não repete o aviso).
// Rodada pela conciliação diária. Nada é descontado de ninguém.
async function registrarAnomaliasDeSobreentrega({ agora = new Date(), apenasContas = null } = {}) {
  const pendencias = require('../pendencias/repository');
  const saldos = await saldosDasContas({ agora, apenasContas });
  let abertas = 0;
  for (const [contaId, s] of saldos) {
    for (const a of s.anomalias) {
      const horas = (a.excedenteSegundos / 3600).toFixed(1).replace('.', ',');
      const linha = await pendencias.abrir({
        tipo: 'SOBREENTREGA_ANOMALA',
        chave: `SOBREENTREGA_ANOMALA:lote:${a.loteId}`,
        anuncianteId: contaId,
        titulo: `Entrega além do contratado: ${horas} h`,
        mensagem:
          'A rede entregou mais de 45 min além de toda a obrigação deste ciclo. É bônus pro cliente (não desconta ' +
          'nada do próximo ciclo) — confira o ritmo do gerador nesta conta.',
        ctaRotulo: 'Ver conta',
        ctaDestino: `#contas/${contaId}`,
        dados: { loteId: a.loteId, excedenteSegundos: a.excedenteSegundos },
      });
      if (linha?.nova) abertas += 1;
    }
  }
  return { contas: saldos.size, abertas };
}

module.exports = {
  registrarAnomaliasDeSobreentrega,
  saldosParaRecuperar,
  EXCEDENTE_TOLERADO_SEGUNDOS,
  segundosPorMesDoPlano,
  registrarCiclo,
  registrarTroca,
  registrarBeneficio,
  encerrarBeneficio,
  registrarReembolsoDaConta,
  conferirReembolsos,
  motivoDeIndisponibilidadeDoCliente,
  avaliarDisponibilidade,
  avaliarDisponibilidadeSemFalhar,
  avaliarTodas,
  calcularSaldo,
  saldoDaConta,
  saldosDasContas,
};
