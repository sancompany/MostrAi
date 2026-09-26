const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { meusPontosDaConta } = require('../src/pontos/meus-pontos');

// "Meus pontos" (Fatia 2 do painel único): um estabelecimento aparece UMA vez,
// do pedido ao ponto no ar, e a resposta nunca carrega dado interno.

async function criarConta() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, papeis)
     VALUES (now(), $1, $2, $3, '16999990000', 'x', ARRAY['anunciante','ponto']) RETURNING *`,
    [
      `MP ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `mp-${randomUUID()}@example.com`,
    ],
  );
  return rows[0];
}

async function candidatura(contaId, nome) {
  const { rows } = await pool.query(
    `INSERT INTO candidaturas (tipo, nome, nome_comercio, contato_telefone, endereco, cidade, uf, cep, conta_id, origem)
     VALUES ('ponto', 'Resp', $1, '16999990000', 'Rua X, 1', 'Matão', 'SP', '15990-000', $2, 'painel') RETURNING id`,
    [nome, contaId],
  );
  return rows[0].id;
}

async function ponto(contaId, nome, extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato,
                         observacoes, anunciante_id, candidatura_id, status)
     VALUES ($1, 'Rua X, 1', 'Matão', 'SP', '15990-000', 'outro', 'Resp', '16 90000-0000',
             'nota interna', $2, $3, 'a_instalar') RETURNING id`,
    [nome, contaId, extra.candidaturaId || null],
  );
  return rows[0].id;
}

async function limpar(contaId) {
  await pool.query('DELETE FROM dispositivos WHERE ponto_id IN (SELECT id FROM pontos WHERE anunciante_id = $1)', [
    contaId,
  ]);
  await pool.query('UPDATE pontos SET mesclado_em_ponto_id = NULL WHERE anunciante_id = $1', [contaId]);
  await pool.query('DELETE FROM pontos WHERE anunciante_id = $1', [contaId]);
  await pool.query('DELETE FROM candidaturas WHERE conta_id = $1', [contaId]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [contaId]);
}

test('pedido já materializado aparece só como o ponto, nunca duas vezes', async () => {
  const conta = await criarConta();
  try {
    const aberta = await candidatura(conta.id, 'Loja Nova');
    const virouPonto = await candidatura(conta.id, 'Loja Antiga');
    await ponto(conta.id, 'Loja Antiga', { candidaturaId: virouPonto });
    const lista = await meusPontosDaConta(conta.id);
    assert.equal(lista.length, 2);
    assert.deepEqual(
      lista.map((e) => [e.tipo, e.nome, e.estado]),
      [
        ['candidatura', 'Loja Nova', 'em_analise'],
        ['ponto', 'Loja Antiga', 'aguardando_instalacao'],
      ],
    );
    assert.equal(lista[0].id, aberta);
  } finally {
    await limpar(conta.id);
  }
});

test('ponto arquivado (mesclado) fica fora', async () => {
  const conta = await criarConta();
  try {
    const canonico = await ponto(conta.id, 'Mercado');
    const duplicata = await ponto(conta.id, 'Mercado');
    await pool.query(
      `UPDATE pontos SET status = 'arquivado', arquivado_em = now(), motivo_arquivamento = 'teste',
              mesclado_em_ponto_id = $2 WHERE id = $1`,
      [duplicata, canonico],
    );
    const lista = await meusPontosDaConta(conta.id);
    assert.deepEqual(
      lista.map((e) => e.id),
      [canonico],
    );
  } finally {
    await limpar(conta.id);
  }
});

test('telas dentro do ponto, com situação humana e sem dado interno', async () => {
  const conta = await criarConta();
  try {
    const id = await ponto(conta.id, 'Bar do Zé');
    await pool.query(
      `INSERT INTO dispositivos (ponto_id, apelido, status, modo_horario, primeiro_sinal_em, ultima_vez_online, aparelho_id,
                                 ultimo_erro, dispositivo_uid, chave_hash, chave_fingerprint, player_versao, player_build)
       VALUES ($1, 'x', 'ativo', '24h', now(), now(), 'chave-secreta', NULL,
               'tela_00000000000000000001', repeat('a', 64), 'AAAAAA', '1.0.0', 2),
              ($1, 'y', 'ativo', '24h', now() - interval '3 hours', now() - interval '3 hours', 'outra-chave', 'stack trace cru',
               NULL, repeat('b', 64), NULL, NULL, NULL)`,
      [id],
    );
    await pool.query(`UPDATE pontos SET status = 'em_operacao' WHERE id = $1`, [id]);
    const [estab] = await meusPontosDaConta(conta.id);
    assert.equal(estab.estado, 'ativo');
    const { rows: ids } = await pool.query('SELECT id FROM dispositivos WHERE ponto_id = $1 ORDER BY numero', [id]);
    const codigo = (n) => `M-${String(ids[n].id).padStart(4, '0')}`;
    assert.deepEqual(
      estab.telas.map((t) => [t.nome, t.situacao, t.nivel]),
      [
        [codigo(0), 'operando', 'ok'],
        [codigo(1), 'sem_sinal', 'atencao'],
      ],
    );
    assert.equal(estab.alertas, 1);
    assert.match(estab.telas[1].situacaoTexto, /sem comunicação/);
    const json = JSON.stringify(estab);
    assert.equal(estab.telas[0].operacao, '24 horas');
    // Visão simplificada do dono (Player V2): nada de identidade técnica.
    for (const proibido of [
      'chave-secreta',
      'outra-chave',
      'stack trace',
      '16 90000-0000',
      'nota interna',
      'tela_000',
      'AAAAAA',
      'aaaaaaaa',
      '1.0.0',
    ]) {
      assert.ok(!json.includes(proibido), `vazou: ${proibido}`);
    }
  } finally {
    await limpar(conta.id);
  }
});

test.after(() => pool.end());
