const crypto = require('node:crypto');
const pool = require('../db/pool');
const { gerarHash, conferirHash } = require('../lib/senha');
const { sincronizarStatusPonto } = require('../pontos/repository');
const { statusOperacionalTela, SITUACOES_DE_ALERTA } = require('../lib/status-tela');

// Dispositivo = uma tela. Ponto = o comércio/endereço (migration 019).
const CAMPOS_ATUALIZAVEIS = [
  'apelido',
  'status',
  'custo_equipamento',
  'meses_amortizacao',
  'instalado_em',
  // Migration 065 — 1 (padrão) devolve o array de sempre pro player web; 2 é
  // o envelope novo, pra quem instalar o app Android nativo nesta tela.
  'contrato_playlist',
  // Margens da safe area (migration 069) — área que o molde físico do ACM
  // cobre, em vmin, mesma unidade que o player web já usava num valor só
  // (?margem=N). Nunca negativo (CHECK no banco).
  'margem_superior',
  'margem_direita',
  'margem_inferior',
  'margem_esquerda',
  // Horário operacional da tela (migration 076) — validado à parte em
  // routes.js (mesmo formato/validação de pontos.horario_semanal) antes de
  // chegar aqui.
  'modo_horario',
  'horario_semanal',
];
const STATUS = ['ativo', 'reparo', 'inativo'];

// pin_hash nunca sai daqui pra fora.
const CAMPOS_PUBLICOS = `id, ponto_id, apelido, aparelho_id, status, ultima_vez_online,
  custo_equipamento, meses_amortizacao, instalado_em, created_at, (pin_hash IS NOT NULL) AS tem_pin,
  contrato_playlist, margem_superior, margem_direita, margem_inferior, margem_esquerda,
  modo_horario, horario_semanal, ultimo_erro, ultimo_erro_em`;

async function criar(pontoId, dados = {}, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO dispositivos (ponto_id, apelido, custo_equipamento, meses_amortizacao, instalado_em)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${CAMPOS_PUBLICOS}`,
    [
      pontoId,
      dados.apelido || 'Tela',
      Number(dados.custo_equipamento) || 0,
      Number(dados.meses_amortizacao) || 36,
      dados.instalado_em || null,
    ],
  );
  // Nasce 'inativo' (default da coluna, migration 069) — não muda o status
  // automático do ponto sozinha (só entra na conta quando alguém marcar
  // 'ativo'), mas sincroniza mesmo assim: um ponto que só tinha telas
  // inativas/em reparo e ganha mais uma segue exatamente igual, e um ponto
  // recém-criado sem tela nenhuma que agora ganha a primeira sai de
  // "a_instalar" só quando ela virar 'ativo' de verdade.
  await sincronizarStatusPonto(pontoId, db);
  return rows[0];
}

async function buscarPorId(id) {
  const { rows } = await pool.query(`SELECT ${CAMPOS_PUBLICOS} FROM dispositivos WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Uso interno do player: precisa do ponto junto (categoria, horário, cota).
async function buscarComPonto(id) {
  const { rows } = await pool.query(
    `SELECT d.id, d.ponto_id, d.aparelho_id, d.status, d.contrato_playlist,
            d.margem_superior, d.margem_direita, d.margem_inferior, d.margem_esquerda,
            p.categoria_id, p.horario_abertura, p.horario_fechamento,
            p.cota_autoanuncio_slots_hora, p.anunciante_id AS dono_conta_id, p.status AS ponto_status,
            (SELECT COUNT(*)::int FROM dispositivos x WHERE x.ponto_id = d.ponto_id AND x.status = 'ativo') AS telas_do_ponto
     FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id WHERE d.id = $1`,
    [id],
  );
  return rows[0] || null;
}

// Mesmos campos públicos, prefixados com o alias da tabela — sem isso
// `status`/`created_at` ficam ambíguos no JOIN com pontos.
const CAMPOS_PUBLICOS_D = `d.id, d.ponto_id, d.apelido, d.aparelho_id, d.status, d.ultima_vez_online,
  d.custo_equipamento, d.meses_amortizacao, d.instalado_em, d.created_at, (d.pin_hash IS NOT NULL) AS tem_pin,
  d.contrato_playlist, d.modo_horario, d.horario_semanal, d.ultimo_erro, d.ultimo_erro_em`;

// `situacaoOperacional` (migration 076 + src/lib/status-tela.js) é derivado
// aqui, não guardado — a régua de "operando/fora do horário/sem sinal/etc"
// muda com o relógio, nunca é um fato gravado no banco.
function comSituacaoOperacional(rows) {
  return rows.map((tela) => ({
    ...tela,
    situacaoOperacional: statusOperacionalTela(tela, tela.ponto_horario_semanal),
  }));
}

// Mesmos campos de listarTodos (com nome, cidade e status do ponto): a tela de
// telas do admin mostra essas colunas, e sem elas filtrar por ponto devolvia
// linhas com a coluna "Ponto" em branco. Duas listagens da mesma coisa tem que
// devolver a mesma forma.
async function listarPorPonto(pontoId) {
  const { rows } = await pool.query(
    `SELECT ${CAMPOS_PUBLICOS_D},
            p.nome AS ponto_nome, p.cidade AS ponto_cidade, p.status AS ponto_status,
            p.horario_semanal AS ponto_horario_semanal
     FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
     WHERE d.ponto_id = $1 ORDER BY d.id`,
    [pontoId],
  );
  return comSituacaoOperacional(rows);
}

async function listarTodos() {
  const { rows } = await pool.query(
    `SELECT ${CAMPOS_PUBLICOS_D},
            p.nome AS ponto_nome, p.cidade AS ponto_cidade, p.status AS ponto_status,
            p.horario_semanal AS ponto_horario_semanal
     FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id ORDER BY p.nome, d.id`,
  );
  return comSituacaoOperacional(rows);
}

// Só as telas que precisam de atenção agora (SITUACOES_DE_ALERTA) — usado
// pelo card de alerta da Visão Geral, que antes contava qualquer heartbeat
// vencido sem saber se a tela deveria estar online.
async function listarComProblemaDeSinal() {
  return (await listarTodos()).filter((t) => SITUACOES_DE_ALERTA.has(t.situacaoOperacional));
}

async function atualizar(id, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorId(id);
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(`UPDATE dispositivos SET ${sets} WHERE id = $1 RETURNING ${CAMPOS_PUBLICOS}`, [
    id,
    ...campos.map((c) => dados[c]),
  ]);
  // Status do ponto acompanha automaticamente (rodada final da Rede) — só
  // recalcula quando o campo que pode ter mudado o resultado muda; os
  // outros campos (chave, PIN, custo, margens...) nunca afetam a conta.
  if (rows[0] && campos.includes('status')) await sincronizarStatusPonto(rows[0].ponto_id);
  return rows[0] || null;
}

// Chave nova derruba o aparelho antigo na hora — é o que se quer quando o
// stick é trocado ou some.
async function gerarChave(id) {
  const chave = crypto.randomBytes(16).toString('base64url');
  const { rows } = await pool.query(
    `UPDATE dispositivos SET aparelho_id = $2 WHERE id = $1 RETURNING ${CAMPOS_PUBLICOS}`,
    [id, chave],
  );
  return rows[0] ? { ...rows[0], aparelho_id: chave } : null;
}

// PIN de 4 dígitos, guardado com hash. Protege só o painel daquela tela
// aberto a partir da própria TV (CONSTRAINTS.md). null limpa.
async function definirPin(id, pin) {
  const hash = pin ? await gerarHash(String(pin)) : null;
  const { rows } = await pool.query(
    `UPDATE dispositivos SET pin_hash = $2 WHERE id = $1 RETURNING ${CAMPOS_PUBLICOS}`,
    [id, hash],
  );
  return rows[0] || null;
}

async function conferirPin(id, pin) {
  const { rows } = await pool.query('SELECT pin_hash FROM dispositivos WHERE id = $1', [id]);
  if (!rows[0]?.pin_hash) return false;
  return (await conferirHash(String(pin), rows[0].pin_hash)).ok;
}

// `erro` vem do próprio player (migration 076) — presente grava os dois
// campos juntos, ausente/vazio limpa os dois: não existe erro "preso" depois
// que o player volta a reportar normal.
async function marcarOnline(id, erro) {
  await pool.query(
    'UPDATE dispositivos SET ultima_vez_online = now(), ultimo_erro = $2, ultimo_erro_em = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END WHERE id = $1',
    [id, erro || null],
  );
}

async function deletar(id) {
  const existente = await buscarPorId(id);
  if (!existente) return;
  await pool.query('DELETE FROM exibicoes_contador WHERE dispositivo_id = $1', [id]);
  // As duas de baixo (migrations 064 e 065) também referenciam dispositivos —
  // sem elas aqui, apagar uma tela que já gerou playlist ou proof-of-play
  // quebra a FK e a exclusão nunca funciona, silenciosamente até alguém tentar.
  await pool.query('DELETE FROM playlist_hora_congelada WHERE dispositivo_id = $1', [id]);
  await pool.query('DELETE FROM execucoes_confirmadas WHERE dispositivo_id = $1', [id]);
  await pool.query('DELETE FROM dispositivos WHERE id = $1', [id]);
  // Excluir a última tela de um ponto tem que voltar ele pra "Aguardando
  // instalação" — sem isso o status ficava preso no valor de antes de apagar.
  await sincronizarStatusPonto(existente.ponto_id);
}

module.exports = {
  criar,
  buscarPorId,
  buscarComPonto,
  listarPorPonto,
  listarTodos,
  listarComProblemaDeSinal,
  atualizar,
  gerarChave,
  definirPin,
  conferirPin,
  marcarOnline,
  deletar,
  STATUS,
};
