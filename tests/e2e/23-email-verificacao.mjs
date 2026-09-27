// Estação de e-mail (27/09/2026), no navegador:
//   · o modal "Confirme seu e-mail" mostra o prazo que o SERVIDOR deu, e
//     recarregar a página não reinicia o relógio;
//   · "Corrigir e-mail" (com a senha) troca o endereço e o código chega no
//     endereço certo; confirmar fecha o modal;
//   · no perfil, trocar o e-mail de uma conta confirmada: o login só muda
//     depois do código;
//   · formulários de cadastro/login/senha com o autocomplete certo (e-mail
//     como usuário; telefone como tel) — o que faz o gerenciador de senhas
//     não salvar o telefone como usuário;
//   · celular (375) sem rolagem lateral, sem erro no console.
// Nenhum e-mail sai: o servidor dos roteiros grava em saida/emails.jsonl
// (EMAIL_CAPTURA, restart.sh). As contas criadas são apagadas no fim.
// Assume servidor na 3999 e o banco do .env.
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';
import { codigoPara, emailsPara } from './emails.mjs';
import { execSync } from 'node:child_process';

const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const falhas = [];
const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const shot = (p, n) =>
  p.screenshot({ path: new URL(`./saida/email-${n}.png`, import.meta.url).pathname, fullPage: false });

const senha = 'Senha123!';
const marca = Date.now();
const criadas = [];

async function contexto(largura = 1366) {
  const ctx = await b.newContext({ viewport: { width: largura, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (400|401|404|409|429)/.test(m.text())) erros.push(`console: ${m.text()}`);
  });
  return p;
}

async function cadastrar(p, email) {
  await irQuieto(p, `${B}/anunciante/cadastro.html`);
  const r = await p.evaluate(
    async ({ email, senha }) => {
      const resp = await fetch('/anunciantes/cadastro', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome_empresa: 'Padaria do E-mail',
          cpf_cnpj: '52998224725',
          contato_email: email,
          contato_telefone: '16999998888',
          senha,
          aceitou_termos: true,
          cep: '15990000',
          logradouro: 'Rua Teste',
          numero: '123',
          bairro: 'Centro',
          cidade: 'Matão',
          uf: 'SP',
        }),
      });
      return { status: resp.status, corpo: await resp.json() };
    },
    { email, senha },
  );
  if (r.status !== 201) throw new Error(`cadastro: ${r.status} ${JSON.stringify(r.corpo)}`);
  criadas.push(r.corpo.id);
  return r.corpo;
}

const segundos = (texto) => {
  const m = String(texto).match(/(\d+):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

console.log('== autocomplete dos formulários ==');
{
  const p = await contexto();
  await irQuieto(p, `${B}/anunciante/cadastro.html`);
  check(
    'cadastro: e-mail é o usuário',
    (await p.getAttribute('#contato_email', 'autocomplete')) === 'username' &&
      (await p.getAttribute('#contato_email', 'type')) === 'email',
  );
  check('cadastro: telefone é tel', (await p.getAttribute('#contato_telefone', 'autocomplete')) === 'tel');
  check('cadastro: senha é nova', (await p.getAttribute('#senha', 'autocomplete')) === 'new-password');
  await irQuieto(p, `${B}/anunciante/login.html`);
  check('login: usuário + senha atual', (await p.getAttribute('#email', 'autocomplete')) === 'username');
  check('login: senha atual', (await p.getAttribute('#senha', 'autocomplete')) === 'current-password');
  await irQuieto(p, `${B}/esqueci-senha.html`);
  check('esqueci a senha: e-mail é o usuário', (await p.getAttribute('#email', 'autocomplete')) === 'username');
  await p.context().close();
}

console.log('== cadastro: modal com o prazo do servidor; recarregar não reinicia ==');
const errado = `errado-${marca}@teste.com`;
const certo = `certo-${marca}@teste.com`;
const p = await contexto();
const conta = await cadastrar(p, errado);
check('no cadastro sai só o código', PG(`SELECT string_agg(tipo, ',') FROM email_outbox WHERE anunciante_id = ${conta.id}`) === 'codigo_confirmacao');
await codigoPara(errado);
check('o primeiro código chega sem reenviar', emailsPara(errado).length === 1);
await irQuieto(p, `${B}/anunciante/painel.html`);
await p.waitForSelector('.modal-email #expiraEmail:not(:empty)');
await p.waitForTimeout(600);
const antes = segundos(await p.textContent('#expiraEmail'));
check('relógio perto de 10 min', antes > 9 * 60 && antes <= 600, String(antes));
check('modal mostra o e-mail do cadastro', (await p.textContent('#emailConfirmar')) === errado);
await shot(p, 'modal');
await p.waitForTimeout(2500);
await p.reload();
await p.waitForSelector('.modal-email #expiraEmail:not(:empty)');
await p.waitForTimeout(600);
const depois = segundos(await p.textContent('#expiraEmail'));
check('recarregar não reinicia o prazo', depois !== null && depois < antes, `${antes} → ${depois}`);

console.log('== corrigir e-mail antes de confirmar ==');
await p.click('#btnCorrigirEmail');
check('formulário de correção aparece', await p.isVisible('#formCorrigirEmail'));
check(
  'correção: campos com autocomplete certo',
  (await p.getAttribute('#novoEmailCadastro', 'autocomplete')) === 'username' &&
    (await p.getAttribute('#senhaCorrigirEmail', 'autocomplete')) === 'current-password',
);
await p.fill('#novoEmailCadastro', certo);
await p.fill('#senhaCorrigirEmail', 'senha-errada');
await p.click('#formCorrigirEmail button[type=submit]');
await p.waitForFunction(() => document.querySelector('#msgConfirmarEmail').classList.contains('err'));
check('senha errada recusada', /senha/i.test(await p.textContent('#msgConfirmarEmail')));
await p.fill('#senhaCorrigirEmail', senha);
await p.click('#formCorrigirEmail button[type=submit]');
await p.waitForFunction(() => document.querySelector('#msgConfirmarEmail').classList.contains('ok'));
check('volta pro código com o endereço novo', (await p.textContent('#emailConfirmar')) === certo);
const codigo = await codigoPara(certo);
await p.fill('#codigoConfirmarEmail', codigo);
await p.click('#formConfirmarEmail button[type=submit]');
await p.waitForSelector('.modal-email', { state: 'detached', timeout: 5000 });
check('código certo fecha o modal', !(await p.$('.modal-email')));
check('conta confirmada, com o e-mail certo', PG(`SELECT contato_email || '|' || email_confirmado FROM anunciantes WHERE id = ${conta.id}`) === `${certo}|true`);
await new Promise((r) => setTimeout(r, 800));
check('boas-vindas só depois de confirmar', emailsPara(certo).some((m) => /foi criada/i.test(m.subject)));
check('nenhuma boas-vindas pro endereço errado', !emailsPara(errado).some((m) => /foi criada/i.test(m.subject)));

console.log('== trocar e-mail depois de confirmado (perfil) ==');
const novo = `novo-${marca}@teste.com`;
await p.evaluate(() => document.getElementById('dlgPerfil').showModal());
await p.click('#blocoTrocarEmail summary');
await p.fill('#novoEmailAcesso', novo);
await p.fill('#senhaTrocarEmail', senha);
await p.click('#formTrocarEmail button[type=submit]');
await p.waitForSelector('#formConfirmarTroca:not([hidden])');
check('login continua o antigo até o código', PG(`SELECT contato_email FROM anunciantes WHERE id = ${conta.id}`) === certo);
check('prazo da troca na tela', /Expira em/.test(await p.textContent('#expiraTroca')));
await shot(p, 'troca-pendente');
await p.fill('#codigoTroca', await codigoPara(novo));
await p.click('#formConfirmarTroca button[type=submit]');
await p.waitForFunction(() => document.querySelector('#msgTrocarEmail').classList.contains('ok'));
check('e-mail de acesso atualizado na tela', (await p.inputValue('#emailFixo')) === novo);
check('login agora é o novo', PG(`SELECT contato_email FROM anunciantes WHERE id = ${conta.id}`) === novo);
await new Promise((r) => setTimeout(r, 800));
check('um diálogo de perfil só, mesmo com o painel recarregando por SSE', (await p.$$('#dlgPerfil')).length === 1);
check('endereço antigo avisado', emailsPara(certo).some((m) => /e-mail da sua conta foi alterado/i.test(m.subject)));
await p.context().close();

console.log('== celular (375): modal sem rolagem lateral ==');
{
  const cel = await contexto(375);
  const outra = `cel-${marca}@teste.com`;
  await cadastrar(cel, outra);
  await irQuieto(cel, `${B}/anunciante/painel.html`);
  await cel.waitForSelector('.modal-email #expiraEmail:not(:empty)');
  const sobra = await cel.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('sem rolagem lateral', sobra <= 0, String(sobra));
  await cel.click('#btnCorrigirEmail');
  const sobraForm = await cel.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('formulário de correção cabe', sobraForm <= 0, String(sobraForm));
  await shot(cel, 'celular-corrigir');
  await cel.context().close();
}

console.log('== limpeza ==');
for (const id of criadas) {
  PG(`DELETE FROM email_outbox WHERE anunciante_id = ${id};
      DELETE FROM notificacoes WHERE anunciante_id = ${id};
      DELETE FROM eventos WHERE anunciante_id = ${id};
      DELETE FROM anunciantes WHERE id = ${id}`);
}
check('contas do roteiro apagadas', PG(`SELECT COUNT(*) FROM anunciantes WHERE id IN (${criadas.join(',')})`) === '0');
check('sem erro no console', erros.length === 0, erros.join(' | '));

await b.close();
console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO OK');
process.exit(falhas.length ? 1 : 0);
