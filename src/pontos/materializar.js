// Candidatura aprovada → ponto (consolidação final, 24/09/2026). UMA função
// para as duas portas que materializam um ponto: o admin liberando a
// candidatura numa conta que já existe (src/conta/modos.js) e a conta nova
// que nasce de um convite ligado a uma candidatura (src/anunciantes/routes.js).
// Antes eram duas cópias do mesmo INSERT, e cada correção precisava ser feita
// duas vezes (a categoria, o horário, a foto — todas já divergiram uma vez).
//
// Regras que moram só aqui:
//   · uma candidatura vira no máximo UM ponto (índice único da migration 080;
//     aqui é o caminho normal, sem erro);
//   · o mesmo estabelecimento (conta + nome + endereço) não vira segundo
//     ponto — recusa com 409, para o admin recusar a candidatura em vez de
//     aprovar;
//   · a categoria (ramo do comércio que cede a parede) vem do `segmento`
//     que a candidatura guardou em texto, resolvido no catálogo por nome ou
//     apelido; só cai na categoria da CONTA quando o texto não bate com nada
//     — antes o segmento do segundo estabelecimento era ignorado e um
//     mercado nascia com o ramo da loja de roupa do mesmo dono;
//   · o ponto nasce sem tela (status automático lê 0 telas como "aguardando
//     instalação"); a Tela nasce no admin, quando for instalar de verdade;
//   · o cupom de indicação é por CONTA — criado só se ela ainda não tem.
const pool = require('../db/pool');
const pontosRepo = require('./repository');
const categoriasRepo = require('../categorias/repository');
const indicacoesRepo = require('../indicacoes/repository');

async function materializarPontoDaCandidatura(cand, conta, db = pool) {
  const { rows: jaExiste } = await db.query('SELECT id FROM pontos WHERE candidatura_id = $1', [cand.id]);
  if (jaExiste.length) return null;

  const nome = cand.nome_comercio || conta.nome_empresa;
  const motivo = await pontosRepo.estabelecimentoJaCadastrado(
    conta.id,
    { nome, endereco: cand.endereco, cep: cand.cep },
    db,
    { incluirPedidos: false },
  );
  if (motivo) {
    throw Object.assign(new Error(`${motivo} — recuse esta candidatura em vez de aprovar`), { status: 409 });
  }

  const categoria = cand.segmento ? await categoriasRepo.buscarAtivaPorNomeOuApelido(cand.segmento, db) : null;
  const ponto = await pontosRepo.criar(
    {
      nome,
      endereco: cand.endereco,
      logradouro: cand.logradouro,
      numero: cand.numero,
      bairro: cand.bairro,
      complemento: cand.complemento,
      cidade: cand.cidade || 'Matão',
      uf: cand.uf || 'SP',
      cep: cand.cep || '',
      segmento: cand.segmento || 'outro',
      categoria_id: categoria ? categoria.id : conta.categoria_id || null,
      categoria_livre: categoria ? null : cand.segmento || conta.categoria_livre || null,
      responsavel_nome: cand.nome,
      responsavel_contato: cand.contato_telefone,
      fluxo_estimado_mensal: cand.fluxo_estimado_mensal,
      horario_semanal: cand.horario_semanal || null,
      foto_instalacao_url: cand.foto_fachada_url || null,
      observacoes: cand.mensagem || null,
      anunciante_id: conta.id,
      candidatura_id: cand.id,
      aceitou_termos_em: new Date(),
    },
    db,
  );
  if (!(await indicacoesRepo.buscarCupomPorConta(conta.id, db))) {
    await indicacoesRepo.criarCupom(conta.id, conta.nome_empresa, db);
  }
  return ponto;
}

module.exports = { materializarPontoDaCandidatura };
