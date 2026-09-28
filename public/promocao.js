// Componente de promoção — Home, Planos e a prévia do admin montam a
// promoção por aqui, com a mesma marcação (Estação 3, 28/09/2026).
//
// Antes cada página tinha a sua cópia de um banner com a arte como FUNDO e
// selo, título, subtítulo, condição e botão por cima, sob um véu escuro. A
// arte perdia a função (o texto cobria a tela Mostraí da própria imagem) e,
// no celular, o recorte do fundo dependia da altura do texto: sumiam partes
// da imagem e a leitura dependia do véu.
//
// Agora MÍDIA e CONTEÚDO são irmãos, nunca sobrepostos: no computador, a arte
// de um lado e o texto do outro; no celular (e em qualquer caixa estreita,
// como a prévia do admin), a arte em cima e o texto embaixo. Quem decide é a
// largura do próprio componente (container query em style.css), não a da
// janela. A arte é medida antes de aparecer e entra com a proporção real
// dela (`width`/`height` no <img>): sem recorte e sem pulo de layout.
//
// Uma promoção = um bloco. Duas ou mais = carrossel sem autoplay (swipe,
// setas, indicadores e teclado); com uma só não existe seta, ponto nem
// "1/1". Classes com prefixo `campanha-`: o admin já usa `promo-*` para as
// próprias telas e carrega o mesmo style.css.
(() => {
  // Proporção declarada no admin (Ofertas → Mídia). Só é usada quando a arte
  // não chega no tempo de espera: reserva o espaço certo.
  const PROPORCAO_DECLARADA = { horizontal: [21, 9], quadrado: [1, 1], vertical: [9, 16] };
  // A seção aparece acima do hero (Home) e da grade (Planos): esperar a arte
  // mais que isso empurraria a página já pintada.
  const ESPERA_IMAGEM_MS = 800;
  const esc = (v) => window.esc(v);
  const pct = (v) => `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
  const semAcento = (t) =>
    String(t || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  const celula = (i) => `${i.tier}:${Number(i.compromissoMeses)}`;

  // Quais promoções aparecem, e com quais células. O preço de cada produto ×
  // ciclo vem da PRIMEIRA promoção vigente que tem aquela célula, na ordem do
  // servidor (`promocoesRepo.condicaoVigente`; a vitrine faz a mesma escolha
  // em planos.page.js#condicaoPromocionalVigente). Uma promoção mais antiga
  // não pode anunciar a célula que a mais nova já ocupa — seria um desconto
  // que a cobrança não dá. Sobra só o que a promoção realmente entrega; sem
  // vantagem em ciclo nenhum, ela não aparece (D1, 24/09/2026). `campo`:
  // 'mostrar_home' ou 'mostrar_planos', aplicado DEPOIS da disputa, porque a
  // cobrança não olha onde a promoção é exibida.
  function promocoesParaExibir(vigentes, campo) {
    const ocupadas = new Set();
    return (Array.isArray(vigentes) ? vigentes : [])
      .map((p) => {
        const itens = (p.itens || []).filter((i) => {
          if (ocupadas.has(celula(i))) return false;
          ocupadas.add(celula(i));
          return true;
        });
        return { ...p, itens };
      })
      .filter((p) => p[campo] && p.itens.some((i) => i.temVantagem !== false));
  }

  // "Pré-venda Mostraí: até 30% de desconto" com o selo "Pré-venda" vira
  // "Até 30% de desconto" — o selo já está logo acima. Só tira o prefixo
  // quando ele É o selo (com ou sem "Mostraí") seguido de ":" ou travessão E
  // o que sobra ainda é um título (duas palavras ou mais, com letra — "Black
  // Friday: 2026" fica como está). O texto gravado não muda.
  function tituloSemSelo(titulo, selo) {
    const t = String(titulo || '').trim();
    const s = semAcento(selo);
    if (!s) return t;
    const partes = /^(.*?)\s*[:—–-]\s+(.+)$/.exec(t);
    if (!partes) return t;
    const prefixo = semAcento(partes[1]);
    if (prefixo !== s && prefixo !== `${s} mostrai`) return t;
    const resto = partes[2].trim();
    const palavras = resto.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w));
    if (palavras.length < 2 || resto.length < 10) return t;
    return resto.charAt(0).toLocaleUpperCase('pt-BR') + resto.slice(1);
  }

  // Maior desconto de cada ciclo, só nas células que baixam o preço de
  // verdade (`temVantagem`, marcado pelo servidor). Produtos com descontos
  // diferentes no mesmo ciclo viram "até X%".
  function descontosPorCiclo(promo) {
    const porCiclo = new Map();
    for (const item of promo.itens || []) {
      if (item.temVantagem === false) continue;
      const meses = Number(item.compromissoMeses);
      const desconto = Number(item.descontoPercentual);
      const atual = porCiclo.get(meses);
      porCiclo.set(meses, {
        min: atual ? Math.min(atual.min, desconto) : desconto,
        max: atual ? Math.max(atual.max, desconto) : desconto,
      });
    }
    return [...porCiclo.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([meses, d]) => ({ meses, nome: window.nomeDoCiclo(meses), desconto: d.max, variavel: d.min !== d.max }));
  }

  // Prazo e teto de adesões — as duas regras que encerram a promoção.
  function linhaValidade(promo, { comLimite = true } = {}) {
    const fim = promo.compra_fim ? window.prazoBR(promo.compra_fim) : '';
    const limite = comLimite ? Number(promo.limite_adesoes) || 0 : 0;
    if (fim && limite) return `Adesões até ${fim} ou até o limite de ${limite} adesões.`;
    if (fim) return `Adesões até ${fim}.`;
    if (limite) return `Até o limite de ${limite} adesões.`;
    return '';
  }

  // Na Home a condição é curta: o prazo, e os ciclos só quando a promoção
  // NÃO vale em todos os ciclos em que foi configurada (D1: não anunciar
  // desconto a mais onde ele não existe).
  function condicaoCurta(promo) {
    const configurados = new Set((promo.itens || []).map((i) => Number(i.compromissoMeses)));
    const comVantagem = descontosPorCiclo(promo).map((c) => c.meses);
    const onde = comVantagem.length < configurados.size ? window.listaDeCiclos(comVantagem) : '';
    const prazo = linhaValidade(promo, { comLimite: false });
    const ondeFrase = onde ? onde.charAt(0).toUpperCase() + onde.slice(1) : '';
    if (ondeFrase && prazo) return `${ondeFrase} · ${prazo.charAt(0).toLowerCase()}${prazo.slice(1)}`;
    return ondeFrase ? `${ondeFrase}.` : prazo;
  }

  // Orientação pela proporção REAL da arte quando se sabe (o formato
  // declarado no admin pode não bater com o arquivo enviado).
  function orientacao(midia, formatoDeclarado) {
    if (midia?.largura && midia?.altura && !midia.estimada) {
      const r = midia.largura / midia.altura;
      if (r >= 1.3) return 'horizontal';
      if (r > 0.8) return 'quadrado';
      return 'vertical';
    }
    return PROPORCAO_DECLARADA[formatoDeclarado] ? formatoDeclarado : 'horizontal';
  }

  // Mede a arte antes de montar: com a proporção real no <img>, o navegador
  // reserva o espaço exato e nada é cortado. Arte que falha = promoção sem
  // mídia (o texto nunca dependeu dela). Arte lenta = espaço reservado pela
  // proporção declarada, e ela entra inteira quando chegar.
  function prepararMidia(promo) {
    const src = promo?.imagem_url;
    if (!src) return Promise.resolve(null);
    return new Promise((resolve) => {
      const img = new Image();
      const espera = setTimeout(() => {
        const [l, a] = PROPORCAO_DECLARADA[promo.formato_midia] || PROPORCAO_DECLARADA.horizontal;
        resolve({ src, largura: l * 100, altura: a * 100, estimada: true });
      }, ESPERA_IMAGEM_MS);
      img.onload = () => {
        clearTimeout(espera);
        resolve({ src, largura: img.naturalWidth, altura: img.naturalHeight });
      };
      img.onerror = () => {
        clearTimeout(espera);
        resolve(null);
      };
      img.src = src;
    });
  }

  function htmlMidia(midia, forma) {
    if (!midia) return '';
    const medidas = midia.largura && midia.altura ? ` width="${midia.largura}" height="${midia.altura}"` : '';
    // A arte é peça visual: tudo o que ela diz está no texto ao lado, então
    // é decorativa (alt vazio) — leitor de tela não repete o título.
    return `<div class="campanha-midia campanha-midia-${forma}${midia.estimada ? ' campanha-midia-estimada' : ''}">
      <img src="${esc(midia.src)}" alt=""${medidas} decoding="async" data-campanha-imagem>
    </div>`;
  }

  function htmlCiclos(promo) {
    const ciclos = descontosPorCiclo(promo);
    if (!ciclos.length) return '';
    return `<ul class="campanha-ciclos" aria-label="Desconto por ciclo">${ciclos
      .map(
        (
          c,
        ) => `<li><button type="button" class="campanha-ciclo" data-campanha-ciclo="${c.meses}" aria-controls="plansGrid"
          aria-label="Ver os planos ${esc(c.nome)}, com ${c.variavel ? 'até ' : ''}${pct(c.desconto)} de desconto"><b>${c.variavel ? 'até ' : ''}${pct(c.desconto)}</b><span>${esc(c.nome)}</span></button></li>`,
      )
      .join('')}</ul>`;
  }

  // Uma promoção, em HTML. `variante`: 'home' (curta, com "Ver planos") ou
  // 'planos' (o cliente já está no destino: descontos por ciclo, que levam
  // ao ciclo escolhido, prazo completo e as regras).
  function htmlPromocao(promo, { variante = 'home', midia = null, id = 'campanha' } = {}) {
    const forma = orientacao(midia, promo.formato_midia);
    const titulo = tituloSemSelo(promo.titulo_publico, promo.selo);
    const idTitulo = `${id}-titulo`;
    let detalhe = '';
    if (variante === 'planos') {
      const validade = linhaValidade(promo);
      detalhe = `${htmlCiclos(promo)}
        ${validade ? `<p class="campanha-validade">${esc(validade)}</p>` : ''}
        ${promo.descricao ? `<details class="campanha-regras"><summary>Como funciona</summary><p>${esc(promo.descricao)}</p></details>` : ''}`;
    } else {
      const condicao = condicaoCurta(promo);
      detalhe = `${condicao ? `<p class="campanha-validade">${esc(condicao)}</p>` : ''}
        <a class="btn primary campanha-cta" href="/planos.html">Ver planos</a>`;
    }
    return `<article class="campanha campanha-${variante} ${midia ? `campanha-com-midia campanha-forma-${forma}` : 'campanha-sem-midia'}" aria-labelledby="${idTitulo}">
      ${htmlMidia(midia, forma)}
      <div class="campanha-conteudo">
        ${promo.selo ? `<span class="campanha-selo">${esc(promo.selo)}</span>` : ''}
        <h2 class="campanha-titulo" id="${idTitulo}">${esc(titulo)}</h2>
        ${promo.subtitulo ? `<p class="campanha-texto">${esc(promo.subtitulo)}</p>` : ''}
        ${detalhe}
      </div>
    </article>`;
  }

  // Arte que falhar DEPOIS de montada (a lenta, que ainda não tinha chegado)
  // sai de cena: fica a promoção sem mídia, nunca uma caixa quebrada.
  function ligarFalhaDeImagem(raiz) {
    raiz.querySelectorAll('[data-campanha-imagem]').forEach((img) => {
      img.addEventListener(
        'error',
        () => {
          const promo = img.closest('.campanha');
          img.closest('.campanha-midia')?.remove();
          promo?.classList.remove(
            'campanha-com-midia',
            'campanha-forma-horizontal',
            'campanha-forma-quadrado',
            'campanha-forma-vertical',
          );
          promo?.classList.add('campanha-sem-midia');
        },
        { once: true },
      );
    });
  }

  // Carrossel no padrão WAI-ARIA (carousel): região rotulada, slides como
  // grupos "1 de N", setas e indicadores como botões, setas do teclado nos
  // controles, sem autoplay. O trilho rola de verdade (scroll-snap), então o
  // swipe é o do próprio navegador; slide fora da vista fica `inert` (fora do
  // Tab e do leitor de tela). <div role="region">, não <section>: a regra
  // global de `section` (style.css) somaria 64px em cima e embaixo.
  function htmlCarrossel(blocos, id, rotulos) {
    const n = blocos.length;
    return `<div class="campanha-carrossel" role="region" aria-roledescription="carrossel" aria-label="Promoções" data-campanha-carrossel>
      <div class="campanha-trilho" id="${id}-trilho" data-campanha-trilho>
        ${blocos
          .map(
            (b, i) =>
              `<div class="campanha-slide" role="group" aria-roledescription="slide" aria-label="${i + 1} de ${n}" data-campanha-slide>${b}</div>`,
          )
          .join('')}
      </div>
      <div class="campanha-navegacao">
        <button type="button" class="campanha-seta" data-campanha-anterior aria-controls="${id}-trilho" aria-label="Promoção anterior"><span aria-hidden="true">‹</span></button>
        <div class="campanha-pontos">
          ${rotulos
            .map(
              (r, i) =>
                `<button type="button" class="campanha-ponto" data-campanha-ir="${i}" aria-controls="${id}-trilho" aria-label="Promoção ${i + 1} de ${n}: ${esc(r)}"></button>`,
            )
            .join('')}
        </div>
        <button type="button" class="campanha-seta" data-campanha-proxima aria-controls="${id}-trilho" aria-label="Próxima promoção"><span aria-hidden="true">›</span></button>
      </div>
    </div>`;
  }

  function ligarCarrossel(raiz) {
    const trilho = raiz.querySelector('[data-campanha-trilho]');
    const slides = [...raiz.querySelectorAll('[data-campanha-slide]')];
    const pontos = [...raiz.querySelectorAll('[data-campanha-ir]')];
    const anterior = raiz.querySelector('[data-campanha-anterior]');
    const proxima = raiz.querySelector('[data-campanha-proxima]');
    const suave = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
    let atual = 0;
    // Enquanto a rolagem pedida por um botão anda, a posição intermediária
    // do trilho não vale como "slide atual" — sem isso o 1º→3º passava pelo
    // 2º (e o destino ficava inerte no meio do caminho).
    let destino = null;
    let largada = 0;

    const marcar = (indice) => {
      atual = indice;
      slides.forEach((s, i) => {
        s.inert = i !== indice;
      });
      pontos.forEach((p, i) => {
        if (i === indice) p.setAttribute('aria-current', 'true');
        else p.removeAttribute('aria-current');
      });
      // `aria-disabled`, não `disabled`: o botão que acabou de chegar ao fim
      // continua com o foco do teclado.
      anterior.setAttribute('aria-disabled', String(indice === 0));
      proxima.setAttribute('aria-disabled', String(indice === slides.length - 1));
    };
    const ir = (indice) => {
      const alvo = Math.max(0, Math.min(slides.length - 1, indice));
      if (alvo === atual) return;
      destino = alvo;
      largada = Date.now();
      marcar(alvo);
      // `.campanha-trilho` é `position: relative`: o offsetLeft do slide é a
      // posição dele dentro do trilho.
      trilho.scrollTo({ left: slides[alvo].offsetLeft, behavior: suave() });
    };
    // Fora de uma rolagem pedida, o índice sai da posição real do trilho —
    // vale pro swipe e pra roda do mouse.
    let quadro = 0;
    trilho.addEventListener(
      'scroll',
      () => {
        cancelAnimationFrame(quadro);
        quadro = requestAnimationFrame(() => {
          const passo = slides[0].getBoundingClientRect().width + parseFloat(getComputedStyle(trilho).columnGap || 0);
          const indice = Math.max(0, Math.min(slides.length - 1, Math.round(trilho.scrollLeft / (passo || 1))));
          if (destino !== null) {
            // Chegou, ou a rolagem pedida foi interrompida por um swipe.
            if (indice === destino || Date.now() - largada > 1200) destino = null;
            else return;
          }
          if (indice !== atual) marcar(indice);
        });
      },
      { passive: true },
    );
    anterior.addEventListener('click', () => ir(atual - 1));
    proxima.addEventListener('click', () => ir(atual + 1));
    pontos.forEach((p, i) => {
      p.addEventListener('click', () => ir(i));
    });
    // Setas do teclado só nos controles do carrossel: dentro de um slide
    // (no "Ver planos", num desconto) elas tornariam inerte o slide que tem
    // o foco.
    raiz.querySelector('.campanha-navegacao').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        ir(atual - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        ir(atual + 1);
      }
    });
    marcar(0);
  }

  // Monta as promoções dentro de `alvo` e devolve se montou alguma. Montagens
  // seguidas no mesmo alvo (a prévia do admin a cada tecla) valem pela mais
  // recente: uma medição de arte que termina atrasada não sobrescreve.
  // `aoEscolherCiclo(meses)` (Planos): o que fazer quando o cliente toca num
  // desconto por ciclo.
  const ultimaMontagem = new WeakMap();
  async function montarPromocoes(alvo, promocoes, { variante = 'home', aoEscolherCiclo = null, id = 'campanha' } = {}) {
    const lista = (Array.isArray(promocoes) ? promocoes : []).filter(Boolean);
    if (!alvo) return false;
    const vez = (ultimaMontagem.get(alvo) || 0) + 1;
    ultimaMontagem.set(alvo, vez);
    if (!lista.length) return false;
    const midias = await Promise.all(lista.map(prepararMidia));
    if (ultimaMontagem.get(alvo) !== vez) return false;
    const blocos = lista.map((p, i) => htmlPromocao(p, { variante, midia: midias[i], id: `${id}-${i}` }));
    alvo.classList.add('campanha-lista');
    alvo.innerHTML =
      lista.length === 1
        ? blocos[0]
        : htmlCarrossel(
            blocos,
            id,
            lista.map((p) => tituloSemSelo(p.titulo_publico, p.selo)),
          );
    ligarFalhaDeImagem(alvo);
    if (lista.length > 1) ligarCarrossel(alvo.querySelector('[data-campanha-carrossel]'));
    if (aoEscolherCiclo) {
      alvo.querySelectorAll('[data-campanha-ciclo]').forEach((b) => {
        b.addEventListener('click', () => aoEscolherCiclo(Number(b.dataset.campanhaCiclo)));
      });
    }
    return true;
  }

  window.montarPromocoes = montarPromocoes;
  window.htmlPromocao = htmlPromocao;
  window.promocoesParaExibir = promocoesParaExibir;
  window.promocaoUtil = { tituloSemSelo, descontosPorCiclo, linhaValidade, condicaoCurta, orientacao };
})();
