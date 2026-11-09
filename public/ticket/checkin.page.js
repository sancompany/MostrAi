// Trimundi — check-in da portaria (T8, /ticket/checkin). A câmera só extrai
// o texto do QR; quem decide é o servidor (assinatura, edição, status, uso
// único). Dois passos: consultar mostra quem é; "Confirmar entrada" registra.
// Leitor: BarcodeDetector quando o navegador tem; senão, jsQR (servido pelo
// próprio site — /ticket/jsqr.js — por causa da CSP).
(() => {
  const { el, api, dataCurta, enviando } = window.trimundi;
  const $ = (id) => document.getElementById(id);
  const ULTIMA = 'trimundi:checkin-edicao';
  let operador = null;
  let fluxo = null;
  let detector = null;
  let lendo = false;
  let ocupado = false;
  let ultimoTexto = '';
  let ultimoEm = 0;
  let contadorTimer = null;

  const TITULOS = {
    valido: 'Ingresso válido',
    entrada_registrada: 'Entrada registrada',
    ja_utilizado: 'Ingresso já utilizado',
    cancelado: 'Ingresso cancelado',
    bloqueado: 'Ingresso bloqueado',
    outra_edicao: 'Ingresso de outra edição',
    invalido: 'Ingresso inválido',
  };

  const sessaoAcabou = () => window.location.replace('/anunciante/login.html');

  async function chamar(caminho, opcoes) {
    try {
      return await api(caminho, opcoes);
    } catch (err) {
      if (err.status === 401) sessaoAcabou();
      throw err;
    }
  }

  async function iniciar() {
    $('falha').classList.add('oculto');
    $('carregando').classList.remove('oculto');
    try {
      operador = await chamar('/ticket/api/operador');
    } catch (err) {
      if (err.status === 401) return;
      $('carregando').classList.add('oculto');
      $('falha').classList.remove('oculto');
      return;
    }
    $('carregando').classList.add('oculto');
    $('ola').textContent = `Olá, ${operador.nome}.`;
    if (!operador.edicoes.length) {
      $('semEdicao').classList.remove('oculto');
      return;
    }
    const select = $('edicao');
    select.replaceChildren(...operador.edicoes.map((e) => el('option', { value: e.id, text: e.nome })));
    let guardada = null;
    try {
      guardada = localStorage.getItem(ULTIMA);
    } catch {}
    if (guardada && operador.edicoes.some((e) => String(e.id) === guardada)) select.value = guardada;
    select.addEventListener('change', () => {
      try {
        localStorage.setItem(ULTIMA, select.value);
      } catch {}
      limparResultado();
      atualizarContador();
    });
    if (operador.indicacao?.url) {
      const aside = $('indicacao');
      aside.replaceChildren(el('a', { href: operador.indicacao.url, text: operador.indicacao.texto || 'Indicação' }));
      aside.classList.remove('oculto');
    }
    $('painel').classList.remove('oculto');
    atualizarContador();
    contadorTimer = setInterval(atualizarContador, 15000);
  }

  const edicaoAtual = () => Number($('edicao').value);

  async function atualizarContador() {
    if (!edicaoAtual()) return;
    try {
      const c = await chamar(`/ticket/api/checkin/contador?edicao=${edicaoAtual()}`);
      $('contador').textContent = `Entradas: ${c.entradas} de ${c.ingressos} ingressos`;
    } catch {}
  }

  // ------------------------------------------------------------- resultado
  function limparResultado() {
    const r = $('resultado');
    r.className = 'resultado oculto';
    r.replaceChildren();
  }

  function avisar(resultado) {
    const bom = resultado === 'valido' || resultado === 'entrada_registrada';
    try {
      navigator.vibrate?.(bom ? 80 : [120, 80, 120]);
    } catch {}
  }

  function mostrarResultado(r) {
    const caixa = $('resultado');
    const i = r.ingresso;
    const linhas = [el('div', { class: 'titulo', text: TITULOS[r.resultado] || r.mensagem })];
    if (i) {
      linhas.push(el('p', { class: 'contador', text: i.participante }));
      linhas.push(
        el('p', {
          text: `${i.categoria}${i.promocao ? ` · promoção ${i.promocao}` : ''}${i.cortesia ? ' · cortesia' : ''} · ${i.codigo_curto}`,
        }),
      );
      if (i.beneficios?.length) linhas.push(listaDeBeneficios(i, r.resultado));
      if (r.resultado === 'ja_utilizado' && i.utilizado_em) {
        linhas.push(
          el('p', {
            text: `Entrou em ${dataCurta(i.utilizado_em)}${i.utilizado_por ? `, por ${i.utilizado_por}` : ''}.`,
          }),
        );
      }
      if ((r.resultado === 'bloqueado' || r.resultado === 'cancelado') && i.motivo)
        linhas.push(el('p', { text: `Motivo: ${i.motivo}` }));
    }
    const acoes = el('div', { class: 'acoes' });
    if (r.resultado === 'valido') {
      const confirmar = el('button', { class: 'btn primario grande', type: 'button', text: 'Confirmar entrada' });
      confirmar.addEventListener('click', () => confirmarEntrada(confirmar, i.id));
      acoes.append(confirmar);
      acoes.append(el('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: proximo }));
    } else {
      acoes.append(el('button', { class: 'btn primario grande', type: 'button', text: 'Próximo', onclick: proximo }));
    }
    linhas.push(acoes);
    caixa.className = `resultado ${r.resultado}`;
    caixa.replaceChildren(...linhas);
    caixa.focus();
    avisar(r.resultado);
  }

  // Benefícios do ingresso com a entrega na hora (uma vez só, registrada).
  function listaDeBeneficios(i, resultado) {
    const podeEntregar = ['valido', 'entrada_registrada', 'ja_utilizado'].includes(resultado);
    return el(
      'ul',
      { class: 'beneficios' },
      i.beneficios.map((b) => {
        const item = el('li', { class: 'chip', text: b.nome });
        if (b.resgatado_em) {
          item.append(` — entregue ${dataCurta(b.resgatado_em)}${b.resgatado_por ? ` por ${b.resgatado_por}` : ''}`);
        } else if (podeEntregar) {
          const botao = el('button', { class: 'btn mini', type: 'button', text: 'Entregar' });
          botao.addEventListener('click', async () => {
            try {
              const r = await enviando(botao, 'Registrando...', () =>
                chamar('/ticket/api/checkin/beneficio', {
                  metodo: 'POST',
                  corpo: { edicao_id: edicaoAtual(), ingresso_id: i.id, beneficio_id: b.id },
                }),
              );
              b.resgatado_em = r.resgatado_em;
              botao.replaceWith(` — ${r.resultado === 'ja_resgatado' ? 'já tinha sido entregue' : 'entregue agora'}`);
            } catch (err) {
              $('msgCamera').textContent = err.message;
            }
          });
          item.append(' ', botao);
        }
        return item;
      }),
    );
  }

  async function consultar(entrada) {
    if (ocupado) return;
    ocupado = true;
    limparResultado();
    $('msgCamera').textContent = 'Consultando...';
    try {
      const r = await chamar('/ticket/api/checkin/consultar', {
        metodo: 'POST',
        corpo: { edicao_id: edicaoAtual(), entrada },
      });
      $('msgCamera').textContent = '';
      mostrarResultado(r);
    } catch (err) {
      $('msgCamera').textContent = err.message;
      ocupado = false;
    }
  }

  async function confirmarEntrada(botao, ingressoId) {
    try {
      const r = await enviando(botao, 'Registrando...', () =>
        chamar('/ticket/api/checkin/confirmar', {
          metodo: 'POST',
          corpo: { edicao_id: edicaoAtual(), ingresso_id: ingressoId, lido_em: new Date().toISOString() },
        }),
      );
      mostrarResultado(r);
      atualizarContador();
      // Com benefício a entregar, a tela fica parada até o operador seguir.
      const pendente = r.ingresso?.beneficios?.some((b) => !b.resgatado_em);
      if (r.resultado === 'entrada_registrada' && lendo && !pendente) setTimeout(proximo, 1800);
    } catch (err) {
      $('msgCamera').textContent = err.message;
    }
  }

  function proximo() {
    limparResultado();
    ocupado = false;
    $('codigo').value = '';
    if (!lendo) $('codigo').focus();
  }

  // ---------------------------------------------------------------- câmera
  function carregarJsQr() {
    if (window.jsQR) return Promise.resolve();
    return new Promise((ok, falhou) => {
      const s = el('script', { src: '/ticket/jsqr.js' });
      s.onload = ok;
      s.onerror = () => falhou(new Error('leitor indisponível'));
      document.head.append(s);
    });
  }

  async function ligarCamera() {
    $('msgCamera').textContent = '';
    if (!navigator.mediaDevices?.getUserMedia) {
      $('msgCamera').textContent = 'Este navegador não abre a câmera — digite o código do ingresso.';
      return;
    }
    try {
      if ('BarcodeDetector' in window) {
        const formatos = await window.BarcodeDetector.getSupportedFormats?.();
        if (!formatos || formatos.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      }
      if (!detector) await carregarJsQr();
      fluxo = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (err) {
      $('msgCamera').textContent =
        err?.name === 'NotAllowedError'
          ? 'A câmera foi bloqueada. Libere o uso da câmera para este site nas configurações do navegador, ou digite o código.'
          : 'Não foi possível abrir a câmera — digite o código do ingresso.';
      return;
    }
    const video = $('video');
    video.srcObject = fluxo;
    await video.play().catch(() => {});
    $('camera').classList.remove('oculto');
    $('ligarCamera').classList.add('oculto');
    $('desligarCamera').classList.remove('oculto');
    lendo = true;
    requestAnimationFrame(ler);
  }

  function desligarCamera() {
    lendo = false;
    for (const t of fluxo?.getTracks() || []) t.stop();
    fluxo = null;
    $('camera').classList.add('oculto');
    $('ligarCamera').classList.remove('oculto');
    $('desligarCamera').classList.add('oculto');
  }

  const quadro = document.createElement('canvas');
  const ctx = quadro.getContext('2d', { willReadFrequently: true });

  async function lerQuadro(video) {
    if (detector) {
      const achados = await detector.detect(video);
      return achados[0]?.rawValue || null;
    }
    const lado = Math.min(video.videoWidth, video.videoHeight);
    if (!lado) return null;
    // Recorte central (onde fica a mira), reduzido: leitura mais rápida.
    const alvo = Math.min(640, lado);
    quadro.width = alvo;
    quadro.height = alvo;
    ctx.drawImage(video, (video.videoWidth - lado) / 2, (video.videoHeight - lado) / 2, lado, lado, 0, 0, alvo, alvo);
    const img = ctx.getImageData(0, 0, alvo, alvo);
    return window.jsQR(img.data, alvo, alvo, { inversionAttempts: 'dontInvert' })?.data || null;
  }

  async function ler() {
    if (!lendo) return;
    const video = $('video');
    if (!ocupado && video.readyState >= 2) {
      try {
        const texto = await lerQuadro(video);
        // O mesmo QR parado na frente da câmera não consulta em loop.
        if (texto && !(texto === ultimoTexto && Date.now() - ultimoEm < 4000)) {
          ultimoTexto = texto;
          ultimoEm = Date.now();
          await consultar(texto);
        }
      } catch {}
    }
    setTimeout(() => requestAnimationFrame(ler), 120);
  }

  // ------------------------------------------------------------------ início
  $('ligarCamera').addEventListener('click', ligarCamera);
  $('desligarCamera').addEventListener('click', desligarCamera);
  $('tentarDeNovo').addEventListener('click', iniciar);
  $('codigo').addEventListener('input', (e) => {
    const s = e.target.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    e.target.value = s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
  });
  $('formCodigo').addEventListener('submit', (e) => {
    e.preventDefault();
    const codigo = $('codigo').value.trim();
    if (codigo.replace(/-/g, '').length !== 8) {
      $('msgCamera').textContent = 'O código tem 8 letras e números (XXXX-XXXX).';
      return;
    }
    ocupado = false;
    consultar(codigo);
  });
  $('sair').addEventListener('click', async () => {
    desligarCamera();
    clearInterval(contadorTimer);
    await api('/ticket/api/sair', { metodo: 'POST', corpo: {} }).catch(() => {});
    window.location.replace('/anunciante/login.html');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && lendo) desligarCamera();
  });
  iniciar();
})();
