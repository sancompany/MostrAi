const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { codigoPublico, hashTexto, token } = require('./lib/codigos');
const { auditar, medir } = require('./lib/registro');
const armazenamento = require('./armazenamento');
const { tipoDaImagem, EXTENSAO } = require('../lib/imagem');

// Evento e edição (T1 e T1a; RN-T01 a RN-T07). Evento é a marca
// ("TREEMUNDO"); edição é a ocorrência vendável ("EDITION01"), com data,
// local, textos versionados, imagens e status.

const TEXTOS = ['regras_entrada', 'condicoes_especiais', 'termos_compra'];
const ROTULO_TEXTO = {
  regras_entrada: 'regras de entrada',
  condicoes_especiais: 'condições especiais',
  termos_compra: 'termos e condições de compra',
};
const TRANSICOES = {
  rascunho: ['publicado', 'encerrado'],
  publicado: ['pausado', 'encerrado'],
  pausado: ['publicado', 'encerrado'],
  encerrado: [],
};
const MAX_IMAGEM = 8 * 1024 * 1024;
const MAX_GALERIA = 8;
// Uma por edição: enviar outra substitui (e o arquivo antigo sai do armazenamento).
const IMAGEM_UNICA = ['banner', 'logo'];

function lerLocal(local) {
  if (local === null || local === undefined || local === '') return null;
  if (typeof local !== 'object') throw erro(400, 'local inválido');
  const nome = v.opcional(local.nome, { campo: 'o nome do local', max: 120 });
  if (!nome) return null;
  const cep = String(local.cep ?? '').replace(/\D/g, '');
  if (cep && cep.length !== 8) throw erro(400, 'CEP inválido — use 8 números.');
  const uf = v.opcional(local.uf, { campo: 'a UF', max: 2 });
  if (uf && !/^[A-Za-z]{2}$/.test(uf)) throw erro(400, 'UF inválida.');
  return {
    nome,
    cep: cep || null,
    logradouro: v.opcional(local.logradouro, { campo: 'o endereço', max: 160 }),
    numero: v.opcional(local.numero, { campo: 'o número', max: 20 }),
    complemento: v.opcional(local.complemento, { campo: 'o complemento', max: 80 }),
    bairro: v.opcional(local.bairro, { campo: 'o bairro', max: 80 }),
    cidade: v.opcional(local.cidade, { campo: 'a cidade', max: 80 }),
    uf: uf ? uf.toUpperCase() : null,
  };
}

// Campos da edição que vêm do formulário; `parcial` = PATCH (só o que veio).
function lerEdicao(e = {}, { parcial = false } = {}) {
  const tem = (k) => !parcial || Object.hasOwn(e, k);
  const out = {};
  if (tem('nome')) out.nome = v.texto(e.nome, { campo: 'o nome da edição', obrigatorio: true, max: 120 });
  // Vazio = automático: na criação, o endereço sai do nome (enderecoLivre);
  // na edição, o que já existe fica.
  if (tem('slug')) out.slug = String(e.slug ?? '').trim() ? v.slugEdicao(e.slug) : undefined;
  if (tem('descricao')) out.descricao = v.texto(e.descricao, { campo: 'a descrição', max: 5000 });
  if (tem('inicio_em')) out.inicio_em = v.dataHora(e.inicio_em, { campo: 'a data de início' });
  if (tem('fim_em')) out.fim_em = v.dataHora(e.fim_em, { campo: 'a data de término' });
  if (tem('local')) out.local = lerLocal(e.local);
  if (tem('classificacao_etaria')) {
    // Opcional no rascunho (só a publicação exige — faltaParaPublicar).
    out.classificacao_etaria =
      e.classificacao_etaria === undefined || e.classificacao_etaria === null || e.classificacao_etaria === ''
        ? null
        : v.escolha(String(e.classificacao_etaria), ['livre', '10', '12', '14', '16', '18'], {
            mensagem: 'classificação etária inválida',
          });
  }
  if (tem('capacidade')) {
    out.capacidade = v.inteiro(e.capacidade, {
      campo: 'a capacidade',
      min: 1,
      max: 1000000,
      obrigatorio: false,
    });
  }
  // Ingressos por CPF nesta edição (todos os tipos e combos somados).
  if (tem('limite_por_cpf')) {
    out.limite_por_cpf = v.inteiro(e.limite_por_cpf, {
      campo: 'o limite de ingressos por CPF',
      min: 1,
      max: 100,
      obrigatorio: false,
    });
  }
  if (e.textos !== undefined) {
    if (typeof e.textos !== 'object' || e.textos === null) throw erro(400, 'textos inválidos');
    out.textos = {};
    for (const tipo of TEXTOS) {
      if (Object.hasOwn(e.textos, tipo)) {
        out.textos[tipo] = v.texto(e.textos[tipo], { campo: `o texto de ${ROTULO_TEXTO[tipo]}`, max: 50000 });
      }
    }
  }
  return out;
}

function conferirDatas(inicio, fim) {
  if (inicio && fim && fim <= inicio) throw erro(400, 'O término precisa ser depois do início.');
  if (!inicio && fim) throw erro(400, 'Informe o início antes do término.');
}

async function gravarTexto(cliente, edicaoId, tipo, texto, autor) {
  const { rows } = await cliente.query(
    'SELECT id, texto, versao FROM termos WHERE edicao_id = $1 AND tipo = $2 AND vigente',
    [edicaoId, tipo],
  );
  const atual = rows[0];
  if (atual && atual.texto === texto) return null;
  if (atual) await cliente.query('UPDATE termos SET vigente = false WHERE id = $1', [atual.id]);
  if (!texto) return null; // condições especiais podem ficar vazias: sai a vigente
  const { rows: max } = await cliente.query(
    'SELECT COALESCE(max(versao), 0) + 1 AS versao FROM termos WHERE edicao_id = $1 AND tipo = $2',
    [edicaoId, tipo],
  );
  const versao = max[0].versao;
  await cliente.query(
    `INSERT INTO termos (edicao_id, tipo, versao, texto, hash_sha256, publicado_por)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [edicaoId, tipo, versao, texto, hashTexto(texto), autor?.autor || 'admin'],
  );
  return { tipo, versao };
}

async function slugEventoLivre(cliente, slug, ignorarId = null) {
  const { rows } = await cliente.query('SELECT id FROM eventos WHERE lower(slug) = lower($1) AND id <> $2', [
    slug,
    ignorarId || 0,
  ]);
  if (rows.length) throw erro(409, 'Esse endereço já é de outro evento.');
}

async function slugEdicaoLivre(cliente, eventoId, slug, ignorarId = null) {
  const { rows } = await cliente.query(
    'SELECT id FROM edicoes WHERE evento_id = $1 AND lower(slug) = lower($2) AND id <> $3',
    [eventoId, slug, ignorarId || 0],
  );
  if (rows.length) throw erro(409, 'Essa edição já existe neste evento.');
}

// Endereço público gerado pelo nome ("Festa de Verão" → "festa-de-verao"),
// quando o Admin não escreve um nas configurações avançadas. Colisão ganha
// número no fim (festa-de-verao-2, -3...). Com a trava por endereço-base,
// duas criações simultâneas com o mesmo nome não escolhem o mesmo.
const TRAVA_ENDERECO = 872029;

function paraEndereco(texto, max) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

async function enderecoLivre(cliente, { base, max, chave, existe }) {
  await cliente.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [TRAVA_ENDERECO, `${chave}:${base}`]);
  for (let n = 1; n <= 1000; n++) {
    const fim = n === 1 ? '' : `-${n}`;
    const candidato = `${base.slice(0, max - fim.length).replace(/-+$/, '')}${fim}`;
    if (!(await existe(candidato))) return candidato;
  }
  throw erro(409, 'Não foi possível gerar um endereço livre — escreva um nas configurações avançadas.');
}

function baseDoEvento(nome) {
  let base = paraEndereco(nome, 60);
  if (base.length < 3) base = base ? `${base}-evento` : 'evento';
  if (v.RESERVADOS.has(base)) base = `${base}-evento`;
  return base;
}

async function enderecoDoEvento(cliente, nome) {
  return enderecoLivre(cliente, {
    base: baseDoEvento(nome),
    max: 60,
    chave: 'evento',
    existe: async (slug) =>
      (await cliente.query('SELECT 1 FROM eventos WHERE lower(slug) = lower($1)', [slug])).rows.length > 0,
  });
}

async function enderecoDaEdicao(cliente, eventoId, nome) {
  return enderecoLivre(cliente, {
    base: paraEndereco(nome, 40) || 'edicao',
    max: 40,
    chave: `edicao:${eventoId}`,
    existe: async (slug) =>
      (await cliente.query('SELECT 1 FROM edicoes WHERE evento_id = $1 AND lower(slug) = lower($2)', [eventoId, slug]))
        .rows.length > 0,
  });
}

const COLUNAS_LOCAL = ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf'];

async function criarEdicao(corpo, autor) {
  const dadosEvento = corpo?.evento || {};
  const e = lerEdicao(corpo?.edicao || {});
  conferirDatas(e.inicio_em, e.fim_em);
  return emTransacao(async (cliente) => {
    let eventoId;
    if (dadosEvento.id) {
      const { rows } = await cliente.query('SELECT id FROM eventos WHERE id = $1', [v.id(dadosEvento.id, 'evento')]);
      if (!rows.length) throw erro(404, 'evento não encontrado');
      eventoId = rows[0].id;
    } else {
      const nome = v.texto(dadosEvento.nome, {
        campo: 'o nome do evento',
        obrigatorio: true,
        max: 120,
        mensagem: 'Preencha o nome do evento.',
      });
      let slug;
      if (String(dadosEvento.slug ?? '').trim()) {
        slug = v.slugEvento(dadosEvento.slug);
        await slugEventoLivre(cliente, slug);
      } else {
        slug = await enderecoDoEvento(cliente, nome);
      }
      const { rows } = await cliente.query('INSERT INTO eventos (nome, slug) VALUES ($1, $2) RETURNING id', [
        nome,
        slug,
      ]);
      eventoId = rows[0].id;
      await auditar(cliente, autor, 'evento_criado', 'evento', eventoId, { slug });
    }
    if (e.slug) await slugEdicaoLivre(cliente, eventoId, e.slug);
    else e.slug = await enderecoDaEdicao(cliente, eventoId, e.nome);
    const l = e.local || {};
    const { rows } = await cliente.query(
      `INSERT INTO edicoes (evento_id, nome, slug, codigo_publico, descricao, inicio_em, fim_em, local_nome,
         cep, logradouro, numero, complemento, bairro, cidade, uf, classificacao_etaria, capacidade, limite_por_cpf)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
      [
        eventoId,
        e.nome,
        e.slug,
        codigoPublico(),
        e.descricao || '',
        e.inicio_em,
        e.fim_em,
        l.nome || null,
        ...COLUNAS_LOCAL.map((c) => l[c] || null),
        e.classificacao_etaria ?? null,
        e.capacidade ?? null,
        e.limite_por_cpf ?? null,
      ],
    );
    const edicaoId = rows[0].id;
    for (const tipo of TEXTOS) {
      if (e.textos?.[tipo]) await gravarTexto(cliente, edicaoId, tipo, e.textos[tipo], autor);
    }
    await auditar(cliente, autor, 'edicao_criada', 'edicao', edicaoId, { slug: e.slug });
    return obterEdicao(edicaoId, cliente);
  });
}

async function obterEdicao(id, cliente = null) {
  const q = cliente ? (s, p) => cliente.query(s, p) : consultar;
  const { rows } = await q(
    `SELECT ed.*, ev.nome AS evento_nome, ev.slug AS evento_slug
       FROM edicoes ed JOIN eventos ev ON ev.id = ed.evento_id WHERE ed.id = $1`,
    [id],
  );
  const ed = rows[0];
  if (!ed) throw erro(404, 'edição não encontrada');
  // Em sequência: com `cliente` (transação) é uma conexão só.
  const { rows: termos } = await q(
    'SELECT id, tipo, versao, texto, publicado_em FROM termos WHERE edicao_id = $1 AND vigente',
    [id],
  );
  const { rows: imagens } = await q(
    'SELECT id, tipo, url, ordem FROM edicao_imagens WHERE edicao_id = $1 ORDER BY tipo, ordem, id',
    [id],
  );
  const { rows: publicadaAntes } = await q(
    'SELECT 1 FROM edicoes WHERE evento_id = $1 AND publicado_em IS NOT NULL LIMIT 1',
    [ed.evento_id],
  );
  return formatarEdicao(ed, termos, imagens, publicadaAntes.length > 0);
}

function formatarEdicao(ed, termos = [], imagens = [], eventoPublicado = false) {
  const textos = {};
  for (const t of termos) textos[t.tipo] = { id: t.id, versao: t.versao, texto: t.texto, publicado_em: t.publicado_em };
  return {
    id: ed.id,
    evento: { id: ed.evento_id, nome: ed.evento_nome, slug: ed.evento_slug, endereco_travado: eventoPublicado },
    nome: ed.nome,
    slug: ed.slug,
    endereco_publico: `/ticket/${ed.evento_slug}/${ed.slug}`,
    endereco_travado: Boolean(ed.publicado_em),
    descricao: ed.descricao,
    inicio_em: ed.inicio_em,
    fim_em: ed.fim_em,
    local: ed.local_nome
      ? {
          nome: ed.local_nome,
          ...Object.fromEntries(COLUNAS_LOCAL.map((c) => [c, ed[c]])),
        }
      : null,
    classificacao_etaria: ed.classificacao_etaria,
    capacidade: ed.capacidade,
    limite_por_cpf: ed.limite_por_cpf,
    status: ed.status,
    publicado_em: ed.publicado_em,
    encerrado_em: ed.encerrado_em,
    textos,
    banner: imagens.find((i) => i.tipo === 'banner')?.url || null,
    logo: imagens.find((i) => i.tipo === 'logo')?.url || null,
    imagens: imagens.map((i) => ({ id: i.id, tipo: i.tipo, url: i.url })),
  };
}

async function listarEdicoes() {
  const { rows } = await consultar(
    `SELECT ed.id, ed.nome, ed.slug, ed.status, ed.inicio_em, ed.local_nome, ed.criado_em,
            ev.id AS evento_id, ev.nome AS evento_nome, ev.slug AS evento_slug
       FROM edicoes ed JOIN eventos ev ON ev.id = ed.evento_id
      ORDER BY (ed.status = 'encerrado'), ed.criado_em DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    evento: { id: r.evento_id, nome: r.evento_nome, slug: r.evento_slug },
    nome: r.nome,
    slug: r.slug,
    status: r.status,
    inicio_em: r.inicio_em,
    local_nome: r.local_nome,
    endereco_publico: `/ticket/${r.evento_slug}/${r.slug}`,
  }));
}

async function listarEventos() {
  const { rows } = await consultar('SELECT id, nome, slug FROM eventos ORDER BY nome');
  return rows;
}

async function travarEdicao(cliente, id) {
  const { rows } = await cliente.query('SELECT * FROM edicoes WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw erro(404, 'edição não encontrada');
  return rows[0];
}

async function atualizarEdicao(id, corpo, autor) {
  const e = lerEdicao(corpo || {}, { parcial: true });
  return emTransacao(async (cliente) => {
    const atual = await travarEdicao(cliente, id);
    if (atual.status === 'encerrado') throw erro(409, 'Edição encerrada fica só para consulta.');
    const mudou = [];
    if (corpo?.evento && typeof corpo.evento === 'object') {
      const { rows: evRows } = await cliente.query('SELECT * FROM eventos WHERE id = $1 FOR UPDATE', [atual.evento_id]);
      const ev = evRows[0];
      const { rows: publicada } = await cliente.query(
        'SELECT 1 FROM edicoes WHERE evento_id = $1 AND publicado_em IS NOT NULL LIMIT 1',
        [ev.id],
      );
      const campos = {};
      if (Object.hasOwn(corpo.evento, 'nome')) {
        campos.nome = v.texto(corpo.evento.nome, {
          campo: 'o nome do evento',
          obrigatorio: true,
          max: 120,
          mensagem: 'Preencha o nome do evento.',
        });
      }
      // Vazio = fica o endereço que já existe.
      if (Object.hasOwn(corpo.evento, 'slug') && String(corpo.evento.slug ?? '').trim()) {
        const slug = v.slugEvento(corpo.evento.slug);
        if (slug !== ev.slug) {
          if (publicada.length) throw erro(409, 'O endereço não muda depois de publicado.');
          await slugEventoLivre(cliente, slug, ev.id);
          campos.slug = slug;
        }
      }
      if (Object.keys(campos).length) {
        const sets = Object.keys(campos).map((k, i) => `${k} = $${i + 2}`);
        await cliente.query(`UPDATE eventos SET ${sets.join(', ')}, atualizado_em = now() WHERE id = $1`, [
          ev.id,
          ...Object.values(campos),
        ]);
        mudou.push(...Object.keys(campos).map((k) => `evento.${k}`));
      }
    }
    if (e.slug !== undefined && e.slug !== atual.slug) {
      if (atual.publicado_em) throw erro(409, 'O endereço não muda depois de publicado.');
      await slugEdicaoLivre(cliente, atual.evento_id, e.slug, id);
    } else {
      delete e.slug;
    }
    const inicio = e.inicio_em !== undefined ? e.inicio_em : atual.inicio_em;
    const fim = e.fim_em !== undefined ? e.fim_em : atual.fim_em;
    conferirDatas(inicio, fim);
    if (e.capacidade !== undefined && e.capacidade !== null) {
      const ocupacao = await require('./disponibilidade').ocupacaoDaEdicao(cliente, id);
      if (e.capacidade < ocupacao) {
        throw erro(409, `A capacidade não pode ficar abaixo do que já está ocupado (${ocupacao}).`);
      }
    }
    const sets = {};
    for (const k of [
      'nome',
      'slug',
      'descricao',
      'inicio_em',
      'fim_em',
      'classificacao_etaria',
      'capacidade',
      'limite_por_cpf',
    ]) {
      if (e[k] !== undefined) sets[k] = e[k];
    }
    if (e.local !== undefined) {
      const l = e.local || {};
      sets.local_nome = l.nome || null;
      for (const c of COLUNAS_LOCAL) sets[c] = l[c] || null;
    }
    if (Object.keys(sets).length) {
      const lista = Object.keys(sets);
      await cliente.query(
        `UPDATE edicoes SET ${lista.map((k, i) => `${k} = $${i + 2}`).join(', ')}, atualizado_em = now() WHERE id = $1`,
        [id, ...lista.map((k) => sets[k])],
      );
      mudou.push(...lista);
    }
    const versoes = [];
    for (const tipo of TEXTOS) {
      if (e.textos && Object.hasOwn(e.textos, tipo)) {
        const nova = await gravarTexto(cliente, id, tipo, e.textos[tipo], autor);
        if (nova) versoes.push(nova);
      }
    }
    if (mudou.length || versoes.length) {
      await auditar(cliente, autor, 'edicao_alterada', 'edicao', id, { campos: mudou, versoes });
    }
    const ficha = await obterEdicao(id, cliente);
    return { ...ficha, versoes_novas: versoes };
  });
}

function faltaParaPublicar(ed) {
  const falta = [];
  if (!ed.classificacao_etaria) falta.push('classificação etária');
  if (!ed.textos.regras_entrada) falta.push('regras de entrada');
  if (!ed.textos.termos_compra) falta.push('termos e condições de compra');
  return falta;
}

async function mudarStatus(id, status, autor) {
  v.escolha(status, Object.keys(TRANSICOES), { mensagem: 'status inválido' });
  return emTransacao(async (cliente) => {
    const atual = await travarEdicao(cliente, id);
    if (!TRANSICOES[atual.status].includes(status)) {
      throw erro(409, `Não dá para passar de ${atual.status} para ${status}.`);
    }
    if (status === 'publicado') {
      const ficha = await obterEdicao(id, cliente);
      const falta = faltaParaPublicar(ficha);
      if (falta.length) throw erro(422, `Para publicar, falta: ${falta.join(', ')}.`, { falta });
    }
    const primeiraPublicacao = status === 'publicado' && !atual.publicado_em;
    await cliente.query(
      `UPDATE edicoes SET status = $2,
         publicado_em = CASE WHEN $2 = 'publicado' AND publicado_em IS NULL THEN now() ELSE publicado_em END,
         encerrado_em = CASE WHEN $2 = 'encerrado' THEN now() ELSE encerrado_em END,
         atualizado_em = now()
       WHERE id = $1`,
      [id, status],
    );
    await auditar(cliente, autor, 'edicao_status', 'edicao', id, { de: atual.status, para: status });
    if (primeiraPublicacao) {
      await medir(cliente, 'catalogo:edicao_publica', id, {
        data_definida: Boolean(atual.inicio_em),
        local_definido: Boolean(atual.local_nome),
      });
    }
    return obterEdicao(id, cliente);
  });
}

async function adicionarImagem(edicaoId, tipo, arquivo, autor) {
  v.escolha(tipo, [...IMAGEM_UNICA, 'galeria'], { mensagem: 'tipo de imagem inválido' });
  const destino = armazenamento.adaptador();
  if (!destino) throw erro(503, 'imagens não configuradas neste ambiente');
  if (!arquivo?.buffer || arquivo.buffer.length > MAX_IMAGEM)
    throw erro(400, 'Envie uma imagem JPEG, PNG ou WebP de até 8 MB.');
  const mime = tipoDaImagem(arquivo.buffer);
  if (!mime) throw erro(400, 'Envie uma imagem JPEG, PNG ou WebP de até 8 MB.');
  // Conferência antes de gravar o arquivo (e de novo, com a trava, abaixo).
  const conferir = async (q) => {
    const { rows } = await q('SELECT status FROM edicoes WHERE id = $1', [edicaoId]);
    if (!rows[0]) throw erro(404, 'edição não encontrada');
    if (rows[0].status === 'encerrado') throw erro(409, 'Edição encerrada fica só para consulta.');
    if (tipo === 'galeria') {
      const { rows: n } = await q(
        "SELECT count(*) AS n FROM edicao_imagens WHERE edicao_id = $1 AND tipo = 'galeria'",
        [edicaoId],
      );
      if (n[0].n >= MAX_GALERIA) throw erro(409, 'A galeria aceita até 8 imagens.');
    }
  };
  await conferir(consultar);
  const caminho = `edicoes/${edicaoId}/${tipo}-${token().slice(0, 16)}.${EXTENSAO[mime]}`;
  let url;
  try {
    url = await destino.salvar(caminho, arquivo.buffer, mime);
  } catch (err) {
    console.error('trimundi: falha ao salvar imagem:', err.message);
    throw erro(502, 'Não foi possível salvar a imagem agora — tente de novo.');
  }
  const antigos = [];
  const gravar = emTransacao(async (cliente) => {
    // Com a edição travada: dois envios ao mesmo tempo não passam de 8.
    await travarEdicao(cliente, edicaoId);
    await conferir((s, p) => cliente.query(s, p));
    if (IMAGEM_UNICA.includes(tipo)) {
      const { rows } = await cliente.query(
        'DELETE FROM edicao_imagens WHERE edicao_id = $1 AND tipo = $2 RETURNING caminho',
        [edicaoId, tipo],
      );
      antigos.push(...rows.map((r) => r.caminho));
    }
    const { rows } = await cliente.query(
      `INSERT INTO edicao_imagens (edicao_id, tipo, caminho, url, ordem)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(ordem), 0) + 1 FROM edicao_imagens WHERE edicao_id = $1))
       RETURNING id, tipo, url`,
      [edicaoId, tipo, caminho, url],
    );
    await auditar(cliente, autor, 'imagem_enviada', 'edicao', edicaoId, { tipo });
    return rows[0];
  });
  let imagem;
  try {
    imagem = await gravar;
  } catch (err) {
    // Não entrou no banco: o arquivo já salvo não pode ficar órfão.
    await destino.remover(caminho).catch(() => {});
    throw err;
  }
  for (const c of antigos) await destino.remover(c).catch(() => {});
  return imagem;
}

async function removerImagem(imagemId, autor) {
  const removida = await emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      `DELETE FROM edicao_imagens im USING edicoes ed
        WHERE im.id = $1 AND ed.id = im.edicao_id AND ed.status <> 'encerrado'
        RETURNING im.caminho, im.edicao_id, im.tipo`,
      [imagemId],
    );
    if (!rows[0]) throw erro(404, 'imagem não encontrada');
    await auditar(cliente, autor, 'imagem_removida', 'edicao', rows[0].edicao_id, { tipo: rows[0].tipo });
    return rows[0];
  });
  const destino = armazenamento.adaptador();
  if (destino) await destino.remover(removida.caminho).catch(() => {});
  return { ok: true };
}

module.exports = {
  TEXTOS,
  paraEndereco,
  criarEdicao,
  obterEdicao,
  listarEdicoes,
  listarEventos,
  atualizarEdicao,
  mudarStatus,
  adicionarImagem,
  removerImagem,
  travarEdicao,
  faltaParaPublicar,
};
