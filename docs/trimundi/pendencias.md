# Pendências — Trimundi

O que falta nesta versão, e o que só o dono faz. Fechar é marcar `[x]` com
a evidência; reabrir é desmarcar com o motivo. O estado detalhado de cada
funcionalidade está em `STATUS-IMPLEMENTACAO.md`.

## Estação 4 — fechada em 09/11/2026

- [x] **D1 — Métrica de sucesso.** Aprovada pelo dono (09/11/2026): pagos
  emitidos, cortesias emitidas, total de participantes, receita confirmada,
  cancelamentos, reembolsos e chargebacks; pedido de teste fora de tudo;
  cortesia nunca é receita. Evidência: `participantes.js#resumo`, teste
  "resumo da edição (D1)" em `tests/trimundi-pagamento.test.js`.
- [x] **D2 — Retenção.** Aprovada COM ressalva (09/11/2026): estrutura
  pronta com prazos provisórios, nenhuma exclusão automática de dado real
  agora, dado exigido por lei preservado, operador revogado na hora.
  Evidência: `src/trimundi/retencao.js` (só por comando, com
  `--confirmar`), teste "retenção (D2)". **Os prazos definitivos seguem
  abertos** (abaixo, "Antes de dado real").
- [x] Migrations do banco próprio aplicadas em banco limpo, com o teste de
  RLS verde (`tests/trimundi-fundacao.test.js`).

## Etapas desta versão

- [x] 0 — Documentos das estações 1 a 4 (commit `fc13b5c`, CI verde).
- [x] 1 — Banco próprio, migrations, RLS, conexão, módulo desligado.
- [x] 2 — Admin "Eventos": as cinco abas.
- [x] 3 — Página pública `/ticket/:evento/:edição`.
- [x] 4 — Pedido, reserva de 30 min e o contrato do San Checkout (com dublê).
- [x] 5 — Emissão, página do pedido com QR, e-mail desacoplado, recuperação.
- [x] 6 — Operadores, ativação, login pela tela da Mostraí e check-in com
  câmera e código; espaço do link de indicação reservado.
- [ ] 7 — Homologação: testes, regressão e E2E local feitos; falta a
  homologação do dono (abaixo) e o teste em aparelho real.

## Decisões do dono desta execução

- [ ] **Pedido de teste em produção.** Hoje só fora de produção (RN-T19).
  Liberar em produção serve para homologar o Checkout de verdade (pedido
  de R$ 5, pago e reembolsado), sempre fora das métricas. Sim ou não?
- [ ] **Taxas no reembolso total.** O Checkout devolve o valor cobrado
  inteiro, com as taxas que o comprador pagou; o reembolso por ingresso
  devolve só o preço dele. Fica assim, ou o total também devolve só o preço?
- [ ] **Prazos definitivos de retenção (D2)**, depois da revisão jurídica.
  Provisórios em `retencao.js`: participantes 180 dias após a edição,
  compradores 5 anos após o último pedido, operador desativado 6 meses.
- [ ] **Sobra de lote encerrado** (documentada desde a Etapa 0): a cota não
  vendida do lote encerrado passa para o seguinte; no último lote, a vaga
  de reserva vencida volta para ele. Confirmar que é a regra comercial.

## Antes de dado real (antes de usar em produção)

### Só o dono faz

- [ ] **Projeto Supabase da Trimundi** em sa-east-1 (banco e Storage). A
  organização está no plano gratuito com os 2 projetos que ele permite; o
  terceiro pede plano pago ou outra organização — **custo a apresentar e
  autorizar antes**.
- [ ] **Alias de e-mail** da Trimundi no Google Workspace: canal do titular
  e envio do ingresso (SMTP próprio, `TRIMUNDI_SMTP_*`).
- [ ] **Revisão jurídica** do regulamento, dos termos de compra e da
  Política de Privacidade cobrindo a Trimundi; prazos de D2.
- [ ] **`TRIMUNDI_SEGREDO`** de produção (32+ caracteres) guardado como
  segredo.

### Engenharia

- [x] Exportação e anonimização por CPF pelo Admin (Participantes → **Pedido
  do titular (LGPD)**). Falta o **canal** do titular (alias de e-mail).
- [x] Limpeza do corpo e do endereço dos e-mails enviados depois de 90 dias
  (provisório), na retenção manual.
- [ ] Backup do banco da Trimundi: job no Northflank e uma restauração
  ensaiada (Lei 6).
- [ ] Variáveis da Trimundi no Northflank (nomes em `.env.example`) e
  `npm run trimundi:migrate -- --producao-autorizada` no arranque — só com
  autorização.
- [x] Conciliação com o Checkout: roda sozinha a cada 6 h no processo,
  quando o Checkout está configurado.
- [x] Origem do armazenamento de imagens da Trimundi na CSP
  (`TRIMUNDI_SUPABASE_URL` em `src/server.js`).

## Antes da venda pública

### Só o dono faz

- [ ] **Contratante da Trimundi no San Checkout**, cadastrado por quem
  administra o Checkout:
  - `contratante_id`, chave, URL base e `webhook_url`
    (`{site}/ticket/api/checkout/webhook`);
  - endereço do pedido: `{site}/ticket/api/checkout/pedido/{pedidoId}`;
  - métodos Pix e cartão (o `expiraEm` desliga o boleto);
  - `retornoDominios` com o domínio do site, para o `returnUrl`.
- [ ] **Nota fiscal do ingresso:** quem emite e em nome de quem (pergunta 29
  do Blueprint).
- [ ] **Serviço próprio** no Northflank para a Trimundi, ou registrar de
  novo o limite (spec §5 e §9).
- [ ] **Homologação no aparelho real:** check-in com a câmera de um iPhone
  e de um Android, e uma compra de ponta a ponta no Checkout de teste.

### Engenharia

- [ ] Os seis passos de ponta a ponta do `API.md` §11 contra o contratante
  de teste do Checkout.
- [ ] Medir pedidos por segundo com a reserva serializada por edição (P-06).
