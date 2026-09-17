const express = require('express');
const multer = require('multer');
const os = require('node:os');
const fs = require('node:fs');
const router = express.Router();
const planosRepo = require('./planos-repository');
const beneficiosRepo = require('./beneficios-repository');
const cobrancasRepo = require('./cobrancas-repository');
const assinaturasRepo = require('./assinaturas-repository');
const pedidosRepo = require('./pedidos-repository');
const sanCheckout = require('./san-checkout');
const drive = require('./drive');
const pool = require('../db/pool');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const anunciantesRepo = require('../anunciantes/repository');
const eventos = require('../lib/eventos');

const uploadNota = multer({ dest: os.tmpdir() });

// Planos — pública (módulo 7) + admin
// Fundador deixou de ser plano de catálogo (item 4 da spec, 15/09/2026):
// virou status da conta, com desconto e elegibilidade que o dono marca à
// mão (ver valorMensalDaConta em san-checkout.js). Um plano com `vagas`
// ainda some da vitrine quando as vagas acabam — mecanismo genérico, não
// exclusivo de fundador.
router.get('/planos', async (_req, res) => {
  const planos = await planosRepo.listarAtivos();
  res.json(planos.filter((p) => p.vagas_restantes == null || p.vagas_restantes > 0));
});

router.get('/admin/planos', async (_req, res) => {
  res.json(await planosRepo.listarTodos());
});

function descontoInvalido(valor) {
  if (valor === undefined || valor === null || valor === '') return false;
  const n = Number(valor);
  return Number.isNaN(n) || n < 0 || n >= 100;
}

// Cria um plano novo — usado pra lançar preço/promoção sem mexer no que
// quem já assinou um plano existente está pagando (ver migration 014).
router.post('/admin/planos', async (req, res) => {
  const { id, tier, nome, valor_mensal_cheio, compromisso_meses, frequencia_hora, cobertura } = req.body;
  if (!id || !tier || !nome || !valor_mensal_cheio || !compromisso_meses || !frequencia_hora || !cobertura) {
    return res.status(400).json({ erro: 'campos obrigatórios faltando' });
  }
  if (descontoInvalido(req.body.desconto_percentual)) {
    return res.status(400).json({ erro: 'desconto precisa ser entre 0 e 99' });
  }
  const ativo = req.body.ativo === undefined ? true : req.body.ativo;
  if (ativo && (await planosRepo.vagaOcupada(Number(compromisso_meses), null, !!req.body.fundador))) {
    return res.status(409).json({
      erro: `já tem ${planosRepo.MAX_ATIVOS_POR_CICLO} planos ativos nessa modalidade — desative um antes (quem já assina continua pagando igual)`,
    });
  }
  try {
    const plano = await planosRepo.criar({ ...req.body, ativo });
    if (Array.isArray(req.body.beneficio_ids)) {
      await planosRepo.definirBeneficios(plano.id, req.body.beneficio_ids.map(Number));
    }
    res.status(201).json(await planosRepo.buscarPorId(plano.id));
  } catch (err) {
    if (err.code === 'LIMITE_CRIATIVOS') return res.status(400).json({ erro: err.message });
    if (err.code === '23505') return res.status(409).json({ erro: 'já existe um plano com esse id' });
    throw err;
  }
});

// Edição no lugar, só do que NÃO alcança quem já assinou: tirar da vitrine,
// mexer em vagas, destaque e rótulo. Campo de contrato aqui é recusado com o
// caminho certo na mensagem — silenciar e ignorar seria pior, o dono acharia
// que salvou.
router.patch('/admin/planos/:id', async (req, res) => {
  const atual = await planosRepo.buscarPorId(req.params.id);
  if (!atual) return res.status(404).json({ erro: 'plano não encontrado' });
  if (atual.arquivado_em) {
    return res.status(409).json({ erro: 'essa versão está aposentada — edite a versão em uso' });
  }

  const deContrato = planosRepo.CAMPOS_CONTRATO.filter((c) => c in req.body);
  if (deContrato.length) {
    return res.status(409).json({
      erro: `${deContrato.join(', ')} muda o contrato de quem já assinou — use "nova versão" (POST /admin/planos/${req.params.id}/nova-versao)`,
      campos: deContrato,
    });
  }

  // Reativar só passa se ainda houver vaga na vitrine daquela modalidade.
  // Desativar nunca é barrado.
  if (
    req.body.ativo === true &&
    (await planosRepo.vagaOcupada(Number(atual.compromisso_meses), req.params.id, !!atual.fundador))
  ) {
    return res.status(409).json({
      erro: `já tem ${planosRepo.MAX_ATIVOS_POR_CICLO} planos ativos nessa modalidade — desative um antes`,
    });
  }

  res.json(await planosRepo.atualizar(req.params.id, req.body));
});

// Item 9 da spec: editar campo de contrato não altera o plano — cria uma
// versão nova, com id novo, e aposenta a atual. Quem já assinou continua na
// versão antiga, com o preço, a frequência, a cobertura, o limite de
// criativos e os benefícios que contratou.
router.post('/admin/planos/:id/nova-versao', async (req, res) => {
  const atual = await planosRepo.buscarPorId(req.params.id);
  if (!atual) return res.status(404).json({ erro: 'plano não encontrado' });
  if (atual.arquivado_em) {
    return res.status(409).json({ erro: 'essa versão já está aposentada — parta da versão em uso' });
  }

  if (descontoInvalido(req.body.desconto_percentual)) {
    return res.status(400).json({ erro: 'desconto precisa ser entre 0 e 99' });
  }
  // Campo NOT NULL apagado na tela chegaria como null e viraria 500 no
  // constraint do banco — devolve o motivo em vez do erro genérico.
  const vazio = ['nome', 'valor_mensal_cheio', 'frequencia_hora', 'compromisso_meses', 'limite_criativos'].find(
    (c) => c in req.body && (req.body[c] === null || req.body[c] === ''),
  );
  if (vazio) return res.status(400).json({ erro: `${vazio} não pode ficar em branco` });

  const mudou = [...planosRepo.CAMPOS_CONTRATO, ...planosRepo.CAMPOS_VITRINE].some((c) => c in req.body);
  if (!mudou) return res.status(400).json({ erro: 'nada mudou — não faz versão nova à toa' });

  // A versão nova nasce ativa e a antiga sai da vitrine na mesma transação,
  // então o total do ciclo não muda. Só precisa conferir se o ciclo MUDOU:
  // aí ela entra num ciclo onde talvez já haja três.
  const cicloNovo = Number(req.body.compromisso_meses || atual.compromisso_meses);
  const ehFundador = 'fundador' in req.body ? !!req.body.fundador : !!atual.fundador;
  if (
    cicloNovo !== Number(atual.compromisso_meses) &&
    (await planosRepo.vagaOcupada(cicloNovo, req.params.id, ehFundador))
  ) {
    return res.status(409).json({
      erro: `já tem ${planosRepo.MAX_ATIVOS_POR_CICLO} planos ativos nessa modalidade — desative um antes`,
    });
  }

  try {
    const novo = await planosRepo.novaVersao(req.params.id, req.body);
    res.status(201).json(novo);
  } catch (err) {
    if (err.code === 'LIMITE_CRIATIVOS') return res.status(400).json({ erro: err.message });
    throw err;
  }
});

// Versões aposentadas, com quantos assinantes ativos cada uma ainda tem.
router.get('/admin/planos-arquivados', async (_req, res) => {
  res.json(await planosRepo.listarArquivados());
});

// Catálogo de benefícios — criado/editado uma vez, marcado por plano.
router.get('/admin/beneficios', async (_req, res) => {
  res.json(await beneficiosRepo.listar());
});

router.post('/admin/beneficios', async (req, res) => {
  if (!req.body.texto) return res.status(400).json({ erro: 'texto obrigatório' });
  try {
    res.status(201).json(await beneficiosRepo.criar(req.body));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'esse benefício já existe' });
    throw err;
  }
});

router.patch('/admin/beneficios/:id', async (req, res) => {
  const beneficio = await beneficiosRepo.atualizar(req.params.id, req.body);
  if (!beneficio) return res.status(404).json({ erro: 'benefício não encontrado' });
  res.json(beneficio);
});

router.delete('/admin/beneficios/:id', async (req, res) => {
  const ok = await beneficiosRepo.excluir(req.params.id);
  if (!ok) return res.status(404).json({ erro: 'benefício não encontrado' });
  res.json({ ok: true });
});

// Assinatura de plano — cria uma linha em `assinaturas` (o id dela é o que
// vai no link, ver src/financeiro/assinaturas-repository.js e
// san-checkout.js sobre por que não é mais um id de catálogo genérico) e
// devolve o link de checkout. Se já existir uma assinatura ativa, reusa —
// não deixa acumular assinatura duplicada por clique duplo.
router.post('/anunciantes/:id/assinar', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode assinar plano na própria conta' });
  }
  const plano = await planosRepo.buscarPorId(req.body.planoId);
  if (!plano?.ativo) return res.status(400).json({ erro: 'plano inválido' });

  // Vagas do plano — mesma conta que a vitrine usa (planos-repository).
  if (plano.vagas != null) {
    const ocupadas = await planosRepo.contarVagasOcupadas(plano.id, req.session.anuncianteId);
    if (ocupadas >= plano.vagas) return res.status(400).json({ erro: 'as vagas desse plano acabaram' });
  }

  // Dono de ponto ou vendedor que resolve anunciar: a conta é a mesma, mas o
  // checkout e a nota fiscal precisam do endereço comercial — que o convite
  // não pediu. Sem ele, manda completar o perfil antes.
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta || conta.excluido_em) return res.status(403).json({ erro: 'conta indisponível' });
  if (conta.suspenso) return res.status(403).json({ erro: 'conta suspensa — fale com o suporte antes de assinar' });
  if (!conta.endereco || !conta.cidade || !conta.uf || !conta.cep) {
    return res.status(400).json({ erro: 'complete o endereço da empresa no seu perfil antes de assinar' });
  }

  // A TRAVA DO COMODATO (migration 049, desenho do dono de 17/09/2026): quem
  // está RECEBENDO a ajuda de custo não assina plano de catálogo. Ou leva o
  // dinheiro e fica no plano básico que vem junto, ou troca o dinheiro por
  // tela — e aí sobe pro que quiser, com o crédito abatendo a mensalidade.
  //
  // Sem a trava, dava pra receber R$ 50 por mês E assinar o Máximo: o Mostraí
  // pagaria o comerciante e cobraria dele no mesmo ciclo, com o dinheiro indo
  // e voltando por dois caminhos que ninguém concilia.
  //
  // A recusa diz o que fazer, não só que não pode — mas só promete o caminho
  // que EXISTE. A troca de opção ainda não tem controle no painel (está em
  // docs/PENDENCIAS.md), então a mensagem manda falar com a gente. Mandar pra
  // um botão que não está lá é a mesma mentira da vitrine, só que na tela de
  // pagamento, que é onde ela custa mais caro.
  if ((conta.papeis || []).includes('ponto')) {
    const { rows } = await pool.query(
      `SELECT DISTINCT pp.permite_assinar
         FROM pontos p JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
        WHERE p.anunciante_id = $1`,
      [req.session.anuncianteId],
    );
    if (rows.length && rows.every((r) => r.permite_assinar === false)) {
      return res.status(400).json({
        erro:
          'você está recebendo a ajuda de custo do comodato, e por isso fica no plano básico que vem junto. ' +
          'Pra assinar Destaque ou Máximo é só trocar a ajuda de custo por tela: fale com a gente que a gente troca, ' +
          'e aí os R$ 50 viram abatimento na sua mensalidade.',
      });
    }
  }
  // Conta parceira só assina o que o dono liberou pra parceiro — ex.: só
  // trimestral pra cima, mensal fora (item 4 da spec, 15/09/2026; renomeado
  // de "fundador" pra "parceiro" em 16/09/2026).
  if (
    conta.status === 'parceiro' &&
    conta.parceiro_compromisso_minimo != null &&
    plano.compromisso_meses < conta.parceiro_compromisso_minimo
  ) {
    return res.status(400).json({ erro: 'esse plano não está liberado para conta parceira' });
  }
  if (!(conta.papeis || []).includes('anunciante')) {
    await pool.query(`UPDATE anunciantes SET papeis = array_append(papeis, 'anunciante') WHERE id = $1`, [conta.id]);
  }

  let assinatura = await assinaturasRepo.buscarAtivaDoAnunciante(req.session.anuncianteId);
  if (assinatura && assinatura.plano_id !== plano.id) {
    // Assinatura de outro plano: se já foi paga, a Asaas está cobrando ela —
    // criar outra viraria cobrança dupla. Troca de plano pago é pelo admin
    // (cancela no Checkout e assina de novo). Se nunca foi paga, é só um
    // clique antigo: cancela localmente e segue.
    const pagou =
      conta.plano_id === assinatura.plano_id && conta.data_expiracao && new Date(conta.data_expiracao) > new Date();
    if (pagou)
      return res.status(409).json({ erro: 'você já tem um plano ativo — pra trocar, fale com a gente pelo WhatsApp' });
    await assinaturasRepo.marcarCancelada(assinatura.id);
    assinatura = null;
  }
  if (!assinatura) {
    assinatura = await assinaturasRepo.criar({ anuncianteId: req.session.anuncianteId, planoId: plano.id });
  }

  // Emitido ao entregar o link, não ao pagar: a distância entre este evento e
  // `pagamento:cobranca_confirma` é exatamente quantos desistem no checkout.
  eventos.registrar(
    'plano:assinatura_inicia',
    {
      plano_id: plano.id,
      plano_ciclo: plano.compromisso_meses,
      valor_cobrado: sanCheckout.valorMensalDaConta(conta, plano),
    },
    conta,
  );

  res.json({ checkoutUrl: sanCheckout.linkCheckoutAssinatura(assinatura.id) });
});

// Exposto pro San Checkout consultar a assinatura (INTEGRACAO.md 6.1 chama
// isso de "plano", mas o :id aqui identifica uma assinatura específica —
// ver comentário em san-checkout.js#montarRespostaPlano)
router.get('/plano/:assinaturaId', sanCheckout.exigirChaveCheckout, async (req, res) => {
  const resposta = await sanCheckout.montarRespostaPlano(req.params.assinaturaId);
  if (!resposta) return res.status(404).json({ erro: 'assinatura não encontrada' });
  res.json(resposta);
});

// Exposto pro San Checkout consultar o pedido avulso (API.md 4.1). Único uso
// hoje: a diferença de uma troca de plano (ver POST /anunciantes/me/trocar-plano).
router.get('/pedido/:id', sanCheckout.exigirChaveCheckout, async (req, res) => {
  const pedido = await pedidosRepo.buscarPorId(req.params.id);
  if (!pedido) return res.status(404).json({ erro: 'pedido não encontrado' });
  const anunciante = await anunciantesRepo.buscarPorId(pedido.anunciante_id);
  res.json({
    pedidoId: pedido.id,
    status: pedido.status,
    itens: [{ nome: pedido.descricao, quantidade: 1, valorUnitario: Number(pedido.valor) }],
    valorCheio: Number(pedido.valor),
    valorComDesconto: Number(pedido.valor),
    descricao: pedido.descricao,
    pagador: anunciante
      ? {
          nome: anunciante.nome_empresa,
          email: anunciante.contato_email,
          documento: anunciante.cpf_cnpj,
          telefone: anunciante.contato_telefone,
        }
      : undefined,
  });
});

// Confirmação/eventos de assinatura E de pedido avulso (API.md do Checkout,
// seção 4.3): o MESMO webhook_url recebe os dois formatos, diferenciados
// pelo campo `tipo` — payload de pedido não tem esse campo (4.3.2). Responde
// 200 rápido, processa depois, exatamente como o contrato permite. A
// autorização é a assinatura HMAC dos headers, conferida em `webhookAutorizado`.
router.post('/webhook/san-checkout', (req, res) => {
  if (!sanCheckout.webhookAutorizado(req)) {
    return res.status(401).json({ erro: 'não autorizado' });
  }
  res.json({ ok: true });
  const processar =
    req.body.tipo === 'assinatura' ? sanCheckout.processarWebhookAssinatura : sanCheckout.processarWebhookPedido;
  processar(req.body).catch((err) => {
    console.error('erro processando webhook san-checkout', err);
  });
});

// Autoatendimento: o próprio cliente cancela, sem passar pelo admin. A
// cobertura já paga continua até data_expiracao (mesma regra do cancelamento
// pelo admin) — o texto da vitrine (FAQ "Como eu cancelo?") já promete isso.
router.post('/anunciantes/me/cancelar-assinatura', exigirAnuncianteLogado, async (req, res) => {
  const anunciante = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!anunciante) return res.status(401).json({ erro: 'não autenticado' });
  const assinatura = await assinaturasRepo.buscarAtivaDoAnunciante(req.session.anuncianteId);
  if (!assinatura) return res.status(400).json({ erro: 'você não tem assinatura ativa pra cancelar' });

  try {
    await sanCheckout.cancelarAssinatura(assinatura.id, anunciante.cpf_cnpj);
    await assinaturasRepo.marcarCancelada(assinatura.id);
    res.json({ ok: true });
  } catch {
    res.status(502).json({ erro: 'falha ao cancelar no San Checkout. Tente de novo em alguns minutos.' });
  }
});

// Troca de plano com o crédito do que resta do plano atual (pedido do dono,
// 16/09/2026): o plano novo só vale se custar mais do que esse crédito —
// senão a troca ou não cobraria nada, ou devolveria dinheiro, e ninguém
// pediu reembolso aqui. Gera um pedido avulso (nunca uma assinatura: essa
// não aceita desconto) e devolve o link de pagamento da diferença.
router.post('/anunciantes/me/trocar-plano', exigirAnuncianteLogado, async (req, res) => {
  const { planoNovoId } = req.body;
  if (!planoNovoId) return res.status(400).json({ erro: 'escolha o plano novo' });

  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(401).json({ erro: 'não autenticado' });
  if (
    !conta.plano_id ||
    conta.plano_cortesia ||
    !conta.data_expiracao ||
    new Date(conta.data_expiracao) <= new Date()
  ) {
    return res.status(400).json({ erro: 'só dá pra trocar quem tem um plano pago ativo agora' });
  }
  if (conta.plano_id === planoNovoId) return res.status(400).json({ erro: 'você já está nesse plano' });

  const planoAtual = await planosRepo.buscarPorId(conta.plano_id);
  const planoNovo = await planosRepo.buscarPorId(planoNovoId);
  if (!planoNovo?.ativo) return res.status(400).json({ erro: 'plano inválido' });

  const { credito, custoNovo, diferenca } = sanCheckout.calcularDiferencaTroca(conta, planoAtual, planoNovo);
  if (diferenca <= 0) {
    return res.status(400).json({
      erro: 'o crédito do que resta no seu plano atual já cobre o plano novo. Espere renovar ou escolha um plano de valor maior.',
      credito,
      custoNovo,
    });
  }

  const pedido = await pedidosRepo.criar({
    anuncianteId: conta.id,
    tipo: 'troca_plano',
    planoAtualId: planoAtual.id,
    planoNovoId: planoNovo.id,
    valor: diferenca,
    descricao: `Mostraí, troca de plano: ${planoAtual.nome} (${planoAtual.compromisso_meses}x) para ${planoNovo.nome} (${planoNovo.compromisso_meses}x)`,
  });
  res.json({ checkoutUrl: sanCheckout.linkCheckoutPedido(pedido.id), valor: diferenca, credito, custoNovo });
});

// Admin aciona cancelamento (Vitrina → San Checkout, nunca o pagador direto)
// Liberar plano de graça. Uma ação só, em vez de o dono editar `plano_id` e
// `data_expiracao` à mão em dois campos e esquecer de anotar que era cortesia.
//
// Não cria assinatura nem cobrança: o San Checkout não fica sabendo, e por isso
// nada é cobrado nem agora nem na renovação. A cobertura simplesmente vence na
// data, e o dono decide se estende.
router.post('/admin/anunciantes/:id/liberar-plano', async (req, res) => {
  const { plano_id, meses, motivo } = req.body;
  if (!plano_id) return res.status(400).json({ erro: 'escolha o plano' });

  const plano = await planosRepo.buscarPorId(plano_id);
  if (!plano) return res.status(404).json({ erro: 'plano não encontrado' });

  const anunciante = await anunciantesRepo.buscarPorId(req.params.id);
  if (!anunciante) return res.status(404).json({ erro: 'conta não encontrada' });

  // Liberar de graça por cima de quem PAGA apagaria a cobertura comprada e
  // pareceria um upgrade. Quem já paga, cancela primeiro.
  if (
    anunciante.plano_id &&
    !anunciante.plano_cortesia &&
    anunciante.data_expiracao &&
    new Date(anunciante.data_expiracao) > new Date()
  ) {
    return res
      .status(409)
      .json({ erro: 'essa conta tem plano pago ativo — cancele a assinatura antes de liberar cortesia' });
  }

  const duracao = Number(meses) > 0 ? Number(meses) : plano.compromisso_meses;
  const atualizado = await anunciantesRepo.atualizar(anunciante.id, {
    plano_id,
    suspenso: false,
    data_inicio_cobertura: anunciante.data_inicio_cobertura || new Date(),
    data_expiracao: new Date(Date.now() + duracao * 30 * 24 * 60 * 60 * 1000),
    plano_cortesia: true,
    cortesia_motivo: motivo || null,
  });
  res.json(atualizado);
});

router.post('/admin/anunciantes/:id/cancelar-assinatura', async (req, res) => {
  const anunciante = await anunciantesRepo.buscarPorId(req.params.id);
  if (!anunciante) return res.status(404).json({ erro: 'anunciante não encontrado' });

  const assinatura = await assinaturasRepo.buscarAtivaDoAnunciante(req.params.id);
  if (!assinatura) return res.status(400).json({ erro: 'anunciante sem assinatura ativa' });

  try {
    await sanCheckout.cancelarAssinatura(assinatura.id, anunciante.cpf_cnpj);
    await assinaturasRepo.marcarCancelada(assinatura.id);
    res.json({ ok: true });
  } catch {
    res.status(502).json({ erro: 'falha ao cancelar no San Checkout' });
  }
});

// Fila de reconciliação manual (webhooks que não deram pra correlacionar
// automaticamente ou eventos sem ação automática — ver san-checkout.js)
router.get('/admin/eventos-pendentes', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM eventos_assinatura_pendentes WHERE resolvido = false ORDER BY criado_em DESC`,
  );
  res.json(rows);
});

// Aplicar o ciclo que ficou pendente. "Marcar resolvido" só apagava o item da
// fila: não criava cobrança, não estendia cobertura, não pagava comissão. Ou
// seja, o único caminho pra pôr no ar quem pagou e caiu aqui era refazer tudo
// à mão em outra aba — e o botão que existia dava a impressão contrária.
router.post('/admin/eventos-pendentes/:id/aplicar', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM eventos_assinatura_pendentes WHERE id = $1', [req.params.id]);
  const evento = rows[0];
  if (!evento) return res.status(404).json({ erro: 'evento não encontrado' });
  if (evento.resolvido) return res.status(400).json({ erro: 'esse evento já foi resolvido' });

  const payload = evento.payload || {};
  const assinatura = payload.planoId ? await assinaturasRepo.buscarPorId(payload.planoId) : null;
  if (!assinatura) {
    return res
      .status(400)
      .json({ erro: 'esse evento não aponta pra nenhuma assinatura conhecida — resolva pela conta do anunciante' });
  }

  const anunciante = await anunciantesRepo.buscarPorId(assinatura.anunciante_id);
  if (!anunciante) return res.status(400).json({ erro: 'a conta dessa assinatura não existe mais' });

  // Confere no Checkout ANTES de creditar. Sem isto, apertar o botão num
  // evento de "cobrança falhou" — que também traz planoId — daria cobertura
  // por dinheiro que não entrou. Quem decide se houve pagamento é o motor de
  // pagamento, nunca a fila de revisão.
  let ultima;
  try {
    const estado = await sanCheckout.consultarAssinatura(assinatura.id, anunciante.cpf_cnpj);
    ultima = estado?.ultimaCobranca;
  } catch (err) {
    // Mensagem do erro vai pro log, não pra tela: ela carrega a URL da API do
    // Checkout, que é endereço de infraestrutura.
    console.error('falha ao consultar assinatura no Checkout', err);
    return res
      .status(502)
      .json({ erro: 'não deu pra conferir essa assinatura no Checkout agora — tente de novo em alguns minutos' });
  }
  if (ultima?.status !== 'confirmado' || !ultima.chargeId) {
    return res
      .status(400)
      .json({ erro: 'o Checkout não mostra cobrança confirmada nessa assinatura — nada a creditar' });
  }

  // A chave é a mesma que o webhook e a conciliação usariam (chargeId|status):
  // assim o mesmo pagamento não vira dois ciclos, venha por onde vier.
  const chave = `${ultima.chargeId}|${ultima.status}`;
  const { rowCount } = await pool.query('INSERT INTO webhooks_processados (id) VALUES ($1) ON CONFLICT DO NOTHING', [
    chave,
  ]);
  if (!rowCount) {
    await pool.query('UPDATE eventos_assinatura_pendentes SET resolvido = true WHERE id = $1', [evento.id]);
    return res
      .status(409)
      .json({ erro: 'essa cobrança já tinha sido creditada — o evento foi marcado como resolvido' });
  }

  try {
    await sanCheckout.aplicarCicloPago(assinatura, chave, { ...payload, origem: 'admin' });
  } catch (err) {
    return res.status(502).json({ erro: `não deu pra aplicar o ciclo: ${err.message}` });
  }
  await pool.query('UPDATE eventos_assinatura_pendentes SET resolvido = true WHERE id = $1', [evento.id]);
  res.json({ ok: true });
});

router.patch('/admin/eventos-pendentes/:id', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE eventos_assinatura_pendentes SET resolvido = true WHERE id = $1 RETURNING *`,
    [req.params.id],
  );
  res.json(rows[0] || null);
});

// Trocas de plano em lista própria (seção F, item 17). O pago já entra em
// Cobranças e o que falha vira pendência, mas nenhuma tela respondia "quem
// trocou de plano, de qual pra qual, e quando" — a pergunta que decide se o
// mecanismo vale a pena. Leitura pura: nada aqui altera pedido nenhum.
router.get('/admin/pedidos-avulsos', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT pa.*, a.nome_empresa,
            atual.nome AS plano_atual_nome, novo.nome AS plano_novo_nome,
            novo.compromisso_meses AS plano_novo_meses
       FROM pedidos_avulsos pa
       JOIN anunciantes a ON a.id = pa.anunciante_id
       LEFT JOIN planos atual ON atual.id = pa.plano_atual_id
       JOIN planos novo ON novo.id = pa.plano_novo_id
      ORDER BY pa.criado_em DESC`,
  );
  res.json(rows);
});

router.get('/admin/cobrancas', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, a.nome_empresa FROM cobrancas_confirmadas c
     JOIN anunciantes a ON a.id = c.anunciante_id ORDER BY c.criado_em DESC`,
  );
  res.json(rows);
});

// Admin sobe o PDF de nota fiscal (emissão em si é manual — ver SPEC.md
// módulo 6) — o upload pro Drive é automático a partir daqui.
router.patch('/admin/cobrancas/:id/nota-fiscal', uploadNota.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'arquivo obrigatório' });
  try {
    const cobranca = await cobrancasRepo.buscarPorId(req.params.id);
    if (!cobranca) return res.status(404).json({ erro: 'cobrança não encontrada' });

    const { driveFileId, url } = await drive.subirNotaFiscal(req.file.path, `nota-fiscal-${req.params.id}.pdf`);
    const atualizada = await cobrancasRepo.marcarNotaFiscal(req.params.id, {
      nota_fiscal_url: url,
      drive_file_id: driveFileId,
    });
    res.json(atualizada);
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// ---------------------------------------------------------------------------
// Vendedor — desde a v2 é um PAPEL da conta única (migration 019), não um
// login à parte. Entra só por convite (src/convites). As rotas antigas de
// /afiliados/* ficam respondendo 410 por um tempo pra quem tiver link salvo.
// ---------------------------------------------------------------------------
const vendedoresRepo = require('./vendedores-repository');

function exigirVendedorLogado(req, res, next) {
  if (!req.session.anuncianteId) return res.status(401).json({ erro: 'não autenticado' });
  vendedoresRepo
    .buscarPorConta(req.session.anuncianteId)
    .then((v) => {
      if (!v) return res.status(403).json({ erro: 'esta conta não é de vendedor' });
      req.vendedor = v;
      next();
    })
    .catch(next);
}

['/afiliados/cadastro', '/afiliados/login', '/afiliados/logout'].forEach((rota) => {
  router.post(rota, (_req, res) =>
    res.status(410).json({ erro: 'vendedor agora usa a conta única — entre em /anunciante/login.html' }),
  );
});

router.get('/vendedor/painel', exigirVendedorLogado, async (req, res) => {
  const { rows: comissoes } = await pool.query(
    `SELECT c.*, a.nome_empresa FROM comissoes c
     JOIN anunciantes a ON a.id = c.anunciante_id
     WHERE c.vendedor_conta_id = $1 ORDER BY c.criado_em DESC`,
    [req.vendedor.conta_id],
  );
  const totalComissionado = comissoes.reduce((soma, c) => soma + Number(c.comissao_valor), 0);
  const totalPago = comissoes.filter((c) => c.pago_em).reduce((soma, c) => soma + Number(c.comissao_valor), 0);
  res.json({
    vendedor: req.vendedor,
    comissoes,
    totalComissionado,
    totalPago,
    totalAReceber: totalComissionado - totalPago,
  });
});

// Admin — quanto se deve a cada vendedor, e marcar como pago.
router.get('/admin/comissoes', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, va.nome_empresa AS vendedor_nome, v.chave_pix, an.nome_empresa
     FROM comissoes c
     LEFT JOIN vendedores v ON v.conta_id = c.vendedor_conta_id
     LEFT JOIN anunciantes va ON va.id = c.vendedor_conta_id
     JOIN anunciantes an ON an.id = c.anunciante_id
     ORDER BY c.pago_em NULLS FIRST, c.criado_em DESC`,
  );
  res.json(rows);
});

router.patch('/admin/comissoes/:id', async (req, res) => {
  const { rows } = await pool.query('UPDATE comissoes SET pago_em = $2 WHERE id = $1 RETURNING *', [
    req.params.id,
    req.body.pago ? new Date() : null,
  ]);
  if (!rows[0]) return res.status(404).json({ erro: 'comissão não encontrada' });
  res.json(rows[0]);
});

router.get('/admin/vendedores', async (_req, res) => res.json(await vendedoresRepo.listar()));

router.patch('/admin/vendedores/:contaId', async (req, res) => {
  try {
    const v = await vendedoresRepo.atualizar(req.params.contaId, req.body);
    if (!v) return res.status(404).json({ erro: 'vendedor não encontrado' });
    res.json(v);
  } catch (err) {
    if (err.constraint === 'vendedores_comissao_percentual_faixa') {
      return res.status(400).json({ erro: 'comissão precisa ficar entre 10% e 30%' });
    }
    if (err.code === '23514') return res.status(400).json({ erro: 'status inválido' });
    throw err;
  }
});

module.exports = { router, exigirVendedorLogado };
