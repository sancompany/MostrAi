// Aponta pra API certa em dev (Express local) vs produção (Render).
// ponytail: sem build step, então isso é JS puro incluído antes dos outros
// scripts — não precisa de bundler pra trocar a URL por ambiente.
// Localhost E IP de rede local: quem abre o site pelo IP do computador na
// rede (ex.: http://192.168.0.10:3000/), o hostname não é "localhost" — sem
// isto a página falaria com a API de produção. Como o próprio Express serve
// o site, mesma origem resolve os dois casos (e leva a porta junto).
const REDE_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
// Sem build step, `const` no topo de um <script> clássico vai pro escopo global
// e é assim que as outras páginas leem esta constante. O lint só enxerga este
// arquivo e não vê uso nenhum — daí a supressão, que é sobre isso e nada mais.
// biome-ignore lint/correctness/noUnusedVariables: lida pelos scripts das páginas, não por este arquivo
const API_BASE_URL = REDE_LOCAL.test(window.location.hostname)
  ? window.location.origin
  : // Produção: a API é servida pelo mesmo serviço que serve o site (Northflank),
    // então mesma origem vale lá também. Se um dia a API for pra outro host,
    // troque aqui — é o único lugar.
    window.location.origin;

// ---------------------------------------------------------------------------
// Utilitários compartilhados. Ficam aqui porque o config.js é o único script
// carregado por toda página que tem JS — sem build step, é o lugar honesto.
// Vão em window.* (e não em `const`) de propósito: página que já declara a
// própria `fmt` continuaria funcionando, um `const fmt` aqui quebraria ela.
// ---------------------------------------------------------------------------

// Escapa dado que veio do servidor antes de entrar em innerHTML. Nome de
// empresa e de ponto são digitados em formulário PÚBLICO, sem autenticação, e
// depois renderizados na sessão de outra pessoa (o vendedor vê o nome da
// empresa que o anunciante digitou; o anunciante vê o nome do ponto). Sem
// isso, um cadastro com <img src=x onerror=...> roda script na conta alheia.
const ESCAPES_HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
window.esc = function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ESCAPES_HTML[c]);
};

// WhatsApp do Mostraí, num lugar só. Estava escrito à mão em 6 arquivos: mudar
// de número significava caçar string, e a mensagem pré-preenchida já tinha
// divergido entre as páginas. O formato é o oficial (wa.me): país + DDD +
// número, só dígitos — `+`, zeros e parênteses quebram no WhatsApp Web.
window.WHATSAPP = '5516994635946';

// Monta o link com a mensagem pronta. Mensagem por página é recomendação da
// referência de mercado: a conversa começa sabendo de onde a pessoa veio, em
// vez de um "oi" solto que o dono precisa decifrar.
window.linkWhatsApp = function linkWhatsApp(mensagem) {
  return `https://wa.me/${window.WHATSAPP}?text=${encodeURIComponent(mensagem)}`;
};

// Data do jeito brasileiro, com a mesma regra do servidor (src/br/formato.js):
// coluna `date` é dia de calendário, não instante, e mandá-la pelo fuso volta
// um dia inteiro. Era o que fazia a competência 09/2026 do extrato do ponto
// aparecer como 08/2026.
const SO_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
window.dataBR = function dataBR(valor, opcoes) {
  if (!valor) return '—';
  const so = SO_DATA.exec(String(valor));
  if (so && !opcoes) return `${so[3]}/${so[2]}/${so[1]}`;
  if (so) {
    const [, a, m, d] = so;
    return new Date(Number(a), Number(m) - 1, Number(d)).toLocaleDateString('pt-BR', opcoes);
  }
  return new Date(valor).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', ...(opcoes || {}) });
};

// Prazo comercial (fim de promoção, de período): a data no relógio de Matão,
// com a hora quando não é o fim do dia — "31/10/2026" se termina 23:59,
// "31/10/2026 às 00:00" se não (no início, `{ inicio: true }`, é o
// contrário: 00:00 some, qualquer outra hora aparece). Antes o site mostrava só a data no fuso do
// navegador, e uma pré-venda que acabava à meia-noite do dia 31 aparecia
// como "válida até 30/10" (D3, 24/09/2026; a regra do servidor está em
// src/lib/fuso-comercial.js). Aceita também a parede sem fuso que o
// `datetime-local` do admin produz, pra prévia dizer o mesmo que o site.
const PAREDE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
window.prazoBR = function prazoBR(valor, { inicio = false } = {}) {
  if (!valor) return '';
  const parede = !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(valor)) && PAREDE.exec(String(valor));
  let dia;
  let hora;
  if (parede) {
    dia = `${parede[3]}/${parede[2]}/${parede[1]}`;
    hora = `${parede[4]}:${parede[5]}`;
  } else {
    const d = new Date(valor);
    if (Number.isNaN(d.getTime())) return '';
    dia = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    hora = d.toLocaleTimeString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
  return hora === (inicio ? '00:00' : '23:59') ? dia : `${dia} às ${hora}`;
};

// Janela de exibição (uma hora cheia) no relógio de Matão: "hoje, 15:00–16:00",
// "amanhã, 09:00–10:00" ou "03/10, 09:00–10:00". A janela vem pronta do
// servidor (src/anunciantes/entrada-no-ar.js) — aqui só se escreve.
window.janelaBR = function janelaBR(iso) {
  if (!iso) return '';
  const inicio = new Date(iso);
  if (Number.isNaN(inicio.getTime())) return '';
  const fim = new Date(inicio.getTime() + 3_600_000);
  const fuso = { timeZone: 'America/Sao_Paulo' };
  const hora = (d) => d.toLocaleTimeString('pt-BR', { ...fuso, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dia = (d) => d.toLocaleDateString('pt-BR', { ...fuso, day: '2-digit', month: '2-digit' });
  const hoje = dia(new Date());
  const amanha = dia(new Date(Date.now() + 86_400_000));
  const nome = dia(inicio) === hoje ? 'hoje' : dia(inicio) === amanha ? 'amanhã' : dia(inicio);
  return `${nome}, ${hora(inicio)}–${hora(fim)}`;
};

// Entrada no ar de uma peça aprovada (estados do servidor, entrada-no-ar.js):
// o MESMO rótulo no painel do cliente e no admin.
window.ENTRADA_NO_AR = {
  APROVADO: { rotulo: 'Aprovado', classe: 'badge-neutro' },
  PROGRAMADO: { rotulo: 'Programado', classe: 'badge-info' },
  AGUARDANDO_PRIMEIRA_EXIBICAO: { rotulo: 'Aguardando primeira exibição', classe: 'badge-pendente' },
  NO_AR: { rotulo: 'No ar', classe: 'badge-ok' },
  ATRASADO: { rotulo: 'Entrada atrasada', classe: 'badge-err' },
  motivo: {
    sem_plano_vigente: 'a conta está sem plano vigente',
    conta_suspensa: 'a conta está suspensa',
    fora_do_limite_de_pecas: 'o plano já roda o máximo de peças ao mesmo tempo',
    acima_da_duracao_maxima: 'a peça passa da duração máxima que a conta roda hoje',
    processando: 'o arquivo ainda está sendo processado',
    sem_ponto_no_ar_na_cobertura: 'nenhum ponto da cobertura está no ar agora',
    cobertura_sem_horario_aberto: 'nenhum ponto da cobertura abre nos próximos dias',
  },
};

// Linha de condição dos banners de promoção (Home e Planos): em que ciclos
// ela vale de verdade e até quando. `ciclosComVantagem` vem do servidor (GET
// /promocoes/vigentes): só os ciclos em que o preço promocional fica abaixo
// do preço normal — o título da campanha diz "mais desconto", e o Anual, que
// já tem 20% normais, não ganha nada a mais com a pré-venda de 20% (D1,
// 24/09/2026). Devolve null quando a promoção não tem vantagem em ciclo
// nenhum: aí o banner não aparece, porque anunciaria um desconto que não
// existe.
// Nome dos ciclos e a lista "no ciclo X" / "nos ciclos X, Y e Z", num lugar
// só — o banner do painel (aqui) e o componente de promoção (promocao.js)
// escrevem a mesma frase.
window.NOME_CICLO = { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };
window.nomeDoCiclo = (meses) => window.NOME_CICLO[meses] || `${meses} meses`;
window.listaDeCiclos = function listaDeCiclos(meses) {
  const nomes = meses.map(window.nomeDoCiclo);
  if (!nomes.length) return '';
  const lista = nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}`;
  return `${nomes.length === 1 ? 'no ciclo' : 'nos ciclos'} ${lista}`;
};
window.condicaoDaPromocao = function condicaoDaPromocao(promo) {
  const ciclos = Array.isArray(promo?.ciclosComVantagem) ? promo.ciclosComVantagem : null;
  if (ciclos && !ciclos.length) return null;
  const ondeVale = ciclos?.length ? ` ${window.listaDeCiclos(ciclos)}` : '';
  const ate = promo.compra_fim ? `${ondeVale ? ',' : ''} até ${window.prazoBR(promo.compra_fim)}` : '';
  return ondeVale || ate ? `Condição válida${ondeVale}${ate}.` : '';
};

// Endereço em uma linha, com a mesma regra do servidor (src/lib/endereco.js,
// D5 de 24/09/2026): "Avenida 28 de Agosto, 2502 - Sala 3 - Alto" e, com
// `comCidade`, ", Matão/SP". Registro antigo sem as partes sai como foi
// gravado em `endereco`.
window.linhaEndereco = function linhaEndereco(e, { comCidade = false } = {}) {
  if (!e) return '';
  const rua = e.logradouro ? [e.logradouro, e.numero].filter(Boolean).join(', ') : e.endereco || '';
  const partes = [rua, e.complemento, e.bairro].filter(Boolean).join(' - ');
  if (!comCidade) return partes;
  return [partes, [e.cidade, e.uf].filter(Boolean).join('/')].filter(Boolean).join(', ');
};

// O instante como o `datetime-local` do admin espera ("2026-10-31T23:59"),
// no relógio de Matão — não em UTC, que era o que fazia a mídia própria
// andar 3h a cada "salvar", nem no fuso do navegador de quem edita.
window.paredeSP = function paredeSP(valor) {
  if (!valor) return '';
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  const p = {};
  for (const parte of new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)) {
    p[parte.type] = parte.value;
  }
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};

// Mensagem de erro que o servidor manda vira frase de tela: maiúscula na
// primeira letra e ponto final só se ainda não tiver um. Sem isto saía
// "CPF inválido — confira os números.." em toda mensagem que já terminava
// com pontuação.
// Erro de rede do próprio navegador ("Failed to fetch", "Load failed",
// "NetworkError…") nunca chega à tela em inglês: vira a frase única de sem
// conexão, em todo lugar que passa por aqui (finalização, 28/09/2026).
const SEM_CONEXAO = 'Sem conexão com o servidor. Confira a internet e tente de novo.';
window.frase = function frase(texto) {
  const t = String(texto || '').trim();
  if (!t) return '';
  if (/failed to fetch|load failed|networkerror|network request failed/i.test(t)) return SEM_CONEXAO;
  const maiuscula = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(maiuscula) ? maiuscula : `${maiuscula}.`;
};

window.fmtBRL = function fmtBRL(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

// Microvalor em reais (custo por exibição prevista, ADR-018). Regra única:
// a partir de R$ 1, duas casas; abaixo, QUATRO casas (R$ 0,0125) — e, se
// ainda assim arredondar pra zero, até seis. Valor positivo nunca aparece
// como "R$ 0,00" nem "R$ 0,01" arredondado; zero, negativo ou ausente é "-".
window.fmtMicroBRL = function fmtMicroBRL(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n >= 1) return window.fmtBRL(n);
  let casas = 4;
  while (casas < 6 && Number(n.toFixed(casas)) === 0) casas += 1;
  if (Number(n.toFixed(casas)) === 0) return '< R$ 0,000001';
  return n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  });
};

// Trava de duplo clique em qualquer formulário e em qualquer botão do site.
// Antes, dois cliques no botão de cadastro criavam duas contas / dois pontos
// / duas mensagens — e no caso do plano, duas cobranças; no admin, dois
// cliques em "Adicionar tela" criavam duas telas (finalização, 28/09/2026).
//
// Cada botão espera SÓ pelas requisições que o próprio clique disparou —
// não por "qualquer requisição em voo" (com a página buscando dados em
// paralelo, todo botão ficava preso sem motivo). Uma requisição pertence ao
// clique se começa na tarefa dele, ou na continuação de uma resposta dele
// (`await fetch` / `await r.json()`, e só então a foto: as duas são do mesmo
// botão). Sem nenhuma requisição na tarefa do clique (abrir modal,
// validação que devolve antes de pedir), o botão nem chega a travar.
//
// Formulário: o botão de enviar fica `disabled` (como sempre foi). Botão
// avulso: ganha a classe `em-voo`, e o segundo clique é engolido aqui mesmo,
// na captura — sem mexer em `disabled`, que é do handler (o "Reenviar
// código" usa disabled pro tempo de espera; a trava não pode desfazer isso).
// Teto de 15 s por segurança.
(function travarDuploEnvio() {
  const fetchOriginal = window.fetch;
  // Botão cuja tarefa está rodando agora: o clique/submit em si, a
  // continuação de um `await fetch()` dele, ou a de um `await r.json()` da
  // resposta dele. É a ele que um fetch novo pertence. Fora dessas tarefas
  // (requisição de fundo, SSE, outro botão), ninguém é dono.
  let botaoDaTarefa = null;
  const pendentes = new Map(); // botão → { pedidos, leituras } ainda em voo

  function liberar(btn) {
    pendentes.delete(btn);
    btn.classList.remove('em-voo');
    if (btn.dataset.travadoPeloEnvio) {
      btn.disabled = false;
      delete btn.dataset.travadoPeloEnvio;
    }
  }

  // Marca a tarefa atual (e suas microtarefas) como do botão; a próxima
  // macrotarefa já não é dele — e, se nada dele ficou em voo, solta.
  function continuacaoDe(btn) {
    botaoDaTarefa = btn;
    setTimeout(() => {
      if (botaoDaTarefa === btn) botaoDaTarefa = null;
      const p = pendentes.get(btn);
      if (p && p.pedidos === 0 && p.leituras === 0) liberar(btn);
    }, 0);
  }

  // `await r.json()` (ou text/blob…) resolve numa tarefa depois: a
  // continuação dela também é do botão, e enquanto lê, não solta.
  function envolverLeituras(resposta, btn) {
    for (const nome of ['json', 'text', 'blob', 'arrayBuffer', 'formData']) {
      const original = resposta[nome];
      if (typeof original !== 'function') continue;
      resposta[nome] = function (...args) {
        const p = pendentes.get(btn);
        if (p) p.leituras += 1;
        return original.apply(this, args).finally(() => {
          const q = pendentes.get(btn);
          if (q) q.leituras -= 1;
          continuacaoDe(btn);
        });
      };
    }
  }

  window.fetch = function (...args) {
    const btn = botaoDaTarefa;
    const promessa = fetchOriginal.apply(this, args);
    const p = btn && pendentes.get(btn);
    if (!p) return promessa;
    p.pedidos += 1;
    return promessa
      .then((resposta) => {
        envolverLeituras(resposta, btn);
        return resposta;
      })
      .finally(() => {
        const q = pendentes.get(btn);
        if (q) q.pedidos -= 1;
        continuacaoDe(btn);
      });
  };

  function travar(btn, comDisabled) {
    if (comDisabled) {
      btn.disabled = true;
      btn.dataset.travadoPeloEnvio = '1';
    }
    btn.classList.add('em-voo');
    pendentes.set(btn, { pedidos: 0, leituras: 0 });
    // Clique que não pediu nada (abrir modal, validação que devolve antes)
    // solta na próxima tarefa.
    continuacaoDe(btn);
    setTimeout(() => {
      if (pendentes.has(btn)) liberar(btn);
    }, 15000);
  }

  document.addEventListener(
    'submit',
    (e) => {
      const btn = e.target.querySelector('button[type="submit"], button:not([type])');
      if (!btn || btn.disabled) return;
      travar(btn, true);
    },
    true,
  );

  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest?.('button');
      if (!btn || btn.disabled) return;
      if (btn.classList.contains('em-voo')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // Botão de enviar dentro de <form>: o submit acima é quem trava.
      if (btn.form && (btn.type === 'submit' || !btn.getAttribute('type'))) return;
      travar(btn, false);
    },
    true,
  );
})();

// Barras de gráfico: a altura/largura é proporcional ao dado, então não cabe
// numa classe. Antes ia como style="width:${...}%" dentro do innerHTML — e é
// exatamente isso que obriga a CSP a liberar style-src 'unsafe-inline', porque
// atributo style vindo de markup é bloqueado, enquanto atribuir via CSSOM não
// é. O template escreve data-pct; quem aplica é este observador, que pega
// também o que for renderizado depois (todo painel monta a tela por innerHTML).
window.aplicarBarras = function aplicarBarras(raiz) {
  const alvos = (raiz || document).querySelectorAll('[data-pct]:not([data-pct-ok])');
  alvos.forEach((el) => {
    const pct = Math.max(0, Math.min(100, Number(el.dataset.pct) || 0));
    // .fill cresce pro lado (largura); tudo o resto (.bar, .bar-pilha, os
    // segmentos empilhados dentro dela) cresce de baixo pra cima (altura).
    el.style[el.classList.contains('fill') ? 'width' : 'height'] = pct + '%';
    el.setAttribute('data-pct-ok', '');
  });
};

new MutationObserver(() => window.aplicarBarras(document)).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
document.addEventListener('DOMContentLoaded', () => window.aplicarBarras(document));
