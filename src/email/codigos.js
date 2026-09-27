const crypto = require('node:crypto');
const pool = require('../db/pool');
const cofre = require('../lib/cofre');
const outbox = require('./outbox');

// Código de verificação de e-mail (migration 097, tabela codigos_email).
//
//   cadastro — confirma que o e-mail de login digitado no cadastro é de
//              verdade (ele é o login e o único canal de recuperação);
//   troca    — confirma o endereço NOVO numa troca pedida por conta já
//              confirmada; só vira login depois do código.
//
// O SERVIDOR é a fonte da verdade do prazo: o código vale VALIDADE_MIN a
// partir de quando foi gerado, e a tela só mostra `expiraEm` que vem daqui —
// recarregar a página não reinicia nada. Validade de 10 minutos (era 2):
// cobre o atraso normal de entrega do Gmail/Outlook e a pessoa trocar de app
// pra abrir a caixa, e com 5 palpites por código (MAX_ERROS) a chance de
// adivinhar continua 5 em 1 milhão — o prazo maior não afrouxa a segurança.
//
// O código em si NUNCA é gravado nem logado: aqui só o HMAC (cofre.assinar,
// chave do servidor); na fila de saída, cifrado e apagado assim que o e-mail
// sai (outbox.js). A resposta das rotas nunca traz o código.

const VALIDADE_MIN = 10;
// Reenviar: 60 s entre um código e outro, e no máximo 5 códigos por hora por
// conta (somando cadastro e troca) — sem isso o botão vira um canhão de SMTP.
const INTERVALO_REENVIO_S = 60;
const MAX_POR_HORA = 5;
// Código errado 5 vezes morre (além do limite por IP da rota): palpites
// espalhados por vários IPs não passam de 5.
const MAX_ERROS = 5;

const TIPO = { cadastro: 'codigo_confirmacao', troca: 'codigo_troca_email' };

const hashDoCodigo = (contaId, finalidade, codigo) =>
  cofre.assinar(`${contaId}:${finalidade}:${codigo}`, 'codigo-email');

function erro(status, mensagem, extra = {}) {
  return Object.assign(new Error(mensagem), { status, ...extra });
}

// Quantos códigos esta conta já pediu na última hora (conta pela fila de
// saída, que é o histórico de envios).
async function enviadosNaUltimaHora(contaId, db = pool) {
  const {
    rows: [{ n }],
  } = await db.query(
    `SELECT COUNT(*)::int AS n FROM email_outbox
      WHERE anunciante_id = $1 AND tipo IN ('codigo_confirmacao', 'codigo_troca_email')
        AND criado_em > now() - interval '1 hour'`,
    [contaId],
  );
  return n;
}

// Gera um código NOVO (o anterior da mesma finalidade deixa de valer na
// hora — é a mesma linha, sobrescrita) e põe o e-mail na fila, na MESMA
// transação: nunca existe código sem e-mail nem e-mail com código que não
// vale. `respeitarIntervalo: false` só para o primeiro código de um endereço
// (cadastro, correção de e-mail) — o teto por hora vale sempre.
//
// Erros com `status` (429) são pra devolver à tela; o resto sobe.
async function emitir(conta, { finalidade = 'cadastro', email = conta.contato_email, respeitarIntervalo = true } = {}) {
  if (!TIPO[finalidade]) throw new Error(`finalidade de código desconhecida: ${finalidade}`);
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiraEm = new Date(Date.now() + VALIDADE_MIN * 60 * 1000);

  const cliente = await pool.connect();
  let linha;
  try {
    await cliente.query('BEGIN');
    // Trava a conta: dois "Reenviar" simultâneos não passam os dois pelo
    // teto nem geram dois códigos.
    await cliente.query('SELECT id FROM anunciantes WHERE id = $1 FOR UPDATE', [conta.id]);
    if ((await enviadosNaUltimaHora(conta.id, cliente)) >= MAX_POR_HORA) {
      throw erro(429, 'muitos códigos pedidos na última hora — espere um pouco e tente de novo');
    }
    const { rows } = await cliente.query(
      `INSERT INTO codigos_email (anunciante_id, finalidade, email, codigo_hash, expira_em)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (anunciante_id, finalidade) DO UPDATE
          SET email = EXCLUDED.email, codigo_hash = EXCLUDED.codigo_hash, expira_em = EXCLUDED.expira_em,
              tentativas = 0, criado_em = now()
        WHERE NOT $6::boolean OR codigos_email.criado_em < now() - make_interval(secs => $7)
       RETURNING id, criado_em, expira_em`,
      [
        conta.id,
        finalidade,
        email,
        hashDoCodigo(conta.id, finalidade, codigo),
        expiraEm,
        respeitarIntervalo,
        INTERVALO_REENVIO_S,
      ],
    );
    if (!rows[0]) {
      const { rows: atual } = await cliente.query(
        'SELECT criado_em FROM codigos_email WHERE anunciante_id = $1 AND finalidade = $2',
        [conta.id, finalidade],
      );
      throw erro(429, 'espere um pouco antes de pedir outro código', {
        podeReenviarEm: new Date(new Date(atual[0].criado_em).getTime() + INTERVALO_REENVIO_S * 1000),
      });
    }
    linha = rows[0];
    await outbox.enfileirar(
      {
        tipo: TIPO[finalidade],
        // Cada código é um evento próprio (o reenvio é um código NOVO).
        chave: `${TIPO[finalidade]}:${conta.id}:${crypto.randomUUID()}`,
        para: email,
        anuncianteId: conta.id,
        dados: { conta: { nome_empresa: conta.nome_empresa }, validadeMinutos: VALIDADE_MIN },
        segredo: { codigo },
        validoAte: linha.expira_em,
      },
      cliente,
    );
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
  outbox.despachar();
  return {
    expiraEm: linha.expira_em,
    podeReenviarEm: new Date(new Date(linha.criado_em).getTime() + INTERVALO_REENVIO_S * 1000),
  };
}

// Confere o código. Acertou: a linha some (uso único) e devolve o e-mail que
// o código confirmou. Errou: conta o erro; no MAX_ERROS a linha some e só
// um código novo resolve.
async function conferir(contaId, finalidade, codigo) {
  const digitado = String(codigo || '').replace(/\D/g, '');
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      'SELECT * FROM codigos_email WHERE anunciante_id = $1 AND finalidade = $2 FOR UPDATE',
      [contaId, finalidade],
    );
    const linha = rows[0];
    if (!linha || new Date(linha.expira_em) <= new Date()) {
      await cliente.query('COMMIT');
      return { ok: false, motivo: 'expirado' };
    }
    const esperado = Buffer.from(linha.codigo_hash, 'hex');
    const recebido = Buffer.from(hashDoCodigo(contaId, finalidade, digitado), 'hex');
    if (digitado.length !== 6 || !crypto.timingSafeEqual(esperado, recebido)) {
      if (linha.tentativas + 1 >= MAX_ERROS) {
        await cliente.query('DELETE FROM codigos_email WHERE id = $1', [linha.id]);
        await cliente.query('COMMIT');
        return { ok: false, motivo: 'esgotado' };
      }
      await cliente.query('UPDATE codigos_email SET tentativas = tentativas + 1 WHERE id = $1', [linha.id]);
      await cliente.query('COMMIT');
      return { ok: false, motivo: 'errado' };
    }
    await cliente.query('DELETE FROM codigos_email WHERE id = $1', [linha.id]);
    await cliente.query('COMMIT');
    return { ok: true, email: linha.email };
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

const MENSAGEM_DO_ERRO = {
  expirado: 'código expirado — peça um novo',
  errado: 'código errado — confira e tente de novo',
  esgotado: 'código errado muitas vezes — peça um novo',
};

// O que a tela precisa pra mostrar o prazo real (e o que aconteceu com o
// envio), sem nunca expor o código. `envio`: estado do e-mail mais recente
// deste tipo na fila — "na fila", "enviado", "tentando de novo" ou
// "abandonado" (aí a tela sugere conferir o endereço ou pedir outro).
async function estado(contaId, finalidade) {
  const { rows } = await pool.query(
    'SELECT email, expira_em, criado_em FROM codigos_email WHERE anunciante_id = $1 AND finalidade = $2',
    [contaId, finalidade],
  );
  const { rows: envios } = await pool.query(
    `SELECT status FROM email_outbox WHERE anunciante_id = $1 AND tipo = $2 ORDER BY id DESC LIMIT 1`,
    [contaId, TIPO[finalidade]],
  );
  const linha = rows[0];
  const valendo = !!linha && new Date(linha.expira_em) > new Date();
  return {
    pendente: valendo,
    email: linha?.email || null,
    expiraEm: valendo ? linha.expira_em : null,
    podeReenviarEm: linha ? new Date(new Date(linha.criado_em).getTime() + INTERVALO_REENVIO_S * 1000) : null,
    envio: envios[0]?.status || null,
  };
}

async function descartar(contaId, finalidade, db = pool) {
  await db.query('DELETE FROM codigos_email WHERE anunciante_id = $1 AND finalidade = $2', [contaId, finalidade]);
}

module.exports = {
  VALIDADE_MIN,
  INTERVALO_REENVIO_S,
  MAX_POR_HORA,
  MAX_ERROS,
  MENSAGEM_DO_ERRO,
  emitir,
  conferir,
  estado,
  descartar,
};
