// A obrigação de veiculação nasce do CICLO CONTRATADO, não da capacidade da
// rede (correção estrutural de 01/10/2026, migration 111 — §38 do pedido do
// dono). Ponta a ponta, pelos caminhos reais:
//   rede vazia → cadastro → POST /assinar (Pro) → webhook assinado do San
//   Checkout (`criada`) → plano ativo → obrigação de 84 h → painel "84h a
//   entregar · 0s entregues" → admin cria ponto e tela, o Player se instala →
//   a conta escolhe o ponto → GET /playlist (gerador) → POST /played
//   (Proof-of-Play) → o saldo cai exatamente o tempo confirmado → renovação
//   (`cobranca_confirmada`) → +84 h somadas ao que faltava.
// Pré-condições: banco zerado (reset-db.sh) e servidor na 3999 (restart.sh).
import { execSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const SAIDA = new URL('./saida/44-', import.meta.url).pathname;
fs.mkdirSync(new URL('./saida/', import.meta.url).pathname, { recursive: true });
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const falhas = [];
const erros = [];
const check = (t, cond, d = '') => {
  console.log(cond ? '  ok ' : '  FALHA', t, cond ? '' : typeof d === 'string' ? d : JSON.stringify(d));
  if (!cond) falhas.push(t);
};
const esperar = async (fn, ms = 15000) => {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
// A mesma régua do painel (painel.page.js#tempoAEntregar).
const tempo = (segundos) => {
  const s = Math.max(0, Math.round(Number(segundos) || 0));
  if (s < 60) return `${s}s`;
  const minutos = Math.round(s / 60);
  const h = Math.floor(minutos / 60);
  const min = minutos % 60;
  if (!h) return `${min}min`;
  return min ? `${h}h ${min}min` : `${h}h`;
};
const H = 3600;
const PRO = 'destaque-1m';
const marca = Date.now();
const IMAGEM = `${B}/img/exemplo-ponto-completo-720.jpg`;

// Webhook como o San Checkout assina (API.md dele, 4.3.1): HMAC-SHA256 de
// "{timestamp}.{corpo cru}" com a chave do Checkout. O `eventoId` é o atalho
// de teste da dedupe (02-assinatura-webhook-comissao.sh).
async function webhook(corpo) {
  const cru = JSON.stringify(corpo);
  const ts = String(Math.floor(Date.now() / 1000));
  const assinatura = `sha256=${createHmac('sha256', process.env.SAN_CHECKOUT_KEY).update(`${ts}.${cru}`).digest('hex')}`;
  const r = await fetch(`${B}/webhook/san-checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Checkout-Signature': assinatura, 'X-Checkout-Timestamp': ts },
    body: cru,
  });
  return r.status;
}

// ===========================================================================
console.log('== 1. rede vazia: nada no ar ==');
check('nenhum ponto em operação', PG("SELECT count(*) FROM pontos WHERE status = 'em_operacao'") === '0');
check('nenhuma tela', PG('SELECT count(*) FROM dispositivos') === '0');

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME, args: ['--lang=pt-BR'] }));
const ctxConta = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR' });
const conta = ctxConta.request;
const email = `e2e44-${marca}@teste.dev`;
const categoria = PG("SELECT id FROM categorias WHERE ativo AND nome ILIKE 'Padaria%' LIMIT 1");
const cad = await conta.post(`${B}/anunciantes/cadastro`, {
  data: {
    nome_empresa: 'Padaria Obrigação E2E',
    cpf_cnpj: '52998224725',
    categoria_id: Number(categoria),
    cep: '15990-000',
    logradouro: 'Avenida Habib Gabriel',
    numero: '1200',
    bairro: 'Centro',
    cidade: 'Matão',
    uf: 'SP',
    contato_email: email,
    contato_telefone: '(16) 99999-0044',
    senha: 'Senha@Forte1',
    aceitou_termos: true,
  },
});
check('cadastro', cad.status() === 201, String(cad.status()));
const ID = PG(`WITH u AS (UPDATE anunciantes SET email_confirmado = true WHERE contato_email = '${email}' RETURNING id) SELECT id FROM u`);

// ===========================================================================
console.log('== 2. compra do Pro com a rede vazia: a venda não é bloqueada ==');
const assinar = await conta.post(`${B}/anunciantes/${ID}/assinar`, { data: { planoId: PRO } });
const corpoAssinar = await assinar.json().catch(() => null);
check('POST /assinar devolve o link do checkout', assinar.status() === 200 && !!corpoAssinar?.checkoutUrl, corpoAssinar);
const ASS = PG(`SELECT id FROM assinaturas WHERE anunciante_id = ${ID} AND status = 'pendente_pagamento' ORDER BY created_at DESC LIMIT 1`);
check('assinatura pendente de pagamento', !!ASS);
check(
  'pagamento confirmado (webhook `criada`) aceito',
  (await webhook({ versao: 1, tipo: 'assinatura', planoId: ASS, documento: '52998224725', evento: 'criada', eventoId: `ev44-${marca}-1` })) === 200,
);
check('plano ativo', !!(await esperar(() => PG(`SELECT plano_id FROM anunciantes WHERE id = ${ID}`) === PRO)));
const [sph, pontosIncluidos] = PG(`SELECT segundos_por_hora, pontos_incluidos FROM planos WHERE id = '${PRO}'`).split('|').map(Number);
const DO_PLANO = Math.round((sph * pontosIncluidos * 12 * 30) / H) * H; // src/lib/pacing.js#horasDeTelaPorMes
check('o plano diz 84 h de tela por mês', DO_PLANO === 84 * H, String(DO_PLANO));
const lote1 = await esperar(() => PG(`SELECT tipo || '|' || segundos FROM obrigacoes_veiculacao WHERE anunciante_id = ${ID}`));
check('a obrigação nasce do ciclo: um lote de 84 h, lido do plano', lote1 === `ciclo|${DO_PLANO}`, lote1);
check('com zero tela na rede (a capacidade não decide a obrigação)', PG('SELECT count(*) FROM dispositivos') === '0');

const bancoHoras = async () => (await conta.get(`${B}/anunciantes/me/banco-horas`)).json();
let bh = await bancoHoras();
// A campanha está sem peça desde a compra (tempo do cliente, RN-53): os
// segundos até agora saem do contratado — por isso a tolerância de 1 min.
check('contratado ≈ 84 h', bh.contratadoSegundos <= 84 * H && bh.contratadoSegundos > 84 * H - 60, bh);
check('entregue 0', bh.entregueSegundos === 0, bh);
check('saldo a entregar = contratado − entregue', bh.segundos === bh.contratadoSegundos - bh.entregueSegundos, bh);

const painel = await ctxConta.newPage();
painel.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
painel.on('console', (m) => m.type() === 'error' && !/status of (401|404|409)/.test(m.text()) && erros.push(`console: ${m.text()}`));
await irQuieto(painel, `${B}/anunciante/painel.html`);
const cardBanco = async () => {
  await painel.waitForFunction(() => {
    const t = document.querySelector('#kpiGrid [data-kpi="banco"] b')?.textContent.trim();
    return t && t !== '-';
  }, null, { timeout: 15000 });
  return painel.$eval('#kpiGrid [data-kpi="banco"]', (c) => ({
    numero: c.querySelector('b').textContent.trim(),
    legenda: c.querySelector('[data-kpi-banco-legenda]').textContent.trim(),
  }));
};
let card = await cardBanco();
check('painel: "84h" a entregar', card.numero === '84h', card);
check('painel: "84h contratadas, 0s entregues"', /^a entregar · 84h contratadas, 0s entregues/.test(card.legenda), card);
check('painel: nunca "Em dia" com dívida', card.numero !== 'Em dia');
await (await painel.$('#kpiGrid')).screenshot({ path: `${SAIDA}1-compra-rede-vazia.png` });

// ===========================================================================
console.log('== 3. a rede ganha uma tela; a conta escolhe o ponto; a peça é aprovada ==');
const ctxAdmin = await b.newContext();
const admin = async (caminho, metodo = 'GET', corpo) => {
  const r = await ctxAdmin.request.fetch(`${B}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    data: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
check('admin logou', (await admin('/admin/login', 'POST', { usuario: process.env.ADMIN_USER, senha: process.env.ADMIN_PASSWORD })).status === 200);
const H24 = JSON.stringify(
  Object.fromEntries(['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].map((d) => [d, { abre: '00:00', fecha: '24:00' }])),
);
const PONTO = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, horario_semanal)
   VALUES ('Mercado Obrigação E2E', 'Rua Dois, 2', 'Matão', 'SP', '15990000', 'outro', 'R', '1', '${H24}'::jsonb) RETURNING id`,
)
  .split('\n')[0]
  .trim();
const TELA = PG(`INSERT INTO dispositivos (ponto_id, apelido, status) VALUES (${PONTO}, 'Tela 1', 'ativo') RETURNING id`)
  .split('\n')[0]
  .trim();
await admin('/admin/player/pin-saida', 'PUT', { pin: '482715' });
const codigo = await admin(`/admin/dispositivos/${TELA}/codigo-instalacao`, 'POST');
const prov = await fetch(`${B}/player/provisionar`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Player-Version': '1.2.0+12' },
  body: JSON.stringify({ codigoTela: codigo.json?.codigoTela, codigoInstalacao: codigo.json?.codigo }),
});
const cred = await prov.json();
check('o Player se instala', prov.status === 200 && !!cred.chaveAparelho, String(prov.status));
const tv = async (metodo, caminho, corpo) => {
  const r = await fetch(`${B}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Player-Version': '1.2.0+12', 'X-Aparelho-Key': cred.chaveAparelho },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
check('ponto em operação', PG(`SELECT status FROM pontos WHERE id = ${PONTO}`) === 'em_operacao');
const escolha = await conta.put(`${B}/anunciantes/me/pontos`, { data: { pontos: [Number(PONTO)] } });
check('a conta escolhe o ponto', escolha.status() === 200, String(escolha.status()));
// A peça chega como chegaria do upload (em análise) e o admin aprova pela API.
const CRIATIVO = PG(
  `INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, thumbnail_url, duracao_segundos, status)
   VALUES (${ID}, '${IMAGEM}', '${IMAGEM}', '${IMAGEM}', 10, 'pendente') RETURNING id`,
)
  .split('\n')[0]
  .trim();
check('admin aprova a peça', (await admin(`/admin/criativos/${CRIATIVO}`, 'PATCH', { status: 'aprovado' })).status === 200);
check(
  'a janela "sem peça" (tempo do cliente) fecha na aprovação',
  PG(`SELECT count(*) FROM indisponibilidade_cliente WHERE anunciante_id = ${ID} AND fim IS NULL`) === '0',
);
// A peça já vale nesta hora (sem esperar a próxima janela — 26-distribuicao).
PG(`UPDATE criativos SET aprovado_em = date_trunc('hour', now()) - interval '5 minutes' WHERE id = ${CRIATIVO}`);
bh = await bancoHoras();
check('instalar tela e programar não abatem nada: entregue 0', bh.entregueSegundos === 0, bh);
const contratado = bh.contratadoSegundos;

// ===========================================================================
console.log('== 4. o gerador programa; só o Proof-of-Play abate ==');
const pl = await tv('GET', `/playlist/${cred.dispositivoId}`);
const itens = (pl.json?.itens || []).filter((i) => String(i.anuncianteId) === ID && i.contabiliza);
check('a playlist da hora traz a peça da conta', itens.length > 0, JSON.stringify(pl.json?.itens?.slice(0, 2)));
bh = await bancoHoras();
check('programado não é entregue: o saldo não muda', bh.entregueSegundos === 0 && bh.segundos === contratado, bh);
const tocados = itens.slice(0, 3);
const eventos = tocados.map((i) => ({
  execucaoId: randomUUID(),
  janelaId: i.itemProgramacaoId.split('|').slice(0, 2).join('|'),
  itemProgramacaoId: i.itemProgramacaoId,
  criativoId: i.criativoId,
  iniciadoEm: new Date().toISOString(),
  terminadoEm: new Date().toISOString(),
}));
const pop = await tv('POST', `/player/${cred.dispositivoId}/played`, { eventos });
check(
  `${tocados.length} comprovante(s) contabilizado(s)`,
  (pop.json?.resultados || []).every((r) => r.status === 'contabilizado') && pop.json?.resultados?.length === tocados.length,
  pop.json,
);
const repetido = await tv('POST', `/player/${cred.dispositivoId}/played`, { eventos: [eventos[0]] });
check('o mesmo comprovante de novo é duplicado', repetido.json?.resultados?.[0]?.status === 'duplicado', repetido.json);
const entregue = tocados.length * 10;
bh = await bancoHoras();
check(`entregue = ${entregue}s (só o confirmado, uma vez)`, bh.entregueSegundos === entregue, bh);
check('o saldo cai exatamente o confirmado', bh.segundos === contratado - entregue, bh);
await painel.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await painel.waitForFunction(
  (e) => document.querySelector('#kpiGrid [data-kpi-banco-legenda]')?.textContent.includes(`${e}s entregues`),
  entregue,
  { timeout: 10000 },
).catch(() => {});
card = await cardBanco();
check(`painel: "${entregue}s entregues", sem recarregar`, card.legenda.includes(`${entregue}s entregues`), card);
const antes = bh.segundos;

// ===========================================================================
console.log('== 5. renovação: +84 h somadas ao que faltava ==');
check(
  'renovação paga (webhook `cobranca_confirmada`) aceita',
  (await webhook({ versao: 1, tipo: 'assinatura', planoId: ASS, documento: '52998224725', evento: 'cobranca_confirmada', eventoId: `ev44-${marca}-2` })) === 200,
);
check(
  'dois lotes de ciclo no livro',
  !!(await esperar(() => PG(`SELECT count(*) FROM obrigacoes_veiculacao WHERE anunciante_id = ${ID} AND tipo = 'ciclo'`) === '2')),
);
bh = await bancoHoras();
check('saldo = o que faltava + 84 h (não substitui)', bh.segundos === antes + DO_PLANO, { antes, depois: bh.segundos });
check('o entregue continua o mesmo', bh.entregueSegundos === entregue, bh);
check('a renovação adiantada não é "saldo anterior"', bh.saldoAnteriorSegundos === 0, bh);
const extrato = (await admin(`/admin/contas/${ID}/saldo-veiculacao`)).json;
check('admin: extrato com os dois ciclos e nenhum negativo técnico', extrato?.lotes?.length === 2 && extrato.negativoTecnicoSegundos === 0, extrato?.lotes);
await painel.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await painel.waitForFunction(
  (n) => document.querySelector('#kpiGrid [data-kpi="banco"] b')?.textContent.trim() === n,
  tempo(bh.segundos),
  { timeout: 10000 },
).catch(() => {});
card = await cardBanco();
check(`painel: "${tempo(bh.segundos)}" a entregar depois da renovação`, card.numero === tempo(bh.segundos), card);
await (await painel.$('#kpiGrid')).screenshot({ path: `${SAIDA}2-renovado.png` });

check('sem erro de console', erros.length === 0, erros.join(' | '));
await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
