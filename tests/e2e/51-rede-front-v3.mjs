// REDE FRONT V3 (06/10/2026) — Rede, pontos, telas e compromissos móveis, no
// navegador, de ponta a ponta:
//   A. Grade: resumo (Pontos, Telas, Operando, Sem comunicação, Com problema,
//      Aguardando instalação) somado do MESMO estado dos cards; chips "Com
//      problema" e "Sem comunicação" separados; busca pelo código da tela;
//      card fixo e card móvel no mesmo molde (MÓVEL · Ativa); Visão geral
//      com "com problema" urgente e "sem comunicação" à parte.
//   B. Ficha da rede móvel: cabeçalho (N telas · X operando · Y compromissos
//      futuros), ⋯, COMPROMISSOS vazio, telas operacionais — a tela calada e
//      sem compromisso é "Sem comunicação · Sem alocação", NUNCA problema.
//   C. Compromisso NA CONTA: busca de conta com homônimos (cidade), endereço
//      e horário do ponto da conta (cópia), benefício, termo físico pendente.
//   D. Compromisso EM OUTRO LOCAL: endereço em partes, várias telas, período
//      curto = "durante todo o período"; vários dias sem horário escolhido é
//      recusado; tela ocupada desabilitada; conflito por tela no servidor.
//   E. Ficha da tela (resumo + Operação/Player/Configuração/Ações), ficha do
//      ponto fixo e 390 px sem rolagem lateral.
// Banco zerado, servidor na 3999 e o .env carregado:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/51-rede-front-v3.mjs
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto, redeQuieta } from './espera.mjs';

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
const shot = (alvo, nome, opcoes = {}) => alvo.screenshot({ path: `${SAIDA}rede-v3-${nome}.png`, ...opcoes });
const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const marca = Date.now();

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
// Um dia inteiro adiante, às HH:MM (Matão).
const diaAs = (dias, hhmm) => `${parede(dias * DIA).slice(0, 10)}T${hhmm}`;

async function cadastrar(nome, cpf, email, cidade) {
  const r = await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: nome,
      cpf_cnpj: cpf,
      contato_email: email,
      contato_telefone: '16999993333',
      senha: 'Senha123!',
      aceitou_termos: true,
      endereco: 'Rua Nove, 90',
      cidade,
      uf: 'SP',
      cep: '15990000',
    }),
  });
  if (!r.ok) throw new Error(`cadastro ${email}: ${r.status} ${await r.text()}`);
  const id = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
  PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${id}`);
  return id;
}

async function pagina(largura, altura, rotulo, permitir = /status of 401/) {
  const ctx = await navegador.newContext({ viewport: { width: largura, height: altura } });
  await ctx.route(/google\.com\/maps/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'mapa' }));
  await ctx.route(/viacep\.com\.br/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"erro":true}' }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`[${rotulo}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() !== 'error' || /net::|ERR_FAILED/.test(m.text()) || permitir.test(m.text())) return;
    erros.push(`[${rotulo}] console: ${m.text()}`);
  });
  return p;
}
const semRolagemLateral = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ---------------------------------------------------------------------------
// Cenário
// ---------------------------------------------------------------------------
const PADARIA = await cadastrar('Padaria Central', '52998224725', `padaria-${marca}@teste.com`, 'Matão');
PG(
  `UPDATE anunciantes SET logradouro = 'Rua das Flores', numero = '120', bairro = 'Centro', cep = '15990-000', cidade = 'Matão', uf = 'SP' WHERE id = ${PADARIA}`,
);
// Homônimo em outra cidade: o seletor precisa distinguir.
const HOMONIMO = await cadastrar('Padaria Central', '11144477735', `padaria2-${marca}@teste.com`, 'Araraquara');
PG(`UPDATE anunciantes SET cidade = 'Araraquara', uf = 'SP' WHERE id = ${HOMONIMO}`);
const MERCADO = await cadastrar('Mercado Bom Preço', '39053344705', `mercado-${marca}@teste.com`, 'Matão');

const admin = await pagina(1400, 960, 'admin', /status of (400|401|404|409)/);
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
  await redeQuieta(admin);
};
const modal = () => admin.locator('dialog[open]').last();
// Envia o formulário de compromisso e espera fechar; se não fechar, diz o
// porquê (a mensagem do modal) em vez de só estourar o tempo.
async function enviarCompromisso(rotulo) {
  await modal().locator('button[type=submit]').click();
  try {
    await admin.waitForFunction(() => !document.querySelector('dialog[open] #formCompromisso'), null, { timeout: 10000 });
    return true;
  } catch {
    const msg = await modal().locator('[data-msg]').innerText().catch(() => '?');
    check(`${rotulo}: o modal fechou`, false, msg);
    await admin.keyboard.press('Escape');
    return false;
  }
}

// Ponto fixo da Padaria, com horário (o "horário do local" do compromisso).
const HORARIO_PADARIA = {
  seg: { abre: '07:00', fecha: '19:00' },
  ter: { abre: '07:00', fecha: '19:00' },
  qua: { abre: '07:00', fecha: '19:00' },
  qui: { abre: '07:00', fecha: '19:00' },
  sex: { abre: '07:00', fecha: '19:00' },
  sab: { abre: '07:00', fecha: '13:00' },
  dom: null,
  feriados: null,
};
const criarFixo = async (conta, nome, horario) => {
  const r = await apiAdmin(`/admin/anunciantes/${conta}/pontos`, 'POST', {
    nome,
    cep: '15990-000',
    logradouro: 'Rua das Flores',
    numero: '120',
    bairro: 'Centro',
    cidade: 'Matão',
    uf: 'SP',
    responsavel_nome: 'Ana',
    responsavel_contato: '16988887777',
    horario_semanal: horario,
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`ponto ${nome}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.id || r.json.ponto?.id;
};
const PONTO_A = await criarFixo(PADARIA, 'Padaria Central — Loja 1', HORARIO_PADARIA);
const PONTO_B = await criarFixo(MERCADO, 'Mercado Bom Preço', null);
const telaNova = async (ponto) => (await apiAdmin(`/admin/pontos/${ponto}/dispositivos`, 'POST', {})).json.id;
const CHAVE = `md5(random()::text) || md5(random()::text)`;
// A1: comunicando agora. A2: calada há 3 h (ponto fixo) → sem comunicação.
const A1 = await telaNova(PONTO_A);
PG(`UPDATE dispositivos SET chave_hash = ${CHAVE}, primeiro_sinal_em = now(), ultima_vez_online = now() WHERE id = ${A1}`);
const A2 = await telaNova(PONTO_A);
PG(
  `UPDATE dispositivos SET chave_hash = ${CHAVE}, primeiro_sinal_em = now() - interval '2 days', ultima_vez_online = now() - interval '3 hours' WHERE id = ${A2}`,
);
// B1: comunicando, com PLAYBACK_ERROR → COM PROBLEMA (evidência real).
const B1 = await telaNova(PONTO_B);
PG(
  `UPDATE dispositivos SET chave_hash = ${CHAVE}, primeiro_sinal_em = now(), ultima_vez_online = now(), player_estado = 'PLAYBACK_ERROR', ultimo_erro_codigo = 'PLAYBACK_ERROR', ultimo_erro = 'decoder', ultimo_erro_em = now() WHERE id = ${B1}`,
);

// Rede móvel: M1 é o caso real (M-0010) — Player instalado, último contato
// há 8 h, nenhum compromisso. M2 ainda sem Player.
const rede = await apiAdmin('/admin/pontos-moveis', 'POST', { nome: 'Mostraí Móvel', cidade: 'Matão', uf: 'SP' });
const REDE = rede.json.id;
const M1 = await telaNova(REDE);
PG(
  `UPDATE dispositivos SET chave_hash = ${CHAVE}, primeiro_sinal_em = now() - interval '3 days', ultima_vez_online = now() - interval '8 hours', player_estado = 'PLAYING', player_versao = '3.0.0', fila_pendentes = 0 WHERE id = ${M1}`,
);
const M2 = await telaNova(REDE);
const codigo = (id) => `M-${String(id).padStart(4, '0')}`;

// ---------------------------------------------------------------------------
console.log('== A. Grade ==');
await irAdmin('#rede/pontos', '.rede-resumo');
const resumo = await admin.locator('.rede-resumo').innerText();
const numeroDe = (rotulo) => {
  const m = new RegExp(`(\\d+)\\s*\\n?\\s*${rotulo}`, 'i').exec(resumo);
  return m ? Number(m[1]) : null;
};
check('resumo: 3 pontos', numeroDe('pontos') === 3, resumo);
check('resumo: 5 telas', numeroDe('telas') === 5, resumo);
check('resumo: 2 sem comunicação (A2 e M1)', numeroDe('sem comunicação') === 2, resumo);
check('resumo: 1 com problema (só B1)', numeroDe('com problema') === 1, resumo);
const cardRede = admin.locator(`.ponto-card[href="#rede/pontos/${REDE}"]`);
const textoCardRede = await cardRede.innerText();
check('card móvel: selo MÓVEL', /MÓVEL/.test(textoCardRede), textoCardRede);
check('card móvel: sem ITINERANTE', !/itinerante/i.test(textoCardRede));
check('card móvel: Local atual / Próximo', /Local atual/i.test(textoCardRede) && /Próximo/i.test(textoCardRede));
check('card móvel: sem comunicação, não problema', /sem comunicação/.test(textoCardRede) && !/com problema/.test(textoCardRede));
check('card móvel: [Abrir]', /Abrir/.test(textoCardRede));
const filtroRede = await cardRede.getAttribute('data-filtro');
check('card móvel: filtros movel + sem_comunicacao, sem problema', /movel/.test(filtroRede) && /sem_comunicacao/.test(filtroRede) && !/problema/.test(filtroRede), filtroRede);
await shot(admin, 'grade', { fullPage: true });

const visiveis = () =>
  admin.$$eval('.pontos-grid .ponto-card:not([hidden])', (cs) => cs.map((c) => c.getAttribute('href')));
await admin.click('.chip[data-filtro="problema"]');
let v = await visiveis();
check('chip Com problema: só o Mercado', v.length === 1 && v[0] === `#rede/pontos/${PONTO_B}`, v.join(','));
await admin.click('.chip[data-filtro="sem_comunicacao"]');
v = await visiveis();
check('chip Sem comunicação: Padaria e a rede', v.length === 2 && v.includes(`#rede/pontos/${PONTO_A}`) && v.includes(`#rede/pontos/${REDE}`), v.join(','));
// O número do resumo aplica o mesmo filtro.
await admin.click('.chip[data-filtro=""]');
await admin.click('[data-resumo-filtro="problema"]');
check('resumo clicável → chip Com problema', (await admin.getAttribute('.chip.active', 'data-filtro')) === 'problema');
await admin.click('.chip[data-filtro="movel"]');
v = await visiveis();
check('chip Móveis: só a rede', v.length === 1 && v[0] === `#rede/pontos/${REDE}`);
check('chip Móveis: barra da rede móvel', await admin.isVisible('[data-barra-moveis]'));
await shot(admin, 'filtro-moveis', { fullPage: true });
await admin.click('.chip[data-filtro=""]');
await admin.fill('.colecao .busca', codigo(B1));
v = await visiveis();
check('busca pelo código da tela', v.length === 1 && v[0] === `#rede/pontos/${PONTO_B}`, v.join(','));
await admin.fill('.colecao .busca', '');

// Visão geral: problema urgente, sem comunicação à parte (o resumo do
// topo é lido no carregamento — recarrega depois do cenário).
await admin.reload();
await admin.waitForSelector('.admin-shell');
await irAdmin('#visaogeral', '.alerta-linha');
await admin.waitForTimeout(400);
const alertas = await admin.$$eval('.alerta-linha', (ls) => ls.map((l) => ({ t: l.innerText, u: l.classList.contains('urgente') })));
const problemaVG = alertas.find((a) => /com problema/.test(a.t));
const semComVG = alertas.find((a) => /sem comunicação/.test(a.t));
check('Visão geral: 1 tela com problema (urgente)', problemaVG && /1 tela/.test(problemaVG.t) && problemaVG.u, JSON.stringify(alertas));
check('Visão geral: 2 telas sem comunicação (não urgente)', semComVG && /2 telas/.test(semComVG.t) && !semComVG.u, JSON.stringify(alertas));

// ---------------------------------------------------------------------------
console.log('== B. Ficha da rede móvel ==');
await irAdmin(`#rede/pontos/${REDE}`, '[data-rede-cabecalho]');
const cab = await admin.locator('[data-rede-cabecalho]').innerText();
check('cabeçalho: MÓVEL e Ativa', /MÓVEL/i.test(cab) && /Ativa/i.test(cab), cab);
check('cabeçalho: 2 telas · 0 operando · 0 compromissos futuros', /2 telas · 0 operando · 0 compromissos futuros/.test(cab), cab);
check('cabeçalho: sem "Disponível para anunciantes"', !/Disponível para anunciantes/.test(await admin.locator('#conteudo').innerText()));
check('cabeçalho: ⋯ com Editar/Alterar foto/Excluir', (await admin.locator('.menu-mais-lista button').count()) === 3);
check('compromissos: vazio com botão', /Nenhum compromisso agora ou programado/.test(await admin.locator('[data-compromissos]').innerText()));
const linhaM1 = await admin.locator(`[data-tela-linha="${M1}"]`).innerText();
check('M1: Sem comunicação · Sem alocação · Último contato há 8 h', /Sem comunicação/.test(linhaM1) && /Sem alocação/.test(linhaM1) && /Último contato há 8 h/.test(linhaM1), linhaM1);
check('M1: nunca "Com problema"', !/problema/i.test(linhaM1));
check('M2: Aguardando instalação', /Aguardando instalação/.test(await admin.locator(`[data-tela-linha="${M2}"]`).innerText()));
await shot(admin, 'ficha-movel', { fullPage: true });

// ---------------------------------------------------------------------------
console.log('== C. Compromisso na conta ==');
await admin.click('[data-rede-cabecalho] [data-novo-compromisso]');
await modal().waitFor();
check('compromisso: contexto Numa conta por padrão', await admin.isChecked('[name="contexto"][value="conta"]'));
await admin.fill('#cmpConta', 'Padaria');
await admin.waitForSelector('#cmpContaLista [role="option"]');
const opcoes = await admin.$$eval('#cmpContaLista [role="option"]', (ls) => ls.map((l) => l.innerText));
check('busca: os dois homônimos, com a cidade', opcoes.length === 2 && opcoes.some((o) => /Matão/.test(o)) && opcoes.some((o) => /Araraquara/.test(o)), opcoes.join(' | '));
await shot(modal(), 'conta-busca');
// Teclado: desce até a de Matão e Enter.
const iMatao = opcoes.findIndex((o) => /Matão/.test(o));
for (let i = 0; i <= iMatao; i++) await admin.press('#cmpConta', 'ArrowDown');
await admin.press('#cmpConta', 'Enter');
await admin.waitForSelector('[data-conta-escolhida]:not([hidden]) b');
await admin.waitForSelector('[name="endereco_origem"]');
const enderecos = await admin.$$eval('[name="endereco_origem"]', (rs) => rs.map((r) => ({ v: r.value, c: r.checked })));
check('endereço: conta + ponto da conta + outro', enderecos.length === 3, JSON.stringify(enderecos));
check('endereço: o ponto da conta já escolhido', enderecos.find((e) => e.v === `ponto:${PONTO_A}`)?.c, JSON.stringify(enderecos));
check('horário: "Usar horário do local" visível e marcado', (await admin.isVisible('[data-modo-local]')) && (await admin.isChecked('[name="horario_modo"][value="local"]')));
check('benefício na conta', /Benefício/.test(await modal().locator('[data-beneficio]').innerText()));
await admin.fill('#cmpInicio', diaAs(3, '08:00'));
await admin.fill('#cmpFim', diaAs(6, '18:00'));
await admin.dispatchEvent('#cmpFim', 'change');
await admin.waitForSelector(`[name="telas"][value="${M1}"]`);
await admin.waitForTimeout(300);
check('conta: tela é escolha única (rádio)', (await admin.getAttribute(`[name="telas"][value="${M1}"]`, 'type')) === 'radio');
await admin.check(`[name="telas"][value="${M1}"]`);
await shot(modal(), 'compromisso-conta');
await enviarCompromisso('compromisso na conta');
await redeQuieta(admin);
const h = PG(
  `SELECT json_build_object('conta', conta_id, 'tela', dispositivo_id, 'estado', estado, 'local', local, 'horario', horario_operacao, 'categoria', categoria_id) FROM pontos_moveis_hospedagens WHERE ponto_id = ${REDE} ORDER BY id DESC LIMIT 1`,
);
const hosp = JSON.parse(h || '{}');
check('conta: hospedagem programada da Padaria de Matão na M1', hosp.conta === Number(PADARIA) && hosp.tela === M1 && hosp.estado === 'programada', h);
check('conta: horário = CÓPIA do horário do ponto', JSON.stringify(hosp.horario?.seg) === JSON.stringify(HORARIO_PADARIA.seg) && hosp.horario?.dom === null, h);
check('conta: local = nome do ponto', hosp.local === 'Padaria Central — Loja 1', h);
await admin.waitForSelector('[data-proximos] [data-contexto="conta"]');
const itemConta = await admin.locator('[data-proximos] [data-contexto="conta"]').innerText();
check('próximos: termo físico pendente e benefício', /Pendente/.test(itemConta) && /Benefício/.test(itemConta), itemConta);
check('cabeçalho: 1 compromisso futuro', /1 compromisso futuro/.test(await admin.locator('[data-rede-cabecalho]').innerText()));

// ---------------------------------------------------------------------------
console.log('== D. Compromisso em outro local ==');
await admin.click('[data-rede-cabecalho] [data-novo-compromisso]');
await modal().waitFor();
await admin.click('label:has([name="contexto"][value="externo"])');
check('externo: sem conta e sem benefício', !(await admin.isVisible('#cmpConta')) && !(await admin.isVisible('[data-beneficio]')));
await admin.fill('#cmpNome', 'Feira da Cidade');
await admin.fill('#cmpLocal', 'Parque de Exposições');
await admin.fill('#cmp_cep', '15990-000');
await admin.fill('#cmp_logradouro', 'Avenida das Feiras');
await admin.fill('#cmp_numero', '100');
await admin.fill('#cmp_bairro', 'Jardim');
// Vários dias sem horário: nada marcado, e o envio é recusado.
await admin.fill('#cmpInicio', diaAs(3, '10:00'));
await admin.fill('#cmpFim', diaAs(5, '22:00'));
await admin.dispatchEvent('#cmpFim', 'change');
await admin.waitForTimeout(400);
check('vários dias: nenhum horário implícito', (await admin.$$eval('[name="horario_modo"]:checked', (r) => r.length)) === 0);
const m1Ocupada = await admin.isDisabled(`[name="telas"][value="${M1}"]`);
check('M1 ocupada no período (compromisso da conta)', m1Ocupada);
await admin.check(`[name="telas"][value="${M2}"]`);
await modal().locator('button[type=submit]').click();
await admin.waitForTimeout(300);
check('vários dias sem horário → recusado', /horário de operação/i.test(await modal().locator('[data-msg]').innerText()));
// Período curto (uma noite): "durante todo o período" vem marcado.
await admin.fill('#cmpInicio', diaAs(1, '18:00'));
await admin.fill('#cmpFim', diaAs(1, '23:00'));
await admin.dispatchEvent('#cmpFim', 'change');
await admin.waitForTimeout(400);
check('período curto: "Operar durante todo o período"', await admin.isChecked('[name="horario_modo"][value="periodo"]'));
await admin.check(`[name="telas"][value="${M1}"]`);
await admin.check(`[name="telas"][value="${M2}"]`);
await shot(modal(), 'compromisso-externo');
await enviarCompromisso('compromisso externo');
await redeQuieta(admin);
const ev = JSON.parse(
  PG(
    `SELECT json_build_object('id', e.id, 'nome', e.nome, 'horario', e.horario_operacao, 'endereco', e.endereco, 'telas', (SELECT json_agg(t.dispositivo_id ORDER BY t.dispositivo_id) FROM pontos_moveis_evento_telas t WHERE t.evento_id = e.id)) FROM pontos_moveis_eventos e WHERE e.ponto_id = ${REDE} ORDER BY e.id DESC LIMIT 1`,
  ) || '{}',
);
check('externo: evento com as duas telas', ev.nome === 'Feira da Cidade' && JSON.stringify(ev.telas) === JSON.stringify([M1, M2]), JSON.stringify(ev));
check('externo: todo o período (sem grade)', ev.horario === null, JSON.stringify(ev));
check('externo: endereço composto das partes', /Avenida das Feiras, 100/.test(ev.endereco || '') && /Matão/.test(ev.endereco || ''), ev.endereco);
// Conflito por TELA no servidor: M1 já está na feira.
const conflito = await apiAdmin(`/admin/pontos/${REDE}/compromissos`, 'POST', {
  contexto: 'externo',
  nome: 'Outra',
  local: 'Praça',
  endereco_origem: 'outro',
  endereco_partes: { cep: '15990-000', logradouro: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'Matão', uf: 'SP' },
  inicio: diaAs(1, '19:00'),
  fim: diaAs(1, '21:00'),
  horario_modo: 'periodo',
  telas: [M1],
});
check('conflito: 409 na tela ocupada', conflito.status === 409 && conflito.json?.campo === 'telas', JSON.stringify(conflito));
await shot(admin, 'ficha-movel-com-compromissos', { fullPage: true });

// Editar o externo: mantém o endereço e troca o nome.
await admin.click(`[data-comp-acao="editar"][data-ref="e${ev.id}"]`);
await modal().waitFor();
check('editar: "Manter o endereço" marcado', await admin.isChecked('[name="endereco_origem"][value="atual"]'));
await admin.fill('#cmpNome', 'Feira da Cidade 2026');
await shot(modal(), 'compromisso-editar');
await enviarCompromisso('editar compromisso');
await redeQuieta(admin);
check('editar: nome salvo, endereço mantido', PG(`SELECT nome || '|' || endereco FROM pontos_moveis_eventos WHERE id = ${ev.id}`) === `Feira da Cidade 2026|${ev.endereco}`);

// ---------------------------------------------------------------------------
console.log('== E. Ficha da tela, ficha do ponto fixo, 390 px ==');
await irAdmin(`#rede/pontos/${REDE}/telas/${M1}`, '[data-tela-resumo]');
const resumoTela = await admin.locator('[data-tela-resumo]').innerText();
check('tela: Conectividade Sem comunicação', /Sem comunicação/.test(resumoTela), resumoTela);
check('tela: Operação Sem alocação', /Sem alocação/.test(resumoTela), resumoTela);
check('tela: Player 3.0.0', /3\.0\.0/.test(resumoTela), resumoTela);
const blocos = await admin.$$eval('.tela-ficha .ficha-bloco h4', (hs) => hs.map((x) => x.textContent.trim()));
check('tela: Operação/Player/Configuração/Ações', JSON.stringify(blocos) === JSON.stringify(['Operação', 'Player', 'Configuração', 'Ações']), blocos.join(','));
check('tela: nenhum selo de problema', !(await admin.locator('.tela-ficha-topo .badge-err').count()));
await shot(admin, 'ficha-tela', { fullPage: true });
await irAdmin(`#rede/pontos/${PONTO_B}/telas/${B1}`, '[data-tela-resumo]');
check('tela B1: Com problema · Falha de reprodução', /Com problema/.test(await admin.locator('.tela-ficha-topo').innerText()) && /Falha de reprodução/.test(await admin.locator('.tela-ficha-topo').innerText()));
await irAdmin(`#rede/pontos/${PONTO_A}`, '#pontoCabecalho');
const cabFixo = await admin.locator('#pontoCabecalho').innerText();
check('ficha fixa: Fixo + estado + resumo das telas', /Fixo/i.test(cabFixo) && /2 telas/.test(cabFixo) && /sem comunicação/.test(cabFixo), cabFixo);
check('ficha fixa: telas antes das informações', await admin.evaluate(() => {
  const t = document.querySelector('#pontoTelas');
  const i = document.querySelector('#pontoInformacoes');
  return Boolean(t && i && t.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING);
}));
await shot(admin, 'ficha-fixa', { fullPage: true });

const celular = await pagina(390, 844, 'celular', /status of (400|401|404|409)/);
await irQuieto(celular, `${B}/admin/index.html`);
await celular.fill('#usuario', process.env.ADMIN_USER || 'admin');
await celular.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await celular.click('button[type=submit]');
await celular.waitForSelector('.admin-shell');
for (const [hash, seletor, nome] of [
  ['#rede/pontos', '.rede-resumo', 'grade-390'],
  [`#rede/pontos/${REDE}`, '[data-rede-cabecalho]', 'ficha-movel-390'],
  [`#rede/pontos/${REDE}/telas/${M1}`, '[data-tela-resumo]', 'ficha-tela-390'],
]) {
  await celular.evaluate((x) => {
    location.hash = x;
  }, hash);
  await celular.waitForSelector(seletor, { timeout: 10000 });
  await redeQuieta(celular);
  check(`390px: ${nome} sem rolagem lateral`, await semRolagemLateral(celular));
  await shot(celular, nome, { fullPage: true });
}
await celular.evaluate((x) => {
  location.hash = x;
}, `#rede/pontos/${REDE}`);
await celular.waitForSelector('[data-rede-cabecalho] [data-novo-compromisso]');
await celular.click('[data-rede-cabecalho] [data-novo-compromisso]');
await celular.waitForSelector('dialog[open] #formCompromisso');
check('390px: modal de compromisso sem rolagem lateral', await semRolagemLateral(celular));
await shot(celular.locator('dialog[open]').last(), 'compromisso-390');

await navegador.close();
console.log(`\n${falhas.length ? `FALHAS: ${falhas.length}` : 'tudo ok'} · erros de console: ${erros.length}`);
for (const e of erros) console.log('  ', e);
process.exit(falhas.length || erros.length ? 1 : 0);
