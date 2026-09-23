const express = require('express');
const router = express.Router();
const criativosRepo = require('../anunciantes/criativos-repository');
const pool = require('../db/pool');
const anunciantesRepo = require('../anunciantes/repository');
const { enviarCriativoNoAr, enviarCriativoReprovado, diagnosticarSmtp } = require('../financeiro/email');
const { ultimaConciliacao } = require('../financeiro/conciliacao');
const pagamentosPontoRepo = require('../pontos/pagamentos-repository');
const dispositivosRepo = require('../dispositivos/repository');
const { valorMensalDaConta } = require('../financeiro/san-checkout');
const eventos = require('../lib/eventos');
const metrica = require('./metrica');

// HORAS_OFFLINE_ALERTA morreu como filtro fixo de "sem heartbeat" (rodada
// horário operacional da tela, 23/09/2026) — virou TOLERANCIA_OFFLINE_MS
// dentro de src/lib/status-tela.js, a única régua de "sem sinal" agora
// (soma horário de funcionamento + modo da tela, não só o relógio).
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
      // o que coloca o vídeo no ar. Conta própria (Mídia Mostraí) não recebe
      // — o `contato_email` dela é um endereço interno sem caixa de entrada
      // (ensureContaMostrai), não um anunciante de verdade esperando aviso.
      if (dono && !dono.conta_propria)
        enviarCriativoNoAr(dono, criativo).catch((err) => console.error('e-mail criativo no ar', err));
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
      // Mesma exclusão de conta própria do bloco de aprovado acima.
      if (dono && !dono.conta_propria)
        enviarCriativoReprovado(dono, criativo).catch((err) => console.error('e-mail criativo reprovado', err));
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

// Função pura, separada da rota só pra dar pra testar sem servidor (mesmo
// motivo de sempre: lógica não trivial de dinheiro ganha uma checagem
// executável). Cada linha de `receita.rows` já traz conta + plano + a
// assinatura ativa (se houver) juntos — aqui só soma por ciclo, chamando
// `valorMensalDaConta` linha a linha pra respeitar promoção travada,
// desconto de parceiro e crédito de comodato (seção 6.1 do pedido).
function agregarReceitaPorCiclo(linhas) {
  // Ciclo sem nenhuma conta pagando não vem linha nenhuma do banco, por
  // isso o default de 0 pra cada um (1/3/6/12 meses).
  const receitaPorCiclo = { 1: 0, 3: 0, 6: 0, 12: 0 };
  for (const r of linhas) {
    const valor = valorMensalDaConta(
      {
        status: r.status,
        papeis: r.papeis,
        credito_comodato_mensal: r.credito_comodato_mensal,
        parceiro_desconto_percentual: r.parceiro_desconto_percentual,
        parceiro_compromisso_minimo: r.parceiro_compromisso_minimo,
      },
      {
        tier: r.tier,
        valor_mensal: r.valor_mensal,
        valor_mensal_cheio: r.valor_mensal_cheio,
        compromisso_meses: r.compromisso_meses,
      },
      { promocao_valido_ate: r.promocao_valido_ate, promocao_desconto_percentual: r.promocao_desconto_percentual },
    );
    receitaPorCiclo[r.compromisso_meses] = (receitaPorCiclo[r.compromisso_meses] || 0) + valor;
  }
  return receitaPorCiclo;
}

router.get('/admin/resumo', async (_req, res) => {
  const [
    receita,
    pontosAtivos,
    amortizacao,
    custosFixos,
    filas,
    pontosPorStatus,
    anunciantesPorSituacao,
    telasComProblemaDeSinal,
    faturamento,
    exibicoes,
    novos,
    conversao,
    repassesPendentes,
    trocasPendentes,
  ] = await Promise.all([
    // Receita recorrente = o que ENTRA de verdade todo mês. O filtro era só
    // `status = 'ativo'`, então somava três coisas que não pagam nada:
    // conta em cortesia (plano liberado de graça), conta excluída que ficou
    // com status ativo, e conta cuja cobertura já venceu. A margem — que é a
    // métrica principal do projeto — mentia pra cima em todas as três.
    // `status` deixou de ter esse sentido (virou só comum/parceiro,
    // 16/09/2026) — quem tem plano de verdade é quem tem `plano_id`.
    //
    // Virou consulta de LINHAS, não de soma pronta (revisão final da Visão
    // geral, 23/09/2026, seção 6.1 do pedido): `p.valor_mensal` sozinho é só
    // o preço de TABELA do ciclo — não carrega promoção travada na adesão
    // (`assinaturas.promocao_*`, snapshot da rodada de Ofertas/Promoções),
    // nem o desconto de parceiro, nem o crédito de comodato da conta
    // (`credito_comodato_mensal`). Somar `valor_mensal` direto inflava o MRR
    // de qualquer conta com um desses três. `valorMensalDaConta()` (mesma
    // função que já monta a cobrança de verdade em san-checkout.js) resolve
    // os três — reaproveitada aqui, não reimplementada. Plano Inicial/Básico
    // já têm `valor_mensal = 0` na tabela, então nem precisam de exclusão à
    // parte: entram na conta e somam zero.
    pool.query(
      `SELECT a.id, a.status, a.papeis, a.credito_comodato_mensal,
              a.parceiro_desconto_percentual, a.parceiro_compromisso_minimo,
              p.tier, p.valor_mensal, p.valor_mensal_cheio, p.compromisso_meses,
              s.promocao_valido_ate, s.promocao_desconto_percentual
       FROM anunciantes a
       JOIN planos p ON p.id = a.plano_id
       LEFT JOIN LATERAL (
         SELECT promocao_valido_ate, promocao_desconto_percentual FROM assinaturas
         WHERE anunciante_id = a.id AND status = 'ativa' ORDER BY created_at DESC LIMIT 1
       ) s ON true
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
        -- Candidatura pendente = mesma definição da aba Rede > Candidaturas
        -- (tudo que ainda não foi aprovado nem recusado). Ponto "aguardando
        -- instalação" NÃO entra aqui: já é ponto aprovado, só sem tela. A
        -- fila antiga "pontos" (status 'a_instalar', rotulada como
        -- "candidatos aguardando triagem") saiu na rodada de integridade de
        -- 23/09/2026 — ela contava 'lead' (o ponto candidato de antes da
        -- tabela de candidaturas) e, quando 'lead' foi aposentado, a query
        -- virou 'a_instalar' sem mudar o rótulo. A contagem por status do
        -- ponto continua em rede.pontosPorStatus, que é o lugar dela.
        -- "Notas por emitir" também saiu: todo pagamento nasce com
        -- nota_fiscal_status = 'pendente', então a fila contava o histórico
        -- inteiro, e emissão manual não existe mais na UI.
        (SELECT COUNT(*) FROM candidaturas WHERE status NOT IN ('aprovada', 'recusada')) AS candidaturas,
        (SELECT COUNT(*) FROM arrependimentos WHERE status = 'pendente') AS arrependimentos,
        (SELECT COALESCE(SUM(valor_a_estornar), 0) FROM arrependimentos WHERE status = 'pendente') AS arrependimentos_total,
        -- Mensagem do formulário de contato ainda sem resposta. Entra como
        -- fila porque /contato.html é o canal declarado do titular de dados
        -- (LGPD art. 18) — pedido com prazo legal não pode depender de
        -- alguém lembrar de abrir uma aba.
        (SELECT COUNT(*) FROM mensagens_contato WHERE respondida_em IS NULL) AS contato,
        -- Banco de horas (G.3): saldo que passou de N meses sem drenar,
        -- esperando o admin decidir (crédito manual, desconto, ou nada —
        -- nunca automático). Ver src/bancohoras/apuracao.js.
        (SELECT COUNT(*) FROM banco_horas WHERE status = 'aguardando_credito' AND resolvido_em IS NULL) AS bancohoras,
        -- Pontos travados pra escolha nova por ocupação (G.7) — só sai daqui
        -- quando o admin libera (src/pontos/repository.js).
        (SELECT COUNT(*) FROM pontos WHERE escolha_bloqueada_em IS NOT NULL) AS pontosocupados`,
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
    // Só telas em sem_sinal/erro_do_player (src/lib/status-tela.js) — nunca
    // fora_do_horario nem aguardando_primeiro_sinal, que não são falha.
    dispositivosRepo.listarComProblemaDeSinal(),
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
    // % de quem criou conta e está pagando um plano de verdade hoje — pedido
    // do dono, 21/09/2026. "Criou conta" é todo mundo (menos a conta própria
    // da Mostraí); "paga" usa o mesmo filtro da receita recorrente acima
    // (cortesia e suspensa não contam como pagando, mas contam no total —
    // criaram conta, só não converteram).
    pool.query(
      `SELECT
        (SELECT COUNT(*) FROM anunciantes WHERE NOT conta_propria) AS total,
        (SELECT COUNT(*) FROM anunciantes
           WHERE NOT conta_propria AND plano_id IS NOT NULL AND NOT suspenso AND NOT plano_cortesia
             AND excluido_em IS NULL AND (data_expiracao IS NULL OR data_expiracao >= current_date)) AS pagantes`,
    ),
    // Bloco financeiro da Visão geral (rodada Financeiro, 22/09/2026):
    // "normalidade não ocupa espaço, pendência aparece" — as três filas de
    // dinheiro a pagar, com contador e total, só pra virar o card quando
    // qtd > 0. A lista completa de repasses (com ponto/responsável/forma)
    // é a mesma usada pela fila #financeiro/repasses — uma função só, sem
    // duas consultas divergindo.
    pagamentosPontoRepo.listarPendentesDoMes(),
    pool.query(
      `SELECT COUNT(*)::int AS qtd, COALESCE(SUM(valor), 0) AS total FROM pedidos_avulsos WHERE status = 'pendente'`,
    ),
  ]);

  const ultima = await ultimaConciliacao();
  const receitaPorCiclo = agregarReceitaPorCiclo(receita.rows);
  const receitaMensal = Object.values(receitaPorCiclo).reduce((soma, v) => soma + v, 0);
  const custoPontosMensal = Number(pontosAtivos.rows[0].total);
  const amortizacaoMensal = Number(amortizacao.rows[0].amortizacao);
  const custosFixosMensal = Number(custosFixos.rows[0].total);
  const totalContas = Number(conversao.rows[0].total);
  const contasPagantes = Number(conversao.rows[0].pagantes);
  const percentualPagantes = totalContas > 0 ? (contasPagantes / totalContas) * 100 : null;

  // Pendências financeiras (revisão final da Visão geral, 23/09/2026,
  // seção 3/4 do pedido): repasse pendente + troca de plano com problema +
  // devolução pendente viram UM card agregado ("Financeiro / N · R$ X"),
  // não mais três cards separados. Comissão de vendedor SAIU da conta — o
  // conceito de vendedor não é mais parte do pedido; a tabela/rota
  // `comissoes` continua existindo dentro de Contas, só não soma mais aqui.
  const repassesPendentesInfo = {
    qtd: repassesPendentes.length,
    total: repassesPendentes.reduce((s, r) => s + Number(r.valor_pago_mensal), 0),
  };
  const trocasPendentesInfo = {
    qtd: Number(trocasPendentes.rows[0].qtd),
    total: Number(trocasPendentes.rows[0].total),
  };
  const devolucoesPendentesInfo = {
    qtd: Number(filas.rows[0].arrependimentos),
    total: Number(filas.rows[0].arrependimentos_total),
  };

  res.json({
    // Filas que pedem ação do admin — viram os alertas do topo da tela.
    filas: {
      criativos: Number(filas.rows[0].criativos),
      eventos: Number(filas.rows[0].eventos),
      candidaturas: Number(filas.rows[0].candidaturas),
      // Dinheiro que a lei manda devolver e ainda não voltou. Continua exposta
      // solta (além de entrar no agregado financeiro) porque é a única com
      // prazo legal correndo — o alerta de urgência olha só pra ela.
      arrependimentos: Number(filas.rows[0].arrependimentos),
      contato: Number(filas.rows[0].contato),
      offline: telasComProblemaDeSinal.length,
      bancohoras: Number(filas.rows[0].bancohoras),
      pontosocupados: Number(filas.rows[0].pontosocupados),
    },
    financeiro: {
      receitaMensal,
      receitaPorCiclo,
      custoPontosMensal,
      amortizacaoMensal,
      custosFixosMensal,
      margemMensal: receitaMensal - custoPontosMensal - amortizacaoMensal - custosFixosMensal,
      faturamentoPorMes: faturamento.rows,
      // Confirmado no mês corrente = a própria linha de `faturamentoPorMes`
      // (cobrancas_confirmadas agrupado por mês) — sem consulta nova, só
      // achar a linha do mês de hoje; 0 se ninguém pagou ainda este mês.
      receitaConfirmadaMes: Number(
        faturamento.rows.find((r) => r.mes === new Date().toISOString().slice(0, 7))?.total || 0,
      ),
      // null (não 0) quando não há nenhuma conta ainda — 0% mentiria "todo
      // mundo tentou e ninguém converteu" numa rede que não tem conta nenhuma.
      percentualPagantes,
      totalContas,
      contasPagantes,
      repassesPendentes: repassesPendentesInfo,
      trocasPendentes: trocasPendentesInfo,
      devolucoesPendentes: devolucoesPendentesInfo,
      // O card único da Visão geral (seção 3/4) — soma dos três acima.
      // Detalhe de cada um mora na Central Financeira (`#financeiro`), aba a
      // aba, não aqui.
      pendenciasFinanceiras: {
        qtd: repassesPendentesInfo.qtd + trocasPendentesInfo.qtd + devolucoesPendentesInfo.qtd,
        total: repassesPendentesInfo.total + trocasPendentesInfo.total + devolucoesPendentesInfo.total,
      },
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
  });
});

// Alerta de tela com sinal comprometido — a aba "Rede" usa a mesma lista;
// isso aqui fica como o endpoint pronto, pra quando alguém quiser só ela.
// Substituiu a checagem fixa "sem heartbeat há 2h" (rodada horário
// operacional da tela, 23/09/2026): agora só entra quem deveria estar
// online e não está (src/lib/status-tela.js).
router.get('/admin/pontos-offline', async (_req, res) => {
  const telas = await dispositivosRepo.listarComProblemaDeSinal();
  res.json(
    telas.map((t) => ({
      id: t.id,
      apelido: t.apelido,
      ultima_vez_online: t.ultima_vez_online,
      ponto_id: t.ponto_id,
      ponto_nome: t.ponto_nome,
      situacaoOperacional: t.situacaoOperacional,
    })),
  );
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

// Anexado no próprio router (não num export nomeado): server.js espera
// `require('./admin/routes')` como o router pronto, sem quebrar isso só
// pra dar um gancho de teste pra uma função pura.
router.agregarReceitaPorCiclo = agregarReceitaPorCiclo;

module.exports = router;
