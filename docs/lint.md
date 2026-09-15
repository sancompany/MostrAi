# Por que o lint está configurado assim

O Biome entrou em 14/09/2026. Três decisões precisam de motivo escrito, senão
a próxima pessoa (ou eu daqui a três meses) desfaz sem saber o que perdeu.

## `useTemplate` desligada
Trocar `'a' + b` por template em 17 lugares é gosto, não defeito. O ganho é
zero e o custo é embaralhar o `git blame` de arquivo que ninguém está tocando.

## `useArrowFunction` desligada
Mesmo motivo: `function () {}` onde não muda o `this` continua correto.

## `useIterableCallbackReturn` desligada **só em `public/`**
São 47 ocorrências, todas do mesmo formato:

    el.querySelectorAll('[data-x]').forEach((b) => b.addEventListener(...))

A regra existe porque devolver valor de um `forEach` costuma significar que a
pessoa queria `map`. Aqui nunca significa: o que "sobra" é o retorno de
`addEventListener`, `classList.toggle` ou `appendChild`, que ninguém usa.

Pôr chaves nas 47 resolveria o aviso e deixaria o arquivo pior — nos casos
multilinha o fecho vira `}); });`. Então ela fica **ligada em `src/`**, onde
`map` confundido com `forEach` é erro plausível sobre lista de dados, e
desligada em `public/`, que é fiação de DOM.

Se um dia aparecer em `public/` um `forEach` que devia ser `map`, esta regra
não vai pegar. É o preço, e é conhecido.

## Formatador: aplicado em 15/09/2026

Os três passos abaixo foram executados, nesta ordem:

1. `npm run formato:corrigir` num commit sozinho (`00e4305`), sem nenhuma
   mudança de comportamento junto — 65 dos 78 arquivos reescritos;
2. o hash entrou em `.git-blame-ignore-revs`. Pra o `git blame` respeitar isso
   sem passar a flag toda vez, rode uma vez por clone:
   `git config blame.ignoreRevsFile .git-blame-ignore-revs`;
3. `npm run formato` entrou no `npm run check`, que é o que o CI roda — daqui
   pra frente formatação fora do padrão **barra**.

A bateria inteira rodou depois de aplicar: 42/42 unitários, lint limpo,
sintaxe de todos os arquivos e as cinco suítes ponta a ponta sem falha.

O registro do porquê do adiamento fica abaixo, porque a razão continua válida
pra próxima vez que aparecer um commit mecânico grande.

## (histórico) Formatador: configurado, ainda não aplicado
`npm run formato` confere e `npm run formato:corrigir` aplica. Medido em
14/09: ele reescreveria **63 dos 76 arquivos**.

Não passei. O motivo é de sequência, não de gosto: seria um commit tocando
quase tudo, a um passo de a primeira versão ir ao ar, e cada linha tocada
precisaria da bateria ponta a ponta inteira pra valer alguma coisa. Risco real
por ganho cosmético, na pior hora.

Fica como passo próprio, e ele tem uma ordem certa:

1. `npm run formato:corrigir` num commit sozinho, sem nenhuma mudança de
   comportamento junto;
2. o hash desse commit entra em `.git-blame-ignore-revs`, pra o `git blame`
   continuar apontando quem escreveu de verdade;
3. só então `npm run formato` entra no `check`, e o CI passa a barrar
   formatação fora do padrão.

Enquanto isso o formatador não barra nada. **O lint barra**: `npm run check`
roda `biome lint` e o CI roda o mesmo comando.
