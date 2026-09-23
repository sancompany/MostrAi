# CONSTRAINTS — Mostraí

O que este projeto **não** faz, com o porquê, e os limites que assume.
Item desejado para depois não mora aqui — mora em `docs/proximas-versoes.md`.

## Vetos (não construir)

- **Teto automático de pontos, fila de espera ou limite por bairro/ramo.**
  O equilíbrio entre quantidade de pontos e de anunciantes é julgamento do
  dono na aprovação de cada candidatura. Regra fixa substituiria uma decisão
  que depende de olhar bairro e ramo. (Decisão de 12/09/2026.)
- **Regras de plano em variável de ambiente.** Preço travado, vagas e desconto
  são campos do plano (ou da conta, no caso do desconto de parceiro — antes
  "fundador", migration 033/038), editáveis no admin sem deploy. Não há mais
  nenhuma variável de ambiente pra regra de plano — o `PROGRAMA_FUNDADOR_ATIVO`
  que existia aqui foi removido em 15/09/2026 junto com o plano fundador de
  catálogo (ver RN-14, `docs/funcional.md`).
- **Usuário e senha na TV.** A tela se autentica por chave de aparelho,
  revogável no admin. Credencial de conta em aparelho fisicamente acessível
  num comércio de terceiro é risco sem ganho.
- **Impedir a saída do modo player por código da página.** Navegador sempre
  permite sair da tela cheia; prometer o contrário é teatro. Isso é função
  do aplicativo de quiosque instalado no stick.
- **Autodeclaração de papel `ponto` ou `vendedor`.** Ninguém ganha esses
  papéis só por pedir — sempre passa pelo dono. Ponto: a conta (já criada,
  sempre `anunciante`) pede de dentro do painel, o dono aprova e libera
  direto nela (`POST /admin/candidaturas/:id/liberar`). Vendedor: papel
  APOSENTADO em 23/09/2026 (pedido do dono) — nenhum vendedor, convite,
  cupom ou comissão nova; os registros antigos ficam no banco. Formulário
  público sem conta (`POST /candidaturas`, "Seja um ponto"/"Seja um
  vendedor") foi aposentado em 18/09/2026 — pedido do dono, pra unificar a
  entrada: toda conta nasce igual, e o papel extra vem depois, de dentro
  dela.
- **Integração programática / DSP / leilão / RTB.** Os mínimos de campanha
  dos DSPs superam a receita mensal inteira de uma rede de uma cidade.
- **Câmera contando audiência, medição por geolocalização de celular,
  segmentação com centenas de segmentos, dayparting por minuto, criativo
  dinâmico com feed, app nativo, white-label/multi-tenant, auditoria externa
  (IVC/Kantar), marketplace de telas de terceiros.** Pesquisa de mercado de
  11/09/2026: todos aparecem nos concorrentes grandes e todos seriam prejuízo
  numa operação de 25 telas. Reavaliar só com segunda cidade **contratada**.
- **Renomear a tabela `anunciantes` para `contas`.** É a tabela de contas;
  o nome é histórico. Renomear tocaria todo o sistema sem ganho funcional.
- **Playlist gerada em Edge Function.** O gerador usa cache em memória por
  processo; Edge Function não tem processo vivo (lição de ecossistema nº 4).
- **Cobrança própria.** Pagamento é sempre pelo San Checkout (estrutura).

## Regras duras

Vieram do `CLAUDE.md` em 14/09/2026, quando ele foi reduzido ao índice que a
Lei 10 pede. São regras, não limites: violar qualquer uma é defeito.

- **`anunciantes` é a tabela de contas.** Papéis em `papeis text[]`. O veto ao
  rename está acima.
- **Tela ≠ ponto.** Playlist, chave de aparelho, PIN, sinal e custo vivem em
  `dispositivos`. Ajuda de custo e cota de autoanúncio vivem no ponto, e a cota
  é dividida entre as telas dele (`dividirCota`).
- **Webhook do San Checkout: fail-closed, idempotente (`webhooks_processados`)
  e transacional.** Não afrouxar nenhuma das três. O erro que originou a regra
  está em `docs/erros/2026-09-webhook-falhava-aberto.md`.
- **Migrations são aditivas.** Drop de coluna ou tabela só com permissão
  explícita do dono, em migration própria. Migration aplicada nunca é editada;
  corrige-se com migration nova.
- **`.env` nunca entra no git.** `.env.example` documenta as chaves com valores
  fictícios. Segredo que vazou se revoga — apagar do histórico não basta, como
  13/09/2026 provou (`docs/erros/2026-09-13-env-real-em-repositorio-publico.md`).
- **O San Checkout tem dois endereços e eles não são intercambiáveis.**
  `SAN_CHECKOUT_BASE_URL` é a tela que o comprador abre; `SAN_CHECKOUT_API_URL`
  é a que o nosso servidor chama, sob `/api/checkout/<rota>`. Endereço nunca é
  montado à mão fora de `chamarApiCheckout`. Usar um só para os dois deixa um
  dos lados quebrado — foi o que aconteceu até 14/09/2026.
- **O webhook do Checkout é autenticado por assinatura HMAC, não por header
  de segredo.** Ele manda `X-Checkout-Signature: sha256=<hex>` sobre
  `"{timestamp}.{corpo cru}"` e `X-Checkout-Timestamp` em segundos, assinados
  com a **mesma `SAN_CHECKOUT_KEY`** das chamadas de saída — não existe
  `SAN_CHECKOUT_WEBHOOK_SECRET` (API.md 4.3.1). A verificação recusa timestamp
  fora de 300s, usa o corpo **cru** (reserializar o JSON muda a ordem das
  chaves e a assinatura não fecha) e compara em tempo constante. Até
  14/09/2026 conferíamos um `X-Webhook-Secret` que o Checkout nunca mandou:
  todo webhook real tomava 401 (`docs/erros/2026-09-14-webhook-autenticado-por-header-inventado.md`).
- **A primeira cobrança paga chega como `criada`, não `cobranca_confirmada`.**
  Só as renovações usam `cobranca_confirmada` (API.md 4.3.4). Os dois eventos
  creditam um ciclo e passam pela mesma dedupe; tratar só o segundo deixa todo
  assinante novo sem ativação automática.
- **Webhook de assinatura deduplica por `chargeId`, nunca pelo corpo.** O
  payload não carrega id (API.md do Checkout, 4.3.4) e o corpo de uma renovação
  é idêntico ao da anterior; o `chargeId` vem da rota de conciliação 5.3. Sem
  ele, o evento vira pendência e espera a conciliação — nunca é creditado "no
  escuro".
- **Benefício comercial se dá no preço, nunca no tempo.** A assinatura não tem
  carência, mês grátis, pular ciclo nem desconto (API.md 7.5). Desconto e
  promoção entram no `valor` que o nosso `GET /plano/{id}` devolve.
- **Plano assinado é imutável para quem assinou** *(decidido em 14/09/2026,
  ainda não construído — item 9 da spec)*. Edição de plano no admin vale só
  para novos assinantes. Precisa estar de pé antes da primeira assinatura paga.

## Limites assumidos

- **Escala declarada:** até ~30 telas e ~60 contas, só Matão-SP. Nenhuma
  decisão de arquitetura é tomada por carga. O gargalo mais provável é saída
  de dados de vídeo do storage; a mitigação (cache de arquivo no player) está
  na v2. Se ainda assim doer: mover os vídeos para Cloudflare R2 (egress zero).
- **Cache de playlist em memória do processo.** Uma instância só. Se um dia
  houver duas, mover para tabela.
- **Limitador de tentativas em memória do processo.** Mesma ressalva.
- **Supabase no plano gratuito não tem backup automático.** Enquanto o
  projeto estiver no gratuito, a Lei 6 (backup do que não pode ser perdido)
  está em **exceção registrada**. Sai da exceção no dia em que o primeiro
  anunciante pagar e o plano subir para Pro. Até lá, `scripts/backup.sh`
  existe para dump manual e o dono roda antes de qualquer migration.
- **O repositório é público, por decisão do dono** (a organização depende de
  recursos que só são gratuitos assim). Nada aqui pode supor leitor confiável:
  sem segredo, sem dado de cliente, sem host ou identificador de infraestrutura
  em arquivo versionado. Em 13/09/2026 o `.env` real chegou a ser publicado; o
  histórico foi reescrito no mesmo dia, e até a rotação registrada em
  `docs/PENDENCIAS.md` (A.0) estar marcada como feita, considere em risco a
  senha do Postgres, o `SESSION_SECRET` e o `ADMIN_PASSWORD`.

- **Ponto único de falha:** um serviço no Northflank e um banco no Supabase.
  Aceito para este porte.
- **PIN da tela tem 4 dígitos (10 mil combinações).** Protege o painel
  daquela tela contra o curioso, não contra ataque. Não dá acesso a nada
  além daquele painel. Guardado com hash mesmo assim.
- **Sessão do admin por usuário/senha continua existindo como segunda camada**
  até o `/admin` estar atrás do Cloudflare Access. Quando o Access entrar, a
  senha vira camada extra, não porta.
- **Hash de senha:** scrypt via `crypto` do Node, N=2^17, r=8, p=1 — o piso
  da Lei 3. ~128 MiB por hash em andamento; 10 logins simultâneos ≈ 1,3 GB.
  Numa instância pequena isso é o teto de logins simultâneos, e é aceito
  porque o volume real é de dezenas de contas. Hashes bcrypt existentes
  migram no primeiro login bem-sucedido (leitura compatível, escrita nova).
- **Comissão de vendedor recorrente pode caracterizar representação comercial
  (Lei 4.886/65).** Não é limite de software; é limite de operação. O contrato
  com o vendedor é decisão do dono e está fora deste repositório.
- ~~`og:image` com caminho relativo~~ — **limite fechado em 14/09/2026**: o
  domínio existe (`mostrai.sancocore.com.br`), e `og:image`, `og:url` e
  `canonical` passaram a ser absolutos nas 26 páginas.

## Exceções registradas

| Lei | Exceção | Sai quando |
|---|---|---|
| 6 (backup) | Supabase gratuito sem backup automático | plano Pro |
| 4/seguranca-san (Access) | `/admin` protegido por senha própria, não por Access | domínio no Cloudflare e Access configurado |
| 6 (RLS) | autorização só na aplicação, sem RLS no banco | decisão do dono na Estação 4 — ver `CLAUDE.md` |
