# Trimundi — mapa das rotas

Contrato de cada rota. As regras (RN-T…) estão em `funcional.md`. Nesta
etapa nenhuma rota existe ainda: elas nascem nas Etapas 1 a 7, e a seção
"Reservadas" só na fase do checkout.

## Convenções

- **Corpo:** JSON na entrada e na saída. Erro sempre como
  `{ "erro": "<texto>" }`, com o texto de `funcional.md` §6 (padrão da
  Mostraí).
- **Códigos:**
  - 400 dado inválido;
  - 401 sem sessão;
  - 403 sem permissão;
  - 404 não existe;
  - 409 conflito de estado (esgotado, transição proibida, já existe);
  - 410 código vencido;
  - 422 falta campo para publicar;
  - 429 excesso de tentativas;
  - 503 Trimundi não configurada (`{ "erro": "a Trimundi não está
    configurada neste ambiente" }`).
- **Dinheiro:** sempre `*_centavos` (inteiro) nas rotas da Trimundi. Reais
  com centavos só na borda do Checkout.
- **Limites de tamanho:** os de `modelo-de-dados.md`, conferidos no
  validador antes do banco.
- **Datas:** ISO 8601 com fuso.

## Admin — `/admin/trimundi/*`

Todas exigem a sessão do Admin (`isAdmin`, cookie `mostrai.admin`) e passam
pelo Cloudflare Access, que cobre `/admin`. Toda escrita grava o histórico
(RN-T29).

### Estado

| Método e rota | O que faz |
|---|---|
| `GET /admin/trimundi/estado` | `{ configurada }`, o banco existe |

### Evento e edição — T1 e T1a

| Método e rota | O que faz |
|---|---|
| `GET /admin/trimundi/edicoes` | lista: `[{ id, evento: { id, nome, slug }, nome, slug, status, inicio_em, local_nome, endereco_publico }]` |
| `GET /admin/trimundi/eventos` | eventos para "Evento já cadastrado" |
| `POST /admin/trimundi/edicoes` | `{ evento: { id } \| { nome, slug }, edicao: { nome, slug, descricao, inicio_em, fim_em, local…, classificacao_etaria, capacidade, regulamento, termos_compra } }` → 201 com a ficha. A edição nasce em `rascunho` |
| `GET /admin/trimundi/edicoes/:id` | a ficha: campos, termos vigentes (versão, data) e imagens |
| `PATCH /admin/trimundi/edicoes/:id` | altera campos. Texto de termos diferente do vigente vira versão nova (RN-T05). Endereço depois de publicado → 409 (RN-T02) |
| `POST /admin/trimundi/edicoes/:id/status` | `{ status }`, com as transições de RN-T03 → 409 ou 422 |
| `POST /admin/trimundi/edicoes/:id/imagens` | multipart: `arquivo` e `tipo` (`banner` ou `galeria`) → 201 (RN-T06) |
| `DELETE /admin/trimundi/imagens/:id` | remove a imagem |

### Benefícios

| Método e rota | O que faz |
|---|---|
| `GET /admin/trimundi/edicoes/:id/beneficios` | o catálogo |
| `POST /admin/trimundi/edicoes/:id/beneficios` | `{ nome, descricao }` → 201 |
| `PATCH /admin/trimundi/beneficios/:id` | altera ou inativa |

### Tipos de ingresso e lotes — T2

| Método e rota | O que faz |
|---|---|
| `GET /admin/trimundi/edicoes/:id/tipos` | tipos com lotes e números calculados no servidor: vendidos, reservados, disponíveis (já com a sobra, RN-T11) e situação |
| `POST /admin/trimundi/edicoes/:id/tipos` | `{ nome, descricao, limite_por_comprador, ativo, beneficios: [ids], lotes: [{ preco_centavos, quantidade, inicio_vendas, fim_vendas }] }` → 201 |
| `PATCH /admin/trimundi/tipos/:id` | altera o tipo, acrescenta lotes e altera lotes sem descer abaixo do vendido (RN-T09) |
| `POST /admin/trimundi/lotes/:id/encerrar` | encerramento à mão (RN-T10) |

### Promoções — T3

| Método e rota | O que faz |
|---|---|
| `GET /admin/trimundi/edicoes/:id/promocoes` | combos com vendidos, disponíveis e situação |
| `POST /admin/trimundi/edicoes/:id/promocoes` | `{ nome, descricao, itens: [{ categoria_id, quantidade, beneficio_id }], preco_total_centavos, quantidade, inicio, fim, ativo }` → 201 (RN-T16) |
| `PATCH /admin/trimundi/promocoes/:id` | altera, ativa ou inativa |

### Participantes e cortesias — T4

| Método e rota | O que faz |
|---|---|
| `GET /admin/trimundi/edicoes/:id/participantes` | `?filtro=todos\|pagos\|cortesias\|testes\|cancelados&busca=&pagina=` → `{ itens, total, pagina }` (RN-T22) |
| `POST /admin/trimundi/edicoes/:id/cortesias` | `{ nome, cpf, email, categoria_id, beneficio_id, classificacao, chave }` → 201 com o ingresso. A mesma `chave` devolve o mesmo ingresso (RN-T20) |
| `GET /admin/trimundi/ingressos/:id/qr` | `image/png`, ou `?formato=svg` (RN-T23) |
| `POST /admin/trimundi/ingressos/:id/cancelar` | `{ motivo }`, só para cortesia → 409 para pago (RN-T21) |

### Operadores — T5

| Método e rota | O que faz |
|---|---|
| `GET /admin/trimundi/operadores` | lista, com a marca "bloqueado pela conta da Mostraí" (RN-T24) |
| `POST /admin/trimundi/operadores` | `{ nome, email, edicoes: 'todas' \| [ids] }` → 201 `{ operador, codigo }`. O código só aparece nesta resposta |
| `PATCH /admin/trimundi/operadores/:id` | altera nome e edições |
| `POST /admin/trimundi/operadores/:id/codigo` | gera código novo → `{ codigo }` (RN-T25) |
| `POST /admin/trimundi/operadores/:id/desativar` | desativa |
| `POST /admin/trimundi/operadores/:id/reativar` | volta a ativo (ou a aguardando ativação, se nunca ativou) |

## Operador — `/ticket/*`

As páginas são servidas por rota, não por `public/`. O servidor da Mostraí
redireciona `/x` para `/x.html` em todo HTML de `public/`, e os endereços
aqui precisam ser exatamente `/ticket/ativar` e `/ticket/checkin`. Os
scripts das páginas ficam em `public/ticket/`.

| Método e rota | Quem | O que faz |
|---|---|---|
| `GET /ticket/ativar` | sem sessão | página T6 |
| `POST /ticket/api/ativar` | sem sessão | `{ email, codigo, senha }` → 200 `{ ok: true }`. Limitador por IP e por e-mail (RN-T26); 400, 410 ou 429 |
| `GET /ticket/checkin` | sessão de operador | página T8. Sem sessão de operador → 302 para `/anunciante/login.html` |
| `GET /ticket/api/operador` | sessão de operador | `{ nome, edicoes: 'todas' \| [{ id, nome }] }`. Sem sessão ou operador desativado → 401 (RN-T28) |
| `POST /ticket/api/sair` | sessão de operador | encerra a sessão → 200 |

## A única rota da Mostraí que muda

`POST /anunciantes/login` — RN-T27; autorizado pelo dono em 09/11/2026 (é
mudança de autenticação).
- **Conta da Mostraí:** nada muda — mesma resposta, mensagens, limitador e
  sessão.
- **E-mail sem conta da Mostraí:**
  - operador ativo com a senha certa → 200
    `{ "operador": true, "destino": "/ticket/checkin" }` e sessão nova com
    `trimundiOperadorId`;
  - operador desativado com a senha certa → 403 com o texto de §6 (T7);
  - qualquer outro caso → o mesmo 401 de hoje;
  - banco da Trimundi fora do ar → 503 com o texto de §6 (T7).
- **Trimundi não configurada:** o login nem procura operador.
- **A tela** (`public/anunciante/login.page.js`) segue o `destino` só quando
  ele é caminho do próprio site em `/ticket/` (sem redirecionamento aberto).

## QR

- **Conteúdo:** `TM1.<edicoes.codigo_publico>.<ingressos.codigo>.<assinatura>`.
- **Assinatura:** Ed25519, em base64url, sobre
  `TM1.<edicoes.codigo_publico>.<ingressos.codigo>`.
- **Chave da edição:** derivada de `TRIMUNDI_SEGREDO_QR` (variável de
  ambiente, só no servidor) e do código público da edição. A chave pública
  fica disponível para o check-in validar sem internet (fase do check-in).
- **Trocar `TRIMUNDI_SEGREDO_QR`** invalida todos os QR já emitidos.
  Procedimento no `RUNBOOK.md`, quando o código existir.

## Reservadas — fase do checkout (não existem)

Contrato do San Checkout, `API.md` v2 (lido no commit `836fdee`). A
Trimundi é contratante próprio: `contratante_id`, chave (`X-Checkout-Key`),
URL base e webhook só dela.

| Método e rota | Contrato |
|---|---|
| `GET /ticket/:evento/:edicao` | página pública da edição |
| `GET /ticket/api/checkout/pedido/:pedidoId` | API.md §4.1. Confere a chave (401 se não bater) e responde em menos de 45 s. `valorUnitario`, `valorCheio` e `valorComDesconto` em reais; `pagador` com documento e telefone; `expiraEm` = `pedidos.expira_em` |
| `POST /ticket/api/checkout/webhook` | API.md §4.3. HMAC sobre `"{timestamp}.{corpo cru}"`, janela de 300 s, comparação em tempo constante. Responde 200 rápido e processa depois; deduplica pelo `eventoId` |

**Status do pedido para o Checkout:**

| Status interno | Vai como |
|---|---|
| `aguardando_pagamento` | `pendente` (com `expiraEm`) |
| `pago` | `pago` |
| `cancelado`, `expirado`, `estornado`, `pago_sem_vaga` | `cancelado` |

**O que cada status do webhook faz:**
- `confirmado` → confirmação (RN-T18).
- `em_analise` → nada.
- `recusado`, `vencido` → libera a reserva e cancela o pedido.
- `chargeback` → bloqueia os ingressos do pedido.
- `estornado` → cancela os ingressos e o pedido vira `estornado`.
- `estornado_parcialmente` → só registra; o ajuste é à mão.
- `estorno_negado`, `pendente` → registra.
- `pagamentoDuplicado: true` → emite uma vez só e abre a devolução da outra
  cobrança.
- Status desconhecido → 200, ignorado.

**Conciliação diária:** `GET /api/checkout/cobranca/{contratanteId}/{pedidoId}`
para todo pedido ainda aguardando pagamento.

**Estorno:** `POST /api/checkout/estornar` com `chaveIdempotencia` própria
por estorno.
