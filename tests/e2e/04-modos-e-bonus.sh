#!/bin/bash
# Painel único: conta que nasce só com o papel ponto (convite) ativa o modo
# anúncios sozinha, pede outro estabelecimento de dentro do painel e o admin
# libera; convite aceito por conta logada; crédito mensal do ponto (ADR-016,
# 24/09/2026 — substituiu a ajuda de custo, a troca por tela e o módulo 2).
# O programa de vendedor foi aposentado em 23/09/2026 — o roteiro confere
# que ele não volta.
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

echo "== conta nasce só com o papel ponto (convite, sem endereço comercial) =="
r=$(curl -s -b adm.txt -X POST $B/admin/convites -H "$J" -d '{"papeis":["vendedor"],"nome_sugerido":"Lia"}')
esperar "convite de vendedor não é mais emitido" 'ao menos um papel' "$r"
r=$(curl -s -b adm.txt -X POST $B/admin/convites -H "$J" -d '{"papeis":["ponto"],"nome_sugerido":"Lia"}')
TOK=$(echo $r | sed 's/.*"token":"\([^"]*\)".*/\1/')
r=$(curl -s -c lia.txt -X POST $B/anunciantes/cadastro -H "$J" -d "{\"convite\":\"$TOK\",\"nome_empresa\":\"Lia Doces\",\"cpf_cnpj\":\"529.982.247-25\",\"contato_email\":\"lia@x.com\",\"contato_telefone\":\"16 99463-5946\",\"senha\":\"Senha12@\",\"aceitou_termos\":true}")
esperar "conta criada só com ponto" '"papeis":\["ponto"\]' "$r"; LIA=$(echo $r | sed 's/.*"id":\([0-9]*\),.*/\1/' | head -c 5)
r=$(curl -s -b lia.txt $B/conta/modos)
esperar "modos: anúncios bloqueado e precisa endereço" '"anunciante":\{"liberado":false,"precisaEndereco":true' "$r"
esperar "modos: ponto liberado" '"ponto":\{"liberado":true' "$r"

echo "== ativa modo anúncios sozinha =="
r=$(curl -s -b lia.txt -X POST $B/conta/modos/anunciante -H "$J" -d '{"cidade":"Matão"}'); esperar "sem endereço completo recusa" 'endereço completo' "$r"
r=$(curl -s -b lia.txt -X POST $B/conta/modos/anunciante -H "$J" -d '{"endereco":"Rua B, 2","cidade":"Matão","uf":"SP","cep":"15990-000"}')
esperar "sem o ramo recusa (é ele que barra concorrente na mesma tela)" 'ramo do seu negócio' "$r"
r=$(curl -s -b lia.txt -X POST $B/conta/modos/anunciante -H "$J" -d '{"endereco":"Rua B, 2","cidade":"Matão","uf":"SP","cep":"15990-000","categoria_id":1}')
esperar "modo anúncios ativado (papel entra)" '"papeis":\["ponto","anunciante"\]' "$r"
r=$(curl -s -b lia.txt -X POST $B/anunciantes/$LIA/assinar -H "$J" -d '{"planoId":"essencial-3m"}'); esperar "agora consegue assinar" 'checkoutUrl' "$r"

echo "== pede outro estabelecimento de dentro do painel; admin libera =="
# Conta que já é ponto pede pela porta de "Meus pontos"; a do modo ponto é só
# pra quem ainda não tem o papel.
r=$(curl -s -b lia.txt -X POST $B/conta/modos/ponto/pedir -H "$J" -d '{"nome_comercio":"x","endereco":"y"}'); esperar "modo ponto já liberado não é pedido de novo" 'já está liberado' "$r"
r=$(curl -s -b lia.txt -X POST $B/anunciantes/me/pontos -H "$J" -d '{"nome_comercio":"Loja da Lia","endereco":"Rua C, 3","cidade":"Matão","uf":"SP","cep":"15990-000","segmento":"loja","fluxo_estimado_mensal":2000,"plano_ponto_id":"ajuda-custo","horario_semanal":{"seg":{"abre":"09:00","fecha":"18:00"},"ter":{"abre":"09:00","fecha":"18:00"},"qua":{"abre":"09:00","fecha":"18:00"},"qui":{"abre":"09:00","fecha":"18:00"},"sex":{"abre":"09:00","fecha":"18:00"},"sab":{"abre":"09:00","fecha":"15:00"},"dom":null}}')
esperar "pedido de ponto criado" '"ok":true' "$r"; CAND=$(echo $r | sed 's/.*"id":\([0-9]*\).*/\1/')
r=$(curl -s -b lia.txt -X POST $B/anunciantes/me/pontos -H "$J" -d '{"nome_comercio":"Loja da Lia","endereco":"Rua C, 3","cep":"15990-000","fluxo_estimado_mensal":2000}'); esperar "segundo pedido do mesmo endereço é recusado" 'em análise' "$r"
r=$(curl -s -b lia.txt $B/anunciantes/me/meus-pontos); esperar "Meus pontos mostra o pedido em análise" '"tipo":"candidatura"[^}]*"nome":"Loja da Lia"[^}]*"estado":"em_analise"' "$r"
r=$(curl -s -b adm.txt $B/admin/candidaturas); esperar "admin vê origem painel e conta" '"origem":"painel"' "$r"
r=$(curl -s -b adm.txt -X POST $B/admin/candidaturas/$CAND/liberar); esperar "admin libera na conta" '"ok":true' "$r"
# "Meus pontos" (painel único) substitui /anunciantes/:id/pontos e
# /anunciantes/:id/dispositivos, que saíram.
r=$(curl -s -b lia.txt $B/anunciantes/me/meus-pontos); esperar "ponto criado com endereço do pedido" 'Loja da Lia' "$r"
esperar "ponto nasce sem modalidade nem R\$ 50" '"beneficio":\{' "$r"
if echo "$r" | grep -q 'ajudaCustoMensal\|modalidade'; then falha "sem campos do modelo antigo" "$r"; else ok "sem campos do modelo antigo"; fi
PONTO=$(echo $r | sed 's/[^{]*{[^{]*{"tipo":"ponto","id":\([0-9]*\).*/\1/')
# Ponto nasce sem tela desde a migration 069: o admin cria a primeira.
r=$(curl -s -b adm.txt -X POST $B/admin/pontos/$PONTO/dispositivos -H "$J" -d '{"apelido":"Tela 1"}'); esperar "Tela 1 criada" 'Tela 1' "$r"
DISP=$(echo $r | sed 's/.*"id":\([0-9]*\).*/\1/' | head -c 5)

echo "== convite aceito por conta logada =="
r=$(curl -s -b adm.txt -X POST $B/admin/convites -H "$J" -d '{"papeis":["ponto"],"nome_sugerido":"Beto"}')
TOK2=$(echo $r | sed 's/.*"token":"\([^"]*\)".*/\1/')
r=$(curl -s -c beto.txt -X POST $B/anunciantes/cadastro -H "$J" -d '{"nome_empresa":"Beto","cpf_cnpj":"04.252.011/0001-10","endereco":"R","cidade":"Matão","uf":"SP","cep":"15990-000","contato_email":"beto2@x.com","contato_telefone":"16 99463-5946","senha":"Senha12@","aceitou_termos":true}')
BETO=$(echo $r | sed 's/.*"id":\([0-9]*\),.*/\1/' | head -c 5)
r=$(curl -s -b beto.txt -X POST $B/convites/$TOK2/aceitar -H "$J" -d '{}'); esperar "conta logada aceita convite e ganha o papel" '"papeis":\["anunciante","ponto"\]' "$r"
r=$(curl -s $B/convites/$TOK2); esperar "convite ficou usado" 'inválido' "$r"

# Módulo 1 (tela após N meses) removido em 17/09/2026 a pedido do dono —
# ver src/db/migrations/046. O módulo 2, logo abaixo, continua.

echo "== modelo antigo aposentado: sem troca, sem repasse, sem módulo 2 =="
r=$(curl -s -b lia.txt $B/anunciantes/me/financeiro)
if echo "$r" | grep -q 'recebimentos\|troca'; then falha "Financeiro sem Recebimentos" "$r"; else ok "Financeiro sem Recebimentos"; fi
r=$(curl -s -o /dev/null -w '%{http_code}' -b lia.txt -X POST $B/anunciantes/me/comodato/trocar-por-tela); esperar "troca por tela aposentada (410)" '^410$' "$r"
r=$(curl -s -o /dev/null -w '%{http_code}' -b lia.txt -X POST $B/conta/bonus/anuncio/resgatar -H "$J" -d '{}'); esperar "módulo 2 aposentado (410)" '^410$' "$r"
r=$(curl -s $B/planos-ponto); esperar "nenhuma modalidade oferecida" '^\[\]$' "$r"

echo "== crédito mensal do ponto: tela ativa = +1 crédito no mês =="
r=$(curl -s -b adm.txt -X PATCH $B/admin/dispositivos/$DISP -H "$J" -d '{"status":"ativo"}'); esperar "tela ativada" '"status":"ativo"' "$r"
# Tela provisionada: o job exige chave de aparelho ou uma conexão já feita.
$PG -c "UPDATE dispositivos SET ultima_vez_online = now() WHERE id=$DISP" >/dev/null
(cd "$ROOT" && node -e "require('./src/creditos/ponto').concederCreditosMensais({ apenasPontos: [$PONTO] }).then(r => { console.log(JSON.stringify(r)); setTimeout(() => process.exit(0), 300); })") >/dev/null
(cd "$ROOT" && node -e "require('./src/creditos/ponto').concederCreditosMensais({ apenasPontos: [$PONTO] }).then(r => { console.log(JSON.stringify(r)); setTimeout(() => process.exit(0), 300); })") >/dev/null
n=$($PG -c "select count(*) from creditos_ledger where ponto_id=$PONTO and tipo='credito_mensal_ponto'"); esperar "1 crédito no mês, mesmo rodando o job duas vezes" '^1$' "$n"
r=$(curl -s -b lia.txt $B/anunciantes/me/creditos); esperar "saldo na mesma carteira" '"saldo":1' "$r"
r=$(curl -s -b lia.txt $B/anunciantes/me/meus-pontos); esperar "Meus pontos: crédito do mês já concedido" '"creditoDoMesConcedido":true' "$r"

echo "== vendedor aposentado: conta sem perfil de vendedor não mexe em Pix =="
r=$(curl -s -b lia.txt -X PATCH $B/vendedor/me -H "$J" -d '{"chave_pix":"lia2@pix"}'); esperar "Pix de vendedor recusado pra conta comum" 'não é de vendedor' "$r"

echo; echo "falhas: $falhas"
[ "$falhas" -eq 0 ]
