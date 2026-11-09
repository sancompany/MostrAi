# Trimundi — fundação da ticketeira (escopo validado)

09/11/2026 · Estação 1 (Escopo) e Estação 2 (Fronteiras) · registro de
decisão, escrito uma vez. Comportamento que mudar depois muda em
`../funcional.md`; versão nova ganha spec novo.

## 1. Origem

- **Pedido do dono, 09/11/2026:** "TRIMUNDI — Estruturação do Admin de
  Eventos e Fundação da Ticketeira". Um Admin enxuto, com cinco funções,
  dentro da aplicação da Mostraí, sobre a fundação técnica completa de uma
  ticketeira.
- **Base anterior:** o Blueprint v2 (v2.6, 08/09/2026) e a folha "Decisões
  TRIMUNDI⁹" (32 questões), artifacts privados do dono desenhados para uma
  Trimundi independente (outra hospedagem, promoters, times, portaria
  offline). Este spec aproveita deles só o que vale para a fundação (§7); o
  resto continua lá como referência e não é escopo (§8).
- **Auditoria e plano técnico** apresentados e aprovados na mesma conversa,
  com um ajuste do dono no login do operador (D-05).

## 2. Escopo (Fase 0)

| Pergunta | Resposta |
|---|---|
| Problema e para quem | O **organizador** (o dono, no Admin) precisa montar evento, edição, ingressos, lotes e combos, emitir cortesias e preparar a portaria, sobre uma base que já sustente a venda online e o check-in das próximas etapas |
| O que acontece hoje sem isso | Não informado nesta conversa. A decisão de ter plataforma própria é do dono e anterior a este spec (Blueprint v2); este spec não a reabre |
| Quantos usuários | Administrador: 1 (o login do Admin é um só). Operadores: alguns por edição. Compradores e participantes reais: nenhum nesta versão (sem venda pública). A escala da venda se decide antes dela (§9) |
| Perfis de acesso | **Administrador** (Admin da Mostraí, atrás do Cloudflare Access) e **Operador de check-in** (só check-in). Comprador e Participante chegam com a página pública |
| Por que agora | O dono quer a fundação pronta para as próximas etapas (checkout público, check-in) |
| Como saber que deu certo | **D1 — proposta, aguarda o dono** (`../pendencias.md`) |
| Fora da v1 | §8 |

## 3. Um projeto ou vários (Fase 0.5)

Trimundi e Mostraí não dividem usuário, dado nem motivo: são **dois
projetos**. A Trimundi em si é um só (catálogo, venda, emissão e acesso
servem ao mesmo dado e ao mesmo motivo). Por isso ela tem documentos e
banco próprios, mesmo morando na mesma aplicação.

## 4. Classificação (Fase 1)

- **Porte:** produto externo, com cliente pagante (venda a consumidor a
  partir da fase do checkout).
- **Dado:** financeiro, documento (CPF) e senha (operador).
- **Vida útil:** anos (plataforma de várias edições). Cada edição tem data
  de morte; o destino do dado de quem participou é a política de retenção
  (D2, `../inventario-de-dados.md`).
- **Tipo:** SaaS/painel com login (Admin e área do operador); depois
  e-commerce (página pública) e PWA (check-in).

→ **Rigor no topo da escala.** Nenhuma lei dispensada.

## 5. Validação técnica (Fase 2)

**Depende de:**
- **San Checkout** (estrutura), contrato v2. O `API.md` foi lido em
  09/11/2026, no commit `836fdee` de `sancompany/san_checkout`.
- **Aplicação da Mostraí:** Admin, login, sessão, limitador de tentativas e
  hash de senha. Consumidos por chamada entre módulos, com contrato em
  `../api.md`.

**Onde roda:**

| Opção | Ganha | Custa |
|---|---|---|
| 1. **No serviço `mostrai` do Northflank — escolhida pelo dono** | zero infraestrutura nova, um deploy só | divide processo e deploy com a Mostraí: um pico de venda afeta a Mostraí, e publicar um publica o outro |
| 2. Segundo serviço no Northflank, do mesmo repositório | o pico de venda não derruba a Mostraí; continua um repositório | ~US$ 12/mês por serviço do tamanho atual e um deploy a mais |
| 3. Repositório e serviço próprios | isolamento total; entrega independente | duplicar Admin, login e integração; dois projetos para manter |

Recomendação para antes da venda pública: opção 2 (§9).

**Banco:**

| Opção | Situação |
|---|---|
| a. **Projeto Supabase próprio, em sa-east-1 — escolhida (é a lei)** | o plano gratuito da organização já tem os 2 projetos ativos que permite (San_Checkout e MostrAi); o terceiro pede plano pago ou outra organização. Custo só na ida ao ar |
| b. Tabelas no banco da Mostraí | proibida pela política de isolamento ("sem exceção", skill `classificar`) |
| c. Postgres de outro provedor na mesma região | possível, sem vantagem sobre a opção a |

**Stack:** a da aplicação que hospeda — Node 22, Express, SQL cru, Postgres,
HTML e JS sem build, CSP estrita. É a que já roda aqui; outra stack no mesmo
processo seriam dois sistemas.

**Quem mexe no código:** vários agentes (Claude Code, Codex, Jules), com a
memória comum em `AGENTS.md` e `.ia/`.

## 6. Fronteiras (Estação 2)

### Os quatro testes

| Teste | Resposta |
|---|---|
| Desligamento | se a Trimundi parar, nenhum outro projeto para → não é estrutura |
| Público | tem público próprio (organizador, compradores, portaria) → projeto |
| Entrega | se a Mostraí fosse entregue amanhã, a Trimundi não iria junto → projeto |
| Pedido de mudança | só a Trimundi pede → projeto |

Os quatro concordam: **projeto**, com banco próprio.

### Estrutura que a Trimundi consome (consumir, não reconstruir)

| Capacidade | Como | Estado |
|---|---|---|
| Pagamento | San Checkout como **contratante próprio** (`contratante_id`, chave, URL base e webhook só dela), cadastrado à mão por quem administra o Checkout | pendente (fase do checkout) |
| Porta do Admin | Cloudflare Access em `/admin`, já aplicado; as rotas `/admin/trimundi/*` herdam | vigente |
| Domínio | `mostrai.sancocore.com.br/ticket/...` — o dono decidiu não criar domínio nem subdomínio | vigente |
| E-mail | alias próprio no Google Workspace (um por projeto) | pendente (dono) |
| Banco e armazenamento de imagens | projeto Supabase próprio, sa-east-1 | pendente (dono; custo) |
| Hospedagem | serviço `mostrai` no Northflank, southamerica-east (§5, opção 1) | vigente |
| Nota fiscal | pela Asaas; quem emite em nome de quem é decisão aberta desde o Blueprint (pergunta 29) | pendente (dono) |

### Números medidos em 09/11/2026

- **Serviço:** `nf-compute-50` (0,5 vCPU, 1 GB) com 2 instâncias. Em 7 dias,
  memória estável em ~13,6 % (≈140 MB) e CPU abaixo de 1 %.
- **Banco da Mostraí:** 18 MB, 13 de 60 conexões.
- **Região:** Northflank southamerica-east e Supabase sa-east-1. O banco da
  Trimundi nasce em sa-east-1 (regra de região: aplicação e banco juntos).

## 7. Decisões

### Do dono (09/11/2026) — valem como lei

- **D-01** Módulo independente dentro da aplicação da Mostraí. No menu do
  Admin, um item só, **Eventos**, com cinco funções: Criar evento, Criar
  ingressos, Criar promoção, Participantes (com "+ Emitir cortesia") e
  Adicionar operador. Nada da Trimundi solto no menu principal.
- **D-02** Identidade visual, componentes e padrões de interface da
  Mostraí.
- **D-03** Rota pública `/ticket/:evento/:edicao`, no domínio atual.
- **D-04** Evento e Edição são entidades distintas no banco, cadastradas
  juntas na tela.
- **D-05** O operador usa a tela de login existente da Mostraí e,
  autenticado, vai direto para `/ticket/checkin` pela permissão de operador,
  sem passar pelo Admin. Um e-mail que já é conta da Mostraí não pode ser
  operador; o Admin avisa no cadastro.
- **D-06** Banco próprio para a Trimundi (lei `classificar`), com o custo
  assumido só na ida ao ar.
- **D-07** O combo consome a capacidade da edição, mas não o lote nem o
  limite por comprador do tipo de ingresso; tem quantidade própria.
- **D-08** As 12 regras de funcionamento são obrigatórias (regras duras em
  `../CONSTRAINTS.md`).
- **D-09** A página de check-in, quando for construída, ganha um link de
  indicação (`../proximas-versoes.md`).
- **D-10** Proteção da Mostraí: branch isolada, nenhuma migration em
  produção, nenhum deploy, reinício ou operação destrutiva sem autorização.

### Do Blueprint v2 — fechadas lá, valem aqui

- Reserva de 30 min. Disponibilidade = pagos + reservas vivas. Capacidade
  da edição como trava rígida. A cota não paga de lote encerrado rola para o
  lote seguinte (decisão 3).
- `expiraEm` de 24 h como teto do pedido (decisão 30).
- Cortesia conta na capacidade, não no lote (decisão 24).
- QR assinado, pronto para check-in offline (decisão 7).
- Boleto fora (decisão 8). O `expiraEm` já desliga o boleto (API.md §4.1.2).
- Dinheiro em centavos inteiros; identificador público aleatório, nunca
  sequencial; itens do pedido em tabela, nunca em JSON (§20 do Blueprint).

### Do Blueprint — superadas por esta arquitetura

- **Login do Supabase e perfis (decisão 1) e RLS com políticas para o
  navegador (decisão 2):** aqui tudo passa pelo servidor, como na Mostraí,
  e o RLS fica ligado e fechado.
- **Render (decisão 4):** descontinuado no ecossistema; a hospedagem é o
  Northflank.

### Escolhas de engenharia desta etapa (P) — o dono pode trocar; custo baixo agora

- **P-01** Ativação do operador por código mostrado uma vez no Admin (72 h,
  uso único), não por e-mail: a Trimundi ainda não tem alias de e-mail.
- **P-02** Preço mínimo de R$ 5,00 por lote e por combo: é o piso da Asaas
  por cobrança (API.md §9.1).
- **P-03** O endereço público (slug) trava depois de publicado: link já
  distribuído não quebra.
- **P-04** O ingresso de combo leva os benefícios do tipo de ingresso mais o
  benefício promocional da posição.
- **P-05** Cortesia emitida por engano pode ser cancelada (com motivo), e o
  QR deixa de valer.
- **P-06** Reserva serializada por edição (uma trava por edição): correto e
  simples nesta escala; medir antes da venda pública.

## 8. Fora desta versão

- **Adiado** (o dono quer depois) → `../proximas-versoes.md`:
  - página pública de compra e o checkout;
  - tela e aplicativo de check-in, com o link de indicação;
  - envio do ingresso por e-mail;
  - painéis e relatórios;
  - cupons de desconto;
  - múltiplos organizadores;
  - repasse automático;
  - automações de marketing;
  - integrações externas.
- **Do Blueprint, fora desta versão** (continua só lá): promoters,
  empresas, times e comissão; indique um amigo; votação e sorteios;
  transferência de ingresso; reembolso pedido pelo comprador; filiais.
  Entrar com qualquer um deles exige spec novo.
- **Vetado** → `../CONSTRAINTS.md`.

## 9. Contrapontos (Fase 3)

- **Necessidade:** a decisão de ter plataforma própria é do dono e anterior
  a este spec. A fundação existe para não refazer o modelo de dados
  depois.
- **Manutenção:** dois projetos no mesmo repositório pedem disciplina de
  fronteira — prefixo `trimundi`, banco próprio, documentos próprios. A
  memória entre agentes fica em `.ia/`.
- **Escala:** nesta versão não há venda pública. O risco real é o passo
  seguinte. O processo da Mostraí tem 0,5 vCPU e 1 GB, e cada hash de senha
  usa ~128 MiB; um pico de venda nele pode derrubar os dois projetos, que
  dividem serviço e deploy (ponto único de falha). Decidir pelo serviço
  próprio (§5, opção 2) antes da venda pública.
- **Segurança:** o pior dado exposto num vazamento seria nome, CPF e e-mail
  de participantes e compradores, mais a chave do contratante no Checkout
  (com ela se estorna e se forja aviso). Ingresso tem valor de revenda,
  então há motivo para atacar (QR falso, reuso): por isso QR assinado e uso
  único no check-in.
- **Sobreposição:** login, Admin, limitador, hash de senha e a integração
  com o Checkout já existem na Mostraí. São reaproveitados como código, sem
  misturar dado.
- **Prazo:** nenhuma data imóvel informada para esta fase. A primeira
  edição (o exemplo do pedido é `TREEMUNDO/EDITION01`) não tem data nesta
  conversa. Quando tiver, a versão reduzida que ainda entrega o essencial é
  cortesias + check-in, sem venda online.

**Veredito:** sobrevive, reduzida à fundação: o Admin com cinco funções e o
modelo de dados com as regras. Antes da venda pública, três decisões do dono
não podem faltar: serviço próprio ou não, projeto Supabase e nota fiscal.

## 10. Autorrevisão (Fase 3.5)

Revisado em 09/11/2026:
- não há placeholder além de D1 e D2, que estão com o dono e com proposta
  em `../pendencias.md`;
- o "não construir agora" do pedido está fora da v1 nos três documentos;
- nenhuma regra de negócio entrou sem marca: as escolhas P estão listadas
  acima para o dono.

## 11. Roteiro desta versão

| Etapa | Entrega |
|---|---|
| 0 | este spec e os documentos |
| 1 | banco próprio |
| 2 | evento e edição |
| 3 | ingressos e lotes |
| 4 | promoções |
| 5 | pedido de teste, confirmação e emissão |
| 6 | participantes e cortesias |
| 7 | operadores e login |
| 8 | revisão, teste no navegador e PR |

O andamento fica em `../pendencias.md`.
