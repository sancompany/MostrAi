const express = require('express');
const multer = require('multer');
const os = require('os');
const fs = require('fs');
const router = express.Router();
const repo = require('./repository');
const criativosRepo = require('./criativos-repository');
const ffmpeg = require('../lib/ffmpeg');
const pool = require('../db/pool');
const planosRepo = require('../financeiro/planos-repository');
const { conferirSenha } = require('../lib/senha');
const { limiteTentativas, zerarTentativas } = require('../lib/limite-tentativas');
const convitesRepo = require('../convites/repository');
const vendedoresRepo = require('../financeiro/vendedores-repository');
const candidaturasRepo = require('../candidaturas/repository');
const pontosRepo = require('../pontos/repository');
const dispositivosRepo = require('../dispositivos/repository');
const planosPontoRepo = require('../pontos/planos-ponto-repository');

// fileFilter: sem ele dava pra subir um .html como "avatar" declarando
// text/html e o bucket público servia HTML executável no nosso domínio.
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^(image|video)\//.test(file.mimetype || '');
    cb(ok ? null : new Error('tipo de arquivo não aceito — envie imagem ou vídeo'), ok);
  },
});

// Cadastro. Dois caminhos na mesma rota:
//   - aberto: cria conta de ANUNCIANTE (único papel com cadastro público);
//   - por convite (?convite=token no corpo): a conta nasce com os papéis que o
//     dono pôs no link — ponto e vendedor só entram assim (CONSTRAINTS.md).
// Ponto que nasce de uma candidatura aprovada: endereço e contato vêm dela;
// ajuda de custo e cota vêm da opção de comodato escolhida (senão ficariam
// em zero e o dono do ponto escolheu à toa).
async function criarPontoDaCandidatura(cand, conta, planoPontoId, db) {
  const opcao = planoPontoId ? await planosPontoRepo.buscarPorId(planoPontoId) : null;
  const ponto = await pontosRepo.criar({
    nome: cand.nome_comercio || conta.nome_empresa, endereco: cand.endereco, cidade: cand.cidade || 'Matão',
    uf: cand.uf || 'SP', cep: cand.cep || '', segmento: cand.segmento || 'outro',
    responsavel_nome: cand.nome, responsavel_contato: cand.contato_telefone,
    fluxo_estimado_mensal: cand.fluxo_estimado_mensal, plano_ponto_id: opcao ? opcao.id : null,
    valor_pago_mensal: opcao ? opcao.ajuda_custo_mensal : 0,
    cota_autoanuncio_slots_hora: opcao ? opcao.cota_slots_hora : 0,
    anunciante_id: conta.id, status: 'aguardando_instalacao', aceitou_termos_em: new Date(),
  }, db);
  await dispositivosRepo.criar(ponto.id, { apelido: 'Tela 1' }, db);
  return ponto;
}

router.post('/anunciantes/cadastro', limiteTentativas, async (req, res) => {
  const {
    nome_empresa, cpf_cnpj, endereco, cidade, uf, cep,
    contato_email, contato_telefone, senha, aceitou_termos, indicado_por_cupom,
    responsavel_nome, responsavel_cpf, responsavel_email, responsavel_telefone,
    convite: tokenConvite, chave_pix,
  } = req.body;

  let convite = null;
  if (tokenConvite) {
    convite = await convitesRepo.buscarValido(tokenConvite);
    if (!convite) return res.status(400).json({ erro: 'convite inválido, usado ou expirado — fale com quem te enviou' });
  }
  const papeis = convite ? convite.papeis : ['anunciante'];
  const ehAnunciante = papeis.includes('anunciante');

  // Endereço comercial só é obrigatório pra quem anuncia; dono de ponto tem o
  // endereço no próprio ponto, vendedor não tem.
  if (!nome_empresa || !cpf_cnpj || !contato_email || !contato_telefone || !senha || !aceitou_termos
    || (ehAnunciante && (!endereco || !cidade || !uf || !cep))) {
    return res.status(400).json({ erro: 'campos obrigatórios faltando' });
  }
  if (papeis.includes('vendedor') && !chave_pix) {
    return res.status(400).json({ erro: 'chave Pix é obrigatória pra receber comissão' });
  }
  const senhaFraca = conferirSenha(senha);
  if (senhaFraca) return res.status(400).json({ erro: senhaFraca });

  const existente = await repo.buscarPorEmailComSenha(contato_email);
  if (existente) return res.status(409).json({ erro: 'e-mail já cadastrado' });

  const dadosConta = {
    nome_empresa, cpf_cnpj, endereco, cidade, uf, cep, contato_email, contato_telefone, senha,
    indicado_por_cupom, responsavel_nome, responsavel_cpf, responsavel_email, responsavel_telefone,
    categoria_id: req.body.categoria_id, categoria_livre: req.body.categoria_livre,
    papeis,
    // Quem entrou por convite já foi aprovado pelo dono ao gerar o link.
    status: convite ? 'aprovado' : 'pendente_aprovacao',
  };

  let anunciante;
  if (!convite) {
    anunciante = await repo.criar(dadosConta);
  } else {
    // Tudo ou nada, e o convite é consumido ANTES da conta existir: dois
    // cadastros simultâneos com o mesmo link não podem virar duas contas
    // aprovadas, e uma falha no perfil de vendedor/ponto não pode deixar
    // conta sem perfil com o convite já queimado.
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const consumido = await convitesRepo.consumir(tokenConvite, null, cliente);
      if (!consumido) {
        await cliente.query('ROLLBACK');
        return res.status(409).json({ erro: 'esse convite acabou de ser usado' });
      }
      anunciante = await repo.criar(dadosConta, cliente);
      await cliente.query('UPDATE convites SET conta_id = $2 WHERE id = $1', [consumido.id, anunciante.id]);
      if (papeis.includes('vendedor')) await vendedoresRepo.criar(anunciante.id, { chave_pix, nome: nome_empresa }, cliente);
      // Convite que nasceu de uma candidatura de ponto já traz o endereço: o
      // ponto é criado agora, ligado à conta nova, com a primeira tela.
      if (papeis.includes('ponto') && convite.candidatura_id) {
        const cand = await candidaturasRepo.buscarPorId(convite.candidatura_id);
        if (cand && cand.tipo === 'ponto') {
          await criarPontoDaCandidatura(cand, anunciante, req.body.plano_ponto_id, cliente);
        }
      }
      await cliente.query('COMMIT');
    } catch (err) {
      await cliente.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      cliente.release();
    }
  }
  // Loga a sessão na hora — o front manda direto pro painel, sem passar pela
  // tela de login de novo (mesmo padrão do POST /seja-um-ponto).
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ erro: 'erro interno' });
    req.session.anuncianteId = anunciante.id;
    res.status(201).json(anunciante);
  });
});

router.post('/anunciantes/login', limiteTentativas, async (req, res) => {
  const { email, senha } = req.body;
  const anunciante = await repo.buscarPorEmailComSenha(email);
  if (!anunciante || !(await repo.validarSenha(anunciante, senha))) {
    return res.status(401).json({ erro: 'e-mail ou senha inválidos' });
  }
  if (anunciante.excluido_em) {
    return res.status(403).json({ erro: 'essa conta foi excluída — fale com o suporte pra recuperar' });
  }
  zerarTentativas(req);
  // Sessão nova a cada login (fixação de sessão) — ver server.js.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ erro: 'erro interno' });
    req.session.anuncianteId = anunciante.id;
    res.json({ id: anunciante.id, nome_empresa: anunciante.nome_empresa, status: anunciante.status, papeis: anunciante.papeis });
  });
});

// Soft-delete: marca a conta e derruba a sessão na hora. Recuperação é manual
// pelo suporte dentro de 60 dias (zera excluido_em) — sem tela de undo.
router.post('/anunciantes/me/excluir', exigirAnuncianteLogado, async (req, res) => {
  await repo.atualizar(req.session.anuncianteId, { excluido_em: new Date() });
  req.session.destroy(() => res.json({ ok: true }));
});

router.post('/anunciantes/logout', (req, res) => {
  // destroy, não só zerar o campo: antes a sessão continuava válida no store
  // e sair como anunciante não derrubava afiliado/admin no mesmo cookie.
  req.session.destroy(() => res.json({ ok: true }));
});

function exigirAnuncianteLogado(req, res, next) {
  if (!req.session.anuncianteId) return res.status(401).json({ erro: 'não autenticado' });
  next();
}

// Painel do anunciante (módulo 7) — dados de conta; dashboard de exibições
// agregadas fica pro módulo 7 consumir via GET /anunciantes/:id/exibicoes
// quando o front pedir (leitura simples de exibicoes_contador, sem lógica nova).
router.get('/anunciantes/me', exigirAnuncianteLogado, async (req, res) => {
  const anunciante = await repo.buscarPorId(req.session.anuncianteId);
  if (!anunciante) return res.status(401).json({ erro: 'não autenticado' });
  const vendedor = (anunciante.papeis || []).includes('vendedor')
    ? await vendedoresRepo.buscarPorConta(anunciante.id) : null;
  res.json({ ...anunciante, vendedor });
});

// Edição de perfil self-service — lista branca própria (não os campos
// admin-only de repo.CAMPOS_ATUALIZAVEIS, ex.: cpf_cnpj/status/plano_id só
// mudam via admin, ver SPEC.md). Documento e e-mail de acesso também ficam
// de fora: mudança só via contato com o admin.
const CAMPOS_AUTOEDITAVEIS = [
  'nome_empresa', 'endereco', 'cidade', 'uf', 'cep', 'contato_telefone', 'categoria_id', 'categoria_livre',
  'responsavel_nome', 'responsavel_cpf', 'responsavel_email', 'responsavel_telefone',
];
router.patch('/anunciantes/me', exigirAnuncianteLogado, async (req, res) => {
  const dados = {};
  for (const campo of CAMPOS_AUTOEDITAVEIS) {
    if (req.body[campo] !== undefined) dados[campo] = req.body[campo];
  }
  res.json(await repo.atualizar(req.session.anuncianteId, dados));
});

router.post('/anunciantes/me/foto', exigirAnuncianteLogado, upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'arquivo obrigatório' });
  try {
    const supabase = require('../lib/supabase');
    const buffer = fs.readFileSync(req.file.path);
    const nomeArquivo = `avatares/anunciante-${req.session.anuncianteId}.jpg`;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;
    const { error } = await supabase.storage.from(bucket).upload(nomeArquivo, buffer, {
      // Fixo: o mimetype vem do cliente e o bucket é público.
      contentType: 'image/jpeg', upsert: true,
    });
    if (error) return res.status(502).json({ erro: 'falha ao salvar a foto' });
    const { data } = supabase.storage.from(bucket).getPublicUrl(nomeArquivo);
    res.json(await repo.atualizar(req.session.anuncianteId, { foto_url: data.publicUrl }));
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// Upload de criativo — autenticado como o próprio anunciante. Dispara a
// normalização (ffmpeg) na hora; se o ffmpeg falhar, o upload falha (não fica
// registro de criativo quebrado no banco).
router.post('/anunciantes/:id/criativos', exigirAnuncianteLogado, upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'arquivo obrigatório' });
  // Tudo dentro do try: o multer já gravou o arquivo em disco antes de
  // chegar aqui, e os `return` de erro que ficavam fora do finally deixavam
  // até 200 MB de lixo em /tmp por request recusada.
  try {
    if (Number(req.params.id) !== req.session.anuncianteId) {
      return res.status(403).json({ erro: 'só pode subir criativo pra própria conta' });
    }

    // Limite de criativos simultâneos vem do plano (ver migration 014) — sem
    // plano ainda, libera 1 só pra não travar quem está no meio do cadastro.
    const anunciante = await repo.buscarPorId(req.session.anuncianteId);
    const plano = anunciante.plano_id ? await planosRepo.buscarPorId(anunciante.plano_id) : null;
    const limite = plano ? plano.limite_criativos : 1;
    const emUso = await criativosRepo.contarNaoReprovados(req.session.anuncianteId);
    if (emUso >= limite) {
      return res.status(400).json({ erro: `seu plano permite até ${limite} criativo(s) ativo(s) — exclua um pra subir outro` });
    }

    const criativoTemp = await criativosRepo.criar({
      anunciante_id: req.session.anuncianteId,
      arquivo_original_url: req.file.originalname,
      arquivo_normalizado_url: null,
      thumbnail_url: null,
      duracao_segundos: null,
    });

    try {
      const normalizado = await ffmpeg.normalizar(req.file.path, criativoTemp.id);
      const criativo = await criativosRepo.atualizar(criativoTemp.id, normalizado);
      res.status(201).json(criativo);
    } catch (err) {
      // Se o ffmpeg falhar (arquivo corrompido, vídeo mais curto que 1s), a
      // linha já criada ficava no banco como "pendente" e ocupava a cota do
      // plano pra sempre — três arquivos ruins e o cliente nunca mais subia nada.
      await criativosRepo.deletar(criativoTemp.id);
      return res.status(400).json({ erro: 'não foi possível processar esse arquivo — confira se é um vídeo ou imagem válido' });
    }
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

router.get('/anunciantes/:id/criativos', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode ver criativos da própria conta' });
  }
  res.json(await criativosRepo.listarPorAnunciante(req.params.id));
});

// Excluir criativo — "substituir" no painel é isso + enviar outro pelo botão
// de upload normal, sem endpoint separado pra troca.
router.delete('/anunciantes/:id/criativos/:criativoId', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode excluir criativo da própria conta' });
  }
  const criativo = await criativosRepo.buscarPorId(req.params.criativoId);
  if (!criativo || criativo.anunciante_id !== req.session.anuncianteId) {
    return res.status(404).json({ erro: 'criativo não encontrado' });
  }
  await criativosRepo.deletar(req.params.criativoId);
  // Best-effort: limpa os arquivos do storage. Se falhar, não impede a
  // exclusão do registro — só fica lixo no bucket pra limpar depois.
  try {
    const supabase = require('../lib/supabase');
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;
    await supabase.storage.from(bucket).remove([`${req.params.criativoId}.mp4`, `${req.params.criativoId}-thumb.jpg`]);
  } catch { /* ignora */ }
  res.json({ ok: true });
});

// Dashboard de exibições (SPEC.md módulo 7) — tudo leitura agregada de
// exibicoes_contador (módulo 3) + cobrancas_confirmadas (módulo 6), sem
// tabela nova.
router.get('/anunciantes/:id/exibicoes', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode ver exibições da própria conta' });
  }
  const anuncianteId = req.params.id;

  const [totais, porPonto, porDia, cobrancas, anunciante] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(vezes_programadas),0) AS programadas, COALESCE(SUM(vezes_confirmadas),0) AS confirmadas
       FROM exibicoes_contador WHERE anunciante_id = $1`,
      [anuncianteId]
    ),
    pool.query(
      `SELECT p.id, p.nome, p.cidade,
              SUM(e.vezes_programadas) AS programadas, SUM(e.vezes_confirmadas) AS confirmadas
       FROM exibicoes_contador e JOIN pontos p ON p.id = e.ponto_id
       WHERE e.anunciante_id = $1
       GROUP BY p.id, p.nome, p.cidade
       ORDER BY confirmadas DESC`,
      [anuncianteId]
    ),
    pool.query(
      `SELECT date_trunc('day', janela_hora) AS dia, SUM(vezes_confirmadas) AS confirmadas
       FROM exibicoes_contador WHERE anunciante_id = $1
       GROUP BY dia ORDER BY dia DESC LIMIT 30`,
      [anuncianteId]
    ),
    pool.query(
      `SELECT id, valor, criado_em, nota_fiscal_status, nota_fiscal_url
       FROM cobrancas_confirmadas WHERE anunciante_id = $1 ORDER BY criado_em DESC`,
      [anuncianteId]
    ),
    repo.buscarPorId(anuncianteId),
  ]);

  const confirmadas = Number(totais.rows[0].confirmadas);
  const plano = anunciante.plano_id ? await planosRepo.buscarPorId(anunciante.plano_id) : null;

  res.json({
    totalProgramadas: Number(totais.rows[0].programadas),
    totalConfirmadas: confirmadas,
    porPonto: porPonto.rows,
    porDia: porDia.rows,
    cobrancas: cobrancas.rows,
    custoPorExibicao: plano && confirmadas > 0 ? Number(plano.valor_mensal) * plano.compromisso_meses / confirmadas : null,
  });
});

// Admin — protegido por requireAdminToken, montado em server.js
router.get('/admin/anunciantes', async (req, res) => {
  const anunciantes = await repo.listar();
  res.json(anunciantes);
});

// Criação manual pelo admin (cadastro "a frio", sem passar pelo formulário
// público) — mesma senha aleatória de 10 chars que o cadastro self-service
// pede na tela, só que aqui ninguém digitou uma: gera e devolve uma vez na
// resposta pro admin repassar por WhatsApp. Não há tela de "trocar senha"
// ainda — fica pro anunciante pedir reset por fora, se precisar.
router.post('/admin/anunciantes', async (req, res) => {
  const {
    nome_empresa, cpf_cnpj, endereco, cidade, uf, cep,
    contato_email, contato_telefone,
  } = req.body;

  if (!nome_empresa || !cpf_cnpj || !endereco || !cidade || !uf || !cep
    || !contato_email || !contato_telefone) {
    return res.status(400).json({ erro: 'campos obrigatórios faltando' });
  }
  // Senha informada precisa seguir a regra; sem senha, gera uma forte.
  const senhaFraca = req.body.senha ? conferirSenha(req.body.senha) : null;
  if (senhaFraca) return res.status(400).json({ erro: senhaFraca });

  const existente = await repo.buscarPorEmailComSenha(contato_email);
  if (existente) return res.status(409).json({ erro: 'e-mail já cadastrado' });

  const senhaGerada = req.body.senha || `${require('crypto').randomBytes(9).toString('base64url')}A1@`;
  const anunciante = await repo.criar({ ...req.body, senha: senhaGerada });
  res.status(201).json({ ...anunciante, senhaGerada });
});

router.patch('/admin/anunciantes/:id', async (req, res) => {
  try {
    const anunciante = await repo.atualizar(req.params.id, req.body);
    if (!anunciante) return res.status(404).json({ erro: 'anunciante não encontrado' });
    res.json(anunciante);
  } catch (err) {
    if (err.code === '23514') return res.status(400).json({ erro: 'status inválido' });
    throw err;
  }
});

module.exports = { router, exigirAnuncianteLogado };
