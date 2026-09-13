# API do Mostraí — contrato v2

Servidor Express único: serve o site estático (`public/`) e a API na mesma origem. JSON em tudo; erro vem como `{ "erro": "texto em português" }` com o status HTTP certo (400 dado inválido, 401 sem sessão/chave, 403 sessão de outra conta, 404 não achou, 409 conflito, 410 caminho desativado, 429 muitas tentativas).

Autenticação, três tipos:

- **Sessão de conta** (cookie httpOnly, tabela `session` no Postgres) — criada por `POST /anunciantes/login` ou por cadastro. Uma conta pode ter os papéis `anunciante`, `ponto`, `vendedor` (campo `papeis`).
- **Sessão de admin** (mesmo cookie, flag separada) — `POST /admin/login`. Tudo em `/admin/*` exige. Em produção a porta é o Cloudflare Access; a senha é segunda camada.
- **Chave de aparelho** — header `X-Aparelho-Id` (ou `?chave=` na playlist). Identifica UMA tela (`dispositivos.aparelho_id`). Só dá acesso ao que é daquela tela.

Rate limit em memória (10 por 15 min por IP+rota) em: login, cadastro, candidatura, esqueci-senha, PIN da tela.

## Público (sem login)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/health` | `{ok:true}` |
| GET | `/planos` | Planos ativos pra vitrine. Plano `fundador` só vem com `PROGRAMA_FUNDADOR_ATIVO=true` e `vagas_restantes > 0`. Campos novos: `meses_gratis`, `minimo_telas_ativas`, `preco_travado`, `fundador`, `vagas`, `vagas_restantes`. |
| GET | `/planos-ponto` | Opções de comodato (ajuda de custo × mais cota). |
| GET | `/pontos` | Pontos ativos (nome, endereço, cidade) pra página "Onde estamos". |
| GET | `/pontos/fluxo` | `{pessoasPorMes}` somando o fluxo estimado dos pontos ativos. |
| GET | `/categorias` | Segmentos do cadastro. |
| POST | `/candidaturas` | Formulário "Seja um ponto" / "Seja um vendedor". Corpo: `tipo` (`ponto`\|`vendedor`), `nome`, `contato_telefone` obrigatórios; ponto exige `nome_comercio` e `endereco`. Não cria conta. |
| GET | `/convites/:token` | O que um link de convite permite: `{papeis, nome_sugerido, email_sugerido, expira_em}`. 404 se usado/expirado. |
| POST | `/anunciantes/cadastro` | Cria conta. Sem `convite`: papel `anunciante`, status `pendente_aprovacao`, exige endereço comercial. Com `convite` (token): papéis do convite, status `aprovado`, `chave_pix` obrigatória se vendedor, `plano_ponto_id` opcional se ponto; convite vindo de candidatura de ponto já cria o ponto + "Tela 1". Loga a sessão e devolve a conta. |
| POST | `/anunciantes/login` | `{email, senha}` → conta (com `papeis`). Senha em scrypt; hash bcrypt antigo migra sozinho no login. |
| POST | `/anunciantes/esqueci-senha` / `/redefinir-senha` | Fluxo de token por e-mail. `/afiliados/esqueci-senha` é alias legado. |
| POST | `/contato` | Formulário de contato → e-mail. |
| POST | `/seja-um-ponto` | **410** — cadastro aberto de ponto foi substituído por candidatura + convite. |
| POST | `/webhook/san-checkout` | Só com `X-Webhook-Secret` correto (fail-closed). Idempotente por `eventoId`/`cobrancaId`/hash. `cobranca_confirmada` ativa a conta, trava preço (`preco_travado`), credita `meses_gratis` uma vez, registra cobrança e comissão numa transação; abaixo de `minimo_telas_ativas` a conta fica `aguardando_ponto` com os meses guardados em `meses_cobertura_pendentes`. |
| GET | `/plano/:assinaturaId` | Consulta do San Checkout (header `X-Checkout-Key`). |

## Conta logada (`credentials: 'include'`)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/anunciantes/me` | A conta: `papeis`, `status`, `plano_id`, `data_expiracao`, `valor_mensal_travado`, `meses_gratis_creditados`, `meses_cobertura_pendentes`, e `vendedor` (perfil) quando tem o papel. |
| PATCH | `/anunciantes/me` | Edita dados de contato/endereço. |
| POST | `/anunciantes/me/foto` | Foto de perfil (multipart `arquivo`). |
| POST | `/anunciantes/me/excluir` | Soft-delete (60 dias recuperável pelo admin). |
| POST | `/anunciantes/logout` | Destrói a sessão. |
| POST | `/anunciantes/:id/assinar` | `{planoId}` → `{checkoutUrl}`. Recusa plano fundador com programa fechado ou sem vaga. |
| GET/POST/DELETE | `/anunciantes/:id/criativos[/:criativoId]` | Criativos do anunciante (upload multipart, normalização por ffmpeg, fila de aprovação). |
| GET | `/anunciantes/:id/exibicoes` | O que rodou pro anunciante, por tela e por dia. |
| GET | `/anunciantes/:id/pontos` | Pontos da conta (papel `ponto`). |
| POST | `/anunciantes/me/pontos` | Dono de ponto cadastra outro endereço (entra como `lead`, com Tela 1). |
| GET | `/anunciantes/:id/dispositivos` | Telas dos pontos da conta, com exibições/anunciantes em 30 dias e `ponto_status`. |
| GET | `/anunciantes/:id/dispositivos/:dispositivoId/painel` | O que rodou naquela tela: `{porAnunciante, porDia}`. |
| GET | `/vendedor/painel` | Papel `vendedor`: `{vendedor, comissoes, totalComissionado, totalPago, totalAReceber}`. |
| PATCH | `/vendedor/me` | `{chave_pix}` — vendedor completa/troca a própria chave. |

### Painel único — modos da conta (v2.1)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/conta/modos` | `{papeis, modos:{anunciante:{liberado, precisaEndereco}, ponto:{liberado, pedido}, vendedor:{liberado, pedido}}, bonus:{ponto, anuncio}}` — o que o painel usa pra desenhar as três abas e os cards de bônus. |
| POST | `/conta/modos/anunciante` | Ativa o modo anúncios na própria conta: exige `endereco, cidade, uf, cep` (aceita `categoria_id`/`categoria_livre`). Acrescenta o papel. |
| POST | `/conta/modos/ponto/pedir` | Pedido de tela de dentro do painel → candidatura `origem=painel` com `conta_id` (`nome_comercio`, `endereco`… obrigatórios; `plano_ponto_id` opcional). 409 se já houver pedido em análise. |
| POST | `/conta/modos/vendedor/pedir` | Idem pra vendas (`cidade`, `chave_pix` opcional, `mensagem`). |
| POST | `/convites/:token/aceitar` | Conta logada aceita um convite: os papéis novos entram nesta conta (vendedor exige `chave_pix`; ponto vindo de candidatura cria ponto + Tela 1). Consome o convite. |
| POST | `/conta/bonus/ponto/resgatar` | Módulo "tela após N meses" (`planos.ponto_apos_meses`): quando `bonus.ponto.disponivel`, cria candidatura de ponto `origem=bonus_plano` e marca `ponto_bonus_resgatado_em`. Corpo igual ao pedido de ponto. |
| POST | `/conta/bonus/anuncio/resgatar` | Módulo "anúncio grátis após N meses como ponto" (`planos_ponto.plano_bonus_*`): quando `bonus.anuncio.disponivel`, ativa o plano na conta por M meses sem cobrança (papel anunciante entra junto). 409 se já houver plano ativo. |

Admin: `POST /admin/candidaturas/:id/liberar` — candidatura com `conta_id` (origem painel/bônus) liga o papel direto na conta (cria perfil de vendedor ou ponto + Tela 1) e marca `aprovada`.

## Tela (chave de aparelho)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/playlist/:dispositivoId` | Playlist da hora pra esta tela. Itens `{anuncianteId, url, duracaoSegundos, autoanuncio}`; autoanúncio do dono vem com `anuncianteId: null` e não é contado. Programa os contadores da hora. |
| POST | `/player/:dispositivoId/played` | `{anuncianteId}` — confirma uma exibição. Só aceita quem está programado nesta tela nesta hora. |
| POST | `/player/:dispositivoId/heartbeat` | Marca a tela online. |
| POST | `/player/:dispositivoId/painel` | `{pin}` → painel da tela (mesmo formato do painel do dono). Rate-limited. |

## Admin (`/admin/*`, sessão de admin)

Resumo: `GET /admin/resumo` — filas (`criativos`, `eventos`, `anunciantes`, `pontos`, `notas`, `candidaturas`, `offline`), financeiro (`receitaMensal`, `custoPontosMensal`, `amortizacaoMensal`, `custosFixosMensal`, `margemMensal`, `faturamentoPorMes`), rede (`pontosAtivos`, `telasAtivas`, `fluxoMensal`, exibições, novos), `horasOfflineAlerta`, `programaFundadorAtivo`.

Entrada: `GET/PATCH /admin/candidaturas[/:id]` (status `nova`→`em_contato`→`aprovada`/`recusada`); `GET/POST /admin/convites` (`{papeis[], candidatura_id?, nome_sugerido?, email_sugerido?, validade_dias?}` → `{...convite, link}`), `POST /admin/convites/:id/revogar`.

Operação: criativos (`GET/PATCH`), pontos (`GET/POST/PATCH`, `/foto`, `/pontos-offline`), telas (`GET /admin/dispositivos`, `GET/POST /admin/pontos/:pontoId/dispositivos`, `PATCH/DELETE /admin/dispositivos/:id`, `POST .../chave`, `POST .../pin`, `GET .../painel`), anunciantes (`GET/POST/PATCH`, `/cancelar-assinatura`), vendedores (`GET /admin/vendedores`, `PATCH /admin/vendedores/:contaId` — `status`, `comissao_percentual`, `chave_pix`).

Catálogo: planos (`GET/POST/PATCH` — máximo 3 ativos por ciclo, plano `fundador` fora dessa conta; campo `ponto_apos_meses` = módulo cruzado), benefícios, categorias, planos-ponto (`plano_bonus_id`, `plano_bonus_apos_meses`, `plano_bonus_meses` = módulo cruzado inverso).

Financeiro: cobranças + nota fiscal, comissões (`PATCH {pago}`), custos fixos (`GET/POST/PATCH/DELETE /admin/custos-fixos`), eventos pendentes do checkout.

`POST /admin/pontos/:id/aparelho` é legado (chave por ponto) — use a chave por tela.
