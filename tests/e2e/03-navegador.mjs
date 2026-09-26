// Fluxo principal no navegador, contra o servidor local real (porta 3999),
// como existe hoje (reescrito em 23/09/2026 — vendedor, custos, "Marcar
// parceiro" e a aba de telas em tabela saíram do produto, e as checagens
// deles saíram junto; Player MVP em 26/09/2026 — o player web, o "Preparar
// Player" e o PIN por tela saíram, ver docs/player-mvp-contract.md): conta
// direta nasce anunciante → pede o modo ponto → a Visão geral mostra a
// pendência → admin aprova na ficha da candidatura → o ponto nasce
// aguardando instalação → admin cria a tela (M-xxxx) na ficha do ponto e
// gera o código de instalação (XXXX-XXXX, nenhuma chave na página) → a TV
// se instala com ID + código e o ponto entra em operação; vitrine de planos,
// Contas com o dono de ponto e cadastro no celular.
// Assume banco zerado (tests/e2e/reset-db.sh) e servidor na 3999.
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) => execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`).toString().trim();
const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
// Admin e usuários em contextos separados: o cookie de sessão é um só por
// contexto, e o cadastro regenera a sessão (derrubaria o admin).
const ctxAdmin = await b.newContext({ viewport: { width: 1280, height: 900 } });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const falhas = [];
const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => { console.log('  FALHA', t, d || ''); falhas.push(t); };
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
async function pagina(url, vp, contexto = ctx) {
  const p = await contexto.newPage();
  if (vp) await p.setViewportSize(vp);
  p.on('pageerror', (e) => erros.push(`${url}: ${e.message}`));
  // 401/404 esperados (sem login, PIN errado) não contam.
  p.on('console', (m) => { if (m.type() === 'error' && !/status of (401|404)/.test(m.text())) erros.push(`${url} console: ${m.text()}`); });
  p.on('dialog', async (d) => { d.type() === 'prompt' ? await d.accept(d.defaultValue()) : await d.accept(); });
  await irQuieto(p, B + url);
  return p;
}
async function irPara(adm, hash) {
  await adm.evaluate((h) => {
    location.hash = h;
  }, hash);
}
async function shot(p, nome) { await p.screenshot({ path: new URL(`./saida/v2-${nome}.png`, import.meta.url).pathname, fullPage: true }); }

console.log('== conta direta (Farmácia Central) nasce anunciante; pede o modo ponto pelo painel ==');
// A interação com o FORMULÁRIO desse pedido (campos, horário, foto) é
// coberta a fundo por 05-navegador-modos.mjs e 08-candidatura-ponto.mjs; aqui
// só falta ter uma conta com ponto pra alimentar o resto deste arquivo
// (aprovação, tela, código de instalação).
const farm = await pagina('/');
const rCad = await farm.evaluate(async () =>
  (
    await (
      await fetch('/anunciantes/cadastro', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome_empresa: 'Farmácia Central',
          cpf_cnpj: '111.444.777-35',
          endereco: 'Rua Sete de Setembro, 100',
          cidade: 'Matão',
          uf: 'SP',
          cep: '15990-000',
          contato_email: 'carla@x.com',
          contato_telefone: '16 99999-1111',
          senha: 'Senha12@',
          aceitou_termos: true,
        }),
      })
    ).json()
  ),
);
check('conta direta nasce só com anunciante', JSON.stringify(rCad.papeis) === '["anunciante"]', JSON.stringify(rCad));
const rPedido = await farm.evaluate(async () =>
  (
    await (
      await fetch('/conta/modos/ponto/pedir', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome_comercio: 'Farmácia Central',
          endereco: 'Rua Sete de Setembro, 100',
          cidade: 'Matão',
          uf: 'SP',
          cep: '15990-000',
          segmento: 'saúde',
          fluxo_estimado_mensal: 1200,
          horario_semanal: {
            seg: { abre: '08:00', fecha: '18:00' },
            ter: { abre: '08:00', fecha: '18:00' },
            qua: { abre: '08:00', fecha: '18:00' },
            qui: { abre: '08:00', fecha: '18:00' },
            sex: { abre: '08:00', fecha: '18:00' },
            sab: { abre: '08:00', fecha: '12:00' },
            dom: null,
          },
        }),
      })
    ).json()
  ),
);
check('pedido de ponto criado pelo painel', rPedido.ok === true, JSON.stringify(rPedido));
await farm.close();

console.log('== admin: Visão geral → Candidaturas → aprova na ficha ==');
const adm = await pagina('/admin/', null, ctxAdmin);
await adm.fill('#usuario', 'admin'); await adm.fill('#senha', 'Admin12@teste'); await adm.click('#formLogin button[type=submit]');
await adm.waitForSelector('#app:not([hidden])');
const pendCand = adm.locator('.pend-bloco[data-ir="rede/candidaturas"]');
await pendCand.waitFor({ timeout: 8000 });
check('visão geral mostra receita recorrente', (await adm.textContent('#conteudo')).includes('Receita recorrente'));
check('pendência de candidatura na Visão geral', (await pendCand.locator('.pend-qtd').textContent()) === '1');
await shot(adm, 'admin-resumo');
// Clicar na pendência abre a fila, como o dono faz.
await pendCand.click();
const cardCand = adm.locator('.ponto-card', { hasText: 'Farmácia Central' });
await cardCand.waitFor({ timeout: 8000 });
check('Candidaturas lista a farmácia como card "Em análise"', (await cardCand.locator('.badge').textContent()) === 'Em análise');
check('card mostra o movimento informado', (await cardCand.textContent()).includes('1.200 pessoas/mês'));
await shot(adm, 'admin-candidaturas');
await cardCand.click();
await adm.waitForSelector('[data-aprovar]');
const fichaCand = await adm.textContent('#conteudo');
check('ficha da candidatura com migalha e horário', fichaCand.includes('Candidaturas') && fichaCand.includes('08:00'), fichaCand.slice(0, 200));
await adm.click('[data-aprovar]');
await adm.click('dialog.modal-admin[open] [data-confirmar]');
await adm.waitForFunction(() => document.getElementById('conteudo').textContent.includes('Nenhuma candidatura aguardando análise'), null, { timeout: 8000 }).catch(() => {});
check('aprovada, a candidatura sai da fila', (await adm.textContent('#conteudo')).includes('Nenhuma candidatura aguardando análise'));
check('conta ganha o papel de ponto, sem convite', PG(`SELECT 'ponto' = ANY(papeis) FROM anunciantes WHERE id=${rCad.id}`) === 't');
const pontoId = Number(PG(`SELECT id FROM pontos WHERE anunciante_id=${rCad.id}`));
check('ponto nasce aguardando instalação, sem tela', PG(`SELECT status FROM pontos WHERE id=${pontoId}`) === 'a_instalar' && PG(`SELECT count(*) FROM dispositivos WHERE ponto_id=${pontoId}`) === '0');
await shot(adm, 'admin-candidaturas-aprovada');

console.log('== admin: ficha do ponto → tela e código de instalação ==');
await irPara(adm, `rede/pontos/${pontoId}`);
await adm.waitForSelector('[data-nova-tela]');
check('ficha do ponto aguardando instalação', (await adm.textContent('.ficha-titulo')).includes('Aguardando instalação'));
check('sem tela ainda — mensagem certa', (await adm.textContent('#pontoTelas')).includes('Nenhuma tela'));
// "+ Adicionar tela": nada a preencher — sem nome manual, sem chave, sem URL;
// a tela nasce com o código humano M-xxxx e a ficha dela já abre.
await adm.click('[data-nova-tela]');
await adm.waitForSelector('.tela-ficha');
check('"+ Adicionar tela" não abre formulário', !(await adm.$('dialog.modal-admin[open]')));
const telaId = Number(adm.url().split('/').pop());
const codigoTela = `M-${String(telaId).padStart(4, '0')}`;
const topo = await adm.textContent('.tela-ficha-topo');
check('tela criada: M-xxxx, aguardando instalação', topo.includes(codigoTela) && /Aguardando instalação/.test(topo), topo);
check('tela nasce Ativa', (await adm.$eval('.tela-ficha [data-campo="status"]', (el) => el.value)) === 'ativo');
check('sem "Preparar Player" nem PIN por tela na ficha', (await adm.locator('[data-acao="preparar"], [data-acao="pin"], [data-acao="pin-ver"]').count()) === 0 && !/Preparar Player|PIN/.test(await adm.textContent('.tela-ficha')));
// PIN de saída global: sem ele o admin não gera código (a UI de Rede que o
// define é coberta pelo 18-rede-player-mvp.mjs).
const pin = await adm.request.put(`${B}/admin/player/pin-saida`, { data: { pin: '48213' } });
check('PIN de saída global definido', pin.status() === 200, pin.status());
await adm.click('[data-acao="gerar-codigo"]');
await adm.waitForSelector('[data-expira]', { timeout: 8000 }).catch(() => {});
const instalacao = await adm.textContent('.tela-ficha');
const codigoInstalacao = instalacao.match(/[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}/)?.[0];
check('Instalação: ID da tela + código XXXX-XXXX + Copiar', instalacao.includes(codigoTela) && !!codigoInstalacao && (await adm.locator('[data-acao="copiar-instalacao"]').count()) === 1, instalacao.slice(0, 300));
check('tela sem Player: ponto continua aguardando instalação', PG(`SELECT status FROM pontos WHERE id=${pontoId}`) === 'a_instalar');
await shot(adm, 'admin-telas');

console.log('== a TV se instala com ID + código ==');
// O Player (Android TV) é simulado por HTTP, como o 18-rede-player-mvp.mjs.
const prov = await fetch(`${B}/player/provisionar`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ codigoTela, codigoInstalacao }),
});
const credencial = await prov.json();
check('provisionar devolve dispositivoId M-xxxx + chave', prov.status === 200 && credencial.dispositivoId === codigoTela && credencial.chaveAparelho?.length === 43);
await adm.waitForFunction(() => /Player conectado/.test(document.querySelector('.tela-ficha')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
check('ficha: "Player conectado" sem F5', /Player conectado/.test(await adm.textContent('.tela-ficha')));
check('a chave nunca aparece na página', !(await adm.textContent('body')).includes(credencial.chaveAparelho));
check('instalação é o primeiro sinal: ponto em operação', PG(`SELECT status FROM pontos WHERE id=${pontoId}`) === 'em_operacao');
const hb = await fetch(`${B}/player/${credencial.dispositivoId}/heartbeat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Aparelho-Key': credencial.chaveAparelho, 'X-Player-Version': '1.0.0+12' },
  body: JSON.stringify({ estado: 'PLAYING', configVersionAplicada: 0, erro: null }),
});
check('heartbeat com X-Aparelho-Key responde configVersion', hb.status === 200 && 'configVersion' in (await hb.json()));
const lista = await fetch(`${B}/playlist/${credencial.dispositivoId}`, { headers: { 'X-Aparelho-Key': credencial.chaveAparelho } });
check('playlist no envelope do contrato', lista.status === 200 && (await lista.json()).versaoContrato === 2);
check('player web não existe mais (/player.html → 404)', (await fetch(`${B}/player.html`)).status === 404);
await shot(adm, 'admin-tela-conectada');

console.log('== planos: vitrine ==');
{
  const p = await pagina('/planos.html');
  await p.waitForTimeout(600);
  check('grade normal continua com 3 planos', (await p.$$('#plansGrid .plan-card')).length === 3);
  await shot(p, 'planos');
  await p.close();
}

console.log('== admin: Contas mostra o dono de ponto ==');
await irPara(adm, 'contas/contas');
await adm.waitForSelector('.tabela-contas');
await adm.click('.chip:has-text("Donos de ponto")');
const linhasDono = adm.locator('.tabela-contas tbody tr:visible');
check('filtro "Donos de ponto" mostra a farmácia', (await linhasDono.count()) === 1 && (await linhasDono.first().textContent()).includes('Farmácia Central'));
await adm.click('.tabela-contas a:has-text("Farmácia Central")');
await adm.waitForSelector('.conta-cabecalho');
check('ficha da conta com o selo "Dono de ponto"', (await adm.textContent('.conta-cabecalho')).includes('Dono de ponto'));
await shot(adm, 'admin-conta');

console.log('== mobile: cadastro ==');
{
  const p = await pagina('/anunciante/cadastro.html', { width: 390, height: 800 });
  const larguraDoc = await p.evaluate(() => document.documentElement.scrollWidth);
  check('cadastro não estoura no celular', larguraDoc <= 390, larguraDoc);
  await p.close();
}

console.log('\nerros de página:', erros.length ? erros : 'nenhum');
console.log('falhas:', falhas.length);
await b.close();
process.exit(falhas.length || erros.length ? 1 : 0);
