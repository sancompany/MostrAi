// PONTOS AGUARDANDO INSTALAÇÃO + MOSTRAÍ MÓVEL + AGENDA — parte ADMIN
// (ADR-047, 14/10/2026; contrato FRONT-ADMIN A1–A10). Itens do dono cobertos
// aqui: 5 (aguardando aparece no Admin), 6 (aguardando é elegível para o
// Móvel), 7 (destino "sem data" só no Admin), 15 (instalação fixa tira o
// ponto de "aguardando"), 16 (instalação fixa não apaga a alocação ativa),
// 17 (Admin é avisado de encerrar), 24 (E2E Admin da agenda), 26 (nenhum erro
// de console). A parte do cliente é o 53-agenda-cliente-movel.mjs.
//   A. Grade: selo "Aguardando instalação" pelo servidor (nunca pelo status:
//      o instalado com o Player revogado é "Temporariamente indisponível"),
//      contador e chip `aguardando_instalacao`, sem chips por status cru; a
//      Visão geral conta pela mesma régua (o número = o do chip que abre) e
//      a rede móvel é "Ativa" em todo selo (card e Ocupação da rede).
//   B. Ficha do ponto aguardando: [Registrar instalação] no lugar do
//      "+ Adicionar tela", [Alocar Móvel], Instalação, Disponibilidade,
//      Instalação prevista ("Sem data definida" → data definida).
//   C. [Alocar Móvel]: o MESMO formulário do compromisso, na conta do dono,
//      no próprio ponto e com o motivo → hospedagem vinculada; a ficha mostra
//      a unidade; termo + entrega → em andamento.
//   D. Agenda em quatro abas (Agora, Próximos, Aguardando instalação,
//      Histórico); [Alocar Móvel] pela aba Aguardando.
//   E. Cancelar exige motivo (sem motivo não envia; duplo clique = 1 pedido);
//      sai de Próximos e entra no Histórico com quem cancelou e o motivo.
//   F. Instalação fixa ([Registrar instalação] → código → Player): o ponto sai
//      de "Aguardando", a alocação continua ATIVA e o aviso aparece na ficha
//      do ponto e na linha do compromisso.
//   G. 1280 e 390 px sem rolagem lateral; nenhum erro de console.
// Banco zerado, servidor na 3999 e o .env carregado:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/52-instalacao-movel.mjs
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
const shot = (alvo, nome, opcoes = {}) => alvo.screenshot({ path: `${SAIDA}instalacao-movel-${nome}.png`, ...opcoes });
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
const diaAs = (dias, hhmm) => `${parede(dias * DIA).slice(0, 10)}T${hhmm}`;
const br = (iso) => iso.slice(0, 10).split('-').reverse().join('/');

async function cadastrar(nome, cpf, email) {
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
      cidade: 'Matão',
      uf: 'SP',
      cep: '15990000',
    }),
  });
  if (!r.ok) throw new Error(`cadastro ${email}: ${r.status} ${await r.text()}`);
  const id = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
  PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${id}`);
  return Number(id);
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
const NOME_P = 'Padaria Aguardando — Centro';
const NOME_Q2 = 'Mercado Sem Móvel';
const DONO = await cadastrar('Padaria Aguardando Ltda', '52998224725', `dono-p-${marca}@teste.com`);
const DONO2 = await cadastrar('Mercado Sem Móvel Ltda', '11144477735', `dono-q2-${marca}@teste.com`);

const admin = await pagina(1280, 900, 'admin');
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
const texto = async (seletor) => ((await admin.locator(seletor).first().textContent()) || '').replace(/\s+/g, ' ').trim();
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
const telaLivre = (id) =>
  admin.waitForFunction(
    (t) => /livre/.test(document.querySelector(`dialog[open] [name="telas"][value="${t}"]`)?.closest('label')?.textContent || ''),
    id,
    { timeout: 8000 },
  );

const HORARIO = {
  seg: { abre: '07:00', fecha: '19:00' },
  ter: { abre: '07:00', fecha: '19:00' },
  qua: { abre: '07:00', fecha: '19:00' },
  qui: { abre: '07:00', fecha: '19:00' },
  sex: { abre: '07:00', fecha: '19:00' },
  sab: { abre: '07:00', fecha: '13:00' },
  dom: null,
  feriados: null,
};
const CATEGORIA = PG(`SELECT id FROM categorias WHERE ativo ORDER BY id LIMIT 1`);
const CATEGORIA_NOME = PG(`SELECT nome FROM categorias WHERE id = ${CATEGORIA}`);
const criarFixo = async (conta, nome) => {
  const r = await apiAdmin(`/admin/anunciantes/${conta}/pontos`, 'POST', {
    nome,
    cep: '15990-000',
    logradouro: 'Rua das Flores',
    numero: String(100 + Math.floor(Math.random() * 800)),
    bairro: 'Centro',
    cidade: 'Matão',
    uf: 'SP',
    responsavel_nome: 'Ana',
    responsavel_contato: '16988887777',
    categoria_id: CATEGORIA,
    horario_semanal: HORARIO,
  });
  if (r.status !== 201) throw new Error(`ponto ${nome}: ${r.status} ${JSON.stringify(r.json)}`);
  return Number(r.json.id);
};
const telaNova = async (ponto) => Number((await apiAdmin(`/admin/pontos/${ponto}/dispositivos`, 'POST', {})).json.id);
const codigo = (id) => `M-${String(id).padStart(4, '0')}`;

// P: aprovado, sem tela, da conta DONO — o protagonista.
const P = await criarFixo(DONO, NOME_P);
// Q2: aprovado, sem tela, de outra conta — recebe o Móvel pela agenda.
const Q2 = await criarFixo(DONO2, NOME_Q2);
// Q: aprovado, sem tela e SEM conta (sem dono, não há a quem hospedar).
const Q = Number(
  PG(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato)
     VALUES ('Quiosque Sem Dono', 'Rua Curta, 1', 'Matão', 'SP', '15990000', 'quiosque', 'Ana', '16999990001') RETURNING id`,
  ),
);
// R: JÁ INSTALADO (a tela deu o 1º sinal há 5 dias) e com o Player revogado:
// a chave sumiu e o status voltou a `a_instalar` — NÃO é "aguardando" (D1).
const R = await criarFixo(DONO2, 'Farmácia Revogada');
const TR = await telaNova(R);
PG(`UPDATE dispositivos SET chave_hash = NULL, primeiro_sinal_em = now() - interval '5 days' WHERE id = ${TR}`);
PG(`UPDATE pontos SET status = 'a_instalar' WHERE id = ${R}`);

// A rede móvel de Matão com duas telas (M1 e M2).
const rede = await apiAdmin('/admin/pontos-moveis', 'POST', { nome: 'Mostraí Móvel', cidade: 'Matão', uf: 'SP' });
const REDE = Number(rede.json.id);
const M1 = await telaNova(REDE);
const M2 = await telaNova(REDE);
// Uma conta com plano que escolheu a rede: a rede entra na "Ocupação da rede"
// da Visão geral. A rede nova, sem nenhum sinal, tem o status cru
// `a_instalar` — e mesmo assim é "Ativa" (rede não tem instalação).
const DONO3 = await cadastrar('Loja Na Rede Ltda', '39053344705', `dono-r3-${marca}@teste.com`);
PG(
  `UPDATE anunciantes SET plano_id = 'essencial-1m', plano_cortesia = true, data_inicio_cobertura = current_date, data_expiracao = current_date + 30 WHERE id = ${DONO3}`,
);
PG(`INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES (${DONO3}, ${REDE})`);
// PIN de saída (sem ele não há código de instalação do Player).
await apiAdmin('/admin/player/pin-saida', 'PUT', { pin: '48213' });

const AGUARDANDO_SQL = `SELECT COUNT(*) FROM pontos p WHERE p.tipo = 'fixo'
  AND p.status IN ('em_operacao','aguardando_primeiro_sinal','a_instalar','em_reparo') AND p.status <> 'em_operacao'
  AND NOT EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = p.id AND d.primeiro_sinal_em IS NOT NULL)`;

// ---------------------------------------------------------------------------
console.log('== A. Grade: selo, contador e chip ==');
await irAdmin('#rede/pontos', '.rede-resumo');
const card = (id) => admin.locator(`a.ponto-card[href="#rede/pontos/${id}"]`);
const seloDe = async (id) => ((await card(id).locator('.badge').first().textContent()) || '').trim();
check('card P: "Aguardando instalação"', (await seloDe(P)) === 'Aguardando instalação', await seloDe(P));
check('card Q (sem dono): "Aguardando instalação"', (await seloDe(Q)) === 'Aguardando instalação', await seloDe(Q));
check(
  'card R (instalado, Player revogado, status a_instalar): "Temporariamente indisponível"',
  (await seloDe(R)) === 'Temporariamente indisponível',
  await seloDe(R),
);
check('card da rede móvel: "Ativa"', (await seloDe(REDE)) === 'Ativa', await seloDe(REDE));
const resumo = await admin.locator('.rede-resumo').innerText();
const nAguardando = Number(/(\d+)\s*\n?\s*aguardando instalação/i.exec(resumo)?.[1]);
check(
  'contador "aguardando instalação" = o do servidor (P, Q e Q2; R não)',
  nAguardando === 3 && nAguardando === Number(PG(AGUARDANDO_SQL)),
  resumo,
);
check(
  'régua sem chips por status cru (a_instalar, aguardando_primeiro_sinal)',
  !(await admin.locator('.chip[data-filtro="a_instalar"], .chip[data-filtro="aguardando_primeiro_sinal"]').count()),
);
await admin.click('[data-resumo-filtro="aguardando_instalacao"]');
check('contador → chip "Aguardando instalação"', (await admin.getAttribute('.chip.active', 'data-filtro')) === 'aguardando_instalacao');
const visiveis = async () =>
  (await admin.$$eval('.pontos-grid .ponto-card:not([hidden])', (cs) => cs.map((c) => c.getAttribute('href')))).sort();
check(
  'chip "Aguardando instalação": P, Q2 e Q — sem R',
  JSON.stringify(await visiveis()) === JSON.stringify([P, Q2, Q].map((id) => `#rede/pontos/${id}`).sort()),
  (await visiveis()).join(','),
);
await shot(admin, 'grade', { fullPage: true });
await admin.click('.chip[data-filtro=""]');
// Visão geral: o "aguardando instalação" (contagem administrativa por status)
// abre a grade no chip novo. O resumo do topo foi lido na entrada, antes do
// cenário: [Atualizar] relê — sem recarregar a página no meio de uma leitura
// (a leitura cortada pelo reload vira "Failed to fetch" no console).
await irAdmin('#visaogeral', '.visao-geral-colunas');
await admin.click('#btnRecarregar');
await admin.waitForSelector('.status-resumo', { timeout: 10000 });
await redeQuieta(admin);
// Ocupação da rede: o selo da rede móvel é "Ativa", como no card da grade —
// nunca o "Aguardando instalação" do status cru dela.
await admin.waitForSelector(`#ocupacaoRede tr[data-ponto-id="${REDE}"]`, { timeout: 10000 });
const seloOcupacaoRede = await texto(`#ocupacaoRede tr[data-ponto-id="${REDE}"] .celula-sub`);
check(
  'Ocupação da rede: a rede móvel (status cru a_instalar) é "Ativa", não "Aguardando instalação"',
  PG(`SELECT status FROM pontos WHERE id = ${REDE}`) === 'a_instalar' &&
    seloOcupacaoRede.startsWith('Ativa ·') &&
    !/Aguardando instalação/.test(seloOcupacaoRede),
  seloOcupacaoRede,
);
// Pontos: cada número conta pela régua do chip que ele abre (o servidor
// marca `aguardando_instalacao`) — nunca pelo status cru `a_instalar`, que
// aqui vale para P, Q, Q2, R (Player revogado) e a rede nova.
await admin.waitForSelector('.status-resumo .status-contagem', { timeout: 10000 });
const resumoVg = (await admin.locator('.status-resumo').innerText()).replace(/\s+/g, ' ');
const nVg = Number(/(\d+) aguardando instalação/.exec(resumoVg)?.[1]);
check(
  'Visão geral: "aguardando instalação" = o do servidor (P, Q e Q2 — sem R e sem a rede)',
  nVg === 3 && nVg === Number(PG(AGUARDANDO_SQL)),
  resumoVg,
);
check(
  'Visão geral: R é "1 temporariamente indisponível" (texto, sem clique) e a rede conta como ativa',
  /\b1 temporariamente indisponível\b/.test(resumoVg) &&
    /\b1 ativo\b/.test(resumoVg) &&
    (await admin.locator('.status-resumo [data-situacao="indisponivel"]:not(button)').count()) === 1,
  resumoVg,
);
check(
  'Visão geral: nenhuma contagem pelo status cru (a_instalar, aguardando_primeiro_sinal)',
  !(await admin.locator('[data-status-clique="a_instalar"], [data-status-clique="aguardando_primeiro_sinal"]').count()),
);
await shot(admin.locator('.coluna-operacional'), 'visao-geral');
await admin.locator('.status-resumo [data-status-clique]', { hasText: 'aguardando instalação' }).click();
await admin.waitForSelector('.colecao .chip.active');
await redeQuieta(admin);
check(
  'Visão geral "aguardando instalação" → chip "Aguardando instalação", com o MESMO número',
  (await admin.getAttribute('.colecao .chip.active', 'data-filtro')) === 'aguardando_instalacao' &&
    (await visiveis()).length === nVg,
  `${nVg} na Visão geral; chip: ${(await visiveis()).join(',')}`,
);

// ---------------------------------------------------------------------------
console.log('== B. Ficha do ponto aguardando ==');
await irAdmin(`#rede/pontos/${P}`, '#pontoCabecalho [data-registrar-instalacao]');
const cab = await admin.locator('#pontoCabecalho').innerText();
// O selo do estado (o segundo, depois de "Fixo"), pelo texto e não pelo
// innerText (o CSS põe os selos em caixa alta).
const seloFicha = async () =>
  ((await admin.locator('#pontoCabecalho .ponto-cabecalho-selos .badge').nth(1).textContent()) || '').trim();
check('cabeçalho: selo "Aguardando instalação"', (await seloFicha()) === 'Aguardando instalação', await seloFicha());
check(
  'cabeçalho: [Registrar instalação] primário, sem "+ Adicionar tela" e sem "Ativar"',
  /Registrar instalação/.test(cab) &&
    !/Adicionar tela/.test(cab) &&
    !/\bAtivar\b/.test(cab) &&
    (await admin.locator('#pontoCabecalho [data-registrar-instalacao].primary').count()) === 1,
  cab,
);
check('cabeçalho: [Alocar Móvel] (tem dono, sem alocação)', await admin.isVisible('#pontoCabecalho [data-alocar-movel]'));
check('Instalação: "Aguardando instalação"', (await texto('[data-instalacao]')) === 'Aguardando instalação', await texto('[data-instalacao]'));
check(
  'Disponibilidade: "Não disponível — aguardando instalação" (nunca "disponível")',
  (await texto('[data-disponibilidade]')) === 'Não disponível — aguardando instalação',
  await texto('[data-disponibilidade]'),
);
check('Instalação prevista: "Sem data definida"', (await texto('[data-instalacao-prevista]')) === 'Sem data definida');
check('Mostraí Móvel: "Nenhuma alocação" + [Alocar Móvel]', /Nenhuma alocação/.test(await texto('[data-movel-alocacao]')) && (await admin.locator('#pontoInformacoes [data-alocar-movel]').count()) === 1);
check('sem passagens: bloco oculto', await admin.locator('[data-passagens]').isHidden());
// Definir data: vazio não envia; com a data, aparece.
await admin.click('[data-definir-previsao]');
await modal().locator('#instalacaoPrevistaData').waitFor();
await modal().locator('button[type=submit]').click();
check('data vazia: erro no modal, nada gravado', /Escolha a data/.test(await modal().locator('[data-msg]').innerText()) && PG(`SELECT instalacao_prevista_em FROM pontos WHERE id = ${P}`) === '');
const PREVISTA = parede(20 * DIA).slice(0, 10);
await modal().locator('#instalacaoPrevistaData').fill(PREVISTA);
await modal().locator('button[type=submit]').click();
await admin.waitForFunction((d) => document.querySelector('[data-instalacao-prevista]')?.textContent.trim() === d, br(PREVISTA), { timeout: 10000 });
await redeQuieta(admin);
check('Instalação prevista: a data definida', (await texto('[data-instalacao-prevista]')) === br(PREVISTA));
check('gravada no banco (AAAA-MM-DD)', PG(`SELECT instalacao_prevista_em FROM pontos WHERE id = ${P}`) === PREVISTA);
check('o botão vira [Alterar data]', (await texto('[data-definir-previsao]')) === 'Alterar data');
check('a data não muda o status do ponto', PG(`SELECT status FROM pontos WHERE id = ${P}`) === 'a_instalar');
await shot(admin.locator('#conteudo'), 'ficha-aguardando');

// ---------------------------------------------------------------------------
console.log('== C. [Alocar Móvel] pela ficha ==');
await admin.click('#pontoCabecalho [data-alocar-movel]');
await modal().locator('#formCompromisso').waitFor();
await admin.waitForSelector(`dialog[open] [name="endereco_origem"][value="ponto:${P}"]`, { timeout: 10000 });
check('modal "Alocar Mostraí Móvel"', /Alocar Mostraí Móvel/.test(await modal().locator('.modal-topo').innerText()));
check('contexto travado em "Na conta" (sem escolha de contexto)', await modal().locator('[data-contexto]').isHidden());
check(
  'conta do dono já escolhida, sem [Trocar]',
  (await modal().locator('[data-conta-escolhida] b').innerText()) === 'Padaria Aguardando Ltda' &&
    !(await modal().locator('[data-trocar-conta]').count()),
);
check('endereço: o próprio ponto', await modal().locator(`[name="endereco_origem"][value="ponto:${P}"]`).isChecked());
check('motivo pré-selecionado: Aguardando instalação', (await modal().locator('#cmpMotivo').inputValue()) === 'aguardando_instalacao');
check('rede única: já escolhida (sem seletor)', !(await modal().locator('#cmpRede').count()));
await admin.fill('#cmpInicio', parede(-1 * HORA));
await admin.fill('#cmpFim', parede(5 * DIA));
await admin.dispatchEvent('#cmpFim', 'change');
await telaLivre(M1);
await admin.check(`[name="telas"][value="${M1}"]`);
check('horário do local (o ponto tem horário) já marcado', await admin.isChecked('[name="horario_modo"][value="local"]'));
await shot(modal(), 'alocar');
await enviarCompromisso('alocar Móvel no ponto');
await redeQuieta(admin);
const HP = PG(`SELECT id FROM pontos_moveis_hospedagens WHERE local_ponto_id = ${P}`);
check(
  'hospedagem vinculada: conta do dono, o ponto, o motivo, sem interesse, programada na M1',
  PG(
    `SELECT conta_id || '|' || local_ponto_id || '|' || motivo_alocacao || '|' || (interesse_id IS NULL) || '|' || estado || '|' || dispositivo_id || '|' || ponto_id FROM pontos_moveis_hospedagens WHERE id = ${HP}`,
  ) === `${DONO}|${P}|aguardando_instalacao|true|programada|${M1}|${REDE}`,
);
await admin.waitForFunction(() => /M-\d{4}/.test(document.querySelector('[data-movel-alocacao]')?.textContent || ''), null, {
  timeout: 10000,
});
const linhaMovel = await texto('[data-movel-alocacao]');
check(
  'ficha: "M-NNNN · Mostraí Móvel · período · Programada · Motivo: Aguardando instalação"',
  linhaMovel.startsWith(`${codigo(M1)} · Mostraí Móvel · `) &&
    /→/.test(linhaMovel) &&
    /Programada · Motivo: Aguardando instalação$/.test(linhaMovel),
  linhaMovel,
);
check('ficha: link para a rede', (await admin.locator(`[data-movel-alocacao] a[href="#rede/pontos/${REDE}"]`).count()) === 1);
check('cabeçalho: [Alocar Móvel] sumiu (já alocado)', !(await admin.locator('#pontoCabecalho [data-alocar-movel]').count()));
await admin.waitForSelector('[data-passagens]:not([hidden])', { timeout: 10000 });
check('passagens: a hospedagem programada, com o motivo', /Programado/.test(await texto('[data-passagens]')) && /Motivo: Aguardando instalação/.test(await texto('[data-passagens]')));
// Termo físico + entrega → em andamento (a instalação fixa vai chegar com o
// Móvel ATIVO no ponto).
const termo = await apiAdmin(`/admin/pontos/${REDE}/hospedagens/${HP}/termo-fisico`, 'PUT', { assinado: true });
const iniciou = await apiAdmin(`/admin/pontos/${REDE}/compromissos/h${HP}/iniciar`, 'POST', {
  entrega: { itens: { tela: true }, condicao: 'ok' },
});
check('termo + entrega → hospedagem ativa', termo.status === 200 && iniciou.status === 200 && PG(`SELECT estado FROM pontos_moveis_hospedagens WHERE id = ${HP}`) === 'ativa', JSON.stringify([termo, iniciou]));

// ---------------------------------------------------------------------------
console.log('== D. Agenda móvel em quatro abas ==');
async function abrirAgenda() {
  await irAdmin('#rede/pontos', '.colecao');
  await admin.click('.chip[data-filtro="movel"]');
  await admin.click('[data-barra-moveis] [data-agenda-movel]');
  await admin.waitForSelector('dialog[open] [data-agenda-corpo] table, dialog[open] [data-agenda-corpo] .empty-state', { timeout: 10000 });
  await redeQuieta(admin);
}
const aba = async (id) => {
  await modal().locator(`[data-agenda-aba="${id}"]`).click();
  await admin.waitForFunction(
    (a) => {
      const c = document.querySelector('dialog[open] [data-agenda-corpo]');
      return c?.getAttribute('aria-labelledby') === `agendaAba-${a}` && !/Carregando/.test(c.textContent);
    },
    id,
    { timeout: 10000 },
  );
  return (await modal().locator('[data-agenda-corpo]').innerText()).replace(/\s+/g, ' ');
};
const contarLeituras = (padrao) => {
  let n = 0;
  const ouvir = (r) => {
    if (padrao.test(r.url())) n += 1;
  };
  admin.on('request', ouvir);
  return () => {
    admin.off('request', ouvir);
    return n;
  };
};
const leituraPadrao = contarLeituras(/\/admin\/pontos-moveis\/agenda$/);
await abrirAgenda();
const abas = await modal().locator('[role="tab"]').allInnerTexts();
check('quatro abas', JSON.stringify(abas.map((x) => x.trim())) === JSON.stringify(['Agora', 'Próximos', 'Aguardando instalação', 'Histórico']), abas.join('|'));
check('Agora selecionada', (await modal().locator('[data-agenda-aba="agora"]').getAttribute('aria-selected')) === 'true');
let corpo = (await modal().locator('[data-agenda-corpo]').innerText()).replace(/\s+/g, ' ');
check('Agora: a hospedagem em andamento no ponto, com o motivo', corpo.includes(NOME_P) && /Em andamento/.test(corpo) && /Motivo: Aguardando instalação/.test(corpo), corpo.slice(0, 300));
// Teclado: seta para a direita leva a Próximos.
await modal().locator('[data-agenda-aba="agora"]').focus();
await admin.keyboard.press('ArrowRight');
await admin.waitForFunction(() => document.querySelector('[data-agenda-aba="proximos"]')?.getAttribute('aria-selected') === 'true');
check('teclado: → seleciona Próximos e leva o foco', await admin.evaluate(() => document.activeElement?.dataset.agendaAba === 'proximos'));
corpo = await aba('proximos');
check('Próximos: vazio com frase própria', /Nenhum compromisso programado\./.test(corpo), corpo);
check('Agora e Próximos: UMA leitura padrão', leituraPadrao() === 1);
corpo = await aba('aguardando');
const linhasAg = await modal().locator('[data-agenda-aguardando] tbody tr').evaluateAll((trs) => trs.map((tr) => tr.dataset.aguardandoPonto));
check('Aguardando: P (com data) antes de Q2 e Q (sem data)', JSON.stringify(linhasAg.map(Number)) === JSON.stringify([P, Q2, Q]), linhasAg.join(','));
const linhaAg = (id) => modal().locator(`[data-aguardando-ponto="${id}"]`);
const textoP = (await linhaAg(P).innerText()).replace(/\s+/g, ' ');
check(
  'Aguardando, P: link da ficha, categoria, cidade, conta, previsão e a unidade em andamento',
  (await linhaAg(P).locator(`a[href="#rede/pontos/${P}"]`).count()) === 1 &&
    textoP.includes(CATEGORIA_NOME) &&
    /Matão\/SP/.test(textoP) &&
    textoP.includes('Padaria Aguardando Ltda') &&
    textoP.includes(br(PREVISTA)) &&
    textoP.includes(codigo(M1)) &&
    /Em andamento/.test(textoP) &&
    !(await linhaAg(P).locator('[data-alocar-movel]').count()),
  textoP,
);
const textoQ = (await linhaAg(Q).innerText()).replace(/\s+/g, ' ');
check('Aguardando, Q (sem conta): "Sem data definida", sem [Alocar Móvel]', /Sem data definida/.test(textoQ) && /Sem conta/.test(textoQ) && !(await linhaAg(Q).locator('[data-alocar-movel]').count()), textoQ);
check('Aguardando, Q2: [Alocar Móvel]', (await linhaAg(Q2).locator('[data-alocar-movel]').count()) === 1);
check('Aguardando: R (instalado) não aparece', !(await linhaAg(R).count()));
await shot(modal(), 'agenda-aguardando');
// [Alocar Móvel] pela agenda: o mesmo formulário, por cima da agenda.
await linhaAg(Q2).locator('[data-alocar-movel]').click();
await admin.waitForSelector(`dialog[open] [name="endereco_origem"][value="ponto:${Q2}"]`, { timeout: 10000 });
check(
  'agenda → Alocar Móvel: conta do dono de Q2, o ponto e o motivo',
  (await modal().locator('[data-conta-escolhida] b').innerText()) === 'Mercado Sem Móvel Ltda' &&
    (await modal().locator(`[name="endereco_origem"][value="ponto:${Q2}"]`).isChecked()) &&
    (await modal().locator('#cmpMotivo').inputValue()) === 'aguardando_instalacao',
);
await admin.fill('#cmpInicio', diaAs(2, '08:00'));
await admin.fill('#cmpFim', diaAs(4, '18:00'));
await admin.dispatchEvent('#cmpFim', 'change');
await telaLivre(M2);
check('agenda → Alocar Móvel: a M1 (em andamento no P) aparece ocupada', await admin.isDisabled(`[name="telas"][value="${M1}"]`));
await admin.check(`[name="telas"][value="${M2}"]`);
await enviarCompromisso('alocar Móvel pela agenda');
await admin.waitForFunction(
  (id) => /M-\d{4}/.test(document.querySelector(`dialog[open] [data-aguardando-ponto="${id}"] [data-movel]`)?.textContent || ''),
  Q2,
  { timeout: 10000 },
);
const HQ2 = PG(`SELECT id FROM pontos_moveis_hospedagens WHERE local_ponto_id = ${Q2}`);
check(
  'agenda: Q2 agora mostra a M2 programada e não oferece mais [Alocar Móvel]',
  (await linhaAg(Q2).innerText()).includes(codigo(M2)) && /Programada/.test(await linhaAg(Q2).innerText()) && !(await linhaAg(Q2).locator('[data-alocar-movel]').count()),
);
corpo = await aba('proximos');
check('Próximos: a passagem de Q2, com o motivo', corpo.includes(NOME_Q2) && /Motivo: Aguardando instalação/.test(corpo), corpo.slice(0, 300));
corpo = await aba('historico');
check('Histórico: vazio com frase própria', /Nenhum compromisso encerrado ainda\./.test(corpo), corpo);
await shot(modal(), 'agenda-proximos');
await modal().locator('[data-fechar]').last().click();

// ---------------------------------------------------------------------------
console.log('== E. Cancelar exige o motivo ==');
await irAdmin(`#rede/pontos/${REDE}`, `[data-compromisso="h${HQ2}"] [data-comp-acao="cancelar"]`);
await admin.click(`[data-compromisso="h${HQ2}"] [data-comp-acao="cancelar"]`);
await modal().locator('#cancelarCompromissoMotivo').waitFor();
check('modal: o texto de sempre + Motivo obrigatório (até 300)', /Não aconteceu: nenhum benefício é gerado/.test(await modal().innerText()) && (await modal().locator('#cancelarCompromissoMotivo').getAttribute('maxlength')) === '300');
check('foco no motivo', await admin.evaluate(() => document.activeElement?.id === 'cancelarCompromissoMotivo'));
const pedidosCancelar = contarLeituras(/\/compromissos\/h\d+\/cancelar$/);
await modal().locator('#cancelarCompromissoMotivo').fill('   ');
await modal().locator('button[type=submit]').click();
await admin.waitForTimeout(400);
check(
  'sem motivo: erro no modal, nada enviado, continua programada',
  /Informe o motivo do cancelamento/.test(await modal().locator('[data-msg]').innerText()) &&
    PG(`SELECT estado FROM pontos_moveis_hospedagens WHERE id = ${HQ2}`) === 'programada',
);
await shot(modal(), 'cancelar-sem-motivo');
const MOTIVO = 'O dono adiou a obra; a unidade vai para outro ponto';
await modal().locator('#cancelarCompromissoMotivo').fill(MOTIVO);
await modal().locator('button[type=submit]').dblclick();
await admin.waitForFunction(() => !document.querySelector('dialog[open] #formCancelarCompromisso'), null, { timeout: 10000 });
await redeQuieta(admin);
check('duplo clique: UM pedido de cancelamento (e nenhum sem motivo)', pedidosCancelar() === 1);
check(
  'cancelada com o motivo e quem cancelou',
  PG(`SELECT estado || '|' || motivo_cancelamento || '|' || (encerrado_por_admin IS NOT NULL) FROM pontos_moveis_hospedagens WHERE id = ${HQ2}`) ===
    `cancelada|${MOTIVO}|true`,
);
const QUEM = PG(`SELECT encerrado_por_admin FROM pontos_moveis_hospedagens WHERE id = ${HQ2}`);
await admin.waitForSelector(`[data-historico] [data-compromisso="h${HQ2}"]`, { state: 'attached', timeout: 10000 });
const linhaCancelada = ((await admin.locator(`[data-historico] [data-compromisso="h${HQ2}"]`).textContent()) || '').replace(/\s+/g, ' ');
check('ficha da rede: "Cancelado por <quem> · <motivo>" e o motivo da alocação', linhaCancelada.includes(`Cancelado por ${QUEM} · ${MOTIVO}`) && /Motivo: Aguardando instalação/.test(linhaCancelada), linhaCancelada);
await abrirAgenda();
corpo = await aba('proximos');
check('agenda, Próximos: a cancelada saiu', !corpo.includes(NOME_Q2), corpo);
corpo = await aba('historico');
check('agenda, Histórico: a cancelada com quem cancelou e o motivo', corpo.includes(NOME_Q2) && corpo.includes(`Cancelado por ${QUEM} · ${MOTIVO}`) && /Cancelada/.test(corpo), corpo.slice(0, 400));
await shot(modal(), 'agenda-historico');
await modal().locator('[data-fechar]').last().click();

// ---------------------------------------------------------------------------
console.log('== F. Instalação fixa com o Móvel no ponto ==');
await irAdmin(`#rede/pontos/${P}`, '#pontoCabecalho [data-registrar-instalacao]');
await admin.click('#pontoCabecalho [data-registrar-instalacao]');
await admin.waitForSelector('.tela-ficha', { timeout: 10000 });
const T = Number(admin.url().split('/').pop());
check('[Registrar instalação] sem tela pendente: cria a tela e abre a ficha dela', T > 0 && PG(`SELECT COUNT(*) FROM dispositivos WHERE ponto_id = ${P}`) === '1');
// De volta à ficha: tela Ativa ainda sem Player → abre a MESMA tela.
await irAdmin(`#rede/pontos/${P}`, '#pontoCabecalho [data-registrar-instalacao]');
check('tela sem Player: o ponto continua aguardando', (await seloFicha()) === 'Aguardando instalação', await seloFicha());
check('o botão não cria outra tela (sem data-nova-tela)', !(await admin.locator('#pontoCabecalho [data-registrar-instalacao][data-nova-tela]').count()));
await admin.click('#pontoCabecalho [data-registrar-instalacao]');
await admin.waitForSelector('.tela-ficha', { timeout: 10000 });
check('[Registrar instalação] com tela pendente: abre a ficha dela', Number(admin.url().split('/').pop()) === T && PG(`SELECT COUNT(*) FROM dispositivos WHERE ponto_id = ${P}`) === '1');
await redeQuieta(admin);
await admin.click('[data-acao="gerar-codigo"]');
await admin.waitForSelector('[data-expira]', { timeout: 8000 }).catch(() => {});
const codigoInstalacao = (await admin.textContent('.tela-ficha')).match(/[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}/)?.[0];
const prov = await fetch(`${B}/player/provisionar`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ codigoTela: codigo(T), codigoInstalacao }),
});
check('Player instalado pelo código (1º sinal)', prov.status === 200, prov.status);
check('o ponto entrou em operação sozinho', PG(`SELECT status FROM pontos WHERE id = ${P}`) === 'em_operacao');
check('a alocação do Móvel NÃO encerrou (continua ativa)', PG(`SELECT estado FROM pontos_moveis_hospedagens WHERE id = ${HP}`) === 'ativa');
// Como no 09: a ficha da tela vê o Player sem F5; depois, um carregamento
// limpo (o POST do código, de corpo não lido, o Playwright conta como em
// voo) com a ficha da tela já assentada — recarregar no meio da leitura da
// ficha do ponto vira "Failed to fetch" no console — e só então a ficha do
// ponto.
await admin.waitForFunction(() => /Player conectado/.test(document.querySelector('.tela-ficha')?.textContent || ''), null, {
  timeout: 8000,
});
await admin.reload();
await admin.waitForSelector('.tela-ficha', { timeout: 10000 });
await redeQuieta(admin);
await irAdmin(`#rede/pontos/${P}`, '#pontoInformacoes [data-instalacao]');
check(
  'cabeçalho: "Ativo" e "+ Adicionar tela" de volta',
  (await seloFicha()) === 'Ativo' &&
    /Adicionar tela/.test(await admin.locator('#pontoCabecalho').innerText()) &&
    !(await admin.locator('[data-registrar-instalacao]').count()),
  await seloFicha(),
);
check('Instalação: "Concluída — 1º sinal em <hoje>"', /^Concluída — 1º sinal em \d{2}\/\d{2}\/\d{4}$/.test(await texto('[data-instalacao]')), await texto('[data-instalacao]'));
check('Disponibilidade: "Disponível para os anunciantes"', (await texto('[data-disponibilidade]')) === 'Disponível para os anunciantes');
check('sem "Instalação prevista" depois de instalado', !(await admin.locator('[data-instalacao-prevista]').count()));
const aviso = await texto('#pontoInformacoes [data-aviso-encerrar]');
check(
  'aviso na ficha: encerre (ou cancele) a alocação, com link para a rede',
  aviso.startsWith('Instalação fixa concluída — encerre (ou cancele) a alocação do Mostraí Móvel neste ponto.') &&
    (await admin.locator(`[data-aviso-encerrar] a[href="#rede/pontos/${REDE}"]`).count()) === 1,
  aviso,
);
check('Mostraí Móvel: a unidade em andamento continua na ficha', (await texto('[data-movel-alocacao]')).includes(codigo(M1)) && /Em andamento/.test(await texto('[data-movel-alocacao]')));
await admin.waitForSelector('[data-passagens]:not([hidden])', { timeout: 10000 });
check('passagens: a hospedagem "Agora"', /Agora/.test(await texto('[data-passagens]')));
await shot(admin.locator('#conteudo'), 'ficha-instalada-aviso');
await irAdmin(`#rede/pontos/${REDE}`, `[data-compromisso="h${HP}"]`);
check(
  'linha do compromisso na rede: o aviso',
  /Instalação fixa concluída no ponto — encerre \(ou cancele\) esta alocação\./.test(await admin.locator(`[data-compromisso="h${HP}"] [data-aviso-encerrar]`).innerText()),
);
await abrirAgenda();
corpo = (await modal().locator('[data-agenda-corpo]').innerText()).replace(/\s+/g, ' ');
check('agenda, Agora: a alocação continua em andamento', corpo.includes(NOME_P) && /Em andamento/.test(corpo));
corpo = await aba('aguardando');
check('agenda, Aguardando: P saiu (Q2 e Q ficam)', !(await linhaAg(P).count()) && (await linhaAg(Q2).count()) === 1 && (await linhaAg(Q).count()) === 1, corpo.slice(0, 300));
await modal().locator('[data-fechar]').last().click();
await irAdmin('#rede/pontos', '.rede-resumo');
const resumo2 = await admin.locator('.rede-resumo').innerText();
check('contador: 2 aguardando (Q e Q2)', Number(/(\d+)\s*\n?\s*aguardando instalação/i.exec(resumo2)?.[1]) === 2, resumo2);
check('card P: "Ativo"', (await seloDe(P)) === 'Ativo', await seloDe(P));

// ---------------------------------------------------------------------------
console.log('== G. 1280 e 390 px ==');
check('1280: grade sem rolagem lateral', await semRolagemLateral(admin));
await irAdmin(`#rede/pontos/${P}`, '#pontoInformacoes [data-instalacao]');
check('1280: ficha sem rolagem lateral', await semRolagemLateral(admin));
await admin.setViewportSize({ width: 390, height: 844 });
await irAdmin(`#rede/pontos/${P}`, '#pontoInformacoes [data-instalacao]');
await admin.waitForSelector('[data-passagens]:not([hidden])', { timeout: 10000 });
check('390: ficha do ponto sem rolagem lateral', await semRolagemLateral(admin));
await shot(admin, 'ficha-390', { fullPage: true });
await irAdmin(`#rede/pontos/${Q2}`, '#pontoInformacoes [data-instalacao]');
check('390: ficha do ponto aguardando sem rolagem lateral', await semRolagemLateral(admin));
await shot(admin, 'ficha-aguardando-390', { fullPage: true });
await irAdmin('#rede/pontos', '.rede-resumo');
check('390: grade sem rolagem lateral', await semRolagemLateral(admin));
await irAdmin('#visaogeral', '.status-resumo .status-contagem');
check('390: Visão geral sem rolagem lateral', await semRolagemLateral(admin));
await shot(admin.locator('.coluna-operacional'), 'visao-geral-390');
await abrirAgenda();
for (const id of ['agora', 'proximos', 'aguardando', 'historico']) {
  await aba(id);
  check(`390: agenda (${id}) sem rolagem lateral`, await semRolagemLateral(admin));
}
await aba('aguardando');
await shot(modal(), 'agenda-390');
await modal().locator('[data-fechar]').last().click();
await irAdmin(`#rede/pontos/${REDE}`, `[data-compromisso="h${HP}"]`);
check('390: ficha da rede sem rolagem lateral', await semRolagemLateral(admin));
await shot(admin, 'rede-390', { fullPage: true });

console.log('\nerros de página:', erros.length ? erros : 'nenhum');
check('nenhum erro de console', !erros.length, erros.join(' | '));
console.log('falhas:', falhas.length);
await navegador.close();
process.exit(falhas.length ? 1 : 0);
