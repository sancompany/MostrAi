const pool = require('../db/pool');
const movel = require('./movel');
const hospedagem = require('./hospedagem');
const alocacao = require('./alocacao');
const horarioSemanal = require('../lib/horario-semanal');
const { colunasDoEndereco, parteQueFalta, problemaNoEndereco, linhaEndereco, temEndereco } = require('../lib/endereco');

// COMPROMISSO MÓVEL — a abstração ÚNICA do Admin para "uma ou mais telas da
// rede, num local, num período, com um horário" (estação Rede Front V3,
// 06/10/2026). Antes eram dois fluxos (Nova hospedagem / Novo evento) que
// diziam a mesma coisa operacional; agora o Admin escolhe o CONTEXTO:
//   conta    — numa conta/estabelecimento cadastrado (a conta anfitriã).
//              Internamente é a HOSPEDAGEM (src/pontos/hospedagem.js): uma
//              tela, benefício com percentual congelado, termo físico,
//              entrega e retirada — nada disso muda.
//   externo  — em outro local ou evento, sem conta. Internamente é o EVENTO
//              (src/pontos/movel.js): 1..N telas, sem benefício, sem termo.
// As duas tabelas continuam (nenhuma migration destrutiva por estética); a
// regra nova mora AQUI, uma vez: o local (endereço vindo da conta, de um
// ponto da conta ou digitado em partes), o horário EXPLÍCITO (nunca 24 h
// implícito — "do local", "personalizado" ou "durante todo o período") e a
// categoria protegida (padrão: a do local). Conflito de agenda continua por
// TELA (src/pontos/agenda.js + gatilhos da 115).
//
// Referência de um compromisso: "h12" (conta/hospedagem 12) ou "e5"
// (externo/evento 5) — estável, sem misturar ids das duas tabelas.

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });

const CONTEXTOS = new Set(['conta', 'externo']);
const MODOS_DE_HORARIO = new Set(['local', 'personalizado', 'periodo']);
const ORIGENS_DE_ENDERECO = new Set(['conta', 'ponto', 'outro', 'atual']);

function lerRef(ref) {
  const m = /^([he])(\d{1,15})$/.exec(String(ref || ''));
  if (!m) throw erro(404, 'compromisso não encontrado');
  return { tipo: m[1] === 'h' ? 'hospedagem' : 'evento', id: m[2] };
}

// ---------------------------------------------------------------------------
// Seletor de conta (autocomplete do Admin)
// ---------------------------------------------------------------------------
// Busca paginada por nome, e-mail ou documento — nunca a lista inteira no
// DOM. Sem a conta própria e sem conta excluída (não hospedam). Mostra o
// bastante para distinguir duas "Padaria Central": cidade e contato.
async function buscarContas(termo, { limite = 12 } = {}) {
  const t = String(termo || '')
    .trim()
    .slice(0, 80);
  const digitos = t.replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT a.id, a.nome_empresa AS nome, a.cidade, a.uf, a.contato_email AS email, a.contato_telefone AS telefone,
            (SELECT COUNT(*)::int FROM pontos p WHERE p.anunciante_id = a.id AND p.tipo = 'fixo'
               AND p.status <> 'arquivado') AS pontos
       FROM anunciantes a
      WHERE a.excluido_em IS NULL AND NOT a.conta_propria
        AND ($1 = '' OR a.nome_empresa ILIKE $2 OR a.contato_email ILIKE $2
             OR ($3 <> '' AND regexp_replace(a.cpf_cnpj, '\\D', '', 'g') LIKE $4))
      ORDER BY (a.nome_empresa ILIKE $5) DESC, a.nome_empresa, a.id
      LIMIT $6`,
    [t, `%${t}%`, digitos.length >= 3 ? digitos : '', `%${digitos}%`, `${t}%`, Math.min(Math.max(limite, 1), 30)],
  );
  return rows;
}

const partesDe = (x) => ({
  cep: x.cep || '',
  logradouro: x.logradouro || '',
  numero: x.numero || '',
  complemento: x.complemento || '',
  bairro: x.bairro || '',
  cidade: x.cidade || '',
  uf: x.uf || '',
});

// Os LOCAIS de uma conta para o compromisso: o endereço principal dela e os
// pontos fixos (cada um com endereço, horário e categoria) — o Admin não
// redigita o que o sistema já sabe.
async function locaisDaConta(contaId) {
  const id = /^\d{1,9}$/.test(String(contaId)) ? Number(contaId) : null;
  if (!id) return null;
  const {
    rows: [conta],
  } = await pool.query(
    `SELECT a.id, a.nome_empresa, a.endereco, a.cep, a.logradouro, a.numero, a.complemento, a.bairro, a.cidade, a.uf,
            a.categoria_id, cat.nome AS categoria_nome
       FROM anunciantes a LEFT JOIN categorias cat ON cat.id = a.categoria_id
      WHERE a.id = $1 AND a.excluido_em IS NULL AND NOT a.conta_propria`,
    [id],
  );
  if (!conta) return null;
  const { rows: pontos } = await pool.query(
    `SELECT p.id, p.nome, p.endereco, p.cep, p.logradouro, p.numero, p.complemento, p.bairro, p.cidade, p.uf,
            p.horario_semanal, p.categoria_id, cat.nome AS categoria_nome
       FROM pontos p LEFT JOIN categorias cat ON cat.id = p.categoria_id
      WHERE p.anunciante_id = $1 AND p.tipo = 'fixo' AND p.status <> 'arquivado'
      ORDER BY p.nome, p.id`,
    [id],
  );
  const categoria = (x) => (x.categoria_id ? { id: x.categoria_id, nome: x.categoria_nome } : null);
  return {
    conta: {
      id: conta.id,
      nome: conta.nome_empresa,
      endereco: temEndereco(conta) ? linhaEndereco(conta, { comCidade: true }) : null,
      partes: partesDe(conta),
      categoria: categoria(conta),
    },
    pontos: pontos.map((p) => ({
      id: p.id,
      nome: p.nome,
      endereco: linhaEndereco(p, { comCidade: true }),
      partes: partesDe(p),
      horario: p.horario_semanal || null,
      horarioResumo: p.horario_semanal ? horarioSemanal.resumo(p.horario_semanal) : null,
      categoria: categoria(p),
    })),
  };
}

// ---------------------------------------------------------------------------
// Regras do formulário
// ---------------------------------------------------------------------------
// Endereço digitado: partes canônicas (src/lib/endereco.js), completas (só o
// complemento é opcional) → a linha que as tabelas gravam.
function linhaDoEnderecoDigitado(corpo) {
  const e = corpo?.endereco_partes;
  if (!e || typeof e !== 'object') throw erro(400, 'Endereço: preencha CEP, rua, número, bairro, cidade e UF', 'cep');
  const problema = problemaNoEndereco(e);
  if (problema) throw erro(400, problema.erro, problema.campo);
  const colunas = colunasDoEndereco(e);
  const falta = parteQueFalta(colunas);
  if (falta) {
    const campo = ['cep', 'logradouro', 'numero', 'bairro', 'cidade', 'uf'].find((p) => !colunas[p]) || 'cep';
    throw erro(400, `Endereço: preencha ${falta}`, campo);
  }
  return linhaEndereco(colunas, { comCidade: true });
}

// O horário EXPLÍCITO do compromisso — nunca 24 h por omissão:
//   local         a CÓPIA do horário do ponto escolhido, gravada no
//                 compromisso (o comércio pode mudar o horário amanhã sem
//                 mexer no que já foi programado);
//   personalizado a grade informada (alocacao.lerHorario);
//   periodo       operar continuamente de `inicio` a `fim` — escolha
//                 explícita do Admin (o evento de 18:00 às 23:00).
function lerHorarioDoCompromisso(corpo, horarioDoLocal) {
  const modo = corpo?.horario_modo;
  if (!MODOS_DE_HORARIO.has(modo)) {
    throw erro(400, 'Horário: escolha como a tela vai operar no período', 'horario_modo');
  }
  if (modo === 'periodo') return { operar_todo_periodo: true };
  if (modo === 'local') {
    if (!horarioDoLocal) {
      throw erro(400, 'Esse local não tem horário cadastrado — personalize o horário', 'horario_modo');
    }
    return { horario_operacao: alocacao.lerHorario(horarioDoLocal) };
  }
  return { horario_operacao: alocacao.lerHorario(corpo?.horario_operacao) };
}

function lerTelas(corpo) {
  const lista = Array.isArray(corpo?.telas) ? corpo.telas : corpo?.telas != null ? [corpo.telas] : [];
  return [...new Set(lista.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

// Categoria: chave ausente = padrão do local; '' / null = "Nenhuma
// restrição" escolhida de propósito; número = essa.
function lerCategoriaEscolhida(corpo) {
  if (!corpo || !Object.hasOwn(corpo, 'categoria_id')) return { padrao: true };
  const v = corpo.categoria_id;
  if (v === null || v === '') return { nenhuma: true };
  return { id: v };
}

// O local de um compromisso de CONTA: de onde vem o endereço e, com ele, o
// horário e a categoria padrão.
async function localDaConta(contaId, corpo, atual) {
  const locais = await locaisDaConta(contaId);
  if (!locais) throw erro(400, 'Escolha a conta anfitriã', 'conta_id');
  const origem = corpo?.endereco_origem;
  // Edição: "manter o endereço" de um compromisso já gravado.
  if (origem === 'atual' && atual) {
    return { nome: atual.local, endereco: atual.endereco, horario: null, categoria: locais.conta.categoria };
  }
  if (!ORIGENS_DE_ENDERECO.has(origem)) throw erro(400, 'Endereço: escolha de onde ele vem', 'endereco_origem');
  if (origem === 'conta') {
    if (!locais.conta.endereco) {
      throw erro(400, 'A conta não tem endereço completo — use um ponto dela ou outro endereço', 'endereco_origem');
    }
    return {
      nome: locais.conta.nome,
      endereco: locais.conta.endereco,
      horario: null,
      categoria: locais.conta.categoria,
    };
  }
  if (origem === 'ponto') {
    const ponto = locais.pontos.find((p) => String(p.id) === String(corpo?.ponto_id));
    if (!ponto) throw erro(400, 'Escolha um ponto desta conta', 'ponto_id');
    return { nome: ponto.nome, endereco: ponto.endereco, horario: ponto.horario, categoria: ponto.categoria };
  }
  return {
    nome: locais.conta.nome,
    endereco: linhaDoEnderecoDigitado(corpo),
    horario: null,
    categoria: locais.conta.categoria,
  };
}

// O corpo do compromisso → o corpo que a hospedagem ou o evento aceitam.
async function traduzir(corpo, { edicao = false, atual = null } = {}) {
  const contexto = corpo?.contexto;
  if (!CONTEXTOS.has(contexto)) throw erro(400, 'Escolha onde a tela ficará', 'contexto');
  const telas = lerTelas(corpo);
  const categoria = lerCategoriaEscolhida(corpo);
  const periodo = { inicio: corpo?.inicio, fim: corpo?.fim };
  const observacao = corpo?.observacao;

  if (contexto === 'conta') {
    const contaId = Number(corpo?.conta_id);
    if (!Number.isInteger(contaId) || contaId <= 0) throw erro(400, 'Escolha a conta anfitriã', 'conta_id');
    // Hospedagem = UMA tela (regra comercial atual — não aumenta aqui).
    if (telas.length !== 1) throw erro(400, 'Na conta anfitriã vai uma tela por compromisso', 'telas');
    const local = await localDaConta(contaId, corpo, atual);
    const horario = lerHorarioDoCompromisso(corpo, local.horario);
    const nomeDoLocal = typeof corpo?.local === 'string' && corpo.local.trim() ? corpo.local : local.nome;
    const base = {
      dispositivo_id: telas[0],
      local: nomeDoLocal,
      endereco: local.endereco,
      ...periodo,
      ...horario,
      observacao,
    };
    if (categoria.nenhuma) base.sem_categoria = true;
    else base.categoria_id = categoria.padrao ? (local.categoria?.id ?? '') : categoria.id;
    if (base.categoria_id === '') base.sem_categoria = true;
    if (edicao) return { tipo: 'hospedagem', corpo: base };
    return {
      tipo: 'hospedagem',
      corpo: {
        ...base,
        conta_id: contaId,
        percentual_esperado: corpo?.percentual_esperado,
        ...(corpo?.interesse_id ? { interesse_id: corpo.interesse_id } : {}),
      },
    };
  }

  // Outro local / evento: sem conta, sem benefício, sem termo.
  const horario = lerHorarioDoCompromisso(corpo, null);
  return {
    tipo: 'evento',
    corpo: {
      nome: corpo?.nome,
      organizacao: corpo?.organizacao,
      local: corpo?.local,
      endereco: corpo?.endereco_origem === 'atual' && atual ? atual.endereco : linhaDoEnderecoDigitado(corpo),
      ...periodo,
      ...horario,
      observacao,
      categoria_id: categoria.padrao || categoria.nenhuma ? '' : categoria.id,
      telas,
    },
  };
}

async function criar(redeId, corpo, admin) {
  const { tipo, corpo: traduzido } = await traduzir(corpo);
  if (tipo === 'hospedagem') {
    const r = await hospedagem.criar(redeId, traduzido, admin);
    return { ref: `h${r.id}`, contexto: 'conta', contaId: r.contaId, percentual: r.percentual, telas: [r.telaId] };
  }
  const id = await movel.criarEvento(redeId, traduzido, admin);
  return { ref: `e${id}`, contexto: 'externo', contaId: null, telas: traduzido.telas };
}

// Editar: o compromisso programado inteiro (o contexto não muda — conta vira
// conta); hospedagem ATIVA só prorroga o fim (src/pontos/hospedagem.js).
async function editar(redeId, ref, corpo) {
  const { tipo, id } = lerRef(ref);
  if (tipo === 'hospedagem') {
    const {
      rows: [h],
    } = await pool.query(
      'SELECT estado, conta_id, local, endereco FROM pontos_moveis_hospedagens WHERE id = $1 AND ponto_id = $2',
      [id, redeId],
    );
    if (!h) throw erro(404, 'compromisso não encontrado');
    if (h.estado === 'ativa') {
      const r = await hospedagem.alterarPeriodo(redeId, id, { fim: corpo?.fim });
      return { ref, contaId: r.contaId };
    }
    const { corpo: traduzido } = await traduzir(
      { ...corpo, contexto: 'conta', conta_id: h.conta_id },
      { edicao: true, atual: h },
    );
    const r = await hospedagem.alterarPeriodo(redeId, id, traduzido);
    return { ref, contaId: r.contaId };
  }
  const {
    rows: [e],
  } = await pool.query('SELECT endereco FROM pontos_moveis_eventos WHERE id = $1 AND ponto_id = $2', [id, redeId]);
  if (!e) throw erro(404, 'compromisso não encontrado');
  const { corpo: traduzido } = await traduzir({ ...corpo, contexto: 'externo' }, { edicao: true, atual: e });
  await movel.editarEvento(redeId, id, traduzido);
  return { ref, contaId: null };
}

// Iniciar / encerrar / cancelar — a mesma porta para os dois contextos. Na
// conta, iniciar continua exigindo termo físico assinado e a entrega.
async function agir(redeId, ref, acao, corpo, admin) {
  const { tipo, id } = lerRef(ref);
  if (!['iniciar', 'encerrar', 'cancelar'].includes(acao)) throw erro(404, 'ação desconhecida');
  if (tipo === 'hospedagem') {
    if (acao === 'iniciar') return hospedagem.iniciar(redeId, id, corpo || {}, admin);
    if (acao === 'encerrar') return hospedagem.encerrar(redeId, id, admin, corpo || {});
    return hospedagem.cancelar(redeId, id);
  }
  const fn = { iniciar: movel.iniciarEvento, encerrar: movel.encerrarEvento, cancelar: movel.cancelarEvento }[acao];
  await fn(redeId, id);
  return { contaId: null };
}

// ---------------------------------------------------------------------------
// Leitura: UM formato para os dois contextos
// ---------------------------------------------------------------------------
// Estado único: programado → em_curso → encerrado | cancelado.
const ESTADO = {
  programada: 'programado',
  programado: 'programado',
  ativa: 'em_curso',
  em_andamento: 'em_curso',
  encerrada: 'encerrado',
  encerrado: 'encerrado',
  cancelada: 'cancelado',
  cancelado: 'cancelado',
};

function daHospedagem(h) {
  return {
    ref: `h${h.id}`,
    contexto: 'conta',
    id: h.id,
    nome: h.local,
    local: h.local,
    organizacao: null,
    endereco: h.endereco,
    conta: h.conta,
    inicio: h.inicio,
    fim: h.fim,
    inicioLocal: h.inicioLocal,
    fimLocal: h.fimLocal,
    horario: h.horario,
    horarioOperacao: h.horarioOperacao,
    estado: ESTADO[h.estado] || h.estado,
    estadoOriginal: h.estado,
    terminou: h.terminou,
    telas: [h.tela],
    categoria: h.categoria,
    observacao: h.observacao,
    encerramento: h.encerramento,
    // Só no contexto de conta: benefício, termo físico e equipamento.
    hospedagem: {
      percentual: h.percentual,
      tempoSegundos: h.tempoSegundos,
      beneficioSegundos: h.beneficioSegundos,
      estimado: h.estimado,
      termo: h.termo,
      entrega: h.entrega,
      retirada: h.retirada,
      interesseId: h.interesseId,
    },
  };
}

function doEvento(e) {
  return {
    ref: `e${e.id}`,
    contexto: 'externo',
    id: e.id,
    nome: e.nome,
    local: e.local,
    organizacao: e.organizacao,
    endereco: e.endereco,
    conta: null,
    inicio: e.inicio,
    fim: e.fim,
    inicioLocal: e.inicioLocal,
    fimLocal: e.fimLocal,
    horario: e.horario,
    horarioOperacao: e.horarioOperacao,
    estado: ESTADO[e.estado] || e.estado,
    estadoOriginal: e.estado,
    terminou: e.terminou,
    telas: e.telas,
    categoria: e.categoria,
    observacao: e.observacao,
    encerramento: e.encerramento,
    exibicoesConfirmadas: e.exibicoesConfirmadas,
    hospedagem: null,
  };
}

// Agora (em curso) + próximos, por início; o histórico (encerrado/cancelado)
// do mais recente para trás.
function normalizar(hospedagens, eventos) {
  const todos = [...hospedagens.map(daHospedagem), ...eventos.map(doEvento)];
  const porInicio = (a, b) => new Date(a.inicio) - new Date(b.inicio);
  return {
    agora: todos.filter((c) => c.estado === 'em_curso').sort(porInicio),
    proximos: todos.filter((c) => c.estado === 'programado').sort(porInicio),
    historico: todos
      .filter((c) => c.estado === 'encerrado' || c.estado === 'cancelado')
      .sort((a, b) => new Date(b.inicio) - new Date(a.inicio)),
  };
}

async function listar(redeId) {
  const ficha = await movel.fichaDaRede(redeId);
  if (!ficha) return null;
  if (ficha.tipo !== 'movel') throw erro(409, 'compromisso é da rede móvel');
  return ficha.compromissos;
}

module.exports = {
  buscarContas,
  locaisDaConta,
  lerHorarioDoCompromisso,
  traduzir,
  criar,
  editar,
  agir,
  listar,
  normalizar,
  lerRef,
};
