require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const anunciantesRepo = require('../src/anunciantes/repository');
const dispositivosRepo = require('../src/dispositivos/repository');
const movel = require('../src/pontos/movel');
const credencial = require('../src/player/credencial');
const { instalarPlayer } = require('./apoio-player');

// PONTO FIXO VENDÁVEL × AGUARDANDO INSTALAÇÃO (ADR-047, 14/10/2026). Aprovar
// o estabelecimento não é ter inventário no lugar: o fixo só entra na escolha
// do anunciante, no site e na contagem comercial depois que alguma tela dele
// deu o 1º sinal real do Player (D1). O instalado que depois ficou offline,
// em reparo ou com o Player revogado continua vendável. O Admin recebe a
// instalação e a disponibilidade já decididas, a data prevista e a passagem
// do Mostraí Móvel vinculada ao ponto. A regra é uma só
// (src/pontos/repository.js: fixoVendavelSql / aguardandoInstalacaoSql).
//
// Os 7 casos de cada ponto saem pelos caminhos reais (tela criada pelo
// repositório, Player instalado pela troca do código, revogado, tela em
// reparo ou inativa) — o status é o que o sincronizar decide, nunca forçado.
// Os arquivos de teste rodam em paralelo no mesmo banco: toda asserção sobre
// listas globais olha só os ids criados aqui.

process.env.SESSION_SECRET ||= 'teste-instalacao-fixa';

let app;
test.before(async () => {
  const a = express();
  a.use(express.json());
  a.use(session({ secret: 'teste-instalacao-fixa', resave: false, saveUninitialized: false }));
  a.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    // As rotas /admin deste roteador são montadas atrás da sessão do Admin
    // em server.js; aqui o roteador vem direto (como pontos-exclusao.test.js).
    req.session.adminUsuario = 'teste';
    proximo();
  });
  a.use(require('../src/anunciantes/routes').router);
  a.use(require('../src/pontos/routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = a.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, { conta, corpo } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (conta) headers['x-conta'] = String(conta);
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await r.text();
    let json = null;
    try {
      json = JSON.parse(texto);
    } catch {}
    return { status: r.status, json, texto };
  };
  app = { chamar, fechar: () => new Promise((r) => server.close(r)) };
});

// ---------------------------------------------------------------------------
// Dados de teste (limpos no fim)
// ---------------------------------------------------------------------------
const criados = { contas: [], pontos: [], redes: [] };

async function novaConta({ plano = 'essencial-1m' } = {}) {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Instalação ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `instalacao-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  criados.contas.push(conta.id);
  if (plano) await pool.query('UPDATE anunciantes SET plano_id = $2 WHERE id = $1', [conta.id, plano]);
  return conta.id;
}

async function pontoFixo({ dono = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, status)
     VALUES ($1, 'Rua X, 1', 'Matão', 'SP', '15990000', 'outro', 'R', '1', $2, 'a_instalar') RETURNING id`,
    [`Instalação ${randomUUID().slice(0, 8)}`, dono],
  );
  criados.pontos.push(rows[0].id);
  return rows[0].id;
}

// Os 7 casos da prova do predicado (commit a474994), pelos caminhos reais:
//   A nunca instalado, sem tela             → aguardando
//   B tela cadastrada, sem Player           → aguardando
//   C tela em reparo que nunca operou       → aguardando (em_reparo)
//   D Player revogado depois de operar      → vendável (a_instalar)
//   E em operação                           → vendável
//   F tela em reparo depois de operar       → vendável (em_reparo)
//   G inativo (telas desligadas pelo Admin) → nem um nem outro
async function montar(caso, { dono = null } = {}) {
  const id = await pontoFixo({ dono });
  if (caso === 'A') return id;
  const tela = await dispositivosRepo.criar(id, caso === 'C' ? { status: 'reparo' } : {});
  if (caso === 'B' || caso === 'C') return id;
  await instalarPlayer(tela.id);
  if (caso === 'D') await credencial.revogar(tela.id);
  if (caso === 'F') await dispositivosRepo.atualizar(tela.id, { status: 'reparo' });
  if (caso === 'G') await dispositivosRepo.atualizar(tela.id, { status: 'inativo' });
  return id;
}

// Instalado e OFFLINE: em operação, sem sinal há 3 dias. Offline é alerta,
// não estado do ponto — continua vendável.
async function instaladoOffline() {
  const id = await montar('E');
  await pool.query(`UPDATE dispositivos SET ultima_vez_online = now() - interval '3 days' WHERE ponto_id = $1`, [id]);
  return id;
}

const statusDe = async (id) => (await pool.query('SELECT status FROM pontos WHERE id = $1', [id])).rows[0].status;

async function todosOsCasos() {
  const c = {};
  for (const caso of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) c[caso] = await montar(caso);
  c.Eoff = await instaladoOffline();
  // Os status vieram do sincronizar real — o mesmo cenário da prova.
  assert.deepStrictEqual(await Promise.all(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'Eoff'].map((k) => statusDe(c[k]))), [
    'a_instalar',
    'a_instalar',
    'em_reparo',
    'a_instalar',
    'em_operacao',
    'em_reparo',
    'inativo',
    'em_operacao',
  ]);
  return c;
}

// Rede móvel de uma cidade única (uma por cidade), pelo caminho do Admin, com
// `telas` telas cadastradas.
async function novaRede({ telas = 1 } = {}) {
  const rede = await movel.criarRedeMovel({ nome: 'Mostraí Móvel', cidade: `Instalação ${randomUUID()}`, uf: 'SP' });
  criados.redes.push(rede.id);
  const ids = [];
  for (let i = 0; i < telas; i++) ids.push((await dispositivosRepo.criar(rede.id, {})).id);
  return { id: rede.id, nome: rede.nome, telas: ids };
}

// Passagem do Mostraí Móvel gravada direto no banco, já com o vínculo da
// migration 123 (local_ponto_id = o ponto fixo). A rota que grava o vínculo
// é de outra fatia; aqui importa o que a ficha do Admin e a exclusão leem.
// `de`/`ate`: horas a partir de agora.
async function passagem({ rede, tela, conta, ponto, estado = 'programada', de = 24, ate = 48 }) {
  const quando = (horas) => new Date(Date.now() + horas * 3_600_000);
  const inicio = quando(de);
  const fim = quando(ate);
  const final = {
    programada: {},
    ativa: { iniciada: inicio },
    cancelada: { cancelada: new Date() },
    encerrada: { iniciada: inicio, encerrada: fim, encerramento: 'manual', tempo: 0, beneficio: 0 },
  }[estado];
  const { rows } = await pool.query(
    `INSERT INTO pontos_moveis_hospedagens
       (ponto_id, dispositivo_id, conta_id, local_ponto_id, local, endereco, data_inicio, data_fim, percentual,
        inicio, fim, estado, motivo_alocacao, iniciada_em, encerrada_em, cancelada_em, encerramento,
        tempo_operacional_segundos, beneficio_segundos)
     VALUES ($1, $2, $3, $4, 'Loja do ponto', 'Rua X, 1',
             ($5::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
             ($6::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date, 20,
             $5, $6, $7, 'aguardando_instalacao', $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      rede,
      tela,
      conta,
      ponto,
      inicio,
      fim,
      estado,
      final.iniciada ?? null,
      final.encerrada ?? null,
      final.cancelada ?? null,
      final.encerramento ?? null,
      final.tempo ?? null,
      final.beneficio ?? null,
    ],
  );
  return Number(rows[0].id);
}

const ERRO_EM_INSTALACAO = 'Esse ponto ainda está em instalação e ainda não pode ser escolhido.';
const ERRO_FORA_DA_REDE = 'um dos pontos escolhidos não existe na rede';

const disponiveis = async (conta) => {
  const r = await app.chamar('GET', '/anunciantes/me/pontos-disponiveis', { conta });
  assert.strictEqual(r.status, 200, r.texto);
  return r.json;
};
const idsDisponiveis = async (conta) => new Set((await disponiveis(conta)).pontos.map((p) => p.id));
const escolher = (conta, pontos) => app.chamar('PUT', '/anunciantes/me/pontos', { conta, corpo: { pontos } });
const escolhasNoBanco = async (conta) =>
  (
    await pool.query('SELECT ponto_id FROM anunciantes_pontos WHERE anunciante_id = $1 ORDER BY escolhido_em', [conta])
  ).rows.map((r) => r.ponto_id);
const idsDoSite = async () => {
  const r = await app.chamar('GET', '/pontos');
  assert.strictEqual(r.status, 200, r.texto);
  return new Set(r.json.map((p) => p.id));
};

test.after(async () => {
  await app.fechar();
  // Métrica anônima da criação da rede ainda gravando: espera antes de limpar.
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const id of criados.redes) await pool.query('DELETE FROM pontos_moveis_hospedagens WHERE ponto_id = $1', [id]);
  for (const id of [...criados.pontos, ...criados.redes]) {
    await pool.query(
      `DELETE FROM eventos WHERE anunciante_id IS NULL
          AND (propriedades->>'ponto_id' = $1::int::text
               OR propriedades->>'dispositivo_id' IN (SELECT id::text FROM dispositivos WHERE ponto_id = $1::int))`,
      [id],
    );
    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
  }
  for (const id of criados.contas) {
    await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM obrigacoes_veiculacao WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM ciclos_contratados WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await pool.end();
});

// ===========================================================================
// Escolha do anunciante e site (itens 1, 2, 3, 4 e 19 do dono)
// ===========================================================================
test('itens 1, 3 e 4: a lista de escolha só traz o fixo instalado (mesmo offline, em reparo ou revogado) e a rede', async () => {
  const conta = await novaConta();
  const c = await todosOsCasos();
  const proprio = await montar('A', { dono: conta });
  const rede = await novaRede();
  const ids = await idsDisponiveis(conta);
  for (const k of ['D', 'E', 'Eoff', 'F']) assert.ok(ids.has(c[k]), `instalado (${k}) continua escolhível`);
  assert.ok(ids.has(rede.id), 'a rede móvel aparece como hoje');
  for (const k of ['A', 'B', 'C', 'G']) assert.ok(!ids.has(c[k]), `${k} não aparece para o cliente`);
  assert.ok(!ids.has(proprio), 'o próprio ponto da conta aguardando instalação também sai');
});

test('item 2: o PUT recusa o ponto em instalação com o motivo; aceita o instalado fora do ar; mantém o 400 de limite e o 409', async () => {
  const conta = await novaConta(); // essencial: 3 pontos
  const c = await todosOsCasos();
  const proprio = await montar('A', { dono: conta });
  const rede = await novaRede();
  for (const id of [c.A, c.B, c.C, proprio]) {
    const r = await escolher(conta, [id]);
    assert.strictEqual(r.status, 400, r.texto);
    assert.deepStrictEqual(r.json, { erro: ERRO_EM_INSTALACAO });
  }
  assert.deepStrictEqual(await escolhasNoBanco(conta), [], 'nada salvo');
  // Inexistente, inativo e arquivado: o 400 de antes.
  const arquivado = await pontoFixo();
  await pool.query(
    `UPDATE pontos SET status = 'arquivado', arquivado_em = now(), motivo_arquivamento = 'teste' WHERE id = $1`,
    [arquivado],
  );
  for (const id of [2147483000, c.G, arquivado]) {
    const r = await escolher(conta, [id]);
    assert.strictEqual(r.status, 400, r.texto);
    assert.deepStrictEqual(r.json, { erro: ERRO_FORA_DA_REDE });
  }
  // O limite do plano continua vindo antes de tudo.
  const limite = await escolher(conta, [c.A, c.B, c.C, c.D]);
  assert.strictEqual(limite.status, 400);
  assert.match(limite.json.erro, /cobre 3 ponto\(s\) e você marcou 4/);
  // Instalado fora do ar agora (revogado, em reparo, offline): escolha válida.
  const ok = await escolher(conta, [c.D, c.F, c.Eoff]);
  assert.strictEqual(ok.status, 200, ok.texto);
  assert.deepStrictEqual(await escolhasNoBanco(conta), [c.D, c.F, c.Eoff]);
  assert.strictEqual((await escolher(conta, [rede.id])).status, 200, 'a rede como hoje');
  // O 409 de ocupação continua, e depois da validade do ponto.
  await pool.query('UPDATE pontos SET escolha_bloqueada_em = now() WHERE id = $1', [c.E]);
  const cheio = await escolher(conta, [c.E]);
  assert.strictEqual(cheio.status, 409, cheio.texto);
  assert.deepStrictEqual(cheio.json.pontosBloqueados, [c.E]);
  const misto = await escolher(conta, [c.A, c.E]);
  assert.strictEqual(misto.status, 400);
  assert.deepStrictEqual(misto.json, { erro: ERRO_EM_INSTALACAO });
});

test('item 3: o site e a contagem comercial (GET /pontos) só trazem o fixo instalado e a rede', async () => {
  const c = await todosOsCasos();
  const rede = await novaRede();
  const site = await idsDoSite();
  for (const k of ['D', 'E', 'Eoff', 'F']) assert.ok(site.has(c[k]), `instalado (${k}) aparece no site`);
  assert.ok(site.has(rede.id), 'a rede aparece como hoje');
  for (const k of ['A', 'B', 'C', 'G']) assert.ok(!site.has(c[k]), `${k} não aparece no site nem conta como ponto`);
});

test('item 19: o Móvel parado num ponto aguardando não torna o estabelecimento escolhível — a posição é a rede', async () => {
  const dono = await novaConta();
  const cliente = await novaConta();
  const ponto = await montar('A', { dono });
  const rede = await novaRede();
  await passagem({ rede: rede.id, tela: rede.telas[0], conta: dono, ponto, estado: 'ativa', de: -1, ate: 24 });
  const ids = await idsDisponiveis(cliente);
  assert.ok(ids.has(rede.id), 'a rede é a posição do plano');
  assert.ok(!ids.has(ponto), 'o estabelecimento não vira ponto selecionável');
  assert.ok(!(await idsDoSite()).has(ponto), 'nem aparece no site');
  const r = await escolher(cliente, [ponto]);
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(r.json, { erro: ERRO_EM_INSTALACAO });
  assert.strictEqual((await escolher(cliente, [rede.id])).status, 200);
});
