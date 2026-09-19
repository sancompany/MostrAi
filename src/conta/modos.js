// Modos da conta (painel único: anúncios / meu ponto / vendas).
//
// Uma conta tem os três modos no painel; só os papéis que ela tem estão
// liberados. Aqui mora tudo que liga um modo numa conta que já existe:
//   - anunciante: a própria pessoa ativa (só precisa do endereço comercial);
//   - ponto e vendedor: a pessoa pede de dentro do painel (candidatura com
//     conta_id) e o dono libera no admin — ou manda um convite que a conta
//     logada aceita. Nunca se libera sozinho (CONSTRAINTS.md).
// E os dois módulos cruzados de plano (migration 020): tela ganha por tempo
// de plano de anunciante, e plano de anúncio ganho por tempo como ponto.
const express = require('express');
const pool = require('../db/pool');
const anunciantesRepo = require('../anunciantes/repository');
const vendedoresRepo = require('../financeiro/vendedores-repository');
const candidaturasRepo = require('../candidaturas/repository');
const pontosRepo = require('../pontos/repository');
const dispositivosRepo = require('../dispositivos/repository');
const planosPontoRepo = require('../pontos/planos-ponto-repository');
const planosRepo = require('../financeiro/planos-repository');
const indicacoesRepo = require('../indicacoes/repository');
const categoriasRepo = require('../categorias/repository');
const convitesRepo = require('../convites/repository');
const { enviarCandidaturaNova } = require('../financeiro/email');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');

const router = express.Router();

async function adicionarPapel(contaId, papel, db = pool) {
  await db.query(`UPDATE anunciantes SET papeis = array_append(papeis, $2) WHERE id = $1 AND NOT ($2 = ANY(papeis))`, [
    contaId,
    papel,
  ]);
}

// Liga um papel numa conta existente a partir de uma candidatura aprovada
// (admin "liberar na conta" ou convite aceito por conta logada). Cria o que
// o papel precisa: perfil de vendedor, ponto + Tela 1.
async function liberarPapelNaConta(conta, papel, cand, db) {
  await adicionarPapel(conta.id, papel, db);
  if (papel === 'vendedor' && !(await vendedoresRepo.buscarPorConta(conta.id))) {
    await vendedoresRepo.criar(conta.id, { chave_pix: cand?.chave_pix || null, nome: conta.nome_empresa }, db);
  }
  if (papel === 'ponto' && cand && cand.tipo === 'ponto') {
    const opcao = cand.plano_ponto_id ? await planosPontoRepo.buscarPorId(cand.plano_ponto_id) : null;
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
        status: 'a_instalar',
        aceitou_termos_em: new Date(),
      },
      db,
    );
    await dispositivosRepo.criar(ponto.id, { apelido: 'Tela 1' }, db);

    // Cupom de indicação do ponto (migration 062, pedido do dono,
    // 19/09/2026): toda conta de ponto ganha um, na mesma transação que cria
    // o ponto — mesmo raciocínio do comodato logo abaixo, o benefício nasce
    // junto com o papel, não numa rotina à parte. Guarda de existência
    // (como vendedoresRepo.buscarPorConta acima) porque um dono pode ceder
    // mais de um ponto: o cupom é por CONTA, não por ponto.
    if (!(await indicacoesRepo.buscarCupomPorConta(conta.id, db))) {
      await indicacoesRepo.criarCupom(conta.id, conta.nome_empresa, db);
    }

    // A CONTRAPARTIDA DO COMODATO (migration 049, desenho do dono de
    // 17/09/2026). Quem cede a parede escolhe uma das duas opções, e as duas
    // dão tela: a opção "Recebe os R$ 50" traz o plano básico junto, e a
    // "Troca os R$ 50 por tela" traz o Essencial inteiro mais um crédito de
    // R$ 50 pra quem depois quiser subir pro Destaque ou pro Máximo.
    //
    // O plano entra AQUI, na mesma transação que cria o ponto, e não numa
    // rotina à parte: comodato assinado e contrapartida concedida têm que ser
    // o mesmo ato, senão existe um intervalo em que ele cedeu a parede e não
    // recebeu nada — e é justo nesse intervalo que alguém abre um chamado.
    //
    // NÃO sobrescreve plano que a conta já tenha: o dono de ponto que já era
    // cliente pagante continua no plano que paga. Dar o plano de comodato por
    // cima apagaria uma assinatura ativa.
    // Entra como CORTESIA, e sem `data_expiracao`: ele não paga nada por
    // nenhuma das duas opções, e o plano vale enquanto o comodato valer.
    // Sem a marca de cortesia, a receita e a margem do admin contariam um
    // Essencial de R$ 99 que ninguém pagou. Sem `data_expiracao` nula, ele
    // receberia o e-mail de "sua cobertura está acabando" (RN-36) por uma
    // cobertura que não tem prazo — e o gerador já trata nulo como válido pra
    // sempre.
    //
    // `aplicarCicloPago` limpa cortesia e motivo quando ele decide pagar o
    // Destaque ou o Máximo, então o plano pago não fica invisível na margem.
    if (opcao?.plano_incluido_id && !conta.plano_id) {
      await db.query(
        `UPDATE anunciantes
            SET plano_id = $2,
                data_inicio_cobertura = COALESCE(data_inicio_cobertura, now()),
                plano_cortesia = true,
                cortesia_motivo = 'comodato'
          WHERE id = $1 AND plano_id IS NULL`,
        [conta.id, opcao.plano_incluido_id],
      );
    }
    // O crédito NÃO acumula por ponto: dono de três pontos tem crédito de
    // R$ 50, não de R$ 150 (a razão está no cabeçalho da migration 049).
    if (Number(opcao?.desconto_assinatura_reais) > 0) {
      await db.query(
        'UPDATE anunciantes SET credito_comodato_mensal = GREATEST(credito_comodato_mensal, $2) WHERE id = $1',
        [conta.id, Number(opcao.desconto_assinatura_reais)],
      );
    }
  }
}

async function emTransacao(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const r = await fn(cliente);
    await cliente.query('COMMIT');
    return r;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

// ---------------------------------------------------------------------------
// O que o painel precisa pra desenhar os três modos: papéis, pedidos em
// aberto, e o estado dos bônus de plano.
// ---------------------------------------------------------------------------
router.get('/conta/modos', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  const papeis = conta.papeis || ['anunciante'];
  const { rows: pedidos } = await pool.query(
    `SELECT tipo, status, criado_em, origem FROM candidaturas
     WHERE conta_id = $1 AND status IN ('nova', 'em_contato') ORDER BY criado_em DESC`,
    [conta.id],
  );
  res.json({
    papeis,
    modos: {
      anunciante: {
        liberado: papeis.includes('anunciante'),
        precisaEndereco: !(conta.endereco && conta.cidade && conta.uf && conta.cep),
      },
      ponto: { liberado: papeis.includes('ponto'), pedido: pedidos.find((p) => p.tipo === 'ponto') || null },
      vendedor: { liberado: papeis.includes('vendedor'), pedido: pedidos.find((p) => p.tipo === 'vendedor') || null },
    },
    bonus: {
      // `ponto` continua na resposta como null: o painel lê `bonus.ponto` e
      // tirar a chave quebraria a tela de quem estiver com a página aberta.
      ponto: null,
      anuncio: await bonusAnuncioDaConta(conta),
    },
  });
});

// Modo anunciante: a própria conta ativa. Só exige o endereço comercial (a
// nota fiscal e o checkout precisam dele); o status de aprovação já veio do
// convite que criou a conta.
router.post('/conta/modos/anunciante', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  const { endereco, cidade, uf, cep, categoria_id, categoria_livre } = req.body;
  const dados = {
    endereco: endereco || conta.endereco,
    cidade: cidade || conta.cidade,
    uf: uf || conta.uf,
    cep: cep || conta.cep,
  };
  if (!dados.endereco || !dados.cidade || !dados.uf || !dados.cep) {
    return res.status(400).json({ erro: 'endereço completo da empresa é obrigatório pra anunciar' });
  }
  // O ramo não é enfeite de cadastro: é ele que o gerador da playlist usa pra
  // não pôr o anúncio dentro de um concorrente direto (src/playlist/gerador.js,
  // `a.categoria_id IS NULL OR a.categoria_id <> $1`). Sem ramo, a conta é
  // elegível pra TODO ponto — inclusive o do lado, do mesmo ramo. O cadastro
  // aberto já exige; por dentro do painel não exigia.
  if (!(categoria_id || categoria_livre || conta.categoria_id || conta.categoria_livre)) {
    return res
      .status(400)
      .json({ erro: 'diga o ramo do seu negócio — é ele que impede o seu anúncio de rodar dentro de um concorrente' });
  }
  if (categoria_id && !(await categoriasRepo.buscarAtivaPorId(categoria_id))) {
    return res.status(400).json({ erro: 'ramo inválido' });
  }
  await pool.query(
    `UPDATE anunciantes SET endereco = $2, cidade = $3, uf = $4, cep = $5,
       categoria_id = COALESCE($6, categoria_id), categoria_livre = COALESCE($7, categoria_livre),
       papeis = CASE WHEN 'anunciante' = ANY(papeis) THEN papeis ELSE array_append(papeis, 'anunciante') END
     WHERE id = $1`,
    [conta.id, dados.endereco, dados.cidade, dados.uf, dados.cep, categoria_id || null, categoria_livre || null],
  );
  res.json(await anunciantesRepo.buscarPorId(conta.id));
});

// Modo ponto: pedido de dentro do painel. Vira candidatura com conta_id; o
// dono libera no admin (ou gera convite, que a conta aceita). Vendedor não
// pede mais assim (18/09/2026, a pedido do dono) — quem quer ser vendedor
// fala direto com a gente; quem entra, entra por convite que o dono gera à
// mão depois da conversa, nunca por pedido self-service.
router.post('/conta/modos/:papel/pedir', exigirAnuncianteLogado, async (req, res) => {
  const papel = req.params.papel;
  if (papel !== 'ponto') return res.status(400).json({ erro: 'modo inválido' });
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  if ((conta.papeis || []).includes(papel))
    return res.status(409).json({ erro: 'esse modo já está liberado na sua conta' });
  const { rows: abertos } = await pool.query(
    `SELECT id FROM candidaturas WHERE conta_id = $1 AND tipo = $2 AND status IN ('nova', 'em_contato')`,
    [conta.id, papel],
  );
  if (abertos.length)
    return res.status(409).json({ erro: 'você já tem um pedido em análise — a gente chama no WhatsApp' });
  if (!req.body.nome_comercio || !req.body.endereco) {
    return res.status(400).json({ erro: 'nome do comércio e endereço são obrigatórios' });
  }
  if (req.body.plano_ponto_id && !(await planosPontoRepo.buscarPorId(req.body.plano_ponto_id))) {
    return res.status(400).json({ erro: 'opção de comodato inválida' });
  }
  const cand = await candidaturasRepo.criar({
    ...req.body,
    tipo: papel,
    nome: conta.responsavel_nome || conta.nome_empresa,
    contato_telefone: req.body.contato_telefone || conta.contato_telefone,
    contato_email: conta.contato_email,
    conta_id: conta.id,
    origem: 'painel',
  });
  // Fire-and-forget: mesmo aviso que o formulário público mandava antes de
  // ser aposentado — sem ele, o pedido só aparece pra quem abrir o admin
  // por acaso (a fila "Candidaturas" ainda avisa, mas o e-mail chega antes).
  enviarCandidaturaNova(cand).catch((err) => console.error('e-mail de candidatura nova', err));
  res.status(201).json({ ok: true, id: cand.id });
});

// Convite aberto por quem já tem conta: os papéis entram nesta conta em vez
// de nascer uma conta nova. Vendedor precisa da chave Pix; ponto vindo de
// candidatura cria o ponto + Tela 1.
router.post('/convites/:token/aceitar', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  const convite = await convitesRepo.buscarValido(req.params.token);
  if (!convite) return res.status(404).json({ erro: 'convite inválido, usado ou expirado — fale com quem te enviou' });
  const novos = (convite.papeis || []).filter((p) => !(conta.papeis || []).includes(p));
  if (!novos.length) return res.status(409).json({ erro: 'sua conta já tem tudo que esse convite libera' });
  if (novos.includes('vendedor') && !req.body.chave_pix)
    return res.status(400).json({ erro: 'chave Pix é obrigatória pra receber comissão' });

  try {
    await emTransacao(async (cliente) => {
      const consumido = await convitesRepo.consumir(req.params.token, conta.id, cliente);
      if (!consumido) throw Object.assign(new Error('esse convite acabou de ser usado'), { status: 409 });
      const cand = convite.candidatura_id ? await candidaturasRepo.buscarPorId(convite.candidatura_id) : null;
      for (const papel of novos) {
        const dadosPapel = papel === 'vendedor' ? { ...(cand || {}), chave_pix: req.body.chave_pix } : cand;
        await liberarPapelNaConta(conta, papel, dadosPapel, cliente);
      }
      // Convite de ponto sem candidatura: o endereço entra depois em "Meu ponto".
      if (cand) await cliente.query(`UPDATE candidaturas SET conta_id = $2 WHERE id = $1`, [cand.id, conta.id]);
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  }
  res.json(await anunciantesRepo.buscarPorId(conta.id));
});

// Admin: libera o papel direto na conta que pediu (candidatura com conta_id).
router.post('/admin/candidaturas/:id/liberar', async (req, res) => {
  const cand = await candidaturasRepo.buscarPorId(req.params.id);
  if (!cand) return res.status(404).json({ erro: 'candidatura não encontrada' });
  if (!cand.conta_id)
    return res.status(400).json({ erro: 'essa candidatura não é de uma conta existente — gere um convite' });
  if (cand.status === 'aprovada') return res.status(409).json({ erro: 'já liberada' });
  const conta = await anunciantesRepo.buscarPorId(cand.conta_id);
  if (!conta || conta.excluido_em) return res.status(400).json({ erro: 'conta não encontrada ou excluída' });
  await emTransacao(async (cliente) => {
    await liberarPapelNaConta(conta, cand.tipo, cand, cliente);
    await cliente.query(`UPDATE candidaturas SET status = 'aprovada' WHERE id = $1`, [cand.id]);
  });
  res.json({ ok: true, conta: await anunciantesRepo.buscarPorId(conta.id) });
});

// Vendedor completa/troca a própria chave Pix (liberado pelo painel pode
// ter entrado sem ela).
router.patch('/vendedor/me', exigirAnuncianteLogado, async (req, res) => {
  const v = await vendedoresRepo.buscarPorConta(req.session.anuncianteId);
  if (!v) return res.status(403).json({ erro: 'esta conta não é de vendedor' });
  if (!req.body.chave_pix) return res.status(400).json({ erro: 'chave Pix obrigatória' });
  res.json(await vendedoresRepo.atualizar(req.session.anuncianteId, { chave_pix: String(req.body.chave_pix).trim() }));
});

// ---------------------------------------------------------------------------
// Módulo 1 — REMOVIDO em 17/09/2026, a pedido do dono.
// ---------------------------------------------------------------------------
// Era o bônus "ganhe uma tela no seu comércio ao completar N meses de plano"
// (`planos.ponto_apos_meses` + `anunciantes.ponto_bonus_resgatado_em`). Saiu
// junto com a grade nova: o dono decidiu que o degrau de cima se vende por
// pontos, tempo de tela e duração da peça, e não por um brinde de longo prazo
// que ninguém tinha ligado em plano nenhum.
//
// O módulo 2 (o inverso: dono de ponto ganha plano de anúncio pelo tempo de
// comodato) CONTINUA — é a contrapartida do comodato, não um brinde. Por isso
// `mesesEntre` fica: era do módulo 1, mas quem conta o tempo de casa do ponto
// também precisa dela.
function mesesEntre(inicio, fim) {
  const a = new Date(inicio);
  const b = new Date(fim);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Módulo 2 — opção de comodato com plano de anúncio grátis por tempo de casa
// (planos_ponto.plano_bonus_*). Resgate ativa o plano na conta do dono.
// ---------------------------------------------------------------------------
async function bonusAnuncioDaConta(conta) {
  if (!(conta.papeis || []).includes('ponto')) return null;
  const { rows } = await pool.query(
    `SELECT pp.plano_bonus_id, pp.plano_bonus_apos_meses, pp.plano_bonus_meses, pp.nome AS opcao_nome,
            MIN(COALESCE(d.instalado_em, p.created_at::date)) AS desde
     FROM pontos p JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
     JOIN dispositivos d ON d.ponto_id = p.id AND d.status = 'ativo'
     WHERE p.anunciante_id = $1 AND p.status = 'em_operacao' AND pp.plano_bonus_id IS NOT NULL
     GROUP BY pp.id ORDER BY pp.plano_bonus_apos_meses LIMIT 1`,
    [conta.id],
  );
  const b = rows[0];
  if (!b) return null;
  const meses = b.desde ? Math.max(0, mesesEntre(b.desde, new Date())) : 0;
  const plano = await planosRepo.buscarPorId(b.plano_bonus_id);
  return {
    opcao: b.opcao_nome,
    plano_nome: plano ? plano.nome : b.plano_bonus_id,
    plano_id: b.plano_bonus_id,
    apos_meses: b.plano_bonus_apos_meses,
    meses_ativo: meses,
    meses_gratis: b.plano_bonus_meses,
    disponivel: meses >= b.plano_bonus_apos_meses && !conta.anuncio_bonus_resgatado_em,
    resgatado_em: conta.anuncio_bonus_resgatado_em,
  };
}

router.post('/conta/bonus/anuncio/resgatar', exigirAnuncianteLogado, async (req, res) => {
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  const bonus = conta && (await bonusAnuncioDaConta(conta));
  if (!bonus?.disponivel) return res.status(400).json({ erro: 'esse bônus não está disponível pra sua conta' });
  if (conta.suspenso || conta.excluido_em)
    return res.status(403).json({ erro: 'conta indisponível — fale com o suporte' });
  if (conta.plano_id && conta.data_expiracao && new Date(conta.data_expiracao) > new Date()) {
    return res
      .status(409)
      .json({ erro: 'você já tem um plano ativo — o bônus pode ser resgatado quando ele terminar' });
  }
  await emTransacao(async (cliente) => {
    await adicionarPapel(conta.id, 'anunciante', cliente);
    await cliente.query(
      // plano_cortesia: o bônus é anúncio de graça por ser ponto, não venda.
      // Sem isso a conta entrava na receita recorrente do resumo como cliente
      // pagante e inflava a margem — o caminho equivalente do admin
      // (liberar-plano) já gravava cortesia.
      `UPDATE anunciantes
       SET plano_id = $2, suspenso = false,
           plano_cortesia = true, cortesia_motivo = 'bônus de ponto',
           data_inicio_cobertura = COALESCE(data_inicio_cobertura, now()),
           data_expiracao = now() + ($3 || ' months')::interval,
           anuncio_bonus_resgatado_em = now()
       WHERE id = $1 AND anuncio_bonus_resgatado_em IS NULL`,
      [conta.id, bonus.plano_id, bonus.meses_gratis],
    );
  });
  res.json(await anunciantesRepo.buscarPorId(conta.id));
});

module.exports = { router, adicionarPapel, liberarPapelNaConta };
