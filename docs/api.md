# API do Mostraí — contrato v2

Servidor Express único: serve o site estático (`public/`) e a API na mesma origem. JSON em tudo; erro vem como `{ "erro": "texto em português" }` com o status HTTP certo (400 dado inválido, 401 sem sessão/chave, 403 sessão de outra conta, 404 não achou, 409 conflito, 410 caminho desativado, 429 muitas tentativas).

Autenticação, três tipos:

- **Sessão de conta** (cookie httpOnly, tabela `session` no Postgres) — criada por `POST /anunciantes/login` ou por cadastro. Uma conta pode ter os papéis `anunciante`, `ponto`, `vendedor` (campo `papeis`).
- **Sessão de admin** (mesmo cookie, flag separada) — `POST /admin/login`. Tudo em `/admin/*` exige. Em produção a porta é o Cloudflare Access; a senha é segunda camada.
- **Chave de aparelho** — header `X-Aparelho-Id` (ou `?chave=` na playlist). Identifica UMA tela (`dispositivos.aparelho_id`). Só dá acesso ao que é daquela tela.

Rate limit no banco (10 por 15 min por IP+rota, migration 051 — não é mais `Map` em memória) em: login, cadastro, candidatura, esqueci-senha, confirmação de e-mail, PIN da tela.

## Público (sem login)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/health` | `{ok:true}` |
| GET | `/planos` | Planos ativos pra vitrine, exceto os com `vagas_restantes = 0`. Campos: `segundos_por_hora`, `pontos_incluidos`, `duracao_maxima_segundos`, `limite_criativos`, `vagas`, `vagas_restantes`, `desconto_comodato_percentual`, `beneficios`, `valor_mensal_cheio`, `desconto_percentual` (preço riscado só aparece com desconto > 0, migration 040). **Horas de tela por mês, minutos por hora, número de pontos e duração da peça NÃO vêm prontos daqui** — a vitrine calcula dos campos acima (`public/planos.page.js`), pra não existir texto que envelhece quando alguém muda um número. `beneficios` traz só o que é qualitativo. `preco_travado` saiu na migration 046; fundador não é plano de catálogo desde a 033 — é status de conta. (`meses_gratis` e `minimo_telas_ativas` sairam na 021.) |
| GET | `/planos-ponto` | Opções de comodato (ajuda de custo × mais cota). |
| GET | `/pontos` | Pontos ativos (nome, endereço, cidade) pra página "Onde estamos". |
| GET | `/pontos/fluxo` | `{pessoasPorMes}` somando o fluxo estimado dos pontos ativos. |
| GET | `/categorias` | Segmentos do cadastro. |
| POST | `/candidaturas` | **410** — candidatura sem conta foi aposentada (18/09/2026, RN-03). Ponto se pede de dentro do painel de uma conta já criada; vendedor não tem pedido, só contato direto. |
| GET | `/convites/:token` | O que um link de convite permite: `{papeis, nome_sugerido, email_sugerido, expira_em}`. 404 se usado/expirado. |
| POST | `/anunciantes/cadastro` | Cria conta, sempre liberada na hora (`status = 'comum'`; não há mais aprovação de conta, RN-34/RN-35 — `status` só distingue comum de parceiro, nunca bloqueia). Sem `convite`: papel `anunciante`, exige endereço comercial. Com `convite` (token): papéis do convite, `chave_pix` obrigatória se vendedor, `plano_ponto_id` opcional se ponto; convite vindo de candidatura de ponto já cria o ponto + "Tela 1". Loga a sessão e devolve a conta. |
| POST | `/anunciantes/login` | `{email, senha}` → conta (com `papeis`). Senha em scrypt; hash bcrypt antigo migra sozinho no login. |
| POST | `/anunciantes/esqueci-senha` / `/redefinir-senha` | Fluxo de token por e-mail. `/afiliados/esqueci-senha` é alias legado. |
| POST | `/contato` | Formulário de contato → e-mail. |
| POST | `/seja-um-ponto` | **410** — legado. O caminho é criar conta e pedir o modo ponto de dentro do painel (`POST /conta/modos/ponto/pedir`). |
| POST | `/afiliados/cadastro` · `/afiliados/login` · `/afiliados/logout` | **410** — vendedor virou papel da conta única (migration 019). Use `/anunciantes/cadastro` e `/anunciantes/login`. |
| POST | `/webhook/san-checkout` | Fail-closed: exige assinatura HMAC válida (`X-Checkout-Signature` + `X-Checkout-Timestamp`, segredo = `SAN_CHECKOUT_KEY`, janela de 300s, corpo cru — API.md 4.3.1 do Checkout). Recebe os dois formatos do Checkout, diferenciados por `tipo` (payload de pedido não tem esse campo). **Assinatura**, 7 eventos (`criada`, `cobranca_confirmada`, `cobranca_falhou`, `cobranca_estornada`, `cobranca_contestada`, `cancelada`, `plano_trocado`): idempotente por `chargeId|status`, buscada na rota de conciliação 5.3; `criada`/`cobranca_confirmada` creditam o ciclo numa transação; `cancelada` marca a assinatura; `cobranca_contestada` suspende a conta na hora (RN-54) e vira pendência; `plano_trocado` é no-op — a troca já foi aplicada de forma síncrona por `POST /anunciantes/me/trocar-plano` (RN-52), o webhook chega só de confirmação; os demais eventos viram pendência. **Pedido avulso** (migration 041, hoje só histórico — RN-52 aposentou este caminho pra troca de plano): idempotente pelo `chargeId` do próprio corpo; `confirmado` aplica a troca (cancela a assinatura antiga, ativa o plano novo); `recusado`/`vencido`/`chargeback`/`estornado` cancela o pedido. |
| GET | `/plano/:assinaturaId` | Consulta do San Checkout (header `X-Checkout-Key`). Serve assinatura com status `ativa` OU `pendente_troca` (RN-52 — a linha nova de uma troca em andamento precisa responder preço antes de confirmada). |
| GET | `/pedido/:id` | Consulta de pedido avulso pelo San Checkout (header `X-Checkout-Key`). Só histórico (ver acima) — nenhum pedido novo nasce por aqui desde 17/09/2026. |

## Conta logada (`credentials: 'include'`)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/anunciantes/me` | A conta: `papeis`, `status`, `plano_id`, `plano` (o objeto do plano assinado, com `duracao_maxima_segundos`, `pontos_incluidos` e `segundos_por_hora` — é o que o painel usa pra dizer o limite de duração e montar a escolha de pontos), `data_expiracao`, `plano_cortesia`, `comunicacoes_revogado_em`, `dados_opcionais_apagados_em`, `email_confirmado` (migration 061 — front mostra aviso em toda página de conta enquanto `false`), e `vendedor` (perfil) quando tem o papel. (`meses_gratis_creditados` e `meses_cobertura_pendentes` sairam do banco na migration 021.) |
| GET | `/anunciantes/me/pontos-disponiveis` | Os pontos `em_operacao` **e `a_instalar`** pra tela de escolha (RN-49: ponto em instalação já é vaga do plano): `limite` (`planos.pontos_incluidos`), `escolhidos` (ids), `pontos[]` com `nome`, `cidade`, `endereco`, `status`, `escolhido`, `ocupacao` (0-100, quanto dos 3600s daquele ponto já está vendido) e `bloqueado` (RN-55 — cruzou 80% e parou de aceitar escolha nova; nunca `true` pra um ponto que a conta já tinha escolhido), e `cobertura` com o bônus da RN-49, sempre em horas por mês (a unidade que o cliente comprou; segundos por hora é unidade de motor e não sai daqui) — `contratados`, `veiculando`, `horas_contratadas`, `horas_sem_compensacao`, `horas_hoje`, `compensando`. 400 se a conta não tem plano. Reavalia o bloqueio (RN-55) antes de responder. |
| PUT | `/anunciantes/me/pontos` | ⚠️ Mesmo caminho do `POST` abaixo, sentido diferente: o `POST` é o DONO DE PONTO cadastrando um endereço novo, o `PUT` é o ANUNCIANTE escolhendo onde aparece. Separa o verbo, não o caminho. Troca a escolha inteira: `{pontos:[id,...]}`. Numa transação — metade salva deixaria a conta numa cobertura que ela não escolheu. 400 se passar do limite do plano ou se algum ponto não existir na rede (`em_operacao` ou `a_instalar` — RN-49). 409 se algum ponto NOVO na lista (que a conta ainda não tinha) estiver travado por ocupação (RN-55) — `{erro, pontosBloqueados:[id,...]}`; manter um ponto que já era seu, mesmo travado, não é recusado. Lista vazia devolve a conta pra distribuição automática (RN-42, que também pula pontos travados). |
| PATCH | `/anunciantes/me` | Edita dados de contato/endereço. |
| POST | `/anunciantes/me/foto` | Foto de perfil (multipart `arquivo`). |
| POST | `/anunciantes/me/excluir` | Soft-delete (60 dias recuperável pelo admin). |
| POST | `/anunciantes/me/confirmar-email` | `{codigo}` (6 dígitos, migration 061) → `{ok}`. 400 se errado/expirado (validade 2min — pedido do dono, 19/09/2026). Não bloqueia login nem uso da conta — só marca `email_confirmado=true` e faz o aviso sumir do front. |
| POST | `/anunciantes/me/reenviar-codigo-email` | Gera e manda um código novo (invalida o anterior); no-op silencioso se já confirmado. |
| POST | `/anunciantes/logout` | Destrói a sessão. |
| POST | `/anunciantes/:id/assinar` | `{planoId}` → `{checkoutUrl}`. Recusa plano fundador com programa fechado ou sem vaga. |
| POST | `/anunciantes/me/cancelar-assinatura` | Cliente cancela a própria assinatura (migration 041, 16/09/2026). Cobertura já paga continua até `data_expiracao`. 400 sem assinatura ativa. |
| POST | `/anunciantes/me/trocar-plano` | `{planoNovoId}` → `{ok, valor, ciclo, acerto}`. Síncrono (RN-52, `POST /trocar-plano` do Checkout, 17/09/2026 — aposenta o pedido avulso pra este fim; sem `checkoutUrl`, não há redirecionamento nem pop-up). 400 sem plano pago ativo, plano cortesia, cobertura vencida, ou trocando pro mesmo plano; 409 sem assinatura ativa no Checkout. Cria a linha nova em `pendente_troca`, chama o Checkout, que cobra o acerto proporcional no cartão salvo ANTES de mudar o plano. Em erro (402/409/502… do Checkout), apaga a linha pendente e devolve o erro dele, sem tocar em nada mais. Em 200: numa transação, marca a linha antiga `trocada`, a nova `ativa`, atualiza `anunciantes.plano_id`, e só grava `cobrancas_confirmadas` (com `plano_anterior_id`) se `acerto.cobrado` — downgrade sem cobrança não gera essa linha (ver `GET /admin/pedidos-avulsos`). Falha ao gravar depois de já ter cobrado no Checkout → 502 e pendência pro admin, nunca finge que a troca não aconteceu. |
| GET/POST/DELETE | `/anunciantes/:id/criativos[/:criativoId]` | Criativos do anunciante (upload multipart, normalização por ffmpeg, fila de aprovação). POST 400 sem `plano_id` (19/09/2026 — antes liberava 1 criativo sem plano pra não travar quem estava no meio do cadastro; o dono pediu pra travar de vez, a tela some com o upload nesse estado). |
| GET | `/anunciantes/:id/exibicoes` | O que rodou pro anunciante, por ponto e por dia. `porDiaPonto` (19/09/2026) é `porDia` cruzado com ponto — `{dia, ponto_id, ponto_nome, confirmadas}`, sem `LIMIT` — pra empilhar o gráfico "Exibições por dia" por cor de ponto no front. `porPonto` também traz `ultima_vez_online` de cada dispositivo, pro front montar o badge online/offline (mesmo limiar `HORAS_OFFLINE_ALERTA` do admin). `cobrancas` não traz mais nota fiscal (19/09/2026 — nenhuma é emitida hoje; quando for possível, o envio será automático por e-mail, não um link nesta lista). Não existe mais `porHora` (chegou a existir por um dia, 19/09/2026, pra um gráfico "Exibições por horário" — pedido do dono foi retirar o painel de vez). Com plano ativo, também devolve `confirmadasMes`, `horasContratadasMes`/`horasEntreguesMes` (ilustrativo, mesma aproximação do banco de horas), `exibicoesContratadasMes`/`exibicoesRestantesMes` (o contratado e o que falta no mês, em exibições — não em horas), `mediaDiariaMes` e `custoPorExibicao` (valor mensal pago ÷ `exibicoesContratadasMes` — pedido do dono, 19/09/2026: por hora "parece caro", por exibição "parece barato", mesmo valor de fundo; divide pelo CONTRATADO, não pelo confirmado, pra ser um preço fixo desde o dia 1, não um número que sobe e desce conforme o mês roda; `null` em cortesia ou sem plano). Todos os campos que dependem de plano vêm `null` sem plano. |
| GET | `/anunciantes/:id/exibicoes.csv?dias=N` | Comprovante de veiculacao em planilha (RN-19). `dias` entre 1 e 365, padrao 30. |
| GET | `/anunciantes/:id/pontos` | Pontos da conta (papel `ponto`). |
| POST | `/anunciantes/me/pontos` | Dono de ponto cadastra outro endereço (entra como `lead`, com Tela 1). |
| GET | `/anunciantes/me/indicacoes` | Créditos de indicação do dono de ponto (migration 062, 19/09/2026): `{codigo, creditos, tierGanho, proximoTier, faltam}`. `codigo` (prefixo `PT-`) é `null` sem papel `ponto` ainda. `tierGanho` é o tier de anúncio mais alto que já foi liberado de graça por indicação (`essencial` a partir de 3 comerciantes indicados que pagaram, `destaque` a partir de 7, `maximo` a partir de 10 — nunca comissão em dinheiro, isso já existe pra vendedor por outro mecanismo). `proximoTier`/`faltam` somem quando já bateu o Máximo. |
| GET | `/anunciantes/:id/dispositivos` | Telas dos pontos da conta, com exibições/anunciantes em 30 dias e `ponto_status`. |
| GET | `/anunciantes/:id/dispositivos/:dispositivoId/painel` | O que rodou naquela tela: `{porAnunciante, porDia}`. |
| POST | `/anunciantes/:id/dispositivos/:dispositivoId/pin` | Dono do ponto define o PIN da própria tela (guardado com hash, mesma regra do `/admin/dispositivos/:id/pin`). |
| GET | `/anunciantes/me/banco-horas` | Saldo do banco de horas (G.3, RN-53): `{saldo, segundos, linhas:[{mesReferencia, saldo}]}`, só linhas `status='ativo'` — o que ainda pode virar prioridade na próxima geração de playlist. `segundos` é `saldo × duração atual da peça` — ilustrativo pra virar tempo na tela (18/09/2026), não o dado que a apuração usa; `saldo` (exibições) é o número exato. Nunca mostra saldo de outra conta, nem linha já drenada ou em fila de crédito. |
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
| GET | `/conta/modos` | `{papeis, modos:{anunciante:{liberado, precisaEndereco}, ponto:{liberado, pedido}, vendedor:{liberado, pedido}}, bonus:{ponto, anuncio}}` — o que o painel usa pra desenhar as três abas e os cards de bônus. `vendedor.pedido` fica sempre `null` daqui pra frente (18/09/2026) — só existe pra linha antiga de quem pediu antes disso. |
| POST | `/conta/modos/anunciante` | Ativa o modo anúncios na própria conta: exige `endereco, cidade, uf, cep` (aceita `categoria_id`/`categoria_livre`). Acrescenta o papel. |
| POST | `/conta/modos/ponto/pedir` | Pedido de tela de dentro do painel → candidatura `origem=painel` com `conta_id` (`nome_comercio`, `endereco`… obrigatórios; `plano_ponto_id` opcional). 409 se já houver pedido em análise. E-mail de aviso pro dono (`enviarCandidaturaNova`), fire-and-forget. |
| POST | `/conta/modos/vendedor/pedir` | **400** — aposentado em 18/09/2026 (RN-03). Vendedor não pede mais: fala direto com o dono, que gera o convite à mão. |
| POST | `/convites/:token/aceitar` | Conta logada aceita um convite: os papéis novos entram nesta conta (vendedor exige `chave_pix`; ponto vindo de candidatura cria ponto + Tela 1). Consome o convite. |
| POST | `/conta/bonus/anuncio/resgatar` | Módulo "anúncio grátis após N meses como ponto" (`planos_ponto.plano_bonus_*`): quando `bonus.anuncio.disponivel`, ativa o plano na conta por M meses sem cobrança (papel anunciante entra junto). 409 se já houver plano ativo. |

Admin: `POST /admin/candidaturas/:id/liberar` — candidatura com `conta_id` (origem painel/bônus) liga o papel direto na conta (cria perfil de vendedor ou ponto + Tela 1) e marca `aprovada`.

## Tela (chave de aparelho)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/playlist/:dispositivoId` | A HORA INTEIRA desta tela: 3600 segundos de itens `{anuncianteId, url, duracaoSegundos, autoanuncio, institucional}`. Exibição contratada primeiro, cota do dono depois, e o espaço vago preenchido com `institucional: true` (sem url — o player mostra a peça `#vazio`). Autoanúncio do dono e institucional vêm com `anuncianteId: null` e não são contados. Programa os contadores da hora. |
| POST | `/player/:dispositivoId/played` | `{anuncianteId}` — confirma uma exibição. Só aceita quem está programado nesta tela nesta hora. |
| POST | `/player/:dispositivoId/heartbeat` | Marca a tela online. |
| POST | `/player/:dispositivoId/painel` | `{pin}` → painel da tela (mesmo formato do painel do dono). Rate-limited. |

## Admin (`/admin/*`, sessão de admin)

Tudo sob `/admin` passa por `requireAdminSession` (`src/server.js`). A porta de
verdade é o Cloudflare Access; a sessão é a segunda camada (`CONSTRAINTS.md`).
**As 76 rotas estão listadas uma a uma de propósito** — contrato que só existe
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
| GET | `/admin/resumo` | filas (`criativos`, `eventos`, `anunciantes`, `pontos`, `notas`, `candidaturas`, `arrependimentos`, `contato`, `offline`, `bancohoras` — linhas `aguardando_credito` não resolvidas, G.3), financeiro (`receitaMensal`, `custoPontosMensal`, `amortizacaoMensal`, `custosFixosMensal`, **`margemMensal`**, `faturamentoPorMes`), rede (`pontosAtivos`, `telasAtivas`, `fluxoMensal`, exibições, novos), `horasOfflineAlerta`, `programaFundadorAtivo` |
| GET | `/admin/diagnostico/smtp` | Não manda e-mail nenhum — só diz se `SMTP_PASS` existe, quantos caracteres tem e se sobrou espaço no meio (senha de app do Gmail tem 16; os espaços que o Google mostra são só separação visual). Não devolve a senha nem parte dela. Também devolve `remetente` (`MOSTRAI_EMAIL_FROM`) e `destino_contato` (`MOSTRAI_EMAIL_CONTATO`, o "para" do formulário de contato) — endereços, não segredo, pra confirmar os dois lados sem ler variável no Northflank (P42, `docs/PENDENCIAS.md`). Existe porque um SMTP mal configurado só aparece tarde e por acaso (item 9, `docs/PENDENCIAS.md`). |

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
| POST | `/admin/pontos/foto-exemplo` | Foto de exemplo do "ponto completo" mostrada em `pontos.html` — ilustração genérica ao lado do mapa, não é foto de nenhum ponto real. Chave fixa no bucket (upsert sobrescreve); a URL salva leva `?v=` pra não ficar em cache. |
| GET | `/admin/pontos-ocupacao` | RN-55 (G.7): uma linha por (ponto, anunciante) — `nome_empresa`, `ponto_nome`, `segundos_por_hora` (dessa conta), `segundos_vendidos` (total do ponto), `escolha_bloqueada_em`. Reavalia o bloqueio antes de responder — é aqui que o admin de fato olha isso. |
| POST | `/admin/pontos/:id/liberar-escolha` | Libera um ponto travado pra escolha nova. 409 se ainda não sobrar `FOLGA_MINIMA_PARA_LIBERAR_SEGUNDOS` (15 min) de espaço real — sem isso o próximo anunciante a entrar travaria de novo minutos depois. |

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
| POST | `/anunciantes/me/comodato/trocar-por-tela` | **Conta logada** (papel `ponto`): troca a ajuda de custo pelo plano Essencial, em todos os pontos dela, numa transação. Mão única — VOLTAR a receber os R$ 50 só pelo `PATCH /admin/pontos/:id`, porque é despesa nova e recorrente. 400 se a conta não tem ponto ou se já trocou. |
| GET | `/anunciantes/me/pontos/extrato` | **Conta logada** (papel `ponto`): o que o dono ja recebeu de comodato, mes a mes, com resumo. |
| GET | `/admin/pontos/:pontoId/pagamentos` | lançamentos daquele ponto |
| POST | `/admin/pontos/:pontoId/pagamentos` | lança `{competencia:'AAAA-MM', valor, forma?, observacao?, pago_em?}`. Mesmo mês de novo **atualiza**, não duplica (UNIQUE da migration 022) |
| PATCH | `/admin/pagamentos-ponto/:id` | `{pago}` quita ou reabre o lançamento |

### Dinheiro
| Método | Rota | O que faz |
|---|---|---|
| GET | `/admin/cobrancas` | cobranças confirmadas |
| GET | `/admin/mensagens-contato` | caixa de entrada do formulário do site, mais recente primeiro. Traz `email_enviado` (se o aviso por e-mail chegou) e `respondida_em`. Quando `email_enviado` é `false`, esta rota é o ÚNICO lugar onde a mensagem existe |
| PATCH | `/admin/mensagens-contato/:id` | `{respondida}` — marca ou desmarca como respondida. 404 se a mensagem não existe |
| GET | `/admin/pedidos-avulsos` | trocas de plano em lista própria: quem trocou, de qual plano pra qual, o valor da diferença e a situação. Leitura pura; o pago também aparece em `/admin/cobrancas`. Desde RN-52 (17/09/2026) é um `UNION ALL` de duas origens — os `pedidos_avulsos` de antes (`pendente`/`pago`/`cancelado`) e as trocas novas, lidas de `cobrancas_confirmadas.plano_anterior_id`. **Limite conhecido, não corrigido:** downgrade sem cobrança não grava `cobrancas_confirmadas`, então não aparece nesta lista — mesma limitação que o pedido avulso sempre teve com downgrade. |
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
| PATCH | `/admin/eventos-pendentes/:id` | marca como resolvido (só arquiva — **não credita nada**) |
| POST | `/admin/eventos-pendentes/:id/aplicar` | credita o ciclo daquele evento de verdade. Confere a cobrança no San Checkout ANTES (`consultarAssinatura`): um evento de "cobrança falhou" também traz `planoId`, e sem a conferência o botão daria cobertura por dinheiro que não entrou. 400 se o evento não aponta pra assinatura conhecida, se a conta sumiu ou se já foi resolvido |
| GET | `/admin/arrependimentos` | devoluções por arrependimento, pendentes primeiro |
| POST | `/admin/arrependimentos/:id/estornado` | `{comprovante}` — fecha o pedido depois de devolver no Checkout/Asaas. 404 se já estornado |

### Banco de horas (G.3, RN-53)
| Método | Rota | O que faz |
|---|---|---|
| GET | `/admin/banco-horas` | Todas as linhas, mais recente primeiro — inclui `ativo`, `drenado` e `aguardando_credito`. |
| GET | `/admin/banco-horas/aguardando-credito` | Só a fila da válvula: linhas que passaram de `MESES_PARA_FILA_DE_CREDITO` (3, prazo meu — o dono não fixou um número) sem drenar tudo. É decisão humana daqui pra frente; a rota só mostra quem está esperando. |
| POST | `/admin/banco-horas/:id/resolver` | Marca a linha como resolvida (`resolvido_em`) — registra QUE o admin decidiu (crédito manual, desconto na próxima fatura, ou nada), nunca decide o quê nem move dinheiro sozinho. 404 se a linha não existe ou já foi resolvida. |
