# Ponto fechado virava dívida no banco de horas

**Sintoma (reproduzido por `tests/saldo-veiculacao.test.js`, testes 1–2, antes
da correção).** Um dia inteiro com TODA a entrega do horário aberto (08–18)
confirmada fechava o mês com 120 exibições (30 min) de "saldo" a devolver.
Nenhuma exibição tinha faltado.

**Causa raiz.** O Player pede playlist a noite toda (só não toca com a loja
fechada), e o gerador gravava a programada comercial em toda hora pedida,
aberta ou fechada. O não confirmado de cada hora fechada voltava como
"déficit da hora anterior" (RN-10) na hora seguinte, a madrugada inteira,
somando; na abertura (ou antes) o pedido passava da hora e era cortado
(RN-30), e a apuração mensal contava o cortado como capacidade que não
coube. A Mídia Mostraí já não gravava em hora fechada (27/09/2026); o
comercial ficou de fora daquela correção.

**Correção (estação do Saldo de Veiculação, migration 100).** Hora sem minuto
aberto não grava linha comercial nenhuma (nem obrigação, nem programada,
nem banco) e a reposição não rola pra dentro dela; hora parcial deve só os
minutos abertos; a apuração passou a ser obrigação × comprovante, em tempo.

**Regra.** O que o Player PEDE não é o que o ponto DEVE. Toda contagem de
obrigação passa pelo horário do ponto (`src/lib/operacao-tela.js`) — a mesma
régua que apaga a tela. Mapa e invariantes:
`docs/specs/2026-09-27-saldo-de-veiculacao.md`.
