// Concorrentes diretos entre categorias (estação de 28/09/2026, migration
// 105): o admin cadastra o par na tela Categorias, e a TV do ponto deixa de
// receber o anúncio do concorrente — tudo pelos caminhos reais (tela do
// admin, contrato do Player: provisionar → GET /playlist). Banco zerado,
// servidor na 3999:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/28-concorrentes-diretos.mjs
//
// Roteiro (o pedido do dono, passo a passo):
//   1. admin configura o conflito A ↔ B no modal da categoria A;
//   2. o ponto é da categoria A;  3. o anunciante B é da categoria B;
//   4. o anúncio de B não entra na TV do ponto;  5. o de C continua;
//   6. o admin tira o conflito (pelo lado de B) e a programação seguinte
//      volta a ter B;  7. sem F5 (a marca `window.__semReload` sobrevive).
// As categorias A/B/C são criadas pelo roteiro — a matriz aprovada (seed) não
// é tocada.
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim()
    .split('\n')[0]
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
const shot = (p, n) => p.screenshot({ path: `${SAIDA}concorrentes-${n}.png`, fullPage: true });

// ---------------------------------------------------------------------------
// Cenário: categorias A (ponto), B (concorrente) e C (neutra); um ponto 24 h
// da categoria A com uma tela; contas B e C com plano, peça aprovada e o
// ponto escolhido.
// ---------------------------------------------------------------------------
const sufixo = Date.now();
const NOME = { a: `E2E Cafeteria ${sufixo}`, b: `E2E Padaria ${sufixo}`, c: `E2E Academia ${sufixo}` };
const CAT = {};
for (const [k, nome] of Object.entries(NOME)) {
  CAT[k] = Number(PG(`INSERT INTO categorias (nome, grupo) VALUES ('${nome}', 'E2E') RETURNING id`));
}
const H24 = JSON.stringify(
  Object.fromEntries(['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].map((d) => [d, { abre: '00:00', fecha: '24:00' }])),
);
const PONTO = Number(
  PG(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, horario_semanal, categoria_id)
     VALUES ('Cafeteria Concorrência', 'Rua Dois, 2', 'Matão', 'SP', '15990000', 'outro', 'R', '1', '${H24}'::jsonb, ${CAT.a}) RETURNING id`,
  ),
);
const TELA = Number(PG(`INSERT INTO dispositivos (ponto_id, apelido, status) VALUES (${PONTO}, 'Tela 1', 'ativo') RETURNING id`));
function conta(nome, categoria) {
  const id = Number(
    PG(
      `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, papeis,
                                email_confirmado, plano_id, data_inicio_cobertura, data_expiracao, categoria_id)
       VALUES (now(), '${nome}', '52998224725', 'conc-${nome.replace(/\W/g, '')}-${sufixo}@teste.com', '16999990000', 'x', '{anunciante}',
               true, 'essencial-1m', now(), now() + interval '20 days', ${categoria}) RETURNING id`,
    ),
  );
  PG(
    `INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, duracao_segundos, status)
     VALUES (${id}, 'original.mp4', 'https://exemplo.test/${id}.mp4', 15, 'aprovado') RETURNING id`,
  );
  PG(`INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES (${id}, ${PONTO}) RETURNING anunciante_id`);
  return id;
}
const CONTA_B = conta('Padaria Concorrente', CAT.b);
const CONTA_C = conta('Academia Vizinha', CAT.c);

const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const ctxAdmin = await navegador.newContext({ viewport: { width: 1360, height: 900 } });
const admin = await ctxAdmin.newPage();
admin.on('pageerror', (e) => erros.push(`[${fase}] pageerror: ${e.message}`));
admin.on('console', (m) => {
  if (m.type() !== 'error' || /net::|ERR_FAILED/.test(m.text())) return;
  if (fase === 'início' && /status of 401/.test(m.text())) return;
  erros.push(`[${fase}] console: ${m.text()}`);
});

await admin.goto(`${B}/admin/index.html`);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('#conteudo .visao-geral-colunas');
await admin.evaluate(() => {
  window.__semReload = true;
});
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

// TV instalada pelo contrato do Player.
await api('/admin/player/pin-saida', 'PUT', { pin: '482715' });
const g = await api(`/admin/dispositivos/${TELA}/codigo-instalacao`, 'POST');
const prov = await (
  await fetch(`${B}/player/provisionar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Player-Version': '1.2.0+12' },
    body: JSON.stringify({ codigoTela: g.json.codigoTela, codigoInstalacao: g.json.codigo }),
  })
).json();
const naTv = async () => {
  const r = await fetch(`${B}/playlist/${prov.dispositivoId}`, {
    headers: { 'X-Player-Version': '1.2.0+12', 'X-Aparelho-Key': prov.chaveAparelho },
  });
  const corpo = await r.json();
  return new Set((corpo.itens || []).map((i) => Number(i.anuncianteId)).filter(Boolean));
};

etapa('== antes: sem conflito, B e C entram ==');
let ids = await naTv();
check('B (categoria sem par) entra na TV do ponto A', ids.has(CONTA_B), [...ids]);
check('C entra na TV do ponto A', ids.has(CONTA_C), [...ids]);

// Abre o modal da categoria pela LISTA (clique na linha, como o admin faz).
async function abrirModal(id) {
  await admin.locator(`#conteudo tr[data-editar-cat="${id}"]`).click();
  await admin.waitForSelector('#formCategoria');
}
async function salvarModal() {
  await admin.click('button[type=submit][form=formCategoria]');
  await admin.waitForSelector('#formCategoria', { state: 'detached' });
  await admin.waitForSelector('#conteudo .tabela-categorias');
}
const chips = () =>
  admin.$$eval('[data-concorrentes] .etiqueta', (els) => els.map((e) => e.firstChild.textContent.trim()));

etapa('== 1: admin configura A ↔ B em Categorias ==');
await admin.evaluate(() => {
  location.hash = '#contas/categorias';
});
await admin.waitForSelector(`#conteudo tr[data-editar-cat="${CAT.a}"]`);
await abrirModal(CAT.a);
const texto = await admin.textContent('.cat-concorrentes');
check(
  'texto explicativo exato',
  texto.includes(
    'Categorias configuradas como concorrentes diretos não terão anúncios exibidos em pontos pertencentes à categoria correspondente.',
  ),
);
check('campos separados: Nome, Grupo, Aliases, Estado, Cadastro, Concorrentes', (await admin.$$('#catNome, #catGrupo, #catAliases, [name=estado], [name=ativo], #catConcBusca')).length >= 6);
check('nenhum concorrente de início', (await chips()).length === 0);
await admin.fill('#catConcBusca', NOME.b);
await admin.click(`#catConcResultados li[data-id="${CAT.b}"]`);
check('B vira etiqueta no modal', (await chips()).includes(NOME.b), await chips());
check('a busca limpa depois de escolher', (await admin.inputValue('#catConcBusca')) === '');
await shot(admin, 'modal-com-par');
await salvarModal();
check(
  'gravado no banco como UM par normalizado',
  PG(`SELECT count(*) FROM categorias_concorrentes WHERE categoria_a = ${Math.min(CAT.a, CAT.b)} AND categoria_b = ${Math.max(CAT.a, CAT.b)}`) === '1',
);

etapa('== reflexo no outro lado, sem F5 ==');
await abrirModal(CAT.b);
check('modal de B mostra A', (await chips()).includes(NOME.a), await chips());
await admin.click('[data-fechar]');
await admin.waitForSelector('#formCategoria', { state: 'detached' });

etapa('== 2–5: ponto A, anunciante B fora, C dentro ==');
ids = await naTv();
check('anúncio de B NÃO entra na TV do ponto A', !ids.has(CONTA_B), [...ids]);
check('anúncio de C continua elegível', ids.has(CONTA_C), [...ids]);

etapa('== 6: admin tira o conflito (pelo lado de B) ==');
await abrirModal(CAT.b);
await admin.click(`[data-tirar-conc="${CAT.a}"]`);
check('etiqueta some na hora', (await chips()).length === 0);
await salvarModal();
check('par apagado', PG(`SELECT count(*) FROM categorias_concorrentes WHERE ${CAT.a} IN (categoria_a, categoria_b)`) === '0');
await abrirModal(CAT.a);
check('A também não mostra mais B', (await chips()).length === 0, await chips());
await admin.click('[data-fechar]');
ids = await naTv();
check('programação seguinte volta a ter B', ids.has(CONTA_B), [...ids]);
check('C continua', ids.has(CONTA_C), [...ids]);

etapa('== 7: sem F5 ==');
check('a página do admin nunca recarregou', await admin.evaluate(() => window.__semReload === true));
check('sem erro de console/página', erros.length === 0, erros.join('\n'));
await shot(admin, 'lista-final');

await navegador.close();
console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO OK');
process.exit(falhas.length ? 1 : 0);
