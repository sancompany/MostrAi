const pool = require('../db/pool');

// Releases do Player para OTA fase 1 (contrato V2 §8). O backend só anuncia;
// quem baixa, confere SHA-256, confere pacote/versionCode e pede instalação
// (com confirmação no controle, sem Device Owner) é o Player.
//
// Keystore: o Android recusa APK assinado com chave diferente da instalada
// (contrato §8.4) e o servidor não tem como provar a assinatura de um APK
// que ele nem baixa. Por isso uma release só pode ser ATIVADA depois que um
// humano marca "assinatura conferida" (CHECK no banco, migration 081) — e o
// Player de hoje ainda não tem keystore definitivo (auditoria do Player,
// seção 7): nenhuma release deve ser ativada antes dele.

const CAMPOS_PUBLICOS = `id, versao, build, url, sha256, tamanho_bytes, obrigatoria, build_minimo, notas,
  assinatura_conferida_em, assinatura_conferida_por, ativa, criado_em, criado_por`;

function validar(d) {
  const erros = [];
  if (typeof d.versao !== 'string' || !/^[0-9A-Za-z.\-_]{1,32}$/.test(d.versao)) erros.push('versão inválida');
  if (!Number.isInteger(d.build) || d.build <= 0) erros.push('build precisa ser inteiro positivo');
  if (typeof d.url !== 'string' || !/^https:\/\/\S+$/.test(d.url)) erros.push('URL precisa ser https');
  if (typeof d.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(d.sha256)) erros.push('SHA-256 precisa ter 64 hex');
  if (d.tamanho_bytes != null && !(Number.isInteger(d.tamanho_bytes) && d.tamanho_bytes > 0))
    erros.push('tamanho inválido');
  if (d.build_minimo != null && !(Number.isInteger(d.build_minimo) && d.build_minimo > 0))
    erros.push('build mínimo inválido');
  return erros;
}

async function listar() {
  const { rows } = await pool.query(`SELECT ${CAMPOS_PUBLICOS} FROM player_releases ORDER BY build DESC`);
  return rows;
}

async function criar(d, criadoPor) {
  const { rows } = await pool.query(
    `INSERT INTO player_releases (versao, build, url, sha256, tamanho_bytes, obrigatoria, build_minimo, notas, criado_por)
     VALUES ($1, $2, $3, lower($4), $5, $6, $7, $8, $9) RETURNING ${CAMPOS_PUBLICOS}`,
    [
      d.versao,
      d.build,
      d.url,
      d.sha256,
      d.tamanho_bytes ?? null,
      !!d.obrigatoria,
      d.build_minimo ?? null,
      typeof d.notas === 'string' ? d.notas.slice(0, 500) : null,
      criadoPor,
    ],
  );
  return rows[0];
}

async function conferirAssinatura(id, quem) {
  const { rows } = await pool.query(
    `UPDATE player_releases SET assinatura_conferida_em = now(), assinatura_conferida_por = $2
      WHERE id = $1 RETURNING ${CAMPOS_PUBLICOS}`,
    [id, quem],
  );
  return rows[0] || null;
}

// Ativar exige assinatura conferida (o CHECK do banco barra o resto; aqui a
// mensagem sai legível). Desativar é sempre possível: é o "segurar versão".
async function definirAtiva(id, ativa) {
  const { rows } = await pool.query(
    `UPDATE player_releases SET ativa = $2 WHERE id = $1 AND (NOT $2 OR assinatura_conferida_em IS NOT NULL)
     RETURNING ${CAMPOS_PUBLICOS}`,
    [id, !!ativa],
  );
  return rows[0] || null;
}

// A release que esta tela deveria receber: a ativa de maior build, acima do
// build instalado, e cujo build mínimo o instalado atende. Sem build
// conhecido (Player não mandou X-Player-Version) não há o que comparar.
async function aplicavelA(buildInstalado) {
  if (!Number.isInteger(buildInstalado)) return null;
  const { rows } = await pool.query(
    `SELECT versao, build, url, sha256, tamanho_bytes, obrigatoria FROM player_releases
      WHERE ativa AND build > $1 AND (build_minimo IS NULL OR build_minimo <= $1)
      ORDER BY build DESC LIMIT 1`,
    [buildInstalado],
  );
  return rows[0] || null;
}

// Manifesto no formato do contrato §8.1. Sem release aplicável o heartbeat
// NÃO leva `update`: manifesto ausente é o que faz o Player limpar o estado
// de uma atualização já concluída (Atualizador.considerar).
function manifesto(release) {
  if (!release) return null;
  const m = {
    available: true,
    required: release.obrigatoria,
    version: release.versao,
    build: release.build,
    url: release.url,
    sha256: release.sha256,
  };
  if (release.tamanho_bytes) m.size = Number(release.tamanho_bytes);
  return m;
}

module.exports = { validar, listar, criar, conferirAssinatura, definirAtiva, aplicavelA, manifesto };
