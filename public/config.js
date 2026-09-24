// Aponta pra API certa em dev (Express local) vs produção (Render).
// ponytail: sem build step, então isso é JS puro incluído antes dos outros
// scripts — não precisa de bundler pra trocar a URL por ambiente.
// Localhost E IP de rede local: quando a TV do ponto abre o player pelo IP do
// computador (ex.: http://192.168.0.10:3000/player.html), o hostname não é
// "localhost" — antes disso cair aqui, ela ia tentar falar com a API de
// produção e o player ficava eternamente em "offline, tocando o cache" sem
// dizer o porquê. Como o próprio Express serve o site, mesma origem resolve
// os dois casos (e leva a porta junto).
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

// Linha de condição dos banners de promoção (Home e Planos): em que ciclos
// ela vale de verdade e até quando. `ciclosComVantagem` vem do servidor (GET
// /promocoes/vigentes): só os ciclos em que o preço promocional fica abaixo
// do preço normal — o título da campanha diz "mais desconto", e o Anual, que
// já tem 20% normais, não ganha nada a mais com a pré-venda de 20% (D1,
// 24/09/2026). Devolve null quando a promoção não tem vantagem em ciclo
// nenhum: aí o banner não aparece, porque anunciaria um desconto que não
// existe.
const NOME_CICLO_PROMO = { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };
window.condicaoDaPromocao = function condicaoDaPromocao(promo) {
  const ciclos = Array.isArray(promo?.ciclosComVantagem) ? promo.ciclosComVantagem : null;
  if (ciclos && !ciclos.length) return null;
  const nomes = (ciclos || []).map((m) => NOME_CICLO_PROMO[m] || `${m} meses`);
  const ondeVale = nomes.length
    ? ` ${nomes.length === 1 ? 'no ciclo' : 'nos ciclos'} ${nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}`}`
    : '';
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
window.frase = function frase(texto) {
  const t = String(texto || '').trim();
  if (!t) return '';
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

// Trava de duplo clique em qualquer formulário do site. Antes, dois cliques
// no botão de cadastro criavam duas contas / dois pontos / duas mensagens —
// e no caso do plano, duas cobranças. Libera quando não há mais requisição em
// voo, com um teto de 15s caso o handler não faça nenhuma.
(function travarDuploEnvio() {
  let emVoo = 0;
  const travados = new Set();
  const fetchOriginal = window.fetch;

  function liberar() {
    travados.forEach((btn) => {
      btn.disabled = false;
    });
    travados.clear();
  }

  window.fetch = function (...args) {
    emVoo += 1;
    return fetchOriginal.apply(this, args).finally(() => {
      emVoo = Math.max(0, emVoo - 1);
      if (emVoo === 0) liberar();
    });
  };

  document.addEventListener(
    'submit',
    (e) => {
      const btn = e.target.querySelector('button[type="submit"], button:not([type])');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      travados.add(btn);
      setTimeout(liberar, 15000);
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
