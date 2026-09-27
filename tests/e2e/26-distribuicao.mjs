// Distribuição real (estação de 27/09/2026): escolha de pontos com o próprio
// ponto, primeira entrada no ar (Programado → Aguardando → No ar) e métricas
// da Mídia Mostraí — tudo pelos caminhos reais (painel, admin, contrato do
// Player: provisionar → GET /playlist → POST /played). Banco zerado,
// servidor na 3999, sem dado de produção:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/26-distribuicao.mjs
// Nenhum page.reload(): as páginas marcam `window.__semReload` e o roteiro
// confere que a marca sobrevive. "Próxima janela" é simulada recuando o
// início do contexto da peça (`aprovado_em`) em vez de esperar uma hora —
// sem relógio acelerado.
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const RAIZ = new URL('../..', import.meta.url).pathname;
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const falhas = [];
const erros = [];
let fase = 'início';
const etapa = (t) => {
  fase = t;
  console.log(t);
};
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (p, n) => p.screenshot({ path: `${SAIDA}distribuicao-${n}.png`, fullPage: true });
const IMAGEM = `${B}/img/exemplo-ponto-completo-720.jpg`;

// ---------------------------------------------------------------------------
// Rede de teste: 3 pontos 24 h (um é da própria conta), uma tela em cada
// ---------------------------------------------------------------------------
const email = `distribuicao-${Date.now()}@teste.com`;
await fetch(`${B}/anunciantes/cadastro`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nome_empresa: 'Padaria Distribuição',
    cpf_cnpj: '52998224725',
    contato_email: email,
    contato_telefone: '16999995555',
    senha: 'Senha123!',
    aceitou_termos: true,
    endereco: 'Rua Um, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
  }),
});
const CONTA = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
PG(
  `UPDATE anunciantes SET email_confirmado = true, plano_id = 'essencial-1m', data_inicio_cobertura = now(),
   data_expiracao = now() + interval '20 days' WHERE id = ${CONTA}`,
);
const H24 = JSON.stringify(
  Object.fromEntries(['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].map((d) => [d, { abre: '00:00', fecha: '24:00' }])),
);
function ponto(nome, dono = 'NULL') {
  const id = PG(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, horario_semanal, anunciante_id)
     VALUES ('${nome}', 'Rua Dois, 2', 'Matão', 'SP', '15990000', 'outro', 'R', '1', '${H24}'::jsonb, ${dono}) RETURNING id`,
  )
    .split('\n')[0]
    .trim();
  const tela = PG(`INSERT INTO dispositivos (ponto_id, apelido, status) VALUES (${id}, 'Tela 1', 'ativo') RETURNING id`)
    .split('\n')[0]
    .trim();
  return { id: Number(id), tela: Number(tela) };
}
const PROPRIO = ponto('Padaria Distribuição (loja)', CONTA);
// O cenário de produção: a conta e o ponto dela no MESMO ramo (a trava de
// ramo barrava o dono na própria tela).
const RAMO = PG('SELECT id FROM categorias WHERE ativo AND NOT legado ORDER BY id LIMIT 1');
PG(`UPDATE anunciantes SET categoria_id = ${RAMO} WHERE id = ${CONTA}`);
PG(`UPDATE pontos SET categoria_id = ${RAMO} WHERE id = ${PROPRIO.id}`);
const CENTRO = ponto('Mercado Centro');
const BAIRRO = ponto('Farmácia Bairro');

const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const ctxAdmin = await navegador.newContext({ viewport: { width: 1360, height: 900 } });
const ctxConta = await navegador.newContext({ viewport: { width: 1280, height: 900 } });

function vigiar(p, nome) {
  p.on('pageerror', (e) => erros.push(`[${nome} ${fase}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/net::|ERR_FAILED/.test(m.text())) return;
    // A tela de login do admin confere a sessão antes de entrar: o 401 é o
    // "ainda não logado", esperado.
    if (nome === 'admin' && fase === 'início' && /status of 401/.test(m.text())) return;
    erros.push(`[${nome} ${fase}] console: ${m.text()}`);
  });
  return p;
}
const marcarSemReload = (p) =>
  p.evaluate(() => {
    window.__semReload = true;
  });
const semReload = (p) => p.evaluate(() => window.__semReload === true);

// Admin: login pela tela.
const admin = vigiar(await ctxAdmin.newPage(), 'admin');
await admin.goto(`${B}/admin/index.html`);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('#conteudo .visao-geral-colunas');
await marcarSemReload(admin);
const api = (caminho, metodo = 'GET', corpo) =>
  admin.evaluate(
    async ({ caminho, metodo, corpo }) => {
      const r = await fetch(caminho, {
        method: metodo,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: corpo ? JSON.stringify(corpo) : undefined,
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    { caminho, metodo, corpo },
  );

// Um comprovante do Player (contrato §8): execucaoId novo por exibição.
const eventoDe = (i) => ({
  execucaoId: crypto.randomUUID(),
  janelaId: i.itemProgramacaoId.split('|').slice(0, 2).join('|'),
  itemProgramacaoId: i.itemProgramacaoId,
  criativoId: i.criativoId,
  iniciadoEm: new Date().toISOString(),
  terminadoEm: new Date().toISOString(),
});

// TVs instaladas pelo contrato do Player: código do admin → /player/provisionar.
etapa('== REDE: três TVs instaladas pelo contrato do Player ==');
await api('/admin/player/pin-saida', 'PUT', { pin: '482715' });
const player = async (p) => {
  const g = await api(`/admin/dispositivos/${p.tela}/codigo-instalacao`, 'POST');
  const r = await fetch(`${B}/player/provisionar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Player-Version': '1.2.0+12' },
    body: JSON.stringify({ codigoTela: g.json.codigoTela, codigoInstalacao: g.json.codigo }),
  });
  const cred = await r.json();
  const chamar = async (metodo, caminho, corpo) => {
    const resp = await fetch(`${B}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'X-Player-Version': '1.2.0+12', 'X-Aparelho-Key': cred.chaveAparelho },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: resp.status, json: await resp.json().catch(() => null) };
  };
  const enviar = (eventos) => chamar('POST', `/player/${cred.dispositivoId}/played`, { eventos });
  return {
    id: cred.dispositivoId,
    playlist: () => chamar('GET', `/playlist/${cred.dispositivoId}`),
    enviar,
    tocou: (itens) => enviar(itens.map(eventoDe)),
  };
};
const tvProprio = await player(PROPRIO);
const tvCentro = await player(CENTRO);
const tvBairro = await player(BAIRRO);
check(
  'os três pontos em operação depois da instalação',
  PG(`SELECT COUNT(*) FROM pontos WHERE id IN (${PROPRIO.id},${CENTRO.id},${BAIRRO.id}) AND status = 'em_operacao'`) === '3',
);

// ===========================================================================
etapa('== A: escolha de pontos com o próprio ponto ==');
const conta = vigiar(await ctxConta.newPage(), 'conta');
await irQuieto(conta, `${B}/anunciante/login.html`);
await conta.fill('#email', email);
await conta.fill('#senha', 'Senha123!');
await conta.click('button[type="submit"]');
await conta.waitForURL(/painel\.html/, { timeout: 10000 });
await conta.waitForSelector('#listaPontos .ponto-escolha', { timeout: 10000 });
await marcarSemReload(conta);
const linhaProprio = conta.locator(`.ponto-escolha[data-ponto-id="${PROPRIO.id}"]`);
check('o próprio ponto aparece na lista', (await linhaProprio.count()) === 1);
check('com o selo "Seu ponto"', (await linhaProprio.locator('.selo-seu-ponto').textContent()) === 'Seu ponto');
check('e o rótulo "Veicular no próprio ponto"', /Veicular no próprio ponto/.test(await linhaProprio.textContent()));
check(
  'e o texto de que é opcional',
  (await linhaProprio.textContent()).includes(
    'Este estabelecimento pertence à sua conta. Você pode incluí-lo na cobertura da campanha ou anunciar somente em outros pontos da rede.',
  ),
);
check('nunca vem marcado', !(await linhaProprio.locator('input').isChecked()));
check('destaque laranja (classe seu-ponto)', await linhaProprio.evaluate((el) => el.classList.contains('seu-ponto')));
check('contador "0 de 3 pontos selecionados"', (await conta.textContent('#contadorPontos')) === '0 de 3 pontos selecionados');
check(
  'modo automático explicado',
  (await conta.textContent('#explicaAutomatico')).includes(
    'Se você não escolher pontos, a Mostraí distribui sua campanha automaticamente entre os pontos disponíveis dentro da cobertura do seu plano.',
  ),
);
check('modo automático ativo', /Distribuição automática ativa/.test(await conta.textContent('#modoPontos')));
const linhaCentro = conta.locator(`.ponto-escolha[data-ponto-id="${CENTRO.id}"]`);
check('linha mostra estado operacional e horário', /Ativo/.test(await linhaCentro.textContent()) && /24h/.test(await linhaCentro.textContent()), await linhaCentro.textContent());
await shot(conta, 'pontos-antes');

await linhaProprio.locator('input').check();
await conta.waitForFunction(() => document.getElementById('msgPontos').textContent.includes('Salvo'));
await linhaCentro.locator('input').check();
await conta.waitForFunction(() => document.getElementById('contadorPontos').textContent === '2 de 3 pontos selecionados');
await conta.waitForFunction(() => /escolheu os pontos/.test(document.getElementById('modoPontos').textContent));
check('contador "2 de 3 pontos selecionados"', true);
check(
  'salvou no banco: próprio + centro',
  PG(`SELECT string_agg(ponto_id::text, ',' ORDER BY ponto_id) FROM anunciantes_pontos WHERE anunciante_id = ${CONTA}`) ===
    [PROPRIO.id, CENTRO.id].sort((a, b) => a - b).join(','),
);
await shot(conta, 'pontos-escolhidos');

// ===========================================================================
etapa('== B: aprovada → Programado → Aguardando → No ar ==');
const criativo = PG(
  `INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, thumbnail_url, duracao_segundos, status)
   VALUES (${CONTA}, '${IMAGEM}', '${IMAGEM}', '${IMAGEM}', 10, 'pendente') RETURNING id`,
)
  .split('\n')[0]
  .trim();
// A conta vê a peça em análise (SSE/resync), o admin aprova pela API do admin.
await conta.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const badge = () => conta.locator(`.criativo-card[data-id="${criativo}"] .badge`).textContent();
const explica = () => conta.locator(`.criativo-card[data-id="${criativo}"] .criativo-explica`).textContent();
await conta.waitForSelector(`.criativo-card[data-id="${criativo}"]`, { timeout: 10000 });
const aprovado = await api(`/admin/criativos/${criativo}`, 'PATCH', { status: 'aprovado' });
check('admin aprova', aprovado.status === 200, JSON.stringify(aprovado.json));
await conta.waitForFunction(
  (id) => /Programado/.test(document.querySelector(`.criativo-card[data-id="${id}"] .badge`)?.textContent || ''),
  criativo,
  { timeout: 10000 },
);
check('aprovada NÃO aparece "No ar": aparece "Programado"', (await badge()) === 'Programado', await badge());
check('com a primeira janela prevista (do servidor)', /Primeira exibição prevista: (hoje|amanhã), \d\d:00–\d\d:00/.test(await explica()), await explica());
const notif = PG(`SELECT descricao FROM notificacoes WHERE anunciante_id = ${CONTA} ORDER BY id DESC LIMIT 1`);
check('o aviso de aprovação não diz "já está no ar"', !/Já está no ar/.test(notif), notif);
await shot(conta, 'programado');

// Próxima janela: o contexto da peça começa antes desta hora.
PG(`UPDATE criativos SET aprovado_em = date_trunc('hour', now()) - interval '5 minutes' WHERE id = ${criativo}`);
// Programação: a TV do próprio ponto pede a playlist da hora (contrato real).
const pl = await tvProprio.playlist();
const itemDaConta = (pl.json?.itens || []).find((i) => String(i.anuncianteId) === CONTA);
check('a playlist da TV do próprio ponto traz a peça (dono no mesmo ponto)', !!itemDaConta, JSON.stringify(pl.json?.itens?.slice(0, 3)));
check('item contabiliza', itemDaConta?.contabiliza === true);
const plBairro = await tvBairro.playlist();
check('o ponto não escolhido não recebe a conta', !(plBairro.json?.itens || []).some((i) => String(i.anuncianteId) === CONTA));
// A pessoa volta pra aba: o painel relê (sem F5).
await conta.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await conta.waitForFunction(
  (id) => /Aguardando primeira exibição/.test(document.querySelector(`.criativo-card[data-id="${id}"] .badge`)?.textContent || ''),
  criativo,
  { timeout: 10000 },
);
check('depois da programação: "Aguardando primeira exibição"', true);

// Admin: indicador da Visão geral e a lista.
await admin.evaluate(() => {
  location.hash = 'visaogeral';
});
await admin.locator('#btnRecarregar').click();
await admin.waitForSelector('.entrada-indicadores');
const indicadores = await admin.textContent('.entrada-indicadores');
check('Visão geral: "Anúncios aguardando primeira exibição: 1"', /aguardando primeira exibição: 1/.test(indicadores), indicadores);
check('Visão geral: "Anúncios atrasados: 0"', /atrasados: 0/.test(indicadores), indicadores);
await admin.locator('.entrada-ind').first().click();
await admin.waitForSelector('.tabela-entrada', { timeout: 10000 });
check('lista útil: conta e estado', /Padaria Distribuição/.test(await admin.textContent('.tabela-entrada')));
await shot(admin, 'admin-entrada');

// Comprovante: a TV confirma a exibição — o painel vira "No ar" sozinho (SSE).
const primeiroEvento = eventoDe(itemDaConta);
const pop = await tvProprio.enviar([primeiroEvento]);
check('POP contabilizado', pop.json?.resultados?.[0]?.status === 'contabilizado', JSON.stringify(pop.json));
await conta.waitForFunction(
  (id) => document.querySelector(`.criativo-card[data-id="${id}"] .badge`)?.textContent === 'No ar',
  criativo,
  { timeout: 10000 },
);
check('"No ar" chegou por SSE, sem recarregar', await semReload(conta));
check('explicação cita exibição confirmada', /confirmada pela TV/.test(await explica()));
const repetido = await tvProprio.enviar([primeiroEvento]);
check('POP repetido (mesmo execucaoId) é duplicado', repetido.json?.resultados?.[0]?.status === 'duplicado');
check(
  'e não conta de novo',
  PG(`SELECT SUM(vezes_confirmadas) FROM exibicoes_contador WHERE anunciante_id = ${CONTA}`) === '1',
);
await shot(conta, 'no-ar');

// ===========================================================================
etapa('== C: Mídia Mostraí — plays simulados → métricas ==');
const midiaId = execSync(
  `node -e "
    const a = require('./src/anunciantes/repository');
    const c = require('./src/anunciantes/criativos-repository');
    const m = require('./src/midias/repository');
    (async () => {
      const conta = await a.ensureContaMostrai();
      const cr = await c.criar({ anunciante_id: conta.id, arquivo_original_url: '${IMAGEM}', arquivo_normalizado_url: '${IMAGEM}', thumbnail_url: '${IMAGEM}', duracao_segundos: 10 });
      await c.atualizar(cr.id, { status: 'aprovado' });
      const midia = await m.criar({ criativoId: cr.id, nomeInterno: 'Seja um ponto (e2e)', frequenciaHora: 2, coberturaTipo: 'pontos', pontosIds: [${BAIRRO.id}] });
      console.log(midia.id);
      process.exit(0);
    })();"`,
  { cwd: RAIZ, env: process.env },
)
  .toString()
  .trim()
  .split('\n')
  .pop();
await admin.evaluate(() => {
  location.hash = 'midiamostrai';
});
await admin.waitForSelector('.mm-item', { timeout: 10000 });
const card = () => admin.locator('.mm-item', { hasText: 'Seja um ponto (e2e)' });
check('card começa aguardando a primeira exibição', /aguardando primeira exibição/.test(await card().textContent()), await card().textContent());
check('0 exibições confirmadas', /0 exibições confirmadas/.test(await card().textContent()));

// A TV do bairro pede a hora e toca as duas inserções da mídia.
const plMidia = await tvBairro.playlist();
const itensMidia = (plMidia.json?.itens || []).filter((i) => i.itemProgramacaoId.endsWith(`|midia:${midiaId}`));
check('playlist traz 2 inserções da mídia, contabiliza=true', itensMidia.length === 2 && itensMidia.every((i) => i.contabiliza));
const popMidia = await tvBairro.tocou(itensMidia);
check('2 comprovantes contabilizados', popMidia.json?.resultados?.every((r) => r.status === 'contabilizado'), JSON.stringify(popMidia.json));
check('entrega comercial intocada', PG(`SELECT COUNT(*) FROM exibicoes_contador WHERE dispositivo_id = ${BAIRRO.tela}`) === '0');

await admin.locator('#btnRecarregar').click();
await admin.waitForFunction(() =>
  [...document.querySelectorAll('.mm-item')].some((el) => /2 exibições confirmadas/.test(el.textContent)),
);
const textoCard = await card().textContent();
check('card: "2 exibições confirmadas"', /2 exibições confirmadas/.test(textoCard), textoCard);
check('card: % da entrega esperada', /(\d+% da entrega esperada|sem entrega esperada ainda)/.test(textoCard), textoCard);
check('card: "Última: hoje HH:MM"', /Última: hoje \d\d:\d\d/.test(textoCard), textoCard);
check('card: reproduzindo normalmente', /reproduzindo normalmente/.test(textoCard), textoCard);
await card().locator('[data-editar-midia]').click();
await admin.waitForSelector('[data-mm-exibicoes]', { timeout: 10000 });
const detalhe = await admin.textContent('[data-mm-exibicoes]');
check('edição: programadas × confirmadas por período', /Programadas/.test(detalhe) && /Confirmadas/.test(detalhe) && /Esperadas/.test(detalhe));
check('edição: por tela (M-xxxx)', detalhe.includes(tvBairro.id), detalhe);
check('edição: por ponto', /Farmácia Bairro/.test(detalhe));
check('admin sem recarregar', await semReload(admin));
await shot(admin, 'midia-metricas');

await navegador.close();
console.log(`\nerros de console/página: ${erros.length}`);
for (const e of erros) console.log('  ', e);
if (falhas.length || erros.length) {
  console.log(`\n${falhas.length} FALHA(S)`);
  process.exit(1);
}
console.log('\nTUDO OK');
