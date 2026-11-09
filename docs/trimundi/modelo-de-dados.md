# Trimundi — modelo de dados

O banco é **próprio da Trimundi**, nunca o da Mostraí (`CONSTRAINTS.md`).
As migrations moram em `src/trimundi/db/migrations/` e são aplicadas pelo
aplicador da Trimundi na tabela `schema_migrations` deste banco; as duas
coisas nascem na Etapa 1. Este documento é o contrato que a Etapa 1
implementa: mudou o modelo, muda aqui na mesma tarefa.

Os números de regra (RN-T…) são de `funcional.md`.

## Convenções

- **Dinheiro:** `bigint` em centavos. Reais com centavos só na borda do San
  Checkout (`api.md`).
- **Tempo:** `timestamptz`; America/Sao_Paulo só na tela.
- **Identificador que sai do sistema** (pedido, código do ingresso, código
  público da edição): aleatório, nunca sequencial. O id `bigserial` só
  aparece dentro do Admin.
- **Texto:** tamanho máximo também no banco (`CHECK`), além do validador.
- **RLS:** toda tabela nasce com RLS ligado e sem política, para que a API
  pública do Supabase não leia nada. Um teste trava tabela nova sem RLS,
  como o `tests/rls.test.js` da Mostraí.
- **Histórico que não muda** (termos publicados, aceites, eventos de
  pagamento, auditoria, medição): um gatilho recusa UPDATE e DELETE.
- **Migrations** só acrescentam; aplicada nunca se edita.

## Tabelas

### Catálogo

- **`eventos`**
  - `id`, `nome` (1–120), `slug` (3–60, `[A-Za-z0-9-]`), `criado_em`, `atualizado_em`.
  - Único: `lower(slug)`.
- **`edicoes`**
  - `id`, `evento_id`, `nome` (1–120), `slug` (1–40), `codigo_publico` (10 caracteres aleatórios), `descricao` (até 5.000).
  - Data: `inicio_em`, `fim_em`. Nulo quer dizer "A definir"; `fim_em` precisa ser depois de `inicio_em`.
  - Local: `local_nome`, `cep`, `logradouro`, `numero`, `complemento`, `bairro`, `cidade`, `uf`. Nulos querem dizer "A definir".
  - `classificacao_etaria` (`livre`, `10`, `12`, `14`, `16`, `18`), `capacidade` (nula = sem trava além de lotes e combos).
  - `status` (`rascunho`, `publicado`, `pausado`, `encerrado`), `publicado_em`, `encerrado_em`, `criado_em`, `atualizado_em`.
  - Único: (`evento_id`, `lower(slug)`) e `codigo_publico`.
- **`edicao_imagens`**
  - `id`, `edicao_id`, `tipo` (`banner`, `galeria`), `caminho`, `url`, `ordem`, `criado_em`.
  - No máximo um banner por edição (índice único parcial); até 8 de galeria (servidor).
- **`termos`**
  - `id`, `edicao_id`, `tipo` (`regulamento`, `compra`), `versao` (1, 2, …), `texto` (até 50.000), `hash_sha256`, `vigente`, `publicado_em`, `publicado_por`.
  - Único: (`edicao_id`, `tipo`, `versao`); um só vigente por (`edicao_id`, `tipo`).
  - Imutável, menos a marca `vigente`.
- **`beneficios`**
  - `id`, `edicao_id`, `nome` (1–60), `descricao` (até 300), `ativo`.
- **`categorias`** (tipo de ingresso)
  - `id`, `edicao_id`, `nome` (1–60), `descricao` (até 500), `limite_por_comprador` (nulo ou 1–20), `ativo`, `ordem`.
  - Único: (`edicao_id`, `lower(nome)`).
- **`categoria_beneficios`**
  - (`categoria_id`, `beneficio_id`).
- **`lotes`**
  - `id`, `categoria_id`, `ordem` (1–10), `preco_centavos` (500 a 5.000.000), `quantidade` (1–100.000), `inicio_vendas`, `fim_vendas`.
  - Encerramento: `encerrado_em` e `motivo_encerramento` (`esgotado`, `fim_das_vendas`, `manual`).
  - Único: (`categoria_id`, `ordem`).
- **`promocoes`** (combo)
  - `id`, `edicao_id`, `nome` (1–60), `descricao` (até 500), `preco_total_centavos` (500 a 5.000.000), `quantidade` (1–10.000), `inicio`, `fim`, `ativo`.
- **`promocao_itens`**
  - `id`, `promocao_id`, `categoria_id`, `quantidade` (1–20), `beneficio_id` (o promocional, opcional), `ordem`.
  - A soma das quantidades de um combo fica entre 2 e 20 (servidor).

### Venda

- **`compradores`**
  - `id`, `nome`, `cpf` (11 dígitos), `email`, `telefone`, `criado_em`, `anonimizado_em`.
- **`pedidos`**
  - `id` (UUID), `edicao_id`, `comprador_id`, `origem` (`venda`, `teste`), `total_centavos`.
  - `status`: `aguardando_pagamento`, `pago`, `cancelado`, `expirado`, `estornado`, `pago_sem_vaga`.
  - Prazos: `reserva_expira_em` (criação + 30 min) e `expira_em` (criação + 24 h).
  - `chave_idempotencia` (única), `criado_em`, `pago_em`, `encerrado_em`.
- **`pedido_itens`**
  - `id`, `pedido_id`, `lote_id` **ou** `promocao_id` (um dos dois, nunca os dois), `quantidade`, `preco_unitario_centavos` (congelado na criação), `total_centavos`, `ordem`.
  - A soma dos itens é igual ao total do pedido (conferido na criação).
- **`pagamento_eventos`**
  - `id`, `pedido_id`, `evento_id` (o `eventoId` do Checkout, ou `teste:<uuid>`; único), `provedor` (`san_checkout`, `teste`), `charge_id`, `status`, `valor_centavos`, `ocorrido_em`, `recebido_em`.
  - `resultado`: `aplicado`, `ignorado`, `valor_divergente`, `sem_vaga` e outros.
  - Imutável.
- **`aceites`**
  - `id`, `pedido_id`, `termo_id`, `hash_sha256` (do texto aceito), `ip`, `user_agent`, `aceito_em`.
  - Imutável. Quem preenche é a página pública (próxima fase).

### Emissão

- **`participantes`**
  - `id`, `edicao_id`, `nome` (2–120), `cpf`, `email`, `criado_em`, `anonimizado_em`.
  - Vínculo: `pedido_item_id` + `posicao` no pedido; nulos na cortesia.
  - Único: (`pedido_item_id`, `posicao`).
- **`cortesias`**
  - `id`, `edicao_id`, `classificacao` (`convidado`, `equipe`, `patrocinador`, `promocional`), `emitida_por`, `emitida_por_access`, `chave_idempotencia` (única), `criado_em`.
- **`ingressos`**
  - `id`, `codigo` (128 bits aleatórios em base64url; único), `edicao_id`, `participante_id` (obrigatório e único).
  - Origem: `categoria_id`, `lote_id`, `promocao_id`, `pedido_item_id` + `posicao`, `cortesia_id`; `origem` (`pago`, `cortesia`); `valor_centavos`.
  - Situação: `status` (`valido`, `bloqueado`, `cancelado`), `emitido_em`, `cancelado_em`, `motivo_cancelamento`.
  - Único: (`pedido_item_id`, `posicao`). É o que impede o reenvio de emitir de novo.
  - Trava: `origem = cortesia` ⇔ `cortesia_id` preenchido, `valor_centavos = 0` e sem pedido; `origem = pago` ⇔ pedido preenchido.
- **`ingresso_beneficios`**
  - (`ingresso_id`, `beneficio_id`), `nome` (cópia feita na emissão), `origem` (`categoria`, `promocao`, `cortesia`), `resgatado_em` (para o check-in futuro).

### Acesso

- **`operadores`**
  - `id`, `nome` (2–120), `email`, `email_normalizado` (único), `senha_hash` (scrypt, mesmo formato da Mostraí).
  - `status`: `aguardando_ativacao`, `ativo`, `desativado`.
  - Código de ativação: `codigo_hash` (HMAC), `codigo_expira_em`, `codigo_tentativas`.
  - `criado_em`, `ativado_em`, `desativado_em`, `ultimo_acesso_em`, `anonimizado_em`.
- **`operador_permissoes`**
  - `id`, `operador_id`, `permissao` (só `checkin`), `edicao_id` (nulo = todas as edições).
  - Único: (`operador_id`, `permissao`, `edicao_id`).
- **`checkins`** — só a estrutura nesta versão.
  - `id`, `ingresso_id`, `operador_id`, `escopo` (`entrada`, `beneficio`), `beneficio_id`, `resultado` (`aceito`, `recusado`), `motivo`, `registrado_em`, `lido_no_aparelho_em`, `aparelho`.
  - Único parcial: uma `entrada` `aceito` por ingresso.

### Governança

- **`auditoria`**
  - `id`, `ocorrido_em`, `autor` (usuário do Admin), `autor_access` (e-mail do Cloudflare Access), `acao`, `entidade`, `entidade_id`, `detalhe` (jsonb, sem dado pessoal).
  - Imutável.
- **`metricas`**
  - `id`, `nome` (`categoria:objeto_acao`), `propriedades` (jsonb, sem dado pessoal), `ocorrido_em`.
  - Imutável. Nasce se o dono confirmar D1.

## Travas e invariantes

| Regra dura (`CONSTRAINTS.md`) | Onde mora |
|---|---|
| 1. código único + QR | `ingressos.codigo` único; o QR é montado e assinado no servidor (`api.md`, "QR") |
| 2. pedido com vários ingressos | `pedido_itens` 1:N; ingressos por item e posição |
| 3. participante próprio | `ingressos.participante_id` obrigatório e único |
| 4. combo gera individuais | item com `promocao_id` vira um ingresso por posição, pela soma de `promocao_itens` |
| 5. cortesia não é receita | trava de origem e valor; receita = soma de `pedidos.total_centavos` com `status = pago` e `origem = venda` |
| 6. só depois da confirmação | ingresso pago só nasce na confirmação, na mesma transação que passa o pedido a `pago` |
| 7. idempotência | `pagamento_eventos.evento_id` único, `ingressos (pedido_item_id, posicao)` único, `pedidos.chave_idempotencia` e `cortesias.chave_idempotencia` únicos |
| 8. sem venda acima | transação que trava a linha da edição e conta pagos + reservas vivas por lote, por combo e na capacidade |
| 9. QR sem dado pessoal | QR = versão, `edicoes.codigo_publico`, `ingressos.codigo` e assinatura |
| 10. aceite com versão | `aceites.termo_id` + hash; `termos` imutável |
| 11. operador só check-in | `operador_permissoes.permissao` só aceita `checkin`; sessão própria (`api.md`) |
| 12. LGPD | colunas `anonimizado_em`; nada pessoal em `auditoria` nem em `metricas`; `inventario-de-dados.md` |

## Disponibilidade, em contas

- **vendidos(lote)** = ingressos não cancelados do lote + vagas de pedidos
  `aguardando_pagamento` com `reserva_expira_em` no futuro.
- **sobra(lote k)** = se o lote k está encerrado, o maior entre zero e
  disponível(k); senão, zero.
- **disponível(lote k)** = quantidade(k) + sobra(k − 1) − vendidos(k). É a
  cota não paga rolando para o próximo (RN-T11).
- **disponível(combo)** = quantidade do combo − (combos com ingresso não
  cancelado + combos reservados vivos).
- **ocupação(edição)** = ingressos não cancelados (pagos, de combo e
  cortesias) + posições reservadas vivas (lotes e combos). Se há
  capacidade, a ocupação nunca passa dela (RN-T07).
