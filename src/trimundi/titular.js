const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { auditar } = require('./lib/registro');
const { hmac } = require('./lib/chaves');
const { PRAZOS_PROVISORIOS } = require('./retencao');

// Pedido do titular (LGPD, art. 18): o Admin consulta por CPF o que a
// Trimundi guarda da pessoa (exportação) e anonimiza o que não tem guarda
// legal (inventario-de-dados.md, "Exclusão e anonimização"):
//   · participante: anonimizado na hora — o ingresso e o check-in ficam, sem
//     pessoa (o ingresso de evento futuro continua valendo pelo QR);
//   · comprador com pagamento no prazo de guarda (provisório: 5 anos) fica,
//     com o motivo na resposta; sem pagamento, anonimizado;
//   · e-mails enviados para a pessoa anonimizada perdem endereço e corpo.
// A auditoria guarda só um HMAC do CPF, nunca o número.

const PAGOS = ['pago', 'estornado', 'pago_sem_vaga'];

async function exportar(cpfBruto) {
  const cpf = v.cpf(cpfBruto);
  const { rows: compradores } = await consultar(
    `SELECT c.id, c.nome, c.email, c.telefone, c.criado_em,
            COALESCE(json_agg(json_build_object('pedido', upper(left(p.id::text, 8)), 'evento', ev.nome || ' — ' || ed.nome,
                     'status', p.status, 'total_centavos', p.total_centavos, 'criado_em', p.criado_em, 'pago_em', p.pago_em)
                     ORDER BY p.criado_em) FILTER (WHERE p.id IS NOT NULL), '[]') AS pedidos
       FROM compradores c
       LEFT JOIN pedidos p ON p.comprador_id = c.id
       LEFT JOIN edicoes ed ON ed.id = p.edicao_id LEFT JOIN eventos ev ON ev.id = ed.evento_id
      WHERE c.cpf = $1 GROUP BY c.id ORDER BY c.criado_em`,
    [cpf],
  );
  const { rows: participantes } = await consultar(
    `SELECT pa.nome, pa.email, ev.nome || ' — ' || ed.nome AS evento, i.codigo_curto, i.status, i.origem,
            (SELECT registrado_em FROM checkins ck WHERE ck.ingresso_id = i.id AND ck.escopo = 'entrada' AND ck.resultado = 'aceito') AS entrada_em
       FROM participantes pa JOIN edicoes ed ON ed.id = pa.edicao_id JOIN eventos ev ON ev.id = ed.evento_id
       LEFT JOIN ingressos i ON i.participante_id = pa.id
      WHERE pa.cpf = $1 ORDER BY pa.criado_em`,
    [cpf],
  );
  const { rows: contas } = await consultar(
    'SELECT nome, email, criado_em, email_confirmado_em, ultimo_acesso_em FROM clientes WHERE cpf = $1',
    [cpf],
  );
  return {
    gerado_em: new Date().toISOString(),
    contas,
    controlador: 'TICK (San & Co.)',
    compradores: compradores.map(({ id, ...c }) => c),
    participantes,
  };
}

async function anonimizar(cpfBruto, motivoBruto, autor) {
  const cpf = v.cpf(cpfBruto);
  const motivo = v.texto(motivoBruto, {
    campo: 'o motivo',
    obrigatorio: true,
    max: 300,
    mensagem: 'Informe o motivo (ex.: pedido do titular).',
  });
  return emTransacao(async (cliente) => {
    const { rows: emailsDe } = await cliente.query(
      `SELECT email FROM participantes WHERE cpf = $1 AND email IS NOT NULL
       UNION SELECT email FROM compradores WHERE cpf = $1 AND email IS NOT NULL
       UNION SELECT email FROM clientes WHERE cpf = $1 AND email IS NOT NULL`,
      [cpf],
    );
    const p = await cliente.query(
      `UPDATE participantes SET nome = NULL, cpf = NULL, email = NULL, anonimizado_em = now(), atualizado_em = now()
        WHERE cpf = $1 AND anonimizado_em IS NULL`,
      [cpf],
    );
    const { rows: retidos } = await cliente.query(
      `SELECT c.id FROM compradores c
        WHERE c.cpf = $1 AND EXISTS (SELECT 1 FROM pedidos p WHERE p.comprador_id = c.id AND p.status = ANY($2::text[])
                                       AND COALESCE(p.pago_em, p.criado_em) >= now() - make_interval(days => $3))`,
      [cpf, PAGOS, PRAZOS_PROVISORIOS.compradoresDiasAposPedido],
    );
    const c = await cliente.query(
      `UPDATE compradores SET nome = NULL, cpf = NULL, email = NULL, telefone = NULL, anonimizado_em = now()
        WHERE cpf = $1 AND anonimizado_em IS NULL AND NOT (id = ANY($2::bigint[]))`,
      [cpf, retidos.map((r) => r.id)],
    );
    // A conta de acesso sai sempre (o que tem guarda legal é o comprador de
    // cada pedido, acima): sem nome, CPF, e-mail nem senha; links anulados.
    const conta = await cliente.query(
      `UPDATE clientes SET nome = NULL, cpf = NULL, email = NULL, senha_hash = NULL, anonimizado_em = now(),
              sessao_versao = sessao_versao + 1, atualizado_em = now()
        WHERE cpf = $1 AND anonimizado_em IS NULL RETURNING id`,
      [cpf],
    );
    if (conta.rows.length) {
      await cliente.query(
        'UPDATE cliente_tokens SET usado_em = now() WHERE cliente_id = ANY($1::bigint[]) AND usado_em IS NULL',
        [conta.rows.map((r) => r.id)],
      );
    }
    // E-mails para quem saiu (o comprador retido segue recebendo o necessário).
    const { rows: aindaUsados } = await cliente.query('SELECT email FROM compradores WHERE cpf = $1', [cpf]);
    const manter = new Set(aindaUsados.map((r) => r.email));
    const apagar = emailsDe.map((r) => r.email).filter((e) => !manter.has(e));
    const m = apagar.length
      ? await cliente.query(
          "UPDATE emails SET para = '[removido]', texto = '[removido]' WHERE para = ANY($1::text[])",
          [apagar],
        )
      : { rowCount: 0 };
    const resultado = {
      participantes: p.rowCount,
      compradores: c.rowCount,
      compradores_retidos: retidos.length,
      contas: conta.rows.length,
      emails: m.rowCount,
      retencao: retidos.length
        ? 'comprador com pagamento: guardado pelo prazo legal (fiscal e de defesa), sem uso para outro fim'
        : null,
    };
    await auditar(cliente, autor, 'titular_anonimizado', 'titular', hmac('titular', cpf).slice(0, 32), {
      ...resultado,
      motivo,
    });
    return resultado;
  });
}

module.exports = { exportar, anonimizar };
