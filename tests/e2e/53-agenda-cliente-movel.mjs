// PONTO AGUARDANDO INSTALAÇÃO + MOSTRAÍ MÓVEL + AGENDA — o lado do CLIENTE
// (ADR-047, 14/10/2026; itens 1, 8, 9, 10, 11, 12, 13, 14, 18, 19, 23, 25,
// 26 e 27 da lista do dono). O lado do Admin é o 52-instalacao-movel.mjs.
//   · ponto aprovado sem 1º sinal (com e sem data prevista) fora da escolha
//     do anunciante — inclusive a do próprio dono — e do site; a contagem
//     comercial (confirmar-plano, "Onde estamos") também não o conta;
//   · o Móvel hospedado nesse ponto: o cliente vê só a rede "Mostraí Móvel" +
//     cidade como posição (1 do plano); o estabelecimento nunca vira card;
//   · card sem próxima: "Ainda não publicada"; a agenda com Agora / Próximas
//     passagens / Histórico (encerradas, período REAL, a mais recente
//     primeiro, em tom secundário); a cancelada nunca aparece;
//   · nada de planejamento interno: motivo, conta, observação, "sem data",
//     data prevista, tela, termo;
//   · a instalação fixa não apaga o histórico nem a passagem em curso;
//   · 1280/820/390 px sem rolagem lateral (página e diálogo); teclado; sem
//     erro de console.
// Banco zerado, servidor na 3999 e o .env carregado:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/53-agenda-cliente-movel.mjs
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
const shot = (alvo, nome, opcoes = {}) =>
  alvo.screenshot({ path: `${SAIDA}agenda-cliente-movel-${nome}.png`, ...opcoes });

const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const marca = Date.now();
const SENHA = 'Senha123!';

// "2026-10-05T14:30" no relógio de Matão — o formato que o compromisso aceita.
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

async function pagina(largura, altura, rotulo, permitir = /status of 401/) {
  const ctx = await navegador.newContext({ viewport: { width: largura, height: altura } });
  await ctx.route(/google\.com\/maps/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'mapa' }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`[${rotulo}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() !== 'error' || /net::|ERR_FAILED/.test(m.text()) || permitir.test(m.text())) return;
    erros.push(`[${rotulo}] console: ${m.text()}`);
  });
  return p;
}

async function entrar(email, largura, altura, rotulo, permitir) {
  const p = await pagina(largura, altura, rotulo, permitir);
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', email);
  await p.fill('#senha', SENHA);
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await redeQuieta(p);
  return p;
}

// Ação do Admin na rede escolhida chega ao painel por SSE (point.updated) e
// ele se recarrega sozinho; um F5 no meio dessa recarga aborta os fetch dela
// ("Failed to fetch" no console). Espera o evento chegar e a rede assentar.
async function assentarERecarregar(p) {
  await p.waitForTimeout(1200);
  await redeQuieta(p);
  await recarregarQuieto(p);
}
const semRolagemLateral = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const texto = (s) => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Contas: a anfitriã (dona do estabelecimento que espera a instalação) e o
// anunciante com plano. Nome da conta ≠ nome do estabelecimento, para provar
// que a conta nunca chega ao cliente.
// ---------------------------------------------------------------------------
const emailAnf = `anfitria-${marca}@teste.com`;
const ANF = await cadastrar('Comercial Silva Ltda', '52998224725', emailAnf);
const emailAnun = `anunciante-${marca}@teste.com`;
const ANUN = await cadastrar('Loja do Anunciante', '11144477735', emailAnun);
PG(
  `UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${ANUN}`,
);
const LIMITE = PG(`SELECT pontos_incluidos FROM planos WHERE id = 'essencial-1m'`);

// ---------------------------------------------------------------------------
// Admin: rede, telas, os pontos aguardando instalação
// ---------------------------------------------------------------------------
const admin = await pagina(1280, 900, 'admin', /status of (400|401|409)/);
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

console.log('== Admin: rede móvel com três telas ==');
check(
  'rede criada',
  (await apiAdmin('/admin/pontos-moveis', 'POST', { nome: 'Mostraí Móvel', cidade: 'Matão', uf: 'SP' })).status === 201,
);
const REDE = PG(`SELECT id FROM pontos WHERE tipo = 'movel' AND cidade = 'Matão' AND uf = 'SP'`);
const TELAS = [];
for (let i = 0; i < 3; i++) TELAS.push((await apiAdmin(`/admin/pontos/${REDE}/dispositivos`, 'POST', {})).json?.id);
const [TELA_A, TELA_B, TELA_C] = TELAS;
check('três telas na rede', TELAS.every(Boolean), JSON.stringify(TELAS));
PG(
  `UPDATE dispositivos SET chave_hash = md5(random()::text), provisionado_em = now(), primeiro_sinal_em = now(), ultima_vez_online = now() WHERE ponto_id = ${REDE}`,
);
PG(`UPDATE pontos SET status = 'em_operacao' WHERE id = ${REDE}`);

console.log('== Admin: dois pontos aprovados aguardando instalação ==');
// O da anfitriã, com data prevista (o Móvel vai para lá)...
const criouFixo = await apiAdmin(`/admin/anunciantes/${ANF}/pontos`, 'POST', {
  nome: 'Empório Silva',
  responsavel_nome: 'Ana Silva',
  responsavel_contato: '16988887777',
  cep: '15990-000',
  logradouro: 'Rua das Flores',
  numero: '120',
  bairro: 'Centro',
  cidade: 'Matão',
  uf: 'SP',
});
check('ponto da anfitriã criado', criouFixo.status === 201, JSON.stringify(criouFixo.json));
const FIXO = PG(`SELECT id FROM pontos WHERE anunciante_id = ${ANF} AND tipo = 'fixo'`);
const DATA_PREVISTA = '2026-11-20';
check(
  'data prevista de instalação definida (só Admin)',
  (await apiAdmin(`/admin/pontos/${FIXO}`, 'PATCH', { instalacao_prevista_em: DATA_PREVISTA })).status === 200,
);
// ...e um sem dono e SEM data definida.
const FIXO_SEM_DATA = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
   VALUES ('Quitanda Sem Data', 'Rua Dois, 2', 'Matão', 'SP', '15990000', 'outro', 'R', '1', 'a_instalar') RETURNING id`,
);
const aguardando = (await apiAdmin('/admin/pontos-moveis/agenda?aguardando=1')).json?.aguardando || [];
check(
  'os dois aparecem como aguardando instalação no Admin',
  [FIXO, FIXO_SEM_DATA].every((id) => aguardando.some((a) => String(a.pontoId) === id)),
  JSON.stringify(aguardando.map((a) => a.pontoId)),
);

// ---------------------------------------------------------------------------
console.log('== Anunciante: rede sem nada publicado ==');
// 400: o PUT com o estabelecimento aguardando, provocado de propósito abaixo.
const anun = await entrar(emailAnun, 1280, 1000, 'anunciante 1280', /status of (400|401)/);
await anun.waitForSelector(`.ponto-escolha[data-ponto-id="${REDE}"]`, { timeout: 10000 });
const cardRede = () => anun.locator(`.ponto-escolha[data-ponto-id="${REDE}"]`);
let textoCard = texto(await cardRede().innerText());
check('card: Local atual — Sem localização no momento', /Local atual Sem localização no momento/i.test(textoCard), textoCard);
check('card: Próxima localização — Ainda não publicada', /Próxima localização Ainda não publicada/i.test(textoCard), textoCard);
// Espera a agenda CARREGADA (algum bloco desenhado) — não um bloco
// específico: se faltar um, o check dele falha sozinho e o roteiro segue.
const abrirAgenda = async (p) => {
  await p.locator(`.ponto-escolha[data-ponto-id="${REDE}"] [data-agenda-rede]`).click();
  await p.waitForSelector('#dlgAgendaMovel[open] .agenda-movel-bloco', { timeout: 8000 });
  return p.locator('#dlgAgendaMovel');
};
const fecharAgenda = async (p) => {
  await p.locator('#dlgAgendaMovel [data-fechar-agenda]').click();
  await p.waitForFunction(() => !document.getElementById('dlgAgendaMovel')?.open);
};
const bloco = (p, chave) => p.locator(`#dlgAgendaMovel [data-agenda-bloco="${chave}"]`);
// Texto do bloco ('' se ele não existe) e as linhas dele — sem esperar.
const lerBloco = async (p, chave) => ((await bloco(p, chave).count()) ? texto(await bloco(p, chave).innerText()) : '');
const linhasDo = (p, chave) => bloco(p, chave).locator('.agenda-movel-item');
let dlg = await abrirAgenda(anun);
check(
  'agenda vazia: Agora / Próximas passagens / Histórico, cada um com a frase própria',
  (await lerBloco(anun, 'agora')) === 'AGORA Sem localização no momento' &&
    (await lerBloco(anun, 'proximas')) === 'PRÓXIMAS PASSAGENS Nenhuma passagem publicada.' &&
    (await lerBloco(anun, 'historico')) === 'HISTÓRICO Nenhuma passagem encerrada ainda.',
  texto(await dlg.innerText()),
);
await shot(dlg, 'vazia');
await fecharAgenda(anun);

// ---------------------------------------------------------------------------
console.log('== Admin: passagens do Móvel no estabelecimento aguardando ==');
const PERCENTUAL = (await apiAdmin('/admin/hospedagem/percentual')).json?.percentual;
const hospedar = async (tela, inicio, fim, extra = {}) => {
  const r = await apiAdmin(`/admin/pontos/${REDE}/compromissos`, 'POST', {
    contexto: 'conta',
    conta_id: Number(ANF),
    endereco_origem: 'ponto',
    ponto_id: Number(FIXO),
    inicio,
    fim,
    horario_modo: 'periodo',
    telas: [Number(tela)],
    motivo: 'aguardando_instalacao',
    percentual_esperado: PERCENTUAL,
    observacao: 'Observação interna ZXQ',
    ...extra,
  });
  if (r.status !== 201) throw new Error(`hospedagem: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.ref;
};
const agir = async (ref, acao, corpo = {}) => {
  const r = await apiAdmin(`/admin/pontos/${REDE}/compromissos/${ref}/${acao}`, 'POST', corpo);
  check(`${ref}: ${acao}`, r.status === 200, JSON.stringify(r.json));
};
const termoAssinado = async (ref) =>
  check(
    `${ref}: termo físico assinado`,
    (await apiAdmin(`/admin/pontos/${REDE}/hospedagens/${ref.slice(1)}/termo-fisico`, 'PUT', { assinado: true }))
      .status === 200,
  );
const ENTREGA = { entrega: { itens: { tela: true }, condicao: 'ok' } };

// Passagem que JÁ ACONTECEU (tela B): prevista de -1 h a +1 dia, encerrada
// agora — o histórico mostra o período REAL, não o previsto.
const H_PASSADA = await hospedar(TELA_B, parede(-HORA), parede(DIA), { local: 'Empório Silva — Café da Manhã' });
await termoAssinado(H_PASSADA);
await agir(H_PASSADA, 'iniciar', ENTREGA);
await agir(H_PASSADA, 'encerrar');
// Um evento em outro local (tela C), também encerrado depois: o mais recente.
const evento = await apiAdmin(`/admin/pontos/${REDE}/compromissos`, 'POST', {
  contexto: 'externo',
  nome: 'Feira do Bairro',
  local: 'Praça Central',
  endereco_origem: 'outro',
  endereco_partes: { cep: '15990-000', logradouro: 'Praça da Matriz', numero: '1', bairro: 'Centro', cidade: 'Matão', uf: 'SP' },
  inicio: parede(-HORA),
  fim: parede(3 * HORA),
  horario_modo: 'periodo',
  telas: [Number(TELA_C)],
  motivo: 'evento',
  observacao: 'Observação interna ZXQ',
});
check('evento criado', evento.status === 201, JSON.stringify(evento.json));
const E_PASSADO = evento.json?.ref;
await agir(E_PASSADO, 'iniciar');
await agir(E_PASSADO, 'encerrar');
// Passagem EM CURSO (tela A), no estabelecimento que espera a instalação.
const H_AGORA = await hospedar(TELA_A, parede(-HORA), parede(2 * DIA));
await termoAssinado(H_AGORA);
await agir(H_AGORA, 'iniciar', ENTREGA);
// Duas FUTURAS (tela B): a que vai ser cancelada começa primeiro.
const H_CANCELADA = await hospedar(TELA_B, parede(2 * DIA), parede(2 * DIA + 5 * HORA), {
  local: 'Degustação Cancelada',
});
const H_PROXIMA = await hospedar(TELA_B, parede(4 * DIA), parede(6 * DIA));
check(
  'vínculo e motivo gravados (local_ponto_id, motivo_alocacao) — dado só do Admin',
  PG(
    `SELECT COUNT(*) FROM pontos_moveis_hospedagens WHERE local_ponto_id = ${FIXO} AND motivo_alocacao = 'aguardando_instalacao'`,
  ) === '4',
);

// ---------------------------------------------------------------------------
console.log('== Anfitriã: confirmar-plano conta só o que já está na rede ==');
const anf = await entrar(emailAnf, 1280, 900, 'anfitriã');
await irQuieto(anf, `${B}/anunciante/confirmar-plano.html?plano=essencial-1m`);
await anf.waitForSelector('#confirmacaoPedido .aviso-rede', { timeout: 10000 });
const aviso = texto(await anf.locator('#confirmacaoPedido .aviso-rede').innerText());
check(
  'confirmar-plano: "1 ponto na rede" (a rede móvel; os 2 aguardando não contam)',
  /^Hoje há 1 ponto na rede, todos no ar\./.test(aviso) && !/cadastrad/i.test(aviso),
  aviso,
);
// Com plano, o PRÓPRIO estabelecimento aguardando também não é escolhível.
PG(
  `UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${ANF}`,
);
await irQuieto(anf, `${B}/anunciante/painel.html`);
await anf.waitForSelector(`.ponto-escolha[data-ponto-id="${REDE}"]`, { timeout: 10000 });
check(
  'anfitriã: o próprio ponto aguardando fora da escolha (sem "Seu ponto")',
  (await anf.locator(`.ponto-escolha[data-ponto-id="${FIXO}"]`).count()) === 0 &&
    (await anf.locator('#listaPontos .seu-ponto').count()) === 0,
);
await anf.context().close();

// ---------------------------------------------------------------------------
console.log('== Anunciante: a rede é a posição; o estabelecimento nunca vira card ==');
await assentarERecarregar(anun);
await anun.waitForSelector(`.ponto-escolha[data-ponto-id="${REDE}"]`, { timeout: 10000 });
check(
  'escolha: os dois aguardando fora da lista',
  (await anun.locator(`.ponto-escolha[data-ponto-id="${FIXO}"], .ponto-escolha[data-ponto-id="${FIXO_SEM_DATA}"]`).count()) === 0,
);
check('escolha: um card só do Móvel', (await anun.locator('#listaPontos .ponto-movel').count()) === 1);
check(
  'escolha: "Empório Silva" só dentro do card do Móvel (passagem, não ponto)',
  (await anun.locator('#listaPontos .ponto-escolha:not(.ponto-movel)', { hasText: 'Empório Silva' }).count()) === 0,
);
textoCard = texto(await cardRede().innerText());
check('card: Mostraí Móvel + Matão/SP', textoCard.includes('Mostraí Móvel') && textoCard.includes('Matão/SP'), textoCard);
check('card: Local atual = onde o Móvel está agora', /Local atual Empório Silva/i.test(textoCard), textoCard);
check(
  'card: a próxima é a primeira programada (antes do cancelamento)',
  /Próxima localização Degustação Cancelada ·/i.test(textoCard),
  textoCard,
);
const PROIBIDO = /Comercial Silva|Quitanda|Sem data definida|20\/11\/2026|2026-11-20|Aguardando instalação|aguardando_instalacao|ZXQ|Motivo|Termo|M-\d{4}|percentual|Benefício/i;
const textoEscolha = await anun.locator('#painelPontos').innerText();
check('escolha: nada de planejamento interno', !PROIBIDO.test(textoEscolha), textoEscolha.match(PROIBIDO)?.[0]);
await anun.evaluate(() => {
  document.getElementById('msgPontos').textContent = '';
});
await cardRede().locator('.ponto-nome').click();
await anun.waitForFunction(() => /Pronto/.test(document.getElementById('msgPontos').textContent), null, { timeout: 8000 });
check(
  'escolheu o Móvel: 1 posição, a REDE',
  PG(`SELECT string_agg(ponto_id::text, ',') FROM anunciantes_pontos WHERE anunciante_id = ${ANUN}`) === REDE,
);
check(
  `contador "1 de ${LIMITE}"`,
  (await anun.textContent('#contadorPontos')) === `1 de ${LIMITE} pontos selecionados`,
  await anun.textContent('#contadorPontos'),
);
const apiAnun = (caminho, metodo = 'GET', corpo) =>
  anun.evaluate(
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
const recusa = await apiAnun('/anunciantes/me/pontos', 'PUT', { pontos: [Number(REDE), Number(FIXO)] });
check(
  'o estabelecimento da passagem não é escolhível nem pela API (400 com o motivo)',
  recusa.status === 400 && /em instalação/.test(recusa.json?.erro || ''),
  JSON.stringify(recusa),
);
const disponiveis = JSON.stringify((await apiAnun('/anunciantes/me/pontos-disponiveis')).json);
check(
  'API do cliente: sem os aguardando nem planejamento',
  !/instalacao_prevista|motivo|aguardando|Comercial Silva|ZXQ/i.test(disponiveis) &&
    !JSON.parse(disponiveis).pontos.some((p) => [FIXO, FIXO_SEM_DATA].includes(String(p.id))),
);

console.log('== Anunciante: Ver agenda — Agora, Próximas passagens, Histórico ==');
dlg = await abrirAgenda(anun);
const agora = await lerBloco(anun, 'agora');
const proximas = await lerBloco(anun, 'proximas');
check('Agora: a passagem em curso no estabelecimento', /^AGORA .*Empório Silva/.test(agora) && !/Café da Manhã/.test(agora), agora);
check(
  'Próximas passagens: as duas programadas, na ordem',
  /^PRÓXIMAS PASSAGENS .*Degustação Cancelada.*Empório Silva/.test(proximas),
  proximas,
);
const itensHistorico = await linhasDo(anun, 'historico').allInnerTexts();
check(
  'Histórico: as duas encerradas, a mais recente primeiro (evento com o local)',
  itensHistorico.length === 2 &&
    /Feira do Bairro/.test(itensHistorico[0]) &&
    /Praça Central/.test(itensHistorico[0]) &&
    /Evento/.test(itensHistorico[0]) &&
    /Café da Manhã/.test(itensHistorico[1]) &&
    /Estabelecimento/.test(itensHistorico[1]),
  JSON.stringify(itensHistorico),
);
// Período REAL (iniciada_em → encerrada_em), não o previsto (-1 h → +1 dia).
const [ini, enc, prevIni, prevFim] = PG(
  `SELECT (extract(epoch FROM iniciada_em) * 1000)::bigint || '|' || (extract(epoch FROM encerrada_em) * 1000)::bigint
          || '|' || (extract(epoch FROM inicio) * 1000)::bigint || '|' || (extract(epoch FROM fim) * 1000)::bigint
     FROM pontos_moveis_hospedagens WHERE id = ${H_PASSADA.slice(1)}`,
)
  .split('|')
  .map(Number);
const periodos = await anun.evaluate(
  ([a, b, c, d]) => {
    const real = window.PONTO_MOVEL.periodoDaAgenda(a, b);
    const previsto = window.PONTO_MOVEL.periodoDaAgenda(c, d);
    return { real: `${real.data} ${real.horario}`, previsto: `${previsto.data} ${previsto.horario}` };
  },
  [ini, enc, prevIni, prevFim],
);
const dataDaPassada = bloco(anun, 'historico')
  .locator('.agenda-movel-item', { hasText: 'Café da Manhã' })
  .locator('.agenda-movel-data');
const dataDoItem = (await dataDaPassada.count()) ? texto(await dataDaPassada.innerText()) : '';
check(
  'Histórico: período REAL da passagem (não o previsto)',
  dataDoItem === periodos.real && periodos.real !== periodos.previsto,
  `${dataDoItem} | real ${periodos.real} | previsto ${periodos.previsto}`,
);
const tons = await anun.evaluate(() => {
  const fundo = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).backgroundColor : null;
  };
  return {
    historico: fundo('#dlgAgendaMovel [data-agenda-bloco="historico"] .agenda-movel-item'),
    proximas: fundo('#dlgAgendaMovel [data-agenda-bloco="proximas"] .agenda-movel-item'),
  };
});
check(
  'Histórico em tom secundário (sem o fundo das outras linhas)',
  tons.historico === 'rgba(0, 0, 0, 0)' && tons.proximas !== tons.historico,
  JSON.stringify(tons),
);
const textoAgenda = await dlg.innerText();
check('agenda: nada de planejamento interno', !PROIBIDO.test(textoAgenda), textoAgenda.match(PROIBIDO)?.[0]);
const agendaJson = (await apiAnun(`/anunciantes/me/redes-moveis/${REDE}/agenda`)).json;
const chaves = new Set(
  ['agora', 'proximos', 'historico'].flatMap((k) => agendaJson[k]).flatMap((c) => Object.keys(c)),
);
check(
  'agenda (API): só as chaves públicas',
  JSON.stringify([...chaves].sort()) === JSON.stringify(['fim', 'inicio', 'local', 'nome', 'tipo']),
  JSON.stringify([...chaves]),
);
check(
  'agenda: os três blocos, cada um nomeado pelo título (região acessível)',
  await anun.evaluate(() => {
    const blocos = [...document.querySelectorAll('#dlgAgendaMovel [data-agenda-bloco]')];
    return (
      blocos.length === 3 &&
      blocos.every((s) => document.getElementById(s.getAttribute('aria-labelledby'))?.tagName === 'H4')
    );
  }),
);
check('1280: sem rolagem lateral com a agenda aberta', await semRolagemLateral(anun));
await shot(dlg, 'completa-1280');
// Teclado: Esc fecha; o "Ver agenda" abre pelo Enter e o foco vai para o diálogo.
await anun.keyboard.press('Escape');
await anun.waitForFunction(() => !document.getElementById('dlgAgendaMovel').open);
await anun.locator(`.ponto-escolha[data-ponto-id="${REDE}"] [data-agenda-rede]`).focus();
await anun.keyboard.press('Enter');
await anun.waitForSelector('#dlgAgendaMovel[open] .agenda-movel-bloco', { timeout: 8000 });
check(
  'teclado: Enter no "Ver agenda" abre e o foco fica no diálogo',
  await anun.evaluate(() => document.getElementById('dlgAgendaMovel').contains(document.activeElement)),
);
check('Ver agenda não mexe na escolha', await cardRede().locator('input').isChecked());
await anun.keyboard.press('Escape');

// ---------------------------------------------------------------------------
console.log('== Admin cancela a próxima: some para o cliente ==');
await agir(H_CANCELADA, 'cancelar', { motivo: 'Motivo interno ZXQ — o dono pediu para adiar' });
await assentarERecarregar(anun);
await anun.waitForSelector(`.ponto-escolha[data-ponto-id="${REDE}"]`, { timeout: 10000 });
textoCard = texto(await cardRede().innerText());
check(
  'card: a próxima passa a ser a programada seguinte (nunca a cancelada)',
  /Próxima localização Empório Silva ·/i.test(textoCard) && !/Degustação Cancelada/.test(textoCard),
  textoCard,
);
dlg = await abrirAgenda(anun);
const depoisDoCancelamento = texto(await dlg.innerText());
check(
  'agenda: a cancelada não aparece em bloco nenhum (nem no Histórico)',
  !/Degustação Cancelada/.test(depoisDoCancelamento) &&
    (await linhasDo(anun, 'proximas').count()) === 1 &&
    (await linhasDo(anun, 'historico').count()) === 2,
  depoisDoCancelamento,
);
check('agenda: nem o motivo do cancelamento', !PROIBIDO.test(depoisDoCancelamento));
await fecharAgenda(anun);

// ---------------------------------------------------------------------------
console.log('== Site "Onde estamos": sem os aguardando ==');
const site = await pagina(1280, 900, 'onde-estamos');
await irQuieto(site, `${B}/pontos.html`);
await site.waitForSelector('#pontosGrid .ponto-card');
const grade = texto(await site.locator('#pontosGrid').innerText());
check(
  'site: nenhum card fixo (os dois ainda não foram instalados)',
  (await site.locator('#pontosGrid .ponto-card:not(.ponto-card-movel)').count()) === 0 && !/Quitanda/.test(grade),
  grade,
);
check('site: o Móvel com o local de agora', /Local atual Empório Silva/i.test(grade), grade);
const faixa = texto(await site.locator('#statRow').innerText());
check('site: sem o número "Em instalação"', !/instala/i.test(faixa) && /1 Ponto ativo/.test(faixa), faixa);
check('site: nada de planejamento interno', !PROIBIDO.test(grade));
await shot(site, 'site-antes-da-instalacao', { fullPage: true });

// ---------------------------------------------------------------------------
console.log('== Instalação fixa no estabelecimento: o histórico fica ==');
await apiAdmin('/admin/player/pin-saida', 'PUT', { pin: '482715' });
const telaFixo = await apiAdmin(`/admin/pontos/${FIXO}/dispositivos`, 'POST', {});
const codigo = await apiAdmin(`/admin/dispositivos/${telaFixo.json?.id}/codigo-instalacao`, 'POST');
const instalou = await fetch(`${B}/player/provisionar`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Player-Version': '1.2.0+12' },
  body: JSON.stringify({ codigoTela: codigo.json?.codigoTela, codigoInstalacao: codigo.json?.codigo }),
});
check(
  'Player instalado no estabelecimento (1º sinal): em operação',
  instalou.ok && PG(`SELECT status FROM pontos WHERE id = ${FIXO}`) === 'em_operacao',
);
await assentarERecarregar(anun);
await anun.waitForSelector(`.ponto-escolha[data-ponto-id="${FIXO}"]`, { timeout: 10000 });
check(
  'instalado: o estabelecimento vira ponto escolhível, "Ativo"',
  texto(await anun.locator(`.ponto-escolha[data-ponto-id="${FIXO}"] .ponto-card-topo .badge`).innerText()) === 'Ativo',
);
check(
  'o sem data continua fora',
  (await anun.locator(`.ponto-escolha[data-ponto-id="${FIXO_SEM_DATA}"]`).count()) === 0,
);
dlg = await abrirAgenda(anun);
check(
  'depois da instalação: Histórico intacto e a passagem em curso continua em Agora',
  (await linhasDo(anun, 'historico').count()) === 2 &&
    /Café da Manhã/.test(await lerBloco(anun, 'historico')) &&
    /Empório Silva/.test(await lerBloco(anun, 'agora')),
  texto(await dlg.innerText()),
);
await fecharAgenda(anun);
await irQuieto(site, `${B}/pontos.html`);
await site.waitForSelector('#pontosGrid .ponto-card:not(.ponto-card-movel)');
check(
  'site: instalado, o estabelecimento aparece "No ar"',
  /No ar/.test(await site.locator('#pontosGrid .ponto-card:not(.ponto-card-movel)', { hasText: 'Empório Silva' }).innerText()),
);

// ---------------------------------------------------------------------------
console.log('== Larguras: 820 e 390 px ==');
for (const [rotulo, largura, altura] of [
  ['820', 820, 1100],
  ['390', 390, 844],
]) {
  const p = await entrar(emailAnun, largura, altura, `anunciante ${rotulo}`);
  await p.waitForSelector(`.ponto-escolha[data-ponto-id="${REDE}"]`, { timeout: 10000 });
  check(`${rotulo}: painel sem rolagem lateral`, await semRolagemLateral(p));
  const d = await abrirAgenda(p);
  check(`${rotulo}: agenda aberta sem rolagem lateral`, await semRolagemLateral(p));
  check(
    `${rotulo}: o diálogo não transborda na horizontal`,
    await d.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth),
  );
  check(
    `${rotulo}: linhas inteiras dentro do diálogo`,
    await d.evaluate((el) =>
      [...el.querySelectorAll('.agenda-movel-item')].every((i) => i.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5),
    ),
  );
  await shot(d, `completa-${rotulo}`);
  await p.context().close();
}

await navegador.close();
console.log(`\n${falhas.length ? `${falhas.length} FALHA(S)` : 'tudo ok'}; ${erros.length} erro(s) de console`);
for (const e of erros) console.log('  ', e);
process.exit(falhas.length || erros.length ? 1 : 0);
