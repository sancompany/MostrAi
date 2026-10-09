const express = require('express');
const obrigacaoDoCiclo = require('../bancohoras/obrigacao-do-ciclo');
const router = express.Router();
const criativosRepo = require('../anunciantes/criativos-repository');
const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const anunciantesRepo = require('../anunciantes/repository');
const { diagnosticarSmtp } = require('../financeiro/email');
const outbox = require('../email/outbox');
const { ultimaConciliacao } = require('../financeiro/conciliacao');
const dispositivosRepo = require('../dispositivos/repository');
const { valorMensalDaConta } = require('../financeiro/san-checkout');
const eventos = require('../lib/eventos');
const metrica = require('./metrica');
const notificacoesRepo = require('../creditos/notificacoes');
const sse = require('../lib/sse');
const filaEntrada = require('../anunciantes/fila-entrada');
// Sem ciclo: o repositório de mídias só requer pool, capacidade e fuso-comercial.
const midiasRepo = require('../midias/repository');

// "Sem sinal" tem régua única em src/lib/status-tela.js (TOLERANCIA_SEM_SINAL_MS,
// 2 min com heartbeat de 15 s — docs/player-mvp-contract.md §9), que soma o
// horário do ponto, não só o relógio.
// Custos fixos saem do banco (migration 019). A amortização de equipamento
// por tela saiu do produto em 05/10/2026 (migration 115).

// Fila de aprovação de criativos
router.get('/admin/criativos', async (req, res) => {
  res.json(await criativosRepo.listarPorStatus(req.query.status || 'pendente'));
});

router.patch('/admin/criativos/:id', async (req, res) => {
  try {
    const antes = await criativosRepo.buscarPorId(req.params.id);
    if (!antes) return res.status(404).json({ erro: 'criativo não encontrado' });
    // Arquivo de mídia própria excluída não muda mais: a exclusão o tirou da
    // fila, e ele não volta por aprovação (migration 107).
    if ((await midiasRepo.situacaoPorCriativo(req.params.id)) === 'excluida') {
      return res.status(409).json({ erro: 'esse arquivo é de uma mídia excluída — não muda mais' });
    }
    let criativo;
    // Substituição (reconstrução de Contas, 23/09/2026, Parte 22): aprovar B
    // tira A do ar no mesmo gesto — A vira 'retirado' (continua cadastrado,
    // sai da playlist). SWAP ATÔMICO (consolidação, 24/09/2026): um comando
    // só — nunca existe um instante com A e B aprovados, nem A retirado sem
    // B aprovado.
    // Vale pra qualquer estado anterior que não seja 'aprovado' (finalização,
    // 28/09/2026): substituto recusado e aprovado depois também retira o
    // original — antes caía no caminho comum e A e B ficavam os dois no ar.
    if (req.body.status === 'aprovado' && antes.status !== 'aprovado' && antes.substitui_criativo_id) {
      await pool.query(
        `WITH nova AS (
           UPDATE criativos SET status = 'aprovado' WHERE id = $1 AND status <> 'aprovado' RETURNING substitui_criativo_id
         )
         UPDATE criativos SET status = 'retirado', retirado_por = 'substituicao'
          WHERE id = (SELECT substitui_criativo_id FROM nova) AND status = 'aprovado'`,
        [antes.id],
      );
      criativo = await criativosRepo.buscarPorId(antes.id);
    } else {
      // Quem tirou do ar fica registrado (migration 109): o cliente só
      // retoma pelo painel o que ele mesmo pausou; o que o admin retirou
      // volta só daqui ("Colocar no ar" limpa a marca).
      const dados = { ...req.body };
      delete dados.retirado_por; // quem tirou do ar vem do status, nunca do corpo
      if (dados.status === 'retirado') dados.retirado_por = 'admin';
      if (dados.status === 'aprovado') dados.retirado_por = null;
      criativo = await criativosRepo.atualizar(req.params.id, dados);
    }
    if (!criativo) return res.status(404).json({ erro: 'criativo não encontrado' });
    if (antes.status !== criativo.status) sse.emitirParaAdmin('creative.updated', { id: criativo.id });
    // Aprovou (a campanha fica disponível) ou retirou (retirada da Mostraí
    // não é culpa do cliente): reavalia a janela de indisponibilidade.
    if (antes.status !== criativo.status)
      await obrigacaoDoCiclo.avaliarDisponibilidadeSemFalhar(criativo.anunciante_id);

    // Só na TRANSIÇÃO para aprovado. Sem comparar com o estado anterior, todo
    // salvamento do admin reenviaria o aviso e o anunciante receberia
    // "seu anúncio foi aprovado" várias vezes pelo mesmo vídeo. Voltar do
    // 'retirado' (Colocar no ar, na ficha) também não é aprovação nova: sem
    // e-mail, sem evento de tempo-até-aprovar.
    if (criativo.status === 'aprovado' && antes?.status !== 'aprovado' && antes?.status !== 'retirado') {
      const dono = await anunciantesRepo.buscarPorId(criativo.anunciante_id);
      // fire-and-forget: e-mail que falha não pode impedir a aprovação, que é
      // o que libera o vídeo para a programação. Conta própria (Mídia Mostraí) não recebe
      // — o `contato_email` dela é um endereço interno sem caixa de entrada
      // (ensureContaMostrai), não um anunciante de verdade esperando aviso.
      if (dono && !dono.conta_propria) {
        await outbox.enfileirarSemFalhar({
          tipo: 'criativo_aprovado',
          chave: `criativo_aprovado:${criativo.id}`,
          para: dono.contato_email,
          anuncianteId: dono.id,
          dados: {
            conta: { nome_empresa: dono.nome_empresa },
            criativo: { duracao_segundos: criativo.duracao_segundos || null },
          },
        });
        await notificacoesRepo
          .registrar(dono.id, {
            tipo: 'criativo_aprovado',
            titulo: 'Seu criativo foi aprovado',
            // Aprovado ≠ no ar (27/09/2026): a peça entra na programação da
            // próxima hora cheia de um ponto aberto da cobertura, e "No ar"
            // só aparece com a primeira exibição confirmada pela TV.
            descricao:
              'Ele entra na programação das telas e aparece como "No ar" quando a TV confirmar a primeira exibição.',
            entidadeTipo: 'criativo',
            entidadeId: criativo.id,
          })
          .catch((err) => console.error('falha ao notificar criativo aprovado', err.message));
        sse.emitirParaConta(dono.id, 'creative.updated', { id: criativo.id, status: criativo.status });
      }
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
      if (dono && !dono.conta_propria) {
        await outbox.enfileirarSemFalhar({
          tipo: 'criativo_recusado',
          chave: `criativo_recusado:${criativo.id}`,
          para: dono.contato_email,
          anuncianteId: dono.id,
          dados: {
            conta: { nome_empresa: dono.nome_empresa },
            criativo: { motivo_reprovacao: criativo.motivo_reprovacao || null },
          },
        });
        await notificacoesRepo
          .registrar(dono.id, {
            tipo: 'criativo_recusado',
            titulo: 'Seu criativo não foi aprovado desta vez',
            descricao: criativo.motivo_reprovacao || undefined,
            entidadeTipo: 'criativo',
            entidadeId: criativo.id,
          })
          .catch((err) => console.error('falha ao notificar criativo recusado', err.message));
        sse.emitirParaConta(dono.id, 'creative.updated', { id: criativo.id, status: criativo.status });
      }
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

// Fila de e-mails (migration 097): contagem por estado e os que estão
// falhando/abandonados — destinatário mascarado, sem conteúdo nem código.
router.get('/admin/emails', async (_req, res) => {
  res.json(await require('../email/outbox').resumo());
});

router.get('/admin/metrica', async (_req, res) => {
  res.json(await metrica.consultar());
});

// Função pura, separada da rota só pra dar pra testar sem servidor (mesmo
// motivo de sempre: lógica não trivial de dinheiro ganha uma checagem
// executável). Cada linha de `receita.rows` já traz conta + plano + a
// assinatura ativa (se houver) juntos — aqui só soma por ciclo, chamando
// `valorMensalDaConta` linha a linha pra respeitar promoção travada,
// e desconto de parceiro (seção 6.1 do pedido).
function agregarReceitaPorCiclo(linhas) {
  // Ciclo sem nenhuma conta pagando não vem linha nenhuma do banco, por
  // isso o default de 0 pra cada um (1/3/6/12 meses).
  const receitaPorCiclo = { 1: 0, 3: 0, 6: 0, 12: 0 };
  for (const r of linhas) {
    const valor = valorMensalDaConta(
      {
        status: r.status,
        papeis: r.papeis,
        parceiro_desconto_percentual: r.parceiro_desconto_percentual,
        parceiro_compromisso_minimo: r.parceiro_compromisso_minimo,
      },
      {
        tier: r.tier,
        valor_mensal: r.valor_mensal,
        valor_mensal_cheio: r.valor_mensal_cheio,
        compromisso_meses: r.compromisso_meses,
      },
      { promocao_desconto_percentual: r.promocao_desconto_percentual },
    );
    receitaPorCiclo[r.compromisso_meses] = (receitaPorCiclo[r.compromisso_meses] || 0) + valor;
  }
  return receitaPorCiclo;
}

router.get('/admin/resumo', async (_req, res) => {
  const [
    receita,
    pontosAtivos,
    telasAtivas,
    custosFixos,
    filas,
    pontosPorStatus,
    anunciantesPorSituacao,
    telasAtencao,
    faturamento,
    exibicoes,
    novos,
    conversao,
    trocasPendentes,
    entradaNoAr,
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
    // nem o desconto de parceiro. Somar `valor_mensal` direto inflava o MRR
    // de qualquer conta com um desses. `valorMensalDaConta()` (mesma
    // função que já monta a cobrança de verdade em san-checkout.js) resolve
    // os dois — reaproveitada aqui, não reimplementada. Créditos não são
    // receita (ADR-016): benefício por créditos não entra; o plano pago
    // guardado sob um benefício entra, porque a assinatura dele segue ativa.
    // MRR = só assinatura PAGA (ADR-016, regra 42): benefício por créditos
    // e cortesia não entram; o crédito mensal do ponto não mexe aqui. Plano
    // pago GUARDADO por baixo de um benefício (a assinatura segue cobrando,
    // migration 082) entra pelo plano guardado — a conta continua pagando.
    pool.query(
      `SELECT a.id, a.status, a.papeis,
              a.parceiro_desconto_percentual, a.parceiro_compromisso_minimo,
              p.tier, p.valor_mensal, p.valor_mensal_cheio, p.compromisso_meses,
              s.promocao_desconto_percentual
       FROM anunciantes a
       JOIN planos p ON p.id = CASE WHEN a.plano_cortesia THEN a.plano_pago_guardado_id ELSE a.plano_id END
       LEFT JOIN LATERAL (
         SELECT promocao_desconto_percentual FROM assinaturas
         WHERE anunciante_id = a.id AND status = 'ativa' ORDER BY created_at DESC LIMIT 1
       ) s ON true
       WHERE NOT a.suspenso
         AND a.excluido_em IS NULL
         AND (
           (NOT a.plano_cortesia AND a.plano_id IS NOT NULL
              AND ${vigencia.vigenteSql('a.data_expiracao')})
           OR (a.plano_cortesia AND a.plano_pago_guardado_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM assinaturas x WHERE x.anunciante_id = a.id AND x.status = 'ativa'))
         )`,
    ),
    pool.query(
      `SELECT COUNT(*) AS qtd, COALESCE(SUM(fluxo_estimado_mensal), 0) AS fluxo
       FROM pontos WHERE status = 'em_operacao'`,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS telas
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
        -- Banco de horas: fila 'aguardando_credito' é histórico da válvula
        -- que saiu em 25/09/2026 (banco de horas não expira) — só conta
        -- linha antiga ainda não resolvida (src/bancohoras/routes.js).
        (SELECT COUNT(*) FROM banco_horas WHERE status = 'aguardando_credito' AND resolvido_em IS NULL) AS bancohoras,
        -- Pontos travados pra escolha nova por ocupação (G.7) — só sai daqui
        -- quando o admin libera (src/pontos/repository.js).
        (SELECT COUNT(*) FROM pontos WHERE escolha_bloqueada_em IS NOT NULL) AS pontosocupados,
        -- Ponto instalado que mudou de endereço pela mão do dono (estação de
        -- endereços, 01/10/2026): a operação confere se a tela continua lá.
        (SELECT COUNT(*) FROM pendencias WHERE tipo = 'ENDERECO_PONTO_ALTERADO' AND resolvido_em IS NULL) AS enderecosaconferir`,
    ),
    pool.query(`SELECT status, COUNT(*)::int AS qtd FROM pontos WHERE status <> 'arquivado' GROUP BY status`),
    // Separa quem paga de quem está em cortesia. Sem isso o resumo dizia
    // "5 anunciantes ativos" com três liberados de graça — e a leitura do
    // negócio saía errada justamente no número que mais importa.
    // `status` não diz mais isso (virou só comum/parceiro, 16/09/2026) —
    // "situação" é calculada de `suspenso` + `plano_id` + `data_expiracao`.
    pool.query(`SELECT
                  CASE
                    WHEN suspenso THEN 'suspenso'
                    WHEN plano_id IS NOT NULL AND ${vigencia.vigenteSql('data_expiracao')} THEN 'ativo'
                    ELSE 'sem_plano'
                  END AS situacao,
                  plano_cortesia, COUNT(*)::int AS qtd
                FROM anunciantes WHERE excluido_em IS NULL
                GROUP BY situacao, plano_cortesia`),
    // Telas COM PROBLEMA (evidência de erro) e SEM COMUNICAÇÃO, separadas —
    // sem comunicação não é falha (src/lib/status-tela.js, Rede Front V3).
    dispositivosRepo.telasComAtencao(),
    pool.query(
      // Receita LÍQUIDA de estornos confirmados pelo PSP (migration 120): o
      // dinheiro que voltou não é receita, e sai do mês em que a Asaas
      // confirmou a devolução (a mesma régua de src/admin/metrica.js).
      // Cancelamento não mexe aqui.
      `SELECT to_char(mes, 'YYYY-MM') AS mes, SUM(total)::numeric AS total FROM (
         SELECT date_trunc('month', criado_em) AS mes, valor AS total
           FROM cobrancas_confirmadas WHERE criado_em > now() - interval '6 months'
         UNION ALL
         SELECT date_trunc('month', confirmado_em), -valor_confirmado
           FROM estornos WHERE status = 'confirmado' AND confirmado_em > now() - interval '6 months'
       ) lancamentos
       GROUP BY 1 ORDER BY 1`,
    ),
    pool.query(
      `SELECT COALESCE(SUM(vezes_confirmadas), 0)::int AS confirmadas,
              COALESCE(SUM(vezes_programadas), 0)::int AS programadas
       FROM exibicoes_contador WHERE janela_hora > now() - interval '30 days'`,
    ),
    // Sem a conta própria (mesma régua da conversão logo abaixo): ela nasce
    // com a migration, então num banco recém-migrado aparecia como "1 conta
    // nova" sem ninguém ter se cadastrado (achado no polimento final).
    pool.query(
      `SELECT
        (SELECT COUNT(*) FROM anunciantes
          WHERE created_at > now() - interval '30 days' AND excluido_em IS NULL AND NOT conta_propria) AS anunciantes,
        (SELECT COUNT(*) FROM pontos WHERE created_at > now() - interval '30 days' AND status <> 'arquivado') AS pontos`,
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
             AND excluido_em IS NULL AND ${vigencia.vigenteSql('data_expiracao')}) AS pagantes`,
    ),
    // Bloco financeiro da Visão geral (rodada Financeiro, 22/09/2026):
    // "normalidade não ocupa espaço, pendência aparece". Repasses de ponto
    // SAÍRAM em 24/09/2026 (ADR-016) — ponto gera créditos, não recebe
    // dinheiro; sobram trocas de plano e devoluções.
    pool.query(
      `SELECT COUNT(*)::int AS qtd, COALESCE(SUM(valor), 0) AS total FROM pedidos_avulsos WHERE status = 'pendente'`,
    ),
    // Entre "Aprovado" e "No ar" (27/09/2026): peças esperando a primeira
    // exibição confirmada e as que passaram do prazo — o mesmo estado que o
    // cliente vê (src/anunciantes/entrada-no-ar.js).
    // Falhar aqui não derruba a Visão geral: o indicador mostra "—".
    filaEntrada
      .pecasSemPrimeiraExibicao()
      .then(filaEntrada.contarEntrada)
      .catch((err) => {
        console.error('falha ao contar a entrada no ar', err.message);
        return { aguardando: null, atrasados: null };
      }),
  ]);

  const ultima = await ultimaConciliacao();
  const receitaPorCiclo = agregarReceitaPorCiclo(receita.rows);
  const receitaMensal = Object.values(receitaPorCiclo).reduce((soma, v) => soma + v, 0);
  const custosFixosMensal = Number(custosFixos.rows[0].total);
  const totalContas = Number(conversao.rows[0].total);
  const contasPagantes = Number(conversao.rows[0].pagantes);
  const percentualPagantes = totalContas > 0 ? (contasPagantes / totalContas) * 100 : null;

  // Pendências financeiras (revisão final da Visão geral, 23/09/2026,
  // seção 3/4 do pedido): troca de plano com problema +
  // devolução pendente viram UM card agregado ("Financeiro / N · R$ X"),
  // não mais três cards separados. Comissão de vendedor SAIU da conta — o
  // conceito de vendedor não é mais parte do pedido; a tabela/rota
  // `comissoes` continua existindo dentro de Contas, só não soma mais aqui.
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
      // `offline` (nome antigo, mesma chave para a Visão geral) = telas COM
      // PROBLEMA real; sem comunicação vem à parte, como aviso.
      offline: telasAtencao.comProblema.length,
      telasComProblema: telasAtencao.comProblema.length,
      telasSemComunicacao: telasAtencao.semComunicacao.length,
      bancohoras: Number(filas.rows[0].bancohoras),
      pontosocupados: Number(filas.rows[0].pontosocupados),
      enderecosaconferir: Number(filas.rows[0].enderecosaconferir),
      entradaAguardando: entradaNoAr.aguardando,
      entradaAtrasada: entradaNoAr.atrasados,
    },
    financeiro: {
      receitaMensal,
      receitaPorCiclo,
      custosFixosMensal,
      margemMensal: receitaMensal - custosFixosMensal,
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
      trocasPendentes: trocasPendentesInfo,
      devolucoesPendentes: devolucoesPendentesInfo,
      // O card único da Visão geral (seção 3/4) — soma das duas acima.
      // Detalhe de cada um mora na Central Financeira (`#financeiro`), aba a
      // aba, não aqui.
      pendenciasFinanceiras: {
        qtd: trocasPendentesInfo.qtd + devolucoesPendentesInfo.qtd,
        total: trocasPendentesInfo.total + devolucoesPendentesInfo.total,
      },
    },
    rede: {
      pontosAtivos: Number(pontosAtivos.rows[0].qtd),
      telasAtivas: telasAtivas.rows[0].telas,
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

// Lista da Visão geral: "Anúncios aguardando primeira exibição" e "Anúncios
// atrasados" levam pra cá — peça, conta, janela prevista e prazo.
router.get('/admin/criativos/entrada', async (_req, res) => {
  res.json(await filaEntrada.pecasSemPrimeiraExibicao());
});

// "Pedir atualização às telas": o mesmo sinal de playlist desatualizada que
// a aprovação já manda, só pras telas da cobertura desta peça. Nunca
// reinicia o Player.
router.post('/admin/criativos/:id/atualizar-telas', async (req, res) => {
  if (!/^\d{1,10}$/.test(req.params.id)) return res.status(400).json({ erro: 'criativo inválido' });
  const r = await filaEntrada.pedirAtualizacaoDasTelas(Number(req.params.id));
  if (!r) return res.status(404).json({ erro: 'criativo não encontrado' });
  res.json(r);
});

// Custos fixos: a tela saiu na rodada Financeiro (22/09/2026 — a Mostraí não
// vira sistema contábil) e o CRUD saiu do código na consolidação final
// (24/09/2026). A tabela `custos_fixos` continua no banco e o resumo continua
// somando o que há nela (`custosFixosMensal`), só não há mais porta pra editar.
const CUSTOS_APOSENTADOS = { erro: 'custos fixos saíram do admin (22/09/2026) — não há mais cadastro aqui' };
router.get('/admin/custos-fixos', (_req, res) => res.status(410).json(CUSTOS_APOSENTADOS));
router.post('/admin/custos-fixos', (_req, res) => res.status(410).json(CUSTOS_APOSENTADOS));
router.patch('/admin/custos-fixos/:id', (_req, res) => res.status(410).json(CUSTOS_APOSENTADOS));
router.delete('/admin/custos-fixos/:id', (_req, res) => res.status(410).json(CUSTOS_APOSENTADOS));

// Anexado no próprio router (não num export nomeado): server.js espera
// `require('./admin/routes')` como o router pronto, sem quebrar isso só
// pra dar um gancho de teste pra uma função pura.
router.agregarReceitaPorCiclo = agregarReceitaPorCiclo;

module.exports = router;
