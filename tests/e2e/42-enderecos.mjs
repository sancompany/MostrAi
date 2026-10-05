// Estação de endereços (01/10/2026), no navegador, celular e desktop.
//
// O caso real: "Avenida Francisco Mastropietro, Av Francisco Mastrop" — a
// pessoa foi do CEP pro Logradouro, a resposta da ViaCEP chegou, o foco
// pulou pro Número no meio da digitação e o `maxlength="20"` cortou a rua em
// "Av Francisco Mastrop". Aqui:
//   A. cadastro (celular): o foco fica onde a pessoa está; ViaCEP com
//      sucesso, sem resultado e fora do ar (sempre dá pra preencher à mão);
//      Número com dica, limite 30 e o aviso de "parece endereço" que segura
//      o envio uma vez só.
//   B. painel: cadastro antigo com Número suspeito → "1 pendência precisa da
//      sua atenção." + aviso no sino → "Corrigir endereço" abre o perfil no
//      Número → corrige → a pendência some.
//   C. Meus pontos: "Editar endereço" do pedido e do ponto, com o mapa; ponto
//      instalado mudando de endereço → pendência do Admin, que confere.
//   D. Admin: edita o endereço da conta e o do ponto (histórico) — o da conta
//      nunca mexe no do ponto.
//
// Assume banco zerado (tests/e2e/reset-db.sh) e servidor na 3999.
import { chromium } from 'playwright';
import { acompanharRede, irQuieto, recarregarQuieto, redeQuieta } from './espera.mjs';
import { codigoPara } from './emails.mjs';
import { execSync } from 'node:child_process';

const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .split('\n')[0]
    .trim();
const sufixo = () => Math.random().toString(36).slice(2, 8);
function cpfValido() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (new Set(base).size === 1) base[0] = (base[0] + 1) % 10;
  const digito = (nums) => {
    const soma = nums.reduce((s, n, i) => s + n * (nums.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = digito(base);
  return [...base, d1, digito([...base, d1])].join('');
}

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const falhas = [];
const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const shot = (p, n) =>
  p.screenshot({ path: new URL(`./saida/v42-${n}.png`, import.meta.url).pathname, fullPage: false });

// ViaCEP falsa, com o modo trocável no meio do roteiro.
let modoViaCep = 'sucesso';
async function prepararContexto(ctx) {
  await ctx.route('https://viacep.com.br/**', async (route) => {
    if (modoViaCep === 'fora') return route.abort('failed');
    // Demora de rede de verdade: é nela que a pessoa já foi pro campo seguinte.
    await new Promise((r) => setTimeout(r, 250));
    const json =
      modoViaCep === 'nao-encontrado'
        ? { erro: true }
        : { cep: '15990-000', logradouro: 'Avenida Francisco Mastropietro', bairro: 'Vila Cardim', localidade: 'Matão', uf: 'SP' };
    return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json });
  });
  // O mapa é do Google: o roteiro não depende de rede externa.
  await ctx.route('https://www.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body>mapa</body></html>' }),
  );
}
async function pagina(ctx, url) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`${url}: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|404|409)|ERR_FAILED|viacep/.test(m.text()))
      erros.push(`${url} console: ${m.text()}`);
  });
  await irQuieto(p, B + url);
  return p;
}

// ================= A. Cadastro no celular =================
console.log('== A. cadastro no celular: foco, ViaCEP e Número ==');
const celular = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await prepararContexto(celular);
const cad = await pagina(celular, '/anunciante/cadastro.html');

const limites = await cad.evaluate(() => {
  const f = document.getElementById('formCadastro');
  return Object.fromEntries(['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf'].map((n) => [n, f[n].maxLength]));
});
check(
  'limites da regra única no formulário (CEP 9, logradouro 255, Número 30, complemento 255, bairro/cidade 150, UF 2)',
  JSON.stringify(limites) === JSON.stringify({ cep: 9, logradouro: 255, numero: 30, complemento: 255, bairro: 150, cidade: 150, uf: 2 }),
  JSON.stringify(limites),
);
check('Número com placeholder de exemplos', (await cad.getAttribute('#numero', 'placeholder')) === 'Ex.: 123, 12A, T10 ou S/N');
check(
  'Número com a dica embaixo',
  (await cad.textContent('[data-numero-dica]')).trim() === 'Informe somente o número ou identificador do imóvel.',
);

// O caso real, refeito: CEP → Tab pro Logradouro → a resposta chega → a
// pessoa digita a rua sem olhar.
await cad.click('#cep');
await cad.keyboard.type('15990000');
await cad.keyboard.press('Tab');
await cad.waitForFunction(() => document.querySelector('[data-cep-msg]').dataset.estado === 'encontrado');
const focoDepois = await cad.evaluate(() => document.activeElement?.id);
await cad.keyboard.type('Av Francisco Mastropietro', { delay: 10 });
check('a resposta do CEP não tira o foco de quem já está no Logradouro', focoDepois === 'logradouro', focoDepois);
check('o que foi digitado fica no Logradouro, não no Número', (await cad.inputValue('#numero')) === '', await cad.inputValue('#numero'));
check('a rua digitada substitui a da ViaCEP (sem colar no fim)', (await cad.inputValue('#logradouro')) === 'Av Francisco Mastropietro');
check('bairro/cidade/UF vieram do CEP', (await cad.inputValue('#bairro')) === 'Vila Cardim' && (await cad.inputValue('#uf')) === 'SP');

// Sem resultado e fora do ar: aviso certo e o preenchimento à mão segue.
modoViaCep = 'nao-encontrado';
await cad.fill('#cep', '');
await cad.fill('#cep', '15990001');
await cad.locator('#cep').blur();
await cad.waitForFunction(() => document.querySelector('[data-cep-msg]').dataset.estado === 'nao-encontrado');
check('CEP sem resultado: pede pra preencher à mão', /na mão/.test(await cad.textContent('[data-cep-msg]')));
modoViaCep = 'fora';
await cad.fill('#cep', '');
await cad.fill('#cep', '15990002');
await cad.locator('#cep').blur();
await cad.waitForFunction(() => document.querySelector('[data-cep-msg]').dataset.estado === 'erro');
check('ViaCEP fora do ar: não trava, pede à mão', /à mão/.test(await cad.textContent('[data-cep-msg]')));

// Preenchimento à mão, completo.
const email = `e2e42-${sufixo()}@example.com`;
await cad.fill('#nome_empresa', `Barbearia ${sufixo()}`);
await cad.fill('#cpf_cnpj', cpfValido());
await cad.fill('#categoria_id_busca', 'Padaria');
await cad.locator('#formCadastro .categoria-resultados li[role=option]').first().click();
await cad.fill('#logradouro', 'Avenida Francisco Mastropietro');
await cad.fill('#complemento', 'Barbearia');
await cad.fill('#bairro', 'Vila Cardim');
await cad.fill('#cidade', 'Matão');
await cad.fill('#uf', 'SP');
await cad.fill('#contato_email', email);
await cad.fill('#contato_telefone', '16999990000');
await cad.fill('#senha', 'Senha@forte1');
await cad.fill('#senha_confirma', 'Senha@forte1');
await cad.check('#aceitou_termos');

// Número que parece endereço: aviso, sem enviar.
await cad.fill('#numero', 'Av Francisco Mastrop');
let enviou = false;
cad.on('request', (r) => {
  if (r.url().endsWith('/anunciantes/cadastro')) enviou = true;
});
await cad.click('#formCadastro [type=submit]');
await cad.waitForTimeout(300);
const aviso = await cad.textContent('[data-numero-dica]');
check('Número suspeito: aviso "Confira este campo..." aparece', /^Confira este campo\. Ele parece conter um endereço completo\./.test(aviso), aviso);
check('Número suspeito: o primeiro envio para no aviso', !enviou);
check('o aviso é do Número (foco nele)', (await cad.evaluate(() => document.activeElement?.id)) === 'numero');
await shot(cad, 'cadastro-aviso-numero');
// Corrige pro número de verdade e envia.
await cad.fill('#numero', '120');
await cad.locator('#numero').blur();
check('número certo: a dica volta ao normal', !(await cad.getAttribute('[data-numero-dica]', 'class')).includes('aviso-numero'));
await Promise.all([cad.waitForURL(/painel|confirmar-plano/, { timeout: 15000 }), cad.click('#formCadastro [type=submit]')]);
const contaId = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
check('conta criada com o endereço inteiro', PG(`SELECT logradouro || ' | ' || numero FROM anunciantes WHERE id = ${contaId}`) === 'Avenida Francisco Mastropietro | 120');
check('CEP gravado como 00000-000', PG(`SELECT cep FROM anunciantes WHERE id = ${contaId}`) === '15990-002');
const codigo = await codigoPara(email);
await cad.evaluate(
  async (c) =>
    fetch('/anunciantes/me/confirmar-email', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo: c }),
    }),
  codigo,
);

// ================= B. Pendência no painel =================
console.log('== B. painel: pendência do Número suspeito e a correção ==');
// O cadastro antigo, gravado antes da regra: o número cortado.
PG(`UPDATE anunciantes SET numero = 'Av Francisco Mastrop', endereco = 'Avenida Francisco Mastropietro, Av Francisco Mastrop' WHERE id = ${contaId}`);
const painel = await pagina(celular, '/anunciante/painel.html');
await painel.waitForSelector('#alertasConta .alertas-conta-cabeca', { timeout: 10000 });
check('topo: "1 pendência precisa da sua atenção."', (await painel.textContent('#alertasConta .alertas-conta-cabeca')).trim() === '1 pendência precisa da sua atenção.');
const alerta = await painel.textContent('#alertasConta');
check('alerta "Confira o endereço da sua empresa" com a mensagem', /Confira o endereço da sua empresa/.test(alerta) && /número do imóvel parece estar incorreto/.test(alerta));
await shot(painel, 'painel-pendencia');
await recarregarQuieto(painel);
await painel.waitForSelector('#alertasConta .alertas-conta-cabeca');
check('recarregar não cria outro aviso no sino', PG(`SELECT count(*) FROM notificacoes WHERE anunciante_id = ${contaId} AND tipo = 'pendencia'`) === '1');
check('nenhuma pendência duplicada', PG(`SELECT count(*) FROM pendencias WHERE anunciante_id = ${contaId} AND resolvido_em IS NULL`) === '1');
await painel.click('#alertasConta [data-alerta-cta]');
await painel.waitForSelector('#dlgPerfil[open]');
check('"Corrigir endereço" abre o perfil já no Número', (await painel.evaluate(() => document.activeElement?.id)) === 'numero');
check('o Número está liberado pra edição', !(await painel.isDisabled('#dlgPerfil #numero')));
await painel.fill('#dlgPerfil #numero', '120');
await painel.click('#btnSalvarPerfil');
await painel.waitForFunction(() => document.getElementById('msgPerfil').textContent.includes('atualizados'));
await painel.waitForFunction(() => document.getElementById('alertasConta').hidden || !document.querySelector('.alertas-conta-cabeca'), null, { timeout: 8000 });
check('corrigido: a pendência some do painel', true);
check('resolvida (não apagada) no banco', PG(`SELECT resolucao FROM pendencias WHERE anunciante_id = ${contaId}`) === 'corrigido');
await painel.keyboard.press('Escape');

// ================= C. Meus pontos =================
console.log('== C. Meus pontos: editar endereço do pedido e do ponto, com mapa ==');
const desktop = await b.newContext({ viewport: { width: 1280, height: 900 } });
await prepararContexto(desktop);
// A sessão da conta vale no desktop também (mesmo cookie).
await desktop.addCookies(await celular.cookies());
const candId = PG(
  `INSERT INTO candidaturas (tipo, nome, nome_comercio, contato_telefone, conta_id, logradouro, numero, endereco, bairro, cidade, uf, cep, segmento, fluxo_estimado_mensal, origem)
   VALUES ('ponto', 'Dono', 'Barbearia do Zé', '16999990000', ${contaId}, 'Rua Antiga', '1', 'Rua Antiga, 1', 'Centro', 'Matão', 'SP', '15990-000', 'Barbearia', 800, 'painel')
   RETURNING id`,
);
const mp = await pagina(desktop, '/anunciante/painel.html#modPontos');
const cardPedido = mp.locator(`[data-estab="candidatura-${candId}"]`);
await cardPedido.waitFor({ timeout: 10000 });
await cardPedido.locator('[data-acao="editar-endereco"]').click();
await mp.waitForSelector('dialog.dlg-endereco[open]');
check('o diálogo traz o endereço do pedido', (await mp.inputValue('#ee_logradouro')) === 'Rua Antiga');
await mp.waitForSelector('dialog.dlg-endereco [data-mapa] iframe', { timeout: 5000 });
check('mapa aparece já com o endereço gravado', (await mp.getAttribute('dialog.dlg-endereco iframe', 'src')).includes('Rua%20Antiga%2C%201%2C'));
await mp.fill('#ee_numero', '12A');
// O mapa se refaz quando o endereço muda (com uma pausa curta na digitação).
const mapaRefeito = await mp
  .waitForFunction(() => document.querySelector('dialog.dlg-endereco iframe')?.src.includes('Rua%20Antiga%2C%2012A'), null, { timeout: 5000 })
  .then(() => true)
  .catch(() => false);
check('mapa se refaz com o endereço novo', mapaRefeito);
check('texto do mapa', /Confira a localização do ponto/.test(await mp.textContent('dialog.dlg-endereco [data-mapa]')));
await shot(mp, 'meus-pontos-editar-endereco');
await mp.click('dialog.dlg-endereco [type=submit]');
await mp.waitForSelector('dialog.dlg-endereco', { state: 'detached' });
check('pedido salvo', PG(`SELECT numero FROM candidaturas WHERE id = ${candId}`) === '12A');

// Admin aprova; o ponto nasce; a tela é instalada (status em operação).
const adminCtx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await prepararContexto(adminCtx);
const adm = await pagina(adminCtx, '/admin/');
await adm.fill('#usuario', 'admin');
await adm.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await adm.click('#formLogin button[type=submit]');
await adm.waitForSelector('#app:not([hidden])');
const liberou = await adm.evaluate(async (id) => (await fetch(`/admin/candidaturas/${id}/liberar`, { method: 'POST', credentials: 'include' })).ok, candId);
check('admin aprovou o pedido', liberou);
const pontoId = PG(`SELECT id FROM pontos WHERE candidatura_id = ${candId}`);
PG(`UPDATE pontos SET status = 'em_operacao' WHERE id = ${pontoId}`);
// A aprovação dispara o SSE da conta e o painel recarrega os módulos: a
// página assenta antes do F5 (senão a busca em voo é cortada e vira "Failed
// to fetch" no console — corrida do roteiro, não da página).
await redeQuieta(mp);
await recarregarQuieto(mp);
const cardPonto = mp.locator(`[data-estab="ponto-${pontoId}"]`);
await cardPonto.waitFor({ timeout: 10000 });
await cardPonto.locator('[data-acao="editar-endereco"]').click();
await mp.waitForSelector('dialog.dlg-endereco[open]');
check('ponto instalado: o diálogo avisa da conferência', /já tem tela instalada/.test(await mp.textContent('dialog.dlg-endereco')));
await mp.fill('#ee_logradouro', 'Avenida Nova');
await mp.fill('#ee_numero', '300');
await mp.click('dialog.dlg-endereco [type=submit]');
await mp.waitForSelector('dialog.dlg-endereco', { state: 'detached' });
check('ponto com o endereço novo', PG(`SELECT endereco FROM pontos WHERE id = ${pontoId}`) === 'Avenida Nova, 300');
check('a tela continua (status do ponto não muda)', PG(`SELECT status FROM pontos WHERE id = ${pontoId}`) === 'em_operacao');
check('histórico do ponto gravado (dono)', PG(`SELECT origem FROM pontos_enderecos_historico WHERE ponto_id = ${pontoId}`) === 'usuario');
check(
  'pendência ENDERECO_PONTO_ALTERADO aberta pro Admin',
  PG(`SELECT count(*) FROM pendencias WHERE ponto_id = ${pontoId} AND tipo = 'ENDERECO_PONTO_ALTERADO' AND resolvido_em IS NULL`) === '1',
);
check('o endereço da conta não mudou', PG(`SELECT numero FROM anunciantes WHERE id = ${contaId}`) === '120');

// ================= D. Admin =================
console.log('== D. Admin: Visão geral, ponto (mapa, histórico, conferir) e conta ==');
await recarregarQuieto(adm);
await adm.waitForSelector('#app:not([hidden])');
await adm.waitForFunction(() => /mudou de endereço depois da instalação/.test(document.body.textContent), null, { timeout: 10000 });
check('Visão geral: alerta do ponto que mudou de endereço', true);
await adm.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, pontoId);
await adm.waitForSelector('#pontoEndereco [data-aviso-endereco]', { timeout: 10000 });
check('ficha do ponto: endereço completo', /Avenida Nova, 300/.test(await adm.textContent('#pontoEndereco')));
check('ficha do ponto: mapa da localização atual', !!(await adm.$('#pontoEndereco iframe')));
await adm.click('#pontoEndereco [data-historico] summary');
await adm.waitForSelector('#pontoEndereco [data-historico-lista] table');
check('histórico com a troca do dono', /Dono/.test(await adm.textContent('#pontoEndereco [data-historico-lista]')));
await shot(adm, 'admin-ponto-endereco');
await adm.click('#pontoEndereco [data-conferir]');
await adm.waitForSelector('#pontoEndereco [data-aviso-endereco]', { state: 'detached', timeout: 8000 });
check('"Marcar como conferido" resolve', PG(`SELECT resolucao FROM pendencias WHERE ponto_id = ${pontoId} AND tipo = 'ENDERECO_PONTO_ALTERADO'`) === 'conferido');

// Admin muda o endereço do ponto (histórico com "Admin").
await adm.click('#pontoEndereco [data-editar-endereco-ponto]');
await adm.waitForSelector('dialog.modal-admin[open] #adm_numero');
await adm.fill('#adm_numero', 'S/N');
await adm.click('dialog.modal-admin[open] [type=submit]');
await adm.waitForSelector('dialog.modal-admin[open]', { state: 'detached' });
check('admin salvou o endereço do ponto', PG(`SELECT numero FROM pontos WHERE id = ${pontoId}`) === 'S/N');
check('histórico com a troca do Admin', PG(`SELECT count(*) FROM pontos_enderecos_historico WHERE ponto_id = ${pontoId} AND origem = 'admin'`) === '1');

// Admin muda o endereço cadastral da conta: o do ponto fica.
await adm.evaluate((id) => {
  location.hash = `contas/contas/${id}`;
}, contaId);
await adm.waitForSelector('[data-editar-endereco-conta]', { timeout: 10000 });
await adm.click('[data-editar-endereco-conta]');
await adm.waitForSelector('dialog.modal-admin[open] #adm_numero');
await adm.fill('#adm_numero', 'T10');
await adm.click('dialog.modal-admin[open] [type=submit]');
await adm.waitForSelector('dialog.modal-admin[open]', { state: 'detached' });
check('admin salvou o endereço da conta', PG(`SELECT numero FROM anunciantes WHERE id = ${contaId}`) === 'T10');
check('o ponto não mudou junto', PG(`SELECT numero FROM pontos WHERE id = ${pontoId}`) === 'S/N');

check('nenhum erro de console/JS', erros.length === 0, erros.join('\n'));
await b.close();
console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO OK');
process.exit(falhas.length ? 1 : 0);
