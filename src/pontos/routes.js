const express = require('express');
const multer = require('multer');
const os = require('node:os');
const fs = require('node:fs');
const router = express.Router();
const repo = require('./repository');
const eventos = require('../lib/eventos');
const planosPontoRepo = require('./planos-ponto-repository');
const categoriasRepo = require('../categorias/repository');
const pagamentosRepo = require('./pagamentos-repository');
const anunciantesRepo = require('../anunciantes/repository');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const pool = require('../db/pool');
const comodato = require('./comodato');

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 20 * 1024 * 1024 } });

// Pública — "onde estamos" (módulo 7)
router.get('/pontos', async (_req, res) => {
  const pontos = await repo.listarPublicos();
  res.json(pontos);
});

// Pública — soma de fluxo estimado dos pontos ativos, pra home/planos (prova
// social). Só a soma, nunca por ponto — e só aparece com 1.000+ pessoas
// somadas (ver repository).
router.get('/pontos/fluxo', async (_req, res) => {
  res.json({ pessoasPorMes: await repo.somaFluxoMensal() });
});

// Pública — foto de exemplo do "ponto completo" em pontos.html, trocável
// pelo admin sem deploy (pedido do dono, 18/09/2026). `null` até a primeira
// troca, e a página cai no arquivo estático padrão nesse caso.
router.get('/pontos/config', async (_req, res) => {
  res.json({ fotoExemploUrl: await repo.obterConfiguracao('foto_exemplo_ponto_url') });
});

// Painel do anunciante — "meus pontos" (mesma conta serve pra anunciar e pra
// hospedar tela, ver migration 016).
router.get('/anunciantes/:id/pontos', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode ver pontos da própria conta' });
  }
  res.json(await repo.listarPorAnunciante(req.params.id));
});

// Dono de ponto (papel vindo do convite) cadastra outro endereço pela conta.
// Entra como lead: o dono do Mostraí aprova no admin, como qualquer ponto.
router.post('/anunciantes/me/pontos', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta || !(conta.papeis || []).includes('ponto')) {
    return res.status(403).json({ erro: 'só contas de dono de ponto cadastram endereço' });
  }
  const { nome, endereco, cidade, uf, cep, segmento, categoria_id, responsavel_nome, responsavel_contato } = req.body;
  if (!nome || !endereco || !cidade || !uf || !cep)
    return res.status(400).json({ erro: 'nome e endereço completo são obrigatórios' });
  // Validado contra o catálogo: id inventado no corpo viraria FK quebrada, e
  // id de outra tabela viraria bloqueio de concorrente errado.
  const categoria = categoria_id ? await categoriasRepo.buscarAtivaPorId(categoria_id) : null;
  if (categoria_id && !categoria) return res.status(400).json({ erro: 'ramo inválido' });
  const ponto = await repo.criar({
    nome,
    endereco,
    cidade,
    uf,
    cep,
    segmento: segmento || 'outro',
    categoria_id: categoria ? categoria.id : null,
    responsavel_nome: responsavel_nome || conta.responsavel_nome || conta.nome_empresa,
    responsavel_contato: responsavel_contato || conta.contato_telefone,
    fluxo_estimado_mensal: req.body.fluxo_estimado_mensal,
    plano_ponto_id: req.body.plano_ponto_id || null,
    anunciante_id: conta.id,
    status: 'a_instalar',
    aceitou_termos_em: new Date(),
  });
  await dispositivosRepo.criar(ponto.id, { apelido: 'Tela 1' });
  res.status(201).json(ponto);
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

// Extrato do ponto — o que ele recebeu e o que está em aberto. Quem cede a
// parede precisa saber se o mês passado foi pago sem ter que perguntar; é o
// padrão de todo portal de quem hospeda tela de anúncio.
router.get('/anunciantes/me/pontos/extrato', exigirAnuncianteLogado, async (req, res) => {
  const linhas = await pagamentosRepo.extratoDaConta(req.session.anuncianteId);
  res.json({ linhas, resumo: pagamentosRepo.resumir(linhas) });
});

// Admin — protegido por requireAdminSession, montado em server.js
const dispositivosRepo = require('../dispositivos/repository');

// Admin cria o ponto — e a primeira tela junto, pra nunca existir ponto sem
// dispositivo (o player e o contador são por tela desde a migration 019).
router.post('/admin/pontos', async (req, res) => {
  const ponto = await repo.criar(req.body);
  await dispositivosRepo.criar(ponto.id, { apelido: 'Tela 1' });
  res.status(201).json(ponto);
});

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
    const ponto = Object.keys(resto).length
      ? await repo.atualizar(req.params.id, resto)
      : await repo.buscarPorId(req.params.id);
    if (!ponto) return res.status(404).json({ erro: 'ponto não encontrado' });

    res.json(ponto);
  } catch (err) {
    if (err.code === '23514') return res.status(400).json({ erro: 'status inválido' });
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
      WHERE p.anunciante_id = $1`,
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
  res.json({ ok: true, modalidade: destino.nome, pontos: aTrocar.length });
});

// Admin — foto real do ponto já com o molde instalado (mesmo padrão de
// upload da nota fiscal em financeiro/routes.js).
router.post('/admin/pontos/:id/foto', upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'arquivo obrigatório' });
  try {
    const supabase = require('../lib/supabase');
    const buffer = fs.readFileSync(req.file.path);
    // Number(): o `:id` chega decodificado e ia direto pro nome do objeto no
    // bucket — `..%2F..%2Fx` viraria uma chave de storage arbitrária.
    const nomeArquivo = `pontos/instalacao-${Number(req.params.id)}.jpg`;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;
    const { error } = await supabase.storage.from(bucket).upload(nomeArquivo, buffer, {
      contentType: 'image/jpeg',
      upsert: true,
    });
    if (error) return res.status(502).json({ erro: 'falha ao salvar a foto' });
    const { data } = supabase.storage.from(bucket).getPublicUrl(nomeArquivo);
    const ponto = await repo.atualizar(req.params.id, { foto_instalacao_url: data.publicUrl });
    if (!ponto) return res.status(404).json({ erro: 'ponto não encontrado' });
    res.json(ponto);
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

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
