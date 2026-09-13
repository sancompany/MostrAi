# Vitrina → San Checkout — o que precisa ser atualizado

Documento de handoff pra quem administra o San Checkout (mesma pessoa, Bruno)
saber exatamente o que a Vitrina precisa que o San Checkout aceite/faça, pra
que a integração funcione ponta a ponta. Não é um pedido de feature nova em
cima do contrato (`INTEGRACAO.md`) — é o mapeamento de como a Vitrina *usa*
esse contrato, mais os pontos que dependiam de confirmação do seu lado.

**Status: alinhado com a v2 do San Checkout (a v1 não existe mais pra fins
deste documento — campo é `documento`, não `cpf`). Nada pendente de decisão
do lado dele pra Vitrina ir ao ar.**

## 1. Confirmado — sem precisar mexer em nada

- **`planoId` opaco.** A Vitrina manda, no campo `planoId` de
  `GET /plano/:id`, o id de uma linha da própria tabela `assinaturas` (um
  `uuid`), não um SKU de catálogo fixo. Pro San Checkout isso é só uma
  string.
- **Prefill do pagador.** `GET /plano/:id` já devolve `pagador: { nome,
  email, documento, telefone }` com os dados reais do anunciante, e o San
  Checkout já lê isso e preenche a tela automaticamente. `documento` aceita
  CPF ou CNPJ (detecção automática por tamanho do lado do San Checkout).
- **Ciclo não-mensal.** O campo `ciclo` que a Vitrina manda em
  `GET /plano/:id` (`QUARTERLY` / `SEMIANNUALLY` / `YEARLY` / `MONTHLY`)
  passa direto pra Asaas.
- **Cobrança automática recorrente.** Comportamento nativo da Asaas: valor e
  ciclo fixados na criação da assinatura, cobrando sozinha pra sempre até
  cancelar. Zero engenharia extra dos dois lados.
- **Split / `wallet_id`.** Sem `wallet_id` cadastrado, o valor cai direto na
  conta Asaas do operador do San Checkout, sem split — é o estado atual da
  Vitrina (subconta ainda não existe). Quando a wallet da Vitrina existir
  (depois da ME abrir), é só cadastrar o `wallet_id` no admin do San
  Checkout — nenhum código muda dos dois lados.
- **Taxa do San Checkout em assinatura: R$0**, definitivo.
- **Formato do cancelamento** (seção 4) e **payload do webhook** (seção 3):
  confirmados campo a campo.

## 2. Como a Vitrina responde `GET /plano/:planoId`

```json
{
  "planoId": "8f2b...uuid da assinatura",
  "nome": "Destaque — 6 meses",
  "descricao": "Vitrina — Destaque, ciclo de 6 meses",
  "valor": 1075.20,
  "ciclo": "SEMIANNUALLY",
  "pagador": {
    "nome": "Empresa X Ltda",
    "email": "contato@empresax.com.br",
    "documento": "12.345.678/0001-90",
    "telefone": "(16) 99999-9999"
  }
}
```

- `valor` é sempre o valor **cheio do período de compromisso** (ex:
  `valor_mensal × compromisso_meses`) — nunca R$0, nunca um valor mensal
  fatiado. A Asaas cobra esse valor inteiro a cada ciclo.
- Mapa `compromisso_meses → ciclo`: `1→MONTHLY`, `3→QUARTERLY`,
  `6→SEMIANNUALLY`, `12→YEARLY`.
- `pagador.documento` hoje manda o **CNPJ** da empresa
  (`anunciantes.cpf_cnpj`) — a Vitrina também tem um bloco opcional de
  responsável pessoa física (`responsavel_nome/cpf/email/telefone`), não
  usado nesse campo hoje.

## 3. Webhook que a Vitrina espera receber

`POST {webhook_url}` com o payload do contrato pra assinatura:

```json
{ "tipo": "assinatura", "planoId": "8f2b...", "documento": "...", "evento": "cobranca_confirmada" }
```

Eventos tratados:

| evento | ação da Vitrina |
|---|---|
| `cobranca_confirmada` | estende `data_expiracao` do anunciante em `compromisso_meses`, marca `ativo` (ou `aguardando_ponto` se nenhum ponto estiver ligado ainda), grava linha em `cobrancas_confirmadas`, calcula comissão de afiliado (se houver), dispara e-mail de confirmação |
| `cancelada` | marca a assinatura como cancelada (cobertura já paga continua valendo até `data_expiracao`) |
| `criada`, `cobranca_falhou`, `cobranca_estornada` | só registrados numa fila de revisão manual do admin — sem ação automática nesta fase, pra nunca derrubar acesso de ninguém sem humano olhar |

Não há campo de valor no webhook de assinatura (diferente do webhook de
`pedido`) — a Vitrina não precisa dele, já sabe o valor pelo `plano_id` da
própria assinatura.

## 4. Cancelamento — confirmado

Só a Vitrina aciona, nunca o anunciante direto no checkout:

```
POST {SAN_CHECKOUT_BASE_URL}/cancelar-assinatura
X-Checkout-Key: ...
{ "planoId": "8f2b...", "documento": "..." }
```

## 5. Combinar manualmente quando a Vitrina for ao ar (sem código nenhum)

- `contratante_id` da Vitrina no San Checkout
- URL base da API da Vitrina
- `X-Checkout-Key` compartilhada (mesma chave nos dois sentidos)
- `webhook_url` de produção da Vitrina (`POST /webhook/san-checkout`)
- `wallet_id` da Asaas da Vitrina assim que a subconta existir

## 6. San Checkout — melhorias em andamento do lado dele (não bloqueiam a Vitrina)

1. **CPF/CNPJ no mesmo campo `documento`** — detecção automática por
   tamanho (11 = CPF, 14 = CNPJ), rótulo único "CPF/CNPJ" / "Nome ou Razão
   Social", valendo pros quatro métodos de pagamento. Já refletido neste
   documento e no código da Vitrina (seção 2).
2. **Retry de verdade no webhook** — hoje é uma tentativa só. Bom pra
   Vitrina: se o webhook falhar por instabilidade momentânea, a renovação
   automática de anúncio não acontece e ninguém percebe até reclamar. Vale
   conferir a fila `eventos_assinatura_pendentes` do admin de vez em quando
   enquanto isso não sobe.
3. **Rótulos de ciclo no front do checkout** (trimestral/semestral/anual) —
   sem ação da Vitrina, é só o texto que o pagador vê na tela.

## 7. Melhoria opcional, não bloqueante

Prefill hoje cobre só nome/e-mail/documento/telefone. Endereço/CEP não é
pré-preenchido — o anunciante digita na tela do checkout. Dá pra estender
`GET /plano/:id` com um bloco `endereco` se algum dia valer a pena
automatizar isso também; não é pedido agora.
