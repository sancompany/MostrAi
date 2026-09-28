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
  // cobrança não olha onde a promoção é exibida. `campo` null (barra da área
  // logada): sem filtro de exposição, só a disputa de células.
  function promocoesParaExibir(vigentes, campo = null) {
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
      .filter((p) => (!campo || p[campo]) && p.itens.some((i) => i.temVantagem !== false));
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
  // verdade (`temVantagem`, marcado pelo servidor). Vira "até X%" quando os
  // produtos do ciclo têm descontos diferentes OU quando algum produto
  // exibido no ciclo fica sem ele — "30% Mensal" levaria a planos Mensal sem
  // os 30%. `tiersDoCiclo(meses)` (Planos): os produtos que a grade mostra
  // naquele ciclo; sem ele, valem os produtos configurados na promoção.
  function descontosPorCiclo(promo, tiersDoCiclo = null) {
    const porCiclo = new Map();
    const configurados = new Map();
    for (const item of promo.itens || []) {
      const meses = Number(item.compromissoMeses);
      if (!configurados.has(meses)) configurados.set(meses, new Set());
      configurados.get(meses).add(item.tier);
      if (item.temVantagem === false) continue;
      const desconto = Number(item.descontoPercentual);
      const atual = porCiclo.get(meses) || { min: desconto, max: desconto, tiers: new Set() };
      atual.min = Math.min(atual.min, desconto);
      atual.max = Math.max(atual.max, desconto);
      atual.tiers.add(item.tier);
      porCiclo.set(meses, atual);
    }
    return [...porCiclo.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([meses, d]) => {
        const exibidos = tiersDoCiclo?.(meses);
        const produtos = exibidos?.length ? exibidos : [...configurados.get(meses)];
        const parcial = produtos.some((t) => !d.tiers.has(t));
        return { meses, nome: window.nomeDoCiclo(meses), desconto: d.max, variavel: d.min !== d.max || parcial };
      });
  }

  // A OFERTA — o que a promoção grita (reforço visual, 28/09/2026): o maior
  // desconto que ela realmente dá (só células com vantagem, as mesmas de
  // `descontosPorCiclo`), com "até" quando os ciclos/produtos não têm todos
  // o mesmo desconto. Sem desconto com vantagem, null (o bloco volta a usar
  // o título como manchete). Nada aqui é regra comercial: é leitura dos
  // mesmos itens que a vitrine e a cobrança usam.
  function ofertaDaPromocao(promo, tiersDoCiclo = null) {
    const ciclos = descontosPorCiclo(promo, tiersDoCiclo);
    if (!ciclos.length) return null;
    const maior = Math.max(...ciclos.map((c) => c.desconto));
    const ate = ciclos.some((c) => c.variavel) || new Set(ciclos.map((c) => c.desconto)).size > 1;
    // "Melhor desconto" só quando UM ciclo tem o maior desconto, e há outros
    // pra comparar — senão o marcador não diferencia nada.
    const doMaior = ciclos.filter((c) => c.desconto === maior);
    const melhorCiclo = ciclos.length > 1 && doMaior.length === 1 ? doMaior[0].meses : null;
    return { desconto: maior, ate, melhorCiclo };
  }

  // O título ainda diz algo que a oferta não diz? "Até 30% de desconto" ao
  // lado de "ATÉ 30% OFF" é a mesma frase duas vezes e sai; "Semana do
  // comércio: 30% no Anual" tem contexto e fica. Tira do título a frase da
  // oferta (o percentual exato, com "até", "de desconto"/"off" em volta) e vê
  // se sobra palavra de verdade. O número precisa bater inteiro: "30,5%" não
  // é "5%" (revisão independente, 28/09/2026).
  function tituloRedundante(titulo, oferta) {
    if (!oferta) return false;
    const numero = pct(oferta.desconto).replace('%', '').replace(/[.,]/g, '[.,]');
    const frase = new RegExp(`(^|[^\\d.,])(at[eé]\\s+)?${numero}\\s*%(\\s*(de\\s+desconto|off))?`, 'iu');
    const t = String(titulo || '');
    if (!frase.test(t)) return false;
    const resto = t.replace(frase, '$1');
    return !resto.split(/\s+/).some((w) => /\p{L}{2,}/u.test(w));
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

  // Planos: cada ciclo é um bloco de desconto clicável (leva ao ciclo na
  // grade). Home: os mesmos blocos, só leitura (o CTA é "Ver planos").
  function htmlCiclos(promo, tiersDoCiclo, { clicavel = true, melhorCiclo = null } = {}) {
    const ciclos = descontosPorCiclo(promo, tiersDoCiclo);
    if (!ciclos.length) return '';
    const bloco = (c) => {
      const valor = `${c.variavel ? '<small>até</small> ' : ''}${pct(c.desconto)}`;
      const melhor = c.meses === melhorCiclo;
      // Na faixa compacta da Home o marcador encurta pra caber em 4 blocos
      // numa linha (o leitor de tela ouve "o melhor desconto" nos dois).
      const selo = melhor
        ? `<span class="campanha-ciclo-melhor" aria-hidden="true">${clicavel ? 'Melhor desconto' : 'Melhor'}</span>`
        : '';
      const falado = `${esc(c.nome)}: ${c.variavel ? 'até ' : ''}${pct(c.desconto)} de desconto${melhor ? ', o melhor desconto' : ''}`;
      return clicavel
        ? `<li><button type="button" class="campanha-ciclo${melhor ? ' campanha-ciclo-destaque' : ''}" data-campanha-ciclo="${c.meses}" aria-controls="plansGrid"
          aria-label="Ver os planos ${falado}">${selo}<b>${valor}</b><span>${esc(c.nome)}</span></button></li>`
        : // Item de lista não tem nome por aria-label (NVDA ignora): o leitor
          // de tela lê o próprio texto, com o que falta em .campanha-sr —
          // "até 10% de desconto no Mensal, o melhor desconto".
          `<li class="campanha-ciclo${melhor ? ' campanha-ciclo-destaque' : ''}">${selo}<b>${valor}</b><span class="campanha-sr"> de desconto no </span><span>${esc(c.nome)}</span>${melhor ? '<span class="campanha-sr">, o melhor desconto</span>' : ''}</li>`;
    };
    return `<ul class="campanha-ciclos${clicavel ? '' : ' campanha-ciclos-leitura'}" aria-label="Desconto por ciclo">${ciclos.map(bloco).join('')}</ul>`;
  }

  // A mesma oferta em uma linha (barra da área logada): "Até 30% OFF" na
  // tela, "Até 30% de desconto" no leitor de tela.
  function htmlOfertaCurta(oferta) {
    return `${oferta.ate ? 'Até ' : ''}${pct(oferta.desconto)} <span aria-hidden="true">OFF</span><span class="campanha-sr"> de desconto</span>`;
  }

  // Manchete da oferta: "ATÉ 30% OFF" na tela, "Até 30% de desconto" no
  // leitor de tela ("OFF" é visual; a frase falada é a completa).
  function htmlOferta(oferta) {
    return `<span class="campanha-oferta">${oferta.ate ? '<span class="campanha-oferta-ate">Até</span> ' : ''}<span class="campanha-oferta-num">${pct(oferta.desconto)}</span> <span class="campanha-oferta-off" aria-hidden="true">OFF</span><span class="campanha-sr"> de desconto</span></span>`;
  }

  // Uma promoção, em HTML. `variante`: 'home' (curta, com "Ver planos") ou
  // 'planos' (o cliente já está no destino: descontos por ciclo, que levam
  // ao ciclo escolhido, prazo completo e as regras).
  //
  // Hierarquia (reforço visual, 28/09/2026): selo (contexto) → título só se
  // disser algo além da oferta → OFERTA ("ATÉ 30% OFF", a manchete) →
  // benefício (subtítulo) → descontos por ciclo → ação → prazo. A arte
  // continua fora do texto.
  function htmlPromocao(promo, { variante = 'home', midia = null, id = 'campanha', tiersDoCiclo = null } = {}) {
    const forma = orientacao(midia, promo.formato_midia);
    const titulo = tituloSemSelo(promo.titulo_publico, promo.selo);
    const oferta = ofertaDaPromocao(promo, tiersDoCiclo);
    const idTitulo = `${id}-titulo`;
    const validade = linhaValidade(promo);
    // "Tempo limitado" só quando há prazo — só o teto de adesões não é tempo.
    const urgencia = promo.compra_fim ? '<span class="campanha-urgencia">Tempo limitado</span> ' : '';
    const manchete = oferta
      ? `${tituloRedundante(titulo, oferta) ? '' : `<p class="campanha-contexto">${esc(titulo)}</p>`}
        <h2 class="campanha-titulo campanha-titulo-oferta" id="${idTitulo}">${htmlOferta(oferta)}</h2>`
      : `<h2 class="campanha-titulo" id="${idTitulo}">${esc(titulo)}</h2>`;
    let detalhe = '';
    if (variante === 'planos') {
      detalhe = `${htmlCiclos(promo, tiersDoCiclo, { melhorCiclo: oferta?.melhorCiclo })}
        ${validade ? `<p class="campanha-validade">${urgencia}${esc(validade)}</p>` : ''}
        ${promo.descricao ? `<details class="campanha-regras"><summary>Como funciona</summary><p>${esc(promo.descricao)}</p></details>` : ''}`;
    } else {
      // Home: os descontos por ciclo só pra leitura rápida (clicar leva a
      // Planos pelo CTA); na Home a ação é uma só.
      detalhe = `${htmlCiclos(promo, null, { clicavel: false, melhorCiclo: oferta?.melhorCiclo })}
        <div class="campanha-acao">
          <a class="btn campanha-cta" href="/planos.html">Ver planos</a>
          ${validade ? `<p class="campanha-validade">${urgencia}${esc(validade)}</p>` : ''}
        </div>`;
    }
    return `<article class="campanha campanha-${variante} ${midia ? `campanha-com-midia campanha-forma-${forma}` : 'campanha-sem-midia'}" aria-labelledby="${idTitulo}">
      ${htmlMidia(midia, forma)}
      <div class="campanha-conteudo">
        ${promo.selo ? `<span class="campanha-selo">${esc(promo.selo)}</span>` : ''}
        ${manchete}
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
    const indiceNaPosicao = () => {
      const passo = slides[0].getBoundingClientRect().width + parseFloat(getComputedStyle(trilho).columnGap || 0);
      return Math.max(0, Math.min(slides.length - 1, Math.round(trilho.scrollLeft / (passo || 1))));
    };
    // Trilho parado: vale onde ele está, tenha a rolagem pedida chegado ou
    // sido interrompida por um swipe no meio (senão o slide à vista ficava
    // inerte e os pontos marcavam o destino que não chegou).
    let parada = 0;
    const assentar = () => {
      destino = null;
      const indice = indiceNaPosicao();
      if (indice !== atual) marcar(indice);
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
      // Rede de segurança pra uma rolagem que não dispara evento nenhum.
      clearTimeout(parada);
      parada = setTimeout(assentar, 1300);
    };
    // Fora de uma rolagem pedida, o índice sai da posição real do trilho —
    // vale pro swipe e pra roda do mouse.
    let quadro = 0;
    trilho.addEventListener(
      'scroll',
      () => {
        clearTimeout(parada);
        parada = setTimeout(assentar, 150);
        cancelAnimationFrame(quadro);
        quadro = requestAnimationFrame(() => {
          const indice = indiceNaPosicao();
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
  async function montarPromocoes(
    alvo,
    promocoes,
    { variante = 'home', aoEscolherCiclo = null, tiersDoCiclo = null, id = 'campanha' } = {},
  ) {
    const lista = (Array.isArray(promocoes) ? promocoes : []).filter(Boolean);
    if (!alvo) return false;
    const vez = (ultimaMontagem.get(alvo) || 0) + 1;
    ultimaMontagem.set(alvo, vez);
    if (!lista.length) return false;
    const midias = await Promise.all(lista.map(prepararMidia));
    if (ultimaMontagem.get(alvo) !== vez) return false;
    const blocos = lista.map((p, i) => htmlPromocao(p, { variante, midia: midias[i], id: `${id}-${i}`, tiersDoCiclo }));
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
  window.promocaoUtil = {
    tituloSemSelo,
    htmlOfertaCurta,
    descontosPorCiclo,
    ofertaDaPromocao,
    tituloRedundante,
    linhaValidade,
    orientacao,
  };
})();
