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
const { consultarAssinatura, aplicarCicloPago } = require('./san-checkout');
const { enviarCoberturaAcabando } = require('./email');

async function conciliarAssinaturas() {
  const comecouEm = new Date();
  const { rows: assinaturas } = await pool.query(
    `SELECT s.id, s.anunciante_id, s.plano_id, a.cpf_cnpj
       FROM assinaturas s
       JOIN anunciantes a ON a.id = s.anunciante_id
      WHERE s.status = 'ativa' AND a.excluido_em IS NULL`,
  );

  const relato = { verificadas: 0, aplicadas: 0, jaProcessadas: 0, semCobranca: 0, falhas: [] };

  for (const assinatura of assinaturas) {
    relato.verificadas += 1;
    try {
      const estado = await consultarAssinatura(assinatura.id, assinatura.cpf_cnpj);
      const ultima = estado?.ultimaCobranca;
      if (ultima?.status !== 'confirmado' || !ultima.chargeId) {
        relato.semCobranca += 1;
        continue;
      }

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
  relato.expiradas = await suspenderCoberturaVencida();
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
// Suspende, nao exclui: `suspenso` e reversivel, mantem o historico. Desde
// 16/09/2026 e um campo proprio, separado de `status` (que virou so
// comum/parceiro). Conta em cortesia entra na regra igual — cortesia tambem
// tem prazo.
async function suspenderCoberturaVencida() {
  const { rows } = await pool.query(`
    UPDATE anunciantes
       SET suspenso = true
     WHERE NOT suspenso
       AND excluido_em IS NULL
       AND data_expiracao IS NOT NULL
       AND data_expiracao < current_date
    RETURNING id, nome_empresa, data_expiracao`);
  return rows;
}

module.exports = {
  conciliarAssinaturas,
  suspenderCoberturaVencida,
  avisarCoberturaAcabando,
  registrarRelato,
  ultimaConciliacao,
};
