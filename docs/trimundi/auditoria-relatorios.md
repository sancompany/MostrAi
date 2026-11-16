# Auditoria dos 15 relatórios administrativos (§8 do prompt master) — 16/11/2026

**Requisito (§8):**
- relatórios completos, com filtros por evento, edição, lote, tipo e operador;
- exportação CSV.

O que segue é o estado **conferido no código da `main` (`749f89a`)**, e não
o que se lembra dele.

## Definições únicas (para não haver número divergente entre telas)

- **Vendido:** ingresso `origem = 'pago'` de pedido `origem = 'venda'` com o
  pedido `pago`, e ingresso não cancelado. Ficam de fora o pedido de teste
  (RN-T19) e a cortesia (decisão 6). Reembolso tira o ingresso da conta.
- **Receita do ingresso:** `ingressos.valor_centavos`, o valor efetivamente
  pago, já com desconto ou rateio do combo, sem taxas (regra 4).
- **Disponível:** o estoque real (`disponibilidade.carregarLotes`): lote
  aberto menos pagos e reservas vivas.
- **Conversão de indicação:** a mesma definição de `desempenho.js`. Pedido
  de venda pago, com indicador e com ao menos um ingresso de pé.

## Situação de cada relatório

| # | Relatório | Situação | Onde está hoje | Filtros hoje | CSV | O que falta |
|---|---|---|---|---|---|---|
| 1 | Vendas por promoter | **não existe** | Base parcial: desempenho do operador por link (`/operadores/:id/desempenho`) | edição | não | Depende do módulo Promoters |
| 2 | Vendas por lote | **incompleto** | Admin → Lotes (`desempenho-lotes`): vendidos, reservados, disponíveis, % | edição | não | Receita do lote, filtro por tipo, CSV |
| 3 | Vendas por tipo de ingresso | **incompleto** | Admin → Lotes, agrupado por tipo na tela | edição | não | Totais por tipo no servidor, receita, CSV |
| 4 | Vendas por link de indicação | **existe** | Admin → Indicações: ranking (pessoas, compras, ingressos) | edição | **sim** (`ranking.csv`) | Receita; filtro por tipo de indicador |
| 5 | Clientes indicados | **incompleto** | Por indicador (ficha do operador ou do comprador); sem lista consolidada | edição | não | Lista consolidada (quem indicou quem, situação), sem CPF, com CSV |
| 6 | Campanhas com maior conversão | **incompleto** | Admin → Campanhas mostra os números de cada uma | edição | posições por campanha | Ranking por conversão: posições premiadas, prêmios entregues, unidades com desconto vendidas |
| 7 | Recompensas concedidas | **incompleto** | Admin → Recompensas (indicação, primeiros N, benefícios), com totais | edição | não | Filtro por situação, CSV |
| 8 | Recompensas entregues | **incompleto** | Idem (situação "entregue", com operador e horário) | edição | não | Idem |
| 9 | Recompensas pendentes | **incompleto** | Idem (situação "a retirar") | edição | não | Idem |
| 10 | Ingressos utilizados | **incompleto** | Admin → Participantes, filtro "utilizados" (lista paginada) | edição, busca | não | Horário e operador da entrada na lista, CSV |
| 11 | Ingressos disponíveis | **existe** | Admin → Lotes (disponíveis por lote e total) | edição | não | CSV |
| 12 | Combos vendidos | **existe** | Admin → Combos (vendidos e disponíveis por combo) | edição | não | Receita, CSV |
| 13 | Histórico de validações | **não existe no Admin** | Dados em `checkins` (aceitas e recusadas, operador, horário, aparelho); o Admin só mostra conflitos do modo sem conexão | — | não | Criar: lista por horário, operador e resultado, com filtro e CSV |
| 14 | Tentativas duplicadas | **não existe no Admin** | Dados em `checkins` (`recusado`, motivo "já utilizado"); a portaria grava a tentativa desde o #150 | — | não | Criar: tentativas recusadas por ingresso, com a 1ª entrada válida, filtro e CSV |
| 15 | Comissões e repasses dos promoters | **não existe** | — | — | — | Depende do módulo Promoters |

### Controle de acesso (todos)

- Rotas sob `/admin/trimundi`: Cloudflare Access mais a sessão do Admin.
  Sem sessão, a resposta é 302/401 (conferido em produção).
- Nenhum relatório mostra CPF inteiro nem e-mail. A lista de participantes
  mascara o CPF.
- Os CSVs neutralizam fórmula (célula que começa com `= + - @` ganha
  apóstrofo) e saem com BOM e `;`.

### Consistência

| Ponto | Situação |
|---|---|
| Pedido de teste | Fica fora de tudo. O painel de lotes passou a respeitar isso no #156, por apontamento do Codex |
| Desconto | O valor do ingresso já é o pago, então receita somada por ingresso bate com o total dos pedidos sem taxas |
| Combo | Cada posição do combo é um ingresso de um lote. Não duplica em "vendas por lote" nem em "por tipo" |
| Cortesia | Não é venda nem receita. Aparece só nos resumos de participantes |

## Plano de construção (PR "Relatórios")

**Uma área "Relatórios"** em Admin → Eventos, com uma camada de consulta
única no servidor (`src/trimundi/relatorios.js`) e uma rota por relatório:
- `GET /admin/trimundi/edicoes/:id/relatorios/:nome`, que devolve JSON;
- `.../:nome.csv`, que devolve o CSV.

**Filtros comuns:**
- lote, tipo e operador (quando fizer sentido);
- período.

O filtro de evento e edição vem do seletor de edição que o Admin já usa.

**Etapa 1** (dados que já existem): relatórios 2, 3, 6, 7, 8, 9, 10, 11, 12,
13 e 14, mais o CSV de 5.

**Etapa 2:** relatórios 1 e 15, junto com o módulo Promoters.

**Regras da construção:**
- nenhum número estimado;
- cada relatório tem teste que confere o total contra a soma dos itens e
  contra o estoque e a receita;
- a tela mostra "sem dados" quando não há dado, nunca zero inventado.
