# Decisões comerciais — TREEMUNDO / TICK (aprovadas pelo dono em 14/11/2026)

Fonte: resposta do dono à revisão do "Prompt master" (§10 e decisões
adicionais A–K). Vale para campanhas, recompensas, promotores, portaria e
monitoramento de lotes. Nenhuma regra comercial fora desta lista entra no
código sem aprovação do dono; contradição técnica ou comercial encontrada na
construção para só a parte afetada e volta para ele.

## Regras comerciais (§10)

1. **Faixa por ordem de compra:** a posição fica fixa depois do reembolso e
   **não passa para o próximo**.
2. **Escada de indicação:** configurável por campanha; **padrão = só o maior
   nível atingido**.
3. **Ingresso grátis = crédito.** O Admin emite manualmente, como cortesia
   nominal.
4. **Base da comissão:** o valor efetivamente cobrado por ingresso, já com
   descontos e combos, **sem taxas**. Taxa que o San Checkout não informar não
   é inventada (a coluna fica "—").
5. **Novo percentual só para vendas futuras**, incluindo a venda que atingiu a
   nova faixa. Sem retroativo.
6. **O que é "venda":** cada ingresso pago conta uma. Cortesia não conta;
   reembolso desconta.
7. **Contagem por edição**, reinicia a cada edição.
8. **Abaixo de 10 vendas:** comissão provisória. Edição terminando sem 10
   vendas → cancelada, **desde que a condição esteja expressa no termo aceito
   pelo promotor**.
9. **Recrutamento:** link exclusivo; candidatura aprovada pelo Admin; um
   recrutador por pessoa; **sem cadeia**. O recrutador recebe 1 ingresso em
   crédito quando o recrutado atinge 10 vendas na mesma edição.

### Percentuais de comissão (por edição, ingressos pagos)

| Vendas | 10 | 20 | 30 | 40 | 50 | 60 |
|---|---|---|---|---|---|---|
| Comissão | 10% | 11% | 12% | 13% | 14% | 15% (teto) |

Os níveis 10, 20, 40 e 60 também funcionam como **selos de reconhecimento**,
sem substituir os degraus de comissão.

## Decisões adicionais

- **A.** Reembolso de indicado reduz o progresso e revoga a recompensa ainda
  não entregue (a entregue fica registrada).
- **B.** Os 7 operadores existentes (produção, 14/11/2026) ficam
  **exclusivamente com a permissão de portaria**. "Promotor" é permissão
  independente, concedida pelo Admin. **Sem comissão retroativa.**
- **C.** Pagamento de comissão manual, registrado pelo Admin (data, meio,
  referência); o promotor acompanha o status. **Antes de ativar pagamentos
  reais:** apresentar ao dono os requisitos de dados pessoais, privacidade e
  documentação fiscal para validação.
- **D.** Alertas de lote só no painel na primeira versão.
- **E.** Capacidade comercial = **soma dos lotes cadastrados e ativos da
  edição**. Sobra de lote encerrado não migra sozinha para outro lote;
  mudança manual do Admin, com auditoria.
- **F.** Validade do ingresso na portaria = data e horário da edição.
- **G.** Campo opcional de pulseira no tipo de ingresso (cor ou código).
- **H.** Recompensas de indicação aparecem na leitura do ingresso principal do
  indicador e podem ser entregues pela portaria, com registro de quem
  entregou e quando.
- **I.** Cada ingresso pago ocupa uma posição individual na faixa, mesmo com
  vários no mesmo pedido.
- **J.** Padrão sem acumulação entre campanhas: vale a de maior valor. O Admin
  pode habilitar acumulação por campanha, com regras claras e sem
  duplicidade de recompensa.
- **K.** After-fest e sorteios **fora desta versão** até revisão jurídica.

## Ordem de construção autorizada

1. Portaria (§6) — `RN-T39`.
2. Desempenho dos lotes (§7).
3. Reorganização do Admin (§9).
4. Campanhas, recompensas e promotores — seguindo as regras acima.

Cada fase: branch própria, PR em rascunho, testes automatizados, auditoria
quando envolver dinheiro, ingresso, recompensa, permissão ou titularidade.
Sem merge nem deploy sem autorização expressa do dono.
