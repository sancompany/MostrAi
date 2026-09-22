// Card "Faça parte da rede" no fim do painel (21/09/2026, revisão de
// design): movimento médio mensal virou obrigatório, e o segmento da
// candidatura passou a ser resolvido no servidor a partir do ramo que a
// conta já informou — seja categoria_id (catálogo fixo) ou categoria_livre
// (texto). Assume banco zerado e servidor na 3999.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const falhas = [];
const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
async function pagina(url) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`${url}: ${e.message}`));
  p.on('console', (m) => {
    // 400 entra na lista de esperados aqui: um dos casos deste script é
    // mandar a candidatura de propósito sem fluxo_estimado_mensal pra
    // provar que o backend recusa — a resposta é 400, não um bug.
    if (m.type() === 'error' && !/status of (400|401|404|409)/.test(m.text())) erros.push(`${url} console: ${m.text()}`);
  });
  await p.goto(B + url, { waitUntil: 'networkidle' });
  return p;
}

async function novaConta(nome, email, categoriaId) {
  const cadastro = await pagina('/');
  const conta = await cadastro.evaluate(
    async ({ nome, email, categoriaId }) =>
      await (
        await fetch('/anunciantes/cadastro', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nome_empresa: nome,
            cpf_cnpj: '390.533.447-05',
            endereco: 'Rua Lu, 5',
            cidade: 'Matão',
            uf: 'SP',
            cep: '15990-000',
            contato_email: email,
            contato_telefone: '16 99463-5946',
            senha: 'Senha12@',
            aceitou_termos: true,
          }),
        })
      ).json(),
    { nome, email, categoriaId },
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
  // Ativa o modo anunciante com o ramo — categoria_id (catálogo fixo) ou
  // categoria_livre (texto), dependendo do teste.
  await cadastro.evaluate(
    async (categoriaId) =>
      await fetch('/conta/modos/anunciante', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          categoriaId
            ? { endereco: 'Rua Lu, 5', cidade: 'Matão', uf: 'SP', cep: '15990-000', categoria_id: categoriaId }
            : { endereco: 'Rua Lu, 5', cidade: 'Matão', uf: 'SP', cep: '15990-000', categoria_livre: 'Loja de bicicletas' },
        ),
      }).then((r) => r.json()),
    categoriaId,
  );
  return { cadastro, conta };
}

console.log('== conta A: ramo do catálogo fixo (categoria_id) ==');
const { cadastro: pA, conta: contaA } = await novaConta('Padaria Lu', 'lu@x.com', 1); // Barbearia
const painelA = await pagina('/anunciante/painel.html');
await painelA.waitForTimeout(500);
await painelA.click('#btnAbrirCardPonto');
check('formulário abre', await painelA.isVisible('#formCardPonto'));
check('campo de fluxo é obrigatório', await painelA.$eval('#cp_fluxo', (e) => e.required));
check('rótulo não diz mais "(opcional)"', !(await painelA.textContent('label[for="cp_fluxo"]')).includes('opcional'));
await painelA.screenshot({ path: new URL('./saida/v24-formulario-aberto.png', import.meta.url).pathname, fullPage: true });

console.log('== tentando enviar sem preencher o movimento (deve bloquear no navegador) ==');
await painelA.click('#formCardPonto button[type=submit]');
await painelA.waitForTimeout(300);
check(
  'candidatura NÃO foi criada sem o campo (validação nativa segurou o submit)',
  !(await painelA.$eval('#cardPontoMsg', (e) => e.textContent.includes('Pedido enviado'))),
);

console.log('== preenchendo e enviando de verdade ==');
await painelA.fill('#cp_fluxo', '2500');
await painelA.click('#formCardPonto button[type=submit]');
await painelA.waitForTimeout(600);
check('mensagem de sucesso', (await painelA.textContent('#cardPontoMsg')).includes('Pedido enviado'));

const segmentoA = PG(`SELECT segmento FROM candidaturas WHERE conta_id=${contaA.id} AND tipo='ponto'`);
check('segmento resolvido a partir de categoria_id (Barbearia)', segmentoA === 'Barbearia', segmentoA);
const fluxoA = PG(`SELECT fluxo_estimado_mensal FROM candidaturas WHERE conta_id=${contaA.id} AND tipo='ponto'`);
check('fluxo_estimado_mensal gravado', fluxoA === '2500', fluxoA);
const horarioA = PG(`SELECT horario_semanal->'seg'->>'abre' FROM candidaturas WHERE conta_id=${contaA.id} AND tipo='ponto'`);
check('horário de funcionamento gravado (padrão do widget)', horarioA === '09:00', horarioA);

console.log('== conta B: ramo em texto livre (categoria_livre) ==');
const { cadastro: pB, conta: contaB } = await novaConta('Mercado Z', 'z@x.com', null);
const painelB = await pagina('/anunciante/painel.html');
await painelB.waitForTimeout(500);
await painelB.click('#btnAbrirCardPonto');
await painelB.fill('#cp_fluxo', '900');
await painelB.click('#formCardPonto button[type=submit]');
await painelB.waitForTimeout(600);
const segmentoB = PG(`SELECT segmento FROM candidaturas WHERE conta_id=${contaB.id} AND tipo='ponto'`);
check('segmento resolvido a partir de categoria_livre', segmentoB === 'Loja de bicicletas', segmentoB);

console.log('== defesa em profundidade: rota direta sem fluxo_estimado_mensal (conta C, sem pedido aberto) ==');
await novaConta('Farmácia C', 'c@x.com', null);
const painelC = await pagina('/anunciante/painel.html');
const semFluxo = await painelC.evaluate(
  async () =>
    await (
      await fetch('/conta/modos/ponto/pedir', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome_comercio: 'Teste', endereco: 'Rua X, 1' }),
      })
    ).json(),
);
check('backend recusa sem fluxo_estimado_mensal mesmo direto na API', /movimento médio mensal/.test(semFluxo.erro || ''), JSON.stringify(semFluxo));

await painelA.screenshot({ path: new URL('./saida/v24-candidatura-ponto.png', import.meta.url).pathname, fullPage: true });

console.log('\nerros de página:', erros.length ? erros : 'nenhum');
console.log('falhas:', falhas.length);
await b.close();
process.exit(falhas.length || erros.length ? 1 : 0);
