# Rotas do player eram públicas: qualquer um inflava exibições cobradas

**Sintoma.** `POST /player/:pontoId/played` e `/heartbeat` e
`GET /playlist/:pontoId` não exigiam nada. Um `curl` em loop aumentava
`vezes_confirmadas` de qualquer anunciante — o número vendido a ele — e
mantinha uma tela morta marcada como online, desligando o alerta de offline.

**Causa raiz.** A coluna `aparelho_id` existia desde a primeira migration e
nunca foi usada; a TV era identificada só pelo id numérico na URL.

**Correção.** Chave de aparelho por tela, gerada no admin, enviada no header
`X-Aparelho-Id`; middleware `exigirAparelho` nas três rotas. O player guarda
a chave no `localStorage` e mostra na tela de debug com qual API fala.

**Guarda.** Teste do middleware pendente (ver `CLAUDE.md`).

**Como evitar na origem.** Todo endpoint chamado por máquina tem credencial
de máquina desde o primeiro dia — chave por dispositivo, revogável.

**Ecossistema:** não — específico de projeto com dispositivo em campo.
