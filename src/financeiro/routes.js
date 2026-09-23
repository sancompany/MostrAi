const express = require('express');
const multer = require('multer');
const os = require('node:os');
const fs = require('node:fs');
const router = express.Router();
const planosRepo = require('./planos-repository');
const promocoesRepo = require('./promocoes-repository');
const { horasDeTelaPorMes, exibicoesPorMes } = require('../lib/pacing');
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
const { enviarTrocaDePlano, enviarCancelamento } = require('./email');
const planoAdministrativo = require('./plano-administrativo');
const comodato = require('../pontos/comodato');

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

// Os 2 produtos fixos de comodato (Inicial e Básico) — rodada de
// integridade, 23/09/2026. Somente leitura: não são compráveis e não têm
// preço; sumiram da UI quando Configurações > Comodato saiu e voltam aqui,
// em Ofertas, que é onde os produtos moram. Ver planosRepo#listarProdutosComodato.
router.get('/admin/ofertas/comodato', async (_req, res) => {
  res.json(await planosRepo.listarProdutosComodato());
});

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
  res.json(vigentes.filter((p) => promocoesRepo.elegivel(p, estado)));
});

// Admin — todas as vigentes, SEM filtro de elegibilidade (a Visão Geral
// precisa ver a promoção que está no ar pra qualquer público, não só a que
// apareceria pro próprio operador). A sessão do admin nunca é uma sessão de
// anunciante, então reusar a rota pública aqui sempre trataria o pedido como
// "visitante novo" e escondia promoção de "assinantes".
router.get('/admin/ofertas/promocoes-vigentes', async (_req, res) => {
  res.json(await promocoesRepo.listarVigentes());
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

  // A TRAVA DO COMODATO (migration 049, desenho do dono de 17/09/2026,
  // centralizada em `pontos/comodato.js#bloqueiaPlanoComercial` em
  // 23/09/2026 — a mesma régua agora também vale pra concessão administrativa
  // e pros créditos automáticos, que passavam batido por essa trava antes de
  // a separação comodato/plano comercial existir): quem está RECEBENDO a
  // ajuda de custo não assina plano de catálogo. Ou leva o dinheiro e fica
  // no Inicial que vem junto, ou troca o dinheiro por tela — e aí sobe pro
  // que quiser, com o crédito abatendo a mensalidade.
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
  if (await comodato.bloqueiaPlanoComercial(req.session.anuncianteId)) {
    return res.status(400).json({
      erro:
        'você está recebendo a ajuda de custo do comodato, e por isso fica no plano Inicial que vem junto. ' +
        'Pra assinar um plano pago (Essencial, Pro ou Prime) é só trocar a ajuda de custo por tela: fale com a gente ' +
        'que a gente troca, e aí os R$ 50 viram abatimento na sua mensalidade.',
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
      conta.plano_id === assinatura.plano_id && conta.data_expiracao && new Date(conta.data_expiracao) > new Date();
    if (pagou)
      return res.status(409).json({ erro: 'você já tem um plano ativo — pra trocar, fale com a gente pelo WhatsApp' });
    await assinaturasRepo.marcarCancelada(assinatura.id);
    assinatura = null;
  }
  if (!assinatura) {
    // Condição promocional vigente E elegível pra essa CONTA (Parte T do
    // pedido de Ofertas/Promoções; elegibilidade comercial adicionada
    // 23/09/2026) — o snapshot trava aqui, no instante da adesão: editar ou
    // encerrar a promoção depois não muda o que essa assinatura já tem
    // direito até o prazo acabar. `conta` já foi carregada acima — mesmo
    // objeto usado nas travas de endereço/comodato logo ali em cima.
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
    new Date(conta.data_expiracao) <= new Date()
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

  // Fire-and-forget: e-mail que falha não desfaz a troca (pedido do dono,
  // 18/09/2026). `conta.plano_id` aqui ainda é o plano ANTIGO — a variável
  // local não muda com o UPDATE que acabou de rodar no banco.
  planosRepo
    .buscarPorId(conta.plano_id)
    .then((planoAntigo) => enviarTrocaDePlano(conta, planoAntigo, planoNovo, corpo.acerto))
    .catch((err) => console.error('e-mail de troca de plano', err));
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
  // Legado (Parte 15 da reconstrução de Contas, 23/09/2026 — sem tela
  // chamando, ver /admin/anunciantes/:id/plano-administrativo). Reforçado
  // aqui pelo mesmo motivo da separação de comodato/plano comercial
  // (migration 076): sem esta trava, um `plano_id` de comodato (Inicial ou
  // Básico, ambos `ativo=false` no catálogo — nunca vendáveis) passando por
  // aqui reintroduziria exatamente o bug que a separação corrigiu.
  if (plano.ativo === false) {
    return res.status(400).json({ erro: 'esse plano não está à venda — não dá pra liberar como cortesia' });
  }

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
  if (await comodato.bloqueiaPlanoComercial(anunciante.id)) {
    return res.status(409).json({
      erro: 'essa conta está na modalidade "Recebe os R$ 50" do comodato, que não acumula com plano comercial',
    });
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
  // A mesma trava do comodato que vale pra quem compra (POST
  // /anunciantes/:id/assinar) — conceder por cima seria a MESMA conversão
  // silenciosa que a separação de comodato/plano comercial existe pra evitar
  // (23/09/2026, decisão do dono e do GPT: "Não faria conversão automática
  // escondida").
  if (await comodato.bloqueiaPlanoComercial(conta.id)) {
    return res.status(409).json({
      erro:
        'essa conta está na modalidade "Recebe os R$ 50" do comodato, que não acumula com plano comercial — ' +
        'troque a modalidade pra "Troca os R$ 50 por tela" antes de conceder Essencial, Pro ou Prime',
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

// Papel Vendedor aposentado (reconstrução de Contas, 23/09/2026, pedido do
// dono): nenhum vendedor novo nasce. A rota fica respondendo 410 em vez de
// sumir, pra quem chamar por engano saber o porquê. Vendedores, comissões e
// cupons que já existem continuam no banco (histórico).
router.post('/admin/anunciantes/:id/ativar-vendedor', (_req, res) => {
  res.status(410).json({ erro: 'o papel Vendedor foi aposentado — não há mais vendedor novo' });
});

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
