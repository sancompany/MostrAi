// Formulários de ponto (estação dos formulários de ponto, 28/09/2026): os
// dois pedidos que nascem em Meus pontos, na rota real do painel.
//   A — "Quero ser um ponto" (comércio da própria conta, "Enviar meu interesse");
//   B — "+ Cadastrar outro estabelecimento" ("Enviar pedido").
// Confere o layout (formulário ~65% e prévia ~35% fixa na rolagem no desktop;
// uma coluna no celular, prévia depois das ações), a validação embaixo do
// campo (sem balão do navegador — o segmento obrigatório escondido travava o
// envio em silêncio), CEP encontrado / não encontrado / erro, segmento pelo
// teclado, horário aberto/fechado, foto válida e recusada, clique duplo, erro
// do servidor com os dados preservados e Cancelar. Também o campo de segmento
// do cadastro público (mesma busca). Assume servidor na 3999 e o banco do
// .env (DATABASE_URL).
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const falhas = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d === undefined ? '' : JSON.stringify(d));
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8Dwn4GBgQEAFQMC/Q5x0bQAAAAASUVORK5CYII=',
  'base64',
);

const b = acompanharRede(
  await chromium.launch({
    executablePath: process.env.PW_CHROME,
    // Horário em 24 h, como o navegador de quem usa o site no Brasil mostra.
    args: ['--lang=pt-BR'],
  }),
);
const marca = Date.now();
const CATEGORIA = Number(PG("SELECT id FROM categorias WHERE ativo AND nome ILIKE 'Padaria%' ORDER BY id LIMIT 1"));

async function novaConta(sufixo, { comPedido }) {
  const ctx = await b.newContext();
  const email = `form-ponto-${sufixo}-${marca}@teste.com`;
  const r = await ctx.request.post(`${B}/anunciantes/cadastro`, {
    data: {
      nome_empresa: sufixo === 'a' ? 'Padaria Estrela do Bairro' : 'Oficina Sanches',
      cpf_cnpj: '52998224725',
      categoria_id: CATEGORIA,
      cep: '15990-000',
      logradouro: 'Avenida Habib Gabriel',
      numero: '1200',
      bairro: 'Centro',
      cidade: 'Matão',
      uf: 'SP',
      contato_email: email,
      contato_telefone: '(16) 99999-0001',
      senha: 'Senha@Forte1',
      aceitou_termos: true,
    },
  });
  if (r.status() !== 201) throw new Error(`cadastro ${r.status()} ${await r.text()}`);
  const id = Number(PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`));
  PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${id}`);
  if (comPedido) {
    const h = { abre: '09:00', fecha: '18:00' };
    const c = await ctx.request.post(`${B}/conta/modos/ponto/pedir`, {
      data: {
        nome_comercio: 'Oficina Sanches',
        cep: '15990-000',
        logradouro: 'Avenida Habib Gabriel',
        numero: '1200',
        bairro: 'Centro',
        cidade: 'Matão',
        uf: 'SP',
        fluxo_estimado_mensal: 1500,
        horario_semanal: { seg: h },
      },
    });
    if (c.status() !== 201) throw new Error(`pedido ${c.status()}`);
  }
  const estado = await ctx.storageState();
  await ctx.close();
  return { id, estado };
}

// ViaCEP falsa: 15990-000 existe, 99999-999 não existe, 11111-111 cai (rede).
async function abrirPainel(estado, largura, altura) {
  const ctx = await b.newContext({
    storageState: estado,
    viewport: { width: largura, height: altura },
    isMobile: largura < 800,
    hasTouch: largura < 800,
    locale: 'pt-BR',
  });
  await ctx.route('https://viacep.com.br/**', (route) => {
    const cep = route.request().url().match(/ws\/(\d+)/)?.[1];
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (cep === '15990000')
      return route.fulfill({
        headers,
        json: { logradouro: 'Rua Sinharinha Frota', bairro: 'Centro', localidade: 'Matão', uf: 'SP' },
      });
    if (cep === '99999999') return route.fulfill({ headers, json: { erro: true } });
    return route.abort();
  });
  const p = await ctx.newPage();
  const erros = [];
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() !== 'error') return;
    // Esperados: a ViaCEP derrubada de propósito, o 409 do pedido repetido e
    // o upload da foto (Supabase não existe neste ambiente).
    if (/viacep|ERR_FAILED|status of (409|500|502)|falha ao enviar foto/.test(t)) return;
    erros.push(`console: ${t}`);
  });
  p.on('dialog', (d) => {
    erros.push(`diálogo nativo: ${d.message()}`);
    d.dismiss().catch(() => {});
  });
  const pedidos = [];
  p.on('request', (r) => {
    if (r.method() === 'POST' && /\/(anunciantes\/me\/pontos|conta\/modos\/ponto\/pedir)$/.test(r.url())) pedidos.push(r.url());
  });
  await irQuieto(p, `${B}/anunciante/painel.html`);
  await p.waitForSelector('#modPontos:not([hidden])');
  return { ctx, p, erros, pedidos };
}

// Todo campo visível do formulário tem nome acessível (rótulo ligado ou aria-label).
async function camposSemNome(p, form) {
  return p.evaluate((sel) => {
    const campos = [...document.querySelectorAll(`${sel} input, ${sel} select, ${sel} textarea`)].filter(
      (c) => c.type !== 'file' && c.offsetParent,
    );
    return campos
      .filter(
        (c) =>
          !c.getAttribute('aria-label') &&
          !c.getAttribute('aria-labelledby') &&
          !(c.id && document.querySelector(`label[for="${c.id}"]`)),
      )
      .map((c) => c.id || c.name || c.className);
  }, form);
}

async function medirLayout(p) {
  return p.evaluate(() => {
    const r = (s) => document.querySelector(s)?.getBoundingClientRect();
    const layout = r('#pontosNovo .candidatura-layout');
    const form = r('#pontosNovo form');
    const lateral = r('#pontosNovo .candidatura-lateral');
    const acoes = r('#pontosNovo .candidatura-acoes');
    const ta = r('#pontosNovo textarea');
    const botoes = [...document.querySelectorAll('#pontosNovo .candidatura-acoes .btn')].map((x) =>
      Math.round(x.getBoundingClientRect().width),
    );
    return {
      rolagemX: document.documentElement.scrollWidth - innerWidth,
      pctForm: Math.round((form.width / layout.width) * 100),
      pctLateral: Math.round((lateral.width / layout.width) * 100),
      ladoALado: lateral.left >= form.right - 1,
      previaDepoisDasAcoes: lateral.top >= acoes.bottom - 1,
      posicao: getComputedStyle(document.querySelector('#pontosNovo .candidatura-lateral')).position,
      alturaTextarea: Math.round(ta.height),
      larguraForm: Math.round(form.width),
      botoes,
    };
  });
}

// ===========================================================================
console.log('== A. "Quero ser um ponto" (comércio da conta) — desktop 1440 ==');
const contaA = await novaConta('a', { comPedido: false });
{
  const { ctx, p, erros, pedidos } = await abrirPainel(contaA.estado, 1440, 900);
  await p.click('[data-acao="abrir-oportunidade"]');
  await p.waitForSelector('#formCardPonto');
  await p.waitForTimeout(400);
  check('abre na largura da página, fora da coluna lateral', !(await p.$('.area-lateral #formCardPonto')));
  check('título e foco no formulário', (await p.evaluate(() => document.activeElement?.id)) === 'tituloFormPonto');
  const m = await medirLayout(p);
  check('desktop: formulário ~65% (62–68)', m.pctForm >= 62 && m.pctForm <= 68, m);
  check('desktop: prévia ~35% (32–38) ao lado', m.ladoALado && m.pctLateral >= 32 && m.pctLateral <= 38, m);
  check('desktop: prévia fixa na rolagem (sticky)', m.posicao === 'sticky', m.posicao);
  check('observações com altura confortável', m.alturaTextarea >= 100, m.alturaTextarea);
  check('sem rolagem horizontal', m.rolagemX <= 0, m.rolagemX);
  check('todo campo tem rótulo', (await camposSemNome(p, '#formCardPonto')).length === 0, await camposSemNome(p, '#formCardPonto'));
  const comercio = await p.textContent('.comercio-da-conta');
  check('diz qual comércio vai no pedido', comercio.includes('Padaria Estrela do Bairro') && comercio.includes('Avenida Habib Gabriel, 1200'), comercio);
  await p.waitForFunction(() => document.querySelector('[data-preview-segmento]').textContent === 'Padaria', null, { timeout: 5000 }).catch(() => {});
  check(
    'prévia com o nome e o segmento da conta',
    (await p.textContent('[data-preview-nome]')) === 'Padaria Estrela do Bairro' &&
      (await p.textContent('[data-preview-segmento]')) === 'Padaria',
  );
  // Rolar até o horário: a prévia continua à vista, abaixo do cabeçalho fixo.
  await p.evaluate(() => document.querySelector('.form-bloco-horario').scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(300);
  const fixa = await p.evaluate(() => ({
    topo: document.querySelector('#pontosNovo .candidatura-lateral').getBoundingClientRect().top,
    cabecalho: document.querySelector('header.site').getBoundingClientRect().bottom,
  }));
  check('prévia fixa abaixo do cabeçalho do site', fixa.topo >= fixa.cabecalho && fixa.topo < 200, fixa);

  // Obrigatório faltando: erro embaixo do campo, foco nele, nada enviado.
  await p.click('#formCardPonto button[type=submit]');
  await p.waitForTimeout(300);
  check('movimento vazio: erro embaixo do campo', (await p.textContent('#cp_fluxo_erro').catch(() => '')).includes('pessoas'));
  check('movimento vazio: campo marcado e ligado ao erro', (await p.getAttribute('#cp_fluxo', 'aria-describedby'))?.includes('cp_fluxo_erro'));
  check('movimento vazio: foco no campo', (await p.evaluate(() => document.activeElement?.id)) === 'cp_fluxo');
  check('movimento vazio: nada enviado', pedidos.length === 0, pedidos);
  // Só dígitos entram; o erro some ao digitar.
  await p.fill('#cp_fluxo', '2.5a00');
  check('movimento: só dígitos', (await p.inputValue('#cp_fluxo')) === '2500', await p.inputValue('#cp_fluxo'));
  check('erro some ao corrigir', !(await p.$('#cp_fluxo_erro')));
  // Horário: fechar e reabrir; abertura igual ao fechamento é recusada.
  await p.check('[data-horario-dia="seg"] [data-horario-fechado]');
  check('Fechado desabilita os horários do dia', await p.$eval('#cp_h_seg_abre', (e) => e.disabled));
  await p.uncheck('[data-horario-dia="seg"] [data-horario-fechado]');
  check('desmarcar reabilita', !(await p.$eval('#cp_h_seg_abre', (e) => e.disabled)));
  await p.fill('#cp_h_ter_fecha', '09:00');
  await p.click('#formCardPonto button[type=submit]');
  await p.waitForTimeout(300);
  check('abertura = fechamento: erro na linha do dia', (await p.textContent('#cp_h_ter_abre_erro').catch(() => '')).includes('não podem ser iguais'));
  check('abertura = fechamento: nada enviado', pedidos.length === 0);
  await p.fill('#cp_h_ter_fecha', '18:00');
  await p.check('[data-horario-dia="sab"] [data-horario-fechado]');
  await p.fill('#cp_mensagem', 'Estacionamento na frente, fachada azul.');
  // Foto: arquivo que não é imagem é recusado; imagem entra com prévia.
  await p.setInputFiles('#cp_foto', { name: 'contrato.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  check('foto: arquivo que não é imagem é recusado', (await p.textContent('#cp_foto_aviso')).includes('imagem'));
  check('foto recusada não fica escolhida', (await p.$eval('#cp_foto', (e) => e.files.length)) === 0);
  await p.setInputFiles('#cp_foto', { name: 'fachada.png', mimeType: 'image/png', buffer: PNG });
  await p.waitForSelector('[data-foto-preview] img');
  check('foto: nome e prévia aparecem', (await p.textContent('[data-foto-legenda]')) === 'fachada.png');
  check('foto: aviso de erro some', await p.$eval('#cp_foto_aviso', (e) => e.hidden));
  await p.waitForSelector('[data-preview-foto] img');
  check('foto aparece no card da prévia', !!(await p.$('[data-preview-foto] img')));
  await p.screenshot({ path: `${SAIDA}form-ponto-A-1440.png`, fullPage: true });
  // Upload da foto respondido aqui (o Supabase não existe neste ambiente).
  await p.route('**/conta/modos/ponto/candidaturas/*/foto', (route) => route.fulfill({ json: { url: 'https://exemplo.test/f.jpg' } }));
  // Clique duplo: um pedido só.
  await p.dblclick('#formCardPonto button[type=submit]');
  await p.waitForSelector('#pontosNovo[hidden]', { state: 'attached', timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(500);
  check('clique duplo: um pedido só', pedidos.length === 1, pedidos);
  check('sucesso: formulário fecha', await p.evaluate(() => document.getElementById('pontosNovo').hidden));
  check('sucesso: aviso normal (foto foi junto)', (await p.textContent('#msgMeusPontos')).startsWith('Pedido enviado. A gente chama'));
  check('sucesso: card "Em análise" na lista', !!(await p.$('.estab-card.estado-em_analise')));
  check('sucesso: foco volta pra Meus pontos', (await p.evaluate(() => document.activeElement?.id)) === 'tituloMeusPontos');
  const cand = PG(
    `SELECT fluxo_estimado_mensal || '|' || coalesce(horario_semanal->>'sab', 'null') || '|' || (horario_semanal->'seg'->>'abre') || '|' || mensagem || '|' || segmento FROM candidaturas WHERE conta_id = ${contaA.id} AND tipo = 'ponto'`,
  );
  check('gravado: movimento, sábado fechado, horário, observação e segmento da conta', cand === '2500|null|09:00|Estacionamento na frente, fachada azul.|Padaria', cand);
  check('A desktop: sem erro de console/página/diálogo', erros.length === 0, erros);
  await ctx.close();
}

// ===========================================================================
console.log('== B. "Novo estabelecimento" — desktop 1440 ==');
const contaB = await novaConta('b', { comPedido: true });
{
  const { ctx, p, erros, pedidos } = await abrirPainel(contaB.estado, 1440, 900);
  await p.waitForSelector('#btnNovoPonto:not([hidden])');
  await p.click('#btnNovoPonto');
  await p.waitForSelector('#formNovoPonto .categoria-busca');
  check('título "Novo estabelecimento"', (await p.textContent('#tituloFormPonto')) === 'Novo estabelecimento');
  const m = await medirLayout(p);
  check('desktop: ~65/35 lado a lado', m.ladoALado && m.pctForm >= 62 && m.pctForm <= 68 && m.pctLateral >= 32, m);
  check('todo campo tem rótulo (inclusive a busca de segmento)', (await camposSemNome(p, '#formNovoPonto')).length === 0, await camposSemNome(p, '#formNovoPonto'));
  check(
    'prévia: vazio aparece como marcador, não como dado',
    await p.$eval('[data-preview-segmento]', (e) => e.classList.contains('is-placeholder')),
  );
  // Tudo vazio: um erro por obrigatório, foco no primeiro, resumo perto do botão.
  await p.click('#formNovoPonto button[type=submit]');
  await p.waitForTimeout(400);
  const errosCampo = await p.$$eval('#formNovoPonto .campo-erro:not([data-foto-erro])', (els) => els.map((e) => e.id));
  for (const id of ['np_nome_comercio', 'np_cep', 'np_logradouro', 'np_numero', 'np_bairro', 'np_categoria_id_busca', 'np_fluxo']) {
    check(`vazio: erro embaixo de ${id}`, errosCampo.includes(`${id}_erro`), errosCampo);
  }
  check('vazio: foco no primeiro campo (nome)', (await p.evaluate(() => document.activeElement?.id)) === 'np_nome_comercio');
  check('vazio: resumo perto do botão', (await p.textContent('#msgNovoPonto')) === 'Confira os campos marcados.');
  check('vazio: nada enviado (o segmento escondido não trava mais em silêncio)', pedidos.length === 0);
  await p.screenshot({ path: `${SAIDA}form-ponto-B-erros-1440.png` });
  // CEP: não encontrado, erro de consulta, encontrado.
  const estadoCep = async (cep) => {
    await p.fill('#np_cep', cep);
    await p.locator('#np_cep').blur();
    await p.waitForFunction(() => document.querySelector('[data-cep-msg]').dataset.estado !== 'consultando');
    await p.waitForTimeout(150);
    return p.$eval('[data-cep-msg]', (e) => [e.dataset.estado, e.textContent]);
  };
  check('CEP inexistente: "não encontrado"', (await estadoCep('99999-999'))[0] === 'nao-encontrado');
  check('CEP com a consulta fora do ar: "erro", com orientação', (await estadoCep('11111-111')).join(' ').includes('Não deu para consultar'));
  const achado = await estadoCep('15990-000');
  check('CEP válido: "encontrado" e endereço preenchido', achado[0] === 'encontrado' && (await p.inputValue('#np_logradouro')) === 'Rua Sinharinha Frota', achado);
  check('CEP válido: foco no número', (await p.evaluate(() => document.activeElement?.id)) === 'np_numero');
  check('CEP válido: erros de rua e bairro somem', !(await p.$('#np_logradouro_erro')) && !(await p.$('#np_bairro_erro')));
  await p.fill('#np_numero', '350');
  await p.fill('#np_nome_comercio', 'Filial Centro');
  check('prévia acompanha o nome', (await p.textContent('[data-preview-nome]')) === 'Filial Centro');
  // Segmento pelo teclado: setas + Enter. Editar o texto desfaz a escolha.
  await p.focus('#np_categoria_id_busca');
  await p.keyboard.type('padar');
  await p.keyboard.press('ArrowDown');
  check('segmento: opção destacada pelo teclado', !!(await p.$('.categoria-resultados li.ativo[aria-selected="true"]')));
  check(
    'segmento: combobox aponta a opção ativa',
    !!(await p.getAttribute('#np_categoria_id_busca', 'aria-activedescendant')),
  );
  await p.keyboard.press('Enter');
  check('segmento: Enter escolhe (sem enviar o formulário)', (await p.inputValue('#np_categoria_id')) === String(CATEGORIA) && pedidos.length === 0);
  check('segmento: prévia mostra o escolhido', (await p.textContent('[data-preview-segmento]')) === 'Padaria');
  await p.keyboard.press('Backspace');
  check('segmento: editar o texto desfaz a escolha', (await p.inputValue('#np_categoria_id')) === '');
  await p.fill('#np_categoria_id_busca', 'Padaria');
  await p.locator('#formNovoPonto .categoria-resultados li[role=option]').first().click();
  check('segmento: clique escolhe', (await p.inputValue('#np_categoria_id')) === String(CATEGORIA));
  await p.fill('#np_fluxo', '1800');
  // Cancelar: fecha sem enviar e sem perguntar (não havia confirmação antes).
  await p.click('#formNovoPonto [data-acao="fechar-form"]');
  await p.waitForTimeout(400);
  check('Cancelar fecha sem enviar', (await p.evaluate(() => document.getElementById('pontosNovo').hidden)) && pedidos.length === 0);
  check('Cancelar devolve o foco pra Meus pontos', (await p.evaluate(() => document.activeElement?.id)) === 'tituloMeusPontos');
  // De novo, com o endereço que JÁ tem pedido: o servidor recusa (409) e o
  // formulário fica como estava.
  await p.click('#btnNovoPonto');
  await p.waitForSelector('#formNovoPonto .categoria-busca');
  await p.fill('#np_nome_comercio', 'Oficina Sanches');
  await p.fill('#np_cep', '15990-000');
  await p.fill('#np_logradouro', 'Avenida Habib Gabriel');
  await p.fill('#np_numero', '1200');
  await p.fill('#np_bairro', 'Centro');
  await p.fill('#np_categoria_id_busca', 'Padaria');
  await p.locator('#formNovoPonto .categoria-resultados li[role=option]').first().click();
  await p.fill('#np_fluxo', '900');
  await p.click('#formNovoPonto button[type=submit]');
  await p.waitForFunction(() => document.querySelector('#msgNovoPonto').classList.contains('err'), null, { timeout: 8000 }).catch(() => {});
  check('erro do servidor: mensagem perto do botão', (await p.textContent('#msgNovoPonto')).length > 5, await p.textContent('#msgNovoPonto'));
  check('rua digitada enquanto o CEP consultava não foi apagada', (await p.inputValue('#np_logradouro')) === 'Avenida Habib Gabriel', await p.inputValue('#np_logradouro'));
  check('erro do servidor: dados preservados', (await p.inputValue('#np_nome_comercio')) === 'Oficina Sanches' && (await p.inputValue('#np_fluxo')) === '900');
  check('erro do servidor: botão volta a funcionar', await p.$eval('#formNovoPonto button[type=submit]', (e) => !e.disabled && e.textContent === 'Enviar pedido'));
  // Pedido válido, com foto — o upload falha de verdade aqui (sem Supabase):
  // o pedido vale e a pessoa fica sabendo que a foto não foi.
  await p.fill('#np_nome_comercio', 'Filial Centro');
  await p.fill('#np_numero', '350');
  await p.setInputFiles('#np_foto', { name: 'loja.png', mimeType: 'image/png', buffer: PNG });
  const antes = pedidos.length;
  await p.dblclick('#formNovoPonto button[type=submit]');
  await p.waitForFunction(() => document.getElementById('pontosNovo').hidden, null, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(400);
  check('clique duplo: um pedido só', pedidos.length === antes + 1, pedidos);
  check('foto que não subiu: pedido vale e o aviso diz', (await p.textContent('#msgMeusPontos')).includes('a foto não foi junto'));
  const novo = PG(
    `SELECT nome_comercio || '|' || logradouro || ', ' || numero || '|' || segmento || '|' || fluxo_estimado_mensal FROM candidaturas WHERE conta_id = ${contaB.id} AND nome_comercio = 'Filial Centro'`,
  );
  check('gravado: nome, endereço, segmento e movimento', novo === 'Filial Centro|Avenida Habib Gabriel, 350|Padaria|900', novo);
  check('B desktop: sem erro de console/página/diálogo', erros.length === 0, erros);
  await ctx.close();
}

// ===========================================================================
console.log('== celular 390 e tablet 768: uma coluna, sem estouro ==');
for (const [largura, altura] of [
  [390, 844],
  [768, 1024],
]) {
  const { ctx, p, erros } = await abrirPainel(contaB.estado, largura, altura);
  await p.waitForSelector('#btnNovoPonto:not([hidden])');
  await p.click('#btnNovoPonto');
  await p.waitForSelector('#formNovoPonto .categoria-busca');
  const m = await medirLayout(p);
  check(`${largura}: uma coluna`, !m.ladoALado, m);
  check(`${largura}: prévia depois das ações`, m.previaDepoisDasAcoes, m);
  check(`${largura}: prévia não fica fixa`, m.posicao !== 'sticky', m.posicao);
  check(`${largura}: sem rolagem horizontal`, m.rolagemX <= 0, m.rolagemX);
  if (largura < 500) check('celular: botões um embaixo do outro, na largura toda', m.botoes.every((w) => w >= m.larguraForm - 2), m);
  const vaza = await p.evaluate(() => {
    const f = document.querySelector('#pontosNovo').getBoundingClientRect();
    return [...document.querySelectorAll('#pontosNovo input, #pontosNovo label, #pontosNovo button, #pontosNovo textarea')]
      .filter((x) => x.offsetParent && x.getBoundingClientRect().right > f.right + 1)
      .map((x) => x.id || x.textContent.trim());
  });
  check(`${largura}: nenhum campo passa da borda`, vaza.length === 0, vaza);
  await p.screenshot({ path: `${SAIDA}form-ponto-B-${largura}.png`, fullPage: true });
  check(`${largura}: sem erro de console/página`, erros.length === 0, erros);
  await ctx.close();
}
{
  const contaC = await novaConta('c', { comPedido: false });
  const { ctx, p, erros } = await abrirPainel(contaC.estado, 390, 844);
  await p.click('[data-acao="abrir-oportunidade"]');
  await p.waitForSelector('#formCardPonto');
  const m = await medirLayout(p);
  check('A no celular: uma coluna, prévia depois das ações, sem estouro', !m.ladoALado && m.previaDepoisDasAcoes && m.rolagemX <= 0, m);
  const linha = await p.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return { dia: r('[data-horario-dia="seg"] .horario-dia-nome').top, fechado: r('[data-horario-dia="seg"] .horario-dia-fechado').top, abre: r('#cp_h_seg_abre').top };
  });
  check('horário no celular: dia e "Fechado" em cima, horários embaixo', Math.abs(linha.dia - linha.fechado) < 16 && linha.abre > linha.dia + 10, linha);
  await p.screenshot({ path: `${SAIDA}form-ponto-A-390.png`, fullPage: true });
  check('A celular: sem erro de console/página', erros.length === 0, erros);
  await ctx.close();
}

// ===========================================================================
console.log('== cadastro público: o segmento obrigatório não trava mais em silêncio ==');
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR' });
  const p = await ctx.newPage();
  await irQuieto(p, `${B}/anunciante/cadastro.html`);
  await p.waitForSelector('.categoria-busca');
  const estado = await p.evaluate(() => {
    const sel = document.querySelector('select[data-categorias]');
    const busca = document.querySelector('.categoria-busca');
    return {
      selectObrigatorio: sel.required,
      buscaInvalida: !busca.checkValidity(),
      mensagem: busca.validationMessage,
      rotulo: !!document.querySelector(`label[for="${busca.id}"]`),
    };
  });
  check('a exigência está no campo visível, com rótulo', !estado.selectObrigatorio && estado.buscaInvalida && estado.rotulo, estado);
  check('a mensagem diz o que fazer', estado.mensagem.includes('Escolha uma opção da lista'), estado.mensagem);
  await ctx.close();
}

await b.close();
console.log(falhas.length ? `\n${falhas.length} falha(s): ${JSON.stringify(falhas, null, 1)}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
