const { consultar, emTransacao } = require('./db/conexao');
const { auditar } = require('./lib/registro');

// Retenção e anonimização (D2, aprovada pelo dono em 09/11/2026 COM ressalva):
// a estrutura existe, os prazos são PROVISÓRIOS e nada roda sozinho. Nenhum
// agendamento chama este módulo — só o comando manual, e só com
// `--confirmar`. Os prazos definitivos dependem da revisão jurídica
// (docs/trimundi/pendencias.md, D2).
//
// Anonimizar = trocar nome, CPF, e-mail e telefone por nulo e marcar
// `anonimizado_em`. O que a lei pede para guardar continua: pedido, valores,
// pagamento, reembolso, aceite (com o hash do texto aceito), histórico do
// ingresso e check-in — nenhum deles tem dado pessoal direto.

const PRAZOS_PROVISORIOS = Object.freeze({
  // Participantes (e cortesias) de edição encerrada: dias após o fim (ou
  // o início, quando não há fim) da edição.
  participantesDiasAposEdicao: 180,
  // Compradores: dias após o último pagamento ou criação de pedido deles.
  compradoresDiasAposPedido: 5 * 365,
  // Operador desativado: dias após a desativação.
  operadoresDiasAposDesativar: 182,
  // E-mail enviado: endereço e corpo (o corpo leva o link do pedido).
  emailsDiasAposEnvio: 90,
});

// O que venceria hoje pelos prazos provisórios — só conta, não muda nada.
async function vencidos(prazos = PRAZOS_PROVISORIOS) {
  const { rows } = await consultar(
    `SELECT
       (SELECT count(*) FROM participantes pa JOIN edicoes ed ON ed.id = pa.edicao_id
         WHERE pa.anonimizado_em IS NULL AND ed.status = 'encerrado'
           AND COALESCE(ed.fim_em, ed.inicio_em, ed.encerrado_em) < now() - make_interval(days => $1))::int AS participantes,
       (SELECT count(*) FROM compradores c
         WHERE c.anonimizado_em IS NULL
           AND NOT EXISTS (SELECT 1 FROM pedidos p WHERE p.comprador_id = c.id
                            AND COALESCE(p.pago_em, p.criado_em) >= now() - make_interval(days => $2)))::int AS compradores,
       (SELECT count(*) FROM operadores o
         WHERE o.anonimizado_em IS NULL AND o.status = 'desativado'
           AND o.desativado_em < now() - make_interval(days => $3))::int AS operadores,
       (SELECT count(*) FROM emails
         WHERE status = 'enviado' AND texto <> '[removido]'
           AND enviado_em < now() - make_interval(days => $4))::int AS emails`,
    [
      prazos.participantesDiasAposEdicao,
      prazos.compradoresDiasAposPedido,
      prazos.operadoresDiasAposDesativar,
      prazos.emailsDiasAposEnvio,
    ],
  );
  return rows[0];
}

// Anonimiza o que venceu. Exige `confirmar: true` — sem isso, só devolve a
// contagem (ensaio). Uma transação: ou tudo, ou nada.
async function anonimizarVencidos({ confirmar = false, prazos = PRAZOS_PROVISORIOS, autor = null } = {}) {
  const antes = await vencidos(prazos);
  if (!confirmar) return { ensaio: true, ...antes };
  return emTransacao(async (cliente) => {
    const p = await cliente.query(
      `UPDATE participantes pa SET nome = NULL, cpf = NULL, email = NULL, anonimizado_em = now(), atualizado_em = now()
         FROM edicoes ed
        WHERE ed.id = pa.edicao_id AND pa.anonimizado_em IS NULL AND ed.status = 'encerrado'
          AND COALESCE(ed.fim_em, ed.inicio_em, ed.encerrado_em) < now() - make_interval(days => $1)`,
      [prazos.participantesDiasAposEdicao],
    );
    const c = await cliente.query(
      `UPDATE compradores c SET nome = NULL, cpf = NULL, email = NULL, telefone = NULL, anonimizado_em = now()
        WHERE c.anonimizado_em IS NULL
          AND NOT EXISTS (SELECT 1 FROM pedidos p WHERE p.comprador_id = c.id
                           AND COALESCE(p.pago_em, p.criado_em) >= now() - make_interval(days => $1))`,
      [prazos.compradoresDiasAposPedido],
    );
    const o = await cliente.query(
      `UPDATE operadores SET nome = NULL, email = NULL, email_normalizado = NULL, senha_hash = NULL, codigo_hash = NULL,
              anonimizado_em = now(), sessao_versao = sessao_versao + 1
        WHERE anonimizado_em IS NULL AND status = 'desativado' AND desativado_em < now() - make_interval(days => $1)`,
      [prazos.operadoresDiasAposDesativar],
    );
    const e = await cliente.query(
      `UPDATE emails SET para = '[removido]', texto = '[removido]'
        WHERE status = 'enviado' AND texto <> '[removido]' AND enviado_em < now() - make_interval(days => $1)`,
      [prazos.emailsDiasAposEnvio],
    );
    const feito = {
      ensaio: false,
      participantes: p.rowCount,
      compradores: c.rowCount,
      operadores: o.rowCount,
      emails: e.rowCount,
    };
    await auditar(cliente, autor || { autor: 'retencao-manual' }, 'anonimizacao', 'retencao', null, feito);
    return feito;
  });
}

if (require.main === module) {
  require('dotenv').config();
  const confirmar = process.argv.includes('--confirmar');
  const { encerrar } = require('./db/conexao');
  anonimizarVencidos({ confirmar })
    .then(async (r) => {
      console.log(
        `trimundi: retenção (prazos PROVISÓRIOS) — ${r.ensaio ? 'ensaio, nada mudou' : 'anonimizado'}: ` +
          `${r.participantes} participante(s), ${r.compradores} comprador(es), ${r.operadores} operador(es), ${r.emails} e-mail(s)`,
      );
      await encerrar();
    })
    .catch(async (err) => {
      console.error('trimundi: retenção falhou:', err.message);
      await encerrar().catch(() => {});
      process.exit(1);
    });
}

module.exports = { PRAZOS_PROVISORIOS, vencidos, anonimizarVencidos };
