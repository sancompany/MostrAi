// Rodada final da tela Rede do admin (22/09/2026): status do ponto 100%
// automático (derivado das telas, sem Instalação/ACM/foto no admin), ficha
// somente-leitura + Telas em cards + margens de safe area, Ocupação da rede
// como tabela operacional, candidatura com foto no topo. Assume banco zerado
// e servidor na 3999 (NODE_ENV=test). Substitui o roteiro da rodada anterior
// (v25) — badges/painéis daquela versão (Instalação, ACM, "TV instalada",
// tabela de telas) não existem mais.
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
// `pontos.status` é escrito só por `sincronizarStatusPonto` (migration 069)
// dentro do app — aqui, montando fixture direto no banco (sem passar pelas
// rotas), o script grava o status já coerente com as telas que insere logo
// em seguida, pra não depender da lógica de sincronização (essa já tem
// cobertura própria em tests/redesenho-rede.test.js).

// Ponto A: 0 telas -> aguardando instalação.
const idA = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato)
   VALUES ('Padaria Aguardando', 'Rua Curta, 1', 'Matão', 'SP', '15990000', 'padaria', 'Ana', '16999990001')
   RETURNING id`,
);

// Ponto B: 1 tela ativa -> ativo.
const idB = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status, fluxo_estimado_mensal)
   VALUES ('Mercadinho Ativo', 'Rua das Flores, 200', 'Matão', 'SP', '15990000', 'mercado', 'Beto', '16999990002', 'em_operacao', 800)
   RETURNING id`,
);
PG(
  `INSERT INTO dispositivos (ponto_id, apelido, aparelho_id, instalado_em, status) VALUES (${idB}, 'Tela 1', gen_random_uuid(), current_date, 'ativo')`,
);

// Ponto C: nome/endereço grandes, foto, observações, horário — 3 telas
// (ativa + reparo + sem chave) -> ativo (basta 1 ativa).
const nomeGrande = 'Academia Corpo em Movimento Studio de Pilates e Musculação Unidade Centro';
const enderecoGrande = 'Avenida Presidente Getúlio Vargas Filho, número 1234, Sala 56, Bloco B, Centro';
const idC = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status, fluxo_estimado_mensal, foto_instalacao_url, observacoes, horario_semanal)
   VALUES ('${nomeGrande}', '${enderecoGrande}', 'Matão', 'SP', '15990000', 'academia', 'Carla Consultora Responsável', '16999990003', 'em_operacao', 4200,
     'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'tem estacionamento próprio nos fundos, entrada pela lateral',
     '{"seg":{"abre":"06:00","fecha":"22:00"},"ter":{"abre":"06:00","fecha":"22:00"},"qua":{"abre":"06:00","fecha":"22:00"},"qui":{"abre":"06:00","fecha":"22:00"},"sex":{"abre":"06:00","fecha":"22:00"},"sab":{"abre":"08:00","fecha":"12:00"},"dom":null,"feriados":null}')
   RETURNING id`,
);
PG(
  `INSERT INTO dispositivos (ponto_id, apelido, aparelho_id, instalado_em, status) VALUES (${idC}, 'Tela 1', gen_random_uuid(), current_date, 'ativo')`,
);
PG(
  `INSERT INTO dispositivos (ponto_id, apelido, aparelho_id, instalado_em, status) VALUES (${idC}, 'Tela 2', gen_random_uuid(), current_date, 'reparo')`,
);
PG(`INSERT INTO dispositivos (ponto_id, apelido) VALUES (${idC}, 'Tela 3 (sem chave ainda)')`);

// Ponto E: 1 tela em reparo, nenhuma ativa -> em reparo.
const idE = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
   VALUES ('Loja Em Reparo', 'Rua Baixa, 9', 'Matão', 'SP', '15990000', 'loja', 'Elis', '16999990005', 'em_reparo')
   RETURNING id`,
);
PG(`INSERT INTO dispositivos (ponto_id, apelido, aparelho_id, status) VALUES (${idE}, 'Tela 1', gen_random_uuid(), 'reparo')`);

// Ponto F: tem tela cadastrada, nenhuma ativa/reparo -> inativo. Não deve
// aparecer no site público (só `inativo` fica de fora, ver
// src/pontos/repository.js#listarPublicos).
const idF = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
   VALUES ('Oficina Inativa', 'Rua Funda, 3', 'Matão', 'SP', '15990000', 'oficina', 'Fabio', '16999990006', 'inativo')
   RETURNING id`,
);
PG(`INSERT INTO dispositivos (ponto_id, apelido, aparelho_id, status) VALUES (${idF}, 'Tela 1', gen_random_uuid(), 'inativo')`);

// Ponto D: em operação, ocupação alta o bastante pra ficar "travado" (G.7,
// LIMITE_OCUPACAO_BLOQUEIA=0.8), mas com folga suficiente pra liberar de
// novo — mesmo cenário "sticky" que tests/pontos-ocupacao.test.js já cobre
// por unidade; aqui é só a VISUAL da tabela de Ocupação da rede.
const idD = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
   VALUES ('Farmácia Ocupação', 'Rua Central, 50', 'Matão', 'SP', '15990000', 'farmacia', 'Duda', '16999990004', 'em_operacao')
   RETURNING id`,
);
PG(`INSERT INTO dispositivos (ponto_id, apelido, aparelho_id, status) VALUES (${idD}, 'Tela 1', gen_random_uuid(), 'ativo')`);
PG(`DELETE FROM planos WHERE id = 'plano-teste-e2e-rede'`);
PG(
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
check('sem "Novo ponto" na tela', !(await admin.locator('text=Novo ponto').count()));
check('sem "ACM"/"molde" na tela', !(await admin.locator('text=/ACM|molde/i').count()));
check('6 cards visíveis (A/B/C/D/E/F)', (await admin.locator('.ponto-card').count()) >= 6);
check('badge "Aguardando instalação" existe', (await admin.locator('.badge:has-text("Aguardando instalação")').count()) >= 1);
check('badge "Ativo" existe', (await admin.locator('.badge:has-text("Ativo")').count()) >= 2);
check('badge "Em reparo" existe', (await admin.locator('.badge:has-text("Em reparo")').count()) >= 1);
check('badge "Inativo" existe', (await admin.locator('.badge:has-text("Inativo")').count()) >= 1);
check('placeholder de foto aparece pros pontos sem foto', (await admin.locator('.ponto-foto-placeholder').count()) >= 3);
check('foto real aparece pro ponto C', (await admin.locator('.ponto-card-media img').count()) >= 1);
await admin.screenshot({ path: `${SAIDA}v26-rede-grade-desktop.png`, fullPage: true });

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
await admin.click('.chip:has-text("Em reparo")');
await admin.waitForTimeout(400);
check('filtro "Em reparo" mostra só o ponto E', (await admin.locator('.ponto-card:visible').count()) === 1);
await admin.click('.chip:has-text("Inativo")');
await admin.waitForTimeout(400);
check('filtro "Inativo" mostra só o ponto F', (await admin.locator('.ponto-card:visible').count()) === 1);
await admin.click('.chip:has-text("Ativo")');
await admin.waitForTimeout(400);
check('filtro "Ativo" mostra B, C e D', (await admin.locator('.ponto-card:visible').count()) === 3);
await admin.click('.chip:has-text("Todos")');
await admin.waitForTimeout(400);

console.log('== grade da Rede — mobile ==');
await admin.setViewportSize({ width: 390, height: 844 });
await admin.waitForTimeout(400);
await admin.screenshot({ path: `${SAIDA}v26-rede-grade-mobile.png`, fullPage: true });
await admin.setViewportSize({ width: 1400, height: 960 });

console.log('== detalhe do ponto — 2 colunas, breadcrumb, sem Instalação/ACM ==');
await admin.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, idC);
await admin.waitForTimeout(400);
check('breadcrumb "Rede / <nome>"', (await admin.textContent('.ponto-breadcrumb')).includes('Rede') && (await admin.textContent('.ponto-breadcrumb')).includes('Academia'));
check('voltar pela breadcrumb leva pra grade', await admin.locator('.ponto-breadcrumb a:has-text("Rede")').isVisible());
check('foto grande no cabeçalho', await admin.locator('.ponto-info-foto img').isVisible());
check('nome grande aparece por inteiro', (await admin.textContent('.ponto-info-titulo h3')).includes('Academia Corpo em Movimento'));
check('segmento aparece', (await admin.textContent('.ponto-info-titulo')).includes('academia'));
check('responsável somente-leitura (sem input)', (await admin.locator('#pontoInformacoes input, #pontoInformacoes select').count()) === 0);
check('horário de funcionamento mostrado como texto', (await admin.textContent('#pontoInformacoes')).includes('06:00'));
check('observações aparecem', (await admin.textContent('#pontoInformacoes')).includes('estacionamento'));
check('sem painel de Instalação/ACM na ficha', !(await admin.locator('text=/ACM|molde|Instalação/i').count()));
check('3 telas em cards (não tabela)', (await admin.locator('#pontoTelas .tela-card').count()) === 3);
check('sem tabela de telas', (await admin.locator('#pontoTelas table').count()) === 0);
check('sem coluna/campo "Contrato" nas telas', !(await admin.locator('#pontoTelas').locator('text=Contrato').count()));
check('sem coluna/campo "Custo" nas telas', !(await admin.locator('#pontoTelas').locator('text=Custo').count()));
check('campos de margem (4 lados) na 1ª tela', (await admin.locator('.tela-card').first().locator('.margens-grid input').count()) === 4);
await admin.screenshot({ path: `${SAIDA}v26-ponto-detalhe-desktop.png`, fullPage: true });
await admin.setViewportSize({ width: 390, height: 844 });
await admin.waitForTimeout(400);
check('colunas empilham no mobile (grid vira 1 coluna)', await admin.evaluate(() => {
  const grid = document.querySelector('.ponto-detalhe-grid');
  return grid && getComputedStyle(grid).gridTemplateColumns.split(' ').length === 1;
}));
await admin.screenshot({ path: `${SAIDA}v26-ponto-detalhe-mobile.png`, fullPage: true });
await admin.setViewportSize({ width: 1400, height: 960 });

console.log('== margens da safe area — salvar no banco ==');
const inputMargemSup = admin.locator('.tela-card').first().locator('input[data-tela="margem_superior"]');
const telaIdC1 = await inputMargemSup.getAttribute('data-id');
await inputMargemSup.fill('6');
await inputMargemSup.dispatchEvent('change');
await admin.waitForTimeout(400);
check('margem superior salva no banco', PG(`SELECT margem_superior FROM dispositivos WHERE id=${telaIdC1}`) === '6');

console.log('== ponto sem tela — aguardando instalação, sem Instalação/ACM ==');
await admin.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, idA);
await admin.waitForTimeout(300);
check('placeholder no cabeçalho do ponto sem foto', await admin.locator('.ponto-info-foto .ponto-foto-placeholder').isVisible());
check('badge "Aguardando instalação" no detalhe', (await admin.textContent('.ponto-info-titulo')).includes('Aguardando instalação'));
check('nenhuma tela — mensagem certa', (await admin.textContent('#pontoTelas')).includes('Nenhuma tela'));
check('sem botão de instalação manual', !(await admin.locator('text=/Colocar em operação|Voltar.*instalação/i').count()));

console.log('== criar tela pelo botão "+ tela" — ponto sai de aguardando instalação ==');
await admin.click('#btnNovaTela');
await admin.waitForTimeout(400);
check('tela criada aparece', (await admin.locator('#pontoTelas .tela-card').count()) === 1);
check('status automático já não é "a_instalar" (tela cadastrada, ainda inativa)', PG(`SELECT status FROM pontos WHERE id=${idA}`) === 'inativo');
const telaNovaId = await admin.locator('.tela-card select[data-tela="status"]').first().getAttribute('data-id');
await admin.selectOption(`select[data-tela="status"][data-id="${telaNovaId}"]`, 'ativo');
await admin.waitForTimeout(400);
check('marcar a tela como Ativa vira "Ativo" no ponto', PG(`SELECT status FROM pontos WHERE id=${idA}`) === 'em_operacao');
await admin.evaluate(() => {
  location.hash = 'rede/pontos';
});
await admin.waitForTimeout(400);
check('badge do card A virou "Ativo" na grade', (await admin.locator(`a.ponto-card[href="#rede/pontos/${idA}"] .badge`).textContent()) === 'Ativo');

console.log('== ocupação da rede — tabela operacional na Visão geral ==');
await admin.evaluate(() => {
  location.hash = 'visaogeral';
});
await admin.waitForTimeout(500);
check('painel "Ocupação da rede" existe', await admin.isVisible('#ocupacaoRede'));
check('é uma tabela (não mais barra simples)', await admin.locator('#ocupacaoRede table').isVisible());
const cabecalhos = await admin.locator('#ocupacaoRede thead th').allTextContents();
check(
  'colunas: Ponto/Status/Telas/Anunciantes/Ocupação/Restante/Reserva',
  ['Ponto', 'Status', 'Telas', 'Anunciantes'].every((c) => cabecalhos.some((h) => h.includes(c))) &&
    cabecalhos.some((h) => h.includes('80%')) &&
    cabecalhos.some((h) => h.includes('Reserva Mostraí')),
  cabecalhos,
);
check('ponto D aparece na lista de ocupação', (await admin.textContent('#ocupacaoRede')).includes('Farmácia Ocupação'));
check('reserva Mostraí sempre 20% (nunca some)', (await admin.textContent('#ocupacaoRede')).includes('20%'));
await admin.click('[data-expandir-ocupacao]');
await admin.waitForTimeout(300);
check('expandir mostra o peso por anunciante (s/hora)', (await admin.textContent('#ocupacaoRede')).includes('s/hora'));
await admin.screenshot({ path: `${SAIDA}v26-visao-geral-ocupacao.png`, fullPage: true });
await admin.click('[data-liberar]');
await admin.waitForTimeout(400);
check('ponto D liberado com sucesso', PG(`SELECT escolha_bloqueada_em FROM pontos WHERE id=${idD}`) === '');

console.log('== site público "Onde estamos" — foto, placeholder e quem aparece ==');
const publico = await pagina('/pontos.html');
await publico.waitForTimeout(400);
check('card com foto real (ponto C)', (await publico.locator('.ponto-card-media img').count()) >= 1);
check('card com placeholder (pontos sem foto)', (await publico.locator('.ponto-foto-placeholder').count()) >= 1);
check('ponto em reparo (E) aparece — é real, só não veicula agora', (await publico.textContent('body')).includes('Loja Em Reparo'));
check('ponto inativo (F) NÃO aparece', !(await publico.textContent('body')).includes('Oficina Inativa'));
await publico.screenshot({ path: `${SAIDA}v26-onde-estamos.png`, fullPage: true });

console.log('== candidatura com foto no topo (dono já logado) ==');
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
check('dica padrão de foto aparece antes de escolher arquivo', (await painel.textContent('#cp_fotoNome')).includes('Opcional'));
// A foto vem ANTES do campo de movimento no formulário (seção "topo" pedida
// na rodada final) — comparado a posição no DOM.
check(
  'campo de foto vem antes do campo de movimento',
  await painel.evaluate(() => {
    const foto = document.querySelector('.campo-foto');
    const fluxo = document.getElementById('cp_fluxo');
    return !!(foto && fluxo) && !!(foto.compareDocumentPosition(fluxo) & Node.DOCUMENT_POSITION_FOLLOWING);
  }),
);
check('horário semanal tem os 7 dias + feriados', (await painel.locator('.horario-dia').count()) === 8);
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
await painel.screenshot({ path: `${SAIDA}v26-candidatura-com-foto.png`, fullPage: true });

console.log('\nerros de página:', erros.length ? erros : 'nenhum');
console.log('falhas:', falhas.length);
await b.close();
process.exit(falhas.length || erros.length ? 1 : 0);
