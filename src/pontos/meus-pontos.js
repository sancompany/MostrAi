const pool = require('../db/pool');
const { saudeDaTela, SITUACOES_DE_ALERTA } = require('../lib/status-tela');
const { situacaoDosPontos } = require('../creditos/ponto');

// "Meus pontos" (Fatia 2 do painel único, 23/09/2026): UMA entidade visual
// por estabelecimento. Antes eram três lugares para a mesma coisa — "Meu
// ponto" (cards de endereço), "Minhas telas" (telas soltas, sem dizer de qual
// ponto) e "Meus endereços" (candidaturas) — e o dono lia o mesmo comércio
// duas ou três vezes.
//
// Ciclo de um estabelecimento, na ordem em que acontece:
//   candidatura aberta (nova/em_contato)  -> em_analise
//   ponto sem tela ativa (a_instalar)     -> aguardando_instalacao
//   ponto com tela ativa (em_operacao)    -> ativo
//   ponto com tela só em reparo           -> em_manutencao
//   ponto com telas desligadas            -> inativo
// Candidatura já materializada (pontos.candidatura_id, migration 080) nunca
// aparece de novo como "em análise": o ponto é quem a representa daqui pra
// frente. Ponto arquivado (mesclado) não aparece.
//
// Projeção FECHADA de propósito: nada de `p.*`. O dono vê o que é dele pra
// ver — nunca contato do responsável, observação interna, chave do aparelho,
// custo do equipamento, margens ou o texto cru do erro do player.
const ESTADO_DO_PONTO = {
  a_instalar: 'aguardando_instalacao',
  em_operacao: 'ativo',
  em_reparo: 'em_manutencao',
  inativo: 'inativo',
};

// Texto humano de cada situação da tela (src/lib/status-tela.js). Nível
// decide a cor: `atencao` só para o que precisa de alguém agir.
const SITUACAO_DA_TELA = {
  operando: { nivel: 'ok', texto: 'Funcionando' },
  fora_do_horario: { nivel: 'neutro', texto: 'Fora do horário de funcionamento' },
  aguardando_primeiro_sinal: { nivel: 'neutro', texto: 'Aguardando a primeira conexão' },
  sem_sinal: {
    nivel: 'atencao',
    texto: 'A tela deveria estar operando e está sem comunicação. A equipe Mostraí foi avisada.',
  },
  erro_do_player: {
    nivel: 'atencao',
    texto: 'A tela relatou um problema. A equipe Mostraí foi avisada.',
  },
  player_revogado: { nivel: 'neutro', texto: 'Aguardando reinstalação pela equipe Mostraí' },
  em_reparo: { nivel: 'neutro', texto: 'Em manutenção' },
  inativa: { nivel: 'neutro', texto: 'Desligada' },
};

// Como a tela opera, em palavras de dono de loja (sem regime/timezone).
const OPERACAO = { '24h': '24 horas', ponto: 'Horário do estabelecimento', personalizado: 'Horário próprio da tela' };

// Visão SIMPLIFICADA do Player V2 para o dono: situação, operação e último
// sinal. Nada técnico — sem ID do dispositivo, credencial, contrato, fila,
// Android, hash, versões de config ou detalhes de atualização.
function telaPublica(t, horarioDoPonto, agora) {
  const situacao = saudeDaTela(t, horarioDoPonto, agora);
  return {
    id: t.id,
    nome: `Tela ${t.numero}`,
    operacao: OPERACAO[t.modo_horario] || OPERACAO.ponto,
    situacao,
    nivel: SITUACAO_DA_TELA[situacao].nivel,
    situacaoTexto: SITUACAO_DA_TELA[situacao].texto,
    alerta: SITUACOES_DE_ALERTA.has(situacao),
    ultimoSinal: t.ultima_vez_online,
    instaladaEm: t.instalado_em,
    temPin: t.tem_pin,
    exibicoes30d: t.exibicoes_30d,
    anunciantes30d: t.anunciantes_30d,
  };
}

async function meusPontosDaConta(contaId, agora = new Date()) {
  const [pontos, telas, candidaturas] = await Promise.all([
    pool.query(
      `SELECT p.id, p.candidatura_id, p.nome, p.endereco, p.logradouro, p.numero, p.complemento, p.bairro,
              p.cidade, p.uf, p.status,
              p.foto_instalacao_url, p.horario_semanal, p.created_at,
              c.nome AS categoria_nome
         FROM pontos p
         LEFT JOIN categorias c ON c.id = p.categoria_id
        WHERE p.anunciante_id = $1 AND p.status <> 'arquivado'
        ORDER BY p.created_at`,
      [contaId],
    ),
    pool.query(
      `SELECT d.id, d.ponto_id, d.numero, d.status, d.ultima_vez_online, d.primeiro_sinal_em, d.instalado_em,
              d.modo_horario, d.horario_semanal, d.timezone, d.player_estado,
              d.ultimo_erro, d.ultimo_erro_codigo, d.revogado_em, d.chave_hash,
              (d.pin_manutencao_cifrado IS NOT NULL OR d.pin_hash IS NOT NULL) AS tem_pin,
              COALESCE(SUM(e.vezes_confirmadas) FILTER (WHERE e.janela_hora > now() - interval '30 days'), 0)::int AS exibicoes_30d,
              COUNT(DISTINCT e.anunciante_id) FILTER (WHERE e.janela_hora > now() - interval '30 days')::int AS anunciantes_30d
         FROM dispositivos d
         JOIN pontos p ON p.id = d.ponto_id
         LEFT JOIN exibicoes_contador e ON e.dispositivo_id = d.id
        WHERE p.anunciante_id = $1 AND p.status <> 'arquivado'
        GROUP BY d.id ORDER BY d.numero`,
      [contaId],
    ),
    pool.query(
      `SELECT c.id, c.nome_comercio, c.endereco, c.logradouro, c.numero, c.complemento, c.bairro,
              c.cidade, c.uf, c.foto_fachada_url, c.criado_em
         FROM candidaturas c
        WHERE c.conta_id = $1 AND c.tipo = 'ponto' AND c.status IN ('nova', 'em_contato')
          AND NOT EXISTS (SELECT 1 FROM pontos p WHERE p.candidatura_id = c.id)
        ORDER BY c.criado_em`,
      [contaId],
    ),
  ]);

  const telasPorPonto = new Map();
  for (const t of telas.rows) {
    if (!telasPorPonto.has(t.ponto_id)) telasPorPonto.set(t.ponto_id, []);
    telasPorPonto.get(t.ponto_id).push(t);
  }

  // Benefício do ponto (ADR-016): +1 crédito por mês quando elegível —
  // mesma regra do job (creditos/ponto.js), nunca recalculada aqui.
  const beneficios = await situacaoDosPontos(
    pontos.rows.map((p) => p.id),
    agora,
  );

  const materializados = pontos.rows.map((p) => {
    const suas = (telasPorPonto.get(p.id) || []).map((t) => telaPublica(t, p.horario_semanal, agora));
    return {
      tipo: 'ponto',
      id: p.id,
      nome: p.nome,
      endereco: p.endereco,
      logradouro: p.logradouro,
      numero: p.numero,
      complemento: p.complemento,
      bairro: p.bairro,
      cidade: p.cidade,
      uf: p.uf,
      fotoUrl: p.foto_instalacao_url,
      categoria: p.categoria_nome,
      estado: ESTADO_DO_PONTO[p.status] || 'inativo',
      desde: p.created_at,
      beneficio: beneficios.get(p.id) || null,
      telas: suas,
      exibicoes30d: suas.reduce((s, t) => s + t.exibicoes30d, 0),
      alertas: suas.filter((t) => t.alerta).length,
    };
  });

  const emAnalise = candidaturas.rows.map((c) => ({
    tipo: 'candidatura',
    id: c.id,
    nome: c.nome_comercio,
    endereco: c.endereco,
    logradouro: c.logradouro,
    numero: c.numero,
    complemento: c.complemento,
    bairro: c.bairro,
    cidade: c.cidade,
    uf: c.uf,
    fotoUrl: c.foto_fachada_url,
    estado: 'em_analise',
    desde: c.criado_em,
    telas: [],
  }));

  return [...emAnalise, ...materializados];
}

module.exports = { meusPontosDaConta, SITUACAO_DA_TELA, ESTADO_DO_PONTO };
