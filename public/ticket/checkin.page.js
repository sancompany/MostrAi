// Trimundi — check-in da portaria (T8, /ticket/checkin). A câmera só extrai
// o texto do QR; com internet, quem decide é o servidor (assinatura, edição,
// status, uso único). Sem internet, o aparelho decide com o pacote baixado
// (checkin-offline.js) e as entradas sobem quando a conexão volta. Dois
// passos: consultar mostra quem é; "Confirmar entrada" registra.
// Leitor: BarcodeDetector quando o navegador tem; senão, jsQR (servido pelo
// próprio site — /ticket/jsqr.js — por causa da CSP).
(() => {
  const { el, api, dataCurta, enviando } = window.trimundi;
  const off = window.tickOffline;
  // Sem rede: a última chamada falhou por conexão (ou o aparelho diz que está
  // offline). Volta a false no evento `online` ou numa chamada que deu certo.
  let semRede = false;
  const desconectado = () => semRede || navigator.onLine === false;
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
    nao_encontrado: 'Não está nos dados baixados',
  };

  const sessaoAcabou = () => window.location.replace('/ticket/entrar');

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
      off.guardarOperador(operador);
      semRede = false;
    } catch (err) {
      if (err.status === 401) return;
      // Sem internet, abrindo o app instalado: segue com o último acesso.
      const guardado = err.status === 0 ? off.operadorGuardado() : null;
      if (!guardado) {
        $('carregando').classList.add('oculto');
        $('falha').classList.remove('oculto');
        return;
      }
      operador = guardado;
      semRede = true;
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
      mostrarLink();
      mostrarOffline();
    });
    mostrarLink();
    mostrarOffline();
    $('painel').classList.remove('oculto');
    atualizarContador();
    contadorTimer = setInterval(() => {
      atualizarContador();
      manterOffline();
    }, 15000);
  }

  // ------------------------------------------------------- sem internet
  function mostrarOffline() {
    const ed = edicaoAtual();
    if (!ed) return;
    const info = off.infoDoPacote(ed);
    const r = off.resumo(ed);
    const linhas = [];
    if (desconectado()) {
      linhas.push(
        el('p', {
          class: info ? 'mensagem alerta' : 'mensagem erro',
          text: info
            ? `Sem internet — validando com os dados baixados em ${dataCurta(info.baixado_em)} (${info.ingressos} ingressos).`
            : 'Sem internet e sem os dados desta edição no aparelho. Conecte-se para baixar.',
        }),
      );
    } else {
      linhas.push(
        el('p', {
          class: 'discreto',
          text: info
            ? `Pronto para usar sem internet: ${info.ingressos} ingressos, dados de ${dataCurta(info.baixado_em)}.`
            : 'Antes de ficar sem internet, baixe os dados desta edição.',
        }),
      );
    }
    if (r.pendentes) linhas.push(el('p', { text: `${r.pendentes} entrada(s) neste aparelho aguardando envio.` }));
    if (r.conflitos)
      linhas.push(
        el('p', {
          class: 'mensagem alerta',
          text: `${r.conflitos} entrada(s) liberada(s) sem internet foram recusadas ao sincronizar (ingresso já usado em outro aparelho, cancelado ou bloqueado). O Admin vê o detalhe.`,
        }),
      );
    const baixar = el('button', {
      class: 'btn mini',
      type: 'button',
      id: 'baixarPacote',
      text: info ? 'Atualizar dados' : 'Baixar para usar sem internet',
      disabled: desconectado(),
    });
    baixar.addEventListener('click', () => baixarPacote(baixar));
    const sinc = el('button', {
      class: 'btn mini',
      type: 'button',
      id: 'sincronizar',
      text: 'Sincronizar agora',
      disabled: desconectado() || !r.pendentes,
    });
    sinc.addEventListener('click', () => sincronizarAgora(sinc));
    $('offline').replaceChildren(...linhas, el('div', { class: 'acoes' }, baixar, sinc));
    $('offline').classList.remove('oculto');
  }

  async function baixarPacote(botao) {
    const ed = edicaoAtual();
    try {
      const p = await enviando(botao, 'Baixando...', () => chamar(`/ticket/api/checkin/pacote?edicao=${ed}`));
      semRede = false;
      if (!off.salvarPacote(ed, p)) $('msgCamera').textContent = 'Sem espaço no aparelho para guardar os dados.';
    } catch (err) {
      if (err.status === 0) semRede = true;
      $('msgCamera').textContent = err.message;
    }
    mostrarOffline();
  }

  let sincronizando = false;
  async function sincronizarAgora(botao = null) {
    const ed = edicaoAtual();
    if (sincronizando || !ed || !off.pendentes(ed).length) return;
    sincronizando = true;
    try {
      const fazer = () => off.sincronizar(ed, chamar);
      const r = botao ? await enviando(botao, 'Enviando...', fazer) : await fazer();
      semRede = false;
      if (r.conflitos) $('msgCamera').textContent = `${r.conflitos} entrada(s) recusada(s) ao sincronizar.`;
      atualizarContador();
    } catch (err) {
      if (err.status === 0) semRede = true;
      else if (botao) $('msgCamera').textContent = err.message;
    } finally {
      sincronizando = false;
      mostrarOffline();
    }
  }

  // A cada 15 s: com internet, sobe o pendente e mantém o pacote fresco (o
  // "já entrou" de outros aparelhos chega aqui).
  let ultimoPacote = 0;
  async function manterOffline() {
    const ed = edicaoAtual();
    if (!ed || navigator.onLine === false) return;
    if (off.pendentes(ed).length) await sincronizarAgora();
    const info = off.infoDoPacote(ed);
    if (info && !semRede && Date.now() - ultimoPacote > 5 * 60000) {
      ultimoPacote = Date.now();
      try {
        off.salvarPacote(ed, await chamar(`/ticket/api/checkin/pacote?edicao=${ed}`));
      } catch (err) {
        if (err.status === 0) semRede = true;
      }
      mostrarOffline();
    }
  }

  const edicaoAtual = () => Number($('edicao').value);

  // Link de indicação do operador (todo operador tem um, 10/11/2026) na
  // edição escolhida: quem comprar por ele fica registrado como indicado por
  // este operador. Sem lista de compradores aqui — isso é do Admin.
  function mostrarLink() {
    const aside = $('indicacao');
    const l = operador.indicacao?.links?.find((x) => Number(x.edicao_id) === edicaoAtual());
    if (!l) {
      aside.classList.add('oculto');
      return;
    }
    const copiar = el('button', { class: 'btn mini', type: 'button', text: 'Copiar' });
    copiar.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(l.link);
        copiar.textContent = 'Copiado';
      } catch {
        copiar.textContent = 'Selecione e copie';
      }
    });
    const c = operador.indicacao.campanhas?.find((x) => x.link === l.link);
    aside.replaceChildren(
      el('p', { class: 'discreto', text: 'Seu link de indicação para este evento' }),
      el('input', { class: 'link-indicacao', readonly: true, value: l.link, 'aria-label': 'Seu link de indicação' }),
      copiar,
      c
        ? el('p', { class: 'discreto', text: `${c.conversoes} indicação(ões) paga(s) na promoção ${c.campanha}` })
        : null,
    );
    aside.classList.remove('oculto');
  }

  async function atualizarContador() {
    if (!edicaoAtual()) return;
    const local = () => {
      const r = off.resumo(edicaoAtual());
      $('contador').textContent = `Sem internet · ${r.entradas} entrada(s) registradas neste aparelho`;
    };
    if (desconectado()) return local();
    try {
      const c = await chamar(`/ticket/api/checkin/contador?edicao=${edicaoAtual()}`);
      const p = off.pendentes(edicaoAtual()).length;
      $('contador').textContent = `Entradas: ${c.entradas} de ${c.ingressos} ingressos${p ? ` · ${p} a enviar` : ''}`;
    } catch (err) {
      if (err.status === 0) {
        semRede = true;
        local();
        mostrarOffline();
      }
    }
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
          text: [
            i.categoria,
            i.promocao ? `promoção ${i.promocao}` : null,
            i.cortesia ? 'cortesia' : null,
            i.codigo_curto || null,
          ]
            .filter(Boolean)
            .join(' · '),
        }),
      );
      // Evento com idade mínima: o operador confere o documento com foto.
      const edicao = operador.edicoes.find((e) => Number(e.id) === edicaoAtual());
      const idade = r.classificacao_etaria || edicao?.classificacao_etaria;
      if (idade && idade !== 'livre' && ['valido', 'entrada_registrada'].includes(r.resultado)) {
        linhas.push(
          el('p', {
            class: 'mensagem alerta',
            text: `Evento ${idade} anos: confira documento oficial com foto e a idade.`,
          }),
        );
      }
      if (i.beneficios?.length) linhas.push(listaDeBeneficios(i, r.resultado));
      if (r.offline && i.utilizado_aqui) {
        linhas.push(el('p', { text: `Entrou por este aparelho em ${dataCurta(i.utilizado_em)}.` }));
      } else if (r.resultado === 'ja_utilizado' && i.utilizado_em) {
        linhas.push(
          el('p', {
            text: `Entrou em ${dataCurta(i.utilizado_em)}${i.utilizado_por ? `, por ${i.utilizado_por}` : ''}.`,
          }),
        );
      }
      if ((r.resultado === 'bloqueado' || r.resultado === 'cancelado') && i.motivo)
        linhas.push(el('p', { text: `Motivo: ${i.motivo}` }));
    }
    if (r.offline) {
      linhas.push(
        el('p', {
          class: 'discreto selo-offline',
          text:
            r.resultado === 'nao_encontrado'
              ? 'Validado sem internet: este código não está nos dados baixados (ingresso emitido depois, ou falso). Não libere; confira quando a internet voltar.'
              : r.resultado === 'entrada_registrada'
                ? 'Registrada sem internet: sobe para o servidor quando a conexão voltar.'
                : `Validado sem internet${r.assinatura === 'conferida' ? ' · assinatura do QR conferida' : ''}. Benefícios só com internet.`,
        }),
      );
    }
    const acoes = el('div', { class: 'acoes' });
    if (r.resultado === 'valido') {
      const confirmar = el('button', { class: 'btn primario grande', type: 'button', text: 'Confirmar entrada' });
      confirmar.addEventListener('click', () => (r.offline ? confirmarLocal(i.id) : confirmarEntrada(confirmar, i.id)));
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

  let ultimoLocal = null;
  async function consultarLocal(entrada) {
    const r = await off.validar(edicaoAtual(), entrada);
    ultimoLocal = r;
    if (r.resultado === 'sem_pacote') {
      $('msgCamera').textContent = 'Sem internet e sem os dados desta edição no aparelho — não dá para validar agora.';
      ocupado = false;
      return;
    }
    $('msgCamera').textContent = '';
    mostrarResultado(r);
  }

  function confirmarLocal(ingressoId) {
    const r = off.registrarEntrada(edicaoAtual(), ingressoId);
    if (r.resultado === 'sem_espaco') {
      $('msgCamera').textContent = 'Sem espaço no aparelho para guardar a entrada.';
      return;
    }
    // Mostra o mesmo ingresso, agora como entrada registrada (ou já usado).
    mostrarResultado({ ...ultimoLocal, resultado: r.resultado });
    atualizarContador();
    mostrarOffline();
    if (r.resultado === 'entrada_registrada' && lendo) setTimeout(proximo, 1800);
  }

  async function consultar(entrada) {
    if (ocupado) return;
    ocupado = true;
    limparResultado();
    if (desconectado()) return consultarLocal(entrada);
    $('msgCamera').textContent = 'Consultando...';
    try {
      const r = await chamar('/ticket/api/checkin/consultar', {
        metodo: 'POST',
        corpo: { edicao_id: edicaoAtual(), entrada },
      });
      $('msgCamera').textContent = '';
      mostrarResultado(r);
    } catch (err) {
      // Caiu a conexão no meio: com pacote, valida aqui mesmo.
      if (err.status === 0 && off.infoDoPacote(edicaoAtual())) {
        semRede = true;
        mostrarOffline();
        return consultarLocal(entrada);
      }
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
      if (r.resultado === 'entrada_registrada') off.marcarUtilizado(edicaoAtual(), ingressoId);
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
    // Entrada registrada sem internet e ainda não enviada não pode se perder.
    if (off.totalPendente()) {
      await sincronizarAgora();
      const resta = off.totalPendente();
      if (resta) {
        $('msgCamera').textContent =
          `Ainda há ${resta} entrada(s) deste aparelho sem enviar. Conecte-se e sincronize antes de sair.`;
        return;
      }
    }
    desligarCamera();
    clearInterval(contadorTimer);
    await api('/ticket/api/sair', { metodo: 'POST', corpo: {} }).catch(() => {});
    off.limparAoSair();
    window.location.replace('/ticket/entrar');
  });
  window.addEventListener('online', () => {
    semRede = false;
    if (operador) {
      mostrarOffline();
      sincronizarAgora();
      atualizarContador();
    }
  });
  window.addEventListener('offline', () => {
    semRede = true;
    if (operador) {
      mostrarOffline();
      atualizarContador();
    }
  });
  // Instalável no celular (PWA): o service worker guarda a casca da página
  // para abrir sem internet. Os dados vêm do pacote (checkin-offline.js).
  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('/ticket/checkin-sw.js', { scope: '/ticket/' }).catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && lendo) desligarCamera();
  });
  iniciar();
})();
