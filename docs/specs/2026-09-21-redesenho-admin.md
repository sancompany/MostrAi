# Redesenho do painel administrativo — plano de execução

> **Status: proposto, NÃO autorizado.** Escrito em 21/09/2026 a pedido do dono,
> a partir de um rascunho dele (via GPT) + mapeamento do código real + pesquisa
> de padrões de mercado. Nada foi construído. A autorização de construir é
> dele, item a item ou em bloco.
>
> Este documento substitui o rascunho original como fonte da tarefa: ele corrige
> três premissas erradas daquele rascunho e adiciona quatro riscos que só
> apareceram na leitura do código.

## 1. Problema

O admin tem **25 itens de menu independentes**, um por tabela/função, montados
a partir do array `NAV` (`public/admin/index.page.js:215-266`). O dono precisa
lembrar em qual das 25 páginas cada função mora. Sintomas concretos:

- funções relacionadas espalhadas (ponto, tela e ocupação do ponto são três
  páginas para uma coisa só);
- telas estruturalmente vazias ocupando item próprio no menu;
- tabelas que editam campos demais direto na linha — incluindo operações de
  negócio não triviais (troca de modalidade de comodato) e valores financeiros
  (custo de equipamento, que alimenta a amortização da Visão geral);
- configuração de baixa frequência (categorias, comodato) ao lado de operação
  diária;
- parágrafos de documentação técnica ocupando a interface.

**Alvo: ~25 itens → 12 módulos**, organizados por fluxo operacional, sem perder
nenhuma função.

## 2. Regras desta tarefa (inegociáveis)

**Escopo é frontend, UX e organização.** Não altera: regra de negócio, cálculo,
banco, migration, playlist/player, proof-of-play, San Checkout, integrações.
Não corrige bug técnico já documentado (a não ser onde esta spec disser
explicitamente que a fusão força a decisão — ver §5.2).

**API só muda se for inevitável.** Se a reorganização exigir mudança estrutural
arriscada, **documentar em vez de implementar**.

**Nenhuma funcionalidade some** por parecer pouco usada. Tela vazia é problema
de estado vazio, não de existência.

**Branch, sem deploy, sem merge em `main`.** O dono revisa visualmente antes.

**Fonte da verdade:** infra real > código real > banco real > documentação.
`docs/teia.md` e `docs/furos.md` têm entradas obsoletas conhecidas
(`.ia/RISKS.md:20-24`) — conferir contra o código, sempre.

## 3. Mapa verificado: 25 telas de hoje

Confirmado linha a linha contra `NAV` (`public/admin/index.page.js:215-266`).
A lista do rascunho estava **correta** — 25 itens, sem tela a mais nem a menos.

| Hash | Tela | Render | Edição inline hoje |
|---|---|---|---|
| `#resumo` | Visão geral | `:518` | nenhuma |
| `#metrica` | Métrica | `:2264` | nenhuma |
| `#candidaturas` | Candidaturas | `:1480` | status (select) |
| `#contato` | Mensagens do site | `:2678` | checkbox respondida |
| `#convites` | Convites | `:1599` | nenhuma |
| `#criativos` | Fila de criativos | `:594` | ações só |
| `#meusanuncios` | Meus anúncios | `:676` | upload |
| `#pontos` | Pontos | `:818` | **9 campos/linha** |
| `#ocupacaopontos` | Ocupação dos pontos | `:2884` | ação só |
| `#telas` | Telas | `:1002` | **5 campos/linha** |
| `#anunciantes` | Anunciantes | `:1170` | 3 selects + `prompt()` |
| `#vendedores` | Vendedores | `:1428` | 3 campos/linha |
| `#planos` | Planos | `:1875` | 12 cartões editáveis |
| `#planosarquivados` | Planos arquivados | `:2383` | nenhuma |
| `#beneficios` | Benefícios | `:2429` | 3 campos/linha |
| `#categorias` | Categorias | `:2504` | 2 campos/linha |
| `#comodato` | Opções de comodato | `:2579` | **10 campos/linha** |
| `#cobrancas` | Cobranças | `:2971` | upload de NF |
| `#trocas` | Trocas de plano | `:2736` | nenhuma (leitura) |
| `#bancohoras` | Banco de horas | `:2781` | ação só |
| `#comissoes` | Comissões | `:3037` | ação só |
| `#pagamentospontos` | Pagar os pontos | `:2150` | ação + formulário |
| `#arrependimentos` | Devoluções | `:3111` | campo + ação |
| `#custos` | Custos fixos | `:1705` | 4 campos/linha |
| `#eventos` | Eventos pendentes | `:3183` | ações só |

## 4. Arquitetura alvo: 12 módulos

```
MOSTRAÍ
  Visão geral            ← #resumo + #metrica

OPERAÇÃO
  Rede                   ← #pontos + #telas + #ocupacaopontos + #bancohoras
  Anunciantes            ← #anunciantes (+ detalhe por conta)
  Conteúdo               ← #criativos + #meusanuncios
  Entrada                ← #candidaturas + #convites + #contato

COMERCIAL
  Planos                 ← #planos + #planosarquivados + #beneficios
  Vendedores             ← #vendedores

FINANCEIRO
  Receitas               ← #cobrancas + #trocas + #arrependimentos
  Repasses               ← #comissoes + #pagamentospontos
  Custos                 ← #custos

SISTEMA
  Configurações          ← #categorias + #comodato + #eventos (diagnóstico)
  Pendências             ← nova, agrega filas que já existem
```

**Nenhuma das 25 funções desaparece.** Todas viram aba, detalhe ou seção de
configuração. Detalhamento por módulo:

### 4.1 Visão geral — `[ Hoje ] [ Performance ] [ Financeiro ]`
Absorve a Métrica. **Hoje** responde "o que precisa da minha atenção?" — cada
item leva à ação, nunca a um gráfico (é o antídoto conhecido contra virar
dashboard genérico). **Performance** recebe funil, evolução e filas da Métrica
atual. **Financeiro** recebe receita, margem, custo, pendente. `redeVazia()`
(`:513-516`), que já troca "tudo em dia" por "Rede em montagem", é preservado.

### 4.2 Rede — `[ Pontos ] [ Telas ] [ Ocupação ] [ Entrega ]`
Listagem de pontos enxuta (nome, cidade, status, nº de telas, ocupação,
anunciantes, ação). Tudo o que hoje é editado na linha vai para o **detalhe do
ponto** com sub-abas (Resumo / Telas / Anunciantes / Ocupação / Comodato /
Financeiro / Histórico). **Entrega** = banco de horas, que sai do Financeiro
porque é entrega operacional, não dinheiro.

### 4.3 Anunciantes
Listagem: empresa, plano, status, vencimento, pontos, situação, ações.
Detalhe por conta: Resumo / Plano / Criativos / Pontos / Cobranças / Histórico.
Os `window.prompt()` sequenciais de "Liberar plano" e "Marcar parceiro"
(`:1301-1356`) viram formulário no detalhe — ganho direto de robustez.

### 4.4 Conteúdo — `[ Aprovação ] [ Anúncios próprios ]`
**Aprovação** = fila de criativos de anunciantes pagantes, com chips
Em análise / Aprovados / Reprovados. **Anúncios próprios** = a conta
institucional da Mostraí, apresentada como biblioteca interna. Fluxo e limites
preservados exatamente como estão.

### 4.5 Entrada — `[ Candidaturas ] [ Convites ] [ Mensagens ]`
Badge no módulo quando houver pendência. Mensagens do site entram aqui porque
são canal de entrada — e **o prazo/LGPD continua visível**, também espelhado em
Pendências. Nada de esconder pendência legal atrás de aba.

### 4.6 Planos — `[ Ativos ] [ Arquivados ] [ Benefícios ]`
Representação por **produto**, não por cartão: um tier com seus 4 ciclos
aninhados. **Ver §5.1 — este é o módulo de maior risco da tarefa.**

### 4.7 Vendedores
Listagem simples; ao selecionar, dados / cupom / comissão / indicados /
histórico. Sem backend novo.

### 4.8 Receitas — `[ Transações ] [ Notas fiscais ] [ Trocas ] [ Devoluções ]`
Troca de plano paga é evento financeiro, não merece página própria. Devoluções
mantêm o fluxo atual — **estorno continua acontecendo fora do sistema**, aqui
só se registra o comprovante.

### 4.9 Repasses — `[ Pontos ] [ Vendedores ]`
### 4.10 Custos
Custos fixos + amortização + ajuda de custo, só com dado que já existe.

### 4.11 Configurações — `[ Categorias ] [ Comodato ] [ Diagnóstico ]`
Diagnóstico recebe os Eventos pendentes e o teste de SMTP (`:83-85`), que
**continua disponível**. Sem monitor novo.

### 4.12 Pendências
Agrega filas que já existem em `GET /admin/resumo` (`src/admin/routes.js:91-269`,
11 queries já agregadas). **Nenhum dado novo é inventado.**

## 5. Riscos reais encontrados no código

Estes quatro não estavam no rascunho original. São o motivo pelo qual "só
reorganizar visualmente" não é automaticamente seguro.

### 5.1 `divergenciasPorTier()` só funciona porque os 12 cartões estão juntos — RISCO ALTO

`public/admin/index.page.js:1832-1852` compara se os 4 ciclos do mesmo tier
prometem os mesmos campos de contrato e avisa quando divergem. **Essa checagem
não existe no backend** — `POST /admin/planos/:id/nova-versao` valida a versão
em si, não a coerência entre ciclos.

É o único lugar do sistema que avisa quando "Essencial trimestral" e "Essencial
anual" prometem coisas diferentes. E ela só é possível hoje porque os 12
cartões estão na tela ao mesmo tempo.

A reestruturação "1 produto → vários ciclos" **destrói essa condição** se for
feita ingenuamente. Exigência: o novo módulo Planos precisa de um equivalente
explícito (painel de consistência por tier, ou drawer "ver diferenças") antes
de qualquer cartão ser reagrupado. Sem isso, é regressão funcional disfarçada
de melhoria visual.

### 5.2 Fundir Visão geral + Métrica expõe um bug de cálculo existente — DECISÃO NECESSÁRIA

`src/admin/metrica.js:30` filtra `p.status = 'ativo'`, status que não existe
desde a migration 045 (hoje é `a_instalar`/`em_operacao`). A amortização
histórica da Métrica é **sempre zero**. A Visão geral usa o status certo
(`src/admin/routes.js:134`) e está correta.

Hoje ninguém percebe porque são duas páginas e o custo de equipamento em
produção ainda é 0. **Juntar as duas em abas da mesma página coloca dois
números diferentes para a mesma coisa lado a lado.** Já registrado em
`.ia/RISKS.md:113` e `.ia/TODO.md:163` como conhecido e não corrigido.

Três saídas, e o dono escolhe: (a) corrigir o filtro nesta tarefa, abrindo uma
exceção explícita à regra "não corrige bug"; (b) fundir e deixar divergir,
documentando; (c) não fundir até o bug ser tratado à parte.

### 5.3 Banco de horas está vazio por falta de job, não por falta de dado

A tela é alimentada por apuração mensal (`npm run apurar-banco-horas`) que
**não existe no Northflank** (`.ia/RISKS.md:69-73`, `.ia/TODO.md:93-104`).
Movê-la para Rede → Entrega **não resolve isso** — ela continuará vazia. O
estado vazio precisa dizer a verdade ("a apuração mensal ainda não roda"), não
sugerir que não há déficit.

### 5.4 Quatro fórmulas de negócio duplicadas no frontend

- `horasDeTelaPorMes()` — `src/lib/pacing.js:224-228` (oficial), reescrita em
  `public/admin/index.page.js:198-202` e numa terceira cópia na vitrine.
  Se a premissa de 12h/dia mudar, são 3 lugares.
- `valorComDesconto()` — `:1908-1912` reimplementa
  `src/financeiro/planos-repository.js:10` (só preview; risco baixo).
- `ocupacaoPct` — `:2899` repete `segundos/3600*100`; o bloqueio de 80% é
  sempre decidido no servidor, então risco baixo.
- `divergenciasPorTier()` — §5.1, risco alto.

O redesenho **não deve consertar** essas duplicatas (é mudança de regra), mas
precisa preservá-las com o mesmo comportamento. Quem mover código de tela
precisa saber que essas linhas não são formatação.

### 5.5 Onde a regra de negócio vive hoje é dentro da interface

`SUBTITULOS` (`:268-308`) e os avisos inline de Planos/Anunciantes/Comodato
("o produto é do tier, a oferta é do ciclo", repetido em `:1233`, `:1971`,
`:2587`) são **a única documentação viva** de RN-27, do bloqueio de 80% e da
regra de que banco de horas nunca vira crédito automático.

O pedido de "tirar parágrafo técnico da interface" está certo — mas esses
textos precisam de destino (popover "Como funciona", drawer, accordion), não
de exclusão.

### 5.6 Sem fronteira de módulo pronta

`public/admin/index.page.js` tem **3270 linhas**, 25 funções `render*` lado a
lado compartilhando helpers globais, sem build e sem framework. Não existe
fronteira natural onde cortar. O backend correspondente está em 12 arquivos de
rota organizados por domínio.

Consequência: a fatia 1 tem de ser a navegação e o container, com as telas
atuais rodando por dentro **sem serem reescritas**. Reescrever as 25 de uma vez
é o caminho mais rápido para quebrar algo silenciosamente.

## 6. Premissas do rascunho que o código não confirmou

1. **"Meus anúncios está quebrada, lista só `pendente`."** Falso. Só o default
   da rota é `pendente` (`src/admin/routes.js:16`); a aba pede `?status=todos`
   (`:718`) e o repositório trata (`src/anunciantes/criativos-repository.js:52-56`).
   O bug existiu e foi corrigido em `7b4d173`, 15/09/2026. Esta sessão chegou a
   registrar o contrário em dois documentos — já corrigido.
2. **"Eventos pendentes praticamente não justifica um módulo."** Concordo com
   mover, mas a tela contém uma ação que **credita dinheiro de verdade**
   (`POST /admin/eventos-pendentes/:id/aplicar`, `src/financeiro/routes.js:563`,
   reconfere no San Checkout antes). Enterrar isso fundo demais em Configurações
   é risco operacional. Proposta: fica em Configurações → Diagnóstico, **mas com
   espelho obrigatório em Pendências** sempre que houver evento não resolvido.
3. **"Candidaturas não deve ocupar item permanente quando vazia."** De acordo —
   mas vale saber que hoje só chega candidatura de ponto, com `conta_id`;
   vendedor não passa mais por ali. A aba nasce mais estreita do que parece.

## 7. Decisões do dono antes de começar

1. **Bug da amortização na Métrica** (§5.2) — corrigir junto, deixar divergir,
   ou adiar a fusão?
2. **Planos** (§5.1) — qual formato de checagem de coerência entre ciclos
   substitui a visão dos 12 cartões? Sem resposta, o módulo Planos fica fora
   da primeira leva.
3. **Escopo de uma vez ou por módulo?** Recomendo por módulo, com revisão sua
   entre um e outro — 12 módulos numa tacada é muita superfície para revisar
   de uma vez.
4. **Conta própria** — a mudança de modelo já pautada (frequência elástica por
   criativo, `docs/proximas-versoes.md`) muda a tela "Anúncios próprios" de
   forma estrutural. Redesenhar a tela agora e mexer de novo depois, ou deixar
   Conteúdo por último?

## 8. Ordem de execução proposta

Cada fatia é verificável sozinha e não quebra a anterior.

1. **Navegação e container** — nova sidebar de 12 itens, sistema de abas,
   aliases de hash antigo → novo. As 25 telas atuais continuam rodando por
   dentro, sem reescrita. *Verificável: todos os 25 hashes antigos ainda abrem
   a tela certa.*
2. **Fusões sem risco** — Entrada, Repasses, Custos, Configurações. Telas de
   pouca edição, agrupadas sob abas.
3. **Pendências** — agregando o que `GET /admin/resumo` já devolve.
4. **Visão geral + Métrica** — depende da decisão 1.
5. **Rede** — listagem enxuta + detalhe do ponto. Maior volume de edição inline
   a migrar.
6. **Anunciantes** — detalhe por conta, `prompt()` → formulário.
7. **Receitas** — consolidação das três telas financeiras.
8. **Conteúdo** — depende da decisão 4.
9. **Planos** — por último, e só com a decisão 2 fechada.
10. **Passe de design** sobre tudo. `.ia/TODO.md:14-18` indica que o CSS do
    admin já usa tokens (`var(--brand)`), então o esforço de cor/tema pode ser
    menor que o esperado — conferir tela a tela.

## 9. Design

Laranja = ação/destaque · azul = informação · verde = sucesso · vermelho =
atenção · cinza = secundário. Sem glassmorphism, gradiente pesado ou sombra
forte. Identidade Mostraí preservada.

Critério objetivo para escolher o recipiente (padrão de mercado, Stripe /
HubSpot / Shopify):

- **drawer** quando é preciso manter a lista visível ao lado;
- **modal** só para tarefa curta e focada (até ~5 campos);
- **página cheia** quando a tarefa é complexa ou precisa de URL própria.

**Estados vazios são item de primeira ordem, não acabamento.** Com 1 ponto e
pouca receita, metade do admin será vista vazia. Seis telas ficam vazias por
motivo estrutural, não por bug: Banco de horas, Devoluções, Trocas, Comissões,
Eventos pendentes, Ocupação. Cada uma diz o que vai aparecer ali e por quê —
compacto, nunca uma tela inteira dizendo "nenhum item".

## 10. Compatibilidade

Os 25 hashes antigos continuam funcionando, redirecionando para o módulo/aba
correspondente. Hash desconhecido segue caindo em `resumo` (`:343`).

## 11. Validação

`npm run sintaxe` · `npm run lint` · `npm run formato` · `git diff --check` ·
testes disponíveis · Playwright nos 12 módulos + amostra dos hashes antigos ·
console sem erro novo · desktop, notebook e tablet.

## 12. Fora de escopo

Sem CRM, analytics, push, automação, cálculo novo, webhook novo, entidade nova,
tabela nova ou dashboard inventado. Sem deploy. Sem merge em `main`.
