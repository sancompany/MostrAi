// Formulário canônico de candidatura/endereço de ponto (reformulação
// comercial + candidatura, 22/09/2026). UM conceito só, hoje montado todo em
// public/meus-pontos.js (painel único, Fatia 6), em duas formas:
//   - "Você também possui um comércio?" — card compacto, reaproveita
//     nome/endereço/segmento da CONTA;
//   - "+ Cadastrar outro estabelecimento" (ou conta sem endereço) — completo,
//     porque é outro lugar e pede tudo de novo.
// Mesmos campos, mesma validação, mesmo componente de horário, mesmo upload
// de foto (com preview real), mesmo preview de card, mesmo payload — só o
// que aparece na tela (contexto) muda entre as formas. Sem bundler, então é
// um script global de verdade (não IIFE) — mesma convenção de
// public/formulario.js.
//
// Estação dos formulários de ponto (28/09/2026): o formulário saiu da coluna
// lateral do painel e ganhou a largura da página (formulário ~65%, prévia
// ~35%); movimento, observações e ações viraram peças daqui (eram cópias nos
// dois formulários) e o erro de validação aparece embaixo do próprio campo
// (`candidaturaValidar`) — as REGRAS são as mesmas de antes (as do HTML e as
// do servidor), só deixaram de depender do balão do navegador.

const CANDIDATURA_DICA_FOTO_PADRAO = 'Opcional. Sem foto, o card usa o ícone padrão.';
// Mesmo teto do upload no servidor (multer, src/candidaturas/routes.js).
const CANDIDATURA_FOTO_MAX_BYTES = 20 * 1024 * 1024;

const CANDIDATURA_FOTO_PLACEHOLDER_SVG = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
  <path d="M12 21.5s7.25-7.35 7.25-12.25a7.25 7.25 0 1 0-14.5 0c0 4.9 7.25 12.25 7.25 12.25Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
  <circle cx="12" cy="9.25" r="2.75" fill="none" stroke="currentColor" stroke-width="1.6"/>
</svg>`;

// ---------- Blocos do formulário (polimento final, 23/09/2026) ----------
// Um assunto por bloco, com título próprio: estabelecimento/foto, endereço,
// segmento/movimento, horário, observações. `role="group"` com
// `aria-labelledby` em vez de <fieldset>: o <legend> é desenhado em cima da
// borda do fieldset e brigava com o separador entre os blocos.
function candidaturaBloco(prefixo, chave, titulo, conteudo) {
  const id = `${prefixo}bloco_${chave}`;
  return `
    <div class="form-bloco form-bloco-${chave}" role="group" aria-labelledby="${id}">
      <p class="form-sep-titulo" id="${id}">${titulo}</p>
      ${conteudo}
    </div>`;
}

// ---------- Endereço (D5, 24/09/2026: todas as partes separadas) ----------
// CEP, logradouro, número, complemento, bairro, cidade e UF — o componente
// único de public/endereco.js (estação de endereços, 01/10/2026): mesmos
// campos, limites e regra do Número em todo formulário de endereço. As
// classes `endereco-linha-*` só desenham a grade no formulário de ponto
// (`.form-ponto`); no card de modo anúncios (public/modos.js) o endereço segue
// na linha de campos de sempre.
function candidaturaCampoEndereco(prefixo) {
  return window.camposEndereco(prefixo, { cidadePadrao: 'Matão', ufPadrao: 'SP' });
}

function candidaturaEnderecoDoForm(form) {
  return window.enderecoDoForm(form);
}

// ---------- Segmento ----------
function candidaturaCampoSegmento(prefixo, rotulo) {
  return `
    <div class="campo campo-segmento"><label for="${prefixo}categoria_id">${rotulo}</label><select id="${prefixo}categoria_id" name="categoria_id" data-categorias required></select></div>
    <div class="campo" data-categoria-livre hidden><label for="${prefixo}categoria_livre">Qual?</label><input id="${prefixo}categoria_livre" name="categoria_livre"></div>`;
}

function candidaturaSegmentoDoForm(form) {
  const sel = form.categoria_id;
  const opcao = sel?.options[sel.selectedIndex];
  const livre = form.querySelector('[data-categoria-livre]');
  return livre && !livre.hidden ? form.categoria_livre.value.trim() : opcao ? opcao.dataset.nome || '' : '';
}

// ---------- Movimento ----------
// Texto com teclado numérico, não `type="number"`: o campo de número aceita
// "e", "+" e "2.500" (vira 2,5). Só dígitos entram (`candidaturaLigarNumeros`);
// a regra é a de sempre — obrigatório e maior que zero, a mesma do servidor
// (`criarCandidaturaPonto`, src/conta/modos.js). O teto de dígitos é contado
// DEPOIS de tirar os pontos: com `maxlength`, colar "10.000.000" virava
// 1.000.000 (o navegador cortava antes).
window.candidaturaCampoMovimento = function candidaturaCampoMovimento(prefixo) {
  return `
    <div class="campo campo-movimento"><label for="${prefixo}fluxo">Média de pessoas que passam por mês</label>
      <input id="${prefixo}fluxo" name="fluxo_estimado_mensal" type="text" inputmode="numeric" autocomplete="off" data-so-numeros data-max-digitos="9" data-maior-que-zero required></div>`;
};

window.candidaturaLigarNumeros = function candidaturaLigarNumeros(form) {
  form.querySelectorAll('[data-so-numeros]').forEach((campo) => {
    const teto = Number(campo.dataset.maxDigitos) || undefined;
    campo.addEventListener('input', () => {
      const limpo = campo.value.replace(/\D/g, '').slice(0, teto);
      if (limpo !== campo.value) campo.value = limpo;
    });
  });
};

// ---------- Observações e ações ----------
window.candidaturaCampoObservacoes = function candidaturaCampoObservacoes(prefixo) {
  return `
    <div class="campo"><label for="${prefixo}mensagem">Algo mais? (opcional)</label>
      <textarea id="${prefixo}mensagem" name="mensagem" rows="4" placeholder="Estacionamento, ponto de referência, horário de pico..."></textarea></div>`;
};

// O texto do botão muda com a intenção de cada forma ("Enviar meu interesse"
// no comércio da conta, "Enviar pedido" no estabelecimento novo).
window.candidaturaAcoes = function candidaturaAcoes(textoEnviar, idMsg) {
  return `
    <div class="form-acoes candidatura-acoes">
      <button class="btn primary" type="submit" data-texto="${textoEnviar}">${textoEnviar}</button>
      <button class="btn ghost" type="button" data-acao="fechar-form">Cancelar</button>
    </div>
    <p class="form-msg" id="${idMsg}" role="status"></p>`;
};

// ---------- Foto da fachada, com preview real (Parte X) ----------
// Problema que isto corrige: antes, escolher uma imagem só trocava o TEXTO
// do nome do arquivo — nunca aparecia a foto de verdade. Agora aparece um
// <img> de verdade assim que o arquivo é escolhido, com "Trocar"/"Remover".
// FileReader (data:), não URL.createObjectURL — a CSP do site só libera
// `img-src 'self' data:` (src/server.js), sem `blob:` (achado já registrado
// noutra rodada: a troca de foto funcionava, mas a imagem nunca aparecia,
// bloqueada pelo navegador em silêncio).
// "Escolher foto" é <button>, não <label for>: rótulo não recebe foco, então
// quem navega por teclado nunca chegava no upload (polimento final).
function candidaturaCampoFoto(prefixo) {
  return `
    <div class="campo-foto-preview" data-campo-foto>
      <div class="campo-foto-preview-img" data-foto-preview>${CANDIDATURA_FOTO_PLACEHOLDER_SVG}</div>
      <div class="campo-foto-preview-info">
        <span class="campo-foto-preview-rotulo" id="${prefixo}foto_rotulo">Foto da fachada</span>
        <span class="campo-foto-preview-legenda" data-foto-legenda>${CANDIDATURA_DICA_FOTO_PADRAO}</span>
        <div class="campo-foto-preview-acoes">
          <button type="button" class="btn ghost mini" data-foto-escolher aria-describedby="${prefixo}foto_rotulo">Escolher foto</button>
          <button type="button" class="btn ghost mini" data-foto-trocar aria-describedby="${prefixo}foto_rotulo" hidden>Trocar</button>
          <button type="button" class="btn perigo-sutil mini" data-foto-remover aria-describedby="${prefixo}foto_rotulo" hidden>Remover</button>
        </div>
        <p class="campo-erro" id="${prefixo}foto_aviso" data-foto-erro aria-live="polite" hidden></p>
      </div>
      <input type="file" accept="image/*" id="${prefixo}foto" hidden>
    </div>`;
}

// Liga o campo de foto de um form. `aoMudar` (opcional) é chamado depois de
// cada escolha/remoção, pra quem tiver um preview de CARD (não só o
// preview inline) atualizar junto — ver `candidaturaLigarPreviewCard`.
// Arquivo que não é imagem ou passa do teto do servidor é recusado aqui, com
// o motivo embaixo da foto — antes ele só era descoberto depois do pedido
// enviado, quando o upload falhava em silêncio.
function candidaturaLigarFoto(form, prefixo, aoMudar) {
  const raiz = form.querySelector('[data-campo-foto]');
  if (!raiz) return;
  const input = document.getElementById(`${prefixo}foto`);
  const previewImg = raiz.querySelector('[data-foto-preview]');
  const legenda = raiz.querySelector('[data-foto-legenda]');
  const erro = raiz.querySelector('[data-foto-erro]');
  const btnEscolher = raiz.querySelector('[data-foto-escolher]');
  const btnTrocar = raiz.querySelector('[data-foto-trocar]');
  const btnRemover = raiz.querySelector('[data-foto-remover]');

  function mostrarErro(texto) {
    erro.textContent = texto;
    erro.hidden = !texto;
  }

  function mostrarPlaceholder() {
    previewImg.innerHTML = CANDIDATURA_FOTO_PLACEHOLDER_SVG;
    legenda.textContent = CANDIDATURA_DICA_FOTO_PADRAO;
    legenda.removeAttribute('title');
    raiz.removeAttribute('aria-busy');
    btnEscolher.hidden = false;
    btnTrocar.hidden = true;
    btnRemover.hidden = true;
  }

  // O nome do arquivo aparece na hora; enquanto a imagem é lida, a miniatura
  // diz "Carregando" (foto grande de celular leva um instante).
  function mostrarArquivo(arquivo) {
    const leitor = new FileReader();
    raiz.setAttribute('aria-busy', 'true');
    previewImg.innerHTML = '<span class="campo-foto-carregando">Carregando...</span>';
    legenda.textContent = arquivo.name;
    legenda.title = arquivo.name;
    leitor.onload = () => {
      // Se a pessoa clicou "Remover foto" ou trocou de arquivo antes da
      // leitura terminar, `input.files[0]` já não é mais este `arquivo` —
      // descarta a leitura velha em vez de sobrescrever a prévia com uma
      // foto removida/superada.
      if (input.files[0] !== arquivo) return;
      previewImg.innerHTML = `<img src="${leitor.result}" alt="Prévia da foto da fachada">`;
      raiz.removeAttribute('aria-busy');
    };
    leitor.onerror = () => {
      if (input.files[0] !== arquivo) return;
      input.value = '';
      // O `change` volta tudo pro placeholder — inclusive o card da prévia,
      // que senão seguiria mostrando uma foto que não vai junto.
      input.dispatchEvent(new Event('change', { bubbles: true }));
      mostrarErro('Não deu para abrir essa imagem. Escolha outra.');
    };
    leitor.readAsDataURL(arquivo);
    btnEscolher.hidden = true;
    btnTrocar.hidden = false;
    btnRemover.hidden = false;
  }

  input.addEventListener('change', () => {
    const arquivo = input.files[0];
    mostrarErro('');
    if (arquivo && !arquivo.type.startsWith('image/')) {
      input.value = '';
      mostrarPlaceholder();
      mostrarErro('Escolha um arquivo de imagem (JPG, PNG ou parecido).');
    } else if (arquivo && arquivo.size > CANDIDATURA_FOTO_MAX_BYTES) {
      input.value = '';
      mostrarPlaceholder();
      mostrarErro('Essa imagem passa de 20 MB. Escolha uma menor.');
    } else if (arquivo) {
      mostrarArquivo(arquivo);
    } else {
      mostrarPlaceholder();
    }
    if (aoMudar) aoMudar();
  });
  btnEscolher.addEventListener('click', () => input.click());
  btnTrocar.addEventListener('click', () => input.click());
  btnRemover.addEventListener('click', () => {
    input.value = '';
    mostrarErro('');
    mostrarPlaceholder();
    // O foco estava no "Remover", que acabou de sumir — devolve pro botão que
    // ficou no lugar, senão o teclado cai no começo da página.
    btnEscolher.focus();
    if (aoMudar) aoMudar();
  });
}

function candidaturaFotoSelecionada(form, prefixo) {
  return document.getElementById(`${prefixo}foto`)?.files[0] || null;
}

// ---------- Horário de funcionamento — 7 dias + feriados (Parte AA) ----------
const CANDIDATURA_DIAS_HORARIO = [
  { id: 'seg', rotulo: 'Segunda', fechadoPadrao: false, abre: '09:00', fecha: '18:00' },
  { id: 'ter', rotulo: 'Terça', fechadoPadrao: false, abre: '09:00', fecha: '18:00' },
  { id: 'qua', rotulo: 'Quarta', fechadoPadrao: false, abre: '09:00', fecha: '18:00' },
  { id: 'qui', rotulo: 'Quinta', fechadoPadrao: false, abre: '09:00', fecha: '18:00' },
  { id: 'sex', rotulo: 'Sexta', fechadoPadrao: false, abre: '09:00', fecha: '18:00' },
  { id: 'sab', rotulo: 'Sábado', fechadoPadrao: false, abre: '09:00', fecha: '15:00' },
  { id: 'dom', rotulo: 'Domingo', fechadoPadrao: true, abre: '09:00', fecha: '13:00' },
  { id: 'feriados', rotulo: 'Feriados', fechadoPadrao: true, abre: '09:00', fecha: '13:00' },
];

// Dia fechado mantém os campos no lugar, desabilitados — antes eles sumiam e
// Domingo/Feriados viravam linhas de outra geometria (polimento final). O
// título do bloco fica com quem chama (`candidaturaBloco`). A linha de
// cabeçalho ("Abre"/"Fecha") só aparece na grade larga; os campos já dizem o
// dia e o que são no próprio `aria-label`, então ela é só visual.
function candidaturaCampoHorario(prefixo = '') {
  return `
    <div class="horario-semanal">
      <div class="horario-cabeca" aria-hidden="true"><span>Dia</span><span>Abre</span><span></span><span>Fecha</span><span></span></div>
      ${CANDIDATURA_DIAS_HORARIO.map(
        (d) => `
        <div class="horario-dia${d.fechadoPadrao ? ' fechado' : ''}" data-horario-dia="${d.id}">
          <span class="horario-dia-nome">${d.rotulo}</span>
          <div class="horario-dia-campos">
            <input type="time" id="${prefixo}h_${d.id}_abre" data-horario-abre value="${d.abre}" aria-label="${d.rotulo}, abre" ${d.fechadoPadrao ? 'disabled' : ''}>
            <span class="horario-ate" aria-hidden="true">até</span>
            <input type="time" id="${prefixo}h_${d.id}_fecha" data-horario-fecha value="${d.fecha}" aria-label="${d.rotulo}, fecha" ${d.fechadoPadrao ? 'disabled' : ''}>
          </div>
          <label class="horario-dia-fechado"><input type="checkbox" data-horario-fechado aria-label="${d.rotulo}, fechado" ${d.fechadoPadrao ? 'checked' : ''}><span>Fechado</span></label>
        </div>`,
      ).join('')}
    </div>`;
}

function candidaturaLigarHorario(form) {
  form.querySelectorAll('[data-horario-dia]').forEach((linha) => {
    const chk = linha.querySelector('[data-horario-fechado]');
    chk.addEventListener('change', () => {
      linha.classList.toggle('fechado', chk.checked);
      linha.querySelectorAll('input[type="time"]').forEach((campo) => {
        campo.disabled = chk.checked;
      });
    });
  });
}

function candidaturaHorarioDoForm(form) {
  const horario = {};
  form.querySelectorAll('[data-horario-dia]').forEach((linha) => {
    const dia = linha.dataset.horarioDia;
    const fechado = linha.querySelector('[data-horario-fechado]').checked;
    horario[dia] = fechado
      ? null
      : {
          abre: linha.querySelector('[data-horario-abre]').value,
          fecha: linha.querySelector('[data-horario-fecha]').value,
        };
  });
  return horario;
}

// ---------- Erro embaixo do campo ----------
// Antes, o formulário dependia do balão do navegador: no segmento (um
// <select> escondido debaixo da busca) ele nem aparecia — o envio parava em
// silêncio. Agora o formulário é `novalidate` e quem valida é
// `candidaturaValidar`, com as MESMAS regras (obrigatórios do HTML; movimento
// maior que zero e horário de abertura diferente do de fechamento, que o
// servidor já recusava): a mensagem fica embaixo do campo, ligada a ele por
// `aria-describedby`, e o foco vai pro primeiro campo com problema.
const CANDIDATURA_MENSAGENS = {
  nome_comercio: 'Informe o nome do estabelecimento.',
  cep: 'Informe o CEP.',
  logradouro: 'Informe a rua ou avenida.',
  numero: 'Informe o número.',
  bairro: 'Informe o bairro.',
  cidade: 'Informe a cidade.',
  uf: 'Informe a UF.',
  fluxo: 'Informe quantas pessoas passam por mês, em média.',
  categoria_livre: 'Escreva qual é a atividade do comércio.',
};

function candidaturaDescritores(campo, mudar) {
  const ids = new Set((campo.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  mudar(ids);
  if (ids.size) campo.setAttribute('aria-describedby', [...ids].join(' '));
  else campo.removeAttribute('aria-describedby');
}

// `depois`: onde a mensagem entra (o próprio campo, ou o bloco em volta dele
// — a busca de segmento, a linha do horário). `campos`: quem ganha
// `aria-invalid` e aponta pra mensagem (a linha do horário tem dois).
function candidaturaMostrarErro(id, mensagem, depois, campos) {
  let p = document.getElementById(id);
  if (!p) {
    p = document.createElement('p');
    p.className = 'campo-erro';
    p.id = id;
    depois.insertAdjacentElement('afterend', p);
  }
  p.textContent = mensagem;
  for (const campo of campos) {
    campo.setAttribute('aria-invalid', 'true');
    candidaturaDescritores(campo, (ids) => ids.add(id));
  }
}

function candidaturaLimparErro(id, campos) {
  document.getElementById(id)?.remove();
  for (const campo of campos) {
    campo.removeAttribute('aria-invalid');
    candidaturaDescritores(campo, (ids) => ids.delete(id));
  }
}

function candidaturaVisivel(el) {
  return !el.disabled && !el.hidden && !el.closest('[hidden]');
}

// Devolve o primeiro campo com problema (ou null) e deixa as mensagens na
// tela. Cada erro some sozinho quando a pessoa mexe naquele campo
// (`candidaturaLigarValidacao`).
window.candidaturaValidar = function candidaturaValidar(form) {
  const problemas = [];
  form.querySelectorAll('[aria-invalid="true"]').forEach((campo) => {
    campo.removeAttribute('aria-invalid');
  });
  form.querySelectorAll('.campo-erro:not([data-foto-erro])').forEach((p) => {
    const campos = form.querySelectorAll(`[aria-describedby~="${p.id}"]`);
    candidaturaLimparErro(p.id, campos);
  });

  for (const campo of form.querySelectorAll('input:not([type="file"]):not([type="checkbox"]), select, textarea')) {
    if (!candidaturaVisivel(campo) || campo.matches('[data-horario-abre], [data-horario-fecha]')) continue;
    const chave = campo.id.replace(/^[a-z]+_/, '');
    let mensagem = '';
    if (!campo.checkValidity()) {
      mensagem = campo.validity.customError
        ? campo.validationMessage
        : CANDIDATURA_MENSAGENS[chave] || 'Preencha este campo.';
    } else if (campo.matches('[data-maior-que-zero]') && Number(campo.value) <= 0) {
      mensagem = 'Informe um número maior que zero.';
    }
    if (!mensagem) continue;
    // A busca de segmento é um bloco (campo + lista): a mensagem entra
    // depois do bloco inteiro, não entre o campo e a lista.
    const depois = campo.closest('.categoria-busca-wrap') || campo;
    candidaturaMostrarErro(`${campo.id}_erro`, mensagem, depois, [campo]);
    problemas.push(campo);
  }

  form.querySelectorAll('[data-horario-dia]').forEach((linha) => {
    if (linha.querySelector('[data-horario-fechado]').checked) return;
    const abre = linha.querySelector('[data-horario-abre]');
    const fecha = linha.querySelector('[data-horario-fecha]');
    let mensagem = '';
    if (!abre.value || !fecha.value) mensagem = 'Preencha a abertura e o fechamento, ou marque Fechado.';
    else if (abre.value === fecha.value) mensagem = 'A abertura e o fechamento não podem ser iguais.';
    if (!mensagem) return;
    candidaturaMostrarErro(`${abre.id}_erro`, mensagem, linha.lastElementChild, [abre, fecha]);
    problemas.push(abre.value ? fecha : abre);
  });

  // Na ordem da tela, não na ordem em que as regras rodaram.
  problemas.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return problemas[0] || null;
};

window.candidaturaLigarValidacao = function candidaturaLigarValidacao(form) {
  form.noValidate = true;
  const limpar = (ev) => {
    const alvo = ev.target;
    // A foto tem aviso próprio (`candidaturaLigarFoto`), fora desta regra.
    if (alvo.type === 'file') return;
    // O <select> de segmento muda por baixo da busca: o erro é da busca.
    const campo = alvo.matches?.('select[data-categorias]')
      ? form.querySelector(`#${alvo.id}_busca`)
      : alvo.closest?.('[data-horario-dia]')?.querySelector('[data-horario-abre]') || alvo;
    if (!campo?.id) return;
    const id = `${campo.id}_erro`;
    if (!document.getElementById(id)) return;
    candidaturaLimparErro(id, form.querySelectorAll(`[aria-describedby~="${id}"]`));
  };
  form.addEventListener('input', limpar);
  form.addEventListener('change', limpar);
};

// Leva a pessoa até o primeiro campo com problema. `preventScroll` + rolagem
// própria: o foco sozinho deixava o campo colado no cabeçalho fixo.
window.candidaturaFocarProblema = function candidaturaFocarProblema(campo) {
  const suave = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  campo.focus({ preventScroll: true });
  campo.scrollIntoView({ block: 'center', behavior: suave ? 'smooth' : 'auto' });
};

// ---------- Preview do card (Parte Y) ----------
// Mesma linguagem visual dos cards de ponto (Rede/admin, "Onde estamos"):
// foto ou placeholder, badge de status ("Em análise" — candidatura nunca
// nasce ponto direto, Parte AE), nome, segmento, cidade/UF, movimento.
// Atualiza em tempo real conforme o formulário é preenchido.
// Mesmo card "com corpo" da Rede no admin (nome e estado no cabeçalho,
// cidade/segmento embaixo, movimento no pé) — e com largura máxima: no
// celular ele ocupava a tela quase inteira.
// `contexto` (opcional): o que acontece depois do envio, curto, embaixo da
// prévia. O card em si é aria-hidden — repete o que já está nos campos.
function candidaturaCampoPreview(contexto = '') {
  return `
    <div class="candidatura-lateral">
      <div class="candidatura-preview">
        <p class="candidatura-preview-titulo" aria-hidden="true">Assim vai aparecer</p>
        <div class="ponto-card com-corpo candidatura-preview-card" aria-hidden="true">
          <div class="ponto-card-media" data-preview-foto>
            <div class="ponto-foto-placeholder">${CANDIDATURA_FOTO_PLACEHOLDER_SVG}</div>
          </div>
          <div class="ponto-card-corpo">
            <div class="ponto-card-topo"><h4 data-preview-nome>Nome do estabelecimento</h4><span class="badge badge-pendente">Em análise</span></div>
            <p class="ponto-card-meta"><span data-preview-cidade>Cidade/UF</span><span data-preview-sep> · </span><span data-preview-segmento>Segmento</span></p>
            <p class="ponto-card-pe" data-preview-fluxo hidden></p>
          </div>
        </div>
      </div>
      ${contexto ? `<div class="candidatura-contexto">${contexto}</div>` : ''}
    </div>`;
}

// `fixos` cobre o card compacto (painel.page.js), que não pede nome/
// endereço/segmento de novo — usa o que a CONTA já tem, então o preview
// nasce com esses valores fixos e só o resto (foto/movimento) atualiza ao
// vivo. `camposForm` são os prefixos reais presentes NESTE form (o card
// compacto não tem nome_comercio/cidade/segmento no DOM).
// O que ainda não foi preenchido aparece como marcador (`is-placeholder`,
// em itálico e mais claro) — "Segmento" no card não pode parecer um dado. No
// card compacto, segmento que a conta não tem não aparece (o servidor também
// grava a candidatura sem ele). Devolve `atualizar`, pra quem descobre um
// valor fixo depois (o nome do segmento da conta chega por fetch).
function candidaturaLigarPreviewCard(form, previewRaiz, prefixo, fixos) {
  const dados = fixos || {};
  const pedeSegmento = !!form.querySelector(`#${prefixo}categoria_id`);
  let fotoMostrada;
  function definir(seletor, valor, marcador) {
    const el = previewRaiz.querySelector(seletor);
    el.textContent = valor || marcador;
    el.classList.toggle('is-placeholder', !valor);
  }
  function atualizar() {
    const nomeInput = form.querySelector(`#${prefixo}nome_comercio`);
    const segmentoSel = form.querySelector(`#${prefixo}categoria_id`);
    const segmentoLivre = form.querySelector(`#${prefixo}categoria_livre`);
    const cidadeInput = form.querySelector(`#${prefixo}cidade`);
    const ufInput = form.querySelector(`#${prefixo}uf`);
    const fluxoInput = form.querySelector(`#${prefixo}fluxo`);
    const foto = candidaturaFotoSelecionada(form, prefixo);

    const nome = nomeInput ? nomeInput.value.trim() : dados.nome;
    const segmento =
      segmentoLivre && !segmentoLivre.closest('[data-categoria-livre]').hidden
        ? segmentoLivre.value.trim()
        : segmentoSel?.options[segmentoSel.selectedIndex]?.dataset.nome || dados.segmento;
    const cidade = cidadeInput ? cidadeInput.value.trim() : dados.cidade;
    const uf = ufInput ? ufInput.value.trim().toUpperCase() : dados.uf;

    definir('[data-preview-nome]', nome, 'Nome do estabelecimento');
    definir('[data-preview-cidade]', cidade ? `${cidade}${uf ? `/${uf}` : ''}` : '', 'Cidade/UF');
    definir('[data-preview-segmento]', segmento, 'Segmento');
    const mostraSegmento = pedeSegmento || !!segmento;
    previewRaiz.querySelector('[data-preview-segmento]').hidden = !mostraSegmento;
    previewRaiz.querySelector('[data-preview-sep]').hidden = !mostraSegmento;

    const fluxoEl = previewRaiz.querySelector('[data-preview-fluxo]');
    if (Number(fluxoInput?.value) > 0) {
      fluxoEl.textContent = `${Number(fluxoInput.value).toLocaleString('pt-BR')} pessoas/mês`;
      fluxoEl.hidden = false;
    } else {
      fluxoEl.hidden = true;
    }

    // A foto só é lida quando MUDA: esta função roda a cada tecla, e uma foto
    // de celular de 15 MB relida a cada letra travava a digitação.
    if (foto === fotoMostrada) return;
    fotoMostrada = foto;
    const mediaFoto = previewRaiz.querySelector('[data-preview-foto]');
    const placeholder = () => {
      mediaFoto.innerHTML = `<div class="ponto-foto-placeholder">${CANDIDATURA_FOTO_PLACEHOLDER_SVG}</div>`;
    };
    if (foto) {
      // FileReader (data:), não URL.createObjectURL — mesmo motivo do
      // preview inline em candidaturaLigarFoto: a CSP não libera `blob:`
      // em img-src.
      const leitor = new FileReader();
      leitor.onload = () => {
        if (candidaturaFotoSelecionada(form, prefixo) !== foto) return;
        mediaFoto.innerHTML = `<img src="${leitor.result}" alt="">`;
      };
      leitor.onerror = placeholder;
      leitor.readAsDataURL(foto);
    } else {
      placeholder();
    }
  }
  form.addEventListener('input', atualizar);
  form.addEventListener('change', atualizar);
  atualizar();
  return atualizar;
}
