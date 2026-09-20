# Investigação do player e da confirmação de exibição — 20/09/2026

> Etapa de leitura e definição de contrato. Nenhum código, banco ou serviço foi alterado. Este documento corrige uma conclusão excessiva da auditoria anterior: o banco de horas atual mede **déficit de capacidade** (`pedidas - programadas`) por decisão implementada, não falha física de reprodução (`programadas - confirmadas`). Isso é uma divergência de significado a decidir, não prova isolada de bug no cálculo do banco.

## Resumo decisório

O player não possui estados explícitos de execução. Ele conhece uma lista, um índice e um único `<video>`. Toda imagem já chega como MP4; não existe caminho de `<img>` para criativo. Ao selecionar um item, troca `src`, chama `video.play()` sem aguardar sucesso e imediatamente dispara `/played`. `ended` serve somente para avançar, não para confirmar. A requisição de confirmação não é aguardada, não é lida e não tem retry.

O backend registra apenas agregados por anunciante, tela e janela horária. Não recebe criativo, posição, janela programada, instante de início/fim nem identificador idempotente. Seu teto impede ultrapassar `vezes_programadas`, mas não identifica duplicata: dois envios da mesma execução podem consumir duas vagas enquanto ainda houver saldo. Na virada, uma confirmação de peça da hora anterior tenta primeiro creditar a hora atual, o que pode atribuí-la à janela errada.

## 1. Fluxo atual completo

### 1.1 Inicialização e autenticação

1. `player.html` cria um `<video id="player" muted playsinline preload="auto">`, o institucional, mensagem e alvo do painel.
2. `player.page.js` lê `tela` (aceita aliases antigos `dispositivo`/`ponto`), orientação e margem.
3. A chave chega uma vez em `?chave=` e fica no `localStorage`; requests usam `X-Aparelho-Id`.
4. Sem ID/chave, apenas mostra erro. Com ambos, carrega a playlist do `localStorage`, chama `atualizarPlaylist().then(tocarProximo)`, agenda polls, heartbeat e reload diário.
5. Backend `exigirAparelho` procura dispositivo+ponto, compara a chave e exige dispositivo `ativo` e ponto `em_operacao`.

### 1.2 Solicitação da playlist

- Endpoint: `GET /playlist/:dispositivoId`, autenticado pela chave.
- Frequência: a cada 15 minutos e na virada de cada hora, com atraso estável de 0–29 segundos derivado do primeiro caractere da chave.
- Na primeira carga, `tocarProximo` só começa quando o primeiro fetch resolve/rejeita. Não há timeout próprio com `AbortController`.
- `401`: mensagem de chave inválida; a lista em memória não é esvaziada nem o avanço iniciado nessa primeira promessa até a função retornar.
- `403`: limpa lista/cache, ativa institucional e mostra o erro operacional.
- Outros HTTP/erro de rede: mantém cache por até uma hora; depois mostra apenas institucional. `ultimoContatoOk` nasce em `Date.now()`, mesmo sem contato bem-sucedido nesta execução.
- Sucesso: substitui toda a lista, salva em `localStorage` e inicia download best-effort das URLs para Cache API. `prepararArquivos` não é aguardada.

### 1.3 Formato recebido

Item pago:

```json
{
  "anuncianteId": 123,
  "url": "https://.../criativo.mp4",
  "duracaoSegundos": 15
}
```

Autoanúncio do dono tem `anuncianteId: null` e `autoanuncio: true`. Inventário vago tem `anuncianteId: null`, `institucional: true`, `url: null` e duração. Não há `criativoId`, `itemId`, `playlistId`, `janelaHora`, posição ou token de execução. Portanto URL é hoje a única forma de distinguir peças do mesmo anunciante no navegador.

### 1.4 Fila, cache e escolha

- A fila é o array `playlist`; `indice` começa em zero e cresce módulo do tamanho atual.
- Um poll substitui o array sem reposicionar/resetar semanticamente o índice. O mesmo número passa a apontar para o item daquela posição na lista nova.
- Cache da lista: `localStorage`. Cache da mídia: Cache API por tela.
- Cada URL nova é baixada sequencialmente em background. Se ainda não estiver em cache, `fonteDe` devolve a URL de rede.
- Quando há cache, a resposta vira Blob/Object URL. Só o Object URL atual fica vivo; o anterior é revogado depois da troca de `src`.

### 1.5 Mídia e avanço

1. `tocarProximo` pausa a lógica enquanto o painel PIN está aberto.
2. Sem lista ou offline há mais de uma hora: institucional e nova tentativa em 5 s.
3. Item institucional: pausa/oculta vídeo e agenda próximo após `max(2, duracao || 10)` segundos.
4. Item sem URL: pula após 1 s.
5. Item de mídia: resolve fonte, atribui `video.src`, mostra o `<video>`, chama `video.play()` e ignora rejeição.
6. Se houver anunciante, dispara `/played` **imediatamente**, sem relação com evento do vídeo.
7. `ended`: chama o próximo item.
8. `error`: escreve “item falhou, pulando” e avança após 500 ms.
9. `stalled`: após 10 s só avança se `video.paused` e o painel estiver fechado.
10. Não há listeners para `loadstart`, `loadedmetadata`, `loadeddata`, `canplay`, `playing`, `waiting`, `pause`, `abort`, `emptied`, `timeupdate` ou `durationchange`. Não há timeout geral de carregamento/reprodução.

### 1.6 Imagens

O player **não exibe imagens como imagens**. No upload, ffprobe identifica foto e ffmpeg gera MP4 H.264 em loop, com a duração máxima do plano (fallback de 10 s sem plano). Storage recebe `<criativoId>.mp4`; a playlist e o player tratam foto e vídeo da mesma forma.

Consequências:

- início, conclusão e erro de uma “imagem” são eventos do `<video>` normalizado;
- `ended` é o evento natural de conclusão;
- falha de decodificação/URL segue `error` como qualquer vídeo;
- a duração contratual vem de `criativos.duracao_segundos`, mas a conclusão real deve vir de `ended`, não de `setTimeout` no player;
- `setTimeout` existe apenas para o institucional HTML, que não é contabilizado.

### 1.7 Heartbeat

- `POST /player/:dispositivoId/heartbeat` no boot e a cada 5 minutos.
- Backend atualiza `dispositivos.ultima_vez_online = now()` e responde `{ok:true}`.
- Frontend não aguarda, não lê status e não registra falha. Heartbeat prova acesso periódico à API, não prova mídia carregada ou reprodução.

### 1.8 `/played`

Request atual:

```http
POST /player/:dispositivoId/played
X-Aparelho-Id: <chave>
Content-Type: application/json

{"anuncianteId": 123}
```

Backend usa a tela autenticada, o anunciante e `new Date()` do servidor. Tenta incrementar `vezes_confirmadas` da hora atual se abaixo de `vezes_programadas`; nos primeiros 15 minutos, tenta depois a hora anterior. Respostas:

- `200 {"ok":true,"janela":"atual"}` ou `"anterior"`: incrementou;
- `200 {"ok":true,"contou":false,"motivo":"ja_completo"}`: existe linha atual, mas já chegou ao teto;
- `400 {"erro":"anunciante não está programado..."}`: não encontrou linha atual elegível;
- `401/403/404`: aparelho, estado ou tela inválidos.

O frontend não chama `.then`, não lê body/status e só engole rejeição. Não há retry, fila local ou confirmação visual.

### 1.9 Banco e métricas

`exibicoes_contador` é uma linha agregada por anunciante+tela+hora (a chave foi migrada de ponto para dispositivo). Campos relevantes:

- `vezes_pedidas`: demanda antes do corte de capacidade;
- `vezes_programadas`: itens que o gerador colocou na hora;
- `vezes_confirmadas`: aceitações de `/played`, hoje enviadas na tentativa de início.

A linha nasce/é atualizada quando a playlist é **gerada**, antes de qualquer reprodução. `/played` apenas incrementa confirmadas sob teto.

Dependem de confirmadas: CSV proof-of-play, gráficos por dia/ponto, horas/exibições entregues do anunciante, painel da tela, contagem de 30 dias do ponto e resumo administrativo. Programadas aparecem como denominador/comparação e diagnóstico.

O banco de horas tem propósito mais estreito no código atual:

- criação mensal: `SUM(vezes_pedidas) - SUM(vezes_programadas)`; compensa corte por falta de espaço na grade;
- não inclui `programadas - confirmadas`; comentário afirma que tela offline é problema separado;
- drenagem: ocorre durante geração de uma nova playlist, proporcional ao que coube em `programadas`, antes de confirmação física.

Logo, mudar `/played` para pós-`ended` melhora todas as métricas baseadas em confirmadas, mas **não altera sozinho** criação/drenagem do banco. Para o banco representar entrega física, é necessária decisão de produto, novo cálculo e provável reconciliação/migration; isso não deve ser embutido silenciosamente na correção do player.

## 2. Contrato conceitual

| Estado | Definição | Existe hoje? | Onde |
|---|---|---|---|
| Programada | Gerador reservou um item na janela da tela | Sim | `vezes_programadas` e array retornado |
| Entregue à TV | HTTP da playlist devolveu o item ao browser | Não persistido | Inferível apenas durante o request |
| Em preparação | Cache/download/fonte começou | Parcial, sem estado/log | Cache API e troca de `src` |
| Carregada | Browser possui metadados/dados reproduzíveis | Não observado | Eventos existem no browser, sem listeners |
| Iniciada | Browser emitiu `playing` | Não observado | Hoje `play()` é tratado implicitamente como início |
| Concluída | `ended` da execução atual | Usado só para avançar | Não ligado a confirmação |
| Falhou | `error`, ou stall/timeout decidido | Parcial | `error`; stall incompleto; sem timeout |
| Confirmação aceita | Backend incrementou exatamente uma execução | Parcial | Incremento existe; frontend ignora resposta e não há ID idempotente |

Hoje “selecionada/tentada”, “iniciada”, “concluída” e “aceita” são comprimidas pelo frontend no mesmo instante. Programada continua separada no banco, mas o nome `confirmadas` sugere uma certeza que o protocolo não fornece.

## 3. Eventos de vídeo: leitura e escolha

| Evento/operação | Uso atual | Significado correto |
|---|---|---|
| atribuir `src` | Sim | preparação começou, não entrega |
| `loadstart` | Não | browser começou a buscar; útil a diagnóstico |
| `loadedmetadata` | Não | duração/dimensões conhecidas; não tocou |
| `loadeddata` | Não | primeiro frame disponível; não tocou |
| `canplay` | Não | estima que pode começar; não tocou |
| `play()` resolvido | Ignorado | pedido de reprodução aceito; não garante frames nem fim |
| `playing` | Não | playback efetivamente avançou após start/buffering; bom para “iniciada” |
| `waiting` | Não | buffering; não é falha final |
| `stalled` | Parcial | download deixou de avançar; precisa timeout/estado por execução |
| `error` | Avança | falha terminal dessa fonte; nunca deve confirmar |
| `ended` | Avança | melhor evidência nativa de execução completa; deve disparar confirmação |
| `pause`/`abort`/`emptied` | Não | úteis para distinguir troca/painel/interrupção |

**Contrato recomendado:** `playing` marca início apenas para telemetria local/operacional; `ended` marca conclusão e habilita confirmação. Confirmar antes de `ended` só seria justificável com uma regra explícita de porcentagem mínima, que o produto não possui hoje.

## 4. Falhas confirmadas

1. `/played` é enviado antes de `playing` e `ended`; uma URL/codec pode falhar depois de já ter sido contabilizada.
2. Rejeição de `play()` é ignorada; mesmo assim `/played` é enviado.
3. Resposta e status de `/played` são ignorados; TV não sabe se o servidor contou.
4. Não existe retry de confirmação; queda após `ended` (num contrato futuro) ou no request atual perde contagem.
5. Não existe chave idempotente. O teto horário limita o total, mas não deduplica uma execução; duplicata pode ocupar duas das N programadas.
6. Request não carrega criativo/item/janela. Não é possível provar qual peça terminou nem atribuir inequivocamente a janela.
7. Na virada, backend tenta hora atual antes da anterior. Uma conclusão atrasada da hora anterior pode incrementar uma vaga da hora atual se o mesmo anunciante estiver programado nas duas.
8. `stalled` não constitui timeout robusto: em muitos stalls `paused` permanece falso e nenhum avanço é garantido.
9. Não há timeout de fetch da playlist nem da mídia.
10. Logs atuais mostram apenas resumo da playlist ou último erro; não oferecem trilha por execução.
11. O relatório anterior classificou banco por programadas como bug confirmado de entrega física. O código prova que ele foi desenhado para déficit de **capacidade**; a possível ampliação para falha física é decisão pendente.

## 5. Riscos de falsa contabilização

- **Falso positivo:** `play()` rejeita, mídia emite `error`, browser fecha ou painel pausa logo após `/played`.
- **Falso negativo:** request `/played` falha/é recusado e não há retry.
- **Duplicata:** reload/retentativa externa faz novo envio sem ID; teto não identifica a execução original.
- **Janela errada:** execução atravessa a hora e o servidor credita primeiro a janela atual.
- **Criativo errado:** duas peças do mesmo anunciante são indistinguíveis no contador/request.
- **TV “online” falsa:** heartbeat funciona, mas mídia pode não carregar/tocar.
- **Cache/lista:** poll troca array mantendo índice; diagnóstico visual pode parecer repetição/pulo.
- **Banco:** uma recuperação é marcada drenada quando coube na nova programação, ainda que não haja confirmação física. Isso é coerente com o desenho de capacidade, mas não com uma promessa comercial de entrega real se essa for adotada.

## 6. Contrato proposto

### Identidade mínima

Cada ocorrência retornada pela playlist deve conter:

- `playbackId` opaco e único para tela+janela+posição/ocorrência;
- `criativoId`;
- `anuncianteId`;
- `janelaHora` explícita;
- `url`, `duracaoSegundos`, posição e tipo.

Não usar URL como identidade e não confiar no relógio da TV para decidir a janela.

### Máquina de estados

1. **PROGRAMADA:** backend persistiu ocorrência e a incluiu na resposta.
2. **ENTREGUE_A_TV:** opcionalmente telemetria de playlist recebida; não conta exibição.
3. **CARREGANDO:** `src` atribuído/`loadstart`; não conta.
4. **CARREGADA:** `canplay`/primeiro frame; não conta.
5. **INICIADA:** `playing` da ocorrência atual; telemetria, não proof-of-play.
6. **CONCLUÍDA_LOCALMENTE:** `ended` da mesma ocorrência, sem erro/troca/painel; cria confirmação pendente local.
7. **CONFIRMADA:** servidor aceita `playbackId` idempotentemente e responde 2xx com `contou:true` (ou duplicata já aceita com estado equivalente).
8. **FALHOU:** `error`, rejeição de `play()`, timeout terminal ou interrupção; não incrementa confirmadas, registra diagnóstico e avança.

### Regra contábil

- Dashboard/proof-of-play: somente **CONFIRMADA**.
- Uma ocorrência aceita no máximo uma vez por unique `playbackId`.
- Retry persiste localmente até aceite/expiração; duplicata devolve sucesso idempotente.
- Backend credita a `janelaHora` assinada/validada da ocorrência, não “agora”.
- `ended` deve disparar confirmação antes de avançar, mas o avanço não pode ficar bloqueado pela rede: enfileira, tenta e segue.
- Institucional e autoanúncio não entram no proof-of-play pago.
- Banco de horas: manter déficit de capacidade separado de déficit físico. Se ambos gerarem crédito, usar saldos/origens distintas para não pagar duas vezes a mesma falta.

## 7. Plano de correção — ainda não implementar

1. **Decisão de produto:** aprovar `ended` como conclusão e decidir se falha física entra no banco de horas ou em mecanismo separado.
2. **Contrato/schema:** criar ocorrências identificáveis (tabela ou token determinístico) e tabela de confirmações idempotentes; planejar retenção.
3. **Gerador:** incluir `playbackId`, `criativoId`, `janelaHora` e posição sem quebrar institucional/dono; resolver corridas do congelamento antes ou junto.
4. **Backend `/played`:** receber `playbackId`, validar aparelho/ocorrência, inserir idempotentemente, responder `contou`, estado e janela; manter compatibilidade temporária se necessário.
5. **Player:** máquina de estado por ocorrência; listeners `loadstart/loadedmetadata/canplay/playing/waiting/ended/error/stalled`; timeout cancelável; confirmar em `ended`; fila persistente de confirmação e retry com backoff.
6. **Logs diagnósticos:** modo `?debug=1` ou painel protegido, sem expor chave, mostrando IDs, URL sanitizada, eventos, tempos e HTTP.
7. **Métricas:** continuar lendo confirmadas aceitas; adicionar taxa programada/iniciada/concluída/confirmada e falhas por tela.
8. **Banco:** manter capacidade e decidir política de falha física; migrar/reconciliar apenas banco de desenvolvimento com roteiro.
9. **Testes:** unidade da máquina, mídia erro/stall/play rejeitado, retry/idempotência, virada, cache/offline; integração com duas requisições e E2E em vídeo curto.
10. **Rollout:** uma TV em modo sombra, comparar eventos, depois ativar contagem nova e monitorar antes de limpar legado.

Arquivos principais: `public/player.page.js`, `public/player.html`, `public/player.css`, `src/player/routes.js`, `src/playlist/gerador.js`, `src/playlist/congelamento-repository.js`, novas migrations, `src/anunciantes/routes.js`, `src/dispositivos/routes.js`, `src/bancohoras/*` e testes.

## 8. Congelamento e impacto no diagnóstico

As duas corridas podem interferir se houver polls simultâneos:

- bases distintas podem fazer duas respostas divergirem na primeira geração;
- extras duplicados podem repetir ocorrências e aumentar `vezes_programadas`.

Na TV atual, uma única página normalmente faz um poll por vez, mas virada da hora e intervalo de 15 minutos podem coincidir; reload/duas abas/proxy retry também tornam concorrência possível. Para o diagnóstico físico, registrar timestamp e corpo de **cada** resposta e garantir uma única aba. Se houver listas diferentes, não atribuir imediatamente o efeito ao playback. As corridas não explicam, sozinhas, `/played` ignorado nem a falta de heartbeat.

## 9. Roteiro curto para a TV física

### Sem instrumentação nova

1. No admin, anotar ID da tela, estado ativo, ponto operacional e `última vez online`.
2. Na TV, confirmar uma única aba e URL completa; pressionar `P` ou tocar cinco vezes no canto superior direito para abrir o painel PIN.
3. Anotar contadores programadas/confirmadas antes do teste e fechar o painel.
4. Conectar teclado ou depuração remota do navegador e abrir DevTools **Network + Console + Media**.
5. Filtrar por `playlist`, `played`, `heartbeat` e `.mp4`; preservar log.
6. Recarregar. Registrar status/corpo da playlist, quantidade e URLs; não publicar a chave.
7. Para a peça investigada, anotar horário de `src`, início visual/áudio mudo, conclusão visível, request `/played`, status/body e próxima peça.
8. Repetir com rede normal; depois simular queda antes do carregamento e durante a peça.
9. Reabrir painel e comparar o delta confirmado: deve corresponder aos `/played` aceitos, não necessariamente às conclusões visuais no protocolo atual.
10. Consultar `ultima_vez_online` após mais de cinco minutos e salvar screenshots/export HAR sem headers secretos.

### Logging existente

O canto inferior mostra apenas `api`, “playlist ok (N itens)”, offline/chave/estado e último “item falhou”. O painel PIN mostra agregados de 30 dias. Isso **não é suficiente** para correlacionar uma execução.

### Instrumentação temporária mínima proposta

Antes da sessão, se DevTools remoto não for viável, adicionar um modo `?debug=1` que mantenha um buffer circular apenas na tela, exibindo: timestamp, `playbackId`/índice, anunciante/criativo, URL sem query, evento de mídia, `currentTime/duration`, heartbeat, request e status/body de `/played`, e avanço. Nunca imprimir a chave. Essa instrumentação deve ser um commit separado, facilmente removível, sem alterar regra de contagem.

## 10. Instrumentação temporária implementada

O modo de observação foi implementado sem alterar o contrato de contabilização. Ative acrescentando `debug=1` à URL completa do aparelho (`&debug=1` quando ela já contém `?tela=...`). Sem esse valor exato, nenhum painel é criado, nada é escrito no console/sessionStorage e as funções de diagnóstico são no-op.

O painel mostra estado, peça/índice, anunciante, criativo quando disponível (hoje aparece `n/d` porque a playlist não o fornece), duração, janela inferida/fornecida, URL sem query string, evento recente, último `/played`, heartbeat, playlist, erros e 12 eventos recentes. O botão no topo alterna entre **Ocultar diagnóstico** e **Mostrar diagnóstico**. Até 40 linhas sanitizadas sobrevivem a reload na mesma aba via `sessionStorage`.

Eventos instrumentados: poll/HTTP/recebimento/falha da playlist; seleção e preparação; origem cache/rede; `play()` chamado/resolvido/rejeitado; `loadstart`, `loadedmetadata`, `canplay`, `playing`, `waiting`, `stalled`, `error`, `ended`; envio/resposta/falha de `/played`; envio/resposta/falha de heartbeat; institucional, espera e avanço.

Segurança: a URL exibida contém somente host e os dois últimos segmentos do caminho; query e fragmento são removidos. A chave, headers, cookies e storage de autenticação nunca entram no logger. O request, payload, momento e fire-and-forget de `/played`, bem como heartbeat, polling, ordem, duração e métricas, permanecem inalterados.
