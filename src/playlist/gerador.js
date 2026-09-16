const pool = require('../db/pool');
const { calcularPlaylist, contarPorAnunciante, dividirCota, pedidoDaHora } = require('../lib/pacing');
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

// Todo plano cobre 100% da rede nesta fase. "Elegível pra esta tela" é:
// conta ativa + criativo aprovado + dentro da validade + não ser do mesmo
// ramo do comércio onde a tela está.
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
           p.limite_criativos,
           array_agg(c.arquivo_normalizado_url ORDER BY c.created_at DESC) AS urls,
           array_agg(c.duracao_segundos ORDER BY c.created_at DESC) AS duracoes
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
    GROUP BY a.id, a.conta_propria, p.frequencia_hora, a.frequencia_hora_propria, p.limite_criativos
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

  const [anunciantes, deficits, doDono] = await Promise.all([
    anunciantesElegiveis(dispositivo.categoria_id, dispositivo.dono_conta_id),
    deficitHoraAnterior(dispositivo.id, horaAnterior),
    criativosDoDono(dispositivo.dono_conta_id),
  ]);
  const porId = Object.fromEntries(anunciantes.map((a) => [a.id, a]));

  // Frequência é por hora direto agora (migration 037) — sem conversão por
  // horário do ponto. O que o plano diz é o que roda, hora a hora.
  const entrada = anunciantes.map((a) => ({
    id: a.id,
    frequenciaBase: Number(a.frequencia_hora) || 0,
    deficit: deficits[a.id] || 0,
  }));

  // Dono do ponto entra com a fatia da cota que cabe a esta tela. Não conta
  // como anunciante pagante nem gera contador — é permuta, não venda.
  const cotaDaTela = dividirCota(dispositivo.cota_autoanuncio_slots_hora, dispositivo.telas_do_ponto);
  if (doDono.length && cotaDaTela > 0) {
    porId.dono = { criativos: doDono };
    entrada.push({ id: 'dono', frequenciaBase: cotaDaTela, deficit: 0 });
  }

  // Teto de 200 slots/hora: quando o pedido passa disso, todo mundo entrega
  // menos do que contratou. O corte e proporcional (src/lib/pacing.js), mas
  // continua sendo entrega menor — e antes nao havia sinal nenhum disso em
  // lugar nenhum. Vira evento da metrica, que e onde o dono olha.
  const aperto = pedidoDaHora(entrada);
  if (aperto.cortou) {
    eventos.registrar('playlist:teto_corta', {
      dispositivo_id: dispositivo.id,
      ponto_id: dispositivo.ponto_id,
      pedido: aperto.pedido,
      cabe: aperto.cabe,
      anunciantes: entrada.length,
    });
  }

  const itensIds = calcularPlaylist(entrada);
  const contagem = contarPorAnunciante(itensIds);
  delete contagem.dono;
  await gravarProgramados(dispositivo, horaAtual, contagem);

  const usados = {};
  return itensIds.map((id) => {
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
