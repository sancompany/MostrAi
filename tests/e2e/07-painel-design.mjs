// Verificação visual/funcional do redesenho de 21/09/2026: marca (Mostraí),
// paleta (sem azul-marinho no hero), hero sem KPI duplicado + estado
// operacional (ponto online/offline), custo por exibição prevista, "previstas"
// no lugar de "contratadas", média diária corrigida e barra de distribuição
// escondida com 1 ponto só. Assume banco zerado e servidor na 3999.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const ctxAdmin = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const falhas = [];
const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
async function pagina(url, contexto = ctx) {
  const p = await contexto.newPage();
  p.on('pageerror', (e) => erros.push(`${url}: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) erros.push(`${url} console: ${m.text()}`);
  });
  p.on('dialog', async (d) => d.accept(d.defaultValue()));
  await p.goto(B + url, { waitUntil: 'networkidle' });
  return p;
}
const shot = (p, n) => p.screenshot({ path: new URL(`./saida/v23-${n}.png`, import.meta.url).pathname, fullPage: true });

const adm = await pagina('/admin/', ctxAdmin);
await adm.fill('#usuario', 'admin');
await adm.fill('#senha', 'Admin12@teste');
await adm.click('#formLogin button[type=submit]');
await adm.waitForSelector('#app:not([hidden])');

console.log('== conta nova, cadastro + confirmação de e-mail ==');
const cadastro = await pagina('/');
const conta = await cadastro.evaluate(
  async () =>
    await (
      await fetch('/anunciantes/cadastro', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome_empresa: 'San União',
          cpf_cnpj: '390.533.447-05',
          endereco: 'Rua Lu, 5',
          cidade: 'Matão',
          uf: 'SP',
          cep: '15990-000',
          contato_email: 'lu@x.com',
          contato_telefone: '16 99463-5946',
          senha: 'Senha12@',
          aceitou_termos: true,
        }),
      })
    ).json(),
);
const codigo = PG(`SELECT codigo FROM tokens_confirmacao_email WHERE anunciante_id=${conta.id}`);
await cadastro.evaluate(
  async (codigo) =>
    await fetch('/anunciantes/me/confirmar-email', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo }),
    }).then((r) => r.json()),
  codigo,
);

console.log('== admin libera plano de cortesia (Pro, cobre vários pontos) ==');
const liberado = await adm.evaluate(
  async (id) =>
    await (
      await fetch(`/admin/anunciantes/${id}/liberar-plano`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plano_id: 'destaque-1m', meses: 1, motivo: 'teste e2e (script 07)' }),
      })
    ).json(),
  conta.id,
);
check('admin liberou o plano', !!liberado.plano_id, JSON.stringify(liberado));

console.log('== semeando um ponto OFFLINE (nunca esteve online) com programação ==');
// CTE (WITH ... SELECT) em vez de INSERT solto: com -t, psql ainda imprime a
// tag "INSERT 0 1" antes da linha do RETURNING, e só um SELECT some com ela.
const pontoId = Number(
  PG(
    `WITH ins AS (INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
     VALUES ('Bruno Henrique Sanches', 'Rua X, 1', 'Matão', 'SP', '15990-000', 'comercio', 'Bruno', '16999999999', 'em_operacao')
     RETURNING id) SELECT id FROM ins`,
  ),
);
const dispositivoId = Number(
  PG(
    `WITH ins AS (INSERT INTO dispositivos (ponto_id, aparelho_id, status) VALUES (${pontoId}, 'chave-teste-07', 'ativo') RETURNING id)
     SELECT id FROM ins`,
  ),
);
const horaAtual = new Date();
horaAtual.setMinutes(0, 0, 0);
PG(
  `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas, vezes_pedidas)
   VALUES (${conta.id}, ${dispositivoId}, '${horaAtual.toISOString()}', 15, 1, 15)`,
);

const p = await pagina('/anunciante/painel.html', ctx);
await p.waitForTimeout(1000);

console.log('== marca: Mostraí em toda a página, nenhum MostrAi sem acento ==');
const textoPagina = await p.evaluate(() => document.body.innerText);
check('grafia Mostraí presente', textoPagina.includes('Mostraí'));
check('nenhum MostrAi sem acento visível', !textoPagina.includes('MostrAi'));

console.log('== hero: sem faixa de métricas duplicadas, com estado operacional ==');
check('hero-metrics não existe mais', !(await p.$('.hero-metrics')));
check('heroStatus visível', await p.isVisible('#heroStatus'));
const statusTxt = await p.textContent('#heroStatus');
check('mostra "0 de 1" (tela nunca deu sinal)', /0 de 1/.test(statusTxt), statusTxt);
check('acusa que nunca recebeu playlist', statusTxt.includes('nunca recebeu playlist'), statusTxt);

console.log('== cor: hero não é mais azul-marinho ==');
const bgHero = await p.$eval('#statusBanner', (el) => getComputedStyle(el).backgroundImage);
check('hero sem azul #172a46/#245b94 no gradiente', !/23,\s*42,\s*70|36,\s*91,\s*148/.test(bgHero), bgHero.slice(0, 80));

console.log('== card de exibições: linguagem "previstas" ==');
const capExibicoes = await p.textContent('[data-kpi="exibicoes"] .kpi-caption');
check('caption usa "previstas"', capExibicoes.includes('previstas'), capExibicoes);
check('caption não usa mais "contratado"', !capExibicoes.includes('contratado'), capExibicoes);

console.log('== card de custo: "Custo por exibição prevista" (ADR-018) ==');
const labelCusto = await p.textContent('[data-kpi="custo"] .kpi-label');
check('label é "Custo por exibição prevista"', /Custo por exibição prevista/i.test(labelCusto) && !labelCusto.includes('1.000'), labelCusto);
// Plano liberado pelo admin (cortesia legada): sem dinheiro, sem "R$ 0,00".
const valorCusto = await p.textContent('[data-kpi="custo"] b');
const legendaCusto = await p.textContent('[data-kpi="custo"] .kpi-caption');
check('cortesia não finge custo: "Cortesia · Sem cobrança neste ciclo"', valorCusto.trim() === 'Cortesia' && /Sem cobrança neste ciclo/.test(legendaCusto), `${valorCusto} | ${legendaCusto}`);

console.log('== média diária: não usa mais "dia do mês" como divisor ==');
const valorMedia = await p.textContent('[data-kpi="media"] b');
check('média diária é 1 (1 confirmada / 1 dia decorrido), não 0.x', valorMedia.trim() === '1', valorMedia);

console.log('== distribuição por ponto: barra escondida com 1 ponto só ==');
const graficoPonto = await p.textContent('#graficoPonto');
check('gráfico de barra vazio com 1 ponto', graficoPonto.trim() === '', graficoPonto);
check('tabela detalhada continua mostrando o ponto', (await p.textContent('#exibicoesDetalhe')).includes('Bruno Henrique Sanches'));

await shot(p, 'hero-1-ponto-offline');

console.log('== adicionando 2º ponto ONLINE + 3º com sinal antigo (2 de 3 no ar) ==');
const ponto2 = Number(
  PG(
    `WITH ins AS (INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
     VALUES ('Padaria Lu', 'Rua Y, 2', 'Matão', 'SP', '15990-000', 'comercio', 'Lu', '16999999998', 'em_operacao')
     RETURNING id) SELECT id FROM ins`,
  ),
);
const disp2 = Number(
  PG(
    `WITH ins AS (INSERT INTO dispositivos (ponto_id, chave_hash, status, modo_horario, primeiro_sinal_em, ultima_vez_online)
     VALUES (${ponto2}, encode(sha256('chave-teste-07b'), 'hex'), 'ativo', '24h', now() - interval '1 day', now()) RETURNING id)
     SELECT id FROM ins`,
  ),
);
PG(
  `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas, vezes_pedidas)
   VALUES (${conta.id}, ${disp2}, '${horaAtual.toISOString()}', 15, 3, 15)`,
);
const ponto3 = Number(
  PG(
    `WITH ins AS (INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
     VALUES ('Mercado Z', 'Rua Z, 3', 'Matão', 'SP', '15990-000', 'comercio', 'Z', '16999999997', 'em_operacao')
     RETURNING id) SELECT id FROM ins`,
  ),
);
const disp3 = Number(
  PG(
    `WITH ins AS (INSERT INTO dispositivos (ponto_id, chave_hash, status, modo_horario, primeiro_sinal_em, ultima_vez_online)
     VALUES (${ponto3}, encode(sha256('chave-teste-07c'), 'hex'), 'ativo', '24h', now() - interval '1 day', now() - interval '5 hours') RETURNING id)
     SELECT id FROM ins`,
  ),
);
PG(
  `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas, vezes_pedidas)
   VALUES (${conta.id}, ${disp3}, '${horaAtual.toISOString()}', 15, 2, 15)`,
);

await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1000);
const statusTxt3 = await p.textContent('#heroStatus');
check('agora mostra "1 de 3" (só o online conta)', /1 de 3/.test(statusTxt3), statusTxt3);
check('acusa sinal antigo em horas, não "nunca"', /sinal mais antigo há \d+ h/.test(statusTxt3), statusTxt3);
check('gráfico de barra reaparece com 3 pontos', (await p.textContent('#graficoPonto')).trim() !== '');
await shot(p, 'hero-3-pontos-mistos');

console.log('\nerros de página:', erros.length ? erros : 'nenhum');
console.log('falhas:', falhas.length);
await b.close();
process.exit(falhas.length || erros.length ? 1 : 0);
