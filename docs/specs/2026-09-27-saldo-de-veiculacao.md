# Saldo de Veiculação (banco de horas) — mapa, invariantes e correção

Estação crítica aberta em 27/09/2026. Nome para o cliente: **Saldo de
Veiculação**. Nome interno (tabelas, arquivos, job): `banco_horas`,
`src/bancohoras/`, `ApuracaoBancoHoras` — mantidos de propósito (renomear
tabela e job em produção é risco sem ganho).

Autoridade usada no mapa: código executável → migrations → testes → docs.

## A. Como funcionava antes desta estação (código de `1ae164c`)

```
PLANO (planos.segundos_por_hora, pontos_incluidos, frequencia_hora)
  ↓  src/playlist/gerador.js#anunciantesElegiveis — vigência (data_expiracao),
  ↓  não suspensa, não excluída, criativo aprovado com arquivo, trava de ramo
OBRIGAÇÃO — não existia como número. O que existia era o PEDIDO da hora:
  ↓  frequenciaBase = floor(segundosCompensados / duração)   (RN-39, RN-49)
PONTOS  src/lib/pacing.js#pontosDoAnunciante (escolha ou sorteio estável,
  ↓  só pontos `em_operacao`)
CAPACIDADE  src/lib/pacing.js#segundosCompensados — base × plano/cobertos,
  ↓  teto 600 s/h por tela; tudo numa camada só com a base de todo mundo
PLAYLIST  src/lib/pacing.js#montarHoraDeTv — 3600 s por hora:
  ↓  1) base + compensação + déficit da hora anterior (corte proporcional,
  ↓     RN-30), Mídia Mostraí e cota do dono na mesma camada;
  ↓  2) banco antigo só no tempo que sobrou; 3) institucional
  ↓  congelada por (tela, hora): playlist_hora_congelada (migration 064)
PROGRAMADA  gerador.js#gravarProgramados → exibicoes_contador
  ↓  (vezes_programadas, vezes_pedidas, vezes_banco) — SEMPRE, mesmo com o
  ↓  ponto fechado (a TV pede playlist a noite toda)
REPRODUÇÃO  Player: toca só no horário do ponto; offline repete a última
  ↓  playlist (docs/player-mvp-contract.md §7)
POP  POST /player/:id/played → execucoes-repository.js#confirmarComDedup
  ↓  (execucao_id único) → gerador.js#confirmarExecucao → +1 em
  ↓  vezes_confirmadas com teto nas programadas; prazo 7 dias
CONTADOR  exibicoes_contador (anunciante, tela, hora)
  ↓  déficit da hora anterior = programadas − banco − confirmadas, só da
  ↓  hora imediatamente anterior, na mesma tela (RN-10)
APURAÇÃO  src/bancohoras/apuracao.js#apurarMes (job ApuracaoBancoHoras,
  ↓  cron 0 6 1 * *): Σ pedidas − Σ (programadas − banco) do mês — o que
  ↓  NÃO COUBE; confirmadas não entravam; ON CONFLICT DO NOTHING
SALDO  banco_horas (uma linha por conta × mês), unidade EXIBIÇÃO
  ↓
COMPENSAÇÃO  gerador programa `vezes_banco` no tempo ocioso; liquidação
     (apuracao.js#liquidarBancoConfirmado, diária no Conciliacao e mensal)
     abate o banco CONFIRMADO, uma vez por hora (banco_liquidado_em), FIFO
```

Tabelas: `exibicoes_contador` (003, 057, 090), `banco_horas` (058),
`banco_horas_execucoes` (090), `playlist_hora_congelada` (064),
`execucoes_confirmadas` (081), `midias_exibicoes_contador` (099).

Horário: `src/lib/operacao-tela.js` (`operacaoDoPonto`, `deveriaOperar`,
`minutosOperando`) — faixas por dia, madrugada que cruza a meia-noite pertence
ao dia em que começou, feriado nacional substitui o dia, fuso
America/Sao_Paulo, sem horário = 24 h. Competência: mês de Matão
(`janelaDoMes`). Estado em produção em 27/09/2026 (leitura): 0 linhas em
`banco_horas`, 0 execuções do job, 0 linhas em `exibicoes_contador`, 1 ponto
com 1 tela.

### Defeitos encontrados

| # | Defeito | Efeito |
|---|---|---|
| D1 | Programada comercial gravada em hora FECHADA; o não confirmado rola hora a hora a madrugada inteira e estoura na abertura, onde é cortado | déficit falso vira saldo (ponto fechado ≠ falha de entrega) |
| D2 | Compensação RN-49 e déficit da hora anterior disputam a mesma camada que a base dos outros | saturada, a hora corta a base de B pra pagar A |
| D3 | O que passa do teto da RN-49 (600 s/h) some | contrato não entregável nunca vira saldo |
| D4 | Saldo em EXIBIÇÕES convertido pela duração ATUAL da peça | trocar a peça reescreve o passado em tempo |
| D5 | Apuração por programadas, não por confirmadas | o que foi programado e não tocou só existe enquanto rola; perde-se na virada de hora fechada, de mês, e com a TV sem pedir playlist |
| D6 | Tela que não pede playlist (sem sinal) não gera linha nenhuma | hora aberta sem sinal não gera obrigação — dívida silenciosa |
| D7 | Apuração no dia 1 com ON CONFLICT DO NOTHING | comprovante offline que chega até 7 dias depois nunca entra |

## B. Invariantes

1. **Ponto fechado não gera dívida.** Hora com 0 minuto aberto não grava
   linha comercial: sem obrigação, sem programada, sem banco reservado, e o
   déficit não rola pra dentro dela.
2. **Obrigação é tempo.** Obrigação da hora na tela =
   inserções inteiras de `base × plano/cobertos` (RN-49 sem teto, RN-39) ×
   minutos abertos/60 ÷ telas ativas do ponto, em segundos da peça daquela
   hora.
3. **Camadas da hora.** T1 base de todos (+ Mídia Mostraí + cota do dono,
   como já era) → T2 compensação RN-49 e reposição da hora anterior → T3
   saldo antigo → T4 institucional. Camada de baixo só usa o que sobrou da
   de cima: compensação, reposição ou saldo de A nunca reduzem a base de B.
4. **Só POP entrega.** Entregue = `LEAST(confirmadas, programadas − banco) ×
   duração da hora`. Pedido, programado, servido, baixado ou `playing` não
   reduz nada.
5. **Uma execução, um crédito.** `execucao_id` único + teto confirmadas ≤
   programadas (existentes, reaproveitados).
6. **Saldo nasce do não entregue.** Saldo do mês = obrigação − entregue, em
   segundos, se positivo. Redistribuição (RN-49 na camada T2) e reposição
   rodam antes: só o que não coube e não tocou vira saldo.
7. **Fechamento idempotente.** Apurar de novo a mesma competência dá o mesmo
   saldo; dentro do prazo do POP (7 dias + 1 h) ele se recompõe com os
   comprovantes que chegaram; depois disso congela; nunca fica abaixo do já
   compensado.
8. **Compensação só confirmada, uma vez.** Saldo antigo só é abatido por
   banco confirmado, uma vez por hora (`banco_liquidado_em`), em segundos da
   duração daquela hora.
9. **Histórico não muda.** Cada linha guarda a duração usada; trocar a peça
   muda só as exibições equivalentes do saldo que ainda falta.
10. **Tela sem sinal em hora aberta deve.** Hora aberta sem pedido de
    playlist ganha a obrigação minutos depois de fechar, com o plano e a
    cobertura daquela hora (gravada uma vez; mudar o plano depois não a
    reescreve), só para conta já servida naquela tela e, na hora da
    instalação, só a partir do instante instalada. A rede de segurança
    (conciliação diária e apuração mensal), que usa o estado de HOJE, só
    entra nas horas em que **nenhuma** tela da rede pediu playlist
    (servidor fora do ar) — hora em que a rede funcionava já foi tratada
    pelo job de 10 min com o estado daquela hora; sem isso, tela em reparo
    reativada e plano vencido renovado ganhavam obrigação retroativa
    *(finalização, 28/09/2026)*.
11. **Sem plano, sem obrigação.** Conta própria, suspensa, excluída, sem
    plano, plano vencido, ponto fora da cobertura ou não `em_operacao`: nada.
12. **Mídia Mostraí isolada.** Nunca entra em `exibicoes_contador` nem em
    `banco_horas`.
13. **Reposição não cruza competência.** O déficit da última hora do mês
    fica no mês (vira saldo dele), não rola pro seguinte.
