// Meus criativos na rota real (/anunciante/painel.html), Fatia 3.
// Anúncio na rede e na tela do próprio comércio numa biblioteca só, com a
// situação que o cliente
// entende (Em análise / Aprovado / Programado / No ar / Fora do ar / Recusado), e a troca
// sem sair do ar: a substituta aprovada tira a atual, sem F5. A página antiga
// do ponto não tem mais "Meu anúncio na minha tela". Assume servidor na 3999.
// Os arquivos são semeados no banco (o upload real precisa do Storage).
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
  p.screenshot({ path: new URL(`./saida/meus-criativos-${n}.png`, import.meta.url).pathname, fullPage: true });

async function novaConta(prefixo) {
  const email = `${prefixo}-${Date.now()}@teste.com`;
  await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: `Loja ${prefixo}`,
      cpf_cnpj: '52998224725',
      contato_email: email,
      contato_telefone: '16999996666',
      senha: 'Senha123!',
      aceitou_termos: true,
      endereco: 'Rua Um, 1',
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
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (400|401|404|409|502)/.test(m.text())) erros.push(`console: ${m.text()}`);
  });
  p.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(B) && ![400, 409, 502].includes(r.status()))
      respostasRuins.push(`${r.status()} ${r.url()}`);
  });
  await ctx.clearCookies();
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', conta.email);
  await p.fill('#senha', 'Senha123!');
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await p.waitForTimeout(1200);
  return p;
}

const IMG = '/img/favicon-192.png';
// `-tA` com RETURNING devolve o id e a etiqueta "INSERT 0 1": fica a 1ª linha.
const criativo = (conta, status, extra = '') =>
  PG(`INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, duracao_segundos, status${extra ? `, ${extra.split('=')[0]}` : ''})
      VALUES (${conta}, 'x.png', '${IMG}', 10, '${status}'${extra ? `, ${extra.split('=')[1]}` : ''}) RETURNING id`).split('\n')[0];

console.log('== sem plano nenhum: o módulo não aparece ==');
const vazia = await novaConta('semplano');
let p = await entrar(vazia);
check('sem plano, Meus criativos fica escondido', !(await p.isVisible('#modCriativos')));
await p.close();

console.log('== conta com plano comercial e ponto no ar ==');
const conta = await novaConta('criativos');
// Com categoria: a substituta, vinda da fila, só se aprova com ela (migration 121).
PG(
  `UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days',
          categoria_id = (SELECT id FROM categorias WHERE nome = 'Academia') WHERE id = ${conta.id}`,
);
PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, status)
   VALUES ('Loja criativos', 'Rua Um, 1', 'Matão', 'SP', '15990000', 'outro', 'R', '16', ${conta.id}, 'em_operacao')`,
);
const reserva = criativo(conta.id, 'aprovado');
PG(`UPDATE criativos SET created_at = now() - interval '2 days' WHERE id = ${reserva}`);
const noAr = criativo(conta.id, 'aprovado');
// "No ar" é exibição confirmada pela TV (27/09/2026), não aprovação: o
// comprovante é o que confirmarExecucao grava.
PG(`UPDATE criativos SET primeira_exibicao_em = now(), ultima_exibicao_em = now() WHERE id = ${noAr}`);
const substituta = criativo(conta.id, 'pendente', `substitui_criativo_id=${noAr}`);
const recusada = criativo(conta.id, 'reprovado', `motivo_reprovacao='texto ilegível'`);
criativo(conta.id, 'retirado');

p = await entrar(conta);
await p.waitForSelector('#modCriativos:not([hidden]) .criativo-card');
await p.evaluate(() => {
  window.__semReload = true;
});
const card = async (id) => (await p.textContent(`.criativo-card[data-id="${id}"]`)) || '';
check('No ar: a peça mais recente dentro do limite do plano', (await card(noAr)).includes('No ar'));
check('No ar explica a substituta em análise', (await card(noAr)).includes('substituta está em análise'));
check('sem "Substituir" em quem já tem substituta', !(await p.$(`.criativo-card[data-id="${noAr}"] [data-acao="substituir"]`)));
check('Em análise: a substituta diz que a atual segue no ar', (await card(substituta)).includes('continua rodando'));
check('Aprovado fora do rodízio explica o limite do plano', /Aprovado[\s\S]*roda 1 peça/.test(await card(reserva)));
check('Recusado mostra o motivo', (await card(recusada)).includes('texto ilegível'));
check('Fora do ar aparece como tal', (await p.textContent('#listaCriativos')).includes('Fora do ar'));
check('onde roda: rede e tela do comércio', /pontos do seu plano e na tela do seu comércio/.test(await p.textContent('#criativosSubtitulo')));
check('duração do plano no subtítulo', (await p.textContent('#criativosSubtitulo')).includes('15 segundos'));
// Mesma conta de criativosRepo.contarNaoReprovados: retirado (fora do ar)
// não ocupa vaga desde o #88 (finalização, 28/09/2026).
check('contador de cadastro', (await p.textContent('#contadorCriativos')).trim() === `${PG(`SELECT count(*) FROM criativos WHERE anunciante_id=${conta.id} AND status NOT IN ('reprovado', 'retirado') AND NOT (status='pendente' AND substitui_criativo_id IS NOT NULL)`)} de 1`);
check('uma biblioteca só (sem "Meu anúncio na minha tela")', !/Meu anúncio na minha tela/.test(await p.textContent('body')));
await shot(p, '1-situacoes');

console.log('== substituir envia a peça apontando pra atual ==');
// O Chromium não entrega o corpo multipart com arquivo ao Playwright:
// captura o FormData na própria página. O envio é por XHR desde 27/09/2026
// (é o que separa "enviando" de "processando" na tela); o fetch fica coberto
// também.
await p.evaluate(() => {
  const original = window.fetch;
  window.fetch = (url, opcoes) => {
    if (opcoes?.body instanceof FormData) window.__substitui = opcoes.body.get('substitui');
    return original(url, opcoes);
  };
  const enviarXhr = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (corpo) {
    if (corpo instanceof FormData) window.__substitui = corpo.get('substitui');
    return enviarXhr.call(this, corpo);
  };
});
const [escolha] = await Promise.all([
  p.waitForEvent('filechooser'),
  p.click(`.criativo-card[data-id="${reserva}"] [data-acao="substituir"]`),
]);
await escolha.setFiles({ name: 'nova.png', mimeType: 'image/png', buffer: Buffer.from('nao e imagem') });
await p.waitForFunction(() => /./.test(document.getElementById('uploadMsg').textContent) && !/Enviando|Processando/.test(document.getElementById('uploadMsg').textContent));
check('o envio carregou o campo "substitui" da peça certa', (await p.evaluate(() => window.__substitui)) === String(reserva));
check('erro de arquivo aparece sem quebrar a tela', (await p.textContent('#uploadMsg')).length > 0);

console.log('== recusas do servidor na substituição ==');
const recusaPendente = await p.evaluate(
  async ({ id, alvo }) => {
    const fd = new FormData();
    fd.append('arquivo', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('substitui', String(alvo));
    const r = await fetch(`/anunciantes/${id}/criativos`, { method: 'POST', credentials: 'include', body: fd });
    return `${r.status} ${(await r.json()).erro}`;
  },
  { id: conta.id, alvo: substituta },
);
check('substituir peça que não está aprovada: 400', /^400 .*só dá pra substituir/.test(recusaPendente), recusaPendente);
const recusaDupla = await p.evaluate(
  async ({ id, alvo }) => {
    const fd = new FormData();
    fd.append('arquivo', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('substitui', String(alvo));
    const r = await fetch(`/anunciantes/${id}/criativos`, { method: 'POST', credentials: 'include', body: fd });
    return `${r.status} ${(await r.json()).erro}`;
  },
  { id: conta.id, alvo: noAr },
);
check('segunda substituta pra mesma peça: 409', /^409 .*substituta em análise/.test(recusaDupla), recusaDupla);

console.log('== aprovação da substituta troca as duas sem F5 ==');
const admin = await b.newContext();
await admin.request.post(`${B}/admin/login`, {
  data: { usuario: process.env.ADMIN_USER, senha: process.env.ADMIN_PASSWORD },
});
const aprov = await admin.request.patch(`${B}/admin/criativos/${substituta}`, { data: { status: 'aprovado' } });
check('admin aprovou a substituta', aprov.ok(), aprov.status());
await p.waitForFunction(
  (id) => document.querySelector(`.criativo-card[data-id="${id}"]`)?.textContent.includes('Programado'),
  substituta,
  { timeout: 8000 },
).catch(() => {});
// Aprovada entra na programação; "No ar" só quando a TV confirmar.
check('substituta agora Programada (via SSE), não "No ar" antes da TV', (await card(substituta)).includes('Programado'), await card(substituta));
check('a antiga saiu do ar', (await card(noAr)).includes('Fora do ar'));
check('sem reload', await p.evaluate(() => window.__semReload === true));

console.log('== excluir recusada ==');
// Modal Mostraí (confirmar.js), não confirm() nativo: um diálogo nativo
// aqui é regressão.
p.once('dialog', (d) => {
  falha('excluir abriu diálogo nativo do navegador', d.message());
  d.dismiss();
});
await p.click(`.criativo-card[data-id="${recusada}"] [data-acao="excluir"]`);
await p.waitForSelector('dialog.dlg-confirmar[open]', { timeout: 5000 });
check('confirmação em modal Mostraí, com título e consequência', (await p.textContent('dialog.dlg-confirmar')).includes('Excluir'));
await p.click('dialog.dlg-confirmar [data-confirmar]');
await p.waitForFunction((id) => !document.querySelector(`.criativo-card[data-id="${id}"]`), recusada, { timeout: 8000 });
check('recusada some da lista', !(await p.$(`.criativo-card[data-id="${recusada}"]`)));

for (let i = 0; i < 3; i++) {
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(300);
}
await p.waitForTimeout(700);
check(
  'resync não duplica cards',
  (await p.$$('.criativo-card')).length === Number(PG(`SELECT count(*) FROM criativos WHERE anunciante_id=${conta.id}`)),
);
await shot(p, '2-depois');

await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(400);
check('celular: sem rolagem horizontal', (await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
await shot(p, '3-celular');

console.log('== ser ponto não dá plano: comodato legado sem plano não envia criativo (ADR-016) ==');
const dono = await novaConta('comodato');
PG(`UPDATE anunciantes SET comodato_plano_id = 'comodato-basico', papeis = ARRAY['anunciante','ponto'] WHERE id = ${dono.id}`);
PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, status)
   VALUES ('Loja comodato', 'Rua Dois, 2', 'Matão', 'SP', '15990000', 'outro', 'R', '16', ${dono.id}, 'em_operacao')`,
);
p = await entrar(dono);
await p.waitForSelector('#modCriativos:not([hidden])', { timeout: 8000 }).catch(() => {});
// Desde 01/10/2026 o dono de ponto da rede vê o painel inteiro — o módulo
// aparece, mas o envio só abre com o Básico ativo (aqui a tela nem existe).
check(
  'dono sem plano (só o comodato legado) não envia criativo: módulo diz aguardando instalação',
  (await p.isVisible('[data-criativos-aguardando]')) &&
    !(await p.isVisible('#rotuloEnviarCriativo')) &&
    /tela do seu ponto estiver instalada/.test(await p.textContent('#modCriativos')),
);
await irQuieto(p, `${B}/anunciante/ponto.html`);
check('página antiga do ponto redireciona pro painel', /painel\.html#modPontos$/.test(p.url()) && !(await p.$('#arquivoAutoanuncio')), p.url());

check('sem erro de console', erros.length === 0, erros.join(' | '));
check('nenhuma resposta 4xx/5xx inesperada', respostasRuins.length === 0, respostasRuins.join(' | '));
await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
