// Painel único na rota real (/anunciante/painel.html), Fatia 5.
// Quatro contas: só anuncia, só cede a parede (sem modo anúncios), as duas
// coisas, e nenhuma. Em todas: os módulos novos aparecem conforme o papel, os
// conceitos antigos não aparecem, o resumo e os alertas vêm do que cada módulo
// sabe, a grade é de verdade (coluna lateral ao lado da campanha no desktop),
// cada endpoint é chamado uma vez na carga e o resync não duplica nada.
// Assume servidor na 3999.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim()
    .split('\n')[0];
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const falhas = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));

const ANTIGOS = /Meu cupom de indicação|indicados pagantes|3 indicados|Meu anúncio na minha tela|Meus endereços|Minhas telas|Meus recebimentos|Meus pagamentos|painel do meu ponto/i;

async function novaConta(prefixo, papeis = "ARRAY['anunciante']") {
  const email = `${prefixo}-${Date.now()}@teste.com`;
  await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: `Conta ${prefixo}`,
      cpf_cnpj: '52998224725',
      contato_email: email,
      contato_telefone: '16999994444',
      senha: 'Senha123!',
      aceitou_termos: true,
      endereco: 'Rua Cinco, 5',
      cidade: 'Matão',
      uf: 'SP',
      cep: '15990000',
    }),
  });
  const id = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
  PG(`UPDATE anunciantes SET email_confirmado = true, papeis = ${papeis} WHERE id = ${id}`);
  return { id, email };
}

const comPlano = (id) =>
  PG(`UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${id}`);
const comPonto = (id, nome, telaSemSinal) => {
  const ponto = PG(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, status, plano_ponto_id, valor_pago_mensal)
     VALUES ('${nome}', 'Rua Cinco, 5', 'Matão', 'SP', '15990000', 'outro', 'R', '16', ${id}, 'em_operacao', 'ajuda-custo', 50) RETURNING id`,
  );
  PG(
    `INSERT INTO dispositivos (ponto_id, apelido, status, modo_horario, ultima_vez_online)
     VALUES (${ponto}, 'Tela 1', 'ativo', '24h', now() - interval '${telaSemSinal ? '5 hours' : '1 minute'}')`,
  );
  PG(`UPDATE anunciantes SET comodato_plano_id = 'inicial-1m' WHERE id = ${id}`);
};

async function abrir(conta, nome, largura = 1280) {
  const ctx = await b.newContext({ viewport: { width: largura, height: 900 } });
  const p = await ctx.newPage();
  const erros = [];
  const ruins = [];
  const chamadas = {};
  p.on('pageerror', (e) => erros.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|404)/.test(m.text())) erros.push(m.text());
  });
  p.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(B)) ruins.push(`${r.status()} ${r.url()}`);
  });
  p.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin === B && r.resourceType() === 'fetch') chamadas[u.pathname] = (chamadas[u.pathname] || 0) + 1;
  });
  await p.goto(`${B}/anunciante/login.html`, { waitUntil: 'networkidle' });
  await p.fill('#email', conta.email);
  await p.fill('#senha', 'Senha123!');
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await p.waitForLoadState('networkidle');
  await p.waitForTimeout(800);
  await p.screenshot({ path: new URL(`./saida/painel-unico-${nome}.png`, import.meta.url).pathname, fullPage: true });
  // Foto das chamadas da CARGA, antes de qualquer resync do teste.
  return { p, ctx, erros, ruins, chamadas, naCarga: { ...chamadas } };
}

const visivel = (p, sel) => p.isVisible(sel);
const box = (p, sel) => p.$eval(sel, (el) => el.getBoundingClientRect().toJSON());

async function comum(nome, s) {
  const texto = await s.p.textContent('main');
  check(`${nome}: nenhum conceito antigo`, !ANTIGOS.test(texto), texto.match(ANTIGOS)?.[0]);
  check(`${nome}: sem link pro painel separado do ponto`, !(await s.p.$('main a[href*="ponto.html"]')));
  const repetidas = Object.entries(s.naCarga).filter(([u, n]) => n > 1 && !u.includes('/eventos'));
  check(`${nome}: cada endpoint uma vez na carga`, repetidas.length === 0, JSON.stringify(repetidas));
  check(`${nome}: console limpo`, s.erros.length === 0, s.erros.join(' | '));
  check(`${nome}: sem 4xx/5xx`, s.ruins.length === 0, s.ruins.join(' | '));
}

console.log('== as duas coisas: anuncia e cede a parede ==');
const ambos = await novaConta('unico-ambos', "ARRAY['anunciante','ponto']");
comPlano(ambos.id);
comPonto(ambos.id, 'Padaria Grade', true);
PG(`INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, observacao) VALUES (${ambos.id}, 'concessao_admin', 5, 'e2e')`);
let s = await abrir(ambos, 'ambos');
for (const m of ['#modPlano', '#modPontos', '#modCriativos', '#modFinanceiro', '#modCreditos', '#dashboardAnuncios'])
  check(`ambos: ${m} visível`, await visivel(s.p, m));
check('ambos: Pagamentos e Recebimentos', (await visivel(s.p, '#finPagamentos')) && (await visivel(s.p, '#finRecebimentos')));
const chips = await s.p.textContent('#resumoConta');
check('ambos: resumo com plano, pontos, criativos e créditos', /Plano[\s\S]*Essencial[\s\S]*Pontos[\s\S]*1 de 1[\s\S]*Criativos[\s\S]*Créditos[\s\S]*5/.test(chips), chips);
const alertas = await s.p.textContent('#alertasConta');
check('ambos: alerta da tela sem comunicação', /Tela 1 \(Padaria Grade\)[\s\S]*sem comunicação/.test(alertas), alertas);
check('ambos: alerta de criativo faltando', /Falta o seu criativo/.test(alertas));
check('ambos: aviso "Falta o seu vídeo" não repete dentro da campanha', !(await s.p.textContent('#dashboardAnuncios')).includes('Falta o seu vídeo'));
const campanha = await box(s.p, '#dashboardAnuncios');
const lateral = await box(s.p, '.area-lateral');
check('ambos: grade de verdade — coluna lateral à direita da campanha', lateral.left >= campanha.right - 1 && Math.abs(lateral.top - campanha.top) < 40, JSON.stringify({ campanha, lateral }));
const creditos = await box(s.p, '#modCreditos');
check('ambos: créditos na largura toda, embaixo', creditos.width > campanha.width && creditos.top > lateral.top);
for (let i = 0; i < 3; i++) {
  await s.p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await s.p.waitForTimeout(350);
}
await s.p.waitForTimeout(800);
const porResync = Object.entries(s.chamadas).filter(([u, n]) => !u.includes('/eventos') && n - (s.naCarga[u] || 0) > 3);
check('ambos: 3 resyncs = no máximo 1 chamada por endpoint cada', porResync.length === 0, JSON.stringify(porResync));
check('ambos: resync não duplica chips', (await s.p.$$('#resumoConta .resumo-chip')).length === 4);
check('ambos: resync não duplica alertas', (await s.p.$$('#alertasConta li')).length === 2);
check('ambos: resync não duplica cards de ponto', (await s.p.$$('.estab-card')).length === 1);
await comum('ambos', s);
await s.ctx.close();

console.log('== só anuncia ==');
const anunc = await novaConta('unico-anunc');
comPlano(anunc.id);
s = await abrir(anunc, 'anunciante');
check('anunciante: Meus pontos é o convite', (await s.p.textContent('#pontosLista')).includes('possui um comércio'));
check('anunciante: só Pagamentos', (await visivel(s.p, '#finPagamentos')) && !(await visivel(s.p, '#finRecebimentos')));
check('anunciante: sem chip de pontos', !(await s.p.textContent('#resumoConta')).includes('Pontos'));
await comum('anunciante', s);
await s.ctx.close();

console.log('== só cede a parede (sem modo anúncios) ==');
const dono = await novaConta('unico-dono', "ARRAY['ponto']");
comPonto(dono.id, 'Mercearia Grade', false);
s = await abrir(dono, 'dono');
check('dono: Meus pontos com o ponto', (await s.p.textContent('#pontosLista')).includes('Mercearia Grade'));
check('dono: Meus criativos pelo comodato', await visivel(s.p, '#modCriativos'));
check('dono: Recebimentos visível', await visivel(s.p, '#finRecebimentos'));
check('dono: Plano comercial diz que não tem, e explica o comodato', /Nenhum plano comercial[\s\S]*comodato/.test(await s.p.textContent('#modPlano')));
check('dono: hero com saudação (não mais "modo não ativado")', (await s.p.textContent('#statusBanner')).includes('Olá'));
await comum('dono', s);
await s.ctx.close();

console.log('== nenhuma das duas, celular ==');
const nada = await novaConta('unico-nada');
s = await abrir(nada, 'nada-celular', 390);
check('nada: cartão de escolher plano', await visivel(s.p, '#bloqueioPlano'));
check('nada: sem Financeiro e sem Criativos', !(await visivel(s.p, '#modFinanceiro')) && !(await visivel(s.p, '#modCriativos')));
check('nada: créditos e convite de ponto aparecem', (await visivel(s.p, '#modCreditos')) && (await visivel(s.p, '#modPontos')));
check('nada: celular sem rolagem horizontal', (await s.p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
await comum('nada', s);
await s.ctx.close();

await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
