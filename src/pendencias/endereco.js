const pool = require('../db/pool');
const repo = require('./repository');
const { numeroSuspeito } = require('../lib/endereco');

// Pendências de endereço (estação de endereços, 01/10/2026). O servidor
// decide; o painel só mostra.
//
// ENDERECO_SUSPEITO — o Número parece endereço ("Av Francisco Mastrop", o
// caso real: a rua digitada no campo Número e cortada em 20 caracteres).
// Vale pra três alvos da conta: o endereço da empresa, cada ponto e cada
// pedido de ponto em análise. Nada é corrigido sozinho: o dado fica como
// está, a pendência aponta e some quando o Número muda — ou quando o
// cliente confirma que está certo (aquele mesmo valor não reabre).

const MENSAGEM_NUMERO =
  'O número do imóvel parece estar incorreto. Revise o endereço para manter seus dados atualizados.';

const ALVOS = {
  conta: (linha) => ({
    titulo: 'Confira o endereço da sua empresa',
    ctaDestino: 'endereco-conta',
    anuncianteId: linha.id,
  }),
  ponto: (linha) => ({
    titulo: `Confira o endereço do ponto ${linha.nome || ''}`.trim(),
    ctaDestino: `endereco-ponto:${linha.id}`,
    anuncianteId: linha.anunciante_id,
    pontoId: linha.id,
  }),
  candidatura: (linha) => ({
    titulo: `Confira o endereço do pedido ${linha.nome_comercio || ''}`.trim(),
    ctaDestino: `endereco-candidatura:${linha.id}`,
    anuncianteId: linha.conta_id,
    candidaturaId: linha.id,
  }),
};

const chaveDoNumero = (alvo, id) => `ENDERECO_SUSPEITO:${alvo}:${id}`;
// O valor comparado na confirmação: sem diferença de caixa e espaço.
const impressaoDo = (numero) =>
  String(numero || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

// Avalia o Número de um alvo já gravado. `confirmado`: o cliente acabou de
// salvar dizendo que o valor está certo.
async function avaliarNumero(alvo, linha, { confirmado = false, por = null } = {}, db = pool) {
  const chave = chaveDoNumero(alvo, linha.id);
  const destino = ALVOS[alvo](linha);
  if (!destino.anuncianteId || !numeroSuspeito(linha.numero)) {
    return repo.resolver(chave, { resolucao: 'corrigido', por }, db);
  }
  const p = {
    tipo: 'ENDERECO_SUSPEITO',
    chave,
    ...destino,
    mensagem: MENSAGEM_NUMERO,
    ctaRotulo: 'Corrigir endereço',
    impressao: impressaoDo(linha.numero),
  };
  if (confirmado) return repo.confirmar(p, por, db);
  if (await repo.foiConfirmada(chave, p.impressao, db))
    return repo.resolver(chave, { resolucao: 'confirmado', por }, db);
  // Ponto que nasceu de um pedido: o "está certo" dado no pedido vale pro
  // mesmo valor no ponto (o endereço foi copiado de lá).
  if (alvo === 'ponto' && linha.candidatura_id) {
    if (await repo.foiConfirmada(chaveDoNumero('candidatura', linha.candidatura_id), p.impressao, db)) {
      return repo.resolver(chave, { resolucao: 'confirmado', por }, db);
    }
  }
  return repo.abrir(p, db);
}

// Reavalia o endereço da conta, dos pontos dela e dos pedidos em análise —
// e encerra a pendência de quem deixou de existir (pedido aprovado ou
// recusado, ponto arquivado ou que mudou de dono). Barata (três leituras
// pequenas) e idempotente: roda depois de cada gravação de endereço, quando
// o painel pede as pendências e na varredura diária.
// `confirmado`: { alvo, id } do que o cliente confirmou nesta gravação.
async function sincronizarConta(contaId, { confirmado = null, por = null } = {}) {
  const [conta, pontos, candidaturas, ativas] = await Promise.all([
    pool.query('SELECT id, numero, excluido_em FROM anunciantes WHERE id = $1', [contaId]),
    pool.query(
      `SELECT id, nome, numero, anunciante_id, candidatura_id FROM pontos WHERE anunciante_id = $1 AND status <> 'arquivado'`,
      [contaId],
    ),
    pool.query(
      `SELECT c.id, c.nome_comercio, c.numero, c.conta_id FROM candidaturas c
        WHERE c.conta_id = $1 AND c.tipo = 'ponto' AND c.status IN ('nova', 'em_contato')
          AND NOT EXISTS (SELECT 1 FROM pontos p WHERE p.candidatura_id = c.id)`,
      [contaId],
    ),
    repo.chavesAtivasDaConta(contaId, 'ENDERECO_SUSPEITO'),
  ]);
  const alvos = [];
  const linhaConta = conta.rows[0];
  // Conta excluída não recebe pendência nova (a anonimização apaga o
  // endereço; o que estava ativo se encerra abaixo).
  if (linhaConta && !linhaConta.excluido_em) {
    alvos.push(['conta', linhaConta]);
    for (const p of pontos.rows) alvos.push(['ponto', p]);
    for (const c of candidaturas.rows) alvos.push(['candidatura', c]);
  }
  const vigentes = new Set();
  for (const [alvo, linha] of alvos) {
    vigentes.add(chaveDoNumero(alvo, linha.id));
    const ehConfirmado = confirmado?.alvo === alvo && Number(confirmado.id) === Number(linha.id);
    await avaliarNumero(alvo, linha, { confirmado: ehConfirmado, por });
  }
  for (const chave of ativas) {
    if (!vigentes.has(chave)) await repo.resolver(chave, { resolucao: 'encerrada', por });
  }
}

// A mesma sincronização sem deixar o erro subir: chamada DEPOIS de a
// gravação de endereço ter acontecido, ela é aviso — nunca derruba (nem
// desfaz) o que o cliente salvou.
async function sincronizarContaSemFalhar(contaId, opcoes) {
  try {
    await sincronizarConta(contaId, opcoes);
  } catch (err) {
    console.error(`pendências de endereço da conta ${contaId} não avaliadas: ${err.message}`);
  }
}

// Varredura diária (scripts/conciliar.js): o cadastro antigo — gravado antes
// desta regra — também ganha a pendência, mesmo de quem não entrou no
// painel. Só aponta; não muda endereço nenhum.
async function varrerContas() {
  const { rows } = await pool.query(
    `SELECT id FROM anunciantes WHERE excluido_em IS NULL
     UNION
     SELECT DISTINCT anunciante_id FROM pendencias WHERE tipo = 'ENDERECO_SUSPEITO' AND resolvido_em IS NULL`,
  );
  let falhas = 0;
  for (const { id } of rows) {
    try {
      await sincronizarConta(id, { por: 'varredura' });
    } catch (err) {
      falhas += 1;
      console.error(`varredura de endereço, conta ${id}: ${err.message}`);
    }
  }
  return { contas: rows.length, falhas };
}

// ENDERECO_PONTO_ALTERADO — o dono mudou o endereço de um ponto que já tem
// tela instalada (qualquer status além de "aguardando instalação"). Pede
// conferência da operação; a tela continua ligada. Dentro da transação da
// troca: a pendência existe junto com o histórico, ou nenhum dos dois.
const MENSAGEM_PONTO_ALTERADO = 'O endereço deste ponto foi alterado após a instalação e precisa ser conferido.';

function pontoJaInstalado(ponto) {
  return !['a_instalar', 'arquivado'].includes(ponto.status);
}

async function abrirPontoAlterado(ponto, anterior, novo, db) {
  return repo.abrir(
    {
      tipo: 'ENDERECO_PONTO_ALTERADO',
      chave: `ENDERECO_PONTO_ALTERADO:ponto:${ponto.id}`,
      anuncianteId: ponto.anunciante_id,
      pontoId: ponto.id,
      titulo: `Endereço alterado: ${ponto.nome}`,
      mensagem: MENSAGEM_PONTO_ALTERADO,
      ctaRotulo: 'Conferir ponto',
      ctaDestino: `#rede/pontos/${ponto.id}`,
      dados: { anterior, novo },
    },
    db,
  );
}

module.exports = {
  sincronizarConta,
  sincronizarContaSemFalhar,
  varrerContas,
  pontoJaInstalado,
  abrirPontoAlterado,
};
