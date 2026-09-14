# Precificação e custos — Mostraí

Levantamento de 12/09/2026 (pesquisa web com fontes no fim). Legenda:
**[F]** número de fonte pública · **[D]** derivado de fonte · **[E]** estimativa
com raciocínio. Câmbio R$ 5,36/US$ (Asaas, 11/09/2026). Matão: 81.144 hab.
(IBGE 2026). **Número envelhece: conferir na fonte antes de decidir preço.**

## 1. Preço ao anunciante

Comparável mais próximo (rede de cidade pequena, Camaçari/BA — memorize.tv [F]):
R$ 59,90 (1 tela) · R$ 119,70 (3 telas) · R$ 199,50 (5 telas, com produção
do vídeo). Marginal trava em R$ 39,90/tela/mês. Sem fidelização, 10 dias
grátis na primeira mensalidade.

Modelo "cota por ponto" (apostila do setor [F]): R$ 150/mês por ponto, −20%
para 6 meses, 15–20 anunciantes por ponto.

CPM praticado em DOOH (adMooH [F]): tela de academia CPM R$ 50; shopping
CPM R$ 16,70. Indoor de baixo fluxo = CPM alto, preço absoluto baixo.

Redes grandes (Eletromidia/Aqui Ads, Attractive, Rede TV Indoor) **não
publicam tabela**.

Disposição a pagar do comércio de interior [D/E]: rádio local cobra R$ 20–200
por spot; campanha razoável fecha em R$ 300–800/mês. Agência digital começa em
R$ 1.500/mês. **Faixa aceitável em Matão: R$ 150–400/mês pela rede inteira;
ponto doce R$ 199–299.**

## 2. Contrapartida ao comércio (comodato)

Cinco modelos praticados no Brasil (Progic [F]): pagamento fixo; comissão;
permuta de mídia; concessão de parte da grade; nada. **Nenhuma fonte publica
o valor fixo típico.** Único percentual público: adMooH paga 75% ao dono da
tela no marketplace programático — plataforma→operador, não operador→lojista.

Recomendação [E]: começar com **permuta + grade** (a cota de autoanúncio que já
existe no motor) e **R$ 0 em dinheiro**. Se um ponto premium exigir dinheiro,
teto de **R$ 30–50/mês** ou 10% da receita atribuída ao ponto. Cláusulas
críticas do comodato (Progic): energia, internet, responsabilidade por
dano/furto, proibição de trocar de canal.

## 3. Comissão de vendedor

Mídia indoor: **10–13%** [F]. BV de agência: 20% [F]. Comissão de vendas em
geral no Brasil: 2,5–8%, até 10% [F]. Recorrência: comissão mensal enquanto o
cliente permanecer é o padrão [F].

Desenho recomendado [E]: **25% do primeiro mês + 10% recorrente**. No modelo
de unit economics abaixo usou-se 15% flat como média.

**Lei 4.886/65 (representação comercial) [F, CORE-SP]:** registro no CORE
obrigatório; comissão é direito (não se desconta inadimplência do anunciante);
rescisão sem justa causa gera 1/12 das comissões da vigência. Vendedor pessoa
física com meta, rota e subordinação é passivo trabalhista. Saídas: PJ/MEI com
contrato de representação; indicação pontual sem meta (afiliado); ou CLT.
**Isso é decisão de operação do dono, fora do software** — registrado em
`CONSTRAINTS.md`.

## 4. Custo de equipamento por tela (2026)

| Item | Valor | Base |
|---|---|---|
| Smart TV 43" entrada (TCL/Semp S62) | R$ 1.499 | [F] |
| TV stick Android (Xiaomi/Fire/Roku) | R$ 199–449 | [F] |
| Moldura MDF/ACM por marceneiro local | R$ 250–500 | [E] |
| Moldura profissional em aço (WallFrame 43") | R$ 1.433–2.326 | [F] |
| Suporte de parede | R$ 60–150 | [E] |
| Instalação (fixação em alvenaria) | R$ 120–300 | [F] |
| Ponto elétrico / cabo | R$ 100–200 | [E] |

**Total por tela instalada, enxuto: R$ 2.100–2.900 — referência R$ 2.400.**
Com moldura de aço: R$ 3.800–4.500. TV de consumo não tem garantia comercial
[F]; assumir **amortização em 36 meses (R$ 66,67/mês)** e **manutenção de
8–10% do CAPEX ao ano (~R$ 20/mês)**.

## 5. Custos fixos mensais

| Item | R$/mês | Base |
|---|---|---|
| Northflank (gratuito, compute sempre ligado) | 0 | plataforma San & Co. |
| Supabase gratuito → Pro (US$ 25) quando pagar | 0 → 134 | [F] |
| Domínio .com.br | 3,33 | [F] |
| E-mail transacional (Resend, 3.000/mês grátis) | 0 | [F] |
| Asaas Pix: R$ 1,99/cobrança × 12 anunciantes | 23,88 | [F] |
| Asaas cartão (se usar): R$ 0,49 + 2,99% × R$ 249 × 12 | 95,16 | [F] |
| Asaas NF-e R$ 0,49/doc (ou NFS-e nacional grátis) | 5,88 / 0 | [F] |
| DAS MEI 2026 (serviços) | 86,05 | [F] |
| Contador MEI | 50–150 | [F] |
| Deslocamento de manutenção (1 ronda/mês) | ~50 | [E] |
| Seguro de equipamento (10–15% do valor/ano) | 200–300 | [D] — **não contratar na fase 1** |

**Total operacional MEI, Pix, sem seguro, Supabase gratuito: ≈ R$ 220/mês.
Com Supabase Pro: ≈ R$ 350/mês.** Teto do MEI: R$ 81.000/ano [F].

Duas decisões que valem dinheiro [E]: **cobrar por Pix, não cartão** (R$ 1,99
vs R$ 7,93 por cobrança de R$ 249); **não contratar seguro** — transferir
responsabilidade por furto/dano ao lojista no comodato e provisionar R$ 200/mês.

## 6. Padrões de plano

| Parâmetro | Mercado | Base |
|---|---|---|
| Duração da peça | 10s (Aqui Ads) · 15s (adMooH) | [F] |
| Frequência | peça a cada ~3 min ≈ 20 inserções/hora | [F] |
| Anunciantes por ponto | 15–20 | [F] |
| Fidelidade | mercado vende **sem** fidelização | [F] |
| Desconto por prazo | −20% para 6 meses; anual ≈ "pague 10" | [F] |
| Trial | 7 dias (Yeloo, Mídias TVs) · 10 dias (memorize) | [F] |
| Ativação | até 24h após pagamento | [F] |
| Produção de arte | incluída só no plano topo | [F] |
| Exclusividade de categoria | ninguém publica preço | — |

Tradução para o Mostraí [E]: peça de 15s, loop de 5 min com 10 slots, 12
loops/hora. **Preço fundador: 10 primeiros a R$ 149/mês travados por 12 meses
contra R$ 249 de tabela.** Mínimo de contrato 3 meses; −20% para 6.
Exclusividade de categoria: **+40%** (sem fonte pública; raciocínio: trava 2
vendas potenciais do mesmo ramo).

## 7. Unit economics — 10 telas

Premissas [E]: CAPEX R$ 2.400/tela, 36 meses; manutenção R$ 20/tela/mês;
fixos R$ 437/mês (cenário com Supabase Pro e contador) rateados; comissão
15%; anunciante compra a rede inteira.

| | Conservador | Base | Otimista |
|---|---|---|---|
| Anunciantes ativos | 8 | 12 | 18 |
| Preço/mês | R$ 199 | R$ 249 | R$ 299 |
| Receita da rede/mês | R$ 1.592 | R$ 2.988 | R$ 5.382 |
| Custo total/tela/mês | R$ 154 | R$ 175 | R$ 261 |
| Margem/tela/mês | R$ 5 | R$ 124 | R$ 277 |
| Margem % | 3% | 41% | 52% |
| Lucro da rede/mês | R$ 50 | R$ 1.236 | R$ 2.771 |
| Payback do CAPEX (R$ 24.000) | 33 meses | 13 meses | 7 meses |

**Leituras.** Ponto de equilíbrio: **7 anunciantes a R$ 249** (só em caixa,
4). O conservador não é lucro pequeno, é inviável — o problema é preço, não
volume. **A alavanca é anunciante, não tela:** tela nova custa R$ 2.400 e
~R$ 87/mês e não traz receita; anunciante novo traz R$ 212 líquidos a custo
marginal zero. Não instalar a 11ª tela antes de ter 12 anunciantes. O que
mais ameaça a conta: seguro cedo demais, cartão em vez de Pix, ajuda de custo
em dinheiro generalizada.

## Como isso entra no sistema

- Valores padrão de plano (`src/db/migrations/019_*.sql`, seed comentado):
  Essencial R$ 199, Destaque R$ 249, Máximo R$ 299; fundador a R$ 149 travado.
  **São sugestões; o dono edita no admin.**
- `dispositivos.custo_equipamento` padrão 2400 e `meses_amortizacao` 36.
- `custos_fixos` com as linhas de operação, editáveis.

## Fontes

memorize.tv · apostila "O que é Mídia Indoor" (pdfcoffee) · adMooH Academy
(CPM; licenciamento; revenue share) · Aqui Ads (quanto custa anunciar) ·
Mídias TVs Indoor · Screencorp (preços) · Sua Imprensa (rádio) · Agência EMI ·
Sebrae/Conselho Digital · Propmark/IAB (DOOH R$ 4,4 bi) · Progic MDOOH
(contratos de parceria; negociar espaço) · CORE-SP (Lei 4.886/65) · iClips
(BV) · DNA de Vendas · TecGuia (TVs 43") · Buskando (sticks) · Fóton
(WallFrame/totem) · Cronoshare (instalação) · B2Mídia (TV x monitor) · Asaas
(preços e taxas; cotação) · Balancinho (MEI 2026) · Meu Contador Online ·
HostGator (domínio) · BuildMVPFast (e-mail API) · Notaas (NFS-e) · Rio Rubio
(seguro) · Guia Franquias / Keep Charged / BA de Valor (franquias) · IBGE.
Links completos no histórico da
sessão de 12/09/2026.
