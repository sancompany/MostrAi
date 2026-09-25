const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const notificacoesRepo = require('../creditos/notificacoes');
const sse = require('../lib/sse');

const dataBR = (iso) => `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}/${String(iso).slice(0, 4)}`;

// Notificação + SSE depois do COMMIT, sem derrubar o job se o aviso falhar.
// Esperada (não solta): quem chama só termina com o aviso gravado — antes
// a gravação corria depois do retorno, e uma exclusão logo em seguida
// (teste, ou limpeza) esbarrava na FK (achado de 25/09/2026, CI do main).
async function avisarConta(contaId, notificacao) {
  await notificacoesRepo
    .registrar(contaId, notificacao)
    .catch((err) => console.error('falha ao notificar benefício', err.message));
  sse.emitirParaConta(contaId, 'plan.updated', {});
  sse.emitirParaConta(contaId, 'credits.updated', {});
}

// PLANO ADMINISTRATIVO (reconstrução de Contas, 23/09/2026, Partes 12-17).
//
// Plano concedido pelo admin é BENEFÍCIO/CORTESIA: nunca passa pelo San
// Checkout, nunca gera cobrança, Pix, cartão, fatura, receita ou MRR. O que
// o torna invisível pra receita é o mesmo `plano_cortesia = true` de sempre
// (src/admin/routes.js já exclui). Regra da troca (Parte 15): a conta tem UM
// plano comercial vigente — conceder encerra o anterior, guarda histórico e
// ativa o novo. Sem diferença, sem troca paga, sem reembolso automático.
//
// Assinatura paga que estiver ativa é cancelada ANTES, pela mesma lógica
// segura que já existia (San Checkout primeiro, marca local só se ele
// confirmar — ver POST /admin/anunciantes/:id/cancelar-assinatura). Quem
// chama faz isso; este módulo só mexe no banco, numa transação.

const TIERS_COMERCIAIS = new Set(['essencial', 'destaque', 'maximo']);

// De onde vem o plano comercial que está na conta agora. Nunca 'comodato':
// ser ponto não é plano (ADR-016, 24/09/2026) — `comodato_plano_id` ficou
// no banco só como histórico.
function origemDoPlano(conta) {
  if (!conta?.plano_id) return null;
  return conta.plano_cortesia ? 'cortesia' : 'assinatura';
}

// De onde vem o DIREITO comercial que está na conta agora, com o nome que a
// ficha e a lista de Contas mostram (revisão da ficha de Conta, 23/09/2026).
// `origemDoPlano` acima continua a régua binária gravada no histórico
// (`plano_anterior_origem`); esta distingue as cortesias entre si, por fato
// gravado: a linha 'ativo' de `planos_administrativos` do MESMO plano diz se
// veio de resgate de créditos (origem 'indicacao') ou de concessão direta do
// admin (o antigo "Conceder plano", hoje legado). Sem linha: `liberar-plano`
// antigo ou o bônus de tempo de ponto — os dois legados.
const ORIGENS_DO_DIREITO = {
  assinatura: 'Assinatura paga',
  beneficio_creditos: 'Benefício por créditos',
  cortesia_legada: 'Cortesia administrativa legada',
  bonus_ponto: 'Bônus de ponto legado',
};

function origemDoDireito(conta, beneficioAtivo) {
  if (!conta?.plano_id) return null;
  if (!conta.plano_cortesia) return 'assinatura';
  if (beneficioAtivo && beneficioAtivo.plano_id === conta.plano_id) {
    return beneficioAtivo.origem === 'indicacao' ? 'beneficio_creditos' : 'cortesia_legada';
  }
  if (conta.cortesia_motivo === 'bônus de ponto') return 'bonus_ponto';
  return 'cortesia_legada';
}

// `validoAte`: 'AAAA-MM-DD'. Vai pra `data_expiracao`, que é `date` — por
// isso segue como texto, nunca como Date do JS (um Date às 23:59 de Brasília
// já é o dia seguinte em UTC, e o banco gravaria um dia a mais). Devolve a
// própria string se for uma data real e ainda não tiver passado (o dia
// termina às 23:59:59 de Brasília, fuso de toda a operação); senão, null.
function validadeValida(validoAte) {
  const texto = String(validoAte || '');
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!partes) return null;
  const [, a, m, d] = partes.map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d));
  // 30/02 vira 02/03 no Date — data que não existe é recusada, não "corrigida".
  if (dia.getUTCFullYear() !== a || dia.getUTCMonth() !== m - 1 || dia.getUTCDate() !== d) return null;
  return texto >= hojeISO() ? texto : null;
}

// Encerra as linhas de histórico ainda abertas da conta.
async function fecharAbertos(db, contaId, motivo, adminUsuario) {
  // `status = 'encerrado'` (migration 079) tem que andar junto de
  // `encerrado_em` sempre — os dois eram uma coisa só até essa migration
  // (linha aberta = `encerrado_em IS NULL`); agora que `status` também
  // decide as travas de "no máximo 1 ativo/1 agendado por conta"
  // (`idx_planos_admin_um_ativo`/`_um_agendado`), esquecer de atualizar um
  // dos dois deixa a linha velha colidindo com a nova no mesmo estado.
  await db.query(
    `UPDATE planos_administrativos
        SET encerrado_em = now(), encerrado_por = $3, encerrado_motivo = $2, status = 'encerrado'
      WHERE anunciante_id = $1 AND encerrado_em IS NULL`,
    [contaId, motivo, adminUsuario || null],
  );
}

async function comTransacao(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

// Concede (ou troca por) um benefício administrativo. `conta` é a linha
// lida ANTES de qualquer cancelamento de assinatura — é dela que sai o
// "plano anterior" gravado no histórico.
async function conceder({ conta, plano, validoAte, observacao, adminUsuario }) {
  return comTransacao(async (db) => {
    await fecharAbertos(db, conta.id, 'substituido', adminUsuario);
    const { rows: historico } = await db.query(
      `INSERT INTO planos_administrativos
         (anunciante_id, plano_id, valido_ate, observacao, concedido_por, plano_anterior_id, plano_anterior_origem)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        conta.id,
        plano.id,
        validoAte,
        observacao || null,
        adminUsuario || null,
        conta.plano_id || null,
        origemDoPlano(conta),
      ],
    );
    const { rows } = await db.query(
      `UPDATE anunciantes
          SET plano_id = $2, plano_cortesia = true, cortesia_motivo = $3,
              data_inicio_cobertura = now(), data_expiracao = $4
        WHERE id = $1 RETURNING *`,
      // Nunca grava só a observação: se o admin digitasse "comodato", a conta
      // passaria a ser lida como comodato (origemDoPlano, admin, painel).
      [
        conta.id,
        plano.id,
        observacao ? `Cortesia administrativa: ${observacao}` : 'Cortesia administrativa',
        validoAte,
      ],
    );
    return { conta: rows[0], historico: historico[0] };
  });
}

// Encerra o plano comercial vigente agora. Histórico preservado.
//
// `motivo`: 'cancelado' é o botão da ficha (admin decidiu agora, com
// `adminUsuario`); 'vencido' é a conciliação diária encerrando sozinha uma
// cobertura que passou da validade, sem suspender a conta por isso
// (`src/financeiro/conciliacao.js#encerrarCoberturaVencida`, migration 078
// — "suspensão só pelo admin, plano vencido cancela sozinho").
async function encerrar({ conta, adminUsuario, motivo = 'cancelado' }) {
  return comTransacao(async (db) => {
    // 'vencido' (a conciliação diária, nunca o admin): a linha que alimentou
    // `encerrarCoberturaVencida` foi lida numa SELECT separada, antes desta
    // transação — um webhook de pagamento pode ter renovado a cobertura
    // (`cobranca_confirmada`) bem nesse intervalo. Sem reconferir aqui, esta
    // UPDATE apagaria um plano que acabou de ser pago de novo (achado real,
    // revisão de 23/09/2026). `FOR UPDATE` trava a linha: se o webhook
    // estiver no meio da própria transação de renovação, esta espera ele
    // terminar antes de decidir, em vez de correr por cima.
    if (motivo === 'vencido') {
      const { rows: aindaVencido } = await db.query(
        `SELECT id FROM anunciantes
          WHERE id = $1 AND plano_id IS NOT NULL AND ${vigencia.vencidaSql('data_expiracao')}
          FOR UPDATE`,
        [conta.id],
      );
      if (!aindaVencido.length) {
        const { rows: fresca } = await db.query('SELECT * FROM anunciantes WHERE id = $1', [conta.id]);
        return fresca[0] || null;
      }
    }
    await fecharAbertos(db, conta.id, motivo, adminUsuario);
    // Plano pago guardado por baixo de uma cortesia (migration 082): os dias
    // são do cliente — encerrar a cortesia devolve o pago, nunca apaga.
    const { rows } = await db.query(
      `UPDATE anunciantes
          SET plano_id = plano_pago_guardado_id,
              plano_cortesia = false,
              cortesia_motivo = NULL,
              data_expiracao = CASE WHEN plano_pago_guardado_id IS NULL THEN NULL
                                    ELSE ${vigencia.HOJE_SQL} + plano_pago_guardado_dias END,
              plano_pago_guardado_id = NULL,
              plano_pago_guardado_dias = NULL
        WHERE id = $1 RETURNING *`,
      [conta.id],
    );
    return rows[0];
  });
}

// Benefício pago com CRÉDITOS (resgate) ainda aberto — em vigor ou
// programado. As rotas técnicas de plano (conceder direto, encerrar,
// liberar-plano) recusam mexer por cima dele: fechar como "substituído" ou
// "cancelado" jogava fora, em silêncio, os créditos que o cliente já pagou
// (aconteceu em produção em 23/09/2026 — 120 créditos de um Prime anual
// substituídos 42 s depois por uma cortesia administrativa).
async function beneficioPorCreditosAberto(contaId, db = pool) {
  const { rows } = await db.query(
    `SELECT * FROM planos_administrativos
      WHERE anunciante_id = $1 AND status IN ('ativo', 'agendado') AND origem = 'indicacao'
      ORDER BY id DESC LIMIT 1`,
    [contaId],
  );
  return rows[0] || null;
}

async function historicoDaConta(contaId) {
  const { rows } = await pool.query(
    `SELECT h.*, p.nome AS plano_nome, p.tier, p.compromisso_meses
       FROM planos_administrativos h JOIN planos p ON p.id = h.plano_id
      WHERE h.anunciante_id = $1
      ORDER BY h.created_at DESC, h.id DESC`,
    [contaId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Ciclo de vida do benefício por créditos (migration 079, reconstrução do
// painel da conta, 23/09/2026)
//
// `conceder`/`encerrar` acima continuam os únicos dois jeitos de mudar o
// que está gravado em `anunciantes.plano_id` por benefício — a diferença é
// que, a partir daqui, quem decide SE aplica agora ou agenda pra depois é
// este bloco, nunca mais quem chama.
//
// REGRA (pedido do dono): um ciclo pago em curso sempre termina
// integralmente — nunca é interrompido no meio, e a conta nunca é cobrada
// duas vezes (a assinatura de verdade continua sem renovar, cancelada por
// quem chamou ANTES de chegar aqui — mesma rota admin de sempre). Sem
// assinatura paga em curso, o benefício entra em vigor na hora, como
// `conceder()` sempre fez.
//
// limite (deliberado, registrado aqui por decisão de escopo): retomar a
// COBRANÇA de verdade sozinho ao fim do benefício exigiria confirmar no
// contrato do San Checkout uma operação de pausa/retomada de assinatura que
// este projeto ainda não tem lida na fonte (docs/erros/2026-09-14-
// contrato-do-checkout-suposto-em-vez-de-lido.md é a lição exata sobre não
// supor esse contrato). Por isso, quando o benefício termina e não há outro
// agendado, a conta volta pra "sem plano" — nunca uma cobrança nova é
// disparada sozinha. O histórico (`plano_anterior_id`/
// `plano_anterior_valido_ate`) fica registrado pra quem for reativar saber
// exatamente o que a conta tinha, e o card de plano no painel convida a
// assinar de novo. Ver relatório final da sessão pra esse ponto.
async function resgatarOuConcederBeneficio(
  { conta, plano, validoAte: validoAteInformado, diasDeBeneficio, observacao, adminUsuario, origem, ledgerId },
  dbExterno,
) {
  const executar = async (db) => {
    await fecharAbertos(db, conta.id, 'substituido', adminUsuario);
    // Mesma fórmula de "pagando em dia" de financeiro/routes.js — um ciclo
    // pago (não cortesia) ainda não vencido.
    const pagandoEmDia =
      conta.plano_id &&
      !conta.plano_cortesia &&
      conta.data_expiracao &&
      vigencia.coberturaVigente(conta.data_expiracao);
    const status = pagandoEmDia ? 'agendado' : 'ativo';
    // Duração em dias (resgate de créditos): a validade conta a partir do dia
    // em que o benefício COMEÇA, não do dia do resgate. Antes o agendado
    // recebia "hoje + N dias" e, se o ciclo pago terminasse depois disso,
    // nascia já vencido — a conta pagava os créditos e não recebia nada.
    const validoAte = diasDeBeneficio
      ? somarDias(pagandoEmDia ? conta.data_expiracao : hojeISO(), diasDeBeneficio)
      : validoAteInformado;
    const { rows: historico } = await db.query(
      `INSERT INTO planos_administrativos
         (anunciante_id, plano_id, valido_ate, observacao, concedido_por, plano_anterior_id,
          plano_anterior_origem, plano_anterior_valido_ate, status, ativado_em, origem, ledger_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        conta.id,
        plano.id,
        validoAte,
        observacao || null,
        adminUsuario || null,
        conta.plano_id || null,
        origemDoPlano(conta),
        pagandoEmDia ? conta.data_expiracao : null,
        status,
        pagandoEmDia ? null : new Date(),
        origem,
        ledgerId || null,
      ],
    );
    let atualizada = conta;
    if (status === 'ativo') {
      const { rows } = await db.query(
        `UPDATE anunciantes
            SET plano_id = $2, plano_cortesia = true, cortesia_motivo = $3,
                data_inicio_cobertura = now(), data_expiracao = $4
          WHERE id = $1 RETURNING *`,
        [conta.id, plano.id, observacao ? `Benefício: ${observacao}` : 'Benefício por créditos', validoAte],
      );
      atualizada = rows[0];
    }
    // 'agendado' não muda `anunciantes` agora — a conta continua no plano
    // pago (ou sem plano, se nunca teve) até a reavaliação diária ativar.
    return { conta: atualizada, historico: historico[0], status };
  };
  return dbExterno ? executar(dbExterno) : comTransacao(executar);
}

// ---------------------------------------------------------------------------
// PRIORIDADE ENTRE PLANO PAGO E BENEFÍCIO (24/09/2026, ADR-016)
//
// Um plano comercial efetivo por vez, ordenado por nível: Essencial 1, Pro 2,
// Prime 3. Nunca diminuir o serviço na hora; nunca sobrepor dois do mesmo
// nível. A matriz (regras 24-30 do pedido do dono):
//   · pago de nível MAIOR que o benefício em vigor → o pago entra na hora e o
//     benefício é encerrado ('superado_por_plano_pago'), sem devolver
//     créditos (o cliente confirma isso antes de pagar — /assinar);
//   · pago de nível IGUAL ou MENOR → o benefício continua; o pago fica
//     GUARDADO (`plano_pago_guardado_*`) e começa quando o benefício acabar;
//   · benefício PROGRAMADO de nível menor que o novo pago é encerrado (não
//     pode ficar na fila pra reduzir o plano depois); igual ou maior fica.
// Cortesia administrativa legada conta como benefício, pelo nível do plano.
const NIVEL_TIER = { essencial: 1, destaque: 2, maximo: 3 };
const nivelDoTier = (tier) => NIVEL_TIER[tier] || 0;

const { diaTexto } = vigencia;

// Dias inteiros de hoje (Matão) até `dataISO` (0 se já passou).
function diasAte(dataISO) {
  return Math.max(0, vigencia.diasAteVencer(dataISO));
}

// Dias que `meses` de calendário valem a partir de hoje (mesma aritmética de
// `setMonth` que o ciclo pago já usa).
function diasDeMeses(meses) {
  const hoje = new Date(`${hojeISO()}T00:00:00Z`);
  const fim = new Date(hoje);
  fim.setUTCMonth(fim.getUTCMonth() + Number(meses));
  return Math.round((fim - hoje) / 86400000);
}

// Benefício em vigor na conta (resgate, ou cortesia legada) com o nível dele.
async function beneficioEmVigor(db, conta) {
  if (!conta?.plano_id || !conta.plano_cortesia) return null;
  // Venceu e a rotina diária ainda não limpou: não é mais benefício em vigor.
  if (conta.data_expiracao && String(diaTexto(conta.data_expiracao)) < hojeISO()) return null;
  const {
    rows: [linha],
  } = await db.query(
    `SELECT h.*, p.tier, p.nome AS plano_nome FROM planos_administrativos h JOIN planos p ON p.id = h.plano_id
      WHERE h.anunciante_id = $1 AND h.status = 'ativo' AND h.plano_id = $2 ORDER BY h.id DESC LIMIT 1`,
    [conta.id, conta.plano_id],
  );
  const {
    rows: [plano],
  } = await db.query('SELECT tier, nome FROM planos WHERE id = $1', [conta.plano_id]);
  return {
    linha: linha || null,
    planoId: conta.plano_id,
    planoNome: plano?.nome || null,
    nivel: nivelDoTier(plano?.tier),
    validoAte: conta.data_expiracao,
    porCreditos: linha?.origem === 'indicacao',
  };
}

// O que acontece com a fila se um plano PAGO `plano` for pago agora — a
// mesma decisão que `aplicarPagamentoNaFila` executa, só que sem gravar nada
// (é o que /assinar mostra pro cliente confirmar antes de pagar).
async function preverPagamento(conta, plano, db = pool) {
  const beneficio = await beneficioEmVigor(db, conta);
  if (!beneficio) return { tipo: 'imediato', beneficio: null };
  return nivelDoTier(plano.tier) > beneficio.nivel
    ? { tipo: 'encerra_beneficio', beneficio }
    : { tipo: 'depois_do_beneficio', beneficio };
}

// Aplica um ciclo pago na fila, DENTRO da transação de quem chama
// (san-checkout.js#aplicarCicloPago). `expiracaoSemBeneficio` é a data que o
// ciclo daria sem benefício nenhum no caminho (a conta de sempre: soma a
// partir do fim da cobertura paga, se ainda vale). Devolve o que aconteceu,
// pra quem chama notificar DEPOIS do COMMIT.
async function aplicarPagamentoNaFila(db, conta, plano, expiracaoSemBeneficio) {
  const meses = Number(plano.compromisso_meses) || 1;
  const beneficio = await beneficioEmVigor(db, conta);
  const eventos = [];

  if (beneficio && nivelDoTier(plano.tier) <= beneficio.nivel) {
    // Benefício igual ou maior segue; o pago espera, com o tempo guardado.
    await db.query(
      `UPDATE anunciantes
          SET plano_pago_guardado_id = $2,
              plano_pago_guardado_dias = COALESCE(plano_pago_guardado_dias, 0) + $3
        WHERE id = $1`,
      [conta.id, plano.id, diasDeMeses(meses)],
    );
    eventos.push({ tipo: 'pago_depois_do_beneficio', beneficio });
  } else {
    if (beneficio) {
      // Pago de nível maior: entra na hora e o benefício acaba. Créditos não
      // voltam — o cliente confirmou isso antes de pagar.
      if (beneficio.linha) {
        await db.query(
          `UPDATE planos_administrativos
              SET status = 'encerrado', encerrado_em = now(), encerrado_motivo = 'superado_por_plano_pago'
            WHERE id = $1`,
          [beneficio.linha.id],
        );
      }
      eventos.push({ tipo: 'beneficio_superado', beneficio });
    }
    // Pago que estava guardado por baixo (outro plano) não perde os dias:
    // somam no novo.
    const expiracao = beneficio
      ? somarDias(hojeISO(), diasDeMeses(meses) + Number(conta.plano_pago_guardado_dias || 0))
      : expiracaoSemBeneficio;
    await db.query(
      `UPDATE anunciantes
          SET plano_id = $2, suspenso = false,
              plano_cortesia = false, cortesia_motivo = NULL,
              data_inicio_cobertura = CASE WHEN $4 THEN ${vigencia.HOJE_SQL} ELSE COALESCE(data_inicio_cobertura, now()) END,
              data_expiracao = $3::timestamptz,
              plano_pago_guardado_id = NULL, plano_pago_guardado_dias = NULL
        WHERE id = $1`,
      [conta.id, plano.id, expiracao, !!beneficio],
    );
  }

  // Fila: benefício PROGRAMADO de nível menor que o pago nunca fica pra
  // reduzir o plano depois.
  const { rows: programadosMenores } = await db.query(
    `UPDATE planos_administrativos h
        SET status = 'encerrado', encerrado_em = now(), encerrado_motivo = 'superado_por_plano_pago'
       FROM planos p
      WHERE p.id = h.plano_id AND h.anunciante_id = $1 AND h.status = 'agendado'
        AND (CASE p.tier WHEN 'essencial' THEN 1 WHEN 'destaque' THEN 2 WHEN 'maximo' THEN 3 ELSE 0 END) < $2
      RETURNING h.id, p.nome AS plano_nome`,
    [conta.id, nivelDoTier(plano.tier)],
  );
  for (const linha of programadosMenores) eventos.push({ tipo: 'programado_superado', linha });
  return eventos;
}

// Datas em 'AAAA-MM-DD' (as colunas são `date`; o pool devolve texto — ver
// src/db/pool.js). "Hoje" é o dia de Matão e o último dia é inclusivo — a
// régua única de src/lib/vigencia.js.
const { hojeComercial: hojeISO, somarDias } = vigencia;

// Reavaliação diária (mesma rotina de sempre, scripts/conciliar.js) — duas
// passadas independentes, cada uma resolvendo um lado do ciclo de vida.

// 1) Ativa benefício agendado cujo ciclo pago anterior já passou. Não confia
// só no `plano_anterior_valido_ate` gravado: reconfere contra
// `anunciantes.data_expiracao` AGORA, porque a mesma trava que
// `encerrar(motivo='vencido')` já usa vale aqui — um webhook pode ter
// renovado a cobertura paga entre o agendamento e hoje, e nesse caso o
// benefício espera mais um ciclo, não atropela.
// `apenasContas` (opcional): restringe a varredura a essas contas — mesmo
// padrão do `apenasPontos` do crédito mensal. Produção não passa nada; os
// testes passam as próprias contas pra não mexer nas de outro arquivo que
// roda em paralelo no mesmo banco (achado do CI de 25/09/2026).
async function ativarBeneficiosAgendados({ apenasContas = null } = {}) {
  // `ha.plano_id` vem apelidado (`beneficio_plano_id`) de propósito: sem
  // isso colidiria com `anunciantes.plano_id` (o plano ATUAL da conta, não
  // o do benefício agendado) — os dois se chamam igual, e `a.*` depois de
  // `ha.plano_id` na mesma SELECT sobrescreveria silenciosamente.
  //
  // Reestruturação de 24/09/2026 (ADR-016, regra 32 do pedido): o benefício
  // começa NO FIM do ciclo pago em que foi resgatado (`plano_anterior_
  // valido_ate`), mesmo que a assinatura renove nesse meio-tempo. Antes ele
  // esperava a assinatura parar de renovar — com a recorrência ativa, nunca
  // começava. Agora o plano pago fica GUARDADO com os dias pagos que ainda
  // tinha (`plano_pago_guardado_*`, migration 082) e volta sozinho quando o
  // benefício termina; renovação paga durante o benefício soma nesses dias.
  const { rows: pendentes } = await pool.query(
    `SELECT ha.id AS historico_id, ha.anunciante_id, ha.plano_id AS beneficio_plano_id, ha.valido_ate, ha.observacao
       FROM planos_administrativos ha
       JOIN anunciantes a ON a.id = ha.anunciante_id
      WHERE ha.status = 'agendado'
        AND (ha.plano_anterior_valido_ate IS NULL
             -- estrito: o último dia do plano pago é inclusivo (RN-32-B), o
             -- benefício começa no dia seguinte, em Matão
             OR ha.plano_anterior_valido_ate < ${vigencia.HOJE_SQL}
             -- o ciclo pago acabou antes (cancelado, cobrança falhou e a
             -- conciliação limpou): o benefício não espera a data antiga.
             OR NOT (a.plano_id IS NOT NULL AND NOT a.plano_cortesia AND a.data_expiracao >= ${vigencia.HOJE_SQL}))
        AND ($1::int[] IS NULL OR ha.anunciante_id = ANY($1))`,
    [apenasContas],
  );
  let ativados = 0;
  for (const linha of pendentes) {
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const {
        rows: [conta],
      } = await cliente.query('SELECT * FROM anunciantes WHERE id = $1 FOR UPDATE', [linha.anunciante_id]);
      if (!conta) {
        await cliente.query('ROLLBACK');
        continue;
      }
      // A duração comprada é preservada mesmo se a ativação atrasou: a
      // validade anda junto com o início real.
      const {
        rows: [{ valido_ate: validoAte }],
      } = await cliente.query(
        `UPDATE planos_administrativos
            SET valido_ate = CASE WHEN plano_anterior_valido_ate IS NULL THEN valido_ate
                                  ELSE GREATEST(valido_ate, ${vigencia.HOJE_SQL} + (valido_ate - plano_anterior_valido_ate)) END,
                status = 'ativo', ativado_em = now()
          WHERE id = $1 RETURNING valido_ate`,
        [linha.historico_id],
      );
      // Plano PAGO em dia por baixo: guarda com os dias que ainda restam.
      const pagoEmDia =
        conta.plano_id &&
        !conta.plano_cortesia &&
        conta.data_expiracao &&
        vigencia.coberturaVigente(conta.data_expiracao);
      await cliente.query(
        `UPDATE anunciantes SET plano_id=$2, plano_cortesia=true,
                cortesia_motivo=$3, data_inicio_cobertura=now(), data_expiracao=$4,
                plano_pago_guardado_id = COALESCE($5, plano_pago_guardado_id),
                plano_pago_guardado_dias = CASE WHEN $5::text IS NULL THEN plano_pago_guardado_dias
                                                ELSE COALESCE(plano_pago_guardado_dias, 0) + $6 END
          WHERE id=$1`,
        [
          linha.anunciante_id,
          linha.beneficio_plano_id,
          linha.observacao ? `Benefício: ${linha.observacao}` : 'Benefício por créditos',
          validoAte,
          pagoEmDia ? conta.plano_id : null,
          pagoEmDia ? diasAte(conta.data_expiracao) : 0,
        ],
      );
      await cliente.query('COMMIT');
      ativados += 1;
      // O cliente fica sabendo que o benefício começou (sino + painel sem
      // F5) — antes o job ativava em silêncio e só o resgate imediato
      // avisava (consolidação final, 24/09/2026).
      await avisarConta(linha.anunciante_id, {
        tipo: 'beneficio_iniciado',
        titulo: 'Seu benefício começou',
        descricao: `Válido até ${dataBR(validoAte)}. Seu anúncio já está na rotação.`,
      });
    } catch (err) {
      await cliente.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      cliente.release();
    }
  }
  return { verificados: pendentes.length, ativados };
}

// 2) Encerra benefício ATIVO cujo `valido_ate` já passou. Se houver um
// próximo AGENDADO pra mesma conta, esse dia vira o dia dele de ativar (a
// passada 1 acima, no mesmo job diário, cobre isso: encerra aqui, ativa lá
// na volta seguinte — nunca no mesmo instante, sempre no próximo dia;
// aceitável porque o benefício expira à meia-noite do fuso do servidor,
// mesma granularidade de `valido_ate date` que todo o resto do projeto usa
// pra plano administrativo).
async function encerrarBeneficiosVencidos({ apenasContas = null } = {}) {
  const { rows: vencidos } = await pool.query(
    `SELECT ha.id, ha.anunciante_id, ha.plano_id FROM planos_administrativos ha
      WHERE ha.status = 'ativo' AND ha.valido_ate < ${vigencia.HOJE_SQL}
        AND ($1::int[] IS NULL OR ha.anunciante_id = ANY($1))`,
    [apenasContas],
  );
  let encerrados = 0;
  for (const linha of vencidos) {
    const conta = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [linha.anunciante_id]);
    if (!conta.rows[0]) continue;
    // A linha do histórico sempre fecha (venceu). A CONTA só volta pra "sem
    // plano" se ainda estiver neste benefício — cortesia, mesmo plano. O
    // comentário antigo já prometia essa cautela e o código não fazia (achado
    // na revisão da ficha de Conta, 23/09/2026): um cliente em benefício que
    // assinava um plano pago ficava com a linha 'ativo' esquecida, e no dia
    // em que ela vencia esta rotina zerava o plano PAGO dele. Condição dentro
    // do próprio UPDATE (não num SELECT antes) pra não correr com um webhook
    // de pagamento no meio.
    await comTransacao(async (db) => {
      await db.query(
        `UPDATE planos_administrativos SET status='encerrado', encerrado_em=now(), encerrado_motivo='vencido' WHERE id=$1`,
        [linha.id],
      );
      // Plano pago guardado por baixo do benefício (migration 082): volta
      // agora, com os dias pagos que tinha — "Pro pago → Prime benefício →
      // volta ao Pro". Sem plano guardado, a conta fica sem plano (nada é
      // cobrado sozinho).
      await db.query(
        `UPDATE anunciantes
            SET plano_id = plano_pago_guardado_id,
                plano_cortesia = false,
                cortesia_motivo = NULL,
                data_inicio_cobertura = CASE WHEN plano_pago_guardado_id IS NULL THEN data_inicio_cobertura ELSE ${vigencia.HOJE_SQL} END,
                data_expiracao = CASE WHEN plano_pago_guardado_id IS NULL THEN NULL
                                      ELSE ${vigencia.HOJE_SQL} + plano_pago_guardado_dias END,
                plano_pago_guardado_id = NULL,
                plano_pago_guardado_dias = NULL
          WHERE id=$1 AND plano_cortesia AND plano_id = $2`,
        [linha.anunciante_id, linha.plano_id],
      );
    });
    encerrados += 1;
    const voltouPago = !!conta.rows[0].plano_pago_guardado_id;
    await avisarConta(linha.anunciante_id, {
      tipo: 'beneficio_encerrado',
      titulo: 'Seu benefício terminou',
      descricao: voltouPago
        ? 'Seu plano pago voltou com os dias que ainda tinha.'
        : 'Pra continuar no ar, resgate créditos ou escolha um plano.',
    });
  }
  return { verificados: vencidos.length, encerrados };
}

module.exports = {
  TIERS_COMERCIAIS,
  ORIGENS_DO_DIREITO,
  origemDoPlano,
  origemDoDireito,
  validadeValida,
  conceder,
  encerrar,
  historicoDaConta,
  beneficioPorCreditosAberto,
  resgatarOuConcederBeneficio,
  NIVEL_TIER,
  nivelDoTier,
  preverPagamento,
  aplicarPagamentoNaFila,
  ativarBeneficiosAgendados,
  encerrarBeneficiosVencidos,
};
