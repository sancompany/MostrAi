# Contrato do Mostraí Player MVP

**Status:** contrato oficial entre o backend Mostraí e o Mostraí Player
(Android TV). Vale a partir de 26/09/2026 e substitui qualquer referência ao
antigo "contrato V2" (`docs/player-v2-contract.md`, que nunca existiu neste
repositório). O backend fala **somente** este contrato: não há mais Player
web (V1), hello, OTA, rotação remota, baseUrl por tela nem rotação de
credencial.

O Player faz só isto:

```
PROVISIONAR → RECEBER PLAYLIST → REPRODUZIR → CACHEAR → FUNCIONAR OFFLINE
            → CONFIRMAR PROOF-OF-PLAY → ENVIAR HEARTBEAT → RECEBER CONFIG MÍNIMA
```

Rotas (5):

| Método | Caminho | Auth |
|---|---|---|
| POST | `/player/provisionar` | código de instalação |
| GET | `/playlist/:dispositivoId` | chave do aparelho |
| POST | `/player/:dispositivoId/played` | chave do aparelho |
| POST | `/player/:dispositivoId/heartbeat` | chave do aparelho |
| GET | `/player/:dispositivoId/config` | chave do aparelho |

Tudo é JSON UTF-8 (`Content-Type: application/json`). Corpo maior que 100 KB
responde 413.

---

## 1. O que fica fixo no APK

| Item | Valor |
|---|---|
| URL base | `https://mostrai.sancocore.com.br` (produção). Não varia por tela. |
| Orientação | 90° (se o primeiro teste mostrar a imagem de ponta-cabeça, 270°). Não é configurável remotamente. |
| Heartbeat | a cada **15 s**. |
| Busca da playlist | na virada de cada hora, a cada 15 min, quando o heartbeat mandar `playlist.atualizar: true`, e quando a rede voltar. |
| Envio de proof-of-play | a cada 60 s e ao voltar a rede. |

O backend não manda nenhum desses valores.

---

## 2. Identidade da tela

Cada tela tem um **código humano estável** derivado do id interno:

```
M-0001, M-0035, M-0235, M-9999, M-12345
```

- prefixo `M-` + o id com no mínimo 4 dígitos, nunca truncado;
- não é segredo;
- é o `dispositivoId` do contrato: vai no caminho de todas as rotas
  autenticadas;
- entrada tolerante: `M-0235`, `m-0235`, `M0235`, `0235` e `235` normalizam
  para `M-0235`.

O código **não muda** ao revogar ou reinstalar um Player. O que muda é a
credencial.

---

## 3. Provisionamento — `POST /player/provisionar`

A TV, na primeira abertura, mostra uma tela local com dois campos:
**ID da tela** e **código de instalação**. O operador copia os dois do admin
(Rede → Ponto → Tela).

### Código de instalação

- 8 caracteres do alfabeto `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (sem `0 O 1 I L`),
  exibido como `XXXX-XXXX` (ex.: `7K4M-9Q2W`);
- ~40 bits de entropia; vinculado a UMA tela;
- válido por **30 minutos**; uso único;
- gerar um novo cancela o anterior; revogar o Player cancela o pendente;
- **5 tentativas erradas** para a mesma tela cancelam o código (é preciso
  gerar outro no admin);
- case-insensitive; espaços e hífen são ignorados.

O código **não é** a credencial: ele só é trocado por ela.

### Requisição

```json
{ "codigoTela": "M-0235", "codigoInstalacao": "7K4M-9Q2W" }
```

Headers: nenhum de autenticação. `X-Player-Version` é opcional.

### Respostas

| HTTP | Corpo | Quando | O que o Player faz |
|---|---|---|---|
| 200 | `{ "dispositivoId": "M-0235", "chaveAparelho": "<43 caracteres>" }` | código certo e válido | grava as duas coisas no armazenamento interno e some com a tela de instalação |
| 400 | `{ "erro": "…" }` | corpo não é objeto, ID em formato inválido, código com tamanho/caractere inválido | mostra "confira o ID e o código" |
| 401 | `{ "erro": "ID da tela ou código de instalação inválido, expirado ou já usado" }` | tela inexistente, código errado, expirado, cancelado ou já usado (mesma resposta para todos) | mostra a mensagem; **não** tenta de novo sozinho |
| 429 | `{ "erro": "…" }` + `Retry-After` (s) | limite de tentativas por origem | espera o `Retry-After` |
| 5xx | — | falha do servidor | pode tentar de novo |

- **Repetição curta:** se a resposta 200 se perder, reenviar o mesmo par
  (ID + código) em até 5 minutos devolve a **mesma** credencial — até a
  primeira requisição autenticada com ela, que fecha essa janela.
- A `chaveAparelho` tem 256 bits aleatórios, é guardada no servidor só como
  hash e nunca aparece no admin, em log ou em evento. O operador nunca a vê.
- Duas trocas simultâneas do mesmo código geram UMA credencial.

---

## 4. Autenticação das rotas da tela

Toda rota com `:dispositivoId` exige:

```
X-Aparelho-Key: <chaveAparelho>
X-Player-Version: 1.2.0+12        (versionName+versionCode — recomendado em todas)
```

| HTTP | Significado | O que o Player faz |
|---|---|---|
| 401 | chave ausente, errada ou revogada; tela inexistente; ponto arquivado | apaga a credencial e volta para a tela de instalação |
| 403 | tela em **reparo** ou **inativa** no cadastro (só `/playlist` e `/played`) | não exibe anúncios novos; mantém os proof-of-play na fila e tenta de novo depois (a tela pode voltar a "Ativa") |

`/heartbeat` e `/config` nunca respondem 403: a tela continua dando sinal
mesmo em reparo.

---

## 5. Heartbeat — `POST /player/:dispositivoId/heartbeat`

A cada **15 s**. O servidor usa para: último sinal, saúde da tela, erro atual,
fila de comprovantes, versão do Player e confirmação da config aplicada.

### Requisição

```json
{
  "estado": "PLAYING",
  "configVersionAplicada": 7,
  "criativoId": "123",
  "erro": null,
  "fila": { "pendentes": 0, "maisAntigoEm": null }
}
```

| Campo | Tipo | Regra |
|---|---|---|
| `estado` | enum | `PLAYING`, `IDLE`, `OUT_OF_SCHEDULE`, `NO_PLAYLIST`, `DOWNLOAD_ERROR`, `PLAYBACK_ERROR`, `AUTH_ERROR`, `NOT_PROVISIONED`, `CONFIG_ERROR`. Ausente ou desconhecido = não informado. |
| `configVersionAplicada` | inteiro ≥ 0 | versão da config que está valendo na TV (0 = nunca recebeu). |
| `criativoId` | string | criativo comercial no ar agora; ausente = nenhum. |
| `erro` | objeto ou `null` | `{ "codigo": "PLAYBACK_FALHOU", "mensagem": "…", "ocorreuEm": "<ISO-8601>" }`. `null` = sem erro (limpa o anterior). Ausente = não informado (mantém). |
| `fila` | objeto | `pendentes` (inteiro) e `maisAntigoEm` (ISO-8601 ou `null`) dos proof-of-play ainda não enviados. Ausente = não informado. |

Corpo `{}` é válido: registra o sinal de vida; `estado` e `criativoId`
ficam "não informado"/"nenhum" (são o retrato de agora), `erro` e `fila`
ficam como estavam. Campo com tipo errado é ignorado; o resto vale. Corpo
que não é objeto JSON → 400. Sem limite de frequência: 15 s é o ritmo normal.

A versão do Player vem **só** do header `X-Player-Version`.

### Resposta 200

```json
{ "configVersion": 7, "playlist": { "atualizar": false } }
```

- `configVersion` diferente da aplicada → o Player faz `GET /config`.
- `playlist.atualizar: true` vem **uma vez** por mudança (criativo novo,
  plano, cobertura) → o Player busca a playlist na hora.

O heartbeat não devolve margens, chave, atualização de APK nem relógio.

---

## 6. Config — `GET /player/:dispositivoId/config`

Chamada quando `configVersion` do heartbeat difere da aplicada. A config
inteira vem de uma leitura só (versão e conteúdo nunca divergem).

```json
{
  "configVersion": 7,
  "margens": { "superior": 0, "direita": 1.5, "inferior": 0, "esquerda": 1.5 },
  "operacao": {
    "timezone": "America/Sao_Paulo",
    "porDiaDaSemana": {
      "seg": [{ "inicio": "08:00", "fim": "18:00" }],
      "ter": [{ "inicio": "08:00", "fim": "18:00" }],
      "qua": [{ "inicio": "08:00", "fim": "18:00" }],
      "qui": [{ "inicio": "08:00", "fim": "18:00" }],
      "sex": [{ "inicio": "08:00", "fim": "22:00" }],
      "sab": [{ "inicio": "18:00", "fim": "02:00" }],
      "dom": []
    },
    "feriados": { "2026-10-12": [], "2026-11-02": [] }
  },
  "pinSaida": "4821"
}
```

### Margens (área segura)

- por tela, em **vmin** (1 vmin = 1% do menor lado da tela), de 0 a 10 por
  lado; o admin edita topo, direita, inferior e esquerda;
- o Player aplica **na hora**, sem reiniciar o app nem o vídeo (padding do
  contêiner do vídeo). A orientação fixa do APK é compensada pelo Player
  (margem é visual: "superior" é o topo que o espectador vê).

### Operação (horário)

Toda tela segue o **horário do ponto** (não existe horário por tela).

- `timezone`: fuso do ponto. Hoje é sempre `America/Sao_Paulo`.
- `porDiaDaSemana`: sempre os 7 dias (`seg`…`dom`). Lista vazia = fechado o
  dia inteiro.
- faixa `{inicio, fim}` em `HH:MM`: início inclusivo, fim exclusivo;
  `fim: "24:00"` = até o fim do dia; `fim` menor que `inicio` cruza a
  meia-noite, e a madrugada pertence à faixa do dia em que começou.
- ponto sem horário cadastrado = aberto 24 h (todos os dias `00:00`–`24:00`).
- `feriados`: data (`AAAA-MM-DD`) → faixas daquele dia. **Substitui** o dia
  da semana, inclusive a madrugada que viria da véspera. Feriados nacionais
  do ano corrente e dos dois seguintes; `{}` = sem regra especial.
- fora do horário o Player não exibe anúncios (mostra o cartão local) e
  manda `estado: OUT_OF_SCHEDULE`. Guardar a última `operacao` recebida é o
  que permite decidir o horário **offline**.

### PIN de saída

- `pinSaida`: PIN **global** (o mesmo para todas as telas), 4 a 8 dígitos,
  definido pelo operador em Rede. Trocar o PIN sobe a `configVersion` de
  todas as telas.
- `pinSaida: null` = nenhum PIN definido ainda. O admin não gera código de
  instalação enquanto não houver PIN, então um Player instalado sempre o
  recebe. Com `null`, o Player **não permite** saída autorizada (nunca usa
  um PIN padrão).
- PIN correto → saída autorizada: o watchdog local **não** reabre o app. Ao
  abrir o app de novo (manual ou boot), a operação normal e o watchdog
  voltam. O backend não é avisado da saída: 2 minutos depois a tela aparece
  como "Sem sinal" no admin, que é o fato.

---

## 7. Playlist — `GET /playlist/:dispositivoId`

A playlist é **da hora cheia** do servidor e fica congelada durante a hora
(quem entra depois vai para o fim).

```json
{
  "versaoContrato": 2,
  "janelaId": "235|2026-09-26T14:00:00.000Z",
  "janelaInicio": "2026-09-26T14:00:00.000Z",
  "janelaFim": "2026-09-26T15:00:00.000Z",
  "servidorAgora": "2026-09-26T14:07:31.512Z",
  "itens": [
    {
      "itemProgramacaoId": "235|2026-09-26T14:00:00.000Z|0|17",
      "criativoId": "88",
      "anuncianteId": 17,
      "autoanuncio": false,
      "institucional": false,
      "contabiliza": true,
      "url": "https://…/criativos/88.mp4",
      "duracaoSegundos": 15,
      "contentHash": "3f2a…(64 hex)"
    }
  ]
}
```

| Campo | Uso no Player |
|---|---|
| `janelaId` | devolvido no proof-of-play de cada item desta hora |
| `janelaInicio` / `servidorAgora` | âncora para calcular em que posição da hora o Player está (o relógio da TV pode estar errado) |
| `janelaFim` | fim da janela (informativo) |
| `itens` | a sequência da hora, na ordem; a posição é a ordem do array |
| `itemProgramacaoId` | identidade estável do item entre buscas da mesma hora; devolvido no proof-of-play |
| `url` / `contentHash` | baixar, conferir o SHA-256 e guardar por conteúdo; sem `contentHash`, guardar por `criativoId` |
| `duracaoSegundos` | tempo do item |
| `contabiliza` | `true` = gera proof-of-play ao terminar; `false` (institucional, autoanúncio, mídia própria) não gera |
| `institucional` | preenchimento da rede (vídeo institucional configurado em Mídia Mostraí). Sem `url`, o Player mostra o cartão local pelo tempo do item |

- A lista quase nunca vem vazia: tempo não vendido vira vídeo institucional.
- Falha de rede ou 5xx → o Player continua a **última playlist válida** e o
  cache. Na virada da hora sem rede, continua a última que tinha.
- 401 → reinstalação; 403 → ver §4.

---

## 8. Proof-of-play — `POST /player/:dispositivoId/played`

Um evento por reprodução **concluída** (fim do vídeo). Reprodução
interrompida não gera evento. O Player guarda os eventos numa fila durável e
envia em lotes.

### Requisição

```json
{
  "eventos": [
    {
      "execucaoId": "6f1c…-uuid",
      "janelaId": "235|2026-09-26T14:00:00.000Z",
      "itemProgramacaoId": "235|2026-09-26T14:00:00.000Z|0|17",
      "criativoId": "88",
      "iniciadoEm": "2026-09-26T14:07:31-03:00",
      "terminadoEm": "2026-09-26T14:07:46-03:00"
    }
  ]
}
```

- até **500** eventos por lote;
- `execucaoId`: UUID gerado pelo Player, **igual em todas as retentativas**
  do mesmo evento (é a chave de idempotência); até 100 caracteres entre
  letras, números, `.`, `_`, `:` e `-`;
- `janelaId` e `itemProgramacaoId`: exatamente os recebidos na playlist;
- `criativoId`, `iniciadoEm`, `terminadoEm`: informativos (o servidor não
  confia no relógio da TV).

### Resposta 200

```json
{ "resultados": [{ "execucaoId": "6f1c…", "status": "contabilizado" }] }
```

Todo evento com `execucaoId` string não vazia recebe exatamente um
resultado. Os 6 status são **finais** — o evento sai da fila:

| Status | Significado |
|---|---|
| `contabilizado` | creditado ao anunciante |
| `duplicado` | este `execucaoId` já foi processado (retentativa) |
| `teto_atingido` | a hora já tem todas as exibições programadas confirmadas |
| `janela_desconhecida` | a janela/item não pertence a esta tela, ou o item não estava na playlist congelada daquela hora |
| `janela_expirada` | chegou mais de **7 dias** depois do fim da janela (ou a janela está no futuro) |
| `item_invalido` | evento malformado (campo ausente, vazio ou de tipo errado; `execucaoId` fora do formato; ids que não são exatamente os da playlist; item que não conta, como institucional) |

### Offline e atraso

O servidor aceita o evento **até 7 dias depois do fim da janela original**,
não pela hora de chegada: uma TV pode ficar horas ou dias sem rede e enviar
tudo depois. A validação usa só fatos do próprio servidor — a tela
autenticada, o `janelaId`, o `itemProgramacaoId`, a playlist congelada
daquela tela e hora, o teto programado e o `execucaoId`. Retentativa tardia
funciona; nada é contado duas vezes.

### Erros de lote

| HTTP | Quando | O que o Player faz |
|---|---|---|
| 400 | corpo não é objeto, `eventos` ausente/não é lista, mais de 500 | divide o lote (bisseção) e põe em quarentena o evento que continua falhando |
| 401 / 403 | §4 | mantém na fila |
| 413 | corpo > 100 KB | divide o lote |
| 5xx | falha do servidor | mantém e tenta de novo com espera crescente |

Evento inválido **nunca** derruba o lote: ele responde `item_invalido` e o
resto é processado.

---

## 9. Estados da tela no admin

Derivados no servidor (o Player reporta fatos, o servidor classifica):

| Estado | Regra |
|---|---|
| Aguardando instalação | tela sem Player provisionado (nunca instalada, ou revogada) |
| Operando | sinal nos últimos 2 min, sem erro |
| Fora do horário | o horário do ponto diz fechado, ou o Player diz `OUT_OF_SCHEDULE` |
| Sem sinal | deveria operar e o último sinal passou de 2 min |
| Erro do Player | sinal recente com `erro` ou estado de erro |

Estados administrativos (decididos pelo operador): **Ativa**, **Em reparo**,
**Inativa**.

---

## 10. Resumo do que o Player guarda localmente

- `dispositivoId` + `chaveAparelho` (armazenamento privado do app);
- última playlist válida + âncora de relógio;
- mídias em cache (por `contentHash`);
- última config (margens, operação, `pinSaida`) e a `configVersion` aplicada;
- fila durável de proof-of-play (até 7 dias).
