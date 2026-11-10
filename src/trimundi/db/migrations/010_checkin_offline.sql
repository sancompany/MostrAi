-- TICK — check-in offline (pedido do dono, 10/11/2026). O aparelho do
-- operador valida sem internet com o pacote da edição e guarda cada entrada;
-- ao voltar a conexão, sincroniza. Cada registro tem um id gerado no aparelho
-- (reenviar não duplica). O servidor continua sendo a regra: a entrada aceita
-- segue única por ingresso (ux_checkins_entrada); a leitura offline que chega
-- depois de outra entrada — de outro aparelho, ou online — fica gravada como
-- recusada, com o motivo, e aparece ao Admin como conflito.
--
-- Dois aparelhos desconectados não conversam: os dois podem deixar a mesma
-- pessoa entrar. Isso não se impede; se detecta na sincronização.

ALTER TABLE checkins ADD COLUMN registro_id uuid UNIQUE;
ALTER TABLE checkins ADD COLUMN modo text NOT NULL DEFAULT 'online' CHECK (modo IN ('online', 'offline'));
ALTER TABLE checkins ADD COLUMN aparelho_id text CHECK (aparelho_id ~ '^[A-Za-z0-9_-]{8,64}$');
CREATE INDEX ix_checkins_conflitos ON checkins (edicao_id, registrado_em DESC) WHERE modo = 'offline' AND resultado = 'recusado';
