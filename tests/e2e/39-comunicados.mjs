// Comunicados por e-mail (Admin → Visão geral, 29/09/2026) no navegador de
// verdade: card compacto, modal com público e contagem, validação, prévia
// (o e-mail real, com os estilos aplicados sob a CSP do admin), envio de
// teste, confirmação Mostraí (nunca window.confirm), resposta PERDIDA no
// meio do envio sem virar envio duplo, histórico que se atualiza, falha
// parcial com "Reenviar falhas" pegando só quem falhou, público vazio
// bloqueado, rota sem admin recusada, e as 8 larguras sem rolagem lateral.
// Banco zerado, servidor na 3999:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/39-comunicados.mjs
import { execSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { chromium } from 'playwright';
import { emailsPara } from './emails.mjs';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
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
const esperar = async (cond, ms = 10000, passo = 250) => {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, passo));
  }
  return false;
};

if (Number(PG('SELECT COUNT(*) FROM anunciantes'))) {
  console.log('Banco com contas de outra rodada: rode tests/e2e/reset-db.sh antes.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Contas: 4 recebem (uma com plano, uma sem, uma com plano vencido, uma dona
// de ponto) e 4 ficam de fora (suspensa, e-mail não confirmado, revogou
// "receber novidades", excluída).
const RODADA = Date.now().toString(36);
const EQUIPE = `equipe-${RODADA}@mostrai.test`;
const email = (n) => `e2e-com-${n}@example.com`;
function conta(n, { plano = false, expira = null, suspensa = false, confirmada = true, revogou = false, excluida = false } = {}) {
  const doc = String(randomInt(10 ** 10, 10 ** 11 - 1));
  // psql devolve o id e, na linha seguinte, a etiqueta "INSERT 0 1".
  return Number.parseInt(
    PG(`INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                                 papeis, email_confirmado, plano_id, data_expiracao, suspenso, excluido_em, comunicacoes_revogado_em)
        VALUES (now(), 'Comércio ${n}', '${doc}', '${email(n)}', '16999990000', 'x', ARRAY['anunciante'], ${confirmada},
                ${plano ? "'destaque-1m'" : 'NULL'}, ${expira === null ? 'NULL' : `current_date + ${expira}`}, ${suspensa},
                ${excluida ? 'now()' : 'NULL'}, ${revogou ? 'now()' : 'NULL'})
        RETURNING id`),
    10,
  );
}
const ID = {
  plano: conta('plano', { plano: true, expira: 30 }),
  semplano: conta('semplano'),
  vencido: conta('vencido', { plano: true, expira: -5 }),
  dono: conta('dono'),
  suspensa: conta('suspensa', { plano: true, expira: 30, suspensa: true }),
  naoconfirmada: conta('naoconfirmada', { confirmada: false }),
  revogou: conta('revogou', { revogou: true }),
  excluida: conta('excluida', { excluida: true }),
};
PG(`INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato,
                        anunciante_id, escolha_bloqueada_em)
    VALUES ('Padaria do Dono', 'R', 'Matão', 'SP', '1', 'outro', 'R', '1', ${ID.dono}, now())`);
const RECEBEM = ['plano', 'semplano', 'vencido', 'dono'];
const FORA = ['suspensa', 'naoconfirmada', 'revogou', 'excluida'];

// ---------------------------------------------------------------------------
const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const ctx = await navegador.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const ignorar = [];
p.on('pageerror', (e) => erros.push(`[${fase}] pageerror: ${e.message}`));
p.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (fase === 'login' && /status of 401/.test(m.text())) return;
  if (ignorar.some((r) => r.test(m.text()))) return;
  erros.push(`[${fase}] console: ${m.text()}`);
});
// window.confirm/alert/prompt: proibidos aqui (a confirmação é o modal da Mostraí).
p.on('dialog', async (d) => {
  falha(`diálogo nativo do navegador (${d.type()})`, d.message());
  await d.dismiss();
});

const semRolagemLateral = (pg) =>
  pg.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const modalSemRolagemLateral = (pg) =>
  pg.evaluate(() =>
    [...document.querySelectorAll('dialog[open]')].every((d) => {
      const corpo = d.querySelector('.modal-corpo');
      return d.scrollWidth <= d.clientWidth + 1 && (!corpo || corpo.scrollWidth <= corpo.clientWidth + 1);
    }),
  );
const textoDe = (pg, sel) => pg.locator(sel).first().innerText();
const destinatarios = (pg) =>
  pg.waitForFunction(() => {
    const t = document.querySelector('[data-destinatarios]')?.textContent || '';
    return t && !t.includes('…') ? t : false;
  });

etapa('login');
await irQuieto(p, `${B}/admin/index.html`);
await p.fill('#usuario', process.env.ADMIN_USER || 'admin');
await p.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await p.click('#formLogin button[type=submit]');
await p.waitForSelector('#conteudo .visao-geral-colunas');

// ---------------------------------------------------------------------------
etapa('== card na Visão geral ==');
const card = p.locator('[data-comunicados-resumo]');
await card.waitFor();
check('card "Comunicados por e-mail"', (await card.locator('h3').innerText()) === 'Comunicados por e-mail');
check(
  'descrição do card',
  (await card.innerText()).includes('Envie avisos da Mostraí para as contas da plataforma.'),
);
check('estado vazio', (await card.innerText()).includes('Nenhum comunicado enviado ainda.'));
check('[+ Novo comunicado]', await card.locator('[data-novo-comunicado]').isVisible());
check('sem formulário grande na Visão geral', (await card.locator('textarea, input').count()) === 0);
await card.screenshot({ path: `${SAIDA}39-card-vazio.png` });

// ---------------------------------------------------------------------------
etapa('== modal: público e contagem ==');
await card.locator('[data-novo-comunicado]').click();
const modal = p.locator('dialog[open]').first();
await modal.waitFor();
const t0 = await destinatarios(p);
check('Todas as contas ativas: 4 contas', (await t0.jsonValue()).includes('4 contas'), await t0.jsonValue());
const fora = await textoDe(p, '[data-fora]');
check(
  'fora do envio explicado (só números)',
  fora.includes('1 suspensa') && fora.includes('1 com e-mail não confirmado') && fora.includes('1 pediu pra não receber'),
  fora,
);
check('a contagem não mostra endereço nenhum', !(await modal.innerText()).includes('@example.com'));
for (const [publico, esperado] of [
  ['com_plano', '1 conta'],
  ['sem_plano', '3 contas'],
  ['donos_de_ponto', '1 conta'],
  ['todas', '4 contas'],
]) {
  await modal.locator(`input[name=publico][value=${publico}]`).check({ force: true });
  const t = await destinatarios(p);
  check(`${publico}: ${esperado}`, (await t.jsonValue()).includes(`Destinatários: ${esperado}`), await t.jsonValue());
}
await p.screenshot({ path: `${SAIDA}39-modal-escrever-1280.png` });

etapa('== validação ==');
ignorar.push(/status of 400/);
await modal.locator('[data-revisar]').click();
await p.waitForFunction(() => document.querySelector('[data-msg]')?.textContent.includes('assunto'));
check('sem assunto: erro no campo', (await p.getAttribute('#comAssunto', 'aria-invalid')) === 'true');
await p.fill('#comAssunto', `Manutenção programada ${RODADA}`);
await p.fill('#comTitulo', 'Sistema em manutenção no domingo');
await p.fill(
  '#comMensagem',
  'No domingo, das 2h às 4h, o painel fica fora do ar.\nAs telas continuam passando os anúncios.\n\nTexto com <script>alert(1)</script> fica como texto.',
);
await modal.locator('summary').click();
await p.fill('#comBotaoTexto', 'Ver status');
await p.fill('#comBotaoUrl', 'javascript:alert(1)');
await modal.locator('[data-revisar]').click();
await p.waitForFunction(() => document.querySelector('#comBotaoUrl')?.getAttribute('aria-invalid') === 'true');
check(
  'link javascript: recusado no campo do botão',
  (await textoDe(p, '[data-msg]')).toLowerCase().includes('https'),
  await textoDe(p, '[data-msg]'),
);
await p.fill('#comBotaoUrl', 'https://mostrai.sancocore.com.br/');

// ---------------------------------------------------------------------------
etapa('== prévia: o e-mail de verdade ==');
await modal.locator('[data-revisar]').click();
await p.waitForSelector('[data-revisao]:not([hidden])');
const previa = await p.evaluate(() => {
  const raiz = document.querySelector('[data-previa]').shadowRoot;
  const h1 = raiz.querySelector('h1');
  const botao = [...raiz.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Ver status');
  return {
    texto: raiz.textContent,
    h1: h1 ? getComputedStyle(h1).fontSize : null,
    fundoBotao: botao ? getComputedStyle(botao.closest('td')).backgroundColor : null,
    alvoBotao: botao?.target,
    scripts: raiz.querySelectorAll('script, img, iframe').length,
    comStyleAttr: raiz.querySelectorAll('[style]').length,
    largura: document.querySelector('[data-previa]').scrollWidth <= document.querySelector('[data-previa]').clientWidth + 1,
  };
});
check('prévia traz o título', previa.texto.includes('Sistema em manutenção no domingo'));
check('o <script> do admin aparece como TEXTO', previa.texto.includes('<script>alert(1)</script>') && previa.scripts === 0);
check('estilos do template aplicados (título 22px) sob a CSP', previa.h1 === '22px', previa.h1);
check('botão na cor da marca (#c2570a)', previa.fundoBotao === 'rgb(194, 87, 10)', previa.fundoBotao);
check('link da prévia abre em outra aba', previa.alvoBotao === '_blank');
check('prévia sem rolagem lateral', previa.largura);
check('ficha: público, destinatários e assunto', (await modal.innerText()).includes('4 contas'));
await p.screenshot({ path: `${SAIDA}39-modal-revisar-1280.png` });
await modal.locator('input[name=formatoPrevia][value=texto]').check({ force: true });
const texto = await textoDe(p, '[data-previa-texto]');
check(
  'versão em texto puro',
  texto.includes('No domingo, das 2h às 4h') && texto.includes('Ver status: https://mostrai.sancocore.com.br/'),
);
await modal.locator('input[name=formatoPrevia][value=html]').check({ force: true });

etapa('== envio de teste ==');
await p.fill('#comTestePara', email('plano'));
await modal.locator('[data-enviar-teste]').click();
await p.waitForFunction(() => document.querySelector('[data-msg-teste]')?.classList.contains('err'));
check('teste para conta de cliente: recusado', (await textoDe(p, '[data-msg-teste]')).includes('conta de cliente'));
await p.fill('#comTestePara', EQUIPE);
await modal.locator('[data-enviar-teste]').click();
await p.waitForFunction(() => document.querySelector('[data-msg-teste]')?.textContent.startsWith('Teste enviado'));
check('teste enviado (endereço mascarado na tela)', (await textoDe(p, '[data-msg-teste]')).includes('eq***@mostrai.test'));
const teste = emailsPara(EQUIPE);
check(
  'o teste chegou marcado [TESTE] e só pra equipe',
  teste.length === 1 && teste[0].subject === `[TESTE] Manutenção programada ${RODADA}`,
  JSON.stringify(teste),
);
check('teste fora do histórico', Number(PG('SELECT COUNT(*) FROM comunicados')) === 0);

// ---------------------------------------------------------------------------
etapa('== confirmação Mostraí ==');
await modal.locator('[data-enviar]').click();
const confirmar = p.locator('dialog[open]').nth(1);
await confirmar.waitFor();
const textoConfirmar = await confirmar.innerText();
check('confirmação: título', textoConfirmar.includes('Enviar comunicado?'));
check('confirmação: público', textoConfirmar.includes('Todas as contas ativas'));
check('confirmação: destinatários', textoConfirmar.includes('4 contas'));
check('confirmação: assunto', textoConfirmar.includes(`Manutenção programada ${RODADA}`));
check('confirmação: consequência', textoConfirmar.includes('Este envio será disparado para 4 contas.'));
await p.screenshot({ path: `${SAIDA}39-confirmacao-1280.png` });
await confirmar.getByRole('button', { name: 'Cancelar' }).click();
check('cancelar não envia nada', Number(PG('SELECT COUNT(*) FROM comunicados')) === 0);

etapa('== resposta perdida no meio do envio, e a conexão não volta ==');
// O servidor recebe e grava, mas a resposta nunca chega ao navegador — e a
// pergunta "entrou?" também não (queda de rede que dura). A tela não sabe:
// trava a edição e o teste (editar e mandar de novo viraria um SEGUNDO
// comunicado) e guarda a chave na aba. Quando a conexão volta, "Enviar
// comunicado…" manda a MESMA chave e o servidor devolve o que já existe.
ignorar.push(/ERR_FAILED/, /Failed to load resource/);
const soPost = (url) => url.pathname === '/admin/comunicados';
const pergunta = (url) => url.pathname.startsWith('/admin/comunicados/por-chave/');
let perdidas = 0;
await p.route(soPost, async (route) => {
  if (route.request().method() !== 'POST' || perdidas) return route.continue();
  await route.fetch();
  perdidas++;
  await route.abort('failed');
});
await p.route(pergunta, (route) => route.abort('failed'));
await modal.locator('[data-enviar]').click();
await confirmar.waitFor();
await confirmar.getByRole('button', { name: 'Enviar comunicado' }).click();
await p.waitForFunction(() => document.querySelector('[data-msg-envio]')?.textContent.includes('Sem resposta do servidor'));
check('a tela diz que não sabe se entrou', true);
check('mas o servidor gravou (1 comunicado)', Number(PG('SELECT COUNT(*) FROM comunicados')) === 1);
check('"Voltar e editar" some enquanto não se sabe', await modal.locator('[data-voltar]').isHidden());
check('envio de teste travado enquanto não se sabe', await modal.locator('[data-enviar-teste]').isDisabled());
const pendenteNaAba = await p.evaluate(() => sessionStorage.getItem('mostrai:comunicado-sem-resposta'));
check('a chave fica guardada na aba (sobrevive a recarregar)', !!pendenteNaAba && pendenteNaAba.includes('chave'));
await p.unroute(pergunta);
await p.unroute(soPost);
await modal.locator('[data-enviar]').click();
await confirmar.waitFor();
await confirmar.getByRole('button', { name: 'Enviar comunicado' }).click();
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('nada foi mandado de novo'));
check('conexão de volta, mesma chave: "já tinha entrado", nada de novo', true);
check(
  'a aba esqueceu a pendência',
  (await p.evaluate(() => sessionStorage.getItem('mostrai:comunicado-sem-resposta'))) === null,
);
check('continua 1 comunicado', Number(PG('SELECT COUNT(*) FROM comunicados')) === 1);
const COM = Number(PG('SELECT id FROM comunicados'));
check(
  'e 4 mensagens na fila (uma por destinatário)',
  Number(PG(`SELECT COUNT(*) FROM email_outbox WHERE chave LIKE 'comunicado:${COM}:%'`)) === 4,
);
check('quem enviou fica registrado', PG(`SELECT criado_por FROM comunicados WHERE id = ${COM}`) === (process.env.ADMIN_USER || 'admin'));

etapa('== entrega: um e-mail por pessoa ==');
const ASSUNTO = `Manutenção programada ${RODADA}`;
const chegou = await esperar(
  () => RECEBEM.every((n) => emailsPara(email(n)).filter((m) => m.subject === ASSUNTO).length === 1),
  75000,
  500,
);
check('as 4 contas receberam UMA vez', chegou, RECEBEM.map((n) => `${n}:${emailsPara(email(n)).length}`).join(' '));
check('quem está fora não recebeu', FORA.every((n) => emailsPara(email(n)).length === 0));
const todas = RECEBEM.flatMap((n) => emailsPara(email(n)).filter((m) => m.subject === ASSUNTO));
check(
  'cada e-mail: um endereço só no "Para", sem cópia',
  todas.every((m) => typeof m.to === 'object' && !m.cc && RECEBEM.some((n) => m.to.address === email(n))),
);
check(
  'nenhum e-mail cita outro destinatário',
  todas.every((m) => RECEBEM.every((n) => m.to.address === email(n) || !m.text.includes(email(n)))),
);

etapa('== card e histórico ==');
await p.waitForFunction(() => document.querySelector('[data-ultimo-comunicado]')?.textContent.includes('Último envio'));
check('card: último envio com 4 destinatários', (await textoDe(p, '[data-ultimo-comunicado]')).includes('4 destinatários'));
await card.screenshot({ path: `${SAIDA}39-card-com-envio.png` });
await card.locator('[data-historico-comunicados]').click();
const historico = p.locator('dialog[open]').first();
await p.waitForFunction(
  () => document.querySelector('.comunicado-item .badge')?.textContent.trim() === 'concluído',
  null,
  { timeout: 20000 },
);
const item = await textoDe(p, '.comunicado-item');
check('histórico: assunto, público e quem enviou', item.includes(ASSUNTO) && item.includes('Todas as contas ativas') && item.includes('por admin'));
check('histórico: 4 previstos, 4 enviados, 0 falharam', item.includes('4 previstos') && item.includes('4 enviados') && item.includes('0 falharam'));
check('histórico sem endereço', !(await historico.innerText()).includes('@example.com'));
await p.screenshot({ path: `${SAIDA}39-historico-1280.png` });
await historico.locator('.modal-rodape [data-fechar]').click();

etapa('== falha parcial e "Reenviar falhas" ==');
// O provedor recusou um destinatário (simulado: a linha dele na fila vira
// "abandonada", como depois de 6 tentativas).
const falhou = ID.vencido;
PG(`UPDATE email_outbox SET status = 'abandonado', ultimo_erro = '550 5.1.1 mailbox unavailable'
     WHERE id = (SELECT email_outbox_id FROM comunicados_destinatarios WHERE comunicado_id = ${COM} AND anunciante_id = ${falhou})`);
PG(`UPDATE comunicados_destinatarios SET situacao = 'falhou', ultimo_erro = '550 5.1.1 mailbox unavailable'
     WHERE comunicado_id = ${COM} AND anunciante_id = ${falhou}`);
await card.locator('[data-historico-comunicados]').click();
await p.waitForSelector('.comunicado-item');
const itemFalha = await textoDe(p, '.comunicado-item');
check('falha parcial: 3 enviados, 1 falhou', itemFalha.includes('3 enviados') && itemFalha.includes('1 falhou'), itemFalha);
check('selo "concluído · 1 falha"', itemFalha.includes('concluído · 1 falha'));
await p.locator('[data-detalhe]').first().click();
const detalhe = p.locator('dialog[open]').nth(1);
await detalhe.locator('[data-reenviar]').waitFor();
const textoDetalhe = await detalhe.innerText();
check('detalhe: quem falhou, com endereço mascarado', textoDetalhe.includes('Comércio vencido') && textoDetalhe.includes('e2***@example.com'));
check('detalhe: o endereço inteiro não aparece', !textoDetalhe.includes(email('vencido')));
check('detalhe: o que foi enviado', textoDetalhe.includes('Sistema em manutenção no domingo'));
await p.screenshot({ path: `${SAIDA}39-detalhe-falha-1280.png` });
await detalhe.locator('[data-reenviar]').click();
const confirmarReenvio = p.locator('dialog[open]').nth(2);
await confirmarReenvio.waitFor();
check('confirmação do reenvio fala em 1 conta', (await confirmarReenvio.innerText()).includes('1 conta'));
await confirmarReenvio.getByRole('button', { name: /Reenviar para 1 conta/ }).click();
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('voltou pra fila'));
check('toast: 1 conta voltou pra fila', true);
const reenviou = await esperar(() => emailsPara(email('vencido')).filter((m) => m.subject === ASSUNTO).length === 2, 75000, 500);
check('quem falhou recebeu de novo', reenviou);
check(
  'quem já tinha recebido NÃO recebeu de novo',
  ['plano', 'semplano', 'dono'].every((n) => emailsPara(email(n)).filter((m) => m.subject === ASSUNTO).length === 1),
);
check(
  'trilha do reenvio (quem, quantos)',
  PG(`SELECT quantidade || '|' || criado_por FROM comunicados_reenvios WHERE comunicado_id = ${COM}`) ===
    `1|${process.env.ADMIN_USER || 'admin'}`,
);
await p.waitForFunction(() => document.querySelector('.comunicado-item')?.textContent.includes('4 enviados'), null, {
  timeout: 20000,
});
check('histórico volta a 4 enviados, reenviado 1×', (await textoDe(p, '.comunicado-item')).includes('falhas reenviadas 1×'));
await p.keyboard.press('Escape');
await p.keyboard.press('Escape');

etapa('== público sem destinatário ==');
PG(`UPDATE anunciantes SET comunicacoes_revogado_em = now() WHERE id = ${ID.dono}`);
await card.locator('[data-novo-comunicado]').click();
const modal2 = p.locator('dialog[open]').first();
await destinatarios(p);
await modal2.locator('input[name=publico][value=donos_de_ponto]').check({ force: true });
await p.waitForFunction(() =>
  document.querySelector('[data-destinatarios]')?.textContent.includes('Nenhuma conta deste público'),
);
check('público vazio: aviso claro', true);
await p.fill('#comAssunto', `Aviso aos donos ${RODADA}`);
await p.fill('#comTitulo', 'Aviso aos donos de ponto');
await p.fill('#comMensagem', 'Mensagem para donos de ponto.');
await modal2.locator('[data-revisar]').click();
await p.waitForSelector('[data-revisao]:not([hidden])');
check('público vazio: "Enviar comunicado" desligado', await modal2.locator('[data-enviar]').isDisabled());
await p.keyboard.press('Escape');
PG(`UPDATE anunciantes SET comunicacoes_revogado_em = NULL WHERE id = ${ID.dono}`);
check('nada gravado pro público vazio', Number(PG('SELECT COUNT(*) FROM comunicados')) === 1);

etapa('== sem sessão de admin ==');
const anonimo = await navegador.newContext();
for (const [metodo, caminho] of [
  ['get', '/admin/comunicados'],
  ['get', '/admin/comunicados/destinatarios?publico=todas'],
  ['post', '/admin/comunicados'],
  ['post', '/admin/comunicados/teste'],
  ['post', `/admin/comunicados/${COM}/reenviar-falhas`],
]) {
  const r = await anonimo.request[metodo](`${B}${caminho}`, { data: {}, failOnStatusCode: false });
  check(`${metodo.toUpperCase()} ${caminho} sem admin: 401`, r.status() === 401, r.status());
}
await anonimo.close();

// ---------------------------------------------------------------------------
etapa('== larguras ==');
for (const largura of [1920, 1440, 1280, 1024, 768, 430, 390, 360]) {
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => erros.push(`[${largura}] pageerror: ${e.message}`));
  pg.on('dialog', async (d) => {
    falha(`diálogo nativo (${largura})`, d.message());
    await d.dismiss();
  });
  await pg.setViewportSize({ width: largura, height: largura < 800 ? 820 : 900 });
  await irQuieto(pg, `${B}/admin/index.html`);
  const c = pg.locator('[data-comunicados-resumo]');
  await c.waitFor();
  await c.scrollIntoViewIfNeeded();
  check(`${largura}: página sem rolagem lateral`, await semRolagemLateral(pg));
  await c.screenshot({ path: `${SAIDA}39-${largura}-card.png` });

  await c.locator('[data-novo-comunicado]').click();
  const m = pg.locator('dialog[open]').first();
  await destinatarios(pg);
  check(`${largura}: modal (escrever) sem rolagem lateral`, await modalSemRolagemLateral(pg));
  await pg.screenshot({ path: `${SAIDA}39-${largura}-escrever.png` });
  await pg.fill('#comAssunto', `Aviso ${largura} ${RODADA}`);
  await pg.fill('#comTitulo', 'Um título que é comprido o bastante pra quebrar em telas estreitas sem vazar');
  await pg.fill('#comMensagem', `Mensagem de teste na largura ${largura}.\nSegunda linha.`);
  await m.locator('[data-revisar]').click();
  await pg.waitForSelector('[data-revisao]:not([hidden])');
  check(`${largura}: prévia sem rolagem lateral`, await modalSemRolagemLateral(pg));
  await pg.screenshot({ path: `${SAIDA}39-${largura}-revisar.png` });
  await m.locator('[data-enviar]').click();
  const conf = pg.locator('dialog[open]').nth(1);
  await conf.waitFor();
  check(`${largura}: confirmação sem rolagem lateral`, await modalSemRolagemLateral(pg));
  await pg.screenshot({ path: `${SAIDA}39-${largura}-confirmar.png` });
  await conf.getByRole('button', { name: 'Cancelar' }).click();
  await pg.keyboard.press('Escape');

  await c.locator('[data-historico-comunicados]').click();
  await pg.waitForSelector('.comunicado-item');
  check(`${largura}: histórico sem rolagem lateral`, await modalSemRolagemLateral(pg));
  await pg.screenshot({ path: `${SAIDA}39-${largura}-historico.png` });
  await pg.close();
}
check('nenhum envio saiu das larguras (só cancelados)', Number(PG('SELECT COUNT(*) FROM comunicados')) === 1);

// ---------------------------------------------------------------------------
// Mais dois jeitos de perder a resposta do envio, agora com a pergunta "entrou?"
// funcionando: na mesma tela, e com a página recarregada no meio.
async function escreverAosDonos(assunto) {
  await irQuieto(p, `${B}/admin/index.html`);
  const c = p.locator('[data-comunicados-resumo]');
  await c.waitFor();
  await c.locator('[data-novo-comunicado]').click();
  const m = p.locator('dialog[open]').first();
  await destinatarios(p);
  await m.locator('input[name=publico][value=donos_de_ponto]').check({ force: true });
  await p.waitForFunction(() => document.querySelector('[data-destinatarios]')?.textContent.includes('1 conta'));
  await p.fill('#comAssunto', assunto);
  await p.fill('#comTitulo', 'Recado para quem tem ponto');
  await p.fill('#comMensagem', 'A tela do seu ponto recebe uma atualização nesta semana.');
  await m.locator('[data-revisar]').click();
  await p.waitForSelector('[data-revisao]:not([hidden])');
  return m;
}
async function perderResposta({ perguntaFalha }) {
  let perdida = 0;
  await p.route(soPost, async (route) => {
    if (route.request().method() !== 'POST' || perdida) return route.continue();
    await route.fetch();
    perdida++;
    await route.abort('failed');
  });
  if (perguntaFalha) await p.route(pergunta, (route) => route.abort('failed'));
}

etapa('== resposta perdida, e a pergunta "entrou?" responde ==');
const RECADO = `Recado aos donos ${RODADA}`;
const m3 = await escreverAosDonos(RECADO);
await perderResposta({ perguntaFalha: false });
await m3.locator('[data-enviar]').click();
await p.locator('dialog[open]').nth(1).waitFor();
await p.locator('dialog[open]').nth(1).getByRole('button', { name: 'Enviar comunicado' }).click();
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Comunicado na fila para 1 conta'));
await p.unroute(soPost);
check('a tela perguntou, soube que entrou e fechou o modal', (await p.locator('dialog[open]').count()) === 0);
check('um comunicado só com esse assunto', Number(PG(`SELECT COUNT(*) FROM comunicados WHERE assunto = '${RECADO}'`)) === 1);
check(
  'o dono recebeu UMA vez',
  await esperar(() => emailsPara(email('dono')).filter((m) => m.subject === RECADO).length === 1, 75000, 500),
);

etapa('== página recarregada no meio do envio ==');
const LEMBRETE = `Lembrete aos donos ${RODADA}`;
const m4 = await escreverAosDonos(LEMBRETE);
await perderResposta({ perguntaFalha: true });
await m4.locator('[data-enviar]').click();
await p.locator('dialog[open]').nth(1).waitFor();
await p.locator('dialog[open]').nth(1).getByRole('button', { name: 'Enviar comunicado' }).click();
await p.waitForFunction(() => document.querySelector('[data-msg-envio]')?.textContent.includes('Sem resposta do servidor'));
await p.unroute(pergunta);
await p.unroute(soPost);
await p.reload();
await p.waitForSelector('[data-comunicados-resumo]');
await p.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('entrou na fila'));
check('recarregada, a Visão geral pergunta pela chave e avisa que entrou', true);
check(
  'e esquece a pendência',
  (await p.evaluate(() => sessionStorage.getItem('mostrai:comunicado-sem-resposta'))) === null,
);
check('um comunicado só com esse assunto', Number(PG(`SELECT COUNT(*) FROM comunicados WHERE assunto = '${LEMBRETE}'`)) === 1);

await navegador.close();
if (erros.length) for (const e of erros) falha('erro de página/console', e);
console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO OK');
process.exit(falhas.length ? 1 : 0);
