const crypto = require('node:crypto');
const pool = require('../db/pool');
const { gerarHash, conferirHash } = require('../lib/senha');
const cofre = require('../lib/cofre');
const horarioSemanal = require('../lib/horario-semanal');
const { operacaoDaTela, deveriaOperar } = require('../lib/operacao-tela');
const { saudeDaTela, situacaoConfig, situacaoFila, alertasDaTela, SITUACOES_DE_ALERTA } = require('../lib/status-tela');
const { sincronizarStatusPonto } = require('../pontos/repository');
const telaEventos = require('../player/tela-eventos');
const credencial = require('../player/credencial');
const {
  formatarCodigoTela,
  normalizarCodigoTela,
  gerarCodigoInstalacao,
  formatarCodigoInstalacao,
} = require('../lib/codigo-tela');

// Tela = `dispositivos` (migration 019); Ponto = o comércio. O Player é a
// identidade provisionada numa tela (migration 083). Nomes de coluna em
// docs/specs/2026-09-23-player-v2-backend.md.

// O que o admin edita numa tela. Tudo que vai na config do Player sobe a
// versão desejada sozinho, por gatilho no banco (migration 083).
const CAMPOS_ATUALIZAVEIS = [
  'status',
  'custo_equipamento',
  'meses_amortizacao',
  'instalado_em',
  // compat-v1: formato da playlist para quem não manda X-Player-Contract
  // (Player Android anterior ao V2). O V2 escolhe o envelope pelo header.
  'contrato_playlist',
  'margem_superior',
  'margem_direita',
  'margem_inferior',
  'margem_esquerda',
  'modo_horario',
  'horario_semanal',
  'rotacao_tela',
  'timezone',
  'update_baixar_auto',
  'update_horas_entre_tentativas',
];
const STATUS = ['ativo', 'reparo', 'inativo'];
// Código de instalação (docs/player-mvp-contract.md §3): 30 min, 5 erros e
// repetição curta de 5 min (a resposta 200 pode se perder na rede).
const INSTALACAO_VALIDADE_MIN = 30;
const INSTALACAO_TENTATIVAS = 5;
const INSTALACAO_REPETICAO_MIN = 5;

const nomeDaTela = (t) => `Tela ${t.numero}`;

// SELECT interno: a linha inteira da tela + o que o ponto empresta a ela.
// Tem hash de chave e PIN cifrado — só sai deste módulo pelas projeções
// abaixo, que escolhem campo a campo o que pode sair.
const SELECT_BASE = `
  SELECT d.*,
         p.nome AS ponto_nome, p.cidade AS ponto_cidade, p.status AS ponto_status,
         p.horario_semanal AS ponto_horario_semanal, p.anunciante_id AS dono_conta_id,
         p.categoria_id, p.horario_abertura, p.horario_fechamento, p.cota_autoanuncio_slots_hora,
         (SELECT COUNT(*)::int FROM dispositivos x WHERE x.ponto_id = d.ponto_id AND x.status = 'ativo') AS telas_do_ponto,
         tk.criado_em AS prov_criado_em, tk.expira_em AS prov_expira_em, tk.usado_em AS prov_usado_em,
         tk.cancelado_em AS prov_cancelado_em, tk.codigo_cifrado AS prov_codigo_cifrado
         __EXTRA__
    FROM dispositivos d
    JOIN pontos p ON p.id = d.ponto_id
    LEFT JOIN LATERAL (
      SELECT criado_em, expira_em, usado_em, cancelado_em, codigo_cifrado FROM tokens_provisionamento
       WHERE dispositivo_id = d.id ORDER BY criado_em DESC, id DESC LIMIT 1
    ) tk ON true`;

const SELECT_TELA = SELECT_BASE.replace('__EXTRA__', '');
// Só para o admin (fora do caminho quente das rotas do Player): última
// exibição confirmada, pelo ledger do V2 ou pelo contador por hora (V1).
// Função como substituto: o texto tem `$'` (fim da regex), que um
// replace com string interpretaria como "o resto do SELECT".
const SELECT_TELA_ADMIN = SELECT_BASE.replace(
  '__EXTRA__',
  () => `, GREATEST(
       (SELECT max(ec.confirmado_em) FROM execucoes_confirmadas ec
         WHERE ec.dispositivo_id = d.id AND ec.status = 'contabilizado'),
       (SELECT max(ex.janela_hora) FROM exibicoes_contador ex
         WHERE ex.dispositivo_id = d.id AND ex.vezes_confirmadas > 0)
     ) AS ultima_confirmacao_em,
     (SELECT a.nome_empresa FROM criativos c JOIN anunciantes a ON a.id = c.anunciante_id
       WHERE d.criativo_atual ~ '^[0-9]{1,9}$' AND c.id = d.criativo_atual::int) AS criativo_atual_anunciante`,
);

// Uso interno do Player (autenticação, playlist, config) — nunca vai para
// resposta HTTP inteiro. O `dispositivoId` do contrato é o código da tela
// ("M-0235"), que é o id interno formatado: "235", "0235" e "M0235" também
// servem (src/lib/codigo-tela.js).
async function buscarComPonto(dispositivoId) {
  const id = normalizarCodigoTela(dispositivoId);
  if (!id) return null;
  const { rows } = await pool.query(`${SELECT_TELA} WHERE d.id = $1`, [id]);
  return rows[0] || null;
}

async function buscarLinha(id) {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  const { rows } = await pool.query(`${SELECT_TELA} WHERE d.id = $1`, [id]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Projeções
// ---------------------------------------------------------------------------
function situacaoProvisionamento(t, agora) {
  if (!t.prov_criado_em) return null;
  let estado = 'aguardando_instalacao';
  if (t.prov_usado_em) estado = 'usado';
  else if (t.prov_cancelado_em) estado = 'cancelado';
  else if (new Date(t.prov_expira_em) <= agora) estado = 'expirado';
  // O código só volta enquanto vale — expirado, usado ou cancelado não tem
  // o que mostrar (e a cópia cifrada já foi ou será apagada).
  const codigo = estado === 'aguardando_instalacao' ? cofre.abrir(t.prov_codigo_cifrado) : null;
  return {
    estado,
    codigo: codigo ? formatarCodigoInstalacao(codigo) : null,
    geradoEm: t.prov_criado_em,
    expiraEm: t.prov_expira_em,
    usadoEm: t.prov_usado_em,
  };
}

function situacaoCredencial(t, agora) {
  const anteriorValida = t.chave_anterior_hash && new Date(t.chave_anterior_expira_em) > agora;
  let estado = 'sem_credencial';
  if (t.chave_hash) estado = 'ativa';
  else if (t.revogado_em) estado = 'revogada';
  return {
    estado,
    fingerprint: t.chave_fingerprint,
    criadaEm: t.chave_criada_em,
    ultimoUsoEm: t.chave_ultimo_uso_em,
    revogadaEm: t.revogado_em,
    nova: t.chave_nova_hash ? { fingerprint: t.chave_nova_fingerprint, criadaEm: t.chave_nova_criada_em } : null,
    anterior: anteriorValida ? { expiraEm: t.chave_anterior_expira_em } : null,
    // Mesma condição de credencial.iniciarRotacao: a candidata só chega a um
    // Player V2 provisionado (viaja na resposta do heartbeat V2).
    rotacionavel: !!t.chave_hash && !!t.dispositivo_uid,
  };
}

// Tudo que o admin precisa para administrar a tela sem abrir o banco — e
// nada que sirva para se passar por ela (sem chave, sem hash inteiro, sem
// token, sem PIN).
function paraAdmin(t, agora = new Date(), releaseObrigatoria = null) {
  const saude = saudeDaTela(t, t.ponto_horario_semanal, agora);
  const v2 = Number(t.player_contrato) >= 2;
  return {
    id: t.id,
    pontoId: t.ponto_id,
    numero: t.numero,
    nome: nomeDaTela(t),
    pontoNome: t.ponto_nome,
    pontoCidade: t.ponto_cidade,
    status: t.status,
    saude,
    alertas: alertasDaTela(t, saude, agora, releaseObrigatoria),
    criadaEm: t.created_at,
    instaladoEm: t.instalado_em,
    custoEquipamento: Number(t.custo_equipamento),
    mesesAmortizacao: t.meses_amortizacao,
    operacao: {
      primeiroSinalEm: t.primeiro_sinal_em,
      ultimoSinalEm: t.ultima_vez_online,
      deveriaOperarAgora: deveriaOperar(operacaoDaTela(t, t.ponto_horario_semanal, agora), agora),
      playerEstado: v2 ? t.player_estado : null,
      criativoAtual: v2 ? t.criativo_atual : null,
      // Quem está no ar, pelo nome — o id do criativo é registro interno.
      midiaNoAr: v2 && t.criativo_atual ? t.criativo_atual_anunciante || null : null,
      ultimaPlaylistOkEm: v2 ? t.ultima_playlist_ok_em : null,
      playlistEntregueEm: t.playlist_entregue_em,
      ultimaConfirmacaoEm: t.ultima_confirmacao_em || null,
    },
    configuracao: {
      desejada: t.config_versao_desejada,
      aplicada: v2 ? t.config_versao_aplicada : null,
      situacao: situacaoConfig(t, agora),
      alteradaEm: t.config_alterada_em,
      aplicadaEm: v2 ? t.config_aplicada_em : null,
      modoHorario: t.modo_horario,
      horarioSemanal: t.horario_semanal,
      horarioResumo:
        t.modo_horario === '24h'
          ? '24 horas'
          : horarioSemanal.resumo(t.modo_horario === 'personalizado' ? t.horario_semanal : t.ponto_horario_semanal),
      timezone: t.timezone,
      rotacao: t.rotacao_tela,
      margens: {
        superior: Number(t.margem_superior),
        direita: Number(t.margem_direita),
        inferior: Number(t.margem_inferior),
        esquerda: Number(t.margem_esquerda),
      },
      pin: {
        configurado: !!t.pin_manutencao_cifrado,
        alteradoEm: t.pin_manutencao_alterado_em,
        // compat-v1: só o PIN do player web existe (hash, 4–6 dígitos) — o
        // Player V2 não o recebe até ser redefinido.
        soPlayerWeb: !t.pin_manutencao_cifrado && !!t.pin_hash,
      },
      update: { baixarAutomaticamente: t.update_baixar_auto, horasEntreTentativas: t.update_horas_entre_tentativas },
    },
    identidade: {
      telaId: t.id,
      pontoId: t.ponto_id,
      dispositivoId: t.dispositivo_uid || null,
      // Tela que nunca passou por provisionamento: o Player (web ou Android
      // legado) fala pelo ID da Tela mesmo.
      dispositivoIdLegado: !t.dispositivo_uid,
      contrato: t.player_contrato,
      versao: t.player_versao,
      build: t.player_build,
      provisionadoEm: t.provisionado_em,
      credencial: situacaoCredencial(t, agora),
      provisionamento: situacaoProvisionamento(t, agora),
    },
    diagnostico: {
      fabricante: t.aparelho_fabricante,
      modelo: t.aparelho_modelo,
      android: t.aparelho_android,
      resolucao: t.aparelho_largura && t.aparelho_altura ? `${t.aparelho_largura}×${t.aparelho_altura}` : null,
      timezoneAparelho: t.aparelho_timezone,
      helloPrimeiroEm: t.hello_primeiro_em,
      helloUltimoEm: t.hello_ultimo_em,
      fila: {
        pendentes: v2 ? t.fila_pendentes : null,
        maisAntigoEm: v2 ? t.fila_mais_antigo_em : null,
        situacao: v2 ? situacaoFila(t, agora) : 'desconhecida',
      },
      erro:
        t.ultimo_erro_codigo || t.ultimo_erro
          ? { codigo: t.ultimo_erro_codigo, mensagem: t.ultimo_erro, em: t.ultimo_erro_em }
          : null,
      desvioRelogioMs: v2 && t.desvio_relogio_ms != null ? Number(t.desvio_relogio_ms) : null,
      update: v2 && t.update_estado ? { estado: t.update_estado, em: t.update_estado_em } : null,
    },
  };
}

async function releaseObrigatoriaAtiva() {
  const { rows } = await pool.query(
    `SELECT build, assinatura_conferida_em FROM player_releases WHERE ativa AND obrigatoria ORDER BY build DESC LIMIT 1`,
  );
  return rows[0] || null;
}

async function listarParaAdmin(where = '', params = []) {
  const agora = new Date();
  const [{ rows }, release] = await Promise.all([
    pool.query(`${SELECT_TELA_ADMIN} ${where} ORDER BY p.nome, d.numero`, params),
    releaseObrigatoriaAtiva(),
  ]);
  return rows.map((t) => paraAdmin(t, agora, release));
}

const listarPorPonto = (pontoId) => listarParaAdmin('WHERE d.ponto_id = $1', [pontoId]);
const listarTodos = () => listarParaAdmin();

async function buscarPorId(id) {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  const [{ rows }, release] = await Promise.all([
    pool.query(`${SELECT_TELA_ADMIN} WHERE d.id = $1`, [id]),
    releaseObrigatoriaAtiva(),
  ]);
  return rows[0] ? paraAdmin(rows[0], new Date(), release) : null;
}

// Visão geral / alertas: só quem deveria operar e não está.
async function listarComProblemaDeSinal() {
  return (await listarTodos()).filter((t) => SITUACOES_DE_ALERTA.has(t.saude));
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------
// Número estável dentro do ponto: o gatilho `tela_numero_estavel`
// (migration 083) dá o próximo número do contador do ponto no INSERT.
async function criar(pontoId, dados = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO dispositivos (ponto_id, apelido, status, modo_horario, rotacao_tela, custo_equipamento, meses_amortizacao)
       VALUES ($1, 'Tela', $2, $3, $4, $5, $6) RETURNING id, numero`,
      [
        pontoId,
        STATUS.includes(dados.status) ? dados.status : 'ativo',
        ['ponto', '24h', 'personalizado'].includes(dados.modo_horario) ? dados.modo_horario : 'ponto',
        [0, 90, 180, 270].includes(Number(dados.rotacao_tela)) ? Number(dados.rotacao_tela) : 0,
        Number(dados.custo_equipamento) || 0,
        Number(dados.meses_amortizacao) || 36,
      ],
    );
    await client.query('UPDATE dispositivos SET apelido = $2 WHERE id = $1', [rows[0].id, `Tela ${rows[0].numero}`]);
    await telaEventos.registrar(rows[0].id, 'SCREEN_CREATED', { numero: rows[0].numero }, client);
    await sincronizarStatusPonto(pontoId, client);
    await client.query('COMMIT');
    return buscarPorId(rows[0].id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function atualizar(id, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  const antes = await buscarLinha(id);
  if (!antes) return null;
  if (campos.length) {
    const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await pool.query(`UPDATE dispositivos SET ${sets} WHERE id = $1`, [id, ...campos.map((c) => dados[c])]);
    if (campos.includes('status') && dados.status !== antes.status) {
      await telaEventos.registrar(id, 'ADMIN_STATE_CHANGED', { de: antes.status, para: dados.status });
      await sincronizarStatusPonto(antes.ponto_id);
    }
  }
  return buscarPorId(id);
}

// PIN de manutenção do Player (4 dígitos, contrato §5 `pinPainel`): cifrado
// para ir na config do V2, e com hash para o painel do player web (V1), que
// confere no servidor. Um PIN só, as duas formas. null apaga.
async function definirPin(id, pin) {
  const cifrado = pin ? cofre.fechar(pin) : null;
  const hash = pin ? await gerarHash(String(pin)) : null;
  const { rowCount } = await pool.query(
    `UPDATE dispositivos SET pin_manutencao_cifrado = $2, pin_hash = $3, pin_manutencao_alterado_em = now() WHERE id = $1`,
    [id, cifrado, hash],
  );
  return rowCount > 0;
}

// PIN em claro, só pelo caminho auditado do admin (GET .../pin registra
// PIN_REVEALED no histórico da tela). Sai do cofre AES-GCM — nunca do hash
// (o hash V1 não abre; tela só com hash devolve null e o admin redefine).
async function revelarPin(id) {
  const { rows } = await pool.query('SELECT pin_manutencao_cifrado FROM dispositivos WHERE id = $1', [id]);
  if (!rows[0]) return undefined;
  const pin = cofre.abrir(rows[0].pin_manutencao_cifrado);
  return pin && /^\d{4}$/.test(pin) ? pin : null;
}

// compat-v1: painel do player web (POST /player/:id/painel).
async function conferirPin(id, pin) {
  const { rows } = await pool.query('SELECT pin_hash FROM dispositivos WHERE id = $1', [id]);
  if (!rows[0]?.pin_hash) return false;
  return (await conferirHash(String(pin), rows[0].pin_hash)).ok;
}

// Tela que já rodou anúncio de verdade não se apaga: o comprovante de
// exibição dos anunciantes (execucoes_confirmadas / exibicoes_contador) é
// deles, não da tela. O caminho é inativar (status), que preserva tudo.
async function temExibicaoConfirmada(id, db = pool) {
  const { rows } = await db.query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM execucoes_confirmadas WHERE dispositivo_id = $1 AND status = 'contabilizado')
                OR EXISTS (SELECT 1 FROM exibicoes_contador WHERE dispositivo_id = $1 AND vezes_confirmadas > 0)`,
    [id],
  );
  return rows.length > 0;
}

async function deletar(id) {
  const existente = await buscarLinha(id);
  if (!existente) return;
  if (await temExibicaoConfirmada(id)) {
    throw Object.assign(new Error('esta tela já exibiu anúncios confirmados — inative em vez de excluir'), {
      status: 409,
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM exibicoes_contador WHERE dispositivo_id = $1', [id]);
    await client.query('DELETE FROM playlist_hora_congelada WHERE dispositivo_id = $1', [id]);
    await client.query('DELETE FROM execucoes_confirmadas WHERE dispositivo_id = $1', [id]);
    // tokens_provisionamento e tela_eventos saem por ON DELETE CASCADE.
    await client.query('DELETE FROM dispositivos WHERE id = $1', [id]);
    await sincronizarStatusPonto(existente.ponto_id, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Instalação por código (docs/player-mvp-contract.md §3)
// ---------------------------------------------------------------------------
// HMAC sobre (tela, código): o mesmo código em outra tela não casa, e o hash
// sozinho (se o banco vazar) não serve pra adivinhar o código.
const assinaturaDoCodigo = (telaId, codigo) => cofre.assinar(`instalacao:${telaId}:${codigo}`);

function assinaturasIguais(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Código novo cancela o pendente. Só para tela SEM Player conectado: gerar
// código numa tela que já tem Player deixaria qualquer um que o visse trocar
// o aparelho dela — o caminho é revogar antes (a tela volta a "Aguardando
// instalação"). Devolve { codigo: 'XXXX-XXXX', criadoEm, expiraEm } ou null
// (tela inexistente); lança 400 (ponto arquivado) e 409 (Player conectado).
async function gerarCodigo(telaId, criadoPor = 'admin') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: tela } = await client.query(
      `SELECT d.id, d.chave_hash, p.status AS ponto_status FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
        WHERE d.id = $1 FOR UPDATE OF d`,
      [telaId],
    );
    if (!tela[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    if (tela[0].ponto_status === 'arquivado') {
      throw Object.assign(new Error('ponto arquivado não recebe Player'), { status: 400 });
    }
    if (tela[0].chave_hash) {
      throw Object.assign(
        new Error('esta tela já tem um Player conectado — revogue o Player antes de instalar outro'),
        {
          status: 409,
        },
      );
    }
    await client.query(
      `UPDATE tokens_provisionamento SET cancelado_em = now(), codigo_cifrado = NULL
        WHERE dispositivo_id = $1 AND usado_em IS NULL AND cancelado_em IS NULL`,
      [telaId],
    );
    // O hash é único na tabela; um código repetido desta mesma tela (1 em
    // 31^8 por código antigo) só pede outro sorteio.
    for (let tentativa = 0; ; tentativa++) {
      const codigo = gerarCodigoInstalacao();
      await client.query('SAVEPOINT codigo');
      try {
        const { rows } = await client.query(
          `INSERT INTO tokens_provisionamento (dispositivo_id, token_hash, criado_por, expira_em, codigo_cifrado)
           VALUES ($1, $2, $3, now() + ($4::int * interval '1 minute'), $5) RETURNING criado_em, expira_em`,
          [telaId, assinaturaDoCodigo(telaId, codigo), criadoPor, INSTALACAO_VALIDADE_MIN, cofre.fechar(codigo)],
        );
        await telaEventos.registrar(telaId, 'PROVISIONING_PREPARED', { expiraEm: rows[0].expira_em }, client);
        await client.query('COMMIT');
        return { codigo: formatarCodigoInstalacao(codigo), criadoEm: rows[0].criado_em, expiraEm: rows[0].expira_em };
      } catch (err) {
        if (err.code !== '23505' || tentativa >= 4) throw err;
        await client.query('ROLLBACK TO SAVEPOINT codigo');
      }
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Troca (código da tela + código de instalação) → credencial permanente.
// `telaId` e `codigo` já normalizados por quem chama. Devolve
// { telaId, pontoId, dispositivoId, chaveAparelho, novo, primeiroSinal } ou
// null — tela inexistente, ponto arquivado, código errado, expirado,
// cancelado ou usado dão o MESMO null (o Player não aprende qual foi).
//
// A tela fica travada (FOR UPDATE) do começo ao fim: duas trocas
// simultâneas do mesmo código geram UMA credencial — a segunda espera, não
// acha mais código pendente e cai na repetição, recebendo a mesma.
async function trocarCodigoPorCredencial(telaId, codigo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Limpeza oportunista: credencial para repetição não passa da janela, e
    // cópia reexibível não sobrevive ao código.
    await client.query(
      `UPDATE tokens_provisionamento SET credencial_cifrada = NULL
        WHERE credencial_cifrada IS NOT NULL AND usado_em < now() - ($1::int * interval '1 minute')`,
      [INSTALACAO_REPETICAO_MIN],
    );
    await client.query(
      `UPDATE tokens_provisionamento SET codigo_cifrado = NULL WHERE codigo_cifrado IS NOT NULL AND expira_em <= now()`,
    );
    const { rows: tela } = await client.query(
      `SELECT d.id, d.ponto_id, d.chave_hash, d.primeiro_sinal_em, p.status AS ponto_status
         FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id WHERE d.id = $1 FOR UPDATE OF d`,
      [telaId],
    );
    if (!tela[0] || tela[0].ponto_status === 'arquivado') {
      await client.query('COMMIT');
      return null;
    }
    const assinatura = assinaturaDoCodigo(telaId, codigo);
    const { rows: pendentes } = await client.query(
      `SELECT id, token_hash FROM tokens_provisionamento
        WHERE dispositivo_id = $1 AND usado_em IS NULL AND cancelado_em IS NULL AND expira_em > now()
        ORDER BY criado_em DESC, id DESC LIMIT 1 FOR UPDATE`,
      [telaId],
    );
    const pendente = pendentes[0];

    if (pendente && assinaturasIguais(pendente.token_hash, assinatura)) {
      await client.query(`UPDATE tokens_provisionamento SET usado_em = now(), codigo_cifrado = NULL WHERE id = $1`, [
        pendente.id,
      ]);
      const chave = credencial.gerarChave();
      const dispositivoId = formatarCodigoTela(telaId);
      // Player novo começa do zero: o que um aparelho anterior relatou não
      // descreve este. A troca em si é o primeiro contato — a tela nasce
      // "Operando" e vira "Sem sinal" se o Player sumir depois.
      await client.query(
        `UPDATE dispositivos
            SET chave_hash = $2, chave_ultimo_uso_em = NULL, provisionado_em = now(), revogado_em = NULL,
                config_versao_aplicada = NULL, config_aplicada_em = NULL,
                player_estado = NULL, criativo_atual = NULL, fila_pendentes = NULL, fila_mais_antigo_em = NULL,
                ultimo_erro_codigo = NULL, ultimo_erro = NULL, ultimo_erro_em = NULL,
                primeiro_sinal_em = COALESCE(primeiro_sinal_em, now()), ultima_vez_online = now()
          WHERE id = $1`,
        [telaId, credencial.hashDaChave(chave)],
      );
      await client.query(`UPDATE tokens_provisionamento SET credencial_cifrada = $2 WHERE id = $1`, [
        pendente.id,
        cofre.fechar(JSON.stringify({ dispositivoId, chaveAparelho: chave })),
      ]);
      await telaEventos.registrar(telaId, 'PLAYER_PROVISIONED', null, client);
      if (!tela[0].primeiro_sinal_em) await telaEventos.registrar(telaId, 'FIRST_SEEN', null, client);
      await client.query('COMMIT');
      return {
        telaId,
        pontoId: tela[0].ponto_id,
        dispositivoId,
        chaveAparelho: chave,
        novo: true,
        primeiroSinal: !tela[0].primeiro_sinal_em,
      };
    }

    // Repetição dentro da janela: mesma credencial, desde que continue
    // sendo a desta tela (não houve revogação nem outra instalação depois).
    const { rows: repetido } = await client.query(
      `SELECT credencial_cifrada FROM tokens_provisionamento
        WHERE dispositivo_id = $1 AND token_hash = $2 AND credencial_cifrada IS NOT NULL
          AND usado_em > now() - ($3::int * interval '1 minute')`,
      [telaId, assinatura, INSTALACAO_REPETICAO_MIN],
    );
    const dados = repetido[0] && JSON.parse(cofre.abrir(repetido[0].credencial_cifrada) || 'null');
    if (dados && tela[0].chave_hash && credencial.hashDaChave(dados.chaveAparelho) === tela[0].chave_hash) {
      await client.query('COMMIT');
      return { telaId, pontoId: tela[0].ponto_id, ...dados, novo: false, primeiroSinal: false };
    }

    // Erro: conta contra o código pendente desta tela; na 5ª ele morre.
    if (pendente) {
      const { rows } = await client.query(
        `UPDATE tokens_provisionamento
            SET tentativas_erradas = tentativas_erradas + 1,
                cancelado_em = CASE WHEN tentativas_erradas + 1 >= $2 THEN now() END,
                codigo_cifrado = CASE WHEN tentativas_erradas + 1 >= $2 THEN NULL ELSE codigo_cifrado END
          WHERE id = $1 RETURNING tentativas_erradas, cancelado_em`,
        [pendente.id, INSTALACAO_TENTATIVAS],
      );
      await telaEventos.registrar(
        telaId,
        'PROVISIONING_FAILED',
        { tentativa: rows[0].tentativas_erradas, bloqueado: !!rows[0].cancelado_em },
        client,
      );
    } else {
      await telaEventos.registrar(telaId, 'PROVISIONING_FAILED', { semCodigoValido: true }, client);
    }
    await client.query('COMMIT');
    return null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// O Player provou que recebeu a credencial (primeira requisição autenticada
// com ela): a janela de repetição do token fecha na hora.
async function fecharJanelaDoToken(telaId) {
  await pool.query(
    `UPDATE tokens_provisionamento SET credencial_cifrada = NULL WHERE dispositivo_id = $1 AND credencial_cifrada IS NOT NULL`,
    [telaId],
  );
}

module.exports = {
  CAMPOS_ATUALIZAVEIS,
  STATUS,
  INSTALACAO_VALIDADE_MIN,
  INSTALACAO_TENTATIVAS,
  nomeDaTela,
  buscarComPonto,
  buscarLinha,
  buscarPorId,
  paraAdmin,
  listarPorPonto,
  listarTodos,
  listarComProblemaDeSinal,
  criar,
  atualizar,
  definirPin,
  revelarPin,
  conferirPin,
  temExibicaoConfirmada,
  deletar,
  gerarCodigo,
  trocarCodigoPorCredencial,
  fecharJanelaDoToken,
};
