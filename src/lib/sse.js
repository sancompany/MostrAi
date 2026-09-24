// Barramento de eventos em tempo real (Server-Sent Events) — 23/09/2026,
// reconstrução do painel da conta. SSE e não WebSocket: o fluxo é sempre
// servidor→navegador ("isso mudou, refaça o GET"), nunca o contrário, e
// EventSource já reconecta sozinho no navegador sem código extra — WebSocket
// exigiria reimplementar isso à mão pra um ganho que este projeto não usa
// (não há nada que o cliente precise mandar pelo mesmo canal).
//
// O evento é sempre leve: tipo + o mínimo pra quem recebe saber o que
// refazer (nunca o dado inteiro). Quem recebe busca o estado canônico de
// novo — o servidor nunca empurra a verdade, só avisa que ela mudou. Isso
// também evita vazar dado sensível no payload do evento.
//
// Duas instâncias em produção (Northflank, `instances: 2`, item 4 de
// docs/PENDENCIAS.md, concluído) — um Map em memória sozinho não bastava:
// evento gerado na instância A nunca chegava em quem estava conectado na B.
// Fan-out por Postgres LISTEN/NOTIFY (mesma base do projeto, sem infra
// nova): publicar usa `pg_notify()` numa query comum do pool (qualquer
// conexão serve, inclusive pooled); assinar exige uma conexão própria e
// duradoura — por isso um `pg.Client` dedicado, fora do pool, nunca
// devolvido. Conferido em 23/09/2026 que a connection string de produção
// (Supabase Supavisor, porta 5432) é "session mode", que suporta
// LISTEN/NOTIFY — a porta 6543 (transaction mode) não suportaria
// (https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO).
// Se o NOTIFY falhar ou o LISTEN cair, o evento ainda entrega local (quem
// está conectado NESTA instância) — só quem está na outra instância atrasa
// até o próximo resync (visibilitychange/reconexão), nunca fica errado.
//
// Desligado em teste (NODE_ENV=test): uma conexão dedicada + timer de
// reconexão ficam abertos pra sempre, e o `node --test` não termina o
// processo sozinho com handle pendente — achado real rodando a suíte depois
// de ligar isto.

const { Client } = require('pg');
const pool = require('../db/pool');
const dbConfig = require('../db/connection-config');

const CANAL = 'sse_conta';
const clientesPorConta = new Map(); // contaId -> Set<res>

function registrarCliente(contaId, res) {
  if (!clientesPorConta.has(contaId)) clientesPorConta.set(contaId, new Set());
  clientesPorConta.get(contaId).add(res);
}

function removerCliente(contaId, res) {
  const set = clientesPorConta.get(contaId);
  if (!set) return;
  set.delete(res);
  if (!set.size) clientesPorConta.delete(contaId);
}

// Isolamento entre contas por desenho: só escreve nas respostas HTTP que
// estão registradas para ESSA conta — nunca existe um broadcast geral.
function emitirLocal(contaId, evento, dado) {
  const set = clientesPorConta.get(contaId);
  if (!set?.size) return;
  const linha = `event: ${evento}\ndata: ${JSON.stringify(dado)}\n\n`;
  for (const res of set) {
    try {
      res.write(linha);
    } catch {
      // Conexão morta escreve e falha; o listener 'close' do handler já
      // cuida de remover do mapa — não precisa fazer de novo aqui.
    }
  }
}

// Entrega pra quem está conectado NESTA instância na hora, e publica no
// canal pra alcançar as outras. Nunca lança — quem chama (rotas, webhooks)
// não pode falhar por causa de um aviso em tempo real.
function emitirParaConta(contaId, evento, dado = {}) {
  emitirLocal(contaId, evento, dado);
  pool
    .query('SELECT pg_notify($1, $2)', [CANAL, JSON.stringify({ contaId, evento, dado })])
    .catch((err) => console.error('sse: não deu pra publicar no canal (outras instâncias não recebem)', err.message));
}

// Canal do ADMIN (Player V2, 23/09/2026): a Rede muda sem ninguém do admin
// clicar em nada — hello, heartbeat, erro, config aplicada. Mesmo desenho do
// canal por conta (evento leve, quem recebe refaz o GET), um conjunto só,
// porque todo admin logado pode ver toda a rede.
const clientesAdmin = new Set();
const registrarAdmin = (res) => clientesAdmin.add(res);
const removerAdmin = (res) => clientesAdmin.delete(res);

function emitirLocalAdmin(evento, dado) {
  if (!clientesAdmin.size) return;
  const linha = `event: ${evento}\ndata: ${JSON.stringify(dado)}\n\n`;
  for (const res of clientesAdmin) {
    try {
      res.write(linha);
    } catch {
      // idem emitirLocal: o 'close' remove.
    }
  }
}

function emitirParaAdmin(evento, dado = {}) {
  emitirLocalAdmin(evento, dado);
  pool
    .query('SELECT pg_notify($1, $2)', [CANAL, JSON.stringify({ admin: true, evento, dado })])
    .catch((err) => console.error('sse: não deu pra publicar no canal do admin', err.message));
}

function contaTemClientes(contaId) {
  return clientesPorConta.has(contaId);
}

// ---------- assinatura do canal (LISTEN), pra fan-out entre instâncias ----------

let listenClient = null;
let reconectAgendado = false;

async function iniciarListener() {
  const cliente = new Client(dbConfig);
  listenClient = cliente;
  cliente.on('notification', (msg) => {
    if (msg.channel !== CANAL) return;
    try {
      const { admin, contaId, evento, dado } = JSON.parse(msg.payload);
      if (admin) emitirLocalAdmin(evento, dado);
      else emitirLocal(contaId, evento, dado);
    } catch (err) {
      console.error('sse: payload de NOTIFY ilegível', err.message);
    }
  });
  cliente.on('error', (err) => {
    console.error('sse: conexão do LISTEN caiu, reconectando em 5s', err.message);
    reconectar();
  });
  try {
    await cliente.connect();
    await cliente.query(`LISTEN ${CANAL}`);
  } catch (err) {
    console.error('sse: não deu pra abrir o LISTEN agora, tentando de novo em 5s', err.message);
    reconectar();
  }
}

function reconectar() {
  if (reconectAgendado) return;
  reconectAgendado = true;
  if (listenClient) {
    const antigo = listenClient;
    listenClient = null;
    antigo.removeAllListeners();
    antigo.end().catch(() => {});
  }
  setTimeout(() => {
    reconectAgendado = false;
    iniciarListener();
  }, 5000).unref();
}

if (process.env.NODE_ENV !== 'test') iniciarListener();

module.exports = {
  registrarCliente,
  removerCliente,
  emitirParaConta,
  contaTemClientes,
  registrarAdmin,
  removerAdmin,
  emitirParaAdmin,
};
