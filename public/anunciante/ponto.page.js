let CONTA = null;
let TELAS = [];

async function carregar() {
  CONTA = await carregarConta();
  if (!CONTA) {
    window.location.href = '/anunciante/login.html';
    return;
  }
  montarPerfil(CONTA, (nova) => {
    CONTA = nova;
  });
  // Extrato do comodato — o que este dono de ponto já recebeu e o que está em
  // aberto. A chamada a esta função existia em `Promise.all` desde sempre; a
  // FUNÇÃO não. Como o erro caía dentro do callback de `montarModo`, que engole
  // exceção, nada aparecia na tela e nada aparecia no console: o extrato
  // simplesmente nunca carregava, em silêncio.
  async function carregarExtrato() {
    const el = document.getElementById('extratoPonto');
    if (!el) return;
    try {
      const { linhas, resumo } = await (
        await fetch(`${API_BASE_URL}/anunciantes/me/pontos/extrato`, { credentials: 'include' })
      ).json();
      if (!linhas.length) {
        el.innerHTML =
          '<p class="empty-state">Nenhum pagamento lançado ainda. Assim que o primeiro mês de comodato for fechado, ele aparece aqui.</p>';
        return;
      }
      el.innerHTML = `
      <div class="kpi-grid u-mb-14">
        <div class="kpi-card"><span class="kpi-label">Já recebido</span><b>${esc(resumo.totalPagoTexto)}</b>
          <span class="kpi-caption">${resumo.ultimoPagamento ? `último em ${esc(resumo.ultimoPagamento)}` : 'nenhum pagamento ainda'}</span></div>
        <div class="kpi-card"><span class="kpi-label">Em aberto</span><b>${esc(resumo.totalAbertoTexto)}</b>
          <span class="kpi-caption">lançado e ainda não pago</span></div>
      </div>
      <div class="tabela-caixa"><div class="rolagem"><table class="mini-table"><thead><tr>
        <th>Competência</th><th>Ponto</th><th class="num">Valor</th><th>Situação</th><th>Forma</th>
      </tr></thead><tbody>
      ${linhas
        .map(
          (l) => `<tr>
        <td>${esc(mesAno(l.competencia))}</td>
        <td>${esc(l.ponto_nome)}</td>
        <td class="num">${fmtBRL(l.valor)}</td>
        <td>${
          l.pago_em
            ? `<span class="badge badge-ok">pago em ${esc(dataCurta(l.pago_em))}</span>`
            : '<span class="badge badge-pendente">em aberto</span>'
        }</td>
        <td>${esc(l.forma || '-')}</td>
      </tr>`,
        )
        .join('')}
      </tbody></table></div></div>`;
    } catch (err) {
      console.error('falha ao carregar o extrato do ponto', err);
      el.innerHTML = '<p class="form-msg err">Não foi possível carregar seus recebimentos agora.</p>';
    }
  }

  const mesAno = (d) => window.dataBR(d, { month: '2-digit', year: 'numeric' });
  const dataCurta = (d) => window.dataBR(d);

  // Painel único (modos.js): sem o papel "ponto", card de ativação.
  const estado = await montarModo('ponto', document.getElementById('dashboardPonto'), async (estado) => {
    document.getElementById('statusBanner').innerHTML =
      `<span><strong>${esc(CONTA.nome_empresa)}</strong> · meu ponto</span>`;
    document.getElementById('bonusPonto').innerHTML = cardBonus(estado, 'anuncio');
    ligarResgateAnuncio(document.getElementById('bonusPonto'));
    await Promise.all([carregarTelas(), carregarPontos(), carregarExtrato(), carregarAutoanuncio()]);
  });
  if (estado && !estado.modos.ponto.liberado) {
    document.getElementById('statusBanner').innerHTML =
      `<span><strong>${esc(CONTA.nome_empresa)}</strong> · modo meu ponto ainda não ativado</span>`;
  }
}

function tempoDesde(iso) {
  if (!iso) return 'nunca ligou';
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 3) return 'online agora';
  if (min < 60) return `há ${min} min`;
  if (min < 48 * 60) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} dias`;
}
const online = (iso) => iso && Date.now() - new Date(iso) < 3 * 60000;

async function carregarTelas() {
  const el = document.getElementById('telasLista');
  try {
    TELAS = await (
      await fetch(`${API_BASE_URL}/anunciantes/${CONTA.id}/dispositivos`, { credentials: 'include' })
    ).json();
    const ativas = TELAS.filter((t) => t.status === 'ativo').length;
    const exib = TELAS.reduce((s, t) => s + (t.exibicoes_30d || 0), 0);
    const anunciantes = Math.max(0, ...TELAS.map((t) => t.anunciantes_30d || 0));
    document.getElementById('kpis').innerHTML = `
      <div class="kpi-card"><span class="kpi-label">Telas</span><b>${TELAS.length}</b><span>${ativas} no ar</span></div>
      <div class="kpi-card"><span class="kpi-label">Exibições em 30 dias</span><b>${exib.toLocaleString('pt-BR')}</b><span>somando todas as telas</span></div>
      <div class="kpi-card"><span class="kpi-label">Anunciantes na sua tela</span><b>${anunciantes}</b><span>nos últimos 30 dias</span></div>`;
    if (!TELAS.length) {
      el.innerHTML =
        '<p class="empty-state">Nenhuma tela instalada ainda. Assim que a gente instalar, ela aparece aqui.</p>';
      return;
    }
    el.innerHTML = TELAS.map(
      (t) => `
      <div class="tela-card">
        <div class="tela-topo">
          <b>${esc(t.apelido)}</b>
          <span class="online ${online(t.ultima_vez_online) ? 'on' : ''}">${tempoDesde(t.ultima_vez_online)}</span>
        </div>
        <div class="tela-meta">${esc(t.ponto_nome)}<br>${esc(t.endereco)}</div>
        ${
          t.ponto_status !== 'ativo'
            ? `<span class="badge ${ROTULOS.pontoClasse[t.ponto_status] || 'badge-pendente'}">${esc(ROTULOS.ponto[t.ponto_status] || t.ponto_status)}</span>`
            : `<span class="badge ${ROTULOS.pontoClasse[t.status] || 'badge-pendente'}">${esc(ROTULOS.ponto[t.status] || t.status)}</span>`
        }
        <div class="tela-meta"><b>${(t.exibicoes_30d || 0).toLocaleString('pt-BR')}</b> exibições · <b>${t.anunciantes_30d || 0}</b> anunciantes (30 dias)</div>
        <div class="tela-acoes"><button type="button" class="btn ghost" data-painel="${t.id}">Ver o que rodou</button></div>
      </div>`,
    ).join('');
    el.querySelectorAll('[data-painel]').forEach((b) =>
      b.addEventListener('click', () => abrirPainel(Number(b.dataset.painel))),
    );
  } catch {
    el.innerHTML = '<p class="form-msg err">Não foi possível carregar suas telas agora.</p>';
  }
}

async function abrirPainel(id) {
  const tela = TELAS.find((t) => t.id === id);
  document.getElementById('modalTelaTitulo').textContent = `${tela.apelido}, ${tela.ponto_nome}`;
  const corpo = document.getElementById('modalTelaCorpo');
  corpo.textContent = 'Carregando...';
  document.getElementById('modalTela').showModal();
  try {
    const d = await (
      await fetch(`${API_BASE_URL}/anunciantes/${CONTA.id}/dispositivos/${id}/painel`, { credentials: 'include' })
    ).json();
    const total = d.porAnunciante.reduce((s, a) => s + a.confirmadas, 0);
    const max = Math.max(...d.porDia.map((y) => y.confirmadas), 1);
    corpo.innerHTML = `
      <p class="form-hint">Últimos 30 dias · ${total.toLocaleString('pt-BR')} exibições confirmadas pela própria tela.</p>
      ${
        d.porAnunciante.length
          ? `<table class="mini-table"><thead><tr><th>Anunciante</th><th>Programadas</th><th>Confirmadas</th></tr></thead><tbody>
        ${d.porAnunciante.map((a) => `<tr><td>${esc(a.nome_empresa)}</td><td>${a.programadas}</td><td>${a.confirmadas}</td></tr>`).join('')}
      </tbody></table>`
          : '<p class="empty-state">Nada rodou nessa tela ainda.</p>'
      }
      <p class="form-sep-titulo u-mt-14">PIN desta tela</p>
      <p class="form-hint u-m-0">É o número que abre este mesmo painel na própria TV: 5 toques no canto superior direito da tela e o PIN.
        Serve pra você conferir o que rodou sem sair do balcão. Quem define é você.</p>
      <form class="field-row u-ai-c u-mt-8" id="formPin">
        <input class="u-col" id="pinTela" inputmode="numeric" pattern="\\d{4,6}" maxlength="6" placeholder="4 a 6 dígitos" required>
        <button class="btn primary" type="submit">Salvar PIN</button>
      </form>
      <p class="form-msg" id="msgPin" role="status">${tela.tem_pin ? 'Esta tela já tem um PIN. Salvar de novo troca o número.' : 'Esta tela ainda não tem PIN.'}</p>

      ${
        d.porDia.length
          ? `<p class="form-sep-titulo u-mt-14">Por dia</p><div class="bar-chart-h">
        ${d.porDia
          .slice(0, 14)
          .reverse()
          .map(
            (x) =>
              `<div class="row"><span class="nome">${new Date(x.dia).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span><span class="track"><span class="fill" data-pct="${Math.round((x.confirmadas / max) * 100)}"></span></span><span class="valor">${x.confirmadas}</span></div>`,
          )
          .join('')}
      </div>`
          : ''
      }`;
    document.getElementById('formPin').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('msgPin');
      const valor = document.getElementById('pinTela').value.trim();
      const r = await fetch(`${API_BASE_URL}/anunciantes/${CONTA.id}/dispositivos/${id}/pin`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: valor }),
      });
      const resposta = await r.json().catch(() => ({}));
      msg.textContent = r.ok
        ? 'PIN salvo. Use ele na própria TV: 5 toques no canto superior direito.'
        : window.frase(resposta.erro || 'não foi possível salvar o PIN agora');
      msg.className = r.ok ? 'form-msg ok' : 'form-msg err';
      if (r.ok) document.getElementById('pinTela').value = '';
    });
  } catch {
    corpo.innerHTML = '<p class="form-msg err">Não deu pra carregar o painel dessa tela.</p>';
  }
}
document
  .getElementById('fecharModalTela')
  .addEventListener('click', () => document.getElementById('modalTela').close());
document.getElementById('modalTela').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

// ---------------------------------------------------------------------------
// Troca de modalidade do comodato — mão única, de propósito
//
// Quem cede a parede escolhe entre receber R$ 50 por mês ou trocar esses
// R$ 50 pelo plano Essencial inteiro. Até 17/09/2026 a escolha só existia na
// candidatura: depois de instalado, trocar era ato de admin no banco, e a
// recusa da rota de assinar mandava "fale com a gente" — que é remendo, não
// caminho.
//
// O botão só faz o sentido BARATO: abrir mão do dinheiro. A Mostraí para de
// pagar e ele ganha o dobro de tela, então não precisa pedir licença a
// ninguém. Voltar a receber é despesa nova e recorrente, entra no caixa do
// mês, e continua saindo pelo admin — sem isso dava pra pingar entre as
// modalidades e sacar a ajuda de custo só nos meses em que ela valesse mais.
// ---------------------------------------------------------------------------
async function carregarTrocaComodato(pontos) {
  const el = document.getElementById('trocaComodato');
  if (!el) return;
  const recebendo = (pontos || []).filter((p) => Number(p.valor_pago_mensal || 0) > 0);
  if (!recebendo.length) {
    el.hidden = true;
    return;
  }
  const total = recebendo.reduce((soma, p) => soma + Number(p.valor_pago_mensal || 0), 0);
  el.hidden = false;
  el.innerHTML = `<div class="card wide u-mt-16">
    <h4 class="u-m-0">Quer trocar a ajuda de custo por tela?</h4>
    <p class="form-hint u-mt-8">Hoje você recebe <b>${fmtBRL(total)} por mês</b>${recebendo.length > 1 ? ` (${recebendo.length} endereços)` : ''} e tem o plano básico junto.
      Abrindo mão desse valor, você passa a ter o <b>plano Essencial inteiro</b> — o dobro de tempo de tela, sem pagar nada —
      e ainda ganha ${fmtBRL(50)} de abatimento por mês se um dia quiser assinar o Pro ou o Prime.</p>
    <p class="form-hint u-mt-8"><b>A troca é só num sentido aqui:</b> para voltar a receber a ajuda de custo, fale com a gente.</p>
    <button type="button" class="btn primary u-mt-12" id="btnTrocarPorTela">Trocar os ${fmtBRL(total)} por tela</button>
    <p class="form-msg u-mt-8" id="msgTrocaComodato" role="status"></p>
  </div>`;

  document.getElementById('btnTrocarPorTela').addEventListener('click', async (ev) => {
    // Confirmação explícita: é dinheiro que ele deixa de receber, e o caminho
    // de volta não está na mão dele.
    if (
      !window.confirm(
        `Você deixa de receber ${fmtBRL(total)} por mês e passa a ter o plano Essencial inteiro, de graça. Para voltar a receber, vai precisar falar com a gente. Confirmar?`,
      )
    )
      return;
    const msg = document.getElementById('msgTrocaComodato');
    ev.target.disabled = true;
    msg.textContent = 'trocando...';
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/comodato/trocar-por-tela`, {
        method: 'POST',
        credentials: 'include',
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(corpo.erro || 'não deu pra trocar agora');
      msg.className = 'form-msg ok u-mt-8';
      msg.textContent = 'Pronto. Seu plano agora é o Essencial, e a ajuda de custo deixa de ser paga.';
      // Recarrega tudo: plano, extrato e a própria oferta (que some).
      CONTA = await (await fetch(`${API_BASE_URL}/anunciantes/me`, { credentials: 'include' })).json();
      carregarPontos();
      carregarExtrato();
    } catch (err) {
      msg.className = 'form-msg err u-mt-8';
      msg.textContent = err.message;
      ev.target.disabled = false;
    }
  });
}

async function carregarPontos() {
  const el = document.getElementById('pontosLista');
  try {
    const pontos = await (
      await fetch(`${API_BASE_URL}/anunciantes/${CONTA.id}/pontos`, { credentials: 'include' })
    ).json();
    carregarTrocaComodato(pontos);
    if (!pontos.length) {
      el.innerHTML = '<p class="empty-state">Nenhum endereço cadastrado ainda.</p>';
      return;
    }
    el.innerHTML = pontos
      .map(
        (p) => `
      <div class="ponto-endereco-card">
        <span class="badge ${ROTULOS.pontoClasse[p.status] || 'badge-pendente'}">${esc(ROTULOS.ponto[p.status] || p.status)}</span>
        <strong>${esc(p.nome || '')}</strong>
        <span>${esc(p.endereco)}</span>
        <span class="u-dim u-fs-88">${esc(p.cidade || '')}${p.uf ? '/' + esc(p.uf) : ''}</span>
        ${Number(p.valor_pago_mensal) > 0 ? `<span class="u-fs-85">Ajuda de custo: <b>${fmtBRL(p.valor_pago_mensal)}/mês</b></span>` : ''}
        ${p.cota_autoanuncio_slots_hora ? `<span class="u-fs-85 u-dim">Cota do seu anúncio: ${p.cota_autoanuncio_slots_hora}x por hora, dividida entre as telas</span>` : ''}
      </div>`,
      )
      .join('');
  } catch {
    el.innerHTML = '<p class="form-msg err">Não foi possível carregar seus endereços agora.</p>';
  }
}

const formEnd = document.getElementById('formEndereco');
document.getElementById('btnNovoEndereco').addEventListener('click', () => {
  formEnd.hidden = false;
  formEnd.scrollIntoView({ behavior: 'smooth' });
});
document.getElementById('btnCancelarEndereco').addEventListener('click', () => {
  formEnd.hidden = true;
});
formEnd.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('msgEndereco');
  msg.textContent = 'Enviando...';
  msg.className = 'form-msg';
  const opcao = formEnd.categoria_id.options[formEnd.categoria_id.selectedIndex];
  const usouLivre = !formEnd.querySelector('[data-categoria-livre]').hidden;
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/me/pontos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        nome: formEnd.nome.value.trim(),
        endereco: `${formEnd.endereco.value.trim()}, ${formEnd.numero.value.trim()}`,
        cidade: formEnd.cidade.value.trim(),
        uf: formEnd.uf.value.trim().toUpperCase(),
        cep: formEnd.cep.value.trim(),
        segmento: usouLivre ? formEnd.categoria_livre.value.trim() : opcao ? opcao.dataset.nome : '',
        // O texto sozinho nao bloqueia concorrente: quem faz isso e o
        // categoria_id, que o gerador da playlist compara com o do anunciante.
        // Sem ele, o ponto nascia sem bloqueio e a tela do dono podia exibir
        // anuncio do concorrente da esquina.
        categoria_id: usouLivre ? null : formEnd.categoria_id.value || null,
      }),
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corpo.erro || 'falha');
    msg.textContent = 'Pedido enviado. A gente chama no WhatsApp pra combinar.';
    msg.className = 'form-msg ok';
    formEnd.reset();
    formEnd.hidden = true;
    carregarPontos();
  } catch (err) {
    msg.textContent = err.message === 'falha' ? 'Não foi possível enviar agora.' : err.message;
    msg.className = 'form-msg err';
  }
});

carregar().catch(() => {
  document.getElementById('statusBanner').textContent = 'Não foi possível carregar sua conta agora.';
});

// ---------------------------------------------------------------------------
// Autoanúncio do dono do ponto
//
// A cota de tela pro próprio negócio é a contrapartida do comodato — e é a
// modalidade inteira de quem abre mão dos R$ 50. O gerador da playlist já
// puxava os criativos aprovados desta conta (criativosDoDono, limite 3) e não
// havia nenhuma tela pra subir o vídeo: a cota era reservada e ficava vazia.
// A rota é a mesma do anunciante (POST /anunciantes/:id/criativos), que já
// aceita conta sem plano com teto de 1.
// ---------------------------------------------------------------------------
function ehVideoArquivo(url) {
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url || '');
}

async function carregarAutoanuncio() {
  const el = document.getElementById('listaAutoanuncio');
  if (!el || !CONTA) return;
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/${CONTA.id}/criativos`, { credentials: 'include' });
    const criativos = await r.json();
    if (!r.ok || !Array.isArray(criativos)) throw new Error('resposta inesperada');
    el.innerHTML = criativos.length
      ? `<div class="criativos-lista u-mt-16">
      ${criativos
        .map(
          (c) => `<div class="criativo-card" data-id="${c.id}">
        ${
          c.arquivo_normalizado_url
            ? ehVideoArquivo(c.arquivo_normalizado_url)
              ? `<video src="${esc(c.arquivo_normalizado_url)}" muted loop playsinline poster="${esc(c.thumbnail_url || '')}"></video>`
              : `<img src="${esc(c.arquivo_normalizado_url)}" alt="">`
            : '<div class="criativo-placeholder">processando...</div>'
        }
        <button type="button" class="criativo-excluir" aria-label="Excluir anúncio">&times;</button>
        <span class="badge ${ROTULOS.criativoClasse[c.status]}">${ROTULOS.criativo[c.status]}</span>
        ${c.status === 'reprovado' ? `<p class="criativo-motivo">${c.motivo_reprovacao ? esc(c.motivo_reprovacao) : 'Fale com a gente pra entender o que ajustar.'}<br><b>Exclua esta peça e suba a versão corrigida.</b></p>` : ''}
      </div>`,
        )
        .join('')}
    </div>`
      : '<p class="empty-state">Você ainda não subiu o seu anúncio. A cota na sua tela está reservada e vazia.</p>';
  } catch (err) {
    console.error('falha ao montar a lista do autoanúncio', err);
    el.innerHTML = '<p class="form-msg err">Não foi possível carregar seus anúncios agora.</p>';
  }
}

document.getElementById('listaAutoanuncio')?.addEventListener('click', async (e) => {
  const card = e.target.closest('.criativo-card');
  if (!card || !e.target.closest('.criativo-excluir')) return;
  if (!window.confirm('Excluir esse anúncio? Ele sai da sua tela.')) return;
  const msg = document.getElementById('msgAutoanuncio');
  const r = await fetch(`${API_BASE_URL}/anunciantes/${CONTA.id}/criativos/${card.dataset.id}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  msg.textContent = r.ok ? 'Anúncio excluído.' : 'Não foi possível excluir agora. Tente de novo.';
  msg.className = r.ok ? 'form-msg ok' : 'form-msg err';
  if (r.ok) carregarAutoanuncio();
});

document.getElementById('arquivoAutoanuncio')?.addEventListener('change', async (e) => {
  const input = e.target;
  const msg = document.getElementById('msgAutoanuncio');
  if (!input.files[0]) return;
  msg.textContent = 'Enviando e processando, pode levar um minuto...';
  msg.className = 'form-msg';
  input.disabled = true;
  const form = new FormData();
  form.append('arquivo', input.files[0]);
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/${CONTA.id}/criativos`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || '');
    msg.textContent = 'Enviado! A gente confere e ele entra na sua cota.';
    msg.className = 'form-msg ok';
    input.value = '';
    carregarAutoanuncio();
  } catch (err) {
    msg.textContent = err.message ? window.frase(err.message) : 'Não foi possível enviar agora. Tente de novo.';
    msg.className = 'form-msg err';
  } finally {
    input.disabled = false;
  }
});
