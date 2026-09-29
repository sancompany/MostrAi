const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');

// Quem recebe um comunicado (Admin → Visão geral, 29/09/2026). A régua é UMA
// só e mora aqui: a contagem que o admin vê antes de enviar, a lista que o
// envio usa, o reenvio de falhas e a conferência na hora de cada e-mail sair
// (src/comunicados/envio.js) montam o SQL com os mesmos pedaços abaixo — o
// número confirmado na tela é, por construção, o número que sai.
//
// Fica DE FORA de todo público (decisões registradas em .ia/DECISIONS.md e
// docs/funcional.md, RN-64):
//   · conta excluída (`excluido_em`) e anonimizada (`anonimizada_em`, e-mail
//     trocado por `excluida-<id>@anonimo.mostrai.invalid`);
//   · a conta própria da Mostraí (`conta_propria`) — é a caixa da empresa;
//   · conta SUSPENSA: login recusado e sessão derrubada
//     (src/anunciantes/routes.js#derrubarSessaoSuspensa), nada dela vai ao ar;
//     aviso sobre o funcionamento de uma plataforma que ela não pode usar não
//     tem o que pedir. A volta dela já tem e-mail próprio (conta_reativada);
//   · e-mail NÃO CONFIRMADO: o endereço nunca foi provado (pode ser erro de
//     digitação de outra pessoa) e o painel inteiro fica travado até a
//     confirmação — é a mesma régua das boas-vindas, que só saem DEPOIS de
//     confirmar (POST /anunciantes/me/confirmar-email);
//   · quem desmarcou "Quero receber novidades e ofertas da Mostraí por
//     e-mail" no perfil (`comunicacoes_revogado_em`, migration 025): o texto
//     do comunicado é livre e o sistema não tem como garantir que é só aviso
//     operacional — então quem pediu pra não receber, não recebe;
//   · e-mail tecnicamente inválido (mesma regra de `emailValido` do cadastro,
//     mais o domínio reservado `.invalid`).
// Endereço repetido sai UMA vez (DISTINCT ON no SQL e de novo no JS).

const PUBLICOS = {
  todas: {
    rotulo: 'Todas as contas ativas',
    descricao: 'Toda conta ativa que recebe comunicados.',
  },
  com_plano: {
    rotulo: 'Contas com plano ativo',
    descricao: 'Plano dentro da validade hoje — pago ou benefício, a mesma régua da Visão geral.',
  },
  sem_plano: {
    rotulo: 'Contas sem plano',
    descricao: 'Nunca teve plano ou o plano venceu.',
  },
  donos_de_ponto: {
    rotulo: 'Donos de ponto',
    descricao: 'Contas com ponto aprovado na rede (candidatura em análise não conta).',
  },
};

const existe = (publico) => Object.hasOwn(PUBLICOS, String(publico || ''));
const lista = () => Object.entries(PUBLICOS).map(([id, p]) => ({ id, ...p }));

// Mesma regra de `emailValido` (src/anunciantes/routes.js) no SQL, mais o
// TLD reservado `.invalid` (RFC 2606) do e-mail de conta anonimizada e sem
// separador de lista de endereços (`,` `;` `<` `>` `"`): um valor desses
// poderia virar mais de um destinatário no cabeçalho.
const EMAIL_VALIDO_SQL = `(a.contato_email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
  AND a.contato_email !~ '[,;<>"]'
  AND length(a.contato_email) <= 254 AND lower(a.contato_email) NOT LIKE '%.invalid')`;

// Conta de cliente de verdade (fora: apagada, anonimizada, a da Mostraí).
const CONTA_DE_CLIENTE_SQL = 'a.excluido_em IS NULL AND a.anonimizada_em IS NULL AND NOT a.conta_propria';

// Conta de cliente que RECEBE comunicado hoje.
const CONTA_RECEBE_SQL = `${CONTA_DE_CLIENTE_SQL}
  AND NOT a.suspenso
  AND a.email_confirmado
  AND a.comunicacoes_revogado_em IS NULL
  AND ${EMAIL_VALIDO_SQL}`;

// "Plano ativo" é a situação 'ativo' da Visão geral (src/admin/routes.js):
// plano gravado e dentro da validade pela régua de Matão (RN-32-B).
const PLANO_ATIVO_SQL = `(a.plano_id IS NOT NULL AND ${vigencia.vigenteSql('a.data_expiracao')})`;

// Dono de ponto = tem ponto materializado que não foi arquivado (regra
// canônica de src/pontos/routes.js: nunca candidatura, nunca o papel legado).
const CRITERIO_SQL = {
  todas: 'true',
  com_plano: PLANO_ATIVO_SQL,
  sem_plano: `NOT ${PLANO_ATIVO_SQL}`,
  donos_de_ponto: `EXISTS (SELECT 1 FROM pontos p WHERE p.anunciante_id = a.id AND p.status <> 'arquivado')`,
};

// Só testes: prefixo do e-mail das contas que entram no público. Os arquivos
// de teste rodam em paralelo contra o mesmo banco, e cada um só pode mandar
// comunicado pras contas que ele mesmo criou (mesmo desenho do `escopo` da
// outbox). Em produção é sempre null — nada fora do teste mexe nisto.
const config = { escopo: null };
const ESCOPO_SQL = (n) => `($${n}::text IS NULL OR lower(a.contato_email) LIKE $${n} || '%')`;

const normalizar = (email) =>
  String(email || '')
    .trim()
    .toLowerCase();

// Um por endereço, mantendo a primeira ocorrência. O SQL já entrega sem
// repetição (DISTINCT ON) — isto é a segunda trava, barata, antes da fila.
function semRepetidos(destinatarios) {
  const vistos = new Set();
  return destinatarios.filter((d) => {
    const chave = normalizar(d.email);
    if (!chave || vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

function criterio(publico) {
  if (!existe(publico)) throw Object.assign(new Error('público de comunicado desconhecido'), { status: 400 });
  return CRITERIO_SQL[publico];
}

// A lista do envio: [{ anuncianteId, email }]. A contagem que a tela mostra
// é o tamanho DESTA lista (nunca a lista em si — o navegador não recebe
// endereço nenhum).
async function listarDestinatarios(publico, db = pool) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (lower(trim(a.contato_email))) a.id AS anunciante_id, trim(a.contato_email) AS email
       FROM anunciantes a
      WHERE ${CONTA_RECEBE_SQL}
        AND ${criterio(publico)}
        AND ${ESCOPO_SQL(1)}
      ORDER BY lower(trim(a.contato_email)), a.id`,
    [config.escopo],
  );
  return semRepetidos(rows.map((r) => ({ anuncianteId: r.anunciante_id, email: r.email })));
}

// Quantas contas do público ficaram de fora, e por quê — só números, pra o
// admin entender a diferença entre "contas" e "destinatários". Cada conta
// conta num motivo só (o primeiro que se aplica, na ordem abaixo).
async function contarForaDoEnvio(publico, db = pool) {
  const { rows } = await db.query(
    `SELECT
        COUNT(*) FILTER (WHERE a.suspenso)::int AS suspensas,
        COUNT(*) FILTER (WHERE NOT a.suspenso AND NOT a.email_confirmado)::int AS email_nao_confirmado,
        COUNT(*) FILTER (WHERE NOT a.suspenso AND a.email_confirmado
                           AND a.comunicacoes_revogado_em IS NOT NULL)::int AS nao_querem_receber,
        COUNT(*) FILTER (WHERE NOT a.suspenso AND a.email_confirmado
                           AND a.comunicacoes_revogado_em IS NULL AND NOT ${EMAIL_VALIDO_SQL})::int AS email_invalido
       FROM anunciantes a
      WHERE ${CONTA_DE_CLIENTE_SQL}
        AND ${criterio(publico)}
        AND ${ESCOPO_SQL(1)}`,
    [config.escopo],
  );
  const r = rows[0];
  return {
    suspensas: r.suspensas,
    emailNaoConfirmado: r.email_nao_confirmado,
    naoQueremReceber: r.nao_querem_receber,
    emailInvalido: r.email_invalido,
  };
}

// Conferência na hora de sair (e no reenvio): a conta AINDA recebe, e o
// endereço da fila ainda é o login dela? Não repete o critério do público
// (plano, ponto) — quem estava no público quando o admin enviou continua
// destinatário; só sai quem deixou de poder receber qualquer comunicado.
async function contaAindaRecebe(anuncianteId, email, db = pool) {
  if (!anuncianteId) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM anunciantes a
      WHERE a.id = $1 AND ${CONTA_RECEBE_SQL} AND lower(trim(a.contato_email)) = lower(trim($2))`,
    [anuncianteId, email],
  );
  return rows.length > 0;
}

module.exports = {
  PUBLICOS,
  CONTA_RECEBE_SQL,
  config,
  existe,
  lista,
  semRepetidos,
  listarDestinatarios,
  contarForaDoEnvio,
  contaAindaRecebe,
};
