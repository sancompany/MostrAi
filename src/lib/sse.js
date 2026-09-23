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
// limite: mapa em memória de processo único — com mais de uma instância do
// serviço (ver docs/PENDENCIAS.md, "2 instâncias"), um evento gerado numa
// instância não chega em quem está conectado na outra; hoje o serviço roda
// numa instância só, então isso não se aplica ainda. Caminho de upgrade:
// Postgres LISTEN/NOTIFY (mesma base de dados do projeto, sem infra nova)
// se um dia virar 2+ instâncias — o cliente nunca fica ERRADO por causa
// disso, só atrasa até o próximo resync (visibilitychange/reconexão).

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
function emitirParaConta(contaId, evento, dado = {}) {
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

function contaTemClientes(contaId) {
  return clientesPorConta.has(contaId);
}

module.exports = { registrarCliente, removerCliente, emitirParaConta, contaTemClientes };
