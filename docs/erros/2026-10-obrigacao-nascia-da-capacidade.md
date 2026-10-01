# Quem comprava sem tela no ar devia-se zero e via "Em dia"

**Sintoma** (achado na auditoria Review-Master, 01/10/2026; pergunta do
dono: "o que acontece quando alguém paga o plano comercial e não tem nenhum
ponto cadastrado?"). Com a rede vazia — venda de pré-lançamento, decisão do
dono — quem pagava um Pro tinha o plano ativo, recebia 0 h, a Mostraí devia
0 h e o painel mostrava "Em dia". O tempo comprado sumia sem registro.

**Causa raiz.** A obrigação de veiculação nascia da CAPACIDADE da rede, não
do contrato: por tela e por hora aberta, quando a TV pedia a playlist
(`gerador.js#gravarProgramados` → `exibicoes_contador.segundos_obrigacao`) ou
na hora sem sinal de uma tela que já tinha servido a conta
(`bancohoras/obrigacao.js`). O saldo mensal (`banco_horas`) era "obrigação −
entrega". Sem tela, não nascia hora; sem hora, não nascia dívida. O
pagamento só gravava `ciclos_contratados` — usado no custo por exibição,
nunca no saldo.

**Correção** (migration 111, ADR-035, RN-53):

- A compra ou renovação paga lança 100% do ciclo no livro
  `obrigacoes_veiculacao` (Essencial 27 h, Pro 84 h, Prime 180 h por mês,
  lidos do plano), na mesma transação do ciclo, com chave única. Troca,
  benefício e reembolso também viram lançamentos.
- O saldo é derivado: lançamentos − Proof-of-Play confirmado, por FIFO.
  Renovação acumula; vencimento e cancelamento não zeram.
- O tempo em que a campanha está fora por responsabilidade do cliente (sem
  peça válida, peças pausadas por ele) é modelado à parte e sai da dívida; o
  resto (ponto fechado, tela offline, falta de capacidade, peça retirada pelo
  admin, peça em análise) continua dívida da Mostraí.
- O painel mostra contratado × entregue × a entregar e só diz "Em dia" sem
  nada pendente.

**Regra que fica.** O que a empresa DEVE nasce do que ela VENDEU, no momento
da venda — nunca da capacidade de entregar. Capacidade decide o ritmo da
entrega, não o tamanho da dívida. Valor devido é livro (lançamento imutável
e idempotente) + comprovante; saldo é leitura derivada, nunca coluna
recalculada.
Teste: `tests/obrigacao-do-ciclo.test.js` (os 26 casos do pedido) e
`tests/e2e/44-obrigacao-do-ciclo.mjs` (rede vazia → compra → POP →
renovação).
