const { emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { codigoIngresso, codigoCurto } = require('./lib/codigos');
const { auditar, historicoDoIngresso, medir } = require('./lib/registro');
const { travarEdicao } = require('./eventos');
const { ocupacaoDaEdicao } = require('./disponibilidade');

// Emissão de ingresso individual (regras duras 1 a 7). O mesmo mecanismo
// serve ao pedido pago (na confirmação legítima do pagamento) e à cortesia.
// Quem chama já segura a trava da edição.

async function codigoCurtoLivre(cliente, edicaoId) {
  for (let i = 0; i < 8; i++) {
    const c = codigoCurto();
    const { rows } = await cliente.query('SELECT 1 FROM ingressos WHERE edicao_id = $1 AND codigo_curto = $2', [
      edicaoId,
      c,
    ]);
    if (!rows.length) return c;
  }
  throw new Error('não foi possível sortear um código curto livre');
}

// Benefícios do ingresso: os do tipo, o do LOTE e o extra (promoção ou
// cortesia), sem repetir o mesmo benefício. Benefício com quantidade só vai
// enquanto houver: a linha do benefício é travada e o que já foi dado (em
// ingresso não cancelado) é contado antes — nunca passa do estoque. Cópia do
// nome no momento da emissão (RN-T15).
async function gravarBeneficios(cliente, ingressoId, categoriaId, extraId, origemExtra, loteId = null) {
  const { rows } = await cliente.query(
    `SELECT b.id, b.nome FROM categoria_beneficios cb JOIN beneficios b ON b.id = cb.beneficio_id
      WHERE cb.categoria_id = $1 AND b.ativo`,
    [categoriaId],
  );
  const lista = rows.map((b) => ({ ...b, origem: 'categoria' }));
  const somar = async (id, origem) => {
    if (!id || lista.some((b) => Number(b.id) === Number(id))) return;
    const { rows: extra } = await cliente.query('SELECT id, nome FROM beneficios WHERE id = $1 AND ativo', [id]);
    if (extra[0]) lista.push({ ...extra[0], origem });
  };
  if (loteId) {
    const { rows: l } = await cliente.query('SELECT beneficio_id FROM lotes WHERE id = $1', [loteId]);
    await somar(l[0]?.beneficio_id, 'lote');
  }
  await somar(extraId, origemExtra);
  for (const b of lista) {
    const { rows: trava } = await cliente.query('SELECT quantidade FROM beneficios WHERE id = $1 FOR UPDATE', [b.id]);
    if (trava[0]?.quantidade) {
      const { rows: dados } = await cliente.query(
        `SELECT count(*)::int AS n FROM ingresso_beneficios ib JOIN ingressos i ON i.id = ib.ingresso_id
          WHERE ib.beneficio_id = $1 AND (i.status <> 'cancelado' OR ib.resgatado_em IS NOT NULL)`,
        [b.id],
      );
      if (dados[0].n >= trava[0].quantidade) continue;
    }
    await cliente.query(
      'INSERT INTO ingresso_beneficios (ingresso_id, beneficio_id, nome, origem) VALUES ($1, $2, $3, $4)',
      [ingressoId, b.id, b.nome, b.origem],
    );
  }
}

// Emite os ingressos de um pedido que acabou de virar pago, um por vaga.
// Idempotente: a vaga que já tem ingresso é pulada (ingressos.reserva_id é
// único — reenvio de aviso nunca emite em dobro).
async function emitirDoPedido(cliente, pedido, { autor = 'pagamento' } = {}) {
  const { rows: vagas } = await cliente.query(
    `SELECT r.*, pi.promocao_id, prit.beneficio_id AS beneficio_promocional
       FROM reservas r JOIN pedido_itens pi ON pi.id = r.pedido_item_id
       LEFT JOIN promocao_itens prit ON prit.id = r.promocao_item_id
       LEFT JOIN ingressos i ON i.reserva_id = r.id
      WHERE r.pedido_id = $1 AND i.id IS NULL
      ORDER BY pi.ordem, r.posicao`,
    [pedido.id],
  );
  const emitidos = [];
  for (const r of vagas) {
    const { rows } = await cliente.query(
      `INSERT INTO ingressos (codigo, codigo_curto, edicao_id, categoria_id, lote_id, promocao_id, pedido_id,
          reserva_id, participante_id, origem, valor_centavos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pago', $10)
       ON CONFLICT (reserva_id) DO NOTHING RETURNING id`,
      [
        codigoIngresso(),
        await codigoCurtoLivre(cliente, pedido.edicao_id),
        pedido.edicao_id,
        r.categoria_id,
        r.lote_id,
        r.promocao_id,
        pedido.id,
        r.id,
        r.participante_id,
        r.valor_centavos,
      ],
    );
    if (!rows[0]) continue;
    const ingressoId = rows[0].id;
    await gravarBeneficios(cliente, ingressoId, r.categoria_id, r.beneficio_promocional, 'promocao', r.lote_id);
    await historicoDoIngresso(cliente, ingressoId, 'emitido', { autor });
    await medir(cliente, 'emissao:ingresso_emite', pedido.edicao_id, {
      origem: 'pago',
      teste: pedido.origem === 'teste',
      categoria_id: r.categoria_id,
      promocao_id: r.promocao_id || null,
    });
    emitidos.push(ingressoId);
  }
  return emitidos;
}

const CLASSIFICACOES = ['convidado', 'equipe', 'patrocinador', 'promocional'];

// Cortesia (RN-T20): ingresso gratuito, fora de qualquer receita; conta na
// capacidade, não no lote nem no limite por comprador.
async function emitirCortesia(edicaoId, dados, autor) {
  const nome = v.texto(dados?.nome, { campo: 'o nome do participante', obrigatorio: true, min: 2, max: 120 });
  const cpf = v.cpf(dados?.cpf);
  const email = v.email(dados?.email);
  const categoriaId = v.id(dados?.categoria_id, 'ingresso');
  const beneficioId = dados?.beneficio_id ? v.id(dados.beneficio_id, 'benefício') : null;
  const classificacao = v.escolha(dados?.classificacao, CLASSIFICACOES, {
    mensagem: 'classificação da cortesia inválida',
  });
  const chave = v.chave(dados?.chave);
  return emTransacao(async (cliente) => {
    const ed = await travarEdicao(cliente, edicaoId);
    const { rows: repetida } = await cliente.query(
      'SELECT i.id FROM cortesias c JOIN ingressos i ON i.cortesia_id = c.id WHERE c.chave_idempotencia = $1',
      [chave],
    );
    if (repetida[0]) return { ingresso_id: repetida[0].id, repetida: true };
    if (ed.status === 'encerrado') throw erro(409, 'Edição encerrada fica só para consulta.');
    const { rows: cat } = await cliente.query('SELECT id FROM categorias WHERE id = $1 AND edicao_id = $2', [
      categoriaId,
      edicaoId,
    ]);
    if (!cat[0]) throw erro(400, 'ingresso que não é desta edição');
    if (beneficioId) {
      const { rows: b } = await cliente.query('SELECT 1 FROM beneficios WHERE id = $1 AND edicao_id = $2', [
        beneficioId,
        edicaoId,
      ]);
      if (!b[0]) throw erro(400, 'benefício que não é desta edição');
    }
    if (ed.capacidade && (await ocupacaoDaEdicao(cliente, edicaoId)) + 1 > ed.capacidade) {
      throw erro(409, 'Não há mais vaga nesta edição.', { codigo: 'esgotado' });
    }
    const { rows: part } = await cliente.query(
      'INSERT INTO participantes (edicao_id, nome, cpf, email) VALUES ($1, $2, $3, $4) RETURNING id',
      [edicaoId, nome, cpf, email],
    );
    const { rows: cort } = await cliente.query(
      `INSERT INTO cortesias (edicao_id, classificacao, emitida_por, emitida_por_access, chave_idempotencia)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [edicaoId, classificacao, autor?.autor || 'admin', autor?.autorAccess || null, chave],
    );
    const { rows } = await cliente.query(
      `INSERT INTO ingressos (codigo, codigo_curto, edicao_id, categoria_id, cortesia_id, participante_id, origem, valor_centavos)
       VALUES ($1, $2, $3, $4, $5, $6, 'cortesia', 0) RETURNING id`,
      [codigoIngresso(), await codigoCurtoLivre(cliente, edicaoId), edicaoId, categoriaId, cort[0].id, part[0].id],
    );
    const ingressoId = rows[0].id;
    await gravarBeneficios(cliente, ingressoId, categoriaId, beneficioId, 'cortesia');
    await historicoDoIngresso(cliente, ingressoId, 'emitido', {
      motivo: `cortesia: ${classificacao}`,
      autor: autor?.autor,
    });
    await auditar(cliente, autor, 'cortesia_emitida', 'ingresso', ingressoId, { edicao_id: edicaoId, classificacao });
    await medir(cliente, 'emissao:ingresso_emite', edicaoId, {
      origem: 'cortesia',
      categoria_id: categoriaId,
      classificacao,
    });
    return { ingresso_id: ingressoId, repetida: false };
  });
}

// Cancelar cortesia emitida por engano (RN-T21): o QR deixa de valer na hora
// e a vaga volta para a capacidade. Ingresso pago não se cancela por aqui.
async function cancelarCortesia(ingressoId, motivo, autor) {
  const m = v.texto(motivo, {
    campo: 'o motivo',
    obrigatorio: true,
    max: 200,
    mensagem: 'Informe o motivo do cancelamento.',
  });
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      `SELECT i.*, c.classificacao FROM ingressos i LEFT JOIN cortesias c ON c.id = i.cortesia_id
        WHERE i.id = $1 FOR UPDATE OF i`,
      [ingressoId],
    );
    const ing = rows[0];
    if (!ing) throw erro(404, 'ingresso não encontrado');
    if (ing.origem !== 'cortesia') throw erro(409, 'Só cortesia se cancela por aqui.');
    if (ing.status === 'cancelado') throw erro(409, 'Essa cortesia já está cancelada.');
    await cliente.query(
      "UPDATE ingressos SET status = 'cancelado', motivo_status = $2, atualizado_em = now() WHERE id = $1",
      [ingressoId, m],
    );
    await historicoDoIngresso(cliente, ingressoId, 'cancelado', { motivo: m, autor: autor?.autor });
    await auditar(cliente, autor, 'cortesia_cancelada', 'ingresso', ingressoId, { edicao_id: ing.edicao_id });
    await medir(cliente, 'emissao:cortesia_cancela', ing.edicao_id, { classificacao: ing.classificacao });
    return { ok: true };
  });
}

module.exports = { emitirDoPedido, emitirCortesia, cancelarCortesia, CLASSIFICACOES };
