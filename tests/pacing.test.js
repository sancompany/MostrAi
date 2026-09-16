const test = require('node:test');
const assert = require('node:assert');
const {
  montarHoraDeTv,
  contarPorAnunciante,
  dividirCota,
  duracaoValida,
  SEGUNDOS_DA_HORA,
  DURACAO_INSTITUCIONAL,
  DURACAO_PADRAO,
  ID_INSTITUCIONAL,
} = require('../src/lib/pacing');

const pagos = (itens) => itens.filter((i) => i !== ID_INSTITUCIONAL);

test('a frequência vendida é a frequência entregue, com a rede vazia', () => {
  // Era o furo: um anunciante só, o player dava 60 voltas na lista e entregava
  // 180 exibições de um plano de 3. Agora a hora é orçada em segundos.
  const hora = montarHoraDeTv([{ id: 1, frequenciaBase: 3, deficit: 0, duracaoSegundos: 20 }]);
  assert.strictEqual(hora.programados[1], 3);
  assert.strictEqual(pagos(hora.itens).length, 3, 'só 3 exibições pagas na hora inteira');
  assert.strictEqual(hora.segundosContratados, 60);
});

test('a hora é preenchida até os 3600s com a peça institucional', () => {
  const hora = montarHoraDeTv([{ id: 1, frequenciaBase: 3, deficit: 0, duracaoSegundos: 20 }]);
  assert.strictEqual(hora.qtdInstitucional, (SEGUNDOS_DA_HORA - 60) / DURACAO_INSTITUCIONAL);
  assert.strictEqual(
    hora.segundosContratados + hora.segundosInstitucionais,
    SEGUNDOS_DA_HORA,
    'a hora fecha exatamente',
  );
});

test('a frequência não muda quando a rede enche — é o mesmo plano', () => {
  const sozinho = montarHoraDeTv([{ id: 1, frequenciaBase: 3, deficit: 0, duracaoSegundos: 20 }]);
  const acompanhado = montarHoraDeTv([
    { id: 1, frequenciaBase: 3, deficit: 0, duracaoSegundos: 20 },
    { id: 2, frequenciaBase: 6, deficit: 0, duracaoSegundos: 20 },
    { id: 3, frequenciaBase: 12, deficit: 0, duracaoSegundos: 20 },
  ]);
  assert.strictEqual(sozinho.programados[1], 3);
  assert.strictEqual(acompanhado.programados[1], 3, 'o Essencial entrega 3 nos dois casos');
  assert.strictEqual(acompanhado.programados[2], 6);
  assert.strictEqual(acompanhado.programados[3], 12);
});

test('a escada de preço vale em número absoluto, não só em proporção', () => {
  const hora = montarHoraDeTv([
    { id: 'essencial', frequenciaBase: 3, deficit: 0, duracaoSegundos: 20 },
    { id: 'maximo', frequenciaBase: 12, deficit: 0, duracaoSegundos: 20 },
  ]);
  assert.strictEqual(hora.programados.maximo / hora.programados.essencial, 4, '12x custa 4x mais e entrega 4x mais');
});

test('compensa quem ficou devendo na hora anterior', () => {
  const hora = montarHoraDeTv([{ id: 1, frequenciaBase: 3, deficit: 2, duracaoSegundos: 20 }]);
  assert.strictEqual(hora.programados[1], 5);
});

test('a hora nunca passa de 3600 segundos, nem com vídeo de 30s', () => {
  // O teto antigo era 200 SLOTS. Com vídeo de 30s isso dava 6000 segundos numa
  // hora de 3600: metade do programado não cabia e virava déficit eterno.
  const anunciantes = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    frequenciaBase: 12,
    deficit: 0,
    duracaoSegundos: 30,
  }));
  const hora = montarHoraDeTv(anunciantes);
  assert.ok(hora.cortou, 'a rede cheia aperta a hora');
  assert.ok(hora.segundosContratados <= SEGUNDOS_DA_HORA, `usou ${hora.segundosContratados}s`);
  assert.strictEqual(hora.qtdInstitucional, 0, 'hora vendida não tem espaço vago');
});

test('quando aperta, o corte é proporcional e ninguém some da hora', () => {
  const hora = montarHoraDeTv([
    { id: 'grande', frequenciaBase: 300, deficit: 0, duracaoSegundos: 20 },
    { id: 'medio', frequenciaBase: 100, deficit: 0, duracaoSegundos: 20 },
    { id: 'pequeno', frequenciaBase: 100, deficit: 0, duracaoSegundos: 20 },
  ]);
  assert.ok(hora.cortou);
  // 500 pedidos de 20s = 10000s pra uma hora de 3600s: 36% de cada um.
  assert.ok(hora.programados.grande >= 107 && hora.programados.grande <= 109, `${hora.programados.grande}`);
  assert.ok(hora.programados.medio >= 35 && hora.programados.medio <= 37, `${hora.programados.medio}`);
  assert.ok(hora.programados.pequeno >= 35 && hora.programados.pequeno <= 37, `${hora.programados.pequeno}`);
});

test('rede lotada não zera ninguém sistematicamente', () => {
  const anunciantes = Array.from({ length: 300 }, (_, i) => ({
    id: i + 1,
    frequenciaBase: 3,
    deficit: 0,
    duracaoSegundos: 20,
  }));
  const hora = montarHoraDeTv(anunciantes);
  const comExibicao = Object.keys(hora.programados).length;
  assert.ok(comExibicao >= 170, `só ${comExibicao} anunciantes entraram na hora`);
});

test('as exibições são espalhadas pela hora, não amontoadas', () => {
  // Três vezes por hora amontoadas em cinco minutos não é três vezes por hora.
  const hora = montarHoraDeTv([{ id: 1, frequenciaBase: 3, deficit: 0, duracaoSegundos: 20 }]);
  const posicoes = hora.itens.map((id, i) => (id === 1 ? i : -1)).filter((i) => i >= 0);
  assert.strictEqual(posicoes.length, 3);
  const total = hora.itens.length;
  // Com 3 exibições espalhadas, a distância entre elas fica perto de um terço
  // da hora. Tolerância larga de propósito: o teste é sobre não amontoar.
  const vaos = [posicoes[1] - posicoes[0], posicoes[2] - posicoes[1]];
  for (const v of vaos) assert.ok(v > total / 5, `exibições amontoadas: vão de ${v} em ${total} itens`);
});

test('criativo sem duração declarada entra com a duração padrão', () => {
  assert.strictEqual(duracaoValida(undefined), DURACAO_PADRAO);
  assert.strictEqual(duracaoValida(0), DURACAO_PADRAO, 'zero não pode virar hora infinita');
  assert.strictEqual(duracaoValida(-5), DURACAO_PADRAO);
  assert.strictEqual(duracaoValida(1), DURACAO_PADRAO, 'abaixo do piso, usa o padrão');
  assert.strictEqual(duracaoValida(25), 25);
});

test('quem tem frequência zero não ocupa a hora', () => {
  const hora = montarHoraDeTv([
    { id: 1, frequenciaBase: 0, deficit: 0, duracaoSegundos: 20 },
    { id: 2, frequenciaBase: 2, deficit: 0, duracaoSegundos: 20 },
  ]);
  assert.strictEqual(hora.programados[1], undefined);
  assert.strictEqual(hora.programados[2], 2);
});

test('hora sem nenhum anunciante é hora institucional inteira', () => {
  const hora = montarHoraDeTv([]);
  assert.strictEqual(hora.segundosContratados, 0);
  assert.strictEqual(hora.itens.length, SEGUNDOS_DA_HORA / DURACAO_INSTITUCIONAL);
  assert.ok(hora.itens.every((i) => i === ID_INSTITUCIONAL));
});

test('ocupação diz quanto da hora está vendido', () => {
  const vazia = montarHoraDeTv([{ id: 1, frequenciaBase: 3, deficit: 0, duracaoSegundos: 20 }]);
  assert.strictEqual(vazia.ocupacao, 2, '60s de 3600 = 2%');
  const cheia = montarHoraDeTv([{ id: 1, frequenciaBase: 180, deficit: 0, duracaoSegundos: 20 }]);
  assert.strictEqual(cheia.ocupacao, 100);
});

test('dono do ponto entra na hora sem virar anunciante pagante', () => {
  const hora = montarHoraDeTv([
    { id: 1, frequenciaBase: 2, deficit: 0, duracaoSegundos: 20 },
    { id: 'dono', frequenciaBase: 3, deficit: 0, duracaoSegundos: 20 },
  ]);
  assert.strictEqual(hora.programados[1], 2);
  assert.strictEqual(hora.programados.dono, 3);
  assert.strictEqual(contarPorAnunciante(hora.itens)[ID_INSTITUCIONAL], hora.qtdInstitucional);
});

test('cota de autoanúncio do ponto é dividida entre as telas', () => {
  assert.strictEqual(dividirCota(6, 2), 3);
  assert.strictEqual(dividirCota(6, 4), 2, 'arredonda pra cima');
  assert.strictEqual(dividirCota(6, 1), 6);
  assert.strictEqual(dividirCota(0, 3), 0, 'cota zero continua zero');
  assert.strictEqual(dividirCota(5, 0), 5, 'sem tela ativa conta como uma');
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
