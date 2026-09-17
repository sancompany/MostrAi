const pool = require('../db/pool');

// Limitador de tentativas por IP+rota. Sem isso, /admin/login aceitava
// tentativas ilimitadas contra uma senha de 10 caracteres, e dava pra varrer
// uma lista de e-mails pelo 409 do cadastro.
//
// A CONTAGEM VIVE NO BANCO desde 17/09/2026 (migration 051). Era um `Map` na
// memória do processo, e isso tem dois defeitos que só aparecem quando o
// serviço cresce: com N instâncias o teto vira N×10 sem ninguém perceber (o
// balanceador espalha as tentativas e cada processo conta as suas), e o
// contador zera a cada deploy. Nenhum dos dois falha barulhento — falham
// deixando a porta mais aberta do que o número escrito aqui promete.
const JANELA_MS = 15 * 60 * 1000;
const MAX = 10;

// O contador é `UPDATE ... RETURNING` num INSERT com conflito, numa ida só ao
// banco. A cláusula do UPDATE decide, no próprio SQL, se a janela anterior
// expirou: se expirou, reinicia em 1; se não, soma 1. Fazer isso em dois
// passos (ler, decidir, gravar) abriria a corrida clássica — duas tentativas
// simultâneas leem 9, as duas gravam 10, e passam as duas.
async function contar(chave) {
  const { rows } = await pool.query(
    `INSERT INTO tentativas_acesso (chave, quantidade, desde)
          VALUES ($1, 1, now())
     ON CONFLICT (chave) DO UPDATE
            SET quantidade = CASE WHEN tentativas_acesso.desde < now() - ($2 || ' milliseconds')::interval
                                  THEN 1 ELSE tentativas_acesso.quantidade + 1 END,
                desde      = CASE WHEN tentativas_acesso.desde < now() - ($2 || ' milliseconds')::interval
                                  THEN now() ELSE tentativas_acesso.desde END
       RETURNING quantidade, desde`,
    [chave, JANELA_MS],
  );
  return rows[0];
}

// Limpeza oportunista, no caminho da própria requisição: sem job pra manter
// vivo e sem tabela crescendo pra sempre. 1 em 100 é raro o bastante pra não
// pesar e frequente o bastante pra não acumular.
async function limparDeVezEmQuando() {
  if (Math.random() > 0.01) return;
  await pool
    .query(`DELETE FROM tentativas_acesso WHERE desde < now() - ($1 || ' milliseconds')::interval`, [JANELA_MS])
    .catch(() => {});
}

// A REGRA, separada do armazenamento: função pura, sem banco e sem relógio
// escondido. É ela que os testes exercem — o resto aqui é adaptador. Enquanto
// a contagem vivia num Map, regra e armazenamento eram a mesma coisa e o
// teste só existia porque tudo era síncrono; ao mover pro banco, ou a suíte
// inteira passava a precisar de Postgres, ou a regra saía de dentro do I/O.
function decidir({ quantidade, desde, agora = Date.now() }) {
  if (quantidade <= MAX) return { bloquear: false };
  const faltam = Math.max(1, Math.ceil((JANELA_MS - (agora - new Date(desde).getTime())) / 60000));
  return { bloquear: true, faltamMinutos: faltam };
}

async function limiteTentativas(req, res, next) {
  try {
    const { quantidade, desde } = await contar(`${req.ip}:${req.path}`);
    limparDeVezEmQuando();

    const veredito = decidir({ quantidade, desde });
    if (veredito.bloquear) {
      res.setHeader('Retry-After', veredito.faltamMinutos * 60);
      return res
        .status(429)
        .json({ erro: `muitas tentativas — espere ${veredito.faltamMinutos} minuto(s) e tente de novo` });
    }
    next();
  } catch (err) {
    // Banco fora não pode virar porta trancada: /admin/login e o login do
    // anunciante ficariam inacessíveis por causa do CONTADOR, não da senha. O
    // caminho autenticado logo abaixo depende do mesmo banco e vai falhar
    // sozinho, com o erro certo.
    console.error('limite de tentativas indisponível:', err.message);
    next();
  }
}

// Chamado depois de um login que deu certo, pra não punir quem só errou a
// senha uma vez antes de acertar.
async function zerarTentativas(req) {
  await pool.query('DELETE FROM tentativas_acesso WHERE chave = $1', [`${req.ip}:${req.path}`]).catch(() => {});
}

module.exports = { limiteTentativas, zerarTentativas, decidir, MAX, JANELA_MS };
