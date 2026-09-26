#!/bin/bash
# Fluxo ponta a ponta contra o servidor local: admin → conta direta (nasce
# anunciante) → pedido de ponto pelo painel → admin libera na conta → "Meus
# pontos" → telas criadas pelo admin (o status do ponto segue as telas,
# migration 069) → PIN de saída global → código de instalação por tela →
# Player provisiona (docs/player-mvp-contract.md) → playlist → heartbeat →
# config → played → rotas do Player antigo 404 → anunciante indicado pelo
# cupom do ponto → assinar (plano inválido) → e-mail → painel sem plano.
# (Programa de vendedor aposentado em 23/09/2026: convite de vendedor não é
# mais emitido. Webhook/cobertura continuam em 02-assinatura-webhook-comissao.sh.)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
B=${B:-http://localhost:3999}
cd "$ROOT/tests/e2e/saida" 2>/dev/null || { mkdir -p "$ROOT/tests/e2e/saida"; cd "$ROOT/tests/e2e/saida"; }
J='Content-Type: application/json'
PG="psql -h localhost -U mostrai -d mostrai -tA"
export PGPASSWORD=mostrai
# Código de instalação: 8 caracteres de 23456789ABCDEFGHJKMNPQRSTUVWXYZ, "XXXX-XXXX".
COD_RE='[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}'
falhas=0
ok(){ echo "  ok  $1"; }
falha(){ echo "  FALHA $1 -> $2"; falhas=$((falhas+1)); }
esperar(){ # $1 descrição, $2 esperado (regex), $3 obtido
  if echo "$3" | grep -qE "$2"; then ok "$1"; else falha "$1" "$3"; fi; }

echo "== admin login =="
r=$(curl -s -c adm.txt -X POST $B/admin/login -H "$J" -d '{"usuario":"admin","senha":"Admin12@teste"}'); esperar "admin entra" '"ok":true' "$r"
r=$(curl -s -b adm.txt $B/admin/resumo); esperar "resumo responde com custos fixos" 'custosFixosMensal' "$r"

echo "== candidatura sem conta e cadastro aberto de ponto foram aposentados (410) =="
r=$(curl -s -X POST $B/candidaturas -H "$J" -d '{}'); esperar "candidatura sem conta fechada (410)" 'painel' "$r"
r=$(curl -s -X POST $B/seja-um-ponto -H "$J" -d '{}'); esperar "cadastro aberto de ponto fechado (410)" 'painel' "$r"

echo "== conta direta nasce anunciante; pede o modo ponto de dentro do painel =="
r=$(curl -s -c joao.txt -X POST $B/anunciantes/cadastro -H "$J" -d '{"nome_empresa":"João","cpf_cnpj":"111.444.777-35","endereco":"Rua A, 10","cidade":"Matão","uf":"SP","cep":"15990-000","contato_email":"joao@x.com","contato_telefone":"16 99463-5946","senha":"Senha12@","aceitou_termos":true}')
esperar "conta direta nasce só com anunciante" '"papeis":\["anunciante"\]' "$r"; JOAO=$(echo $r | sed 's/.*"id":\([0-9]*\),.*/\1/' | head -c 5)
r=$(curl -s -b joao.txt -X POST $B/conta/modos/vendedor/pedir -H "$J" -d '{}'); esperar "pedido de vendedor foi aposentado (400)" 'inválido' "$r"
r=$(curl -s -b joao.txt -X POST $B/conta/modos/ponto/pedir -H "$J" -d '{"nome_comercio":"Bar do João","endereco":"Rua A, 10","cidade":"Matão","uf":"SP","cep":"15990-000","segmento":"bar","fluxo_estimado_mensal":3000,"horario_semanal":{"seg":{"abre":"09:00","fecha":"18:00"},"ter":{"abre":"09:00","fecha":"18:00"},"qua":{"abre":"09:00","fecha":"18:00"},"qui":{"abre":"09:00","fecha":"18:00"},"sex":{"abre":"09:00","fecha":"18:00"},"sab":{"abre":"09:00","fecha":"15:00"},"dom":null}}')
esperar "pedido de ponto criado de dentro do painel" '"ok":true' "$r"; CAND=$(echo $r | sed 's/.*"id":\([0-9]*\).*/\1/')

echo "== admin libera o ponto direto na conta; convite de vendedor não existe mais =="
r=$(curl -s -b adm.txt $B/admin/candidaturas); esperar "admin vê o pedido com origem painel" '"origem":"painel"' "$r"
r=$(curl -s -b adm.txt -X POST $B/admin/candidaturas/$CAND/liberar); esperar "admin libera ponto direto na conta" '"papeis":\["anunciante","ponto"\]' "$r"
r=$(curl -s -b adm.txt -X POST $B/admin/convites -H "$J" -d '{"papeis":["vendedor"],"nome_sugerido":"João"}')
esperar "convite de vendedor não é mais emitido (programa aposentado)" 'ao menos um papel' "$r"
# Cupom de indicação que vale hoje: o do ponto (PT-…), mostrado em
# "Créditos e benefícios". O anunciante indicado logo abaixo usa ele.
r=$(curl -s -b joao.txt $B/anunciantes/me/creditos); esperar "dono de ponto tem cupom de indicação PT-" '"codigo":"PT-' "$r"
CUPOM=$(echo $r | sed 's/.*"codigo":"\(PT-[^"]*\)".*/\1/')
# "Meus pontos" (painel único): as rotas /anunciantes/:id/pontos e
# /anunciantes/:id/dispositivos saíram — o ponto e as telas vêm juntos daqui.
r=$(curl -s -b joao.txt $B/anunciantes/me/meus-pontos); esperar "ponto nasceu do pedido, ligado à conta" 'Bar do João' "$r"
PONTO=$(echo $r | sed 's/[^{]*{[^{]*{"tipo":"ponto","id":\([0-9]*\).*/\1/')
# Ponto nasce sem tela desde a migration 069: o admin cria a primeira. Sem
# nome manual (Player MVP): o nome da tela é o código humano dela, M-xxxx (o
# id com no mínimo 4 dígitos) — é o `dispositivoId` do contrato.
r=$(curl -s -b adm.txt -X POST $B/admin/pontos/$PONTO/dispositivos -H "$J" -d '{}'); esperar "admin cria a tela com o código M-xxxx" '"codigo":"M-[0-9]{4,}"' "$r"
DISP=$(echo $r | sed 's/^{"id":\([0-9]*\).*/\1/'); DID=$(printf 'M-%04d' "$DISP")
esperar "o nome da tela é o próprio código" "\"nome\":\"$DID\"" "$r"
esperar "tela nova aguardando instalação" '"saude":"aguardando_instalacao"' "$r"

echo "== admin: tela ativa, ponto ativo só com Player instalado =="
r=$(curl -s -b adm.txt -X PATCH $B/admin/pontos/$PONTO -H "$J" -d '{"cota_autoanuncio_slots_hora":4}'); esperar "cota do autoanúncio salva" '"cota_autoanuncio_slots_hora":4' "$r"
# A tela nasce Ativa, mas o ponto só vira "Ativo" quando um Player se instala
# numa tela dele — cadastrada não é operando.
r=$(curl -s -b joao.txt $B/anunciantes/me/meus-pontos); esperar "tela ativa sem Player: ponto aguardando instalação" '"estado":"aguardando_instalacao"' "$r"
esperar "dono vê a tela aguardando instalação" '"situacao":"aguardando_instalacao"' "$r"
r=$(curl -s -b adm.txt -X POST $B/admin/pontos/$PONTO/dispositivos -H "$J" -d '{"custo_equipamento":2400}')
DISP2=$(echo $r | sed 's/^{"id":\([0-9]*\).*/\1/'); DID2=$(printf 'M-%04d' "$DISP2")
if [ "$DISP2" -gt "$DISP" ] 2>/dev/null && echo "$r" | grep -q "\"codigo\":\"$DID2\""; then ok "segunda tela criada com o código seguinte ($DID2)"; else falha "segunda tela criada com o código seguinte" "$r"; fi
r=$(curl -s -b adm.txt -X PATCH $B/admin/dispositivos/$DISP -H "$J" -d '{"custo_equipamento":2400,"meses_amortizacao":36}'); esperar "custo por tela salvo" '"custoEquipamento":2400' "$r"

echo "== PIN de saída global: sem ele nenhuma TV se instala =="
# Começa limpo: o PIN mora em configuracoes_site, que o reset-db não zera.
$PG -c "DELETE FROM configuracoes_site WHERE chave = 'player_pin_saida'" >/dev/null
r=$(curl -s -b adm.txt $B/admin/player/pin-saida); esperar "nenhum PIN de saída definido" '"definido":false' "$r"
r=$(curl -s -w ' %{http_code}' -b adm.txt -X POST $B/admin/dispositivos/$DISP/codigo-instalacao); esperar "sem PIN o código de instalação é recusado (409)" 'PIN de saída.* 409$' "$r"
r=$(curl -s -b adm.txt -X PUT $B/admin/player/pin-saida -H "$J" -d '{"pin":"123"}'); esperar "PIN de 3 dígitos recusado" '4 a 8 dígitos' "$r"
r=$(curl -s -b adm.txt -X PUT $B/admin/player/pin-saida -H "$J" -d '{"pin":"1111"}'); esperar "PIN com dígitos iguais recusado" 'dígitos iguais' "$r"
r=$(curl -s -b adm.txt -X PUT $B/admin/player/pin-saida -H "$J" -d '{"pin":"4321"}'); esperar "PIN em sequência recusado" 'sequência' "$r"
r=$(curl -s -b adm.txt -X PUT $B/admin/player/pin-saida -H "$J" -d '{"pin":"48213"}'); esperar "PIN de saída definido" '"definido":true' "$r"
if echo "$r" | grep -q '48213'; then falha "PIN em claro ao salvar" "$r"; else ok "PIN nunca volta ao salvar"; fi
r=$(curl -s -b adm.txt $B/admin/player/pin-saida); esperar "situação do PIN: definido, sem o número" '"definido":true' "$r"
if echo "$r" | grep -q '48213'; then falha "PIN em claro na situação" "$r"; else ok "situação do PIN não traz o número"; fi
r=$(curl -s -b adm.txt -X POST $B/admin/player/pin-saida/revelar); esperar "revelar devolve o PIN" '"pin":"48213"' "$r"
sleep 0.5
r=$($PG -c "SELECT count(*) FROM eventos WHERE nome = 'player:pin_saida_revelado' AND criado_em > now() - interval '5 minutes'"); esperar "revelação do PIN fica registrada" '^[1-9]' "$r"

echo "== código de instalação por tela → Player provisiona =="
r=$(curl -s -b adm.txt -X POST $B/admin/dispositivos/$DISP/codigo-instalacao); esperar "código XXXX-XXXX vinculado à tela" "\"codigoTela\":\"$DID\",\"codigo\":\"$COD_RE\"" "$r"
COD=$(echo $r | sed 's/.*"codigo":"\([^"]*\)".*/\1/')
r=$(curl -s -b adm.txt $B/admin/dispositivos/$DISP); esperar "ficha reexibe o código enquanto vale" "\"instalacao\":\{\"estado\":\"aguardando\",[^}]*\"codigo\":\"$COD\"" "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/player/provisionar -H "$J" -d "{\"codigoTela\":\"$DID\",\"codigoInstalacao\":\"2222-2222\"}"); esperar "código errado é 401" '^401$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/player/provisionar -H "$J" -d "{\"codigoTela\":\"tela-1\",\"codigoInstalacao\":\"$COD\"}"); esperar "ID da tela em formato inválido é 400" '^400$' "$r"
# Entrada tolerante: "m0001" e o código em minúsculas valem.
r=$(curl -s -X POST $B/player/provisionar -H "$J" -d "{\"codigoTela\":\"$(echo "$DID" | tr -d '-' | tr 'M' 'm')\",\"codigoInstalacao\":\"$(echo "$COD" | tr 'A-Z' 'a-z')\"}")
esperar "provisionar devolve só dispositivoId (M-xxxx) + chaveAparelho" "^\{\"dispositivoId\":\"$DID\",\"chaveAparelho\":\"[A-Za-z0-9_-]{43}\"\}$" "$r"
CHAVE=$(echo $r | sed 's/.*"chaveAparelho":"\([^"]*\)".*/\1/')
r=$(curl -s -X POST $B/player/provisionar -H "$J" -d "{\"codigoTela\":\"$DID\",\"codigoInstalacao\":\"$COD\"}")
if echo "$r" | grep -q "\"chaveAparelho\":\"$CHAVE\""; then ok "resposta perdida: repetir o mesmo par devolve a mesma chave"; else falha "repetição curta devolve a mesma chave" "$r"; fi
r=$(curl -s -b joao.txt $B/anunciantes/me/meus-pontos); esperar "instalação é o primeiro sinal: ponto em operação" '"estado":"ativo"' "$r"
r=$(curl -s -b adm.txt $B/admin/dispositivos/$DISP); esperar "ficha: Player conectado" '"instalacao":\{"estado":"conectado"' "$r"
if echo "$r" | grep -q "$CHAVE"; then falha "chave em claro na ficha" "(chave omitida)"; else ok "chave em claro nunca volta pro admin"; fi
if echo "$r" | grep -qE 'chave_hash|cifrad'; then falha "ficha sem hash nem cópia cifrada" "$r"; else ok "ficha sem hash nem cópia cifrada"; fi
r=$(curl -s -b adm.txt -X POST $B/admin/dispositivos/$DISP2/codigo-instalacao); COD2=$(echo $r | sed 's/.*"codigo":"\([^"]*\)".*/\1/')
esperar "código da segunda tela" "\"codigoTela\":\"$DID2\"" "$r"
r=$(curl -s -X POST $B/player/provisionar -H "$J" -d "{\"codigoTela\":\"$DID2\",\"codigoInstalacao\":\"$COD2\"}"); esperar "segunda tela provisionada" "\"dispositivoId\":\"$DID2\"" "$r"
CHAVE2=$(echo $r | sed 's/.*"chaveAparelho":"\([^"]*\)".*/\1/')
r=$(curl -s -o /dev/null -w "%{http_code}" -b adm.txt -X POST $B/admin/dispositivos/$DISP/codigo-instalacao); esperar "tela com Player conectado não gera código (revogar antes) — 409" '^409$' "$r"

echo "== player: só X-Aparelho-Key autentica; playlist, heartbeat, config, played =="
r=$(curl -s -o /dev/null -w "%{http_code}" $B/playlist/$DID); esperar "playlist sem chave é 401" '^401$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" "$B/playlist/$DID?chave=$CHAVE"); esperar "chave na URL não autentica (vai pra log)" '^401$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Aparelho-Id: $CHAVE" $B/playlist/$DID); esperar "X-Aparelho-Id não autentica mais" '^401$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Aparelho-Key: $CHAVE2" $B/playlist/$DID); esperar "chave de outra tela é 401" '^401$' "$r"
r=$(curl -s -H "X-Aparelho-Key: $CHAVE" $B/playlist/$DID); esperar "playlist com a chave no header: envelope do contrato" '^\{"versaoContrato":2,"janelaId":"[0-9]+\|' "$r"
esperar "envelope traz a lista de itens" '"itens":\[' "$r"
JANELA=$(echo $r | sed 's/.*"janelaId":"\([^"]*\)".*/\1/')
r=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Aparelho-Key: $CHAVE" $B/playlist/$DISP); esperar "id numérico também identifica a tela" '^200$' "$r"
r=$(curl -s -X POST $B/player/$DID/heartbeat -H "X-Aparelho-Key: $CHAVE" -H "X-Player-Version: 1.0.0+12" -H "$J" -d '{"estado":"PLAYING","configVersionAplicada":0,"erro":null,"fila":{"pendentes":0,"maisAntigoEm":null}}')
esperar "heartbeat devolve só configVersion + playlist.atualizar" '^\{"configVersion":[0-9]+,"playlist":\{"atualizar":(true|false)\}\}$' "$r"
r=$(curl -s -X POST $B/player/$DID2/heartbeat -H "X-Aparelho-Key: $CHAVE2" -H "$J" -d '{}'); esperar "heartbeat da segunda tela (corpo {} é válido)" '"configVersion"' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/player/$DID/heartbeat -H "X-Aparelho-Key: $CHAVE" -H "$J" -d '[1]'); esperar "heartbeat com corpo que não é objeto é 400" '^400$' "$r"
r=$(curl -s -H "X-Aparelho-Key: $CHAVE" $B/player/$DID/config); esperar "config traz o PIN de saída global" '"pinSaida":"48213"' "$r"
esperar "config traz margens e o horário do ponto" '"margens":\{"superior".*"operacao":\{.*"porDiaDaSemana":\{"seg"' "$r"
r=$(curl -s -b joao.txt $B/anunciantes/me/meus-pontos); esperar "ponto segue em operação" '"estado":"ativo"' "$r"
r=$(curl -s -b adm.txt $B/admin/resumo); esperar "amortização real no resumo (2 telas x 66,67)" '"amortizacaoMensal":133' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/player/$DID/played -H "X-Aparelho-Key: $CHAVE" -H "$J" -d '{"anuncianteId":999}'); esperar "played no formato V1 ({anuncianteId}) é 400" '^400$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/player/$DID/played -H "X-Aparelho-Key: $CHAVE" -H "$J" -d '{"eventos":{}}'); esperar "played com eventos que não é lista é 400" '^400$' "$r"
EXEC="e2e-01-$(date +%s%N)"
r=$(curl -s -X POST $B/player/$DID/played -H "X-Aparelho-Key: $CHAVE" -H "$J" -d "{\"eventos\":[{\"execucaoId\":\"$EXEC\",\"janelaId\":\"$JANELA\",\"itemProgramacaoId\":\"$JANELA|0|999\"},{\"execucaoId\":\"$EXEC-b\",\"janelaId\":\"x\"}]}")
esperar "anunciante fora da playlist congelada não conta" "\"execucaoId\":\"$EXEC\",\"status\":\"janela_desconhecida\"" "$r"
esperar "evento malformado vira item_invalido sem derrubar o lote" "\"execucaoId\":\"$EXEC-b\",\"status\":\"item_invalido\"" "$r"

echo "== o que saiu do Player antigo responde 404 =="
for rota in "POST /admin/dispositivos/$DISP/preparar-player" "POST /admin/dispositivos/$DISP/chave-legada" \
  "POST /admin/dispositivos/$DISP/provisionamento" "DELETE /admin/dispositivos/$DISP/provisionamento" \
  "GET /admin/dispositivos/$DISP/eventos" "GET /admin/dispositivos/$DISP/pin" "POST /admin/dispositivos/$DISP/pin" \
  "POST /admin/dispositivos/$DISP/credencial/rotacionar" "GET /admin/player-releases"; do
  set -- $rota
  r=$(curl -s -o /dev/null -w "%{http_code}" -b adm.txt -X "$1" "$B$2" -H "$J" -d '{"pin":"4827"}'); esperar "$1 $2 é 404" '^404$' "$r"
done
r=$(curl -s -o /dev/null -w "%{http_code}" -b joao.txt -X POST $B/anunciantes/$JOAO/dispositivos/$DISP/pin -H "$J" -d '{"pin":"4827"}'); esperar "PIN por tela do dono (Meus pontos) é 404" '^404$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/player/$DID/painel -H "X-Aparelho-Key: $CHAVE" -H "$J" -d '{"pin":"48213"}'); esperar "painel por PIN do player web é 404" '^404$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/player/$DID/hello -H "X-Aparelho-Key: $CHAVE" -H "$J" -d '{}'); esperar "/player/:id/hello é 404" '^404$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" $B/player.html); esperar "player web (/player.html) é 404" '^404$' "$r"

echo "== anunciante: cadastro aberto, plano inválido =="
r=$(curl -s -c ana.txt -X POST $B/anunciantes/cadastro -H "$J" -d "{\"nome_empresa\":\"Padaria Ana\",\"cpf_cnpj\":\"11.222.333/0001-81\",\"endereco\":\"R\",\"cidade\":\"Matão\",\"uf\":\"SP\",\"cep\":\"15990-000\",\"contato_email\":\"ana@x.com\",\"contato_telefone\":\"16 99463-5946\",\"senha\":\"Senha12@\",\"aceitou_termos\":true,\"indicado_por_cupom\":\"$CUPOM\"}")
esperar "anunciante cadastro aberto, papel anunciante" '"papeis":\["anunciante"\]' "$r"; ANA=$(echo $r | sed 's/.*"id":\([0-9]*\),.*/\1/' | head -c 5)
r=$(curl -s -b ana.txt -X POST $B/anunciantes/$ANA/assinar -H "$J" -d '{"planoId":"nao-existe"}'); esperar "plano inexistente recusado" 'inválido' "$r"
r=$(curl -s -X POST $B/anunciantes/cadastro -H "$J" -d '{"nome_empresa":"X","cpf_cnpj":"390.533.447-05","endereco":"R","cidade":"Matão","uf":"SP","cep":"15990-000","contato_email":"catinvalida@x.com","contato_telefone":"16 99463-5946","senha":"Senha12@","aceitou_termos":true,"categoria_id":999999}')
esperar "categoria_id inválido no cadastro é 400, não 500" 'ramo inválido' "$r"

echo "== confirmação de e-mail por código (migration 061) =="
r=$(curl -s -b ana.txt $B/anunciantes/me); esperar "conta nova nasce sem confirmar" '"email_confirmado":false' "$r"
r=$(curl -s -b ana.txt -X POST $B/anunciantes/me/confirmar-email -H "$J" -d '{"codigo":"000000"}'); esperar "código errado recusado" 'inválido ou expirado' "$r"
CODIGO=$(PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "SELECT codigo FROM tokens_confirmacao_email WHERE anunciante_id=$ANA")
r=$(curl -s -b ana.txt -X POST $B/anunciantes/me/confirmar-email -H "$J" -d "{\"codigo\":\"$CODIGO\"}"); esperar "código certo confirma" '"ok":true' "$r"
r=$(curl -s -b ana.txt $B/anunciantes/me); esperar "conta marcada confirmada" '"email_confirmado":true' "$r"

echo "== painel sem plano: upload de criativo travado, horas do mês vazias =="
r=$(curl -s -o /dev/null -w "%{http_code}" -b ana.txt -X POST $B/anunciantes/$ANA/criativos -F "arquivo=@/dev/null;filename=x.mp4;type=video/mp4")
esperar "upload de criativo sem plano é 400" '^400$' "$r"
r=$(curl -s -b ana.txt $B/anunciantes/$ANA/exibicoes); esperar "sem plano, horas do mês vêm null" '"horasContratadasMes":null,"horasEntreguesMes":null' "$r"

echo; echo "falhas: $falhas"
[ "$falhas" -eq 0 ]
