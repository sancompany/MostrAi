# PLANO DE LANÇAMENTO — TREEMUNDO / TICK

Documento central de acompanhamento. **Nada é marcado como concluído só
porque existe tela ou código: concluído pede evidência de funcionamento**
(teste automatizado que passou, verificação em produção ou registro real).

**Status:** `concluído` · `implementado, aguardando validação` · `em andamento`
· `depende de decisão do Bruno` · `depende de terceiro` · `bloqueado (jurídico
ou financeiro)` · `pendente`
**Responsáveis:** Claude · Bruno (dono) · Advogado · Contador · Fornecedor
(San Checkout, Northflank, Supabase, provedor de e-mail) · Terceiro

**Última atualização geral:** 16/11/2026, 21:30 UTC.

---

## 1. Situação geral

- **Em produção** (`main` em `cf3c4c6`, publicado às 21:16 UTC de 16/11):
  - venda, pagamento Pix/cartão pelo San Checkout, emissão e e-mail;
  - portaria com e sem conexão;
  - campanhas, com a proteção de revisão jurídica ativa;
  - relatórios 2 a 14 com CSV;
  - saúde do sistema (C3);
  - alertas (B13): vigia no serviço e a tarefa `SentinelaTick` no Northflank.
- **Pronto em PR, esperando o merge:**
  - Promoters, em 3 PRs: #161 motor, #162 Admin e relatórios 1 e 15, #163 Minha Conta;
  - relatórios 16 a 20 (#164).
  - O código de Promoters segue as regras aprovadas. As decisões abertas (P-1 a P-10) estão na seção 4, cada uma com recomendação. O pagamento de comissão e a candidatura pela conta ficam **desligados** até essas decisões.
- **O que falta para operar** (seção 3):
  - o teste real com cartão e reembolso (B5, B6) e a portaria em Android e iPhone (B7, B8), feitos pelo Bruno;
  - a revisão jurídica: Termos v1.3, endereço, regulamentos, termo do promoter;
  - a definição fiscal (nota e repasse);
  - a conta do monitor externo com aviso no celular.
- **Riscos críticos conhecidos sem tratamento:** nenhum. Os riscos abertos estão na seção 7.

## 2. Progresso por módulo

| Módulo | Situação | Evidência |
|---|---|---|
| Venda e checkout (Pix) | **concluído** | Compra real em 11/11: cobrança, aviso, ingresso e e-mail; testes de pagamento e idempotência |
| Venda com cartão e reembolso real | **depende do Bruno** (B5, B6) | Roteiro pronto: `roteiro-teste-real.md` |
| Portaria (QR, duplicado, sem conexão) | implementado, aguardando validação em aparelho real (B7) | Testes `trimundi-checkin*`; índice único contra entrada duplicada |
| Campanhas e promoções | **concluído no código**; nenhuma ativa (proteção C7) | #150–#156 em produção; 0 campanhas; ativar exige a revisão jurídica (B11/A5) |
| Relatórios §8 (15) | 2–14 **em produção** (#158); 1 e 15 em PR (#162) | `auditoria-relatorios.md`; testes conferem cada total contra o banco |
| Relatórios complementares (16–20) | em PR (#164) | Participantes, reembolsos, financeiro, conciliação, desempenho por edição; números iguais aos das outras telas |
| Saúde do sistema (C3) | **concluído** (#159, em produção) | Sinais zerados em produção (SELECT, 16:14 e 21:20 UTC) |
| Monitoramento e alertas (B13) | **concluído no que é meu** (#160 + `SentinelaTick`); monitor no celular depende do Bruno | Seção 3, B13 |
| Promoters | implementado em PR (#161–#163), aguardando merge e as decisões | Seção 4 |

## 3. Pendências B1–B13 — classificadas

| # | Item | Status | Responsável | O que falta exatamente | Evidência / próxima ação |
|---|---|---|---|---|---|
| B1 | Nome empresarial e CNPJ na página de pagamento do San Checkout | depende de terceiro | Bruno (painel do Checkout) | A página de pagamento é do San Checkout; o nome vem do cadastro do contratante lá. Conferir sem criar cobrança real exige o painel do Checkout | Bruno abre o cadastro do contratante TICK no Checkout e confirma o MEI; um print fecha o item |
| B2 | Nome do remetente dos e-mails | depende do Bruno | Bruno | O remetente vem de `MOSTRAI_EMAIL_FROM`, fora do código (o valor não é lido por mim). O rodapé de todo e-mail já leva o MEI e o CNPJ | Bruno confere um e-mail recebido; se quiser outro nome, cria `TRIMUNDI_EMAIL_FROM` (eu configuro se ele me passar o texto) |
| B3 | E-mail de contato próprio da TICK | depende do Bruno | Bruno → Claude | Criar a caixa (ex.: `contato@…`). Depois, eu ponho `TRIMUNDI_EMAIL_CONTATO`, e ele aparece nos Termos, na Política e como destinatário dos alertas | Sem a caixa, o contato é o da Mostraí, e os alertas vão para lá |
| B4 | Endereço completo da operadora (Decreto 7.962/2013) | bloqueado (jurídico) | Bruno + advogado | O endereço não foi informado e não será inventado. Pede Termos e Política v1.4 (texto novo, novo aceite) | Bruno informa o endereço; preparo a minuta v1.4 para o advogado |
| B5 | Compra real com cartão | depende do Bruno (pagamento real) | Bruno | Uma compra de valor baixo com cartão | `roteiro-teste-real.md` §2; depois eu confiro no banco (pedido, aviso, ingresso, e-mail) e nos relatórios 18 e 19 |
| B6 | Reembolso real | depende do Bruno (reembolso real) | Bruno | Um reembolso pelo Admin | Roteiro §4; eu confiro o estorno, o ingresso cancelado e o relatório 17 |
| B7 | Check-in em Android e iPhone (QR, duplicado, sem conexão) | depende do Bruno + operador | Bruno | Teste presencial com aparelhos reais | Roteiro §3; eu confiro `checkins` e os relatórios 13 e 14 |
| B8 | Entrega de benefício na portaria | depende do Bruno | Bruno | Depende de B7 e de um benefício cadastrado | Roteiro §3.5 |
| B9 | Organizador de cada evento | depende de decisão do Bruno | Bruno | Decidir se entra um campo "Organizador (nome e CNPJ/CPF)" na ficha da edição, exibido na página de venda e no e-mail | **Recomendação:** sim, campo opcional na ficha, mostrado na página de venda e no rodapé do e-mail do pedido. Com a decisão, faço em 1 PR pequeno (migration só de acréscimo) |
| B10 | Decisões de Promoters (P-1 a P-10) | depende de decisão do Bruno | Bruno (P-8 e P-9 com advogado e contador) | Ver a seção 4 | O código não depende delas para existir: pagamento e candidatura ficam desligados até lá |
| B11 | Ativar uma campanha | bloqueado (jurídico) | Advogado (A5) | Regulamento revisado | Minuta pronta: `legal/minuta-regulamento-campanhas.md` |
| B12 | Nota fiscal do ingresso e repasse ao organizador | bloqueado (financeiro) | Contador + advogado (A4) | Quem emite, em nome de quem, e como é o repasse (o San Checkout não faz split — F5) | Definição por escrito; o relatório 18 (financeiro) já dá os números por meio de pagamento |
| B13 | Monitoramento contínuo e alerta no celular | **concluído no que é meu**; monitor externo depende do Bruno | Claude → Bruno | Feito: vigia (5 min), `SentinelaTick` (10 min, `Forbid`), `/ticket/api/saude`, e-mail sem repetição, RUNBOOK §11.5. Falta: a conta no serviço de uptime com app no celular (cria conta e aceita os termos — passo do Bruno) | Evidência na seção 6. Configuração do monitor externo pronta abaixo |

**Monitor externo (B13) — configuração pronta, conta a criar pelo Bruno:**
- **Serviço recomendado:** UptimeRobot, plano gratuito: intervalo de 5 min e aplicativo para Android e iPhone com notificação.
- O plano gratuito é para uso não comercial, então conferir os termos. Se não servir, há o plano pago mais barato do mesmo serviço ou o Better Stack. Não criei conta nem aceitei termos.
- **Monitores (tipo HTTP(s), a cada 5 min):**
  1. `https://mostrai.sancocore.com.br/health`, palavra-chave `"ok":true`;
  2. `https://mostrai.sancocore.com.br/ticket/api/saude`, palavra-chave `"ok":true`. Responde 503 com sinal crítico ou banco fora.
- **Alerta:** app no celular e e-mail do Bruno, depois de 2 falhas seguidas (evita alarme falso em deploy).

## 4. Promoters — situação e decisões P-1 a P-10

**Construído** (só regras aprovadas; recomendações em
`specs/2026-11-16-promoters-desenho.md` §5):

| PR | Conteúdo | Testes |
|---|---|---|
| #161 | Migration 021 (só acréscimo, RLS) e motor de comissões, explicados abaixo | 12 casos: tabela, idempotência, imutabilidade, sem retroativo, suspensão, escada, estorno, simultaneidade, recrutamento, pagamento |
| #162 | Admin (aba Promoters, ficha, decisões, crédito emitido) e relatórios 1 e 15 | rotas e relatórios conferidos contra o livro; navegador 16/16 |
| #163 | Minha Conta: painel do promoter, links de venda e convite; candidatura fechada por padrão | 2 casos; navegador 12/12 |

O motor do #161 faz o seguinte:
- grava cada venda do promoter num **livro de comissões só de acréscimo**, com o percentual pela ordem da venda (10% a 15%);
- trata o reembolso como lançamento de estorno;
- marca a comissão como provisória abaixo de 10 vendas;
- gera o crédito de recrutamento;
- usa a situação do promoter no instante do pagamento.

**Desligado até a decisão:**
- **Pagamento de comissão** (`TRIMUNDI_PROMOTER_PAGAMENTOS`): espera P-1 e P-9.
- **Candidatura pela conta** (`TRIMUNDI_PROMOTERS_CANDIDATURA`): espera o termo, P-8.

| # | Decisão | Recomendação |
|---|---|---|
| P-1 | Quando a comissão fica liberada para pagar | Depois do fim da edição **e** 7 dias da compra |
| P-2 | Reembolso depois de pago | Compensar no próximo pagamento; sem pagamento futuro, saldo devedor registrado |
| P-3 | Reembolso que derruba a faixa | Confirmar o que já está implementado: as próximas vendas usam a contagem atualizada, que é o efeito das regras 5 e 6 juntas |
| P-4 | Compra pelo próprio link | Confirmar: não conta, pela regra de indicação que já existe |
| P-5 | Link do promoter também em "Indique e ganhe" | Não acumular: venda com comissão não conta para campanha de indicação |
| P-6 | Benefícios por meta (10/20/40/60) | Aprovar como cortesias nominais emitidas pelo Admin, depois de entrarem no termo |
| P-7 | Revenda de cortesia | Não permitir na v1 |
| P-8 | Termo do promoter | Advogado revisar a minuta `legal/minuta-termo-promoter.md` |
| P-9 | Dados para pagar | CPF e chave Pix só no 1º pagamento; RPA e retenção definidos pelo contador |
| P-10 | Promoter e operador na mesma pessoa | Permitir, com as permissões separadas, como está |

## 5. PRs, commits e deploys (16/11/2026)

| PR | Conteúdo | Situação | Commit na `main` | Deploy |
|---|---|---|---|---|
| #150–#156 | Portaria, lotes, Admin, campanhas (4 PRs) | incorporados | até `749f89a` | 12:01 UTC, migrations 013–019 |
| #157 | Plano, auditoria, desenho de Promoters, minutas | incorporado | `7e645f7` | só documentação |
| #158 | Relatórios 2–14 (+ CSV sem teto, achado do Codex) | incorporado | `20babdb` | 19:13 UTC |
| #159 | Saúde do sistema (C3) | incorporado | `fb1813d` | 19:20 UTC |
| #160 | Alertas (B13) + migration 020 | incorporado | `cf3c4c6` | 21:16 UTC; migration 020 às 21:15 UTC; backup antes, às 21:00 UTC |
| #161 | Promoters 1/3 — motor (migration 021) | aberto, CI verde | — | espera autorização |
| #162 | Promoters 2/3 — Admin e relatórios 1 e 15 | aberto (empilhado) | — | espera autorização |
| #163 | Promoters 3/3 — Minha Conta | aberto (empilhado) | — | espera autorização |
| #164 | Relatórios 16–20 | aberto (empilhado) | — | espera autorização |

Tarefa agendada criada no Northflank: `SentinelaTick` (cron `*/10 * * * *`,
`Forbid`, 120 s, `npm run trimundi:sentinela`).

## 6. Testes executados e resultados

| Quando | O quê | Resultado |
|---|---|---|
| 16/11 | Regressão da versão integrada #157 + #158 + #159, em banco limpo | **1359/1359**, lint e formato ok |
| 16/11 | Navegador (computador e celular): relatórios e saúde | 12/12 e 14/14 ok |
| 16/11 | Regressão do #160 (B13) em banco limpo | **1365/1365** |
| 16/11 | Produção depois de cada deploy | `/health` ok, páginas da TICK 200, rotas protegidas 401, 12 telas ok |
| 16/11 | Produção depois do #160 | `/ticket/api/saude` → `{"ok":true}`; migration 020 com RLS; 0 alertas abertos |
| 16/11 | `SentinelaTick` em produção | ver "Evidência do B13" abaixo |
| 16/11 | Promoters (#161–#163) | motor 12/12; Admin e relatórios 8/8; conta 12/12 (com motor); navegador 16/16 e 12/12; regressão local 1369/1369 |
| 16/11 | Relatórios 16–20 (#164) | 6/6 nas suítes de relatórios; navegador 20/20 |

Achados do Codex: 2 no #158, 1 no #159, 2 no #157 (documentação), 1 no
#160 e 2 no #161. Todos conferidos no código e corrigidos com teste. Em cada
correção de código, o teste novo falhava antes e passa depois.

**Evidência do B13 (produção, 16/11/2026):**
- 21:15 UTC — migration 020 aplicada (`saude_alertas`, RLS ligado), depois do backup das 21:00 (job `Backup`, SUCCESS).
- 21:16 UTC — deploy do #160. `/ticket/api/saude` → `200 {"ok":true}`.
- 21:17 UTC — tarefa `SentinelaTick` criada pela API do Northflank. As 9 variáveis foram copiadas do serviço sem leitura de valor. A imagem do commit `cf3c4c6` foi construída.
- 21:19 UTC — execução manual: "tudo respondendo", saída 0.
- 21:20 UTC — **simulação de site fora**: execução com `SITE_URL` trocada só nela para um caminho inexistente.
  - Os dois alvos responderam 404 e foram conferidos de novo 20 s depois.
  - E-mail "[TICK] ALERTA: 2 problema(s) crítico(s)" enviado ao contato.
  - `saude_alertas` com `sentinela:site` e `sentinela:tick` abertos e avisados.
  - Execução vermelha (saída 1).
- 21:29 UTC — execução normal: e-mail "[TICK] Resolvido: 2 problema(s)", alertas marcados como resolvidos, saída 0.
- **Os dois e-mails do teste chegaram ao e-mail de contato** (`MOSTRAI_EMAIL_CONTATO`). Bruno: conferir se chegaram e se não caíram no spam.
- O vigia (dentro do serviço) não tem sinal crítico para avisar em produção; o caminho dele é coberto por teste automatizado (`trimundi-alertas`).
- **Agenda:** as execuções das 21:30 e 21:40 não aconteceram. A tarefa criada pela API não registrou a agenda até as configurações serem reaplicadas, às 21:42 (`POST …/jobs/sentinelatick/settings`). Depois disso, **21:50 UTC: execução agendada, SUCCESS**. A lição ficou no RUNBOOK §11.5.

## 7. Riscos encontrados

| Risco | Situação | Tratamento |
|---|---|---|
| Fila de pagamento ou de e-mail parar sem ninguém ver | tratado | Saúde (C3) + vigia e sentinela (B13) avisam por e-mail |
| Site cair sem aviso no celular | aberto | Depende do monitor externo (B13, conta do Bruno) |
| Comissão paga antes de reembolso ou sem termo | tratado | Pagamento desligado até P-1/P-9; candidatura fechada até P-8 |
| Campanha publicada sem revisão jurídica | tratado | Bloqueio no Admin, na vitrine e no desconto (C7) |
| Pool de conexões do banco (15 vagas no pooler de sessão) | aberto, baixo | A TICK usa 1 por instância; a `SentinelaTick` abre 1 por 10 min, por segundos. Subir o volume pede aumentar o pool no Supabase (RUNBOOK §11.2) |
| Segredos copiados para a tarefa agendada | aceito | Mesmo padrão da `Conciliacao`: `DATABASE_URL` e `SMTP_*`; sem `TRIMUNDI_SEGREDO` nem a chave do Checkout. Rotação: RUNBOOK §2 |

## 8. Dependências externas

| Dependência | Para quê | Situação |
|---|---|---|
| San Checkout | Pagamento, reembolso, nome na página de pagamento (B1) | funcionando (Pix real em 11/11) |
| Asaas (via Checkout) | Cartão e Pix | funcionando; cartão real ainda não testado (B5) |
| Provedor de e-mail (SMTP) | Ingressos, confirmações, alertas | funcionando |
| Supabase | Banco e imagens | funcionando; backup semanal + manual antes de migration |
| Northflank | Serviço, jobs, `SentinelaTick` | funcionando |
| Serviço de uptime | Alerta no celular (B13) | a contratar (gratuito ou pago) — Bruno |
| Advogado | Termos, endereço, regulamentos, termo do promoter | pendente (A1–A7) |
| Contador | Nota fiscal, repasse, dados de pagamento | pendente (A4, P-9) |

## 9. Decisões que precisam do Bruno

1. **Autorizar merge e deploy** de #161, #162, #163 e #164: Promoters (com pagamento e candidatura desligados) e relatórios 16–20. A migration 021 é só de acréscimo.
2. **P-1 a P-10** (seção 4): responder ou aprovar as recomendações.
3. **B9:** campo "Organizador" na ficha da edição (recomendação: sim).
4. **B13:** criar a conta no serviço de uptime e cadastrar os 2 monitores (configuração na seção 3).
5. **B3:** criar o e-mail de contato da TICK; eu configuro o resto.
6. **B5–B8:** executar o teste real (`roteiro-teste-real.md`).

## 10. Próxima ação concreta

- **Claude:**
  - acompanhar os PRs #161–#164 (CI e revisão);
  - assim que o Bruno autorizar: merge na ordem, deploy, migration 021 com backup antes, e verificação em produção;
  - conferir cada teste real (B5–B8) no banco e nos relatórios assim que acontecer.
- **Bruno:** itens 1 a 6 da seção 9.

## Tarefas do advogado (A1–A7)

| # | Item | Status | Próxima ação |
|---|---|---|---|
| A1 | Termos de Uso v1.3 | pendente | Enviar `legal/termos-de-uso-v1.3.txt` (e o endereço, B4) |
| A2 | Política de Privacidade v1.3 | pendente | Enviar o texto e o `inventario-de-dados.md` |
| A3 | Prazo de guarda dos aceites (IP e navegador) | pendente | Hoje ficam sem prazo |
| A4 | Requisitos fiscais, nota fiscal, repasse | pendente | Junto com B12, com o contador |
| A5 | Regulamentos das campanhas | pendente | Minuta `legal/minuta-regulamento-campanhas.md` |
| A6 | Termo do promoter (P-8, regra 8) | pendente | Minuta `legal/minuta-termo-promoter.md` |
| A7 | Dados pessoais e fiscais para pagar comissão (P-9) | pendente | Junto com A6 |

## Proteções que continuam ativas

- Nenhuma campanha ativa ou pública sem a marca de revisão jurídica.
- Nenhuma transação financeira real sem autorização expressa; pedido de teste bloqueado em produção.
- Pagamento de comissão e candidatura de promoter desligados até as decisões.
- Nenhum segredo lido ou exposto: as conferências usam só nomes de variáveis e contagens.

## Histórico de atualizações

- **16/11/2026** — documento criado depois da publicação da fase de Campanhas.
- **16/11/2026** — C8 (#158) e C3 (#159) em PR.
- **16/11/2026, 19:20 UTC** — #157, #158 e #159 incorporados e publicados, com autorização do dono.
- **16/11/2026, 21:16 UTC** — #160 (B13) publicado, migration 020, tarefa `SentinelaTick` criada. Promoters (#161–#163) e relatórios 16–20 (#164) em PR. B1–B13 classificados.
