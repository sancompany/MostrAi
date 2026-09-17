#!/bin/bash
# Fluxo ponta a ponta contra o servidor local: admin → candidatura → convite →
# cadastro por convite (ponto+vendedor) → tela → chave → playlist → played →
# anunciante → assinar (plano inválido) → webhook → cobertura → comissão
# (webhook/cobertura/comissão continuam em 02-assinatura-webhook-comissao.sh).
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

echo "== candidatura pública de ponto =="
r=$(curl -s -X POST $B/candidaturas -H "$J" -d '{"tipo":"ponto","nome":"João","nome_comercio":"Bar do João","contato_telefone":"16999990000","endereco":"Rua A, 10","cidade":"Matão","uf":"SP","cep":"15990-000","segmento":"bar","fluxo_estimado_mensal":3000}')
esperar "candidatura criada" '"ok":true' "$r"; CAND=$(echo $r | sed 's/.*"id":\([0-9]*\).*/\1/')
r=$(curl -s -X POST $B/seja-um-ponto -H "$J" -d '{}'); esperar "cadastro aberto de ponto fechado (410)" 'convite' "$r"

echo "== convite gerado pelo admin a partir da candidatura =="
r=$(curl -s -b adm.txt -X POST $B/admin/convites -H "$J" -d "{\"papeis\":[\"ponto\",\"vendedor\"],\"candidatura_id\":$CAND,\"nome_sugerido\":\"João\"}")
esperar "convite criado com link" 'convite.html\?t=' "$r"; TOK=$(echo $r | sed 's/.*"token":"\([^"]*\)".*/\1/')
r=$(curl -s $B/convites/$TOK); esperar "convite público diz os papéis" '"papeis":\["ponto","vendedor"\]' "$r"
r=$(curl -s -b adm.txt $B/admin/candidaturas); esperar "candidatura virou aprovada" '"status":"aprovada"' "$r"

echo "== cadastro por convite (sem endereço comercial, com pix) =="
r=$(curl -s -c joao.txt -X POST $B/anunciantes/cadastro -H "$J" -d "{\"convite\":\"$TOK\",\"nome_empresa\":\"João\",\"cpf_cnpj\":\"111.444.777-35\",\"contato_email\":\"joao@x.com\",\"contato_telefone\":\"16 99463-5946\",\"senha\":\"Senha12@\",\"aceitou_termos\":true,\"chave_pix\":\"joao@pix\"}")
esperar "conta criada com papéis do convite" '"papeis":\["ponto","vendedor"\]' "$r"; JOAO=$(echo $r | sed 's/.*"id":\([0-9]*\),.*/\1/' | head -c 5)
r=$(curl -s -X POST $B/anunciantes/cadastro -H "$J" -d "{\"convite\":\"$TOK\",\"nome_empresa\":\"X\",\"cpf_cnpj\":\"111.444.777-35\",\"contato_email\":\"outro@x.com\",\"contato_telefone\":\"16 99463-5946\",\"senha\":\"Senha12@\",\"aceitou_termos\":true}")
esperar "convite é de uso único" 'usado|inválido' "$r"
r=$(curl -s -b joao.txt $B/anunciantes/me); esperar "me traz perfil de vendedor com cupom" '"codigo_cupom":"' "$r"
CUPOM=$(echo $r | sed 's/.*"codigo_cupom":"\([^"]*\)".*/\1/')
r=$(curl -s -b joao.txt $B/anunciantes/$JOAO/pontos); esperar "ponto nasceu da candidatura, ligado à conta" 'Bar do João' "$r"
PONTO=$(echo $r | sed 's/.*"id":\([0-9]*\).*/\1/' | head -c 5)
r=$(curl -s -b joao.txt $B/anunciantes/$JOAO/dispositivos); esperar "ponto já tem a Tela 1" 'Tela 1' "$r"
DISP=$(echo $r | sed 's/.*"id":\([0-9]*\).*/\1/' | head -c 5)
r=$(curl -s -b joao.txt $B/vendedor/painel); esperar "painel do vendedor pela conta única" 'totalAReceber' "$r"

echo "== admin: tela ativa, ponto ativo, chave, PIN =="
r=$(curl -s -b adm.txt -X PATCH $B/admin/pontos/$PONTO -H "$J" -d '{"status":"em_operacao","cota_autoanuncio_slots_hora":4}'); esperar "ponto em operacao" '"status":"em_operacao"' "$r"
r=$(curl -s -b adm.txt -X POST $B/admin/pontos/$PONTO/dispositivos -H "$J" -d '{"apelido":"Tela 2","custo_equipamento":2400}'); esperar "segunda tela criada" 'Tela 2' "$r"
DISP2=$(echo $r | sed 's/.*"id":\([0-9]*\).*/\1/' | head -c 5)
r=$(curl -s -b adm.txt -X POST $B/admin/dispositivos/$DISP/chave); esperar "chave gerada" 'aparelho_id' "$r"; CHAVE=$(echo $r | sed 's/.*"aparelho_id":"\([^"]*\)".*/\1/')
r=$(curl -s -b adm.txt -X POST $B/admin/dispositivos/$DISP/pin -H "$J" -d '{"pin":"1234"}'); esperar "PIN definido (com hash)" '"tem_pin":true' "$r"
r=$(curl -s -b adm.txt -X PATCH $B/admin/dispositivos/$DISP -H "$J" -d '{"custo_equipamento":2400,"meses_amortizacao":36}'); esperar "custo por tela salvo" '"custo_equipamento":"2400"' "$r"
r=$(curl -s -b adm.txt $B/admin/resumo); esperar "amortização real no resumo (2 telas x 66,67)" '"amortizacaoMensal":133' "$r"

echo "== player: sem chave 401, com chave 200 =="
r=$(curl -s -o /dev/null -w "%{http_code}" $B/playlist/$DISP); esperar "playlist sem chave é 401" '^401$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" "$B/playlist/$DISP?chave=$CHAVE"); esperar "playlist com chave é 200" '^200$' "$r"
r=$(curl -s -X POST $B/player/$DISP/heartbeat -H "X-Aparelho-Id: $CHAVE"); esperar "heartbeat" '"ok":true' "$r"
r=$(curl -s -X POST $B/player/$DISP/played -H "X-Aparelho-Id: $CHAVE" -H "$J" -d '{"anuncianteId":999}'); esperar "played de quem não está na playlist é recusado" 'não está programado' "$r"
r=$(curl -s -X POST $B/player/$DISP/painel -H "X-Aparelho-Id: $CHAVE" -H "$J" -d '{"pin":"0000"}'); esperar "PIN errado 401" 'PIN incorreto' "$r"
r=$(curl -s -X POST $B/player/$DISP/painel -H "X-Aparelho-Id: $CHAVE" -H "$J" -d '{"pin":"1234"}'); esperar "PIN certo abre painel da tela" 'porAnunciante' "$r"

echo "== anunciante: cadastro aberto, plano inválido =="
r=$(curl -s -c ana.txt -X POST $B/anunciantes/cadastro -H "$J" -d "{\"nome_empresa\":\"Padaria Ana\",\"cpf_cnpj\":\"11.222.333/0001-81\",\"endereco\":\"R\",\"cidade\":\"Matão\",\"uf\":\"SP\",\"cep\":\"15990-000\",\"contato_email\":\"ana@x.com\",\"contato_telefone\":\"16 99463-5946\",\"senha\":\"Senha12@\",\"aceitou_termos\":true,\"indicado_por_cupom\":\"$CUPOM\"}")
esperar "anunciante cadastro aberto, papel anunciante" '"papeis":\["anunciante"\]' "$r"; ANA=$(echo $r | sed 's/.*"id":\([0-9]*\),.*/\1/' | head -c 5)
r=$(curl -s -b ana.txt -X POST $B/anunciantes/$ANA/assinar -H "$J" -d '{"planoId":"nao-existe"}'); esperar "plano inexistente recusado" 'inválido' "$r"
