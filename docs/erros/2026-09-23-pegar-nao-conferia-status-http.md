# Admin "abre com mensagem de erro, F5 resolve" — leitura de API nunca conferia `response.ok`

**Sintoma.** Relato do dono: de vez em quando o `/admin` abria mostrando uma
mensagem de erro genérica em vez do conteúdo da tela; recarregar (F5) sempre
resolvia. Intermitente, sem padrão óbvio de reprodução.

**Causa raiz.** `pegar()` em `public/admin/index.page.js` (usada em ~70
lugares pra ler qualquer endpoint `GET /admin/...`) fazia só
`(await api(caminho)).json()` — nunca conferia `response.ok`. Numa falha
transitória (cold start, blip de rede, sessão ainda não propagada logo após
o login), o backend responde com um corpo de erro tipo `{erro:'...'}`, e
`pegar` devolvia isso como se fosse o dado esperado. O primeiro código que
desmontava esse objeto — por exemplo `const {filas} = RESUMO` em
`renderResumo`, chamada logo na abertura — quebrava com `TypeError`
(`Cannot read properties of undefined`), capturado pelo catch genérico de
`renderModulo`, que é exatamente a mensagem "Não foi possível carregar esta
seção" que o dono via. F5 "resolvia" só porque recarregava do zero, e a
segunda tentativa geralmente já pegava o backend aquecido — sorte, não
conserto.

**Como foi achado.** Leitura direta do bootstrap (`api('/admin/resumo').then(...)`
sem `.catch`) e de `irPara` (`RESUMO = await pegar('/admin/resumo')` fora de
qualquer try/catch) — os dois pontos onde uma falha na primeira leitura da
tela vira exceção sem tratamento antes de `renderModulo` sequer rodar.

**Correção.** `pegar()` agora confere `response.ok`; em erro, lança
`ErroApi` tipado (status + mensagem) em vez de devolver o corpo como dado.
Falha transitória (rede fora do ar, 5xx, 429) tenta de novo uma vez com um
atraso curto; erro de autenticação/validação (401/403/404) nunca tenta de
novo. O teste de sessão na abertura e o fetch de `RESUMO` dentro de `irPara`
passam a tratar a falha explicitamente (mensagem no gate, ou o mesmo
"Não foi possível carregar esta seção. Clique em Atualizar." de sempre) em
vez de vazar como rejeição não tratada. De brinde, a abertura parou de
disparar duas leituras quase simultâneas de `/admin/resumo` (uma no teste de
sessão, outra em `irPara`) — o teste de sessão bem-sucedido agora é
reaproveitado por `mostrarApp`, e essa duplicata concorrente era ela mesma
mais uma fonte de corrida bem na janela mais frágil (login recém-feito,
sessão recém-propagada).

**Guarda.** `npm run check` cobre o resto do admin; este caminho específico
(bootstrap/leitura inicial) ainda não tem teste automatizado — verificado
manualmente (login real, `/admin/resumo` autenticado e não-autenticado,
`node --check` no arquivo).

**Como evitar na origem.** Qualquer helper de leitura de API compartilhado
por dezenas de call sites tem que conferir status antes de devolver o corpo
como dado — um helper que "sempre funciona" (nunca lança) empurra a
validação pra cada chamador, e nenhum dos ~70 chamadores fazia essa
checagem. Corrigido na raiz, no helper, não em cada chamada.

**Ecossistema:** sim — o padrão (helper de GET que nunca confere `.ok`) vale
pra qualquer front-end deste ecossistema que tenha um `pegar`/`fetchJSON`
equivalente; conferir os outros front-ends do projeto (`public/*.page.js`)
se o mesmo padrão existir lá.
