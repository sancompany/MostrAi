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

## Decisões de 15/11/2026 (revisão dos PRs #150–#152)

1. **Capacidade comercial** = soma de **todos** os lotes dos tipos ativos da
   edição, inclusive os encerrados. A sobra não vendida dos encerrados aparece
   à parte e não é transferida automaticamente para outro lote.
2. **Nome do comprador na portaria:** aprovado, junto ao do titular. CPF e
   e-mail continuam ocultos.
3. **Recompensa de operador indicador** (ingresso dele é cortesia, sem
   pedido): entregue **exclusivamente pelo Admin**. O sistema não a apresenta
   como disponível para retirada na portaria (a portaria não a mostra nem a
   entrega; a área do operador diz "entrega pelo Admin, não na portaria"; o
   Admin → Recompensas marca "só pelo Admin").
4. **Campanhas (§3):** antes de implementar, o desenho técnico completo vai
   para aprovação do dono. Nada da fase começa sem ela. Padrão do projeto:
   desenvolvimento por fases, com aprovação antes de cada etapa sensível.

## Decisões de 16/11/2026 — campanhas (C1–C7)

- **C1.** O ingresso ocupa posição em **todas** as campanhas em que se
  qualifica, mesmo não acumuláveis; recebe só a recompensa da campanha
  vencedora (regras de prioridade).
- **C2.** Quem já atingiu e **retirou** o prêmio de um nível recebe também o
  do nível superior ao alcançá-lo. Prêmio entregue nunca é revogado. Cada
  nível tem controle próprio de concessão, entrega e unicidade.
- **C3.** Limite por pessoa conta pela **conta compradora**, não pelo titular.
- **C4.** A janela da campanha usa o **horário efetivo da confirmação do
  pagamento**.
- **C5.** O benefício de lote fica com o funcionamento próprio; promoções
  novas de "primeiros N"/posição de compra vão para Campanhas, com aviso claro
  no cadastro do benefício de lote.
- **C6.** Pagamento confirmado durante a pausa não ocupa posição; na retomada
  a contagem continua da próxima posição, sem reutilizar posições.
- **C7.** Textos e regulamentos das campanhas passam por revisão jurídica
  antes da primeira publicação pública.

Direção arquitetural do desenho (`docs/trimundi/specs/2026-11-15-campanhas-desenho.md`)
aprovada com condições: posições imutáveis; idempotência de pagamentos e
webhooks; prevenção de recompensas duplicadas; histórico imutável e
auditável; reembolso sem transferência de posição; preservação das tabelas
antigas; nenhuma migration destrutiva sem autorização; nenhum merge ou deploy
sem autorização. Implementação só depois da revisão final do documento
completo (versão 2), em 4 PRs na ordem proposta.

## Decisões de 16/11/2026 — R1–R3 e autorização da fase de Campanhas

- **R1.** Não permitir duas campanhas de indicação **não acumuláveis ativas**
  ao mesmo tempo na mesma edição. O Admin bloqueia a ativação da segunda e
  informa que já existe outra ativa. Ordem de compra e acumuláveis seguem as
  regras já aprovadas.
- **R2.** O horário oficial é o instante em que a TICK **aplica** a
  confirmação do pagamento; ele define a ordem das posições e a entrada na
  janela. A hora informada pelo Checkout é preservada só para auditoria e
  investigação de atrasos, sem alterar a classificação.
- **R3.** O limite por pessoa conta só recompensas **válidas** (de pé). Se uma
  for revogada por reembolso, a pessoa pode voltar a recebê-la numa compra
  futura, cumprindo de novo as regras; o histórico da concessão e da
  revogação fica preservado.

Com R1–R3, as regras comerciais da fase de Campanhas estão aprovadas.
Autorizado o **PR 1 (banco de dados e regras de negócio, sem telas novas)**,
em rascunho, com testes específicos para: ativação concorrente de campanhas
de indicação; webhooks atrasados e reprocessados; pagamentos durante pausa e
encerramento; reembolso e nova compra; progressão e regressão de níveis;
indicações simultâneas; esgotamento simultâneo de estoque; integridade das
posições e do histórico. Tabelas antigas preservadas, nenhuma remoção ou
migração destrutiva, nada em produção sem autorização expressa.

## Promoção de preço em ingresso individual (pedido do dono, 16/11/2026)

Escopo acrescentado à fase de Campanhas: promoção de preço em ingresso
individual (sem combo), com percentual, valor fixo ou preço promocional,
quantidade promocional, início/fim, pausa e encerramento; "relâmpago" como
destaque com encerramento obrigatório. Os combos (2 a 20 ingressos) seguem
como estão, em Admin → Combos. Mesma estrutura de Campanhas e mesma
confirmação de pagamento — sem mecanismo paralelo de desconto.

### Pendências comerciais abertas (regra 11: nada inventado — o comportamento
### mais conservador foi implementado e fica aqui para o dono confirmar)

- **P1. Unidade promocional de ingresso reembolsado** NÃO volta para a
  quantidade promocional (aplicação, por analogia, da regra 1 — "não passa
  para o próximo"). Reserva vencida sem pagamento volta (nunca foi vendida).
- **P2. Desconto × outras campanhas.** Dois descontos nunca se somam no mesmo
  ingresso (vale o menor preço; empate: prioridade, depois a mais antiga). Um
  desconto **não acumulável** conta como a campanha vencedora do ingresso:
  brinde de campanha não acumulável de primeiros N não vem junto (o ingresso
  ainda ocupa a posição — C1). Desconto acumulável permite os brindes.
- **P3. Preço mínimo com desconto:** R$ 5,00 — o mesmo piso que o sistema já
  exige do preço de lote. Ingresso grátis é cortesia, não desconto.
- **P4. Arredondamento do percentual:** ao centavo, meio centavo para cima.
- **P5. Pagamento que chega depois de a reserva vencer** (pedido com
  desconto): vale a mesma regra do lote — só se a promoção ainda estiver
  aberta (ativa, dentro do prazo) e com quantidade promocional; senão o
  pedido fica "pago sem vaga" e o Admin devolve. (Reserva ainda viva
  mantém o preço combinado, mesmo com a promoção pausada ou encerrada no
  meio.)
- **P7. Limite por pessoa da promoção de preço:** conta pela conta
  compradora (C3) e só o que está de pé (R3, por analogia): ingresso
  reembolsado libera o limite da pessoa, mas não devolve a unidade
  promocional (P1).
- **P6. Regulamento revisado (C7)** é exigido para ativar **toda** campanha
  criada pelo Admin → Campanhas, inclusive as de indicação novas. As
  campanhas de indicação antigas (formato "a cada N", pelas rotas antigas)
  seguem funcionando como antes.
