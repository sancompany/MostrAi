// Formulário canônico de candidatura/endereço de ponto (reformulação
// comercial + candidatura, 22/09/2026). UM conceito só, usado em 3 lugares:
//   - public/modos.js (CARDS.ponto — formulário completo, quando a conta
//     ainda não tem endereço/segmento próprios pra reaproveitar);
//   - public/anunciante/painel.page.js ("Você também possui um comércio?"
//     — card compacto, reaproveita nome/endereço/segmento da CONTA);
//   - public/anunciante/ponto.page.js ("+ Cadastrar outro endereço" — outro
//     endereço da mesma conta, então pede tudo de novo, é um lugar novo).
// Mesmos campos, mesma validação, mesmo componente de horário, mesmo upload
// de foto (com preview real), mesmo preview de card, mesmo payload — só o
// que aparece na tela (contexto) muda entre os três. Sem bundler, então é
// um script global de verdade (não IIFE) — mesma convenção de
// public/formulario.js, pra dar pra chamar de qualquer um dos três.

const CANDIDATURA_DICA_FOTO_PADRAO = 'Opcional. Sem foto, o card usa o ícone padrão.';

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
    <div class="form-bloco" role="group" aria-labelledby="${id}">
      <p class="form-sep-titulo" id="${id}">${titulo}</p>
      ${conteudo}
    </div>`;
}

// Logo quadrado ou em pé numa moldura deitada: com `cover` ele era cortado e
// ampliado até sobrar uma letra gigante no card (achado do dono no polimento
// final). Abaixo de 1,2:1 a imagem entra inteira, com respiro. Mesma régua de
// `ajustarFotos` no admin (public/admin/index.page.js) — duplicada de
// propósito, os dois front-ends não compartilham script.
function candidaturaAjustarFoto(img) {
  const aplicar = () => {
    if (img.naturalWidth && img.naturalWidth / img.naturalHeight < 1.2) img.classList.add('foto-contida');
  };
  if (img.complete) aplicar();
  else img.addEventListener('load', aplicar, { once: true });
}

// ---------- Endereço (Parte W: rua e bairro separados) ----------
// `ligarCep` (public/formulario.js) já busca `logradouro`/`bairro`
// SEPARADOS na ViaCEP — só nunca tinha campo próprio pra `bairro` preencher
// (o formulário antigo concatenava os dois num campo só "Rua e bairro").
// Migration 070 deu a `pontos`/`candidaturas` a coluna que faltava.
function candidaturaCampoEndereco(prefixo) {
  return `
    <div class="field-row">
      <div class="u-col"><label for="${prefixo}cep">CEP</label><input id="${prefixo}cep" name="cep" data-cep inputmode="numeric" placeholder="00000-000" required></div>
      <div class="u-col-2"><label for="${prefixo}endereco">Rua</label><input id="${prefixo}endereco" name="endereco" required></div>
      <div class="u-col"><label for="${prefixo}numero">Número</label><input id="${prefixo}numero" name="numero" required></div>
    </div>
    <p class="form-hint" data-cep-msg>Digite o CEP e o resto vem preenchido.</p>
    <div class="field-row">
      <div class="u-col-2"><label for="${prefixo}bairro">Bairro</label><input id="${prefixo}bairro" name="bairro"></div>
      <div class="u-col-2"><label for="${prefixo}complemento">Complemento</label><input id="${prefixo}complemento" name="complemento" placeholder="Opcional"></div>
    </div>
    <div class="field-row">
      <div class="u-col-2"><label for="${prefixo}cidade">Cidade</label><input id="${prefixo}cidade" name="cidade" value="Matão" required></div>
      <div class="u-col"><label for="${prefixo}uf">UF</label><input id="${prefixo}uf" name="uf" maxlength="2" value="SP" required></div>
    </div>`;
}

function candidaturaEnderecoDoForm(form) {
  return {
    endereco: `${form.endereco.value.trim()}, ${form.numero.value.trim()}`,
    bairro: form.bairro.value.trim() || null,
    complemento: form.complemento.value.trim() || null,
    cidade: form.cidade.value.trim(),
    uf: form.uf.value.trim().toUpperCase(),
    cep: form.cep.value.trim(),
  };
}

// ---------- Segmento ----------
function candidaturaCampoSegmento(prefixo, rotulo) {
  return `
    <div><label for="${prefixo}categoria_id">${rotulo}</label><select id="${prefixo}categoria_id" name="categoria_id" data-categorias required></select></div>
    <div data-categoria-livre hidden><label for="${prefixo}categoria_livre">Qual?</label><input id="${prefixo}categoria_livre" name="categoria_livre"></div>`;
}

function candidaturaSegmentoDoForm(form) {
  const sel = form.categoria_id;
  const opcao = sel?.options[sel.selectedIndex];
  const livre = form.querySelector('[data-categoria-livre]');
  return livre && !livre.hidden ? form.categoria_livre.value.trim() : opcao ? opcao.dataset.nome || '' : '';
}

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
      </div>
      <input type="file" accept="image/*" id="${prefixo}foto" hidden>
    </div>`;
}

// Liga o campo de foto de um form. `aoMudar` (opcional) é chamado depois de
// cada escolha/remoção, pra quem tiver um preview de CARD (não só o
// preview inline) atualizar junto — ver `candidaturaLigarPreviewCard`.
function candidaturaLigarFoto(form, prefixo, aoMudar) {
  const raiz = form.querySelector('[data-campo-foto]');
  if (!raiz) return;
  const input = document.getElementById(`${prefixo}foto`);
  const previewImg = raiz.querySelector('[data-foto-preview]');
  const legenda = raiz.querySelector('[data-foto-legenda]');
  const btnEscolher = raiz.querySelector('[data-foto-escolher]');
  const btnTrocar = raiz.querySelector('[data-foto-trocar]');
  const btnRemover = raiz.querySelector('[data-foto-remover]');

  function mostrarPlaceholder() {
    previewImg.innerHTML = CANDIDATURA_FOTO_PLACEHOLDER_SVG;
    legenda.textContent = CANDIDATURA_DICA_FOTO_PADRAO;
    legenda.removeAttribute('title');
    btnEscolher.hidden = false;
    btnTrocar.hidden = true;
    btnRemover.hidden = true;
  }

  function mostrarArquivo(arquivo) {
    const leitor = new FileReader();
    leitor.onload = () => {
      // Se a pessoa clicou "Remover foto" ou trocou de arquivo antes da
      // leitura terminar, `input.files[0]` já não é mais este `arquivo` —
      // descarta a leitura velha em vez de sobrescrever a prévia com uma
      // foto removida/superada.
      if (input.files[0] !== arquivo) return;
      previewImg.innerHTML = `<img src="${leitor.result}" alt="Prévia da foto da fachada">`;
      candidaturaAjustarFoto(previewImg.querySelector('img'));
    };
    leitor.readAsDataURL(arquivo);
    legenda.textContent = arquivo.name;
    legenda.title = arquivo.name;
    btnEscolher.hidden = true;
    btnTrocar.hidden = false;
    btnRemover.hidden = false;
  }

  input.addEventListener('change', () => {
    const arquivo = input.files[0];
    if (arquivo) mostrarArquivo(arquivo);
    else mostrarPlaceholder();
    if (aoMudar) aoMudar();
  });
  btnEscolher.addEventListener('click', () => input.click());
  btnTrocar.addEventListener('click', () => input.click());
  btnRemover.addEventListener('click', () => {
    input.value = '';
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
// título do bloco fica com quem chama (`candidaturaBloco`).
function candidaturaCampoHorario() {
  return `
    <div class="horario-semanal">
      ${CANDIDATURA_DIAS_HORARIO.map(
        (d) => `
        <div class="horario-dia${d.fechadoPadrao ? ' fechado' : ''}" data-horario-dia="${d.id}">
          <span class="horario-dia-nome">${d.rotulo}</span>
          <div class="horario-dia-campos">
            <input type="time" data-horario-abre value="${d.abre}" aria-label="${d.rotulo}, abre" ${d.fechadoPadrao ? 'disabled' : ''}>
            <span aria-hidden="true">–</span>
            <input type="time" data-horario-fecha value="${d.fecha}" aria-label="${d.rotulo}, fecha" ${d.fechadoPadrao ? 'disabled' : ''}>
          </div>
          <label class="horario-dia-fechado"><input type="checkbox" data-horario-fechado aria-label="${d.rotulo}, fechado" ${d.fechadoPadrao ? 'checked' : ''}>Fechado</label>
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

// ---------- Preview do card (Parte Y) ----------
// Mesma linguagem visual dos cards de ponto (Rede/admin, "Onde estamos"):
// foto ou placeholder, badge de status ("Em análise" — candidatura nunca
// nasce ponto direto, Parte AE), nome, segmento, cidade/UF, movimento.
// Atualiza em tempo real conforme o formulário é preenchido.
// Mesmo card "com corpo" da Rede no admin (nome e estado no cabeçalho,
// cidade/segmento embaixo, movimento no pé) — e com largura máxima: no
// celular ele ocupava a tela quase inteira.
function candidaturaCampoPreview() {
  return `
    <div class="candidatura-preview" aria-hidden="true">
      <p class="candidatura-preview-titulo">Assim vai aparecer</p>
      <div class="ponto-card com-corpo candidatura-preview-card">
        <div class="ponto-card-media" data-preview-foto>
          <div class="ponto-foto-placeholder">${CANDIDATURA_FOTO_PLACEHOLDER_SVG}</div>
        </div>
        <div class="ponto-card-corpo">
          <div class="ponto-card-topo"><h4 data-preview-nome>Nome do estabelecimento</h4><span class="badge badge-pendente">Em análise</span></div>
          <p class="ponto-card-meta"><span data-preview-cidade>Cidade/UF</span> · <span data-preview-segmento>Segmento</span></p>
          <p class="ponto-card-pe" data-preview-fluxo hidden></p>
        </div>
      </div>
    </div>`;
}

// `fixos` cobre o card compacto (painel.page.js), que não pede nome/
// endereço/segmento de novo — usa o que a CONTA já tem, então o preview
// nasce com esses valores fixos e só o resto (foto/movimento) atualiza ao
// vivo. `camposForm` são os prefixos reais presentes NESTE form (o card
// compacto não tem nome_comercio/cidade/segmento no DOM).
function candidaturaLigarPreviewCard(form, previewRaiz, prefixo, fixos) {
  const dados = fixos || {};
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

    previewRaiz.querySelector('[data-preview-nome]').textContent = nome || 'Nome do estabelecimento';
    previewRaiz.querySelector('[data-preview-segmento]').textContent = segmento || 'Segmento';
    const cidadeTexto = cidade ? `${cidade}${uf ? `/${uf}` : ''}` : 'Cidade/UF';
    previewRaiz.querySelector('[data-preview-cidade]').textContent = cidadeTexto;

    const fluxoEl = previewRaiz.querySelector('[data-preview-fluxo]');
    if (fluxoInput?.value) {
      fluxoEl.textContent = `${Number(fluxoInput.value).toLocaleString('pt-BR')} pessoas/mês`;
      fluxoEl.hidden = false;
    } else {
      fluxoEl.hidden = true;
    }

    const mediaFoto = previewRaiz.querySelector('[data-preview-foto]');
    if (foto) {
      // FileReader (data:), não URL.createObjectURL — mesmo motivo do
      // preview inline em candidaturaLigarFoto: a CSP não libera `blob:`
      // em img-src.
      const leitor = new FileReader();
      leitor.onload = () => {
        if (candidaturaFotoSelecionada(form, prefixo) !== foto) return;
        mediaFoto.innerHTML = `<img src="${leitor.result}" alt="">`;
        candidaturaAjustarFoto(mediaFoto.querySelector('img'));
      };
      leitor.readAsDataURL(foto);
    } else {
      mediaFoto.innerHTML = `<div class="ponto-foto-placeholder">${CANDIDATURA_FOTO_PLACEHOLDER_SVG}</div>`;
    }
  }
  form.addEventListener('input', atualizar);
  form.addEventListener('change', atualizar);
  atualizar();
}
