const pool = require('../db/pool');

// Concorrentes diretos entre categorias (migration 105). A proteção do dono
// da tela é CATEGORIA DO PONTO × CATEGORIA DO NEGÓCIO que a peça divulga
// (validada pela Mostraí; migration 121 — antes era a da conta inteira):
//
//   1. mesma categoria                          → bloqueia
//   2. par registrado em categorias_concorrentes → bloqueia
//   3. qualquer outra coisa                      → exibe
//
// Grupo e aliases nunca entram (mesmo grupo não é concorrência; alias é só
// busca). Não existe exclusividade anunciante × anunciante. Quem aplica a
// regra na programação é o SQL de src/playlist/gerador.js#anunciantesElegiveis
// (um NOT EXISTS pela PK); `bloqueia` abaixo é a mesma regra em JS, pra quem
// já tem as linhas na mão (entrada-no-ar.js#coberturaDaConta).
//
// Um par por linha, sempre com categoria_a < categoria_b: a simetria é do
// armazenamento, não de disciplina de quem grava — não existe um lado só.

// Normaliza o par pro formato da tabela. Null quando não é par (mesma
// categoria ou id inválido).
function parNormalizado(x, y) {
  const a = Number(x);
  const b = Number(y);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) return null;
  return a < b ? [a, b] : [b, a];
}

// `concorrentesDoAnunciante`: Set com os ids que concorrem com a categoria do
// anunciante (`concorrentesDe`). Sem categoria de um dos lados, não há o que
// comparar — exibe, como sempre foi.
function bloqueia(categoriaDoPonto, categoriaDoAnunciante, concorrentesDoAnunciante) {
  if (!categoriaDoPonto || !categoriaDoAnunciante) return false;
  if (Number(categoriaDoPonto) === Number(categoriaDoAnunciante)) return true;
  return !!concorrentesDoAnunciante?.has(Number(categoriaDoPonto));
}

// Ids das categorias que concorrem com `categoriaId` (os dois lados do par).
async function concorrentesDe(categoriaId, db = pool) {
  const id = Number(categoriaId);
  if (!Number.isInteger(id) || id <= 0) return new Set();
  const { rows } = await db.query(
    `SELECT categoria_b AS id FROM categorias_concorrentes WHERE categoria_a = $1
     UNION ALL
     SELECT categoria_a FROM categorias_concorrentes WHERE categoria_b = $1`,
    [id],
  );
  return new Set(rows.map((r) => r.id));
}

// Todos os pares, já espelhados: Map id → [ids concorrentes] ordenados. Uma
// consulta só pra lista inteira do admin (sem N+1).
async function mapaDeConcorrentes(db = pool) {
  const { rows } = await db.query('SELECT categoria_a, categoria_b FROM categorias_concorrentes');
  const mapa = new Map();
  const juntar = (de, para) => {
    if (!mapa.has(de)) mapa.set(de, []);
    mapa.get(de).push(para);
  };
  for (const r of rows) {
    juntar(r.categoria_a, r.categoria_b);
    juntar(r.categoria_b, r.categoria_a);
  }
  for (const lista of mapa.values()) lista.sort((x, y) => x - y);
  return mapa;
}

class ErroConcorrentes extends Error {}

// Maior id que cabe no `int` do Postgres — acima disso a consulta estoura
// (500) em vez de dizer "categoria inválida" (revisão de 28/09/2026).
const MAIOR_ID = 2147483647;

// Só número inteiro positivo (ou o mesmo em texto de dígitos) vale como id:
// `Number([7])` e `Number(true)` virariam 7 e 1 sem ninguém perceber.
function idValido(bruto) {
  if (typeof bruto === 'number' || (typeof bruto === 'string' && /^\d+$/.test(bruto))) {
    const n = Number(bruto);
    if (Number.isInteger(n) && n > 0 && n <= MAIOR_ID) return n;
  }
  return null;
}

function listaDeIds(lista, id) {
  if (lista === undefined) return [];
  if (!Array.isArray(lista)) throw new ErroConcorrentes('concorrentes diretos: lista inválida');
  const ids = new Set();
  for (const bruto of lista) {
    const outro = idValido(bruto);
    if (!outro) throw new ErroConcorrentes('concorrentes diretos: categoria inválida');
    if (outro === id)
      throw new ErroConcorrentes('uma categoria não é concorrente direta de si mesma — isso já bloqueia');
    ids.add(outro);
  }
  return [...ids];
}

// O que o admin mudou no modal (Categorias → editar): pares a PÔR e a TIRAR,
// nunca "o conjunto inteiro" — um modal aberto antes de outra aba gravar um
// par não pode apagá-lo só por salvar o nome (revisão de 28/09/2026). Roda
// dentro da transação de quem chama (`db` = cliente com BEGIN). Como o par é
// uma linha só, tirar B de A tira A de B, e pôr B em A põe A em B.
//
// Par NOVO só entre categorias fora do legado (as duas pontas). As linhas
// das duas pontas ficam travadas (FOR SHARE) até o fim da transação: uma
// mesclagem em andamento termina antes e a checagem enxerga a categoria já
// legada — senão o par ficava preso na absorvida e as contas movidas perdiam
// a proteção. Par antigo com uma ponta que virou legado continua até o admin
// tirar (tirar é sempre permitido).
async function alterarConcorrentes(db, categoriaId, { adicionar, remover } = {}) {
  const id = idValido(categoriaId);
  if (!id) throw new ErroConcorrentes('categoria inválida');
  const poe = listaDeIds(adicionar, id);
  const tira = listaDeIds(remover, id);
  if (poe.some((x) => tira.includes(x))) {
    throw new ErroConcorrentes('concorrentes diretos: a mesma categoria não pode entrar e sair ao mesmo tempo');
  }
  const atuais = await concorrentesDe(id, db);
  const novos = poe.filter((x) => !atuais.has(x));

  if (novos.length) {
    const { rows } = await db.query(
      'SELECT id, legado FROM categorias WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE',
      [[id, ...novos]],
    );
    const vivas = new Set(rows.filter((r) => !r.legado).map((r) => r.id));
    if (!vivas.has(id)) {
      throw new ErroConcorrentes(
        'categoria legado não ganha concorrente novo — mescle ou volte ela pro cadastro antes',
      );
    }
    if (novos.some((x) => !vivas.has(x))) {
      throw new ErroConcorrentes('concorrentes diretos: só dá pra escolher categoria existente e fora do legado');
    }
    const pares = novos.map((outro) => parNormalizado(id, outro));
    await db.query(
      `INSERT INTO categorias_concorrentes (categoria_a, categoria_b)
       SELECT * FROM unnest($1::int[], $2::int[])
       ON CONFLICT DO NOTHING`,
      [pares.map((p) => p[0]), pares.map((p) => p[1])],
    );
  }
  if (tira.length) {
    await db.query(
      `DELETE FROM categorias_concorrentes
        WHERE (categoria_a = $1 AND categoria_b = ANY($2::int[]))
           OR (categoria_b = $1 AND categoria_a = ANY($2::int[]))`,
      [id, tira],
    );
  }
  return [...(await concorrentesDe(id, db))].sort((x, y) => x - y);
}

// Mesclar origem → destino (POST /admin/categorias/:id/mesclar): é o mesmo
// negócio com outro nome, então quem concorria com a origem passa a
// concorrer com o destino — senão a conta reapontada perderia a proteção
// que tinha. O par origem↔destino some (viraria destino↔destino), e par
// repetido não duplica (PK). A origem, legada, fica sem par.
async function moverNaFusao(db, origemId, destinoId) {
  await db.query(
    `INSERT INTO categorias_concorrentes (categoria_a, categoria_b)
     SELECT least($2::int, outro), greatest($2::int, outro)
       FROM (SELECT categoria_b AS outro FROM categorias_concorrentes WHERE categoria_a = $1
             UNION
             SELECT categoria_a FROM categorias_concorrentes WHERE categoria_b = $1) t
      WHERE outro <> $2
     ON CONFLICT DO NOTHING`,
    [origemId, destinoId],
  );
  await db.query('DELETE FROM categorias_concorrentes WHERE categoria_a = $1 OR categoria_b = $1', [origemId]);
}

module.exports = {
  ErroConcorrentes,
  parNormalizado,
  bloqueia,
  concorrentesDe,
  mapaDeConcorrentes,
  idValido,
  alterarConcorrentes,
  moverNaFusao,
};
