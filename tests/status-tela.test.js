const test = require('node:test');
const assert = require('node:assert');
const {
  saudeDaTela,
  TOLERANCIA_SEM_SINAL_MS,
  situacaoConfig,
  situacaoFila,
  alertasDaTela,
} = require('../src/lib/status-tela');
const { DIAS } = require('../src/lib/horario-semanal');

// Régua única de status operacional da tela (revisão final da Visão Geral,
// 23/09/2026) — substitui a checagem fixa de "2h sem heartbeat" que ignorava
// o horário de funcionamento. 2026-09-23 é uma quarta-feira. Offset `-03:00`
// explícito: `estaAbertoAgora` lê a wall-clock de São Paulo via `Intl`
// (achado em revisão de PR), não o fuso do processo — sem o offset, este
// literal seria interpretado em UTC (fuso do servidor/CI) e representaria
// 09:00 em SP, não meio-dia.
const QUARTA_MEIO_DIA = new Date('2026-09-23T12:00:00-03:00');
const HORARIO_9_18 = { ...Object.fromEntries(DIAS.map((d) => [d, null])), qua: { abre: '09:00', fecha: '18:00' } };
const HORARIO_FECHADO_QUARTA = { ...Object.fromEntries(DIAS.map((d) => [d, null])) };
const HORARIO_24H = Object.fromEntries(DIAS.map((d) => [d, { abre: '00:00', fecha: '24:00' }]));
const RECENTE = new Date(QUARTA_MEIO_DIA.getTime() - 30 * 1000).toISOString();
const EXPIRADO = new Date(QUARTA_MEIO_DIA.getTime() - TOLERANCIA_SEM_SINAL_MS - 60 * 1000).toISOString();

test('em_reparo/inativa vêm do status manual, nunca viram alerta', () => {
  assert.strictEqual(saudeDaTela({ status: 'reparo' }, null, QUARTA_MEIO_DIA), 'em_reparo');
  assert.strictEqual(saudeDaTela({ status: 'inativo' }, null, QUARTA_MEIO_DIA), 'inativa');
});

test('sem Player instalado -> aguardando_instalacao, mesmo fora do horário', () => {
  const tela = { status: 'ativo', ultima_vez_online: null };
  assert.strictEqual(saudeDaTela(tela, HORARIO_FECHADO_QUARTA, QUARTA_MEIO_DIA), 'aguardando_instalacao');
});

test('horário do ponto: dentro do horário + heartbeat recente -> operando', () => {
  const tela = {
    status: 'ativo',
    chave_hash: 'h',
    primeiro_sinal_em: RECENTE,
    ultima_vez_online: RECENTE,
  };
  assert.strictEqual(saudeDaTela(tela, HORARIO_9_18, QUARTA_MEIO_DIA), 'operando');
});

test('horário do ponto: fora do horário -> fora_do_horario, não alerta', () => {
  const tela = {
    status: 'ativo',
    chave_hash: 'h',
    primeiro_sinal_em: EXPIRADO,
    ultima_vez_online: EXPIRADO,
  };
  assert.strictEqual(saudeDaTela(tela, HORARIO_FECHADO_QUARTA, QUARTA_MEIO_DIA), 'fora_do_horario');
});

test('horário do ponto: dentro do horário + heartbeat expirado -> sem_sinal', () => {
  const tela = {
    status: 'ativo',
    chave_hash: 'h',
    primeiro_sinal_em: EXPIRADO,
    ultima_vez_online: EXPIRADO,
  };
  assert.strictEqual(saudeDaTela(tela, HORARIO_9_18, QUARTA_MEIO_DIA), 'sem_sinal');
});

test('ponto 24 h (00:00–24:00): heartbeat expirado -> sem_sinal a qualquer hora', () => {
  const madrugada = new Date('2026-09-23T03:00:00-03:00');
  const expirado = new Date(madrugada.getTime() - TOLERANCIA_SEM_SINAL_MS - 60 * 1000).toISOString();
  const tela = { status: 'ativo', chave_hash: 'h', primeiro_sinal_em: expirado, ultima_vez_online: expirado };
  assert.strictEqual(saudeDaTela(tela, HORARIO_24H, madrugada), 'sem_sinal');
});

test('horário/modo gravados na TELA são ignorados: vale sempre o do ponto', () => {
  const tela = {
    status: 'ativo',
    chave_hash: 'h',
    horario_semanal: HORARIO_9_18,
    primeiro_sinal_em: EXPIRADO,
    ultima_vez_online: EXPIRADO,
  };
  assert.strictEqual(saudeDaTela(tela, HORARIO_FECHADO_QUARTA, QUARTA_MEIO_DIA), 'fora_do_horario');
});

test('sem horário cadastrado (null): trata como "deveria estar online" (nunca suprime por omissão)', () => {
  const tela = {
    status: 'ativo',
    chave_hash: 'h',
    primeiro_sinal_em: EXPIRADO,
    ultima_vez_online: EXPIRADO,
  };
  assert.strictEqual(saudeDaTela(tela, null, QUARTA_MEIO_DIA), 'sem_sinal');
});

test('player relatou erro -> erro_do_player, quando por outro lado estaria operando', () => {
  const tela = {
    status: 'ativo',
    chave_hash: 'h',
    primeiro_sinal_em: RECENTE,
    ultima_vez_online: RECENTE,
    ultimo_erro: 'falha ao baixar playlist',
  };
  assert.strictEqual(saudeDaTela(tela, HORARIO_9_18, QUARTA_MEIO_DIA), 'erro_do_player');
});

test('erro relatado, mas heartbeat já expirou -> sem_sinal tem prioridade (parou de falar de vez)', () => {
  const tela = {
    status: 'ativo',
    chave_hash: 'h',
    primeiro_sinal_em: EXPIRADO,
    ultima_vez_online: EXPIRADO,
    ultimo_erro: 'falha antiga',
  };
  assert.strictEqual(saudeDaTela(tela, HORARIO_9_18, QUARTA_MEIO_DIA), 'sem_sinal');
});

// ---------------------------------------------------------------------------
// Player V2 (24/09/2026): regra única de saúde + config + fila + alertas
// ---------------------------------------------------------------------------
const viva = (extra = {}) => ({
  status: 'ativo',
  chave_hash: 'h',
  primeiro_sinal_em: RECENTE,
  ultima_vez_online: RECENTE,
  created_at: RECENTE,
  ...extra,
});

test('tolerância de "sem sinal" é de 2 min (heartbeat de 15 s)', () => {
  assert.strictEqual(TOLERANCIA_SEM_SINAL_MS, 2 * 60 * 1000);
  const ha = (s) => new Date(QUARTA_MEIO_DIA.getTime() - s * 1000).toISOString();
  assert.strictEqual(saudeDaTela(viva({ ultima_vez_online: ha(15) }), null, QUARTA_MEIO_DIA), 'operando');
  assert.strictEqual(saudeDaTela(viva({ ultima_vez_online: ha(119) }), null, QUARTA_MEIO_DIA), 'operando');
  assert.strictEqual(saudeDaTela(viva({ ultima_vez_online: ha(121) }), null, QUARTA_MEIO_DIA), 'sem_sinal');
});

test('Player V2 reporta OUT_OF_SCHEDULE -> fora_do_horario, mesmo com 24h no servidor', () => {
  assert.strictEqual(saudeDaTela(viva({ player_estado: 'OUT_OF_SCHEDULE' }), null, QUARTA_MEIO_DIA), 'fora_do_horario');
});

test('estados de erro do contrato §10 -> erro_do_player; PLAYING/IDLE -> operando', () => {
  for (const e of ['PLAYBACK_ERROR', 'DOWNLOAD_ERROR', 'AUTH_ERROR', 'CONFIG_ERROR', 'NO_PLAYLIST']) {
    assert.strictEqual(saudeDaTela(viva({ player_estado: e }), null, QUARTA_MEIO_DIA), 'erro_do_player', e);
  }
  for (const e of ['PLAYING', 'IDLE']) {
    assert.strictEqual(saudeDaTela(viva({ player_estado: e }), null, QUARTA_MEIO_DIA), 'operando', e);
  }
  assert.strictEqual(
    saudeDaTela(viva({ ultimo_erro_codigo: 'CONFIG_FALHOU' }), null, QUARTA_MEIO_DIA),
    'erro_do_player',
  );
});

test('heartbeat volta / erro resolve -> operando de novo (derivado, nada gravado)', () => {
  const t = viva({ ultimo_erro_codigo: 'X' });
  assert.strictEqual(saudeDaTela(t, null, QUARTA_MEIO_DIA), 'erro_do_player');
  t.ultimo_erro_codigo = null;
  assert.strictEqual(saudeDaTela(t, null, QUARTA_MEIO_DIA), 'operando');
});

test('Player revogado (sem chave) -> aguardando_instalacao; em reparo/inativa vencem tudo', () => {
  assert.strictEqual(
    saudeDaTela(viva({ revogado_em: RECENTE, chave_hash: null }), null, QUARTA_MEIO_DIA),
    'aguardando_instalacao',
  );
  assert.strictEqual(
    saudeDaTela(viva({ status: 'reparo', ultima_vez_online: EXPIRADO }), null, QUARTA_MEIO_DIA),
    'em_reparo',
  );
});

test('config: sem Player indisponível; igual atualizada; diferente sincronizando, depois pendente', () => {
  assert.strictEqual(situacaoConfig({ chave_hash: null }, QUARTA_MEIO_DIA), 'indisponivel');
  const base = { chave_hash: 'h', config_versao_desejada: 3, config_alterada_em: RECENTE };
  assert.strictEqual(situacaoConfig({ ...base, config_versao_aplicada: 3 }, QUARTA_MEIO_DIA), 'atualizada');
  assert.strictEqual(situacaoConfig({ ...base, config_versao_aplicada: 2 }, QUARTA_MEIO_DIA), 'sincronizando');
  assert.strictEqual(
    situacaoConfig({ ...base, config_versao_aplicada: 2, config_alterada_em: EXPIRADO }, QUARTA_MEIO_DIA),
    'pendente',
  );
});

test('fila: desconhecida nunca vira zero; limiares 2.000/10.000/48 h do contrato §9.3', () => {
  assert.strictEqual(situacaoFila({ fila_pendentes: null }, QUARTA_MEIO_DIA), 'desconhecida');
  assert.strictEqual(situacaoFila({ fila_pendentes: 0 }, QUARTA_MEIO_DIA), 'em_dia');
  assert.strictEqual(situacaoFila({ fila_pendentes: 2001 }, QUARTA_MEIO_DIA), 'atencao');
  assert.strictEqual(situacaoFila({ fila_pendentes: 10001 }, QUARTA_MEIO_DIA), 'critica');
  const antigo = new Date(QUARTA_MEIO_DIA.getTime() - 49 * 3600 * 1000).toISOString();
  assert.strictEqual(situacaoFila({ fila_pendentes: 5, fila_mais_antigo_em: antigo }, QUARTA_MEIO_DIA), 'critica');
});

test('alertas: sem sinal/erro alertam; fora do horário, reparo e inativa nunca', () => {
  assert.deepStrictEqual(
    alertasDaTela(viva(), 'sem_sinal', QUARTA_MEIO_DIA).map((a) => a.codigo),
    ['SEM_SINAL'],
  );
  assert.deepStrictEqual(alertasDaTela(viva(), 'fora_do_horario', QUARTA_MEIO_DIA), []);
  assert.deepStrictEqual(alertasDaTela(viva({ status: 'reparo' }), 'em_reparo', QUARTA_MEIO_DIA), []);
  assert.deepStrictEqual(alertasDaTela(viva({ status: 'inativo' }), 'inativa', QUARTA_MEIO_DIA), []);
  const velha = new Date(QUARTA_MEIO_DIA.getTime() - 8 * 24 * 3600 * 1000).toISOString();
  assert.deepStrictEqual(
    alertasDaTela(viva({ created_at: velha, chave_hash: null }), 'aguardando_instalacao', QUARTA_MEIO_DIA).map(
      (a) => a.codigo,
    ),
    ['INSTALACAO_ATRASADA'],
  );
});
