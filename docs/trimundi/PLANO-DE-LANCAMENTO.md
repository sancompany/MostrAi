# PLANO DE LANÇAMENTO — TREEMUNDO / TICK

Documento central de acompanhamento. Cada item tem status, responsável,
dependências, evidência e próxima ação. **Nada é marcado como concluído só
porque existe tela ou código: concluído pede evidência de funcionamento**
(teste automatizado que passou, verificação em produção ou registro real).

**Status:** `pendente` · `em andamento` · `bloqueado` · `concluído`
**Responsáveis:** Claude · Bruno (dono) · Advogado · Fornecedor (San
Checkout, Northflank, Supabase, provedor de e-mail) · Terceiro

**Última atualização geral:** 16/11/2026.

---

## Ponto de partida — conferido em 16/11/2026

Conferência feita agora, não presumida:

| Item | Situação real | Como foi conferido |
|---|---|---|
| Código | `main` em `749f89a` (#156); PRs #150–#156 incorporados | `git log origin/main` |
| Produção | Rodando `749f89a` em 2 instâncias, `/health` ok | API do Northflank + `GET /health` |
| Migrations TICK | 19 aplicadas (013–019 em 16/11, 10:55–12:00 UTC) | `trimundi.schema_migrations` (só leitura) |
| Migrations Mostraí | 117, sem mudança | `public.schema_migrations` |
| Dados TICK | 4 pedidos (1 pago por Pix, 3 expirados), 1 ingresso, 7 operadores, 1 edição publicada, 0 campanhas | contagens, sem dado pessoal |
| Backup | Manual em 16/11, 10:40 UTC, restauração ensaiada; job semanal (dom 08:00 UTC) ativo | job `Backup` |
| Conciliação | Job da Mostraí diário às 09:00 UTC (3 últimas execuções com sucesso). A da TICK roda no próprio app a cada 6 h | API do Northflank + `src/trimundi/index.js` |
| Logs | 77 linhas recentes do serviço, nenhuma de erro | API do Northflank |
| Páginas públicas | 6 telas em computador e celular: 200, sem erro de JavaScript, sem rolagem lateral | Playwright contra produção |
| Testes | 1346/1346 na versão final | `npm run check` em banco limpo + CI |

---

## 1. Tarefas que eu (Claude) executo

| # | Item | Status | Dependências | Evidência | Próxima ação | Atualizado |
|---|---|---|---|---|---|---|
| C1 | Auditoria do estado atual (código, produção, documentação) | concluído | — | Tabela "Ponto de partida" acima | — | 16/11 |
| C2 | Páginas principais em computador e celular | concluído | — | Playwright contra produção: 12 verificações ok | Repetir a cada deploy | 16/11 |
| C3 | Logs e monitoramento de erros | em andamento | — | Logs recentes sem erro; `/health` ok | Montar uma rotina de checagem (logs + `/health` + fila de pagamento) e documentá-la no RUNBOOK | 16/11 |
| C4 | Webhooks: assinatura, reprocessamento, idempotência | concluído (automático) | — | Testes: webhook sem assinatura → 401 em produção; aviso reprocessado 3× sem efeito (`trimundi-pagamento`, `trimundi-campanhas-venda`) | Conferir de novo na compra real (B5) | 16/11 |
| C5 | Fila "Pagos sem vaga" e conciliação | concluído (automático) | — | Testes P5 (motivo, conciliação, histórico); em produção hoje: 0 casos | Conferir de novo se surgir caso real | 16/11 |
| C6 | Registros financeiros e histórico | concluído (automático) | — | Auditoria de reembolso, eventos de pagamento, disputas e sem vaga cobertos por teste | — | 16/11 |
| C7 | Auditoria dos 15 relatórios (§8) | concluído | — | `docs/trimundi/auditoria-relatorios.md` | Construir os que faltam (C8) | 16/11 |
| C8 | Relatórios que faltam ou estão incompletos | em andamento | C7; merge autorizado pelo Bruno | PR #158: 12 dos 15 com filtros e CSV, 5 testes que conferem cada total contra contagem independente, navegador ok, regressão 1352/1352 | Merge e deploy depois da autorização; os relatórios 1 e 15 vêm com Promoters | 16/11 |
| C9 | Desenho técnico de Promoters | concluído (desenho) | Decisões do Bruno (B10) | `docs/trimundi/specs/2026-11-16-promoters-desenho.md` | Esperar as decisões; depois construir em PRs separados | 16/11 |
| C10 | Minuta de regulamento de campanha (para o advogado) | concluído (minuta) | — | `docs/trimundi/legal/minuta-regulamento-campanhas.md` | Revisão do advogado (A5) | 16/11 |
| C11 | Roteiro de teste real (compra, cartão, reembolso, portaria) | concluído (roteiro) | — | `docs/trimundi/roteiro-teste-real.md` | Bruno executa (B5–B8); eu confiro no banco e nos logs | 16/11 |
| C12 | Procedimento de atendimento ao participante | concluído (rascunho) | Contato próprio (C/B3) | `docs/trimundi/atendimento-participante.md` | Bruno aprova o texto e o canal | 16/11 |
| C13 | Portaria sem conexão (offline) | concluído (automático) | — | Testes `trimundi-checkin-offline` (pacote, sincronização, conflitos) | Teste em aparelho real (B7) | 16/11 |
| C14 | Bloqueio de entrada duplicada | concluído (automático) | — | Índice único no banco + teste de 3 portarias simultâneas | Teste em aparelho real (B7) | 16/11 |

## 2. Tarefas que dependem do Bruno (dono)

| # | Item | Status | Dependências | Evidência necessária | Próxima ação | Atualizado |
|---|---|---|---|---|---|---|
| B1 | Conferir nome empresarial e CNPJ exibidos na página de pagamento do San Checkout | pendente | Acesso ao painel do Checkout | Print da página de pagamento mostrando o MEI | Abrir o link de pagamento de um pedido e conferir | 16/11 |
| B2 | Conferir o nome do remetente dos e-mails | pendente | Acesso ao Northflank | Print de um e-mail recebido | Ver a variável `MOSTRAI_EMAIL_FROM` (ou criar `TRIMUNDI_EMAIL_FROM`) | 16/11 |
| B3 | E-mail de contato próprio da TICK | pendente | Criar a caixa (ex.: no provedor de e-mail) | Variável `TRIMUNDI_EMAIL_CONTATO` no Northflank + e-mail de teste recebido | Criar o endereço e me avisar; eu confiro onde ele aparece | 16/11 |
| B4 | Endereço completo da operadora (Decreto 7.962/2013) | pendente | Advogado (A1) para a versão nova dos textos | Termos e Política v1.4 publicados | Informar o endereço; eu preparo a minuta da v1.4 com ele | 16/11 |
| B5 | Compra real com **cartão** (valor baixo) | pendente | Autorização para pagamento real | Pedido pago, ingresso emitido, e-mail recebido | Seguir `roteiro-teste-real.md`, passo 2 | 16/11 |
| B6 | **Reembolso** real | pendente | Autorização; B5 | Reembolso confirmado pelo Checkout, ingresso cancelado | Seguir o roteiro, passo 4 | 16/11 |
| B7 | Check-in em **Android** e **iPhone** (QR, duplicado, sem conexão) | pendente | Um operador e o ingresso pago de 11/11 (ou B5) | Entrada registrada; segunda leitura recusada; teste sem conexão sincronizado | Seguir o roteiro, passo 3 | 16/11 |
| B8 | Entrega de benefício na portaria | pendente | B7; um benefício cadastrado | Entrega registrada com operador e horário | Seguir o roteiro, passo 3.5 | 16/11 |
| B9 | Organizador de cada evento | pendente | Decisão | — | Decidir se entra um campo "Organizador (nome e CNPJ/CPF)" na ficha do evento e onde ele aparece | 16/11 |
| B10 | Decisões pendentes de Promoters | pendente | — | Decisões registradas | Responder as perguntas da seção 5 do desenho de Promoters | 16/11 |
| B11 | Ativar uma campanha | bloqueado | A5 (regulamento revisado) | Campanha ativa com a marca de revisão | Só depois da revisão jurídica | 16/11 |
| B12 | Nota fiscal do ingresso e repasse financeiro | pendente | Contador/advogado (A4) | Definição registrada | Definir quem emite e como é o repasse ao organizador | 16/11 |

## 3. Tarefas que dependem de fornecedores

| # | Item | Status | Responsável | Evidência | Próxima ação | Atualizado |
|---|---|---|---|---|---|---|
| F1 | Contratante da TICK no San Checkout | concluído | Fornecedor (San Checkout) | Compra Pix real em 11/11: cobrança, aviso, emissão e e-mail | — | 16/11 |
| F2 | Variáveis de produção (Checkout, e-mail, Storage) | concluído | Northflank | Nomes presentes no serviço (valores não lidos); funcionamento comprovado por F1, pelos e-mails `enviado` e pelo banner servido | — | 16/11 |
| F3 | Envio de e-mail (SMTP) | concluído | Provedor de e-mail | 3 tipos de e-mail com status `enviado` em produção | Conferir a caixa de entrada na compra real (B5) | 16/11 |
| F4 | Armazenamento de imagens | concluído | Supabase | Banner da TREEMUNDO servido pelo Storage | — | 16/11 |
| F5 | Repasse automático (split) | bloqueado | San Checkout | — | Não existe hoje; o repasse é manual (ver B12) | 16/11 |

## 4. Tarefas que dependem do advogado

| # | Item | Status | Dependências | Evidência necessária | Próxima ação | Atualizado |
|---|---|---|---|---|---|---|
| A1 | Revisar os Termos de Uso v1.3 | pendente | B4 (endereço) | Parecer ou texto aprovado | Enviar `docs/trimundi/legal/termos-de-uso-v1.3.txt` | 16/11 |
| A2 | Revisar a Política de Privacidade v1.3 | pendente | — | Parecer ou texto aprovado | Enviar o texto e o `inventario-de-dados.md` | 16/11 |
| A3 | Prazo de guarda dos registros de aceite (e do IP e navegador) | pendente | — | Prazo definido por escrito | Pergunta ao advogado (hoje os registros ficam sem prazo) | 16/11 |
| A4 | Requisitos fiscais e documentais da operação; nota fiscal; repasse | pendente | Contador | Definição por escrito | Junto com B12 | 16/11 |
| A5 | Regulamentos das campanhas (C7) | pendente | C10 (minuta pronta) | Regulamento aprovado; marca "Regulamento revisado" no Admin | Enviar a minuta `minuta-regulamento-campanhas.md` | 16/11 |
| A6 | Termo do promoter (necessário para a regra 8: comissão cancelada sem 10 vendas) | pendente | C9 | Termo aprovado | Depois das decisões de Promoters (B10) | 16/11 |
| A7 | Requisitos de dados pessoais e fiscais antes de pagar comissão real (decisão C) | pendente | C9 | Lista aprovada | Junto com A6 | 16/11 |

---

## Proteções que continuam ativas

- **Nenhuma campanha ativa ou pública sem a marca de revisão jurídica.** O Admin não ativa sem ela, a vitrine não mostra e o desconto não é aplicado.
- **Nenhuma transação financeira real** sem autorização expressa.
- **Pedido de teste** bloqueado em produção.
- **Nenhum segredo lido ou exposto.** As conferências usam só nomes de variáveis e contagens.

## Histórico de atualizações

- **16/11/2026** — documento criado depois da publicação da fase de Campanhas, com a auditoria do estado real.
- **16/11/2026** — C8: relatórios em PR (#158), esperando autorização de merge.
