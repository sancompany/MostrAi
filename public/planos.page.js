// Horas de tela, pontos, duração e criativos saem do DADO do plano, não de
// texto guardado na tabela de benefícios. Escrever "27 horas" à mão cria um
// número que envelhece sozinho no dia em que alguém mexer em
// `segundos_por_hora` — e a vitrine passa a prometer o que a tela não faz.
//
// A conta das horas assume 12h de comércio aberto por dia, 30 dias — por isso
// sai com "até": comércio que abre menos entrega menos, e prometer o número
// cheio seria vender hora que a porta fechada não dá.
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
  if (horas) linhas.push(`<li><b>Até ${horas} horas de tela por mês</b>, somando os seus pontos</li>`);
  if (p.pontos_incluidos) {
    linhas.push(
      `<li>Em ${p.pontos_incluidos} ${p.pontos_incluidos === 1 ? 'ponto' : 'pontos'} da rede, escolhidos por você</li>`,
    );
  }
  if (p.duracao_maxima_segundos) linhas.push(`<li>Peça de até ${p.duracao_maxima_segundos} segundos</li>`);
  if (p.limite_criativos) {
    linhas.push(
      `<li>${p.limite_criativos} ${p.limite_criativos === 1 ? 'criativo ativo por vez' : 'criativos ativos, revezando entre si'}</li>`,
    );
  }
  return linhas.join('');
}

let PLANOS = [];
// Se já estiver logado como anunciante, assinar aqui mesmo — sem passar
// pelo cadastro de novo (o painel pega o ?plano= e gera a cobrança).
let LOGADO = false;
// A troca do cabeçalho pelo menu da conta é do /layout.js — aqui só
// interessa saber se está logado, pra o botão do plano ir pro painel
// (que gera a cobrança) em vez de pedir cadastro de novo.
const carregarLogin = carregarConta().then((a) => {
  LOGADO = !!a;
});

const fmt = fmtBRL; // config.js — Number(v||0), o local usava Number(v) e virava 'R$ NaN'

const NOTA_CICLO = {
  // O aviso de "sem fidelidade" do ciclo mensal foi retirado (pedido do
  // dono, 15/09/2026): a mesma informação já está na FAQ "Como eu cancelo?"
  // logo abaixo, e repetir aqui duplicava o texto sem necessidade.
  1: '',
  3: 'Você paga uma vez a cada 3 meses. O valor por mês abaixo é a referência de quanto isso representa.',
  6: 'Você paga uma vez a cada 6 meses. O valor por mês abaixo é a referência de quanto isso representa.',
  12: 'Você paga uma vez por ano. O valor por mês abaixo é a referência de quanto isso representa.',
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
      const porMes = Number(p.valor_mensal);
      const cheio = p.desconto_percentual > 0 && p.valor_mensal_cheio != null ? Number(p.valor_mensal_cheio) : null;
      return `
    <div class="plan-card ${p.destaque_no_site ? 'popular' : ''}">
      ${p.destaque_no_site ? '<span class="badge">Mais escolhido</span>' : ''}
      <div class="tier">${esc(p.nome)}</div>
      ${p.rotulo ? `<div class="rotulo">${esc(p.rotulo)}</div>` : ''}
      ${cheio ? `<div class="price-riscado"><span>${fmt(cheio)}/mês</span> <span class="badge-desconto">-${Number(p.desconto_percentual)}%</span></div>` : ''}
      <div class="price">${fmt(porMes)}/mês</div>
      <ul>
        ${heranca(p)}
        ${derivados(p)}
        ${proprios(p)
          .map((b) => `<li>${esc(b)}</li>`)
          .join('')}
      </ul>
      <a class="btn ${p.destaque_no_site ? 'popular' : 'primary'} block" href="${LOGADO ? `/anunciante/painel.html?plano=${p.id}` : `/anunciante/cadastro.html?plano=${p.id}`}">Assinar ${esc(p.nome)}</a>
    </div>
  `;
    })
    .join('');
}

document.getElementById('cycleToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#cycleToggle button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  render(Number(btn.dataset.meses));
});

// O desconto de cada ciclo sai dos preços que estão no banco, não de um
// número escrito na mão aqui — se o admin mexer no preço, o rótulo segue.
function atualizarDescontos() {
  document.querySelectorAll('#cycleToggle button').forEach((btn) => {
    const meses = Number(btn.dataset.meses);
    const rotulo = btn.querySelector('small');
    if (!rotulo || meses === 1) return;
    const descontos = PLANOS.filter((p) => p.compromisso_meses === meses)
      .map((p) => {
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
    el.innerHTML = `Os pontos no ar estimam <b>${pessoasPorMes.toLocaleString('pt-BR')} pessoas por mês</b> passando na frente das telas.`;
    el.hidden = false;
  })
  .catch(() => {});

Promise.all([fetch(`${API_BASE_URL}/planos`).then((r) => r.json()), carregarLogin])
  .then(([planos]) => {
    PLANOS = planos;
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
// Limite de 5 pontos na rede (pedido do dono, 15/09/2026): com a rede ainda
// pequena o aviso acompanha o tamanho dela, e some sozinho assim que o quinto
// entrar — a partir daí a cobertura já não é mais "rede vazia" o bastante pra
// precisar do aviso.
const PONTOS_PARA_TIRAR_AVISO = 5;

fetch(`${API_BASE_URL}/pontos`)
  .then((r) => r.json())
  .then((pontos) => {
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
    const situacao =
      naRede === 0
        ? 'Ainda não há nenhum ponto na rede.'
        : `Hoje a rede tem ${naRede === 1 ? '1 ponto' : `${naRede} pontos`}.`;

    // RN-49: o bônus de cobertura. Só entra com tela VEICULANDO — sem nenhuma
    // não existe pra onde concentrar o tempo, e prometer aqui seria vender o
    // que a rede não tem. Por isso o gatilho é `veiculando` e não `naRede`:
    // são as duas contagens diferentes, e usar a errada aqui transformaria a
    // frase numa promessa que o gerador não cumpre.
    const bonus = veiculando
      ? '<br><br><b>E você não paga por ponto que ainda não existe.</b> Enquanto a rede for menor que a cobertura ' +
        'do seu plano, o tempo dos pontos que faltam volta para os pontos que já estão no ar — até onde couber na ' +
        'hora de cada tela. Você aparece mais vezes em cada ponto em vez de aparecer em menos lugares, e vê no seu ' +
        'painel quantas horas a mais isso dá por mês. Conforme os pontos entram no ar, o tempo se espalha de volta.'
      : '';

    const el = document.getElementById('avisoRede');
    el.innerHTML =
      `<b>A rede ainda está em montagem.</b> ${situacao} ` +
      'A cobrança do plano começa na confirmação do pagamento, e não quando a primeira tela subir. ' +
      'Se preferir esperar, <a href="/contato.html">fale com a gente</a>. E se assinar agora e mudar de ideia, ' +
      `você tem 7 dias para pedir a devolução integral pelo painel.${bonus}`;
    el.hidden = false;
  })
  .catch(() => {});
