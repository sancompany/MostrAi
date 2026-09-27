# Dono do ponto barrado na própria tela (e a escolha de pontos escondida)

**Sintoma.** Em produção, a conta dona do único ponto da rede tinha plano,
criativo aprovado e o próprio ponto escolhido — e zero exibição programada.
O painel dizia "No ar". A lista de pontos nem aparecia pra ela.

**Causa raiz (três, independentes).**
1. **Trava de ramo sem exceção pro dono.** `anunciantesElegiveis`
   (`src/playlist/gerador.js`) tira da tela a conta do mesmo ramo do ponto
   (`a.categoria_id <> p.categoria_id`) — proteção contra concorrente. O
   ponto herda o ramo do dono, então a regra barrava o próprio dono.
2. **Painel escondia a escolha.** `carregarPontos` (painel.page.js) saía
   cedo com `plano_cortesia` (benefício por créditos/cortesia) e engolia
   qualquer erro da rota em silêncio; o atalho do onboarding pra escolher
   pontos nunca aparecia (a etapa é opcional e nunca vira "próximo passo").
3. **"No ar" era derivado da aprovação**, não da exibição
   (`criativosComSituacao` marcava `no_ar` por estar no rodízio) — ver
   `2026-09-27-aprovado-mostrado-como-no-ar.md`.

**Correção.** A trava de ramo isenta a dona **quando ela escolheu o
próprio ponto** (`anunciantes_pontos`); no modo automático, nada muda. A
lista de pontos aparece pra qualquer conta com plano (inclusive benefício),
com erro visível e [Tentar de novo]; o próprio ponto vem destacado e nunca
pré-marcado. Testes: `tests/distribuicao.test.js` 6–8.

**Regra.** Toda trava que protege um comércio de terceiros precisa testar o
caso "o terceiro é o próprio dono". E filtro no front não substitui estado
de erro: o que some em silêncio parece "não existe".
