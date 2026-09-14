const express = require('express');
const router = express.Router();
const criativosRepo = require('../anunciantes/criativos-repository');
const pool = require('../db/pool');
const anunciantesRepo = require('../anunciantes/repository');
const { enviarCriativoNoAr } = require('../financeiro/email');
const eventos = require('../lib/eventos');
const metrica = require('./metrica');

const HORAS_OFFLINE_ALERTA = 2;
// Amortização e custos fixos saem do banco (migration 019) — antes era uma
// constante igual pra todo ponto, ver docs/erros/2026-09-amortizacao-constante-no-codigo.md

// Fila de aprovação de criativos
router.get('/admin/criativos', async (req, res) => {
  res.json(await criativosRepo.listarPorStatus(req.query.status || 'pendente'));
});

router.patch('/admin/criativos/:id', async (req, res) => {
  try {
    const antes = await criativosRepo.buscarPorId(req.params.id);
    const criativo = await criativosRepo.atualizar(req.params.id, req.body);
    if (!criativo) return res.status(404).json({ erro: 'criativo não encontrado' });

    // Só na TRANSIÇÃO para aprovado. Sem comparar com o estado anterior, todo
    // salvamento do admin reenviaria o aviso e o anunciante receberia
    // "seu anúncio está no ar" várias vezes pelo mesmo vídeo.
    if (criativo.status === 'aprovado' && (antes?.status !== 'aprovado')) {
      const dono = await anunciantesRepo.buscarPorId(criativo.anunciante_id);
      // fire-and-forget: e-mail que falha não pode impedir a aprovação, que é
      // o que coloca o vídeo no ar.
      if (dono) enviarCriativoNoAr(dono, criativo).catch((err) => console.error('e-mail criativo no ar', err));
      eventos.registrar('criativo:video_aprova', {
        horas_ate_aprovar: eventos.horasEntre(criativo.created_at),
        duracao_segundos: criativo.duracao_segundos,
        pelo_operador: !!criativo.editado_pelo_operador,
      }, dono);
    }
    res.json(criativo);
  } catch (err) {
    if (err.code === '23514') return res.status(400).json({ erro: 'status inválido' });
    throw err;
  }
});

// Tudo que a tela inicial do admin precisa numa requisição só: as filas que
// pedem ação, o resultado do mês e a fotografia da rede. Antes eram 4 abas
// separadas (margem, offline, eventos, fila) que ninguém abria junto — e o
// admin não tinha como saber o que estava pendente sem clicar em todas.
// As três consultas salvas da métrica (funcional.md §9). Ficam num módulo à
// parte porque são SQL longo e de leitura própria — misturadas no resumo,
// ninguém acharia nem uma nem outro.
router.get('/admin/metrica', async (_req, res) => {
  res.json(await metrica.consultar());
});

router.get('/admin/resumo', async (_req, res) => {
  const limiteOffline = new Date(Date.now() - HORAS_OFFLINE_ALERTA * 3600 * 1000);

  const [
    receita, pontosAtivos, amortizacao, custosFixos, filas, pontosPorStatus, anunciantesPorStatus,
    offline, faturamento, exibicoes, novos,
  ] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(COALESCE(a.valor_mensal_travado, p.valor_mensal)), 0) AS total FROM anunciantes a
       JOIN planos p ON p.id = a.plano_id WHERE a.status = 'ativo'`
    ),
    pool.query(
      `SELECT COALESCE(SUM(valor_pago_mensal), 0) AS total, COUNT(*) AS qtd,
              COALESCE(SUM(fluxo_estimado_mensal), 0) AS fluxo
       FROM pontos WHERE status = 'ativo'`
    ),
    // Amortização real: custo de cada tela dividido pelo prazo dela, só das
    // telas ativas; mais os custos fixos lançados pelo dono.
    pool.query(
      `SELECT COALESCE(SUM(d.custo_equipamento / GREATEST(d.meses_amortizacao, 1)), 0) AS amortizacao,
              COUNT(*)::int AS telas
       FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
       WHERE d.status = 'ativo' AND p.status = 'ativo'`
    ),
    pool.query(`SELECT COALESCE(SUM(valor_mensal), 0) AS total FROM custos_fixos WHERE ativo`),
    pool.query(
      `SELECT
        (SELECT COUNT(*) FROM criativos WHERE status = 'pendente') AS criativos,
        (SELECT COUNT(*) FROM eventos_assinatura_pendentes WHERE NOT resolvido) AS eventos,
        (SELECT COUNT(*) FROM anunciantes WHERE status = 'pendente_aprovacao' AND excluido_em IS NULL) AS anunciantes,
        (SELECT COUNT(*) FROM pontos WHERE status = 'lead') AS pontos,
        (SELECT COUNT(*) FROM cobrancas_confirmadas WHERE nota_fiscal_status = 'pendente') AS notas,
        (SELECT COUNT(*) FROM candidaturas WHERE status = 'nova') AS candidaturas,
        (SELECT COUNT(*) FROM arrependimentos WHERE status = 'pendente') AS arrependimentos`
    ),
    pool.query('SELECT status, COUNT(*)::int AS qtd FROM pontos GROUP BY status'),
    // Separa quem paga de quem está em cortesia. Sem isso o resumo dizia
    // "5 anunciantes ativos" com três liberados de graça — e a leitura do
    // negócio saía errada justamente no número que mais importa.
    pool.query(`SELECT status, plano_cortesia, COUNT(*)::int AS qtd
                FROM anunciantes WHERE excluido_em IS NULL
                GROUP BY status, plano_cortesia`),
    pool.query(
      `SELECT COUNT(*)::int AS qtd FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
       WHERE d.status = 'ativo' AND p.status = 'ativo'
         AND (d.ultima_vez_online IS NULL OR d.ultima_vez_online < $1)`,
      [limiteOffline]
    ),
    pool.query(
      `SELECT to_char(date_trunc('month', criado_em), 'YYYY-MM') AS mes, SUM(valor)::numeric AS total
       FROM cobrancas_confirmadas
       WHERE criado_em > now() - interval '6 months'
       GROUP BY mes ORDER BY mes`
    ),
    pool.query(
      `SELECT COALESCE(SUM(vezes_confirmadas), 0)::int AS confirmadas,
              COALESCE(SUM(vezes_programadas), 0)::int AS programadas
       FROM exibicoes_contador WHERE janela_hora > now() - interval '30 days'`
    ),
    pool.query(
      `SELECT
        (SELECT COUNT(*) FROM anunciantes WHERE created_at > now() - interval '30 days' AND excluido_em IS NULL) AS anunciantes,
        (SELECT COUNT(*) FROM pontos WHERE created_at > now() - interval '30 days') AS pontos`
    ),
  ]);

  const receitaMensal = Number(receita.rows[0].total);
  const custoPontosMensal = Number(pontosAtivos.rows[0].total);
  const amortizacaoMensal = Number(amortizacao.rows[0].amortizacao);
  const custosFixosMensal = Number(custosFixos.rows[0].total);

  res.json({
    // Filas que pedem ação do admin — viram os alertas do topo da tela.
    filas: {
      criativos: Number(filas.rows[0].criativos),
      eventos: Number(filas.rows[0].eventos),
      anunciantes: Number(filas.rows[0].anunciantes),
      pontos: Number(filas.rows[0].pontos),
      notas: Number(filas.rows[0].notas),
      candidaturas: Number(filas.rows[0].candidaturas),
      // Dinheiro que a lei manda devolver e ainda não voltou. É a única fila
      // com prazo legal correndo, por isso entra como urgente na visão geral.
      arrependimentos: Number(filas.rows[0].arrependimentos),
      offline: offline.rows[0].qtd,
    },
    financeiro: {
      receitaMensal,
      custoPontosMensal,
      amortizacaoMensal,
      custosFixosMensal,
      margemMensal: receitaMensal - custoPontosMensal - amortizacaoMensal - custosFixosMensal,
      faturamentoPorMes: faturamento.rows,
    },
    rede: {
      pontosAtivos: Number(pontosAtivos.rows[0].qtd),
      telasAtivas: amortizacao.rows[0].telas,
      fluxoMensal: Number(pontosAtivos.rows[0].fluxo),
      pontosPorStatus: pontosPorStatus.rows,
      // Mantém a forma antiga (status + qtd, somando os dois tipos) pra não
      // quebrar quem já lê isso, e acrescenta a contagem de cortesia separada.
      anunciantesPorStatus: Object.values(
        anunciantesPorStatus.rows.reduce((acc, r) => {
          acc[r.status] = acc[r.status] || { status: r.status, qtd: 0 };
          acc[r.status].qtd += r.qtd;
          return acc;
        }, {})
      ),
      anunciantesAtivosPagantes: anunciantesPorStatus.rows
        .filter((r) => r.status === 'ativo' && !r.plano_cortesia)
        .reduce((soma, r) => soma + r.qtd, 0),
      anunciantesEmCortesia: anunciantesPorStatus.rows
        .filter((r) => r.plano_cortesia)
        .reduce((soma, r) => soma + r.qtd, 0),
      exibicoes30d: exibicoes.rows[0].confirmadas,
      programadas30d: exibicoes.rows[0].programadas,
      novosAnunciantes30d: Number(novos.rows[0].anunciantes),
      novosPontos30d: Number(novos.rows[0].pontos),
    },
    horasOfflineAlerta: HORAS_OFFLINE_ALERTA,
    // Única regra de plano que mora em variável de ambiente (CONSTRAINTS.md):
    // liga/desliga a vitrine do plano fundador sem deploy.
    programaFundadorAtivo: process.env.PROGRAMA_FUNDADOR_ATIVO === 'true',
  });
});

// Alerta de ponto offline — a aba "Pontos" filtra pela mesma regra usando
// ultima_vez_online + horasOfflineAlerta do /admin/resumo; isso aqui fica
// como a lista pronta, pra quando alguém quiser só ela.
router.get('/admin/pontos-offline', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.apelido, d.ultima_vez_online, p.id AS ponto_id, p.nome AS ponto_nome
     FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
     WHERE d.status = 'ativo' AND p.status = 'ativo'
       AND (d.ultima_vez_online IS NULL OR d.ultima_vez_online < $1)
     ORDER BY d.ultima_vez_online NULLS FIRST`,
    [new Date(Date.now() - HORAS_OFFLINE_ALERTA * 3600 * 1000)]
  );
  res.json(rows);
});

// Custos fixos da operação — entram na margem do resumo.
router.get('/admin/custos-fixos', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM custos_fixos ORDER BY ativo DESC, nome');
  res.json(rows);
});
router.post('/admin/custos-fixos', async (req, res) => {
  const { nome, valor_mensal, observacao } = req.body;
  if (!nome) return res.status(400).json({ erro: 'nome obrigatório' });
  const { rows } = await pool.query(
    'INSERT INTO custos_fixos (nome, valor_mensal, observacao) VALUES ($1,$2,$3) RETURNING *',
    [nome, Number(valor_mensal) || 0, observacao || null]
  );
  res.status(201).json(rows[0]);
});
router.patch('/admin/custos-fixos/:id', async (req, res) => {
  const campos = ['nome', 'valor_mensal', 'ativo', 'observacao'].filter((c) => req.body[c] !== undefined);
  if (!campos.length) return res.status(400).json({ erro: 'nada pra atualizar' });
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `UPDATE custos_fixos SET ${sets} WHERE id = $1 RETURNING *`,
    [req.params.id, ...campos.map((c) => (c === 'valor_mensal' ? Number(req.body[c]) : req.body[c]))]
  );
  if (!rows[0]) return res.status(404).json({ erro: 'custo não encontrado' });
  res.json(rows[0]);
});
router.delete('/admin/custos-fixos/:id', async (req, res) => {
  await pool.query('DELETE FROM custos_fixos WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
