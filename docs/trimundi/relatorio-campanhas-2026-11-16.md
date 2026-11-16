# Relatório final consolidado — PRs #150 a #156 (TREEMUNDO/TICK, 16/11/2026)

## 0. Publicação técnica — 16/11/2026 (autorizada pelo dono)

O dono autorizou o merge na ordem #150 → #156, as migrations 013–019 em
produção e o deploy. **Ativação e divulgação de campanha continuam
proibidas sem a revisão jurídica (C7):**
- nenhuma campanha foi criada nem ativada em produção;
- a página de venda mostra 0 campanhas;
- o desconto e a vitrine exigem a marca de revisão.

**Antes do primeiro merge:**
- **Backup:** job `Backup` do Northflank às 10:40 UTC,
  `/backups/mostrai-20261116-104027.sql.gz` (140 KB, marcador de dump
  completo).
- **Integridade e restauração:** o arquivo foi baixado, passou no
  `gzip -t` e foi restaurado num Postgres isolado. As contagens bateram com
  produção: 4 pedidos, 1 ingresso, 7 operadores, 1 edição, 1 cliente, 117
  migrations da Mostraí e 12 da TICK.
- **Ensaio das migrations:** a cópia restaurada recebeu as migrations
  013–019, uma a uma, sem erro e sem mudar nenhuma contagem, com RLS em
  todas as tabelas. A cópia e o arquivo baixado foram apagados (dado
  pessoal).
- **Produção antes da publicação:** rodando a `main` (`ecb40da`), saudável,
  TREEMUNDO publicada com 7 tipos à venda.

**Como foi publicado:** push na `main` é deploy (Northflank). As migrations
da TICK rodam no arranque do contêiner. Cada PR foi um deploy próprio, com a
mesma sequência:
1. trazer a `main` atualizada para o PR;
2. esperar o CI verde contra a `main` e a revisão do Codex;
3. fazer o merge (squash);
4. esperar o deploy publicar o commit;
5. conferir `/health`, as páginas principais, a vitrine e as migrations e
   contagens no banco.

| PR | Commit na `main` | Deploy concluído (UTC) | Migration aplicada (UTC) | CI do PR |
|---|---|---|---|---|
| #150 Portaria | `c16fe84` | 10:55 | 013 às 10:55:02 | verde |
| #151 Lotes | `cafbc71` | 11:13 | 014 às 11:12:12 | verde |
| #152 Admin | `3b2fcce` | 11:27 | — | verde |
| #153 Campanhas 1/4 | `2d620e6` | 11:34 | 015 e 016 às 11:33:49 | verde |
| #154 Campanhas 2/4 | `2173823` | 11:41 | 017 às 11:40:54 | verde |
| #155 Campanhas 3/4 | `b36e429` | 11:48 | — | verde |
| #156 Campanhas 4/4 | este PR | depois deste relatório (horário no relatório entregue ao dono) | 018 e 019 | — |

**Depois de cada deploy:** dados intactos (4 pedidos, 1 ingresso),
`/health` `ok:true` e TREEMUNDO vendendo os 7 tipos.

**Conflitos na pilha:** cada PR já continha o anterior, então os conflitos
(documentação e as mesmas funções) foram resolvidos ficando com a versão do
PR mais novo. A correção feita direto na `main` (Recompensas, #152) foi
reaplicada no modelo novo de campanhas. A árvore final de cada PR foi
conferida contra a já testada.

**Revisão automática do Codex** (rodou ao tirar os PRs do rascunho): 6
apontamentos P2. Todos foram conferidos no código, todos procediam e todos
foram corrigidos com teste:

| Onde | Apontamento | Correção |
|---|---|---|
| #151 | Painel de lotes contava pedido de teste | Fora das métricas (RN-T19); o estoque continua real |
| #151 | A atualização automática do painel parava depois de uma falha | Reagenda sempre; conferido no navegador com relógio simulado |
| #152 | Totais de Recompensas saíam da lista cortada em 1.000 | Contagem à parte e aviso de lista cortada |
| #154 | CSV de posições cortado em 2.000 | Consulta própria, sem limite |
| #154 | Edição de campanha em uso dava 409 falso | Campo com valor igual não conta como mudança; a tela não envia campo travado |
| #154 | Estado lido antes da trava podia furar o C7 | Usa a linha travada; desconto exige a marca de revisão |

Os do #151 e do #154 entraram no #156. O do #152 entrou no próprio #152.

**Testes em produção sem efeito colateral** (nenhum dado criado):
- **Páginas:** `/`, `/tic/eventos`, venda da TREEMUNDO, conta, entrar,
  termos e privacidade respondem 200. A portaria redireciona para o login.
- **Admin:** atrás do Cloudflare Access (302).
- **Rotas protegidas:**
  - login inválido de conta e de portaria → 401;
  - webhook sem assinatura → 401;
  - rota do Checkout sem chave → 401;
  - criar pedido sem conta → 401;
  - check-in sem operador → 401.
- **Cotação:** 2 × Pagonejo = R$ 50,00, e o preço mandado pelo navegador é
  ignorado.
- **Vitrine:** 7 tipos à venda, 0 campanhas, 0 promoções.

**Compra real de ponta a ponta:**
- **Já existe em produção:** pedido pago por **Pix** em 11/11 (R$ 25,00).
  - aviso do Checkout recebido;
  - ingresso emitido;
  - e-mail `pedido_confirmado` enviado.
- **Ainda não foi feito o check-in desse ingresso.** Uma compra nova com
  cartão, o check-in na portaria (Android e iPhone) e um reembolso exigem
  dinheiro real e um operador: **só o dono pode fazer** (pendências,
  seção 4).

**Configuração real conferida** (só nomes de variáveis e contagens, nenhum
valor lido):
- **San Checkout:** contratante e variáveis configurados e funcionando.
- **E-mail (SMTP):** funcionando.
- **Storage:** funcionando (banner servido pelo Supabase).
- **E-mail de contato próprio da TICK:** não configurado. Os documentos usam
  o contato da Mostraí.

## Situação antes da publicação (revisão de 16/11)

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

## 4. O que depende do dono (atualizado depois da publicação)

Nenhum dado cadastral, fiscal ou jurídico foi inventado. Cada item diz
exatamente o que falta e onde entra.

**Para publicar e divulgar campanhas:**
1. **Revisão jurídica (C7/P6)** do regulamento de cada campanha.
   - **Como:** o Admin escreve o regulamento → "Regulamento revisado" com o
     nome de quem revisou → "Ativar".
   - Sem essa marca, a campanha não ativa, não aparece na vitrine e o
     desconto não é aplicado.

**Para a operação real** (de `pendencias.md`):

2. **Teste real que falta:**
   - check-in na portaria, num Android e num iPhone, do ingresso já pago (ou
     de uma compra nova);
   - uma compra com cartão;
   - a entrega de um benefício;
   - um reembolso.
   - Eu confiro depois, pelo banco e pelos logs, o pagamento, a emissão e a
     validação.
3. **Endereço completo da operadora** (Decreto 7.962/2013).
   - **Onde entra:** nos Termos e na Política. Hoje dizem só "com sede em
     Matão-SP".
   - **Como:** o texto novo é uma versão nova (v1.4), que pede aceite de
     novo.
4. **Nome no San Checkout:** conferir no painel do Checkout que a página de
   pagamento mostra o MEI (nome empresarial e CNPJ) do cadastro do
   contratante.
5. **Remetente dos e-mails:** conferir o nome em `MOSTRAI_EMAIL_FROM` (ou
   criar `TRIMUNDI_EMAIL_FROM`) no Northflank. Eu não li o valor.
6. **E-mail de contato próprio da TICK** (`TRIMUNDI_EMAIL_CONTATO`): hoje
   vale o da Mostraí.
7. **Quem organiza cada evento:** decidir se entra um campo na ficha do
   evento (nome e CNPJ/CPF da produtora). Não foi criado sem pedido.
8. **Advogado:**
   - revisar a v1.3 (Termos e Política) e as afirmações da Política;
   - definir o prazo de guarda dos aceites.
9. **Nota fiscal do ingresso:** quem emite e em nome de quem.
10. **Repasse financeiro:** sem `wallet_id`, o repasse ao organizador é
    manual.

**Fora desta fase:**
- promotores e comissão;
- os 15 relatórios do §8;
- after-fest e sorteios.
