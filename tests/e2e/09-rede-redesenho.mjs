// Redesenho da tela Rede do admin (22/09/2026): grade de cards com status
// visual derivado, ficha somente-leitura + Telas + Instalação, ocupação
// agregada na Visão geral, placeholder de foto, candidatura com foto/
// observação. Assume banco zerado e servidor na 3999 (NODE_ENV=test).
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const B = 'http://localhost:3999';
// -tAc some psql ainda imprime a linha de status ("INSERT 0 1") depois do
// valor retornado por RETURNING — primeira linha é sempre o valor de
// verdade nas queries deste script (uma linha, uma coluna).
const PG = (sql) =>
  execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .split('\n')[0]
    .trim();
const SAIDA = new URL('./saida/', import.meta.url).pathname;

const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const ctxAdmin = await b.newContext({ viewport: { width: 1400, height: 960 } });
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
    if (m.type() === 'error' && !/status of (400|401|404|409|502)/.test(m.text())) erros.push(`${url} console: ${m.text()}`);
  });
  p.on('dialog', async (d) => (d.type() === 'prompt' ? await d.accept(d.defaultValue()) : await d.accept()));
  await p.goto(B + url, { waitUntil: 'networkidle' });
  return p;
}

// ---------- dados de teste (direto no banco, determinístico) ----------
const idA = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
   VALUES ('Padaria Aguardando', 'Rua Curta, 1', 'Matão', 'SP', '15990000', 'padaria', 'Ana', '16999990001', 'a_instalar')
   RETURNING id`,
);
const idB = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status, fluxo_estimado_mensal)
   VALUES ('Mercadinho TV Instalada', 'Rua das Flores, 200', 'Matão', 'SP', '15990000', 'mercado', 'Beto', '16999990002', 'a_instalar', 800)
   RETURNING id`,
);
PG(`INSERT INTO dispositivos (ponto_id, apelido, aparelho_id, instalado_em) VALUES (${idB}, 'Tela 1', gen_random_uuid(), current_date)`);

const nomeGrande = 'Academia Corpo em Movimento Studio de Pilates e Musculação Unidade Centro';
const enderecoGrande = 'Avenida Presidente Getúlio Vargas Filho, número 1234, Sala 56, Bloco B, Centro';
const idC = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status, fluxo_estimado_mensal, acabamento_completo, foto_instalacao_url, observacoes, horario_semanal)
   VALUES ('${nomeGrande}', '${enderecoGrande}', 'Matão', 'SP', '15990000', 'academia', 'Carla Consultora Responsável', '16999990003', 'em_operacao', 4200, true,
     'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'tem estacionamento próprio nos fundos, entrada pela lateral',
     '{"seg":{"abre":"06:00","fecha":"22:00"},"ter":{"abre":"06:00","fecha":"22:00"},"qua":{"abre":"06:00","fecha":"22:00"},"qui":{"abre":"06:00","fecha":"22:00"},"sex":{"abre":"06:00","fecha":"22:00"},"sab":{"abre":"08:00","fecha":"12:00"},"dom":null}')
   RETURNING id`,
);
PG(`INSERT INTO dispositivos (ponto_id, apelido, aparelho_id, instalado_em) VALUES (${idC}, 'Tela 1', gen_random_uuid(), current_date)`);
PG(`INSERT INTO dispositivos (ponto_id, apelido, aparelho_id, instalado_em, status) VALUES (${idC}, 'Tela 2', gen_random_uuid(), current_date, 'ativo')`);
PG(`INSERT INTO dispositivos (ponto_id, apelido) VALUES (${idC}, 'Tela 3 (sem chave ainda)')`);

// Ponto D: em operação, ocupação alta o bastante pra ficar "travado" (G.7,
// LIMITE_OCUPACAO_BLOQUEIA=0.8), mas com folga suficiente pra liberar de
// novo — mesmo cenário "sticky" que tests/pontos-ocupacao.test.js já cobre
// por unidade; aqui é só a VISUAL do painel de Ocupação da rede.
const idD = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
   VALUES ('Farmácia Ocupação', 'Rua Central, 50', 'Matão', 'SP', '15990000', 'farmacia', 'Duda', '16999990004', 'em_operacao')
   RETURNING id`,
);
PG(`DELETE FROM planos WHERE id = 'plano-teste-e2e-rede'`);
const planoIdD = PG(
  `INSERT INTO planos (id, tier, nome, valor_mensal, compromisso_meses, frequencia_hora, cobertura, segundos_por_hora, pontos_incluidos, duracao_maxima_segundos, limite_criativos)
   VALUES ('plano-teste-e2e-rede', 'essencial', 'Teste E2E Rede', 100, 1, 0, 'todos_pontos', 2000, 1, 30, 3) RETURNING id`,
);
const anuncianteIdD = PG(
  `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em, plano_id, data_expiracao)
   VALUES ('Anunciante Teste Ocupação', '11144477735', 'ocup-e2e@example.com', '16999990000', 'x', now(), 'plano-teste-e2e-rede', now() + interval '30 days')
   RETURNING id`,
);
PG(`INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES (${anuncianteIdD}, ${idD})`);
PG(`UPDATE pontos SET escolha_bloqueada_em = now() WHERE id = ${idD}`);

console.log('== login admin ==');
const admin = await pagina('/admin/index.html', ctxAdmin);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForTimeout(500);
check('logou no admin', await admin.isVisible('.admin-shell'));

console.log('== grade da Rede — desktop ==');
await admin.evaluate(() => {
  location.hash = 'rede/pontos';
});
await admin.waitForTimeout(500);
check('sem "+ Novo ponto" na tela', !(await admin.locator('text=Novo ponto').count()));
check('sem "Foto de exemplo" na tela', !(await admin.locator('text=Foto de exemplo').count()));
check('4 cards visíveis (A/B/C/D)', (await admin.locator('.ponto-card').count()) >= 4);
check('badge "Aguardando instalação" existe', (await admin.locator('.badge:has-text("Aguardando instalação")').count()) >= 1);
check('badge "TV instalada" existe', (await admin.locator('.badge:has-text("TV instalada")').count()) >= 1);
check('badge "Em operação" existe', (await admin.locator('.badge:has-text("Em operação")').count()) >= 2);
check('placeholder de foto aparece pros pontos sem foto', (await admin.locator('.ponto-foto-placeholder').count()) >= 3);
check('foto real aparece pro ponto C', await admin.locator('.ponto-card-media img').count() >= 1);
await admin.screenshot({ path: `${SAIDA}v25-rede-grade-desktop.png`, fullPage: true });

console.log('== busca e filtros ==');
await admin.fill('.busca', 'Mercadinho');
await admin.waitForTimeout(400);
check('busca filtra pro card certo', (await admin.locator('.ponto-card:visible').count()) === 1);
await admin.fill('.busca', 'ponto-que-nao-existe-xyz');
await admin.waitForTimeout(400);
check('busca sem resultado mostra mensagem certa', (await admin.textContent('[data-vazio]')) === 'Nenhum ponto encontrado para esta busca.');
await admin.fill('.busca', '');
await admin.click('.chip:has-text("Aguardando instalação")');
await admin.waitForTimeout(400);
check('filtro "Aguardando instalação" mostra só o ponto A', (await admin.locator('.ponto-card:visible').count()) === 1);
await admin.click('.chip:has-text("TV instalada")');
await admin.waitForTimeout(400);
check('filtro "TV instalada" mostra só o ponto B', (await admin.locator('.ponto-card:visible').count()) === 1);
await admin.click('.chip:has-text("Em operação")');
await admin.waitForTimeout(400);
check('filtro "Em operação" mostra C e D', (await admin.locator('.ponto-card:visible').count()) === 2);
await admin.click('.chip:has-text("Todos")');
await admin.waitForTimeout(400);

console.log('== grade da Rede — mobile ==');
await admin.setViewportSize({ width: 390, height: 844 });
await admin.waitForTimeout(400);
await admin.screenshot({ path: `${SAIDA}v25-rede-grade-mobile.png`, fullPage: true });
await admin.setViewportSize({ width: 1400, height: 960 });

console.log('== detalhe do ponto — com foto, nome/endereço grandes ==');
await admin.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, idC);
await admin.waitForTimeout(400);
check('foto grande no cabeçalho', await admin.locator('.ponto-ficha-foto img').isVisible());
check('nome grande aparece por inteiro', (await admin.textContent('.ponto-ficha-titulo h3')).includes('Academia Corpo em Movimento'));
check('segmento aparece', (await admin.textContent('.ponto-ficha-titulo')).includes('academia'));
check('responsável somente-leitura (sem input)', (await admin.locator('#pontoInformacoes input, #pontoInformacoes select').count()) === 0);
check('horário de funcionamento mostrado como texto', (await admin.textContent('#pontoInformacoes')).includes('06:00'));
check('observações aparecem', (await admin.textContent('#pontoInformacoes')).includes('estacionamento'));
check('molde ACM: Instalado', (await admin.textContent('#pontoInformacoes')).includes('Instalado'));
check('3 telas na tabela (uma sem chave)', (await admin.locator('#pontoTelas tbody tr').count()) === 3);
await admin.screenshot({ path: `${SAIDA}v25-ponto-detalhe-desktop.png`, fullPage: true });
await admin.setViewportSize({ width: 390, height: 844 });
await admin.waitForTimeout(400);
await admin.screenshot({ path: `${SAIDA}v25-ponto-detalhe-mobile.png`, fullPage: true });
await admin.setViewportSize({ width: 1400, height: 960 });

console.log('== ponto sem foto — placeholder no detalhe ==');
await admin.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, idA);
await admin.waitForTimeout(300);
check('placeholder no cabeçalho do ponto sem foto', await admin.locator('.ponto-ficha-foto .ponto-foto-placeholder').isVisible());
check('badge "Aguardando instalação" no detalhe', (await admin.textContent('.ponto-ficha-titulo')).includes('Aguardando instalação'));
check('botão "Colocar em operação" existe (ponto a_instalar)', await admin.isVisible('#btnColocarOperacao'));
check('nenhuma tela — mensagem certa', (await admin.textContent('#pontoTelas')).includes('Nenhuma tela ainda'));

console.log('== fluxo de instalação: molde + colocar em operação ==');
await admin.check('#pontoAcabamento');
await admin.waitForTimeout(300);
check('molde ACM salvo', PG(`SELECT acabamento_completo FROM pontos WHERE id=${idA}`) === 't');
await admin.click('#btnColocarOperacao');
await admin.waitForTimeout(400);
check('status virou em_operacao no banco', PG(`SELECT status FROM pontos WHERE id=${idA}`) === 'em_operacao');
check('botão virou "Voltar pra aguardando instalação"', await admin.isVisible('#btnVoltarInstalacao'));

console.log('== ocupação agregada na Visão geral ==');
await admin.evaluate(() => {
  location.hash = 'visaogeral';
});
await admin.waitForTimeout(500);
check('painel "Ocupação da rede" existe', await admin.isVisible('#ocupacaoRede'));
check('ponto D aparece na lista de ocupação', (await admin.textContent('#ocupacaoRede')).includes('Farmácia Ocupação'));
check('aviso de bloqueio aparece pro ponto D', (await admin.textContent('#ocupacaoRede')).includes('bloqueada'));
await admin.screenshot({ path: `${SAIDA}v25-visao-geral-ocupacao.png`, fullPage: true });
await admin.click('[data-liberar]');
await admin.waitForTimeout(400);
check('ponto D liberado com sucesso', PG(`SELECT escolha_bloqueada_em FROM pontos WHERE id=${idD}`) === '');

console.log('== site público "Onde estamos" — foto e placeholder ==');
const publico = await pagina('/pontos.html');
await publico.waitForTimeout(400);
check('card com foto real (ponto C)', (await publico.locator('.ponto-card-media img').count()) >= 1);
check('card com placeholder (pontos sem foto)', (await publico.locator('.ponto-foto-placeholder').count()) >= 1);
await publico.screenshot({ path: `${SAIDA}v25-onde-estamos.png`, fullPage: true });

console.log('== candidatura com foto (dono já logado) ==');
const cadastro = await pagina('/');
const conta = await cadastro.evaluate(
  async () =>
    await (
      await fetch('/anunciantes/cadastro', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome_empresa: 'Loja Teste Foto',
          cpf_cnpj: '390.533.447-05',
          endereco: 'Rua Lu, 5',
          cidade: 'Matão',
          uf: 'SP',
          cep: '15990-000',
          contato_email: 'foto-e2e@x.com',
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
await cadastro.evaluate(
  async () =>
    await fetch('/conta/modos/anunciante', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endereco: 'Rua Lu, 5', cidade: 'Matão', uf: 'SP', cep: '15990-000', categoria_livre: 'Papelaria' }),
    }).then((r) => r.json()),
);

const painel = await pagina('/anunciante/painel.html');
await painel.waitForTimeout(500);
await painel.click('#btnAbrirCardPonto');
check('campo de foto (opcional) existe no formulário', (await painel.locator('#cp_foto').count()) === 1);
await painel.fill('#cp_fluxo', '1500');
await painel.fill('#cp_mensagem', 'fachada azul, de frente pro semáforo');
const fotoTeste = `${SAIDA}foto-teste.png`;
// PNG 1x1 mínimo válido, só pra exercitar o upload multipart de verdade.
writeFileSync(
  fotoTeste,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
await painel.setInputFiles('#cp_foto', fotoTeste);
check('nome do arquivo aparece depois de escolher', (await painel.textContent('#cp_fotoNome')) === 'foto-teste.png');
await painel.click('#formCardPonto button[type=submit]');
await painel.waitForTimeout(700);
check(
  'pedido enviado com sucesso MESMO com o upload da foto falhando (Supabase não configurado neste ambiente)',
  (await painel.textContent('#cardPontoMsg')).includes('Pedido enviado'),
);
const mensagemGravada = PG(`SELECT mensagem FROM candidaturas WHERE conta_id=${conta.id} AND tipo='ponto'`);
check('"algo a mais" gravado na candidatura', mensagemGravada === 'fachada azul, de frente pro semáforo', mensagemGravada);
await painel.screenshot({ path: `${SAIDA}v25-candidatura-com-foto.png`, fullPage: true });

console.log('\nerros de página:', erros.length ? erros : 'nenhum');
console.log('falhas:', falhas.length);
await b.close();
process.exit(falhas.length || erros.length ? 1 : 0);
