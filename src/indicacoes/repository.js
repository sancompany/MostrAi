const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const { nomeDoCiclo } = require('../lib/ciclos');

// Cupom de indicação da conta (migration 062): até 6 letras do nome (sem
// acento) + 3 dígitos, prefixado com "PT-". O prefixo veio da época em que
// existia cupom de vendedor (só letras e dígitos, tabela UNIQUE separada) —
// o programa foi aposentado, mas o formato fica: cupons já impressos e
// gravados em `anunciantes.indicado_por_cupom` continuam válidos. Cada
// pagamento de quem usou o cupom vira crédito no ledger (src/creditos).
function gerarCupomPonto(nome) {
  const slug =
    String(nome || 'ponto')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z]/g, '')
      .toUpperCase()
      .slice(0, 6) || 'PONTO';
  return `PT-${slug}${Math.floor(100 + Math.random() * 900)}`;
}

// Precisa de transação (usa SAVEPOINT): um 23505 por colisão de código
// abortaria a transação inteira sem o SAVEPOINT em volta de cada tentativa.
async function criarCupom(contaId, nome, db = pool) {
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    try {
      await db.query('SAVEPOINT cupom_ponto');
      const { rows } = await db.query('INSERT INTO cupons_ponto (conta_id, codigo) VALUES ($1,$2) RETURNING *', [
        contaId,
        gerarCupomPonto(nome),
      ]);
      await db.query('RELEASE SAVEPOINT cupom_ponto');
      return rows[0];
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT cupom_ponto').catch(() => {});
      if (err.code !== '23505' || tentativa === 4) throw err;
    }
  }
  return null;
}

async function buscarCupomPorConta(contaId, db = pool) {
  const { rows } = await db.query('SELECT * FROM cupons_ponto WHERE conta_id = $1', [contaId]);
  return rows[0] || null;
}

// Toda conta indica — não só quem tem ponto (o cupom nascia só junto do
// ponto). Cria na primeira vez que a conta abre "Créditos e benefícios".
// Duas abas abrindo juntas: a trava por conta serializa, e a segunda só lê.
async function garantirCupom(contaId, nome) {
  const existente = await buscarCupomPorConta(contaId);
  if (existente) return existente;
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cupom:${contaId}`]);
    const ja = await buscarCupomPorConta(contaId, cliente);
    const cupom = ja || (await criarCupom(contaId, nome, cliente));
    await cliente.query('COMMIT');
    return cupom;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

async function buscarPontoPorCupom(codigo) {
  const { rows } = await pool.query(
    `SELECT cp.*, a.nome_empresa AS nome FROM cupons_ponto cp JOIN anunciantes a ON a.id = cp.conta_id
     WHERE cp.codigo = $1 AND a.excluido_em IS NULL`,
    [codigo],
  );
  return rows[0] || null;
}

// A REGRA ÚNICA de "este link indica alguém" (29/09/2026): o cadastro grava
// a indicação com ela e a página de cadastro mostra "Indicado por" com ela —
// o nome que aparece é o da conta que o cadastro vai associar, nunca outro.
// Cupom de ponto sempre começa com "PT-" (migration 062); o de vendedor não
// vale mais (programa aposentado, 23/09/2026). Devolve o cupom canônico
// (`codigo`, em maiúsculas) e o nome do negócio que indica, ou null.
async function indicadorDoCupom(texto) {
  const cupom = String(texto ?? '').toUpperCase();
  return cupom.startsWith('PT-') ? buscarPontoPorCupom(cupom) : null;
}

// Atividade das indicações em número, nunca em pessoa: quantas contas se
// cadastraram com o código e quantas já pagaram. Nome, e-mail ou documento
// de quem foi indicado não saem daqui.
async function resumoIndicacoes(codigo) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cadastradas,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM cobrancas_confirmadas cc WHERE cc.anunciante_id = a.id))::int AS pagantes
       FROM anunciantes a
      WHERE a.indicado_por_cupom = $1 AND a.excluido_em IS NULL`,
    [codigo],
  );
  return rows[0];
}

// Histórico de quem se cadastrou pelo link (painel do usuário, 29/09/2026,
// pedido do dono). Sem livro próprio: cada coluna sai da fonte que já decide
// aquilo no sistema —
//   · quem é indicado: `anunciantes.indicado_por_cupom` (gravado no cadastro,
//     imutável — a mesma régua do "Indicado por", indicadorDoCupom);
//   · pagamentos: ciclos PAGOS da conta indicada (`ciclos_contratados`,
//     compra ou renovação) — é exatamente o que passa por aplicarCicloPago,
//     onde o crédito de indicação nasce; acerto de troca de plano não conta
//     (não gera crédito);
//   · créditos: as linhas de indicação do ledger do INDICADOR ($2) com
//     aquela conta como origem — idempotentes por cobrança (índice único da
//     migration 079), então reprocessar um pagamento nunca soma duas vezes.
// Só o que o dono do ponto pode ver: nome comercial, dia do cadastro, plano
// em vigor, pagamentos e créditos com as datas. Nunca e-mail, telefone,
// documento, endereço, valor pago nem o id da conta. Conta excluída sai.
async function historicoDeIndicados(codigo, indicadorContaId) {
  const { rows } = await pool.query(
    `SELECT a.nome_empresa AS nome,
            (a.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS cadastro_em,
            a.plano_id, a.data_expiracao, p.nome AS plano_nome, p.compromisso_meses AS plano_meses,
            (SELECT COUNT(*) FROM ciclos_contratados c
              WHERE c.anunciante_id = a.id AND c.origem IN ('compra', 'renovacao')
                AND c.cobranca_confirmada_id IS NOT NULL)::int AS pagamentos,
            COALESCE(l.creditos, 0)::int AS creditos,
            COALESCE(l.datas, '[]'::json) AS creditos_em
       FROM anunciantes a
       LEFT JOIN planos p ON p.id = a.plano_id
       LEFT JOIN LATERAL (
         SELECT SUM(cl.quantidade) AS creditos,
                json_agg(json_build_object(
                  'data', (cl.criado_em AT TIME ZONE 'America/Sao_Paulo')::date,
                  'tipo', CASE cl.tipo WHEN 'indicacao_primeiro_pagamento' THEN 'primeiro_pagamento' ELSE 'renovacao' END
                ) ORDER BY cl.criado_em, cl.id) AS datas
           FROM creditos_ledger cl
          WHERE cl.anunciante_id = $2 AND cl.origem_conta_id = a.id
            AND cl.tipo IN ('indicacao_primeiro_pagamento', 'indicacao_renovacao')
       ) l ON true
      WHERE a.indicado_por_cupom = $1 AND a.excluido_em IS NULL
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 200`,
    [codigo, indicadorContaId],
  );
  return rows.map((r) => ({
    nome: r.nome,
    cadastroEm: r.cadastro_em,
    // Plano em vigor, pela régua do gerador (planoVigenteId): vencido é
    // "sem plano" pra quem olha de fora.
    plano:
      r.plano_id && vigencia.coberturaVigente(r.data_expiracao)
        ? `${r.plano_nome} · ${nomeDoCiclo(r.plano_meses)}`
        : null,
    pagamentos: r.pagamentos,
    creditos: r.creditos,
    creditosEm: r.creditos_em,
  }));
}

module.exports = {
  criarCupom,
  garantirCupom,
  buscarCupomPorConta,
  buscarPontoPorCupom,
  indicadorDoCupom,
  resumoIndicacoes,
  historicoDeIndicados,
};
