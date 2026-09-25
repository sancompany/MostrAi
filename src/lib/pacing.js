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
//   3. banco de horas — só no tempo que SOBROU de 1 e 2 (decisão do dono,
//      25/09/2026: a dívida volta em capacidade ociosa, nunca tirando a
//      entrega corrente de ninguém);
//   4. o que sobrar vira a peça institucional do próprio player, que já
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
//
// A vaga livre mais próxima NUNCA pode ser vizinha de outra vaga do MESMO
// anunciante (pedido do dono, 18/09/2026: "nunca rodando 2 vezes seguidas") —
// a busca tenta achar vaga sem vizinho igual primeiro; só aceita vizinho
// igual se não sobrar outra (a exibição contratada nunca é descartada por
// causa disto — pior fica a ordem, nunca a entrega).
function vagaLivreMaisProxima(vagas, total, ideal, id, semVizinhoIgual) {
  for (let d = 0; d < total; d++) {
    for (const candidata of d === 0 ? [ideal] : [ideal - d, ideal + d]) {
      if (candidata < 0 || candidata >= total || vagas[candidata] !== null) continue;
      if (semVizinhoIgual && (vagas[candidata - 1] === id || vagas[candidata + 1] === id)) continue;
      return candidata;
    }
  }
  return -1;
}

function espalhar(grupos, total) {
  const vagas = new Array(total).fill(null);
  const porTamanho = [...grupos].sort((a, b) => b.quantidade - a.quantidade);

  for (const grupo of porTamanho) {
    for (let i = 0; i < grupo.quantidade; i++) {
      const ideal = Math.min(total - 1, Math.floor(((i + 0.5) * total) / grupo.quantidade));
      let posicao = vagaLivreMaisProxima(vagas, total, ideal, grupo.id, true);
      if (posicao < 0) posicao = vagaLivreMaisProxima(vagas, total, ideal, grupo.id, false);
      if (posicao >= 0) vagas[posicao] = grupo.id;
    }
  }
  return vagas;
}

// Corta `pedidos` ({ quer, duracao }) pra caberem em `capacidade` segundos.
// O corte é proporcional (cada um perde a mesma fração do que pediu) e a sobra
// vai pros maiores restos — medida em segundos, que é o que a hora realmente
// tem. Grava `cabe` em cada pedido.
function caberEm(pedidos, capacidade) {
  const pedidoSegundos = pedidos.reduce((soma, p) => soma + p.quer * p.duracao, 0);
  if (pedidoSegundos <= capacidade) {
    for (const p of pedidos) p.cabe = p.quer;
    return;
  }
  const fator = capacidade / pedidoSegundos;
  for (const p of pedidos) {
    const exato = p.quer * fator;
    p.cabe = Math.floor(exato);
    p.resto = exato - p.cabe;
  }
  let livres = capacidade - pedidos.reduce((soma, p) => soma + p.cabe * p.duracao, 0);
  for (const p of [...pedidos].sort((x, y) => y.resto - x.resto)) {
    if (p.duracao <= livres) {
      p.cabe += 1;
      livres -= p.duracao;
    }
  }
}

// anunciantes: [{ id, frequenciaBase, deficit, banco, duracaoSegundos }]
//
// Devolve a hora inteira já ordenada, mais o relatório de como ela foi gasta.
// `programados` conta só quem ocupa inventário de verdade — o institucional
// fica de fora de propósito, porque ele não é entrega de ninguém.
//
// `banco` (banco de horas) disputa só o tempo que a hora vendida deixou
// livre, DEPOIS do corte da RN-30: pedir banco nunca muda o `cabe` de
// ninguém, nem o do próprio dono da dívida (decisão do dono, 25/09/2026 —
// "entrega corrente não deve ser destruída para satisfazer dívida antiga").
//
// `duracaoInstitucional` (opcional, padrão `DURACAO_INSTITUCIONAL`): quando
// existe vídeo institucional configurado (25/09/2026,
// `src/playlist/gerador.js`), a duração real dele decide quantas peças cabem
// no tempo livre — sem isso, o cartão HTML de 10s e um vídeo de 47s dividiam
// a mesma hora em números bem diferentes de peças, e o resto da conta
// (`qtdInstitucional`, `segundosInstitucionais`) mentia.
function montarHoraDeTv(anunciantes, semente, duracaoInstitucional = DURACAO_INSTITUCIONAL) {
  const todos = embaralhar(
    anunciantes.map((a) => ({
      id: a.id,
      duracao: duracaoValida(a.duracaoSegundos),
      quer: Math.max(0, (a.frequenciaBase || 0) + (a.deficit || 0)),
      banco: Math.max(0, a.banco || 0),
    })),
    semente,
  );
  const pedidos = todos.filter((p) => p.quer > 0);

  const pedidoSegundos = pedidos.reduce((soma, p) => soma + p.quer * p.duracao, 0);
  const cortou = pedidoSegundos > SEGUNDOS_DA_HORA;
  caberEm(pedidos, SEGUNDOS_DA_HORA);
  const segundosContratados = pedidos.reduce((soma, p) => soma + p.cabe * p.duracao, 0);

  const pedidosBanco = todos.filter((p) => p.banco > 0).map((p) => ({ id: p.id, duracao: p.duracao, quer: p.banco }));
  caberEm(pedidosBanco, SEGUNDOS_DA_HORA - segundosContratados);
  const bancoProgramados = {};
  for (const p of pedidosBanco) if (p.cabe > 0) bancoProgramados[p.id] = p.cabe;
  const segundosBanco = pedidosBanco.reduce((soma, p) => soma + p.cabe * p.duracao, 0);

  // Map e não objeto: guarda o id com o tipo original (número de anunciante,
  // 'dono', 'midia:N'), que é o que vai nos itens da playlist.
  const vezesPorId = new Map();
  for (const p of pedidos) if (p.cabe > 0) vezesPorId.set(p.id, p.cabe);
  for (const p of pedidosBanco) if (p.cabe > 0) vezesPorId.set(p.id, (vezesPorId.get(p.id) || 0) + p.cabe);
  const programados = Object.fromEntries(vezesPorId);

  const segundosLivres = Math.max(0, SEGUNDOS_DA_HORA - segundosContratados - segundosBanco);
  const qtdInstitucional = Math.floor(segundosLivres / duracaoInstitucional);

  const grupos = [...vezesPorId].map(([id, quantidade]) => ({ id, quantidade }));
  const itensPagos = grupos.reduce((soma, g) => soma + g.quantidade, 0);
  const total = itensPagos + qtdInstitucional;
  const vagas = total ? espalhar(grupos, total) : [];

  // O que cada um QUERIA antes do corte proporcional (`p.quer`, calculado
  // antes de `cabe`) — é o que o banco de horas (G.3) precisa pra apurar o
  // que não coube por causa da hora estar vendida, não por tela offline.
  // Vai de todo mundo que pediu, mesmo quem não coube em nada (`cabe`
  // ausente vira 0 na leitura, não some da conta do déficit). O banco NÃO
  // entra aqui: devolver dívida não é pedido novo.
  const pedidosPorAnunciante = {};
  for (const p of pedidos) pedidosPorAnunciante[p.id] = p.quer;

  return {
    itens: vagas.map((id) => id ?? ID_INSTITUCIONAL),
    programados,
    bancoProgramados,
    pedidosPorAnunciante,
    segundosContratados,
    segundosBanco,
    segundosInstitucionais: qtdInstitucional * duracaoInstitucional,
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

// `pontosBloqueados` (G.7, pedido do dono 18/09/2026): ponto que cruzou 80%
// de ocupação para de entrar em escolha NOVA — mas só nisso. Quem já estava
// lá (`conta.escolhidos`, ou já caiu ali pelo sorteio de uma rodada
// anterior) continua recebendo normalmente: o bloqueio nunca tira de quem
// já tinha, só impede alguém novo de entrar. Por isso o filtro entra SÓ no
// sorteio automático (linha de baixo), nunca em `operando` (que valida
// escolha existente).
function pontosDoAnunciante(conta, pontosEmOperacao, pontosBloqueados = []) {
  // Plano sem teto de pontos cobre a rede inteira — é o comportamento de
  // todo plano antes desta mudança, e continua valendo pra quem não tem o
  // campo preenchido.
  if (!conta.pontosIncluidos) return [...pontosEmOperacao];

  // Ponto que saiu de operação não conta como escolha gasta: o anunciante
  // não pode perder uma vaga porque um comércio fechou.
  const operando = new Set(pontosEmOperacao);
  const escolhidos = (conta.escolhidos || []).filter((id) => operando.has(id));
  if (escolhidos.length) return escolhidos.slice(0, conta.pontosIncluidos);

  const bloqueados = new Set(pontosBloqueados);
  return [...pontosEmOperacao]
    .filter((id) => !bloqueados.has(id))
    .sort((a, b) => embaralhamentoEstavel(`${conta.id}-${a}`) - embaralhamentoEstavel(`${conta.id}-${b}`))
    .slice(0, conta.pontosIncluidos);
}

// COMPENSAÇÃO DE COBERTURA — RN-49, decidida pelo dono em 17/09/2026.
//
// O plano vende N pontos. Enquanto a rede tiver menos que N, o anunciante
// recebia menos do que pagou, e em silêncio: ele comprou 7 pontos, a rede
// tinha 5, e os 2 que faltavam simplesmente não existiam pra ele. Quem paga
// mais era quem perdia mais — o Prime, que cobre 10, ficava com metade do
// contrato numa rede de 5, enquanto o Essencial, que cobre 3, recebia tudo.
//
// A regra: o tempo dos pontos que faltam volta pros pontos que veiculam.
//
//   segundos por hora em cada ponto = base × (pontos do plano ÷ pontos cobertos)
//
// O TOTAL da hora contratada não muda — só se concentra. Pro (120s × 7) numa
// rede de 5 vira 168s em cada um dos 5: 840s de qualquer jeito. É a mesma
// venda entregue no inventário que existe, não um brinde.
//
// "Pontos cobertos" é quantos pontos EM OPERAÇÃO entram na fatia dele hoje —
// quem escolheu 2 dos 7 concentra nos 2, quem não escolheu nada concentra em
// todos os que estão no ar. Ponto com status `a_instalar` conta como vaga do
// plano (a pessoa não perde o lugar dele), mas não veicula: é exatamente por
// isso que ele entra no numerador e nunca no denominador.
//
// TETO: um anunciante nunca passa de um sexto da hora numa tela.
//
// Sem teto a conta explode no começo, que é justo quando ela mais roda: Prime
// numa rede de 1 ponto pediria 1800s — metade da hora daquela tela, pra uma
// conta só. Aí a tela deixa de ser rede e vira canal de um anunciante, e o
// corte proporcional da RN-30 passa a comer o de todo mundo, inclusive o
// dele. Um sexto é onde a promessa ainda se cumpre: seis contas compensadas
// enchem a hora, e antes disso ninguém é cortado. Acima do teto o anunciante
// para de ganhar — não perde nada do que já tinha.
const TETO_COMPENSACAO_SEGUNDOS = SEGUNDOS_DA_HORA / 6;

function segundosCompensados(segundosPorHora, pontosIncluidos, pontosCobertos) {
  const base = Math.max(0, Number(segundosPorHora) || 0);
  const contratados = Number(pontosIncluidos) || 0;
  const cobertos = Number(pontosCobertos) || 0;
  // Sem base, sem teto de pontos (plano que cobre a rede inteira), sem
  // cobertura nenhuma, ou rede já do tamanho do plano: nada a compensar.
  if (!base || !contratados || cobertos <= 0 || cobertos >= contratados) return base;
  return Math.min(TETO_COMPENSACAO_SEGUNDOS, Math.floor((base * contratados) / cobertos));
}

// Horas de tela por mês, a partir dos segundos por hora e dos pontos.
//
// Assume 12h de comércio aberto por dia, 30 dias — é a mesma conta que a
// vitrine faz no card, e por isso ela sai com "até": comércio que abre menos
// entrega menos. Mora aqui porque o painel do anunciante passou a precisar
// dela pro bônus da RN-49, e um segundo lugar calculando isso à mão seria
// duas respostas diferentes pra mesma pergunta.
const HORAS_ABERTO_DIA = 12;
const DIAS_MES = 30;

function horasDeTelaPorMes(segundosPorHora, pontos) {
  const seg = Math.max(0, Number(segundosPorHora) || 0);
  const n = Math.max(0, Number(pontos) || 0);
  return Math.round((seg * n * HORAS_ABERTO_DIA * DIAS_MES) / SEGUNDOS_DA_HORA);
}

// Quantas vezes o anúncio aparece no mês — reaproveita `horasDeTelaPorMes`
// (o total de tela que o plano já garante) dividido pela duração da peça,
// em vez de guardar um terceiro número que precisaria ser mantido igual aos
// outros dois. Usa `duracao_maxima_segundos` do PLANO, não a duração real
// do criativo (que só existe depois do upload, e varia por anunciante): uma
// peça mais curta que o teto do plano exibe MAIS vezes que este número,
// nunca menos — é o piso garantido, não um teto.
function exibicoesPorMes(horasPorMes, duracaoSegundos) {
  const horas = Math.max(0, Number(horasPorMes) || 0);
  const duracao = Math.max(0, Number(duracaoSegundos) || 0);
  if (!horas || !duracao) return 0;
  return Math.floor((horas * SEGUNDOS_DA_HORA) / duracao);
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
  segundosCompensados,
  horasDeTelaPorMes,
  exibicoesPorMes,
  TETO_COMPENSACAO_SEGUNDOS,
  DURACAO_INSTITUCIONAL,
  DURACAO_PADRAO,
  ID_INSTITUCIONAL,
};
