const test = require('node:test');
const assert = require('node:assert');
const nodemailer = require('nodemailer');
const { gerarComprovante, TEXTO_OBRIGATORIO } = require('../src/financeiro/comprovante');

// E-mails transacionais (HTML + texto) e o comprovante de pagamento em PDF.
// Nada aqui fala com SMTP: o transporte é trocado por um que só guarda a
// mensagem montada.
const enviados = [];
const criarTransporteOriginal = nodemailer.createTransport;
nodemailer.createTransport = () => ({
  sendMail: async (m) => {
    enviados.push(m);
    return { messageId: 'teste' };
  },
});
test.after(() => {
  nodemailer.createTransport = criarTransporteOriginal;
});
const email = require('../src/financeiro/email');

const conta = {
  id: 1,
  nome_empresa: 'Padaria São João <script>alert(1)</script>',
  cpf_cnpj: '52998224725',
  contato_email: 'padaria@example.com',
};
const plano = { nome: 'Destaque', compromisso_meses: 3 };
const dadosComprovante = {
  cobrancaId: 42,
  confirmadoEm: '2026-09-25T13:05:00Z',
  valor: 267.3,
  plano,
  anunciante: conta,
};

test('comprovante: PDF válido (xref aponta pra cada objeto) e determinístico', () => {
  const { pdf, nomeArquivo } = gerarComprovante(dadosComprovante);
  const texto = pdf.toString('latin1');
  assert.strictEqual(nomeArquivo, 'comprovante-MST-000042.pdf');
  assert.ok(texto.startsWith('%PDF-1.4\n'));
  assert.ok(texto.endsWith('%%EOF\n'));
  const [, inicioXref] = texto.match(/startxref\n(\d+)\n%%EOF/);
  assert.strictEqual(texto.slice(Number(inicioXref), Number(inicioXref) + 4), 'xref');
  const entradas = texto
    .slice(Number(inicioXref))
    .split('\n')
    .filter((l) => / 00000 n $/.test(l));
  assert.strictEqual(entradas.length, 7);
  entradas.forEach((l, i) => {
    assert.strictEqual(texto.indexOf(`${i + 1} 0 obj\n`), Number(l.slice(0, 10)), `offset do objeto ${i + 1}`);
  });
  const [, tamanho] = texto.match(/<< \/Length (\d+) >>\nstream\n/);
  const inicioStream = texto.indexOf('stream\n') + 'stream\n'.length;
  assert.strictEqual(texto.indexOf('\nendstream'), inicioStream + Number(tamanho), '/Length confere');
  assert.ok(gerarComprovante(dadosComprovante).pdf.equals(pdf), 'mesma cobrança, mesmo documento');
});

test('comprovante: diz o que é, traz o texto obrigatório, e nunca se chama de nota fiscal', () => {
  const texto = gerarComprovante(dadosComprovante).pdf.toString('latin1');
  assert.ok(texto.includes('COMPROVANTE DE PAGAMENTO'));
  assert.ok(texto.includes('MST-000042'));
  assert.ok(texto.includes('267,30'));
  // O texto obrigatório sai quebrado em linhas; cada palavra está lá, na ordem.
  const corpo = texto.replace(/\) Tj ET\nBT [^(]*\(/g, ' ');
  const obrigatorio = Buffer.from(TEXTO_OBRIGATORIO, 'latin1').toString('latin1');
  assert.ok(corpo.includes(obrigatorio), 'texto obrigatório inteiro');
  assert.doesNotMatch(texto, /nota fiscal|nfs-e/i);
  assert.strictEqual((texto.match(/fiscal/gi) || []).length, 1, '"fiscal" só dentro do texto obrigatório');
});

test('comprovante: CPF mascarado; sem cobrança confirmada não existe comprovante', () => {
  const texto = gerarComprovante(dadosComprovante).pdf.toString('latin1');
  assert.ok(texto.includes('CPF ***.982.247-**'));
  assert.ok(!texto.includes('52998224725') && !texto.includes('529.982.247-25'));
  assert.throws(() => gerarComprovante({ ...dadosComprovante, cobrancaId: null }), /cobrança confirmada/);
  assert.throws(() => gerarComprovante({ ...dadosComprovante, valor: 0 }), /cobrança confirmada/);
});

test('pagamento confirmado: HTML + texto, comprovante em PDF anexado', async () => {
  enviados.length = 0;
  const r = await email.enviarConfirmacaoPagamento(conta, plano, 267.3, {
    id: 42,
    criado_em: '2026-09-25T13:05:00Z',
  });
  assert.deepStrictEqual(r, { comComprovante: true });
  const [m] = enviados;
  assert.strictEqual(m.subject, 'Pagamento confirmado — Mostraí');
  assert.ok(m.text.includes('R$ 267,30') && m.text.includes('comprovante de pagamento está anexado'));
  assert.ok(m.html.includes('Pagamento confirmado') && m.html.includes('<a href='));
  assert.strictEqual(m.attachments.length, 1);
  assert.strictEqual(m.attachments[0].filename, 'comprovante-MST-000042.pdf');
  assert.strictEqual(m.attachments[0].contentType, 'application/pdf');
  assert.ok(m.attachments[0].content.subarray(0, 8).toString('latin1').startsWith('%PDF-1.4'));

  enviados.length = 0;
  assert.deepStrictEqual(await email.enviarConfirmacaoPagamento(conta, plano, 267.3), { comComprovante: false });
  assert.strictEqual(enviados[0].attachments, undefined, 'sem cobrança, sem anexo — e o e-mail sai igual');
  assert.ok(!enviados[0].text.includes('anexado'));
});

test('HTML escapa o que veio do cadastro; o texto puro leva o mesmo conteúdo', () => {
  const m = email.mensagem({
    titulo: 'Título',
    saudacao: `Olá, ${conta.nome_empresa}!`,
    paragrafos: ['Um parágrafo.'],
    botao: { texto: 'Abrir', url: 'https://mostrai.example/x?a=1&b=2' },
  });
  assert.ok(!m.html.includes('<script>'));
  assert.ok(m.html.includes('&lt;script&gt;'));
  assert.ok(m.html.includes('href="https://mostrai.example/x?a=1&amp;b=2"'));
  assert.ok(m.text.includes('Abrir: https://mostrai.example/x?a=1&b=2'));
  assert.ok(m.text.includes('Um parágrafo.') && m.text.endsWith('Equipe Mostraí.'));
});

test('todo e-mail ao cliente sai em HTML e texto; os internos, só texto', async () => {
  enviados.length = 0;
  await email.enviarCobrancaFalhou(conta, 'https://checkout.example/renovar');
  await email.enviarCobrancaFalhou(conta, null);
  await email.enviarCoberturaAcabando(conta, plano, 3);
  await email.enviarContaReativada(conta);
  await email.enviarContaCriada(conta);
  await email.enviarContaExcluida(conta);
  await email.enviarTrocaDePlano(conta, { nome: 'Essencial' }, plano, { cobrado: true, valor: 40.5 });
  await email.enviarCancelamento(conta, plano);
  await email.enviarCodigoConfirmacaoEmail(conta, '123456');
  await email.enviarLinkRedefinicaoSenha(conta.contato_email, 'Fulano', 'https://mostrai.example/senha?t=abc');
  await email.enviarCriativoReprovado(conta, { motivo_reprovacao: 'texto ilegível' });
  await email.enviarCriativoNoAr(conta, { duracao_segundos: 15 });
  await email.enviarArrependimentoRecebido(conta, { id: 7, valor_a_estornar: 267.3 });
  await email.enviarNovidade(conta, { assunto: 'Novidade', texto: 'Texto.' });
  assert.strictEqual(enviados.length, 14);
  for (const m of enviados) {
    assert.ok(m.text && m.html, `${m.subject}: HTML e texto`);
    assert.ok(m.html.startsWith('<!doctype html>'), m.subject);
    assert.ok(!m.html.includes('<script>'), `${m.subject}: nome escapado`);
  }
  assert.ok(enviados[8].html.includes('123456') && enviados[8].text.includes('123456'), 'código visível nos dois');

  enviados.length = 0;
  await email.enviarMensagemContato({ nome: 'A', email: 'a@example.com', telefone: '', mensagem: 'oi' });
  await email.enviarCandidaturaNova({ tipo: 'ponto', nome: 'B', contato_telefone: '1' });
  for (const m of enviados) assert.ok(m.text && !m.html, `${m.subject}: interno, só texto`);
});
