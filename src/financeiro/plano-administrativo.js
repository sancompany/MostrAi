const pool = require('../db/pool');

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

// De onde vem o plano comercial que está na conta agora — nunca mais
// 'comodato' (migration 077, 23/09/2026): comodato tem campo próprio
// (`anunciantes.comodato_plano_id`), independente, e nenhum código escreve
// mais um produto de comodato em `plano_id`. Quem quer saber do comodato lê
// `comodato_plano_id` direto (ver ficha da conta no admin).
function origemDoPlano(conta) {
  if (!conta?.plano_id) return null;
  return conta.plano_cortesia ? 'cortesia' : 'assinatura';
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
  return new Date(`${texto}T23:59:59-03:00`) > new Date() ? texto : null;
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

// Encerra o plano comercial vigente agora. Só o plano COMERCIAL é encerrado
// (23/09/2026, decisão do dono e do GPT, migration 077): comodato mora em
// campo próprio e nunca é tocado por este fluxo — não existe "devolver
// comodato" porque ele nunca saiu. Histórico preservado.
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
          WHERE id = $1 AND plano_id IS NOT NULL AND data_expiracao IS NOT NULL AND data_expiracao < current_date
          FOR UPDATE`,
        [conta.id],
      );
      if (!aindaVencido.length) {
        const { rows: fresca } = await db.query('SELECT * FROM anunciantes WHERE id = $1', [conta.id]);
        return fresca[0] || null;
      }
    }
    await fecharAbertos(db, conta.id, motivo, adminUsuario);
    const { rows } = await db.query(
      `UPDATE anunciantes
          SET plano_id = NULL, plano_cortesia = false, cortesia_motivo = NULL, data_expiracao = NULL
        WHERE id = $1 RETURNING *`,
      [conta.id],
    );
    return rows[0];
  });
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
      conta.plano_id && !conta.plano_cortesia && conta.data_expiracao && new Date(conta.data_expiracao) > new Date();
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

// Datas em 'AAAA-MM-DD' (as colunas são `date`; o pool devolve texto — ver
// src/db/pool.js). Aritmética em UTC pra não escorregar um dia no fuso.
function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}
function somarDias(dataISO, dias) {
  const base = new Date(`${String(dataISO).slice(0, 10)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + Number(dias));
  return base.toISOString().slice(0, 10);
}

// Reavaliação diária (mesma rotina de sempre, scripts/conciliar.js) — duas
// passadas independentes, cada uma resolvendo um lado do ciclo de vida.

// 1) Ativa benefício agendado cujo ciclo pago anterior já passou. Não confia
// só no `plano_anterior_valido_ate` gravado: reconfere contra
// `anunciantes.data_expiracao` AGORA, porque a mesma trava que
// `encerrar(motivo='vencido')` já usa vale aqui — um webhook pode ter
// renovado a cobertura paga entre o agendamento e hoje, e nesse caso o
// benefício espera mais um ciclo, não atropela.
async function ativarBeneficiosAgendados() {
  // `ha.plano_id` vem apelidado (`beneficio_plano_id`) de propósito: sem
  // isso colidiria com `anunciantes.plano_id` (o plano ATUAL da conta, não
  // o do benefício agendado) — os dois se chamam igual, e `a.*` depois de
  // `ha.plano_id` na mesma SELECT sobrescreveria silenciosamente.
  const { rows: pendentes } = await pool.query(
    `SELECT ha.id AS historico_id, ha.anunciante_id, ha.plano_id AS beneficio_plano_id, ha.valido_ate, ha.observacao
       FROM planos_administrativos ha
      WHERE ha.status = 'agendado'`,
  );
  let ativados = 0;
  for (const linha of pendentes) {
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const { rows: trava } = await cliente.query(
        `SELECT * FROM anunciantes WHERE id = $1
           AND NOT (plano_id IS NOT NULL AND NOT plano_cortesia AND data_expiracao > now())
           FOR UPDATE`,
        [linha.anunciante_id],
      );
      if (!trava.length) {
        // Ainda pagando em dia (renovou depois do agendamento) — tenta de
        // novo no próximo dia, sem mexer em nada agora.
        await cliente.query('ROLLBACK');
        continue;
      }
      // A duração comprada é preservada mesmo se a ativação atrasou (a
      // assinatura paga renovou depois do resgate): a validade anda junto
      // com o início real. Sem isso, cada renovação encurtava o benefício
      // até ele nascer vencido.
      const {
        rows: [{ valido_ate: validoAte }],
      } = await cliente.query(
        `UPDATE planos_administrativos
            SET valido_ate = CASE WHEN plano_anterior_valido_ate IS NULL THEN valido_ate
                                  ELSE GREATEST(valido_ate, current_date + (valido_ate - plano_anterior_valido_ate)) END,
                status = 'ativo', ativado_em = now()
          WHERE id = $1 RETURNING valido_ate`,
        [linha.historico_id],
      );
      await cliente.query(
        `UPDATE anunciantes SET plano_id=$2, plano_cortesia=true,
                cortesia_motivo=$3, data_inicio_cobertura=now(), data_expiracao=$4 WHERE id=$1`,
        [
          linha.anunciante_id,
          linha.beneficio_plano_id,
          linha.observacao ? `Benefício: ${linha.observacao}` : 'Benefício por créditos',
          validoAte,
        ],
      );
      await cliente.query('COMMIT');
      ativados += 1;
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
async function encerrarBeneficiosVencidos() {
  const { rows: vencidos } = await pool.query(
    `SELECT ha.id, ha.anunciante_id FROM planos_administrativos ha
      WHERE ha.status = 'ativo' AND ha.valido_ate < current_date`,
  );
  let encerrados = 0;
  for (const linha of vencidos) {
    const conta = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [linha.anunciante_id]);
    if (!conta.rows[0]) continue;
    // Só encerra se a conta ainda está no MESMO plano que este benefício
    // concedeu (mesma cautela de encerrar(motivo='vencido') pra plano
    // pago — algo pode ter trocado o plano da conta nesse meio-tempo).
    await comTransacao(async (db) => {
      await db.query(
        `UPDATE planos_administrativos SET status='encerrado', encerrado_em=now(), encerrado_motivo='vencido' WHERE id=$1`,
        [linha.id],
      );
      await db.query(
        `UPDATE anunciantes SET plano_id=NULL, plano_cortesia=false, cortesia_motivo=NULL, data_expiracao=NULL WHERE id=$1`,
        [linha.anunciante_id],
      );
    });
    encerrados += 1;
  }
  return { verificados: vencidos.length, encerrados };
}

module.exports = {
  TIERS_COMERCIAIS,
  origemDoPlano,
  validadeValida,
  conceder,
  encerrar,
  historicoDaConta,
  resgatarOuConcederBeneficio,
  ativarBeneficiosAgendados,
  encerrarBeneficiosVencidos,
};
