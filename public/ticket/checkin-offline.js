// TICK — check-in sem internet (pedido do dono, 10/11/2026).
//
// O operador baixa o pacote da edição enquanto tem conexão. Sem internet, o
// aparelho valida sozinho:
//   1. o QR tem o formato TM1.<edição>.<código>.<assinatura>;
//   2. a assinatura Ed25519 confere com a chave pública da edição (WebCrypto,
//      quando o navegador tem — Chrome/Android e Safari/iPhone atuais têm);
//   3. o hash SHA-256 do código está no pacote (só quem tem o ingresso tem o
//      código; o pacote não tem o código em claro);
//   4. situação (cancelado, bloqueado) e uso: já entrou segundo o pacote ou
//      já entrou NESTE aparelho.
// Cada entrada liberada fica guardada aqui, com um id único, e sobe quando a
// conexão volta. Outro aparelho sem internet não sabe desta entrada: a mesma
// pessoa pode passar pelos dois — o servidor detecta na sincronização e o
// Admin vê o conflito. Guardado no aparelho: só o pacote (hashes, situação,
// tipo e primeiro nome) e as entradas; nada de CPF nem e-mail.
(() => {
  const PREFIXO = 'tick:offline';
  const ler = (k, padrao = null) => {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : padrao;
    } catch {
      return padrao;
    }
  };
  const gravar = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch {
      return false; // sem espaço: o chamador avisa
    }
  };

  function aparelhoId() {
    let id = ler(`${PREFIXO}:aparelho`);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      gravar(`${PREFIXO}:aparelho`, id);
    }
    return id;
  }
  const novoRegistroId = () =>
    crypto.randomUUID?.() ||
    '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
      (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16),
    );

  const b64url = (texto) => {
    const s = texto.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const paraB64url = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const sha256 = async (texto) => paraB64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto)));

  // ------------------------------------------------------------- pacote
  const chavePacote = (edicaoId) => `${PREFIXO}:pacote:${edicaoId}`;
  const chaveRegistros = (edicaoId) => `${PREFIXO}:registros:${edicaoId}`;
  const indices = new Map(); // edicaoId → { porCodigo, porCurto, porId }

  function indexar(edicaoId, pacote) {
    const porCodigo = new Map();
    const porCurto = new Map();
    const porId = new Map();
    for (const i of pacote.ingressos) {
      porCodigo.set(i.h, i);
      porCurto.set(i.c, i);
      porId.set(i.i, i);
    }
    const idx = { pacote, porCodigo, porCurto, porId, chave: undefined };
    indices.set(String(edicaoId), idx);
    return idx;
  }
  function indice(edicaoId) {
    const k = String(edicaoId);
    if (indices.has(k)) return indices.get(k);
    const p = ler(chavePacote(edicaoId));
    return p ? indexar(edicaoId, p) : null;
  }
  function salvarPacote(edicaoId, pacote) {
    const ok = gravar(chavePacote(edicaoId), { ...pacote, baixado_em: new Date().toISOString() });
    if (ok) indexar(edicaoId, ler(chavePacote(edicaoId)));
    return ok;
  }
  const infoDoPacote = (edicaoId) => {
    const idx = indice(edicaoId);
    return idx ? { ingressos: idx.pacote.ingressos.length, baixado_em: idx.pacote.baixado_em } : null;
  };

  // Ed25519 no WebCrypto. Sem suporte, a assinatura não é conferida no
  // aparelho — vale só o hash do código no pacote (que já basta para saber
  // que o ingresso existe) — e o resultado diz isso.
  async function chaveDaEdicao(idx) {
    if (idx.chave !== undefined) return idx.chave;
    try {
      idx.chave = await crypto.subtle.importKey('spki', b64url(idx.pacote.chave_publica), { name: 'Ed25519' }, false, [
        'verify',
      ]);
    } catch {
      idx.chave = null;
    }
    return idx.chave;
  }

  // ------------------------------------------------------------ registros
  const registros = (edicaoId) => ler(chaveRegistros(edicaoId), []);
  const salvarRegistros = (edicaoId, lista) => gravar(chaveRegistros(edicaoId), lista);
  const pendentes = (edicaoId) => registros(edicaoId).filter((r) => !r.sincronizado);
  const entradaLocal = (edicaoId, ingressoId) =>
    registros(edicaoId).find(
      (r) => r.ingresso_id === ingressoId && r.resultado !== 'conflito' && r.resultado !== 'recusado',
    );

  // Depois de uma entrada ONLINE neste aparelho: o pacote passa a saber.
  function marcarUtilizado(edicaoId, ingressoId) {
    const idx = indice(edicaoId);
    const i = idx?.porId.get(Number(ingressoId));
    if (!i || i.u) return;
    i.u = true;
    gravar(chavePacote(edicaoId), idx.pacote);
  }

  const QR = /^TM1\.([A-Za-z0-9_-]{10,40})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{86})$/;
  const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function codigoCurto(texto) {
    const s = String(texto || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (s.length !== 8 || [...s].some((c) => !ALFABETO.includes(c))) return null;
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  }

  // Mesmo formato da resposta do servidor (consultar), com `offline: true`.
  async function validar(edicaoId, entrada) {
    const idx = indice(edicaoId);
    if (!idx) return { resultado: 'sem_pacote', offline: true };
    const texto = String(entrada || '').trim();
    let item = null;
    let assinatura = 'sem_qr';
    const m = QR.exec(texto);
    if (m) {
      const [, codigoPublico, codigo, sig] = m;
      if (codigoPublico !== idx.pacote.edicao.codigo_publico) return { resultado: 'outra_edicao', offline: true };
      const chave = await chaveDaEdicao(idx);
      if (chave) {
        let ok = false;
        try {
          ok = await crypto.subtle.verify(
            { name: 'Ed25519' },
            chave,
            b64url(sig),
            new TextEncoder().encode(`TM1.${codigoPublico}.${codigo}`),
          );
        } catch {
          ok = false;
        }
        if (!ok) return { resultado: 'invalido', offline: true };
        assinatura = 'conferida';
      } else {
        assinatura = 'nao_suportada';
      }
      item = idx.porCodigo.get(await sha256(codigo));
    } else if (texto.startsWith('TM1.')) {
      return { resultado: 'invalido', offline: true };
    } else {
      const curto = codigoCurto(texto);
      if (!curto) return { resultado: 'invalido', offline: true };
      item = idx.porCurto.get(await sha256(`${idx.pacote.edicao.codigo_publico}:${curto}`));
    }
    if (!item) return { resultado: 'nao_encontrado', offline: true, assinatura };
    const local = entradaLocal(edicaoId, item.i);
    const ingresso = {
      id: item.i,
      participante: item.n,
      categoria: item.t,
      status: item.s,
      utilizado_em: local?.lido_em || null,
      utilizado_aqui: Boolean(local),
    };
    let resultado = 'valido';
    if (item.s === 'cancelado') resultado = 'cancelado';
    else if (item.s === 'bloqueado') resultado = 'bloqueado';
    else if (item.u || local) resultado = 'ja_utilizado';
    return {
      resultado,
      offline: true,
      assinatura,
      ingresso,
      classificacao_etaria: idx.pacote.edicao.classificacao_etaria,
    };
  }

  function registrarEntrada(edicaoId, ingressoId) {
    if (entradaLocal(edicaoId, ingressoId)) return { resultado: 'ja_utilizado', offline: true };
    const lista = registros(edicaoId);
    const reg = {
      registro_id: novoRegistroId(),
      ingresso_id: ingressoId,
      lido_em: new Date().toISOString(),
      sincronizado: false,
    };
    lista.push(reg);
    if (!salvarRegistros(edicaoId, lista)) return { resultado: 'sem_espaco', offline: true };
    return { resultado: 'entrada_registrada', offline: true, registro: reg };
  }

  // Sobe o que está pendente (em lotes de 500). `api` é o do comum.js.
  async function sincronizar(edicaoId, api) {
    const fila = pendentes(edicaoId);
    let conflitos = 0;
    for (let n = 0; n < fila.length; n += 500) {
      const lote = fila.slice(n, n + 500);
      const r = await api('/ticket/api/checkin/sincronizar', {
        metodo: 'POST',
        corpo: {
          edicao_id: edicaoId,
          aparelho_id: aparelhoId(),
          registros: lote.map(({ registro_id, ingresso_id, lido_em }) => ({ registro_id, ingresso_id, lido_em })),
        },
      });
      const porId = new Map(r.resultados.map((x) => [x.registro_id, x]));
      const lista = registros(edicaoId).map((reg) => {
        const x = porId.get(reg.registro_id);
        if (!x) return reg;
        if (x.resultado === 'conflito' || x.resultado === 'recusado') conflitos++;
        return { ...reg, sincronizado: true, resultado: x.resultado, motivo: x.motivo || null };
      });
      salvarRegistros(edicaoId, lista);
    }
    return { enviados: fila.length, conflitos };
  }

  const resumo = (edicaoId) => {
    const lista = registros(edicaoId);
    return {
      entradas: lista.filter((r) => r.resultado !== 'conflito' && r.resultado !== 'recusado').length,
      pendentes: lista.filter((r) => !r.sincronizado).length,
      conflitos: lista.filter((r) => r.resultado === 'conflito' || r.resultado === 'recusado').length,
    };
  };

  // Ao sair: o pacote sai do aparelho; entradas ainda não enviadas, não.
  function limparAoSair() {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(`${PREFIXO}:pacote:`) || k === `${PREFIXO}:operador`) localStorage.removeItem(k);
      if (k.startsWith(`${PREFIXO}:registros:`)) {
        const restantes = (ler(k, []) || []).filter((r) => !r.sincronizado);
        if (restantes.length) gravar(k, restantes);
        else localStorage.removeItem(k);
      }
    }
    indices.clear();
  }
  const totalPendente = () =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith(`${PREFIXO}:registros:`))
      .reduce((t, k) => t + (ler(k, []) || []).filter((r) => !r.sincronizado).length, 0);

  window.tickOffline = {
    aparelhoId,
    salvarPacote,
    infoDoPacote,
    validar,
    registrarEntrada,
    marcarUtilizado,
    sincronizar,
    resumo,
    pendentes,
    totalPendente,
    limparAoSair,
    guardarOperador: (o) => gravar(`${PREFIXO}:operador`, o),
    operadorGuardado: () => ler(`${PREFIXO}:operador`),
    suportaAssinatura: async () => {
      try {
        const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
        return Boolean(k);
      } catch {
        return false;
      }
    },
  };
})();
