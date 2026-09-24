#!/bin/bash
# Fluxo ponta a ponta contra o servidor local: admin → conta direta (nasce
# anunciante) → pedido de ponto pelo painel → admin libera na conta → "Meus
# pontos" → telas ativadas pelo admin (o status do ponto segue as telas,
# migration 069) → chave → playlist → played → anunciante indicado pelo cupom
# do ponto → assinar (plano inválido) → e-mail → painel sem plano.
# (Programa de vendedor aposentado em 23/09/2026: convite de vendedor não é
# mais emitido. Webhook/cobertura continuam em 02-assinatura-webhook-comissao.sh.)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
B=${B:-http://localhost:3999}
cd "$ROOT/tests/e2e/saida" 2>/dev/null || { mkdir -p "$ROOT/tests/e2e/saida"; cd "$ROOT/tests/e2e/saida"; }
J='Content-Type: application/json'
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
# nome manual (Player V2): o nome é derivado, "Tela N".
r=$(curl -s -b adm.txt -X POST $B/admin/pontos/$PONTO/dispositivos -H "$J" -d '{}'); esperar "admin cria a Tela 1" '"nome":"Tela 1"' "$r"
DISP=$(echo $r | sed 's/^{"id":\([0-9]*\).*/\1/')

echo "== admin: tela ativa, ponto ativo só com primeiro sinal, chave, PIN =="
r=$(curl -s -b adm.txt -X PATCH $B/admin/pontos/$PONTO -H "$J" -d '{"cota_autoanuncio_slots_hora":4}'); esperar "cota do autoanúncio salva" '"cota_autoanuncio_slots_hora":4' "$r"
# Player V2 (24/09/2026): tela nasce Ativa, mas o ponto só vira "Ativo" com o
# primeiro sinal de uma tela — cadastrada não é operando.
r=$(curl -s -b joao.txt $B/anunciantes/me/meus-pontos); esperar "tela ativa sem sinal: ponto aguardando instalação" '"estado":"aguardando_instalacao"' "$r"
esperar "dono vê a tela aguardando a primeira conexão" '"situacao":"aguardando_primeiro_sinal"' "$r"
r=$(curl -s -b adm.txt -X POST $B/admin/pontos/$PONTO/dispositivos -H "$J" -d '{"custo_equipamento":2400}'); esperar "segunda tela criada, número estável" '"nome":"Tela 2"' "$r"
DISP2=$(echo $r | sed 's/^{"id":\([0-9]*\).*/\1/')
# [Preparar Player]: dispositivoId (5 dígitos) + chave, mostrados uma vez só.
r=$(curl -s -b adm.txt -X POST $B/admin/dispositivos/$DISP/preparar-player); esperar "Preparar Player devolve dispositivoId de 5 dígitos" '"dispositivoId":"[1-9][0-9]{4}"' "$r"
esperar "Preparar Player devolve a baseUrl" '"baseUrl":"http' "$r"
CHAVE=$(echo $r | sed 's/.*"chaveAparelho":"\([^"]*\)".*/\1/'); DID=$(echo $r | sed 's/.*"dispositivoId":"\([0-9]*\)".*/\1/')
r=$(curl -s -b adm.txt -X POST $B/admin/dispositivos/$DISP2/preparar-player); CHAVE2=$(echo $r | sed 's/.*"chaveAparelho":"\([^"]*\)".*/\1/'); DID2=$(echo $r | sed 's/.*"dispositivoId":"\([0-9]*\)".*/\1/')
r=$(curl -s -b adm.txt -X POST $B/admin/dispositivos/$DISP/chave-legada -o /dev/null -w "%{http_code}"); esperar "fluxo antigo de chave aposentado (410)" '^410$' "$r"
r=$(curl -s -b joao.txt $B/anunciantes/me/meus-pontos); esperar "Player preparado sem sinal: ponto aguardando primeiro sinal" '"estado":"aguardando_primeiro_sinal"' "$r"
r=$(curl -s -b adm.txt $B/admin/dispositivos/$DISP); esperar "admin não recebe a chave de volta" '"fingerprint":"[0-9A-F]{6}"' "$r"
if echo "$r" | grep -q "$CHAVE"; then falha "chave em claro na ficha" "$CHAVE"; else ok "chave em claro nunca volta pro admin"; fi
r=$(curl -s -b adm.txt -X POST $B/admin/dispositivos/$DISP/pin -H "$J" -d '{"pin":"12345"}'); esperar "PIN de 5 dígitos recusado (Player V2 aceita 4)" 'exatamente 4' "$r"
r=$(curl -s -b adm.txt -X POST $B/admin/dispositivos/$DISP/pin -H "$J" -d '{"pin":"1234"}'); esperar "PIN de manutenção configurado" '"pin":{"configurado":true' "$r"
if echo "$r" | grep -q '1234'; then falha "PIN em claro na ficha" ''; else ok "PIN nunca volta na ficha"; fi
r=$(curl -s -b adm.txt $B/admin/dispositivos/$DISP/pin); esperar "olho do PIN: revelação auditada devolve o PIN" '"pin":"1234"' "$r"
r=$(curl -s -b adm.txt $B/admin/dispositivos/$DISP/eventos); esperar "revelação do PIN fica no histórico" 'PIN_REVEALED' "$r"
r=$(curl -s -b adm.txt -X PATCH $B/admin/dispositivos/$DISP -H "$J" -d '{"custo_equipamento":2400,"meses_amortizacao":36}'); esperar "custo por tela salvo" '"custoEquipamento":2400' "$r"

echo "== player: sem chave 401, com chave 200, primeiro sinal =="
r=$(curl -s -o /dev/null -w "%{http_code}" $B/playlist/$DID); esperar "playlist sem chave é 401" '^401$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" "$B/playlist/$DID?chave=$CHAVE"); esperar "chave na URL não autentica (vai pra log)" '^401$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Aparelho-Key: $CHAVE" $B/playlist/$DID); esperar "playlist pelo dispositivoId com chave no header é 200" '^200$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Aparelho-Id: $CHAVE" $B/playlist/$DISP); esperar "PK numérica não autentica a tela que tem dispositivoId" '^401$' "$r"
r=$(curl -s -X POST $B/player/$DID/heartbeat -H "X-Aparelho-Id: $CHAVE"); esperar "heartbeat V1 vazio" '"ok":true' "$r"
r=$(curl -s -X POST $B/player/$DID2/heartbeat -H "X-Aparelho-Id: $CHAVE2"); esperar "heartbeat da Tela 2" '"ok":true' "$r"
r=$(curl -s -b joao.txt $B/anunciantes/me/meus-pontos); esperar "primeiro sinal põe o ponto em operação" '"estado":"ativo"' "$r"
r=$(curl -s -b adm.txt $B/admin/resumo); esperar "amortização real no resumo (2 telas x 66,67)" '"amortizacaoMensal":133' "$r"
r=$(curl -s -X POST $B/player/$DID/played -H "X-Aparelho-Id: $CHAVE" -H "$J" -d '{"anuncianteId":999}'); esperar "played de quem não está na playlist é recusado" 'não está programado' "$r"
r=$(curl -s -X POST $B/player/$DID/painel -H "X-Aparelho-Id: $CHAVE" -H "$J" -d '{"pin":"0000"}'); esperar "PIN errado 401" 'PIN incorreto' "$r"
r=$(curl -s -X POST $B/player/$DID/painel -H "X-Aparelho-Id: $CHAVE" -H "$J" -d '{"pin":"1234"}'); esperar "PIN certo abre painel da tela" 'porAnunciante' "$r"

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
