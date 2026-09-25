require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const { colunasDoEndereco, parteQueFalta, temEndereco, linhaEndereco } = require('../src/lib/endereco');

// D5 (24/09/2026, decisão do dono): endereço em campos separados em todo o
// sistema — CEP, logradouro, número, complemento, bairro, cidade e UF. Nunca
// mais "Rua e bairro" num campo só. `endereco` segue existindo como a linha
// "logradouro, número", composta no servidor (src/lib/endereco.js).

const PARTES = {
  cep: '15997-078',
  logradouro: 'Avenida 28 de Agosto',
  numero: '2502',
  complemento: 'Sala 3',
  bairro: 'Alto',
  cidade: 'Matão',
  uf: 'sp',
};

test('colunasDoEndereco: compõe a linha, normaliza a UF e só devolve o que veio', () => {
  const c = colunasDoEndereco(PARTES);
  assert.strictEqual(c.endereco, 'Avenida 28 de Agosto, 2502');
  assert.strictEqual(c.uf, 'SP');
  assert.strictEqual(c.complemento, 'Sala 3');
  assert.deepStrictEqual(colunasDoEndereco({ nome: 'x' }), {}, 'sem endereço no corpo, nada a gravar');
  // Complemento em branco vira null (opcional); o resto continua.
  assert.strictEqual(colunasDoEndereco({ ...PARTES, complemento: '  ' }).complemento, null);
});

test('colunasDoEndereco: PATCH que troca só o número mantém a rua gravada', () => {
  const atual = { logradouro: 'Rua A', numero: '10', endereco: 'Rua A, 10' };
  assert.strictEqual(colunasDoEndereco({ numero: '12' }, atual).endereco, 'Rua A, 12');
  assert.strictEqual(colunasDoEndereco({ logradouro: 'Rua B' }, atual).endereco, 'Rua B, 10');
});

test('colunasDoEndereco: registro antigo (só a linha) passa como veio', () => {
  assert.deepStrictEqual(colunasDoEndereco({ endereco: ' Rua X, 1 ', cidade: 'Matão' }), {
    endereco: 'Rua X, 1',
    cidade: 'Matão',
  });
  // Candidatura antiga virando ponto: partes nulas, a linha que veio vale.
  assert.strictEqual(colunasDoEndereco({ endereco: 'Rua X, 1', logradouro: null, numero: null }).endereco, 'Rua X, 1');
});

test('parteQueFalta e temEndereco: complemento é o único opcional; linha antiga continua valendo', () => {
  assert.strictEqual(parteQueFalta(colunasDoEndereco(PARTES)), null);
  assert.strictEqual(parteQueFalta(colunasDoEndereco({ ...PARTES, complemento: '' })), null);
  assert.strictEqual(parteQueFalta(colunasDoEndereco({ ...PARTES, bairro: '' })), 'bairro');
  assert.strictEqual(parteQueFalta(colunasDoEndereco({ ...PARTES, numero: '' })), 'número');
  assert.strictEqual(
    parteQueFalta(colunasDoEndereco({ endereco: 'Rua X, 1', cidade: 'Matão', uf: 'SP', cep: '1' })),
    null,
  );
  assert.strictEqual(temEndereco({ logradouro: 'Rua A', numero: null, cidade: 'M', uf: 'SP', cep: '1' }), false);
  assert.strictEqual(temEndereco({ endereco: 'Rua A, 1', cidade: 'M', uf: 'SP', cep: '1' }), true);
});

test('linhaEndereco: rua, número, complemento e bairro — e a cidade quando pedida', () => {
  const linha = { ...colunasDoEndereco(PARTES) };
  assert.strictEqual(linhaEndereco(linha), 'Avenida 28 de Agosto, 2502 - Sala 3 - Alto');
  assert.strictEqual(linhaEndereco(linha, { comCidade: true }), 'Avenida 28 de Agosto, 2502 - Sala 3 - Alto, Matão/SP');
  assert.strictEqual(linhaEndereco({ endereco: 'Rua X, 1' }), 'Rua X, 1');
  assert.strictEqual(linhaEndereco(null), '');
});

// ---------------------------------------------------------------------------
// Rotas: cadastro, perfil, candidatura e aprovação guardam as partes.
// ---------------------------------------------------------------------------

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-endereco', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/anunciantes/routes').router);
  app.use(require('../src/conta/modos').router);
  app.use(require('../src/pontos/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, corpo, conta) => {
    const headers = { 'Content-Type': 'application/json' };
    if (conta) headers['x-conta'] = String(conta);
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers,
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

// CPF com dígitos verificadores válidos (o cadastro confere).
function cpfValido() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (new Set(base).size === 1) base[0] = (base[0] + 1) % 10;
  const digito = (nums) => {
    const soma = nums.reduce((s, n, i) => s + n * (nums.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = digito(base);
  const d2 = digito([...base, d1]);
  return [...base, d1, d2].join('');
}

const linhaDaConta = async (id) => (await pool.query('SELECT * FROM anunciantes WHERE id = $1', [id])).rows[0];

async function limparConta(id) {
  await pool.query('DELETE FROM pontos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM candidaturas WHERE conta_id = $1', [id]);
  await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM codigos_confirmacao_email WHERE anunciante_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

test('cadastro: grava as partes separadas e compõe a linha; sem bairro é 400', async () => {
  const app = await subirApp();
  let contaId = null;
  try {
    const base = {
      nome_empresa: `Endereço ${randomUUID().slice(0, 8)}`,
      cpf_cnpj: cpfValido(),
      contato_telefone: '16999990000',
      senha: 'Senha@forte1',
      aceitou_termos: true,
      categoria_livre: 'teste',
    };
    const semBairro = await app.chamar('POST', '/anunciantes/cadastro', {
      ...base,
      ...PARTES,
      bairro: '',
      contato_email: `end-${randomUUID()}@example.com`,
    });
    assert.strictEqual(semBairro.status, 400, JSON.stringify(semBairro.corpo));
    assert.match(semBairro.corpo.erro, /bairro/);

    const ok = await app.chamar('POST', '/anunciantes/cadastro', {
      ...base,
      ...PARTES,
      contato_email: `end-${randomUUID()}@example.com`,
    });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.corpo));
    contaId = ok.corpo.id;
    const linha = await linhaDaConta(contaId);
    assert.strictEqual(linha.logradouro, 'Avenida 28 de Agosto');
    assert.strictEqual(linha.numero, '2502');
    assert.strictEqual(linha.complemento, 'Sala 3');
    assert.strictEqual(linha.bairro, 'Alto');
    assert.strictEqual(linha.uf, 'SP');
    assert.strictEqual(linha.endereco, 'Avenida 28 de Agosto, 2502', 'a linha antiga é composta, sem bairro colado');

    // Perfil: troca o endereço inteiro; a linha acompanha.
    const patch = await app.chamar(
      'PATCH',
      '/anunciantes/me',
      { ...PARTES, logradouro: 'Rua Nova', numero: '15', complemento: '' },
      contaId,
    );
    assert.strictEqual(patch.status, 200, JSON.stringify(patch.corpo));
    assert.strictEqual(patch.corpo.endereco, 'Rua Nova, 15');
    assert.strictEqual(patch.corpo.complemento, null);

    // Começou a preencher, preenche tudo: número em branco é 400.
    const incompleto = await app.chamar('PATCH', '/anunciantes/me', { ...PARTES, numero: '' }, contaId);
    assert.strictEqual(incompleto.status, 400);
    assert.match(incompleto.corpo.erro, /número/);
    assert.strictEqual((await linhaDaConta(contaId)).numero, '15', 'nada foi gravado');
  } finally {
    await app.fechar();
    if (contaId) await limparConta(contaId);
  }
});

test('perfil de conta só de ponto salva com o endereço em branco (quem anuncia, não)', async () => {
  const app = await subirApp();
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, papeis)
     VALUES (now(), 'Só ponto', $1, $2, '16999990000', 'x', ARRAY['ponto']) RETURNING id`,
    [cpfValido(), `soponto-${randomUUID()}@example.com`],
  );
  const contaId = rows[0].id;
  try {
    const vazio = Object.fromEntries(Object.keys(PARTES).map((k) => [k, '']));
    const r = await app.chamar('PATCH', '/anunciantes/me', { nome_empresa: 'Só ponto (novo)', ...vazio }, contaId);
    assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
    assert.strictEqual(r.corpo.nome_empresa, 'Só ponto (novo)');
    await pool.query(`UPDATE anunciantes SET papeis = ARRAY['anunciante'] WHERE id = $1`, [contaId]);
    const anunciante = await app.chamar('PATCH', '/anunciantes/me', { nome_empresa: 'x', ...vazio }, contaId);
    assert.strictEqual(anunciante.status, 400, 'quem anuncia precisa do endereço (nota fiscal)');
  } finally {
    await app.fechar();
    await limparConta(contaId);
  }
});

// Revisão do PR #55 (25/09/2026): o painel troca a conta inteira pela
// resposta do PATCH — se ela vier sem `plano_vigente`, o card do plano diz
// "Cobertura vencida" pra quem está em dia até o próximo recarregar.
test('PATCH do perfil devolve a conta na mesma forma do GET (vigência decidida no servidor)', async () => {
  const app = await subirApp();
  const vigencia = require('../src/lib/vigencia');
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, papeis,
                              plano_id, data_expiracao)
     VALUES (now(), 'Em dia', $1, $2, '16999990000', 'x', ARRAY['ponto'], 'essencial-1m', $3) RETURNING id`,
    [cpfValido(), `emdia-${randomUUID()}@example.com`, vigencia.somarDias(vigencia.hojeComercial(), 10)],
  );
  const contaId = rows[0].id;
  try {
    const get = await app.chamar('GET', '/anunciantes/me', undefined, contaId);
    const patch = await app.chamar('PATCH', '/anunciantes/me', { nome_empresa: 'Em dia (novo)' }, contaId);
    assert.strictEqual(patch.status, 200, JSON.stringify(patch.corpo));
    assert.strictEqual(patch.corpo.nome_empresa, 'Em dia (novo)');
    assert.strictEqual(patch.corpo.plano_vigente, true);
    assert.strictEqual(patch.corpo.dias_ate_vencer, get.corpo.dias_ate_vencer);
    assert.deepStrictEqual(Object.keys(patch.corpo).sort(), Object.keys(get.corpo).sort());
  } finally {
    await app.fechar();
    await limparConta(contaId);
  }
});

test('candidatura de ponto guarda as partes e a aprovação leva todas pro ponto', async () => {
  const app = await subirApp();
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, papeis)
     VALUES (now(), 'Candidato', $1, $2, '16999990000', 'x', ARRAY['anunciante']) RETURNING id`,
    [cpfValido(), `cand-${randomUUID()}@example.com`],
  );
  const contaId = rows[0].id;
  const horario = { seg: { abre: '08:00', fecha: '18:00' } };
  try {
    const incompleto = await app.chamar(
      'POST',
      '/conta/modos/ponto/pedir',
      { nome_comercio: 'Loja E', ...PARTES, bairro: '', fluxo_estimado_mensal: 100, horario_semanal: horario },
      contaId,
    );
    assert.strictEqual(incompleto.status, 400);
    assert.match(incompleto.corpo.erro, /bairro/);

    const pedido = await app.chamar(
      'POST',
      '/conta/modos/ponto/pedir',
      { nome_comercio: 'Loja E', ...PARTES, fluxo_estimado_mensal: 100, horario_semanal: horario },
      contaId,
    );
    assert.strictEqual(pedido.status, 201, JSON.stringify(pedido.corpo));
    const { rows: cands } = await pool.query('SELECT * FROM candidaturas WHERE id = $1', [pedido.corpo.id]);
    assert.strictEqual(cands[0].logradouro, 'Avenida 28 de Agosto');
    assert.strictEqual(cands[0].numero, '2502');
    assert.strictEqual(cands[0].endereco, 'Avenida 28 de Agosto, 2502');

    const aprovada = await app.chamar('POST', `/admin/candidaturas/${pedido.corpo.id}/liberar`);
    assert.strictEqual(aprovada.status, 200, JSON.stringify(aprovada.corpo));
    const { rows: pontos } = await pool.query('SELECT * FROM pontos WHERE candidatura_id = $1', [pedido.corpo.id]);
    assert.strictEqual(pontos.length, 1);
    assert.strictEqual(pontos[0].logradouro, 'Avenida 28 de Agosto');
    assert.strictEqual(pontos[0].numero, '2502');
    assert.strictEqual(pontos[0].complemento, 'Sala 3');
    assert.strictEqual(pontos[0].bairro, 'Alto');
    assert.strictEqual(pontos[0].endereco, 'Avenida 28 de Agosto, 2502');

    // O mesmo estabelecimento pedido de novo, pelas partes, é reconhecido.
    const repetido = await app.chamar(
      'POST',
      '/anunciantes/me/pontos',
      { nome_comercio: 'Loja E', ...PARTES, fluxo_estimado_mensal: 100, horario_semanal: horario },
      contaId,
    );
    assert.strictEqual(repetido.status, 409, JSON.stringify(repetido.corpo));
  } finally {
    await app.fechar();
    await limparConta(contaId);
  }
});
