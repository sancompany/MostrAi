# Promoters e comissionamento — desenho técnico (v1, para aprovação)

**Situação:** PR 1 (banco e motor) construído em 16/11/2026, só com as regras aprovadas. PR 2 (Admin e relatórios 1 e 15) e PR 3 (painel do promoter e recrutamento) seguem; as perguntas abertas estão na seção 5, com recomendação.

**Fontes:**
- §5 do prompt master;
- regras 4 a 9 e decisões A–K de `decisoes-comerciais-2026-11-14.md`, todas
  aprovadas.

**O que não é inventado aqui:** nenhuma regra de comissão, tributação ou
repasse. O que não está decidido vai para a seção 5, como pergunta.

## 1. O que já existe e é reaproveitado (não reconstruir)

| Peça | Onde | Uso nos promoters |
|---|---|---|
| Link individual de divulgação | `indicadores` (um por cliente ou operador) + `pedidos.indicador_id` (origem fixa da conta na edição, migration 009) | O link do promoter **é** o link de indicador que ele já tem. A atribuição da venda já existe e já é fixa |
| Conversão confirmada | `desempenho.js` (`CONVERSOES`: pedido de venda pago, ingresso de pé) | Base de "venda" do promoter. Cada ingresso de pé conta uma (regra 6) |
| Valor efetivamente pago | `ingressos.valor_centavos` (com desconto e rateio de combo, sem taxa) | Base da comissão (regra 4) |
| Reembolso e cancelamento | `ingressos.status = 'cancelado'` + `reembolsos` | Reembolso desconta a venda (regra 6) |
| Ficha e desempenho do operador | `/admin/trimundi/operadores/:id/desempenho` | Ponto de partida do painel do promoter no Admin |
| Auditoria | `auditar()` | Toda ação do Admin sobre promoter |

## 2. O que é novo

**Tabelas** (migration nova, só acréscimo):
- `promoters`
  - quem: `indicador_id` único, ligado a uma conta de cliente;
  - situação: `candidato` · `provisorio` · `oficial` · `suspenso` ·
    `encerrado`;
  - quem aprovou e quando, e o termo aceito (versão e data);
  - **separado de `operadores`**: promoter não ganha portaria nem vice-versa
    (decisão B).
- `promoter_recrutamentos`: recrutador → recrutado, único por recrutado (um
  recrutador por pessoa e sem cadeia, regra 9).
- `promoter_comissoes`: **livro, só acréscimo**. Uma linha por ingresso
  vendido pelo promoter, com:
  - edição, pedido e ingresso;
  - valor bruto do pedido, valor do ingresso (base), taxas informadas ou "—"
    (regra 4: taxa que o Checkout não informa não se inventa);
  - percentual aplicado, valor da comissão;
  - situação: `provisoria` · `liberada` · `estornada` · `cancelada` · `paga`;
  - estorno por **lançamento novo** (não se apaga nem se edita valor).
- `promoter_pagamentos`: registro manual do Admin (data, meio, referência,
  valor, lançamentos pagos), sem split no Checkout (decisão C).
- `promoter_metas`: selos e benefícios alcançados por edição (10, 20, 40,
  60), com a entrega registrada.

**Percentual** (tabela aprovada, por edição):

| Vendas na edição | 1–9 | 10–19 | 20–29 | 30–39 | 40–49 | 50–59 | 60+ |
|---|---|---|---|---|---|---|---|
| Comissão | 10% (provisória) | 10% | 11% | 12% | 13% | 14% | 15% (teto) |

- **Vale para a venda que muda a faixa e as seguintes, sem retroativo**
  (regra 5).
- **Implementação:** o percentual é calculado e gravado **na confirmação do
  pagamento**, sob a trava da edição. É o mesmo ponto em que nascem as
  posições das campanhas, então a ordem real das vendas decide a faixa.

**Abaixo de 10 vendas:**
- a comissão é provisória;
- a edição terminou sem 10 vendas: comissão cancelada, **se o termo aceito
  pelo promoter disser isso** (regra 8).

**Recrutamento:**
- link exclusivo de recrutamento, candidatura e aprovação pelo Admin;
- quando o recrutado chega a 10 vendas **na mesma edição**, o recrutador
  ganha 1 ingresso em crédito (regra 3: cortesia nominal emitida pelo
  Admin), uma vez por recrutado.

**Painel do promoter** (na Minha Conta, para quem é promoter):
- vendas por lote e por tipo;
- faixa e percentual atual e próxima meta;
- comissão provisória, liberada e paga;
- histórico de pagamentos;
- selos (10/20/40/60);
- benefícios e créditos;
- recrutados.

**Admin:**
- candidaturas (aprovar ou recusar);
- lista de promoters com números;
- livro de comissões;
- registrar pagamento;
- relatórios 1 e 15, com CSV.

## 3. Integridade

| Garantia | Como |
|---|---|
| Uma comissão por ingresso | Índice único `(ingresso_id)` nos lançamentos de origem |
| Reprocessamento do pagamento não duplica | Mesma idempotência das campanhas |
| Reembolso | Lançamento de estorno ligado ao original. A venda deixa de contar para a faixa das **próximas** vendas; o que já foi calculado não muda |
| Pagamento registrado | Não volta atrás; correção por lançamento novo |
| Auditoria | Tudo auditado; CPF e chave Pix nunca em log |

## 4. Entrega em PRs (depois das decisões)

1. **Banco e motor:** tabelas, livro de comissões calculado na confirmação,
   estorno, testes de concorrência e reprocessamento.
2. **Admin:** candidaturas, aprovação, lista, livro, registro de pagamento,
   relatórios 1 e 15 com CSV.
3. **Painel do promoter** e link de recrutamento.
4. **Metas, benefícios e créditos** de recrutamento.

## 5. Decisões pendentes — com recomendação (atualizado em 16/11/2026, PR 1)

O PR 1 (banco e motor) foi construído **sem inventar** nenhuma destas
respostas. Onde o motor precisa de um comportamento, ele faz o mais
conservador, descrito na coluna "Hoje no código". A coluna "Recomendação" é
a minha proposta para a decisão; nada dela entra no código sem aprovação.

| # | Pergunta | Hoje no código (PR 1) | Recomendação | Quem decide |
|---|---|---|---|---|
| P-1 | **Quando a comissão fica liberada para pagar?** | Venda com 10+ vendas de pé na edição aparece como "confirmada". O **registro de pagamento fica desligado** (`TRIMUNDI_PROMOTER_PAGAMENTOS` vazio → 409) | Liberar **depois do fim da edição** (evento realizado) **e** 7 dias depois da compra (art. 49, arrependimento). Assim o reembolso por evento cancelado ou arrependimento acontece antes do pagamento, e P-2 quase nunca ocorre | Bruno |
| P-2 | **Reembolso depois de a comissão ser paga** | O estorno entra no livro e a venda aparece como "estornada após o pagamento". Nada é descontado sozinho | Descontar do **próximo pagamento** do mesmo promoter (compensação), sem cobrança ativa. Sem pagamentos futuros, fica registrado como saldo devedor e o Admin decide | Bruno (e contador) |
| P-3 | **Reembolso que faz cair de faixa** | As **próximas** vendas usam a contagem de pé depois do reembolso. Ex.: com 20 de pé e 1 reembolso, a venda seguinte é a nº 20 de novo. É o que as regras 5 (percentual só para vendas futuras) e 6 (reembolso desconta) já dizem juntas. O que já foi gravado não muda | Confirmar o comportamento atual | Bruno |
| P-4 | **Compra pelo próprio link conta?** | **Não conta.** A regra de indicação que já existe não grava a indicação da própria conta (mesma conta ou mesmo CPF) no pedido, então não há comissão. Testado | Confirmar (já é a regra da indicação) | Bruno |
| P-5 | **O link do promoter também conta para "Indique e ganhe"?** | Hoje contaria, porque o link é o mesmo (`indicadores`). Não há nenhuma campanha de indicação ativa em produção (0 em 16/11) | **Não acumular:** venda que gera comissão não conta para campanha de indicação (um benefício por venda, como a regra J para campanhas). Exige uma linha no motor das campanhas, a fazer depois da decisão | Bruno |
| P-6 | **Benefícios por meta** (10, 20, 40, 60) | Só os **selos** (10/20/40/60) aparecem; nenhum benefício é concedido | Aprovar a lista do §5.3 como **créditos de cortesia nominal emitidos pelo Admin** (regra 3): 10 → 1 ingresso; 20 → +1 acompanhante; 40 → VIP e +1; 60 → pulseira preta e open bar "conforme regulamento". After-fest fora (decisão K). Antes de valer, entra no regulamento/termo (A) | Bruno + advogado |
| P-7 | **Revenda de cortesia** | Não existe | **Não permitir** na v1: a cortesia é nominal e intransferível. Rever depois do advogado | Bruno + advogado |
| P-8 | **Termo do promoter** | O banco guarda a versão e a data do aceite (`termo_versao`), hoje vazias. Minuta em `docs/trimundi/legal/minuta-termo-promoter.md` | Advogado revisar a minuta. A regra 8 (cancelar comissão provisória no fim da edição sem 10 vendas) **só vale se estiver no termo aceito**; até lá, nada é cancelado sozinho | Advogado |
| P-9 | **Dados para pagar** (CPF, chave Pix, recibo/RPA, tributos) | Nada é coletado | Coletar CPF e chave Pix **só no primeiro pagamento**, dentro da conta, com finalidade explícita na Política. RPA e retenção definidos pelo contador. Até lá o pagamento segue desligado | Advogado + contador |
| P-10 | **Promoter e operador de portaria podem ser a mesma pessoa?** | Sim, com permissões separadas: promoter **não** ganha portaria e operador **não** vira promoter (decisão B). A comissão conta só as vendas pelo link **da conta de cliente** do promoter; o link de operador não gera comissão | Permitir as duas permissões na mesma pessoa, como está | Bruno |
