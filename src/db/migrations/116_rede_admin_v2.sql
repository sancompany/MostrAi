-- REDE / ADMIN V2 (06/10/2026, pedido do dono). Continuação do #118 — a
-- arquitetura da rede móvel (115) não muda. Duas coisas pequenas de banco:
--
-- 1. ORIGEM do ponto, auditável. O Admin passa a poder criar um ponto FIXO
--    direto da ficha de uma conta (sem candidatura falsa) — o comerciante
--    que quer ser ponto e não tem tempo de preencher o pedido. Até aqui a
--    única pista era `candidatura_id`; agora a origem é explícita:
--      'candidatura' — candidatura aprovada (src/pontos/materializar.js)
--      'admin'       — criado pelo Admin na ficha da conta
--      'movel'       — rede móvel (só nasce pelo Admin, migration 115)
--    `criado_por` guarda o usuário do Admin (só na origem 'admin').
--    Ponto antigo sem candidatura fica NULL (origem desconhecida — não se
--    inventa história).
ALTER TABLE pontos ADD COLUMN origem text
  CHECK (origem IS NULL OR origem IN ('candidatura', 'admin', 'movel'));
ALTER TABLE pontos ADD COLUMN criado_por text CHECK (criado_por IS NULL OR length(criado_por) <= 120);
UPDATE pontos SET origem = 'candidatura' WHERE candidatura_id IS NOT NULL AND origem IS NULL;
UPDATE pontos SET origem = 'movel' WHERE tipo = 'movel' AND origem IS NULL;

-- 2. NOME da rede móvel separado da cidade. A 115 compôs o nome sozinha
--    ("Mostraí Móvel — Matão"); agora nome e cidade/UF são campos
--    independentes, escolhidos pelo Admin, e o card mostra "Mostraí Móvel"
--    + "Matão/SP". Desfaz SÓ o nome que a 115 compôs (o padrão exato com a
--    cidade da própria rede) — nome escolhido à mão não é tocado. IDs,
--    telas, credenciais, Player e POP não mudam. Produção quando esta foi
--    escrita: uma rede (id 9, "Mostraí Móvel — Matão", Matão/SP).
UPDATE pontos SET nome = 'Mostraí Móvel'
 WHERE tipo = 'movel' AND nome = 'Mostraí Móvel — ' || cidade;
