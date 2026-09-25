require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID, createHash } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const vigencia = require('../src/lib/vigencia');
const { situacaoDaConta } = require('../src/anunciantes/situacao');
const creditosRepo = require('../src/creditos/repository');
const planoAdm = require('../src/financeiro/plano-administrativo');

// Invariantes da ficha de Conta do admin (revisão de 23/09/2026, pedido do
// dono). Cada teste é uma frase que a ficha nunca pode contradizer — e o
// que ela lê sai de UMA função de domínio (src/anunciantes/situacao.js), então
// testar a função é testar o que a tela mostra.

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-ficha', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-admin'] === '1') {
      req.session.isAdmin = true;
      req.session.adminUsuario = 'admin-teste';
    }
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/anunciantes/situacao').router);
  app.use(require('../src/creditos/routes'));
  app.use(require('../src/financeiro/routes').router);
  app.use(require('../src/anunciantes/routes').router);
  app.use(require('../src/conta/modos').router);
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, corpo, { conta } = {}) => {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(conta ? { 'x-conta': String(conta) } : { 'x-admin': '1' }) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

async function criarConta(extra = {}) {
  const campos = {
    nome_empresa: `Ficha ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: '11144477735',
    contato_email: `ficha-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha_hash: 'x',
    papeis: '{anunciante}',
    ...extra,
  };
  const nomes = Object.keys(campos);
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, ${nomes.join(', ')})
     VALUES (now(), ${nomes.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(campos),
  );
  return rows[0];
}

async function candidatura(contaId, nome) {
  const { rows } = await pool.query(
    `INSERT INTO candidaturas (tipo, nome, nome_comercio, contato_telefone, endereco, cidade, uf, cep, conta_id, origem)
     VALUES ('ponto', 'Resp', $1, '16999990000', $2, 'Matão', 'SP', '15990-000', $3, 'painel') RETURNING id`,
    [nome, `Rua ${randomUUID().slice(0, 6)}, 1`, contaId],
  );
  return rows[0].id;
}

async function ponto(contaId, nome, extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato,
                         anunciante_id, candidatura_id, plano_ponto_id, status, valor_pago_mensal)
     VALUES ($1, 'Rua X, 1', 'Matão', 'SP', '15990-000', 'outro', 'Resp', '16 90000-0000', $2, $3, $4,
             COALESCE($5, 'a_instalar'), COALESCE($6, 0)) RETURNING id`,
    [nome, contaId, extra.candidaturaId || null, extra.modalidade || null, extra.status || null, extra.repasse ?? null],
  );
  return rows[0].id;
}

async function criativo(contaId, status = 'aprovado') {
  await pool.query(
    `INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, duracao_segundos, status)
     VALUES ($1, 'https://x/o.mp4', 'https://x/n.mp4', 10, $2)`,
    [contaId, status],
  );
}

async function apagar(id) {
  await require('../src/lib/eventos').aguardarGravacoes(); // métrica grava solta; espera terminar antes de apagar
  await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM planos_administrativos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [id]);
  await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM dispositivos WHERE ponto_id IN (SELECT id FROM pontos WHERE anunciante_id = $1)', [id]);
  await pool.query('UPDATE pontos SET mesclado_em_ponto_id = NULL WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM pontos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM candidaturas WHERE conta_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

// Dia de Matão (RN-32-B), não UTC: entre 21:00 e 00:00 UTC os dois divergem.
const somar = (dias) => vigencia.somarDias(vigencia.hojeComercial(), dias);

// ---------- ponto × candidatura × selo ----------

test('candidatura em análise NÃO dá selo e NÃO vira ponto', async () => {
  const c = await criarConta({ papeis: '{anunciante,ponto}' }); // papel legado não conta
  try {
    await candidatura(c.id, 'Loja Pedida');
    const s = await situacaoDaConta(c.id);
    assert.equal(s.donoDePonto, false, 'selo só com ponto aprovado — nunca por candidatura nem por papel legado');
    assert.equal(s.pontos.length, 0);
    assert.deepEqual(
      s.solicitacoes.map((x) => x.nome),
      ['Loja Pedida'],
    );
  } finally {
    await apagar(c.id);
  }
});

test('candidatura aprovada materializa UM ponto: aparece em Pontos, sai de Solicitações, dá o selo', async () => {
  const c = await criarConta();
  const app = await subirApp();
  try {
    const cand = await candidatura(c.id, 'Padaria Aprovada');
    const r = await app.chamar('POST', `/admin/candidaturas/${cand}/liberar`);
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const s = await situacaoDaConta(c.id);
    assert.equal(s.donoDePonto, true);
    assert.deepEqual(
      s.pontos.map((p) => [p.nome, p.statusTexto]),
      [['Padaria Aprovada', 'Aguardando instalação']],
    );
    assert.equal(s.solicitacoes.length, 0, 'a candidatura materializada não aparece de novo como pedido');
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test('ponto arquivado/mesclado não aparece; ponto inativo continua aparecendo', async () => {
  const c = await criarConta();
  try {
    const canonico = await ponto(c.id, 'Mercado', { status: 'inativo' });
    const duplicata = await ponto(c.id, 'Mercado');
    await pool.query(
      `UPDATE pontos SET status = 'arquivado', arquivado_em = now(), motivo_arquivamento = 'teste',
              mesclado_em_ponto_id = $2 WHERE id = $1`,
      [duplicata, canonico],
    );
    const s = await situacaoDaConta(c.id);
    assert.deepEqual(
      s.pontos.map((p) => [p.id, p.statusTexto]),
      [[canonico, 'Inativo']],
    );
    assert.equal(s.donoDePonto, true, 'inativo é estado do ponto, não ausência de ponto');
    assert.equal(s.pontos[0].beneficio.elegivel, false, 'ponto sem tela ativa não gera crédito');
  } finally {
    await apagar(c.id);
  }
});

// ---------- benefício do ponto (ADR-016) ----------

test('conta sem ponto: sem plano, sem benefício de ponto, nada de comodato', async () => {
  const c = await criarConta();
  try {
    const s = await situacaoDaConta(c.id);
    assert.equal(s.comodato, undefined, 'não existe mais bloco de comodato comercial');
    assert.equal(s.plano.agora, null, '"Sem plano"');
    assert.equal(s.alertas.length, 0);
  } finally {
    await apagar(c.id);
  }
});

test('ponto aprovado mostra o benefício "+1 crédito/mês": elegível só com tela ativa provisionada', async () => {
  const c = await criarConta();
  try {
    const id = await ponto(c.id, 'Santos', { status: 'inativo' });
    let s = await situacaoDaConta(c.id);
    assert.equal(s.pontos[0].beneficio.elegivel, false);
    await pool.query(
      // Provisionada = credencial vinculada (só o hash fica no banco, Player V2).
      `INSERT INTO dispositivos (ponto_id, apelido, status, chave_hash) VALUES ($1, 'Tela 1', 'ativo', $2)`,
      [id, createHash('sha256').update(`ap-${randomUUID()}`).digest('hex')],
    );
    s = await situacaoDaConta(c.id);
    assert.equal(s.pontos[0].beneficio.elegivel, true);
    assert.equal(s.pontos[0].beneficio.creditoDoMesConcedido, false);
    assert.ok(!JSON.stringify(s).match(/Inicial|Básico|repasse|R\$ ?50/), 'nada do modelo antigo');
  } finally {
    await apagar(c.id);
  }
});

test('comodato legado (Inicial/Básico na conta) não vira plano nem crédito monetário', async () => {
  const c = await criarConta({ comodato_plano_id: 'comodato-basico', credito_comodato_mensal: 50 });
  try {
    await ponto(c.id, 'Loja Legada', { modalidade: 'mais-cota' });
    const s = await situacaoDaConta(c.id);
    assert.equal(s.plano.agora, null, 'Básico legado não é plano');
    assert.equal(s.creditos.saldo, 0, 'os R$ 50 antigos nunca viram créditos sozinhos');
  } finally {
    await apagar(c.id);
  }
});

// ---------- plano: origem e fila ----------

test('assinatura paga: origem "Assinatura paga", renova na data, depois = renovação', async () => {
  const c = await criarConta({ plano_id: 'destaque-3m', plano_cortesia: false, data_expiracao: somar(40) });
  try {
    await pool.query(
      `INSERT INTO assinaturas (id, anunciante_id, plano_id, status) VALUES ($1, $2, 'destaque-3m', 'ativa')`,
      [randomUUID(), c.id],
    );
    const s = await situacaoDaConta(c.id);
    assert.equal(s.plano.agora.origem, 'assinatura');
    assert.equal(s.plano.agora.origemTexto, 'Assinatura paga');
    assert.equal(s.plano.agora.renovaEm, somar(40));
    assert.equal(s.plano.depois.tipo, 'renova');
    assert.equal(s.plano.veicula, true);
  } finally {
    await apagar(c.id);
  }
});

test('plano pago + benefício por créditos respeitam a fila: Agora = pago, Próximo = benefício, sem sobrepor', async () => {
  const c = await criarConta({ plano_id: 'destaque-1m', plano_cortesia: false, data_expiracao: somar(20) });
  const app = await subirApp();
  try {
    await creditosRepo.concederAdmin(c.id, 30, { motivo: 'teste' });
    const menor = await app.chamar(
      'POST',
      '/anunciantes/me/creditos/resgatar',
      { tier: 'essencial', meses: 3 },
      { conta: c.id },
    );
    assert.equal(menor.status, 409, 'benefício menor que o plano pago é recusado');
    const r = await app.chamar(
      'POST',
      '/anunciantes/me/creditos/resgatar',
      { tier: 'maximo', meses: 1 },
      { conta: c.id },
    );
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    assert.equal(r.corpo.status, 'agendado');
    const s = await situacaoDaConta(c.id);
    assert.equal(s.plano.agora.origem, 'assinatura', 'o ciclo pago continua sendo o Agora');
    assert.equal(s.plano.proximo.origem, 'beneficio_creditos');
    // Último dia pago é inclusivo: o benefício começa no dia SEGUINTE.
    assert.equal(s.plano.proximo.comecaEm, somar(21));
    assert.equal(s.plano.depois.tipo, 'sem_plano', 'sem assinatura ativa: depois do benefício, sem plano');
    // A rotina diária NÃO ativa antes do fim do ciclo pago.
    await planoAdm.ativarBeneficiosAgendados({ apenasContas: [c.id] });
    const depois = await situacaoDaConta(c.id);
    assert.equal(depois.plano.agora.origem, 'assinatura');
    assert.ok(depois.plano.proximo);
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test('dois benefícios não se sobrepõem: segundo resgate recusa, e a ferramenta técnica não substitui benefício por créditos', async () => {
  const c = await criarConta();
  const app = await subirApp();
  try {
    await creditosRepo.concederAdmin(c.id, 30, { motivo: 'teste' });
    const r1 = await app.chamar(
      'POST',
      '/anunciantes/me/creditos/resgatar',
      { tier: 'essencial', meses: 3 },
      { conta: c.id },
    );
    assert.equal(r1.status, 200, JSON.stringify(r1.corpo));
    const r2 = await app.chamar(
      'POST',
      '/anunciantes/me/creditos/resgatar',
      { tier: 'essencial', meses: 3 },
      { conta: c.id },
    );
    assert.equal(r2.status, 409);
    const s = await situacaoDaConta(c.id);
    assert.equal(s.plano.agora.origem, 'beneficio_creditos');
    assert.equal(s.plano.agora.origemTexto, 'Benefício por créditos');

    // O caso real de produção: cortesia administrativa por cima de um
    // benefício pago com créditos, 42 s depois — agora recusado.
    const { rows: prime } = await pool.query(
      `SELECT id FROM planos WHERE tier = 'maximo' AND ativo AND NOT fundador ORDER BY compromisso_meses DESC LIMIT 1`,
    );
    if (prime[0]) {
      const t = await app.chamar('POST', `/admin/anunciantes/${c.id}/plano-administrativo`, {
        plano_id: prime[0].id,
        valido_ate: somar(300),
      });
      assert.equal(t.status, 409, JSON.stringify(t.corpo));
    }
    const e = await app.chamar('POST', `/admin/anunciantes/${c.id}/plano-administrativo/encerrar`);
    assert.equal(e.status, 409);
    const { rows } = await pool.query(
      `SELECT status FROM planos_administrativos WHERE anunciante_id = $1 ORDER BY id`,
      [c.id],
    );
    assert.deepEqual(
      rows.map((x) => x.status),
      ['ativo'],
      'o benefício pago continua de pé, nada foi substituído',
    );
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test('admin concede CRÉDITOS (não plano): ledger imutável com motivo, nota interna, admin e hora', async () => {
  const c = await criarConta();
  const app = await subirApp();
  try {
    const semMotivo = await app.chamar('POST', `/admin/anunciantes/${c.id}/creditos/conceder`, { quantidade: 10 });
    assert.equal(semMotivo.status, 400, 'motivo é obrigatório no servidor, não só no modal');
    const r = await app.chamar('POST', `/admin/anunciantes/${c.id}/creditos/conceder`, {
      quantidade: 120,
      motivo: 'parceria de lançamento',
      nota_interna: 'combinado no WhatsApp',
    });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    const s = await situacaoDaConta(c.id);
    assert.equal(s.creditos.saldo, 120);
    const [m] = s.creditos.movimentacoes;
    assert.equal(m.tipo, 'concessao_admin');
    assert.equal(m.motivo, 'parceria de lançamento');
    assert.equal(m.notaInterna, 'combinado no WhatsApp');
    assert.equal(m.concedidoPor, 'admin-teste');
    assert.ok(m.criadoEm);
    assert.equal(s.plano.agora, null, 'conceder créditos não dá plano sozinho — a conta resgata');
    // A nota interna nunca sai no autoatendimento.
    const cli = await app.chamar('GET', '/anunciantes/me/creditos', null, { conta: c.id });
    assert.equal(cli.status, 200);
    assert.ok(!JSON.stringify(cli.corpo).includes('combinado no WhatsApp'));
    // Conta suspensa não recebe concessão.
    await pool.query('UPDATE anunciantes SET suspenso = true WHERE id = $1', [c.id]);
    const susp = await app.chamar('POST', `/admin/anunciantes/${c.id}/creditos/conceder`, {
      quantidade: 1,
      motivo: 'x',
    });
    assert.equal(susp.status, 409);
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test('cortesia administrativa legada é respeitada até o fim e dita como legada', async () => {
  const c = await criarConta({
    plano_id: 'maximo-12m',
    plano_cortesia: true,
    cortesia_motivo: 'Cortesia administrativa',
    data_expiracao: somar(100),
  });
  try {
    await pool.query(
      `INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, concedido_por, status, origem, ativado_em)
       VALUES ($1, 'maximo-12m', $2, 'admin-antigo', 'ativo', 'admin', now())`,
      [c.id, somar(100)],
    );
    const s = await situacaoDaConta(c.id);
    assert.equal(s.plano.agora.origem, 'cortesia_legada');
    assert.equal(s.plano.agora.origemTexto, 'Cortesia administrativa legada');
    assert.equal(s.plano.agora.validoAte, somar(100));
    assert.equal(s.plano.veicula, true);
    // A rotina diária não encerra antes do prazo.
    await planoAdm.encerrarBeneficiosVencidos({ apenasContas: [c.id] });
    const { rows } = await pool.query('SELECT plano_id FROM anunciantes WHERE id = $1', [c.id]);
    assert.equal(rows[0].plano_id, 'maximo-12m');
  } finally {
    await apagar(c.id);
  }
});

test('benefício "ativo" esquecido por baixo de um plano PAGO vence sem zerar o plano pago', async () => {
  const c = await criarConta({ plano_id: 'destaque-3m', plano_cortesia: false, data_expiracao: somar(60) });
  try {
    await pool.query(
      `INSERT INTO planos_administrativos (anunciante_id, plano_id, inicio, valido_ate, status, origem, ativado_em)
       VALUES ($1, 'maximo-12m', now() - interval '40 days', $2, 'ativo', 'admin', now() - interval '40 days')`,
      [c.id, somar(-1)],
    );
    const antes = await situacaoDaConta(c.id);
    assert.ok(antes.alertas.some((a) => a.codigo === 'beneficio_orfao'));
    await planoAdm.encerrarBeneficiosVencidos({ apenasContas: [c.id] });
    const { rows } = await pool.query(
      'SELECT plano_id, plano_cortesia, data_expiracao FROM anunciantes WHERE id = $1',
      [c.id],
    );
    assert.equal(rows[0].plano_id, 'destaque-3m', 'o plano pago sobrevive');
    const { rows: h } = await pool.query('SELECT status FROM planos_administrativos WHERE anunciante_id = $1', [c.id]);
    assert.equal(h[0].status, 'encerrado');
  } finally {
    await apagar(c.id);
  }
});

test('ciclo pago MAIOR por cima de benefício em vigor encerra o benefício (superado), sem devolver créditos', async () => {
  process.env.SAN_CHECKOUT_KEY = process.env.SAN_CHECKOUT_KEY || 'chave-de-teste';
  const sc = require('../src/financeiro/san-checkout');
  const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
  const c = await criarConta({ plano_id: 'essencial-1m', plano_cortesia: true, data_expiracao: somar(50) });
  try {
    await pool.query(
      `INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, status, origem, ativado_em)
       VALUES ($1, 'essencial-1m', $2, 'ativo', 'indicacao', now())`,
      [c.id, somar(50)],
    );
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: 'destaque-1m', status: 'ativa' });
    await sc.aplicarCicloPago(assinatura, `teste-ficha-${randomUUID()}`);
    const { rows } = await pool.query(
      'SELECT status, encerrado_motivo FROM planos_administrativos WHERE anunciante_id = $1',
      [c.id],
    );
    assert.deepEqual(rows, [{ status: 'encerrado', encerrado_motivo: 'superado_por_plano_pago' }]);
    const s = await situacaoDaConta(c.id);
    assert.equal(s.plano.agora.origem, 'assinatura');
    assert.equal(s.creditos.movimentacoes.filter((m) => m.tipo === 'estorno_resgate').length, 0, 'sem devolução');
    assert.ok(!s.alertas.some((a) => a.codigo === 'beneficio_orfao'), 'nenhum benefício órfão sobra');
  } finally {
    await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id]);
    await pool.query('DELETE FROM comissoes WHERE anunciante_id = $1', [c.id]);
    await apagar(c.id);
  }
});

// ---------- criativos ----------

test('criativo respeita o direito vigente: sem plano nunca "no ar"; comercial vencido não segura pelo comodato legado', async () => {
  const sem = await criarConta();
  const vencido = await criarConta({
    plano_id: 'destaque-3m',
    plano_cortesia: false,
    data_expiracao: somar(-2),
    comodato_plano_id: 'comodato-basico',
  });
  try {
    await criativo(sem.id);
    const s1 = await situacaoDaConta(sem.id);
    assert.equal(s1.criativos.resumo.noAr, 0);
    assert.equal(s1.criativos.resumo.aprovadosForaDoAr, 1);
    assert.equal(s1.plano.veicula, false);

    await criativo(vencido.id);
    const s2 = await situacaoDaConta(vencido.id);
    assert.equal(s2.plano.agora, null, 'comercial vencido: sem plano, mesmo com Básico legado');
    assert.ok(s2.plano.vencido);
    assert.equal(s2.criativos.resumo.noAr, 0, 'ficha e gerador concordam: fora do ar');
    assert.ok(s2.alertas.some((a) => a.codigo === 'plano_vencido'));
  } finally {
    await apagar(sem.id);
    await apagar(vencido.id);
  }
});

// ---------- suspensão ----------

test('suspender a conta não inativa o ponto nem a tela, e não apaga plano nem créditos', async () => {
  const c = await criarConta({ plano_id: 'destaque-3m', plano_cortesia: false, data_expiracao: somar(30) });
  const app = await subirApp();
  try {
    const p = await ponto(c.id, 'Loja Suspensa', { modalidade: 'mais-cota', status: 'em_operacao' });
    await pool.query(`INSERT INTO dispositivos (ponto_id, apelido, status) VALUES ($1, 'Tela 1', 'ativo')`, [p]);
    await creditosRepo.concederAdmin(c.id, 5, { motivo: 'teste' });
    const r = await app.chamar('PATCH', `/admin/anunciantes/${c.id}`, { suspenso: true });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const { rows: pts } = await pool.query('SELECT status FROM pontos WHERE id = $1', [p]);
    const { rows: tel } = await pool.query('SELECT status FROM dispositivos WHERE ponto_id = $1', [p]);
    assert.equal(pts[0].status, 'em_operacao');
    assert.equal(tel[0].status, 'ativo');
    const s = await situacaoDaConta(c.id);
    assert.equal(s.dados.suspensa, true);
    assert.equal(s.plano.veicula, false, 'sai da rotação');
    assert.equal(s.plano.agora.planoId, 'destaque-3m', 'o plano continua registrado');
    assert.equal(s.creditos.saldo, 5);
    assert.equal(s.pontos.length, 1);
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

// ---------- lista de Contas ----------

test('lista de Contas diz a origem certa do plano (créditos ≠ cortesia legada ≠ pago)', async () => {
  const pago = await criarConta({ plano_id: 'destaque-3m', plano_cortesia: false, data_expiracao: somar(30) });
  const porCreditos = await criarConta();
  const legada = await criarConta({ plano_id: 'destaque-3m', plano_cortesia: true, data_expiracao: somar(30) });
  const app = await subirApp();
  try {
    await creditosRepo.concederAdmin(porCreditos.id, 9, { motivo: 'teste' });
    const r = await app.chamar(
      'POST',
      '/anunciantes/me/creditos/resgatar',
      { tier: 'essencial', meses: 3 },
      {
        conta: porCreditos.id,
      },
    );
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const lista = await app.chamar('GET', '/admin/anunciantes');
    const origem = (id) => lista.corpo.find((a) => a.id === id).plano_origem;
    assert.equal(origem(pago.id), 'assinatura');
    assert.equal(origem(porCreditos.id), 'beneficio_creditos');
    assert.equal(origem(legada.id), 'cortesia_legada');
  } finally {
    await app.fechar();
    await apagar(pago.id);
    await apagar(porCreditos.id);
    await apagar(legada.id);
  }
});

test('rota da situação: 404 pra conta inexistente, sem cache', async () => {
  const app = await subirApp();
  try {
    const r = await app.chamar('GET', '/admin/anunciantes/999999999/situacao');
    assert.equal(r.status, 404);
  } finally {
    await app.fechar();
  }
});

test.after(() => pool.end());
