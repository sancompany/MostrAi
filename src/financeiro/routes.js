const express = require('express');
const multer = require('multer');
const os = require('node:os');
const fs = require('node:fs');
const router = express.Router();
const planosRepo = require('./planos-repository');
const promocoesRepo = require('./promocoes-repository');
const { horasDeTelaPorMes, exibicoesPorMes } = require('../lib/pacing');
const assinaturasRepo = require('./assinaturas-repository');
const pedidosRepo = require('./pedidos-repository');
const sanCheckout = require('./san-checkout');
const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const anunciantesRepo = require('../anunciantes/repository');
const eventos = require('../lib/eventos');
const { enviarTrocaDePlano, enviarCancelamento } = require('./email');
const planoAdministrativo = require('./plano-administrativo');
const { cotarPlano } = require('./cotacao');
const cicloContratado = require('./ciclo-contratado');
const { multiplicar } = require('../lib/dinheiro');
const sse = require('../lib/sse');
const dataBR = (iso) => `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}/${String(iso).slice(0, 4)}`;

const uploadNota = multer({ dest: os.tmpdir() });

// Planos — pública (módulo 7) + admin
// Fundador deixou de ser plano de catálogo (item 4 da spec, 15/09/2026):
// virou status da conta, com desconto e elegibilidade que o dono marca à
// mão (ver valorMensalDaConta em san-checkout.js). Um plano com `vagas`
// ainda some da vitrine quando as vagas acabam — mecanismo genérico, não
// exclusivo de fundador.
// `horas_por_mes` é calculado AQUI, não em cada tela. Ele já vivia à mão na
// vitrine e no admin, e a tela de pedido ia virar a terceira cópia — que é
// como três telas passam a prometer números diferentes pro mesmo plano. A
// conta é a de `src/lib/pacing.js`, a mesma que o painel usa no bônus da
// RN-49. Campo NOVO, nada removido: quem já lia a resposta continua lendo.
router.get('/planos', async (_req, res) => {
  const planos = await planosRepo.listarAtivos();
  res.json(
    planos
      .filter((p) => p.vagas_restantes == null || p.vagas_restantes > 0)
      .map((p) => {
        const horas_por_mes = horasDeTelaPorMes(p.segundos_por_hora, p.pontos_incluidos);
        // Benefício novo (21/09/2026, pedido do dono): quantas vezes o
        // anúncio aparece no mês. Reaproveita horas_por_mes ÷ a duração
        // máxima do plano — mesma lógica de `exibicoesPorMes`, ver
        // src/lib/pacing.js. Zero (não `null`) quando o plano não declara
        // duração, pro front não ter que tratar dois tipos de "vazio".
        return { ...p, horas_por_mes, exibicoes_por_mes: exibicoesPorMes(horas_por_mes, p.duracao_maxima_segundos) };
      }),
  );
});

router.get('/admin/planos', async (_req, res) => {
  res.json(await planosRepo.listarTodos());
});

// OFERTAS > PREÇOS (reformulação comercial, 22/09/2026) — os 3 produtos
// fixos, cada um com as 4 ofertas de ciclo já resolvidas. Substitui a grade
// de "todo plano é uma linha solta" por "3 produtos, cada um com 4 ciclos"
// pra quem só precisa mexer em preço/desconto no dia a dia — ver
// planosRepo#listarProdutos.
router.get('/admin/ofertas/produtos', async (_req, res) => {
  res.json(await planosRepo.listarProdutos());
});

// `GET /admin/ofertas/comodato` (Inicial e Básico em Ofertas) SAIU em
// 24/09/2026 (ADR-016): os dois deixaram de ser produto — o benefício de ser
// ponto agora é crédito. Catálogo ativo: Essencial, Pro e Prime.

const TIERS_VALIDOS = new Set(['essencial', 'destaque', 'maximo']);

// Preço-base + os 4 descontos de ciclo, nada além disso. `descontos` chega
// como { "1": pct, "3": pct, "6": pct, "12": pct }. O antigo "desconto
// comodato %" saiu daqui na rodada de integridade (23/09/2026): a migration
// 049 já tinha trocado esse percentual pelo crédito em reais da conta, e
// deixar o campo editável reabria um segundo desconto de comodato por cima.
router.patch('/admin/ofertas/produtos/:tier', async (req, res) => {
  if (!TIERS_VALIDOS.has(req.params.tier)) return res.status(400).json({ erro: 'produto inválido' });
  try {
    const produto = await planosRepo.atualizarProduto(req.params.tier, {
      precoBase: req.body.precoBase,
      descontos: req.body.descontos || {},
    });
    res.json(produto);
  } catch (err) {
    res.status(err.status || 400).json({ erro: err.message });
  }
});

// OFERTAS > PROMOÇÕES (mesma reformulação) — CRUD do admin. `itens` é a
// matriz produto × ciclo (Parte N do pedido): cada linha diz quais tier +
// compromisso_meses participam e com que desconto; ciclo sem linha fica de
// fora sem precisar de flag "desabilitado" separada.
router.get('/admin/ofertas/promocoes', async (_req, res) => {
  res.json(await promocoesRepo.listarTodas());
});

router.post('/admin/ofertas/promocoes', async (req, res) => {
  try {
    res.status(201).json(await promocoesRepo.criar(req.body));
  } catch (err) {
    res.status(err.status || 400).json({ erro: err.message });
  }
});

router.patch('/admin/ofertas/promocoes/:id', async (req, res) => {
  const atual = await promocoesRepo.buscarPorId(req.params.id);
  if (!atual) return res.status(404).json({ erro: 'promoção não encontrada' });
  try {
    res.json(await promocoesRepo.atualizar(req.params.id, req.body));
  } catch (err) {
    res.status(err.status || 400).json({ erro: err.message });
  }
});

router.delete('/admin/ofertas/promocoes/:id', async (req, res) => {
  try {
    await promocoesRepo.excluir(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(err.status || 400).json({ erro: err.message });
  }
});

// Pública — as promoções vigentes E elegíveis pra quem está pedindo (Parte
// da reconstrução de 23/09/2026: elegibilidade COMERCIAL, não sessão).
// Sem sessão de anunciante = tratado como "novo" (mesma regra de visitante
// sem conta). Sem filtro de SUPERFÍCIE aqui ainda — o front escolhe o campo
// `mostrar_home`/`mostrar_planos` que interessa, porque a mesma promoção
// pode aparecer em mais de um lugar.
router.get('/promocoes/vigentes', async (req, res) => {
  const conta = req.session.anuncianteId ? await anunciantesRepo.buscarPorId(req.session.anuncianteId) : null;
  const estado = await promocoesRepo.estadoComercialDaConta(conta);
  const vigentes = await promocoesRepo.listarVigentes();
  // Cada célula vai marcada com `temVantagem` e a promoção com
  // `ciclosComVantagem` (D1, 24/09/2026 — ver promocoes-repository.js).
  const planos = await planosRepo.listarAtivos({ incluirFundador: false });
  res.json(vigentes.filter((p) => promocoesRepo.elegivel(p, estado)).map((p) => promocoesRepo.comVantagem(p, planos)));
});

// Admin — todas as vigentes, SEM filtro de elegibilidade (a Visão Geral
// precisa ver a promoção que está no ar pra qualquer público, não só a que
// apareceria pro próprio operador). A sessão do admin nunca é uma sessão de
// anunciante, então reusar a rota pública aqui sempre trataria o pedido como
// "visitante novo" e escondia promoção de "assinantes".
router.get('/admin/ofertas/promocoes-vigentes', async (_req, res) => {
  // Mesma régua de vantagem do site (D1): a Visão geral não lista um ciclo
  // em que a promoção é pior que o desconto normal.
  const [vigentes, planos] = await Promise.all([
    promocoesRepo.listarVigentes(),
    planosRepo.listarAtivos({ incluirFundador: false }),
  ]);
  res.json(vigentes.map((p) => promocoesRepo.comVantagem(p, planos)));
});

// Upload da mídia da promoção (Parte B do pedido) — mesmo padrão de
// `POST /anunciantes/me/foto` (Supabase Storage direto, sem ffmpeg: é
// imagem, não vídeo). A promoção precisa existir antes (formulário salva os
// campos de texto primeiro, depois sobe a imagem — mesma convenção de
// "Ajustar mídia" em Mídia Mostraí).
router.post('/admin/ofertas/promocoes/:id/imagem', uploadNota.single('arquivo'), async (req, res) => {
  const atual = await promocoesRepo.buscarPorId(req.params.id);
  if (!atual) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ erro: 'promoção não encontrada' });
  }
  if (!req.file) return res.status(400).json({ erro: 'arquivo obrigatório' });
  try {
    const supabase = require('../lib/supabase');
    const buffer = fs.readFileSync(req.file.path);
    const nomeArquivo = `promocoes/promocao-${req.params.id}-${Date.now()}.jpg`;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;
    const { error } = await supabase.storage.from(bucket).upload(nomeArquivo, buffer, {
      contentType: 'image/jpeg',
      upsert: true,
    });
    if (error) return res.status(502).json({ erro: 'falha ao salvar a imagem' });
    const { data } = supabase.storage.from(bucket).getPublicUrl(nomeArquivo);
    res.json(await promocoesRepo.atualizar(req.params.id, { imagem_url: data.publicUrl }));
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// Grade antiga de planos (uma linha solta por plano, versão nova por edição
// de contrato, catálogo de benefícios editável) — a tela saiu em 22/09/2026
// (Ofertas = 3 produtos × 4 ciclos, `/admin/ofertas/*`) e o CRUD saiu do
// código na consolidação final (24/09/2026). O que continua: `GET
// /admin/planos` (leitura, a ficha de Conta usa), a tabela `planos` com as
// versões aposentadas (assinaturas antigas apontam pra elas) e a tabela
// `beneficios` (texto dos cards da vitrine — hoje só muda por SQL, decisão
// registrada em docs/CONSOLIDATION_STATE.md).
const GRADE_APOSENTADA = {
  erro: 'a grade antiga de planos saiu do admin (22/09/2026) — preço e desconto ficam em /admin/ofertas/produtos',
};
for (const rota of ['/admin/planos', '/admin/beneficios']) {
  router.post(rota, (_req, res) => res.status(410).json(GRADE_APOSENTADA));
  router.patch(`${rota}/:id`, (_req, res) => res.status(410).json(GRADE_APOSENTADA));
}
router.post('/admin/planos/:id/nova-versao', (_req, res) => res.status(410).json(GRADE_APOSENTADA));
router.get('/admin/planos-arquivados', (_req, res) => res.status(410).json(GRADE_APOSENTADA));
router.get('/admin/beneficios', (_req, res) => res.status(410).json(GRADE_APOSENTADA));
router.delete('/admin/beneficios/:id', (_req, res) => res.status(410).json(GRADE_APOSENTADA));

// Assinatura de plano — cria uma linha em `assinaturas` (o id dela é o que
// vai no link, ver src/financeiro/assinaturas-repository.js e
// san-checkout.js sobre por que não é mais um id de catálogo genérico) e
// devolve o link de checkout. Se já existir uma assinatura ativa, reusa —
// não deixa acumular assinatura duplicada por clique duplo.
// Cotação da tela de confirmação do pedido: o valor que ESTA conta pagaria
// neste plano, calculado pelas mesmas funções da cobrança (ver cotacao.js).
// Só leitura — não cria assinatura nem reserva vaga; quem decide de verdade
// continua sendo o POST /assinar logo abaixo.
router.get('/anunciantes/me/cotacao/:planoId', exigirAnuncianteLogado, async (req, res) => {
  const plano = await planosRepo.buscarPorId(req.params.planoId);
  if (!plano?.ativo) return res.status(404).json({ erro: 'plano não encontrado' });
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta || conta.excluido_em) return res.status(403).json({ erro: 'conta indisponível' });
  res.json(await cotarPlano(conta, plano));
});

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

  // Benefício em vigor (por créditos, ou cortesia legada): a compra muda a
  // fila, e o cliente precisa saber como ANTES de pagar (regras 25-27 do
  // pedido, ADR-016). Sem `confirmarBeneficio: true`, responde 409 com o
  // texto exato do que vai acontecer — a tela mostra e reenvia.
  const previsao = await planoAdministrativo.preverPagamento(conta, plano);
  if (previsao.beneficio && req.body.confirmarBeneficio !== true) {
    const b = previsao.beneficio;
    const ate = b.validoAte ? dataBR(b.validoAte) : 'o fim do período';
    return res.status(409).json({
      erro: 'confirme como fica o seu benefício',
      confirmacao:
        previsao.tipo === 'encerra_beneficio'
          ? {
              titulo: `Ativar o ${plano.nome} agora?`,
              texto: `Você tem um benefício ${b.planoNome} ativo até ${ate}. Ao ativar o ${plano.nome} agora, esse benefício será encerrado e ${b.porCreditos ? 'os créditos utilizados não serão devolvidos' : 'ele não volta depois'}. O ${plano.nome} começa imediatamente.`,
              botao: `Continuar com ${plano.nome}`,
            }
          : {
              titulo: `O ${plano.nome} começa depois do benefício`,
              texto: `Você tem um benefício ${b.planoNome} ativo até ${ate}, que já oferece o mesmo ou mais que o ${plano.nome}. Ele continua até o fim; o período que você pagar agora fica guardado e o ${plano.nome} começa logo depois — nenhum dia pago se perde.`,
              botao: 'Continuar',
            },
    });
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
      conta.plano_id === assinatura.plano_id && conta.data_expiracao && vigencia.coberturaVigente(conta.data_expiracao);
    if (pagou)
      return res
        .status(409)
        .json({ erro: 'você já tem esse plano ativo — pra mudar de plano, use "Trocar de plano" no painel' });
    // Achado real (revisão de 23/09/2026): `pagou` só olha o `plano_id`
    // ATUAL da conta — que a conciliação diária (encerrarCoberturaVencida)
    // agora pode limpar sozinha quando a cobrança recorrente falha e a
    // cobertura vence, SEM cancelar a assinatura no San Checkout (isso nunca
    // existiu; antes disso a conta ficava suspensa e nem chegava aqui). Sem
    // olhar o histórico, essa assinatura que já foi cobrada de verdade caía
    // no mesmo caminho de uma que nunca chegou a ser paga (checkout
    // abandonado): cancelamento só local, o San Checkout seguiria tentando
    // cobrar as duas. `cobrancas_confirmadas` é o fato histórico que
    // `conta.plano_id` não é mais garantia de refletir.
    const { rows: jaFoiCobrada } = await pool.query(
      'SELECT 1 FROM cobrancas_confirmadas WHERE anunciante_id = $1 AND plano_id = $2 LIMIT 1',
      [conta.id, assinatura.plano_id],
    );
    if (jaFoiCobrada.length) {
      try {
        await sanCheckout.cancelarAssinatura(assinatura.id, conta.cpf_cnpj);
      } catch {
        return res
          .status(502)
          .json({ erro: 'não deu pra cancelar sua assinatura anterior no San Checkout — tente de novo em instantes' });
      }
    }
    await assinaturasRepo.marcarCancelada(assinatura.id);
    assinatura = null;
  }
  // Link gerado há pouco e ainda não pago: o mesmo link (o Checkout lê a
  // mesma linha). Sem isso cada clique em "Assinar" abria outra intenção.
  if (!assinatura) assinatura = await assinaturasRepo.buscarPendenteDePagamento(conta.id, plano.id);
  if (!assinatura) {
    // O que sobrou de intenções antigas (outro plano, ou mais de 24 h) morre
    // aqui: um link só pagável por conta.
    await assinaturasRepo.cancelarPendentesDePagamento(conta.id);
    // Condição promocional vigente E elegível pra essa CONTA (Parte T do
    // pedido de Ofertas/Promoções; elegibilidade comercial adicionada
    // 23/09/2026) — o snapshot trava aqui, no instante da adesão: editar ou
    // encerrar a promoção depois não muda o que essa assinatura já tem
    // direito até o prazo acabar. `conta` já foi carregada acima — mesmo
    // objeto usado na trava de endereço logo ali em cima.
    const estadoComercial = await promocoesRepo.estadoComercialDaConta(conta);
    const condicao = await promocoesRepo.condicaoVigente(plano.tier, plano.compromisso_meses, estadoComercial);
    let promocaoValidoAte = null;
    if (condicao) {
      promocaoValidoAte = new Date();
      promocaoValidoAte.setMonth(promocaoValidoAte.getMonth() + condicao.promocao.duracao_beneficio_meses);
    }
    assinatura = await assinaturasRepo.criar({
      anuncianteId: req.session.anuncianteId,
      planoId: plano.id,
      promocaoId: condicao?.promocao.id,
      promocaoDescontoPercentual: condicao?.descontoPercentual,
      promocaoValidoAte,
    });
  }

  // Emitido ao entregar o link, não ao pagar: a distância entre este evento e
  // `pagamento:cobranca_confirma` é exatamente quantos desistem no checkout.
  eventos.registrar(
    'plano:assinatura_inicia',
    {
      plano_id: plano.id,
      plano_ciclo: plano.compromisso_meses,
      valor_cobrado: sanCheckout.valorMensalDaConta(conta, plano, assinatura),
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

// Exposto pro San Checkout consultar o pedido avulso (API.md 4.1). Pedido
// avulso está aposentado como caminho de troca de plano desde 17/09/2026
// (essa rota usa POST /trocar-plano dele agora, síncrona) — o que resta aqui
// é só leitura de pedidos antigos, criados antes da mudança.
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
          // contato_telefone vem em E.164 (+55...); o Checkout quer só DDD +
          // número, 10 ou 11 dígitos (mesmo achado de montarRespostaPlano em
          // san-checkout.js, 19/09/2026).
          telefone: sanCheckout.telefoneNacional(anunciante.contato_telefone),
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
    // Outras abas e o painel: a assinatura deixou de renovar (sem F5).
    sse.emitirParaConta(anunciante.id, 'plan.updated', {});
    // Fire-and-forget, depois de responder: e-mail que falha não desfaz o
    // cancelamento (pedido do dono, 18/09/2026).
    planosRepo
      .buscarPorId(assinatura.plano_id)
      .then((plano) => enviarCancelamento(anunciante, plano))
      .catch((err) => console.error('e-mail de cancelamento', err));
  } catch {
    res.status(502).json({ erro: 'falha ao cancelar no San Checkout. Tente de novo em alguns minutos.' });
  }
});

// Troca de plano PELO CHECKOUT (POST /trocar-plano dele — substitui o
// pedido avulso pra este caso). Sem acerto a cobrar (rebaixamento, ou
// acerto absorvido), troca na hora, sem o assinante digitar cartão de
// novo. Com acerto a cobrar (mudança de contrato em 21/09/2026: o dono
// testou o caminho antigo — que cobrava direto, sem o pagador ver nada —
// e decidiu que qualquer cobrança precisa de aprovação explícita dele),
// o Checkout responde 202 e devolve `approvalUrl`: quem confirma essa
// troca é o webhook `plano_trocado`, não esta resposta (ver
// processarWebhookAssinatura em san-checkout.js).
//
// A linha nova em `assinaturas` nasce 'pendente_troca' ANTES de chamar o
// Checkout — é dela que o Checkout lê preço/ciclo do plano de destino
// (GET /plano/:id, montarRespostaPlano). Se a troca for recusada em
// QUALQUER ponto (cartão, período não pago, troca simultânea...), a linha
// é apagada: ela nunca existiu de verdade pro anunciante.
router.post('/anunciantes/me/trocar-plano', exigirAnuncianteLogado, async (req, res) => {
  const { planoNovoId } = req.body;
  if (!planoNovoId) return res.status(400).json({ erro: 'escolha o plano novo' });

  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(401).json({ erro: 'não autenticado' });
  if (
    !conta.plano_id ||
    conta.plano_cortesia ||
    !conta.data_expiracao ||
    vigencia.coberturaVencida(conta.data_expiracao)
  ) {
    return res.status(400).json({ erro: 'só dá pra trocar quem tem um plano pago ativo agora' });
  }
  if (conta.plano_id === planoNovoId) return res.status(400).json({ erro: 'você já está nesse plano' });

  const planoNovo = await planosRepo.buscarPorId(planoNovoId);
  if (!planoNovo?.ativo) return res.status(400).json({ erro: 'plano inválido' });

  const assinaturaAtiva = await assinaturasRepo.buscarAtivaDoAnunciante(conta.id);
  if (!assinaturaAtiva) {
    return res
      .status(409)
      .json({ erro: 'não encontrei uma assinatura ativa no Checkout pra trocar. Fale com a gente.' });
  }

  const assinaturaNova = await assinaturasRepo.criar({
    anuncianteId: conta.id,
    planoId: planoNovo.id,
    status: 'pendente_troca',
  });

  const { status, corpo } = await sanCheckout.trocarPlano(assinaturaAtiva.id, assinaturaNova.id, conta.cpf_cnpj);

  if (status === 202) {
    // Nada foi cobrado nem alterado ainda — a linha 'pendente_troca' fica
    // exatamente como está. Só o webhook plano_trocado (se o pagador
    // aprovar) ou a expiração sozinha do lado do Checkout (se não
    // aprovar) resolvem daqui pra frente; não há nada a fazer nesta
    // resposta além de mandar o pagador pra lá.
    return res.status(202).json({
      status: 'aprovacao_pendente',
      approvalUrl: corpo.approvalUrl,
      expiresAt: corpo.expiresAt,
      amount: corpo.amount,
    });
  }

  if (status !== 200) {
    // O Checkout recusou em algum ponto ANTES de cobrar (ver os códigos em
    // trocaPlanoController.js do Checkout: 400/402/404/409/502) — a linha
    // pendente nunca chegou a valer, então some. Se o dinheiro já tiver
    // sido cobrado e só a confirmação (502) tiver falhado, o próprio
    // Checkout registra o erro do lado dele (chargeId na resposta); aqui
    // só cabe não fingir que a troca aconteceu.
    await assinaturasRepo.excluir(assinaturaNova.id);
    return res.status(status).json({ erro: corpo.erro || 'não foi possível trocar de plano', ...corpo });
  }

  // A partir daqui o dinheiro (se houve acerto) já foi cobrado pelo
  // Checkout — as escritas locais têm que ser tudo ou nada, e uma falha
  // aqui não pode desaparecer sem deixar rastro (mesmo raciocínio de
  // aplicarCicloPago, acima).
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await assinaturasRepo.marcarTrocada(assinaturaAtiva.id, cliente);
    await assinaturasRepo.marcarAtiva(assinaturaNova.id, cliente);
    await cliente.query('UPDATE anunciantes SET plano_id = $2 WHERE id = $1', [conta.id, planoNovo.id]);
    // Troca = ciclo novo (migration 087): snapshot do ciclo do plano novo,
    // pelo valor que a assinatura nova cobra — nunca o acerto proporcional.
    await cicloContratado.registrar(cliente, {
      anuncianteId: conta.id,
      plano: planoNovo,
      assinaturaId: assinaturaNova.id,
      origem: 'troca',
      valorCiclo: multiplicar(
        sanCheckout.valorMensalDaConta(conta, planoNovo, assinaturaNova),
        planoNovo.compromisso_meses,
      ),
    });
    if (corpo.acerto?.cobrado) {
      // `plano_anterior_id` é o que permite a aba "Trocas de plano" do
      // admin continuar existindo: sem ele, esta linha ficaria idêntica a
      // uma renovação de ciclo comum (ver GET /admin/pedidos-avulsos).
      await cliente.query(
        `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, plano_anterior_id, valor, nota_fiscal_status)
         VALUES ($1,$2,$3,$4,'pendente')`,
        [conta.id, planoNovo.id, assinaturaAtiva.plano_id, corpo.acerto.valor],
      );
    }
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK');
    await sanCheckout.registrarPendencia(
      {
        rota: '/anunciantes/me/trocar-plano',
        assinaturaAtiva: assinaturaAtiva.id,
        assinaturaNova: assinaturaNova.id,
        corpo,
      },
      `troca de plano cobrada no Checkout (acerto ${corpo.acerto?.valor ?? 0}), mas falhou ao gravar aqui: ${err.message}`,
    );
    return res.status(502).json({
      erro: 'A troca foi cobrada, mas não conseguimos confirmar aqui. Já estamos cientes — fale com a gente se o plano não mudar em alguns minutos.',
    });
  } finally {
    cliente.release();
  }

  eventos.registrar(
    'plano:troca_paga',
    { plano_id: planoNovo.id, valor_confirmado: Number(corpo.acerto?.valor || 0) },
    conta,
  );

  res.json({ ok: true, valor: corpo.valor, ciclo: corpo.ciclo, acerto: corpo.acerto });
  sse.emitirParaConta(conta.id, 'plan.updated', {});

  // Fire-and-forget: e-mail que falha não desfaz a troca (pedido do dono,
  // 18/09/2026). `conta.plano_id` aqui ainda é o plano ANTIGO — a variável
  // local não muda com o UPDATE que acabou de rodar no banco.
  planosRepo
    .buscarPorId(conta.plano_id)
    .then((planoAntigo) => enviarTrocaDePlano(conta, planoAntigo, planoNovo, corpo.acerto))
    .catch((err) => console.error('e-mail de troca de plano', err));
});

// "Liberar plano" (cortesia gravada direto em `anunciantes.plano_id`, sem
// histórico) saiu da tela em 23/09/2026 e do código na consolidação final
// (24/09/2026): cortesia comercial é crédito (`creditos/conceder`) e correção
// técnica excepcional é `plano-administrativo` abaixo, que registra o
// benefício no histórico e nunca passa por cima de crédito já debitado.
router.post('/admin/anunciantes/:id/liberar-plano', (_req, res) =>
  res.status(410).json({
    erro: 'liberar plano foi aposentado — conceda créditos (creditos/conceder) ou use plano-administrativo',
  }),
);

router.post('/admin/anunciantes/:id/cancelar-assinatura', async (req, res) => {
  const anunciante = await anunciantesRepo.buscarPorId(req.params.id);
  if (!anunciante) return res.status(404).json({ erro: 'anunciante não encontrado' });

  const assinatura = await assinaturasRepo.buscarAtivaDoAnunciante(req.params.id);
  if (!assinatura) return res.status(400).json({ erro: 'anunciante sem assinatura ativa' });

  try {
    await sanCheckout.cancelarAssinatura(assinatura.id, anunciante.cpf_cnpj);
    await assinaturasRepo.marcarCancelada(assinatura.id);
    res.json({ ok: true });
    // Outras abas e o painel: a assinatura deixou de renovar (sem F5).
    sse.emitirParaConta(anunciante.id, 'plan.updated', {});
    // Fire-and-forget: mesmo aviso do cancelamento pedido pelo próprio
    // anunciante — quem cancelou não muda o que o cliente precisa saber.
    planosRepo
      .buscarPorId(assinatura.plano_id)
      .then((plano) => enviarCancelamento(anunciante, plano))
      .catch((err) => console.error('e-mail de cancelamento', err));
  } catch {
    res.status(502).json({ erro: 'falha ao cancelar no San Checkout' });
  }
});

// ---------- plano administrativo (reconstrução de Contas, 23/09/2026) ----------
// Benefício/cortesia concedido pelo admin — regras em plano-administrativo.js.
// Substitui, na ficha da conta, o "Liberar plano" por prompt() com id digitado
// (a rota liberar-plano acima fica como legado, sem tela chamando).
//
// Revisão da ficha de Conta (23/09/2026, pedido do dono): "Conceder/Alterar/
// Cancelar plano" SAÍRAM da ficha — cortesia comercial agora é crédito
// (`POST /admin/anunciantes/:id/creditos/conceder`), que entra na mesma fila
// de benefícios do resgate. `plano-administrativo` e `/encerrar` ficam como
// FERRAMENTA TÉCNICA de correção excepcional, sem tela, e nunca por cima de
// benefício pago com créditos (`beneficioPorCreditosAberto`). Cortesias
// administrativas antigas continuam valendo até o fim (o gerador lê
// `anunciantes.plano_id`, e `encerrarBeneficiosVencidos` fecha no prazo).

// O que a ficha precisa pra mostrar Plano sem adivinhar: de onde vem o plano
// vigente, se há assinatura paga ativa (só essa passa pelo San Checkout) e o
// histórico de benefícios administrativos.
router.get('/admin/anunciantes/:id/plano', async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.params.id);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  const [assinatura, historico] = await Promise.all([
    assinaturasRepo.buscarAtivaDoAnunciante(conta.id),
    planoAdministrativo.historicoDaConta(conta.id),
  ]);
  res.json({
    origem: planoAdministrativo.origemDoPlano(conta),
    assinatura_ativa: assinatura
      ? { id: assinatura.id, plano_id: assinatura.plano_id, created_at: assinatura.created_at }
      : null,
    historico,
  });
});

// Conceder (ou trocar por) um benefício. Uma conta, um plano comercial
// vigente: se há assinatura paga ativa, ela é cancelada ANTES pela mesma
// lógica do cancelar-assinatura (San Checkout primeiro; se ele recusar, nada
// muda). Sem cobrança, sem diferença, sem troca paga, sem reembolso — nenhuma
// regra existente pede reembolso aqui, então nenhum é gerado.
router.post('/admin/anunciantes/:id/plano-administrativo', async (req, res) => {
  const { plano_id, valido_ate } = req.body;
  const plano = plano_id ? await planosRepo.buscarPorId(plano_id) : null;
  if (!plano || !planoAdministrativo.TIERS_COMERCIAIS.has(plano.tier) || plano.fundador || plano.ativo === false) {
    return res.status(400).json({ erro: 'escolha Essencial, Pro ou Prime e um ciclo' });
  }
  const validoAte = planoAdministrativo.validadeValida(valido_ate);
  if (!validoAte) {
    return res.status(400).json({ erro: 'escolha uma data de validade no futuro' });
  }
  const conta = await anunciantesRepo.buscarPorId(req.params.id);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  if (conta.conta_propria) {
    return res.status(400).json({ erro: 'a conta interna do Mostraí não recebe plano comercial' });
  }
  if (conta.excluido_em) return res.status(409).json({ erro: 'conta excluída — restaure antes de conceder plano' });
  if (conta.suspenso) return res.status(409).json({ erro: 'conta suspensa — reative antes de conceder plano' });
  if (await planoAdministrativo.beneficioPorCreditosAberto(conta.id)) {
    return res.status(409).json({
      erro:
        'esta conta tem um benefício pago com créditos em vigor ou programado — ele não pode ser substituído ' +
        'por cortesia (os créditos já foram debitados). Espere ele terminar.',
    });
  }
  const observacao =
    String(req.body.observacao || '')
      .trim()
      .slice(0, 500) || null;

  const assinatura = await assinaturasRepo.buscarAtivaDoAnunciante(conta.id);
  if (assinatura) {
    try {
      await sanCheckout.cancelarAssinatura(assinatura.id, conta.cpf_cnpj);
      await assinaturasRepo.marcarCancelada(assinatura.id);
    } catch {
      return res
        .status(502)
        .json({ erro: 'não deu pra cancelar a assinatura paga no San Checkout — nada foi alterado, tente de novo' });
    }
  }
  const { conta: atualizada } = await planoAdministrativo.conceder({
    conta,
    plano,
    validoAte,
    observacao,
    adminUsuario: req.session.adminUsuario,
  });
  res.json({ conta: atualizada, assinatura_cancelada: !!assinatura });
});

// Encerrar o benefício administrativo agora (assinatura paga não passa por
// aqui — essa usa cancelar-assinatura, que mantém a cobertura já paga).
router.post('/admin/anunciantes/:id/plano-administrativo/encerrar', async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.params.id);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  if (planoAdministrativo.origemDoPlano(conta) !== 'cortesia') {
    return res.status(400).json({ erro: 'esta conta não tem benefício administrativo em vigor' });
  }
  if (await planoAdministrativo.beneficioPorCreditosAberto(conta.id)) {
    return res.status(409).json({
      erro: 'o benefício em vigor foi pago com créditos — não se encerra por aqui (os créditos já foram debitados)',
    });
  }
  res.json(await planoAdministrativo.encerrar({ conta, adminUsuario: req.session.adminUsuario }));
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
//
// UNION de dois mecanismos, o antigo e o atual (18/09/2026): pedido avulso
// (aposentado — POST /anunciantes/me/trocar-plano não cria mais nenhum,
// mas o que já existe continua aqui) e o acerto de POST /trocar-plano do
// Checkout, que fica em `cobrancas_confirmadas.plano_anterior_id`. Sem o
// UNION, a troca de hoje ficaria idêntica a uma renovação de ciclo comum
// nessa tabela, e a pergunta que esta aba responde pararia de ter
// resposta pra tudo que acontecer a partir de agora.
router.get('/admin/pedidos-avulsos', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT pa.id, pa.status, pa.valor, pa.criado_em, pa.pago_em, a.nome_empresa,
            atual.nome AS plano_atual_nome, novo.nome AS plano_novo_nome,
            novo.compromisso_meses AS plano_novo_meses
       FROM pedidos_avulsos pa
       JOIN anunciantes a ON a.id = pa.anunciante_id
       LEFT JOIN planos atual ON atual.id = pa.plano_atual_id
       JOIN planos novo ON novo.id = pa.plano_novo_id
     UNION ALL
     SELECT c.id::text, 'pago' AS status, c.valor, c.criado_em, c.criado_em AS pago_em, a.nome_empresa,
            atual.nome AS plano_atual_nome, novo.nome AS plano_novo_nome,
            novo.compromisso_meses AS plano_novo_meses
       FROM cobrancas_confirmadas c
       JOIN anunciantes a ON a.id = c.anunciante_id
       JOIN planos atual ON atual.id = c.plano_anterior_id
       JOIN planos novo ON novo.id = c.plano_id
      WHERE c.plano_anterior_id IS NOT NULL
      ORDER BY criado_em DESC`,
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

// Nota fiscal por upload (PDF → Google Drive): a tela saiu em 19/09/2026
// (nenhuma nota é emitida hoje; quando for, o envio será automático) e o
// código saiu na consolidação final (24/09/2026) — `drive.js` e a
// dependência `googleapis` foram removidos. As colunas `nota_fiscal_*` de
// `cobrancas_confirmadas` ficam como histórico.
router.patch('/admin/cobrancas/:id/nota-fiscal', (_req, res) =>
  res.status(410).json({ erro: 'nota fiscal por upload saiu do admin (19/09/2026) — não há mais envio por aqui' }),
);

// ---------------------------------------------------------------------------
// Programa de vendedores — aposentado em 23/09/2026 (pedido do dono). Na
// consolidação final (24/09/2026) o código executável saiu: produção sem
// nenhum vendedor, nenhuma comissão, nenhuma conta com o papel. As tabelas
// `vendedores`/`comissoes` ficam no banco (histórico; a exportação LGPD ainda
// as lê). Cada rota antiga responde 410 com o motivo, pra quem tiver link ou
// script salvo saber por quê.
// ---------------------------------------------------------------------------
const VENDEDOR_APOSENTADO = {
  erro: 'o programa de vendedores foi aposentado — não há mais vendedor, cupom nem comissão',
};
for (const rota of [
  '/afiliados/cadastro',
  '/afiliados/login',
  '/afiliados/logout',
  '/admin/anunciantes/:id/ativar-vendedor',
]) {
  router.post(rota, (_req, res) => res.status(410).json(VENDEDOR_APOSENTADO));
}
router.get('/vendedor/painel', (_req, res) => res.status(410).json(VENDEDOR_APOSENTADO));
router.get('/admin/comissoes', (_req, res) => res.status(410).json(VENDEDOR_APOSENTADO));
router.patch('/admin/comissoes/:id', (_req, res) => res.status(410).json(VENDEDOR_APOSENTADO));
router.get('/admin/vendedores', (_req, res) => res.status(410).json(VENDEDOR_APOSENTADO));
router.patch('/admin/vendedores/:contaId', (_req, res) => res.status(410).json(VENDEDOR_APOSENTADO));

module.exports = { router };
