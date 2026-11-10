# Trimundi — mapa das rotas

Contrato de cada rota. As regras (RN-T…) estão em `funcional.md`. Todas
existem desde 09/11/2026 (Etapas 1 a 6), com teste em `tests/trimundi-*`.

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
| `POST /admin/trimundi/edicoes` | `{ evento: { id } \| { nome, slug? }, edicao: { nome, slug?, descricao, inicio_em, fim_em, local…, classificacao_etaria, capacidade, regulamento, termos_compra } }` → 201 com a ficha. A edição nasce em `rascunho`. Sem `slug` (ou vazio), o endereço sai do nome, com `-2`, `-3`... se já existir (RN-T01) |
| `GET /admin/trimundi/edicoes/:id` | a ficha: campos, termos vigentes (versão, data) e imagens |
| `PATCH /admin/trimundi/edicoes/:id` | altera campos. Texto de termos diferente do vigente vira versão nova (RN-T05). Endereço depois de publicado → 409 (RN-T02) |
| `POST /admin/trimundi/edicoes/:id/status` | `{ status }`, com as transições de RN-T03 → 409 ou 422 |
| `POST /admin/trimundi/edicoes/:id/imagens` | multipart: `arquivo` e `tipo` (`banner`, `logo` ou `galeria`) → 201 (RN-T06). Banner e logo: um por edição, o novo substitui |
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
| `GET /admin/trimundi/edicoes/:id/participantes` | `?filtro=todos\|pagos\|cortesias\|testes\|cancelados\|utilizados&busca=&pagina=` → `{ itens, total, pagina, por_pagina }` (RN-T22). CPF mascarado (`***.456.789-**`); a busca aceita o CPF inteiro |
| `GET /admin/trimundi/edicoes/:id/resumo` | números da edição (D1): pagos, cortesias, participantes, entradas, receita confirmada, reembolsado, receita líquida, cancelados, reembolsos, chargebacks — teste fora |
| `GET /admin/trimundi/edicoes/:id/avisos` | o que pede ação: sem vaga, valor divergente, pagamento duplicado, devolução feita fora, aviso morto, reembolso recusado ou a reenviar, chargeback |
| `GET /admin/trimundi/pedidos/:pedido` | ficha do pedido: itens, ingressos, reembolsos |
| `POST /admin/trimundi/pedidos/:pedido/link` | link novo da página do pedido (o antigo segue valendo) |
| `POST /admin/trimundi/pedidos/:pedido/reembolsos` | `{ motivo, ingresso_id? }` → pede o estorno ao Checkout com a nossa chave; o ingresso fica bloqueado até o aviso. 409 se não pago ou nada a devolver; 502 se o Checkout recusar de vez |
| `POST /admin/trimundi/reembolsos/:id/reenviar` | reenvia com a MESMA chave |
| `POST /admin/trimundi/edicoes/:id/pedido-teste` | pedido de teste (RN-T19); 403 em produção |
| `POST /admin/trimundi/edicoes/:id/avisos/resolver` | `{ chave, motivo }` → o aviso some (só ele; nada muda no pedido). Fato novo do mesmo tipo volta |
| `POST /admin/trimundi/titular/consultar` | `{ cpf }` → tudo que a Trimundi guarda da pessoa (exportação, `no-store`). CPF só no corpo |
| `POST /admin/trimundi/titular/anonimizar` | `{ cpf, motivo }` → anonimiza participante e comprador sem guarda legal; comprador com pagamento fica pelo prazo, informado na resposta |
| `POST /admin/trimundi/edicoes/:id/cortesias` | `{ nome, cpf, email, categoria_id, beneficio_id, classificacao, chave }` → 201 com o ingresso. A mesma `chave` devolve o mesmo ingresso (RN-T20) |
| `GET /admin/trimundi/ingressos/:id/qr` | `image/png`, ou `?formato=svg` (RN-T23) |
| `POST /admin/trimundi/ingressos/:id/cancelar` | `{ motivo }`, só para cortesia → 409 para pago (RN-T21) |

### Operadores — T5

| Método e rota | O que faz |
|---|---|
| `GET /admin/trimundi/operadores` | lista, com `indicacao: { codigo, links[], pessoas, compras, ingressos }` (só conversões confirmadas, todas as edições) |
| `GET /admin/trimundi/operadores/:id/desempenho` | ficha: operador, código, links por edição autorizada, totais, histórico por edição e compradores indicados (CPF mascarado) |
| `POST /admin/trimundi/operadores` | `{ nome, email, edicoes: 'todas' \| [ids] }` → 201 `{ operador, codigo }`. O código só aparece nesta resposta. (`indicacao_habilitada` ainda é aceito, mas não decide mais nada: todo operador tem link) |
| `PATCH /admin/trimundi/operadores/:id` | altera nome e edições |
| `POST /admin/trimundi/operadores/:id/codigo` | gera código novo → `{ codigo }` (RN-T25) |
| `POST /admin/trimundi/operadores/:id/desativar` | desativa |
| `POST /admin/trimundi/operadores/:id/reativar` | volta a ativo (ou a aguardando ativação, se nunca ativou) |

### Indicação

| Método e rota | O que faz |
|---|---|
| `GET /admin/trimundi/edicoes/:id/campanhas` | campanhas da edição, com indicações válidas, recompensas concedidas e entregues |
| `POST /admin/trimundi/edicoes/:id/campanhas` | `{ nome, recompensa, quantidade, indicacoes_por_recompensa, limite_por_indicador?, inicio?, fim?, ativo? }` → 201. 409 se já houver outra ativa na edição |
| `PATCH /admin/trimundi/campanhas/:id` | altera; a quantidade não fica abaixo do concedido (409) |
| `GET /admin/trimundi/campanhas/:id/indicadores` | quem indicou: nome, tipo, código, indicações pagas e recompensas (sem CPF nem e-mail) |
| `POST /admin/trimundi/recompensas/:id/entregar` | marca entregue (uma vez; a segunda é 409) |
| `GET /admin/trimundi/edicoes/:id/ranking` | ranking da edição: `[{ posicao, nome, categoria (comprador\|operador), pessoas, compras, ingressos }]` — só conversões confirmadas |
| `GET /admin/trimundi/edicoes/:id/ranking.csv` | o mesmo em CSV (`;`, UTF-8 com BOM), sem CPF, e-mail nem código; nome com cara de fórmula ganha apóstrofo |
| `GET /admin/trimundi/edicoes/:id/compradores/:cliente` | ficha do comprador na edição: conta (CPF mascarado), compra, pedidos, quem indicou, link e pessoas indicadas com totais |
| `GET /admin/trimundi/edicoes/:id/checkin/conflitos` | leituras sem internet que o servidor recusou ao sincronizar (já tinha entrada, cancelado ou bloqueado depois do pacote), com a entrada que valeu |
| `POST /admin/trimundi/clientes/:id/cpf` | CPF inteiro de um comprador; fica na auditoria (`cpf_consultado`) |

Benefício (em "Benefícios" acima) ganhou `quantidade` (vazio = sem limite) e
devolve `concedidos`, `resgatados` e `restam`; cada lote aceita
`beneficio_id`.

## Operador — `/ticket/*`

As páginas são servidas por rota, não por `public/`. O servidor da Mostraí
redireciona `/x` para `/x.html` em todo HTML de `public/`, e os endereços
aqui precisam ser exatamente `/ticket/ativar` e `/ticket/checkin`. Os
scripts das páginas ficam em `public/ticket/`.

| Método e rota | Quem | O que faz |
|---|---|---|
| `GET /ticket/ativar` | sem sessão | página T6 |
| `GET /ticket/entrar` | sem sessão | login do operador (próprio da Trimundi) |
| `POST /ticket/api/operador/entrar` | sem sessão | `{ email, senha }` → 200 `{ ok, destino: '/ticket/checkin' }` e sessão nova; 401 igual com ou sem operador; 403 desativado. Limitador por IP e e-mail |
| `POST /ticket/api/ativar` | sem sessão | `{ email, codigo, senha }` → 200 `{ ok: true }`. Limitador por IP e por e-mail (RN-T26); 400, 410 ou 429 |
| `GET /ticket/checkin` | sessão de operador | página T8. Sem sessão de operador → 302 para `/ticket/entrar` |
| `GET /ticket/api/operador` | sessão de operador | `{ nome, edicoes, indicacao }` (`indicacao` = `{ codigo, links[] das edições autorizadas, campanhas[] }`; todo operador tem). Sem sessão ou operador desativado → 401 (RN-T28) |
| `GET /ticket/api/checkin/pacote?edicao=` | sessão de operador da edição | pacote para o check-in sem internet: `{ versao, gerado_em, edicao: { id, nome, codigo_publico, classificacao_etaria }, chave_publica (Ed25519, SPKI base64url), ingressos: [{ i, h: sha256(código), c: sha256(código público:código curto), s: situação, u: já entrou, t: tipo, n: primeiro nome }] }` — sem CPF, e-mail nem código em claro. Outra edição → 403 |
| `POST /ticket/api/checkin/sincronizar` | sessão de operador da edição | `{ edicao_id, aparelho_id, registros: [{ registro_id (uuid), ingresso_id, lido_em }] }` (até 500) → `{ resultados: [{ registro_id, resultado: aceito \| conflito \| recusado \| invalido, motivo, entrada? }] }`. Idempotente pelo `registro_id`; a entrada aceita segue única por ingresso |
| `POST /ticket/api/sair` | sessão de operador | encerra a sessão → 200 |
| `POST /ticket/api/checkin/consultar` | sessão de operador | `{ edicao_id, entrada }` (texto do QR ou código curto) → `{ resultado, mensagem, ingresso? }`; 403 sem permissão na edição. Não registra nada |
| `POST /ticket/api/checkin/confirmar` | sessão de operador | `{ edicao_id, ingresso_id, lido_em? }` → `entrada_registrada` ou o motivo da recusa; entrada única por ingresso (índice no banco + trava da linha) |
| `POST /ticket/api/checkin/beneficio` | sessão de operador | `{ edicao_id, ingresso_id, beneficio_id }` → `resgatado` ou `ja_resgatado` (uma entrega por benefício); 404 sem o benefício, 409 ingresso cancelado ou bloqueado |
| `GET /ticket/api/checkin/contador?edicao=` | sessão de operador | `{ entradas, ingressos }` |
| `GET /ticket/jsqr.js` | público | leitor de QR para navegador sem BarcodeDetector (CSP só aceita script do site) |

## Comprador — `/ticket/*`

| Método e rota | O que faz |
|---|---|
| `GET /ticket/:evento/:edicao` | página T9 (404 em rascunho), com título e imagem para compartilhamento |
| `GET /ticket/api/edicoes/:evento/:edicao` | vitrine: dados, textos vigentes, tipos (preço e lote do vigente, próximo lote, `disponibilidade` — "Disponível" ou "Últimas N" —, `beneficio_do_lote` com o que resta, quantidade máxima) e combos |
| `POST /ticket/api/cotacao` | `{ evento, edicao, itens }` → itens com preço por lote, total, vagas (uma por ingresso) e os ids dos termos vigentes. Não reserva |
| `POST /ticket/api/pedidos` | **exige conta logada e confirmada** (401 `conta`). `{ evento, edicao, itens, participantes[] (ou `{ conta: true }` = "é meu"), aceite: { aceito, termos[] }, chave, indicacao? }` → 201 `{ pedido_id, token, url, pagamento, reserva_expira_em }`; o comprador vem da conta, nunca do corpo; a mesma chave, da mesma conta → 200 com o mesmo pedido (de outra conta → 409). 409 `esgotado`, `limite` (por tipo), `limite_cpf` (limite da edição por CPF, com `disponivel`), `termos` ou `pedido_pendente` (o CPF já tem um pedido aguardando pagamento na edição; volta `url` desse pedido) |
| `GET /ticket/api/pedidos/:id` | com `X-Pedido-Token` (ou `?t=`): pedido, pagamento e ingressos com QR; 404 sem token válido |
| `GET /ticket/pedido/:id` | página T10 |
| `POST /ticket/api/recuperar` | `{ email, cpf }` → resposta sempre igual; o link vai para o e-mail do comprador |
| `GET /ticket/recuperar` | página T11 |
| `GET /ticket/dev/pagamento/:id`, `POST /ticket/api/dev/pagamento/:id` | só com `TRIMUNDI_PAGAMENTO_SIMULADO=1` fora de produção (404 no resto) |

## Home pública — `/tic`

| Método e rota | O que faz |
|---|---|
| `GET /tic` | 302 para `/tic/eventos` |
| `GET /tic/eventos` | home da TICK: eventos publicados (ou pausados) que ainda não terminaram, busca e cards com banner, nome, data e local; cada card leva a `/ticket/<evento>/<edição>` |
| `GET /ticket/api/vitrine?q=` | a lista da home (até 60), com busca por evento, edição, local ou cidade |

A conta TICK usa o cookie `tick.sid` (path `/ticket`), separado do
`connect.sid` da Mostraí e do `mostrai.admin` do Admin (`src/lib/sessao.js`).

## Conta do cliente — `/ticket/conta`

| Método e rota | O que faz |
|---|---|
| `GET /ticket/conta`, `/ticket/conta/confirmar`, `/esqueci`, `/redefinir` | uma página: entrar, criar conta, confirmar e-mail, recuperar senha e "minha conta" |
| `POST /ticket/api/conta/cadastro` | `{ nome, cpf, email, senha, senha_confirmacao, maioridade: true, aceite_termos: true, versao_termos }` (sem os aceites ou com a confirmação diferente → 400; `versao_termos` diferente da vigente — a página manda a que mostrou, de `<meta name="tick-termos">` — → 409 `versao_termos` com `versao`, nada é criado). O aceite vira uma linha em `aceites_conta` (origem `cadastro`). Uma conta por CPF e por e-mail: 409 `email_em_uso` ("Este e-mail já possui uma conta. Entre na sua conta.") ou `cpf_em_uso` ("Este CPF já possui uma conta vinculada. Entre na sua conta."), com `entrar: '/ticket/conta'`; garantido no banco (índices únicos) e serializado por CPF e e-mail → 201 com a mesma mensagem exista ou não conta com o e-mail (a existente não muda e o dono dela é avisado); 409 `cpf_em_uso` se o CPF é de outra conta |
| `POST /ticket/api/conta/confirmar` | `{ token }` (vem no fragmento `#t=` do link) → abre sessão; uso único, 48 h |
| `POST /ticket/api/conta/reenviar` | `{ email }` → resposta sempre igual |
| `POST /ticket/api/conta/entrar` | `{ email, senha }` → sessão nova; 401 igual com ou sem conta; 403 `nao_confirmado` |
| `POST /ticket/api/conta/sair` | sai da conta |
| `POST /ticket/api/conta/esqueci` | `{ email }` → resposta sempre igual; link de 60 min |
| `POST /ticket/api/conta/redefinir` | `{ token, senha }` → senha nova, sessões antigas caem |
| `POST /ticket/api/conta/aceite` | `{ maioridade: true, aceite_termos: true, versao_termos }` → aceita a versão atual dos Termos (conta logada); versão diferente da vigente → 409 `versao_termos`. Nova linha em `aceites_conta` (origem `reaceite`); as anteriores ficam |
| `GET /ticket/termos`, `GET /ticket/privacidade` | Termos de Uso e Política de Privacidade v1.2 — o texto oficial, sem mudança (`docs/trimundi/legal/*.txt`, conferido por teste) |
| `GET /ticket/api/conta/sessao` | `{ logado, nome, email }` (a página do evento sabe se pede login) |
| `GET /ticket/api/conta` | conta (CPF mascarado); `edicoes[]` — um grupo por edição (`evento`, `edicao`, `inicio_em`, `local`) com `pedidos[]` (`codigo`, `status`, `situacao`, `itens[]`, `reserva_expira_em`, `ingressos[]` com QR só se o pedido está pago e o ingresso válido e não usado); `ingressos[]` (lista plana, compatibilidade); e a indicação (`codigo`, `link_geral` permanente `/tic/eventos?ind=…`, `links[]` de cada edição à venda, campanhas e `numeros: { acessos, contas_criadas, pessoas, compras, ingressos }`) — nenhum dado de quem visitou ou comprou |
| `POST /ticket/api/conta/pedidos/:id/link` | conta logada, dona do pedido, pedido aguardando pagamento com reserva viva → `{ url }` ("Continuar pagamento"); qualquer outro caso → 404 |
| `POST /ticket/api/indicacao/visita` | `{ codigo, visitante }` (visitante = id aleatório do navegador, 16–64 `[A-Za-z0-9_-]`) → `{ indicacao: { nome, tipo } \| null }`. Registra o acesso único (só o hash SHA-256 do visitante; a própria conta não conta; 60 por hora por IP) |
| `POST /ticket/api/edicoes/:evento/:edicao/indicacao` | `{ codigo?, visitante? }` (com `visitante`, conta o acesso único como a rota acima) → `{ indicacao: { nome, tipo } \| null }` para o aviso "Você chegou por indicação de…". Com conta logada, registra a origem da conta na edição (o primeiro link que valeu fica) |

## Rotas da Mostraí

Nenhuma muda. `POST /anunciantes/login` voltou a ser o da `main` (o login
de operador e o de cliente são da Trimundi, acima). Da Mostraí, só o Admin
ganhou a aba Eventos.

## QR

- **Conteúdo:** `TM1.<edicoes.codigo_publico>.<ingressos.codigo>.<assinatura>`.
- **Assinatura:** Ed25519, em base64url, sobre
  `TM1.<edicoes.codigo_publico>.<ingressos.codigo>`.
- **Chave da edição:** derivada (HKDF) de `TRIMUNDI_SEGREDO` (variável de
  ambiente, só no servidor) e do código público da edição. A chave pública
  pode ser exportada para validação sem internet (`qr.js#chavePublicaDaEdicao`).
- **Trocar `TRIMUNDI_SEGREDO`** invalida todos os QR já emitidos
  (`RUNBOOK.md` §11).

## Contrato com o San Checkout

Contrato do San Checkout, `API.md` v2 (lido no commit `836fdee`). A
Trimundi é contratante próprio: `contratante_id`, chave (`X-Checkout-Key`),
URL base e webhook só dela.

| Método e rota | Contrato |
|---|---|
| `GET /ticket/api/checkout/pedido/:pedidoId` | API.md §4.1. Confere a chave (401 se não bater) e responde em menos de 45 s. `valorUnitario`, `valorCheio` e `valorComDesconto` em reais; `pagador` com documento e telefone; `expiraEm` = `pedidos.reserva_expira_em` (30 min) |
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
- `recusado`, `vencido` → marca a recusa; o pedido segue aguardando até a
  reserva vencer (dá para tentar outro meio).
- `chargeback` → bloqueia os ingressos do pedido (só gente desbloqueia).
- `estornado` → cancela os ingressos, confirma o reembolso pedido (ou
  registra a devolução feita fora) e o pedido vira `estornado`.
- `estornado_parcialmente` → confirma os reembolsos por ingresso que o
  `valorEstornado` acumulado cobre; o que sobrar sem pedido vira aviso.
- `estorno_negado` → reembolso negado e ingressos de volta a válidos.
- `pendente` (baixa desfeita) → bloqueia; um `confirmado` depois desbloqueia.
- Outro `chargeId` confirmado no mesmo pedido → emite uma vez só e vira
  aviso de pagamento duplicado.
- Status desconhecido → 200, ignorado.

**Conciliação** (a cada 6 h no processo, ou `npm run trimundi:conciliar`):
`GET /api/checkout/cobranca/{contratanteId}/{pedidoId}` para todo pedido
aguardando/expirado dos últimos 2 dias e todo pago com reembolso ainda
aberto; o fato entra pela mesma fila dos avisos.

**Estorno:** `POST /api/checkout/estornar` com `chaveIdempotencia` própria
por estorno (`tm-<uuid>`), sem `valor` no total e com `valor` (reais) no
parcial. O 200 já entra na fila como fato; 5xx, 429 e 409 de reconciliação
ficam para reenviar com a mesma chave; 409 definitivo
(`chave_idempotencia_reutilizada`, `estorno_impossivel`,
`mais_de_uma_cobranca_paga`, `estorno_de_parcelamento`) falha e devolve o
ingresso a válido.
