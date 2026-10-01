// Endereço no navegador (estação de endereços, 01/10/2026) — o que todo
// formulário de endereço do site usa, num lugar só. Antes o CEP morava em
// formulario.js e cada formulário desenhava campos e limites do seu jeito:
// o Número cortava em 20 caracteres sem avisar ninguém.
//
//   camposEndereco(prefixo, opcoes)  os sete campos (CEP, logradouro, número,
//                                    complemento, bairro, cidade, UF)
//   ligarCep(escopo)                 CEP → ViaCEP → o resto preenchido, e a
//                                    regra do Número (limites, dica, aviso)
//   enderecoDoForm(form)             o corpo pra API, com `numero_confirmado`
//   ligarMapaDoEndereco(form, alvo)  o mapa pequeno do formulário de ponto
//   htmlMapaDoEndereco(endereco)     o mesmo mapa, só leitura (ficha do ponto)
//
// Requer /config.js (esc) e /endereco-regras.js (limites e leitura do Número
// — os mesmos do servidor) antes. O servidor é a fonte da verdade: aqui só se
// avisa antes de enviar. Sem dependência externa: a ViaCEP é pública e o
// mapa é o embed do Google sem chave (CSP: frame-src www.google.com).
(function () {
  const R = window.enderecoRegras;
  const DICA_NUMERO = 'Informe somente o número ou identificador do imóvel.';
  const esc = (v) => window.esc(v ?? '');
  const limite = (parte) => (R ? ` maxlength="${R.LIMITES[parte]}"` : '');

  // Os sete campos, com a mesma marcação em todo formulário que os desenha
  // (candidatura de ponto, edição do endereço do ponto, Admin). `valores`
  // preenche (edição); cidade/UF padrão só valem pra campo vazio.
  window.camposEndereco = function camposEndereco(prefixo = '', opcoes = {}) {
    const {
      valores = {},
      cidadePadrao = '',
      ufPadrao = '',
      textoCep = 'Digite o CEP e o resto vem preenchido.',
    } = opcoes;
    const id = (parte) => `${prefixo}${parte}`;
    const valor = (parte, padrao = '') => esc(valores[parte] || padrao);
    return `
    <div class="field-row endereco-linha endereco-linha-cep">
      <div class="u-col campo campo-cep"><label for="${id('cep')}">CEP</label><input id="${id('cep')}" name="cep" data-cep inputmode="numeric" autocomplete="postal-code"${limite('cep')} placeholder="00000-000" aria-describedby="${id('cep_msg')}" value="${valor('cep')}" required></div>
      <div class="u-col-2 campo campo-logradouro"><label for="${id('logradouro')}">Logradouro</label><input id="${id('logradouro')}" name="logradouro" autocomplete="address-line1"${limite('logradouro')} placeholder="Rua, avenida..." value="${valor('logradouro')}" required></div>
      <div class="u-col campo campo-numero"><label for="${id('numero')}">Número</label><input id="${id('numero')}" name="numero" autocomplete="off"${limite('numero')} value="${valor('numero')}" required></div>
    </div>
    <p class="form-hint" id="${id('cep_msg')}" data-cep-msg aria-live="polite">${esc(textoCep)}</p>
    <div class="field-row endereco-linha endereco-linha-complemento">
      <div class="u-col-2 campo"><label for="${id('complemento')}">Complemento</label><input id="${id('complemento')}" name="complemento" autocomplete="address-line2"${limite('complemento')} placeholder="Opcional" value="${valor('complemento')}"></div>
      <div class="u-col-2 campo"><label for="${id('bairro')}">Bairro</label><input id="${id('bairro')}" name="bairro" autocomplete="address-level3"${limite('bairro')} value="${valor('bairro')}" required></div>
    </div>
    <div class="field-row endereco-linha endereco-linha-cidade">
      <div class="u-col-2 campo"><label for="${id('cidade')}">Cidade</label><input id="${id('cidade')}" name="cidade" autocomplete="address-level2"${limite('cidade')} value="${valor('cidade', cidadePadrao)}" required></div>
      <div class="u-col campo campo-uf"><label for="${id('uf')}">UF</label><input id="${id('uf')}" name="uf" autocomplete="address-level1" autocapitalize="characters"${limite('uf')} value="${valor('uf', ufPadrao)}" required></div>
    </div>`;
  };

  // O corpo que a API espera (src/lib/endereco.js): as partes, cada uma
  // aparada, e se a pessoa confirmou um Número que parecia endereço.
  window.enderecoDoForm = function enderecoDoForm(form) {
    const valor = (nome) => form.querySelector(`[name="${nome}"]`)?.value.trim() ?? '';
    return {
      cep: valor('cep'),
      logradouro: valor('logradouro'),
      numero: valor('numero'),
      complemento: valor('complemento') || null,
      bairro: valor('bairro') || null,
      cidade: valor('cidade'),
      uf: valor('uf').toUpperCase(),
      numero_confirmado: valor('numero_confirmado') === '1',
    };
  };

  // ---------- Número ----------
  // O caso real (01/10/2026): a rua digitada no campo Número e cortada em 20
  // caracteres pelo `maxlength`. Agora o campo tem o limite da regra (30),
  // diz o que vai nele (placeholder + dica embaixo) e, quando o que foi
  // digitado parece endereço, avisa — sem corrigir nada e sem impedir: o
  // primeiro envio para no aviso, o segundo com o mesmo valor segue, marcado
  // como confirmado (o servidor então não abre a pendência).
  function ligarNumero(form) {
    if (!form || form === document || form.dataset.numeroLigado) return;
    const numero = form.querySelector('[name="numero"]');
    if (!numero) return;
    form.dataset.numeroLigado = '1';
    if (R) {
      for (const [parte, max] of Object.entries(R.LIMITES)) {
        form.querySelectorAll(`input[name="${parte}"]`).forEach((campo) => {
          campo.maxLength = max;
        });
      }
    }
    if (!numero.placeholder) numero.placeholder = 'Ex.: 123, 12A, T10 ou S/N';
    let dica = form.querySelector('[data-numero-dica]');
    if (!dica) {
      dica = document.createElement('p');
      dica.className = 'form-hint campo-numero-dica';
      dica.dataset.numeroDica = '';
      dica.id = `${numero.id || 'numero'}_dica`;
      dica.setAttribute('aria-live', 'polite');
      numero.insertAdjacentElement('afterend', dica);
    }
    dica.textContent = DICA_NUMERO;
    const descritores = (numero.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!descritores.includes(dica.id)) numero.setAttribute('aria-describedby', [...descritores, dica.id].join(' '));
    let confirmado = form.querySelector('input[name="numero_confirmado"]');
    if (!confirmado) {
      confirmado = document.createElement('input');
      confirmado.type = 'hidden';
      confirmado.name = 'numero_confirmado';
      form.appendChild(confirmado);
    }
    confirmado.value = '';
    let avisadoPara = null;

    const suspeito = () => !!R && R.numeroSuspeito(numero.value);
    const pintar = (texto) => {
      const s = suspeito();
      dica.textContent = s ? texto || R.AVISO_NUMERO : DICA_NUMERO;
      dica.classList.toggle('aviso-numero', s);
    };
    numero.addEventListener('blur', () => pintar());
    numero.addEventListener('input', () => {
      // Mudou o valor: a confirmação era do valor anterior.
      confirmado.value = '';
      avisadoPara = null;
      if (dica.classList.contains('aviso-numero')) pintar();
    });
    // Captura: roda antes do envio da página (que é registrado no mesmo
    // form, sem captura) e o segura uma vez só.
    form.addEventListener(
      'submit',
      (ev) => {
        if (numero.disabled || !suspeito()) return;
        const valor = numero.value.trim();
        if (avisadoPara === valor) {
          confirmado.value = '1';
          return;
        }
        ev.preventDefault();
        ev.stopImmediatePropagation();
        avisadoPara = valor;
        pintar(`${R.AVISO_NUMERO} Se estiver certo assim, é só enviar de novo.`);
        numero.focus({ preventScroll: true });
        numero.scrollIntoView({ block: 'center' });
      },
      true,
    );
  }

  // ---------- CEP (ViaCEP) ----------
  // data-cep no input do CEP; os campos preenchidos são procurados pelo name
  // dentro do mesmo formulário (logradouro/bairro/cidade/uf — D5, 24/09/2026).
  // O aviso embaixo do CEP diz em que pé está a consulta (`data-estado`:
  // consultando, encontrado, nao-encontrado, erro). Consulta só no blur com
  // 8 dígitos. ViaCEP fora do ar ou CEP desconhecido nunca impede de salvar:
  // a pessoa preenche à mão.
  function ligarCep(escopo) {
    (escopo || document).querySelectorAll('[data-cep]').forEach((input) => {
      const form = input.closest('form') || document;
      ligarNumero(form);
      if (input.dataset.cepLigado) return;
      input.dataset.cepLigado = '1';
      const achar = (nome) => form.querySelector(`[name="${nome}"]`);
      const aviso = form.querySelector('[data-cep-msg]');
      // Como o aviso nasceu (texto, classe, escondido ou não — no perfil ele
      // nasce vazio e escondido): é pra lá que ele volta quando o CEP muda.
      const inicial = aviso && { texto: aviso.textContent, classe: aviso.className, escondido: aviso.hidden };
      if (aviso && !aviso.hasAttribute('aria-live')) aviso.setAttribute('aria-live', 'polite');
      const avisar = (estado, texto) => {
        if (!aviso) return;
        aviso.hidden = false;
        aviso.textContent = texto;
        aviso.className = 'form-hint';
        aviso.dataset.estado = estado;
      };
      const restaurar = () => {
        if (!aviso) return;
        aviso.textContent = inicial.texto;
        aviso.className = inicial.classe;
        aviso.hidden = inicial.escondido;
        delete aviso.dataset.estado;
      };

      input.addEventListener('input', () => {
        const so = input.value.replace(/\D/g, '').slice(0, 8);
        input.value = so.length > 5 ? `${so.slice(0, 5)}-${so.slice(5)}` : so;
        // CEP mudou depois de uma consulta: o aviso dela já não vale.
        if (aviso?.dataset.estado && so.length < 8) restaurar();
      });

      // Só consulta quando o CEP MUDOU nesta passagem pelo campo: no
      // formulário de edição (perfil, endereço do ponto, Admin), entrar e
      // sair do CEP sem mexer refazia a consulta por cima do endereço gravado.
      let cepAoEntrar = null;
      input.addEventListener('focus', () => {
        cepAoEntrar = input.value.replace(/\D/g, '');
      });

      input.addEventListener('blur', async () => {
        const cep = input.value.replace(/\D/g, '');
        if (cep.length !== 8 || cep === cepAoEntrar) return;
        avisar('consultando', 'Buscando endereço...');
        // O que cada campo tinha quando a consulta saiu: quem a pessoa editou
        // enquanto a resposta não chegava fica como ela deixou.
        const campos = ['logradouro', 'endereco', 'bairro', 'cidade', 'uf'];
        const antes = Object.fromEntries(campos.map((nome) => [nome, achar(nome)?.value]));
        const preencher = (nome, valor) => {
          const campo = achar(nome);
          if (!campo || campo.value !== antes[nome]) return;
          // CEP geral (sem rua/bairro fixos) devolve vazio: o que já está no
          // campo fica — a consulta nunca apaga o que a pessoa escreveu.
          if (!valor && campo.value) return;
          campo.value = valor;
          // A pessoa já está neste campo (foi pra ele antes da resposta
          // chegar): o texto preenchido fica selecionado, então o que ela
          // digitar substitui — em vez de colar no fim do que veio do CEP.
          if (campo === document.activeElement && valor) campo.select();
          // Quem depende do campo fica sabendo (a prévia do card do ponto,
          // o mapa, o erro de "informe o bairro").
          campo.dispatchEvent(new Event('input', { bubbles: true }));
        };
        let dados;
        try {
          dados = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
        } catch {
          // Consulta velha (a pessoa já trocou o CEP) não fala mais nada.
          if (input.value.replace(/\D/g, '') === cep) {
            avisar('erro', 'Não deu para consultar o CEP agora. Preencha o endereço à mão.');
          }
          return;
        }
        // Outra consulta começou depois desta (a pessoa trocou o CEP): esta
        // resposta já não é do CEP que está no campo.
        if (input.value.replace(/\D/g, '') !== cep) return;
        try {
          if (dados.erro) throw new Error();
          // Rua e bairro em campos separados, nunca colados um no outro. CEP
          // de faixa (sem logradouro fixo) não preenche o campo: fica pra pessoa.
          preencher(achar('logradouro') ? 'logradouro' : 'endereco', dados.logradouro || '');
          preencher('bairro', dados.bairro || '');
          preencher('cidade', dados.localidade);
          preencher('uf', dados.uf);
          avisar('encontrado', 'Confira e complete com o número.');
          // Leva pro Número SÓ se a pessoa ainda está no CEP (ou em lugar
          // nenhum). Se ela já foi pra outro campo — mesmo um que a consulta
          // acabou de preencher —, o foco fica onde ela está. Antes o foco
          // pulava pro Número no meio da digitação da rua, e a rua caía no
          // Número (o caso real de 01/10/2026).
          const numero = achar('numero');
          const foco = document.activeElement;
          if (numero && !numero.value && (!foco || foco === document.body || foco === input)) numero.focus();
        } catch {
          avisar('nao-encontrado', 'CEP não encontrado, pode preencher o endereço na mão.');
        }
      });
    });
  }
  window.ligarCep = ligarCep;

  // ---------- Mapa do ponto ----------
  // Só o endereço vai pro mapa (busca do Google pelo texto): nenhuma
  // coordenada sai do navegador nem é gravada — latitude/longitude não
  // existem no sistema. Mapa que não carrega nunca impede de salvar.
  const linhaDoMapa = (e) => {
    if (!e?.logradouro || !e.numero || !e.cidade || !e.uf) return '';
    const rua = `${e.logradouro}, ${e.numero}`;
    return [rua, e.bairro, `${e.cidade} - ${e.uf}`, e.cep].filter(Boolean).join(', ');
  };

  window.htmlMapaDoEndereco = function htmlMapaDoEndereco(endereco, { titulo } = {}) {
    const linha = linhaDoMapa(endereco);
    if (!linha) return '';
    const q = encodeURIComponent(linha);
    return `<div class="mapa-endereco">
      ${titulo ? `<p class="mapa-endereco-titulo">${esc(titulo)}</p>` : ''}
      <div class="mapa-endereco-quadro"><iframe src="https://www.google.com/maps?q=${q}&amp;output=embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Mapa: ${esc(linha)}"></iframe></div>
      <a class="mapa-endereco-abrir" href="https://www.google.com/maps/search/?api=1&amp;query=${q}" target="_blank" rel="noopener">Abrir no Google Maps</a>
    </div>`;
  };

  // No formulário de ponto: aparece quando o endereço já está completo o
  // bastante (logradouro, número, cidade e UF) e se refaz quando ele muda.
  window.ligarMapaDoEndereco = function ligarMapaDoEndereco(form, alvo) {
    let ultima = null;
    let espera = null;
    const atualizar = () => {
      const e = window.enderecoDoForm(form);
      const linha = linhaDoMapa(e);
      if (linha === ultima) return;
      ultima = linha;
      alvo.innerHTML = linha
        ? `<div class="mapa-endereco-cabeca"><p class="mapa-endereco-titulo">Confira a localização do ponto</p>
            <p class="form-hint">Veja se o marcador corresponde ao endereço informado.</p></div>
           ${window.htmlMapaDoEndereco(e)}`
        : '';
      alvo.hidden = !linha;
    };
    const agendar = () => {
      clearTimeout(espera);
      espera = setTimeout(atualizar, 700);
    };
    form.addEventListener('input', agendar);
    form.addEventListener('change', agendar);
    atualizar();
  };

  document.addEventListener('DOMContentLoaded', () => ligarCep());
})();
