# Roteiro do teste real de ponta a ponta (produção)

**Quem faz:** Bruno, com dinheiro real (autorização expressa dele). Para a
portaria, também um operador.

**Quem confere:** Claude, pelo banco (só leitura, sem dado pessoal na
conversa) e pelos logs. O resultado de cada passo vai para o
`PLANO-DE-LANCAMENTO.md`.

**Valor:** o ingresso mais barato à venda.

## Já comprovado (11/11/2026)

**Compra por Pix de R$ 25,00:**
- pedido pago;
- 1 aviso do Checkout aplicado;
- 1 ingresso emitido;
- e-mail `pedido_confirmado` enviado.

**Falta:** o check-in desse ingresso.

## 1. Antes

- [ ] Um operador ativo, com acesso à edição. Ele entra em
      `/ticket/entrar` no celular de teste.
- [ ] (Para o passo 3.5) Um benefício cadastrado no tipo de ingresso a ser
      comprado.

## 2. Compra com cartão (B5)

1. Entrar na conta em `/ticket/conta` e abrir a página da edição.
2. Escolher 1 ingresso, aceitar os termos e "Ir para o pagamento".
3. Pagar com cartão no San Checkout.
   - **Conferir na tela de pagamento:** nome empresarial e CNPJ do MEI (B1).
4. **Conferir:**
   - a página do pedido mostra "Pago" e o QR;
   - o e-mail de confirmação chegou e o remetente está certo (B2);
   - a Minha Conta mostra o ingresso.
5. Me avisar. Eu confiro no banco:
   - pedido `pago` e valor cobrado;
   - aviso do Checkout com assinatura válida;
   - ingresso `valido`;
   - e-mail `enviado`.

## 3. Portaria (B7, B8)

Fazer **num Android e depois num iPhone**:

1. O operador entra em `/ticket/entrar`. Leitor aberto, câmera autorizada.
2. **QR do ingresso:** a ficha aparece (titular, comprador, tipo, lote,
   número) e o botão azul **VALIDAR INGRESSO** registra a entrada.
3. **Ler o mesmo QR de novo:** aparece em vermelho **INGRESSO JÁ UTILIZADO —
   ENTRADA NÃO AUTORIZADA**, com a hora e o operador da 1ª entrada.
4. **Sem conexão** (modo avião):
   - baixar o pacote antes, com conexão;
   - ler um ingresso ainda não usado, que deve ser aceito no aparelho;
   - religar a conexão: a entrada sincroniza;
   - um conflito, se houver, aparece em Admin → Participantes.
5. **Benefício:** em "RECOMPENSAS DE <TITULAR>", **CONFIRMAR ENTREGA** fica
   registrado com o operador e o horário. Uma segunda entrega é recusada.
6. Me avisar. Eu confiro o registro das entradas, das tentativas recusadas e
   da entrega (operador e horário).

## 4. Reembolso (B6)

1. Admin → Participantes → abrir o pedido da compra com cartão → "Reembolsar
   pedido", com o motivo.
2. **Conferir:**
   - o Checkout confirma o estorno;
   - o pedido fica "Reembolsado" e o ingresso, cancelado;
   - o QR deixa de valer na portaria.
3. Me avisar. Eu confiro o registro do reembolso, o aviso do Checkout e a
   auditoria.

## 5. Encerramento

Depois dos passos acima, marco B5–B8 como concluídos no plano, com a
evidência.
