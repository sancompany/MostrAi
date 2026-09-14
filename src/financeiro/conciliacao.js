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

async function conciliarAssinaturas() {
  const { rows: assinaturas } = await pool.query(
    `SELECT s.id, s.anunciante_id, s.plano_id, a.cpf_cnpj
       FROM assinaturas s
       JOIN anunciantes a ON a.id = s.anunciante_id
      WHERE s.status = 'ativa' AND a.excluido_em IS NULL`
  );

  const relato = { verificadas: 0, aplicadas: 0, jaProcessadas: 0, semCobranca: 0, falhas: [] };

  for (const assinatura of assinaturas) {
    relato.verificadas += 1;
    try {
      const estado = await consultarAssinatura(assinatura.id, assinatura.cpf_cnpj);
      const ultima = estado && estado.ultimaCobranca;
      if (!ultima || ultima.status !== 'confirmado' || !ultima.chargeId) {
        relato.semCobranca += 1;
        continue;
      }

      // A chave é a mesma que o webhook usaria. Se já está gravada, o webhook
      // chegou e fez o trabalho — não há nada a fazer.
      const chave = `${ultima.chargeId}|${ultima.status}`;
      const { rowCount } = await pool.query(
        'INSERT INTO webhooks_processados (id) VALUES ($1) ON CONFLICT DO NOTHING',
        [chave]
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

  return relato;
}

module.exports = { conciliarAssinaturas };
