const pool = require('../db/pool');
const { removerAvatar } = require('../lib/avatar');

// Tudo que a conta gerou, numa leitura só. É a base do direito de acesso e de
// portabilidade (LGPD art. 18, II e V): o titular tem que conseguir ver e levar
// embora o que é dele, sem depender de alguém do outro lado montar isso à mão.
//
// O que NÃO sai daqui: `senha_hash` (não é dado do titular, é credencial —
// exportar hash só ajuda quem roubar o arquivo), a chave e o PIN das telas
// (credencial de aparelho, mesma razão), e id interno de terceiro. O resto sai
// inteiro, inclusive o que ele não digitou — exibições, cobranças, comissões.
async function exportarConta(anuncianteId) {
  const q = (sql, p = [anuncianteId]) => pool.query(sql, p).then((r) => r.rows);

  const [conta] = await q(`
    SELECT id, nome_empresa, cpf_cnpj, endereco, logradouro, numero, complemento, bairro, cidade, uf, cep,
           contato_email, contato_telefone, status, plano_id,
           data_inicio_cobertura, data_expiracao, indicado_por_cupom,
           responsavel_nome, responsavel_cpf, responsavel_email, responsavel_telefone,
           aceitou_termos_em, created_at, foto_url, categoria_id, categoria_livre,
           excluido_em, papeis, plano_cortesia, cortesia_motivo, comodato_plano_id,
           comunicacoes_revogado_em, dados_opcionais_apagados_em
      FROM anunciantes WHERE id = $1`);
  if (!conta) return null;

  const [
    pontos,
    criativos,
    assinaturas,
    cobrancas,
    comissoesGanhas,
    comissoesGeradas,
    exibicoes,
    pagamentosPonto,
    vendedor,
    candidaturas,
    eventosDaConta,
    telas,
    creditos,
    beneficios,
    notificacoes,
    arrependimentos,
    pontosEscolhidos,
    bancoHoras,
    ciclosContratados,
    pedidosAvulsos,
  ] = await Promise.all([
    q('SELECT * FROM pontos WHERE anunciante_id = $1 ORDER BY id'),
    q(`SELECT id, arquivo_original_url, arquivo_normalizado_url, thumbnail_url,
              editado_pelo_operador, status, duracao_segundos, created_at
         FROM criativos WHERE anunciante_id = $1 ORDER BY id`),
    q('SELECT * FROM assinaturas WHERE anunciante_id = $1 ORDER BY created_at'),
    q(`SELECT id, plano_id, valor, criado_em, nota_fiscal_status, nota_fiscal_url
         FROM cobrancas_confirmadas WHERE anunciante_id = $1 ORDER BY criado_em`),
    // Duas pontas da mesma tabela: o que esta conta GANHOU indicando alguém,
    // e o que a compra dela GEROU de comissão pra quem a indicou. As duas são
    // dado pessoal dela, por motivos diferentes.
    q(`SELECT id, anunciante_id AS indicou, valor_confirmado, comissao_valor, criado_em, pago_em
         FROM comissoes WHERE vendedor_conta_id = $1 ORDER BY id`),
    q(`SELECT id, valor_confirmado, comissao_valor, criado_em
         FROM comissoes WHERE anunciante_id = $1 ORDER BY id`),
    q(`SELECT janela_hora, ponto_id, dispositivo_id, vezes_programadas, vezes_confirmadas
         FROM exibicoes_contador WHERE anunciante_id = $1 ORDER BY janela_hora`),
    q(`SELECT pp.* FROM pagamentos_ponto pp
         JOIN pontos p ON p.id = pp.ponto_id
        WHERE p.anunciante_id = $1 ORDER BY pp.competencia`),
    q('SELECT * FROM vendedores WHERE conta_id = $1'),
    q(`SELECT * FROM candidaturas
        WHERE conta_id = $1
           OR contato_email = (SELECT contato_email FROM anunciantes WHERE id = $1)`),
    // Eventos da métrica também são dado do titular: dizem o que a conta fez
    // e quando. Ficar de fora da exportação seria guardar registro de alguém
    // e não entregar quando ela pede.
    q(`SELECT nome, propriedades, criado_em FROM eventos
        WHERE anunciante_id = $1 ORDER BY criado_em`),
    q(`SELECT d.id, d.ponto_id, 'Tela ' || d.numero AS tela, d.status, d.ultima_vez_online,
              d.custo_equipamento, d.meses_amortizacao, d.instalado_em, d.created_at
         FROM dispositivos d
         JOIN pontos p ON p.id = d.ponto_id
        WHERE p.anunciante_id = $1 ORDER BY d.id`),
    // Consolidação (24/09/2026): o que faltava na exportação — tudo que a
    // conta gerou depois do modelo de créditos, e o que ela pediu (LGPD art.
    // 18: o titular leva TUDO, não só o que existia quando a rota nasceu).
    q(`SELECT id, tipo, quantidade, ponto_id, competencia, observacao, criado_em
         FROM creditos_ledger WHERE anunciante_id = $1 ORDER BY criado_em`),
    q(`SELECT id, plano_id, origem, status, inicio, valido_ate, ativado_em, encerrado_em, encerrado_motivo, observacao, criado_em
         FROM planos_administrativos WHERE anunciante_id = $1 ORDER BY criado_em`),
    q(`SELECT id, tipo, titulo, descricao, lida_em, criado_em
         FROM notificacoes WHERE anunciante_id = $1 ORDER BY criado_em`),
    q(`SELECT id, assinatura_id, plano_id, valor_a_estornar, contratado_em, pedido_em, status, estornado_em
         FROM arrependimentos WHERE anunciante_id = $1 ORDER BY pedido_em`),
    q(`SELECT ap.ponto_id, p.nome AS ponto, ap.escolhido_em
         FROM anunciantes_pontos ap JOIN pontos p ON p.id = ap.ponto_id
        WHERE ap.anunciante_id = $1 ORDER BY ap.escolhido_em`),
    q('SELECT * FROM banco_horas WHERE anunciante_id = $1 ORDER BY 1'),
    q('SELECT * FROM ciclos_contratados WHERE anunciante_id = $1 ORDER BY 1'),
    q('SELECT * FROM pedidos_avulsos WHERE anunciante_id = $1 ORDER BY 1'),
  ]);

  return {
    gerado_em: new Date().toISOString(),
    aviso:
      'Exportação de dados pessoais da Mostraí, gerada pelo próprio titular. ' +
      'Não inclui senha nem chave de aparelho, que são credenciais, não dados.',
    conta,
    pontos,
    telas,
    criativos,
    assinaturas,
    cobrancas_confirmadas: cobrancas,
    comissoes_ganhas_como_vendedor: comissoesGanhas,
    comissoes_geradas_pelas_minhas_compras: comissoesGeradas,
    exibicoes_por_hora: exibicoes,
    pagamentos_recebidos_como_ponto: pagamentosPonto,
    cadastro_de_vendedor: vendedor,
    candidaturas_de_ponto: candidaturas,
    eventos_registrados: eventosDaConta,
    creditos: creditos,
    beneficios_por_creditos: beneficios,
    notificacoes,
    pedidos_de_arrependimento: arrependimentos,
    pontos_escolhidos_para_anunciar: pontosEscolhidos,
    banco_de_horas: bancoHoras,
    ciclos_contratados: ciclosContratados,
    pedidos_avulsos: pedidosAvulsos,
  };
}

// Apaga o que é opcional e nulo pro serviço. Não toca em nada que a execução
// do contrato ou a obrigação fiscal exija — isso só sai com a conta. A foto
// sai do bucket junto (src/lib/avatar.js) — zerar só a URL deixava o arquivo
// público.
async function apagarDadosOpcionais(anuncianteId) {
  const { rows } = await pool.query(
    `
    UPDATE anunciantes
       SET responsavel_nome = NULL, responsavel_cpf = NULL,
           responsavel_email = NULL, responsavel_telefone = NULL,
           foto_url = NULL, dados_opcionais_apagados_em = now()
     WHERE id = $1 RETURNING dados_opcionais_apagados_em`,
    [anuncianteId],
  );
  await removerAvatar(anuncianteId);
  return rows[0];
}

// Conta excluída há mais de 60 dias (prazo prometido em POST
// /anunciantes/me/excluir pra recuperação pelo suporte) perde o dado
// pessoal que não sustenta obrigação nenhuma: contato, endereço,
// responsável, senha, consentimentos. Nome e documento FICAM — são o que a
// cobrança confirmada e a nota exigem (obrigação fiscal). O e-mail vira um
// marcador único e a pessoa pode se cadastrar de novo com o mesmo endereço
// (antes ficava preso pra sempre no índice único). Roda no job diário
// (scripts/conciliar.js); idempotente por `anonimizada_em`.
const DIAS_ATE_ANONIMIZAR = 60;
async function anonimizarExcluidas(agora = new Date()) {
  const { rows } = await pool.query(
    `UPDATE anunciantes
        SET contato_email = 'excluida-' || id || '@anonimo.mostrai.invalid',
            contato_telefone = '',
            senha_hash = 'anonimizada',
            endereco = NULL, logradouro = NULL, numero = NULL, complemento = NULL, bairro = NULL,
            cidade = NULL, uf = NULL, cep = NULL,
            responsavel_nome = NULL, responsavel_cpf = NULL, responsavel_email = NULL, responsavel_telefone = NULL,
            foto_url = NULL, categoria_livre = NULL,
            comunicacoes_revogado_em = COALESCE(comunicacoes_revogado_em, now()),
            anonimizada_em = now()
      WHERE excluido_em IS NOT NULL AND excluido_em < $1::timestamptz - make_interval(days => $2)
        AND anonimizada_em IS NULL
      RETURNING id`,
    [agora, DIAS_ATE_ANONIMIZAR],
  );
  for (const { id } of rows) await removerAvatar(id);
  return rows.map((r) => r.id);
}

async function definirComunicacoes(anuncianteId, aceita) {
  const { rows } = await pool.query(
    `
    UPDATE anunciantes SET comunicacoes_revogado_em = $2
     WHERE id = $1 RETURNING comunicacoes_revogado_em`,
    [anuncianteId, aceita ? null : new Date()],
  );
  return rows[0];
}

// A primeira cobrança confirmada é quando a contratação se completou — é dela
// que os 7 dias do art. 49 do CDC contam, não do cadastro.
async function primeiraCobranca(anuncianteId) {
  const { rows } = await pool.query(
    `
    SELECT id, plano_id, valor, criado_em FROM cobrancas_confirmadas
     WHERE anunciante_id = $1 ORDER BY criado_em LIMIT 1`,
    [anuncianteId],
  );
  return rows[0] || null;
}

// Soma do que a conta pagou. O art. 49 devolve TUDO o que foi pago, não um
// pró-rata pelos dias em que o anúncio rodou — o direito não é proporcional.
async function totalPago(anuncianteId) {
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(valor), 0) AS total FROM cobrancas_confirmadas WHERE anunciante_id = $1',
    [anuncianteId],
  );
  return Number(rows[0].total);
}

async function arrependimentoAberto(anuncianteId) {
  const { rows } = await pool.query("SELECT * FROM arrependimentos WHERE anunciante_id = $1 AND status = 'pendente'", [
    anuncianteId,
  ]);
  return rows[0] || null;
}

async function registrarArrependimento({ anuncianteId, assinaturaId, planoId, valor, contratadoEm }) {
  const { rows } = await pool.query(
    `
    INSERT INTO arrependimentos
      (anunciante_id, assinatura_id, plano_id, valor_a_estornar, contratado_em)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (anunciante_id) WHERE status = 'pendente' DO NOTHING
    RETURNING *`,
    [anuncianteId, assinaturaId, planoId, valor, contratadoEm],
  );
  return rows[0] || arrependimentoAberto(anuncianteId);
}

async function listarArrependimentos() {
  const { rows } = await pool.query(`
    SELECT a.*, an.nome_empresa, an.cpf_cnpj, an.contato_email
      FROM arrependimentos a
      JOIN anunciantes an ON an.id = a.anunciante_id
     ORDER BY (a.status = 'pendente') DESC, a.pedido_em DESC`);
  return rows;
}

async function marcarEstornado(id, comprovante) {
  const { rows } = await pool.query(
    `
    UPDATE arrependimentos
       SET status = 'estornado', estornado_em = now(), comprovante = $2
     WHERE id = $1 AND status = 'pendente' RETURNING *`,
    [id, comprovante || null],
  );
  return rows[0] || null;
}

module.exports = {
  exportarConta,
  apagarDadosOpcionais,
  anonimizarExcluidas,
  DIAS_ATE_ANONIMIZAR,
  definirComunicacoes,
  primeiraCobranca,
  totalPago,
  arrependimentoAberto,
  registrarArrependimento,
  listarArrependimentos,
  marcarEstornado,
};
