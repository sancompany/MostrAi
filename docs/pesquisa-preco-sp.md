# Preço de mercado — mídia indoor / DOOH em São Paulo

Pesquisa pedida pelo dono (pendência **B.4**): quanto empresas **do mesmo porte**
cobram por plano, e que benefícios entregam nesse preço, **só no Brasil, recorte
São Paulo**. Feita em 15/09/2026.

## Como ler este documento

Cada número vem com **de onde saiu** e **o quanto dá pra confiar nele**. Onde não
achei, está escrito que não achei — preço estimado numa pesquisa de preço é pior
do que preço ausente, e é assim que a pesquisa da Voltplace
(`docs/pesquisa-voltplace.md`) já foi escrita.

| Confiança | O que significa |
|---|---|
| **Alta** | Número publicado pela própria empresa, no site dela |
| **Média** | Número publicado por veículo do setor ou por operador, mas sobre outro recorte (outra praça, outro formato) |
| **Baixa** | Ordem de grandeza citada em material comercial, sem metodologia |

**O achado que atravessa tudo:** esse mercado **não publica preço**. Das dezenas
de operadoras de mídia indoor brasileiras que aparecem numa busca, quase nenhuma
tem tabela pública; o padrão do setor é "fale com um consultor". Isso tem uma
consequência comercial direta, e ela está no item 6.

---

## 1. O concorrente da mesma cidade (a única comparação perfeita)

| | Mostraí | Voltplace (Matão) |
|---|---|---|
| Entrada | **R$ 99/mês** | **R$ 150/mês** (Starter) |
| Meio | **R$ 199/mês** | **R$ 300/mês** (Pro, "mais popular") |
| Topo | **R$ 399/mês** | **R$ 499/mês** (Premium) |

Confiança **alta** dos dois lados (nosso `src/db/migrations/005_planos.sql` e o
site deles). Detalhe de benefício por faixa em `docs/pesquisa-voltplace.md`.

**Leitura:** somos 34% mais baratos na entrada, 34% no meio e 20% no topo. Não
estamos "baratos demais" por acidente — estamos um degrau abaixo do único
concorrente local em todas as faixas, com mais coisa entregue no plano de
entrada (painel de exibições e comprovante em planilha, que o Starter deles não
tem).

---

## 2. O que outras operadoras publicam

| Operador | Praça | Preço publicado | O que entra | Confiança |
|---|---|---|---|---|
| Tela Indoor | Interior de SP (DDD 15) | **R$ 150/mês** (Inicial) e **R$ 300/mês** (Gestão) | Planos do **estabelecimento** que quer operar a própria TV, não do anunciante | Alta |
| Rede citada em material de fornecedor | não declarada | **a partir de R$ 59,90/mês**, com 12 telas ativas e ~45.000 impactos/mês | Pacote de anunciante em rede pequena | Baixa (material comercial) |
| Painel de LED (formato vizinho, não indoor) | municípios < 500 mil hab. | **R$ 1.500 a R$ 2.500 por anúncio** | Tela de rua, grande formato | Média |
| Painel de LED | capitais | **R$ 10.000 a R$ 15.000 por anúncio** | Tela de rua, grande formato | Média |
| Outdoor impresso × digital | Brasil | **R$ 500 a R$ 2.500/mês** (impresso) · **R$ 1.200 a R$ 15.000/mês** (LED/digital) | Mídia exterior | Média |

**Leitura:** a faixa de R$ 99 a R$ 399 do Mostraí está **abaixo de tudo que é
mídia de rua** e **dentro** do intervalo de mídia indoor de rede pequena —
exatamente onde deveria estar, porque o produto é esse: tela dentro do comércio
de uma cidade de ~80 mil habitantes, não painel de avenida.

---

## 3. A régua que o setor usa: CPM

O mercado profissional de DOOH não cobra "por mês": cobra **CPM** (custo por mil
impactos). Referências publicadas:

| Contexto | CPM | Fonte | Confiança |
|---|---|---|---|
| Exemplo de tela em academia | **R$ 50** | material técnico de plataforma DOOH | Média |
| Exemplo de tela em shopping | **R$ 16,70** | mesma fonte | Média |
| Exemplo genérico de campanha | **R$ 10** | mesma fonte | Média |

### Onde caímos nessa régua

Contas feitas com a grade real (`planos`) e **duas suposições declaradas**: 30
dias no mês e **3 pessoas vendo cada exibição** (tela de espera em comércio de
bairro; é chute conservador, não medição).

| Plano | R$/mês | Exibições/dia por tela | Com **1 tela** na rede | Com **5 telas** na rede |
|---|---|---|---|---|
| Essencial | 99 | 36 | 1.080 exib./mês · **R$ 0,092 por exibição** · CPM ~R$ 31 | 5.400 exib./mês · **R$ 0,018** · CPM ~R$ 6 |
| Destaque | 199 | 72 | 2.160 · R$ 0,092 · CPM ~R$ 31 | 10.800 · R$ 0,018 · CPM ~R$ 6 |
| Máximo | 399 | 144 | 4.320 · R$ 0,092 · CPM ~R$ 31 | 21.600 · R$ 0,018 · CPM ~R$ 6 |

**Três conclusões que mudam decisão:**

1. **O preço por exibição é o mesmo nos três planos** (R$ 0,092 por tela). A
   grade é linear: paga-se por frequência, não por "pacote melhor". Isso é
   honesto e fácil de defender numa conversa de venda — e também significa que
   o Destaque e o Máximo **não têm nenhuma economia de escala pro cliente**. Se
   um dia quisermos que o plano de cima pareça mais vantajoso, o caminho é dar
   desconto por volume, não inventar benefício.
2. **Com a rede vazia, o nosso CPM (~R$ 31) é caro** — fica entre o shopping
   (R$ 16,70) e a academia (R$ 50), sem ter nem o público do shopping nem a
   atenção da academia. **Com 5 telas cai pra ~R$ 6**, abaixo de tudo que o
   setor publica. Ou seja: **o preço atual só é bom negócio pro cliente depois
   da quinta tela.** Isso é argumento de venda e é também um risco — vender
   caro pra rede vazia é o que gera pedido de devolução.
3. O número de telas é o que move o valor entregue, não o valor cobrado. Cada
   ponto novo melhora a oferta de **todos** os anunciantes já pagantes, de
   graça. É o efeito de rede do negócio, e ele deveria estar dito na vitrine.

---

## 4. Tamanho do mercado (contexto, não preço)

| Dado | Número | Fonte | Confiança |
|---|---|---|---|
| Investimento em mídia digital no Brasil (2025) | **R$ 42,7 bilhões** | IAB Brasil / Kantar Ibope, Digital AdSpend 2026 | Alta |
| Fatia de DOOH, medida pela primeira vez | **R$ 4,4 bilhões** | mesma pesquisa | Alta |
| Anunciantes que pretendem **aumentar** investimento em DOOH | **71%** | IAB Brasil | Alta |

**Leitura:** o formato está crescendo e acabou de virar linha de orçamento
formal. Não muda nosso preço; muda o discurso de venda — "isso é o que as
grandes já estão fazendo, na escala da sua rua".

---

## 5. O que a operação cobra de quem cede a parede

Do lado do ponto (o outro lado da conta), o único número comparável que achei
publicado é o nosso próprio modelo: **R$ 50/mês de ajuda de custo ou cota
ampliada de autoanúncio**. Operadores de totem de rua costumam falar de
**comodato sem contrapartida em dinheiro** (o estabelecimento ganha exposição,
não aluguel) — o que torna nossa ajuda de custo uma vantagem competitiva real na
hora de fechar ponto, e um custo fixo que a margem do admin já mostra.

**Não achei** nenhuma tabela pública de quanto redes indoor pagam a lojistas em
São Paulo. Fica como pergunta aberta, e a resposta prática é a do nosso próprio
funil: se fechar ponto estiver fácil, a ajuda de custo está acima do necessário;
se estiver difícil, está abaixo.

---

## 6. O que fazer com isso (recomendações)

1. **Não baixar preço.** Estamos abaixo do único concorrente local em todas as
   faixas e dentro da faixa do setor. O problema do Mostraí hoje não é preço
   alto: é rede pequena.
2. **Publicar a tabela é vantagem competitiva, não risco.** O setor inteiro
   esconde preço atrás de "fale com um consultor". Somos, junto com a
   Voltplace, dos poucos com preço na tela — e quem decide sozinho, às 23h, com
   o preço à vista, é exatamente o comerciante de Matão.
3. **Vender em CPM quando a rede crescer.** A partir de ~5 telas o nosso CPM
   fica abaixo do que o mercado publica. Aí vale colocar o número na vitrine
   ("R$ 6 por mil pessoas alcançadas" diz mais a um anunciante experiente do que
   "R$ 99 por mês").
4. **Enquanto a rede for pequena, a honestidade é o produto.** A tela de planos
   já avisa quando não há ponto no ar (`public/planos.page.js`), e o direito de
   arrependimento de 7 dias está dito. Manter isso vale mais do que um desconto.
5. **Rever a linearidade da grade.** Hoje os três planos custam o mesmo por
   exibição. Se o Máximo é pra parecer o melhor negócio, precisa de desconto por
   volume — hoje ele é só "três vezes mais caro por três vezes mais exibições".

---

## 7. O que esta pesquisa NÃO conseguiu responder

Registrado por honestidade — e porque a resposta existe, só não está publicada:

1. **Preço médio real de mídia indoor em São Paulo por faixa de plano.** O setor
   não publica. As redes grandes (Elemidia, Helloo, 20/20, adMooH) vendem por
   campanha/CPM, não por plano mensal de PME, e nenhuma delas publica tabela.
2. **Quanto uma rede indoor paga a um lojista** por ceder parede e energia.
3. **Preço praticado pelas outras redes indoor do interior paulista** (Rio
   Preto, Araraquara, São Carlos): nenhuma com tabela pública encontrada.

**Como fechar essas três lacunas, se o dono quiser:** pedir proposta como
anunciante a três operadoras (uma da capital, duas do interior) — é meia hora de
formulário e devolve o número exato que nenhuma busca devolve. Se isso for feito,
os números entram aqui com confiança **alta** e esta seção some.

---

## Fontes

- Voltplace — site do concorrente (ver `docs/pesquisa-voltplace.md` para o
  registro completo da leitura)
- [Tela Indoor](https://telaindoor.com.br/) — planos R$ 150 e R$ 300/mês
- [The Led — Quanto custa para anunciar em outdoor](https://theled.com.br/quanto-custa-para-anunciar-em-outdoor/) — faixas de LED por porte de município
- [Sua Imprensa — Quanto custa anunciar em outdoor](https://suaimprensa.com.br/blog/quanto-custa-anunciar-em-outdoor/) — faixas de outdoor impresso e digital
- [adMooH Academy — O que é CPM no contexto de DOOH](https://help.admooh.com/support/solutions/articles/154000189123-o-que-%C3%A9-cpm-e-como-%C3%A9-calculado-no-contexto-de-dooh-) — exemplos de CPM (R$ 10, R$ 16,70, R$ 50)
- [IAB Brasil — Panorama DOOH](https://iabbrasil.com.br/pesquisa-panorama-dooh-2025/) e [Digital AdSpend 2026 (via Conversion)](https://www.conversion.com.br/blog/iab-brasil-publicidade-digital-42-bilhoes-2025) — R$ 42,7 bi digital, R$ 4,4 bi DOOH
- [Meio & Mensagem — 71% aumentarão investimento em DOOH](https://www.meioemensagem.com.br/midia/iab-investimento-em-dooh)
- [Achei no Totem — Investir em mídia indoor em 2026](https://www.acheinototem.com.br/investir-em-midia-indoor/) — modelo de negócio de rede no interior paulista
