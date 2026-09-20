# Auditoria de fechamento da Estação 5 — 20/09/2026

> Revisão somente leitura de produto, código, banco, Git, documentação e infraestrutura. Não houve deploy, mutação de banco, correção funcional ou atualização de dependência. Consultas de produção foram agregadas e nenhum identificador ou dado pessoal é registrado aqui.

## Resumo executivo

O Mostraí já é uma v1 publicada e coerente de mídia indoor por assinatura, mas a Estação 5 ainda não pode fechar. O risco principal está no elo **playlist → reprodução → confirmação → métrica → banco de horas**. Produção prova que o anúncio investigado é elegível e foi programado muitas vezes, porém quase nenhuma reprodução foi confirmada. A investigação deixa de ser “por que não entrou na playlist” e passa a ser “por que a TV não reproduziu/confirmou o que recebeu”.

O banco de horas considera programação ao formar/drenar déficit porque foi desenhado para falta de capacidade, não falha física. A divergência entre esse significado e a ideia comercial de entrega precisa ser decidida antes de qualquer correção. Há ainda duas corridas no congelamento novo, vulnerabilidades npm (uma crítica e três altas), jobs sem confirmação, ausência de teste do congelamento e drift documental. `/health`, Supabase e Cloudflare Access estão ativos.

**Primeiro furo:** integridade da confirmação quando a tela não conclui ou não consegue falar com o servidor. **Primeira tela para revisar junto:** player na TV física, com log e rede visíveis. **Primeira decisão sistêmica:** manter o banco restrito a déficit de capacidade ou criar também recuperação de falha física, sem misturar os dois conceitos.

## 1. Visão consolidada do Mostraí

### Produto

- Toda conta nasce **anunciante** e pode acumular **ponto** e **vendedor** em `anunciantes.papeis`. Ponto depende de candidatura/liberação; vendedor, de convite do dono.
- O anunciante compra no San Checkout uma assinatura. O plano determina preço/ciclo, segundos por hora, pontos cobertos, duração e limite de criativos. Escolhe pontos até o teto; sem escolha recebe uma fatia determinística.
- Vídeo é validado/normalizado; imagem vira vídeo com a duração máxima do plano. Só criativo aprovado com URL normalizada entra na playlist.
- Ponto é o comércio; dispositivo é cada tela. Categoria impede anúncio do mesmo ramo. Ponto recebe ajuda ou converte o valor em crédito de comodato.
- Comissão de vendedor nasce da cobrança confirmada. O admin opera contas, catálogo, pontos/telas, criativos, dinheiro, convites, pendências e métricas.

### Arquitetura

Node 22 + Express 4, SQL manual com `pg`, sessão PostgreSQL, frontend HTML/CSS/JS sem build, Supabase Postgres/Storage e ffmpeg. A tela usa chave revogável; conta/admin usam sessão. Migrations rodam antes do servidor e produção está na 064. Northflank hospeda serviço/jobs; Cloudflare protege `/admin`; Google fornece SMTP/Drive; GitHub Actions roda migration/check e auditoria semanal.

### Fluxos principais

1. **Aquisição:** cadastro → confirmação de e-mail → plano → assinatura → Checkout → webhook HMAC/conciliação → cobertura → criativo → aprovação → pontos → playlist → reprodução → confirmação → métricas/apuração.
2. **Troca:** destino → assinatura `pendente_troca` → acerto no Checkout → troca síncrona → webhook informativo. O caso atual falha no cálculo proporcional externo.
3. **Ponto:** conta → candidatura → liberação → ponto/dispositivo → chave/PIN → player/heartbeat → ajuda ou crédito.
4. **Vendedor:** convite → vínculo/cupom → indicado paga → comissão.
5. **Recuperação:** contador guarda pedidas/programadas/confirmadas → déficit horário → job mensal cria saldo → playlist tenta drenar → saldo antigo vai a crédito.

## 2. Estado atual real

| Área | Estado | Evidência/ressalva |
|---|---|---|
| Site, login e sessão | Funcionando | Produção responde e implementação existe; cadastro completo deve ser repetido manualmente. |
| Contratação nova | Parcialmente confirmada | Contrato/testes existem; pagamento real não foi provocado. |
| Troca de plano | Quebrada no caso conhecido | Checkout recusa cálculo proporcional; dado final está no banco externo. |
| Cancelamento/renovação | Parcial | Código/testes puros, sem ensaio real de todos estados. |
| Upload/aprovação | Funcionando | Produção tem criativo aprovado/normalizado; falta matriz de formatos. |
| Cobertura | Funcionando com risco | Conta investigada tem ponto escolhido e foi programada. |
| Playlist | Parcial | Produção programa; congelamento não tem teste e tem corridas. |
| Reprodução/contagem | Quebrada ou indisponível | Programadas e confirmadas divergem drasticamente; heartbeat estava antigo. |
| Banco de horas | Implementado, operação não confirmada | Tabela vazia; job incerto; regra usa programado. |
| Ponto/categoria | Funcionando hoje | Backend/admin gravam `categoria_id`; produção o possui. `.ia` estava errada. |
| Vendedor/comissões | Parcial | Implementação/testes, sem fluxo real completo nesta rodada. |
| Admin/Access | Funcionando | `/admin/` redireciona ao Cloudflare Access. |
| Supabase | Funcionando | Saudável, migration 064 e consulta HTTPS. |
| Northflank/jobs | Não confirmado | CLI abriu seletor interativo; jobs não comprovados. |
| GitHub Actions | Não confirmado aqui | CLI autenticada, checkout sem remote. |
| SMTP/Drive/Checkout | Parcial | Implementação/histórico; sem operação mutante nesta auditoria. |
| Endpoints públicos antigos | Legado intencional | Retornam 410 e apontam ao fluxo atual. |
| Revisão visual autenticada | Pendente | Inventário abaixo guia navegação conjunta. |

## 3. Bugs confirmados

### B1 — `/played` não confirma conclusão (P0)

**Sintoma:** métrica pode contar uma tentativa que falhou e perder reprodução real durante oscilação. **Evidência:** o player chama `/played` logo após `play()`, sem esperar `playing`/`ended`, e descarta resposta/erro. **Causa:** não há protocolo durável, retry ou idempotency key por execução. **Arquivos/dados:** `public/player.page.js`, `src/player/routes.js`, `exibicoes_contador`. **Impacto:** prova de entrega, KPIs e confiança comercial.

### B2 — banco de horas mede capacidade, não reprodução (inconsistência a decidir)

**Fato confirmado:** geração drena saldo quando a recuperação coube na programação; a apuração mensal usa `pedidas - programadas`. **Correção de classificação:** comentários, migration e teste provam que o banco foi desenhado apenas para corte de capacidade. A falta física (`programadas - confirmadas`) é deliberadamente separada. Portanto isso não é, isoladamente, bug comprovado; vira lacuna de produto se “banco de horas” também promete recuperar falha da TV. A decisão e impactos estão detalhados em `docs/investigacao-player-confirmacao-2026-09-20.md`.

### B3 — corrida na primeira base congelada (P1)

Duas requisições podem ler ausência, construir bases diferentes e devolver cada qual a sua, embora só uma vença `ON CONFLICT DO NOTHING`. A perdedora não relê a vencedora. Viola a garantia de uma sequência. Envolve `src/playlist/gerador.js`, `src/playlist/congelamento-repository.js` e `playlist_hora_congelada`.

### B4 — corrida duplica extras congelados (P1)

Polls concorrentes podem ler os mesmos extras e ambos concatenar o mesmo novo ID. Não há lock, unicidade nem deduplicação no `UPDATE extras = extras || ...`, podendo superprogramar a hora de entrada.

### B5 — relato “não entra na playlist” está mal classificado (P0 operacional)

Produção confirma plano com segundos, criativo aprovado/normalizado, ponto escolhido/operacional, tela pareada e muitas inserções programadas, mas só uma confirmação. A tela estava sem heartbeat recente. A causa exata depende da TV, porém elegibilidade deixou de ser hipótese principal: o foco é player/mídia/rede/confirmação.

## 4. Inconsistências

| Camadas | Discrepância |
|---|---|
| Produto ↔ código | O banco chama o que coube na grade de `entregue`, enquanto o dashboard usa confirmação física; são conceitos distintos com nomenclatura ambígua. |
| Frontend ↔ backend | Endpoint é confirmação; frontend o envia no início e ignora resultado. |
| Código ↔ `.ia` | Documentos diziam que categoria do ponto nunca era gravada; código e produção provam o contrário. |
| Código ↔ governança | `CONSTRAINTS.md` ainda cita cache em memória removido. |
| Docs ↔ Git | Handoff citava branch Claude/origin; checkout atual é `work` sem remote. |
| Docs ↔ produto | `teia.md`/`furos.md` ainda contêm fluxos públicos aposentados. |
| Testes ↔ local | `npm test` mistura puros e integração; sem Postgres TCP, 21 testes falham por ambiente. |
| Segurança ↔ CI | Auditoria semanal deve falhar no limiar alto; triagem/alerta não foram confirmados. |

## 5. Suspeitas a investigar (não bugs)

1. `stalled` só avança se `videoEl.paused`; travamento pode manter `paused=false`.
2. Poll troca o array mantendo índice numérico, podendo pular/repetir item.
3. Heartbeat e `/played` ignoram HTTP; chave revogada/400 pode parecer normal.
4. Plano legado com segundos nulos depende de fallback; validar dados legados.
5. `bonus.ponto` sempre nulo pode esconder benefício adquirido.
6. Conciliação, apuração e backup podem não existir/falhar silenciosamente.
7. Troca proporcional pode ter ciclo/vencimento/cobrança incoerente no Checkout.
8. Ocupação/sorteio com múltiplas telas por ponto precisa teste de ponta a ponta.
9. Storage precisa teste de CORS, codec, disponibilidade e arquivo órfão.
10. Definir confirmação atrasada, reload, replay e virada da hora.

## 6. Checklist funcional manual

### Conta

- [ ] Cadastrar CPF/CNPJ; recusar duplicado/inválido.
- [ ] Código de e-mail certo, errado, expirado e reenvio bloqueado.
- [ ] Login, reload, segunda aba, logout e sessão expirada.
- [ ] Recuperação com token expirado/reutilizado e senha fraca.
- [ ] Editar dados/foto; CEP, telefone, categoria livre.
- [ ] Consentimento, exportação, arrependimento dentro/fora do prazo.
- [ ] Excluir conta livre e tentar com assinatura/ponto/vendedor.
- [ ] Suspender e validar todos os papéis; combinar os três papéis.

### Plano, pagamento e anunciante

- [ ] Bloqueio da conta sem plano, mantendo perfil/candidatura.
- [ ] Contratar cada ciclo; subtotal, descontos, crédito e total.
- [ ] Abandonar/pagar checkout; repetir webhook e provar idempotência.
- [ ] Upgrade/downgrade no começo/meio/fim do ciclo; repetir caso afetado.
- [ ] Cancelar pelo cliente/admin; expiração, criativos e e-mail.
- [ ] Recusada, pendente, renovada, contestada e cancelada externamente.
- [ ] Nova versão de plano não muda contrato vigente.
- [ ] Parceiro, comodato, cortesia e conta própria sem valor negativo.

### Criativos, cobertura e métricas

- [ ] JPG/PNG horizontal/vertical, limite e acima do teto.
- [ ] Vídeo mínimo/máximo/acima, codec inválido e 95 MB.
- [ ] Duração de imagem normalizada em cada plano.
- [ ] Aprovar/reprovar/reencaminhar/excluir e atingir limite.
- [ ] Revezar N criativos por N horas.
- [ ] Escolher zero/um/máximo/acima do máximo de pontos.
- [ ] Ponto bloqueado antes/depois e liberação administrativa.
- [ ] Alterar cobertura/criativo no meio da hora sem duplicar/mover base.
- [ ] KPI, gráficos, CSV, custo e vazios.
- [ ] Comparar pedidas/programadas/reproduzidas/confirmadas; cortar rede.
- [ ] Gerar, apurar, drenar, expirar e creditar banco de horas.

### Ponto, vendedor, player e admin

- [ ] Candidatar, impedir duplicata, aprovar/reprovar/liberar e criar primeira tela.
- [ ] Segundo endereço, múltiplas telas e categoria bloqueando mesmo ramo.
- [ ] Estados de ponto/tela, chave revogada/regenerada e PIN/rate limit.
- [ ] Heartbeat/fuso, extrato, ajuda, crédito e troca por tela.
- [ ] Convite válido/expirado/revogado/usado, logado/deslogado.
- [ ] Cupom válido/inválido/próprio; comissão única após pagamento; percentual 10–30.
- [ ] Limiar de indicação sem rebaixar/sobrescrever plano pago.
- [ ] Player sem parâmetro, chave errada, tela/ponto fora.
- [ ] Imagem/vídeo/institucional, 404, codec ruim e `stalled`.
- [ ] Offline <1h/>1h, reinício, poll, virada de hora e dois polls simultâneos.
- [ ] Confirmar uma vez somente após exibição válida.
- [ ] Percorrer cada seção admin; erros, vazios, uploads e ações destrutivas.
- [ ] Access + sessão interna, SMTP, pendências, custos, margem e offline.

## 7. Revisão visual/UX

Em todas: desktop 1440, tablet, 320/375 px, zoom 200%, teclado; loading/erro/vazio/sucesso; foco, contraste, textos longos, retorno e duplo clique.

| Tela | Observar |
|---|---|
| Home | Hero/CTA, prova social zero/valor, planos, login e rodapé. |
| Planos | Escada, ciclos/economia, cobertura, condicionais, CTA e mobile. |
| Pontos | Foto/fallback, status/endereço/categoria, vazio, privacidade. |
| Comodato | Dinheiro versus crédito, termos e catálogo atual. |
| Contato | Validação, espera, erro SMTP/API, sucesso e reenvio. |
| Cadastro | Máscaras, termos, categoria, erros por campo e confirmação. |
| Login/recuperação | Autofill, mensagens, expiração e volta. |
| Convite | Estados, conta logada/troca e papel correto. |
| Confirmar plano | Resumo, descontos, troca/contratação, erro externo e volta. |
| Obrigado | Antes/depois do webhook, refresh/demora e caminho ao Painel. |
| Painel | Bloqueio, KPIs/gráficos, plano, upload/cards, pontos e candidatura. |
| Perfil | Foto, campos, consentimento, arrependimento e exclusão. |
| Meu ponto | Extrato/crédito, endereços/telas, offline, PIN e vazios. |
| Vendedor | Cupom, indicados, comissão e acesso indevido. |
| Player | Primeira carga, preload, flash, institucional, offline, erro e PIN. |
| Admin | Access/login, tabelas largas, inline forms, feedback e responsividade. |
| 404/500 | Marca, retorno útil e ausência de detalhe técnico. |
| Legal | Legibilidade, versão/data e aderência ao fluxo real. |

## 8. Banco e migrations

- Produção está até 064; não renumerar/editar migrations. A lacuna 009 é histórica.
- Revisar 019/020 (papéis/telas), 026 (versionamento), 031 (PostgREST), 036/046 (drops), 045–050 (grade), 051 (tentativas), 056 (troca), 057–058 (banco), 060 (ocupação), 062–063 (indicação) e 064 (congelamento).
- Validar nulabilidade de segundos/duração/pontos/categoria, cobertura e assinaturas. Há plano legado com segundos nulos.
- Produção pequena (3 contas, 1 ponto, 1 tela, 1 criativo) facilita limpeza, mas oferece pouca variedade real.
- Ponto possui categoria; corrigir documentação. No instante consultado não havia linha congelada nem saldo; havia contadores.
- Auditar órfãos/duplicatas/estados impossíveis antes da limpeza e definir retenção de congelamento, sessões, eventos, tokens e contadores; 064 não expurga linhas antigas.

## 9. Integrações

| Integração | Estado | Evidência | Pendência |
|---|---|---|---|
| Northflank/produção | Parcial | `/health` 200 | Serviço/deploy/recursos/logs e três jobs. |
| Supabase Postgres | Funcionando | Saudável, 064, consultas HTTPS | Backup/restauração e auditoria completa. |
| Storage | Não confirmado | Cliente/URLs existem | Mídia real, CORS/cache/políticas/órfãos. |
| San Checkout | Parcial | Código/testes; caso de troca falha | Dado da assinatura e matriz de eventos. |
| Cloudflare | Funcionando | Redirect ao Access | Política, membros e origem. |
| GitHub | Parcial | CLI/workflows | Remote, runs, branch protection e scanning. |
| Google SMTP | Parcial | Código/histórico | Diagnóstico, alias, bounce e limites. |
| Google Drive | Não confirmado | Código existe | Upload, permissão, retenção e retry. |
| ViaCEP | Parcial | Fetch no browser | Timeout, inexistente, privacidade e fallback. |
| ffmpeg | Funcionando localmente | Binários/pipeline | Matriz adversa de formatos. |

## 10. Segurança e qualidade

- `npm audit`: **10 vulnerabilidades** — 1 crítica (`tar` transitiva de bcrypt), 3 altas (nodemailer), 6 moderadas (`qs`/`uuid` e cadeias). Não atualizar nesta auditoria; fazer mudança separada com testes.
- Pontos fortes: CSP estrita, HMAC/body cru/janela, comparação constante, sessão Postgres, chave da tela, autorização e PostgREST fechado.
- CI não roda E2E browser e não cobre congelamento/player.
- `npm run check`: sintaxe/lint/formato passaram; 101/122 testes passaram. Os 21 restantes falharam só por `ENETUNREACH` ao Postgres remoto TCP, limitação conhecida, não asserção.
- Confirmar se workflow semanal vermelha notifica alguém. Backup Free/script não substitui restauração testada.
- Observabilidade do player é insuficiente: falhas são engolidas e não há correlação item/início/fim/confirmação.
- CI procura arquivo `.env`, não segredo em conteúdo. Adotar scanner e proteção GitHub.
- Reconciliar migration 051 com documentação/código que chama rate limit de memória.

## 11. Débito técnico (não bug)

- `admin/index.page.js` e `painel.page.js` são monólitos de alto churn.
- Fetch/erro/loading repetidos podem divergir.
- `PENDENCIAS.md` virou diário; extrair estado ativo sem perder histórico.
- Regenerar `teia.md`/`furos.md` após estabilizar.
- Separar testes puros/integração e documentar provisionamento.
- Adicionar testes de mídia/eventos e concorrência.
- Definir limpeza temporal e cache de mídia v2.

## 12. Ordem real de fechamento

1. Observar na TV playlist, URL/codec, eventos, console/rede, heartbeat e `/played`.
2. Decidir evento de entrega, retry/idempotência, offline e virada de hora.
3. Corrigir B1 com identidade, idempotência e retry; decidir B2 separadamente antes de alterar banco ou reconciliar dados.
4. Corrigir/testar B3/B4 com concorrência real.
5. Fechar troca no Checkout com matriz upgrade/downgrade/ciclo.
6. Confirmar jobs, backup e restauração.
7. Executar checklist funcional por ator, classificando toda descoberta.
8. Rodada visual desktop/celular/TV, sem redesign.
9. Dependências, CI, observabilidade e secret scanning em mudanças isoladas.
10. Sincronizar docs, limpar banco só com roteiro, smoke final e aceite.

## 13. Critério objetivo de fechamento

- [ ] B1 e B3–B5 corrigidos/explicados com evidência; B2 decidido como regra de produto; nenhum P0/P1 aberto.
- [ ] Checklist essencial executado; exceções têm dono/prazo aceitos.
- [ ] “Entrega” é única em playlist, contador, painel, banco, contrato e docs.
- [ ] Contratação, troca, cancelamento, renovação e contestação validadas.
- [ ] Player validado online/offline, erro, reload, virada, congelamento e confirmação.
- [ ] Jobs têm agenda, último sucesso, alerta/reexecução; backup foi restaurado.
- [ ] Integrações essenciais confirmadas ou exceção aceita.
- [ ] Vulnerabilidades corrigidas ou risco aceito.
- [ ] Rodada visual completa e achados classificados.
- [ ] `.ia`, docs, código e infraestrutura sem divergência material.
- [ ] Banco auditado antes da limpeza e smoke/rollback definidos.
- [ ] Dono encerra a seção F de `docs/PENDENCIAS.md`.

## Áreas mais frágeis

1. Player, confirmação e observabilidade.
2. Semântica/operação do banco de horas.
3. Concorrência do congelamento.
4. Troca e consistência Mostraí/Checkout.
5. Jobs, backup/restauração e dependências.
6. Documentação extensa e divergente.
