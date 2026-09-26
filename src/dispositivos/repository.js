const crypto = require('node:crypto');
const pool = require('../db/pool');
const cofre = require('../lib/cofre');
const { saudeDaTela, situacaoConfig, situacaoFila, alertasDaTela, SITUACOES_DE_ALERTA } = require('../lib/status-tela');
const { sincronizarStatusPonto } = require('../pontos/repository');
const telaEventos = require('../player/tela-eventos');
const credencial = require('../player/credencial');
const pinSaida = require('../player/pin-saida');
const {
  formatarCodigoTela,
  normalizarCodigoTela,
  gerarCodigoInstalacao,
  formatarCodigoInstalacao,
} = require('../lib/codigo-tela');

// Tela = `dispositivos` (migration 019); Ponto = o comércio. O Player é a
// credencial instalada numa tela pelo código de instalação
// (docs/player-mvp-contract.md §3).

// O que o admin edita numa tela. Margem vai na config do Player e sobe a
// versão desejada sozinha, por gatilho no banco (migration 093). Horário é
// do ponto; PIN de saída é global (src/player/pin-saida.js).
const CAMPOS_ATUALIZAVEIS = [
  'status',
  'custo_equipamento',
  'meses_amortizacao',
  'instalado_em',
  'margem_superior',
  'margem_direita',
  'margem_inferior',
  'margem_esquerda',
];
const STATUS = ['ativo', 'reparo', 'inativo'];
// Código de instalação (docs/player-mvp-contract.md §3): 30 min, 5 erros e
// repetição curta de 5 min (a resposta 200 pode se perder na rede).
const INSTALACAO_VALIDADE_MIN = 30;
const INSTALACAO_TENTATIVAS = 5;
const INSTALACAO_REPETICAO_MIN = 5;

// SELECT interno: a linha inteira da tela + o que o ponto empresta a ela.
// Tem hash de chave — só sai deste módulo pelas projeções abaixo, que
// escolhem campo a campo o que pode sair. É o caminho quente do Player (toda
// requisição autenticada, heartbeat a cada 15 s): nada além do necessário.
const SELECT_TELA = `
  SELECT d.*,
         p.nome AS ponto_nome, p.cidade AS ponto_cidade, p.status AS ponto_status,
         p.horario_semanal AS ponto_horario_semanal, p.anunciante_id AS dono_conta_id,
         p.categoria_id, p.cota_autoanuncio_slots_hora,
         (SELECT COUNT(*)::int FROM dispositivos x WHERE x.ponto_id = d.ponto_id AND x.status = 'ativo') AS telas_do_ponto
    FROM dispositivos d
    JOIN pontos p ON p.id = d.ponto_id`;

// Só para o admin (fora do caminho quente): o código de instalação mais
// recente (cópia cifrada, para reexibir enquanto vale) e quem está no ar,
// pelo nome do anunciante.
// Função como substituto: o texto tem `$'` (fim da regex), que um replace
// com string interpretaria como "o resto do SELECT".
const SELECT_TELA_ADMIN = SELECT_TELA.replace(
  '    FROM dispositivos d',
  () => `,
         tk.criado_em AS prov_criado_em, tk.expira_em AS prov_expira_em, tk.usado_em AS prov_usado_em,
         tk.cancelado_em AS prov_cancelado_em, tk.codigo_cifrado AS prov_codigo_cifrado,
         (SELECT a.nome_empresa FROM criativos c JOIN anunciantes a ON a.id = c.anunciante_id
           WHERE d.criativo_atual ~ '^[0-9]{1,9}$' AND c.id = d.criativo_atual::int) AS criativo_atual_anunciante
    FROM dispositivos d
    LEFT JOIN LATERAL (
      SELECT criado_em, expira_em, usado_em, cancelado_em, codigo_cifrado FROM tokens_provisionamento
       WHERE dispositivo_id = d.id ORDER BY criado_em DESC, id DESC LIMIT 1
    ) tk ON true`,
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
// Instalação do Player (docs/player-mvp-contract.md §3): "aguardando" até
// haver credencial, "conectado" depois. O código só volta enquanto vale —
// expirado, usado ou cancelado não tem o que mostrar.
function situacaoInstalacao(t, agora) {
  if (t.chave_hash) return { estado: 'conectado', conectadoEm: t.provisionado_em, codigo: null, expiraEm: null };
  const pendente = t.prov_criado_em && !t.prov_usado_em && !t.prov_cancelado_em && new Date(t.prov_expira_em) > agora;
  const codigo = pendente ? cofre.abrir(t.prov_codigo_cifrado) : null;
  return {
    estado: 'aguardando',
    conectadoEm: null,
    codigo: codigo ? formatarCodigoInstalacao(codigo) : null,
    expiraEm: codigo ? t.prov_expira_em : null,
  };
}

// O que o admin precisa para operar a tela — e nada que sirva para se passar
// por ela (sem chave, sem hash, sem PIN) nem jargão de engenharia.
function paraAdmin(t, agora = new Date()) {
  const saude = saudeDaTela(t, t.ponto_horario_semanal, agora);
  const temErro = t.ultimo_erro_codigo || t.ultimo_erro;
  return {
    id: t.id,
    pontoId: t.ponto_id,
    codigo: formatarCodigoTela(t.id),
    nome: formatarCodigoTela(t.id),
    pontoNome: t.ponto_nome,
    pontoCidade: t.ponto_cidade,
    status: t.status,
    saude,
    alertas: alertasDaTela(t, saude, agora),
    criadaEm: t.created_at,
    instaladoEm: t.instalado_em,
    custoEquipamento: Number(t.custo_equipamento),
    mesesAmortizacao: t.meses_amortizacao,
    primeiroSinalEm: t.primeiro_sinal_em,
    ultimoSinalEm: t.chave_hash ? t.ultima_vez_online : null,
    player: t.chave_hash ? { versao: t.player_versao, build: t.player_build } : null,
    // Quem está no ar, pelo nome — o id do criativo é registro interno.
    midiaAtual: t.chave_hash && t.criativo_atual ? t.criativo_atual_anunciante || null : null,
    instalacao: situacaoInstalacao(t, agora),
    margens: {
      superior: Number(t.margem_superior),
      direita: Number(t.margem_direita),
      inferior: Number(t.margem_inferior),
      esquerda: Number(t.margem_esquerda),
    },
    // Só para alerta ("a TV ainda não recebeu a mudança"); versão não é
    // assunto do operador.
    configuracao: {
      situacao: situacaoConfig(t, agora),
      desejada: t.config_versao_desejada,
      aplicada: t.config_versao_aplicada,
    },
    suporte: {
      erro: temErro ? { codigo: t.ultimo_erro_codigo, mensagem: t.ultimo_erro, em: t.ultimo_erro_em } : null,
      fila: { pendentes: t.fila_pendentes, maisAntigoEm: t.fila_mais_antigo_em, situacao: situacaoFila(t, agora) },
    },
  };
}

async function listarParaAdmin(where = '', params = []) {
  const agora = new Date();
  const { rows } = await pool.query(`${SELECT_TELA_ADMIN} ${where} ORDER BY p.nome, d.id`, params);
  return rows.map((t) => paraAdmin(t, agora));
}

const listarPorPonto = (pontoId) => listarParaAdmin('WHERE d.ponto_id = $1', [pontoId]);
const listarTodos = () => listarParaAdmin();

async function buscarPorId(id) {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  const { rows } = await pool.query(`${SELECT_TELA_ADMIN} WHERE d.id = $1`, [id]);
  return rows[0] ? paraAdmin(rows[0], new Date()) : null;
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
      `INSERT INTO dispositivos (ponto_id, apelido, status, custo_equipamento, meses_amortizacao)
       VALUES ($1, 'Tela', $2, $3, $4) RETURNING id, numero`,
      [
        pontoId,
        STATUS.includes(dados.status) ? dados.status : 'ativo',
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

// Exclusão de tela SEM histórico de exibição. O código de instalação
// pendente e a credencial somem com a linha (tokens_provisionamento e
// tela_eventos por ON DELETE CASCADE); contador, hora congelada e ledger
// dela são só programação que nunca virou exibição. Devolve false se a tela
// não existe.
async function deletar(id) {
  const existente = await buscarLinha(id);
  if (!existente) return false;
  if (await temExibicaoConfirmada(id)) {
    throw Object.assign(
      new Error('Esta tela possui histórico de exibições e não pode ser excluída permanentemente. Deixe-a Inativa.'),
      { status: 409 },
    );
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
    return true;
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
        { status: 409 },
      );
    }
    // Sem PIN de saída, um Player instalado não teria como sair do modo
    // quiosque de forma autorizada (contrato §6) — nunca existe PIN padrão.
    if (!(await pinSaida.obter(client))) {
      throw Object.assign(new Error('defina o PIN de saída do Player (Rede → PIN de saída) antes de instalar uma TV'), {
        status: 409,
      });
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
  buscarComPonto,
  buscarLinha,
  buscarPorId,
  paraAdmin,
  listarPorPonto,
  listarTodos,
  listarComProblemaDeSinal,
  criar,
  atualizar,
  temExibicaoConfirmada,
  deletar,
  gerarCodigo,
  trocarCodigoPorCredencial,
  fecharJanelaDoToken,
};
