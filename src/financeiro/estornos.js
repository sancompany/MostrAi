// Estorno — ação do Admin sobre UMA cobrança (estação "Pagamentos /
// cancelamento ≠ estorno", 09/10/2026; ADR-046; migration 120).
//
// CANCELAR ≠ ESTORNAR. Cancelar a assinatura (src/financeiro/routes.js) só
// para a recorrência: não chama nada daqui. Estornar devolve o dinheiro de
// uma cobrança e NÃO cancela a assinatura nem suspende a conta. Nenhum dos
// dois dispara o outro.
//
// O dinheiro não sai pela Mostraí: o `/estornar` do San Checkout só alcança
// pedido avulso (procura a cobrança por `pedido_id`, que cobrança de
// assinatura não tem — API.md dele, 5.4, lido em 09/10/2026), e mexer no
// Checkout está fora desta estação. Então:
//
//   Admin pede (aqui: 'solicitado', com operador, motivo e valor)
//   → operador devolve no painel da Asaas
//   → webhook `cobranca_estornada` (casado pelo chargeId) → 'confirmado'
//
// Nada marca dinheiro como devolvido sem o PSP dizer. Sem confirmação, o
// pedido fica 'solicitado' (visível no Admin) — nunca vira 'confirmado' por
// clique. O que só o PSP sabe (o valor acumulado devolvido) vem dele.
const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const obrigacaoDoCiclo = require('../bancohoras/obrigacao-do-ciclo');
const planoAdministrativo = require('./plano-administrativo');

// Janela do estorno ORDINÁRIO: 7 dias corridos da confirmação do pagamento
// no PSP (`pago_em`), por cobrança — renovação inclusive (decisão do dono,
// 09/10/2026). Fora dela, só o estorno EXCEPCIONAL (com categoria).
const DIAS_JANELA_ORDINARIA = 7;
const DIA_MS = 24 * 3600 * 1000;
const CATEGORIAS_EXCEPCIONAIS = new Set([
  'duplicidade',
  'cobranca_indevida',
  'erro_operacional',
  'obrigacao_legal',
  'administrativa',
]);
const MOTIVO_MIN = 5;
const MOTIVO_MAX = 500;

class ErroEstorno extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

// Dinheiro em centavos inteiros: R$ 134,99 → 13499. Comparar reais em ponto
// flutuante erra no centavo (0.1 + 0.2).
const centavos = (v) => Math.round(Number(v) * 100);
const reais = (c) => c / 100;

function janelaOrdinaria(cobranca, agora = new Date()) {
  const ate = new Date(new Date(cobranca.pago_em).getTime() + DIAS_JANELA_ORDINARIA * DIA_MS);
  return { ate, dentro: new Date(agora).getTime() <= ate.getTime() };
}

// Quanto ainda pode voltar: o pago, menos o que o PSP já confirmou, menos o
// que já está pedido e esperando a Asaas.
function restanteCentavos(cobranca, pedidoAberto = null) {
  const aberto = pedidoAberto ? centavos(pedidoAberto.valor) : 0;
  return Math.max(0, centavos(cobranca.valor) - centavos(cobranca.valor_estornado) - aberto);
}

// O que a tela pode oferecer — e o que o servidor exige de novo no POST. Pura
// (sem banco): o relógio é o do servidor, nunca o do navegador.
function elegibilidade(cobranca, { pedidoAberto = null, agora = new Date() } = {}) {
  const restante = restanteCentavos(cobranca, null);
  const janela = janelaOrdinaria(cobranca, agora);
  const base = { restante: reais(restante), prazoAte: janela.ate.toISOString(), dentroDaJanela: janela.dentro };
  let bloqueio = null;
  if (cobranca.status_financeiro === 'contestado') {
    bloqueio = 'cobrança contestada (chargeback) — o dinheiro está em disputa no banco do cliente';
  } else if (cobranca.status_financeiro === 'estornado' || restante <= 0) {
    bloqueio = 'cobrança já estornada por inteiro';
  } else if (!cobranca.charge_id) {
    bloqueio = 'cobrança sem identificador do PSP (chargeId) — a devolução não teria como ser confirmada';
  } else if (pedidoAberto) {
    bloqueio = 'já existe um estorno solicitado para esta cobrança, aguardando a Asaas';
  }
  return {
    ...base,
    ordinario: bloqueio
      ? { pode: false, motivo: bloqueio }
      : janela.dentro
        ? { pode: true }
        : { pode: false, motivo: 'Fora da janela de estorno pelo painel.' },
    excepcional: bloqueio ? { pode: false, motivo: bloqueio } : { pode: true },
  };
}

function validarValor(valorPedido, restante) {
  if (valorPedido === undefined || valorPedido === null || valorPedido === '') return restante;
  const n = Number(valorPedido);
  if (!Number.isFinite(n) || n <= 0) throw new ErroEstorno(400, 'valor do estorno inválido');
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw new ErroEstorno(400, 'valor com mais de 2 casas decimais');
  const c = Math.round(n * 100);
  if (c > restante) {
    throw new ErroEstorno(
      400,
      `valor do estorno (R$ ${reais(c).toFixed(2)}) maior que o que ainda pode voltar (R$ ${reais(restante).toFixed(2)})`,
    );
  }
  return c;
}

function validarMotivo(motivo) {
  const m = typeof motivo === 'string' ? motivo.trim() : '';
  if (m.length < MOTIVO_MIN) throw new ErroEstorno(400, 'descreva o motivo do estorno');
  if (m.length > MOTIVO_MAX) throw new ErroEstorno(400, `motivo com mais de ${MOTIVO_MAX} caracteres`);
  return m;
}

// Sempre dentro de transação, e TRAVANDO o pedido: `cancelar` não passa pela
// trava da cobrança, então é a trava da linha que decide a corrida com a
// confirmação do PSP — quem chega depois relê o status e não acha mais um
// pedido aberto (cancelado não vira confirmado, nem o contrário).
async function pedidoAbertoDa(db, cobrancaId) {
  const { rows } = await db.query(
    "SELECT * FROM estornos WHERE cobranca_id = $1 AND status = 'solicitado' FOR UPDATE",
    [cobrancaId],
  );
  return rows[0] || null;
}

// Admin pede o estorno de uma cobrança. Tudo é conferido aqui, de novo, com a
// cobrança TRAVADA: o que a tela mostrou não vale como prova (relógio,
// valor, janela e pedido em aberto são os do servidor agora). Devolve a
// linha criada — 'solicitado'; o dinheiro só volta quando o operador
// executar na Asaas, e só conta quando o PSP avisar.
async function solicitar({ cobrancaId, tipo, categoria = null, valor, motivo, operador, operadorAccess = null }) {
  if (tipo !== 'ordinario' && tipo !== 'excepcional') throw new ErroEstorno(400, 'tipo de estorno inválido');
  if (tipo === 'excepcional' && !CATEGORIAS_EXCEPCIONAIS.has(categoria)) {
    throw new ErroEstorno(400, 'estorno excepcional precisa de uma categoria');
  }
  const motivoLimpo = validarMotivo(motivo);
  const id = Number(cobrancaId);
  if (!Number.isInteger(id) || id <= 0) throw new ErroEstorno(404, 'cobrança não encontrada');

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const {
      rows: [cobranca],
    } = await cliente.query('SELECT * FROM cobrancas_confirmadas WHERE id = $1 FOR UPDATE', [id]);
    if (!cobranca) throw new ErroEstorno(404, 'cobrança não encontrada');
    const pedidoAberto = await pedidoAbertoDa(cliente, id);
    const eleg = elegibilidade(cobranca, { pedidoAberto });
    const regra = eleg[tipo];
    if (!regra.pode) throw new ErroEstorno(409, regra.motivo);
    const valorCentavos = validarValor(valor, restanteCentavos(cobranca, pedidoAberto));

    const {
      rows: [criado],
    } = await cliente.query(
      `INSERT INTO estornos (cobranca_id, anunciante_id, tipo, categoria, valor, motivo, solicitado_por,
                             solicitado_por_access, status_financeiro_antes, psp_charge_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id,
        cobranca.anunciante_id,
        tipo,
        tipo === 'excepcional' ? categoria : null,
        reais(valorCentavos),
        motivoLimpo,
        operador || null,
        operadorAccess || null,
        cobranca.status_financeiro,
        cobranca.charge_id,
      ],
    );
    await cliente.query('COMMIT');
    return criado;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    // Corrida com outro pedido para a mesma cobrança: o índice único decide.
    if (err.code === '23505') throw new ErroEstorno(409, 'já existe um estorno solicitado para esta cobrança');
    throw err;
  } finally {
    cliente.release();
  }
}

// Encerra um pedido que não vai ser executado (o operador não devolveu, ou
// desistiu), com quem e por quê. Não mexe em dinheiro nem na cobrança. A
// devolução de uma DESISTÊNCIA (art. 49) não se cancela por aqui: é direito
// já exercido, e o pedido fica visível até o PSP confirmar.
// Pertence a uma desistência o pedido criado por ela E o pedido que já
// estava aberto quando o cliente desistiu (ganhou `arrependimento_id`).
const daDesistencia = (pedido) => pedido.tipo === 'desistencia' || pedido.arrependimento_id != null;

async function cancelar({ estornoId, motivo, operador }) {
  const motivoLimpo = validarMotivo(motivo);
  const id = Number(estornoId) || 0;
  const { rows } = await pool.query('SELECT * FROM estornos WHERE id = $1', [id]);
  if (!rows[0]) throw new ErroEstorno(404, 'estorno não encontrado');
  const recusa = (pedido) =>
    daDesistencia(pedido)
      ? new ErroEstorno(409, 'a devolução de uma desistência não se cancela pelo painel')
      : new ErroEstorno(409, 'só um estorno ainda solicitado pode ser cancelado');
  if (daDesistencia(rows[0])) throw recusa(rows[0]);
  // As condições vão no próprio UPDATE: uma desistência que adota este
  // pedido no meio do caminho (revisão Codex do PR #130) faz o
  // cancelamento não pegar nada, em vez de deixá-la sem pedido aberto.
  const { rows: feitos } = await pool.query(
    `UPDATE estornos SET status = 'cancelado', cancelado_por = $2, cancelado_motivo = $3, cancelado_em = now()
      WHERE id = $1 AND status = 'solicitado' AND tipo <> 'desistencia' AND arrependimento_id IS NULL RETURNING *`,
    [id, operador || null, motivoLimpo],
  );
  if (feitos[0]) return feitos[0];
  const { rows: agora } = await pool.query('SELECT * FROM estornos WHERE id = $1', [id]);
  throw recusa(agora[0]);
}

// Os dias que um ciclo pago pôs na fila guardada: a mesma conta da fila
// (plano-administrativo.js#aplicarPagamentoNaFila), a partir do dia em que
// ele entrou.
const diasNaFila = (ciclo) =>
  planoAdministrativo.diasDeMeses(ciclo.ciclo_meses, vigencia.hojeComercial(new Date(ciclo.criado_em)));

// Tira `dias` da fila guardada; zerou, a fila some.
async function tirarDaFila(db, anuncianteId, dias) {
  await db.query(
    `UPDATE anunciantes
        SET plano_pago_guardado_dias = CASE WHEN plano_pago_guardado_dias > $2 THEN plano_pago_guardado_dias - $2 END,
            plano_pago_guardado_id = CASE WHEN plano_pago_guardado_dias > $2 THEN plano_pago_guardado_id END
      WHERE id = $1`,
    [anuncianteId, dias],
  );
}

// Efeito do estorno TOTAL confirmado (decisão do dono, 09/10/2026): o ciclo
// pago por esta cobrança é desfeito — o lote de horas sai (reembolso, a
// regra que já existia) e a cobertura daquele ciclo sai. Não cancela a
// assinatura, não suspende a conta. Parcial nunca chega aqui: é só dinheiro.
// Devolve avisos para a fila do Admin quando algo não pôde ser ajustado
// sozinho (nunca adivinha).
async function aplicarEstornoTotal(db, cobranca, motivo, { coberturaJaDesfeita = false } = {}) {
  const avisos = [];
  // Acerto de troca de plano: a decisão de voltar ou não ao plano anterior é
  // de pessoa (pendência `troca_revertida`), não daqui.
  if (cobranca.plano_anterior_id) return avisos;

  await obrigacaoDoCiclo.registrarReembolsoDaCobranca(db, { cobrancaId: cobranca.id, motivo });

  const {
    rows: [ciclo],
  } = await db.query(
    'SELECT ciclo_meses, assinatura_id, criado_em FROM ciclos_contratados WHERE cobranca_confirmada_id = $1',
    [cobranca.id],
  );
  const {
    rows: [conta],
  } = await db.query(
    `SELECT id, plano_id, plano_cortesia, data_expiracao, plano_pago_guardado_id, plano_pago_guardado_dias
       FROM anunciantes WHERE id = $1 FOR UPDATE`,
    [cobranca.anunciante_id],
  );
  if (!ciclo || !conta) return avisos;
  // Devolução de uma desistência: a cobertura do contrato (ou a fila guardada
  // dele) já foi desfeita no pedido (src/titular/routes.js) — tirar de novo
  // comeria os dias pagos do contrato anterior que ela preservou.
  if (coberturaJaDesfeita) return avisos;
  // A cobertura de agora só contém este ciclo se ela vem da MESMA assinatura
  // (renovações dela se empilham). Ciclo de uma assinatura antiga — o cliente
  // cancelou e voltou ao mesmo plano depois — não encolhe a cobertura paga
  // pela nova (revisão Codex do PR #130).
  const {
    rows: [ultimo],
  } = await db.query('SELECT assinatura_id FROM ciclos_contratados WHERE anunciante_id = $1 ORDER BY id DESC LIMIT 1', [
    cobranca.anunciante_id,
  ]);
  const mesmaCobertura = !!ciclo.assinatura_id && ultimo?.assinatura_id === ciclo.assinatura_id;
  // Benefício em vigor: os dias pagos esperam na fila (`plano_pago_guardado_*`)
  // e entrariam quando o benefício acabasse. O ciclo devolvido sai dela — os
  // dias que ELE pôs, pela mesma conta da fila a partir do dia em que entrou
  // (revisão Codex do PR #130). O benefício não muda: é pago com créditos,
  // não com o dinheiro devolvido.
  if (conta.plano_cortesia && conta.plano_pago_guardado_id === cobranca.plano_id && mesmaCobertura) {
    await tirarDaFila(db, conta.id, diasNaFila(ciclo));
    return avisos;
  }
  if (!conta.data_expiracao) return avisos; // nada pago em vigor (ex.: desistência já zerou)
  if (conta.plano_cortesia || conta.plano_id !== cobranca.plano_id || !mesmaCobertura) {
    avisos.push(
      'estorno total confirmado — horas do ciclo revertidas; a cobertura NÃO foi ajustada sozinha (a conta está em benefício, em outro plano ou em outra assinatura agora) — revisar',
    );
    return avisos;
  }
  const {
    rows: [{ nova }],
  } = await db.query(`SELECT ($1::date - make_interval(months => $2))::date::text AS nova`, [
    vigencia.diaTexto(conta.data_expiracao),
    ciclo.ciclo_meses,
  ]);
  // A cobertura encolhe o tamanho do ciclo devolvido (o último dia é
  // inclusivo, src/lib/vigencia.js). Se o que sobra acabaria HOJE, era este
  // o ciclo em vigor: ela acaba agora (ontem como último dia) e a rotina
  // diária encerra o plano vencido.
  // limite: uma renovação devolvida exatamente no último dia do ciclo
  // anterior perde o resto desse dia — distinguir pediria guardar a
  // cobertura de antes de cada ciclo.
  const hoje = vigencia.hojeComercial();
  const fim = nova === hoje ? vigencia.somarDias(hoje, -1) : nova;
  await db.query('UPDATE anunciantes SET data_expiracao = $2 WHERE id = $1', [conta.id, fim]);
  return avisos;
}

// O PSP avisou que o dinheiro de uma cobrança voltou (webhook
// `cobranca_estornada`, ou `troca_revertida` com estorno, contrato v2). É a
// ÚNICA porta para 'confirmado'. Idempotente: o valor acumulado só anda pra
// frente (aviso repetido ou fora de ordem não muda nada).
// Devolve { semCobranca } quando o chargeId não é de nenhuma cobrança daqui
// (ainda — quem chama decide se tenta de novo), ou { avisos, confirmado }
// para quem chama registrar na fila do Admin.
async function registrarEstornoDoPsp(payload) {
  const chargeId = String(payload.chargeId || '');
  const status = payload.statusFinanceiro;
  if (!chargeId) return { semCobranca: true };
  if (status !== 'estornado' && status !== 'estornado_parcialmente') {
    return { avisos: [`estorno com status '${status}' — sem ação automática`] };
  }
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const {
      rows: [cobranca],
    } = await cliente.query('SELECT * FROM cobrancas_confirmadas WHERE charge_id = $1 FOR UPDATE', [chargeId]);
    if (!cobranca) {
      await cliente.query('ROLLBACK');
      return { semCobranca: true };
    }
    const pago = centavos(cobranca.valor);
    const ja = centavos(cobranca.valor_estornado);
    let acumulado;
    if (status === 'estornado') acumulado = pago;
    else {
      const informado = Number(payload.valorEstornado);
      if (!Number.isFinite(informado) || informado <= 0) {
        await cliente.query('ROLLBACK');
        return { avisos: ['estorno parcial sem valorEstornado válido — conferir na Asaas'] };
      }
      acumulado = Math.min(centavos(informado), pago);
    }
    if (acumulado <= ja) {
      await cliente.query('ROLLBACK');
      return { avisos: [], repetido: true };
    }
    const novoStatus = acumulado >= pago ? 'estornado' : 'estornado_parcialmente';
    const delta = acumulado - ja;
    const eventoPsp = String(payload.eventoId || `${chargeId}|${novoStatus}|${acumulado}`).slice(0, 200);
    // Normalizado: um formato que o JS aceita e o Postgres não derrubaria a
    // confirmação inteira (e o webhook iria pra fila de mortos).
    const t = Date.parse(payload.ocorridoEm);
    const confirmadoEm = new Date(Number.isFinite(t) ? t : Date.now()).toISOString();

    await cliente.query('UPDATE cobrancas_confirmadas SET valor_estornado = $2, status_financeiro = $3 WHERE id = $1', [
      cobranca.id,
      reais(acumulado),
      novoStatus,
    ]);

    const avisos = [];
    const pedido = await pedidoAbertoDa(cliente, cobranca.id);
    let estorno;
    if (pedido) {
      ({
        rows: [estorno],
      } = await cliente.query(
        `UPDATE estornos SET status = 'confirmado', valor_confirmado = $2, psp_evento_id = $3, psp_charge_id = $4,
                confirmado_em = $5, status_financeiro_depois = $6
          WHERE id = $1 RETURNING *`,
        [pedido.id, reais(delta), eventoPsp, chargeId, confirmadoEm, novoStatus],
      ));
      if (delta !== centavos(pedido.valor)) {
        avisos.push(
          `estorno confirmado pela Asaas com R$ ${reais(delta).toFixed(2)}, mas o pedido era de R$ ${Number(pedido.valor).toFixed(2)} — conferir`,
        );
      }
    } else {
      ({
        rows: [estorno],
      } = await cliente.query(
        `INSERT INTO estornos (cobranca_id, anunciante_id, tipo, valor, motivo, status, status_financeiro_antes,
                               status_financeiro_depois, valor_confirmado, psp_charge_id, psp_evento_id, confirmado_em)
         VALUES ($1,$2,'externo',$3,$4,'confirmado',$5,$6,$3,$7,$8,$9) RETURNING *`,
        [
          cobranca.id,
          cobranca.anunciante_id,
          reais(delta),
          'devolução feita direto na Asaas, sem pedido no Admin da Mostraí',
          cobranca.status_financeiro,
          novoStatus,
          chargeId,
          eventoPsp,
          confirmadoEm,
        ],
      ));
      avisos.push(
        `estorno de R$ ${reais(delta).toFixed(2)} feito direto na Asaas, sem pedido no Admin — registrado; conferir o motivo`,
      );
    }

    if (novoStatus === 'estornado') {
      avisos.push(
        ...(await aplicarEstornoTotal(cliente, cobranca, `estorno total da cobrança ${cobranca.id}`, {
          coberturaJaDesfeita: await deContratoDesistido(cliente, cobranca.id),
        })),
      );
    }

    await fecharDesistenciaAtendida(cliente, cobranca.anunciante_id);
    await cliente.query('COMMIT');
    return { avisos, confirmado: estorno, anuncianteId: cobranca.anunciante_id };
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

// Desistência (art. 49) atendida = nenhuma devolução dela esperando a Asaas E
// nada mais a voltar no contrato dela (cobranças pagas desde `contratado_em`)
// — inclusive cobrança sem chargeId, ou paga depois do pedido, que não vira
// pedido (só aviso) e por isso não pode fechar a desistência pelos outros
// pedidos. Fecha sozinha, nunca por clique: chamada na confirmação do PSP e
// na criação (quando já não havia nada a voltar).
async function fecharDesistenciaAtendida(db, anuncianteId) {
  // Trava a desistência ANTES de conferir, em comando separado: duas
  // confirmações simultâneas (duas cobranças dela) se enfileiram aqui, e a
  // segunda confere já vendo a primeira gravada — no mesmo comando, cada uma
  // via a outra ainda 'solicitado' e ninguém fechava.
  const { rows } = await db.query(
    "SELECT id FROM arrependimentos WHERE anunciante_id = $1 AND status = 'pendente' FOR UPDATE",
    [anuncianteId],
  );
  if (!rows[0]) return;
  await db.query(
    `UPDATE arrependimentos a
        SET status = 'estornado', estornado_em = now(),
            comprovante = (SELECT string_agg(e.psp_charge_id, ', ' ORDER BY e.id) FROM estornos e
                            WHERE e.arrependimento_id = a.id AND e.status = 'confirmado')
      WHERE a.id = $1
        AND NOT EXISTS (SELECT 1 FROM estornos e WHERE e.arrependimento_id = a.id AND e.status = 'solicitado')
        AND NOT EXISTS (SELECT 1 FROM cobrancas_confirmadas c
                         WHERE c.anunciante_id = a.anunciante_id
                           AND ${doContrato('c', 'a.contratado_em')}
                           AND c.status_financeiro IN ('confirmado', 'estornado_parcialmente')
                           AND c.valor > c.valor_estornado)`,
    [rows[0].id],
  );
}

// Um contrato é a fatia de ciclos entre o seu ciclo `compra` e o `compra`
// seguinte, por ASSINATURA: um ciclo é dele quando a assinatura dele nasceu
// nessa fatia (a comprada, ou a nova de uma troca de plano depois — a troca
// grava o primeiro ciclo dela). Renovação atrasada de uma assinatura
// ANTERIOR, paga depois da compra nova, tem a data dentro do contrato mas é
// do contrato velho; e a compra SEGUINTE (outro plano comprado antes da
// devolução confirmar) já é outro contrato (revisões Codex do PR #130).
// Compara ids de ciclo, não relógios.
const primeiroDaAssinatura = (ciclo) =>
  `COALESCE((SELECT min(p.id) FROM ciclos_contratados p WHERE p.assinatura_id = ${ciclo}.assinatura_id), ${ciclo}.id)`;
const compraDoContrato = (conta, desde) =>
  `(SELECT COALESCE(min(k.id), 0) FROM ciclos_contratados k JOIN cobrancas_confirmadas kc ON kc.id = k.cobranca_confirmada_id
     WHERE k.anunciante_id = ${conta} AND k.origem = 'compra' AND kc.pago_em >= ${desde})`;
// 0 sem compra no contrato (conta sem esse histórico): nada vem depois.
const compraSeguinte = (conta, compra) =>
  `(SELECT min(n.id) FROM ciclos_contratados n WHERE n.anunciante_id = ${conta} AND n.origem = 'compra'
       AND n.id > ${compra} AND ${compra} > 0)`;

// A cobrança `c` é do contrato que começou em `desde` (o pagamento do ciclo
// `compra` dele)? Paga desde então e com o ciclo dentro da fatia acima.
// Cobrança sem ciclo (acerto de troca) vale pela data: não tem assinatura pra
// conferir — até a compra seguinte.
function doContrato(c, desde) {
  const compra = compraDoContrato(`${c}.anunciante_id`, desde);
  const seguinte = compraSeguinte(`${c}.anunciante_id`, compra);
  return `${c}.pago_em >= ${desde}
    AND NOT EXISTS (
      SELECT 1 FROM ciclos_contratados dela
       WHERE dela.cobranca_confirmada_id = ${c}.id
         AND (${primeiroDaAssinatura('dela')} < ${compra}
              OR ${primeiroDaAssinatura('dela')} >= COALESCE(${seguinte}, 2147483647)))
    AND (EXISTS (SELECT 1 FROM ciclos_contratados dela WHERE dela.cobranca_confirmada_id = ${c}.id)
         OR NOT EXISTS (SELECT 1 FROM ciclos_contratados n JOIN cobrancas_confirmadas nc ON nc.id = n.cobranca_confirmada_id
                         WHERE n.id = ${seguinte} AND nc.pago_em <= ${c}.pago_em))`;
}

// A cobrança é de um contrato desistido (paga até o pedido)? A cobertura dele
// já foi desfeita no pedido (src/titular/routes.js) — tenha ou não pedido de
// estorno dela (sem chargeId na hora, vira aviso e a devolução chega sem
// pedido).
async function deContratoDesistido(db, cobrancaId) {
  const { rows } = await db.query(
    `SELECT 1 FROM arrependimentos a JOIN cobrancas_confirmadas c ON c.id = $1
      WHERE a.anunciante_id = c.anunciante_id AND c.pago_em <= a.pedido_em AND ${doContrato('c', 'a.contratado_em')}
      LIMIT 1`,
    [cobrancaId],
  );
  return rows.length > 0;
}

// Os ciclos do mesmo contrato (a fatia de `doContrato`, para ciclos). `null` quando
// não há ciclo `compra` desde `desde` — conta sem esse histórico: aí o
// contrato é a conta inteira, como sempre foi.
async function ciclosDoContrato(db, anuncianteId, desde) {
  const { rows } = await db.query(
    `WITH k AS (SELECT NULLIF(${compraDoContrato('$1', '$2::timestamptz')}, 0) AS id)
     SELECT k.id AS k, c.id, c.origem, c.ciclo_meses, c.plano_id, c.criado_em
       FROM k LEFT JOIN ciclos_contratados c
         ON c.anunciante_id = $1 AND c.id >= k.id
        AND ${primeiroDaAssinatura('c')} >= k.id
        AND ${primeiroDaAssinatura('c')} < COALESCE(${compraSeguinte('$1', 'k.id')}, 2147483647)`,
    [anuncianteId, desde],
  );
  if (!rows[0]?.k) return null;
  return rows.filter((r) => r.id != null);
}

// Desistência de um contrato quando a conta ainda tem dias PAGOS de um
// contrato anterior (cancelou com cobertura e comprou de novo): devolver este
// não tira aqueles. A cobertura volta ao fim que o anterior pagou — o fim de
// agora menos os meses pagos por este contrato —, no plano do anterior
// (revisão Codex do PR #130). `null` quando não sobra nada depois de hoje (o
// caso comum: primeira compra, ou a anterior já vencida). Compra de OUTRO
// plano (ou outra versão) começa hoje e já descarta, na própria compra, os
// dias do anterior (san-checkout.js, `calcularExpiracao`): aqui também não
// voltam.
// limite: o ciclo pago soma meses com `setMonth` (san-checkout.js) e aqui se
// subtrai com o calendário do Postgres — perto do fim do mês o fim devolvido
// pode variar uns dias; guardar a cobertura de antes de cada ciclo resolve
// isso e o caso do outro plano.
async function coberturaAnterior(db, { anuncianteId, desde, dataExpiracao }) {
  if (!dataExpiracao) return null;
  const ciclos = await ciclosDoContrato(db, anuncianteId, desde);
  if (!ciclos) return null;
  const meses = ciclos
    .filter((c) => c.origem === 'compra' || c.origem === 'renovacao')
    .reduce((t, c) => t + Number(c.ciclo_meses), 0);
  const {
    rows: [anterior],
  } = await db.query(
    'SELECT plano_id FROM ciclos_contratados WHERE anunciante_id = $1 AND NOT (id = ANY($2::int[])) ORDER BY id DESC LIMIT 1',
    [anuncianteId, ciclos.map((c) => c.id)],
  );
  if (!anterior) return null;
  const {
    rows: [{ fim }],
  } = await db.query('SELECT ($1::date - make_interval(months => $2))::date::text AS fim', [
    vigencia.diaTexto(dataExpiracao),
    meses,
  ]);
  return fim > vigencia.hojeComercial() ? { planoId: anterior.plano_id, fim } : null;
}

// Desistência com benefício em vigor (conta em cortesia): o pago deste
// contrato não está na cobertura de agora — espera GUARDADO atrás do
// benefício (plano-administrativo.js#aplicarPagamentoNaFila). Sai da fila só
// o que os ciclos dele puseram, pela mesma conta do estorno total; o
// benefício segue no ar (revisão Codex do PR #130). Fila vazia ou de outro
// plano não é deste contrato: vira aviso, nunca adivinha.
async function tirarContratoDaFila(db, { anuncianteId, desde }) {
  const pagos = ((await ciclosDoContrato(db, anuncianteId, desde)) || []).filter(
    (c) => c.origem === 'compra' || c.origem === 'renovacao',
  );
  const {
    rows: [conta],
  } = await db.query('SELECT plano_pago_guardado_id FROM anunciantes WHERE id = $1', [anuncianteId]);
  if (!pagos.some((c) => c.plano_id === conta?.plano_pago_guardado_id)) {
    return [
      'desistência com benefício em vigor: os dias pagos deste contrato não estão na fila guardada — conferir a cobertura à mão',
    ];
  }
  await tirarDaFila(
    db,
    anuncianteId,
    pagos.reduce((t, c) => t + diasNaFila(c), 0),
  );
  return [];
}

// Chargeback numa cobrança: o dinheiro está em disputa — estado próprio,
// que não é estorno (não confirma pedido nenhum, não desfaz ciclo). A
// suspensão da conta continua no webhook, como antes. Um pedido de estorno
// ainda aberto fica EM ESPERA (a tela lê a situação da cobrança): devolvê-lo
// na Asaas agora devolveria o dinheiro duas vezes, porque o banco do
// cliente já está devolvendo pela disputa. Não se cancela sozinho: a disputa
// não tem evento de fim, e o que fazer depois dela é decisão de pessoa —
// daí o aviso pra fila do Admin (revisão Codex do PR #130).
// Devolve { semCobranca } quando o chargeId não é de nenhuma cobrança daqui.
async function marcarContestada(chargeId) {
  if (!chargeId) return { semCobranca: true };
  const {
    rows: [cobranca],
  } = await pool.query('SELECT id FROM cobrancas_confirmadas WHERE charge_id = $1', [String(chargeId)]);
  if (!cobranca) return { semCobranca: true };
  await pool.query(
    `UPDATE cobrancas_confirmadas SET status_financeiro = 'contestado'
      WHERE id = $1 AND status_financeiro IN ('confirmado', 'estornado_parcialmente')`,
    [cobranca.id],
  );
  const {
    rows: [pedido],
  } = await pool.query("SELECT valor FROM estornos WHERE cobranca_id = $1 AND status = 'solicitado'", [cobranca.id]);
  const avisos = pedido
    ? [
        `chargeback numa cobrança com estorno pedido (R$ ${Number(pedido.valor).toFixed(2)}) — NÃO devolver na Asaas enquanto a disputa corre; o pedido fica em espera`,
      ]
    : [];
  return { cobrancaId: cobranca.id, avisos };
}

// Desistência (art. 49) pela trilha nova: cada cobrança da conta que ainda
// tem dinheiro a voltar vira um pedido 'desistencia' (ou o pedido que já
// estava aberto passa a contar pra ela). O cliente só PEDIU; quem devolve é
// o operador na Asaas, e quem confirma é o PSP. Cobrança sem chargeId não
// tem como ser confirmada: vira aviso pro Admin, não pedido mudo.
async function solicitarDevolucoesDaDesistencia(db, { anuncianteId, desde, arrependimentoId, motivo }) {
  const { rows: cobrancas } = await db.query(
    `SELECT c.* FROM cobrancas_confirmadas c
      WHERE c.anunciante_id = $1 AND ${doContrato('c', '$2::timestamptz')}
        AND c.status_financeiro IN ('confirmado', 'estornado_parcialmente')
      ORDER BY c.pago_em FOR UPDATE OF c`,
    [anuncianteId, desde],
  );
  const avisos = [];
  for (const c of cobrancas) {
    const aberto = await pedidoAbertoDa(db, c.id);
    if (aberto) {
      await db.query('UPDATE estornos SET arrependimento_id = $2 WHERE id = $1 AND arrependimento_id IS NULL', [
        aberto.id,
        arrependimentoId,
      ]);
      // Um pedido aberto por cobrança (índice único): se o que já estava
      // pedido é menos que o restante, o resto só pode ser pedido depois que
      // a Asaas confirmar este — a desistência fica aberta até lá.
      const falta = restanteCentavos(c, aberto);
      if (falta > 0) {
        avisos.push(
          `desistência: cobrança ${c.id} já tinha pedido de R$ ${Number(aberto.valor).toFixed(2)}; faltam R$ ${reais(falta).toFixed(2)} — pedir o resto quando a Asaas confirmar`,
        );
      }
      continue;
    }
    const restante = restanteCentavos(c, null);
    if (restante <= 0) continue;
    if (!c.charge_id) {
      avisos.push(
        `desistência: cobrança ${c.id} (R$ ${reais(restante).toFixed(2)}) sem chargeId — devolver na Asaas e conferir à mão`,
      );
      continue;
    }
    await db.query(
      `INSERT INTO estornos (cobranca_id, anunciante_id, tipo, valor, motivo, solicitado_por, arrependimento_id,
                             status_financeiro_antes, psp_charge_id)
       VALUES ($1,$2,'desistencia',$3,$4,'cliente (desistência no painel)',$5,$6,$7)`,
      [c.id, anuncianteId, reais(restante), motivo, arrependimentoId, c.status_financeiro, c.charge_id],
    );
  }
  await fecharDesistenciaAtendida(db, anuncianteId);
  return avisos;
}

// O que ainda pode voltar das cobranças do contrato atual (`doContrato`: o
// que começou em `desde`, a cobrança que o abriu), já descontado o que o PSP
// confirmou. É o "valor integral" da desistência — sem contar duas vezes o
// que já voltou, nem o contrato anterior.
async function restanteDesde(anuncianteId, desde, db = pool) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(c.valor - c.valor_estornado), 0) AS total FROM cobrancas_confirmadas c
      WHERE c.anunciante_id = $1 AND ${doContrato('c', '$2::timestamptz')}
        AND c.status_financeiro IN ('confirmado', 'estornado_parcialmente')`,
    [anuncianteId, desde],
  );
  return Number(rows[0].total);
}

module.exports = {
  ErroEstorno,
  elegibilidade,
  solicitar,
  cancelar,
  registrarEstornoDoPsp,
  marcarContestada,
  solicitarDevolucoesDaDesistencia,
  restanteDesde,
  ciclosDoContrato,
  coberturaAnterior,
  tirarContratoDaFila,
};
