// Meus pontos na rota real (/anunciante/painel.html), Fatia 2.
// Um estabelecimento = um card, do pedido ao ponto no ar, sem F5 e sem
// duplicar: pedido pelo card compacto → "Em análise"; admin aprova →
// "Aguardando instalação" (o MESMO card, não um segundo); admin liga a tela →
// "Ativo" com a tela dentro; tela sem sinal → texto humano de atenção. Pedir
// o mesmo estabelecimento de novo é recusado. Assume servidor na 3999.
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route('https://viacep.com.br/**', (route) =>
  route.fulfill({
    headers: { 'Access-Control-Allow-Origin': '*' },
    json: { cep: '15990-000', logradouro: '', bairro: '', localidade: 'Matão', uf: 'SP' },
  }),
);
const falhas = [];
const erros = [];
const respostasRuins = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const shot = (p, n) =>
  p.screenshot({ path: new URL(`./saida/meus-pontos-${n}.png`, import.meta.url).pathname, fullPage: true });

const email = `pontos-${Date.now()}@teste.com`;
const senha = 'Senha123!';
const nomeEmpresa = `Padaria Teste ${Date.now() % 100000}`;
await fetch(`${B}/anunciantes/cadastro`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nome_empresa: nomeEmpresa,
    cpf_cnpj: '52998224725',
    contato_email: email,
    contato_telefone: '16999997777',
    senha,
    aceitou_termos: true,
    endereco: 'Rua das Flores, 45',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
  }),
});
const id = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${id}`);

const p = await ctx.newPage();
p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
p.on('console', (m) => {
  if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) erros.push(`console: ${m.text()}`);
});
const chamadasMeusPontos = [];
p.on('request', (r) => {
  if (r.url().includes('/anunciantes/me/meus-pontos')) chamadasMeusPontos.push(Date.now());
});
p.on('response', (r) => {
  if (r.status() >= 400 && r.url().startsWith(B) && r.status() !== 409) respostasRuins.push(`${r.status()} ${r.url()}`);
});
await irQuieto(p, `${B}/anunciante/login.html`);
await p.fill('#email', email);
await p.fill('#senha', senha);
await p.click('button[type="submit"]');
await p.waitForURL(/painel\.html/, { timeout: 10000 });
await p.waitForSelector('#modPontos:not([hidden])', { timeout: 10000 });
await p.waitForTimeout(600);
// Marca a janela: se a página recarregar, a marca some.
await p.evaluate(() => {
  window.__semReload = true;
});

console.log('== sem ponto nenhum: o módulo é o convite ==');
check('Meus pontos aparece mesmo sem plano', await p.isVisible('#modPontos'));
check('convite "Você também possui um comércio?"', (await p.textContent('#pontosLista')).includes('possui um comércio'));
check('sem "Cadastrar outro" enquanto não há nenhum', !(await p.isVisible('#btnNovoPonto')));
const corpo = await p.textContent('body');
check('nada de "Meus endereços"/"Minhas telas"/link pro painel antigo', !/Meus endereços|Minhas telas|painel do meu ponto/i.test(corpo));
await shot(p, '1-convite');

console.log('== pedido pelo card compacto ==');
await p.click('[data-acao="abrir-oportunidade"]');
await p.waitForSelector('#formCardPonto');
await p.fill('#cp_fluxo', '3000');
await p.click('#formCardPonto button[type=submit]');
await p.waitForSelector('.estab-card.estado-em_analise', { timeout: 8000 });
check('card "Em análise" aparece sem recarregar', await p.evaluate(() => window.__semReload === true));
check('um card só', (await p.$$('.estab-card')).length === 1);
check('confirmação visível', (await p.textContent('#msgMeusPontos')).includes('Pedido enviado'));
check('convite some depois do pedido', !(await p.textContent('#pontosLista')).includes('possui um comércio'));
check('agora dá pra cadastrar outro', await p.isVisible('#btnNovoPonto'));
await shot(p, '2-em-analise');

const candId = PG(`SELECT id FROM candidaturas WHERE conta_id = ${id} AND tipo = 'ponto'`);

console.log('== admin aprova: o MESMO card vira "Aguardando instalação" ==');
const admin = await b.newContext();
const api = async (caminho, metodo = 'GET', corpoJson) => {
  const r = await admin.request.fetch(`${B}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    data: corpoJson ? JSON.stringify(corpoJson) : undefined,
  });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
const login = await api('/admin/login', 'POST', {
  usuario: process.env.ADMIN_USER,
  senha: process.env.ADMIN_PASSWORD,
});
check('admin logou', login.status === 200, JSON.stringify(login));
const lib = await api(`/admin/candidaturas/${candId}/liberar`, 'POST');
check('liberar respondeu 200', lib.status === 200, JSON.stringify(lib));
await p.waitForSelector('.estab-card.estado-aguardando_instalacao', { timeout: 8000 }).catch(() => {});
check('card virou "Aguardando instalação" via SSE, sem F5', !!(await p.$('.estab-card.estado-aguardando_instalacao')));
check('continua UM card (pedido e ponto não duplicam)', (await p.$$('.estab-card')).length === 1);
const pontoId = PG(`SELECT id FROM pontos WHERE candidatura_id = ${candId}`);
check('ponto nasceu ligado à candidatura', !!pontoId);
await p.waitForTimeout(500);
check('sino recebeu o aviso de aprovação', /aprovado/i.test(await p.textContent('body')) || PG(`SELECT count(*) FROM notificacoes WHERE anunciante_id = ${id} AND tipo = 'ponto_aprovado'`) === '1');
await shot(p, '3-aguardando');

console.log('== admin cria e liga a tela ==');
// Player V2: sem nome manual — a tela é "Tela 1"; nasce Ativa, e o ponto só
// vira "Ativo" com o primeiro sinal da TV (aqui, o heartbeat do player web).
const tela = await api(`/admin/pontos/${pontoId}/dispositivos`, 'POST', { modo_horario: '24h' });
check('tela criada', tela.status === 201, JSON.stringify(tela));
const { arquivo: cfgPlayer } = (await api(`/admin/dispositivos/${tela.json.id}/preparar-player`, 'POST')).json;
await fetch(`${B}/player/${cfgPlayer.dispositivoId}/heartbeat`, {
  method: 'POST',
  headers: { 'X-Aparelho-Key': cfgPlayer.chaveAparelho },
});
await p.waitForSelector('.estab-card.estado-ativo', { timeout: 8000 }).catch(() => {});
check('card virou "Ativo" sem F5 (primeiro sinal)', !!(await p.$('.estab-card.estado-ativo')));
check('a tela aparece DENTRO do ponto', (await p.textContent('.estab-card .estab-telas')).includes('Tela 1'));
check('tela funcionando', (await p.textContent('.estab-card .tela-linha')).includes('Funcionando'));
check('resumo do cabeçalho', (await p.textContent('#pontosResumo')).includes('1 de 1 tela funcionando'));
await shot(p, '4-ativo');

console.log('== tela sem sinal: texto humano, sem dado técnico ==');
PG(`UPDATE dispositivos SET ultima_vez_online = now() - interval '3 hours' WHERE id = ${tela.json.id}`);
const antes = chamadasMeusPontos.length;
for (let i = 0; i < 3; i++) {
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(300);
}
await p.waitForTimeout(800);
const porResync = chamadasMeusPontos.length - antes;
check('3 resyncs = no máximo 3 chamadas (sem laço, sem duplicar)', porResync <= 3, `${porResync} chamadas`);
check('um card depois dos resyncs', (await p.$$('.estab-card')).length === 1);
check('uma linha de tela depois dos resyncs', (await p.$$('.tela-linha')).length === 1);
const linha = await p.textContent('.tela-linha');
check('sem sinal vira "Precisa de atenção"', linha.includes('Precisa de atenção'), linha);
check('explica que a equipe já vê o alerta', linha.includes('equipe Mostraí'), linha);
const resposta = await p.evaluate(async () => (await fetch('/anunciantes/me/meus-pontos', { credentials: 'include' })).text());
check(
  'resposta não vaza chave, PIN, contato ou erro cru',
  !/aparelho_id|pin_hash|responsavel_contato|observacoes|ultimo_erro|custo_equipamento/.test(resposta),
  resposta.slice(0, 300),
);
await shot(p, '5-atencao');

console.log('== o que rodou na tela + PIN ==');
await p.click('[data-acao="ver-tela"]');
await p.waitForSelector('#modalTela[open] #formPin');
check('diálogo explica a situação', (await p.textContent('#modalTelaCorpo')).includes('equipe Mostraí'));
await p.fill('#pinTela', '4321');
await p.click('#formPin button[type=submit]');
await p.waitForFunction(() => document.getElementById('msgPin').textContent.includes('PIN salvo'));
check('PIN salvo pelo dono', PG(`SELECT (pin_hash IS NOT NULL) FROM dispositivos WHERE id = ${tela.json.id}`) === 't');
await p.click('#fecharModalTela');

console.log('== o mesmo estabelecimento não entra de novo ==');
const dup = await p.evaluate(async (nome) => {
  const r = await fetch('/anunciantes/me/pontos', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_comercio: nome,
      endereco: 'Rua das Flores, 45',
      cidade: 'Matão',
      uf: 'SP',
      cep: '15990000',
      fluxo_estimado_mensal: 100,
      horario_semanal: { seg: { abre: '09:00', fecha: '18:00' } },
    }),
  });
  return { status: r.status, corpo: await r.json() };
}, nomeEmpresa);
check('pedido duplicado recusado com 409', dup.status === 409, JSON.stringify(dup));

console.log('== outro estabelecimento pelo formulário completo ==');
await p.click('#btnNovoPonto');
await p.waitForSelector('#formNovoPonto');
await p.fill('#np_nome_comercio', 'Filial Centro');
await p.fill('#np_cep', '15990-000');
await p.locator('#np_cep').blur();
await p.waitForTimeout(400);
await p.fill('#np_logradouro', 'Avenida Central');
await p.fill('#np_numero', '900');
await p.fill('#np_bairro', 'Centro');
await p.fill('#formNovoPonto .categoria-busca', 'Padaria');
await p.locator('#formNovoPonto .categoria-resultados li[role=option]').first().click();
await p.fill('#np_fluxo', '1200');
await p.click('#formNovoPonto button[type=submit]');
await p.waitForSelector('.estab-card.estado-em_analise', { timeout: 8000 }).catch(() => {});
check('dois cards: o ponto ativo e o pedido novo', (await p.$$('.estab-card')).length === 2);
check('formulário fechou', await p.evaluate(() => document.getElementById('pontosNovo').hidden));
check('ainda sem reload', await p.evaluate(() => window.__semReload === true));
await shot(p, '6-dois');

console.log('== celular ==');
await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(400);
const sobra = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('celular: sem rolagem horizontal', sobra <= 1, `${sobra}px`);
await shot(p, '7-celular');

check('sem erro de console', erros.length === 0, erros.join(' | '));
check('nenhuma resposta 4xx/5xx inesperada', respostasRuins.length === 0, respostasRuins.join(' | '));
await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
