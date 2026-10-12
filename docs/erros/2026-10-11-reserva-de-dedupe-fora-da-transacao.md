# Reserva de idempotência gravada fora da transação do efeito

**Sintoma.** Webhook `criada` (primeiro ciclo pago) chega; a instância grava
as chaves de dedupe em `webhooks_processados` e morre (deploy, OOM, banco
fora) antes do `COMMIT` do ciclo. A retomada pela inbox, a conciliação diária
e o botão "Aplicar este ciclo" do admin encontram a chave gravada e tratam o
pagamento como já aplicado. Cliente pagou, conta sem cobertura, zero rastro —
só SQL manual recupera (AUD-005 da auditoria técnica, 11/10/2026).

**Causa raiz.** A reserva de idempotência era um `INSERT` autocommit, separado
da transação que aplica o efeito. Reserva e efeito tinham destinos
independentes: a reserva sobrevivia a um efeito que caiu. A compensação em
memória (`DELETE` no `catch`) só cobre erro lançado — não cobre processo
morto nem conexão perdida.

**Correção.** A reserva vai DENTRO da transação do efeito, com o mesmo
client (`aplicarCicloPago`, a lista `reservas`): `INSERT … ON CONFLICT DO
NOTHING` depois do `FOR UPDATE`; conflito = já aplicado → as reservas são
desfeitas (savepoint) e volta `{ jaAplicada }`; falha = a reserva cai junto
com o efeito. Decisão que não credita (conta excluída, intenção cancelada)
devolve outro marcador, `{ pendenciaJaRegistrada }` — com o mesmo, uma
`cobranca_confirmada` reentregue abria por cima a pendência "descartado pela
deduplicação" de um ciclo que nunca entrou (3ª rodada, 12/10/2026). Vale
para os três caminhos que creditam
(webhook, conciliação, "Aplicar este ciclo"): nenhum reserva antes, a
conciliação só LÊ a chave; e a pendência de "intenção cancelada paga" da
conciliação grava chave e pendência numa transação só. Os `DELETE`
compensatórios desses caminhos saíram — não há mais o que compensar.

**Guarda.** `tests/webhook-inbox.test.js` — "11c. ciclo pago: processo morre
entre a reserva e o COMMIT — a retomada da inbox credita o ciclo" e "11d.
conciliação: processo morre entre a reserva e o COMMIT — a próxima varredura
aplica o ciclo"; `tests/assinatura-pendente.test.js` — "`cobranca_confirmada`
de conta excluída entregue duas vezes gera UMA pendência".

**Como evitar na origem.** Chave de idempotência é parte do efeito, não um
passo anterior a ele: ou entra na mesma transação, ou o desenho precisa provar
o que acontece quando o processo morre entre os dois. "Liberar em erro" não é
prova — processo morto não executa `catch`.

**Ecossistema:** sim — vale para qualquer consumidor de webhook do Checkout
que deduplique antes de gravar o efeito.
