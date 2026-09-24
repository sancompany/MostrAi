# Estado da consolidação final — Mostraí

Arquivo curto de retomada. Não é diário: só o necessário para outra sessão
continuar com segurança.

## Fase atual
Checkpoint A — inventário + mapa (em andamento)

## Último commit / deploy
- MostrAi: `3f2412c` (main = branch `claude/busy-noether-hheir2` = deployed SHA no
  Northflank `mostrai/mostrai`, 2 instâncias, build main).
- Player (`sancompany/Playlist.MostrAi`): `28bc93d` (main).
- San Checkout (`sancompany/san_checkout`): `f7b1cb9` deployado em
  `san-checkout/san-checkout`, `ASAAS_AMBIENTE=sandbox` — NÃO virar para
  produção sem gate explícito do dono.
- Migrations: local e CI aplicam até `087_ciclos_contratados.sql`; produção
  confirmar na tabela `schema_migrations` (consulta em andamento).
- Baseline `npm run check` na main: 377/377, 16 avisos de lint conhecidos.

## Ambiente
- Banco: Supabase `wnbztsprmzarexnncchg` (MostrAi). Jobs Northflank:
  `conciliacao` (0 9 * * * UTC, `npm run conciliar`), `backup` (0 8 * * 0).
- Cloudflare Access: LIGADO. Apps: `mostrai.sancocore.com.br/admin`
  (`818c814f…`) e `checkout.sancocore.com.br/admin(.html)` (`24de0141…`),
  policy "Somente o operador" (e-mail do dono + domínio sancocore.com.br).
  Nenhum bypass criado ainda.

## Concluído
- Fase 0 preflight.

## Item atual
- Fase 1/2: inventário transversal + mapa de dados (workflow read-only).

## Próximos
- Checkpoint B (regras canônicas) → C (backend/banco) → D (Player) → E (admin/painel)
  → F (site) → G (Checkout) → H (legado) → I (polimento) → J (E2E online) → K (Access + smoke).

## Bloqueios reais
- Nenhum.
