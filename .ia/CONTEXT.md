# CONTEXT.md — O que é o Mostraí

## Finalidade do produto

Rede de mídia digital indoor (DOOH — *digital out-of-home*) na cidade de
Matão-SP. Telas instaladas em comércios de terceiros (bares, mercados,
salões, etc.) tocam anúncios em vídeo/imagem de empresas locais que pagam um
plano mensal. Projeto próprio do ecossistema San & Co. (não é white-label,
não atende outras cidades hoje — ver veto de segunda cidade em
`CONSTRAINTS.md`).

## Problema que resolve

- **Para o anunciante local**: mídia paga de alcance real na própria cidade,
  sem o custo e a complexidade de comprar mídia em rede nacional (TV, painel
  digital de rodovia) nem o trabalho de administrar as próprias telas.
- **Para o comércio (ponto)**: monetiza uma parede sem custo de instalação —
  cede o espaço e recebe ajuda de custo mensal ou cota para anunciar o
  próprio negócio nas telas (comodato).
- **Para quem indica clientes (vendedor)**: comissão sobre o valor confirmado
  de quem ele trouxe.

## Público-alvo

Pequeno e médio comércio de Matão-SP e região, tanto do lado anunciante
(quem paga pra aparecer) quanto do lado ponto (quem cede a parede).
Vendedores são parceiros comerciais que trazem anunciantes, recrutados por
convite direto do dono — não é uma força de vendas pública.

## Modelo de funcionamento

Uma única tabela de conta (`anunciantes`) pode acumular até três papéis:
**anunciante** (quem paga pra anunciar, papel de nascença de toda conta),
**ponto** (quem cede o comércio, entra por candidatura aprovada pelo dono) e
**vendedor** (quem indica, entra só por convite direto do dono — nunca
self-service). Uma conta pode ter os três papéis ao mesmo tempo. O painel é
único (`/anunciante/painel.html`, chamado de "Painel" desde 19/09/2026); cada
papel adicional tem sua própria tela (`ponto.html`, `vendedor.html`), sem
aba própria no menu (ver `DECISIONS.md` — mudança de 19/09/2026).

## Como funcionam os painéis/totens DOOH

- Cada comércio (**ponto**) tem uma ou mais **telas** (`dispositivos`) — TVs
  rodando um navegador em modo quiosque abrindo `/player.html?tela=<id>`.
- A tela se autentica por uma **chave de aparelho** gravada no navegador
  (nunca usuário/senha — veto explícito em `CONSTRAINTS.md`), gerada uma vez
  pelo admin.
- A cada 15 minutos o player busca a playlist da hora corrente
  (`GET /playlist/:dispositivoId`) e a toca em sequência.
- A hora é um **orçamento de 3600 segundos**, repartido entre: (1) as
  exibições que os anunciantes contrataram (frequência do plano + déficit
  acumulado), (2) a cota de autoanúncio do dono do ponto, e (3) o que sobra
  vira a peça institucional do próprio player ("este espaço pode ser do seu
  negócio"). Ver `BUSINESS_RULES.md` pra fórmula exata.
- Um vídeo/imagem só entra na rotação depois de **aprovado por revisão
  manual do administrador** — é o único portão de moderação que existe.

## Campanhas

Não existe o conceito de "campanha" separado do plano — o anunciante assina
um **plano** (preço + frequência/segundos por hora + quantos pontos cobre) e
o vídeo aprovado roda continuamente enquanto o plano estiver ativo. Não há
início/fim de campanha, orçamento por campanha, nem segmentação — é
assinatura recorrente, não veiculação avulsa (com uma exceção: "pedidos
avulsos", usados hoje só no fluxo de troca de plano — ver `docs/api.md`).

## Criativos

Vídeo (3 a 60s, até 95 MB) ou imagem — a imagem é convertida em vídeo real
via `ffmpeg` na duração máxima que o plano permite (não um valor fixo).
Cada criativo passa por `pendente → aprovado/reprovado` no admin. Rotação
entre criativos da mesma conta gira o ponto de partida a cada hora (corrigido
19/09/2026 — ver `docs/teia.md`, "Revezamento entre criativos").

## Planos

Escada de planos (hoje: Inicial/Básico/Essencial/Pro/Prime, mais variações
de comodato para pontos) definida inteiramente no banco (tabela `planos`),
nunca em variável de ambiente (veto explícito). Cada plano define: preço,
segundos de tela por hora, quantos pontos da rede cobre, duração máxima de
peça, limite de criativos simultâneos, e se o preço fica travado pra quem
assinou naquele valor.

## Dashboard do cliente (Painel)

`/anunciante/painel.html` — KPIs de exibições (formato "concluídas / total
contratado no mês"), custo por exibição (preço fixo, não pelas exibições
realizadas), banco de horas, gráficos de exibição por dia/por ponto, upload
de criativo, escolha de em quais pontos o anúncio aparece, gerenciamento do
plano. Bloqueado por um card de ativação enquanto a conta não tem plano.
No fim da página, um card simplificado convida a se candidatar a ponto (ver
`DECISIONS.md`).

## Principais fluxos

1. **Anunciante**: cadastro → escolhe plano → paga (San Checkout) → sobe
   criativo → admin aprova → entra na rotação de todas as telas que o plano
   cobre.
2. **Ponto**: conta já existe (nasce anunciante) → se candidata a ponto pelo
   card no fim do Painel → dono avalia e libera → ganha o papel `ponto` e a
   primeira tela → admin cadastra telas extras, gera chave de aparelho.
3. **Vendedor**: fala direto com o dono → recebe convite → cupom de indicação
   → indicado assina e paga → comissão gerada automaticamente.
4. **Tela**: abre o player com a chave → busca playlist a cada 15 min →
   confirma cada exibição tocada (`POST /player/:id/played`) → contador
   compara programado vs. confirmado (déficit vira prioridade na hora
   seguinte).

## Terminologia

| Termo | Significado |
|---|---|
| Conta / anunciante (tabela) | Qualquer usuário cadastrado — nome histórico da tabela, nunca renomear (veto) |
| Papel (`papeis`) | anunciante / ponto / vendedor — uma conta pode ter mais de um |
| Ponto | O comércio/endereço que cede parede |
| Tela / dispositivo | Uma TV específica dentro de um ponto (um ponto pode ter várias) |
| Playlist da hora | Sequência de itens que uma tela toca numa hora específica |
| Peça institucional | Item de preenchimento quando sobra inventário não vendido |
| Banco de horas | Saldo de exibições que faltaram entregar num mês, com prioridade pra recuperar depois |
| Cobertura | Quantos dos pontos que o plano promete a rede realmente tem hoje |
| Congelamento da hora | Mecanismo de 19/09/2026 que fixa a playlist de uma hora na primeira geração (ver `DECISIONS.md`) |
| Comodato | O contrato/benefício oferecido ao dono do ponto em troca da parede |

## Funcionalidades existentes (confirmadas no código)

Cadastro/login de conta única, papéis múltiplos, planos configuráveis no
banco, assinatura e troca de plano via San Checkout, upload e aprovação de
criativo, geração de playlist por hora com orçamento de segundos, banco de
horas com apuração mensal, escolha de pontos pelo anunciante com sorteio
estável para quem não escolhe, cota de autoanúncio do dono do ponto,
comissão de vendedor, indicações com cupom e crédito de upgrade, dashboard
com KPIs e gráficos, painel administrativo completo (contas, candidaturas,
convites, pontos, telas, criativos, dinheiro, banco de horas).

## Funcionalidades planejadas / fora de escopo hoje

Ver `docs/proximas-versoes.md` para o que é "depois" e `CONSTRAINTS.md` para
o que é veto permanente (programática/RTB, câmera de audiência, app nativo,
white-label, segunda cidade sem contrato fechado, etc.).

## Estado geral

Estação 5 (Construção) da esteira San & Co., aberta em 14/09/2026, no ar em
produção desde 15/09/2026. Falta a rodada de depuração da seção F de
`docs/PENDENCIAS.md` (o dono revisa o produto no ar e reporta ajuste) para
fechar a estação — ver `.ia/PROJECT_STATE.md` para o detalhe atual.
