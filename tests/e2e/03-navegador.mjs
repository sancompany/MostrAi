// Fluxo principal no navegador, contra o servidor local real (porta 3999),
// como existe hoje (reescrito em 23/09/2026 — vendedor, custos, "Marcar
// parceiro" e a aba de telas em tabela saíram do produto, e as checagens
// deles saíram junto): conta direta nasce anunciante → pede o modo ponto →
// a Visão geral mostra a pendência → admin aprova na ficha da candidatura →
// o ponto nasce aguardando instalação → admin cria a tela na ficha do ponto,
// gera a chave e define o PIN → marcar a tela como ativa põe o ponto em
// operação → o player carrega e abre o painel por PIN; vitrine de planos,
// Contas com o dono de ponto e cadastro no celular.
// Assume banco zerado (tests/e2e/reset-db.sh) e servidor na 3999.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) => execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`).toString().trim();
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
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
  await p.goto(B + url, { waitUntil: 'networkidle' });
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
// (aprovação, tela, chave, PIN, player).
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

console.log('== admin: ficha do ponto → tela, chave e PIN ==');
await irPara(adm, `rede/pontos/${pontoId}`);
await adm.waitForSelector('[data-nova-tela]');
check('ficha do ponto aguardando instalação', (await adm.textContent('.ficha-titulo')).includes('Aguardando instalação'));
check('sem tela ainda — mensagem certa', (await adm.textContent('#pontoTelas')).includes('Nenhuma tela'));
// "+ Adicionar tela": sem nome manual, sem chave, sem URL — o sistema gera.
await adm.click('[data-nova-tela]');
check('modal de tela nova sem "Nome da tela"', !(await adm.$('dialog.modal-admin[open] #novaTelaApelido')));
await adm.click('dialog.modal-admin[open] button[type=submit]');
await adm.waitForSelector('.tela-ficha');
check('tela criada: Tela 1, Ativa, aguardando primeiro sinal', /Tela 1[\s\S]*Ativa[\s\S]*Aguardando primeiro sinal/.test(await adm.textContent('.tela-ficha-topo')));
// compat-v1: TV com o player de navegador recebe a chave num link, uma vez.
await adm.click('.ficha-avancado summary');
await adm.click('[data-acao="chave-legada"]');
await adm.click('dialog.modal-admin[open] [data-confirmar]');
const campoLink = adm.locator('dialog.modal-admin[open] #linkPlayerCampo');
await campoLink.waitFor({ timeout: 8000 });
const linkPlayer = await campoLink.inputValue();
check('chave gerada e link do player mostrado', /player\.html\?tela=\d+&chave=/.test(linkPlayer), linkPlayer);
await adm.click('dialog.modal-admin[open] .modal-rodape [data-fechar]');
await adm.locator('dialog.modal-admin[open]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
// Espera a ficha refeita com a credencial nova (fingerprint "…XXXXXX").
await adm.locator('.tela-ficha code', { hasText: /^…[0-9A-F]{6}$/ }).first().waitFor({ timeout: 10000 }).catch(() => {});
check('ficha mostra só o fingerprint, nunca a chave', !(await adm.textContent('.tela-ficha')).includes(new URL(linkPlayer).searchParams.get('chave')));
await adm.click('[data-acao="pin"]');
await adm.locator('dialog.modal-admin[open] #pinTela').waitFor({ timeout: 5000 });
await adm.fill('dialog.modal-admin[open] #pinTela', '4321');
await adm.click('dialog.modal-admin[open] button[type=submit]');
// hasText não diferencia maiúsculas: "Não configurado" também casaria com
// "Configurado" — espera o texto que só existe depois de salvo.
await adm.locator('.tela-ficha', { hasText: /alterado agora/ }).waitFor({ timeout: 10000 }).catch(() => {});
check('PIN de manutenção configurado', /Configurado\s*alterado/.test(await adm.textContent('.tela-ficha')));
check('tela ativa sem sinal ainda não põe o ponto em operação', PG(`SELECT status FROM pontos WHERE id=${pontoId}`) === 'a_instalar');
await shot(adm, 'admin-telas');

console.log('== player + painel por PIN ==');
{
  const p = await pagina(linkPlayer.replace(/^https?:\/\/[^/]+/, ''), { width: 1920, height: 1080 });
  await p.waitForTimeout(1200);
  const msg = await p.textContent('#msg');
  check('player carregou a playlist (ok ou sem anúncios)', /playlist ok|sem anúncios/.test(msg), msg);
  check('heartbeat do boot é o primeiro sinal: ponto em operação', PG(`SELECT status FROM pontos WHERE id=${pontoId}`) === 'em_operacao');
  await p.keyboard.press('p'); await p.waitForTimeout(300);
  check('tecla P abre o painel da tela', !!(await p.$('.painel-tela')));
  // scrypt do PIN leva ~0,5–1 s — espera o texto, não um tempo fixo.
  await p.fill('#pin', '0000'); await p.click('#formPin button');
  await p.waitForFunction(() => document.getElementById('erroPin').textContent.includes('PIN'), null, { timeout: 8000 }).catch(() => {});
  check('PIN errado é recusado', (await p.textContent('#erroPin')).includes('PIN'));
  await p.fill('#pin', '4321'); await p.click('#formPin button');
  await p.waitForFunction(() => document.getElementById('conteudoPainel').textContent.includes('Exibições'), null, { timeout: 8000 }).catch(() => {});
  check('PIN certo mostra o painel', (await p.textContent('#conteudoPainel')).includes('Exibições em 30 dias'));
  await shot(p, 'player-painel');
  await p.close();
}

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
