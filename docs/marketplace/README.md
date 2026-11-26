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
| Telas e governança do Modo Vitrine | **feita** (migration 124): trava de moderação do Admin, retenção de 12 meses dos contatos, upload de logo/foto, Admin → Lojas (lojas, planos de loja, moderação), painel da dona (`/anunciante/minha-loja`), páginas `/marketplace` e `/loja/<slug>` — tudo desligado sem `MARKETPLACE_ATIVO=1` |
| Telas de loja no player (modo Completo) | não feita — exige a Etapa 2 antes |
| Venda ao comprador, pedido, split | **vetada** até a V2 do San Checkout (conta PJ, subcontas) |
| Cobrança do plano de loja pelo San Checkout | não feita — o pagamento é registrado pelo Admin |

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
  - **Retenção: 12 meses** desde o envio, lido ou não. Expurgo de hora em
    hora (`expurgarContatosAntigos`, iniciado em `src/server.js`). O
    formulário avisa o prazo a quem escreve.
- **Moderação** (migration 124). O Admin **bloqueia** um espaço com motivo:
  - o espaço sai da vitrine na hora (`pausado`) e a dona não o republica —
    a rota dá 409 e o banco recusa (CHECK
    `lojas_espacos_bloqueado_fora_da_vitrine`);
  - ela continua editando o resto (descrição, foto) e vê o motivo no painel;
  - **liberar** só destrava: o espaço segue pausado até a dona publicar;
  - bloqueio e liberação ficam no histórico da loja (`lojas_eventos`).
- **Imagens** (logo, foto do espaço) só por upload: tipo pelos bytes, até
  5 MB, no Storage da Mostraí (a CSP só mostra imagem de lá). URL livre no
  JSON é ignorada.
- **Cadastro.** A dona preenche razão social e documento enquanto a loja
  está em `rascunho`; depois de ativa, só o Admin muda. O endereço
  `/loja/<slug>` nunca muda (link divulgado quebraria).

## Telas

- **Admin → Lojas** (`public/admin/lojas.js`; o item só aparece com a
  chave ligada, via `GET /admin/marketplace/estado`):
  - *Lojas*: lista com situação; ficha com status (ativar, suspender,
    encerrar, com motivo), cadastro e logo, contrato (criar, renovar,
    cancelar, registrar pagamento manual), espaços com bloquear/liberar,
    contatos e histórico de assinaturas, pagamentos e eventos; nova loja
    a partir da busca de conta (põe o papel `loja`).
  - *Planos de loja*: Mensal e Anual+ (criar, editar, ativar/desativar).
  - *Moderação*: todos os espaços, publicados primeiro, com bloquear/liberar.
- **Painel da dona** (`/anunciante/minha-loja`, aba "Minha loja" do
  painel da conta para quem tem o papel `loja`): situação do contrato com
  avisos (vencido, inadimplente, fora da vitrine), espaços (criar, editar,
  foto, publicar/pausar, arquivar — publicar desligado se bloqueado),
  pedidos de orçamento (lido, respondido, responder por e-mail/WhatsApp) e
  perfil (logo, nome, cor, descrição, contato, dados cadastrais).
- **Público**: `/marketplace` (filtros de cidade e tipo) e `/loja/<slug>`
  (cor e logo da loja, espaços, mapa por link do Google Maps, formulário de
  contato). Sem checkout. `public/vitrine/`, páginas em
  `src/lojas/paginas/`.

## Rotas

`docs/api.md`, seção "Marketplace de Lojas".

## Limites conhecidos desta versão

- **Contato.** O limitador da Mostraí (`limiteTentativas`) conta erros por
  IP, não envios certos — o mesmo do formulário de contato do site.
- **Plano de loja.** Não é cobrado pelo Checkout: o Admin registra o
  pagamento à mão.

## Decisões do dono ainda abertas

1. Ligar `MARKETPLACE_ATIVO=1` em produção (hoje desligado).
2. Cobrar o plano de loja pelo San Checkout (assinatura de contratante próprio).
3. Modo Completo (tela de loja no player): só depois da Etapa 2.
4. V2 do San Checkout para a venda ao comprador.
5. Termos de Uso da loja e menção da vitrine na Política de Privacidade
   (contato de terceiro, 12 meses) — texto jurídico é do dono, antes de ligar.
