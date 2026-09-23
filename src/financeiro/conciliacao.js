// Conciliação diária de assinaturas.
//
// Por que existe: o webhook do San Checkout pode simplesmente não chegar. A
// fila de retry dele é em memória do processo — se o processo reiniciar entre
// as tentativas, o aviso se perde, e o dinheiro continua dentro (API.md do
// Checkout, 4.3.6). O contrato é explícito: "a conciliação não é opcional
// para quem leva dinheiro a sério: rode uma vez por dia".
//
// Sem isso, o desfecho é um cliente que pagou e ficou sem cobertura, e a
// única forma de descobrir é ele reclamar.
//
// A varredura passa pela MESMA dedupe do webhook (`webhooks_processados`,
// chaveada por chargeId), então um ciclo nunca entra duas vezes — não importa
// se o aviso veio pelo webhook, por aqui, ou pelos dois.
const pool = require('../db/pool');
const { consultarAssinatura, aplicarCicloPago, linkRenovarAssinatura } = require('./san-checkout');
const planoAdministrativo = require('./plano-administrativo');
const { enviarCoberturaAcabando, enviarCobrancaFalhou } = require('./email');
const anunciantesRepo = require('../anunciantes/repository');
const assinaturasRepo = require('./assinaturas-repository');
const eventos = require('../lib/eventos');

// A resposta de `consultar-assinatura` tem DUAS METADES, e até 17/09/2026 a
// conciliação lia só uma (API.md 5.3 do Checkout):
//
//   `status`          -> o VÍNCULO existe? (ativa | pausada | cancelada)
//   `ultimaCobranca`  -> o último CICLO entrou?
//
// Ler só `ultimaCobranca` deixava dois buracos, os dois de dinheiro:
//
// 1. ASSINATURA ENCERRADA FORA DO NOSSO FLUXO nunca chegava. Cancelada no
//    painel da Asaas, ou morta por ela depois de falhas seguidas, não gera
//    aviso nenhum — o Checkout MEDIU isso em 16/09: zero eventos
//    `SUBSCRIPTION_*` entre os 53 configurados na Asaas. Esta rota é o ÚNICO
//    caminho pelo qual isso chega até nós, e a gente jogava fora a metade que
//    trazia. Resultado: o anunciante seguia `ativa` aqui e rodando anúncio de
//    graça, pra sempre, sem nada acusar.
// 2. CICLO QUE FALHOU sem o webhook `cobranca_falhou` ter chegado. Esse aviso
//    é justamente o que se perde (fila de retry em memória, reinício do
//    processo), e sem ele o anunciante nunca soube que precisa trocar o
//    cartão — a cobertura simplesmente vence.
//
// `pausada` não tem estado local (a tabela só aceita `ativa`/`cancelada`) e o
// Mostraí nunca pausa nada, então ela só vira evento, sem mexer no registro.
// Se um dia pausar virar fluxo de verdade, aí sim vale a coluna.
const COBRANCA_FALHOU = new Set(['vencido', 'recusado']);

// A decisão sai daqui, pura, sem banco: é caminho de dinheiro, e o teste dela
// não pode depender de subir Postgres (mesmo padrão de
// `src/lib/limite-tentativas.js`). O laço abaixo só executa o que ela decide.
function decidirPorEstado(estado) {
  if (!estado) return { acao: 'sem_resposta' };
  // O vínculo vem primeiro: assinatura encerrada não tem ciclo a aplicar,
  // por mais confirmada que esteja a última cobrança dela.
  if (estado.status && estado.status !== 'ativa') {
    return { acao: 'vinculo_encerrado', status: estado.status, cancelar: estado.status === 'cancelada' };
  }
  const ultima = estado.ultimaCobranca;
  if (ultima?.status === 'confirmado' && ultima.chargeId) return { acao: 'aplicar_ciclo', ultima };
  if (ultima?.chargeId && COBRANCA_FALHOU.has(ultima.status)) return { acao: 'avisar_renovacao', ultima };
  return { acao: 'nada' };
}

// Manda o link de renovação pra quem tem o vínculo vivo e o último ciclo
// falhado. Deduplicado pelo MESMO `webhooks_processados` do resto, com
// prefixo próprio: sem isso o anunciante receberia o mesmo e-mail todo dia
// até trocar o cartão, que é a melhor forma de ensinar alguém a ignorar os
// nossos e-mails. Uma vez por cobrança falhada, e pronto.
async function avisarRenovacao(assinatura, ultima) {
  const { rowCount } = await pool.query('INSERT INTO webhooks_processados (id) VALUES ($1) ON CONFLICT DO NOTHING', [
    `renovacao|${ultima.chargeId}`,
  ]);
  if (!rowCount) return false;

  const anunciante = await anunciantesRepo.buscarPorId(assinatura.anunciante_id);
  if (!anunciante) return false;
  // `null` quando não dá pra assinar o token: o e-mail sai sem link, pedindo
  // contato. Link sem token válido cria uma SEGUNDA assinatura na Asaas sem
  // cancelar a primeira (API.md 7.3) — cobrança dobrada, calada.
  const link = linkRenovarAssinatura(assinatura.id, anunciante.cpf_cnpj);
  await enviarCobrancaFalhou(anunciante, link).catch((err) =>
    console.error('e-mail de renovação pela conciliação', err),
  );
  eventos.registrar('assinatura:renovacao_avisada', {
    anunciante_id: assinatura.anunciante_id,
    assinatura_id: assinatura.id,
    cobranca: ultima.status,
    com_link: !!link,
    origem: 'conciliacao',
  });
  return true;
}

async function conciliarAssinaturas() {
  const comecouEm = new Date();
  const { rows: assinaturas } = await pool.query(
    `SELECT s.id, s.anunciante_id, s.plano_id, a.cpf_cnpj
       FROM assinaturas s
       JOIN anunciantes a ON a.id = s.anunciante_id
      WHERE s.status = 'ativa' AND a.excluido_em IS NULL`,
  );

  const relato = {
    verificadas: 0,
    aplicadas: 0,
    jaProcessadas: 0,
    semCobranca: 0,
    canceladasFora: 0,
    renovacoesAvisadas: 0,
    falhas: [],
  };

  for (const assinatura of assinaturas) {
    relato.verificadas += 1;
    try {
      const decisao = decidirPorEstado(await consultarAssinatura(assinatura.id, assinatura.cpf_cnpj));

      if (decisao.acao === 'vinculo_encerrado') {
        if (decisao.cancelar) {
          await assinaturasRepo.marcarCancelada(assinatura.id);
          relato.canceladasFora += 1;
        }
        eventos.registrar(`assinatura:${decisao.status}_fora_do_fluxo`, {
          anunciante_id: assinatura.anunciante_id,
          assinatura_id: assinatura.id,
          // Cobertura já paga continua valendo até `data_expiracao` — quem
          // encerra é `encerrarCoberturaVencida`, igual ao webhook `cancelada`.
          // Cancelar no ato tiraria do ar quem pagou o ciclo corrente.
          nota: 'descoberto pela conciliação; a Asaas não avisa por evento',
        });
        continue;
      }

      if (decisao.acao !== 'aplicar_ciclo') {
        if (decisao.acao === 'avisar_renovacao') {
          relato.renovacoesAvisadas += (await avisarRenovacao(assinatura, decisao.ultima)) ? 1 : 0;
        }
        relato.semCobranca += 1;
        continue;
      }
      const ultima = decisao.ultima;

      // A chave é a mesma que o webhook usaria. Se já está gravada, o webhook
      // chegou e fez o trabalho — não há nada a fazer.
      const chave = `${ultima.chargeId}|${ultima.status}`;
      const { rowCount } = await pool.query(
        'INSERT INTO webhooks_processados (id) VALUES ($1) ON CONFLICT DO NOTHING',
        [chave],
      );
      if (!rowCount) {
        relato.jaProcessadas += 1;
        continue;
      }

      await aplicarCicloPago(assinatura, chave);
      relato.aplicadas += 1;
    } catch (err) {
      relato.falhas.push({ assinaturaId: assinatura.id, erro: err.message });
    }
  }

  relato.avisados = await avisarCoberturaAcabando();
  relato.expiradas = await encerrarCoberturaVencida();
  await registrarRelato(comecouEm, relato);
  return relato;
}

// O relato existia só no stdout do processo: ninguém sabia se a conciliação
// rodou hoje, o que ela aplicou e o que falhou. Guardado aqui, vira a linha
// que o admin mostra na Visão geral — e a resposta pra "o cron está de pé?".
// Falha ao gravar o relato não pode derrubar a conciliação: o trabalho dela
// (pôr no ar quem pagou) já foi feito quando chegamos nesta linha.
async function registrarRelato(comecouEm, relato, abortou = null) {
  try {
    await pool.query(
      `INSERT INTO conciliacoes
         (comecou_em, verificadas, aplicadas, ja_processadas, sem_cobranca, expiradas, avisados, falhas, abortou)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        comecouEm,
        relato.verificadas || 0,
        relato.aplicadas || 0,
        relato.jaProcessadas || 0,
        relato.semCobranca || 0,
        (relato.expiradas || []).length,
        (relato.avisados || []).length,
        JSON.stringify(relato.falhas || []),
        abortou,
      ],
    );
  } catch (err) {
    console.error('falha ao gravar o relato da conciliação', err);
  }
}

// Última execução, pra Visão geral do admin.
async function ultimaConciliacao() {
  const { rows } = await pool.query('SELECT * FROM conciliacoes ORDER BY id DESC LIMIT 1');
  return rows[0] || null;
}

// Aviso de cobertura acabando, para quem NÃO tem recorrência (seção F, item
// 16). Quem trocou de plano pagou um pedido avulso: a cobertura vale pelo
// período e some sozinha, porque não há próxima cobrança pra acontecer.
// Quem tem assinatura ativa não entra aqui — pra esse o motor cobra de novo
// sozinho, e se a cobrança falhar quem avisa é `enviarCobrancaFalhou`.
//
// Roda junto da conciliação porque a pergunta é a mesma ("o que vence nos
// próximos dias") e o cron já existe, uma vez por dia. Falha de e-mail não
// derruba a conciliação: o aviso só é marcado como dado depois do envio, e
// no dia seguinte a varredura tenta de novo enquanto a janela durar.
const DIAS_DE_AVISO = 7;

async function avisarCoberturaAcabando() {
  const { rows } = await pool.query(
    `SELECT a.id, a.nome_empresa, a.contato_email, a.data_expiracao,
            p.nome AS plano_nome, p.compromisso_meses
       FROM anunciantes a
       JOIN planos p ON p.id = a.plano_id
      WHERE a.excluido_em IS NULL
        AND NOT a.suspenso
        AND NOT a.plano_cortesia
        AND a.contato_email IS NOT NULL
        AND a.data_expiracao IS NOT NULL
        AND a.data_expiracao >= now()
        AND a.data_expiracao < now() + ($1 || ' days')::interval
        AND a.aviso_fim_cobertura_para IS DISTINCT FROM a.data_expiracao
        AND NOT EXISTS (
          SELECT 1 FROM assinaturas s
           WHERE s.anunciante_id = a.id AND s.status = 'ativa'
        )`,
    [String(DIAS_DE_AVISO)],
  );

  const avisados = [];
  for (const conta of rows) {
    const dias = Math.ceil((new Date(conta.data_expiracao) - Date.now()) / 86400000);
    try {
      await enviarCoberturaAcabando(
        conta,
        { nome: conta.plano_nome, compromisso_meses: conta.compromisso_meses },
        dias,
      );
      // Só depois do envio: marcar antes transformaria uma falha de SMTP em
      // aviso que nunca sai.
      await pool.query('UPDATE anunciantes SET aviso_fim_cobertura_para = $2 WHERE id = $1', [
        conta.id,
        conta.data_expiracao,
      ]);
      avisados.push({ id: conta.id, nome_empresa: conta.nome_empresa, dias });
    } catch (err) {
      console.error(`falha ao avisar fim de cobertura da conta ${conta.id}:`, err.message);
    }
  }
  return avisados;
}

// Nada expirava a cobertura. Uma conta cujo `data_expiracao` passou continuava
// contando como ativa pra sempre: aparecia assim no admin, no painel da
// propria pessoa e — ate 15/09 — dentro da receita recorrente. A playlist ja
// filtrava por data, entao o anuncio parava de rodar; o que nao parava era o
// sistema dizer que estava tudo certo.
//
// Até 23/09/2026 isso SUSPENDIA a conta (`suspenso = true`) — mas suspensão
// passou a ser só do admin, nunca automática (pedido do dono, resposta
// direta à reconstrução de Contas: "o plano é cancelado automaticamente").
// Agora esta rotina ENCERRA o plano comercial — mesma ação do botão
// "Cancelar plano" da ficha (`plano-administrativo.js#encerrar`, reusado,
// não duplicado) — sem tocar `suspenso`. Conta em cortesia entra na regra
// igual — cortesia também tem prazo. O comodato (campo próprio desde a
// migration 077) nunca é afetado: nunca esteve em `plano_id`.
async function encerrarCoberturaVencida() {
  const { rows } = await pool.query(`
    SELECT id, nome_empresa, data_expiracao FROM anunciantes
     WHERE plano_id IS NOT NULL
       AND excluido_em IS NULL
       AND data_expiracao IS NOT NULL
       AND data_expiracao < current_date`);
  for (const conta of rows) {
    await planoAdministrativo.encerrar({ conta, motivo: 'vencido' });
  }
  return rows;
}

module.exports = {
  conciliarAssinaturas,
  decidirPorEstado,
  encerrarCoberturaVencida,
  avisarCoberturaAcabando,
  registrarRelato,
  ultimaConciliacao,
};
