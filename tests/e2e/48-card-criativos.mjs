// Card "Meus criativos" com envio sob demanda (estação de 10/10/2026), na
// rota real (/anunciante/painel.html): fechado, o card é só a biblioteca
// (contador "X de Y criativos utilizados" + um botão); "Enviar criativo" abre
// o novo criativo dentro do card (arquivo, negócio, "Enviar para análise");
// "Cancelar envio" volta sem deixar peça nem negócio; no limite do plano o
// botão vira "Substituir criativo" — escolher a peça, depois o arquivo, com o
// negócio da peça travado. Regras que não mudaram e continuam valendo:
// substituta única por peça, teto de cadastro (3 guardados), correção e
// reenvio. Essencial 1/1 (um negócio) e Prime 3/3 (dois negócios), desktop,
// tablet e celular, teclado, sem erro de console, sem diálogo nativo.
//
// Sobe o próprio servidor com STORAGE_CAPTURA (upload real; como no 47). Uso:
//   tests/e2e/reset-db.sh && node tests/e2e/48-card-criativos.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const RAIZ = new URL('../../', import.meta.url).pathname;
const SAIDA = new URL('./saida/48-', import.meta.url).pathname;
fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
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
const esperar = async (fn, ms = 20000) => {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
};

const VIDEO = `${SAIDA}peca.mp4`;
execSync(`ffmpeg -v error -y -f lavfi -i testsrc2=size=360x640:rate=30 -t 5 -c:v libx264 -preset ultrafast ${VIDEO}`);
execSync(`bash ${RAIZ}tests/e2e/restart.sh STORAGE_CAPTURA=${SAIDA}storage`);

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME, args: ['--lang=pt-BR'] }));
const vigiar = (p) => {
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (400|401|404|409)/.test(m.text())) erros.push(`console: ${m.text()}`);
  });
  p.on('dialog', async (d) => {
    erros.push(`diálogo nativo: ${d.message()}`);
    await d.dismiss();
  });
  return p;
};

async function novaConta(prefixo, plano, categoria) {
  const email = `e2e48-${prefixo}-${Date.now()}@teste.dev`;
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR' });
  const cad = await ctx.request.post(`${B}/anunciantes/cadastro`, {
    data: {
      nome_empresa: `Loja ${prefixo}`,
      cpf_cnpj: '52998224725',
      cep: '15990-000',
      logradouro: 'Avenida Habib Gabriel',
      numero: '1200',
      bairro: 'Centro',
      cidade: 'Matão',
      uf: 'SP',
      contato_email: email,
      contato_telefone: '(16) 99999-0048',
      senha: 'Senha@Forte1',
      aceitou_termos: true,
    },
  });
  check(`cadastro ${prefixo}`, cad.status() === 201, String(cad.status()));
  const id = PG(
    `WITH u AS (UPDATE anunciantes SET email_confirmado = true, plano_id = '${plano}', data_inicio_cobertura = now(),
       data_expiracao = now() + interval '20 days', categoria_id = (SELECT id FROM categorias WHERE nome = '${categoria}')
     WHERE contato_email = '${email}' RETURNING id) SELECT id FROM u`,
  );
  const p = vigiar(await ctx.newPage());
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', email);
  await p.fill('#senha', 'Senha@Forte1');
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 15000 });
  await p.waitForSelector('#modCriativos:not([hidden]) #contadorCriativos:not(:empty)', { timeout: 15000 });
  return { id, p, ctx };
}

const visivel = (p, sel) => p.isVisible(sel);
const texto = async (p, sel) => ((await p.textContent(sel)) || '').trim();
// O resync do eventos.js (voltar pra aba) relê a lista — pro que mudou direto no banco.
const resync = async (p) => {
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(700);
};
const contarNegocios = (conta) => Number(PG(`SELECT count(*) FROM negocios WHERE anunciante_id = ${conta}`));
const contarCriativos = (conta) => Number(PG(`SELECT count(*) FROM criativos WHERE anunciante_id = ${conta}`));
const IMG = '/img/favicon-192.png';
const pecaAprovada = (conta) =>
  PG(`INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, duracao_segundos, status)
      VALUES (${conta}, 'x.png', '${IMG}', 10, 'aprovado') RETURNING id`).split('\n')[0];

const admin = await b.newContext();
const login = await admin.request.post(`${B}/admin/login`, {
  data: { usuario: process.env.ADMIN_USER || 'admin', senha: process.env.ADMIN_PASSWORD || 'Admin12@teste' },
});
check('admin entrou', login.ok(), String(login.status()));

// ---------------------------------------------------------------------------
console.log('== 1. Essencial 1/1, um negócio: o card fechado é só a biblioteca ==');
const ess = await novaConta('essencial', 'essencial-1m', 'Academia');
let p = ess.p;
check('[1] card limpo: sem seletor de negócio', !(await visivel(p, '#negocioEnvio')) && !(await visivel(p, '.negocio-opcao')));
check('[1] card limpo: sem formulário de marca nem categoria', !(await visivel(p, '[data-negocio-novo]')) && !(await visivel(p, '[data-categorias]')));
check('[1] card limpo: sem upload nem bloco de envio', !(await visivel(p, '#envioCriativo')) && !(await visivel(p, '#escolherArquivo')));
check('[10] contador no singular: "0 de 1 criativo utilizado"', (await texto(p, '#contadorCriativos')) === '0 de 1 criativo utilizado', await texto(p, '#contadorCriativos'));
check('[2] abaixo do limite: "+ Enviar criativo"', await visivel(p, '#botaoEnviarCriativo'));
check('[2] e sem "Substituir criativo" nem aviso de limite', !(await visivel(p, '#botaoSubstituirCriativo')) && !(await visivel(p, '#avisoLimite')));
check('biblioteca vazia diz o que fazer', /Nenhum criativo enviado ainda\.[\s\S]*Enviar criativo/.test(await texto(p, '#listaCriativos')));
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}1-biblioteca-vazia.png` });

console.log('== 2. teclado: Enter no botão abre o novo criativo e o foco entra no bloco ==');
await p.focus('#botaoEnviarCriativo');
await p.keyboard.press('Enter');
await p.waitForSelector('#envioCriativo:not([hidden])');
check('[3] modo de criação abre dentro do card: "Novo criativo"', (await texto(p, '#tituloEnvio')) === 'Novo criativo');
check('[3] subtítulo do bloco', (await texto(p, '#envioSub')) === 'Configure a peça antes de enviá-la para análise.');
check(
  '[3] "Cancelar" discreto no topo (nome acessível "Cancelar envio")',
  (await texto(p, '#cancelarEnvio')) === 'Cancelar' && (await p.getAttribute('#cancelarEnvio', 'aria-label')) === 'Cancelar envio',
);
check('[3] seção ARQUIVO, sem numeração', (await texto(p, '#rotuloEtapaArquivo')) === 'Arquivo');
check(
  '[3] área de soltar: arrastar ou "Selecionar arquivo", com as regras curtas',
  /Arraste seu vídeo ou imagem aqui/.test(await texto(p, '#dropzone')) &&
    (await texto(p, '#escolherArquivo')) === 'Selecionar arquivo' &&
    (await texto(p, '#criativosSubtitulo')) === 'Vertical · até 15 s · até 95 MB · sem áudio',
  await texto(p, '#criativosSubtitulo'),
);
check('[3] seção NEGÓCIO ANUNCIADO, com a frase de apoio', (await texto(p, '#negocioEnvio legend')) === 'Negócio anunciado' && /Escolha quem aparece nesta peça/.test(await texto(p, '#negocioEnvio')));
check('[3] botão "Enviar para análise"', await visivel(p, '#enviarParaAnalise'));
check(
  '[9-estado] recém-aberto: botão inativo (aria-disabled) e o rodapé diz o que falta',
  (await p.getAttribute('#enviarParaAnalise', 'aria-disabled')) === 'true' &&
    (await texto(p, '#envioDica')) === 'Selecione o arquivo da peça para enviar.' &&
    (await visivel(p, '#envioDica')),
);
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}1b-composer-aberto.png` });
check('[26] foco foi pro primeiro controle (o arquivo)', await p.evaluate(() => document.activeElement?.id === 'escolherArquivo'));
check('[3] a biblioteca e o botão do topo saem de cena', !(await visivel(p, '#listaCriativos')) && !(await visivel(p, '#botaoEnviarCriativo')));
check('[4] o principal vem marcado', (await p.locator('#negocioEscolha .negocio-opcao').count()) === 1 && (await p.isChecked('#negocioEscolha .negocio-opcao input')));
check('[4] radio de verdade, com nome', (await p.getAttribute('#negocioEscolha .negocio-opcao input', 'type')) === 'radio');
check('[6] "outro negócio ou marca" é uma opção do mesmo grupo, desmarcada', (await p.getAttribute('[data-negocio-outro]', 'type')) === 'radio' && !(await p.isChecked('[data-negocio-outro]')));
check('[6] o negócio novo só abre a pedido', !(await visivel(p, '[data-negocio-novo]')));
// Teclado: do arquivo, Tab vai pro negócio marcado; as setas andam no grupo
// de rádios — e "outro negócio" abre os campos só enquanto está marcado.
await p.focus('#escolherArquivo');
await p.keyboard.press('Tab');
check('[26] Tab do arquivo vai pro negócio marcado', await p.evaluate(() => document.activeElement?.type === 'radio' && document.activeElement.checked));
await p.keyboard.press('ArrowDown');
check('[26] seta no grupo marca "outro negócio" e abre os campos', (await p.isChecked('[data-negocio-outro]')) && (await visivel(p, '[data-negocio-novo]')));
await p.keyboard.press('ArrowUp');
check('[26] seta de volta: principal marcado, campos fechados', (await p.isChecked('#negocioEscolha .negocio-opcao input')) && !(await visivel(p, '[data-negocio-novo]')));

console.log('== 3. "+ Anunciar outro negócio ou marca" e cancelar: nada é criado ==');
const negociosAntes = contarNegocios(ess.id);
await p.click('[data-negocio-outro]');
check('[6] formulário da marca nova aparece sob demanda', await visivel(p, '[data-negocio-novo]'));
check(
  '[6] a escolha ativa fica clara: "outro" marcado, o principal desmarcado',
  (await p.isChecked('[data-negocio-outro]')) && !(await p.isChecked('#negocioEscolha .negocio-opcao input')),
);
check('[6] sub-bloco "Novo negócio ou marca" com nome, categoria e "mesmo grupo"', (await texto(p, '.negocio-novo-titulo')) === 'Novo negócio ou marca' && (await visivel(p, '[data-negocio-nome]')) && (await p.locator('[data-negocio-grupo]').count()) === 1);
await p.fill('[data-negocio-nome]', 'Marca Cancelada');
await p.setInputFiles('#arquivoCriativo', VIDEO);
check(
  '[5-estado] o arquivo escolhido aparece NA área de soltar (prévia, nome, tamanho, estado), sem subir nada',
  (await visivel(p, '#dropzone #arquivoCard')) &&
    !(await visivel(p, '#dropzoneVazia')) &&
    (await texto(p, '#arquivoEscolhido')) === '48-peca.mp4' &&
    /^(\d+ KB|\d+,\d MB)$/.test(await texto(p, '#arquivoTamanho')) &&
    (await texto(p, '#arquivoEstado')) === 'Selecionado' &&
    // Prévia: o quadro do vídeo, ou o bloco escuro com ▶ quando o navegador
    // não decodifica o formato (o Chromium do Playwright não tem H.264).
    (await visivel(p, '#arquivoPrevia')) &&
    contarCriativos(ess.id) === 0,
  `${await texto(p, '#arquivoCard')}`,
);
check(
  '[9-estado] com o negócio novo incompleto, o botão segue inativo e diz o que falta',
  (await p.getAttribute('#enviarParaAnalise', 'aria-disabled')) === 'true' && /categoria/.test(await texto(p, '#envioDica')),
  await texto(p, '#envioDica'),
);
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}1c-outro-negocio-com-arquivo.png` });
await p.click('#cancelarEnvio');
check('[7] cancelar fecha o modo', !(await visivel(p, '#envioCriativo')));
check('[7] volta pra biblioteca, com o botão do topo', (await visivel(p, '#listaCriativos')) && (await visivel(p, '#botaoEnviarCriativo')));
check('[7] o foco volta pro botão que abriu', await p.evaluate(() => document.activeElement?.id === 'botaoEnviarCriativo'));
check('[7] nenhum negócio criado', contarNegocios(ess.id) === negociosAntes, `${negociosAntes} → ${contarNegocios(ess.id)}`);
check('[7] nenhum criativo criado', contarCriativos(ess.id) === 0);
check('[7] sem mensagem pendurada', (await texto(p, '#uploadMsg')) === '');
await p.click('#botaoEnviarCriativo');
check(
  '[7] reabrir começa do zero: marca nova fechada, principal marcado, sem arquivo',
  !(await visivel(p, '[data-negocio-novo]')) && (await p.isChecked('#negocioEscolha .negocio-opcao input')) && !(await visivel(p, '#arquivoCard')) && (await visivel(p, '#dropzoneVazia')),
);
// Botão inativo é aria-disabled (segue focável): o clique não envia, destaca o que falta e leva o foco ao arquivo.
await p.click('#enviarParaAnalise', { force: true });
check(
  'sem arquivo: o clique não envia, destaca o que falta e leva o foco ao arquivo',
  (await p.getAttribute('#envioDica', 'class')).includes('alerta') &&
    (await p.evaluate(() => document.activeElement?.id === 'escolherArquivo')) &&
    contarCriativos(ess.id) === 0,
);

console.log('== 4. envio real: arquivo, análise, volta pra biblioteca ==');
check('[27] mensagem do envio é role=status', (await p.getAttribute('#uploadMsg', 'role')) === 'status');
await p.setInputFiles('#arquivoCriativo', VIDEO);
check(
  '[8-estado] pronto pra enviar: botão ativo, sem aviso no rodapé',
  (await p.getAttribute('#enviarParaAnalise', 'aria-disabled')) === 'false' && !(await visivel(p, '#envioDica')) && (await texto(p, '#uploadMsg')) === '',
);
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}1d-pronto.png` });
await p.click('#enviarParaAnalise');
await esperar(async () => /Criativo enviado!/.test(await texto(p, '#uploadMsg')), 60000);
check('[8] upload, processamento e envio funcionam', /Criativo enviado!/.test(await texto(p, '#uploadMsg')), await texto(p, '#uploadMsg'));
check('[9] depois de enviar, o card volta pra biblioteca', !(await visivel(p, '#envioCriativo')) && (await visivel(p, '#listaCriativos')));
await esperar(async () => (await p.locator('.criativo-card').count()) === 1);
check('[8] a peça aparece na lista, em análise', /Em análise/.test(await texto(p, '#listaCriativos')));
check('[8] 1 criativo no banco, no negócio principal', contarCriativos(ess.id) === 1 && PG(`SELECT n.principal FROM criativos c JOIN negocios n ON n.id = c.negocio_id WHERE c.anunciante_id = ${ess.id}`) === 't');
check('[9] o foco foi pro título do card', await p.evaluate(() => document.activeElement?.id === 'tituloCriativos'));

console.log('== 5. no limite: sem "Enviar", com "Substituir criativo" ==');
await esperar(async () => (await texto(p, '#contadorCriativos')) === '1 de 1 criativo utilizado');
check('[22] Essencial 1/1: "1 de 1 criativo utilizado"', (await texto(p, '#contadorCriativos')) === '1 de 1 criativo utilizado', await texto(p, '#contadorCriativos'));
check('[12] no limite, "Enviar criativo" some (não fica desabilitado)', (await p.locator('#botaoEnviarCriativo').isHidden()) && !(await p.isDisabled('#botaoSubstituirCriativo')));
check('[13] aparece "↻ Substituir criativo"', (await visivel(p, '#botaoSubstituirCriativo')) && /Substituir criativo/.test(await texto(p, '#botaoSubstituirCriativo')));
check('[13] com o aviso discreto do limite', (await visivel(p, '#avisoLimite')) && (await texto(p, '#avisoLimite')) === 'Limite de criativos do plano atingido.');
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}2-limite.png` });
await p.click('#botaoSubstituirCriativo');
check('peça em análise não se substitui: o card explica', /Nenhuma peça pode ser substituída agora/.test(await texto(p, '#envioAviso')));
check('e não oferece arquivo nem envio', !(await visivel(p, '#etapaArquivo')) && !(await visivel(p, '#enviarParaAnalise')));
await p.click('#cancelarEnvio');

const original = PG(`SELECT id FROM criativos WHERE anunciante_id = ${ess.id}`);
const aprov = await admin.request.patch(`${B}/admin/criativos/${original}`, { data: { status: 'aprovado' } });
check('admin aprovou a peça', aprov.ok(), String(aprov.status()));
await esperar(async () => /Programado|Aprovado|Aguardando/.test(await texto(p, `.criativo-card[data-id="${original}"]`)), 10000);

console.log('== 6. substituir: escolher a peça, negócio travado ==');
await p.click('#botaoSubstituirCriativo');
await p.waitForSelector('#etapaAlvo:not([hidden]) .alvo-opcao');
check('[14] "Qual criativo você quer substituir?"', (await texto(p, '#etapaAlvo legend')) === 'Peça a substituir' && /Qual criativo você quer substituir\?/.test(await texto(p, '#etapaAlvo')));
check('[14] lista a peça elegível com negócio, categoria e situação', /Loja essencial[\s\S]*Academia[\s\S]*(Programado|Aprovado|Aguardando)/.test(await texto(p, '#alvosSubstituicao')), await texto(p, '#alvosSubstituicao'));
check('[14] uma só: já vem marcada, e o foco está nela', (await p.isChecked('#alvosSubstituicao input')) && (await p.evaluate(() => document.activeElement?.name === 'alvo_substituicao')));
check('[14] arquivo só depois de escolher', !(await visivel(p, '#etapaArquivo')));
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}3-escolher-peca.png` });
await p.click('#continuarSubstituicao');
check('[15] "Substituindo criativo de: <negócio> · <categoria>"', /Substituindo criativo de: Loja essencial · Academia/.test(await texto(p, '#envioTravado')), await texto(p, '#envioTravado'));
check('[16] a marca não pode mudar: sem escolha de negócio', !(await visivel(p, '#negocioEnvio')) && !(await visivel(p, '[data-negocio-outro]')));
check('[15] "Selecionar novo arquivo"', (await texto(p, '#escolherArquivo')) === 'Selecionar novo arquivo');
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}4-substituindo.png` });
await p.setInputFiles('#arquivoCriativo', VIDEO);
await p.click('#enviarParaAnalise');
await esperar(async () => /Substituta enviada/.test(await texto(p, '#uploadMsg')), 60000);
check('[15] substituta enviada', /Substituta enviada/.test(await texto(p, '#uploadMsg')), await texto(p, '#uploadMsg'));
check('[9] e o card volta pra biblioteca', !(await visivel(p, '#envioCriativo')));
const substituta = PG(`SELECT id FROM criativos WHERE substitui_criativo_id = ${original}`);
check(
  '[15] a substituta divulga o MESMO negócio da peça trocada',
  !!substituta && PG(`SELECT negocio_id FROM criativos WHERE id = ${substituta}`) === PG(`SELECT negocio_id FROM criativos WHERE id = ${original}`),
);
check('a atual segue aprovada até a nova ser aprovada', PG(`SELECT status FROM criativos WHERE id = ${original}`) === 'aprovado');

console.log('== 7. sem substituta duplicada ==');
await esperar(async () => !(await p.$(`.criativo-card[data-id="${original}"] [data-acao="substituir"]`)), 8000);
check('[17] a peça com substituta em análise perde o "Substituir" do card', !(await p.$(`.criativo-card[data-id="${original}"] [data-acao="substituir"]`)));
await p.click('#botaoSubstituirCriativo');
check('[17] e não aparece mais como elegível', /Nenhuma peça pode ser substituída agora/.test(await texto(p, '#envioAviso')) && (await p.locator('#alvosSubstituicao .alvo-opcao').count()) === 0);
await p.click('#cancelarEnvio');
const dupla = await p.evaluate(
  async ({ id, alvo }) => {
    const fd = new FormData();
    fd.append('arquivo', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('substitui', String(alvo));
    const r = await fetch(`/anunciantes/${id}/criativos`, { method: 'POST', credentials: 'include', body: fd });
    return `${r.status} ${(await r.json()).erro}`;
  },
  { id: ess.id, alvo: original },
);
check('[17] o servidor recusa a segunda (409)', /^409 .*substituta em análise/.test(dupla), dupla);
check('[17] uma substituta só no banco', PG(`SELECT count(*) FROM criativos WHERE substitui_criativo_id = ${original}`) === '1');
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}5-substituta-em-analise.png` });
await ess.ctx.close();

// ---------------------------------------------------------------------------
console.log('== 8. Prime, dois negócios: o envio de uma marca nova ==');
const prime = await novaConta('prime', 'maximo-1m', 'Restaurante');
p = prime.p;
check('[11] Prime vazio: "0 de 3 criativos utilizados"', (await texto(p, '#contadorCriativos')) === '0 de 3 criativos utilizados', await texto(p, '#contadorCriativos'));
await p.click('#botaoEnviarCriativo');
await p.click('[data-negocio-outro]');
await p.fill('[data-negocio-nome]', 'Marca Dois');
await p.fill('#envio_categoria_id_busca', 'Pizzaria');
await p.click('#envio_categoria_id_busca_lista li:has-text("Pizzaria")');
await p.setInputFiles('#arquivoCriativo', VIDEO);
await p.click('#enviarParaAnalise', { force: true });
check(
  'sem a declaração do grupo: diz o que falta, leva o foco à caixa, nada sobe',
  /mesmo responsável ou grupo/.test(await texto(p, '#envioDica')) &&
    (await p.evaluate(() => document.activeElement?.matches('[data-negocio-grupo]'))) &&
    contarCriativos(prime.id) === 0,
  await texto(p, '#envioDica'),
);
check('e o modo segue aberto com o que foi preenchido', (await visivel(p, '#envioCriativo')) && (await p.inputValue('[data-negocio-nome]')) === 'Marca Dois');
await p.check('[data-negocio-grupo]');
await p.click('#enviarParaAnalise');
await esperar(async () => /Criativo enviado!/.test(await texto(p, '#uploadMsg')), 60000);
check('[21] peça de outra marca enviada', /Criativo enviado!/.test(await texto(p, '#uploadMsg')) && contarCriativos(prime.id) === 1, await texto(p, '#uploadMsg'));
check('[21] o negócio novo nasceu junto, na mesma conta', contarNegocios(prime.id) === 2);
await esperar(async () => (await texto(p, '#contadorCriativos')) === '1 de 3 criativos utilizados');
check('[11] plural: "1 de 3 criativos utilizados"', (await texto(p, '#contadorCriativos')) === '1 de 3 criativos utilizados', await texto(p, '#contadorCriativos'));
await p.click('#botaoEnviarCriativo');
check('[5] os dois negócios aparecem na escolha', (await p.locator('#negocioEscolha .negocio-opcao').count()) === 2 && /Loja prime[\s\S]*Marca Dois/.test(await texto(p, '#negocioEscolha')));
check('[4] e o principal volta marcado por padrão', await p.isChecked('#negocioEscolha .negocio-opcao:first-child input'));
await p.click('#negocioEscolha .negocio-opcao:has-text("Marca Dois")');
check(
  '[3-estado] negócio adicional existente selecionado: marcado sozinho, sem abrir o negócio novo',
  (await p.isChecked('#negocioEscolha .negocio-opcao:has-text("Marca Dois") input')) &&
    !(await p.isChecked('#negocioEscolha .negocio-opcao:first-child input')) &&
    !(await visivel(p, '[data-negocio-novo]')),
);
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}6-dois-negocios.png` });

console.log('== 9. estados do arquivo: enviando e recusado (resposta simulada — nada chega ao servidor) ==');
await p.setInputFiles('#arquivoCriativo', VIDEO);
let soltarResposta;
const resposta = new Promise((r) => {
  soltarResposta = r;
});
await p.route('**/anunciantes/*/criativos', async (route) => {
  if (route.request().method() !== 'POST') return route.fallback();
  await resposta;
  await route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ erro: 'esse vídeo tem 35s e o seu plano aceita peça de até 30s — corte a peça ou mude de plano' }),
  });
});
await p.click('#enviarParaAnalise');
await esperar(async () => /Enviando|Processando/.test(await texto(p, '#arquivoEstado')));
check(
  '[6-estado] enviando: o arquivo mostra o andamento, o bloco trava e o "Cancelar" sai',
  /Enviando|Processando/.test(await texto(p, '#arquivoEstado')) &&
    (await p.isDisabled('#trocarArquivo')) &&
    (await p.getAttribute('#envioCriativo', 'aria-busy')) === 'true' &&
    !(await visivel(p, '#cancelarEnvio')) &&
    (await texto(p, '#enviarParaAnalise')) === 'Enviando...',
  await texto(p, '#arquivoEstado'),
);
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}7-enviando.png` });
soltarResposta();
await esperar(async () => (await texto(p, '#arquivoEstado')) === 'Recusado');
check(
  '[7-estado] recusado: "Recusado" no arquivo, o motivo no rodapé ao lado do botão, o bloco segue aberto',
  (await texto(p, '#arquivoEstado')) === 'Recusado' &&
    !!(await p.$('#envioRodape #uploadMsg')) &&
    /até 30s/.test(await texto(p, '#uploadMsg')) &&
    (await visivel(p, '#envioCriativo')),
  await texto(p, '#uploadMsg'),
);
check('[7-estado] nada criado', contarCriativos(prime.id) === 1);
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}8-recusado.png` });
await p.unroute('**/anunciantes/*/criativos');

console.log('== 10. tablet e celular: o bloco aberto cabe ==');
// O estado mais cheio: outro negócio aberto e arquivo escolhido.
await p.click('#cancelarEnvio');
check('cancelar devolve a mensagem pro lugar dela (abaixo do bloco), vazia', !(await p.$('#envioRodape #uploadMsg')) && (await texto(p, '#uploadMsg')) === '');
await p.click('#botaoEnviarCriativo');
await p.click('[data-negocio-outro]');
await p.fill('[data-negocio-nome]', 'Marca Três');
await p.setInputFiles('#arquivoCriativo', VIDEO);
for (const [largura, altura, nome] of [
  [1280, 900, '9-desktop-cheio'],
  [820, 1100, '9-tablet-cheio'],
  [390, 844, '9-celular-cheio'],
]) {
  await p.setViewportSize({ width: largura, height: altura });
  await p.waitForTimeout(300);
  check(`[25] ${largura}px: sem rolagem horizontal`, (await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
  await p.locator('#modCriativos').screenshot({ path: `${SAIDA}${nome}.png` });
}
const larguras = await p.evaluate(() => {
  const caixa = document.getElementById('envioCampos').getBoundingClientRect().width;
  return ['dropzone', 'trocarArquivo', 'enviarParaAnalise'].map((id) =>
    Math.round(document.getElementById(id).getBoundingClientRect().width - caixa),
  );
});
check('[25] celular: área de soltar e botão de envio na largura toda', Math.abs(larguras[0]) <= 1 && Math.abs(larguras[2]) <= 1, larguras);
const cards = await p.evaluate(() => {
  const caixa = document.getElementById('negocioEscolha').getBoundingClientRect().width;
  return [...document.querySelectorAll('#negocioEscolha .negocio-opcao, #negocioEscolha .negocio-outro-opcao')].map((el) =>
    Math.round(el.getBoundingClientRect().width - caixa),
  );
});
check('[25] celular: cards de negócio na largura toda', cards.every((d) => Math.abs(d) <= 1), cards);
await p.click('#cancelarEnvio');
check('[25] celular: o card fechado também cabe', (await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}9-celular-biblioteca.png` });
await p.setViewportSize({ width: 1280, height: 900 });

console.log('== 11. correção e reenvio continuam iguais ==');
const pecaMarca = PG(`SELECT id FROM criativos WHERE anunciante_id = ${prime.id}`);
const corr = await admin.request.patch(`${B}/admin/criativos/${pecaMarca}`, {
  data: { status: 'correcao', motivo_reprovacao: 'a categoria informada não corresponde à peça' },
});
check('admin pediu correção', corr.ok(), String(corr.status()));
const cardMarca = p.locator(`.criativo-card[data-id="${pecaMarca}"]`);
await esperar(async () => (await cardMarca.innerText()).includes('Correção necessária'), 10000);
check('[18] o card mostra "Correção necessária" com o motivo', /Correção necessária[\s\S]*categoria informada/.test(await cardMarca.innerText()));
await cardMarca.locator('[data-acao="reenviar"]').click();
const dlg = p.locator('dialog.dlg-confirmar');
await dlg.waitFor();
await dlg.screenshot({ path: `${SAIDA}10-modal-reenvio.png` });
check('[19] o reenvio pergunta quem a peça divulga, com o negócio atual marcado', (await dlg.innerText()).includes('Quem este anúncio divulga?'));
await dlg.locator('[data-confirmar]').click();
await esperar(async () => PG(`SELECT status FROM criativos WHERE id = ${pecaMarca}`) === 'pendente');
check('[19] reenviada: volta pra análise', PG(`SELECT status FROM criativos WHERE id = ${pecaMarca}`) === 'pendente');
await esperar(async () => (await cardMarca.innerText()).includes('Em análise'));
check('[19] o card volta a "Em análise"', (await cardMarca.innerText()).includes('Em análise'));

console.log('== 12. Prime 3/3: substituir esbarra no teto de cadastro, e o card avisa antes ==');
pecaAprovada(prime.id);
const terceira = pecaAprovada(prime.id);
await resync(p);
await esperar(async () => (await texto(p, '#contadorCriativos')) === '3 de 3 criativos utilizados');
check('[23] Prime 3/3: "3 de 3 criativos utilizados"', (await texto(p, '#contadorCriativos')) === '3 de 3 criativos utilizados', await texto(p, '#contadorCriativos'));
check('[23] Prime 3/3: "Substituir criativo" no lugar de "Enviar"', (await visivel(p, '#botaoSubstituirCriativo')) && !(await visivel(p, '#botaoEnviarCriativo')));
await p.click('#botaoSubstituirCriativo');
check(
  '[23] 3 guardados: o card explica o teto antes de pedir arquivo',
  /já guarda 3 criativos[\s\S]*Exclua um da biblioteca/.test(await texto(p, '#envioAviso')) && !(await visivel(p, '#etapaArquivo')) && !(await visivel(p, '#etapaAlvo')),
  await texto(p, '#envioAviso'),
);
check('[26] sem nada a fazer, o foco vai pro "Cancelar"', await p.evaluate(() => document.activeElement?.id === 'cancelarEnvio'));
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}10-prime-teto.png` });
await p.keyboard.press('Enter');
check('[26] Enter no "Cancelar" volta pra biblioteca', !(await visivel(p, '#envioCriativo')));
const rTeto = await p.evaluate(
  async ({ id, alvo }) => {
    const fd = new FormData();
    fd.append('arquivo', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('substitui', String(alvo));
    const r = await fetch(`/anunciantes/${id}/criativos`, { method: 'POST', credentials: 'include', body: fd });
    return `${r.status} ${(await r.json()).erro}`;
  },
  { id: prime.id, alvo: terceira },
);
check('[23] o servidor diz o mesmo (regra inalterada)', /^400 .*3 criativos cadastrados/.test(rTeto), rTeto);

console.log('== 13. excluir uma peça libera: volta o "Enviar criativo" ==');
await p.click(`.criativo-card[data-id="${terceira}"] [data-acao="excluir"]`);
await p.waitForSelector('dialog.dlg-confirmar[open]');
await p.click('dialog.dlg-confirmar [data-confirmar]');
await esperar(async () => (await texto(p, '#contadorCriativos')) === '2 de 3 criativos utilizados');
check('2 de 3: "+ Enviar criativo" de volta, sem aviso de limite', (await visivel(p, '#botaoEnviarCriativo')) && !(await visivel(p, '#avisoLimite')));
await p.locator('#modCriativos').screenshot({ path: `${SAIDA}11-prime-2-de-3.png` });

check('[24] sem erro de console nem diálogo nativo', erros.length === 0, erros.join(' | '));
await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
