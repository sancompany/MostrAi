// Modos da conta (painel único: anúncios / meu ponto / vendas).
//
// Uma conta tem os três modos no painel; só os papéis que ela tem estão
// liberados. Aqui mora tudo que liga um modo numa conta que já existe:
//   - anunciante: a própria pessoa ativa (só precisa do endereço comercial);
//   - ponto e vendedor: a pessoa pede de dentro do painel (candidatura com
//     conta_id) e o dono libera no admin — ou manda um convite que a conta
//     logada aceita. Nunca se libera sozinho (CONSTRAINTS.md).
// E os dois módulos cruzados de plano (migration 020): tela ganha por tempo
// de plano de anunciante, e plano de anúncio ganho por tempo como ponto.
const express = require('express');
const pool = require('../db/pool');
const anunciantesRepo = require('../anunciantes/repository');
const candidaturasRepo = require('../candidaturas/repository');
const pontosRepo = require('../pontos/repository');
const { materializarPontoDaCandidatura } = require('../pontos/materializar');
const categoriasRepo = require('../categorias/repository');
const convitesRepo = require('../convites/repository');
const eventos = require('../lib/eventos');
const { enviarCandidaturaNova } = require('../financeiro/email');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const { validar: validarHorarioSemanal } = require('../lib/horario-semanal');
const { colunasDoEndereco, parteQueFalta, temEndereco } = require('../lib/endereco');
const notificacoesRepo = require('../creditos/notificacoes');
const sse = require('../lib/sse');

const router = express.Router();

async function adicionarPapel(contaId, papel, db = pool) {
  await db.query(`UPDATE anunciantes SET papeis = array_append(papeis, $2) WHERE id = $1 AND NOT ($2 = ANY(papeis))`, [
    contaId,
    papel,
  ]);
}

// Liga um papel numa conta existente a partir de uma candidatura aprovada
// (admin "liberar na conta" ou convite aceito por conta logada). Cria o que
// o papel precisa: perfil de vendedor, ponto + Tela 1.
//
// Papel Vendedor aposentado (23/09/2026, pedido do dono): pedir 'vendedor'
// aqui não faz mais nada — nem papel novo, nem perfil de vendedor. É o ponto
// único por onde convite aceito, candidatura antiga e o admin chegavam, então
// fechar aqui fecha todos. Vendedor que já existe fica como está.
// O papel 'ponto' em `papeis` é só um espelho legado: "dono de ponto" é
// derivado do ponto materializado (src/anunciantes/situacao.js,
// src/pontos/routes.js) — a materialização em si mora em
// src/pontos/materializar.js, compartilhada com o cadastro por convite.
async function liberarPapelNaConta(conta, papel, cand, db) {
  if (papel === 'vendedor') return;
  await adicionarPapel(conta.id, papel, db);
  if (papel === 'ponto' && cand && cand.tipo === 'ponto') {
    await materializarPontoDaCandidatura(cand, conta, db);
  }
}

async function emTransacao(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const r = await fn(cliente);
    await cliente.query('COMMIT');
    return r;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

// ---------------------------------------------------------------------------
// O que o painel precisa pra desenhar os três modos: papéis, pedidos em
// aberto, e o estado dos bônus de plano.
// ---------------------------------------------------------------------------
router.get('/conta/modos', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  const papeis = conta.papeis || ['anunciante'];
  const { rows: pedidos } = await pool.query(
    `SELECT tipo, status, criado_em, origem FROM candidaturas
     WHERE conta_id = $1 AND status IN ('nova', 'em_contato') ORDER BY criado_em DESC`,
    [conta.id],
  );
  res.json({
    papeis,
    modos: {
      anunciante: {
        liberado: papeis.includes('anunciante'),
        precisaEndereco: !temEndereco(conta),
      },
      ponto: { liberado: papeis.includes('ponto'), pedido: pedidos.find((p) => p.tipo === 'ponto') || null },
      vendedor: { liberado: papeis.includes('vendedor'), pedido: pedidos.find((p) => p.tipo === 'vendedor') || null },
    },
    bonus: {
      // `ponto` continua na resposta como null: o painel lê `bonus.ponto` e
      // tirar a chave quebraria a tela de quem estiver com a página aberta.
      ponto: null,
      // Bônus de anúncio por tempo de ponto (módulo 2) aposentado em
      // 24/09/2026 — o tempo de ponto agora vira crédito mensal.
      anuncio: null,
    },
  });
});

// Modo anunciante: a própria conta ativa. Só exige o endereço comercial (a
// nota fiscal e o checkout precisam dele); o status de aprovação já veio do
// convite que criou a conta.
router.post('/conta/modos/anunciante', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  const { categoria_id, categoria_livre } = req.body;
  // Endereço em partes (D5, 24/09/2026 — src/lib/endereco.js). Quem já tem
  // endereço na conta não precisa mandar de novo; quem manda, manda completo.
  const enviado = colunasDoEndereco(req.body, conta);
  const dados = {
    endereco: conta.endereco,
    logradouro: conta.logradouro,
    numero: conta.numero,
    complemento: conta.complemento,
    bairro: conta.bairro,
    cidade: conta.cidade,
    uf: conta.uf,
    cep: conta.cep,
    ...enviado,
  };
  const falta = enviado.logradouro !== undefined ? parteQueFalta(dados) : !temEndereco(dados);
  if (falta) {
    return res.status(400).json({
      erro:
        typeof falta === 'string'
          ? `endereço incompleto — preencha o campo ${falta}`
          : 'endereço completo da empresa é obrigatório pra anunciar',
    });
  }
  // O ramo não é enfeite de cadastro: é ele que o gerador da playlist usa pra
  // não pôr o anúncio dentro de um concorrente direto (src/playlist/gerador.js,
  // `a.categoria_id IS NULL OR a.categoria_id <> $1`). Sem ramo, a conta é
  // elegível pra TODO ponto — inclusive o do lado, do mesmo ramo. O cadastro
  // aberto já exige; por dentro do painel não exigia.
  if (!(categoria_id || categoria_livre || conta.categoria_id || conta.categoria_livre)) {
    return res
      .status(400)
      .json({ erro: 'diga o ramo do seu negócio — é ele que impede o seu anúncio de rodar dentro de um concorrente' });
  }
  if (categoria_id && !(await categoriasRepo.buscarAtivaPorId(categoria_id))) {
    return res.status(400).json({ erro: 'ramo inválido' });
  }
  await pool.query(
    `UPDATE anunciantes SET endereco = $2, cidade = $3, uf = $4, cep = $5,
       categoria_id = COALESCE($6, categoria_id), categoria_livre = COALESCE($7, categoria_livre),
       papeis = CASE WHEN 'anunciante' = ANY(papeis) THEN papeis ELSE array_append(papeis, 'anunciante') END,
       logradouro = $8, numero = $9, complemento = $10, bairro = $11
     WHERE id = $1`,
    [
      conta.id,
      dados.endereco,
      dados.cidade,
      dados.uf,
      dados.cep,
      categoria_id || null,
      categoria_livre || null,
      dados.logradouro ?? null,
      dados.numero ?? null,
      dados.complemento ?? null,
      dados.bairro ?? null,
    ],
  );
  res.json(await anunciantesRepo.buscarPorId(conta.id));
});

// Modo ponto: pedido de dentro do painel. Vira candidatura com conta_id; o
// dono libera no admin (ou gera convite, que a conta aceita). Vendedor não
// pede mais assim (18/09/2026, a pedido do dono) — quem quer ser vendedor
// fala direto com a gente; quem entra, entra por convite que o dono gera à
// mão depois da conversa, nunca por pedido self-service.
// Candidatura de ponto canônica (rodada "Ofertas + formulário canônico de
// candidatura", 22/09/2026) — usada pelos DOIS caminhos de entrada: "Você
// também possui um comércio?" (conta ainda sem papel `ponto`) e "+
// Cadastrar outro endereço" (conta que já é dona de ponto e cede mais um
// endereço, `src/pontos/routes.js`). Antes desta rodada só o primeiro
// caminho criava candidatura de verdade — o segundo criava um PONTO direto,
// sem passar pelo Aprovar/Recusar do admin (achado real, corrigido aqui).
// Os dois têm o MESMO contrato de dados a partir daqui; a diferença entre
// eles é só a guarda de quem pode chamar (ver as duas rotas).
async function criarCandidaturaPonto(conta, entrada) {
  // Endereço em partes (D5, 24/09/2026): a linha `endereco` é composta aqui,
  // e o endereço vem completo — CEP, logradouro, número, bairro, cidade, UF.
  const dados = { ...entrada, ...colunasDoEndereco(entrada) };
  if (!dados.nome_comercio || !dados.endereco) {
    throw Object.assign(new Error('nome do comércio e endereço são obrigatórios'), { status: 400 });
  }
  const faltaNoEndereco = parteQueFalta(dados);
  if (faltaNoEndereco) {
    throw Object.assign(new Error(`endereço incompleto — preencha o campo ${faltaNoEndereco}`), { status: 400 });
  }
  // Defesa em profundidade (21/09/2026, pedido do dono: campo virou
  // obrigatório na tela) — o card do painel já exige no HTML, mas quem
  // chamar a rota direto não passa pelo front. É o único número que a
  // candidatura de ponto realmente precisa e que a conta não tem como já
  // ter informado antes (ao contrário de nome/endereço/ramo).
  if (!dados.fluxo_estimado_mensal || Number(dados.fluxo_estimado_mensal) <= 0) {
    throw Object.assign(new Error('movimento médio mensal é obrigatório'), { status: 400 });
  }
  // Sem escolha de benefício (24/09/2026, ADR-016): o estabelecimento só
  // pede pra entrar na rede. Um `plano_ponto_id` que ainda chegue de tela
  // antiga é ignorado (ver `plano_ponto_id: null` na gravação).
  // Horário de funcionamento — pedido do dono, 22/09/2026: quem cede a
  // parede diz o horário do próprio comércio nesta mesma tela, junto do
  // resto do cadastro (não numa tela separada depois). Obrigatório aqui —
  // é o único lugar onde a pessoa que sabe o horário está preenchendo o
  // formulário; o cadastro manual do admin (exceção) deixa opcional.
  if (!dados.horario_semanal) {
    throw Object.assign(new Error('horário de funcionamento é obrigatório'), { status: 400 });
  }
  const horario_semanal = validarHorarioSemanal(dados.horario_semanal);
  // Segmento do comércio: a conta já respondeu isso pra poder anunciar
  // (POST /conta/modos/anunciante exige o ramo) — reaproveita em vez de
  // perguntar de novo. `categoria_livre` é texto direto; `categoria_id`
  // (ramo do catálogo fixo) precisa de uma busca pelo nome antes de virar
  // o texto que a candidatura guarda.
  let segmento = dados.segmento || conta.categoria_livre || null;
  if (!segmento && conta.categoria_id) {
    const categoria = await categoriasRepo.buscarAtivaPorId(conta.categoria_id);
    segmento = categoria?.nome || null;
  }
  const cand = await candidaturasRepo.criar({
    ...dados,
    tipo: 'ponto',
    nome: conta.responsavel_nome || conta.nome_empresa,
    contato_telefone: dados.contato_telefone || conta.contato_telefone,
    contato_email: conta.contato_email,
    segmento,
    horario_semanal,
    conta_id: conta.id,
    origem: 'painel',
  });
  // Fire-and-forget: mesmo aviso que o formulário público mandava antes de
  // ser aposentado — sem ele, o pedido só aparece pra quem abrir o admin
  // por acaso (a fila "Candidaturas" ainda avisa, mas o e-mail chega antes).
  enviarCandidaturaNova(cand).catch((err) => console.error('e-mail de candidatura nova', err));
  // Rede/Candidaturas e o contador do admin, sem F5.
  sse.emitirParaAdmin('application.updated', { id: cand.id, status: cand.status });
  return cand;
}

// Toda conta pode pedir um ponto, tenha ou não outro já aprovado (o segundo
// endereço entra pela mesma candidatura; a régua de duplicidade é por
// estabelecimento, não por conta). `POST /anunciantes/me/pontos` é o mesmo
// caminho com outro nome (src/pontos/routes.js).
router.post('/conta/modos/:papel/pedir', exigirAnuncianteLogado, async (req, res) => {
  const papel = req.params.papel;
  if (papel !== 'ponto') return res.status(400).json({ erro: 'modo inválido' });
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  // Mesma régua de `POST /anunciantes/me/pontos` — uma função só
  // (pontosRepo.estabelecimentoJaCadastrado), nunca "já tem qualquer pedido
  // em aberto", que barrava candidatar um segundo endereço diferente.
  const motivo = await pontosRepo.estabelecimentoJaCadastrado(conta.id, {
    nome: req.body.nome_comercio,
    // A mesma linha "logradouro, número" que fica gravada (D5).
    endereco: colunasDoEndereco(req.body).endereco,
    cep: req.body.cep,
  });
  if (motivo) return res.status(409).json({ erro: motivo });
  try {
    const cand = await criarCandidaturaPonto(conta, req.body);
    sse.emitirParaConta(conta.id, 'application.updated', { id: cand.id, status: cand.status });
    res.status(201).json({ ok: true, id: cand.id });
  } catch (err) {
    res.status(err.status || 400).json({ erro: err.message });
  }
});

// Convite aberto por quem já tem conta: os papéis entram nesta conta em vez
// de nascer uma conta nova. Vendedor precisa da chave Pix; ponto vindo de
// candidatura cria o ponto + Tela 1.
router.post('/convites/:token/aceitar', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  const convite = await convitesRepo.buscarValido(req.params.token);
  if (!convite) return res.status(404).json({ erro: 'convite inválido, usado ou expirado — fale com quem te enviou' });
  // 'vendedor' não conta mais (papel aposentado, 23/09/2026) — convite
  // antigo que só liberava isso não tem mais nada a liberar.
  const novos = (convite.papeis || []).filter((p) => p !== 'vendedor' && !(conta.papeis || []).includes(p));
  if (!novos.length) return res.status(409).json({ erro: 'sua conta já tem tudo que esse convite libera' });

  try {
    await emTransacao(async (cliente) => {
      const consumido = await convitesRepo.consumir(req.params.token, conta.id, cliente);
      if (!consumido) throw Object.assign(new Error('esse convite acabou de ser usado'), { status: 409 });
      const cand = convite.candidatura_id ? await candidaturasRepo.buscarPorId(convite.candidatura_id) : null;
      for (const papel of novos) await liberarPapelNaConta(conta, papel, cand, cliente);
      // Convite de ponto sem candidatura: o endereço entra depois em "Meu ponto".
      if (cand) await cliente.query(`UPDATE candidaturas SET conta_id = $2 WHERE id = $1`, [cand.id, conta.id]);
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  }
  res.json(await anunciantesRepo.buscarPorId(conta.id));
});

// Admin: libera o papel direto na conta que pediu (candidatura com conta_id).
router.post('/admin/candidaturas/:id/liberar', async (req, res) => {
  const cand = await candidaturasRepo.buscarPorId(req.params.id);
  if (!cand) return res.status(404).json({ erro: 'candidatura não encontrada' });
  if (!cand.conta_id)
    return res.status(400).json({ erro: 'essa candidatura não é de uma conta existente — gere um convite' });
  if (cand.status === 'aprovada') return res.status(409).json({ erro: 'já liberada' });
  const conta = await anunciantesRepo.buscarPorId(cand.conta_id);
  if (!conta || conta.excluido_em) return res.status(400).json({ erro: 'conta não encontrada ou excluída' });
  try {
    await emTransacao(async (cliente) => {
      // A checagem de "já liberada" acima roda FORA da transação — dois
      // cliques simultâneos passavam os dois. Relê travando a linha: o
      // segundo espera o primeiro terminar e vê 'aprovada'.
      const {
        rows: [atual],
      } = await cliente.query('SELECT status FROM candidaturas WHERE id = $1 FOR UPDATE', [cand.id]);
      if (atual.status === 'aprovada') throw Object.assign(new Error('já liberada'), { status: 409 });
      await liberarPapelNaConta(conta, cand.tipo, cand, cliente);
      await cliente.query(`UPDATE candidaturas SET status = 'aprovada' WHERE id = $1`, [cand.id]);
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  }
  // Esta é a ÚNICA aprovação (o PATCH de status recusa 'aprovada' desde a
  // consolidação de 24/09/2026). Depois do COMMIT: métrica, aviso à conta,
  // SSE pra conta (Meus pontos) e pro admin (Rede/Candidaturas, sem F5).
  eventos.registrar('ponto:candidatura_aprova', {
    tipo: cand.tipo,
    cidade: cand.cidade,
    uf: cand.uf,
    ramo: cand.segmento,
    dias_ate_aprovar: eventos.diasEntre(cand.criado_em),
  });
  sse.emitirParaAdmin('application.updated', { id: cand.id, status: 'aprovada' });
  if (cand.tipo === 'ponto') {
    sse.emitirParaAdmin('point.updated', {});
    await notificacoesRepo
      .registrar(conta.id, {
        tipo: 'ponto_aprovado',
        titulo: 'Seu pedido de ponto foi aprovado',
        descricao: 'A gente chama no WhatsApp pra combinar a visita e a instalação.',
        entidadeTipo: 'candidatura',
        entidadeId: cand.id,
      })
      .catch((err) => console.error('falha ao notificar aprovação de ponto', err.message));
    sse.emitirParaConta(conta.id, 'point.updated', {});
  }
  sse.emitirParaConta(conta.id, 'application.updated', { id: cand.id, status: 'aprovada' });
  res.json({ ok: true, conta: await anunciantesRepo.buscarPorId(conta.id) });
});

// Programa de vendedores aposentado (23/09/2026); código executável removido
// na consolidação final (24/09/2026) — produção sem nenhum vendedor.
router.patch('/vendedor/me', (_req, res) => res.status(410).json({ erro: 'o programa de vendedores foi aposentado' }));

// ---------------------------------------------------------------------------
// Bônus de ponto (módulos 1 e 2) — REMOVIDOS.
// ---------------------------------------------------------------------------
// Módulo 1 (tela grátis por tempo de plano) saiu em 17/09/2026. Módulo 2
// (plano de anúncio grátis por tempo de ponto, `planos_ponto.plano_bonus_*`)
// saiu em 24/09/2026 junto com as modalidades de comodato (ADR-016): o tempo
// de ponto na rede agora rende 1 crédito por mês, resgatável em qualquer
// benefício. Quem já resgatou o bônus antigo fica com o registro
// (`anuncio_bonus_resgatado_em`, cortesia 'bônus de ponto' — a ficha mostra
// como "Bônus de ponto legado") e com o plano até o fim do prazo.
router.post('/conta/bonus/anuncio/resgatar', exigirAnuncianteLogado, (_req, res) => {
  res.status(410).json({ erro: 'esse bônus foi substituído pelos créditos mensais do ponto' });
});

module.exports = { router, adicionarPapel, liberarPapelNaConta, criarCandidaturaPonto, emTransacao };
