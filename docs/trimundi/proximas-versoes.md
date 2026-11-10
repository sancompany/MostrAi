# Próximas versões — Trimundi

Ideias guardadas para depois da fundação. Nada aqui está autorizado: quem
autoriza é a Estação 1 da versão seguinte. Cinco linhas por entrada. A
fonte é o pedido do dono de 09/11/2026 ("O que não construir agora") e o
ajuste do mesmo dia.

## Tela de check-in, com o link de indicação
- **O que:** a tela do operador que lê o QR, valida a entrada (uso único) e
  o resgate de benefício, com um link de indicação.
- **Por que:** sem ela o ingresso emitido não serve na porta. O link de
  indicação foi pedido pelo dono para essa tela; quem indica quem, e o que
  ganha, se define naquela etapa.
- **De onde veio:** pedido do dono, 09/11/2026 ("Interface de check-in" na
  lista do que não construir agora; link de indicação no ajuste do mesmo
  dia).
- **O que toca:** `/ticket/checkin` (hoje provisória), a tabela `checkins`
  (já existe, só a estrutura), a chave pública do QR por edição e
  `operador_permissoes`.
- **Quando vale a pena:** antes da primeira edição com cortesia ou venda
  real.

## Aplicativo de check-in que funciona sem internet
- **O que:** a mesma leitura do QR com o aparelho offline. Valida a
  assinatura com a chave pública da edição, guarda a lista de ingressos
  baixada antes e sincroniza depois.
- **Por que:** portaria sem internet para a fila; o QR já nasce assinado
  para isso (decisão 7 do Blueprint).
- **De onde veio:** pedido do dono, 09/11/2026 ("Aplicativo de check-in"),
  e o Blueprint v2, §2.7.
- **O que toca:** tela de check-in, `checkins.lido_no_aparelho_em` e um
  manifesto por edição.
- **Quando vale a pena:** na primeira edição em local sem internet
  confiável.

## Página pública de compra e o checkout
- **O que:** `/ticket/<evento>/<edição>` com os ingressos e combos à venda.
  O pedido com participante por ingresso e aceite dos termos vai para o San
  Checkout. Junto vêm o webhook com inbox, a conciliação diária, o job de
  expiração e o e-mail com o ingresso.
- **Por que:** é a venda; a fundação existe para sustentá-la.
- **De onde veio:** pedido do dono, 09/11/2026 ("Página pública de compra").
- **O que toca:** `api.md` "Reservadas", `aceites`, `pagamento_eventos`,
  contratante no Checkout, alias de e-mail e nota fiscal (`pendencias.md`).
- **Quando vale a pena:** com a fundação revisada e os itens "Antes da
  venda pública" de `pendencias.md` feitos.

## Painéis e relatórios
- **O que:** dashboard com gráficos e relatórios financeiros por edição.
- **Por que:** acompanhar venda e conciliar receita sem planilha.
- **De onde veio:** pedido do dono, 09/11/2026 ("Dashboard com gráficos
  avançados", "Relatórios financeiros complexos").
- **O que toca:** `metricas` (D1), `pedidos` e `ingressos`. A conta da
  receita já está em `modelo-de-dados.md`.
- **Quando vale a pena:** depois da primeira edição com venda pública.

## Cupons de desconto
- **O que:** código de desconto independente do combo.
- **Por que:** ação comercial pontual; o Checkout só repassa o `cupom` como
  referência, e quem calcula é a Trimundi.
- **De onde veio:** pedido do dono, 09/11/2026 ("Cupons de desconto
  independentes").
- **O que toca:** pedido (campo de desconto e limite de uso por cupom) e
  `GET /pedido` (`desconto`, `cupom`).
- **Quando vale a pena:** quando houver campanha que o combo não resolve.

## Múltiplos organizadores
- **O que:** mais de um organizador, cada um com os próprios eventos e
  acessos.
- **Por que:** abrir a plataforma para produtores além do dono (as
  "filiais" do Blueprint).
- **De onde veio:** pedido do dono, 09/11/2026 ("Gestão de múltiplos
  organizadores").
- **O que toca:** dono da edição em toda tabela, papéis de administrador e
  repasse.
- **Quando vale a pena:** com um segundo organizador real pedindo.

## Repasse financeiro automático
- **O que:** o dinheiro de cada organizador separado na liquidação
  (`split`).
- **Por que:** hoje tudo cai na conta do operador do Checkout e o repasse é
  manual.
- **De onde veio:** pedido do dono, 09/11/2026 ("Repasse financeiro
  automático").
- **O que toca:** `wallet_id` no Checkout, que pede a conta da Asaas em CNPJ
  (`API.md` §8).
- **Quando vale a pena:** com múltiplos organizadores e a conta da Asaas em
  CNPJ.

## Automações de marketing
- **O que:** e-mails e mensagens automáticas (lembrete, carrinho
  abandonado, pós-evento).
- **Por que:** recuperar venda e fidelizar.
- **De onde veio:** pedido do dono, 09/11/2026 ("Automações de marketing").
- **O que toca:** consentimento de marketing (inventário de dados, base
  legal própria), alias de e-mail e outbox.
- **Quando vale a pena:** depois da venda pública, com base de compradores
  que aceitou receber.

## Integrações externas
- **O que:** integrações com serviços de terceiros além do San Checkout.
- **Por que:** só se uma necessidade concreta aparecer; o dono pediu para
  não fazer as desnecessárias.
- **De onde veio:** pedido do dono, 09/11/2026 ("Integrações externas
  desnecessárias").
- **O que toca:** inventário de dados (subprocessador novo) e `CONSTRAINTS.md`.
- **Quando vale a pena:** com o caso concreto escrito antes.
