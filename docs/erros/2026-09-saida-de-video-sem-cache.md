# O player baixava o vídeo do storage a cada exibição

**Sintoma (previsto, não sofrido).** Uma tela rodando 12h com peças de 15s
faz ~2.800 exibições/dia. A 6 MB por peça, >15 GB/dia por tela saindo do
Supabase Storage — o plano gratuito dá 5 GB por mês, e mesmo no Pro a conta
de saída superaria a receita da rede.

**Causa raiz.** O player guardava a *playlist* (URLs) no `localStorage` e
chamava isso de cache; o arquivo em si era pedido de novo a cada `video.src`.

**Correção.** Cache de arquivo no player (Cache API): baixa uma vez por
criativo, toca do cache, rebaixa só quando a URL muda.

**Guarda.** Teste manual no stick: rede desligada depois do primeiro ciclo, a
playlist continua tocando.

**Como evitar na origem.** Antes de escolher hospedagem, calcular o custo de
saída do maior arquivo multiplicado pela frequência real de uso. Lei 7.

**Ecossistema:** sim — qualquer projeto que sirva mídia repetidamente.
