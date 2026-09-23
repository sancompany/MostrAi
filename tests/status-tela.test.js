const test = require('node:test');
const assert = require('node:assert');
const { statusOperacionalTela, TOLERANCIA_OFFLINE_MS } = require('../src/lib/status-tela');
const { DIAS } = require('../src/lib/horario-semanal');

// Régua única de status operacional da tela (revisão final da Visão Geral,
// 23/09/2026) — substitui a checagem fixa de "2h sem heartbeat" que ignorava
// o horário de funcionamento. 2026-09-23 é uma quarta-feira.
const QUARTA_MEIO_DIA = new Date('2026-09-23T12:00:00');
const HORARIO_9_18 = { ...Object.fromEntries(DIAS.map((d) => [d, null])), qua: { abre: '09:00', fecha: '18:00' } };
const HORARIO_FECHADO_QUARTA = { ...Object.fromEntries(DIAS.map((d) => [d, null])) };
const RECENTE = new Date(QUARTA_MEIO_DIA.getTime() - 5 * 60 * 1000).toISOString();
const EXPIRADO = new Date(QUARTA_MEIO_DIA.getTime() - TOLERANCIA_OFFLINE_MS - 60 * 1000).toISOString();

test('em_reparo/inativa vêm do status manual, nunca viram alerta', () => {
  assert.strictEqual(statusOperacionalTela({ status: 'reparo' }, null, QUARTA_MEIO_DIA), 'em_reparo');
  assert.strictEqual(statusOperacionalTela({ status: 'inativo' }, null, QUARTA_MEIO_DIA), 'inativa');
});

test('nunca conectou -> aguardando_primeiro_sinal, mesmo fora do horário', () => {
  const tela = { status: 'ativo', modo_horario: 'ponto', ultima_vez_online: null };
  assert.strictEqual(statusOperacionalTela(tela, HORARIO_FECHADO_QUARTA, QUARTA_MEIO_DIA), 'aguardando_primeiro_sinal');
});

test('modo "ponto": dentro do horário + heartbeat recente -> operando', () => {
  const tela = { status: 'ativo', modo_horario: 'ponto', ultima_vez_online: RECENTE };
  assert.strictEqual(statusOperacionalTela(tela, HORARIO_9_18, QUARTA_MEIO_DIA), 'operando');
});

test('modo "ponto": fora do horário -> fora_do_horario, não alerta', () => {
  const tela = { status: 'ativo', modo_horario: 'ponto', ultima_vez_online: EXPIRADO };
  assert.strictEqual(statusOperacionalTela(tela, HORARIO_FECHADO_QUARTA, QUARTA_MEIO_DIA), 'fora_do_horario');
});

test('modo "ponto": dentro do horário + heartbeat expirado -> sem_sinal', () => {
  const tela = { status: 'ativo', modo_horario: 'ponto', ultima_vez_online: EXPIRADO };
  assert.strictEqual(statusOperacionalTela(tela, HORARIO_9_18, QUARTA_MEIO_DIA), 'sem_sinal');
});

test('modo "24h": heartbeat expirado -> sem_sinal independente do horário do ponto', () => {
  const tela = { status: 'ativo', modo_horario: '24h', ultima_vez_online: EXPIRADO };
  assert.strictEqual(statusOperacionalTela(tela, HORARIO_FECHADO_QUARTA, QUARTA_MEIO_DIA), 'sem_sinal');
});

test('modo "24h": heartbeat recente -> operando mesmo com o ponto fechado', () => {
  const tela = { status: 'ativo', modo_horario: '24h', ultima_vez_online: RECENTE };
  assert.strictEqual(statusOperacionalTela(tela, HORARIO_FECHADO_QUARTA, QUARTA_MEIO_DIA), 'operando');
});

test('modo "personalizado": usa o horário PRÓPRIO da tela, ignora o do ponto', () => {
  const tela = {
    status: 'ativo',
    modo_horario: 'personalizado',
    horario_semanal: HORARIO_9_18,
    ultima_vez_online: RECENTE,
  };
  // ponto fechado, mas a tela tem horário próprio aberto agora.
  assert.strictEqual(statusOperacionalTela(tela, HORARIO_FECHADO_QUARTA, QUARTA_MEIO_DIA), 'operando');
});

test('modo "personalizado": fora da janela própria -> fora_do_horario mesmo com o ponto aberto', () => {
  const tela = {
    status: 'ativo',
    modo_horario: 'personalizado',
    horario_semanal: HORARIO_FECHADO_QUARTA,
    ultima_vez_online: EXPIRADO,
  };
  assert.strictEqual(statusOperacionalTela(tela, HORARIO_9_18, QUARTA_MEIO_DIA), 'fora_do_horario');
});

test('sem horário cadastrado (null): trata como "deveria estar online" (nunca suprime por omissão)', () => {
  const tela = { status: 'ativo', modo_horario: 'ponto', ultima_vez_online: EXPIRADO };
  assert.strictEqual(statusOperacionalTela(tela, null, QUARTA_MEIO_DIA), 'sem_sinal');
});

test('player relatou erro -> erro_do_player, quando por outro lado estaria operando', () => {
  const tela = {
    status: 'ativo',
    modo_horario: 'ponto',
    ultima_vez_online: RECENTE,
    ultimo_erro: 'falha ao baixar playlist',
  };
  assert.strictEqual(statusOperacionalTela(tela, HORARIO_9_18, QUARTA_MEIO_DIA), 'erro_do_player');
});

test('erro relatado, mas heartbeat já expirou -> sem_sinal tem prioridade (parou de falar de vez)', () => {
  const tela = { status: 'ativo', modo_horario: 'ponto', ultima_vez_online: EXPIRADO, ultimo_erro: 'falha antiga' };
  assert.strictEqual(statusOperacionalTela(tela, HORARIO_9_18, QUARTA_MEIO_DIA), 'sem_sinal');
});
