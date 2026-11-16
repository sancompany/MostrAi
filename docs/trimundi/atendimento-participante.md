# Atendimento ao participante — procedimento (rascunho para aprovação)

> **Rascunho.** O canal e os prazos dependem do Bruno: o e-mail de contato
> próprio (B3) ainda não existe, e hoje vale o contato da Mostraí. Os textos
> jurídicos (Termos v1.3) prevalecem sobre este procedimento.

## Canal

- **E-mail de contato:** [TRIMUNDI_EMAIL_CONTATO — pendente]. Os documentos
  e o rodapé mostram o contato vigente.
- **Prazo de primeira resposta:** [definir].

## Casos frequentes e o que fazer no sistema

| Caso | O que fazer | Onde |
|---|---|---|
| "Não recebi o e-mail do ingresso" | Conferir o pedido e reenviar o link do pedido (o QR também fica na Minha Conta) | Admin → Participantes → abrir o pedido → link do pedido |
| "Não consigo entrar na conta" | Orientar "Esqueci a senha"; se o e-mail não chegar, conferir o endereço | `/ticket/conta` |
| "Paguei e aparece pago sem vaga" | O pagamento chegou depois de a reserva vencer e não havia vaga. Devolver o valor e anotar | Admin → Participantes → "Pagos sem vaga" → Abrir pedido → Reembolsar; Anotar |
| "Quero cancelar" (arrependimento, art. 49) | Conferir o prazo e o caso nos Termos; reembolsar pelo pedido | Admin → Participantes → pedido → Reembolsar |
| "Meu QR deu já utilizado" | Ver quem validou e quando: relatório 13 (Histórico de validações) ou 14 (Tentativas duplicadas, com a 1ª entrada ao lado). Os dois entram no ar com o PR #158; antes disso, a ficha do pedido mostra quando o ingresso entrou (sem o operador) | Admin → Relatórios (depois do #158) · Admin → Participantes → pedido |
| "Não recebi o brinde ou a recompensa" | Ver a situação do prêmio (a retirar, entregue, expirado, revogado) e o histórico | Admin → Recompensas / Campanhas → Detalhes |
| "Trocar o titular do ingresso" | [regra não definida — decidir] | — |
| Pedido de dados pessoais (LGPD) | Exportar ou anonimizar pelo CPF | Admin → Participantes → "Pedido do titular (LGPD)" |
| Contestação no banco (chargeback) | O ingresso fica bloqueado automaticamente; acompanhar no aviso | Admin → Participantes → "Precisa de você" |

## Registro

Toda ação feita pelo Admin fica na auditoria do pedido. Nos casos de "pago
sem vaga", a anotação aparece no histórico do caso.
