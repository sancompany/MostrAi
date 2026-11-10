const { consultar } = require('./db/conexao');

// Home pública da TICK (/tic/eventos — pedido do dono, 10/11/2026): os
// eventos vêm do mesmo cadastro do Admin (Eventos → Criar evento); não há
// segundo cadastro. Entram só as edições publicadas (ou com venda pausada)
// que ainda não terminaram; rascunho e encerrada nunca aparecem.

const LIMITE = 60;

// Busca simples por nome do evento, da edição, do local ou da cidade. Os
// curingas do LIKE digitados pela pessoa valem como texto.
function termoDeBusca(q) {
  const t = String(q ?? '')
    .trim()
    .slice(0, 80);
  return t ? `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
}

async function listarEventos({ busca = '' } = {}) {
  const termo = termoDeBusca(busca);
  const { rows } = await consultar(
    `SELECT ev.nome AS evento, ev.slug AS evento_slug, ed.nome AS edicao, ed.slug AS edicao_slug,
            ed.inicio_em, ed.fim_em, ed.local_nome, ed.cidade, ed.uf, ed.status, ed.classificacao_etaria,
            (SELECT url FROM edicao_imagens im WHERE im.edicao_id = ed.id AND im.tipo = 'banner' LIMIT 1) AS banner,
            (SELECT url FROM edicao_imagens im WHERE im.edicao_id = ed.id AND im.tipo = 'logo' LIMIT 1) AS logo
       FROM edicoes ed JOIN eventos ev ON ev.id = ed.evento_id
      WHERE ed.status IN ('publicado', 'pausado')
        AND (COALESCE(ed.fim_em, ed.inicio_em + interval '12 hours') IS NULL
             OR COALESCE(ed.fim_em, ed.inicio_em + interval '12 hours') > now())
        AND ($1::text IS NULL OR (ev.nome || ' ' || ed.nome || ' ' || COALESCE(ed.local_nome, '') || ' ' ||
                                  COALESCE(ed.cidade, '')) ILIKE $1)
      ORDER BY ed.inicio_em NULLS LAST, ed.id
      LIMIT ${LIMITE}`,
    [termo],
  );
  return rows.map((r) => ({
    evento: r.evento,
    edicao: r.edicao,
    inicio_em: r.inicio_em,
    local: [r.local_nome, r.cidade && `${r.cidade}${r.uf ? `/${r.uf}` : ''}`].filter(Boolean).join(' · ') || null,
    banner: r.banner,
    logo: r.logo,
    classificacao_etaria: r.classificacao_etaria,
    vendas_pausadas: r.status === 'pausado',
    // A página individual de venda é a de sempre (/ticket/<evento>/<edição>).
    endereco: `/ticket/${encodeURIComponent(r.evento_slug)}/${encodeURIComponent(r.edicao_slug)}`,
  }));
}

module.exports = { listarEventos, termoDeBusca };
