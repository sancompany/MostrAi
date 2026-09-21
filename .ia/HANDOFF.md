# Current Handoff

## Updated
2026-09-21

## Current priority
Revisão manual funcional e visual conduzida pelo dono. Ele já está aproximadamente na metade. Não reiniciar auditoria: receber a próxima observação, investigar transversalmente e fazer a menor correção coerente.

## Advertiser dashboard redesigned
`public/anunciante/painel.html`, `painel.css` e `painel.page.js` agora formam um dashboard SaaS/AdTech responsivo: resumo executivo, KPIs, performance, relatório por ponto, cobertura positiva, biblioteca de criativos, pagamentos e candidatura recolhida sob CTA. Foram preservados endpoints, IDs funcionais, cálculos, filtros, comprovante, upload/exclusão, plano e candidatura. Validado com dados simulados realistas em Chromium nos viewports 1440×1000, 1280×800, 768×1024 e 390×844, sem erro de console nem overflow da página. Screenshots temporárias: `/tmp/painel-{desktop,notebook,tablet,mobile}.png` (não versionadas).

## Advertiser dashboard — segunda camada de refinamento (21/09/2026, este agente)
Depois de discussão em três pontas (dono, este agente e GPT, com pauta escrita explicitamente proibindo código até o dono autorizar) sobre o que o redesign do Codex deixou solto, o dono autorizou implementar. Mudou:
- **Marca**: as 2 ocorrências de "MostrAi" sem acento que existiam no texto do cliente (só nesta página) viraram "Mostraí", igual ao resto do produto (170 ocorrências).
- **Paleta**: o hero deixou de ser azul-marinho (`#172a46`→`#245b94`, cor que não existe em mais lugar nenhum) e virou laranja queimado escuro dentro da rampa de `--brand` (parado em `#9c4506` por contraste WCAG AA — branco sobre `--brand` puro dá só 2,3:1). Azuis escritos à mão em ícone/aviso/borda viraram tokens do design system.
- **Hero**: a faixa de 4 métricas (Plano/Horas/Exibições/Pontos), que duplicava os cards de "Resumo da campanha" logo abaixo, saiu. No lugar entrou um estado operacional — quantos pontos estão dando sinal agora e, se algum estiver fora do ar, há quanto tempo (mesmo limiar `HORAS_OFFLINE_ALERTA` que a tabela de pontos já usa).
- **Métricas**: "contratado" virou "previstas" (o número é derivado da duração do criativo, não uma promessa fixa); "Custo por exibição" (sempre R$ 0,01, ilegível) virou "Custo por 1.000 exibições" (mesma fórmula ×1000 no front, não é CPM — o Mostraí não mede audiência); média diária passou a dividir pelos dias decorridos desde o início real da campanha no mês, não pelo dia do mês (bug real: campanha nova aparecia com média artificialmente baixa); a barra de "Exibições por ponto" some com 1 ponto só (é sempre 100% por definição).
- Arquivos: `painel.css`, `painel.html`, `painel.page.js`, `src/anunciantes/routes.js` (nova query + cálculo de `mediaDiariaMes`), `docs/api.md`. Teste novo `tests/e2e/07-painel-design.mjs` (17 checagens). `npm run check` 125/125. Commit na branch `claude/busy-noether-hheir2`, ainda **não mergeado em `main` nem verificado em produção** — falta o dono revisar visualmente e autorizar o merge/deploy.
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

## Item em aberto, sem detalhe (21/09/2026)
O dono mencionou "aquela promoção... sobre trazer algumas pessoas de fora" e disse que ele mesmo resolve isso "às 9 da manhã" — **essa promoção não foi descrita em nenhum momento desta sessão**, deve ter sido discutida em outra conversa (Codex ou sessão anterior) sem registro aqui. Não inventar do que se trata. Se ele voltar e perguntar sobre isso sem reexplicar, pedir o contexto de novo em vez de supor — pode ser algo tipo cupom/crédito de indicação (já existe em `src/indicacoes/`) ou algo totalmente novo.
