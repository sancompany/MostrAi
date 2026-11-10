const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { auditar } = require('./lib/registro');
const { edicaoEditavel, conferirBeneficios } = require('./catalogo');
const { carregarLotes, criarAlocador, combosVendidos, situacaoDoCombo } = require('./disponibilidade');

// Promoções e combos (T3; RN-T16). O combo é a oferta: consome o estoque
// real dos tipos que o compõem e a capacidade da edição, e cada posição vira
// um ingresso individual com participante, código, QR e benefícios próprios.

function lerPromocao(d = {}, parcial = false) {
  const tem = (k) => !parcial || Object.hasOwn(d, k);
  const out = {};
  if (tem('nome')) out.nome = v.texto(d.nome, { campo: 'o nome da promoção', obrigatorio: true, max: 60 });
  if (tem('descricao')) out.descricao = v.texto(d.descricao, { campo: 'a descrição', max: 500 });
  if (tem('preco_total_centavos')) {
    out.preco_total_centavos = v.inteiro(d.preco_total_centavos, {
      campo: 'o preço do combo',
      min: 500,
      max: 5000000,
      mensagem: 'O preço do combo vai de R$ 5,00 a R$ 50.000,00.',
    });
  }
  if (tem('quantidade'))
    out.quantidade = v.inteiro(d.quantidade, { campo: 'a quantidade de combos', min: 1, max: 10000 });
  if (tem('inicio')) out.inicio = v.dataHora(d.inicio, { campo: 'o início da validade' });
  if (tem('fim')) out.fim = v.dataHora(d.fim, { campo: 'o fim da validade' });
  if (out.inicio && out.fim && out.fim <= out.inicio)
    throw erro(400, 'O fim da validade precisa ser depois do início.');
  if (Object.hasOwn(d, 'ativo')) out.ativo = v.booleano(d.ativo, true);
  if (tem('itens')) {
    if (!Array.isArray(d.itens) || !d.itens.length) throw erro(400, 'Inclua de 2 a 20 ingressos no combo.');
    out.itens = d.itens.map((it) => ({
      categoria_id: v.id(it?.categoria_id, 'ingresso'),
      quantidade: v.inteiro(it?.quantidade, { campo: 'a quantidade', min: 1, max: 20 }),
      beneficio_id: it?.beneficio_id ? v.id(it.beneficio_id, 'benefício') : null,
    }));
    const total = out.itens.reduce((s, it) => s + it.quantidade, 0);
    if (total < 2 || total > 20) throw erro(400, 'Inclua de 2 a 20 ingressos no combo.');
  }
  return out;
}

async function conferirItens(cliente, edicaoId, itens) {
  const ids = [...new Set(itens.map((it) => it.categoria_id))];
  const { rows } = await cliente.query('SELECT id FROM categorias WHERE edicao_id = $1 AND id = ANY($2::bigint[])', [
    edicaoId,
    ids,
  ]);
  if (rows.length !== ids.length) throw erro(400, 'ingresso que não é desta edição');
  await conferirBeneficios(cliente, edicaoId, itens.map((it) => it.beneficio_id).filter(Boolean));
}

async function listarPromocoes(edicaoId, cliente = null) {
  const q = cliente ? (s, p) => cliente.query(s, p) : consultar;
  const db = cliente || { query: (s, p) => consultar(s, p) };
  const { rows: promos } = await q('SELECT * FROM promocoes WHERE edicao_id = $1 ORDER BY criado_em, id', [edicaoId]);
  if (!promos.length) return [];
  const { rows: itens } = await q(
    `SELECT pi.*, c.nome AS categoria_nome, b.nome AS beneficio_nome
       FROM promocao_itens pi JOIN categorias c ON c.id = pi.categoria_id
       LEFT JOIN beneficios b ON b.id = pi.beneficio_id
      WHERE pi.promocao_id = ANY($1::bigint[]) ORDER BY pi.promocao_id, pi.ordem`,
    [promos.map((p) => p.id)],
  );
  const categorias = [...new Set(itens.map((i) => Number(i.categoria_id)))];
  // Em sequência: com `cliente` (transação) é uma conexão só.
  const lotes = await carregarLotes(db, categorias);
  const vendidos = await combosVendidos(
    db,
    promos.map((p) => p.id),
  );
  const { rows: ativos } = await q('SELECT id FROM categorias WHERE id = ANY($1::bigint[]) AND ativo', [categorias]);
  // Tipo inativo não vende — nem dentro de combo.
  const ativosSet = new Set(ativos.map((c) => Number(c.id)));
  for (const cat of categorias) if (!ativosSet.has(cat)) lotes.set(cat, []);
  const alocador = criarAlocador(lotes);
  return promos.map((p) => {
    const meus = itens.filter((i) => Number(i.promocao_id) === Number(p.id));
    const usados = vendidos.get(Number(p.id)) || { pagos: 0, reservados: 0 };
    return {
      id: p.id,
      nome: p.nome,
      descricao: p.descricao,
      preco_total_centavos: p.preco_total_centavos,
      quantidade: p.quantidade,
      inicio: p.inicio,
      fim: p.fim,
      ativo: p.ativo,
      vendidos: usados.pagos,
      reservados: usados.reservados,
      disponiveis: Math.max(0, p.quantidade - usados.pagos - usados.reservados),
      ingressos_por_combo: meus.reduce((s, i) => s + i.quantidade, 0),
      itens: meus.map((i) => ({
        id: i.id,
        categoria_id: i.categoria_id,
        categoria_nome: i.categoria_nome,
        quantidade: i.quantidade,
        beneficio_id: i.beneficio_id,
        beneficio_nome: i.beneficio_nome,
      })),
      situacao: situacaoDoCombo(p, meus, usados, alocador),
    };
  });
}

async function gravarItens(cliente, promocaoId, itens) {
  await cliente.query('DELETE FROM promocao_itens WHERE promocao_id = $1', [promocaoId]);
  for (const [i, it] of itens.entries()) {
    await cliente.query(
      'INSERT INTO promocao_itens (promocao_id, categoria_id, quantidade, beneficio_id, ordem) VALUES ($1, $2, $3, $4, $5)',
      [promocaoId, it.categoria_id, it.quantidade, it.beneficio_id, i + 1],
    );
  }
}

async function nomeLivre(cliente, edicaoId, nome, ignorarId = 0) {
  const { rows } = await cliente.query(
    'SELECT 1 FROM promocoes WHERE edicao_id = $1 AND lower(nome) = lower($2) AND id <> $3',
    [edicaoId, nome, ignorarId],
  );
  if (rows.length) throw erro(409, 'Já existe uma promoção com esse nome nesta edição.');
}

async function criarPromocao(edicaoId, dados, autor) {
  const p = lerPromocao(dados);
  return emTransacao(async (cliente) => {
    await edicaoEditavel(cliente, edicaoId);
    await nomeLivre(cliente, edicaoId, p.nome);
    await conferirItens(cliente, edicaoId, p.itens);
    const { rows } = await cliente.query(
      `INSERT INTO promocoes (edicao_id, nome, descricao, preco_total_centavos, quantidade, inicio, fim, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [edicaoId, p.nome, p.descricao || '', p.preco_total_centavos, p.quantidade, p.inicio, p.fim, p.ativo ?? true],
    );
    await gravarItens(cliente, rows[0].id, p.itens);
    await auditar(cliente, autor, 'promocao_criada', 'promocao', rows[0].id, { edicao_id: edicaoId });
    return (await listarPromocoes(edicaoId, cliente)).find((x) => Number(x.id) === Number(rows[0].id));
  });
}

async function atualizarPromocao(id, dados, autor) {
  const p = lerPromocao(dados, true);
  return emTransacao(async (cliente) => {
    const { rows: atualRows } = await cliente.query('SELECT * FROM promocoes WHERE id = $1', [id]);
    const atual = atualRows[0];
    if (!atual) throw erro(404, 'promoção não encontrada');
    await edicaoEditavel(cliente, atual.edicao_id);
    if (p.nome !== undefined) await nomeLivre(cliente, atual.edicao_id, p.nome, id);
    if (p.itens) await conferirItens(cliente, atual.edicao_id, p.itens);
    const inicio = p.inicio !== undefined ? p.inicio : atual.inicio;
    const fim = p.fim !== undefined ? p.fim : atual.fim;
    if (inicio && fim && new Date(fim) <= new Date(inicio)) {
      throw erro(400, 'O fim da validade precisa ser depois do início.');
    }
    if (p.quantidade !== undefined) {
      const usados = (await combosVendidos(cliente, [Number(id)])).get(Number(id)) || { pagos: 0, reservados: 0 };
      const n = usados.pagos + usados.reservados;
      if (p.quantidade < n) {
        throw erro(409, `A quantidade não pode ficar abaixo dos combos já vendidos ou reservados (${n}).`);
      }
    }
    const campos = ['nome', 'descricao', 'preco_total_centavos', 'quantidade', 'inicio', 'fim', 'ativo'].filter(
      (k) => p[k] !== undefined,
    );
    if (campos.length) {
      await cliente.query(
        `UPDATE promocoes SET ${campos.map((k, i) => `${k} = $${i + 2}`).join(', ')}, atualizado_em = now() WHERE id = $1`,
        [id, ...campos.map((k) => p[k])],
      );
    }
    if (p.itens) await gravarItens(cliente, id, p.itens);
    await auditar(cliente, autor, 'promocao_alterada', 'promocao', id, {
      campos: [...campos, ...(p.itens ? ['itens'] : [])],
    });
    return (await listarPromocoes(atual.edicao_id, cliente)).find((x) => Number(x.id) === Number(id));
  });
}

module.exports = { listarPromocoes, criarPromocao, atualizarPromocao };
