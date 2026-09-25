// Reestruturação do benefício dos pontos (24/09/2026, ADR-016) no navegador:
// o modelo antigo (Inicial/Básico, R$ 50, repasse, ajuda de custo, comodato
// comercial, Conceder plano) não aparece em NENHUMA tela ativa — admin, painel
// do cliente e site público — e a compra de um plano pago por cima de um
// benefício por créditos mostra o aviso ANTES de pagar.
//
// O comodato JURÍDICO do equipamento (/comodato.html, link no rodapé) é
// documento legal e fica de fora da varredura de propósito: não se reescreve
// contrato em silêncio (ver docs/PENDENCIAS.md).
//
// Assume servidor na 3999 e `DATABASE_URL` no ambiente. O crédito do mês é
// concedido por OUTRO processo (o job diário, como em produção) e chega ao
// painel pelo LISTEN/NOTIFY do barramento SSE — desligado com NODE_ENV=test,
// então suba o servidor com `tests/e2e/restart.sh NODE_ENV=development ...`.
import { chromium } from 'playwright';
import { acompanharRede, irQuieto, recarregarQuieto } from './espera.mjs';
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

const ANTIGO =
  /\bInicial\b|Básico|Basico|R\$ ?50\b|50 reais|repasses?\b|ajuda de custo|cr[eé]dito monet[aá]rio|receber dinheiro|Comodato|comodato|Conceder plano|Liberar plano|modalidade/i;

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
const erros = [];

function vigiar(p) {
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) erros.push(`console: ${m.text()}`);
  });
}

// ---------------------------------------------------------------------------
console.log('== site público ==');
{
  const p = await ctx.newPage();
  vigiar(p);
  for (const pagina of ['/', '/pontos.html', '/planos.html', '/contato.html']) {
    await irQuieto(p, `${B}${pagina}`);
    const texto = await p.locator('main').innerText();
    check(`${pagina}: sem oferta ou texto do modelo antigo`, !ANTIGO.test(texto), (texto.match(ANTIGO) || [])[0]);
  }
  await irQuieto(p, `${B}/`);
  check('home: ponto acumula créditos, sem prometer dinheiro', /acumula créditos/.test(await p.locator('main').innerText()));
  await irQuieto(p, `${B}/planos.html`);
  const planos = await p.locator('main').innerText();
  check('planos: Essencial, Pro e Prime', /Essencial/.test(planos) && /\bPro\b/.test(planos) && /Prime/.test(planos));
  const publicos = await p.evaluate(async () => (await fetch('/planos')).json());
  check(
    'GET /planos só com os 3 tiers comerciais',
    publicos.every((x) => ['essencial', 'destaque', 'maximo'].includes(x.tier)),
    JSON.stringify(publicos.map((x) => x.id)),
  );
  // 410 desde 24/09/2026 (modalidades de ponto aposentadas). `p.request`
  // (fora da página) pra não deixar um "Failed to load resource" no console.
  check('GET /planos-ponto aposentado (410)', (await p.request.get(`${B}/planos-ponto`)).status() === 410);
  await p.close();
}

// ---------------------------------------------------------------------------
console.log('== admin ==');
{
  const admin = await ctx.newPage();
  await admin.goto(`${B}/admin/index.html`);
  await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
  await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
  await admin.click('button[type=submit]');
  await admin.waitForSelector('.admin-shell');
  vigiar(admin);
  const nav = await admin.locator('#nav').innerText();
  check('menu sem Repasses/Comodato', !ANTIGO.test(nav), (nav.match(ANTIGO) || [])[0]);
  const TELAS = [
    'visaogeral',
    'contas/contas',
    'rede/pontos',
    'ofertas/precos',
    'ofertas/promocoes',
    'financeiro/cobrancas',
    'financeiro/trocas',
    'financeiro/devolucoes',
  ];
  for (const h of TELAS) {
    await admin.evaluate((x) => {
      location.hash = x;
    }, h);
    await admin.waitForTimeout(900);
    const texto = await admin.locator('#conteudo').innerText();
    check(`#${h}: sem modelo antigo`, !ANTIGO.test(texto), (texto.match(ANTIGO) || [])[0]);
    const abas = await admin.locator('.abas, .sub-abas, [role="tablist"]').allInnerTexts();
    check(`#${h}: nenhuma aba Repasses`, !abas.some((a) => /Repasses/.test(a)));
  }
  for (const antigo of ['financeiro/repasses', 'pagamentospontos', 'comodato', 'configuracoes/comodato']) {
    await admin.evaluate((x) => {
      location.hash = x;
    }, antigo);
    await admin.waitForTimeout(700);
    const texto = await admin.locator('#conteudo').innerText();
    check(`#${antigo} antigo não abre tela de repasse/comodato`, !ANTIGO.test(texto), (texto.match(ANTIGO) || [])[0]);
  }
  await admin.screenshot({ path: `${SAIDA}creditos-admin-visaogeral.png`, fullPage: true });
  await admin.close();
}

// ---------------------------------------------------------------------------
console.log('== painel do cliente: dono de ponto com dados do modelo antigo ==');
async function contaPainel(prefixo, extra = '') {
  const email = `${prefixo}-${randomUUID().slice(0, 8)}@teste.com`;
  await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: `Loja ${prefixo}`,
      cpf_cnpj: '52998224725',
      contato_email: email,
      contato_telefone: '16999995555',
      senha: 'Senha123!',
      aceitou_termos: true,
      endereco: 'Rua Três, 3',
      cidade: 'Matão',
      uf: 'SP',
      cep: '15990000',
    }),
  });
  const id = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
  PG(`UPDATE anunciantes SET email_confirmado = true, papeis = ARRAY['anunciante','ponto'] ${extra} WHERE id = ${id}`);
  return { id, email };
}
async function entrar(conta, destino = '/anunciante/painel.html') {
  await ctx.clearCookies();
  const p = await ctx.newPage();
  vigiar(p);
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', conta.email);
  await p.fill('#senha', 'Senha123!');
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  // O painel termina de carregar antes de sair dele — navegar no meio das
  // buscas vira "Failed to fetch" no console.
  await p.waitForTimeout(1500);
  if (destino !== '/anunciante/painel.html') await irQuieto(p, `${B}${destino}`);
  return p;
}
const contas = [];
{
  const dono = await contaPainel('legado', ", comodato_plano_id = 'comodato-basico', credito_comodato_mensal = 50");
  contas.push(dono.id);
  const ponto = PG(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, status, plano_ponto_id, valor_pago_mensal)
     VALUES ('Santos unio', 'Rua Quatro, 4', 'Matão', 'SP', '15990000', 'outro', 'R', '16', ${dono.id}, 'em_operacao', 'ajuda-custo', 50) RETURNING id`,
  );
  // `chave_hash`: desde a consolidação (24/09/2026) o crédito mensal exige
  // credencial viva do Player V2 — tela só com a chave V1 não conta.
  PG(`INSERT INTO dispositivos (ponto_id, apelido, status, modo_horario, ultima_vez_online, aparelho_id, chave_hash)
      VALUES (${ponto}, 'Tela 1', 'ativo', '24h', now(), 'ap-e2e-${randomUUID()}', 'e2e-hash-${randomUUID()}')`);
  PG(`INSERT INTO pagamentos_ponto (ponto_id, competencia, valor, pago_em, forma) VALUES (${ponto}, date_trunc('month', now() - interval '1 month'), 50, now(), 'pix')`);
  const p = await entrar(dono);
  const texto = await p.locator('main').innerText();
  check('painel: sem Inicial/Básico/R$ 50/Recebimentos', !ANTIGO.test(texto) && !/Recebimentos/.test(texto), (texto.match(ANTIGO) || texto.match(/Recebimentos/) || [])[0]);
  check('painel: Meus pontos mostra o benefício do ponto', /Benefício do ponto: \+1 crédito por mês/.test(texto));
  check('painel: ser ponto não dá plano', /Nenhum plano comercial/.test(await p.locator('#modPlano').innerText()));
  // Job do mês: o crédito aparece no painel sozinho (SSE), com o ponto.
  await p.evaluate(() => {
    window.__semReload = true;
  });
  execSync(
    `node -e "require('./src/creditos/ponto').concederCreditosMensais({ apenasPontos: [${ponto}] }).then(() => setTimeout(() => process.exit(0), 600))"`,
    { cwd: new URL('../..', import.meta.url).pathname, env: process.env },
  );
  await p.waitForFunction(() => /\b1\b/.test(document.querySelector('#modCreditos')?.innerText || ''), null, { timeout: 8000 }).catch(() => {});
  const creditos = await p.locator('#modCreditos').innerText();
  check('créditos: saldo 1 sem F5', /\b1 crédito\b/.test(creditos) && (await p.evaluate(() => window.__semReload === true)), creditos.slice(0, 300));
  await p.waitForTimeout(800);
  const listaPontos = await p.locator('#pontosLista').innerText();
  check('Meus pontos: crédito do mês já concedido', /já concedido/.test(listaPontos), listaPontos.replace(/\s+/g, ' ').slice(0, 600));
  check('notificação do crédito do ponto', PG(`SELECT titulo FROM notificacoes WHERE anunciante_id = ${dono.id} AND tipo = 'credito_mensal_ponto'`) === 'Seu ponto Santos unio gerou 1 crédito');
  await p.screenshot({ path: `${SAIDA}creditos-painel-dono.png`, fullPage: true });
  // O evento de crédito recarrega vários módulos; fechar a aba no meio das
  // buscas vira "Failed to fetch" no console.
  await p.waitForTimeout(1500);
  await p.close();
}

// ---------------------------------------------------------------------------
console.log('== benefício Essencial ativo + compra do Prime: aviso antes de pagar ==');
{
  const conta = await contaPainel(
    'beneficio',
    ", plano_id = 'essencial-1m', plano_cortesia = true, cortesia_motivo = 'Benefício por créditos', data_inicio_cobertura = current_date, data_expiracao = current_date + 30",
  );
  contas.push(conta.id);
  PG(`INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, status, origem, ativado_em)
      VALUES (${conta.id}, 'essencial-1m', current_date + 30, 'ativo', 'indicacao', now())`);
  const p = await entrar(conta, '/anunciante/confirmar-plano.html?plano=maximo-1m');
  await p.waitForSelector('#btnConfirmarPlano', { timeout: 8000 });
  await p.click('#btnConfirmarPlano');
  await p.waitForSelector('dialog.dlg-resgate[open]', { timeout: 8000 });
  const aviso = await p.locator('dialog.dlg-resgate[open]').innerText();
  check('aviso diz que o benefício termina e os créditos não voltam', /será encerrado/.test(aviso) && /não serão devolvidos/.test(aviso), aviso);
  check('aviso diz que o Prime começa na hora', /começa imediatamente/.test(aviso));
  check('botões Voltar e Continuar com Prime', /Voltar/.test(aviso) && /Continuar com Prime/.test(aviso));
  await p.screenshot({ path: `${SAIDA}creditos-aviso-prime.png`, fullPage: true });
  await p.click('dialog.dlg-resgate [data-voltar]');
  check('Voltar não compra nada', PG(`SELECT count(*) FROM assinaturas WHERE anunciante_id = ${conta.id}`) === '0');
  check('benefício continua intacto', PG(`SELECT status FROM planos_administrativos WHERE anunciante_id = ${conta.id}`) === 'ativo');
  await p.close();
}

// ---------------------------------------------------------------------------
// ADR-018 (24/09/2026): custo por exibição prevista do SNAPSHOT do ciclo, e
// benefício por créditos com o nome do ciclo (Mensal/Trimestral/...).
console.log('== custo por exibição prevista: plano pago lê o snapshot do ciclo ==');
{
  const conta = await contaPainel(
    'custo',
    ", plano_id = 'destaque-3m', plano_cortesia = false, data_inicio_cobertura = current_date, data_expiracao = current_date + 90",
  );
  contas.push(conta.id);
  // Pro · Trimestral: 120 s/h × 7 pontos × 12 h × 30 d = 84 h/mês ÷ 20 s =
  // 15.120 exibições/mês → 45.360 no ciclo. R$ 672,30 ÷ 45.360 = R$ 0,0148.
  PG(`INSERT INTO ciclos_contratados (anunciante_id, plano_id, origem, ciclo_meses, valor_ciclo, exibicoes_previstas_mes, exibicoes_previstas_ciclo)
      VALUES (${conta.id}, 'destaque-3m', 'compra', 3, 672.30, 15120, 45360)`);
  const p = await entrar(conta);
  await p.waitForFunction(() => /R\$/.test(document.querySelector('[data-kpi="custo"] b')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  const card = await p.locator('[data-kpi="custo"]').innerText();
  check('card "Custo por exibição prevista"', /Custo por exibição prevista/i.test(card) && !/1\.000/.test(card), card);
  check('microvalor com 4 casas: R$ 0,0148', /R\$\s?0,0148/.test(card), card);
  check('legenda: valor contratado ÷ exibições previstas no ciclo', /Valor contratado ÷ exibições previstas no ciclo/.test(card), card);
  check(
    'tooltip com a conta do ciclo',
    /Pro · Trimestral: R\$\s?672,30 ÷ 45\.360 exibições previstas no ciclo/.test((await p.locator('[data-kpi="custo"]').getAttribute('title')) || ''),
  );
  check('card Plano: "Pro · Trimestral" + Assinatura paga', /Pro · Trimestral[\s\S]*Assinatura paga/.test(await p.locator('#modPlano').innerText()));
  // Preço do admin mudando depois não mexe no ciclo contratado.
  PG(`UPDATE planos SET valor_mensal = valor_mensal WHERE id = 'destaque-3m'`);
  await recarregarQuieto(p);
  await p.waitForTimeout(1200);
  check('recarregado: mesmo custo', /R\$\s?0,0148/.test(await p.locator('[data-kpi="custo"]').innerText()));
  await p.screenshot({ path: `${SAIDA}custo-previsto-pago.png`, fullPage: true });
  await p.close();
}

console.log('== benefício por créditos: sem R$, e ciclos com nome ==');
{
  const conta = await contaPainel(
    'ciclo',
    ", plano_id = 'maximo-6m', plano_cortesia = true, cortesia_motivo = 'Benefício por créditos', data_inicio_cobertura = current_date, data_expiracao = current_date + 180",
  );
  contas.push(conta.id);
  PG(`INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, status, origem, ativado_em)
      VALUES (${conta.id}, 'maximo-6m', current_date + 180, 'ativo', 'indicacao', now())`);
  PG(`INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, observacao) VALUES (${conta.id}, 'concessao_admin', 60, 'e2e')`);
  const p = await entrar(conta);
  await p.waitForTimeout(800);
  const card = await p.locator('[data-kpi="custo"]').innerText();
  const valorCusto = await p.locator('[data-kpi="custo"] b').innerText();
  check(
    'custo: "Benefício por créditos · Sem valor monetário neste ciclo", nunca R$ 0,00',
    valorCusto.trim() === 'Benefício por créditos' && /Sem valor monetário neste ciclo/.test(card) && !/R\$\s?\d/.test(card),
    card,
  );
  const plano = await p.locator('#modPlano').innerText();
  check('card Plano: "Prime · Semestral" + Benefício por créditos', /Prime · Semestral[\s\S]*Benefício por créditos/.test(plano), plano);
  const creditosTxt = await p.locator('#modCreditos').innerText();
  check('Créditos e benefícios: em vigor "Prime · Semestral"', /Prime · Semestral · Benefício por créditos/.test(creditosTxt), creditosTxt.slice(0, 300));
  const cabecalho = await p.locator('.creditos-tabela thead').innerText();
  check('tabela com colunas Mensal/Trimestral/Semestral/Anual', /Mensal[\s\S]*Trimestral[\s\S]*Semestral[\s\S]*Anual/.test(cabecalho) && !/\bmeses?\b/.test(cabecalho), cabecalho);
  const linhaPrime = await p.locator('.creditos-tabela tbody tr', { hasText: 'Prime' }).innerText();
  check('Prime: 10 / 30 / 60 / 120 créditos', /10 créditos[\s\S]*30 créditos[\s\S]*60 créditos[\s\S]*120 créditos/.test(linhaPrime), linhaPrime);
  await p.screenshot({ path: `${SAIDA}ciclos-beneficio.png`, fullPage: true });
  await p.close();
}

console.log('== confirmação de resgate: "Resgatar Prime · Semestral" · "Usar 60 créditos" ==');
{
  const conta = await contaPainel('resgate');
  contas.push(conta.id);
  PG(`INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, observacao) VALUES (${conta.id}, 'concessao_admin', 60, 'e2e')`);
  const p = await entrar(conta);
  await p.waitForSelector('[data-acao="resgatar"][data-tier="maximo"][data-meses="6"]', { timeout: 8000 });
  await p.click('[data-acao="resgatar"][data-tier="maximo"][data-meses="6"]');
  await p.waitForSelector('#dlgResgate[open]');
  check('título "Resgatar Prime · Semestral"', (await p.textContent('#tituloResgate')).trim() === 'Resgatar Prime · Semestral');
  check('CTA "Usar 60 créditos"', (await p.textContent('#btnConfirmarResgate')).trim() === 'Usar 60 créditos');
  check('duração como explicação: "período: 6 meses"', /60 créditos · período: 6 meses/.test(await p.textContent('#previewResgate')));
  await p.click('#btnConfirmarResgate');
  await p.waitForFunction(() => !document.querySelector('#dlgResgate[open]'), null, { timeout: 8000 });
  await p.waitForTimeout(1200);
  // O histórico mora num <details> recolhido: textContent, não innerText.
  const historico = (await p.locator('#creditosHistorico').textContent()) || '';
  check('histórico: "Resgate · Prime · Semestral -60"', /Resgate · Prime · Semestral\s*-60/.test(historico), historico.slice(0, 300));
  check('card Plano sem F5: "Prime · Semestral"', /Prime · Semestral/.test(await p.locator('#modPlano').innerText()));
  check('custo sem F5: benefício, sem R$', /Benefício por créditos/.test(await p.locator('[data-kpi="custo"]').innerText()));
  await p.waitForTimeout(1500);
  await p.close();
}

check('sem erro de console', erros.length === 0, erros.join(' | '));
await b.close();

// Limpa o que criou (contas com plano entram na playlist e mexem nos testes
// de geração do `npm test` no mesmo banco).
for (const id of contas) {
  PG(`DELETE FROM notificacoes WHERE anunciante_id = ${id};
      DELETE FROM planos_administrativos WHERE anunciante_id = ${id};
      DELETE FROM creditos_ledger WHERE anunciante_id = ${id};
      DELETE FROM ciclos_contratados WHERE anunciante_id = ${id};
      DELETE FROM assinaturas WHERE anunciante_id = ${id};
      DELETE FROM eventos WHERE anunciante_id = ${id};
      DELETE FROM cupons_ponto WHERE conta_id = ${id};
      DELETE FROM pagamentos_ponto WHERE ponto_id IN (SELECT id FROM pontos WHERE anunciante_id = ${id});
      DELETE FROM dispositivos WHERE ponto_id IN (SELECT id FROM pontos WHERE anunciante_id = ${id});
      DELETE FROM pontos WHERE anunciante_id = ${id};
      DELETE FROM anunciantes WHERE id = ${id}`);
}
console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO OK');
process.exit(falhas.length ? 1 : 0);
