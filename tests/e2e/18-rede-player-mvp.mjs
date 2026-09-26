// Player MVP ponta a ponta no admin real (docs/player-mvp-contract.md), com
// um "Player" simulado por HTTP:
//
//   Rede → PIN de saída (sem PIN não instala) → horário do ponto (24 h) →
//   + Tela → M-xxxx "Aguardando instalação" → Gerar código → Player
//   provisiona com ID + código → "Player conectado" sem F5 → heartbeat de
//   15 s → config (margens, horário do ponto, PIN) → área segura sobe a
//   versão → erro no Suporte → revogar → excluir → rotas antigas 404 →
//   dono vê só o simples → celular sem rolagem lateral.
//
// Assume banco zerado (reset-db.sh) e servidor na 3999.
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';
import { execSync } from 'node:child_process';

const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .split('\n')[0]
    .trim();
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const falhas = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const texto = (pagina, seletor) => pagina.textContent(seletor).then((t) => t || '');
const esperarTexto = (pagina, seletor, re, timeout = 8000) =>
  pagina.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent || ''), [seletor, re.source], {
    timeout,
  });

// ---------- "Player" simulado ----------
let credencial = null;
const chamar = (metodo, caminho, corpo, chave = credencial?.chaveAparelho) =>
  fetch(`${B}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      'X-Player-Version': '1.0.0+12',
      ...(chave ? { 'X-Aparelho-Key': chave } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
const heartbeat = (extra = {}, chave) =>
  chamar(
    'POST',
    `/player/${credencial.dispositivoId}/heartbeat`,
    { estado: 'PLAYING', configVersionAplicada: 0, erro: null, fila: { pendentes: 0, maisAntigoEm: null }, ...extra },
    chave,
  );

// ---------- fixture: ponto com dono, sem PIN de saída ----------
PG("DELETE FROM configuracoes_site WHERE chave = 'player_pin_saida'");
const email = `dono-mvp-${Date.now()}@teste.com`;
await fetch(`${B}/anunciantes/cadastro`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nome_empresa: 'Santos Unio',
    cpf_cnpj: '52998224725',
    contato_email: email,
    contato_telefone: '16999994444',
    senha: 'Senha123!',
    aceitou_termos: true,
    endereco: 'Av. Principal, 100',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
  }),
});
const donoId = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
PG(`UPDATE anunciantes SET email_confirmado = true, papeis = ARRAY['ponto'] WHERE id = ${donoId}`);
const pontoId = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, horario_semanal)
   VALUES ('Santos Unio', 'Av. Principal, 100', 'Matão', 'SP', '15990000', 'restaurante', 'Rita', '16999990001', ${donoId},
   '{"seg":{"abre":"09:00","fecha":"18:00"},"ter":{"abre":"09:00","fecha":"18:00"},"qua":{"abre":"09:00","fecha":"18:00"},"qui":{"abre":"09:00","fecha":"18:00"},"sex":{"abre":"09:00","fecha":"18:00"},"sab":null,"dom":null,"feriados":null}')
   RETURNING id`,
);

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });
const admin = await ctx.newPage();
const erros = [];
const ruins = [];
admin.on('pageerror', (e) => erros.push(e.message));
admin.on('console', (m) => {
  if (m.type() === 'error' && !/status of 40[0149]/.test(m.text())) erros.push(m.text());
});
admin.on('response', (r) => {
  if (r.status() >= 500 && r.url().startsWith(B)) ruins.push(`${r.status()} ${r.url()}`);
});

console.log('== login admin → Rede ==');
await irQuieto(admin, `${B}/admin/index.html`);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('.admin-shell');
await admin.evaluate(() => {
  location.hash = 'rede/pontos';
});
await admin.waitForSelector('.pin-saida');
check('Rede avisa que não há PIN de saída', /Nenhum PIN definido/.test(await texto(admin, '.pin-saida')));
check('sem aba "Versões do Player"', !/Versões do Player/.test(await texto(admin, 'body')));

console.log('== sem PIN o código de instalação não sai ==');
await admin.click(`a[href="#rede/pontos/${pontoId}"]`);
await admin.waitForSelector('#pontoTelas');
await admin.click('[data-nova-tela]');
await admin.waitForSelector('.tela-ficha');
const telaId = Number(admin.url().split('/').pop());
const codigoTela = `M-${String(telaId).padStart(4, '0')}`;
const topo = await texto(admin, '.tela-ficha-topo');
check('tela nasce com o ID humano e "Aguardando instalação"', topo.includes(codigoTela) && /Aguardando instalação/.test(topo), topo);
await admin.click('[data-acao="gerar-codigo"]');
await admin.waitForSelector('.toast', { timeout: 5000 }).catch(() => {});
check('sem PIN: nenhum código aparece', !/[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/.test(await texto(admin, '.tela-ficha')));
check('API recusa com 409', (await admin.request.post(`${B}/admin/dispositivos/${telaId}/codigo-instalacao`)).status() === 409);

console.log('== PIN de saída em Rede ==');
await admin.evaluate(() => {
  location.hash = 'rede/pontos';
});
await admin.waitForSelector('[data-pin-alterar]');
await admin.click('[data-pin-alterar]');
await admin.fill('#pinNovo', '1234');
await admin.fill('#pinConfirma', '1234');
await admin.click('dialog[open] button[type=submit]');
await esperarTexto(admin, 'dialog[open] [data-msg]', /sequência/);
check('PIN óbvio é recusado no modal', true);
await admin.fill('#pinNovo', '48213');
await admin.fill('#pinConfirma', '48213');
await admin.click('dialog[open] button[type=submit]');
await esperarTexto(admin, '.pin-saida', /O mesmo em todas as TVs/);
check('PIN salvo; o número não aparece na Rede', !(await texto(admin, '.pin-saida')).includes('48213'));
await admin.screenshot({ path: `${SAIDA}player-mvp-rede.png`, fullPage: true });
await admin.click('[data-pin-ver]');
await admin.waitForSelector('dialog[open] .pin-saida-numero');
check('"Ver PIN" mostra o número', (await texto(admin, 'dialog[open] .pin-saida-numero')) === '48213');
await admin.click('dialog[open] [data-fechar]');
check(
  'ver o PIN fica registrado',
  Number(PG("SELECT COUNT(*) FROM eventos WHERE nome = 'player:pin_saida_revelado' AND criado_em > now() - interval '5 minutes'")) >= 1,
);

console.log('== horário do ponto: 24 h ==');
await admin.click(`a[href="#rede/pontos/${pontoId}"]`);
await admin.waitForSelector('[data-editar-horario]');
await admin.click('[data-editar-horario]');
await admin.screenshot({ path: `${SAIDA}player-mvp-horario.png` });
await admin.click('dialog[open] [data-tudo-24h]');
await admin.click('dialog[open] button[type=submit]');
await esperarTexto(admin, '#pontoInformacoes', /Seg–sex[\s\S]*24h/);
check('ficha do ponto mostra 24h', true);

console.log('== + código de instalação → Player provisiona ==');
await admin.click(`a[href="#rede/pontos/${pontoId}/telas/${telaId}"]`);
await admin.waitForSelector('[data-acao="gerar-codigo"]');
await admin.click('[data-acao="gerar-codigo"]');
await admin.waitForSelector('[data-expira]');
const instalacao = await texto(admin, '.tela-ficha');
const codigo = instalacao.match(/[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/)?.[0];
check('código XXXX-XXXX + contagem + Copiar', !!codigo && /\d\d:\d\d/.test(await texto(admin, '[data-expira]')) && (await admin.locator('[data-acao="copiar-instalacao"]').count()) === 1);
await admin.click('[data-acao="copiar-instalacao"]');
const copiado = await admin.evaluate(() => navigator.clipboard.readText()).catch(() => '');
check('Copiar leva ID + código', copiado.includes(codigoTela) && copiado.includes(codigo), copiado);
await admin.screenshot({ path: `${SAIDA}player-mvp-codigo.png`, fullPage: true });

const prov = await fetch(`${B}/player/provisionar`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ codigoTela: codigoTela.replace('-', '').toLowerCase(), codigoInstalacao: codigo.toLowerCase() }),
});
credencial = await prov.json();
check('provisionar devolve só dispositivoId + chaveAparelho', prov.status === 200 && Object.keys(credencial).sort().join() === 'chaveAparelho,dispositivoId' && credencial.dispositivoId === codigoTela);
await esperarTexto(admin, '.tela-ficha', /Player conectado/);
check('"Player conectado" sem F5', true);
check('a chave nunca aparece na ficha', !(await texto(admin, 'body')).includes(credencial.chaveAparelho));
const json = await (await admin.request.get(`${B}/admin/dispositivos/${telaId}`)).text();
check('JSON do admin sem chave nem hash', !json.includes(credencial.chaveAparelho) && !/chave_hash|cifrad|token/.test(json));

console.log('== heartbeat + config ==');
const hb = await (await heartbeat()).json();
check('heartbeat: só configVersion + playlist.atualizar', Object.keys(hb).sort().join() === 'configVersion,playlist' && typeof hb.playlist.atualizar === 'boolean');
const repetido = await fetch(`${B}/player/provisionar`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ codigoTela, codigoInstalacao: codigo }),
});
check('depois do primeiro uso da chave, o mesmo código vale nada (401)', repetido.status === 401);
let cfg = await (await chamar('GET', `/player/${credencial.dispositivoId}/config`)).json();
check('config: margens 0, 24 h, PIN global', cfg.configVersion === hb.configVersion && cfg.margens.superior === 0 && cfg.pinSaida === '48213' && cfg.operacao.porDiaDaSemana.dom[0].fim === '24:00');
check('config sem rotação, update, URL', !/rotacao|update|baseUrl|regime/.test(JSON.stringify(cfg)));
await heartbeat({ configVersionAplicada: cfg.configVersion });
await esperarTexto(admin, '.tela-ficha-topo', /Operando/);
check('Operando sem F5', true);

console.log('== área segura sobe a versão ==');
await admin.fill('#area_superior', '2.5');
await admin.fill('#area_esquerda', '1');
await admin.click('[data-form-area] button[type=submit]');
await admin.waitForTimeout(500);
const hb2 = await (await heartbeat({ configVersionAplicada: cfg.configVersion })).json();
check('heartbeat anuncia config nova', hb2.configVersion === cfg.configVersion + 1);
cfg = await (await chamar('GET', `/player/${credencial.dispositivoId}/config`)).json();
check('config traz a margem nova', cfg.margens.superior === 2.5 && cfg.margens.esquerda === 1);
await heartbeat({ configVersionAplicada: cfg.configVersion });

console.log('== erro no Suporte ==');
await heartbeat({
  configVersionAplicada: cfg.configVersion,
  estado: 'PLAYBACK_ERROR',
  erro: { codigo: 'PLAYBACK_FALHOU', mensagem: 'vídeo corrompido', ocorreuEm: new Date().toISOString() },
});
await esperarTexto(admin, '.tela-ficha-topo', /Erro do Player/);
check('Suporte mostra o último erro', /Suporte[\s\S]*vídeo corrompido/.test(await texto(admin, '.tela-ficha')));
await heartbeat({ configVersionAplicada: cfg.configVersion, erro: null });
await esperarTexto(admin, '.tela-ficha-topo', /Operando/);
check('erro resolvido → Operando', true);
await admin.screenshot({ path: `${SAIDA}player-mvp-ficha.png`, fullPage: true });

console.log('== ficha do ponto: linha da tela ==');
await admin.click(`.breadcrumb a[href="#rede/pontos/${pontoId}"]`);
await admin.waitForSelector('.tela-linha');
const linha = await texto(admin, '.tela-linha');
check('linha: M-xxxx + Operando + Abrir + Excluir', linha.includes(codigoTela) && /Operando/.test(linha) && /Abrir/.test(linha) && /Excluir/.test(linha), linha);

console.log('== dono do ponto: visão simples ==');
const dono = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await irQuieto(dono, `${B}/anunciante/login.html`);
await dono.fill('#email', email);
await dono.fill('#senha', 'Senha123!');
await dono.click('button[type="submit"]');
await dono.waitForURL(/painel\.html/, { timeout: 10000 });
await dono.waitForSelector('#pontosLista .tela-linha', { timeout: 10000 });
const visaoDono = await texto(dono, '#pontosLista');
check('dono vê a tela funcionando', visaoDono.includes(codigoTela) && /Funcionando/.test(visaoDono), visaoDono);
check('dono não vê PIN, chave nem nada técnico', !/PIN|chave|build|Android|fila|config/i.test(visaoDono), visaoDono);

console.log('== revogar → aguardando instalação ==');
await admin.click(`a[href="#rede/pontos/${pontoId}/telas/${telaId}"]`);
await admin.waitForSelector('[data-acao="revogar"]');
await admin.click('[data-acao="revogar"]');
await admin.click('dialog[open] [data-confirmar]');
await esperarTexto(admin, '.tela-ficha-topo', /Aguardando instalação/);
check('revogar volta a "Aguardando instalação"', true);
check('a chave antiga recebe 401', (await heartbeat()).status === 401);

console.log('== celular ==');
await admin.setViewportSize({ width: 390, height: 844 });
await admin.waitForTimeout(300);
check('ficha da tela sem rolagem lateral no celular', (await admin.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
await admin.screenshot({ path: `${SAIDA}player-mvp-celular.png`, fullPage: true });
await admin.setViewportSize({ width: 1366, height: 900 });

console.log('== excluir tela sem histórico ==');
await admin.click('[data-acao="excluir"]');
await admin.click('dialog[open] [data-confirmar]');
await admin.waitForSelector('#pontoTelas');
await admin.waitForTimeout(300);
check('tela some do ponto', !(await texto(admin, '#pontoTelas')).includes(codigoTela));
check('tela não existe mais', PG(`SELECT COUNT(*) FROM dispositivos WHERE id = ${telaId}`) === '0');

console.log('== o que saiu não responde mais ==');
check('/player.html não existe', (await fetch(`${B}/player.html`)).status === 404);
check('/admin/player-releases não existe', (await admin.request.get(`${B}/admin/player-releases`)).status() === 404);
check('/player/:id/hello não existe', (await fetch(`${B}/player/${codigoTela}/hello`, { method: 'POST' })).status === 404);

check('console limpo', erros.length === 0, erros.join(' | '));
check('sem 5xx', ruins.length === 0, ruins.join(' | '));
await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
