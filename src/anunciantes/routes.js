const express = require('express');
const multer = require('multer');
const os = require('node:os');
const fs = require('node:fs');
const router = express.Router();
const repo = require('./repository');
const criativosRepo = require('./criativos-repository');
const ffmpeg = require('../lib/ffmpeg');
const pool = require('../db/pool');
const planosRepo = require('../financeiro/planos-repository');
const { conferirSenha } = require('../lib/senha');
const { validarCpfOuCnpj } = require('../br/documento');
const { cepValido, telefoneE164, data } = require('../br/formato');
const { limiteTentativas, zerarTentativas } = require('../lib/limite-tentativas');
const convitesRepo = require('../convites/repository');
const vendedoresRepo = require('../financeiro/vendedores-repository');
const candidaturasRepo = require('../candidaturas/repository');
const pontosRepo = require('../pontos/repository');
const dispositivosRepo = require('../dispositivos/repository');
const planosPontoRepo = require('../pontos/planos-ponto-repository');
const eventos = require('../lib/eventos');
const assinaturasRepo = require('../financeiro/assinaturas-repository');
const sanCheckout = require('../financeiro/san-checkout');
const { enviarContaAprovada } = require('../financeiro/email');

// fileFilter: sem ele dava pra subir um .html como "avatar" declarando
// text/html e o bucket público servia HTML executável no nosso domínio.
const upload = multer({
  dest: os.tmpdir(),
  // 95 MB e nao 200: assim que o dominio passar pelo proxy do Cloudflare (que
  // e o que permite pôr o Access na frente do /admin), o plano Free corta
  // qualquer corpo de requisicao acima de 100 MB — e o corte acontece ANTES de
  // chegar aqui, devolvendo uma pagina de erro do Cloudflare que o nosso
  // front-end nao sabe ler. Melhor um limite nosso, dito na tela, do que um
  // limite de terceiro que aparece como falha misteriosa. 95 MB continua muito
  // acima do que um video vertical de 30s ocupa (30 a 60 MB).
  limits: { fileSize: 95 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
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
  const ponto = await pontosRepo.criar(
    {
      nome: cand.nome_comercio || conta.nome_empresa,
      endereco: cand.endereco,
      cidade: cand.cidade || 'Matão',
      uf: cand.uf || 'SP',
      cep: cand.cep || '',
      segmento: cand.segmento || 'outro',
      responsavel_nome: cand.nome,
      responsavel_contato: cand.contato_telefone,
      fluxo_estimado_mensal: cand.fluxo_estimado_mensal,
      plano_ponto_id: opcao ? opcao.id : null,
      valor_pago_mensal: opcao ? opcao.ajuda_custo_mensal : 0,
      cota_autoanuncio_slots_hora: opcao ? opcao.cota_slots_hora : 0,
      anunciante_id: conta.id,
      status: 'aguardando_instalacao',
      aceitou_termos_em: new Date(),
    },
    db,
  );
  await dispositivosRepo.criar(ponto.id, { apelido: 'Tela 1' }, db);
  return ponto;
}

router.post('/anunciantes/cadastro', limiteTentativas, async (req, res) => {
  const {
    nome_empresa,
    cpf_cnpj,
    endereco,
    cidade,
    uf,
    cep,
    contato_email,
    contato_telefone,
    senha,
    aceitou_termos,
    indicado_por_cupom,
    responsavel_nome,
    responsavel_cpf,
    responsavel_email,
    responsavel_telefone,
    convite: tokenConvite,
    chave_pix,
  } = req.body;

  let convite = null;
  if (tokenConvite) {
    convite = await convitesRepo.buscarValido(tokenConvite);
    if (!convite)
      return res.status(400).json({ erro: 'convite inválido, usado ou expirado — fale com quem te enviou' });
  }
  const papeis = convite ? convite.papeis : ['anunciante'];
  const ehAnunciante = papeis.includes('anunciante');

  // Endereço comercial só é obrigatório pra quem anuncia; dono de ponto tem o
  // endereço no próprio ponto, vendedor não tem.
  if (
    !nome_empresa ||
    !cpf_cnpj ||
    !contato_email ||
    !contato_telefone ||
    !senha ||
    !aceitou_termos ||
    (ehAnunciante && (!endereco || !cidade || !uf || !cep))
  ) {
    return res.status(400).json({ erro: 'campos obrigatórios faltando' });
  }
  // Cupom era gravado como texto livre e so conferido na hora de pagar a
  // comissao. Cupom errado (digitado errado, de vendedor que saiu, ou o
  // proprio cupom de quem esta se cadastrando) passava batido: o anunciante
  // achava que tinha indicado alguem, o vendedor achava que tinha indicado, e
  // a comissao simplesmente nunca existia. Conferido aqui, com a mesma
  // consulta que paga a comissao la na frente.
  if (indicado_por_cupom) {
    const vendedor = await vendedoresRepo.buscarPorCupomAprovado(String(indicado_por_cupom).toUpperCase());
    if (!vendedor) {
      return res
        .status(400)
        .json({ erro: 'esse cupom de indicação não existe ou não está ativo', campo: 'indicado_por_cupom' });
    }
  }

  if (papeis.includes('vendedor') && !chave_pix) {
    return res.status(400).json({ erro: 'chave Pix é obrigatória pra receber comissão' });
  }
  // O documento vai daqui pro San Checkout e de lá pra Asaas como documento do
  // pagador. Documento inválido só quebra na hora de cobrar — depois que a
  // pessoa já foi embora. Conferir aqui é o único momento barato.
  const docInvalido = validarCpfOuCnpj(cpf_cnpj);
  if (docInvalido) return res.status(400).json({ erro: docInvalido, campo: 'cpf_cnpj' });
  if (responsavel_cpf && validarCpfOuCnpj(responsavel_cpf)) {
    return res
      .status(400)
      .json({ erro: 'CPF do responsável inválido — confira os números.', campo: 'responsavel_cpf' });
  }
  if (ehAnunciante && !cepValido(cep)) {
    return res.status(400).json({ erro: 'CEP inválido — use 8 dígitos.', campo: 'cep' });
  }
  const telefone = telefoneE164(contato_telefone);
  if (!telefone)
    return res.status(400).json({ erro: 'Telefone inválido — informe DDD e número.', campo: 'contato_telefone' });

  const senhaFraca = conferirSenha(senha);
  if (senhaFraca) return res.status(400).json({ erro: senhaFraca });

  const existente = await repo.buscarPorEmailComSenha(contato_email);
  if (existente) return res.status(409).json({ erro: 'e-mail já cadastrado' });

  const dadosConta = {
    nome_empresa,
    cpf_cnpj,
    endereco,
    cidade,
    uf,
    cep,
    contato_email,
    contato_telefone: telefone,
    senha,
    indicado_por_cupom,
    responsavel_nome,
    responsavel_cpf,
    responsavel_email,
    responsavel_telefone,
    categoria_id: req.body.categoria_id,
    categoria_livre: req.body.categoria_livre,
    papeis,
    // Não existe mais aprovação de conta — ela nasce liberada, por convite
    // ou pelo cadastro aberto (decisão do dono, 15/09/2026: pagar já ativava
    // a conta de qualquer forma, então a fila de aprovação nunca foi um
    // portão de verdade). O único portão que sobra é o do criativo.
    //
    // `status` deixou de ser estado operacional (decisão do dono, 16/09/2026):
    // agora só distingue comum/parceiro. Toda conta nova nasce 'comum'; quem
    // vira 'parceiro' é marcado à mão pelo admin (substitui o antigo flag
    // `fundador`). O que hoje bloqueia (não pagou, cobertura venceu, admin
    // suspendeu) é o campo `suspenso`.
    status: 'comum',
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
      if (papeis.includes('vendedor'))
        await vendedoresRepo.criar(anunciante.id, { chave_pix, nome: nome_empresa }, cliente);
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
  eventos.registrar(
    'conta:cadastro_conclui',
    {
      papel_inicial: (anunciante.papeis || [])[0] || 'anunciante',
      veio_de_cupom: !!anunciante.indicado_por_cupom,
      veio_de_convite: !!req.body.convite,
    },
    anunciante,
  );

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
    res.json({
      id: anunciante.id,
      nome_empresa: anunciante.nome_empresa,
      status: anunciante.status,
      papeis: anunciante.papeis,
    });
  });
});

// Soft-delete: marca a conta e derruba a sessão na hora. Recuperação é manual
// pelo suporte dentro de 60 dias (zera excluido_em) — sem tela de undo.
router.post('/anunciantes/me/excluir', exigirAnuncianteLogado, async (req, res) => {
  const conta = await repo.buscarPorId(req.session.anuncianteId);

  // Excluir a conta sem cancelar a assinatura deixava a cobrança recorrente
  // viva: o Checkout seguia cobrando todo ciclo uma conta que pediu pra sair,
  // e a comissão do vendedor continuava sendo paga por ela. Cancela lá
  // primeiro — se falhar, nada muda aqui e a pessoa tenta de novo, que é a
  // mesma ordem do pedido de arrependimento (src/titular/routes.js).
  const assinatura = conta ? await assinaturasRepo.buscarAtivaDoAnunciante(conta.id) : null;
  if (assinatura) {
    try {
      await sanCheckout.cancelarAssinatura(assinatura.id, conta.cpf_cnpj);
      await assinaturasRepo.marcarCancelada(assinatura.id);
    } catch {
      return res.status(502).json({
        erro: 'não conseguimos cancelar a sua cobrança agora — tente de novo em alguns minutos',
      });
    }
  }

  await repo.atualizar(req.session.anuncianteId, { excluido_em: new Date() });
  if (conta) {
    eventos.registrar(
      'conta:exclusao_pede',
      {
        dias_de_vida: eventos.diasEntre(conta.created_at),
        tinha_plano_ativo:
          !!conta.plano_id && !conta.suspenso && (!conta.data_expiracao || new Date(conta.data_expiracao) > new Date()),
      },
      conta,
    );
  }
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
    ? await vendedoresRepo.buscarPorConta(anunciante.id)
    : null;
  res.json({ ...anunciante, vendedor });
});

// Edição de perfil self-service — lista branca própria (não os campos
// admin-only de repo.CAMPOS_ATUALIZAVEIS, ex.: cpf_cnpj/status/plano_id só
// mudam via admin, ver SPEC.md). Documento e e-mail de acesso também ficam
// de fora: mudança só via contato com o admin.
const CAMPOS_AUTOEDITAVEIS = [
  'nome_empresa',
  'endereco',
  'cidade',
  'uf',
  'cep',
  'contato_telefone',
  'categoria_id',
  'categoria_livre',
  'responsavel_nome',
  'responsavel_cpf',
  'responsavel_email',
  'responsavel_telefone',
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
      contentType: 'image/jpeg',
      upsert: true,
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
// Subir criativo é o mesmo trabalho pedido de dois lugares: pelo anunciante,
// na conta dele, e pelo admin, na conta própria do Mostraí. A diferença é só
// quem autoriza e qual é o teto — então a rotina mora aqui uma vez, e as duas
// rotas abaixo a chamam. Duplicar isso significaria manter dois lugares que
// lidam com ffmpeg, arquivo temporário e limpeza de /tmp.
async function subirCriativo(req, res, { contaId, limite, peloOperador = false }) {
  if (!req.file) return res.status(400).json({ erro: 'arquivo obrigatório' });
  // Tudo dentro do try: o multer já gravou o arquivo em disco antes de
  // chegar aqui, e os `return` de erro que ficavam fora do finally deixavam
  // até 95 MB de lixo em /tmp por request recusada.
  try {
    if (Number.isFinite(limite)) {
      const emUso = await criativosRepo.contarNaoReprovados(contaId);
      if (emUso >= limite) {
        return res
          .status(400)
          .json({ erro: `seu plano permite até ${limite} criativo(s) ativo(s) — exclua um pra subir outro` });
      }
    }

    // Duração: a vitrine pede "15 a 30 segundos" e nada nunca conferiu. Um
    // vídeo de três minutos entrava inteiro e tomava, sozinho, o lugar de seis
    // anúncios no rodízio — sem ninguém ver. O teto é 60s (o dobro do
    // recomendado, pra não recusar quem passou um pouco) e o piso, 3s.
    // Imagem não entra na conta: ela vira vídeo com duração fixa nossa.
    const midia = await ffmpeg.probeMidia(req.file.path).catch(() => null);
    if (!midia) {
      return res
        .status(400)
        .json({ erro: 'não foi possível ler esse arquivo — confira se é um vídeo ou imagem válido' });
    }
    if (!midia.ehImagem && (midia.duracao_segundos > 60 || midia.duracao_segundos < 3)) {
      return res.status(400).json({
        erro: `esse vídeo tem ${midia.duracao_segundos}s — a tela aceita de 3 a 60 segundos, e o ideal são 15 a 30`,
      });
    }

    const criativoTemp = await criativosRepo.criar({
      anunciante_id: contaId,
      arquivo_original_url: req.file.originalname,
      arquivo_normalizado_url: null,
      thumbnail_url: null,
      duracao_segundos: null,
    });

    try {
      const normalizado = await ffmpeg.normalizar(req.file.path, criativoTemp.id);
      // Peça que o operador subiu já entra aprovada: quem aprovaria é quem
      // acabou de subir. Fazer o dono aprovar o próprio upload seria um clique
      // sem decisão nenhuma por trás.
      const criativo = await criativosRepo.atualizar(criativoTemp.id, {
        ...normalizado,
        ...(peloOperador ? { editado_pelo_operador: true, status: 'aprovado' } : {}),
      });
      res.status(201).json(criativo);
    } catch (err) {
      // Se o ffmpeg falhar (arquivo corrompido, vídeo mais curto que 1s), a
      // linha já criada ficava no banco como "pendente" e ocupava a cota do
      // plano pra sempre — três arquivos ruins e o cliente nunca mais subia nada.
      // O erro vai pro log: sem isso, falha de storage (credencial vencida,
      // bucket errado) e arquivo ruim do cliente viravam a mesma frase, e não
      // dava pra saber qual dos dois era sem reproduzir na mão.
      console.error('falha ao processar criativo', err);
      await criativosRepo.deletar(criativoTemp.id);
      if (err && err.origem === 'storage') {
        return res.status(502).json({
          erro: 'o problema foi nosso: o armazenamento não respondeu agora. Tente de novo em alguns minutos — o seu arquivo está ok',
        });
      }
      return res
        .status(400)
        .json({ erro: 'não foi possível processar esse arquivo — confira se é um vídeo ou imagem válido' });
    }
  } finally {
    fs.unlink(req.file.path, () => {});
  }
}

router.post('/anunciantes/:id/criativos', exigirAnuncianteLogado, upload.single('arquivo'), async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(403).json({ erro: 'só pode subir criativo pra própria conta' });
  }
  // Limite de criativos simultâneos vem do plano (ver migration 014) — sem
  // plano ainda, libera 1 só pra não travar quem está no meio do cadastro.
  const anunciante = await repo.buscarPorId(req.session.anuncianteId);
  const plano = anunciante.plano_id ? await planosRepo.buscarPorId(anunciante.plano_id) : null;
  return subirCriativo(req, res, {
    contaId: req.session.anuncianteId,
    limite: plano ? plano.limite_criativos : 1,
  });
});

// Admin subindo criativo na conta de um anunciante.
//
// É o caminho normal do Mostraí, não uma exceção: a peça é feita FORA do site
// — por quem o dono combinar, na reunião de WhatsApp — e depois entra direto
// na conta do cliente. O anunciante também pode subir a dele, e os dois
// caminhos convivem.
//
// A conta própria do Mostraí não tem teto (o inventário é da casa); nas contas
// de cliente vale o limite do plano, senão o teto vendido deixaria de valer
// justamente quando é o operador que sobe.
//
// `editado_pelo_operador` marca a origem. A coluna já existia desde a
// migration 003 — é o registro de que aquela peça não veio do anunciante, e
// serve pra ninguém cobrar dele um vídeo que o Mostraí montou.
router.post('/admin/anunciantes/:id/criativos', upload.single('arquivo'), async (req, res) => {
  const conta = await repo.buscarPorId(req.params.id);
  if (!conta) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ erro: 'conta não encontrada' });
  }
  const plano = conta.plano_id ? await planosRepo.buscarPorId(conta.plano_id) : null;
  return subirCriativo(req, res, {
    contaId: conta.id,
    limite: conta.conta_propria ? Infinity : plano ? plano.limite_criativos : 1,
    peloOperador: true,
  });
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
  } catch {
    /* ignora */
  }
  res.json({ ok: true });
});

// Dashboard de exibições (SPEC.md módulo 7) — tudo leitura agregada de
// exibicoes_contador (módulo 3) + cobrancas_confirmadas (módulo 6), sem
// tabela nova.
// Comprovante de veiculação em CSV — o que o setor chama de proof-of-play.
// O dado já existia em `exibicoes_contador`; faltava a forma que o anunciante
// consegue guardar, imprimir ou mandar pro contador dele.
//
// `;` e BOM porque o Excel em português com vírgula junta tudo numa coluna só
// e come os acentos. O `?desde=` respeita o mesmo recorte da tela.
router.get('/anunciantes/:id/exibicoes.csv', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode ver exibições da própria conta' });
  }
  const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);
  const { rows } = await pool.query(
    `SELECT date_trunc('day', e.janela_hora) AS dia, p.nome AS ponto, p.cidade,
            d.apelido AS tela, SUM(e.vezes_confirmadas)::int AS exibicoes
     FROM exibicoes_contador e
     JOIN dispositivos d ON d.id = e.dispositivo_id
     JOIN pontos p ON p.id = d.ponto_id
     WHERE e.anunciante_id = $1 AND e.janela_hora > now() - ($2 || ' days')::interval
     GROUP BY dia, p.nome, p.cidade, d.apelido
     HAVING SUM(e.vezes_confirmadas) > 0
     ORDER BY dia DESC, p.nome`,
    [req.params.id, dias],
  );

  const campo = (v) => {
    const t = String(v ?? '');
    return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const linhas = [['Data', 'Ponto', 'Cidade', 'Tela', 'Exibições'].join(';')];
  for (const r of rows) {
    linhas.push([data(r.dia), r.ponto, r.cidade, r.tela || '—', r.exibicoes].map(campo).join(';'));
  }
  const total = rows.reduce((soma, r) => soma + r.exibicoes, 0);
  linhas.push(['', '', '', 'Total', total].join(';'));

  const arquivo = `mostrai-exibicoes-${dias}dias.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${arquivo}"`);
  res.send('\uFEFF' + linhas.join('\r\n') + '\r\n');
});

router.get('/anunciantes/:id/exibicoes', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode ver exibições da própria conta' });
  }
  const anuncianteId = req.params.id;

  const [totais, porPonto, porDia, cobrancas, anunciante] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(vezes_programadas),0) AS programadas, COALESCE(SUM(vezes_confirmadas),0) AS confirmadas
       FROM exibicoes_contador WHERE anunciante_id = $1`,
      [anuncianteId],
    ),
    pool.query(
      `SELECT p.id, p.nome, p.cidade,
              SUM(e.vezes_programadas) AS programadas, SUM(e.vezes_confirmadas) AS confirmadas
       FROM exibicoes_contador e
       JOIN dispositivos d ON d.id = e.dispositivo_id
       JOIN pontos p ON p.id = d.ponto_id
       WHERE e.anunciante_id = $1
       GROUP BY p.id, p.nome, p.cidade
       ORDER BY confirmadas DESC`,
      [anuncianteId],
    ),
    pool.query(
      `SELECT date_trunc('day', janela_hora) AS dia, SUM(vezes_confirmadas) AS confirmadas
       FROM exibicoes_contador WHERE anunciante_id = $1
       GROUP BY dia ORDER BY dia DESC LIMIT 30`,
      [anuncianteId],
    ),
    pool.query(
      `SELECT id, valor, criado_em, nota_fiscal_status, nota_fiscal_url
       FROM cobrancas_confirmadas WHERE anunciante_id = $1 ORDER BY criado_em DESC`,
      [anuncianteId],
    ),
    repo.buscarPorId(anuncianteId),
  ]);

  const confirmadas = Number(totais.rows[0].confirmadas);
  const plano = anunciante.plano_id ? await planosRepo.buscarPorId(anunciante.plano_id) : null;

  // Quantas pecas ja estao aprovadas: e o que decide a frase que o painel
  // mostra quando tudo esta zerado ("falta o seu video" x "ja esta no ar, os
  // numeros comecam a aparecer").
  const { rows: aprovados } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM criativos
      WHERE anunciante_id = $1 AND status = 'aprovado' AND arquivo_normalizado_url IS NOT NULL`,
    [req.params.id],
  );

  res.json({
    totalProgramadas: Number(totais.rows[0].programadas),
    totalConfirmadas: confirmadas,
    criativosAprovados: aprovados[0].n,
    porPonto: porPonto.rows,
    porDia: porDia.rows,
    cobrancas: cobrancas.rows,
    // O que a conta PAGA, nao o preco de tabela: quem esta em cortesia nao paga
    // nada — mostrar "custo por exibicao" pra quem recebeu o plano de graca e
    // numero inventado.
    //
    // O valor sai de `valorMensalDaConta`, a MESMA funcao que decide o que o
    // San Checkout cobra. A conta inline que estava aqui so enxergava o preco
    // travado; nao enxergava o desconto de parceiro (RN-31) nem o de comodato
    // (RN-32), que nasceram depois. Resultado: parceiro e dono de ponto viam,
    // na propria tela, um custo por exibicao MAIOR do que o que pagam. E o
    // furo M11 de volta, por outra porta — preco de cobranca so pode ter uma
    // fonte, e ela e a do motor de pagamento.
    custoPorExibicao:
      plano && confirmadas > 0 && !anunciante.plano_cortesia
        ? (sanCheckout.valorMensalDaConta(anunciante, plano) * plano.compromisso_meses) / confirmadas
        : null,
  });
});

// Admin — protegido por requireAdminToken, montado em server.js
router.get('/admin/anunciantes', async (_req, res) => {
  const anunciantes = await repo.listar();
  res.json(anunciantes);
});

// Criação manual pelo admin (cadastro "a frio", sem passar pelo formulário
// público) — mesma senha aleatória de 10 chars que o cadastro self-service
// pede na tela, só que aqui ninguém digitou uma: gera e devolve uma vez na
// resposta pro admin repassar por WhatsApp. Não há tela de "trocar senha"
// ainda — fica pro anunciante pedir reset por fora, se precisar.
router.post('/admin/anunciantes', async (req, res) => {
  const { nome_empresa, cpf_cnpj, endereco, cidade, uf, cep, contato_email, contato_telefone } = req.body;

  // Endereço é exigido de quem vai receber nota — a CONTA PRÓPRIA do Mostraí
  // não recebe nota nenhuma: ela é a própria rede anunciando. Pedir endereço
  // dela só produziria endereço de mentira no cadastro.
  const ehPropria = req.body.conta_propria === true;
  if (
    !nome_empresa ||
    !cpf_cnpj ||
    !contato_email ||
    !contato_telefone ||
    (!ehPropria && (!endereco || !cidade || !uf || !cep))
  ) {
    return res.status(400).json({ erro: 'campos obrigatórios faltando' });
  }
  const docInvalido = validarCpfOuCnpj(cpf_cnpj);
  if (docInvalido) return res.status(400).json({ erro: docInvalido, campo: 'cpf_cnpj' });
  // Senha informada precisa seguir a regra; sem senha, gera uma forte.
  const senhaFraca = req.body.senha ? conferirSenha(req.body.senha) : null;
  if (senhaFraca) return res.status(400).json({ erro: senhaFraca });

  const existente = await repo.buscarPorEmailComSenha(contato_email);
  if (existente) return res.status(409).json({ erro: 'e-mail já cadastrado' });

  // Conferir ANTES de criar. O índice único do banco recusaria a segunda
  // conta própria de qualquer jeito, mas a essa altura a conta já teria sido
  // inserida e sobraria uma linha órfã sem a marca — meio criada, que é pior
  // que não criada. O índice segue sendo a última linha de defesa.
  if (ehPropria && (await repo.existeContaPropria())) {
    return res
      .status(409)
      .json({ erro: 'já existe uma conta própria do Mostraí — edite a que existe em "Meus anúncios"' });
  }

  const senhaGerada = req.body.senha || `${require('node:crypto').randomBytes(9).toString('base64url')}A1@`;
  let anunciante = await repo.criar({ ...req.body, senha: senhaGerada });

  // `conta_propria` dá anúncio ilimitado e de graça na rede inteira, então ela
  // NÃO entra no INSERT do repository: assim nenhum caminho de cadastro —
  // público, por convite ou por bônus — consegue marcá-la, nem por engano nem
  // por corpo forjado. Só este ponto, atrás da sessão de admin, e passando
  // pela allowlist de `atualizar`.
  if (ehPropria) {
    anunciante = await repo.atualizar(anunciante.id, {
      conta_propria: true,
      frequencia_hora_propria: Number(req.body.frequencia_hora_propria) || 1,
    });
  }
  // Conta criada pelo dono também é aquisição: o negócio fecha por WhatsApp e
  // o admin cadastra o cliente depois. Deixar de fora furaria o funil
  // justamente no caminho que mais vende. A conta própria do Mostraí não
  // conta, e não por exceção escrita aqui — `ehInterno` já a marca.
  eventos.registrar(
    'conta:cadastro_conclui',
    {
      papel_inicial: (anunciante.papeis || [])[0] || 'anunciante',
      veio_de_cupom: !!anunciante.indicado_por_cupom,
      veio_de_convite: false,
      pelo_operador: true,
    },
    anunciante,
  );

  res.status(201).json({ ...anunciante, senhaGerada });
});

router.patch('/admin/anunciantes/:id', async (req, res) => {
  try {
    const antes = await repo.buscarPorId(req.params.id);
    const anunciante = await repo.atualizar(req.params.id, req.body);
    if (!anunciante) return res.status(404).json({ erro: 'anunciante não encontrado' });

    // Só na TRANSIÇÃO de suspensa pra liberada. Sem comparar com o estado
    // anterior, todo salvamento do admin numa conta já liberada contaria
    // como uma reinstalação nova. Conta nova já nasce liberada (não há mais
    // aprovação de conta, 15/09/2026) — o caso real que sobra aqui é
    // reinstalar uma conta suspensa. `suspenso` é o campo operacional desde
    // 16/09/2026 (`status` virou só comum/parceiro, não bloqueia mais nada).
    if (antes?.suspenso && !anunciante.suspenso) {
      eventos.registrar(
        'conta:aprovacao_recebe',
        {
          papel_liberado: (anunciante.papeis || [])[0] || 'anunciante',
          horas_ate_aprovar: eventos.horasEntre(anunciante.created_at),
        },
        anunciante,
      );
      // Fire-and-forget: e-mail que falha nao pode desfazer uma aprovacao.
      enviarContaAprovada(anunciante).catch((err) => console.error('e-mail de conta aprovada', err));
    }
    res.json(anunciante);
  } catch (err) {
    if (err.code === '23514') return res.status(400).json({ erro: 'status inválido' });
    throw err;
  }
});

module.exports = { router, exigirAnuncianteLogado };
