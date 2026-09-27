# "Aprovado" mostrado como "No ar" (o limbo)

**Sintoma.** O cliente via "No ar" (e recebia "Seu criativo foi aprovado —
Já está no ar.") logo depois da aprovação, sem nenhuma exibição ter
acontecido. Quando a peça demorava ou nunca entrava, ninguém sabia: o
sistema dizia que estava tudo certo.

**Causa raiz.** `criativosComSituacao` chamava de `no_ar` a peça que
**entra no rodízio** (conta veiculando, dentro do limite do plano). Nada no
sistema ligava o comprovante de exibição (proof-of-play) à peça.

**Correção.** Migration 099: `criativos.aprovado_em` (carimbado por
trigger em toda passagem pra aprovado), `primeira_exibicao_em` e
`ultima_exibicao_em` (só o proof-of-play confirmado escreve).
`src/anunciantes/entrada-no-ar.js` deriva Aprovado → Programado (com a
primeira janela prevista) → Aguardando primeira exibição → No ar (comprovante
depois da aprovação) ou Entrada atrasada (janela + tolerância). O admin tem
os dois indicadores na Visão geral e a lista. O aviso dentro da conta
deixou de dizer "Já está no ar". O **e-mail** "Seu anúncio está no ar"
continua com o texto antigo — e-mails estavam fora do escopo desta estação
(pendência registrada em `docs/PENDENCIAS.md`).

**Regra.** Estado de veiculação só sai de fato observado (comprovante), nunca
de intenção (aprovação, playlist gerada, download).
