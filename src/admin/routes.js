const express = require('express');
const router = express.Router();
const criativosRepo = require('../anunciantes/criativos-repository');
const pool = require('../db/pool');
const anunciantesRepo = require('../anunciantes/repository');
const { enviarCriativoNoAr, enviarCriativoReprovado, diagnosticarSmtp } = require('../financeiro/email');
const { ultimaConciliacao } = require('../financeiro/conciliacao');
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
    if (criativo.status === 'aprovado' && antes?.status !== 'aprovado') {
      const dono = await anunciantesRepo.buscarPorId(criativo.anunciante_id);
      // fire-and-forget: e-mail que falha não pode impedir a aprovação, que é
      // o que coloca o vídeo no ar.
      if (dono) enviarCriativoNoAr(dono, criativo).catch((err) => console.error('e-mail criativo no ar', err));
      eventos.registrar(
        'criativo:video_aprova',
        {
          horas_ate_aprovar: eventos.horasEntre(criativo.created_at),
          duracao_segundos: criativo.duracao_segundos,
          pelo_operador: !!criativo.editado_pelo_operador,
        },
        dono,
      );
    }
    // Mesma regra do aprovado, do outro lado: reprovar era um beco sem saída
    // — o card virava "Reprovado" e nada mais acontecia. Agora sai um aviso
    // com o motivo e o caminho de correção.
    if (criativo.status === 'reprovado' && antes?.status !== 'reprovado') {
      const dono = await anunciantesRepo.buscarPorId(criativo.anunciante_id);
      if (dono) enviarCriativoReprovado(dono, criativo).catch((err) => console.error('e-mail criativo reprovado', err));
      eventos.registrar(
        'criativo:video_reprova',
        {
          horas_ate_reprovar: eventos.horasEntre(criativo.created_at),
          tem_motivo: !!criativo.motivo_reprovacao,
        },
        dono,
      );
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
// Diagnóstico do e-mail: faz o LOGIN no servidor de SMTP e diz se passou,
// sem mandar mensagem nenhuma. Existe porque a única forma de saber se a
// senha de app do Gmail está valendo era esperar um pagamento real acontecer
// e depois caçar o erro nos logs — o que só se descobre tarde e por acaso
// (foi assim que o item 9 de PENDENCIAS apareceu, em 16/09/2026).
//
// Não devolve a senha nem parte dela: só se existe, quantos caracteres tem e
// se sobrou espaço no meio. Senha de app do Gmail tem 16 caracteres; os
// espaços que o Google mostra na tela são separação visual e não entram.
router.get('/admin/diagnostico/smtp', async (_req, res) => {
  res.json(await diagnosticarSmtp());
});

router.get('/admin/metrica', async (_req, res) => {
  res.json(await metrica.consultar());
});

router.get('/admin/resumo', async (_req, res) => {
  const limiteOffline = new Date(Date.now() - HORAS_OFFLINE_ALERTA * 3600 * 1000);

  const [
    receita,
    pontosAtivos,
    amortizacao,
    custosFixos,
    filas,
    pontosPorStatus,
    anunciantesPorSituacao,
    offline,
    faturamento,
    exibicoes,
    novos,
  ] = await Promise.all([
    // Receita recorrente = o que ENTRA de verdade todo mês. O filtro era só
    // `status = 'ativo'`, então somava três coisas que não pagam nada:
    // conta em cortesia (plano liberado de graça), conta excluída que ficou
    // com status ativo, e conta cuja cobertura já venceu. A margem — que é a
    // métrica principal do projeto — mentia pra cima em todas as três.
    // `status` deixou de ter esse sentido (virou só comum/parceiro,
    // 16/09/2026) — quem tem plano de verdade é quem tem `plano_id`.
    pool.query(
      `SELECT COALESCE(SUM(p.valor_mensal), 0) AS total FROM anunciantes a
       JOIN planos p ON p.id = a.plano_id
       WHERE a.plano_id IS NOT NULL
         AND NOT a.suspenso
         AND NOT a.plano_cortesia
         AND a.excluido_em IS NULL
         AND (a.data_expiracao IS NULL OR a.data_expiracao >= current_date)`,
    ),
    pool.query(
      `SELECT COALESCE(SUM(valor_pago_mensal), 0) AS total, COUNT(*) AS qtd,
              COALESCE(SUM(fluxo_estimado_mensal), 0) AS fluxo
       FROM pontos WHERE status = 'em_operacao'`,
    ),
    // Amortização real: custo de cada tela dividido pelo prazo dela, só das
    // telas ativas; mais os custos fixos lançados pelo dono.
    pool.query(
      `SELECT COALESCE(SUM(d.custo_equipamento / GREATEST(d.meses_amortizacao, 1)), 0) AS amortizacao,
              COUNT(*)::int AS telas
       FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
       WHERE d.status = 'ativo' AND p.status = 'em_operacao'`,
    ),
    pool.query(`SELECT COALESCE(SUM(valor_mensal), 0) AS total FROM custos_fixos WHERE ativo`),
    pool.query(
      `SELECT
        (SELECT COUNT(*) FROM criativos WHERE status = 'pendente') AS criativos,
        (SELECT COUNT(*) FROM eventos_assinatura_pendentes WHERE NOT resolvido) AS eventos,
        (SELECT COUNT(*) FROM pontos WHERE status = 'a_instalar') AS pontos,
        (SELECT COUNT(*) FROM cobrancas_confirmadas WHERE nota_fiscal_status = 'pendente') AS notas,
        (SELECT COUNT(*) FROM candidaturas WHERE status = 'nova') AS candidaturas,
        (SELECT COUNT(*) FROM arrependimentos WHERE status = 'pendente') AS arrependimentos,
        -- Mensagem do formulário de contato ainda sem resposta. Entra como
        -- fila porque /contato.html é o canal declarado do titular de dados
        -- (LGPD art. 18) — pedido com prazo legal não pode depender de
        -- alguém lembrar de abrir uma aba.
        (SELECT COUNT(*) FROM mensagens_contato WHERE respondida_em IS NULL) AS contato`,
    ),
    pool.query('SELECT status, COUNT(*)::int AS qtd FROM pontos GROUP BY status'),
    // Separa quem paga de quem está em cortesia. Sem isso o resumo dizia
    // "5 anunciantes ativos" com três liberados de graça — e a leitura do
    // negócio saía errada justamente no número que mais importa.
    // `status` não diz mais isso (virou só comum/parceiro, 16/09/2026) —
    // "situação" é calculada de `suspenso` + `plano_id` + `data_expiracao`.
    pool.query(`SELECT
                  CASE
                    WHEN suspenso THEN 'suspenso'
                    WHEN plano_id IS NOT NULL AND (data_expiracao IS NULL OR data_expiracao >= now()) THEN 'ativo'
                    ELSE 'sem_plano'
                  END AS situacao,
                  plano_cortesia, COUNT(*)::int AS qtd
                FROM anunciantes WHERE excluido_em IS NULL
                GROUP BY situacao, plano_cortesia`),
    pool.query(
      `SELECT COUNT(*)::int AS qtd FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
       WHERE d.status = 'ativo' AND p.status = 'em_operacao'
         AND (d.ultima_vez_online IS NULL OR d.ultima_vez_online < $1)`,
      [limiteOffline],
    ),
    pool.query(
      `SELECT to_char(date_trunc('month', criado_em), 'YYYY-MM') AS mes, SUM(valor)::numeric AS total
       FROM cobrancas_confirmadas
       WHERE criado_em > now() - interval '6 months'
       GROUP BY mes ORDER BY mes`,
    ),
    pool.query(
      `SELECT COALESCE(SUM(vezes_confirmadas), 0)::int AS confirmadas,
              COALESCE(SUM(vezes_programadas), 0)::int AS programadas
       FROM exibicoes_contador WHERE janela_hora > now() - interval '30 days'`,
    ),
    pool.query(
      `SELECT
        (SELECT COUNT(*) FROM anunciantes WHERE created_at > now() - interval '30 days' AND excluido_em IS NULL) AS anunciantes,
        (SELECT COUNT(*) FROM pontos WHERE created_at > now() - interval '30 days') AS pontos`,
    ),
  ]);

  const ultima = await ultimaConciliacao();
  const receitaMensal = Number(receita.rows[0].total);
  const custoPontosMensal = Number(pontosAtivos.rows[0].total);
  const amortizacaoMensal = Number(amortizacao.rows[0].amortizacao);
  const custosFixosMensal = Number(custosFixos.rows[0].total);

  res.json({
    // Filas que pedem ação do admin — viram os alertas do topo da tela.
    filas: {
      criativos: Number(filas.rows[0].criativos),
      eventos: Number(filas.rows[0].eventos),
      pontos: Number(filas.rows[0].pontos),
      notas: Number(filas.rows[0].notas),
      candidaturas: Number(filas.rows[0].candidaturas),
      // Dinheiro que a lei manda devolver e ainda não voltou. É a única fila
      // com prazo legal correndo, por isso entra como urgente na visão geral.
      arrependimentos: Number(filas.rows[0].arrependimentos),
      contato: Number(filas.rows[0].contato),
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
      // Mantém a forma antiga (situacao + qtd, somando os dois tipos) pra não
      // quebrar quem já lê isso, e acrescenta a contagem de cortesia separada.
      anunciantesPorSituacao: Object.values(
        anunciantesPorSituacao.rows.reduce((acc, r) => {
          acc[r.situacao] = acc[r.situacao] || { situacao: r.situacao, qtd: 0 };
          acc[r.situacao].qtd += r.qtd;
          return acc;
        }, {}),
      ),
      anunciantesAtivosPagantes: anunciantesPorSituacao.rows
        .filter((r) => r.situacao === 'ativo' && !r.plano_cortesia)
        .reduce((soma, r) => soma + r.qtd, 0),
      anunciantesEmCortesia: anunciantesPorSituacao.rows
        .filter((r) => r.plano_cortesia)
        .reduce((soma, r) => soma + r.qtd, 0),
      exibicoes30d: exibicoes.rows[0].confirmadas,
      programadas30d: exibicoes.rows[0].programadas,
      novosAnunciantes30d: Number(novos.rows[0].anunciantes),
      novosPontos30d: Number(novos.rows[0].pontos),
    },
    // Última conciliação: é ela que põe no ar quem pagou e cujo webhook se
    // perdeu. Rodava (ou não) sem deixar rastro em tela nenhuma — e a pergunta
    // "o cron está de pé?" não tinha onde ser respondida.
    conciliacao: ultima
      ? {
          terminouEm: ultima.terminou_em,
          verificadas: ultima.verificadas,
          aplicadas: ultima.aplicadas,
          semCobranca: ultima.sem_cobranca,
          expiradas: ultima.expiradas,
          avisados: ultima.avisados,
          falhas: (ultima.falhas || []).length,
          abortou: ultima.abortou,
        }
      : null,
    horasOfflineAlerta: HORAS_OFFLINE_ALERTA,
  });
});

// Alerta de ponto offline — a aba "Pontos" filtra pela mesma regra usando
// ultima_vez_online + horasOfflineAlerta do /admin/resumo; isso aqui fica
// como a lista pronta, pra quando alguém quiser só ela.
router.get('/admin/pontos-offline', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.apelido, d.ultima_vez_online, p.id AS ponto_id, p.nome AS ponto_nome
     FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
     WHERE d.status = 'ativo' AND p.status = 'em_operacao'
       AND (d.ultima_vez_online IS NULL OR d.ultima_vez_online < $1)
     ORDER BY d.ultima_vez_online NULLS FIRST`,
    [new Date(Date.now() - HORAS_OFFLINE_ALERTA * 3600 * 1000)],
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
    [nome, Number(valor_mensal) || 0, observacao || null],
  );
  res.status(201).json(rows[0]);
});
router.patch('/admin/custos-fixos/:id', async (req, res) => {
  const campos = ['nome', 'valor_mensal', 'ativo', 'observacao'].filter((c) => req.body[c] !== undefined);
  if (!campos.length) return res.status(400).json({ erro: 'nada pra atualizar' });
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(`UPDATE custos_fixos SET ${sets} WHERE id = $1 RETURNING *`, [
    req.params.id,
    ...campos.map((c) => (c === 'valor_mensal' ? Number(req.body[c]) : req.body[c])),
  ]);
  if (!rows[0]) return res.status(404).json({ erro: 'custo não encontrado' });
  res.json(rows[0]);
});
router.delete('/admin/custos-fixos/:id', async (req, res) => {
  await pool.query('DELETE FROM custos_fixos WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
