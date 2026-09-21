# Amortização da aba Métrica sempre zero — status de ponto errado na query

**Sintoma.** A tabela "Margem mês a mês" da Métrica sempre mostrava
`amortizacao = R$ 0,00`, mesmo com telas de custo lançado e ponto em
operação — divergindo do KPI "Amortização" da Visão geral, que mostrava o
valor certo.

**Causa raiz.** `SQL_MARGEM` em `src/admin/metrica.js` filtrava
`p.status = 'ativo'`. Desde a migration 045, `pontos.status` só assume
`a_instalar`/`em_operacao` (ver `PONTO_STATUS` em `public/admin/index.page.js`)
— `'ativo'` nunca casava, então a subconsulta somava sempre zero linhas. A
Visão geral (`src/admin/routes.js:134`) já usava `p.status = 'em_operacao'`
corretamente; a Métrica não foi atualizada junto quando o status mudou.

**Como foi achado.** Não por auditoria: o redesenho do admin de 21/09/2026
uniu Visão geral e Métrica em duas abas da mesma tela. O número errado da
Métrica ficou visível ao lado do número certo da Visão geral, a um clique de
distância — antes, em páginas separadas, a divergência não se via junta.

**Correção.** `p.status = 'em_operacao'` em `SQL_MARGEM`.

**Guarda.** Nenhum teste automatizado cobre `src/admin/metrica.js` hoje —
zero-linhas silencioso não estoura exceção, só devolve `0`.

**Como evitar na origem.** Toda constante de status espalhada em SQL corre o
risco de sobreviver a uma migration que muda o conjunto de valores válidos.
Um teste que confere `pontos.status` contra o enum vivo (ou centralizar o
valor numa função/constante compartilhada) pegaria isso na hora da migration,
não meses depois.

**Ecossistema:** não — específico do enum de status de ponto deste projeto.
