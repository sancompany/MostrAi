const pool = require('../db/pool');
const {
  montarHoraDeTv,
  pontosDoAnunciante,
  dividirCota,
  duracaoValida,
  segundosCompensados,
  ID_INSTITUCIONAL,
  DURACAO_INSTITUCIONAL,
} = require('../lib/pacing');
const eventos = require('../lib/eventos');
const { CRIATIVOS_POR_CONTA } = require('../lib/limites');
const bancoHorasRepo = require('../bancohoras/repository');
const { MESES_PARA_FILA_DE_CREDITO } = require('../bancohoras/apuracao');

// Quanto mais perto a dívida chega da válvula (MESES_PARA_FILA_DE_CREDITO),
// mais peso ela ganha na hora — pedido do dono, 18/09/2026: "quanto mais
// tempo no banco tiver, mais prioridade tem", pra tentar drenar sozinha
// antes de precisar virar decisão do admin. Escala de 1x (dívida deste mês,
// mesmo teto de sempre: nunca mais que dobrar o pedido) até
// MULTIPLICADOR_MAXIMO_BANCO (dívida na borda da válvula) — número meu, o
// dono não pediu nestes termos, documentado como tal em docs/PENDENCIAS.md.
const MULTIPLICADOR_MAXIMO_BANCO = 3;

function multiplicadorPorIdade(idadeMeses) {
  const fracao = Math.min((idadeMeses || 0) / MESES_PARA_FILA_DE_CREDITO, 1);
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
// O LEFT JOIN em `planos` existe por causa da CONTA PRÓPRIA do Mostraí
// (migration 023), que anuncia a rede sem assinar plano. O guarda no WHERE é
// o que impede o efeito colateral óbvio de trocar JOIN por LEFT JOIN: conta
// ativa e sem plano nenhum entrando na playlist de graça. Ou tem plano, ou é
// própria com frequência definida — não existe terceiro caso.
async function anunciantesElegiveis(categoriaDoPonto, excluirContaId) {
  const { rows } = await pool.query(
    `
    SELECT a.id, a.conta_propria,
           COALESCE(p.frequencia_hora, a.frequencia_hora_propria) AS frequencia_hora,
           p.segundos_por_hora, p.pontos_incluidos,
           p.limite_criativos,
           array_agg(c.arquivo_normalizado_url ORDER BY c.created_at DESC) AS urls,
           array_agg(c.duracao_segundos ORDER BY c.created_at DESC) AS duracoes,
           COALESCE(
             (SELECT array_agg(ap.ponto_id ORDER BY ap.escolhido_em)
                FROM anunciantes_pontos ap WHERE ap.anunciante_id = a.id),
             ARRAY[]::int[]
           ) AS pontos_escolhidos
    FROM anunciantes a
    LEFT JOIN planos p ON p.id = a.plano_id
    -- arquivo_normalizado_url IS NOT NULL: peca aprovada com o arquivo ainda
    -- em processamento (ou cujo processamento morreu no meio) entrava na
    -- playlist como url nula e a TV ficava tocando vazio no lugar dela — e a
    -- exibicao era contada. criativosDoDono, logo abaixo, ja filtrava.
    JOIN criativos c ON c.anunciante_id = a.id AND c.status = 'aprovado'
      AND c.arquivo_normalizado_url IS NOT NULL
    WHERE NOT a.suspenso
      AND a.excluido_em IS NULL
      AND (
        (a.conta_propria AND COALESCE(a.frequencia_hora_propria, 0) > 0)
        OR (NOT a.conta_propria AND p.id IS NOT NULL)
      )
      AND (a.data_expiracao IS NULL OR a.data_expiracao >= now())
      AND ($1::int IS NULL OR a.categoria_id IS NULL OR a.categoria_id <> $1)
      AND ($2::int IS NULL OR a.id <> $2)
    GROUP BY a.id, a.conta_propria, p.frequencia_hora, p.segundos_por_hora, p.pontos_incluidos,
             a.frequencia_hora_propria, p.limite_criativos
  `,
    [categoriaDoPonto || null, excluirContaId || null],
  );

  return rows.map((r) => {
    const limite = limiteDeCriativos(r.conta_propria, r.limite_criativos, r.urls.length);
    return { ...r, criativos: r.urls.slice(0, limite).map((url, i) => ({ url, duracaoSegundos: r.duracoes[i] })) };
  });
}

// Cota de autoanúncio: os criativos aprovados da conta dona do ponto entram
// na tela dele sem plano e sem cobrança — é a contrapartida do comodato.
// A cota (slots/hora) é do ponto e é dividida entre as telas ativas dele.
async function criativosDoDono(contaId) {
  if (!contaId) return [];
  const { rows } = await pool.query(
    `SELECT arquivo_normalizado_url AS url, duracao_segundos AS "duracaoSegundos"
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

async function deficitHoraAnterior(dispositivoId, horaAnterior) {
  const { rows } = await pool.query(
    `SELECT anunciante_id, GREATEST(vezes_programadas - vezes_confirmadas, 0) AS deficit
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
// removido): sem pedido não há déficit a apurar.
async function gravarProgramados(dispositivo, horaAtual, contagem, pedidos = {}) {
  const anunciantes = new Set([...Object.keys(contagem), ...Object.keys(pedidos)]);
  await Promise.all(
    [...anunciantes].map((anuncianteId) => {
      const vezes = contagem[anuncianteId] || 0;
      const pedidas = pedidos[anuncianteId] ?? vezes;
      return pool.query(
        `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (anunciante_id, dispositivo_id, janela_hora)
     DO UPDATE SET vezes_programadas = $4, vezes_pedidas = $5`,
        [anuncianteId, dispositivo.id, horaAtual, vezes, pedidas],
      );
    }),
  );
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

  const [todos, deficits, doDono, pontosNoAr, saldosBanco] = await Promise.all([
    anunciantesElegiveis(dispositivo.categoria_id, excluirDaRotacaoPaga),
    deficitHoraAnterior(dispositivo.id, horaAnterior),
    criativosDoDono(dispositivo.dono_conta_id),
    pontosEmOperacao(),
    bancoHorasRepo.saldosAtivos(),
  ]);

  // Cobertura: fica quem tem ESTE ponto na fatia dele. A conta própria do
  // Mostraí não entra na régua — ela anuncia a rede inteira, é o que ela é.
  //
  // A fatia é calculada UMA vez por conta e guardada: ela decide duas coisas
  // agora (se a conta entra nesta tela, e por quantos pontos o tempo dela se
  // divide na RN-49), e chamar duas vezes convida as duas a divergirem.
  const cobertura = new Map(
    todos.map((a) => [
      a.id,
      a.conta_propria
        ? pontosNoAr
        : pontosDoAnunciante(
            { id: a.id, pontosIncluidos: a.pontos_incluidos, escolhidos: a.pontos_escolhidos },
            pontosNoAr,
          ),
    ]),
  );
  const anunciantes = todos.filter((a) => a.conta_propria || cobertura.get(a.id).includes(dispositivo.ponto_id));
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
    // faltam volta pros que veiculam. Conta própria fica de fora — ela não
    // compra cobertura, ela É a rede.
    const segundos = a.conta_propria
      ? Number(a.segundos_por_hora) || 0
      : segundosCompensados(a.segundos_por_hora, a.pontos_incluidos, cobertura.get(a.id).length);
    // O plano compra SEGUNDOS da hora; quantas inserções isso vira depende
    // da peça que o cliente subiu. Seis de 15s e três de 30s ocupam o mesmo
    // lugar, e é por isso que a duração deixou de ser eixo de inventário.
    //
    // `frequencia_hora * duração` é a ponte pra quem ainda não tem
    // `segundos_por_hora` preenchido: mantém o comportamento de antes até a
    // grade nova ser publicada, em vez de zerar a playlist de todo mundo.
    const frequenciaBase = quantasInsercoes(a, segundos, duracaoSegundos);
    // Banco de horas (G.3): quem tem saldo (déficit de mês anterior que
    // ainda não foi devolvido) ganha prioridade aqui, em cima do déficit
    // normal de hora anterior. Capado no próprio pedido da hora — sem
    // teto, uma dívida grande dominaria a hora inteira, o que a RN-49 já
    // evita do outro lado. Conta própria não acumula banco (não é
    // cliente). O teto cresce com `multiplicadorPorIdade` conforme a
    // dívida envelhece (ver acima) — dívida nova nunca passa do dobro do
    // pedido normal; dívida perto da válvula pode chegar a
    // MULTIPLICADOR_MAXIMO_BANCO vezes isso.
    //
    // O saldo é da conta, não da tela — mas a playlist é gerada UMA TELA
    // por vez, e quem cobre vários pontos tem esta função rodando em
    // paralelo pra cada um, todas lendo o MESMO saldo ainda intacto. Sem
    // dividir, uma conta em 3 pontos puxaria o saldo inteiro 3 vezes na
    // mesma hora — a dívida "paga" triplicada, à custa de quem mais
    // partilha aquelas telas. Divide por `cobertura.get(a.id).length`, a
    // mesma fatia que a RN-49 já usa pra ratear segundos entre pontos —
    // ela existe pra resolver exatamente este problema, com outro número.
    const bancoDaConta = saldosBanco[a.id];
    const multiplicadorBanco = bancoDaConta ? multiplicadorPorIdade(bancoDaConta.idadeMeses) : 1;
    const prioridadeBanco = a.conta_propria
      ? 0
      : Math.min(
          Math.floor(((bancoDaConta?.saldo || 0) / cobertura.get(a.id).length) * multiplicadorBanco),
          Math.floor(frequenciaBase * multiplicadorBanco),
        );
    return {
      id: a.id,
      frequenciaBase,
      deficit: (deficits[a.id] || 0) + prioridadeBanco,
      prioridadeBanco,
      duracaoSegundos,
    };
  });

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
  const daHora = montarHoraDeTv(entrada, `${dispositivo.id}-${horaAtual.toISOString()}`);

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
  const contagem = { ...daHora.programados };
  delete contagem.dono;
  const pedidos = { ...daHora.pedidosPorAnunciante };
  delete pedidos.dono;
  await gravarProgramados(dispositivo, horaAtual, contagem, pedidos);

  // Banco de horas (G.3): drena na proporção do que a hora entregou. Se a
  // hora coube em tudo (cabe === quer), a prioridade toda foi entregue e
  // drena por inteiro; se cortou, drena só a fração — o resto continua no
  // banco pra próxima hora tentar de novo. `Math.round` porque o banco é
  // em exibições inteiras, não fração de exibição.
  await Promise.all(
    entrada
      .filter((e) => e.prioridadeBanco > 0)
      .map((e) => {
        const quer = pedidos[e.id] || 0;
        const cabe = contagem[e.id] || 0;
        const fracaoAtendida = quer > 0 ? Math.min(1, cabe / quer) : 0;
        const drenar = Math.round(e.prioridadeBanco * fracaoAtendida);
        return drenar > 0 ? bancoHorasRepo.drenar(Number(e.id), drenar) : null;
      }),
  );

  const usados = {};
  return daHora.itens.map((id) => {
    // Inventário vago: o player mostra a própria peça institucional (#vazio em
    // public/player.html) pelo tempo do item. Não tem url, não é de ninguém e
    // não conta exibição.
    if (id === ID_INSTITUCIONAL) {
      return { anuncianteId: null, institucional: true, url: null, duracaoSegundos: DURACAO_INSTITUCIONAL };
    }
    const { criativos } = porId[id];
    const vez = usados[id] || 0;
    usados[id] = vez + 1;
    const criativo = criativos[vez % criativos.length];
    return {
      anuncianteId: id === 'dono' ? null : id,
      autoanuncio: id === 'dono',
      url: criativo.url,
      duracaoSegundos: criativo.duracaoSegundos,
    };
  });
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

  const creditar = async (janela) => {
    const { rowCount } = await pool.query(
      `UPDATE exibicoes_contador SET vezes_confirmadas = vezes_confirmadas + 1
        WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3
          AND vezes_confirmadas < vezes_programadas`,
      [anuncianteId, dispositivoId, janela],
    );
    return rowCount > 0;
  };

  const existe = async (janela) => {
    const { rows } = await pool.query(
      `SELECT 1 FROM exibicoes_contador
        WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3`,
      [anuncianteId, dispositivoId, janela],
    );
    return rows.length > 0;
  };

  // Hora corrente primeiro: é o caso normal, e a folga é exceção.
  if (await creditar(horaAtual)) return { ok: true, janela: 'atual' };

  // Sobrou da hora anterior? Só nos primeiros minutos, e só se aquela hora
  // ainda tiver o que confirmar.
  const minutos = new Date(momento).getMinutes();
  if (minutos < FOLGA_VIRADA_MIN) {
    const anterior = new Date(horaAtual);
    anterior.setHours(anterior.getHours() - 1);
    if (await creditar(anterior)) return { ok: true, janela: 'anterior' };
  }

  if (await existe(horaAtual)) return { ok: false, motivo: 'ja_completo' };
  return { ok: false, motivo: 'nao_programado' };
}

module.exports = { gerarPlaylistDaHora, confirmarExibicao, limiteDeCriativos, FOLGA_VIRADA_MIN };
