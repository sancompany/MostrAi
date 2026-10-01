const pool = require('../db/pool');
const sse = require('../lib/sse');
const notificacoesRepo = require('../creditos/notificacoes');

// Pendências da conta e da operação (estação de endereços, 01/10/2026;
// migration 110). Uma pendência é algo que alguém precisa conferir ou
// corrigir — diferente da notificação (src/creditos/notificacoes.js), que é
// histórico do que já aconteceu. Quem decide se existe pendência é sempre o
// servidor; o painel e o admin só mostram.
//
// Uma ATIVA por `chave` (tipo + alvo, índice único parcial): reavaliar o
// mesmo caso não duplica nem avisa de novo. Resolvida nunca é apagada.
//
// Catálogo: cada tipo nasce aqui, com severidade e escopo. Tipos previstos
// para depois (não implementados — entram aqui quando forem construídos):
// endereço incompleto, CEP inválido, telefone incompleto, e-mail não
// confirmado, ponto com endereço pendente, tela sem comunicação, criativo
// rejeitado, pagamento pendente, documento faltante.
const TIPOS = {
  // Número do imóvel que parece endereço ("Av Francisco Mastrop"). O
  // cliente vê e corrige; nunca bloqueia a conta.
  ENDERECO_SUSPEITO: { severidade: 'atencao', escopo: 'conta' },
  // Ponto que já tinha tela instalada mudou de endereço pela mão do dono: a
  // operação confere se a tela continua no lugar. A tela não é desligada.
  ENDERECO_PONTO_ALTERADO: { severidade: 'atencao', escopo: 'admin' },
};

const ORDEM_DA_SEVERIDADE = `CASE severidade WHEN 'bloqueante' THEN 0 WHEN 'atencao' THEN 1 ELSE 2 END`;

// Abre (ou mantém) a pendência ativa da `chave`. Devolve a linha com
// `nova: true` só quando ela acabou de nascer — é o único momento de avisar.
// Se já existia, atualiza o texto, o dono e a impressão (o valor de agora é o
// que o cliente vai confirmar ou corrigir; ponto que mudou de conta leva a
// pendência pro dono novo).
async function abrir(p, db = pool) {
  const tipo = TIPOS[p.tipo];
  if (!tipo) throw new Error(`tipo de pendência desconhecido: ${p.tipo}`);
  const { rows } = await db.query(
    `INSERT INTO pendencias
       (tipo, severidade, escopo, chave, anunciante_id, ponto_id, candidatura_id,
        titulo, mensagem, cta_rotulo, cta_destino, impressao, dados)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (chave) WHERE resolvido_em IS NULL DO UPDATE
       SET anunciante_id = EXCLUDED.anunciante_id, ponto_id = EXCLUDED.ponto_id,
           candidatura_id = EXCLUDED.candidatura_id,
           titulo = EXCLUDED.titulo, mensagem = EXCLUDED.mensagem,
           cta_rotulo = EXCLUDED.cta_rotulo, cta_destino = EXCLUDED.cta_destino,
           impressao = EXCLUDED.impressao, dados = EXCLUDED.dados
     RETURNING *, (xmax = 0) AS nova`,
    [
      p.tipo,
      tipo.severidade,
      tipo.escopo,
      p.chave,
      p.anuncianteId || null,
      p.pontoId || null,
      p.candidaturaId || null,
      p.titulo,
      p.mensagem,
      p.ctaRotulo || null,
      p.ctaDestino || null,
      p.impressao ?? null,
      p.dados ? JSON.stringify(p.dados) : null,
    ],
  );
  const linha = rows[0];
  // Dentro de transação, quem chamou avisa depois do COMMIT (avisarNova) —
  // nunca anunciar o que ainda pode dar ROLLBACK.
  if (db === pool && linha.nova) await avisarNova(linha);
  return linha;
}

// Pendência nova da conta vira um aviso no sino (uma vez só — `nova` só é
// verdadeiro no INSERT) e atualiza o painel aberto; a do admin atualiza o
// admin aberto. Aviso que falha não desfaz a pendência.
async function avisarNova(linha) {
  if (!linha?.nova) return;
  if (linha.escopo === 'conta' && linha.anunciante_id) {
    await notificacoesRepo.registrarSemFalhar(linha.anunciante_id, {
      tipo: 'pendencia',
      titulo: linha.titulo,
      descricao: linha.mensagem,
      entidadeTipo: 'pendencia',
      entidadeId: Number(linha.id),
    });
  }
  emitir(linha);
}

function emitir(linha) {
  if (linha.escopo === 'conta' && linha.anunciante_id) {
    sse.emitirParaConta(linha.anunciante_id, 'pendencia.updated', { id: Number(linha.id) });
  }
  sse.emitirParaAdmin('pendencia.updated', { id: Number(linha.id) });
}

// Resolve a ativa da `chave` (se houver). `resolucao`: corrigido (o dado
// mudou), confirmado (o cliente disse que está certo), conferido (o admin
// olhou), encerrada (o alvo deixou de existir — pedido aprovado/recusado,
// ponto arquivado).
async function resolver(chave, { resolucao, por = null, impressao } = {}, db = pool) {
  const { rows } = await db.query(
    `UPDATE pendencias
        SET resolvido_em = now(), resolucao = $2, resolvido_por = $3, impressao = COALESCE($4, impressao)
      WHERE chave = $1 AND resolvido_em IS NULL
      RETURNING *`,
    [chave, resolucao, por, impressao ?? null],
  );
  if (db === pool && rows[0]) emitir(rows[0]);
  return rows[0] || null;
}

// O cliente confirmou que o valor está certo. Resolve a ativa; sem ativa
// (confirmou já no formulário, antes de existir pendência), grava a
// confirmação como pendência já resolvida — é ela que impede o mesmo valor
// de reabrir depois (`foiConfirmada`).
async function confirmar(p, por, db = pool) {
  const resolvida = await resolver(p.chave, { resolucao: 'confirmado', por, impressao: p.impressao }, db);
  if (resolvida) return resolvida;
  const tipo = TIPOS[p.tipo];
  const { rows } = await db.query(
    `INSERT INTO pendencias
       (tipo, severidade, escopo, chave, anunciante_id, ponto_id, candidatura_id, titulo, mensagem,
        impressao, resolvido_em, resolucao, resolvido_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), 'confirmado', $11)
     RETURNING *`,
    [
      p.tipo,
      tipo.severidade,
      tipo.escopo,
      p.chave,
      p.anuncianteId || null,
      p.pontoId || null,
      p.candidaturaId || null,
      p.titulo,
      p.mensagem,
      p.impressao ?? null,
      por,
    ],
  );
  return rows[0];
}

async function foiConfirmada(chave, impressao, db = pool) {
  const { rows } = await db.query(
    `SELECT 1 FROM pendencias WHERE chave = $1 AND resolucao = 'confirmado' AND impressao = $2 LIMIT 1`,
    [chave, impressao],
  );
  return rows.length > 0;
}

// O que o cliente vê: as ativas da conta, mais grave primeiro. Projeção
// fechada — nada de `dados` interno nem da pendência do admin.
async function listarDaConta(contaId, db = pool) {
  const { rows } = await db.query(
    `SELECT id, tipo, severidade, titulo, mensagem, cta_rotulo, cta_destino, ponto_id, candidatura_id, criado_em
       FROM pendencias
      WHERE anunciante_id = $1 AND escopo = 'conta' AND resolvido_em IS NULL
      ORDER BY ${ORDEM_DA_SEVERIDADE}, criado_em`,
    [contaId],
  );
  return rows;
}

// Ativas da conta, por chave — pra sincronização saber o que encerrar.
async function chavesAtivasDaConta(contaId, tipo, db = pool) {
  const { rows } = await db.query(
    `SELECT chave FROM pendencias WHERE anunciante_id = $1 AND tipo = $2 AND resolvido_em IS NULL`,
    [contaId, tipo],
  );
  return rows.map((r) => r.chave);
}

// Admin: todas as ativas (das duas visões), ou só as de um ponto/conta.
async function listarAtivas({ pontoId, anuncianteId } = {}, db = pool) {
  const filtros = ['p.resolvido_em IS NULL'];
  const valores = [];
  if (pontoId) {
    valores.push(pontoId);
    filtros.push(`p.ponto_id = $${valores.length}`);
  }
  if (anuncianteId) {
    valores.push(anuncianteId);
    filtros.push(`p.anunciante_id = $${valores.length}`);
  }
  const { rows } = await db.query(
    `SELECT p.id, p.tipo, p.severidade, p.escopo, p.titulo, p.mensagem, p.anunciante_id, p.ponto_id,
            p.candidatura_id, p.criado_em, a.nome_empresa AS conta_nome, pt.nome AS ponto_nome
       FROM pendencias p
       LEFT JOIN anunciantes a ON a.id = p.anunciante_id
       LEFT JOIN pontos pt ON pt.id = p.ponto_id
      WHERE ${filtros.join(' AND ')}
      ORDER BY ${ORDEM_DA_SEVERIDADE.replace('severidade', 'p.severidade')}, p.criado_em`,
    valores,
  );
  return rows;
}

// O admin marca como conferida. Só pendência do admin — a do cliente se
// resolve quando o dado muda (ou o cliente confirma), nunca por fora.
async function conferirPeloAdmin(id, por, db = pool) {
  const { rows } = await db.query(
    `UPDATE pendencias SET resolvido_em = now(), resolucao = 'conferido', resolvido_por = $2
      WHERE id = $1 AND escopo = 'admin' AND resolvido_em IS NULL
      RETURNING *`,
    [id, por],
  );
  if (db === pool && rows[0]) emitir(rows[0]);
  return rows[0] || null;
}

module.exports = {
  TIPOS,
  abrir,
  avisarNova,
  resolver,
  confirmar,
  foiConfirmada,
  listarDaConta,
  chavesAtivasDaConta,
  listarAtivas,
  conferirPeloAdmin,
};
