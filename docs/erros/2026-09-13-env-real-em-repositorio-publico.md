# `.env` real subiu para um repositório público

**Sintoma.** No primeiro push (13/09/2026) o arquivo `.env` foi versionado e
enviado para `github.com/sancompany/MostrAi`, que é **público**. Junto foi o
`node_modules/` inteiro (4.341 arquivos). O `.env` continha a string de conexão
do Postgres do Supabase (com senha), o `SESSION_SECRET` e o usuário e a senha
do admin. As chaves do Supabase (service role) e do San Checkout estavam
vazias no arquivo.

**Causa raiz.** O `.gitignore` do projeto tinha uma única linha
(`tests/e2e/saida/`). A pendência A.1 dizia "o `.gitignore` já cobre `.env.*`"
— não cobria; a checagem manual (`git status` não pode listar `.env`) não foi
feita antes do `git add`. O repositório também foi criado público, não privado
como a pendência A.1 pedia.

**Correção.** `.gitignore` completo (`.env`, `.env.*` com exceção do
`.env.example`, `*.bak`, `*.pem`, `*.key`, `node_modules/`, dumps),
`git rm --cached` dos dois, e reescrita do histórico (`git filter-branch`)
removendo `.env` e `node_modules/` de **todos** os commits, com force-push em
`main` e na branch de trabalho. A reescrita apaga o rastro público; ela **não**
substitui a rotação, porque quem tenha clonado antes continua com os valores.
Rotação registrada em `docs/PENDENCIAS.md` (A.0), adiada por decisão do dono.

**Guarda.** `git ls-files | grep -E '^\.env'` tem que voltar só
`.env.example`. Ligar Push Protection e Secret Scanning no GitHub
(Settings → Code security).

**Como evitar na origem.** O `.gitignore` entra **antes** do `git init`, e o
primeiro `git add` é sempre precedido de `git status` lido linha a linha. Este
repositório é público por decisão do dono, então a regra vale dobrado: nada
entra sem passar por essa leitura.

**Ecossistema:** sim — "confira que X está configurado" numa pendência não
substitui verificar o arquivo de configuração de verdade.
