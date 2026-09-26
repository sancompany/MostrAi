-- (084 continua reservada pro Player V2 — ver o cabeçalho da 085.)
--
-- Código de instalação humano (docs/player-mvp-contract.md §3, reestruturação
-- do Player MVP, 26/09/2026). `tokens_provisionamento` deixa de guardar o
-- token técnico longo (`tok_…`, 7 dias) e passa a guardar o CÓDIGO de 8
-- caracteres que o operador digita na TV — mesma tabela, mesmas garantias
-- (uso único, expiração, cancelamento, consumo atômico, repetição curta).
--
-- `token_hash` continua sendo a coluna de busca, agora com HMAC-SHA256 de
-- chave do servidor (src/lib/cofre.js#assinar) sobre (tela, código): o
-- código tem ~40 bits e um SHA-256 simples dele seria quebrado offline.
--
-- ADITIVA: só colunas novas, com padrão.
ALTER TABLE tokens_provisionamento
  -- Tentativas erradas contra o código pendente DESTA tela. Na 5ª o código
  -- é cancelado (o admin gera outro) — o limite por origem (IP) continua
  -- como segunda camada.
  ADD COLUMN IF NOT EXISTS tentativas_erradas smallint NOT NULL DEFAULT 0,
  -- Cópia CIFRADA (AES-256-GCM, src/lib/cofre.js) do código, só para o
  -- admin reexibi-lo com a contagem regressiva depois de recarregar a
  -- página. Apagada ao usar, cancelar ou expirar; nunca em claro.
  ADD COLUMN IF NOT EXISTS codigo_cifrado text;
