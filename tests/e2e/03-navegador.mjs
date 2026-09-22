// Fluxo v3 no navegador, contra o servidor local real (porta 3999): conta
// direta nasce anunciante → pede o modo ponto pelo painel → admin libera
// direto na conta → painel do ponto; convite manual de vendedor (sem
// candidatura) → painel do vendedor; planos, player + PIN, abas do admin.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) => execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`).toString().trim();
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
// Admin e usuários em contextos separados: o cookie de sessão é um só por
// navegador, e o cadastro por convite regenera a sessão (derrubaria o admin).
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
  // 401/404 esperados (sem login, convite usado, PIN errado) não contam.
  p.on('console', (m) => { if (m.type() === 'error' && !/status of (401|404)/.test(m.text())) erros.push(`${url} console: ${m.text()}`); });
  p.on('dialog', async (d) => { d.type() === 'prompt' ? await d.accept(d.defaultValue()) : await d.accept(); });
  await p.goto(B + url, { waitUntil: 'networkidle' });
  return p;
}
async function abaAdmin(adm, nome, esperado) {
  // Vai pelo hash antigo (não pelo clique no menu): desde o redesenho de
  // 21/09/2026 os itens do menu viram módulo (data-modulo), não mais aba
  // solta — e o hash antigo é exatamente o que a compatibilidade promete
  // continuar abrindo. Ver ALIASES_ANTIGOS em public/admin/index.page.js.
  await adm.evaluate((h) => {
    location.hash = h;
  }, nome);
  await adm.waitForFunction((t) => document.getElementById('conteudo').textContent.includes(t), esperado, { timeout: 8000 }).catch(() => {});
  await adm.waitForTimeout(200);
}
async function shot(p, nome) { await p.screenshot({ path: new URL(`./saida/v2-${nome}.png`, import.meta.url).pathname, fullPage: true }); }

console.log('== conta direta (Farmácia Central) nasce anunciante; pede o modo ponto pelo painel ==');
// Sem candidatura sem conta e sem convite pra isso (aposentado 18/09/2026):
// a conta nasce normal e pede o modo de dentro do painel — a interação com
// o FORMULÁRIO desse pedido (campos, opções de comodato) já é coberta a
// fundo por 05-navegador-modos.mjs; aqui só falta ter uma conta com ponto
// pra alimentar o resto deste arquivo (telas, chave, PIN, player).
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

console.log('== admin: candidaturas → libera direto na conta ==');
const adm = await pagina('/admin/', null, ctxAdmin);
await adm.fill('#usuario', 'admin'); await adm.fill('#senha', 'Admin12@teste'); await adm.click('#formLogin button[type=submit]');
await adm.waitForSelector('#app:not([hidden])');
await adm.waitForTimeout(600);
// Visão geral simplificada (21/09/2026, pedido do dono): só receita recorrente,
// alcance da rede, anunciantes novos e pontos por status — custos/margem/
// amortização/pontos ativos/exibições/faturamento/anunciantes por situação saíram.
check('visão geral mostra receita recorrente', (await adm.textContent('#conteudo')).includes('Receita recorrente'));
check('alerta de candidaturas novas', (await adm.textContent('#conteudo')).includes('candidatura'));
await shot(adm, 'admin-resumo');
await abaAdmin(adm, 'candidaturas', 'Farmácia Central');
check('aba candidaturas lista a farmácia, pedido do painel', (await adm.textContent('#conteudo')).includes('Farmácia Central') && (await adm.textContent('#conteudo')).includes('pedido do painel'));
await shot(adm, 'admin-candidaturas');
await adm.locator('tr', { hasText: 'Farmácia Central' }).first().locator('[data-liberar]').click();
await adm.waitForTimeout(800);
check('candidatura liberada direto na conta, sem convite', (await adm.textContent('#conteudo')).includes('Liberado na conta'));
await shot(adm, 'admin-candidaturas-liberada');

console.log('== admin: telas (chave + PIN) ==');
await abaAdmin(adm, 'telas', 'Farmácia Central');
check('aba telas lista a tela da farmácia', (await adm.textContent('#conteudo')).includes('Farmácia Central'), (await adm.textContent('#conteudo')).slice(0, 300) + ' | hash=' + adm.url() + ' | erros=' + JSON.stringify(erros));
let linkPlayer = null;
adm.removeAllListeners('dialog');
adm.on('dialog', async (d) => {
  if (d.type() === 'prompt' && /PIN/.test(d.message())) return d.accept('4321');
  if (d.type() === 'prompt') { linkPlayer = d.defaultValue(); return d.accept(); }
  return d.accept();
});
const linhaFarm = adm.locator('tr', { hasText: 'Farmácia Central' }).first();
await linhaFarm.locator('[data-chave]').click(); await adm.waitForTimeout(800);
check('chave gerada e link do player mostrado', !!linkPlayer && /player\.html\?tela=\d+&chave=/.test(linkPlayer), linkPlayer);
await adm.locator('tr', { hasText: 'Farmácia Central' }).first().locator('[data-pin]').click();
// Espera o SELO aparecer, não um relógio. O clique dispara renderTelas(), que
// refaz a linha inteira depois de duas chamadas de rede; com 800ms fixos o
// teste falhava de vez em quando sem nada estar quebrado no produto.
const seloPin = adm.locator('tr', { hasText: 'Farmácia Central' }).first().locator('.badge', { hasText: 'definido' });
await seloPin.waitFor({ timeout: 10000 }).catch(() => {});
check('PIN definido', (await adm.locator('tr', { hasText: 'Farmácia Central' }).first().textContent()).includes('definido'));
await shot(adm, 'admin-telas');

// ativa ponto + tela pra playlist responder
const telaId = Number(new URL(linkPlayer).searchParams.get('tela'));
const pontoId = Number(PG(`select ponto_id from dispositivos where id=${telaId}`));
PG(`update pontos set status='em_operacao' where id=${pontoId}`);

console.log('== player + painel por PIN ==');
{
  const p = await pagina(linkPlayer.replace(/^https?:\/\/[^/]+/, ''), { width: 1920, height: 1080 });
  await p.waitForTimeout(1200);
  const msg = await p.textContent('#msg');
  check('player carregou a playlist (ok ou sem anúncios)', /playlist ok|sem anúncios/.test(msg), msg);
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

console.log('== vendedor: convite manual (sem candidatura) → painel de vendas ==');
// Vendedor não tem pedido self-service (aposentado 18/09/2026): quem quer
// ser vendedor fala direto com o dono, que gera o convite à mão — sem
// candidatura nenhuma por trás. Mesmo padrão de "+ Novo convite (sem
// candidatura)" que já existe na aba Convites do admin.
const rConvVend = await adm.evaluate(async () =>
  (
    await (
      await fetch('/admin/convites', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ papeis: ['vendedor'], nome_sugerido: 'Marcos' }),
      })
    ).json()
  ),
);
const linkVend = rConvVend.link ? rConvVend.link.replace(/^https?:\/\/[^/]+/, '') : null;
check('convite de vendedor gerado à mão, sem candidatura', !!linkVend, JSON.stringify(rConvVend));
{
  // Contexto novo: a Carla continua logada no `ctx`, e convite aberto por
  // conta logada agora oferece "liberar na minha conta" em vez do formulário.
  const ctxVend = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await pagina(linkVend.replace(/^https?:\/\/[^/]+/, ''), null, ctxVend);
  await p.waitForSelector('#formConvite:not([hidden])');
  check('seção de Pix visível pra vendedor', !(await p.$eval('#secaoPix', (e) => e.hidden)));
  await p.fill('#cpf_cnpj', '529.982.247-25'); await p.fill('#contato_telefone', '16 98888-2222'); await p.fill('#chave_pix', 'marcos@pix');
  await p.fill('#contato_email', 'marcos@x.com'); await p.fill('#senha', 'Senha12@'); await p.fill('#senha_confirma', 'Senha12@');
  await p.check('#aceitou_termos'); await p.click('button[type=submit]');
  await p.waitForURL('**/anunciante/vendedor.html', { timeout: 8000 }).catch(() => {});
  check('vendedor cai no painel de vendas', p.url().includes('/anunciante/vendedor.html'), p.url());
  await p.waitForTimeout(800);
  const t = await p.textContent('body');
  check('painel mostra cupom e link', t.includes('Seu cupom') && t.includes('cadastro.html?ref='), t.slice(0, 120));
  check('menu mostra Vendas', await p.$eval('#navVendas', (e) => !e.hidden));
  await shot(p, 'vendedor');
  await p.close();
}
await abaAdmin(adm, 'vendedores', 'Marcos');
check('aba vendedores lista Marcos com cupom', (await adm.textContent('#conteudo')).includes('Marcos') && await adm.$eval('#conteudo input[data-vendedor="chave_pix"]', (e) => e.value === 'marcos@pix'));

console.log('== planos: vitrine e admin ==');
{
  const p = await pagina('/planos.html');
  await p.waitForTimeout(600);
  check('grade normal continua com 3 planos', (await p.$$('#plansGrid .plan-card')).length === 3);
  await shot(p, 'planos');
  await p.close();
}
await abaAdmin(adm, 'planos', 'Desconto comodato');
{
  const t = await adm.textContent('#conteudo');
  check('admin planos tem coluna de desconto comodato', t.includes('Desconto comodato'));
}
await abaAdmin(adm, 'anunciantes', 'Marcar parceiro');
check('admin anunciantes tem ação de marcar parceiro', (await adm.textContent('#conteudo')).includes('Marcar parceiro'));
await abaAdmin(adm, 'custos', 'DAS MEI');
check('aba custos lista DAS MEI', (await adm.textContent('#conteudo')).includes('DAS MEI'));
await shot(adm, 'admin-custos');
await abaAdmin(adm, 'anunciantes', 'Dono de ponto');
check('anunciantes mostra badge de papel', (await adm.textContent('#conteudo')).includes('Dono de ponto'));

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
