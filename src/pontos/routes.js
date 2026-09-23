const express = require('express');
const multer = require('multer');
const os = require('node:os');
const fs = require('node:fs');
const router = express.Router();
const repo = require('./repository');
const eventos = require('../lib/eventos');
const planosPontoRepo = require('./planos-ponto-repository');
const pagamentosRepo = require('./pagamentos-repository');
const anunciantesRepo = require('../anunciantes/repository');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const pool = require('../db/pool');
const comodato = require('./comodato');
const { criarCandidaturaPonto } = require('../conta/modos');
const { meusPontosDaConta } = require('./meus-pontos');
const sse = require('../lib/sse');

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 20 * 1024 * 1024 } });

// Pública — "onde estamos" (módulo 7)
router.get('/pontos', async (_req, res) => {
  const pontos = await repo.listarPublicos();
  res.json(pontos);
});

// Pública — soma de fluxo estimado dos pontos ativos, pra home/planos (prova
// social). Só a soma, nunca por ponto — e só aparece acima de zero (ver
// repository).
router.get('/pontos/fluxo', async (_req, res) => {
  res.json({ pessoasPorMes: await repo.somaFluxoMensal() });
});

// Pública — foto de exemplo do "ponto completo" em pontos.html, trocável
// pelo admin sem deploy (pedido do dono, 18/09/2026). `null` até a primeira
// troca, e a página cai no arquivo estático padrão nesse caso.
router.get('/pontos/config', async (_req, res) => {
  res.json({ fotoExemploUrl: await repo.obterConfiguracao('foto_exemplo_ponto_url') });
});

// "Meu ponto" (GET /anunciantes/:id/pontos, devolvia a linha inteira do
// ponto) e "Meus endereços" (GET /anunciantes/me/pontos/candidaturas) saíram
// com a página antiga do ponto (Fatia 6, 23/09/2026): a rota abaixo junta os
// dois, com projeção fechada.
// "Meus pontos" do painel único — pedido em análise, ponto e telas na MESMA
// entidade, com projeção segura (ver src/pontos/meus-pontos.js). `ehPonto`
// diz ao painel por qual porta um estabelecimento novo entra: a conta que já
// é ponto usa POST /anunciantes/me/pontos; a que ainda não é, POST
// /conta/modos/ponto/pedir. As duas criam a mesma candidatura.
router.get('/anunciantes/me/meus-pontos', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  res.json({
    ehPonto: (conta.papeis || []).includes('ponto'),
    estabelecimentos: await meusPontosDaConta(conta.id),
  });
});

// Dono de ponto (papel vindo do convite) cadastra outro endereço pela conta
// — "+ Cadastrar outro endereço" em Meus endereços. ENTRA COMO CANDIDATURA
// (rodada de candidatura canônica, 22/09/2026), igual ao caminho "Você
// também possui um comércio?": aparece em Candidaturas pro admin Aprovar/
// Recusar, e só vira ponto de verdade quando aprovada (liberarPapelNaConta).
// Achado real, corrigido nesta rodada: antes esta rota criava o PONTO
// direto (`repo.criar`), sem passar pelo admin — apesar do comentário aqui
// sempre ter dito "entra como lead, o dono aprova". Mesmo contrato de dados
// do outro caminho (`criarCandidaturaPonto`, src/conta/modos.js) — os dois
// formulários têm que pedir e mandar exatamente os mesmos campos.
router.post('/anunciantes/me/pontos', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta || !(conta.papeis || []).includes('ponto')) {
    return res.status(403).json({ erro: 'só contas de dono de ponto cadastram endereço' });
  }
  // Mesma régua das outras duas portas (repo.estabelecimentoJaCadastrado):
  // pedido em análise no mesmo endereço, ou o mesmo estabelecimento já
  // materializado como ponto desta conta. Antes só a primeira metade existia
  // — depois de aprovado, o mesmo lugar passava livre e virava ponto duplicado.
  const motivo = await repo.estabelecimentoJaCadastrado(conta.id, {
    nome: req.body.nome_comercio,
    endereco: req.body.endereco,
    cep: req.body.cep,
  });
  if (motivo) return res.status(409).json({ erro: motivo });
  try {
    const cand = await criarCandidaturaPonto(conta, req.body);
    // Outras abas da mesma conta: o pedido novo aparece em "Meus pontos".
    sse.emitirParaConta(conta.id, 'application.updated', { id: cand.id, status: cand.status });
    res.status(201).json({ ok: true, id: cand.id });
  } catch (err) {
    res.status(err.status || 400).json({ erro: err.message });
  }
});

// Pública — as duas opções de comodato que o estabelecimento escolhe no
// cadastro (ajuda de custo em dinheiro x mais cota de tela pro negócio dele)
router.get('/planos-ponto', async (_req, res) => {
  res.json(await planosPontoRepo.listarAtivos());
});

// Pública — "seja um ponto": cria lead, cai na fila do admin (módulo 5).
// Aceita mais de um endereço no mesmo envio (quem tem duas lojas manda as
// duas de uma vez): cada endereço vira um ponto próprio, com o mesmo
// responsável e o mesmo plano escolhido.
// v3: ponto não tem mais formulário nenhum sem conta (nem este, nem a
// candidatura pública que o substituiu — ver src/candidaturas/routes.js).
// Quem tiver este endpoint antigo salvo recebe o caminho atual.
router.post('/seja-um-ponto', (_req, res) => {
  res.status(410).json({ erro: 'crie sua conta e peça pra ser ponto de dentro do painel' });
});

// Extrato do ponto (GET /anunciantes/me/pontos/extrato) saiu com a página
// antiga do ponto (Fatia 6): o mesmo extrato, sem a anotação interna, está em
// GET /anunciantes/me/financeiro (src/conta/financeiro.js).

// Admin — protegido por requireAdminSession, montado em server.js

// Cadastro manual do ponto pelo admin (`POST /admin/pontos`) foi removido
// no redesenho da Rede (22/09/2026): o dono não cadastra ponto à mão, quem
// fornece os dados é o próprio estabelecimento pela candidatura
// (`POST /conta/modos/ponto/pedir` → liberarPapelNaConta, src/conta/modos.js,
// que já cria o ponto + Tela 1). Confirmado sem consumidor real antes de
// remover: nenhuma tela além do botão que sumiu chamava esta rota, nenhum
// teste (`tests/e2e/01-fluxo-api.sh` cria o ponto pela candidatura, não por
// aqui), nenhuma menção em `docs/api.md`. Documentado em `.ia/DECISIONS.md`.

router.get('/admin/pontos', async (_req, res) => {
  const pontos = await repo.listar();
  res.json(pontos);
});

// G.7 (docs/PENDENCIAS.md, pedido do dono 18/09/2026): quem ocupa cada ponto,
// e quanto. Reavalia o bloqueio aqui também — a tabela do admin é onde ele
// realmente olha isso, então é onde a régua de 80% precisa estar fresca.
router.get('/admin/pontos-ocupacao', async (_req, res) => {
  await repo.avaliarBloqueios();
  res.json(await repo.ocupacaoPorAnunciante());
});

// Libera um ponto pra escolha nova. Só aceita com folga real (ver
// `FOLGA_MINIMA_PARA_LIBERAR_SEGUNDOS`, src/pontos/repository.js) — sem
// isso, o próximo anunciante a cair ali rebloqueia o ponto minutos depois
// de o admin ter clicado, e a ação não teria significado nenhum.
router.post('/admin/pontos/:id/liberar-escolha', async (req, res) => {
  const liberou = await repo.liberarEscolha(req.params.id);
  if (!liberou) {
    return res
      .status(409)
      .json({ erro: 'ainda não sobra folga de 15 minutos nesse ponto — não dá pra liberar pra escolha agora' });
  }
  res.json({ ok: true });
});

router.patch('/admin/pontos/:id', async (req, res) => {
  try {
    // Trocar a MODALIDADE do comodato não é editar um campo: mexe no que a
    // Mostraí paga, no plano que o comerciante ganha e no crédito da conta
    // dele. Passa pela `aplicarModalidade`, que faz as três coisas juntas —
    // gravar só `plano_ponto_id` deixaria ele numa modalidade nova recebendo
    // a contrapartida da antiga. Este é o ÚNICO caminho para VOLTAR a receber
    // a ajuda de custo: é despesa nova e recorrente, e quem decide é o dono.
    if (req.body.plano_ponto_id) {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        const opcao = await comodato.aplicarModalidade(req.params.id, req.body.plano_ponto_id, cliente);
        if (!opcao) {
          await cliente.query('ROLLBACK');
          return res.status(400).json({ erro: 'ponto ou modalidade de comodato inválidos' });
        }
        await cliente.query('COMMIT');
      } catch (err) {
        await cliente.query('ROLLBACK');
        throw err;
      } finally {
        cliente.release();
      }
    }

    const { plano_ponto_id: _modalidade, ...resto } = req.body;
    const antes = await repo.buscarPorId(req.params.id);
    const ponto = Object.keys(resto).length
      ? await repo.atualizar(req.params.id, resto)
      : await repo.buscarPorId(req.params.id);
    if (!ponto) return res.status(404).json({ erro: 'ponto não encontrado' });

    // "Meus pontos" do dono atualiza sem F5. Os dois donos quando o vínculo
    // muda: um ganha o ponto, o outro perde.
    for (const dono of new Set([antes?.anunciante_id, ponto.anunciante_id].filter(Boolean))) {
      sse.emitirParaConta(dono, 'point.updated', { id: ponto.id });
    }
    res.json(ponto);
  } catch (err) {
    if (err.code === '23514') return res.status(400).json({ erro: 'status inválido' });
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  }
});

// O dono do ponto troca a ajuda de custo por tela, sozinho e na hora.
//
// Só neste sentido. Abrir mão dos R$ 50 não custa nada à Mostraí — ela para
// de pagar e ele ganha o dobro de tela — então não precisa pedir licença.
// VOLTAR a receber é despesa nova e recorrente, e sai pelo admin (o PATCH
// acima). Sem essa assimetria, dava pra pingar entre as modalidades todo mês
// e sacar a ajuda de custo só nos meses em que ela valesse mais.
router.post('/anunciantes/me/comodato/trocar-por-tela', exigirAnuncianteLogado, async (req, res) => {
  const { rows: meus } = await pool.query(
    `SELECT p.id, pp.ajuda_custo_mensal
       FROM pontos p LEFT JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
      WHERE p.anunciante_id = $1 AND p.status <> 'arquivado'`,
    [req.session.anuncianteId],
  );
  if (!meus.length) return res.status(400).json({ erro: 'sua conta não tem ponto no comodato' });

  const destino = await comodato.modalidadeSemDinheiro();
  if (!destino) return res.status(500).json({ erro: 'nenhuma modalidade sem ajuda de custo configurada' });

  const aTrocar = meus.filter((p) => Number(p.ajuda_custo_mensal || 0) > 0);
  if (!aTrocar.length) {
    return res.status(400).json({ erro: 'você já trocou a ajuda de custo por tela' });
  }

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    for (const p of aTrocar) await comodato.aplicarModalidade(p.id, destino.id, cliente);
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }

  eventos.registrar('comodato:trocado_por_tela', {
    anuncianteId: req.session.anuncianteId,
    pontos: aTrocar.map((p) => p.id),
  });
  sse.emitirParaConta(req.session.anuncianteId, 'point.updated', {});
  sse.emitirParaConta(req.session.anuncianteId, 'finance.updated', {});
  sse.emitirParaConta(req.session.anuncianteId, 'plan.updated', {});
  res.json({ ok: true, modalidade: destino.nome, pontos: aTrocar.length });
});

// Upload administrativo da foto do ponto (`POST /admin/pontos/:id/foto`)
// foi removido na rodada final da Rede (22/09/2026) — a foto pertence ao
// estabelecimento e vem da candidatura (`POST
// /conta/modos/ponto/candidaturas/:id/foto`, src/candidaturas/routes.js);
// sem consumidor real depois de tirar o botão "Trocar foto do ponto" do
// admin (confirmado antes de remover: só a UI que acabou de sair chamava
// esta rota).

// Admin — foto de EXEMPLO do "ponto completo" mostrada em pontos.html (não é
// de nenhum ponto real; é a ilustração genérica ao lado do mapa). Mesmo
// padrão de upload das demais fotos deste arquivo. A chave no bucket é fixa
// (upsert sobrescreve), e o `?v=` na URL salva evita que o navegador
// continue mostrando a foto antiga em cache depois da troca.
router.post('/admin/pontos/foto-exemplo', upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'arquivo obrigatório' });
  try {
    const supabase = require('../lib/supabase');
    const buffer = fs.readFileSync(req.file.path);
    const nomeArquivo = 'site/exemplo-ponto-completo.jpg';
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;
    const { error } = await supabase.storage.from(bucket).upload(nomeArquivo, buffer, {
      contentType: 'image/jpeg',
      upsert: true,
    });
    if (error) return res.status(502).json({ erro: 'falha ao salvar a foto' });
    const { data } = supabase.storage.from(bucket).getPublicUrl(nomeArquivo);
    const url = `${data.publicUrl}?v=${Date.now()}`;
    await repo.definirConfiguracao('foto_exemplo_ponto_url', url);
    res.json({ url });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// Chave por PONTO: rota morta desde a migration 019, quando a chave passou a
// ser por TELA (um ponto pode ter várias). Quem autentica o player lê
// `dispositivos.aparelho_id` (src/lib/aparelho.js) — esta aqui escrevia numa
// coluna que ninguém mais lê. Pior que inútil: gerava uma chave com cara de
// válida, que a TV recusaria, e o admin passaria a tarde procurando o defeito
// na tela errada. 410 como o /seja-um-ponto, dizendo qual é o caminho.
router.post('/admin/pontos/:id/aparelho', (_req, res) => {
  res.status(410).json({
    erro: 'a chave agora é por tela, não por ponto — use POST /admin/dispositivos/:id/chave',
  });
});

// Admin — controla o que cada opção de comodato oferece
router.get('/admin/planos-ponto', async (_req, res) => {
  res.json(await planosPontoRepo.listarTodos());
});

router.post('/admin/planos-ponto', async (req, res) => {
  const { id, nome, chamada } = req.body;
  if (!id || !nome || !chamada) return res.status(400).json({ erro: 'campos obrigatórios faltando' });
  try {
    res.status(201).json(await planosPontoRepo.criar(req.body));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'já existe uma opção com esse id' });
    throw err;
  }
});

router.patch('/admin/planos-ponto/:id', async (req, res) => {
  const plano = await planosPontoRepo.atualizar(req.params.id, req.body);
  if (!plano) return res.status(404).json({ erro: 'opção não encontrada' });
  res.json(plano);
});

// Admin lança e quita o pagamento do ponto. `competencia` chega 'AAAA-MM'.
// O UNIQUE (ponto_id, competencia) da migration 022 é o que impede pagar o
// mesmo mês duas vezes por duplo clique — aqui o conflito vira atualização.
router.get('/admin/pontos/:pontoId/pagamentos', async (req, res) => {
  res.json(await pagamentosRepo.listarPorPonto(req.params.pontoId));
});

// Fila financeira "quem devo pagar este mês" (rodada Financeiro, 22/09/2026)
// — usada pela Visão geral (contador/total) e pela tela de drill-down
// #financeiro/repasses.
router.get('/admin/pagamentos-ponto/pendentes', async (_req, res) => {
  res.json(await pagamentosRepo.listarPendentesDoMes());
});

router.post('/admin/pontos/:pontoId/pagamentos', async (req, res) => {
  const { competencia, valor, forma, observacao, pago_em } = req.body;
  if (!competencia || valor === undefined || valor === null) {
    return res.status(400).json({ erro: 'competência e valor são obrigatórios' });
  }
  if (Number(valor) < 0) return res.status(400).json({ erro: 'valor não pode ser negativo' });
  res.status(201).json(
    await pagamentosRepo.lancar({
      ponto_id: req.params.pontoId,
      competencia,
      valor,
      forma,
      observacao,
      pago_em,
    }),
  );
});

router.patch('/admin/pagamentos-ponto/:id', async (req, res) => {
  const pago = Boolean(req.body.pago);
  const linha = await pagamentosRepo.marcarPago(req.params.id, pago);
  if (!linha) return res.status(404).json({ erro: 'lançamento não encontrado' });
  // Só ao quitar. Desfazer não emite evento negativo: a pergunta é quanto a
  // rede custou, e desfazer é correção de lançamento, não custo.
  if (pago) {
    eventos.registrar('ponto:pagamento_quita', {
      ponto_id: linha.ponto_id,
      valor: linha.valor,
      competencia: linha.competencia,
    });
  }
  res.json(linha);
});

// Export no fim do arquivo, depois da ultima rota: estava no meio, e as tres
// rotas de pagamento ao ponto ficavam abaixo dele. Funcionava (o router e o
// mesmo objeto), mas quem lesse o arquivo de cima pra baixo concluiria que
// elas nao existem — e foi exatamente o que aconteceu numa revisao.
module.exports = router;
