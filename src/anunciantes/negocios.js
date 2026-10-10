const pool = require('../db/pool');
const categoriasRepo = require('../categorias/repository');

// Negócio ou marca que o criativo divulga (migration 121). A CONTA contrata e
// paga — plano, horas, saldo, obrigação e limite de criativos continuam nela;
// o negócio só diz quem aparece na peça e em que categoria, que é o que a
// proteção contra concorrentes compara (src/playlist/gerador.js#travaDeRamoSql).
//
// Validado = a Mostraí conferiu (aprovou um criativo do negócio, ou o Admin o
// corrigiu). Antes disso a categoria é só a palavra do cliente, e o cliente
// edita à vontade. Depois, só o Admin muda nome e categoria — decisão do dono
// (10/10/2026): quem precisar mudar anuncia como outro negócio.

class ErroNegocio extends Error {
  constructor(mensagem, status = 400) {
    super(mensagem);
    this.status = status;
  }
}

const NOME_MIN = 2;
const NOME_MAX = 80;

const CAMPOS = `n.id, n.anunciante_id, n.nome, n.categoria_id, k.nome AS categoria_nome, n.categoria_livre,
                n.principal, n.mesmo_grupo_declarado_em, n.validado_em, n.validado_por, n.criado_em`;

function paraResposta(r) {
  return {
    id: r.id,
    nome: r.nome,
    principal: r.principal,
    categoria: r.categoria_id ? { id: r.categoria_id, nome: r.categoria_nome } : null,
    categoriaLivre: r.categoria_id ? null : r.categoria_livre || null,
    validado: !!r.validado_em,
    validadoEm: r.validado_em || null,
    mesmoGrupoDeclaradoEm: r.mesmo_grupo_declarado_em || null,
    ...(r.criativos === undefined ? {} : { criativos: r.criativos }),
  };
}

// O principal da conta, criado na hora se a conta é de depois da migration
// (mesma função que o banco usa no gatilho do criativo).
async function principalDaConta(contaId, db = pool) {
  const { rows } = await db.query('SELECT negocio_principal($1) AS id', [contaId]);
  return rows[0].id;
}

// Os negócios da conta: o principal primeiro, depois na ordem em que foram
// criados. `criativos` = quantos criativos cadastrados apontam pra ele.
async function listarDaConta(contaId, db = pool) {
  await principalDaConta(contaId, db);
  const { rows } = await db.query(
    `SELECT ${CAMPOS}, (SELECT count(*) FROM criativos c WHERE c.negocio_id = n.id)::int AS criativos
       FROM negocios n LEFT JOIN categorias k ON k.id = n.categoria_id
      WHERE n.anunciante_id = $1
      ORDER BY n.principal DESC, n.criado_em, n.id`,
    [contaId],
  );
  return rows;
}

// Id vindo da requisição: inteiro positivo que cabe no `int` do banco, ou null.
function lerId(bruto) {
  const id = Number(bruto);
  return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

async function buscarDaConta(contaId, negocioId, db = pool, { travar = false } = {}) {
  const id = lerId(negocioId);
  if (!id) return null;
  const { rows } = await db.query(
    `SELECT ${CAMPOS} FROM negocios n LEFT JOIN categorias k ON k.id = n.categoria_id
      WHERE n.id = $1 AND n.anunciante_id = $2${travar ? ' FOR UPDATE OF n' : ''}`,
    [id, contaId],
  );
  return rows[0] || null;
}

function lerNome(bruto) {
  const nome = String(bruto ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (nome.length < NOME_MIN || nome.length > NOME_MAX) {
    throw new ErroNegocio(`o nome do negócio ou marca precisa ter de ${NOME_MIN} a ${NOME_MAX} caracteres`);
  }
  return nome;
}

// Categoria do catálogo (ativa) ou, se o cliente não achou a dele, o texto
// livre — que a Mostraí classifica antes de aprovar.
async function lerCategoria(categoriaId, categoriaLivre) {
  if (categoriaId !== undefined && categoriaId !== null && categoriaId !== '') {
    const categoria = await categoriasRepo.buscarAtivaPorId(categoriaId);
    if (!categoria) throw new ErroNegocio('categoria inválida');
    return { categoriaId: categoria.id, categoriaLivre: null };
  }
  const livre = String(categoriaLivre ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (livre.length < NOME_MIN || livre.length > NOME_MAX) throw new ErroNegocio('escolha a categoria do negócio');
  return { categoriaId: null, categoriaLivre: livre };
}

const sim = (v) => v === true || v === 'true' || v === '1' || v === 'on' || v === 1;

// Negócio adicional, criado junto com o envio de um criativo. O mesmo nome
// na conta é o mesmo negócio: se ele ainda não foi validado (um envio que
// falhou no meio, um reenvio), a nova declaração substitui a anterior; se já
// foi validado, ou é o principal, o cliente escolhe ele na lista.
async function criarAdicional(contaId, { nome, categoriaId, categoriaLivre, mesmoGrupo }, db = pool) {
  const nomeLimpo = lerNome(nome);
  const categoria = await lerCategoria(categoriaId, categoriaLivre);
  if (!sim(mesmoGrupo)) {
    throw new ErroNegocio('confirme que este negócio ou marca pertence ao mesmo responsável ou grupo desta conta');
  }
  const { rows } = await db.query(
    `INSERT INTO negocios (anunciante_id, nome, categoria_id, categoria_livre, mesmo_grupo_declarado_em)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (anunciante_id, (lower(btrim(nome)))) DO UPDATE
       SET categoria_id = EXCLUDED.categoria_id, categoria_livre = EXCLUDED.categoria_livre,
           mesmo_grupo_declarado_em = EXCLUDED.mesmo_grupo_declarado_em
       WHERE NOT negocios.principal AND negocios.validado_em IS NULL
     RETURNING id`,
    [contaId, nomeLimpo, categoria.categoriaId, categoria.categoriaLivre],
  );
  if (!rows[0]) {
    throw new ErroNegocio('você já tem um negócio com esse nome — escolha-o em "Quem este anúncio divulga?"', 409);
  }
  return rows[0].id;
}

// O negócio de um envio: o escolhido (tem que ser desta conta), um novo
// (nome + categoria + declaração) ou, sem nada, o principal — o mesmo que a
// tela de envio deixa marcado.
async function negocioDoEnvio(contaId, corpo = {}, db = pool) {
  if (corpo.negocio_id !== undefined && corpo.negocio_id !== null && corpo.negocio_id !== '') {
    const negocio = await buscarDaConta(contaId, corpo.negocio_id, db);
    if (!negocio) throw new ErroNegocio('negócio não encontrado nesta conta', 404);
    return negocio.id;
  }
  if (corpo.negocio_nome !== undefined) {
    return criarAdicional(
      contaId,
      {
        nome: corpo.negocio_nome,
        categoriaId: corpo.negocio_categoria_id,
        categoriaLivre: corpo.negocio_categoria_livre,
        mesmoGrupo: corpo.negocio_mesmo_grupo,
      },
      db,
    );
  }
  return principalDaConta(contaId, db);
}

// O cliente corrige um negócio que a Mostraí ainda não validou (o caso de
// "Correção necessária"). Validado, só o Admin muda.
async function editarPeloCliente(contaId, negocioId, corpo = {}) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const atual = await buscarDaConta(contaId, negocioId, cliente, { travar: true });
    if (!atual) throw new ErroNegocio('negócio não encontrado nesta conta', 404);
    if (atual.validado_em) {
      throw new ErroNegocio(
        'este negócio já foi conferido pela Mostraí e não muda mais por aqui — para anunciar com outro nome ou categoria, use "Anunciar outro negócio ou marca"',
        409,
      );
    }
    const nome = corpo.nome === undefined ? atual.nome : lerNome(corpo.nome);
    const mudaCategoria = corpo.categoria_id !== undefined || corpo.categoria_livre !== undefined;
    const categoria = mudaCategoria
      ? await lerCategoria(corpo.categoria_id, corpo.categoria_livre)
      : { categoriaId: atual.categoria_id, categoriaLivre: atual.categoria_livre };
    await cliente.query('UPDATE negocios SET nome = $2, categoria_id = $3, categoria_livre = $4 WHERE id = $1', [
      atual.id,
      nome,
      categoria.categoriaId,
      categoria.categoriaLivre,
    ]);
    await cliente.query('COMMIT');
    return buscarDaConta(contaId, atual.id);
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw new ErroNegocio('você já tem um negócio com esse nome', 409);
    throw err;
  } finally {
    cliente.release();
  }
}

async function nomeDaCategoria(db, id) {
  if (!id) return null;
  const { rows } = await db.query('SELECT nome FROM categorias WHERE id = $1', [id]);
  return rows[0]?.nome || null;
}

async function auditar(db, antes, depois, { acao, criativoId = null, motivo = null, operador, operadorAccess = null }) {
  await db.query(
    `INSERT INTO negocios_validacoes (negocio_id, criativo_id, acao, nome_antes, nome_depois, categoria_antes_id,
                                      categoria_antes_nome, categoria_livre_antes, categoria_depois_id,
                                      categoria_depois_nome, motivo, operador, operador_access)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      antes.id,
      criativoId,
      acao,
      antes.nome,
      depois.nome,
      antes.categoria_id,
      antes.categoria_nome ?? (await nomeDaCategoria(db, antes.categoria_id)),
      antes.categoria_livre,
      depois.categoria_id,
      await nomeDaCategoria(db, depois.categoria_id),
      motivo,
      operador,
      operadorAccess,
    ],
  );
}

function lerMotivo(bruto) {
  const motivo = String(bruto ?? '').trim();
  return motivo ? motivo.slice(0, 500) : null;
}

// Na aprovação de um criativo (dentro da transação de quem aprova): o negócio
// dele sai validado. `categoriaId` é a categoria FINAL que o Admin escolheu
// ("Alterar categoria e aprovar") — diferente da que estava, exige motivo e
// fica na auditoria com a de antes. Sem categoria nenhuma (o cliente marcou
// "não encontrei a minha"), não aprova — nem quando o negócio já foi
// validado sem ela (upload do operador): peça sem categoria nunca seria
// barrada como concorrente (revisão do PR #133). `exigirCategoria: false` só
// pra quem o Admin aprova sem fila (o upload do operador, a conta própria) e
// pra peça retirada que volta ao ar (não é aprovação nova).
async function validarNaAprovacao(
  db,
  criativo,
  { categoriaId, motivo, operador, operadorAccess, exigirCategoria = true },
) {
  const atual = await buscarDaConta(criativo.anunciante_id, criativo.negocio_id, db, { travar: true });
  if (!atual) throw new ErroNegocio('o negócio deste criativo não existe mais', 409);
  const informada = categoriaId !== undefined && categoriaId !== null && categoriaId !== '';
  let final = atual.categoria_id;
  if (informada) {
    const categoria = await categoriasRepo.buscarAtivaPorId(categoriaId);
    if (!categoria) throw new ErroNegocio('categoria inválida');
    final = categoria.id;
  }
  const corrigida = final !== atual.categoria_id;
  if (corrigida && !lerMotivo(motivo)) throw new ErroNegocio('diga o motivo de alterar a categoria');
  if (!final && exigirCategoria) {
    throw new ErroNegocio('escolha a categoria deste negócio antes de aprovar');
  }
  if (atual.validado_em && !corrigida) return atual;
  await db.query(
    `UPDATE negocios
        SET categoria_id = $2,
            categoria_livre = CASE WHEN $3 THEN NULL ELSE categoria_livre END,
            validado_em = COALESCE(validado_em, now()),
            validado_por = COALESCE(validado_por, $4)
      WHERE id = $1`,
    [atual.id, final, corrigida, operador],
  );
  await auditar(
    db,
    atual,
    { nome: atual.nome, categoria_id: final },
    {
      acao: corrigida ? 'categoria_corrigida' : 'validado',
      criativoId: criativo.id,
      motivo: lerMotivo(motivo),
      operador,
      operadorAccess,
    },
  );
  return buscarDaConta(criativo.anunciante_id, atual.id, db);
}

// O Admin muda nome e/ou categoria de um negócio fora da aprovação (o
// cliente pediu, ou a Mostraí percebeu). Sempre com motivo; o negócio fica
// validado — foi a Mostraí que decidiu.
async function editarPeloAdmin(db, negocioId, { nome, categoriaId, motivo, operador, operadorAccess }) {
  const id = lerId(negocioId);
  if (!id) throw new ErroNegocio('negócio não encontrado', 404);
  const { rows } = await db.query(
    `SELECT ${CAMPOS} FROM negocios n LEFT JOIN categorias k ON k.id = n.categoria_id WHERE n.id = $1 FOR UPDATE OF n`,
    [id],
  );
  const atual = rows[0];
  if (!atual) throw new ErroNegocio('negócio não encontrado', 404);
  const motivoLimpo = lerMotivo(motivo);
  if (!motivoLimpo) throw new ErroNegocio('diga o motivo da alteração');
  const novoNome = nome === undefined ? atual.nome : lerNome(nome);
  let novaCategoria = atual.categoria_id;
  if (categoriaId !== undefined) {
    const categoria = await categoriasRepo.buscarAtivaPorId(categoriaId);
    if (!categoria) throw new ErroNegocio('categoria inválida');
    novaCategoria = categoria.id;
  }
  if (novoNome === atual.nome && novaCategoria === atual.categoria_id && atual.validado_em) {
    throw new ErroNegocio('nada mudou');
  }
  try {
    await db.query(
      `UPDATE negocios
          SET nome = $2, categoria_id = $3,
              categoria_livre = CASE WHEN $3::int IS DISTINCT FROM categoria_id THEN NULL ELSE categoria_livre END,
              validado_em = COALESCE(validado_em, now()), validado_por = COALESCE(validado_por, $4)
        WHERE id = $1`,
      [atual.id, novoNome, novaCategoria, operador],
    );
  } catch (err) {
    if (err.code === '23505') throw new ErroNegocio('a conta já tem um negócio com esse nome', 409);
    throw err;
  }
  await auditar(
    db,
    atual,
    { nome: novoNome, categoria_id: novaCategoria },
    { acao: 'editado_pelo_admin', motivo: motivoLimpo, operador, operadorAccess },
  );
  return buscarDaConta(atual.anunciante_id, atual.id, db);
}

// O Admin reclassificou a CONTA na ficha: o negócio principal JÁ VALIDADO
// passa a ter a mesma categoria (é o mesmo estabelecimento), com auditoria.
// Ainda não validado, o banco já o fez acompanhar o cadastro (gatilho da 121).
async function aplicarCategoriaDaContaNoPrincipal(db, contaId, categoriaId, { operador, operadorAccess }) {
  if (!categoriaId) return null;
  const { rows } = await db.query(
    'SELECT id, categoria_id FROM negocios WHERE anunciante_id = $1 AND principal AND validado_em IS NOT NULL',
    [contaId],
  );
  if (!rows[0] || rows[0].categoria_id === Number(categoriaId)) return null;
  return editarPeloAdmin(db, rows[0].id, {
    categoriaId,
    motivo: 'categoria da conta alterada pelo Admin na ficha',
    operador,
    operadorAccess,
  });
}

// O que aconteceu com o negócio, do mais novo pro mais velho (ficha do Admin).
async function historico(negocioId, db = pool) {
  const { rows } = await db.query(
    `SELECT acao, criativo_id, nome_antes, nome_depois, categoria_antes_nome, categoria_livre_antes,
            categoria_depois_nome, motivo, operador, operador_access, criado_em
       FROM negocios_validacoes WHERE negocio_id = $1 ORDER BY criado_em DESC, id DESC`,
    [negocioId],
  );
  return rows;
}

module.exports = {
  ErroNegocio,
  paraResposta,
  principalDaConta,
  listarDaConta,
  buscarDaConta,
  negocioDoEnvio,
  criarAdicional,
  editarPeloCliente,
  validarNaAprovacao,
  editarPeloAdmin,
  aplicarCategoriaDaContaNoPrincipal,
  historico,
};
