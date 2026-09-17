const test = require('node:test');
const assert = require('node:assert');
const {
  montarHoraDeTv,
  pontosDoAnunciante,
  contarPorAnunciante,
  dividirCota,
  duracaoValida,
  SEGUNDOS_DA_HORA,
  segundosCompensados,
  TETO_COMPENSACAO_SEGUNDOS,
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

// ---------------------------------------------------------------------------
// Cobertura por pontos — o plano dá acesso a N pontos e o contratante escolhe.
// ---------------------------------------------------------------------------
const REDE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test('plano sem teto de pontos cobre a rede inteira', () => {
  assert.deepStrictEqual(pontosDoAnunciante({ id: 7, pontosIncluidos: null }, REDE), REDE);
});

test('a escolha do contratante é respeitada', () => {
  assert.deepStrictEqual(pontosDoAnunciante({ id: 7, pontosIncluidos: 3, escolhidos: [2, 5] }, REDE), [2, 5]);
});

test('escolher mais do que o plano dá não fura o teto', () => {
  const r = pontosDoAnunciante({ id: 7, pontosIncluidos: 3, escolhidos: [1, 2, 3, 4, 5] }, REDE);
  assert.strictEqual(r.length, 3);
});

test('quem não escolhe recebe uma fatia, e ela é estável', () => {
  const a = pontosDoAnunciante({ id: 7, pontosIncluidos: 3 }, REDE);
  const b = pontosDoAnunciante({ id: 7, pontosIncluidos: 3 }, REDE);
  assert.strictEqual(a.length, 3);
  assert.deepStrictEqual(a, b, 'o anúncio não pode pular de comércio a cada hora');
});

test('contas diferentes caem em pontos diferentes', () => {
  const a = pontosDoAnunciante({ id: 7, pontosIncluidos: 3 }, REDE);
  const b = pontosDoAnunciante({ id: 8, pontosIncluidos: 3 }, REDE);
  assert.notDeepStrictEqual(a, b, 'sorteio estável não pode ser sorteio igual pra todo mundo');
});

test('ponto que saiu de operação não gasta vaga de ninguém', () => {
  // Escolheu um ponto que fechou: cai no sorteio em vez de ficar sem nada.
  const r = pontosDoAnunciante({ id: 7, pontosIncluidos: 3, escolhidos: [99] }, REDE);
  assert.strictEqual(r.length, 3);
  assert.ok(r.every((id) => REDE.includes(id)));
});

test('rede menor que o plano não quebra — cobre o que existe', () => {
  const r = pontosDoAnunciante({ id: 7, pontosIncluidos: 10 }, [1, 2, 3]);
  assert.strictEqual(r.length, 3, 'plano de 10 pontos numa rede de 3 cobre os 3');
});

test('rede vazia devolve lista vazia, não explode', () => {
  assert.deepStrictEqual(pontosDoAnunciante({ id: 7, pontosIncluidos: 3 }, []), []);
});

// ---------------------------------------------------------------------------
// Playlist determinística — o que permite rodar em mais de uma instância
// (item 4, 17/09/2026). Era `Math.random()` mais um cache em memória do
// processo; o cache é justamente o que não sobrevive a duas instâncias.
// ---------------------------------------------------------------------------
const contas = () => [
  { id: 1, frequenciaBase: 6, deficit: 0, duracaoSegundos: 15 },
  { id: 2, frequenciaBase: 4, deficit: 0, duracaoSegundos: 20 },
  { id: 3, frequenciaBase: 3, deficit: 0, duracaoSegundos: 30 },
];

test('mesma semente monta a hora exatamente igual (duas instâncias combinam)', () => {
  const a = montarHoraDeTv(contas(), 'tela-7-2026-09-17T14:00:00.000Z');
  const b = montarHoraDeTv(contas(), 'tela-7-2026-09-17T14:00:00.000Z');
  assert.deepStrictEqual(a.itens, b.itens);
  assert.deepStrictEqual(a.programados, b.programados);
});

// ACHADO ao escrever este teste, e vale registrar porque contraria a
// intuição: o sorteio quase NÃO muda a hora. Quem define a ordem é o
// espalhamento (`espalhar`), que coloca cada anunciante nas posições ideais a
// partir da quantidade — resultado igual para a mesma quantidade, venha a
// lista na ordem que vier. O sorteio só decide DESEMPATE entre contas com a
// mesma quantidade de inserções.
//
// Ou seja: o `Math.random()` que estava aqui antes já quase não fazia
// diferença, e o cache em memória protegia uma variação que mal existia. Isso
// é bom para o item 4 (menos coisa muda entre instâncias), mas o teste tem
// que afirmar o que é verdade, não o que eu esperava.
test('o sorteio desempata contas de mesma quantidade, e só isso', () => {
  const empatadas = () => [
    { id: 1, frequenciaBase: 4, deficit: 0, duracaoSegundos: 15 },
    { id: 2, frequenciaBase: 4, deficit: 0, duracaoSegundos: 15 },
    { id: 3, frequenciaBase: 4, deficit: 0, duracaoSegundos: 15 },
  ];
  const ordens = new Set(
    ['tela-1-h9', 'tela-1-h10', 'tela-2-h9', 'tela-3-h14', 'tela-9-h21'].map((s) =>
      JSON.stringify(montarHoraDeTv(empatadas(), s).itens),
    ),
  );
  assert.ok(ordens.size > 1, 'com quantidades empatadas, sementes diferentes devem variar a ordem');

  // Sem empate, a ordem é a mesma em qualquer tela — é o espalhamento
  // mandando, e é o comportamento desejado: cada um nas suas posições ideais.
  assert.deepStrictEqual(montarHoraDeTv(contas(), 'tela-1-h9').itens, montarHoraDeTv(contas(), 'tela-2-h22').itens);
});

// O contador gravado tem que ser o mesmo em qualquer regeração: `gravarProgramados`
// faz `DO UPDATE SET` (não incrementa), então valor instável viraria número
// que muda sozinho no painel do anunciante entre um poll e outro.
test('regerar a mesma hora não muda o que foi programado', () => {
  const semente = 'tela-1-2026-09-17T09:00:00.000Z';
  const primeira = montarHoraDeTv(contas(), semente).programados;
  for (let i = 0; i < 5; i++) {
    assert.deepStrictEqual(montarHoraDeTv(contas(), semente).programados, primeira);
  }
});

// Semente ausente não pode explodir nem virar aleatório: quem chamar sem ela
// (código antigo, teste) tem que receber algo estável.
test('sem semente ainda assim é estável', () => {
  assert.deepStrictEqual(montarHoraDeTv(contas()).itens, montarHoraDeTv(contas()).itens);
});

// ---------------------------------------------------------------------------
// RN-49 — compensação de cobertura enquanto a rede é menor que o plano
// ---------------------------------------------------------------------------
// É caminho de contrato: o número que sai daqui é quanto tempo de tela o
// cliente recebe pelo que pagou. A propriedade que importa não é o valor por
// ponto, é o TOTAL — a compensação concentra, não presenteia.

test('o total contratado na hora não muda: a compensação concentra, não presenteia', () => {
  // Pro: 120s em cada um dos 7 pontos = 840s por hora, rede cheia.
  const total = 120 * 7;
  for (const cobertos of [7, 6, 5, 4, 3]) {
    assert.strictEqual(segundosCompensados(120, 7, cobertos) * cobertos, total, `com ${cobertos} pontos`);
  }
});

test('rede do tamanho do plano (ou maior) não compensa nada', () => {
  assert.strictEqual(segundosCompensados(90, 3, 3), 90);
  assert.strictEqual(segundosCompensados(90, 3, 5), 90);
});

test('quem paga por mais cobertura recebe mais compensação — é o ponto da regra', () => {
  const rede = 5;
  assert.strictEqual(segundosCompensados(90, 3, rede), 90); // Essencial: cabe na rede, não ganha
  assert.strictEqual(segundosCompensados(120, 7, rede), 168); // Pro
  assert.strictEqual(segundosCompensados(180, 10, rede), 360); // Prime
});

// Sem teto, o Prime numa rede de 1 ponto pediria 1800s — metade da hora
// daquela tela pra uma conta só, e o corte da RN-30 passaria a comer o de
// todo mundo. O teto é o que faz a promessa ser cumprível.
test('o teto segura a conta quando a rede é muito menor que o plano', () => {
  assert.strictEqual(segundosCompensados(180, 10, 1), TETO_COMPENSACAO_SEGUNDOS);
  assert.strictEqual(segundosCompensados(120, 7, 1), TETO_COMPENSACAO_SEGUNDOS);
  // Seis contas no teto enchem a hora e nem uma a mais — é de onde o teto sai.
  assert.strictEqual(TETO_COMPENSACAO_SEGUNDOS * 6, SEGUNDOS_DA_HORA);
});

test('a compensação nunca devolve menos que o contratado', () => {
  for (const contratados of [1, 3, 7, 10]) {
    for (const cobertos of [0, 1, 2, 5, 10, 20]) {
      assert.ok(
        segundosCompensados(120, contratados, cobertos) >= 120,
        `plano de ${contratados} com ${cobertos} cobertos caiu abaixo do contratado`,
      );
    }
  }
});

// Plano sem teto de pontos cobre a rede inteira (`pontosDoAnunciante` devolve
// tudo), então não existe ponto faltando pra compensar.
test('plano que cobre a rede inteira não entra na regra', () => {
  assert.strictEqual(segundosCompensados(120, null, 5), 120);
  assert.strictEqual(segundosCompensados(120, 0, 5), 120);
});

// Ponto `a_instalar` conta como vaga do plano e não veicula. Quem escolheu 2
// pontos no ar de um plano de 7 concentra nos 2 — e recebe os mesmos 840s.
test('quem escolheu poucos pontos concentra neles, e recebe o mesmo total', () => {
  assert.strictEqual(segundosCompensados(120, 7, 2), 420);
  assert.strictEqual(420 * 2, 120 * 7);
});
