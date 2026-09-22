# Current Handoff

## Updated
2026-09-22

## Merge com a reforma de categorias (outra sessão, 22/09/2026, este agente)
`main` avançou (PR #5, "reforma da taxonomia de categorias") enquanto esta
sessão trabalhava a Rede — ambas tocaram `src/pontos/repository.js` e
`public/admin/index.page.js` na mesma área (ficha do ponto). Merge
resolvido: minha migration virou 068 (colisão de número com a deles, que já
era 067). Na ficha do ponto, a busca de categoria editável que eles
adicionaram (`categoriaBuscaHtml`/`ligarCategoriaBusca`, com limpeza de
`categoria_livre` ao escolher) **não entrou** — a ficha é somente-leitura
desde o redesenho desta sessão (pedido explícito do dono: só status/molde
ACM ficam editáveis, categoria não estava na lista). O componente de busca
continua ativo e usado normalmente no cadastro, nas outras telas públicas e
no detalhe de Anunciantes — só não em Pontos.
**Dívida real, registrada, não resolvida**: com isso, não existe mais UI
pra corrigir `categoria_id`/`categoria_livre` de um ponto já criado (antes
existia, meio errado, no formulário de cadastro manual removido). Na
prática `liberarPapelNaConta` já propaga a categoria da CONTA pro ponto no
nascimento (fix deles), então o caso só importa se a conta mudar de ramo
DEPOIS do ponto já existir — raro, e sem UI hoje pra corrigir se acontecer
(precisaria de PATCH direto ou uma tela nova, decisão do dono se quiser).
`npm run check` 161/161 depois do merge (153 desta sessão + 8 deles),
`tests/e2e/01-fluxo-api.sh` e `09-rede-redesenho.mjs` reconfirmados verdes.

## Redesenho completo da tela Rede do admin (22/09/2026, este agente)
Pedido do dono, autorização direta pra implementar a rodada inteira ("pode
implementar... não precisa perguntar de novo, só se achar decisão de
negócio nova"). Objetivo: Rede virar centro operacional — grade de cards →
ficha do ponto (somente-leitura) → Telas (única parte editável). Detalhe
técnico completo e as decisões tomadas em `docs/PENDENCIAS.md` seção K;
as duas decisões que valiam ADR foram pra `.ia/DECISIONS.md` (ADR-007
status visual derivado, ADR-008 divergência da regra 80/20).

**Em uma linha cada:**
- `public/admin/index.page.js`: grade de cards nova (`montarPontoCard`,
  `caixaCards` reaproveitado), placeholder de foto oficial
  (`fotoOuPlaceholder`, SVG de pin), status visual derivado
  (`statusVisualPonto`), ficha do ponto somente-leitura
  (`renderPontoInformacoes`) + painel de Instalação
  (`renderPontoInstalacao`, único trecho realmente editável fora de Telas),
  Ocupação virou painel agregado na Visão geral (`renderOcupacaoRede`).
- Removido da UI: bloco de foto-de-exemplo do site público, botão "+Novo
  ponto" (cadastro manual). O endpoint `POST /admin/pontos` foi removido
  de vez (backend) — confirmado sem consumidor real antes (nem teste, nem
  `docs/api.md`); `POST /admin/pontos/foto-exemplo` ficou no backend sem
  gatilho na UI (config ainda é lida pelo site público, só perdeu o jeito
  de trocar pela tela — dívida registrada, seção K).
- Migration 067: `candidaturas.foto_fachada_url` + `pontos.observacoes`,
  fechando os 2 furos do pipeline candidatura→ponto (o resto — endereço,
  segmento, responsável, movimento, horário — já fluía). Upload de foto em
  2 passos, autenticado (`POST /conta/modos/ponto/candidaturas/:id/foto`).
- **Achado real corrigido no caminho**: `segmento` no header da ficha só
  olhava `categoria_nome`/`categoria_livre` — mas `liberarPapelNaConta`
  nunca escreve essas duas colunas, só o `segmento` texto puro. Sem o
  fallback, praticamente todo ponto nascido da candidatura mostrava "Sem
  segmento informado". Corrigido (mesma prioridade do card:
  `categoria_nome || categoria_livre || segmento`).

**Verificado:** `npm run check` 153/153 (5 testes novos,
`tests/redesenho-rede.test.js`); `tests/e2e/01-fluxo-api.sh` e
`08-candidatura-ponto.mjs` sem regressão; `tests/e2e/09-rede-redesenho.mjs`
novo (39 checagens, screenshots desktop+mobile em `tests/e2e/saida/v25-*`).
`03-navegador.mjs` quebra num seletor de tabela de telas que já não existe
desde a reorganização de Rede por entidade de 21/09 — confirmado
pré-existente, não desta mudança.

**Trabalhando na branch `claude/wonderful-hypatia-i7y4xx`, sem merge em
`main`.**

## Current priority
Revisão manual funcional e visual conduzida pelo dono. Ele já está aproximadamente na metade. Não reiniciar auditoria: receber a próxima observação, investigar transversalmente e fazer a menor correção coerente.

## Auditoria pós-atualização do app Android (22/09/2026, este agente)
Pedido do dono: o player nativo (`sancompany/playlist.mostrai`) lançou uma
atualização, ele pediu pra ler o repositório e conferir o que falta no
backend do Mostraí pra suportar. Comparado campo a campo, rota a rota,
status a status contra o código atual do app — detalhe completo em
`docs/PENDENCIAS.md`, seção H (adenda de 22/09/2026).

**Resultado principal: o contrato novo já está pronto** (foi construído
numa sessão anterior, seção H original) — rotas, cabeçalho, envelope, lote
de `/played`, os 6 status de dedup, as duas garantias de imutabilidade que
o app depende. Nada disso precisou de código novo.

**O que faltava de verdade, corrigido nesta sessão:** não existia controle
nenhum na aba Telas do admin pra ligar `contrato_playlist=2` — só dava pra
fazer com um `PATCH` cru (curl/Postman). Adicionado um select "Contrato"
na tabela de Telas (`public/admin/index.page.js`, mesmo padrão do select de
Status já existente), sem migration nem rota nova. Verificado por
Playwright: cria ponto → aba Telas → troca o select → persiste no banco.

**Achados que NÃO são bugs, registrados pra quando o dono decidir:**
- PIN do app (sempre 4 dígitos, local) e PIN do site admin (4-6 dígitos,
  hoje só usado pelo player web) são dois sistemas desconectados — já
  listado como questão aberta no próprio repo do app.
- `margemVmin` por tela/por lado — já era backlog intencional ("não
  construir agora"), confirmado que continua sem campo no backend, como
  esperado.

**Verificado:** `npm run check` (156/156), Playwright manual do select novo.

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`.**

## Reforma da taxonomia de categorias concorrenciais (22/09/2026, este agente)
Pedido do dono, spec completa de 13 itens em uma mensagem, autorização direta
("pode implementar"). Regra imutável reafirmada: categoria existe só pra
impedir dois CONCORRENTES DIRETOS na mesma tela — `categoria_id` igual
bloqueia, grupo nunca bloqueia. Detalhe técnico completo (mapa das 22
categorias antigas → novas, o que ficou fora de propósito, checklist de
verificação) em `docs/PENDENCIAS.md`, seção K; regra formalizada pela
primeira vez em `docs/funcional.md` RN-57.

**O que mudou, em uma linha cada:**
- Migration 067 (aditiva): `categorias` ganha `grupo`, `aliases[]`, `legado`;
  `pontos` ganha `categoria_livre` (paridade com `anunciantes`). As 25
  categorias amplas antigas viram `legado=true` (Barbearia/Odontologia/
  Imobiliária foram upgradadas no lugar, mesmo `id`); ~229 categorias novas
  e específicas entram em 20 grupos. Nada foi apagado nem reatribuído sem
  aviso — correspondência proposta, não aplicada, é decisão do dono.
- `GET /categorias` só devolve ativas e não-legadas (com grupo+aliases);
  contas antigas continuam válidas e continuam bloqueando concorrência
  (legado nunca é excluído do que já está em uso, só do catálogo de opção).
- Todo select de categoria virou busca (nome+alias, sem acento/maiúscula,
  até 40 resultados) sobre um `<select>` escondido — `public/formulario.js`
  (compartilhado pelas 3 telas públicas) e uma cópia equivalente no bundle
  do admin (`public/admin/index.page.js`), mesma convenção do horário
  semanal. "Não encontrei minha categoria" cai em `categoria_livre` (texto
  livre, nunca bloqueia — reaproveita o padrão que `anunciantes` já tinha
  desde a migration 015, só faltava em `pontos`).
- Admin de Categorias: tabela ganhou colunas Grupo/Aliases, chip "Legado",
  filtro por grupo — sem virar tela gigante (busca já existente reaproveitada).
- **Dois furos reais, pré-existentes, corrigidos**: `criarPontoDaCandidatura`
  (`src/anunciantes/routes.js`) e `liberarPapelNaConta` (`src/conta/modos.js`)
  — os dois caminhos reais de nascimento de ponto — nunca copiavam
  `categoria_id`/`categoria_livre` da conta pro ponto novo, então o ponto
  nascia sem proteção de concorrente nenhuma. `POST /anunciantes/cadastro`
  ganhou validação de `categoria_id` (era 500, agora 400 pra id inválido).
- **Bug de infra encontrado no caminho**: `turbinarTabela` (helper de busca
  de tabela do admin) filtrava por `tr.textContent`, que não vê valor de
  `<input>`/`<select>` — a busca da tela de Categorias (e qualquer tabela
  toda feita de campos editáveis) não funcionava pra nada. Corrigido na
  raiz, no helper compartilhado.

**Deliberadamente fora desta rodada** (pedido explícito do dono): scoring,
recomendação automática, targeting, IA, múltiplas categorias por negócio,
hierarquia complexa de bloqueio. Ação pendente do dono: revisar a tabela de
correspondência em `docs/PENDENCIAS.md` seção K e decidir se alguma das 22
categorias legadas deve virar `ativo=false` de vez (hoje só saíram do
catálogo de opção — continuam bloqueando quem já as usa).

**Verificado:** `tests/categorias-concorrencia.test.js` (8 testes novos,
mesma-categoria bloqueia / categoria-diferente não bloqueia / categoria
nula não bloqueia / categoria_livre nunca bloqueia / legado ainda bloqueia
quem já usa / catálogo público exclui inativa e legado / `liberarPapelNaConta`
propaga categoria), `tests/e2e/01-fluxo-api.sh` estendido (categoria_id
inválido → 400), Playwright manual dos três widgets (busca por nome
completo, parcial, sem acento, por alias, "não encontrei", categoria já
legada ainda aparecendo pra quem já usa), `npm run check`.

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`.**

## Horário de funcionamento do ponto, construído (22/09/2026, este agente)
Pedido do dono, funcionalidade que ele lembrava de ter esquecido: cada ponto
precisa dizer seu horário de funcionamento (seg-sex / sáb / dom), e isso
precisa aparecer pro anunciante ao escolher onde o anúncio roda. Investigação
confirmou: `pontos.horario_abertura`/`horario_fechamento` (migration 001)
existiam no banco desde o início e nunca foram ligados a formulário nenhum —
exatamente a lacuna que o dono lembrava. Detalhe técnico completo em
`docs/PENDENCIAS.md`, seção J.

**O que mudou, em uma linha cada:**
- Migration 066: `pontos.horario_semanal` e `candidaturas.horario_semanal`
  (jsonb, um valor por dia da semana), colunas antigas mantidas paradas.
- `src/lib/horario-semanal.js` — `validar()` e `resumo()`, únicos, usados
  nos três lugares que escrevem ou leem o campo.
- `POST /conta/modos/ponto/pedir` (as duas telas públicas de candidatura)
  passou a EXIGIR o horário — único momento em que quem sabe o horário do
  comércio está preenchendo o formulário.
- Widget de 3 grupos (seg-sex/sáb/dom, domingo fechado por padrão)
  duplicado em `public/modos.js`, `public/anunciante/painel.page.js` e
  `public/admin/index.page.js` — sem bundler, é a convenção do projeto.
- Admin (`POST /admin/pontos`, cadastro manual) deixa o campo opcional por
  um checkbox desmarcado — não silenciosamente 09:00-18:00 como se fosse
  real (placeholder virando dado falso).
- `GET /anunciantes/me/pontos-disponiveis` ganhou `horario` (resumo
  textual); o anunciante vê no `title` (tooltip) do nome do ponto, sem
  alargar a lista compacta (`.ponto-escolha`, redesenhada 19/09/2026).
- Achado e corrigido no caminho: o card estreito de "Novo ponto" no admin
  (~420px) espremia os campos de hora até sobrar só o ícone, porque
  reusava o layout de 3 colunas aninhadas do formulário público (640px) —
  virou 2 linhas só na versão do admin.

**Verificado:** `tests/horario-semanal.test.js` (8 testes novos), `npm run
check` (141/141), os e2e que passam pela rota
(`01-fluxo-api.sh`/`02-...comissao.sh`/`04-modos-e-bonus.sh`/
`03-navegador.mjs`/`08-candidatura-ponto.mjs`) e verificação visual manual
por Playwright dos três widgets.

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`.**

## Varredura visual do admin — botões sem CSS e avisos mal coloridos (21/09/2026, este agente)
Pedido do dono: mapear a funcionalidade do admin e corrigir botão mal estilizado, aviso inútil e função em aberto. Login via Playwright em todos os 12 módulos/22 telas (incluindo detalhe de ponto e de anunciante). Achados reais, corrigidos — detalhe técnico em `docs/PENDENCIAS.md`, seção I:
- Crash de verdade ao abrir Conteúdo → Aprovação pelo menu (`renderCriativos` recebia `resto=null` do roteador genérico, não `undefined`, e o parâmetro default nunca entrava).
- 4 `<input type="file">` nativos (cinza, fora do desenho) viraram o padrão já usado em "Subir anúncio": label estilizada escondendo o input de verdade.
- 2 checkboxes virando "barra cinza" cobrindo a linha inteira (Convites "papéis da conta" e Pontos "Molde de ACM") — mesmo bug do `.card input{width:100%}` que `.check-row` já resolvia noutro lugar, agora generalizado.
- Checkboxes de tabela azuis (cor do navegador) em Custos/Categorias/Comodato/Benefícios — regra geral `input[type=checkbox]{accent-color:var(--brand)}` no admin, resolve para sempre.
- Aviso "conciliação nunca rodou" estava verde (`.tudo-em-dia`) e o caso realmente grave (atrasada/abortou) saía SEM cor nenhuma (classe errada, `alertas` plural em vez de `alerta`). Trocados por laranja/vermelho, condizente com a gravidade.
- De brinde: a violação de CSP inline-style em Diagnóstico (já sabida, "não tocada") sumiu ao trocar `style="padding:14px"` por uma classe utilitária que já existia.

Nenhuma função foi removida — a varredura não achou nada sem uso real; o inventário de `docs/specs/2026-09-21-admin-inventario-funcoes.md` continua batendo. `npm run check` 133/133, zero erro de console em todas as 22 telas (desktop + mobile 390×844). Dados de teste acumulados no banco (24 eventos pendentes, um "Contador" duplicado em Custos) não foram apagados — é limpeza de banco, que o dono já disse que vai fazer à parte.

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`.**

## Contrato novo de playlist/played pro app Android nativo (21/09/2026, este agente)
Pedido direto do dono: "leia o repositório do aplicativo e faça o que tiver
que fazer do seu lado" — referência ao app irmão `sancompany/playlist.mostrai`
(Android TV nativo, sideload), cuja estação 5 já estava pronta esperando o
Mostraí publicar o contrato que ele já sabe consumir (envelope com
`versaoContrato`/`janelaId`/`itemProgramacaoId`/`criativoId`, `POST /played`
em lote deduplicado por `execucaoId`). Contrato completo em `docs/api.md`,
"Tela (chave de aparelho)"; resumo técnico em `docs/PENDENCIAS.md` seção H.

**O que mudou, em uma linha cada:**
- `dispositivos.contrato_playlist` (migration 065, padrão `1`) decide POR
  TELA se `/playlist` devolve o array de sempre ou o envelope novo — o app
  não manda cabeçalho de versão, então virou config por dispositivo.
- `itemProgramacaoId` embute índice (posição na hora congelada) + quem
  creditar, pra `/played` não precisar reconstruir a hora.
- `execucoes_confirmadas` (ledger novo) + `execucoes-repository.js` credita
  e deduplica na MESMA transação — sem essa atomicidade, um crash no meio
  perderia o crédito de uma exibição real pra sempre.
- Bug achado e corrigido no caminho: `dispositivosRepo.deletar` não limpava
  `playlist_hora_congelada` (existe desde a migration 064) — apagar tela que
  já gerou playlist falhava com FK, sempre, desde 19/09. Corrigido.

**Deliberadamente intocado:** `public/player.page.js` (player web, contrato
1, não mudou nem uma linha) e o repositório `sancompany/playlist.mostrai`
(o pedido foi só do lado do Mostraí — "do seu lado"). Nenhuma tela em
produção foi migrada pra `contrato_playlist=2`; isso só faz sentido depois
do dono confirmar o app rodando em hardware real (pendência do OUTRO
repositório) e então marcar a tela específica no admin.

**Verificado:** `npm run check` (133/133, 5 testes novos em
`tests/playlist-contrato-novo.test.js`), e fumaça manual pela API HTTP real
(servidor local + Postgres local: tela de teste em contrato 2 recebendo o
envelope, `/played` em lote com item malformado devolvendo `item_invalido`,
tela legada em paralelo sem mudar nada, exclusão da tela de teste pelo
admin funcionando).

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`.**

## Admin: Rede e Anunciantes reorganizados por entidade (21/09/2026, este agente)
Pedido do dono, spec fechada de 20 itens com screenshots do admin em produção:
o PONTO virou a entidade central de Rede (era 3 telas/abas separadas — Pontos,
Telas, Ocupação — cada uma com sua própria tabela) e a tabela de Anunciantes
foi simplificada (lista enxuta + detalhe por conta, ações saíram da linha).
Só reorganização administrativa/UX — **nenhuma relação de backend, rota, regra
de negócio ou autorização foi tocada**; cada função de render nova chama as
mesmas rotas de sempre.

**Rede:** `renderPontos` virou um dispatcher — grade de cards (`.ponto-card`,
foto grande quando existe, placeholder quando não) sem `pontoId` no hash, ou
`renderPontoDetalhe` com 3 sub-abas (Resumo/Telas/Ocupação) quando tem.
`renderOcupacaoPontos` (tela solta) foi deletada — virou a sub-aba Ocupação,
sempre filtrada a um ponto. Entrega/banco de horas **saiu do menu Rede**
(não existe mais como página administrativa independente) — a lógica de
backend (`src/bancohoras/`) não foi tocada, só a superfície de admin; a regra
"nunca crédito automático em dinheiro" que estava só no texto da tela deletada
já vive independentemente em `src/bancohoras/repository.js:115`.
Roteador do admin (`public/admin/index.page.js`, `resolverAlvo`/`irPara`/
`renderModulo`) ganhou um 3º segmento de hash (`resto`) pra isso — mecanismo
genérico, disponível pra qualquer módulo agora, não só Rede/Anunciantes.
Hashes antigos preservados via `ALIASES_ANTIGOS`: `#telas`→`rede/pontos`,
`#ocupacaopontos`→`rede/pontos`, `#bancohoras`→`rede/pontos` (a rota antiga
de Entrega não tem mais tela própria pra apontar; cai na grade de Pontos).

**Anunciantes:** lista caiu pra 7 colunas (nome/contato/ramo/plano/status/
entrada + badges de papel), sem os botões de ação nem o aviso laranja de
divergência de ciclo (que **continua existindo em Planos**, não foi apagado,
só duplicado — a chamada em Anunciantes foi removida, a de Planos ficou
intacta). Clicar na linha abre `renderAnuncianteDetalhe`: resumo completo +
os mesmos 4 botões de ação de sempre (Subir anúncio/Liberar plano/Marcar
parceiro/Cancelar assinatura), mesmas condições de disponibilidade, mesmas
rotas — só mudou de lugar na tela.

**Documento (CPF/CNPJ) normalizado na gravação, dali pra frente:**
`src/anunciantes/repository.js` (`criar`/`atualizar`) agora passa `cpf_cnpj`
por `limpar()` (`src/br/documento.js` — sem pontuação, maiúsculo, preserva
letra porque CNPJ é alfanumérico desde jul/2024) antes de gravar. Corrigido
na raiz (repository, não nas rotas) — cobre cadastro público, cadastro do
admin e convite de uma vez. **Contas já gravadas antes de hoje não foram
tocadas, nenhuma foi apagada, nenhum merge automático foi feito** — só o
comportamento novo, dali pra frente. Não há constraint `UNIQUE` em
`cpf_cnpj` hoje (confirmado antes de mexer — só `contato_email` é único), e
nenhuma foi criada agora: seria destrutivo sem antes tratar as duplicidades
existentes. Query pronta pra achar duplicidade por documento normalizado está
em `docs/PENDENCIAS.md`, seção G — **rodada contra o banco local não achou
nenhuma (é dado de sandbox); produção ainda não foi checada, fica registrado
como pendência, não resolvido aqui**.

**IDEIA FUTURA, explicitamente NÃO implementada agora** (só registrada, a
pedido do dono): reservar ~20% da capacidade de cada ponto pra conteúdo
institucional/estratégico (hoje é 100% comercial). Fica pra quando o dono
pedir — não mexer em playlist/pacing pra isso sem novo pedido.

**Verificado:** `npm test` (novo `tests/anunciantes-normalizacao-documento.test.js`,
3 casos: pontuação removida, letra de CNPJ alfanumérico preservada, edição
também normaliza), Playwright em desktop e mobile (grade com/sem foto, telas
0/1/muitas, as 3 sub-abas, lista e detalhe de Anunciantes, hashes antigos
redirecionando certo), `npm run lint`/`sintaxe`/`formato`.

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`.**

## Troca de plano com acerto agora redireciona pro Checkout aprovar (21/09/2026, este agente)
O San Checkout mudou de contrato NO MESMO DIA (`sancompany/san_checkout` commit
`9c21be1`, "Trocar de plano redireciona o pagador ao Checkout para aprovar o
acerto") — o dono testou o caminho de 17-18/09 (cobrava direto no cartão
salvo, sem o pagador ver nada) e reverteu: quando há diferença a pagar,
`POST /trocar-plano` agora responde `202` com `approvalUrl`, e só cobra depois
que o pagador aprova numa tela do próprio Checkout. Sem diferença
(rebaixamento/absorção < R$5), continua `200` na hora, sem redirect, igual
sempre foi.

**O que mudou no Mostraí**, pra acompanhar:
- `src/financeiro/routes.js` (`POST /anunciantes/me/trocar-plano`): novo
  ramo pro `202` — não aplica nada, só repassa `approvalUrl`/`expiresAt`/`amount`
  pro front. A linha `pendente_troca` fica como está.
- `src/financeiro/san-checkout.js` (`processarWebhookAssinatura`, evento
  `plano_trocado`): deixou de ser no-op. Agora só é no-op quando a
  assinatura já está `ativa` (caso síncrono, sem acerto); quando ainda está
  `pendente_troca`, este webhook é quem aplica a troca de verdade (marca
  trocada/ativa, atualiza `anunciantes.plano_id`, grava
  `cobrancas_confirmadas` se houve cobrança, manda o e-mail) — é o ÚNICO
  sinal de que a troca aconteceu no caso assíncrono.
- `public/anunciante/confirmar-plano.page.js` (`montarConfirmacaoTroca`):
  no `202`, redireciona `window.location.href = approvalUrl` (mesmo padrão
  que `assinar()` já usa pra assinatura nova).
- Docs atualizados: `docs/api.md`, `docs/funcional.md` (RN-52),
  `docs/PENDENCIAS.md` (seção G.9, com o limite conhecido: link nunca
  aprovado deixa uma linha `pendente_troca` órfã, inofensiva, sem
  varredura própria — fora de escopo desta entrega).

**Verificado:** `npm run check` (127/127 testes) contra Postgres local
real — dois testes novos usam linhas reais em `anunciantes`/`assinaturas`
(não um cliente de pool simulado: `pool.query` da dedupe do webhook e
`pool.connect` da transação da troca coexistem na mesma função, e simular
só `connect` trava o `query` por dentro do `pg-pool` — achado construindo
o primeiro teste, documentado no próprio arquivo). Não testado no
navegador contra um Checkout de verdade respondendo 202 (sandbox não tem
acesso de rede pro Checkout real) — só revisão do diff + testes de
unidade do lado do Mostraí.

**Pendência que este item resolveu, mas não a que motivou a pergunta
original:** a pendência 11 (antiga) do `PENDENCIAS.md`, sobre configurar o
San Checkout pra aceitar pedido avulso, segue corretamente marcada como
caída — o pedido avulso continua aposentado como caminho de troca de
plano, o `202` novo não trouxe ele de volta.

## Painel admin reorganizado: 25 telas → 12 módulos (21/09/2026, este agente)
Pedido do dono: reestruturar o admin inteiro (rascunho dele via GPT + pesquisa
de mercado + mapeamento do código real, tudo registrado em
`docs/specs/2026-09-21-redesenho-admin.md` e
`docs/specs/2026-09-21-admin-inventario-funcoes.md`), depois autorização direta
pra construir sem mais discussão item a item ("julgo olhando a tela").

**O que mudou, só isso:** navegação e agrupamento visual. `public/admin/index.page.js`
ganhou `MODULOS` (12 itens em 5 grupos: Mostraí/Operação/Comercial/Financeiro/Sistema)
no lugar do antigo `NAV` (25 itens em 5 grupos), um roteador novo (`irPara`,
`resolverAlvo`, `renderModulo`) e uma fileira de abas por módulo quando ele
agrupa mais de uma tela antiga. **Nenhuma função `render*()` foi reescrita** —
cada aba nova chama exatamente a função de antes, então toda edição inline,
toda regra de negócio e toda rota consumida continuam idênticas. Nova tela
`renderPendencias` (módulo "Pendências") reaproveita a mesma lista `ALERTAS`
e `RESUMO.filas` da Visão geral — nenhum dado novo.

**Compatibilidade:** os 25 hashes antigos (`#pontos`, `#criativos` etc.)
continuam abrindo a tela certa via `ALIASES_ANTIGOS` — nenhum `href="#x"` ou
`irPara('x')` espalhado pelas ~210 funções internas precisou mudar.
Verificado com Playwright: os 25 hashes antigos + os 12 módulos novos + todas
as sub-abas navegam certo, zero erro novo de console (só um CSP de estilo
inline pré-existente em `renderEventos`, não tocado).

**Bug achado e corrigido no caminho** (não estava no escopo, mas a própria
reorganização o expôs): `src/admin/metrica.js` comparava `p.status = 'ativo'`
num status que não existe desde a migration 045 — a amortização da aba
Performance (fundida com a Visão geral em abas) sempre dava zero, divergindo
do número certo da aba ao lado. Corrigido pra `p.status = 'em_operacao'`
(mesmo padrão já usado em `src/admin/routes.js`). `docs/erros/2026-09-21-metrica-amortizacao-status-errado.md`.

**Verificado, não só lido:** `npm run check` (125/125 testes) e toda a
bateria de `tests/e2e/` (01, 02, 03, 05, 06, 07, 08) contra Postgres local de
verdade + Chromium real. Dois ajustes nos próprios scripts de teste — `03-navegador.mjs`
e `05-navegador-modos.mjs` clicavam em `.nav-item[data-aba="x"]` (estrutura
antiga); passaram a navegar pelo hash antigo direto (`location.hash = 'x'`),
o que também serviu de teste real da promessa de compatibilidade.

**Dois achados pré-existentes, confirmados NÃO relacionados a esta mudança**
(já sabidos, não corrigidos, fora de escopo): `#navVendas` (03-navegador.mjs)
e `#navMeuPonto` (05-navegador-modos.mjs) — seletores do painel do
**anunciante**, removidos numa reestruturação de nav anterior (item 77 do
histórico desta sessão), scripts nunca atualizados depois. `tests/e2e/06-painel-bloqueio-plano.mjs`
também falha num rótulo renomeado ("Horas entregues no mês") no mesmo painel
— idem, já sabido, confirmado de novo agora.

**Deliberadamente fora desta rodada** (era o pedido original via GPT, mas o
dono cortou escopo — "tá muita coisa"): mover a edição densa de Pontos/Telas/Anunciantes/Comodato
pra página de detalhe com drawer; desduplicar o aviso de divergência de
ciclos e o texto "produto é do tier" (aparecem 3x: Planos, Anunciantes,
Comodato); o CSP inline-style pré-existente em Eventos/Diagnóstico. Tudo
com risco/decisão mapeado em `docs/specs/2026-09-21-redesenho-admin.md`,
seções 5 e 7, se um dia isso for retomado.

**Trabalhando na branch `claude/busy-noether-hheir2`, sem merge em `main`**
até o dono revisar visualmente — mesma regra que o rascunho do GPT já trazia.

## Advertiser dashboard redesigned
`public/anunciante/painel.html`, `painel.css` e `painel.page.js` agora formam um dashboard SaaS/AdTech responsivo: resumo executivo, KPIs, performance, relatório por ponto, cobertura positiva, biblioteca de criativos, pagamentos e candidatura recolhida sob CTA. Foram preservados endpoints, IDs funcionais, cálculos, filtros, comprovante, upload/exclusão, plano e candidatura. Validado com dados simulados realistas em Chromium nos viewports 1440×1000, 1280×800, 768×1024 e 390×844, sem erro de console nem overflow da página. Screenshots temporárias: `/tmp/painel-{desktop,notebook,tablet,mobile}.png` (não versionadas).

## Card "Faça parte da rede" — movimento obrigatório + segmento resolvido (21/09/2026, este agente)
Pedido direto do dono, depois da rodada de design acima: no card de candidatura a ponto do fim do painel (`montarCardPonto`, `painel.page.js`), "Movimento médio mensal" virou obrigatório (era opcional) — required no HTML e checado de novo no backend (`POST /conta/modos/:papel/pedir`, `src/conta/modos.js`), defesa em profundidade pra quem chamar a rota direto. Layout trocou o `field-row` de duas colunas (desalinhava rótulo/campo por causa do textarea vizinho) por dois campos empilhados. Rótulo alinhado com o mesmo campo em `public/modos.js` ("Média de pessoas que passam por mês"). Achado no caminho: `segmento` só olhava `categoria_livre` — conta que respondeu o ramo pelo catálogo fixo (`categoria_id`) mandava segmento vazio e caía em "outro" no admin sem motivo. Backend agora resolve os dois casos (`categoria_livre` direto, ou busca o nome por `categoria_id`); o front não manda mais esse campo. Teste `tests/e2e/08-candidatura-ponto.mjs` (9 checagens, os dois casos de segmento). Mergeado em `main` e verificado em produção.

**Achado fora de escopo, não corrigido:** `tests/e2e/03-navegador.mjs` quebra num seletor `#navVendas` que não existe desde a remoção da aba Vendas do topo (sessão anterior) — pré-existente, script nunca foi atualizado depois daquela mudança. As outras 17 checagens do script passam.

## Advertiser dashboard — segunda camada de refinamento (21/09/2026, este agente)
Depois de discussão em três pontas (dono, este agente e GPT, com pauta escrita explicitamente proibindo código até o dono autorizar) sobre o que o redesign do Codex deixou solto, o dono autorizou implementar. Mudou:
- **Marca**: as 2 ocorrências de "MostrAi" sem acento que existiam no texto do cliente (só nesta página) viraram "Mostraí", igual ao resto do produto (170 ocorrências).
- **Paleta**: o hero deixou de ser azul-marinho (`#172a46`→`#245b94`, cor que não existe em mais lugar nenhum) e virou laranja queimado escuro dentro da rampa de `--brand` (parado em `#9c4506` por contraste WCAG AA — branco sobre `--brand` puro dá só 2,3:1). Azuis escritos à mão em ícone/aviso/borda viraram tokens do design system.
- **Hero**: a faixa de 4 métricas (Plano/Horas/Exibições/Pontos), que duplicava os cards de "Resumo da campanha" logo abaixo, saiu. No lugar entrou um estado operacional — quantos pontos estão dando sinal agora e, se algum estiver fora do ar, há quanto tempo (mesmo limiar `HORAS_OFFLINE_ALERTA` que a tabela de pontos já usa).
- **Métricas**: "contratado" virou "previstas" (o número é derivado da duração do criativo, não uma promessa fixa); "Custo por exibição" (sempre R$ 0,01, ilegível) virou "Custo por 1.000 exibições" (mesma fórmula ×1000 no front, não é CPM — o Mostraí não mede audiência); média diária passou a dividir pelos dias decorridos desde o início real da campanha no mês, não pelo dia do mês (bug real: campanha nova aparecia com média artificialmente baixa); a barra de "Exibições por ponto" some com 1 ponto só (é sempre 100% por definição).
- Arquivos: `painel.css`, `painel.html`, `painel.page.js`, `src/anunciantes/routes.js` (nova query + cálculo de `mediaDiariaMes`), `docs/api.md`. Teste novo `tests/e2e/07-painel-design.mjs` (17 checagens). `npm run check` 125/125. Mergeado em `main` (fast-forward, sem conflito) e **verificado em produção** (`mostrai.sancocore.com.br`, `/health` 200, CSS/HTML/JS com a versão nova em múltiplas requisições — não numa só, porque a primeira bateu num nó de borda da Cloudflare ainda com cache antigo).
- **O que ficou pra depois, ainda em discussão com o GPT**: retomada de índice do app Android TV não é isso — não confundir; aqui os itens em aberto da PRÓPRIA discussão do painel foram: "1 de 7 escolhidos" (semântica conferida — são contagens diferentes, badge ganhou "· P em operação", mas não houve pedido pra ir além disso); card de "criativos" com métrica por peça (bloqueado — `exibicoes_contador` não tem `criativo_id`, só existe depois que o app de TV mandar o contrato de proof-of-play).

## Functional map
Inventário de site público, conta, anunciante, ponto, vendedor, player, Checkout, 25 seções admin e jobs em `docs/mapa-funcional-completo-2026-09-20.md`.

## Public review synchronized
Termos de Uso agora refletem o produto atual: conta nasce anunciante e vendedor só por convite; cobertura/vigência começam no pagamento sem espera por ponto; cancelamento é feito no painel; tempo é reservado por hora e a projeção mensal usa referência de 12h/dia.

## Infrastructure incident already resolved
Em 20/09/2026 a produção caiu porque a senha do Postgres foi trocada no Supabase sem atualizar `DATABASE_URL` no serviço e nos jobs Northflank. Foi corrigida nos três lugares; site, admin, `Conciliacao` e `Backup` foram confirmados. Detalhe: `docs/erros/2026-09-20-senha-do-postgres-divergente-entre-supabase-e-northflank.md`. Também foi confirmado que `ApuracaoBancoHoras` não existe no Northflank.

## Confirmed finding not fixed
`src/admin/metrica.js` usa o status antigo `p.status = 'ativo'` na amortização histórica. Pontos atuais usam `em_operacao`; a aba Métrica zera amortização e pode inflar margem. Visão geral está correta. Tratar quando o dono chegar nessa tela ou autorizar.

## Paused until explicit request
Player/proof-of-play, banco de horas/déficit físico e troca proporcional. A ideia de banco de horas nos dois sentidos está em `docs/proximas-versoes.md`. Manter tudo registrado e não trabalhar espontaneamente. A concorrência da playlist saiu desta lista porque o dono autorizou e ela foi corrigida nesta sessão.

## Existing temporary diagnostic
`?debug=1` no player permanece disponível, mas não retomar teste/correção sem pedido.

## Playlist concurrency fixed
Após o dono confirmar que `&debug=1` funcionou na TV e autorizar retomar o caminho da playlist, as duas corridas do congelamento foram corrigidas. `src/playlist/congelamento-repository.js` agora serializa base e extras com advisory lock transacional por `(dispositivo, hora)`; `gerador.js` sempre monta a resposta a partir da base efetivamente vencedora. As regras da ADR-005 permanecem: base não muda, novos participantes entram no fim, repetições da frequência são legítimas. Testes em `tests/playlist-congelamento.test.js`. Não houve mudança em `/played`, métricas ou banco de horas.

## Do not undo
- Não recolocar cache em memória na playlist.
- Não restaurar Vendas/Meu ponto no topo.
- Não mudar custo por exibição para dividir pelo confirmado.
- Não editar migration aplicada nem versionar segredo.

## Next action
Aguardar a próxima tela/observação do dono. Classificar como bug, inconsistência, melhoria visual, decisão, legado ou não confirmado; checar impactos laterais antes de alterar.

## Plano do dono para os próximos dias (21/09/2026)
Ordem que ele deu: (1) terminar a revisão do painel admin e do painel do anunciante — o redesign do Codex "melhorou muito" mas não bateu 100%, **principalmente a parte visual**; ele pediu explicitamente pra ESTE agente (Claude) corrigir isso, não o Codex — em especial **voltar as cores pra paleta própria do Mostraí** (laranja `#ff7a1a`, ver `theme-color` nos HTMLs e `public/style.css`) onde o redesign tiver se afastado dela; (2) terminar o app Android TV da playlist (`docs/proximas-versoes.md`, "App Android TV nativo..."); (3) **trocar o San Checkout de sandbox pra produção** — não investigado ainda se é config do lado do Mostraí (`SAN_CHECKOUT_*` já parecem apontar pra domínio de produção, `sancocore.com.br` — conferir antes de assumir) ou decisão só do lado de quem administra o Checkout; (4) finalizar os testes. Estimativa dele: ~2 dias de trabalho até poder vender; depois disso "só vai sobrar ir atrás do anunciante" (prospecção, fora do escopo de código).

## Item em aberto, agora especificado mas DEFERIDO — não implementar sem novo pedido (21/09/2026)
A "promoção de trazer gente de fora" mencionada antes (e que ficava sem detalhe) foi explicada pelo dono: dá um **crédito pro comodato**, e **quanto mais crédito, mais o plano do ponto sobe de nível**. Ele foi explícito: "**fica pendente também**" — não construir agora. Antes de começar quando ele pedir, checar contra o que já existe (pode ser extensão do `src/indicacoes/` — que já libera upgrade de plano por indicação em 3 limiares — ou algo separado ligado ao comodato/`credito_comodato_mensal`); não assumir qual dos dois sem perguntar, o mecanismo exato (o que conta como "trazer gente de fora", quanto vale cada crédito, a curva de nível) não foi dado.

## Revisão visual/funcional das telas — três ainda faltam (21/09/2026)
Depois do painel do anunciante fechado nesta sessão, o dono listou o que falta revisar: **1) painel admin, 2) painel do ponto/comodato, 3) painel do vendedor**. Sem pedido de começar ainda — só registrado pra não perder a ordem.

**Item já pautado pra quando a revisão do admin começar:** conta própria virar preenchimento elástico do vazio da hora (não frequência fixa) e configuração por criativo (alcance + frequência/"plano" por peça, não por conta) — ver `docs/proximas-versoes.md`, "Conta própria vira preenchimento elástico do vazio, configurada por criativo". Nasceu de uma investigação desta sessão sobre por que o cartão institucional aparece tanto — não era bug, era o desenho atual (RN-40) mesmo, e o dono decidiu mudar. **Correção (21/09/2026, mesma sessão):** este handoff chegou a afirmar que a aba "Meus anúncios" do admin estava quebrada por listar só `pendente`. **Era falso alarme** — só o *default* da rota é `pendente` (`src/admin/routes.js:16`); a aba pede `?status=todos` (`public/admin/index.page.js:718`) e o repositório trata isso (`src/anunciantes/criativos-repository.js:52-56`). O bug real existiu e foi corrigido em `7b4d173` (15/09/2026). Não "consertar" de novo o que já está certo — se a aba estiver vazia, checar se a conta própria existe e se tem criativo enviado.

## margemVmin — reafirmado que precisa ser por lado (4 valores), não só por tela (21/09/2026)
O dono apontou de novo: `margemVmin` tem que vir do admin (por tela), e como
**4 valores independentes** (um por lado — topo/base/esquerda/direita), não
um número só igual nos 4 lados. A ideia já estava registrada em
`docs/proximas-versoes.md` ("Margem e orientação por tela configuráveis no
admin, não só na URL") pensando no player web; esta sessão atualizou essa
entrada pra também cobrir o app Android nativo (que reproduz o mesmo
problema: `ConfigAparelho.margemVmin`/`ConfigExterna.Dados.margemVmin` são
um `Float` único aplicado igual nos 4 lados por
`PlayerActivity.aplicarMargemOverscan()`). Espelhado em
`sancompany/playlist.mostrai` (`docs/pendencias.md` e
`docs/proximas-versoes.md`), reconciliando com um registro concorrente que
outra sessão já tinha feito lá (faltava a nuance dos 4 lados). **Nada
implementado** — só registro, como pedido.

## playlist.mostrai — entrega de provisionamento revisada, nada a mudar aqui (21/09/2026)
A outra sessão entregou `ConfigExterna` (lê `mostrai-config.json` de um pendrive/volume externo montado, mesmos 5 campos do provisionamento por `adb`/build embutido). Conferido: é 100% client-side, nenhuma chamada nova ao backend, nenhum campo que o `sancompany/mostrai` precise passar a aceitar. Build + 53 testes verdes localmente (SDK Android montado em `/opt/android-sdk` nesta sessão pra verificar de verdade, não só ler). PR #1 (`playlist.mostrai`) segue em draft, aguardando o dono testar em hardware real.
