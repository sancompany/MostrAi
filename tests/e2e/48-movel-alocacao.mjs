// Ponto Móvel V1.1 (05/10/2026, migration 114): o móvel NÃO tem base — é
// equipamento itinerante e só tem local, horário e lugar no inventário
// enquanto está ALOCADO (hospedagem ativa ou evento em andamento). No
// navegador, de ponta a ponta, os quatro fluxos:
//   A — conta COM direito ativo de veiculação (plano vigente): vê a ação
//       secundária em Meus pontos, abre /hospedar.html, vê DADOS DA CONTA e o
//       formulário, escolhe "Em outro endereço" (os campos aparecem), envia,
//       vê "Interesse enviado"; duplo envio não duplica (banco = 1);
//   B — conta SEM direito: sem a ação em Meus pontos; /hospedar.html mostra o
//       requisito e "Ver planos"; visitante anônimo vê só o convite para
//       entrar; POST direto: 403 (logada) / 401 (anônimo);
//   C — Admin: cria o móvel pelo modal (só nome/foto/nota) → "Sem alocação" e
//       "Nenhum compromisso agendado"; o interesse chega "Com direito"; aprova
//       e agenda (data e hora + horário); um segundo agendamento no mesmo
//       período é recusado com o motivo; o anfitrião aceita o termo; o Admin
//       inicia → "Hospedado · … até …"; encerra → "Sem alocação" e o saldo;
//   D — móvel sem alocação não é inventário: fora de "Onde estamos" e da
//       escolha de pontos do anunciante; a playlist da tela dele é só
//       institucional (contrato do Player), enquanto a do ponto fixo leva a
//       campanha da conta.
// Banco zerado, servidor na 3999 e o .env carregado:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/48-movel-alocacao.mjs
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto, recarregarQuieto, redeQuieta } from './espera.mjs';

const B = 'http://localhost:3999';
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .split('\n')[0]
    .trim();
const falhas = [];
const erros = [];
const check = (t, cond, d) => {
  console.log(cond ? '  ok ' : '  FALHA', t, cond ? '' : d || '');
  if (!cond) falhas.push(t);
};
const shot = (alvo, nome, opcoes = {}) => alvo.screenshot({ path: `${SAIDA}v11-${nome}.png`, ...opcoes });

const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const marca = Date.now();
const SENHA = 'Senha123!';

// "2026-10-05T14:30" no relógio de Matão — o formato do datetime-local.
const parede = (deslocamentoMs) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(Date.now() + deslocamentoMs))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const HORA = 3600 * 1000;
const DIA = 24 * HORA;

async function cadastrar(nome, cpf, email) {
  const r = await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: nome,
      cpf_cnpj: cpf,
      contato_email: email,
      contato_telefone: '16999993333',
      senha: SENHA,
      aceitou_termos: true,
      endereco: 'Rua Nove, 90',
      cidade: 'Matão',
      uf: 'SP',
      cep: '15990000',
    }),
  });
  if (!r.ok) throw new Error(`cadastro ${email}: ${r.status} ${await r.text()}`);
  const id = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
  PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${id}`);
  return id;
}

// `permitir`: os status que o roteiro provoca de propósito naquela página
// (401 do anônimo/login, 403 do POST sem direito, 409 do agendamento em
// conflito) — conferidos na tela ou na resposta.
async function pagina(largura, altura, rotulo, permitir = /status of 401/) {
  const ctx = await navegador.newContext({ viewport: { width: largura, height: altura } });
  await ctx.route(/google\.com\/maps/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'mapa' }));
  await ctx.route(/viacep\.com\.br/, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        cep: '15990-540',
        logradouro: 'Avenida Sete de Setembro',
        bairro: 'Centro',
        localidade: 'Matão',
        uf: 'SP',
      }),
    }),
  );
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`[${rotulo}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() !== 'error' || /net::|ERR_FAILED/.test(m.text()) || permitir.test(m.text())) return;
    erros.push(`[${rotulo}] console: ${m.text()}`);
  });
  return p;
}

async function entrar(p, email) {
  await p.fill('#email', email);
  await p.fill('#senha', SENHA);
  await p.click('button[type="submit"]');
}

async function entrarConta(email, largura = 1280, altura = 1000, permitir) {
  const p = await pagina(largura, altura, `${email} ${largura}px`, permitir);
  await irQuieto(p, `${B}/anunciante/login.html`);
  await entrar(p, email);
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  // O painel assenta antes de o roteiro navegar (senão as buscas dele são
  // cortadas no meio e viram "Failed to fetch" no console).
  await redeQuieta(p);
  return p;
}

const semRolagemLateral = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// Meus pontos carregado (a lista vem de GET /anunciantes/me/meus-pontos).
async function meusPontos(p) {
  await p.waitForSelector('#modPontos:not([hidden]) #pontosLista > *', { timeout: 10000 });
  await redeQuieta(p);
  return p.locator('#modPontos');
}

// ---------------------------------------------------------------------------
// Contas e rede de teste
// ---------------------------------------------------------------------------
const emailEleg = `doceria-${marca}@teste.com`;
const ELEG = await cadastrar('Doceria Bom Gosto', '52998224725', emailEleg);
PG(
  `UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${ELEG}`,
);
const emailSem = `semplano-${marca}@teste.com`;
const SEM = await cadastrar('Oficina Sem Plano', '11144477735', emailSem);

// Um ponto FIXO no ar (24 h) — o controle positivo: aparece em "Onde estamos",
// na escolha de pontos e a TV dele leva a campanha da conta.
const H24 = JSON.stringify(
  Object.fromEntries(
    ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].map((d) => [d, { abre: '00:00', fecha: '24:00' }]),
  ),
);
const FIXO = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, horario_semanal)
   VALUES ('Mercado Central', 'Rua Dois, 2', 'Matão', 'SP', '15990000', 'outro', 'R', '1', '${H24}'::jsonb) RETURNING id`,
);
const TELA_FIXO = PG(
  `INSERT INTO dispositivos (ponto_id, apelido, status) VALUES (${FIXO}, 'Tela 1', 'ativo') RETURNING id`,
);

// Admin.
const admin = await pagina(1400, 960, 'admin', /status of (401|409)/);
await irQuieto(admin, `${B}/admin/index.html`);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('.admin-shell');
const apiAdmin = (caminho, metodo = 'GET', corpo) =>
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
const irAdmin = async (hash, seletor) => {
  await admin.evaluate((h) => {
    location.hash = h;
  }, hash);
  await admin.waitForSelector(seletor, { timeout: 10000 });
};

// TV instalada pelo contrato do Player: código do Admin → /player/provisionar.
await apiAdmin('/admin/player/pin-saida', 'PUT', { pin: '482715' });
async function tv(telaId) {
  const g = await apiAdmin(`/admin/dispositivos/${telaId}/codigo-instalacao`, 'POST');
  if (g.status !== 200 && g.status !== 201)
    throw new Error(`código de instalação: ${g.status} ${JSON.stringify(g.json)}`);
  const r = await fetch(`${B}/player/provisionar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Player-Version': '1.2.0+12' },
    body: JSON.stringify({ codigoTela: g.json.codigoTela, codigoInstalacao: g.json.codigo }),
  });
  const cred = await r.json();
  return async () => {
    const resp = await fetch(`${B}/playlist/${cred.dispositivoId}`, {
      headers: { 'X-Player-Version': '1.2.0+12', 'X-Aparelho-Key': cred.chaveAparelho },
    });
    return { status: resp.status, json: await resp.json().catch(() => null) };
  };
}
const playlistFixo = await tv(TELA_FIXO);

// A campanha da conta com plano: peça aprovada, valendo desde antes desta hora.
const IMAGEM = `${B}/img/exemplo-ponto-completo-720.jpg`;
const CRIATIVO = PG(
  `INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, thumbnail_url, duracao_segundos, status)
   VALUES (${ELEG}, '${IMAGEM}', '${IMAGEM}', '${IMAGEM}', 10, 'pendente') RETURNING id`,
);
const aprovado = await apiAdmin(`/admin/criativos/${CRIATIVO}`, 'PATCH', { status: 'aprovado' });
check('(preparo) peça da conta aprovada', aprovado.status === 200, JSON.stringify(aprovado.json));
PG(`UPDATE criativos SET aprovado_em = date_trunc('hour', now()) - interval '5 minutes' WHERE id = ${CRIATIVO}`);

// ===========================================================================
console.log('== B: sem direito ativo de veiculação ==');
// Painel, desktop e celular: Meus pontos sem a ação secundária.
for (const [largura, altura, sufixo] of [
  [1280, 1000, ''],
  [390, 844, '-390'],
]) {
  // 403: o POST direto sem direito, provocado abaixo.
  const p = await entrarConta(emailSem, largura, altura, /status of (401|403)/);
  const mod = await meusPontos(p);
  check(
    `sem direito ${largura}px: Meus pontos sem "Hospedar um Ponto Móvel"`,
    (await mod.locator('.ponto-movel-convite').count()) === 0,
  );
  check(`sem direito ${largura}px: "Quero ser um ponto" continua`, /Quero ser um ponto/.test(await mod.innerText()));
  if (largura === 390) check('sem direito 390px: sem rolagem lateral', await semRolagemLateral(p));
  await mod.scrollIntoViewIfNeeded();
  await shot(mod, `painel-meus-pontos-sem-direito${sufixo}`);
  // /hospedar.html: o requisito e "Ver planos", sem formulário.
  await irQuieto(p, `${B}/hospedar.html`);
  await p.waitForSelector('#hospedarConteudo .card h2');
  const conteudo = await p.locator('#hospedarConteudo').innerText();
  check(
    `sem direito ${largura}px: /hospedar.html diz o requisito`,
    /precisa ter direito ativo de veiculação: um plano vigente, benefício de mídia, Plano Básico ou saldo de horas/.test(
      conteudo,
    ),
    conteudo,
  );
  check(
    `sem direito ${largura}px: "Ver planos" leva a /planos.html`,
    (await p.locator('#hospedarConteudo a[href="/planos.html"]').innerText()).trim() === 'Ver planos',
  );
  check(`sem direito ${largura}px: sem formulário`, (await p.locator('#formHospedar').count()) === 0);
  if (largura === 390) check('sem direito 390px: /hospedar.html sem rolagem lateral', await semRolagemLateral(p));
  await shot(p, `hospedar-sem-direito${sufixo}`, { fullPage: true });
  if (largura === 1280) {
    // POST direto, com a sessão: o servidor decide (403 com o motivo).
    const r = await p.evaluate(async () => {
      const resp = await fetch('/hospedagem/interesse', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ local_tipo: 'conta' }),
      });
      return { status: resp.status, corpo: await resp.json() };
    });
    check('sem direito: POST /hospedagem/interesse → 403', r.status === 403, JSON.stringify(r));
    check(
      'sem direito: o motivo vem junto',
      r.corpo.motivo === 'sem_direito' && /plano ativo/.test(r.corpo.erro),
      JSON.stringify(r),
    );
    const painel = await p.evaluate(async () => {
      const resp = await fetch('/anunciantes/me/meus-pontos', { credentials: 'include' });
      return (await resp.json()).podeHospedarMovel;
    });
    check('sem direito: GET meus-pontos → podeHospedarMovel false', painel === false);
  }
  await p.context().close();
}
check(
  'sem direito: nenhum interesse gravado',
  PG(`SELECT COUNT(*) FROM hospedagem_interesses WHERE conta_id = ${SEM}`) === '0',
);

// Anônimo: convite para entrar, sem formulário; POST direto → 401.
const anonimo = await pagina(1280, 1000, 'anônimo');
await irQuieto(anonimo, `${B}/hospedar.html`);
await anonimo.waitForSelector('#hospedarConteudo .card h2');
check(
  'anônimo: "Entre na sua conta para pedir"',
  /Entre na sua conta para pedir/.test(await anonimo.locator('#hospedarConteudo').innerText()),
);
check(
  'anônimo: "Entrar na minha conta" volta para /hospedar.html',
  (await anonimo.locator('#hospedarConteudo a.btn').getAttribute('href')) ===
    '/anunciante/login.html?voltar=%2Fhospedar.html',
);
check('anônimo: sem formulário', (await anonimo.locator('#formHospedar').count()) === 0);
await anonimo.waitForFunction(() => /20%/.test(document.getElementById('hospPercentual')?.textContent || ''));
check('anônimo: o percentual vem do servidor', true);
await shot(anonimo, 'hospedar-anonimo', { fullPage: true });
const r401 = await fetch(`${B}/hospedagem/interesse`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ local_tipo: 'conta' }),
});
check('anônimo: POST /hospedagem/interesse → 401', r401.status === 401, String(r401.status));
await anonimo.context().close();

// ===========================================================================
console.log('== A: conta com direito (plano vigente) ==');
// Celular: anônimo → "Entrar na minha conta" → volta para /hospedar.html já
// com o formulário.
const celular = await pagina(390, 844, 'elegível 390px');
await irQuieto(celular, `${B}/hospedar.html`);
await celular.waitForSelector('#hospedarConteudo a.btn');
check('anônimo 390px: sem rolagem lateral', await semRolagemLateral(celular));
await shot(celular, 'hospedar-anonimo-390', { fullPage: true });
await celular.click('#hospedarConteudo a.btn');
await celular.waitForURL(/login\.html/);
await entrar(celular, emailEleg);
await celular.waitForURL(/\/hospedar\.html$/, { timeout: 10000 });
await celular.waitForSelector('#formHospedar');
check('login com ?voltar= devolve para /hospedar.html com o formulário', true);
check('elegível 390px: sem rolagem lateral', await semRolagemLateral(celular));
await shot(celular, 'hospedar-elegivel-390', { fullPage: true });
// Painel no celular: a ação secundária em Meus pontos.
await irQuieto(celular, `${B}/anunciante/painel.html`);
const modCel = await meusPontos(celular);
check(
  'elegível 390px: "Hospedar um Ponto Móvel" em Meus pontos',
  (await modCel.locator('.ponto-movel-convite').count()) === 1,
);
check('elegível 390px: painel sem rolagem lateral', await semRolagemLateral(celular));
await modCel.scrollIntoViewIfNeeded();
await shot(modCel, 'painel-meus-pontos-elegivel-390');
await celular.context().close();

// Desktop: painel → ação secundária → /hospedar.html → envia.
// 409: o PUT da escolha com o móvel sem alocação, provocado em D.
const pE = await entrarConta(emailEleg, 1280, 1000, /status of (401|409)/);
const modE = await meusPontos(pE);
const convite = modE.locator('.ponto-movel-convite');
check('elegível: a ação secundária aparece uma vez', (await convite.count()) === 1);
check(
  'elegível: "Já anuncia na Mostraí? Hospedar um Ponto Móvel"',
  /Já anuncia na Mostraí\?\s*Hospedar um Ponto Móvel/.test(await convite.innerText()),
);
check('elegível: "Quero ser um ponto" continua a ação principal', /Quero ser um ponto/.test(await modE.innerText()));
await modE.scrollIntoViewIfNeeded();
await shot(modE, 'painel-meus-pontos-elegivel');
check('elegível: painel sem módulo de hospedagem antes do interesse', await pE.locator('#modHospedagem').isHidden());

await convite.locator('a[href="/hospedar.html"]').click();
await pE.waitForURL(/\/hospedar\.html$/);
await pE.waitForSelector('#formHospedar');
await redeQuieta(pE);
const formTexto = await pE.locator('#formHospedar').innerText();
check('formulário: "DADOS DA CONTA"', /DADOS DA CONTA/i.test(formTexto), formTexto);
check(
  'formulário: empresa e e-mail da conta, sem pedir de novo',
  formTexto.includes('Doceria Bom Gosto') && formTexto.includes(emailEleg),
);
check(
  'formulário: sem campo de empresa/responsável/telefone',
  (await pE.locator('#formHospedar input[name="empresa"], #formHospedar input[name="contato_telefone"]').count()) === 0,
);
check(
  'formulário: "No endereço da minha conta" marcado por padrão',
  await pE.isChecked('#formHospedar input[name="local_tipo"][value="conta"]'),
);
check(
  'formulário: sem equipamento, data, percentual ou termo',
  (await pE
    .locator(
      '#formHospedar input[type="date"], #formHospedar input[type="datetime-local"], #formHospedar select[name="ponto"]',
    )
    .count()) === 0,
);
check('formulário: endereço "outro" escondido de início', await pE.locator('#formHospedar #h_cep').isHidden());
await pE.waitForFunction(() => /20%/.test(document.getElementById('hospPercentual')?.textContent || ''));
await shot(pE, 'hospedar-elegivel', { fullPage: true });

// "Em outro endereço": os campos aparecem; de volta à conta, somem.
await pE.check('#formHospedar input[name="local_tipo"][value="outro"]');
check('"Em outro endereço" mostra os campos', await pE.locator('#formHospedar #h_cep').isVisible());
await pE.check('#formHospedar input[name="local_tipo"][value="conta"]');
check('"endereço da conta" esconde os campos', await pE.locator('#formHospedar #h_cep').isHidden());
await pE.check('#formHospedar input[name="local_tipo"][value="outro"]');
await pE.fill('#hospLocalNome', 'Quiosque do Shopping');
await pE.fill('#h_cep', '15990-540');
await pE.locator('#h_cep').blur();
await pE.waitForFunction(() => document.querySelector('#formHospedar [data-cep-msg]')?.dataset.estado === 'encontrado');
await pE.fill('#h_numero', '1500');
await pE.fill('#hospObservacao', 'Movimento forte aos sábados');
await shot(pE, 'hospedar-elegivel-outro-endereco', { fullPage: true });
// Duplo clique no envio: a trava do botão segura o segundo.
await pE.locator('#hospEnviar').dblclick();
await pE.waitForFunction(
  () => /Interesse enviado/.test(document.getElementById('hospedarConteudo')?.textContent || ''),
  null,
  {
    timeout: 10000,
  },
);
check('depois de enviar: "Interesse enviado"', true);
check('depois de enviar: o formulário some', (await pE.locator('#formHospedar').count()) === 0);
await shot(pE, 'hospedar-interesse-enviado', { fullPage: true });
// Reenvio direto (retry da rede, duas abas): devolve o mesmo, sem duplicar.
const repetidos = await pE.evaluate(async () => {
  const um = () =>
    fetch('/hospedagem/interesse', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local_tipo: 'conta' }),
    }).then(async (r) => ({ status: r.status, corpo: await r.json() }));
  return Promise.all([um(), um()]);
});
check(
  'reenvio: 200 "jaRecebido"',
  repetidos.every((r) => r.status === 200 && r.corpo.jaRecebido),
  JSON.stringify(repetidos),
);
check(
  'duplo envio não duplica (banco = 1)',
  PG(`SELECT COUNT(*) FROM hospedagem_interesses WHERE conta_id = ${ELEG}`) === '1',
);
const INTERESSE = PG(`SELECT id FROM hospedagem_interesses WHERE conta_id = ${ELEG}`);
check(
  'interesse gravado com o outro endereço e o nome do local',
  PG(
    `SELECT local_tipo || '|' || local_nome || '|' || numero || '|' || status FROM hospedagem_interesses WHERE id = ${INTERESSE}`,
  ) === 'outro|Quiosque do Shopping|1500|nova',
);
check(
  'interesse não reserva nada',
  PG(`SELECT COUNT(*) FROM pontos_moveis_hospedagens WHERE conta_id = ${ELEG}`) === '0',
);
// No painel, o andamento.
await irQuieto(pE, `${B}/anunciante/painel.html`);
await pE.waitForSelector('#modHospedagem:not([hidden]) [data-hosp-interesse]', { timeout: 10000 });
check(
  'painel: andamento "Interesse enviado"',
  /Interesse enviado/.test(await pE.locator('#modHospedagem').innerText()),
);

// ===========================================================================
console.log('== C: Admin cria o móvel ==');
await irAdmin('rede/moveis', '[data-criar-movel]');
await admin.waitForSelector(`[data-interesse-id="${INTERESSE}"]`);
await shot(admin, 'admin-pontos-moveis', { fullPage: true });
await admin.click('[data-criar-movel]');
await admin.waitForSelector('#formCriarMovel');
const camposDoModal = await admin.$$eval('#formCriarMovel [name]', (els) => els.map((e) => e.name).sort());
check(
  'modal "Criar ponto móvel": só nome, foto e nota',
  JSON.stringify(camposDoModal) === '["foto","nome","observacoes"]',
  JSON.stringify(camposDoModal),
);
check(
  'modal: sem base, endereço, ramo ou horário',
  (await admin
    .locator('#formCriarMovel [data-cep], #formCriarMovel [data-horario-alocacao], #formCriarMovel select')
    .count()) === 0,
);
await admin.fill('#cmNota', 'Kit 1 — TV 43" com suporte de chão');
await shot(admin, 'admin-criar-movel');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForSelector('.movel-card', { timeout: 10000 });
const PONTO = PG(`SELECT id FROM pontos WHERE tipo = 'movel' ORDER BY id DESC LIMIT 1`);
const NOME = PG(`SELECT nome FROM pontos WHERE id = ${PONTO}`);
check('nome automático "Mostraí Móvel #NN"', /^Mostraí Móvel #\d{2,}$/.test(NOME), NOME);
check(
  'nasce sem dono, sem base, sem endereço e com a nota',
  PG(
    `SELECT concat_ws('|', COALESCE(anunciante_id::text, 'sem dono'), COALESCE(base_conta_id::text, 'sem base'), COALESCE(endereco, 'sem endereço'), observacoes) FROM pontos WHERE id = ${PONTO}`,
  ) === 'sem dono|sem base|sem endereço|Kit 1 — TV 43" com suporte de chão',
);
check('a Tela 1 nasce junto', PG(`SELECT COUNT(*) FROM dispositivos WHERE ponto_id = ${PONTO}`) === '1');
const cardMovel = admin.locator(`.movel-card[data-movel-id="${PONTO}"]`);
const cardTexto = () => cardMovel.innerText();
check('card: AGORA "Sem alocação"', /AGORA\s+Sem alocação/.test(await cardTexto()), await cardTexto());
check(
  'card: PRÓXIMO "Nenhum compromisso agendado"',
  /PRÓXIMO\s+Nenhum compromisso agendado/.test(await cardTexto()),
  await cardTexto(),
);
await shot(cardMovel, 'admin-card-sem-alocacao');

// ===========================================================================
console.log('== D: móvel sem alocação não é inventário ==');
const TELA_MOVEL = PG(`SELECT id FROM dispositivos WHERE ponto_id = ${PONTO} ORDER BY id LIMIT 1`);
const playlistMovel = await tv(TELA_MOVEL);
const plMovel = await playlistMovel();
const itensMovel = plMovel.json?.itens || [];
check(
  'playlist do móvel: responde 200 com itens',
  plMovel.status === 200 && itensMovel.length > 0,
  JSON.stringify(plMovel).slice(0, 300),
);
check(
  'playlist do móvel: só institucional (nenhuma campanha, nada contabiliza)',
  itensMovel.every((i) => i.institucional === true && i.anuncianteId === null && i.contabiliza === false),
  JSON.stringify(itensMovel.slice(0, 3)),
);
const plFixo = await playlistFixo();
check(
  'controle: a playlist do ponto fixo leva a campanha da conta',
  (plFixo.json?.itens || []).some((i) => String(i.anuncianteId) === ELEG),
  JSON.stringify(plFixo.json?.itens?.slice(0, 3)),
);
check(
  'móvel sem alocação: nenhuma programada gravada',
  PG(
    `SELECT COUNT(*) FROM exibicoes_contador e JOIN dispositivos d ON d.id = e.dispositivo_id WHERE d.ponto_id = ${PONTO}`,
  ) === '0',
);
const vitrine = await (await fetch(`${B}/pontos`)).json();
check(
  'GET /pontos: o fixo aparece',
  vitrine.some((p) => String(p.id) === FIXO),
);
check(
  'GET /pontos: o móvel sem alocação não aparece',
  !vitrine.some((p) => String(p.id) === PONTO),
  JSON.stringify(vitrine.map((p) => p.id)),
);
const onde = await pagina(1280, 1000, 'onde estamos');
await irQuieto(onde, `${B}/pontos.html`);
await onde.waitForSelector('#pontosGrid .ponto-card');
const grade = await onde.locator('#pontosGrid').innerText();
check('"Onde estamos": o fixo aparece', grade.includes('Mercado Central'), grade);
check('"Onde estamos": o móvel sem alocação não aparece', !grade.includes(NOME) && !/Ponto móvel/.test(grade), grade);
await onde.locator('#pontosGrid').scrollIntoViewIfNeeded();
await shot(onde, 'onde-estamos', { fullPage: true });
// Escolha de pontos do anunciante.
await recarregarQuieto(pE);
await pE.waitForSelector('#listaPontos .ponto-escolha', { timeout: 10000 });
check('escolha de pontos: o fixo aparece', (await pE.locator(`.ponto-escolha[data-ponto-id="${FIXO}"]`).count()) === 1);
check(
  'escolha de pontos: o móvel sem alocação não aparece',
  (await pE.locator(`.ponto-escolha[data-ponto-id="${PONTO}"]`).count()) === 0,
);
const disponiveis = await pE.evaluate(async () =>
  (await (await fetch('/anunciantes/me/pontos-disponiveis', { credentials: 'include' })).json()).pontos.map(
    (p) => p.id,
  ),
);
check('GET pontos-disponiveis: sem o móvel', !disponiveis.map(String).includes(PONTO), JSON.stringify(disponiveis));
const escolherMovel = await pE.evaluate(async (id) => {
  const r = await fetch('/anunciantes/me/pontos', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pontos: [Number(id)] }),
  });
  return r.status;
}, PONTO);
check('PUT da escolha com o móvel sem alocação → 409', escolherMovel === 409, String(escolherMovel));
await pE.locator('#painelPontos').scrollIntoViewIfNeeded();
await shot(pE.locator('#painelPontos'), 'selecao-pontos-anunciante');

// ===========================================================================
console.log('== C: interesse → aprovar → agendar ==');
await irAdmin('rede/moveis', `[data-interesse-id="${INTERESSE}"]`);
const linha = admin.locator(`[data-interesse-id="${INTERESSE}"]`);
const linhaTexto = await linha.innerText();
check('interesse: "Com direito" (plano vigente)', /Com direito[\s\S]*plano vigente/.test(linhaTexto), linhaTexto);
check(
  'interesse: outro endereço com o nome do local',
  /Outro endereço: Quiosque do Shopping/.test(linhaTexto),
  linhaTexto,
);
check('interesse: observação da conta', /Movimento forte aos sábados/.test(linhaTexto), linhaTexto);
check('interesse: "Recebido"', /Recebido/.test(linhaTexto), linhaTexto);
await shot(linha, 'admin-interesse-recebido');
await admin.click(`[data-interesse-acao="aprovada"][data-interesse="${INTERESSE}"]`);
await admin.waitForFunction(
  (id) => /Aprovado para agendamento/.test(document.querySelector(`[data-interesse-id="${id}"]`)?.textContent || ''),
  INTERESSE,
);
check(
  'aprovar: "Aprovado para agendamento" (banco: aprovada)',
  PG(`SELECT status FROM hospedagem_interesses WHERE id = ${INTERESSE}`) === 'aprovada',
);
await admin.click(`[data-interesse-acao="agendar"][data-interesse="${INTERESSE}"]`);
await admin.waitForSelector('#formHospedagem');
check('agendar: a conta vem do interesse', (await admin.inputValue('#hoConta')) === `Doceria Bom Gosto (#${ELEG})`);
check('agendar: o local vem do interesse', (await admin.inputValue('#hoLocal')) === 'Quiosque do Shopping');
check(
  'agendar: início e fim com data e hora',
  (await admin.locator('#hoInicio[type="datetime-local"], #hoFim[type="datetime-local"]').count()) === 2,
);
const linhasHorario = await admin.$$eval('#formHospedagem [data-horario-alocacao] .horario-editor-linha', (ls) =>
  ls.map(
    (l) =>
      `${l.dataset.dia}:${l.querySelector('select').value}:${l.querySelector('[data-abre]').value}-${l.querySelector('[data-fecha]').value}`,
  ),
);
check(
  'horário: os 7 dias e feriados, padrão 08:00–18:00 (nunca 24 h automático)',
  linhasHorario.length === 8 && linhasHorario.every((l) => /:faixa:08:00-18:00$/.test(l)),
  JSON.stringify(linhasHorario),
);
await admin.selectOption('#hoMovel', PONTO);
const INICIO = parede(-6 * HORA);
const FIM = parede(2 * DIA);
await admin.fill('#hoInicio', INICIO);
await admin.fill('#hoFim', FIM);
await admin.click('#formHospedagem [data-tudo-24h]');
check(
  '"Aberto 24 horas todos os dias" marca todas as linhas',
  (await admin.$$eval('#formHospedagem [data-horario-alocacao] select', (ss) => ss.map((s) => s.value))).every(
    (v) => v === '24h',
  ),
);
check(
  'revisão: "ficará vinculada a 20%"',
  /ficará vinculada a 20%/.test(await admin.locator('[data-revisao-percentual]').innerText()),
);
await shot(admin.locator('dialog[open]'), 'admin-agendar-hospedagem');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(
  (id) => /Agendado/.test(document.querySelector(`[data-interesse-id="${id}"]`)?.textContent || ''),
  INTERESSE,
  { timeout: 10000 },
);
const HOSP = PG(`SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = ${PONTO}`);
check(
  'hospedagem programada: conta, local, 20% e horário 24 h',
  PG(
    `SELECT concat_ws('|', conta_id, local, estado, percentual, horario_operacao->'dom'->>'fecha', interesse_id) FROM pontos_moveis_hospedagens WHERE id = ${HOSP}`,
  ) === `${ELEG}|Quiosque do Shopping|programada|20.00|24:00|${INTERESSE}`,
);
check(
  'o interesse virou "agendada"',
  PG(`SELECT status FROM hospedagem_interesses WHERE id = ${INTERESSE}`) === 'agendada',
);
await admin.waitForFunction(
  (id) =>
    /PRÓXIMO\s+Hospedagem · Quiosque do Shopping/.test(
      document.querySelector(`.movel-card[data-movel-id="${id}"]`)?.innerText || '',
    ),
  PONTO,
);
check('card: PRÓXIMO "Hospedagem · Quiosque do Shopping"', true);
check(
  'card: ainda "Sem alocação" (agendar não inicia)',
  /AGORA\s+Sem alocação/.test(await cardTexto()),
  await cardTexto(),
);

// Conflito: a agenda é única — outro agendamento no mesmo período é recusado.
await irAdmin(`rede/pontos/${PONTO}`, '#pontoMovel [data-nova-hospedagem]');
await admin.click('#pontoMovel [data-nova-hospedagem]');
await admin.waitForSelector('#formHospedagem');
await admin.fill('#hoConta', `Oficina Sem Plano (#${SEM})`);
await admin.fill('#hoLocal', 'Oficina Sem Plano');
await admin.fill('#hoInicio', parede(DIA));
await admin.fill('#hoFim', parede(3 * DIA));
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() =>
  /já está hospedado/.test(document.querySelector('dialog[open] [data-msg]')?.textContent || ''),
);
const msgConflito = await admin.locator('dialog[open] [data-msg]').innerText();
check(
  'conflito: recusado com o motivo',
  /O ponto móvel já está hospedado em “Quiosque do Shopping” nesse período \(\d\d\/\d\d \d\d:\d\d a \d\d\/\d\d \d\d:\d\d\)/.test(
    msgConflito,
  ),
  msgConflito,
);
check('conflito: nada gravado', PG(`SELECT COUNT(*) FROM pontos_moveis_hospedagens WHERE ponto_id = ${PONTO}`) === '1');
await shot(admin.locator('dialog[open]'), 'admin-agendar-conflito');
await admin.click('dialog[open] [data-fechar]');

// Ficha: agenda com a hospedagem programada; iniciar travado sem o aceite.
await admin.waitForSelector(`#pontoMovel [data-agenda] [data-hospedagem-id="${HOSP}"]`);
const ficha = () => admin.locator('#pontoMovel').innerText();
check('ficha: AGORA "Sem alocação"', /Sem alocação/.test(await admin.locator('[data-local-atual]').innerText()));
check(
  'ficha: PRÓXIMO com a hospedagem',
  /Hospedagem · Quiosque do Shopping/.test(await admin.locator('[data-proximo]').innerText()),
);
check('ficha: fora do inventário', /Inventário\s+Não/.test(await ficha()), await ficha());
check('ficha: "Iniciar" travado sem o aceite', await admin.locator('[data-hosp-acao="iniciar"]').isDisabled());
check('ficha: aviso de termo pendente', /Aguardando o anfitrião aceitar o termo/.test(await ficha()));
check('ficha: o horário da hospedagem', /horário: [^\n]*24/i.test(await ficha()), await ficha());
check(
  'ficha sem base nem endereço próprio',
  !/\bBase\b|Alterar base/.test(await ficha()) && (await admin.locator('#pontoEndereco').count()) === 0,
);
await shot(admin, 'admin-ficha-movel-programada', { fullPage: true });

// O anfitrião aceita o termo pelo painel.
await recarregarQuieto(pE);
await pE.waitForSelector('#modHospedagem:not([hidden]) [data-hosp-termo]', { timeout: 10000 });
check(
  'painel: "Ponto Móvel programado"',
  /Agendado[\s\S]*Ponto Móvel programado[\s\S]*Quiosque do Shopping/.test(
    await pE.locator('#modHospedagem').innerText(),
  ),
);
await pE.click('[data-hosp-termo]');
await pE.waitForSelector('dialog.dlg-termo[open]');
const termo = await pE.locator('dialog.dlg-termo[open]').innerText();
check(
  'termo: dados da hospedagem (local, horário, 20%)',
  /Quiosque do Shopping[\s\S]*Horário de funcionamento[\s\S]*20%/.test(termo),
  termo.slice(-600),
);
await pE.fill('#termoResponsavel', 'Marina Doce');
await pE.check('dialog.dlg-termo[open] input[name="concordo"]');
await pE.click('dialog.dlg-termo[open] button[type="submit"]');
await pE.waitForFunction(() => !document.querySelector('dialog.dlg-termo[open]'));
await pE.waitForFunction(() =>
  /Termo de hospedagem aceito/.test(document.getElementById('modHospedagem')?.textContent || ''),
);
check(
  'aceite gravado (minuta-2)',
  PG(`SELECT termo_versao FROM hospedagem_aceites WHERE hospedagem_id = ${HOSP}`) === 'minuta-2',
);

// Iniciar (a tela chegou), com a entrega.
await recarregarQuieto(admin);
await admin.waitForSelector('[data-hosp-acao="iniciar"]:not([disabled])', { timeout: 10000 });
await admin.click('[data-hosp-acao="iniciar"]');
await admin.waitForSelector('#formAcaoHosp');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() =>
  /Hospedado · Quiosque do Shopping/.test(document.querySelector('[data-local-atual]')?.textContent || ''),
);
const agoraFicha = await admin.locator('[data-local-atual]').innerText();
check(
  'ficha: AGORA "Hospedado · Quiosque do Shopping até …"',
  /Hospedado · Quiosque do Shopping\s*até \d\d\/\d\d \d\d:\d\d · Doceria Bom Gosto/.test(agoraFicha),
  agoraFicha,
);
check('ficha: no inventário', /Inventário\s+Sim — alocado/.test(await ficha()));
check(
  'banco: hospedagem ativa com a entrega',
  PG(
    `SELECT h.estado || ':' || m.condicao FROM pontos_moveis_hospedagens h JOIN hospedagem_movimentacoes m ON m.hospedagem_id = h.id AND m.tipo = 'entrega' WHERE h.id = ${HOSP}`,
  ) === 'ativa:ok',
);
await shot(admin, 'admin-ficha-movel-hospedado', { fullPage: true });
await irAdmin('rede/moveis', `.movel-card[data-movel-id="${PONTO}"]`);
check(
  'card: AGORA "Hospedado · Quiosque do Shopping até …"',
  /AGORA\s+Hospedado · Quiosque do Shopping até \d\d\/\d\d \d\d:\d\d/.test(await cardTexto()),
  await cardTexto(),
);
check(
  'card: PRÓXIMO "Nenhum compromisso agendado"',
  /PRÓXIMO\s+Nenhum compromisso agendado/.test(await cardTexto()),
  await cardTexto(),
);
await shot(cardMovel, 'admin-card-hospedado');

// Alocado, é inventário: aparece em "Onde estamos" e na escolha de pontos.
const vitrineAlocada = await (await fetch(`${B}/pontos`)).json();
const naVitrine = vitrineAlocada.find((p) => String(p.id) === PONTO);
check(
  'alocado: GET /pontos traz o móvel com o local da hospedagem',
  naVitrine?.local_atual === 'Quiosque do Shopping',
  JSON.stringify(naVitrine),
);
await recarregarQuieto(onde);
await onde.waitForSelector('#pontosGrid .ponto-card');
check(
  'alocado: "Onde estamos" mostra "Agora em: Quiosque do Shopping"',
  /Agora em: Quiosque do Shopping/.test(await onde.locator('#pontosGrid').innerText()),
);
await shot(onde, 'onde-estamos-alocado', { fullPage: true });
await recarregarQuieto(pE);
await pE.waitForSelector(`.ponto-movel[data-ponto-id="${PONTO}"]`, { timeout: 10000 });
const cardEscolha = await pE.locator(`.ponto-movel[data-ponto-id="${PONTO}"]`).innerText();
check(
  'alocado: a escolha de pontos mostra o móvel "Agora em: Quiosque do Shopping"',
  /Agora em: Quiosque do Shopping/.test(cardEscolha),
  cardEscolha,
);
check('alocado: o card não mostra conta, percentual nem saldo', !/Doceria|%|saldo/i.test(cardEscolha), cardEscolha);
await shot(pE.locator('#painelPontos'), 'selecao-pontos-anunciante-alocado');

// A tela operou 3 h desde que chegou (24 h de horário: tudo válido).
PG(`UPDATE pontos_moveis_hospedagens SET iniciada_em = now() - interval '4 hours' WHERE id = ${HOSP}`);
PG(
  `INSERT INTO tela_operacao (dispositivo_id, ponto_id, origem, inicio, fim) VALUES (${TELA_MOVEL}, ${PONTO}, 'heartbeat', now() - interval '3 hours 30 minutes', now() - interval '30 minutes')`,
);

// Encerrar: volta a "Sem alocação" e o benefício vira saldo.
await irAdmin(`rede/pontos/${PONTO}`, '[data-hosp-acao="encerrar"]');
await admin.click('[data-hosp-acao="encerrar"]');
await admin.waitForSelector('#formAcaoHosp');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(
  () => /Sem alocação/.test(document.querySelector('[data-local-atual]')?.textContent || ''),
  null,
  {
    timeout: 10000,
  },
);
check('encerrar: ficha volta a "Sem alocação"', true);
check('encerrar: fora do inventário de novo', /Inventário\s+Não/.test(await ficha()));
check(
  'encerrar: benefício de 36 min no livro',
  PG(`SELECT segundos FROM saldo_hospedagem_lancamentos WHERE hospedagem_id = ${HOSP}`) === '2160',
);
check(
  'encerrar: a hospedagem vai para o histórico',
  /Hospedagens[\s\S]*Hospedagem · Quiosque do Shopping[\s\S]*Encerrada/.test(await ficha()),
);
await shot(admin, 'admin-ficha-movel-encerrada', { fullPage: true });
await irAdmin('rede/moveis', `.movel-card[data-movel-id="${PONTO}"]`);
check('card: AGORA "Sem alocação" de novo', /AGORA\s+Sem alocação/.test(await cardTexto()), await cardTexto());
check(
  '/pontos: o móvel some de novo',
  !(await (await fetch(`${B}/pontos`)).json()).some((p) => String(p.id) === PONTO),
);
const plDepois = await playlistMovel();
check(
  'playlist do móvel: só institucional de novo',
  (plDepois.json?.itens || []).every((i) => i.institucional === true),
);
await recarregarQuieto(pE);
await pE.waitForFunction(
  () => /Saldo de hospedagem/i.test(document.getElementById('modHospedagem')?.textContent || ''),
  null,
  {
    timeout: 10000,
  },
);
const painelHosp = await pE.locator('#modHospedagem').innerText();
check(
  'painel: SALDO DE HOSPEDAGEM com 36 min disponíveis',
  /Saldo de hospedagem[\s\S]*36 min[\s\S]*disponíveis/i.test(painelHosp),
  painelHosp,
);
check(
  'painel: concluída com as horas recebidas',
  /Concluída[\s\S]*Horas recebidas[\s\S]*36 min/.test(painelHosp),
  painelHosp,
);
await shot(pE.locator('#modHospedagem'), 'painel-saldo-hospedagem');

check('sem erro de console/página', erros.length === 0, erros.join(' | '));
await navegador.close();
if (falhas.length) {
  console.log(`\n${falhas.length} falha(s)`);
  process.exit(1);
}
console.log('\ntudo ok');
