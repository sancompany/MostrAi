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
| GET | `/planos` | Planos ativos pra vitrine, exceto os com `vagas_restantes = 0`. Campos: `segundos_por_hora`, `pontos_incluidos`, `duracao_maxima_segundos`, `limite_criativos`, `vagas`, `vagas_restantes`, `desconto_comodato_percentual`, `beneficios`, `valor_mensal_cheio`, `desconto_percentual` (preço riscado só aparece com desconto > 0, migration 040). **`horas_por_mes` e `exibicoes_por_mes` vêm calculados aqui** (`src/lib/pacing.js#horasDeTelaPorMes`/`exibicoesPorMes`), pra não existir uma terceira conta pro mesmo número em cada tela — `confirmar-plano.page.js` lê os dois direto da resposta; `planos.page.js` (vitrine pública) ainda recalcula os dois localmente, dos campos brutos acima, e é a mesma conta. `exibicoes_por_mes` é `0` (nunca `null`) quando o plano não declara `duracao_maxima_segundos`. `beneficios` traz só o que é qualitativo. `preco_travado` saiu na migration 046; fundador não é plano de catálogo desde a 033 — é status de conta. (`meses_gratis` e `minimo_telas_ativas` sairam na 021.) |
| GET | `/planos-ponto` | Opções de comodato (ajuda de custo × mais cota). |
| GET | `/pontos` | Pontos `em_operacao`, `a_instalar` e `em_reparo` (nome, endereço, cidade, `foto_instalacao_url`) pra página "Onde estamos" — sem foto, o front usa o placeholder oficial. Só `inativo` fica de fora (rodada final da Rede, 22/09/2026). |
| GET | `/pontos/fluxo` | `{pessoasPorMes}` somando o fluxo estimado dos pontos ativos. |
| GET | `/categorias` | Catálogo de categorias pro seletor pesquisável (22/09/2026, migration 067 — ~230 categorias específicas, era 25 amplas): `{id, nome, grupo, aliases}`. Só `ativo AND NOT legado` — categoria antiga (ampla demais, ex. "Clínica / consultório") não aparece mais aqui, mas continua bloqueando concorrente pra quem já a usa (RN-57). `grupo` é só organização visual da lista (ex. "Saúde"); `aliases` só ajudam a achar na busca ("dentista" → Odontologia). Nenhum dos dois entra na regra de bloqueio — só `categoria_id` entra (`src/playlist/gerador.js#anunciantesElegiveis`). |
| POST | `/candidaturas` | **410** — candidatura sem conta foi aposentada (18/09/2026, RN-03). Ponto se pede de dentro do painel de uma conta já criada; vendedor não tem pedido, só contato direto. |
| GET | `/convites/:token` | O que um link de convite permite: `{papeis, nome_sugerido, email_sugerido, expira_em}`. 404 se usado/expirado. |
| POST | `/anunciantes/cadastro` | Cria conta, sempre liberada na hora (`status = 'comum'`; não há mais aprovação de conta, RN-34/RN-35 — `status` só distingue comum de parceiro, nunca bloqueia). Sem `convite`: papel `anunciante`, exige endereço comercial. Com `convite` (token): papéis do convite, `chave_pix` obrigatória se vendedor, `plano_ponto_id` opcional se ponto; convite vindo de candidatura de ponto já cria o ponto + "Tela 1" — categoria da conta é copiada pro ponto (RN-57, corrigido 22/09/2026). `categoria_id`, se vier, precisa existir e estar ativa (400 "ramo inválido" — antes virava 500 na FK, achado no mapeamento da reforma de taxonomia). Loga a sessão e devolve a conta. |
| POST | `/anunciantes/login` | `{email, senha}` → conta (com `papeis`). Senha em scrypt; hash bcrypt antigo migra sozinho no login. |
| POST | `/anunciantes/esqueci-senha` / `/redefinir-senha` | Fluxo de token por e-mail. `/afiliados/esqueci-senha` é alias legado. |
| POST | `/contato` | Formulário de contato → e-mail. |
| POST | `/seja-um-ponto` | **410** — legado. O caminho é criar conta e pedir o modo ponto de dentro do painel (`POST /conta/modos/ponto/pedir`). |
| POST | `/afiliados/cadastro` · `/afiliados/login` · `/afiliados/logout` | **410** — vendedor virou papel da conta única (migration 019). Use `/anunciantes/cadastro` e `/anunciantes/login`. |
| POST | `/webhook/san-checkout` | Fail-closed: exige assinatura HMAC válida (`X-Checkout-Signature` + `X-Checkout-Timestamp`, segredo = `SAN_CHECKOUT_KEY`, janela de 300s, corpo cru — API.md 4.3.1 do Checkout). Recebe os dois formatos do Checkout, diferenciados por `tipo` (payload de pedido não tem esse campo). **Assinatura**, 7 eventos (`criada`, `cobranca_confirmada`, `cobranca_falhou`, `cobranca_estornada`, `cobranca_contestada`, `cancelada`, `plano_trocado`): idempotente por `chargeId|status`, buscada na rota de conciliação 5.3; `criada`/`cobranca_confirmada` creditam o ciclo numa transação; `cancelada` marca a assinatura; `cobranca_contestada` suspende a conta na hora (RN-54) e vira pendência; `plano_trocado` é no-op só quando a assinatura já está `ativa` (troca sem acerto, aplicada de forma síncrona por `POST /anunciantes/me/trocar-plano`) — quando ela ainda está `pendente_troca` (troca com acerto, aprovada pelo pagador na tela do Checkout desde 21/09/2026), este webhook é quem aplica a troca de verdade: marca a antiga `trocada`, a nova `ativa`, atualiza `anunciantes.plano_id` e grava `cobrancas_confirmadas` se houve cobrança (RN-52); os demais eventos viram pendência. **Pedido avulso** (migration 041, hoje só histórico — RN-52 aposentou este caminho pra troca de plano): idempotente pelo `chargeId` do próprio corpo; `confirmado` aplica a troca (cancela a assinatura antiga, ativa o plano novo); `recusado`/`vencido`/`chargeback`/`estornado` cancela o pedido. |
| GET | `/plano/:assinaturaId` | Consulta do San Checkout (header `X-Checkout-Key`). Serve assinatura com status `ativa` OU `pendente_troca` (RN-52 — a linha nova de uma troca em andamento precisa responder preço antes de confirmada). |
| GET | `/pedido/:id` | Consulta de pedido avulso pelo San Checkout (header `X-Checkout-Key`). Só histórico (ver acima) — nenhum pedido novo nasce por aqui desde 17/09/2026. |

## Conta logada (`credentials: 'include'`)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/anunciantes/me` | A conta: `papeis`, `status`, `plano_id` (plano COMERCIAL — Essencial/Pro/Prime, pago ou cortesia — nunca mais comodato desde a migration 077), `comodato_plano_id` (Inicial/Básico, independente, sincronizado pelos pontos da conta — migration 077), `plano` (o objeto do plano comercial assinado, com `duracao_maxima_segundos`, `pontos_incluidos` e `segundos_por_hora` — é o que o painel usa pra dizer o limite de duração e montar a escolha de pontos), `data_expiracao`, `plano_cortesia`, `comunicacoes_revogado_em`, `dados_opcionais_apagados_em`, `email_confirmado` (migration 061 — front mostra aviso em toda página de conta enquanto `false`), e `vendedor` (perfil) quando tem o papel. (`meses_gratis_creditados` e `meses_cobertura_pendentes` sairam do banco na migration 021.) |
| GET | `/anunciantes/me/pontos-disponiveis` | Os pontos `em_operacao`, `a_instalar` **e `em_reparo`** pra tela de escolha (RN-49: ponto em instalação já é vaga do plano; `em_reparo` entra pela mesma regra desde a rodada final da Rede, 22/09/2026 — não veicula agora, mas é real e pode voltar). Só `inativo` fica de fora. `limite` (`planos.pontos_incluidos`), `escolhidos` (ids), `pontos[]` com `nome`, `cidade`, `endereco`, `status`, `escolhido`, `ocupacao` (0-100, quanto dos 3600s daquele ponto já está vendido), `horario` (resumo textual do `horario_semanal` do ponto, ex. `"Seg-sex 09:00-18:00 · Sáb 09:00-15:00 · Dom fechado"`, `null` se o ponto ainda não informou — vai no `title` do nome no card, 22/09/2026) e `bloqueado` (RN-55 — cruzou 80% e parou de aceitar escolha nova; nunca `true` pra um ponto que a conta já tinha escolhido), e `cobertura` com o bônus da RN-49, sempre em horas por mês (a unidade que o cliente comprou; segundos por hora é unidade de motor e não sai daqui) — `contratados`, `veiculando`, `horas_contratadas`, `horas_sem_compensacao`, `horas_hoje`, `compensando`. 400 se a conta não tem plano. Reavalia o bloqueio (RN-55) antes de responder. |
| PUT | `/anunciantes/me/pontos` | ⚠️ Mesmo caminho do `POST` abaixo, sentido diferente: o `POST` é o DONO DE PONTO cadastrando um endereço novo, o `PUT` é o ANUNCIANTE escolhendo onde aparece. Separa o verbo, não o caminho. Troca a escolha inteira: `{pontos:[id,...]}`. Numa transação — metade salva deixaria a conta numa cobertura que ela não escolheu. 400 se passar do limite do plano ou se algum ponto não existir na rede (`em_operacao`, `a_instalar` ou `em_reparo` — RN-49 e rodada final da Rede). 409 se algum ponto NOVO na lista (que a conta ainda não tinha) estiver travado por ocupação (RN-55) — `{erro, pontosBloqueados:[id,...]}`; manter um ponto que já era seu, mesmo travado, não é recusado. Lista vazia devolve a conta pra distribuição automática (RN-42, que também pula pontos travados). |
| PATCH | `/anunciantes/me` | Edita dados de contato/endereço. |
| POST | `/anunciantes/me/foto` | Foto de perfil (multipart `arquivo`). |
| POST | `/anunciantes/me/excluir` | Soft-delete (60 dias recuperável pelo admin). |
| POST | `/anunciantes/me/confirmar-email` | `{codigo}` (6 dígitos, migration 061) → `{ok}`. 400 se errado/expirado (validade 2min — pedido do dono, 19/09/2026). Não bloqueia login nem uso da conta — só marca `email_confirmado=true` e faz o aviso sumir do front. |
| POST | `/anunciantes/me/reenviar-codigo-email` | Gera e manda um código novo (invalida o anterior); no-op silencioso se já confirmado. |
| POST | `/anunciantes/logout` | Destrói a sessão. |
| POST | `/anunciantes/:id/assinar` | `{planoId}` → `{checkoutUrl}`. Recusa plano fundador com programa fechado ou sem vaga. |
| POST | `/anunciantes/me/cancelar-assinatura` | Cliente cancela a própria assinatura (migration 041, 16/09/2026). Cobertura já paga continua até `data_expiracao`. 400 sem assinatura ativa. |
| POST | `/anunciantes/me/trocar-plano` | `{planoNovoId}` → `{ok, valor, ciclo, acerto}` (200, sem acerto a cobrar) **ou** `{status:'aprovacao_pendente', approvalUrl, expiresAt, amount}` (202, com acerto a cobrar — RN-52, `POST /trocar-plano` do Checkout; aposenta o pedido avulso pra este fim). 400 sem plano pago ativo, plano cortesia, cobertura vencida, ou trocando pro mesmo plano; 409 sem assinatura ativa no Checkout. Cria a linha nova em `pendente_troca`, chama o Checkout. Em erro (400/404/409/502… do Checkout), apaga a linha pendente e devolve o erro dele, sem tocar em nada mais. Em 202: não apaga nem aplica nada — o front redireciona pra `approvalUrl`, e é o webhook `plano_trocado` (não esta resposta) que confirma, quando o pagador aprovar. Em 200 (sem acerto): numa transação, marca a linha antiga `trocada`, a nova `ativa`, atualiza `anunciantes.plano_id`, e só grava `cobrancas_confirmadas` (com `plano_anterior_id`) se `acerto.cobrado` — downgrade sem cobrança não gera essa linha (ver `GET /admin/pedidos-avulsos`). Falha ao gravar depois de já ter cobrado no Checkout → 502 e pendência pro admin, nunca finge que a troca não aconteceu. |
| GET/POST/DELETE | `/anunciantes/:id/criativos[/:criativoId]` | Criativos do anunciante (upload multipart, normalização por ffmpeg, fila de aprovação). POST 400 sem `plano_id` (19/09/2026 — antes liberava 1 criativo sem plano pra não travar quem estava no meio do cadastro; o dono pediu pra travar de vez, a tela some com o upload nesse estado). Campo opcional `substitui` (Fatia 3, 23/09/2026): id de uma peça APROVADA da própria conta — a nova nasce em análise apontando pra ela e a atual segue no ar até a nova ser aprovada (400 se a peça não está aprovada, 404 se não é da conta, 409 se já tem substituta em análise). POST e DELETE emitem `creative.updated` pra conta. |
| GET | `/anunciantes/:id/exibicoes` | O que rodou pro anunciante, por ponto e por dia. `porDiaPonto` (19/09/2026) é `porDia` cruzado com ponto — `{dia, ponto_id, ponto_nome, confirmadas}`, sem `LIMIT` — pra empilhar o gráfico "Exibições por dia" por cor de ponto no front. `porPonto` também traz `ultima_vez_online` de cada dispositivo, pro front montar o badge online/offline (mesmo limiar `HORAS_OFFLINE_ALERTA` do admin). `cobrancas` não traz mais nota fiscal (19/09/2026 — nenhuma é emitida hoje; quando for possível, o envio será automático por e-mail, não um link nesta lista). Não existe mais `porHora` (chegou a existir por um dia, 19/09/2026, pra um gráfico "Exibições por horário" — pedido do dono foi retirar o painel de vez). Com plano ativo, também devolve `confirmadasMes`, `horasContratadasMes`/`horasEntreguesMes` (ilustrativo, mesma aproximação do banco de horas), `exibicoesContratadasMes`/`exibicoesRestantesMes` (o contratado e o que falta no mês, em exibições — não em horas), `mediaDiariaMes` e `custoPorExibicao` (valor mensal pago ÷ `exibicoesContratadasMes` — pedido do dono, 19/09/2026: por hora "parece caro", por exibição "parece barato", mesmo valor de fundo; divide pelo CONTRATADO, não pelo confirmado, pra ser um preço fixo desde o dia 1, não um número que sobe e desce conforme o mês roda; `null` em cortesia ou sem plano). `mediaDiariaMes` divide pelos dias DECORRIDOS DESDE O INÍCIO DA CAMPANHA NO MÊS (primeiro dia com programação, não confirmação — sempre existe uma linha em `exibicoes_contador` quando a conta foi programada numa hora), não pelo dia do mês (21/09/2026, revisão de design do painel: dividir pelo dia do mês penalizava campanha que começou no meio do mês). O front (`painel.page.js`) multiplica `custoPorExibicao` por 1000 pra mostrar "custo por 1.000 exibições" — não é CPM (o Mostraí não mede audiência, só reprodução), o campo em si continua sendo o valor por UMA exibição. Todos os campos que dependem de plano vêm `null` sem plano. |
| GET | `/anunciantes/:id/exibicoes.csv?dias=N` | Comprovante de veiculacao em planilha (RN-19). `dias` entre 1 e 365, padrao 30. |
| GET | `/anunciantes/:id/pontos` | Pontos da conta (papel `ponto`). |
| GET | `/anunciantes/me/criativos` | **Conta logada** (Fatia 3 do painel único, 23/09/2026): "Meus criativos" — a peça comercial e a do comodato (autoanúncio na tela do próprio comércio) numa lista só. `criativos[]` com `situacao` (`em_analise` · `aprovado` = pronta mas fora do rodízio agora · `no_ar` · `fora_do_ar` · `recusado`), `arquivoUrl`, `thumbnailUrl`, `duracaoSegundos`, `motivoRecusa`, `feitoPelaMostrai`, `substitui` (id da peça que esta troca) e `substitutaEmAnalise` (id da substituta pendente). Mais `temPlano` (efetivo: comercial ou comodato), `rodaNaRede`, `rodaNoProprioPonto`, `contaVeicula`, `limiteNoAr`, `limiteCadastro`, `emUso`, `duracaoMaxima`. `no_ar` é o mesmo motor da ficha do admin (`criativosComSituacao`). |
| GET | `/anunciantes/me/meus-pontos` | **Conta logada** (Fatia 2 do painel único, 23/09/2026): "Meus pontos" — `{ehPonto, estabelecimentos[]}`, UM item por estabelecimento. `tipo: 'candidatura'` (pedido aberto que ainda não virou ponto — a candidatura com `pontos.candidatura_id` nunca aparece de novo) ou `tipo: 'ponto'` (não arquivado). `estado`: `em_analise` · `aguardando_instalacao` · `ativo` · `em_manutencao` · `inativo`. Ponto traz `telas[]` com `situacao` (régua de `src/lib/status-tela.js`), `nivel` (`ok`/`neutro`/`atencao`), `situacaoTexto` humano, `ultimoSinal`, `temPin`, `exibicoes30d`, `anunciantes30d`; e `modalidade`, `ajudaCustoMensal`, `cotaAutoanuncioPorHora`. Projeção fechada: nunca chave do aparelho, PIN, contato do responsável, observação interna, custo ou texto cru do erro do player. `ehPonto` diz qual rota o painel usa pra pedir outro estabelecimento. SSE: `application.updated`, `point.updated`, `screen.updated`. |
| GET | `/anunciantes/me/pontos/candidaturas` | **Conta logada** (papel `ponto`, 23/09/2026): candidaturas de endereço em aberto (`status IN ('nova','em_contato')`) desta conta — "Meus endereços" funde com os pontos de verdade, badge "Em análise". Some sozinha quando o admin aprova (vira ponto) ou recusa. |
| POST | `/anunciantes/me/pontos` | Dono de ponto cadastra outro endereço — entra como CANDIDATURA (não cria ponto direto; o admin aprova em Rede/Candidaturas, `liberarPapelNaConta` cria o ponto + Tela 1 só então). 403 sem papel `ponto`. 409 se já existir uma candidatura em aberto pro MESMO endereço (`endereco`+`cep`) — `"Já existe uma solicitação em análise para este endereço"` — ou se o mesmo estabelecimento (conta + nome + endereço) já for ponto da conta. Emite `application.updated` pra conta. |
| GET | `/anunciantes/:id/dispositivos` | Telas dos pontos da conta, com exibições/anunciantes em 30 dias e `ponto_status`. |
| GET | `/anunciantes/:id/dispositivos/:dispositivoId/painel` | O que rodou naquela tela: `{porAnunciante, porDia}`. |
| POST | `/anunciantes/:id/dispositivos/:dispositivoId/pin` | Dono do ponto define o PIN da própria tela (guardado com hash, mesma regra do `/admin/dispositivos/:id/pin`). |
| GET | `/anunciantes/me/banco-horas` | Saldo do banco de horas (G.3, RN-53): `{saldo, segundos, linhas:[{mesReferencia, saldo}]}`, só linhas `status='ativo'` — o que ainda pode virar prioridade na próxima geração de playlist. `segundos` é `saldo × duração atual da peça` — ilustrativo pra virar tempo na tela (18/09/2026), não o dado que a apuração usa; `saldo` (exibições) é o número exato. Nunca mostra saldo de outra conta, nem linha já drenada ou em fila de crédito. |
| GET | `/anunciantes/me/creditos` | Tudo que o módulo "Créditos e benefícios" do painel mostra: `{saldo, opcoes, movimentacoes, beneficioAtivo, beneficioAgendado, situacaoAtual, diasPorMes, resgate:{permitido, motivo}, indicacao:{codigo, cadastradas, pagantes}}`. `opcoes`: as 12 combinações tier×período com `disponivel`/`faltam`. `beneficio*`: `{tier (chave), nomeTier, planoNome, validoAte, comecaEm}`. `situacaoAtual` alimenta o preview do resgate. `indicacao` cria o cupom `PT-` da conta na primeira chamada — toda conta indica, não só dono de ponto (`null` pra conta própria). A atividade é só número, nunca dado de quem foi indicado. |
| POST | `/anunciantes/me/creditos/resgatar` | `{tier, meses}` → `{conta, status:'ativo'\|'agendado', validoAte, comecaEm}`. Benefício temporário: 30 dias por mês, contados do dia em que COMEÇA. Com ciclo pago em curso, fica `agendado` e começa quando ele termina (se a assinatura renovar antes, a ativação atrasa e a duração é preservada). Trava a conta na transação e relê saldo e bloqueios depois da trava. 409: saldo insuficiente, conta suspensa, comodato "Recebe os R$ 50", ou benefício já em vigor/programado (resgatar por cima perderia os dias ou os créditos do anterior). |
| GET | `/anunciantes/me/notificacoes` | `{notificacoes, naoLidas}` — central de atualizações da conta (migration 079): histórico de eventos (criativo aprovado/recusado, pagamento confirmado, créditos recebidos, benefício iniciado/programado, etc.), nunca mensagens/chat. |
| POST | `/anunciantes/me/notificacoes/:id/lida` | marca uma notificação como lida. 404 se não é desta conta ou já estava lida. |
| POST | `/anunciantes/me/notificacoes/marcar-todas-lidas` | marca todas as não lidas da conta. |
| GET | `/conta/eventos` | Server-Sent Events (`text/event-stream`) — eventos em tempo real da conta logada. Conjunto fechado (Fase 3, 23/09/2026): `payment.updated`/`credits.updated`/`notification.created` (confirmação de pagamento, resgate/concessão de crédito, qualquer notificação nova), `application.updated` (candidatura de ponto aprovada/recusada), `creative.updated` (criativo aprovado/recusado), `account.updated` (conta suspensa/reativada). `plan.updated`/`point.updated`/`screen.updated`/`finance.updated` existem no cliente (`public/eventos.js`) mas ainda sem emissor no backend — ver `.ia/HANDOFF.md`. Heartbeat a cada 25s. Isolado por `anuncianteId` da sessão — nunca vaza evento de outra conta. Publicado por `src/lib/sse.js` via Postgres LISTEN/NOTIFY — alcança as duas instâncias do serviço (Northflank), não só a que recebeu a ação. |
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
| POST | `/conta/modos/ponto/pedir` | Pedido de tela de dentro do painel → candidatura `origem=painel` com `conta_id` (`nome_comercio`, `endereco`, `fluxo_estimado_mensal` e `horario_semanal` obrigatórios — este último desde 22/09/2026; `plano_ponto_id` opcional, `mensagem` opcional). `segmento` não precisa vir no corpo: resolvido no servidor a partir de `categoria_livre` da conta ou, se ela usa o catálogo fixo, do nome de `categoria_id`. `horario_semanal` é `{seg,ter,qua,qui,sex,sab,dom}`, cada dia `null` (fechado) ou `{abre,fecha}` em `HH:MM` (`src/lib/horario-semanal.js#validar`) — a tela só pede 3 grupos (seg-sex/sáb/dom) e replica seg-sex pros 5 dias. 409 se já houver pedido em análise. E-mail de aviso pro dono (`enviarCandidaturaNova`), fire-and-forget. Retorna `{ok, id}` — o `id` alimenta o upload de foto abaixo. |
| POST | `/conta/modos/ponto/candidaturas/:id/foto` | **Conta logada, dona da candidatura** (migration 067, 22/09/2026). Segundo passo, opcional — multipart (`arquivo`), mesmo padrão de storage das demais fotos do projeto. Sem foto, candidatura e ponto continuam válidos (placeholder assume). Copiada pro `pontos.foto_instalacao_url` quando `liberarPapelNaConta` cria o ponto. |
| POST | `/conta/modos/vendedor/pedir` | **400** — aposentado em 18/09/2026 (RN-03). Vendedor não pede mais: fala direto com o dono, que gera o convite à mão. |
| POST | `/convites/:token/aceitar` | Conta logada aceita um convite: os papéis novos entram nesta conta (vendedor exige `chave_pix`; ponto vindo de candidatura cria ponto + Tela 1). Consome o convite. |
| POST | `/conta/bonus/anuncio/resgatar` | Módulo "anúncio grátis após N meses como ponto" (`planos_ponto.plano_bonus_*`): quando `bonus.anuncio.disponivel`, ativa o plano na conta por M meses sem cobrança (papel anunciante entra junto). 409 se já houver plano ativo. |

Admin: `POST /admin/candidaturas/:id/liberar` — candidatura com `conta_id` (origem painel/bônus) liga o papel direto na conta (cria perfil de vendedor ou ponto + Tela 1) e marca `aprovada`. Depois do COMMIT avisa o dono: notificação `ponto_aprovado` + SSE `point.updated` e `application.updated` (antes só o PATCH de status avisava, e o botão Aprovar não passa por ele). Ponto herda `categoria_id`/`categoria_livre` da conta (RN-57, corrigido 22/09/2026 — antes nascia sem categoria nenhuma, bloqueio de concorrente inoperante).

## Tela (chave de aparelho)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/playlist/:dispositivoId` | A HORA INTEIRA desta tela. Duas formas, decididas por `dispositivos.contrato_playlist` (migration 065) — ver "Contrato novo" abaixo. |
| POST | `/player/:dispositivoId/played` | Duas formas no mesmo corpo, decididas pelo que chega — ver "Contrato novo" abaixo. |
| POST | `/player/:dispositivoId/heartbeat` | Marca a tela online. Corpo opcional `{erro}` (migration 076, revisão final da Visão geral, 23/09/2026) — texto curto de um problema real que o player detectou (ex.: "tela fora do ar no cadastro"); grava `dispositivos.ultimo_erro`/`ultimo_erro_em` junto do heartbeat. Ausente/`null` limpa os dois — não existe erro "preso" depois que o player volta a reportar normal. Alimenta o estado `erro_do_player` de `src/lib/status-tela.js`. |
| POST | `/player/:dispositivoId/painel` | `{pin}` → painel da tela (mesmo formato do painel do dono). Rate-limited. |

### Contrato 1 — array (padrão, player web)

`contrato_playlist = 1` (padrão de toda tela nova). `GET /playlist/:dispositivoId`
devolve um array puro de itens `{anuncianteId, url, duracaoSegundos, autoanuncio,
institucional}` — exibição contratada primeiro, cota do dono depois, espaço vago
preenchido com `institucional: true` (sem url — o player mostra a peça `#vazio`).
Autoanúncio do dono e institucional vêm com `anuncianteId: null` e não são
contados. Programa os contadores da hora (`exibicoes_contador`).

`POST /player/:dispositivoId/played` recebe `{anuncianteId}` e confirma uma
exibição — só aceita quem está programado nesta tela nesta hora. `200
{ok:true, janela}` credita; `200 {ok:true, contou:false, motivo:"ja_completo"}`
é a própria TV reenviando o que já contou (não é erro); `400` é pedido inválido
(anunciante não programado).

### Contrato 2 — envelope (app Android nativo, `sancompany/playlist.mostrai`, 21/09/2026)

`contrato_playlist = 2`, marcado por tela direto na aba Telas do admin (select
"Contrato", 22/09/2026 — antes só dava pra mudar por `PATCH
/admin/dispositivos/:id {"contrato_playlist":2}` na unha, sem controle na UI)
— pra quem instalar o app nativo naquela TV. `GET /playlist/:dispositivoId`
devolve:

```json
{
  "versaoContrato": 2,
  "janelaId": "<dispositivoId>|<horaISO>",
  "janelaInicio": "2026-09-21T22:00:00.000Z",
  "janelaFim": "2026-09-21T23:00:00.000Z",
  "servidorAgora": "2026-09-21T22:00:07.123Z",
  "itens": [
    {
      "itemProgramacaoId": "<janelaId>|<indice>|<anuncianteId|dono|inst>",
      "criativoId": "42",
      "anuncianteId": "7",
      "autoanuncio": false,
      "institucional": false,
      "contabiliza": true,
      "url": "https://.../normalizado.mp4",
      "duracaoSegundos": 15
    }
  ]
}
```

`itemProgramacaoId` é opaco pro app (só compara igualdade) mas tem forma fixa —
`indice` é a posição na sequência congelada da hora (`playlist_hora_congelada`,
migration 064), **antes** de remover vagas que saíram de elegibilidade no meio
da hora, pra não deslocar o índice de quem vem depois a cada poll. Estável
entre polls da mesma hora (é o que permite ao app reancorar sem reiniciar a
exibição em andamento). `criativoId` é o id real de `criativos` — muda só
quando o criativo muda de verdade (upload novo, nunca edição do mesmo id).

`POST /player/:dispositivoId/played` recebe `{"eventos":[{execucaoId,
janelaId, itemProgramacaoId, criativoId, iniciadoEm, terminadoEm}, ...]}` (até
50 por lote) e devolve `{"resultados":[{execucaoId, status}, ...]}`. `status`
é sempre um destes (vocabulário fixo, definido do lado do app —
`FilaProofOfPlay.STATUS_DEFINITIVOS` em `playlist.mostrai` — mudar aqui sem
mudar lá quebra a fila de retentativa):

- `contabilizado` — creditado.
- `duplicado` — `execucaoId` já visto antes (retentativa depois de resposta
  perdida); não credita de novo.
- `teto_atingido` — a hora já tinha `vezes_confirmadas = vezes_programadas`
  pra este anunciante quando este `execucaoId` (novo) chegou.
- `janela_desconhecida` — `itemProgramacaoId` aponta pra outra tela, ou pra
  uma janela que nunca existiu nesta.
- `item_invalido` — `itemProgramacaoId`/`janelaId` malformado.
- `janela_expirada` — a hora referenciada é velha demais (mesma folga de 15
  minutos da virada de hora do contrato 1, `FOLGA_VIRADA_MIN`).

Deduplicação por `execucaoId` é obrigatória e durável — ledger em
`execucoes_confirmadas` (migration 065), reserva e crédito na MESMA
transação (`src/playlist/execucoes-repository.js`), pra um crash no meio
nunca deixar "já visto" gravado sem ter creditado. `criativoId`/`janelaId`
que o app manda de volta não são cross-checados contra o banco além do
prefixo de `itemProgramacaoId` — a confiança é a mesma chave de aparelho de
sempre (`X-Aparelho-Id`), igual ao contrato 1.

Registra 1 evento por LOTE em `eventos` (`playlist:proofofplay_lote`, com a
contagem por status) — não por execução, mesmo motivo do comentário em
`src/player/routes.js` sobre `exibicao:video_toca` nunca virar linha própria.

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
| GET | `/admin/resumo` | filas (`criativos`, `eventos`, `candidaturas` — `status NOT IN ('aprovada','recusada')`, mesma definição da aba Rede > Candidaturas —, `arrependimentos`, `contato`, `offline`, `bancohoras` — linhas `aguardando_credito` não resolvidas, G.3 —, `pontosocupados`). **Saíram na rodada de integridade (23/09/2026):** `pontos` (contava ponto `a_instalar` e era exibido como "candidatos aguardando triagem"; a contagem por status do ponto é `rede.pontosPorStatus`) e `notas` (todo pagamento nasce `nota_fiscal_status='pendente'`, então contava o histórico inteiro). **Saíram na revisão final da Visão geral (23/09/2026, seção 3 do pedido):** `falhasFiscais` (nunca teve automação capaz de falhar de verdade) e `horasOfflineAlerta`/`comissoesPendentes` (virou régua de horário — ver `offline` abaixo — e comissão de vendedor saiu do agregado financeiro; a tabela `comissoes` continua servida por `GET /admin/comissoes`, dentro de Contas). `offline` agora conta só telas em `sem_sinal`/`erro_do_player` (`src/lib/status-tela.js`) — tela fora do horário de funcionamento ou nunca instalada não entra mais. Financeiro (`receitaMensal` — soma `valorMensalDaConta()` linha a linha, respeitando promoção travada/desconto de parceiro/crédito de comodato, não mais o preço de tabela cru —, `receitaConfirmadaMes` — confirmado no mês corrente, de `faturamentoPorMes` —, `receitaPorCiclo` — por `compromisso_meses`, 1/3/6/12, não exibido na Visão geral desde a rodada Financeiro de 22/09/2026, só consumido por quem quiser —, `repassesPendentes`/`trocasPendentes`/`devolucoesPendentes` — `{qtd, total}` cada — e `pendenciasFinanceiras` — a SOMA dos três, é o que vira o card único "Financeiro" da Visão geral (seção 3/4/6 do pedido); `custoPontosMensal`, `amortizacaoMensal`, `custosFixosMensal` e `margemMensal` continuam calculados mas não aparecem em nenhuma tela do admin desde que a página de Custos saiu da UI — nenhum dado apagado, só sem exposição —, `percentualPagantes` — `null` sem conta nenhuma —, `totalContas`, `contasPagantes`: quem tem plano ativo, não suspenso, não cortesia), rede (`pontosAtivos`, `telasAtivas`, `fluxoMensal`, exibições, novos) |
| GET | `/admin/pagamentos-ponto/pendentes` | fila "quem devo pagar este mês" (rodada Financeiro, 22/09/2026): pontos `em_operacao` com `valor_pago_mensal > 0` (comodato sem dinheiro de verdade nunca aparece aqui) e sem lançamento pago pra competência atual. Usada pela Visão geral e pelo drill-down `#financeiro/repasses` |
| GET | `/admin/ofertas/produtos` | Essencial/Pro/Prime, cada um com `precoBase` e os 4 ciclos (`planoId`, `descontoPercentual`, `valorMensal`). Sem `descontoComodato` desde a rodada de integridade (23/09/2026) |
| PATCH | `/admin/ofertas/produtos/:tier` | `{precoBase, descontos: {1,3,6,12}}` — versão nova só no ciclo que mudou. `descontoComodato` não é mais aceito: o percentual de comodato por plano foi aposentado (a migration 049 já o tinha trocado pelo crédito em reais) e **não entra mais no cálculo** (`valorMensalDaConta`); o valor que estiver gravado na coluna fica, sem efeito |
| GET | `/admin/ofertas/comodato` | Os 2 produtos de comodato, somente leitura (rodada de integridade): Inicial e Básico, via `planos_ponto.plano_incluido_id` das modalidades ativas — `planoId`, `nome`, `compravel` (sempre `false`), `modalidadeNome`, `ajudaCustoMensal`, `permiteAssinar`, `creditoAssinatura`, `segundosPorHora`, `pontosIncluidos`, `duracaoMaximaSegundos`, `limiteCriativos`, `horasMes`, `exibicoesMes` (mesmas funções da vitrine) |
| GET | `/admin/capacidade-rede` | Uma linha por ponto `em_operacao` (`?escopo=rede`: todos os pontos — é o que a tabela "Ocupação da rede" da Visão geral usa). Régua 80/20 única (`src/lib/capacidade.js`, rodada de integridade): `comercialPct`, `comercialRestantePct` (do teto de 80%), `mostraiPct`, `reservaRestantePct` (da reserva de 20%), `mostraiAcimaDaReservaPct`, `totalPct`, `excede`. `livrePct`/`institucionalPct`/`atualPct` continuam na resposta por compatibilidade, mas nenhuma tela mostra mais "livre" — ele somava os dois saldos |
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
| POST | `/admin/anunciantes/:id/criativos` | sobe a peça direto na conta do cliente, **já aprovada** e marcada em `editado_pelo_operador`. A peça é feita fora do site. Teto de CADASTRO: 3 por conta (`CRIATIVOS_POR_CONTA`) desde 23/09/2026 — quantos rodam juntos continua sendo o `limite_criativos` do plano; nenhum teto na conta própria. 409 com a conta suspensa |
| GET | `/admin/anunciantes/:id/criativos` | criativos da conta pra ficha, com `no_ar` calculado pela mesma regra do gerador (conta veiculando + aprovado com arquivo + os N mais recentes do plano), `limite_no_ar`, `limite_cadastro`, `conta_veicula` (23/09/2026) |
| GET | `/admin/anunciantes/:id/plano` | origem do plano COMERCIAL vigente (`assinatura`/`cortesia`/null — nunca mais `comodato`, migration 077: comodato é slot próprio, `comodato_plano_id`, mostrado à parte na ficha), assinatura paga ativa (se houver) e histórico de benefícios administrativos (23/09/2026) |
| POST | `/admin/anunciantes/:id/creditos/conceder` | **o jeito NORMAL de dar cortesia comercial desde 23/09/2026** — `{quantidade, motivo}`. Cria uma linha `concessao_admin` no ledger (`creditos_ledger`, migration 079); a conta escolhe depois em que plano/período resgata, do painel dela, mesma régua de um crédito de indicação. Gera notificação pra conta. 400 pra `conta_propria` |
| GET | `/admin/anunciantes/:id/creditos` | `{saldo, movimentacoes, historicoBeneficios}` — mesmo dado que alimenta o card Créditos da ficha da conta |
| POST | `/admin/anunciantes/:id/plano-administrativo` | `{plano_id, valido_ate: 'AAAA-MM-DD', observacao?}` — concede/troca por BENEFÍCIO **diretamente** (cortesia administrativa: sem cobrança, sem receita), sem passar por crédito. Desde 23/09/2026 é o caminho TÉCNICO (correção pontual), não mais o normal — ver `creditos/conceder` acima. Só Essencial/Pro/Prime ativos. Assinatura paga ativa é cancelada antes pelo San Checkout (502 e nada muda se ele recusar). Sem diferença, troca paga ou reembolso. Encerra o benefício anterior no histórico (`planos_administrativos`, migration 075). 409 com a conta suspensa ou excluída. 409 se a conta está no comodato Inicial (`planos_ponto.permite_assinar=false`) — plano comercial não acumula com Inicial; primeiro troca a modalidade pra Básico (23/09/2026, decisão do dono e do GPT) |
| POST | `/admin/anunciantes/:id/plano-administrativo/encerrar` | encerra só o plano COMERCIAL concedido agora — o comodato (`comodato_plano_id`) nunca é tocado, nem "volta": ele nunca deveria ter desaparecido (23/09/2026, correção do modelo de domínio). 400 se o plano vigente não for cortesia (assinatura paga usa `cancelar-assinatura`) |
| POST | `/admin/anunciantes/:id/ativar-vendedor` | **410** desde 23/09/2026 — papel Vendedor aposentado (dados antigos intactos) |
| POST | `/admin/anunciantes/:id/liberar-plano` | legado (sem tela chamando desde 23/09/2026 — ver `plano-administrativo`). `{plano_id, meses?, motivo?}` — põe a conta no ar de graça, sem assinatura nem cobrança. 409 se já houver plano pago ativo |
| POST | `/admin/anunciantes/:id/cancelar-assinatura` | chama o Checkout. Mesma ação de `POST /anunciantes/me/cancelar-assinatura`, pelo admin em nome do cliente (16/09/2026: o pagador também pode cancelar sozinho, ver Conta logada) |

### Pontos e telas
| Método | Rota | O que faz |
|---|---|---|
| GET | `/admin/pontos` | lista. `status` é 100% automático desde a rodada final da Rede (22/09/2026, migration 069) — deriva de `dispositivos.status` (`sincronizarStatusPonto`, `src/pontos/repository.js`): 0 telas → `a_instalar`; ≥1 ativa → `em_operacao`; 0 ativa e ≥1 em `reparo` → `em_reparo`; tem tela(s), nenhuma ativa/reparo → `inativo`. Ninguém escreve a coluna fora dessa função — nunca duas fontes de verdade. |
| PATCH | `/admin/pontos/:id` | endereço, ajuda de custo, cota, `horario_semanal`, `observacoes` (migration 067). **Não aceita `status`** — a ficha do ponto é somente-leitura na tela desde o redesenho de 22/09/2026, e desde a rodada final também não tem mais painel de Instalação/ACM nenhum: quem muda o status é a tela (`PATCH /admin/dispositivos/:id`), nunca o ponto direto. |
| GET | `/admin/pontos-offline` | telas em `sem_sinal`/`erro_do_player` (revisão final da Visão geral, 23/09/2026 — antes era só heartbeat vencido há mais de `HORAS_OFFLINE_ALERTA`, sem olhar horário de funcionamento; ver `src/lib/status-tela.js`). Cada linha traz `situacaoOperacional`. |
| GET | `/admin/pontos/:pontoId/dispositivos` | telas do ponto, cada uma com `situacaoOperacional` calculado (`operando`/`fora_do_horario`/`aguardando_primeiro_sinal`/`sem_sinal`/`erro_do_player`/`em_reparo`/`inativa`) |
| POST | `/admin/pontos/:pontoId/dispositivos` | cria tela — nasce sempre `status='inativo'` (default da coluna, migration 069); quem confirma que está funcionando marca `ativo` depois, pelo PATCH abaixo |
| GET | `/admin/dispositivos` | todas as telas, mesmo formato de `.../dispositivos` acima |
| PATCH | `/admin/dispositivos/:id` | apelido, status, custo, prazo de amortização, `instalado_em`, `margem_superior`/`margem_direita`/`margem_inferior`/`margem_esquerda` (safe area da tela, migration 069 — vmin, nunca negativo), `modo_horario` (`'ponto'`\|`'24h'`\|`'personalizado'`, migration 076) e `horario_semanal` (só usado quando `modo_horario='personalizado'`; mesmo formato/validação de `pontos.horario_semanal`, `src/lib/horario-semanal.js`). Mudar `status` recalcula `pontos.status` do dono na hora (`sincronizarStatusPonto`). |
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
| GET | `/admin/categorias` | lista todas (ativa, inativa e legado — `GET /categorias` pública mostra só o que sobra depois do filtro), com `uso_contas`, `uso_pontos` e `canonica_nome` (23/09/2026) |
| POST | `/admin/categorias` | cria: `{nome (obrigatório), grupo?, aliases?, ativo?, legado?}` |
| PATCH | `/admin/categorias/:id` | edita `nome`, `ativo`, `grupo`, `aliases` (array) ou `legado` (legado força `ativo = false`) |
| POST | `/admin/categorias/:id/mesclar` | `{destino_id}` — funde na canônica numa transação: reaponta contas e pontos, grava `canonica_id`, vira legado e o nome vira alias da canônica. 400 se o destino for ela mesma ou legado (23/09/2026, mesma operação da migration 074) |
| DELETE | `/admin/categorias/:id` | remove — 409 se estiver em uso (FK de `anunciantes`/`pontos`); mescle ou tire do cadastro em vez de excluir |

### Criativos
| Método | Rota | O que faz |
|---|---|---|
| GET | `/admin/criativos` | fila de aprovação |
| PATCH | `/admin/criativos/:id` | aprova, recusa, retira do ar (`retirado`, migration 075) ou põe de volta. Só aprovado entra na playlist. Aprovar um substituto (`substitui_criativo_id`) tira o original do ar no mesmo gesto |
| POST | `/admin/criativos/:id/substituto` | multipart `arquivo` — sobe a versão nova de um criativo APROVADO sem tirá-lo do ar: a nova nasce em análise apontando pra ele; ao ser aprovada, troca de lugar. 409 se já houver substituto em análise ou a conta estiver suspensa (23/09/2026) |

### Pagamento ao ponto (extrato)
| Método | Rota | O que faz |
|---|---|---|
| POST | `/anunciantes/me/comodato/trocar-por-tela` | **Conta logada** (papel `ponto`): troca a ajuda de custo pelo plano Essencial, em todos os pontos dela, numa transação. Mão única — VOLTAR a receber os R$ 50 só pelo `PATCH /admin/pontos/:id`, porque é despesa nova e recorrente. 400 se a conta não tem ponto ou se já trocou. |
| GET | `/anunciantes/me/pontos/extrato` | **Conta logada** (papel `ponto`): o que o dono ja recebeu de comodato, mes a mes, com resumo. |
| GET | `/admin/pontos/:pontoId/pagamentos` | lançamentos daquele ponto |
| POST | `/admin/pontos/:pontoId/pagamentos` | lança `{competencia:'AAAA-MM', valor, forma?, observacao?, pago_em?}`. Mesmo mês de novo **atualiza**, não duplica (UNIQUE da migration 022) |
| PATCH | `/admin/pagamentos-ponto/:id` | `{pago}` quita ou reabre o lançamento |

### Dinheiro
Rodada Financeiro (22/09/2026): Receitas/Repasses/Custos saíram de página
permanente da sidebar do admin — "normalidade não ocupa espaço, pendência
aparece". Repasses, comissões, trocas e devoluções viraram drill-down oculto
(`#financeiro/repasses`, `#financeiro/comissoes`, `#financeiro/trocas`,
`#financeiro/devolucoes`), acessados só pelo clique na pendência da Visão
geral. Custos (`/admin/custos-fixos*`) e a emissão manual de nota fiscal
(`PATCH .../nota-fiscal`, upload de PDF) **não têm mais chamador nenhum no
front** — as rotas abaixo continuam de pé (dado e histórico preservados),
só sem tela.

| Método | Rota | O que faz |
|---|---|---|
| GET | `/admin/cobrancas` | cobranças confirmadas |
| GET | `/admin/mensagens-contato` | caixa de entrada do formulário do site, mais recente primeiro, SEM filtro de status (o front filtra Pendentes/Histórico do lado dele desde a revisão final da Visão geral, 23/09/2026, seção 5 do pedido — `#mensagens/pendentes` e `#mensagens/historico`, mesmo endpoint). Traz `email_enviado` (se o aviso por e-mail chegou) e `respondida_em`. Quando `email_enviado` é `false`, esta rota é o ÚNICO lugar onde a mensagem existe |
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
