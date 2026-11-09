# Trimundi — auditoria do estado atual

> **Retrato histórico do commit `8cb4dc6`, superado.** Depois desta
> auditoria o dono simplificou o escopo e as decisões mudaram (esquema
> `trimundi` no banco da Mostraí, marca própria, conta do cliente,
> benefício por lote, indicação, login próprio do operador). O estado que
> vale é o de `STATUS-IMPLEMENTACAO.md` e `pendencias.md`. Os riscos daqui
> foram tratados assim: o de reter estoque sem pagar caiu com a conta
> obrigatória e o limite de um pedido aberto por conta e edição; o das
> decisões não aplicadas caiu com a ADR-049.

Data: 09/11/2026. Auditoria só de leitura: nenhum código alterado, nenhum
commit, migration ou deploy. Avaliado: o código da branch, os testes
executados e o banco local (só consulta). Documentação não conta como
implementação.

## Contexto verificado

| Item | Estado real | Evidência |
|---|---|---|
| Branch | `claude/beautiful-faraday-cjq1nt` | `git branch --show-current` |
| Último commit avaliado | `8cb4dc6` (7 commits da Trimundi sobre a `main`) | `git log` |
| PR | [sancompany/MostrAi#137](https://github.com/sancompany/MostrAi/pull/137): **aberto, rascunho, não integrado**; CI "testes" verde no `8cb4dc6` | GitHub |
| Produção (`main` = `f344882`) | **nenhum** arquivo da Trimundi; nada está no ar | `git merge-base --is-ancestor 8cb4dc6 origin/main` → não |
| Tamanho | 86 arquivos, +14.463 linhas sobre a `main` | `git diff --stat origin/main...HEAD` |
| **Alterações não commitadas** | 6 arquivos com trabalho **incompleto** de antes do reinício do processo: `config.js`, `db/conexao.js`, `db/migrate.js`, `001_fundacao.sql`, `armazenamento.js`, `disponibilidade.js` | `git status` |

As alterações não commitadas tentavam aplicar as decisões da última
mensagem do dono: esquema `trimundi` no banco da Mostraí, Storage e e-mail
da Mostraí, lote sem sobra para o seguinte. Estão **pela metade**:
- `pedidos.js` e `pagamentos.js` não foram ajustados;
- a nova função `marcarEsgotados` não é chamada por ninguém;
- os testes não foram atualizados.

Não estão testadas e **não devem ser usadas como estão**. Esta auditoria
avalia o `8cb4dc6`; essas alterações aparecem só aqui e na Parte 5.

## Parte 1 — Resumo executivo

**Estado geral:**
- Em desenvolvimento local, o fluxo completo funciona e tem testes: Admin
  → página do evento → pedido → pagamento simulado → ingressos com QR →
  check-in.
- **Nada está em produção.** Nada foi testado com o San Checkout real,
  com e-mail real, com o Storage real ou em celular real.

**Realmente funcional (código + teste automatizado + navegador local):**
- as cinco abas do Admin;
- a página pública;
- cotação e pedido com reserva;
- emissão de um ingresso por vaga, cada um com o próprio QR assinado;
- check-in por código e por câmera (câmera testada com vídeo simulado);
- operadores com login pela tela da Mostraí;
- cortesias;
- números da edição (D1);
- pedido do titular (LGPD).

**Parcial:**
- **pagamento real:** o contrato do Checkout está implementado, mas só foi
  testado com dublê;
- **e-mail:** existe a fila; o envio real nunca foi exercitado;
- **imagens em produção:** o adaptador do Supabase existe e nunca foi
  exercitado;
- **reembolso:** existe, mas sem o modo "cancelamento do evento" que o
  dono definiu;
- **regras recém-decididas pelo dono:** ainda não aplicadas (ver Parte 5).

**Não iniciado:**
- devolução pedida pelo próprio comprador (arrependimento);
- nota fiscal;
- check-in sem internet;
- link de indicação (só o espaço reservado);
- reembolso em lote quando o evento é cancelado.

**Bloqueios:**
- autorização do dono para o merge e o deploy;
- cadastro da Trimundi como contratante no San Checkout;
- configuração do ambiente de produção;
- decisão sobre o banco: as decisões novas contradizem "banco próprio",
  que ainda está escrito no `CLAUDE.md`, no `CONSTRAINTS.md` e no código
  commitado;
- revisão jurídica dos textos.

## Parte 2 — Matriz de funcionalidades

Estados:
- **Concluída**: backend, tela e teste;
- **Parcial**;
- **Só backend**;
- **Só documentada**;
- **Não iniciada**;
- **Bloqueada**: depende de algo externo.

Os testes citados estão em `tests/trimundi-*.test.js`.

### A. Admin — Criar evento

| Funcionalidade | Estado | Evidência | Pendência |
|---|---|---|---|
| Evento e edição, endereço (slug) validado, reservado e único | Concluída | `eventos.js#criarEdicao`, `validacao.js`; teste admin "evento e edição…" | — |
| Descrição, data/hora ("A definir"), local, classificação, capacidade | Concluída | ficha em `admin/trimundi.js#renderFicha`; `lerEdicao` | — |
| Regras, condições e termos versionados (versão nunca muda) | Concluída | `gravarTexto`; trigger `trimundi_termo_imutavel`; teste "textos versionados" | revisão jurídica do conteúdo |
| Status, publicação (exige textos → 422), endereço trava | Concluída | `mudarStatus`, `faltaParaPublicar`; teste "publicar exige…" | — |
| Banner e galeria (bytes conferidos, ≤ 8, banner único) | Concluída no armazenamento local / em memória | `adicionarImagem`; teste "imagens…" | Storage real (Supabase) nunca exercitado |

### B. Admin — Ingressos

| Funcionalidade | Estado | Evidência | Pendência |
|---|---|---|---|
| Tipos, até 10 lotes, preço R$ 5 a 50.000, quantidade, períodos | Concluída | `catalogo.js`; teste "tipos e lotes…" | — |
| Limite por comprador (CPF) | Concluída | `pedidos.js` + `compradosPorCpf`; teste venda "limite…" | — |
| Benefícios (catálogo da edição) | Concluída | `criarBeneficio`, cópia no ingresso | — |
| Ativar e inativar | Concluída | `atualizarTipo`; teste admin | — |
| Estoque com virada de lote | Concluída **com a regra antiga** | `disponibilidade.js` (commit): a sobra do lote encerrado passa ao seguinte | o dono decidiu que a sobra **não** passa; ainda não implementado (o rascunho não commitado está incompleto) |

### C. Admin — Promoções

| Funcionalidade | Estado | Evidência | Pendência |
|---|---|---|---|
| Combos com itens (2–20 ingressos), preço, quantidade, validade, benefício promocional | Concluída | `promocoes.js`; teste admin "promoção…" | — |
| Consome o estoque real dos tipos e a capacidade | Concluída | `pedidos.js#montar`; teste venda "combo consome…" | — |
| Um ingresso individual por posição | Concluída | `emissao.js#emitirDoPedido`; teste pagamento "combo: cada posição…" | — |

### D. Admin — Participantes

| Funcionalidade | Estado | Evidência | Pendência |
|---|---|---|---|
| Lista, busca (nome, CPF, e-mail, pedido), filtros, 50 por página | Concluída | `participantes.js#listar`; teste "CPF mascarado…" | — |
| Status de pagamento e do ingresso, benefícios, entrada | Concluída | mesma lista; teste check-in "utilizados" | — |
| Cortesia: emitir (idempotente) e cancelar | Concluída | `emissao.js`; teste admin "cortesia…" | — |
| Histórico do ingresso e auditoria do Admin (imutáveis) | Concluída | `ingresso_historico`, `auditoria` + triggers; teste "auditoria…" | sem tela de consulta do histórico |
| Números da edição (D1), sem teste e sem cortesia na receita | Concluída | `participantes.js#resumo`; teste "resumo (D1)" | — |
| Avisos (sem vaga, divergência, duplicidade, reembolso) e "resolvido" | Concluída | `avisos`, `resolverAviso`; teste admin | — |
| Pedido: ficha, link novo, reembolso por pedido ou por ingresso | Parcial | `reembolsos.js`; teste pagamento | falta o modo "evento cancelado" (só o valor do ingresso, sem taxas) e o reembolso em lote |
| Pedido de teste | Concluída (só fora de produção) | `pedidos.js#criarTeste` | o dono disse que não precisa: remover ou manter só no desenvolvimento |
| Pedido do titular (exportar e anonimizar por CPF) | Concluída | `titular.js`; teste admin "pedido do titular" | — |

### E. Admin — Operadores

| Funcionalidade | Estado | Evidência | Pendência |
|---|---|---|---|
| Cadastro com código XXXX-XXXX, mostrado uma vez, válido por 72 h | Concluída | `operadores.js#criar`; teste admin | — |
| Ativação (5 erros travam, vencido → 410) | Concluída | `ativar`; teste check-in "ativação…" | — |
| Login pela tela da Mostraí → `/ticket/checkin` | Concluída | `acesso.js`, `anunciantes/routes.js`, `login.page.js`; teste "login pela tela da Mostraí…" | — |
| Permissão por edição; sessão não abre conta nem Admin | Concluída | `edicoesPermitidas`, `daSessao`; testes | — |
| Revogação imediata (desativar, código novo) | Concluída | `sessao_versao`; testes "desativar…", "código novo…" | — |
| Conflito com conta da Mostraí (a conta vence) | Concluída | `contaDaMostrai`; testes | — |

### Página pública, pedido, pagamento, emissão, check-in

| Módulo | Funcionalidade | Estado | Evidência | Pendência |
|---|---|---|---|---|
| Página pública | `/ticket/:evento/:edicao` ligada ao banco; rascunho dá 404; tipos, lotes, combos, situação; título para compartilhamento | Concluída | `publico.js`, `paginas/edicao.html`, `edicao.page.js`; teste "vitrine…"; navegador (computador e celular, claro e escuro) | o `max_quantidade` revela o estoque quando sobra menos de 20 (risco baixo) |
| Página pública | Comprar: escolher, dados de cada participante, aceite dos termos, ir ao pagamento | Concluída com pagamento **simulado**; real **bloqueado** | `edicao.page.js`; fluxo no navegador | contratante no Checkout |
| Pedido | Validação de CPF e e-mail, idempotência, reserva de 30 min, expiração, corrida pela última vaga | Concluída | `pedidos.js`; testes venda (5 pedidos ao mesmo tempo → 1 passa) | — |
| Checkout | Leitura do pedido pelo Checkout (`GET /pedido`), webhook HMAC fechado na falha, dedupe por `eventoId`, recusado, tardio, chargeback, duplicidade, conciliação | **Só backend com dublê**; real bloqueado | `checkout/*`, `pagamentos.js`; 19 testes de pagamento | **nunca falou com o San Checkout de verdade** |
| Checkout | Estorno total e parcial com a nossa chave de idempotência | Só backend com dublê | `reembolsos.js` | modo "evento cancelado"; teste contra o Checkout de teste |
| Emissão | Um ingresso por vaga, código de 128 bits, QR Ed25519 próprio por ingresso, sem dado pessoal, sem duplicar | Concluída | `emissao.js`, `lib/qr.js`; testes "QR…", "o mesmo aviso cinco vezes…" | **nenhum fluxo compartilha QR entre ingressos** |
| Entrega | Página do pedido com token (só o hash no banco), QR depois de pago, "Baixar QR", recuperar o link | Concluída | `pedidos.js#paraComprador`; teste "página do pedido…" | — |
| Entrega | E-mail do link dos ingressos | Parcial | `email.js` (fila); captura em arquivo testada só no navegador local | envio real nunca exercitado; o dono decidiu usar o e-mail da Mostraí (não aplicado) |
| Check-in | `/ticket/checkin` mobile; câmera (BarcodeDetector ou jsQR) e código digitado; validação no servidor; entrada única com trava; operador registrado; contador | Concluída | `checkin.js`, `checkin.page.js`; 10 testes; câmera com vídeo simulado no Chromium | **celular real não testado** |
| Check-in | Link de indicação | Só o espaço reservado | `rotas/operador.js` (`indicacao: null`), `<aside id="indicacao">` | mecanismo não definido |
| Check-in | Funcionar sem internet | Não iniciada | — | — |
| LGPD | Retenção | Só backend (comando manual) | `retencao.js` | o dono decidiu guardar os dados: os prazos provisórios perdem efeito (docs não atualizados) |
| Comprador | Devolução pedida pelo próprio comprador (7 dias) | Não iniciada | — | hoje só o Admin reembolsa |
| Fiscal | Nota fiscal | Não iniciada | — | decisão pendente |

## Parte 3 — Estrutura técnica (commit `8cb4dc6`)

- **Arquitetura:**
  - módulo dentro da aplicação Express da Mostraí, montado em
    `src/server.js` (`app.use(require('./trimundi').router)`);
  - desligado sem `TRIMUNDI_DATABASE_URL`: `/ticket/*` e o Admin da
    Trimundi respondem 503;
  - SQL direto (pg) e páginas sem build.
- **Diretórios:**
  - `src/trimundi/`: serviços por assunto, `rotas/` (admin, operador,
    público), `checkout/`, `lib/`, `db/`, `paginas/`;
  - `public/ticket/`: scripts e estilo das páginas públicas;
  - `public/admin/trimundi.{js,css}`: as telas do Admin;
  - `tests/trimundi-*`.
- **Rotas:**
  - 39 no Admin (`/admin/trimundi/*`), atrás da sessão do Admin e do
    Cloudflare Access;
  - 12 públicas;
  - 9 do operador;
  - na Mostraí, muda só `POST /anunciantes/login`.
- **Banco:**
  - 31 tabelas, todas com RLS: 29 na migration `001`, 1 na `002` e a `schema_migrations` (criada pelo migrador);
  - restrições: chaves estrangeiras, faixas de valor, índice parcial
    único de entrada aceita, código curto único por edição, `reserva_id`
    único no ingresso;
  - tabelas imutáveis por trigger: termos, aceites, auditoria, métricas,
    check-in, histórico do ingresso.
- **Separação dos bancos, no commit:**
  - banco próprio `TRIMUNDI_DATABASE_URL`, com trava que recusa o banco
    da Mostraí;
  - localmente, `trimundi_dev` e `mostrai_trimundi_teste` são bancos
    separados, e o banco `mostrai` não tem tabela nem esquema da
    Trimundi (consultado: `to_regclass('public.ingressos')` nulo, 0
    esquemas `trimundi`).
  - **Isso contradiz a última decisão do dono** ("usar a estrutura da
    Mostraí").
- **Integrações:**
  - San Checkout (contrato v2, dublê nos testes, simulador em
    desenvolvimento);
  - Supabase Storage (adaptador sem teste real);
  - SMTP (nodemailer, sem teste real).
- **Dependências:** `jsqr` passou a dependência de produção (servido em
  `/ticket/jsqr.js`); `qrcode`, `pg` e `multer` já existiam.
- **Variáveis de ambiente:**
  - `TRIMUNDI_DATABASE_URL` e `TRIMUNDI_SEGREDO` (obrigatório em
    produção);
  - `TRIMUNDI_CHECKOUT_*` (4);
  - `TRIMUNDI_SUPABASE_*`;
  - `TRIMUNDI_EMAIL_FROM` e `TRIMUNDI_SMTP_*`;
  - `TRIMUNDI_PAGAMENTO_SIMULADO`, `TRIMUNDI_ARMAZENAMENTO` e
    `TRIMUNDI_EMAIL_CAPTURA` (só desenvolvimento).
- **Testes executados agora** (cópia limpa do `8cb4dc6`, `npm run check`
  completo):
  - **1171 de 1171 passam, 0 falhas**: 1095 da Mostraí (regressão) e 76
    da Trimundi;
  - sintaxe, lint e formato: OK (14 avisos de lint, todos em arquivos da
    Mostraí que já existiam);
  - testes da Trimundi por arquivo: fundação 16, módulo desligado 4,
    Admin 16, venda 11, pagamento 19, check-in 10.
- **Testes que ainda não existem:**
  - contra o Checkout de teste real;
  - envio real de e-mail;
  - upload real no Storage;
  - navegador automatizado no CI (o fluxo de navegador foi feito à mão,
    fora do repositório);
  - celular real;
  - carga (pedidos por segundo com a trava por edição);
  - acessibilidade.

## Parte 4 — Segurança

Nenhuma falha crítica foi encontrada no código lido. **Isso não é
atestado de segurança:** não houve teste de intrusão nem revisão
independente, e o código nunca rodou contra os serviços reais.

| Criticidade | Item | Evidência | Ação |
|---|---|---|---|
| **Alta** | **Estoque sequestrável:** qualquer um cria pedidos válidos em série, cada um com até 20 ingressos, e segura todo o estoque por 30 min. O limitador conta só erro; não há teto de reservas vivas por IP, CPF ou e-mail, e o limite por comprador é opcional | `pedidos.js#criar`; `limite-tentativas.js` (teto de 10 **erros**) | teto de reservas vivas por IP e por CPF; prova humana (captcha) se precisar |
| **Alta** | Decisões novas do dono não aplicadas e documentos contraditórios: o `CLAUDE.md`, o `CONSTRAINTS.md` e o código dizem "banco próprio"; a decisão nova diz "estrutura da Mostraí". Há alterações pela metade no diretório de trabalho | `git status`; `config.js` (commit) | decidir o desenho e concluir ou descartar o rascunho antes de qualquer deploy |
| Média | O token do pedido viaja na URL (`?t=`), inclusive no `returnUrl` entregue ao Checkout. A página usa `no-referrer` e a API recebe o token por cabeçalho, mas a URL pode ficar em histórico e em logs de terceiros | `pedidos.js#linkDePagamento` | aceitável no desenho atual; avaliar link curto que expira |
| Média | A tabela `emails` guarda o corpo com o link do pedido em texto: quem lê o banco abre o pedido | `pagamentos.js#avisarComprador` | limpar o corpo depois do envio (o comando de retenção faz isso, mas só à mão) |
| Média | CPF guardado em claro (compradores e participantes) | migration 001 | o disco do Supabase é cifrado; avaliar cifra por coluna se a revisão jurídica pedir |
| Média | Nada testado contra os serviços reais (Checkout, SMTP, Storage) | — | homologação |
| Baixa | A vitrine revela o estoque quando sobra menos de 20 (`max_quantidade`) | `publico.js` | limitar ao teto do pedido, ou aceitar |
| Baixa | O tempo de resposta do login revela se um e-mail é de operador (mesmo padrão que a Mostraí já tem para conta) | `operadores.js#autenticar` | aceitar ou igualar o tempo |
| Baixa | O teto de leituras do check-in (120/min) fica em memória, por instância | `rotas/operador.js#ritmo` | aceitável |

**Verificado e adequado no código:**
- **Autorização:** guarda do Admin em duas camadas; sessão do operador
  conferida no banco a cada requisição.
- **Entrada de dados:**
  - SQL sempre parametrizado (nome de coluna só de lista fixa);
  - validação com teto de tamanho;
  - upload conferido pelos bytes (sem SVG);
  - HTML escapado no Admin e `textContent` nas páginas públicas;
  - CSP sem script inline;
  - `/ticket/dev/*` inexistente em produção;
  - redirecionamento do login restrito a `/ticket/...`.
- **Webhook e pagamento:** HMAC com janela de 300 s, comparação em tempo
  constante, fechado na falha; idempotência no pedido, na cortesia, no
  aviso de pagamento e no estorno.
- **QR:** sem dado pessoal; assinatura por edição; adulteração detectada
  (teste).
- **Registro e privacidade:**
  - log sem CPF;
  - auditoria sem dado pessoal;
  - a portaria vê o nome, não o CPF;
  - CPF mascarado na lista do Admin.

## Parte 5 — Pendências (por prioridade e dependência)

1. **Decidir e aplicar a estrutura de banco** (estrutura da Mostraí ×
   banco próprio). Depois, concluir **ou** descartar as alterações não
   commitadas e atualizar `CLAUDE.md`, `CONSTRAINTS.md`, ADR-048 e
   `docs/trimundi`. Bloqueia todo o resto do deploy.
2. **Aplicar as decisões do dono:**
   - lote sem sobra para o seguinte;
   - reembolso no cancelamento do evento: só o valor dos ingressos, sem
     as taxas do SANCO Pay;
   - reembolso normal: o valor total;
   - e-mail e Storage da Mostraí;
   - dados guardados (sem prazo de anonimização);
   - pedido de teste dispensado.

   Cada uma precisa de testes e documentação.
3. **Teto de reservas vivas por IP e por CPF** (o risco alto da Parte 4).
4. **Reembolso em lote** quando a edição é cancelada.
5. **Produção** (dono):
   - autorizar o merge;
   - `TRIMUNDI_SEGREDO` e as variáveis no Northflank;
   - migration autorizada;
   - cadastro do contratante no San Checkout.
6. **Homologação:**
   - os 6 passos do API.md §11 contra o Checkout de teste;
   - e-mail real;
   - upload real;
   - check-in em iPhone e Android.
7. **Decisões jurídicas e comerciais:**
   - devolução pelo próprio comprador (arrependimento);
   - nota fiscal;
   - revisão dos textos.
8. **Depois:** link de indicação, check-in sem internet, teste de carga,
   navegador automatizado no CI.

## Parte 6 — Próximas etapas recomendadas (a partir do estado real)

1. **Fechar a estrutura:** o dono confirma esquema `trimundi` dentro do
   banco da Mostraí. Termino o rascunho (conexão, migration, regra de
   lote, `aindaCabe`, marca de esgotado na confirmação), atualizo os
   testes e os documentos, e rodo a bateria.
2. **Aplicar as regras de reembolso** (cancelamento × normal, com
   reembolso em lote) e o teto de reservas, com testes.
3. **Revisão de código e de segurança** do PR inteiro.
4. **Deploy autorizado** com o módulo ligado: variáveis, migration e
   cadastro no Checkout. Depois, homologação real: a primeira compra do
   dono, reembolso, e-mail e check-in em celular.
5. O dono cria a TREEMUNDO pelo Admin e abre as vendas.

## Parte 7 — Critério de prontidão

**1. Funcional em desenvolvimento — atingido no commit `8cb4dc6`.**
- Ressalva: com as regras antigas (banco próprio, sobra de lote).
- O diretório de trabalho atual **não** está nesse estado: as
  alterações não commitadas estão incompletas.
- Para voltar a ele: concluir ou descartar o rascunho (Parte 5, item 1).

**2. Pronto para homologação — falta:**
- decisões aplicadas e testadas (Parte 5, itens 1 e 2);
- teto de reservas;
- revisão de código e de segurança;
- deploy autorizado com o módulo ligado;
- contratante de teste no San Checkout;
- e-mail e Storage configurados.

**3. Pronto para produção — falta, além do nível 2:**
- os 6 passos do API.md §11 aprovados contra o Checkout;
- compra, reembolso e check-in reais em celular feitos pelo dono;
- revisão jurídica (termos, privacidade, arrependimento, nota fiscal);
- backup confirmado cobrindo os dados da Trimundi;
- contratante de produção no Checkout;
- aprovação do dono.
