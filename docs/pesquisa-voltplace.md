# Voltplace × Mostraí — pesquisa competitiva

Feita em 15/09/2026 lendo o site da Voltplace, registros públicos do domínio e
preços publicados de outros operadores. **Uma empresa não é o mercado**: a
pesquisa de preço médio do setor em São Paulo está pedida e pendente
(`docs/PENDENCIAS.md`, B.4).

Grau de confiança marcado em cada afirmação. O que não foi encontrado está
dito como não encontrado — preço estimado numa análise competitiva é pior que
preço ausente.

---

# COMPARATIVO VOLTPLACE × MOSTRAÍ + POSICIONAMENTO DE PREÇO
**Base:** três pesquisas entregues (varredura do site, sondagem técnica/externa, mercado) + código e docs do repositório em 15/09/2026.
**Grade real do Mostraí conferida no código, não na memória:** `src/db/migrations/005_planos.sql:31-42`.

---

## 1. CLASSIFICAÇÃO DA VOLTPLACE

| Dimensão | O que é | Certeza |
|---|---|---|
| **Formato** | Totem de piso autoportante com tela vertical **e carregador de celular**. Não é TV de parede. Dois modelos nas fotos: um com lockers para trancar o celular, outro com cabos expostos. Anúncio em vídeo. | **Alta** — título do site, 5 fotos de produto, texto da seção Produtos |
| **Tese de venda** | Atenção cativa: "3 a 8 minutos parados, com atenção total ao display" enquanto o celular carrega. Vendem profundidade de um encontro, não repetição. | **Alta** que afirmam · **Zero** embasamento: não há fonte, metodologia ou amostra em lugar nenhum |
| **Ambientes** | Supermercados, academias, farmácias e universidades "de alto fluxo". Locais de espera longa, não comércio de bairro. | **Alta** — está escrito em `#comofunciona` |
| **Praça** | DDD 16 nos dois telefones — (16) 99788-2339 e (16) 99600-8128. O DDD cobre Matão, mas cobre igual Araraquara, São Carlos, Ribeirão e Franca. **Nenhuma cidade é nomeada em lugar nenhum do site.** Só "os melhores pontos da cidade". | **Baixa** para sobreposição com Matão. Três pesquisas independentes buscaram e não acharam vínculo com Matão |
| **Porte / idade** | Domínio registrado **07/05/2026** (RDAP registro.br, registro de 1 ano — o mínimo). Zero captura no Wayback Machine. Uploads todos de `/2026/05/`. Rodapé "© 2026". ETag da home de 11/09/2026 → **está viva e sendo mexida agora**. | **Alta** |
| **Personalidade jurídica** | Titular do domínio é **pessoa física**: Bruno Veronez, CPF ***.707.968-**, e-mails pessoais. Não há CNPJ no registro. Não achei CNPJ em nenhuma base (Casa dos Dados e cnpj.biz atrás de Cloudflare). | **Alta** que o domínio está em CPF · **Nenhuma** sobre existir ou não CNPJ em outro lugar |
| **Infraestrutura** | WordPress + Elementor Pro sobre tema Hello Elementor, hospedagem compartilhada Hostinger (`platform: hostinger`, `panel: hpanel`, PHP 8.3.33). Site inteiro = **3 URLs**: home, `/linktree/` e o `hello-world` padrão nunca apagado. | **Alta** |
| **Modelo de venda** | **100% WhatsApp.** Zero tags `<form>` em 153 KB de HTML. Zero checkout (0 ocorrências de woocommerce/pix/cartão/boleto/stripe/asaas/mercadopago). Zero área logada — `/login`, `/dashboard` e `/admin` redirecionam para o `wp-login.php` do próprio WordPress. Zero app. | **Alta** |
| **Preço publicado** | **Starter R$ 150/mês · Pro R$ 300/mês ("mais popular") · Premium R$ 499/mês.** | **Alta** — publicado no próprio site, lido por três varreduras independentes |
| **Porte do cliente-alvo** | PME local, inferido pela faixa de preço e pelo canal (WhatsApp). O site nunca declara. | **Média** — é inferência |

**Veredito:** operação de ~4 meses, uma pessoa física, site de uma página, venda manual, formato diferente do nosso. **Não é concorrente de formato. É concorrente de verba** — e só se estiver mesmo em Matão, o que ninguém provou.

---

## 2. FUNCIONALIDADES — LADO A LADO

| Funcionalidade | Voltplace | Mostraí |
|---|---|---|
| Site público | 1 página (âncoras) + linktree | 26 páginas, `sitemap.xml`, JSON-LD em 3 |
| Formulário de contato | **Não existe** (0 `<form>`) | `/contato.html` → grava + e-mail |
| Cadastro / conta do cliente | **Não existe** | `/anunciante/cadastro.html`, scrypt N=2^17, sessão em Postgres |
| Login / área logada | **Não existe** (os 3 caminhos levam ao wp-admin) | `/anunciante/login.html` + painel único com 3 abas |
| Checkout / pagamento online | **Não existe** | San Checkout, webhook HMAC fail-closed, idempotente, transacional |
| Upload de criativo pelo cliente | **Não existe** ("cliente envia o criativo" → por WhatsApp) | Sobe pelo celular, normalizado por ffmpeg, thumb gerada, aprovação do admin |
| Painel do anunciante | **Não existe** | Aba Anúncios: criativos, exibições, cobranças |
| Proof-of-play / exibição confirmada | **Nenhuma menção** no site inteiro | `exibicoes_contador` com `vezes_programadas` × `vezes_confirmadas`, confirmação só se havia programação |
| Comprovante exportável (CSV) | **Nenhuma menção** | `GET /anunciantes/:id/exibicoes.csv` (`src/anunciantes/routes.js:380`), `;` + BOM, 403 para conta alheia |
| Relatório / dashboard | **Prometido** em copy, sem superfície digital para acessar | Painel + CSV |
| Player / CMS de tela | Não observável de fora | `/player.html?tela=ID`, chave de aparelho revogável, PIN por tela, cache de vídeo, heartbeat |
| Gestão de telas | Não observável | Admin → Telas: chave, PIN, custo, amortização, sinal |
| Painel do dono do ponto | **Não existe** (não há oferta ao lojista) | `/anunciante/ponto.html`: telas, cota, sinal por tela, **extrato** (migration 022) |
| Programa de vendedor / indicação | **Não existe** | Cupom, link `?ref=`, comissão por cobrança confirmada, aba Vendas |
| Painel do dono (admin) | wp-admin genérico | `/admin` com resumo de **margem real**, contas, candidaturas, convites, pontos, telas, planos, cobranças, comissões, custos fixos, eventos pendentes, aba Métrica |
| Termos de Uso | **Não existem** | `/termos-de-uso.html` |
| Política de Privacidade / LGPD | **Não existem** (e o site coleta contato) | `/politica-de-privacidade.html`, `docs/inventario-de-dados.md`, direitos do titular RN-24 a RN-26, arrependimento 7 dias |
| Contrato de comodato | Não existe oferta | `/comodato.html` completo |
| App nativo | Não existe | Não existe (**vetado** em `CONSTRAINTS.md` — decisão, não falta) |

**Empate no que nos falta:** nenhum dos dois tem trilha de auditoria, notificação de cobrança recusada, tela "Plano e cobrança" ou prova social documentada. Nós ao menos temos isso mapeado (`docs/PENDENCIAS.md`, seção E5).

---

## 3. BENEFÍCIOS DOS PLANOS

### Voltplace (só mensal, sem ciclo longo)

| | **Starter R$ 150** | **Pro R$ 300** | **Premium R$ 499** |
|---|---|---|---|
| Duração do spot | 10s | 20s | 20–30s |
| Frequência | "padrão no loop" | "2x maior que o Starter" | "máxima (quase contínua)" |
| Cobertura | **1 ponto de alto fluxo** | "mesmo ponto com mais aparições" | não declarada |
| Horário | comercial | **não declarado** | **não declarado** |
| Criativos ativos | não limitado, não mencionado | idem | idem |
| Relatório | **NENHUM** | "relatórios completos" | "relatórios completos" |
| Exclusividade | — | — | "poucos anunciantes ou exclusividade", prioridade na tela |
| Produção da peça | cliente envia | não declarado | não declarado |
| Desconto por prazo | **não existe** | **não existe** | **não existe** |

### Mostraí (grade real no banco)

| | **Essencial** | **Destaque** | **Máximo** |
|---|---|---|---|
| Mensal | **R$ 99,00** | **R$ 199,00** | **R$ 399,00** |
| 3 meses (−10%) | R$ 89,10 | R$ 179,10 | R$ 359,10 |
| 6 meses (−15%) | R$ 84,15 | R$ 169,15 | R$ 339,15 |
| 12 meses (−20%) | R$ 79,20 | R$ 159,20 | R$ 319,20 |
| Exibições/dia por tela | **36** | **72** | **144** |
| Criativos ativos | 1 | 2 | 3 |
| Cobertura | **100% dos pontos** | 100% | 100% |
| Comprovante CSV | **sim** | sim | sim |
| Painel de exibições | **sim** | sim | sim |
| Não-concorrência no ponto | **sim, de graça** | sim | sim |

### As quatro diferenças que importam

1. **Eixo de upgrade.** Eles escalam **duração do spot**; nós escalamos **frequência + nº de criativos**. O deles é mais fácil de entender ("meu anúncio dura o triplo"); o nosso é mais auditável.
2. **Cobertura.** Starter = 1 ponto. Pro = "mesmo ponto com mais aparições" — **o upgrade de R$150 para R$300 não compra mais pontos**, e o site nunca resolve a ambiguidade. Nosso R$99 já compra a rede inteira.
3. **Número.** Eles nunca publicam frequência em número absoluto. Nós publicamos 36/72/144 e confirmamos exibição a exibição.
4. **Relatório no plano de entrada.** Quem paga R$150 na Voltplace **não recebe prestação de contas nenhuma**. Quem paga R$99 aqui já sai com painel e CSV.

---

## 4. PONTOS FORTES DELA QUE O MOSTRAÍ NÃO TEM — sem suavizar

1. **Está no ar vendendo há quatro meses. Nós não estamos no ar.** A Estação 5 não fecha sem "a versão inicial no ar", e isso depende de três itens da fila do dono (bucket `criativos` público, health check, build verde). Enquanto discutimos CSP estrita e migration 026, eles atendem WhatsApp num WordPress de R$ 30/mês. Isso não é detalhe — é a única vantagem que realmente compõe juros.

2. **Têm um número de atenção. Nós não temos nenhum.** "3 a 8 minutos parados na frente da tela" é falso-ou-verdadeiro, mas é um número, e fecha venda. O nosso equivalente — "tempo de espera vira atenção" em `public/index.html` — é adjetivo. Não temos fluxo por ponto, não temos impacto, não temos CPM. **Sem número de audiência, nenhuma agência e nenhum comerciante com histórico consegue nos comparar com nada.**

3. **O totem tem razão física para a pessoa parar na frente dele.** Carregamento gratuito é um serviço; a permanência é consequência estrutural do produto. A nossa TV na parede depende do acaso do olhar de quem já estava parado ali por outro motivo. É vantagem de produto, não de marketing.

4. **Teto de preço mais alto e exclusividade vendida.** R$ 499 contra os nossos R$ 399, e o Premium vende "poucos anunciantes ou exclusividade" como benefício pago. Nós damos não-concorrência de segmento **de graça** (`public/comodato.html` cl. 5.3 e `public/index.html`) e não capturamos nada por isso.

5. **Ambientes de permanência estruturalmente mais longa.** Academia e universidade batem padaria e barbearia em tempo de exposição por visita. O mix de pontos deles é melhor para a tese de atenção — e é escolha deliberada, não acaso.

6. **Custo de construção próximo de zero.** WordPress + Elementor. Nós construímos 27 migrations, 26 páginas, CI, CSP sem `unsafe-inline`, webhook HMAC e cinco suítes e2e **antes do primeiro cliente pagante**. Para quem chega ao mercado, a vantagem é deles.

7. **Modelo comercialmente escalável.** Vender por ponto permite subir preço quando a rede cresce. Nós travamos "100% dos pontos" — cada tela nova adiciona custo e **zero inventário vendável**. Ver seção 6.

---

## 5. PONTOS FRACOS DELA QUE O MOSTRAÍ PODE ATACAR

**Utilizáveis em material comercial (evidência forte):**

1. **Frequência não auditável.** "padrão", "2x maior", "quase contínua". O anunciante não sabe quantas vezes vai aparecer, e não tem como conferir depois. Nossa resposta: 36/72/144, publicado, e o comprovante que prova.
2. **R$ 150 sem relatório nenhum.** Está nos cinco itens do card Starter: não há relatório. Nosso Essencial de R$ 99 sai mais barato **e** já entrega painel e CSV.
3. **Relatório prometido sem lugar onde acessar.** Zero área logada, zero cadastro, zero app. Se entregam algo, é PDF por WhatsApp, na mão, quando lembrarem.
4. **"Relatórios sobre movimentação do público" é medição de audiência, não prova de veiculação.** Nenhuma ocorrência de proof-of-play, exibição confirmada, comprovante ou CSV em 153 KB de HTML. *(Ressalva honesta: ausência no site não é prova de ausência no produto — a própria pesquisa marca isso com confiança média. Cobrar "me mostre um exemplo do relatório" na negociação resolve.)*
5. **Cobertura parcial disfarçada de upgrade.** Starter = 1 ponto. Pro = mais aparições **no mesmo ponto**. Quem paga o dobro não alcança mais gente — alcança mais vezes a mesma gente.
6. **Sem Termos de Uso e sem Política de Privacidade**, num site que capta contato por WhatsApp. Nós temos os dois, mais inventário de dados e direitos do titular no ar desde 14/09.
7. **Zero prova social.** Nenhum cliente, nenhum case, nenhum depoimento, nenhum número de pontos, nenhuma cidade. *(Ressalva: nós também não temos — `docs/provas.md` não existe. Isso é empate, não vantagem nossa.)*
8. **Venda 100% manual.** Não vende às 23h, não vende sem conversa, não escala. Toda a nossa esteira de autoatendimento é vantagem aqui.
9. **Zero oferta ao lojista e zero programa de indicação.** As duas pontas que o Mostraí monetiza não existem na comunicação deles. Se disputarmos a mesma parede em Matão, nós temos proposta escrita (R$ 50/mês ou cota ampliada) e eles não têm nenhuma.

**Leitura interna apenas — NÃO usar em material comercial:**

10. **Titular pessoa física, sem CNPJ no domínio.** Não usar: o Mostraí também opera hoje em nome de pessoa física (`public/comodato.html` §1: "Bruno Henrique Sanches, CPF 552.085.198-01... enquanto a SLU ME está em fase de constituição"). Atirar nisso antes de constituir a nossa PJ é tiro no pé.
11. **Higiene técnica ruim:** `xmlrpc.php` exposto, wp-admin acessível por três aliases, sitemap de usuários público, "Hello world!" publicado desde 07/05. Não vende nada para comerciante — mas diz que não há ninguém cuidando do ativo.
12. **As fotos de produto provavelmente não são da rede deles** (criativo da Jeep com carimbo de concessionária; Granado/Turma da Mônica em loja Granado; nomes de arquivo "Captura-de-tela-..."). **Confiança baixa** — é indício de que podem ser imagens do fabricante do totem, não pontos instalados. Serve só para calibrar quanto medo ter.

---

## 6. ONDE NOSSO PREÇO CAI NO MERCADO

### 6.1 Os números publicados que existem

| Operador | Praça | Preço publicado | Unidade vendida |
|---|---|---|---|
| **Mostraí** | Matão-SP | R$ 99 / 199 / 399 (−20% em 12m) | **rede inteira** |
| Voltplace | DDD 16, cidade não nomeada | R$ 150 / 300 / 499 | 1 ponto (Starter) / ambíguo |
| memorize.tv | Camaçari-BA, 12 telas | R$ 59,90 / 119,70 / 199,50 | 1 / 3 / 5 telas (R$ 39,90 marginal) |
| Lets Three | Mirassol-SP, 4 pontos | a partir de R$ 69,90 | plano único, produção inclusa |
| Rede TV Indoor | Trindade-GO, ~130 mil hab. | R$ 5,99 / 14,99 / 24,99 **por dia**, mín. 90 dias → ≈ R$ 180 / 450 / **750** por mês | rede mista |
| 4Charge | nacional | R$ 150–400/mês | **por ponto** |
| helloo | capitais | a partir de R$ 79,90 / 30 dias | 1 tela, mín. 10.500 exibições |
| Rádio Mix | São Carlos (60 km) | **R$ 160 por UMA inserção de 30s** | inserção |
| Outdoor | Araraquara | R$ 950/bi-semana (tabela de 2017) | ponto |

### 6.2 Onde caímos, por comparação

**Por linha de plano, contra o comparável de formato mais direto (memorize.tv): estamos ACIMA.** R$ 99 contra R$ 59,90. R$ 399 contra R$ 199,50. Quem comparar card a card acha o Mostraí caro.

**Por cobertura: estamos claramente ABAIXO.** A rede inteira do memorize.tv (12 telas × R$ 39,90) extrapolada sai ~R$ 478,80/mês — nosso Máximo entrega a rede inteira por R$ 399. E contra a Voltplace, o Starter deles é R$ 150 por **um** ponto; nosso Essencial é R$ 99 por **todos**. Com 10 telas, isso é 1/15 do preço por tela.

**Contra o teto praticado: estamos ABAIXO, com folga.** O topo da Rede TV Indoor, numa cidade de porte comparável (Trindade-GO, 130 mil hab.), é ~R$ 750/mês. O topo da Voltplace é R$ 499. O nosso é R$ 399.

**Contra mídia local tradicional: estamos MUITO ABAIXO.** R$ 99 é menos que **uma única** inserção de 30s na Mix São Carlos (R$ 160, tabela oficial jan–dez/2025). R$ 399 ≈ 2,5 inserções de rádio, ou ~27% de uma bi-semana de outdoor em Araraquara corrigida por inflação. *Contraponto honesto que precisa estar escrito junto: rádio e outdoor alcançam a cidade inteira; nós alcançamos quem entra nos pontos parceiros. Universo muito menor, contexto muito melhor. Comparar 4.320 exibições/mês com 44 inserções de rádio sem dizer isso é enganar a si mesmo — e o comerciante que já anunciou em rádio percebe.*

### 6.3 Veredito por nível

| Plano | Posição | Risco |
|---|---|---|
| **Essencial R$ 99** | Muito abaixo por cobertura; na média por valor absoluto | **O número mais perigoso da grade.** Se R$ 99 já dá 100% dos pontos, por que alguém pagaria R$ 399? A diferença é só frequência, e o comerciante não sabe medir frequência. Risco real de a grade inteira ancorar em R$ 99 |
| **Destaque R$ 199** | Na faixa | Baixo. É a linha que `docs/precificacao.md` aponta como ponto doce (R$ 199–299) |
| **Máximo R$ 399** | Abaixo do teto praticado (R$ 499 Voltplace, R$ 750 Rede TV Indoor) | Dinheiro na mesa. E o plano que menos tem motivo de ser escolhido, pelo item acima |

### 6.4 Os três riscos estruturais de preço, com números

**A. A receita da rede é travada pelo inventário, não pelo número de telas.**
Como todo plano alcança 100% dos pontos (menos concorrente direto), o inventário vendável da rede inteira é o inventário de **uma** tela. O teto é `LIMITE_SLOTS_PROGRAMADOS = 200` slots/hora (`src/lib/pacing.js:5`), e a frequência é `planos.frequencia_hora`, direta, sem conversão (migration 037). Os números por hora:

- Essencial = 3 slots/hora · Destaque = 6 · Máximo = 12
- Teto: 200 slots/hora ÷ 3 = **66 contas Essencial** → R$ 6.534/mês
- Ou 200 ÷ 12 = **16 contas Máximo** → R$ 6.384/mês
- Mix realista (20 Essencial + 10 Destaque + 5 Máximo) = 2.160 exibições/dia, **R$ 5.965/mês** — e já consome 90% do inventário

**A receita máxima da rede é ~R$ 6.400/mês, e esse número não muda se a rede tiver 10 ou 30 telas.** O custo, sim: R$ 2.400 de CAPEX por tela + ~R$ 87/mês (amortização 36m + manutenção). A 30 telas (o limite declarado em `CONSTRAINTS.md`) o custo de telas sozinho é ~R$ 2.610/mês contra um teto de R$ 6.400. Cada tela nova adiciona custo e **zero inventário vendável**. A cota de autoanúncio do comodato come dos mesmos 200 slots.

**B. A grade no banco não é a grade que a precificação recomendou.**
`docs/precificacao.md` §"Como isso entra no sistema" afirma: *"Valores padrão de plano (`src/db/migrations/019_*.sql`, seed comentado): Essencial R$ 199, Destaque R$ 249, Máximo R$ 299"*. **Isso está errado duas vezes:** o seed real está em `005_planos.sql`, e os valores são 99/199/399. A mesma doc conclui que o ponto de equilíbrio é **7 anunciantes a R$ 249** e que *"o conservador não é lucro pequeno, é inviável — o problema é preço, não volume"*. Com o mix real da grade de 99/199/399, o ticket médio fica abaixo de R$ 249. Uma das duas fontes está errada, e a doc é a que o dono lê para decidir preço.

**C. Colisão de números com um produto do outro lado do mercado.**
R$ 99 / 199 / 399 é **idêntico, valor por valor**, à grade do MÍDIA.PontoTV — que é SaaS de digital signage vendido ao **dono da TV**, com repasse de 20%/35%/50%. Um comerciante de Matão que pesquisar "mídia indoor R$ 99" encontra o produto invertido.

**D. Preço riscado que nunca foi praticado.**
O plano fundador tem `valor_mensal_cheio = 249` (`019_v2_contas_dispositivos_convites_planos.sql:168`). O Destaque mensal real é R$ 199 e o Destaque anual é R$ 159,20. **R$ 249 não existe em nenhuma linha da grade.** Preço de referência não praticado é risco de CDC art. 37 e Anexo Q do CONAR, não detalhe de copy.

---

## 7. O QUE MUDAR NO MOSTRAÍ — priorizado

| # | Mudança | Onde mexe |
|---|---|---|
| **1** | **Pôr a versão inicial no ar.** Quatro meses de vantagem da Voltplace é a única coisa nesta pesquisa que não se recupera com código. | `docs/PENDENCIAS.md`, fila do dono, itens 1–3: bucket `criativos` público no Supabase, health check `/health` no Northflank, build verde. É o que fecha a Estação 5 |
| **2** | **Resolver a divergência de preço entre `docs/precificacao.md` e o seed real**, e então decidir a grade definitiva. Recomendação com base nos dados: subir o Máximo (teto praticado é R$ 499–750) e subir o Essencial (hoje ancora a grade inteira num número que torna Destaque e Máximo desnecessários). | `docs/precificacao.md` §"Como isso entra no sistema" (corrigir o texto) · valores: admin → Planos via `POST /admin/planos/:id/nova-versao` (RN-27, migration 026 — valor é campo de contrato, não de vitrine). Sem assinante pago ainda, migration aditiva corrigindo o seed de `005_planos.sql` também serve |
| **3** | **Quebrar a colisão 99/199/399 com o MÍDIA.PontoTV.** Qualquer terno que não seja exatamente esse. Cabe junto com o item 2, num movimento só. | Mesma tela do item 2 |
| **4** | **Tirar o R$ 249 riscado do plano fundador.** Risco legal, custo zero de correção. | `src/db/migrations/019_...sql:168` (`valor_mensal_cheio`), ou admin → Planos → Programa fundador |
| **5** | **Pôr o comprovante em CSV na vitrine.** É o nosso maior diferencial contra Voltplace, memorize.tv e Lets Three, existe em `src/anunciantes/routes.js:380` — e **não aparece em nenhuma página pública**. Hoje só quem já é cliente descobre que existe. | `public/planos.html` (bloco de benefícios) + `public/planos.page.js` (cards) + `public/index.html` (seção "Por que funciona") + `planos.beneficios` nas 12 linhas da grade, no admin |
| **6** | **Escrever a resposta para "quero escolher o ponto".** Todo o mercado do formato vende por tela (memorize.tv 1/3/5, Voltplace "1 ponto", 4Charge por ponto). O comprador foi ensinado a pedir ponto. Sem resposta impressa, o vendedor perde essa comparação toda vez. | `public/planos.html` (bloco curto: "por que 100% dos pontos em todo plano") + `public/pontos.html` (a lista de pontos é a prova) |
| **7** | **Item 8 da spec — desconto de comodato por linha da grade.** É o que falta para fechar a Estação 5 junto com o deploy. A pesquisa reforça o valor: **nenhum concorrente tem qualquer oferta ao lojista.** Antes de construir, decidir a precedência em aberto: quem tem `preco_travado` e ganha desconto de comodato — o desconto incide sobre o travado, ou o travado vence? | `docs/PENDENCIAS.md` B.1.2 (a decisão) · 12 campos no admin → Planos · `GET /plano/{id}`, que é o valor que o San Checkout cobra (spec item 8) |
| **8** | **Um número de audiência nosso.** A Voltplace tem "3 a 8 minutos" sem fonte; nós não temos número nenhum. Basta um campo de fluxo/permanência declarado por ponto para nascer impacto e CPM. Sem CPM, ninguém compara o Mostraí com rádio, com Instagram nem com a Voltplace. | Campo novo no cadastro de ponto (admin → Pontos) + a entrada "Impactos estimados e CPM" de `docs/proximas-versoes.md`, que hoje está sem condição de entrada cumprida |
| **9** | **Criar o registro de provas antes de publicar qualquer número.** Está marcado ❌ em `docs/PENDENCIAS.md` (E5, tipo institucional, item 4). A Voltplace afirma "3 a 8 minutos" e "ROI superior" sem fonte — nós não podemos responder com a mesma moeda. | `docs/` (arquivo de provas, o dono decide o nome) + gate antes de qualquer número entrar em `public/` |
| **10** | **Página "Mostraí × outras mídias" com os números publicados.** R$ 99 < R$ 160 de UMA inserção de 30s na Mix São Carlos (tabela oficial jan–dez/2025). R$ 399 < 30% de uma bi-semana de outdoor em Araraquara. **Com o contraponto de alcance escrito junto** — senão quem já anunciou em rádio derruba o argumento na hora. | Página nova em `public/` + entrada no `public/sitemap.xml` + menu em `public/layout.js` |
| **11** | **Precificar a exclusividade de categoria.** Hoje damos não-concorrência de segmento de graça (`public/comodato.html` cl. 5.3, `public/index.html`). A Voltplace vende isso no plano de R$ 499. `docs/precificacao.md` §6 sugere +40%. | `docs/proximas-versoes.md`, entrada "sobretaxa de exclusividade" — revisar a condição de entrada; depois, campo de plano no admin |
| **12** | **Escrever o teto de inventário no lugar certo.** O modelo "100% dos pontos" trava a receita da rede em ~R$ 6.400/mês independentemente do número de telas, enquanto o custo cresce R$ 2.400 + R$ 87/mês por tela. Precisa estar como limite assumido, e a tabela precisa ter revisão prevista em contrato quando a rede passar de N pontos. | `CONSTRAINTS.md` (limites assumidos) · `docs/precificacao.md` §7 (a leitura "não instalar a 11ª tela antes de ter 12 anunciantes" precisa virar regra explícita de inventário) · `public/contrato-anunciante.html` (cláusula de revisão de tabela) |

---

## 8. O QUE NÃO DEU PRA DESCOBRIR — e como descobrir

**Sobre preço da Voltplace, com todas as letras:** a pesquisa **achou** o preço deles — R$ 150 / R$ 300 / R$ 499 por mês, publicado no próprio site e lido por três varreduras independentes. O que **não** existe é confirmação fora do site deles: nenhum anúncio, tabela, matéria ou menção externa de preço. E não existe, em lugar nenhum: preço de ciclo longo, taxa de adesão, custo de produção, fidelidade, prazo mínimo ou política de cancelamento. **Nada disso foi estimado aqui.**

| Lacuna | Como fechar | Custo |
|---|---|---|
| Quantos totens a Voltplace tem e onde estão | WhatsApp (16) 99788-2339 como anunciante interessado: "quantos pontos e quais?" | 10 min |
| **Se a Voltplace opera em Matão** — a pergunta que decide se ela importa | Duas vias: a mesma ligação; e uma volta pelos supermercados, academias e farmácias de Matão olhando se há totem com carregador. A segunda é conclusiva | 1 tarde |
| Fidelidade, adesão, ciclo longo, cancelamento deles | Pedir proposta por WhatsApp. O site não publica nada disso | 10 min |
| **Se a Voltplace entrega proof-of-play de verdade** | Na conversa: "me manda um exemplo do relatório do Pro". Se vier PDF de fluxo de público, a brecha está confirmada e vira argumento de venda nosso | 10 min |
| O que a Voltplace paga (ou não) ao lojista | Ligar como **lojista**, não como anunciante: "quero um totem no meu comércio, o que eu ganho?" | 10 min |
| Se existe CNPJ da Voltplace | Casa dos Dados e cnpj.biz bloquearam robô, mas abrem no navegador. Buscar pelo nome do titular | 10 min |
| **Preços reais de mídia em Matão** — não existe nenhum publicado, de nenhum meio | Três ligações: **Jornal A Comarca (16) 3382-1999**; **Rádio Cidade FM 106,5 (Matão)**; **I'mídia** (`imidiapaineis.com.br`, opera Araraquara/São Carlos/Ribeirão). ⚠️ **Não usar a tabela Mix "Centro Paulista" de R$ 250** como preço de rádio em Matão: é de Lençóis Paulista/Agudos/Bauru — coincidência de frequência 106,5 | 30 min |
| **Se o adMooH Pump já tem tela em Matão ou região** | Abrir `site.admooh.com/pump` e filtrar por cidade. É o único concorrente que permite um comerciante de Matão comprar tela sem falar conosco — e permite um lojista parceiro monetizar a tela sozinho | 10 min, e **muda a estratégia se der positivo** |
| Quanto o mercado paga por parede em comodato | **Nenhuma das três pesquisas achou benchmark público.** Único número indireto: ~R$ 70 de receita por ponto/mês numa rede indoor madura (Ponto TV, 100+ pontos). Nossos R$ 50/mês estão perto demais desse teto. Só se descobre negociando os 5 primeiros pontos | na rua |
| Se algum concorrente paga comissão recorrente a vendedor | Nenhuma fonte, em nenhuma das três pesquisas. Nosso desenho (25% do 1º mês + 10% recorrente, `docs/precificacao.md` §3) está sem comparável | — |
| Tamanho do mercado publicitário de Matão | Associação Comercial de Matão. Nenhuma fonte pública tem o número | 1 ligação |
| Fonte do "3 a 8 minutos" e do "ROI superior" da Voltplace | **Não tem, e não vai ter.** Registrado aqui para não replicarmos o padrão | — |

**Uma advertência de calibragem, do achado mais duro do levantamento de mercado:** existe decisão judicial e artigo no Migalhas documentando fraude em projeção de viabilidade **neste mesmo setor** — franqueadora projetando R$ 8.316/mês por totem (28 anunciantes a R$ 297) contra uma receita real observada de **R$ 970/mês por equipamento** (~3 anunciantes), com casos de R$ 150 e de zero. O mesmo artigo registra que ~82% dos potenciais anunciantes locais preferem Google e Meta Ads. Dimensionar a meta de vendas do Mostraí pelos R$ 8 mil das franqueadoras é repetir um erro já documentado em juízo — e é risco de compliance direto se algum dia o programa de vendedor parceiro prometer comissão com base em projeção.