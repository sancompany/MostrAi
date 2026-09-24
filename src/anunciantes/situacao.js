const express = require('express');
const pool = require('../db/pool');
const repo = require('./repository');
const assinaturasRepo = require('../financeiro/assinaturas-repository');
const planoAdministrativo = require('../financeiro/plano-administrativo');
const creditosRepo = require('../creditos/repository');
const { CUSTO_BASE_POR_MES, NOME_TIER } = require('../creditos/regras');
const { meusPontosDaConta } = require('../pontos/meus-pontos');
const { horasDeTelaPorMes } = require('../lib/pacing');
const { limiteDeCriativos } = require('../playlist/gerador');
const { CRIATIVOS_POR_CONTA } = require('../lib/limites');
const { criativosComSituacao } = require('./routes');
const { linhaEndereco } = require('../lib/endereco');

// SITUAÇÃO DA CONTA — a leitura de domínio da ficha de Conta do admin
// (revisão de 23/09/2026, pedido do dono: "a interface precisa representar o
// domínio da Mostraí, não a estrutura das tabelas").
//
// Antes, a ficha montava a conta no navegador a partir de seis listas cruas
// (`/admin/anunciantes`, `/admin/pontos`, `/plano`, `/criativos`,
// `/creditos`, `/admin/planos`) e cada card tirava a própria conclusão — foi
// assim que "Sem ponto em comodato" e "Pontos: Santos unio · Inativo"
// apareceram lado a lado: um card lia o campo espelho da conta, o outro a
// lista de pontos. Aqui cada regra é decidida UMA vez, e a tela só desenha.
//
// As regras, na ordem em que a ficha mostra:
//
// PLANO (o direito de veicular na rede): só Essencial, Pro ou Prime.
//   · "Agora" é o que o gerador honra hoje (`repo.planoVigenteId`, mesma
//     condição de src/playlist/gerador.js): o comercial dentro da validade.
//   · A ORIGEM sai de fato gravado, nunca de rótulo livre: sem
//     `plano_cortesia` = assinatura paga; cortesia com a linha 'ativo' de
//     `planos_administrativos` de origem 'indicacao' = benefício por
//     créditos; qualquer outra cortesia = cortesia administrativa LEGADA.
//   · "Próximo" é o benefício 'agendado', ou o plano PAGO guardado por baixo
//     de um benefício em vigor (migration 082) — volta quando ele acabar.
//   · "Depois" é o que sobra quando a fila acaba: renovação da assinatura ou
//     nenhum plano. Nada é cobrado sozinho.
//   Inicial/Básico não são mais plano (24/09/2026, ADR-016).
//
// PONTO: gera créditos, não plano. Cada ponto aprovado mostra o benefício
//   (+1 crédito/mês, elegível ou não, último crédito) pela mesma regra do job
//   (creditos/ponto.js). Não existe card "Comodato" comercial.
//
// PONTO × CANDIDATURA: ponto é linha de `pontos` com `anunciante_id` desta
//   conta e não arquivada (mesma consulta de "Meus pontos" do painel —
//   src/pontos/meus-pontos.js). Candidatura em análise é SOLICITAÇÃO, nunca
//   ponto, e nunca dá o selo "Dono de ponto". Nada é inferido por endereço,
//   documento ou nome.
//
// SELO "Dono de ponto": ≥ 1 ponto aprovado. Não lê `papeis` (legado), nem
//   candidatura. Não existe selo "Anunciante" — toda conta anuncia.

// Nome do ciclo: a mesma linguagem pro plano pago e pro benefício por
// créditos (ADR-018, src/lib/ciclos.js).
const { nomeDoCiclo, comNomeDeCiclo } = require('../lib/ciclos');

const ORIGENS = planoAdministrativo.ORIGENS_DO_DIREITO;

const STATUS_DO_PONTO = {
  a_instalar: 'Aguardando instalação',
  em_operacao: 'Ativo',
  em_reparo: 'Em reparo',
  inativo: 'Inativo',
};

const MOTIVO_ENCERRAMENTO = {
  substituido: 'substituído',
  cancelado: 'cancelado',
  vencido: 'venceu',
  superado_por_plano_pago: 'plano pago maior entrou',
};

function nomeDoPlano(plano) {
  if (!plano) return null;
  return `${plano.nome} · ${nomeDoCiclo(plano.compromisso_meses)}`;
}

// O que o plano entrega, em números que o admin reconhece.
function direitosDoPlano(plano) {
  if (!plano) return null;
  const segundos = Number(plano.segundos_por_hora) || 0;
  const pontos = Number(plano.pontos_incluidos) || 0;
  return {
    segundosPorHora: segundos || null,
    pontos: pontos || null,
    duracaoMaxima: plano.duracao_maxima_segundos || null,
    criativosNoAr: limiteDeCriativos(false, plano.limite_criativos, 0),
    horasPorMes: segundos && pontos ? horasDeTelaPorMes(segundos, pontos) : null,
  };
}

const origemDoComercial = planoAdministrativo.origemDoDireito;
const origemDoBeneficio = (linha) => (linha.origem === 'indicacao' ? 'beneficio_creditos' : 'cortesia_legada');

// 'AAAA-MM-DD' de coluna `date` (o driver devolve texto; Date por garantia).
// Só pra `date` — timestamptz vai cru pro navegador, que formata no fuso de
// São Paulo (window.dataBR); cortar em UTC aqui mostraria o dia seguinte pra
// tudo que aconteceu depois das 21h.
function diaISO(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  return String(valor).slice(0, 10);
}

// Linha do tempo do direito de veicular: Agora → Próximo → Depois.
function linhaDoTempo({ conta, comercial, assinaturaAtiva, beneficioAtivo, beneficioAgendado, planos, agora }) {
  const comercialVigente = !!conta.plano_id && (!conta.data_expiracao || new Date(conta.data_expiracao) >= agora);
  const origem = origemDoComercial(conta, beneficioAtivo);

  let agoraItem = null;
  if (comercialVigente) {
    const renova = origem === 'assinatura' && !!assinaturaAtiva;
    agoraItem = {
      tipo: 'comercial',
      planoId: conta.plano_id,
      nome: nomeDoPlano(comercial) || 'Plano',
      origem,
      origemTexto: ORIGENS[origem],
      desde: diaISO(conta.data_inicio_cobertura),
      validoAte: diaISO(conta.data_expiracao),
      renovaEm: renova ? diaISO(conta.data_expiracao) : null,
      assinaturaCancelada: origem === 'assinatura' && !assinaturaAtiva,
      direitos: direitosDoPlano(comercial),
    };
  }

  // Plano pago GUARDADO por baixo do benefício em vigor (migration 082).
  const guardado =
    conta.plano_cortesia && conta.plano_pago_guardado_id
      ? {
          planoId: conta.plano_pago_guardado_id,
          nome: nomeDoPlano(planos[conta.plano_pago_guardado_id]) || 'Plano',
          dias: Number(conta.plano_pago_guardado_dias) || 0,
          assinaturaAtiva: !!assinaturaAtiva,
        }
      : null;

  let proximo = null;
  if (beneficioAgendado) {
    const plano = planos[beneficioAgendado.plano_id];
    const o = origemDoBeneficio(beneficioAgendado);
    proximo = {
      tipo: 'beneficio',
      planoId: beneficioAgendado.plano_id,
      nome: nomeDoPlano(plano) || 'Plano',
      origem: o,
      origemTexto: ORIGENS[o],
      // Começa no fim do ciclo pago em curso, mesmo que a assinatura renove
      // (o pago fica guardado — plano-administrativo.js#ativarBeneficiosAgendados).
      comecaEm: diaISO(beneficioAgendado.plano_anterior_valido_ate || conta.data_expiracao),
      validoAte: diaISO(beneficioAgendado.valido_ate),
      esperaAssinatura: !!assinaturaAtiva,
    };
  } else if (guardado && agoraItem) {
    proximo = {
      tipo: 'pago_guardado',
      planoId: guardado.planoId,
      nome: guardado.nome,
      origem: 'assinatura',
      origemTexto: ORIGENS.assinatura,
      // O benefício vale até `validoAte` inclusive; o job do dia seguinte
      // devolve o pago com `current_date + dias`.
      comecaEm: agoraItem.validoAte ? somarDiasISO(agoraItem.validoAte, 1) : null,
      dias: guardado.dias,
      validoAte: agoraItem.validoAte ? somarDiasISO(agoraItem.validoAte, 1 + guardado.dias) : null,
    };
  }

  // O que acontece quando a fila acaba.
  let depois = null;
  if (agoraItem?.tipo === 'comercial' && agoraItem.renovaEm && !proximo) {
    depois = { tipo: 'renova', em: agoraItem.renovaEm, texto: `Renova sozinha em ${dataBR(agoraItem.renovaEm)}.` };
  } else if (proximo?.tipo === 'pago_guardado') {
    depois = guardado.assinaturaAtiva
      ? { tipo: 'renova', em: proximo.validoAte, texto: `A assinatura ${guardado.nome} segue renovando.` }
      : {
          tipo: 'sem_plano',
          em: proximo.validoAte,
          texto: 'Fica sem plano comercial. Nada é cobrado automaticamente.',
        };
  } else if (proximo?.tipo === 'beneficio' && agoraItem?.origem === 'assinatura' && assinaturaAtiva) {
    // Pro pago → benefício Prime → volta ao Pro: o ciclo que renovar durante
    // o benefício fica guardado e assume quando ele acabar. A assinatura do
    // San Checkout não pula ciclo (CONSTRAINTS.md), então "adiar a cobrança"
    // é isto: cobra no calendário de sempre, e os dias pagos esperam.
    depois = {
      tipo: 'volta_pago',
      em: proximo.validoAte,
      texto: `Retorna ao ${agoraItem.nome}. O que for pago durante o benefício fica guardado — nenhum dia pago se perde.`,
    };
  } else {
    const fimDaFila = proximo ? proximo.validoAte : agoraItem?.validoAte || null;
    if (fimDaFila) {
      depois = { tipo: 'sem_plano', em: fimDaFila, texto: 'Fica sem plano comercial. Nada é cobrado automaticamente.' };
    }
  }

  const vencido =
    conta.plano_id && !comercialVigente
      ? {
          planoId: conta.plano_id,
          nome: nomeDoPlano(comercial) || 'Plano',
          origemTexto: ORIGENS[origem],
          venceuEm: diaISO(conta.data_expiracao),
        }
      : null;

  return { agora: agoraItem, proximo, depois, vencido, guardado };
}

function somarDiasISO(iso, dias) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(dias));
  return d.toISOString().slice(0, 10);
}

function dataBR(iso) {
  return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';
}

// Saúde operacional resumida, a partir da MESMA situação de tela que o dono
// vê em "Meus pontos" (src/lib/status-tela.js via meus-pontos.js).
const GRUPOS_DE_SAUDE = [
  { chave: 'operando', um: 'funcionando', varios: 'funcionando' },
  { chave: 'fora_do_horario', um: 'fora do horário', varios: 'fora do horário' },
  { chave: 'aguardando_primeiro_sinal', um: 'aguardando a primeira conexão', varios: 'aguardando a primeira conexão' },
  { chave: 'sem_sinal', um: 'sem sinal', varios: 'sem sinal' },
  { chave: 'erro_do_player', um: 'com erro relatado', varios: 'com erro relatado' },
  { chave: 'em_reparo', um: 'em reparo', varios: 'em reparo' },
  { chave: 'inativa', um: 'desligada', varios: 'desligadas' },
];
function saudeDoPonto(telas) {
  if (!telas.length) return { nivel: 'neutro', texto: 'Nenhuma tela instalada ainda' };
  const partes = GRUPOS_DE_SAUDE.map((g) => {
    const n = telas.filter((t) => t.situacao === g.chave).length;
    return n ? `${n} ${n === 1 ? g.um : g.varios}` : null;
  }).filter(Boolean);
  const alerta = telas.some((t) => t.alerta);
  const ok = telas.some((t) => t.situacao === 'operando' || t.situacao === 'fora_do_horario');
  return { nivel: alerta ? 'atencao' : ok ? 'ok' : 'neutro', texto: partes.join(' · ') };
}

async function situacaoDaConta(contaId, agora = new Date()) {
  const conta = await repo.buscarPorId(contaId);
  if (!conta) return null;

  const [
    { rows: planosRows },
    assinaturaAtiva,
    historico,
    saldo,
    movimentacoes,
    estabelecimentos,
    { rows: statusDosPontos },
    { criativos, limite: limiteNoAr, contaVeicula },
    { rows: categoriaRows },
  ] = await Promise.all([
    pool.query('SELECT * FROM planos'),
    assinaturasRepo.buscarAtivaDoAnunciante(conta.id),
    planoAdministrativo.historicoDaConta(conta.id),
    creditosRepo.saldo(conta.id),
    creditosRepo.movimentacoes(conta.id, 200),
    meusPontosDaConta(conta.id, agora),
    pool.query(`SELECT id, status FROM pontos WHERE anunciante_id = $1 AND status <> 'arquivado'`, [conta.id]),
    criativosComSituacao(conta),
    conta.categoria_id
      ? pool.query(
          `SELECT c.id, c.nome, c.legado, c.ativo, k.id AS canonica_id, k.nome AS canonica_nome
             FROM categorias c LEFT JOIN categorias k ON k.id = c.canonica_id AND k.ativo AND NOT k.legado
            WHERE c.id = $1`,
          [conta.categoria_id],
        )
      : { rows: [] },
  ]);
  const planos = Object.fromEntries(planosRows.map((p) => [p.id, p]));
  const statusPorPonto = new Map(statusDosPontos.map((r) => [r.id, r.status]));

  // ---------- pontos (aprovados) e solicitações (candidaturas em análise) ----------
  const pontos = estabelecimentos
    .filter((e) => e.tipo === 'ponto')
    .map((e) => {
      const status = statusPorPonto.get(e.id) || null;
      return {
        id: e.id,
        nome: e.nome,
        endereco: e.endereco,
        logradouro: e.logradouro,
        numero: e.numero,
        complemento: e.complemento,
        bairro: e.bairro,
        cidade: e.cidade,
        uf: e.uf,
        fotoUrl: e.fotoUrl,
        status,
        statusTexto: STATUS_DO_PONTO[status] || 'Inativo',
        telas: e.telas.length,
        telasComAlerta: e.alertas,
        saude: saudeDoPonto(e.telas),
        // +1 crédito/mês quando elegível (creditos/ponto.js, via meus-pontos).
        beneficio: e.beneficio,
        desde: e.desde,
      };
    });
  const solicitacoes = estabelecimentos
    .filter((e) => e.tipo === 'candidatura')
    .map((e) => ({
      id: e.id,
      nome: e.nome,
      endereco: e.endereco,
      logradouro: e.logradouro,
      numero: e.numero,
      complemento: e.complemento,
      bairro: e.bairro,
      cidade: e.cidade,
      uf: e.uf,
      fotoUrl: e.fotoUrl,
      enviadaEm: e.desde,
    }));

  // ---------- plano ----------
  const beneficioAtivo = historico.find((h) => h.status === 'ativo') || null;
  const beneficioAgendado = historico.find((h) => h.status === 'agendado') || null;
  const plano = linhaDoTempo({
    conta,
    comercial: planos[conta.plano_id] || null,
    assinaturaAtiva,
    beneficioAtivo,
    beneficioAgendado,
    planos,
    agora,
  });
  plano.veicula = contaVeicula;
  plano.assinaturaAtiva = assinaturaAtiva ? { id: assinaturaAtiva.id, planoId: assinaturaAtiva.plano_id } : null;

  // ---------- créditos e benefícios ----------
  const custoPorLedger = new Map(movimentacoes.map((m) => [String(m.id), Math.abs(m.quantidade)]));
  const beneficios = historico.map((h) => {
    const o = origemDoBeneficio(h);
    const statusTexto =
      h.status === 'ativo'
        ? 'Em vigor'
        : h.status === 'agendado'
          ? 'Programado'
          : `Encerrado${h.encerrado_motivo ? ` · ${MOTIVO_ENCERRAMENTO[h.encerrado_motivo] || h.encerrado_motivo}` : ''}`;
    return {
      id: h.id,
      nome: nomeDoPlano(planos[h.plano_id]) || 'Plano',
      origem: o,
      origemTexto: ORIGENS[o],
      status: h.status,
      statusTexto,
      inicio: h.ativado_em || h.inicio,
      comecaEm: h.status === 'agendado' ? diaISO(h.plano_anterior_valido_ate) : null,
      validoAte: diaISO(h.valido_ate),
      encerradoEm: h.encerrado_em || null,
      concedidoPor: h.concedido_por || null,
      observacao: h.observacao || null,
      custoCreditos: h.ledger_id ? custoPorLedger.get(String(h.ledger_id)) || null : null,
    };
  });
  const creditos = {
    saldo,
    movimentacoes: movimentacoes.map((m) => ({
      id: m.id,
      tipo: m.tipo,
      quantidade: m.quantidade,
      motivo: m.tipo === 'resgate_beneficio' ? comNomeDeCiclo(m.observacao) : m.observacao,
      notaInterna: m.nota_interna || null,
      concedidoPor: m.concedido_por,
      origemNome: m.origem_nome,
      pontoNome: m.ponto_nome || null,
      criadoEm: m.criado_em,
    })),
    // Tabela de referência do modal "Conceder créditos" — a mesma régua do
    // resgate (creditos/regras.js), nunca um número escrito à mão na tela.
    referencia: Object.entries(CUSTO_BASE_POR_MES).map(([tier, porMes]) => ({
      tier,
      nome: NOME_TIER[tier],
      porMes,
      anual: porMes * 12,
    })),
  };

  // ---------- criativos ----------
  const substituicoes = criativos.filter((c) => c.status === 'pendente' && c.substitui_criativo_id).length;
  const resumoCriativos = {
    cadastrados: criativos.filter(
      (c) => c.status !== 'reprovado' && !(c.status === 'pendente' && c.substitui_criativo_id),
    ).length,
    limiteConta: CRIATIVOS_POR_CONTA,
    limiteNoAr: limiteNoAr,
    noAr: criativos.filter((c) => c.no_ar).length,
    emAnalise: criativos.filter((c) => c.status === 'pendente' && !c.substitui_criativo_id).length,
    aprovadosForaDoAr: criativos.filter((c) => c.status === 'aprovado' && !c.no_ar).length,
    retirados: criativos.filter((c) => c.status === 'retirado').length,
    recusados: criativos.filter((c) => c.status === 'reprovado').length,
    substituicoesPendentes: substituicoes,
    contaVeicula,
  };

  // ---------- dados ----------
  const cat = categoriaRows[0];
  const dados = {
    id: conta.id,
    nome: conta.nome_empresa,
    documento: conta.cpf_cnpj,
    email: conta.contato_email,
    telefone: conta.contato_telefone,
    // Endereço da conta (vai na nota fiscal), numa linha só com a regra de
    // src/lib/endereco.js — a ficha não mostrava endereço nenhum (D5,
    // 24/09/2026).
    endereco: linhaEndereco(conta, { comCidade: true }) || null,
    cep: conta.cep || null,
    entrouEm: conta.created_at,
    categoria: cat
      ? {
          id: cat.id,
          nome: cat.nome,
          antiga: !!cat.legado || !cat.ativo,
          canonica: cat.canonica_id ? { id: cat.canonica_id, nome: cat.canonica_nome } : null,
        }
      : null,
    categoriaLivre: conta.categoria_livre || null,
    suspensa: !!conta.suspenso,
    excluidaEm: conta.excluido_em || null,
    contaPropria: !!conta.conta_propria,
  };

  const situacao = {
    dados,
    donoDePonto: pontos.length > 0,
    plano,
    creditos,
    beneficios,
    criativos: { resumo: resumoCriativos, lista: criativos },
    pontos,
    solicitacoes,
  };
  situacao.alertas = await verificarInvariantes({ conta, situacao, beneficioAtivo, beneficioAgendado });
  return situacao;
}

// INVARIANTES — o que nunca pode ser verdade ao mesmo tempo. Se o dado
// quebra uma delas, a ficha diz o que está errado (em vez de mostrar dois
// cards que se contradizem) e o teste de invariantes pega a regressão.
async function verificarInvariantes({ conta, situacao, beneficioAtivo, beneficioAgendado }) {
  const alertas = [];
  const { plano, pontos, criativos } = situacao;
  for (const p of pontos) {
    if (p.status === 'em_operacao' && p.telas === 0) {
      alertas.push({
        codigo: 'ponto_ativo_sem_tela',
        texto: `${p.nome}: marcado como ativo sem nenhuma tela.`,
        pontoId: p.id,
      });
    }
  }
  // Crédito de ponto que o dado não sustenta (ponto sem tela, arquivado ou
  // de outra conta creditando esta) — nunca deveria existir; o job só
  // concede pela regra única de creditos/ponto.js.
  const { rows: creditoSemBase } = await pool.query(
    `SELECT l.competencia, p.nome FROM creditos_ledger l JOIN pontos p ON p.id = l.ponto_id
      WHERE l.anunciante_id = $1 AND l.tipo = 'credito_mensal_ponto'
        AND (p.status = 'arquivado' OR NOT EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = p.id))
      LIMIT 1`,
    [conta.id],
  );
  if (creditoSemBase.length) {
    alertas.push({
      codigo: 'credito_de_ponto_sem_base',
      texto: `${creditoSemBase[0].nome}: há crédito mensal de um ponto hoje arquivado ou sem tela (histórico — confira).`,
    });
  }
  if (beneficioAtivo && !(conta.plano_cortesia && conta.plano_id === beneficioAtivo.plano_id)) {
    alertas.push({
      codigo: 'beneficio_orfao',
      texto:
        'Há um benefício marcado como em vigor, mas a conta está em outro plano — a rotina diária encerra no prazo sem mexer no plano atual.',
    });
  }
  // Benefício programado MENOR que o plano pago em vigor: a fila não pode
  // reduzir o plano depois (o pagamento encerra esses — ADR-016).
  if (beneficioAgendado && plano.agora?.origem === 'assinatura') {
    const {
      rows: [tiers],
    } = await pool.query(
      `SELECT (SELECT tier FROM planos WHERE id = $1) AS agendado, (SELECT tier FROM planos WHERE id = $2) AS pago`,
      [beneficioAgendado.plano_id, conta.plano_id],
    );
    if (planoAdministrativo.nivelDoTier(tiers.agendado) < planoAdministrativo.nivelDoTier(tiers.pago)) {
      alertas.push({
        codigo: 'beneficio_menor_programado',
        texto: 'Há um benefício programado menor que o plano pago em vigor — ele não deveria estar na fila.',
      });
    }
  }
  if (plano.vencido) {
    alertas.push({
      codigo: 'plano_vencido',
      texto: `${plano.vencido.nome} venceu em ${dataBR(plano.vencido.venceuEm)} — a conciliação diária encerra.`,
    });
  }
  if (criativos.resumo.noAr > 0 && !plano.agora) {
    alertas.push({ codigo: 'criativo_no_ar_sem_plano', texto: 'Há criativo no ar sem plano vigente.' });
  }
  return alertas;
}

// ---------- rota ----------
const router = express.Router();

// GET /admin/anunciantes/:id/situacao — tudo que a ficha de Conta mostra, já
// decidido. Protegido pelo requireAdminSession montado em '/admin'.
router.get('/admin/anunciantes/:id/situacao', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: 'conta inválida' });
  const situacao = await situacaoDaConta(id);
  if (!situacao) return res.status(404).json({ erro: 'conta não encontrada' });
  res.set('Cache-Control', 'no-store');
  res.json(situacao);
});

module.exports = { router, situacaoDaConta };
