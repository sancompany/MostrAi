# Relatório consolidado — fase de Campanhas e evolução TREEMUNDO/TICK (16/11/2026)

Dono: decide merge, deploy e publicação. **Nada aqui foi mergeado, publicado
ou aplicado em produção.** Todos os PRs estão em rascunho, empilhados: cada
um usa como base o anterior.

| PR | Branch (sufixo de `claude/beautiful-faraday-cjq1nt-`) | Base | Migration | Regressão local (banco limpo) |
|---|---|---|---|---|
| [#150](https://github.com/sancompany/MostrAi/pull/150) Portaria §6 | `portaria` | `main` | — | 1283/1283 (+ CI verde) |
| [#151](https://github.com/sancompany/MostrAi/pull/151) Desempenho de lotes §7 | `lotes` | #150 | 014 | 1287/1287 |
| [#152](https://github.com/sancompany/MostrAi/pull/152) Admin reorganizado §9 | `admin` | #151 | — | 1290/1290 |
| [#153](https://github.com/sancompany/MostrAi/pull/153) Campanhas 1/4 — banco e motor | `campanhas-motor` | #152 | 015, 016 | 1306/1306 |
| [#154](https://github.com/sancompany/MostrAi/pull/154) Campanhas 2/4 — Admin → Campanhas | `campanhas-admin` | #153 | 017 | 1314/1314 |
| [#155](https://github.com/sancompany/MostrAi/pull/155) Campanhas 3/4 — Portaria e Minha Conta | `campanhas-conta` | #154 | — | 1319/1319 |
| [#156](https://github.com/sancompany/MostrAi/pull/156) Campanhas 4/4 — venda, desconto e relâmpago | `campanhas-venda` | #155 | 018 | 1337/1337 |

O CI do repositório roda só nos PRs contra `main`. Por isso, só o #150 tem
CI. Os demais foram validados com o mesmo comando do CI (`npm run check`),
em banco recém-criado, migrations do zero.

## 1. Relatório técnico por PR

### #150 — Portaria (§6, RN-T39)
- A leitura do ingresso mostra o titular, o comprador (nome aprovado em
  15/11), o número de indicados e "RECOMPENSAS DE <TITULAR>".
- A entrega acontece uma vez só, mesmo com várias portarias ao mesmo tempo.
- Os 7 operadores existentes continuam só com a portaria.
- **Risco conhecido:** nenhum aberto.

### #151 — Desempenho de lotes (§7, RN-T40)
- Barras geral e por lote, cores e alertas configuráveis.
- A capacidade inclui os lotes encerrados (decisão de 15/11). A sobra de
  lote encerrado não migra.
- Migration 014 (configuração dos alertas).

### #152 — Admin reorganizado (§9, RN-T41)
- Áreas: Visão geral, Eventos, Ingressos, Lotes, Combos, Campanhas,
  Indicações, Recompensas, Participantes e Portaria.
- Os ids antigos das abas foram mantidos.
- A recompensa de operador indicador é entregue só pelo Admin (decisão 3 de
  15/11).

### #153 — Campanhas 1/4: banco e motor (RN-T42)
- **Migrations:**
  - 015: tabelas novas, gatilhos de imutabilidade, índices únicos;
  - 016: cópia das campanhas de indicação antigas, com os mesmos ids. As
    tabelas antigas ficam intactas e sem uso.
- **Posições e janela:** posição por ingresso, sob a trava da edição.
  Instante oficial = aplicação na TICK (R2); a hora do Checkout fica só para
  auditoria.
- **Regras implementadas:** C1, C2, C3, C4, C6, R1 e R3.
- **Prêmios:** idempotentes por chave única. Histórico só de acréscimo.
- **Testes:** os 8 grupos pedidos — ativação concorrente, webhooks atrasados
  e reprocessados, pausa e encerramento, reembolso e nova compra, níveis,
  indicações simultâneas, esgotamento simultâneo e integridade.

### #154 — Campanhas 2/4: Admin → Campanhas (RN-T43)
- **Modalidades:** ordem de compra, indicação e promoção de preço em
  ingresso individual. O relâmpago é um destaque com fim obrigatório. Combo
  promocional leva para Combos, que continua como está.
- **Ações:** pausar, retomar, encerrar e duplicar; detalhe com CSV.
- **Validações:** configuração contraditória é recusada antes de gravar.
  Campanha em uso tem travas de justiça.
- **C5 e C7:** aviso de C5 no benefício de lote. Ativação exige regulamento
  revisado (C7).
- **Migration 017:** modalidade `desconto` e as colunas do desconto.

### #155 — Campanhas 3/4: Portaria e Minha Conta (RN-T44)
- **Portaria:**
  - o brinde de primeiros N aparece no ingresso lido e sai por rota única;
  - a entrega registra data, hora e operador, e não se repete;
  - recompensa de operador continua só pelo Admin.
- **Minha Conta:**
  - mostra níveis, progresso, posições e histórico;
  - mostra só dados da própria conta.

### PR 4 — Campanhas 4/4: venda, desconto no checkout e relâmpago (RN-T45)
- **Onde o desconto é calculado:** no servidor, sob a trava da edição. O
  preço vindo do navegador é ignorado.
- **Gravação:** a vaga e o item guardam a campanha e o preço cheio; o
  ingresso guarda o preço pago.
- **Quantidade promocional:** nunca é ultrapassada, nem com compras
  simultâneas. O reprocessamento do aviso de pagamento não gasta unidade.
- **Regras aplicadas:** P1, P2, P5 e P7 (abaixo).
- **Página de venda:**
  - selo PROMOÇÃO RELÂMPAGO, preço riscado, %, quanto resta e prazo;
  - esgotada ou encerrada aparece sem preço;
  - brindes de primeiros N com quanto resta;
  - só campanha com C7 aparece.
- **Migration 018:** colunas opcionais. Pedido antigo fica igual.

## 2. Cenários de teste (o que foi executado)

| Cenário | Onde | Resultado |
|---|---|---|
| 12 compras simultâneas, quantidade promocional 5 → exatamente 5 com desconto; 12 pagamentos simultâneos não mudam a conta | `trimundi-campanhas-venda` | passou |
| 12 pagamentos simultâneos, brinde com estoque 5 → posições 1..12 sem buraco, 5 prêmios | `trimundi-campanhas` (7) | passou |
| Duas ativações simultâneas de indicação não acumulável → uma passa (R1) | `trimundi-campanhas` (1) | passou |
| Três portarias entregando o mesmo brinde ao mesmo tempo → uma entrega | `trimundi-campanhas-conta` | passou |
| Esgotamento: a promoção acaba no meio da compra → o resto sai pelo preço do lote; a compra atravessa dois lotes sem passar da quantidade | `trimundi-campanhas-venda` | passou |
| Descontos: percentual (meio centavo para cima), valor fixo, preço promocional; piso de R$ 5,00; lote que mudou de preço | `trimundi-campanhas-venda`, `-admin` | passou |
| Navegador manda preço/total/campanha → ignorados; o Checkout recebe o preço do servidor | `trimundi-campanhas-venda` | passou |
| Reembolso: posição fica, prêmio não passa adiante; unidade promocional não volta (P1); a conta volta a poder comprar (P7, R3) | `trimundi-campanhas`, `-venda` | passou |
| Pagamento atrasado (P5): sem quantidade → pago sem vaga; promoção encerrada → pago sem vaga; com quantidade → vale | `trimundi-campanhas-venda` | passou |
| Campanhas simultâneas: dois descontos não somam (vale o menor); desconto não acumulável vence o brinde não acumulável (posição fica); acumulável leva os dois | `trimundi-campanhas-venda`, `trimundi-campanhas` (C1) | passou |
| Webhook reprocessado (3×, 2 ao mesmo tempo) e atrasado | `trimundi-campanhas` (2), `-venda` | passou |
| Pausa e encerramento: pausado não ocupa posição nem dá desconto; reserva viva mantém o preço | `trimundi-campanhas` (3), `-venda` | passou |
| Conferência visual: claro e escuro, computador (1280) e celular (390) — vitrine, compra, Admin, portaria, Minha Conta | roteiros de navegador (Playwright) | sem falha |

Mutações de código foram aplicadas nos pontos críticos para provar que os
testes pegam o erro. No PR 4 foram 4, todas detectadas. A primeira passou
num primeiro momento e gerou o teste da compra que atravessa dois lotes.

## 3. Pendências comerciais e jurídicas

**Bloqueiam a publicação de campanhas:**
- **C7 — revisão jurídica** dos regulamentos de cada campanha antes da
  primeira publicação.
  - O sistema não ativa campanha sem o regulamento marcado como revisado, e
    a página de venda não mostra campanha sem essa marca.
  - Quem marca é o Admin, com o nome de quem revisou.

**Para o dono confirmar (comportamento conservador já implementado):**
- **P1:** a unidade promocional de ingresso reembolsado não volta.
- **P2:** descontos não se somam. Desconto não acumulável vence o brinde
  não acumulável.
- **P3:** piso de R$ 5,00 com desconto.
- **P4:** arredondamento do percentual, meio centavo para cima.
- **P5:** pagamento atrasado só vale com a promoção aberta e com quantidade.
- **P6:** C7 vale para toda campanha nova.
- **P7 (nova):** limite por pessoa do desconto conta pela conta compradora
  e só o que está de pé.
- Detalhes em `decisoes-comerciais-2026-11-14.md`.

**Já registradas antes, ainda abertas** (`pendencias.md`):
- endereço completo da operadora;
- nome no San Checkout;
- remetente dos e-mails;
- quem organiza cada evento;
- revisão da v1.3 dos documentos legais por advogado;
- nota fiscal do ingresso e repasse financeiro;
- e-mail de contato próprio;
- antes de pagamentos reais de comissão, os requisitos de dados pessoais,
  privacidade e documentação fiscal (decisão C de 14/11).

**Fora desta fase:**
- promotores e comissão (regras 4–9 aprovadas, construção não iniciada);
- os 15 relatórios do §8;
- after-fest e sorteios (K: depois da revisão jurídica).

## 4. O que falta para publicar
1. Revisar os 7 PRs e autorizar o merge na ordem (#150 → PR 4). A base de
   cada um é o anterior.
2. Autorizar as migrations 014–018 em produção. Todas são não destrutivas e
   rodam no boot. Fazer backup antes, como diz o RUNBOOK.
3. Revisão jurídica (C7) dos regulamentos das campanhas que forem ao ar.
4. Confirmar ou ajustar P1–P7.
5. Itens "Só o dono faz — obrigatório para lançar" de `pendencias.md`
   (variáveis de produção, contratante no San Checkout, teste real de ponta
   a ponta).
6. Depois do deploy: uma compra real com promoção de preço, conferindo o
   valor no San Checkout e o ingresso emitido.
