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
const { bloqueiaPlanoComercial } = require('../pontos/comodato');

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
// PLANO (o direito de veicular na rede):
//   · "Agora" é o que o gerador honra hoje (`repo.planoVigenteId`, o mesmo
//     COALESCE de src/playlist/gerador.js): o comercial dentro da validade,
//     senão o produto do comodato, senão nada.
//   · A ORIGEM do comercial sai de fato gravado, nunca de rótulo livre:
//     sem `plano_cortesia` = assinatura paga; cortesia com a linha 'ativo' de
//     `planos_administrativos` de origem 'indicacao' = benefício por
//     créditos; qualquer outra cortesia = cortesia administrativa LEGADA
//     (o "Conceder plano" saiu da ficha; as que existem valem até o fim).
//   · "Próximo" é o benefício 'agendado' (espera o ciclo pago terminar).
//   · "Depois" é o que sobra quando a fila acaba: renovação da assinatura,
//     o produto do comodato, ou nenhum plano. Nada é cobrado sozinho.
//
// COMODATO: direito do PONTO. Só existe com ponto aprovado; a modalidade de
//   cada ponto decide o que o dono recebe (Inicial: repasse de R$ 50/mês e
//   não acumula com plano comercial; Básico: crédito de R$ 50/mês na
//   mensalidade e acumula). Ponto sem modalidade é um furo operacional, dito
//   como tal — não "sem comodato".
//
// PONTO × CANDIDATURA: ponto é linha de `pontos` com `anunciante_id` desta
//   conta e não arquivada (mesma consulta de "Meus pontos" do painel —
//   src/pontos/meus-pontos.js). Candidatura em análise é SOLICITAÇÃO, nunca
//   ponto, e nunca dá o selo "Dono de ponto". Nada é inferido por endereço,
//   documento ou nome.
//
// SELO "Dono de ponto": ≥ 1 ponto aprovado. Não lê `papeis` (legado), nem
//   candidatura. Não existe selo "Anunciante" — toda conta anuncia.

const CICLOS = { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };

const ORIGENS = planoAdministrativo.ORIGENS_DO_DIREITO;

const STATUS_DO_PONTO = {
  a_instalar: 'Aguardando instalação',
  em_operacao: 'Ativo',
  em_reparo: 'Em reparo',
  inativo: 'Inativo',
};

const MOTIVO_ENCERRAMENTO = { substituido: 'substituído', cancelado: 'cancelado', vencido: 'venceu' };

function nomeDoPlano(plano, idsDeComodato) {
  if (!plano) return null;
  // Produto de comodato não tem ciclo: "Básico", não "Básico · Mensal".
  if (idsDeComodato.has(plano.id)) return plano.nome.replace(/^Plano\s+/i, '');
  return `${plano.nome} · ${CICLOS[plano.compromisso_meses] || `${plano.compromisso_meses} meses`}`;
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
function linhaDoTempo({
  conta,
  comercial,
  comodatoProduto,
  assinaturaAtiva,
  beneficioAtivo,
  beneficioAgendado,
  planos,
  ids,
  agora,
}) {
  const comercialVigente = !!conta.plano_id && (!conta.data_expiracao || new Date(conta.data_expiracao) >= agora);
  const origem = origemDoComercial(conta, beneficioAtivo);
  const produtoComodato = comodatoProduto
    ? {
        planoId: comodatoProduto.id,
        nome: nomeDoPlano(comodatoProduto, ids),
        direitos: direitosDoPlano(comodatoProduto),
      }
    : null;

  let agoraItem = null;
  if (comercialVigente) {
    const renova = origem === 'assinatura' && !!assinaturaAtiva;
    agoraItem = {
      tipo: 'comercial',
      planoId: conta.plano_id,
      nome: nomeDoPlano(comercial, ids) || 'Plano',
      origem,
      origemTexto: ORIGENS[origem],
      desde: diaISO(conta.data_inicio_cobertura),
      validoAte: diaISO(conta.data_expiracao),
      renovaEm: renova ? diaISO(conta.data_expiracao) : null,
      assinaturaCancelada: origem === 'assinatura' && !assinaturaAtiva,
      direitos: direitosDoPlano(comercial),
    };
  } else if (produtoComodato) {
    agoraItem = { tipo: 'comodato', ...produtoComodato, origem: 'comodato', origemTexto: ORIGENS.comodato };
  }

  let proximo = null;
  if (beneficioAgendado) {
    const plano = planos[beneficioAgendado.plano_id];
    const o = origemDoBeneficio(beneficioAgendado);
    proximo = {
      planoId: beneficioAgendado.plano_id,
      nome: nomeDoPlano(plano, ids) || 'Plano',
      origem: o,
      origemTexto: ORIGENS[o],
      // Começa quando o ciclo pago acabar; se a assinatura renovar antes, o
      // benefício anda junto, com a mesma duração (ativarBeneficiosAgendados).
      comecaEm: diaISO(beneficioAgendado.plano_anterior_valido_ate || conta.data_expiracao),
      validoAte: diaISO(beneficioAgendado.valido_ate),
      esperaAssinatura: !!assinaturaAtiva,
    };
  }

  // O que acontece quando a fila acaba.
  let depois = null;
  const fimDaFila = proximo ? proximo.validoAte : agoraItem?.tipo === 'comercial' ? agoraItem.validoAte : null;
  if (agoraItem?.tipo === 'comercial' && agoraItem.renovaEm && !proximo) {
    depois = { tipo: 'renova', em: agoraItem.renovaEm, texto: `Renova sozinha em ${dataBR(agoraItem.renovaEm)}.` };
  } else if (fimDaFila) {
    depois = produtoComodato
      ? { tipo: 'comodato', em: fimDaFila, ...produtoComodato, texto: `Volta para ${produtoComodato.nome} (comodato).` }
      : { tipo: 'sem_plano', em: fimDaFila, texto: 'Fica sem plano comercial. Nada é cobrado automaticamente.' };
  }

  const vencido =
    conta.plano_id && !comercialVigente
      ? {
          planoId: conta.plano_id,
          nome: nomeDoPlano(comercial, ids) || 'Plano',
          origemTexto: ORIGENS[origem],
          venceuEm: diaISO(conta.data_expiracao),
        }
      : null;

  return { agora: agoraItem, proximo, depois, vencido };
}

function dataBR(iso) {
  return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';
}

// Mesmo formato do resto do admin (fmt em public/admin/index.page.js): "R$ 50,00".
const reais = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Modalidade de comodato de cada ponto aprovado — o que o dono recebe.
async function modalidadesDosPontos(contaId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.status, p.plano_ponto_id, p.valor_pago_mensal,
            pp.nome AS modalidade_nome, pp.ajuda_custo_mensal, pp.desconto_assinatura_reais,
            pp.permite_assinar, pp.plano_incluido_id, pp.ordem
       FROM pontos p LEFT JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
      WHERE p.anunciante_id = $1 AND p.status <> 'arquivado'`,
    [contaId],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

function modalidadeDoPonto(m, planos, ids) {
  if (!m?.plano_ponto_id) return null;
  const produto = planos[m.plano_incluido_id];
  const repasse = Number(m.valor_pago_mensal) || 0;
  const credito = Number(m.desconto_assinatura_reais) || 0;
  // Repasse é por PONTO (cada um recebe o seu); o crédito do Básico é UM por
  // conta, o melhor entre os pontos (comodato.js#sincronizarComodato) — a
  // frase diz isso pra dois pontos no Básico não parecerem R$ 100.
  const recebe =
    repasse > 0
      ? `Recebe ${reais(repasse)}/mês de repasse por este ponto`
      : credito > 0
        ? `Crédito de ${reais(credito)}/mês na mensalidade (um por conta, não soma)`
        : 'Sem contrapartida em dinheiro';
  return {
    id: m.plano_ponto_id,
    nome: m.modalidade_nome,
    produtoId: m.plano_incluido_id || null,
    produto: produto ? nomeDoPlano(produto, ids) : null,
    repasseMensal: repasse,
    creditoMensal: credito,
    acumulaComComercial: m.permite_assinar !== false,
    ordem: m.ordem || 0,
    recebe,
  };
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
    { rows: produtosComodato },
    assinaturaAtiva,
    historico,
    saldo,
    movimentacoes,
    estabelecimentos,
    modalidades,
    { criativos, limite: limiteNoAr, contaVeicula },
    { rows: categoriaRows },
    bloqueiaComercial,
  ] = await Promise.all([
    pool.query('SELECT * FROM planos'),
    pool.query('SELECT DISTINCT plano_incluido_id AS id FROM planos_ponto WHERE plano_incluido_id IS NOT NULL'),
    assinaturasRepo.buscarAtivaDoAnunciante(conta.id),
    planoAdministrativo.historicoDaConta(conta.id),
    creditosRepo.saldo(conta.id),
    creditosRepo.movimentacoes(conta.id, 200),
    meusPontosDaConta(conta.id, agora),
    modalidadesDosPontos(conta.id),
    criativosComSituacao(conta),
    conta.categoria_id
      ? pool.query(
          `SELECT c.id, c.nome, c.legado, c.ativo, k.id AS canonica_id, k.nome AS canonica_nome
             FROM categorias c LEFT JOIN categorias k ON k.id = c.canonica_id AND k.ativo AND NOT k.legado
            WHERE c.id = $1`,
          [conta.categoria_id],
        )
      : { rows: [] },
    bloqueiaPlanoComercial(conta.id),
  ]);
  const planos = Object.fromEntries(planosRows.map((p) => [p.id, p]));
  const ids = new Set(produtosComodato.map((r) => r.id));

  // ---------- pontos (aprovados) e solicitações (candidaturas em análise) ----------
  const pontos = estabelecimentos
    .filter((e) => e.tipo === 'ponto')
    .map((e) => {
      const m = modalidades.get(e.id);
      return {
        id: e.id,
        nome: e.nome,
        endereco: e.endereco,
        bairro: e.bairro,
        cidade: e.cidade,
        uf: e.uf,
        fotoUrl: e.fotoUrl,
        status: m?.status || null,
        statusTexto: STATUS_DO_PONTO[m?.status] || 'Inativo',
        telas: e.telas.length,
        telasComAlerta: e.alertas,
        saude: saudeDoPonto(e.telas),
        modalidade: modalidadeDoPonto(m, planos, ids),
        desde: e.desde,
      };
    });
  const solicitacoes = estabelecimentos
    .filter((e) => e.tipo === 'candidatura')
    .map((e) => ({
      id: e.id,
      nome: e.nome,
      endereco: e.endereco,
      bairro: e.bairro,
      cidade: e.cidade,
      uf: e.uf,
      fotoUrl: e.fotoUrl,
      enviadaEm: e.desde,
    }));

  // ---------- comodato: derivado do ponto + modalidade ----------
  // "Vale o melhor entre os pontos, nunca a soma" — mesma régua de
  // pontos/comodato.js#sincronizarComodato (ordem maior = melhor).
  const comModalidade = pontos.filter((p) => p.modalidade?.produtoId);
  const melhor = comModalidade.reduce((a, p) => (!a || p.modalidade.ordem > a.modalidade.ordem ? p : a), null);
  const produtoDerivadoId = melhor?.modalidade.produtoId || null;
  const comodatoProduto = planos[conta.comodato_plano_id] || null;
  const comodato = pontos.length
    ? {
        pontos: pontos.map((p) => ({ id: p.id, nome: p.nome, statusTexto: p.statusTexto, modalidade: p.modalidade })),
        produto: comodatoProduto
          ? {
              planoId: comodatoProduto.id,
              nome: nomeDoPlano(comodatoProduto, ids),
              direitos: direitosDoPlano(comodatoProduto),
            }
          : null,
        creditoMensal: Number(conta.credito_comodato_mensal) || 0,
        repasseMensal: pontos.reduce((s, p) => s + (p.modalidade?.repasseMensal || 0), 0),
        naoAcumulaComComercial: bloqueiaComercial,
        pontosSemModalidade: pontos.filter((p) => !p.modalidade).length,
      }
    : null;

  // ---------- plano ----------
  const beneficioAtivo = historico.find((h) => h.status === 'ativo') || null;
  const beneficioAgendado = historico.find((h) => h.status === 'agendado') || null;
  const plano = linhaDoTempo({
    conta,
    comercial: planos[conta.plano_id] || null,
    comodatoProduto,
    assinaturaAtiva,
    beneficioAtivo,
    beneficioAgendado,
    planos,
    ids,
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
      nome: nomeDoPlano(planos[h.plano_id], ids) || 'Plano',
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
      motivo: m.observacao,
      notaInterna: m.nota_interna || null,
      concedidoPor: m.concedido_por,
      origemNome: m.origem_nome,
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
    comodato,
    creditos,
    beneficios,
    criativos: { resumo: resumoCriativos, lista: criativos },
    pontos,
    solicitacoes,
  };
  situacao.alertas = verificarInvariantes({ conta, situacao, produtoDerivadoId, beneficioAtivo, bloqueiaComercial });
  return situacao;
}

// INVARIANTES — o que nunca pode ser verdade ao mesmo tempo. Se o dado
// quebra uma delas, a ficha diz o que está errado (em vez de mostrar dois
// cards que se contradizem) e o teste de invariantes pega a regressão.
function verificarInvariantes({ conta, situacao, produtoDerivadoId, beneficioAtivo, bloqueiaComercial }) {
  const alertas = [];
  const { plano, pontos, criativos } = situacao;
  for (const p of pontos) {
    if (!p.modalidade) {
      alertas.push({
        codigo: 'ponto_sem_modalidade',
        texto: `${p.nome}: ponto aprovado sem modalidade de comodato — o dono não recebe repasse nem crédito, e a conta não ganha o Inicial/Básico até definir.`,
        pontoId: p.id,
      });
    }
    if (p.status === 'em_operacao' && p.telas === 0) {
      alertas.push({
        codigo: 'ponto_ativo_sem_tela',
        texto: `${p.nome}: marcado como ativo sem nenhuma tela.`,
        pontoId: p.id,
      });
    }
  }
  if ((conta.comodato_plano_id || null) !== produtoDerivadoId) {
    alertas.push({
      codigo: 'comodato_dessincronizado',
      texto:
        'O comodato gravado na conta não bate com a modalidade dos pontos dela — a próxima troca de modalidade ressincroniza.',
    });
  }
  if (beneficioAtivo && !(conta.plano_cortesia && conta.plano_id === beneficioAtivo.plano_id)) {
    alertas.push({
      codigo: 'beneficio_orfao',
      texto:
        'Há um benefício marcado como em vigor, mas a conta está em outro plano — a rotina diária encerra no prazo sem mexer no plano atual.',
    });
  }
  if (bloqueiaComercial && conta.plano_id && plano.agora?.tipo === 'comercial') {
    alertas.push({
      codigo: 'inicial_com_comercial',
      texto: 'A conta está no Inicial (recebe repasse) e tem plano comercial ao mesmo tempo — os dois não acumulam.',
    });
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
