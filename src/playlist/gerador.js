const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const {
  montarHoraDeTv,
  pontosDoAnunciante,
  dividirCota,
  duracaoValida,
  segundosCompensados,
  espalhar,
  ID_INSTITUCIONAL,
  DURACAO_INSTITUCIONAL,
} = require('../lib/pacing');
const eventos = require('../lib/eventos');
const { CRIATIVOS_POR_CONTA } = require('../lib/limites');
const bancoHorasRepo = require('../bancohoras/repository');
const pontosRepo = require('../pontos/repository');
const congelamentoRepo = require('./congelamento-repository');
const midiasRepo = require('../midias/repository');

// Quem chega no meio da hora (ponto escolhido agora, criativo aprovado
// agora) não disputa vaga com quem já estava programado — só pede a fatia
// que teria direito e entra em fila, sempre depois de tudo que já existe.
// Sem corte proporcional (RN-30 já rodou pra quem estava na hora desde o
// início): o pedido do dono foi "não precisa separar por hora, só bater a
// meta do mês", e o déficit de uma hora cheia demais se resolve sozinho na
// hora seguinte, como qualquer déficit.
function sequenciaAdicional(novosEntrada) {
  const pedidos = novosEntrada
    .map((n) => ({ id: n.id, quantidade: Math.max(0, (n.frequenciaBase || 0) + (n.deficit || 0)) }))
    .filter((p) => p.quantidade > 0);
  if (!pedidos.length) return [];
  const total = pedidos.reduce((soma, p) => soma + p.quantidade, 0);
  return espalhar(pedidos, total).filter((id) => id !== null);
}

// Quanto mais velha a dívida, mais peso ela ganha na hora — pedido do dono,
// 18/09/2026: "quanto mais tempo no banco tiver, mais prioridade tem". Escala
// de 1x (dívida deste mês: nunca mais que o próprio pedido da hora) até
// MULTIPLICADOR_MAXIMO_BANCO (dívida com IDADE_DE_PESO_MAXIMO_MESES ou mais)
// — números nossos, o dono não pediu nestes termos (docs/PENDENCIAS.md). Até
// 25/09/2026 a idade máxima era a da válvula de expiração; a válvula saiu
// (banco de horas não expira) e a escala ficou com o mesmo formato.
const MULTIPLICADOR_MAXIMO_BANCO = 3;
const IDADE_DE_PESO_MAXIMO_MESES = 3;

function multiplicadorPorIdade(idadeMeses) {
  const fracao = Math.min((idadeMeses || 0) / IDADE_DE_PESO_MAXIMO_MESES, 1);
  return 1 + fracao * (MULTIPLICADOR_MAXIMO_BANCO - 1);
}

// Playlist é por TELA (dispositivo), não por ponto — migration 019. A tela
// recebe do ponto a categoria (bloqueio de concorrente) e a cota de
// autoanúncio do dono, dividida entre as telas daquele ponto.

// Quantos criativos da conta entram na rotação.
//
// Conta própria não tem teto: o inventário é da casa, e limitar a si mesmo não
// protege ninguém. Quem paga plano fica no que o plano vende, e nunca acima do
// teto de `src/lib/limites.js`.
//
// Este corte continua aqui como ÚLTIMA defesa (plano antigo, ou alguém
// escrevendo no banco à mão), mas desde 17/09/2026 já não é a única: quem
// recusa é o repositório de planos, na gravação, com o motivo na mensagem. O
// corte silencioso no fim da linha vendia 5 e rodava 3 sem avisar ninguém.
function limiteDeCriativos(contaPropria, limitePlano, disponiveis) {
  if (contaPropria) return disponiveis;
  return Math.min(CRIATIVOS_POR_CONTA, Math.max(1, Number(limitePlano) || 1));
}

// "Elegível pra esta tela" é: conta ativa + criativo aprovado + dentro da
// validade + não ser do mesmo ramo do comércio onde a tela está + O PLANO
// COBRIR ESTE PONTO.
//
// A última condição é nova (17/09/2026). Até aqui todo plano cobria 100% da
// rede, então instalar uma tela aumentava custo e abria zero vaga. Agora o
// plano dá acesso a N pontos e o contratante escolhe quais — quem não
// escolhe recebe uma fatia estável, calculada em `pontosDoAnunciante`.
//
// A CONTA PRÓPRIA do Mostraí (migration 023) SAIU desta função (reorganização
// de Conteúdo, 22/09/2026) — cada peça institucional agora é uma "mídia
// própria" independente (`midias-proprias`), com a própria frequência e
// cobertura, não mais um valor único por conta. Ver `midiasElegiveis`
// abaixo, chamada à parte em `gerarPlaylistDaHora`.
// `anunciantes.frequencia_hora_propria`/`conta_propria` continuam existindo
// no banco (legado, sem uso novo) — só não alimentam mais a playlist por
// aqui.
async function anunciantesElegiveis(categoriaDoPonto, excluirContaId) {
  const { rows } = await pool.query(
    `
    SELECT a.id, a.conta_propria,
           p.frequencia_hora,
           p.segundos_por_hora, p.pontos_incluidos,
           p.limite_criativos,
           array_agg(c.arquivo_normalizado_url ORDER BY c.created_at DESC) AS urls,
           array_agg(c.duracao_segundos ORDER BY c.created_at DESC) AS duracoes,
           array_agg(c.id ORDER BY c.created_at DESC) AS criativo_ids,
           array_agg(c.conteudo_sha256 ORDER BY c.created_at DESC) AS hashes,
           COALESCE(
             (SELECT array_agg(ap.ponto_id ORDER BY ap.escolhido_em)
                FROM anunciantes_pontos ap WHERE ap.anunciante_id = a.id),
             ARRAY[]::int[]
           ) AS pontos_escolhidos
    FROM anunciantes a
    -- Só o plano COMERCIAL dentro da validade (Essencial/Pro/Prime — pago,
    -- benefício por créditos ou cortesia legada). Inicial/Básico deixaram de
    -- dar direito de veicular em 24/09/2026 (ADR-016): ser ponto gera
    -- créditos, não plano. comodato_plano_id fica no banco como legado.
    JOIN planos p ON p.id = a.plano_id
      AND ${vigencia.vigenteSql('a.data_expiracao')}
    -- arquivo_normalizado_url IS NOT NULL: peca aprovada com o arquivo ainda
    -- em processamento (ou cujo processamento morreu no meio) entrava na
    -- playlist como url nula e a TV ficava tocando vazio no lugar dela — e a
    -- exibicao era contada. criativosDoDono, logo abaixo, ja filtrava.
    JOIN criativos c ON c.anunciante_id = a.id AND c.status = 'aprovado'
      AND c.arquivo_normalizado_url IS NOT NULL
    WHERE NOT a.suspenso
      AND a.excluido_em IS NULL
      AND NOT a.conta_propria
      AND ($1::int IS NULL OR a.categoria_id IS NULL OR a.categoria_id <> $1)
      AND ($2::int IS NULL OR a.id <> $2)
    GROUP BY a.id, a.conta_propria, p.frequencia_hora, p.segundos_por_hora, p.pontos_incluidos, p.limite_criativos
  `,
    [categoriaDoPonto || null, excluirContaId || null],
  );

  return rows.map((r) => {
    const limite = limiteDeCriativos(r.conta_propria, r.limite_criativos, r.urls.length);
    return {
      ...r,
      criativos: r.urls.slice(0, limite).map((url, i) => ({
        url,
        duracaoSegundos: r.duracoes[i],
        criativoId: r.criativo_ids[i],
        contentHash: r.hashes[i],
      })),
    };
  });
}

// Mídias próprias elegíveis nesta tela, uma entrada de playlist por mídia
// (Parte 5/7 do pedido: cada mídia tem a própria frequência e cobertura,
// não é mais rateada entre pontos como a cobertura de plano — RN-49 e banco
// de horas não se aplicam aqui, os dois existem pra compensar/repartir
// cobertura entre pontos, e cada mídia já diz direto quantas vezes por
// hora, nos pontos que ela mesma escolheu).
async function midiasElegiveis(pontoId) {
  const rows = await midiasRepo.elegiveisNoPonto(pontoId);
  return rows.map((r) => ({
    id: `midia:${r.id}`,
    frequenciaBase: Number(r.frequencia_hora) || 0,
    deficit: 0,
    duracaoSegundos: r.duracao_segundos,
    criativos: [
      { url: r.url, duracaoSegundos: r.duracao_segundos, criativoId: r.criativo_id, contentHash: r.conteudo_sha256 },
    ],
  }));
}

// Cota de autoanúncio: os criativos aprovados da conta dona do ponto entram
// na tela dele sem plano e sem cobrança — é a contrapartida do comodato.
// A cota (slots/hora) é do ponto e é dividida entre as telas ativas dele.
async function criativosDoDono(contaId) {
  if (!contaId) return [];
  const { rows } = await pool.query(
    `SELECT id AS "criativoId", arquivo_normalizado_url AS url, duracao_segundos AS "duracaoSegundos",
            conteudo_sha256 AS "contentHash"
     FROM criativos WHERE anunciante_id = $1 AND status = 'aprovado' AND arquivo_normalizado_url IS NOT NULL
     ORDER BY created_at DESC LIMIT 3`,
    [contaId],
  );
  return rows;
}

// Os pontos que estão no ar agora. É a régua da cobertura: o plano dá acesso
// a N pontos, e "N de quantos" muda toda vez que um comércio novo entra.
// Quantas inserções aquele plano compra nesta hora, com a peça que a conta
// tem hoje. `segundos` já vem compensado pela cobertura (RN-49) — a decisão
// de quanto ele tem fica fora daqui, que é só a divisão.
function quantasInsercoes(conta, segundos, duracaoSegundos) {
  if (segundos > 0) return Math.floor(segundos / duracaoValida(duracaoSegundos));
  return Number(conta.frequencia_hora) || 0;
}

async function pontosEmOperacao() {
  const { rows } = await pool.query(`SELECT id FROM pontos WHERE status = 'em_operacao' ORDER BY id`);
  return rows.map((r) => r.id);
}

// Quem reveza entre peças de durações diferentes ocupa, ao longo da hora, a
// média delas. Média e não a primeira: a rotação passa por todas.
function duracaoMedia(criativos) {
  if (!criativos?.length) return undefined;
  const soma = criativos.reduce((t, c) => t + duracaoValida(c.duracaoSegundos), 0);
  return Math.round(soma / criativos.length);
}

// Só a entrega NORMAL da hora anterior que a TV não confirmou volta como
// déficit. A exibição do banco (`vezes_banco`, migration 090) que não rodou
// continua no saldo do banco — carregar ela aqui também a devolveria duas
// vezes. A confirmada conta primeiro pra entrega normal (mesma regra da
// liquidação, src/bancohoras/apuracao.js).
async function deficitHoraAnterior(dispositivoId, horaAnterior) {
  const { rows } = await pool.query(
    `SELECT anunciante_id, GREATEST(vezes_programadas - vezes_banco - vezes_confirmadas, 0) AS deficit
     FROM exibicoes_contador WHERE dispositivo_id = $1 AND janela_hora = $2`,
    [dispositivoId, horaAnterior],
  );
  const mapa = {};
  rows.forEach((r) => {
    mapa[r.anunciante_id] = Number(r.deficit);
  });
  return mapa;
}

// `pedidos` é o que cada anunciante QUERIA antes do corte (RN-30) — pode
// ter chave que não está em `contagem` (quem não coube em nada, `cabe=0`,
// e por isso nem aparece na entrega). `vezes_pedidas` some do banco de
// horas quem não pediu mais nada naquela hora (conta cancelada, criativo
// removido): sem pedido não há déficit a apurar. `banco` é quanto de
// `contagem` veio do banco de horas (entra em `vezes_programadas` — é o teto
// da confirmação — e separado em `vezes_banco`). `banco_liquidado_em` nunca é
// regravado aqui: a base da hora é congelada, então `vezes_banco` não muda
// entre as gerações da mesma hora.
async function gravarProgramados(dispositivo, horaAtual, contagem, pedidos = {}, banco = {}) {
  const anunciantes = new Set([...Object.keys(contagem), ...Object.keys(pedidos)]);
  await Promise.all(
    [...anunciantes].map((anuncianteId) => {
      const vezes = contagem[anuncianteId] || 0;
      const doBanco = banco[anuncianteId] || 0;
      const pedidas = pedidos[anuncianteId] ?? vezes - doBanco;
      return pool.query(
        `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas, vezes_banco)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (anunciante_id, dispositivo_id, janela_hora)
     DO UPDATE SET vezes_programadas = $4, vezes_pedidas = $5, vezes_banco = $6`,
        [anuncianteId, dispositivo.id, horaAtual, vezes, pedidas, doBanco],
      );
    }),
  );
}

// Vídeo institucional (25/09/2026): configuração ÚNICA pra rede inteira,
// gravada por `POST /admin/video-institucional` na MESMA `configuracoes_site`
// que já guarda a foto de exemplo do ponto (migration 055; `src/pontos/
// repository.js#definirConfiguracao`) — não é criativo (não tem
// `anunciante_id`, não é de ninguém pra aprovar) nem mídia própria
// (`midias_proprias`, que compete por frequência: este só preenche o que
// sobrou, igual ao cartão que substitui).
//
// Roda em TODA geração de playlist de TODA tela da rede — nunca pode
// derrubar isso por causa de um valor gravado errado à mão. `null` (nunca
// configurado, JSON quebrado, ou campos faltando) cai no cartão de sempre.
async function obterVideoInstitucional() {
  const bruto = await pontosRepo.obterConfiguracao('video_institucional');
  if (!bruto) return null;
  try {
    const { url, duracaoSegundos, contentHash } = JSON.parse(bruto);
    if (typeof url !== 'string' || !url) return null;
    if (!Number.isFinite(duracaoSegundos) || duracaoSegundos <= 0) return null;
    return { url, duracaoSegundos, contentHash: typeof contentHash === 'string' ? contentHash : null };
  } catch {
    return null;
  }
}

// `dispositivo` é o objeto de dispositivosRepo.buscarComPonto (já traz a
// categoria, o horário, a cota e o dono do ponto).
async function gerarPlaylistDaHora(dispositivo, hora) {
  const horaAtual = new Date(hora);
  horaAtual.setMinutes(0, 0, 0);
  const horaAnterior = new Date(horaAtual);
  horaAnterior.setHours(horaAnterior.getHours() - 1);

  // O DONO DO PONTO PASSA NA PRÓPRIA TELA (decisão do dono, 17/09/2026 —
  // fecha o item 28 de docs/PENDENCIAS.md).
  //
  // Ele era excluído da rotação paga da tela dele, e isso fazia sentido
  // enquanto a contrapartida do comodato era a COTA de autoanúncio: ele já
  // entrava por ali, e entrar duas vezes era aparecer em dobro. A cota acabou
  // na migration 049 — agora a contrapartida é um plano de verdade, e a
  // exclusão passou a fazer o contrário do que ela protegia: ele escolhia o
  // próprio ponto em `PUT /anunciantes/me/pontos`, a rota aceitava, e o
  // gerador tirava ele de lá. Gastava uma vaga de cobertura num lugar onde
  // nunca ia aparecer, sem aviso nenhum.
  //
  // E é justamente a tela DELE que vende o comodato: os clientes dele passam
  // ali. A exclusão só continua valendo enquanto a cota existir naquela tela,
  // que é o único caso em que a dobra é real.
  const cotaDaTela = dividirCota(dispositivo.cota_autoanuncio_slots_hora, dispositivo.telas_do_ponto);
  const excluirDaRotacaoPaga = cotaDaTela > 0 ? dispositivo.dono_conta_id : null;

  const [todos, deficits, doDono, pontosNoAr, saldosBanco, pontosBloqueados, midiasProprias, videoInstitucional] =
    await Promise.all([
      anunciantesElegiveis(dispositivo.categoria_id, excluirDaRotacaoPaga),
      deficitHoraAnterior(dispositivo.id, horaAnterior),
      criativosDoDono(dispositivo.dono_conta_id),
      pontosEmOperacao(),
      bancoHorasRepo.saldosAtivos(),
      pontosRepo.idsBloqueadosParaEscolha(),
      midiasElegiveis(dispositivo.ponto_id),
      obterVideoInstitucional(),
    ]);

  // Cobertura: fica quem tem ESTE ponto na fatia dele.
  //
  // A fatia é calculada UMA vez por conta e guardada: ela decide duas coisas
  // agora (se a conta entra nesta tela, e por quantos pontos o tempo dela se
  // divide na RN-49), e chamar duas vezes convida as duas a divergirem.
  //
  // `pontosBloqueados` (G.7) só entra na fatia de quem NÃO escolheu nada —
  // quem já escolheu um ponto bloqueado continua nele (`pontosDoAnunciante`
  // só filtra o sorteio automático, nunca a escolha explícita). Quem não
  // escolheu já é recalculado do zero a cada hora (não existe linha salva
  // pra essa conta em `anunciantes_pontos`), então aplicar o filtro aqui é
  // exatamente o que impede um anunciante NOVO, sem escolha própria ainda,
  // de cair de primeira num ponto que já parou de aceitar gente.
  const cobertura = new Map(
    todos.map((a) => [
      a.id,
      pontosDoAnunciante(
        { id: a.id, pontosIncluidos: a.pontos_incluidos, escolhidos: a.pontos_escolhidos },
        pontosNoAr,
        pontosBloqueados,
      ),
    ]),
  );
  const anunciantes = todos.filter((a) => cobertura.get(a.id).includes(dispositivo.ponto_id));
  const porId = Object.fromEntries(anunciantes.map((a) => [a.id, a]));

  // Frequência é por hora direto agora (migration 037) — sem conversão por
  // horário do ponto. O que o plano diz é o que roda, hora a hora.
  //
  // A duração entra junto porque a hora passou a ser orçada em SEGUNDOS
  // (src/lib/pacing.js): quem revezar entre peças de durações diferentes ocupa
  // a média delas, que é o que de fato acontece ao longo da hora.
  const entrada = anunciantes.map((a) => {
    const duracaoSegundos = duracaoMedia(a.criativos);
    // RN-49: enquanto a rede for menor que o plano, o tempo dos pontos que
    // faltam volta pros que veiculam.
    const segundos = segundosCompensados(a.segundos_por_hora, a.pontos_incluidos, cobertura.get(a.id).length);
    // O plano compra SEGUNDOS da hora; quantas inserções isso vira depende
    // da peça que o cliente subiu. Seis de 15s e três de 30s ocupam o mesmo
    // lugar, e é por isso que a duração deixou de ser eixo de inventário.
    //
    // `frequencia_hora * duração` é a ponte pra quem ainda não tem
    // `segundos_por_hora` preenchido: mantém o comportamento de antes até a
    // grade nova ser publicada, em vez de zerar a playlist de todo mundo.
    const frequenciaBase = quantasInsercoes(a, segundos, duracaoSegundos);
    // Banco de horas (G.3): quem tem saldo DISPONÍVEL (déficit de mês
    // anterior ainda não devolvido, menos o que outra hora já programou e
    // ainda não liquidou) pede exibições a mais — mas só no tempo que a hora
    // vendida deixou livre (`banco` em src/lib/pacing.js#montarHoraDeTv):
    // nunca tira a entrega corrente de ninguém. Capado no próprio pedido da
    // hora, crescendo com a idade da dívida (`multiplicadorPorIdade`).
    //
    // O saldo é da conta, não da tela — mas a playlist é gerada UMA TELA
    // por vez, e quem cobre vários pontos tem esta função rodando em
    // paralelo pra cada um, todas lendo o MESMO saldo ainda intacto. Sem
    // dividir, uma conta em 3 pontos puxaria o saldo inteiro 3 vezes na
    // mesma hora — a dívida "paga" triplicada, à custa de quem mais
    // partilha aquelas telas. Divide por `cobertura.get(a.id).length`, a
    // mesma fatia que a RN-49 já usa pra ratear segundos entre pontos —
    // ela existe pra resolver exatamente este problema, com outro número.
    // Arredonda pra cima: saldo menor que o número de pontos (2 exibições em
    // 3 pontos) nunca podia virar 0 pra sempre; a sobra é de no máximo uma
    // exibição por ponto, e a liquidação nunca abate mais que o saldo.
    //
    // O multiplicador de idade acelera o RITMO (teto por hora), nunca o
    // tamanho da dívida: até 25/09/2026 ele multiplicava também a fatia do
    // saldo, e 10 exibições devidas viravam 16 programadas.
    const bancoDaConta = saldosBanco[a.id];
    const multiplicadorBanco = bancoDaConta ? multiplicadorPorIdade(bancoDaConta.idadeMeses) : 1;
    const prioridadeBanco = Math.min(
      Math.ceil((bancoDaConta?.saldo || 0) / cobertura.get(a.id).length),
      Math.floor(frequenciaBase * multiplicadorBanco),
    );
    return {
      id: a.id,
      frequenciaBase,
      deficit: deficits[a.id] || 0,
      banco: prioridadeBanco,
      duracaoSegundos,
    };
  });

  // Mídia própria: cada uma já entra pronta (frequência e cobertura são
  // dela mesma, sem RN-49 nem banco de horas — ver `midiasElegiveis`).
  for (const m of midiasProprias) {
    porId[m.id] = { criativos: m.criativos };
    entrada.push({ id: m.id, frequenciaBase: m.frequenciaBase, deficit: 0, duracaoSegundos: m.duracaoSegundos });
  }

  // Dono do ponto entra com a fatia da cota que cabe a esta tela. Não conta
  // como anunciante pagante nem gera contador — é permuta, não venda. Zerada
  // nas duas opções de comodato desde a 049, então na prática este bloco só
  // roda se alguém repuser a cota à mão no admin.
  if (doDono.length && cotaDaTela > 0) {
    porId.dono = { criativos: doDono };
    entrada.push({ id: 'dono', frequenciaBase: cotaDaTela, deficit: 0, duracaoSegundos: duracaoMedia(doDono) });
  }

  // Semente = (aparelho, hora). A ordem da hora passa a ser a MESMA em
  // qualquer instância e depois de qualquer reinício, que é o que permite
  // rodar em mais de uma instância sem cache em memória (item 4).
  const semente = `${dispositivo.id}-${horaAtual.toISOString()}`;

  // A HORA CONGELA (19/09/2026, pedido do dono: escolher um ponto novo não
  // pode esperar "a próxima hora cheia" — tem que entrar na hora que já
  // está no ar, sem empurrar quem já tinha vaga). `montarHoraDeTv` reposiciona
  // TODO MUNDO quando o total de participantes muda (é assim que o
  // espalhamento fica justo no início da hora), então a única forma de uma
  // chegada no meio da hora não mexer em quem já tinha vaga é nunca mais
  // rodar `montarHoraDeTv` sobre a lista cheia depois da primeira vez.
  //
  // Por isso a `entrada` da primeira geração desta hora vira `base`
  // congelada (migration 064): toda geração seguinte reprocessa a MESMA
  // `base` pela mesma semente — determinístico, sempre a mesma sequência —
  // e quem não estava nela ainda entra em `extras`, sempre no fim.
  const congelada = await congelamentoRepo.resolver(dispositivo.id, horaAtual, entrada, (base, extras) => {
    const idsConhecidos = new Set([...base.map((e) => e.id), ...extras]);
    return sequenciaAdicional(entrada.filter((e) => !idsConhecidos.has(e.id)));
  });
  const daHora = montarHoraDeTv(congelada.base, semente, videoInstitucional?.duracaoSegundos ?? DURACAO_INSTITUCIONAL);
  const idsExtras = congelada.extras;

  // A hora não coube em todo mundo: todos entregam menos do que contrataram.
  // O corte é proporcional, mas continua sendo entrega menor, e sem isto não
  // haveria sinal nenhum em lugar nenhum. Vira evento da métrica, que é onde
  // o dono olha — e é também o aviso de que a rede está vendida e é hora de
  // subir preço ou abrir ponto novo.
  if (daHora.cortou) {
    eventos.registrar('playlist:teto_corta', {
      dispositivo_id: dispositivo.id,
      ponto_id: dispositivo.ponto_id,
      pedido_segundos: daHora.pedidoSegundos,
      cabe_segundos: daHora.cabeSegundos,
      anunciantes: entrada.length,
    });
  }

  // Quanto da hora está vendido. Registrado só quando a tela passa de 80%:
  // é o aviso antecipado do corte acima, com tempo de agir antes de alguém
  // receber menos do que comprou.
  if (!daHora.cortou && daHora.ocupacao >= 80) {
    eventos.registrar('playlist:hora_quase_cheia', {
      dispositivo_id: dispositivo.id,
      ponto_id: dispositivo.ponto_id,
      ocupacao: daHora.ocupacao,
    });
  }

  // `programados` já vem sem o institucional. O dono do ponto sai aqui: a cota
  // é permuta, não venda, e não entra no relatório de entrega de ninguém.
  // Mídia própria também sai — mesmo motivo (não é anunciante, não tem
  // `exibicoes_contador` pra creditar; `anunciante_id` daquela tabela é
  // int e não aceitaria a string `midia:N`). O filtro em `idsExtras`
  // (`id !== 'dono' && !String(id).startsWith('midia:')`) existe porque,
  // sem ele, um dos dois chegando no meio da hora (`extras`, quando a base
  // já congelou sem ele) voltava pro objeto pela soma logo abaixo.
  const contagem = { ...daHora.programados };
  delete contagem.dono;
  const pedidos = { ...daHora.pedidosPorAnunciante };
  delete pedidos.dono;
  for (const m of midiasProprias) {
    delete contagem[m.id];
    delete pedidos[m.id];
  }
  for (const id of idsExtras) {
    if (id === 'dono' || String(id).startsWith('midia:')) continue;
    contagem[id] = (contagem[id] || 0) + 1;
    pedidos[id] = (pedidos[id] || 0) + 1;
  }
  // Banco de horas: a hora só PROGRAMA (`vezes_banco`); o saldo é abatido
  // pela liquidação, com o que a TV confirmou, depois que a hora fecha
  // (src/bancohoras/apuracao.js#liquidarBancoConfirmado — job diário e
  // mensal). Até 25/09/2026 drenava aqui, no programado: TV desligada
  // consumia a dívida sem entregar nada.
  const banco = { ...daHora.bancoProgramados };
  await gravarProgramados(dispositivo, horaAtual, contagem, pedidos, banco);

  // Ponto de partida do revezamento gira por hora (19/09/2026, furo real
  // encontrado a partir de um relato do dono: "rodou só uma vez e não rodou
  // de novo"). Sem isto, `vez` sempre começava do zero A CADA HORA — pra
  // conta que só cabe 1 inserção por hora (plano pequeno, começo de conta),
  // `criativos[0]` (o mais novo, por causa do ORDER BY created_at DESC lá
  // em cima) ganhava a vaga TODA hora, pra sempre, e qualquer criativo mais
  // antigo nunca era escolhido — não porque a imagem tivesse alguma
  // limitação (imagem já virava vídeo de verdade, com duração real, muito
  // antes deste ponto), mas porque o revezamento reiniciava do mesmo lugar
  // toda hora. Girar o início pela hora garante que, ao longo de
  // `criativos.length` horas, todo criativo passa pela vaga pelo menos uma
  // vez, mesmo quando só cabe uma inserção por vez.
  const horaEpoch = Math.floor(horaAtual.getTime() / 3_600_000);
  const usados = {};
  // Identidade do item pro contrato novo (migration 065, app Android nativo
  // `sancompany/playlist.mostrai`): `janelaId` marca a hora congelada desta
  // tela, e `itemProgramacaoId` soma a POSIÇÃO na sequência congelada — antes
  // do `.filter(Boolean)` abaixo remover vagas que saíram de elegibilidade no
  // meio da hora, senão um buraco no meio deslocaria o índice de tudo que vem
  // depois a cada poll. O tipo/anunciante vai dentro do próprio id (formato
  // em docs/api.md) pra `/played` não precisar reconstruir a hora pra saber
  // quem creditar — só decodifica a string que ele mesmo devolveu.
  const janelaId = `${dispositivo.id}|${horaAtual.toISOString()}`;
  // `extras` sempre depois de `daHora.itens`: é o "sempre no fim" pedido —
  // quem chegou no meio da hora nunca disputa posição com quem já rodava.
  const itens = [...daHora.itens, ...idsExtras]
    .map((id, indice) => {
      // Inventário vago: sem vídeo institucional configurado, o player mostra
      // a própria peça institucional (#vazio em public/player.html) pelo tempo
      // do item — não tem url, não é de ninguém e não conta exibição. Com o
      // vídeo configurado (25/09/2026, `POST /admin/video-institucional`), o
      // Player V2 baixa e toca ele como qualquer mídia (`url`/`contentHash`);
      // o Player V1 IGNORA esses dois campos quando `institucional: true`
      // (public/player.page.js) e continua mostrando só o cartão — o vídeo
      // nunca é forçado num player antigo sem esse suporte.
      if (id === ID_INSTITUCIONAL) {
        return {
          itemProgramacaoId: `${janelaId}|${indice}|inst`,
          criativoId: null,
          anuncianteId: null,
          autoanuncio: false,
          institucional: true,
          contabiliza: false,
          url: videoInstitucional?.url ?? null,
          duracaoSegundos: videoInstitucional?.duracaoSegundos ?? DURACAO_INSTITUCIONAL,
          ...(videoInstitucional?.contentHash ? { contentHash: videoInstitucional.contentHash } : {}),
        };
      }
      // Congelou numa hora e saiu da elegibilidade depois (ponto desmarcado
      // de novo, criativo reprovado): a vaga dele só desaparece, não é
      // reaproveitada por ninguém — não é erro, é o fim natural de uma
      // escolha desfeita no meio da hora.
      const dados = porId[id];
      if (!dados?.criativos?.length) return null;
      const { criativos } = dados;
      const vez = usados[id] || 0;
      usados[id] = vez + 1;
      const inicio = horaEpoch % criativos.length;
      const criativo = criativos[(inicio + vez) % criativos.length];
      const autoanuncio = id === 'dono';
      // Mídia própria tem arquivo de verdade (ao contrário do item
      // institucional de preenchimento, `ID_INSTITUCIONAL` acima, que não
      // tem url nenhuma) — por isso `institucional: false` aqui: aquele
      // campo já tem um significado fixo no player (mostra o cartão
      // genérico "este espaço pode ser seu", nunca troca por vídeo real) e
      // reaproveitá-lo pra mídia própria trocaria o vídeo pelo cartão gená.
      // `anuncianteId: null` (mesmo mecanismo do autoanúncio) é o que faz o
      // player não mandar `/played` pra uma mídia que não é venda.
      const midiaPropria = typeof id === 'string' && id.startsWith('midia:');
      return {
        itemProgramacaoId: `${janelaId}|${indice}|${autoanuncio ? 'dono' : id}`,
        criativoId: criativo.criativoId != null ? String(criativo.criativoId) : null,
        anuncianteId: autoanuncio || midiaPropria ? null : id,
        autoanuncio,
        institucional: false,
        // Autoanúncio (permuta do comodato), institucional (preenchimento) e
        // mídia própria nunca contam — mesma regra que `parseLegado` do app
        // já infere hoje pro contrato antigo, só que explícita aqui em vez
        // de deduzida do outro lado.
        contabiliza: !autoanuncio && !midiaPropria,
        url: criativo.url,
        duracaoSegundos: criativo.duracaoSegundos,
        // SHA-256 do arquivo servido (contrato V2 §6.1): o Player guarda por
        // conteúdo e confere o download. Sem hash (criativo anterior à
        // migration 083, ou URL trocada à mão) o campo não vai, e o Player
        // cai no cache por criativoId (V1).
        ...(criativo.contentHash ? { contentHash: criativo.contentHash } : {}),
      };
    })
    .filter(Boolean);

  return {
    versaoContrato: 2,
    janelaId,
    janelaInicio: horaAtual.toISOString(),
    janelaFim: new Date(horaAtual.getTime() + 3_600_000).toISOString(),
    servidorAgora: new Date().toISOString(),
    itens,
  };
}

// Só confirma se havia programação pra esse anunciante nesta tela nesta
// hora — uma chave válida não pode inflar quem não estava na playlist.
// A FOLGA DA VIRADA DA HORA (regra do dono, esclarecida em 17/09/2026): "não
// pode passar de 1 hora, mas digamos que passe alguns minutos, aí sim pode
// deixar passar". A hora é um orçamento fechado de 3600s, mas a peça que
// começou às 13h59m50s termina depois das 14h — e o `played` dela chega numa
// hora que não é a dela. Sem a folga, essa exibição REAL era recusada e
// entrava como déficit, que a hora seguinte tentava repor: um atraso de
// segundos virava exibição a mais no dia seguinte.
const FOLGA_VIRADA_MIN = 15;

// As duas operações que tanto `confirmarExibicao` (contrato antigo, por
// anunciante+momento) quanto `confirmarExecucao` (contrato novo, por
// itemProgramacaoId já decodificado) precisam: creditar com teto, e saber se
// a linha existe (pra distinguir "já completou" de "nunca foi programado").
// `db` opcional (padrão `pool`): `execucoes-repository.js` passa o client de
// uma transação, pra creditar e reservar o `execucaoId` (dedup) atomicamente
// — sem isso, um crash bem no meio (entre creditar e gravar o ledger) credita
// sem deixar rastro de dedup, e a próxima retentativa credita nas de novo.
async function creditarConfirmacao(anuncianteId, dispositivoId, janela, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE exibicoes_contador SET vezes_confirmadas = vezes_confirmadas + 1
      WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3
        AND vezes_confirmadas < vezes_programadas`,
    [anuncianteId, dispositivoId, janela],
  );
  return rowCount > 0;
}

async function existeConfirmacao(anuncianteId, dispositivoId, janela, db = pool) {
  const { rows } = await db.query(
    `SELECT 1 FROM exibicoes_contador
      WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3`,
    [anuncianteId, dispositivoId, janela],
  );
  return rows.length > 0;
}

// Confirma uma exibição, com TETO. Era `vezes_confirmadas + 1` sem limite
// nenhum, e por isso qualquer reenvio da TV (queda de rede e retentativa,
// recarregar a página, player travar e reiniciar) contava a mesma exibição
// duas vezes. Não é o plano entregando a mais: é o COMPROVANTE ficando falso
// — e o comprovante é o que se entrega a quem pagou. O teto é
// `vezes_programadas`, que é exatamente o que aquela hora prometeu.
//
// Devolve `{ ok, motivo }` em vez de booleano porque os dois "não" são
// diferentes e o player precisa distinguir: `nao_programado` é pedido
// inválido (chave certa tentando confirmar anunciante que não está na hora);
// `ja_completo` é a própria TV reenviando, que é normal e não é erro.
async function confirmarExibicao(dispositivoId, anuncianteId, momento) {
  const horaAtual = new Date(momento);
  horaAtual.setMinutes(0, 0, 0);

  // Hora corrente primeiro: é o caso normal, e a folga é exceção.
  if (await creditarConfirmacao(anuncianteId, dispositivoId, horaAtual)) return { ok: true, janela: 'atual' };

  // Sobrou da hora anterior? Só nos primeiros minutos, e só se aquela hora
  // ainda tiver o que confirmar.
  const minutos = new Date(momento).getMinutes();
  if (minutos < FOLGA_VIRADA_MIN) {
    const anterior = new Date(horaAtual);
    anterior.setHours(anterior.getHours() - 1);
    if (await creditarConfirmacao(anuncianteId, dispositivoId, anterior)) return { ok: true, janela: 'anterior' };
  }

  if (await existeConfirmacao(anuncianteId, dispositivoId, horaAtual)) return { ok: false, motivo: 'ja_completo' };
  return { ok: false, motivo: 'nao_programado' };
}

// Decodifica um `itemProgramacaoId` do contrato novo (formato montado em
// `gerarPlaylistDaHora`: `dispositivoId|horaISO|indice|tipo`) e credita —
// sem reconstruir a hora congelada: o índice existe pra identidade estável
// entre polls (RN-09 do app), o `tipo` já traz quem creditar embutido, então
// não precisa reler `playlist_hora_congelada` pra saber a resposta.
//
// Devolve exatamente um dos status que `playlist.mostrai`
// (`FilaProofOfPlay.STATUS_DEFINITIVOS`) reconhece como definitivo — qualquer
// string fora dessa lista faz o app manter o item na fila e tentar de novo,
// então esta função nunca deve inventar um status novo sem atualizar os dois
// lados (ver docs/api.md).
async function confirmarExecucao(dispositivoIdEsperado, itemProgramacaoId, janelaId, agora, db = pool) {
  const partes = String(itemProgramacaoId || '').split('|');
  if (partes.length !== 4) return 'item_invalido';
  const [dispositivoIdStr, horaISO, indiceStr, tipo] = partes;
  if (Number(dispositivoIdStr) !== Number(dispositivoIdEsperado)) return 'janela_desconhecida';
  if (janelaId !== `${dispositivoIdStr}|${horaISO}`) return 'item_invalido';
  const horaJanela = new Date(horaISO);
  if (Number.isNaN(horaJanela.getTime()) || !/^\d+$/.test(indiceStr)) return 'item_invalido';

  const anuncianteId = Number(tipo);
  // `dono` (autoanúncio) e `inst` (institucional) nunca contam — o app já
  // filtra isso do próprio lado (`FilaProofOfPlay.registrarInicio` não cria
  // execução pra item com `contabiliza=false`), então chegar aqui com um
  // desses é o app tentando confirmar algo que não devia existir.
  // Teto do int4: um número maior passava daqui e estourava na query (500
  // eterno para um evento que nunca vai ser válido).
  if (!Number.isInteger(anuncianteId) || anuncianteId <= 0 || anuncianteId > 2147483647) return 'item_invalido';

  // Mesma folga da virada de hora do contrato antigo — a peça pode terminar
  // minutos depois da hora virar, e o `janelaId` já diz exatamente qual hora
  // era a dela (não precisa adivinhar pela hora "agora").
  const diffMin = (new Date(agora).getTime() - horaJanela.getTime()) / 60_000;
  if (diffMin < -1 || diffMin > 60 + FOLGA_VIRADA_MIN) return 'janela_expirada';

  if (await creditarConfirmacao(anuncianteId, dispositivoIdEsperado, horaJanela, db)) return 'contabilizado';
  if (await existeConfirmacao(anuncianteId, dispositivoIdEsperado, horaJanela, db)) return 'teto_atingido';
  return 'janela_desconhecida';
}

module.exports = {
  gerarPlaylistDaHora,
  confirmarExibicao,
  confirmarExecucao,
  limiteDeCriativos,
  FOLGA_VIRADA_MIN,
};
