const { consultar } = require('./db/conexao');
const { erro } = require('./lib/erros');
const { edicaoPorEndereco, termosVigentes, MAX_INGRESSOS } = require('./pedidos');
const { listarTipos } = require('./catalogo');
const { listarPromocoes } = require('./promocoes');

// O que a página pública da edição recebe (§6 do pedido de 09/11/2026).
// Só o que o comprador precisa: nada de quantidade em estoque, número de
// vendidos, id de lote ou dado administrativo. Rascunho não existe para
// o público (404).

const SITUACAO_TIPO = {
  a_venda: 'À venda',
  esgotado: 'Esgotado',
  em_breve: 'Em breve',
  encerrado: 'Vendas encerradas',
  indisponivel: 'Indisponível',
};

function situacaoDoTipo(t) {
  if (!t.ativo) return 'indisponivel';
  if (t.disponivel_agora > 0) return 'a_venda';
  if (t.proximo_inicio) return 'em_breve';
  const temAberto = t.lotes.some((l) => !['esgotado', 'encerrado'].includes(l.situacao));
  if (!temAberto && t.lotes.every((l) => l.situacao === 'encerrado')) return 'encerrado';
  return 'esgotado';
}

async function edicaoPublica(evento, edicao) {
  const cliente = { query: (s, p) => consultar(s, p) };
  const ed = await edicaoPorEndereco(cliente, evento, edicao);
  if (!ed || ed.status === 'rascunho') throw erro(404, 'evento não encontrado');
  const [{ rows: imagens }, termos, tipos, promos] = await Promise.all([
    consultar('SELECT tipo, url FROM edicao_imagens WHERE edicao_id = $1 ORDER BY tipo, ordem, id', [ed.id]),
    consultar('SELECT id, tipo, versao, texto FROM termos WHERE edicao_id = $1 AND vigente', [ed.id]),
    listarTipos(ed.id),
    listarPromocoes(ed.id),
  ]);
  const vendaAberta = ed.status === 'publicado';
  const textos = Object.fromEntries(termos.rows.map((t) => [t.tipo, { id: t.id, versao: t.versao, texto: t.texto }]));
  return {
    evento: { nome: ed.evento_nome, slug: ed.evento_slug },
    edicao: {
      nome: ed.nome,
      slug: ed.slug,
      descricao: ed.descricao,
      inicio_em: ed.inicio_em,
      fim_em: ed.fim_em,
      local: ed.local_nome
        ? {
            nome: ed.local_nome,
            logradouro: ed.logradouro,
            numero: ed.numero,
            complemento: ed.complemento,
            bairro: ed.bairro,
            cidade: ed.cidade,
            uf: ed.uf,
            cep: ed.cep,
          }
        : null,
      classificacao_etaria: ed.classificacao_etaria,
      status: ed.status,
      banner: imagens.find((i) => i.tipo === 'banner')?.url || null,
      galeria: imagens.filter((i) => i.tipo === 'galeria').map((i) => i.url),
    },
    venda_aberta: vendaAberta,
    mensagem: vendaAberta ? null : ed.status === 'pausado' ? 'Vendas pausadas no momento.' : 'Vendas encerradas.',
    textos,
    // O carrinho respeita também o limite por CPF da edição (o servidor
    // confere de novo, somando o que o CPF já tem).
    max_ingressos_por_pedido: Math.min(MAX_INGRESSOS, ed.limite_por_cpf || MAX_INGRESSOS),
    limite_por_cpf: ed.limite_por_cpf || null,
    tipos: tipos.map((t) => {
      const situacao = vendaAberta ? situacaoDoTipo(t) : 'indisponivel';
      const vigente = t.lotes.find((l) => l.situacao === 'a_venda');
      const seguinte = vigente ? t.lotes.find((l) => l.numero > vigente.numero && !l.encerrado_em) : null;
      const brinde = vigente?.beneficio;
      return {
        id: t.id,
        nome: t.nome,
        descricao: t.descricao,
        beneficios: t.beneficios.map((b) => b.nome),
        // Algum benefício do tipo tem quantidade: a página avisa que é
        // "enquanto durar o estoque" (a unidade só é separada no pagamento).
        beneficios_limitados: t.beneficios.some((b) => b.limitado),
        situacao,
        situacao_rotulo: SITUACAO_TIPO[situacao],
        preco_centavos: vigente?.preco_centavos ?? null,
        lote: vigente ? `${vigente.numero}º lote` : null,
        proximo_lote: seguinte ? { lote: `${seguinte.numero}º lote`, preco_centavos: seguinte.preco_centavos } : null,
        // Benefício do lote vigente, enquanto houver (ex.: copão personalizado).
        beneficio_do_lote:
          brinde?.ativo && (brinde.restam === null || brinde.restam > 0)
            ? {
                nome: brinde.nome,
                restam: brinde.restam !== null && brinde.restam <= 50 ? brinde.restam : null,
                limitado: brinde.quantidade !== null && brinde.quantidade !== undefined,
              }
            : null,
        // Disponibilidade sem expor o estoque inteiro: "últimas N" perto do fim.
        disponibilidade:
          situacao === 'a_venda'
            ? t.disponivel_agora <= 20
              ? `Últimas ${t.disponivel_agora}`
              : 'Disponível'
            : SITUACAO_TIPO[situacao],
        vendas_ate: vigente?.fim_vendas ?? null,
        proximo_inicio: t.proximo_inicio,
        // Quanto dá para escolher: o menor entre o limite por comprador, o
        // teto do pedido e o que há agora (o número exato não aparece).
        max_quantidade:
          situacao === 'a_venda'
            ? Math.min(t.disponivel_agora, t.limite_por_comprador || MAX_INGRESSOS, MAX_INGRESSOS)
            : 0,
        limite_por_comprador: t.limite_por_comprador,
      };
    }),
    combos: promos
      .filter((p) => p.ativo)
      .map((p) => ({
        id: p.id,
        nome: p.nome,
        descricao: p.descricao,
        preco_total_centavos: p.preco_total_centavos,
        ingressos: p.itens.map((i) => ({
          categoria: i.categoria_nome,
          quantidade: i.quantidade,
          beneficio: i.beneficio_nome,
          beneficio_limitado: Boolean(i.beneficio_nome && i.beneficio_limitado),
        })),
        ingressos_por_combo: p.ingressos_por_combo,
        situacao: vendaAberta ? p.situacao : 'indisponivel',
        valida_ate: p.fim,
        max_quantidade:
          vendaAberta && p.situacao === 'a_venda'
            ? Math.min(p.disponiveis, Math.floor(MAX_INGRESSOS / p.ingressos_por_combo), 10)
            : 0,
      })),
  };
}

// Título e imagem para o compartilhamento (og:*), com escape no servidor.
async function metaDaEdicao(evento, edicao) {
  try {
    const cliente = { query: (s, p) => consultar(s, p) };
    const ed = await edicaoPorEndereco(cliente, evento, edicao);
    if (!ed || ed.status === 'rascunho') return null;
    const { rows } = await consultar("SELECT url FROM edicao_imagens WHERE edicao_id = $1 AND tipo = 'banner'", [
      ed.id,
    ]);
    return {
      titulo: `${ed.evento_nome} — ${ed.nome}`,
      descricao: (ed.descricao || '').slice(0, 200),
      imagem: rows[0]?.url || null,
    };
  } catch {
    return null;
  }
}

module.exports = { edicaoPublica, metaDaEdicao, termosVigentes };
