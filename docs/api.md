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
| GET | `/planos` | Planos ativos pra vitrine, exceto os com `vagas_restantes = 0`. Campos: `preco_travado`, `vagas`, `vagas_restantes`, `desconto_comodato_percentual`, `limite_criativos`, `beneficios`, `valor_mensal_cheio`, `desconto_percentual` (preço riscado só aparece com desconto > 0, migration 040). Fundador não é mais plano de catálogo (migration 033) — é status de conta, sem campo aqui. (`meses_gratis` e `minimo_telas_ativas` sairam do banco na migration 021.) |
| GET | `/planos-ponto` | Opções de comodato (ajuda de custo × mais cota). |
| GET | `/pontos` | Pontos ativos (nome, endereço, cidade) pra página "Onde estamos". |
| GET | `/pontos/fluxo` | `{pessoasPorMes}` somando o fluxo estimado dos pontos ativos. |
| GET | `/categorias` | Segmentos do cadastro. |
| POST | `/candidaturas` | Formulário "Seja um ponto" / "Seja um vendedor". Corpo: `tipo` (`ponto`\|`vendedor`), `nome`, `contato_telefone` obrigatórios; ponto exige `nome_comercio` e `endereco`. Não cria conta. |
| GET | `/convites/:token` | O que um link de convite permite: `{papeis, nome_sugerido, email_sugerido, expira_em}`. 404 se usado/expirado. |
| POST | `/anunciantes/cadastro` | Cria conta, sempre liberada na hora (`status = 'comum'`; não há mais aprovação de conta, RN-34/RN-35 — `status` só distingue comum de parceiro, nunca bloqueia). Sem `convite`: papel `anunciante`, exige endereço comercial. Com `convite` (token): papéis do convite, `chave_pix` obrigatória se vendedor, `plano_ponto_id` opcional se ponto; convite vindo de candidatura de ponto já cria o ponto + "Tela 1". Loga a sessão e devolve a conta. |
| POST | `/anunciantes/login` | `{email, senha}` → conta (com `papeis`). Senha em scrypt; hash bcrypt antigo migra sozinho no login. |
| POST | `/anunciantes/esqueci-senha` / `/redefinir-senha` | Fluxo de token por e-mail. `/afiliados/esqueci-senha` é alias legado. |
| POST | `/contato` | Formulário de contato → e-mail. |
| POST | `/seja-um-ponto` | **410** — cadastro aberto de ponto foi substituído por candidatura + convite. |
| POST | `/afiliados/cadastro` · `/afiliados/login` · `/afiliados/logout` | **410** — vendedor virou papel da conta única (migration 019). Use `/anunciantes/cadastro` e `/anunciantes/login`. |
| POST | `/webhook/san-checkout` | Fail-closed: exige assinatura HMAC válida (`X-Checkout-Signature` + `X-Checkout-Timestamp`, segredo = `SAN_CHECKOUT_KEY`, janela de 300s, corpo cru — API.md 4.3.1 do Checkout). Recebe os dois formatos do Checkout, diferenciados por `tipo` (payload de pedido não tem esse campo). **Assinatura**: idempotente por `chargeId|status`, buscada na rota de conciliação 5.3; `criada` (1ª cobrança) e `cobranca_confirmada` (renovação) creditam o ciclo numa transação; `cancelada` marca a assinatura; os demais eventos viram pendência. **Pedido avulso** (migration 041, só troca de plano hoje): idempotente pelo `chargeId` do próprio corpo; `confirmado` aplica a troca (cancela a assinatura antiga, ativa o plano novo); `recusado`/`vencido`/`chargeback`/`estornado` cancela o pedido. |
| GET | `/plano/:assinaturaId` | Consulta do San Checkout (header `X-Checkout-Key`). |
| GET | `/pedido/:id` | Consulta de pedido avulso pelo San Checkout (header `X-Checkout-Key`). |

## Conta logada (`credentials: 'include'`)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/anunciantes/me` | A conta: `papeis`, `status`, `plano_id`, `data_expiracao`, `valor_mensal_travado`, `plano_cortesia`, `comunicacoes_revogado_em`, `dados_opcionais_apagados_em`, e `vendedor` (perfil) quando tem o papel. (`meses_gratis_creditados` e `meses_cobertura_pendentes` sairam do banco na migration 021.) |
| PATCH | `/anunciantes/me` | Edita dados de contato/endereço. |
| POST | `/anunciantes/me/foto` | Foto de perfil (multipart `arquivo`). |
| POST | `/anunciantes/me/excluir` | Soft-delete (60 dias recuperável pelo admin). |
| POST | `/anunciantes/logout` | Destrói a sessão. |
| POST | `/anunciantes/:id/assinar` | `{planoId}` → `{checkoutUrl}`. Recusa plano fundador com programa fechado ou sem vaga. |
| POST | `/anunciantes/me/cancelar-assinatura` | Cliente cancela a própria assinatura (migration 041, 16/09/2026). Cobertura já paga continua até `data_expiracao`. 400 sem assinatura ativa. |
| POST | `/anunciantes/me/trocar-plano` | `{planoNovoId}` → `{checkoutUrl, valor, credito, custoNovo}`. Gera pedido avulso (não assinatura, que não aceita desconto) pela diferença entre o preço cheio do plano novo e o crédito dos dias que restam no atual (30 dias por mês). 400 se o crédito já cobrir o plano novo — nunca cobra zero nem devolve dinheiro. Paga a diferença, o webhook cancela a assinatura antiga e aplica o plano novo; a cobertura vale pelo período do plano novo, sem assinatura recorrente nova (precisa assinar de novo ao vencer, e a conciliação diária avisa por e-mail 7 dias antes). |
| GET/POST/DELETE | `/anunciantes/:id/criativos[/:criativoId]` | Criativos do anunciante (upload multipart, normalização por ffmpeg, fila de aprovação). |
| GET | `/anunciantes/:id/exibicoes` | O que rodou pro anunciante, por tela e por dia. |
| GET | `/anunciantes/:id/exibicoes.csv?dias=N` | Comprovante de veiculacao em planilha (RN-19). `dias` entre 1 e 365, padrao 30. |
| GET | `/anunciantes/:id/pontos` | Pontos da conta (papel `ponto`). |
| POST | `/anunciantes/me/pontos` | Dono de ponto cadastra outro endereço (entra como `lead`, com Tela 1). |
| GET | `/anunciantes/:id/dispositivos` | Telas dos pontos da conta, com exibições/anunciantes em 30 dias e `ponto_status`. |
| GET | `/anunciantes/:id/dispositivos/:dispositivoId/painel` | O que rodou naquela tela: `{porAnunciante, porDia}`. |
| GET | `/vendedor/painel` | Papel `vendedor`: `{vendedor, comissoes, totalComissionado, totalPago, totalAReceber}`. |
| PATCH | `/vendedor/me` | `{chave_pix}` — vendedor completa/troca a própria chave. |

### Direitos do titular (LGPD / CDC)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/titular/meus-dados` | Baixa a conta e tudo que ela gerou em JSON (`Content-Disposition: attachment`). Não inclui senha nem chave/PIN de aparelho. RN-24. |
| POST | `/titular/consentimento` | `{escopo:'comunicacoes', aceita}` liga/desliga divulgação; `{escopo:'opcionais'}` apaga contato do responsável e foto. Outro escopo → 400. RN-25. |
| GET | `/titular/arrependimento` | `{disponivel, motivo, prazo_ate, valor_a_estornar}` — ou `{pedido}` se já houver um. RN-26. |
| POST | `/titular/arrependimento` | Cancela no Checkout, suspende a conta e abre a devolução. 400 fora do prazo ou sem cobrança, 409 com pedido aberto, 502 se o Checkout não responder. RN-26. |

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

Tudo sob `/admin` passa por `requireAdminSession` (`src/server.js`). A porta de
verdade é o Cloudflare Access; a sessão é a segunda camada (`CONSTRAINTS.md`).
**As 66 rotas estão listadas uma a uma de propósito** — contrato que só existe
em prosa não dá para conferir contra o código, e conferir é o que a Estação 4
pede.

### Sessão
| Método | Rota | O que faz |
|---|---|---|
| POST | `/admin/login` | `{usuario, senha}` contra `ADMIN_USER`/`ADMIN_PASSWORD`, em tempo constante. Regenera a sessão. Limitado a 10 tentativas/15 min |
| POST | `/admin/logout` | destrói a sessão |

### Resumo
| Método | Rota | O que faz |
|---|---|---|
| GET | `/admin/resumo` | filas (`criativos`, `eventos`, `anunciantes`, `pontos`, `notas`, `candidaturas`, `offline`), financeiro (`receitaMensal`, `custoPontosMensal`, `amortizacaoMensal`, `custosFixosMensal`, **`margemMensal`**, `faturamentoPorMes`), rede (`pontosAtivos`, `telasAtivas`, `fluxoMensal`, exibições, novos), `horasOfflineAlerta`, `programaFundadorAtivo` |

### Entrada de gente (candidatura → convite → conta)
| Método | Rota | O que faz |
|---|---|---|
| GET | `/admin/candidaturas` | lista |
| PATCH | `/admin/candidaturas/:id` | status `nova` → `em_contato` → `aprovada`/`recusada` |
| POST | `/admin/candidaturas/:id/liberar` | libera o papel numa conta que já existe, sem gerar link |
| GET | `/admin/convites` | lista |
| POST | `/admin/convites` | `{papeis[], candidatura_id?, nome_sugerido?, email_sugerido?, validade_dias?}` → `{...convite, link}` |
| POST | `/admin/convites/:id/revogar` | invalida o link |

### Contas
| Método | Rota | O que faz |
|---|---|---|
| GET | `/admin/anunciantes` | lista |
| POST | `/admin/anunciantes` | cria conta pelo admin. Com `conta_propria: true` dispensa endereço (a rede não recebe nota de si mesma) e recusa a segunda com 409 |
| PATCH | `/admin/anunciantes/:id` | status, papéis, dados, e `conta_propria`/`frequencia_hora_propria` |
| POST | `/admin/anunciantes/:id/criativos` | sobe a peça direto na conta do cliente, **já aprovada** e marcada em `editado_pelo_operador`. A peça é feita fora do site. Teto: o do plano na conta de cliente, nenhum na conta própria |
| POST | `/admin/anunciantes/:id/liberar-plano` | `{plano_id, meses?, motivo?}` — põe a conta no ar de graça, sem assinatura nem cobrança. 409 se já houver plano pago ativo |
| POST | `/admin/anunciantes/:id/cancelar-assinatura` | chama o Checkout. Mesma ação de `POST /anunciantes/me/cancelar-assinatura`, pelo admin em nome do cliente (16/09/2026: o pagador também pode cancelar sozinho, ver Conta logada) |

### Pontos e telas
| Método | Rota | O que faz |
|---|---|---|
| GET | `/admin/pontos` | lista |
| POST | `/admin/pontos` | cria |
| PATCH | `/admin/pontos/:id` | status, endereço, ajuda de custo, cota |
| POST | `/admin/pontos/:id/foto` | foto do comércio |
| GET | `/admin/pontos-offline` | telas sem sinal além do limite |
| GET | `/admin/pontos/:pontoId/dispositivos` | telas do ponto |
| POST | `/admin/pontos/:pontoId/dispositivos` | cria tela |
| GET | `/admin/dispositivos` | todas as telas |
| PATCH | `/admin/dispositivos/:id` | apelido, status, custo, prazo de amortização |
| DELETE | `/admin/dispositivos/:id` | remove |
| POST | `/admin/dispositivos/:id/chave` | gera a chave de aparelho e devolve o link do player |
| POST | `/admin/dispositivos/:id/pin` | define o PIN (guardado com hash) |
| GET | `/admin/dispositivos/:id/painel` | o mesmo painel que o PIN abre, visto pelo admin |
| POST | `/admin/pontos/:id/aparelho` | **410** — a chave é por TELA desde a migration 019. Use `POST /admin/dispositivos/:id/chave`. |

### Catálogo
| Método | Rota | O que faz |
|---|---|---|
| GET | `/admin/planos` | os 12 da grade + o fundador, ativos e desativados |
| POST | `/admin/planos` | nova versão de preço/promoção — não mexe no que já existe |
| PATCH | `/admin/planos/:id` | **só campo de vitrine** (`ativo`, `vagas`, `rotulo`, `destaque_no_site`) — não alcança quem já assinou. Campo de contrato responde 409 apontando a rota abaixo. Máximo 3 ativos por ciclo; o fundador fica fora dessa conta |
| POST | `/admin/planos/:id/nova-versao` | RN-27: cria a versão nova (id `-vN`) com os campos de contrato mudados e aposenta a atual, numa transação. 400 sem mudança nenhuma, 409 partindo de versão aposentada ou sem vaga no ciclo novo |
| GET | `/admin/planos-arquivados` | versões aposentadas, com `contas_ativas` e `cobrancas` de cada uma |
| GET | `/admin/metrica` | as três consultas salvas da métrica (funcional §9): `margem` mês a mês, `funil` e `filas`, mais `eventos` (contagem por nome, pra saber se a instrumentação está viva). Tudo com `NOT interno` |
| GET | `/admin/planos-ponto` | opções de comodato |
| POST | `/admin/planos-ponto` | cria |
| PATCH | `/admin/planos-ponto/:id` | `plano_bonus_id`, `plano_bonus_apos_meses`, `plano_bonus_meses` = módulo cruzado inverso |
| GET | `/admin/beneficios` | lista |
| POST | `/admin/beneficios` | cria |
| PATCH | `/admin/beneficios/:id` | edita |
| DELETE | `/admin/beneficios/:id` | remove |
| GET | `/admin/categorias` | lista |
| POST | `/admin/categorias` | cria |
| PATCH | `/admin/categorias/:id` | edita |
| DELETE | `/admin/categorias/:id` | remove |

### Criativos
| Método | Rota | O que faz |
|---|---|---|
| GET | `/admin/criativos` | fila de aprovação |
| PATCH | `/admin/criativos/:id` | aprova ou recusa. Só aprovado entra na playlist |

### Pagamento ao ponto (extrato)
| Método | Rota | O que faz |
|---|---|---|
| GET | `/anunciantes/me/pontos/extrato` | **Conta logada** (papel `ponto`): o que o dono ja recebeu de comodato, mes a mes, com resumo. |
| GET | `/admin/pontos/:pontoId/pagamentos` | lançamentos daquele ponto |
| POST | `/admin/pontos/:pontoId/pagamentos` | lança `{competencia:'AAAA-MM', valor, forma?, observacao?, pago_em?}`. Mesmo mês de novo **atualiza**, não duplica (UNIQUE da migration 022) |
| PATCH | `/admin/pagamentos-ponto/:id` | `{pago}` quita ou reabre o lançamento |

### Dinheiro
| Método | Rota | O que faz |
|---|---|---|
| GET | `/admin/cobrancas` | cobranças confirmadas |
| GET | `/admin/pedidos-avulsos` | trocas de plano em lista própria: quem trocou, de qual plano pra qual, o valor da diferença e a situação (`pendente`/`pago`/`cancelado`). Leitura pura; o pago também aparece em `/admin/cobrancas`. |
| PATCH | `/admin/cobrancas/:id/nota-fiscal` | marca a nota como emitida |
| GET | `/admin/comissoes` | comissões geradas |
| PATCH | `/admin/comissoes/:id` | `{pago}` |
| GET | `/admin/vendedores` | lista |
| PATCH | `/admin/vendedores/:contaId` | `status`, `comissao_percentual`, `chave_pix` |
| GET | `/admin/custos-fixos` | lista |
| POST | `/admin/custos-fixos` | cria |
| PATCH | `/admin/custos-fixos/:id` | edita |
| DELETE | `/admin/custos-fixos/:id` | remove |
| GET | `/admin/eventos-pendentes` | webhooks que chegaram e não foram aplicados, com o motivo |
| PATCH | `/admin/eventos-pendentes/:id` | marca como resolvido |
| GET | `/admin/arrependimentos` | devoluções por arrependimento, pendentes primeiro |
| POST | `/admin/arrependimentos/:id/estornado` | `{comprovante}` — fecha o pedido depois de devolver no Checkout/Asaas. 404 se já estornado |
