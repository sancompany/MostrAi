// Painel único no navegador, como existe hoje (reescrito em 23/09/2026: o
// papel Vendedor foi aposentado e o bônus de tela/anúncio saiu na migration
// 046 — as checagens deles saíram junto, sem recriar nada).
//
// Parte A — conta que entra por convite de ponto, sem o papel anunciante:
// candidatura antiga (sem conta) → admin aprova na ficha e o convite sai num
// modal → cadastro pelo convite escolhendo a ajuda de custo → Meu ponto com o
// endereço aguardando instalação → troca da ajuda de custo por tela
// (regressão: carregarExtrato fora de escopo) → Painel com cadeado → card de
// ativação → modo anúncios ligado (sem plano, o painel pede um plano).
//
// Parte B — conta que só anuncia abre Meu ponto: card do modo com as opções
// de comodato → pedido enviado. (Aprovar a candidatura de uma conta que já
// existe fica no 03-navegador.mjs.)
//
// Assume banco zerado (tests/e2e/reset-db.sh) e servidor na 3999.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
// Primeira linha: com RETURNING o psql ainda imprime "INSERT 0 1" depois do valor.
const PG = (sql) =>
  execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .split('\n')[0]
    .trim();
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
// Admin e cada conta em contextos separados: o cookie de sessão é um só por
// contexto, e o cadastro regenera a sessão.
const ctxAdmin = await b.newContext({ viewport: { width: 1280, height: 900 } });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const falhas = []; const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => { console.log('  FALHA', t, d || ''); falhas.push(t); };
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
async function pagina(url, contexto = ctx) {
  const p = await contexto.newPage();
  p.on('pageerror', (e) => erros.push(`${url}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) erros.push(`${url} console: ${m.text()}`); });
  p.on('dialog', async (d) => d.accept(d.defaultValue()));
  await p.goto(B + url, { waitUntil: 'networkidle' });
  return p;
}
const shot = (p, n) => p.screenshot({ path: new URL(`./saida/v21-${n}.png`, import.meta.url).pathname, fullPage: true });

// ViaCEP é serviço de terceiro: o roteiro responde por ele (CEP geral de
// Matão, sem rua — como a resposta real), pra não depender de rede externa.
async function responderViaCep(contexto) {
  await contexto.route('https://viacep.com.br/**', (route) =>
    route.fulfill({
      headers: { 'Access-Control-Allow-Origin': '*' },
      json: { cep: '15990-000', logradouro: '', bairro: '', localidade: 'Matão', uf: 'SP' },
    }),
  );
}
await responderViaCep(ctx);

// O CEP preenche rua/bairro/cidade quando a busca volta (public/formulario.js)
// e sobrescreve o que já estiver digitado — espera a busca terminar antes de
// digitar a rua e o número, como a pessoa faz.
async function preencherEndereco(p, prefixo, rua, numero) {
  await p.fill(`#${prefixo}cep`, '15990-000');
  await p.locator(`#${prefixo}cep`).blur();
  await p.waitForFunction(
    (id) => !/Buscando/.test(document.getElementById(id).closest('form').querySelector('[data-cep-msg]').textContent),
    `${prefixo}cep`,
  );
  await p.fill(`#${prefixo}endereco`, rua);
  await p.fill(`#${prefixo}numero`, numero);
}

// Ramo/segmento é um campo de busca por cima do <select> escondido
// (public/formulario.js): digita e escolhe o resultado, como a pessoa faz.
async function escolherRamo(p, form, termo) {
  await p.fill(`${form} .categoria-busca`, termo);
  await p.locator(`${form} .categoria-resultados li[role=option]`).first().click();
}

// E-mail sem confirmar trava toda página da conta num modal (migration 061).
// Confirma pela API, como o 06, pra o modal não cobrir o que este roteiro testa.
async function confirmarEmail(p, email) {
  const codigo = PG(
    `SELECT t.codigo FROM tokens_confirmacao_email t JOIN anunciantes a ON a.id = t.anunciante_id WHERE a.contato_email = '${email}'`,
  );
  const r = await p.evaluate(
    async (codigo) =>
      (
        await fetch('/anunciantes/me/confirmar-email', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codigo }),
        })
      ).ok,
    codigo,
  );
  check(`e-mail ${email} confirmado`, r, codigo);
}

const adm = await pagina('/admin/', ctxAdmin);
await adm.fill('#usuario', 'admin'); await adm.fill('#senha', 'Admin12@teste'); await adm.click('#formLogin button[type=submit]');
await adm.waitForSelector('#app:not([hidden])');

console.log('== A. candidatura antiga (sem conta) → admin aprova → convite num modal ==');
// Candidatura sem conta é a de antes de 18/09/2026 (formulário público
// aposentado): ainda pode sobrar na fila, e aprovar ela é o que gera convite.
const idCand = PG(
  `INSERT INTO candidaturas (tipo, nome, nome_comercio, contato_telefone, contato_email, endereco, bairro, cidade, uf, cep, segmento, fluxo_estimado_mensal)
   VALUES ('ponto', 'Nina', 'Doceria Nina', '16994635946', 'nina@x.com', 'Rua Doce, 1', 'Centro', 'Matão', 'SP', '15990000', 'Confeitaria / Doceria', 900)
   RETURNING id`,
);
await adm.evaluate(() => {
  location.hash = 'rede/candidaturas';
});
const cardCand = adm.locator('.ponto-card', { hasText: 'Doceria Nina' });
await cardCand.waitFor({ timeout: 8000 });
check('candidatura aparece como card "Em análise"', (await cardCand.locator('.badge').textContent()) === 'Em análise');
await cardCand.click();
await adm.waitForSelector('[data-aprovar]');
const migalhaCand = await adm.textContent('.breadcrumb');
check('ficha abre com a migalha "Candidaturas / Doceria Nina"', migalhaCand.includes('Candidaturas') && migalhaCand.includes('Doceria Nina'), migalhaCand);
await adm.click('[data-aprovar]');
await adm.click('dialog.modal-admin[open] [data-confirmar]');
const campoConvite = adm.locator('dialog.modal-admin[open] #linkPlayerCampo');
await campoConvite.waitFor({ timeout: 8000 });
const linkConvite = (await campoConvite.inputValue()).replace(/^https?:\/\/[^/]+/, '');
check('aprovar candidatura sem conta gera o convite, com o link num modal', /^\/convite\.html\?t=/.test(linkConvite), linkConvite);
check('candidatura sai da fila como aprovada', PG(`SELECT status FROM candidaturas WHERE id=${idCand}`) === 'aprovada');
await shot(adm, 'admin-convite-gerado');
await adm.click('dialog.modal-admin[open] .modal-rodape [data-fechar]');

console.log('== A. cadastro pelo convite: conta só de ponto, com a ajuda de custo ==');
{
  const p = await pagina(linkConvite);
  await p.waitForSelector('#formConvite:not([hidden])');
  check('convite traz o nome e o e-mail da candidatura', (await p.textContent('#titulo')).includes('Nina') && (await p.inputValue('#contato_email')) === 'nina@x.com');
  check('convite de ponto não pede endereço comercial', await p.isHidden('#secaoEndereco'));
  const opcaoAjuda = p.locator('#escolhaPlano label.escolha', { has: p.locator('input[value="ajuda-custo"]') });
  await opcaoAjuda.waitFor({ timeout: 8000 });
  check('convite de ponto oferece as opções de comodato', (await p.locator('#escolhaPlano .escolha').count()) >= 2);
  await opcaoAjuda.click();
  await p.fill('#cpf_cnpj', '111.444.777-35'); await p.fill('#contato_telefone', '16 99463-5946');
  await p.fill('#senha', 'Senha12@'); await p.fill('#senha_confirma', 'Senha12@');
  await p.check('#aceitou_termos');
  await p.click('#formConvite button[type=submit]');
  await p.waitForURL('**/anunciante/ponto.html', { timeout: 8000 }).catch(() => {});
  // Deixa a página terminar de carregar antes do reload abaixo — recarregar
  // no meio aborta os fetches em voo, e cada um vira um erro de console.
  await p.waitForLoadState('networkidle');
  check('cadastro pelo convite cai no Meu ponto', p.url().includes('/anunciante/ponto.html'), p.url());
  check('conta nasce só com o papel de ponto', PG(`SELECT papeis::text FROM anunciantes WHERE contato_email='nina@x.com'`) === '{ponto}');
  await confirmarEmail(p, 'nina@x.com');
  await p.reload({ waitUntil: 'networkidle' });

  console.log('== A. Meu ponto: endereço aguardando instalação, sem tela ==');
  await p.locator('#pontosLista .ponto-card', { hasText: 'Doceria Nina' }).waitFor({ timeout: 8000 }).catch(() => {});
  const endereco = await p.textContent('#pontosLista');
  check('o endereço da candidatura aparece em "Meus endereços"', endereco.includes('Doceria Nina') && endereco.includes('Aguardando instalação'), endereco.slice(0, 200));
  check('ajuda de custo no rodapé do endereço', endereco.includes('Ajuda de custo'), endereco.slice(0, 200));
  check('sem tela ainda — mensagem certa', (await p.textContent('#telasLista')).includes('Nenhuma tela instalada ainda'));
  check('Painel com cadeado (conta sem o papel anunciante)', await p.$eval('#navDashboard', (e) => e.classList.contains('bloqueado')));
  await shot(p, 'ponto-liberado');

  console.log('== A. trocar ajuda de custo por tela (regressão: carregarExtrato fora de escopo) ==');
  // O bug: carregarExtrato() só existia dentro de carregar(), e este botão
  // chamava de fora — ReferenceError engolido pelo catch do próprio clique,
  // que sobrescrevia a mensagem de sucesso com "carregarExtrato is not
  // defined" mesmo a troca já tendo dado certo no servidor.
  await p.click('#btnTrocarPorTela');
  await p.waitForFunction(() => document.getElementById('msgTrocaComodato').textContent.trim() !== 'trocando...', null, {
    timeout: 8000,
  });
  const msgTroca = await p.textContent('#msgTrocaComodato');
  check('mensagem de sucesso, não o erro de escopo', msgTroca.includes('Pronto') && !msgTroca.includes('is not defined'), msgTroca);
  check('classe de sucesso, não de erro', await p.$eval('#msgTrocaComodato', (e) => e.className.includes(' ok')));
  check('ajuda de custo deixa de ser paga', Number(PG(`SELECT valor_pago_mensal FROM pontos WHERE nome='Doceria Nina'`)) === 0);
  await shot(p, 'ponto-trocou-por-tela');

  console.log('== A. Painel com cadeado → card de ativação → modo anúncios ==');
  await p.click('#navDashboard');
  await p.waitForURL('**/anunciante/painel.html');
  await p.waitForSelector('form.modo-card#formModo');
  check('dashboard de anúncios escondido', await p.$eval('#dashboardAnuncios', (e) => e.hidden));
  await shot(p, 'anuncios-bloqueado');
  await preencherEndereco(p, 'm_', 'Rua Doce', '1');
  await escolherRamo(p, '#formModo', 'Confeitaria');
  await p.click('#formModo button[type=submit]');
  // Ativar recarrega a página. Conta de ponto já tem plano pelo comodato (o
  // Básico, depois da troca acima), então o painel abre direto, com as horas
  // dele — sem o bloqueio de plano, que é de conta sem plano nenhum (06).
  const kpiHoras = p.locator('#kpiGrid [data-kpi="horas"]');
  await kpiHoras.waitFor({ timeout: 10000 }).catch(() => {});
  check('card de ativação some depois de ativar', !(await p.$('#formModo')));
  check('Painel sem cadeado', await p.$eval('#navDashboard', (e) => !e.classList.contains('bloqueado')));
  check(
    'painel abre com as horas do plano do comodato, sem bloqueio de plano',
    (await p.$eval('#dashboardAnuncios', (e) => !e.hidden)) && !(await p.$('#bloqueioPlano')) && /contratadas/.test(await kpiHoras.textContent()),
  );
  check('conta ganha o papel anunciante', PG(`SELECT 'anunciante' = ANY(papeis) FROM anunciantes WHERE contato_email='nina@x.com'`) === 't');
  await shot(p, 'anuncios-ativado');
  await p.close();
}

console.log('== B. conta que só anuncia abre Meu ponto: card do modo com as opções de comodato ==');
{
  const ctxB = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await responderViaCep(ctxB);
  const p = await pagina('/', ctxB);
  const conta = await p.evaluate(async () => (await (await fetch('/anunciantes/cadastro', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: 'Doceria Lia', cpf_cnpj: '390.533.447-05', endereco: 'Rua Lu, 5', cidade: 'Matão', uf: 'SP',
      cep: '15990-000', contato_email: 'lia@x.com', contato_telefone: '16 99463-5947', senha: 'Senha12@', aceitou_termos: true,
    }),
  })).json()));
  check('conta direta nasce só com anunciante', JSON.stringify(conta.papeis) === '["anunciante"]', JSON.stringify(conta));
  await confirmarEmail(p, 'lia@x.com');
  await p.goto(`${B}/anunciante/ponto.html`, { waitUntil: 'networkidle' });
  await p.locator('#modoEscolhaPlano .escolha').first().waitFor({ timeout: 8000 }).catch(() => {});
  check(
    'card do modo ponto com as opções de comodato',
    (await p.textContent('#formModo')).includes('Como você quer ser recompensado') && (await p.locator('#modoEscolhaPlano .escolha').count()) >= 2,
  );
  await shot(p, 'ponto-bloqueado');
  await p.fill('#m_nome_comercio', 'Doceria Lia');
  await preencherEndereco(p, 'm_', 'Rua Doce', '2');
  await escolherRamo(p, '#formModo', 'Confeitaria');
  await p.fill('#m_fluxo', '800');
  await p.click('#formModo button[type=submit]');
  await p.waitForFunction(() => document.body.textContent.includes('Pedido enviado'), null, { timeout: 8000 }).catch(() => {});
  check('depois do pedido mostra "Pedido enviado"', (await p.textContent('body')).includes('Pedido enviado'));
  check('candidatura de ponto gravada na conta', PG(`SELECT count(*) FROM candidaturas WHERE conta_id=${conta.id} AND tipo='ponto'`) === '1');
  await shot(p, 'ponto-pedido');
  await p.close();
}

console.log('\nerros de página:', erros.length ? erros : 'nenhum');
console.log('falhas:', falhas.length);
await b.close();
process.exit(falhas.length || erros.length ? 1 : 0);
