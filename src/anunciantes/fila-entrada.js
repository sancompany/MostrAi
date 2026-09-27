const pool = require('../db/pool');
const repo = require('./repository');
const planosRepo = require('../financeiro/planos-repository');
const { criativosComSituacao } = require('./routes');
const { ESTADOS, coberturaDaConta } = require('./entrada-no-ar');

// Visão da operação sobre a entrada no ar (Visão geral do admin): as peças
// aprovadas que ainda não tiveram a primeira exibição confirmada, com o
// MESMO estado que o cliente vê (entrada-no-ar.js via criativosComSituacao).
// Só entra conta que pode veicular — peça de conta sem plano está
// "Aprovada", não esperando nada da rede.
const ESPERANDO = new Set([ESTADOS.PROGRAMADO, ESTADOS.AGUARDANDO, ESTADOS.ATRASADO]);

async function pecasSemPrimeiraExibicao() {
  // Pré-filtro barato no banco: só conta com peça aprovada sem exibição
  // confirmada no contexto atual. O estado exato sai do módulo único.
  const { rows } = await pool.query(
    `SELECT DISTINCT c.anunciante_id
       FROM criativos c JOIN anunciantes a ON a.id = c.anunciante_id
      WHERE c.status = 'aprovado'
        AND (c.ultima_exibicao_em IS NULL OR c.ultima_exibicao_em < COALESCE(c.aprovado_em, c.created_at))
        AND NOT a.conta_propria AND NOT a.suspenso AND a.excluido_em IS NULL
      ORDER BY c.anunciante_id`,
  );
  const itens = [];
  for (const { anunciante_id: contaId } of rows) {
    const conta = await repo.buscarPorId(contaId);
    if (!conta) continue;
    const { criativos } = await criativosComSituacao(conta);
    for (const c of criativos) {
      if (!ESPERANDO.has(c.entrada?.estado)) continue;
      itens.push({
        criativoId: c.id,
        contaId: conta.id,
        conta: conta.nome_empresa,
        thumbnailUrl: c.thumbnail_url,
        aprovadoEm: c.aprovado_em,
        ...c.entrada,
      });
    }
  }
  // Atrasado primeiro, depois quem vence antes.
  return itens.sort(
    (a, b) =>
      (b.estado === ESTADOS.ATRASADO) - (a.estado === ESTADOS.ATRASADO) ||
      new Date(a.prazoPrimeiraExibicao) - new Date(b.prazoPrimeiraExibicao),
  );
}

function contarEntrada(itens) {
  return {
    aguardando: itens.filter((i) => i.estado !== ESTADOS.ATRASADO).length,
    atrasados: itens.filter((i) => i.estado === ESTADOS.ATRASADO).length,
  };
}

// Ferramenta segura da operação: pede às telas da cobertura desta peça que
// busquem a playlist de novo (o heartbeat devolve `playlist.atualizar`,
// docs/player-mvp-contract.md §5). Não reinicia o Player nem mexe na hora
// congelada — é o mesmo sinal que qualquer aprovação já dispara.
async function pedirAtualizacaoDasTelas(criativoId) {
  const { rows } = await pool.query('SELECT anunciante_id, status FROM criativos WHERE id = $1', [criativoId]);
  if (!rows[0]) return null;
  const conta = await repo.buscarPorId(rows[0].anunciante_id);
  const planoId = conta ? repo.planoVigenteId(conta) : null;
  const plano = planoId ? await planosRepo.buscarPorId(planoId) : null;
  if (!plano || rows[0].status !== 'aprovado') return { telas: 0 };
  const pontos = (await coberturaDaConta(conta, plano)).map((p) => p.id);
  if (!pontos.length) return { telas: 0 };
  const { rowCount } = await pool.query(
    `UPDATE dispositivos SET playlist_desatualizada_em = clock_timestamp()
      WHERE status = 'ativo' AND ponto_id = ANY($1::int[])`,
    [pontos],
  );
  return { telas: rowCount };
}

module.exports = { pecasSemPrimeiraExibicao, contarEntrada, pedirAtualizacaoDasTelas };
