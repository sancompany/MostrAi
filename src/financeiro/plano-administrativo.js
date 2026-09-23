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

// De onde vem o plano que está na conta agora. Comodato e plano comercial
// são coisas separadas (Parte 12) — o comodato vem do ponto e não é
// "plano atual" pra efeito de troca.
function origemDoPlano(conta) {
  if (!conta?.plano_id) return null;
  if (conta.plano_cortesia && conta.cortesia_motivo === 'comodato') return 'comodato';
  if (conta.plano_cortesia) return 'cortesia';
  return 'assinatura';
}

// Plano incluído no comodato de algum ponto da conta (Inicial/Básico) — é o
// que volta pra conta quando o benefício comercial acaba, igual ao que o
// cadastro do ponto teria posto lá (src/conta/modos.js, src/pontos/comodato.js).
async function planoDoComodato(contaId, db = pool) {
  const { rows } = await db.query(
    `SELECT pp.plano_incluido_id
       FROM pontos p JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
      WHERE p.anunciante_id = $1 AND pp.plano_incluido_id IS NOT NULL
      ORDER BY pp.ordem, pp.id
      LIMIT 1`,
    [contaId],
  );
  return rows[0]?.plano_incluido_id || null;
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
  await db.query(
    `UPDATE planos_administrativos
        SET encerrado_em = now(), encerrado_por = $3, encerrado_motivo = $2
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

// Encerra o benefício administrativo vigente agora. Se a conta tem ponto em
// comodato, o plano do comodato volta (sem prazo, como nasceu); senão a conta
// fica sem plano comercial. Histórico preservado.
async function encerrar({ conta, adminUsuario }) {
  return comTransacao(async (db) => {
    await fecharAbertos(db, conta.id, 'cancelado', adminUsuario);
    const comodato = await planoDoComodato(conta.id, db);
    const { rows } = comodato
      ? await db.query(
          `UPDATE anunciantes
              SET plano_id = $2, plano_cortesia = true, cortesia_motivo = 'comodato', data_expiracao = NULL
            WHERE id = $1 RETURNING *`,
          [conta.id, comodato],
        )
      : await db.query(
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

module.exports = {
  TIERS_COMERCIAIS,
  origemDoPlano,
  planoDoComodato,
  validadeValida,
  conceder,
  encerrar,
  historicoDaConta,
};
