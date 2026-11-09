# Pendências — Trimundi

O que falta nesta versão, e o que só o dono faz. Fechar é marcar `[x]` com
a evidência; reabrir é desmarcar com o motivo.

## Para fechar a Estação 4 (bloqueia a construção)

- [ ] **D1 — Métrica de sucesso.** *Só o dono.* Proposta:
  - **Principal:** ingressos emitidos por edição, com pagos e cortesias
    contados separados, e a receita confirmada (só pagos de venda, nunca
    teste).
  - **"Quantos ontem?":** ingressos pagos e cortesias emitidos ontem, e
    quanto entrou.
  - **Eventos:** os dez de `funcional.md` §9.
- [ ] **D2 — Prazos de retenção.** *Só o dono, com revisão de advogado
  antes de dado real.* Proposta:
  - compradores e aceites: 5 anos após o pagamento;
  - participantes e cortesias: 180 dias após o fim da edição;
  - operador desativado: 6 meses;
  - histórico do Admin: 5 anos, sem dado pessoal.
  - Vencido o prazo, anonimiza (`inventario-de-dados.md`).
- [ ] Migrations do banco próprio aplicadas em banco limpo, com o teste de
  RLS verde (Etapa 1).

## Etapas desta versão

- [ ] 0 — Documentos das estações 1 a 4 (`docs/trimundi/`), com a exceção
  e o limite no `CONSTRAINTS.md` da raiz, o `RUNBOOK.md` e o ADR-048 em
  `.ia/DECISIONS.md`.
- [ ] 1 — Banco próprio: aplicador de migrations, migrations, RLS, conexão
  e módulo desligado sem configuração.
- [ ] 2 — Evento, edição, termos versionados e imagens → aba Criar evento.
- [ ] 3 — Tipos de ingresso, lotes, benefícios e disponibilidade (teste de
  corrida) → aba Criar ingressos.
- [ ] 4 — Promoções e combos → aba Criar promoção.
- [ ] 5 — Pedido de teste, confirmação idempotente, emissão e QR.
- [ ] 6 — Participantes e cortesias → aba Participantes.
- [ ] 7 — Operadores, ativação, login e check-in provisório → aba Adicionar
  operador.
- [ ] 8 — Revisão em ciclos, teste no navegador das cinco abas,
  documentação, HANDOFF e PR.

## Antes de dado real (antes de usar em produção)

### Só o dono faz

- [ ] **Projeto Supabase da Trimundi** em sa-east-1. A organização está no
  plano gratuito, com os 2 projetos que ele permite; o terceiro pede plano
  pago ou outra organização. Precisa da URL de conexão e do armazenamento de
  imagens.
- [ ] **Alias de e-mail** da Trimundi no Google Workspace (um por projeto):
  canal do titular e, depois, envio do ingresso.
- [ ] **Revisão jurídica** do regulamento, dos termos de compra e da
  Política de Privacidade cobrindo a Trimundi.
- [ ] **D2 revisado** por advogado.

### Engenharia

- [ ] Fluxo do titular: canal, exportação e anonimização por CPF pelo Admin.
- [ ] Backup do banco da Trimundi: job no Northflank e uma restauração
  ensaiada (Lei 6).
- [ ] Variáveis da Trimundi no Northflank (nomes em `.env.example`, quando
  existirem) e migrations dela no arranque do contêiner.
- [ ] Origem do armazenamento de imagens da Trimundi na CSP.

## Antes da venda pública

### Só o dono faz

- [ ] **Contratante da Trimundi no San Checkout**, cadastrado por quem
  administra o Checkout:
  - `contratante_id`, chave, URL base e `webhook_url`;
  - métodos Pix e cartão (o `expiraEm` desliga o boleto);
  - `retornoDominios`, se for usar `returnUrl`.
- [ ] **Nota fiscal do ingresso:** quem emite e em nome de quem (pergunta 29
  do Blueprint).
- [ ] **Serviço próprio** no Northflank para a Trimundi, ou registrar de
  novo o limite (spec §5 e §9).

### Engenharia

- [ ] Página pública, `GET /pedido`, webhook com inbox, conciliação diária,
  job de expiração e e-mail do ingresso (`api.md`, "Reservadas").
- [ ] Os seis passos de ponta a ponta do `API.md` §11 contra o contratante
  de teste do Checkout.
- [ ] Medir pedidos por segundo com a reserva serializada por edição (P-06).
