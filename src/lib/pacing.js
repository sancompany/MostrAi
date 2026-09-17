// Cálculo puro da hora de uma tela — sem acesso a banco, testável isolado
// (tests/pacing.test.js). Quem busca os dados e grava o resultado é
// src/playlist/gerador.js.
//
// A UNIDADE DA HORA É O SEGUNDO, NÃO O SLOT.
//
// Até 16/09/2026 este arquivo contava slots: montava uma lista com
// `frequencia_hora` cópias de cada anunciante e devolvia. A lista não tinha
// nenhuma relação com os 3600 segundos da hora, e o player
// (public/player.page.js) toca a lista em LAÇO — `indice = (indice + 1) %
// playlist.length`. O resultado, medido: com um anunciante só na rede, o
// plano Essencial vendia 3 exibições por hora e a tela entregava 180. Com a
// rede cheia, o MESMO plano entregava 5. Ou seja, o que o cliente recebia não
// era o que ele comprou, e piorava conforme a rede desse certo — o pior
// desenho possível pra um produto que se vende por frequência.
//
// Agora a hora é um orçamento de 3600 segundos, gasto nesta ordem:
//   1. exibição contratada (frequência do plano + déficit da hora anterior);
//   2. cota de autoanúncio do dono do ponto (permuta do comodato);
//   3. o que sobrar vira a peça institucional do próprio player, que já
//      existe (#vazio em public/player.html) e já diz "este espaço pode ser
//      do seu negócio" — inventário vago que anuncia a si mesmo.
//
// Com a hora cheia, a lista tem a duração da hora e o laço do player deixa de
// inflar nada: `vezes_programadas` volta a ser comparável com
// `vezes_confirmadas`, o déficit da RN-10 volta a fazer sentido, e o número
// que a vitrine imprime passa a ser o número que a tela entrega, com a rede
// vazia ou cheia.

const SEGUNDOS_DA_HORA = 3600;

// Duração da peça institucional que preenche o inventário vago. Não é vídeo:
// é o cartão HTML do próprio player, então o número é escolha nossa. Dez
// segundos é o suficiente pra ler "este espaço pode ser do seu negócio" sem
// virar tela parada.
const DURACAO_INSTITUCIONAL = 10;

// Criativo sem duração declarada (upload que o ffmpeg não mediu) entra com um
// valor do meio da faixa que a vitrine aceita, 15 a 30s. O piso existe porque
// uma duração absurda (0, negativa, 1s) transformaria a hora em milhares de
// itens.
const DURACAO_MINIMA = 5;
const DURACAO_PADRAO = 20;

// Id reservado dos itens institucionais. Não é anunciante: não gera contador,
// não gera cobrança, não aparece em relatório de entrega.
const ID_INSTITUCIONAL = '__institucional';

function duracaoValida(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= DURACAO_MINIMA ? n : DURACAO_PADRAO;
}

// EMBARALHAMENTO DETERMINISTICO (17/09/2026, pra rodar em mais de uma
// instancia). Era `Math.random()`, e por isso a playlist precisava de um cache
// em memoria do processo: sem ele, cada poll do player remontava a hora numa
// ordem diferente e a TV pulava. Cache em memoria e exatamente o que nao
// sobrevive a duas instancias — cada uma cachearia uma ordem, e o aparelho
// receberia uma ou outra conforme quem respondesse.
//
// Com a semente, a hora de um aparelho e SEMPRE a mesma ordem, calculada por
// qualquer instancia, e ate depois de reiniciar o servidor. O cache deixou de
// existir em vez de virar tabela: e menos peca, nao mais.
//
// A semente vem do par (aparelho, hora), entao a ordem continua variando de
// hora em hora e de tela em tela — ninguem ve o mesmo padrao duas vezes.
function geradorSemente(semente) {
  let h = embaralhamentoEstavel(String(semente ?? ''));
  // xorshift32: barato, sem dependencia, e bom o suficiente pra ordenar uma
  // lista. Nao e para uso criptografico e nao precisa ser.
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 4294967296;
  };
}

function embaralhar(lista, semente) {
  const sorteio = geradorSemente(semente);
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(sorteio() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

// Espalha as exibições contratadas ao longo da hora em vez de sortear a
// ordem. Sortear era aceitável quando a lista inteira era paga e dava uma
// volta a cada poucos minutos; agora a lista é a hora inteira, e no sorteio as
// 3 exibições do Essencial podiam cair todas nos primeiros cinco minutos. Três
// vezes por hora amontoadas em cinco minutos não é três vezes por hora.
//
// Cada anunciante recebe as posições ideais (i + 0,5) * total / n e vai pra
// vaga livre mais próxima. Quem tem mais exibições é colocado primeiro, porque
// é quem tem menos folga pra ser empurrado.
function espalhar(grupos, total) {
  const vagas = new Array(total).fill(null);
  const porTamanho = [...grupos].sort((a, b) => b.quantidade - a.quantidade);

  for (const grupo of porTamanho) {
    for (let i = 0; i < grupo.quantidade; i++) {
      const ideal = Math.min(total - 1, Math.floor(((i + 0.5) * total) / grupo.quantidade));
      let posicao = -1;
      for (let d = 0; d < total; d++) {
        if (ideal - d >= 0 && vagas[ideal - d] === null) {
          posicao = ideal - d;
          break;
        }
        if (ideal + d < total && vagas[ideal + d] === null) {
          posicao = ideal + d;
          break;
        }
      }
      if (posicao >= 0) vagas[posicao] = grupo.id;
    }
  }
  return vagas;
}

// anunciantes: [{ id, frequenciaBase, deficit, duracaoSegundos }]
//
// Devolve a hora inteira já ordenada, mais o relatório de como ela foi gasta.
// `programados` conta só quem ocupa inventário de verdade — o institucional
// fica de fora de propósito, porque ele não é entrega de ninguém.
function montarHoraDeTv(anunciantes, semente) {
  const pedidos = embaralhar(
    anunciantes.map((a) => ({
      id: a.id,
      duracao: duracaoValida(a.duracaoSegundos),
      quer: Math.max(0, (a.frequenciaBase || 0) + (a.deficit || 0)),
    })),
    semente,
  ).filter((p) => p.quer > 0);

  const pedidoSegundos = pedidos.reduce((soma, p) => soma + p.quer * p.duracao, 0);
  const cortou = pedidoSegundos > SEGUNDOS_DA_HORA;

  if (cortou) {
    // A hora não cabe em todo mundo. O corte é proporcional (cada um perde a
    // mesma fração do que pediu) e a sobra vai pros maiores restos, como já
    // era — só que medida em segundos, que é o que a hora realmente tem.
    const fator = SEGUNDOS_DA_HORA / pedidoSegundos;
    for (const p of pedidos) {
      const exato = p.quer * fator;
      p.cabe = Math.floor(exato);
      p.resto = exato - p.cabe;
    }
    let livres = SEGUNDOS_DA_HORA - pedidos.reduce((soma, p) => soma + p.cabe * p.duracao, 0);
    for (const p of [...pedidos].sort((x, y) => y.resto - x.resto)) {
      if (p.duracao <= livres) {
        p.cabe += 1;
        livres -= p.duracao;
      }
    }
  } else {
    for (const p of pedidos) p.cabe = p.quer;
  }

  const comExibicao = pedidos.filter((p) => p.cabe > 0);
  const segundosContratados = comExibicao.reduce((soma, p) => soma + p.cabe * p.duracao, 0);
  const segundosLivres = Math.max(0, SEGUNDOS_DA_HORA - segundosContratados);
  const qtdInstitucional = Math.floor(segundosLivres / DURACAO_INSTITUCIONAL);

  const itensPagos = comExibicao.reduce((soma, p) => soma + p.cabe, 0);
  const total = itensPagos + qtdInstitucional;

  const vagas = total
    ? espalhar(
        comExibicao.map((p) => ({ id: p.id, quantidade: p.cabe })),
        total,
      )
    : [];

  const programados = {};
  for (const p of comExibicao) programados[p.id] = p.cabe;

  return {
    itens: vagas.map((id) => id ?? ID_INSTITUCIONAL),
    programados,
    segundosContratados,
    segundosInstitucionais: qtdInstitucional * DURACAO_INSTITUCIONAL,
    qtdInstitucional,
    pedidoSegundos,
    cabeSegundos: Math.min(pedidoSegundos, SEGUNDOS_DA_HORA),
    cortou,
    // Quanto da hora está vendido. É o número que diz se a rede tem inventário
    // pra vender ou se já está na hora de subir preço ou abrir mais ponto.
    ocupacao: Math.round((segundosContratados / SEGUNDOS_DA_HORA) * 100),
  };
}

// Em quais pontos este anunciante roda.
//
// Regra do dono (17/09/2026): o plano dá acesso a N pontos e o CONTRATANTE
// escolhe quais. Quem não escolhe não fica de fora — o sistema escolhe por
// ele. O que o sistema NÃO pode fazer é escolher de novo a cada hora: o
// anúncio ficaria pulando de comércio em comércio e nenhum relatório faria
// sentido. Por isso a escolha automática é um sorteio ESTÁVEL, derivado do
// par (anunciante, ponto) — mesma conta, mesma rede, mesmos pontos, sempre.
//
// Quando a rede cresce, os pontos novos entram no sorteio e a distribuição
// se refaz sozinha. É o que faz "rede expansiva" ser verdade sem ninguém
// mexer em nada.
function embaralhamentoEstavel(texto) {
  let h = 2166136261;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pontosDoAnunciante(conta, pontosEmOperacao) {
  // Plano sem teto de pontos cobre a rede inteira — é o comportamento de
  // todo plano antes desta mudança, e continua valendo pra quem não tem o
  // campo preenchido.
  if (!conta.pontosIncluidos) return [...pontosEmOperacao];

  // Ponto que saiu de operação não conta como escolha gasta: o anunciante
  // não pode perder uma vaga porque um comércio fechou.
  const operando = new Set(pontosEmOperacao);
  const escolhidos = (conta.escolhidos || []).filter((id) => operando.has(id));
  if (escolhidos.length) return escolhidos.slice(0, conta.pontosIncluidos);

  return [...pontosEmOperacao]
    .sort((a, b) => embaralhamentoEstavel(`${conta.id}-${a}`) - embaralhamentoEstavel(`${conta.id}-${b}`))
    .slice(0, conta.pontosIncluidos);
}

function contarPorAnunciante(itens) {
  const contagem = {};
  for (const id of itens) contagem[id] = (contagem[id] || 0) + 1;
  return contagem;
}

// Cota de autoanúncio é do PONTO e é dividida entre as telas ativas dele
// (migration 019). Cota 6 com 2 telas = 3 por tela; com 4 telas = 2 (arredonda
// pra cima, pra o dono nunca ficar com zero por causa de divisão).
function dividirCota(cotaDoPonto, telasAtivas) {
  const cota = Math.max(0, Number(cotaDoPonto) || 0);
  const telas = Math.max(1, Number(telasAtivas) || 1);
  return cota === 0 ? 0 : Math.ceil(cota / telas);
}

module.exports = {
  montarHoraDeTv,
  pontosDoAnunciante,
  contarPorAnunciante,
  dividirCota,
  duracaoValida,
  espalhar,
  SEGUNDOS_DA_HORA,
  DURACAO_INSTITUCIONAL,
  DURACAO_PADRAO,
  ID_INSTITUCIONAL,
};
