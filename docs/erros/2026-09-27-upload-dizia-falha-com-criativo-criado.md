# Upload dizia "Não foi possível enviar" com o criativo criado

**Sintoma.** Nos uploads #2 e #3 do dono, o painel mostrou "Não foi possível
enviar agora. Tente de novo." — e o criativo estava na conta e no admin,
certinho. Tentar de novo criaria outro.

**Causa raiz.** O processamento é síncrono dentro da requisição: multer →
ffprobe → linha temporária no banco → FFmpeg → Storage → 201. Em produção o
serviço tem 0,5 vCPU (`nf-compute-50`), e o FFmpeg rodava no preset padrão
(medium) sem teto de fps. Medido nos criativos reais de produção (horário do
MP4 no `storage.objects` − `criativos.created_at`, só leitura):

| criativo | vídeo | FFmpeg + Storage |
|---|---|---|
| #6 | 14 s | 59,9 s → ok |
| #7 | 16 s | 105,7 s → **524** |
| #8 | 24 s | 131,8 s → **524** |

O proxy da Cloudflare espera a resposta da origem por 100 s; depois devolve
**524** (página HTML) ao navegador — e o servidor continua e termina. O front
só sabia ler `{erro}` em JSON: sem ele, "Não foi possível enviar". Havia
ainda o `finally` que recarregava a lista (o criativo aparecia logo abaixo da
mensagem de erro).

**Correção.**
1. **Idempotência** (migration 098): o painel gera uma chave por arquivo
   escolhido (`Idempotency-Key`); a mesma chave nunca cria dois criativos
   (índice único por conta). Repetir devolve o existente (200) ou "ainda
   processando" (202).
2. **Resultado incerto ≠ falha**: "falhou" só quando o servidor disse por quê
   (4xx com `erro`, ou o 502 do nosso armazenamento). 524/504/rede/500 sem
   corpo → o painel pergunta `GET /anunciantes/me/criativos/envios/:chave` e
   diz a verdade: enviado, ainda processando (o card atualiza pelo SSE), ou
   não concluído (nada criado — reenviar com a MESMA chave).
3. **Upload ≠ lista**: upload concluído e lista que não atualizou viram
   "Criativo enviado. Não conseguimos atualizar a lista agora."
4. **FFmpeg mais rápido, mesma saída** (medido): `-preset veryfast`,
   `-fpsmax 30`, fundo do horizontal desfocado em baixa resolução. Na própria
   produção, 6,3 s → 3,4 s por 3 s de vídeo vertical; horizontal 60 fps de
   30 s, 153 s → 36 s por núcleo.
5. **Tempos por etapa no log** (`upload de criativo {…}`), só números.

**O que continua.** Fonte pesada (4K, 60 fps, horizontal) ainda pode passar
de 100 s com 0,5 vCPU. A tela não mente mais nesse caso, e não duplica — mas
a garantia de "sempre abaixo do timeout" pede processamento fora da
requisição (fila de mídia). Decisão do dono: `docs/PENDENCIAS.md`.

**Guarda.** `tests/upload-criativo.test.js` (resposta perdida no meio do
processamento, mesma chave concorrente, falhas reais sem linha residual),
`tests/ffmpeg-normalizar.test.js` (saída H.264 Main 1080x1920 ≤ 30 fps com o
FFmpeg real) e `tests/e2e/25-sessao-e-upload.mjs` (524 depois do commit,
conexão caindo, lista falhando, sem F5).

**Como evitar na origem.** Operação cara dentro de uma requisição HTTP
atrás de proxy tem um teto que não é nosso. Medir o tempo real em produção
antes de supor que "cabe", e nunca tratar "sem resposta" como "falhou".
