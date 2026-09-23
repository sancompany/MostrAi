#!/bin/bash
# Painel único (v2.1): conta que nasce vendedor ativa o modo anúncios sozinha,
# pede o modo ponto de dentro do painel, o admin libera na conta; convite
# aceito por conta logada; módulos cruzados de plano (tela após N meses de
# plano; anúncio grátis após N meses como ponto).
# Assume: banco zerado (reset-db.sh).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
B=${B:-http://localhost:3999}
mkdir -p "$ROOT/tests/e2e/saida"; cd "$ROOT/tests/e2e/saida"
J='Content-Type: application/json'
PG="psql -h localhost -U mostrai -d mostrai -tA"
export PGPASSWORD=mostrai
falhas=0
ok(){ echo "  ok  $1"; }
falha(){ echo "  FALHA $1 -> $2"; falhas=$((falhas+1)); }
esperar(){ if echo "$3" | grep -qE "$2"; then ok "$1"; else falha "$1" "$3"; fi; }

curl -s -c adm.txt -X POST $B/admin/login -H "$J" -d '{"usuario":"admin","senha":"Admin12@teste"}' >/dev/null

echo "== conta nasce só vendedor (convite) =="
r=$(curl -s -b adm.txt -X POST $B/admin/convites -H "$J" -d '{"papeis":["vendedor"],"nome_sugerido":"Lia"}')
TOK=$(echo $r | sed 's/.*"token":"\([^"]*\)".*/\1/')
r=$(curl -s -c lia.txt -X POST $B/anunciantes/cadastro -H "$J" -d "{\"convite\":\"$TOK\",\"nome_empresa\":\"Lia Vendas\",\"cpf_cnpj\":\"529.982.247-25\",\"contato_email\":\"lia@x.com\",\"contato_telefone\":\"16 99463-5946\",\"senha\":\"Senha12@\",\"aceitou_termos\":true,\"chave_pix\":\"lia@pix\"}")
esperar "conta criada só com vendedor" '"papeis":\["vendedor"\]' "$r"; LIA=$(echo $r | sed 's/.*"id":\([0-9]*\),.*/\1/' | head -c 5)
r=$(curl -s -b lia.txt $B/conta/modos)
esperar "modos: anúncios bloqueado e precisa endereço" '"anunciante":\{"liberado":false,"precisaEndereco":true' "$r"
esperar "modos: vendedor liberado" '"vendedor":\{"liberado":true' "$r"

echo "== ativa modo anúncios sozinha =="
r=$(curl -s -b lia.txt -X POST $B/conta/modos/anunciante -H "$J" -d '{"cidade":"Matão"}'); esperar "sem endereço completo recusa" 'endereço completo' "$r"
r=$(curl -s -b lia.txt -X POST $B/conta/modos/anunciante -H "$J" -d '{"endereco":"Rua B, 2","cidade":"Matão","uf":"SP","cep":"15990-000"}')
esperar "sem o ramo recusa (é ele que barra concorrente na mesma tela)" 'ramo do seu negócio' "$r"
r=$(curl -s -b lia.txt -X POST $B/conta/modos/anunciante -H "$J" -d '{"endereco":"Rua B, 2","cidade":"Matão","uf":"SP","cep":"15990-000","categoria_id":1}')
esperar "modo anúncios ativado (papel entra)" '"papeis":\["vendedor","anunciante"\]' "$r"
r=$(curl -s -b lia.txt -X POST $B/anunciantes/$LIA/assinar -H "$J" -d '{"planoId":"essencial-3m"}'); esperar "agora consegue assinar" 'checkoutUrl' "$r"

echo "== pede modo ponto de dentro do painel; admin libera na conta =="
r=$(curl -s -b lia.txt -X POST $B/conta/modos/ponto/pedir -H "$J" -d '{"nome_comercio":"Loja da Lia","endereco":"Rua C, 3","cidade":"Matão","uf":"SP","cep":"15990-000","segmento":"loja","fluxo_estimado_mensal":2000,"plano_ponto_id":"ajuda-custo","horario_semanal":{"seg":{"abre":"09:00","fecha":"18:00"},"ter":{"abre":"09:00","fecha":"18:00"},"qua":{"abre":"09:00","fecha":"18:00"},"qui":{"abre":"09:00","fecha":"18:00"},"sex":{"abre":"09:00","fecha":"18:00"},"sab":{"abre":"09:00","fecha":"15:00"},"dom":null}}')
esperar "pedido de ponto criado" '"ok":true' "$r"; CAND=$(echo $r | sed 's/.*"id":\([0-9]*\).*/\1/')
r=$(curl -s -b lia.txt -X POST $B/conta/modos/ponto/pedir -H "$J" -d '{"nome_comercio":"x","endereco":"y"}'); esperar "segundo pedido é recusado" 'em análise' "$r"
r=$(curl -s -b lia.txt $B/conta/modos); esperar "modos mostra pedido pendente de ponto" '"ponto":\{"liberado":false,"pedido":\{"tipo":"ponto"' "$r"
r=$(curl -s -b adm.txt $B/admin/candidaturas); esperar "admin vê origem painel e conta" '"origem":"painel"' "$r"
r=$(curl -s -b adm.txt -X POST $B/admin/candidaturas/$CAND/liberar); esperar "admin libera na conta" '"papeis":\["vendedor","anunciante","ponto"\]' "$r"
# "Meus pontos" (painel único) substitui /anunciantes/:id/pontos e
# /anunciantes/:id/dispositivos, que saíram.
r=$(curl -s -b lia.txt $B/anunciantes/me/meus-pontos); esperar "ponto criado com endereço do pedido" 'Loja da Lia' "$r"
esperar "ajuda de custo copiada da opção de comodato" '"ajudaCustoMensal":[1-9]' "$r"
PONTO=$(echo $r | sed 's/[^{]*{[^{]*{"tipo":"ponto","id":\([0-9]*\).*/\1/')
# Ponto nasce sem tela desde a migration 069: o admin cria a primeira.
r=$(curl -s -b adm.txt -X POST $B/admin/pontos/$PONTO/dispositivos -H "$J" -d '{"apelido":"Tela 1"}'); esperar "Tela 1 criada" 'Tela 1' "$r"

echo "== convite aceito por conta logada =="
r=$(curl -s -b adm.txt -X POST $B/admin/convites -H "$J" -d '{"papeis":["ponto"],"nome_sugerido":"Beto"}')
TOK2=$(echo $r | sed 's/.*"token":"\([^"]*\)".*/\1/')
r=$(curl -s -c beto.txt -X POST $B/anunciantes/cadastro -H "$J" -d '{"nome_empresa":"Beto","cpf_cnpj":"04.252.011/0001-10","endereco":"R","cidade":"Matão","uf":"SP","cep":"15990-000","contato_email":"beto2@x.com","contato_telefone":"16 99463-5946","senha":"Senha12@","aceitou_termos":true}')
BETO=$(echo $r | sed 's/.*"id":\([0-9]*\),.*/\1/' | head -c 5)
r=$(curl -s -b beto.txt -X POST $B/convites/$TOK2/aceitar -H "$J" -d '{}'); esperar "conta logada aceita convite e ganha o papel" '"papeis":\["anunciante","ponto"\]' "$r"
r=$(curl -s $B/convites/$TOK2); esperar "convite ficou usado" 'inválido' "$r"
r=$(curl -s -b adm.txt -X POST $B/admin/convites -H "$J" -d '{"papeis":["vendedor"]}'); TOK3=$(echo $r | sed 's/.*"token":"\([^"]*\)".*/\1/')
r=$(curl -s -b beto.txt -X POST $B/convites/$TOK3/aceitar -H "$J" -d '{}'); esperar "vendedor por convite exige Pix" 'Pix' "$r"

# Módulo 1 (tela após N meses) removido em 17/09/2026 a pedido do dono —
# ver src/db/migrations/046. O módulo 2, logo abaixo, continua.

echo "== módulo 2: anúncio grátis após N meses como ponto =="
$PG -c "UPDATE planos_ponto SET plano_bonus_id='destaque-1m', plano_bonus_apos_meses=6, plano_bonus_meses=2 WHERE id='ajuda-custo'" >/dev/null
$PG -c "UPDATE pontos SET status='em_operacao' WHERE id=$PONTO" >/dev/null
$PG -c "UPDATE dispositivos SET status='ativo', instalado_em = (now() - interval '7 months')::date WHERE ponto_id=$PONTO" >/dev/null
$PG -c "UPDATE anunciantes SET plano_id=NULL, data_expiracao=NULL WHERE id=$LIA" >/dev/null
r=$(curl -s -b lia.txt $B/conta/modos); esperar "7 meses como ponto com módulo de 6 → bônus de anúncio disponível" '"anuncio":\{[^}]*"disponivel":true' "$r"
r=$(curl -s -b lia.txt -X POST $B/conta/bonus/anuncio/resgatar -H "$J" -d '{}')
esperar "resgate ativa o plano na conta" '"plano_id":"destaque-1m","data_inicio_cobertura"' "$r"
esperar "conta fica ativa (não suspensa)" '"suspenso":false' "$r"
esperar "bônus entra como cortesia (não vira receita no resumo)" '"plano_cortesia":true' "$r"
dias=$($PG -c "select data_expiracao::date - now()::date from anunciantes where id=$LIA"); esperar "cobertura de ~2 meses (>= 58 dias)" '^(5[8-9]|6[0-9])$' "$dias"
r=$(curl -s -b lia.txt -X POST $B/conta/bonus/anuncio/resgatar -H "$J" -d '{}'); esperar "não resgata duas vezes" 'não está disponível|já tem um plano' "$r"

echo "== vendedor completa Pix depois =="
r=$(curl -s -b lia.txt -X PATCH $B/vendedor/me -H "$J" -d '{"chave_pix":"lia2@pix"}'); esperar "chave Pix atualizada" '"chave_pix":"lia2@pix"' "$r"

echo; echo "falhas: $falhas"
