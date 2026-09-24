// Ficha de Conta do admin (revisão de 23/09/2026) — os 11 perfis do pedido
// do dono (A–K), cada um aberto na rota real, com captura de tela, e as
// frases que a ficha nunca pode contradizer. Mais: reatividade sem F5
// (créditos concedidos, crédito mensal do ponto e candidatura aprovada por
// fora aparecem sozinhos) e os fluxos (conceder créditos, suspender).
// Reestruturação de 24/09/2026 (ADR-016): os perfis E/F/G/I/K têm dados do
// modelo antigo (Inicial/Básico, R$ 50) de propósito — a ficha tem que
// mostrar a conta pelo modelo novo (sem card Comodato, sem R$ 50, benefício
// do ponto = +1 crédito/mês), com o legado só no banco.
// Assume servidor na 3999 e `DATABASE_URL` no ambiente. O crédito mensal do
// ponto vem de outro processo (o job) pelo LISTEN/NOTIFY do SSE, desligado
// com NODE_ENV=test: suba com `tests/e2e/restart.sh NODE_ENV=development ...`.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const B = 'http://localhost:3999';
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim()
    .split('\n')[0];
const falhas = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const dias = (n) => `(current_date + ${n})`;

// `campos`: coluna → expressão SQL já pronta (literal entre aspas simples).
function conta(nome, campos = {}) {
  const tudo = {
    nome_empresa: `'${nome}'`,
    cpf_cnpj: "'11144477735'",
    contato_email: `'ficha-${randomUUID()}@teste.com'`,
    contato_telefone: "'16999994444'",
    senha_hash: "'x'",
    aceitou_termos_em: 'now()',
    papeis: "'{anunciante}'",
    categoria_id: '(SELECT id FROM categorias WHERE ativo AND NOT legado ORDER BY id LIMIT 1)',
    ...campos,
  };
  return Number(
    PG(`INSERT INTO anunciantes (${Object.keys(tudo).join(', ')}) VALUES (${Object.values(tudo).join(', ')}) RETURNING id`),
  );
}
function ponto(contaId, nome, { modalidade = null, status = 'a_instalar', repasse = 0, tela = null } = {}) {
  const id = Number(
    PG(`INSERT INTO pontos (nome, endereco, bairro, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, plano_ponto_id, status, valor_pago_mensal)
        VALUES ('${nome}', 'Avenida 28 de Agosto, 2502', 'Centro', 'Matão', 'SP', '15990-000', 'outro', 'Resp', '16 90000-0000', ${contaId},
                ${modalidade ? `'${modalidade}'` : 'NULL'}, '${status}', ${repasse}) RETURNING id`),
  );
  if (tela) {
    PG(`INSERT INTO dispositivos (ponto_id, apelido, status, modo_horario, ultima_vez_online)
        VALUES (${id}, 'Tela 1', '${tela}', '24h', ${tela === 'ativo' ? 'now()' : 'NULL'})`);
  }
  return id;
}
function assinatura(contaId, plano) {
  PG(`INSERT INTO assinaturas (id, anunciante_id, plano_id, status) VALUES ('${randomUUID()}', ${contaId}, '${plano}', 'ativa')`);
}
function criativo(contaId, status = 'aprovado') {
  PG(`INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, duracao_segundos, status)
      VALUES (${contaId}, '/img/mockup-poster.png', '/img/mockup-poster.png', 10, '${status}')`);
}
function candidatura(contaId, nome) {
  return Number(
    PG(`INSERT INTO candidaturas (tipo, nome, nome_comercio, contato_telefone, endereco, bairro, cidade, uf, cep, conta_id, origem)
        VALUES ('ponto', 'Resp', '${nome}', '16999990000', 'Rua ${randomUUID().slice(0, 6)}, 10', 'Centro', 'Matão', 'SP', '15990-000', ${contaId}, 'painel')
        RETURNING id`),
  );
}

console.log('== perfis A–K ==');
const P = {};
P.A = conta('A · Conta comum', { categoria_id: '4' }); // e categoria antiga
P.B = conta('B · Plano pago', { plano_id: "'destaque-3m'", plano_cortesia: 'false', data_expiracao: dias(40) });
assinatura(P.B, 'destaque-3m');
criativo(P.B);
P.C = conta('C · Benefício por créditos', {
  plano_id: "'maximo-12m'",
  plano_cortesia: 'true',
  cortesia_motivo: "'Benefício por créditos'",
  data_inicio_cobertura: 'current_date',
  data_expiracao: dias(360),
});
PG(`INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, concedido_por, observacao, nota_interna) VALUES (${P.C}, 'concessao_admin', 150, 'Master-BHS', 'parceria de lançamento', 'combinado por WhatsApp')`);
const debito = PG(`INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, observacao) VALUES (${P.C}, 'resgate_beneficio', -120, 'Resgate: Prime · 12 meses') RETURNING id`);
PG(`INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, status, origem, ativado_em, ledger_id, observacao)
    VALUES (${P.C}, 'maximo-12m', ${dias(360)}, 'ativo', 'indicacao', now(), ${debito}, 'resgate de créditos')`);
P.D = conta('D · Pago + benefício programado', { plano_id: "'destaque-1m'", plano_cortesia: 'false', data_expiracao: dias(20) });
assinatura(P.D, 'destaque-1m');
PG(`INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, status, origem, plano_anterior_id, plano_anterior_origem, plano_anterior_valido_ate)
    VALUES (${P.D}, 'maximo-3m', ${dias(110)}, 'agendado', 'indicacao', 'destaque-1m', 'assinatura', ${dias(20)})`);
P.E = conta('E · Dono de ponto (legado 1)', { comodato_plano_id: "'inicial-1m'" });
const pontoE = ponto(P.E, 'Loja E', { modalidade: 'ajuda-custo', status: 'em_operacao', repasse: 50, tela: 'ativo' });
PG(`UPDATE dispositivos SET aparelho_id = 'ap-e2e-${randomUUID()}' WHERE ponto_id = ${pontoE}`);
criativo(P.E);
P.F = conta('F · Dono de ponto (legado 2)', { comodato_plano_id: "'comodato-basico'", credito_comodato_mensal: '50' });
ponto(P.F, 'Loja F', { modalidade: 'mais-cota', status: 'em_operacao', tela: 'ativo' });
P.G = conta('G · Legado + plano pago', {
  comodato_plano_id: "'comodato-basico'",
  credito_comodato_mensal: '50',
  plano_id: "'destaque-3m'",
  plano_cortesia: 'false',
  data_expiracao: dias(60),
});
assinatura(P.G, 'destaque-3m');
ponto(P.G, 'Loja G', { modalidade: 'mais-cota', status: 'em_operacao', tela: 'ativo' });
ponto(P.G, 'Loja G 2', { modalidade: 'mais-cota', status: 'em_reparo', tela: 'reparo' });
P.H = conta('H · Candidatura em análise');
const candH = candidatura(P.H, 'Padaria Pedida');
P.I = conta('I · Ponto aguardando instalação', { comodato_plano_id: "'comodato-basico'", credito_comodato_mensal: '50' });
ponto(P.I, 'Loja Nova', { modalidade: 'mais-cota' });
P.J = conta('J · Ponto inativo (caso Santos unio)', {
  categoria_id: '4',
  plano_id: "'maximo-12m'",
  plano_cortesia: 'true',
  cortesia_motivo: "'Cortesia administrativa'",
  data_inicio_cobertura: 'current_date',
  data_expiracao: dias(365),
});
PG(`INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, status, origem, ativado_em, concedido_por)
    VALUES (${P.J}, 'maximo-12m', ${dias(365)}, 'ativo', 'admin', now(), 'Master-BHS')`);
ponto(P.J, 'Santos unio', { status: 'inativo', tela: 'inativo' });
candidatura(P.J, 'Mostrai SANCO');
criativo(P.J);
P.K = conta('K · Conta suspensa', { suspenso: 'true', plano_id: "'destaque-3m'", plano_cortesia: 'false', data_expiracao: dias(30) });
ponto(P.K, 'Loja K', { modalidade: 'mais-cota', status: 'em_operacao', tela: 'ativo' });
PG(`UPDATE anunciantes SET comodato_plano_id = 'comodato-basico', credito_comodato_mensal = 50 WHERE id = ${P.K}`);
criativo(P.K);
// L: Pro PAGO guardado por baixo de um benefício Prime (migration 082).
P.L = conta('L · Pago guardado sob benefício', {
  plano_id: "'maximo-1m'",
  plano_cortesia: 'true',
  cortesia_motivo: "'Benefício por créditos'",
  data_inicio_cobertura: 'current_date',
  data_expiracao: dias(25),
  plano_pago_guardado_id: "'destaque-1m'",
  plano_pago_guardado_dias: '30',
});
assinatura(P.L, 'destaque-1m');
PG(`INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, status, origem, ativado_em)
    VALUES (${P.L}, 'maximo-1m', ${dias(25)}, 'ativo', 'indicacao', now())`);
console.log('  contas:', JSON.stringify(P));

// O que cada perfil TEM que mostrar.
// Ser ponto não dá plano (ADR-016): E/F/I, com Inicial/Básico legado, ficam
// "Sem plano". Nenhum perfil tem card Comodato.
const ESPERADO = {
  A: { selo: false, pontos: false, solicitacoes: false, plano: /Sem plano/ },
  B: { selo: false, pontos: false, solicitacoes: false, plano: /Assinatura paga/, renova: true },
  C: { selo: false, pontos: false, solicitacoes: false, plano: /Benefício por créditos/ },
  D: { selo: false, pontos: false, solicitacoes: false, plano: /Assinatura paga/, proximo: true },
  E: { selo: true, pontos: true, solicitacoes: false, plano: /Sem plano/ },
  F: { selo: true, pontos: true, solicitacoes: false, plano: /Sem plano/ },
  G: { selo: true, pontos: true, solicitacoes: false, plano: /Assinatura paga/ },
  H: { selo: false, pontos: false, solicitacoes: true, plano: /Sem plano/ },
  I: { selo: true, pontos: true, solicitacoes: false, plano: /Sem plano/ },
  J: { selo: true, pontos: true, solicitacoes: true, plano: /Cortesia administrativa legada/ },
  K: { selo: true, pontos: true, solicitacoes: false, plano: /Assinatura paga/ },
  L: { selo: false, pontos: false, solicitacoes: false, plano: /Benefício por créditos/ },
};
const PROIBIDO =
  /Conceder plano|Liberar plano|Alterar plano|Cancelar plano|Comodato|comodato|\bInicial\b|Básico|R\$ ?50|50 reais|repasse|ajuda de custo|crédito monetário|modalidade|undefined|NaN|\bnull\b|destaque-\d+m|maximo-\d+m|comodato-basico|inicial-1m|mais-cota|ajuda-custo|a_instalar|em_operacao|beneficio_creditos|cortesia_legada|concessao_admin|resgate_beneficio|credito_mensal_ponto|pago_guardado/;

const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
const admin = await ctx.newPage();
const errosConsole = [];
await admin.goto(`${B}/admin/index.html`);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('.admin-shell');
// Só depois do login: antes dele, o 401 do teste de sessão é o esperado.
admin.on('console', (m) => {
  if (m.type() === 'error') errosConsole.push(m.text());
});
admin.on('pageerror', (e) => errosConsole.push(String(e)));

async function abrir(id) {
  await admin.evaluate((h) => {
    location.hash = h;
  }, `contas/contas/${id}`);
  await admin.waitForSelector('.conta-cabecalho');
  await admin.waitForTimeout(250);
}

for (const [perfil, id] of Object.entries(P)) {
  console.log(`== perfil ${perfil} ==`);
  await abrir(id);
  const e = ESPERADO[perfil];
  const texto = await admin.locator('#conteudo').innerText();
  const cabecalho = await admin.locator('.conta-cabecalho').innerText();
  check(`${perfil}: selo Dono de ponto ${e.selo ? 'presente' : 'ausente'}`, /Dono de ponto/.test(cabecalho) === e.selo);
  check(`${perfil}: sem selo "Anunciante"`, !/Anunciante/.test(cabecalho));
  check(`${perfil}: sem card Comodato`, (await admin.locator('#contaComodato').count()) === 0);
  check(`${perfil}: card Pontos ${e.pontos ? 'presente' : 'ausente'}`, (await admin.locator('#contaPontos').count()) === (e.pontos ? 1 : 0));
  check(
    `${perfil}: Solicitações ${e.solicitacoes ? 'presente' : 'ausente'}`,
    (await admin.locator('#contaSolicitacoes').count()) === (e.solicitacoes ? 1 : 0),
  );
  const plano = await admin.locator('#contaPlano').innerText();
  check(`${perfil}: Plano diz ${e.plano}`, e.plano.test(plano), plano.slice(0, 200));
  if (e.renova) check(`${perfil}: mostra próxima renovação`, /Próxima renovação/.test(plano));
  if (e.proximo) check(`${perfil}: mostra benefício Próximo`, /Próximo/i.test(plano) && /Benefício por créditos/.test(plano));
  check(`${perfil}: nada proibido/slug técnico na tela`, !PROIBIDO.test(texto), (texto.match(PROIBIDO) || [])[0]);
  check(`${perfil}: históricos recolhidos`, (await admin.locator('details[data-historico][open]').count()) === 0);
  check(`${perfil}: sem rolagem horizontal`, await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await admin.screenshot({ path: `${SAIDA}ficha-${perfil}.png`, fullPage: true });
}

console.log('== conteúdo específico ==');
await abrir(P.J);
let t = await admin.locator('#contaPontos').innerText();
check('J: ponto Inativo continua em Pontos', /Inativo/.test(t));
check('J: ponto inativo fora do programa de créditos', /\+1 crédito\/mês/.test(t) && /fora do programa/.test(t), t);
check('J: nenhum alerta de modalidade', !(await admin.locator('.conta-alertas').count()) || !/modalidade/.test(await admin.locator('.conta-alertas').innerText()));
check('J: categoria antiga com sugestões', (await admin.locator('.categoria-sugestoes button').count()) >= 1);
await abrir(P.E);
t = await admin.locator('#contaPontos').innerText();
check('E: benefício do ponto +1 crédito/mês, sem R$ 50', /\+1 crédito\/mês/.test(t) && !/R\$/.test(t), t);
check('E: Inicial legado não dá plano', /Sem plano/.test(await admin.locator('#contaPlano').innerText()));
await abrir(P.F);
check('F: 0 créditos — o crédito monetário antigo não virou crédito', /0 créditos/.test(await admin.locator('#contaCreditos').innerText()));
await abrir(P.D);
t = await admin.locator('#contaPlano').innerText();
check('D: Depois volta ao Pro pago, sem perder dia pago', /Volta ao Pro[\s\S]*nenhum dia pago se perde/.test(t), t);
await abrir(P.L);
t = await admin.locator('#contaPlano').innerText();
check('L: Agora benefício Prime, Próximo o Pro pago guardado com os dias', /Prime[\s\S]*Próximo[\s\S]*Pro[\s\S]*Guardado[\s\S]*30 dias pagos/i.test(t), t);
await abrir(P.C);
await admin.click('details[data-historico="movimentacoes"] summary');
t = await admin.locator('#contaCreditos').innerText();
check('C: movimentação mostra motivo, nota interna e quem concedeu', /parceria de lançamento/.test(t) && /Nota interna/.test(t) && /Master-BHS/.test(t));
await admin.click('details[data-historico="beneficios"] summary');
t = await admin.locator('#contaCreditos').innerText();
check('C: histórico de benefícios diz o custo em créditos', /120 créditos/.test(t));
await abrir(P.K);
t = await admin.locator('#contaCriativos').innerText();
check('K: nenhum criativo no ar — conta suspensa', /Nenhum no ar — conta suspensa/.test(t));
check('K: botão Reativar no fim', (await admin.locator('#contaRodape [data-reativar]').count()) === 1);
check('K: sem Conceder créditos (suspensa)', (await admin.locator('[data-creditos-conceder]').count()) === 0);

await abrir(P.B);
check('B: "Veiculando" (tem peça no ar)', /Veiculando/.test(await admin.locator('#contaPlano').innerText()));
await abrir(P.D);
check('D: "Sem peça no ar" (plano vigente, nenhum criativo)', /Sem peça no ar/.test(await admin.locator('#contaPlano').innerText()));

console.log('== reatividade sem F5 ==');
await abrir(P.C);
// O botão Atualizar recria o contêiner da aba — o canal de eventos tem que
// continuar valendo depois dele.
await admin.click('#btnRecarregar');
await admin.waitForSelector('.conta-cabecalho');
await admin.evaluate(() => {
  window.__semRecarregar = true;
});
const saldoAntes = await admin.locator('.creditos-saldo b').innerText();
await admin.evaluate(async (id) => {
  await fetch(`/admin/anunciantes/${id}/creditos/conceder`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantidade: 7, motivo: 'por fora da ficha' }),
  });
}, P.C);
await admin.waitForFunction((antes) => document.querySelector('.creditos-saldo b')?.textContent !== antes, saldoAntes, {
  timeout: 8000,
});
check('C: saldo mudou sozinho (SSE)', (await admin.locator('.creditos-saldo b').innerText()) === '37 créditos');
check('C: sem recarregar a página', await admin.evaluate(() => window.__semRecarregar === true));

await abrir(P.H);
await admin.evaluate(async (cand) => {
  await fetch(`/admin/candidaturas/${cand}/liberar`, { method: 'POST', credentials: 'include' });
}, candH);
await admin.waitForSelector('#contaPontos', { timeout: 8000 });
check('H: aprovou por fora → Pontos apareceu sozinho', true);
check('H: selo Dono de ponto apareceu', /Dono de ponto/.test(await admin.locator('.conta-cabecalho').innerText()));
check('H: Solicitações sumiu (virou ponto)', (await admin.locator('#contaSolicitacoes').count()) === 0);
check('H: sem recarregar a página', await admin.evaluate(() => window.__semRecarregar === true));

console.log('== crédito mensal do ponto aparece sozinho na ficha (E) ==');
await abrir(P.E);
await admin.evaluate(() => {
  window.__semRecarregar = true;
});
execSync(
  `node -e "require('./src/creditos/ponto').concederCreditosMensais({ apenasPontos: [${pontoE}] }).then(() => setTimeout(() => process.exit(0), 600))"`,
  { cwd: new URL('../..', import.meta.url).pathname, env: process.env },
);
await admin
  .waitForFunction(() => /1 crédito/.test(document.querySelector('.creditos-saldo b')?.textContent || ''), null, { timeout: 8000 })
  .catch(() => {});
check('E: saldo 1 crédito sozinho (SSE)', (await admin.locator('.creditos-saldo b').innerText()) === '1 crédito');
await admin.click('details[data-historico="movimentacoes"] summary');
t = await admin.locator('#contaCreditos').innerText();
check('E: movimentação "Crédito mensal do ponto · Loja E"', /Crédito mensal do ponto · Loja E/.test(t), t);
t = await admin.locator('#contaPontos').innerText();
check('E: ponto diz que o crédito do mês já saiu', /último: /.test(t) && /próximo: /.test(t), t);
check('E: sem recarregar a página', await admin.evaluate(() => window.__semRecarregar === true));

console.log('== conceder créditos pela ficha ==');
await abrir(P.A);
await admin.click('[data-creditos-conceder]');
await admin.fill('#creditosQtd', '120');
check('modal mostra prévia do saldo', /0 créditos.*120 créditos/.test(await admin.locator('[data-previa]').innerText()));
await admin.click('dialog button[type=submit]');
check(
  'sem motivo não envia (campo obrigatório barra)',
  (await admin.locator('dialog[open]').count()) === 1 && (await admin.locator('#creditosMotivo:invalid').count()) === 1,
);
await admin.fill('#creditosMotivo', 'parceria de lançamento');
await admin.fill('#creditosNota', 'só o time vê');
await admin.click('dialog button[type=submit]');
await admin.waitForFunction(() => /120 créditos/.test(document.querySelector('.creditos-saldo b')?.textContent || ''));
check('A: saldo 120 após conceder', true);
check('A: plano continua "Sem plano" (créditos não viram plano sozinhos)', /Sem plano/.test(await admin.locator('#contaPlano').innerText()));
await admin.screenshot({ path: `${SAIDA}ficha-A-depois-de-conceder.png`, fullPage: true });

console.log('== categoria antiga: um clique ==');
await admin.locator('.categoria-sugestoes button').first().click();
await admin.waitForFunction(() => !document.querySelector('.categoria-sugestoes'));
check('A: aviso de categoria antiga some depois de trocar', !/categoria antiga/.test(await admin.locator('#contaDados').innerText()));

console.log('== suspender (B) — confirmação séria ==');
await abrir(P.B);
await admin.click('[data-suspender]');
check('botão de suspender começa desligado', await admin.locator('dialog [data-confirmar]').isDisabled());
await admin.check('dialog [data-entendi]');
await admin.click('dialog [data-confirmar]');
await admin.waitForSelector('.conta-cabecalho .conta-sinal-err');
check('B: suspensa', /Conta suspensa/.test(await admin.locator('.conta-cabecalho').innerText()));
await admin.click('[data-reativar]');
await admin.click('dialog [data-confirmar]');
await admin.waitForFunction(() => !document.querySelector('.conta-cabecalho .conta-sinal-err'));
check('B: reativada', true);

console.log('== celular ==');
await admin.setViewportSize({ width: 390, height: 844 });
for (const perfil of ['G', 'J', 'C', 'L']) {
  await abrir(P[perfil]);
  check(`${perfil} (390px): sem rolagem horizontal`, await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await admin.screenshot({ path: `${SAIDA}ficha-${perfil}-celular.png`, fullPage: true });
}

console.log('== console ==');
check('nenhum erro no console', errosConsole.length === 0, errosConsole.join(' | '));

await b.close();

// Limpa o que criou: contas com plano e criativo aprovado entram na playlist
// e mudam o resultado dos testes de geração (`npm test`) no mesmo banco.
PG(`CREATE TEMP TABLE alvo AS SELECT id FROM anunciantes WHERE contato_email LIKE 'ficha-%@teste.com';
    DELETE FROM eventos WHERE anunciante_id IN (SELECT id FROM alvo);
    DELETE FROM notificacoes WHERE anunciante_id IN (SELECT id FROM alvo);
    DELETE FROM planos_administrativos WHERE anunciante_id IN (SELECT id FROM alvo);
    DELETE FROM creditos_ledger WHERE anunciante_id IN (SELECT id FROM alvo);
    DELETE FROM cupons_ponto WHERE conta_id IN (SELECT id FROM alvo);
    DELETE FROM criativos WHERE anunciante_id IN (SELECT id FROM alvo);
    DELETE FROM assinaturas WHERE anunciante_id IN (SELECT id FROM alvo);
    DELETE FROM dispositivos WHERE ponto_id IN (SELECT id FROM pontos WHERE anunciante_id IN (SELECT id FROM alvo));
    DELETE FROM pontos WHERE anunciante_id IN (SELECT id FROM alvo);
    DELETE FROM candidaturas WHERE conta_id IN (SELECT id FROM alvo);
    DELETE FROM anunciantes WHERE id IN (SELECT id FROM alvo)`);
console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO OK');
process.exit(falhas.length ? 1 : 0);
