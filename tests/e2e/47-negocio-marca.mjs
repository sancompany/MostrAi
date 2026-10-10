// Negócio ou marca por criativo (migration 121, estação de 10/10/2026) na
// rota real: o cliente envia uma peça do negócio principal (sem perceber
// nada a mais) e outra de um negócio novo ("Academia Pizza"), a Mostraí pede
// correção, o cliente reenvia, e o Admin altera a categoria e aprova — com o
// histórico na ficha da conta. Sem erro de console, sem diálogo nativo.
//
// Sobe o próprio servidor com STORAGE_CAPTURA (o upload real precisa de
// Storage; como no roteiro 25). Uso:
//   tests/e2e/reset-db.sh && node tests/e2e/47-negocio-marca.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const RAIZ = new URL('../../', import.meta.url).pathname;
const SAIDA = new URL('./saida/47-', import.meta.url).pathname;
fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const falhas = [];
const erros = [];
const check = (t, cond, d = '') => {
  console.log(cond ? '  ok ' : '  FALHA', t, cond ? '' : typeof d === 'string' ? d : JSON.stringify(d));
  if (!cond) falhas.push(t);
};
const esperar = async (fn, ms = 20000) => {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
};

const VIDEO = `${SAIDA}peca.mp4`;
execSync(`ffmpeg -v error -y -f lavfi -i testsrc2=size=360x640:rate=30 -t 5 -c:v libx264 -preset ultrafast ${VIDEO}`);
execSync(`bash ${RAIZ}tests/e2e/restart.sh STORAGE_CAPTURA=${SAIDA}storage`);

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME, args: ['--lang=pt-BR'] }));
const vigiar = (p) => {
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (400|401|404|409)/.test(m.text())) erros.push(`console: ${m.text()}`);
  });
  p.on('dialog', async (d) => {
    erros.push(`diálogo nativo: ${d.message()}`);
    await d.dismiss();
  });
  return p;
};

// ---------------------------------------------------------------------------
console.log('== 1. conta Prime de um restaurante, um negócio só ==');
const marca = Date.now();
const email = `e2e47-${marca}@teste.dev`;
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR' });
const cad = await ctx.request.post(`${B}/anunciantes/cadastro`, {
  data: {
    nome_empresa: `Academia da Boêmia ${marca}`,
    cpf_cnpj: '52998224725',
    cep: '15990-000',
    logradouro: 'Avenida Habib Gabriel',
    numero: '1200',
    bairro: 'Centro',
    cidade: 'Matão',
    uf: 'SP',
    contato_email: email,
    contato_telefone: '(16) 99999-0047',
    senha: 'Senha@Forte1',
    aceitou_termos: true,
  },
});
check('cadastro', cad.status() === 201, String(cad.status()));
const contaId = PG(
  `WITH u AS (UPDATE anunciantes SET email_confirmado = true, plano_id = 'maximo-1m', data_inicio_cobertura = now(),
     data_expiracao = now() + interval '20 days', categoria_id = (SELECT id FROM categorias WHERE nome = 'Restaurante')
   WHERE contato_email = '${email}' RETURNING id) SELECT id FROM u`,
);

const p = vigiar(await ctx.newPage());
await irQuieto(p, `${B}/anunciante/login.html`);
await p.fill('#email', email);
await p.fill('#senha', 'Senha@Forte1');
await p.click('button[type="submit"]');
await p.waitForURL(/painel\.html/, { timeout: 15000 });
await p.waitForSelector('#negocioEnvio:not([hidden]) .negocio-opcao', { timeout: 15000 });
check('"Quem este anúncio divulga?" aparece no envio', (await p.textContent('#negocioEnvio legend')).includes('Quem este anúncio divulga?'));
check('uma opção só — o negócio principal', (await p.locator('.negocio-opcao').count()) === 1);
check('o principal já vem marcado', await p.isChecked('.negocio-opcao input'));
check('com o nome e a categoria da conta', /Academia da Boêmia[\s\S]*Restaurante/.test(await p.textContent('.negocio-opcao')));
check('o negócio novo fica fechado até pedir', await p.isHidden('[data-negocio-novo]'));
await p.screenshot({ path: `${SAIDA}1-um-negocio.png`, fullPage: true });

console.log('== 2. envio do negócio principal: o mesmo gesto de sempre ==');
await p.setInputFiles('#arquivoCriativo', VIDEO);
await esperar(async () => (await p.locator('.criativo-card').count()) === 1 && /enviado/i.test(await p.textContent('#uploadMsg')));
check('peça enviada', (await p.locator('.criativo-card').count()) === 1, await p.textContent('#uploadMsg'));
check('com um negócio só, o card não ganha linha a mais', (await p.locator('.criativo-divulga').count()) === 0);
const principal = PG(`SELECT id FROM negocios WHERE anunciante_id = ${contaId} AND principal`);
check(
  'a peça ficou no negócio principal',
  PG(`SELECT negocio_id FROM criativos WHERE anunciante_id = ${contaId}`) === principal,
);

console.log('== 3. "+ Anunciar outro negócio ou marca" ==');
await p.click('[data-negocio-outro]');
check('abre o formulário pequeno', await p.isVisible('[data-negocio-novo]'));
await p.fill('[data-negocio-nome]', 'Academia Pizza');
// Sem a declaração, o seletor de arquivo nem abre: a tela diz o que falta.
await p.click('#rotuloEnviarCriativo');
await esperar(async () => /categoria|responsável/.test(await p.textContent('#uploadMsg')));
check('sem categoria: diz o que falta', /categoria/i.test(await p.textContent('#uploadMsg')), await p.textContent('#uploadMsg'));
await p.fill('#envio_categoria_id_busca', 'Pizzaria');
await p.click('#envio_categoria_id_busca_lista li:has-text("Pizzaria")');
await p.click('#rotuloEnviarCriativo');
check('sem a declaração: diz o que falta', /mesmo responsável ou grupo/.test(await p.textContent('#uploadMsg')));
await p.check('[data-negocio-grupo]');
await p.setInputFiles('#arquivoCriativo', VIDEO);
await esperar(async () => (await p.locator('.criativo-card').count()) === 2);
check('segunda peça enviada', (await p.locator('.criativo-card').count()) === 2, await p.textContent('#uploadMsg'));
await esperar(async () => (await p.locator('.negocio-opcao').count()) === 2);
check('o negócio novo vira opção da lista', (await p.locator('.negocio-opcao').count()) === 2);
check(
  'e os cards dizem quem cada peça divulga',
  /Divulga: Academia Pizza · Pizzaria/.test(await p.textContent('#listaCriativos')),
  await p.textContent('#listaCriativos'),
);
const pizza = PG(`SELECT id FROM negocios WHERE anunciante_id = ${contaId} AND nome = 'Academia Pizza'`);
const pecaPizza = PG(`SELECT id FROM criativos WHERE negocio_id = ${pizza}`);
check('negócio novo na mesma conta, com a declaração', !!PG(`SELECT mesmo_grupo_declarado_em FROM negocios WHERE id = ${pizza}`));
check('nenhuma assinatura nova', PG(`SELECT count(*) FROM assinaturas WHERE anunciante_id = ${contaId}`) === '0');
await p.screenshot({ path: `${SAIDA}2-dois-negocios.png`, fullPage: true });

console.log('== 4. Admin: a fila mostra conta, negócio e categoria; pede correção ==');
const ctxAdmin = await b.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
const admin = vigiar(await ctxAdmin.newPage());
await irQuieto(admin, `${B}/admin/index.html`);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('.admin-shell');
await admin.evaluate(() => {
  location.hash = 'aprovacao';
});
const cardPizza = admin.locator('.criativo-item', { hasText: 'Academia Pizza' });
await cardPizza.waitFor({ timeout: 15000 });
const textoFila = await cardPizza.innerText();
check('fila: conta', textoFila.includes(`Academia da Boêmia ${marca}`), textoFila);
check('fila: negócio ou marca', /Negócio ou marca\s*Academia Pizza/i.test(textoFila), textoFila);
check('fila: categoria declarada', /Categoria declarada\s*Pizzaria/.test(textoFila), textoFila);
check('fila: categoria nova a conferir', textoFila.includes('a conferir'), textoFila);
await admin.screenshot({ path: `${SAIDA}3-fila.png`, fullPage: true });
await cardPizza.locator('[data-acao="correcao"]').click();
const modalCorrecao = admin.locator('dialog.modal-admin');
await modalCorrecao.waitFor();
check('modal já traz a mensagem padrão', (await admin.inputValue('#motivoCorrecao')).includes('categoria informada não corresponde'));
await modalCorrecao.locator('[data-confirmar]').click();
await esperar(async () => PG(`SELECT status FROM criativos WHERE id = ${pecaPizza}`) === 'correcao');
check('peça em correção', PG(`SELECT status FROM criativos WHERE id = ${pecaPizza}`) === 'correcao');

console.log('== 5. cliente: "Correção necessária" e reenvio ==');
const cardCliente = p.locator(`.criativo-card[data-id="${pecaPizza}"]`);
await esperar(async () => (await cardCliente.innerText()).includes('Correção necessária'));
check('o card mostra "Correção necessária"', (await cardCliente.innerText()).includes('Correção necessária'), await cardCliente.innerText());
check('com a mensagem da Mostraí', (await cardCliente.innerText()).includes('categoria informada'));
await cardCliente.locator('[data-acao="reenviar"]').click();
const dlg = p.locator('dialog.dlg-confirmar');
await dlg.waitFor();
check('o modal pergunta quem a peça divulga', (await dlg.innerText()).includes('Quem este anúncio divulga?'));
check('com o negócio atual marcado', await dlg.locator(`input[type=radio][value="${pizza}"]`).isChecked());
await dlg.locator('[data-confirmar]').click();
await esperar(async () => PG(`SELECT status FROM criativos WHERE id = ${pecaPizza}`) === 'pendente');
check('voltou pra análise', PG(`SELECT status FROM criativos WHERE id = ${pecaPizza}`) === 'pendente');
await esperar(async () => (await cardCliente.innerText()).includes('Em análise'));
check('o card volta a "Em análise"', (await cardCliente.innerText()).includes('Em análise'));

console.log('== 6. Admin: altera a categoria e aprova; aprova a do principal ==');
await admin.evaluate(() => {
  location.hash = 'visaogeral';
});
await admin.waitForTimeout(500);
await admin.evaluate(() => {
  location.hash = 'aprovacao';
});
await cardPizza.waitFor({ timeout: 15000 });
await cardPizza.locator('[data-acao="aprovar-categoria"]').click();
const modalCategoria = admin.locator('dialog.modal-admin');
await modalCategoria.waitFor();
await admin.fill('#aprovarCategoriaBusca', 'Esfiharia');
await admin.locator('#aprovarCategoriaResultados li', { hasText: 'Esfiharia' }).first().dispatchEvent('mousedown');
await admin.fill('#aprovarCategoriaMotivo', 'a peça divulga esfihas');
await modalCategoria.locator('[data-confirmar]').click();
await esperar(async () => PG(`SELECT status FROM criativos WHERE id = ${pecaPizza}`) === 'aprovado');
check('aprovado com a categoria alterada', PG(`SELECT status FROM criativos WHERE id = ${pecaPizza}`) === 'aprovado');
check(
  'a categoria final é a do Admin',
  PG(`SELECT k.nome FROM negocios n JOIN categorias k ON k.id = n.categoria_id WHERE n.id = ${pizza}`) === 'Esfiharia',
);
check(
  'auditoria: declarada, final, operador e motivo',
  PG(
    `SELECT categoria_antes_nome || '>' || categoria_depois_nome || '|' || operador || '|' || motivo FROM negocios_validacoes WHERE negocio_id = ${pizza}`,
  ) === 'Pizzaria>Esfiharia|admin|a peça divulga esfihas',
);
const cardPrincipal = admin.locator('.criativo-item', { hasText: 'Restaurante' });
await cardPrincipal.waitFor({ timeout: 15000 });
await cardPrincipal.locator('[data-acao="aprovado"]').click();
await esperar(async () => PG(`SELECT count(*) FROM criativos WHERE anunciante_id = ${contaId} AND status = 'aprovado'`) === '2');
check('as duas peças aprovadas', PG(`SELECT count(*) FROM criativos WHERE anunciante_id = ${contaId} AND status = 'aprovado'`) === '2');

console.log('== 7. ficha da conta: negócios e histórico ==');
await admin.evaluate((id) => {
  location.hash = `contas/contas/${id}`;
}, contaId);
const negociosFicha = admin.locator('[data-negocios-conta]');
await negociosFicha.waitFor({ timeout: 15000 });
await esperar(async () => (await negociosFicha.innerText()).includes('Academia Pizza'));
const textoFicha = await negociosFicha.innerText();
check('ficha lista os negócios', textoFicha.includes('Academia Pizza') && textoFicha.includes('principal'), textoFicha);
check('com a categoria validada', textoFicha.includes('Esfiharia'), textoFicha);
check('e quem cada peça divulga', /Divulga: Academia Pizza · Esfiharia/.test(await admin.locator('#contaCriativos').innerText()));
const linhaPizza = negociosFicha.locator('.negocio-linha', { hasText: 'Academia Pizza' });
await linhaPizza.locator('details summary').click();
check(
  'histórico do ajuste',
  /Categoria alterada na aprovação[\s\S]*Pizzaria → Esfiharia[\s\S]*a peça divulga esfihas/.test(await linhaPizza.innerText()),
  await linhaPizza.innerText(),
);
await admin.screenshot({ path: `${SAIDA}4-ficha.png`, fullPage: true });

console.log('== 8. o cliente não altera negócio validado ==');
const tentativa = await ctx.request.patch(`${B}/anunciantes/me/negocios/${pizza}`, { data: { nome: 'Outro nome' } });
check('PATCH de negócio validado: 409', tentativa.status() === 409, String(tentativa.status()));

await b.close();
check('sem erro de console nem diálogo nativo', erros.length === 0, erros.join(' | '));
console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
