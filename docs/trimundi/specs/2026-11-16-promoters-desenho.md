# Promoters e comissionamento — desenho técnico (v1, para aprovação)

**Situação:** desenho para aprovação. Nada desta fase foi construído.

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

## 5. Decisões pendentes (do Bruno; algumas pedem advogado ou contador)

| # | Pergunta | Por que importa |
|---|---|---|
| P-1 | **Saldo "liberado"**: quando a comissão provisória passa a liberada? Na 10ª venda? Depois do evento? Depois do prazo de arrependimento (7 dias, art. 49)? | Define o que pode ser pago |
| P-2 | **Reembolso depois de a comissão ser paga**: desconta do saldo futuro? Fica como débito? Não desconta? | O livro precisa da regra de estorno |
| P-3 | **Reembolso que faz cair de faixa**: as vendas seguintes voltam ao percentual menor? | A regra 5 cobre a subida, não a descida |
| P-4 | **Compra do próprio promoter pelo próprio link** conta como venda? | Evita comissão sobre a própria compra |
| P-5 | **Um link de promoter também conta para as campanhas de "Indique e ganhe"?** O mesmo pedido pode render comissão e recompensa de indicação? | O link é o mesmo (`indicadores`) |
| P-6 | **Benefícios por meta** (§5.3): ingresso grátis em 10, acompanhante em 20, VIP e +1 em 40, pulseira preta e open bar em 60 — confirmar a lista. Todos viram cortesia nominal emitida pelo Admin (regra 3)? After-fest está fora (decisão K) | Itens do §5.3 não foram aprovados um a um |
| P-7 | **Revenda de cortesia** (§5.5): pode? Com que controle? O §10 item 9 do prompt não está entre as regras aprovadas | Não construo revenda sem regra |
| P-8 | **Termo do promoter**: o texto (inclui a regra 8) | Advogado |
| P-9 | **Dados para pagar** (CPF, chave Pix, recibo/RPA, retenção de tributos) | Advogado e contador (decisão C) |
| P-10 | **Promoter e operador de portaria podem ser a mesma pessoa?** (permissões separadas, mas a pessoa pode ter as duas) | Desenho de permissão |
