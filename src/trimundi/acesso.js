const config = require('./config');
const { descontarAcerto } = require('../lib/limite-tentativas');

// Login do operador pela tela da Mostraí (D-05, RN-T27). Chamado pelo
// `POST /anunciantes/login` SÓ quando o e-mail não é de nenhuma conta da
// Mostraí. Devolve `true` quando já respondeu; `false` deixa a Mostraí
// responder exatamente como sempre (mesmo 401).
async function entrarComoOperador(req, res, email, senha) {
  if (!config.configurada()) return false;
  let r;
  try {
    r = await require('./operadores').autenticar(email, senha);
  } catch (err) {
    // Banco da Trimundi fora: a Mostraí responde como sempre (401). Um 503
    // aqui mudaria o login dela e ainda diria "este e-mail não é conta".
    console.error('trimundi: login de operador indisponível:', err.message);
    return false;
  }
  if (!r) return false;
  if (r.desativado) {
    res.status(403).json({ erro: 'Este acesso foi desativado — fale com quem organiza o evento.' });
    return true;
  }
  await descontarAcerto(req, res);
  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.trimundiOperadorId = r.id;
  req.session.trimundiOperadorVersao = r.versao;
  res.json({ operador: true, destino: '/ticket/checkin' });
  return true;
}

module.exports = { entrarComoOperador };
