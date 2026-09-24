// Integração definitiva com o Player V2 (24/09/2026) — definição de pronto
// do dono, ponta a ponta, na rota real do admin e com um "Player" simulado
// por HTTP seguindo docs/player-v2-contract.md (sancompany/Playlist.MostrAi):
//
//   Rede → ponto → + Tela → Tela 1 → Preparar instalação → baixa o
//   mostrai-config.json → Player provisiona → hello → primeiro sinal sem F5
//   → versão/build → Operando → config desejada × aplicada → erro no
//   diagnóstico → rotação de credencial → dono vê só o simplificado → V1
//   continua.
//
// Assume banco zerado (reset-db.sh) e servidor na 3999.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

// ---------- "Player" simulado ----------
const H = { 'Content-Type': 'application/json', 'X-Player-Version': '1.0.0+2', 'X-Player-Contract': '2' };
let credencial = null;
const chamar = (metodo, caminho, corpo, chave = credencial?.chaveAparelho) =>
  fetch(`${B}${caminho}`, {
    method: metodo,
    headers: { ...H, ...(chave ? { 'X-Aparelho-Id': chave, 'X-Aparelho-Key': chave } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
const heartbeat = (extra = {}, chave) =>
  chamar(
    'POST',
    `/player/${credencial.dispositivoId}/heartbeat`,
    {
      versaoContrato: 2,
      estado: 'PLAYING',
      configVersionAplicada: 0,
      criativoId: '1',
      ultimaPlaylistOkEm: new Date().toISOString(),
      fila: { pendentes: 3, maisAntigoEm: new Date(Date.now() - 60000).toISOString() },
      erro: null,
      desvioRelogioMs: -1200,
      ...extra,
    },
    chave,
  );

// ---------- fixture: ponto com dono ----------
const email = `dono-v2-${Date.now()}@teste.com`;
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
   '{"seg":{"abre":"00:00","fecha":"23:59"},"ter":{"abre":"00:00","fecha":"23:59"},"qua":{"abre":"00:00","fecha":"23:59"},"qui":{"abre":"00:00","fecha":"23:59"},"sex":{"abre":"00:00","fecha":"23:59"},"sab":{"abre":"00:00","fecha":"23:59"},"dom":{"abre":"00:00","fecha":"23:59"}}')
   RETURNING id`,
);

const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const ctx = await b.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
const admin = await ctx.newPage();
const erros = [];
const ruins = [];
admin.on('pageerror', (e) => erros.push(e.message));
admin.on('console', (m) => {
  if (m.type() === 'error' && !/status of 40[14]/.test(m.text())) erros.push(m.text());
});
admin.on('response', (r) => {
  if (r.status() >= 500 && r.url().startsWith(B)) ruins.push(`${r.status()} ${r.url()}`);
});

console.log('== login admin → Rede ==');
await admin.goto(`${B}/admin/index.html`, { waitUntil: 'networkidle' });
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('.admin-shell');
await admin.evaluate(() => {
  location.hash = 'rede/pontos';
});
await admin.waitForSelector('.rede-resumo');
check('resumo da rede no topo', /pontos?[\s\S]*telas?[\s\S]*operando[\s\S]*com problema[\s\S]*aguardando instalação/.test(await admin.textContent('.rede-resumo')));
const card = admin.locator(`a[href="#rede/pontos/${pontoId}"]`);
check('card do ponto sem ID técnico', !/#\d|ID do/.test(await card.textContent()));
check('card do ponto: aguardando instalação e nenhuma tela', /Aguardando instalação[\s\S]*Nenhuma tela/.test(await card.textContent()));
await admin.screenshot({ path: `${SAIDA}player-v2-rede.png`, fullPage: true });

console.log('== ficha do ponto → + Adicionar tela ==');
await card.click();
await admin.waitForSelector('#pontoTelas');
check('ficha do ponto não expõe o registro interno', !/ID do Ponto #/.test(await admin.textContent('#pontoInformacoes')));
await admin.click('[data-nova-tela]');
const modal = admin.locator('dialog[open]');
const textoModal = await modal.textContent();
check('modal de nova tela sem nome/chave/URL/token', !/Nome da tela|chave|baseUrl|token|URL da API|dispositivoId/i.test(textoModal), textoModal);
await modal.locator('button[type=submit]').click();
await admin.waitForSelector('.tela-ficha');
const topo = await admin.textContent('.tela-ficha-topo');
check('Tela 1 criada Ativa + Aguardando primeiro sinal', /Tela 1[\s\S]*Ativa[\s\S]*Aguardando primeiro sinal/.test(topo), topo);
const telaId = Number(admin.url().split('/').pop());

console.log('== Preparar Player → JSON uma vez + download ==');
const [download] = await Promise.all([admin.waitForEvent('download'), admin.click('[data-acao="preparar"]')]);
check('arquivo se chama mostrai-config.json', download.suggestedFilename() === 'mostrai-config.json');
const arquivo = JSON.parse(readFileSync(await download.path(), 'utf8'));
check('arquivo tem dispositivoId (5 dígitos), chaveAparelho, baseUrl e rotação', /^[1-9]\d{4}$/.test(arquivo.dispositivoId) && arquivo.chaveAparelho?.length > 30 && !!arquivo.baseUrl && arquivo.rotacaoTela === 0);
check('modal mostra o mesmo JSON (copiar)', (await admin.inputValue('dialog[open] #playerConfigJson')).includes(arquivo.chaveAparelho));
await admin.click('dialog[open] [data-fechar]');
await admin.waitForTimeout(300);
const fichaPreparada = await admin.textContent('.tela-ficha');
check('ficha: dispositivoId aparece, chave nunca', fichaPreparada.includes(arquivo.dispositivoId) && !fichaPreparada.includes(arquivo.chaveAparelho));
check('ponto: aguardando primeiro sinal', PG(`SELECT status FROM pontos WHERE id=${pontoId}`) === 'aguardando_primeiro_sinal');

console.log('== Player usa a credencial direta + hello → primeiro sinal sem F5 ==');
credencial = { dispositivoId: arquivo.dispositivoId, chaveAparelho: arquivo.chaveAparelho };
const hello = await chamar('POST', `/player/${credencial.dispositivoId}/hello`, {
  contrato: 2,
  versaoApp: '1.0.0',
  buildNumber: 2,
  fabricante: 'TCL',
  modelo: '32S6500S',
  android: '8.0.0',
  largura: 1920,
  altura: 1080,
  timezone: 'America/Sao_Paulo',
});
check('hello 200 com configVersion', hello.status === 200 && (await hello.json()).configVersion === 1);
const hb1 = await (await heartbeat()).json();
check('heartbeat pede a config (configVersion 1)', hb1.configVersion === 1);
await admin.waitForFunction(() => /Operando/.test(document.querySelector('.tela-ficha-topo')?.textContent || ''), null, {
  timeout: 8000,
});
const ficha = await admin.textContent('.tela-ficha');
check('Operando sem F5', /Operando/.test(ficha));
check('versão/build do Player aparecem', /1\.0\.0/.test(ficha) && /build 2/.test(ficha));
check('dispositivoId aparece rotulado', ficha.includes(credencial.dispositivoId) && /ID do dispositivo/i.test(ficha));
check('chave do aparelho NUNCA aparece', !ficha.includes(credencial.chaveAparelho));
check('fingerprint aparece', /Fingerprint[\s\S]*…[0-9A-F]{6}/.test(ficha));

console.log('== config desejada × aplicada ==');
await (await chamar('GET', `/player/${credencial.dispositivoId}/config`)).json();
await heartbeat({ configVersionAplicada: 1 });
await admin.waitForFunction(() => /Atualizada/.test(document.querySelector('.tela-ficha')?.textContent || ''), null, {
  timeout: 8000,
});
check('config v1 aplicada → Atualizada', true);
await admin.click('[data-acao="area"]');
await admin.fill('#area_superior', '2.5');
await admin.fill('#area_esquerda', '1');
await admin.click('dialog[open] button[type=submit]');
await admin.waitForFunction(() => /Sincronizando|Pendente/.test(document.querySelector('.tela-ficha')?.textContent || ''), null, {
  timeout: 8000,
});
check('área segura editada → versão desejada sobe, situação sincronizando', /desejada v2/.test(await admin.textContent('.tela-ficha')));
const cfg = await (await chamar('GET', `/player/${credencial.dispositivoId}/config`)).json();
check('GET /config entrega a margem nova e o horário', cfg.configVersion === 2 && cfg.margens.superior === 2.5 && cfg.operacao.regime === 'FOLLOW_POINT');
await heartbeat({ configVersionAplicada: 2 });
await admin.waitForFunction(() => /Atualizada/.test(document.querySelector('.tela-ficha')?.textContent || ''), null, {
  timeout: 8000,
});
check('Player aplica v2 → Atualizada sem F5', true);
check('área segura aparece resumida (sem 4 inputs abertos)', (await admin.locator('.tela-ficha input[type=number]').count()) === 0);

console.log('== erro do player → diagnóstico ==');
await heartbeat({
  configVersionAplicada: 2,
  estado: 'PLAYBACK_ERROR',
  erro: { codigo: 'PLAYBACK_FALHOU', ocorreuEm: new Date().toISOString(), mensagem: 'ERROR_CODE_DECODING_FAILED' },
});
await admin.waitForFunction(() => /Erro do player/.test(document.querySelector('.tela-ficha-topo')?.textContent || ''), null, {
  timeout: 8000,
});
await admin.click('[data-bloco="diagnostico"] summary');
const diag = await admin.textContent('[data-bloco="diagnostico"]');
check('diagnóstico mostra código e mensagem do erro', diag.includes('PLAYBACK_FALHOU') && diag.includes('ERROR_CODE_DECODING_FAILED'));
check('diagnóstico mostra aparelho e fila', /TCL 32S6500S/.test(diag) && /3 pendentes/.test(diag));
check('diagnóstico não inventa Device Owner', !/Device Owner/.test(diag));
await heartbeat({ configVersionAplicada: 2 });
await admin.waitForFunction(() => /Operando/.test(document.querySelector('.tela-ficha-topo')?.textContent || ''), null, {
  timeout: 8000,
});
check('erro resolvido → Operando de novo', true);
await admin.click('[data-bloco="historico"] summary');
await admin.waitForSelector('.tela-historico');
const hist = await admin.textContent('.tela-historico');
check('histórico com transições (provisionou, primeiro sinal, erro, resolvido, config)', /Player preparado/.test(hist) && /Primeiro sinal/.test(hist) && /Erro do player/.test(hist) && /Erro resolvido/.test(hist) && /Configuração aplicada/.test(hist));
check('histórico sem uma linha por heartbeat', (await admin.locator('.tela-historico li').count()) < 15);
await admin.screenshot({ path: `${SAIDA}player-v2-ficha-tela.png`, fullPage: true });

console.log('== rotação de credencial (overlap) ==');
await admin.click('[data-acao="rotacionar"]');
await admin.click('dialog[open] [data-confirmar]');
await admin.waitForFunction(() => /aguardando confirmação/.test(document.querySelector('.tela-ficha')?.textContent || ''), null, {
  timeout: 8000,
});
const hbRot = await (await heartbeat({ configVersionAplicada: 2 })).json();
check('heartbeat entrega novaChave', typeof hbRot.novaChave === 'string' && hbRot.novaChave !== credencial.chaveAparelho);
const antiga = credencial.chaveAparelho;
const comNova = await heartbeat({ configVersionAplicada: 2 }, hbRot.novaChave);
check('primeira requisição com a nova é aceita', comNova.status === 200 && !(await comNova.json()).novaChave);
check('antiga ainda vale na sobreposição', (await heartbeat({ configVersionAplicada: 2 }, antiga)).status === 200);
credencial.chaveAparelho = hbRot.novaChave;
await admin.waitForFunction(() => /Credencial anterior/.test(document.querySelector('.tela-ficha')?.textContent || ''), null, {
  timeout: 8000,
});
const fichaRot = await admin.textContent('.tela-ficha');
check('ficha: rotacionada, anterior expira', /Não programada/.test(fichaRot) && /Credencial anterior[\s\S]*expira/.test(fichaRot));
check('nenhuma das chaves aparece', !fichaRot.includes(antiga) && !fichaRot.includes(hbRot.novaChave));
const json = await (await admin.request.get(`${B}/admin/dispositivos/${telaId}`)).text();
check('JSON do admin sem chave, hash ou token', !json.includes(antiga) && !json.includes(hbRot.novaChave) && !json.includes(arquivo.tokenProvisionamento) && !/chave_hash|aparelho_id|pin_hash|cifrad/.test(json));

console.log('== playlist V2 + contentHash + proof ==');
const pl = await (await chamar('GET', `/playlist/${credencial.dispositivoId}`)).json();
check('playlist V2 em envelope', pl.versaoContrato === 2 && Array.isArray(pl.itens));

console.log('== card fechado na ficha do ponto ==');
await admin.click(`.breadcrumb a[href="#rede/pontos/${pontoId}"]`);
await admin.waitForSelector('.tela-card');
const cardTela = await admin.textContent('.tela-card');
check('card da tela: Ativa, Operando, player, último sinal, operação, config', /Tela 1[\s\S]*Ativa[\s\S]*Operando[\s\S]*1\.0\.0 · build 2[\s\S]*Último sinal[\s\S]*Operação[\s\S]*Configuração[\s\S]*Atualizada/.test(cardTela), cardTela);
check('ponto virou Ativo depois do primeiro sinal', /Ativo/.test(await admin.textContent('#pontoInformacoes')));
check('layout notebook sem rolagem horizontal', (await admin.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
await admin.screenshot({ path: `${SAIDA}player-v2-ponto.png`, fullPage: true });

console.log('== dono do ponto: visão simplificada ==');
const dono = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await dono.goto(`${B}/anunciante/login.html`, { waitUntil: 'networkidle' });
await dono.fill('#email', email);
await dono.fill('#senha', 'Senha123!');
await dono.click('button[type="submit"]');
await dono.waitForURL(/painel\.html/, { timeout: 10000 });
await dono.waitForSelector('#pontosLista .tela-linha', { timeout: 10000 });
const visaoDono = await dono.textContent('#pontosLista');
check('dono vê Tela 1 funcionando e a operação', /Tela 1[\s\S]*Funcionando[\s\S]*Horário do estabelecimento/.test(visaoDono), visaoDono);
check('dono não vê nada técnico', !/tela_[0-9a-f]|dispositivoId|Fingerprint|credencial|contrato|build|Android|fila|SHA|config/i.test(visaoDono), visaoDono);
const apiDono = await (await dono.request.get(`${B}/anunciantes/me/meus-pontos`)).text();
check('API do dono sem dado técnico', !/tela_[0-9a-f]{20}|chave|fingerprint|player_|hash|fila_|contrato/i.test(apiDono));

console.log('== fluxo antigo de chave aposentado; V1 em campo continua pelo ID numérico ==');
check('chave-legada responde 410', (await admin.request.post(`${B}/admin/dispositivos/${telaId}/chave-legada`)).status() === 410);
const v1 = { 'X-Aparelho-Id': credencial.chaveAparelho, 'Content-Type': 'application/json' };
const plV1 = await fetch(`${B}/playlist/${credencial.dispositivoId}`, { headers: v1 });
check('playlist V1 (array) sem X-Player-Contract', plV1.status === 200 && Array.isArray(await plV1.json()));
const hbV1 = await fetch(`${B}/player/${credencial.dispositivoId}/heartbeat`, { method: 'POST', headers: v1, body: '{}' });
const hbV1j = await hbV1.json();
check('heartbeat V1 vazio: 200 com margens, sem campos V2', hbV1.status === 200 && hbV1j.margens && !('configVersion' in hbV1j));
check('PK numérica não autentica a tela que tem dispositivoId', (await fetch(`${B}/playlist/${telaId}`, { headers: v1 })).status === 401);

check('console limpo', erros.length === 0, erros.join(' | '));
check('sem 5xx', ruins.length === 0, ruins.join(' | '));
await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
