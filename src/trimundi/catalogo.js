const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { auditar } = require('./lib/registro');
const { travarEdicao } = require('./eventos');
const { carregarLotes, estadoDaCategoria } = require('./disponibilidade');

// Benefícios, tipos de ingresso e lotes (T2; RN-T08 a RN-T11, RN-T15).

const MAX_LOTES = 10;

async function edicaoEditavel(cliente, edicaoId) {
  const ed = await travarEdicao(cliente, edicaoId);
  if (ed.status === 'encerrado') throw erro(409, 'Edição encerrada fica só para consulta.');
  return ed;
}

// ---------------------------------------------------------------- benefícios
function lerBeneficio(d = {}, parcial = false) {
  const out = {};
  if (!parcial || Object.hasOwn(d, 'nome'))
    out.nome = v.texto(d.nome, { campo: 'o nome do benefício', obrigatorio: true, max: 60 });
  if (!parcial || Object.hasOwn(d, 'descricao'))
    out.descricao = v.texto(d.descricao, { campo: 'a descrição', max: 300 });
  if (Object.hasOwn(d, 'ativo')) out.ativo = v.booleano(d.ativo, true);
  // Quantos existem (ex.: 50 copos). Vazio = sem limite.
  if (!parcial || Object.hasOwn(d, 'quantidade')) {
    out.quantidade = v.inteiro(d.quantidade, {
      campo: 'a quantidade do benefício',
      min: 1,
      max: 100000,
      obrigatorio: false,
    });
  }
  return out;
}

// Benefícios com o estoque: concedidos (em ingresso não cancelado, ou já
// resgatados) e resgatados na portaria.
const SQL_BENEFICIOS = `
  SELECT b.id, b.nome, b.descricao, b.ativo, b.quantidade,
         (SELECT count(*)::int FROM ingresso_beneficios ib JOIN ingressos i ON i.id = ib.ingresso_id
           WHERE ib.beneficio_id = b.id AND (i.status <> 'cancelado' OR ib.resgatado_em IS NOT NULL)) AS concedidos,
         (SELECT count(*)::int FROM ingresso_beneficios ib WHERE ib.beneficio_id = b.id AND ib.resgatado_em IS NOT NULL) AS resgatados
    FROM beneficios b`;

const comRestam = (b) => ({ ...b, restam: b.quantidade ? Math.max(0, b.quantidade - b.concedidos) : null });

async function listarBeneficios(edicaoId) {
  const { rows } = await consultar(`${SQL_BENEFICIOS} WHERE b.edicao_id = $1 ORDER BY b.ativo DESC, b.nome`, [
    edicaoId,
  ]);
  return rows.map(comRestam);
}

async function criarBeneficio(edicaoId, dados, autor) {
  const b = lerBeneficio(dados);
  return emTransacao(async (cliente) => {
    await edicaoEditavel(cliente, edicaoId);
    const { rows } = await cliente.query(
      'INSERT INTO beneficios (edicao_id, nome, descricao, quantidade) VALUES ($1, $2, $3, $4) RETURNING id',
      [edicaoId, b.nome, b.descricao || '', b.quantidade ?? null],
    );
    await auditar(cliente, autor, 'beneficio_criado', 'beneficio', rows[0].id, { edicao_id: edicaoId });
    return comRestam((await cliente.query(`${SQL_BENEFICIOS} WHERE b.id = $1`, [rows[0].id])).rows[0]);
  });
}

async function atualizarBeneficio(id, dados, autor) {
  const b = lerBeneficio(dados, true);
  return emTransacao(async (cliente) => {
    const { rows: atual } = await cliente.query('SELECT edicao_id FROM beneficios WHERE id = $1', [id]);
    if (!atual[0]) throw erro(404, 'benefício não encontrado');
    await edicaoEditavel(cliente, atual[0].edicao_id);
    const campos = Object.keys(b);
    if (!campos.length) throw erro(400, 'nada para alterar');
    if (b.quantidade) {
      const { rows: hoje } = await cliente.query(`${SQL_BENEFICIOS} WHERE b.id = $1 FOR UPDATE OF b`, [id]);
      if (b.quantidade < hoje[0].concedidos) {
        throw erro(409, `A quantidade não pode ficar abaixo do que já foi dado (${hoje[0].concedidos}).`);
      }
    }
    await cliente.query(`UPDATE beneficios SET ${campos.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [
      id,
      ...campos.map((k) => b[k]),
    ]);
    await auditar(cliente, autor, 'beneficio_alterado', 'beneficio', id, { campos });
    return comRestam((await cliente.query(`${SQL_BENEFICIOS} WHERE b.id = $1`, [id])).rows[0]);
  });
}

async function conferirBeneficios(cliente, edicaoId, ids) {
  const unicos = [...new Set((ids || []).map((x) => v.id(x, 'benefício')))];
  if (!unicos.length) return [];
  const { rows } = await cliente.query('SELECT id FROM beneficios WHERE edicao_id = $1 AND id = ANY($2::bigint[])', [
    edicaoId,
    unicos,
  ]);
  if (rows.length !== unicos.length) throw erro(400, 'benefício que não é desta edição');
  return unicos;
}

// ------------------------------------------------------------------ tipos
function lerLote(l = {}) {
  const inicio = v.dataHora(l.inicio_vendas, { campo: 'o início das vendas' });
  const fim = v.dataHora(l.fim_vendas, { campo: 'o fim das vendas' });
  if (inicio && fim && fim <= inicio) throw erro(400, 'O fim das vendas precisa ser depois do início.');
  return {
    id: l.id ? v.id(l.id, 'lote') : null,
    preco_centavos: v.inteiro(l.preco_centavos, {
      campo: 'o preço',
      min: 500,
      max: 5000000,
      mensagem:
        l.preco_centavos > 5000000
          ? 'O preço máximo é R$ 50.000,00.'
          : 'O preço mínimo é R$ 5,00 (limite do meio de pagamento).',
    }),
    quantidade: v.inteiro(l.quantidade, { campo: 'a quantidade', min: 1, max: 100000 }),
    inicio_vendas: inicio,
    fim_vendas: fim,
    // Benefício que este lote dá (ex.: copão personalizado), ou nenhum.
    beneficio_id: l.beneficio_id ? v.id(l.beneficio_id, 'benefício') : null,
  };
}

function lerTipo(d = {}, parcial = false) {
  const tem = (k) => !parcial || Object.hasOwn(d, k);
  const out = {};
  if (tem('nome')) out.nome = v.texto(d.nome, { campo: 'o nome do ingresso', obrigatorio: true, max: 60 });
  if (tem('descricao')) out.descricao = v.texto(d.descricao, { campo: 'a descrição', max: 500 });
  if (tem('limite_por_comprador')) {
    out.limite_por_comprador = v.inteiro(d.limite_por_comprador, {
      campo: 'o limite por comprador',
      min: 1,
      max: 20,
      obrigatorio: false,
    });
  }
  if (Object.hasOwn(d, 'ativo')) out.ativo = v.booleano(d.ativo, true);
  if (tem('beneficios')) out.beneficios = Array.isArray(d.beneficios) ? d.beneficios : [];
  if (tem('lotes')) {
    if (!Array.isArray(d.lotes) || d.lotes.length < 1 || d.lotes.length > MAX_LOTES) {
      throw erro(400, 'Cada ingresso tem de 1 a 10 lotes.');
    }
    out.lotes = d.lotes.map(lerLote);
  }
  return out;
}

async function nomeLivre(cliente, edicaoId, nome, ignorarId = 0) {
  const { rows } = await cliente.query(
    'SELECT 1 FROM categorias WHERE edicao_id = $1 AND lower(nome) = lower($2) AND id <> $3',
    [edicaoId, nome, ignorarId],
  );
  if (rows.length) throw erro(409, 'Já existe um ingresso com esse nome nesta edição.');
}

async function listarTipos(edicaoId, cliente = null) {
  const q = cliente ? (s, p) => cliente.query(s, p) : consultar;
  const { rows: categorias } = await q('SELECT * FROM categorias WHERE edicao_id = $1 ORDER BY ordem, id', [edicaoId]);
  if (!categorias.length) return [];
  const ids = categorias.map((c) => c.id);
  const db = cliente || { query: (s, p) => consultar(s, p) };
  // Em sequência: com `cliente` (transação) é uma conexão só.
  const lotes = await carregarLotes(db, ids);
  const { rows: benef } = await q(
    `SELECT cb.categoria_id, b.id, b.nome, b.quantidade FROM categoria_beneficios cb JOIN beneficios b ON b.id = cb.beneficio_id
      WHERE cb.categoria_id = ANY($1::bigint[]) ORDER BY b.nome`,
    [ids],
  );
  const { rows: doLote } = await q(`${SQL_BENEFICIOS} WHERE b.edicao_id = $1`, [edicaoId]);
  const beneficioPorId = new Map(doLote.map((b) => [Number(b.id), comRestam(b)]));
  const agora = new Date();
  return categorias.map((c) => {
    const estado = estadoDaCategoria(lotes.get(Number(c.id)) || [], agora);
    return {
      id: c.id,
      nome: c.nome,
      descricao: c.descricao,
      limite_por_comprador: c.limite_por_comprador,
      ativo: c.ativo,
      beneficios: benef
        .filter((b) => Number(b.categoria_id) === Number(c.id))
        .map((b) => ({ id: b.id, nome: b.nome, limitado: Boolean(b.quantidade) })),
      lotes: estado.lotes.map((l, i) => ({
        id: l.id,
        numero: i + 1,
        preco_centavos: l.preco_centavos,
        quantidade: l.quantidade,
        inicio_vendas: l.inicio_vendas,
        fim_vendas: l.fim_vendas,
        pagos: l.pagos,
        reservados: l.reservados,
        disponivel: l.disponivel,
        situacao: l.situacao,
        encerrado_em: l.encerrado_em,
        beneficio: l.beneficio_id ? beneficioPorId.get(Number(l.beneficio_id)) || null : null,
      })),
      disponivel_agora: c.ativo ? estado.disponivelAgora : 0,
      vigente: estado.vigente ? { id: estado.vigente.id, preco_centavos: estado.vigente.preco_centavos } : null,
      proximo_inicio: estado.proximoInicio,
    };
  });
}

async function gravarBeneficiosDoTipo(cliente, categoriaId, ids) {
  await cliente.query('DELETE FROM categoria_beneficios WHERE categoria_id = $1', [categoriaId]);
  for (const b of ids) {
    await cliente.query('INSERT INTO categoria_beneficios (categoria_id, beneficio_id) VALUES ($1, $2)', [
      categoriaId,
      b,
    ]);
  }
}

async function criarTipo(edicaoId, dados, autor) {
  const t = lerTipo(dados);
  return emTransacao(async (cliente) => {
    await edicaoEditavel(cliente, edicaoId);
    await nomeLivre(cliente, edicaoId, t.nome);
    const beneficios = await conferirBeneficios(cliente, edicaoId, t.beneficios);
    await conferirBeneficios(cliente, edicaoId, t.lotes.map((l) => l.beneficio_id).filter(Boolean));
    const { rows } = await cliente.query(
      `INSERT INTO categorias (edicao_id, nome, descricao, limite_por_comprador, ativo, ordem)
       VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(max(ordem), 0) + 1 FROM categorias WHERE edicao_id = $1))
       RETURNING id`,
      [edicaoId, t.nome, t.descricao || '', t.limite_por_comprador ?? null, t.ativo ?? true],
    );
    const id = rows[0].id;
    await gravarBeneficiosDoTipo(cliente, id, beneficios);
    for (const [i, l] of t.lotes.entries()) {
      await cliente.query(
        `INSERT INTO lotes (categoria_id, ordem, preco_centavos, quantidade, inicio_vendas, fim_vendas, beneficio_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, i + 1, l.preco_centavos, l.quantidade, l.inicio_vendas, l.fim_vendas, l.beneficio_id],
      );
    }
    await auditar(cliente, autor, 'tipo_criado', 'categoria', id, { edicao_id: edicaoId, lotes: t.lotes.length });
    return (await listarTipos(edicaoId, cliente)).find((c) => Number(c.id) === Number(id));
  });
}

async function atualizarTipo(id, dados, autor) {
  const t = lerTipo(dados, true);
  return emTransacao(async (cliente) => {
    const { rows: atualRows } = await cliente.query('SELECT * FROM categorias WHERE id = $1', [id]);
    const atual = atualRows[0];
    if (!atual) throw erro(404, 'ingresso não encontrado');
    await edicaoEditavel(cliente, atual.edicao_id);
    if (t.nome !== undefined) await nomeLivre(cliente, atual.edicao_id, t.nome, id);
    const campos = ['nome', 'descricao', 'limite_por_comprador', 'ativo'].filter((k) => t[k] !== undefined);
    if (campos.length) {
      await cliente.query(
        `UPDATE categorias SET ${campos.map((k, i) => `${k} = $${i + 2}`).join(', ')}, atualizado_em = now() WHERE id = $1`,
        [id, ...campos.map((k) => t[k])],
      );
    }
    if (t.beneficios !== undefined) {
      await gravarBeneficiosDoTipo(cliente, id, await conferirBeneficios(cliente, atual.edicao_id, t.beneficios));
    }
    if (t.lotes !== undefined) {
      await conferirBeneficios(cliente, atual.edicao_id, t.lotes.map((l) => l.beneficio_id).filter(Boolean));
      await gravarLotes(cliente, atual, t.lotes);
    }
    await auditar(cliente, autor, 'tipo_alterado', 'categoria', id, {
      campos: [...campos, ...(t.beneficios !== undefined ? ['beneficios'] : []), ...(t.lotes ? ['lotes'] : [])],
    });
    return (await listarTipos(atual.edicao_id, cliente)).find((c) => Number(c.id) === Number(id));
  });
}

// Lista desejada de lotes: os que vieram com id são alterados (sem descer
// abaixo do vendido; lote fechado não muda), os sem id entram no fim, e os
// que sumiram da lista só saem se nunca tiveram venda (RN-T09).
async function gravarLotes(cliente, categoria, desejados) {
  const lotes = (await carregarLotes(cliente, [Number(categoria.id)])).get(Number(categoria.id)) || [];
  const estado = estadoDaCategoria(lotes);
  const porId = new Map(estado.lotes.map((l) => [Number(l.id), l]));
  const mantidos = new Set();
  for (const d of desejados) {
    if (!d.id) continue;
    const l = porId.get(Number(d.id));
    if (!l) throw erro(400, 'lote que não é deste ingresso');
    mantidos.add(Number(d.id));
    const t = (x) => (x ? new Date(x).getTime() : null);
    const mudou =
      l.preco_centavos !== d.preco_centavos ||
      l.quantidade !== d.quantidade ||
      t(l.inicio_vendas) !== t(d.inicio_vendas) ||
      t(l.fim_vendas) !== t(d.fim_vendas);
    // O benefício do lote pode mudar a qualquer hora (vale para os próximos
    // ingressos emitidos; os já emitidos guardam o que receberam).
    if (Number(l.beneficio_id || 0) !== Number(d.beneficio_id || 0)) {
      await cliente.query('UPDATE lotes SET beneficio_id = $2 WHERE id = $1', [d.id, d.beneficio_id]);
    }
    if (!mudou) continue;
    if (l.encerrado_em) throw erro(409, 'Lote encerrado não muda.');
    if (d.quantidade < l.vendidos) {
      throw erro(409, `A quantidade não pode ficar abaixo do que já foi vendido ou reservado (${l.vendidos}).`);
    }
    await cliente.query(
      'UPDATE lotes SET preco_centavos = $2, quantidade = $3, inicio_vendas = $4, fim_vendas = $5 WHERE id = $1',
      [d.id, d.preco_centavos, d.quantidade, d.inicio_vendas, d.fim_vendas],
    );
  }
  for (const l of estado.lotes) {
    if (mantidos.has(Number(l.id))) continue;
    const { rows } = await cliente.query('SELECT 1 FROM reservas WHERE lote_id = $1 LIMIT 1', [l.id]);
    if (rows.length) throw erro(409, 'Não dá para apagar lote com venda — encerre o lote.');
    await cliente.query('DELETE FROM lotes WHERE id = $1', [l.id]);
  }
  let ordem = lotes.reduce((m, l) => Math.max(m, l.ordem), 0);
  for (const d of desejados) {
    if (d.id) continue;
    ordem += 1;
    await cliente.query(
      `INSERT INTO lotes (categoria_id, ordem, preco_centavos, quantidade, inicio_vendas, fim_vendas, beneficio_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [categoria.id, ordem, d.preco_centavos, d.quantidade, d.inicio_vendas, d.fim_vendas, d.beneficio_id],
    );
  }
  const { rows: total } = await cliente.query('SELECT count(*)::int AS n FROM lotes WHERE categoria_id = $1', [
    categoria.id,
  ]);
  if (total[0].n < 1 || total[0].n > MAX_LOTES) throw erro(400, 'Cada ingresso tem de 1 a 10 lotes.');
}

async function encerrarLote(id, autor) {
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT l.*, c.edicao_id FROM lotes l JOIN categorias c ON c.id = l.categoria_id WHERE l.id = $1',
      [id],
    );
    const lote = rows[0];
    if (!lote) throw erro(404, 'lote não encontrado');
    await edicaoEditavel(cliente, lote.edicao_id);
    if (lote.encerrado_em) throw erro(409, 'Esse lote já está encerrado.');
    await cliente.query("UPDATE lotes SET encerrado_em = now(), motivo_encerramento = 'manual' WHERE id = $1", [id]);
    await auditar(cliente, autor, 'lote_encerrado', 'lote', id, { categoria_id: lote.categoria_id });
    return (await listarTipos(lote.edicao_id, cliente)).find((c) => Number(c.id) === Number(lote.categoria_id));
  });
}

module.exports = {
  listarBeneficios,
  criarBeneficio,
  atualizarBeneficio,
  listarTipos,
  criarTipo,
  atualizarTipo,
  encerrarLote,
  conferirBeneficios,
  edicaoEditavel,
};
