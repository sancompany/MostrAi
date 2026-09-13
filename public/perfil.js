// Popup de perfil da conta (anunciante e dono de ponto usam o mesmo login).
//
// Isso estava duplicado linha a linha em anunciante/painel.html e
// anunciante/ponto.html — ~230 linhas em dois lugares, onde qualquer correção
// precisava ser feita duas vezes e mais cedo ou mais tarde ia divergir.
//
// Uso: montarPerfil() depois de ter a conta carregada. Requer /config.js e
// /layout.js (avatar do cabeçalho e window.ROTULOS) antes.
(function () {
  const CAMPOS_EDITAVEIS = ['nome_empresa', 'endereco', 'cidade', 'uf', 'cep', 'contato_telefone',
    'responsavel_nome', 'responsavel_cpf', 'responsavel_telefone', 'responsavel_email'];

  const inicialDe = (nome) => (nome || '?').trim().charAt(0).toUpperCase();

  const MARCACAO = `
  <dialog id="dlgPerfil">
    <div class="dlg-head">
      <div class="dlg-foto-wrap">
        <img id="fotoPreviewDlg" class="dlg-foto" src="" alt="" hidden>
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
      <div><label for="emailFixo">E-mail de acesso (fixo)</label><input id="emailFixo" disabled></div>
      <div><label for="nome_empresa">Nome da empresa</label><input id="nome_empresa" name="nome_empresa" disabled required></div>
      <div><label for="endereco">Endereço completo</label><input id="endereco" name="endereco" disabled required></div>
      <div class="field-row">
        <div style="flex:2"><label for="cidade">Cidade</label><input id="cidade" name="cidade" disabled required></div>
        <div style="flex:1"><label for="uf">UF</label><input id="uf" name="uf" maxlength="2" disabled required></div>
        <div style="flex:1"><label for="cep">CEP</label><input id="cep" name="cep" disabled required></div>
      </div>
      <div><label for="contato_telefone">WhatsApp</label><input id="contato_telefone" name="contato_telefone" autocomplete="tel" disabled required></div>
      <p class="eyebrow" style="margin-top:8px">Responsável (opcional)</p>
      <div><label for="responsavel_nome">Nome do responsável</label><input id="responsavel_nome" name="responsavel_nome" disabled></div>
      <div class="field-row">
        <div style="flex:1"><label for="responsavel_cpf">CPF</label><input id="responsavel_cpf" name="responsavel_cpf" disabled></div>
        <div style="flex:1"><label for="responsavel_telefone">WhatsApp</label><input id="responsavel_telefone" name="responsavel_telefone" autocomplete="tel" disabled></div>
      </div>
      <div><label for="responsavel_email">E-mail do responsável</label><input id="responsavel_email" name="responsavel_email" type="email" disabled></div>

      <div class="dlg-actions">
        <button type="button" class="btn ghost block" id="btnEditarPerfil">Editar</button>
        <button type="submit" class="btn primary block" id="btnSalvarPerfil" hidden>Salvar</button>
      </div>
      <p class="form-msg" id="msgPerfil"></p>
    </form>

    <button type="button" class="btn-sair" id="btnLogout">Sair</button>
    <button type="button" class="btn-excluir" id="btnExcluirConta">Excluir minha conta</button>
  </dialog>`;

  // `conta` é o objeto de /anunciantes/me; `aoAtualizar` recebe a conta nova
  // depois de salvar, pra a página redesenhar o que depender dela.
  window.montarPerfil = function montarPerfil(conta, aoAtualizar) {
    document.body.insertAdjacentHTML('beforeend', MARCACAO);
    const $ = (id) => document.getElementById(id);
    const dlg = $('dlgPerfil');

    function pintarAvatar() {
      const img = $('avatarFoto');
      const inicial = $('avatarInicial');
      const preview = $('fotoPreviewDlg');
      const inicialDlg = $('fotoInicialDlg');
      const temFoto = !!conta.foto_url;
      if (img) { img.src = conta.foto_url || ''; img.hidden = !temFoto; }
      if (inicial) { inicial.hidden = temFoto; inicial.textContent = inicialDe(conta.nome_empresa); }
      preview.src = conta.foto_url || '';
      preview.hidden = !temFoto;
      inicialDlg.hidden = temFoto;
      inicialDlg.textContent = inicialDe(conta.nome_empresa);
    }

    function preencher() {
      $('cpfCnpjFixo').value = conta.cpf_cnpj || '';
      $('emailFixo').value = conta.contato_email || '';
      $('perfilNome').textContent = conta.nome_empresa || '';
      $('perfilStatusBadge').textContent = ROTULOS.anunciante[conta.status] || conta.status || '';
      const form = $('formPerfil');
      CAMPOS_EDITAVEIS.forEach((campo) => { if (form[campo]) form[campo].value = conta[campo] || ''; });
      pintarAvatar();
    }

    function travarCampos(travado) {
      const form = $('formPerfil');
      CAMPOS_EDITAVEIS.forEach((c) => { if (form[c]) form[c].disabled = travado; });
      $('btnEditarPerfil').hidden = !travado;
      $('btnSalvarPerfil').hidden = travado;
    }

    preencher();

    const abrir = () => dlg.showModal();
    if ($('btnPerfil')) $('btnPerfil').addEventListener('click', abrir);
    $('btnFecharPerfil').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
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
        msg.textContent = err.message || 'Não foi possível salvar agora. Tente de novo.';
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
        const r = await fetch(`${API_BASE_URL}/anunciantes/me/foto`, { method: 'POST', credentials: 'include', body: form });
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

    $('btnLogout').addEventListener('click', async () => {
      if (!confirm('Sair da sua conta?')) return;
      await fetch(`${API_BASE_URL}/anunciantes/logout`, { method: 'POST', credentials: 'include' });
      window.location.href = '/';
    });

    $('btnExcluirConta').addEventListener('click', async () => {
      if (!confirm('Tem certeza que quer excluir sua conta? Ela fica recuperável por 60 dias — depois disso é apagada de vez. Pra recuperar dentro desse prazo, fale com o suporte pelo WhatsApp.')) return;
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/excluir`, { method: 'POST', credentials: 'include' });
      if (!r.ok) return alert('Não foi possível excluir a conta agora. Fale com o suporte.');
      window.location.href = '/';
    });

    return { abrir, preencher };
  };
})();
