// Financeiro na rota real (/anunciante/painel.html), Fatia 4.
// Só Pagamentos (o que a conta paga à Mostraí). "Recebimentos" saiu em
// 24/09/2026 (ADR-016): quem cede a parede ganha créditos, não dinheiro —
// mesmo com repasse antigo no histórico, nada de R$ 50 aparece aqui, e a
// anotação interna do repasse nunca sai do servidor. A página antiga do
// ponto não tem mais extrato. Assume servidor na 3999.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim()
    .split('\n')[0];
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
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
  p.screenshot({ path: new URL(`./saida/financeiro-${n}.png`, import.meta.url).pathname, fullPage: true });

async function novaConta(prefixo) {
  const email = `${prefixo}-${Date.now()}@teste.com`;
  await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: `Conta ${prefixo}`,
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
  PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${id}`);
  return { id, email };
}

async function entrar(conta) {
  await ctx.clearCookies();
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|404)/.test(m.text())) erros.push(`console: ${m.text()}`);
  });
  p.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(B)) respostasRuins.push(`${r.status()} ${r.url()}`);
  });
  await p.goto(`${B}/anunciante/login.html`, { waitUntil: 'networkidle' });
  await p.fill('#email', conta.email);
  await p.fill('#senha', 'Senha123!');
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await p.waitForTimeout(1200);
  return p;
}

console.log('== conta sem plano e sem ponto: sem módulo ==');
let p = await entrar(await novaConta('finvazia'));
check('Financeiro escondido sem assunto', !(await p.isVisible('#modFinanceiro')));
await p.close();

console.log('== só anuncia: só Pagamentos ==');
const anunc = await novaConta('finanunc');
PG(`UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${anunc.id}`);
PG(`INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor) VALUES (${anunc.id}, 'essencial-1m', 149.90)`);
p = await entrar(anunc);
await p.waitForSelector('#modFinanceiro:not([hidden])');
check('Pagamentos visível', await p.isVisible('#finPagamentos'));
check('sem bloco de Recebimentos', !(await p.$('#finRecebimentos')));
check('plano e cobrança', /Essencial[\s\S]*Ativa[\s\S]*149,90/.test(await p.textContent('#finPagamentos')));
check('sem o "Meus pagamentos" antigo', !(await p.$('#painelCobrancas')));
await p.click('#modPlano [data-acao="gerenciar-plano"]');
check('Gerenciar plano abre o diálogo', await p.evaluate(() => document.getElementById('dlgPlano').open));
await p.click('#btnFecharPlano');
await p.close();

console.log('== anuncia e cede a parede, com repasse antigo no histórico: só Pagamentos ==');
const ambos = await novaConta('finambos');
PG(`UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days', papeis = ARRAY['anunciante','ponto'] WHERE id = ${ambos.id}`);
PG(`INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor) VALUES (${ambos.id}, 'essencial-1m', 149.90)`);
const ponto = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, status)
   VALUES ('Bar Financeiro', 'Rua Três, 3', 'Matão', 'SP', '15990000', 'outro', 'R', '16', ${ambos.id}, 'em_operacao') RETURNING id`,
);
PG(`INSERT INTO pagamentos_ponto (ponto_id, competencia, valor, pago_em, forma, observacao) VALUES (${ponto}, date_trunc('month', now() - interval '1 month'), 50, now(), 'pix', 'NOTA INTERNA DO ADMIN')`);
p = await entrar(ambos);
await p.waitForSelector('#modFinanceiro:not([hidden])');
const fin = await p.textContent('#modFinanceiro');
check('só Pagamentos', (await p.isVisible('#finPagamentos')) && !(await p.$('#finRecebimentos')));
check('nada de repasse, R$ 50 ou troca por tela', !/Recebimentos|repasse|ajuda de custo|R\$ 50|Trocar os/i.test(fin), fin.slice(0, 300));
const api = await p.evaluate(async () => (await fetch('/anunciantes/me/financeiro', { credentials: 'include' })).text());
check('anotação interna não sai do servidor', !api.includes('NOTA INTERNA'));
check('API sem recebimentos', !api.includes('recebimentos'));
check('repasse antigo continua no banco (histórico)', PG(`SELECT count(*) FROM pagamentos_ponto WHERE ponto_id = ${ponto}`) === '1');
await shot(p, '1-ambos');
await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(400);
check('celular: sem rolagem horizontal', (await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
await shot(p, '2-celular');

await p.goto(`${B}/anunciante/ponto.html`, { waitUntil: 'networkidle' });
check('página antiga do ponto redireciona pro painel', /painel\.html#modPontos$/.test(p.url()) && !(await p.$('#extratoPonto')), p.url());

check('sem erro de console', erros.length === 0, erros.join(' | '));
check('nenhuma resposta 4xx/5xx inesperada', respostasRuins.length === 0, respostasRuins.join(' | '));
await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
