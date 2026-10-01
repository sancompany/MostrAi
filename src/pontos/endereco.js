const pool = require('../db/pool');
const { PARTES, colunasDoEndereco, parteQueFalta } = require('../lib/endereco');
const pendenciasRepo = require('../pendencias/repository');
const { pontoJaInstalado, abrirPontoAlterado } = require('../pendencias/endereco');

// Troca do endereço FÍSICO do ponto (estação de endereços, 01/10/2026) —
// um caminho só para o dono (Meus pontos) e para o Admin (Rede → Ponto).
// Endereço do ponto não é o da conta: a conta muda o dela no perfil e
// nenhum ponto se mexe; o ponto muda aqui e a conta não se mexe.
//
// Cada troca grava uma linha em `pontos_enderecos_historico` (antes, depois,
// quem, de onde, quando) na MESMA transação do UPDATE: ou ficam as duas, ou
// nenhuma. Ponto com tela instalada que muda de endereço pela mão do dono
// ganha a pendência ENDERECO_PONTO_ALTERADO pra operação conferir — a tela
// continua ligada.
//
// Latitude e longitude não existem aqui: o mapa é desenhado a partir do
// endereço (busca do Google no navegador), nunca de coordenada enviada.

const CAMPOS = [...PARTES, 'endereco'];
const retrato = (linha) => Object.fromEntries(CAMPOS.map((c) => [c, linha?.[c] ?? null]));
const erro = (status, mensagem) => Object.assign(new Error(mensagem), { status });

// `corpo`: as partes do endereço (já validadas por problemaNoEndereco).
// `origem`: 'usuario' (com `contaId`, conferida contra o dono DENTRO da
// trava da linha) ou 'admin' (com `admin`, o usuário do painel).
async function alterarEnderecoDoPonto(pontoId, corpo, { origem, contaId = null, admin = null }) {
  const partes = Object.fromEntries(PARTES.filter((p) => corpo?.[p] !== undefined).map((p) => [p, corpo[p]]));
  if (!Object.keys(partes).length) throw erro(400, 'nenhuma parte do endereço enviada');

  const cliente = await pool.connect();
  let ponto;
  let mudou = false;
  let pendencia = null;
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query('SELECT * FROM pontos WHERE id = $1 FOR UPDATE', [pontoId]);
    const atual = rows[0];
    // Ponto de outra conta responde igual a ponto inexistente — não confirma
    // que o id existe.
    if (!atual || (origem === 'usuario' && Number(atual.anunciante_id) !== Number(contaId))) {
      throw erro(404, 'ponto não encontrado');
    }
    if (atual.status === 'arquivado') throw erro(409, 'ponto arquivado não muda de endereço');

    const novo = retrato({ ...atual, ...colunasDoEndereco(partes, atual) });
    // Endereço do ponto é sempre completo (cidade, UF e CEP são NOT NULL na
    // tabela; o resto é o que a operação usa pra chegar lá).
    const falta = parteQueFalta(novo);
    if (falta) throw erro(400, `endereço incompleto — preencha o campo ${falta}`);

    const anterior = retrato(atual);
    mudou = CAMPOS.some((c) => anterior[c] !== novo[c]);
    ponto = atual;
    if (mudou) {
      const r = await cliente.query(
        `UPDATE pontos SET cep = $2, logradouro = $3, numero = $4, complemento = $5, bairro = $6,
                cidade = $7, uf = $8, endereco = $9
          WHERE id = $1 RETURNING *`,
        [
          pontoId,
          novo.cep,
          novo.logradouro,
          novo.numero,
          novo.complemento,
          novo.bairro,
          novo.cidade,
          novo.uf,
          novo.endereco,
        ],
      );
      ponto = r.rows[0];
      await cliente.query(
        `INSERT INTO pontos_enderecos_historico
           (ponto_id, anterior, novo, origem, alterado_por_conta, alterado_por_admin, status_do_ponto)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          pontoId,
          JSON.stringify(anterior),
          JSON.stringify(novo),
          origem,
          origem === 'usuario' ? contaId : null,
          origem === 'admin' ? admin : null,
          atual.status,
        ],
      );
      // Só a troca feita pelo dono pede conferência: quando é o Admin quem
      // muda, ele mesmo já está conferindo.
      if (origem === 'usuario' && pontoJaInstalado(atual)) {
        pendencia = await abrirPontoAlterado(atual, anterior, novo, cliente);
      }
    }
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
  if (pendencia) await pendenciasRepo.avisarNova(pendencia);
  return { ponto, mudou };
}

// Histórico de um ponto, mais recente primeiro (Admin → Rede → Ponto).
async function historicoDoPonto(pontoId) {
  const { rows } = await pool.query(
    `SELECT h.id, h.anterior, h.novo, h.origem, h.alterado_por_admin, h.status_do_ponto, h.criado_em,
            h.alterado_por_conta, a.nome_empresa AS conta_nome
       FROM pontos_enderecos_historico h
       LEFT JOIN anunciantes a ON a.id = h.alterado_por_conta
      WHERE h.ponto_id = $1
      ORDER BY h.criado_em DESC, h.id DESC`,
    [pontoId],
  );
  return rows;
}

module.exports = { alterarEnderecoDoPonto, historicoDoPonto };
