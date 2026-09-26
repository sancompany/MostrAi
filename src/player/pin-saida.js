const pool = require('../db/pool');
const cofre = require('../lib/cofre');
const eventos = require('../lib/eventos');

// PIN de saída do Player (docs/player-mvp-contract.md §6): UM para a rede
// inteira, definido pelo operador em Rede. Vai em `pinSaida` no GET /config
// de toda tela; trocar sobe a `configVersion` de todas.
//
// Guardado cifrado (src/lib/cofre.js) em `configuracoes_site`, nunca em
// claro nem em log. O admin vê só "definido em …"; ver o número é um clique
// deliberado e auditado (evento `player:pin_saida_revelado`).
//
// Sem PIN definido, `pinSaida` sai null — e o admin não gera código de
// instalação (src/dispositivos/repository.js#gerarCodigo), então nenhum
// Player real é instalado sem PIN. Nunca existe PIN padrão.
const CHAVE = 'player_pin_saida';

function erro400(mensagem) {
  return Object.assign(new Error(mensagem), { status: 400 });
}

// 4 a 8 dígitos. Recusa o que alguém tenta primeiro na frente da TV:
// todos iguais (0000, 1111…) e sequência simples (1234, 8765…).
function validar(entrada) {
  const pin = typeof entrada === 'number' ? String(entrada) : entrada;
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
    throw erro400('o PIN de saída tem de 4 a 8 dígitos, só números');
  }
  if (/^(\d)\1+$/.test(pin)) throw erro400('PIN fácil demais — não use todos os dígitos iguais');
  const passos = new Set();
  for (let i = 1; i < pin.length; i++) passos.add((Number(pin[i]) - Number(pin[i - 1]) + 10) % 10);
  if (passos.size === 1 && (passos.has(1) || passos.has(9))) {
    throw erro400('PIN fácil demais — não use sequência (1234, 4321…)');
  }
  return pin;
}

async function ler(cliente = pool) {
  const { rows } = await cliente.query('SELECT valor FROM configuracoes_site WHERE chave = $1', [CHAVE]);
  if (!rows[0]?.valor) return null;
  try {
    return JSON.parse(rows[0].valor);
  } catch {
    return null;
  }
}

// PIN em claro, para a config do Player. null = nenhum definido (ou não
// decifra — SESSION_SECRET trocado: o operador redefine em Rede).
async function obter(cliente = pool) {
  const registro = await ler(cliente);
  const pin = registro ? cofre.abrir(registro.cifrado) : null;
  return pin && /^\d{4,8}$/.test(pin) ? pin : null;
}

async function situacao() {
  const registro = await ler();
  const definido = Boolean(registro && cofre.abrir(registro.cifrado));
  return { definido, alteradoEm: definido ? registro.alteradoEm : null };
}

// Sobe a versão de TODAS as telas: trava as linhas em ordem de id, a mesma
// para qualquer chamada, e repete se o banco ainda assim escolher esta
// transação para desfazer um impasse com outra que atualiza várias telas
// (ex.: o gatilho que marca playlists de um ponto). Trocar o PIN é raro; um
// 500 por impasse, não.
const IMPASSE = '40P01';
async function definir(entrada) {
  const pin = validar(entrada);
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await gravar(pin);
    } catch (err) {
      if (err.code !== IMPASSE || tentativa >= 3) throw err;
    }
  }
}

async function gravar(pin) {
  const alteradoEm = new Date().toISOString();
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query(
      `INSERT INTO configuracoes_site (chave, valor) VALUES ($1, $2)
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
      [CHAVE, JSON.stringify({ cifrado: cofre.fechar(pin), alteradoEm })],
    );
    // Toda tela recebe a config nova no próximo heartbeat (15 s).
    const { rowCount } = await cliente.query(
      `UPDATE dispositivos d SET config_versao_desejada = d.config_versao_desejada + 1, config_alterada_em = now()
         FROM (SELECT id FROM dispositivos ORDER BY id FOR UPDATE) t
        WHERE d.id = t.id`,
    );
    await cliente.query('COMMIT');
    eventos.registrar('player:pin_saida_alterado', { telas: rowCount });
    return { definido: true, alteradoEm, telas: rowCount };
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

async function revelar() {
  const pin = await obter();
  if (pin) eventos.registrar('player:pin_saida_revelado', {});
  return pin;
}

module.exports = { CHAVE, validar, obter, situacao, definir, revelar };
