const test = require('node:test');
const assert = require('node:assert');

const { validarCpf, validarCnpj, validarCpfOuCnpj, formatar } = require('../src/br/documento');
const { reais, data, compararTexto, telefoneE164, telefoneExibicao, cepValido } = require('../src/br/formato');

test('CPF confere pelo dígito verificador', () => {
  assert.strictEqual(validarCpf('111.444.777-35'), true, 'CPF válido conhecido');
  assert.strictEqual(validarCpf('111.444.777-36'), false, 'dígito trocado');
  assert.strictEqual(validarCpf('111.111.111-11'), false, 'sequência repetida passa no módulo 11 por acidente');
  assert.strictEqual(validarCpf('1114447773'), false, 'curto demais');
});

// A parte que mais importa: CNPJ é alfanumérico desde julho/2026. Um validador
// só numérico recusaria toda empresa aberta de lá pra cá.
test('CNPJ alfanumérico é aceito, e o numérico continua valendo', () => {
  assert.strictEqual(validarCnpj('11.222.333/0001-81'), true, 'CNPJ numérico válido');
  assert.strictEqual(validarCnpj('11.222.333/0001-82'), false, 'dígito trocado');
  assert.strictEqual(validarCnpj('12.ABC.345/01DE-35'), true, 'CNPJ alfanumérico da NT da Receita');
  assert.strictEqual(validarCnpj('12.ABC.345/01DE-36'), false, 'alfanumérico com dígito trocado');
  assert.strictEqual(validarCnpj('AA.AAA.AAA/AAAA-AA'), false, 'verificador não pode ser letra');
});

test('campo único decide entre CPF e CNPJ pelo tamanho', () => {
  assert.strictEqual(validarCpfOuCnpj('111.444.777-35'), null);
  assert.strictEqual(validarCpfOuCnpj('11.222.333/0001-81'), null);
  assert.ok(validarCpfOuCnpj('123'), 'tamanho fora recusa com mensagem');
  assert.ok(validarCpfOuCnpj('111.444.777-36'), 'CPF inválido recusa com mensagem');
});

test('formatação devolve a máscara conhecida', () => {
  assert.strictEqual(formatar('11144477735'), '111.444.777-35');
  assert.strictEqual(formatar('11222333000181'), '11.222.333/0001-81');
});

test('dinheiro e data saem no formato de casa, no fuso de Brasília', () => {
  assert.match(reais('149.00'), /R\$\s?149,00/);
  assert.match(reais(0), /R\$\s?0,00/);
  // 01/01/2026 00:30 UTC é 31/12/2025 21:30 em Brasília — sem timeZone
  // explícito esta data aparece como 01/01 e o dono do ponto vê o dia errado.
  assert.strictEqual(data('2026-01-01T00:30:00Z'), '31/12/2025');
});

test('ordenação respeita acento', () => {
  const nomes = ['Zulmira', 'Ágata', 'Bruno'].sort(compararTexto);
  assert.deepStrictEqual(nomes, ['Ágata', 'Bruno', 'Zulmira']);
});

test('telefone guarda em E.164 e exibe no formato local', () => {
  assert.strictEqual(telefoneE164('(16) 99463-5946'), '+5516994635946');
  assert.strictEqual(telefoneE164('+55 16 99463-5946'), '+5516994635946');
  assert.strictEqual(telefoneE164('123'), null);
  assert.strictEqual(telefoneExibicao('+5516994635946'), '(16) 99463-5946');
});

test('CEP confere o formato', () => {
  assert.strictEqual(cepValido('15990-000'), true);
  assert.strictEqual(cepValido('1599-000'), false);
});

// Data pura (coluna `date`) é dia de calendário, não instante. Passar pelo
// fuso volta um dia inteiro sempre que o servidor roda em UTC — que é o caso
// em produção. A competência 2026-09-01 do extrato do ponto saía como 08/2026.
test('data pura não anda um dia pra trás no fuso', () => {
  assert.equal(data('2026-09-01'), '01/09/2026');
  assert.equal(data('2026-01-01'), '01/01/2026');
  assert.equal(data('2026-12-31'), '31/12/2026');
});

test('data com hora continua respeitando o fuso de São Paulo', () => {
  // 14:00 UTC é 11:00 em São Paulo, mesmo dia.
  assert.equal(data('2026-09-05T14:00:00.000Z'), '05/09/2026');
  // 02:00 UTC é 23:00 do dia anterior em São Paulo — e aqui isso é correto.
  assert.equal(data('2026-09-05T02:00:00.000Z'), '04/09/2026');
});
