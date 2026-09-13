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

**O que a reescrita NÃO resolveu.** Verificado na hora: o GitHub continua
servindo os commits antigos por SHA direto (`/commit/<sha>` e a API), porque
objeto órfão só some quando o GitHub roda a coleta de lixo dele. Force-push não
dispara isso. Para apagar de verdade só há dois caminhos: abrir chamado no
Suporte do GitHub pedindo a limpeza dos commits órfãos (citando os SHAs), ou
apagar e recriar o repositório com o histórico já limpo. Enquanto isso não for
feito, o `.env` antigo continua acessível a quem tiver o SHA.

**Guarda.** `git ls-files | grep -E '^\.env'` tem que voltar só
`.env.example`. Ligar Push Protection e Secret Scanning no GitHub
(Settings → Code security).

**Como evitar na origem.** O `.gitignore` entra **antes** do `git init`, e o
primeiro `git add` é sempre precedido de `git status` lido linha a linha. Este
repositório é público por decisão do dono, então a regra vale dobrado: nada
entra sem passar por essa leitura.

**Ecossistema:** sim — "confira que X está configurado" numa pendência não
substitui verificar o arquivo de configuração de verdade.
