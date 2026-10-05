const express = require('express');
const multer = require('multer');
const os = require('node:os');
const fs = require('node:fs');
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
const { entradaNoArDasPecas, ESTADOS: ESTADOS_ENTRADA } = require('./entrada-no-ar');
const { resumo: resumoHorarioSemanal } = require('../lib/horario-semanal');
const { cepValido, telefoneE164, data } = require('../br/formato');
const {
  PARTES: PARTES_DO_ENDERECO,
  colunasDoEndereco,
  parteQueFalta,
  problemaNoEndereco,
  numeroConfirmado,
} = require('../lib/endereco');
const { sincronizarContaSemFalhar } = require('../pendencias/endereco');
const { limiteTentativas, zerarTentativas } = require('../lib/limite-tentativas');
const convitesRepo = require('../convites/repository');
const candidaturasRepo = require('../candidaturas/repository');
const pontosRepo = require('../pontos/repository');
const { situacaoDosMoveis } = require('../pontos/movel');
const { horarioEmVigorSql, inventarioSql } = require('../lib/contexto-do-ponto');
const basicoRepo = require('../pontos/basico');
const { materializarPontoDaCandidatura } = require('../pontos/materializar');
const indicacoesRepo = require('../indicacoes/repository');
const categoriasRepo = require('../categorias/repository');
const { removerAvatar } = require('../lib/avatar');
const eventos = require('../lib/eventos');
const notificacoesRepo = require('../creditos/notificacoes');
const sse = require('../lib/sse');
const { primeirosPassosDaConta } = require('./primeiros-passos');
const { acessoDoPainel } = require('./acesso-painel');
const hospedagemSaldo = require('../pontos/hospedagem');
const obrigacaoDoCiclo = require('../bancohoras/obrigacao-do-ciclo');
const assinaturasRepo = require('../financeiro/assinaturas-repository');
const planoAdministrativo = require('../financeiro/plano-administrativo');
const sanCheckout = require('../financeiro/san-checkout');
const cicloContratado = require('../financeiro/ciclo-contratado');
const bancohorasRepo = require('../bancohoras/repository');
const { CRIATIVOS_POR_CONTA } = require('../lib/limites');
const { saudeDaTela } = require('../lib/status-tela');
const { limiteDeCriativos } = require('../playlist/gerador');
const outbox = require('../email/outbox');
const codigosEmail = require('../email/codigos');

// Primeiro código de uma conta nova (cadastro aberto ou pelo admin). Nunca
// derruba o cadastro: a conta já existe, e o modal da conta oferece "Enviar
// código" quando não há código valendo.
async function emitirPrimeiroCodigo(anunciante) {
  try {
    await codigosEmail.emitir(anunciante, { respeitarIntervalo: false });
  } catch (err) {
    console.error(`código de confirmação da conta ${anunciante.id} não entrou na fila: ${outbox.sanitizar(err)}`);
  }
}

// O e-mail de login mudou: tudo que foi mandado pro endereço ANTIGO e ainda
// vale deixa de valer — link de redefinição de senha (senão quem tem a caixa
// antiga ainda troca a senha por 1 hora — revisão Codex do PR #80) e o que
// ainda está na fila pra ele. Na MESMA transação da troca.
async function invalidarEnviosDoEmailAntigo(contaId, db) {
  await db.query("DELETE FROM tokens_senha WHERE usuario_id = $1 AND tipo IN ('anunciante', 'afiliado')", [contaId]);
  await outbox.descartarPendentes(
    contaId,
    ['redefinir_senha', 'codigo_confirmacao', 'codigo_troca_email'],
    'o e-mail de login da conta mudou',
    db,
  );
}

const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')) && String(e).length <= 254;

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
  // Tamanho e formato de cada parte (estação de endereços, 01/10/2026): os
  // mesmos limites do formulário (public/endereco-regras.js).
  const problemaEndereco = problemaNoEndereco(req.body);
  if (problemaEndereco) return res.status(400).json(problemaEndereco);
  // Cupom era gravado como texto livre e so conferido na hora de pagar a
  // comissao. Cupom errado (digitado errado, de vendedor que saiu, ou o
  // proprio cupom de quem esta se cadastrando) passava batido: o anunciante
  // achava que tinha indicado alguem, o vendedor achava que tinha indicado, e
  // a comissao simplesmente nunca existia. Conferido aqui, com a mesma
  // consulta que paga a comissao la na frente.
  // Regra em `indicacoesRepo.indicadorDoCupom` — a mesma que a página de
  // cadastro usa pra mostrar "Indicado por" (GET /indicacoes/:codigo), então
  // o nome mostrado é o da conta que fica associada aqui. Cupom de vendedor
  // não vale mais (programa aposentado, 23/09/2026). O front já reenvia o
  // cadastro sem o cupom quando o erro vem com `campo`, então o link antigo
  // só perde a indicação, não o cadastro.
  if (indicado_por_cupom) {
    const encontrado = await indicacoesRepo.indicadorDoCupom(indicado_por_cupom);
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
  // No cadastro sai UM e-mail só: o código (toda conta nova, qualquer papel
  // — o e-mail é sempre o login). As boas-vindas saem depois que o código
  // for confirmado (POST /anunciantes/me/confirmar-email). Antes as duas
  // saíam juntas, em duas conexões SMTP simultâneas, e o código às vezes
  // não chegava. Um e-mail que falha nunca desfaz o cadastro.
  await emitirPrimeiroCodigo(anunciante);
  // Número que parece endereço vira pendência no painel (nunca trava o
  // cadastro; se a pessoa confirmou no aviso, não vira).
  await sincronizarContaSemFalhar(anunciante.id, {
    confirmado: numeroConfirmado(req.body) ? { alvo: 'conta', id: anunciante.id } : null,
    por: `conta:${anunciante.id}`,
  });

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
    // E-mail que falha não pode desfazer a exclusão (pedido do dono,
    // 18/09/2026) — vai pra fila e a operação segue.
    await outbox.enfileirarSemFalhar({
      tipo: 'conta_excluida',
      chave: `conta_excluida:${conta.id}:${Date.now()}`,
      para: conta.contato_email,
      anuncianteId: conta.id,
      dados: { conta: { nome_empresa: conta.nome_empresa } },
    });
  }
  req.session.destroy(() => res.json({ ok: true }));
});

router.post('/anunciantes/logout', (req, res) => {
  // destroy, não só zerar o campo: a sessão não pode continuar válida no
  // store depois do "Sair". Desde 27/09/2026 o admin tem cookie próprio
  // (src/lib/sessao.js) — sair da conta não sai do admin, e vice-versa.
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
// Conta excluída idem (finalização, 28/09/2026): excluir no computador
// derrubava só aquela sessão; o celular seguia logado por até 7 dias,
// subindo criativo e resgatando crédito numa conta que pediu pra sair.
async function derrubarSessaoSuspensa(req, _res, next) {
  if (!req.session?.anuncianteId) return next();
  const { rows } = await pool.query('SELECT suspenso, excluido_em FROM anunciantes WHERE id = $1', [
    req.session.anuncianteId,
  ]);
  if (!rows[0] || rows[0].suspenso || rows[0].excluido_em) delete req.session.anuncianteId;
  next();
}

// Painel do anunciante (módulo 7) — dados de conta; dashboard de exibições
// agregadas fica pro módulo 7 consumir via GET /anunciantes/:id/exibicoes
// quando o front pedir (leitura simples de exibicoes_contador, sem lógica nova).
router.get('/anunciantes/me', exigirAnuncianteLogado, async (req, res) => {
  const anunciante = await repo.buscarPorId(req.session.anuncianteId);
  if (!anunciante) return res.status(401).json({ erro: 'não autenticado' });
  res.json(await contaParaOPainel(anunciante));
});

// Onboarding do painel: as quatro etapas lidas do estado real da conta
// (src/anunciantes/primeiros-passos.js).
router.get('/anunciantes/me/primeiros-passos', exigirAnuncianteLogado, async (req, res) => {
  const anunciante = await repo.buscarPorId(req.session.anuncianteId);
  if (!anunciante) return res.status(401).json({ erro: 'não autenticado' });
  res.json(await primeirosPassosDaConta(anunciante));
});

// A conta como o painel lê: GET, PATCH do perfil e foto respondem a MESMA
// forma. O PATCH e a foto devolviam a linha crua, e o painel troca o objeto
// inteiro pela resposta — o card do plano perdia `plano_vigente` e dizia
// "Cobertura vencida" pra quem estava em dia (revisão do PR #55, 25/09/2026).
async function contaParaOPainel(anunciante) {
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
  // Plano Básico do ponto (migration 103): benefício SEPARADO do plano
  // comercial — o painel mostra os dois, cada um com a sua origem, e os
  // direitos somados (`direitos`: pontos e horas somam; peça e criativos no
  // ar valem o maior).
  const basicos = await basicoRepo.ativosDaConta(anunciante.id);
  const vigente = repo.planoVigenteId(anunciante) ? plano : null;
  return {
    ...anunciante,
    plano,
    beneficios_basico: basicos.map(basicoRepo.resumo),
    direitos: basicoRepo.direitosCombinados(vigente, basicos),
    plano_origem: origem,
    plano_origem_texto: origem ? planoAdministrativo.ORIGENS_DO_DIREITO[origem] : null,
    // Vigência decidida AQUI (RN-32-B, último dia inclusivo em Matão), não
    // pelo relógio do navegador: o painel só rotula o que o servidor decidiu.
    plano_vigente: !!repo.planoVigenteId(anunciante),
    dias_ate_vencer: vigencia.diasAteVencer(anunciante.data_expiracao),
    // Acesso ao painel ≠ direito de veicular (src/anunciantes/acesso-painel.js):
    // dono de ponto já aprovado vê o painel inteiro mesmo antes do Básico.
    acesso_painel: await acessoDoPainel(anunciante, { basicos }),
  };
}

// ---------------------------------------------------------------------------
// Verificação e troca do e-mail de login (estação de e-mail, 27/09/2026)
// ---------------------------------------------------------------------------
// Código de 6 dígitos com prazo decidido AQUI (src/email/codigos.js): a tela
// mostra `expiraEm`, e recarregar a página não reinicia nada. Três caminhos:
//   · confirmar o e-mail do cadastro (código pro próprio login);
//   · CORRIGIR o e-mail antes de confirmar — quem digitou errado no cadastro
//     nunca receberia o código; prova de que é a mesma pessoa: a sessão do
//     cadastro + a senha. Não precisa (nem pode precisar) do endereço errado;
//   · TROCAR o e-mail de uma conta já confirmada — o novo começa pendente,
//     recebe o código, e só vira login depois de confirmado; o antigo é
//     avisado. Até lá o login continua pelo antigo.

// Estado da verificação pra tela (sem o código, nunca).
router.get('/anunciantes/me/verificacao-email', exigirAnuncianteLogado, async (req, res) => {
  const conta = await repo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(401).json({ erro: 'não autenticado' });
  const [cadastro, troca] = await Promise.all([
    conta.email_confirmado ? null : codigosEmail.estado(conta.id, 'cadastro'),
    codigosEmail.estado(conta.id, 'troca'),
  ]);
  res.json({
    email: conta.contato_email,
    confirmado: !!conta.email_confirmado,
    validadeMinutos: codigosEmail.VALIDADE_MIN,
    intervaloReenvioSegundos: codigosEmail.INTERVALO_REENVIO_S,
    cadastro,
    troca: troca?.pendente ? troca : null,
  });
});

// `limiteTentativas` (por IP) + o limite do próprio código (5 erros e ele
// morre, src/email/codigos.js): força bruta num código de 6 dígitos não passa.
router.post('/anunciantes/me/confirmar-email', exigirAnuncianteLogado, limiteTentativas, async (req, res) => {
  if (!String(req.body.codigo || '').trim()) return res.status(400).json({ erro: 'código obrigatório' });
  const conta = await repo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(401).json({ erro: 'não autenticado' });
  if (conta.email_confirmado) return res.json({ ok: true, jaConfirmado: true });
  const r = await codigosEmail.conferir(conta.id, 'cadastro', req.body.codigo);
  if (!r.ok) return res.status(400).json({ erro: codigosEmail.MENSAGEM_DO_ERRO[r.motivo], motivo: r.motivo });
  // O código confirma o endereço PARA O QUAL foi mandado: se o login mudou
  // no meio (correção, admin), ele não confirma o endereço novo.
  if (repo.normalizarEmail(r.email) !== repo.normalizarEmail(conta.contato_email)) {
    return res.status(400).json({ erro: 'esse código era de outro endereço — peça um novo', motivo: 'expirado' });
  }
  zerarTentativas(req);
  await repo.atualizar(conta.id, { email_confirmado: true });
  // Boas-vindas só DEPOIS da confirmação, uma vez na vida da conta, e só pra
  // quem anuncia — o texto fala em escolher plano e colocar anúncio, o que
  // não faz sentido pra quem entrou só como ponto (convite).
  if ((conta.papeis || []).includes('anunciante') && !conta.conta_propria) {
    await outbox.enfileirarSemFalhar({
      tipo: 'boas_vindas',
      chave: `boas_vindas:${conta.id}`,
      para: conta.contato_email,
      anuncianteId: conta.id,
      dados: { conta: { nome_empresa: conta.nome_empresa } },
    });
  }
  sse.emitirParaConta(conta.id, 'account.updated', { email_confirmado: true });
  res.json({ ok: true });
});

// Reenviar = código NOVO (o anterior deixa de valer). 60 s entre um e outro
// e no máximo 5 por hora; a resposta traz o prazo real pra tela.
router.post('/anunciantes/me/reenviar-codigo-email', exigirAnuncianteLogado, limiteTentativas, async (req, res) => {
  const conta = await repo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(401).json({ erro: 'não autenticado' });
  if (conta.email_confirmado) return res.status(409).json({ erro: 'seu e-mail já está confirmado' });
  try {
    const r = await codigosEmail.emitir(conta);
    res.json({ ok: true, email: conta.contato_email, ...r });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message, podeReenviarEm: err.podeReenviarEm });
    throw err;
  }
});

// Confere e-mail novo + senha atual; devolve o erro pronto pra tela ou null.
async function conferirPedidoDeEmail(conta, req) {
  const novo = repo.normalizarEmail(req.body.email);
  if (!emailValido(novo)) return { status: 400, erro: 'e-mail inválido', campo: 'email' };
  if (novo === repo.normalizarEmail(conta.contato_email)) {
    return { status: 400, erro: 'esse já é o e-mail da sua conta', campo: 'email' };
  }
  const comSenha = await repo.buscarPorEmailComSenha(conta.contato_email);
  if (!comSenha || !(await repo.validarSenha(comSenha, String(req.body.senha || '')))) {
    return { status: 401, erro: 'senha incorreta', campo: 'senha' };
  }
  if (await repo.buscarPorEmailComSenha(novo)) {
    return { status: 409, erro: 'esse e-mail já é usado por outra conta', campo: 'email' };
  }
  return { novo };
}

// Corrigir o e-mail ANTES de confirmar: troca na hora (o endereço atual nunca
// foi provado), apaga o código antigo e manda um novo pro endereço certo.
router.post('/anunciantes/me/corrigir-email', exigirAnuncianteLogado, limiteTentativas, async (req, res) => {
  const conta = await repo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(401).json({ erro: 'não autenticado' });
  if (conta.email_confirmado) {
    return res.status(409).json({ erro: 'seu e-mail já está confirmado — use a troca de e-mail no perfil' });
  }
  const pedido = await conferirPedidoDeEmail(conta, req);
  if (pedido.erro) return res.status(pedido.status).json({ erro: pedido.erro, campo: pedido.campo });

  const cliente = await pool.connect();
  let atualizada;
  try {
    await cliente.query('BEGIN');
    atualizada = await repo.atualizar(conta.id, { contato_email: pedido.novo }, cliente);
    await cliente.query(
      `INSERT INTO alteracoes_email (anunciante_id, email_anterior, email_novo, origem)
       VALUES ($1, $2, $3, 'correcao_antes_de_confirmar')`,
      [conta.id, conta.contato_email, pedido.novo],
    );
    await codigosEmail.descartar(conta.id, 'cadastro', cliente);
    await invalidarEnviosDoEmailAntigo(conta.id, cliente);
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ erro: 'esse e-mail já é usado por outra conta' });
    throw err;
  } finally {
    cliente.release();
  }
  try {
    const r = await codigosEmail.emitir(atualizada, { respeitarIntervalo: false });
    res.json({ ok: true, email: atualizada.contato_email, ...r });
  } catch (err) {
    // O e-mail já foi corrigido; só o código não saiu (teto por hora). A
    // tela mostra o endereço novo e oferece reenviar quando puder.
    if (err.status) return res.status(err.status).json({ erro: err.message, email: atualizada.contato_email });
    throw err;
  }
});

// Trocar o e-mail DEPOIS de confirmado: o novo fica pendente até o código.
router.post('/anunciantes/me/trocar-email', exigirAnuncianteLogado, limiteTentativas, async (req, res) => {
  const conta = await repo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(401).json({ erro: 'não autenticado' });
  if (!conta.email_confirmado) {
    return res.status(409).json({ erro: 'confirme seu e-mail atual primeiro, ou corrija o endereço na confirmação' });
  }
  const pedido = await conferirPedidoDeEmail(conta, req);
  if (pedido.erro) return res.status(pedido.status).json({ erro: pedido.erro, campo: pedido.campo });
  try {
    // Pedir de novo pra OUTRO endereço substitui o pendente na hora; pro
    // mesmo, respeita o intervalo de reenvio.
    const atual = await codigosEmail.estado(conta.id, 'troca');
    const r = await codigosEmail.emitir(conta, {
      finalidade: 'troca',
      email: pedido.novo,
      respeitarIntervalo: atual.email === pedido.novo,
    });
    res.json({ ok: true, emailPendente: pedido.novo, ...r });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message, podeReenviarEm: err.podeReenviarEm });
    throw err;
  }
});

router.post('/anunciantes/me/confirmar-troca-email', exigirAnuncianteLogado, limiteTentativas, async (req, res) => {
  if (!String(req.body.codigo || '').trim()) return res.status(400).json({ erro: 'código obrigatório' });
  const conta = await repo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(401).json({ erro: 'não autenticado' });
  const r = await codigosEmail.conferir(conta.id, 'troca', req.body.codigo);
  if (!r.ok) return res.status(400).json({ erro: codigosEmail.MENSAGEM_DO_ERRO[r.motivo], motivo: r.motivo });
  zerarTentativas(req);

  const cliente = await pool.connect();
  let atualizada;
  let alteracaoId;
  try {
    await cliente.query('BEGIN');
    atualizada = await repo.atualizar(conta.id, { contato_email: r.email, email_confirmado: true }, cliente);
    const { rows } = await cliente.query(
      `INSERT INTO alteracoes_email (anunciante_id, email_anterior, email_novo, origem)
       VALUES ($1, $2, $3, 'troca_confirmada') RETURNING id`,
      [conta.id, conta.contato_email, r.email],
    );
    alteracaoId = rows[0].id;
    await invalidarEnviosDoEmailAntigo(conta.id, cliente);
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    // Outra conta ficou com o endereço entre o pedido e a confirmação.
    if (err.code === '23505') return res.status(409).json({ erro: 'esse e-mail passou a ser usado por outra conta' });
    throw err;
  } finally {
    cliente.release();
  }
  // Aviso ao endereço ANTIGO — é por ele que o dono de verdade percebe uma
  // troca que não fez. A troca já valeu; o aviso vai pela fila.
  await outbox.enfileirarSemFalhar({
    tipo: 'email_alterado',
    chave: `email_alterado:${alteracaoId}`,
    para: conta.contato_email,
    anuncianteId: conta.id,
    dados: { conta: { nome_empresa: conta.nome_empresa }, emailNovoMascarado: outbox.mascararEmail(r.email) },
  });
  sse.emitirParaConta(conta.id, 'account.updated', {});
  res.json({ ok: true, email: atualizada.contato_email });
});

router.delete('/anunciantes/me/trocar-email', exigirAnuncianteLogado, async (req, res) => {
  await codigosEmail.descartar(req.session.anuncianteId, 'troca');
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
    `SELECT p.id, p.nome, p.cidade, p.endereco, p.status, ${horarioEmVigorSql('p')} AS horario_semanal, p.tipo,
            ${inventarioSql('p')} AS inventario,
            (p.escolha_bloqueada_em IS NOT NULL) AS bloqueado,
            COALESCE(SUM(pl.segundos_por_hora), 0)::int AS segundos_vendidos,
            (ap.ponto_id IS NOT NULL) AS escolhido, ap.escolhido_em,
            (p.anunciante_id IS NOT DISTINCT FROM $1) AS seu_ponto
       FROM pontos p
       LEFT JOIN anunciantes_pontos outros ON outros.ponto_id = p.id
       LEFT JOIN anunciantes ao ON ao.id = outros.anunciante_id AND NOT ao.suspenso AND ao.excluido_em IS NULL
       LEFT JOIN planos pl ON pl.id = ao.plano_id
       LEFT JOIN anunciantes_pontos ap ON ap.ponto_id = p.id AND ap.anunciante_id = $1
      WHERE p.status = ANY($2::text[])
      GROUP BY p.id, p.nome, p.cidade, p.endereco, p.status, p.horario_semanal, p.tipo, p.escolha_bloqueada_em, ap.ponto_id,
               ap.escolhido_em, p.anunciante_id
      ORDER BY (p.anunciante_id IS NOT DISTINCT FROM $1) DESC, p.status DESC, p.nome`,
    [conta.id, pontosRepo.STATUS_NA_REDE],
  );

  // Ponto móvel SEM ALOCAÇÃO (migration 114) não é inventário: fica fora da
  // lista — só aparece para quem já o tinha escolhido (para poder tirar), e
  // nunca conta como ponto no ar.
  const lista = rows.filter((r) => r.inventario || r.escolhido);
  // A conta do bônus é a MESMA do gerador da playlist, com as mesmas funções:
  // quantos pontos EM OPERAÇÃO entram na fatia dele hoje, e quantos segundos
  // por hora isso vira depois da RN-49. Refazer a conta aqui à mão daria um
  // número no painel diferente do que a tela executa.
  const noAr = lista.filter((r) => r.status === 'em_operacao' && r.inventario).map((r) => r.id);
  const bloqueados = lista.filter((r) => r.bloqueado).map((r) => r.id);
  // Mesma ordem do gerador (`ORDER BY escolhido_em`): se o plano encolheu e
  // sobrou escolha acima do teto, a fatia corta os mesmos pontos aqui e lá.
  const escolhidos = lista
    .filter((r) => r.escolhido)
    .sort((a, b) => new Date(a.escolhido_em) - new Date(b.escolhido_em))
    .map((r) => r.id);
  const cobertos = pontosDoAnunciante(
    { id: conta.id, pontosIncluidos: plano.pontos_incluidos, escolhidos },
    noAr,
    bloqueados,
  );
  const naCobertura = new Set(cobertos);
  // Ponto móvel: local atual (a alocação em curso) e próximo evento —
  // decididos no servidor (src/pontos/movel.js), o card só mostra.
  const moveis = await situacaoDosMoveis(lista.filter((r) => r.tipo === 'movel').map((r) => r.id));
  const base = Number(plano.segundos_por_hora) || 0;
  const efetivos = segundosCompensados(base, plano.pontos_incluidos, cobertos.length);

  res.json({
    limite: plano.pontos_incluidos,
    escolhidos,
    // Sem escolha nenhuma a Mostraí distribui sozinha (RN-44): a fatia
    // estável de `pontosDoAnunciante` entre os pontos no ar com espaço. O
    // painel explica isso em vez de mostrar "0 de N" como se faltasse algo.
    modoAutomatico: escolhidos.length === 0,
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
    pontos: lista.map((r) => ({
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
      // O ponto é desta conta (ela é a dona do comércio). Só destaque: nunca
      // vem marcado por isso — veicular nele é escolha, e se marcado conta
      // no limite do plano como qualquer outro.
      seuPonto: r.seu_ponto,
      // Entra na distribuição da campanha hoje (escolhido e no ar, ou
      // sorteado no modo automático). É a mesma conta do gerador.
      naCobertura: naCobertura.has(r.id),
      // 'fixo' | 'movel'. Quem escolhe o móvel escolhe o PONTO (nunca uma
      // hospedagem ou um evento): a campanha acompanha o ponto enquanto ele
      // estiver alocado. Sem alocação, `inventario: false` (só para quem já o
      // tinha): não veicula até a próxima alocação.
      tipo: r.tipo,
      inventario: r.inventario,
      movel: moveis.get(r.id) || null,
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
    const { rows } = await pool.query(
      `SELECT p.id, ${inventarioSql('p')} AS inventario FROM pontos p
        WHERE p.id = ANY($1::int[]) AND p.status = ANY($2::text[])`,
      [pedidos, pontosRepo.STATUS_NA_REDE],
    );
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
    // Ponto móvel sem alocação (migration 114) não aceita escolha NOVA — não
    // está em lugar nenhum; quem já tinha pode mantê-lo.
    const foraDoInventario = new Set(rows.filter((r) => !r.inventario).map((r) => r.id));
    if (novos.some((id) => foraDoInventario.has(id))) {
      return res.status(409).json({ erro: 'esse ponto móvel está sem alocação e não pode ser escolhido agora' });
    }
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
  //
  // Ponto que continua na lista MANTÉM o `escolhido_em` (27/09/2026): apagar
  // e reinserir tudo dava o mesmo `now()` a todos (é o relógio da
  // transação), e a ordem da escolha — que decide quem fica se o plano
  // encolher (`pontosDoAnunciante` corta pela ordem) — virava sorteio. Os
  // novos entram com `clock_timestamp()`, na ordem em que vieram.
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1 AND NOT (ponto_id = ANY($2::int[]))', [
      conta.id,
      pedidos,
    ]);
    for (const pontoId of pedidos) {
      await cliente.query(
        `INSERT INTO anunciantes_pontos (anunciante_id, ponto_id, escolhido_em) VALUES ($1,$2, clock_timestamp())
         ON CONFLICT (anunciante_id, ponto_id) DO NOTHING`,
        [conta.id, pontoId],
      );
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
  const problemaEndereco = problemaNoEndereco(dados);
  if (problemaEndereco) return res.status(400).json(problemaEndereco);
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
  const conta = await repo.atualizar(req.session.anuncianteId, dados);
  if (!conta) return res.status(401).json({ erro: 'não autenticado' });
  // Endereço da CONTA mudou: reavalia só a pendência dela — nenhum ponto
  // muda de endereço por causa disso (o do ponto é outro, em Meus pontos).
  if (PARTES_DO_ENDERECO.some((p) => dados[p] !== undefined)) {
    await sincronizarContaSemFalhar(conta.id, {
      confirmado: numeroConfirmado(req.body) ? { alvo: 'conta', id: conta.id } : null,
      por: `conta:${conta.id}`,
    });
  }
  res.json(await contaParaOPainel(conta));
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
    const conta = await repo.atualizar(req.session.anuncianteId, { foto_url: data.publicUrl });
    if (!conta) return res.status(401).json({ erro: 'não autenticado' });
    res.json(await contaParaOPainel(conta));
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
// /admin/criativos/:id em src/admin/routes.js). Não passa pelo limite do
// PLANO: B só entra tirando A, então as vagas ativas depois da troca são as
// mesmas. Passa pelo teto de CADASTRO, sim (revisão Codex do PR #88,
// 28/09/2026): A vira 'retirado' e continua guardado, e cada troca deixava
// mais um retirado sem nada segurando.
//
// Dois tetos, duas contagens: o de CADASTRO (`CRIATIVOS_POR_CONTA`, conta
// retirado — `contarCadastrados`) vale pra todo upload e só a conta própria
// pula (`semTeto`); o do PLANO (`limite`, vagas ativas —
// `contarNaoReprovados`) vale pra upload que não é substituição.
//
// `envioChave` (migration 098): idempotência do upload do cliente — ver
// `responderEnvioExistente` e a rota do anunciante. `avisar`: chamado quando
// a linha temporária nasce e quando o trabalho termina (ok ou falha), pra o
// painel mostrar o card "processando" e tirá-lo/atualizá-lo sem F5.
//
// Tempos por etapa (estação upload, 27/09/2026) vão pro log em uma linha, só
// números: sem eles, "o upload está lento" era palpite.
async function subirCriativo(
  req,
  res,
  {
    contaId,
    limite,
    semTeto = false,
    duracaoMaxima = null,
    peloOperador = false,
    substitui = null,
    envioChave = null,
    avisar = null,
  },
) {
  if (!req.file) return res.status(400).json({ erro: 'arquivo obrigatório' });
  const inicio = Date.now();
  const tempos = { receber_ms: req.inicioUpload ? inicio - req.inicioUpload : null };
  const medir = async (etapa, fn) => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      tempos[etapa] = Date.now() - t;
    }
  };
  const registrar = (criativoId, resultado, extra = {}) =>
    console.log(
      'upload de criativo',
      JSON.stringify({ criativo: criativoId, resultado, ...tempos, ...extra, total_ms: Date.now() - inicio }),
    );
  // Tudo dentro do try: o multer já gravou o arquivo em disco antes de
  // chegar aqui, e os `return` de erro que ficavam fora do finally deixavam
  // até 95 MB de lixo em /tmp por request recusada.
  try {
    // Teto de cadastro antes do limite do plano, substituição inclusive: o
    // cliente com 3 guardados (retirados contam) exclui um antes de subir.
    if (!semTeto && (await criativosRepo.contarCadastrados(contaId)) >= CRIATIVOS_POR_CONTA) {
      return res.status(400).json({
        erro: `você já tem ${CRIATIVOS_POR_CONTA} criativos cadastrados (contando os que estão fora do ar) — exclua um pra subir outro`,
      });
    }
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
    const midia = await medir('ffprobe_ms', () => ffmpeg.probeMidia(req.file.path).catch(() => null));
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

    let criativoTemp;
    try {
      criativoTemp = await medir('db_criar_ms', () =>
        criativosRepo.criar({
          anunciante_id: contaId,
          arquivo_original_url: req.file.originalname,
          arquivo_normalizado_url: null,
          thumbnail_url: null,
          duracao_segundos: null,
          substitui_criativo_id: substitui ? substitui.id : null,
          envio_chave: envioChave,
        }),
      );
    } catch (err) {
      // Duas requisições com a mesma chave ao mesmo tempo (o navegador repetiu
      // enquanto a primeira ainda rodava): o índice único deixa uma só criar.
      if (envioChave && err.code === '23505') {
        const existente = await criativosRepo.buscarPorEnvio(contaId, envioChave);
        if (existente) return responderEnvioExistente(res, existente);
      }
      throw err;
    }
    avisar?.();

    try {
      const { tempos: temposMidia, ...normalizado } = await ffmpeg.normalizar(
        req.file.path,
        criativoTemp.id,
        duracaoMaxima,
        midia,
      );
      Object.assign(tempos, temposMidia);
      // Peça que o operador subiu já entra aprovada: quem aprovaria é quem
      // acabou de subir. Fazer o dono aprovar o próprio upload seria um clique
      // sem decisão nenhuma por trás. Substituto é a exceção: a troca só
      // acontece na aprovação, então ele espera em análise.
      const criativo = await medir('db_finalizar_ms', () =>
        criativosRepo.atualizar(criativoTemp.id, {
          ...normalizado,
          ...(peloOperador ? { editado_pelo_operador: true } : {}),
          ...(peloOperador && !substitui ? { status: 'aprovado' } : {}),
        }),
      );
      if (!criativo) {
        // A linha saiu no meio do processamento (a exclusão do cliente
        // recusa isso; aqui é a rede de segurança). Nunca 201 de um criativo
        // que não existe, e os arquivos que acabaram de subir não ficam órfãos.
        registrar(criativoTemp.id, 'excluido_durante_processamento');
        removerArquivosDoStorage(criativoTemp.id);
        avisar?.();
        return res.status(409).json({ erro: 'esse criativo foi excluído enquanto era processado — envie de novo' });
      }
      registrar(criativoTemp.id, 'ok');
      // Peça enviada: a campanha deixa de estar parada por falta de peça do
      // cliente (a análise é da Mostraí) — fecha a janela do cliente.
      await obrigacaoDoCiclo.avaliarDisponibilidadeSemFalhar(contaId);
      res.status(201).json(criativo);
      avisar?.();
    } catch (err) {
      // Se o ffmpeg falhar (arquivo corrompido, vídeo mais curto que 1s), a
      // linha já criada ficava no banco como "pendente" e ocupava a cota do
      // plano pra sempre — três arquivos ruins e o cliente nunca mais subia nada.
      // O erro vai pro log: sem isso, falha de storage (credencial vencida,
      // bucket errado) e arquivo ruim do cliente viravam a mesma frase, e não
      // dava pra saber qual dos dois era sem reproduzir na mão.
      console.error('falha ao processar criativo', err);
      Object.assign(tempos, err?.tempos);
      registrar(criativoTemp.id, err?.origem === 'storage' ? 'falha_storage' : 'falha_midia');
      await criativosRepo.deletar(criativoTemp.id);
      await obrigacaoDoCiclo.avaliarDisponibilidadeSemFalhar(contaId);
      // O card "processando" some sem F5.
      avisar?.();
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

// Best-effort: limpa os arquivos do criativo no Storage. Se falhar, não
// impede nada — só fica lixo no bucket pra limpar depois.
async function removerArquivosDoStorage(criativoId) {
  try {
    const supabase = require('../lib/supabase');
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;
    await supabase.storage.from(bucket).remove([`${criativoId}.mp4`, `${criativoId}-thumb.jpg`]);
  } catch {
    /* ignora */
  }
}

// Repetição de um envio que já chegou (mesma `Idempotency-Key`): devolve o
// que existe em vez de criar outro criativo. 200 = pronto; 202 = ainda
// processando (a primeira requisição segue trabalhando — o painel espera o
// card atualizar pelo SSE ou perguntando em /anunciantes/me/criativos/envios).
function responderEnvioExistente(res, criativo) {
  if (criativo.arquivo_normalizado_url) return res.status(200).json({ ...criativo, repetido: true });
  return res.status(202).json({ processando: true, id: criativo.id });
}

// Chave de idempotência: gerada pelo navegador por arquivo escolhido
// (crypto.randomUUID). Opcional — sem ela o upload funciona como antes.
const CHAVE_ENVIO = /^[A-Za-z0-9-]{16,64}$/;

// Marca quando a requisição chegou, antes do multer ler o corpo: a diferença
// até o handler é o tempo de receber o arquivo (UPLOAD_RECEIVE no log).
const marcarInicioUpload = (req, _res, next) => {
  req.inicioUpload = Date.now();
  next();
};

router.post(
  '/anunciantes/:id/criativos',
  exigirAnuncianteLogado,
  marcarInicioUpload,
  upload.single('arquivo'),
  async (req, res) => {
    if (Number(req.params.id) !== req.session.anuncianteId) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(403).json({ erro: 'só pode subir criativo pra própria conta' });
    }
    return subirCriativoDoCliente(req, res);
  },
);

async function subirCriativoDoCliente(req, res) {
  const envioChave = req.get('idempotency-key') || null;
  if (envioChave && !CHAVE_ENVIO.test(envioChave)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ erro: 'chave de envio inválida' });
  }
  // Upload interrompido por restart (deploy) no meio do FFmpeg não ocupa a
  // cota pra sempre.
  await criativosRepo.descartarProcessamentosOrfaos(req.session.anuncianteId);
  // Antes de plano e limite: repetir um envio que já chegou não pode esbarrar
  // no "limite atingido" que ele mesmo causou.
  if (envioChave) {
    const existente = await criativosRepo.buscarPorEnvio(req.session.anuncianteId, envioChave);
    if (existente) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return responderEnvioExistente(res, existente);
    }
  }
  const anunciante = await repo.buscarPorId(req.session.anuncianteId);
  // Antes liberava 1 criativo sem plano, "pra não travar quem está no meio
  // do cadastro" — decisão revertida pelo dono, 19/09/2026: o painel agora
  // trava a tela inteira sem plano (ver front), então subir criativo sem
  // plano nem deveria ser alcançável por ali; isso é a segunda trava, direto
  // no servidor, pra quem tentar pela API sem passar pela tela. Ser ponto
  // não libera plano (ADR-016, 24/09/2026).
  // Plano Básico do ponto (migration 103, substitui a parte "ser ponto não
  // libera plano" do ADR-016): a conta que hospeda um ponto ativo sobe peça
  // mesmo sem plano comercial. Limites = os direitos somados (o maior de
  // peças no ar e de duração entre as duas origens).
  // Saldo de hospedagem (migration 113): quem hospedou um ponto móvel sobe
  // peça com as horas gratuitas mesmo sem plano — `direitosDePeca`.
  const { direitos } = await direitosDePeca(anunciante);
  if (!direitos) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ erro: 'sua conta ainda não tem plano' });
  }
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
  return subirCriativo(req, res, {
    contaId: req.session.anuncianteId,
    limite: direitos.limiteCriativos,
    semTeto: false,
    duracaoMaxima: direitos.duracaoMaxima,
    substitui,
    envioChave,
    // Quando a linha nasce (card "processando") e quando o trabalho termina
    // (pronto, ou falhou e a linha saiu): o painel refaz a lista sem F5. O
    // admin só é avisado no fim — a fila de aprovação não mostra peça sem
    // arquivo pronto.
    avisar: () => {
      sse.emitirParaConta(anunciante.id, 'creative.updated', {});
      if (res.headersSent) sse.emitirParaAdmin('creative.updated', {});
    },
  });
}

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
// O teto de cadastro mora dentro de `subirCriativo` desde a revisão Codex do
// PR #88 (28/09/2026) — aqui só se diz quem pula (`semTeto`, conta própria).
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
    limite: Infinity,
    semTeto: conta.conta_propria,
    // A conta própria não tem teto de duração: o inventário é da casa.
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
    // Troca pelo operador não esbarra no teto de cadastro: o admin não tem
    // como excluir criativo (só retirar, e retirado conta), então com 3
    // cadastrados ficava sem saída. O teto segue valendo pro cliente
    // (revisão do PR #88, 28/09/2026).
    semTeto: true,
    duracaoMaxima: conta.conta_propria ? null : plano ? plano.duracao_maxima_segundos : null,
    peloOperador: true,
    substitui: atual,
  });
});

// Os limites de PEÇA da conta (quantas no ar, até quantos segundos): plano
// comercial e Básico do ponto somados; sem nenhum dos dois, o SALDO DE
// HOSPEDAGEM disponível dá a regra do saldo (src/pontos/hospedagem.js#
// REGRA_DO_SALDO). Sem nada disso, `direitos` é null (sem direito de subir).
// Um lugar só para upload, retomar e "Meus criativos".
async function direitosDePeca(conta) {
  const planoId = planoEfetivoId(conta);
  const plano = planoId ? await planosRepo.buscarPorId(planoId) : null;
  const basicos = conta.conta_propria ? [] : await basicoRepo.ativosDaConta(conta.id);
  if (plano || basicos.length) {
    return { plano, basicos, saldoHospedagem: 0, direitos: basicoRepo.direitosCombinados(plano, basicos) };
  }
  const saldo = conta.conta_propria ? 0 : (await hospedagemSaldo.saldoDaConta(conta.id)).disponivelSegundos;
  if (saldo <= 0) return { plano, basicos, saldoHospedagem: 0, direitos: null };
  const regra = hospedagemSaldo.REGRA_DO_SALDO;
  return {
    plano,
    basicos,
    saldoHospedagem: saldo,
    direitos: { limiteCriativos: regra.limiteCriativos, duracaoMaxima: regra.duracaoMaximaSegundos },
  };
}

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
  // O Básico do ponto (migration 103) também veicula: sem plano comercial,
  // a conta com ponto ativo toca no próprio ponto; com os dois, o limite de
  // peças no ar é o maior (o gerador usa o mesmo conjunto nas duas origens).
  const basicos = conta.conta_propria ? [] : await basicoRepo.ativosDaConta(conta.id);
  // Sem plano vigente nem Básico, o saldo de hospedagem (migration 113)
  // ainda veicula — na rede inteira, com a regra do saldo.
  const saldoHospedagem =
    vigente || basicos.length || conta.conta_propria
      ? 0
      : (await hospedagemSaldo.saldoDaConta(conta.id)).disponivelSegundos;
  const regraSaldo = hospedagemSaldo.REGRA_DO_SALDO;
  const contaVeicula =
    (!!vigente || basicos.length > 0 || saldoHospedagem > 0) &&
    !conta.suspenso &&
    !conta.excluido_em &&
    !conta.conta_propria;
  const prontos = criativos.filter((c) => c.status === 'aprovado' && c.arquivo_normalizado_url);
  const limiteBasico = Math.max(0, ...basicos.map((b) => b.limite_criativos));
  const limite = vigente
    ? Math.max(limiteDeCriativos(false, vigente.limite_criativos, prontos.length), limiteBasico)
    : saldoHospedagem > 0
      ? regraSaldo.limiteCriativos
      : limiteBasico;
  // `em_rodizio`: a peça ENTRA na playlist (conta veiculando, dentro do
  // limite de peças simultâneas, mesma ordem do gerador). Até 27/09/2026
  // isto se chamava `no_ar` — e era o que o painel mostrava como "No ar"
  // sem nenhuma exibição ter acontecido. "No ar" agora é comprovante
  // confirmado (src/anunciantes/entrada-no-ar.js).
  // Duas vagas, a mesma escolha do gerador: a do plano (as N mais novas, N =
  // limite do plano) e a do Básico (as mais novas que cabem no teto de peça
  // da conta hoje — `basicoRepo.cabeNoTeto`, a regra de `pecasDoBasico`).
  const teto = basicoRepo.direitosCombinados(vigente, basicos).duracaoMaxima;
  const doPlano = vigente ? prontos.slice(0, limiteDeCriativos(false, vigente.limite_criativos, prontos.length)) : [];
  const doBasico = prontos.filter((c) => basicoRepo.cabeNoTeto(c.duracao_segundos, teto)).slice(0, limiteBasico);
  // Só o saldo: a escolha de `pecasDoSaldo` (as mais novas dentro da regra).
  const doSaldo =
    saldoHospedagem > 0
      ? prontos
          .filter((c) => Number(c.duracao_segundos) <= regraSaldo.duracaoMaximaSegundos)
          .slice(0, regraSaldo.limiteCriativos)
      : [];
  const rodizio = new Set(contaVeicula ? [...doPlano, ...doBasico, ...doSaldo].map((c) => c.id) : []);
  const comRodizio = criativos.map((c) => ({ ...c, em_rodizio: rodizio.has(c.id) }));
  const entradas = await entradaNoArDasPecas({
    conta,
    plano: vigente,
    basicos,
    teto: saldoHospedagem > 0 ? regraSaldo.duracaoMaximaSegundos : teto,
    contaVeicula,
    saldoHospedagem,
    criativos: comRodizio,
  });
  return {
    criativos: comRodizio.map((c) => {
      const entrada = entradas.get(c.id) || null;
      return { ...c, entrada, no_ar: entrada?.estado === ESTADOS_ENTRADA.NO_AR };
    }),
    plano,
    basicos,
    saldoHospedagem,
    limite,
    contaVeicula,
  };
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
// Peça aprovada: a situação é a da entrada no ar (entrada-no-ar.js), nunca
// "no ar" só por estar aprovada.
const SITUACAO_DA_ENTRADA = {
  APROVADO: 'aprovado',
  PROGRAMADO: 'programado',
  AGUARDANDO_PRIMEIRA_EXIBICAO: 'aguardando_primeira_exibicao',
  NO_AR: 'no_ar',
  ATRASADO: 'atrasado',
};
// O que aconteceu com um envio cuja resposta se perdeu (proxy devolveu 524,
// rede caiu, aba perdeu a conexão): a chave é a mesma que o painel mandou no
// `Idempotency-Key`. `pronto` = criativo criado; `processando` = chegou e o
// vídeo ainda está sendo processado; 404 `nao_encontrado` = não existe (não
// chegou, ou o processamento falhou e a linha saiu) — aí reenviar com a
// MESMA chave é seguro.
router.get('/anunciantes/me/criativos/envios/:chave', exigirAnuncianteLogado, async (req, res) => {
  if (!CHAVE_ENVIO.test(req.params.chave)) return res.status(400).json({ erro: 'chave de envio inválida' });
  await criativosRepo.descartarProcessamentosOrfaos(req.session.anuncianteId);
  const criativo = await criativosRepo.buscarPorEnvio(req.session.anuncianteId, req.params.chave);
  if (!criativo) return res.status(404).json({ estado: 'nao_encontrado' });
  res.json({ estado: criativo.arquivo_normalizado_url ? 'pronto' : 'processando', id: criativo.id });
});

router.get('/anunciantes/me/criativos', exigirAnuncianteLogado, async (req, res) => {
  const conta = await repo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  await criativosRepo.descartarProcessamentosOrfaos(conta.id);
  const { criativos, plano, basicos, saldoHospedagem, limite, contaVeicula } = await criativosComSituacao(conta);
  const direitos =
    !plano && !basicos.length && saldoHospedagem > 0
      ? {
          limiteCriativos: hospedagemSaldo.REGRA_DO_SALDO.limiteCriativos,
          duracaoMaxima: hospedagemSaldo.REGRA_DO_SALDO.duracaoMaximaSegundos,
        }
      : basicoRepo.direitosCombinados(plano, basicos);
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
      situacao:
        c.status === 'aprovado'
          ? SITUACAO_DA_ENTRADA[c.entrada?.estado] || 'aprovado'
          : c.status === 'retirado' && c.retirado_por === 'cliente'
            ? 'pausado'
            : SITUACAO_CRIATIVO[c.status],
      // Quem tirou do ar (migration 109): 'cliente' (pausou, pode retomar),
      // 'admin' ou 'substituicao' — o painel explica cada um.
      retiradaPor: c.status === 'retirado' ? c.retirado_por : null,
      // Quando a primeira exibição deve acontecer e quando vira atraso — o
      // servidor calcula (o painel não adivinha horário de ponto nem regra
      // de playlist); e o que o comprovante confirmou.
      entrada: c.entrada
        ? {
            primeiraJanelaPrevista: c.entrada.primeiraJanelaPrevista,
            prazoPrimeiraExibicao: c.entrada.prazoPrimeiraExibicao,
            primeiraExibicaoEm: c.entrada.primeiraExibicaoEm,
            ultimaExibicaoEm: c.entrada.ultimaExibicaoEm,
            motivo: c.entrada.motivo,
          }
        : null,
      arquivoUrl: c.arquivo_normalizado_url,
      thumbnailUrl: c.thumbnail_url,
      duracaoSegundos: c.duracao_segundos,
      motivoRecusa: c.status === 'reprovado' ? c.motivo_reprovacao : null,
      feitoPelaMostrai: !!c.editado_pelo_operador,
      substitui: c.substitui_criativo_id,
      substitutaEmAnalise: substitutaDe.get(c.id) || null,
      enviadoEm: c.created_at,
    })),
    // `temPlano`: tem algum direito de veicular — plano comercial OU o
    // Básico do ponto (migration 103).
    temPlano: !!plano || basicos.length > 0 || saldoHospedagem > 0,
    temBasico: basicos.length > 0,
    // Só o saldo de hospedagem (sem plano nem Básico): a peça roda na rede
    // inteira com as horas gratuitas (migration 113).
    soSaldoHospedagem: !plano && basicos.length === 0 && saldoHospedagem > 0,
    // Dono de ponto da rede ainda sem direito de veicular (tela aguardando
    // instalação, Básico ainda não ativo): o painel mostra o módulo com o
    // envio fechado e o motivo, em vez de sumir com ele atrás de "compre um
    // plano" (01/10/2026).
    aguardandoBeneficio:
      !plano && basicos.length === 0 && !saldoHospedagem
        ? (await acessoDoPainel(conta, { basicos })).basico.aguardando
        : null,
    // Plano (anúncio na rede) e/ou ponto no ar (a tela do próprio
    // comércio) — o painel explica onde a peça aprovada roda.
    rodaNaRede: !!conta.plano_id || saldoHospedagem > 0,
    rodaNoProprioPonto: pontos[0].n > 0,
    contaVeicula,
    limiteNoAr: limite,
    limiteCadastro: direitos.limiteCriativos,
    emUso,
    duracaoMaxima: direitos.duracaoMaxima,
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
  // Linha sem arquivo = upload ainda no FFmpeg (a órfã de mais de 30 min já
  // saiu pelo descarte). Apagar agora não cancela o processamento: ele subia
  // os arquivos pro Storage, não achava a linha e respondia 201 de um
  // criativo que não existe (revisão Codex do PR #82).
  if (criativo.status === 'pendente' && !criativo.arquivo_normalizado_url) {
    return res.status(409).json({ erro: 'esse criativo ainda está sendo processado — espere terminar pra excluir' });
  }
  await criativosRepo.deletar(req.params.criativoId);
  await avisarMudancaDePeca(req.session.anuncianteId, criativo.id);
  await removerArquivosDoStorage(criativo.id);
  res.json({ ok: true });
});

// Pausar / retomar a própria peça (finalização, 28/09/2026, pedido do
// dono). Pausar tira a peça aprovada da programação (status 'retirado',
// `retirado_por = 'cliente'`, migration 109) sem apagar nada; retomar
// devolve a aprovação — sem análise nova, o arquivo é o mesmo. Só volta
// pela mão do cliente o que o cliente pausou: o que o admin retirou, ou a
// substituição retirou, fica como está. Retomar respeita o limite de peças
// do plano como o upload respeita: ativa a mais do que o plano permite não
// entra (criativosRepo.contarNaoReprovados, pelos direitos combinados).
async function pecaDaConta(req, res) {
  const criativo = await criativosRepo.buscarPorId(req.params.id);
  if (!criativo || criativo.anunciante_id !== req.session.anuncianteId) {
    res.status(404).json({ erro: 'criativo não encontrado' });
    return null;
  }
  return criativo;
}

async function avisarMudancaDePeca(contaId, criativoId) {
  sse.emitirParaConta(contaId, 'creative.updated', { id: criativoId });
  sse.emitirParaAdmin('creative.updated', {});
  // Pausou a última peça (ou retomou): a campanha fica indisponível por
  // decisão do cliente — esse tempo não vira dívida (migration 111).
  await obrigacaoDoCiclo.avaliarDisponibilidadeSemFalhar(contaId);
}

router.post('/anunciantes/me/criativos/:id/pausar', exigirAnuncianteLogado, async (req, res) => {
  const criativo = await pecaDaConta(req, res);
  if (!criativo) return;
  if (criativo.status !== 'aprovado') return res.status(409).json({ erro: 'só uma peça aprovada pode ser pausada' });
  const { rowCount } = await pool.query(
    `UPDATE criativos SET status = 'retirado', retirado_por = 'cliente' WHERE id = $1 AND status = 'aprovado'`,
    [criativo.id],
  );
  if (!rowCount) return res.status(409).json({ erro: 'a peça mudou de situação — atualize a lista' });
  await avisarMudancaDePeca(req.session.anuncianteId, criativo.id);
  res.json({ ok: true });
});

router.post('/anunciantes/me/criativos/:id/retomar', exigirAnuncianteLogado, async (req, res) => {
  const criativo = await pecaDaConta(req, res);
  if (!criativo) return;
  if (criativo.status !== 'retirado' || criativo.retirado_por !== 'cliente') {
    return res.status(409).json({ erro: 'essa peça não foi pausada por você — fale com a gente pra colocá-la no ar' });
  }
  // Mesma régua do upload: os direitos somados do plano comercial e do
  // Básico do ponto (migration 103, #93) — conta só com o Básico também
  // retoma. Vagas ativas = contarNaoReprovados (pausada/retirada não conta).
  const conta = await repo.buscarPorId(req.session.anuncianteId);
  const { direitos } = await direitosDePeca(conta);
  if (!direitos) {
    return res.status(409).json({ erro: 'sua conta está sem plano — a peça volta quando você tiver um' });
  }
  if (
    Number.isFinite(direitos.limiteCriativos) &&
    (await criativosRepo.contarNaoReprovados(conta.id)) >= direitos.limiteCriativos
  ) {
    return res.status(409).json({
      erro: `seu plano permite até ${direitos.limiteCriativos} criativo(s) ativo(s) — pause ou exclua outra peça pra retomar esta`,
    });
  }
  const { rowCount } = await pool.query(
    `UPDATE criativos SET status = 'aprovado', retirado_por = NULL
      WHERE id = $1 AND status = 'retirado' AND retirado_por = 'cliente'`,
    [criativo.id],
  );
  if (!rowCount) return res.status(409).json({ erro: 'a peça mudou de situação — atualize a lista' });
  await avisarMudancaDePeca(req.session.anuncianteId, criativo.id);
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
// e come os acentos.
//
// Recorte: `?desde=AAAA-MM-DD` (painel do usuário, 29/09/2026) é o primeiro
// dia do período do gráfico, em Matão — o arquivo cobre exatamente o que a
// tela soma, de 00:00 desse dia até agora (com `dias`, a janela era "agora
// menos N×24 h" e pegava um pedaço do dia anterior ao que a tela mostra).
// Sem `desde` — ou com data que não existe, no futuro ou antes de 2020 —
// vale o `?dias=` de sempre (1 a 365, padrão 30).
function diaDoComprovante(texto) {
  const t = String(texto || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const dia = new Date(`${t}T00:00:00Z`);
  if (Number.isNaN(dia.getTime()) || dia.toISOString().slice(0, 10) !== t) return null;
  return t >= '2020-01-01' && t <= vigencia.hojeComercial() ? t : null;
}
router.get('/anunciantes/:id/exibicoes.csv', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode ver exibições da própria conta' });
  }
  const desde = diaDoComprovante(req.query.desde);
  const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);
  const recorte = desde
    ? `e.janela_hora >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')`
    : `e.janela_hora > now() - ($2 || ' days')::interval`;
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
     WHERE e.anunciante_id = $1 AND ${recorte}
     GROUP BY dia, p.nome, p.cidade, d.numero
     HAVING SUM(e.vezes_confirmadas) > 0
     ORDER BY dia DESC, p.nome`,
    [req.params.id, desde || dias],
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

  const arquivo = desde ? `mostrai-exibicoes-desde-${desde}.csv` : `mostrai-exibicoes-${dias}dias.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${arquivo}"`);
  res.send('\uFEFF' + linhas.join('\r\n') + '\r\n');
});

// "A propaganda está passando ou a TV está desligada?" pela MESMA régua do
// admin e do dono do ponto (src/lib/status-tela.js) — antes o painel tinha a
// sua (último sinal < 2h) e dizia "Online" para uma tela que o admin já
// mostrava sem sinal. Por ponto: no ar se alguma tela opera; fora do horário
// se nenhuma opera mas alguma está no horário de folga; SEM COMUNICAÇÃO se
// a tela deveria operar e só o heartbeat sumiu (conectividade não é
// operação: a TV pode estar exibindo o pacote offline — Ponto Móvel V1 §8;
// nunca dizer "fora do ar" sem prova); senão (reparo, inativa, não
// instalada, erro relatado pelo Player), fora do ar.
// O horário é o EM VIGOR, o mesmo da config da TV (ponto móvel: o da
// alocação em curso — src/lib/contexto-do-ponto.js).
// Só a conclusão sai daqui — nenhum dado da tela vai para o anunciante.
async function comSituacaoNoAr(pontos) {
  if (!pontos.length) return pontos;
  const { rows: telas } = await pool.query(
    `SELECT d.ponto_id, d.status, d.revogado_em, (d.chave_hash IS NOT NULL) AS chave_hash, d.primeiro_sinal_em,
            d.ultima_vez_online, d.player_estado, d.ultimo_erro_codigo, d.ultimo_erro,
            ${horarioEmVigorSql('p')} AS ponto_horario_semanal, ${inventarioSql('p')} AS inventario
       FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
      WHERE d.ponto_id = ANY($1::int[])`,
    [pontos.map((p) => p.id)],
  );
  const agora = new Date();
  return pontos.map((p) => {
    const doPonto = telas.filter((t) => t.ponto_id === p.id);
    const saudes = doPonto.map((t) => saudeDaTela(t, t.ponto_horario_semanal, agora));
    // Ponto móvel sem alocação (migration 114) nunca é "no ar": não está em
    // lugar nenhum e não veicula campanha.
    const situacao = doPonto.some((t) => !t.inventario)
      ? 'sem_alocacao'
      : saudes.includes('operando')
        ? 'no_ar'
        : saudes.includes('fora_do_horario')
          ? 'fora_do_horario'
          : saudes.includes('sem_sinal')
            ? 'sem_comunicacao'
            : 'fora_do_ar';
    // Nada da tela vai ao anunciante — nem o horário do último sinal.
    const { ultima_vez_online: _ultimoSinal, ...semSinal } = p;
    return { ...semSinal, situacao };
  });
}

router.get('/anunciantes/:id/exibicoes', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode ver exibições da própria conta' });
  }
  const anuncianteId = req.params.id;

  const [totais, porPonto, porDiaPonto, cobrancas, anunciante, confirmadasMesRows, janelaMesRows] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(vezes_programadas),0) AS programadas, COALESCE(SUM(vezes_confirmadas),0) AS confirmadas
       FROM exibicoes_contador WHERE anunciante_id = $1`,
      [anuncianteId],
    ),
    pool.query(
      // A situação do ponto vem de `comSituacaoNoAr` (régua única); o último
      // sinal da tela é diagnóstico do Admin e não vai para o anunciante.
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
    // Dia × ponto, o histórico inteiro (19/09/2026; é a fonte única do
    // gráfico do período desde o painel do usuário, 29/09/2026): o front
    // reagrupa em dia, semana ou mês conforme o filtro (7 dias a "Máx.")
    // sem pedir de novo, e empilha por cor de ponto. Mesmo corte de dia do
    // comprovante em CSV (acima): no fuso de Matão. Sem LIMIT de propósito —
    // "Máx." é desde o primeiro dia; o tamanho cresce com dias × pontos da
    // própria conta. (`porDia`, só o total do dia, saiu: ninguém lia.)
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
  // Duas origens (migration 103): as horas do plano comercial e as do Básico
  // de cada ponto ativo somam no total, e vão separadas pro painel mostrar de
  // onde vem cada parte. Tempo é a fonte: as exibições são derivadas.
  const basicosDaConta = await basicoRepo.ativosDaConta(anunciante.id);
  const origens = basicoRepo.direitosCombinados(plano, basicosDaConta);
  if (plano || basicosDaConta.length) {
    const duracaoMedia = await bancohorasRepo.duracaoMediaDoAnunciante(anuncianteId);
    horasContratadasMes = origens.horasPorMes;
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
    porDiaPonto: porDiaPonto.rows,
    cobrancas: cobrancas.rows,
    horasContratadasMes,
    horasPlanoMes: plano ? origens.horasPlano : null,
    horasBasicoMes: basicosDaConta.length ? origens.horasBasico : null,
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
  const problemaEndereco = problemaNoEndereco(req.body);
  if (problemaEndereco) return res.status(400).json(problemaEndereco);
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
    await emitirPrimeiroCodigo(anunciante);
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

  await sincronizarContaSemFalhar(anunciante.id, { por: `admin:${req.session?.adminUsuario || 'admin'}` });
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
    // `numero_confirmado` não é coluna: é o "está certo assim" do aviso de
    // Número suspeito (estação de endereços), lido à parte.
    const confirmouNumero = numeroConfirmado(req.body);
    const { numero_confirmado: _confirmado, ...corpo } = req.body || {};
    req.body = corpo;
    const recusados = Object.keys(req.body).filter((c) => !CAMPOS_ADMIN_EDITA.includes(c));
    if (recusados.length) {
      return res.status(400).json({ erro: `campo não editável por aqui: ${recusados.join(', ')}` });
    }
    const problemaEndereco = problemaNoEndereco(req.body);
    if (problemaEndereco) return res.status(400).json(problemaEndereco);
    const antes = await repo.buscarPorId(req.params.id);
    if (!antes) return res.status(404).json({ erro: 'anunciante não encontrado' });
    // Endereço mexido pelo Admin sai completo, como o do cliente (só o
    // complemento é opcional) — nunca meio endereço gravado.
    const partesEnviadas = PARTES_DO_ENDERECO.filter((p) => req.body[p] !== undefined);
    if (partesEnviadas.some((p) => String(req.body[p] ?? '').trim())) {
      const atual = Object.fromEntries([...PARTES_DO_ENDERECO, 'endereco'].map((p) => [p, antes[p] ?? null]));
      const falta = parteQueFalta({ ...atual, ...colunasDoEndereco(req.body, antes) });
      if (falta) return res.status(400).json({ erro: `endereço incompleto — preencha o campo ${falta}` });
    }

    // E-mail de login trocado pelo suporte (estação de e-mail, 27/09/2026).
    // Continua possível — é o caminho de quem perdeu o acesso ao endereço
    // antigo —, mas não mais silencioso: fica na trilha (alteracoes_email),
    // o endereço NOVO precisa ser confirmado por código (o suporte pode ter
    // digitado errado, ou atendido quem não era o dono), e o ANTIGO recebe o
    // aviso se já tinha sido confirmado.
    const emailNovo = req.body.contato_email !== undefined ? repo.normalizarEmail(req.body.contato_email) : null;
    const trocouEmail = emailNovo !== null && emailNovo !== repo.normalizarEmail(antes.contato_email);
    if (trocouEmail && !emailValido(emailNovo)) return res.status(400).json({ erro: 'e-mail inválido' });

    let anunciante;
    let alteracaoId = null;
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      anunciante = await repo.atualizar(
        req.params.id,
        trocouEmail && !antes.conta_propria ? { ...req.body, email_confirmado: false } : req.body,
        cliente,
      );
      if (trocouEmail) {
        const { rows } = await cliente.query(
          `INSERT INTO alteracoes_email (anunciante_id, email_anterior, email_novo, origem, admin_usuario)
           VALUES ($1, $2, $3, 'admin', $4) RETURNING id`,
          [antes.id, antes.contato_email, emailNovo, req.session?.adminUsuario || null],
        );
        alteracaoId = rows[0].id;
        await codigosEmail.descartar(antes.id, 'cadastro', cliente);
        await codigosEmail.descartar(antes.id, 'troca', cliente);
        await invalidarEnviosDoEmailAntigo(antes.id, cliente);
      }
      await cliente.query('COMMIT');
    } catch (err) {
      await cliente.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') return res.status(409).json({ erro: 'esse e-mail já é usado por outra conta' });
      throw err;
    } finally {
      cliente.release();
    }
    if (trocouEmail && !antes.conta_propria) {
      if (antes.email_confirmado) {
        await outbox.enfileirarSemFalhar({
          tipo: 'email_alterado',
          chave: `email_alterado:${alteracaoId}`,
          para: antes.contato_email,
          anuncianteId: antes.id,
          dados: {
            conta: { nome_empresa: antes.nome_empresa },
            emailNovoMascarado: outbox.mascararEmail(emailNovo),
            peloSuporte: true,
          },
        });
      }
      await emitirPrimeiroCodigo(anunciante);
      sse.emitirParaConta(antes.id, 'account.updated', { email_confirmado: false });
    }

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
      // E-mail que falha não pode desfazer a reativação — vai pela fila.
      await outbox.enfileirarSemFalhar({
        tipo: 'conta_reativada',
        chave: `conta_reativada:${anunciante.id}:${Date.now()}`,
        para: anunciante.contato_email,
        anuncianteId: anunciante.id,
        dados: { conta: { nome_empresa: anunciante.nome_empresa } },
      });
    }
    // Aviso em tempo real nas duas transições (Fase 3, SSE) — a conta
    // suspensa não pode descobrir só porque um botão parou de funcionar
    // (pedido original: "on reactivation, interface must update
    // automatically"). Símetrico: suspender também avisa.
    if (!!antes?.suspenso !== !!anunciante.suspenso) {
      await notificacoesRepo
        .registrar(anunciante.id, {
          tipo: anunciante.suspenso ? 'conta_suspensa' : 'conta_reativada',
          titulo: anunciante.suspenso ? 'Sua conta foi suspensa' : 'Sua conta foi reativada',
          descricao: anunciante.suspenso ? 'Fale com a gente pra entender o motivo.' : undefined,
        })
        .catch((err) => console.error('falha ao notificar suspensão/reativação', err.message));
      sse.emitirParaConta(anunciante.id, 'account.updated', { suspenso: anunciante.suspenso });
    }
    // Endereço da conta corrigido pelo Admin: a pendência do cliente se
    // reavalia (e some, se o Número ficou certo) e o painel aberto se refaz.
    if (PARTES_DO_ENDERECO.some((p) => req.body[p] !== undefined)) {
      await sincronizarContaSemFalhar(anunciante.id, {
        confirmado: confirmouNumero ? { alvo: 'conta', id: anunciante.id } : null,
        por: `admin:${req.session?.adminUsuario || 'admin'}`,
      });
      sse.emitirParaConta(anunciante.id, 'account.updated', {});
    }
    res.json(anunciante);
  } catch (err) {
    if (err.code === '23514') return res.status(400).json({ erro: 'status inválido' });
    throw err;
  }
});

module.exports = { router, exigirAnuncianteLogado, derrubarSessaoSuspensa, criativosComSituacao };
