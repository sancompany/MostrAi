const express = require('express');
const multer = require('multer');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const router = express.Router();
const repo = require('./repository');
const { planoEfetivoId } = repo;
const criativosRepo = require('./criativos-repository');
const ffmpeg = require('../lib/ffmpeg');
const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const planosRepo = require('../financeiro/planos-repository');
const { conferirSenha } = require('../lib/senha');
const { validarCpfOuCnpj } = require('../br/documento');
const { pontosDoAnunciante, segundosCompensados, horasDeTelaPorMes } = require('../lib/pacing');
const { resumo: resumoHorarioSemanal } = require('../lib/horario-semanal');
const { cepValido, telefoneE164, data } = require('../br/formato');
const { PARTES: PARTES_DO_ENDERECO, colunasDoEndereco, parteQueFalta } = require('../lib/endereco');
const { limiteTentativas, zerarTentativas } = require('../lib/limite-tentativas');
const convitesRepo = require('../convites/repository');
const candidaturasRepo = require('../candidaturas/repository');
const pontosRepo = require('../pontos/repository');
const { materializarPontoDaCandidatura } = require('../pontos/materializar');
const indicacoesRepo = require('../indicacoes/repository');
const categoriasRepo = require('../categorias/repository');
const { removerAvatar } = require('../lib/avatar');
const eventos = require('../lib/eventos');
const notificacoesRepo = require('../creditos/notificacoes');
const sse = require('../lib/sse');
const assinaturasRepo = require('../financeiro/assinaturas-repository');
const planoAdministrativo = require('../financeiro/plano-administrativo');
const sanCheckout = require('../financeiro/san-checkout');
const cicloContratado = require('../financeiro/ciclo-contratado');
const bancohorasRepo = require('../bancohoras/repository');
const { CRIATIVOS_POR_CONTA } = require('../lib/limites');
const { saudeDaTela } = require('../lib/status-tela');
const { limiteDeCriativos } = require('../playlist/gerador');
const {
  enviarContaReativada,
  enviarContaCriada,
  enviarContaExcluida,
  enviarCodigoConfirmacaoEmail,
} = require('../financeiro/email');

// Confirmação de e-mail por código (migration 061). Apaga o código anterior
// antes de gerar outro: só o último vale, pedir de novo não deve deixar dois
// códigos válidos ao mesmo tempo.
const VALIDADE_CODIGO_EMAIL_MS = 2 * 60 * 1000;
async function enviarNovoCodigoConfirmacao(anunciante) {
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await pool.query('DELETE FROM tokens_confirmacao_email WHERE anunciante_id = $1', [anunciante.id]);
  await pool.query('INSERT INTO tokens_confirmacao_email (anunciante_id, codigo, expira_em) VALUES ($1,$2,$3)', [
    anunciante.id,
    codigo,
    new Date(Date.now() + VALIDADE_CODIGO_EMAIL_MS),
  ]);
  return enviarCodigoConfirmacaoEmail(anunciante, codigo);
}

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
// Ponto que nasce de uma candidatura aprovada: endereço e contato vêm dela
// (src/pontos/materializar.js — a mesma função da liberação pelo admin).

router.post('/anunciantes/cadastro', limiteTentativas, async (req, res) => {
  const {
    nome_empresa,
    cpf_cnpj,
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
  } = req.body;

  let convite = null;
  if (tokenConvite) {
    convite = await convitesRepo.buscarValido(tokenConvite);
    if (!convite)
      return res.status(400).json({ erro: 'convite inválido, usado ou expirado — fale com quem te enviou' });
  }
  // Papel Vendedor aposentado (reconstrução de Contas, 23/09/2026, pedido do
  // dono): convite antigo que ainda carregue 'vendedor' não cria vendedor
  // novo — a conta nasce com o resto dos papéis (ou só anunciante). Os
  // vendedores que já existem ficam no banco, intactos.
  const papeisDoConvite = convite ? convite.papeis.filter((p) => p !== 'vendedor') : [];
  const papeis = papeisDoConvite.length ? papeisDoConvite : ['anunciante'];
  const ehAnunciante = papeis.includes('anunciante');

  // Endereço comercial só é obrigatório pra quem anuncia; dono de ponto tem o
  // endereço no próprio ponto, vendedor não tem. Em partes desde 24/09/2026
  // (D5, src/lib/endereco.js): CEP, logradouro, número, bairro, cidade e UF.
  const endereco = colunasDoEndereco(req.body);
  if (!nome_empresa || !cpf_cnpj || !contato_email || !contato_telefone || !senha || !aceitou_termos) {
    return res.status(400).json({ erro: 'campos obrigatórios faltando' });
  }
  const faltaNoEndereco = ehAnunciante && parteQueFalta(endereco);
  if (faltaNoEndereco) {
    return res.status(400).json({ erro: `endereço incompleto — preencha o campo ${faltaNoEndereco}` });
  }
  // Cupom era gravado como texto livre e so conferido na hora de pagar a
  // comissao. Cupom errado (digitado errado, de vendedor que saiu, ou o
  // proprio cupom de quem esta se cadastrando) passava batido: o anunciante
  // achava que tinha indicado alguem, o vendedor achava que tinha indicado, e
  // a comissao simplesmente nunca existia. Conferido aqui, com a mesma
  // consulta que paga a comissao la na frente.
  if (indicado_por_cupom) {
    // Cupom de ponto sempre começa com "PT-" (migration 062) — namespace
    // separado do de vendedor, então dá pra rotear sem ambiguidade e sem
    // gastar duas consultas por cadastro comum.
    // Cupom de vendedor não vale mais (programa aposentado, 23/09/2026 — sem
    // indicação nova, sem comissão nova). O front já reenvia o cadastro sem o
    // cupom quando o erro vem com `campo`, então o link antigo só perde a
    // indicação, não o cadastro. Cupom de ponto (PT-) segue valendo.
    const cupom = String(indicado_por_cupom).toUpperCase();
    const encontrado = cupom.startsWith('PT-') ? await indicacoesRepo.buscarPontoPorCupom(cupom) : null;
    if (!encontrado) {
      return res
        .status(400)
        .json({ erro: 'esse cupom de indicação não existe ou não está ativo', campo: 'indicado_por_cupom' });
    }
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
  if (ehAnunciante && !cepValido(endereco.cep)) {
    return res.status(400).json({ erro: 'CEP inválido — use 8 dígitos.', campo: 'cep' });
  }
  const telefone = telefoneE164(contato_telefone);
  if (!telefone)
    return res.status(400).json({ erro: 'Telefone inválido — informe DDD e número.', campo: 'contato_telefone' });

  const senhaFraca = conferirSenha(senha);
  if (senhaFraca) return res.status(400).json({ erro: senhaFraca });

  // Sem isso, categoria_id inválido/legado só quebrava na FK — 500 genérico
  // em vez de um 400 dizendo o quê. Único cadastro que não passava por
  // buscarAtivaPorId (POST /conta/modos/anunciante e POST /anunciantes/me/pontos
  // já validavam) — achado no mapeamento de 22/09/2026.
  if (req.body.categoria_id && !(await categoriasRepo.buscarAtivaPorId(req.body.categoria_id))) {
    return res.status(400).json({ erro: 'ramo inválido', campo: 'categoria_id' });
  }

  const existente = await repo.buscarPorEmailComSenha(contato_email);
  if (existente) return res.status(409).json({ erro: 'e-mail já cadastrado' });

  const dadosConta = {
    nome_empresa,
    cpf_cnpj,
    ...endereco,
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
      // Convite que nasceu de uma candidatura de ponto já traz o endereço: o
      // ponto é criado agora, ligado à conta nova, com a primeira tela.
      if (papeis.includes('ponto') && convite.candidatura_id) {
        const cand = await candidaturasRepo.buscarPorId(convite.candidatura_id);
        if (cand && cand.tipo === 'ponto') {
          await materializarPontoDaCandidatura(cand, anunciante, cliente);
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
  // Fire-and-forget: e-mail que falha não pode desfazer um cadastro (pedido
  // do dono, 18/09/2026). Só pra quem anuncia — o texto fala em "escolher
  // plano" e "colocar seu anúncio", que não faz sentido pra quem entrou só
  // como vendedor ou dono de ponto (convite sem o papel 'anunciante').
  if (ehAnunciante) enviarContaCriada(anunciante).catch((err) => console.error('e-mail de conta criada', err));
  // Código de confirmação vai pra toda conta nova, qualquer papel — o e-mail
  // é sempre o login, não só de quem anuncia.
  enviarNovoCodigoConfirmacao(anunciante).catch((err) => console.error('código de confirmação de e-mail', err));

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
  // Suspensa perde o acesso (reconstrução de Contas, 23/09/2026, Parte 27) —
  // antes o login ignorava `suspenso` e a conta seguia entrando, subindo
  // criativo e mexendo no cadastro; só a compra era barrada. Sessão já aberta
  // cai pelo middleware de server.js. Só a senha certa chega aqui, então a
  // mensagem não revela nada a quem está chutando.
  if (anunciante.suspenso) {
    return res.status(403).json({ erro: 'esta conta está suspensa — fale com a gente pra reativar o acesso' });
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
  // Link gerado e não pago também morre: senão continuava pagável depois da
  // exclusão (GET /plano ainda servia a linha). Só local — na Asaas não
  // existe nada antes do primeiro pagamento.
  if (conta) await assinaturasRepo.cancelarPendentesDePagamento(conta.id);

  // A foto de perfil sai do bucket público na hora (era pública pela URL
  // antiga mesmo depois da exclusão). O resto dos dados pessoais sai na
  // anonimização automática depois de 60 dias (src/titular/repository.js).
  await repo.atualizar(req.session.anuncianteId, { excluido_em: new Date(), foto_url: null });
  await removerAvatar(req.session.anuncianteId);
  if (conta) {
    eventos.registrar(
      'conta:exclusao_pede',
      {
        dias_de_vida: eventos.diasEntre(conta.created_at),
        tinha_plano_ativo: !!conta.plano_id && !conta.suspenso && vigencia.coberturaVigente(conta.data_expiracao),
      },
      conta,
    );
    // Fire-and-forget: e-mail que falha não pode desfazer a exclusão (pedido
    // do dono, 18/09/2026).
    enviarContaExcluida(conta).catch((err) => console.error('e-mail de conta excluída', err));
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

// Conta suspensa perde o acesso também com a sessão já aberta (reconstrução
// de Contas, 23/09/2026, Parte 27). O login barra a entrada nova; isto barra
// quem já estava dentro quando o admin suspendeu: a sessão deixa de valer e
// toda rota que exige conta logada responde 401, que o front já trata
// mandando pro login — onde a mensagem de "suspensa" aparece. Uma leitura por
// chave primária por request autenticada; o ponto físico do dono suspenso
// continua tocando (a TV autentica pelo aparelho, não por esta sessão).
// Montado em server.js antes de todas as rotas.
async function derrubarSessaoSuspensa(req, _res, next) {
  if (!req.session?.anuncianteId) return next();
  const { rows } = await pool.query('SELECT suspenso FROM anunciantes WHERE id = $1', [req.session.anuncianteId]);
  if (rows[0]?.suspenso) delete req.session.anuncianteId;
  next();
}

// Painel do anunciante (módulo 7) — dados de conta; dashboard de exibições
// agregadas fica pro módulo 7 consumir via GET /anunciantes/:id/exibicoes
// quando o front pedir (leitura simples de exibicoes_contador, sem lógica nova).
router.get('/anunciantes/me', exigirAnuncianteLogado, async (req, res) => {
  const anunciante = await repo.buscarPorId(req.session.anuncianteId);
  if (!anunciante) return res.status(401).json({ erro: 'não autenticado' });
  // `plano` junto de propósito: o painel precisa dele pra dizer a duração
  // máxima da peça e quantos pontos a conta pode escolher, e sem isso teria
  // que adivinhar ou buscar na vitrine — que só lista plano ATIVO, e a conta
  // pode estar numa versão aposentada.
  const plano = planoEfetivoId(anunciante) ? await planosRepo.buscarPorId(planoEfetivoId(anunciante)) : null;
  // Origem do direito em vigor (ADR-018): o painel mostra "Prime · Semestral
  // · Benefício por créditos" com a MESMA régua da ficha do admin.
  const {
    rows: [beneficioAtivo],
  } = anunciante.plano_cortesia
    ? await pool.query(
        `SELECT plano_id, origem FROM planos_administrativos WHERE anunciante_id = $1 AND status = 'ativo' ORDER BY id DESC LIMIT 1`,
        [anunciante.id],
      )
    : { rows: [] };
  const origem = planoAdministrativo.origemDoDireito(anunciante, beneficioAtivo);
  res.json({
    ...anunciante,
    plano,
    plano_origem: origem,
    plano_origem_texto: origem ? planoAdministrativo.ORIGENS_DO_DIREITO[origem] : null,
    // Vigência decidida AQUI (RN-32-B, último dia inclusivo em Matão), não
    // pelo relógio do navegador: o painel só rotula o que o servidor decidiu.
    plano_vigente: !!repo.planoVigenteId(anunciante),
    dias_ate_vencer: vigencia.diasAteVencer(anunciante.data_expiracao),
  });
});

// Confirmação de e-mail por código (migration 061). `limiteTentativas` conta
// tentativa errada pra não virar força-bruta num código de 6 dígitos.
router.post('/anunciantes/me/confirmar-email', exigirAnuncianteLogado, limiteTentativas, async (req, res) => {
  const codigo = String(req.body.codigo || '').trim();
  if (!codigo) return res.status(400).json({ erro: 'código obrigatório' });
  const { rows } = await pool.query(
    'SELECT id FROM tokens_confirmacao_email WHERE anunciante_id = $1 AND codigo = $2 AND expira_em > now()',
    [req.session.anuncianteId, codigo],
  );
  if (!rows[0]) return res.status(400).json({ erro: 'código inválido ou expirado — peça um novo' });
  zerarTentativas(req);
  await pool.query('DELETE FROM tokens_confirmacao_email WHERE anunciante_id = $1', [req.session.anuncianteId]);
  await repo.atualizar(req.session.anuncianteId, { email_confirmado: true });
  res.json({ ok: true });
});

router.post('/anunciantes/me/reenviar-codigo-email', exigirAnuncianteLogado, limiteTentativas, async (req, res) => {
  const anunciante = await repo.buscarPorId(req.session.anuncianteId);
  if (!anunciante) return res.status(401).json({ erro: 'não autenticado' });
  if (!anunciante.email_confirmado) {
    enviarNovoCodigoConfirmacao(anunciante).catch((err) => console.error('reenvio de código de confirmação', err));
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Escolha de pontos pelo contratante (17/09/2026)
// ---------------------------------------------------------------------------
// O plano dá acesso a N pontos e quem escolhe quais é o anunciante. Quem não
// escolhe não fica de fora: `pontosDoAnunciante` sorteia uma fatia estável
// (src/lib/pacing.js). Deixar tudo desmarcado é uma escolha válida, e é a
// recomendada pra quem não conhece a cidade.
//
// A ocupação de cada ponto vem junto porque o dono pediu que ponto cheio não
// pudesse ser escolhido: sem ver o quanto já está vendido, a pessoa escolhe o
// ponto lotado e recebe menos exibição do que receberia num vazio.
//
// G.7 (18/09/2026): ponto que cruzou 80% pára de entrar na conta automática
// E de aceitar escolha nova — mas quem já tinha continua tendo (ver
// `pontosDoAnunciante`, src/lib/pacing.js). `avaliarBloqueios` roda aqui
// porque é exatamente o momento em que uma escolha nova está sendo
// decidida — não precisa de cron separado pra isso.
router.get('/anunciantes/me/pontos-disponiveis', exigirAnuncianteLogado, async (req, res) => {
  const conta = await repo.buscarPorId(req.session.anuncianteId);
  const plano = planoEfetivoId(conta) ? await planosRepo.buscarPorId(planoEfetivoId(conta)) : null;
  if (!plano) return res.status(400).json({ erro: 'sua conta ainda não tem plano' });

  await pontosRepo.avaliarBloqueios();

  // Ponto `a_instalar` entra na lista (RN-49, decisão do dono em 17/09/2026):
  // ele já conta como vaga do plano, pra quem paga por cobertura maior não
  // perder o lugar num comércio que está sendo montado. Ele não veicula, e é
  // por isso que a compensação abaixo o trata como ponto FALTANDO.
  // `em_reparo` entra pela mesma regra (rodada final da Rede, 22/09/2026):
  // status automático desde a migration 069, mesma situação de "não veicula
  // agora mas o lugar é real e pode voltar" que `a_instalar` já cobria — o
  // `noAr` abaixo já trata os dois como "fora do ar" hoje, só `inativo`
  // (tela cadastrada, nenhuma funcionando) fica fora da lista.
  const { rows } = await pool.query(
    `SELECT p.id, p.nome, p.cidade, p.endereco, p.status, p.horario_semanal, (p.escolha_bloqueada_em IS NOT NULL) AS bloqueado,
            COALESCE(SUM(pl.segundos_por_hora), 0)::int AS segundos_vendidos,
            (ap.ponto_id IS NOT NULL) AS escolhido
       FROM pontos p
       LEFT JOIN anunciantes_pontos outros ON outros.ponto_id = p.id
       LEFT JOIN anunciantes ao ON ao.id = outros.anunciante_id AND NOT ao.suspenso AND ao.excluido_em IS NULL
       LEFT JOIN planos pl ON pl.id = ao.plano_id
       LEFT JOIN anunciantes_pontos ap ON ap.ponto_id = p.id AND ap.anunciante_id = $1
      WHERE p.status = ANY($2::text[])
      GROUP BY p.id, p.nome, p.cidade, p.endereco, p.status, p.horario_semanal, p.escolha_bloqueada_em, ap.ponto_id
      ORDER BY p.status DESC, p.nome`,
    [conta.id, pontosRepo.STATUS_NA_REDE],
  );

  // A conta do bônus é a MESMA do gerador da playlist, com as mesmas funções:
  // quantos pontos EM OPERAÇÃO entram na fatia dele hoje, e quantos segundos
  // por hora isso vira depois da RN-49. Refazer a conta aqui à mão daria um
  // número no painel diferente do que a tela executa.
  const noAr = rows.filter((r) => r.status === 'em_operacao').map((r) => r.id);
  const bloqueados = rows.filter((r) => r.bloqueado).map((r) => r.id);
  const cobertos = pontosDoAnunciante(
    {
      id: conta.id,
      pontosIncluidos: plano.pontos_incluidos,
      escolhidos: rows.filter((r) => r.escolhido).map((r) => r.id),
    },
    noAr,
    bloqueados,
  );
  const base = Number(plano.segundos_por_hora) || 0;
  const efetivos = segundosCompensados(base, plano.pontos_incluidos, cobertos.length);

  res.json({
    limite: plano.pontos_incluidos,
    escolhidos: rows.filter((r) => r.escolhido).map((r) => r.id),
    // O que o plano compra, o que a rede entrega hoje, e a diferença — que é
    // o número que o dono pediu pra ficar escrito ("a hora que ele vai ganhar
    // a mais"), em vez de um bônus que ninguém consegue conferir.
    //
    // Tudo em HORAS POR MÊS, e só: é a unidade que o cliente comprou e a que
    // o card vende. Segundos por hora é a unidade do motor, e mandar as duas
    // deixava a tela escolher — que é como o painel nasceu falando em segundos
    // enquanto a vitrine falava em horas.
    cobertura: {
      contratados: plano.pontos_incluidos,
      veiculando: cobertos.length,
      horas_contratadas: horasDeTelaPorMes(base, plano.pontos_incluidos),
      horas_sem_compensacao: horasDeTelaPorMes(base, cobertos.length),
      horas_hoje: horasDeTelaPorMes(efetivos, cobertos.length),
      compensando: efetivos > base,
    },
    pontos: rows.map((r) => ({
      id: r.id,
      nome: r.nome,
      cidade: r.cidade,
      endereco: r.endereco,
      escolhido: r.escolhido,
      status: r.status,
      // Pedido do dono, 22/09/2026: quem escolhe o ponto vê o horário de
      // funcionamento dele. Texto pronto (não o objeto por dia) — o
      // front-end só exibe, não precisa saber o formato de
      // src/lib/horario-semanal.js.
      horario: resumoHorarioSemanal(r.horario_semanal),
      // Quanto da hora daquele ponto já está vendido. 100% = cheio.
      // Ponto que ainda não veicula não tem hora vendida — 0 não é "vazio de
      // verdade", é "ainda não existe", e a tela diz isso com o status.
      ocupacao: Math.min(100, Math.round((r.segundos_vendidos / 3600) * 100)),
      // Cruzou 80% (G.7) — fechado pra escolha nova, mas continua exibindo
      // pra quem já tinha escolhido (esse nunca é tirado por isso).
      bloqueado: r.bloqueado && !r.escolhido,
    })),
  });
});

router.put('/anunciantes/me/pontos', exigirAnuncianteLogado, async (req, res) => {
  const conta = await repo.buscarPorId(req.session.anuncianteId);
  const plano = planoEfetivoId(conta) ? await planosRepo.buscarPorId(planoEfetivoId(conta)) : null;
  if (!plano) return res.status(400).json({ erro: 'sua conta ainda não tem plano' });

  const pedidos = [...new Set((req.body.pontos || []).map(Number).filter(Number.isInteger))];
  if (plano.pontos_incluidos && pedidos.length > plano.pontos_incluidos) {
    return res.status(400).json({
      erro: `seu plano cobre ${plano.pontos_incluidos} ponto(s) e você marcou ${pedidos.length}`,
    });
  }

  // `a_instalar`/`em_reparo` são escolha válida desde a RN-49 (a_instalar) e
  // a rodada final da Rede (em_reparo entra pela mesma regra, 22/09/2026): a
  // vaga fica reservada pro ponto que não está veiculando agora, e enquanto
  // não veicula o tempo dele volta pros pontos no ar. O que continua
  // recusado é ponto que não existe (ou `inativo`).
  if (pedidos.length) {
    const { rows } = await pool.query(`SELECT id FROM pontos WHERE id = ANY($1::int[]) AND status = ANY($2::text[])`, [
      pedidos,
      pontosRepo.STATUS_NA_REDE,
    ]);
    if (rows.length !== pedidos.length) {
      return res.status(400).json({ erro: 'um dos pontos escolhidos não existe na rede' });
    }

    // G.7 (18/09/2026): ponto cruzou 80% pára de aceitar escolha NOVA — mas
    // continuar com um que já era seu não é escolha nova, então reenviar a
    // lista com ele dentro não é recusado (senão o bloqueio empurraria o
    // próprio anunciante que já estava lá pra fora, o que ninguém pediu).
    await pontosRepo.avaliarBloqueios();
    const { rows: jaTinha } = await pool.query('SELECT ponto_id FROM anunciantes_pontos WHERE anunciante_id = $1', [
      conta.id,
    ]);
    const idsJaTinha = new Set(jaTinha.map((r) => r.ponto_id));
    const novos = pedidos.filter((id) => !idsJaTinha.has(id));
    if (novos.length) {
      const bloqueados = await pontosRepo.idsBloqueadosParaEscolha();
      const bloqueadosNovos = novos.filter((id) => bloqueados.includes(id));
      if (bloqueadosNovos.length) {
        return res.status(409).json({
          erro: 'um dos pontos escolhidos está com a hora quase toda vendida e parou de aceitar escolha nova',
          pontosBloqueados: bloqueadosNovos,
        });
      }
    }
  }

  // Troca a lista inteira numa transação: metade salva seria pior que nada,
  // porque o anunciante ficaria numa cobertura que ele não escolheu.
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [conta.id]);
    for (const pontoId of pedidos) {
      await cliente.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1,$2)', [
        conta.id,
        pontoId,
      ]);
    }
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }

  eventos.registrar('pontos:escolhidos', { quantidade: pedidos.length, limite: plano.pontos_incluidos }, conta);
  res.json({ escolhidos: pedidos, limite: plano.pontos_incluidos });
});

// Edição de perfil self-service — lista branca própria (não os campos
// admin-only de repo.CAMPOS_ATUALIZAVEIS, ex.: cpf_cnpj/status/plano_id só
// mudam via admin, ver SPEC.md). Documento e e-mail de acesso também ficam
// de fora: mudança só via contato com o admin.
const CAMPOS_AUTOEDITAVEIS = [
  'nome_empresa',
  'endereco',
  // Partes do endereço (D5, 24/09/2026 — migration 086).
  'logradouro',
  'numero',
  'complemento',
  'bairro',
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
  // Endereço editado no perfil vem inteiro, em partes (D5): começou a
  // preencher, preenche tudo (complemento é o único opcional) e o CEP tem que
  // ser um CEP. Quem anuncia não pode ficar sem endereço (vai na nota); conta
  // só de ponto pode salvar o perfil com o endereço em branco.
  const partes = PARTES_DO_ENDERECO.filter((p) => dados[p] !== undefined);
  if (partes.length) {
    const algumPreenchido = partes.some((p) => String(dados[p] ?? '').trim());
    const conta = await repo.buscarPorId(req.session.anuncianteId);
    if (algumPreenchido || (conta?.papeis || []).includes('anunciante')) {
      const falta = parteQueFalta(colunasDoEndereco(dados));
      if (falta) return res.status(400).json({ erro: `endereço incompleto — preencha o campo ${falta}` });
      if (!cepValido(dados.cep)) return res.status(400).json({ erro: 'CEP inválido — use 8 dígitos.', campo: 'cep' });
    } else {
      for (const p of partes) delete dados[p];
    }
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
// `substitui` (reconstrução de Contas, 23/09/2026, Parte 22): criativo A que
// este upload vai substituir. O novo (B) nasce EM ANÁLISE mesmo vindo do
// operador, apontando pra A — A segue no ar até B ser aprovado (ver PATCH
// /admin/criativos/:id em src/admin/routes.js). Não passa pelo limite: B só
// entra tirando A, então o total cadastrado depois da troca é o mesmo.
async function subirCriativo(
  req,
  res,
  { contaId, limite, duracaoMaxima = null, peloOperador = false, substitui = null },
) {
  if (!req.file) return res.status(400).json({ erro: 'arquivo obrigatório' });
  // Tudo dentro do try: o multer já gravou o arquivo em disco antes de
  // chegar aqui, e os `return` de erro que ficavam fora do finally deixavam
  // até 95 MB de lixo em /tmp por request recusada.
  try {
    if (Number.isFinite(limite) && !substitui) {
      const emUso = await criativosRepo.contarNaoReprovados(contaId);
      if (emUso >= limite) {
        return res
          .status(400)
          .json({ erro: `seu plano permite até ${limite} criativo(s) ativo(s) — exclua um pra subir outro` });
      }
    }

    // Duração: nada nunca conferiu, e um vídeo de três minutos entrava inteiro
    // e tomava, sozinho, o lugar de seis anúncios no rodízio.
    //
    // Dois tetos. O GLOBAL de 60s é a trava física da tela. O DO PLANO
    // (`duracao_maxima_segundos`, desde 17/09/2026) é benefício vendido: o
    // Essencial compra peça de até 15s, o Máximo até 30s. Ele vem de quem
    // chama, porque a mesma função serve o upload do cliente e o do operador.
    //
    // Imagem não entra nessa checagem de duração (não tem duração real pra
    // violar teto nenhum) — mas usa o MESMO teto do plano na hora de virar
    // vídeo (19/09/2026, pedido do dono: antes ficava sempre em 10s fixos,
    // mesmo quem pagava plano de 30s recebia menos do que comprou; ver
    // ffmpeg.normalizar). Sem plano (conta própria/admin), cai no padrão.
    const midia = await ffmpeg.probeMidia(req.file.path).catch(() => null);
    if (!midia) {
      return res
        .status(400)
        .json({ erro: 'não foi possível ler esse arquivo — confira se é um vídeo ou imagem válido' });
    }
    if (!midia.ehImagem && (midia.duracao_segundos > 60 || midia.duracao_segundos < 3)) {
      return res.status(400).json({
        erro: `esse vídeo tem ${midia.duracao_segundos}s — a tela aceita de 3 a 60 segundos`,
      });
    }
    if (!midia.ehImagem && duracaoMaxima && midia.duracao_segundos > duracaoMaxima) {
      return res.status(400).json({
        erro: `esse vídeo tem ${midia.duracao_segundos}s e o seu plano aceita peça de até ${duracaoMaxima}s — corte a peça ou mude de plano`,
      });
    }

    const criativoTemp = await criativosRepo.criar({
      anunciante_id: contaId,
      arquivo_original_url: req.file.originalname,
      arquivo_normalizado_url: null,
      thumbnail_url: null,
      duracao_segundos: null,
      substitui_criativo_id: substitui ? substitui.id : null,
    });

    try {
      const normalizado = await ffmpeg.normalizar(req.file.path, criativoTemp.id, duracaoMaxima);
      // Peça que o operador subiu já entra aprovada: quem aprovaria é quem
      // acabou de subir. Fazer o dono aprovar o próprio upload seria um clique
      // sem decisão nenhuma por trás. Substituto é a exceção: a troca só
      // acontece na aprovação, então ele espera em análise.
      const criativo = await criativosRepo.atualizar(criativoTemp.id, {
        ...normalizado,
        ...(peloOperador ? { editado_pelo_operador: true } : {}),
        ...(peloOperador && !substitui ? { status: 'aprovado' } : {}),
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
  const anunciante = await repo.buscarPorId(req.session.anuncianteId);
  // Antes liberava 1 criativo sem plano, "pra não travar quem está no meio
  // do cadastro" — decisão revertida pelo dono, 19/09/2026: o painel agora
  // trava a tela inteira sem plano (ver front), então subir criativo sem
  // plano nem deveria ser alcançável por ali; isso é a segunda trava, direto
  // no servidor, pra quem tentar pela API sem passar pela tela. Ser ponto
  // não libera plano (ADR-016, 24/09/2026).
  const planoId = planoEfetivoId(anunciante);
  if (!planoId) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ erro: 'sua conta ainda não tem plano' });
  }
  const plano = await planosRepo.buscarPorId(planoId);
  // Substituir sem tirar do ar (Fatia 3): o cliente troca a peça aprovada
  // pela nova, e a atual continua rodando até a nova ser aprovada — antes o
  // único jeito era excluir primeiro e ficar sem nada no ar durante a
  // análise. Mesma regra do caminho do operador (/admin/criativos/:id/substituto).
  let substitui = null;
  if (req.body.substitui) {
    const atual = await criativosRepo.buscarPorId(req.body.substitui);
    const recusa = (status, erro) => {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(status).json({ erro });
    };
    if (!atual || atual.anunciante_id !== anunciante.id) return recusa(404, 'criativo não encontrado');
    if (atual.status !== 'aprovado') return recusa(400, 'só dá pra substituir uma peça aprovada');
    const { rows } = await pool.query(
      `SELECT id FROM criativos WHERE substitui_criativo_id = $1 AND status = 'pendente' LIMIT 1`,
      [atual.id],
    );
    if (rows.length) return recusa(409, 'essa peça já tem uma substituta em análise');
    substitui = atual;
  }
  const enviou = await subirCriativo(req, res, {
    contaId: req.session.anuncianteId,
    limite: plano.limite_criativos,
    duracaoMaxima: plano.duracao_maxima_segundos,
    substitui,
  });
  if (res.statusCode === 201) {
    sse.emitirParaConta(anunciante.id, 'creative.updated', {});
    // Fila de Aprovação do admin cresce sem F5.
    sse.emitirParaAdmin('creative.updated', {});
  }
  return enviou;
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
//
// Teto de CADASTRO desde a reconstrução de Contas (23/09/2026, Parte 21): até
// 3 criativos por conta (CRIATIVOS_POR_CONTA), independente do plano. Quantos
// RODAM ao mesmo tempo continua sendo o `limite_criativos` do plano, decidido
// na playlist (limiteDeCriativos em src/playlist/gerador.js) — "até 3
// cadastrados" e "N no ar" são coisas diferentes, e a ficha mostra as duas.
// Conta suspensa não recebe criativo novo (Parte 27).
router.post('/admin/anunciantes/:id/criativos', upload.single('arquivo'), async (req, res) => {
  const conta = await repo.buscarPorId(req.params.id);
  if (!conta || conta.suspenso) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return conta
      ? res.status(409).json({ erro: 'conta suspensa — reative antes de mexer nos criativos' })
      : res.status(404).json({ erro: 'conta não encontrada' });
  }
  const plano = planoEfetivoId(conta) ? await planosRepo.buscarPorId(planoEfetivoId(conta)) : null;
  return subirCriativo(req, res, {
    contaId: conta.id,
    // A conta própria não tem teto de duração: o inventário é da casa.
    limite: conta.conta_propria ? Infinity : CRIATIVOS_POR_CONTA,
    duracaoMaxima: conta.conta_propria ? null : plano ? plano.duracao_maxima_segundos : null,
    peloOperador: true,
  });
});

// Substituir criativo sem tirar o atual do ar (Parte 22): sobe B apontando
// pra A. Só faz sentido pra quem está aprovado/no ar — em análise ou
// recusado se troca o arquivo na mesma linha (POST /admin/criativos/:id/substituir).
router.post('/admin/criativos/:id/substituto', upload.single('arquivo'), async (req, res) => {
  const descartar = () => req.file && fs.unlink(req.file.path, () => {});
  const atual = await criativosRepo.buscarPorId(req.params.id);
  if (!atual) {
    descartar();
    return res.status(404).json({ erro: 'criativo não encontrado' });
  }
  if (atual.status !== 'aprovado') {
    descartar();
    return res.status(400).json({ erro: 'só dá pra substituir criativo aprovado — nos outros, troque o arquivo' });
  }
  const conta = await repo.buscarPorId(atual.anunciante_id);
  if (!conta || conta.suspenso) {
    descartar();
    return res.status(409).json({ erro: 'conta suspensa — reative antes de mexer nos criativos' });
  }
  const { rows } = await pool.query(
    `SELECT id FROM criativos WHERE substitui_criativo_id = $1 AND status = 'pendente' LIMIT 1`,
    [atual.id],
  );
  if (rows.length) {
    descartar();
    return res
      .status(409)
      .json({ erro: 'esse criativo já tem um substituto em análise — aprove ou recuse aquele antes' });
  }
  const plano = planoEfetivoId(conta) ? await planosRepo.buscarPorId(planoEfetivoId(conta)) : null;
  return subirCriativo(req, res, {
    contaId: conta.id,
    limite: Infinity,
    duracaoMaxima: conta.conta_propria ? null : plano ? plano.duracao_maxima_segundos : null,
    peloOperador: true,
    substitui: atual,
  });
});

// O que a playlist faria com os criativos de uma conta agora: `no_ar` segue
// exatamente a regra do gerador (conta elegível + aprovado com arquivo pronto
// + os N mais recentes, N = limite do plano). Uma função só pra ficha do
// admin e pro "Meus criativos" do painel — as duas telas nunca podem
// discordar sobre o que está no ar.
//
// O plano é o VIGENTE (`planoVigenteId`, a mesma regra do gerador: plano
// que não venceu), não o efetivo cru — um plano vencido não veicula, e esta
// função não pode dizer "no ar" enquanto a TV não toca a peça.
async function criativosComSituacao(conta) {
  const criativos = await criativosRepo.listarPorAnunciante(conta.id);
  // `plano` (devolvido) continua o EFETIVO — é dele que o painel do cliente
  // lê limite de cadastro e duração máxima, igual ao upload (subirCriativo).
  const efetivoId = planoEfetivoId(conta);
  const plano = efetivoId ? await planosRepo.buscarPorId(efetivoId) : null;
  const vigenteId = repo.planoVigenteId(conta);
  const vigente = vigenteId === efetivoId ? plano : vigenteId ? await planosRepo.buscarPorId(vigenteId) : null;
  const contaVeicula = !!vigente && !conta.suspenso && !conta.excluido_em && !conta.conta_propria;
  const prontos = criativos.filter((c) => c.status === 'aprovado' && c.arquivo_normalizado_url);
  const limite = vigente ? limiteDeCriativos(false, vigente.limite_criativos, prontos.length) : 0;
  const noAr = new Set(contaVeicula ? prontos.slice(0, limite).map((c) => c.id) : []);
  return { criativos: criativos.map((c) => ({ ...c, no_ar: noAr.has(c.id) })), plano, limite, contaVeicula };
}

// Criativos de UMA conta pra ficha do admin (Parte 18-24). Mesmo motor da
// fila global — isto só lê.
router.get('/admin/anunciantes/:id/criativos', async (req, res) => {
  const conta = await repo.buscarPorId(req.params.id);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  const { criativos, limite, contaVeicula } = await criativosComSituacao(conta);
  res.json({
    criativos,
    limite_no_ar: limite,
    limite_cadastro: CRIATIVOS_POR_CONTA,
    conta_veicula: contaVeicula,
  });
});

// "Meus criativos" do painel único (Fatia 3, 23/09/2026) — o anúncio na rede
// e o da tela do próprio comércio são a MESMA tabela e a mesma cota da
// conta; antes eram duas telas, uma em cada página. Cada peça
// vem com a situação que o cliente entende:
//   em_analise · aprovado (pronto, fora do rodízio agora) · no_ar ·
//   fora_do_ar (retirado) · recusado
// e o vínculo de substituição nos dois sentidos (a peça atual sabe que tem
// substituta em análise; a substituta sabe quem ela troca).
const SITUACAO_CRIATIVO = { pendente: 'em_analise', reprovado: 'recusado', retirado: 'fora_do_ar' };
router.get('/anunciantes/me/criativos', exigirAnuncianteLogado, async (req, res) => {
  const conta = await repo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  const { criativos, plano, limite, contaVeicula } = await criativosComSituacao(conta);
  const substitutaDe = new Map(
    criativos
      .filter((c) => c.status === 'pendente' && c.substitui_criativo_id)
      .map((c) => [c.substitui_criativo_id, c.id]),
  );
  const emUso = await criativosRepo.contarNaoReprovados(conta.id);
  const { rows: pontos } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pontos WHERE anunciante_id = $1 AND status = 'em_operacao'`,
    [conta.id],
  );
  res.json({
    criativos: criativos.map((c) => ({
      id: c.id,
      situacao: c.status === 'aprovado' ? (c.no_ar ? 'no_ar' : 'aprovado') : SITUACAO_CRIATIVO[c.status],
      arquivoUrl: c.arquivo_normalizado_url,
      thumbnailUrl: c.thumbnail_url,
      duracaoSegundos: c.duracao_segundos,
      motivoRecusa: c.status === 'reprovado' ? c.motivo_reprovacao : null,
      feitoPelaMostrai: !!c.editado_pelo_operador,
      substitui: c.substitui_criativo_id,
      substitutaEmAnalise: substitutaDe.get(c.id) || null,
      enviadoEm: c.created_at,
    })),
    temPlano: !!plano,
    // Plano (anúncio na rede) e/ou ponto no ar (a tela do próprio
    // comércio) — o painel explica onde a peça aprovada roda.
    rodaNaRede: !!conta.plano_id,
    rodaNoProprioPonto: pontos[0].n > 0,
    contaVeicula,
    limiteNoAr: limite,
    limiteCadastro: plano ? plano.limite_criativos : 0,
    emUso,
    duracaoMaxima: plano?.duracao_maxima_segundos || null,
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
  sse.emitirParaConta(req.session.anuncianteId, 'creative.updated', { id: criativo.id });
  sse.emitirParaAdmin('creative.updated', {});
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
    // `janela_hora` é timestamptz e a sessão do Postgres roda em UTC, então
    // `date_trunc('day', ...)` cru corta o dia em UTC, não em Matão: tudo o
    // que rodou ANTES das 21h caía no dia anterior. Num comprovante de
    // veiculação — o papel que prova a entrega pra quem pagou — a data é o
    // dado principal. Convertendo pro fuso antes de cortar, e devolvendo
    // `::date` (dia de calendário puro, que o parser do pool entrega como
    // texto), o dia sai certo dos dois lados e sem passar por fuso de novo.
    `SELECT date_trunc('day', e.janela_hora AT TIME ZONE 'America/Sao_Paulo')::date AS dia, p.nome AS ponto, p.cidade,
            'Tela ' || d.numero AS tela, SUM(e.vezes_confirmadas)::int AS exibicoes
     FROM exibicoes_contador e
     JOIN dispositivos d ON d.id = e.dispositivo_id
     JOIN pontos p ON p.id = d.ponto_id
     WHERE e.anunciante_id = $1 AND e.janela_hora > now() - ($2 || ' days')::interval
     GROUP BY dia, p.nome, p.cidade, d.numero
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

// "A propaganda está passando ou a TV está desligada?" pela MESMA régua do
// admin e do dono do ponto (src/lib/status-tela.js) — antes o painel tinha a
// sua (último sinal < 2h) e dizia "Online" para uma tela que o admin já
// mostrava sem sinal. Por ponto: no ar se alguma tela opera; fora do horário
// se nenhuma opera mas alguma está no horário de folga; senão, fora do ar.
// Só a conclusão sai daqui — nenhum dado da tela vai para o anunciante.
async function comSituacaoNoAr(pontos) {
  if (!pontos.length) return pontos;
  const { rows: telas } = await pool.query(
    `SELECT d.ponto_id, d.status, d.revogado_em, (d.chave_hash IS NOT NULL) AS chave_hash, d.primeiro_sinal_em,
            d.ultima_vez_online, d.player_estado, d.modo_horario, d.horario_semanal, d.timezone,
            d.ultimo_erro_codigo, d.ultimo_erro, p.horario_semanal AS ponto_horario_semanal
       FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
      WHERE d.ponto_id = ANY($1::int[])`,
    [pontos.map((p) => p.id)],
  );
  const agora = new Date();
  return pontos.map((p) => {
    const saudes = telas.filter((t) => t.ponto_id === p.id).map((t) => saudeDaTela(t, t.ponto_horario_semanal, agora));
    const situacao = saudes.includes('operando')
      ? 'no_ar'
      : saudes.includes('fora_do_horario')
        ? 'fora_do_horario'
        : 'fora_do_ar';
    return { ...p, situacao };
  });
}

router.get('/anunciantes/:id/exibicoes', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode ver exibições da própria conta' });
  }
  const anuncianteId = req.params.id;

  const [totais, porPonto, porDia, porDiaPonto, cobrancas, anunciante, confirmadasMesRows, janelaMesRows] =
    await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(vezes_programadas),0) AS programadas, COALESCE(SUM(vezes_confirmadas),0) AS confirmadas
       FROM exibicoes_contador WHERE anunciante_id = $1`,
        [anuncianteId],
      ),
      pool.query(
        // `MAX(d.ultima_vez_online)` — quando o ponto tem mais de uma tela, o
        // status mostrado é o da tela mais recentemente vista (19/09/2026,
        // pedido do dono: "a TV tá desligada ou tá passando mesmo?").
        `SELECT p.id, p.nome, p.cidade,
              SUM(e.vezes_programadas) AS programadas, SUM(e.vezes_confirmadas) AS confirmadas,
              MAX(d.ultima_vez_online) AS ultima_vez_online
       FROM exibicoes_contador e
       JOIN dispositivos d ON d.id = e.dispositivo_id
       JOIN pontos p ON p.id = d.ponto_id
       WHERE e.anunciante_id = $1
       GROUP BY p.id, p.nome, p.cidade
       ORDER BY confirmadas DESC`,
        [anuncianteId],
      ),
      pool.query(
        // Mesmo corte de dia do comprovante em CSV (ver acima): no fuso de
        // Matão, não no do servidor.
        `SELECT date_trunc('day', janela_hora AT TIME ZONE 'America/Sao_Paulo')::date AS dia, SUM(vezes_confirmadas) AS confirmadas
       FROM exibicoes_contador WHERE anunciante_id = $1
       GROUP BY dia ORDER BY dia DESC LIMIT 30`,
        [anuncianteId],
      ),
      // Mesma coisa, mas por ponto dentro de cada dia (19/09/2026, pedido do
      // dono: "no card exibições por dia, coloque também um exibições por
      // ponto") — o front empilha por cor de ponto em vez de mostrar só o
      // total do dia. Mesmo corte de 30 dias do gráfico por dia; sem LIMIT
      // aqui porque é dia × ponto, não só dia.
      pool.query(
        `SELECT date_trunc('day', e.janela_hora AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
              p.id AS ponto_id, p.nome AS ponto_nome, SUM(e.vezes_confirmadas) AS confirmadas
       FROM exibicoes_contador e
       JOIN dispositivos d ON d.id = e.dispositivo_id
       JOIN pontos p ON p.id = d.ponto_id
       WHERE e.anunciante_id = $1
       GROUP BY dia, p.id, p.nome
       ORDER BY dia DESC`,
        [anuncianteId],
      ),
      // Nota fiscal saiu daqui (19/09/2026, pedido do dono): hoje nenhuma é
      // emitida, e quando passar a emitir vai direto por e-mail, não por um
      // link nesta tabela — os campos continuam existindo na tabela
      // `cobrancas_confirmadas` pro admin, só não vêm mais nesta resposta.
      pool.query(
        `SELECT id, valor, criado_em FROM cobrancas_confirmadas WHERE anunciante_id = $1 ORDER BY criado_em DESC`,
        [anuncianteId],
      ),
      repo.buscarPorId(anuncianteId),
      // Mesmo mês/fuso do banco de horas (mes_referencia) e do corte de dia
      // acima: quanto já confirmou no mês corrente, em Matão.
      pool.query(
        `SELECT COALESCE(SUM(vezes_confirmadas),0) AS confirmadas
       FROM exibicoes_contador
       WHERE anunciante_id = $1
         AND date_trunc('month', janela_hora AT TIME ZONE 'America/Sao_Paulo')
           = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`,
        [anuncianteId],
      ),
      // Primeiro dia com PROGRAMAÇÃO (não confirmação) no mês corrente, em
      // Matão — é o início real da campanha dentro do mês, mesmo em dias sem
      // nenhuma confirmação. Existe uma linha em exibicoes_contador sempre que
      // a conta foi programada numa hora, então MIN() aqui não depende de ter
      // rodado de verdade (21/09/2026, correção da média diária: dividir por
      // "dia do mês" penalizava campanha que começou no meio do mês —
      // 14 exibições em 2 dias virava "0,7 por dia" em vez de "7 por dia").
      pool.query(
        `SELECT
         MIN(date_trunc('day', janela_hora AT TIME ZONE 'America/Sao_Paulo'))::date AS primeiro_dia,
         date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje
       FROM exibicoes_contador
       WHERE anunciante_id = $1
         AND date_trunc('month', janela_hora AT TIME ZONE 'America/Sao_Paulo')
           = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`,
        [anuncianteId],
      ),
    ]);

  const confirmadas = Number(totais.rows[0].confirmadas);
  const plano = planoEfetivoId(anunciante) ? await planosRepo.buscarPorId(planoEfetivoId(anunciante)) : null;
  const confirmadasMes = Number(confirmadasMesRows.rows[0].confirmadas);

  // Horas contratadas x entregues no mês (pedido do dono, 19/09/2026, card
  // novo no painel). "Contratadas" é o que o plano promete (mesma conta de
  // `horas_contratadas` em GET /anunciantes/me/pontos-disponiveis — só
  // precisa de segundos_por_hora e pontos_incluidos, não da cobertura do
  // dia). "Entregues" é o confirmado do mês corrente convertido em horas
  // pela duração média dos criativos aprovados — mesma aproximação que o
  // banco de horas já usa pra "segundos" ilustrativos.
  //
  // "Exibições contratadas/restantes/média diária" (19/09/2026, pedido do
  // dono, seguindo a mesma ideia do ChatGPT/Gemini que ele consultou):
  // `duracaoMediaDoAnunciante` NUNCA devolve zero (cai no padrão de 20s sem
  // criativo aprovado ainda — ver bancohoras/repository.js), por isso dá
  // pra calcular "contratadas" desde o primeiro dia, sem esperar a primeira
  // exibição confirmada.
  let horasContratadasMes = null;
  let horasEntreguesMes = null;
  let exibicoesContratadasMes = null;
  let exibicoesRestantesMes = null;
  let mediaDiariaMes = null;
  if (plano) {
    const duracaoMedia = await bancohorasRepo.duracaoMediaDoAnunciante(anuncianteId);
    horasContratadasMes = horasDeTelaPorMes(Number(plano.segundos_por_hora) || 0, plano.pontos_incluidos);
    horasEntreguesMes = Math.round(((confirmadasMes * duracaoMedia) / 3600) * 10) / 10;
    exibicoesContratadasMes = Math.round((horasContratadasMes * 3600) / duracaoMedia);
    exibicoesRestantesMes = Math.max(0, exibicoesContratadasMes - confirmadasMes);
    // Dias DECORRIDOS DESDE O INÍCIO DA CAMPANHA no mês, não "dia do mês"
    // (21/09/2026, correção: o divisor antigo penalizava campanha nova —
    // conta que começou dia 19 e confirmou 14 vezes até dia 21 mostrava
    // "0,7 por dia", dividindo por 21 em vez de pelos 3 dias em que a
    // campanha de fato existiu). `janelaMesRows` só tem linha quando já
    // houve programação neste mês; sem isso, 1 dia evita divisão por zero
    // sem inventar uma média que não existe ainda.
    const { primeiro_dia: primeiroDia, hoje } = janelaMesRows.rows[0] || {};
    const diasDecorridos = primeiroDia ? Math.round((new Date(hoje) - new Date(primeiroDia)) / 86_400_000) + 1 : 1;
    mediaDiariaMes = Math.round((confirmadasMes / diasDecorridos) * 10) / 10;
  }

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
    confirmadasMes,
    criativosAprovados: aprovados[0].n,
    porPonto: await comSituacaoNoAr(porPonto.rows),
    porDia: porDia.rows,
    porDiaPonto: porDiaPonto.rows,
    cobrancas: cobrancas.rows,
    horasContratadasMes,
    horasEntreguesMes,
    exibicoesContratadasMes,
    exibicoesRestantesMes,
    mediaDiariaMes,
    // "Custo por exibição prevista" (24/09/2026, ADR-018): valor contratado
    // no ciclo ÷ exibições previstas no ciclo, lidos do SNAPSHOT do ciclo
    // pago em vigor (financeiro/ciclo-contratado.js). Não depende de
    // exibição realizada, nem do preço atual do admin, nem da duração dos
    // criativos da conta — nasce da contratação e só muda na próxima
    // compra/troca/renovação. Benefício por créditos e cortesia legada vêm
    // com `tipo` próprio e SEM valor (nunca "R$ 0,00").
    custoPrevisto: await cicloContratado.situacaoDoCusto(anunciante),
  });
});

// Admin — protegido por requireAdminToken, montado em server.js
//
// `plano_origem` (revisão da ficha de Conta, 23/09/2026): a lista de Contas
// dizia "Cortesia administrativa" pra QUALQUER cortesia, inclusive benefício
// pago com créditos. Mesma régua da ficha (plano-administrativo.js#
// origemDoDireito), decidida aqui em vez de adivinhada no navegador.
router.get('/admin/anunciantes', async (_req, res) => {
  const [anunciantes, { rows: ativos }] = await Promise.all([
    repo.listar(),
    pool.query(`SELECT anunciante_id, plano_id, origem FROM planos_administrativos WHERE status = 'ativo'`),
  ]);
  const beneficioPorConta = new Map(ativos.map((b) => [b.anunciante_id, b]));
  res.json(
    anunciantes.map((a) => ({
      ...a,
      plano_origem: planoAdministrativo.origemDoDireito(a, beneficioPorConta.get(a.id)),
      // Vigência decidida AQUI (mesma régua do gerador, repo.planoVigenteId),
      // não pelo relógio do navegador.
      plano_vigente: !!repo.planoVigenteId(a),
    })),
  );
});

// Criação manual pelo admin (cadastro "a frio", sem passar pelo formulário
// público) — mesma senha aleatória de 10 chars que o cadastro self-service
// pede na tela, só que aqui ninguém digitou uma: gera e devolve uma vez na
// resposta pro admin repassar por WhatsApp. Não há tela de "trocar senha"
// ainda — fica pro anunciante pedir reset por fora, se precisar.
router.post('/admin/anunciantes', async (req, res) => {
  const { nome_empresa, cpf_cnpj, contato_email, contato_telefone } = req.body;

  // Endereço é exigido de quem vai receber nota — a CONTA PRÓPRIA do Mostraí
  // não recebe nota nenhuma: ela é a própria rede anunciando. Pedir endereço
  // dela só produziria endereço de mentira no cadastro. Em partes desde
  // 24/09/2026 (D5, src/lib/endereco.js).
  const ehPropria = req.body.conta_propria === true;
  if (!nome_empresa || !cpf_cnpj || !contato_email || !contato_telefone) {
    return res.status(400).json({ erro: 'campos obrigatórios faltando' });
  }
  const faltaNoEndereco = !ehPropria && parteQueFalta(colunasDoEndereco(req.body));
  if (faltaNoEndereco) {
    return res.status(400).json({ erro: `endereço incompleto — preencha o campo ${faltaNoEndereco}` });
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
      // Conta interna do Mostraí, não tem inbox de cliente pra confirmar —
      // sem isso ela nasceria com o aviso de e-mail preso pra sempre, e
      // nenhum código nunca chegaria em lugar nenhum.
      email_confirmado: true,
    });
  } else {
    // Cadastro pelo admin (achado na revisão, 19/09/2026): sem isso a conta
    // nascia com email_confirmado=false igual o cadastro aberto, mas nunca
    // recebia o código — o cliente logava pela primeira vez, via o aviso
    // preso, e não tinha como saber que precisava clicar "Reenviar código".
    enviarNovoCodigoConfirmacao(anunciante).catch((err) => console.error('código de confirmação de e-mail', err));
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

// O que o admin edita numa conta (consolidação, 24/09/2026). Antes o corpo
// ia inteiro pra allowlist genérica do repository — que também aceita
// `plano_id`, `plano_cortesia`, `papeis`, `conta_propria`, `excluido_em`,
// `email_confirmado`: um PATCH forjado concedia plano sem passar por
// nenhuma regra (conceder plano está aposentado; plano vem do pagamento ou
// do benefício por créditos). Aqui só o que tem tela: suspensão, parceiro,
// dados cadastrais e a frequência da conta própria.
const CAMPOS_ADMIN_EDITA = [
  'nome_empresa',
  'cpf_cnpj',
  'contato_email',
  'contato_telefone',
  'logradouro',
  'numero',
  'complemento',
  'bairro',
  'cidade',
  'uf',
  'cep',
  'categoria_id',
  'categoria_livre',
  'responsavel_nome',
  'responsavel_cpf',
  'responsavel_email',
  'responsavel_telefone',
  'status',
  'parceiro_desconto_percentual',
  'parceiro_compromisso_minimo',
  'suspenso',
  'frequencia_hora_propria',
];
router.patch('/admin/anunciantes/:id', async (req, res) => {
  try {
    const recusados = Object.keys(req.body || {}).filter((c) => !CAMPOS_ADMIN_EDITA.includes(c));
    if (recusados.length) {
      return res.status(400).json({ erro: `campo não editável por aqui: ${recusados.join(', ')}` });
    }
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
      enviarContaReativada(anunciante).catch((err) => console.error('e-mail de conta reativada', err));
    }
    // Aviso em tempo real nas duas transições (Fase 3, SSE) — a conta
    // suspensa não pode descobrir só porque um botão parou de funcionar
    // (pedido original: "on reactivation, interface must update
    // automatically"). Símetrico: suspender também avisa.
    if (!!antes?.suspenso !== !!anunciante.suspenso) {
      notificacoesRepo
        .registrar(anunciante.id, {
          tipo: anunciante.suspenso ? 'conta_suspensa' : 'conta_reativada',
          titulo: anunciante.suspenso ? 'Sua conta foi suspensa' : 'Sua conta foi reativada',
          descricao: anunciante.suspenso ? 'Fale com a gente pra entender o motivo.' : undefined,
        })
        .catch((err) => console.error('falha ao notificar suspensão/reativação', err.message));
      sse.emitirParaConta(anunciante.id, 'account.updated', { suspenso: anunciante.suspenso });
    }
    res.json(anunciante);
  } catch (err) {
    if (err.code === '23514') return res.status(400).json({ erro: 'status inválido' });
    throw err;
  }
});

module.exports = { router, exigirAnuncianteLogado, derrubarSessaoSuspensa, criativosComSituacao };
