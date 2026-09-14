# CONSTRAINTS — Mostraí

O que este projeto **não** faz, com o porquê, e os limites que assume.
Item desejado para depois não mora aqui — mora em `docs/proximas-versoes.md`.

## Vetos (não construir)

- **Teto automático de pontos, fila de espera ou limite por bairro/ramo.**
  O equilíbrio entre quantidade de pontos e de anunciantes é julgamento do
  dono na aprovação de cada candidatura. Regra fixa substituiria uma decisão
  que depende de olhar bairro e ramo. (Decisão de 12/09/2026.)
- **Regras de plano em variável de ambiente.** Meses grátis, mínimo de telas,
  preço travado e vagas são campos do plano, editáveis no admin sem deploy.
  A única variável de ambiente é a chave liga/desliga do programa de fundador
  como um todo (`PROGRAMA_FUNDADOR_ATIVO`).
- **Usuário e senha na TV.** A tela se autentica por chave de aparelho,
  revogável no admin. Credencial de conta em aparelho fisicamente acessível
  num comércio de terceiro é risco sem ganho.
- **Impedir a saída do modo player por código da página.** Navegador sempre
  permite sair da tela cheia; prometer o contrário é teatro. Isso é função
  do aplicativo de quiosque instalado no stick.
- **Cadastro aberto de ponto e de vendedor.** Só por convite gerado pelo dono.
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
- **`og:image` com caminho relativo** até o domínio público estar definido.

## Exceções registradas

| Lei | Exceção | Sai quando |
|---|---|---|
| 6 (backup) | Supabase gratuito sem backup automático | plano Pro |
| 4/seguranca-san (Access) | `/admin` protegido por senha própria, não por Access | domínio no Cloudflare e Access configurado |
| 6 (RLS) | autorização só na aplicação, sem RLS no banco | decisão do dono na Estação 4 — ver `CLAUDE.md` |
