const test = require('node:test');
const assert = require('node:assert');
const { calcularPlaylist, contarPorAnunciante, pedidoDaHora, LIMITE_SLOTS_PROGRAMADOS } = require('../src/lib/pacing');

test('aplica a frequência base sem déficit', () => {
  const itens = calcularPlaylist([{ id: 1, frequenciaBase: 3, deficit: 0 }]);
  assert.strictEqual(itens.length, 3);
  assert.strictEqual(contarPorAnunciante(itens)[1], 3);
});

test('compensa quem ficou devendo na hora anterior', () => {
  const itens = calcularPlaylist([{ id: 1, frequenciaBase: 3, deficit: 2 }]);
  assert.strictEqual(contarPorAnunciante(itens)[1], 5);
});

test('trava de segurança nunca deixa passar do limite de slots', () => {
  const anunciantes = Array.from({ length: 50 }, (_, i) => ({ id: i, frequenciaBase: 12, deficit: 0 }));
  const itens = calcularPlaylist(anunciantes);
  assert.ok(itens.length <= LIMITE_SLOTS_PROGRAMADOS);
});

const { dividirCota } = require('../src/lib/pacing');

test('cota de autoanúncio do ponto é dividida entre as telas', () => {
  assert.strictEqual(dividirCota(6, 2), 3);
  assert.strictEqual(dividirCota(6, 4), 2, 'arredonda pra cima');
  assert.strictEqual(dividirCota(6, 1), 6);
  assert.strictEqual(dividirCota(0, 3), 0, 'cota zero continua zero');
  assert.strictEqual(dividirCota(5, 0), 5, 'sem tela ativa conta como uma');
});

test('dono do ponto entra na playlist como item próprio sem virar anunciante', () => {
  const itens = calcularPlaylist([
    { id: 1, frequenciaBase: 2, deficit: 0 },
    { id: 'dono', frequenciaBase: 3, deficit: 0 },
  ]);
  const contagem = contarPorAnunciante(itens);
  assert.strictEqual(contagem[1], 2);
  assert.strictEqual(contagem.dono, 3);
});

// Teto de criativos em rotação — regra do inventário, mexida em 14/09/2026
// quando a conta própria do Mostraí passou a existir (migration 023).
const { limiteDeCriativos } = require('../src/playlist/gerador');

test('conta própria não tem teto de criativos; quem paga plano tem', () => {
  assert.strictEqual(limiteDeCriativos(true, null, 12), 12, 'própria roda tudo que subiu');
  assert.strictEqual(limiteDeCriativos(true, 1, 7), 7, 'própria ignora até limite herdado');
  assert.strictEqual(limiteDeCriativos(false, 2, 9), 2, 'plano manda');
  assert.strictEqual(limiteDeCriativos(false, 99, 99), 3, 'teto duro de 3 protege contra zero a mais no admin');
  assert.strictEqual(limiteDeCriativos(false, 0, 5), 1, 'sem plano válido, libera 1');
  assert.strictEqual(limiteDeCriativos(false, null, 5), 1);
});

// Teto de 200 slots: o corte tem que ser proporcional, nao sorteio. Antes era
// um `slice` na lista ja embaralhada — quem caisse depois do item 200 perdia a
// hora inteira, e quem perdia era sorte.
test('teto corta proporcionalmente, nao por sorteio', () => {
  const anunciantes = [
    { id: 'grande', frequenciaBase: 300, deficit: 0 },
    { id: 'medio', frequenciaBase: 100, deficit: 0 },
    { id: 'pequeno', frequenciaBase: 100, deficit: 0 },
  ];
  const itens = calcularPlaylist(anunciantes);
  assert.equal(itens.length, LIMITE_SLOTS_PROGRAMADOS);
  const contagem = contarPorAnunciante(itens);
  // 500 pedidos pra 200 slots = 40% de cada um, com sobra pros maiores restos.
  assert.ok(contagem.grande >= 119 && contagem.grande <= 121, `grande ficou com ${contagem.grande}`);
  assert.ok(contagem.medio >= 39 && contagem.medio <= 41, `medio ficou com ${contagem.medio}`);
  assert.ok(contagem.pequeno >= 39 && contagem.pequeno <= 41, `pequeno ficou com ${contagem.pequeno}`);
});

test('ninguem some da hora so porque a rede encheu', () => {
  const anunciantes = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, frequenciaBase: 3, deficit: 0 }));
  const contagem = contarPorAnunciante(calcularPlaylist(anunciantes));
  // 300 pedidos, 200 slots: cada um fica com 0 ou 1 — mas 200 dos 300 entram,
  // e o teste garante que a distribuicao nao zera ninguem sistematicamente.
  const comZero = anunciantes.filter((a) => !contagem[a.id]).length;
  assert.equal(comZero, 0, `${comZero} anunciantes ficaram sem nenhuma exibicao`);
});

test('pedidoDaHora diz quando a hora apertou', () => {
  const folga = pedidoDaHora([{ id: 1, frequenciaBase: 10, deficit: 0 }]);
  assert.equal(folga.cortou, false);
  assert.equal(folga.cabe, 10);
  const aperto = pedidoDaHora([{ id: 1, frequenciaBase: 500, deficit: 0 }]);
  assert.equal(aperto.cortou, true);
  assert.equal(aperto.cabe, LIMITE_SLOTS_PROGRAMADOS);
});
