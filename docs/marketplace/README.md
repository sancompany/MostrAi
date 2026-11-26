# Marketplace de Lojas — porta de entrada

Lojas de terceiros (empresas de mídia, donos de painel, totem ou tela) com
vitrine pública dentro da Mostraí, pagando um plano de loja à Mostraí.
Decisão do dono em 26/11/2026; exceção registrada no `CONSTRAINTS.md`
("Exceções registradas"). Auditoria e plano completos: os relatórios de
26/11/2026 (`AUDITORIA-MARKETPLACE-LOJAS-2026-11-26.md`, fora do repositório).

## Estado

| Etapa | Situação |
|---|---|
| 1 — Linha de base | Suíte de `main` em `1f98b56`: 1366/1366 |
| 2 — Filtro central `loja_id IS NULL` nas 15 consultas que vazam | **não feita** — não é necessária enquanto nenhum espaço de loja vira `pontos`/`dispositivos` (modo Completo) |
| 3 — Lojas, planos e assinaturas da loja, vitrine e contato | **feita** (migration 123, `src/lojas/`) — desligada sem `MARKETPLACE_ATIVO=1` |
| Telas de loja no player (modo Completo) | não feita — exige a Etapa 2 antes |
| Venda ao comprador, pedido, split | **vetada** até a V2 do San Checkout (conta PJ, subcontas) |
| Cobrança do plano de loja pelo San Checkout | não feita — o pagamento é registrado pelo Admin |
| Páginas públicas (`/loja/:slug`, `/marketplace`) e telas do Admin/conta | não feitas — só a API |

## Regras (o que o código garante)

- **Isolamento da rede própria.** Tabelas próprias: `planos_loja`,
  `lojas`, `assinaturas_loja`, `assinaturas_loja_pagamentos`,
  `lojas_espacos`, `lojas_contatos`, `lojas_eventos`.
  - Nada lê ou escreve `planos`, `assinaturas`, `ciclos_contratados`,
    `obrigacoes_veiculacao`, `pontos`, `dispositivos` ou a playlist.
  - A única linha da Core que muda é `anunciantes.papeis`, que ganha o
    rótulo `loja`.
  - Prova: `tests/marketplace-lojas.test.js`, teste "rede própria intacta".
    A mesma tela e hora geram a mesma playlist antes e depois de existirem
    lojas, e a conta anunciante que vira loja não ganha plano, assinatura,
    ciclo nem obrigação.
- **Plano de loja** (`planos_loja`):
  - **Mensal**, ou **Anual+** com 12 meses ou mais. Valores definidos no
    Admin; nenhum vem de migration.
  - `taxa_percentual` é o valor contratado para quando houver venda; nesta
    versão nada é cobrado por ele.
- **Assinatura** (`assinaturas_loja`):
  - copia o plano na hora;
  - o fim é início + prazo − 1 dia (o último dia é inclusivo, no relógio de
    Matão);
  - uma ativa por loja; a renovação só depois de vencer, e a vencida vira
    `encerrada`;
  - pagamento registrado pelo Admin estende `pago_ate` e é imutável.
- **Vitrine.** A loja aparece quando:
  - está `ativa`;
  - a conta não está suspensa nem excluída;
  - a assinatura está ativa e vigente hoje;
  - o último dia pago + a tolerância (`dias_tolerancia`) não passou.

  Fora disso ela some sozinha, sem tarefa agendada. A `situacao` calculada
  diz o porquê: `na_vitrine`, `rascunho`, `suspensa`, `encerrada`,
  `conta_indisponivel`, `sem_assinatura`, `aguardando_inicio`, `vencida`,
  `inadimplente`.
- **Vitrine pública** mostra só o que é da vitrine: nunca documento, razão
  social, conta nem contrato.
- **Contato** só para loja visível e espaço publicado dela. Fica com a loja
  e o Admin. Dado de terceiro: fora da exportação da conta da loja
  (`docs/inventario-de-dados.md`).

## Rotas

`docs/api.md`, seção "Marketplace de Lojas".

## Limites conhecidos desta versão

- **Moderação.** O Admin pausa um espaço, mas a dona pode republicá-lo: não
  há marca de "pausado pelo Admin". Para tirar de vez, suspender a loja.
- **Contato.** O limitador da Mostraí (`limiteTentativas`) conta erros por
  IP, não envios certos — o mesmo do formulário de contato do site.
- **Plano de loja.** Não é cobrado pelo Checkout: o Admin registra o
  pagamento à mão.

## Decisões do dono ainda abertas

1. Retenção dos contatos da vitrine (proposta: 12 meses, com purga).
2. Cobrar o plano de loja pelo San Checkout (assinatura de contratante próprio).
3. Páginas públicas e telas do Admin e da conta.
4. Modo Completo (tela de loja no player): só depois da Etapa 2.
5. V2 do San Checkout para a venda ao comprador.
