// Site público — indicação no cadastro + regra da senha na redefinição
// (estação de 29/09/2026):
//   · cadastro sem ?ref: a linha "Indicado por" não existe (nem placeholder);
//   · cadastro com ?ref válido: "Indicado por: <negócio>" no topo do card, e a
//     conta criada fica associada ao MESMO indicador (confere no banco);
//   · ?ref inválido: nada aparece, nenhum erro interno, cadastro normal e sem
//     indicação gravada;
//   · envio recusado pelo servidor (CPF inválido): a linha continua, com o
//     mesmo nome;
//   · nome comprido quebra linha sem vazar em 1440/1024/768/430/390/360;
//   · redefinir-senha: a regra sai depois dos DOIS campos, antes do botão,
//     menor e secundária; senha fraca continua recusada, a forte continua
//     valendo (entra com ela); cadastro mantém a dica de antes, no lugar dela.
// Banco zerado, servidor na 3999 e o .env carregado (DATABASE_URL):
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/36-cadastro-indicacao-senha.mjs
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { emailsPara } from './emails.mjs';
import { acompanharRede } from './espera.mjs';

const B = 'http://localhost:3999';
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const falhas = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const LARGURAS = [1440, 1024, 768, 430, 390, 360];
const sufixo = () => Math.random().toString(36).slice(2, 8);

function cpfValido() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (new Set(base).size === 1) base[0] = (base[0] + 1) % 10;
  const digito = (nums) => {
    const soma = nums.reduce((s, n, i) => s + n * (nums.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = digito(base);
  return [...base, d1, digito([...base, d1])].join('');
}

// Conta criada pela rota real (o mesmo POST do formulário).
async function criarConta(nome, extra = {}) {
  const email = `e2e36-${sufixo()}@example.com`;
  const r = await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: nome,
      cpf_cnpj: cpfValido(),
      contato_email: email,
      contato_telefone: '16999990000',
      senha: 'Senha@forte1',
      aceitou_termos: true,
      categoria_livre: 'teste',
      cep: '15997-078',
      logradouro: 'Avenida 28 de Agosto',
      numero: '10',
      bairro: 'Alto',
      cidade: 'Matão',
      uf: 'SP',
      ...extra,
    }),
  });
  const corpo = await r.json();
  if (r.status !== 201) throw new Error(`cadastro de apoio falhou: ${r.status} ${JSON.stringify(corpo)}`);
  return { id: corpo.id, email };
}

// Ponto indicador: conta + cupom PT- (o mesmo formato de gerarCupomPonto).
async function indicador(nome) {
  const conta = await criarConta(nome);
  // Letras aleatórias: reset-db.sh não limpa cupons_ponto, e o código é único.
  const letras = Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const codigo = `PT-${letras}${100 + Math.floor(Math.random() * 900)}`;
  PG(`INSERT INTO cupons_ponto (conta_id, codigo) VALUES (${conta.id}, '${codigo}')`);
  return { ...conta, nome, codigo };
}

const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));

async function pagina(largura, errosConsole) {
  const ctx = await navegador.newContext({ viewport: { width: largura, height: 900 } });
  // ViaCEP respondida aqui (sem rede externa no roteiro).
  await ctx.route('https://viacep.com.br/**', (route) =>
    route.fulfill({
      json: { cep: '15997-078', logradouro: 'Avenida 28 de Agosto', bairro: 'Alto', localidade: 'Matão', uf: 'SP' },
    }),
  );
  const p = await ctx.newPage();
  p.on('console', (m) => m.type() === 'error' && errosConsole.push(m.text()));
  p.on('pageerror', (e) => errosConsole.push(String(e)));
  return { ctx, p };
}

async function preencherCadastro(p, { cpf = cpfValido(), email = `e2e36-${sufixo()}@example.com` } = {}) {
  await p.fill('#nome_empresa', `Anunciante ${sufixo()}`);
  await p.fill('#cpf_cnpj', cpf);
  // Ramo pela busca, como a pessoa faz (formulario.js#ligarCategorias).
  await p.fill('#categoria_id_busca', 'Padaria');
  await p.locator('#formCadastro .categoria-resultados li[role=option]').first().click();
  await p.fill('#cep', '15997078');
  await p.fill('#logradouro', 'Avenida 28 de Agosto');
  await p.fill('#numero', '10');
  await p.fill('#bairro', 'Alto');
  await p.fill('#cidade', 'Matão');
  await p.fill('#uf', 'SP');
  await p.fill('#contato_email', email);
  await p.fill('#contato_telefone', '16999990000');
  await p.fill('#senha', 'Senha@forte1');
  await p.fill('#senha_confirma', 'Senha@forte1');
  await p.check('#aceitou_termos');
  return email;
}

const linhaIndicacao = (p) =>
  p.evaluate(() => {
    const el = document.getElementById('indicadoPor');
    return el ? { visivel: !el.hidden && el.offsetParent !== null, texto: el.textContent.trim() } : null;
  });
const semRolagemLateral = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// ---------------------------------------------------------------------------
console.log('\nCadastro — indicação');
const padaria = await indicador('Padaria Shot');
const comprido = await indicador(
  'Padaria e Confeitaria Shot da Esquina do Centro Histórico de Matão — Unidade Avenida 28 de Agosto',
);
const erros = [];

{
  // Caso A — sem indicação
  const { ctx, p } = await pagina(1440, erros);
  await p.goto(`${B}/anunciante/cadastro.html`);
  await p.waitForLoadState('load');
  await p.waitForTimeout(300);
  const l = await linhaIndicacao(p);
  check('A: sem ?ref a linha não aparece', l && !l.visivel && l.texto === '', JSON.stringify(l));
  check('A: nenhum "Indicado por" na página', !(await p.textContent('body')).includes('Indicado por'));
  await ctx.close();
}

{
  // Caso B — indicação válida: mostra e associa o mesmo indicador
  const { ctx, p } = await pagina(1440, erros);
  await p.goto(`${B}/anunciante/cadastro.html?ref=${padaria.codigo}`);
  await p.waitForSelector('#indicadoPor:not([hidden])');
  const l = await linhaIndicacao(p);
  check('B: "Indicado por: Padaria Shot"', l.visivel && l.texto === 'Indicado por: Padaria Shot', l.texto);
  const texto = await p.textContent('body');
  check('B: nada interno no texto da página (código, id)', !texto.includes(padaria.codigo) && !texto.includes(`#${padaria.id}`));
  const antesSeuNegocio = await p.evaluate(() => {
    const el = document.getElementById('indicadoPor');
    return el.parentElement.id === 'formCadastro' && el.nextElementSibling?.textContent.trim() === 'Seu negócio';
  });
  check('B: no topo do card, antes de "Seu negócio"', antesSeuNegocio);
  await p.screenshot({ path: `${SAIDA}36-cadastro-indicado-1440.png`, fullPage: false });
  const email = await preencherCadastro(p);
  await Promise.all([p.waitForURL(/painel|confirmar-plano/, { timeout: 15000 }), p.click('#formCadastro [type=submit]')]);
  const gravado = PG(
    `SELECT a.indicado_por_cupom || '|' || cp.conta_id FROM anunciantes a JOIN cupons_ponto cp ON cp.codigo = a.indicado_por_cupom WHERE a.contato_email = '${email}'`,
  );
  check('B: conta criada associada ao MESMO indicador', gravado === `${padaria.codigo}|${padaria.id}`, gravado);
  await ctx.close();
}

{
  // Caso C — referral inválido
  const { ctx, p } = await pagina(1440, erros);
  const respostas = [];
  p.on('response', (r) => r.url().includes('/indicacoes/') && respostas.push(r.status()));
  await p.goto(`${B}/anunciante/cadastro.html?ref=PT-INVALIDO999`);
  await p.waitForLoadState('load');
  await p.waitForTimeout(400);
  const l = await linhaIndicacao(p);
  check('C: inválido não mostra comércio', l && !l.visivel && l.texto === '', JSON.stringify(l));
  check('C: consulta respondeu 404 (sem erro interno)', respostas.includes(404), respostas.join(','));
  const email = await preencherCadastro(p);
  await Promise.all([p.waitForURL(/painel|confirmar-plano/, { timeout: 15000 }), p.click('#formCadastro [type=submit]')]);
  const cupom = PG(`SELECT coalesce(indicado_por_cupom, 'NULO') FROM anunciantes WHERE contato_email = '${email}'`);
  check('C: cadastro funciona e sem indicação gravada', cupom === 'NULO', cupom);
  await ctx.close();
}

{
  // Caso D — o servidor recusa o envio: a indicação continua a mesma
  const { ctx, p } = await pagina(1440, erros);
  await p.goto(`${B}/anunciante/cadastro.html?ref=${padaria.codigo}`);
  await p.waitForSelector('#indicadoPor:not([hidden])');
  // Validação do navegador (campo vazio) não envia nada.
  await p.click('#formCadastro [type=submit]');
  await p.waitForTimeout(200);
  let l = await linhaIndicacao(p);
  check('D: validação do navegador mantém a linha', l.visivel && l.texto === 'Indicado por: Padaria Shot', l.texto);
  // CPF inválido: o servidor recusa com campo.
  await preencherCadastro(p, { cpf: '11111111111' });
  const [resp] = await Promise.all([
    p.waitForResponse((r) => r.url().endsWith('/anunciantes/cadastro')),
    p.click('#formCadastro [type=submit]'),
  ]);
  await p.waitForTimeout(200);
  check('D: servidor recusou o envio', resp.status() === 400, String(resp.status()));
  l = await linhaIndicacao(p);
  check('D: depois da recusa, mesma indicação na tela', l.visivel && l.texto === 'Indicado por: Padaria Shot', l.texto);
  check('D: mensagem de erro não fala de cupom', !/cupom/i.test(await p.textContent('#msg')), await p.textContent('#msg'));
  await ctx.close();
}

{
  // Caso E — a consulta do nome dá 404 (instância antiga no meio de um deploy,
  // sem a rota) com uma ref VÁLIDA: não mostra a linha, mas a indicação vai no
  // envio e a conta fica com o indicador (revisão Codex do #102).
  const { ctx, p } = await pagina(1440, erros);
  await p.route('**/indicacoes/**', (route) => route.fulfill({ status: 404, body: 'Not Found' }));
  await p.goto(`${B}/anunciante/cadastro.html?ref=${padaria.codigo}`);
  await p.waitForLoadState('load');
  await p.waitForTimeout(300);
  const l = await linhaIndicacao(p);
  check('E: consulta 404 → sem a linha', l && !l.visivel, JSON.stringify(l));
  const email = await preencherCadastro(p);
  await Promise.all([p.waitForURL(/painel|confirmar-plano/, { timeout: 15000 }), p.click('#formCadastro [type=submit]')]);
  const gravado = PG(`SELECT coalesce(indicado_por_cupom, 'NULO') FROM anunciantes WHERE contato_email = '${email}'`);
  check('E: a indicação válida não se perde (vai no envio)', gravado === padaria.codigo, gravado);
  await ctx.close();
}

// Responsivo — nome comprido
for (const largura of LARGURAS) {
  const { ctx, p } = await pagina(largura, erros);
  await p.goto(`${B}/anunciante/cadastro.html?ref=${comprido.codigo}`);
  await p.waitForSelector('#indicadoPor:not([hidden])');
  const medida = await p.evaluate(() => {
    const el = document.getElementById('indicadoPor').getBoundingClientRect();
    const card = document.getElementById('formCadastro').getBoundingClientRect();
    return { dentro: el.left >= card.left - 0.5 && el.right <= card.right + 0.5, altura: el.height };
  });
  check(`${largura}px: nome comprido dentro do card`, medida.dentro, JSON.stringify(medida));
  check(`${largura}px: sem rolagem lateral`, await semRolagemLateral(p));
  if (largura <= 430) check(`${largura}px: quebra em mais de uma linha`, medida.altura > 30, String(medida.altura));
  await p.screenshot({ path: `${SAIDA}36-cadastro-nome-comprido-${largura}.png`, fullPage: false });
  await ctx.close();
}

{
  // Cadastro mantém a dica de senha de antes, no lugar de antes.
  const { ctx, p } = await pagina(1440, erros);
  await p.goto(`${B}/anunciante/cadastro.html`);
  await p.waitForSelector('[data-dica-senha]');
  const dica = await p.evaluate(() => {
    const d = document.querySelectorAll('[data-dica-senha]');
    return { n: d.length, texto: d[0].textContent, depoisDaLinha: d[0].previousElementSibling?.classList.contains('field-row') };
  });
  check('cadastro: dica de senha inalterada (texto e lugar)', dica.n === 1 && dica.texto.startsWith('Mínimo 8 caracteres') && dica.depoisDaLinha, JSON.stringify(dica));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\nRedefinir senha');
const dono = await criarConta(`Senha ${sufixo()}`);
const pedido = Date.now();
await fetch(`${B}/anunciantes/esqueci-senha`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: dono.email }),
});
let link = null;
for (let i = 0; i < 40 && !link; i++) {
  const m = emailsPara(dono.email).filter((x) => Date.parse(x.em) >= pedido - 1000).at(-1);
  link = m?.text.match(/https?:\/\/\S*redefinir-senha\.html\?token=[^\s"<]+/)?.[0];
  if (!link) await new Promise((r) => setTimeout(r, 150));
}
check('e-mail de redefinição chegou com o link', !!link);
const caminho = link ? new URL(link).pathname + new URL(link).search : '/redefinir-senha.html';

for (const largura of LARGURAS) {
  const { ctx, p } = await pagina(largura, erros);
  await p.goto(`${B}${caminho}`);
  await p.waitForSelector('#blocoContaSenha:not([hidden])');
  const m = await p.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const dicas = document.querySelectorAll('[data-dica-senha]');
    const dica = dicas[0];
    const conf = document.getElementById('senha_confirma');
    const botao = document.querySelector('#formSenha [type=submit]');
    const senha = document.getElementById('senha');
    const cs = getComputedStyle(dica);
    const label = getComputedStyle(document.querySelector('label[for=senha]'));
    return {
      n: dicas.length,
      texto: dica.textContent.trim(),
      depoisDosDois: r(dica).top >= r(conf).bottom && r(dica).top >= r(senha).bottom,
      antesDoBotao: r(dica).bottom <= r(botao).top,
      folgaCampo: Math.round(r(dica).top - r(conf).bottom),
      folgaBotao: Math.round(r(botao).top - r(dica).bottom),
      menor: parseFloat(cs.fontSize) < parseFloat(getComputedStyle(conf).fontSize),
      corSecundaria: cs.color === label.color,
      naoEhErro: !dica.classList.contains('err'),
    };
  });
  check(`${largura}px: uma dica, depois dos dois campos e antes do botão`, m.n === 1 && m.depoisDosDois && m.antesDoBotao, JSON.stringify(m));
  check(`${largura}px: sem colar no campo nem no botão (≥ 8px)`, m.folgaCampo >= 8 && m.folgaBotao >= 8, JSON.stringify(m));
  check(`${largura}px: menor, cor secundária, não é erro`, m.menor && m.corSecundaria && m.naoEhErro, JSON.stringify(m));
  check(`${largura}px: texto novo`, m.texto === 'Sua senha deve ter 8+ caracteres, maiúscula, minúscula, número e símbolo.', m.texto);
  check(`${largura}px: sem rolagem lateral`, await semRolagemLateral(p));
  await p.screenshot({ path: `${SAIDA}36-redefinir-senha-${largura}.png`, fullPage: true });
  await ctx.close();
}

{
  const { ctx, p } = await pagina(390, erros);
  await p.goto(`${B}${caminho}`);
  await p.waitForSelector('#blocoContaSenha:not([hidden])');
  // Senha fraca: a validação de sempre recusa (nada vai pro servidor).
  let enviou = false;
  p.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/redefinir-senha') && (enviou = true));
  await p.fill('#senha', 'senhafraca');
  await p.fill('#senha_confirma', 'senhafraca');
  await p.click('#formSenha [type=submit]');
  await p.waitForTimeout(300);
  const valida = await p.evaluate(() => document.getElementById('senha').checkValidity());
  check('senha fraca continua recusada (sem envio)', !valida && !enviou);
  // Servidor continua exigindo a regra (sem o navegador no meio).
  const token = new URL(`${B}${caminho}`).searchParams.get('token');
  const direto = await fetch(`${B}/redefinir-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, senha: 'semsimbolo1A' }),
  });
  check('servidor recusa senha sem símbolo', direto.status === 400, String(direto.status));
  // Senha forte: salva, e entra com ela.
  await p.fill('#senha', 'Nova@Senha2');
  await p.fill('#senha_confirma', 'Nova@Senha2');
  await p.click('#formSenha [type=submit]');
  await p.waitForSelector('#msg.ok', { timeout: 5000 });
  const login = await fetch(`${B}/anunciantes/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: dono.email, senha: 'Nova@Senha2' }),
  });
  check('senha forte continua valendo (login com ela)', login.status === 200, String(login.status));
  await ctx.close();
}

const errosReais = erros.filter((e) => !/404|Failed to load resource/.test(e));
check('sem erro de console', errosReais.length === 0, errosReais.join(' | '));

await navegador.close();
console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO OK');
process.exit(falhas.length ? 1 : 0);
