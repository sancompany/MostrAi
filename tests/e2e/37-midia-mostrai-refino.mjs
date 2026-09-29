// Refino operacional da Mídia Mostraí (29/09/2026): a página cuida só do
// conteúdo próprio. Aqui, pelo navegador e pelo upload de verdade (FFmpeg):
// indicadores das mídias (ativas, agendadas, pausadas, com atraso), vídeo
// institucional compacto, cards em pé com preview em cima, exclusão só fora
// do ar e com modal (lógica — a linha fica), formulário de criação/edição com
// resumo e capacidade projetada por ponto, QR compacto na Visão geral,
// capacidade de veiculação na ficha do ponto (e não na da tela), grade em 8
// larguras sem rolagem lateral e sem erro de console.
// Banco zerado (o roteiro sobe o servidor com STORAGE_CAPTURA):
//   tests/e2e/reset-db.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/37-midia-mostrai-refino.mjs
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const RAIZ = new URL('../..', import.meta.url).pathname;
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const STORAGE = `${SAIDA}storage-37`;
const FIX = `${SAIDA}midia-fixtures`;
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const falhas = [];
const erros = [];
let fase = 'início';
let esperado409 = false;
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
const shot = (alvo, n, opts = {}) => alvo.screenshot({ path: `${SAIDA}37-${n}.png`, ...opts });

// ---------------------------------------------------------------------------
etapa('peças de teste (FFmpeg) e servidor');
mkdirSync(FIX, { recursive: true });
const ff = (args, saida) => execSync(`ffmpeg -loglevel error -y ${args} "${FIX}/${saida}"`);
ff('-f lavfi -i "color=c=0xff7a1a:s=1080x1920" -frames:v 1', 'cafe-da-manha.png');
ff('-f lavfi -i "color=c=0x2a78d6:s=1080x1920" -frames:v 1', 'institucional-loja.png');
ff('-f lavfi -i "color=c=0x1baf7a:s=1080x1920" -frames:v 1', 'campanha-antiga.png');
ff('-f lavfi -i "color=c=0x5b6472:s=1080x1920" -frames:v 1', 'aviso-horario.png');
ff('-f lavfi -i "color=c=0x1d4ed8:s=1920x1080" -frames:v 1', 'banner-deitado.png');
// Vídeo escolhido no formulário em WebM: o Chromium dos testes é o aberto,
// sem H.264 — um .mp4 local nem carregaria os metadados nele (no Chrome de
// verdade carrega). O servidor normaliza pra MP4 do mesmo jeito.
ff('-f lavfi -i "testsrc2=s=720x1280:r=25" -t 7 -c:v libvpx-vp9 -b:v 300k', 'seja-um-ponto.webm');
ff('-f lavfi -i "testsrc2=s=360x640:r=10" -t 60 -c:v libvpx-vp9 -b:v 100k', 'longo-60s.webm');
ff('-f lavfi -i "smptebars=s=720x1280:r=25" -t 15 -pix_fmt yuv420p -c:v libx264', 'institucional.mp4');
execSync(`bash ${RAIZ}tests/e2e/restart.sh STORAGE_CAPTURA=${STORAGE}`);
// O vídeo institucional enviado aqui aponta pro storage de captura; ao fim, a
// configuração volta ao que era (os outros roteiros não servem /e2e-storage).
const VIDEO_ANTES = PG(`SELECT valor FROM configuracoes_site WHERE chave = 'video_institucional'`);

// Rede: dois pontos em operação, 24 h, cada um com uma tela ativa; um
// anunciante com plano escolheu o San & Co (pra ter parte comercial usada).
const H24 = JSON.stringify(
  Object.fromEntries(['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].map((d) => [d, { abre: '00:00', fecha: '24:00' }])),
);
function ponto(nome) {
  const id = Number(
    PG(
      `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, horario_semanal, status)
       VALUES ('${nome}', 'Rua Dois, 2', 'Matão', 'SP', '15990000', 'outro', 'R', '1', '${H24}'::jsonb, 'em_operacao') RETURNING id`,
    ).split('\n')[0],
  );
  const tela = Number(
    PG(`INSERT INTO dispositivos (ponto_id, apelido, status) VALUES (${id}, 'Tela 1', 'ativo') RETURNING id`).split(
      '\n',
    )[0],
  );
  return { id, tela };
}
const SAN = ponto('San & Co');
const PADARIA = ponto('Padaria Central');
const ANUNCIANTE = Number(
  PG(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, email_confirmado, plano_id, data_inicio_cobertura, data_expiracao)
     VALUES (now(), 'Loja Comercial', '52998224725', 'loja-37-${Date.now()}@teste.com', '16999990000', 'x', true, 'essencial-1m', now(), now() + interval '20 days') RETURNING id`,
  ).split('\n')[0],
);
PG(`INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES (${ANUNCIANTE}, ${SAN.id})`);

const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const ctx = await navegador.newContext({ viewport: { width: 1440, height: 900 } });
// O arquivo normalizado foi pra STORAGE_CAPTURA; o navegador o busca de lá.
await ctx.route('**/e2e-storage/**', (rota) =>
  rota.fulfill({ path: path.join(STORAGE, path.basename(new URL(rota.request().url()).pathname)) }),
);
const p = await ctx.newPage();
p.on('pageerror', (e) => erros.push(`[${fase}] pageerror: ${e.message}`));
p.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (fase === 'login' && /status of 401/.test(m.text())) return;
  if (esperado409 && /status of 409/.test(m.text())) return;
  erros.push(`[${fase}] console: ${m.text()}`);
});

etapa('login');
await irQuieto(p, `${B}/admin/index.html`);
await p.fill('#usuario', process.env.ADMIN_USER || 'admin');
await p.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await p.click('#formLogin button[type=submit]');
await p.waitForSelector('#conteudo .visao-geral-colunas');

const irMidia = async () => {
  await p.evaluate(() => {
    location.hash = 'midiamostrai';
  });
  await p.waitForSelector('[data-mm-vi]');
};
const recarregar = async () => {
  await p.click('#btnRecarregar');
  await p.waitForSelector('[data-mm-vi]');
  await p.waitForTimeout(300);
};
const kpi = async (chave) => Number(await p.textContent(`[data-kpi="${chave}"] b`));
const card = (nome) => p.locator('.mm-card', { hasText: nome });

// ---------------------------------------------------------------------------
etapa('== página vazia ==');
await irMidia();
check('estado vazio compacto', await p.isVisible('.mm-vazio'));
check('vazio chama pra criar', /Nenhuma mídia própria criada/.test(await p.textContent('.mm-vazio')));
check('vazio tem [+ Nova mídia]', await p.isVisible('.mm-vazio #btnNovaMidia'));
check('4 indicadores, todos zero', (await Promise.all(['ativas', 'agendadas', 'pausadas', 'atraso'].map(kpi))).every((n) => n === 0));
check('nada de rede nos indicadores', !/ponto/i.test(await p.textContent('.mm-kpis')));
check('sem QR na página', !(await p.isVisible('text=QR Code institucional')) && !(await p.$('#qrLink')));
check('sem Capacidade da rede', !(await p.isVisible('text=Capacidade da rede')));
check('fallback explicado', /cartão “este espaço pode ser do seu negócio”/.test(await p.textContent('[data-mm-vi]')));
await shot(p, 'vazio', { fullPage: true });

// ---------------------------------------------------------------------------
etapa('== vídeo institucional ==');
await p.setInputFiles('#viArquivo', `${FIX}/institucional.mp4`);
await p.waitForFunction(() => /Vídeo institucional atualizado/.test(document.getElementById('toast')?.textContent || ''), null, {
  timeout: 60000,
});
await p.waitForSelector('[data-mm-vi] video');
const vi = await p.textContent('[data-mm-vi]');
check('duração 15 s', /15 s/.test(vi), vi);
check('data de atualização', /atualizado em \d\d\/\d\d\/\d{4}/.test(vi), vi);
check('botão Trocar vídeo', /Trocar vídeo/.test(vi));
const alturaVi = await p.evaluate(() => document.querySelector('[data-mm-vi]').getBoundingClientRect().height);
check('bloco compacto (< 260 px de altura)', alturaVi < 260, `${alturaVi}px`);
check(
  'preview aponta pro vídeo salvo, com pôster',
  await p.evaluate(() => {
    const v = document.querySelector('[data-mm-vi] video');
    return /\/e2e-storage\/institucional\.mp4/.test(v.getAttribute('src')) && /institucional-thumb\.jpg/.test(v.getAttribute('poster'));
  }),
);
await shot(await p.$('[data-mm-vi]'), 'video-institucional');

// ---------------------------------------------------------------------------
async function abrirNova() {
  await p.click('#btnNovaMidia');
  await p.waitForSelector('#formMidia');
}
async function criar({ nome, arquivo, freq = 1, pontos = null, inicio = null, pausada = false }) {
  await abrirNova();
  await p.fill('#mmNome', nome);
  await p.setInputFiles('#mmArquivo', `${FIX}/${arquivo}`);
  await p.fill('#mmFreq', String(freq));
  if (pontos) {
    await p.click('label:has(input[name="cobertura_tipo"][value="pontos"])');
    for (const n of pontos) await p.click(`.mm-picker-card:has-text("${n}")`);
  }
  if (inicio) {
    await p.click('label.alternar:has(#mmAgendada)');
    await p.fill('#mmInicio', inicio);
  }
  if (pausada) await p.click('label.alternar:has(input[name="situacao_pausada"])');
  await p.waitForSelector('[data-mm-projecao]');
  await p.click('#formMidia button[type=submit]');
  await p.waitForFunction(() => /Mídia criada/.test(document.getElementById('toast')?.textContent || ''), null, {
    timeout: 60000,
  });
  await p.waitForSelector(`.mm-card:has-text("${nome}")`);
}

etapa('== criação: imagem, toda a rede ==');
await abrirNova();
await p.fill('#mmNome', 'Promoção Café da Manhã');
await p.setInputFiles('#mmArquivo', `${FIX}/cafe-da-manha.png`);
await p.waitForFunction(() => /vertical/.test(document.getElementById('mmPreviewInfo')?.textContent || ''));
const infoImg = await p.textContent('#mmPreviewInfo');
check('preview: imagem, 1080×1920, vertical, PNG', /Imagem/.test(infoImg) && /1080×1920 px/.test(infoImg) && /vertical/.test(infoImg) && /PNG/.test(infoImg), infoImg);
await p.fill('#mmFreq', '6');
await p.waitForFunction(() => /2 de 2/.test(document.querySelector('[data-mm-compativeis]')?.textContent || ''));
const resumo = await p.textContent('[data-mm-resumo]');
check('resumo: duração, frequência, cobertura', /10 s/.test(resumo) && /6 vezes\/hora/.test(resumo) && /Toda a rede/.test(resumo), resumo);
check('resumo: pontos compatíveis 2 de 2', /2 de 2/.test(resumo), resumo);
const proj = await p.textContent('[data-mm-projecao]');
check('capacidade projetada: os dois pontos, "Cabe normalmente"', /San & Co/.test(proj) && /Padaria Central/.test(proj) && (proj.match(/Cabe normalmente/g) || []).length === 2, proj);
check('capacidade projetada: quanto soma (+1,7% da hora)', /\+1,7% da hora na parte Mostraí/.test(proj), proj);
check('"Começar pausada" e "Período definido" presentes', (await p.isVisible('input[name="situacao_pausada"]')) || (await p.$('input[name="situacao_pausada"]')) !== null);
await shot(await p.$('.mm-editor'), 'form-criacao');
await p.click('#formMidia button[type=submit]');
await p.waitForFunction(() => /Mídia criada/.test(document.getElementById('toast')?.textContent || ''), null, {
  timeout: 60000,
});
await p.waitForSelector('.mm-card:has-text("Promoção Café da Manhã")');
check('card da mídia nova', true);
await shot(await p.$('.mm-grade'), 'grade-1-midia');

etapa('== formulário: peça deitada e peça que não cabe ==');
await abrirNova();
await p.setInputFiles('#mmArquivo', `${FIX}/banner-deitado.png`);
await p.waitForFunction(() => /horizontal/.test(document.getElementById('mmPreviewInfo')?.textContent || ''));
check('peça deitada: avisa as faixas', /em pé \(9:16\)/.test(await p.textContent('#mmPreviewInfo')));
await p.setInputFiles('#mmArquivo', `${FIX}/longo-60s.webm`);
await p.waitForFunction(() => /60 s/.test(document.getElementById('mmPreviewInfo')?.textContent || ''), null, { timeout: 20000 });
check('vídeo: duração detectada 60 s, vertical, WEBM', /Vídeo/.test(await p.textContent('#mmPreviewInfo')) && /vertical/.test(await p.textContent('#mmPreviewInfo')) && /WEBM/.test(await p.textContent('#mmPreviewInfo')));
await p.fill('#mmFreq', '60');
await p.waitForFunction(() => /0 de 2/.test(document.querySelector('[data-mm-compativeis]')?.textContent || ''));
const projCheia = await p.textContent('#mmCapacidadePreview');
check('não cabe: aviso antes de criar', /Não cabe em 2 pontos/.test(projCheia), projCheia);
check('não cabe: por ponto', (projCheia.match(/Não há capacidade disponível para esta configuração/g) || []).length === 2, projCheia);
await shot(await p.$('.mm-editor'), 'form-nao-cabe');
await p.click('#btnCancelarMidia');

etapa('== criar os outros estados ==');
const amanha = new Date(Date.now() + 24 * 3600_000).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16).replace(' ', 'T');
await criar({ nome: 'Seja um ponto', arquivo: 'seja-um-ponto.webm', freq: 2, pontos: ['San & Co'], inicio: amanha });
await criar({ nome: 'Aviso de horário', arquivo: 'aviso-horario.png', pausada: true });
await shot(await p.$('.mm-grade'), 'grade-3-midias');
await criar({ nome: 'Campanha antiga', arquivo: 'campanha-antiga.png' });
await card('Campanha antiga').locator('[data-encerrar-midia]').click();
await p.click('dialog [data-confirmar]');
await p.waitForFunction(() => /retirada do ar/.test(document.getElementById('toast')?.textContent || ''));
await criar({ nome: 'Institucional loja', arquivo: 'institucional-loja.png', freq: 4 });
// Entrega atrasada: ativa há 5 h, em pontos abertos 24 h, sem nenhuma
// exibição confirmada. Mesmo estado que a métrica calcula de verdade.
const atrasada = PG(`SELECT id FROM midias_proprias WHERE nome_interno = 'Institucional loja'`);
PG(`UPDATE midias_proprias SET created_at = now() - interval '5 hours' WHERE id = ${atrasada}`);
PG(`UPDATE midias_proprias_situacoes SET desde = now() - interval '5 hours' WHERE midia_id = ${atrasada}`);
await recarregar();

etapa('== indicadores e cards ==');
check('Ativas = 2 (café e institucional loja)', (await kpi('ativas')) === 2, String(await kpi('ativas')));
check('Agendadas = 1', (await kpi('agendadas')) === 1, String(await kpi('agendadas')));
check('Pausadas = 1', (await kpi('pausadas')) === 1, String(await kpi('pausadas')));
check('Com atraso = 1', (await kpi('atraso')) === 1, String(await kpi('atraso')));
check('atraso em destaque no indicador', await p.isVisible('[data-kpi="atraso"].mini-indicador-alerta'));
const cAtrasada = await card('Institucional loja').textContent();
check('card atrasado: badge "Entrega atrasada" com o porquê', /Entrega atrasada/.test(cAtrasada) && /primeira exibição passou do prazo/.test(cAtrasada), cAtrasada);
check('card atrasado: marcado', await p.isVisible('.mm-card-atrasada:has-text("Institucional loja")'));
const cCafe = await card('Promoção Café da Manhã').textContent();
check('card: nome, estado, duração, frequência, cobertura', /Ativa/.test(cCafe) && /10 s/.test(cCafe) && /6×\/hora/.test(cCafe) && /Toda a rede/.test(cCafe), cCafe);
const metricaCafe = async (attr) => (await card('Promoção Café da Manhã').locator(`[${attr}]`).textContent()).trim();
check('card: exibições confirmadas e última', (await metricaCafe('data-mm-confirmadas')) === '0' && (await metricaCafe('data-mm-ultima')) === '—', cCafe);
check('card: aguardando primeira exibição', /Aguardando a primeira exibição/.test(cCafe), cCafe);
const cAgendada = await card('Seja um ponto').textContent();
check('card agendado: "Agendada", 7 s, 1 ponto, período', /Agendada/.test(cAgendada) && /7 s/.test(cAgendada) && /1 ponto/.test(cAgendada) && /→ sem fim/.test(cAgendada), cAgendada);
check('card encerrado: "Encerrada"', /Encerrada/.test(await card('Campanha antiga').textContent()));
check('card pausado: "Pausada" e [Retomar]', /Pausada/.test(await card('Aviso de horário').textContent()) && (await card('Aviso de horário').locator('[data-retomar-midia]').count()) === 1);
check('preview em cima, informações embaixo', await p.evaluate(() => {
  const c = document.querySelector('.mm-card');
  const pr = c.querySelector('.mm-card-preview').getBoundingClientRect();
  const corpo = c.querySelector('.mm-card-corpo').getBoundingClientRect();
  return pr.bottom <= corpo.top + 1;
}));
check('ações no rodapé do card', await p.evaluate(() =>
  [...document.querySelectorAll('.mm-card')].every((c) => {
    const acoes = c.querySelector('.mm-card-acoes').getBoundingClientRect();
    return c.getBoundingClientRect().bottom - acoes.bottom < 20;
  }),
));
check('mesma área de preview em todo card', await p.evaluate(() => {
  const alturas = [...document.querySelectorAll('.mm-card-preview')].map((e) => Math.round(e.getBoundingClientRect().height));
  return new Set(alturas).size === 1;
}));
check('listagem sem player: nenhum <video> com controles na grade', (await p.locator('.mm-grade video[controls]').count()) === 0);
check('prévia é a miniatura (img), não vídeo, quando há quadro gerado', await p.evaluate(() =>
  [...document.querySelectorAll('.mm-card-moldura')].every((m) => m.querySelector('img.mm-card-thumb') && !m.querySelector('video')),
));
check('moldura 9:16, peça inteira (contain), sem deformar', await p.evaluate(() =>
  [...document.querySelectorAll('.mm-card-moldura')].every((m) => {
    const r = m.getBoundingClientRect();
    const t = m.querySelector('.mm-card-thumb');
    return Math.abs(r.width / r.height - 9 / 16) < 0.02 && getComputedStyle(t).objectFit === 'contain';
  }),
));
check('ações: dia a dia à esquerda, destrutivas à direita, cada botão numa linha', await p.evaluate(() =>
  [...document.querySelectorAll('.mm-card-acoes')].every((a) => {
    const grupos = [...a.querySelectorAll('.mm-card-acoes-grupo')];
    const botoesInteiros = [...a.querySelectorAll('.btn')].every((b) => b.getBoundingClientRect().height < 40);
    if (grupos.length < 2) return botoesInteiros;
    const [g1, g2] = grupos.map((g) => g.getBoundingClientRect());
    return botoesInteiros && Math.abs(g2.right - a.getBoundingClientRect().right) < 16 && g1.left < g2.left;
  }),
));
await shot(p, 'pagina-inteira', { fullPage: true });
await shot(await p.$('.mm-kpis'), 'kpis');
await shot(await p.$('.mm-grade'), 'grade-4-midias');
await shot(await card('Aviso de horário').elementHandle(), 'card-pausada');
await shot(await card('Institucional loja').elementHandle(), 'card-atrasada');

// ---------------------------------------------------------------------------
etapa('== exclusão ==');
check('ativa não tem [Excluir]', (await card('Promoção Café da Manhã').locator('[data-excluir-midia]').count()) === 0);
check('agendada não tem [Excluir]', (await card('Seja um ponto').locator('[data-excluir-midia]').count()) === 0);
check('pausada tem [Excluir]', (await card('Aviso de horário').locator('[data-excluir-midia]').count()) === 1);
check('encerrada tem [Excluir]', (await card('Campanha antiga').locator('[data-excluir-midia]').count()) === 1);
esperado409 = true;
const idCafe = PG(`SELECT id FROM midias_proprias WHERE nome_interno = 'Promoção Café da Manhã'`);
const r409 = await p.evaluate(async (id) => (await fetch(`/admin/midias-proprias/${id}`, { method: 'DELETE' })).status, idCafe);
check('servidor recusa excluir ativa (409)', r409 === 409, String(r409));
esperado409 = false;

await card('Aviso de horário').locator('[data-excluir-midia]').click();
await p.waitForSelector('dialog.modal-admin');
const textoModal = await p.textContent('dialog.modal-admin');
check('modal nativo: "Excluir mídia?"', /Excluir mídia\?/.test(textoModal), textoModal);
check('modal: nome e "não pode ser desfeita"', /“Aviso de horário” será removida/.test(textoModal) && /não pode ser desfeita/.test(textoModal));
check('modal: botão destrutivo', await p.isVisible('dialog [data-confirmar].perigo'));
await shot(await p.$('dialog .modal-caixa'), 'modal-exclusao');
await p.click('dialog .modal-rodape [data-fechar]');
await p.waitForTimeout(200);
check('Cancelar não exclui', (await card('Aviso de horário').count()) === 1);
await card('Aviso de horário').locator('[data-excluir-midia]').click();
await p.click('dialog [data-confirmar]');
await p.waitForFunction(() => /Mídia excluída/.test(document.getElementById('toast')?.textContent || ''));
await p.waitForSelector('.mm-card:has-text("Aviso de horário")', { state: 'detached' });
check('some da página', true);
check('no banco: exclusão lógica (a linha fica)', PG(`SELECT situacao FROM midias_proprias WHERE nome_interno = 'Aviso de horário'`) === 'excluida');
check('Pausadas volta a 0', (await kpi('pausadas')) === 0);

// ---------------------------------------------------------------------------
etapa('== edição: mesmo padrão da criação ==');
await card('Seja um ponto').locator('[data-editar-midia]').click();
await p.waitForSelector('#formMidia');
const infoEd = await p.textContent('#mmPreviewInfo');
// Tamanho e orientação saem do próprio vídeo quando ele carrega — o MP4
// salvo não carrega no Chromium sem H.264; tipo, duração e formato já vêm.
check('edição: preview descrito (vídeo, 7 s, WEBM do original)', /Vídeo/.test(infoEd) && /7 s/.test(infoEd) && /WEBM/.test(infoEd), infoEd);
check('edição: Resumo e Capacidade projetada', (await p.isVisible('[data-mm-resumo]')) && (await p.isVisible('text=Capacidade projetada')));
await p.waitForSelector('[data-mm-projecao]');
check('edição: projeção só no ponto escolhido', /San & Co/.test(await p.textContent('[data-mm-projecao]')) && !/Padaria Central/.test(await p.textContent('[data-mm-projecao]')));
check('edição: período visível com início e fim', (await p.isVisible('#mmInicio')) && (await p.isVisible('#mmFim')));
await shot(await p.$('.mm-editor'), 'form-edicao');
await p.click('#btnCancelarMidia');

// ---------------------------------------------------------------------------
etapa('== larguras ==');
const colunasEsperadas = (w) => (w >= 1200 ? 3 : w >= 640 ? 2 : 1);
for (const w of [1920, 1440, 1280, 1024, 768, 430, 390, 360]) {
  await p.setViewportSize({ width: w, height: 900 });
  await p.waitForTimeout(250);
  const { colunas, sobra } = await p.evaluate(() => ({
    colunas: new Set([...document.querySelectorAll('.mm-card')].map((c) => Math.round(c.getBoundingClientRect().left))).size,
    sobra: document.documentElement.scrollWidth - window.innerWidth,
  }));
  check(`${w}px: ${colunasEsperadas(w)} coluna(s), sem rolagem lateral`, colunas === colunasEsperadas(w) && sobra <= 0, `colunas ${colunas}, sobra ${sobra}px`);
  if ([1920, 1024, 390].includes(w)) await shot(p, `pagina-${w}`, { fullPage: true });
}
await p.setViewportSize({ width: 390, height: 844 });
await card('Campanha antiga').locator('[data-excluir-midia]').click();
await p.waitForSelector('dialog.modal-admin');
const sobraModal = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('390px: modal sem rolagem lateral', sobraModal <= 0, `${sobraModal}px`);
await shot(p, 'modal-exclusao-390');
await p.click('dialog .modal-rodape [data-fechar]');
await abrirNova();
await p.setInputFiles('#mmArquivo', `${FIX}/cafe-da-manha.png`);
await p.waitForSelector('[data-mm-projecao]');
const sobraForm = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('390px: formulário sem rolagem lateral', sobraForm <= 0, `${sobraForm}px`);
await shot(p, 'form-390', { fullPage: true });
await p.click('#btnCancelarMidia');
await p.setViewportSize({ width: 1440, height: 900 });

// ---------------------------------------------------------------------------
etapa('== Visão geral: QR compacto ==');
await p.evaluate(() => {
  location.hash = 'visaogeral';
});
await p.waitForSelector('#qrResumo [data-qr-resumo]');
const qr = await p.textContent('#qrResumo');
check('QR institucional + destino atual + [Gerenciar]', /QR institucional/.test(qr) && /Destino atual/.test(qr) && /Gerenciar/.test(qr), qr);
const alturaQr = await p.evaluate(() => document.getElementById('qrResumo').getBoundingClientRect().height);
check('compacto (< 160 px)', alturaQr < 160, `${alturaQr}px`);
await shot(await p.$('#qrResumo'), 'visao-geral-qr');
await p.click('#qrResumo [data-gerenciar-qr]');
await p.waitForSelector('dialog [data-qr-controles] .qr-inst');
check('Gerenciar abre os controles de sempre', (await p.isVisible('#qrLink')) && (await p.isVisible('#qrDestino')) && (await p.locator('dialog a[download]').count()) === 3);
await shot(await p.$('dialog .modal-caixa'), 'visao-geral-qr-gerenciar');
await p.click('dialog .modal-topo [data-fechar]');
await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(250);
check('390px: Visão geral sem rolagem lateral', (await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
await p.setViewportSize({ width: 1440, height: 900 });

// ---------------------------------------------------------------------------
etapa('== Rede → Ponto: capacidade de veiculação ==');
const [daRede] = await p.evaluate(async (id) => (await (await fetch('/admin/capacidade-rede?escopo=rede')).json()).filter((l) => l.pontoId === id), SAN.id);
const [daMidia] = await p.evaluate(async (id) => (await (await fetch('/admin/capacidade-rede')).json()).filter((l) => l.pontoId === id), SAN.id);
check('mesma régua da antiga tabela da Mídia Mostraí (ponto em operação)', JSON.stringify(daRede) === JSON.stringify(daMidia));
check('comercial usado > 0 (anunciante no ponto)', daRede.comercialPct > 0, JSON.stringify(daRede));
await p.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, SAN.id);
await p.waitForSelector('[data-capacidade-ponto]');
const pctBR = (v) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
const cap = async (k) => (await p.textContent(`[data-cap="${k}"]`)).trim();
check('Comercial usado', (await cap('comercial')) === pctBR(daRede.comercialPct), `${await cap('comercial')} × ${daRede.comercialPct}`);
check('Comercial livre', (await cap('comercial-livre')).startsWith(pctBR(daRede.comercialRestantePct)), await cap('comercial-livre'));
check('Reserva Mostraí usada', (await cap('mostrai')) === pctBR(daRede.mostraiPct), `${await cap('mostrai')} × ${daRede.mostraiPct}`);
check('Reserva Mostraí livre', (await cap('mostrai-livre')).startsWith(pctBR(daRede.reservaRestantePct)), await cap('mostrai-livre'));
check('Total ocupado', (await cap('total')) === pctBR(daRede.totalPct), `${await cap('total')} × ${daRede.totalPct}`);
check('Mídias próprias', Number(await cap('midias')) === daRede.qtdMidiasProprias, `${await cap('midias')} × ${daRede.qtdMidiasProprias}`);
await p.click('[data-cap="midias"]');
await p.waitForSelector('[data-cap-midias] table, [data-cap-midias] p');
const lista = await p.textContent('[data-cap-midias]');
check('lista as mídias no ponto', /Promoção Café da Manhã/.test(lista) && /Institucional loja/.test(lista), lista);
await shot(await p.$('#pontoCapacidade'), 'rede-ponto-capacidade');
await shot(p, 'rede-ponto', { fullPage: true });
await p.evaluate(({ id, tela }) => {
  location.hash = `rede/pontos/${id}/telas/${tela}`;
}, SAN);
await p.waitForTimeout(1200);
check('ficha da tela não tem capacidade', !(await p.$('[data-capacidade-ponto]')));
await p.setViewportSize({ width: 390, height: 844 });
await p.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, SAN.id);
await p.waitForSelector('[data-capacidade-ponto]');
// A ficha do ponto já tinha transbordo a 390 px antes desta estação (a linha
// "Benefício do ponto" da ficha, +86 px — fica pra revisão da Rede). Aqui se
// confere o bloco que esta estação pôs lá: ele cabe na tela.
check(
  '390px: bloco de capacidade cabe na tela',
  await p.evaluate(() => {
    const el = document.getElementById('pontoCapacidade');
    return el.getBoundingClientRect().right <= innerWidth && el.scrollWidth <= el.clientWidth;
  }),
);
await shot(await p.$('#pontoCapacidade'), 'rede-ponto-capacidade-390');

if (VIDEO_ANTES) PG(`UPDATE configuracoes_site SET valor = '${VIDEO_ANTES.replace(/'/g, "''")}' WHERE chave = 'video_institucional'`);
else PG(`DELETE FROM configuracoes_site WHERE chave = 'video_institucional'`);
check('sem erro de console ou de página', erros.length === 0, erros.join(' | '));
await navegador.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\nTUDO OK');
process.exit(falhas.length ? 1 : 0);
