# Próximas versões — Mostraí

Ideias guardadas para a próxima volta da esteira. Nada aqui está autorizado;
quem autoriza é a Estação 1 da versão seguinte. Cinco linhas por entrada.
Fonte principal: pesquisa de mercado de 11/09/2026
e a de custos de 12/09
(`docs/precificacao.md`).

## Primeiro mês sem cobrança como benefício de primeira compra
- **O que:** "assine e o primeiro mês é por nossa conta" — benefício só na primeira compra, não recorrente.
- **Por que:** é o gancho de venda mais direto para quem nunca anunciou; recorrente ("pague 3, leve 4") já se resolve embutindo 25% no valor do ciclo, mas o de primeira compra não fecha por preço.
- **De onde veio:** ideia do dono, 14/09/2026, na leitura do contrato do San Checkout.
- **O que toca:** o motor de pagamento, não o Mostraí. Hoje não há caminho limpo: não existe carência nem data de início (`API.md` do Checkout, 7.5), e pausar/retomar na data certa é comando manual sobre caminho de dinheiro — se ninguém executar no dia, o assinante é cobrado e a correção é estorno.
- **Quando vale a pena:** quando o San Checkout ganhar um campo de primeira cobrança (`primeiraCobrancaEm` alimentando o `nextDueDate`, que já está no caminho dele). Enquanto isso não existir, não se promete.

## Impactos estimados e CPM no painel e na página de planos
- **O que:** mostrar ao anunciante impactos/mês e CPM, além do custo por exibição.
- **Por que:** o mercado inteiro negocia em CPM; sem isso o anunciante não compara com rádio nem Instagram e o vendedor não defende preço.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** um campo por ponto (tempo médio de permanência), fórmula, painel do anunciante e `planos.html`.
- **Quando vale a pena:** na primeira negociação em que o anunciante perguntar "quanta gente vê".

## Comprovante de veiculação em PDF
- **O que:** relatório mensal por anunciante com log de exibições por tela e data, baixável.
- **Por que:** o dashboard mostra, mas o cliente não leva nada embora; é o que destrava cliente maior e a renovação.
- **De onde veio:** pesquisa de mercado, 11/09/2026 (Progic cita como o diferencial de rede indoor).
- **O que toca:** endpoint de PDF reaproveitando o pipeline da nota fiscal; dados já existem.
- **Quando vale a pena:** ao fim do primeiro ciclo pago de um anunciante.

## Alertas ativos e cobrança falhada
- **O que:** aviso por e-mail/WhatsApp quando uma tela cai, um criativo é reprovado ou uma cobrança falha; suspensão da veiculação após N dias sem pagar.
- **Por que:** hoje o heartbeat registra e ninguém é avisado; churn silencioso é a maior perda em assinatura.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** três eventos já registrados; um disparador de e-mail e o `wa.me` manual.
- **Quando vale a pena:** na primeira tela que ficar um dia inteiro fora sem ninguém perceber.

## "A arte é por nossa conta" como serviço
- **O que:** formulário para o anunciante pedir a peça, e um card no admin para o dono entregar.
- **Por que:** padaria não tem vídeo vertical pronto; é a fricção nº 1 de conversão em self-serve local.
- **De onde veio:** pesquisa de mercado, 11/09/2026; memorize.tv inclui produção no plano topo.
- **O que toca:** formulário, aba no admin, e o campo de "incluído" no plano.
- **Quando vale a pena:** no primeiro anunciante que pagar e travar no upload.

## Venda por campanha (período + subconjunto de pontos)
- **O que:** contratar N semanas em telas escolhidas, com data de início.
- **Por que:** metade da demanda local é sazonal e o cliente não assina 3 meses de cara.
- **De onde veio:** pesquisa de mercado, 11/09/2026 (Aqui Ads vende a partir de 1 semana).
- **O que toca:** motor de playlist, checkout (pagamento único), pacing.
- **Quando vale a pena:** quando três clientes pedirem "só no Dia das Mães" no mesmo trimestre.

## QR rastreável por criativo e por ponto
- **O que:** link curto com QR por peça e por tela, com contagem de acessos.
- **Por que:** única atribuição viável nessa escala e argumento de renovação.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** tabela de links, redirecionador, painel do anunciante.
- **Quando vale a pena:** quando um anunciante perguntar "veio alguém por causa disso?".

## Mapa dos pontos com foto real na página pública
- **O que:** "Onde estamos" em mapa, com foto da tela instalada e perfil do público.
- **Por que:** todo self-serve é map-based; o anunciante compra com os olhos.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** `pontos.html`; a foto de instalação já existe no cadastro do ponto.
- **Quando vale a pena:** com 10+ pontos ativos.

## Uptime por tela exposto ao anunciante
- **O que:** "98,7% no mês" por tela, no painel do anunciante.
- **Por que:** o heartbeat já existe; mostrar antes de perguntarem converte desconfiança em confiança.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** agregação sobre `ultima_vez_online` histórica (precisa passar a guardar histórico, não só o último).
- **Quando vale a pena:** junto do comprovante em PDF.

## Assinatura eletrônica do contrato com IP, data e hash
- **O que:** aceite registrado do contrato de comodato e do de anunciante.
- **Por que:** equipamento caro em loja de terceiro; aceite por checkbox é fraco.
- **De onde veio:** pesquisa de mercado, 11/09/2026; skill `legal`.
- **O que toca:** cadastro via convite, tabela de aceites.
- **Quando vale a pena:** antes da primeira tela instalada num comércio que não seja de conhecido.

## Kit do vendedor (proposta em PDF, pipeline de leads)
- **O que:** proposta gerada com os dados do prospect; lista de leads do vendedor.
- **Por que:** vendedor sem material vende mal e desiste.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** painel do vendedor.
- **Quando vale a pena:** no segundo vendedor ativo.

## Cupom de primeira compra reaproveitando o cupom do vendedor
- **O que:** desconto de aquisição sobre a mesma mecânica de cupom.
- **Por que:** reaproveitamento quase puro.
- **De onde veio:** pesquisa de mercado, 11/09/2026.
- **O que toca:** tabela de cupons, checkout.
- **Quando vale a pena:** na primeira campanha de aquisição paga.

## Trial de 15 dias
- **O que:** período grátis antes da primeira cobrança.
- **Por que:** memorize.tv dá 10 dias; Yeloo dá 7; o ciclo de decisão de interior é mais lento.
- **De onde veio:** pesquisa de custos, 12/09/2026.
- **O que toca:** contrato com o San Checkout (início postergado de assinatura) — depende da auditoria da última estação do Checkout.
- **Quando vale a pena:** quando o programa de fundador fechar as vagas.

## Sobretaxa de exclusividade de categoria
- **O que:** o anunciante paga a mais para ser o único do ramo na rede.
- **Por que:** em cidade pequena é o ativo comercial mais forte; o bloqueio de concorrente já existe no motor, falta cobrar por ele.
- **De onde veio:** pesquisa de custos, 12/09/2026 (+40% sugerido, sem fonte pública).
- **O que toca:** campo no plano ou na assinatura; motor já bloqueia.
- **Quando vale a pena:** quando dois anunciantes do mesmo ramo disputarem a rede.
