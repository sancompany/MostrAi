# Campanhas (§3) — documento técnico para revisão final

**Implementação:** R1–R3 aprovadas em 16/11/2026; PR 1 (banco e motor) em
rascunho. Ajustes feitos na implementação, sem mudar regra comercial:
(a) o prêmio da faixa tem **nome livre**, com vínculo **opcional** ao catálogo
de benefícios — assim as campanhas de indicação de antes migram sem criar
benefícios artificiais; (b) o livro de conversões é uma tabela **nova**,
`campanha_indicacoes` (cópia fiel de `indicacoes`), porque reaproveitar
`indicacoes` exigiria **remover** a FK e o índice único dela — e a decisão é
nenhuma remoção; (c) o índice `ux_campanha_ativa` da tabela antiga **não** é
removido (a tabela antiga só deixa de ser usada); (d) R1 é garantida por
índice único parcial no banco (`ux_campanha_indicacao_exclusiva`), que vale
também para duas ativações simultâneas.

**Versão 2 — 16/11/2026.** A versão 1 (15/11) recebeu a aprovação da direção
pelo dono, com as decisões C1–C7. Esta versão incorpora essas decisões e
detalha C1 e C2 em concorrência, reembolso, acumulação e progressão de
níveis. **Nada desta fase está implementado.** A implementação, em 4 PRs na
ordem da seção 15, começa depois da revisão final do dono e da resposta às
propostas R1–R3 (seção 14).

Base: `docs/trimundi/decisoes-comerciais-2026-11-14.md`, que reúne as regras
1–9, as decisões A–K e as decisões de 15/11 e 16/11. Estado de produção
conferido em 14/11: **0 campanhas, 0 recompensas, 0 benefícios, 1 pedido
pago**. Nenhuma migração de dado real é necessária.

## Decisões do dono incorporadas (16/11/2026)

| # | Decisão | Onde está no desenho |
|---|---|---|
| C1 | O ingresso ocupa posição em **todas** as campanhas em que se qualifica, mesmo nas não acumuláveis. O prêmio vem **só da vencedora** (prioridade). | §2, §4, §6.1 |
| C2 | Quem já **retirou** o prêmio de um nível recebe **também** o do nível superior quando chegar nele. Prêmio entregue nunca é revogado. **Cada nível tem controle próprio** de concessão, entrega e unicidade. | §3, §6.2 |
| C3 | O limite por pessoa conta pela **conta compradora**, não pelo titular do ingresso. | §2.4, §6.3 |
| C4 | A janela da campanha usa o **horário efetivo da confirmação do pagamento**. | §2.3, R2 |
| C5 | O benefício de lote fica como está. Toda promoção nova de "primeiros N" ou de posição de compra é feita em **Campanhas**, com um **aviso** no cadastro do benefício de lote. | §7, §10 |
| C6 | Pagamento confirmado durante a **pausa** não ocupa posição. Na retomada, a contagem continua da próxima posição, sem reaproveitar posições. | §2.3, §6.1 |
| C7 | Textos e regulamentos passam por **revisão jurídica** antes da primeira publicação pública. | §10, §15 |

Requisitos do dono e como cada um é garantido:

| Requisito | Garantia |
|---|---|
| Posições imutáveis | `campanha_posicoes` com gatilho que recusa UPDATE e DELETE; contador que só cresce; únicos (campanha, posição) e (campanha, ingresso) |
| Idempotência de pagamentos e webhooks | `pagamento_eventos.evento_id` único (já existe), emissão única por vaga (já existe), posição `ON CONFLICT DO NOTHING`, prêmio com `chave` única, reconciliação que calcula o estado desejado e grava só a diferença |
| Prevenção de recompensas duplicadas | chave única por prêmio; um prêmio exclusivo de pé por ingresso; nenhum brinde repetido por ingresso; um prêmio por nível (e por repetição) por indicador — tudo no banco |
| Histórico imutável e auditável | `campanha_premio_eventos` só de acréscimo (gatilho), mais a `auditoria` existente para as ações do Admin |
| Reembolso sem transferência de posição | a posição fica; o prêmio não entregue é revogado; nada é recalculado para a posição seguinte (§6.1) |
| Preservação das tabelas antigas | `campanhas_indicacao` e `recompensas_indicacao` ficam intactas (só leitura); remoção só em migration futura autorizada |
| Nenhuma migration destrutiva sem autorização | 015 e 016 só criam, copiam e trocam uma FK (seção 11) |
| Nenhum merge ou deploy sem autorização | PRs em rascunho; produção não é tocada |

---

## 0. Princípios

1. **Ordem real = ordem em que a TICK aplica a confirmação.** Toda
   confirmação já roda em `pagamentos.aplicar`, que trava a linha da
   **edição** (`SELECT … FROM edicoes … FOR UPDATE`) e depois a do pedido. As
   confirmações de uma mesma edição são executadas uma de cada vez. A posição
   é atribuída **dentro dessa transação**, e a ordem de commit é a ordem das
   posições.
2. **Tudo idempotente.** Reprocessar um aviso não muda nada (seção 9).
3. **Reconciliar em vez de incrementar.** A cada aviso, a função calcula o
   estado **desejado** dos prêmios a partir dos fatos (ingressos de pé,
   indicações válidas) e aplica só a diferença. Rodar N vezes dá o mesmo
   resultado.
4. **Histórico imutável.** Toda mudança de estado de prêmio grava uma linha
   só de acréscimo, com autor e motivo, na mesma transação.
5. **Reaproveitar sem duplicar.** Continuam como estão:
   - `beneficios`, que é o catálogo de brindes;
   - `indicacoes`, o livro de conversões;
   - a regra `INGRESSO_DE_PE`;
   - a numeração dos ingressos;
   - a entrega única da portaria (PR #150);
   - a área Admin → Campanhas e Admin → Recompensas (PR #152).

---

## 1. Modelo de dados

Esquema `trimundi`, migrations novas, `ENABLE ROW LEVEL SECURITY` em todas.

### 1.1 `campanhas`
| Campo | Tipo | Regra |
|---|---|---|
| `id` | bigserial PK | |
| `edicao_id` | FK `edicoes` | NOT NULL |
| `modalidade` | text | `ordem_compra` \| `indicacao` |
| `nome` | text | 1–80 |
| `descricao` | text | ≤ 1000 |
| `regras` | text | ≤ 5000 — regulamento público (revisão jurídica antes da 1ª publicação, C7) |
| `regras_revisadas_em`, `regras_revisadas_por` | | marca do Admin de que o texto passou pelo jurídico (§10) |
| `banner_chave` | text | nulo ou chave do armazenamento |
| `status` | text | `rascunho` \| `ativa` \| `pausada` \| `encerrada` |
| `inicio`, `fim` | timestamptz | nulos = sem limite; `fim > inicio` |
| `relampago` | boolean | destaque na página de venda |
| `acumula` | boolean | default **false** (decisão J) |
| `prioridade` | int | desempate quando o valor empata (maior primeiro) |
| `escada` | text | indicação: `maior_nivel` (padrão, regra 2) \| `cumulativa` |
| `limite_por_pessoa` | int | nulo = sem limite. Ordem de compra: prêmios por conta compradora (C3). Indicação: prêmios por indicador |
| `prazo_retirada` | timestamptz | nulo = até o fim da edição |
| `inclui_combos` | boolean | default true |
| `proxima_posicao` | int | contador da ordem de compra, default 1, **só cresce** (gatilho recusa diminuir) |
| `criado_em`, `atualizado_em`, `encerrada_em` | timestamptz | |

O índice `ux_campanha_ativa` (uma por edição) sai: campanhas simultâneas
são permitidas, com as regras da seção 4.

### 1.2 `campanha_alvos` — tipos e lotes que participam (ordem de compra)
`campanha_id`, `categoria_id` nulo, `lote_id` nulo;
`CHECK (categoria_id IS NOT NULL OR lote_id IS NOT NULL)`; único por
(campanha, categoria, lote). Sem linhas, vale para a edição inteira.

### 1.3 `campanha_faixas` — faixas (ordem de compra) ou níveis (indicação)
| Campo | Regra |
|---|---|
| `id`, `campanha_id` | |
| `ordem` | 1..20, único por campanha |
| `de` | ≥ 1 — posição inicial (ordem de compra) ou nº de indicações do nível (indicação) |
| `ate` | posição final (ordem de compra); nulo em indicação |
| `repete` | boolean, só indicação, default false — "a cada `de` indicações, 1 prêmio" (formato das campanhas de indicação de hoje, seção 11) |
| `beneficio_id` | FK `beneficios`, mesma edição |
| `quantidade` | ≥ 1 — unidades do brinde por prêmio |
| `estoque` | nulo ou ≥ 1 — teto de prêmios da faixa ou nível (ver §2.5 e §3.4) |
| `custo_unitario_centavos` | ≥ 0 — base do "valor" para acumulação e relatórios |

Restrições:
- Ordem de compra: as faixas não se sobrepõem e `de ≤ ate`.
- Indicação: `de` estritamente crescente pela `ordem`.
- No máximo um nível com `repete`, e ele é o único da campanha.
- As restrições são conferidas no servidor e por gatilho.

### 1.4 `campanha_posicoes` — posição definitiva (ordem de compra)
| Campo | Regra |
|---|---|
| `id`, `campanha_id`, `posicao` (≥ 1), `ingresso_id`, `pedido_id`, `comprador_cliente_id`, `faixa_id` (nulo = além da última), `atribuida_em` | |
| `resultado` | `premiado` \| `sem_estoque` \| `limite_por_pessoa` \| `nao_acumulavel` \| `sem_faixa` — o que aconteceu **na hora** da atribuição |
| `vencedora_id` | quando `nao_acumulavel`: a campanha que levou o prêmio |

Únicos `(campanha_id, posicao)` e `(campanha_id, ingresso_id)`. **Gatilho
imutável** (UPDATE/DELETE recusados). O estado posterior do ingresso
(cancelado) é lido do ingresso e nunca reescreve a posição.

### 1.5 `campanha_premios` — o prêmio
| Campo | Regra |
|---|---|
| `id`, `campanha_id`, `faixa_id` | |
| `ingresso_id` | ordem de compra: o prêmio é **do ingresso** |
| `indicador_id` | indicação: o prêmio é **do indicador** |
| `repeticao` | indicação com `repete`: 1, 2, 3… (nulo nos outros) |
| `comprador_cliente_id` | ordem de compra: conta compradora (C3) |
| `beneficio_id`, `nome`, `quantidade`, `valor_centavos` | cópia congelada na concessão |
| `exclusivo` | `NOT campanha.acumula`, congelado |
| `so_admin` | indicador operador: entrega só pelo Admin (decisão de 15/11) |
| `status` | `concedido` \| `entregue` \| `revogado` \| `expirado` |
| `motivo`, `concedido_em`, `entregue_em`, `entregue_por`, `revogado_em`, `expirado_em` | |
| `chave` | **UNIQUE** (abaixo) |

**Chaves** (uma linha por prêmio possível; reaplicar nunca cria outra):
- ordem de compra: `pos:<campanha>:<ingresso>`;
- indicação: `niv:<campanha>:<indicador>:<faixa>` — **um por nível** (C2);
- indicação com `repete`: `niv:<campanha>:<indicador>:<faixa>:<repeticao>`.

Índices únicos parciais (o banco recusa duplicidade):
- `(ingresso_id) WHERE exclusivo AND status IN ('concedido','entregue')`:
  no máximo um prêmio não acumulável de pé por ingresso;
- `(ingresso_id, beneficio_id) WHERE status IN ('concedido','entregue')`:
  nunca o mesmo brinde duas vezes no mesmo ingresso.

CHECKs: `(ingresso_id IS NULL) <> (indicador_id IS NULL)`;
`(status = 'entregue') = (entregue_em IS NOT NULL)`.

**Restauração** (indicação): um prêmio revogado que volta a valer volta a
`concedido` **na mesma linha** (mesma chave), com o evento `restaurado`. Não
nasce linha nova, então a unicidade por nível se mantém.

### 1.6 `campanha_premio_eventos` — histórico (só acréscimo)
`premio_id`, `acao` (`concedido` \| `entregue` \| `revogado` \| `expirado` \|
`restaurado`), `autor` (`pagamento` \| `operador:<id>` \| Admin \| `sistema`),
`motivo`, `em`. Gatilho imutável. Gravado na mesma transação da mudança.

### 1.7 Relacionamentos
```
edicoes ─< campanhas ─< campanha_faixas >─ beneficios
                 │  └─< campanha_alvos >─ categorias / lotes
                 ├─< campanha_posicoes >─ ingressos, pedidos
                 ├─< campanha_premios  >─ ingressos | indicadores
                 │        └─< campanha_premio_eventos
                 └─< indicacoes (FK campanha_id passa a apontar para campanhas)
```

---

## 2. Fluxo — ordem de compra

Exemplo: Campanha A, "1º–20º: Copão; 21º–50º: Pulseira".

### 2.1 Admin
Cria em rascunho e ativa. A ativação confere faixas, alvos, brindes da
edição, período e regulamento revisado (C7, se a campanha for pública).

### 2.2 Venda
Nada acontece na compra. Pedido pendente **não** tem posição.

### 2.3 Confirmação (`pagamentos.confirmar`, sob a trava da edição)
1. `emitirDoPedido` emite os ingressos (como hoje).
2. `campanhas.aoConfirmar(cliente, pedido)`:
   1. **Campanhas candidatas:** `status = 'ativa'` (a **pausada não entra**,
      C6) e com `inicio ≤ hora da confirmação < fim` (C4; a hora usada está
      em R2). Elas são travadas em `FOR UPDATE` **em ordem de id**: ordem de
      travas fixa, sem deadlock.
   2. **Ingressos do pedido**, na ordem da numeração (`pi.ordem`,
      `r.posicao`). Cada ingresso pago é uma posição (decisão I). Ficam de
      fora a cortesia, o pedido de teste e o `pago_sem_vaga`.
   3. Para **cada** campanha candidata em que o ingresso se qualifica (alvos
      e `inclui_combos`):
      - recebe `posicao = proxima_posicao`, e o contador sobe;
      - `INSERT … ON CONFLICT (campanha_id, ingresso_id) DO NOTHING`;
      - **C1:** isso vale em todas as campanhas, acumuláveis ou não.
   4. Para cada posição, o **candidato a prêmio** é a faixa da posição, se
      houver estoque (§2.5) e o limite por pessoa permitir (§2.4).
   5. **Escolha da vencedora** entre os candidatos do ingresso (seção 4):
      - o grupo das não acumuláveis dá **uma** vencedora;
      - as acumuláveis entram sem repetir o brinde.
   6. Para cada vencedora: cria o prêmio (`chave pos:…`, `ON CONFLICT DO
      NOTHING`) e o evento `concedido`.
   7. Cada posição grava o `resultado` (`premiado`, `nao_acumulavel` com
      `vencedora_id`, `sem_estoque`, `limite_por_pessoa`, `sem_faixa`).
3. A **retomada da pausa** não mexe no contador: a próxima confirmação depois
   de reativar pega `proxima_posicao`, que nunca volta (C6).

### 2.4 Limite por pessoa (C3)
- Conta os prêmios **de pé** (`concedido` ou `entregue`) da **conta
  compradora** (`pedidos.cliente_id`) na campanha. O titular do ingresso não
  entra na conta.
- Se o limite já foi atingido, o ingresso recebe a posição sem prêmio
  (`limite_por_pessoa`).
- Se o prêmio de um ingresso dessa conta for revogado depois (reembolso), a
  vaga do limite reabre só para compras **futuras** da conta (R3). Não há
  recálculo do passado.

### 2.5 Estoque da faixa
- `estoque` nulo: cada posição da faixa tem o seu brinde.
- `estoque` definido: teto de prêmios **concedidos** na faixa, contando os
  revogados. A posição revogada **não** devolve unidade ao estoque, e o
  prêmio não passa para ninguém (regra 1).
- Uma posição que ficou sem prêmio por `nao_acumulavel` ou
  `limite_por_pessoa` **não** consome estoque. A próxima posição da faixa
  ainda pode ganhar enquanto houver estoque. Isso não é transferência: é o
  brinde que nunca foi concedido.

### 2.6 Portaria e prazo
- O prêmio aparece em "RECOMPENSAS DE <TITULAR>" do próprio ingresso, com
  CONFIRMAR ENTREGA.
- Depois de `prazo_retirada`, o prêmio `concedido` vira `expirado`. Isso
  acontece pela varredura periódica e também na leitura, com evento.

---

## 3. Fluxo — indicação com níveis

Exemplo: Campanha N, níveis "4 indicações: Copão" e "10 indicações:
Camiseta", escada `maior_nivel`.

### 3.1 O que conta (sem mudança)
- Pedido **pago** de quem chegou pelo link, com ingresso de pé
  (`INGRESSO_DE_PE`).
- A mesma pessoa conta uma vez por campanha (`ux_indicacao_pessoa`).
- A autoindicação continua bloqueada.
- A indicação entra em toda campanha de indicação ativa (não pausada) da
  edição, desde que o pagamento tenha sido confirmado dentro da janela dela
  (C4, C6).

### 3.2 Reconciliação: `reconciliarIndicador(campanha, indicador)`, campanha em `FOR UPDATE`
1. `n` = indicações válidas do indicador na campanha.
2. **Níveis atingidos:** os níveis com `de ≤ n`.
3. **Estado desejado, nível a nível** (C2 — cada nível é independente):

   | Escada | Nível atingido | Desejado |
   |---|---|---|
   | `cumulativa` | qualquer | prêmio de pé |
   | `maior_nivel` | o **maior** atingido | prêmio de pé |
   | `maior_nivel` | **abaixo** do maior, prêmio ainda `concedido` | sai: revogado com o motivo "substituído pelo nível N" |
   | `maior_nivel` | **abaixo** do maior, prêmio **`entregue`** | **fica**, e o maior também é concedido (C2) |
   | qualquer | **não** atingido (o `n` caiu), prêmio `concedido` | sai: revogado com o motivo "indicação reembolsada" |
   | qualquer | **não** atingido, prêmio `entregue` | **fica** (entregue nunca é revogado) |

4. **Nível com `repete`:** `floor(n / de)` prêmios, cada um com a sua
   `repeticao`, dentro do limite por pessoa. É o formato "a cada N, 1" de
   hoje.
5. **Diferença:**
   - o que falta é concedido, ou **restaurado** se a linha existia revogada;
   - o que sobra e ainda está `concedido` é revogado;
   - o que sobra e está `entregue` não muda.
6. Antes de conceder, aplicam-se o limite por pessoa, o estoque do nível
   (§3.4) e a acumulação entre campanhas (seção 4 e R1).

### 3.3 Indicador operador
Os prêmios dele nascem com `so_admin`. A portaria não os mostra, e a conta
dele diz "entrega pelo Admin, não na portaria" (como no PR #152).

### 3.4 Estoque do nível
- O estoque conta os prêmios **de pé**.
- Na indicação, o prêmio revogado **devolve** a unidade: indicação não tem
  posição, e o brinde não saiu.
- Nível sem estoque:
  - em `maior_nivel`, cai para o nível imediatamente abaixo que tenha
    estoque;
  - em `cumulativa`, aquele nível fica sem prêmio até haver estoque.

---

## 4. Campanhas simultâneas, prioridade, acumulação e duplicidade

- **Valor de um prêmio** = `custo_unitario × quantidade` da faixa.
- **Não acumuláveis (padrão, J):** entre as não acumuláveis em que o
  **mesmo ingresso** teria prêmio, vence a de maior valor. No empate, maior
  `prioridade`; depois, a mais antiga. As outras gravam a posição com
  `nao_acumulavel` e `vencedora_id` (C1).
- **Acumuláveis:** somam-se à vencedora e entre si, sem repetir o mesmo
  brinde no ingresso (índice único). Quando dois brindes iguais colidem,
  fica o de maior valor, com as mesmas regras de desempate.
- **Modalidades diferentes não disputam.** O prêmio de ordem de compra é do
  **ingresso**, e o de indicação é do **indicador**. Um não bloqueia o outro.
- **Duas campanhas de indicação não acumuláveis ao mesmo tempo:** ver R1.
- **Benefício de tipo ou lote** (`ingresso_beneficios`): é outro mecanismo e
  continua como está (C5). Não entra na acumulação de campanhas.

---

## 5. Compras e confirmações simultâneas

| Situação | O que garante |
|---|---|
| Dois pagamentos da mesma edição ao mesmo tempo | trava da edição em `pagamentos.aplicar` (já existe): um espera o outro, e as posições seguem a ordem de commit |
| Duas instâncias processando a fila | `FOR UPDATE SKIP LOCKED` na fila (já existe), mais a trava da edição |
| Corrida no contador | campanha em `FOR UPDATE`, contador que só cresce, único `(campanha_id, posicao)` |
| Conciliação e webhook juntos | mesma trava; o segundo vê o pedido pago e responde `ja_aplicado` |
| Mesmo aviso de novo | `evento_id` único; ingresso, posição e prêmio já existem → nada muda |
| Ordem das travas | sempre edição → pedido → campanhas (por id) → faixas |
| Duas portarias entregando o mesmo prêmio | prêmio em `FOR UPDATE` + `UPDATE … WHERE status = 'concedido'`; o segundo recebe "já entregue" (testado no #150) |

---

## 6. C1 e C2 nos casos-limite

### 6.1 C1 — posição em todas, prêmio só da vencedora

Cenário: Campanha **A** (não acumulável, 1º–20º: Copão, custo R$ 15) e
Campanha **B** (não acumulável, 1º–50º: Pulseira, custo R$ 5), ativas ao
mesmo tempo para os mesmos tipos.

| Caso | Resultado |
|---|---|
| Ingresso X é o 7º de A e o 7º de B | posição 7 em A e posição 7 em B; prêmio **Copão (A)**; em B fica `nao_acumulavel`, `vencedora_id = A`. O estoque de B não é consumido |
| **Concorrência:** 30 pagamentos confirmados no mesmo instante | executados um a um pela trava da edição; A recebe as posições 1..30 e B também, sem buraco nem repetição; 20 Copões (1–20) e 10 Pulseiras (posições 21–30 de B, porque A não tem prêmio nesses números) |
| **Reprocessamento** do aviso de X | posições e prêmio já existem, nada muda |
| **Reembolso** de X (Copão ainda não entregue) | posições 7/A e 7/B **ficam**; Copão **revogado**; **não** há prêmio novo de B para X (a decisão foi tomada na confirmação, a posição é fixa e o ingresso foi cancelado); a posição 8 de A **não** herda o Copão |
| Reembolso de X com Copão **já entregue** | o Copão fica, com o evento "ingresso reembolsado após a entrega" (alerta no Admin) |
| X ganharia em A, mas a faixa de A está **sem estoque** | A não é candidata; **B vence** (Pulseira); A fica com `sem_estoque` |
| A **pausada** quando X é confirmado | X **não** recebe posição em A (C6); recebe em B, se B estiver ativa; quando A é retomada, o próximo pagamento pega a próxima posição de A |
| B **acumulável** e A não | X leva Copão (A) **e** Pulseira (B), porque os brindes são diferentes |
| A e B acumuláveis com o **mesmo** brinde | só um Copão no ingresso (índice único); o outro fica `nao_acumulavel`, motivo "brinde repetido" |

### 6.2 C2 — progressão de níveis

Cenário: Campanha N, níveis 4 (Copão) e 10 (Camiseta), escada `maior_nivel`.

| Sequência | Copão (nível 4) | Camiseta (nível 10) |
|---|---|---|
| 1–3 indicações | — | — |
| 4 indicações | **concedido** | — |
| 4 → retirou na portaria | **entregue** | — |
| … 10 indicações | entregue (fica) | **concedido** (C2: recebe também) |
| Variante: chegou a 10 **sem** ter retirado o Copão | **revogado** ("substituído pelo nível 10") | **concedido** |
| Variante + reembolso de 1 indicado (10 → 9) | **restaurado** (mesma linha, evento `restaurado`) | **revogado** ("indicação reembolsada") |
| … voltou a 10 (nova indicação paga) | revogado de novo ("substituído") | **restaurado** (mesma linha) |
| Camiseta **entregue** e depois 10 → 9 | — | **fica** (entregue nunca é revogado) |
| Copão entregue e Camiseta entregue, 10 → 3 | fica | fica |
| **Concorrência:** duas indicações pagas no mesmo instante levam de 9 a 11 | executadas uma a uma (trava da edição e da campanha); na 10ª, a Camiseta é concedida **uma vez** (chave `niv:N:ind:nivel10`); na 11ª, nada muda |
| **Reprocessamento** do aviso da 10ª | a chave já existe, nada muda |
| Duas campanhas de indicação (N acumulável, M acumulável), ambas com nível 4 | cada campanha tem o seu prêmio (chaves diferentes); o indicador leva os dois |

Unicidade por nível: **uma linha por (campanha, indicador, nível)** (e por
repetição no nível `repete`). Concessão, entrega e revogação de um nível
nunca tocam a linha de outro nível.

### 6.3 Reembolso, cancelamento e estorno (resumo)

| Fato | Posição | Prêmio `concedido` | Prêmio `entregue` |
|---|---|---|---|
| Reembolso confirmado (ingresso cancelado) | **fica** | **revogado** ("ingresso reembolsado") | **fica** + alerta |
| Reembolso pedido e ainda não confirmado (bloqueado) | fica | fica, sem entrega na portaria | — |
| Chargeback (bloqueado) | fica | fica, sem entrega; revogado se virar estorno | fica + alerta |
| Baixa desfeita e refeita | fica | fica (a entrega volta quando o ingresso volta a valer) | fica |
| Indicação perde a validade | — | §3.2 (revoga e desce de nível; restaura o de baixo) | fica |
| Prazo de retirada vencido | fica | **expirado** | — |

---

## 7. Integração com ingressos, combos, tipos e lotes

- **Ingresso individual:** a unidade de posição e de prêmio.
- **Combo:**
  - cada posição já é um ingresso; entra se `inclui_combos`;
  - a ordem dentro do pedido é a da numeração.
- **Tipo e lote:** definidos em `campanha_alvos`.
- **Estoque de ingresso, capacidade e painel de lotes (§7):** não mudam.
- **Portaria:**
  - "RECOMPENSAS DE <TITULAR>" passa a listar os prêmios de campanha do
    ingresso e os de indicação no ingresso principal (já é assim);
  - a entrega usa uma rota única, `POST /ticket/api/checkin/premio`;
  - as rotas atuais ficam por compatibilidade.
- **Benefício de lote (C5):** sem mudança de funcionamento. O cadastro ganha
  o aviso: "Para 'primeiros N ingressos' ou posição de compra, use
  Campanhas. Este benefício devolve o estoque quando o ingresso é cancelado."

---

## 8. Registro da posição definitiva

- **Quando:** na transação que confirma o pagamento e emite o ingresso.
  Nunca existe "pago e sem posição" numa campanha elegível ativa.
- **O quê:** campanha, posição, ingresso, pedido, conta compradora, faixa,
  resultado (`premiado`/`nao_acumulavel`/…), vencedora e hora.
- **Garantias:** os dois únicos, o gatilho imutável e o contador que só
  cresce.
- **Onde aparece:**
  - Minha Conta ("ingresso 2 de 3 — posição 17 na campanha X");
  - portaria;
  - Admin, com a lista de posições e o CSV.
- **Ingresso cancelado:** a posição continua listada, marcada "cancelado".

---

## 9. Confirmação de pagamento e idempotência

1. `pagamentos.confirmar`, depois de `emitirDoPedido` e
   `marcarLotesDoPedido`: `campanhas.aoConfirmar(cliente, pedido)`.
2. `pagamentos.aplicar`, depois de `indicacao.revisarPedido`:
   `campanhas.revisarPedido(cliente, pedidoId)`. Ele reconcilia os prêmios
   de ordem de compra dos ingressos do pedido e as campanhas de indicação do
   indicador do pedido. Roda em **todo** aviso e é idempotente.
3. `indicacao.revisarPedido`: sai "a campanha ativa (uma)"; ele percorre as
   campanhas de indicação ativas e delega a `reconciliarIndicador`.

Idempotência, camada a camada:

| Camada | Barreira |
|---|---|
| aviso | `evento_id` |
| ingresso | `reserva_id` |
| posição | `(campanha_id, ingresso_id)` |
| prêmio | `chave` |
| reconciliação | só grava diferença |

Teste: o mesmo aviso 3 vezes, tabelas idênticas antes e depois.

**Falha no meio:** tudo está na transação do aviso. Uma falha desfaz o aviso
inteiro e ele volta para a fila (já existe). Nunca fica "pago sem posição".

---

## 10. Telas

### Admin → Campanhas
- **Lista:** nome, modalidade, status, período, posições ou indicações,
  prêmios (concedidos, entregues, revogados, expirados), estoque por faixa,
  custo total, selo relâmpago e selo "regulamento revisado".
- **Ações:** criar, editar, duplicar (sem posições nem prêmios), pausar,
  retomar, encerrar.
- **Formulário:**
  - nome, descrição, banner, edição, modalidade, datas, status;
  - tipos e lotes;
  - faixas ou níveis, cada um com brinde, quantidade, estoque, custo
    unitário e "repete";
  - limite por pessoa, prazo de retirada, acumulação, prioridade, escada,
    "inclui combos", relâmpago;
  - regras.
- **Travas de justiça:** depois da 1ª posição ou do 1º prêmio, modalidade,
  faixas e alvos ficam só para leitura. Ainda podem mudar:
  - nome, descrição, banner e regras;
  - `fim` e prazo, só para depois;
  - estoque, só para mais;
  - status.

  Tudo com auditoria.
- **C7:** campanha com `relampago` ou visível na página de venda só ativa com
  "regulamento revisado pelo jurídico" marcado pelo Admin (data e autor
  ficam gravados).
- **Detalhe:**
  - posições (CSV, sem CPF), com `resultado` e vencedora;
  - prêmios com histórico;
  - "Marcar entregue", obrigatório para `so_admin`.
- **Admin → Recompensas:** fonte `campanha_premios`, com filtros.
- **Visão geral:** "prêmios a retirar".

### Cadastro de benefício de lote (C5)
Aviso fixo junto ao campo de benefício do lote, com o texto da seção 7.

### Página de venda
Campanha relâmpago ativa: destaque com nome, brinde e **"restam N"**, com N
real calculado na hora; link "regras da campanha".

> Implementado no PR 4 (RN-T45): promoção de preço no card do ingresso
> (selo, preço riscado, %, restam, prazo, regulamento) e "Brindes desta
> edição" para primeiros N; esgotada/encerrada sem preço; só com C7.

### Minha Conta → "MINHAS PROMOÇÕES E RECOMPENSAS" (§4)
- Indicação: barra de progresso por nível ("6 de 10 para a Camiseta").
- Ordem de compra: posição de cada ingresso e prêmio.
- Status: LIBERADO / JÁ RETIRADO / REVOGADO (motivo) / EXPIRADO, com prazo
  e local de retirada (portaria ou organização).

### Portaria
O bloco "RECOMPENSAS DE <TITULAR>" já existe (#150). Muda só a fonte e a
rota única.

---

## 11. Migrations, rollback e impacto

1. **`015_campanhas.sql`** — só cria: as 6 tabelas, índices, CHECKs,
   gatilhos (imutáveis e contador que só cresce) e RLS. **Não destrutiva.**
2. **`016_indicacao_nas_campanhas.sql`:**
   - copia `campanhas_indicacao` para `campanhas` (`modalidade =
     'indicacao'`), **com os mesmos ids**, e um nível `repete` com `de =
     indicacoes_por_recompensa`. Reproduz o "a cada N, 1" de hoje, dentro do
     limite por pessoa;
   - copia `recompensas_indicacao` para `campanha_premios`, com os eventos;
   - repõe a FK de `indicacoes.campanha_id` para `campanhas` (os ids são os
     mesmos);
   - remove o índice `ux_campanha_ativa` (índice, não dado).
   - Produção tem **0** linhas: a cópia é coberta por teste com dado
     sintético.
   - **As tabelas antigas ficam intactas** (sem uso, só leitura). A remoção
     será uma migration futura, **só com a sua autorização**.
3. **Rollback:**
   - código: reverter o PR; as tabelas antigas e o código antigo voltam a
     funcionar;
   - banco: SQL de reversão no comentário de cada migration (DROP só das
     novas, FK de volta), para usar se ainda não houver campanha nova.
     Nenhum dado de tabela existente é apagado.
4. **Impacto:**
   - muda: `pagamentos.js` (2 chamadas), `indicacao.js` (delegação),
     `checkin.js` e `recompensas.js` (fonte), `clientes.painel` (seção
     nova), `desempenho.js` (relatórios), cadastro de benefício de lote
     (aviso);
   - **não muda:** venda, cotação, estoque, emissão de ingresso, check-in de
     entrada, painel de lotes, capacidade.

---

## 12. Plano de testes automatizados

**Ordem de compra**
1. Do 1º ao 20º, faixa 1; o 21º, faixa 2; estoque menor que a largura
   esgota.
2. **Concorrência:** 30 confirmações simultâneas dão posições 1..30 sem
   buraco ou repetição em **cada** campanha; prêmios = estoque.
3. **Reprocessamento:** o mesmo aviso 3 vezes e conciliação depois do
   webhook deixam tabelas idênticas.
4. Pedido com 3 ingressos e combo: posições seguidas;
   `inclui_combos = false` exclui os do combo.
5. Pendente, expirado, teste, cortesia e `pago_sem_vaga` nunca recebem
   posição.
6. Reembolso total e parcial:
   - a posição fica;
   - o prêmio não entregue é revogado;
   - o entregue fica, com evento;
   - a próxima posição não herda;
   - a vencedora reembolsada não passa o prêmio para a perdedora (C1).
7. Chargeback e baixa desfeita bloqueiam e liberam a entrega.
8. **C1:**
   - posição em A e B;
   - prêmio só da vencedora (valor, depois prioridade, depois antiguidade);
   - `nao_acumulavel` e `vencedora_id` gravados;
   - o estoque de B não é consumido;
   - A sem estoque faz B vencer;
   - acumuláveis somam sem repetir o brinde.
9. **C3:** o limite conta a conta compradora: titular diferente, mesma
   conta, é bloqueado; contas diferentes passam.
10. **C4:** a janela usa a hora da confirmação. Pedido criado antes do
    início e confirmado dentro entra; criado dentro e confirmado depois do
    fim não entra.
11. **C6:** pausada não atribui; a retomada continua do contador, sem
    reutilizar posição.
12. Travas de justiça: faixas e alvos ficam bloqueados (409); estoque só
    sobe.
13. Prazo de retirada vencido vira `expirado`, e a portaria recusa.

**Indicação**

14. 1 indicação não libera; 4 liberam; 10 seguem a escada (`maior_nivel` e
    `cumulativa`).
15. **C2:**
    - nível 4 entregue + chegar a 10 = os dois;
    - nível 4 não entregue + chegar a 10 = o 4 é substituído;
    - reembolso (10 → 9) restaura o 4 e revoga o 10 na **mesma linha**;
    - voltar a 10 restaura o 10;
    - entregue nunca é revogado;
    - uma linha por nível.
16. Concorrência de 9 → 11: a Camiseta é concedida uma vez só.
17. A mesma pessoa não conta duas vezes; compra estornada deixa de contar.
18. Nível sem estoque: `maior_nivel` cai para o nível de baixo com estoque.
19. Nível `repete`: o comportamento de hoje (`indicacoes_por_recompensa`)
    continua igual; a suíte de indicação atual passa inteira.
20. Indicador operador: `so_admin`, sem portaria.

**Portaria e entrega**

21. Três portarias ao mesmo tempo dão uma entrega só, com uma linha de
    histórico.
22. Entregar não registra entrada. Bloqueado ou cancelado não entrega.

**Integridade**

23. O banco recusa a duplicidade direta: posição, prêmio, exclusivo em dobro
    e brinde repetido.
24. Posições e histórico recusam UPDATE e DELETE; o contador recusa
    diminuir.
25. Migration 016 com dado sintético: tudo continua contando igual; as
    tabelas antigas continuam intactas.
26. Regressão completa num banco limpo e conferência no navegador (Admin,
    página de venda, Minha Conta, portaria) em cada PR.

---

## 13. Decisões já aprovadas (C1–C7)

Ver a tabela no topo. Elas estão registradas também em
`docs/trimundi/decisoes-comerciais-2026-11-14.md`.

## 14. Propostas novas — para a revisão final

Elas apareceram ao detalhar C1–C4. Cada uma traz uma recomendação; nada é
implementado sem a sua resposta.

- **R1. Duas campanhas de indicação não acumuláveis ao mesmo tempo, na
  mesma edição.**
  - **Recomendo bloquear no Admin:** a ativação recusa uma segunda campanha
    de indicação **não acumulável** com período sobreposto, com mensagem
    clara.
  - Ordem de compra e campanhas acumuláveis seguem livres.
  - **Motivo:** a progressão por níveis (C2) acontece ao longo do tempo, e
    "vale a de maior valor" entre duas escadas em andamento troca prêmios já
    concedidos de um lado para o outro. Isso é difícil de explicar ao
    cliente e de auditar.
- **R2. Qual relógio é o "horário efetivo da confirmação" (C4).**
  - **Recomendo** usar `pedidos.pago_em`: a hora em que a TICK aplica a
    confirmação, que é a mesma que define a ordem das posições. Um relógio
    só, gravado e auditável.
  - **Limitação:** se o aviso do Checkout atrasar (fila com nova tentativa),
    vale a hora de aplicação. Normalmente a diferença é de segundos.
  - **Alternativa:** a hora informada pelo provedor (`ocorridoEm`) só para a
    janela. As posições continuariam pela ordem de aplicação, e as duas
    ordens podem divergir nas bordas.
- **R3. Limite por pessoa depois de um reembolso (C3).**
  - **Recomendo** contar só prêmios **de pé**. Se a conta teve um prêmio
    revogado por reembolso, uma compra **futura** dela pode ganhar de novo,
    se a posição cair numa faixa com estoque.
  - Não é transferência: nada do passado é recalculado.
  - **Alternativa:** contar todo prêmio já concedido, inclusive revogado.
    Nesse caso, quem reembolsou não ganha mais naquela campanha.

## 15. Entrega em 4 PRs (na ordem; cada um com testes completos e parada para aprovação)

1. **Banco e motor:**
   - migrations 015/016;
   - `campanhas.js` (posição, reconciliação, acumulação, níveis);
   - ganchos no pagamento;
   - testes 1–11, 13–20, 23–25.
   - Sem tela nova; o Admin atual de indicação continua funcionando sobre a
     fonte nova.
2. **Admin → Campanhas:**
   - formulário completo, faixas e níveis, duplicar, pausar, retomar,
     encerrar;
   - travas e marca do regulamento revisado (C7);
   - detalhe com CSV;
   - Admin → Recompensas na fonte nova;
   - aviso no benefício de lote (C5);
   - teste 12 e navegador.
3. **Portaria e Minha Conta:** rota única de entrega e "Minhas promoções e
   recompensas"; testes 21–22 e navegador.
4. **Página de venda:** campanha relâmpago com "restam N" e regras; só com
   regulamento revisado (C7).

Cada PR: branch própria, empilhado na ordem, **rascunho**, resumo antes,
regressão completa num banco limpo, conferência no navegador. **Sem merge,
deploy ou alteração em produção sem a sua autorização.**
