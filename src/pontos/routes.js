const express = require('express');
const multer = require('multer');
const os = require('node:os');
const fs = require('node:fs');
const router = express.Router();
const repo = require('./repository');
const anunciantesRepo = require('../anunciantes/repository');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const { criarCandidaturaPonto } = require('../conta/modos');
const { meusPontosDaConta } = require('./meus-pontos');
const { situacaoDosPontos } = require('../creditos/ponto');
const sse = require('../lib/sse');
const { colunasDoEndereco } = require('../lib/endereco');

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
// é DERIVADO do ponto materializado (regra canônica: dono de ponto = tem
// ponto aprovado; nunca candidatura, nunca o papel legado em `papeis`).
router.get('/anunciantes/me/meus-pontos', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  const estabelecimentos = await meusPontosDaConta(conta.id);
  res.json({
    ehPonto: estabelecimentos.some((e) => e.tipo === 'ponto'),
    estabelecimentos,
  });
});

// "+ Cadastrar outro endereço" em Meus pontos. ENTRA COMO CANDIDATURA
// (rodada de candidatura canônica, 22/09/2026), igual ao caminho "Você
// também possui um comércio?" (`POST /conta/modos/ponto/pedir`): aparece em
// Candidaturas pro admin Aprovar/Recusar, e só vira ponto de verdade quando
// aprovada. Mesmo contrato de dados e mesma guarda (qualquer conta logada;
// a régua de duplicidade é por estabelecimento) — os dois nomes existem
// porque o painel os chama de lugares diferentes.
router.post('/anunciantes/me/pontos', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  // Mesma régua das outras duas portas (repo.estabelecimentoJaCadastrado):
  // pedido em análise no mesmo endereço, ou o mesmo estabelecimento já
  // materializado como ponto desta conta. Antes só a primeira metade existia
  // — depois de aprovado, o mesmo lugar passava livre e virava ponto duplicado.
  const motivo = await repo.estabelecimentoJaCadastrado(conta.id, {
    nome: req.body.nome_comercio,
    // A mesma linha "logradouro, número" que fica gravada (D5).
    endereco: colunasDoEndereco(req.body).endereco,
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

// `GET /planos-ponto` (as duas modalidades de comodato pra escolher no
// cadastro) foi aposentada em 24/09/2026 (ADR-016): não há escolha nenhuma,
// o ponto só pede pra entrar na rede. Nenhuma tela viva chama.
router.get('/planos-ponto', (_req, res) =>
  res.status(410).json({ erro: 'não há modalidades de ponto: seu ponto gera créditos todo mês' }),
);

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

// Cada ponto leva o benefício dele (ADR-016): +1 crédito por mês quando
// elegível — mesma regra do job (creditos/ponto.js), nunca recalculada aqui.
router.get('/admin/pontos', async (_req, res) => {
  const pontos = await repo.listar();
  const beneficios = await situacaoDosPontos(pontos.map((p) => p.id));
  res.json(pontos.map((p) => ({ ...p, beneficio: beneficios.get(p.id) || null })));
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
    // Modalidade de comodato aposentada (24/09/2026, ADR-016): não se troca
    // mais — o campo é ignorado se ainda vier.
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

// "Trocar os R$ 50 por tela" deixou de existir junto com as modalidades
// (24/09/2026, ADR-016).
router.post('/anunciantes/me/comodato/trocar-por-tela', exigirAnuncianteLogado, (_req, res) => {
  res.status(410).json({ erro: 'não há mais ajuda de custo: seu ponto gera créditos todo mês' });
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

// Modalidades de comodato e repasses (24/09/2026, ADR-016): ser ponto não é
// plano e não recebe dinheiro — gera 1 crédito por mês (creditos/ponto.js).
// Nenhuma rota cria modalidade nem repasse novo. O que já foi pago continua
// em `pagamentos_ponto`, só leitura (histórico/auditoria).
const APOSENTADO = { erro: 'modalidades de comodato e repasses foram substituídos pelos créditos do ponto' };
router.get('/admin/planos-ponto', (_req, res) => res.status(410).json(APOSENTADO));
router.post('/admin/planos-ponto', (_req, res) => res.status(410).json(APOSENTADO));
router.patch('/admin/planos-ponto/:id', (_req, res) => res.status(410).json(APOSENTADO));
router.get('/admin/pagamentos-ponto/pendentes', (_req, res) => res.status(410).json(APOSENTADO));
router.post('/admin/pontos/:pontoId/pagamentos', (_req, res) => res.status(410).json(APOSENTADO));
router.patch('/admin/pagamentos-ponto/:id', (_req, res) => res.status(410).json(APOSENTADO));

// Histórico de repasses (modelo antigo): sem tela desde 24/09/2026 (ADR-016)
// e sem código executável desde a consolidação final — a tabela
// `pagamentos_ponto` fica como histórico (o extrato do cliente em
// src/conta/financeiro.js ainda a lê).
router.get('/admin/pontos/:pontoId/pagamentos', (_req, res) => res.status(410).json(APOSENTADO));

// Export no fim do arquivo, depois da ultima rota: estava no meio, e as tres
// rotas de pagamento ao ponto ficavam abaixo dele. Funcionava (o router e o
// mesmo objeto), mas quem lesse o arquivo de cima pra baixo concluiria que
// elas nao existem — e foi exatamente o que aconteceu numa revisao.
module.exports = router;
