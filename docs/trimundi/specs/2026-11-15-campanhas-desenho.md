# Campanhas (§3) — desenho técnico para aprovação

**Situação:** proposta, 15/11/2026. **Nada desta fase está implementado.** A
implementação só começa depois da aprovação do dono, e as decisões abertas
da seção 13 precisam de resposta antes.

Base: `docs/trimundi/decisoes-comerciais-2026-11-14.md` (regras 1–9, decisões
A–K e as de 15/11). Estado de produção conferido em 14/11: **0 campanhas, 0
recompensas, 0 benefícios, 1 pedido pago** — nenhuma migração de dado real é
necessária.

---

## 0. Princípios

1. **Ordem real = ordem de confirmação do pagamento.** Toda confirmação já
   roda em `pagamentos.aplicar`, que trava a linha da **edição**
   (`SELECT … FROM edicoes … FOR UPDATE`) e depois a do pedido. Assim, as
   confirmações de uma mesma edição já são executadas em fila. A posição é
   atribuída **dentro dessa mesma transação**, e a ordem de commit é a ordem
   das posições. Não é preciso um mecanismo novo de fila.
2. **Tudo idempotente.**
   - Já existe: o evento do Checkout tem id único (`pagamento_eventos.evento_id`)
     e a emissão é única por vaga (`ingressos.reserva_id`).
   - O desenho acrescenta duas travas únicas: posição única por
     (campanha, ingresso) e prêmio único por chave de idempotência.
   - Reprocessar um aviso não muda nada.
3. **Reconciliar em vez de incrementar.** A cada aviso de pagamento, a função
   calcula o estado **desejado** dos prêmios do pedido ou do indicador a
   partir dos fatos (ingressos de pé, indicações válidas) e aplica só a
   diferença. Rodar duas vezes dá o mesmo resultado.
4. **Histórico imutável.** Toda mudança de estado de um prêmio (concessão,
   entrega, revogação, expiração, restauração) grava uma linha só de
   acréscimo, com autor e motivo, além da `auditoria` que já existe.
5. **Reaproveitar sem duplicar.** Continuam como estão:
   - `beneficios`, que vira o catálogo de brindes (nome, descrição, estoque);
   - `indicacoes`, o livro de conversões;
   - a regra `INGRESSO_DE_PE`;
   - a numeração dos ingressos;
   - a entrega única da portaria, que é ampliada;
   - as telas e rotas do Admin.

   O que muda: `campanhas_indicacao` e `recompensas_indicacao` passam para o
   modelo unificado (seção 11).

---

## 1. Modelo de dados

Esquema `trimundi`, em migrations novas. Todas as tabelas com
`ENABLE ROW LEVEL SECURITY`, como as demais.

### 1.1 `campanhas` — a campanha (qualquer modalidade)
| Campo | Tipo | Regra |
|---|---|---|
| `id` | bigserial PK | |
| `edicao_id` | bigint FK `edicoes` | NOT NULL |
| `modalidade` | text | `ordem_compra` \| `indicacao` |
| `nome` | text | 1–80 |
| `descricao` | text | ≤ 1000 |
| `regras` | text | ≤ 5000 — texto público do regulamento da campanha |
| `banner_chave` | text | nulo ou chave do armazenamento (mesmo caminho das imagens da edição) |
| `status` | text | `rascunho` \| `ativa` \| `pausada` \| `encerrada` |
| `inicio`, `fim` | timestamptz | nulos = sem limite; `fim > inicio` |
| `relampago` | boolean | destaque na página de venda |
| `acumula` | boolean | default **false** (decisão J) |
| `prioridade` | int | desempate (maior primeiro) quando o valor empata |
| `escada` | text | só indicação: `maior_nivel` (padrão, regra 2) \| `cumulativa` |
| `limite_por_pessoa` | int | nulo = sem limite; prêmios por pessoa na campanha |
| `prazo_retirada` | timestamptz | nulo = até o fim da edição |
| `inclui_combos` | boolean | default true — ingresso de combo também conta |
| `proxima_posicao` | int | contador da ordem de compra, default 1, só cresce |
| `criado_em`, `atualizado_em`, `encerrada_em` | timestamptz | |

Índices: `(edicao_id, status)`.

**Não** existe mais "uma campanha ativa por edição": o índice
`ux_campanha_ativa` sai. Campanhas simultâneas são permitidas.

### 1.2 `campanha_alvos` — o que participa (ordem de compra)
`campanha_id` FK, `categoria_id` FK nulo, `lote_id` FK nulo;
`CHECK (categoria_id IS NOT NULL OR lote_id IS NOT NULL)`; único por
(campanha, categoria, lote).
- Sem nenhuma linha, vale **todos os tipos e lotes** da edição.
- O lote precisa ser da mesma edição (conferido no servidor).

### 1.3 `campanha_faixas` — faixas (ordem de compra) ou níveis (indicação)
| Campo | Regra |
|---|---|
| `id`, `campanha_id` FK | |
| `ordem` | 1..20, único por campanha |
| `de` | int ≥ 1 — posição inicial (ordem) ou nº de indicações do nível (indicação) |
| `ate` | int nulo — posição final (ordem); nulo em indicação |
| `beneficio_id` | FK `beneficios` (o brinde, mesma edição) |
| `quantidade` | int ≥ 1 — unidades do brinde por prêmio |
| `estoque` | int nulo — teto de prêmios da faixa; nulo = largura da faixa (ordem) / sem teto (indicação) |
| `custo_unitario_centavos` | bigint ≥ 0 — base do "valor" para acumulação e relatórios |

Restrições:
- Na ordem de compra, as faixas não se sobrepõem e `de ≤ ate`.
- Na indicação, `de` cresce estritamente com a `ordem`.
- As duas são conferidas no servidor e por gatilho.

### 1.4 `campanha_posicoes` — posição definitiva (ordem de compra)
| Campo | Regra |
|---|---|
| `id`, `campanha_id` FK | |
| `posicao` | int ≥ 1 |
| `ingresso_id` | FK `ingressos` |
| `pedido_id` | FK `pedidos` |
| `faixa_id` | FK nulo — a faixa em que caiu (nulo = depois da última) |
| `atribuida_em` | timestamptz |

- **Únicos:** `(campanha_id, posicao)` e `(campanha_id, ingresso_id)`.
- **Imutável:** gatilho que impede UPDATE e DELETE, como em `checkins`.
- A posição nunca muda nem passa adiante (regra 1). O estado do ingresso
  (cancelado etc.) é lido do próprio ingresso.

### 1.5 `campanha_premios` — o prêmio concedido (as duas modalidades)
| Campo | Regra |
|---|---|
| `id`, `campanha_id`, `faixa_id` FK | |
| `ingresso_id` | FK nulo — ordem de compra: o prêmio é **do ingresso** |
| `indicador_id` | FK nulo — indicação: o prêmio é **de quem indicou** |
| `beneficio_id`, `nome`, `quantidade` | cópia do brinde no momento da concessão |
| `valor_centavos` | `custo_unitario × quantidade`, congelado |
| `status` | `concedido` \| `entregue` \| `revogado` \| `expirado` |
| `motivo` | por que foi revogado ou expirou |
| `chave` | text **UNIQUE** — idempotência (abaixo) |
| `concedido_em`, `entregue_em`, `entregue_por`, `revogado_em`, `expirado_em` | |

Restrições:
- `CHECK ((ingresso_id IS NULL) <> (indicador_id IS NULL))`.
- `CHECK ((status = 'entregue') = (entregue_em IS NOT NULL))`.
- **Chaves:**
  - ordem de compra: `pos:<campanha>:<ingresso>`;
  - indicação, escada `maior_nivel`: `niv:<campanha>:<indicador>:<faixa>`;
  - indicação, escada `cumulativa`: `niv:<campanha>:<indicador>:<faixa>`, uma por nível.
- **Sem acumulação** (decisão J), um ingresso tem no máximo um prêmio de pé
  entre as campanhas não acumuláveis. Índice único parcial
  `(ingresso_id) WHERE exclusivo AND status IN ('concedido','entregue')`, com
  a coluna `exclusivo` = `NOT campanha.acumula`, congelada.
- **Com acumulação**, nunca o mesmo brinde duas vezes ao mesmo ingresso:
  índice único parcial `(ingresso_id, beneficio_id) WHERE status IN ('concedido','entregue')`.

### 1.6 `campanha_premio_eventos` — histórico (só acréscimo)
`premio_id` FK, `acao` (`concedido`, `entregue`, `revogado`, `expirado`,
`restaurado`), `autor` (`pagamento`, `operador:<id>`, autor do Admin,
`sistema`), `motivo`, `em`. Gatilho imutável. Cada mudança de status grava
uma linha **na mesma transação**.

### 1.7 Relacionamentos
```
edicoes ─< campanhas ─< campanha_faixas >─ beneficios
                 │  └─< campanha_alvos >─ categorias / lotes
                 ├─< campanha_posicoes >─ ingressos, pedidos
                 ├─< campanha_premios  >─ ingressos | indicadores
                 │        └─< campanha_premio_eventos
                 └─< indicacoes (campanha_id passa a apontar para campanhas)
```

---

## 2. Fluxo — campanha por ordem de compra

Exemplo: "1º ao 20º ingresso: Copão; 21º ao 50º: Pulseira; estoque igual à
largura da faixa".

1. **Admin** cria a campanha (rascunho), as faixas e os alvos, e a ativa.
   A ativação confere que as faixas não se sobrepõem, que os brindes são da
   edição e que o período é válido. Tudo vai para a auditoria.
2. **Venda:** nada acontece na compra. Pedido pendente **não** tem posição.
3. **Confirmação do pagamento** (`pagamentos.confirmar`, dentro da trava da
   edição):
   1. `emitirDoPedido` emite os ingressos, como hoje.
   2. **Novo** `campanhas.aoConfirmar(cliente, pedido)`:
      1. Busca as campanhas `ativa` da edição cuja janela contém **agora**
         (hora da confirmação), em `FOR UPDATE` e em ordem de `id`. Assim a
         ordem das travas é sempre a mesma e não há deadlock.
      2. Para cada ingresso pago do pedido (decisão I: cada um ocupa uma
         posição), na ordem da numeração (`pi.ordem`, `r.posicao`):
         - O ingresso entra se o tipo ou lote está nos alvos, e se combo é
           aceito quando o ingresso veio de combo.
         - Cortesia, pedido de teste e `pago_sem_vaga` nunca entram.
      3. Atribui `posicao = proxima_posicao` e incrementa:
         `INSERT … ON CONFLICT (campanha_id, ingresso_id) DO NOTHING`.
         Se o ingresso já tinha posição (reprocessamento), nada muda.
      4. Acha a faixa da posição. Se há estoque na faixa, é candidato a
         prêmio. O estoque conta **todos** os prêmios já concedidos na faixa,
         inclusive revogados: a posição não passa adiante (regra 1).
   3. **Acumulação** (seção 4) decide quais candidatos viram prêmio.
   4. Cria `campanha_premios` com a chave `pos:<campanha>:<ingresso>`
      (`ON CONFLICT (chave) DO NOTHING`) e o evento `concedido`.
4. **Portaria:** o prêmio aparece em "RECOMPENSAS DE <TITULAR>" **no próprio
   ingresso**, com CONFIRMAR ENTREGA (seção 7).
5. **Fim do prazo de retirada:** o prêmio `concedido` vira `expirado`, com
   evento e motivo, pela varredura periódica (que já existe para filas) e
   também na leitura.

---

## 3. Fluxo — campanha por indicação, com níveis

Exemplo: "4 indicações: Copão; 10 indicações: Camiseta", escada padrão
`maior_nivel` (regra 2).

1. **O que conta** continua igual:
   - o pedido **pago** de quem chegou pelo link, com ingresso de pé
     (`INGRESSO_DE_PE`);
   - a mesma pessoa conta uma vez por campanha
     (`ux_indicacao_pessoa`, que já existe);
   - a autoindicação é barrada (regras de 11/11).
2. **A cada aviso de pagamento**, `indicacao.revisarPedido` atualiza a
   conversão do pedido, como hoje. Para **cada** campanha de indicação ativa
   da edição (antes era uma só), chama `campanhas.reconciliarIndicador`.
3. **`reconciliarIndicador(campanha, indicador)`**, com a campanha em
   `FOR UPDATE`:
   1. `n` = indicações válidas do indicador na campanha.
   2. **Escada `maior_nivel`:** o alvo é o maior nível com `de ≤ n`.
      - Se esse nível não tem estoque, desce para o nível imediatamente
        abaixo que tenha.
      - O prêmio desejado é **um**: o desse nível.
   3. **Escada `cumulativa`:** o alvo é um prêmio para cada nível com
      `de ≤ n` e estoque.
   4. Compara o desejado com os prêmios de pé (`concedido` ou `entregue`):
      - o que está faltando é **concedido**;
      - o que sobrou e ainda está `concedido` é **revogado**, com o motivo
        "substituído pelo nível N" ou "indicação reembolsada" (decisão A);
      - o que sobrou e já foi `entregue` **fica** (não se desfaz brinde
        entregue).
   5. O limite por pessoa e o acúmulo entre campanhas (seção 4) se aplicam
      antes de conceder.
4. **Estoque de indicação:** o prêmio revogado **devolve** a unidade ao
   estoque do nível. Indicação não tem "posição", e o brinde não saiu.
5. **Exemplos:**

   | Indicações | Situação | Resultado |
   |---|---|---|
   | 1 | | nada (meta 4) |
   | 4 | | Copão concedido |
   | 10 | Copão ainda não entregue | Copão revogado ("substituído pelo nível 2") e Camiseta concedida |
   | 10 | Copão já entregue | ver decisão aberta **C2** |
   | 9 (um reembolso depois dos 10) | Camiseta não entregue | Camiseta revogada e Copão restaurado (evento `restaurado` na mesma linha, se ela tinha sido revogada) |

6. **Indicador operador:** os prêmios dele são `so_admin` (decisão de 15/11).
   - A portaria não os mostra.
   - A conta dele mostra "entrega pelo Admin, não na portaria".

---

## 4. Campanhas simultâneas: prioridade, acumulação e duplicidade

- **Elegibilidade:** um ingresso ou indicador pode estar em várias campanhas
  ativas ao mesmo tempo.
- **Posição:** na ordem de compra, o ingresso recebe posição em **toda**
  campanha elegível (ver decisão **C1**).
- **Sem acumulação** (padrão, decisão J), entre as campanhas não acumuláveis
  em que o ingresso ou indicador ganharia:
  1. vence a de **maior valor** (`custo_unitario × quantidade` da faixa);
  2. no empate, a de maior `prioridade`;
  3. no empate, a mais antiga (menor id).

  As outras registram a posição sem prêmio, com o motivo "não acumulável —
  valeu a campanha X", visível no Admin.
- **Com acumulação** (o Admin liga por campanha): o ingresso leva os prêmios
  de todas as campanhas acumuláveis, **sem repetir o mesmo brinde**. O índice
  único `(ingresso_id, beneficio_id)` garante isso.
- **Mistura de acumulável e não acumulável:** o grupo das não acumuláveis
  escolhe um vencedor, e as acumuláveis se somam a ele.
- **Duplicidade impossível pelo banco:**
  - um prêmio por chave;
  - no máximo um prêmio exclusivo de pé por ingresso;
  - nenhum brinde repetido por ingresso.

  Se o código tentar duplicar, o banco recusa e a transação desfaz.
- **Benefício do tipo ou do lote** (`ingresso_beneficios`, que já existe) é
  outra coisa: continua como está e não conta para a acumulação de campanhas
  (ver **C5**).

---

## 5. Compras e confirmações simultâneas

| Situação | O que garante |
|---|---|
| Dois pagamentos da mesma edição confirmados no mesmo instante | trava da linha da edição em `pagamentos.aplicar` (já existe): um espera o outro; posições sequenciais pela ordem de commit |
| Duas instâncias do servidor processando a fila | `FOR UPDATE SKIP LOCKED` na fila de avisos (já existe) + trava da edição |
| Corrida no contador `proxima_posicao` | campanha em `FOR UPDATE`; único `(campanha_id, posicao)` como segunda trava |
| Conciliação e webhook chegando juntos | mesma trava da edição; o segundo vê o pedido já pago, `ja_aplicado` |
| Mesma confirmação reenviada | `evento_id` único; ingresso já emitido; posição `ON CONFLICT DO NOTHING`; prêmio por `chave` |
| Ordem das travas | sempre: edição → pedido → campanhas (por id) → faixas; nunca o contrário (sem deadlock) |

A portaria entregando o mesmo prêmio em dois aparelhos: `FOR UPDATE` na
linha do prêmio e `UPDATE … WHERE status = 'concedido'`. O segundo recebe
"já entregue", como já é feito no benefício e na recompensa de indicação
(testado no PR #150).

---

## 6. Cancelamento, reembolso, estorno e prêmio entregue

| Fato | Posição | Prêmio `concedido` | Prêmio `entregue` |
|---|---|---|---|
| Reembolso total ou parcial confirmado (ingresso cancelado) | **fica**, não passa adiante (regra 1) | **revogado** ("ingresso reembolsado") | **fica**, com o evento "ingresso reembolsado após a entrega" (alerta no Admin) |
| Reembolso pedido e ainda não confirmado (ingresso bloqueado) | fica | fica, mas a portaria **não** entrega (ingresso não válido) | — |
| Chargeback (bloqueado) | fica | fica, sem entrega na portaria; vira revogado se virar estorno | fica, com alerta |
| Baixa desfeita (`pendente`) e refeita | fica | fica (a entrega volta quando o ingresso volta a valer) | fica |
| Cancelamento de cortesia | cortesia não tem posição | — | — |
| Indicação perde a validade (reembolso do indicado) | — | reconciliação da seção 3 (revoga, desce de nível) | fica |
| Prazo de retirada vencido | fica | **expirado** | — |

- Toda revogação e expiração grava o motivo e o autor
  (`pagamento`/`sistema`/Admin) em `campanha_premio_eventos`.
- Um prêmio revogado **não volta a ser concedido** pela ordem de compra. A
  posição é fixa e o ingresso foi cancelado.
- Na indicação, o prêmio pode ser **restaurado** se a contagem voltar
  (exemplo da seção 3).

---

## 7. Integração com ingressos, combos, tipos e lotes

- **Ingresso individual:** a unidade de posição e de prêmio da ordem de
  compra.
- **Combo:**
  - cada posição do combo já é um ingresso; cada um recebe sua posição se
    `inclui_combos`;
  - os ingressos do combo entram na ordem da numeração do pedido;
  - a decisão I vale: 3 ingressos do mesmo pedido são 3 posições seguidas.
- **Tipo e lote:** os alvos da campanha (`campanha_alvos`). O lote do
  ingresso é o da reserva, gravado na emissão.
- **Lote encerrado ou esgotado:** não muda nada nas posições já atribuídas.
- **Capacidade comercial e painel de lotes (§7):** não mudam. Campanha não
  mexe em estoque de ingresso.
- **Portaria:**
  - "RECOMPENSAS DE <TITULAR>" passa a listar também os prêmios de campanha
    do ingresso lido (ordem de compra) e os prêmios de indicação no ingresso
    principal, como já é feito hoje;
  - o botão CONFIRMAR ENTREGA usa uma rota só,
    `POST /ticket/api/checkin/premio`;
  - as rotas atuais de benefício e de recompensa ficam (compatibilidade).

---

## 8. Registro da posição definitiva

- **Quando:** na confirmação do pagamento, dentro da transação que emite o
  ingresso. Um ingresso nunca existe "pago e sem posição" numa campanha
  elegível que estava ativa.
- **Como:**
  - `campanha_posicoes` grava (campanha, posição, ingresso, pedido, faixa,
    hora);
  - a tabela é imutável (gatilho) e tem dois únicos;
  - o contador `proxima_posicao` só cresce, e posição nunca se reutiliza.
- **Onde aparece:**
  - Minha Conta: "seu ingresso 2 de 3 ficou na **posição 17** da campanha X";
  - portaria;
  - Admin, na lista de posições com CSV.
- **Ingresso cancelado:** a posição continua na lista, marcada como
  "cancelado", porque o estado vem do ingresso.

---

## 9. Mudanças na confirmação de pagamento e idempotência

São três pontos, todos na transação que já existe:

1. `pagamentos.confirmar`, depois de `emitirDoPedido` e `marcarLotesDoPedido`:
   `await campanhas.aoConfirmar(cliente, pedido)` (seção 2).
2. `pagamentos.aplicar`, depois de `indicacao.revisarPedido`:
   `await campanhas.revisarPedido(cliente, pedido.id)`.
   - Ele reconcilia os prêmios de ordem de compra dos ingressos do pedido:
     revoga o de ingresso cancelado e deixa o resto como está.
   - Ele também reconcilia as campanhas de indicação do indicador do pedido.
   - Roda em **todo** aviso (confirmado, estornado, parcial, chargeback,
     pendente) e é idempotente.
3. `indicacao.revisarPedido`: troca a "campanha ativa (uma)" por "campanhas de
   indicação ativas" e delega o cálculo de prêmios a
   `campanhas.reconciliarIndicador`.

**Idempotência:**
- O aviso repetido é barrado por `evento_id`.
- A emissão repetida é barrada por `reserva_id`.
- A posição repetida é barrada por `(campanha_id, ingresso_id)`.
- O prêmio repetido é barrado por `chave`.
- A reconciliação calcula o estado desejado e só grava a diferença.

Um teste roda o mesmo aviso 3 vezes e compara as tabelas antes e depois.

**Falha no meio:** tudo está na mesma transação do aviso. Se a campanha
falhar, o aviso inteiro desfaz e volta para a fila com nova tentativa (já
existe). Nunca fica "pago sem posição".

---

## 10. Telas

### Admin → Campanhas (a área já existe desde o PR #152)
- **Lista:** nome, modalidade, status, período, posições ou indicações,
  prêmios (concedidos, entregues, revogados), estoque por faixa, custo total,
  e o selo "relâmpago".
- **Ações:** criar, editar, **duplicar** (copia a configuração para um novo
  rascunho, sem posições nem prêmios), **pausar**, **retomar**, **encerrar**.
- **Formulário** (campos do §3):
  - nome, descrição, banner, edição, modalidade, início e fim, status;
  - tipos e lotes;
  - faixas ou níveis, cada um com brinde (do catálogo de benefícios),
    quantidade, estoque e custo unitário;
  - limite por pessoa, prazo de retirada, acumulação, prioridade, escada,
    "inclui combos", relâmpago;
  - regras (texto público).
- **Travas de justiça:** depois da primeira posição ou do primeiro prêmio, a
  modalidade, as faixas e os alvos ficam **somente leitura**. Só podem mudar:
  - nome, descrição, banner e regras;
  - `fim` e o prazo de retirada, só para depois;
  - o estoque, só para mais;
  - o status.

  Tudo com auditoria.
- **Detalhe da campanha:**
  - posições (CSV): posição, ingresso, tipo, lote, comprador e titular sem
    CPF, faixa, prêmio e status;
  - prêmios com histórico;
  - "Marcar entregue" no Admin, que é obrigatório para indicador operador.
- **Admin → Recompensas** (PR #152): passa a ler de `campanha_premios`, com
  filtros de campanha, status e modalidade.
- **Visão geral:** inclui "prêmios a retirar" de todas as campanhas.

### Página de venda
- Campanha relâmpago ativa: faixa de destaque com o nome, o brinde e
  **"restam N"**.
  - N é o estoque real da faixa atual (posições até o fim da faixa menos
    posições atribuídas), calculado na hora e sem cache.
- Link "regras da campanha".

### Minha Conta → "MINHAS PROMOÇÕES E RECOMPENSAS" (§4)
- **Por edição:**
  - indicação: barra de progresso "6 de 10 para a Camiseta", com o nível
    atual e o próximo;
  - ordem de compra: a posição de cada ingresso e o prêmio.
- **Status de cada prêmio:** LIBERADO, JÁ RETIRADO, REVOGADO (com o motivo)
  e EXPIRADO, mais o prazo de retirada e onde retirar (portaria ou
  organização).
- Nada de dado de outras pessoas.

### Portaria
Já está pronta para receber os prêmios (bloco "RECOMPENSAS DE <TITULAR>",
PR #150). Muda só a origem dos dados e a rota única de entrega.

---

## 11. Migrations, rollback e impacto

1. **`015_campanhas.sql`** (novas tabelas, não destrutiva):
   - cria `campanhas`, `campanha_alvos`, `campanha_faixas`,
     `campanha_posicoes`, `campanha_premios` e `campanha_premio_eventos`;
   - cria os índices, os CHECKs, os gatilhos imutáveis e o RLS.
2. **`016_indicacao_nas_campanhas.sql`:**
   - copia `campanhas_indicacao` para `campanhas`
     (`modalidade = 'indicacao'`), **com os mesmos ids** e uma faixa
     equivalente: `de = indicacoes_por_recompensa`, escada `cumulativa`. Isso
     reproduz o "a cada N, 1" de hoje, dentro do limite por pessoa;
   - copia `recompensas_indicacao` para `campanha_premios`, com os eventos;
   - repõe a FK de `indicacoes.campanha_id` para `campanhas`;
   - remove `ux_campanha_ativa`.
   - Produção tem **0** linhas nessas tabelas: a cópia é trivial e fica
     coberta por teste com dado sintético.
   - As tabelas antigas **ficam** (somente leitura, sem uso). A remoção será
     uma migration separada, com autorização sua, depois de uma edição
     rodando.
3. **Rollback:**
   - Código: reverter o PR. As tabelas antigas continuam intactas e o código
     antigo volta a usá-las.
   - Banco: cada migration traz no comentário o SQL de reversão
     (`DROP TABLE … ` das novas, `ALTER … ` da FK de volta), para rodar só se
     ainda não houver campanha nova em uso. Nada é apagado de tabela
     existente.
4. **Impacto no que já existe:**
   - `pagamentos.js`: 2 chamadas novas;
   - `indicacao.js`: `revisarPedido`/`recalcular` passam a delegar;
   - `checkin.js` e `recompensas.js`: a fonte dos prêmios muda;
   - `clientes.painel`: a seção nova;
   - `desempenho.js`: relatórios por campanha.
   - **Sem mudança:** venda, cotação, estoque, emissão de ingresso, check-in
     de entrada, painel de lotes e capacidade.

---

## 12. Plano de testes automatizados

**Campanhas (§13 do prompt)**
1. Os primeiros 20 ingressos recebem o brinde da faixa 1. O 21º recebe o da
   faixa 2.
2. Estoque da faixa menor que a largura: as posições seguintes ficam sem
   brinde.
3. **Concorrência:** 30 confirmações simultâneas (`Promise.all` de avisos) dão
   posições 1..30 sem buraco nem repetição, e o número de prêmios é o do
   estoque.
4. **Reprocessamento:** o mesmo aviso 3 vezes deixa as tabelas iguais. Uma
   conciliação depois do webhook não faz nada.
5. Pedido com 3 ingressos e combo de 2: posições seguidas na ordem da
   numeração. `inclui_combos = false` exclui os do combo.
6. Pendente, expirado, teste, cortesia e `pago_sem_vaga` nunca recebem
   posição.
7. Reembolso total e parcial:
   - a posição fica;
   - o prêmio não entregue é revogado;
   - o prêmio entregue fica, com evento;
   - a próxima posição **não** herda o prêmio.
8. Chargeback e baixa desfeita: a entrega fica bloqueada e volta ao
   reativar.
9. Duas campanhas simultâneas:
   - sem acumulação, vence a de maior valor, e no empate a prioridade;
   - com acumulação, somam sem repetir o brinde;
   - na mistura, as não acumuláveis escolhem um vencedor e as acumuláveis se
     somam a ele.
10. Campanha pausada não atribui. A retomada continua do contador. Campanha
    fora da janela não atribui.
11. Trava de justiça: depois da primeira posição, não dá para mudar as faixas
    nem os alvos (409). Estoque pode aumentar e não pode diminuir.
12. O prazo de retirada vencido gera `expirado`, e a portaria recusa a
    entrega.

**Indicações**
13. 1 indicação não libera, 4 liberam o nível 1, 10 respeitam a escada
    (`maior_nivel` e `cumulativa`).
14. A mesma pessoa não conta duas vezes. A compra estornada deixa de contar,
    desce de nível e restaura o anterior.
15. Nível sem estoque: cai para o nível de baixo com estoque.
16. Indicador operador: prêmio `so_admin`, sem portaria.

**Portaria e entrega**
17. Duas ou três portarias entregando o mesmo prêmio ao mesmo tempo resultam
    em uma entrega só (como no #150), com uma linha de histórico.
18. Entregar não registra entrada. Ingresso bloqueado ou cancelado não
    entrega.

**Integridade**
19. O banco recusa a duplicidade direta: INSERT repetido de posição e de
    prêmio, e prêmio exclusivo em dobro.
20. As tabelas de posição e de histórico não aceitam UPDATE nem DELETE.
21. Migration 016: o dado sintético da campanha antiga continua contando
    igual depois da cópia. A suíte de indicação atual passa inteira.
22. Regressão completa num banco limpo e conferência no navegador: Admin,
    página de venda, Minha Conta e portaria.

---

## 13. Decisões abertas — precisam da sua resposta antes de implementar

- **C1. Posição em campanhas não acumuláveis simultâneas.** Quando o ingresso
  vale para as campanhas A e B e leva o prêmio de A, ele **também ocupa uma
  posição em B** (sem prêmio)?
  - **Recomendo sim:** a promessa "os primeiros N" fica literal e a ordem não
    depende de outra campanha.
  - A alternativa é ocupar posição só onde ganha prêmio, o que reordena B por
    causa de A.
- **C2. Escada `maior_nivel` com nível baixo já entregue.** A pessoa retirou o
  Copão (nível 4) e depois chegou ao nível 10. Ela recebe a Camiseta?
  - **Recomendo sim:** o entregue não se desfaz e o nível novo é concedido.
  - A alternativa (não dar o nível 10) pune quem retirou cedo.
- **C3. Limite por pessoa na ordem de compra.** Conta por **conta
  compradora** (`pedidos.cliente_id`) ou por titular do ingresso?
  - **Recomendo conta compradora.** O titular pode ser outra pessoa e o
    brinde fica com o ingresso.
- **C4. Janela da campanha.** O que vale é a **hora da confirmação do
  pagamento** (recomendado, coerente com a "ordem real") ou a hora da compra?
- **C5. Benefício de lote com quantidade (que já existe).** Hoje "primeiros N
  do lote ganham X" **devolve** o estoque quando o ingresso é cancelado, o
  que difere da regra 1. Duas opções:
  - (a) mantê-lo como "benefício do lote" e usar Campanhas para toda promessa
    de "primeiros N";
  - (b) migrar esse benefício para campanha.
  - **Recomendo (a)**, com um aviso na tela do lote ("para 'primeiros N' com
    posição fixa, use Campanhas").
- **C6. Pausa.** Confirmação durante a pausa **não** recebe posição e a
  retomada continua do contador (recomendado)? Ou a pausa só suspende os
  prêmios?
- **C7. Regulamento.** Campanha por ordem de compra ou meta não envolve sorte
  (diferente de sorteio, item K). Mesmo assim, recomendo que o modelo do
  texto de regras passe pelo advogado antes da primeira campanha pública.

---

## 14. Fases de entrega propostas (cada uma: branch, PR em rascunho, testes)

1. **Banco e motor:** migrations 015/016, `campanhas.js` (posição,
   reconciliação, acumulação) e os ganchos no pagamento. Testes 1–10, 13–16,
   19–21. Sem tela.
2. **Admin → Campanhas:** formulário, faixas, duplicar, pausar, encerrar,
   travas, detalhe com CSV. Admin → Recompensas na fonte nova.
3. **Portaria e Minha Conta:** rota única de entrega e "Minhas promoções e
   recompensas" com barras.
4. **Página de venda:** campanha relâmpago com "restam N" e as regras.

Cada fase para em PR, com o resumo antes. Nada de merge nem deploy sem a sua
autorização.
