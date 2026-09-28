// Popup de perfil da conta (anunciante e dono de ponto usam o mesmo login).
//
// Isso estava duplicado linha a linha em anunciante/painel.html e
// a página antiga do ponto — ~230 linhas em dois lugares, onde qualquer correção
// precisava ser feita duas vezes e mais cedo ou mais tarde ia divergir.
//
// Uso: montarPerfil() depois de ter a conta carregada. Requer /config.js e
// /layout.js (avatar do cabeçalho e window.ROTULOS) antes.
(function () {
  // Endereço em partes (D5, 24/09/2026 — src/lib/endereco.js): CEP,
  // logradouro, número, complemento, bairro, cidade e UF. O servidor compõe a
  // linha `endereco`; o perfil não mexe nela.
  const CAMPOS_ENDERECO = ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf'];
  const CAMPOS_EDITAVEIS = [
    'nome_empresa',
    ...CAMPOS_ENDERECO,
    'contato_telefone',
    'responsavel_nome',
    'responsavel_cpf',
    'responsavel_telefone',
    'responsavel_email',
  ];

  const inicialDe = (nome) => (nome || '?').trim().charAt(0).toUpperCase();

  const MARCACAO = `
  <dialog id="dlgPerfil">
    <div class="dlg-head">
      <div class="dlg-foto-wrap">
        <img id="fotoPreviewDlg" class="dlg-foto" alt="" hidden>
        <div id="fotoInicialDlg" class="dlg-foto-inicial"></div>
        <button type="button" class="dlg-foto-cam" id="btnTrocarFoto" aria-label="Trocar foto">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M9 3l-1.83 2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.17L15 3H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg>
        </button>
        <input type="file" id="inputFoto" accept="image/*" hidden>
      </div>
      <div>
        <h3 id="perfilNome"></h3>
        <span class="badge badge-pendente" id="perfilStatusBadge"></span>
      </div>
      <button type="button" class="dlg-close" id="btnFecharPerfil" aria-label="Fechar">&times;</button>
    </div>
    <p class="form-msg" id="fotoMsg"></p>

    <form id="formPerfil">
      <div><label for="cpfCnpjFixo">CPF/CNPJ (fixo)</label><input id="cpfCnpjFixo" disabled></div>
      <div><label for="emailFixo">E-mail de acesso</label><input id="emailFixo" disabled></div>
      <div><label for="nome_empresa">Nome da empresa</label><input id="nome_empresa" name="nome_empresa" disabled required></div>
      <div class="field-row">
        <div class="u-col"><label for="cep">CEP</label><input id="cep" name="cep" data-cep inputmode="numeric" autocomplete="postal-code" maxlength="9" placeholder="00000-000" disabled data-endereco-obrigatorio></div>
        <div class="u-col-2"><label for="logradouro">Logradouro</label><input id="logradouro" name="logradouro" autocomplete="address-line1" maxlength="200" disabled data-endereco-obrigatorio></div>
      </div>
      <p class="form-hint" data-cep-msg hidden></p>
      <div class="field-row">
        <div class="u-col"><label for="numero">Número</label><input id="numero" name="numero" maxlength="20" disabled data-endereco-obrigatorio></div>
        <div class="u-col-2"><label for="complemento">Complemento</label><input id="complemento" name="complemento" autocomplete="address-line2" maxlength="120" placeholder="Opcional" disabled></div>
      </div>
      <div><label for="bairro">Bairro</label><input id="bairro" name="bairro" autocomplete="address-level3" maxlength="120" disabled data-endereco-obrigatorio></div>
      <div class="field-row">
        <div class="u-col-2"><label for="cidade">Cidade</label><input id="cidade" name="cidade" autocomplete="address-level2" disabled data-endereco-obrigatorio></div>
        <div class="u-col"><label for="uf">UF</label><input id="uf" name="uf" autocomplete="address-level1" maxlength="2" disabled data-endereco-obrigatorio></div>
      </div>
      <div><label for="contato_telefone">WhatsApp</label><input id="contato_telefone" name="contato_telefone" autocomplete="tel" disabled required></div>
      <p class="eyebrow u-mt-8">Responsável (opcional)</p>
      <div><label for="responsavel_nome">Nome do responsável</label><input id="responsavel_nome" name="responsavel_nome" disabled></div>
      <div class="field-row">
        <div class="u-col"><label for="responsavel_cpf">CPF</label><input id="responsavel_cpf" name="responsavel_cpf" disabled></div>
        <div class="u-col"><label for="responsavel_telefone">WhatsApp</label><input id="responsavel_telefone" name="responsavel_telefone" autocomplete="tel" disabled></div>
      </div>
      <div><label for="responsavel_email">E-mail do responsável</label><input id="responsavel_email" name="responsavel_email" type="email" disabled></div>

      <div class="dlg-actions">
        <button type="button" class="btn ghost block" id="btnEditarPerfil">Editar</button>
        <button type="submit" class="btn primary block" id="btnSalvarPerfil" hidden>Salvar</button>
      </div>
      <p class="form-msg" id="msgPerfil"></p>
    </form>

    <details class="bloco-titular" id="blocoTrocarEmail">
      <summary>Trocar e-mail de acesso</summary>
      <p class="form-hint u-mt-8">O e-mail novo só passa a valer depois que você digitar o código que vamos mandar pra ele. Até lá, o login continua pelo e-mail atual — e ele recebe um aviso quando a troca acontecer.</p>
      <form id="formTrocarEmail">
        <div><label for="novoEmailAcesso">E-mail novo</label><input id="novoEmailAcesso" name="email" type="email" autocomplete="email" maxlength="254" required></div>
        <div><label for="senhaTrocarEmail">Senha atual</label><input id="senhaTrocarEmail" name="senha" type="password" autocomplete="current-password" required></div>
        <button type="submit" class="btn primary block">Enviar código pro e-mail novo</button>
      </form>
      <form id="formConfirmarTroca" hidden>
        <p class="form-hint" id="textoTrocaPendente"></p>
        <p class="form-hint" id="expiraTroca" aria-live="polite"></p>
        <div><label for="codigoTroca">Código</label><input id="codigoTroca" name="codigo" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" required></div>
        <button type="submit" class="btn primary block">Confirmar troca</button>
        <button type="button" class="btn ghost block" id="btnCancelarTroca">Cancelar troca</button>
      </form>
      <p class="form-msg" id="msgTrocarEmail" role="status"></p>
    </details>

    <details class="bloco-titular">
      <summary>Seus dados e seus direitos</summary>

      <p class="form-hint">Baixe tudo o que a Mostraí guarda sobre você, num arquivo só.
        Serve pra conferir e pra levar pra outro fornecedor (LGPD, art. 18).</p>
      <a class="btn ghost block" id="btnBaixarDados" href="#" download>Baixar meus dados</a>

      <div class="check-row u-mt-16">
        <input type="checkbox" id="chkComunicacoes">
        <label for="chkComunicacoes">Quero receber novidades e ofertas da Mostraí por e-mail.
          Avisos do seu plano, pagamento e anúncio continuam chegando de qualquer jeito,
          eles fazem parte do serviço.</label>
      </div>

      <p class="form-hint u-mt-16">Apagar os dados que você deu por vontade própria e que o
        serviço não precisa: contato do responsável e foto. Nome, documento, endereço e
        histórico de pagamento não saem daqui, eles sustentam o contrato e a nota fiscal,
        e só somem junto com a conta.</p>
      <button type="button" class="btn ghost block" id="btnApagarOpcionais">Apagar dados opcionais</button>

      <div id="blocoArrependimento" hidden>
        <p class="form-hint u-mt-16" id="textoArrependimento"></p>
        <button type="button" class="btn ghost block" id="btnArrependimento">Desistir da contratação</button>
      </div>

      <p class="form-msg" id="msgTitular"></p>
    </details>

    <button type="button" class="btn-sair" id="btnLogout">Sair</button>
    <button type="button" class="btn-excluir" id="btnExcluirConta">Excluir minha conta</button>
  </dialog>`;

  // `conta` é o objeto de /anunciantes/me; `aoAtualizar` recebe a conta nova
  // depois de salvar, pra a página redesenhar o que depender dela.
  //
  // Idempotente: o painel chama de novo a cada `carregar()` (que roda de novo
  // por SSE). Antes cada chamada inseria OUTRO diálogo com os mesmos ids e
  // ligava os botões de novo — um clique virava dois envios. Agora a segunda
  // chamada só troca a conta e redesenha.
  let montado = null;
  window.montarPerfil = function montarPerfil(contaNova, aoAtualizarNovo) {
    if (montado && document.getElementById('dlgPerfil')) return montado(contaNova, aoAtualizarNovo);
    let conta = contaNova;
    let aoAtualizar = aoAtualizarNovo;
    document.body.insertAdjacentHTML('beforeend', MARCACAO);
    const $ = (id) => document.getElementById(id);
    const dlg = $('dlgPerfil');
    // CEP preenche logradouro, bairro, cidade e UF (public/formulario.js) —
    // o diálogo nasce depois do `ligarCep()` da página, então liga aqui.
    if (window.ligarCep) window.ligarCep(dlg);

    function pintarAvatar() {
      const img = $('avatarFoto');
      const inicial = $('avatarInicial');
      const preview = $('fotoPreviewDlg');
      const inicialDlg = $('fotoInicialDlg');
      const temFoto = !!conta.foto_url;
      // `src = ''` nao limpa a imagem: o navegador resolve string vazia como a
      // URL da propria pagina e pede o HTML de volta como se fosse imagem —
      // duas requisicoes inuteis por pagina, e uma imagem "quebrada" no DOM.
      // Sem foto, o atributo sai.
      if (img) {
        if (temFoto) img.src = conta.foto_url;
        else img.removeAttribute('src');
        img.hidden = !temFoto;
      }
      if (inicial) {
        inicial.hidden = temFoto;
        inicial.textContent = inicialDe(conta.nome_empresa);
      }
      if (temFoto) preview.src = conta.foto_url;
      else preview.removeAttribute('src');
      preview.hidden = !temFoto;
      inicialDlg.hidden = temFoto;
      inicialDlg.textContent = inicialDe(conta.nome_empresa);
    }

    function preencher() {
      $('cpfCnpjFixo').value = conta.cpf_cnpj || '';
      $('emailFixo').value = conta.contato_email || '';
      $('perfilNome').textContent = conta.nome_empresa || '';
      // Só `suspenso` rende selo. "Parceiro" saiu da experiência
      // (reconstrução de Contas, 23/09/2026) — o dado fica no banco, o selo não.
      $('perfilStatusBadge').textContent = conta.suspenso ? 'Suspensa' : '';
      const form = $('formPerfil');
      CAMPOS_EDITAVEIS.forEach((campo) => {
        if (form[campo]) form[campo].value = conta[campo] || '';
      });
      // Conta de antes das partes (linha única que não deu pra separar com
      // segurança, migration 086): a linha vai pro logradouro e o número fica
      // em branco pra pessoa completar — nada é adivinhado.
      if (!conta.logradouro && conta.endereco) form.logradouro.value = conta.endereco;
      // Endereço só é obrigatório pra quem anuncia (vai na nota fiscal) —
      // conta só de ponto salva o perfil sem ele, como o servidor aceita.
      const exige = (conta.papeis || []).includes('anunciante');
      form.querySelectorAll('[data-endereco-obrigatorio]').forEach((campo) => {
        campo.required = exige;
      });
      pintarAvatar();
    }

    function travarCampos(travado) {
      const form = $('formPerfil');
      CAMPOS_EDITAVEIS.forEach((c) => {
        if (form[c]) form[c].disabled = travado;
      });
      $('btnEditarPerfil').hidden = !travado;
      $('btnSalvarPerfil').hidden = travado;
    }

    preencher();
    ligarTrocaDeEmail();
    montado = (nova, cb) => {
      conta = nova;
      aoAtualizar = cb;
      // Não apaga o que a pessoa está digitando: com o formulário aberto pra
      // edição, só o cabeçalho e a foto se refazem.
      if ($('btnSalvarPerfil').hidden) preencher();
      else pintarAvatar();
      $('blocoTrocarEmail').hidden = !conta.email_confirmado;
    };

    // Troca do e-mail de login (estação de e-mail, 27/09/2026): o novo fica
    // pendente até o código; o prazo mostrado é o do servidor. Conta ainda
    // não confirmada corrige o e-mail pelo aviso de confirmação — a troca
    // aparece assim que ela confirmar (evento do layout.js), sem F5.
    function ligarTrocaDeEmail() {
      const msg = $('msgTrocarEmail');
      const avisar = (texto, tipo = '') => {
        msg.textContent = texto;
        msg.className = `form-msg ${tipo}`.trim();
      };
      let tique = null;
      function mostrarPendente(emailNovo, expiraEm) {
        $('formTrocarEmail').hidden = true;
        $('formConfirmarTroca').hidden = false;
        $('textoTrocaPendente').textContent = `Mandamos um código pra ${emailNovo}.`;
        const fim = new Date(expiraEm).getTime();
        clearInterval(tique);
        const pintar = () => {
          const resta = Math.max(0, Math.ceil((fim - Date.now()) / 1000));
          $('expiraTroca').textContent =
            resta > 0
              ? `Expira em ${Math.floor(resta / 60)}:${String(resta % 60).padStart(2, '0')}`
              : 'Código expirado — cancele e peça de novo.';
        };
        pintar();
        tique = setInterval(pintar, 1000);
      }
      function voltarAoPedido() {
        clearInterval(tique);
        $('formTrocarEmail').hidden = false;
        $('formConfirmarTroca').hidden = true;
        $('codigoTroca').value = '';
      }

      $('blocoTrocarEmail').hidden = !conta.email_confirmado;
      window.addEventListener('mostrai:email-confirmado', (ev) => {
        conta.email_confirmado = true;
        if (ev.detail?.email) {
          conta.contato_email = ev.detail.email;
          $('emailFixo').value = ev.detail.email;
        }
        $('blocoTrocarEmail').hidden = false;
      });
      if (conta.email_confirmado) {
        fetch(`${API_BASE_URL}/anunciantes/me/verificacao-email`, { credentials: 'include' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d?.troca?.pendente) mostrarPendente(d.troca.email, d.troca.expiraEm);
          })
          .catch(() => {});
      }

      $('formTrocarEmail').addEventListener('submit', async (e) => {
        e.preventDefault();
        avisar('Enviando...');
        try {
          const r = await fetch(`${API_BASE_URL}/anunciantes/me/trocar-email`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: $('novoEmailAcesso').value.trim(), senha: $('senhaTrocarEmail').value }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) return avisar(d.erro || 'Não deu pra pedir a troca.', 'err');
          $('senhaTrocarEmail').value = '';
          mostrarPendente(d.emailPendente, d.expiraEm);
          avisar('Código enviado. Confira também o spam.', 'ok');
        } catch {
          avisar('Sem conexão com o servidor.', 'err');
        }
      });

      $('formConfirmarTroca').addEventListener('submit', async (e) => {
        e.preventDefault();
        avisar('Confirmando...');
        try {
          const r = await fetch(`${API_BASE_URL}/anunciantes/me/confirmar-troca-email`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codigo: $('codigoTroca').value.trim() }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) {
            if (d.motivo === 'expirado' || d.motivo === 'esgotado') voltarAoPedido();
            return avisar(d.erro || 'Não deu pra confirmar.', 'err');
          }
          conta.contato_email = d.email;
          $('emailFixo').value = d.email;
          voltarAoPedido();
          $('novoEmailAcesso').value = '';
          avisar('Pronto: seu e-mail de acesso agora é o novo.', 'ok');
        } catch {
          avisar('Sem conexão com o servidor.', 'err');
        }
      });

      $('btnCancelarTroca').addEventListener('click', async () => {
        await fetch(`${API_BASE_URL}/anunciantes/me/trocar-email`, { method: 'DELETE', credentials: 'include' }).catch(
          () => {},
        );
        voltarAoPedido();
        avisar('Troca cancelada. Nada mudou na sua conta.');
      });
    }

    const abrir = () => dlg.showModal();
    if ($('btnPerfil')) $('btnPerfil').addEventListener('click', abrir);
    $('btnFecharPerfil').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
    $('btnEditarPerfil').addEventListener('click', () => travarCampos(false));

    $('formPerfil').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('msgPerfil');
      msg.textContent = 'Salvando...';
      msg.className = 'form-msg';
      try {
        const r = await fetch(`${API_BASE_URL}/anunciantes/me`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || '');
        conta = await r.json();
        msg.textContent = 'Dados atualizados!';
        msg.className = 'form-msg ok';
        travarCampos(true);
        preencher();
        if (aoAtualizar) aoAtualizar(conta);
      } catch (err) {
        msg.textContent = window.frase(err.message) || 'Não foi possível salvar agora. Tente de novo.';
        msg.className = 'form-msg err';
      }
    });

    $('btnTrocarFoto').addEventListener('click', () => $('inputFoto').click());
    $('inputFoto').addEventListener('change', async (e) => {
      const arquivo = e.target.files[0];
      if (!arquivo) return;
      const fotoMsg = $('fotoMsg');
      fotoMsg.textContent = 'Enviando...';
      fotoMsg.className = 'form-msg';
      const form = new FormData();
      form.append('arquivo', arquivo);
      try {
        const r = await fetch(`${API_BASE_URL}/anunciantes/me/foto`, {
          method: 'POST',
          credentials: 'include',
          body: form,
        });
        if (!r.ok) throw new Error();
        conta = await r.json();
        pintarAvatar();
        fotoMsg.textContent = 'Foto atualizada!';
        fotoMsg.className = 'form-msg ok';
        if (aoAtualizar) aoAtualizar(conta);
      } catch {
        fotoMsg.textContent = 'Não foi possível enviar a foto agora.';
        fotoMsg.className = 'form-msg err';
      } finally {
        e.target.value = '';
      }
    });

    // Confirmações em modal Mostraí (confirmar.js), nunca confirm()/alert()
    // nativo: o pedido roda dentro do modal, com loading, e erro fica escrito
    // ali — a página só muda quando o servidor respondeu.
    $('btnLogout').addEventListener('click', async () => {
      const sim = await window.confirmarMostrai({
        titulo: 'Sair da sua conta?',
        texto: 'Você volta pra página inicial. Pra entrar de novo é só usar seu e-mail e senha.',
        botao: 'Sair',
        aoConfirmar: () => fetch(`${API_BASE_URL}/anunciantes/logout`, { method: 'POST', credentials: 'include' }),
      });
      if (sim) window.location.href = '/';
    });

    $('btnExcluirConta').addEventListener('click', async () => {
      const sim = await window.confirmarMostrai({
        titulo: 'Excluir sua conta?',
        texto:
          'Seu anúncio sai do ar e você perde o acesso agora. A conta fica recuperável por 60 dias — pra recuperar nesse prazo, fale com o suporte pelo WhatsApp. Depois disso é apagada de vez.',
        botao: 'Excluir minha conta',
        perigo: true,
        aoConfirmar: async () => {
          const r = await fetch(`${API_BASE_URL}/anunciantes/me/excluir`, { method: 'POST', credentials: 'include' });
          if (!r.ok) throw new Error('Não foi possível excluir a conta agora. Fale com o suporte.');
        },
      });
      if (sim) window.location.href = '/';
    });

    // --- Direitos do titular -------------------------------------------------
    const msgTitular = $('msgTitular');
    const dizer = (texto, classe) => {
      msgTitular.textContent = texto;
      msgTitular.className = `form-msg ${classe || ''}`.trim();
    };

    // O download é um <a href> pra rota, e não um fetch + blob: o navegador
    // salva o arquivo com o nome que o Content-Disposition manda, e o link
    // funciona mesmo com a CSP bloqueando o que a página fabrica sozinha.
    $('btnBaixarDados').href = `${API_BASE_URL}/titular/meus-dados`;

    const chk = $('chkComunicacoes');
    chk.checked = !conta.comunicacoes_revogado_em;
    chk.addEventListener('change', async () => {
      const r = await fetch(`${API_BASE_URL}/titular/consentimento`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escopo: 'comunicacoes', aceita: chk.checked }),
      });
      if (!r.ok) {
        chk.checked = !chk.checked;
        return dizer('Não deu pra salvar agora.', 'err');
      }
      const d = await r.json();
      conta.comunicacoes_revogado_em = d.comunicacoes_revogado_em;
      dizer(chk.checked ? 'Você vai receber novidades.' : 'Consentimento revogado. Não mandamos mais novidades.', 'ok');
    });

    $('btnApagarOpcionais').addEventListener('click', async () => {
      const sim = await window.confirmarMostrai({
        titulo: 'Apagar os dados opcionais?',
        texto: 'O contato do responsável e a foto da conta são apagados. Não dá pra desfazer.',
        botao: 'Apagar',
        perigo: true,
        aoConfirmar: async () => {
          const r = await fetch(`${API_BASE_URL}/titular/consentimento`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ escopo: 'opcionais' }),
          });
          if (!r.ok) throw new Error('Não deu pra apagar agora.');
        },
      });
      if (!sim) return;
      dizer('Dados opcionais apagados.', 'ok');
      const novo = await (await fetch(`${API_BASE_URL}/anunciantes/me`, { credentials: 'include' })).json();
      Object.assign(conta, novo);
      preencher();
      pintarAvatar();
      if (aoAtualizar) aoAtualizar(conta);
    });

    // O botão de desistir só existe enquanto o prazo existe — mostrar um botão
    // que vai responder "prazo vencido" é pior do que não mostrar.
    (async function montarArrependimento() {
      let d;
      try {
        d = await (await fetch(`${API_BASE_URL}/titular/arrependimento`, { credentials: 'include' })).json();
      } catch {
        return;
      }
      const bloco = $('blocoArrependimento');
      if (d.pedido) {
        bloco.hidden = false;
        $('btnArrependimento').hidden = true;
        $('textoArrependimento').textContent =
          d.pedido.status === 'estornado'
            ? `Desistência registrada e valor devolvido (protocolo ${d.pedido.id}).`
            : `Desistência registrada (protocolo ${d.pedido.id}). A devolução de ` +
              `${fmtBRL(d.pedido.valor_a_estornar)} está em andamento.`;
        return;
      }
      if (!d.disponivel) return;
      bloco.hidden = false;
      const ate = new Date(d.prazo_ate).toLocaleDateString('pt-BR');
      $('textoArrependimento').textContent =
        `Você tem até ${ate} pra desistir da contratação ` +
        `e receber ${fmtBRL(d.valor_a_estornar)} de volta (7 dias, art. 49 do Código de Defesa ` +
        `do Consumidor). O anúncio sai do ar na hora.`;
      $('btnArrependimento').addEventListener('click', async () => {
        const sim = await window.confirmarMostrai({
          titulo: 'Desistir da contratação?',
          texto: `Seu anúncio sai do ar agora e ${fmtBRL(d.valor_a_estornar)} voltam pra você pelo mesmo meio de pagamento. Você recebe a confirmação por e-mail.`,
          botao: 'Desistir e pedir o valor de volta',
          perigo: true,
          aoConfirmar: async () => {
            const r = await fetch(`${API_BASE_URL}/titular/arrependimento`, {
              method: 'POST',
              credentials: 'include',
            });
            const corpo = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(corpo.erro || 'Não deu pra registrar agora.');
          },
        });
        if (!sim) return;
        dizer('Desistência registrada. Você recebe a confirmação por e-mail.', 'ok');
        $('btnArrependimento').hidden = true;
      });
    })();

    return { abrir, preencher };
  };
})();
