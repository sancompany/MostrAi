const pool = require('../db/pool');
const dispositivosRepo = require('../dispositivos/repository');

// Chamada quando uma tela ou um ponto vira 'ativo'. Quem já pagou e estava
// em 'aguardando_ponto' passa a 'ativo' assim que a rede tiver ao menos o
// mínimo de telas que o plano dele promete (migration 019:
// planos.minimo_telas_ativas). O webhook guardou os meses pagos em
// meses_cobertura_pendentes; aqui eles viram data de expiração. Conta em
// 'aguardando_ponto' sem mês pendente (status mudado à mão) não ganha nada.
async function ativarCoberturaDosAnunciantes() {
  const telasAtivas = await dispositivosRepo.contarAtivas();
  await pool.query(
    `UPDATE anunciantes a
     SET status = 'ativo',
         data_inicio_cobertura = COALESCE(a.data_inicio_cobertura, now()),
         data_expiracao = GREATEST(COALESCE(a.data_expiracao, now()), now())
                          + (a.meses_cobertura_pendentes || ' months')::interval,
         meses_cobertura_pendentes = 0
     FROM planos p
     WHERE a.plano_id = p.id AND a.status = 'aguardando_ponto'
       AND a.meses_cobertura_pendentes > 0
       AND GREATEST(1, p.minimo_telas_ativas) <= $1`,
    [telasAtivas]
  );
}

module.exports = { ativarCoberturaDosAnunciantes };
