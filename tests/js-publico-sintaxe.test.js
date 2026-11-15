const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Todo JavaScript servido em public/ é script clássico, sem build: um erro de
// sintaxe derruba o arquivo inteiro no navegador (ex.: `const` declarado duas
// vezes no mesmo escopo, que o lint não pega) e nenhum teste de servidor vê.
// Aqui cada arquivo é só compilado — nada roda.

function arquivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return arquivos(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

const PUBLICO = path.join(__dirname, '..', 'public');

test('todo .js de public/ compila (sem erro de sintaxe)', () => {
  const lista = arquivos(PUBLICO);
  assert.ok(lista.length > 10);
  const ruins = [];
  for (const arquivo of lista) {
    try {
      new vm.Script(fs.readFileSync(arquivo, 'utf8'), { filename: arquivo });
    } catch (err) {
      ruins.push(`${path.relative(PUBLICO, arquivo)}: ${err.message}`);
    }
  }
  assert.deepEqual(ruins, []);
});
