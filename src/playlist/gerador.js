const pool = require('../db/pool');
const {
  montarHoraDeTv,
  pontosDoAnunciante,
  dividirCota,
  duracaoValida,
  ID_INSTITUCIONAL,
  DURACAO_INSTITUCIONAL,
} = require('../lib/pacing');
const eventos = require('../lib/eventos');

// Playlist é por TELA (dispositivo), não por ponto — migration 019. A tela
// recebe do ponto a categoria (bloqueio de concorrente) e a cota de
// autoanúncio do dono, dividida entre as telas daquele ponto.

// Quantos criativos da conta entram na rotação.
//
// Conta própria não tem teto: o inventário é da casa, e limitar a si mesmo não
// protege ninguém. Quem paga plano fica no que o plano vende, e nunca acima de
// 3 — o teto duro existe porque `limite_criativos` é editável no admin e um
// zero a mais ali encheria a playlist de uma conta só.
function limiteDeCriativos(contaPropria, limitePlano, disponiveis) {
  if (contaPropria) return disponiveis;
  return Math.min(3, Math.max(1, Number(limitePlano) || 1));
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
// tem hoje.
function quantasInsercoes(conta, duracaoSegundos) {
  const segundos = Number(conta.segundos_por_hora) || 0;
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

async function gravarProgramados(dispositivo, horaAtual, contagem) {
  await Promise.all(
    Object.entries(contagem).map(([anuncianteId, vezes]) =>
      pool.query(
        `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (anunciante_id, dispositivo_id, janela_hora) DO UPDATE SET vezes_programadas = $4`,
        [anuncianteId, dispositivo.id, horaAtual, vezes],
      ),
    ),
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

  const [todos, deficits, doDono, pontosNoAr] = await Promise.all([
    anunciantesElegiveis(dispositivo.categoria_id, excluirDaRotacaoPaga),
    deficitHoraAnterior(dispositivo.id, horaAnterior),
    criativosDoDono(dispositivo.dono_conta_id),
    pontosEmOperacao(),
  ]);

  // Cobertura: fica quem tem ESTE ponto na fatia dele. A conta própria do
  // Mostraí não entra na régua — ela anuncia a rede inteira, é o que ela é.
  const anunciantes = todos.filter(
    (a) =>
      a.conta_propria ||
      pontosDoAnunciante(
        { id: a.id, pontosIncluidos: a.pontos_incluidos, escolhidos: a.pontos_escolhidos },
        pontosNoAr,
      ).includes(dispositivo.ponto_id),
  );
  const porId = Object.fromEntries(anunciantes.map((a) => [a.id, a]));

  // Frequência é por hora direto agora (migration 037) — sem conversão por
  // horário do ponto. O que o plano diz é o que roda, hora a hora.
  //
  // A duração entra junto porque a hora passou a ser orçada em SEGUNDOS
  // (src/lib/pacing.js): quem revezar entre peças de durações diferentes ocupa
  // a média delas, que é o que de fato acontece ao longo da hora.
  const entrada = anunciantes.map((a) => {
    const duracaoSegundos = duracaoMedia(a.criativos);
    return {
      id: a.id,
      // O plano compra SEGUNDOS da hora; quantas inserções isso vira depende
      // da peça que o cliente subiu. Seis de 15s e três de 30s ocupam o mesmo
      // lugar, e é por isso que a duração deixou de ser eixo de inventário.
      //
      // `frequencia_hora * duração` é a ponte pra quem ainda não tem
      // `segundos_por_hora` preenchido: mantém o comportamento de antes até a
      // grade nova ser publicada, em vez de zerar a playlist de todo mundo.
      frequenciaBase: quantasInsercoes(a, duracaoSegundos),
      deficit: deficits[a.id] || 0,
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
  await gravarProgramados(dispositivo, horaAtual, contagem);

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
async function confirmarExibicao(dispositivoId, anuncianteId, hora) {
  const horaAtual = new Date(hora);
  horaAtual.setMinutes(0, 0, 0);
  const { rowCount } = await pool.query(
    `UPDATE exibicoes_contador SET vezes_confirmadas = vezes_confirmadas + 1
     WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3`,
    [anuncianteId, dispositivoId, horaAtual],
  );
  return rowCount > 0;
}

module.exports = { gerarPlaylistDaHora, confirmarExibicao, limiteDeCriativos };
