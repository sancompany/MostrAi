const pool = require('../db/pool');

// TROCA DE MODALIDADE DO COMODATO (decisão do dono, 17/09/2026).
//
// Quem cede a parede escolhe entre receber R$ 50 por mês ou trocar esses
// R$ 50 por tela. A troca tem MÃO ÚNICA no autoatendimento:
//
//   receber R$ 50  ->  trocar por tela   o dono do ponto faz quando quiser
//   trocar por tela ->  receber R$ 50    só o admin faz
//
// A assimetria não é capricho. Abrir mão do dinheiro não custa nada à
// Mostraí — ela para de pagar e o comerciante ganha mais tela, então pode ser
// imediato e sem pedir licença. Voltar a receber é despesa nova, recorrente,
// e entra no caixa do mês: passa pela mão do dono. Sem essa trava, dava pra
// pingar entre as duas modalidades todo mês e sacar a ajuda de custo nos
// meses em que ela valesse mais, o que ninguém concilia.
//
// Tudo aqui roda na MESMA transação de quem chamou: modalidade trocada e
// contrapartida ajustada são um ato só. Metade aplicada é um comerciante
// que deixou de receber R$ 50 e não ganhou a tela.
//
// COMODATO É SEPARADO DE PLANO COMERCIAL (23/09/2026, decisão do dono e do
// GPT — migration 076). Até aqui, `sincronizarComodato` escrevia no MESMO
// campo que o plano pago/cortesia (`anunciantes.plano_id`), com uma guarda
// pra nunca sobrescrever assinatura ativa — e por isso mesmo, quando a
// assinatura ESTAVA ativa, o comodato simplesmente não era gravado em lugar
// nenhum: cancelar o plano pago "descobria" o campo e não havia nada pra
// aparecer no lugar. Agora comodato mora em `anunciantes.comodato_plano_id`,
// SEMPRE espelhando a modalidade viva do(s) ponto(s) da conta, nunca tocado
// por nenhum fluxo de plano comercial (assinatura, cortesia administrativa,
// bônus). Básico coexiste com qualquer plano comercial. Inicial não —
// `bloqueiaPlanoComercial`, abaixo, é a régua que os fluxos de plano
// comercial consultam antes de conceder ou vender.

// O crédito e o comodato valem o MELHOR entre os pontos da conta, nunca a
// soma — dono de três pontos tem UM crédito de R$ 50 (não R$ 150) e UM
// comodato (o melhor dos três, não os três empilhados). Recalcular a partir
// dos pontos (em vez de somar ou subtrair no lugar) é o que faz a troca
// funcionar nos dois sentidos sem deixar resto: quem volta pra ajuda de
// custo perde o crédito e o comodato de nível melhor no mesmo cálculo que
// os deu. `ordem` em `planos_ponto` já expressa "melhor" (mais-cota > ajuda-
// custo) — mesmo critério que a migração de dados usou.
async function sincronizarComodato(contaId, db = pool) {
  await db.query(
    `UPDATE anunciantes a
        SET credito_comodato_mensal = COALESCE((
              SELECT MAX(pp.desconto_assinatura_reais)
                FROM pontos p
                JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
               WHERE p.anunciante_id = a.id
            ), 0),
            comodato_plano_id = (
              SELECT pp.plano_incluido_id
                FROM pontos p
                JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
               WHERE p.anunciante_id = a.id AND pp.plano_incluido_id IS NOT NULL
               ORDER BY pp.ordem DESC
               LIMIT 1
            )
      WHERE a.id = $1`,
    [contaId],
  );
}

// Aplica uma modalidade a UM ponto e acerta a conta do dono dele.
//
// Trava simétrica à de `bloqueiaPlanoComercial` (achado real, revisão de
// 23/09/2026): aquela impede CONCEDER/VENDER plano comercial pra quem está
// no Inicial; esta impede o caminho contrário — o admin trocar a modalidade
// PRA Inicial (`permite_assinar = false`) de uma conta que já tem plano
// comercial vigente (`anunciantes.plano_id`). Sem ela, o único lugar que
// ainda deixava "Inicial + plano comercial" coexistir era este — o
// autoatendimento (`POST /anunciantes/me/comodato/trocar-por-tela`) só anda
// no sentido oposto (ajuda de custo → Básico), então esta trava só morde a
// troca manual do admin.
async function aplicarModalidade(pontoId, opcaoId, db = pool) {
  const { rows: pts } = await db.query('SELECT id, anunciante_id FROM pontos WHERE id = $1', [pontoId]);
  const ponto = pts[0];
  if (!ponto) return null;

  const { rows: ops } = await db.query('SELECT * FROM planos_ponto WHERE id = $1', [opcaoId]);
  const opcao = ops[0];
  if (!opcao) return null;

  if (!opcao.permite_assinar && ponto.anunciante_id) {
    const { rows: contas } = await db.query('SELECT plano_id FROM anunciantes WHERE id = $1', [ponto.anunciante_id]);
    if (contas[0]?.plano_id) {
      throw Object.assign(
        new Error(
          'esta conta tem plano comercial vigente — encerre ou cancele o plano antes de trocar pra uma modalidade que não acumula com ele',
        ),
        { status: 409 },
      );
    }
  }

  await db.query(
    `UPDATE pontos
        SET plano_ponto_id = $2, valor_pago_mensal = $3, cota_autoanuncio_slots_hora = $4
      WHERE id = $1`,
    [ponto.id, opcao.id, opcao.ajuda_custo_mensal, opcao.cota_slots_hora],
  );

  if (ponto.anunciante_id) await sincronizarComodato(ponto.anunciante_id, db);
  return opcao;
}

// A modalidade que o dono do ponto pode escolher sozinho: a que NÃO paga
// dinheiro. Descoberta por dado (`ajuda_custo_mensal = 0`), não por id fixo —
// se o dono renomear ou recriar as opções no admin, isto continua certo.
async function modalidadeSemDinheiro(db = pool) {
  const { rows } = await db.query(
    'SELECT * FROM planos_ponto WHERE ativo AND ajuda_custo_mensal = 0 ORDER BY ordem, id LIMIT 1',
  );
  return rows[0] || null;
}

// A TRAVA DO COMODATO (migration 049, desenho do dono de 17/09/2026;
// centralizada aqui em 23/09/2026 — antes só vivia dentro de POST
// /anunciantes/:id/assinar, e por isso só valia pra quem COMPRAVA um plano;
// concessão administrativa e créditos automáticos passavam batido pela mesma
// regra). `permite_assinar` já existe em `planos_ponto` com exatamente esta
// régua desde a migration 049: falso pra "ajuda-custo" (Inicial), true pra
// "mais-cota" (Básico) — não é reinventada aqui, só passa a valer em todo
// lugar que concede ou vende plano comercial, não só na compra direta.
//
// Verdadeiro só quando NENHUM ponto da conta permite (dono de pontos em
// modalidades diferentes fica liberado se pelo menos um permitir — mesma
// leitura que já valia dentro de /assinar).
async function bloqueiaPlanoComercial(contaId, db = pool) {
  const { rows } = await db.query(
    `SELECT DISTINCT pp.permite_assinar
       FROM pontos p JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
      WHERE p.anunciante_id = $1`,
    [contaId],
  );
  return rows.length > 0 && rows.every((r) => r.permite_assinar === false);
}

module.exports = { aplicarModalidade, sincronizarComodato, modalidadeSemDinheiro, bloqueiaPlanoComercial };
