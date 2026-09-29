const pool = require('../db/pool');

// 'retirado' (migration 075): aprovado que o admin tirou do ar, ou que saiu
// porque o substituto foi aprovado. Continua cadastrado; o gerador só toca
// 'aprovado', então fica fora da playlist sem nenhuma outra regra.
const STATUS = ['pendente', 'aprovado', 'reprovado', 'retirado'];

const CAMPOS_ATUALIZAVEIS = [
  'status',
  // Quem tirou do ar (migration 109): cliente, admin ou substituição.
  'retirado_por',
  'arquivo_normalizado_url',
  'thumbnail_url',
  'editado_pelo_operador',
  'motivo_reprovacao',
  // Substituir arquivo de uma mídia própria (Parte 27, reorganização de
  // Conteúdo, 22/09/2026) atualiza a MESMA linha em vez de criar outra —
  // por isso original/duração, que antes só entravam no INSERT, também
  // precisam ser editáveis.
  'arquivo_original_url',
  'duracao_segundos',
  // SHA-256 e tamanho do MP4 servido (migration 083, contentHash do Player V2).
  'conteudo_sha256',
  'conteudo_bytes',
];

// `envio_chave` (migration 098): a chave de idempotência do upload. Duas
// requisições com a mesma chave na mesma conta esbarram no índice único —
// quem chama trata o 23505 como "já existe".
async function criar(dados) {
  const { rows } = await pool.query(
    `INSERT INTO criativos
       (anunciante_id, arquivo_original_url, arquivo_normalizado_url, thumbnail_url, duracao_segundos,
        substitui_criativo_id, envio_chave)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      dados.anunciante_id,
      dados.arquivo_original_url,
      dados.arquivo_normalizado_url,
      dados.thumbnail_url,
      dados.duracao_segundos,
      dados.substitui_criativo_id || null,
      dados.envio_chave || null,
    ],
  );
  return rows[0];
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM criativos WHERE id = $1', [id]);
  return rows[0] || null;
}

async function buscarPorEnvio(anuncianteId, envioChave) {
  const { rows } = await pool.query('SELECT * FROM criativos WHERE anunciante_id = $1 AND envio_chave = $2', [
    anuncianteId,
    envioChave,
  ]);
  return rows[0] || null;
}

// Linha temporária de um upload que nunca terminou: o processo reiniciou
// (deploy) no meio do FFmpeg, e nem o sucesso nem a limpeza do erro rodaram.
// Ficava "processando" pra sempre e ocupando a cota. Nenhum processamento
// real dura 30 min (o maior medido em produção foi ~2 min).
// limite: janela fixa de 30 min; com fila assíncrona de mídia, vira estado
// explícito (processando/falhou) em vez de idade.
async function descartarProcessamentosOrfaos(anuncianteId) {
  const { rows } = await pool.query(
    `DELETE FROM criativos c
      WHERE c.anunciante_id = $1 AND c.status = 'pendente' AND c.arquivo_normalizado_url IS NULL
        AND c.created_at < now() - interval '30 minutes'
        AND NOT EXISTS (SELECT 1 FROM midias_proprias m WHERE m.criativo_id = c.id)
      RETURNING c.id`,
    [anuncianteId],
  );
  return rows.length;
}

// Conta pra aplicar o limite de criativos do plano — as vagas ATIVAS, o "1 de
// 1" do painel (não conta reprovado — reprovado não ocupa a cota, ver
// src/anunciantes/routes.js). Substituto em análise também não conta: ele
// só entra tirando o que substitui, então o total depois da troca é o mesmo
// de antes (Parte 22). Retirado também não conta (finalização, 28/09/2026):
// depois da troca o original vira 'retirado' e, contando, o Essencial (1)
// ficava "2 de 1" e travava o próximo envio — a peça fora do ar não ocupa
// vaga; se o admin a colocar no ar de novo, o limite do rodízio
// (limiteDeCriativos) é que segura.
//
// Esta NÃO é a conta do teto de cadastro (CRIATIVOS_POR_CONTA): quem segura
// o que fica guardado na conta, retirado incluído, é `contarCadastrados`
// (revisão Codex do PR #88, 28/09/2026).
async function contarNaoReprovados(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM criativos
      WHERE anunciante_id = $1 AND status NOT IN ('reprovado', 'retirado')
        AND NOT (status = 'pendente' AND substitui_criativo_id IS NOT NULL)`,
    [anuncianteId],
  );
  return rows[0].total;
}

// Conta pro teto de CADASTRO (CRIATIVOS_POR_CONTA, src/lib/limites.js): tudo
// que fica guardado na conta — retirado inclusive. Mesma régua do
// "N de 3 cadastrados" da ficha (src/anunciantes/situacao.js). Existe
// separada de `contarNaoReprovados` desde a revisão Codex do PR #88
// (28/09/2026): quando o retirado saiu da conta do plano, a substituição
// (que pula o limite do plano) passou a acumular um retirado por troca sem
// teto nenhum — o cliente trocava sem fim e a conta guardava tudo.
async function contarCadastrados(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM criativos
      WHERE anunciante_id = $1 AND status <> 'reprovado'
        AND NOT (status = 'pendente' AND substitui_criativo_id IS NOT NULL)`,
    [anuncianteId],
  );
  return rows[0].total;
}

async function listarPorAnunciante(anuncianteId) {
  const { rows } = await pool.query('SELECT * FROM criativos WHERE anunciante_id = $1 ORDER BY created_at DESC', [
    anuncianteId,
  ]);
  return rows;
}

// `status` vazio ou 'todos' traz tudo. A aba "Meus anúncios" do admin lista os
// criativos da conta própria do Mostraí, que a operação sobe JÁ APROVADOS —
// e como esta função só aceitava um status e a rota mandava 'pendente' por
// padrão, aquela tabela ficava eternamente vazia com peças no ar.
async function listarPorStatus(status) {
  if (!status || status === 'todos') {
    const { rows } = await pool.query('SELECT * FROM criativos ORDER BY created_at ASC');
    return rows;
  }
  const { rows } = await pool.query('SELECT * FROM criativos WHERE status = $1 ORDER BY created_at ASC', [status]);
  return rows;
}

// `db`: um client em transação, quando quem chama precisa travar outra linha
// junto (troca de arquivo de mídia própria × exclusão, src/midias/repository.js).
async function atualizar(id, dadosRecebidos, db = pool) {
  // URL nova sem o hash do arquivo novo: o hash antigo mentiria sobre o
  // conteúdo (o Player rejeitaria o download e pularia a peça). Sem hash, o
  // Player cai no cache por criativoId — pior, mas não errado.
  const dados =
    'arquivo_normalizado_url' in dadosRecebidos && !('conteudo_sha256' in dadosRecebidos)
      ? { ...dadosRecebidos, conteudo_sha256: null, conteudo_bytes: null }
      : dadosRecebidos;
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorId(id);
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const valores = campos.map((c) => dados[c]);
  const { rows } = await db.query(`UPDATE criativos SET ${sets} WHERE id = $1 RETURNING *`, [id, ...valores]);
  return rows[0] || null;
}

async function deletar(id) {
  await pool.query('DELETE FROM criativos WHERE id = $1', [id]);
}

module.exports = {
  criar,
  buscarPorId,
  buscarPorEnvio,
  descartarProcessamentosOrfaos,
  listarPorAnunciante,
  listarPorStatus,
  atualizar,
  deletar,
  contarNaoReprovados,
  contarCadastrados,
  STATUS,
};
