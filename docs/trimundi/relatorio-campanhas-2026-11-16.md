# Relatório final consolidado — PRs #150 a #156 (TREEMUNDO/TICK, 16/11/2026)

**Situação:** os 7 PRs estão em rascunho e empilhados (cada um usa o anterior
como base).

**Não autorizado, e nada disso foi feito:**
- merge de qualquer PR;
- migrations em produção;
- deploy ou publicação;
- ativação de campanha pública.

As decisões P1–P7 foram **aprovadas pelo dono em 16/11/2026** e estão
registradas em `decisoes-comerciais-2026-11-14.md`.

| PR | Assunto | Base | Migrations | Regressão (banco limpo, mesmo comando do CI) |
|---|---|---|---|---|
| [#150](https://github.com/sancompany/MostrAi/pull/150) | Portaria §6 | `main` | 013 | 1283/1283 + **CI verde** |
| [#151](https://github.com/sancompany/MostrAi/pull/151) | Desempenho de lotes §7 | #150 | 014 | 1287/1287 |
| [#152](https://github.com/sancompany/MostrAi/pull/152) | Admin reorganizado §9 | #151 | — | 1290/1290 |
| [#153](https://github.com/sancompany/MostrAi/pull/153) | Campanhas 1/4 — banco e motor | #152 | 015, 016 | 1306/1306 |
| [#154](https://github.com/sancompany/MostrAi/pull/154) | Campanhas 2/4 — Admin → Campanhas | #153 | 017 | 1314/1314 |
| [#155](https://github.com/sancompany/MostrAi/pull/155) | Campanhas 3/4 — Portaria e Minha Conta | #154 | — | 1319/1319 |
| [#156](https://github.com/sancompany/MostrAi/pull/156) | Campanhas 4/4 — venda, desconto, relâmpago, P2/P5 | #155 | 018, 019 | **1341/1341** |

O CI do repositório só roda em PR contra `main`, por isso só o #150 tem CI.
Os outros foram validados com o mesmo `npm run check`, em banco recém-criado
e com as migrations do zero. A `main` não mudou desde a abertura da pilha:
nenhum PR tem conflito.

---

## 1. Revisão consolidada

### 1.1 Dependências e ordem das migrations

- **Ordem de aplicação:**
  - as migrations rodam no boot, em ordem de nome;
  - cada arquivo roda numa transação própria: falhou, nada dele fica;
  - uma trava (`pg_advisory_lock`) impede duas instâncias de migrar ao
    mesmo tempo;
  - a conexão confere que está no esquema `trimundi` antes de aplicar.
- **Sequência:** 013 → 014 → 015 → 016 → 017 → 018 → 019. A numeração
  segue a ordem dos PRs; nenhum PR depende de migration de um PR posterior.
- **Todas são não destrutivas** (só acrescentam), com a reversão escrita no
  cabeçalho do arquivo:

| Migration | O que faz |
|---|---|
| 013 | Coluna nula `pulseira` |
| 014 | Configuração dos alertas de lote |
| 015 | Tabelas de campanhas, gatilhos de imutabilidade, índices únicos |
| 016 | Copia as campanhas de indicação antigas com os mesmos ids; as tabelas antigas ficam intactas |
| 017 | Amplia `modalidade` e acrescenta as colunas do desconto |
| 018 | Colunas opcionais no item e na vaga do pedido |
| 019 | Duas tabelas novas, imutáveis: `campanha_disputas` e `pedidos_sem_vaga` |

- **Conferência em produção** (só leitura, só contagens, sem dado pessoal,
  16/11):
  - aplicadas até a **012**;
  - **0** campanhas de indicação antigas, 0 indicações, 0 recompensas;
  - 4 pedidos, 1 ingresso, 7 operadores, 1 edição, nenhum "pago sem vaga".
  - Conclusão: as regras novas (R1, faixas, coerência) não esbarram em
    nenhum dado existente, e a 016 não tem nada a copiar.
- **Atenção para o merge, porque os PRs estão empilhados:**
  - mergear na ordem, #150 → #156;
  - com *squash*, cada PR seguinte precisa receber a `main` atualizada antes
    do próprio merge. O conteúdo é o mesmo, então não deve haver conflito,
    mas o CI passa a rodar nele contra `main`;
  - faço isso quando for autorizado.

### 1.2 Integridade dos dados

**Garantias pelo banco** (não dependem do código):
- **Posição:** imutável e única por campanha e ingresso.
- **Prêmio:**
  - único por chave;
  - "exclusivo de pé" é único por ingresso;
  - prêmio entregue é final;
  - o histórico de prêmios é só acréscimo.
- **Contador de posições:** só cresce. Campanha encerrada não reabre.
- **Faixas:** sem sobreposição; níveis crescentes.
- **Desconto:** item com desconto exige preço cheio maior e lote, nunca
  combo.
- **Novos (019):** as disputas e o motivo do "pago sem vaga" também são
  imutáveis.

**Idempotência:**
- aviso de pagamento único por `evento_id`;
- ingresso único por vaga;
- reprocessar o pagamento não muda posição, prêmio, unidade promocional nem
  fila.

**Histórico:**
- Toda ação do Admin grava auditoria.
- **P2:**
  - "qual venceu e qual deixou de conceder" está em `campanha_disputas`
    (promoção × promoção) e em `campanha_posicoes`
    (`nao_acumulavel` + vencedora: promoção × brinde);
  - o detalhe da promoção no Admin mostra as duas coisas.

**Dados pessoais:**
- a vitrine, o CSV, a fila e a portaria não expõem CPF nem e-mail;
- a portaria mostra o nome do comprador (aprovado em 15/11).

### 1.3 Segurança dos descontos e pagamentos

- **Preço calculado só no servidor**, sob a trava da edição. O que o
  navegador mandar como preço, total ou campanha é ignorado (há teste).
- **Confirmação do pagamento:** continua exigindo valor recebido igual ao
  total do pedido; se diferir, vira aviso "valor divergente". O contrato com
  o San Checkout não mudou: ele recebe o preço unitário já com desconto.
- **Preço com desconto:**
  - nunca abaixo de R$ 5,00 (P3) nem igual ou acima do preço do lote;
  - se o lote mudar de preço depois, a promoção que não baixaria o preço
    deixa de valer.
- **Arredondamento (P4):** um número só, calculado uma vez, gravado igual na
  vaga, no item e no ingresso.
- **Combo** nunca recebe promoção de preço. A validação de 2 a 20 ingressos
  por combo continua.
- **Admin:** todas as rotas novas ficam atrás da proteção do Admin (Access e
  sessão). A tela usa só texto puro (`textContent` e `esc`) para o que o
  Admin escreve.
- **Pedido de teste** (só fora de produção) também recebe desconto, para
  conferir o fluxo inteiro.

### 1.4 Concorrência e estoque

Testes de verdade, com até 12 conexões ao mesmo tempo:

| Cenário | Resultado |
|---|---|
| 12 compras simultâneas, quantidade promocional 5 | exatamente 5 com desconto |
| Pagamentos simultâneos | não mudam a conta |
| 12 pagamentos simultâneos, brinde com estoque 5 | posições 1..12 sem buraco, 5 prêmios |
| Duas ativações simultâneas de indicação não acumulável | uma passa (R1) |
| Três portarias entregando o mesmo brinde | uma entrega |
| Aviso reprocessado 3×, sendo 2 ao mesmo tempo | nada muda |
| Compra que atravessa dois lotes | a mesma quantidade promocional vale nos dois, sem passar do limite |

- **Ordem das travas, sempre a mesma:** edição → pedido → campanhas, por id.
  Pausar ou encerrar no meio de uma confirmação espera ela terminar.
- **Risco a acompanhar depois do lançamento:**
  - a vitrine faz algumas consultas a mais por visita;
  - a criação do pedido também (as promoções vigentes);
  - com pool de 1 conexão por instância isso cabe, mas vale medir no
    primeiro pico (já estava em `pendencias.md`: "medir pedidos por
    segundo").

### 1.5 Reembolsos e conciliação

- **Reembolso de ingresso com desconto:** devolve o preço pago, não o cheio
  (há teste).
- **Unidade promocional:** não volta (P1). O limite por pessoa volta (P7).
- **Posição de primeiros N:** fica fixa e o prêmio não passa adiante (regra
  1).
- **Prêmio entregue e depois reembolsado:** fica, com alerta.
- **Pago sem vaga (P5, condição atendida):**
  - **o que acontece:** nenhum ingresso é emitido e nada sai do estoque nem
    da quantidade promocional;
  - **fila no Admin** → Participantes → "Pagos sem vaga", com:
    - pedido, comprador, valor recebido (e o do pedido, se diferente) e
      campanha;
    - **motivo**: lote, capacidade, promoção encerrada ou promoção sem
      quantidade;
    - **situação da conciliação**: a devolver, devolução pedida, reenviar,
      recusada, devolvido;
    - **histórico**: recebido, anotações, devolução pedida, confirmada ou
      recusada, com autor e hora;
  - **o que o Admin faz:** "Abrir pedido" → "Reembolsar pedido" (fluxo de
    sempre, com chave de idempotência) e "Anotar";
  - pedidos "pago sem vaga" anteriores à 019 aparecem com "motivo não
    registrado". Em produção, hoje, são 0.

### 1.6 Celular e computador

Roteiros de navegador (Playwright) em claro e escuro, computador (1280) e
celular (390), na pilha completa:

| Área | Verificações |
|---|---|
| Portaria | 112 ok |
| Lotes | 18 ok |
| Admin (áreas do §9) | 30 ok |
| Admin → Campanhas | 28 ok |
| Minha Conta + portaria com brinde | 44 ok |
| Página de venda + compra pela tela | 56 ok |
| Fila "Pagos sem vaga" + detalhe da promoção | 36 ok |

Em todas, as mesmas conferências:
- sem rolagem lateral;
- sem erro de JavaScript;
- botões de ação visíveis no celular (na primeira coluna das tabelas
  roláveis).

**Total:** 324 verificações, 0 falhas. O roteiro de Campanhas (PR 2) foi
atualizado:
- antes conferia que a promoção de preço **não** tinha o botão "Ativar";
  agora confere que ela ativa e pausa pela tela;
- com ela ativa e não acumulável, as compras deixavam de ganhar o brinde
  (P2 funcionando).

### 1.7 Ausência de regressões

- **Pilha completa (#156): **1341/1341**** com lint, em banco limpo. Cada
  PR intermediário também passou na própria regressão (tabela no topo).
- **Funcionalidades que continuam iguais:**
  - os 7 operadores ficam só com a portaria;
  - indicação "a cada N" pelas rotas antigas;
  - benefício de lote;
  - combos;
  - check-in sem internet;
  - limite por CPF;
  - pedido aberto por conta;
  - LGPD do titular;
  - pedido sem promoção, idêntico ao de antes (há teste).
- **Achado desta revisão, já corrigido:** as duas tabelas novas da 019
  tinham ficado sem RLS. O teste de fundação do esquema (toda tabela do
  `trimundi` com RLS) pegou o erro na regressão completa; a 019 foi
  corrigida antes de qualquer aplicação.
- **Erros plantados de propósito nos pontos críticos:** os testes pegaram
  todos. A única que escapou de início (gasto da quantidade entre lotes)
  ganhou teste próprio.

---

## 2. Cenários de teste executados

| Cenário | Onde | Resultado |
|---|---|---|
| Concorrência: 12 compras, quantidade 5 → 5 com desconto | `trimundi-campanhas-venda` | passou |
| Esgotamento simultâneo de brinde (12 pagamentos, estoque 5) | `trimundi-campanhas` | passou |
| Esgotamento no meio da compra e entre lotes | `trimundi-campanhas-venda` | passou |
| Descontos: percentual (P4), valor, preço; piso (P3); lote que mudou de preço | `-venda`, `-admin` | passou |
| Preço do navegador ignorado; Checkout com o preço do servidor | `-venda` | passou |
| Reembolso total e parcial com desconto; P1; P7 | `-venda`, `trimundi-campanhas` | passou |
| Pagamento atrasado (P5): sem quantidade, encerrada, lote → fila com motivo; com quantidade → vale | `-venda` | passou |
| Fila P5: anotação, devolução pedida, devolvido; histórico; sem CPF; 404 fora da fila | `-venda` | passou |
| Campanhas simultâneas: dois descontos (P2) com histórico; desconto × brinde | `-venda`, `trimundi-campanhas` | passou |
| Webhooks atrasados e reprocessados (R2) | `trimundi-campanhas`, `-venda` | passou |
| Pausa e encerramento (C6); reserva viva mantém o preço | `trimundi-campanhas`, `-venda` | passou |
| Níveis de indicação (C2), regressão, indicações simultâneas | `trimundi-campanhas` | passou |
| Portaria: entrega única concorrente, expirado, só Admin | `trimundi-campanhas-conta`, `trimundi-portaria` | passou |

---

## 3. O que está pronto

| Item | Situação |
|---|---|
| Portaria §6 | pronto |
| Lotes §7 | pronto |
| Admin §9 | pronto |
| Campanhas de ordem de compra (primeiros N) e de indicação (níveis, "a cada N"), com C1–C7 e R1–R3 | pronto |
| Admin → Campanhas: cadastro, edição, pausar, retomar, encerrar, duplicar, detalhe, CSV, travas de justiça, aviso C5 | pronto |
| Portaria e Minha Conta com campanhas | pronto |
| Promoção de preço em ingresso individual e relâmpago, aplicada no pedido, com P1–P7 | pronto |
| Página de venda: selo, preço riscado, %, restam, prazo, esgotada/encerrada, brindes | pronto |
| Histórico das disputas (P2) e fila "Pagos sem vaga" (P5) | pronto |

## 4. O que depende do dono

**Para publicar campanhas:**
1. **Revisão jurídica (C7/P6)** de cada regulamento. Quem marca a revisão é
   o Admin, com o nome de quem revisou. Sem ela, a campanha não ativa e não
   aparece na página de venda.

**Para lançar (itens já abertos em `pendencias.md`):**

2. Contratante da TICK no San Checkout e variáveis de produção (Northflank).
3. E-mail em produção e storage.
4. Teste real de ponta a ponta. Depois do deploy, inclui uma compra com
   promoção de preço.
5. Endereço completo da operadora, nome no San Checkout, remetente dos
   e-mails e quem organiza cada evento.
6. Advogado:
   - revisão da v1.3 dos documentos legais e das afirmações da Política;
   - prazo de guarda dos aceites.
7. Nota fiscal do ingresso e repasse financeiro. E-mail de contato próprio.

**Para autorizar, quando quiser:**

8. O merge, na ordem #150 → #156.
9. As migrations 013–019 em produção, com backup antes (RUNBOOK).
10. O deploy.

**Fora desta fase** (aprovado, mas não construído):
- promotores e comissão (regras 4–9). Antes de pagamento real: requisitos de
  dados pessoais, privacidade e documentação fiscal (decisão C);
- os 15 relatórios do §8;
- after-fest e sorteios (K, depois da revisão jurídica).
