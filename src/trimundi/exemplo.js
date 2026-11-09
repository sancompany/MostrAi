const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { consultar } = require('./db/conexao');

// Carrega (ou atualiza) uma edição completa a partir de um arquivo de dados —
// hoje a TREEMUNDO / EDITION01, em docs/trimundi/exemplos/. Só fora de
// produção. Idempotente: o que já existe é atualizado pelo nome/endereço,
// nada é duplicado. Lotes de um tipo já criado não mudam por aqui (venda
// pode existir): o Admin cuida disso (RN-T09).
//
//   npm run trimundi:exemplo -- [arquivo.json] [--banner imagem.png] [--publicar]

const AUTOR = { autor: 'carga-de-exemplo', autorAccess: null };
const PADRAO = path.join(__dirname, '..', '..', 'docs', 'trimundi', 'exemplos', 'treemundo-edition01.json');

async function carregar(dados, { banner = null, publicar = false } = {}) {
  if (config.producao()) throw new Error('a carga de exemplo não roda em produção');
  const eventos = require('./eventos');
  const catalogo = require('./catalogo');
  const promocoes = require('./promocoes');
  const passos = [];

  // Evento e edição
  const { rows: ev } = await consultar('SELECT id FROM eventos WHERE lower(slug) = lower($1)', [dados.evento.slug]);
  let edicao;
  const { rows: ed } = ev[0]
    ? await consultar('SELECT id FROM edicoes WHERE evento_id = $1 AND lower(slug) = lower($2)', [
        ev[0].id,
        dados.edicao.slug,
      ])
    : { rows: [] };
  if (!ed[0]) {
    edicao = await eventos.criarEdicao(
      { evento: ev[0] ? { id: ev[0].id } : dados.evento, edicao: dados.edicao },
      AUTOR,
    );
    passos.push(`edição criada (${edicao.endereco_publico})`);
  } else {
    const atual = await eventos.obterEdicao(ed[0].id);
    const { slug, ...semSlug } = dados.edicao;
    edicao = await eventos.atualizarEdicao(atual.id, atual.endereco_travado ? semSlug : dados.edicao, AUTOR);
    passos.push(
      `edição atualizada (${edicao.endereco_publico})${edicao.versoes_novas?.length ? ` — ${edicao.versoes_novas.length} texto(s) em versão nova` : ''}`,
    );
  }

  // Banner (opcional, com armazenamento configurado)
  if (banner) {
    await eventos.adicionarImagem(edicao.id, 'banner', { buffer: fs.readFileSync(banner) }, AUTOR);
    passos.push('banner enviado');
  }

  // Benefícios
  const existentes = new Map((await catalogo.listarBeneficios(edicao.id)).map((b) => [b.nome.toLowerCase(), b]));
  for (const b of dados.beneficios || []) {
    if (existentes.has(b.nome.toLowerCase())) continue;
    existentes.set(b.nome.toLowerCase(), await catalogo.criarBeneficio(edicao.id, b, AUTOR));
    passos.push(`benefício ${b.nome}`);
  }
  const beneficioId = (nome) => {
    const b = existentes.get(String(nome).toLowerCase());
    if (!b) throw new Error(`benefício "${nome}" não está na lista de benefícios`);
    return b.id;
  };

  // Tipos de ingresso
  const tipos = new Map((await catalogo.listarTipos(edicao.id)).map((t) => [t.nome.toLowerCase(), t]));
  for (const t of dados.tipos || []) {
    const corpo = { ...t, beneficios: (t.beneficios || []).map(beneficioId) };
    const atual = tipos.get(t.nome.toLowerCase());
    if (atual) {
      const { lotes, ...semLotes } = corpo;
      tipos.set(t.nome.toLowerCase(), await catalogo.atualizarTipo(atual.id, semLotes, AUTOR));
      passos.push(`ingresso ${t.nome} atualizado (lotes mantidos)`);
    } else {
      tipos.set(t.nome.toLowerCase(), await catalogo.criarTipo(edicao.id, corpo, AUTOR));
      passos.push(`ingresso ${t.nome} com ${t.lotes.length} lote(s)`);
    }
  }

  // Promoções
  const promos = new Set((await promocoes.listarPromocoes(edicao.id)).map((p) => p.nome.toLowerCase()));
  for (const p of dados.promocoes || []) {
    if (promos.has(p.nome.toLowerCase())) continue;
    const itens = p.itens.map((i) => {
      const tipo = tipos.get(String(i.tipo).toLowerCase());
      if (!tipo) throw new Error(`a promoção ${p.nome} cita o ingresso "${i.tipo}", que não existe`);
      return {
        categoria_id: tipo.id,
        quantidade: i.quantidade,
        beneficio_id: i.beneficio ? beneficioId(i.beneficio) : null,
      };
    });
    await promocoes.criarPromocao(edicao.id, { ...p, itens }, AUTOR);
    passos.push(`promoção ${p.nome}`);
  }

  if (publicar) {
    const ficha = await eventos.obterEdicao(edicao.id);
    if (ficha.status === 'rascunho' || ficha.status === 'pausado') {
      await eventos.mudarStatus(edicao.id, 'publicado', AUTOR);
      passos.push('publicada');
    }
  }
  return { edicao_id: edicao.id, endereco: edicao.endereco_publico, passos };
}

if (require.main === module) {
  require('dotenv').config();
  const args = process.argv.slice(2);
  const opcao = (nome) => {
    const i = args.indexOf(nome);
    return i >= 0 ? args[i + 1] : null;
  };
  const arquivo = args.find((a, i) => a.endsWith('.json') && args[i - 1] !== '--banner') || PADRAO;
  const { encerrar } = require('./db/conexao');
  carregar(JSON.parse(fs.readFileSync(arquivo, 'utf8')), {
    banner: opcao('--banner'),
    publicar: args.includes('--publicar'),
  })
    .then(async (r) => {
      console.log(`trimundi: ${r.endereco} (edição ${r.edicao_id})`);
      for (const p of r.passos) console.log(`  · ${p}`);
      await encerrar();
    })
    .catch(async (err) => {
      console.error('trimundi: carga de exemplo falhou:', err.message);
      await encerrar().catch(() => {});
      process.exit(1);
    });
}

module.exports = { carregar, PADRAO };
