const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const repo = require('../src/indicacoes/repository');
const { tierElegivel, LIMIAR_ESSENCIAL, LIMIAR_DESTAQUE, LIMIAR_MAXIMO } = require('../src/indicacoes/regras');
const { aplicarUpgradeSeElegivel } = require('../src/indicacoes/aplicar');

// Créditos de indicação do dono de ponto (migration 062, 19/09/2026): nunca
// comissão em dinheiro — 3 comerciantes indicados que pagaram libera o
// Essencial de graça, 7 libera o Pro (destaque), 10 libera o Prime (maximo).
// Cada teste cria as próprias contas, com e-mail único, pra não colidir com
// outra rodada da suíte.

test('tierElegivel: limiares são 3/7/10 pra essencial/destaque/máximo, nada abaixo de 3', () => {
  assert.strictEqual(tierElegivel(0), null);
  assert.strictEqual(tierElegivel(LIMIAR_ESSENCIAL - 1), null);
  assert.strictEqual(tierElegivel(LIMIAR_ESSENCIAL), 'essencial');
  assert.strictEqual(tierElegivel(LIMIAR_DESTAQUE - 1), 'essencial');
  assert.strictEqual(tierElegivel(LIMIAR_DESTAQUE), 'destaque');
  assert.strictEqual(tierElegivel(LIMIAR_MAXIMO - 1), 'destaque');
  assert.strictEqual(tierElegivel(LIMIAR_MAXIMO), 'maximo');
  assert.strictEqual(tierElegivel(LIMIAR_MAXIMO + 20), 'maximo');
});

async function contaDeTeste(prefixo) {
  const email = `${prefixo}-${randomUUID()}@example.com`;
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em, papeis)
     VALUES ($1, '11144477735', $2, '16999990000', 'x', now(), '{anunciante,ponto}')
     RETURNING id`,
    [prefixo, email],
  );
  return rows[0].id;
}

async function apagarContas(ids) {
  await pool.query('DELETE FROM indicacoes_pagas WHERE ponto_conta_id = ANY($1) OR indicado_conta_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM cupons_ponto WHERE conta_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM anunciantes WHERE id = ANY($1)', [ids]);
}

test('registrarCredito conta uma vez só por indicado (ON CONFLICT DO NOTHING)', async () => {
  const ponto = await contaDeTeste('indicacoes-ponto');
  const indicado = await contaDeTeste('indicacoes-indicado');
  try {
    const primeira = await repo.registrarCredito(ponto, indicado);
    assert.ok(primeira, 'primeira vez grava linha');
    const segunda = await repo.registrarCredito(ponto, indicado);
    assert.strictEqual(segunda, null, 'renovação do mesmo indicado não gera crédito novo');
    assert.strictEqual(await repo.contarCreditos(ponto), 1);
  } finally {
    await apagarContas([ponto, indicado]);
  }
});

test('aplicarUpgradeSeElegivel: sem plano nenhum, sobe um degrau por vez conforme bate cada limiar', async () => {
  const ponto = await contaDeTeste('indicacoes-semplano');
  const indicados = await Promise.all(Array.from({ length: 10 }, () => contaDeTeste('indicacoes-ref')));
  try {
    for (const [i, indicadoId] of indicados.entries()) {
      await repo.registrarCredito(ponto, indicadoId);
      const resultado = await aplicarUpgradeSeElegivel(ponto);
      const creditos = i + 1;
      if (creditos < LIMIAR_ESSENCIAL) {
        assert.strictEqual(
          resultado,
          null,
          `com ${creditos} crédito(s) ainda não bate o limiar de ${LIMIAR_ESSENCIAL}`,
        );
      } else if (creditos === LIMIAR_ESSENCIAL) {
        assert.ok(resultado, 'no 3º crédito, o tier Essencial é liberado');
        assert.match(resultado.plano_id, /^essencial-1m/);
      } else if (creditos === LIMIAR_DESTAQUE) {
        assert.ok(resultado, 'no 7º crédito, o tier Pro é liberado');
        assert.match(resultado.plano_id, /^destaque-1m/);
      } else if (creditos === LIMIAR_MAXIMO) {
        assert.ok(resultado, 'no 10º crédito, o tier Prime é liberado');
        assert.match(resultado.plano_id, /^maximo-1m/);
      } else {
        assert.strictEqual(resultado, null, `com ${creditos} créditos, entre limiares, nada novo a aplicar`);
      }
      if (resultado) {
        assert.strictEqual(resultado.plano_cortesia, true);
        assert.strictEqual(resultado.cortesia_motivo, 'indicação');
      }
    }
  } finally {
    await apagarContas([ponto, ...indicados]);
  }
});

test('aplicarUpgradeSeElegivel: conta no comodato (Inicial/Básico) não conta como "já no Essencial"', async () => {
  // Inicial e Básico têm tier='essencial' no banco (mesma coluna do
  // Essencial de verdade — migration 005 nunca distinguiu os dois), então
  // o comparador de tier precisa ignorar planos de comodato, senão o
  // crédito nunca levaria essa conta pro Essencial pago de verdade.
  const ponto = await contaDeTeste('indicacoes-comodato');
  const indicados = await Promise.all([1, 2, 3].map(() => contaDeTeste('indicacoes-ref-com')));
  try {
    await pool.query(
      `UPDATE anunciantes SET plano_id = 'comodato-basico', plano_cortesia = true, cortesia_motivo = 'comodato'
        WHERE id = $1`,
      [ponto],
    );
    for (const indicadoId of indicados) await repo.registrarCredito(ponto, indicadoId);

    const resultado = await aplicarUpgradeSeElegivel(ponto);
    assert.ok(resultado, 'conta no Básico (comodato) ainda é elegível pro Essencial de verdade');
    assert.match(resultado.plano_id, /^essencial-1m/);
    assert.strictEqual(resultado.plano_cortesia, true);
    assert.strictEqual(resultado.cortesia_motivo, 'indicação');
  } finally {
    await apagarContas([ponto, ...indicados]);
  }
});

test('aplicarUpgradeSeElegivel: NUNCA sobrescreve plano pago em dia', async () => {
  const ponto = await contaDeTeste('indicacoes-pagando');
  const indicados = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => contaDeTeste('indicacoes-ref-pg')));
  try {
    await pool.query(
      `UPDATE anunciantes SET plano_id = 'essencial-1m', plano_cortesia = false,
              data_expiracao = now() + interval '10 days' WHERE id = $1`,
      [ponto],
    );
    for (const indicadoId of indicados) await repo.registrarCredito(ponto, indicadoId);

    const resultado = await aplicarUpgradeSeElegivel(ponto);
    assert.strictEqual(
      resultado,
      null,
      'crédito suficiente pro Pro, mas conta paga em dia no Essencial — fica pendente',
    );

    const { rows } = await pool.query('SELECT plano_id, plano_cortesia FROM anunciantes WHERE id = $1', [ponto]);
    assert.strictEqual(rows[0].plano_id, 'essencial-1m', 'plano pago não foi tocado');
    assert.strictEqual(rows[0].plano_cortesia, false);
  } finally {
    await apagarContas([ponto, ...indicados]);
  }
});

test('aplicarUpgradeSeElegivel: aplica sozinho assim que o plano pago vence', async () => {
  const ponto = await contaDeTeste('indicacoes-venceu');
  const indicados = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => contaDeTeste('indicacoes-ref-vc')));
  try {
    await pool.query(
      `UPDATE anunciantes SET plano_id = 'essencial-1m', plano_cortesia = false,
              data_expiracao = now() - interval '1 day' WHERE id = $1`,
      [ponto],
    );
    for (const indicadoId of indicados) await repo.registrarCredito(ponto, indicadoId);

    const resultado = await aplicarUpgradeSeElegivel(ponto);
    assert.ok(resultado, 'plano pago já venceu — o crédito acumulado (Pro) entra agora');
    assert.match(resultado.plano_id, /^destaque-1m/);
    assert.strictEqual(resultado.plano_cortesia, true);
  } finally {
    await apagarContas([ponto, ...indicados]);
  }
});

test('aplicarUpgradeSeElegivel: nunca rebaixa quem já está num tier igual ou acima', async () => {
  const ponto = await contaDeTeste('indicacoes-jamaximo');
  const indicados = await Promise.all(Array.from({ length: 10 }, () => contaDeTeste('indicacoes-ref-max')));
  try {
    await pool.query(
      `UPDATE anunciantes SET plano_id = 'maximo-1m', plano_cortesia = false,
              data_expiracao = now() + interval '10 days' WHERE id = $1`,
      [ponto],
    );
    for (const indicadoId of indicados) await repo.registrarCredito(ponto, indicadoId);
    // Máximo pago em dia: mesmo com 10 créditos (limiar do próprio Máximo),
    // a função não mexe em plano pago — resultado null por estar pagando,
    // não por já estar no tier (comportamento idêntico ao teste acima).
    const resultado = await aplicarUpgradeSeElegivel(ponto);
    assert.strictEqual(resultado, null);
  } finally {
    await apagarContas([ponto, ...indicados]);
  }
});
