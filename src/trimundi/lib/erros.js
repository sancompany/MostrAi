// Erro de regra da Trimundi: carrega o status HTTP e a mensagem final que a
// tela mostra (docs/trimundi/funcional.md §6). Qualquer outro erro é 500.
class ErroTrimundi extends Error {
  constructor(status, mensagem, extra = {}) {
    super(mensagem);
    this.status = status;
    this.extra = extra;
  }
}

const erro = (status, mensagem, extra) => new ErroTrimundi(status, mensagem, extra);

// Vai para o público (/ticket/*): fala da venda de ingressos, não do módulo.
const MENSAGEM_NAO_CONFIGURADA = 'a venda de ingressos não está configurada neste ambiente';

// Middleware de erro dos routers da Trimundi: regra vira resposta com a
// mensagem; módulo desligado vira 503; o resto segue para o handler global
// da Mostraí (500 genérico, sem detalhe para o cliente).
function tratarErros(err, _req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof ErroTrimundi) return res.status(err.status).json({ erro: err.message, ...err.extra });
  if (err?.naoConfigurada) return res.status(503).json({ erro: MENSAGEM_NAO_CONFIGURADA });
  if (err?.code === '23505') return res.status(409).json({ erro: 'já existe um registro com esses dados' });
  if (err?.code === '23514' || err?.code === '22P02' || err?.code === '22001') {
    return res.status(400).json({ erro: 'dado inválido' });
  }
  if (err?.type === 'entity.parse.failed') return next(err);
  return next(err);
}

module.exports = { ErroTrimundi, erro, tratarErros, MENSAGEM_NAO_CONFIGURADA };
