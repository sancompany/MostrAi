# Identidade externa gravada uma vez e nunca comparada

**Sintoma.** O Checkout acha a assinatura pelo par `planoId` + `documento`
(API.md dele, 4.3.4). Cancelar, consultar, trocar e renovar mandavam o
CPF/CNPJ da conta; quando o pagador era outro, o Checkout respondia 404 e a
Asaas seguia cobrando (AUD-006, 11/10/2026). A correção gravou o documento
do pagador (`assinaturas.documento_pagador`, migration 122) — uma vez só.
O pagador que digita OUTRO CPF/CNPJ na pop-up de renovação ganha uma 2ª
recorrência do mesmo plano, sem a 1ª ser cancelada (o token não confere,
API.md 7.3). O webhook creditava a 2ª calado, o documento seguia o antigo,
o "Cancelar" matava a 1ª e a 2ª seguia cobrando (3ª rodada, 12/10/2026).

**Causa raiz.** Um identificador que outro sistema controla foi tratado como
fixo: gravado no primeiro evento e nunca comparado com os seguintes. Junto,
o `cancelada` fechava a assinatura daqui sem olhar o documento — o de uma
recorrência que não é a vigente também fechava (inclusive a pop-up de
renovação fechada sem pagar com outro documento, que pro Checkout é
assinatura nova e manda `cancelada`, API.md 4.3.5). E o aviso de cadastro
divergente ia depois do `COMMIT`: processo morto entre os dois o perdia.

**Correção.** `aplicarCicloPago` compara o documento de todo ciclo pago:
ciclo novo com outro documento passa a valer (é o que cobra) e abre a
pendência `documento_pagador_mudou`, sem "Aplicar este ciclo" — cancelar a
antiga pelo Checkout. Reentrega ou ciclo que já tinha entrado nunca troca o
vigente, mas grava o documento se faltava (savepoint, não `ROLLBACK`). Os
avisos entram na transação do ciclo. `cancelada` com documento diferente do
vigente não fecha a assinatura. O botão "Aplicar este ciclo" credita com o
documento da consulta, nunca o do payload guardado.

**Guarda.** `tests/assinatura-pendente.test.js` — "pagamento com outro
documento na mesma assinatura…", "documento que chega num ciclo já creditado
por outro caminho…", "o aviso de documento divergente entra no COMMIT do
ciclo…", "Aplicar este ciclo usa o documento da consulta…" e "assinatura sem
documento do pagador (legada)…".

**Como evitar na origem.** Dado que o outro sistema define (documento,
cartão, id externo) se confere em todo evento que o traz, não só no
primeiro; e o que identifica o recurso lá decide também qual evento vale
aqui.

**Ecossistema:** sim — vale para qualquer contratante do Checkout que guarde
o documento do pagador.
