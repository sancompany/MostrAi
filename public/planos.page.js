// Horas de tela, pontos, duração e criativos saem do DADO do plano, não de
// texto guardado na tabela de benefícios. Escrever "27 horas" à mão cria um
// número que envelhece sozinho no dia em que alguém mexer em
// `segundos_por_hora` — e a vitrine passa a prometer o que a tela não faz.
//
// O QUE O PLANO VENDE É UM TOTAL DE HORAS NA REDE, dividido entre os pontos —
// não horas por ponto (decisão do dono, 17/09/2026). A conta é a mesma; o que
// muda é qual dos dois números é o produto e qual é consequência. Importa
// porque, com a rede menor que o plano, o total é o que se preserva e a
// divisão é o que muda (RN-49). A frase "na rede, dividida entre os seus
// pontos" saiu do texto do card em 18/09/2026 (pedido do dono, bullet mais
// seco) — a divisão continua implícita na linha seguinte ("Em até N pontos
// da rede"), só não é mais dita duas vezes.
//
// A conta assume 12h de comércio aberto por dia, 30 dias. O "até" que
// protegia contra prometer hora que a porta fechada não dá saiu do texto do
// card em 18/09/2026, a pedido do dono ("27 horas de tela por mês", sem
// qualificador) — decisão dele sobre a promessa, não mudança na conta.
//
// A linha de "X min de tela a cada hora" saiu em 17/09/2026 (pedido do dono).
// Era a conta de DENTRO: mesma grandeza que o total do mês, em outra unidade,
// obrigando o leitor a multiplicar pra concluir o que o card já dizia em cima.
const HORAS_ABERTO_DIA = 12;
const DIAS_MES = 30;

function horasDeTelaPorMes(p) {
  if (!p.segundos_por_hora || !p.pontos_incluidos) return null;
  return Math.round((p.segundos_por_hora * p.pontos_incluidos * HORAS_ABERTO_DIA * DIAS_MES) / 3600);
}

// Quantas vezes o anúncio aparece no mês — mesma conta de
// src/lib/pacing.js#exibicoesPorMes, reaproveitando as horas de tela já
// calculadas acima em vez de um terceiro número. Usa a duração MÁXIMA do
// plano: uma peça mais curta cabe mais vezes, então este é o piso
// garantido, não um teto.
function exibicoesPorMes(p) {
  const horas = horasDeTelaPorMes(p);
  if (!horas || !p.duracao_maxima_segundos) return null;
  return Math.floor((horas * 3600) / p.duracao_maxima_segundos);
}

// "Tudo do Essencial" abre o card, não fecha: é a frase que diz ao leitor que
// ele não precisa reler o degrau de baixo. Vinha por último porque
// `planos_beneficios` não guarda ordem, e ordenar no banco por id daria uma
// ordem que muda a cada benefício novo.
const HERANCA = /^Tudo do /i;
const heranca = (p) =>
  (p.beneficios || [])
    .filter((b) => HERANCA.test(b))
    .map((b) => `<li><b>${esc(b)}</b></li>`)
    .join('');
const proprios = (p) => (p.beneficios || []).filter((b) => !HERANCA.test(b));

function derivados(p) {
  const linhas = [];
  const horas = horasDeTelaPorMes(p);
  if (horas) linhas.push(`<li><b>${horas} horas de tela por mês</b></li>`);
  if (p.pontos_incluidos) {
    linhas.push(
      `<li>Em até ${p.pontos_incluidos} ${p.pontos_incluidos === 1 ? 'ponto' : 'pontos'} da rede, escolhidos por você</li>`,
    );
  }
  if (p.duracao_maxima_segundos) linhas.push(`<li>Anúncio de até ${p.duracao_maxima_segundos} segundos</li>`);
  const exibicoes = exibicoesPorMes(p);
  if (exibicoes) linhas.push(`<li>Pelo menos ${exibicoes.toLocaleString('pt-BR')} exibições por mês</li>`);
  if (p.limite_criativos) {
    linhas.push(
      `<li>${p.limite_criativos} ${p.limite_criativos === 1 ? 'anúncio ativo por vez' : 'anúncios por vez, que revezam entre si'}</li>`,
    );
  }
  return linhas.join('');
}

let PLANOS = [];
// Se já estiver logado como anunciante, assinar aqui mesmo — sem passar
// pelo cadastro de novo (confirmar-plano.html pega o ?plano= e gera a cobrança).
let LOGADO = false;
// A troca do cabeçalho pelo menu da conta é do /layout.js — aqui só
// interessa saber se está logado, pra o botão do plano ir pro painel
// (que gera a cobrança) em vez de pedir cadastro de novo.
const carregarLogin = carregarSessao().then((a) => {
  LOGADO = !!a;
});

const fmt = fmtBRL; // config.js — Number(v||0), o local usava Number(v) e virava 'R$ NaN'

const NOTA_CICLO = {
  // O aviso de "sem fidelidade" do ciclo mensal foi retirado (pedido do
  // dono, 15/09/2026): a mesma informação já está na FAQ "Como eu cancelo?"
  // logo abaixo, e repetir aqui duplicava o texto sem necessidade.
  //
  // A segunda frase ("o valor mensal é só referência") saiu em 18/09/2026,
  // a pedido do dono ("mantenha... somente o aviso"): o preço do card agora
  // mostra o total do ciclo, o quanto economizou E a equivalência mensal —
  // a nota repetindo isso ficaria dizendo três vezes a mesma coisa.
  1: '',
  3: 'Você paga uma vez a cada 3 meses.',
  6: 'Você paga uma vez a cada 6 meses.',
  12: 'Você paga uma vez por ano.',
};

// Referência de preço cheio: é o plano mensal do mesmo tier. Assinar 3
// meses custa o mensal × 3 se não houvesse desconto — esse é o valor
// riscado, e a diferença dividida pelos meses é a economia por mês.
function mensalDoTier(tier) {
  const mensal = PLANOS.find((p) => p.tier === tier && p.compromisso_meses === 1);
  return mensal ? Number(mensal.valor_mensal) : null;
}

function render(meses) {
  const grid = document.getElementById('plansGrid');
  const nota = document.getElementById('cycleNote');
  nota.textContent = NOTA_CICLO[meses] || '';
  nota.hidden = !NOTA_CICLO[meses];
  const doMes = PLANOS.filter((p) => p.compromisso_meses === meses);
  // Aba sem plano nenhum deixava a area em branco, sem dizer se estava
  // carregando, se deu erro ou se nao ha plano naquele ciclo.
  if (!doMes.length) {
    grid.innerHTML =
      '<p class="empty-state">Nenhum plano nesse ciclo agora. Veja os outros ciclos acima ou ' +
      '<a href="/contato.html">fale com a gente</a>.</p>';
    return;
  }
  grid.innerHTML = doMes
    .map((p) => {
      const promo = condicaoPromocionalVigente(p.tier, meses);
      return `
    <div class="plan-card ${p.destaque_no_site ? 'popular' : ''}">
      ${p.destaque_no_site ? '<span class="badge">Mais escolhido</span>' : ''}
      <div class="tier">${esc(p.nome)}</div>
      ${p.rotulo ? `<div class="rotulo">${esc(p.rotulo)}</div>` : ''}
      ${montarPreco(p, meses, promo)}
      <ul>
        ${heranca(p)}
        ${derivados(p)}
        ${proprios(p)
          .map((b) => `<li>${esc(b)}</li>`)
          .join('')}
      </ul>
      <a class="btn ${p.destaque_no_site ? 'popular' : 'primary'} block" href="${LOGADO ? `/anunciante/confirmar-plano.html?plano=${p.id}` : `/anunciante/cadastro.html?plano=${p.id}`}">Assinar ${esc(p.nome)}</a>
    </div>
  `;
    })
    .join('');
}

// O preço fala em MÊS no ciclo mensal (não há um "ciclo maior" pra comparar
// contra) e fala em CICLO nos demais — pedido do dono, 18/09/2026: o que o
// cliente realmente paga de uma vez, o quanto economizou nesse pagamento, e
// só por último a equivalência mensal, pra quem quer comparar contra o
// mensal. Três linhas, nessa ordem: o valor cheio do ciclo inteiro riscado,
// o valor total do ciclo já com desconto (o número grande), e — do mesmo
// tamanho da linha riscada — quanto economizou (em verde) e, na linha de
// baixo, na cor normal, o equivalente por mês.
//
// As duas últimas linhas são condicionais NO CONTEÚDO (pedido do dono,
// 19/09/2026, revendo a decisão anterior de "manter os quatro ciclos
// iguais"): no Mensal SEM promoção não há nada pra comparar (o valor já É
// o mensal), e "economizou" só faz sentido quando existe desconto de
// verdade — sem ele a economia seria sempre zero, e uma linha dizendo
// "economizou R$0,00" não ajuda ninguém. Isso continua valendo.
//
// O que NÃO pode mais variar é a GEOMETRIA (reformulação comercial,
// 22/09/2026, Parte J: "os cards do ciclo Mensal ficam menores/diferentes
// dos cards dos outros ciclos" — o próprio card pulava de 2 pra 4 linhas ao
// trocar de aba, e a régua de altura ficava pulando junto). As 4 linhas
// (riscado/badge, preço, economia, equivalente) sempre nascem no DOM nos 4
// ciclos; a que não se aplica fica com `.price-linha-vazia` — reserva a
// mesma altura, sem mostrar um número que não existe.
//
// `promo` (Parte Q, mesma rodada): quando o ciclo participa de uma
// promoção vigente, o desconto promocional SUBSTITUI o desconto normal do
// ciclo na conta (mesma régua do backend, san-checkout.js#valorMensalDaConta)
// — é o preço de tabela daquele ciclo enquanto a promoção vale, não mais um
// desconto em cima do desconto.
//
// O selo e o "preço válido por N meses" só aparecem quando a célula tem
// vantagem de verdade (`temVantagem`, calculado no servidor — D1,
// 24/09/2026): no Anual a pré-venda dá 20% e o ciclo já dá 20%, o preço é o
// mesmo, e o card anunciava uma promoção que não muda nada. O número
// continua seguindo a régua da cobrança (a promoção substitui o ciclo).
function montarPreco(p, meses, promo) {
  const cheioBase = Number(p.valor_mensal_cheio ?? p.valor_mensal);
  const desconto = promo ? Number(promo.descontoPercentual) : Number(p.desconto_percentual) || 0;
  const porMes = desconto ? Math.round(cheioBase * (1 - desconto / 100) * 100) / 100 : cheioBase;
  const cheioCiclo = Math.round(cheioBase * meses * 100) / 100;
  const totalCiclo = Math.round(porMes * meses * 100) / 100;
  const economia = Math.round((cheioCiclo - totalCiclo) * 100) / 100;
  const temRiscado = cheioCiclo > totalCiclo;
  const anunciaPromo = promo && promo.temVantagem !== false;
  return `
      ${anunciaPromo ? `<div class="price-selo-promo">${esc(promo.promocao?.selo || promo.promocao?.titulo_publico || 'Promoção')}</div>` : ''}
      <div class="price-riscado ${temRiscado ? '' : 'price-linha-vazia'}">${temRiscado ? `<span>${fmt(cheioCiclo)}</span> <span class="badge-desconto">-${desconto}%</span>` : '&nbsp;'}</div>
      <div class="price">${fmt(totalCiclo)}${meses === 1 ? '/mês' : ''}</div>
      <div class="price-economia ${economia > 0 ? '' : 'price-linha-vazia'}">${economia > 0 ? `Você economizou ${fmt(economia)}.` : '&nbsp;'}</div>
      <div class="price-equivalente ${meses > 1 ? '' : 'price-linha-vazia'}">${meses > 1 ? `Equivalente a ${fmt(porMes)}/mês.` : '&nbsp;'}</div>
      ${anunciaPromo ? `<div class="price-promo-duracao">Preço válido por ${promo.promocao?.duracao_beneficio_meses} meses a partir da adesão.</div>` : ''}`;
}

// `aria-pressed` acompanha a classe: pro leitor de tela, as quatro abas
// eram quatro botões iguais, sem dizer qual ciclo estava escolhido.
document.getElementById('cycleToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#cycleToggle button').forEach((b) => {
    b.classList.toggle('active', b === btn);
    b.setAttribute('aria-pressed', String(b === btn));
  });
  render(Number(btn.dataset.meses));
});

// O desconto de cada ciclo sai dos preços que estão no banco, não de um
// número escrito na mão aqui — se o admin mexer no preço, o rótulo segue.
// Promoção vigente entra na mesma conta (Parte Q): o rótulo do ciclo mostra
// o MAIOR desconto real de quem está ali, promocional incluso — senão a
// aba dizia "-10%" enquanto o card já embaixo mostrava "-15%" de promoção.
function atualizarDescontos() {
  document.querySelectorAll('#cycleToggle button').forEach((btn) => {
    const meses = Number(btn.dataset.meses);
    const rotulo = btn.querySelector('small');
    if (!rotulo || meses === 1) return;
    const descontos = PLANOS.filter((p) => p.compromisso_meses === meses)
      .map((p) => {
        const promo = condicaoPromocionalVigente(p.tier, meses);
        if (promo) return Number(promo.descontoPercentual);
        const base = mensalDoTier(p.tier);
        return base ? Math.round((1 - p.valor_mensal / base) * 100) : 0;
      })
      .filter((d) => d > 0);
    rotulo.textContent = descontos.length ? `-${Math.max(...descontos)}%` : '';
  });
}

fetch(`${API_BASE_URL}/pontos/fluxo`)
  .then((r) => r.json())
  .then(({ pessoasPorMes }) => {
    if (!pessoasPorMes) return;
    const el = document.getElementById('planosFluxo');
    // "alcança" era medicao; isto e estimativa de fluxo declarada por cada
    // ponto na instalacao. A palavra mudou pra o que o numero e de verdade.
    // Sem "no ar" (19/09/2026, pedido do dono) — mesmo motivo do texto da
    // home: não importa se o ponto está instalado ou não, só o total.
    el.innerHTML = `Os pontos estimam <b>${pessoasPorMes.toLocaleString('pt-BR')} pessoas por mês</b> passando na frente das telas.`;
    el.hidden = false;
  })
  .catch(() => {});

// Guardado numa promessa porque o aviso de rede (lá embaixo) precisa dos
// planos pra dizer ATÉ QUANTOS pontos a cobertura vai. Sem isso os dois
// `fetch` corriam soltos e, numa rede lenta, o aviso montava antes dos planos
// chegarem e saía com "mais pontos" em vez do número — o tipo de corrida que
// nunca aparece na máquina de quem escreveu e sempre aparece no celular.
// Promoções vigentes marcadas pra aparecer na página de Planos (Parte Q do
// pedido de Ofertas/Promoções, 22/09/2026) — falha muda (sem promoção
// nenhuma) em vez de quebrar a vitrine se o endpoint cair.
let PROMOCOES_VIGENTES = [];
function condicaoPromocionalVigente(tier, compromissoMeses) {
  for (const promo of PROMOCOES_VIGENTES) {
    const item = (promo.itens || []).find((i) => i.tier === tier && i.compromissoMeses === compromissoMeses);
    if (item) return { ...item, promocao: promo };
  }
  return null;
}

// Banner no topo da página (Parte 4 do pedido, camada 1: "o usuário entende
// claramente que existe uma campanha ativa e quais condições ela oferece" —
// antes só o preço mudava, sem nenhum aviso de que havia promoção).
// Mesmo visual do banner da Home (`.promo-home-banner`), sem botão — a
// página inteira já É a oferta, não precisa de CTA pra rolar até ela mesma.
function pintarBannerPlanos(promo) {
  if (!promo) return;
  const secao = document.getElementById('promocaoPlanosBanner');
  const el = document.getElementById('promocaoPlanosTopo');
  const comImagemHorizontal = promo.imagem_url && promo.formato_midia === 'horizontal';
  // Em que ciclos vale e até quando (D1/D3, 24/09/2026 — config.js).
  // Sem vantagem em ciclo nenhum, não há banner: seria anunciar desconto
  // que não existe.
  const condicao = window.condicaoDaPromocao(promo);
  if (condicao === null) return;
  const prazo = condicao ? `<p class="promo-home-prazo">${esc(condicao)}</p>` : '';
  el.innerHTML = `
    <div class="promo-home-banner ${comImagemHorizontal ? 'com-imagem' : ''}">
      ${comImagemHorizontal ? `<img class="promo-home-img-fundo" src="${esc(promo.imagem_url)}" alt="">` : ''}
      <div class="promo-home-conteudo">
        ${promo.selo ? `<span class="badge">${esc(promo.selo)}</span>` : ''}
        <h2>${esc(promo.titulo_publico)}</h2>
        ${promo.subtitulo ? `<p class="lead">${esc(promo.subtitulo)}</p>` : ''}
        ${prazo}
      </div>
    </div>`;
  secao.hidden = false;
}

const planosCarregados = Promise.all([
  fetch(`${API_BASE_URL}/planos`).then((r) => r.json()),
  fetch(`${API_BASE_URL}/promocoes/vigentes`)
    .then((r) => r.json())
    .catch(() => []),
  carregarLogin,
])
  .then(([planos, promocoes]) => {
    PLANOS = planos;
    PROMOCOES_VIGENTES = (Array.isArray(promocoes) ? promocoes : []).filter((p) => p.mostrar_planos);
    pintarBannerPlanos(PROMOCOES_VIGENTES[0]);
    atualizarDescontos();
    render(3);
  })
  .catch(() => {
    document.getElementById('plansGrid').innerHTML =
      '<p class="empty-state">Não foi possível carregar os planos agora.</p>';
  });

// Vender cobertura numa rede sem nenhuma tela no ar era o furo mais caro da
// vitrine: a cobranca comeca na confirmacao do pagamento (migration 021 tirou
// a espera por ponto), entao quem assinasse ia pagar por uma rede vazia sem a
// tela dizer isso em lugar nenhum. Nao bloqueia a venda, so para de esconder.
//
// Limite de 10 pontos na rede (pedido do dono, 15/09/2026, ajustado pra 10
// em 19/09/2026: com 10 pontos a rede já cobre o maior plano vendido —
// Máximo, com pontos_incluidos=10 — então não sobra plano que ainda
// precisaria do bônus de cobertura). Com a rede ainda menor que isso, o
// aviso acompanha o tamanho dela, e some sozinho assim que o décimo entrar.
const PONTOS_PARA_TIRAR_AVISO = 10;

Promise.all([fetch(`${API_BASE_URL}/pontos`).then((r) => r.json()), planosCarregados])
  .then(([pontos]) => {
    if (!Array.isArray(pontos)) return;
    // UMA contagem só (pedido do dono, 17/09/2026): ponto ATIVO é o que já
    // tem cadastro na rede — em operação mais esperando instalação. A vitrine
    // não separa os dois; quem separa é o admin, e o desenho de status vai ser
    // fechado quando o dono chegar naquela aba.
    //
    // `/pontos` já devolve só esses dois status, então a contagem é o tamanho
    // da lista. Filtrar por status aqui de novo seria repetir a regra do
    // servidor num lugar que não manda nela.
    const naRede = pontos.length;
    if (naRede >= PONTOS_PARA_TIRAR_AVISO) return;
    const veiculando = pontos.filter((p) => p.status === 'em_operacao').length;
    const maiorCobertura = Math.max(0, ...PLANOS.map((p) => Number(p.pontos_incluidos) || 0));
    const situacao = naRede === 0 ? 'nenhum ponto ainda.' : `${naRede} ${naRede === 1 ? 'ponto' : 'pontos'} hoje.`;

    // O dono pediu pra melhorar esta parte (18/09/2026): "igual estava antes",
    // com a mecânica do bônus explicada de verdade, não só prometida. A frase
    // visível agora diz O QUE acontece (plano com mais pontos que a rede tem
    // hoje ganha horas bônus, divididas entre os pontos ativos) — não só que
    // "não se paga por ponto que não existe". O <details> continua existindo
    // pra quem quer a mecânica completa (como a hora se concentra, o teto por
    // tela, e que o bônus some sozinho conforme a rede cresce), sem obrigar
    // todo mundo a ler o parágrafo inteiro.
    //
    // Só entra com tela VEICULANDO: sem nenhuma não existe pra onde
    // concentrar o tempo. Por isso o gatilho é `veiculando` e não `naRede`.
    const bonus = veiculando
      ? ` <b>Você não paga por ponto que ainda não existe.</b> Planos que cobrem mais pontos do que a rede tem ` +
        `hoje (até ${maiorCobertura || 'mais'} pontos) ganham horas bônus, divididas entre os pontos já ativos — ` +
        'até a rede completar a cobertura do plano.' +
        '<details class="aviso-detalhe"><summary>Como isso funciona</summary>' +
        '<p>O seu plano vende um total de horas de tela por mês, divididas entre os pontos que ele cobre. Enquanto ' +
        'a rede tiver menos pontos que o seu plano, essas horas se concentram nos pontos que já estão no ar — até ' +
        'onde couber na hora de cada tela. Você aparece mais vezes em cada ponto, em vez de aparecer em menos ' +
        'lugares, e vê no seu painel quantas horas a mais isso dá por mês. Conforme os pontos entram no ar, o ' +
        'bônus vai sumindo e o tempo se espalha de volta.</p></details>'
      : '';

    const el = document.getElementById('avisoRede');
    el.innerHTML = `<b>Rede em montagem: ${situacao}</b>${bonus}`;
    el.hidden = false;
  })
  .catch(() => {});
