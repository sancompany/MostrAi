# Integração definitiva com o Mostraí Player V2 — plano técnico

23/09/2026. Contraparte do backend para o Player V2 mesclado em
`sancompany/Playlist.MostrAi` `main` (`28bc93d`).

## Fonte de verdade

Precedência: código do Player (`app/src/main/java/br/com/mostrai/player/`) >
`docs/player-v2-contract.md` > `docs/player-v2-mostrai-checklist.md` > prompt do
dono (este último manda em negócio, modelo Rede/Ponto/Tela e UI).

Arquivos do Player lidos para fechar o protocolo: `network/MostraiApi.kt`,
`HeartbeatJson.kt`, `HelloJson.kt`, `PlayedJson.kt`, `PlaylistJson.kt`,
`SincronizacaoV2.kt`, `config/ConfigRemota.kt`, `HorarioOperacional.kt`,
`ConfigExterna.kt`, `update/UpdateManifesto.kt`, `Atualizador.kt`,
`proof/FilaProofOfPlay.kt`, `estado/EstadoPlayer.kt`.

## Divergências encontradas (o código do Player venceu)

| Tema | Documento | Código do Player | Adotado |
|---|---|---|---|
| Regime 24h | checklist: `24_HOURS` | `regimeDeTexto`: `HORAS_24` (valor desconhecido também vira 24h) | `HORAS_24` |
| Device Owner / capabilities / watchdog | prompt do dono pede no diagnóstico | nem hello nem heartbeat reportam | não exibido — o Player não informa |
| `versaoMinimaBuild` | config opcional | lido, sem efeito | não enviado (nada o alimenta) |
| `cache.tetoMegabytes` | reservado | sem efeito | não enviado |
| PIN | checklist: `admin_pin` | `pinPainel`, exatamente 4 dígitos, entregue em claro na config | guardado cifrado (AES-256-GCM), nunca em claro no banco |
| Heartbeat sem `update` | — | manifesto ausente limpa estado local (exceto `INSTALL_REQUESTED`) | só envia `update` quando há release aplicável |
| `/playlist` | — | caminho sem `/player` (`GET /playlist/:dispositivoId`) | mantido |

## Modelo

- **Rede** → **Ponto** (`pontos`) → **Tela** (`dispositivos`) → **Player** (identidade
  provisionada na tela). Candidatura continua separada (não vira ponto antes de aprovada).
- Tela ganha `numero` estável por ponto (contador em `pontos.telas_numeradas`, nunca
  reaproveitado) — "Tela N" é derivado; `apelido` sai da UI.
- Player: `dispositivo_uid` (o `dispositivoId` das rotas V2, `tela_<hex>`), credencial
  por hash SHA-256 (`chave_hash`), fingerprint de 6 hex, criada/último uso, candidata
  de rotação (hash + cópia cifrada até ser confirmada), anterior com expiração (24h),
  `revogado_em`. `aparelho_id` em claro é migrado para hash e zerado.
  Telas V1 continuam acessíveis pelo `id` numérico com a mesma chave.
- Provisionamento: `tokens_provisionamento` (hash, expira em 7 dias, uso único,
  consumo atômico com `UPDATE … WHERE usado_em IS NULL RETURNING`, novo token cancela
  o anterior não usado, resposta repetível por 10 min com a mesma credencial cifrada).
- Snapshot do Player em colunas da própria tela (hello + heartbeat), sem linha por
  heartbeat. Histórico só de transição em `tela_eventos`.
- Config versionada: `config_versao_desejada` sobe por gatilho no banco quando muda
  qualquer campo que vai na config (tela) ou o horário do ponto (telas que seguem o
  ponto). `config_versao_aplicada` vem do heartbeat.
- Playlist desatualizada: gatilhos de instrução nas tabelas que alimentam o gerador
  marcam `playlist_desatualizada_em`; heartbeat sinaliza `playlist.atualizar` uma vez;
  `GET /playlist` bem-sucedido limpa.
- `contentHash`: SHA-256 do MP4 normalizado que vai para o Storage (o arquivo servido),
  em `criativos.conteudo_sha256`/`conteudo_bytes`; trocar a URL sem hash zera o hash.
- OTA: `player_releases`; só ativa com assinatura conferida por um humano.

## Regras únicas (uma função cada)

- `src/lib/operacao-tela.js`: monta o bloco `operacao` da config e responde "deveria
  operar agora?" com a mesma semântica do `HorarioOperacional.kt`.
- `src/lib/status-tela.js`: saúde operacional (Operando / Fora do horário / Aguardando
  primeiro sinal / Sem sinal / Erro do player / Player revogado; Em reparo/Inativa pelo
  estado administrativo). Tolerância "sem sinal": 15 min (3 ciclos), `TELA_SEM_SINAL_MIN`.
- `src/player/credencial.js`: autenticação, rotação e revogação.

## Ordem

migration → cofre/credencial → provisionar → hello → heartbeat → saúde → config →
playlist/hash → proof → OTA → rotação → SSE admin → UI Rede/Ponto/Tela → dono →
limpeza → testes → auditorias → deploy.
