# Pendências — Trimundi

O que falta, e o que só o dono faz. Fechar é marcar `[x]` com a evidência;
reabrir é desmarcar com o motivo. Estado de cada funcionalidade:
`STATUS-IMPLEMENTACAO.md`. Atualizado em 09/11/2026 (finalização da etapa).

## Decisões do dono — fechadas em 09/11/2026

- [x] Infraestrutura, banco (esquema `trimundi`), Storage e e-mail da
  Mostraí (ADR-049).
- [x] Identidade própria da Trimundi; nenhum elemento da Mostraí ao público.
- [x] Reserva que vence devolve a vaga ao próprio lote; o que não vendeu
  num lote encerrado não passa ao seguinte.
- [x] Pedido de teste só fora de produção (desenvolvimento e homologação
  local). A homologação real é a primeira compra do dono.
- [x] Disponibilidade: "Disponível" ou "Últimas N" (a partir de 20).
- [x] Conta do cliente com e-mail confirmado; operadores só pelo Admin.
- [x] Dados ficam guardados normalmente; nada é apagado sozinho
  (`retencao.js` só por comando).

## Só o dono faz — obrigatório para lançar

- [ ] **Contratante da Trimundi no San Checkout** (painel `/admin.html` do
  Checkout, que o próprio dono administra): criar o contratante com
  - URL base da API: `https://mostrai.sancocore.com.br/ticket/api/checkout`
    (o Checkout chama `{base}/pedido/{pedidoId}`);
  - `webhook_url`: `https://mostrai.sancocore.com.br/ticket/api/checkout/webhook`;
  - métodos: Pix e cartão (o `expiraEm` de 30 min desliga o boleto);
  - anotar o `contratante_id` e a chave gerada.
- [ ] **Variáveis de produção no Northflank** (serviço da Mostraí):
  `TRIMUNDI_ATIVA=1`, `TRIMUNDI_SEGREDO` (32+ caracteres, novo, só desta
  finalidade), `TRIMUNDI_CHECKOUT_BASE_URL=https://checkout.sancocore.com.br`,
  `TRIMUNDI_CHECKOUT_API_URL=https://api.sancocore.com.br`,
  `TRIMUNDI_CHECKOUT_CONTRATANTE_ID`, `TRIMUNDI_CHECKOUT_KEY`.
  Conferir que `DATABASE_URL` é o pooler de SESSÃO (porta 5432).
- [ ] **E-mail da Mostraí ativo em produção** (`SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASS`, `MOSTRAI_EMAIL_FROM`). Sem ele ninguém confirma
  a conta e, portanto, ninguém compra.
- [ ] **Storage da Mostraí** (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_STORAGE_BUCKET`) em produção: sem ele, o Admin não envia banner
  nem imagens (responde "imagens não configuradas").
- [ ] **Autorizar** o merge, o deploy e a migration em produção
  (`npm run trimundi:migrate -- --producao-autorizada`).
- [ ] **Teste real de ponta a ponta** (API.md do Checkout, §11): uma compra
  de valor baixo com Pix e outra com cartão, e-mail recebido, QR na conta,
  check-in num celular Android e num iPhone, entrega do benefício, e um
  reembolso.
- [x] **Termos de Uso e Política de Privacidade** da Trimundi (v1.0,
  10/11/2026) em `/ticket/termos` e `/ticket/privacidade`, com aceite
  obrigatório no cadastro (maioridade + termos, guardados com versão, IP e
  navegador). Conta só para maiores de 18; compra para evento com
  classificação exige a declaração de idade dos participantes; reembolso só
  nos casos legais (arrependimento do art. 49, evento cancelado, pago sem
  vaga). **Recomendado:** revisão de um advogado.
- [ ] **E-mail de contato próprio** para o titular e o comprador (ex.:
  `trimundi@sancocore.com.br`) em `TRIMUNDI_EMAIL_CONTATO`. Sem ele, os
  documentos mostram o contato da Mostraí (`MOSTRAI_EMAIL_CONTATO`).
- [ ] **Nota fiscal do ingresso:** quem emite e em nome de quem.
- [ ] **Repasse financeiro:** sem `wallet_id` (conta Asaas de pessoa
  física), o valor das vendas cai na conta do operador do Checkout e o
  repasse ao organizador é manual (API.md do Checkout, §2.0 e §8).

## Só o dono decide — documentos legais v1.2 (10/11/2026)

- [ ] Os textos oficiais foram publicados **exatamente** como entregues,
  inclusive três trechos em que a quebra de linha sumiu na colagem
  ("concorrência de tempo.Não há", "legítimo interesse.Nota de cookies",
  "controle de acesso.A TICK"). Corrigir é mudar o texto: só com um texto
  novo do dono (e uma versão nova, que pede aceite de novo).
- [ ] Os Termos publicam o CPF do operador da plataforma. Confirmar que é
  intencional.
- [ ] Revisão por advogado das afirmações da Política (retenção, bases
  legais, cookies) frente ao que o sistema faz (`inventario-de-dados.md`).
- [ ] Prazo de guarda do histórico de aceites (`aceites_conta`) e do IP e
  navegador do aceite depois que a conta é apagada — hoje ficam.

## Só o dono faz — pode esperar

- [ ] Criar a TREEMUNDO / EDITION01 pelo Admin (ingressos, lotes,
  benefícios, campanha de indicação, banner) — antes de divulgar o link.
- [ ] Domínio próprio da Trimundi (hoje `/ticket/*` fica no domínio da
  Mostraí). Pede DNS no Cloudflare e `SITE_URL`/rotas; não é necessário
  para lançar.
- [ ] Prazos definitivos de retenção (D2), depois da revisão jurídica.
- [ ] Remetente próprio da Trimundi, se um dia quiser (`TRIMUNDI_SMTP_*`).

## Engenharia — feito nesta etapa

- [x] Esquema `trimundi` com conexão que falha fechado; migrations
  aplicadas num banco limpo (público com 77 tabelas antes e depois; 37 no
  esquema; RLS em todas; reaplicar não muda nada).
- [x] Restauração só da Trimundi ensaiada (RUNBOOK §11.4).
- [x] Um pedido aguardando pagamento por conta e edição (ninguém segura
  estoque abrindo vários pedidos).
- [x] Página de erro própria em `/ticket` (antes aparecia a da Mostraí).
- [x] Fluxo completo no navegador, com o pagamento SIMULADO: indicação →
  cadastro → confirmação por e-mail (capturado) → compra → ingresso com QR
  e benefício → login do operador → check-in → entrega → segunda leitura
  recusada → indicação contada.

## Engenharia — depois do lançamento

- [ ] Se a venda crescer: aumentar o *pool size* do pooler de sessão no
  Supabase e então `TRIMUNDI_POOL_MAX` (hoje 1 conexão por instância, para
  caber nas 15 vagas que a Mostraí divide; RUNBOOK §11.2).

- [ ] Reembolso por **cancelamento do evento** devolvendo só o valor dos
  ingressos (sem as taxas do Checkout) e o estorno em massa da edição. Hoje
  o reembolso total devolve o valor cobrado inteiro, taxas incluídas.
- [ ] Link da página de status do Checkout (`status.html`) no e-mail do
  pedido (API.md §11, item recomendado).
- [ ] Medir pedidos por segundo com a reserva serializada por edição (P-06)
  antes de uma venda com muita gente ao mesmo tempo.
- [ ] Serviço próprio no Northflank, se o volume pedir (hoje a Trimundi
  divide o processo com a Mostraí).
