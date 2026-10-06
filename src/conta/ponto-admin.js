const express = require('express');
const anunciantesRepo = require('../anunciantes/repository');
const categoriasRepo = require('../categorias/repository');
const { materializarPonto } = require('../pontos/materializar');
const { colunasDoEndereco, parteQueFalta, problemaNoEndereco } = require('../lib/endereco');
const { adicionarPapel, emTransacao } = require('./modos');
const { sincronizarContaSemFalhar } = require('../pendencias/endereco');
const eventos = require('../lib/eventos');
const sse = require('../lib/sse');

// CRIAR PONTO PELA CONTA (estação Rede/Admin V2, 06/10/2026, pedido do
// dono): o comerciante quer ser ponto mas não tem tempo de preencher o
// pedido — o Admin cria por ele, na ficha da conta (Contas › conta ›
// "+ Criar ponto"). É uma criação administrativa EXPLÍCITA: nenhuma
// candidatura falsa nasce; a origem fica gravada (`pontos.origem = 'admin'`,
// `criado_por` = o usuário do Admin, migration 116) e no registro de eventos.
//
// O ponto nasce pelo MESMO núcleo da candidatura aprovada
// (src/pontos/materializar.js#materializarPonto): ponto FIXO vinculado à
// conta, endereço em partes, `a_instalar`, SEM tela (a tela nasce no Admin
// quando for instalar — mesma regra da candidatura), papel `ponto` na conta,
// cupom de indicação da conta. Créditos e Plano Básico vêm depois, da tela
// instalada, como em todo ponto. Estabelecimento repetido (mesma conta,
// nome e endereço) ou pedido em análise no mesmo endereço → 409 com o
// motivo, nunca um segundo ponto silencioso.
//
//   POST /admin/anunciantes/:id/pontos
const router = express.Router();

// As partes do endereço que o ponto exige (src/lib/endereco.js: só o
// complemento é opcional) — para o 400 apontar o campo que falta.
const OBRIGATORIAS = ['cep', 'logradouro', 'numero', 'bairro', 'cidade', 'uf'];
const LIMITES = { nome: 120, responsavel: 120, contato: 40, observacoes: 1000, fluxoMaximo: 10_000_000 };
const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });

function texto(valor, campo, rotulo, maximo, obrigatorio = true) {
  const t = typeof valor === 'string' ? valor.trim() : '';
  if (!t) {
    if (obrigatorio) throw erro(400, `${rotulo}: preencha`, campo);
    return null;
  }
  if (t.length > maximo) throw erro(400, `${rotulo}: no máximo ${maximo} caracteres`, campo);
  return t;
}

// O que o Admin revisou no formulário (pré-preenchido com os dados da
// conta) vira os dados do ponto. Tudo validado aqui — o navegador só sugere.
async function lerPonto(corpo, conta) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw erro(400, 'Envie os dados do ponto');
  const nome = texto(corpo.nome, 'nome', 'Nome do ponto', LIMITES.nome);
  const problema = problemaNoEndereco(corpo);
  if (problema) throw erro(400, problema.erro, problema.campo);
  const endereco = colunasDoEndereco(corpo);
  const falta = parteQueFalta(endereco);
  if (falta) throw erro(400, `Endereço: preencha ${falta}`, OBRIGATORIAS.find((p) => !endereco[p]) || 'logradouro');
  const responsavel = texto(corpo.responsavel_nome, 'responsavel_nome', 'Responsável no local', LIMITES.responsavel);
  const contato = texto(corpo.responsavel_contato, 'responsavel_contato', 'Telefone do responsável', LIMITES.contato);
  let categoria = null;
  if (corpo.categoria_id !== undefined && corpo.categoria_id !== null && corpo.categoria_id !== '') {
    const id = /^\d{1,9}$/.test(String(corpo.categoria_id)) ? Number(corpo.categoria_id) : null;
    categoria = id ? await categoriasRepo.buscarAtivaPorId(id) : null;
    if (!categoria) throw erro(400, 'Categoria inválida', 'categoria_id');
  } else if (conta.categoria_id) {
    // Sem escolha no formulário: a categoria da conta (a mesma régua da
    // candidatura aprovada — src/pontos/materializar.js).
    categoria = await categoriasRepo.buscarAtivaPorId(conta.categoria_id);
  }
  let fluxo = null;
  if (
    corpo.fluxo_estimado_mensal !== undefined &&
    corpo.fluxo_estimado_mensal !== null &&
    corpo.fluxo_estimado_mensal !== ''
  ) {
    fluxo = Number(corpo.fluxo_estimado_mensal);
    if (!Number.isInteger(fluxo) || fluxo < 0 || fluxo > LIMITES.fluxoMaximo) {
      throw erro(400, 'Movimento estimado: um número inteiro de pessoas por mês', 'fluxo_estimado_mensal');
    }
  }
  return {
    nome,
    ...endereco,
    segmento: categoria?.nome || conta.categoria_livre || 'outro',
    categoria_id: categoria ? categoria.id : conta.categoria_id || null,
    categoria_livre: categoria || conta.categoria_id ? null : conta.categoria_livre || null,
    responsavel_nome: responsavel,
    responsavel_contato: contato,
    fluxo_estimado_mensal: fluxo,
    // Validado por src/pontos/repository.js#criar (400 com a mensagem).
    horario_semanal: corpo.horario_semanal || null,
    observacoes: texto(corpo.observacoes, 'observacoes', 'Observações', LIMITES.observacoes, false),
  };
}

router.post('/admin/anunciantes/:id/pontos', async (req, res) => {
  const contaId = /^\d{1,9}$/.test(String(req.params.id)) ? Number(req.params.id) : null;
  const conta = contaId ? await anunciantesRepo.buscarPorId(contaId) : null;
  if (!conta || conta.excluido_em) return res.status(404).json({ erro: 'conta não encontrada' });
  if (conta.conta_propria) return res.status(409).json({ erro: 'a conta própria da Mostraí não é dona de ponto' });
  const admin = req.session?.adminUsuario || 'admin';
  let ponto;
  try {
    const dados = await lerPonto(req.body, conta);
    ponto = await emTransacao(async (c) => {
      // Um "+ Criar ponto" por vez por conta: dois cliques seguidos não
      // passam os dois pela checagem de estabelecimento repetido.
      await c.query('SELECT pg_advisory_xact_lock(116, $1)', [conta.id]);
      await adicionarPapel(conta.id, 'ponto', c);
      // Sem `aceitou_termos_em`: ninguém da conta aceitou nada neste ato —
      // quem criou foi o Admin (a origem e o usuário ficam gravados).
      return materializarPonto({ ...dados, origem: 'admin', criado_por: admin, aceitou_termos_em: null }, conta, c, {
        incluirPedidos: true,
      });
    });
  } catch (err) {
    // O horário é validado no INSERT (src/pontos/repository.js#criar), que
    // não sabe o nome do campo.
    if (err.status === 400 && !err.campo && /hor[aá]rio/i.test(err.message)) err.campo = 'horario_semanal';
    if (err.status)
      return res.status(err.status).json({ erro: err.message, ...(err.campo ? { campo: err.campo } : {}) });
    throw err;
  }
  eventos.registrar('ponto:criado_admin', { ponto_id: ponto.id, admin }, conta);
  sse.emitirParaAdmin('point.updated', { id: ponto.id });
  sse.emitirParaConta(conta.id, 'point.updated');
  sincronizarContaSemFalhar(conta.id, { por: `admin:${admin}` });
  res.status(201).json({ id: ponto.id, nome: ponto.nome, status: ponto.status });
});

module.exports = { router };
