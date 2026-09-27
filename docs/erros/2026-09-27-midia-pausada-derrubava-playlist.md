# Mídia Mostraí pausada no meio da hora derrubava a playlist da tela

**Sintoma (achado pelo teste 22 de `tests/distribuicao.test.js`).** Pausar
ou encerrar uma Mídia Mostraí no meio da hora fazia `GET /playlist` daquela
tela falhar (`invalid input syntax for type integer: "midia:8"`) até a hora
virar. A TV seguia com a playlist anterior (a pausa não valia) e o
programado da hora não era gravado.

**Causa raiz.** A mídia entra na `base` congelada da hora (migration 064)
como `midia:N`. Na hora de gravar a entrega comercial, o gerador só tirava
de `programados` as mídias **ainda elegíveis** (`midiasProprias`); a pausada
continuava no objeto e ia pro `INSERT` de `exibicoes_contador`, cujo
`anunciante_id` é inteiro.

**Correção.** `gerarPlaylistDaHora` remove toda chave `midia:*` da
contagem comercial, elegível ou não.

**Regra.** Tudo que sai da `base` congelada precisa ser tratado pelo TIPO do
id, não pela lista de elegíveis de agora — a base lembra de quem já saiu.
