// "Hospede temporariamente um Ponto Móvel Mostraí" (migration 113). Só
// manifestação de interesse: POST /hospedagem/interesse. O percentual do
// texto vem do servidor (GET /hospedagem/condicao) — nada fixo na página.
const form = document.getElementById('formHospedar');
const msg = document.getElementById('msg');
const botaoEnviar = form.querySelector('[type="submit"]');

document.getElementById('hospEndereco').innerHTML = window.camposEndereco('h_', {
  cidadePadrao: 'Matão',
  ufPadrao: 'SP',
});
window.ligarCep(form);

const horasTexto = (segundos) => {
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
};

(async () => {
  try {
    const r = await fetch(`${API_BASE_URL}/hospedagem/condicao`);
    if (!r.ok) return;
    const c = await r.json();
    const pct = `${String(c.percentual).replace('.', ',')}%`;
    document.getElementById('hospPercentual').textContent = `${pct} do tempo operado vira horas de mídia`;
    document.getElementById('hospExemplo').textContent =
      `Com ${pct}: ${c.exemplo.horasDeOperacao} h de operação geram ${horasTexto(c.exemplo.segundosDeMidia)} de mídia ` +
      'para anunciar o seu negócio na rede inteira. Conta só o tempo em que a tela esteve ligada e funcionando.';
  } catch {
    // Sem o número, o texto genérico da página continua valendo.
  }
})();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Enviando...';
  msg.className = 'form-msg';
  botaoEnviar.disabled = true;
  try {
    const dados = Object.fromEntries(new FormData(form));
    const r = await fetch(`${API_BASE_URL}/hospedagem/interesse`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...dados, ...window.enderecoDoForm(form) }),
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corpo.erro || 'Não foi possível enviar agora.');
    msg.textContent = 'Recebemos seu interesse! A Mostraí entra em contato pelo WhatsApp informado.';
    msg.className = 'form-msg ok';
    form.reset();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-msg err';
  } finally {
    botaoEnviar.disabled = false;
  }
});
