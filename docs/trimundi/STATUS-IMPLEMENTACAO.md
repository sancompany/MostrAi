# Trimundi — status da implementação

Atualizado em 09/11/2026, branch `claude/beautiful-faraday-cjq1nt`
([PR #137](https://github.com/sancompany/MostrAi/pull/137), em rascunho).
Nada disto está em produção: merge na `main` publica, e só o dono autoriza.

Legenda: **feito** = funciona no servidor, tem tela quando a etapa pede, e
tem teste automatizado · **parcial** = feito com limite declarado ·
**depende de fora** = estrutura, contrato e teste com dublê prontos; falta
credencial ou serviço que só o dono provê.

## Escopo simplificado (pedido do dono, 09/11/2026)

Feito na branch, em commits locais (nada enviado ao GitHub, nada em
produção). Cada item tem teste automatizado; `npm run check` (Mostraí +
Trimundi) passa. Migrations conferidas num banco limpo; restauração só da
Trimundi ensaiada; fluxo completo conferido no navegador com o pagamento
SIMULADO. **Nenhum serviço externo real foi testado** (Checkout, e-mail,
Storage, celular): isso é a homologação de `pendencias.md`.

| Parte | Estado | Onde | Teste |
|---|---|---|---|
| Esquema `trimundi` no banco da Mostraí, conexão que falha fechado, migrador que confere o esquema, pooler de transação recusado | feito | `db/conexao.js`, `db/migrate.js`, `config.js` | `trimundi-fundacao` |
| Lote sem sobra (o que não vendeu não passa adiante; pagamento atrasado confere o próprio lote; marca "esgotado" só por pagos) | feito | `disponibilidade.js`, `pagamentos.js` | `trimundi-fundacao`, `-venda`, `-pagamento` |
| Identidade Trimundi (logo, cores, nenhum elemento ou link da Mostraí; e-mail com a logo no corpo) | feito | `public/ticket/`, `paginas/`, `email.js` | `trimundi-identidade` |
| Conta do cliente (nome, CPF, e-mail, senha; e-mail confirmado; compra exige conta; minha conta com ingressos e QR) | feito | `clientes.js`, `rotas/conta.js`, `conta.page.js` | `trimundi-conta` |
| Benefício por lote com quantidade; entrega única na portaria | feito | `emissao.js`, `catalogo.js`, `checkin.js` | `trimundi-beneficios` |
| Indicação (link, conversão paga, recompensa por campanha, entrega no Admin) | feito | `indicacao.js`, aba Indicação | `trimundi-indicacao` |
| Login próprio do operador (`/ticket/entrar`); login da Mostraí restaurado | feito | `rotas/operador.js` | `trimundi-checkin` |
| Um pedido aguardando pagamento por conta e edição (sem reter estoque) | feito | `pedidos.js` | `trimundi-conta` |
| Página de erro e 404 próprias em `/ticket` | feito | `index.js`, `paginas/erro.html` | `trimundi-identidade` |
| Nome público TICK, home `/tic/eventos` com busca, "Eventos" no menu público da Mostraí, cookie próprio da conta TICK | feito | `vitrine.js`, `paginas/eventos.html`, `eventos.page.js`, `src/lib/sessao.js`, `public/layout.js` | `trimundi-tick` |
| Uma conta por CPF e por e-mail (mensagens próprias, confirmação de senha, corrida barrada no banco); limite de ingressos por CPF **na edição** (`edicoes.limite_por_cpf`, migration 007); pedido aberto por CPF e edição; aviso "Benefício disponível enquanto durar o estoque." | feito | `clientes.js`, `pedidos.js`, `disponibilidade.js`, `eventos.js`, `publico.js`, ficha do Admin | `trimundi-cadastro-limite` |
| Ficha do evento reorganizada no Admin: Identidade visual (banner e **logo**, migration 008, com pré-visualização antes de salvar), Informações principais, Data e classificação, Localização, Regulamento e condições; endereço público gerado do nome, sem colisão, editável só nas configurações avançadas; logo na página de venda e no card da vitrine | feito | `eventos.js`, `publico.js`, `vitrine.js`, `admin/trimundi.js`, `admin/trimundi.css`, páginas públicas | `trimundi-ficha-evento` |
| Indicação de compradores e operadores: link permanente para todos (operador nas edições autorizadas), origem fixa no servidor (`indicacao_origens`, migration 009), aviso "Você chegou por indicação de…", ficha do comprador em Participantes (CPF mascarado, inteiro auditado), lista e ficha de operadores com desempenho, ranking por edição com CSV | feito | `indicacao.js`, `desempenho.js`, `pedidos.js`, `rotas/admin.js`, `rotas/publico.js`, `admin/trimundi.js`, páginas públicas | `trimundi-indicacao-desempenho`, `trimundi-indicacao` |
| Check-in sem internet: pacote da edição (hashes, situação, tipo, primeiro nome, chave Ed25519), validação no aparelho, entradas locais com id único, sincronização idempotente, conflitos no Admin (migration 010), PWA instalável do check-in | feito | `checkin-offline.js` (servidor e página), `checkin-sw.js`, `checkin.webmanifest`, `rotas/operador.js`, `admin/trimundi.js` | `trimundi-checkin-offline`; navegador emulado (Android/iPhone no Chromium); **aparelho real: pendente** |
| Termos de Uso e Política de Privacidade (v1.0) com aceite obrigatório, conta só para maiores, declaração de idade no pedido, lembrete na portaria | feito | `legal.js`, `paginas/termos.html`, `paginas/privacidade.html`, `clientes.js`, `pedidos.js` | `trimundi-legal` |
| Telas públicas e documentos legais (10/11/2026): botão "Minha conta", entrar e criar conta redesenhados, olho na senha (entrar, criar conta, redefinir), Termos e Política **v1.2** com o texto oficial sem mudança, aceite com a versão apresentada e histórico imutável (`aceites_conta`, migration 011, aceites antigos preservados como `anterior`), Minha conta por evento e pedido, "Indique e acompanhe" com link permanente e acessos únicos (`indicacao_visitas`) | feito | `legal.js`, `paginas/termos.html`, `paginas/privacidade.html`, `clientes.js`, `indicacao.js`, `desempenho.js`, `rotas/conta.js`, `rotas/publico.js`, `conta.page.js`, `comum.js`, `ticket.css` | `trimundi-conta-legal`, `trimundi-legal`, `trimundi-conta` |
| E-mail real, Storage real, Checkout real, celular real | **depende de fora** | — | dublês nos testes |

## Decisões aplicadas nesta execução

- **D1 (aprovada):** o resumo da edição traz ingressos pagos, cortesias,
  participantes, entradas, receita confirmada, reembolsado, receita
  líquida, cancelados, reembolsos e chargebacks. Pedido de teste fica fora
  de tudo; cortesia nunca é receita (`participantes.js#resumo`).
- **D2 (aprovada com ressalva):** a estrutura de retenção existe com prazos
  **provisórios** e nada roda sozinho (`retencao.js`, só por comando com
  `--confirmar`). Operador desativado perde o acesso na hora.
- **Combo (regra nova do dono):** consome o estoque real dos tipos que o
  compõem e a capacidade; os benefícios do combo somam aos do tipo sem
  repetir; cada posição é um ingresso individual (participante, código, QR,
  benefício e check-in próprios).
- **Reserva de 30 min** = `expiraEm` mandado ao Checkout (o Blueprint dizia
  24 h; estoque estrito pediu o prazo curto). Pagamento que chega depois só
  emite se ainda couber; senão, "pago sem vaga" e aviso de devolução.
- **Cartão recusado não derruba o pedido:** a reserva continua até vencer e
  o comprador pode tentar outro meio (API.md do Checkout, §4.3.3).

## Etapas

| Etapa | Situação | Onde |
|---|---|---|
| 1 — Fundação | **feito** | `src/trimundi/{config,db,lib}`, migrations `001_fundacao.sql` e `002_avisos_e_titular.sql` (31 tabelas, RLS em todas), trava contra o banco da Mostraí |
| 2 — Admin "Eventos" (5 abas) | **feito** | `public/admin/trimundi.{js,css}`, rotas `src/trimundi/rotas/admin.js` |
| 3 — Página pública `/ticket/:evento/:edição` | **feito** | `src/trimundi/paginas/edicao.html`, `public/ticket/edicao.page.js` |
| 4 — Pedido e checkout | **feito**, Checkout real **depende de fora** | `pedidos.js`, `pagamentos.js`, `checkout/*` |
| 5 — Emissão, entrega, e-mail, recuperação | **feito**, e-mail real **depende de fora** | `emissao.js`, `email.js`, `/ticket/pedido`, `/ticket/recuperar` |
| 6 — Check-in | **feito** | `checkin.js`, `/ticket/checkin` (câmera + código), link de indicação: espaço reservado |
| 7 — Homologação | **parcial**: testes, regressão e E2E local feitos; homologação com dado real é do dono | este arquivo, `pendencias.md` |

## Funcionalidades e testes

Testes: `tests/trimundi-*.test.js` — 6 arquivos, 76 casos, banco de teste
próprio (`<banco>_trimundi_teste`, criado pelo próprio teste).

| Área | O que funciona | Teste |
|---|---|---|
| Fundação | banco próprio; migrations idempotentes com trava; RLS em toda tabela; histórico imutável (auditoria, métricas, termos, aceites, check-in, histórico do ingresso); trava contra o banco da Mostraí; produção sem segredo próprio não liga | `trimundi-fundacao` |
| Módulo desligado | sem `TRIMUNDI_DATABASE_URL`: `/ticket/*` e Admin da Trimundi 503; login da Mostraí intacto | `trimundi-desligada` |
| QR e códigos | `TM1.<edição>.<código>.<Ed25519>`, sem dado pessoal; qualquer alteração invalida; código curto `XXXX-XXXX` sem 0/O/1/I | `trimundi-fundacao` |
| Estoque | lote vigente, virada automática, encerrado não reabre, sobra rola para o próximo, vaga devolvida no último lote volta para ele, pagamento tardio não vende acima | `trimundi-fundacao`, `trimundi-venda` |
| Admin | evento/edição, endereço reservado e único, publicar exige textos (422), endereço trava, termos versionados, capacidade ≥ ocupação, imagens (bytes conferidos, banner único, galeria ≤ 8), tipos e lotes, promoções, cortesias idempotentes, participantes, QR PNG/SVG, link novo do pedido, operadores, auditoria sem dado pessoal | `trimundi-admin` |
| Venda | vitrine sem número de estoque; cotação com preço por lote; pedido com reserva de 30 min, aceites com hash, token só como hash; idempotência; limite por CPF; capacidade; última vaga disputada (1 de 5 passa); combo consome o tipo | `trimundi-venda` |
| Pagamento | webhook HMAC fechado na falha (sem assinatura, chave errada, hora velha, corpo alterado → 401); dedupe por `eventoId` (5 iguais ao mesmo tempo → 1 emissão); valor divergente; pagamento duplicado; recusado; tardio; chargeback; baixa desfeita e refeita | `trimundi-pagamento` |
| Reembolso | total e por ingresso com a nossa chave de idempotência; 200 do Checkout já confirma; aviso depois não duplica; rede/502/409 em reconciliação → reenvio com a mesma chave; 409 definitivo → falha e ingresso volta a valer; estorno negado | `trimundi-pagamento` |
| Contrato com o Checkout | `GET /ticket/api/checkout/pedido/:id` com `X-Checkout-Key`, campos do API.md §4.1, `expiraEm` = fim da reserva; conciliação §5.2 pela mesma fila | `trimundi-pagamento` |
| Entrega | página do pedido só com o token; QR só depois de pago; sem CPF na página; e-mail de confirmação enfileirado (nunca "enviado" sem provedor) | `trimundi-venda`, `trimundi-pagamento` |
| Operador | e-mail da Mostraí não vira operador; ativação (mesma resposta para erro e desconhecido, 5 erros travam, vencido 410); login pela tela da Mostraí → `/ticket/checkin`; sessão não abre conta nem Admin; desativar e código novo derrubam a sessão na hora; conta da Mostraí criada depois vence | `trimundi-checkin` |
| Check-in | QR e código digitado; válido → entrada; segunda leitura "já utilizado" com hora e operador; 6 leituras simultâneas → 1 entrada; forjado, outra edição, cancelado, bloqueado; permissão por edição (403) | `trimundi-checkin` |
| Retenção (D2) | ensaio não muda nada; com confirmação anonimiza só o vencido (participantes, compradores, operadores e o corpo dos e-mails enviados) e guarda o financeiro | `trimundi-fundacao` |
| Pedido do titular (LGPD) | Admin consulta por CPF, baixa os dados em JSON e anonimiza o que não tem guarda legal; comprador com pagamento fica pelo prazo; auditoria sem o CPF | `trimundi-admin` |
| Avisos | "Marcar como resolvido" com o que foi feito; um fato novo do mesmo tipo volta a aparecer | `trimundi-admin` |
| Conciliação | roda sozinha a cada 6 h no processo, só com o Checkout configurado (e por `npm run trimundi:conciliar`) | `trimundi-pagamento` |

Fluxo de ponta a ponta no navegador (Playwright, servidor local, banco
`trimundi_dev`), sem erro de página:
1. o Admin cria o evento, envia o banner, cria benefício, Pista (2 lotes),
   VIP e o combo "Casal", e publica;
2. no celular, a compra de 2 Pista + 1 Casal gera 4 vagas e R$ 190,00;
3. o pagamento simulado aprova e a página do pedido mostra 4 ingressos com QR;
4. o operador ativa o acesso, entra pela tela da Mostraí e cai no check-in;
5. no check-in: código digitado (válido → registrado → já utilizado) e
   câmera lendo o QR com jsQR (vídeo falso no Chromium);
6. o Admin desativa o operador e a leitura seguinte manda para o login;
7. o resumo da edição mostra 4 pagos, 2 entradas e R$ 190,00.

## Eventos e marca

Para o público a marca é **Mostraí** (os eventos são dela); Trimundi é o
nome interno do módulo.


Os eventos são da Mostraí e são criados por quem administra, pelo Admin
(Eventos → Criar evento): nome, endereço, data, local, textos, banner,
imagens, ingressos, lotes e combos. Nenhum evento vem pronto no código.
TREEMUNDO / EDITION01 é o primeiro evento a ser criado assim.

## Parcial

- **Pedido "pago sem vaga"** tem botão de reembolso; a devolução é pedida
  pelo Admin, não automática.
- **Câmera:** testada no Chromium com vídeo falso (jsQR). Em iPhone real
  (Safari, sem BarcodeDetector, usa jsQR) e Android real ainda não foi
  testada — homologação do dono.
- **Edição com imagem no armazenamento local** só em desenvolvimento; em
  produção, o Storage próprio (depende de fora).

## Depende de credencial ou serviço externo

| O quê | O que já existe | O que falta (só o dono) |
|---|---|---|
| San Checkout real | contrato v2 implementado (GET /pedido, webhook HMAC, estorno, conciliação), com dublês | cadastrar a Trimundi como contratante próprio no Checkout (chave, URL base, webhook) e pôr `TRIMUNDI_CHECKOUT_*` no ambiente |
| Banco de produção da Trimundi | migration, trava, `npm run trimundi:migrate` (pede `--producao-autorizada`) | criar o banco/projeto próprio (custo a apresentar antes) e autorizar a migration |
| Storage das imagens | adaptador Supabase e CSP lida do ambiente | projeto Supabase próprio e bucket |
| E-mail | fila desacoplada; sem provedor fica "aguardando provedor" | alias/SMTP próprio da Trimundi |
| Segredo-mestre | derivação HKDF por uso | gerar `TRIMUNDI_SEGREDO` (32+) no ambiente de produção |

## Alterações no banco local

- Banco `trimundi_dev` (desenvolvimento) criado e migrado com
  `001_fundacao.sql` e `002_avisos_e_titular.sql`; contém só dado fictício do E2E.
- Banco `mostrai_trimundi_teste` criado pelos testes.
- **O banco da Mostraí não recebeu nenhuma tabela da Trimundi** (há teste
  que confere).

## Alterações na Mostraí (compatíveis)

- `POST /anunciantes/login`: e-mail que **não** é conta da Mostraí pode ser
  de operador. Conta da Mostraí segue exatamente igual; com a Trimundi
  desligada ou fora do ar, a resposta é o 401 de sempre.
- `public/anunciante/login.page.js`: segue o `destino` do operador (só
  caminho `/ticket/...`).
- `src/server.js`: monta o router da Trimundi, inicia os processos dela
  (só se configurada) e lê a origem do Storage dela para a CSP.
- `public/admin/index.page.js` e `index.html`: o item "Eventos".
- `package.json`: `jsqr` passa de devDependency a dependency (servido em
  `/ticket/jsqr.js`); scripts `trimundi:*`.
- Toda a bateria segue verde: 1171 testes (1095 da Mostraí, sem nenhum alterado, + 76 da Trimundi), lint e formato.

## Como rodar localmente

Veja `RUNBOOK.md` §11. Em resumo, no `.env`:
`TRIMUNDI_DATABASE_URL` (banco local próprio), `TRIMUNDI_PAGAMENTO_SIMULADO=1`,
`TRIMUNDI_ARMAZENAMENTO=local`, `TRIMUNDI_EMAIL_FROM` e
`TRIMUNDI_EMAIL_CAPTURA`. Depois:

```bash
npm run trimundi:migrate
```

```bash
npm run dev
```

Admin em `/admin/` → Eventos; vitrine em `/ticket/<evento>/<edição>`.

## Como testar

```bash
npm test
```

```bash
node --test tests/trimundi-*.test.js
```

## Riscos

1. **Chave do QR = `TRIMUNDI_SEGREDO`.** Trocar invalida todos os QR
   emitidos; vazar permite forjar. Guardar como segredo de produção.
2. **Reserva curta (30 min) × Pix lento:** pagamento depois do prazo vira
   "pago sem vaga" se esgotou, com devolução manual pelo Admin.
3. **Taxas no reembolso total:** o Checkout devolve o valor cobrado inteiro
   (com as taxas); o reembolso por ingresso devolve só o preço dele.
4. **Câmera em aparelho real** ainda não homologada.
5. **Mesma aplicação da Mostraí:** um erro grave na Trimundi pode derrubar o
   processo comum. Mitigado: módulo isolado por prefixo, banco próprio,
   desligável por variável, e login da Mostraí que ignora a Trimundi fora
   do ar.

## Decisões do dono

Estão em `pendencias.md`, seção "Decisões do dono desta execução".
